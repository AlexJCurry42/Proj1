// Pocket Planetarium — bundled Aladin Lite loader. The engine ships WITH
// the app (js/vendor/aladin/aladin.js, v3.9.0-beta, LGPL-3.0-or-later,
// source: https://github.com/cds-astro/aladin-lite) instead of arriving
// from the mutable /latest/ CDN URL: no upstream release can change or
// break the app unreviewed, the CSP needs no external script origin, and
// offline startup is complete once the service worker holds the shell.
// The classic-script contract is preserved: the module sets window.A and
// executes before js/app.js (module scripts run in document order).
import A from './aladin.js';
window.A = A;
