// Deep Sky Atlas — warp-speed zoom feedback.
//
// Primary mode ("capture"): radially smear THE ACTUAL SKY. Each active frame
// samples Aladin's live WebGL canvas and re-draws it in several concentric
// scales with falling alpha — a classic zoom blur, but built from the real
// stars and nebulae on screen, so the streaks belong to the universe you're
// looking at, not a generic overlay.
//
// Fallback mode ("particles"): some WebGL configurations clear their drawing
// buffer between frames (preserveDrawingBuffer: false), which makes the sky
// canvas unsampleable. That's detected at runtime with a tiny probe, and only
// then do we fall back to a refined particle field: gradient-tailed streaks,
// doppler-tinted (blue-shifted flying in, red-shifted pulling back).
//
// Both modes decay in ~a quarter second, ignore pointer events, and are
// disabled while animations are off (js/motion.js — OS preference or the
// dock's Animations switch).

import { motionOK } from './motion.js';

// Programmatic camera flights ("Show me something cool") suppress the warp:
// a three-second continuous zoom ramp would otherwise keep the blur at full
// energy the whole way — six full-canvas composites per frame of exactly the
// kind of extra GPU work that makes a flight stutter on a phone. The effect
// is feedback for USER zooms; a scripted flight is its own animation.
let suppressed = false;
export function setWarpSuppressed(v) { suppressed = v; }

export function initWarpEffect(aladin, onZoom = (fn) => aladin.on('zoomChanged', fn)) {
  // No init-time reduced-motion bail: the Animations toggle can flip
  // mid-session, so the check lives in the zoom handler instead.

  const canvas = document.createElement('canvas');
  canvas.id = 'warp-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.getElementById('sky-wrap').appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 1.5); // blur doesn't need retina
  let w = 0, h = 0, maxR = 1;
  function resize() {
    w = canvas.width = Math.round(canvas.clientWidth * dpr);
    h = canvas.height = Math.round(canvas.clientHeight * dpr);
    maxR = Math.hypot(w, h) / 2;
  }
  resize();
  window.addEventListener('resize', resize);

  // ---- live sky sampling -------------------------------------------------
  let srcCanvas = null;
  function skyCanvas() {
    if (!srcCanvas || !srcCanvas.isConnected || !srcCanvas.width) {
      srcCanvas = document.querySelector('#aladin-lite-div canvas');
    }
    return srcCanvas && srcCanvas.width ? srcCanvas : null;
  }

  // 8×8 probe: can we actually read pixels out of the sky canvas?
  const probe = document.createElement('canvas');
  probe.width = probe.height = 8;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  let mode = 'probe'; // 'probe' → 'capture' | 'particles'
  let probeOk = 0, probeBlank = 0;

  function sampleIsLive(src) {
    try {
      pctx.clearRect(0, 0, 8, 8);
      pctx.drawImage(src, 0, 0, 8, 8);
      const d = pctx.getImageData(0, 0, 8, 8).data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] | d[i + 1] | d[i + 2]) return true;
      }
      return false;
    } catch (err) {
      return false;
    }
  }

  // ---- fallback particle field -------------------------------------------
  const stars = Array.from({ length: 110 }, () => ({
    a: Math.random() * Math.PI * 2,
    r: Math.pow(Math.random(), 0.7), // bias outward, keep center clean
    b: 0.4 + Math.random() * 0.6,
    w: 0.6 + Math.random() * 1.2
  }));

  let intensity = 0;   // 0..1, energy injected by zoom changes, decays fast
  let dir = 1;         // +1 zoom in (streaks fly outward), -1 zoom out
  let lastFov = null;
  let raf = null;
  let lastT = 0;

  onZoom(() => {
    if (suppressed || !motionOK()) { lastFov = null; return; } // and no dz spike on resume
    let fov;
    try { fov = aladin.getFov()[0]; } catch (err) { return; }
    if (!(fov > 0)) return;
    if (lastFov != null && fov !== lastFov) {
      const dz = Math.log(lastFov / fov); // >0 means zooming in
      dir = dz >= 0 ? 1 : -1;
      intensity = Math.min(1, intensity + Math.min(0.5, Math.abs(dz) * 2.2));
      if (!raf) {
        lastT = performance.now();
        raf = requestAnimationFrame(frame);
      }
    }
    lastFov = fov;
  });

  // Radial zoom blur of the live sky: concentric re-draws, fading outward.
  function drawCapture(src) {
    const cx = w / 2, cy = h / 2;
    const layers = 6;
    const spread = 0.075 * intensity; // how far the smear reaches
    for (let i = 1; i <= layers; i++) {
      const t = i / layers;
      const s = dir > 0 ? 1 + spread * t : 1 / (1 + spread * t);
      ctx.globalAlpha = 0.22 * intensity * (1 - 0.6 * t);
      ctx.setTransform(s, 0, 0, s, cx - s * cx, cy - s * cy);
      ctx.drawImage(src, 0, 0, w, h);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  // Refined 2D fallback: gradient-tailed streaks with doppler tinting.
  function drawParticles(dt) {
    const cx = w / 2, cy = h / 2;
    // Approaching starlight blue-shifts; receding red-shifts.
    const [tr, tg, tb] = dir > 0 ? [200, 222, 255] : [255, 214, 186];
    ctx.lineCap = 'round';
    const speed = Math.pow(intensity, 1.35);
    for (const s of stars) {
      s.r += dir * speed * (dt / 1000) * 0.55 * (0.25 + s.r);
      if (s.r > 1) s.r -= 0.97;
      if (s.r < 0.03) s.r += 0.97;

      const r = s.r * maxR;
      if (r < maxR * 0.08) continue;
      const len = dir * speed * maxR * 0.07 * (0.25 + s.r) * s.b;
      const cos = Math.cos(s.a), sin = Math.sin(s.a);
      const x1 = cx + cos * r, y1 = cy + sin * r;
      const x2 = cx + cos * (r + len), y2 = cy + sin * (r + len);
      const alpha = Math.min(0.4, intensity * 0.5) * s.b * (0.25 + 0.75 * s.r);
      // Transparent tail → bright head, so streaks read as motion, not sticks.
      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      grad.addColorStop(0, `rgba(${tr},${tg},${tb},0)`);
      grad.addColorStop(1, `rgba(${tr},${tg},${tb},${alpha.toFixed(3)})`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = s.w * dpr;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  function frame(t) {
    const dt = Math.min(t - lastT, 50);
    lastT = t;
    intensity *= Math.exp(-dt / 240); // ~quarter-second decay
    ctx.clearRect(0, 0, w, h);
    if (intensity < 0.02) { raf = null; return; }

    const src = mode !== 'particles' ? skyCanvas() : null;
    if (src) {
      if (mode === 'probe') {
        // Decide once, while the engine is actively re-rendering (i.e. now).
        if (sampleIsLive(src)) { if (++probeOk >= 4) mode = 'capture'; drawCapture(src); }
        else if (++probeBlank >= 12 && probeOk === 0) mode = 'particles';
      } else {
        drawCapture(src); // a cleared (transparent) buffer simply draws nothing
      }
    }
    if (mode === 'particles' || !src) drawParticles(dt);

    // Punch the effect out of the center: the view's focal point must stay
    // crisp and untouched — no fog, no ghost copies, no wash — with the
    // streaks feathering in from ~10% of the radius outward.
    const cx = w / 2, cy = h / 2;
    const hole = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 0.22);
    hole.addColorStop(0, 'rgba(0,0,0,1)');
    hole.addColorStop(0.45, 'rgba(0,0,0,1)');
    hole.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = hole;
    ctx.fillRect(cx - maxR * 0.22, cy - maxR * 0.22, maxR * 0.44, maxR * 0.44);
    ctx.globalCompositeOperation = 'source-over';

    raf = requestAnimationFrame(frame);
  }
}
