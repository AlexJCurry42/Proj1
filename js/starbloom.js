// Pocket Planetarium — the star bloom: catalog-driven glows drawn over the
// imagery on bright stars. The photographic survey plates saturated on
// them (clipped cores, misaligned red/blue exposures, JPEG chroma blocking
// — see the About panel), and a survey can't be repainted. This layer is
// the classic planetarium cure: a soft synthetic glow, positioned, sized
// and tinted from the catalog (V magnitude, B−V color), covering the
// artifact. It is deliberately a TOGGLE — it retouches the view, so the
// user can always switch back to the raw observations.
//
// Data: data/brightstars.json (full Yale BSC to V≤6.5, refreshed by
// .github/workflows/bright-stars.yml); until that Action has run, a
// curated seed of the ~50 brightest stars ships in the repo.

import { fetchJSON } from './net.js';
import { getOverlay } from './overlay.js';

// B−V color index → screen RGB, piecewise-linear over standard anchors
// (blue-white O/B stars through yellow G to orange-red M).
const BV_STOPS = [
  [-0.30, [158, 183, 255]],
  [0.00, [195, 209, 255]],
  [0.30, [237, 240, 253]],
  [0.60, [255, 244, 227]],
  [1.00, [255, 219, 172]],
  [1.50, [255, 187, 123]],
  [2.00, [255, 165, 100]]
];
function bvColor(bv) {
  if (!Number.isFinite(bv)) bv = 0.3;
  if (bv <= BV_STOPS[0][0]) return BV_STOPS[0][1];
  for (let i = 1; i < BV_STOPS.length; i++) {
    if (bv <= BV_STOPS[i][0]) {
      const [b0, c0] = BV_STOPS[i - 1];
      const [b1, c1] = BV_STOPS[i];
      const t = (bv - b0) / (b1 - b0);
      return [0, 1, 2].map(k => Math.round(c0[k] + (c1[k] - c0[k]) * t));
    }
  }
  return BV_STOPS[BV_STOPS.length - 1][1];
}

export async function initStarBloom(aladin) {
  let stars;
  try {
    stars = (await fetchJSON('data/brightstars.json')).stars;
  } catch (err) {
    try {
      stars = (await fetchJSON('data/brightstars_seed.json')).stars;
    } catch (err2) {
      return null; // no data at all: the toggle will disable itself
    }
  }
  if (!Array.isArray(stars) || !stars.length) return null;
  stars.sort((a, b) => a[2] - b[2]); // brightest first, so mag tiers can early-break

  function draw(ctx, view, state) {
    const { fov, W, H } = view;
    // Whole-sky views: stars are unresolved points, no artifact to hide.
    if (fov > 110) return;
    const alpha = state.alpha;
    const pxPerDeg = Math.max(W, H) / fov;
    // Zoom tiers, like the deep-sky layer: wide views only need the
    // brightest handful; deep zooms include everything in the file.
    const magCap = fov > 40 ? 3.0 : fov > 12 ? 4.6 : 99;
    const rMax = 0.45 * Math.max(W, H);
    for (const [ra, dec, v, bv] of stars) {
      if (v > magCap) break;
      // Glow angular radius ≈ the saturated plate core it must cover:
      // ~10′ at mag 0, shrinking ~½ per 1.05 mag.
      const rPx = (10 / 60) * Math.pow(10, -v / 3.5) * pxPerDeg;
      if (rPx < 2.2) continue; // core unresolved at this zoom: leave it be
      const p = view.proj(ra, dec);
      if (!p) continue;
      const r = Math.min(rPx, rMax);
      const [cr, cg, cb] = bvColor(bv);
      const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r);
      g.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
      g.addColorStop(0.16, `rgba(${cr}, ${cg}, ${cb}, ${0.92 * alpha})`);
      g.addColorStop(0.45, `rgba(${cr}, ${cg}, ${cb}, ${0.34 * alpha})`);
      g.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, 6.2832);
      ctx.fill();
    }
  }

  // z:8 — over the imagery, under constellation figures (10), horizon (20)
  // and satellites (30): the bloom is part of the SKY, not the instruments.
  const ctl = getOverlay(aladin).addLayer({ z: 8, draw });
  return {
    show: () => ctl.show(),
    hide: () => ctl.hide(),
    count: stars.length
  };
}
