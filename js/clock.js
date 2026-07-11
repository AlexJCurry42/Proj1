// Pocket Planetarium — the app clock. One shared answer to "what time is it
// in the app?": normally real time, but the time scrubber can shift it, and
// every time-dependent layer (Solar System, horizon, satellites, Sky Now)
// asks THIS module instead of `new Date()` so the whole sky moves together.
//
// The offset model (rather than a frozen Date) keeps a scrubbed clock
// ticking: "tonight at 23:00" set five real minutes ago reads 23:05.

let offsetMs = 0;
const subs = new Set();

/** The current app time — real time plus the scrubbed offset. */
export function appNow() {
  return new Date(Date.now() + offsetMs);
}

export function timeOffsetMs() {
  return offsetMs;
}

export function isTimeShifted() {
  return offsetMs !== 0;
}

/**
 * Scrub the app clock to a Date, or back to real time with `null`.
 * Subscribers fire only on an actual change.
 */
export function setAppTime(dateOrNull) {
  const next = dateOrNull ? dateOrNull.getTime() - Date.now() : 0;
  if (next === offsetMs) return;
  offsetMs = next;
  for (const fn of subs) {
    try { fn(appNow(), offsetMs); } catch (err) { /* one bad listener must not block the rest */ }
  }
}

/** Subscribe to clock scrubs; returns an unsubscribe function. */
export function onTimeChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
