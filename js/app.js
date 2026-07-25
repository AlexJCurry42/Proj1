// Project Planetarium — application entry point: boot sequencing and wiring
// only. The substance lives in controllers:
//   js/layersdock.js — every dock switch, its lazy loading and consent flows
//   js/viewstate.js  — view mode, zoom floors, permalink hash, share, HUD
//   (plus the long-standing dock/timeui/searchui/centerid/... modules)
// This file decides ORDER: chrome first (a sky-engine failure must still
// leave a working shell), then the engine, then everything that needs it.

import {
  showToast, renderDetailPanel, showDetailLoading, closeDetailPanel,
  currentDetailEpoch, fetchSimbadNear, humanObjectType,
  initTours, initAboutModal, initRedlightToggle,
  initDetailPanelClose, initKeyboard
} from './ui.js';
import { initUiGuide } from './guide.js';
import { primeConstellations } from './constellation.js';
import { SURVEYS, STOP, MAX_VALUE, DEFAULT_VALUE, initSpectrumBar } from './spectrum.js';
import { readPref, writePref } from './prefs.js';
import { initMarkerFades } from './markerfade.js';
import { initMotion } from './motion.js';
import { initDockCollapse, collapseDock } from './dock.js';
import { initTimeControl } from './timeui.js';
import { initSearchUI } from './searchui.js';
import { initCenterId } from './centerid.js';
import { initSkyNow } from './skynow.js';
import { onTimeChange } from './clock.js';
import { getOverlay } from './overlay.js';
import { initTimeSky } from './timesky.js';
import { parseViewHash, nudgeUntilPressed, initViewState } from './viewstate.js';
import { initLayersDock } from './layersdock.js';

const SGR_A_STAR = { ra: 266.41683, dec: -29.007811 };

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function main() {
  // Reaching here means the whole module graph (and the engine script ahead
  // of it) has downloaded and parsed — the boot bar's first real milestone.
  window.__boot?.to(45);
  // Aladin-independent chrome first, so a sky-engine failure still leaves a
  // working shell (dock, about modal, red-light mode). Each piece is
  // fault-isolated: right after a deploy the HTTP cache can briefly pair a
  // stale index.html with fresh JS, and a missing element in one widget must
  // cost that widget, not the sky.
  for (const initChrome of [initMotion, initRedlightToggle, initAboutModal, initDetailPanelClose,
                            initKeyboard, initDockCollapse, initTimeControl, initUiGuide]) {
    try { initChrome(); } catch (err) { console.error('chrome init failed:', err); }
  }

  // The IAU constellation zone table (detail panel's Constellation row):
  // tiny, but strictly off the boot path.
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 4000)))(() => primeConstellations());

  // Spectrum position priority: shared link > saved position > legacy survey
  // preference > default.
  const linkedView = parseViewHash();
  const linkedIdx = SURVEYS.findIndex(s => s.id === linkedView?.survey);
  const legacyIdx = SURVEYS.findIndex(s => s.id === readPref('survey', null));
  const prefSpectrum = readPref('spectrum', null);
  // 2MASS (near-infrared) is the default survey. Existing installs carry a
  // saved spectrum position from the DSS2-default era, so the new default is
  // applied ONCE via a migration flag — after that, the user's own choice
  // persists exactly as before. A shared view link still wins outright.
  const migrated2mass = readPref('default2mass', false) === true;
  if (!migrated2mass) writePref('default2mass', true);
  const initialSpectrum = linkedIdx >= 0 ? linkedIdx * STOP
    : !migrated2mass ? DEFAULT_VALUE
      : typeof prefSpectrum === 'number' ? Math.max(0, Math.min(MAX_VALUE, prefSpectrum))
        : legacyIdx >= 0 ? legacyIdx * STOP : DEFAULT_VALUE;
  const startSurvey = SURVEYS[Math.round(initialSpectrum / STOP)].id;

  // View mode: 'globe' looks AT the celestial sphere (orthographic, ≤180°);
  // 'inside' stands WITHIN it (stereographic — the planetarium projection,
  // where the sky wraps around you and the view can open past 180°).
  // Ongoing view-mode state lives in js/viewstate.js; boot only needs the
  // starting values for the engine's constructor.
  const viewMode = linkedView?.view || readPref('viewmode', 'globe');

  // ----------------------------------------------------------- Sky engine ---
  if (typeof window.A === 'undefined') {
    throw new Error('the bundled Aladin Lite engine failed to load (js/vendor/aladin/) — an incomplete deploy or a corrupted cache is the usual cause; reload to re-fetch.');
  }
  // A.init resolves once Aladin's WASM core is downloaded and compiled. It can
  // stall silently (e.g. Safari Lockdown Mode disables WebAssembly), so race
  // it against a timeout rather than awaiting it unconditionally.
  window.__boot?.to(85); // the compile is the long pole: let the bar creep toward here
  await Promise.race([
    A.init,
    new Promise((_, reject) => setTimeout(() =>
      reject(new Error('the Aladin Lite engine stalled during startup (20 s timeout). Anything that blocks WebAssembly or WebGL — such as Safari Lockdown Mode — causes this.')), 20000))
  ]);

  const aladin = A.aladin('#aladin-lite-div', {
    // The engine's default log:true fires a startup usage beacon to
    // alasky.unistra.fr/AladinLiteLogger carrying pageUrl + referrer.
    // The app promises "no tracking, ever", so it stays OFF. (Belt and
    // suspenders: the logger URL is also neutered in the vendored bundle,
    // since that host serves real tiles and can't be blocked by CSP.)
    log: false,
    survey: startSurvey,
    fov: viewMode === 'inside' ? 240 : 180,
    projection: viewMode === 'inside' ? 'STG' : 'SIN',
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
  window.__boot?.to(94); // engine live — what remains is wiring the chrome

  // A lost WebGL context leaves a permanently black sky (the wasm renderer
  // has no recovery path) — surface it with a one-tap reload instead of a
  // frozen app. Capture phase: webglcontextlost does not bubble, but the
  // capture traversal still passes through this ancestor.
  document.getElementById('aladin-lite-div').addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    showFatalError('the browser reclaimed the graphics context (low memory or a long-backgrounded tab is the usual cause). Reloading restores the sky.',
      'The sky renderer stopped');
  }, true);
  const fadeCatalog = initMarkerFades(aladin); // layer toggles cross-fade markers

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

  // Moving the sky puts the open layer dock away (its outside-tap dismissal
  // lives in dock.js; this is the pan/zoom/flight path).
  onPosition(collapseDock);
  onZoom(collapseDock);

  // Time travel turns the SKY, planetarium-style: the camera holds the
  // user's line of sight in their local frame while the clock moves.
  initTimeSky(aladin);

  // View-state controller: mode toggle, zoom floors, permalink, share, HUD.
  // The spectrum bar is created immediately after — each needs the other
  // (onSettle → applyFovLimits; FoV floor → spectrum value), so the
  // controller takes a function accessor instead of the instance.
  let spectrum = null;
  const view = initViewState(aladin, {
    onZoom, onPosition,
    initialViewMode: viewMode,
    spectrum: () => spectrum
  });

  // One slider, the whole spectrum: settles persist position + permalink.
  spectrum = initSpectrumBar(aladin, {
    onSettle: (v) => { writePref('spectrum', v); view.updateHash(); view.applyFovLimits(); },
    // Collapsed by default: menus must not open themselves over the sky on
    // a first visit — the guided tour points them out instead.
    collapsed: readPref('spectrumcollapsed', true) === true,
    onCollapse: (c) => writePref('spectrumcollapsed', c)
  });
  spectrum.setValue(initialSpectrum);
  view.applyFovLimits();

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

  initTours(aladin, spectrum);
  nudgeUntilPressed(document.getElementById('cool-btn'), 'coolhint');

  // The layer dock (left): every switch, its lazy loading and consent flows.
  const dock = initLayersDock(aladin, { onZoom, onPosition, fadeCatalog });
  // Motion tracking switches on the horizon/compass overlay for orientation.
  initSkyNow(aladin, { onTrackingStart: (lat, lon) => dock.onTrackingStart(lat, lon) });

  // Whatever known object sits under the crosshair gets named (layer
  // toggles notwithstanding) — with its full description when we have one.
  initCenterId(aladin, { onPosition, onZoom });

  initSearchUI(aladin);

  // ----------------------------------------------------- Object detail UX ---
  // Tap sequence token: two quick taps launch two SIMBAD lookups, and on a
  // slow connection the FIRST can resolve last — without the token it would
  // overwrite the newer panel (or reopen one the user already dismissed).
  let tapSeq = 0;
  aladin.on('objectClicked', async (object) => {
    tapSeq++; // every tap supersedes any lookup still in flight
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
    const token = tapSeq;
    showDetailLoading();
    // Two staleness guards: the tap token (a newer TAP), and the shared
    // panel epoch (a newer render from ANY writer — search, suggestion —
    // or a dismissal; epoch captured after our own loading render).
    const epoch = currentDetailEpoch();
    const stale = () => token !== tapSeq || epoch !== currentDetailEpoch();
    try {
      const ra = [object.ra, data.ra, data.RA, data.RAJ2000, data.RA_ICRS].map(Number).find(Number.isFinite);
      const dec = [object.dec, data.dec, data.DE, data.DEJ2000, data.DE_ICRS].map(Number).find(Number.isFinite);
      const rec = await fetchSimbadNear(ra, dec);
      const typeLabel = await humanObjectType(rec.otype);
      if (stale()) return;
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
      if (stale()) return;
      showToast(`Could not resolve object details: ${err.message}`, 'error');
      closeDetailPanel();
    }
  });

  window.addEventListener('error', (e) => {
    console.error('Unhandled error:', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled promise rejection:', e.reason);
  });

  // PWA service-worker registration lives inline in index.html: the page is
  // network-first (always fresh), while THIS file is cache-first and may be
  // a version behind — registration from here once left phones running new
  // HTML against stale CSS/JS with no way to converge.

  // Everything interactive is wired: retire the boot screen (tiles keep
  // streaming in behind it regardless — the sky is usable now).
  window.__boot?.done();
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
function showFatalError(message, title = 'The sky engine failed to start') {
  console.error('Project Planetarium fatal:', message);
  document.getElementById('fatal-banner')?.remove();
  const banner = document.createElement('div');
  banner.id = 'fatal-banner';
  banner.setAttribute('role', 'alert');
  const h = document.createElement('h2');
  h.textContent = title;
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
  window.__boot?.done(); // the banner (z:150) sits below the boot screen (z:400)
  showFatalError(err.message);
});
