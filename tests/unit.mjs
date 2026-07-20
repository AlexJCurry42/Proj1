// Pocket Planetarium — unit tests. Dependency-free: plain Node (≥18), no
// test framework, no DOM. Run with `node tests/unit.mjs` (or `npm test`).
//
// Scope: the pure math the sky stands on — js/astro.js (sidereal time,
// coordinate transforms, rise/set), js/planets.js (the self-contained
// ephemeris, anchored to equinox/solstice ground truth), js/clock.js (the
// time scrubber's backbone), and the vendored SGP4 propagator. Modules that
// touch the DOM or the Aladin engine (ui.js, app.js, the overlay layers)
// are exercised in a real browser via the Playwright harness instead.

import { strict as assert } from 'node:assert';

import {
  D2R, R2D, normRa, wrap180, clamp01, smoothstep,
  raDecToVec, vecToRaDec, vecMix, angularSepDeg, subdivide, centroidOf,
  gmstDeg, zenithRaDec, altAzToRaDec, raDecToAltAz, riseSet
} from '../js/astro.js';
import {
  computePlanetPositions, computeSunPosition, computeMoonPosition, PLANET_LABELS
} from '../js/planets.js';
import { appNow, setAppTime, isTimeShifted, timeOffsetMs, onTimeChange } from '../js/clock.js';
import { twoline2satrec } from '../js/vendor/satellite/io.js';
import { propagate, gstime } from '../js/vendor/satellite/propagation.js';

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

const near = (a, b, tol, what = '') =>
  assert.ok(Math.abs(a - b) <= tol, `${what} expected ${a} ≈ ${b} (±${tol}), off by ${Math.abs(a - b)}`);

// Angular difference that respects the 360° wrap (RA comparisons).
const nearAngle = (a, b, tol, what = '') =>
  assert.ok(Math.abs(wrap180(a - b)) <= tol, `${what} expected ${a}° ≈ ${b}° (±${tol}°), off by ${Math.abs(wrap180(a - b))}°`);

// ------------------------------------------------------------ astro.js ---

await test('gmstDeg matches the textbook value at the J2000 epoch', () => {
  // Meeus ex. 12.a lineage: at JD 2451545.0 (2000-01-01 12:00 UT),
  // GMST = 280.46062° (the linear term's anchor point).
  near(gmstDeg(new Date('2000-01-01T12:00:00Z')), 280.46062, 0.01, 'GMST(J2000)');
});

await test('gmstDeg advances at the sidereal rate', () => {
  const t0 = new Date('2026-07-11T00:00:00Z');
  const t1 = new Date('2026-07-12T00:00:00Z');
  const advance = ((gmstDeg(t1) - gmstDeg(t0)) % 360 + 360) % 360;
  near(advance, 360.98564736629 % 360, 1e-6, 'sidereal advance per day');
});

await test('raDecToVec / vecToRaDec round-trip, including the RA seam and poles', () => {
  for (const [ra, dec] of [[0, 0], [359.9, 45], [0.1, -45], [180, 89.9], [270, -89.9], [123.456, 7.89]]) {
    const back = vecToRaDec(raDecToVec(ra, dec));
    nearAngle(back.ra, ra, 1e-9, `RA(${ra},${dec})`);
    near(back.dec, dec, 1e-9, `Dec(${ra},${dec})`);
  }
});

await test('altAzToRaDec and raDecToAltAz are inverses', () => {
  const date = new Date('2026-07-11T04:00:00Z');
  const lat = 37.77, lon = -122.42;
  for (const [alt, az] of [[90, 0], [45, 30], [10, 200], [0.5, 315], [-20, 90]]) {
    const eq = altAzToRaDec(alt, az, lat, lon, date);
    const back = raDecToAltAz(eq.ra, eq.dec, lat, lon, date);
    near(back.alt, alt, 1e-6, `alt(${alt},${az})`);
    if (Math.abs(alt) < 89) nearAngle(back.az, az, 1e-6, `az(${alt},${az})`);
  }
});

await test('the zenith is at altitude 90°', () => {
  const date = new Date('2026-01-15T20:00:00Z');
  const { ra, dec } = zenithRaDec(51.48, 0, date); // Greenwich
  near(raDecToAltAz(ra, dec, 51.48, 0, date).alt, 90, 1e-6, 'zenith altitude');
  near(dec, 51.48, 1e-9, 'zenith declination = latitude');
});

await test('riseSet: Polaris is circumpolar from mid-northern latitudes', () => {
  const rs = riseSet(37.95, 89.26, 48.85, 2.35, new Date('2026-07-11T00:00:00Z')); // from Paris
  assert.equal(rs.circumpolar, true);
  assert.equal(rs.neverRises, false);
  assert.equal(rs.rise, null);
  assert.ok(rs.altNow > 40, `Polaris altitude ≈ latitude, got ${rs.altNow}`);
});

await test('riseSet: the deep-southern sky never rises from mid-northern latitudes', () => {
  // Alpha Centauri (dec −60.8°) from London (lat 51.5°).
  const rs = riseSet(219.9, -60.83, 51.5, 0, new Date('2026-07-11T00:00:00Z'));
  assert.equal(rs.neverRises, true);
  assert.equal(rs.circumpolar, false);
  assert.ok(rs.altNow < 0, 'never-rising object is below the horizon');
});

await test('riseSet: a regular star rises and sets within one sidereal day, at the horizon', () => {
  const date = new Date('2026-07-11T06:00:00Z');
  const lat = 40.7, lon = -74.0; // New York
  const rs = riseSet(88.79, 7.41, lat, lon, date); // Betelgeuse
  assert.ok(rs.rise instanceof Date && rs.set instanceof Date && rs.transit instanceof Date);
  const day = 86400000;
  for (const [label, d] of [['rise', rs.rise], ['set', rs.set], ['transit', rs.transit]]) {
    const dt = d.getTime() - date.getTime();
    assert.ok(dt >= 0 && dt <= day, `${label} is within the next 24 h (got ${dt / 3600000} h)`);
  }
  // At the computed rise/set instants the altitude equals the refraction horizon.
  near(raDecToAltAz(88.79, 7.41, lat, lon, rs.rise).alt, -0.567, 0.01, 'altitude at rise');
  near(raDecToAltAz(88.79, 7.41, lat, lon, rs.set).alt, -0.567, 0.01, 'altitude at set');
  // At transit the altitude peaks at 90 − |lat − dec|.
  near(raDecToAltAz(88.79, 7.41, lat, lon, rs.transit).alt, rs.transitAlt, 0.01, 'altitude at transit');
  near(rs.transitAlt, 90 - Math.abs(lat - 7.41), 1e-9, 'transit altitude formula');
});

await test('riseSet: altNow agrees with raDecToAltAz', () => {
  const date = new Date('2026-03-01T22:00:00Z');
  const rs = riseSet(201.3, -11.16, 35, 139.7, date); // Spica from Tokyo
  near(rs.altNow, raDecToAltAz(201.3, -11.16, 35, 139.7, date).alt, 1e-9, 'altNow');
});

await test('small helpers: normRa, wrap180, clamp01, smoothstep, angularSepDeg', () => {
  near(normRa(-30), 330, 1e-9);
  near(normRa(725), 5, 1e-9);
  near(wrap180(350), -10, 1e-9);
  near(wrap180(-190), 170, 1e-9);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(-1), 0);
  assert.equal(smoothstep(0), 0);
  assert.equal(smoothstep(1), 1);
  near(smoothstep(0.5), 0.5, 1e-9);
  near(angularSepDeg(raDecToVec(0, 0), raDecToVec(90, 0)), 90, 1e-9);
});

await test('subdivide keeps segments under the cap; centroidOf survives the RA seam', () => {
  // A realistic constellation-figure stroke (~30°). vecMix is a normalized
  // lerp, not a true slerp (by design — it's a drawing subdivision), so
  // segments may exceed the cap by a few percent; never by a multiple.
  const line = subdivide([[10, 5], [35, 20]], 3);
  assert.ok(line.length >= 9, `subdivision added waypoints (got ${line.length} points)`);
  for (let i = 1; i < line.length; i++) {
    const sep = angularSepDeg(raDecToVec(...line[i - 1]), raDecToVec(...line[i]));
    assert.ok(sep <= 3 * 1.15, `segment ${i} spans ${sep}°`);
  }
  const c = centroidOf([[[359, 10], [1, 10]]]); // straddles RA 0
  nearAngle(c[0], 0, 0.01, 'seam centroid RA');
  near(c[1], 10, 0.1, 'seam centroid Dec');
});

// ---------------------------------------------------------- planets.js ---

await test('Sun: RA ≈ 0° at the March 2000 equinox, dec ≈ +23.44° at the June solstice', () => {
  // Equinox 2000: March 20, 07:35 UTC. Solstice 2000: June 21, 01:48 UTC.
  const eq = computeSunPosition(new Date('2000-03-20T07:35:00Z'));
  nearAngle(eq.ra, 0, 0.05, 'Sun RA at equinox');
  near(eq.dec, 0, 0.05, 'Sun dec at equinox');
  const sol = computeSunPosition(new Date('2000-06-21T01:48:00Z'));
  near(sol.dec, 23.439, 0.02, 'Sun dec at solstice');
  assert.ok(eq.distanceAu > 0.98 && eq.distanceAu < 1.02, 'Earth–Sun distance ≈ 1 AU');
});

await test('planets: all nine bodies, finite coordinates, sane geocentric distances', () => {
  const results = computePlanetPositions(new Date('2026-07-11T00:00:00Z'));
  assert.equal(results.length, 8); // 7 planets + Pluto (Earth excluded)
  const range = {
    mercury: [0.5, 1.5], venus: [0.25, 1.75], mars: [0.35, 2.7],
    jupiter: [3.9, 6.5], saturn: [8.0, 11.1], uranus: [17.2, 21.2],
    neptune: [28.8, 31.4], pluto: [28.5, 51]
  };
  for (const p of results) {
    assert.ok(PLANET_LABELS[p.body], `label exists for ${p.body}`);
    assert.ok(Number.isFinite(p.ra) && p.ra >= 0 && p.ra < 360, `${p.body} RA in range`);
    assert.ok(Number.isFinite(p.dec) && Math.abs(p.dec) <= 90, `${p.body} dec in range`);
    const [lo, hi] = range[p.body];
    assert.ok(p.distanceAu > lo && p.distanceAu < hi,
      `${p.body} geocentric distance ${p.distanceAu.toFixed(2)} AU within [${lo}, ${hi}]`);
  }
});

await test('planets sit near the ecliptic; the ephemeris is stable across its 1800–2050 span', () => {
  for (const iso of ['1850-06-01T00:00:00Z', '1990-02-11T12:00:00Z', '2049-12-31T00:00:00Z']) {
    for (const p of computePlanetPositions(new Date(iso))) {
      const cap = p.body === 'pluto' ? 41 : 32; // ecliptic pole tilt 23.4° + inclination + margin
      assert.ok(Math.abs(p.dec) < cap, `${p.body} dec ${p.dec.toFixed(1)}° at ${iso}`);
    }
  }
});

await test('Moon: distance inside the real perigee–apogee envelope, dec inside ±29.5°', () => {
  for (const iso of ['2026-01-01T00:00:00Z', '2026-07-11T00:00:00Z', '2027-03-15T18:00:00Z']) {
    const m = computeMoonPosition(new Date(iso));
    assert.ok(m.distanceKm > 356000 && m.distanceKm < 407000, `distance ${Math.round(m.distanceKm)} km at ${iso}`);
    assert.ok(Math.abs(m.dec) < 29.6, `dec ${m.dec.toFixed(1)}° at ${iso}`);
    assert.ok(Number.isFinite(m.ra) && m.ra >= 0 && m.ra < 360, `RA at ${iso}`);
  }
});

await test('Moon: moves ~13°/day against the stars (sanity of the of-date → J2000 fix)', () => {
  const a = computeMoonPosition(new Date('2026-07-11T00:00:00Z'));
  const b = computeMoonPosition(new Date('2026-07-12T00:00:00Z'));
  const sep = angularSepDeg(raDecToVec(a.ra, a.dec), raDecToVec(b.ra, b.dec));
  assert.ok(sep > 11 && sep < 15.5, `daily lunar motion ${sep.toFixed(1)}°`);
});

// ------------------------------------------------------------ clock.js ---

await test('clock: appNow tracks real time until scrubbed, then holds the offset', () => {
  assert.equal(isTimeShifted(), false);
  assert.ok(Math.abs(appNow().getTime() - Date.now()) < 50, 'unscrubbed appNow ≈ now');

  const target = new Date('2030-06-15T22:30:00Z');
  setAppTime(target);
  assert.equal(isTimeShifted(), true);
  assert.ok(Math.abs(appNow().getTime() - target.getTime()) < 50, 'scrubbed appNow ≈ target');
  assert.ok(Math.abs(timeOffsetMs() - (target.getTime() - Date.now())) < 50, 'offset math');

  setAppTime(null);
  assert.equal(isTimeShifted(), false);
  assert.ok(Math.abs(appNow().getTime() - Date.now()) < 50, 'reset restores real time');
});

await test('clock: onTimeChange fires on change, not on no-ops, and unsubscribes cleanly', () => {
  const seen = [];
  const off = onTimeChange((d, offset) => seen.push(offset));
  setAppTime(null); // already at real time: no-op, must not fire
  assert.equal(seen.length, 0);
  setAppTime(new Date(Date.now() + 3600000));
  assert.equal(seen.length, 1);
  assert.ok(Math.abs(seen[0] - 3600000) < 50, 'listener receives the offset');
  off();
  setAppTime(null);
  assert.equal(seen.length, 1, 'unsubscribed listener stays quiet');
});

// -------------------------------------------------------- vendored SGP4 ---

await test('SGP4: a real ISS TLE propagates to a low-Earth-orbit state vector', () => {
  // Historical ISS element set (epoch 2019-12-09). Values only need to be
  // self-consistent: at its own epoch the station must sit at LEO altitude
  // moving at orbital speed.
  const rec = twoline2satrec(
    '1 25544U 98067A   19343.69339541  .00001764  00000-0  40967-4 0  9997',
    '2 25544  51.6439 211.2001 0007417  17.6667  85.6398 15.50103472202482'
  );
  assert.ok(Number.isFinite(rec.jdsatepoch), 'epoch parsed');
  const epochMs = (rec.jdsatepoch - 2440587.5) * 86400000;
  const pv = propagate(rec, new Date(epochMs));
  const r = Math.hypot(pv.position.x, pv.position.y, pv.position.z);
  const v = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z);
  assert.ok(r > 6650 && r < 6810, `orbital radius ${r.toFixed(0)} km is ISS-like`);
  assert.ok(v > 7.5 && v < 7.8, `speed ${v.toFixed(2)} km/s is orbital`);
});

await test('SGP4: satellite.js gstime agrees with astro.js gmstDeg', () => {
  const date = new Date('2026-07-11T03:14:15Z');
  nearAngle(gstime(date) * R2D, gmstDeg(date), 0.01, 'two independent GMST implementations');
});

await test('constants: D2R/R2D are radians↔degrees', () => {
  near(D2R * 180, Math.PI, 1e-12);
  near(R2D * Math.PI, 180, 1e-9);
});

// ------------------------------------------- constellation determination ---
// js/constellation.js: IAU zones (Roman 1987) after J2000 → B1875
// precession. The zone table is Action-fetched; until data/ has it, only
// the precession math is testable.

const { toB1875, zoneLookup } = await import('../js/constellation.js');

await test('precession J2000→B1875: plausible shift, poles stay polar', () => {
  // General precession is ~1.74° along the ecliptic over 125 years: an
  // equatorial point's RA must shift west by roughly that much.
  const eq = toB1875(180, 0);
  near(eq.raH * 15, 180 - 1.74, 0.35, 'equatorial RA shift');
  // The J2000 celestial pole sits ~0.35°/25yr from the 1875 pole — well
  // under 2° away, and never flips hemisphere.
  const pole = toB1875(0, 90);
  assert.ok(pole.dec > 88 && pole.dec <= 90, `pole dec ${pole.dec}`);
});

await test('constellation zones: famous objects land in the right constellation', async () => {
  const { existsSync, readFileSync } = await import('node:fs');
  const path = new URL('../data/constellation_zones.json', import.meta.url);
  if (!existsSync(path)) {
    console.log('      (data/constellation_zones.json not fetched yet — Action-generated; skipping lookups)');
    return;
  }
  const zones = JSON.parse(readFileSync(path)).zones;
  assert.ok(zones.length > 300, `${zones.length} zones`);
  const expect = [
    [101.287, -16.716, 'Canis Major'],   // Sirius
    [37.955, 89.264, 'Ursa Minor'],      // Polaris
    [10.685, 41.269, 'Andromeda'],       // M31
    [88.793, 7.407, 'Orion'],            // Betelgeuse
    [219.902, -60.834, 'Centaurus'],     // alpha Cen
    [83.633, 22.015, 'Taurus'],          // Crab Nebula
    [316.0, -88.0, 'Octans'],            // deep south
    [266.417, -29.008, 'Sagittarius']    // Sgr A*
  ];
  for (const [ra, dec, want] of expect) {
    const got = zoneLookup(zones, ra, dec);
    assert.equal(got, want, `(${ra}, ${dec}) → ${got}, expected ${want}`);
  }
});

await test('object names: one canonical spelling across every lookup', async () => {
  const { normalizeName, matchKeysFor } = await import('../js/objnames.js');
  // Designations collapse to one form no matter how they arrive.
  assert.equal(normalizeName('M 31'), 'm31');
  assert.equal(normalizeName('Messier 31'), 'm31');
  assert.equal(normalizeName('NGC104'), 'ngc 104');
  assert.equal(normalizeName('IC434'), 'ic 434');
  assert.equal(normalizeName('NAME Andromeda Galaxy'), 'andromeda galaxy');
  assert.equal(normalizeName('V* V645 Cen'), 'v645 cen');
  // tools/fetch_descriptions.py mirrors these rules when writing lookup
  // keys — this block is the JS half of that contract.
  const keys = matchKeysFor('NGC 7293 — Helix Nebula', ['Ring Nebula (M57)']);
  for (const want of ['ngc 7293', 'helix nebula', 'm57', 'ring nebula']) {
    assert.ok(keys.includes(want), `compound labels must yield "${want}" (got ${keys.join(', ')})`);
  }
});

await test('DESI cosmic-web binary: parser unpacks and rejects correctly', async () => {
  const { parseDesiWeb, DESI_HEADER_BYTES, DESI_RECORD_BYTES } = await import('../js/desidata.js');
  // Build a two-point file exactly as tools/fetch_desi_web.py packs it.
  const scale = 0.21;
  const buf = new ArrayBuffer(DESI_HEADER_BYTES + 2 * DESI_RECORD_BYTES);
  const dv = new DataView(buf);
  [..."DSW1"].forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint32(4, 2, true);
  dv.setFloat32(8, scale, true);
  dv.setInt16(12, 1000, true); dv.setInt16(14, -2000, true); dv.setInt16(16, 30000, true); dv.setUint8(18, 0);
  dv.setInt16(20, -1, true); dv.setInt16(22, 0, true); dv.setInt16(24, 1, true); dv.setUint8(26, 1);
  const d = parseDesiWeb(buf);
  assert.equal(d.count, 2);
  near(d.xyz[0], 1000 * scale, 0.01, 'x0');
  near(d.xyz[1], -2000 * scale, 0.01, 'y0');
  near(d.xyz[2], 30000 * scale, 0.5, 'z0');
  assert.equal(d.type[0], 0);
  assert.equal(d.type[1], 1);
  // Malformed inputs must throw, never mis-render: wrong magic, wrong length.
  dv.setUint8(0, 88); // 'X'
  assert.throws(() => parseDesiWeb(buf), /magic/);
  dv.setUint8(0, 'D'.charCodeAt(0));
  dv.setUint32(4, 3, true); // claims more points than the buffer holds
  assert.throws(() => parseDesiWeb(buf), /length/);
});

await test('version consistency: sw.js VERSION and js/version.js SHELL_VERSION match', async () => {
  // The two constants are hand-synced (a worker script can't import an ES
  // module); this test is the drift guard — CI fails any commit that bumps
  // one without the other.
  const { readFileSync } = await import('node:fs');
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const ver = readFileSync(new URL('../js/version.js', import.meta.url), 'utf8');
  const swV = sw.match(/VERSION = 'dsa-shell-(v\d+)'/)?.[1];
  const shellV = ver.match(/SHELL_VERSION = '(v\d+)'/)?.[1];
  assert.ok(swV && shellV, 'both version constants must be present and well-formed');
  assert.equal(swV, shellV, `sw.js is ${swV} but js/version.js is ${shellV}`);
});

// ------------------------------------------------------------- summary ---

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  process.exitCode = 1;
}
