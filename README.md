# Pocket Planetarium

**Pocket Planetarium** (formerly Deep Sky Atlas): an interactive, browser-based atlas of the entire sky — imagery across the
electromagnetic spectrum, stars, galaxies, nebulae, exoplanets, Solar System
planets, the ISS overhead, and a dedicated **black
holes** layer covering stellar-mass X-ray binaries and supermassive black
holes (28 curated measured entries including the two EHT-imaged flagships,
plus the full live AGN/quasar population).

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
boundaries), a **horizon & compass overlay** — on by default — that
draws YOUR horizon, cardinal directions and zenith on the sky, plus a
moderate **horizon lock** that gently re-levels the view after each pan
settles, so "up" stays up (it waits out drags and inertia flings, fades
out entirely when zoomed onto an object, and never undoes a deliberate
two-finger rotation: an assist, not a cage),
an adaptive **coordinate grid** (a custom RA/Dec graticule: spacing
cross-fades continuously with zoom, coordinate labels are pinned to the
screen edges so the scale readout sits still, and the lines curve
exactly as the projection does, making any distortion visible),
guided **tours** that fly
three-act flights to the sky's greatest hits, the complete **NGC/IC
catalog** (~13,000 objects, magnitude-tiered by zoom), live
the **ISS** with live pass predictions (SGP4, computed on-device — part
of the Solar System layer, appearing once your location is known),
and **Sky Now** — one tap flies to your zenith, and with the compass
toggle on, the view tracks the phone live (sensor-smoothed gyro +
compass, computed entirely on-device). A **time scrubber** (the clock
button) shows the sky for any date and time — and can PLAY it: time-lapse
the whole sky at a minute, an hour, or a day per second — Solar System positions,
the horizon overlay, the ISS and Sky Now all follow one shared app
clock, with an amber chip marking the shift. Once your location is
known the scrubber is a true planetarium: the camera holds your line
of sight in YOUR sky, so setting a date turns the heavens to that
moment and playback streams the stars wheeling across the view in
real time. Once your location is
known, every object's detail panel adds **visible-tonight rows**: is it
up right now, and when does it rise and set from where you stand. Two
projections: orbit the celestial sphere from outside, or stand inside
it, planetarium style.

A faint **center crosshair** marks the view center, and whenever a known
deep-sky object — a Messier or curated NGC/IC showpiece, or any tour
destination — sits under it, a small card names it (type, catalog id, and
the full description when one is known); zoomed in close, a subtle
**bubble label** also pins the name and type beside the object itself,
moving with the sky. Identification is a property of the view itself: it
works even when that object's layer is switched off (and it stands down
politely when a tour's toast has already announced the destination).

Object detail panels carry the full record: type, coordinates, magnitude,
spectral type, distance, **constellation** (the official IAU
determination — Roman 1987 zones after precessing to B1875, not a
nearest-label guess), visible-tonight rows, and SIMBAD/NED/Wikipedia
links. First-timers get a one-time, non-blocking **tips card**, a
tappable coordinates readout that explains RA/Dec, and a **controls
sheet** (press ?) listing gestures and keyboard shortcuts
(/ search, + − zoom, Esc close).

Also: instant search suggestions from the curated catalogs, shareable
permalinks for any view (plus a native share button), installable as a
PWA with an offline-cached shell, red-light night-vision mode, an
**Animations switch** in the layer dock (on by default for everyone;
flipping it off makes every flight, fade, reveal and CSS transition
instant, persistently), always-on **imagery sharpening** (a strong
two-scale optical unsharp mask over the sky — pure local contrast,
never invented detail, disclosed in the About panel), and preferences
that persist locally. **No tracking, no analytics, no
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
css/style.css        Liquid-glass design system, one --spring motion token
js/app.js            App entry point: engine init + module composition
js/dock.js           Layer-dock building blocks: toggles, sections, collapse
js/timeui.js         Time scrubber UI: picker, time-lapse play, amber chip
js/planetslayer.js   Solar System markers (Sun/Moon/planets) on the engine
js/searchui.js       Search box UX: recents, suggestions, submit flow
js/loccard.js        In-app location consent card (no cold browser prompts)
js/centerid.js       Crosshair identification: names the known object at center
js/overlay.js        UNIFIED overlay engine: one canvas + one loop for every
                     sky-drawn layer (goes fully idle when nothing animates)
js/astro.js          Shared spherical math: vectors, alt-az↔RA/Dec, GMST, rise/set
js/clock.js          Shared app clock: the time scrubber's single source of truth
js/prefs.js          Shared localStorage preferences (one namespace/codec)
js/observer.js       Shared geolocation (one permission flow, session cache)
js/conesearch.js     Shared live TAP cone-search layer skeleton
js/markerfade.js     Marker cross-fades for layer toggles (overlay layer)
js/spectrum.js       Vertical spectrum rail: scrub imagery gamma-ray → radio
js/skynow.js         Sky Now + gyro/compass tracking (all math on-device)
js/horizon.js        Local horizon, cardinal directions & zenith (overlay layer)
js/iss.js            The ISS in the Solar System layer: live SGP4 (overlay)
js/starbloom.js      "Clean bright stars": catalog glows over plate artifacts
js/vendor/satellite/ Vendored satellite.js SGP4 submodules (MIT)
js/constellations.js 88 constellations: figures, names, boundaries (overlay layer)
js/catalogs.js       SIMBAD/Gaia layers, Deep sky (Messier+OpenNGC), exoplanets
js/blackholes.js     Stellar-mass + supermassive BHs, live AGN/quasars
js/planets.js        Self-contained Solar System ephemeris (no external calls)
js/search.js         CDS Sesame name resolver + coordinate parsing
js/suggest.js        Instant search suggestions from the curated catalogs
js/ui.js             Detail panel, toasts, sky destinations, about modal
js/render3d.js       WebGL procedural 3-D renders (planets, stars, black holes)
js/markers.js        Shared catalog-marker helpers
js/net.js            Shared fetch-with-timeout-and-retry helper
sw.js                Service worker: cache-first shell, SWR data (offline PWA)
data/*.json|csv|txt  Curated + Action-refreshed data
tests/unit.mjs       Unit tests: astro math, ephemeris, clock, SGP4 (plain Node)
tests/health-check.mjs  Live-endpoint health check (replays every service call)
tests/browser/run.mjs   Browser regression suite (real engine, headless Chromium)
package.json         No dependencies — exists so Node runs the tests as ES modules
.github/workflows/   ONE data pipeline (data-refresh.yml) + tests/health checks
```

## Tests

Both suites are dependency-free — plain Node ≥ 18, nothing to install:

```sh
node tests/unit.mjs          # pure math: sidereal time, transforms, rise/set,
                             # the ephemeris (anchored to equinox/solstice
                             # ground truth), the app clock, vendored SGP4
node tests/health-check.mjs  # live: replays every CDS/VizieR/NASA/CelesTrak/
                             # Commons call the app makes, exact queries and
                             # columns, and fails on drift
```

`.github/workflows/health-check.yml` runs both daily (and on any push that
touches `tests/`), so endpoint drift — TAP column renames, retired HiPS IDs,
moved Commons files — surfaces in the Actions tab instead of in a user's
browser.

Browser-level behavior is covered by the committed regression suite:

```sh
node tests/browser/run.mjs    # the real app + the real Aladin engine in
                              # headless Chromium: boot budget, lazy layers,
                              # flights, star bloom, horizon lock, spectrum
                              # fades, time-lapse, location consent
```

It needs Playwright (`npm i --no-save playwright`) and downloads the engine
bundle once into `tests/browser/.cache/`.
`.github/workflows/browser-tests.yml` runs it on every push that touches the
app's code.

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
| **OpenNGC** | Full NGC/IC catalog layer (~13,000 objects) | Mattia Verga, CC-BY-SA-4.0, `github.com/mattiaverga/OpenNGC` (monthly snapshot) |
| **CelesTrak** | ISS + bright satellite orbital elements (TLEs) | Dr. T.S. Kelso, `celestrak.org` (daily snapshot); propagated on-device with SGP4 (`satellite.js`, MIT) |
| **Yale Bright Star Catalogue (V/50) + Tycho-2 (I/259)** | "Clean bright stars" bloom overlay (positions, V magnitudes, B−V colors); bright tier loads with the app, the faint Tycho-2 tier lazy-loads on idle | Hoffleit & Warren 1991; Høg et al. 2000 — via VizieR TAP (monthly snapshot; curated seed until first fetch) |

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
  domains this app depends on, so every integration was written against
  each service's real, documented API but could not be exercised against
  live traffic during development. The daily health-check Action
  (`tests/health-check.mjs`) now replays every live call — exact queries,
  exact column names — so endpoint drift is caught within a day; check the
  Actions tab if a live layer misbehaves.
- **Bright stars show colored blotched cores in DSS2 — at any deep zoom.**
  This is in the survey data, not the renderer: bright stars saturated the
  photographic emulsion, the red and blue plate exposures were taken years
  apart (so their star images are misaligned), and the JPEG tile encoding
  adds chroma blocking on the clipped cores. The per-survey zoom floors stop
  *over*-magnification of plate grain, but a resolved bright-star core shows
  its artifacts at legitimate zooms too. The app explains this once, in
  context, and ships the classic planetarium cure as a default-on
  **"Clean bright stars"** checkbox (layer dock → Display): a synthetic
  glow — positioned, sized and tinted from the Yale Bright Star Catalogue —
  covers the saturated cores. Because it retouches the view, it is always
  one tap from off, and the raw observations are never altered underneath.
- **The ISS position depends on TLE freshness.** SGP4 accuracy decays
  within days of the element epoch; the daily CelesTrak snapshot keeps the
  ISS good to well under a degree, but if the Action stops running the app
  warns once the data is >10 days old. ISS "passes" are above-horizon
  windows — actually *seeing* one also requires a dark sky with the station
  sunlit. The marker appears only once your location is known (from the
  horizon consent or Sky Now); it never asks on its own.
- **The NGC/IC layer and the ISS need their data Action to have run**
  (`data-refresh.yml`) — on a fresh fork they show a
  "data refresh pending" note until the workflows commit their snapshots.
- **Planet positions are geometric, not apparent.** The self-contained
  ephemeris (`js/planets.js`) uses the standard JPL low-precision Keplerian
  elements table (1800–2050 AD validity) with no light-time, aberration, or
  nutation correction. Cross-validated against the VSOP87-based
  `astronomy-engine`: Sun and most planets agree to ≲1′, Jupiter/Saturn to
  ~10′ worst-case (the table's documented weakness), the Moon to ~5′ typical
  after correcting its of-date series to J2000. Positions are computed once,
  at app launch (and recomputed whenever the time scrubber moves); a
  long-lived tab will slowly drift (Moon ~0.5°/hour) until reloaded or
  scrubbed.
- **The time-scrubbed ISS is gated.** SGP4 accuracy decays km/day away
  from the TLE epoch, so the ISS hides itself beyond ±5 days of
  time travel rather than plot confident-looking nonsense. Rise/set rows in
  the detail panel treat the object's coordinates as fixed — exact for stars
  and deep-sky objects, approximate for planets, and up to ~½ hour off for
  the fast-moving Moon.
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
  Action refreshes weekly.
- **AGN/quasar layer depends on a live VizieR cone search**, since Milliquas
  has no ready-made progressive HiPS catalog service (unlike SIMBAD/Gaia). If
  VizieR's TAP schema for VII/294 differs from what's queried here, the layer
  will show a toast and disable itself for the session rather than retry
  indefinitely.
- Overlay cross-fade blending depends on Aladin Lite's multi-layer image API;
  if unavailable in a given Aladin Lite build, base-survey switching still
  works and a hint is shown in the layer rail.

## Roadmap

- Act on the daily health-check Action's findings: correct any HiPS survey
  IDs / TAP column names the live replay flags as drifted.
- Expand the black hole layer with intermediate-mass black hole candidates
  (e.g. in dense globular clusters) as the literature matures.
- Add unit conversion toggles (magnitude systems, distance units).
- Offline/cached tile fallback for intermittent connectivity.

## Non-goals

No user accounts, no backend, no database, no telescope control, no live
JWST pointing feed, no 3D flythrough mode — by design.
