// Pocket Planetarium — the observer's location, shared by every feature that
// needs it (horizon overlay, satellites, Sky Now, gyro tracking). One
// permission flow, one per-session cache; coordinates are consumed entirely
// on-device and never transmitted anywhere.

let cache = null;
const subs = new Set();

function notify() {
  for (const fn of subs) {
    try { fn(cache); } catch (err) { /* one bad listener must not block the rest */ }
  }
}

/** One-shot geolocation as a promise; cached for the session. */
export function requestObserver() {
  if (cache) return Promise.resolve(cache);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('no geolocation on this browser')); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        cache = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        notify();
        resolve(cache);
      },
      (e) => reject(new Error(e.message)),
      { timeout: 10000, maximumAge: 300000 }
    );
  });
}

/** Adopt coordinates obtained elsewhere (e.g. the gyro tracker's fix). */
export function seedObserver(lat, lon) {
  const had = !!cache;
  cache = { lat, lon };
  if (!had) notify();
  return cache;
}

export function cachedObserver() { return cache; }

/**
 * Run `fn(observer)` once coordinates first become available (immediately if
 * they already are). Lets location-dependent extras — like the ISS marker in
 * the Solar System layer — light up the moment ANY feature obtains a fix,
 * without ever prompting on their own.
 */
export function onObserver(fn) {
  subs.add(fn);
  if (cache) { try { fn(cache); } catch (err) { /* listener error */ } }
  return () => subs.delete(fn);
}
