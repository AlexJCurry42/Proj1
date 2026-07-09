// Deep Sky Atlas — service worker: caches the app shell (HTML/CSS/JS/data/
// icons) so revisits and the installed PWA start instantly. All sky data —
// HiPS tiles, TAP queries, photographs — is cross-origin and passes straight
// through to the network, always live.
//
// Strategy: navigations are network-first (so a deploy is picked up on the
// next load) with cache fallback for offline; same-origin assets are served
// stale-while-revalidate.

// NOTE: never list Action-generated data files (exoplanets_snapshot,
// constellations_lines/names/borders) here — they may not exist on a fresh
// deploy and one 404 fails the entire install. Runtime caching covers them.
const VERSION = 'dsa-shell-v2';

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
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
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

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('./', copy));
          return res;
        })
        .catch(() => caches.match('./'))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((hit) => {
      const refresh = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});
