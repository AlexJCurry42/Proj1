// Project Planetarium — the app clock. One shared answer to "what time is it
// in the app?": normally real time, but the time scrubber can shift it, and
// every time-dependent layer (Solar System, horizon, satellites, Sky Now)
// asks THIS module instead of `new Date()` so the whole sky moves together.
//
// The offset model (rather than a frozen Date) keeps a scrubbed clock
// ticking: "tonight at 23:00" set five real minutes ago reads 23:05.

let offsetMs = 0;
let extraRate = 0;   // play speed minus 1; the offset accrues at this rate.
                     // At exactly 1× it is 0: real-time playback needs NO
                     // accrual at all — the clock advances because real time
                     // does, which is what makes 1× motion exact.
let nominalMult = 0; // 0 = stopped; ≥ 1 = playing at that × real time
let rateAnchor = 0;
let ticker = null;
const subs = new Set();

// While playing, the offset grows continuously; fold the growth in lazily so
// every read — appNow, timeOffsetMs — sees the exact current moment.
function accrue() {
  if (extraRate === 0) return;
  const real = Date.now();
  offsetMs += (real - rateAnchor) * extraRate;
  rateAnchor = real;
}

function notify() {
  for (const fn of subs) {
    try { fn(appNow(), offsetMs); } catch (err) { /* one bad listener must not block the rest */ }
  }
}

/** The current app time — real time plus the scrubbed offset. */
export function appNow() {
  accrue();
  return new Date(Date.now() + offsetMs);
}

export function timeOffsetMs() {
  accrue();
  return offsetMs;
}

export function isTimeShifted() {
  accrue();
  return offsetMs !== 0 || extraRate !== 0;
}

/**
 * Scrub the app clock to a Date, or back to real time with `null`.
 * Stops any running playback. Subscribers fire only on an actual change.
 */
export function setAppTime(dateOrNull) {
  accrue();
  const wasPlaying = nominalMult !== 0;
  if (wasPlaying) {
    // Stop SILENTLY — setPlaySpeed would notify with the pre-scrub time,
    // making every subscriber do one round of stale work (planetslayer's
    // throttle then rendered the OLD moment and queued the real one ~1 s).
    // One notify below broadcasts the stop and the new offset together.
    nominalMult = 0;
    extraRate = 0;
    rateAnchor = Date.now();
    clearInterval(ticker);
    ticker = null;
  }
  const next = dateOrNull ? dateOrNull.getTime() - Date.now() : 0;
  if (next === offsetMs && !wasPlaying) return;
  offsetMs = next;
  notify();
}

/**
 * Time-lapse playback: run the app clock at `mult`× real time (3600 = one
 * hour per second; 1 = exactly real time — a real playing state, with the
 * offset frozen so accuracy is by construction, not by arithmetic).
 * Anything below 1 stops playback and freezes the offset where it is.
 * While playing, subscribers are ticked twice a second so layers follow.
 */
export function setPlaySpeed(mult) {
  accrue();
  nominalMult = mult >= 1 ? mult : 0;
  extraRate = mult > 1 ? mult - 1 : 0;
  rateAnchor = Date.now();
  clearInterval(ticker);
  ticker = null;
  // Tick period scales with speed: 500 ms at fast-lapse (the Moon visibly
  // races), stretching to 5 s at exactly 1× — where the sky moves 0.004°/s
  // and 2 Hz subscriber fan-out (catalog rebuilds, chip re-renders) was
  // pure waste. The planetarium camera is unaffected: it runs its own
  // per-frame loop, kicked by the immediate notify below.
  if (nominalMult !== 0) ticker = setInterval(notify, Math.min(5000, Math.max(500, 30000 / nominalMult)));
  notify();
}

export function playSpeed() {
  return nominalMult;
}

/** Subscribe to clock scrubs; returns an unsubscribe function. */
export function onTimeChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
