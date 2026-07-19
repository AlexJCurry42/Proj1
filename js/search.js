// Deep Sky Atlas — search box: CDS Sesame name resolution + coordinate parsing.

import { showToast } from './ui.js';
import { fetchText } from './net.js';
import { motionOK } from './motion.js';

const SESAME_URL = 'https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNVA?';

const sesameCache = new Map(); // name (lowercased) -> resolved result
let searchHistory = []; // in-memory only, most-recent-first, max 10

/**
 * Parse "13 29 52 +47 11 43" (sexagesimal RA h m s, Dec d m s) or
 * "202.4696 47.1953" / "202.4696, 47.1953" (decimal degrees) input.
 * Returns { ra, dec } in decimal degrees, or null if it doesn't look like coordinates.
 */
export function parseCoordinates(raw) {
  const text = raw.trim();

  // Decimal degrees: "ra dec" or "ra, dec", two floats.
  const decimalMatch = text.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (decimalMatch) {
    const ra = parseFloat(decimalMatch[1]);
    const dec = parseFloat(decimalMatch[2]);
    if (ra >= 0 && ra <= 360 && dec >= -90 && dec <= 90) return { ra, dec };
  }

  // Sexagesimal: "HH MM SS(.s) +/-DD MM SS(.s)" with space or colon separators.
  const sexMatch = text.match(
    /^(\d{1,2})[h: ]+(\d{1,2})[m: ]+(\d{1,2}(?:\.\d+)?)s?\s+([+-]?\d{1,3})[d: °]+(\d{1,2})['m: ]+(\d{1,2}(?:\.\d+)?)"?s?$/
  );
  if (sexMatch) {
    const [, rh, rm, rs, dd, dm, ds] = sexMatch;
    const ra = (parseFloat(rh) + parseFloat(rm) / 60 + parseFloat(rs) / 3600) * 15;
    const decSign = dd.trim().startsWith('-') ? -1 : 1;
    const dec = decSign * (Math.abs(parseFloat(dd)) + parseFloat(dm) / 60 + parseFloat(ds) / 3600);
    return { ra, dec };
  }

  return null;
}

/** Resolve an object name via the CDS Sesame resolver (SIMBAD/NED/VizieR). */
export async function resolveName(name) {
  const key = name.trim().toLowerCase();
  if (sesameCache.has(key)) return sesameCache.get(key);

  const xmlText = await fetchText(SESAME_URL + encodeURIComponent(name.trim()));
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('Sesame returned malformed XML');

  const resolver = doc.querySelector('Resolver');
  if (!resolver) throw new Error(`"${name}" not found by Sesame`);

  const jradeg = resolver.querySelector('jradeg')?.textContent;
  const jdedeg = resolver.querySelector('jdedeg')?.textContent;
  if (!jradeg || !jdedeg) throw new Error(`No coordinates returned for "${name}"`);

  const otype = resolver.querySelector('otype')?.textContent || null;
  const oname = resolver.querySelector('oname')?.textContent || name.trim();
  const aliases = Array.from(resolver.querySelectorAll('alias')).map(a => a.textContent);

  const result = { name: oname, ra: parseFloat(jradeg), dec: parseFloat(jdedeg), otype, aliases };
  sesameCache.set(key, result);
  return result;
}

export function addToHistory(entry) {
  searchHistory = searchHistory.filter(h => h.query.toLowerCase() !== entry.query.toLowerCase());
  searchHistory.unshift(entry);
  if (searchHistory.length > 10) searchHistory.length = 10;
}

export function getHistory() {
  return searchHistory;
}

/** Fly the Aladin view to a target, respecting the animations switch. */
let fovTimer = null; // a newer flight must cancel the older one's pending
                     // FoV landing, or the stale timer snaps the view back
export function flyTo(aladin, ra, dec, fovDeg = 0.6) {
  clearTimeout(fovTimer);
  if (!motionOK() || typeof aladin.animateToRaDec !== 'function') {
    aladin.gotoRaDec(ra, dec);
    aladin.setFoV(fovDeg);
  } else {
    aladin.animateToRaDec(ra, dec, 1.2);
    fovTimer = setTimeout(() => aladin.setFoV(fovDeg), 1200);
  }
}

/** Run a full search: try coordinates first, then fall back to name resolution. */
export async function runSearch(aladin, rawQuery) {
  const query = rawQuery.trim();
  if (!query) return;

  const coords = parseCoordinates(query);
  if (coords) {
    flyTo(aladin, coords.ra, coords.dec);
    addToHistory({ query, ra: coords.ra, dec: coords.dec, label: `${coords.ra.toFixed(4)}, ${coords.dec.toFixed(4)}` });
    return { ra: coords.ra, dec: coords.dec };
  }

  try {
    const result = await resolveName(query);
    flyTo(aladin, result.ra, result.dec);
    addToHistory({ query, ra: result.ra, dec: result.dec, label: result.name });
    return result;
  } catch (err) {
    showToast(`Couldn't resolve "${query}": ${err.message}`, 'error');
    // Fall back to Aladin's own bundled resolver, which uses Sesame server-side
    // and may succeed even if our direct client-side Sesame call failed (CORS, etc).
    if (typeof aladin.gotoObject === 'function') {
      aladin.gotoObject(query, {
        success: () => addToHistory({ query, ra: null, dec: null, label: query }),
        error: () => showToast(`No results found for "${query}"`, 'error')
      });
    }
    return null;
  }
}
