// Deep Sky Atlas — application entry point: wires up the sky view, imagery
// layer manager, readouts, and every catalog/black-hole/planet/search module.
//
// Layer philosophy: the sky should feel calm on first load. Only lightweight,
// high-signal layers (Messier/NGC, Solar System, the black hole sets) are on
// by default; bulk/progressive layers (SIMBAD, Gaia, exoplanets, Milliquas
// quasars, GW mergers) are created lazily the first time they're switched on.

import {
  showToast, renderDetailPanel, showDetailLoading, closeDetailPanel,
  fetchSimbadNear, humanObjectType, toSexagesimalRA, toSexagesimalDec,
  initTours, initOnboarding, initAboutModal, initRedlightToggle, initRailToggle,
  initDetailPanelClose
} from './ui.js';
import { runSearch, getHistory } from './search.js';
import { initSimbadHips, initGaiaHips, loadMessierNgc, loadExoplanets } from './catalogs.js';
import { loadStellarBlackHoles, loadFlagshipSupermassive, initMilliquasLayer, loadGwMergers } from './blackholes.js';
import { computePlanetPositions, PLANET_LABELS } from './planets.js';

const SGR_A_STAR = { ra: 266.41683, dec: -29.007811 };

const BASE_SURVEYS = [
  { id: 'P/DSS2/color', label: 'DSS2 color (optical)' },
  { id: 'P/PanSTARRS/DR1/color-z-zg-g', label: 'Pan-STARRS DR1 (deepest optical)' },
  { id: 'P/SDSS9/color', label: 'SDSS9 (optical)' },
  { id: 'P/2MASS/color', label: '2MASS (near-infrared)' },
  { id: 'P/allWISE/color', label: 'AllWISE (mid-infrared)' },
  { id: 'P/Fermi/color', label: 'Fermi (gamma-ray)' },
  { id: 'P/NVSS', label: 'NVSS (radio)' }
];

const ALLWISE_HINT = 'Mid-infrared: dusty star-forming regions and AGN/quasar accretion glow show up strongly here.';

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

let toggleSeq = 0;
function addToggle(listEl, { label, color, checked = true, onToggle }) {
  const id = `tgl-${++toggleSeq}`;
  const li = document.createElement('li');
  li.innerHTML =
    `<span class="legend-dot" style="background:${color};color:${color}"></span>` +
    `<label class="toggle-label" for="${id}">${label}<span class="toggle-count"></span></label>` +
    `<input type="checkbox" role="switch" id="${id}" ${checked ? 'checked' : ''}/>`;
  listEl.appendChild(li);
  li.querySelector('input').addEventListener('change', (e) => onToggle(e.target.checked));
  return { setCount: (n) => { li.querySelector('.toggle-count').textContent = n; } };
}

function setCatalogVisible(catalog, visible) {
  if (!catalog) return;
  try {
    if (visible && typeof catalog.show === 'function') catalog.show();
    else if (!visible && typeof catalog.hide === 'function') catalog.hide();
  } catch (err) { /* best-effort; visibility toggling is not essential to correctness */ }
}

function setBaseSurvey(aladin, id) {
  try {
    if (typeof aladin.setBaseImageLayer === 'function') { aladin.setBaseImageLayer(id); return; }
  } catch (err) { /* fall through to legacy API */ }
  try {
    if (typeof aladin.setImageSurvey === 'function') { aladin.setImageSurvey(id); return; }
  } catch (err) {
    showToast(`Could not switch imagery to ${id}.`, 'error');
  }
}

let overlayLayer = null;
function setOverlaySurvey(aladin, id) {
  overlayLayer = null;
  if (!id) return;
  try {
    if (typeof aladin.setOverlayImageLayer === 'function') {
      overlayLayer = aladin.setOverlayImageLayer(id, 'dsa-overlay');
    }
  } catch (err) {
    showToast('Overlay blending is unavailable in this Aladin Lite build; base-layer switching still works.', 'info');
  }
}

function updateSurveyHint(baseId, overlayId) {
  const hint = document.getElementById('overlay-note');
  if (baseId === 'P/allWISE/color' || overlayId === 'P/allWISE/color') {
    hint.textContent = ALLWISE_HINT;
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
}

async function main() {
  // Aladin-independent chrome first, so a sky-engine failure still leaves a
  // working shell (rail, about modal, red-light mode, onboarding).
  initRailToggle();
  initRedlightToggle();
  initAboutModal();
  initDetailPanelClose();
  initOnboarding();

  // Phones start with the layers sheet tucked away so the sky is unobstructed.
  if (window.matchMedia('(max-width: 640px)').matches) {
    document.getElementById('left-rail').classList.add('collapsed');
    document.getElementById('rail-toggle').setAttribute('aria-expanded', 'false');
  }

  const baseSelect = document.getElementById('base-layer-select');
  const overlaySelect = document.getElementById('overlay-layer-select');
  for (const s of BASE_SURVEYS) {
    baseSelect.appendChild(new Option(s.label, s.id));
    overlaySelect.appendChild(new Option(s.label, s.id));
  }
  baseSelect.value = BASE_SURVEYS[0].id;

  // ----------------------------------------------------------- Sky engine ---
  if (typeof window.A === 'undefined') {
    throw new Error('the Aladin Lite script never loaded from aladin.cds.unistra.fr — a content blocker, DNS filter, or captive network is the usual cause.');
  }
  // A.init resolves once Aladin's WASM core is downloaded and compiled. It can
  // stall silently (e.g. Safari Lockdown Mode disables WebAssembly), so race
  // it against a timeout rather than awaiting it unconditionally.
  await Promise.race([
    A.init,
    new Promise((_, reject) => setTimeout(() =>
      reject(new Error('the Aladin Lite engine stalled during startup (20 s timeout). Anything that blocks WebAssembly or WebGL — such as Safari Lockdown Mode — causes this.')), 20000))
  ]);

  const aladin = A.aladin('#aladin-lite-div', {
    survey: BASE_SURVEYS[0].id,
    fov: 180,
    projection: 'SIN',
    showFullscreenControl: false,
    showCooGridControl: false,
    showLayersControl: false,
    showGotoControl: false,
    showZoomControl: false,
    showFrame: false,
    cooFrame: 'ICRS'
  });
  aladin.gotoRaDec(SGR_A_STAR.ra, SGR_A_STAR.dec);

  // ---------------------------------------------------------- Imagery UI ---
  baseSelect.addEventListener('change', () => {
    setBaseSurvey(aladin, baseSelect.value);
    updateSurveyHint(baseSelect.value, overlaySelect.value);
  });
  overlaySelect.addEventListener('change', () => {
    setOverlaySurvey(aladin, overlaySelect.value);
    const opacity = document.getElementById('overlay-opacity');
    if (overlayLayer && typeof overlayLayer.setOpacity === 'function') {
      overlayLayer.setOpacity(Number(opacity.value) / 100);
    }
    updateSurveyHint(baseSelect.value, overlaySelect.value);
  });
  document.getElementById('overlay-opacity').addEventListener('input', (e) => {
    const alpha = Number(e.target.value) / 100;
    try {
      if (overlayLayer?.setOpacity) overlayLayer.setOpacity(alpha);
      else if (overlayLayer?.setAlpha) overlayLayer.setAlpha(alpha);
    } catch (err) { /* non-critical visual feature */ }
  });

  initTours(aladin);

  // ------------------------------------------------------------ Readouts ---
  const skyDiv = document.getElementById('aladin-lite-div');
  const updateCoordReadout = debounce((x, y) => {
    try {
      const [ra, dec] = aladin.pix2world(x, y);
      if (ra == null) return;
      document.getElementById('coord-readout').textContent = `${toSexagesimalRA(ra)} ${toSexagesimalDec(dec)}`;
    } catch (err) { /* cursor left the sky area, e.g. off the sphere */ }
  }, 250);
  skyDiv.addEventListener('mousemove', (e) => {
    const rect = skyDiv.getBoundingClientRect();
    updateCoordReadout(e.clientX - rect.left, e.clientY - rect.top);
  });

  const updateFovReadout = debounce(() => {
    try {
      const fov = aladin.getFov();
      document.getElementById('fov-readout').textContent = `FoV ${fov[0].toFixed(2)}°`;
    } catch (err) { /* ignore transient state during animation */ }
  }, 250);
  aladin.on('zoomChanged', updateFovReadout);
  updateFovReadout();

  function tickClock() {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    document.getElementById('clock-readout').textContent = `${hh}:${mm} UTC`;
  }
  setInterval(tickClock, 15000);
  tickClock();

  // -------------------------------------------------------------- Search ---
  const searchForm = document.getElementById('search-form');
  const searchInput = document.getElementById('search-input');
  const historyList = document.getElementById('search-history');

  function renderHistory() {
    const items = getHistory();
    historyList.innerHTML = items.map(h =>
      `<li data-ra="${h.ra}" data-dec="${h.dec}">${h.label}<div class="item-sub">${h.query}</div></li>`
    ).join('');
  }
  searchInput.addEventListener('focus', () => {
    renderHistory();
    historyList.hidden = getHistory().length === 0;
  });
  searchInput.addEventListener('blur', () => setTimeout(() => { historyList.hidden = true; }, 150));
  historyList.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li || li.dataset.ra === 'null') return;
    searchInput.value = li.textContent.trim();
    historyList.hidden = true;
  });
  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = await runSearch(aladin, searchInput.value);
    renderHistory();
    searchInput.blur();
    // A resolved named object opens its detail card (with 3-D render if famous).
    if (result && result.name) {
      const typeLabel = result.otype ? await humanObjectType(result.otype) : 'Astronomical object';
      renderDetailPanel({
        name: result.name,
        aliases: result.aliases,
        typeLabel,
        ra: result.ra,
        dec: result.dec,
        source: 'CDS Sesame name resolver (SIMBAD/NED/VizieR)'
      });
    }
  });

  // ----------------------------------------------------- Object detail UX ---
  aladin.on('objectClicked', async (object) => {
    if (!object) { closeDetailPanel(); return; }
    const data = object.data || {};
    if (data._detail) {
      renderDetailPanel(data._detail);
      return;
    }
    // Anything without pre-built detail is a raw progressive-catalog hit
    // (SIMBAD or Gaia HiPS) — resolve it on demand via SIMBAD TAP.
    showDetailLoading();
    try {
      const ra = object.ra ?? object.data?.ra;
      const dec = object.dec ?? object.data?.dec;
      const rec = await fetchSimbadNear(ra, dec);
      const typeLabel = await humanObjectType(rec.otype);
      renderDetailPanel({
        name: rec.name,
        typeLabel,
        ra: rec.ra,
        dec: rec.dec,
        mag: rec.mag,
        distanceText: rec.distancePc ? `${rec.distancePc.toFixed(1)} pc (from parallax)` : null,
        source: 'SIMBAD (CDS Strasbourg), via SIMBAD TAP cone search'
      });
    } catch (err) {
      showToast(`Could not resolve object details: ${err.message}`, 'error');
      closeDetailPanel();
    }
  });

  // ------------------------------------------------ Catalog layers (rail) ---
  const catalogList = document.getElementById('catalog-toggle-list');
  const bhList = document.getElementById('blackhole-toggle-list');

  // On by default: small, curated, high-signal.
  const messierRef = {};
  const messierToggle = addToggle(catalogList, {
    label: 'Messier & bright NGC/IC', color: '#ffd60a', checked: true,
    onToggle: v => setCatalogVisible(messierRef.catalog, v)
  });
  loadMessierNgc(aladin).then(({ catalog, count }) => { messierRef.catalog = catalog; messierToggle.setCount(count); });

  const planetsRef = {};
  const planetsToggle = addToggle(catalogList, {
    label: 'Solar System', color: '#7fd6ff', checked: true,
    onToggle: v => setCatalogVisible(planetsRef.catalog, v)
  });
  initPlanetsLayer(aladin).then(({ catalog, count }) => { planetsRef.catalog = catalog; planetsToggle.setCount(count); });

  // Off by default, created lazily on first enable: heavy/bulk layers.
  let simbadCat = null;
  addToggle(catalogList, {
    label: 'SIMBAD database', color: '#0a84ff', checked: false,
    onToggle: (v) => {
      if (v && !simbadCat) simbadCat = initSimbadHips(aladin);
      else setCatalogVisible(simbadCat, v);
    }
  });

  let gaiaCat = null;
  addToggle(catalogList, {
    label: 'Gaia DR3 stars', color: '#ffffff', checked: false,
    onToggle: (v) => {
      if (v && !gaiaCat) gaiaCat = initGaiaHips(aladin);
      else setCatalogVisible(gaiaCat, v);
    }
  });

  const exoRef = { loading: false };
  const exoToggle = addToggle(catalogList, {
    label: 'Exoplanets', color: '#30d158', checked: false,
    onToggle: async (v) => {
      if (v && !exoRef.catalog && !exoRef.loading) {
        exoRef.loading = true;
        const { catalog, count } = await loadExoplanets(aladin);
        exoRef.catalog = catalog;
        exoRef.loading = false;
        if (count > 0) exoToggle.setCount(count.toLocaleString());
      } else {
        setCatalogVisible(exoRef.catalog, v);
      }
    }
  });

  // ----------------------------------------------------------- Black holes ---
  const stellarRef = {};
  const stellarToggle = addToggle(bhList, {
    label: 'Stellar-mass black holes', color: '#ff9f0a', checked: true,
    onToggle: v => setCatalogVisible(stellarRef.catalog, v)
  });
  loadStellarBlackHoles(aladin).then(({ catalog, count }) => { stellarRef.catalog = catalog; stellarToggle.setCount(count); });

  const flagshipRef = {};
  const flagshipToggle = addToggle(bhList, {
    label: 'EHT-imaged supermassive', color: '#ffd60a', checked: true,
    onToggle: v => setCatalogVisible(flagshipRef.catalog, v)
  });
  loadFlagshipSupermassive(aladin).then(({ catalog, count }) => { flagshipRef.catalog = catalog; flagshipToggle.setCount(count); });

  let milliquasCat = null;
  addToggle(bhList, {
    label: 'AGN & quasars (Milliquas)', color: '#ff453a', checked: false,
    onToggle: (v) => {
      if (v && !milliquasCat) milliquasCat = initMilliquasLayer(aladin);
      else setCatalogVisible(milliquasCat, v);
    }
  });

  const gwRef = { loading: false };
  const gwToggle = addToggle(bhList, {
    label: 'Gravitational-wave mergers', color: '#bf5af2', checked: false,
    onToggle: async (v) => {
      if (v && !gwRef.catalog && !gwRef.loading) {
        gwRef.loading = true;
        const { catalog, count } = await loadGwMergers(aladin);
        gwRef.catalog = catalog;
        gwRef.loading = false;
        if (count > 0) gwToggle.setCount(count);
      } else {
        setCatalogVisible(gwRef.catalog, v);
      }
    }
  });

  window.addEventListener('error', (e) => {
    console.error('Unhandled error:', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled promise rejection:', e.reason);
  });
}

async function initPlanetsLayer(aladin) {
  const cat = A.catalog({ name: 'Solar System', shape: 'circle', color: '#7fd6ff', sourceSize: 14, onClick: null });

  function build() {
    if (typeof cat.removeAll === 'function') cat.removeAll();
    const positions = computePlanetPositions(new Date());
    const sources = positions.map(p => A.source(p.ra, p.dec, {
      _detail: {
        name: PLANET_LABELS[p.body],
        typeLabel: 'Solar System planet',
        ra: p.ra,
        dec: p.dec,
        distanceText: `${p.distanceAu.toFixed(3)} AU from Earth (today)`,
        extraRows: [['Position computed', new Date().toUTCString()]],
        approxNote: 'Computed client-side from truncated Keplerian orbital elements (JPL/Meeus low-precision formulae), accurate to a few arcminutes for 1800-2050.',
        source: 'Self-contained ephemeris (see js/planets.js); orbital elements from JPL "Keplerian Elements for Approximate Positions of the Major Planets".'
      }
    }, { shape: 'circle', color: '#7fd6ff' }));
    cat.addSources(sources);
    return sources.length;
  }

  const count = build();
  aladin.addCatalog(cat);
  setInterval(build, 10 * 60 * 1000); // refresh every 10 minutes to reflect real orbital motion
  return { catalog: cat, count };
}

// On-page debug console for devices without dev tools (phones): append
// ?debug=1 to the URL and every console error / unhandled rejection is
// mirrored into a scrollable pane you can screenshot.
function initDebugConsole() {
  if (!new URLSearchParams(location.search).has('debug')) return;
  const pane = document.createElement('div');
  pane.id = 'debug-pane';
  document.body.appendChild(pane);
  const log = (kind, msg) => {
    const line = document.createElement('div');
    line.textContent = `[${kind}] ${msg}`;
    pane.appendChild(line);
    pane.scrollTop = pane.scrollHeight;
  };
  for (const kind of ['error', 'warn']) {
    const orig = console[kind].bind(console);
    console[kind] = (...args) => { orig(...args); log(kind, args.map(a => a instanceof Error ? `${a.message}\n${a.stack}` : String(a)).join(' ')); };
  }
  window.addEventListener('error', e => log('error', e.message + (e.filename ? ` @ ${e.filename}:${e.lineno}` : '')));
  window.addEventListener('unhandledrejection', e => log('rejection', String(e.reason?.message || e.reason)));
  log('info', `debug console active — aladin.js ${typeof window.A === 'undefined' ? 'NOT LOADED' : 'loaded'}, UA: ${navigator.userAgent}`);
  window.__dsaDebugLog = log;
}

// Persistent (non-toast) failure banner: if the sky engine can't start there
// is no app to speak of, so the user must see why, not a 15-second toast.
function showFatalError(message) {
  console.error('Deep Sky Atlas failed to start:', message);
  document.getElementById('fatal-banner')?.remove();
  const banner = document.createElement('div');
  banner.id = 'fatal-banner';
  banner.setAttribute('role', 'alert');
  const h = document.createElement('h2');
  h.textContent = 'The sky engine failed to start';
  const p = document.createElement('p');
  p.textContent = `Reason: ${message}`;
  const tips = document.createElement('p');
  tips.textContent = 'Things to check: this device can reach aladin.cds.unistra.fr (content blockers and some school/work networks block it), Safari Lockdown Mode is off for this site, and you are online. Then reload.';
  const btn = document.createElement('button');
  btn.textContent = 'Reload';
  btn.className = 'btn-primary';
  btn.addEventListener('click', () => location.reload());
  banner.append(h, p, tips, btn);
  document.body.appendChild(banner);
}

initDebugConsole();
main().catch(err => {
  showFatalError(err.message);
});
