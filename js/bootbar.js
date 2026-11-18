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

  // HARD ceiling. The one above only forces `skyPainting`; `chromeReady` was
  // set by exactly one thing, app.js reaching done(). So anything that kept
  // app.js from getting there — a fetch that hangs instead of failing, a
  // module that never resolves, a throw outside its own try — left this
  // OPAQUE, full-screen, z-400 cover up forever. The app booted fine
  // underneath; the user saw an unbroken black screen and no way out, with
  // the fatal-error banner (z-150) sitting uselessly beneath the cover.
  // Nothing may hold the cover indefinitely, so this lifts it regardless and
  // says so, because a silent black screen is the worst possible failure.
  setTimeout(() => {
    if (retired) return;
    const stalled = !chromeReady;
    chromeReady = true;
    skyPainting = true;
    retire();
    if (stalled) showStartupHelp();
  }, 9000);

  // Deliberately self-contained: plain DOM, no imports, no app CSS. This has
  // to work in exactly the case where the module graph did NOT come up.
  function showStartupHelp() {
    if (document.getElementById('boot-help')) return;
    const box = document.createElement('div');
    box.id = 'boot-help';
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);'
      + 'z-index:401;max-width:min(92vw,420px);padding:18px 20px;border-radius:14px;'
      + 'background:rgba(22,24,32,0.96);color:#e9ecf4;border:1px solid rgba(255,255,255,0.14);'
      + 'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;'
      + 'box-shadow:0 18px 50px rgba(0,0,0,0.6);text-align:left';
    const h = document.createElement('strong');
    h.style.cssText = 'display:block;font-size:15px;margin-bottom:6px';
    h.textContent = 'The sky did not finish starting';
    const p1 = document.createElement('p');
    p1.style.cssText = 'margin:0 0 10px';
    p1.textContent = 'The app loaded but never reported ready, so the loading cover was lifted to get it out of your way. '
      + 'A stale cached copy is the usual cause; resetting clears it and keeps nothing but your saved location.';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    const mk = (label, primary) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'flex:1 1 auto;min-height:40px;padding:0 14px;border-radius:10px;cursor:pointer;'
        + 'font:600 13px inherit;border:1px solid rgba(255,255,255,0.18);'
        + (primary ? 'background:#3b6ef0;color:#fff' : 'background:rgba(255,255,255,0.08);color:#e9ecf4');
      return b;
    };
    const reload = mk('Reload', false);
    reload.addEventListener('click', () => location.reload());
    const reset = mk('Reset app data & reload', true);
    reset.addEventListener('click', async () => {
      reset.disabled = true;
      reset.textContent = 'Resetting…';
      // Clear every layer that can pin a broken start: the worker and its
      // shell caches, this app's saved preferences, and the permalink hash
      // (a survey or position recorded there has stranded the view before).
      try {
        if (navigator.serviceWorker) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
        }
      } catch (e) { /* carry on: each step is best-effort */ }
      try {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k.indexOf('dsa-shell-') === 0).map((k) => caches.delete(k)));
      } catch (e) { /* ditto */ }
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && k.indexOf('dsa-') === 0) localStorage.removeItem(k);
        }
      } catch (e) { /* private mode */ }
      try { sessionStorage.clear(); } catch (e) { /* private mode */ }
      location.replace(location.pathname);
    });
    row.append(reload, reset);
    box.append(h, p1, row);
    document.body.appendChild(box);
  }

  return {
    to(p) { target = Math.max(target, p); },
    // force lifts immediately (the fatal-error path: there is no sky coming,
    // and the error banner sits BELOW the cover, so it must come off now).
    done(force) { chromeReady = true; if (force) skyPainting = true; retire(); }
  };
})();
