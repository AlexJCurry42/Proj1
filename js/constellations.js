// Deep Sky Atlas — constellations, built for stargazers. Primary data is the
// full-88 IAU set (figures, official names + label positions, boundaries)
// from the d3-celestial project (BSD-3-Clause, Stellarium-derived), committed
// into data/ by .github/workflows/constellation-data.yml. If those files are
// missing (first deploy), a curated 21-figure set keeps the layer alive.
//
// Rendering notes learned the hard way:
// - Aladin's overlay color parser is only reliable with hex colors, so no
//   rgba() strings here (labels are canvas-rendered text and CAN use rgba).
// - d3-celestial stores RA in [-180, 180]. After normalizing to [0, 360),
//   any segment jumping >180° in RA is crossing the 0/360 seam and must be
//   split, or the projection draws a line across the entire sky.

import { fetchJSON } from './net.js';
import { showToast } from './ui.js';

const FIGURE_COLOR = '#5d79ad';
const BORDER_COLOR = '#39496b';
const LABEL_COLOR = 'rgba(165, 186, 235, 0.72)';

const normRa = (ra) => ((ra % 360) + 360) % 360;

/**
 * Normalize a GeoJSON MultiLineString: RA to [0,360), split at the 0/360
 * seam WITHOUT losing the crossing stroke — the segment is cut at an
 * interpolated seam point so figures like Pegasus's Great Square stay whole.
 */
export function normalizeMulti(multi) {
  const out = [];
  for (const line of multi) {
    let cur = [];
    let prevRa = null, prevDec = null;
    for (const [raRaw, dec] of line) {
      const ra = normRa(raRaw);
      if (prevRa != null) {
        const delta = ra - prevRa;
        if (Math.abs(delta) > 180) {
          // Unwrap the endpoint, find where the segment hits the seam, and
          // cut there — ending one piece at ~360 and starting the next at ~0
          // (or vice versa) at the interpolated declination.
          const raU = delta > 0 ? ra - 360 : ra + 360;
          const boundary = raU > prevRa ? 360 : 0;
          const t = (boundary - prevRa) / (raU - prevRa);
          const decX = prevDec + t * (dec - prevDec);
          cur.push([boundary === 360 ? 359.9999 : 0.0001, decX]);
          if (cur.length > 1) out.push(cur);
          cur = [[boundary === 360 ? 0.0001 : 359.9999, decX]];
        }
      }
      cur.push([ra, dec]);
      prevRa = ra;
      prevDec = dec;
    }
    if (cur.length > 1) out.push(cur);
  }
  return out;
}

/** show/hide controller that works on every engine build. */
function overlayController(overlay, polylines) {
  let visible = true;
  return {
    show() {
      if (visible) return;
      visible = true;
      if (typeof overlay.show === 'function') { overlay.show(); return; }
      for (const pl of polylines) overlay.add(pl); // refill fallback
    },
    hide() {
      if (!visible) return;
      visible = false;
      if (typeof overlay.hide === 'function') { overlay.hide(); return; }
      if (typeof overlay.removeAll === 'function') overlay.removeAll(); // empty fallback
    }
  };
}

async function loadFigures() {
  // Full-88 dataset first…
  try {
    const [lines, names] = await Promise.all([
      fetchJSON('data/constellations_lines.json'),
      fetchJSON('data/constellations_names.json').catch(() => null)
    ]);
    const nameById = {};
    if (names) {
      for (const f of names.features) {
        nameById[f.id] = {
          name: f.properties?.name || f.id,
          pos: Array.isArray(f.geometry?.coordinates)
            ? [normRa(f.geometry.coordinates[0]), f.geometry.coordinates[1]]
            : null
        };
      }
    }
    return lines.features.map(f => ({
      name: nameById[f.id]?.name || f.id,
      labelPos: nameById[f.id]?.pos || null,
      lines: normalizeMulti(f.geometry.coordinates)
    }));
  } catch (err) {
    // …curated 21-figure fallback (first deploy, before the Action has run).
    const data = await fetchJSON('data/constellations.json');
    return data.figures.map(f => ({ name: f.name, labelPos: null, lines: normalizeMulti(f.lines) }));
  }
}

export async function loadConstellations(aladin) {
  let figures;
  try {
    figures = await loadFigures();
  } catch (err) {
    showToast('Could not load constellation figures.', 'error');
    return { catalogs: [], count: 0 };
  }

  // Lines and labels are built INDEPENDENTLY with per-figure guards, so a
  // failure in one engine call degrades that one piece — never the layer.
  const catalogs = [];
  let firstError = null;
  const note = (err) => { if (!firstError) firstError = err; };

  // ---- figure lines ----
  let drawnFigures = 0;
  try {
    const overlay = A.graphicOverlay({ color: FIGURE_COLOR, lineWidth: 1 });
    aladin.addOverlay(overlay);
    const polylines = [];
    for (const fig of figures) {
      try {
        for (const line of fig.lines) {
          const pl = A.polyline(line);
          polylines.push(pl);
          overlay.add(pl);
        }
        drawnFigures++;
      } catch (err) {
        console.error(`Constellation figure "${fig.name}" failed:`, err);
        note(err);
      }
    }
    if (drawnFigures > 0) catalogs.push(overlayController(overlay, polylines));
  } catch (err) {
    console.error('Constellation line overlay failed:', err);
    note(err);
  }

  // ---- name labels ----
  try {
    const blank = document.createElement('canvas');
    blank.width = blank.height = 8; // transparent carrier for the text label
    const labels = A.catalog({
      name: 'Constellation names',
      shape: blank,
      sourceSize: 8,
      displayLabel: true,
      labelColumn: 'name',
      labelColor: LABEL_COLOR,
      labelFont: '11px -apple-system, sans-serif',
      onClick: null
    });
    aladin.addCatalog(labels);
    const D2R = Math.PI / 180, R2D = 180 / Math.PI;
    for (const fig of figures) {
      try {
        // Official IAU-style label position when the names file provides one;
        // spherical centroid of the figure otherwise (safe across the RA seam).
        let pos = fig.labelPos;
        if (!pos) {
          let x = 0, y = 0, z = 0, n = 0;
          for (const line of fig.lines) {
            for (const [ra, dec] of line) {
              x += Math.cos(dec * D2R) * Math.cos(ra * D2R);
              y += Math.cos(dec * D2R) * Math.sin(ra * D2R);
              z += Math.sin(dec * D2R);
              n++;
            }
          }
          if (n) {
            let ra = Math.atan2(y, x) * R2D;
            if (ra < 0) ra += 360;
            pos = [ra, Math.atan2(z, Math.hypot(x, y)) * R2D];
          }
        }
        if (pos) labels.addSources([A.source(pos[0], pos[1], { name: fig.name })]);
      } catch (err) {
        console.error(`Constellation label "${fig.name}" failed:`, err);
        note(err);
      }
    }
    catalogs.push(labels);
  } catch (err) {
    console.error('Constellation labels failed:', err);
    note(err);
  }

  if (catalogs.length === 0) {
    // Include the real message: a screenshot of this toast identifies the
    // failing engine call without needing devtools on a phone.
    showToast(`Constellation layer failed: ${firstError?.message || firstError || 'unknown error'}`, 'error', 12000);
    return { catalogs: [], count: 0 };
  }
  if (firstError) {
    console.warn('Constellation layer partially degraded; first error above.');
  }
  return { catalogs, count: drawnFigures || figures.length };
}

/** IAU constellation boundaries — the faint property lines of the sky. */
export async function loadConstellationBorders(aladin) {
  let data;
  try {
    data = await fetchJSON('data/constellations_borders.json');
  } catch (err) {
    showToast('Constellation boundaries are not available yet (data refresh pending).', 'info');
    return { catalogs: [], count: 0 };
  }
  try {
    const overlay = A.graphicOverlay({ color: BORDER_COLOR, lineWidth: 1 });
    aladin.addOverlay(overlay);
    const polylines = [];
    let drawn = 0;
    for (const f of data.features) {
      try {
        // Polygon rings and MultiLineString lines share the [line][point] shape.
        for (const line of normalizeMulti(f.geometry.coordinates)) {
          const pl = A.polyline(line);
          polylines.push(pl);
          overlay.add(pl);
        }
        drawn++;
      } catch (err) {
        console.error(`Boundary feature "${f.id}" failed:`, err);
      }
    }
    if (!drawn) throw new Error('no boundary features drawable');
    return { catalogs: [overlayController(overlay, polylines)], count: drawn };
  } catch (err) {
    console.error('Constellation boundaries failed to build:', err);
    showToast(`Constellation boundaries failed: ${err.message}`, 'error', 10000);
    return { catalogs: [], count: 0 };
  }
}
