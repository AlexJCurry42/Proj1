// Project Planetarium — the first-run guided tour: a small glass callout
// that steps through the UI's doorways with Next buttons, a sprung
// highlight ring gliding from target to target, and page dots. It replaced
// the old static tips card, which explained less and pointed at nothing.
// Never a modal wall: the sky stays live, Skip is always one tap, and a
// swipe throws the card away. Runs once, ever (pref 'uiguide').

import { readPref, writePref } from './prefs.js';
import { makeDismissable } from './ui.js';
import { cardAppear } from './sound.js';

// target: element id (null = centered welcome). Text stays BRIEF — one
// idea per stop, and the location step keeps the optional-only promise.
const STEPS = [
  { target: null,
    text: 'Welcome to Project Planetarium — the whole sky, live. Drag to look around, pinch to zoom.' },
  { target: 'layer-dock',
    text: 'Layers: sky guides, catalogs, black holes and display options all live here.' },
  { target: 'spectrum-rail',
    text: 'The spectrum rail re-images the sky from gamma-ray to radio — every band is real telescope data.' },
  { target: 'cool-btn',
    text: '“Show me something cool” flies you to a famous object, with the story when you land.' },
  { target: 'skynow-btn',
    text: 'Sky Now shows YOUR sky at this moment. It asks for location first — optional, on-device only, never transmitted.' },
  { target: 'search-form',
    text: 'Search anything — “Andromeda”, “Ring Nebula”, or coordinates. Press ? any time for shortcuts.' }
];

export function initUiGuide() {
  if (readPref('uiguide', false)) return;

  const card = document.createElement('div');
  card.id = 'ui-guide';
  card.className = 'glass-panel';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Quick tour');
  const text = document.createElement('p');
  text.className = 'guide-text';
  const rowEl = document.createElement('div');
  rowEl.className = 'guide-row';
  const dots = document.createElement('div');
  dots.className = 'guide-dots';
  for (let i = 0; i < STEPS.length; i++) dots.appendChild(document.createElement('span'));
  const skip = document.createElement('button');
  skip.className = 'guide-skip';
  skip.textContent = 'Skip';
  const next = document.createElement('button');
  next.className = 'guide-next';
  rowEl.append(dots, skip, next);
  card.append(text, rowEl);

  const ring = document.createElement('div');
  ring.id = 'guide-ring';

  let idx = 0;
  let active = false;

  function place() {
    const step = STEPS[idx];
    const t = step.target && document.getElementById(step.target);
    const vw = window.innerWidth, vh = window.innerHeight;
    const cw = Math.min(300, vw - 24);
    if (t) {
      const r = t.getBoundingClientRect();
      ring.style.opacity = '1';
      ring.style.left = `${r.left - 6}px`;
      ring.style.top = `${r.top - 6}px`;
      ring.style.width = `${r.width + 12}px`;
      ring.style.height = `${r.height + 12}px`;
      // The card sits under the target when the target is in the top half,
      // above it otherwise — never covering what it is pointing at.
      const below = r.top + r.height / 2 < vh / 2;
      card.style.top = below ? `${Math.min(vh - 150, r.bottom + 14)}px` : '';
      card.style.bottom = below ? '' : `${Math.min(vh - 150, vh - r.top + 14)}px`;
      const cx = Math.max(12, Math.min(vw - cw - 12, r.left + r.width / 2 - cw / 2));
      card.style.left = `${cx}px`;
      card.style.transform = '';
    } else {
      ring.style.opacity = '0';
      card.style.left = '50%';
      card.style.top = '42%';
      card.style.bottom = '';
      card.style.transform = 'translate(-50%, -50%)';
    }
  }

  function show(i) {
    idx = i;
    text.textContent = STEPS[idx].text;
    next.textContent = idx === STEPS.length - 1 ? 'Done' : 'Next';
    [...dots.children].forEach((d, k) => d.classList.toggle('on', k === idx));
    place();
    cardAppear();
  }

  function finish() {
    if (!active) return;
    active = false;
    writePref('uiguide', true);
    window.removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('guiding');
    card.remove();
    ring.remove();
  }

  next.addEventListener('click', () => {
    if (idx >= STEPS.length - 1) finish();
    else show(idx + 1);
  });
  skip.addEventListener('click', finish);
  makeDismissable(card, finish);
  // The same keyboard contract as every other dismissable surface:
  // Escape puts the tour away (it counts as done — it never returns).
  const onKey = (e) => { if (e.key === 'Escape' && active) finish(); };
  document.addEventListener('keydown', onKey);

  // Let the boot screen fade and the sky settle before speaking up.
  setTimeout(() => {
    if (readPref('uiguide', false)) return; // dismissed elsewhere meanwhile
    active = true;
    document.body.classList.add('guiding'); // css: the crosshair card stands aside
    document.body.append(ring, card);
    window.addEventListener('resize', place);
    show(0);
    // First boot: give focus to Next so the whole tour is Enter, Enter, … —
    // unless the user already reached an input (search, time pickers) in
    // the 1.8 s delay; yanking focus mid-word would close their keyboard.
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
    if (!typing) next.focus({ preventScroll: true });
  }, 1800);
}
