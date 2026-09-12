// Project Planetarium — local preferences. All persistence in the app flows
// through here: one namespace ('dsa-'), one JSON codec, one try/catch
// (private-mode Safari throws on any storage access).

export function readPref(key, fallback) {
  try {
    const v = localStorage.getItem('dsa-' + key);
    return v == null ? fallback : JSON.parse(v);
  } catch (err) { return fallback; }
}

export function writePref(key, value) {
  try { localStorage.setItem('dsa-' + key, JSON.stringify(value)); } catch (err) { /* private mode */ }
}
