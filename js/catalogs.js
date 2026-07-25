// Project Planetarium — catalog overlays: SIMBAD/Gaia progressive HiPS catalogs,
// eagerly-loaded Messier/NGC/IC markers with zoom-aware density, and the
// NASA Exoplanet Archive layer.

import { fetchJSON, fetchText } from './net.js';
import { showToast } from './ui.js';
import { makeGlowDot, makePlanetIcon } from './markers.js';
import { makeConeLayer } from './conesearch.js';

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
 * SIMBAD flavor of the shared cone-layer skeleton (js/conesearch.js).
 * SIMBAD aggregates the major catalogs, so an otype-filtered cone search
 * around the view center gives "all known X" semantics with progressive
 * loading. The ADQL keeps the parser-safe shape the detail panel already
 * uses in production: no joins, no ORDER BY on expressions, coordinates
 * pre-validated and fixed-point.
 */
function makeSimbadConeLayer(aladin, onZoom, onPosition, opts) {
  return makeConeLayer(aladin, onZoom, onPosition, {
    name: opts.name,
    shape: makeGlowDot(opts.color, opts.dotSize ?? 9),
    sourceSize: opts.dotSize ?? 9,
    maxRadiusDeg: opts.maxRadiusDeg,
    hint: opts.hint,
    failMsg: `The SIMBAD ${opts.fallbackName} service is unreachable right now; the layer will retry next session.`,
    async fetchSources(ra, dec, radius) {
      const query =
        `SELECT TOP ${opts.top ?? 800} main_id, otype, ra, dec FROM basic ` +
        `WHERE ${opts.where} AND ra IS NOT NULL AND dec IS NOT NULL ` +
        `AND CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}, ${radius.toFixed(4)})) = 1`;
      const json = await fetchJSON(`${SIMBAD_TAP_URL}?request=doQuery&lang=adql&format=json&query=${encodeURIComponent(query)}`);
      const cols = (json.metadata || []).map(m => m.name.toLowerCase());
      return (json.data || []).map(r => {
        const get = (name) => r[cols.indexOf(name)];
        const oname = get('main_id') || opts.fallbackName;
        return A.source(get('ra'), get('dec'), {
          _detail: {
            name: oname,
            typeLabel: opts.typeLabel,
            ra: get('ra'),
            dec: get('dec'),
            extraRows: [['SIMBAD type', get('otype')]],
            ...(opts.detailExtras ? opts.detailExtras(oname, get('otype')) : {}),
            source: opts.sourceNote
          }
        });
      });
    }
  });
}

/**
 * All known galaxies: SIMBAD unions LEDA, 2MASS XSC, SDSS, 6dF, … — millions
 * of objects. otype = 'G..' is SIMBAD's hierarchical wildcard: galaxies and
 * every galaxy subtype (interacting, Seyfert, LINER, …).
 */
export function initGalaxiesLayer(
  aladin,
  onZoom = (fn) => aladin.on('zoomChanged', fn),
  onPosition = (fn) => aladin.on('positionChanged', fn)
) {
  return makeSimbadConeLayer(aladin, onZoom, onPosition, {
    name: 'Galaxies (SIMBAD)',
    color: '#ffcc66',
    where: `otype = 'G..'`,
    typeLabel: 'Galaxy',
    fallbackName: 'galaxy',
    hint: 'Galaxies load around the view center — zoom or pan to fetch more of the sky.',
    sourceNote: 'SIMBAD (CDS) via TAP — union of the major galaxy catalogs'
  });
}

/**
 * Every object SIMBAD classifies as a black hole or black hole candidate —
 * the live "all known" complement to the curated stellar-mass list (which
 * keeps its rich physics-driven renders and literature citations).
 */
export function initSimbadBlackHolesLayer(
  aladin,
  onZoom = (fn) => aladin.on('zoomChanged', fn),
  onPosition = (fn) => aladin.on('positionChanged', fn)
) {
  return makeSimbadConeLayer(aladin, onZoom, onPosition, {
    name: 'Black holes (SIMBAD)',
    color: '#ff9f0a',
    dotSize: 8,
    top: 500,
    where: `(otype = 'BH..' OR otype = 'BH?')`,
    typeLabel: 'Black hole (catalogued)',
    fallbackName: 'black hole',
    hint: 'Catalogued black holes load around the view center — zoom or pan to fetch more of the sky.',
    sourceNote: 'SIMBAD (CDS) via TAP — objects classified as (candidate) black holes',
    detailExtras: (name) => {
      const seed = String(name).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
      return {
        render: {
          type: 'black_hole',
          title: name,
          params: { inclinationDeg: 20 + (seed % 55), spin: 0.3 + (seed % 60) / 100, jet: seed % 4 === 0 ? 1 : 0, dim: 0.85 }
        }
      };
    }
  });
}

const NGC_TYPE_LABEL = {
  G: 'Galaxy', GPair: 'Galaxy pair', GTrpl: 'Galaxy triplet', GGroup: 'Galaxy group',
  OCl: 'Open cluster', GCl: 'Globular cluster', PN: 'Planetary nebula',
  SNR: 'Supernova remnant', Neb: 'Nebula', EmN: 'Emission nebula',
  RfN: 'Reflection nebula', HII: 'HII region', 'Cl+N': 'Cluster with nebulosity',
  DrkN: 'Dark nebula', Ast: 'Asterism', Nova: 'Nova'
};

/**
 * The complete OpenNGC catalog (~13,000 NGC/IC objects), snapshotted by
 * the data-refresh Action. Magnitude-tiered by field of view so
 * the full list only appears once you're zoomed in enough for it to be
 * useful rather than a wall of dots:
 *   FoV ≥ 50°:  mag ≤ 8    ·  20–50°: mag ≤ 10
 *   7–20°:      mag ≤ 12   ·  < 7°:   everything
 */
export async function loadNgcFull(aladin, onZoom = (fn) => aladin.on('zoomChanged', fn), excludeIds = null) {
  let data;
  try {
    data = await fetchJSON('data/ngc_full.json');
  } catch (err) {
    showToast('The full NGC/IC catalog is not available yet (data refresh pending).', 'info', 7000);
    return { catalog: null, count: 0 };
  }

  // Tiers by magnitude; unmeasured-magnitude objects land in the last tier.
  const tiers = [[], [], [], []];
  let skipped = 0;
  for (const [name, type, ra, dec, mag, common] of data.objects) {
    if (excludeIds && excludeIds.has(String(name).replace(/\s+/g, '').toUpperCase())) { skipped++; continue; }
    const src = A.source(ra, dec, {
      _detail: {
        name: common ? `${name} — ${common}` : name,
        typeLabel: NGC_TYPE_LABEL[type] || type,
        ra, dec,
        mag: mag ?? undefined,
        source: 'OpenNGC (CC-BY-SA-4.0) — the complete NGC/IC catalogs'
      }
    });
    const tier = mag == null ? 3 : mag <= 8 ? 0 : mag <= 10 ? 1 : mag <= 12 ? 2 : 3;
    tiers[tier].push(src);
  }

  const cat = A.catalog({
    name: 'NGC & IC (full)',
    shape: makeGlowDot('#66b7ff', 8),
    sourceSize: 8,
    onClick: null
  });
  aladin.addCatalog(cat);

  let currentDepth = -1;
  const depthFor = (fov) => fov >= 50 ? 0 : fov >= 20 ? 1 : fov >= 7 ? 2 : 3;
  function rebuild() {
    let fov = 60;
    try { fov = aladin.getFov()[0]; } catch (err) { /* keep default */ }
    const depth = depthFor(fov);
    if (depth === currentDepth) return;
    currentDepth = depth;
    try {
      if (typeof cat.removeAll === 'function') cat.removeAll();
      cat.addSources(tiers.slice(0, depth + 1).flat());
    } catch (err) { /* engine mid-redraw */ }
  }
  rebuild();
  onZoom(debounce(rebuild, 200));

  return { catalog: cat, count: data.objects.length - skipped };
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

  // ids let the full-NGC layer skip objects the curated set already shows.
  // Messier ids can never match OpenNGC's 'NGC 224'-style names by string
  // alone, so each curated Messier entry carries its standard NGC/IC
  // cross-id — without it, all ~106 shared objects rendered TWICE (the
  // curated M31 marker plus a plain 'NGC 224' dot dead-stacked on top).
  const ids = new Set(all.flatMap(e =>
    [e.obj.id, e.obj.ngc].filter(Boolean).map(s => String(s).replace(/\s+/g, '').toUpperCase())));
  return { catalogs: Object.values(catalogs), count: all.length, ids };
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

/**
 * NASA Exoplanet Archive: confirmed planets, cached in-memory for the session.
 * The archive's TAP sends no CORS headers, so browsers cannot query it
 * directly — the only source is the repo-bundled snapshot that the
 * data-refresh Action regenerates weekly.
 */
export async function loadExoplanets(aladin) {
  // The famous-planet names come from renders.json — start that fetch NOW
  // so it rides alongside the big CSV instead of queueing behind it.
  const rendersEarly = fetchJSON('data/renders.json').catch(() => null);
  if (!exoplanetCache) {
    try {
      exoplanetCache = parseExoCsv(await fetchText(EXO_SNAPSHOT_URL, { timeoutMs: 15000 }));
    } catch (err) {
      // Snapshot missing: a fresh fork before the data-refresh Action's first run.
      showToast('The exoplanet catalog is not available yet (the bundled snapshot has not been generated — the archive blocks direct browser access). Try again after the next site update.', 'error', 10000);
      return { catalog: null, count: 0 };
    }
  }

  // The well-studied planets — the ones with curated artist impressions,
  // direct images or renders in data/renders.json — get their own standout
  // markers: bigger, ringed like the Solar System planets, and labeled by
  // name, so they read as landmarks among the six thousand dots.
  let famousNames = new Set();
  try {
    const renders = await rendersEarly;
    for (const e of renders.entries || []) {
      for (const m of e.match || []) famousNames.add(m);
    }
  } catch (err) { /* purely cosmetic: everything falls back to plain dots */ }

  const cat = A.catalog({
    name: 'Exoplanets',
    shape: makeGlowDot('#30d158', 9),
    sourceSize: 9,
    onClick: null
  });
  const catFamous = A.catalog({
    name: 'Exoplanets (well-studied)',
    shape: makePlanetIcon('#7dffb0', 17),
    sourceSize: 17,
    displayLabel: true,
    labelColumn: 'name',
    labelColor: 'rgba(158, 255, 196, 0.85)',
    labelFont: '11px -apple-system, sans-serif',
    onClick: null
  });

  const sources = [];
  const famous = [];
  for (const row of exoplanetCache) {
    if (row.ra == null || row.dec == null) continue;
    const isFamous = famousNames.has(String(row.pl_name).trim().toLowerCase());
    const src = A.source(row.ra, row.dec, {
      ...(isFamous ? { name: row.pl_name } : {}),
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
        source: 'NASA Exoplanet Archive (pscomppars), NASA/IPAC — bundled snapshot, refreshed weekly'
      }
    });
    (isFamous ? famous : sources).push(src);
  }
  cat.addSources(sources);
  catFamous.addSources(famous);
  aladin.addCatalog(cat);
  aladin.addCatalog(catFamous); // added second: draws above the plain dots
  return { catalog: [cat, catFamous], count: sources.length + famous.length };
}
