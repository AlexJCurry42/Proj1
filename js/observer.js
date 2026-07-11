// Pocket Planetarium — the observer's location, shared by every feature that
// needs it (horizon overlay, satellites, Sky Now, gyro tracking). One
// permission flow, one per-session cache; coordinates are consumed entirely
// on-device and never transmitted anywhere.

let cache = null;

/** One-shot geolocation as a promise; cached for the session. */
export function requestObserver() {
  if (cache) return Promise.resolve(cache);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('no geolocation on this browser')); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        cache = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        resolve(cache);
      },
      (e) => reject(new Error(e.message)),
      { timeout: 10000, maximumAge: 300000 }
    );
  });
}

/** Adopt coordinates obtained elsewhere (e.g. the gyro tracker's fix). */
export function seedObserver(lat, lon) {
  cache = { lat, lon };
  return cache;
}

export function cachedObserver() { return cache; }
