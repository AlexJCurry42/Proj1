// Deep Sky Atlas — "Sky Now": center the view on the user's zenith, i.e.
// what is directly overhead at their location this very moment. This is the
// stargazer's entry point: tap it outside and the screen matches the sky.
//
// Privacy: geolocation is consumed entirely on-device to compute local
// sidereal time; the position is never transmitted anywhere.

import { showToast } from './ui.js';
import { flyTo } from './search.js';

/**
 * Zenith equatorial coordinates for an observer:
 *   RA  = local sidereal time (Greenwich mean sidereal time + east longitude)
 *   Dec = observer latitude
 * GMST from the standard linear expansion (Meeus eq. 12.4, arcsecond-level —
 * vastly more precise than needed to aim a 100° view).
 */
export function zenithRaDec(latDeg, lonEastDeg, date = new Date()) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const d = jd - 2451545.0;
  let gmst = (280.46061837 + 360.98564736629 * d) % 360;
  if (gmst < 0) gmst += 360;
  const lst = ((gmst + lonEastDeg) % 360 + 360) % 360;
  return { ra: lst, dec: Math.max(-90, Math.min(90, latDeg)) };
}

export function initSkyNow(aladin) {
  const btn = document.getElementById('skynow-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      showToast('This browser does not expose location, so the sky overhead cannot be computed.', 'error');
      return;
    }
    showToast('Finding your sky…', 'info', 3000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        const { ra, dec } = zenithRaDec(latitude, longitude);
        flyTo(aladin, ra, dec, 100);
        const hh = String(new Date().getHours()).padStart(2, '0');
        const mm = String(new Date().getMinutes()).padStart(2, '0');
        showToast(`Your sky at ${hh}:${mm} — centered on the point straight overhead. Hold the phone up and the constellations around the center are above you.`, 'info', 9000);
      },
      (err) => {
        showToast(`Location unavailable (${err.message}). Allow location access to see your sky — your position never leaves this device.`, 'error', 9000);
      },
      { timeout: 8000, maximumAge: 60000 }
    );
  });
}
