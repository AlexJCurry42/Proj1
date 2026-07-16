// Pocket Planetarium — the unified sky-overlay engine. Constellations, the
// horizon & compass, live satellites and the marker-fade transitions all
// draw here, on ONE canvas driven by ONE animation loop.
//
// Why one: each full-viewport canvas costs the compositor a private buffer
// (~8–10 MB at phone DPR) and each private rAF loop wakes the CPU on its own
// schedule. The previous architecture ran four of each. This engine keeps a
// single buffer and a single loop that goes fully idle — zero work, loop
// stopped — whenever nothing is visible, fading, or animating.
//
// A layer registers with:
//   draw(ctx, view, state)  — paint at state.alpha; view = {W, H, fov, now}
//   z                       — stacking order (lower draws first)
//   everyFrame              — true/fn: repaint every frame while visible
//                             (satellites move; most layers don't)
//   extraSig()              — optional string folded into the dirty check
//                             (e.g. a 10 s time bucket for sidereal drift)
// and gets back a controller: show({reveal}) / hide() / dirty().
// state carries {alpha, revealStart} so layers can run entry animations.

import { motionOK } from './motion.js';

// Checked live (not cached at load): the Animations toggle can flip mid-session.
const fadeTau = () => (motionOK() ? 110 : 1);

let inst = null;

export function getOverlay(aladin) {
  if (inst) return inst;

  const wrap = document.getElementById('sky-wrap');
  const canvas = document.createElement('canvas');
  canvas.id = 'overlay-canvas';
  wrap.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let dpr = 1, W = 0, H = 0;
  let raf = null;
  let lastSig = '';
  let lastT = 0;
  let dirty = true;

  function resize() {
    // Full native resolution, up to 3× (covers every current phone). The
    // engine's own imagery canvas is hard-capped at 2× inside its wasm
    // core, but THIS canvas draws the star bloom that covers the bright
    // star cores — the exact pixels a viewer scrutinizes — plus the grid
    // and horizon lines and labels. Crisp here is visibly crisper stars.
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    const r = wrap.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    dirty = true;
    ensureLoop();
  }
  window.addEventListener('resize', resize);
  resize();

  const layers = []; // sorted by z at registration

  // Screen projection shared by every layer, with per-frame result caching:
  // several layers ask for the same points (labels vs nodes), and the wasm
  // boundary crossing is the priciest part of a frame.
  let projCache = new Map();
  const proj = (ra, dec) => {
    const key = ra + ',' + dec;
    let p = projCache.get(key);
    if (p === undefined) {
      try {
        const q = aladin.world2pix(ra, dec);
        p = (q && Number.isFinite(q[0]) && Number.isFinite(q[1])) ? q : null;
      } catch (err) { p = null; }
      projCache.set(key, p);
    }
    return p;
  };

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(now - (lastT || now), 100);
    lastT = now;

    let fading = false;
    let anyVisible = false;
    let everyFrame = false;
    for (const L of layers) {
      const st = L.state;
      st.alpha += (st.target - st.alpha) * (1 - Math.exp(-dt / fadeTau()));
      if (Math.abs(st.target - st.alpha) > 0.004) fading = true;
      else st.alpha = st.target;
      if (st.revealStart != null && now - st.revealStart > (L.revealSpan || 2500)) st.revealStart = null;
      if (st.revealStart != null) fading = true;
      if (st.alpha > 0.004) {
        anyVisible = true;
        if (typeof L.everyFrame === 'function' ? L.everyFrame() : L.everyFrame) everyFrame = true;
      }
    }

    if (!anyVisible && !fading) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      cancelAnimationFrame(raf);
      raf = null; // fully idle until a controller wakes the loop
      return;
    }

    let sig = '';
    let fov = 60;
    try {
      const [ra, dec] = aladin.getRaDec();
      fov = aladin.getFov()[0];
      const rot = aladin.getRotation?.() ?? 0; // grid/horizon must track two-finger & lock rotations
      sig = `${ra.toFixed(5)},${dec.toFixed(5)},${fov.toFixed(4)},${rot.toFixed(3)},${W}x${H}`;
    } catch (err) { /* engine mid-init: draw anyway */ }
    for (const L of layers) {
      if (L.extraSig && L.state.alpha > 0.004) sig += '|' + L.extraSig();
    }

    if (sig === lastSig && !fading && !everyFrame && !dirty) return;
    lastSig = sig;
    dirty = false;

    projCache = new Map();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const view = { W, H, fov, now, proj };
    for (const L of layers) {
      if (L.state.alpha <= 0.004) continue;
      ctx.save();
      try { L.draw(ctx, view, L.state); } catch (err) { /* one layer's bug must not kill the rest */ }
      ctx.restore();
    }
  }
  function ensureLoop() { if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); } }

  inst = {
    addLayer(spec) {
      const L = {
        ...spec,
        state: { alpha: 0, target: 0, revealStart: null }
      };
      layers.push(L);
      layers.sort((a, b) => (a.z || 0) - (b.z || 0));
      return {
        show({ reveal = false } = {}) {
          L.state.target = 1;
          if (reveal && motionOK()) L.state.revealStart = performance.now();
          dirty = true;
          ensureLoop();
        },
        hide() {
          L.state.target = 0;
          L.state.revealStart = null;
          dirty = true;
          ensureLoop();
        },
        dirty() { dirty = true; ensureLoop(); },
        state: L.state
      };
    },
    wake: ensureLoop,
    get reduceMotion() { return !motionOK(); }
  };
  return inst;
}

// ---- shared drawing helpers ----

/**
 * Trace an [ra,dec] polyline as canvas subpaths via view.proj, breaking at
 * off-view gaps and projection glitches. Returns drawn pixel length (for
 * dash-based reveals).
 */
export function tracePath(ctx, view, line) {
  const MAX_SEG = 0.6 * Math.max(view.W, view.H);
  let len = 0, pen = false, px = 0, py = 0;
  for (let i = 0; i < line.length; i++) {
    const p = view.proj(line[i][0], line[i][1]);
    if (!p) { pen = false; continue; }
    if (!pen) { ctx.moveTo(p[0], p[1]); pen = true; }
    else {
      const d = Math.hypot(p[0] - px, p[1] - py);
      if (d > MAX_SEG) ctx.moveTo(p[0], p[1]);
      else { ctx.lineTo(p[0], p[1]); len += d; }
    }
    px = p[0]; py = p[1];
  }
  return len;
}

/** Halo-backed label text (strokeText halo beats shadowBlur ~10×). */
export function haloText(ctx, text, x, y, fill, halo, haloWidth = 3) {
  ctx.strokeStyle = halo;
  ctx.lineWidth = haloWidth;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}
