// Deep Sky Atlas — constellation stick figures + name labels. The general
// public navigates the sky by constellations, not coordinates, so this layer
// defaults on: thin, low-contrast lines that orient without shouting.

import { fetchJSON } from './net.js';
import { showToast } from './ui.js';

/** Returns [overlay, labelCatalog] (both toggleable via show/hide). */
export async function loadConstellations(aladin) {
  let data;
  try {
    data = await fetchJSON('data/constellations.json');
  } catch (err) {
    showToast('Could not load constellation figures.', 'error');
    return { catalogs: [], count: 0 };
  }

  const overlay = A.graphicOverlay({ color: 'rgba(122, 160, 255, 0.32)', lineWidth: 1.4 });
  aladin.addOverlay(overlay);

  // Invisible 1×1 marker per figure, used purely to carry the name label.
  const blank = document.createElement('canvas');
  blank.width = blank.height = 2;
  const labels = A.catalog({
    name: 'Constellation names',
    shape: blank,
    sourceSize: 2,
    displayLabel: true,
    labelColumn: 'name',
    labelColor: 'rgba(150, 172, 224, 0.55)',
    labelFont: '11px -apple-system, sans-serif',
    onClick: null
  });
  aladin.addCatalog(labels);

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  for (const fig of data.figures) {
    // Spherical mean via unit vectors — a plain RA average would put the
    // label for figures crossing RA 0 (Pegasus) on the far side of the sky.
    let x = 0, y = 0, z = 0;
    for (const line of fig.lines) {
      overlay.add(A.polyline(line));
      for (const [ra, dec] of line) {
        x += Math.cos(dec * D2R) * Math.cos(ra * D2R);
        y += Math.cos(dec * D2R) * Math.sin(ra * D2R);
        z += Math.sin(dec * D2R);
      }
    }
    let ra = Math.atan2(y, x) * R2D;
    if (ra < 0) ra += 360;
    const dec = Math.atan2(z, Math.hypot(x, y)) * R2D;
    labels.addSources([A.source(ra, dec, { name: fig.name })]);
  }

  return { catalogs: [overlay, labels], count: data.figures.length };
}
