// Pocket Planetarium — the local horizon & compass overlay. Draws YOUR
// horizon on the celestial sphere: the great circle of altitude 0° for the
// observer's location at the current moment, with cardinal direction labels
// (N/NE/E/…), azimuth tick marks, and a zenith marker. This is the layer
// that turns the atlas into a backyard instrument: with Sky Now or gyro
// tracking on, it shows exactly which part of the sky is above you.
//
// Rendering mirrors the constellation layer: a dedicated canvas repainted
// only when the view moves, the layer fades, or enough time passes for the
// sidereal drift to matter (~0.25°/minute — a 10 s cadence keeps the line
// visually glued to the true horizon).
//
// Privacy: the observer's location is consumed entirely on-device.

import { altAzToRaDec } from './skynow.js';

const CARDINALS = [
  ['N', 0, true], ['NE', 45, false], ['E', 90, true], ['SE', 135, false],
  ['S', 180, true], ['SW', 225, false], ['W', 270, true], ['NW', 315, false]
];

/** One-shot geolocation as a promise; the result is cached per session. */
let observerCache = null;
export function requestObserver() {
  if (observerCache) return Promise.resolve(observerCache);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('no geolocation on this browser')); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        observerCache = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        resolve(observerCache);
      },
      (e) => reject(new Error(e.message)),
      { timeout: 10000, maximumAge: 300000 }
    );
  });
}

export function initHorizonLayer(aladin, observer) {
  const wrap = document.getElementById('sky-wrap');
  const canvas = document.createElement('canvas');
  canvas.id = 'horizon-canvas';
  wrap.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let dpr = 1, W = 0, H = 0;
  let raf = null;
  let lastSig = '';
  let lastT = 0;
  let alpha = 0, target = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = wrap.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    lastSig = '';
    ensureLoop();
  }
  window.addEventListener('resize', resize);
  resize();

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FADE_TAU = reduceMotion ? 1 : 110;

  // alt/az (observer frame, now) -> screen px, or null when off-view.
  function proj(altDeg, azDeg, date) {
    const { ra, dec } = altAzToRaDec(altDeg, azDeg, observer.lat, observer.lon, date);
    let p;
    try { p = aladin.world2pix(ra, dec); } catch (err) { return null; }
    return (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) ? p : null;
  }

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (alpha <= 0.004) return;
    const date = new Date();
    const MAX_SEG = 0.6 * Math.max(W, H);

    // ---- the horizon line ----
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let pen = false, px = 0, py = 0;
    for (let az = 0; az <= 360; az += 2) {
      const p = proj(0, az, date);
      if (!p) { pen = false; continue; }
      if (!pen) { ctx.moveTo(p[0], p[1]); pen = true; }
      else {
        const d = Math.hypot(p[0] - px, p[1] - py);
        if (d > MAX_SEG) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      }
      px = p[0]; py = p[1];
    }
    ctx.strokeStyle = `rgba(126, 226, 166, ${0.16 * alpha})`;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = `rgba(151, 235, 183, ${0.72 * alpha})`;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // ---- azimuth ticks every 15° ----
    ctx.beginPath();
    for (let az = 0; az < 360; az += 15) {
      const a = proj(0, az, date), b = proj(1.6, az, date);
      if (!a || !b) continue;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 60) continue; // projection glitch
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    ctx.strokeStyle = `rgba(151, 235, 183, ${0.5 * alpha})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // ---- cardinal labels, floated just above the line ----
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [label, az, major] of CARDINALS) {
      const p = proj(3.4, az, date);
      if (!p) continue;
      ctx.font = major
        ? '800 13px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif'
        : '650 10px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
      const a = (major ? 0.85 : 0.55) * alpha;
      ctx.strokeStyle = `rgba(2, 8, 5, ${0.65 * a})`;
      ctx.lineWidth = 3;
      ctx.strokeText(label, p[0], p[1]);
      // North gets the compass accent so orientation reads at a glance.
      ctx.fillStyle = label === 'N'
        ? `rgba(255, 122, 100, ${a})`
        : `rgba(173, 240, 200, ${a})`;
      ctx.fillText(label, p[0], p[1]);
    }

    // ---- zenith marker ----
    const z = proj(90, 0, date);
    if (z) {
      ctx.strokeStyle = `rgba(151, 235, 183, ${0.7 * alpha})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(z[0], z[1], 5, 0, 6.2832);
      for (const [dx, dy] of [[8, 0], [-8, 0], [0, 8], [0, -8]]) {
        ctx.moveTo(z[0] + dx * 0.55, z[1] + dy * 0.55);
        ctx.lineTo(z[0] + dx, z[1] + dy);
      }
      ctx.stroke();
      ctx.font = '650 8.5px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = `rgba(173, 240, 200, ${0.6 * alpha})`;
      ctx.strokeStyle = `rgba(2, 8, 5, ${0.4 * alpha})`;
      ctx.lineWidth = 2.5;
      ctx.strokeText('ZENITH', z[0], z[1] + 15);
      ctx.fillText('ZENITH', z[0], z[1] + 15);
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(now - (lastT || now), 100);
    lastT = now;
    const prev = alpha;
    alpha += (target - alpha) * (1 - Math.exp(-dt / FADE_TAU));
    if (Math.abs(target - alpha) <= 0.004) alpha = target;
    const fading = alpha !== prev;

    let sig = '';
    try {
      const [ra, dec] = aladin.getRaDec();
      // The 10 s time bucket keeps the line pinned as the sky rotates.
      sig = `${ra.toFixed(5)},${dec.toFixed(5)},${aladin.getFov()[0].toFixed(4)},${W}x${H},${Math.floor(now / 10000)}`;
    } catch (err) { /* engine mid-init */ }

    if (alpha <= 0.004 && target === 0) {
      draw(now); // final clear
      cancelAnimationFrame(raf);
      raf = null;
      return;
    }
    if (sig === lastSig && !fading) return;
    lastSig = sig;
    draw(now);
  }
  function ensureLoop() { if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); } }

  return {
    show() { target = 1; lastSig = ''; ensureLoop(); },
    hide() { target = 0; ensureLoop(); }
  };
}
