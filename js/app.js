// Deep Sky Atlas — application entry point: wires up the sky view, imagery
// layer manager, readouts, and every catalog/black-hole/planet/search module.
//
// Layer philosophy: the sky should feel calm on first load. Only lightweight,
// high-signal layers (constellations, Messier/NGC, Solar System, the black
// hole sets) are on by default; bulk/progressive layers (SIMBAD, Gaia,
// exoplanets, Milliquas quasars, GW mergers) are created lazily the first
// time they're switched on. Layer choices persist in localStorage.

import {
  showToast, renderDetailPanel, showDetailLoading, closeDetailPanel,
  fetchSimbadNear, humanObjectType, toSexagesimalRA, toSexagesimalDec,
  initTours, initOnboarding, initAboutModal, initRedlightToggle,
  initDetailPanelClose, initKeyboard
} from './ui.js';
import { runSearch, getHistory, addToHistory, flyTo } from './search.js';
import { initSimbadHips, initGaiaHips, initGalaxiesLayer, initSimbadBlackHolesLayer, loadMessierNgc, loadExoplanets } from './catalogs.js';
import { loadStellarBlackHoles, loadFlagshipSupermassive, initMilliquasLayer, loadGwMergers } from './blackholes.js';
import { computePlanetPositions, computeSunPosition, computeMoonPosition, PLANET_LABELS } from './planets.js';
import { makePlanetIcon, makeGlowDot } from './markers.js';
import { initWarpEffect } from './warp.js';
import { loadConstellations, loadConstellationBorders } from './constellations.js';
import { querySuggestions, suggestionCoords } from './suggest.js';
import { initSkyNow } from './skynow.js';
import { SURVEYS, STOP, MAX_VALUE, DEFAULT_VALUE, initSpectrumBar } from './spectrum.js';

const SGR_A_STAR = { ra: 266.41683, dec: -29.007811 };

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ------------------------------------------------- Preferences (local) ---
function readPref(key, fallback) {
  try {
    const v = localStorage.getItem('dsa-' + key);
    return v == null ? fallback : JSON.parse(v);
  } catch (err) { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem('dsa-' + key, JSON.stringify(value)); } catch (err) { /* private mode */ }
}
const savedLayers = readPref('layers', {});

let toggleSeq = 0;
function addToggle(listEl, { label, color, checked = true, sub = false, onToggle }) {
  const saved = Object.prototype.hasOwnProperty.call(savedLayers, label) ? savedLayers[label] : undefined;
  const initial = saved ?? checked;
  const id = `tgl-${++toggleSeq}`;
  const li = document.createElement('li');
  if (sub) li.className = 'toggle-sub';
  li.innerHTML =
    `<span class="legend-dot" style="background:${color};color:${color}"></span>` +
    `<label class="toggle-label" for="${id}"><span class="toggle-text">${label}</span><span class="toggle-count"></span></label>` +
    `<input type="checkbox" ${sub ? 'class="sub"' : 'role="switch"'} id="${id}" ${initial ? 'checked' : ''}/>`;
  listEl.appendChild(li);
  const input = li.querySelector('input');
  input.addEventListener('change', () => {
    savedLayers[label] = input.checked;
    writePref('layers', savedLayers);
    onToggle(input.checked);
  });
  // A lazily-created layer the user had enabled last visit must initialize now.
  if (initial && !checked) queueMicrotask(() => onToggle(true));
  return {
    setCount: (n) => { li.querySelector('.toggle-count').textContent = n; },
    isChecked: () => input.checked,
    setDisabled: (d) => { input.disabled = d; li.classList.toggle('disabled', d); }
  };
}

// The layer dock folds the same way the spectrum rail does: one chevron,
// one sprung animation down to a lone pill. State persists across visits.
function initDockCollapse() {
  const dock = document.getElementById('layer-dock');
  const btn = document.getElementById('dock-collapse');
  if (!dock || !btn) return; // stale HTML mid-deploy: skip, never crash boot
  function setCollapsed(c) {
    dock.classList.toggle('collapsed', c);
    btn.setAttribute('aria-expanded', String(!c));
    btn.setAttribute('aria-label', c ? 'Expand the layers menu' : 'Collapse the layers menu');
    writePref('dockcollapsed', c);
  }
  btn.addEventListener('click', () => setCollapsed(!dock.classList.contains('collapsed')));
  if (readPref('dockcollapsed', false) === true) {
    dock.classList.add('collapsed');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Expand the layers menu');
  }
}

function setCatalogVisible(catalogOrList, visible) {
  if (!catalogOrList) return;
  const list = Array.isArray(catalogOrList) ? catalogOrList : [catalogOrList];
  for (const catalog of list) {
    if (!catalog) continue;
    try {
      if (visible && typeof catalog.show === 'function') catalog.show();
      else if (!visible && typeof catalog.hide === 'function') catalog.hide();
    } catch (err) { /* best-effort; visibility toggling is not essential to correctness */ }
  }
}

// -------------------------------------------------- Shareable view URLs ---
function parseViewHash() {
  try {
    const p = new URLSearchParams(location.hash.slice(1));
    const ra = parseFloat(p.get('ra'));
    const dec = parseFloat(p.get('dec'));
    const fov = parseFloat(p.get('fov'));
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;
    return {
      ra: ((ra % 360) + 360) % 360,
      dec: Math.min(90, Math.max(-90, dec)),
      fov: Number.isFinite(fov) ? Math.min(320, Math.max(0.02, fov)) : null,
      survey: p.get('survey'),
      view: p.get('view') === 'inside' ? 'inside' : null
    };
  } catch (err) { return null; }
}

async function main() {
  // Aladin-independent chrome first, so a sky-engine failure still leaves a
  // working shell (dock, about modal, red-light mode, onboarding). Each piece
  // is fault-isolated: right after a deploy the HTTP cache can briefly pair a
  // stale index.html with fresh JS, and a missing element in one widget must
  // cost that widget, not the sky.
  for (const initChrome of [initRedlightToggle, initAboutModal, initDetailPanelClose,
                            initKeyboard, initOnboarding, initDockCollapse]) {
    try { initChrome(); } catch (err) { console.error('chrome init failed:', err); }
  }

  // Spectrum position priority: shared link > saved position > legacy survey
  // preference > default (DSS2 optical).
  const linkedView = parseViewHash();
  const linkedIdx = SURVEYS.findIndex(s => s.id === linkedView?.survey);
  const legacyIdx = SURVEYS.findIndex(s => s.id === readPref('survey', null));
  const prefSpectrum = readPref('spectrum', null);
  const initialSpectrum = linkedIdx >= 0 ? linkedIdx * STOP
    : (typeof prefSpectrum === 'number' ? Math.max(0, Math.min(MAX_VALUE, prefSpectrum))
      : (legacyIdx >= 0 ? legacyIdx * STOP : DEFAULT_VALUE));
  const startSurvey = SURVEYS[Math.round(initialSpectrum / STOP)].id;

  // View mode: 'globe' looks AT the celestial sphere (orthographic, ≤180°);
  // 'inside' stands WITHIN it (stereographic — the planetarium projection,
  // where the sky wraps around you and the view can open past 180°).
  let viewMode = linkedView?.view || readPref('viewmode', 'globe');
  const projectionFor = (mode) => mode === 'inside' ? 'STG' : 'SIN';
  const maxFovFor = (mode) => mode === 'inside' ? 300 : 180;

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
    survey: startSurvey,
    fov: viewMode === 'inside' ? 240 : 180,
    projection: projectionFor(viewMode),
    showFullscreenControl: false,
    showCooGridControl: false,
    showLayersControl: false,
    showGotoControl: false,
    showZoomControl: false,
    showFrame: false,
    cooFrame: 'ICRS',
    // Pure black around the celestial sphere — the sky should feel infinite,
    // not like a globe floating on a gray card.
    backgroundColor: '#000000'
  });
  try { aladin.setBackgroundColor?.('#000000'); } catch (err) { /* option above covers newer builds */ }

  if (linkedView) {
    aladin.gotoRaDec(linkedView.ra, linkedView.dec);
    if (linkedView.fov) aladin.setFoV(linkedView.fov);
  } else {
    aladin.gotoRaDec(SGR_A_STAR.ra, SGR_A_STAR.dec);
  }

  // Aladin Lite stores a single callback per event name, so if each module
  // called aladin.on('zoomChanged', …) they would silently overwrite one
  // another. One dispatcher owns each event and fans it out.
  const zoomSubs = new Set();
  const positionSubs = new Set();
  aladin.on('zoomChanged', (...args) => { for (const fn of zoomSubs) fn(...args); });
  aladin.on('positionChanged', (...args) => { for (const fn of positionSubs) fn(...args); });
  const onZoom = (fn) => zoomSubs.add(fn);
  const onPosition = (fn) => positionSubs.add(fn);

  initWarpEffect(aladin, onZoom);

  // One slider, the whole spectrum: settles persist position + permalink.
  const spectrum = initSpectrumBar(aladin, {
    onSettle: (v) => { writePref('spectrum', v); updateHash(); },
    collapsed: readPref('spectrumcollapsed', false) === true,
    onCollapse: (c) => writePref('spectrumcollapsed', c)
  });
  spectrum.setValue(initialSpectrum);

  // Keep the URL hash in sync with the view (debounced, replaceState so the
  // back button isn't spammed) — every view is a shareable permalink.
  function currentViewUrl() {
    try {
      const [ra, dec] = aladin.getRaDec();
      const fov = aladin.getFov()[0];
      const view = viewMode === 'inside' ? '&view=inside' : '';
      const hash = `#ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&fov=${fov.toFixed(3)}&survey=${encodeURIComponent(spectrum.nearestSurveyId())}${view}`;
      return location.origin + location.pathname + hash;
    } catch (err) { return location.href; }
  }
  const updateHash = debounce(() => history.replaceState(null, '', currentViewUrl()), 400);
  onZoom(updateHash);
  onPosition(updateHash);

  document.getElementById('share-btn').addEventListener('click', async () => {
    const url = currentViewUrl();
    history.replaceState(null, '', url);
    if (navigator.share) {
      try { await navigator.share({ title: 'Pocket Planetarium', url }); return; }
      catch (err) { if (err.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link to this view copied to clipboard.', 'info');
    } catch (err) {
      showToast(url, 'info', 12000);
    }
  });

  initTours(aladin);
  initSkyNow(aladin);

  // ------------------------------------------------------- View mode toggle ---
  const viewBtn = document.getElementById('view-toggle');
  function applyViewMode(mode, { announce = true } = {}) {
    viewMode = mode;
    try { aladin.setProjection(projectionFor(mode)); } catch (err) { /* engine hiccup */ }
    try {
      const fov = aladin.getFov()[0];
      if (mode === 'inside' && fov >= 150) aladin.setFoV(240); // reveal the wraparound
      if (mode === 'globe' && fov > 180) aladin.setFoV(180);   // globe caps at a hemisphere
    } catch (err) { /* keep current FoV */ }
    viewBtn.setAttribute('aria-pressed', String(mode === 'inside'));
    writePref('viewmode', mode);
    updateHash();
    if (announce) {
      showToast(mode === 'inside'
        ? 'Inside view: you are standing within the celestial sphere — the sky wraps around you. Zoom out past 180° to feel it.'
        : 'Globe view: the celestial sphere seen from outside.', 'info', 6000);
    }
  }
  viewBtn.setAttribute('aria-pressed', String(viewMode === 'inside'));
  viewBtn.addEventListener('click', () => applyViewMode(viewMode === 'inside' ? 'globe' : 'inside'));

  // Floating zoom controls (Aladin's own chrome is disabled for a clean sky).
  function zoomBy(factor) {
    try {
      const fov = aladin.getFov()[0];
      aladin.setFoV(Math.min(maxFovFor(viewMode), Math.max(0.02, fov * factor)));
    } catch (err) { /* engine mid-animation; ignore */ }
  }
  document.getElementById('zoom-in').addEventListener('click', () => zoomBy(0.5));
  document.getElementById('zoom-out').addEventListener('click', () => zoomBy(2));

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
  onZoom(updateFovReadout);
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
  const suggList = document.getElementById('search-suggestions');
  let currentSuggs = [];
  let activeIdx = -1;

  function renderHistory() {
    const items = getHistory();
    historyList.innerHTML = items.map((h, i) =>
      `<li data-idx="${i}">${h.label}<div class="item-sub">${h.query}</div></li>`
    ).join('');
  }
  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim().length >= 2) return;
    renderHistory();
    historyList.hidden = getHistory().length === 0;
  });
  searchInput.addEventListener('blur', () => setTimeout(() => {
    historyList.hidden = true;
    suggList.hidden = true;
  }, 150));
  historyList.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const h = getHistory()[Number(li.dataset.idx)];
    if (!h) return;
    searchInput.value = h.query;
    historyList.hidden = true;
    searchForm.requestSubmit(); // re-run the search, don't just fill the box
  });

  // Instant suggestions from the app's own curated objects (no network).
  const runSuggest = debounce(async () => {
    currentSuggs = await querySuggestions(searchInput.value);
    activeIdx = -1;
    if (!currentSuggs.length) { suggList.hidden = true; return; }
    historyList.hidden = true;
    suggList.innerHTML = currentSuggs.map((s, i) =>
      `<li data-i="${i}">${s.name}<div class="item-sub">${s.typeLabel}</div></li>`
    ).join('');
    suggList.hidden = false;
  }, 140);
  searchInput.addEventListener('input', () => {
    if (searchInput.value.trim().length >= 2) runSuggest();
    else { suggList.hidden = true; }
  });

  function pickSuggestion(s) {
    const c = suggestionCoords(s);
    if (!c) return;
    flyTo(aladin, c.ra, c.dec, s.fov ?? 0.8);
    addToHistory({ query: s.name, ra: c.ra, dec: c.dec, label: s.name });
    renderDetailPanel({ name: s.name, typeLabel: s.typeLabel, ra: c.ra, dec: c.dec });
    suggList.hidden = true;
    historyList.hidden = true;
    searchInput.value = s.name;
    searchInput.blur();
  }
  // mousedown, not click: it must beat the input's blur handler.
  suggList.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();
    pickSuggestion(currentSuggs[Number(li.dataset.i)]);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (suggList.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = currentSuggs.length;
      activeIdx = ((activeIdx + (e.key === 'ArrowDown' ? 1 : -1)) % n + n) % n;
      [...suggList.children].forEach((el, i) => el.classList.toggle('active', i === activeIdx));
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      pickSuggestion(currentSuggs[activeIdx]);
    }
  });

  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    suggList.hidden = true;
    const result = await runSearch(aladin, searchInput.value);
    renderHistory();
    searchInput.blur();
    // A resolved named object opens its detail card (with media if famous).
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
    // (SIMBAD or Gaia HiPS) — resolve it on demand via SIMBAD TAP. Different
    // catalog sources expose their position under different keys, so try the
    // common ones and validate before querying.
    showDetailLoading();
    try {
      const ra = [object.ra, data.ra, data.RA, data.RAJ2000, data.RA_ICRS].map(Number).find(Number.isFinite);
      const dec = [object.dec, data.dec, data.DE, data.DEJ2000, data.DE_ICRS].map(Number).find(Number.isFinite);
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

  // ------------------------------------------------ Layer dock (left) ---
  // One flat overlay menu, a switch per celestial family; heavyweight layers
  // still lazy-create on first enable.
  const catalogList = document.getElementById('layer-dock-list');
  const bhList = catalogList;

  // First-load default: ONLY the Solar System layer is on — the sky itself is
  // the star of the show. Everything else builds ready-to-go but starts
  // hidden; the user's own toggle choices persist and override from then on.
  const constRef = {};
  const bordersRef = { loading: false };

  // Boundaries live as a sub-checkbox of Constellations: visible only when
  // its parent is on, and following the parent off/on.
  function syncBorders() {
    const parentOn = constToggle.isChecked();
    bordersToggle.setDisabled(!parentOn);
    const show = parentOn && bordersToggle.isChecked();
    if (show && !bordersRef.catalogs && !bordersRef.loading) {
      bordersRef.loading = true;
      loadConstellationBorders(aladin).then(({ catalogs }) => {
        bordersRef.catalogs = catalogs;
        bordersRef.loading = false;
        setCatalogVisible(catalogs, constToggle.isChecked() && bordersToggle.isChecked());
      });
      return;
    }
    setCatalogVisible(bordersRef.catalogs, show);
  }
  const constToggle = addToggle(catalogList, {
    label: 'Constellations', color: '#7aa0ff', checked: false,
    onToggle: (v) => { setCatalogVisible(constRef.catalogs, v); syncBorders(); }
  });
  const bordersToggle = addToggle(catalogList, {
    label: 'Boundaries', color: '#39496b', checked: false, sub: true,
    onToggle: () => syncBorders()
  });
  loadConstellations(aladin).then(({ catalogs, count }) => {
    constRef.catalogs = catalogs;
    constToggle.setCount(count);
    setCatalogVisible(catalogs, constToggle.isChecked());
  });
  syncBorders();

  const messierRef = {};
  const messierToggle = addToggle(catalogList, {
    label: 'Messier & NGC', color: '#ffd60a', checked: false,
    onToggle: v => setCatalogVisible(messierRef.catalogs, v)
  });
  loadMessierNgc(aladin, onZoom).then(({ catalogs, count }) => {
    messierRef.catalogs = catalogs;
    messierToggle.setCount(count);
    setCatalogVisible(catalogs, messierToggle.isChecked());
  });

  const planetsRef = {};
  const planetsToggle = addToggle(catalogList, {
    label: 'Solar System', color: '#7fd6ff', checked: true,
    onToggle: v => setCatalogVisible(planetsRef.catalogs, v)
  });
  initPlanetsLayer(aladin).then(({ catalogs, count }) => {
    planetsRef.catalogs = catalogs;
    planetsToggle.setCount(count);
    setCatalogVisible(catalogs, planetsToggle.isChecked());
  });

  // Off by default, created lazily on first enable: heavy/bulk layers.
  let simbadCat = null;
  addToggle(catalogList, {
    label: 'SIMBAD sources', color: '#0a84ff', checked: false,
    onToggle: (v) => {
      if (v && !simbadCat) simbadCat = initSimbadHips(aladin);
      else setCatalogVisible(simbadCat, v);
    }
  });

  let gaiaCat = null;
  addToggle(catalogList, {
    label: 'Gaia stars', color: '#ffffff', checked: false,
    onToggle: (v) => {
      if (v && !gaiaCat) gaiaCat = initGaiaHips(aladin);
      else setCatalogVisible(gaiaCat, v);
    }
  });

  let galaxiesCat = null;
  addToggle(catalogList, {
    label: 'Galaxies', color: '#ffcc66', checked: false,
    onToggle: (v) => {
      if (v && !galaxiesCat) {
        galaxiesCat = initGalaxiesLayer(aladin, onZoom, onPosition);
      } else {
        galaxiesCat?.dsaSetEnabled?.(v); // stop/restart live SIMBAD queries
        setCatalogVisible(galaxiesCat, v);
      }
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
        setCatalogVisible(catalog, exoToggle.isChecked());
      } else {
        setCatalogVisible(exoRef.catalog, v);
      }
    }
  });

  // ----------------------------------------------------------- Black holes ---
  // Two sources under one switch: the curated stellar-mass list (rich
  // physics-driven renders, literature citations) plus a live SIMBAD layer
  // of everything catalogued as a (candidate) black hole, so the toggle
  // genuinely means "all known".
  const stellarRef = {};
  let simbadBhCat = null;
  const stellarToggle = addToggle(bhList, {
    label: 'Black holes', color: '#ff9f0a', checked: false,
    onToggle: (v) => {
      setCatalogVisible(stellarRef.catalog, v);
      if (v && !simbadBhCat) {
        simbadBhCat = initSimbadBlackHolesLayer(aladin, onZoom, onPosition);
      } else {
        simbadBhCat?.dsaSetEnabled?.(v); // stop/restart live SIMBAD queries
        setCatalogVisible(simbadBhCat, v);
      }
    }
  });
  loadStellarBlackHoles(aladin).then(({ catalog, count }) => {
    stellarRef.catalog = catalog;
    stellarToggle.setCount(count);
    setCatalogVisible(catalog, stellarToggle.isChecked());
  });

  const flagshipRef = {};
  const flagshipToggle = addToggle(bhList, {
    label: 'Supermassive', color: '#ffd60a', checked: false,
    onToggle: v => setCatalogVisible(flagshipRef.catalog, v)
  });
  loadFlagshipSupermassive(aladin).then(({ catalog, count }) => {
    flagshipRef.catalog = catalog;
    flagshipToggle.setCount(count);
    setCatalogVisible(catalog, flagshipToggle.isChecked());
  });

  let milliquasCat = null;
  addToggle(bhList, {
    label: 'AGN & quasars', color: '#ff453a', checked: false,
    onToggle: (v) => {
      if (v && !milliquasCat) {
        milliquasCat = initMilliquasLayer(aladin, onZoom, onPosition);
      } else {
        milliquasCat?.dsaSetEnabled?.(v); // stop/restart live VizieR queries
        setCatalogVisible(milliquasCat, v);
      }
    }
  });

  const gwRef = { loading: false };
  const gwToggle = addToggle(bhList, {
    label: 'GW mergers', color: '#bf5af2', checked: false,
    onToggle: async (v) => {
      if (v && !gwRef.catalog && !gwRef.loading) {
        gwRef.loading = true;
        const { catalog, count } = await loadGwMergers(aladin);
        gwRef.catalog = catalog;
        gwRef.loading = false;
        if (count > 0) gwToggle.setCount(count);
        setCatalogVisible(catalog, gwToggle.isChecked());
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

  // PWA: cache the app shell so revisits load instantly (sky data stays live).
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* shell caching is optional */ });
  }
}

async function initPlanetsLayer(aladin) {
  const catPlanets = A.catalog({
    name: 'Solar System planets',
    shape: makePlanetIcon('#7fd6ff', 18),
    sourceSize: 18,
    displayLabel: true,
    labelColumn: 'name',
    labelColor: 'rgba(220, 235, 255, 0.85)',
    labelFont: '11px -apple-system, sans-serif',
    onClick: null
  });
  const catSun = A.catalog({
    name: 'Sun',
    shape: makeGlowDot('#ffd60a', 28),
    sourceSize: 28,
    displayLabel: true,
    labelColumn: 'name',
    labelColor: 'rgba(255, 224, 130, 0.9)',
    labelFont: '11px -apple-system, sans-serif',
    onClick: null
  });
  const catMoon = A.catalog({
    name: 'Moon',
    shape: makePlanetIcon('#d9d9de', 18),
    sourceSize: 18,
    displayLabel: true,
    labelColumn: 'name',
    labelColor: 'rgba(225, 225, 235, 0.85)',
    labelFont: '11px -apple-system, sans-serif',
    onClick: null
  });

  const EPHEMERIS_NOTE = 'Computed client-side for the moment the app opened. Validated against a VSOP87-class ephemeris: typically within 1′ (Saturn up to ~9′), 1800–2050.';
  const EPHEMERIS_SOURCE = 'Self-contained ephemeris (see js/planets.js); JPL approximate elements / Astronomical Almanac low-precision formulae.';

  function build() {
    for (const c of [catPlanets, catSun, catMoon]) {
      if (typeof c.removeAll === 'function') c.removeAll();
    }
    const now = new Date();
    catPlanets.addSources(computePlanetPositions(now).map(p => A.source(p.ra, p.dec, {
      name: PLANET_LABELS[p.body],
      _detail: {
        name: PLANET_LABELS[p.body],
        typeLabel: 'Solar System planet',
        ra: p.ra,
        dec: p.dec,
        distanceText: `${p.distanceAu.toFixed(3)} AU from Earth (today)`,
        extraRows: [['Position computed', now.toUTCString()]],
        approxNote: EPHEMERIS_NOTE,
        source: EPHEMERIS_SOURCE
      }
    })));
    const sun = computeSunPosition(now);
    catSun.addSources([A.source(sun.ra, sun.dec, {
      name: 'Sun',
      _detail: {
        name: 'The Sun',
        typeLabel: 'G-type main-sequence star',
        ra: sun.ra,
        dec: sun.dec,
        distanceText: `${sun.distanceAu.toFixed(4)} AU from Earth (today)`,
        extraRows: [['Position computed', now.toUTCString()]],
        approxNote: EPHEMERIS_NOTE,
        source: EPHEMERIS_SOURCE
      }
    })]);
    const moon = computeMoonPosition(now);
    catMoon.addSources([A.source(moon.ra, moon.dec, {
      name: 'Moon',
      _detail: {
        name: 'The Moon',
        typeLabel: "Earth's natural satellite",
        ra: moon.ra,
        dec: moon.dec,
        distanceText: `${Math.round(moon.distanceKm).toLocaleString()} km from Earth's center (today)`,
        extraRows: [['Position computed', now.toUTCString()]],
        approxNote: 'Geocentric position from the Astronomical Almanac lunar formulae, computed when the app opened (validated: typically ~5′). From your location on Earth’s surface the Moon can appear up to ~1° away from this point (parallax).',
        source: EPHEMERIS_SOURCE
      }
    })]);
  }

  // Positions are computed once, for the moment the app launches — each
  // marker's detail panel records that timestamp. (The Moon moves ~0.5°/hour,
  // so a long-lived tab will drift; reloading recomputes.)
  build();
  for (const c of [catPlanets, catSun, catMoon]) aladin.addCatalog(c);
  return { catalogs: [catPlanets, catSun, catMoon], count: 11 };
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
  console.error('Pocket Planetarium failed to start:', message);
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
