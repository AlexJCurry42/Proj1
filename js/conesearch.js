// Project Planetarium — the live cone-search layer skeleton, shared by every
// layer that re-queries a TAP service around the view center as the user
// pans and zooms (SIMBAD galaxies, SIMBAD black holes, VizieR Milliquas
// AGN/quasars). One implementation of the debounce, the view-key dedupe,
// the one-shot failure handling, the wide-field hint, and the query shutoff
// while the layer is hidden.

import { showToast } from './ui.js';

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/**
 * opts:
 *   name, shape, sourceSize     — engine catalog config
 *   maxRadiusDeg (default 4)    — cone cap at wide fields
 *   hint                        — one-time toast when enabled very zoomed-out
 *   failMsg                     — one-shot toast when the endpoint is down
 *   fetchSources(ra, dec, radiusDeg) → Promise<A.source[]>
 */
export function makeConeLayer(aladin, onZoom, onPosition, opts) {
  const cat = A.catalog({
    name: opts.name,
    shape: opts.shape,
    sourceSize: opts.sourceSize,
    onClick: null
  });
  aladin.addCatalog(cat);

  let lastKey = '';
  let failed = false;
  let enabled = true;
  let hinted = false;
  let seq = 0; // the debounce spaces LAUNCHES, not landings: a slow query
               // can still land after a newer one — only the newest applies

  async function refresh() {
    if (failed || !enabled) return; // dead endpoint or layer toggled off: no queries
    let ra, dec, fov;
    try { [ra, dec] = aladin.getRaDec(); fov = aladin.getFov()[0]; } catch (err) { return; }
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) return;
    const radius = Math.min(Math.max(fov / 2, 0.05), opts.maxRadiusDeg ?? 4);
    if (!hinted && fov > 60 && opts.hint) {
      hinted = true;
      showToast(opts.hint, 'info', 6000);
    }
    const key = `${ra.toFixed(2)},${dec.toFixed(2)},${radius.toFixed(2)}`;
    if (key === lastKey) return;
    lastKey = key;
    const token = ++seq;

    try {
      const sources = await opts.fetchSources(ra, dec, radius);
      if (token !== seq || !enabled) return; // superseded, or switched off mid-flight
      if (typeof cat.removeAll === 'function') cat.removeAll();
      cat.addSources(sources);
    } catch (err) {
      if (token !== seq) return;
      failed = true;
      showToast(opts.failMsg, 'error');
    }
  }

  onPosition(debounce(refresh, 250));
  onZoom(debounce(refresh, 250));
  refresh();
  // Lets the layer toggle stop live queries entirely while hidden.
  cat.dsaSetEnabled = (v) => {
    enabled = v;
    // A transient error (even our own 10 s timeout mid-pan) latches
    // `failed`; a deliberate re-toggle is the user asking for one more
    // try — grant it without giving up the anti-hammer property.
    if (v) { failed = false; lastKey = ''; refresh(); }
  };
  return cat;
}
