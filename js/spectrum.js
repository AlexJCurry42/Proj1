// Deep Sky Atlas — the spectrum rail. Every imagery survey on one vertical
// track at the top-right, ordered by wavelength: gamma-ray at the top, radio
// at the bottom. Dragging cross-fades adjacent surveys live.
//
// Smoothness model:
//  - the displayed value critically-damps toward the pointer (eased glide,
//    never a jump — taps on the track travel there smoothly),
//  - blend opacity follows smoothstep(frac), so fades breathe into and out
//    of each stop instead of moving linearly,
//  - crossing a stop is seamless by construction: at the moment of the swap
//    the overlay is fully opaque and identical to the incoming base layer.
// Custom pointer-driven slider (native vertical range inputs are unreliable
// across engines) with full keyboard support: arrows step between surveys,
// Home/End jump to the spectrum's ends.

export const SURVEYS = [
  { id: 'P/Fermi/color', name: 'Fermi', band: 'Gamma-ray — the violent universe' },
  { id: 'P/SDSS9/color', name: 'SDSS9', band: 'Optical — Sloan digital survey' },
  { id: 'P/PanSTARRS/DR1/color-z-zg-g', name: 'Pan-STARRS', band: 'Optical — deepest wide field' },
  { id: 'P/DSS2/color', name: 'DSS2', band: 'Optical — the classic all-sky view' },
  { id: 'P/2MASS/color', name: '2MASS', band: 'Near-infrared — through the dust' },
  { id: 'P/allWISE/color', name: 'AllWISE', band: 'Mid-infrared — warm dust & AGN glow' },
  { id: 'P/NVSS', name: 'NVSS', band: 'Radio — jets, lobes & remnants' }
];

export const STOP = 100;
export const MAX_VALUE = (SURVEYS.length - 1) * STOP;
export const DEFAULT_VALUE = SURVEYS.findIndex(s => s.name === 'DSS2') * STOP;

const PAD = 15; // px of thumb-travel inset at each end of the track
const smoothstep = (t) => t * t * (3 - 2 * t);

export function initSpectrumBar(aladin, { onSettle, collapsed = false, onCollapse } = {}) {
  const rail = document.getElementById('spectrum-rail');
  const track = document.getElementById('spectrum-track');
  const thumb = document.getElementById('spectrum-thumb');
  const chip = document.getElementById('spectrum-chip');
  const nameEl = document.getElementById('spectrum-name');
  const bandEl = document.getElementById('spectrum-band');
  const dotsEl = document.getElementById('spectrum-dots');
  const collapseBtn = document.getElementById('spectrum-collapse');

  for (let i = 0; i < SURVEYS.length; i++) {
    const dot = document.createElement('span');
    dot.className = 'spectrum-dot';
    dot.style.top = `calc(${PAD}px + (100% - ${2 * PAD}px) * ${i / (SURVEYS.length - 1)})`;
    dotsEl.appendChild(dot);
  }
  const dots = [...dotsEl.children];

  let value = DEFAULT_VALUE;   // displayed (eased) position
  let target = DEFAULT_VALUE;  // where the pointer/keyboard wants to be
  let dragging = false;
  let raf = null;
  let settlePending = false;

  let curBase = -1, curOver = -1, overlayLayer = null;

  function applyEngine(v) {
    const idx = Math.min(Math.floor(v / STOP), SURVEYS.length - 2);
    const frac = (v - idx * STOP) / STOP;
    if (idx !== curBase) {
      try { aladin.setBaseImageLayer(SURVEYS[idx].id); } catch (err) { /* mid-drag hiccup */ }
      curBase = idx;
    }
    const overIdx = idx + 1;
    if (frac > 0.001) {
      if (overIdx !== curOver) {
        try {
          overlayLayer = aladin.setOverlayImageLayer(SURVEYS[overIdx].id, 'dsa-blend')
            || aladin.getOverlayImageLayer?.('dsa-blend') || overlayLayer;
        } catch (err) { overlayLayer = null; }
        curOver = overIdx;
      }
      try { overlayLayer?.setOpacity?.(smoothstep(frac)); } catch (err) { /* non-fatal */ }
    } else {
      try { overlayLayer?.setOpacity?.(0); } catch (err) { /* non-fatal */ }
    }

    const near = Math.round(v / STOP);
    nameEl.textContent = (frac > 0.18 && frac < 0.82)
      ? `${SURVEYS[idx].name} + ${SURVEYS[overIdx].name}`
      : SURVEYS[near].name;
    bandEl.textContent = SURVEYS[near].band;
    dots.forEach((d, i) => d.classList.toggle('active', i === near));
    track.setAttribute('aria-valuenow', String(Math.round(v)));
    track.setAttribute('aria-valuetext', nameEl.textContent);
  }

  function paint(v) {
    const rect = track.getBoundingClientRect();
    const travel = rect.height - 2 * PAD;
    const y = PAD + (v / MAX_VALUE) * travel;
    thumb.style.top = `${y}px`;
    chip.style.top = `${rect.top + y}px`;
  }

  function tick() {
    const delta = target - value;
    if (Math.abs(delta) < 0.35 && !dragging) {
      value = target;
      applyEngine(value);
      paint(value);
      raf = null;
      if (settlePending) {
        settlePending = false;
        onSettle?.(value);
      }
      return;
    }
    // Critically-damped approach: stiffer under the finger so the thumb
    // feels attached, softer on released glides so arrivals feather in.
    value += delta * (dragging ? 0.34 : 0.2);
    applyEngine(value);
    paint(value);
    raf = requestAnimationFrame(tick);
  }
  const animate = () => { if (!raf) raf = requestAnimationFrame(tick); };

  function valueFromPointer(clientY) {
    const rect = track.getBoundingClientRect();
    const travel = rect.height - 2 * PAD;
    const t = (clientY - rect.top - PAD) / travel;
    return Math.max(0, Math.min(MAX_VALUE, t * MAX_VALUE));
  }

  function release() {
    if (!dragging) return;
    dragging = false;
    track.classList.remove('dragging');
    const near = Math.round(target / STOP) * STOP;
    if (Math.abs(target - near) <= 15) target = near; // magnetic snap
    settlePending = true;
    animate();
  }

  track.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { track.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    dragging = true;
    track.classList.add('dragging');
    target = valueFromPointer(e.clientY);
    animate();
  });
  track.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    target = valueFromPointer(e.clientY);
    animate();
  });
  track.addEventListener('pointerup', release);
  track.addEventListener('pointercancel', release);

  track.addEventListener('keydown', (e) => {
    const stopIdx = Math.round(target / STOP);
    let next = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown') next = Math.min(SURVEYS.length - 1, stopIdx + 1) * STOP;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') next = Math.max(0, stopIdx - 1) * STOP;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = MAX_VALUE;
    if (next == null) return;
    e.preventDefault();
    target = next;
    settlePending = true;
    animate();
  });

  window.addEventListener('resize', () => paint(value));

  // ---- collapse / expand ----
  function setCollapsed(c) {
    rail.classList.toggle('collapsed', c);
    chip.classList.toggle('collapsed', c);
    collapseBtn.setAttribute('aria-expanded', String(!c));
    collapseBtn.setAttribute('aria-label', c ? 'Expand the spectrum control' : 'Collapse the spectrum control');
    onCollapse?.(c);
    // The track's geometry changes as the fold animates: repaint on arrival.
    if (!c) setTimeout(() => paint(value), 450);
  }
  collapseBtn.addEventListener('click', () => setCollapsed(!rail.classList.contains('collapsed')));
  if (collapsed) {
    rail.classList.add('collapsed');
    chip.classList.add('collapsed');
    collapseBtn.setAttribute('aria-expanded', 'false');
    collapseBtn.setAttribute('aria-label', 'Expand the spectrum control');
  }
  rail.querySelector('#spectrum-track').addEventListener('transitionend', () => paint(value));

  return {
    setValue(v, { settle = false } = {}) {
      value = target = Math.max(0, Math.min(MAX_VALUE, v));
      applyEngine(value);
      paint(value);
      if (settle) onSettle?.(value);
    },
    getValue: () => target,
    nearestSurveyId: () => SURVEYS[Math.round(target / STOP)].id,
    valueForSurveyId: (id) => {
      const i = SURVEYS.findIndex(s => s.id === id);
      return i >= 0 ? i * STOP : null;
    }
  };
}
