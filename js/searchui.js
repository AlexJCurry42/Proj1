// Project Planetarium — the search box UX: recents dropdown, instant
// suggestions from the curated catalogs, keyboard navigation, and the
// submit → resolve → detail-panel flow. Resolution itself lives in
// js/search.js; the suggestion index in js/suggest.js.

import { runSearch, supersedeSearch, getHistory, addToHistory, flyTo } from './search.js';
import { querySuggestions, suggestionCoords } from './suggest.js';
import { renderDetailPanel, currentDetailEpoch, humanObjectType } from './ui.js';

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function initSearchUI(aladin) {
  const searchForm = document.getElementById('search-form');
  const searchInput = document.getElementById('search-input');
  const historyList = document.getElementById('search-history');
  const suggList = document.getElementById('search-suggestions');
  if (!searchForm || !searchInput) return;
  let currentSuggs = [];
  let activeIdx = -1;

  // DOM nodes + textContent, never innerHTML: history labels and queries are
  // RAW USER INPUT (and suggestion names come from data files) — a query
  // like "<img src=x onerror=…>" must render as text, not execute.
  function itemLi(title, sub, idxAttr, idx) {
    const li = document.createElement('li');
    li.dataset[idxAttr] = String(idx);
    li.role = 'option';
    li.id = `${idxAttr === 'idx' ? 'hist' : 'sugg'}-opt-${idx}`;
    li.setAttribute('aria-selected', 'false');
    li.append(title);
    const s = document.createElement('div');
    s.className = 'item-sub';
    s.textContent = sub;
    li.appendChild(s);
    return li;
  }

  // The combobox contract: aria-expanded mirrors whether EITHER list is
  // open, aria-controls names the open one, aria-activedescendant tracks
  // the keyboard-highlighted option.
  function syncExpanded() {
    const open = !historyList.hidden ? historyList : (!suggList.hidden ? suggList : null);
    searchInput.setAttribute('aria-expanded', String(!!open));
    if (open) searchInput.setAttribute('aria-controls', open.id);
    else {
      searchInput.removeAttribute('aria-controls');
      searchInput.removeAttribute('aria-activedescendant');
    }
  }

  function renderHistory() {
    historyList.replaceChildren(...getHistory().map((h, i) => itemLi(h.label, h.query, 'idx', i)));
  }
  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim().length >= 2) return;
    renderHistory();
    activeIdx = -1;
    historyList.hidden = getHistory().length === 0;
    syncExpanded();
  });
  searchInput.addEventListener('blur', () => setTimeout(() => {
    historyList.hidden = true;
    suggList.hidden = true;
    syncExpanded();
  }, 150));
  // mousedown, not click — same reason as the suggestion list below: the
  // input's blur hides this list after 150 ms, so a press held longer than
  // that landed on a hidden list and was silently lost.
  historyList.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();
    const h = getHistory()[Number(li.dataset.idx)];
    if (!h) return;
    searchInput.value = h.query;
    historyList.hidden = true;
    searchForm.requestSubmit(); // re-run the search, don't just fill the box
  });

  // Instant suggestions from the app's own curated objects (no network —
  // but the FIRST query awaits the catalog files, so a slow first call can
  // outlive later keystrokes; the token keeps only the newest one's list).
  let suggSeq = 0;
  const runSuggest = debounce(async () => {
    const token = ++suggSeq;
    const suggs = await querySuggestions(searchInput.value);
    if (token !== suggSeq) return;
    currentSuggs = suggs;
    activeIdx = -1;
    if (!currentSuggs.length) { suggList.hidden = true; syncExpanded(); return; }
    historyList.hidden = true;
    suggList.replaceChildren(...currentSuggs.map((s, i) => itemLi(s.name, s.typeLabel, 'i', i)));
    suggList.hidden = false;
    syncExpanded();
  }, 140);
  searchInput.addEventListener('input', () => {
    if (searchInput.value.trim().length >= 2) runSuggest();
    else { suggSeq++; suggList.hidden = true; syncExpanded(); }
  });

  function pickSuggestion(s) {
    const c = suggestionCoords(s);
    if (!c) return;
    supersedeSearch(); // a slow pending submit must not fly us away later
    flyTo(aladin, c.ra, c.dec, s.fov ?? 0.8);
    addToHistory({ query: s.name, ra: c.ra, dec: c.dec, label: s.name });
    renderDetailPanel({ name: s.name, typeLabel: s.typeLabel, ra: c.ra, dec: c.dec });
    suggList.hidden = true;
    historyList.hidden = true;
    syncExpanded();
    searchInput.value = s.name;
    searchInput.blur();
  }
  // mousedown, not click: it must beat the input's blur handler.
  suggList.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();
    pickSuggestion(currentSuggs[Number(li.dataset.i)]);
  });
  // Arrow/Enter drive WHICHEVER list is open — the history dropdown
  // advertises the same combobox contract and must honor it too.
  searchInput.addEventListener('keydown', (e) => {
    const list = !suggList.hidden ? suggList : (!historyList.hidden ? historyList : null);
    if (!list) return;
    const n = list === suggList ? currentSuggs.length : getHistory().length;
    if (!n) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = ((activeIdx + (e.key === 'ArrowDown' ? 1 : -1)) % n + n) % n;
      [...list.children].forEach((el, i) => {
        el.classList.toggle('active', i === activeIdx);
        el.setAttribute('aria-selected', String(i === activeIdx));
      });
      searchInput.setAttribute('aria-activedescendant',
        `${list === suggList ? 'sugg' : 'hist'}-opt-${activeIdx}`);
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      if (list === suggList) {
        pickSuggestion(currentSuggs[activeIdx]);
      } else {
        const h = getHistory()[activeIdx];
        if (!h) return;
        searchInput.value = h.query;
        historyList.hidden = true;
        searchForm.requestSubmit();
      }
    }
  });

  // Submit token: runSearch already refuses to fly for a superseded search,
  // but the panel render below awaits one more lookup — guard it too so a
  // slow older submit can't overwrite the newer search's panel.
  let submitSeq = 0;
  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = ++submitSeq;
    suggList.hidden = true;
    syncExpanded();
    const epoch = currentDetailEpoch();
    const result = await runSearch(aladin, searchInput.value);
    renderHistory();
    searchInput.blur();
    // A resolved named object opens its detail card (with media if famous).
    if (result && result.name) {
      const typeLabel = result.otype ? await humanObjectType(result.otype) : 'Astronomical object';
      if (token !== submitSeq || epoch !== currentDetailEpoch()) return;
      renderDetailPanel({
        name: result.name,
        aliases: result.aliases,
        typeLabel,
        ra: result.ra,
        dec: result.dec,
        source: 'CDS Sesame name resolver (SIMBAD/NED/VizieR)'
      });
    }
  });
}
