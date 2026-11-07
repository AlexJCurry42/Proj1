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
import { showToast, makeDismissable } from './ui.js';
import { motionOK } from './motion.js';
import { acquireView, releaseView } from './cameraowner.js';

const VERT = `
attribute vec3 aPos;    // LATTICE coordinates, not Mpc — see js/desidata.js
attribute float aType;
uniform mat4 uMvp;
uniform vec3 uOrigin;   // lattice corner in Mpc
uniform float uStep;    // Mpc per lattice unit
uniform float uPx;      // viewport height in DEVICE px (size attenuation)
uniform float uDpr;     // device-pixel ratio: keeps sprite size in CSS px
varying float vType;
varying float vFade;
void main() {
  // Positions arrive quantized and are rebuilt here. That keeps a
  // multi-million-point catalog at 6 bytes per point on the GPU instead of
  // 12, and spares the main thread ever building a float array the size of
  // the whole map.
  vec3 world = uOrigin + aPos * uStep;
  gl_Position = uMvp * vec4(world, 1.0);
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
uniform float uAlpha;
void main() {
  // Soft round sprite — square points read as digital grit.
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = dot(d, d);
  if (r > 0.25) discard;
  float core = smoothstep(0.25, 0.02, r);
  vec3 galaxy = vec3(0.98, 0.88, 0.70);   // warm starlight
  vec3 quasar = vec3(0.45, 0.75, 1.00);   // hot accretion blue
  vec3 col = mix(galaxy, quasar, step(0.5, vType));
  // Additive blending accumulates linearly with point count, so the per
  // point weight has to fall as the catalog grows or a 3-million-point map
  // is one white sheet. uAlpha carries that, set from the real count.
  gl_FragColor = vec4(col * core, core * uAlpha * vFade);
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
let uMvp = null, uPx = null, uDpr = null, uOrigin = null, uStep = null, uAlpha = null;
let posBuf = null, typeBuf = null;
let dataOrigin = [0, 0, 0], dataStep = 1, pointAlpha = 0.55;
// While the camera is moving, draw every Nth point. The file is stored in
// Morton (spatial) order, so a strided read is a SPATIALLY EVEN subsample,
// not a corner of the volume — which is what makes this free: one stride
// argument, no second buffer, no reordering.
let lodStride = 1, lastDrawnStride = 0, lastCamSig = '';
let prevYaw = 0, prevPitch = 0, prevDist = 0, driftTick = 0;
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
  document.body.append(canvas, legend, exitBtn);
  // A browser can evict the GL context (backgrounded mobile tab). Without
  // this, the loop kept drawing into a dead context and the takeover view
  // stayed permanently black. Recovery = full teardown; the next flip
  // rebuilds from the SW-cached dataset in well under a second.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    const wasActive = active;
    exitMode(false);
    canvas.remove(); legend.remove(); exitBtn.remove();
    built = false; gl = null; loading = null; lastCamSig = ''; lastDrawnStride = 0;
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
  // Upload the quantized lattice and the type flags in their native widths:
  // SHORT positions and a single BYTE per type. Expanding either to float
  // here would triple the GPU cost of the map for no visual gain.
  posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, data.q, gl.STATIC_DRAW);
  typeBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, typeBuf);
  gl.bufferData(gl.ARRAY_BUFFER, data.type, gl.STATIC_DRAW);
  uMvp = gl.getUniformLocation(prog, 'uMvp');
  uPx = gl.getUniformLocation(prog, 'uPx');
  uDpr = gl.getUniformLocation(prog, 'uDpr');
  uOrigin = gl.getUniformLocation(prog, 'uOrigin');
  uStep = gl.getUniformLocation(prog, 'uStep');
  uAlpha = gl.getUniformLocation(prog, 'uAlpha');
  pointCount = data.count;
  dataOrigin = [data.origin[0], data.origin[1], data.origin[2]];
  dataStep = data.step;
  // Keep a moving frame near ~800k points however big the catalog gets.
  lodStride = Math.max(1, Math.ceil(pointCount / 800000));
  // Brightness per point falls as the count rises. Square-root rather than
  // linear: linear makes a dense map dimmer than a sparse one overall, and
  // the eye reads the cosmic web by contrast, not absolute level.
  pointAlpha = Math.min(0.55, Math.max(0.07, 0.55 * Math.sqrt(400000 / Math.max(1, pointCount))));


  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive: dense filaments glow
}

// Bind one program's vertex attributes. Two programs share the context, so
// the pointers must be re-established per pass — set-once-in-initGL state
// belongs to whichever program happened to be bound last.
function bindAttrib(program, buffer, name, size, glType, stride) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const loc = gl.getAttribLocation(program, name);
  if (loc < 0) return;
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, glType, false, stride, 0);
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  gl.viewport(0, 0, canvas.width, canvas.height);
  // Force a redraw at the new size (the canvas dims are part of the
  // camera signature, but be explicit rather than rely on that).
  lastCamSig = ''; lastDrawnStride = 0;
}

function frame() {
  raf = requestAnimationFrame(frame);
  // Inertia + idle drift (drift only when animations are allowed).
  cam.yaw += vel.yaw;
  cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + vel.pitch));
  vel.yaw *= 0.92;
  vel.pitch *= 0.92;
  // Idle drift, advanced in steps rather than every frame. The rate is the
  // same to the eye; what changes is that three frames in four leave the
  // camera bit-identical, so the rest-detection below skips them. At 400k
  // points redrawing the drift every frame was merely wasteful — at three
  // million it would be the single biggest battery cost in the app.
  driftTick++;
  if (motionOK() && performance.now() - lastInteract > 5000 && driftTick % 4 === 0) {
    cam.yaw += 0.0024;
  }

  // At rest (Animations off, inertia decayed) the camera is bit-identical
  // frame to frame — redrawing the catalog anyway was the app's largest
  // steady battery drain. Skip until something actually moves. When motion
  // DOES stop, one full-detail frame still has to land: the last moving
  // frame was drawn strided, so returning early there would leave the
  // thinned-out version on screen for as long as the user sits still.
  const sig = `${cam.yaw.toFixed(5)},${cam.pitch.toFixed(5)},${cam.dist.toFixed(2)},${canvas.width}x${canvas.height}`;
  const changed = sig !== lastCamSig;
  lastCamSig = sig;
  // Thin the map only while it is moving FAST — a drag or a dolly, where the
  // eye cannot resolve individual points anyway. Keying this off "moved at
  // all" instead looked right and was not: the idle drift never stops, so
  // the full-detail frame never landed and the map sat permanently at a
  // quarter of the resolution it had just downloaded.
  const speed = Math.abs(cam.yaw - prevYaw) + Math.abs(cam.pitch - prevPitch)
    + Math.abs(cam.dist - prevDist) / Math.max(1, cam.dist);
  prevYaw = cam.yaw; prevPitch = cam.pitch; prevDist = cam.dist;
  const stride = (changed && speed > 0.004) ? lodStride : 1;
  if (!changed && lastDrawnStride === 1) return;
  lastDrawnStride = stride;

  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const eye = [cam.dist * cp * Math.cos(cam.yaw), cam.dist * cp * Math.sin(cam.yaw), cam.dist * sp];
  const aspect = canvas.width / Math.max(1, canvas.height);
  const mvp = mul4(perspective(1.05, aspect, 2, 40000), lookAt(eye, [0, 0, 0]));
  const px = canvas.height / 900;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  gl.clearColor(0.01, 0.014, 0.03, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);


  gl.useProgram(prog);
  bindAttrib(prog, posBuf, 'aPos', 3, gl.SHORT, stride * 6);
  bindAttrib(prog, typeBuf, 'aType', 1, gl.UNSIGNED_BYTE, stride);
  gl.uniformMatrix4fv(uMvp, false, mvp);
  gl.uniform1f(uPx, px);
  gl.uniform1f(uDpr, dpr);
  gl.uniform3f(uOrigin, dataOrigin[0], dataOrigin[1], dataOrigin[2]);
  gl.uniform1f(uStep, dataStep);
  // A strided frame draws 1/stride of the light, so lift each point to keep
  // the map's brightness steady while the camera moves.
  gl.uniform1f(uAlpha, pointAlpha * (stride > 1 ? Math.sqrt(stride) : 1));
  gl.drawArrays(gl.POINTS, 0, Math.floor(pointCount / stride));
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
      canvas.remove(); legend.remove(); exitBtn.remove();
      built = false; gl = null;
      return false;
    }
    legend.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = 'DESI DR1 — the cosmic web in 3-D';
    const p = document.createElement('p');
    p.textContent = `${pointCount.toLocaleString()} real galaxies & quasars from DESI Data Release 1 — the largest 3-D map of the universe ever made. Every point is a measured spectroscopic redshift, not a simulation. Earth sits at the center; distance follows from redshift (Planck ΛCDM). Drag to orbit · pinch or scroll to fly.`;
    const credit = document.createElement('p');
    credit.className = 'cosmos-credit';
    credit.textContent = 'Data: DESI Collaboration DR1, via NOIRLab Astro Data Lab.';
    const close = document.createElement('button');
    close.className = 'legend-close';
    close.setAttribute('aria-label', 'Dismiss the legend');
    close.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="7" y1="7" x2="17" y2="17"/><line x1="17" y1="7" x2="7" y2="17"/></svg>';
    close.addEventListener('click', () => hideLegend(true));
    legend.append(strong, p, credit, close);
    makeDismissable(legend, () => hideLegend(true), 'translateX(-50%)');
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
