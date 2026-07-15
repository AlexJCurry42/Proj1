// Pocket Planetarium — the time scrubber's UI: the clock button, the glass
// popover (date-time picker, play controls, "Back to now"), and the amber
// time-shifted chip. All state lives in js/clock.js; every time-dependent
// layer subscribes there, so this file only drives the shared clock.
//
// Play: time-lapse the whole sky. One press runs the app clock at the
// selected speed (a minute, an hour, or a day per second) — the stars wheel,
// the Moon races, planets creep along the ecliptic — with the same chip
// marking the shift, and "Back to now" as the one-tap exit.

import { appNow, setAppTime, isTimeShifted, onTimeChange, setPlaySpeed, playSpeed } from './clock.js';

export function initTimeControl() {
  const btn = document.getElementById('time-btn');
  const panel = document.getElementById('time-panel');
  const input = document.getElementById('time-input');
  const nowBtn = document.getElementById('time-now');
  const chip = document.getElementById('time-chip');
  const playBtn = document.getElementById('time-play');
  const speedBtns = [...document.querySelectorAll('#time-speeds .speed-btn')];
  if (!btn || !panel || !input || !nowBtn || !chip) return;

  const pad = (n) => String(n).padStart(2, '0');
  // datetime-local speaks LOCAL wall-clock time with no zone suffix.
  const toLocalInputValue = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  let selectedMult = 3600; // an hour per second: the sweet spot for sky motion

  function refresh() {
    const shifted = isTimeShifted();
    const playing = playSpeed() !== 0;
    btn.setAttribute('aria-pressed', String(shifted));
    btn.classList.toggle('time-active', shifted);
    playBtn?.setAttribute('aria-pressed', String(playing));
    playBtn?.classList.toggle('playing', playing);
    chip.hidden = !shifted;
    if (shifted) {
      chip.textContent = (playing ? '▶ ' : '') + appNow().toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    }
  }
  onTimeChange(refresh);

  function openPanel() {
    input.value = toLocalInputValue(appNow());
    panel.hidden = false;
    if (playSpeed() === 0) input.focus({ preventScroll: true });
  }
  btn.addEventListener('click', () => {
    if (panel.hidden) openPanel(); else panel.hidden = true;
  });
  chip.addEventListener('click', openPanel); // the amber chip reopens the scrubber
  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target) && !chip.contains(e.target)) {
      panel.hidden = true;
    }
  });
  input.addEventListener('change', () => {
    const d = new Date(input.value);
    if (!Number.isNaN(d.getTime())) setAppTime(d); // also stops playback
  });
  nowBtn.addEventListener('click', () => {
    setAppTime(null); // stops playback and returns to real time
    panel.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) panel.hidden = true;
  });

  // ---- play controls ----
  playBtn?.addEventListener('click', () => {
    setPlaySpeed(playSpeed() === 0 ? selectedMult : 0);
  });
  for (const sb of speedBtns) {
    sb.addEventListener('click', () => {
      selectedMult = Number(sb.dataset.mult) || 3600;
      for (const b of speedBtns) b.classList.toggle('active', b === sb);
      if (playSpeed() !== 0) setPlaySpeed(selectedMult); // live speed change
    });
  }
  // While playing, the picker mirrors the moving clock (unless being edited).
  onTimeChange(() => {
    if (playSpeed() !== 0 && !panel.hidden && document.activeElement !== input) {
      input.value = toLocalInputValue(appNow());
    }
  });

  refresh();
}
