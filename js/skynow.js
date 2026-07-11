// Deep Sky Atlas — "Sky Now" compass mode. Tap: the view flies to your
// zenith and then TRACKS the phone — point the device anywhere and the atlas
// shows the sky behind it, live (back-camera axis → alt/az → RA/Dec via
// local sidereal time). Tap again, or drag the sky, to stop. Devices without
// motion sensors (or denied permission) fall back to a one-shot zenith view.
//
// Privacy: location and motion sensors are consumed entirely on-device;
// nothing is transmitted anywhere.

import { showToast } from './ui.js';
import { flyTo } from './search.js';
import { D2R, R2D, altAzToRaDec, zenithRaDec, raDecToVec, vecToRaDec, vecMix } from './astro.js';
import { appNow, isTimeShifted } from './clock.js';
import { requestObserver, seedObserver } from './observer.js';

// Re-exports kept for compatibility (tests and older callers).
export { gmstDeg, zenithRaDec, altAzToRaDec } from './astro.js';

/**
 * Where is the phone pointing? W3C device orientation (α,β,γ) rotates the
 * device frame into the Earth frame (x East, y North, z Up); the pointing
 * direction is the back-camera axis, device -z — conveniently invariant
 * under screen rotation, so portrait/landscape both work untouched.
 * On iOS, α is relative; webkitCompassHeading supplies the absolute yaw
 * (α = 360 − heading). Returns azimuth (° east of north) and altitude (°).
 */
export function pointingFromOrientation(alpha, beta, gamma, compassHeading = null) {
  if (alpha == null || beta == null || gamma == null) return null;
  if (typeof compassHeading === 'number' && !Number.isNaN(compassHeading)) {
    alpha = 360 - compassHeading;
  }
  const a = alpha * D2R, b = beta * D2R, g = gamma * D2R;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cg = Math.cos(g), sg = Math.sin(g);
  // v_earth = R(α,β,γ) · (0,0,−1) — third column of R, negated.
  const vE = -(ca * sg + sa * sb * cg); // East
  const vN = -(sa * sg - ca * sb * cg); // North
  const vU = -(cb * cg);                // Up
  let az = Math.atan2(vE, vN) * R2D;
  if (az < 0) az += 360;
  const alt = Math.asin(Math.max(-1, Math.min(1, vU))) * R2D;
  return { az, alt };
}

export function initSkyNow(aladin, { onTrackingStart } = {}) {
  const btn = document.getElementById('skynow-btn');
  const gyroBtn = document.getElementById('gyro-toggle');
  if (!btn) return;

  let tracking = false;
  let teardown = [];

  function stopTracking(quiet = false) {
    if (!tracking) return;
    tracking = false;
    for (const fn of teardown) { try { fn(); } catch (err) { /* best effort */ } }
    teardown = [];
    btn.setAttribute('aria-pressed', 'false');
    gyroBtn?.setAttribute('aria-pressed', 'false');
    gyroBtn?.classList.remove('acquiring');
    if (!quiet) showToast('Gyro tracking off — drag to explore. Tap the compass to resume.', 'info', 4000);
  }

  // Cinematic FoV breathe used when tracking engages (never a snap).
  function easeFovTo(toFov, ms = 900) {
    let from;
    try { from = aladin.getFov()[0]; } catch (err) { return; }
    if (!Number.isFinite(from) || Math.abs(from - toFov) < 0.5) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      try { aladin.setFoV(toFov); } catch (err) { /* engine hiccup */ }
      return;
    }
    const t0 = performance.now();
    let raf = null;
    const step = (t) => {
      const u = Math.min(1, (t - t0) / ms);
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      try { aladin.setFoV(from + (toFov - from) * e); } catch (err) { /* engine hiccup */ }
      if (u < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    teardown.push(() => cancelAnimationFrame(raf));
  }

  function oneShotZenith(latitude, longitude) {
    // Follows the time scrubber: "Sky Now" becomes "Sky Then" when scrubbed.
    const now = appNow();
    const { ra, dec } = zenithRaDec(latitude, longitude, now);
    flyTo(aladin, ra, dec, 100);
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const when = isTimeShifted()
      ? `${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${hh}:${mm}`
      : `${hh}:${mm}`;
    showToast(`Your sky at ${when} — centered on the point straight overhead.`, 'info', 8000);
  }

  async function startTracking(latitude, longitude) {
    const evName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    let gotEvent = false;

    // Two-stage smoothing. Stage 1: each sensor reading nudges a low-passed
    // TARGET vector (kills magnetometer jitter without adding much lag).
    // Stage 2: a per-frame critically-damped glide eases the DISPLAYED
    // pointing toward the target — tiny 60 fps steps instead of the old
    // 10 Hz gotoRaDec jumps, which is what made tracking feel clunky.
    let target = null;
    let shown = null;
    // COMPLEMENTARY FILTER — the fix for point-jumping on iPhones.
    // The OS's sensor-fused alpha/beta/gamma stream is silky-smooth but its
    // yaw is RELATIVE (arbitrary zero). webkitCompassHeading is ABSOLUTE but
    // raw magnetometer: noisy, glitchy, and gimbal-unstable exactly when the
    // phone points up at the sky (heading is defined around gravity, so near
    // vertical, tiny wobbles swing it wildly — the source of the jumps).
    // So: ALL motion comes from the smooth relative stream, and the compass
    // contributes only a slowly-trusted azimuth offset that anchors it to
    // true north. Compass glitches barely dent the offset; dropouts simply
    // pause its updates. Android's absolute stream needs no offset at all.
    // The compass corrects the gyro frame CONTINUOUSLY — the anchor moves
    // with the user, so pointing at the same real-world direction always
    // shows the same sky. Two mechanisms share the work:
    //  · gentle correction, weighted by how much geometric signal the
    //    compass carries (webkitCompassHeading is the top edge projected on
    //    the horizon, so its information fades as the phone tips vertical
    //    and vanishes in the last ~10°, where rolls spin it full-circle);
    //  · a consistency tracker that tells NOISE from REORIENTATION: compass
    //    readings scattered everywhere are ignored, but readings that agree
    //    with each other while disagreeing with the anchor mean the gyro
    //    frame really rotated (walking, turning, an iOS re-reference) — the
    //    anchor snaps to the new consensus within about a second.
    let azOffset = null;
    let cand = null;    // fast follower of the compass-implied offset
    let agreeMs = 0;    // how long the consensus has disagreed with the anchor
    let lastEvT = 0;
    const wrap180 = (d) => { d = ((d + 180) % 360 + 360) % 360 - 180; return d; };
    const handler = (e) => {
      const rel = pointingFromOrientation(e.alpha, e.beta, e.gamma, null);
      if (!rel) return;
      gotEvent = true;
      gyroBtn?.classList.remove('acquiring');
      const now = performance.now();
      const dtE = Math.min(now - (lastEvT || now), 100);
      lastEvT = now;
      const fr = dtE / 16.7; // event-rate normalization (gains are per-60Hz-frame)

      const heading = (typeof e.webkitCompassHeading === 'number' &&
                       !Number.isNaN(e.webkitCompassHeading) &&
                       e.webkitCompassHeading >= 0) ? e.webkitCompassHeading : null;
      if (heading != null) {
        const cb = Math.abs(Math.cos((e.beta || 0) * D2R));
        const w = Math.min(1, Math.max(0, (cb - 0.12) / 0.45));
        if (w > 0) {
          const abs = pointingFromOrientation(e.alpha, e.beta, e.gamma, heading);
          if (abs) {
            const d = wrap180(abs.az - rel.az);
            if (azOffset == null) {
              azOffset = d;
              cand = d;
            } else {
              cand = cand == null ? d
                : wrap180(cand + wrap180(d - cand) * Math.min(1, 0.12 * w * fr));
              const disagree = Math.abs(wrap180(cand - azOffset));
              const candStable = Math.abs(wrap180(d - cand)) < 15;
              if (disagree > 20 && candStable && w > 0.2) {
                agreeMs += dtE;
                if (agreeMs > 1100) { azOffset = cand; agreeMs = 0; } // the world moved: re-anchor
              } else {
                agreeMs = Math.max(0, agreeMs - dtE * 2);
              }
              const dd = wrap180(d - azOffset);
              const k = (Math.abs(dd) > 25 ? 0.02 : 0.09) * w * fr;
              azOffset = wrap180(azOffset + dd * Math.min(0.3, k));
            }
          }
        }
      }

      const az = azOffset != null ? rel.az + azOffset : rel.az;
      // appNow(): with the clock scrubbed, pointing the phone somewhere shows
      // what will be in that direction at the scrubbed time — the sky, layers
      // and tracker all agree on one moment.
      const { ra, dec } = altAzToRaDec(rel.alt, ((az % 360) + 360) % 360, latitude, longitude, appNow());
      const v = raDecToVec(ra, dec);
      target = target ? vecMix(target, v, 0.3) : v;
    };
    window.addEventListener(evName, handler, true);
    teardown.push(() => window.removeEventListener(evName, handler, true));

    let raf = null, lastT = 0;
    const DEADBAND = Math.cos(0.02 * D2R); // skip engine calls under 0.02°
    const tick = (t) => {
      raf = requestAnimationFrame(tick);
      if (!target) return;
      const dt = Math.min((t - (lastT || t)) / 1000, 0.1);
      lastT = t;
      if (!shown) {
        // Glide in from wherever the user is looking, not a hard cut.
        try { const [ra0, dec0] = aladin.getRaDec(); shown = raDecToVec(ra0, dec0); }
        catch (err) { shown = target; }
      }
      // Frame-rate-independent damping: ~63% of the way per 180 ms.
      shown = vecMix(shown, target, 1 - Math.exp(-dt / 0.18));
      const dot = shown[0] * target[0] + shown[1] * target[1] + shown[2] * target[2];
      if (dot > DEADBAND) return;
      const { ra, dec } = vecToRaDec(shown);
      try { aladin.gotoRaDec(ra, dec); } catch (err) { /* mid-animation hiccup */ }
    };
    raf = requestAnimationFrame(tick);
    teardown.push(() => cancelAnimationFrame(raf));

    // No events within 2.5 s → this device has no usable sensors.
    const fallbackTimer = setTimeout(() => {
      if (!gotEvent) {
        stopTracking(true);
        oneShotZenith(latitude, longitude);
        showToast('No motion sensors detected — showing a zenith snapshot instead.', 'info', 7000);
      }
    }, 2500);
    teardown.push(() => clearTimeout(fallbackTimer));

    // Dragging the sky is a manual override: hand control back instantly.
    const skyWrap = document.getElementById('sky-wrap');
    const dragStop = () => stopTracking();
    skyWrap.addEventListener('pointerdown', dragStop);
    teardown.push(() => skyWrap.removeEventListener('pointerdown', dragStop));

    // Keep the screen awake while stargazing (best effort).
    try {
      const lock = await navigator.wakeLock?.request('screen');
      if (lock) teardown.push(() => lock.release().catch(() => {}));
    } catch (err) { /* not critical */ }

    tracking = true;
    btn.setAttribute('aria-pressed', 'true');
    gyroBtn?.setAttribute('aria-pressed', 'true');
    gyroBtn?.classList.add('acquiring'); // pulses until the first sensor fix
    // Kill any in-flight fly-to animation (zenith snapshot, tour, search):
    // a running animator would tug the camera back along its own path every
    // frame, fighting the tracker. Re-issuing the current position as a
    // plain goto supersedes it.
    try { const [r0, d0] = aladin.getRaDec(); aladin.gotoRaDec(r0, d0); } catch (err) { /* fresh view */ }
    // Cinematic engage: the FoV breathes to a sky-window width while the
    // tracker glides toward where the phone points — never a hard cut.
    easeFovTo(70, 900);
    // Orientation context comes on with tracking: the horizon line, cardinal
    // directions and zenith marker (app.js wires this to the layer dock).
    try { onTrackingStart?.(latitude, longitude); } catch (err) { /* optional */ }
    showToast('Point your phone at the sky and the view follows. Tap the compass — or drag the sky — to stop.', 'info', 8000);
  }

  // Shared entry: permission prompt first (iOS requires it inside the tap
  // gesture, before any other await), then location, then track or snapshot.
  // Re-entrancy guard: engage() spends seconds awaiting permission and
  // location, and a second tap in that window must not spin up a competing
  // tracker loop.
  let engaging = false;
  async function engage(wantTracking) {
    if (engaging) return;
    engaging = true;
    try { await engageInner(wantTracking); } finally { engaging = false; }
  }
  async function engageInner(wantTracking) {
    let motionAllowed = wantTracking;
    if (wantTracking &&
        typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      motionAllowed = await DeviceOrientationEvent.requestPermission()
        .then(p => p === 'granted')
        .catch(() => false);
    }

    let obs;
    try {
      showToast('Finding your sky…', 'info', 3000);
      obs = await requestObserver(); // shared, session-cached location
    } catch (err) {
      showToast(`Location unavailable (${err.message}). Allow location access to use Sky Now — your position never leaves this device.`, 'error', 9000);
      return;
    }
    const { lat: latitude, lon: longitude } = seedObserver(obs.lat, obs.lon);

    if (!wantTracking) { oneShotZenith(latitude, longitude); return; }
    if (!motionAllowed) {
      oneShotZenith(latitude, longitude);
      showToast('Motion access was declined, so the view won\'t follow the phone — showing a zenith snapshot instead.', 'info', 7000);
      return;
    }
    await startTracking(latitude, longitude);
  }

  // Sky Now: a zenith snapshot, nothing more — it never starts motion
  // tracking. If tracking is running, it stops it and shows the zenith.
  btn.addEventListener('click', () => {
    if (tracking) stopTracking(true);
    engage(false);
  });

  // The compass alone owns motion tracking: tap on, tap off.
  gyroBtn?.addEventListener('click', () => {
    if (tracking) stopTracking();
    else engage(true);
  });
}
