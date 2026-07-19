// Pocket Planetarium — service worker: caches the app shell (HTML/CSS/JS/data/
// icons) so revisits and the installed PWA start instantly. All sky data —
// HiPS tiles, TAP queries, photographs — is cross-origin and passes straight
// through to the network, always live.
//
// Strategy, per resource class (this ordering is why warm loads are fast):
//  · navigations — network-first (a fresh index.html whenever online),
//    cache fallback offline;
//  · Action-refreshed data (data/…) — stale-while-revalidate: served from
//    cache instantly, refreshed in the background for next time (these
//    files change without a VERSION bump, so cache-first would stick);
//  · versioned shell (js/css/icons) — CACHE-FIRST: immutable within a
//    VERSION, zero network round-trips on warm loads. Deploys bump VERSION,
//    the browser re-checks sw.js on navigation, the new worker installs a
//    fresh cache and takes over — and app.js reloads the page once when
//    that happens mid-session, so "test right after deploy" still works.
// (Pure network-first was the previous strategy; it paid one conditional
// request per asset per load — dozens of RTTs on mobile, felt like bloat.)

// NOTE: never list Action-generated data files (exoplanets_snapshot,
// constellations_lines/names/borders) here — they may not exist on a fresh
// deploy and one 404 fails the entire install. Runtime caching covers them.
// Bump together with js/version.js (shown in the About panel).
const VERSION = 'dsa-shell-v75';

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/astro.js',
  'js/blackholes.js',
  'js/catalogs.js',
  'js/clock.js',
  'js/dock.js',
  'js/conesearch.js',
  'js/constellations.js',
  'js/horizon.js',
  'js/markerfade.js',
  'js/markers.js',
  'js/motion.js',
  'js/net.js',
  'js/observer.js',
  'js/overlay.js',
  'js/planets.js',
  'js/planetslayer.js',
  'js/prefs.js',
  'js/render3d.js',
  'js/iss.js',
  'js/loccard.js',
  'js/centerid.js',
  'js/constellation.js',
  'js/grid.js',
  'js/version.js',
  'js/search.js',
  'js/searchui.js',
  'js/skynow.js',
  'js/sound.js',
  'js/spectrum.js',
  'js/starbloom.js',
  'js/suggest.js',
  'js/timesky.js',
  'js/timeui.js',
  'js/ui.js',
  'js/vendor/satellite/common-types.js',
  'js/vendor/satellite/constants.js',
  'js/vendor/satellite/ext.js',
  'js/vendor/satellite/io.js',
  'js/vendor/satellite/propagation.js',
  'js/vendor/satellite/transforms.js',
  'js/vendor/satellite/propagation/SatRec.js',
  'js/vendor/satellite/propagation/dpper.js',
  'js/vendor/satellite/propagation/dscom.js',
  'js/vendor/satellite/propagation/dsinit.js',
  'js/vendor/satellite/propagation/dspace.js',
  'js/vendor/satellite/propagation/gstime.js',
  'js/vendor/satellite/propagation/initl.js',
  'js/vendor/satellite/propagation/propagate.js',
  'js/vendor/satellite/propagation/sgp4.js',
  'js/vendor/satellite/propagation/sgp4init.js',
  'data/blackholes_stellar.json',
  'data/brightstars_seed.json',
  'data/blackholes_supermassive.json',
  'data/constellations.json',
  'data/messier_ngc.json',
  'data/object_types.json',
  'data/renders.json',
  'data/tours.json',
  'assets/icon-180.png',
  'assets/icon-192.png',
  'assets/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // sky data: always live

  // Media MUST bypass the worker: iOS fetches audio with Range headers and
  // rejects the full-body 200 a cache respondWith() would produce — the
  // Easter egg track simply refused to play through the old handler.
  if (e.request.headers.get('range') !== null || url.pathname.endsWith('.mp3')) return;

  // Navigations: network-first so a fresh deploy's index.html is never
  // missed; cache fallback keeps the installed PWA opening offline.
  // (cache:'no-cache' forces etag revalidation past GitHub Pages'
  // max-age=600; navigations must be re-requested by URL because fetch()
  // rejects init options on mode:'navigate'.)
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request.url, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put('./', copy));
          }
          return res;
        })
        .catch(() => caches.match('./').then((hit) => hit || Response.error()))
    );
    return;
  }

  // Action-refreshed data: stale-while-revalidate — instant from cache,
  // silently refreshed behind for the next load.
  if (url.pathname.includes('/data/')) {
    e.respondWith(
      caches.open(VERSION).then(async (c) => {
        const hit = await c.match(e.request);
        const refresh = fetch(e.request, { cache: 'no-cache' })
          .then((res) => {
            if (res.ok) c.put(e.request, res.clone());
            return res;
          })
          .catch(() => null);
        return hit || refresh.then((res) => res || Response.error());
      })
    );
    return;
  }

  // Versioned shell: cache-first. Immutable within a VERSION — a warm load
  // costs zero network round-trips.
  e.respondWith(
    caches.match(e.request).then((hit) => hit ||
      fetch(e.request, { cache: 'no-cache' }).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
    )
  );
});
