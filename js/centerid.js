// Pocket Planetarium — "what's under the crosshair?": when a known deep-sky
// object (a Messier or curated NGC/IC showpiece, or any tour destination)
// sits under the view-center crosshair, two things identify it:
//  · a small CARD (top of the screen; bottom slot on phones) with its name,
//    type, and full description whenever one is known (the tour captions);
//  · zoomed in close, a subtle BUBBLE drawn next to the object itself in
//    the sky — name and type, anchored to the object, moving with it.
// Both are properties of the VIEW, not of any overlay, so they work even
// when the object's dock layer is switched off.
//
// Shape: the curated identification set (~200 objects, two small JSON files
// already bundled for other features) loads lazily on browser idle, never
// on the boot path. Matching runs only after the view settles — a quarter
// second after the last position/zoom event — and scans a precomputed unit
// vector per object, so it costs nothing while panning.

import { fetchJSON } from './net.js';
import { raDecToVec, angularSepDeg } from './astro.js';
import { TYPE_STYLE } from './catalogs.js';
import { getOverlay, haloText } from './overlay.js';
import { cardAppear } from './sound.js';
import { makeDismissable } from './ui.js';
import { findDescriptionFor, descriptionCredit } from './descriptions.js';

// The crosshair's identification reach, in screen pixels — matches the
// drawn crosshair's footprint so "overlaps the crosshair" is literal.
const CROSS_PX = 26;
// Sticky factor: once identified, the object must clearly leave the
// crosshair (1.6× the show radius) before letting go — no edge flicker.
const HYSTERESIS = 1.6;
// The in-sky bubble appears only when genuinely zoomed in on the object.
const BUBBLE_MAX_FOV = 25;
// And identification as a WHOLE is a zoomed-in feature: wide fields cross
// dozens of showpieces, and a card popping at every one read as spam.
const ID_MAX_FOV = 30;

export function initCenterId(aladin, { onPosition, onZoom }) {
  const card = document.getElementById('center-card');
  const nameEl = document.getElementById('center-name');
  const subEl = document.getElementById('center-sub');
  const descEl = document.getElementById('center-desc');
  const dotEl = card?.querySelector('.center-dot');
  const closeBtn = document.getElementById('center-close');
  const wrap = document.getElementById('sky-wrap');
  if (!card || !nameEl || !wrap) return;

  let entries = null;    // null until the idle load finishes
  let matched = null;    // entry under the crosshair (drives card AND bubble)
  let suppressed = null; // card stays quiet for this entry (✕, or a tour toast already announced it)
  let announce = null;   // {ra, dec, t} from the cool-button toast, resolved lazily

  // The "Show me something cool" toast already names and describes the
  // destination — the card popping the same text at landing read as a
  // duplicate notification. The tour code announces its destination here;
  // the card stands down for that one arrival (the sky bubble still labels
  // the object, quietly).
  window.addEventListener('dsa:destination-announced', (e) => {
    const d = e.detail || {};
    if (Number.isFinite(d.ra) && Number.isFinite(d.dec)) {
      announce = { vec: raDecToVec(d.ra, d.dec), t: performance.now() };
    }
  });

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
          aliases: [o.id],
          sub: [style?.label, o.name ? o.id : null].filter(Boolean).join(' · '),
          color: style?.color || '#7dd3ff',
          desc: null,
          ra: o.ra, dec: o.dec,
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
          out.push({ name: t.name, sub: '', color: '#7dd3ff', desc: t.caption || null, ra: t.ra, dec: t.dec, vec, rDeg });
        }
      }
    }
    // Curated objects without a hand-written tour caption borrow their
    // bundled Wikipedia extract — filled in the BACKGROUND, because
    // identification must not wait on the descriptions file: on a slow
    // first visit the card works immediately and gains its text when ready.
    fillDescriptions(out);
    return out;
  }

  async function fillDescriptions(list) {
    await Promise.all(list.map(async (e) => {
      if (e.desc) return;
      const d = await findDescriptionFor(e.name, e.aliases).catch(() => null);
      if (d) { e.desc = d.text; e.descSrc = d; }
    }));
    // A card may already be up for an entry that just gained its text —
    // fill it in place, quietly (no re-appear animation, no sound).
    if (matched && matched.desc && !card.hidden) setCardDesc(matched);
  }

  // ---- the in-sky bubble: a quiet label pinned beside the object ----
  let bubbleCtl = null;
  function drawBubble(ctx, view, state) {
    window.__dsaBubble = null;
    if (!matched || view.fov > BUBBLE_MAX_FOV) return;
    const p = view.proj(matched.ra, matched.dec);
    if (!p) return;
    const a = state.alpha;
    const nameFont = '600 11px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
    const subFont = '500 9.5px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
    ctx.font = nameFont;
    const nameW = ctx.measureText(matched.name).width;
    let subW = 0;
    if (matched.sub) { ctx.font = subFont; subW = ctx.measureText(matched.sub).width; }
    const w = Math.max(nameW, subW) + 24;
    const h = matched.sub ? 36 : 24;
    const gap = 20;
    let x = p[0] + gap;
    if (x + w > view.W - 10) x = p[0] - gap - w; // flip left near the right edge
    let y = Math.max(58, Math.min(view.H - 104 - h, p[1] - h / 2));

    // connector: a hairline from the object to the bubble's near edge
    const nearX = x > p[0] ? x : x + w;
    ctx.strokeStyle = `rgba(220, 230, 250, ${0.3 * a})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p[0] + (nearX > p[0] ? 7 : -7), p[1]);
    ctx.lineTo(nearX, Math.max(y + 4, Math.min(y + h - 4, p[1])));
    ctx.stroke();

    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 8); else ctx.rect(x, y, w, h);
    ctx.fillStyle = `rgba(9, 13, 22, ${0.58 * a})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.14 * a})`;
    ctx.stroke();

    ctx.fillStyle = matched.color;
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(x + 11, y + 12, 2.5, 0, 6.2832);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = nameFont;
    haloText(ctx, matched.name, x + 18, y + 12, `rgba(240, 244, 252, ${0.92 * a})`, `rgba(0, 0, 0, ${0.4 * a})`, 2);
    if (matched.sub) {
      ctx.font = subFont;
      haloText(ctx, matched.sub, x + 18, y + 26, `rgba(190, 200, 220, ${0.75 * a})`, `rgba(0, 0, 0, ${0.35 * a})`, 2);
    }
    window.__dsaBubble = matched.name;
  }

  function setCardDesc(e) {
    if (!descEl) return;
    descEl.textContent = e.desc || '';
    if (e.desc && e.descSrc) descEl.append(' ', descriptionCredit(e.descSrc));
    descEl.hidden = !e.desc;
  }

  function showCard(e) {
    nameEl.textContent = e.name;
    subEl.textContent = e.sub;
    subEl.hidden = !e.sub;
    setCardDesc(e);
    if (dotEl) dotEl.style.background = e.color;
    card.hidden = false;
    cardAppear();
  }

  const hideCard = () => { card.hidden = true; };

  function setMatched(e) {
    matched = e;
    if (!bubbleCtl && e) bubbleCtl = getOverlay(aladin).addLayer({ z: 26, draw: drawBubble });
    if (e) { bubbleCtl.show(); bubbleCtl.dirty(); }
    else if (bubbleCtl) { bubbleCtl.hide(); window.__dsaBubble = null; }
  }

  function check() {
    if (!entries) return;
    let center;
    try { center = aladin.getRaDec(); } catch (err) { return; }
    const cv = raDecToVec(center[0], center[1]);
    const fovX = aladin.getFov()[0];
    if (fovX > ID_MAX_FOV) { // zoomed out: no cards, no bubbles, no pings
      if (matched) { setMatched(null); hideCard(); }
      return;
    }
    const W = wrap.clientWidth || window.innerWidth;
    const crossDeg = (CROSS_PX * fovX) / W; // the crosshair's angular reach at this zoom
    let best = null, bestScore = Infinity, matchedScore = Infinity, suppressedScore = Infinity;
    for (const e of entries) {
      const score = angularSepDeg(cv, e.vec) / Math.max(crossDeg, e.rDeg);
      if (score < bestScore) { bestScore = score; best = e; }
      if (e === matched) matchedScore = score;
      if (e === suppressed) suppressedScore = score;
    }
    if (suppressed && suppressedScore > HYSTERESIS) suppressed = null;
    if (best && bestScore <= 1) {
      if (best !== matched) {
        // A tour flight just announced this exact object in its toast: the
        // card stays quiet for this arrival (announcements expire quickly).
        if (announce && performance.now() - announce.t < 20000 &&
            angularSepDeg(best.vec, announce.vec) < 0.35) {
          suppressed = best;
        }
        announce = null;
        setMatched(best);
        if (best !== suppressed) showCard(best); else hideCard();
      }
    } else if (matched && matchedScore > HYSTERESIS) {
      setMatched(null);
      hideCard();
    }
  }

  let timer = null;
  const settled = () => { clearTimeout(timer); timer = setTimeout(check, 250); };
  onPosition(settled);
  onZoom(settled);

  // ✕ (or a swipe) quiets the card until the object leaves the crosshair;
  // the sky bubble stays — it is a label on the sky, not a notification.
  const quiet = () => { suppressed = matched; hideCard(); };
  closeBtn?.addEventListener('click', quiet);
  makeDismissable(card, quiet, 'translateX(-50%)');

  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 4000));
  idle(async () => {
    entries = await loadEntries();
    check(); // the view may already be parked on something known (the boot
             // view itself is: Sagittarius A*, which has a rich caption)
  }, { timeout: 15000 });
}
