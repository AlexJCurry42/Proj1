// Deep Sky Atlas — the spectrum slider. One control, the whole electromagnetic
// spectrum: every imagery survey sits on a single track ordered from the
// shortest wavelength (gamma-ray) to the longest (radio), and dragging
// between adjacent stops cross-fades them live. Replaces the old
// base-select + overlay-select + blend-slider trio.

export const SURVEYS = [
  { id: 'P/Fermi/color', name: 'Fermi', band: 'Gamma-ray — the violent universe' },
  { id: 'P/SDSS9/color', name: 'SDSS9', band: 'Optical — Sloan digital survey' },
  { id: 'P/PanSTARRS/DR1/color-z-zg-g', name: 'Pan-STARRS', band: 'Optical — deepest wide field' },
  { id: 'P/DSS2/color', name: 'DSS2', band: 'Optical — the classic all-sky view' },
  { id: 'P/2MASS/color', name: '2MASS', band: 'Near-infrared — through the dust' },
  { id: 'P/allWISE/color', name: 'AllWISE', band: 'Mid-infrared — warm dust & AGN glow' },
  { id: 'P/NVSS', name: 'NVSS', band: 'Radio — jets, lobes & remnants' }
];

export const STOP = 100; // slider units per survey stop
export const MAX_VALUE = (SURVEYS.length - 1) * STOP;
export const DEFAULT_VALUE = SURVEYS.findIndex(s => s.name === 'DSS2') * STOP;

/**
 * Wire the spectrum bar to the engine. Returns { setValue, getValue,
 * nearestSurveyId, valueForSurveyId } for permalink/preference plumbing.
 * onSettle(value) fires when the user releases the thumb (post-snap).
 */
export function initSpectrumBar(aladin, { onSettle } = {}) {
  const slider = document.getElementById('spectrum-slider');
  const nameEl = document.getElementById('spectrum-name');
  const bandEl = document.getElementById('spectrum-band');
  const dotsEl = document.getElementById('spectrum-dots');

  // One dot per survey stop, aligned with the thumb's travel.
  for (let i = 0; i < SURVEYS.length; i++) {
    const dot = document.createElement('span');
    dot.className = 'spectrum-dot';
    dot.style.left = `${(i / (SURVEYS.length - 1)) * 100}%`;
    dotsEl.appendChild(dot);
  }

  let curBase = -1;
  let curOver = -1;
  let overlayLayer = null;

  function apply(value) {
    const v = Math.max(0, Math.min(MAX_VALUE, value));
    const idx = Math.min(Math.floor(v / STOP), SURVEYS.length - 2);
    const frac = (v - idx * STOP) / STOP; // 0..1 toward the next survey

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
      try { overlayLayer?.setOpacity?.(frac); } catch (err) { /* non-fatal */ }
    } else {
      try { overlayLayer?.setOpacity?.(0); } catch (err) { /* non-fatal */ }
    }

    // Label: nearest survey's name and band; both names while truly blended.
    const near = Math.round(v / STOP);
    nameEl.textContent = (frac > 0.18 && frac < 0.82)
      ? `${SURVEYS[idx].name} + ${SURVEYS[overIdx].name}`
      : SURVEYS[near].name;
    bandEl.textContent = SURVEYS[near].band;
    dotsEl.querySelectorAll('.spectrum-dot').forEach((d, i) => d.classList.toggle('active', i === near));
  }

  // Drag: apply at most once per frame. Release: gentle magnetic snap.
  let rafPending = false;
  slider.addEventListener('input', () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      apply(Number(slider.value));
    });
  });
  slider.addEventListener('change', () => {
    let v = Number(slider.value);
    const near = Math.round(v / STOP) * STOP;
    if (Math.abs(v - near) <= 15) v = near; // snap when released close to a stop
    slider.value = v;
    apply(v);
    onSettle?.(v);
  });

  return {
    setValue(v, { settle = false } = {}) {
      slider.value = Math.max(0, Math.min(MAX_VALUE, v));
      apply(Number(slider.value));
      if (settle) onSettle?.(Number(slider.value));
    },
    getValue: () => Number(slider.value),
    nearestSurveyId: () => SURVEYS[Math.round(Number(slider.value) / STOP)].id,
    valueForSurveyId: (id) => {
      const i = SURVEYS.findIndex(s => s.id === id);
      return i >= 0 ? i * STOP : null;
    }
  };
}
