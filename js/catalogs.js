// Deep Sky Atlas — catalog overlays: SIMBAD/Gaia progressive HiPS catalogs,
// eagerly-loaded Messier/NGC/IC markers with zoom-aware density, and the
// NASA Exoplanet Archive layer.

import { fetchJSON } from './net.js';
import { showToast } from './ui.js';
import { makeGlowDot } from './markers.js';

const EXOPLANET_TAP_URL = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync';
const SIMBAD_HIPS_CAT_URL = 'https://axel.u-strasbg.fr/HiPSCatService/SIMBAD';
const GAIA_HIPS_CAT_URL = 'https://axel.u-strasbg.fr/HiPSCatService/I/355/gaiadr3';

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

/** NASA Exoplanet Archive: confirmed planets, queried once and cached in-memory. */
export async function loadExoplanets(aladin) {
  if (!exoplanetCache) {
    const query =
      'SELECT pl_name, hostname, ra, dec, discoverymethod, disc_year, sy_dist FROM pscomppars ' +
      'WHERE ra IS NOT NULL AND dec IS NOT NULL';
    const url = `${EXOPLANET_TAP_URL}?query=${encodeURIComponent(query)}&format=json`;
    try {
      exoplanetCache = await fetchJSON(url);
    } catch (err) {
      showToast('NASA Exoplanet Archive is unreachable; exoplanet layer disabled.', 'error');
      return { catalog: null, count: 0 };
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
        source: 'NASA Exoplanet Archive (pscomppars table), NASA/IPAC'
      }
    }));
  }
  cat.addSources(sources);
  aladin.addCatalog(cat);
  return { catalog: cat, count: sources.length };
}
