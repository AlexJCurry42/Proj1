// Pocket Planetarium — browser regression suite. Runs the REAL app against
// the REAL Aladin Lite engine in headless Chromium, covering the behavior
// the unit tests can't see: boot budget, lazy layers, flights, the star
// bloom, the horizon lock, spectrum transitions, time-lapse, the location
// consent card. Every scenario here began life as a bug the unit suite
// missed.
//
// Run: `node tests/browser/run.mjs`
//   needs: playwright (CI: `npm i --no-save playwright`) and a browser
//   (CI: `npx playwright install --with-deps chromium` or `webkit`). The
//   sky engine is bundled with the app (js/vendor/aladin/), so no download.
// Env overrides: PLAYWRIGHT_MODULE, CHROME_PATH, and BROWSER_ENGINE
//   (chromium | webkit — webkit is the closest CI proxy for iOS Safari,
//   the platform where every audio/gesture bug in this app's history
//   actually lived; see docs/DEVICE-CHECKLIST.md for the on-device pass).

import { createServer } from 'node:http';
import { readFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE = path.join(ROOT, 'tests/browser/.cache');

// ---- locate playwright + chromium (CI installs them; the dev sandbox has
// them preinstalled at fixed paths) ----
async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/opt/node22/lib/node_modules/playwright/index.mjs'
  ].filter(Boolean);
  for (const c of candidates) {
    try { return await import(c); } catch (err) { /* next */ }
  }
  throw new Error('playwright not found — npm i --no-save playwright');
}
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return undefined; // let playwright resolve its own managed chromium
}

// ---- fixture ----
// The engine is BUNDLED with the app (js/vendor/aladin/), so the fixture is
// simply the production page: no download, no tag surgery, and the suite
// exercises the exact engine build every user runs. The engine-test.html
// name is kept so scenario URLs stay stable.
async function prepareFixture() {
  await mkdir(CACHE, { recursive: true });
  await copyFile(path.join(ROOT, 'index.html'), path.join(CACHE, 'engine-test.html'));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function startServer() {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (p === '/' || p === '/engine-test.html') p = '/tests/browser/.cache/engine-test.html';
        const file = path.join(ROOT, p);
        if (!file.startsWith(ROOT)) throw new Error('traversal');
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(body);
      } catch (err) {
        res.writeHead(404);
        res.end('not found');
      }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---- tiny harness ----
let passed = 0;
const failures = [];
// Software-rendered WebKit occasionally loses its renderer under heavy
// canvas/WebGL load — every later protocol call then reports a closed
// target. That's an environment crash, not a product regression, so ONLY
// that signature earns one fresh-context retry; assertion failures never do.
const CRASH_RE = /Target (page|crashed)|context or browser has been closed/i;
async function scenario(name, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}${attempt > 1 ? ' (after renderer-crash retry)' : ''}`);
      return;
    } catch (err) {
      if (attempt === 1 && CRASH_RE.test(err.message)) {
        console.warn(`  retry ${name} — renderer crashed: ${err.message.slice(0, 100)}`);
        continue;
      }
      failures.push(name);
      console.error(`FAIL  ${name}\n      ${err.message}`);
      return;
    }
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// Shared page bootstrap: engine hook + error collection.
const INIT = () => {
  let _A;
  Object.defineProperty(window, 'A', {
    configurable: true,
    get() { return _A; },
    set(v) {
      _A = v;
      const o = v.aladin.bind(v);
      v.aladin = (...a) => { const x = o(...a); window.__aladin = x; return x; };
      const oc = v.catalog?.bind(v);
      if (oc) { window.__cats = []; v.catalog = (op) => { const c = oc(op); window.__cats.push(c); return c; }; }
    }
  });
};
const IGNORE_ERR = /HiPS|CDS ID|Failed to fetch|points to a HiPS|NetworkError|Load failed/i;

async function newPage(browser, baseURL, { geolocation = true, guide = false, viewport = { width: 600, height: 700 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  if (geolocation) {
    await ctx.grantPermissions(['geolocation'], { origin: baseURL });
    await ctx.setGeolocation({ latitude: 37.77, longitude: -122.42 });
  }
  // The first-run guided tour would sit over the UI in every scenario;
  // pre-dismiss it except where the tour itself is under test.
  if (!guide) {
    await ctx.addInitScript(() => {
      try { localStorage.setItem('dsa-uiguide', 'true'); } catch (e) { /* private mode */ }
    });
  }
  const page = await ctx.newPage();
  page.__errors = [];
  page.__console = [];
  page.on('pageerror', (e) => { if (!IGNORE_ERR.test(e.message)) page.__errors.push(e.message); });
  page.on('console', (m) => { page.__console.push(`[${m.type()}] ${m.text()}`.slice(0, 300)); });
  await page.addInitScript(INIT);
  page.__dataReqs = [];
  // Only the app's own bundled data counts against the boot fetch budget —
  // with real network the engine fetches survey metadata from CDS, and some
  // of those URLs also contain "/data/" in their path.
  page.on('request', (r) => { const u = r.url(); if (u.startsWith(`${baseURL}/data/`)) page.__dataReqs.push(u.split('/data/')[1]); });
  await page.goto(`${baseURL}/engine-test.html`);
  try {
    await page.waitForFunction(() => window.__aladin, null, { timeout: 60000 });
  } catch (err) {
    // The engine never came up — report everything we know instead of a
    // bare timeout, so CI logs are actionable.
    const diag = await page.evaluate(() => ({
      hasA: typeof window.A !== 'undefined',
      fatal: document.getElementById('fatal-banner')?.textContent?.slice(0, 300) || null,
      webgl2: (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return String(e); } })()
    })).catch(() => ({ evalFailed: true }));
    throw new Error(`engine never booted: ${JSON.stringify(diag)}; errors: ${page.__errors.join(' | ')}; console tail: ${page.__console.slice(-8).join(' | ')}`);
  }
  await page.waitForTimeout(3000);
  return { ctx, page };
}

// Dock-row helpers as real functions with arguments — no string-built code
// anywhere in the suite (mirrors the app's own no-eval discipline).
const flipRow = (page, label) => page.evaluate((lbl) => {
  const find = (l) => [...document.querySelectorAll('#layer-dock-list li')].find(
    (li) => li.querySelector('.toggle-text')?.textContent === l);
  find(lbl).querySelector('input').click();
}, label);
const rowState = (page, label) => page.evaluate((lbl) => {
  const find = (l) => [...document.querySelectorAll('#layer-dock-list li')].find(
    (li) => li.querySelector('.toggle-text')?.textContent === l);
  const li = find(lbl);
  return li ? {
    checked: li.querySelector('input').checked,
    count: li.querySelector('.toggle-count')?.textContent || '',
    loading: li.classList.contains('loading')
  } : null;
}, label);

// ============================================================ scenarios ===
const pw = await loadPlaywright();
await prepareFixture();
const server = await startServer();
const baseURL = `http://127.0.0.1:${server.address().port}`;
const ENGINE = process.env.BROWSER_ENGINE || 'chromium';
const LAUNCH_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
let browser;
if (ENGINE === 'webkit') {
  browser = await pw.webkit.launch();
} else if (chromePath()) {
  browser = await pw.chromium.launch({ executablePath: chromePath(), args: LAUNCH_ARGS });
} else {
  // Playwright's default headless target is the minimal "headless shell",
  // which can't give Aladin a WebGL context; the full chromium build (new
  // headless mode) can. Fall back for playwright versions without channels.
  try {
    browser = await pw.chromium.launch({ channel: 'chromium', args: LAUNCH_ARGS });
  } catch (err) {
    browser = await pw.chromium.launch({ args: LAUNCH_ARGS });
  }
}
console.log(`engine: ${ENGINE}`);

await scenario('boot: lean fetch budget, no dead chrome, zero errors (granted geo)', async () => {
  const { ctx, page } = await newPage(browser, baseURL);
  const dataFiles = new Set(page.__dataReqs.map((u) => u.split('?')[0]));
  // boot may fetch: tours, the star tiers (faint arrives on idle — off the
  // critical path by design), the ISS TLE (observer already granted) —
  // never the catalogs of default-off layers.
  // (descriptions.json joins on idle with the identification set; the file
  // is Action-generated, so a 404 for it is normal on a fresh checkout.)
  const allowed = ['tours.json', 'brightstars.json', 'brightstars_faint.json', 'brightstars_seed.json', 'satellites_tle.txt', 'messier_ngc.json', 'constellation_zones.json', 'descriptions.json'];
  for (const f of dataFiles) {
    assert(allowed.includes(f), `unexpected boot fetch: ${f}`);
  }
  const boot = await page.evaluate(() => {
    const find = (l) => [...document.querySelectorAll('#layer-dock-list li')].find(
      (li) => li.querySelector('.toggle-text')?.textContent === l);
    return {
      warp: !!document.getElementById('warp-canvas'),
      satToggle: !!find('Satellites & ISS'),
      horizon: find('Horizon & compass')?.querySelector('input').checked,
      locCardHidden: document.getElementById('loc-card').hidden
    };
  });
  assert(!boot.warp, 'warp canvas should not exist');
  assert(!boot.satToggle, 'satellite toggle should not exist');
  assert(boot.horizon === true, 'horizon should default on');
  assert(boot.locCardHidden, 'consent card must not show when permission already granted');
  // Every catalog — Solar System included — starts OFF for a new user; the
  // count badge still shows what the switch offers (11: Sun, Moon, planets;
  // the ISS joins the count only when the layer is actually enabled).
  await page.waitForTimeout(1500);
  const solar = await rowState(page, 'Solar System');
  assert(solar.checked === false, 'Solar System must start off for new users');
  assert(solar.count === '11', `Solar System count should be 11 while off, got "${solar.count}"`);
  // The boot loading screen must have retired itself (removed, not merely
  // faded — a lingering full-screen div would swallow every tap).
  assert(await page.evaluate(() => !document.getElementById('boot-screen')),
    'boot screen must remove itself once the sky is interactive');
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

await scenario('location consent: boot never asks; Sky Now anchors the card', async () => {
  const { ctx, page } = await newPage(browser, baseURL, { geolocation: false });
  await page.waitForTimeout(1200);
  assert(await page.evaluate(() => document.getElementById('loc-card').hidden),
    'boot must NEVER show the consent card');
  const horizon = await rowState(page, 'Horizon & compass');
  assert(horizon.checked === false, 'horizon layer waits quietly without permission');
  // The first (and only) ask is anchored to the Sky Now tap.
  await page.click('#skynow-btn');
  await page.waitForFunction(() => !document.getElementById('loc-card').hidden, null, { timeout: 5000 });
  await page.click('#loc-decline');
  await page.waitForTimeout(400);
  assert(await page.evaluate(() => document.getElementById('loc-card').hidden),
    'declining hides the card');
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

await scenario('lazy dock: Deep sky fetches its own files on first flip, shimmer clears', async () => {
  const { ctx, page } = await newPage(browser, baseURL);
  page.__dataReqs.length = 0;
  // The shimmer can clear within milliseconds against a local server, so
  // watch for it with an observer instead of sampling on a timer.
  const sawShimmer = page.evaluate((lbl) => new Promise((resolve) => {
    const li = [...document.querySelectorAll('#layer-dock-list li')].find(
      (el) => el.querySelector('.toggle-text')?.textContent === lbl);
    if (li.classList.contains('loading')) { resolve(true); return; }
    const mo = new MutationObserver(() => {
      if (li.classList.contains('loading')) { mo.disconnect(); resolve(true); }
    });
    mo.observe(li, { attributes: true, attributeFilter: ['class'] });
    setTimeout(() => { mo.disconnect(); resolve(li.classList.contains('loading')); }, 3000);
  }), 'Deep sky');
  await flipRow(page, 'Deep sky');
  assert(await sawShimmer, 'row should shimmer while loading');
  await page.waitForTimeout(3500);
  const done = await rowState(page, 'Deep sky');
  assert(!done.loading, 'shimmer must clear');
  assert(done.count === '12,149', `Deep sky count should be 12,149, got "${done.count}"`);
  // The open dock behaves like a popover: moving the view or tapping
  // outside puts it away (taps inside — like the flips above — leave it).
  await page.click('#dock-collapse');
  await page.waitForTimeout(700); // past the anti-slam grace window
  assert(await page.evaluate(() => !document.getElementById('layer-dock').classList.contains('collapsed')),
    'chevron must expand the dock');
  await page.evaluate(() => { const a = window.__aladin; const [ra, dec] = a.getRaDec(); a.gotoRaDec(ra + 20, dec); });
  await page.waitForTimeout(400);
  assert(await page.evaluate(() => document.getElementById('layer-dock').classList.contains('collapsed')),
    'moving the view must collapse the dock');
  await page.click('#dock-collapse');
  await page.waitForTimeout(700);
  await page.mouse.click(520, 400); // a tap on the open sky, away from the dock
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => document.getElementById('layer-dock').classList.contains('collapsed')),
    'tapping off the dock must collapse it');

  // ngc_full is this layer's own lazy file — the flip must fetch it. The
  // curated messier_ngc file is SHARED (crosshair ID loads it at idle) and
  // fetchJSON dedupes per session, so it must NOT appear a second time here.
  const fetched = page.__dataReqs.map((u) => u.split('?')[0]);
  assert(fetched.includes('ngc_full.json'),
    `expected ngc_full.json on first flip, got: ${[...new Set(fetched)].join(', ')}`);
  assert(fetched.filter((u) => u === 'messier_ngc.json').length <= 1,
    'messier_ngc.json must be fetched at most once per session (dedupe)');
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

await scenario('flight: continuous arc, exact landing, survey settles', async () => {
  const { ctx, page } = await newPage(browser, baseURL);
  await page.evaluate(() => {
    window.__trace = [];
    window.__tracing = true;
    const rec = (t) => {
      try { const [ra, dec] = window.__aladin.getRaDec(); window.__trace.push([t, window.__aladin.getFov()[0], ra, dec]); } catch (e) { /* mid-init */ }
      if (window.__tracing) requestAnimationFrame(rec);
    };
    requestAnimationFrame(rec);
  });
  await page.click('#cool-btn');
  // The caption is deliberately delayed until touchdown + reveal — and other
  // toasts can precede it (the one-time DSS2 artifact note fires on the same
  // landing), so find the toast that names a tour destination rather than
  // trusting whichever toast happens to be first.
  const tours = await page.evaluate(async () => (await (await fetch('data/tours.json')).json()).destinations);
  const prefixes = tours.map((t) => `${t.name} — `);
  // Generous timeout: the caption sits downstream of a ~4 s flight, the
  // reveal fade, AND live CDS survey-metadata fetches — on a loaded
  // software-rendered runner 20 s proved flaky (WebKit CI, 2026-07-21).
  await page.waitForFunction((ps) =>
    [...document.querySelectorAll('.toast')].some((el) => ps.some((p) => (el.textContent || '').includes(p))),
  prefixes, { timeout: 40000 });
  const toastTexts = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((el) => el.textContent || ''));
  const dest = tours.find((t) => toastTexts.some((x) => x.includes(`${t.name} — `)));
  assert(dest, 'destination not identified from toast');
  // Settle is condition-, not clock-based: the longest flights (4.2 s) plus
  // the survey fade tail and the hash debounce legitimately take ~5 s even
  // on fast hardware — a fixed sleep here was a flake on slow CI runners.
  // "Settled" = the permalink hash carries BOTH the destination survey and
  // its exact coordinates (a DSS2-bound flight matches the survey from
  // frame one, so the survey alone proves nothing).
  await page.waitForFunction(
    ({ sv, ra, dec }) => {
      const p = new URLSearchParams(location.hash.slice(1));
      if (p.get('survey') !== sv) return false;
      const dra = ((+p.get('ra') - ra + 540) % 360) - 180;
      return Math.hypot(dra, +p.get('dec') - dec) < 0.01;
    },
    { sv: dest.survey, ra: dest.ra, dec: dest.dec }, { timeout: 25000 }
  ).catch(() => { /* asserted below with a readable message */ });
  const r = await page.evaluate(() => {
    window.__tracing = false;
    const p = new URLSearchParams(location.hash.slice(1));
    return { trace: window.__trace, hash: { survey: p.get('survey'), ra: +p.get('ra'), dec: +p.get('dec') } };
  });
  assert(dest.survey === r.hash.survey, `survey should settle to ${dest.survey}, got ${r.hash.survey}`);
  const landErr = Math.hypot(((r.hash.ra - dest.ra + 540) % 360) - 180, r.hash.dec - dest.dec);
  assert(landErr < 0.01, `landing error ${landErr.toFixed(4)}°`);
  // no stalls: inside the moving window, never 8+ consecutive static frames
  const tr = r.trace;
  let start = -1, end = -1;
  for (let k = 1; k < tr.length; k++) {
    const moving = Math.abs(tr[k][1] - tr[k - 1][1]) > 1e-4 ||
      Math.hypot(((tr[k][2] - tr[k - 1][2] + 540) % 360) - 180, tr[k][3] - tr[k - 1][3]) > 1e-4;
    if (moving) { if (start < 0) start = k; end = k; }
  }
  let run = 0;
  for (let k = start + 1; k <= end; k++) {
    const still = Math.abs(tr[k][1] - tr[k - 1][1]) < 1e-5 &&
      Math.hypot(((tr[k][2] - tr[k - 1][2] + 540) % 360) - 180, tr[k][3] - tr[k - 1][3]) < 1e-5;
    run = still ? run + 1 : 0;
    assert(run < 8, `flight stalled for ${run + 1} frames mid-journey`);
  }
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

await scenario('star bloom: activates only where the plate core resolves', async () => {
  const { ctx, page } = await newPage(browser, baseURL);
  const alphaAt = (ra, dec) => page.evaluate(([ra, dec]) => {
    const a = window.__aladin, cv = document.getElementById('overlay-canvas');
    const p = a.world2pix(ra, dec);
    if (!p) return null;
    const dpr = cv.width / cv.clientWidth;
    return cv.getContext('2d').getImageData(Math.round(p[0] * dpr), Math.round(p[1] * dpr), 1, 1).data[3];
  }, [ra, dec]);
  const at = async (ra, dec, fov) => {
    await page.evaluate(([ra, dec, fov]) => { window.__aladin.gotoRaDec(ra, dec); window.__aladin.setFoV(fov); }, [ra, dec, fov]);
    await page.waitForTimeout(700);
  };
  await at(114.7912, 34.5842, 2.4); // V≈4.9 star, above threshold
  assert((await alphaAt(114.7912, 34.5842)) === 0, 'V4.9 star must be untouched at fov 2.4°');
  await at(114.7912, 34.5842, 0.4);
  assert((await alphaAt(114.7912, 34.5842)) > 240, 'V4.9 star must be covered at fov 0.4°');
  await at(101.287, -16.716, 20); // Sirius wide
  assert((await alphaAt(101.287, -16.716)) === 0, 'Sirius must be untouched at fov 20°');
  await at(101.287, -16.716, 5);
  assert((await alphaAt(101.287, -16.716)) > 240, 'Sirius must be covered at fov 5°');
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

await scenario('horizon lock: never steers mid-drag; budgeted leveling after', async () => {
  const { ctx, page } = await newPage(browser, baseURL);
  await page.evaluate(() => {
    const a = window.__aladin;
    const orig = a.setRotation.bind(a);
    window.__rotCalls = [];
    a.setRotation = (v) => { window.__rotCalls.push(v); return orig(v); };
  });
  await page.evaluate(async () => {
    const a = window.__aladin;
    const { zenithRaDec } = await import('/js/astro.js');
    const z = zenithRaDec(37.77, -122.42, new Date());
    a.gotoRaDec((z.ra + 80) % 360, 5);
    a.setFoV(60);
    await new Promise((r) => setTimeout(r, 300));
    a.setRotation(100);
  });
  await page.waitForTimeout(3200); // drain the setup episode
  const rotBefore = await page.evaluate(() => window.__aladin.getRotation());
  await page.mouse.move(300, 350);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.evaluate(() => { window.__rotCalls = []; });
  for (let i = 1; i <= 15; i++) await page.mouse.move(300 + i * 8, 350, { steps: 1 });
  const duringDrag = await page.evaluate(() => window.__rotCalls.length);
  await page.mouse.up();
  await page.waitForTimeout(3200);
  const rotAfter = await page.evaluate(() => window.__aladin.getRotation());
  assert(duringDrag === 0, `lock issued ${duringDrag} rotations during the drag`);
  assert(Math.abs(rotAfter - rotBefore) < 36, `post-swipe leveling exceeded budget: ${Math.abs(rotAfter - rotBefore).toFixed(1)}°`);
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

await scenario('spectrum: a multi-stop tap is one direct fade, no intermediate surveys', async () => {
  const { ctx, page } = await newPage(browser, baseURL);
  await page.evaluate(() => {
    const a = window.__aladin;
    window.__layerCalls = [];
    for (const m of ['setBaseImageLayer', 'setOverlayImageLayer']) {
      const om = a[m].bind(a);
      a[m] = (...la) => {
        // Count only calls issued by OUR spectrum logic. The engine itself
        // re-installs its hardcoded DSS2 default whenever a survey fetch
        // fails (an offline / sandboxed run flails that way on a loop) —
        // that resilience noise is not what this scenario asserts about.
        if (new Error().stack.includes('/js/spectrum.js')) {
          window.__layerCalls.push(String(la[0]?.id || la[0]));
        }
        return om(...la);
      };
    }
  });
  // The rail starts as its collapsed pill now — expand it first, as a user
  // would, before aiming at the track.
  await page.click('#spectrum-collapse');
  await page.waitForTimeout(500);
  const track = await page.locator('#spectrum-track').boundingBox();
  await page.mouse.click(track.x + track.width / 2, track.y + 14); // top stop: Fermi, 4 stops from the 2MASS boot survey
  await page.waitForTimeout(1600);
  const calls = await page.evaluate(() => window.__layerCalls);
  assert(!calls.some((c) => /SDSS|PanSTARRS|DSS2/.test(c)), `intermediate surveys touched: ${calls.join(', ')}`);
  const survey = await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('survey'));
  assert(survey === 'P/Fermi/color', `should settle on Fermi, got ${survey}`);
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

await scenario('time: playback moves the Moon; Back to now stops and resets', async () => {
  const { ctx, page } = await newPage(browser, baseURL);
  // WebKit CI renders the sky in software, and fast playback re-projects
  // the whole view every frame — the saturated main thread starves
  // Playwright's multi-step click protocol (hit-target checks scheduled
  // between frames) past its timeout. What this scenario asserts is the
  // CLOCK LOGIC behind the buttons, not their hit-testing (every other
  // scenario exercises real clicks), so drive the time controls directly.
  const tap = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
  const moonPos = () => page.evaluate(() => {
    for (const c of window.__cats) if (c.name === 'Moon' && c.sources?.length) return [c.sources[0].ra, c.sources[0].dec];
    return null;
  });
  const m0 = await moonPos();
  assert(m0, 'Moon marker missing');
  // The camera anchors in the observer's local frame — wait for the
  // geolocation cache (the horizon layer's boot flow fills it).
  await page.waitForFunction(async () => {
    const { cachedObserver } = await import('/js/observer.js');
    return !!cachedObserver();
  }, null, { timeout: 15000 });
  const centerRa = () => page.evaluate(() => window.__aladin.getRaDec()[0]);
  const ra0 = await centerRa();
  await tap('#time-btn');
  await page.waitForTimeout(300);
  await tap('#time-play');
  await page.waitForTimeout(2400); // hr/s → ~2.4 h of sky time
  const m1 = await moonPos();
  const moved = Math.hypot(((m1[0] - m0[0] + 540) % 360) - 180, m1[1] - m0[1]);
  assert(moved > 0.4, `Moon should move ≳1° under playback, moved ${moved.toFixed(2)}°`);
  // Planetarium behavior: the SKY ITSELF turns — the camera holds the
  // local line of sight, so the view center's RA streams during playback…
  const raPlay = await centerRa();
  const drift = Math.abs(((raPlay - ra0 + 540) % 360) - 180);
  assert(drift > 10, `view should stream with the diurnal motion, drifted ${drift.toFixed(1)}°`);
  const chip = await page.evaluate(() => document.getElementById('time-chip'));
  assert(chip !== null, 'chip element missing');
  await tap('#time-now');
  await page.waitForTimeout(700);
  const stopped = await page.evaluate(async () => (await import('/js/clock.js')).playSpeed() === 0);
  const chipHidden = await page.evaluate(() => document.getElementById('time-chip').hidden);
  assert(stopped && chipHidden, 'Back to now must stop playback and retire the chip');
  // …and Back to now turns it home again (round-trip through the anchor).
  const raBack = await centerRa();
  const home = Math.abs(((raBack - ra0 + 540) % 360) - 180);
  assert(home < 3, `Back to now should return the view (off by ${home.toFixed(2)}°)`);
  // The Easter egg: day/s + play cues the bundled track. The audio file
  // may not be deployed yet (owner-supplied), so the assertions target the
  // TRIGGER logic via its hook — armed at day/s playback, disarmed at stop.
  assert(await page.evaluate(() => !window.__eggWanted), 'egg must be unarmed before day/s playback');
  await tap('#time-btn');
  await page.waitForTimeout(300);
  await page.evaluate(() => { // slide to ∞ — the only position that arms the egg
    const s = document.getElementById('time-speed');
    s.value = '1000';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await tap('#time-play');
  await page.waitForTimeout(400);
  assert(await page.evaluate(() => window.__eggWanted === true), 'egg must arm on day/s playback');
  // Made in Heaven: the armed egg transforms the UI chrome (violet aura
  // theme — sky overlays were deliberately removed as clutter).
  assert(await page.evaluate(() => document.body.classList.contains('heaven')),
    'heaven theme must accompany the armed egg');
  await tap('#time-now');
  await page.waitForTimeout(400);
  assert(await page.evaluate(() => window.__eggWanted === false), 'egg must disarm when playback stops');
  assert(await page.evaluate(() => !document.body.classList.contains('heaven')),
    'heaven theme must lift when playback stops');
  // The slider→speed mapping across the whole track: EXACT real time at
  // the far left (value 0 is a falsy number — a `|| 500` fallback once
  // served hour-speed there), hour exactly at center, the maximum at ∞.
  const multAt = (val) => page.evaluate((v) => {
    const s = document.getElementById('time-speed');
    s.value = String(v);
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return window.__speedMult;
  }, val);
  assert(Math.abs(await multAt(0) - 1) < 1e-9, 'far left must map to exactly real time (1×)');
  assert(Math.abs(await multAt(500) - 3600) < 0.01, 'center must map to one hour per second');
  assert(Math.abs(await multAt(1000) - 51840) < 0.01, '∞ must map to the maximum rate');
  // Real-time playback is a real STATE: play at 1× reads as playing, keeps
  // the clock honest (unshifted — the offset is frozen, not accrued), and
  // never arms the egg.
  await multAt(0);
  await tap('#time-play');
  await page.waitForTimeout(600);
  const rt = await page.evaluate(async () => {
    const { playSpeed, isTimeShifted, timeOffsetMs } = await import('/js/clock.js');
    return {
      speed: playSpeed(), shifted: isTimeShifted(), offset: timeOffsetMs(),
      egg: window.__eggWanted,
      playing: document.getElementById('time-play').getAttribute('aria-pressed')
    };
  });
  assert(rt.speed === 1, `1× must register as playing at speed 1 (got ${rt.speed})`);
  assert(rt.offset === 0 && rt.shifted === false,
    'real-time playback from now must not shift the clock by even a millisecond');
  assert(!rt.egg, '1× must never arm the egg');
  assert(rt.playing === 'true', 'the play button must show playing at 1×');
  await tap('#time-now');
  await page.waitForTimeout(300);
  assert(await page.evaluate(async () => (await import('/js/clock.js')).playSpeed() === 0),
    'Back to now must stop real-time playback too');
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

await scenario('coordinate grid: draws, rescales with zoom, keeps edge labels', async () => {
  const { ctx, page } = await newPage(browser, baseURL);
  const overlayInk = () => page.evaluate(() => {
    const cv = document.getElementById('overlay-canvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  });
  await page.waitForTimeout(900);
  const before = await overlayInk();
  await flipRow(page, 'Coordinate grid');
  await page.waitForTimeout(800);
  const wide = await overlayInk();
  assert(wide > before + 2000, `grid should add visible lines (ink ${before} -> ${wide})`);
  // Zoom deep: the graticule must follow in real time, never vanish.
  // The star bloom and the center-ID bubble also ink this view — settle
  // the bubble first, then compare grid-on vs grid-off LIKE FOR LIKE.
  await page.evaluate(() => { window.__aladin.gotoRaDec(83.6, 22.0); window.__aladin.setFoV(1.5); });
  await page.waitForFunction(() => /crab/i.test(window.__dsaBubble || ''), null, { timeout: 20000 });
  await page.waitForTimeout(500);
  const deepOn = await overlayInk();
  await flipRow(page, 'Coordinate grid');
  await page.waitForTimeout(600);
  const deepOff = await overlayInk();
  assert(deepOn > deepOff + 2000, `grid must draw at deep zoom and clear when off (on ${deepOn}, off ${deepOff})`);
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});


await scenario('center ID: a known object under the crosshair pops its card', async () => {
  const { ctx, page } = await newPage(browser, baseURL);
  // Park the crosshair on the Crab Nebula (M1) — curated AND toured, so the
  // card must carry both a type line and a real description. (The boot view
  // itself may legitimately pop Sgr A* first — wait for the Crab by name.)
  await page.evaluate(() => { window.__aladin.gotoRaDec(83.63308, 22.0145); window.__aladin.setFoV(2); });
  await page.waitForFunction(
    () => !document.getElementById('center-card').hidden &&
      /crab/i.test(document.getElementById('center-name').textContent),
    null, { timeout: 20000 } // identification data loads on browser idle
  );
  const card = await page.evaluate(() => ({
    name: document.getElementById('center-name').textContent,
    desc: document.getElementById('center-desc').textContent
  }));
  assert(/crab/i.test(card.name), `card should name the Crab Nebula, got "${card.name}"`);
  assert(card.desc.length > 50, 'the known description must be shown');
  // Zoomed in this close, the object also gets its in-sky label bubble.
  await page.waitForFunction(() => /crab/i.test(window.__dsaBubble || ''), null, { timeout: 5000 });
  // Off to an empty patch: card and bubble must retire.
  await page.evaluate(() => { window.__aladin.gotoRaDec(140, -35); });
  await page.waitForFunction(
    () => document.getElementById('center-card').hidden && !window.__dsaBubble,
    null, { timeout: 5000 }
  );
  // A tour toast announcing the destination suppresses the duplicate card
  // for that one arrival — but the quiet sky bubble still labels it.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('dsa:destination-announced', { detail: { ra: 83.63308, dec: 22.0145 } }));
    window.__aladin.gotoRaDec(83.63308, 22.0145);
  });
  await page.waitForFunction(() => /crab/i.test(window.__dsaBubble || ''), null, { timeout: 5000 });
  const dupCard = await page.evaluate(() => !document.getElementById('center-card').hidden);
  assert(!dupCard, 'card must stand down when the tour toast already announced the object');
  // The crosshair itself is part of the feature — it must exist and sit centered.
  const cross = await page.locator('#crosshair').boundingBox();
  const vp = page.viewportSize();
  assert(cross && Math.abs(cross.x + cross.width / 2 - vp.width / 2) < 2, 'crosshair must mark the view center');
  // Bundled descriptions: a curated object WITHOUT a tour caption (M2) gets
  // its Wikipedia extract on the card, with the CC BY-SA attribution link.
  await page.evaluate(() => { window.__aladin.gotoRaDec(323.3625, -0.8233); window.__aladin.setFoV(2); });
  // (the description fill runs in the background after the identification
  // set loads — wait for the text itself, not just the card)
  await page.waitForFunction(
    () => !document.getElementById('center-card').hidden &&
      /M2/.test(document.getElementById('center-name').textContent) &&
      /globular/i.test(document.getElementById('center-desc')?.textContent || ''),
    null, { timeout: 10000 });
  const m2 = await page.evaluate(() => ({
    desc: document.getElementById('center-desc')?.textContent || '',
    credit: document.querySelector('#center-desc .obj-desc-credit')?.href || null
  }));
  assert(/globular cluster/i.test(m2.desc), `M2 card should describe the cluster, got "${m2.desc.slice(0, 80)}"`);
  assert(m2.credit && m2.credit.includes('en.wikipedia.org'), 'card description must carry its attribution link');
  // …and the detail panel fills its description slot the same way.
  const panel = await page.evaluate(async () => {
    const { renderDetailPanel } = await import('/js/ui.js');
    renderDetailPanel({ name: 'M2', typeLabel: 'Globular cluster', ra: 323.3625, dec: -0.8233 });
    await new Promise((r) => setTimeout(r, 700));
    const slot = document.querySelector('#detail-content .desc-slot');
    return {
      text: slot?.querySelector('.obj-desc')?.textContent || '',
      credit: slot?.querySelector('.obj-desc-credit')?.textContent || null
    };
  });
  assert(/globular cluster/i.test(panel.text), 'detail panel must show the bundled description');
  assert(panel.credit === 'Wikipedia · CC BY-SA 4.0', `attribution must be exact, got "${panel.credit}"`);
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

await scenario('onboarding: guided tour steps through, persists; ? and / work', async () => {
  const { ctx, page } = await newPage(browser, baseURL, { geolocation: false, guide: true });
  // Menus must NOT open themselves on a first visit — the tour points
  // instead. (Their expanded state is the user's choice, persisted.)
  assert(await page.evaluate(() => document.getElementById('layer-dock').classList.contains('collapsed')),
    'layer dock must start collapsed');
  assert(await page.evaluate(() => document.getElementById('spectrum-rail').classList.contains('collapsed')),
    'spectrum rail must start collapsed');
  // The click-through tour: welcome first, then Next walks the targets with
  // the highlight ring; the Sky Now step keeps the optional-location promise.
  await page.waitForSelector('#ui-guide', { timeout: 10000 });
  const welcome = await page.textContent('#ui-guide .guide-text');
  assert(/welcome/i.test(welcome), `first step should welcome, got: ${welcome}`);
  let sawLocationPromise = false;
  let ringShown = false;
  for (let i = 0; i < 5; i++) {
    await page.click('#ui-guide .guide-next');
    await page.waitForTimeout(250);
    const t = await page.textContent('#ui-guide .guide-text');
    if (/location/i.test(t) && /optional/i.test(t)) sawLocationPromise = true;
    if (await page.evaluate(() => {
      const r = document.getElementById('guide-ring');
      return r && r.style.opacity === '1' && parseFloat(r.style.width) > 10;
    })) ringShown = true;
  }
  assert(sawLocationPromise, 'a tour step must carry the optional-location promise');
  assert(ringShown, 'the highlight ring must mark targets');
  await page.click('#ui-guide .guide-next'); // "Done" on the last step
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => !document.getElementById('ui-guide')),
    'finishing the tour must remove it');
  await page.reload();
  await page.waitForFunction(() => window.__aladin, null, { timeout: 60000 });
  await page.waitForTimeout(3500);
  await page.waitForTimeout(2500); // past the tour's own appearance delay
  assert(await page.evaluate(() => !document.getElementById('ui-guide')),
    'a finished tour must never return');
  // Keyboard: "?" opens the controls sheet, Esc closes it, "/" focuses search.
  await page.keyboard.press('?');
  assert(!(await page.evaluate(() => document.getElementById('shortcuts-sheet').hidden)), '? must open the shortcuts sheet');
  await page.keyboard.press('Escape');
  assert(await page.evaluate(() => document.getElementById('shortcuts-sheet').hidden), 'Esc must close the shortcuts sheet');
  await page.keyboard.press('/');
  const focused = await page.evaluate(() => document.activeElement?.id);
  assert(focused === 'search-input', `/ must focus search (focused: ${focused})`);
  // Hostile markup in a search must render as TEXT, never execute — the
  // history dropdown once fed raw queries through innerHTML (stored XSS).
  await page.evaluate(async () => {
    const { addToHistory } = await import('/js/search.js');
    addToHistory({ query: '<img src=x onerror="window.__xss=1">', ra: null, dec: null, label: '<b>evil</b>' });
    document.getElementById('search-input').blur();
  });
  await page.click('#search-input');
  await page.waitForTimeout(400);
  const hist = await page.evaluate(() => ({
    xss: window.__xss,
    html: document.getElementById('search-history').innerHTML
  }));
  assert(!hist.xss && hist.html.includes('&lt;b&gt;evil&lt;/b&gt;'),
    'search history must render hostile input inert');
  // Coordinate parsing: impossible clock/angle values must be rejected, and
  // 360° must normalize to the canonical 0°.
  const coords = await page.evaluate(async () => {
    const { parseCoordinates } = await import('/js/search.js');
    return {
      badHour: parseCoordinates('25 10 10 +20 10 10'),
      badMin: parseCoordinates('10 61 10 +20 10 10'),
      badDec: parseCoordinates('10 10 10 +91 10 10'),
      overPole: parseCoordinates('10 10 10 +90 00 01'),
      wrap: parseCoordinates('360 45'),
      good: parseCoordinates('12 30 00 -45 30 00'),
      huge: parseCoordinates('1'.repeat(500))
    };
  });
  assert(coords.badHour === null && coords.badMin === null && coords.badDec === null &&
    coords.overPole === null && coords.huge === null, 'impossible coordinates must be rejected');
  assert(coords.wrap && coords.wrap.ra === 0 && coords.wrap.dec === 45, '360° must normalize to 0°');
  assert(coords.good && Math.abs(coords.good.ra - 187.5) < 1e-9 && Math.abs(coords.good.dec + 45.5) < 1e-9,
    'valid sexagesimal must parse exactly');
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

await scenario('cosmic web: 3-D mode enters and exits, or degrades gracefully without data', async () => {
  const { ctx, page } = await newPage(browser, baseURL);
  await page.click('#dock-collapse');
  await page.waitForTimeout(700);
  // The dataset is Action-generated: this scenario proves BOTH sides of
  // that fact — full mode when the file is deployed, honest degradation
  // (toast + reverted switch, no errors) when it isn't.
  const hasData = await page.evaluate(async () => {
    try { return (await fetch('data/desi_web.bin')).ok; } catch (e) { return false; }
  });
  await flipRow(page, 'Cosmic web 3-D');
  await page.waitForTimeout(3000);
  if (hasData) {
    assert(await page.evaluate(() => document.getElementById('cosmos-canvas')?.style.display === 'block'),
      '3-D canvas must take the viewport');
    assert(await page.evaluate(() => /DESI DR1/.test(document.getElementById('cosmos-legend')?.textContent || '')),
      'legend must name and credit DESI');
    // The exit control is a TEXT button: it must be wide enough for its
    // label (the .glass-btn base is a 40px icon circle) and sit centered.
    const exit = await page.locator('#cosmos-exit').boundingBox();
    assert(exit && exit.width > 90, `exit button must fit its label, width ${exit?.width}`);
    assert(Math.abs(exit.x + exit.width / 2 - page.viewportSize().width / 2) < 3,
      'exit button must be horizontally centered');
    // The legend obeys the app-wide notification contract: an ✕ dismisses
    // it while the 3-D mode itself stays up.
    await page.click('#cosmos-legend .legend-close');
    await page.waitForTimeout(250);
    assert(await page.evaluate(() => document.getElementById('cosmos-legend').style.display === 'none'),
      'the legend ✕ must dismiss it');
    assert(await page.evaluate(() => document.getElementById('cosmos-canvas').style.display === 'block'),
      'dismissing the legend must not exit the mode');
    // Escape leaves the mode AND flips the dock switch back off.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    assert(await page.evaluate(() => document.getElementById('cosmos-canvas').style.display === 'none'),
      'Escape must return to the sky');
    const st = await rowState(page, 'Cosmic web 3-D');
    assert(st.checked === false, 'the dock switch must follow the exit');
  } else {
    const st = await rowState(page, 'Cosmic web 3-D');
    assert(st.checked === false, 'the switch must revert when the dataset is absent');
    assert(await page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /DESI 3-D/.test(t.textContent || ''))),
      'a toast must explain the missing dataset');
  }
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

await scenario('phone layout: dock rows never truncate their labels', async () => {
  // iPhone-class viewport: the dock narrows via the max-width media query,
  // and "Horizon & compass" once ellipsized there — the first thing a
  // design-minded eye catches. Deep sky is flipped on first so the widest
  // count ("12,149") is in play while measuring.
  const { ctx, page } = await newPage(browser, baseURL, { viewport: { width: 390, height: 844 } });
  await page.click('#dock-collapse');
  await page.waitForTimeout(700);
  await flipRow(page, 'Deep sky');
  await page.waitForTimeout(3000);
  const bad = await page.evaluate(() => [...document.querySelectorAll('#layer-dock-list .toggle-text')]
    .filter((el) => el.scrollWidth > el.clientWidth + 1)
    .map((el) => el.textContent));
  assert(bad.length === 0, `truncated dock labels at phone width: ${bad.join(', ')}`);
  // The dock as a whole must still fit the narrow viewport.
  const dock = await page.locator('#layer-dock').boundingBox();
  assert(dock.x >= 0 && dock.x + dock.width <= 390, 'dock must fit the phone viewport');
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

await scenario('sound effects: gestures tick, boot is silent, checkbox mutes', async () => {
  const { ctx, page } = await newPage(browser, baseURL);
  const sfx = () => page.evaluate(() => window.__sfx || 0);
  // Boot fires programmatic toggles — none of them may make a sound.
  assert((await sfx()) === 0, 'boot must be silent');
  // A REAL pointer gesture unlocks audio (synthetic .click() does not).
  await page.click('#dock-collapse');
  await page.waitForTimeout(120);
  await page.click('#dock-collapse');
  await page.waitForTimeout(120);
  // Two gesture toggles (the first click also unlocks the AudioContext).
  await flipRow(page, 'Coordinate grid');
  await page.waitForTimeout(150);
  await flipRow(page, 'Coordinate grid');
  await page.waitForTimeout(150);
  const afterTicks = await sfx();
  assert(afterTicks >= 1, `gesture toggles should tick (count ${afterTicks})`);
  // Mute via the Sound effects checkbox: later gestures stay silent.
  await flipRow(page, 'Sound effects');
  await page.waitForTimeout(150);
  const muted = await sfx();
  await flipRow(page, 'Constellations');
  await page.waitForTimeout(300);
  assert((await sfx()) === muted, 'no ticks while Sound effects is off');
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

// ---------------------------------------------------------------- done ---
await browser.close();
server.close();
await rm(path.join(CACHE, 'engine-test.html'), { force: true });

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ` — ${failures.join('; ')}` : ''}`);
if (failures.length) process.exitCode = 1;
