// Pocket Planetarium — the ISS and the brightest artificial satellites,
// propagated live on-device with SGP4 (vendored satellite.js submodules;
// no WASM, no network beyond the repo's own TLE snapshot, which
// .github/workflows/satellite-tles.yml refreshes daily from CelesTrak).
//
// Positions are TOPOCENTRIC — computed for the observer's location, which
// matters enormously in low Earth orbit (parallax reaches tens of degrees).
// Satellites cross the sky in minutes, so this registers as an every-frame
// layer on the unified overlay engine while visible. Tapping a dot opens a
// detail panel; the ISS panel includes its next above-horizon passes.

import { twoline2satrec } from './vendor/satellite/io.js';
import { propagate, gstime } from './vendor/satellite/propagation.js';
import { eciToEcf, ecfToLookAngles, degreesToRadians } from './vendor/satellite/transforms.js';
import { altAzToRaDec, R2D } from './astro.js';
import { appNow, timeOffsetMs } from './clock.js';
import { fetchText } from './net.js';
import { showToast, renderDetailPanel } from './ui.js';
import { getOverlay, haloText } from './overlay.js';

function parseTles(text) {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
  const sats = [];
  for (let i = 0; i + 2 < lines.length + 1 && sats.length < 400; i += 3) {
    const [name, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
    if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) break;
    try {
      const rec = twoline2satrec(l1, l2);
      sats.push({ name: name.trim(), rec, isISS: /ISS \(ZARYA\)/.test(name) });
    } catch (err) { /* skip malformed entry */ }
  }
  return sats;
}

/** Topocentric look angles for one satellite; null when propagation fails. */
function lookAngles(sat, observerGd, date) {
  let pv;
  try { pv = propagate(sat.rec, date); } catch (err) { return null; }
  if (!pv || !pv.position || typeof pv.position !== 'object') return null;
  const ecf = eciToEcf(pv.position, gstime(date));
  const la = ecfToLookAngles(observerGd, ecf);
  return Number.isFinite(la.elevation) ? la : null;
}

/** Next above-horizon ISS windows in the coming 24 h (30 s sampling). */
function nextPasses(sat, observerGd, maxPasses = 3) {
  const passes = [];
  let cur = null;
  const start = appNow().getTime();
  for (let s = 0; s <= 86400 && passes.length < maxPasses; s += 30) {
    const la = lookAngles(sat, observerGd, new Date(start + s * 1000));
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

export async function initSatellitesLayer(aladin, observer) {
  let sats;
  try {
    sats = parseTles(await fetchText('data/satellites_tle.txt'));
    if (!sats.length) throw new Error('no TLEs parsed');
  } catch (err) {
    showToast('Satellite orbit data is not available yet (daily refresh pending).', 'info', 7000);
    return { controller: null, count: 0 };
  }
  const observerGd = {
    latitude: degreesToRadians(observer.lat),
    longitude: degreesToRadians(observer.lon),
    height: 0
  };

  // TLE freshness: SGP4 drifts km/day; past ~10 days pass timing is mush.
  const iss = sats.find(s => s.isISS) || null;
  const epochAgeDays = iss ? (Date.now() / 86400000 + 2440587.5 - iss.rec.jdsatepoch) : 0;
  if (epochAgeDays > 10) {
    showToast('Satellite orbit data is over ten days old — positions are approximate until the next refresh.', 'info', 8000);
  }

  let hits = []; // last-drawn screen positions, for tap lookup

  // SGP4 accuracy decays fast away from the element epoch (km/day of
  // along-track drift), so when the time scrubber travels more than a few
  // days the satellites bow out rather than plot confident-looking nonsense.
  const MAX_SCRUB_DAYS = 5;
  const scrubbedTooFar = () => Math.abs(timeOffsetMs()) > MAX_SCRUB_DAYS * 86400000;
  let scrubNoteShown = false;

  // SGP4 is the expensive half of this layer (~180 propagations); on-screen
  // motion between frames is sub-pixel at most zooms. So orbits recompute at
  // 10 Hz and every frame only RE-PROJECTS the cached sky positions — the
  // cheap half — keeping the pan/zoom loop light while satellites stay live.
  let track = [];      // [{sat, ra, dec, el, rangeKm, cueRa, cueDec}]
  let lastPropT = 0;
  function propagate10Hz() {
    const now = performance.now();
    if (now - lastPropT < 100 && track.length) return;
    lastPropT = now;
    track = [];
    const date = appNow();
    for (const sat of sats) {
      const la = lookAngles(sat, observerGd, date);
      if (!la) continue;
      const el = la.elevation * R2D;
      if (el < 0) continue; // below the observer's horizon
      const { ra, dec } = altAzToRaDec(el, la.azimuth * R2D, observer.lat, observer.lon, date);
      const rec = { sat, ra, dec, el, rangeKm: la.rangeSat, cueRa: null, cueDec: null };
      if (sat.isISS) {
        // Motion cue: where it will be in 30 s.
        const la2 = lookAngles(sat, observerGd, new Date(date.getTime() + 30000));
        if (la2 && la2.elevation > 0) {
          const n = altAzToRaDec(la2.elevation * R2D, la2.azimuth * R2D, observer.lat, observer.lon, date);
          rec.cueRa = n.ra;
          rec.cueDec = n.dec;
        }
      }
      track.push(rec);
    }
  }

  function draw(ctx, view, state) {
    const alpha = state.alpha;
    hits = [];
    if (scrubbedTooFar()) {
      if (!scrubNoteShown && state.alpha > 0.5) {
        scrubNoteShown = true;
        showToast(`Satellites hide beyond ±${MAX_SCRUB_DAYS} days of time travel — orbit data can't be propagated that far accurately.`, 'info', 7000);
      }
      return;
    }
    scrubNoteShown = false;
    propagate10Hz();
    for (const rec of track) {
      const { sat, ra, dec, el, rangeKm } = rec;
      const p = view.proj(ra, dec);
      if (!p) continue;
      hits.push({ x: p[0], y: p[1], sat, el, rangeKm, ra, dec });

      if (sat.isISS) {
        if (rec.cueRa != null) {
          const q = view.proj(rec.cueRa, rec.cueDec);
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
      } else {
        ctx.fillStyle = `rgba(170, 220, 245, ${0.75 * alpha})`;
        ctx.beginPath();
        ctx.arc(p[0], p[1], 1.9, 0, 6.2832);
        ctx.fill();
      }
    }
  }

  const ctl = getOverlay(aladin).addLayer({ z: 30, everyFrame: true, draw });

  // Tap a drawn satellite → detail panel (capture phase beats the engine's
  // own canvas handling; only intercepts when a dot is actually hit).
  const wrap = document.getElementById('sky-wrap');
  const onTap = (e) => {
    if (ctl.state.alpha < 0.5 || !hits.length) return;
    const r = wrap.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bestD = 16;
    for (const h of hits) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < bestD) { bestD = d; best = h; }
    }
    if (!best) return;
    e.stopPropagation();
    e.preventDefault();
    const { sat, el, rangeKm, ra, dec } = best;
    renderDetailPanel({
      name: sat.isISS ? 'International Space Station' : sat.name,
      typeLabel: sat.isISS ? 'Crewed space station, low Earth orbit' : 'Artificial satellite',
      ra, dec,
      skyVisibility: false, // moves too fast for fixed-point rise/set rows

      distanceText: `${Math.round(rangeKm).toLocaleString()} km from you right now`,
      extraRows: [
        ['Above your horizon', `${Math.round(el)}° up`],
        ...(sat.isISS ? nextPasses(sat, observerGd) : []),
        ['Orbit data age', `${epochAgeDays.toFixed(1)} days`]
      ],
      approxNote: sat.isISS
        ? 'Pass times are above-horizon windows for your location; to actually SEE a pass the sky must be dark while the station is still sunlit. Computed on-device with SGP4 from CelesTrak orbital elements.'
        : 'Position computed on-device with SGP4 from CelesTrak orbital elements.',
      source: 'CelesTrak GP element sets (daily snapshot); SGP4 via satellite.js'
    });
  };
  wrap.addEventListener('click', onTap, true);

  return {
    controller: { show: () => ctl.show(), hide: () => ctl.hide() },
    count: sats.length
  };
}
