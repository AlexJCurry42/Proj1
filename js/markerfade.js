// Project Planetarium — marker cross-fades for layer toggles. The sky
// engine's catalog show/hide is a hard cut, and its marker bitmaps are
// baked when sources are added (setShape after the fact has no visual
// effect — verified empirically). So the fade happens on our side: the
// engine catalog hides for the whole transition while faded copies of its
// markers (shapes and labels) draw on the unified overlay engine, easing
// over 320 ms before handing back. Rapid re-toggles reverse from the
// current opacity; the fade-in handoff keeps our full-alpha copy up a few
// frames while the engine redraws, so there is no blink.

import { getOverlay } from './overlay.js';
import { smoothstep } from './astro.js';
import { motionOK } from './motion.js';

const FADE_MS = 320;

function parseColor(c) {
  if (typeof c !== 'string') return null;
  if (c[0] === '#') {
    let h = c.slice(1);
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    if (h.length < 6) return null;
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16), a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    };
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(',').map(Number);
  return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
}
const withAlpha = (c, a) => `rgba(${c.r},${c.g},${c.b},${(c.a * a).toFixed(3)})`;

export function initMarkerFades(aladin) {
  const jobs = new Set();
  const states = new WeakMap(); // catalog -> { alpha, job }

  const ctl = getOverlay(aladin).addLayer({
    z: 25,
    everyFrame: () => jobs.size > 0,
    draw(ctx, view) {
      const now = view.now;
      for (const job of [...jobs]) {
        const u = Math.min(1, (now - job.t0) / FADE_MS);
        const a = job.from + (job.to - job.from) * smoothstep(u);
        ctx.globalAlpha = a;
        for (const s of job.sources) {
          const p = view.proj(s.ra, s.dec);
          if (!p) continue;
          ctx.drawImage(job.shape, p[0] - job.shape.width / 2, p[1] - job.shape.height / 2);
          if (job.label && s.name) {
            ctx.font = job.labelFont;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = job.label;
            ctx.fillText(s.name, p[0] + job.shape.width / 2 + 2, p[1]);
          }
        }
        if (u >= 1) {
          if (job.to === 1) {
            // Hand back to the engine, keeping our copy up a few frames —
            // the engine redraws asynchronously and clearing in the same
            // frame leaves a visible blink between the two.
            if (!job.handed) {
              job.handed = true;
              job.linger = 3;
              try { job.cat.show(); } catch (err) { /* best effort */ }
            }
            if (--job.linger > 0) continue;
          }
          jobs.delete(job);
          job.state.job = null;
          job.state.alpha = job.to;
        }
      }
      ctx.globalAlpha = 1;
      if (!jobs.size) ctl.hide(); // last fade done: let the engine idle again
    }
  });
  // Shown only WHILE jobs exist: pinning this layer visible at init held
  // the whole unified overlay engine out of its idle stop for the entire
  // session (permanent 60 Hz wakeups with every layer off).

  function jobAlpha(job) {
    const u = Math.min(1, (performance.now() - job.t0) / FADE_MS);
    return job.from + (job.to - job.from) * smoothstep(u);
  }

  /**
   * Toggle a catalog's visibility with a cross-fade. Falls back to the hard
   * cut for anything we can't faithfully mirror (progressive HiPS catalogs,
   * self-fading controllers like the overlay layers themselves).
   */
  return function fadeCatalog(cat, visible) {
    const shape = cat.shape && typeof cat.shape === 'object' && typeof cat.shape.getContext === 'function' ? cat.shape : null;
    let sources = null;
    try { sources = cat.getSources?.() || cat.sources || null; } catch (err) { /* progressive cat */ }
    if (!motionOK() || !shape || !sources || !sources.length || sources.length > 1200) {
      try { visible ? cat.show?.() : cat.hide?.(); } catch (err) { /* best effort */ }
      return;
    }

    let state = states.get(cat);
    if (!state) { state = { alpha: cat.isShowing === false ? 0 : 1, job: null }; states.set(cat, state); }
    if (state.job) { jobs.delete(state.job); state.alpha = jobAlpha(state.job); state.job = null; }
    if (visible && state.alpha >= 1 && cat.isShowing !== false) return;
    if (!visible && state.alpha <= 0 && cat.isShowing === false) return;

    // The engine catalog is hidden during BOTH directions of the transition;
    // our overlay owns the pixels until the fade lands.
    try { cat.hide(); } catch (err) { /* best effort */ }

    const labelColor = cat.displayLabel && typeof cat.labelColor === 'string' ? parseColor(cat.labelColor) : null;
    const job = {
      cat, shape, state,
      sources: sources.map(s => ({ ra: s.ra, dec: s.dec, name: s.data?.name || null })),
      from: state.alpha, to: visible ? 1 : 0,
      t0: performance.now(),
      label: labelColor ? withAlpha(labelColor, 1) : null,
      labelFont: cat.labelFont || '11px -apple-system, sans-serif'
    };
    state.job = job;
    jobs.add(job);
    ctl.show(); // wake the engine for the duration of the fade
    ctl.dirty();
  };
}
