// Pocket Planetarium — constellations, built for stargazers. Primary data is
// the full-88 IAU set (figures, official names + label positions, boundaries)
// from the d3-celestial project (BSD-3-Clause, Stellarium-derived), committed
// into data/ by .github/workflows/constellation-data.yml. If those files are
// missing (first deploy), a curated 21-figure set keeps the layer alive.
//
// Rendering is a custom canvas layer above the sky, not the engine's basic
// graphic overlay: every frame the figure vertices are projected through
// aladin.world2pix (measured ~1µs/point), which buys glow-layered strokes,
// star nodes at the figure joints, typographic labels with halos, zoom-aware
// fading, and a staggered draw-in animation — none of which the built-in
// overlay API can express. The canvas only repaints when the view moves or
// an animation is running; a static sky costs nothing.
//
// Data notes learned the hard way:
// - d3-celestial stores RA in [-180, 180]. After normalizing to [0, 360),
//   any segment jumping >180° in RA is crossing the 0/360 seam and must be
//   split, or the projection draws a line across the entire sky.
// - Figure vertices ARE the member stars, so they double as node positions;
//   long star-to-star hops are subdivided along the great circle for drawing
//   (a straight chord visibly sags at wide fields), while nodes keep the
//   original vertices only.

import { fetchJSON } from './net.js';
import { showToast } from './ui.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

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

// ---- spherical helpers (subdivision along great circles) ----
const toVec = (ra, dec) => {
  const r = ra * D2R, d = dec * D2R, cd = Math.cos(d);
  return [cd * Math.cos(r), cd * Math.sin(r), Math.sin(d)];
};
const toRaDec = (v) => {
  let ra = Math.atan2(v[1], v[0]) * R2D;
  if (ra < 0) ra += 360;
  return [ra, Math.asin(Math.max(-1, Math.min(1, v[2]))) * R2D];
};

/** Insert great-circle waypoints so no drawn segment spans more than ~3°. */
function subdivide(line, maxDeg = 3) {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = toVec(line[i - 1][0], line[i - 1][1]);
    const b = toVec(line[i][0], line[i][1]);
    const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const ang = Math.acos(dot) * R2D;
    const n = Math.ceil(ang / maxDeg);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      const l = Math.hypot(m[0], m[1], m[2]) || 1;
      out.push(toRaDec([m[0] / l, m[1] / l, m[2] / l]));
    }
    out.push(line[i]);
  }
  return out;
}

// ============================ canvas renderer ============================

let renderer = null;

function getRenderer(aladin) {
  if (renderer) return renderer;

  const wrap = document.getElementById('sky-wrap');
  const canvas = document.createElement('canvas');
  canvas.id = 'constellation-canvas';
  wrap.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let dpr = 1, W = 0, H = 0;
  let raf = null;
  let lastSig = '';
  let lastT = 0;
  let needsDraw = false;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = wrap.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    needsDraw = true;
    ensureLoop();
  }
  window.addEventListener('resize', resize);
  resize();

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const REVEAL_MS = reduceMotion ? 0 : 520;   // per-constellation draw-in
  const STAGGER_MS = reduceMotion ? 0 : 13;   // delay between constellations
  const FADE_TAU = reduceMotion ? 1 : 110;    // layer fade time constant (ms)

  // layer := { items, alpha, target, revealStart, kind }
  const layers = {};

  const proj = (ra, dec) => {
    const p = aladin.world2pix(ra, dec);
    return (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) ? p : null;
  };

  // Build one line as canvas subpaths, skipping hidden/degenerate parts.
  // Returns the drawn pixel length (for the dash-based draw-in reveal).
  const MAX_SEG = () => 0.6 * Math.max(W, H); // projection glitch guard
  function tracePath(line) {
    let len = 0, pen = false, px = 0, py = 0;
    for (let i = 0; i < line.length; i++) {
      const p = proj(line[i][0], line[i][1]);
      if (!p) { pen = false; continue; }
      if (!pen) { ctx.moveTo(p[0], p[1]); pen = true; }
      else {
        const d = Math.hypot(p[0] - px, p[1] - py);
        if (d > MAX_SEG()) { ctx.moveTo(p[0], p[1]); }
        else { ctx.lineTo(p[0], p[1]); len += d; }
      }
      px = p[0]; py = p[1];
    }
    return len;
  }

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const smooth = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };

  function drawFigures(layer, now, fov) {
    // Figures matter at wide fields; deep zooms are about the objects.
    const lod = smooth((fov - 5) / 9);
    const A0 = layer.alpha * lod;
    if (A0 <= 0.005) return;
    const labelLod = smooth((fov - 8) / 10);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const strokeBoth = (a) => {
      // Glow pass under a crisp core: reads as light, not as a wireframe.
      ctx.strokeStyle = `rgba(122, 154, 234, ${0.20 * a})`;
      ctx.lineWidth = 4.4;
      ctx.stroke();
      ctx.strokeStyle = `rgba(164, 189, 248, ${0.82 * a})`;
      ctx.lineWidth = 1.35;
      ctx.stroke();
    };
    const revealing = layer.revealStart != null;

    if (!revealing) {
      // Steady state (the vast majority of frames): one batched path for
      // every figure, two strokes total — not two per constellation.
      ctx.beginPath();
      for (const fig of layer.items) for (const line of fig.drawLines) tracePath(line);
      strokeBoth(A0);
      ctx.beginPath();
      for (const fig of layer.items) {
        for (const [nx, ny] of fig.nodePts(proj)) {
          ctx.moveTo(nx + 1.7, ny);
          ctx.arc(nx, ny, 1.7, 0, 6.2832);
        }
      }
      ctx.fillStyle = `rgba(215, 228, 255, ${0.9 * A0})`;
      ctx.fill();
    } else {
      // Draw-in: per-constellation dash reveal, staggered across the sky.
      for (let i = 0; i < layer.items.length; i++) {
        const fig = layer.items[i];
        const p = clamp01((now - layer.revealStart - i * STAGGER_MS) / (REVEAL_MS || 1));
        if (p <= 0) continue;
        const reveal = smooth(p);

        ctx.beginPath();
        let len = 0;
        for (const line of fig.drawLines) len += tracePath(line);
        if (len === 0) continue;
        if (reveal < 1) ctx.setLineDash([len * reveal, 1e9]);
        strokeBoth(A0);
        if (reveal < 1) ctx.setLineDash([]);

        // Star nodes at the figure joints — the member stars themselves.
        ctx.beginPath();
        for (const [nx, ny] of fig.nodePts(proj)) {
          ctx.moveTo(nx + 1.7, ny);
          ctx.arc(nx, ny, 1.7, 0, 6.2832);
        }
        ctx.fillStyle = `rgba(215, 228, 255, ${0.9 * A0 * reveal})`;
        ctx.fill();
      }
    }

    // Labels: quiet small caps with a dark halo (strokeText beats
    // shadowBlur by an order of magnitude here).
    if (labelLod > 0.01) {
      ctx.font = '600 10.5px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      try { ctx.letterSpacing = '0.14em'; } catch (err) { /* older engines */ }
      for (let i = 0; i < layer.items.length; i++) {
        const fig = layer.items[i];
        if (!fig.label) continue;
        const p = layer.revealStart == null ? 1
          : clamp01((now - layer.revealStart - i * STAGGER_MS) / (REVEAL_MS || 1));
        if (p <= 0.55) continue;
        const lp = proj(fig.label.ra, fig.label.dec);
        if (!lp) continue;
        const la = layer.alpha * labelLod * clamp01((p - 0.55) / 0.45);
        ctx.strokeStyle = `rgba(2, 4, 12, ${0.6 * la})`;
        ctx.lineWidth = 3;
        ctx.strokeText(fig.label.text, lp[0], lp[1]);
        ctx.fillStyle = `rgba(178, 197, 244, ${0.8 * la})`;
        ctx.fillText(fig.label.text, lp[0], lp[1]);
      }
    }
  }

  function drawBorders(layer, now, fov) {
    const lod = smooth((fov - 6) / 10);
    const p = layer.revealStart == null ? 1
      : clamp01((now - layer.revealStart) / ((REVEAL_MS || 1) * 0.7));
    const A0 = layer.alpha * lod * smooth(p);
    if (A0 <= 0.005) return;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.beginPath();
    for (const item of layer.items) for (const line of item.drawLines) tracePath(line);
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = `rgba(96, 116, 168, ${0.5 * A0})`;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(now - (lastT || now), 100);
    lastT = now;

    let animating = false;
    let anyVisible = false;
    for (const k in layers) {
      const L = layers[k];
      const step = 1 - Math.exp(-dt / FADE_TAU);
      L.alpha += (L.target - L.alpha) * step;
      if (Math.abs(L.target - L.alpha) > 0.004) animating = true;
      else L.alpha = L.target;
      if (L.revealStart != null) {
        const span = REVEAL_MS + L.items.length * STAGGER_MS;
        if (now - L.revealStart < span) animating = true;
        else L.revealStart = null;
      }
      if (L.alpha > 0.004) anyVisible = true;
    }

    let sig = '';
    try {
      const [ra, dec] = aladin.getRaDec();
      sig = `${ra.toFixed(5)},${dec.toFixed(5)},${aladin.getFov()[0].toFixed(4)},${W}x${H}`;
    } catch (err) { /* engine mid-init: draw anyway */ }
    const viewMoved = sig !== lastSig;

    if (!anyVisible && !animating) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      cancelAnimationFrame(raf);
      raf = null; // fully idle: the loop stops until show() restarts it
      return;
    }
    if (!viewMoved && !animating && !needsDraw) return;
    lastSig = sig;
    needsDraw = false;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    let fov = 60;
    try { fov = aladin.getFov()[0]; } catch (err) { /* keep default */ }
    if (layers.borders) drawBorders(layers.borders, now, fov);
    if (layers.figures) drawFigures(layers.figures, now, fov);
  }
  function ensureLoop() { if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); } }

  renderer = {
    setLayer(kind, items) {
      layers[kind] = { kind, items, alpha: 0, target: 0, revealStart: null };
    },
    controller(kind) {
      return {
        show() {
          const L = layers[kind];
          if (!L || L.target === 1) return;
          L.target = 1;
          L.revealStart = performance.now();
          needsDraw = true;
          ensureLoop();
        },
        hide() {
          const L = layers[kind];
          if (!L || L.target === 0) return;
          L.target = 0;
          needsDraw = true;
          ensureLoop();
        }
      };
    }
  };
  return renderer;
}

// ============================ data + wiring ============================

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

/** Spherical centroid of a figure — safe across the RA seam. */
function centroidOf(lines) {
  let x = 0, y = 0, z = 0, n = 0;
  for (const line of lines) {
    for (const [ra, dec] of line) {
      x += Math.cos(dec * D2R) * Math.cos(ra * D2R);
      y += Math.cos(dec * D2R) * Math.sin(ra * D2R);
      z += Math.sin(dec * D2R);
      n++;
    }
  }
  if (!n) return null;
  let ra = Math.atan2(y, x) * R2D;
  if (ra < 0) ra += 360;
  return [ra, Math.atan2(z, Math.hypot(x, y)) * R2D];
}

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
      // Node positions are the raw vertices (the member stars); strokes get
      // great-circle waypoints so wide-field lines curve correctly. Nodes are
      // deduped once here, then projected per frame via the closure.
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
        nodePts: (proj) => {
          const out = [];
          for (const [ra, dec] of nodes) { const p = proj(ra, dec); if (p) out.push(p); }
          return out;
        },
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

  const r = getRenderer(aladin);
  r.setLayer('figures', items);
  return { catalogs: [r.controller('figures')], count: items.length };
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
    const r = getRenderer(aladin);
    r.setLayer('borders', items);
    return { catalogs: [r.controller('borders')], count: items.length };
  } catch (err) {
    console.error('Constellation boundaries failed to build:', err);
    showToast(`Constellation boundaries failed: ${err.message}`, 'error', 10000);
    return { catalogs: [], count: 0 };
  }
}
