// Project Planetarium — the Earth at the centre of the 3-D cosmic web.
//
// WHY IT EXISTS: three million points with nothing among them gives the eye
// no anchor — you cannot tell which way you are facing, how far out you have
// flown, or where the middle is. Earth marks the one place in the map that
// means something to the viewer: every DESI position is measured FROM here,
// so the origin is not an arbitrary centre, it is us.
//
// ON SCALE, stated plainly in the legend too: this globe is NOT to scale and
// cannot be. Earth is about 2e-19 Mpc across; at the ~14,000 Mpc span of the
// survey a true-to-scale Earth would be smaller than a single atom of the
// screen. It is a symbol placed at the true origin, drawn at a size the eye
// can use.
//
// ON ORIENTATION, which IS true: the catalog's +z axis is the north celestial
// pole, which is the direction Earth's rotation axis points. So the globe's
// axis here is the real one, and the hemisphere you see above the equator is
// genuinely the northern sky's side. Only the choice of which meridian faces
// you is illustrative. The globe does NOT spin: a rotating Earth would force
// the renderer to redraw three million points every frame purely to animate
// it, undoing the rest-detection that keeps this view off the battery. The
// idle camera drift already swings the viewpoint around it, which is what
// makes it read as a body.
//
// The surface is real geography: assets/earth_land.png, a land/ocean mask
// rasterized from Natural Earth's public-domain 1:10,000,000 coastlines by
// tools/make_earth_mask.py. Uploaded as LUMINANCE, so it costs one byte per
// pixel on the GPU rather than four.

// Symbolic size, chosen by measurement rather than taste. Apparent radius in
// pixels is (R / camera distance) / tan(fov/2) * viewportHeight/2, which at
// the default 4200 Mpc works out to R * 0.144. At 95 Mpc the globe came out
// 27 px across — present, but far too small to orient by, which was the whole
// point of adding it. 220 Mpc puts it near 64 px: unmistakably a body at the
// centre, while still spanning only ~1.6% of the 14,000 Mpc the survey covers,
// so the handful of galaxies nearer than that are all it can hide.
const EARTH_RADIUS_MPC = 220;

const VERT = `
attribute vec3 aPos;
attribute vec2 aUv;
uniform mat4 uMvp;
uniform float uRadius;
uniform float uSpin;
varying vec3 vN;
varying vec2 vUv;
varying vec3 vP;
void main() {
  float c = cos(uSpin), s = sin(uSpin);
  // Spin about z — the celestial pole — so the axis stays physically right.
  vec3 p = vec3(aPos.x * c - aPos.y * s, aPos.x * s + aPos.y * c, aPos.z);
  vN = p;
  vUv = aUv;
  vP = p * uRadius;
  gl_Position = uMvp * vec4(vP, 1.0);
}`;

const FRAG = `
precision mediump float;
uniform sampler2D uLand;
uniform float uHasTex;
uniform vec3 uLight;
uniform vec3 uEye;
varying vec3 vN;
varying vec2 vUv;
varying vec3 vP;
void main() {
  vec3 n = normalize(vN);
  float land = uHasTex > 0.5 ? texture2D(uLand, vUv).r : 0.0;
  // Albedo is deliberately brighter than a photograph of Earth. Three million
  // galaxies are drawn ADDITIVELY in front of the globe, and the galaxy tint is
  // warm; against that, a true-to-life dark ocean measured out as neutral grey
  // and the globe stopped reading as a globe. Brighter holds its colour.
  vec3 ocean = vec3(0.13, 0.44, 0.95);
  vec3 ground = vec3(0.46, 0.78, 0.38);
  vec3 base = mix(ocean, ground, land);
  // A terminator gives the sphere its shape — the single strongest cue that
  // this is a BODY at the centre and not a flat dot.
  float d = max(dot(n, normalize(uLight)), 0.0);
  float lit = 0.24 + 0.88 * pow(d, 0.65);
  // Atmospheric rim, so the globe separates from a field of stars behind it.
  vec3 v = normalize(uEye - vP);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.6);
  vec3 col = base * lit + vec3(0.42, 0.66, 1.00) * rim * 1.25;
  gl_FragColor = vec4(col, 1.0);
}`;

// Lat/lon sphere. The seam column is DUPLICATED: u runs 0..1 monotonically, so
// no triangle has to interpolate from 0.99 back to 0.01 and smear the whole
// texture across one strip of ocean.
function sphereMesh(lonSeg, latSeg) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= latSeg; j++) {
    const v = j / latSeg, theta = v * Math.PI;      // 0 at north pole
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let i = 0; i <= lonSeg; i++) {
      const u = i / lonSeg, phi = u * 2 * Math.PI;
      // z is up (the celestial pole); v=0 maps to +z.
      pos.push(st * Math.cos(phi), st * Math.sin(phi), ct);
      uv.push(u, v);
    }
  }
  const row = lonSeg + 1;
  for (let j = 0; j < latSeg; j++) {
    for (let i = 0; i < lonSeg; i++) {
      const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return { pos: new Float32Array(pos), uv: new Float32Array(uv), idx: new Uint16Array(idx) };
}

/**
 * Build the Earth renderer on an existing WebGL context.
 * Returns { draw(mvp, eye, nowMs), radius } or null if it cannot be built —
 * the caller must treat Earth as optional chrome, never a hard dependency.
 */
export function initEarth(gl, { assetUrl = 'assets/earth_land.png' } = {}) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');

  const m = sphereMesh(128, 64);
  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.STATIC_DRAW);
  const uvBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, m.uv, gl.STATIC_DRAW);
  const idxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);

  const u = (n) => gl.getUniformLocation(prog, n);
  const uMvp = u('uMvp'), uRadius = u('uRadius'), uSpin = u('uSpin');
  const uLand = u('uLand'), uHasTex = u('uHasTex'), uLight = u('uLight'), uEye = u('uEye');

  // A one-channel placeholder keeps the sampler legal before the mask lands,
  // so the globe draws as a lit ocean immediately instead of popping in.
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array([0]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  let hasTex = 0, onTextureReady = null;

  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    try {
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (img.width > max) throw new Error(`mask ${img.width}px exceeds MAX_TEXTURE_SIZE ${max}`);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      hasTex = 1;
      onTextureReady?.();
    } catch (err) {
      // Keep the lit sphere: a globe without coastlines still anchors the view.
      hasTex = 0;
      onTextureReady?.();
    }
  };
  img.onerror = () => { hasTex = 0; onTextureReady?.(); };
  img.src = assetUrl;

  return {
    radius: EARTH_RADIUS_MPC,
    get textured() { return hasTex === 1; },
    set onReady(fn) { onTextureReady = fn; },
    draw(mvp, eye) {
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      const aPos = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      const aUv = gl.getAttribLocation(prog, 'aUv');
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(uLand, 0);
      gl.uniform1f(uHasTex, hasTex);
      gl.uniformMatrix4fv(uMvp, false, mvp);
      gl.uniform1f(uRadius, EARTH_RADIUS_MPC);
      // Fixed: turns the Atlantic/Africa face toward the default camera.
      gl.uniform1f(uSpin, 2.35);
      gl.uniform3f(uLight, 0.55, 0.42, 0.72);
      gl.uniform3f(uEye, eye[0], eye[1], eye[2]);
      // Opaque body: it must OCCLUDE the galaxies behind it, which is what
      // turns a flat sheet of points into a volume with a near and a far side.
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.drawElements(gl.TRIANGLES, m.idx.length, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.disableVertexAttribArray(aPos);
      gl.disableVertexAttribArray(aUv);
    }
  };
}
