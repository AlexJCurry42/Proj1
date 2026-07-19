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
  initTours, initAboutModal, initRedlightToggle,
  initDetailPanelClose, initKeyboard, initWelcomeTips
} from './ui.js';
import { primeConstellations } from './constellation.js';
import { initGaiaHips, initGalaxiesLayer, initSimbadBlackHolesLayer, loadMessierNgc, loadNgcFull, loadExoplanets } from './catalogs.js';
import { initIssLayer } from './iss.js';
import { loadStellarBlackHoles, loadFlagshipSupermassive, initMilliquasLayer } from './blackholes.js';
import { initPlanetsLayer } from './planetslayer.js';
import { loadConstellations, loadConstellationBorders } from './constellations.js';
import { initHorizonLayer, initHorizonLock, requestObserver } from './horizon.js';
import { initStarBloom } from './starbloom.js';
import { initSkyNow } from './skynow.js';
import { SURVEYS, STOP, MAX_VALUE, DEFAULT_VALUE, initSpectrumBar } from './spectrum.js';
import { readPref, writePref } from './prefs.js';
import { onObserver, cachedObserver } from './observer.js';
import { initMarkerFades } from './markerfade.js';
import { motionOK, setAnimationsEnabled, initMotion } from './motion.js';
import { addDockSection, addToggle, initDockCollapse } from './dock.js';
import { initTimeControl } from './timeui.js';
import { initSearchUI } from './searchui.js';
import { initCenterId } from './centerid.js';
import { initGridLayer } from './grid.js';
import { geoPermissionState } from './loccard.js';
import { onTimeChange } from './clock.js';
import { getOverlay } from './overlay.js';
import { initTimeSky } from './timesky.js';
import { setSfxEnabled } from './sound.js';

const SGR_A_STAR = { ra: 266.41683, dec: -29.007811 };

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------------------------------------------- Layer fade on toggle ---
// Cross-fades live in js/markerfade.js on the unified overlay engine; until
// the engine is up, toggles fall back to the plain show/hide.
let fadeCatalog = (cat, visible) => {
  try { visible ? cat.show?.() : cat.hide?.(); } catch (err) { /* best effort */ }
};

function setCatalogVisible(catalogOrList, visible) {
  if (!catalogOrList) return;
  const list = Array.isArray(catalogOrList) ? catalogOrList : [catalogOrList];
  for (const catalog of list) {
    if (!catalog) continue;
    fadeCatalog(catalog, visible);
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
  // working shell (dock, about modal, red-light mode). Each piece is
  // fault-isolated: right after a deploy the HTTP cache can briefly pair a
  // stale index.html with fresh JS, and a missing element in one widget must
  // cost that widget, not the sky.
  for (const initChrome of [initMotion, initRedlightToggle, initAboutModal, initDetailPanelClose,
                            initKeyboard, initDockCollapse, initTimeControl, initWelcomeTips]) {
    try { initChrome(); } catch (err) { console.error('chrome init failed:', err); }
  }

  // The IAU constellation zone table (detail panel's Constellation row):
  // tiny, but strictly off the boot path.
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 4000)))(() => primeConstellations());


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
    showCooLocation: false,
    showFov: false,
    showStatusBar: false,
    showProjectionControl: false,
    cooFrame: 'ICRS',
    // Pure black around the celestial sphere — the sky should feel infinite,
    // not like a globe floating on a gray card.
    backgroundColor: '#000000'
  });
  try { aladin.setBackgroundColor?.('#000000'); } catch (err) { /* option above covers newer builds */ }
  fadeCatalog = initMarkerFades(aladin); // layer toggles can now cross-fade markers

  // Time-lapse playback: each clock tick must wake the overlay engine (its
  // loop idles when nothing animates) so the horizon and other time-aware
  // layers redraw as the played clock advances.
  onTimeChange(() => { try { getOverlay(aladin).wake(); } catch (err) { /* pre-init tick */ } });

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

  // Time travel turns the SKY, planetarium-style: the camera holds the
  // user's line of sight in their local frame while the clock moves.
  initTimeSky(aladin);


  // Zoom stops where the data does. Each survey has an honest floor
  // (~1 data pixel per screen pixel); zooming past it just magnifies plate
  // grain into orange/blue/black blotches. The engine range enforces the
  // floor against pinch, wheel and buttons alike; when a spectrum scrub
  // lands on a coarser survey while zoomed below its floor, the view eases
  // out to it instead of snapping.
  function currentFovFloor() {
    return SURVEYS[Math.min(SURVEYS.length - 1, Math.max(0, Math.round(spectrum.getValue() / STOP)))].minFov;
  }
  let fovEaseToken = 0;
  function applyFovLimits() {
    const floor = currentFovFloor();
    const max = maxFovFor(viewMode);
    const token = ++fovEaseToken;
    let fov = 60;
    try { fov = aladin.getFov()[0]; } catch (err) { /* engine mid-init */ }
    const finish = () => { try { aladin.setFoVRange?.(floor, max); } catch (err) { /* older builds */ } };
    if (fov >= floor || !motionOK()) { finish(); return; }
    // Ease out to the new floor over ~450 ms, then lock the range.
    const from = fov, t0 = performance.now();
    const step = (t) => {
      if (token !== fovEaseToken) return;
      const u = Math.min(1, (t - t0) / 450);
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      try { aladin.setFoV(from + (floor - from) * e); } catch (err) { /* engine hiccup */ }
      if (u < 1) requestAnimationFrame(step); else finish();
    };
    requestAnimationFrame(step);
  }

  // One slider, the whole spectrum: settles persist position + permalink.
  const spectrum = initSpectrumBar(aladin, {
    onSettle: (v) => { writePref('spectrum', v); updateHash(); applyFovLimits(); },
    collapsed: readPref('spectrumcollapsed', false) === true,
    onCollapse: (c) => writePref('spectrumcollapsed', c)
  });
  spectrum.setValue(initialSpectrum);
  applyFovLimits();

  // Bright stars in DSS2 show orange/blue/black blotched cores at ANY zoom
  // deep enough to resolve them. That is the survey data, not a bug: the
  // stars saturated the photographic emulsion, the red and blue plates were
  // exposed years apart (so their images don't align), and JPEG tiles add
  // chroma blocking on the clipped cores. The app can't repaint a
  // photographic survey — but it can explain, once, at the moment the user
  // is probably looking at it.
  let artifactNoteShown = readPref('artifactnote', false) === true;
  const maybeExplainPlateArtifacts = debounce(() => {
    if (artifactNoteShown) return;
    let fov;
    try { fov = aladin.getFov()[0]; } catch (err) { return; }
    if (fov > 2.5 || spectrum.nearestSurveyId() !== 'P/DSS2/color') return;
    artifactNoteShown = true;
    writePref('artifactnote', true);
    showToast('Colored blotches on bright stars are artifacts of the photographic survey plates — the star saturated the emulsion, and the red and blue exposures were taken years apart. Not real structure. Scrub the spectrum rail for a cleaner band.', 'info', 14000);
  }, 800);
  onZoom(maybeExplainPlateArtifacts);

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

  initTours(aladin, spectrum);
  // Motion tracking switches on the horizon/compass overlay for orientation;
  // the hook is filled in below once the layer dock exists.
  let onTrackingStartHook = null;
  initSkyNow(aladin, { onTrackingStart: (lat, lon) => onTrackingStartHook?.(lat, lon) });

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
    applyFovLimits();
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
  // First-discovery nudges (the replacement for modal onboarding): the two
  // doorway buttons breathe until each has been pressed once, ever.
  function nudgeUntilPressed(btn, prefKey) {
    if (!btn || readPref(prefKey, false) === true) return;
    btn.classList.add('nudge');
    btn.addEventListener('click', () => {
      btn.classList.remove('nudge');
      writePref(prefKey, true);
    }, { once: true });
  }
  nudgeUntilPressed(viewBtn, 'viewhint');
  nudgeUntilPressed(document.getElementById('cool-btn'), 'coolhint');
  viewBtn.addEventListener('click', () => {
    applyViewMode(viewMode === 'inside' ? 'globe' : 'inside');
  });

  // Floating zoom controls (Aladin's own chrome is disabled for a clean sky).
  function zoomBy(factor) {
    try {
      const fov = aladin.getFov()[0];
      aladin.setFoV(Math.min(maxFovFor(viewMode), Math.max(0.02, fov * factor)));
    } catch (err) { /* engine mid-animation; ignore */ }
  }
  document.getElementById('zoom-in').addEventListener('click', () => zoomBy(0.5));
  document.getElementById('zoom-out').addEventListener('click', () => zoomBy(2));

  // ------------------------------------------------------- Coordinates HUD ---
  // One whisper of text, bottom-right: the view center's coordinates.
  // (The engine's own location/FoV/status widgets are disabled at init —
  // their grey boxes and magenta text fought the design.)
  const coordsHud = document.getElementById('coords-hud');
  const updateCoordsHud = debounce(() => {
    try {
      const [ra, dec] = aladin.getRaDec();
      coordsHud.textContent = `${toSexagesimalRA(ra)}  ${toSexagesimalDec(dec)}`;
    } catch (err) { /* transient state during animation */ }
  }, 150);
  onPosition(updateCoordsHud);
  onZoom(updateCoordsHud);
  updateCoordsHud();
  // The readout doubles as its own explainer — a first-timer has no reason
  // to know what "5h 34m / +22°" means until they tap it.
  coordsHud?.addEventListener('click', () => {
    showToast('These are the view center’s sky coordinates: Right Ascension (the sky’s longitude, measured in hours-minutes-seconds) and Declination (its latitude, in degrees). Flip on the Coordinate grid layer to see these lines drawn on the sky.', 'info', 12000);
  });

  // Whatever known object sits under the crosshair gets named (layer
  // toggles notwithstanding) — with its full description when we have one.
  initCenterId(aladin, { onPosition, onZoom });

  initSearchUI(aladin);

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
        spType: rec.spType,
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

  // First-load default: ONLY the Solar System layer is on — the sky itself is
  // the star of the show. Everything else builds ready-to-go but starts
  // hidden; the user's own toggle choices persist and override from then on.

  addDockSection(catalogList, 'Sky guides');

  // Horizon & compass: YOUR horizon on the sky — ON by default (it's the
  // main defense against getting lost in the spherical views). Needs
  // location (on-device only); if permission is declined the switch turns
  // itself back off and never nags. Alongside the drawn overlay comes the
  // horizon LOCK: while the user pans, the view gently re-levels so their
  // zenith reads as up.
  const horizonRef = { ctl: null, busy: false };
  const horizonLock = initHorizonLock(aladin, onPosition);
  const horizonToggle = addToggle(catalogList, {
    label: 'Horizon & compass', color: '#63d68b', checked: true,
    onToggle: async (v, { gesture } = {}) => {
      if (v && !horizonRef.ctl && !horizonRef.busy) {
        horizonRef.busy = true;
        try {
          // Boot NEVER asks for location — not even with the in-app card.
          // The only prompt moments are the Sky Now button (see skynow.js)
          // and a deliberate flip of this switch. Without permission the
          // layer just waits, quietly unchecked.
          if (!gesture && !cachedObserver()) {
            if ((await geoPermissionState()) !== 'granted') {
              horizonToggle.setChecked(false);
              horizonRef.busy = false;
              return;
            }
          }
          horizonToggle.setLoading(true);
          const obs = await requestObserver();
          horizonRef.ctl = initHorizonLayer(aladin, obs);
          horizonLock.setObserver(obs);
        } catch (err) {
          showToast('The horizon overlay needs your location to know which sky is yours — it never leaves this device.', 'error', 8000);
          horizonToggle.setChecked(false);
        }
        horizonToggle.setLoading(false);
        horizonRef.busy = false;
      }
      if (!horizonRef.ctl) return;
      const on = horizonToggle.isChecked();
      horizonLock.setEnabled(on);
      if (on) horizonRef.ctl.show(); else horizonRef.ctl.hide();
    }
  });
  // Gyro tracking brings its own orientation context: the horizon, cardinal
  // directions and zenith switch on with it (coordinates arrive from the
  // tracker, so no second location request is ever needed).
  onTrackingStartHook = (lat, lon) => {
    if (!horizonRef.ctl) {
      try { horizonRef.ctl = initHorizonLayer(aladin, { lat, lon }); }
      catch (err) { return; }
    }
    if (!horizonToggle.isChecked()) horizonToggle.setChecked(true);
    horizonLock.setObserver({ lat, lon });
    horizonLock.setEnabled(true);
    horizonRef.ctl.show();
  };

  // Coordinate grid: our own RA/Dec graticule on the overlay engine (the
  // engine's built-in one snapped between spacing levels and let its labels
  // drift with the sky). Spacing cross-fades continuously with zoom, and
  // the labels are pinned to the screen edges — a scale readout that sits
  // still while the sky moves under it.
  const gridRef = { ctl: null };
  addToggle(catalogList, {
    label: 'Coordinate grid', color: '#5ac8fa', checked: false,
    onToggle: (v) => {
      if (v && !gridRef.ctl) gridRef.ctl = initGridLayer(aladin);
      if (gridRef.ctl) (v ? gridRef.ctl.show() : gridRef.ctl.hide());
    }
  });

  const constRef = { loading: false };
  const bordersRef = { loading: false };
  function ensureConstellations() {
    if (constRef.catalogs || constRef.loading) return;
    constRef.loading = true;
    constToggle.setLoading(true);
    loadConstellations(aladin).then(({ catalogs, count }) => {
      constRef.catalogs = catalogs;
      constRef.loading = false;
      constToggle.setLoading(false);
      constToggle.setCount(count);
      setCatalogVisible(catalogs, constToggle.isChecked());
    });
  }

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
    onToggle: (v) => {
      if (v) ensureConstellations(); // lazy: boot stays light, first flip loads
      setCatalogVisible(constRef.catalogs, v);
      syncBorders();
    }
  });
  const bordersToggle = addToggle(catalogList, {
    label: 'Boundaries', color: '#39496b', checked: false, sub: true,
    onToggle: () => syncBorders()
  });
  syncBorders();

  addDockSection(catalogList, 'Catalogs');

  // Deep sky: one switch for everything beyond the Solar System's furniture.
  // The ~140 curated showpieces (typed colors, photos, renders) are the
  // always-ready bright tier; the complete OpenNGC catalog (~12k objects,
  // magnitude-tiered by zoom, deduped against the showpieces) lazy-loads the
  // first time the switch is flipped.
  const deepRef = { curated: null, curatedCount: 0, ids: null, full: null, loading: false };
  const deepToggle = addToggle(catalogList, {
    label: 'Deep sky', color: '#ffd60a', checked: false,
    onToggle: async (v) => {
      // Everything is lazy now — curated showpieces AND the full OpenNGC
      // catalog load together on the first flip, nothing at boot.
      if (v && !deepRef.curated && !deepRef.loading) {
        deepRef.loading = true;
        deepToggle.setLoading(true);
        const { catalogs, count, ids } = await loadMessierNgc(aladin, onZoom);
        deepRef.curated = catalogs;
        deepRef.curatedCount = count;
        deepRef.ids = ids;
        const full = await loadNgcFull(aladin, onZoom, ids || undefined);
        deepRef.full = full.catalog;
        deepRef.loading = false;
        deepToggle.setLoading(false);
        deepToggle.setCount((count + (full.count || 0)).toLocaleString());
      }
      setCatalogVisible(deepRef.curated, deepToggle.isChecked());
      setCatalogVisible(deepRef.full, deepToggle.isChecked());
    }
  });

  // Solar System: Sun, Moon, planets — and the ISS, humanity's outpost. The
  // station's position is observer-dependent (LEO parallax spans tens of
  // degrees), so its marker lights up the moment coordinates arrive from a
  // feature the user chose (horizon consent, Sky Now); it never prompts.
  const planetsRef = { iss: null, issStarted: false };
  const planetsToggle = addToggle(catalogList, {
    label: 'Solar System', color: '#7fd6ff', checked: true,
    onToggle: (v) => {
      setCatalogVisible(planetsRef.catalogs, v);
      if (planetsRef.iss) { if (v) planetsRef.iss.show(); else planetsRef.iss.hide(); }
    }
  });
  initPlanetsLayer(aladin).then(({ catalogs, count }) => {
    planetsRef.catalogs = catalogs;
    planetsRef.count = count;
    planetsToggle.setCount(count);
    setCatalogVisible(catalogs, planetsToggle.isChecked());
  });
  onObserver(async (obs) => {
    if (planetsRef.issStarted) return;
    planetsRef.issStarted = true;
    try {
      planetsRef.iss = await initIssLayer(aladin, obs);
    } catch (err) { /* no TLE yet: the marker just doesn't appear */ }
    if (planetsRef.iss && planetsToggle.isChecked()) {
      planetsRef.iss.show();
      planetsToggle.setCount((planetsRef.count || 11) + 1);
    }
  });

  // Off by default, created lazily on first enable: heavy/bulk layers.
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
        exoToggle.setLoading(true);
        const { catalog, count } = await loadExoplanets(aladin);
        exoRef.catalog = catalog;
        exoRef.loading = false;
        exoToggle.setLoading(false);
        if (count > 0) exoToggle.setCount(count.toLocaleString());
        setCatalogVisible(catalog, exoToggle.isChecked());
      } else {
        setCatalogVisible(exoRef.catalog, v);
      }
    }
  });

  // ----------------------------------------------------------- Black holes ---
  addDockSection(catalogList, 'Black holes');
  // Two sources under one switch: the curated stellar-mass list (rich
  // physics-driven renders, literature citations) plus a live SIMBAD layer
  // of everything catalogued as a (candidate) black hole, so the toggle
  // genuinely means "all known".
  const stellarRef = { loading: false };
  let simbadBhCat = null;
  const stellarToggle = addToggle(catalogList, {
    label: 'Black holes', color: '#ff9f0a', checked: false,
    onToggle: (v) => {
      if (v && !stellarRef.catalog && !stellarRef.loading) {
        stellarRef.loading = true;
        stellarToggle.setLoading(true);
        loadStellarBlackHoles(aladin).then(({ catalog, count }) => {
          stellarRef.catalog = catalog;
          stellarRef.loading = false;
          stellarToggle.setLoading(false);
          if (count) stellarToggle.setCount(count);
          setCatalogVisible(catalog, stellarToggle.isChecked());
        });
      } else {
        setCatalogVisible(stellarRef.catalog, v);
      }
      if (v && !simbadBhCat) {
        simbadBhCat = initSimbadBlackHolesLayer(aladin, onZoom, onPosition);
      } else {
        simbadBhCat?.dsaSetEnabled?.(v); // stop/restart live SIMBAD queries
        setCatalogVisible(simbadBhCat, v);
      }
    }
  });

  const flagshipRef = { loading: false };
  const flagshipToggle = addToggle(catalogList, {
    label: 'Supermassive', color: '#ffd60a', checked: false,
    onToggle: (v) => {
      if (v && !flagshipRef.catalog && !flagshipRef.loading) {
        flagshipRef.loading = true;
        flagshipToggle.setLoading(true);
        loadFlagshipSupermassive(aladin).then(({ catalog, count }) => {
          flagshipRef.catalog = catalog;
          flagshipRef.loading = false;
          flagshipToggle.setLoading(false);
          if (count) flagshipToggle.setCount(count);
          setCatalogVisible(catalog, flagshipToggle.isChecked());
        });
      } else {
        setCatalogVisible(flagshipRef.catalog, v);
      }
    }
  });

  let milliquasCat = null;
  addToggle(catalogList, {
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

  // -------------------------------------------------------------- Display ---
  addDockSection(catalogList, 'Display');
  // Animations: ON by default for everybody (see js/motion.js for why the
  // OS reduce-motion flag is deliberately not the default). This one switch
  // governs EVERYTHING — flights, layer fades, constellation reveals,
  // and all CSS animation (via body.reduce-motion).
  addToggle(catalogList, {
    label: 'Animations', color: '#bf5af2', checked: motionOK(), persist: false,
    onToggle: (v) => setAnimationsEnabled(v)
  });
  // Star bloom: synthetic glows over the blotchy saturated plate cores of
  // bright stars (the one artifact the imagery itself can't fix — see the
  // About panel). On by default because it's what most people expect stars
  // to look like; a checkbox because it retouches the view, and switching
  // back to the raw observations must stay one tap away.
  const bloomRef = { ctl: null, busy: false };
  const bloomToggle = addToggle(catalogList, {
    label: 'Clean bright stars', color: '#fff2b0', checked: true, sub: true,
    onToggle: async (v) => {
      if (v && !bloomRef.ctl && !bloomRef.busy) {
        bloomRef.busy = true;
        bloomToggle.setLoading(true);
        try { bloomRef.ctl = await initStarBloom(aladin); } catch (err) { /* data missing */ }
        bloomRef.busy = false;
        bloomToggle.setLoading(false);
        if (!bloomRef.ctl) { bloomToggle.setChecked(false); return; }
      }
      if (!bloomRef.ctl) return;
      if (bloomToggle.isChecked()) bloomRef.ctl.show(); else bloomRef.ctl.hide();
    }
  });
  // Sound effects: the synthesized audio responses on flights, fades,
  // toggles and panels (js/sound.js). All on-device, nothing fetched.
  const sfxToggle = addToggle(catalogList, {
    label: 'Sound effects', color: '#64d2ff', checked: true, sub: true,
    onToggle: (v) => setSfxEnabled(v)
  });
  setSfxEnabled(sfxToggle.isChecked()); // saved OFF never boot-fires: sync explicitly

  window.addEventListener('error', (e) => {
    console.error('Unhandled error:', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled promise rejection:', e.reason);
  });

  // PWA: cache the app shell so revisits load instantly (sky data stays live).
  // The shell is cache-first per VERSION (see sw.js); when a NEW version's
  // worker takes over mid-session, reload once so the page runs the fresh
  // code immediately — this is what keeps "deploy, then test on the phone"
  // honest despite cache-first assets.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // First-ever install also fires this (clients.claim); only reload on
      // a genuine version change, and only once per session (loop guard).
      if (!hadController) return;
      try {
        if (sessionStorage.getItem('dsa-swreloaded')) return;
        sessionStorage.setItem('dsa-swreloaded', '1');
      } catch (err) { return; }
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => { /* shell caching is optional */ });
  }
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
