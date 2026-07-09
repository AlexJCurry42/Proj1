// Deep Sky Atlas — subtle "warp streak" feedback while zooming. When the
// field of view changes, faint radial star-streaks flare outward (zooming in)
// or inward (zooming out) from the view center, then decay in ~a third of a
// second. Deliberately restrained: low alpha, short streaks, and completely
// absent for prefers-reduced-motion users. The overlay canvas ignores pointer
// events, so it never interferes with the sky.

export function initWarpEffect(aladin, onZoom = (fn) => aladin.on('zoomChanged', fn)) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = document.createElement('canvas');
  canvas.id = 'warp-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.getElementById('sky-wrap').appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0, h = 0, maxR = 1;
  function resize() {
    w = canvas.width = Math.round(canvas.clientWidth * dpr);
    h = canvas.height = Math.round(canvas.clientHeight * dpr);
    maxR = Math.hypot(w, h) / 2;
  }
  resize();
  window.addEventListener('resize', resize);

  // A fixed particle field; streaks appear along each particle's radial line.
  const stars = Array.from({ length: 120 }, () => ({
    a: Math.random() * Math.PI * 2,
    r: Math.pow(Math.random(), 0.7), // bias toward the edges, keep center clean
    b: 0.4 + Math.random() * 0.6,    // per-star brightness
    w: 0.6 + Math.random() * 1.2     // per-star stroke width (CSS px)
  }));

  let intensity = 0;   // 0..1, energy injected by zoom changes, decays fast
  let dir = 1;         // +1 zoom in (streaks fly outward), -1 zoom out
  let lastFov = null;
  let raf = null;
  let lastT = 0;

  onZoom(() => {
    let fov;
    try { fov = aladin.getFov()[0]; } catch (err) { return; }
    if (!(fov > 0)) return;
    if (lastFov != null && fov !== lastFov) {
      const dz = Math.log(lastFov / fov); // >0 means zooming in
      dir = dz >= 0 ? 1 : -1;
      intensity = Math.min(1, intensity + Math.min(0.5, Math.abs(dz) * 2.2));
      if (!raf) {
        lastT = performance.now();
        raf = requestAnimationFrame(frame);
      }
    }
    lastFov = fov;
  });

  function frame(t) {
    const dt = Math.min(t - lastT, 50);
    lastT = t;
    intensity *= Math.exp(-dt / 240); // ~quarter-second decay
    ctx.clearRect(0, 0, w, h);
    if (intensity < 0.02) { raf = null; return; }

    const cx = w / 2, cy = h / 2;
    ctx.lineCap = 'round';
    for (const s of stars) {
      // Particles drift with the warp direction so the field feels alive.
      s.r += dir * intensity * (dt / 1000) * 0.5 * (0.25 + s.r);
      if (s.r > 1) s.r -= 0.97;
      if (s.r < 0.03) s.r += 0.97;

      const r = s.r * maxR;
      if (r < maxR * 0.08) continue; // keep the very center clean
      const len = dir * intensity * maxR * 0.055 * (0.25 + s.r) * s.b;
      const cos = Math.cos(s.a), sin = Math.sin(s.a);
      const alpha = Math.min(0.38, intensity * 0.5) * s.b * (0.25 + 0.75 * s.r);
      ctx.strokeStyle = `rgba(190, 212, 255, ${alpha.toFixed(3)})`;
      ctx.lineWidth = s.w * dpr;
      ctx.beginPath();
      ctx.moveTo(cx + cos * r, cy + sin * r);
      ctx.lineTo(cx + cos * (r + len), cy + sin * (r + len));
      ctx.stroke();
    }
    raf = requestAnimationFrame(frame);
  }
}
