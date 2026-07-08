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
  setTimeout(() => el.remove(), timeoutMs);
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
export async function fetchSimbadNear(ra, dec, radiusDeg = 0.01) {
  const key = `${ra.toFixed(4)},${dec.toFixed(4)}`;
  if (simbadCache.has(key)) return simbadCache.get(key);

  const query = `SELECT TOP 1 basic.main_id, basic.otype, basic.ra, basic.dec, basic.plx_value, ` +
    `flux.flux AS v_mag FROM basic LEFT JOIN flux ON flux.oidref = basic.oid AND flux.filter = 'V' ` +
    `WHERE CONTAINS(POINT('ICRS', basic.ra, basic.dec), CIRCLE('ICRS', ${ra}, ${dec}, ${radiusDeg})) = 1 ` +
    `ORDER BY DISTANCE(POINT('ICRS', basic.ra, basic.dec), POINT('ICRS', ${ra}, ${dec})) ASC`;

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
    mag: get('v_mag') ?? null
  };
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

export function showDetailLoading() {
  detailPanel().hidden = false;
  detailContent().innerHTML = `<p id="detail-loading">Loading object details…</p>`;
}

/**
 * Render the object detail panel.
 * obj: { name, aliases, typeLabel, ra, dec, mag, distanceText, badges, extraRows, source, approxNote }
 */
export function renderDetailPanel(obj) {
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
}

function row(label, value) {
  return `<div class="drow"><span>${escapeHtml(label)}</span><span>${escapeHtml(String(value))}</span></div>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function initDetailPanelClose() {
  document.getElementById('detail-close').addEventListener('click', closeDetailPanel);
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
  select.addEventListener('change', () => {
    const t = tours.find(x => x.id === select.value);
    if (!t) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || typeof aladin.animateToRaDec !== 'function') {
      aladin.gotoRaDec(t.ra, t.dec);
      aladin.setFoV(t.fov_deg);
    } else {
      aladin.animateToRaDec(t.ra, t.dec, 1.5);
      setTimeout(() => aladin.setFoV(t.fov_deg), 1500);
    }
    showToast(t.caption, 'info', 9000);
    select.value = '';
  });
}

// --------------------------------------------------------------- Onboarding ---

const ONBOARDING_STEPS = [
  { title: 'Explore the sky', body: 'Drag to pan, pinch to zoom. This is the real sky — more detail and more objects reveal themselves the deeper you go.' },
  { title: 'Tap anything', body: 'Every glowing marker opens a story: black holes, nebulae, planets. Famous objects come with an animated 3-D render.' },
  { title: 'Search the universe', body: 'Try "Cygnus X-1" or "Orion Nebula" — or pick a Tour for a guided flight to the sky’s greatest hits.' }
];

export function initOnboarding() {
  if (sessionStorage.getItem('dsa-onboarding-shown')) return;
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
    sessionStorage.setItem('dsa-onboarding-shown', '1');
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
    <h2>About &amp; Credits</h2>
    <p>Deep Sky Atlas is a browser-based sky atlas built with <a href="https://aladin.cds.unistra.fr/AladinLite/" target="_blank" rel="noopener">Aladin Lite v3</a>, streaming imagery and catalog data live from public astronomical archives. No accounts, no backend, no tracking.</p>
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
    </ul>
    <h3>Black holes &amp; gravitational waves</h3>
    <ul>
      <li>Stellar-mass black hole X-ray binaries curated from the <strong>BlackCAT</strong> catalog (Corral-Santana et al. 2016) and subsequent literature</li>
      <li>Sgr A* and M87* parameters from the <strong>Event Horizon Telescope Collaboration</strong> and <strong>GRAVITY Collaboration</strong></li>
      <li>Gravitational-wave mergers from the <strong>LIGO/Virgo/KAGRA</strong> Gravitational-Wave Transient Catalog (GWTC)</li>
    </ul>
    <h3>Name resolution</h3>
    <p>Object search uses the CDS <strong>Sesame</strong> name resolver, querying SIMBAD, NED and VizieR.</p>
    <h3>3-D renders</h3>
    <p>Renders of planets, stars and black holes are <strong>procedural illustrations</strong> generated in-browser from published parameters (planet class, stellar temperature, accretion physics) — they are not observed images, and each one is labeled as such.</p>
    <p class="hint">Every dataset should be cited per its provider's own guidelines in any derived publication. This tool is for exploration and education, not a substitute for primary catalogs.</p>
  `;
  document.getElementById('about-toggle').addEventListener('click', () => { modal.hidden = false; });
  document.getElementById('about-close').addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
}

// ---------------------------------------------------------- Red-light mode ---

export function initRedlightToggle() {
  const btn = document.getElementById('redlight-toggle');
  btn.addEventListener('click', () => {
    const active = document.body.classList.toggle('redlight');
    btn.setAttribute('aria-pressed', String(active));
  });
}

// --------------------------------------------------------------- Rail toggle ---

export function initRailToggle() {
  const btn = document.getElementById('rail-toggle');
  const rail = document.getElementById('left-rail');
  btn.addEventListener('click', () => {
    const collapsed = rail.classList.toggle('collapsed');
    btn.setAttribute('aria-expanded', String(!collapsed));
  });
}
