# Deep Sky Atlas

An interactive, browser-based atlas of the entire sky — imagery across the
electromagnetic spectrum, stars, galaxies, nebulae, exoplanets, Solar System
planets, and a dedicated **black holes** layer covering stellar-mass X-ray
binaries, supermassive/AGN & quasars (including the two EHT-imaged flagships,
Sgr A* and M87*), and notable gravitational-wave mergers.

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
index.html          Page shell: top bar, layer rail, sky view, detail panel
css/style.css        Dark theme, responsive layout, red-light mode
js/app.js            App entry point: wires up Aladin, layers, readouts, search
js/catalogs.js       SIMBAD/Gaia HiPS catalogs, Messier/NGC-IC, exoplanets
js/blackholes.js      Stellar-mass BHs, supermassive/AGN & quasars, GW mergers
js/planets.js         Self-contained Solar System ephemeris (no external calls)
js/search.js          CDS Sesame name resolver + coordinate parsing
js/ui.js              Detail panel, toasts, tours, onboarding, about modal
js/net.js             Shared fetch-with-timeout-and-retry helper
data/*.json           Curated black hole, GW merger, tour and catalog data
```

## Data sources & attribution

| Source | Used for | Citation |
|---|---|---|
| **Aladin Lite** | Sky rendering, HiPS tile streaming, progressive catalogs | CDS, Observatoire astronomique de Strasbourg, CNRS/Université de Strasbourg |
| **DSS2, SDSS9, 2MASS, AllWISE, Pan-STARRS DR1, Fermi, NVSS** (HiPS) | Imagery layers | Distributed via the CDS HiPS service; see each survey's own citation guidelines |
| **SIMBAD** | Progressive object catalog + on-demand object detail lookups | CDS, Strasbourg, via SIMBAD TAP (`simbad.cds.unistra.fr/simbad/sim-tap/sync`) |
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
  elements table (1800–2050 AD validity), accurate to a few arcminutes, with
  no light-time, aberration, or nutation correction.
- **Messier/NGC/IC layer is a curated subset, not the full NGC/IC catalogs.**
  It includes all 110 Messier objects plus roughly 30 additional famous
  NGC/IC objects — not the complete ~13,000-object NGC/IC catalogs.
- **Stellar-mass black hole masses/distances vary across the literature.**
  Several BlackCAT entries (e.g. GX 339-4, V4641 Sgr, GS 1354-64) have
  significant, still-debated uncertainty in mass and distance; these are
  marked `approx: true` with the specific source cited.
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
