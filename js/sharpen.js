// Pocket Planetarium — always-on imagery sharpening, WebKit-proof.
//
// The first implementation was a CSS `filter: url(#dsa-sharpen)` SVG filter
// on the sky div. Chromium honors SVG-referenced CSS filters; WebKit (iOS
// Safari — the app's primary device) has never reliably applied them to
// HTML elements, silently rendering nothing. So the primary path here is a
// WEBGL post-process: every frame, the engine's rendered imagery canvas is
// uploaded as a texture and redrawn through an unsharp-mask shader onto our
// own canvas laid exactly over it. The CSS filter remains as the fallback
// for the day WebGL2 itself is unavailable (where the engine can't run
// anyway, so the fallback is mostly ceremony).
//
// The mask is the same two-scale design as the SVG filter: a fine pass
// (~1.4 px via mip LOD 1.5, amount 1.6) that tightens star profiles and a
// clarity pass (~4 px via LOD 3, amount 0.7) that lifts nebular structure.
// Pure local contrast on the engine's real pixels — never invented detail.
//
// Reading the engine's WebGL canvas is only spec-guaranteed when its
// context keeps its drawing buffer after compositing, so BEFORE the engine
// boots, patchEngineContext() intercepts getContext('webgl2') on the
// engine's image canvas and injects preserveDrawingBuffer: true.

export function patchEngineContext() {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl2' && this.classList?.contains('aladin-imageCanvas')) {
      attrs = { ...(attrs || {}), preserveDrawingBuffer: true };
    }
    return orig.call(this, type, attrs);
  };
}

const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 o;
void main() {
  vec3 c  = texture(u_tex, v_uv).rgb;
  vec3 b1 = textureLod(u_tex, v_uv, 1.5).rgb;
  vec3 b2 = textureLod(u_tex, v_uv, 3.0).rgb;
  vec3 fine = c + 1.6 * (c - b1);
  vec3 res  = fine + 0.7 * (fine - b2);
  o = vec4(clamp(res, 0.0, 1.0), 1.0);
}`;

const VERT = `#version 300 es
out vec2 v_uv;
void main() {
  // One oversized triangle covers the viewport without a vertex buffer.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = vec2(p.x, 1.0 - p.y); // canvas textures arrive y-down
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * The reusable pipeline: sharpen sourceCanvas onto targetCanvas each
 * frame() call. Exported separately so the shader math is testable against
 * a synthetic source without the engine. Returns null if WebGL2 is out.
 */
export function createSharpenPipeline(sourceCanvas, targetCanvas) {
  const gl = targetCanvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
  if (!gl) return null;
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
  gl.useProgram(prog);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);

  return {
    gl,
    frame() {
      const w = sourceCanvas.width, h = sourceCanvas.height;
      if (!w || !h) return;
      if (targetCanvas.width !== w || targetCanvas.height !== h) {
        targetCanvas.width = w;
        targetCanvas.height = h;
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  };
}

/**
 * Wire the always-on sharpening over the engine's imagery. Returns the
 * active mode: 'webgl' (primary) or 'css' (SVG-filter fallback).
 */
export function initSharpen(aladin, { onPosition, onZoom }) {
  const cssFallback = () => { document.body.classList.add('sharpen'); return 'css'; };
  try {
    const src = document.querySelector('.aladin-imageCanvas');
    if (!src) return cssFallback();
    // Verify our preserveDrawingBuffer injection took — reading a buffer
    // that clears on composite would sharpen mostly black frames.
    const srcGl = src.getContext('webgl2');
    if (!srcGl?.getContextAttributes()?.preserveDrawingBuffer) return cssFallback();

    const cv = document.createElement('canvas');
    cv.id = 'dsa-sharpen-canvas';
    cv.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    src.insertAdjacentElement('afterend', cv); // above imagery, below the engine's catalog canvas
    const pipe = createSharpenPipeline(src, cv);
    if (!pipe) { cv.remove(); return cssFallback(); }

    // Activity-aware cadence: full frame rate while the view moves or has
    // just moved (tiles keep fading in after a pan stops), a 2 Hz
    // heartbeat at rest so late tile arrivals still appear sharpened.
    let lastActive = performance.now();
    let lastBeat = 0;
    const wake = () => { lastActive = performance.now(); };
    onPosition(wake);
    onZoom(wake);
    const loop = (t) => {
      requestAnimationFrame(loop);
      if (document.hidden) return;
      const active = t - lastActive < 3000;
      if (!active && t - lastBeat < 500) return;
      lastBeat = t;
      try { pipe.frame(); } catch (err) { /* transient context loss: retry next frame */ }
    };
    requestAnimationFrame(loop);
    return 'webgl';
  } catch (err) {
    return cssFallback();
  }
}
