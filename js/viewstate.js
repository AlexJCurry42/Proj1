// Project Planetarium — view-state controller: the globe/inside view mode
// (projection + FoV caps), the per-survey zoom floor with its ease-out,
// the shareable permalink hash, the share button, the floating zoom
// buttons and the coordinates HUD. Everything here answers one question —
// "what is the camera allowed to show, and how do we describe it?" —
// extracted from app.js, which now only boots and wires.

import { showToast, toSexagesimalRA, toSexagesimalDec } from './ui.js';
import { SURVEYS, STOP } from './spectrum.js';
import { readPref, writePref } from './prefs.js';
import { motionOK } from './motion.js';

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Parse a shared-view URL hash (#ra=…&dec=…&fov=…&survey=…&view=…). */
export function parseViewHash() {
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

/** First-discovery nudge: the button breathes until pressed once, ever. */
export function nudgeUntilPressed(btn, prefKey) {
  if (!btn || readPref(prefKey, false) === true) return;
  btn.classList.add('nudge');
  btn.addEventListener('click', () => {
    btn.classList.remove('nudge');
    writePref(prefKey, true);
  }, { once: true });
}

/**
 * @param spectrum accessor returning the spectrum-bar API (it is created
 *        AFTER this controller, because its onSettle callback needs
 *        applyFovLimits/updateHash from here — a function reference breaks
 *        the chicken-and-egg cleanly).
 */
export function initViewState(aladin, { onZoom, onPosition, initialViewMode, spectrum }) {
  let viewMode = initialViewMode;
  const projectionFor = (mode) => mode === 'inside' ? 'STG' : 'SIN';
  const maxFovFor = (mode) => mode === 'inside' ? 300 : 180;

  // Zoom stops where the data does. Each survey has an honest floor
  // (~1 data pixel per screen pixel); zooming past it just magnifies plate
  // grain into orange/blue/black blotches. The engine range enforces the
  // floor against pinch, wheel and buttons alike; when a spectrum scrub
  // lands on a coarser survey while zoomed below its floor, the view eases
  // out to it instead of snapping.
  function currentFovFloor() {
    const s = spectrum();
    return SURVEYS[Math.min(SURVEYS.length - 1, Math.max(0, Math.round(s.getValue() / STOP)))].minFov;
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

  // Keep the URL hash in sync with the view (debounced, replaceState so the
  // back button isn't spammed) — every view is a shareable permalink.
  function currentViewUrl() {
    try {
      const [ra, dec] = aladin.getRaDec();
      const fov = aladin.getFov()[0];
      const view = viewMode === 'inside' ? '&view=inside' : '';
      const hash = `#ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&fov=${fov.toFixed(3)}&survey=${encodeURIComponent(spectrum().nearestSurveyId())}${view}`;
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
      try { await navigator.share({ title: 'Project Planetarium', url }); return; }
      catch (err) { if (err.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link to this view copied to clipboard.', 'info');
    } catch (err) {
      showToast(url, 'info', 12000);
    }
  });

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
  nudgeUntilPressed(viewBtn, 'viewhint');
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

  return { applyFovLimits, updateHash };
}
