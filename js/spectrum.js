// Deep Sky Atlas — the spectrum rail. Every imagery survey on one vertical
// track at the top-right, ordered by wavelength: gamma-ray at the top, radio
// at the bottom. Dragging cross-fades adjacent surveys live.
//
// Smoothness model:
//  - the displayed value critically-damps toward the pointer (eased glide,
//    never a jump — taps on the track travel there smoothly),
//  - blend opacity follows smoothstep(frac), so fades breathe into and out
//    of each stop instead of moving linearly,
//  - crossing a stop is seamless by construction: at the moment of the swap
//    the overlay is fully opaque and identical to the incoming base layer.
// Custom pointer-driven slider (native vertical range inputs are unreliable
// across engines) with full keyboard support: arrows step between surveys,
// Home/End jump to the spectrum's ends.

// minFov (degrees) is each survey's honest zoom floor: roughly where one
// data pixel fills a screen pixel. Zooming past it just magnifies plate
// grain — on DSS2 the misregistered red/blue plates dissolve into orange,
// blue and black blotches — so the app stops where the data does.
import { motionOK } from './motion.js';

export const SURVEYS = [
  { id: 'P/Fermi/color', name: 'Fermi', band: 'Gamma-ray — the violent universe', minFov: 1.0 },
  { id: 'P/SDSS9/color', name: 'SDSS9', band: 'Optical — Sloan digital survey', minFov: 0.05 },
  { id: 'P/PanSTARRS/DR1/color-z-zg-g', name: 'Pan-STARRS', band: 'Optical — deepest wide field', minFov: 0.03 },
  { id: 'P/DSS2/color', name: 'DSS2', band: 'Optical — the classic all-sky view', minFov: 0.1 },
  { id: 'P/2MASS/color', name: '2MASS', band: 'Near-infrared — through the dust', minFov: 0.14 },
  { id: 'P/allWISE/color', name: 'AllWISE', band: 'Mid-infrared — warm dust & AGN glow', minFov: 0.2 },
  { id: 'P/NVSS', name: 'NVSS', band: 'Radio — jets, lobes & remnants', minFov: 0.6 }
];

export const STOP = 100;
export const MAX_VALUE = (SURVEYS.length - 1) * STOP;
export const DEFAULT_VALUE = SURVEYS.findIndex(s => s.name === 'DSS2') * STOP;

const PAD = 15; // px of thumb-travel inset at each end of the track
const smoothstep = (t) => t * t * (3 - 2 * t);

export function initSpectrumBar(aladin, { onSettle, collapsed = false, onCollapse } = {}) {
  const rail = document.getElementById('spectrum-rail');
  const track = document.getElementById('spectrum-track');
  const thumb = document.getElementById('spectrum-thumb');
  const chip = document.getElementById('spectrum-chip');
  const nameEl = document.getElementById('spectrum-name');
  const bandEl = document.getElementById('spectrum-band');
  const dotsEl = document.getElementById('spectrum-dots');
  const collapseBtn = document.getElementById('spectrum-collapse');

  for (let i = 0; i < SURVEYS.length; i++) {
    const dot = document.createElement('span');
    dot.className = 'spectrum-dot';
    dot.style.top = `calc(${PAD}px + (100% - ${2 * PAD}px) * ${i / (SURVEYS.length - 1)})`;
    dotsEl.appendChild(dot);
  }
  const dots = [...dotsEl.children];

  let value = DEFAULT_VALUE;   // displayed (eased) position
  let target = DEFAULT_VALUE;  // where the pointer/keyboard wants to be
  let dragging = false;
  let raf = null;
  let settlePending = false;

  let curBase = -1, curOver = -1, overlayLayer = null;

  // The label chip is feedback, not furniture: visible while the user is
  // adjusting, then gone two seconds after the adjustment settles.
  let chipTimer = null;
  function showChip() {
    clearTimeout(chipTimer);
    chipTimer = null;
    chip.classList.add('visible');
  }
  function scheduleChipHide() {
    clearTimeout(chipTimer);
    chipTimer = setTimeout(() => chip.classList.remove('visible'), 2000);
  }

  function applyEngine(v) {
    const idx = Math.min(Math.floor(v / STOP), SURVEYS.length - 2);
    const frac = (v - idx * STOP) / STOP;
    if (idx !== curBase) {
      try { aladin.setBaseImageLayer(SURVEYS[idx].id); } catch (err) { /* mid-drag hiccup */ }
      curBase = idx;
    }
    const overIdx = idx + 1;
    if (frac > 0.001) {
      if (overIdx !== curOver) {
        try {
          overlayLayer = aladin.setOverlayImageLayer(SURVEYS[overIdx].id, 'dsa-blend')
            || aladin.getOverlayImageLayer?.('dsa-blend') || overlayLayer;
        } catch (err) { overlayLayer = null; }
        curOver = overIdx;
      }
      try { overlayLayer?.setOpacity?.(smoothstep(frac)); } catch (err) { /* non-fatal */ }
    } else {
      try { overlayLayer?.setOpacity?.(0); } catch (err) { /* non-fatal */ }
    }

    const near = Math.round(v / STOP);
    nameEl.textContent = (frac > 0.18 && frac < 0.82)
      ? `${SURVEYS[idx].name} + ${SURVEYS[overIdx].name}`
      : SURVEYS[near].name;
    bandEl.textContent = SURVEYS[near].band;
    dots.forEach((d, i) => d.classList.toggle('active', i === near));
    track.setAttribute('aria-valuenow', String(Math.round(v)));
    track.setAttribute('aria-valuetext', nameEl.textContent);
  }

  function paint(v) {
    const rect = track.getBoundingClientRect();
    const travel = rect.height - 2 * PAD;
    const y = PAD + (v / MAX_VALUE) * travel;
    thumb.style.top = `${y}px`;
    chip.style.top = `${rect.top + y}px`;
  }

  function tick() {
    const delta = target - value;
    if (Math.abs(delta) < 0.35 && !dragging) {
      value = target;
      applyEngine(value);
      paint(value);
      raf = null;
      if (settlePending) {
        settlePending = false;
        scheduleChipHide(); // the adjustment is finished: 2s grace, then fade
        onSettle?.(value);
      }
      return;
    }
    // Under the finger the thumb tracks 1:1 — any easing here reads as lag.
    // The glide is reserved for taps, keyboard steps and the release snap.
    value += dragging ? delta : delta * 0.2;
    applyEngine(value);
    paint(value);
    raf = requestAnimationFrame(tick);
  }
  const animate = () => { if (!raf) raf = requestAnimationFrame(tick); };

  function valueFromPointer(clientY) {
    const rect = track.getBoundingClientRect();
    const travel = rect.height - 2 * PAD;
    const t = (clientY - rect.top - PAD) / travel;
    return Math.max(0, Math.min(MAX_VALUE, t * MAX_VALUE));
  }

  function thumbClientY() {
    const rect = track.getBoundingClientRect();
    return rect.top + PAD + (value / MAX_VALUE) * (rect.height - 2 * PAD);
  }

  function startDrag(clientY) {
    dragging = true;
    track.classList.add('dragging');
    showChip();
    target = valueFromPointer(clientY);
    animate();
  }

  function release() {
    if (!dragging) return;
    dragging = false;
    track.classList.remove('dragging');
    const near = Math.round(target / STOP) * STOP;
    if (Math.abs(target - near) <= 15) target = near; // magnetic snap
    settlePending = true;
    animate();
  }

  // Pointer model, tuned to coexist with sky navigation. A touch landing on
  // the thumb scrubs immediately, 1:1. A touch elsewhere on the track is
  // NOT acted on at pointerdown — it becomes a jump on release if it stays a
  // tap, becomes a scrub if it travels vertically, and is discarded entirely
  // if it travels mostly sideways (that's a sky pan brushing the rail, and
  // it used to yank the survey).
  const THUMB_GRAB = 26; // px above/below the thumb that scrub instantly
  const SLOP = 8;        // px of travel before a touch declares its intent
  let gesture = null;    // 'drag' | 'pending' | 'dead'
  let startX = 0, startY = 0;

  track.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { track.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    startX = e.clientX; startY = e.clientY;
    if (Math.abs(e.clientY - thumbClientY()) <= THUMB_GRAB) {
      gesture = 'drag';
      startDrag(e.clientY);
    } else {
      gesture = 'pending';
    }
  });
  track.addEventListener('pointermove', (e) => {
    if (gesture === 'drag') {
      target = valueFromPointer(e.clientY);
      animate();
    } else if (gesture === 'pending') {
      const dx = Math.abs(e.clientX - startX), dy = Math.abs(e.clientY - startY);
      if (dy > SLOP && dy >= dx) {
        gesture = 'drag';
        startDrag(e.clientY);
      } else if (dx > SLOP && dx > dy) {
        gesture = 'dead'; // sideways: a navigation gesture, not slider input
      }
    }
  });
  track.addEventListener('pointerup', (e) => {
    if (gesture === 'pending') {
      // A clean tap: glide to the tapped point.
      showChip();
      target = valueFromPointer(e.clientY);
      settlePending = true;
      animate();
    }
    gesture = null;
    release();
  });
  track.addEventListener('pointercancel', () => {
    gesture = null;
    release();
  });

  track.addEventListener('keydown', (e) => {
    const stopIdx = Math.round(target / STOP);
    let next = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown') next = Math.min(SURVEYS.length - 1, stopIdx + 1) * STOP;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') next = Math.max(0, stopIdx - 1) * STOP;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = MAX_VALUE;
    if (next == null) return;
    e.preventDefault();
    showChip();
    target = next;
    settlePending = true;
    animate();
  });

  window.addEventListener('resize', () => paint(value));

  // ---- collapse / expand ----
  function setCollapsed(c) {
    rail.classList.toggle('collapsed', c);
    chip.classList.toggle('collapsed', c);
    if (c) { clearTimeout(chipTimer); chip.classList.remove('visible'); }
    collapseBtn.setAttribute('aria-expanded', String(!c));
    collapseBtn.setAttribute('aria-label', c ? 'Expand the spectrum control' : 'Collapse the spectrum control');
    onCollapse?.(c);
    // The track's geometry changes as the fold animates: repaint on arrival.
    if (!c) setTimeout(() => paint(value), 450);
  }
  collapseBtn.addEventListener('click', () => setCollapsed(!rail.classList.contains('collapsed')));
  if (collapsed) {
    rail.classList.add('collapsed');
    chip.classList.add('collapsed');
    collapseBtn.setAttribute('aria-expanded', 'false');
    collapseBtn.setAttribute('aria-label', 'Expand the spectrum control');
  }
  rail.querySelector('#spectrum-track').addEventListener('transitionend', () => paint(value));

  // Direct survey cross-fade, used by the "Show me something cool" flights.
  // Scrubbing the VALUE to a distant survey swaps the base layer at every
  // stop crossed and creates an overlay per intermediate survey — tile
  // fetches for wavelengths shown for milliseconds, mid-camera-animation.
  // That churn is what made flights stutter. This instead pins the CURRENT
  // survey as the base, brings the DESTINATION in as the single blend
  // overlay, and eases only its opacity; the base swap happens once, hidden
  // beneath a fully-opaque overlay (the same seamless-by-construction trick
  // applyEngine uses at stop crossings).
  let fadeToken = 0;
  // Pin the blend pair: base = the survey on screen now, overlay = the
  // incoming one (created only if it isn't already the 'dsa-blend' layer).
  function pinBlendPair(fromIdx, toIdx) {
    if (curBase !== fromIdx) {
      try { aladin.setBaseImageLayer(SURVEYS[fromIdx].id); } catch (err) { /* engine hiccup */ }
      curBase = fromIdx;
    }
    if (curOver !== toIdx || !overlayLayer) {
      try {
        overlayLayer = aladin.setOverlayImageLayer(SURVEYS[toIdx].id, 'dsa-blend')
          || aladin.getOverlayImageLayer?.('dsa-blend') || overlayLayer;
      } catch (err) { overlayLayer = null; }
      curOver = toIdx;
    }
  }
  const api = {
    setValue(v, { settle = false } = {}) {
      fadeToken++; // a direct set supersedes any in-flight fade
      value = target = Math.max(0, Math.min(MAX_VALUE, v));
      applyEngine(value);
      paint(value);
      if (settle) onSettle?.(value);
    },
    getValue: () => target,
    nearestSurveyId: () => SURVEYS[Math.round(target / STOP)].id,
    valueForSurveyId: (id) => {
      const i = SURVEYS.findIndex(s => s.id === id);
      return i >= 0 ? i * STOP : null;
    },
    // Create the destination survey as an INVISIBLE (opacity 0) blend
    // overlay so the engine starts fetching its tiles now — flights call
    // this at launch, then fadeToSurvey later finds the layer warm and the
    // reveal is a pure opacity ramp instead of a cold tile load.
    primeSurvey(id) {
      const i = SURVEYS.findIndex(s => s.id === id);
      if (i < 0 || i === Math.round(target / STOP)) return;
      fadeToken++; // priming supersedes any fade already in flight
      pinBlendPair(Math.round(target / STOP), i);
      try { overlayLayer?.setOpacity?.(0); } catch (err) { /* non-fatal */ }
    },
    fadeToSurvey(id, ms = 1800) {
      const i = SURVEYS.findIndex(s => s.id === id);
      if (i < 0) return;
      const toV = i * STOP;
      const fromV = target;
      if (Math.round(fromV) === toV) { api.setValue(toV, { settle: true }); return; }
      if (!motionOK()) {
        api.setValue(toV, { settle: true });
        return;
      }
      const token = ++fadeToken;
      // Pin the pair: the on-screen survey stays the base, the destination
      // is the one incoming layer (a no-op if primeSurvey already did this).
      pinBlendPair(Math.round(fromV / STOP), i);
      const t0 = performance.now();
      const step = (t) => {
        // A user grab or another set/fade takes over instantly.
        if (token !== fadeToken || dragging) return;
        const u = Math.min(1, (t - t0) / ms);
        try { overlayLayer?.setOpacity?.(smoothstep(u)); } catch (err) { /* non-fatal */ }
        // The thumb glides along for feedback; the engine pair stays pinned.
        value = target = fromV + (toV - fromV) * smoothstep(u);
        paint(value);
        if (u < 1) { requestAnimationFrame(step); return; }
        // Fully opaque: swapping the base underneath is invisible.
        api.setValue(toV, { settle: true });
      };
      requestAnimationFrame(step);
    }
  };
  return api;
}
