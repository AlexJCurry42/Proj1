// Deep Sky Atlas — application entry point: wires up the sky view, imagery
// layer manager, readouts, and every catalog/black-hole/planet/search module.

import {
  showToast, renderDetailPanel, showDetailLoading, closeDetailPanel,
  fetchSimbadNear, humanObjectType, toSexagesimalRA, toSexagesimalDec,
  initTours, initOnboarding, initAboutModal, initRedlightToggle, initRailToggle,
  initDetailPanelClose
} from './ui.js';
import { runSearch, getHistory } from './search.js';
import { initSimbadHips, initGaiaHips, loadMessierNgc, loadExoplanets, TYPE_STYLE } from './catalogs.js';
import { loadStellarBlackHoles, loadFlagshipSupermassive, initMilliquasLayer, loadGwMergers } from './blackholes.js';
import { computePlanetPositions, PLANET_LABELS } from './planets.js';

const SGR_A_STAR = { ra: 266.41683, dec: -29.007811 };

const BASE_SURVEYS = [
  { id: 'P/DSS2/color', label: 'DSS2 color (optical)' },
  { id: 'P/PanSTARRS/DR1/color-z-zg-g', label: 'Pan-STARRS DR1 color (deepest wide optical)' },
  { id: 'P/SDSS9/color', label: 'SDSS9 color (optical)' },
  { id: 'P/2MASS/color', label: '2MASS color (near-infrared)' },
  { id: 'P/allWISE/color', label: 'AllWISE color (mid-infrared)' },
  { id: 'P/Fermi/color', label: 'Fermi color (gamma-ray)' },
  { id: 'P/NVSS', label: 'NVSS (radio)' }
];

const ALLWISE_HINT = 'Mid-infrared: dusty star-forming regions and AGN/quasar accretion glow show up strongly here.';

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function addToggle(listEl, { label, checked = true, onToggle }) {
  const id = 'tgl-' + Math.random().toString(36).slice(2, 9);
  const li = document.createElement('li');
  li.innerHTML = `<input type="checkbox" id="${id}" ${checked ? 'checked' : ''}/>` +
    `<label class="toggle-label" for="${id}">${label}</label><span class="toggle-count"></span>`;
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
  await A.init;

  const aladin = A.aladin('#aladin-lite-div', {
    survey: BASE_SURVEYS[0].id,
    fov: 180,
    projection: 'SIN',
    showFullscreenControl: true,
    showCooGridControl: true,
    cooFrame: 'ICRS'
  });
  aladin.gotoRaDec(SGR_A_STAR.ra, SGR_A_STAR.dec);

  // ---------------------------------------------------------- Imagery UI ---
  const baseSelect = document.getElementById('base-layer-select');
  const overlaySelect = document.getElementById('overlay-layer-select');
  for (const s of BASE_SURVEYS) {
    baseSelect.appendChild(new Option(s.label, s.id));
    overlaySelect.appendChild(new Option(s.label, s.id));
  }
  baseSelect.value = BASE_SURVEYS[0].id;
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

  // -------------------------------------------------------------- Chrome ---
  initRailToggle();
  initRedlightToggle();
  initAboutModal();
  initDetailPanelClose();
  initOnboarding();
  initTours(aladin);

  // ------------------------------------------------------------ Readouts ---
  const skyDiv = document.getElementById('aladin-lite-div');
  const updateCoordReadout = debounce((x, y) => {
    try {
      const [ra, dec] = aladin.pix2world(x, y);
      if (ra == null) return;
      document.getElementById('coord-readout').textContent = `RA ${toSexagesimalRA(ra)}  Dec ${toSexagesimalDec(dec)}`;
    } catch (err) { /* cursor left the sky area, e.g. off the sphere */ }
  }, 250);
  skyDiv.addEventListener('mousemove', (e) => {
    const rect = skyDiv.getBoundingClientRect();
    updateCoordReadout(e.clientX - rect.left, e.clientY - rect.top);
  });

  const updateFovReadout = debounce(() => {
    try {
      const fov = aladin.getFov();
      document.getElementById('fov-readout').textContent = `FoV ${fov[0].toFixed(3)}°`;
    } catch (err) { /* ignore transient state during animation */ }
  }, 250);
  aladin.on('zoomChanged', updateFovReadout);
  updateFovReadout();

  function tickClock() {
    document.getElementById('clock-readout').textContent = new Date().toUTCString();
  }
  setInterval(tickClock, 1000);
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
    await runSearch(aladin, searchInput.value);
    renderHistory();
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

  // -------------------------------------------------------------- Catalogs ---
  const catalogList = document.getElementById('catalog-toggle-list');
  const bhList = document.getElementById('blackhole-toggle-list');

  const simbadCat = initSimbadHips(aladin);
  addToggle(catalogList, { label: 'SIMBAD (progressive)', onToggle: (v) => setCatalogVisible(simbadCat, v) });

  const gaiaCat = initGaiaHips(aladin);
  addToggle(catalogList, { label: 'Gaia DR3 stars (progressive)', onToggle: (v) => setCatalogVisible(gaiaCat, v) });

  const messierToggle = addToggle(catalogList, { label: 'Messier & NGC/IC', onToggle: (v) => setCatalogVisible(messierRef.catalog, v) });
  const messierRef = {};
  loadMessierNgc(aladin).then(({ catalog, count }) => { messierRef.catalog = catalog; messierToggle.setCount(count); });

  const exoToggle = addToggle(catalogList, { label: 'Exoplanets', onToggle: (v) => setCatalogVisible(exoRef.catalog, v) });
  const exoRef = {};
  loadExoplanets(aladin).then(({ catalog, count }) => {
    exoRef.catalog = catalog;
    exoToggle.setCount(count.toLocaleString());
    if (count > 0) showToast(`Loaded ${count.toLocaleString()} confirmed exoplanets from the NASA Exoplanet Archive.`, 'info');
  });

  const planetsToggle = addToggle(catalogList, { label: 'Solar System (now)', onToggle: (v) => setCatalogVisible(planetsRef.catalog, v) });
  const planetsRef = {};
  initPlanetsLayer(aladin).then(({ catalog, count }) => { planetsRef.catalog = catalog; planetsToggle.setCount(count); });

  // ----------------------------------------------------------- Black holes ---
  const stellarToggle = addToggle(bhList, { label: 'Confirmed stellar-mass', onToggle: (v) => setCatalogVisible(stellarRef.catalog, v) });
  const stellarRef = {};
  loadStellarBlackHoles(aladin).then(({ catalog, count }) => { stellarRef.catalog = catalog; stellarToggle.setCount(count); });

  const smToggle = addToggle(bhList, { label: 'Supermassive / AGN & quasars', onToggle: (v) => { setCatalogVisible(smRef.flagship, v); setCatalogVisible(smRef.milliquas, v); } });
  const smRef = {};
  loadFlagshipSupermassive(aladin).then(({ catalog, count }) => { smRef.flagship = catalog; smToggle.setCount(`2 flagship + live`); });
  smRef.milliquas = initMilliquasLayer(aladin);

  const gwToggle = addToggle(bhList, { label: 'Gravitational-wave mergers', onToggle: (v) => setCatalogVisible(gwRef.catalog, v) });
  const gwRef = {};
  loadGwMergers(aladin).then(({ catalog, count }) => { gwRef.catalog = catalog; gwToggle.setCount(count); });

  // -------------------------------------------------------------- Legend ---
  renderLegend();

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

function renderLegend() {
  const legend = document.getElementById('legend-list');
  const items = [
    ...Object.values(TYPE_STYLE).map(s => ({ color: s.color, label: s.label })),
    { color: '#5eb1ff', label: 'SIMBAD source' },
    { color: '#ffffff', label: 'Gaia DR3 star' },
    { color: '#7CFF9C', label: 'Exoplanet' },
    { color: '#7fd6ff', label: 'Solar System planet' },
    { color: '#ff9d3f', label: 'Stellar-mass black hole' },
    { color: '#ff5555', label: 'AGN / quasar' },
    { color: '#ffd166', label: 'EHT-imaged supermassive black hole' },
    { color: '#b388ff', label: 'Gravitational-wave merger (illustrative)' }
  ];
  legend.innerHTML = items.map(i =>
    `<li><span class="legend-swatch" style="background:${i.color}"></span>${i.label}</li>`
  ).join('');
}

main().catch(err => {
  console.error(err);
  showToast('Deep Sky Atlas failed to start: ' + err.message, 'error', 15000);
});
