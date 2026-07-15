// Pocket Planetarium — the location consent card. The horizon overlay is on
// by default and needs geolocation, but a browser permission dialog with no
// context is the rudest possible first impression (and browsers increasingly
// auto-deny prompts that arrive without a user gesture). So at boot the app
// asks IN ITS OWN WORDS first; the real browser prompt only ever fires from
// the user's tap on "Use my location".

/**
 * navigator.permissions state for geolocation: 'granted' | 'prompt' |
 * 'denied' | 'unknown' (API unavailable — e.g. older Safari).
 */
export async function geoPermissionState() {
  try {
    const st = await navigator.permissions.query({ name: 'geolocation' });
    return st.state;
  } catch (err) {
    return 'unknown';
  }
}

/**
 * Show the consent card; resolves true if the user chose "Use my location"
 * (the caller then runs requestObserver(), so the browser prompt is anchored
 * to that tap), false for "Not now" — quietly, no toast, no nagging.
 */
export function showLocationCard() {
  return new Promise((resolve) => {
    const card = document.getElementById('loc-card');
    const yes = document.getElementById('loc-accept');
    const no = document.getElementById('loc-decline');
    if (!card || !yes || !no) { resolve(false); return; }
    card.hidden = false;
    const done = (ok) => {
      card.hidden = true;
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      resolve(ok);
    };
    const onYes = () => done(true);
    const onNo = () => done(false);
    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
  });
}
