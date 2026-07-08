// Deep Sky Atlas — catalog overlays: SIMBAD/Gaia progressive HiPS catalogs,
// eagerly-loaded Messier/NGC/IC markers, and the NASA Exoplanet Archive layer.

import { fetchJSON } from './net.js';
import { showToast } from './ui.js';

const EXOPLANET_TAP_URL = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync';
const SIMBAD_HIPS_CAT_URL = 'https://axel.u-strasbg.fr/HiPSCatService/SIMBAD';
const GAIA_HIPS_CAT_URL = 'https://axel.u-strasbg.fr/HiPSCatService/I/355/gaiadr3';

// Marker shape/color per astrophysical object type, used consistently across
// the Messier/NGC layer and reflected in the left-rail legend.
export const TYPE_STYLE = {
  galaxy: { shape: 'circle', color: '#ffcc66', label: 'Galaxy' },
  nebula: { shape: 'square', color: '#66ccff', label: 'Nebula' },
  open_cluster: { shape: 'triangle', color: '#99ff99', label: 'Open cluster' },
  globular_cluster: { shape: 'cross', color: '#ff99cc', label: 'Globular cluster' },
  planetary_nebula: { shape: 'rhomb', color: '#cc99ff', label: 'Planetary nebula' },
  supernova_remnant: { shape: 'plus', color: '#ff6666', label: 'Supernova remnant' },
  star_cloud: { shape: 'circle', color: '#ffff99', label: 'Star cloud' },
  asterism: { shape: 'triangle', color: '#cccccc', label: 'Asterism' },
  double_star: { shape: 'triangle', color: '#ffffff', label: 'Double star' }
};

let exoplanetCache = null; // in-memory cache: never re-fetched in a session

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

/** Eagerly-loaded Messier + curated bright NGC/IC marker set (small, always visible). */
export async function loadMessierNgc(aladin) {
  let data;
  try {
    data = await fetchJSON('data/messier_ngc.json');
  } catch (err) {
    showToast('Could not load the Messier/NGC/IC catalog.', 'error');
    return { catalog: null, count: 0 };
  }

  const cat = A.catalog({ name: 'Messier & NGC/IC', sourceSize: 10, onClick: null });
  const all = [...data.messier, ...data.ngc_ic];
  for (const obj of all) {
    const style = TYPE_STYLE[obj.type] || TYPE_STYLE.galaxy;
    const source = A.source(obj.ra, obj.dec, {
      _detail: {
        name: obj.name,
        typeLabel: style.label,
        ra: obj.ra,
        dec: obj.dec,
        extraRows: [['Catalog ID', obj.id]],
        source: 'Messier catalog / curated NGC-IC subset (standard published J2000 coordinates)'
      }
    }, { shape: style.shape, color: style.color });
    cat.addSources([source]);
  }
  aladin.addCatalog(cat);
  return { catalog: cat, count: all.length };
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

  const cat = A.catalog({ name: 'Exoplanets', sourceSize: 6, color: '#7CFF9C', shape: 'circle', onClick: null });
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
