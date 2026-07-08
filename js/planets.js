// Deep Sky Atlas — Solar System planet positions.
//
// Self-contained implementation of the JPL "Keplerian Elements for Approximate
// Positions of the Major Planets" low-precision formulae (Standish 1800-2050 AD
// table, as also reproduced in Meeus, "Astronomical Algorithms"). Accuracy is a
// few arcminutes over 1800-2050, which is more than sufficient for plotting
// planet markers on a sky atlas. No external ephemeris service is used.

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// a (AU), e, I (deg), L (deg), long.peri (deg), long.node (deg) at J2000,
// and their linear rates per Julian century.
const ELEMENTS = {
  mercury: {
    a: [0.38709927, 0.00000037], e: [0.20563593, 0.00001906], I: [7.00497902, -0.00594749],
    L: [252.25032350, 149472.67411175], peri: [77.45779628, 0.16047689], node: [48.33076593, -0.12534081]
  },
  venus: {
    a: [0.72333566, 0.00000390], e: [0.00677672, -0.00004107], I: [3.39467605, -0.00078890],
    L: [181.97909950, 58517.81538729], peri: [131.60246718, 0.00268329], node: [76.67984255, -0.27769418]
  },
  earth: {
    a: [1.00000261, 0.00000562], e: [0.01671123, -0.00004392], I: [-0.00001531, -0.01294668],
    L: [100.46457166, 35999.37244981], peri: [102.93768193, 0.32327364], node: [0.0, 0.0]
  },
  mars: {
    a: [1.52371034, 0.00001847], e: [0.09339410, 0.00007882], I: [1.84969142, -0.00813131],
    L: [-4.55343205, 19140.30268499], peri: [-23.94362959, 0.44441088], node: [49.55953891, -0.29257343]
  },
  jupiter: {
    a: [5.20288700, -0.00011607], e: [0.04838624, -0.00013253], I: [1.30439695, -0.00183714],
    L: [34.39644051, 3034.74612775], peri: [14.72847983, 0.21252668], node: [100.47390909, 0.20469106]
  },
  saturn: {
    a: [9.53667594, -0.00125060], e: [0.05386179, -0.00050991], I: [2.48599187, 0.00193609],
    L: [49.95424423, 1222.49362201], peri: [92.59887831, -0.41897216], node: [113.66242448, -0.28867794]
  },
  uranus: {
    a: [19.18916464, -0.00196176], e: [0.04725744, -0.00004397], I: [0.77263783, -0.00242939],
    L: [313.23810451, 428.48202785], peri: [170.95427630, 0.40805281], node: [74.01692503, 0.04240589]
  },
  neptune: {
    a: [30.06992276, 0.00026291], e: [0.00859048, 0.00005105], I: [1.77004347, 0.00035372],
    L: [-55.12002969, 218.45945325], peri: [44.96476227, -0.32241464], node: [131.78422574, -0.00508664]
  },
  pluto: {
    a: [39.48211675, -0.00031596], e: [0.24882730, 0.00005170], I: [17.14001206, 0.00004818],
    L: [238.92903833, 145.20780515], peri: [224.06891629, -0.04062942], node: [110.30393684, -0.01183482]
  }
};

const OBLIQUITY_J2000_DEG = 23.43929111;

function normalizeDeg(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// Julian centuries since J2000.0 (JD 2451545.0) for a JS Date.
function centuriesSinceJ2000(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  return (jd - 2451545.0) / 36525;
}

// Heliocentric ecliptic rectangular coordinates (AU, J2000 ecliptic frame) for one body.
function heliocentricEcliptic(body, T) {
  const el = ELEMENTS[body];
  const a = el.a[0] + el.a[1] * T;
  const e = el.e[0] + el.e[1] * T;
  const I = el.I[0] + el.I[1] * T;
  const L = el.L[0] + el.L[1] * T;
  const longPeri = el.peri[0] + el.peri[1] * T;
  const longNode = el.node[0] + el.node[1] * T;

  const argPeri = longPeri - longNode;
  const M = normalizeDeg(L - longPeri);

  // Solve Kepler's equation M = E - e* sin(E) (degrees) by Newton-Raphson.
  const eStar = e * RAD2DEG;
  let E = M + eStar * Math.sin(M * DEG2RAD);
  for (let i = 0; i < 8; i++) {
    const dM = M - (E - eStar * Math.sin(E * DEG2RAD));
    const dE = dM / (1 - e * Math.cos(E * DEG2RAD));
    E += dE;
    if (Math.abs(dE) < 1e-7) break;
  }

  // Position in the orbital plane.
  const xPrime = a * (Math.cos(E * DEG2RAD) - e);
  const yPrime = a * Math.sqrt(1 - e * e) * Math.sin(E * DEG2RAD);

  // Rotate by argument of perihelion, inclination, and longitude of ascending node
  // into the J2000 ecliptic frame.
  const cosArg = Math.cos(argPeri * DEG2RAD), sinArg = Math.sin(argPeri * DEG2RAD);
  const cosI = Math.cos(I * DEG2RAD), sinI = Math.sin(I * DEG2RAD);
  const cosNode = Math.cos(longNode * DEG2RAD), sinNode = Math.sin(longNode * DEG2RAD);

  const xOrb = cosArg * xPrime - sinArg * yPrime;
  const yOrb = sinArg * xPrime + cosArg * yPrime;

  const x = (cosNode * xOrb - sinNode * yOrb * cosI);
  const y = (sinNode * xOrb + cosNode * yOrb * cosI);
  const z = (yOrb * sinI);

  return { x, y, z };
}

// Convert J2000 ecliptic rectangular coords to equatorial RA/Dec (degrees).
function eclipticToEquatorial(x, y, z) {
  const eps = OBLIQUITY_J2000_DEG * DEG2RAD;
  const yEq = y * Math.cos(eps) - z * Math.sin(eps);
  const zEq = y * Math.sin(eps) + z * Math.cos(eps);
  let ra = Math.atan2(yEq, x) * RAD2DEG;
  if (ra < 0) ra += 360;
  const dec = Math.atan2(zEq, Math.sqrt(x * x + yEq * yEq)) * RAD2DEG;
  return { ra, dec };
}

/**
 * Compute geocentric apparent RA/Dec (ICRS-ish, J2000 equatorial, no light-time
 * or aberration correction — adequate to a few arcminutes) for all 8 planets
 * plus Pluto, at the given Date (defaults to now).
 */
export function computePlanetPositions(date = new Date()) {
  const T = centuriesSinceJ2000(date);
  const earth = heliocentricEcliptic('earth', T);

  const results = [];
  for (const body of Object.keys(ELEMENTS)) {
    if (body === 'earth') continue;
    const helio = heliocentricEcliptic(body, T);
    // Geocentric = heliocentric(planet) - heliocentric(Earth)
    const gx = helio.x - earth.x;
    const gy = helio.y - earth.y;
    const gz = helio.z - earth.z;
    const { ra, dec } = eclipticToEquatorial(gx, gy, gz);
    const distanceAu = Math.sqrt(gx * gx + gy * gy + gz * gz);
    results.push({ body, ra, dec, distanceAu });
  }
  return results;
}

export const PLANET_LABELS = {
  mercury: 'Mercury', venus: 'Venus', mars: 'Mars', jupiter: 'Jupiter',
  saturn: 'Saturn', uranus: 'Uranus', neptune: 'Neptune', pluto: 'Pluto'
};
