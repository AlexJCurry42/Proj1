// Pocket Planetarium — the coordinate grid, drawn on the unified overlay
// engine (replacing the engine's built-in graticule, whose line spacing
// snapped between levels and whose labels rode the sky, drifting with
// every pan). This one is fluid by construction:
//
//  · spacing is CONTINUOUS — as the zoom crosses a level, the finer lines
//    fade in over the coarse ones instead of the whole lattice popping;
//  · labels are pinned to the screen edges (declinations on the right,
//    right ascensions along the top), so the scale readout sits still
//    while the sky moves under it;
//  · lines are sampled along great circles through the shared projector,
//    so they curve exactly as the projection does — the honest way to
//    SHOW distortion instead of pretending there is none.

import { getOverlay, haloText } from './overlay.js';

// "Nice" spacing ladders, coarse → fine. Declination in degrees; right
// ascension in hours (the sky's native RA unit — labels read 5h 40m, not
// 85°). Finest: 15″ of dec, 1s of RA — beyond any HiPS survey's floor.
const DEC_STEPS = [45, 30, 15, 10, 5, 2, 1, 1 / 2, 1 / 4, 1 / 6, 1 / 12, 1 / 30, 1 / 60, 1 / 120, 1 / 240];
const RA_STEPS = [6, 3, 2, 1, 1 / 2, 1 / 3, 1 / 6, 1 / 12, 1 / 30, 1 / 60, 1 / 120, 1 / 240, 1 / 480, 1 / 1200, 1 / 3600];

// Pick the coarse/fine step pair bracketing the ideal spacing, plus the
// fade progress t of the fine level (0 = coarse only, 1 = fine mature).
function pickStep(steps, ideal) {
  let i = 0;
  while (i < steps.length - 1 && steps[i + 1] >= ideal) i++;
  const coarse = steps[i];
  const fine = steps[Math.min(i + 1, steps.length - 1)];
  if (fine === coarse || ideal <= fine) return { coarse, fine, t: ideal <= fine ? 1 : 0 };
  const t = (Math.log(coarse) - Math.log(ideal)) / (Math.log(coarse) - Math.log(fine));
  return { coarse, fine, t: Math.max(0, Math.min(1, t)) };
}

const isMultiple = (v, step) => Math.abs(v / step - Math.round(v / step)) < 1e-6;

function fmtDec(deg, step) {
  const sign = deg < 0 ? '−' : '+';
  const a = Math.abs(deg);
  const d = Math.floor(a + 1e-9);
  const mFull = (a - d) * 60;
  const m = Math.floor(mFull + 1e-9);
  const s = Math.round((mFull - m) * 60);
  if (step >= 1) return `${sign}${d}°`;
  if (step >= 1 / 60) return `${sign}${d}° ${String(m).padStart(2, '0')}′`;
  return `${sign}${d}° ${String(m).padStart(2, '0')}′ ${String(s).padStart(2, '0')}″`;
}

function fmtRa(hours, stepH) {
  const a = ((hours % 24) + 24) % 24;
  const h = Math.floor(a + 1e-9);
  const mFull = (a - h) * 60;
  const m = Math.floor(mFull + 1e-9);
  const s = Math.round((mFull - m) * 60);
  if (stepH >= 1) return `${h}h`;
  if (stepH >= 1 / 60) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

// Where a sampled polyline crosses a vertical guide x = gx (for dec
// labels) or horizontal guide y = gy (for RA labels), in pixel space.
function crossing(pts, axis, guide, lo, hi) {
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    if (!p || !q) continue;
    const a = axis === 'x' ? p[0] : p[1], b = axis === 'x' ? q[0] : q[1];
    if ((a - guide) * (b - guide) > 0 || a === b) continue;
    if (Math.abs(b - a) > 220) continue; // projection seam, not a crossing
    const f = (guide - a) / (b - a);
    const other = axis === 'x'
      ? p[1] + (q[1] - p[1]) * f
      : p[0] + (q[0] - p[0]) * f;
    if (other >= lo && other <= hi) return other;
  }
  return null;
}

export function initGridLayer(aladin) {
  function draw(ctx, view, state) {
    const { W, H, fov } = view;
    const alpha = state.alpha;

    let ra0, dec0;
    try { [ra0, dec0] = aladin.getRaDec(); } catch (err) { return; }

    // Visible extent with margin (rotation-safe: use the diagonal).
    const fovY = fov * (H / W);
    const half = Math.min(90, 0.62 * Math.hypot(fov, fovY));
    const decMin = Math.max(-90, dec0 - half);
    const decMax = Math.min(90, dec0 + half);
    const nearPole = decMax > 88 || decMin < -88;
    const cosDec = Math.max(0.15, Math.cos(dec0 * Math.PI / 180));
    const raHalf = nearPole ? 180 : Math.min(180, half / cosDec);

    // Ideal spacing: ~4.5 lines across the smaller screen span.
    const dec = pickStep(DEC_STEPS, Math.min(fovY, fov) / 4.5);
    const ra = pickStep(RA_STEPS, (fov / 4.5) / (15 * cosDec));

    const line = (r, g, b, a) => `rgba(${r}, ${g}, ${b}, ${a})`;
    const COL = [120, 148, 210];
    const labels = []; // [text, x, y, align, a] — painted last, over the lines

    // Sample density tracks the field: wide views need dense sampling to
    // follow projection curvature, but a small field's arcs are nearly
    // straight — half the points draw the identical line, at half the
    // projection (wasm-crossing) cost per pan frame. Near the poles the
    // parallels stay strongly curved at any zoom, so density stays full.
    const dense = nearPole || fov > 20;

    // ---- declination parallels ----
    const raSamples = dense ? 56 : 28;
    const decLines = [[], []]; // [full-alpha batch, fading batch]
    for (let d = Math.ceil(decMin / dec.fine) * dec.fine; d <= decMax + 1e-9; d += dec.fine) {
      if (Math.abs(d) > 89.999) continue;
      const major = isMultiple(d, dec.coarse);
      const a = major ? 1 : dec.t;
      if (a < 0.02) continue;
      const pts = [];
      for (let k = 0; k <= raSamples; k++) {
        const r = ra0 - raHalf + (2 * raHalf * k) / raSamples;
        pts.push(view.proj(((r % 360) + 360) % 360, d));
      }
      decLines[major ? 0 : 1].push(pts);
      if (a > 0.35) {
        const y = crossing(pts, 'x', W - 70, 74, H - 116);
        if (y != null) labels.push([fmtDec(d, dec.fine), W - 74, y, 'right', a]);
      }
    }

    // ---- right-ascension meridians ----
    const decSamples = dense ? 40 : 20;
    const raLines = [[], []];
    const seen = new Set();
    const stepDeg = ra.fine * 15;
    for (let r = Math.ceil((ra0 - raHalf) / stepDeg) * stepDeg; r <= ra0 + raHalf + 1e-9; r += stepDeg) {
      const rNorm = ((r % 360) + 360) % 360;
      const key = rNorm.toFixed(6);
      if (seen.has(key)) continue;
      seen.add(key);
      const major = isMultiple(rNorm / 15, ra.coarse);
      const a = major ? 1 : ra.t;
      if (a < 0.02) continue;
      const pts = [];
      for (let k = 0; k <= decSamples; k++) {
        const d = decMin + ((decMax - decMin) * k) / decSamples;
        pts.push(view.proj(rNorm, Math.max(-89.999, Math.min(89.999, d))));
      }
      raLines[major ? 0 : 1].push(pts);
      if (a > 0.35) {
        const x = crossing(pts, 'y', 64, 60, W - 130);
        if (x != null) labels.push([fmtRa(rNorm / 15, ra.fine), x, 74, 'center', a]);
      }
    }

    // Two strokes per family: mature lines at full opacity, the arriving
    // finer level at its fade progress — the cross-fade IS the smoothness.
    ctx.lineWidth = 1;
    for (const [batchIdx, fam, t] of [[0, decLines, 1], [1, decLines, dec.t], [0, raLines, 1], [1, raLines, ra.t]]) {
      const batch = fam[batchIdx];
      if (!batch.length || t < 0.02) continue;
      ctx.beginPath();
      for (const pts of batch) tracePathPts(ctx, view, pts);
      ctx.strokeStyle = line(...COL, 0.5 * t * alpha);
      ctx.stroke();
    }

    // ---- edge-pinned labels ----
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    for (const [text, x, y, align, a] of labels) {
      ctx.textAlign = align;
      haloText(ctx, text, x, y,
        line(168, 190, 238, 0.85 * a * alpha), `rgba(4, 8, 18, ${0.7 * a * alpha})`, 2.5);
    }
  }

  // tracePath variant over pre-projected points (the grid projects its own
  // samples so label crossings reuse them).
  function tracePathPts(ctx, view, pts) {
    const MAX_SEG = 0.6 * Math.max(view.W, view.H);
    let pen = false, px = 0, py = 0;
    for (const p of pts) {
      if (!p) { pen = false; continue; }
      if (!pen) { ctx.moveTo(p[0], p[1]); pen = true; }
      else {
        const d = Math.hypot(p[0] - px, p[1] - py);
        if (d > MAX_SEG) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      }
      px = p[0]; py = p[1];
    }
  }

  const ctl = getOverlay(aladin).addLayer({ z: 8, draw });
  return { show: () => ctl.show(), hide: () => ctl.hide() };
}
