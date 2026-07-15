// Pocket Planetarium — the star bloom: catalog-driven glows drawn over the
// imagery on bright stars. The photographic survey plates saturated on
// them (clipped cores, misaligned red/blue exposures, JPEG chroma blocking
// — see the About panel), and a survey can't be repainted. This layer is
// the classic planetarium cure: a soft synthetic glow, positioned, sized
// and tinted from the catalog (V magnitude, B−V color), covering the
// artifact. It is deliberately a TOGGLE — it retouches the view, so the
// user can always switch back to the raw observations.
//
// Performance shape (this layer is ON by default, so it must be free):
//  · data comes in two files — data/brightstars.json (Yale BSC, V ≤ 6.5,
//    ~250 KB, loaded when the layer starts) and data/brightstars_faint.json
//    (Tycho-2 extension to V ≈ 8.4, ~1.6 MB) fetched LAZILY on browser idle
//    or the first deep zoom, never on the boot path;
//  · glows are stamped from pre-rendered SPRITES (one small canvas per
//    color bucket) with drawImage — the earlier per-star radial gradients
//    cost several ms per pan frame and read as stutter;
//  · faint stars live in a 10°×10° spatial grid so a deep-zoom redraw only
//    touches the cells around the view center.

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

// One pre-rendered glow sprite per color bucket: the gradient is baked once
// at 96 px radius and scaled at stamp time (radial gradients are perfectly
// scale-invariant, so a stretched sprite is pixel-identical to a live one).
const SPRITE_R = 96;
const BUCKETS = 12; // B−V quantized from −0.3 … 2.0
function makeSprites() {
  const sprites = [];
  for (let i = 0; i < BUCKETS; i++) {
    const bv = -0.3 + (2.3 * i) / (BUCKETS - 1);
    const [cr, cg, cb] = bvColor(bv);
    const cv = document.createElement('canvas');
    cv.width = cv.height = SPRITE_R * 2;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(SPRITE_R, SPRITE_R, 0, SPRITE_R, SPRITE_R, SPRITE_R);
    g.addColorStop(0, 'rgba(255, 255, 255, 1)');
    g.addColorStop(0.22, 'rgba(255, 255, 255, 0.97)'); // solid heart: the artifact must not ghost through
    g.addColorStop(0.45, `rgba(${cr}, ${cg}, ${cb}, 0.75)`);
    g.addColorStop(0.7, `rgba(${cr}, ${cg}, ${cb}, 0.28)`);
    g.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);
    c.fillStyle = g;
    c.fillRect(0, 0, SPRITE_R * 2, SPRITE_R * 2);
    sprites.push(cv);
  }
  return sprites;
}
const spriteFor = (sprites, bv) => {
  const b = Number.isFinite(bv) ? bv : 0.3;
  const i = Math.round(((b + 0.3) / 2.3) * (BUCKETS - 1));
  return sprites[Math.max(0, Math.min(BUCKETS - 1, i))];
};

// Glow angular radius ≈ the saturated plate core it must cover. DSS2 cores
// are LARGE: ~10′ radius at mag 0, still over 1′ at mag 6 — halving roughly
// every 2 magnitudes (calibrated against user screenshots). ×1.3 swallows
// the offset red/blue fringes.
const coreRadiusDeg = (v) => 1.3 * (10 / 60) * Math.pow(10, -v / 6.6);

export async function initStarBloom(aladin) {
  let bright;
  let legacyFaint = null; // pre-split combined file: carve the faint tier out locally
  try {
    const d = await fetchJSON('data/brightstars.json');
    bright = d.stars;
    if (bright.length > 15000) {
      legacyFaint = bright.filter(s => s[2] > 6.5);
      bright = bright.filter(s => s[2] <= 6.5);
    }
  } catch (err) {
    try {
      bright = (await fetchJSON('data/brightstars_seed.json')).stars;
    } catch (err2) {
      return null; // no data at all: the toggle will disable itself
    }
  }
  if (!Array.isArray(bright) || !bright.length) return null;
  bright.sort((a, b) => a[2] - b[2]); // brightest first, so mag tiers early-break

  const sprites = makeSprites();

  // ---- faint tier: spatial grid, filled when the data arrives ----
  const cells = new Map(); // "cx,cy" → faint stars in that 10° cell
  let faintState = 'idle'; // idle → loading → ready|failed
  function indexFaint(stars) {
    for (const s of stars) {
      const key = `${Math.floor(s[0] / 10)},${Math.floor((s[1] + 90) / 10)}`;
      let arr = cells.get(key);
      if (!arr) cells.set(key, arr = []);
      arr.push(s);
    }
    faintState = 'ready';
    ctl?.dirty(); // repaint: newly-covered stars appear
  }
  function loadFaint() {
    if (faintState !== 'idle') return;
    faintState = 'loading';
    if (legacyFaint) { indexFaint(legacyFaint); legacyFaint = null; return; }
    fetchJSON('data/brightstars_faint.json')
      .then((d) => indexFaint(d.stars || []))
      .catch(() => { faintState = 'failed'; }); // bright tier still covers the worst
  }
  // Fetch during idle time well after boot; a deep zoom forces it sooner.
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 4000));
  idle(() => loadFaint(), { timeout: 15000 });

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

  function drawStar(ctx, view, pxPerDeg, rMax, s) {
    const rPx = coreRadiusDeg(s[2]) * pxPerDeg;
    if (rPx < 2.2) return; // core unresolved at this zoom: leave it be
    const p = view.proj(s[0], s[1]);
    if (!p) return;
    const r = Math.min(rPx, rMax);
    ctx.drawImage(spriteFor(sprites, s[3]), p[0] - r, p[1] - r, r * 2, r * 2);
  }

  function draw(ctx, view, state) {
    const { fov, W, H } = view;
    // Whole-sky views: stars are unresolved points, no artifact to hide.
    if (fov > 110) return;
    const pxPerDeg = Math.max(W, H) / fov;
    const rMax = 0.45 * Math.max(W, H);
    ctx.globalAlpha = state.alpha; // sprites carry their own falloff
    const magCap = fov > 40 ? 3.0 : 99;
    for (const s of bright) {
      if (s[2] > magCap) break;
      drawStar(ctx, view, pxPerDeg, rMax, s);
    }
    // Faint tier only at depth — where their cores resolve into blotches.
    if (fov <= 12) {
      if (faintState === 'idle') loadFaint();
      let ra0 = 0, dec0 = 0;
      try { [ra0, dec0] = aladin.getRaDec(); } catch (err) { ctx.globalAlpha = 1; return; }
      for (const s of faintNear(ra0, dec0, fov * 0.75 + 1)) {
        drawStar(ctx, view, pxPerDeg, rMax, s);
      }
    }
    ctx.globalAlpha = 1;
  }

  // z:8 — over the imagery, under constellation figures (10), horizon (20)
  // and satellites (30): the bloom is part of the SKY, not the instruments.
  const ctl = getOverlay(aladin).addLayer({ z: 8, draw });
  return {
    show: () => ctl.show(),
    hide: () => ctl.hide(),
    count: bright.length
  };
}
