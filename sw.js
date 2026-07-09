// Pocket Planetarium — service worker: caches the app shell (HTML/CSS/JS/data/
// icons) so revisits and the installed PWA start instantly. All sky data —
// HiPS tiles, TAP queries, photographs — is cross-origin and passes straight
// through to the network, always live.
//
// Strategy: EVERYTHING same-origin is network-first with cache fallback.
// Stale-while-revalidate was tried first and burned us badly: it serves the
// previous deploy's JS on the first load after every update, so users test
// fixes one version behind. Network-first costs a conditional request per
// asset (cheap 304s via Pages etags) and guarantees fresh code; the cache
// exists purely to keep the installed PWA working offline.

// NOTE: never list Action-generated data files (exoplanets_snapshot,
// constellations_lines/names/borders) here — they may not exist on a fresh
// deploy and one 404 fails the entire install. Runtime caching covers them.
const VERSION = 'dsa-shell-v21';

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/blackholes.js',
  'js/catalogs.js',
  'js/constellations.js',
  'js/markers.js',
  'js/net.js',
  'js/planets.js',
  'js/render3d.js',
  'js/search.js',
  'js/skynow.js',
  'js/spectrum.js',
  'js/suggest.js',
  'js/ui.js',
  'js/warp.js',
  'data/blackholes_gw_mergers.json',
  'data/blackholes_stellar.json',
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

  const cacheKey = e.request.mode === 'navigate' ? './' : e.request;
  // cache:'no-cache' forces an etag revalidation instead of trusting the HTTP
  // cache. Without it, GitHub Pages' max-age=600 lets "network-first" hand
  // back files cached at different moments — a stale index.html alongside a
  // fresh app.js crashes boot right after every deploy. (Navigations must be
  // re-requested by URL: fetch() rejects init options on mode:'navigate'.)
  const fresh = e.request.mode === 'navigate'
    ? fetch(e.request.url, { cache: 'no-cache' })
    : fetch(e.request, { cache: 'no-cache' });
  e.respondWith(
    fresh
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(cacheKey, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(cacheKey).then((hit) => hit || Response.error())
      )
  );
});
