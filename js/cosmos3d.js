// Project Planetarium — the DESI cosmic web in three dimensions. Every point
// is a real galaxy or quasar with a spectroscopically measured redshift from
// DESI Data Release 1, placed at its comoving position (Earth at the
// origin). This is the survey's signature product — the largest 3-D map of
// the universe — and it fundamentally cannot live on Aladin's celestial
// sphere, so it gets its own mode: a full-viewport WebGL point cloud with
// orbit, dolly and fly-through controls. No libraries; the little matrix
// math it needs is written here, in the same spirit as render3d.js.
//
// The dataset (data/desi_web.bin, ~3 MB) is Action-generated and LAZY:
// nothing loads until the first flip of the dock switch.

import { parseDesiWeb } from './desidata.js';
import { buildDensityField } from './darkmatter.js';
import { readPref, writePref } from './prefs.js';
import { showToast, makeDismissable } from './ui.js';
import { motionOK } from './motion.js';
import { acquireView, releaseView } from './cameraowner.js';

const VERT = `
attribute vec3 aPos;
attribute float aType;
uniform mat4 uMvp;
uniform float uPx;      // viewport height in DEVICE px (size attenuation)
uniform float uDpr;     // device-pixel ratio: keeps sprite size in CSS px
varying float vType;
varying float vFade;
void main() {
  gl_Position = uMvp * vec4(aPos, 1.0);
  float w = max(gl_Position.w, 1.0);
  // Clamp bounds scale with DPR so a phone shows the same CSS-px sprites
  // as a laptop (raw device-px clamps halved them at dpr 2).
  gl_PointSize = clamp(uPx * 900.0 / w, uDpr, 4.5 * uDpr);
  // Distant points thin out gently instead of shimmering as 1px noise.
  vFade = clamp(2200.0 * (uPx / uDpr) / w, 0.25, 1.0);
  vType = aType;
}`;

const FRAG = `
precision mediump float;
varying float vType;
varying float vFade;
void main() {
  // Soft round sprite — square points read as digital grit.
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = dot(d, d);
  if (r > 0.25) discard;
  float core = smoothstep(0.25, 0.02, r);
  vec3 galaxy = vec3(0.98, 0.88, 0.70);   // warm starlight
  vec3 quasar = vec3(0.45, 0.75, 1.00);   // hot accretion blue
  vec3 col = mix(galaxy, quasar, step(0.5, vType));
  gl_FragColor = vec4(col * core, core * 0.55 * vFade);
}`;

// The dark-matter field rides in its own pass: diffuse volumetric sprites
// whose SIZE and COLOUR both climb with concentration, so a dense node reads
// as a wide white-hot glow and a thin filament as a narrow purple thread.
const DM_VERT = `
attribute vec3 aPos;
attribute float aDens;
uniform mat4 uMvp;
uniform float uPx;
uniform float uDpr;
varying float vDens;
varying float vFade;
void main() {
  gl_Position = uMvp * vec4(aPos, 1.0);
  float w = max(gl_Position.w, 1.0);
  // Wider light IS higher concentration — the sprite grows with density.
  gl_PointSize = clamp(uPx * (1400.0 + 5400.0 * aDens) / w, 2.0 * uDpr, 46.0 * uDpr);
  vFade = clamp(2600.0 * (uPx / uDpr) / w, 0.30, 1.0);
  vDens = aDens;
}`;

const DM_FRAG = `
precision mediump float;
varying float vDens;
varying float vFade;
uniform float uAlpha;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  // Squared falloff: these are diffuse clouds, not point sources.
  float g = smoothstep(0.25, 0.0, r2);
  g *= g;
  // The concentration ramp: dark purple → light pink → yellow → white.
  vec3 c0 = vec3(0.17, 0.03, 0.40);
  vec3 c1 = vec3(0.98, 0.55, 0.86);
  vec3 c2 = vec3(1.00, 0.91, 0.38);
  vec3 c3 = vec3(1.00, 1.00, 0.98);
  float t = clamp(vDens, 0.0, 1.0);
  vec3 col = t < 0.36
    ? mix(c0, c1, t / 0.36)
    : (t < 0.70 ? mix(c1, c2, (t - 0.36) / 0.34) : mix(c2, c3, (t - 0.70) / 0.30));
  gl_FragColor = vec4(col * g, g * uAlpha * (0.25 + 0.75 * t) * vFade);
}`;

// ---- minimal mat4 (column-major, WebGL order) ----
function perspective(fovyRad, aspect, near, far) {
  const f = 1 / Math.tan(fovyRad / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0
  ]);
}
function lookAt(eye, center) {
  const up = [0, 0, 1]; // +z = north celestial pole
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1
  ]);
}
function mul4(a, b) { // a * b
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

// ---- module state (one instance ever) ----
let built = false;        // DOM + GL created
let active = false;       // mode currently on screen
let reqSeq = 0;           // newest setCosmicWeb call wins across its awaits
let loading = null;       // in-flight dataset promise
let gl = null, prog = null, canvas = null, legend = null, exitBtn = null;
let pointCount = 0;
let uMvp = null, uPx = null, uDpr = null;
// Dark-matter pass: own program, own buffers, own uniforms.
let dmProg = null, dmPosBuf = null, dmDensBuf = null, dmCount = 0;
let dmUMvp = null, dmUPx = null, dmUDpr = null, dmUAlpha = null;
let posBuf = null, typeBuf = null;
let dmOn = false, dmToggle = null;
let raf = null;
let onUserExit = null;    // flips the dock switch back off

// Camera: spherical orbit around the origin (Earth). Distances in Mpc.
const cam = { yaw: 0.6, pitch: 0.35, dist: 4200 };
const vel = { yaw: 0, pitch: 0 };
let lastInteract = 0;

// The legend behaves like every notification in the app: an ✕, a swipe,
// and an auto-hide — never a permanent squatter over the view. A manual
// dismissal is remembered for the session; re-entries stay quiet.
let legendTimer = null;
let legendDismissed = false;

function hideLegend(manual) {
  clearTimeout(legendTimer);
  legendTimer = null;
  if (legend) legend.style.display = 'none';
  if (manual) legendDismissed = true;
}
function showLegend() {
  if (legendDismissed) return;
  legend.style.display = 'block';
  clearTimeout(legendTimer);
  legendTimer = setTimeout(() => hideLegend(false), 12000);
}

function buildDom() {
  canvas = document.createElement('canvas');
  canvas.id = 'cosmos-canvas';
  canvas.setAttribute('aria-label', '3-D map of DESI galaxies and quasars — drag to orbit, pinch or scroll to fly');
  legend = document.createElement('div');
  legend.id = 'cosmos-legend';
  legend.className = 'glass-panel';
  exitBtn = document.createElement('button');
  exitBtn.id = 'cosmos-exit';
  exitBtn.className = 'glass-btn';
  exitBtn.textContent = 'Back to the sky';
  exitBtn.addEventListener('click', () => exitMode(true));
  // Sub-layer switch. It belongs to the 3-D mode, not the sky dock: it is
  // meaningless outside this view, so it lives and dies with it.
  dmToggle = document.createElement('button');
  dmToggle.id = 'cosmos-dm';
  dmToggle.className = 'glass-btn';
  dmToggle.setAttribute('aria-pressed', 'false');
  const dmDot = document.createElement('span');
  dmDot.className = 'cosmos-dm-dot';
  const dmLabel = document.createElement('span');
  dmLabel.textContent = 'Dark matter';
  dmToggle.append(dmDot, dmLabel);
  dmToggle.addEventListener('click', () => setDarkMatter(!dmOn));
  document.body.append(canvas, legend, exitBtn, dmToggle);
  // A browser can evict the GL context (backgrounded mobile tab). Without
  // this, the loop kept drawing into a dead context and the takeover view
  // stayed permanently black. Recovery = full teardown; the next flip
  // rebuilds from the SW-cached dataset in well under a second.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    const wasActive = active;
    exitMode(false);
    canvas.remove(); legend.remove(); exitBtn.remove(); dmToggle.remove();
    built = false; gl = null; loading = null; lastFrameSig = '';
    if (wasActive) {
      onUserExit?.();
      showToast('The 3-D view lost its graphics context — flip the switch to re-enter.', 'info', 7000);
    }
  });
  attachControls();
}

function initGL(data) {
  gl = canvas.getContext('webgl', { antialias: false, depth: false, alpha: true });
  if (!gl) throw new Error('WebGL unavailable');
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  };
  const link = (vsrc, fsrc) => {
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vsrc));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    return p;
  };

  prog = link(VERT, FRAG);
  posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, data.xyz, gl.STATIC_DRAW);
  typeBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, typeBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data.type), gl.STATIC_DRAW);
  uMvp = gl.getUniformLocation(prog, 'uMvp');
  uPx = gl.getUniformLocation(prog, 'uPx');
  uDpr = gl.getUniformLocation(prog, 'uDpr');
  pointCount = data.count;

  // The density field is derived HERE, while the parsed positions are still
  // in hand — the caller drops them right after to reclaim ~5 MB, and
  // retaining them just for a toggle the user might never flip would give
  // that saving back. ~150 ms, hidden inside a load that already took
  // seconds; the result is ~18k cells, a rounding error on the GPU.
  try {
    const field = buildDensityField(data.xyz, data.count, { grid: 96, smooth: 3 });
    if (field.n > 0) {
      dmProg = link(DM_VERT, DM_FRAG);
      dmPosBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, dmPosBuf);
      gl.bufferData(gl.ARRAY_BUFFER, field.pos, gl.STATIC_DRAW);
      dmDensBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, dmDensBuf);
      gl.bufferData(gl.ARRAY_BUFFER, field.dens, gl.STATIC_DRAW);
      dmUMvp = gl.getUniformLocation(dmProg, 'uMvp');
      dmUPx = gl.getUniformLocation(dmProg, 'uPx');
      dmUDpr = gl.getUniformLocation(dmProg, 'uDpr');
      dmUAlpha = gl.getUniformLocation(dmProg, 'uAlpha');
      dmCount = field.n;
    }
  } catch (err) {
    dmCount = 0; // the galaxies alone are still a complete view
  }

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive: dense filaments glow
}

// Bind one program's vertex attributes. Two programs share the context, so
// the pointers must be re-established per pass — set-once-in-initGL state
// belongs to whichever program happened to be bound last.
function bindAttrib(program, buffer, name, size) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const loc = gl.getAttribLocation(program, name);
  if (loc < 0) return;
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  gl.viewport(0, 0, canvas.width, canvas.height);
  lastFrameSig = ''; // force a redraw at the new size
}

let lastFrameSig = '';
function frame() {
  raf = requestAnimationFrame(frame);
  // Inertia + idle drift (drift only when animations are allowed).
  cam.yaw += vel.yaw;
  cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + vel.pitch));
  vel.yaw *= 0.92;
  vel.pitch *= 0.92;
  if (motionOK() && performance.now() - lastInteract > 5000) cam.yaw += 0.0006;

  // At rest (Animations off, inertia decayed) the camera is bit-identical
  // frame to frame — redrawing 400k points anyway was the app's largest
  // steady battery drain. Skip until something actually moves.
  // dmOn joins the signature: flipping the layer must force a repaint even
  // when the camera has not moved a pixel.
  const sig = `${cam.yaw.toFixed(5)},${cam.pitch.toFixed(5)},${cam.dist.toFixed(2)},${canvas.width}x${canvas.height},${dmOn ? 1 : 0}`;
  if (sig === lastFrameSig) return;
  lastFrameSig = sig;

  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const eye = [cam.dist * cp * Math.cos(cam.yaw), cam.dist * cp * Math.sin(cam.yaw), cam.dist * sp];
  const aspect = canvas.width / Math.max(1, canvas.height);
  const mvp = mul4(perspective(1.05, aspect, 2, 40000), lookAt(eye, [0, 0, 0]));
  const px = canvas.height / 900;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  gl.clearColor(0.01, 0.014, 0.03, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Dark matter underneath: the galaxies are the visible tracers and must
  // read ON TOP of the field they sit in, not be washed out by it.
  if (dmOn && dmCount > 0 && dmProg) {
    gl.useProgram(dmProg);
    bindAttrib(dmProg, dmPosBuf, 'aPos', 3);
    bindAttrib(dmProg, dmDensBuf, 'aDens', 1);
    gl.uniformMatrix4fv(dmUMvp, false, mvp);
    gl.uniform1f(dmUPx, px);
    gl.uniform1f(dmUDpr, dpr);
    gl.uniform1f(dmUAlpha, 0.30);
    gl.drawArrays(gl.POINTS, 0, dmCount);
  }

  gl.useProgram(prog);
  bindAttrib(prog, posBuf, 'aPos', 3);
  bindAttrib(prog, typeBuf, 'aType', 1);
  gl.uniformMatrix4fv(uMvp, false, mvp);
  gl.uniform1f(uPx, px);
  gl.uniform1f(uDpr, dpr);
  gl.drawArrays(gl.POINTS, 0, pointCount);
}

// ---- input: one-finger orbit, wheel / two-finger pinch dolly ----
const pointers = new Map();
let pinchDist = 0;
function dolly(factor) {
  cam.dist = Math.max(60, Math.min(12000, cam.dist * factor));
  lastInteract = performance.now();
}
function attachControls() {
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    lastInteract = performance.now();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 1) {
      vel.yaw = -dx * 0.0016;
      vel.pitch = dy * 0.0016;
      lastInteract = performance.now();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && d > 0) dolly(pinchDist / d);
      pinchDist = d;
    }
  });
  const up = (e) => { pointers.delete(e.pointerId); pinchDist = 0; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    dolly(Math.exp(e.deltaY * 0.0012));
  }, { passive: false });
}

// Capture phase + higher-surface guard (like the guided tour): defer to an
// open modal/sheet/lightbox so their Escape wins; otherwise exit the mode
// and stop the event so the central handler doesn't also act on one press.
const onKey = (e) => {
  if (e.key !== 'Escape' || !active) return;
  const higherOpen = document.getElementById('lightbox') ||
    !document.getElementById('shortcuts-sheet')?.hidden ||
    !document.getElementById('about-modal')?.hidden;
  if (higherOpen) return;
  e.stopImmediatePropagation();
  exitMode(true);
};
const onResize = () => { if (active) resize(); };

// Flip the dark-matter field. Remembered across sessions, like every other
// layer choice in the app.
function setDarkMatter(on) {
  dmOn = !!on && dmCount > 0;
  if (dmToggle) {
    dmToggle.setAttribute('aria-pressed', String(dmOn));
    dmToggle.classList.toggle('on', dmOn);
  }
  writePref('cosmosdm', dmOn);
  lastFrameSig = ''; // the camera has not moved: force the repaint
}

function enterMode() {
  if (active) return; // a double-enter would orphan a second rAF loop
  // Claim the view: taking it over while time playback or Sky Now gyro is
  // running would leave their per-frame loops driving the hidden 2-D camera
  // (and the clock ticking invisibly). Acquiring evicts them first. If WE
  // are later evicted (the user starts playback from the chrome that stays
  // above the 3-D view), exit AND revert the dock switch — exitMode(true).
  acquireView('cosmos', () => exitMode(true));
  active = true;
  document.body.classList.add('cosmos-on');
  canvas.style.display = 'block';
  showLegend();
  exitBtn.style.display = 'flex';
  // Offered only when the field actually built — never a switch that does
  // nothing (a device that declined the second program still gets galaxies).
  if (dmToggle) dmToggle.style.display = dmCount > 0 ? 'flex' : 'none';
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  resize();
  lastInteract = performance.now();
  raf = requestAnimationFrame(frame);
  exitBtn.focus({ preventScroll: true });
}

function exitMode(byUser) {
  if (!active) return;
  active = false;
  releaseView('cosmos');
  cancelAnimationFrame(raf);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onResize);
  document.body.classList.remove('cosmos-on');
  canvas.style.display = 'none';
  hideLegend(false);
  exitBtn.style.display = 'none';
  if (dmToggle) dmToggle.style.display = 'none';
  if (byUser) onUserExit?.();
}

/**
 * Dock wiring: flip the mode on/off. opts.onExit is called when the user
 * leaves via the in-mode controls (Escape / Back to the sky), so the dock
 * switch can follow. Returns false if the dataset isn't available.
 */
export async function setCosmicWeb(on, { onExit } = {}) {
  onUserExit = onExit || onUserExit;
  // The dataset load takes seconds; the user can flip the switch again in
  // that window. Only the NEWEST request may act after an await — without
  // this, on→off during the load still took over the viewport, and
  // on→off→on could stack a second entry.
  const token = ++reqSeq;
  if (!on) { exitMode(false); return true; }
  if (!built) {
    loading ??= (async () => {
      const res = await fetch('data/desi_web.bin');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseDesiWeb(await res.arrayBuffer());
    })();
    let data;
    try {
      data = await loading;
    } catch (err) {
      loading = null; // a later flip may retry (deploy may have landed)
      if (token !== reqSeq) return true; // superseded: the newer call speaks
      showToast('The DESI 3-D dataset isn\'t available yet — it is published by the data pipeline shortly after each release.', 'error', 8000);
      return false;
    }
    if (token !== reqSeq) return true; // superseded while loading
    buildDom();
    try {
      initGL(data);
    } catch (err) {
      showToast('3-D view unavailable: this device declined a WebGL context.', 'error', 7000);
      canvas.remove(); legend.remove(); exitBtn.remove(); dmToggle.remove();
      built = false; gl = null;
      return false;
    }
    legend.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = 'DESI DR1 — the cosmic web in 3-D';
    const p = document.createElement('p');
    p.textContent = `${pointCount.toLocaleString()} real galaxies & quasars from the largest 3-D map of the universe (a uniform sample of 18.7 million DESI redshifts). Earth sits at the center; distances follow from each redshift (Planck ΛCDM). Drag to orbit · pinch or scroll to fly.`;
    // Say plainly what the dark-matter layer is and is not. Nobody has
    // imaged dark matter; this is the density it is INFERRED to have from
    // where the measured galaxies actually are.
    const dmNote = document.createElement('p');
    dmNote.textContent = 'Dark matter: no telescope sees it directly. Galaxies form inside dark-matter halos, so this layer maps the density they trace — corrected for the survey\u2019s reach, so it shows real structure rather than how many galaxies are simply nearer. Purple is faint, white is the densest.';
    const credit = document.createElement('p');
    credit.className = 'cosmos-credit';
    credit.textContent = 'Data: DESI Collaboration DR1, via NOIRLab Astro Data Lab. Dark-matter field inferred from those positions.';
    const close = document.createElement('button');
    close.className = 'legend-close';
    close.setAttribute('aria-label', 'Dismiss the legend');
    close.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="7" y1="7" x2="17" y2="17"/><line x1="17" y1="7" x2="7" y2="17"/></svg>';
    close.addEventListener('click', () => hideLegend(true));
    legend.append(strong, p, dmNote, credit, close);
    makeDismissable(legend, () => hideLegend(true), 'translateX(-50%)');
    setDarkMatter(readPref('cosmosdm', false) === true);
    built = true;
    // The parsed arrays now live in GPU buffers; dropping the resolved
    // promise frees ~5 MB of heap. (Context loss rebuilds via a fresh
    // fetch — instant from the service worker's cache.)
    loading = null;
  }
  if (token !== reqSeq) return true; // superseded during GL setup
  enterMode();
  return true;
}
