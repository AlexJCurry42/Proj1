// Pocket Planetarium — the layer dock's building blocks: section headers,
// the toggle rows (switches and sub-checkboxes), persistence of the user's
// layer choices, and the collapse-to-pill behavior. app.js composes the
// actual dock from these.

import { readPref, writePref } from './prefs.js';

const savedLayers = readPref('layers', {});
// Migration: the two deep-sky toggles merged into one. If a returning user
// had either of the old switches on, the merged switch comes on.
if ('Messier & NGC' in savedLayers || 'NGC & IC (full)' in savedLayers) {
  if (!('Deep sky' in savedLayers)) {
    savedLayers['Deep sky'] = savedLayers['Messier & NGC'] === true || savedLayers['NGC & IC (full)'] === true;
  }
  delete savedLayers['Messier & NGC'];
  delete savedLayers['NGC & IC (full)'];
  writePref('layers', savedLayers);
}

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
  li.innerHTML =
    `<span class="legend-dot" style="background:${color};color:${color}"></span>` +
    `<label class="toggle-label" for="${id}"><span class="toggle-text">${label}</span><span class="toggle-count"></span></label>` +
    `<input type="checkbox" ${sub ? 'class="sub"' : 'role="switch"'} id="${id}" ${initial ? 'checked' : ''}/>`;
  listEl.appendChild(li);
  const input = li.querySelector('input');
  input.addEventListener('change', () => {
    if (persist) {
      savedLayers[label] = input.checked;
      writePref('layers', savedLayers);
    }
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
  function setCollapsed(c) {
    dock.classList.toggle('collapsed', c);
    btn.setAttribute('aria-expanded', String(!c));
    btn.setAttribute('aria-label', c ? 'Expand the layers menu' : 'Collapse the layers menu');
    writePref('dockcollapsed', c);
  }
  btn.addEventListener('click', () => setCollapsed(!dock.classList.contains('collapsed')));
  if (readPref('dockcollapsed', false) === true) {
    dock.classList.add('collapsed');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Expand the layers menu');
  }
}
