// Deep Sky Atlas — the black holes signature layer: confirmed stellar-mass
// X-ray binaries and supermassive black holes (a curated measured set plus
// a live VizieR Milliquas AGN/quasar cone search).

import { fetchJSON } from './net.js';
import { showToast } from './ui.js';
import { makeGlowDot, makeBlackHoleIcon } from './markers.js';

const VIZIER_TAP_URL = 'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync';

const STELLAR_COLOR = '#ff9f0a';
const SUPERMASSIVE_COLOR = '#ff453a';
const FLAGSHIP_COLOR = '#ffd60a';

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function lerpHex(a, b, t) {
  const pa = a.match(/\w\w/g).map(x => parseInt(x, 16));
  const pb = b.match(/\w\w/g).map(x => parseInt(x, 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

/**
 * Map a system's measured physics onto its render: inclination tilts the
 * disk, spin sets the inner-edge radius, accretion state sets brightness,
 * and disk color runs from deep orange (cool/quiescent) toward blue-white
 * (hot inner disks of rapidly-spinning, actively-feeding systems) — the
 * real temperature ordering of X-ray binary disks.
 */
function stellarRender(bh) {
  const spin = bh.spin ?? 0.5;
  const state = bh.accretion_state || 'quiescent';
  const heat = Math.min(1, (state === 'persistent' ? 0.5 : state === 'recurrent' ? 0.28 : 0.05) + spin * 0.5);
  const entry = {
    type: 'black_hole',
    title: bh.name,
    params: {
      colorA: lerpHex('#ff7a1a', '#6f9ff2', heat),
      colorB: lerpHex('#ffd9a0', '#eef4ff', heat),
      inclinationDeg: bh.inclination_deg ?? 74,
      spin,
      jet: bh.jets ? 1 : 0,
      dim: state === 'quiescent' ? 0.68 : 1
    }
  };
  // Cygnus X-1 has a famous official artist's impression — prefer it, with
  // the data-driven render as live fallback.
  if (bh.name === 'Cygnus X-1') {
    entry.photo = {
      file: "Artist's impression of Cygnus X-1.jpg",
      kind: 'art',
      credit: 'NASA/CXC/M. Weiss (Chandra X-ray Observatory)'
    };
  }
  return entry;
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

  const cat = A.catalog({
    name: 'Stellar-mass black holes',
    shape: makeBlackHoleIcon(STELLAR_COLOR, 20),
    sourceSize: 20,
    onClick: null
  });
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
        extraRows: [
          ['Mass', massText],
          ['Companion star', bh.companion],
          ...(bh.inclination_deg != null ? [['Disk inclination', `~${bh.inclination_deg}° (approx.)`]] : []),
          ...(bh.spin != null ? [['Spin (a*)', `~${bh.spin} (approx.)`]] : [])
        ],
        render: stellarRender(bh),
        source: bh.source,
        approxNote: bh.approx || bh.distance_approx ? 'Some values above are approximate; the literature disagrees on precise mass/distance for this system.' : (bh.notes || null)
      }
    });
    cat.addSources([source]);
  }
  aladin.addCatalog(cat);
  return { catalog: cat, count: data.objects.length };
}

/**
 * Curated supermassive black holes with direct or well-known mass
 * measurements — the EHT-imaged pair plus the classic dynamical set
 * (megamaser disks, stellar/gas dynamics, reverberation mapping) and the
 * famous record-holders. The full AGN/quasar population (every one of them
 * a supermassive black hole) loads live from Milliquas below.
 */
export async function loadFlagshipSupermassive(aladin) {
  let data;
  try {
    data = await fetchJSON('data/blackholes_supermassive.json');
  } catch (err) {
    showToast('Could not load the supermassive black hole catalog.', 'error');
    return { catalog: null, count: 0 };
  }

  const cat = A.catalog({
    name: 'Supermassive black holes (measured)',
    shape: makeBlackHoleIcon(FLAGSHIP_COLOR, 26, 1.25),
    sourceSize: 26,
    displayLabel: true,
    labelColumn: 'name',
    labelColor: '#ffd60acc',
    labelFont: '12px -apple-system, sans-serif',
    onClick: null
  });
  const massText = (m, approx) => (m >= 1e9
    ? `${(m / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 })} billion M☉`
    : `${(m / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })} million M☉`)
    + (approx ? ' (approx.)' : '');
  for (const bh of data.objects) {
    // Per-object render seeded from the name so each hole looks distinct;
    // radio-loud systems get their jets. The EHT pair keeps its real
    // photographs (renders.json) — the render is the live fallback.
    const seed = String(bh.name).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const source = A.source(bh.ra, bh.dec, {
      name: bh.name,
      _detail: {
        name: bh.name,
        aliases: bh.aliases,
        typeLabel: 'Supermassive black hole',
        ra: bh.ra,
        dec: bh.dec,
        distanceText: `${bh.distance_kpc.toLocaleString()} kpc${bh.distance_approx ? ' (approx.)' : ''}`,
        badges: bh.eht_imaged ? [`EHT imaged ${bh.eht_year}`] : [],
        extraRows: [
          ['Mass', massText(bh.mass_solar, bh.approx)],
          ...(bh.method ? [['Measured by', bh.method]] : [])
        ],
        render: {
          type: 'black_hole',
          title: bh.name,
          params: {
            inclinationDeg: 18 + (seed % 55),
            spin: 0.35 + (seed % 55) / 100,
            jet: bh.jets ? 1 : 0,
            dim: 1
          }
        },
        approxNote: bh.notes || null,
        source: bh.source
      }
    });
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
export function initMilliquasLayer(
  aladin,
  onZoom = (fn) => aladin.on('zoomChanged', fn),
  onPosition = (fn) => aladin.on('positionChanged', fn)
) {
  const cat = A.catalog({
    name: 'AGN & Quasars (Milliquas)',
    shape: makeGlowDot(SUPERMASSIVE_COLOR, 9),
    sourceSize: 9,
    onClick: null
  });
  aladin.addCatalog(cat);

  let lastKey = '';
  let failed = false;
  let enabled = true;

  async function refresh() {
    if (failed || !enabled) return; // dead endpoint or layer toggled off: no queries
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
        const qname = get('Name') || 'quasar';
        // Per-object variety seeded from the name; BL Lacs are jets pointed
        // nearly at us, so they render face-on with a beam.
        const seed = String(qname).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        const isBlazar = typeCode === 'B';
        return A.source(get('RAJ2000'), get('DEJ2000'), {
          _detail: {
            name: qname,
            typeLabel,
            ra: get('RAJ2000'),
            dec: get('DEJ2000'),
            mag: get('Rmag'),
            extraRows: [['Redshift (z)', get('z')]],
            render: {
              type: 'black_hole',
              title: qname,
              params: {
                inclinationDeg: isBlazar ? 8 : 20 + (seed % 50),
                spin: 0.4 + (seed % 50) / 100,
                jet: isBlazar ? 1 : (seed % 3 === 0 ? 1 : 0),
                dim: 1
              }
            },
            source: 'Million Quasars catalog (Milliquas, VII/294) via VizieR TAP'
          }
        });
      });
      cat.addSources(sources);
    } catch (err) {
      failed = true;
      showToast('VizieR Milliquas AGN/quasar layer is unreachable right now.', 'error');
    }
  }

  onPosition(debounce(refresh, 250));
  onZoom(debounce(refresh, 250));
  refresh();
  // Lets the layer toggle stop live VizieR queries entirely while hidden.
  cat.dsaSetEnabled = (v) => {
    enabled = v;
    if (v) { lastKey = ''; refresh(); }
  };
  return cat;
}

// NOTE: the former GW-mergers scatter layer was removed deliberately.
// Real gravitational-wave localizations span tens to hundreds of square
// degrees; plotting them as precise-looking pins overstated the app's
// accuracy. GW170817 — the one merger pinpointed exactly, via its kilonova
// in NGC 4993 — lives on as a guided-tour destination instead.
