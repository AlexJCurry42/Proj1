# Project Planetarium — architecture

A static, build-free web app: plain ES modules, HTML and CSS, deployed as
files. No backend, no API keys, no accounts, no analytics. This document
maps the moving parts and the boundaries between them.

## Rendering

- **Sky imagery**: [Aladin Lite v3](https://github.com/cds-astro/aladin-lite)
  (v3.9.0-beta, **bundled** at `js/vendor/aladin/`, LGPL-3.0-or-later). A
  WebAssembly/WebGL core streams HiPS tiles and draws the celestial sphere.
  The app disables all engine chrome and drives it through its public API.
  A lost WebGL context is unrecoverable by the engine; `js/app.js` listens
  for it and surfaces a reload banner.
- **Overlay engine** (`js/overlay.js`): ONE full-viewport 2D canvas and ONE
  animation loop shared by every drawn layer (star bloom, grid, horizon,
  constellations, satellites, marker fades, ID bubble). Layers register
  `draw(ctx, view, state)` with a z-order; the loop idles completely when
  nothing is visible or animating, throttles its view polling at rest, and
  caches world→pixel projections per frame (the wasm boundary is the
  expensive part).
- **Procedural renders** (`js/render3d.js`): one shared WebGL fragment
  shader draws planet/star/black-hole illustrations in the detail panel;
  real photographs (Wikimedia Commons) take precedence when curated in
  `data/renders.json`.
- **Cosmic web 3-D mode** (`js/cosmos3d.js` + `js/desidata.js`): a
  full-viewport WebGL point cloud of ~400k real DESI DR1 redshifts
  (comoving positions, Earth at origin) with orbit/dolly controls —
  a separate MODE, since a 3-D volume cannot live on Aladin's sphere.
  Dependency-free (own 4×4 matrix math); module and its ~3 MB dataset
  load lazily on the first dock flip, never at boot.

## Coordinate systems

- Everything user-facing is **ICRS J2000** decimal degrees; RA is displayed
  sexagesimally (`js/ui.js` formatters).
- `js/astro.js`: J2000 ↔ alt-az for the observer (horizon layer, Sky Now,
  time-lapse camera), rise/set, angular separations.
- `js/constellation.js`: IAU constellation determination — J2000 is
  precessed to **B1875** (the epoch the IAU zone borders are defined in),
  then looked up in the VI/42 zone table.
- The time-lapse camera (`js/timesky.js`) holds the user's line of sight
  fixed in their **local frame** while the app clock moves: alt-az of the
  view center is captured at each tick and re-projected at the new time.

## State & persistence

- `js/clock.js` is the single app clock (real time + scrub offset +
  play rate); every time-dependent layer subscribes to it.
- `js/prefs.js` is the single localStorage codec (namespace `dsa-`).
- View state (mode, zoom floors, permalink hash) lives in
  `js/viewstate.js`; the layer dock and its lazy loading in
  `js/layersdock.js`; `js/app.js` is boot sequencing and wiring only.

## Data pipelines

Two kinds of data, deliberately separated:

1. **Bundled snapshots** (`data/…`, committed): refreshed by
   `.github/workflows/data-refresh.yml` on schedules (TLEs daily,
   exoplanets weekly, catalogs monthly), each with format validation and
   known-object sanity checks before commit, and per-file provenance
   (sha256, source, timestamp, run id) in `data/PROVENANCE.json`.
   Served with stale-while-revalidate by the service worker and
   deduplicated per session by `js/net.js`.
2. **Live queries** (never persisted): SIMBAD TAP cone searches (object
   details, live layers), VizieR TAP (quasars), Sesame (name resolution).
   All carry timeouts + one retry (`js/net.js`) and toast a clear failure
   (including an explicit offline message) without breaking the app.

## External provider boundaries

| Provider | What crosses the wire | When |
|---|---|---|
| CDS `alasky` | HiPS imagery tiles | continuously while panning |
| CDS SIMBAD/VizieR/Sesame | TAP/name queries | object taps, search, live layers |
| Wikimedia Commons | photographs | detail panel of famous objects |
| NASA Exoplanet Archive, CelesTrak, OpenNGC, VizieR | dataset snapshots | **GitHub Actions only** — never from users' browsers |
| Wikipedia (REST API) | two-sentence object descriptions (CC BY-SA 4.0, attributed in-app) | **GitHub Actions only** — bundled as `data/descriptions.json` |
| NOIRLab Astro Data Lab | DESI DR1 redshift subsample for the 3-D mode | **GitHub Actions only** — bundled as `data/desi_web.bin` |

The user's precise location never crosses any boundary: alt-az math is
entirely on-device.

## Caching & offline

- `sw.js`: versioned cache-first app shell (HTML/CSS/JS/data/icons —
  including the bundled engine, so offline startup is complete),
  network-first navigations, stale-while-revalidate for `data/`, and a
  hard bypass for media/Range requests (iOS audio). The shell VERSION and
  the About panel's `js/version.js` are hand-synced; a unit test fails CI
  if they drift.
- Update flow: `js/swboot.js` (loaded from the always-fresh index.html)
  forces a cache-bypassing worker update check every load and reloads once
  when a new version takes over.

## Security posture

- CSP (meta tag — GitHub Pages cannot set headers): scripts from `'self'`
  only (+`wasm-unsafe-eval` for the engine core); no inline scripts; no
  objects; `base-uri 'self'`. All user/data-derived strings reach the DOM
  via `textContent` or an HTML escaper. ESLint enforces the
  no-dynamic-code family in CI; CodeQL runs on pushes and weekly.

## Testing

- `tests/unit.mjs` — pure-math/deterministic (astro, ephemeris, clock,
  SGP4, parsing, version consistency); runs on every push.
- `tests/browser/run.mjs` — 13 scenarios of the real app + the bundled
  engine, in headless Chromium **and headless WebKit** (the closest CI
  proxy for iOS Safari, where the app's real users are); runs on every
  code push. The pre-release on-device pass is `docs/DEVICE-CHECKLIST.md`.
- `tests/health-check.mjs` — replays every LIVE service call; scheduled
  daily and dispatchable, **never** on push, so provider outages cannot
  redden code changes.
