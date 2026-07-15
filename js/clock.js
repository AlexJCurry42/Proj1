// Pocket Planetarium — the app clock. One shared answer to "what time is it
// in the app?": normally real time, but the time scrubber can shift it, and
// every time-dependent layer (Solar System, horizon, satellites, Sky Now)
// asks THIS module instead of `new Date()` so the whole sky moves together.
//
// The offset model (rather than a frozen Date) keeps a scrubbed clock
// ticking: "tonight at 23:00" set five real minutes ago reads 23:05.

let offsetMs = 0;
let extraRate = 0;   // play speed minus 1 (0 = not playing); offset accrues at this rate
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
  const wasPlaying = extraRate !== 0;
  if (wasPlaying) setPlaySpeed(0);
  const next = dateOrNull ? dateOrNull.getTime() - Date.now() : 0;
  if (next === offsetMs && !wasPlaying) return;
  offsetMs = next;
  notify();
}

/**
 * Time-lapse playback: run the app clock at `mult`× real time (e.g. 3600 =
 * one hour per second). 0 or 1 stops playback and freezes the offset where
 * it is. While playing, subscribers are ticked twice a second so layers
 * follow along.
 */
export function setPlaySpeed(mult) {
  accrue();
  extraRate = mult > 1 ? mult - 1 : 0;
  rateAnchor = Date.now();
  clearInterval(ticker);
  ticker = null;
  if (extraRate !== 0) ticker = setInterval(notify, 500);
  notify();
}

export function playSpeed() {
  return extraRate === 0 ? 0 : extraRate + 1;
}

/** Subscribe to clock scrubs; returns an unsubscribe function. */
export function onTimeChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
