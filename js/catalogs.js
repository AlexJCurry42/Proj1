// Deep Sky Atlas — catalog overlays: SIMBAD/Gaia progressive HiPS catalogs,
// eagerly-loaded Messier/NGC/IC markers with zoom-aware density, and the
// NASA Exoplanet Archive layer.

import { fetchJSON, fetchText } from './net.js';
import { showToast } from './ui.js';
import { makeGlowDot } from './markers.js';

const EXOPLANET_TAP_URL = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync';
const SIMBAD_HIPS_CAT_URL = 'https://axel.u-strasbg.fr/HiPSCatService/SIMBAD';
const GAIA_HIPS_CAT_URL = 'https://axel.u-strasbg.fr/HiPSCatService/I/355/gaiadr3';
const SIMBAD_TAP_URL = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';

// Marker tint per astrophysical object type, reflected in the rail legend.
export const TYPE_STYLE = {
  galaxy: { color: '#ffcc66', label: 'Galaxy' },
  nebula: { color: '#66ccff', label: 'Nebula' },
  open_cluster: { color: '#99ff99', label: 'Open cluster' },
  globular_cluster: { color: '#ff99cc', label: 'Globular cluster' },
  planetary_nebula: { color: '#cc99ff', label: 'Planetary nebula' },
  supernova_remnant: { color: '#ff6666', label: 'Supernova remnant' },
  star_cloud: { color: '#ffff99', label: 'Star cloud' },
  asterism: { color: '#cccccc', label: 'Asterism' },
  double_star: { color: '#ffffff', label: 'Double star' }
};

// Showpieces that stay visible even zoomed all the way out. Everything else
// fades in as the field of view narrows, so the full-sky view never becomes
// a crammed wall of markers.
const WIDE_FOV_IDS = new Set([
  'M1', 'M8', 'M13', 'M16', 'M20', 'M27', 'M31', 'M33', 'M42', 'M45',
  'M51', 'M57', 'M81', 'M87', 'M101', 'M104',
  'NGC104', 'NGC2070', 'NGC5128', 'NGC7293', 'NGC869', 'IC434'
]);

let exoplanetCache = null; // in-memory cache: never re-fetched in a session

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Progressive SIMBAD catalog — density scales with zoom, never bulk-loaded. */
export function initSimbadHips(aladin) {
  try {
    const cat = A.catalogHiPS(SIMBAD_HIPS_CAT_URL, {
      name: 'SIMBAD',
      color: '#5eb1ff',
      sourceSize: 8,
      onClick: null
    });
    aladin.addCatalog(cat);
    return cat;
  } catch (err) {
    showToast('SIMBAD progressive catalog failed to load.', 'error');
    return null;
  }
}

/** Progressive Gaia DR3 catalog of stars. */
export function initGaiaHips(aladin) {
  try {
    const cat = A.catalogHiPS(GAIA_HIPS_CAT_URL, {
      name: 'Gaia DR3',
      color: '#ffffff',
      sourceSize: 6,
      onClick: null
    });
    aladin.addCatalog(cat);
    return cat;
  } catch (err) {
    showToast('Gaia DR3 progressive catalog failed to load.', 'error');
    return null;
  }
}

/**
 * All known galaxies — a live cone-search of SIMBAD's TAP service, which
 * aggregates every major galaxy catalog (LEDA, 2MASS XSC, SDSS, 6dF, …:
 * millions of objects). Galaxies load around the view center as you pan and
 * zoom, following the same live-query pattern as the AGN/quasar layer.
 * otype = 'G..' is SIMBAD's hierarchical wildcard: galaxies and every galaxy
 * subtype (interacting, Seyfert, LINER, …).
 */
export function initGalaxiesLayer(
  aladin,
  onZoom = (fn) => aladin.on('zoomChanged', fn),
  onPosition = (fn) => aladin.on('positionChanged', fn)
) {
  const cat = A.catalog({
    name: 'Galaxies (SIMBAD)',
    shape: makeGlowDot('#ffcc66', 9),
    sourceSize: 9,
    onClick: null
  });
  aladin.addCatalog(cat);

  let lastKey = '';
  let failed = false;
  let enabled = true;
  let hinted = false;

  async function refresh() {
    if (failed || !enabled) return; // dead endpoint or layer toggled off: no queries
    const [ra, dec] = aladin.getRaDec();
    const fov = aladin.getFov()[0];
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) return;
    const radius = Math.min(Math.max(fov / 2, 0.05), 4);
    if (!hinted && fov > 60) {
      hinted = true;
      showToast('Galaxies load around the view center — zoom or pan to fetch more of the sky.', 'info', 6000);
    }
    const key = `${ra.toFixed(2)},${dec.toFixed(2)},${radius.toFixed(2)}`;
    if (key === lastKey) return;
    lastKey = key;

    // Same parser-safe ADQL shape as the proven detail-panel query: no joins,
    // no ORDER BY on expressions, coordinates pre-validated and fixed-point.
    const query =
      `SELECT TOP 800 main_id, otype, ra, dec FROM basic ` +
      `WHERE otype = 'G..' AND ra IS NOT NULL AND dec IS NOT NULL ` +
      `AND CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}, ${radius.toFixed(4)})) = 1`;
    const url = `${SIMBAD_TAP_URL}?request=doQuery&lang=adql&format=json&query=${encodeURIComponent(query)}`;

    try {
      const json = await fetchJSON(url);
      const cols = (json.metadata || []).map(m => m.name.toLowerCase());
      const rows = json.data || [];
      if (typeof cat.removeAll === 'function') cat.removeAll();
      cat.addSources(rows.map(r => {
        const get = (name) => r[cols.indexOf(name)];
        const gname = get('main_id') || 'galaxy';
        return A.source(get('ra'), get('dec'), {
          _detail: {
            name: gname,
            typeLabel: 'Galaxy',
            ra: get('ra'),
            dec: get('dec'),
            extraRows: [['SIMBAD type', get('otype')]],
            source: 'SIMBAD (CDS) via TAP — union of the major galaxy catalogs'
          }
        });
      }));
    } catch (err) {
      failed = true;
      showToast('The SIMBAD galaxy service is unreachable right now; the layer will retry next session.', 'error');
    }
  }

  onPosition(debounce(refresh, 250));
  onZoom(debounce(refresh, 250));
  refresh();
  // Lets the layer toggle stop live queries entirely while hidden.
  cat.dsaSetEnabled = (v) => {
    enabled = v;
    if (v) { lastKey = ''; refresh(); }
  };
  return cat;
}

/**
 * Messier + curated bright NGC/IC markers with zoom-aware density:
 *   FoV ≥ 70°  — only the ~22 famous showpieces
 *   20°–70°    — objects with proper names (Lagoon, Sombrero, …)
 *   < 20°      — everything
 * One Aladin catalog per object type so each type carries its own soft
 * glow-dot icon. Returns { catalogs, count }.
 */
export async function loadMessierNgc(aladin, onZoom = (fn) => aladin.on('zoomChanged', fn)) {
  let data;
  try {
    data = await fetchJSON('data/messier_ngc.json');
  } catch (err) {
    showToast('Could not load the Messier/NGC/IC catalog.', 'error');
    return { catalogs: [], count: 0 };
  }

  const all = [...data.messier, ...data.ngc_ic].map(obj => {
    const style = TYPE_STYLE[obj.type] || TYPE_STYLE.galaxy;
    // Tier 0: famous showpiece; tier 1: has a proper name; tier 2: the rest.
    const tier = WIDE_FOV_IDS.has(obj.id) ? 0 : (obj.name !== obj.id ? 1 : 2);
    return { obj, style, tier, src: null }; // src: A.source built once, reused across tier rebuilds
  });

  const catalogs = {};
  for (const [type, style] of Object.entries(TYPE_STYLE)) {
    catalogs[type] = A.catalog({
      name: `Messier/NGC — ${style.label}`,
      shape: makeGlowDot(style.color, 16),
      sourceSize: 16,
      onClick: null
    });
    aladin.addCatalog(catalogs[type]);
  }

  function makeSource({ obj, style }) {
    return A.source(obj.ra, obj.dec, {
      name: obj.name,
      _detail: {
        name: obj.name,
        typeLabel: style.label,
        ra: obj.ra,
        dec: obj.dec,
        extraRows: [['Catalog ID', obj.id]],
        source: 'Messier catalog / curated NGC-IC subset (standard published J2000 coordinates)'
      }
    });
  }

  let lastMaxTier = -1;
  function applyDensity() {
    let fov = 180;
    try { fov = aladin.getFov()[0]; } catch (err) { /* keep default */ }
    const maxTier = fov >= 70 ? 0 : (fov >= 20 ? 1 : 2);
    if (maxTier === lastMaxTier) return;
    lastMaxTier = maxTier;
    for (const [type, cat] of Object.entries(catalogs)) {
      if (typeof cat.removeAll === 'function') cat.removeAll();
      const sources = all
        .filter(e => e.tier <= maxTier && (e.obj.type in catalogs ? e.obj.type === type : type === 'galaxy'))
        .map(e => (e.src ??= makeSource(e)));
      cat.addSources(sources);
    }
  }

  onZoom(debounce(applyDensity, 250));
  applyDensity();

  return { catalogs: Object.values(catalogs), count: all.length };
}

/**
 * Minimal quote-aware CSV parser for the archive's TAP output: returns
 * objects keyed by the header row, with numeric fields converted.
 */
export function parseExoCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length);
  if (lines.length < 2) return [];
  const splitLine = (line) => {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = splitLine(lines[0]).map(h => h.trim().toLowerCase());
  const numeric = new Set(['ra', 'dec', 'sy_dist', 'disc_year']);
  return lines.slice(1).map(line => {
    const cells = splitLine(line);
    const row = {};
    header.forEach((h, i) => {
      const v = cells[i] ?? '';
      row[h] = numeric.has(h) ? (v === '' ? null : Number(v)) : v;
    });
    return row;
  });
}

const EXO_SNAPSHOT_URL = 'data/exoplanets_snapshot.csv';
let exoplanetFromSnapshot = false;

/** Direct TAP query — works only where the archive permits it (no CORS from browsers today). */
async function fetchLiveExoplanets() {
  const probeQuery = 'select top 1 pl_name from pscomppars';
  await fetchText(`${EXOPLANET_TAP_URL}?query=${encodeURIComponent(probeQuery)}&format=csv`, { timeoutMs: 12000 });
  const query =
    'select pl_name,hostname,ra,dec,discoverymethod,disc_year,sy_dist from pscomppars ' +
    'where ra is not null and dec is not null';
  const csv = await fetchText(`${EXOPLANET_TAP_URL}?query=${encodeURIComponent(query)}&format=csv`, { timeoutMs: 90000, retries: 0 });
  return parseExoCsv(csv);
}

/**
 * NASA Exoplanet Archive: confirmed planets, cached in-memory for the session.
 * The archive's TAP sends no CORS headers, so browsers cannot query it
 * directly — the primary source is a repo-bundled snapshot that a GitHub
 * Action refreshes weekly (see .github/workflows/exoplanet-snapshot.yml).
 * A silent live-TAP attempt still runs in the background so the app
 * self-heals to live data if the archive ever enables browser access.
 */
export async function loadExoplanets(aladin) {
  if (!exoplanetCache) {
    try {
      exoplanetCache = parseExoCsv(await fetchText(EXO_SNAPSHOT_URL, { timeoutMs: 15000 }));
      exoplanetFromSnapshot = true;
      // Background upgrade path — expected to fail today, so completely silent.
      fetchLiveExoplanets().then(rows => {
        if (rows.length >= exoplanetCache.length) {
          exoplanetCache = rows;
          exoplanetFromSnapshot = false;
        }
      }).catch(() => { /* no CORS from the archive: the snapshot stands */ });
    } catch (err) {
      // Snapshot missing (first deploy before the Action has run): try live.
      showToast('Downloading confirmed exoplanets from the NASA archive — this can take up to a minute…', 'info', 9000);
      try {
        exoplanetCache = await fetchLiveExoplanets();
      } catch (liveErr) {
        showToast('The exoplanet catalog is not available right now (the archive blocks direct browser access and the bundled snapshot has not been generated yet). Try again after the next site update.', 'error', 10000);
        return { catalog: null, count: 0 };
      }
    }
  }

  const cat = A.catalog({
    name: 'Exoplanets',
    shape: makeGlowDot('#30d158', 9),
    sourceSize: 9,
    onClick: null
  });
  const sources = [];
  for (const row of exoplanetCache) {
    if (row.ra == null || row.dec == null) continue;
    sources.push(A.source(row.ra, row.dec, {
      _detail: {
        name: row.pl_name,
        typeLabel: 'Confirmed exoplanet',
        ra: row.ra,
        dec: row.dec,
        distanceText: row.sy_dist ? `${row.sy_dist.toFixed(1)} pc from host star system` : null,
        extraRows: [
          ['Host star', row.hostname],
          ['Discovery method', row.discoverymethod],
          ['Discovery year', row.disc_year]
        ],
        source: exoplanetFromSnapshot
          ? 'NASA Exoplanet Archive (pscomppars), NASA/IPAC — bundled snapshot, refreshed weekly'
          : 'NASA Exoplanet Archive (pscomppars table), NASA/IPAC'
      }
    }));
  }
  cat.addSources(sources);
  aladin.addCatalog(cat);
  return { catalog: cat, count: sources.length };
}
