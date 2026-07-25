// Project Planetarium — the boot loading bar's driver. Loaded as a CLASSIC
// blocking script right after the boot-screen markup, so it runs before
// anything else has even started downloading (it was inline until the
// Content-Security-Policy arrived: external same-origin scripts keep the
// policy free of 'unsafe-inline'). app.js reports milestones via
// window.__boot.to(percent) and retires the screen with .done().
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
