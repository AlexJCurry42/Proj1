// Pocket Planetarium — the sound design. Every major animated moment gets
// a matching audio response, SYNTHESIZED in-code with WebAudio rather than
// shipped as clip files: no downloads, no licensing questions, zero bytes
// on the wire, and clips that are exactly as long as the animations they
// accompany. The palette is deliberately hushed and TEXTURAL — breaths of
// filtered air for flights and panels, muted glass taps for arrivals and
// identifications, keyboard-light taps for switches — routed through one
// low master gain and a limiter so nothing ever startles in a dark room.
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
// iOS grants the unlock on touchend/click, NOT on touchstart/pointerdown,
// so all three are listened to (the first one that works wins).
let unlocked = false;
const unlock = () => { unlocked = true; ensureCtx(); };
for (const ev of ['pointerdown', 'touchend', 'click']) {
  document.addEventListener(ev, unlock, { capture: true, passive: true });
}

export function setSfxEnabled(v) { enabled = !!v; }

function gate() {
  if (!enabled || !unlocked) return null;
  const c = ensureCtx();
  if (!c || c.state === 'closed') return null;
  // A still-suspended context accepts scheduled nodes and plays them the
  // moment resume() lands (milliseconds later on iOS) — refusing here is
  // what used to eat the first sound of every session.
  if (c.state === 'suspended') c.resume();
  window.__sfx = (window.__sfx || 0) + 1; // test hook: counts attempted plays
  return c;
}

// ---- primitives ----
// Everything below is TEXTURAL: filtered-noise transients and muted
// inharmonic partials with natural exponential decays. No raw oscillator
// beeps, no resonant filter sweeps, no arpeggios — those are what made
// the first draft sound like a 90s soundboard. Attacks are a few
// milliseconds of linear ramp (click-free), decays are setTargetAtTime
// exponentials (how real struck and blown objects actually die away).

function bus(c, t0, { peak, a = 0.004, decayAt = null, tau }) {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + a);
  g.gain.setTargetAtTime(0.0001, decayAt ?? (t0 + a), tau);
  g.connect(master);
  return g;
}

/** A filtered noise event — the palette's backbone (taps, air, swells). */
function airNoise(c, t0, { dur, type = 'bandpass', f0, f1 = null, q = 0.8, peak, a = 0.006, decayAt = null, tau }) {
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  src.playbackRate.value = 0.94 + Math.random() * 0.12; // no two events identical
  const flt = c.createBiquadFilter();
  flt.type = type;
  flt.Q.value = q;
  flt.frequency.setValueAtTime(f0, t0);
  if (f1 != null) flt.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  src.connect(flt);
  flt.connect(bus(c, t0, { peak, a, decayAt, tau }));
  src.start(t0);
  src.stop(t0 + dur + tau * 5);
}

/** A muted struck partial: sine through a lowpass, dying exponentially —
 *  stacked inharmonically it reads as glass/marimba, never as a beep. */
function struck(c, t0, { f, peak, tau, lp = 2600, a = 0.003 }) {
  const o = c.createOscillator();
  o.frequency.value = f * (0.996 + Math.random() * 0.008);
  const flt = c.createBiquadFilter();
  flt.type = 'lowpass';
  flt.frequency.value = lp;
  o.connect(flt);
  flt.connect(bus(c, t0, { peak, a, tau }));
  o.start(t0);
  o.stop(t0 + tau * 6 + 0.05);
}

/** The signature "muted glass tap": a breath of high air + two quiet
 *  inharmonic partials (1 : 2.756, a struck bar's ratio). */
function glassTap(c, t0, f = 1180, level = 1) {
  airNoise(c, t0, { dur: 0.02, type: 'highpass', f0: 3000, q: 0.7, peak: 0.05 * level, a: 0.002, tau: 0.008 });
  struck(c, t0, { f, peak: 0.12 * level, tau: 0.16, lp: 2400 });
  struck(c, t0, { f: f * 2.756, peak: 0.035 * level, tau: 0.09, lp: 5200 });
}

// ---- the sound set ----

/** Flight departure: a smooth, non-resonant swell of air that rises with
 *  the arc and settles before landing. Arrival is deliberately SILENT —
 *  a touchdown chime tested as annoying, so the swell simply fades out. */
export function flightStart(flightMs = 2500) {
  const c = gate();
  if (!c) return;
  const t = c.currentTime;
  const dur = Math.min(1.8, Math.max(0.8, flightMs / 1000 * 0.5));
  airNoise(c, t, { dur, type: 'lowpass', f0: 260, f1: 1250, q: 0.5, peak: 0.5, a: dur * 0.4, decayAt: t + dur * 0.55, tau: dur * 0.22 });
}

/** Wavelength change: a short, smooth glide of air — up toward gamma,
 *  down toward radio. Informative, never whooshy. */
export function spectrumShift(up = true) {
  const c = gate();
  if (!c) return;
  const t = c.currentTime;
  airNoise(c, t, {
    dur: 0.26, type: 'bandpass', q: 1.0,
    f0: up ? 700 : 1900, f1: up ? 1900 : 700,
    peak: 0.26, a: 0.03, decayAt: t + 0.13, tau: 0.06
  });
}

/** Layer switch: an iOS-keyboard-like tap — noise transient + tiny body. */
export function layerToggle(on = true) {
  const c = gate();
  if (!c) return;
  const t = c.currentTime;
  airNoise(c, t, { dur: 0.03, type: 'bandpass', f0: on ? 1900 : 1150, q: 1.3, peak: 0.5, a: 0.002, tau: 0.014 });
  struck(c, t, { f: on ? 235 : 185, peak: 0.05, tau: 0.03, lp: 500 });
}

/** Detail panel: a breath of air, rising open, falling closed. */
export function panelOpen() {
  const c = gate();
  if (!c) return;
  const t = c.currentTime;
  airNoise(c, t, { dur: 0.16, type: 'lowpass', f0: 500, f1: 1650, q: 0.6, peak: 0.3, a: 0.018, decayAt: t + 0.07, tau: 0.05 });
}
export function panelClose() {
  const c = gate();
  if (!c) return;
  const t = c.currentTime;
  airNoise(c, t, { dur: 0.13, type: 'lowpass', f0: 1650, f1: 500, q: 0.6, peak: 0.24, a: 0.014, decayAt: t + 0.05, tau: 0.04 });
}

/** Crosshair identification: one faint, high glass touch. */
export function cardAppear() {
  const c = gate();
  if (!c) return;
  glassTap(c, c.currentTime, 1320, 0.7);
}

/** Time-lapse: a light mechanical double-tap to engage, a single duller
 *  tap to disengage — a watch crown, not a jingle. */
export function playStart() {
  const c = gate();
  if (!c) return;
  const t = c.currentTime;
  airNoise(c, t, { dur: 0.03, type: 'bandpass', f0: 1500, q: 1.3, peak: 0.42, a: 0.002, tau: 0.013 });
  airNoise(c, t + 0.085, { dur: 0.03, type: 'bandpass', f0: 2000, q: 1.3, peak: 0.5, a: 0.002, tau: 0.013 });
  struck(c, t, { f: 210, peak: 0.05, tau: 0.035, lp: 500 });
}
export function playStop() {
  const c = gate();
  if (!c) return;
  const t = c.currentTime;
  airNoise(c, t, { dur: 0.035, type: 'bandpass', f0: 1000, q: 1.2, peak: 0.45, a: 0.002, tau: 0.016 });
  struck(c, t, { f: 165, peak: 0.05, tau: 0.04, lp: 450 });
}
