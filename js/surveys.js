// Project Planetarium — the imagery surveys on the spectrum rail, and WHERE
// they are actually served from.
//
// Why explicit URLs: the rail used to hand the engine registry IDs
// ("P/2MASS/color") and let it resolve them. The engine only ever resolves to
// CDS's own hosts, and in November 2026 every survey path on
// alasky.cds.unistra.fr started returning 404 (alaskybis stopped answering at
// all). The registry still LISTS those paths, so nothing looked wrong — the
// sky was simply black. The same surveys are mirrored at NASA/IPAC (IRSA),
// ESA, CSIRO (CASDA), STScI (MAST) and China-VO, so each entry names its
// mirrors explicitly, best first, and the engine is pointed straight at them.
//
// Every URL below was verified from CI the way a browser uses it: an Origin
// header, a 200 on `properties` AND on a real tile, and
// `Access-Control-Allow-Origin: *` on both — WebGL cannot texture from a tile
// served without CORS, so "answers curl" is not enough. tests/health-check.mjs
// re-checks this table daily against the same bar.
//
// `id` is the app's stable key (permalinks, saved preferences, tours). It is
// NOT used to load anything any more.
//
// Kept DOM-free so the unit suite and the Node health check can import it.

export const SURVEYS = [
  { id: 'P/Fermi/color', name: 'Fermi', band: 'Gamma-ray — the violent universe', minFov: 1.0,
    urls: ['https://skies.esac.esa.int/FermiColor'] },
  { id: 'P/SDSS9/color', name: 'SDSS9', band: 'Optical — Sloan digital survey', minFov: 0.05,
    urls: ['https://irsa.ipac.caltech.edu/data/hips/CDS/SDSS/DR9/color',
      'https://skies.esac.esa.int/SDSS9Color'] },
  // The key is the historical z-zg-g composite, which no host serves any more.
  // MAST serves the i-r-g composite of the same Pan-STARRS DR1 data, which is
  // what loads; the key stays so tours and old links keep landing here.
  { id: 'P/PanSTARRS/DR1/color-z-zg-g', name: 'Pan-STARRS', band: 'Optical — deep CCD survey', minFov: 0.03,
    urls: ['https://stpubdata.s3.us-east-1.amazonaws.com/mast/skybackgrounds/PanSTARRS'] },
  { id: 'P/DSS2/color', name: 'DSS2', band: 'Optical — the classic all-sky view', minFov: 0.1,
    urls: ['https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color',
      'https://casda.csiro.au/hips/DSS2/color',
      'https://skies.esac.esa.int/DSSColor',
      'https://stpubdata.s3.us-east-1.amazonaws.com/mast/skybackgrounds/DSSColor'] },
  { id: 'P/2MASS/color', name: '2MASS', band: 'Near-infrared — through the dust', minFov: 0.14,
    urls: ['https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color'] },
  { id: 'P/allWISE/color', name: 'AllWISE', band: 'Mid-infrared — warm dust & AGN glow', minFov: 0.2,
    urls: ['https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1',
      'https://skies.esac.esa.int/AllWISEColor',
      'https://hips.china-vo.org/m/CDS_P_allWISE_color'] },
  { id: 'P/NVSS', name: 'NVSS', band: 'Radio — jets, lobes & remnants', minFov: 0.6,
    urls: ['https://casda.csiro.au/hips/NVSS',
      'https://hips.china-vo.org/m/CDS_P_NVSS'] }
];
// Removed: DESI Legacy Surveys DR10. Its only hosts were the two CDS servers,
// and a registry-wide search found no other colour HiPS of it that serves —
// a stop that can never paint is worse than no stop. Restore it here if a
// live mirror appears; the health check's discovery block will report one.

export const surveyIndex = (id) => SURVEYS.findIndex((s) => s.id === id);

/** The URL the engine should load for a survey: its best mirror. */
export const surveyUrl = (id, mirror = 0) => {
  const s = SURVEYS[surveyIndex(id)];
  return s ? s.urls[Math.min(mirror, s.urls.length - 1)] : null;
};
