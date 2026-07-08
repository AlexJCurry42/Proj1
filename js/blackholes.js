// Deep Sky Atlas — the black holes signature layer: confirmed stellar-mass
// X-ray binaries, supermassive/AGN & quasars (with an EHT-imaged flagship pair
// plus a live VizieR Milliquas cone search), and notable gravitational-wave
// binary-black-hole mergers.

import { fetchJSON } from './net.js';
import { showToast } from './ui.js';

const VIZIER_TAP_URL = 'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync';

const STELLAR_COLOR = '#ff9d3f';
const SUPERMASSIVE_COLOR = '#ff5555';
const FLAGSHIP_COLOR = '#ffd166';
const GW_COLOR = '#b388ff';

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Curated stellar-mass black hole X-ray binaries (data/blackholes_stellar.json). */
export async function loadStellarBlackHoles(aladin) {
  let data;
  try {
    data = await fetchJSON('data/blackholes_stellar.json');
  } catch (err) {
    showToast('Could not load the stellar-mass black hole catalog.', 'error');
    return { catalog: null, count: 0 };
  }

  const cat = A.catalog({ name: 'Stellar-mass black holes', shape: 'circle', color: STELLAR_COLOR, sourceSize: 12, onClick: null });
  for (const bh of data.objects) {
    const massText = bh.mass_solar != null ? `${bh.mass_solar}${bh.approx ? ' (approx.)' : ''} M☉` : 'Not dynamically measured';
    const source = A.source(bh.ra, bh.dec, {
      _detail: {
        name: bh.name,
        aliases: bh.aliases,
        typeLabel: bh.status === 'confirmed' ? 'Stellar-mass black hole (dynamically confirmed)' : 'Stellar-mass black hole candidate',
        ra: bh.ra,
        dec: bh.dec,
        distanceText: bh.distance_kpc != null ? `${bh.distance_kpc}${bh.distance_approx ? ' (approx.)' : ''} kpc` : null,
        extraRows: [['Mass', massText], ['Companion star', bh.companion]],
        source: bh.source,
        approxNote: bh.approx || bh.distance_approx ? 'Some values above are approximate; the literature disagrees on precise mass/distance for this system.' : (bh.notes || null)
      }
    }, { shape: 'circle', color: STELLAR_COLOR });
    cat.addSources([source]);
  }
  aladin.addCatalog(cat);
  return { catalog: cat, count: data.objects.length };
}

/** Flagship EHT-imaged supermassive black holes: Sgr A* and M87*. */
export async function loadFlagshipSupermassive(aladin) {
  let data;
  try {
    data = await fetchJSON('data/blackholes_supermassive.json');
  } catch (err) {
    showToast('Could not load flagship supermassive black hole entries.', 'error');
    return { catalog: null, count: 0 };
  }

  const cat = A.catalog({ name: 'EHT-imaged supermassive black holes', shape: 'circle', color: FLAGSHIP_COLOR, sourceSize: 16, onClick: null });
  for (const bh of data.objects) {
    const massText = `${(bh.mass_solar / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })} million M☉`;
    const source = A.source(bh.ra, bh.dec, {
      _detail: {
        name: bh.name,
        aliases: bh.aliases,
        typeLabel: 'Supermassive black hole',
        ra: bh.ra,
        dec: bh.dec,
        distanceText: `${bh.distance_kpc.toLocaleString()} kpc${bh.distance_approx ? ' (approx.)' : ''}`,
        badges: bh.eht_imaged ? [`EHT imaged ${bh.eht_year}`] : [],
        extraRows: [['Mass', massText]],
        source: bh.source
      }
    }, { shape: 'circle', color: FLAGSHIP_COLOR });
    cat.addSources([source]);
  }
  aladin.addCatalog(cat);
  return { catalog: cat, count: data.objects.length };
}

/**
 * Progressive AGN/quasar layer backed by a live VizieR TAP cone search against
 * the Milliquas catalog (VII/294), re-queried (debounced) as the view moves —
 * SIMBAD/Gaia have ready-made HiPS catalog services for this kind of
 * progressive loading, but Milliquas does not, so we approximate the same
 * "load only what's in view" behavior with cone searches.
 */
export function initMilliquasLayer(aladin) {
  const cat = A.catalog({ name: 'AGN & Quasars (Milliquas)', shape: 'circle', color: SUPERMASSIVE_COLOR, sourceSize: 7, onClick: null });
  aladin.addCatalog(cat);

  let lastKey = '';
  let failed = false;

  async function refresh() {
    if (failed) return; // don't hammer a dead endpoint all session
    const [ra, dec] = aladin.getRaDec();
    const fov = aladin.getFov()[0];
    const radius = Math.min(Math.max(fov / 2, 0.05), 5);
    const key = `${ra.toFixed(2)},${dec.toFixed(2)},${radius.toFixed(2)}`;
    if (key === lastKey) return;
    lastKey = key;

    const query =
      `SELECT TOP 500 RAJ2000, DEJ2000, Name, z, Rmag, Type FROM "VII/294/catalog" ` +
      `WHERE 1=CONTAINS(POINT('ICRS',RAJ2000,DEJ2000),CIRCLE('ICRS',${ra},${dec},${radius}))`;
    const url = `${VIZIER_TAP_URL}?request=doQuery&lang=adql&format=json&query=${encodeURIComponent(query)}`;

    try {
      const json = await fetchJSON(url);
      const cols = (json.metadata || []).map(m => m.name);
      const rows = json.data || [];
      if (typeof cat.removeAll === 'function') cat.removeAll();
      const sources = rows.map(r => {
        const get = (name) => r[cols.indexOf(name)];
        const typeCode = get('Type');
        const typeLabel = { Q: 'Quasar', A: 'AGN', B: 'BL Lac object', K: 'Narrow-line AGN' }[typeCode] || 'AGN/quasar candidate';
        return A.source(get('RAJ2000'), get('DEJ2000'), {
          _detail: {
            name: get('Name'),
            typeLabel,
            ra: get('RAJ2000'),
            dec: get('DEJ2000'),
            mag: get('Rmag'),
            extraRows: [['Redshift (z)', get('z')]],
            source: 'Million Quasars catalog (Milliquas, VII/294) via VizieR TAP'
          }
        }, { shape: 'circle', color: SUPERMASSIVE_COLOR });
      });
      cat.addSources(sources);
    } catch (err) {
      failed = true;
      showToast('VizieR Milliquas AGN/quasar layer is unreachable right now.', 'error');
    }
  }

  aladin.on('positionChanged', debounce(refresh, 250));
  aladin.on('zoomChanged', debounce(refresh, 250));
  refresh();
  return cat;
}

/** Curated notable LIGO/Virgo binary-black-hole mergers (illustrative centroids only). */
export async function loadGwMergers(aladin) {
  let data;
  try {
    data = await fetchJSON('data/blackholes_gw_mergers.json');
  } catch (err) {
    showToast('Could not load gravitational-wave merger events.', 'error');
    return { catalog: null, count: 0 };
  }

  const cat = A.catalog({ name: 'Gravitational-wave mergers', shape: 'plus', color: GW_COLOR, sourceSize: 14, onClick: null });
  for (const ev of data.events) {
    const source = A.source(ev.ra, ev.dec, {
      _detail: {
        name: ev.name,
        typeLabel: 'Gravitational-wave binary black hole merger',
        ra: ev.ra,
        dec: ev.dec,
        distanceText: `${ev.distance_mpc.toLocaleString()} Mpc`,
        extraRows: [
          ['Merger date', ev.date],
          ['Progenitor masses', `${ev.mass1_solar} + ${ev.mass2_solar} M☉`],
          ['Remnant mass', `${ev.remnant_mass_solar} M☉`],
          ['90% localization area', `~${ev.localization_area_deg2} deg²`]
        ],
        source: ev.source,
        approxNote: `Sky position is an illustrative centroid only — the real localization region spans roughly ${ev.localization_area_deg2} square degrees, not a point.`
      }
    }, { shape: 'plus', color: GW_COLOR });
    cat.addSources([source]);
  }
  aladin.addCatalog(cat);
  return { catalog: cat, count: data.events.length };
}
