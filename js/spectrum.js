// Project Planetarium — the spectrum rail. Every imagery survey on one vertical
// track at the top-right, ordered by wavelength: gamma-ray at the top, radio
// at the bottom. The rail selects one survey; a blend overlay renders it.
//
// Interaction model:
//  - the thumb critically-damps toward the pointer (eased glide, never a
//    jump — taps and keyboard steps travel there smoothly),
//  - the survey is COMMITTED once the rail settles on a stop (imagery is not
//    touched mid-drag), and the commit rides a single overlay above a FIXED
//    base — never the base layer itself. The engine applies a base swap
//    asynchronously and refuses base == overlay; touching the base directly
//    either froze the sky or (cancelling the boot load) blacked it out
//    entirely. See commitSurvey for the full account.
// Custom pointer-driven slider (native vertical range inputs are unreliable
// across engines) with full keyboard support: arrows step between surveys,
// Home/End jump to the spectrum's ends.

// minFov (degrees) is each survey's honest zoom floor: roughly where one
// data pixel fills a screen pixel. Zooming past it just magnifies plate
// grain — on DSS2 the misregistered red/blue plates dissolve into orange,
// blue and black blotches — so the app stops where the data does.
import { motionOK } from './motion.js';
import { spectrumShift } from './sound.js';

export const SURVEYS = [
  { id: 'P/Fermi/color', name: 'Fermi', band: 'Gamma-ray — the violent universe', minFov: 1.0 },
  { id: 'P/SDSS9/color', name: 'SDSS9', band: 'Optical — Sloan digital survey', minFov: 0.05 },
  { id: 'P/PanSTARRS/DR1/color-z-zg-g', name: 'Pan-STARRS', band: 'Optical — deep CCD survey', minFov: 0.03 },
  { id: 'P/DESI-Legacy-Surveys/DR10/color', name: 'DESI LS', band: 'Optical — deepest wide imaging (grz)', minFov: 0.03 },
  { id: 'P/DSS2/color', name: 'DSS2', band: 'Optical — the classic all-sky view', minFov: 0.1 },
  { id: 'P/2MASS/color', name: '2MASS', band: 'Near-infrared — through the dust', minFov: 0.14 },
  { id: 'P/allWISE/color', name: 'AllWISE', band: 'Mid-infrared — warm dust & AGN glow', minFov: 0.2 },
  { id: 'P/NVSS', name: 'NVSS', band: 'Radio — jets, lobes & remnants', minFov: 0.6 }
];

export const STOP = 100;
export const MAX_VALUE = (SURVEYS.length - 1) * STOP;
export const DEFAULT_VALUE = SURVEYS.findIndex(s => s.name === '2MASS') * STOP;

const PAD = 15; // px of thumb-travel inset at each end of the track

export function initSpectrumBar(aladin, { onSettle, collapsed = false, onCollapse, baseSurvey } = {}) {
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

  // Survey selection NEVER touches the base layer. The base stays the boot
  // survey for the whole session — a permanent, already-loaded floor — and
  // the CURRENT selection rides on one overlay ('dsa-blend') above it.
  //
  // Why: this engine applies a base swap asynchronously, and (fatally for the
  // old code) REFUSES to set the base to a survey that is already loaded as
  // the blend overlay. The previous cross-fade pinned base=from + overlay=to
  // then set base=to while `to` was the overlay → ignored, bookkeeping
  // desynced, and the sky froze on the boot survey (the on-device report).
  // The first repair swung the other way — setBaseImageLayer directly — which
  // cancelled the constructor's in-flight base load at boot and left NO base:
  // a fully black sky. Keeping the base fixed and layering the selection on
  // top sidesteps both: no base==overlay conflict, and the base is always
  // visible underneath, so a still-loading selection reveals the floor rather
  // than black. Selecting the base survey itself just removes the overlay.
  const BASE_ID = baseSurvey; // set once by the constructor; never reassigned
  let appliedIdx = -1;
  let overlay = null;
  let fadeRaf = null;
  function fadeOverlay(toOpacity, removeAtEnd) {
    cancelAnimationFrame(fadeRaf);
    let from = 0;
    try { from = overlay?.getOpacity?.() ?? 0; } catch (err) { from = 0; }
    const dur = motionOK() ? 450 : 0;
    const t0 = performance.now();
    const step = (t) => {
      const u = dur ? Math.min(1, (t - t0) / dur) : 1;
      try { overlay?.setOpacity?.(from + (toOpacity - from) * u); } catch (err) { /* layer gone */ }
      if (u < 1) { fadeRaf = requestAnimationFrame(step); return; }
      if (removeAtEnd) {
        try { aladin.removeImageLayer?.('dsa-blend'); } catch (err) { /* already gone */ }
        overlay = null;
      }
    };
    fadeRaf = requestAnimationFrame(step);
  }
  function commitSurvey(idx) {
    idx = Math.max(0, Math.min(SURVEYS.length - 1, idx));
    if (idx === appliedIdx) return;
    appliedIdx = idx;
    if (SURVEYS[idx].id === BASE_ID) {
      // The selection IS the base survey: fade the overlay away to reveal it.
      if (overlay) fadeOverlay(0, true);
      return;
    }
    try {
      overlay = aladin.setOverlayImageLayer(SURVEYS[idx].id, 'dsa-blend')
        || aladin.getOverlayImageLayer?.('dsa-blend') || overlay;
      // Start transparent so the base floor shows while the new tiles load —
      // an un-loaded overlay draws nothing, never a black cover.
      overlay?.setOpacity?.(0);
    } catch (err) { overlay = null; }
    fadeOverlay(1, false);
  }

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

  // Visual-only: name, band, dots, thumb position and ARIA. The imagery
  // itself is NOT touched per-frame — it is committed once when the rail
  // settles (commitSurvey), so a drag previews the label live but never
  // fires a burst of colliding async base swaps. While between two stops the
  // name reads "A + B" so the user sees which pair they are sliding across.
  function applyEngine(v) {
    const idx = Math.min(Math.floor(v / STOP), SURVEYS.length - 2);
    const frac = (v - idx * STOP) / STOP;
    const overIdx = idx + 1;
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
      commitSurvey(Math.round(value / STOP)); // settled: apply the survey once
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
      // A clean tap picks a survey: ONE direct cross-fade to the nearest
      // stop. (Gliding the value there walked through every survey in
      // between — each crossing a base swap and a burst of tile loads,
      // which read as jitter. Live pair-blending stays for real drags,
      // where the finger sets the pace.)
      showChip();
      const stopIdx = Math.round(valueFromPointer(e.clientY) / STOP);
      api.fadeToSurvey(SURVEYS[stopIdx].id, 650);
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
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown') next = Math.min(SURVEYS.length - 1, stopIdx + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') next = Math.max(0, stopIdx - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = SURVEYS.length - 1;
    if (next == null) return;
    e.preventDefault();
    showChip();
    api.fadeToSurvey(SURVEYS[next].id, 550); // one direct fade, like taps
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

  // Programmatic survey selection, used by the "Show me something cool"
  // flights and the tap / keyboard handlers. The thumb GLIDES to the target
  // (visual feedback), and the survey is committed once on settle by the
  // tick loop — one setBaseImageLayer, never a per-stop burst. The engine
  // runs its own fade between base layers, so the reveal stays smooth
  // without this module orchestrating a blend overlay.
  const api = {
    setValue(v, { settle = false } = {}) {
      // A direct set supersedes any in-flight glide: the single tick loop
      // always eases toward the latest `target`.
      value = target = Math.max(0, Math.min(MAX_VALUE, v));
      applyEngine(value);
      paint(value);
      commitSurvey(Math.round(value / STOP)); // apply immediately (no glide)
      if (settle) onSettle?.(value);
    },
    getValue: () => target,
    nearestSurveyId: () => SURVEYS[Math.round(target / STOP)].id,
    valueForSurveyId: (id) => {
      const i = SURVEYS.findIndex(s => s.id === id);
      return i >= 0 ? i * STOP : null;
    },
    // Kept for the flight callers' API. Prefetching the destination as a
    // hidden overlay is deliberately NOT done: this engine removes layers
    // asynchronously, so an overlay of the destination survey could still be
    // present when the landing commits it as the base — and the engine
    // refuses base == overlay, which is the exact freeze this module now
    // avoids. Landing cold (~1 s, masked by the flight) is the safe trade.
    primeSurvey() { /* no-op: see above */ },
    fadeToSurvey(id) {
      const i = SURVEYS.findIndex(s => s.id === id);
      if (i < 0) return;
      const toV = i * STOP;
      const fromV = target;
      // The wavelength change gets its crystalline sweep — rising toward
      // gamma (index 0), falling toward radio.
      if (Math.round(fromV / STOP) !== i && motionOK()) spectrumShift(toV < fromV);
      showChip();
      // Commit the selection NOW — the survey swap, permalink, saved position
      // and FoV floor must not wait on the cosmetic thumb glide. That glide is
      // frame-paced and crawls while the engine is busy, so deferring the
      // commit to it left the sky (and the hash) a beat behind the tap. The
      // thumb still eases over for feedback; when motion is reduced it snaps.
      target = toV;
      commitSurvey(i);
      scheduleChipHide();
      onSettle?.(toV);
      if (motionOK()) {
        animate();
      } else {
        value = toV;
        applyEngine(value);
        paint(value);
      }
    }
  };
  return api;
}
