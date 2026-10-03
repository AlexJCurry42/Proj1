// Project Planetarium — "which constellation is this?", answered the
// official way, not by nearest-label guessing: the IAU constellation
// boundaries (Delporte 1930) are fixed along lines of the 1875.0 equinox,
// and the standard determination algorithm (Roman 1987; VizieR VI/42) is
// a scan of ~357 declination-ordered zones in B1875 coordinates. We
// precess J2000 → B1875 and scan. The zone table is fetched by the data
// pipeline (data-refresh.yml); until its first run the lookup returns
// null and the detail row is simply omitted.

import { fetchJSON } from './net.js';
import { D2R, R2D } from './astro.js';

const NAMES = {
  and: 'Andromeda', ant: 'Antlia', aps: 'Apus', aqr: 'Aquarius', aql: 'Aquila',
  ara: 'Ara', ari: 'Aries', aur: 'Auriga', boo: 'Boötes', cae: 'Caelum',
  cam: 'Camelopardalis', cnc: 'Cancer', cvn: 'Canes Venatici', cma: 'Canis Major',
  cmi: 'Canis Minor', cap: 'Capricornus', car: 'Carina', cas: 'Cassiopeia',
  cen: 'Centaurus', cep: 'Cepheus', cet: 'Cetus', cha: 'Chamaeleon',
  cir: 'Circinus', col: 'Columba', com: 'Coma Berenices', cra: 'Corona Australis',
  crb: 'Corona Borealis', crv: 'Corvus', crt: 'Crater', cru: 'Crux',
  cyg: 'Cygnus', del: 'Delphinus', dor: 'Dorado', dra: 'Draco', equ: 'Equuleus',
  eri: 'Eridanus', for: 'Fornax', gem: 'Gemini', gru: 'Grus', her: 'Hercules',
  hor: 'Horologium', hya: 'Hydra', hyi: 'Hydrus', ind: 'Indus', lac: 'Lacerta',
  leo: 'Leo', lmi: 'Leo Minor', lep: 'Lepus', lib: 'Libra', lup: 'Lupus',
  lyn: 'Lynx', lyr: 'Lyra', men: 'Mensa', mic: 'Microscopium', mon: 'Monoceros',
  mus: 'Musca', nor: 'Norma', oct: 'Octans', oph: 'Ophiuchus', ori: 'Orion',
  pav: 'Pavo', peg: 'Pegasus', per: 'Perseus', phe: 'Phoenix', pic: 'Pictor',
  psc: 'Pisces', psa: 'Piscis Austrinus', pup: 'Puppis', pyx: 'Pyxis',
  ret: 'Reticulum', sge: 'Sagitta', sgr: 'Sagittarius', sco: 'Scorpius',
  scl: 'Sculptor', sct: 'Scutum', ser: 'Serpens', sex: 'Sextans', tau: 'Taurus',
  tel: 'Telescopium', tri: 'Triangulum', tra: 'Triangulum Australe',
  tuc: 'Tucana', uma: 'Ursa Major', umi: 'Ursa Minor', vel: 'Vela',
  vir: 'Virgo', vol: 'Volans', vul: 'Vulpecula'
};

// IAU 1976 precession angles, evaluated once for J2000.0 → B1875.0 (the
// boundaries' epoch). T is negative: we precess backward.
const T = (2405889.25855 - 2451545.0) / 36525; // Julian centuries
const AS = Math.PI / 180 / 3600;               // arcsec → rad
const ZETA = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * AS;
const ZEE = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * AS;
const THETA = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * AS;

/** J2000 degrees → B1875 { raH (hours), dec (degrees) }. */
export function toB1875(raDeg, decDeg) {
  const a = raDeg * D2R, d = decDeg * D2R;
  const A = Math.cos(d) * Math.sin(a + ZETA);
  const B = Math.cos(THETA) * Math.cos(d) * Math.cos(a + ZETA) - Math.sin(THETA) * Math.sin(d);
  const C = Math.sin(THETA) * Math.cos(d) * Math.cos(a + ZETA) + Math.cos(THETA) * Math.sin(d);
  let ra = (Math.atan2(A, B) + ZEE) * R2D;
  if (ra < 0) ra += 360;
  return { raH: ra / 15, dec: Math.asin(Math.max(-1, Math.min(1, C))) * R2D };
}

/**
 * Pure zone scan (Roman 1987): first row, in catalog order, whose
 * declination floor and RA span contain the B1875 position. Exported
 * separately so the unit tests can drive it with the file from disk.
 */
export function zoneLookup(zones, raDeg, decDeg) {
  const { raH, dec } = toB1875(raDeg, decDeg);
  for (const [raLo, raHi, decLo, abbr] of zones) {
    if (dec >= decLo && raH >= raLo && raH < raHi) {
      return NAMES[String(abbr).toLowerCase().replace(/[^a-z]/g, '')] || null;
    }
  }
  return null;
}

let zones = null;  // null = not loaded yet; [] = unavailable (row omitted)
let loading = null;

export function primeConstellations() {
  if (!loading) {
    loading = fetchJSON('data/constellation_zones.json')
      .then((d) => { zones = Array.isArray(d.zones) ? d.zones : []; })
      .catch((e) => {
        // A genuine 404 (file not generated on this deploy) latches "row
        // omitted"; a TRANSIENT failure clears `loading` so the next lookup
        // retries — net.js evicts its cache entry for exactly this reason.
        if (/^HTTP 4/.test(e?.message || '')) zones = [];
        else loading = null;
      });
  }
  return loading;
}

/** Full constellation name at a J2000 position, or null until data is in. */
export function constellationAt(raDeg, decDeg) {
  if (!zones || !zones.length) { primeConstellations(); return null; }
  if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg)) return null;
  return zoneLookup(zones, raDeg, decDeg);
}
