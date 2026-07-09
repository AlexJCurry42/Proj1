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

export function initSkyNow(aladin) {
  const btn = document.getElementById('skynow-btn');
  if (!btn) return;

  let tracking = false;
  let teardown = [];

  function stopTracking(quiet = false) {
    if (!tracking) return;
    tracking = false;
    for (const fn of teardown) { try { fn(); } catch (err) { /* best effort */ } }
    teardown = [];
    btn.setAttribute('aria-pressed', 'false');
    if (!quiet) showToast('Compass mode off. Tap Sky Now to resume.', 'info', 4000);
  }

  function oneShotZenith(latitude, longitude) {
    const { ra, dec } = zenithRaDec(latitude, longitude);
    flyTo(aladin, ra, dec, 100);
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    showToast(`Your sky at ${hh}:${mm} — centered on the point straight overhead.`, 'info', 8000);
  }

  btn.addEventListener('click', async () => {
    if (tracking) { stopTracking(); return; }

    // iOS: the motion-sensor prompt must be requested INSIDE the tap gesture,
    // before any other await, or it auto-denies.
    let motionAllowed = true;
    if (typeof DeviceOrientationEvent !== 'undefined' &&
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

    if (!motionAllowed) {
      oneShotZenith(latitude, longitude);
      showToast('Motion access was declined, so the view won\'t follow the phone — showing a zenith snapshot instead.', 'info', 7000);
      return;
    }

    // Live tracking.
    const evName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    let gotEvent = false;
    let lastApply = 0;
    const handler = (e) => {
      const heading = typeof e.webkitCompassHeading === 'number' ? e.webkitCompassHeading : null;
      const p = pointingFromOrientation(e.alpha, e.beta, e.gamma, heading);
      if (!p) return;
      gotEvent = true;
      const now = performance.now();
      if (now - lastApply < 100) return; // ~10 Hz is smooth and battery-kind
      lastApply = now;
      const { ra, dec } = altAzToRaDec(p.alt, p.az, latitude, longitude);
      try { aladin.gotoRaDec(ra, dec); } catch (err) { /* mid-animation hiccup */ }
    };
    window.addEventListener(evName, handler, true);
    teardown.push(() => window.removeEventListener(evName, handler, true));

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
    try { aladin.setFoV(70); } catch (err) { /* keep current FoV */ }
    showToast('Compass mode: point your phone at the sky and the view follows. Tap Sky Now again — or drag the sky — to stop.', 'info', 8000);
  });
}
