// Pocket Planetarium — "what's under the crosshair?": when a known deep-sky
// object (a Messier or curated NGC/IC showpiece, or any tour destination)
// sits under the view-center crosshair, a small card names it — with its
// full description whenever one is known (the tour captions). This is a
// property of the VIEW, not of any overlay, so it works even when the
// object's dock layer is switched off.
//
// Shape: the curated identification set (~200 objects, two small JSON files
// already bundled for other features) loads lazily on browser idle, never
// on the boot path. Matching runs only after the view settles — a quarter
// second after the last position/zoom event — and scans a precomputed unit
// vector per object, so it costs nothing while panning.

import { fetchJSON } from './net.js';
import { raDecToVec, angularSepDeg } from './astro.js';
import { TYPE_STYLE } from './catalogs.js';

// The crosshair's identification reach, in screen pixels — matches the
// drawn crosshair's footprint so "overlaps the crosshair" is literal.
const CROSS_PX = 26;
// Sticky factor: once a card is up, the object must clearly leave the
// crosshair (1.6× the show radius) before it hides — no edge flicker.
const HYSTERESIS = 1.6;

export function initCenterId(aladin, { onPosition, onZoom }) {
  const card = document.getElementById('center-card');
  const nameEl = document.getElementById('center-name');
  const subEl = document.getElementById('center-sub');
  const descEl = document.getElementById('center-desc');
  const dotEl = card?.querySelector('.center-dot');
  const closeBtn = document.getElementById('center-close');
  const wrap = document.getElementById('sky-wrap');
  if (!card || !nameEl || !wrap) return;

  let entries = null;   // null until the idle load finishes
  let current = null;   // entry whose card is showing
  let suppressed = null; // entry dismissed via ✕: stays quiet until it leaves the crosshair

  async function loadEntries() {
    const [curated, tours] = await Promise.all([
      fetchJSON('data/messier_ngc.json').catch(() => null),
      fetchJSON('data/tours.json').catch(() => null)
    ]);
    const out = [];
    if (curated) {
      for (const o of [...(curated.messier || []), ...(curated.ngc_ic || [])]) {
        const style = TYPE_STYLE[o.type];
        out.push({
          name: o.name || o.id,
          sub: [style?.label, o.name ? o.id : null].filter(Boolean).join(' · '),
          color: style?.color || '#7dd3ff',
          desc: null,
          vec: raDecToVec(o.ra, o.dec),
          rDeg: 0.08 // extended-object grace: "overlaps" even without size data
        });
      }
    }
    if (tours) {
      for (const t of tours.destinations || []) {
        const vec = raDecToVec(t.ra, t.dec);
        // A tour frames its object at fov_deg, so ~a quarter of that is a
        // fair radius for "the object overlaps the crosshair".
        const rDeg = Math.max(0.05, (t.fov_deg || 0.5) / 4);
        const twin = out.find((e) => angularSepDeg(e.vec, vec) < 0.3);
        if (twin) {
          twin.desc = t.caption;
          twin.rDeg = Math.max(twin.rDeg, rDeg);
        } else {
          out.push({ name: t.name, sub: '', color: '#7dd3ff', desc: t.caption || null, vec, rDeg });
        }
      }
    }
    return out;
  }

  function show(e) {
    nameEl.textContent = e.name;
    subEl.textContent = e.sub;
    subEl.hidden = !e.sub;
    if (descEl) {
      descEl.textContent = e.desc || '';
      descEl.hidden = !e.desc;
    }
    if (dotEl) dotEl.style.background = e.color;
    card.hidden = false;
    current = e;
  }

  function hide() {
    card.hidden = true;
    current = null;
  }

  function check() {
    if (!entries) return;
    let center;
    try { center = aladin.getRaDec(); } catch (err) { return; }
    const cv = raDecToVec(center[0], center[1]);
    const fovX = aladin.getFov()[0];
    const W = wrap.clientWidth || window.innerWidth;
    const crossDeg = (CROSS_PX * fovX) / W; // the crosshair's angular reach at this zoom
    let best = null, bestScore = Infinity, currentScore = Infinity, suppressedScore = Infinity;
    for (const e of entries) {
      const score = angularSepDeg(cv, e.vec) / Math.max(crossDeg, e.rDeg);
      if (score < bestScore) { bestScore = score; best = e; }
      if (e === current) currentScore = score;
      if (e === suppressed) suppressedScore = score;
    }
    if (suppressed && suppressedScore > HYSTERESIS) suppressed = null;
    if (best && bestScore <= 1 && best !== suppressed) {
      if (best !== current) show(best);
    } else if (current && currentScore > HYSTERESIS) {
      hide();
    }
  }

  let timer = null;
  const settled = () => { clearTimeout(timer); timer = setTimeout(check, 250); };
  onPosition(settled);
  onZoom(settled);

  closeBtn?.addEventListener('click', () => { suppressed = current; hide(); });

  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 4000));
  idle(async () => {
    entries = await loadEntries();
    check(); // the view may already be parked on something known (the boot
             // view itself is: Sagittarius A*, which has a rich caption)
  }, { timeout: 15000 });
}
