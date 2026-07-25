// Project Planetarium — the Solar System marker layer: Sun, Moon and planets
// as engine catalogs, positions from the self-contained ephemeris
// (js/planets.js). Positions are computed for the app clock's current
// moment and rebuilt whenever the time scrubber moves or plays (throttled:
// a rebuild tears down and re-adds engine sources, so playback rebuilds at
// ~1 Hz, not on every 500 ms clock tick).

import { computePlanetPositions, computeSunPosition, computeMoonPosition, PLANET_LABELS } from './planets.js';
import { makePlanetIcon, makeGlowDot } from './markers.js';
import { appNow, onTimeChange } from './clock.js';

export async function initPlanetsLayer(aladin) {
  const catPlanets = A.catalog({
    name: 'Solar System planets',
    shape: makePlanetIcon('#7fd6ff', 18),
    sourceSize: 18,
    displayLabel: true,
    labelColumn: 'name',
    labelColor: 'rgba(220, 235, 255, 0.85)',
    labelFont: '11px -apple-system, sans-serif',
    onClick: null
  });
  const catSun = A.catalog({
    name: 'Sun',
    shape: makeGlowDot('#ffd60a', 28),
    sourceSize: 28,
    displayLabel: true,
    labelColumn: 'name',
    labelColor: 'rgba(255, 224, 130, 0.9)',
    labelFont: '11px -apple-system, sans-serif',
    onClick: null
  });
  const catMoon = A.catalog({
    name: 'Moon',
    shape: makePlanetIcon('#d9d9de', 18),
    sourceSize: 18,
    displayLabel: true,
    labelColumn: 'name',
    labelColor: 'rgba(225, 225, 235, 0.85)',
    labelFont: '11px -apple-system, sans-serif',
    onClick: null
  });

  const EPHEMERIS_NOTE = 'Computed client-side for the time shown above (the clock button scrubs it). Validated against a VSOP87-class ephemeris: typically within 1′ (Saturn up to ~9′), 1800–2050.';
  const EPHEMERIS_SOURCE = 'Self-contained ephemeris (see js/planets.js); JPL approximate elements / Astronomical Almanac low-precision formulae.';

  function build() {
    for (const c of [catPlanets, catSun, catMoon]) {
      if (typeof c.removeAll === 'function') c.removeAll();
    }
    const now = appNow();
    catPlanets.addSources(computePlanetPositions(now).map(p => A.source(p.ra, p.dec, {
      name: PLANET_LABELS[p.body],
      _detail: {
        name: PLANET_LABELS[p.body],
        typeLabel: 'Solar System planet',
        ra: p.ra,
        dec: p.dec,
        distanceText: `${p.distanceAu.toFixed(3)} AU from Earth (at the time shown)`,
        extraRows: [['Position computed', now.toUTCString()]],
        approxNote: EPHEMERIS_NOTE,
        source: EPHEMERIS_SOURCE
      }
    })));
    const sun = computeSunPosition(now);
    catSun.addSources([A.source(sun.ra, sun.dec, {
      name: 'Sun',
      _detail: {
        name: 'The Sun',
        typeLabel: 'G-type main-sequence star',
        ra: sun.ra,
        dec: sun.dec,
        distanceText: `${sun.distanceAu.toFixed(4)} AU from Earth (at the time shown)`,
        extraRows: [['Position computed', now.toUTCString()]],
        approxNote: EPHEMERIS_NOTE,
        source: EPHEMERIS_SOURCE
      }
    })]);
    const moon = computeMoonPosition(now);
    catMoon.addSources([A.source(moon.ra, moon.dec, {
      name: 'Moon',
      _detail: {
        name: 'The Moon',
        typeLabel: "Earth's natural satellite",
        ra: moon.ra,
        dec: moon.dec,
        distanceText: `${Math.round(moon.distanceKm).toLocaleString()} km from Earth's center (at the time shown)`,
        extraRows: [['Position computed', now.toUTCString()]],
        approxNote: 'Geocentric position from the Astronomical Almanac lunar formulae, computed for the time shown (validated: typically ~5′). From your location on Earth’s surface the Moon can appear up to ~1° away from this point (parallax).',
        source: EPHEMERIS_SOURCE
      }
    })]);
  }

  // Build once for launch; rebuild when the clock scrubs or plays —
  // throttled to ~1 Hz so playback doesn't churn engine catalogs.
  build();
  let lastBuild = 0;
  let queued = false;
  onTimeChange(() => {
    const t = performance.now();
    if (t - lastBuild > 900) {
      lastBuild = t;
      build();
    } else if (!queued) {
      queued = true;
      setTimeout(() => { queued = false; lastBuild = performance.now(); build(); }, 950);
    }
  });
  for (const c of [catPlanets, catSun, catMoon]) aladin.addCatalog(c);
  return { catalogs: [catPlanets, catSun, catMoon], count: 11 };
}
