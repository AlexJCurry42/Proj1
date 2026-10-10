// Project Planetarium — the spectrum rail. Every imagery survey on one vertical
// track at the top-right, ordered by wavelength: gamma-ray at the top, radio
// at the bottom. The rail selects one survey; the engine renders the switch.
//
// Interaction model:
//  - the thumb critically-damps toward the pointer (eased glide, never a
//    jump — taps and keyboard steps travel there smoothly),
//  - the survey is COMMITTED once the rail settles on a stop, and it arrives
//    as a CROSS-FADE: the incoming survey is brought up as an overlay above
//    whatever is already on screen, and the outgoing layer is dropped only
//    once the new one is fully opaque. The base is set once by the
//    constructor and never touched again, which is what keeps a switch from
//    ever flashing black (see the long note on commitSurvey below).
//    Imagery is not touched mid-drag — only on settle.
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
const smoothstep = (t) => t * t * (3 - 2 * t);

export function initSpectrumBar(aladin, { onSettle, collapsed = false, onCollapse, baseSurveyId } = {}) {
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

  // ---- survey selection: a cross-fade that can never show black ----
  //
  // Why not setBaseImageLayer: swapping the BASE tears the current imagery
  // down and rebuilds it, so every switch showed the empty sky — black —
  // until the new survey's tiles arrived. It is also the call the engine
  // refuses while that survey is loaded as an overlay, and which it silently
  // DEFERS while any layer is still being queried (see the engine's own
  // _waitsForLayer / delayedBaseLayerCalledParams): the desync those two
  // behaviours produced is what froze the rail on the boot survey.
  //
  // So the base is set ONCE, by the constructor, and never touched again.
  // Every selection rides above it as a named overlay. The two properties
  // that kill the black flash both fall out of that:
  //   · a base layer missing tiles paints BLACK; an overlay missing tiles is
  //     TRANSPARENT, so whatever is already on screen shows through it,
  //   · the outgoing layer is removed only AFTER the incoming one has
  //     reached full opacity, so there is never a frame with nothing up.
  // Worst case (the engine refuses the new layer) the picture simply stays
  // on the survey already showing. It never goes black.
  const FADE_MS = 620;
  const bootIdx = SURVEYS.findIndex(s => s.id === baseSurveyId);
  // -1 would mean 'no stop matches the base', making the base unreachable
  // and stranding an overlay forever; fall back to the documented default.
  const baseIdx = bootIdx >= 0 ? bootIdx : Math.round(DEFAULT_VALUE / STOP);
  let appliedIdx = baseIdx;      // what the rail has committed
  let liveLayer = null;          // the overlay on screen, or null = base showing
  let layerSeq = 0;
  let fadeRaf = null, fadeDone = null;

  function dropLayer(l) {
    if (!l) return;
    try { aladin.removeImageLayer(l.name); } catch (err) { /* already gone */ }
  }

  // Fast-forward any fade in flight: land it on its final opacity and run its
  // cleanup, so a rapid second tap can never strand a half-faded layer.
  function settleFade() {
    if (fadeRaf) { cancelAnimationFrame(fadeRaf); fadeRaf = null; }
    const done = fadeDone; fadeDone = null;
    if (done) done();
  }

  function ramp(layer, from, to, after) {
    const apply = (o) => { try { layer.setOpacity?.(o); } catch (err) { /* non-fatal */ } };
    const finish = () => { apply(to); after?.(); };
    if (!motionOK()) { finish(); return; }
    apply(from);
    const t0 = performance.now();
    fadeDone = finish;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / FADE_MS);
      apply(from + (to - from) * smoothstep(t));
      if (t < 1) { fadeRaf = requestAnimationFrame(step); return; }
      fadeRaf = null; fadeDone = null;
      after?.();
    };
    fadeRaf = requestAnimationFrame(step);
  }

  function commitSurvey(idx) {
    idx = Math.max(0, Math.min(SURVEYS.length - 1, idx));
    if (idx === appliedIdx) return;
    appliedIdx = idx;
    settleFade();

    // Back to the survey the base already holds: fade the overlay off and
    // drop it. The base underneath is warm, so this is instant and clean.
    if (idx === baseIdx) {
      const out = liveLayer;
      liveLayer = null;
      if (out) ramp(out.layer, 1, 0, () => dropLayer(out));
      return;
    }

    const name = 'dsa-blend-' + (++layerSeq);
    let layer = null;
    try {
      layer = aladin.setOverlayImageLayer(SURVEYS[idx].id, name)
        || aladin.getOverlayImageLayer?.(name);
    } catch (err) { layer = null; }
    if (!layer) {
      // Engine busy or the survey was rejected: keep the current picture up
      // (never black) and let the next settle re-commit.
      appliedIdx = liveLayer ? liveLayer.idx : baseIdx;
      return;
    }
    const prev = liveLayer;
    liveLayer = { name, layer, idx };
    // The outgoing layer stays fully opaque beneath until the incoming one
    // has arrived, then it is removed — never a gap.
    ramp(layer, 0, 1, () => dropLayer(prev));
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
  // Every write here is deduped against what is already on screen. The label
  // only changes a handful of times across a whole glide, but this runs once
  // per frame — blindly rewriting two text nodes, eight dot classes and two
  // ARIA attributes every frame put ~13 DOM mutations against the main thread
  // exactly while the engine was decoding a new survey's tiles.
  let lastNear = -1, lastLabel = null, lastValueNow = null;
  function applyEngine(v) {
    const idx = Math.min(Math.floor(v / STOP), SURVEYS.length - 2);
    const frac = (v - idx * STOP) / STOP;
    const near = Math.round(v / STOP);
    const label = (frac > 0.18 && frac < 0.82)
      ? `${SURVEYS[idx].name} + ${SURVEYS[idx + 1].name}`
      : SURVEYS[near].name;
    if (label !== lastLabel) {
      lastLabel = label;
      nameEl.textContent = label;
      track.setAttribute('aria-valuetext', label);
    }
    if (near !== lastNear) {
      if (lastNear >= 0) dots[lastNear].classList.remove('active');
      dots[near].classList.add('active');
      lastNear = near;
      bandEl.textContent = SURVEYS[near].band;
    }
    const valueNow = String(Math.round(v));
    if (valueNow !== lastValueNow) {
      lastValueNow = valueNow;
      track.setAttribute('aria-valuenow', valueNow);
    }
  }

  // getBoundingClientRect() forces a synchronous layout, and the drag/glide
  // loop called it EVERY frame — the single most expensive thing on the rail's
  // hot path, and it competes with the engine's own work during a swap. The
  // track's geometry only moves on resize, orientation change and the collapse
  // fold, so read it once and invalidate on exactly those.
  let rectCache = null, paintedY = null;
  function trackRect() {
    if (!rectCache) rectCache = track.getBoundingClientRect();
    return rectCache;
  }
  function invalidateRect() {
    rectCache = null;
    paintedY = null; // geometry moved: the next paint must write even if y matches
  }

  function paint(v) {
    const rect = trackRect();
    const travel = rect.height - 2 * PAD;
    const y = PAD + (v / MAX_VALUE) * travel;
    if (y === paintedY) return; // the thumb has not moved: nothing to write
    paintedY = y;
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
    const rect = trackRect();
    const travel = rect.height - 2 * PAD;
    const t = (clientY - rect.top - PAD) / travel;
    return Math.max(0, Math.min(MAX_VALUE, t * MAX_VALUE));
  }

  function thumbClientY() {
    const rect = trackRect();
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
    invalidateRect(); // one fresh read per gesture, then cached for its frames
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

  window.addEventListener('resize', () => { invalidateRect(); paint(value); });
  // The chip is position:fixed off the track's viewport rect, so a scroll
  // moves it even though the track's own box is unchanged.
  window.addEventListener('scroll', invalidateRect, { passive: true });

  // ---- collapse / expand ----
  function setCollapsed(c) {
    rail.classList.toggle('collapsed', c);
    chip.classList.toggle('collapsed', c);
    if (c) { clearTimeout(chipTimer); chip.classList.remove('visible'); }
    collapseBtn.setAttribute('aria-expanded', String(!c));
    collapseBtn.setAttribute('aria-label', c ? 'Expand the spectrum control' : 'Collapse the spectrum control');
    onCollapse?.(c);
    // The track's geometry changes as the fold animates: repaint on arrival.
    if (!c) setTimeout(() => { invalidateRect(); paint(value); }, 450);
  }
  collapseBtn.addEventListener('click', () => setCollapsed(!rail.classList.contains('collapsed')));
  if (collapsed) {
    rail.classList.add('collapsed');
    chip.classList.add('collapsed');
    collapseBtn.setAttribute('aria-expanded', 'false');
    collapseBtn.setAttribute('aria-label', 'Expand the spectrum control');
  }
  rail.querySelector('#spectrum-track').addEventListener('transitionend', () => { invalidateRect(); paint(value); });

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
