// Deep Sky Atlas — custom canvas-drawn marker icons. Aladin Lite accepts an
// Image/HTMLCanvasElement as a catalog `shape`, so instead of its hard-edged
// default squares we draw soft, glowing star-like dots (radial gradients),
// and give black holes a miniature dark-core-with-glowing-ring icon that
// echoes the full accretion-disk render in the detail panel.

function hexRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Soft luminous dot: bright white center falling off through the tint color. */
export function makeGlowDot(hex, size = 16) {
  const s = size * 2; // draw at 2x for retina sharpness
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const [r, g, b] = hexRgb(hex);
  const x = s / 2;
  const grad = ctx.createRadialGradient(x, x, 0, x, x, x);
  grad.addColorStop(0.0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.18, `rgba(${r},${g},${b},0.95)`);
  grad.addColorStop(0.45, `rgba(${r},${g},${b},0.32)`);
  grad.addColorStop(1.0, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, s, s);
  return c;
}

/** Black hole: pitch-dark core wrapped in a glowing accretion ring. */
export function makeBlackHoleIcon(ringHex = '#ff9f0a', size = 22, ringBoost = 1) {
  const s = size * 2;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const [r, g, b] = hexRgb(ringHex);
  const x = s / 2;

  // Faint outer halo so the marker reads on both dark sky and bright nebulae.
  const halo = ctx.createRadialGradient(x, x, s * 0.18, x, x, x);
  halo.addColorStop(0, `rgba(${r},${g},${b},${0.35 * ringBoost})`);
  halo.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, s, s);

  // Glowing ring.
  ctx.strokeStyle = `rgba(${r},${g},${b},${Math.min(1, 0.95 * ringBoost)})`;
  ctx.lineWidth = s * 0.09;
  ctx.shadowColor = `rgba(${r},${g},${b},0.9)`;
  ctx.shadowBlur = s * 0.12;
  ctx.beginPath();
  ctx.arc(x, x, s * 0.26, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Event-horizon core.
  ctx.fillStyle = 'rgba(0,0,0,0.97)';
  ctx.beginPath();
  ctx.arc(x, x, s * 0.20, 0, Math.PI * 2);
  ctx.fill();

  return c;
}

/** Diffuse blob for gravitational-wave events (their localization is fuzzy). */
export function makeDiffuseBlob(hex = '#bf5af2', size = 26) {
  const s = size * 2;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const [r, g, b] = hexRgb(hex);
  const x = s / 2;
  const grad = ctx.createRadialGradient(x, x, 0, x, x, x);
  grad.addColorStop(0.0, `rgba(${r},${g},${b},0.75)`);
  grad.addColorStop(0.35, `rgba(${r},${g},${b},0.32)`);
  grad.addColorStop(1.0, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(x, x, s * 0.05, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

/** Bright planetary disc with a crisp rim — reads as "a world", not a star. */
export function makePlanetIcon(hex = '#7fd6ff', size = 18) {
  const s = size * 2;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const [r, g, b] = hexRgb(hex);
  const x = s / 2;

  const halo = ctx.createRadialGradient(x, x, s * 0.16, x, x, x);
  halo.addColorStop(0, `rgba(${r},${g},${b},0.4)`);
  halo.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, s, s);

  const disc = ctx.createRadialGradient(x - s * 0.07, x - s * 0.07, 0, x, x, s * 0.2);
  disc.addColorStop(0, 'rgba(255,255,255,0.98)');
  disc.addColorStop(1, `rgba(${r},${g},${b},0.95)`);
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(x, x, s * 0.19, 0, Math.PI * 2);
  ctx.fill();

  return c;
}
