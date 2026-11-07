// Project Planetarium — the boot loading bar's driver. Loaded as a CLASSIC
// blocking script right after the boot-screen markup, so it runs before
// anything else has even started downloading (it was inline until the
// Content-Security-Policy arrived: external same-origin scripts keep the
// policy free of 'unsafe-inline'). app.js reports milestones via
// window.__boot.to(percent) and retires the screen with .done().

// Frame-buster: a meta-delivered CSP cannot set frame-ancestors, so this is
// the only way to stop a hostile page from framing the app and redressing
// the geolocation-consent tap. Runs before the app paints; a no-op at top
// level (top === self).
if (window.top !== window.self) {
  try { window.top.location = window.self.location.href; }
  catch (e) { document.documentElement.style.display = 'none'; } // cross-origin: at least don't render
}

window.__boot = (() => {
  const fill = document.getElementById('boot-fill');
  let target = 12, shown = 0, timer = null;
  // Ease toward the current stage's cap so the bar keeps breathing while a
  // slow stage (the wasm engine download + compile) is still in flight —
  // asymptotic, so it never falsely reaches the cap.
  timer = setInterval(() => {
    shown = Math.min(target, shown + Math.max(0.35, (target - shown) * 0.10));
    fill.style.width = shown + '%';
  }, 120);

  // The screen lifts only when BOTH conditions hold: the chrome is wired
  // (app.js calls done()) AND the sky has actually begun to paint. The old
  // behaviour retired on wiring alone — with a warm wasm cache the engine
  // came up in a blink, the cover vanished, and the user watched the sky
  // tile in from black for a second. The engine fires AL:Resource.fetched on
  // document as it pulls the survey's properties and first tiles; the first
  // of those means real sky is arriving, so hold the cover a beat past it to
  // mask the tile-in, then lift.
  let chromeReady = false, skyPainting = false, retired = false;
  function retire() {
    if (retired || !chromeReady || !skyPainting) return;
    retired = true;
    if (timer) { clearInterval(timer); timer = null; }
    fill.style.width = '100%';
    const el = document.getElementById('boot-screen');
    el.classList.add('boot-out');
    setTimeout(() => el.remove(), 500);
  }
  // This listener is registered before the engine (or even app.js) runs, so
  // it can't miss the first fetch. One is enough — remove it immediately.
  document.addEventListener('AL:Resource.fetched', function onFetch() {
    document.removeEventListener('AL:Resource.fetched', onFetch);
    setTimeout(() => { skyPainting = true; retire(); }, 700);
  });
  // Ceiling: a blocked or offline CDN never paints a sky — the cover must
  // still lift so it can never trap taps behind a full-screen div.
  setTimeout(() => { skyPainting = true; retire(); }, 4500);

  return {
    to(p) { target = Math.max(target, p); },
    // force lifts immediately (the fatal-error path: there is no sky coming,
    // and the error banner sits BELOW the cover, so it must come off now).
    done(force) { chromeReady = true; if (force) skyPainting = true; retire(); }
  };
})();
