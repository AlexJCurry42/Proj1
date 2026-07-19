// Pocket Planetarium — the time scrubber's CAMERA: a real planetarium
// turns the sky when you turn the clock. The view is anchored in the
// observer's LOCAL frame — whatever altitude/azimuth the user is looking
// at stays their line of sight — so:
//  · setting a date jumps the view to the sky of that moment (the RA/Dec
//    that then occupies the same direction over their horizon);
//  · time-lapse playback streams the diurnal motion live, every frame,
//    stars wheeling across the held line of sight.
// Anchoring needs the observer's location (the same on-device cache the
// horizon layer fills); until it is known, time changes move the Solar
// System markers only — exactly the old behavior.

import { onTimeChange, appNow, playSpeed } from './clock.js';
import { raDecToAltAz, altAzToRaDec } from './astro.js';
import { cachedObserver } from './observer.js';

export function initTimeSky(aladin) {
  let lastT = appNow().getTime();
  let raf = null;

  function retarget(newT) {
    const obs = cachedObserver();
    if (!obs || Math.abs(newT - lastT) < 250) { lastT = newT; return; }
    let ra0, dec0;
    try { [ra0, dec0] = aladin.getRaDec(); } catch (err) { lastT = newT; return; }
    // The direction the user is looking, in their sky, at the OLD time —
    // then the equatorial position that occupies it at the NEW time.
    const { alt, az } = raDecToAltAz(ra0, dec0, obs.lat, obs.lon, new Date(lastT));
    const { ra, dec } = altAzToRaDec(alt, az, obs.lat, obs.lon, new Date(newT));
    try { aladin.gotoRaDec(ra, dec); } catch (err) { /* engine hiccup: next tick */ }
    lastT = newT;
  }

  // Playback runs its own frame loop — the clock's 500 ms notify ticker
  // would hop the camera (half a sky-day per hop at day/s); per-frame
  // retargeting streams it. (Panning during playback is fine: each frame
  // re-anchors from wherever the user is looking NOW.)
  function loop() {
    raf = null;
    if (playSpeed() <= 0) return;
    retarget(appNow().getTime());
    raf = requestAnimationFrame(loop);
  }

  onTimeChange(() => {
    if (playSpeed() > 0) {
      if (!raf) raf = requestAnimationFrame(loop);
      return;
    }
    retarget(appNow().getTime()); // a scrub, a jump, or Back to now
  });
}
