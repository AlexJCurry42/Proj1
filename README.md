# Pocket Planetarium

**Pocket Planetarium** (formerly Deep Sky Atlas): an interactive, browser-based atlas of the entire sky — imagery across the
electromagnetic spectrum, stars, galaxies, nebulae, exoplanets, Solar System
planets, and a dedicated **black holes** layer covering stellar-mass X-ray
binaries, supermassive/AGN & quasars (including the two EHT-imaged flagships,
Sgr A* and M87*), and notable gravitational-wave mergers.

Designed for the general public with scientific-tool standards: an
Apple-native liquid-glass UI floats over a full-bleed sky — search bar
bottom-center like iOS Safari, a collapsible layers dock on the left, a
vertical **spectrum rail** on the right that scrubs the imagery from
gamma-ray to radio with live cross-fades. First load starts calm (only
the Solar System layer on; everything else one switch away), and famous
objects — the Sun, Moon and every planet, well-studied exoplanets,
bright stars, and all black holes — open with real photographs,
official artist impressions, or an animated **3-D render** generated
in-browser from published parameters. Renders are explicitly labeled as
illustrations, never passed off as observations.

For stargazers: all 88 constellations (figures, names, optional
boundaries), guided **tours** that fly three-act flights to the sky's
greatest hits, and **Sky Now** — one tap flies to your zenith, and with
the compass toggle on, the view tracks the phone live (sensor-smoothed
gyro + compass, computed entirely on-device). Two projections: orbit
the celestial sphere from outside, or stand inside it, planetarium
style.

Also: instant search suggestions from the curated catalogs, shareable
permalinks for any view (plus a native share button), installable as a
PWA with an offline-cached shell, red-light night-vision mode, and
preferences that persist locally. **No tracking, no analytics, no
accounts — ever.** MIT licensed (code); all data and imagery remain
under their providers' licenses, credited in-app.

Built with [Aladin Lite v3](https://aladin.cds.unistra.fr/AladinLite/) as the
sky-rendering engine. No build step, no framework, no backend, no API keys —
plain ES modules, HTML and CSS.

## Running it

Aladin Lite requires the page to be served over HTTP(S); it will not work if
you open `index.html` directly via `file://`. From the project root:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000/` in Chrome or Firefox. Any other static
file server (`npx serve`, `php -S`, etc.) works equally well.

## File structure

```
index.html           Page shell: top bar, layer dock, spectrum rail, bottom bar
css/style.css        Liquid-glass design system, responsive layout, red-light mode
js/app.js            App entry point: engine init, layer dock, readouts, permalinks
js/spectrum.js       Vertical spectrum rail: scrub imagery gamma-ray → radio
js/skynow.js         Sky Now + gyro/compass tracking (all math on-device)
js/constellations.js 88 constellations: figures, names, boundaries (Action data)
js/catalogs.js       SIMBAD/Gaia HiPS catalogs, Messier/NGC-IC, exoplanets
js/blackholes.js     Stellar-mass BHs, supermassive/AGN & quasars, GW mergers
js/planets.js        Self-contained Solar System ephemeris (no external calls)
js/search.js         CDS Sesame name resolver + coordinate parsing
js/suggest.js        Instant search suggestions from the curated catalogs
js/ui.js             Detail panel, toasts, tours, onboarding, about modal
js/render3d.js       WebGL procedural 3-D renders (planets, stars, black holes)
js/warp.js           Star-streak warp feedback on zoom, fed by the live view
js/markers.js        Shared catalog-marker helpers
js/net.js            Shared fetch-with-timeout-and-retry helper
sw.js                Service worker: network-first shell cache (offline PWA)
data/*.json|csv      Curated + Action-refreshed data (black holes, tours, ...)
.github/workflows/   Weekly exoplanet snapshot + constellation data pipelines
```

## Data sources & attribution

| Source | Used for | Citation |
|---|---|---|
| **Aladin Lite** | Sky rendering, HiPS tile streaming, progressive catalogs | CDS, Observatoire astronomique de Strasbourg, CNRS/Université de Strasbourg |
| **DSS2, SDSS9, 2MASS, AllWISE, Pan-STARRS DR1, Fermi, NVSS** (HiPS) | Imagery layers | Distributed via the CDS HiPS service; see each survey's own citation guidelines |
| **SIMBAD** | Progressive object catalog, the all-known-galaxies layer, and on-demand object detail lookups | CDS, Strasbourg, via SIMBAD TAP (`simbad.cds.unistra.fr/simbad/sim-tap/sync`) |
| **Gaia DR3** | Progressive stellar catalog | ESA / Gaia Data Processing and Analysis Consortium (DPAC), via CDS HiPS catalog service |
| **VizieR / Milliquas (VII/294)** | AGN & quasar cone-search layer | CDS, Strasbourg, via VizieR TAP (`tapvizier.cds.unistra.fr`) |
| **NASA Exoplanet Archive** | Confirmed exoplanets layer | NASA/IPAC, operated by Caltech, via TAP (`exoplanetarchive.ipac.caltech.edu/TAP`) |
| **Sesame** | Name resolution for search | CDS, Strasbourg (queries SIMBAD, NED, VizieR) |
| **Messier / NGC / IC** | Eagerly-loaded bright-object markers | Curated from standard published J2000 coordinates (SEDS/OpenNGC-derived) |
| **BlackCAT catalog** (Corral-Santana et al. 2016, A&A 587, A61) | Stellar-mass black hole X-ray binaries | See `data/blackholes_stellar.json` for per-object literature citations |
| **Event Horizon Telescope / GRAVITY Collaboration** | Sgr A* and M87* flagship entries | EHT Collaboration 2019/2022; GRAVITY Collaboration 2019/2022 |
| **LIGO/Virgo/KAGRA GWTC** | Gravitational-wave merger events | See `data/blackholes_gw_mergers.json` for per-event citations |

Every curated JSON file carries a `source` field per entry, and an
`approx: true` flag wherever the literature disagrees or a value (especially
sky-localization centroids for GW events) is only approximate rather than
precise.

## Object media (photographs → artist impressions → renders)

Famous objects show the best media humanity has, in strict priority order:

1. **Real photographs** where they exist — all eight planets + Pluto from
   MESSENGER/Mariner/Rosetta/Hubble/Cassini/Voyager/New Horizons, Hubble
   showpieces (Orion, Andromeda, Crab, Whirlpool, Pillars of Creation),
   ALMA's resolved disk of Betelgeuse, and the two real Event Horizon
   Telescope black hole images (M87* 2019, Sgr A* 2022). Served from
   Wikimedia Commons via the stable `Special:FilePath` endpoint, credited
   on screen per image.
2. **Official artist impressions** (ESO/NASA) for famous exoplanets
   (51 Peg b, HD 189733 b, Proxima b, Kepler-452b).
3. **Procedural WebGL renders** (`js/render3d.js`) for everything else —
   sphere shading per planet class, blackbody-correct star colors from
   published T_eff, ring occlusion, and a black hole visualization with
   event-horizon shadow, photon ring, and doppler-beamed accretion disk.
   Also the automatic live fallback if a photograph fails to load.

Commons filenames were verified by search in July 2026 but could not be
fetched from the development sandbox (network policy); if any filename
drifts, the UI degrades to the procedural render without a broken image.

## Known limitations

- **This was built and tested in a network-sandboxed environment.** The
  sandbox's outbound network policy blocks the CDS, NASA/IPAC and VizieR
  domains this app depends on, so while every integration was written against
  each service's real, documented API (HiPS survey IDs, TAP/ADQL endpoints,
  Sesame resolver), **it could not be exercised against live traffic during
  development.** Please verify end-to-end behavior (tile loading, TAP
  queries, search) the first time you run it with real internet access, and
  file corrections for any endpoint/column-name drift — CDS occasionally
  renames HiPS catalog service paths and VizieR table columns.
- **Gravitational-wave sky localizations are illustrative only.** Real
  LIGO/Virgo localization regions are irregular and span tens to hundreds of
  square degrees; the marker positions in `data/blackholes_gw_mergers.json`
  are single illustrative points inside the published credible region, not
  precise coordinates.
- **Planet positions are geometric, not apparent.** The self-contained
  ephemeris (`js/planets.js`) uses the standard JPL low-precision Keplerian
  elements table (1800–2050 AD validity) with no light-time, aberration, or
  nutation correction. Cross-validated against the VSOP87-based
  `astronomy-engine`: Sun and most planets agree to ≲1′, Jupiter/Saturn to
  ~10′ worst-case (the table's documented weakness), the Moon to ~5′ typical
  after correcting its of-date series to J2000. Positions are computed once,
  at app launch; a long-lived tab will slowly drift (Moon ~0.5°/hour) until
  reloaded.
- **Messier/NGC/IC layer is a curated subset, not the full NGC/IC catalogs.**
  It includes all 110 Messier objects plus roughly 30 additional famous
  NGC/IC objects — not the complete ~13,000-object NGC/IC catalogs.
- **Stellar-mass black hole masses/distances vary across the literature.**
  Several BlackCAT entries (e.g. GX 339-4, V4641 Sgr, GS 1354-64) have
  significant, still-debated uncertainty in mass and distance; these are
  marked `approx: true` with the specific source cited.
- **The NASA Exoplanet Archive's TAP service sends no CORS headers**, so
  browsers cannot query it directly. The exoplanet layer therefore loads a
  repo-bundled snapshot (`data/exoplanets_snapshot.csv`) that a GitHub
  Action refreshes weekly, with a silent live-TAP upgrade attempt in case
  the archive ever enables browser access.
- **AGN/quasar layer depends on a live VizieR cone search**, since Milliquas
  has no ready-made progressive HiPS catalog service (unlike SIMBAD/Gaia). If
  VizieR's TAP schema for VII/294 differs from what's queried here, the layer
  will show a toast and disable itself for the session rather than retry
  indefinitely.
- Overlay cross-fade blending depends on Aladin Lite's multi-layer image API;
  if unavailable in a given Aladin Lite build, base-survey switching still
  works and a hint is shown in the layer rail.

## Roadmap

- Verify and, if needed, correct HiPS survey IDs / TAP column names against
  live CDS/VizieR/NASA endpoints once network access is available.
- Add a full NGC/IC catalog (progressive, not eager) once a suitable
  HiPS catalog service endpoint is confirmed.
- Expand the black hole layer with intermediate-mass black hole candidates
  (e.g. in dense globular clusters) as the literature matures.
- Add unit conversion toggles (magnitude systems, distance units).
- Offline/cached tile fallback for intermittent connectivity.

## Non-goals

No user accounts, no backend, no database, no telescope control, no live
JWST pointing feed, no 3D flythrough mode — by design.
