// Pocket Planetarium — the sound design. Every major animated moment gets
// a matching audio response, SYNTHESIZED in-code with WebAudio rather than
// shipped as clip files: no downloads, no licensing questions, zero bytes
// on the wire, and clips that are exactly as long as the animations they
// accompany. The palette is deliberately hushed — soft airy noise swells
// for flights, crystalline sweeps for wavelength changes, watch-like ticks
// for switches — routed through one low master gain and a limiter so
// nothing ever startles in a dark room.
//
// Rules: nothing plays before the first user gesture (which also unlocks
// the AudioContext on iOS), nothing plays while the Sound effects checkbox
// is off, and boot-time programmatic toggles are silent by design.

let ctx = null;
let master = null;
let noiseBuf = null;
let enabled = true;

function ensureCtx() {
  if (ctx) return ctx.state === 'suspended' ? (ctx.resume(), ctx) : ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (err) {
    return null;
  }
  const comp = ctx.createDynamicsCompressor(); // safety limiter
  comp.threshold.value = -24;
  comp.ratio.value = 12;
  master = ctx.createGain();
  master.gain.value = 0.16;
  master.connect(comp);
  comp.connect(ctx.destination);
  const len = ctx.sampleRate;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) { // pinkish: integrated white, gentler than hiss
    last = last * 0.96 + (Math.random() * 2 - 1) * 0.22;
    d[i] = last;
  }
  return ctx;
}

// iOS/autoplay: the context can only start from a user gesture — and the
// unlocked flag ALSO enforces our own rule that boot never makes a sound,
// even in browsers whose autoplay policy would technically allow it.
let unlocked = false;
document.addEventListener('pointerdown', () => { unlocked = true; ensureCtx(); }, { capture: true, passive: true });

export function setSfxEnabled(v) { enabled = !!v; }

function gate() {
  if (!enabled || !unlocked) return null;
  const c = ensureCtx();
  if (!c || c.state !== 'running') return null;
  window.__sfx = (window.__sfx || 0) + 1; // test hook: counts actual plays
  return c;
}

// ---- primitives ----

function envGain(c, t0, peaks) {
  // peaks: [[dt, gain], ...] — a piecewise-linear envelope from silence.
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  for (const [dt, v] of peaks) g.gain.linearRampToValueAtTime(Math.max(0.0001, v), t0 + dt);
  g.connect(master);
  return g;
}

function tone(c, t0, { f0, f1 = null, type = 'sine', dur, peaks, detune = 0 }) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1 != null) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  o.detune.value = detune;
  o.connect(envGain(c, t0, peaks));
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

function airy(c, t0, { fFrom, fTo, q = 1.2, dur, peaks }) {
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = q;
  bp.frequency.setValueAtTime(fFrom, t0);
  bp.frequency.exponentialRampToValueAtTime(fTo, t0 + dur);
  src.connect(bp);
  bp.connect(envGain(c, t0, peaks));
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

// ---- the sound set ----

/** Flight departure: an airy swell that rises with the arc (capped, and
 *  always finished before landing so the arrival chime stands alone). */
export function flightStart(flightMs = 2500) {
  const c = gate();
  if (!c) return;
  const dur = Math.min(2.2, Math.max(0.9, flightMs / 1000 * 0.55));
  const t = c.currentTime;
  airy(c, t, { fFrom: 180, fTo: 1900, q: 0.9, dur, peaks: [[0.12, 0.5], [dur * 0.7, 0.34], [dur, 0.0001]] });
  tone(c, t, { f0: 98, f1: 196, type: 'sine', dur, peaks: [[0.2, 0.16], [dur, 0.0001]] });
}

/** Arrival: a soft two-note airy chime with a shimmer of detune. */
export function flightLand() {
  const c = gate();
  if (!c) return;
  const t = c.currentTime;
  for (const [dt, f] of [[0, 784], [0.14, 1175]]) {
    tone(c, t + dt, { f0: f, type: 'sine', dur: 0.7, peaks: [[0.015, 0.32], [0.7, 0.0001]] });
    tone(c, t + dt, { f0: f, type: 'sine', detune: 7, dur: 0.7, peaks: [[0.015, 0.12], [0.7, 0.0001]] });
  }
}

/** Wavelength change: a crystalline sweep, up toward gamma, down toward radio. */
export function spectrumShift(up = true) {
  const c = gate();
  if (!c) return;
  const t = c.currentTime;
  airy(c, t, {
    fFrom: up ? 500 : 2600, fTo: up ? 2600 : 500, q: 6, dur: 0.45,
    peaks: [[0.04, 0.4], [0.32, 0.28], [0.45, 0.0001]]
  });
}

/** Layer switch: a watch-like micro tick (brighter on, duller off). */
export function layerToggle(on = true) {
  const c = gate();
  if (!c) return;
  const t = c.currentTime;
  tone(c, t, { f0: on ? 1320 : 880, type: 'sine', dur: 0.07, peaks: [[0.004, 0.5], [0.07, 0.0001]] });
}

/** Detail panel: hushed air, rising open / falling closed. */
export function panelOpen() {
  const c = gate();
  if (!c) return;
  airy(c, c.currentTime, { fFrom: 300, fTo: 1200, q: 1.4, dur: 0.16, peaks: [[0.03, 0.3], [0.16, 0.0001]] });
}
export function panelClose() {
  const c = gate();
  if (!c) return;
  airy(c, c.currentTime, { fFrom: 1200, fTo: 300, q: 1.4, dur: 0.14, peaks: [[0.03, 0.24], [0.14, 0.0001]] });
}

/** Crosshair identification: the faintest two-note ping. */
export function cardAppear() {
  const c = gate();
  if (!c) return;
  const t = c.currentTime;
  tone(c, t, { f0: 1046, type: 'sine', dur: 0.32, peaks: [[0.01, 0.18], [0.32, 0.0001]] });
  tone(c, t + 0.09, { f0: 1568, type: 'sine', dur: 0.36, peaks: [[0.01, 0.12], [0.36, 0.0001]] });
}

/** Time-lapse: a tiny wind-up arpeggio to start, wound down to stop. */
export function playStart() {
  const c = gate();
  if (!c) return;
  const t = c.currentTime;
  for (const [i, f] of [523, 659, 784].entries()) {
    tone(c, t + i * 0.07, { f0: f, type: 'triangle', dur: 0.14, peaks: [[0.01, 0.2], [0.14, 0.0001]] });
  }
}
export function playStop() {
  const c = gate();
  if (!c) return;
  const t = c.currentTime;
  for (const [i, f] of [784, 659, 523].entries()) {
    tone(c, t + i * 0.07, { f0: f, type: 'triangle', dur: 0.14, peaks: [[0.01, 0.16], [0.14, 0.0001]] });
  }
}
