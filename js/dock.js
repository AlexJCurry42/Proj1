// Pocket Planetarium — the layer dock's building blocks: section headers,
// the toggle rows (switches and sub-checkboxes), persistence of the user's
// layer choices, and the collapse-to-pill behavior. app.js composes the
// actual dock from these.

import { readPref, writePref } from './prefs.js';
import { layerToggle } from './sound.js';

const savedLayers = readPref('layers', {});

/** A quiet section header inside the layer dock (visual only). */
export function addDockSection(listEl, title) {
  const li = document.createElement('li');
  li.className = 'dock-section';
  li.setAttribute('aria-hidden', 'true');
  li.textContent = title;
  listEl.appendChild(li);
}

let toggleSeq = 0;

/**
 * One dock row: a labeled iOS-style switch (or square sub-checkbox).
 * onToggle(checked, { gesture }) — gesture:false marks the boot-time call
 * for layers that start enabled, so handlers can defer anything that must
 * not happen without a user action (like a permission prompt).
 * Returns { setCount, isChecked, setDisabled, setChecked, setLoading }.
 */
export function addToggle(listEl, { label, color, checked = true, sub = false, persist = true, onToggle }) {
  // persist:false = the switch's state lives elsewhere (e.g. the Animations
  // switch persists through js/motion.js), so keep it out of the layers pref.
  const saved = persist && Object.prototype.hasOwnProperty.call(savedLayers, label) ? savedLayers[label] : undefined;
  const initial = saved ?? checked;
  const id = `tgl-${++toggleSeq}`;
  const li = document.createElement('li');
  if (sub) li.className = 'toggle-sub';
  // DOM nodes, not innerHTML: every caller passes hardcoded labels and
  // colors today, but a sink must not depend on its callers staying polite.
  const dot = document.createElement('span');
  dot.className = 'legend-dot';
  dot.style.background = color;
  dot.style.color = color;
  const lbl = document.createElement('label');
  lbl.className = 'toggle-label';
  lbl.htmlFor = id;
  const text = document.createElement('span');
  text.className = 'toggle-text';
  text.textContent = label;
  const count = document.createElement('span');
  count.className = 'toggle-count';
  lbl.append(text, count);
  const input = document.createElement('input');
  input.type = 'checkbox';
  if (sub) input.className = 'sub'; else input.setAttribute('role', 'switch');
  input.id = id;
  input.checked = initial;
  li.append(dot, lbl, input);
  listEl.appendChild(li);
  input.addEventListener('change', () => {
    if (persist) {
      savedLayers[label] = input.checked;
      writePref('layers', savedLayers);
    }
    layerToggle(input.checked); // gesture-only by construction: change events come from taps
    onToggle(input.checked, { gesture: true });
  });
  // Any layer that starts enabled — by default or from last visit — must
  // initialize now; lazy layers guard themselves against double-init.
  // (persist:false switches manage their own boot state, e.g. Animations.)
  if (initial && persist) queueMicrotask(() => onToggle(true, { gesture: false }));
  return {
    setCount: (n) => { li.querySelector('.toggle-count').textContent = n; },
    isChecked: () => input.checked,
    setDisabled: (d) => { input.disabled = d; li.classList.toggle('disabled', d); },
    // Lazy layers fetch on first flip; the row shimmers while that runs so
    // the wait reads as loading, not as a dead switch.
    setLoading: (on) => { li.classList.toggle('loading', !!on); },
    // Programmatic revert (e.g. a layer whose permission was denied): keeps
    // the saved preference in sync but does NOT re-fire onToggle.
    setChecked: (v) => {
      input.checked = v;
      if (persist) {
        savedLayers[label] = v;
        writePref('layers', savedLayers);
      }
    }
  };
}

/**
 * The layer dock folds the same way the spectrum rail does: one chevron,
 * one sprung animation down to a lone pill. State persists across visits.
 */
export function initDockCollapse() {
  const dock = document.getElementById('layer-dock');
  const btn = document.getElementById('dock-collapse');
  if (!dock || !btn) return; // stale HTML mid-deploy: skip, never crash boot
  let expandedAt = 0; // grace: residual view motion (horizon-lock settle,
                      // flight tail) must not slam the dock shut as it opens
  function setCollapsed(c) {
    if (!c) expandedAt = performance.now();
    dock.classList.toggle('collapsed', c);
    btn.setAttribute('aria-expanded', String(!c));
    btn.setAttribute('aria-label', c ? 'Expand the layers menu' : 'Collapse the layers menu');
    writePref('dockcollapsed', c);
  }
  btn.addEventListener('click', () => setCollapsed(!dock.classList.contains('collapsed')));
  // Collapsed by default: the dock must not open itself over the sky on a
  // first visit — the guided tour points it out instead. The user's own
  // expand/collapse choice persists from then on.
  if (readPref('dockcollapsed', true) === true) {
    dock.classList.add('collapsed');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Expand the layers menu');
  }
  // The open dock behaves like a popover: any tap OUTSIDE it puts it away
  // (taps inside — flipping switches, scrolling the list — leave it open).
  document.addEventListener('pointerdown', (e) => {
    if (!dock.classList.contains('collapsed') && !dock.contains(e.target)) setCollapsed(true);
  });
  // …and the view-moved path (pan/zoom/flights) closes it too; app.js wires
  // collapseDock() to the engine's position and zoom events.
  autoCollapse = () => {
    if (dock.classList.contains('collapsed')) return;
    if (performance.now() - expandedAt < 600) return; // grace window
    setCollapsed(true);
  };
}

// Filled by initDockCollapse; a no-op until then (and with stale HTML).
let autoCollapse = null;

/** Collapse the layer dock if it is open — the sky was touched or moved. */
export function collapseDock() { autoCollapse?.(); }
