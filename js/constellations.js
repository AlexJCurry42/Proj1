// Pocket Planetarium — constellations, built for stargazers. Primary data is
// the full-88 IAU set (figures, official names + label positions, boundaries)
// from the d3-celestial project (BSD-3-Clause, Stellarium-derived), committed
// into data/ by the data-refresh Action. If those files are
// missing (first deploy), a curated 21-figure set keeps the layer alive.
//
// Rendering rides the unified overlay engine (js/overlay.js): glow-layered
// strokes with star nodes at the figure joints (the joints ARE the member
// stars), small-caps labels with dark halos, zoom-aware fading, and a
// staggered draw-in when the layer switches on. Long star-to-star hops are
// subdivided along great circles so wide-field lines curve with the sky;
// the ORIGINAL vertices alone carry the star nodes.
//
// Data notes learned the hard way:
// - d3-celestial stores RA in [-180, 180]. After normalizing to [0, 360),
//   any segment jumping >180° in RA is crossing the 0/360 seam and must be
//   split, or the projection draws a line across the entire sky.

import { fetchJSON } from './net.js';
import { showToast } from './ui.js';
import { getOverlay, tracePath, haloText } from './overlay.js';
import { normRa, subdivide, centroidOf, smoothstep, clamp01 } from './astro.js';

const REVEAL_MS = 520;   // per-constellation draw-in
const STAGGER_MS = 13;   // delay between constellations

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

// ============================ data loading ============================

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

// ============================ drawing ============================

function strokeFigure(ctx, a) {
  // Glow pass under a crisp core: reads as light, not as a wireframe.
  ctx.strokeStyle = `rgba(122, 154, 234, ${0.20 * a})`;
  ctx.lineWidth = 4.4;
  ctx.stroke();
  ctx.strokeStyle = `rgba(164, 189, 248, ${0.82 * a})`;
  ctx.lineWidth = 1.35;
  ctx.stroke();
}

function drawFigures(items, ctx, view, state) {
  // Figures matter at wide fields; deep zooms are about the objects.
  const lod = smoothstep((view.fov - 5) / 9);
  const A0 = state.alpha * lod;
  if (A0 <= 0.005) return;
  const labelLod = smoothstep((view.fov - 8) / 10);
  const now = view.now;

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const revealing = state.revealStart != null;
  const progress = (i) => state.revealStart == null ? 1
    : clamp01((now - state.revealStart - i * STAGGER_MS) / REVEAL_MS);

  if (!revealing) {
    // Steady state (the vast majority of frames): one batched path for
    // every figure, two strokes total — not two per constellation.
    ctx.beginPath();
    for (const fig of items) for (const line of fig.drawLines) tracePath(ctx, view, line);
    strokeFigure(ctx, A0);
    ctx.beginPath();
    for (const fig of items) {
      for (const [ra, dec] of fig.nodes) {
        const p = view.proj(ra, dec);
        if (!p) continue;
        ctx.moveTo(p[0] + 1.7, p[1]);
        ctx.arc(p[0], p[1], 1.7, 0, 6.2832);
      }
    }
    ctx.fillStyle = `rgba(215, 228, 255, ${0.9 * A0})`;
    ctx.fill();
  } else {
    // Draw-in: per-constellation dash reveal, staggered across the sky.
    for (let i = 0; i < items.length; i++) {
      const fig = items[i];
      const p = progress(i);
      if (p <= 0) continue;
      const reveal = smoothstep(p);

      ctx.beginPath();
      let len = 0;
      for (const line of fig.drawLines) len += tracePath(ctx, view, line);
      if (len === 0) continue;
      if (reveal < 1) ctx.setLineDash([len * reveal, 1e9]);
      strokeFigure(ctx, A0);
      if (reveal < 1) ctx.setLineDash([]);

      ctx.beginPath();
      for (const [ra, dec] of fig.nodes) {
        const q = view.proj(ra, dec);
        if (!q) continue;
        ctx.moveTo(q[0] + 1.7, q[1]);
        ctx.arc(q[0], q[1], 1.7, 0, 6.2832);
      }
      ctx.fillStyle = `rgba(215, 228, 255, ${0.9 * A0 * reveal})`;
      ctx.fill();
    }
  }

  // Labels: quiet small caps with a dark halo.
  if (labelLod > 0.01) {
    ctx.font = '600 10.5px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    try { ctx.letterSpacing = '0.14em'; } catch (err) { /* older engines */ }
    for (let i = 0; i < items.length; i++) {
      const fig = items[i];
      if (!fig.label) continue;
      const p = progress(i);
      if (p <= 0.55) continue;
      const lp = view.proj(fig.label.ra, fig.label.dec);
      if (!lp) continue;
      const la = state.alpha * labelLod * clamp01((p - 0.55) / 0.45);
      haloText(ctx, fig.label.text, lp[0], lp[1],
        `rgba(178, 197, 244, ${0.8 * la})`, `rgba(2, 4, 12, ${0.6 * la})`);
    }
  }
}

function drawBorders(items, ctx, view, state) {
  const lod = smoothstep((view.fov - 6) / 10);
  const p = state.revealStart == null ? 1
    : clamp01((view.now - state.revealStart) / (REVEAL_MS * 0.7));
  const A0 = state.alpha * lod * smoothstep(p);
  if (A0 <= 0.005) return;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  ctx.beginPath();
  for (const item of items) for (const line of item.drawLines) tracePath(ctx, view, line);
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = `rgba(96, 116, 168, ${0.5 * A0})`;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
}

// Adapt an overlay controller to the catalog show/hide contract, with the
// staggered reveal on every show.
const asCatalog = (ctl) => ({ show: () => ctl.show({ reveal: true }), hide: () => ctl.hide() });

// ============================ wiring ============================

export async function loadConstellations(aladin) {
  let figures;
  try {
    figures = await loadFigures();
  } catch (err) {
    showToast('Could not load constellation figures.', 'error');
    return { catalogs: [], count: 0 };
  }
  if (typeof aladin.world2pix !== 'function') {
    showToast('Constellations need a newer sky engine build.', 'error');
    return { catalogs: [], count: 0 };
  }

  const items = [];
  for (const fig of figures) {
    try {
      // Nodes are the raw vertices (the member stars), deduped; strokes get
      // great-circle waypoints so wide-field lines curve correctly.
      const seen = new Set();
      const nodes = [];
      for (const line of fig.lines) {
        for (const [ra, dec] of line) {
          const key = `${ra.toFixed(3)},${dec.toFixed(3)}`;
          if (!seen.has(key)) { seen.add(key); nodes.push([ra, dec]); }
        }
      }
      const pos = fig.labelPos || centroidOf(fig.lines);
      items.push({
        drawLines: fig.lines.map(l => subdivide(l)),
        nodes,
        label: pos ? { text: fig.name.toUpperCase(), ra: pos[0], dec: pos[1] } : null
      });
    } catch (err) {
      console.error(`Constellation "${fig.name}" failed to build:`, err);
    }
  }
  if (!items.length) {
    showToast('Constellation layer failed: no drawable figures.', 'error', 10000);
    return { catalogs: [], count: 0 };
  }

  const ctl = getOverlay(aladin).addLayer({
    z: 10,
    revealSpan: REVEAL_MS + items.length * STAGGER_MS,
    draw: (ctx, view, state) => drawFigures(items, ctx, view, state)
  });
  return { catalogs: [asCatalog(ctl)], count: items.length };
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
    const items = [];
    for (const f of data.features) {
      try {
        // Polygon rings and MultiLineString lines share the [line][point] shape.
        items.push({ drawLines: normalizeMulti(f.geometry.coordinates).map(l => subdivide(l)) });
      } catch (err) {
        console.error(`Boundary feature "${f.id}" failed:`, err);
      }
    }
    if (!items.length) throw new Error('no boundary features drawable');
    const ctl = getOverlay(aladin).addLayer({
      z: 5,
      revealSpan: REVEAL_MS,
      draw: (ctx, view, state) => drawBorders(items, ctx, view, state)
    });
    return { catalogs: [asCatalog(ctl)], count: items.length };
  } catch (err) {
    console.error('Constellation boundaries failed to build:', err);
    showToast(`Constellation boundaries failed: ${err.message}`, 'error', 10000);
    return { catalogs: [], count: 0 };
  }
}
