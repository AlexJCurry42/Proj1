// Pocket Planetarium — browser regression suite. Runs the REAL app against
// the REAL Aladin Lite engine in headless Chromium, covering the behavior
// the unit tests can't see: boot budget, lazy layers, flights, the star
// bloom, the horizon lock, spectrum transitions, time-lapse, the location
// consent card. Every scenario here began life as a bug the unit suite
// missed.
//
// Run: `node tests/browser/run.mjs`
//   needs: playwright (CI: `npm i --no-save playwright`), a chromium
//   (CI: `npx playwright install --with-deps chromium`), and network access
//   to fetch the engine bundle once (cached in tests/browser/.cache).
// Env overrides: PLAYWRIGHT_MODULE, CHROME_PATH, ALADIN_JS (path to a local
// engine bundle instead of downloading).

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm, copyFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE = path.join(ROOT, 'tests/browser/.cache');
const ENGINE_URL = 'https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js';

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

// ---- fixture: the app served locally with the engine bundle inlined ----
async function prepareFixture() {
  await mkdir(CACHE, { recursive: true });
  const enginePath = path.join(CACHE, 'aladin-local.js');
  const hasEngine = await access(enginePath).then(() => true, () => false);
  if (!hasEngine) {
    if (process.env.ALADIN_JS) {
      await copyFile(process.env.ALADIN_JS, enginePath);
    } else {
      const res = await fetch(ENGINE_URL, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`engine download failed: HTTP ${res.status}`);
      await writeFile(enginePath, Buffer.from(await res.arrayBuffer()));
    }
  }
  const html = (await readFile(path.join(ROOT, 'index.html'), 'utf8')).replace(
    /<script src="https:\/\/aladin\.cds\.unistra\.fr[^"]*" charset="utf-8" defer><\/script>/,
    '<script type="module">import A from "/tests/browser/.cache/aladin-local.js"; window.A = A;</script>'
  );
  await writeFile(path.join(CACHE, 'engine-test.html'), html);
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
async function scenario(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL  ${name}\n      ${err.message}`);
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

async function newPage(browser, baseURL, { geolocation = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 600, height: 700 } });
  if (geolocation) {
    await ctx.grantPermissions(['geolocation'], { origin: baseURL });
    await ctx.setGeolocation({ latitude: 37.77, longitude: -122.42 });
  }
  const page = await ctx.newPage();
  page.__errors = [];
  page.__console = [];
  page.on('pageerror', (e) => { if (!IGNORE_ERR.test(e.message)) page.__errors.push(e.message); });
  page.on('console', (m) => { page.__console.push(`[${m.type()}] ${m.text()}`.slice(0, 300)); });
  await page.addInitScript(INIT);
  page.__dataReqs = [];
  page.on('request', (r) => { const u = r.url(); if (u.includes('/data/')) page.__dataReqs.push(u.split('/data/')[1]); });
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

const row = (label) => `[...document.querySelectorAll('#layer-dock-list li')].find(li => li.querySelector('.toggle-text')?.textContent === ${JSON.stringify(label)})`;
const flipRow = (page, label) => page.evaluate(`${row(label)}.querySelector('input').click()`);
const rowState = (page, label) => page.evaluate(`(() => { const li = ${row(label)}; return li ? { checked: li.querySelector('input').checked, count: li.querySelector('.toggle-count')?.textContent || '', loading: li.classList.contains('loading') } : null; })()`);

// ============================================================ scenarios ===
const pw = await loadPlaywright();
await prepareFixture();
const server = await startServer();
const baseURL = `http://127.0.0.1:${server.address().port}`;
const LAUNCH_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
let browser;
if (chromePath()) {
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

await scenario('boot: lean fetch budget, no dead chrome, zero errors (granted geo)', async () => {
  const { ctx, page } = await newPage(browser, baseURL);
  const dataFiles = new Set(page.__dataReqs.map((u) => u.split('?')[0]));
  // boot may fetch: tours, the star tiers (faint arrives on idle — off the
  // critical path by design), the ISS TLE (observer already granted) —
  // never the catalogs of default-off layers.
  const allowed = ['tours.json', 'brightstars.json', 'brightstars_faint.json', 'brightstars_seed.json', 'satellites_tle.txt'];
  for (const f of dataFiles) {
    assert(allowed.includes(f), `unexpected boot fetch: ${f}`);
  }
  const boot = await page.evaluate(`(() => ({
    warp: !!document.getElementById('warp-canvas'),
    satToggle: !!${row('Satellites & ISS')},
    horizon: ${row('Horizon & compass')}?.querySelector('input').checked,
    locCardHidden: document.getElementById('loc-card').hidden
  }))()`);
  assert(!boot.warp, 'warp canvas should not exist');
  assert(!boot.satToggle, 'satellite toggle should not exist');
  assert(boot.horizon === true, 'horizon should default on');
  assert(boot.locCardHidden, 'consent card must not show when permission already granted');
  // ISS joins the Solar System layer once the observer resolves
  await page.waitForTimeout(1500);
  const solar = await rowState(page, 'Solar System');
  assert(solar.count === '12', `Solar System count should be 12 with ISS, got "${solar.count}"`);
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

await scenario('location consent: card shows without permission; decline is remembered', async () => {
  const { ctx, page } = await newPage(browser, baseURL, { geolocation: false });
  const shown = await page.evaluate(() => !document.getElementById('loc-card').hidden);
  assert(shown, 'consent card should show at boot in permission-prompt state');
  await page.click('#loc-decline');
  await page.waitForTimeout(400);
  const after = await rowState(page, 'Horizon & compass');
  assert(after.checked === false, 'declining must uncheck the horizon');
  await page.reload();
  await page.waitForFunction(() => window.__aladin, null, { timeout: 45000 });
  await page.waitForTimeout(2500);
  const again = await page.evaluate(() => !document.getElementById('loc-card').hidden);
  assert(!again, 'the card must not nag after a decline');
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

await scenario('lazy dock: Deep sky fetches its own files on first flip, shimmer clears', async () => {
  const { ctx, page } = await newPage(browser, baseURL);
  page.__dataReqs.length = 0;
  // The shimmer can clear within milliseconds against a local server, so
  // watch for it with an observer instead of sampling on a timer.
  const sawShimmer = page.evaluate(`new Promise((resolve) => {
    const li = ${row('Deep sky')};
    if (li.classList.contains('loading')) { resolve(true); return; }
    const mo = new MutationObserver(() => {
      if (li.classList.contains('loading')) { mo.disconnect(); resolve(true); }
    });
    mo.observe(li, { attributes: true, attributeFilter: ['class'] });
    setTimeout(() => { mo.disconnect(); resolve(li.classList.contains('loading')); }, 3000);
  })`);
  await flipRow(page, 'Deep sky');
  assert(await sawShimmer, 'row should shimmer while loading');
  await page.waitForTimeout(3500);
  const done = await rowState(page, 'Deep sky');
  assert(!done.loading, 'shimmer must clear');
  assert(done.count === '12,149', `Deep sky count should be 12,149, got "${done.count}"`);
  const fetched = new Set(page.__dataReqs.map((u) => u.split('?')[0]));
  assert(fetched.has('messier_ngc.json') && fetched.has('ngc_full.json'),
    `expected deep-sky files, got: ${[...fetched].join(', ')}`);
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
  const toast = await page.textContent('.toast').catch(() => null);
  await page.waitForTimeout(5300);
  const r = await page.evaluate(async () => {
    window.__tracing = false;
    const tours = (await (await fetch('data/tours.json')).json()).destinations;
    const p = new URLSearchParams(location.hash.slice(1));
    return { trace: window.__trace, hash: { survey: p.get('survey'), ra: +p.get('ra'), dec: +p.get('dec') }, tours };
  });
  const dest = r.tours.find((t) => t.name === (toast || '').split(' — ')[0]);
  assert(dest, 'destination not identified from toast');
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
      a[m] = (...la) => { window.__layerCalls.push(String(la[0]?.id || la[0])); return om(...la); };
    }
  });
  const track = await page.locator('#spectrum-track').boundingBox();
  await page.mouse.click(track.x + track.width / 2, track.y + 14); // top stop: Fermi, 3 stops away
  await page.waitForTimeout(1600);
  const calls = await page.evaluate(() => window.__layerCalls);
  assert(!calls.some((c) => /SDSS|PanSTARRS/.test(c)), `intermediate surveys touched: ${calls.join(', ')}`);
  const survey = await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('survey'));
  assert(survey === 'P/Fermi/color', `should settle on Fermi, got ${survey}`);
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

await scenario('time: playback moves the Moon; Back to now stops and resets', async () => {
  const { ctx, page } = await newPage(browser, baseURL);
  const moonPos = () => page.evaluate(() => {
    for (const c of window.__cats) if (c.name === 'Moon' && c.sources?.length) return [c.sources[0].ra, c.sources[0].dec];
    return null;
  });
  const m0 = await moonPos();
  assert(m0, 'Moon marker missing');
  await page.click('#time-btn');
  await page.waitForTimeout(300);
  await page.click('#time-play');
  await page.waitForTimeout(2400); // hr/s → ~2.4 h of sky time
  const m1 = await moonPos();
  const moved = Math.hypot(((m1[0] - m0[0] + 540) % 360) - 180, m1[1] - m0[1]);
  assert(moved > 0.4, `Moon should move ≳1° under playback, moved ${moved.toFixed(2)}°`);
  const chip = await page.evaluate(() => document.getElementById('time-chip'));
  assert(chip !== null, 'chip element missing');
  await page.click('#time-now');
  await page.waitForTimeout(700);
  const stopped = await page.evaluate(async () => (await import('/js/clock.js')).playSpeed() === 0);
  const chipHidden = await page.evaluate(() => document.getElementById('time-chip').hidden);
  assert(stopped && chipHidden, 'Back to now must stop playback and retire the chip');
  assert(page.__errors.length === 0, `page errors: ${page.__errors.join('; ')}`);
  await ctx.close();
});

// ---------------------------------------------------------------- done ---
await browser.close();
server.close();
await rm(path.join(CACHE, 'engine-test.html'), { force: true });

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ` — ${failures.join('; ')}` : ''}`);
if (failures.length) process.exitCode = 1;
