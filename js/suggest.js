// Project Planetarium — instant search suggestions from the app's own curated
// datasets (no network round-trip): planets + Sun/Moon, Messier/NGC objects,
// black holes, famous stars/exoplanets, and tour stops. Sesame still
// handles anything not in the index.

import { fetchJSON } from './net.js';
import { computePlanetPositions, computeSunPosition, computeMoonPosition, PLANET_LABELS } from './planets.js';

let indexPromise = null;

async function build() {
  const [messier, stellar, sm, tours, renders] = await Promise.all([
    fetchJSON('data/messier_ngc.json').catch(() => null),
    fetchJSON('data/blackholes_stellar.json').catch(() => null),
    fetchJSON('data/blackholes_supermassive.json').catch(() => null),
    fetchJSON('data/tours.json').catch(() => null),
    fetchJSON('data/renders.json').catch(() => null)
  ]);

  const entries = [];
  const add = (name, ra, dec, typeLabel, opts = {}) => {
    if (!name || (!opts.dynamic && !(Number.isFinite(ra) && Number.isFinite(dec)))) return;
    // Merge alias keys carefully: the object's own name must always be a key
    // (a plain spread of opts would clobber the merged list).
    const { keys: extraKeys = [], ...rest } = opts;
    entries.push({ name, ra, dec, typeLabel, ...rest, keys: [name.toLowerCase(), ...extraKeys.map(k => k.toLowerCase())] });
  };

  // Solar System: positions computed fresh at selection time.
  add('The Sun', null, null, 'Star — our own', { dynamic: 'sun', fov: 2 });
  add('The Moon', null, null, "Earth's natural satellite", { dynamic: 'moon', fov: 2, keys: ['moon', 'luna'] });
  for (const body of Object.keys(PLANET_LABELS)) {
    add(PLANET_LABELS[body], null, null, 'Solar System planet', { dynamic: body, fov: 1 });
  }

  if (messier) {
    for (const o of [...messier.messier, ...messier.ngc_ic]) {
      add(o.name, o.ra, o.dec, 'Deep-sky object', { fov: 1, keys: o.name !== o.id ? [o.id.toLowerCase()] : [] });
    }
  }
  if (stellar) for (const o of stellar.objects) {
    add(o.name, o.ra, o.dec, 'Stellar-mass black hole', { fov: 0.5, keys: (o.aliases || []).map(a => a.toLowerCase()) });
  }
  if (sm) for (const o of sm.objects) {
    add(o.name, o.ra, o.dec, 'Supermassive black hole', { fov: 0.5, keys: (o.aliases || []).map(a => a.toLowerCase()) });
  }
  if (tours) for (const t of tours.destinations) {
    add(t.name, t.ra, t.dec, 'Tour destination', { fov: t.fov_deg });
  }
  if (renders) for (const e of renders.entries) {
    // Famous stars/exoplanets have no coordinates in renders.json; they are
    // still searchable via Sesame, so only index entries we can fly to.
    void e;
  }

  return entries;
}

export function getSuggestionIndex() {
  indexPromise ??= build();
  return indexPromise;
}

/** Ranked prefix/substring match over names and aliases. */
export async function querySuggestions(q, max = 7) {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  const entries = await getSuggestionIndex();
  const starts = [], contains = [], seen = new Set();
  for (const e of entries) {
    const nameKey = e.name.toLowerCase();
    if (seen.has(nameKey)) continue; // e.g. Cygnus X-1 is both a BH and a tour stop
    if (e.keys.some(k => k.startsWith(needle))) { starts.push(e); seen.add(nameKey); }
    else if (e.keys.some(k => k.includes(needle))) { contains.push(e); seen.add(nameKey); }
    if (starts.length >= max) break;
  }
  return [...starts, ...contains].slice(0, max);
}

/** Resolve a suggestion to current coordinates (Solar System moves). */
export function suggestionCoords(s) {
  if (!s.dynamic) return { ra: s.ra, dec: s.dec };
  if (s.dynamic === 'sun') { const p = computeSunPosition(); return { ra: p.ra, dec: p.dec }; }
  if (s.dynamic === 'moon') { const p = computeMoonPosition(); return { ra: p.ra, dec: p.dec }; }
  const p = computePlanetPositions().find(x => x.body === s.dynamic);
  return p ? { ra: p.ra, dec: p.dec } : null;
}
