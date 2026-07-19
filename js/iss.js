// Pocket Planetarium — the International Space Station, part of the Solar
// System layer. Propagated live on-device with SGP4 (vendored satellite.js
// submodules; no WASM, no network beyond the repo's own TLE snapshot, which
// the data-refresh Action keeps fresh daily from CelesTrak).
//
// The position is TOPOCENTRIC — computed for the observer's location, which
// matters enormously in low Earth orbit (parallax reaches tens of degrees) —
// so this layer only lights up once the observer's coordinates are known
// from some feature the user chose (horizon, Sky Now); it NEVER prompts.
// The ISS crosses the sky in minutes, so while visible it registers as an
// every-frame layer, with SGP4 re-run at 10 Hz and only the cheap screen
// projection done per frame. Tapping the dot opens a detail panel with the
// next above-horizon passes.

import { twoline2satrec } from './vendor/satellite/io.js';
import { propagate, gstime } from './vendor/satellite/propagation.js';
import { eciToEcf, ecfToLookAngles, degreesToRadians } from './vendor/satellite/transforms.js';
import { altAzToRaDec, R2D } from './astro.js';
import { appNow, timeOffsetMs } from './clock.js';
import { fetchText } from './net.js';
import { showToast, renderDetailPanel } from './ui.js';
import { getOverlay, haloText } from './overlay.js';

/** The ISS entry from the TLE snapshot (works on old multi-sat files too). */
function parseIssTle(text) {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    const [name, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
    if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) break;
    if (/ISS \(ZARYA\)/.test(name)) {
      try { return twoline2satrec(l1, l2); } catch (err) { return null; }
    }
  }
  return null;
}

/** Topocentric look angles; null when propagation fails. */
function lookAngles(rec, observerGd, date) {
  let pv;
  try { pv = propagate(rec, date); } catch (err) { return null; }
  if (!pv || !pv.position || typeof pv.position !== 'object') return null;
  const ecf = eciToEcf(pv.position, gstime(date));
  const la = ecfToLookAngles(observerGd, ecf);
  return Number.isFinite(la.elevation) ? la : null;
}

/** Next above-horizon ISS windows in the coming 24 h (30 s sampling). */
function nextPasses(rec, observerGd, maxPasses = 3) {
  const passes = [];
  let cur = null;
  const start = appNow().getTime();
  for (let s = 0; s <= 86400 && passes.length < maxPasses; s += 30) {
    const la = lookAngles(rec, observerGd, new Date(start + s * 1000));
    const el = la ? la.elevation * R2D : -90;
    if (el > 10) {
      if (!cur) cur = { t0: s, maxEl: el };
      else cur.maxEl = Math.max(cur.maxEl, el);
      cur.t1 = s;
    } else if (cur) {
      passes.push(cur);
      cur = null;
    }
  }
  const fmt = (s) => {
    const d = new Date(start + s * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return passes.map(p => [
    `Pass ${p.t0 < 60 ? 'now' : `at ${fmt(p.t0)}`}`,
    `until ${fmt(p.t1)}, peaks ${Math.round(p.maxEl)}° up`
  ]);
}

export async function initIssLayer(aladin, observer) {
  let rec;
  try {
    rec = parseIssTle(await fetchText('data/satellites_tle.txt'));
    if (!rec) throw new Error('ISS TLE not found');
  } catch (err) {
    return null; // quiet: the marker just doesn't appear until data exists
  }
  const observerGd = {
    latitude: degreesToRadians(observer.lat),
    longitude: degreesToRadians(observer.lon),
    height: 0
  };

  // TLE freshness: SGP4 drifts km/day; past ~10 days pass timing is mush.
  const epochAgeDays = Date.now() / 86400000 + 2440587.5 - rec.jdsatepoch;

  // SGP4 accuracy also decays fast when the time scrubber travels: bow out
  // beyond a few days rather than plot confident-looking nonsense.
  const MAX_SCRUB_DAYS = 5;
  const scrubbedTooFar = () => Math.abs(timeOffsetMs()) > MAX_SCRUB_DAYS * 86400000;

  // SGP4 at 10 Hz; the per-frame work is only the screen projection.
  let pos = null; // {ra, dec, el, rangeKm, cueRa, cueDec} | null when below horizon
  let lastPropT = 0;
  function propagate10Hz() {
    const now = performance.now();
    if (now - lastPropT < 100 && lastPropT) return;
    lastPropT = now;
    pos = null;
    const date = appNow();
    const la = lookAngles(rec, observerGd, date);
    if (!la) return;
    const el = la.elevation * R2D;
    if (el < 0) return;
    const { ra, dec } = altAzToRaDec(el, la.azimuth * R2D, observer.lat, observer.lon, date);
    pos = { ra, dec, el, rangeKm: la.rangeSat, cueRa: null, cueDec: null };
    const la2 = lookAngles(rec, observerGd, new Date(date.getTime() + 30000));
    if (la2 && la2.elevation > 0) {
      const n = altAzToRaDec(la2.elevation * R2D, la2.azimuth * R2D, observer.lat, observer.lon, date);
      pos.cueRa = n.ra;
      pos.cueDec = n.dec;
    }
  }

  let hit = null; // last-drawn screen position, for tap lookup

  function draw(ctx, view, state) {
    const alpha = state.alpha;
    hit = null;
    if (scrubbedTooFar()) return;
    propagate10Hz();
    if (!pos) return;
    const p = view.proj(pos.ra, pos.dec);
    if (!p) return;
    hit = { x: p[0], y: p[1] };

    if (pos.cueRa != null) { // motion cue: where it will be in 30 s
      const q = view.proj(pos.cueRa, pos.cueDec);
      if (q && Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.4 * Math.max(view.W, view.H)) {
        ctx.strokeStyle = `rgba(159, 232, 255, ${0.5 * alpha})`;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(q[0], q[1]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.fillStyle = `rgba(190, 240, 255, ${0.95 * alpha})`;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 3.4, 0, 6.2832);
    ctx.fill();
    ctx.strokeStyle = `rgba(159, 232, 255, ${0.35 * alpha})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 7, 0, 6.2832);
    ctx.stroke();
    ctx.font = '700 10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    haloText(ctx, 'ISS', p[0] + 11, p[1],
      `rgba(190, 240, 255, ${0.9 * alpha})`, `rgba(2, 8, 12, ${0.6 * alpha})`);
  }

  // Repaint every frame ONLY while the station is actually on screen — a
  // below-horizon or out-of-view ISS must not keep the whole overlay canvas
  // repainting at 60 fps (it did: a parked sky never went idle). While the
  // dot is absent, a 2 s bucket in the dirty signature re-runs draw() just
  // often enough to catch the station rising or entering the view.
  const ctl = getOverlay(aladin).addLayer({
    z: 30,
    everyFrame: () => hit != null,
    extraSig: () => (hit ? '' : String((performance.now() / 2000) | 0)),
    draw
  });

  // Tap the drawn ISS → detail panel (capture phase beats the engine's own
  // canvas handling; only intercepts when the dot is actually hit).
  const wrap = document.getElementById('sky-wrap');
  const onTap = (e) => {
    if (ctl.state.alpha < 0.5 || !hit || !pos) return;
    const r = wrap.getBoundingClientRect();
    if (Math.hypot(hit.x - (e.clientX - r.left), hit.y - (e.clientY - r.top)) > 16) return;
    e.stopPropagation();
    e.preventDefault();
    renderDetailPanel({
      name: 'International Space Station',
      typeLabel: 'Crewed space station, low Earth orbit',
      ra: pos.ra, dec: pos.dec,
      skyVisibility: false, // moves too fast for fixed-point rise/set rows
      distanceText: `${Math.round(pos.rangeKm).toLocaleString()} km from you right now`,
      extraRows: [
        ['Above your horizon', `${Math.round(pos.el)}° up`],
        ...nextPasses(rec, observerGd),
        ['Orbit data age', `${epochAgeDays.toFixed(1)} days`]
      ],
      approxNote: 'Pass times are above-horizon windows for your location; to actually SEE a pass the sky must be dark while the station is still sunlit. Computed on-device with SGP4 from CelesTrak orbital elements.',
      source: 'CelesTrak GP element sets (daily snapshot); SGP4 via satellite.js'
    });
  };
  wrap.addEventListener('click', onTap, true);

  if (epochAgeDays > 10) {
    showToast('ISS orbit data is over ten days old — its position is approximate until the next refresh.', 'info', 8000);
  }

  return { show: () => ctl.show(), hide: () => ctl.hide() };
}
