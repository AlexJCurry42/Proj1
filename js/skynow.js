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

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Greenwich mean sidereal time in degrees (Meeus eq. 12.4, linear term). */
export function gmstDeg(date = new Date()) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const d = jd - 2451545.0;
  let gmst = (280.46061837 + 360.98564736629 * d) % 360;
  return gmst < 0 ? gmst + 360 : gmst;
}

/** Zenith equatorial coordinates: RA = local sidereal time, Dec = latitude. */
export function zenithRaDec(latDeg, lonEastDeg, date = new Date()) {
  const lst = ((gmstDeg(date) + lonEastDeg) % 360 + 360) % 360;
  return { ra: lst, dec: Math.max(-90, Math.min(90, latDeg)) };
}

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

/** Horizontal (alt/az) → equatorial (RA/Dec) for an observer, now. */
export function altAzToRaDec(altDeg, azDeg, latDeg, lonEastDeg, date = new Date()) {
  const alt = altDeg * D2R, az = azDeg * D2R, lat = latDeg * D2R;
  const sinDec = Math.sin(alt) * Math.sin(lat) + Math.cos(alt) * Math.cos(lat) * Math.cos(az);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec))) * R2D;
  const haDeg = Math.atan2(
    -Math.sin(az) * Math.cos(alt),
    Math.sin(alt) * Math.cos(lat) - Math.cos(alt) * Math.sin(lat) * Math.cos(az)
  ) * R2D;
  const lst = gmstDeg(date) + lonEastDeg;
  const ra = ((lst - haDeg) % 360 + 360) % 360;
  return { ra, dec };
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('no geolocation on this browser')); return; }
    navigator.geolocation.getCurrentPosition(resolve, (e) => reject(new Error(e.message)), {
      timeout: 8000, maximumAge: 60000
    });
  });
}

// ---- smoothing helpers: pointing directions as celestial unit vectors ----
// Working in vectors (not angles) makes the smoothing seamless across the
// RA 0/360 wrap and near the poles, where angle-space interpolation whips.
const raDecToVec = (raDeg, decDeg) => {
  const r = raDeg * D2R, d = decDeg * D2R, cd = Math.cos(d);
  return [cd * Math.cos(r), cd * Math.sin(r), Math.sin(d)];
};
const vecToRaDec = (v) => {
  let ra = Math.atan2(v[1], v[0]) * R2D;
  if (ra < 0) ra += 360;
  return { ra, dec: Math.asin(Math.max(-1, Math.min(1, v[2]))) * R2D };
};
const vecMix = (a, b, k) => {
  const x = a[0] + (b[0] - a[0]) * k, y = a[1] + (b[1] - a[1]) * k, z = a[2] + (b[2] - a[2]) * k;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

export function initSkyNow(aladin) {
  const btn = document.getElementById('skynow-btn');
  const gyroBtn = document.getElementById('gyro-toggle');
  if (!btn) return;

  // Whether Sky Now should engage live gyro tracking (the compass toggle).
  const readGyroPref = () => {
    try { return localStorage.getItem('dsa-gyro') !== 'false'; } catch (err) { return true; }
  };
  const writeGyroPref = (v) => {
    try { localStorage.setItem('dsa-gyro', String(v)); } catch (err) { /* private mode */ }
  };

  let tracking = false;
  let teardown = [];

  function stopTracking(quiet = false) {
    if (!tracking) return;
    tracking = false;
    for (const fn of teardown) { try { fn(); } catch (err) { /* best effort */ } }
    teardown = [];
    btn.setAttribute('aria-pressed', 'false');
    gyroBtn?.setAttribute('aria-pressed', 'false');
    if (!quiet) showToast('Gyro tracking off — drag to explore. Tap the compass to resume.', 'info', 4000);
  }

  function oneShotZenith(latitude, longitude) {
    const { ra, dec } = zenithRaDec(latitude, longitude);
    flyTo(aladin, ra, dec, 100);
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    showToast(`Your sky at ${hh}:${mm} — centered on the point straight overhead.`, 'info', 8000);
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
    const handler = (e) => {
      const heading = typeof e.webkitCompassHeading === 'number' ? e.webkitCompassHeading : null;
      const p = pointingFromOrientation(e.alpha, e.beta, e.gamma, heading);
      if (!p) return;
      gotEvent = true;
      const { ra, dec } = altAzToRaDec(p.alt, p.az, latitude, longitude);
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
    try { aladin.setFoV(70); } catch (err) { /* keep current FoV */ }
    showToast('Point your phone at the sky and the view follows. Tap the compass — or drag the sky — to stop.', 'info', 8000);
  }

  // Shared entry: permission prompt first (iOS requires it inside the tap
  // gesture, before any other await), then location, then track or snapshot.
  async function engage(wantTracking) {
    let motionAllowed = wantTracking;
    if (wantTracking &&
        typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      motionAllowed = await DeviceOrientationEvent.requestPermission()
        .then(p => p === 'granted')
        .catch(() => false);
    }

    let pos;
    try {
      showToast('Finding your sky…', 'info', 3000);
      pos = await getPosition();
    } catch (err) {
      showToast(`Location unavailable (${err.message}). Allow location access to use Sky Now — your position never leaves this device.`, 'error', 9000);
      return;
    }
    const { latitude, longitude } = pos.coords;

    if (!wantTracking) { oneShotZenith(latitude, longitude); return; }
    if (!motionAllowed) {
      oneShotZenith(latitude, longitude);
      showToast('Motion access was declined, so the view won\'t follow the phone — showing a zenith snapshot instead.', 'info', 7000);
      return;
    }
    await startTracking(latitude, longitude);
  }

  // Sky Now: show my sky (tracking it live if the gyro toggle is on).
  btn.addEventListener('click', () => {
    if (tracking) { stopTracking(); return; }
    engage(readGyroPref());
  });

  // The compass: explicit gyro on/off, independent of Sky Now.
  gyroBtn?.addEventListener('click', () => {
    if (tracking) {
      writeGyroPref(false);
      stopTracking();
    } else {
      writeGyroPref(true);
      engage(true);
    }
  });
}
