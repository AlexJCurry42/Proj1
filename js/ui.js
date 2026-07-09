// Deep Sky Atlas — UI chrome: toasts, object detail panel, tours, onboarding,
// about/credits modal, red-light night-vision mode.

import { fetchJSON } from './net.js';
import { attachRenderIfFamous } from './render3d.js';

const SIMBAD_TAP_URL = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';

let objectTypesDict = null;
const simbadCache = new Map(); // "ra,dec" (rounded) -> result

// ---------------------------------------------------------------- Toasts ---

export function showToast(message, kind = 'info', timeoutMs = 6000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    // Graceful exit: play the out animation, then remove (with a safety
    // timeout so reduced-motion users aren't left with a stuck toast).
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 500);
  }, timeoutMs);
}

// ------------------------------------------------------- Object type dict ---

async function loadObjectTypesDict() {
  if (objectTypesDict) return objectTypesDict;
  try {
    objectTypesDict = await fetchJSON('data/object_types.json');
  } catch (err) {
    objectTypesDict = {};
    showToast('Could not load object-type dictionary; raw codes will be shown.', 'error');
  }
  return objectTypesDict;
}

export async function humanObjectType(code) {
  if (!code) return 'Unknown type';
  const dict = await loadObjectTypesDict();
  return dict[code] || code;
}

// ----------------------------------------------------------- Coord format ---

export function toSexagesimalRA(raDeg) {
  // Round to 0.1 s of time FIRST, then decompose, so 59.96 s carries into the
  // next minute instead of printing the invalid "60.0s".
  let ds = Math.round((((raDeg % 360) + 360) % 360) / 15 * 36000); // deciseconds
  ds = ds % 864000;
  const hh = Math.floor(ds / 36000);
  const mm = Math.floor((ds % 36000) / 600);
  const ss = (ds % 600) / 10;
  return `${String(hh).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m ${ss.toFixed(1).padStart(4, '0')}s`;
}

export function toSexagesimalDec(decDeg) {
  const sign = decDeg < 0 ? '-' : '+';
  // Same carry-safe rounding, in tenths of an arcsecond.
  let das = Math.round(Math.abs(decDeg) * 36000);
  const dd = Math.floor(das / 36000);
  const mm = Math.floor((das % 36000) / 600);
  const ss = (das % 600) / 10;
  return `${sign}${String(dd).padStart(2, '0')}° ${String(mm).padStart(2, '0')}' ${ss.toFixed(1).padStart(4, '0')}"`;
}

// -------------------------------------------------------------- SIMBAD TAP --

/** On-demand cone-search of SIMBAD's TAP service around a clicked sky position. */
export async function fetchSimbadNear(ra, dec, radiusDeg = 0.02) {
  // Never let bad inputs reach the ADQL string — "CIRCLE('ICRS', undefined,…)"
  // is a guaranteed HTTP 400 from the TAP parser.
  const raNum = Number(ra), decNum = Number(dec);
  if (!Number.isFinite(raNum) || !Number.isFinite(decNum)) {
    throw new Error('this source did not report usable coordinates');
  }
  const raQ = raNum.toFixed(6), decQ = decNum.toFixed(6);
  const key = `${raQ},${decQ}`;
  if (simbadCache.has(key)) return simbadCache.get(key);

  // Minimal, parser-safe ADQL: no joins, and the DISTANCE expression is
  // selected under an alias then ordered by the alias — the pattern SIMBAD's
  // own TAP examples use. (Magnitude is skipped deliberately; the compound
  // flux join this replaced was 400-ing on the strict grammar.)
  const query =
    `SELECT TOP 1 oid, main_id, otype, ra, dec, plx_value, ` +
    `DISTANCE(POINT('ICRS', ra, dec), POINT('ICRS', ${raQ}, ${decQ})) AS dist ` +
    `FROM basic ` +
    `WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${raQ}, ${decQ}, ${radiusDeg})) = 1 ` +
    `ORDER BY dist ASC`;

  const url = `${SIMBAD_TAP_URL}?request=doQuery&lang=adql&format=json&query=${encodeURIComponent(query)}`;
  const json = await fetchJSON(url);
  const rows = json.data || [];
  if (!rows.length) throw new Error('No SIMBAD object found at this position');

  const cols = (json.metadata || []).map(m => m.name);
  const row = rows[0];
  const get = (name) => row[cols.indexOf(name)];

  const result = {
    name: get('main_id'),
    otype: get('otype'),
    ra: get('ra'),
    dec: get('dec'),
    distancePc: get('plx_value') ? 1000 / get('plx_value') : null,
    mag: null
  };

  // V magnitude via a SEPARATE query so a schema hiccup in the flux table
  // can never break the main lookup (a compound join here once 400-ed).
  try {
    const oid = get('oid');
    if (oid != null) {
      const magQuery = `SELECT V FROM allfluxes WHERE oidref = ${oid}`;
      const magJson = await fetchJSON(`${SIMBAD_TAP_URL}?request=doQuery&lang=adql&format=json&query=${encodeURIComponent(magQuery)}`);
      const v = magJson.data?.[0]?.[0];
      if (v != null) result.mag = v;
    }
  } catch (err) { /* magnitude is a bonus, never a blocker */ }

  simbadCache.set(key, result);
  return result;
}

// --------------------------------------------------------------- Detail panel ---

const detailPanel = () => document.getElementById('detail-panel');
const detailContent = () => document.getElementById('detail-content');

export function closeDetailPanel() {
  detailPanel().hidden = true;
  detailContent().innerHTML = '';
}

// ------------------------------------------------------------- Lightbox ---

let lightboxReturnFocus = null;

export function openLightbox(src, caption) {
  closeLightbox();
  lightboxReturnFocus = document.activeElement;
  const lb = document.createElement('div');
  lb.id = 'lightbox';
  lb.setAttribute('role', 'dialog');
  lb.setAttribute('aria-label', caption || 'Enlarged image');
  const img = document.createElement('img');
  img.src = src;
  img.alt = caption || '';
  const cap = document.createElement('p');
  cap.textContent = caption || '';
  const btn = document.createElement('button');
  btn.className = 'glass-btn small';
  btn.id = 'lightbox-close';
  btn.setAttribute('aria-label', 'Close enlarged image');
  btn.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="7" y1="7" x2="17" y2="17"/><line x1="17" y1="7" x2="7" y2="17"/></svg>';
  btn.addEventListener('click', closeLightbox);
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
  lb.append(img, cap, btn);
  document.body.appendChild(lb);
  btn.focus();
}

export function closeLightbox() {
  const lb = document.getElementById('lightbox');
  if (!lb) return;
  lb.remove();
  lightboxReturnFocus?.focus?.({ preventScroll: true });
  lightboxReturnFocus = null;
}

// ------------------------------------------------------ Global keyboard ---

/** Escape dismisses the topmost surface; Tab is trapped inside open modals. */
export function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Let the search field's native Escape (clear text) win while focused.
    if (e.target && e.target.id === 'search-input') return;
    if (document.getElementById('lightbox')) { closeLightbox(); return; }
    const onboarding = document.getElementById('onboarding');
    if (!onboarding.hidden) { document.getElementById('onboarding-skip').click(); return; }
    const about = document.getElementById('about-modal');
    if (!about.hidden) { document.getElementById('about-close').click(); return; }
    if (!detailPanel().hidden) closeDetailPanel();
  });
}

function trapFocus(container) {
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusables = container.querySelectorAll('button, a[href], select, input, [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

export function showDetailLoading() {
  detailPanel().hidden = false;
  detailContent().innerHTML = `<p id="detail-loading">Loading object details…</p>`;
}

/**
 * Render the object detail panel.
 * obj: { name, aliases, typeLabel, ra, dec, mag, distanceText, badges, extraRows, source, approxNote }
 */
export function renderDetailPanel(obj) {
  const wasHidden = detailPanel().hidden;
  detailPanel().hidden = false;
  const rows = [];
  rows.push(row('RA (ICRS)', `${toSexagesimalRA(obj.ra)} / ${obj.ra.toFixed(5)}°`));
  rows.push(row('Dec (ICRS)', `${toSexagesimalDec(obj.dec)} / ${obj.dec.toFixed(5)}°`));
  if (obj.mag !== undefined && obj.mag !== null) rows.push(row('Magnitude', obj.mag));
  if (obj.distanceText) rows.push(row('Distance', obj.distanceText));
  for (const [label, value] of obj.extraRows || []) rows.push(row(label, value));

  const nameForLinks = encodeURIComponent(obj.name || '');
  const badges = (obj.badges || []).map(b => `<span class="badge-eht">${b}</span>`).join('');

  detailContent().innerHTML = `
    <h3>${escapeHtml(obj.name || 'Unknown object')}${badges}</h3>
    <span class="dtype">${escapeHtml(obj.typeLabel || 'Unknown type')}</span>
    ${obj.aliases && obj.aliases.length ? `<p class="hint">Also known as: ${escapeHtml(obj.aliases.join(', '))}</p>` : ''}
    <div class="drows">${rows.join('')}</div>
    ${obj.approxNote ? `<p class="approx-note">⚠ ${escapeHtml(obj.approxNote)}</p>` : ''}
    ${obj.source ? `<p class="hint">Source: ${escapeHtml(obj.source)}</p>` : ''}
    <div class="dlinks">
      <a href="https://simbad.cds.unistra.fr/simbad/sim-basic?Ident=${nameForLinks}" target="_blank" rel="noopener">SIMBAD</a>
      <a href="https://ned.ipac.caltech.edu/cgi-bin/objsearch?objname=${nameForLinks}" target="_blank" rel="noopener">NED</a>
      <a href="https://en.wikipedia.org/w/index.php?search=${nameForLinks}" target="_blank" rel="noopener">Wikipedia</a>
    </div>
  `;
  // Famous objects (and every black hole) get a procedural 3-D render,
  // inserted between the type chip and the data rows. Fire-and-forget.
  attachRenderIfFamous(detailContent(), obj);
  // Move keyboard focus into the freshly-opened panel (a11y), without
  // yanking it on every re-render while the panel is already open.
  if (wasHidden) document.getElementById('detail-close').focus({ preventScroll: true });
}

function row(label, value) {
  return `<div class="drow"><span>${escapeHtml(label)}</span><span>${escapeHtml(String(value))}</span></div>`;
}

const escapeDiv = document.createElement('div');
function escapeHtml(str) {
  escapeDiv.textContent = str;
  return escapeDiv.innerHTML;
}

export function initDetailPanelClose() {
  document.getElementById('detail-close').addEventListener('click', closeDetailPanel);
  const panel = document.getElementById('detail-panel');
  makeSheetDraggable(panel, panel, closeDetailPanel);
}

// ------------------------------------------------- Mobile sheet gestures ---

const isPhone = () => window.matchMedia('(max-width: 640px)').matches;

/**
 * Swipe-down-to-dismiss for mobile bottom sheets. A drag can start from the
 * grabber, or from anywhere in the sheet while its scroller sits at the top.
 * The sheet follows the finger; past ~90 px (or a quick flick) it dismisses,
 * otherwise it springs back.
 */
function makeSheetDraggable(sheet, scroller, onDismiss) {
  let startY = null, curY = 0, dragging = false, startT = 0;

  sheet.addEventListener('touchstart', (e) => {
    if (!isPhone()) return;
    const fromGrabber = !!e.target.closest('.sheet-grabber');
    if (!fromGrabber && scroller && scroller.scrollTop > 2) return;
    startY = e.touches[0].clientY;
    startT = Date.now();
    curY = 0;
    dragging = false;
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (startY == null || !isPhone()) return;
    const dy = e.touches[0].clientY - startY;
    if (!dragging && dy > 8) dragging = true;
    if (dragging) {
      if (e.cancelable) e.preventDefault(); // the gesture owns this move, not the scroller
      curY = Math.max(0, dy);
      sheet.style.transition = 'none';
      sheet.style.transform = `translateY(${curY}px)`;
    }
  }, { passive: false });

  const end = () => {
    if (startY == null) return;
    const velocity = curY / Math.max(Date.now() - startT, 1); // px/ms
    sheet.style.transition = '';
    if (dragging && (curY > 90 || velocity > 0.55)) onDismiss();
    // Clear the inline transform on the next frame so the stylesheet's
    // transition animates the sheet the rest of the way (down or back up).
    requestAnimationFrame(() => { sheet.style.transform = ''; });
    startY = null; curY = 0; dragging = false;
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);

  // A plain tap on the grabber also dismisses.
  sheet.querySelector('.sheet-grabber')?.addEventListener('click', onDismiss);
}

// -------------------------------------------------------------------- Tours ---

export async function initTours(aladin) {
  let tours;
  try {
    tours = (await fetchJSON('data/tours.json')).destinations;
  } catch (err) {
    showToast('Could not load guided tour destinations.', 'error');
    return;
  }
  const select = document.getElementById('tour-select');
  for (const t of tours) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    select.appendChild(opt);
  }

  // Each selection is a three-act flight: rise (pull back so there's a sky to
  // cross), glide (the engine's great-circle animation), descend (eased zoom
  // into the destination). Picking another tour mid-flight cancels the rest
  // of this one and starts the new flight from wherever the view is now.
  let flightToken = 0;
  const easeInOutCubic = (u) => u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  function easeFov(toFov, ms, token) {
    return new Promise((resolve) => {
      let from;
      try { from = aladin.getFov()[0]; } catch (err) { resolve(false); return; }
      if (!Number.isFinite(from) || Math.abs(from - toFov) < 0.001) { resolve(true); return; }
      const t0 = performance.now();
      const step = (t) => {
        if (token !== flightToken) { resolve(false); return; }
        const u = Math.min(1, (t - t0) / ms);
        try { aladin.setFoV(from + (toFov - from) * easeInOutCubic(u)); } catch (err) { /* engine hiccup */ }
        if (u < 1) requestAnimationFrame(step); else resolve(true);
      };
      requestAnimationFrame(step);
    });
  }
  const pause = (ms, token) => new Promise((r) => setTimeout(() => r(token === flightToken), ms));

  select.addEventListener('change', async () => {
    const t = tours.find(x => x.id === select.value);
    select.value = '';
    if (!t) return;
    const token = ++flightToken;
    showToast(t.caption, 'info', 12000);

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || typeof aladin.animateToRaDec !== 'function') {
      aladin.gotoRaDec(t.ra, t.dec);
      aladin.setFoV(t.fov_deg);
      return;
    }

    // Act 1 — rise: if we're zoomed in tight, pull back first so the glide
    // reads as travel across the sky rather than an anonymous smear.
    let cur = 60;
    try { cur = aladin.getFov()[0]; } catch (err) { /* keep default */ }
    if (cur < 25) {
      if (!await easeFov(Math.min(60, Math.max(cur * 4, 35)), 750, token)) return;
    }
    // Act 2 — glide.
    try { aladin.animateToRaDec(t.ra, t.dec, 1.6); } catch (err) { aladin.gotoRaDec(t.ra, t.dec); }
    if (!await pause(1650, token)) return;
    // Act 3 — descend into the destination.
    await easeFov(t.fov_deg, 1200, token);
  });
}

// --------------------------------------------------------------- Onboarding ---

const ONBOARDING_STEPS = [
  { title: 'Explore the sky', body: 'Drag to pan, pinch to zoom. This is the real sky — more detail and more objects reveal themselves the deeper you go.' },
  { title: 'Light up the sky', body: 'The menu on the left holds the universe: constellations, black holes, exoplanets, whole catalogs. Switch on a layer and tap any glowing marker for its story.' },
  { title: 'Search the universe', body: 'Try "Cygnus X-1" or "Orion Nebula" — or pick a Tour for a guided flight to the sky’s greatest hits.' }
];

function onboardingSeen(set) {
  // localStorage so a launched tool greets each person once, not once per
  // tab; sessionStorage fallback keeps private-mode users covered.
  try {
    if (set) localStorage.setItem('dsa-onboarding-shown', '1');
    else return localStorage.getItem('dsa-onboarding-shown');
  } catch (err) {
    if (set) sessionStorage.setItem('dsa-onboarding-shown', '1');
    else return sessionStorage.getItem('dsa-onboarding-shown');
  }
  return null;
}

export function initOnboarding() {
  if (onboardingSeen(false)) return;
  const overlay = document.getElementById('onboarding');
  const stepsEl = document.getElementById('onboarding-steps');
  const dotsEl = document.getElementById('onboarding-dots');
  let step = 0;

  function render() {
    const s = ONBOARDING_STEPS[step];
    stepsEl.innerHTML = `<div class="onboarding-step"><strong>${s.title}</strong><p>${s.body}</p></div>`;
    dotsEl.innerHTML = ONBOARDING_STEPS.map((_, i) => `<span${i === step ? ' class="active"' : ''}></span>`).join('');
    document.getElementById('onboarding-prev').disabled = step === 0;
    document.getElementById('onboarding-next').textContent = step === ONBOARDING_STEPS.length - 1 ? 'Start exploring' : 'Continue';
  }

  function dismiss() {
    overlay.hidden = true;
    onboardingSeen(true);
  }

  document.getElementById('onboarding-next').addEventListener('click', () => {
    if (step < ONBOARDING_STEPS.length - 1) { step++; render(); } else { dismiss(); }
  });
  document.getElementById('onboarding-prev').addEventListener('click', () => {
    if (step > 0) { step--; render(); }
  });
  document.getElementById('onboarding-skip').addEventListener('click', dismiss);

  render();
  overlay.hidden = false;
}

// --------------------------------------------------------------- About modal ---

export function initAboutModal() {
  const modal = document.getElementById('about-modal');
  document.getElementById('about-content').innerHTML = `
    <h2>Pocket Planetarium</h2>
    <p>A planetarium in your pocket: a browser-based sky atlas built with <a href="https://aladin.cds.unistra.fr/AladinLite/" target="_blank" rel="noopener">Aladin Lite v3</a>, streaming imagery and catalog data live from public astronomical archives. No accounts, no backend, no tracking.</p>
    <h3>Imagery &amp; sky rendering</h3>
    <ul>
      <li><strong>Aladin Lite</strong> &mdash; CDS, Observatoire de Strasbourg &amp; CNRS</li>
      <li>DSS2, SDSS9, 2MASS, AllWISE/unWISE, Pan-STARRS DR1, Fermi and radio HiPS surveys, distributed via the CDS HiPS service</li>
    </ul>
    <h3>Catalogs</h3>
    <ul>
      <li><strong>SIMBAD</strong> astronomical database &mdash; CDS, Strasbourg</li>
      <li><strong>VizieR</strong> catalog service &mdash; CDS, Strasbourg, including the Million Quasars (Milliquas) catalog</li>
      <li><strong>Gaia</strong> DR3 &mdash; ESA / Gaia Data Processing and Analysis Consortium</li>
      <li><strong>NASA Exoplanet Archive</strong> &mdash; NASA/IPAC, operated by Caltech</li>
      <li>Messier &amp; NGC/IC positions curated from standard published (SEDS/OpenNGC-derived) coordinates</li>
      <li>Constellation figures, names and IAU boundaries from the <strong>d3-celestial</strong> project (Olaf Frohn, BSD-3-Clause), based on Stellarium sky-culture data</li>
    </ul>
    <h3>Black holes &amp; gravitational waves</h3>
    <ul>
      <li>Stellar-mass black hole X-ray binaries curated from the <strong>BlackCAT</strong> catalog (Corral-Santana et al. 2016) and subsequent literature</li>
      <li>Sgr A* and M87* parameters from the <strong>Event Horizon Telescope Collaboration</strong> and <strong>GRAVITY Collaboration</strong></li>
      <li>Gravitational-wave mergers from the <strong>LIGO/Virgo/KAGRA</strong> Gravitational-Wave Transient Catalog (GWTC)</li>
    </ul>
    <h3>Name resolution</h3>
    <p>Object search uses the CDS <strong>Sesame</strong> name resolver, querying SIMBAD, NED and VizieR.</p>
    <h3>Photographs &amp; artist impressions</h3>
    <p>Object photographs are real mission and observatory images — NASA/JPL-Caltech, NASA/ESA Hubble, ESO, ALMA, MESSENGER, Cassini, Voyager, New Horizons, and the Event Horizon Telescope Collaboration — served via <strong>Wikimedia Commons</strong> and credited individually beneath each image. Famous exoplanets use official NASA/ESO artist impressions.</p>
    <h3>Procedural renders</h3>
    <p>Objects without real imagery fall back to <strong>procedural illustrations</strong> generated in-browser from published parameters (planet class, stellar temperature, accretion physics) — never passed off as observations, and labeled as such.</p>
    <h3>Privacy</h3>
    <p><strong>No tracking, ever.</strong> No analytics, no cookies, no accounts. Preferences (layers, night-vision mode) live only in your browser's local storage. The Sky&nbsp;Now feature reads your location and motion sensors on this device solely to compute and track what's overhead — nothing is ever transmitted anywhere.</p>
    <h3>Open source</h3>
    <p>MIT-licensed. Source, bug reports and suggestions: <a href="https://github.com/AlexJCurry42/Proj1" target="_blank" rel="noopener">github.com/AlexJCurry42/Proj1</a>. Curated data last reviewed July 2026.</p>
    <p class="hint">Every dataset should be cited per its provider's own guidelines in any derived publication. This tool is for exploration and education, not a substitute for primary catalogs. Planet/Moon positions are geocentric and approximate (±arcminutes; Moon up to ~1° due to parallax).</p>
  `;
  let aboutReturnFocus = null;
  const open = () => {
    aboutReturnFocus = document.activeElement;
    modal.hidden = false;
    document.getElementById('about-close').focus();
  };
  document.getElementById('about-toggle').addEventListener('click', open);
  document.getElementById('brand-btn')?.addEventListener('click', open);
  const close = () => {
    modal.hidden = true;
    aboutReturnFocus?.focus?.({ preventScroll: true });
  };
  document.getElementById('about-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  trapFocus(document.getElementById('about-card'));
}

// ---------------------------------------------------------- Red-light mode ---

export function initRedlightToggle() {
  const btn = document.getElementById('redlight-toggle');
  const apply = (active) => {
    document.body.classList.toggle('redlight', active);
    btn.setAttribute('aria-pressed', String(active));
  };
  try { apply(localStorage.getItem('dsa-redlight') === '1'); } catch (err) { /* private mode */ }
  btn.addEventListener('click', () => {
    const active = !document.body.classList.contains('redlight');
    apply(active);
    try { localStorage.setItem('dsa-redlight', active ? '1' : '0'); } catch (err) { /* private mode */ }
  });
}

// --------------------------------------------------------------- Rail toggle ---

