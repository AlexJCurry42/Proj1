// Pocket Planetarium — shared spherical-astronomy math. One home for the
// unit-vector helpers, coordinate transforms and sidereal time that the
// sky-side modules (constellations, horizon, satellites, gyro tracking)
// previously each carried their own copies of.

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export const normRa = (ra) => ((ra % 360) + 360) % 360;
export const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;
export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const smoothstep = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };

// ---- celestial unit vectors (seamless across the RA wrap and poles) ----
export function raDecToVec(raDeg, decDeg) {
  const r = raDeg * D2R, d = decDeg * D2R, cd = Math.cos(d);
  return [cd * Math.cos(r), cd * Math.sin(r), Math.sin(d)];
}

export function vecToRaDec(v) {
  let ra = Math.atan2(v[1], v[0]) * R2D;
  if (ra < 0) ra += 360;
  return { ra, dec: Math.asin(Math.max(-1, Math.min(1, v[2]))) * R2D };
}

/** Normalized linear mix of two unit vectors (cheap slerp substitute). */
export function vecMix(a, b, k) {
  const x = a[0] + (b[0] - a[0]) * k, y = a[1] + (b[1] - a[1]) * k, z = a[2] + (b[2] - a[2]) * k;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

export function angularSepDeg(a, b) {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(dot) * R2D;
}

/** Insert great-circle waypoints so no drawn segment spans more than maxDeg. */
export function subdivide(line, maxDeg = 3) {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = raDecToVec(line[i - 1][0], line[i - 1][1]);
    const b = raDecToVec(line[i][0], line[i][1]);
    const n = Math.ceil(angularSepDeg(a, b) / maxDeg);
    for (let k = 1; k < n; k++) {
      const m = vecMix(a, b, k / n);
      const { ra, dec } = vecToRaDec(m);
      out.push([ra, dec]);
    }
    out.push(line[i]);
  }
  return out;
}

/** Spherical centroid of a set of [ra, dec] polylines — RA-seam safe. */
export function centroidOf(lines) {
  let x = 0, y = 0, z = 0, n = 0;
  for (const line of lines) {
    for (const [ra, dec] of line) {
      const v = raDecToVec(ra, dec);
      x += v[0]; y += v[1]; z += v[2]; n++;
    }
  }
  if (!n) return null;
  let ra = Math.atan2(y, x) * R2D;
  if (ra < 0) ra += 360;
  return [ra, Math.atan2(z, Math.hypot(x, y)) * R2D];
}

// ---- time & frames ----

/** Greenwich mean sidereal time in degrees (Meeus eq. 12.4, linear term). */
export function gmstDeg(date = new Date()) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const d = jd - 2451545.0;
  const gmst = (280.46061837 + 360.98564736629 * d) % 360;
  return gmst < 0 ? gmst + 360 : gmst;
}

/** Zenith equatorial coordinates: RA = local sidereal time, Dec = latitude. */
export function zenithRaDec(latDeg, lonEastDeg, date = new Date()) {
  const lst = normRa(gmstDeg(date) + lonEastDeg);
  return { ra: lst, dec: Math.max(-90, Math.min(90, latDeg)) };
}

/** Horizontal (alt/az) → equatorial (RA/Dec) for an observer, now. */
export function altAzToRaDec(altDeg, azDeg, latDeg, lonEastDeg, date = new Date()) {
  const alt = altDeg * D2R, az = azDeg * D2R, lat = latDeg * D2R;
  const sinDec = Math.sin(alt) * Math.sin(lat) + Math.cos(alt) * Math.cos(lat) * Math.cos(az);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec))) * R2D;
  const haDeg = Math.atan2(
    -Math.sin(az) * Math.cos(alt),
    Math.sin(alt) * Math.cos(lat) - Math.cos(alt) * Math.sin(lat) * Math.cos(az)
  ) * R2D;
  const lst = gmstDeg(date) + lonEastDeg;
  return { ra: normRa(lst - haDeg), dec };
}

/** Equatorial (RA/Dec) → horizontal (alt/az) for an observer — the inverse. */
export function raDecToAltAz(raDeg, decDeg, latDeg, lonEastDeg, date = new Date()) {
  const H = (gmstDeg(date) + lonEastDeg - raDeg) * D2R; // hour angle
  const dec = decDeg * D2R, lat = latDeg * D2R;
  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * R2D;
  let az = Math.atan2(
    -Math.sin(H) * Math.cos(dec),
    Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(H)
  ) * R2D;
  if (az < 0) az += 360;
  return { alt, az };
}

// Earth's rotation against the stars: sidereal degrees of hour angle per ms.
const SIDEREAL_DEG_PER_MS = 360.98564736629 / 86400000;

/**
 * Rise, transit and set for a fixed point on the celestial sphere, seen by an
 * observer. Solves the hour angle H₀ where the object crosses the effective
 * horizon (default −0.567°: standard atmospheric refraction), then converts
 * hour angles to the NEXT clock times at the sidereal rate.
 *
 * Returns { altNow, transitAlt, circumpolar, neverRises, rise, set, transit }
 * — rise/set are Dates (null when circumpolar or never up); transit is the
 * next upper culmination. Solar System bodies drift in RA/Dec, so for them
 * the times are approximate (fine for planets; the Moon can be off ~½ h).
 */
export function riseSet(raDeg, decDeg, latDeg, lonEastDeg, date = new Date(), horizonAltDeg = -0.567) {
  const lat = latDeg * D2R, dec = decDeg * D2R;
  const altNow = raDecToAltAz(raDeg, decDeg, latDeg, lonEastDeg, date).alt;
  const transitAlt = 90 - Math.abs(latDeg - decDeg);
  const haNow = wrap180(gmstDeg(date) + lonEastDeg - raDeg);
  const nextAtHa = (haDeg) =>
    new Date(date.getTime() + (((haDeg - haNow) % 360 + 360) % 360) / SIDEREAL_DEG_PER_MS);
  const cosH0 = (Math.sin(horizonAltDeg * D2R) - Math.sin(lat) * Math.sin(dec)) /
    (Math.cos(lat) * Math.cos(dec));
  if (cosH0 < -1) {
    return { altNow, transitAlt, circumpolar: true, neverRises: false, rise: null, set: null, transit: nextAtHa(0) };
  }
  if (cosH0 > 1) {
    return { altNow, transitAlt, circumpolar: false, neverRises: true, rise: null, set: null, transit: nextAtHa(0) };
  }
  const h0 = Math.acos(cosH0) * R2D;
  return {
    altNow, transitAlt, circumpolar: false, neverRises: false,
    rise: nextAtHa(-h0), set: nextAtHa(h0), transit: nextAtHa(0)
  };
}
