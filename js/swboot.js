// Project Planetarium — service-worker bootstrap. Loaded from index.html
// (the one file that is always network-first and therefore always fresh)
// rather than from app.js, which is cache-first and can be a version
// behind — a stale app.js can't be trusted to notice its own staleness.
// External same-origin file (was inline) so the Content-Security-Policy
// needs no 'unsafe-inline' for scripts.
//
// Every load forces a cache-bypassing re-check of sw.js (reg.update()
// ignores the HTTP cache; GitHub Pages' max-age=600 on sw.js otherwise
// delays pickup, and iOS PWAs re-check lazily). When a NEW version's
// worker takes over mid-session, reload once so the page runs matching
// assets instead of fresh HTML on stale CSS/JS.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // First-ever install also fires this (clients.claim); only reload on
    // a genuine version change, and only once per session (loop guard).
    if (!hadController) return;
    try {
      if (sessionStorage.getItem('dsa-swreloaded')) return;
      sessionStorage.setItem('dsa-swreloaded', '1');
    } catch (err) { return; }
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then((reg) => reg.update())
    .catch((err) => {
      // Shell caching is optional — the app runs fine without it — but a
      // failed install must be VISIBLE (console + the ?debug=1 pane), not
      // silently degrade offline support.
      console.warn('Service worker registration failed (offline support disabled):', err?.message || err);
    });
}
