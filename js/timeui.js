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
import { playStart, playStop } from './sound.js';

export function initTimeControl() {
  const btn = document.getElementById('time-btn');
  const panel = document.getElementById('time-panel');
  const dateIn = document.getElementById('time-date');
  const timeIn = document.getElementById('time-time');
  const nowBtn = document.getElementById('time-now');
  const chip = document.getElementById('time-chip');
  const playBtn = document.getElementById('time-play');
  const speedSlider = document.getElementById('time-speed');
  if (!btn || !panel || !dateIn || !timeIn || !nowBtn || !chip) return;

  const pad = (n) => String(n).padStart(2, '0');
  // Two separate fields (LOCAL wall-clock): nudging the time of day must
  // never drag the user through a calendar picker.
  const toDateValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toTimeValue = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const setInputs = (d) => { dateIn.value = toDateValue(d); timeIn.value = toTimeValue(d); };
  const editingInputs = () => document.activeElement === dateIn || document.activeElement === timeIn;

  // Playback speed is a continuous slider, minutes → hours → ∞, on a
  // piecewise-log scale so "hr" sits exactly at center: the left half runs
  // a minute-per-second up to an hour-per-second, the right half runs on
  // up to the maximum (0.6 day per real second — the rate approved when
  // the old day/s button was slowed 40%). One shared multiplier drives the
  // clock, the chip and the sky, so the display can never drift from the
  // rotation — and dragging mid-playback retunes the speed live.
  const MIN_MULT = 60, MID_MULT = 3600, MAX_MULT = 51840;
  const multFromSlider = () => {
    const v = (Number(speedSlider?.value) || 500) / 1000;
    return v <= 0.5
      ? MIN_MULT * Math.pow(MID_MULT / MIN_MULT, v / 0.5)
      : MID_MULT * Math.pow(MAX_MULT / MID_MULT, (v - 0.5) / 0.5);
  };
  const atInfinity = () => speedSlider && Number(speedSlider.value) >= 1000;
  let selectedMult = 3600;

  // ---- the Easter egg ----
  // Play the sky at a DAY per second and the app cues a bundled audio
  // track (assets/egg-crucified.mp3, supplied by the project owner) —
  // fully on-origin, no third-party embeds, so the privacy promise stays
  // absolute. Until the file exists the egg is a silent no-op. A small
  // chip names the track while it plays; ✕ stops it until the next play.
  let eggAudio = null;
  let eggEl = null;
  let eggDismissed = false;
  function stopEgg() {
    try { eggAudio?.pause(); } catch (err) { /* already gone */ }
    eggAudio = null;
    eggEl?.remove();
    eggEl = null;
  }
  function syncEgg() {
    const want = playSpeed() !== 0 && atInfinity() && !eggDismissed;
    window.__eggWanted = want; // test hook: the trigger logic, independent of the audio file
    if (want && !eggAudio) {
      eggAudio = new Audio('assets/egg-crucified.mp3');
      eggAudio.loop = true;
      eggAudio.volume = 0.5; // the track opens hot: halved by request
      const started = eggAudio.play();
      eggEl = document.createElement('div');
      eggEl.id = 'egg-player';
      eggEl.className = 'glass-panel';
      eggEl.innerHTML =
        '<span class="egg-note" aria-hidden="true">♪</span>' +
        '<span class="egg-title">Crucified — Army of Lovers</span>' +
        '<button id="egg-close" class="glass-btn small" aria-label="Stop the music">' +
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="7" y1="7" x2="17" y2="17"/><line x1="17" y1="7" x2="7" y2="17"/></svg>' +
        '</button>';
      document.body.appendChild(eggEl);
      eggEl.querySelector('#egg-close').addEventListener('click', () => {
        eggDismissed = true;
        syncEgg();
      });
      // File not deployed yet (or autoplay denied): vanish without a trace.
      started?.catch(() => stopEgg());
    } else if (!want && eggAudio) {
      stopEgg();
    }
    if (playSpeed() === 0) eggDismissed = false; // a fresh play can summon it again
  }

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
    syncEgg();
  }
  onTimeChange(refresh);

  function openPanel() {
    setInputs(appNow());
    panel.hidden = false;
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
  const applyInputs = () => {
    // Either field alone is enough: the other falls back to the shown value.
    const dv = dateIn.value || toDateValue(appNow());
    const tv = timeIn.value || toTimeValue(appNow());
    const d = new Date(`${dv}T${tv}`);
    if (!Number.isNaN(d.getTime())) setAppTime(d); // also stops playback
  };
  dateIn.addEventListener('change', applyInputs);
  timeIn.addEventListener('change', applyInputs);
  nowBtn.addEventListener('click', () => {
    setAppTime(null); // stops playback and returns to real time
    panel.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) panel.hidden = true;
  });

  // ---- play controls ----
  playBtn?.addEventListener('click', () => {
    const starting = playSpeed() === 0;
    selectedMult = multFromSlider();
    setPlaySpeed(starting ? selectedMult : 0);
    if (starting) playStart(); else playStop();
  });
  // Seamless: dragging the slider retunes a running playback continuously.
  speedSlider?.addEventListener('input', () => {
    selectedMult = multFromSlider();
    if (playSpeed() !== 0) setPlaySpeed(selectedMult);
    syncEgg(); // ∞ reached (or left) mid-playback arms or retires the egg
  });
  // While playing, the pickers mirror the moving clock (unless being edited).
  onTimeChange(() => {
    if (playSpeed() !== 0 && !panel.hidden && !editingInputs()) {
      setInputs(appNow());
    }
  });

  refresh();
}
