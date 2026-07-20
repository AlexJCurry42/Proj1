// Deep Sky Atlas — procedural 3-D renders for famous objects, shown in the
// detail panel. A single WebGL fragment shader ray-shades a rotating sphere
// (rocky / gas giant / ice giant / lava / cloudy / star) or draws a black hole
// with photon ring, doppler-boosted accretion disk and lensed arcs. Renders
// are generated from published parameters (planet class, star temperature)
// and are explicitly labeled as illustrations, not observations.

import { fetchJSON } from './net.js';
import { openLightbox } from './ui.js';
import { motionOK } from './motion.js';
import { matchKeysFor } from './objnames.js';

const TYPE_IDS = { rocky: 0, gas_giant: 1, ice_giant: 2, lava: 3, star: 4, black_hole: 5, cloudy: 6, black_hole_binary: 7 };

let rendersPromise = null;
function loadRenders() {
  rendersPromise ??= fetchJSON('data/renders.json').catch(() => ({ entries: [] }));
  return rendersPromise;
}

export async function findRenderFor(name, aliases = [], typeLabel = '') {
  const { entries } = await loadRenders();
  const keys = matchKeysFor(name, aliases);
  for (const e of entries) {
    if (e.match.some(m => keys.includes(m))) return e;
  }
  // Every black hole gets the signature render even without a curated entry.
  if (/black hole/i.test(typeLabel)) {
    return { title: null, type: 'black_hole', params: {}, blurb: null };
  }
  return null;
}

// Stable Wikimedia Commons entry point: needs only the exact filename (no
// hash paths), and its thumbnail service converts even TIFF sources to web
// formats at the requested width.
function commonsUrl(file, width = 900) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`;
}

/**
 * Insert the best available media for a famous object into the detail panel:
 * a real photograph where one exists, an official artist's impression next,
 * and the procedural WebGL render as generator-of-last-resort — which is
 * also the live fallback if the photograph fails to load.
 */
export async function attachRenderIfFamous(containerEl, detailObj, anchorEl = null) {
  try {
    // The anchor is created fresh by every panel render, so it doubles as
    // the staleness check: if a NEWER render replaced the panel while the
    // entry lookup was in flight, this call's anchor is disconnected and
    // its media must not land in the newer object's panel. (containerEl
    // itself stays connected across re-renders — it can't tell renders
    // apart.)
    const entry = detailObj.render || await findRenderFor(detailObj.name, detailObj.aliases, detailObj.typeLabel);
    const anchor = anchorEl || containerEl.querySelector('.desc-slot, .drows');
    if (!entry || !anchor?.isConnected) return;

    const wrap = document.createElement('div');
    wrap.className = 'render-wrap';

    const media = document.createElement('div');
    media.className = 'render-media';
    wrap.appendChild(media);

    if (entry.blurb) {
      const blurb = document.createElement('p');
      blurb.className = 'render-blurb';
      blurb.textContent = entry.blurb;
      wrap.appendChild(blurb);
    }
    const cap = document.createElement('p');
    cap.className = 'render-caption';
    wrap.appendChild(cap);

    function mountProcedural() {
      if (!entry.type) { wrap.remove(); return; }
      const shared = getSharedRenderer();
      if (!shared) { wrap.remove(); return; } // no WebGL on this device
      media.innerHTML = '';
      shared.canvas.setAttribute('aria-label', `Illustrative render of ${detailObj.name || entry.title || 'object'}`);
      media.appendChild(shared.canvas);
      cap.textContent = 'Illustrative render from published parameters — not an observed image.';
      startRender(shared, entry);
    }

    // Insert into the DOM before mounting: the render loop stops itself when
    // its canvas is disconnected, so a canvas started pre-insertion dies on
    // its first frame. Above the anchor = media, then description, then the
    // data rows — a deterministic order even though the attach calls race.
    containerEl.insertBefore(wrap, anchor);

    if (entry.photo) {
      const img = document.createElement('img');
      img.className = 'render-photo';
      img.alt = `${entry.photo.kind === 'art' ? "Artist's impression" : 'Photograph'} of ${detailObj.name || entry.title}`;
      img.loading = 'eager';
      img.decoding = 'async';
      img.src = commonsUrl(entry.photo.file);
      img.addEventListener('error', mountProcedural, { once: true });
      // Tap to enlarge: same image at higher resolution in a lightbox.
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', () =>
        openLightbox(commonsUrl(entry.photo.file, 1600), `${entry.title || detailObj.name} — ${entry.photo.credit}`));
      media.appendChild(img);
      cap.textContent = `${entry.photo.kind === 'art' ? "Artist's impression" : 'Photograph'} — ${entry.photo.credit}. Via Wikimedia Commons.`;
    } else if (entry.type) {
      mountProcedural();
    } else {
      wrap.remove(); // nothing to show at all
    }
  } catch (err) {
    // A failed render must never break the detail panel.
    console.warn('Object media skipped:', err.message);
  }
}

// ---------------------------------------------------------------- WebGL ---

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform int uType;
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uRings;
uniform float uCaps;
uniform float uSeed;
uniform float uInclK;  // disk foreshortening: 1/cos(inclination), 1=face-on
uniform float uInner;  // disk inner-edge radius (smaller for high spin)
uniform float uJet;    // 0/1: relativistic jets documented for this system
uniform float uDim;    // overall disk brightness (quiescent systems are dim)
uniform float uQ;      // binary mass ratio m2/m1 (black_hole_binary only)

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  vec3 col = vec3(0.0);
  float alpha = 0.0;

  if (uType == 5) {
    // ---- Black hole: accretion disk + shadow + photon ring + lensed arcs.
    // Shaped by this system's measured physics: inclination tilts the disk,
    // spin pulls the inner edge closer, quiescence dims it, and documented
    // jet sources get relativistic beams perpendicular to the disk. ----
    float r = length(p);
    vec2 dp = vec2(p.x, p.y * uInclK);
    float dr = length(dp);
    float ang = atan(dp.y, dp.x);
    float edge = clamp((uInclK - 1.15) * 0.45, 0.0, 1.0); // 0 face-on, 1 edge-on
    float disk = smoothstep(uInner, uInner + 0.09, dr) * (1.0 - smoothstep(0.85, 1.2, dr));
    // Turbulent streaks spiraling inward with time.
    float swirl = fbm(vec2(dr * 9.0 - uTime * 0.6, ang * 2.5 + uSeed));
    // Relativistic doppler beaming, stronger the more edge-on we view the disk.
    float doppler = 1.0 + (0.25 + 0.75 * edge) * (-dp.x / max(dr, 0.001));
    float diskGlow = disk * (0.55 + 0.6 * swirl) * max(doppler, 0.12);
    vec3 diskCol = mix(uColA, uColB, clamp(swirl, 0.0, 1.0));
    col += diskCol * diskGlow * 1.5 * uDim;
    // Lensed image of the disk's far side, bent above and below the shadow —
    // prominent only when the disk is seen edge-on (the 'Interstellar' look).
    float arc = exp(-abs(r - 0.40) * 26.0) * smoothstep(0.02, 0.32, abs(p.y)) * (0.15 + 0.85 * edge);
    col += uColB * arc * 0.9 * uDim;
    // Relativistic jets along the spin axis, one beamed toward us.
    if (uJet > 0.5) {
      float ay = abs(p.y);
      float wj = 0.035 + 0.15 * ay;
      float xr = p.x / wj; // squared manually: GLSL pow() is undefined for x<0
      float beam = exp(-xr * xr) * smoothstep(1.15, 0.3, ay) * smoothstep(0.26, 0.44, r);
      float asym = p.y > 0.0 ? 1.3 : 0.65;
      col += mix(uColB, vec3(0.72, 0.84, 1.0), 0.55) * beam * 0.55 * asym * max(uDim, 0.5);
    }
    // Event-horizon shadow swallows everything inside.
    float shadow = smoothstep(0.335, 0.30, r);
    col *= (1.0 - shadow);
    // Thin bright photon ring at the shadow's edge; high spin brightens it.
    float pr = exp(-abs(r - 0.345) * 70.0);
    col += uColB * pr * (1.2 + 0.8 * (0.55 - uInner) * 5.0) * max(uDim, 0.55);
    // Sparse background stars, cleared near the hole as if lensed away.
    float st = step(0.9975, hash(floor(vUv * 180.0) + uSeed));
    col += vec3(st) * 0.35 * smoothstep(0.5, 1.0, r);
    alpha = clamp(max(max(col.r, col.g), col.b) * 1.3, 0.0, 1.0);
    alpha = max(alpha, shadow);
  } else if (uType == 7) {
    // ---- Binary black hole inspiral (gravitational-wave merger source).
    // Deliberately disk-free: BBH mergers are gas-poor, so what you'd see is
    // two shadows against lensed starlight. Sizes follow the real mass ratio. ----
    float th = uTime * 0.4;
    float q = clamp(uQ, 0.1, 1.0);
    float sep = 0.34;
    vec2 orbit = vec2(cos(th), sin(th) * 0.38); // mildly inclined orbital plane
    vec2 c1 = -orbit * sep * (q / (1.0 + q));        // heavier hole, tighter circle
    vec2 c2 = orbit * sep * (1.0 / (1.0 + q));       // lighter hole, wider circle
    float R1 = 0.15;
    float R2 = max(0.055, 0.15 * pow(q, 0.6));
    // Dense starfield: the visual interest is the lensing against it.
    float st = step(0.996, hash(floor(vUv * 150.0) + uSeed));
    col += vec3(st) * 0.5;
    float d1 = length(p - c1);
    float d2 = length(p - c2);
    // Faint gravitational glow warping between the pair.
    float mid = exp(-length(p) * 3.0) * 0.08;
    col += uColB * mid;
    // Shadows swallow background light...
    col *= smoothstep(R1 * 0.92, R1 * 1.02, d1);
    col *= smoothstep(R2 * 0.92, R2 * 1.02, d2);
    // ...wrapped in thin photon rings.
    col += uColB * exp(-abs(d1 - R1 * 1.06) * 60.0) * 1.1;
    col += uColB * exp(-abs(d2 - R2 * 1.06) * 60.0) * 1.0;
    alpha = clamp(max(max(col.r, col.g), col.b) * 1.3, 0.0, 1.0);
    alpha = max(alpha, smoothstep(R1, R1 * 0.9, d1));
    alpha = max(alpha, smoothstep(R2, R2 * 0.9, d2));
  } else {
    // ---- Sphere-shaded bodies ----
    float R = 0.74;
    vec2 q = p / R;
    float q2 = dot(q, q);
    if (q2 < 1.0) {
      vec3 n = vec3(q, sqrt(1.0 - q2));
      float rot = uTime * 0.12;
      float lon = atan(n.x, n.z) + rot;
      float lat = asin(clamp(n.y, -1.0, 1.0));
      vec2 tc = vec2(lon * 1.2, lat * 2.2) + uSeed;
      vec3 surf = uColA;
      if (uType == 0) {          // rocky: continents/highlands vs lowlands
        float t = fbm(tc * 2.6);
        surf = mix(uColB, uColA, smoothstep(0.35, 0.62, t));
        surf *= 0.85 + 0.3 * fbm(tc * 7.0);
        if (uCaps > 0.5) {
          surf = mix(surf, vec3(0.92), smoothstep(0.78, 0.96, abs(n.y)) * 0.75);
        }
      } else if (uType == 1) {   // gas giant: latitudinal banding + storms
        float band = fbm(vec2(lat * 7.0 + fbm(tc * 1.6) * 1.2, lon * 0.6));
        surf = mix(uColA, uColB, band);
        surf *= 0.92 + 0.16 * fbm(tc * 5.0);
      } else if (uType == 2) {   // ice giant: smooth methane haze, faint bands
        float band = 0.5 + 0.5 * sin(lat * 9.0 + fbm(tc) * 1.5);
        surf = mix(uColA, uColB, band * 0.35 + 0.25 * fbm(tc * 2.0));
      } else if (uType == 3) {   // lava world: dark crust, glowing fractures
        float cracks = fbm(tc * 3.2);
        float glow = smoothstep(0.52, 0.75, cracks);
        surf = mix(uColA, uColB * 1.5, glow);
      } else if (uType == 6) {   // featureless cloud deck
        float sw = fbm(tc * 2.2 + vec2(fbm(tc * 1.1)));
        surf = mix(uColA, uColB, sw * 0.5);
      } else {                   // star: granulation, emissive
        float gran = fbm(tc * 6.0 + uTime * 0.05);
        surf = uColA * (0.72 + 0.3 * gran);
      }
      if (uType == 4) {
        float limb = pow(n.z, 0.45); // limb darkening
        // Modest gain preserves the blackbody hue (a 3600 K supergiant must
        // stay orange-red, not clip to white).
        col = surf * limb * 1.22;
      } else {
        vec3 ldir = normalize(vec3(-0.55, 0.45, 0.72));
        float diff = max(dot(n, ldir), 0.0);
        float rim = pow(1.0 - n.z, 2.5) * 0.25;
        col = surf * (0.10 + 0.95 * diff) + rim * surf;
      }
      alpha = 1.0 - smoothstep(0.985, 1.0, q2); // anti-aliased limb
    }
    if (uType == 4) {
      // Corona glow outside the stellar disk.
      float d = length(p) / R;
      if (d > 0.97) {
        float glow = exp(-(d - 1.0) * 4.5);
        col += uColA * glow * 0.55;
        alpha = max(alpha, clamp(glow, 0.0, 1.0));
      }
    }
    if (uRings > 0.5) {
      // Ring system as a tilted annulus; the half behind the planet is occluded.
      vec2 rp = vec2(p.x, p.y * 3.4);
      float rr = length(rp) / R;
      float inRing = smoothstep(1.22, 1.32, rr) * (1.0 - smoothstep(1.9, 2.05, rr));
      float pattern = 0.5 + 0.5 * noise(vec2(rr * 26.0, 0.0));
      float vis = inRing * pattern;
      bool behindPlanet = p.y < 0.0 && dot(p / R, p / R) < 1.0;
      if (behindPlanet) vis = 0.0;
      vec3 ringCol = mix(uColA, vec3(0.88), 0.45);
      col = mix(col, ringCol, clamp(vis, 0.0, 1.0) * 0.85);
      alpha = max(alpha, vis * 0.85);
    }
  }

  gl_FragColor = vec4(col * alpha, alpha);
}`;

function hexToVec3(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255
  ];
}

// Blackbody temperature -> approximate RGB (Tanner Helland's fit), so star
// renders carry scientifically plausible color for their published T_eff.
function kelvinToRGB(kelvin) {
  const k = Math.min(Math.max(kelvin, 1000), 40000) / 100;
  let r, g, b;
  r = k <= 66 ? 255 : 329.698727446 * Math.pow(k - 60, -0.1332047592);
  g = k <= 66 ? 99.4708025861 * Math.log(k) - 161.1195681661 : 288.1221695283 * Math.pow(k - 60, -0.0755148492);
  b = k >= 66 ? 255 : (k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307);
  const clamp = v => Math.min(255, Math.max(0, v)) / 255;
  return [clamp(r), clamp(g), clamp(b)];
}

function seedFrom(str) {
  let h = 0;
  for (const c of String(str || 'x')) h = (h * 31 + c.charCodeAt(0)) % 997;
  return h / 100;
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

// One canvas + WebGL context + compiled program for the whole session,
// re-parented into each new detail panel. Browsers cap live WebGL contexts
// (~16), so a context per panel-open would eventually start losing contexts —
// and recompiling the shader on every open is pure waste.
let sharedRenderer = null;

function getSharedRenderer() {
  if (sharedRenderer) return sharedRenderer;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 640; // 2x for retina crispness
  canvas.className = 'render-canvas';
  canvas.setAttribute('role', 'img');
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
  if (!gl) return null;

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);

  const U = {};
  for (const name of ['uTime', 'uType', 'uColA', 'uColB', 'uRings', 'uCaps', 'uSeed', 'uInclK', 'uInner', 'uJet', 'uDim', 'uQ']) {
    U[name] = gl.getUniformLocation(prog, name);
  }

  sharedRenderer = { canvas, gl, U, raf: null, t0: 0 };
  return sharedRenderer;
}

function startRender(shared, entry) {
  const { gl, U, canvas } = shared;
  const params = entry.params || {};
  const typeId = TYPE_IDS[entry.type] ?? TYPE_IDS.rocky;
  let colA, colB;
  if (entry.type === 'star') {
    colA = params.colorA ? hexToVec3(params.colorA) : kelvinToRGB(params.tempK || 5800);
    colB = colA;
  } else if (entry.type === 'black_hole' || entry.type === 'black_hole_binary') {
    colA = hexToVec3(params.colorA || '#ff7a1a');
    colB = hexToVec3(params.colorB || '#ffe0b0');
  } else {
    colA = hexToVec3(params.colorA || '#aaaaaa');
    colB = hexToVec3(params.colorB || '#555555');
  }

  // Black hole physics → shader shape: inclination foreshortens the disk,
  // spin moves the inner disk edge (smaller ISCO for higher a*).
  const inclDeg = params.inclinationDeg ?? 74;
  const inclK = 1 / Math.max(Math.cos(inclDeg * Math.PI / 180), 0.12);
  const spin = params.spin ?? 0.5;
  const inner = 0.55 - 0.15 * Math.min(Math.max(spin, 0), 1);

  gl.uniform1i(U.uType, typeId);
  gl.uniform3fv(U.uColA, colA);
  gl.uniform3fv(U.uColB, colB);
  gl.uniform1f(U.uRings, params.rings ? 1 : 0);
  gl.uniform1f(U.uCaps, params.caps ? 1 : 0);
  gl.uniform1f(U.uSeed, seedFrom(entry.title || entry.type));
  gl.uniform1f(U.uInclK, inclK);
  gl.uniform1f(U.uInner, inner);
  gl.uniform1f(U.uJet, params.jet ? 1 : 0);
  gl.uniform1f(U.uDim, params.dim ?? 1);
  gl.uniform1f(U.uQ, params.q ?? 0.8);

  const reduceMotion = !motionOK();
  shared.t0 = performance.now();

  function frame() {
    if (!canvas.isConnected) { shared.raf = null; return; } // panel closed: idle until next mount
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(U.uTime, (performance.now() - shared.t0) / 1000 + 20);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    shared.raf = reduceMotion ? null : requestAnimationFrame(frame);
  }
  if (shared.raf) cancelAnimationFrame(shared.raf); // don't stack loops across mounts
  frame();
}
