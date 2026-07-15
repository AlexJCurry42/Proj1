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
import { altAzToRaDec, zenithRaDec, raDecToVec, vecToRaDec, D2R, R2D } from './astro.js';
import { appNow, timeOffsetMs } from './clock.js';
import { motionOK } from './motion.js';
export { requestObserver } from './observer.js';

const CARDINALS = [
  ['N', 0, true], ['NE', 45, false], ['E', 90, true], ['SE', 135, false],
  ['S', 180, true], ['SW', 225, false], ['W', 270, true], ['NW', 315, false]
];

export function initHorizonLayer(aladin, observer) {
  // alt/az (observer frame, now) -> screen px via the shared projector.
  function draw(ctx, view, state) {
    const alpha = state.alpha;
    const date = appNow(); // follows the time scrubber — YOUR horizon, THEN
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
    extraSig: () => `${Math.floor(performance.now() / 10000)}|${timeOffsetMs()}` // sidereal drift + time scrubs
  });
  return { show: () => ctl.show(), hide: () => ctl.hide() };
}

/**
 * The horizon lock: a moderate up-is-up assist. Panning a sphere lets the
 * sky roll until "up" on screen points anywhere, which is what makes the
 * spherical views disorienting. While the user moves (and for a beat
 * after), this gently rotates the view so the direction toward THEIR
 * zenith reads as screen-up — the horizon levels itself out. It is an
 * assist, not a cage: small tilts inside the deadband are left alone,
 * corrections are rate-capped, and it goes fully idle when the view rests.
 *
 * Engine rotation convention (probed empirically): setRotation/getRotation
 * are in degrees, and a world direction's on-screen position angle equals
 * its angle at rotation 0 MINUS the rotation — so adding the measured tilt
 * error to the current rotation re-levels the view. gotoRaDec preserves
 * rotation, so the lock composes cleanly with pans, flights and tracking.
 */
export function initHorizonLock(aladin, onPosition) {
  let observer = null;
  let enabled = false;
  let raf = null;
  let lastActivityT = 0;

  // NEVER rotate while a pointer is down — and NEVER while the view is
  // still coasting. The engine anchors both an active drag and the fling
  // that follows it to a sky point computed in the current rotation frame;
  // rotating mid-anchor breaks it, which read as "horizontal scrolling
  // just doesn't work" (the fling died the instant the lock stepped in).
  // Leveling begins only in the quiet AFTER the view comes to rest.
  let pointerDown = false;
  let pointersDown = 0;
  let multiTouch = false;     // pinch/two-finger: the user is steering deliberately
  let movedInGesture = false; // taps must not trigger leveling
  const wrap = document.getElementById('sky-wrap');
  wrap?.addEventListener('pointerdown', () => {
    pointersDown++;
    if (pointersDown > 1) multiTouch = true;
    if (!pointerDown) movedInGesture = false;
    pointerDown = true;
  }, true);
  const gestureEnd = () => {
    if (!pointerDown) return;
    pointersDown = Math.max(0, pointersDown - 1);
    if (pointersDown > 0) return;
    pointerDown = false;
    if (multiTouch) {
      // A pinch zoom or two-finger rotation is a deliberate act — leveling
      // right on its heels read as the view "adjusting its angle on its
      // own". Spend the episode instead of starting one.
      multiTouch = false;
      budget = 0;
      return;
    }
    if (movedInGesture) wake(true); // a real pan ended: fresh allowance, level once at rest
  };
  window.addEventListener('pointerup', gestureEnd, true);
  window.addEventListener('pointercancel', gestureEnd, true);
  // A drag released outside the window loses its pointerup — never leave
  // the guard stuck (it silenced the lock until the next tap).
  window.addEventListener('blur', () => { pointerDown = false; pointersDown = 0; multiTouch = false; });

  // Screen tilt of the zenith direction at the view center, in degrees
  // (0 = zenith reads straight up); null when it can't be measured.
  function zenithTilt() {
    let ra0, dec0, fov;
    try { [ra0, dec0] = aladin.getRaDec(); fov = aladin.getFov()[0]; } catch (err) { return null; }
    const zen = zenithRaDec(observer.lat, observer.lon, appNow());
    const c = raDecToVec(ra0, dec0);
    const z = raDecToVec(zen.ra, zen.dec);
    const dot = c[0] * z[0] + c[1] * z[1] + c[2] * z[2];
    // Within ~10° of the zenith/nadir "up" is ill-defined and flips 180°
    // as the center crosses over — chasing that reads as a violent spin,
    // so the lock stands down in the whole neighborhood.
    if (Math.abs(dot) > 0.985) return null;
    // Unit tangent at the view center, pointing along the great circle
    // toward the zenith; project a small step along it and measure the
    // screen angle of that step.
    const t = [z[0] - dot * c[0], z[1] - dot * c[1], z[2] - dot * c[2]];
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    const s = Math.min(4, Math.max(0.05, fov * 0.12)) * D2R;
    const cs = Math.cos(s), sn = Math.sin(s) / tl;
    const { ra, dec } = vecToRaDec([
      c[0] * cs + t[0] * sn, c[1] * cs + t[1] * sn, c[2] * cs + t[2] * sn
    ]);
    let p0, p1;
    try { p0 = aladin.world2pix(ra0, dec0); p1 = aladin.world2pix(ra, dec); } catch (err) { return null; }
    if (!p0 || !p1) return null;
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    if (dx * dx + dy * dy < 4) return null; // too short to trust
    return Math.atan2(dx, -dy) * R2D;
  }

  // MODERATE means bounded and gated:
  //  · REST first — no steering until REST_MS after the last position
  //    event, so drags AND their inertia flings finish untouched;
  //  · a FoV gate — zoomed onto an object the horizon isn't even in
  //    frame, and a frame rotation there reads as the view "adjusting its
  //    angle on its own"; authority fades out entirely below ~16° fields;
  //  · rate-capped at STEP_MAX per frame (a glide, never a snap) with a
  //    per-episode allowance that scales with the actual tilt, so a big
  //    swipe levels fully instead of stalling partway (the old fixed 28°
  //    budget plus a >150° skip zone left heavily-rolled views stuck —
  //    "the lock just doesn't work");
  //  · direction latched per episode: past ~170° the shorter way flips on
  //    measurement noise, and re-deciding every frame oscillates.
  const REST_MS = 320;
  const STEP_MAX = 0.6; // deg per frame ≈ 36°/s
  let budget = 0;
  let latchedSign = 0;

  function fovScale() {
    let fov;
    try { fov = aladin.getFov()[0]; } catch (err) { return 0; }
    return Math.max(0, Math.min(1, (fov - 16) / 14)); // 0 below 16°, full from 30°
  }

  function frame() {
    raf = null;
    if (!enabled || !observer) return;
    const now = performance.now();
    if (now - lastActivityT > 2800) return; // the view is at rest: stand down
    raf = requestAnimationFrame(frame);
    if (pointerDown) return;                 // finger owns the view: watch, don't steer
    if (now - lastActivityT < REST_MS) return; // inertia still coasting: wait for quiet
    const scale = fovScale();
    if (scale <= 0 || budget <= 0) return;
    let err = zenithTilt();
    if (err == null || Math.abs(err) <= 3) { latchedSign = 0; return; }
    if (latchedSign === 0) latchedSign = err >= 0 ? 1 : -1;
    // Near 180° the short way is ambiguous; stay on the episode's latched
    // side even when noise flips the measurement.
    if (Math.abs(err) > 150 && (err >= 0 ? 1 : -1) !== latchedSign) err = latchedSign * (360 - Math.abs(err)) % 360;
    let rot = 0;
    try { rot = aladin.getRotation(); } catch (err2) { return; }
    const cap = STEP_MAX * scale;
    const stepDeg = motionOK()
      ? Math.max(-cap, Math.min(cap, err * 0.06))
      : Math.max(-budget, Math.min(budget, err)); // no animations: one capped snap
    budget -= Math.abs(stepDeg);
    try { aladin.setRotation(rot + stepDeg); } catch (err2) { /* engine hiccup */ }
    // Steering is activity: keep the window open so the glide finishes its
    // allowance instead of being cut off mid-level (bounded by the budget).
    lastActivityT = now - REST_MS;
  }
  const wake = (fresh = false) => {
    lastActivityT = performance.now();
    if (!enabled || !observer) return;
    if (fresh || !raf) {
      // Allowance scales with the mess to clean up: small tilts get the
      // gentle minimum, a hard swipe gets enough to actually finish.
      const err = zenithTilt();
      budget = Math.max(28, Math.min(120, Math.abs(err ?? 0) * 1.1));
      latchedSign = 0;
    }
    if (!raf) raf = requestAnimationFrame(frame);
  };
  onPosition(() => {
    if (pointerDown) movedInGesture = true;
    wake();
  });

  return {
    setObserver(obs) { observer = obs; },
    setEnabled(v) { enabled = v; if (v) wake(); }
  };
}
