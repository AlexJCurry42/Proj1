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
  stars.sort((a, b) => a[2] - b[2]); // brightest first

  // Two access paths: the bright tier is a small flat list scanned at any
  // zoom; the faint thousands live in a 10°×10° spatial grid consulted
  // only at deep zooms, so a redraw never projects tens of thousands of
  // off-view stars.
  const BRIGHT_CAP = 4.6;
  const bright = stars.filter(s => s[2] <= BRIGHT_CAP);
  const cells = new Map(); // "cx,cy" → faint stars in that 10° cell
  for (const s of stars) {
    if (s[2] <= BRIGHT_CAP) continue;
    const key = `${Math.floor(s[0] / 10)},${Math.floor((s[1] + 90) / 10)}`;
    let arr = cells.get(key);
    if (!arr) cells.set(key, arr = []);
    arr.push(s);
  }
  function* faintNear(ra, dec, radiusDeg) {
    const stretch = 1 / Math.max(0.15, Math.cos(dec * Math.PI / 180)); // RA cells shrink toward the poles
    const cy0 = Math.floor((Math.max(-90, dec - radiusDeg) + 90) / 10);
    const cy1 = Math.floor((Math.min(89.99, dec + radiusDeg) + 90) / 10);
    const span = Math.min(18, Math.ceil((radiusDeg * stretch) / 10) + 1);
    const cx0 = Math.floor(ra / 10);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let dx = -span; dx <= span; dx++) {
        const arr = cells.get(`${(((cx0 + dx) % 36) + 36) % 36},${cy}`);
        if (arr) yield* arr;
      }
    }
  }

  // Glow angular radius ≈ the saturated plate core it must cover. DSS2
  // cores are LARGE: ~10′ radius at mag 0, still over 1′ at mag 6 —
  // halving roughly every 2 magnitudes (the earlier 1.05-mag halving
  // undersized mid-bright stars ~4×, leaving their black cores exposed;
  // calibrated against user screenshots). ×1.3 to swallow the offset
  // red/blue fringes around the core.
  const coreRadiusDeg = (v) => 1.3 * (10 / 60) * Math.pow(10, -v / 6.6);

  function drawStar(ctx, view, alpha, pxPerDeg, rMax, s) {
    const rPx = coreRadiusDeg(s[2]) * pxPerDeg;
    if (rPx < 2.2) return; // core unresolved at this zoom: leave it be
    const p = view.proj(s[0], s[1]);
    if (!p) return;
    const r = Math.min(rPx, rMax);
    const [cr, cg, cb] = bvColor(s[3]);
    const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r);
    g.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    g.addColorStop(0.22, `rgba(255, 255, 255, ${0.97 * alpha})`); // solid heart: the artifact must not ghost through
    g.addColorStop(0.45, `rgba(${cr}, ${cg}, ${cb}, ${0.75 * alpha})`);
    g.addColorStop(0.7, `rgba(${cr}, ${cg}, ${cb}, ${0.28 * alpha})`);
    g.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, 6.2832);
    ctx.fill();
  }

  function draw(ctx, view, state) {
    const { fov, W, H } = view;
    // Whole-sky views: stars are unresolved points, no artifact to hide.
    if (fov > 110) return;
    const alpha = state.alpha;
    const pxPerDeg = Math.max(W, H) / fov;
    const rMax = 0.45 * Math.max(W, H);
    const magCap = fov > 40 ? 3.0 : 99;
    for (const s of bright) {
      if (s[2] > magCap) break;
      drawStar(ctx, view, alpha, pxPerDeg, rMax, s);
    }
    // Faint tier only at depth — where their cores resolve into blotches.
    if (fov <= 12) {
      let ra0 = 0, dec0 = 0;
      try { [ra0, dec0] = aladin.getRaDec(); } catch (err) { return; }
      for (const s of faintNear(ra0, dec0, fov * 0.75 + 1)) {
        drawStar(ctx, view, alpha, pxPerDeg, rMax, s);
      }
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
