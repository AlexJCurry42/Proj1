// Deep Sky Atlas — UI chrome: toasts, object detail panel, sky destinations,
// about/credits modal, red-light night-vision mode.

import { fetchJSON } from './net.js';
import { attachRenderIfFamous } from './render3d.js';
import { riseSet, raDecToVec, vecToRaDec, angularSepDeg } from './astro.js';
import { cachedObserver } from './observer.js';
import { appNow } from './clock.js';
import { SURVEYS } from './spectrum.js';
import { motionOK } from './motion.js';

const SIMBAD_TAP_URL = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';

let objectTypesDict = null;
const simbadCache = new Map(); // "ra,dec" (rounded) -> result

// ---------------------------------------------------------------- Toasts ---

// One notification at a time. Bursts are common here (layer load + engine
// hint + tour caption can all fire together) and stacked toasts flood the
// sky, so a new message replaces the current one; repeating the same
// message just extends its stay instead of re-animating.
let activeToast = null;
let activeTimer = null;

export function showToast(message, kind = 'info', timeoutMs = 6000) {
  const container = document.getElementById('toast-container');

  if (activeToast && activeToast.textContent === message && !activeToast.classList.contains('toast-out')) {
    clearTimeout(activeTimer);
    activeTimer = setTimeout(activeToast.__dismiss, timeoutMs);
    return;
  }
  if (activeToast) {
    clearTimeout(activeTimer);
    activeToast.remove(); // replaced instantly: never two on screen
  }

  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  container.appendChild(el);
  activeToast = el;

  el.__dismiss = () => {
    if (activeToast === el) { activeToast = null; activeTimer = null; }
    // Graceful exit: play the out animation, then remove (with a safety
    // timeout so reduced-motion users aren't left with a stuck toast).
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 500);
  };
  activeTimer = setTimeout(el.__dismiss, timeoutMs);
}

// ------------------------------------------------------- Object type dict ---

async function loadObjectTypesDict() {
  if (objectTypesDict) return objectTypesDict;
  try {
    objectTypesDict = await fetchJSON('data/object_types.json');
  } catch (err) {
    objectTypesDict = {};
    showToast('Could not load object-type dictionary; raw codes will be shown.', 'error');
  }
  return objectTypesDict;
}

export async function humanObjectType(code) {
  if (!code) return 'Unknown type';
  const dict = await loadObjectTypesDict();
  return dict[code] || code;
}

// ----------------------------------------------------------- Coord format ---

export function toSexagesimalRA(raDeg) {
  // Round to 0.1 s of time FIRST, then decompose, so 59.96 s carries into the
  // next minute instead of printing the invalid "60.0s".
  let ds = Math.round((((raDeg % 360) + 360) % 360) / 15 * 36000); // deciseconds
  ds = ds % 864000;
  const hh = Math.floor(ds / 36000);
  const mm = Math.floor((ds % 36000) / 600);
  const ss = (ds % 600) / 10;
  return `${String(hh).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m ${ss.toFixed(1).padStart(4, '0')}s`;
}

export function toSexagesimalDec(decDeg) {
  const sign = decDeg < 0 ? '-' : '+';
  // Same carry-safe rounding, in tenths of an arcsecond.
  let das = Math.round(Math.abs(decDeg) * 36000);
  const dd = Math.floor(das / 36000);
  const mm = Math.floor((das % 36000) / 600);
  const ss = (das % 600) / 10;
  return `${sign}${String(dd).padStart(2, '0')}° ${String(mm).padStart(2, '0')}' ${ss.toFixed(1).padStart(4, '0')}"`;
}

// -------------------------------------------------------------- SIMBAD TAP --

/** On-demand cone-search of SIMBAD's TAP service around a clicked sky position. */
export async function fetchSimbadNear(ra, dec, radiusDeg = 0.02) {
  // Never let bad inputs reach the ADQL string — "CIRCLE('ICRS', undefined,…)"
  // is a guaranteed HTTP 400 from the TAP parser.
  const raNum = Number(ra), decNum = Number(dec);
  if (!Number.isFinite(raNum) || !Number.isFinite(decNum)) {
    throw new Error('this source did not report usable coordinates');
  }
  const raQ = raNum.toFixed(6), decQ = decNum.toFixed(6);
  const key = `${raQ},${decQ}`;
  if (simbadCache.has(key)) return simbadCache.get(key);

  // Minimal, parser-safe ADQL: no joins, and the DISTANCE expression is
  // selected under an alias then ordered by the alias — the pattern SIMBAD's
  // own TAP examples use. (Magnitude is skipped deliberately; the compound
  // flux join this replaced was 400-ing on the strict grammar.)
  const query =
    `SELECT TOP 1 oid, main_id, otype, ra, dec, plx_value, ` +
    `DISTANCE(POINT('ICRS', ra, dec), POINT('ICRS', ${raQ}, ${decQ})) AS dist ` +
    `FROM basic ` +
    `WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${raQ}, ${decQ}, ${radiusDeg})) = 1 ` +
    `ORDER BY dist ASC`;

  const url = `${SIMBAD_TAP_URL}?request=doQuery&lang=adql&format=json&query=${encodeURIComponent(query)}`;
  const json = await fetchJSON(url);
  const rows = json.data || [];
  if (!rows.length) throw new Error('No SIMBAD object found at this position');

  const cols = (json.metadata || []).map(m => m.name);
  const row = rows[0];
  const get = (name) => row[cols.indexOf(name)];

  const result = {
    name: get('main_id'),
    otype: get('otype'),
    ra: get('ra'),
    dec: get('dec'),
    distancePc: get('plx_value') ? 1000 / get('plx_value') : null,
    mag: null
  };

  // V magnitude via a SEPARATE query so a schema hiccup in the flux table
  // can never break the main lookup (a compound join here once 400-ed).
  try {
    const oid = get('oid');
    if (oid != null) {
      const magQuery = `SELECT V FROM allfluxes WHERE oidref = ${oid}`;
      const magJson = await fetchJSON(`${SIMBAD_TAP_URL}?request=doQuery&lang=adql&format=json&query=${encodeURIComponent(magQuery)}`);
      const v = magJson.data?.[0]?.[0];
      if (v != null) result.mag = v;
    }
  } catch (err) { /* magnitude is a bonus, never a blocker */ }

  simbadCache.set(key, result);
  return result;
}

// --------------------------------------------------------------- Detail panel ---

const detailPanel = () => document.getElementById('detail-panel');
const detailContent = () => document.getElementById('detail-content');

export function closeDetailPanel() {
  detailPanel().hidden = true;
  detailContent().innerHTML = '';
}

// ------------------------------------------------------------- Lightbox ---

let lightboxReturnFocus = null;

export function openLightbox(src, caption) {
  closeLightbox();
  lightboxReturnFocus = document.activeElement;
  const lb = document.createElement('div');
  lb.id = 'lightbox';
  lb.setAttribute('role', 'dialog');
  lb.setAttribute('aria-label', caption || 'Enlarged image');
  const img = document.createElement('img');
  img.src = src;
  img.alt = caption || '';
  const cap = document.createElement('p');
  cap.textContent = caption || '';
  const btn = document.createElement('button');
  btn.className = 'glass-btn small';
  btn.id = 'lightbox-close';
  btn.setAttribute('aria-label', 'Close enlarged image');
  btn.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="7" y1="7" x2="17" y2="17"/><line x1="17" y1="7" x2="7" y2="17"/></svg>';
  btn.addEventListener('click', closeLightbox);
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
  lb.append(img, cap, btn);
  document.body.appendChild(lb);
  btn.focus();
}

export function closeLightbox() {
  const lb = document.getElementById('lightbox');
  if (!lb) return;
  lb.remove();
  lightboxReturnFocus?.focus?.({ preventScroll: true });
  lightboxReturnFocus = null;
}

// ------------------------------------------------------ Global keyboard ---

/** Escape dismisses the topmost surface; Tab is trapped inside open modals. */
export function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Let the search field's native Escape (clear text) win while focused.
    if (e.target && e.target.id === 'search-input') return;
    if (document.getElementById('lightbox')) { closeLightbox(); return; }
    const about = document.getElementById('about-modal');
    if (!about.hidden) { document.getElementById('about-close').click(); return; }
    if (!detailPanel().hidden) closeDetailPanel();
  });
}

function trapFocus(container) {
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusables = container.querySelectorAll('button, a[href], select, input, [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

export function showDetailLoading() {
  detailPanel().hidden = false;
  detailContent().innerHTML = `<p id="detail-loading">Loading object details…</p>`;
}

/**
 * Render the object detail panel.
 * obj: { name, aliases, typeLabel, ra, dec, mag, distanceText, badges, extraRows, source, approxNote }
 */
export function renderDetailPanel(obj) {
  const wasHidden = detailPanel().hidden;
  detailPanel().hidden = false;
  const rows = [];
  rows.push(row('RA (ICRS)', `${toSexagesimalRA(obj.ra)} / ${obj.ra.toFixed(5)}°`));
  rows.push(row('Dec (ICRS)', `${toSexagesimalDec(obj.dec)} / ${obj.dec.toFixed(5)}°`));
  if (obj.mag !== undefined && obj.mag !== null) rows.push(row('Magnitude', obj.mag));
  if (obj.distanceText) rows.push(row('Distance', obj.distanceText));
  for (const r of visibilityRows(obj)) rows.push(r);
  for (const [label, value] of obj.extraRows || []) rows.push(row(label, value));

  const nameForLinks = encodeURIComponent(obj.name || '');
  const badges = (obj.badges || []).map(b => `<span class="badge-eht">${b}</span>`).join('');

  detailContent().innerHTML = `
    <h3>${escapeHtml(obj.name || 'Unknown object')}${badges}</h3>
    <span class="dtype">${escapeHtml(obj.typeLabel || 'Unknown type')}</span>
    ${obj.aliases && obj.aliases.length ? `<p class="hint">Also known as: ${escapeHtml(obj.aliases.join(', '))}</p>` : ''}
    <div class="drows">${rows.join('')}</div>
    ${obj.approxNote ? `<p class="approx-note">⚠ ${escapeHtml(obj.approxNote)}</p>` : ''}
    ${obj.source ? `<p class="hint">Source: ${escapeHtml(obj.source)}</p>` : ''}
    <div class="dlinks">
      <a href="https://simbad.cds.unistra.fr/simbad/sim-basic?Ident=${nameForLinks}" target="_blank" rel="noopener">SIMBAD</a>
      <a href="https://ned.ipac.caltech.edu/cgi-bin/objsearch?objname=${nameForLinks}" target="_blank" rel="noopener">NED</a>
      <a href="https://en.wikipedia.org/w/index.php?search=${nameForLinks}" target="_blank" rel="noopener">Wikipedia</a>
    </div>
  `;
  // Famous objects (and every black hole) get a procedural 3-D render,
  // inserted between the type chip and the data rows. Fire-and-forget.
  attachRenderIfFamous(detailContent(), obj);
  // Move keyboard focus into the freshly-opened panel (a11y), without
  // yanking it on every re-render while the panel is already open.
  if (wasHidden) document.getElementById('detail-close').focus({ preventScroll: true });
}

function row(label, value) {
  return `<div class="drow"><span>${escapeHtml(label)}</span><span>${escapeHtml(String(value))}</span></div>`;
}

// "Visible tonight" rows: is this object up in YOUR sky, and when does it
// rise and set? Shown only when the observer's location is already known —
// some feature the user chose (horizon, satellites, Sky Now) asked for it;
// the detail panel itself never triggers a permission prompt. Uses the app
// clock, so the rows follow the time scrubber.
function visibilityRows(obj) {
  if (obj.skyVisibility === false) return []; // e.g. satellites: too fast for fixed-point rise/set
  const obs = cachedObserver();
  if (!obs || !Number.isFinite(obj.ra) || !Number.isFinite(obj.dec)) return [];
  const rows = [];
  try {
    const rs = riseSet(obj.ra, obj.dec, obs.lat, obs.lon, appNow());
    rows.push(row('In your sky', rs.altNow >= 0
      ? `Up now — ${Math.round(rs.altNow)}° above the horizon`
      : 'Below the horizon right now'));
    const fmt = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (rs.circumpolar) {
      rows.push(row('Rises / sets', 'Never sets from your latitude — up every clear night'));
    } else if (rs.neverRises) {
      rows.push(row('Rises / sets', 'Never rises from your latitude'));
    } else {
      rows.push(row('Rises / sets', `Rises ${fmt(rs.rise)} · sets ${fmt(rs.set)}`));
    }
  } catch (err) { /* a bad coordinate must not break the panel */ }
  return rows;
}

const escapeDiv = document.createElement('div');
function escapeHtml(str) {
  escapeDiv.textContent = str;
  return escapeDiv.innerHTML;
}

export function initDetailPanelClose() {
  document.getElementById('detail-close').addEventListener('click', closeDetailPanel);
  const panel = document.getElementById('detail-panel');
  makeSheetDraggable(panel, panel, closeDetailPanel);
}

// ------------------------------------------------- Mobile sheet gestures ---

const isPhone = () => window.matchMedia('(max-width: 640px)').matches;

/**
 * Swipe-down-to-dismiss for mobile bottom sheets. A drag can start from the
 * grabber, or from anywhere in the sheet while its scroller sits at the top.
 * The sheet follows the finger; past ~90 px (or a quick flick) it dismisses,
 * otherwise it springs back.
 */
function makeSheetDraggable(sheet, scroller, onDismiss) {
  let startY = null, curY = 0, dragging = false, startT = 0;

  sheet.addEventListener('touchstart', (e) => {
    if (!isPhone()) return;
    const fromGrabber = !!e.target.closest('.sheet-grabber');
    if (!fromGrabber && scroller && scroller.scrollTop > 2) return;
    startY = e.touches[0].clientY;
    startT = Date.now();
    curY = 0;
    dragging = false;
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (startY == null || !isPhone()) return;
    const dy = e.touches[0].clientY - startY;
    if (!dragging && dy > 8) dragging = true;
    if (dragging) {
      if (e.cancelable) e.preventDefault(); // the gesture owns this move, not the scroller
      curY = Math.max(0, dy);
      sheet.style.transition = 'none';
      sheet.style.transform = `translateY(${curY}px)`;
    }
  }, { passive: false });

  const end = () => {
    if (startY == null) return;
    const velocity = curY / Math.max(Date.now() - startT, 1); // px/ms
    sheet.style.transition = '';
    if (dragging && (curY > 90 || velocity > 0.55)) onDismiss();
    // Clear the inline transform on the next frame so the stylesheet's
    // transition animates the sheet the rest of the way (down or back up).
    requestAnimationFrame(() => { sheet.style.transform = ''; });
    startY = null; curY = 0; dragging = false;
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);

  // A plain tap on the grabber also dismisses.
  sheet.querySelector('.sheet-grabber')?.addEventListener('click', onDismiss);
}

// ------------------------------------------------- Show me something cool ---

export async function initTours(aladin, spectrum) {
  let tours;
  try {
    tours = (await fetchJSON('data/tours.json')).destinations;
  } catch (err) {
    showToast('Could not load the sky destinations.', 'error');
    return;
  }
  const btn = document.getElementById('cool-btn');
  if (!btn) return;

  // A shuffle bag: every press is a surprise, and nothing repeats until
  // every destination has been seen once.
  let bag = [];
  function draw() {
    if (!bag.length) bag = [...tours].sort(() => Math.random() - 0.5);
    return bag.pop();
  }

  // Each press is ONE continuous camera arc — the van Wijk & Nuij (2003)
  // optimal pan-zoom path, the same math behind d3/Google-Earth flights.
  // The old three-act choreography (rise, engine glide, descend) stopped
  // dead twice at the act seams and guessed the glide's landing time; here
  // position and zoom follow a single hyperbolic geodesic at constant
  // perceived velocity, so the camera never halts or kinks mid-journey.
  // Pressing again mid-flight starts the next from wherever the view is;
  // touching the sky hands control back instantly.
  let flightToken = 0;
  document.getElementById('sky-wrap')?.addEventListener('pointerdown', () => {
    flightToken++;
  }, true);

  const RHO = 1.42, RHO2 = RHO * RHO, RHO4 = RHO2 * RHO2;
  function flyPath(toRa, toDec, toFov, token, onProgress) {
    return new Promise((resolve) => {
      let ra0, dec0, w0;
      try { [ra0, dec0] = aladin.getRaDec(); w0 = aladin.getFov()[0]; } catch (err) { resolve(false); return; }
      if (!Number.isFinite(w0) || w0 <= 0) { resolve(false); return; }
      const p0 = raDecToVec(ra0, dec0);
      const p1 = raDecToVec(toRa, toDec);
      const d = angularSepDeg(p0, p1); // pan distance, degrees
      const w1 = Math.max(0.02, toFov); // "width" = field of view

      // The path: u(s) = pan progress along the great circle (0..d), w(s) =
      // field of view. Both come from one hyperbolic geodesic in (u, w)
      // space — it widens exactly enough to cross the distance and narrows
      // into the target with no separate zoom-out/zoom-in phases.
      let S, uOf, wOf;
      if (d < 0.02) { // pure zoom: the geodesic degenerates to an exponential
        S = Math.abs(Math.log(w1 / w0)) / RHO;
        const k = w1 < w0 ? -1 : 1;
        uOf = () => 0;
        wOf = (s) => w0 * Math.exp(k * RHO * s);
      } else {
        const b0 = (w1 * w1 - w0 * w0 + RHO4 * d * d) / (2 * w0 * RHO2 * d);
        const b1 = (w1 * w1 - w0 * w0 - RHO4 * d * d) / (2 * w1 * RHO2 * d);
        const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
        const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
        S = (r1 - r0) / RHO;
        uOf = (s) => (w0 / RHO2) * (Math.cosh(r0) * Math.tanh(RHO * s + r0) - Math.sinh(r0));
        wOf = (s) => w0 * Math.cosh(r0) / Math.cosh(RHO * s + r0);
      }
      if (!(S > 1e-6) || !Number.isFinite(S)) { // already there
        try { aladin.gotoRaDec(toRa, toDec); aladin.setFoV(w1); } catch (err) { /* engine hiccup */ }
        resolve(true);
        return;
      }
      // Constant perceived velocity: duration scales with path length.
      const ms = Math.min(4200, Math.max(1800, S * 820));

      // True slerp along the great circle (vecMix is an nlerp — fine for
      // short drawing segments, visibly non-uniform across half the sky).
      const om = d * Math.PI / 180, so = Math.sin(om);
      const posAt = (f) => {
        if (so < 1e-6) return [toRa, toDec];
        const ka = Math.sin((1 - f) * om) / so;
        const kb = Math.sin(f * om) / so;
        const { ra, dec } = vecToRaDec([
          p0[0] * ka + p1[0] * kb, p0[1] * ka + p1[1] * kb, p0[2] * ka + p1[2] * kb
        ]);
        return [ra, dec];
      };

      const t0 = performance.now();
      let expected = null; // what WE last set, read back (engine may clamp)
      const step = (t) => {
        if (token !== flightToken) { resolve(false); return; }
        // External steering — gyro tracking engaging, a search fly-to —
        // moves the camera between our frames. Detect it and yield: two
        // animators fighting over the view is the worst kind of jank.
        if (expected) {
          try {
            const fovNow = aladin.getFov()[0];
            const [raNow, decNow] = aladin.getRaDec();
            const posErr = angularSepDeg(raDecToVec(raNow, decNow), raDecToVec(expected[1], expected[2]));
            if (Math.abs(fovNow - expected[0]) > expected[0] * 0.05 + 0.01 ||
                posErr > Math.max(1, fovNow * 0.1)) {
              resolve(false);
              return;
            }
          } catch (err) { /* transient read failure: keep flying */ }
        }
        const u01 = Math.min(1, (t - t0) / ms);
        const s = S * u01;
        const frac = d < 0.02 ? u01 : Math.max(0, Math.min(1, uOf(s) / d));
        const [ra, dec] = posAt(frac);
        try {
          aladin.setFoV(Math.max(0.02, wOf(s)));
          aladin.gotoRaDec(ra, dec);
          expected = [aladin.getFov()[0], ...aladin.getRaDec()];
        } catch (err) { /* engine hiccup: skip this frame */ }
        onProgress?.(u01, ms);
        if (u01 < 1) { requestAnimationFrame(step); return; }
        try { aladin.gotoRaDec(toRa, toDec); aladin.setFoV(w1); } catch (err) { /* engine hiccup */ }
        resolve(true);
      };
      requestAnimationFrame(step);
    });
  }

  btn.addEventListener('click', async () => {
    const t = draw();
    const token = ++flightToken;
    showToast(`${t.name} — ${t.caption}`, 'info', 12000);
    // This toast IS the announcement — tell the crosshair card to stand
    // down for this one arrival, or the landing pops the same text twice.
    window.dispatchEvent(new CustomEvent('dsa:destination-announced', { detail: { ra: t.ra, dec: t.dec } }));

    if (!motionOK()) {
      aladin.gotoRaDec(t.ra, t.dec);
      if (spectrum && t.survey) {
        const v = spectrum.valueForSurveyId(t.survey);
        if (v != null) spectrum.setValue(v, { settle: true });
      }
      aladin.setFoV(t.fov_deg);
      return;
    }

    // Unlock the zoom floor for the destination survey now, so the descent
    // can't slam into the CURRENT survey's floor mid-path (the fade's settle
    // re-locks the proper range on arrival).
    const destFloor = SURVEYS.find(s => s.id === t.survey)?.minFov;
    try { aladin.setFoVRange?.(Math.min(destFloor ?? 0.02, t.fov_deg), 320); } catch (err) { /* older builds */ }

    // Destination tiles start fetching NOW, behind an invisible overlay, so
    // the reveal later is a pure opacity ramp instead of a cold tile load.
    spectrum?.primeSurvey?.(t.survey);

    // The wavelength reveal rides the final 45% of the arc — the fast pan
    // happens in one steady light, and the new survey breathes in as the
    // camera settles onto the destination.
    let fadeStarted = false;
    const startFade = (msLeft) => {
      if (fadeStarted || !spectrum || !t.survey) return;
      fadeStarted = true;
      spectrum.fadeToSurvey(t.survey, Math.max(700, msLeft + 500));
    };

    let landed = false;
    try {
      landed = await flyPath(t.ra, t.dec, t.fov_deg, token, (u01, ms) => {
        if (u01 >= 0.55) startFade(ms * (1 - u01));
      });
      if (landed) startFade(900); // short hop that never crossed 55%
    } finally {
      if (token === flightToken) {
        // Canceled before any fade could settle: re-lock the zoom limits
        // for the survey we're actually still on.
        if (!landed && !fadeStarted) spectrum?.setValue?.(spectrum.getValue(), { settle: true });
      }
    }
  });
}

// NOTE: the modal first-run onboarding was retired deliberately — a welcome
// dialog stands between a new user and the sky. Discovery happens in place
// instead: the view-mode and "Show me something cool" buttons breathe until
// first pressed (see the .nudge pattern in app.js/style.css).

// --------------------------------------------------------------- About modal ---

export function initAboutModal() {
  const modal = document.getElementById('about-modal');
  document.getElementById('about-content').innerHTML = `
    <h2>Pocket Planetarium</h2>
    <p>A planetarium in your pocket: a browser-based sky atlas built with <a href="https://aladin.cds.unistra.fr/AladinLite/" target="_blank" rel="noopener">Aladin Lite v3</a>, streaming imagery and catalog data live from public astronomical archives.</p>
    <h3>Imagery &amp; sky rendering</h3>
    <ul>
      <li><strong>Aladin Lite</strong> &mdash; CDS, Observatoire de Strasbourg &amp; CNRS</li>
      <li>DSS2, SDSS9, 2MASS, AllWISE/unWISE, Pan-STARRS DR1, Fermi and radio HiPS surveys, distributed via the CDS HiPS service</li>
    </ul>
    <p class="hint">Why do bright stars look blotchy up close? The DSS2 optical imagery comes from photographic sky-survey plates: a bright star saturated the emulsion, and the red and blue exposures were taken years apart, so their images don't quite align — the orange/blue/black cores are plate artifacts, not real structure. Other bands (2MASS, Pan-STARRS) have their own, different bright-star artifacts. The <strong>Clean bright stars</strong> checkbox (layer dock → Display) covers those cores with a synthetic glow — positioned, sized and colored from the Yale Bright Star Catalogue — and can be switched off any time to see the raw observations.</p>
    <p class="hint">Want the sharpest possible view of a region? Slide the spectrum rail to <strong>Pan-STARRS</strong> — a modern CCD survey, far deeper and cleaner than the classic photographic DSS2 (it covers the sky north of declination −30°). Every stop on the rail is real observational data, so image quality is set by each survey's telescope and era, not by your screen.</p>
    <h3>Catalogs</h3>
    <ul>
      <li><strong>SIMBAD</strong> astronomical database &mdash; CDS, Strasbourg</li>
      <li><strong>VizieR</strong> catalog service &mdash; CDS, Strasbourg, including the Million Quasars (Milliquas) catalog</li>
      <li><strong>Gaia</strong> DR3 &mdash; ESA / Gaia Data Processing and Analysis Consortium</li>
      <li><strong>NASA Exoplanet Archive</strong> &mdash; NASA/IPAC, operated by Caltech</li>
      <li>Messier &amp; NGC/IC positions curated from standard published (SEDS/OpenNGC-derived) coordinates</li>
      <li>Constellation figures, names and IAU boundaries from the <strong>d3-celestial</strong> project (Olaf Frohn, BSD-3-Clause), based on Stellarium sky-culture data</li>
    </ul>
    <h3>Black holes &amp; gravitational waves</h3>
    <ul>
      <li>Stellar-mass black hole X-ray binaries curated from the <strong>BlackCAT</strong> catalog (Corral-Santana et al. 2016) and subsequent literature</li>
      <li>Sgr A* and M87* parameters from the <strong>Event Horizon Telescope Collaboration</strong> and <strong>GRAVITY Collaboration</strong></li>
      <li><strong>CelesTrak</strong> orbital element sets (TLEs) for the ISS and bright satellites</li>
    </ul>
    <h3>Name resolution</h3>
    <p>Object search uses the CDS <strong>Sesame</strong> name resolver, querying SIMBAD, NED and VizieR.</p>
    <h3>Photographs &amp; artist impressions</h3>
    <p>Object photographs are real mission and observatory images — NASA/JPL-Caltech, NASA/ESA Hubble, ESO, ALMA, MESSENGER, Cassini, Voyager, New Horizons, and the Event Horizon Telescope Collaboration — served via <strong>Wikimedia Commons</strong> and credited individually beneath each image. Famous exoplanets use official NASA/ESO artist impressions.</p>
    <h3>Procedural renders</h3>
    <p>Objects without real imagery fall back to <strong>procedural illustrations</strong> generated in-browser from published parameters (planet class, stellar temperature, accretion physics) — never passed off as observations, and labeled as such.</p>
    <h3>Privacy</h3>
    <p><strong>No tracking, ever.</strong> No analytics, no cookies, no accounts. Preferences (layers, night-vision mode) live only in your browser's local storage. The Sky&nbsp;Now feature reads your location and motion sensors on this device solely to compute and track what's overhead — nothing is ever transmitted anywhere.</p>
    <h3>Open source</h3>
    <p>MIT-licensed. Source, bug reports and suggestions: <a href="https://github.com/AlexJCurry42/Proj1" target="_blank" rel="noopener">github.com/AlexJCurry42/Proj1</a>. Curated data last reviewed July 2026.</p>
    <p class="hint">Every dataset should be cited per its provider's own guidelines in any derived publication. This tool is for exploration and education, not a substitute for primary catalogs. Planet/Moon positions are geocentric and approximate (±arcminutes; Moon up to ~1° due to parallax).</p>
  `;
  let aboutReturnFocus = null;
  const open = () => {
    aboutReturnFocus = document.activeElement;
    modal.hidden = false;
    document.getElementById('about-close').focus();
  };
  document.getElementById('about-toggle').addEventListener('click', open);
  document.getElementById('brand-btn')?.addEventListener('click', open);
  const close = () => {
    modal.hidden = true;
    aboutReturnFocus?.focus?.({ preventScroll: true });
  };
  document.getElementById('about-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  trapFocus(document.getElementById('about-card'));
}

// ---------------------------------------------------------- Red-light mode ---

export function initRedlightToggle() {
  const btn = document.getElementById('redlight-toggle');
  const apply = (active) => {
    document.body.classList.toggle('redlight', active);
    btn.setAttribute('aria-pressed', String(active));
  };
  try { apply(localStorage.getItem('dsa-redlight') === '1'); } catch (err) { /* private mode */ }
  btn.addEventListener('click', () => {
    const active = !document.body.classList.contains('redlight');
    apply(active);
    try { localStorage.setItem('dsa-redlight', active ? '1' : '0'); } catch (err) { /* private mode */ }
  });
}

// --------------------------------------------------------------- Rail toggle ---

