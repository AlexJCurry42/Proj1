// Pocket Planetarium — the local horizon & compass overlay. Draws YOUR
// horizon on the celestial sphere: the great circle of altitude 0° for the
// observer's location at the current moment, with cardinal direction labels
// (N accented like a compass), azimuth tick marks, and a zenith marker.
// This is the layer that turns the atlas into a backyard instrument.
//
// Draws on the unified overlay engine; a 10 s time bucket in the dirty
// signature keeps the line pinned as the sky rotates (~0.25°/minute).
// Privacy: the observer's location is consumed entirely on-device.

import { getOverlay, haloText } from './overlay.js';
import { altAzToRaDec } from './astro.js';
export { requestObserver } from './observer.js';

const CARDINALS = [
  ['N', 0, true], ['NE', 45, false], ['E', 90, true], ['SE', 135, false],
  ['S', 180, true], ['SW', 225, false], ['W', 270, true], ['NW', 315, false]
];

export function initHorizonLayer(aladin, observer) {
  // alt/az (observer frame, now) -> screen px via the shared projector.
  function draw(ctx, view, state) {
    const alpha = state.alpha;
    const date = new Date();
    const proj = (altDeg, azDeg) => {
      const { ra, dec } = altAzToRaDec(altDeg, azDeg, observer.lat, observer.lon, date);
      return view.proj(ra, dec);
    };
    const MAX_SEG = 0.6 * Math.max(view.W, view.H);

    // ---- the horizon line ----
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let pen = false, px = 0, py = 0;
    for (let az = 0; az <= 360; az += 2) {
      const p = proj(0, az);
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
      const a = proj(0, az), b = proj(1.6, az);
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
      const p = proj(3.4, az);
      if (!p) continue;
      ctx.font = major
        ? '800 13px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif'
        : '650 10px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
      const a = (major ? 0.85 : 0.55) * alpha;
      // North gets the compass accent so orientation reads at a glance.
      const fill = label === 'N' ? `rgba(255, 122, 100, ${a})` : `rgba(173, 240, 200, ${a})`;
      haloText(ctx, label, p[0], p[1], fill, `rgba(2, 8, 5, ${0.65 * a})`);
    }

    // ---- zenith marker ----
    const z = proj(90, 0);
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
      haloText(ctx, 'ZENITH', z[0], z[1] + 15,
        `rgba(173, 240, 200, ${0.6 * alpha})`, `rgba(2, 8, 5, ${0.4 * alpha})`, 2.5);
    }
  }

  const ctl = getOverlay(aladin).addLayer({
    z: 20,
    draw,
    extraSig: () => String(Math.floor(performance.now() / 10000)) // sidereal drift
  });
  return { show: () => ctl.show(), hide: () => ctl.hide() };
}
