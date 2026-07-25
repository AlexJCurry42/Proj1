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
  return {
    to(p) { target = Math.max(target, p); },
    done() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      fill.style.width = '100%';
      const el = document.getElementById('boot-screen');
      el.classList.add('boot-out');
      setTimeout(() => el.remove(), 500);
    }
  };
})();
