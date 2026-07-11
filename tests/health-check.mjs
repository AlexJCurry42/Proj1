// Pocket Planetarium — live-endpoint health check. Dependency-free Node
// (≥18, for global fetch). Run with `node tests/health-check.mjs`.
//
// The app has no backend: it talks straight to CDS, VizieR, NASA, CelesTrak
// and Wikimedia Commons from the browser. Any of those can drift — TAP
// column renames, retired HiPS IDs, moved image files — and nothing in the
// repo would notice until a user hits it. This script replays each service
// call the app actually makes (same endpoints, same queries, same columns)
// and fails loudly on drift. It runs on a daily schedule in
// .github/workflows/health-check.yml.
//
// Every check retries once (transient network flakes are not drift) and
// carries its own timeout.

const UA = 'PocketPlanetarium-healthcheck/1 (+https://github.com/AlexJCurry42/Proj1)';
const TIMEOUT_MS = 30000;

// Endpoints exactly as the app uses them (js/*.js, .github/workflows/*.yml).
const SIMBAD_TAP = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';
const VIZIER_TAP = 'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync';
const EXO_TAP = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync';
const GAIA_HIPS_CAT = 'https://axel.u-strasbg.fr/HiPSCatService/I/355/gaiadr3';
const SESAME = 'https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNVA?';
const CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php';
const MOCSERVER = 'https://alasky.cds.unistra.fr/MocServer/query';
const COMMONS_FILEPATH = 'https://commons.wikimedia.org/wiki/Special:FilePath/';

// The seven HiPS imagery surveys on the spectrum rail (js/spectrum.js).
const HIPS_SURVEYS = [
  'P/Fermi/color',
  'P/SDSS9/color',
  'P/PanSTARRS/DR1/color-z-zg-g',
  'P/DSS2/color',
  'P/2MASS/color',
  'P/allWISE/color',
  'P/NVSS'
];

async function get(url, init = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    ...init,
    headers: { 'user-agent': UA, ...(init.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.slice(0, 120)}`);
  return res;
}

const getJSON = async (url) => (await get(url)).json();
const getText = async (url) => (await get(url)).text();

function tapUrl(base, query) {
  return `${base}?request=doQuery&lang=adql&format=json&query=${encodeURIComponent(query)}`;
}

/** Assert a TAP-JSON response has the columns the app indexes by name. */
function expectColumns(json, wanted, label) {
  const cols = (json.metadata || []).map((m) => m.name.toLowerCase());
  for (const w of wanted) {
    if (!cols.includes(w.toLowerCase())) {
      throw new Error(`${label}: column "${w}" missing (got: ${cols.join(', ')})`);
    }
  }
  if (!Array.isArray(json.data) || json.data.length === 0) {
    throw new Error(`${label}: query returned no rows`);
  }
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// --------------------------------------------------------- SIMBAD TAP ---
// The galaxies layer (js/catalogs.js): otype-filtered cone search.
check('SIMBAD TAP — galaxies cone search (Galaxies layer)', async () => {
  const q =
    `SELECT TOP 5 main_id, otype, ra, dec FROM basic ` +
    `WHERE otype = 'G..' AND ra IS NOT NULL AND dec IS NOT NULL ` +
    `AND CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', 10.684700, 41.269100, 2.0000)) = 1`;
  expectColumns(await getJSON(tapUrl(SIMBAD_TAP, q)), ['main_id', 'otype', 'ra', 'dec'], 'galaxies');
});

// The live black-holes layer (js/catalogs.js).
check('SIMBAD TAP — black hole cone search (Black holes layer)', async () => {
  const q =
    `SELECT TOP 5 main_id, otype, ra, dec FROM basic ` +
    `WHERE (otype = 'BH..' OR otype = 'BH?') AND ra IS NOT NULL AND dec IS NOT NULL ` +
    `AND CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', 299.590300, 35.201600, 5.0000)) = 1`;
  expectColumns(await getJSON(tapUrl(SIMBAD_TAP, q)), ['main_id', 'otype', 'ra', 'dec'], 'black holes');
});

// The tap-an-object detail lookup (js/ui.js fetchSimbadNear), both queries.
check('SIMBAD TAP — nearest-object detail lookup + allfluxes magnitude', async () => {
  const q =
    `SELECT TOP 1 oid, main_id, otype, ra, dec, plx_value, ` +
    `DISTANCE(POINT('ICRS', ra, dec), POINT('ICRS', 10.684700, 41.269100)) AS dist ` +
    `FROM basic ` +
    `WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', 10.684700, 41.269100, 0.02)) = 1 ` +
    `ORDER BY dist ASC`;
  const json = await getJSON(tapUrl(SIMBAD_TAP, q));
  expectColumns(json, ['oid', 'main_id', 'otype', 'ra', 'dec', 'plx_value'], 'detail lookup');
  const cols = json.metadata.map((m) => m.name.toLowerCase());
  const oid = json.data[0][cols.indexOf('oid')];
  const magJson = await getJSON(tapUrl(SIMBAD_TAP, `SELECT V FROM allfluxes WHERE oidref = ${oid}`));
  if (!(json.metadata && Array.isArray(magJson.data))) throw new Error('allfluxes query shape changed');
});

// ------------------------------------------------------- VizieR TAP ---
// The AGN/quasars layer (js/blackholes.js): Milliquas VII/294 cone search.
check('VizieR TAP — Milliquas VII/294 (AGN & quasars layer)', async () => {
  const q =
    `SELECT TOP 5 RAJ2000, DEJ2000, Name, z, Rmag, Type FROM "VII/294/catalog" ` +
    `WHERE 1=CONTAINS(POINT('ICRS',RAJ2000,DEJ2000),CIRCLE('ICRS',180,30,2))`;
  expectColumns(await getJSON(tapUrl(VIZIER_TAP, q)),
    ['RAJ2000', 'DEJ2000', 'Name', 'z', 'Rmag', 'Type'], 'Milliquas');
});

// -------------------------------------------------- NASA Exoplanet TAP ---
// The weekly snapshot Action's exact column list (exoplanet-snapshot.yml);
// also the browser's silent live-upgrade probe (js/catalogs.js).
check('NASA Exoplanet Archive TAP — pscomppars columns (snapshot Action)', async () => {
  const q = 'select top 1 pl_name,hostname,ra,dec,discoverymethod,disc_year,sy_dist from pscomppars';
  const text = await getText(`${EXO_TAP}?query=${encodeURIComponent(q)}&format=csv`);
  const header = text.trim().split('\n')[0].toLowerCase();
  for (const col of ['pl_name', 'hostname', 'ra', 'dec', 'discoverymethod', 'disc_year', 'sy_dist']) {
    if (!header.includes(col)) throw new Error(`pscomppars column "${col}" missing (header: ${header})`);
  }
});

// ------------------------------------------------------- HiPS surveys ---
// Every spectrum-rail survey must still exist in the CDS MocServer registry
// with a live HiPS service URL.
check('CDS MocServer — all 7 spectrum-rail HiPS surveys exist', async () => {
  const missing = [];
  for (const id of HIPS_SURVEYS) {
    const url = `${MOCSERVER}?ID=*${encodeURIComponent(id)}&get=record&fmt=json&fields=ID,hips_service_url`;
    let records;
    try {
      records = await getJSON(url);
    } catch (err) {
      missing.push(`${id} (${err.message})`);
      continue;
    }
    const hit = (Array.isArray(records) ? records : []).find(
      (r) => r.ID && r.ID.endsWith(id) && r.hips_service_url
    );
    if (!hit) missing.push(id);
  }
  if (missing.length) throw new Error(`surveys missing from MocServer: ${missing.join('; ')}`);
});

// The Gaia DR3 progressive catalog (js/catalogs.js initGaiaHips).
check('Gaia DR3 HiPS catalog service — properties reachable', async () => {
  const text = await getText(`${GAIA_HIPS_CAT}/properties`);
  if (!/dataproduct_type\s*=?\s*catalog|hips_/i.test(text)) {
    throw new Error('properties file no longer looks like a HiPS catalog descriptor');
  }
});

// ------------------------------------------------------------- Sesame ---
// Name search (js/search.js): resolve M31 and get coordinates back.
check('CDS Sesame — resolves M31 (search)', async () => {
  const text = await getText(`${SESAME}${encodeURIComponent('M31')}`);
  if (!/<jradeg>\s*10\.6/i.test(text)) {
    throw new Error(`Sesame response lacks M31's RA (<jradeg>10.68…): ${text.slice(0, 200)}`);
  }
});

// ---------------------------------------------------------- CelesTrak ---
// The daily TLE snapshot Action's two source groups (satellite-tles.yml).
check('CelesTrak — stations TLEs include the ISS; visual TLEs parse', async () => {
  const stations = await getText(`${CELESTRAK}?GROUP=stations&FORMAT=tle`);
  if (!stations.includes('ISS (ZARYA)')) throw new Error('ISS (ZARYA) missing from stations group');
  const visual = await getText(`${CELESTRAK}?GROUP=visual&FORMAT=tle`);
  const lines = visual.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  if (lines.length < 30) throw new Error(`visual group suspiciously small (${lines.length} lines)`);
  if (!(lines[1]?.startsWith('1 ') && lines[2]?.startsWith('2 '))) {
    throw new Error('visual group is not name/line1/line2 TLE triplets');
  }
});

// --------------------------------------------------- Wikimedia Commons ---
// Every real photograph in data/renders.json is served via the stable
// Special:FilePath endpoint; a renamed/deleted file breaks that object's
// photo (the UI falls back to a render, but we want to know).
check('Wikimedia Commons — every renders.json photo file still resolves', async () => {
  const { readFile } = await import('node:fs/promises');
  const renders = JSON.parse(await readFile(new URL('../data/renders.json', import.meta.url), 'utf8'));
  const files = (renders.entries || [])
    .filter((e) => e.photo && e.photo.file)
    .map((e) => e.photo.file);
  files.push("Artist's impression of Cygnus X-1.jpg"); // hardcoded in js/blackholes.js
  if (files.length < 20) throw new Error(`only found ${files.length} photo files in renders.json — parser drift?`);
  const broken = [];
  // Small batches: polite to Commons, still fast enough.
  for (let i = 0; i < files.length; i += 5) {
    await Promise.all(files.slice(i, i + 5).map(async (file) => {
      const url = `${COMMONS_FILEPATH}${encodeURIComponent(file)}?width=64`;
      try {
        const res = await fetch(url, {
          method: 'HEAD', redirect: 'follow',
          headers: { 'user-agent': UA },
          signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        if (!res.ok) broken.push(`${file} (HTTP ${res.status})`);
      } catch (err) {
        broken.push(`${file} (${err.message})`);
      }
    }));
  }
  if (broken.length) throw new Error(`${broken.length} photo(s) no longer resolve: ${broken.join('; ')}`);
});

// -------------------------------------------------------------- runner ---

let failed = 0;
for (const { name, fn } of checks) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await fn();
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt === 1) await new Promise((r) => setTimeout(r, 4000));
    }
  }
  if (lastErr) {
    failed++;
    console.error(`FAIL  ${name}\n      ${lastErr.message}`);
  } else {
    console.log(`  ok  ${name}`);
  }
}

console.log(`\n${checks.length - failed} of ${checks.length} live checks passed`);
if (failed) process.exitCode = 1;
