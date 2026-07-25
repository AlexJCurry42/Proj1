// Project Planetarium — the layer dock controller: every switch in the left
// dock, section by section, with its lazy loading, consent flows and count
// badges. Extracted from app.js, which now only boots and wires.
//
// Layer philosophy: the sky should feel calm on first load. Only the horizon
// guide starts on (and only where permission already exists); every catalog
// — Solar System included — lazy-creates or stays hidden until its switch is
// flipped, and the user's choices persist.

import { showToast } from './ui.js';
import { initGaiaHips, initGalaxiesLayer, initSimbadBlackHolesLayer, loadMessierNgc, loadNgcFull, loadExoplanets } from './catalogs.js';
import { initIssLayer } from './iss.js';
import { loadStellarBlackHoles, loadFlagshipSupermassive, initMilliquasLayer } from './blackholes.js';
import { initPlanetsLayer } from './planetslayer.js';
import { loadConstellations, loadConstellationBorders } from './constellations.js';
import { initHorizonLayer, initHorizonLock, requestObserver } from './horizon.js';
import { initStarBloom } from './starbloom.js';
import { onObserver, cachedObserver } from './observer.js';
import { motionOK, setAnimationsEnabled } from './motion.js';
import { addDockSection, addToggle } from './dock.js';
import { initGridLayer } from './grid.js';
import { geoPermissionState } from './loccard.js';
import { setSfxEnabled } from './sound.js';

/**
 * Build the whole dock. `fadeCatalog(cat, visible)` is the marker
 * cross-fader from js/markerfade.js (already engine-bound by the caller).
 * Returns { onTrackingStart } — Sky Now's gyro tracking calls it so the
 * horizon overlay lights up with the tracker's own coordinates.
 */
export function initLayersDock(aladin, { onZoom, onPosition, fadeCatalog }) {
  const catalogList = document.getElementById('layer-dock-list');

  function setCatalogVisible(catalogOrList, visible) {
    if (!catalogOrList) return;
    const list = Array.isArray(catalogOrList) ? catalogOrList : [catalogOrList];
    for (const catalog of list) {
      if (!catalog) continue;
      fadeCatalog(catalog, visible);
    }
  }

  addDockSection(catalogList, 'Sky guides');

  // Horizon & compass: YOUR horizon on the sky — ON by default (it's the
  // main defense against getting lost in the spherical views). Needs
  // location (on-device only); if permission is declined the switch turns
  // itself back off and never nags. Alongside the drawn overlay comes the
  // horizon LOCK: while the user pans, the view gently re-levels so their
  // zenith reads as up.
  const horizonRef = { ctl: null, busy: false };
  const horizonLock = initHorizonLock(aladin, onPosition);
  const horizonToggle = addToggle(catalogList, {
    label: 'Horizon & compass', color: '#63d68b', checked: true,
    onToggle: async (v, { gesture } = {}) => {
      if (v && !horizonRef.ctl && !horizonRef.busy) {
        horizonRef.busy = true;
        try {
          // Boot NEVER asks for location — not even with the in-app card.
          // The only prompt moments are the Sky Now button (see skynow.js)
          // and a deliberate flip of this switch. Without permission the
          // layer just waits, quietly unchecked.
          if (!gesture && !cachedObserver()) {
            if ((await geoPermissionState()) !== 'granted') {
              horizonToggle.setChecked(false);
              horizonRef.busy = false;
              return;
            }
          }
          horizonToggle.setLoading(true);
          const obs = await requestObserver();
          horizonRef.ctl = initHorizonLayer(aladin, obs);
          horizonLock.setObserver(obs);
        } catch (err) {
          showToast('The horizon overlay needs your location to know which sky is yours — it never leaves this device.', 'error', 8000);
          horizonToggle.setChecked(false);
        }
        horizonToggle.setLoading(false);
        horizonRef.busy = false;
      }
      if (!horizonRef.ctl) return;
      const on = horizonToggle.isChecked();
      horizonLock.setEnabled(on);
      if (on) horizonRef.ctl.show(); else horizonRef.ctl.hide();
    }
  });
  // Gyro tracking brings its own orientation context: the horizon, cardinal
  // directions and zenith switch on with it (coordinates arrive from the
  // tracker, so no second location request is ever needed).
  function onTrackingStart(lat, lon) {
    if (!horizonRef.ctl) {
      try { horizonRef.ctl = initHorizonLayer(aladin, { lat, lon }); }
      catch (err) { return; }
    }
    if (!horizonToggle.isChecked()) horizonToggle.setChecked(true);
    horizonLock.setObserver({ lat, lon });
    horizonLock.setEnabled(true);
    horizonRef.ctl.show();
  }

  // Coordinate grid: our own RA/Dec graticule on the overlay engine (the
  // engine's built-in one snapped between spacing levels and let its labels
  // drift with the sky). Spacing cross-fades continuously with zoom, and
  // the labels are pinned to the screen edges — a scale readout that sits
  // still while the sky moves under it.
  const gridRef = { ctl: null };
  addToggle(catalogList, {
    label: 'Coordinate grid', color: '#5ac8fa', checked: false,
    onToggle: (v) => {
      if (v && !gridRef.ctl) gridRef.ctl = initGridLayer(aladin);
      if (gridRef.ctl) (v ? gridRef.ctl.show() : gridRef.ctl.hide());
    }
  });

  const constRef = { loading: false };
  const bordersRef = { loading: false };
  function ensureConstellations() {
    if (constRef.catalogs || constRef.loading) return;
    constRef.loading = true;
    constToggle.setLoading(true);
    loadConstellations(aladin).then(({ catalogs, count }) => {
      constRef.catalogs = catalogs;
      constRef.loading = false;
      constToggle.setLoading(false);
      constToggle.setCount(count);
      setCatalogVisible(catalogs, constToggle.isChecked());
    });
  }

  // Boundaries live as a sub-checkbox of Constellations: visible only when
  // its parent is on, and following the parent off/on.
  function syncBorders() {
    const parentOn = constToggle.isChecked();
    bordersToggle.setDisabled(!parentOn);
    const show = parentOn && bordersToggle.isChecked();
    if (show && !bordersRef.catalogs && !bordersRef.loading) {
      bordersRef.loading = true;
      loadConstellationBorders(aladin).then(({ catalogs }) => {
        bordersRef.catalogs = catalogs;
        bordersRef.loading = false;
        setCatalogVisible(catalogs, constToggle.isChecked() && bordersToggle.isChecked());
      });
      return;
    }
    setCatalogVisible(bordersRef.catalogs, show);
  }
  const constToggle = addToggle(catalogList, {
    label: 'Constellations', color: '#7aa0ff', checked: false,
    onToggle: (v) => {
      if (v) ensureConstellations(); // lazy: boot stays light, first flip loads
      setCatalogVisible(constRef.catalogs, v);
      syncBorders();
    }
  });
  const bordersToggle = addToggle(catalogList, {
    label: 'Boundaries', color: '#39496b', checked: false, sub: true,
    onToggle: () => syncBorders()
  });
  syncBorders();

  addDockSection(catalogList, 'Catalogs');

  // Deep sky: one switch for everything beyond the Solar System's furniture.
  // The ~140 curated showpieces (typed colors, photos, renders) are the
  // always-ready bright tier; the complete OpenNGC catalog (~12k objects,
  // magnitude-tiered by zoom, deduped against the showpieces) lazy-loads the
  // first time the switch is flipped.
  const deepRef = { curated: null, curatedCount: 0, ids: null, full: null, loading: false };
  const deepToggle = addToggle(catalogList, {
    label: 'Deep sky', color: '#ffd60a', checked: false,
    onToggle: async (v) => {
      // Everything is lazy — curated showpieces AND the full OpenNGC
      // catalog load together on the first flip, nothing at boot.
      if (v && !deepRef.curated && !deepRef.loading) {
        deepRef.loading = true;
        deepToggle.setLoading(true);
        const { catalogs, count, ids } = await loadMessierNgc(aladin, onZoom);
        deepRef.curated = catalogs;
        deepRef.curatedCount = count;
        deepRef.ids = ids;
        const full = await loadNgcFull(aladin, onZoom, ids || undefined);
        deepRef.full = full.catalog;
        deepRef.loading = false;
        deepToggle.setLoading(false);
        deepToggle.setCount((count + (full.count || 0)).toLocaleString());
      }
      setCatalogVisible(deepRef.curated, deepToggle.isChecked());
      setCatalogVisible(deepRef.full, deepToggle.isChecked());
    }
  });

  // Solar System: Sun, Moon, planets — and the ISS, humanity's outpost. The
  // station's position is observer-dependent (LEO parallax spans tens of
  // degrees), so its marker lights up the moment coordinates arrive from a
  // feature the user chose (horizon consent, Sky Now); it never prompts.
  // OFF by default like every catalog: a new user's first sky is just the
  // sky (the guided tour points at the dock where all of this lives).
  const planetsRef = { iss: null, issStarted: false };
  const planetsToggle = addToggle(catalogList, {
    label: 'Solar System', color: '#7fd6ff', checked: false,
    onToggle: (v) => {
      setCatalogVisible(planetsRef.catalogs, v);
      if (planetsRef.iss) { if (v) planetsRef.iss.show(); else planetsRef.iss.hide(); }
    }
  });
  initPlanetsLayer(aladin).then(({ catalogs, count }) => {
    planetsRef.catalogs = catalogs;
    planetsRef.count = count;
    planetsToggle.setCount(count);
    setCatalogVisible(catalogs, planetsToggle.isChecked());
  });
  onObserver(async (obs) => {
    if (planetsRef.issStarted) return;
    planetsRef.issStarted = true;
    try {
      planetsRef.iss = await initIssLayer(aladin, obs);
    } catch (err) { /* no TLE yet: the marker just doesn't appear */ }
    if (planetsRef.iss && planetsToggle.isChecked()) {
      planetsRef.iss.show();
      planetsToggle.setCount((planetsRef.count || 11) + 1);
    }
  });

  // Off by default, created lazily on first enable: heavy/bulk layers.
  let gaiaCat = null;
  addToggle(catalogList, {
    label: 'Gaia stars', color: '#ffffff', checked: false,
    onToggle: (v) => {
      if (v && !gaiaCat) gaiaCat = initGaiaHips(aladin);
      else setCatalogVisible(gaiaCat, v);
    }
  });

  let galaxiesCat = null;
  addToggle(catalogList, {
    label: 'Galaxies', color: '#ffcc66', checked: false,
    onToggle: (v) => {
      if (v && !galaxiesCat) {
        galaxiesCat = initGalaxiesLayer(aladin, onZoom, onPosition);
      } else {
        galaxiesCat?.dsaSetEnabled?.(v); // stop/restart live SIMBAD queries
        setCatalogVisible(galaxiesCat, v);
      }
    }
  });

  const exoRef = { loading: false };
  const exoToggle = addToggle(catalogList, {
    label: 'Exoplanets', color: '#30d158', checked: false,
    onToggle: async (v) => {
      if (v && !exoRef.catalog && !exoRef.loading) {
        exoRef.loading = true;
        exoToggle.setLoading(true);
        const { catalog, count } = await loadExoplanets(aladin);
        exoRef.catalog = catalog;
        exoRef.loading = false;
        exoToggle.setLoading(false);
        if (count > 0) exoToggle.setCount(count.toLocaleString());
        setCatalogVisible(catalog, exoToggle.isChecked());
      } else {
        setCatalogVisible(exoRef.catalog, v);
      }
    }
  });

  // ----------------------------------------------------------- Black holes ---
  addDockSection(catalogList, 'Black holes');
  // Two sources under one switch: the curated stellar-mass list (rich
  // physics-driven renders, literature citations) plus a live SIMBAD layer
  // of everything catalogued as a (candidate) black hole, so the toggle
  // genuinely means "all known".
  const stellarRef = { loading: false };
  let simbadBhCat = null;
  const stellarToggle = addToggle(catalogList, {
    label: 'Black holes', color: '#ff9f0a', checked: false,
    onToggle: (v) => {
      if (v && !stellarRef.catalog && !stellarRef.loading) {
        stellarRef.loading = true;
        stellarToggle.setLoading(true);
        loadStellarBlackHoles(aladin).then(({ catalog, count }) => {
          stellarRef.catalog = catalog;
          stellarRef.loading = false;
          stellarToggle.setLoading(false);
          if (count) stellarToggle.setCount(count);
          setCatalogVisible(catalog, stellarToggle.isChecked());
        });
      } else {
        setCatalogVisible(stellarRef.catalog, v);
      }
      if (v && !simbadBhCat) {
        simbadBhCat = initSimbadBlackHolesLayer(aladin, onZoom, onPosition);
      } else {
        simbadBhCat?.dsaSetEnabled?.(v); // stop/restart live SIMBAD queries
        setCatalogVisible(simbadBhCat, v);
      }
    }
  });

  const flagshipRef = { loading: false };
  const flagshipToggle = addToggle(catalogList, {
    label: 'Supermassive', color: '#ffd60a', checked: false,
    onToggle: (v) => {
      if (v && !flagshipRef.catalog && !flagshipRef.loading) {
        flagshipRef.loading = true;
        flagshipToggle.setLoading(true);
        loadFlagshipSupermassive(aladin).then(({ catalog, count }) => {
          flagshipRef.catalog = catalog;
          flagshipRef.loading = false;
          flagshipToggle.setLoading(false);
          if (count) flagshipToggle.setCount(count);
          setCatalogVisible(catalog, flagshipToggle.isChecked());
        });
      } else {
        setCatalogVisible(flagshipRef.catalog, v);
      }
    }
  });

  let milliquasCat = null;
  addToggle(catalogList, {
    label: 'AGN & quasars', color: '#ff453a', checked: false,
    onToggle: (v) => {
      if (v && !milliquasCat) {
        milliquasCat = initMilliquasLayer(aladin, onZoom, onPosition);
      } else {
        milliquasCat?.dsaSetEnabled?.(v); // stop/restart live VizieR queries
        setCatalogVisible(milliquasCat, v);
      }
    }
  });

  // -------------------------------------------------------------- Universe ---
  addDockSection(catalogList, 'Universe');
  // The DESI cosmic web: a full 3-D MODE, not a sky overlay — flipping it
  // hands the viewport to js/cosmos3d.js (lazy: module + ~3 MB dataset load
  // on first flip only). persist:false on purpose: a takeover view must
  // never auto-start a session.
  const cosmosToggle = addToggle(catalogList, {
    label: 'Cosmic web 3-D', color: '#5e5ce6', checked: false, persist: false,
    onToggle: async (v) => {
      cosmosToggle.setLoading(true);
      try {
        const { setCosmicWeb } = await import('./cosmos3d.js');
        const ok = await setCosmicWeb(v, { onExit: () => cosmosToggle.setChecked(false) });
        if (v && !ok) cosmosToggle.setChecked(false);
      } catch (err) {
        cosmosToggle.setChecked(false);
      } finally {
        cosmosToggle.setLoading(false);
      }
    }
  });

  // -------------------------------------------------------------- Display ---
  addDockSection(catalogList, 'Display');
  // Animations: ON by default for everybody (see js/motion.js for why the
  // OS reduce-motion flag is deliberately not the default). This one switch
  // governs EVERYTHING — flights, layer fades, constellation reveals,
  // and all CSS animation (via body.reduce-motion).
  addToggle(catalogList, {
    label: 'Animations', color: '#bf5af2', checked: motionOK(), persist: false,
    onToggle: (v) => setAnimationsEnabled(v)
  });
  // Star bloom: synthetic glows over the blotchy saturated plate cores of
  // bright stars (the one artifact the imagery itself can't fix — see the
  // About panel). On by default because it's what most people expect stars
  // to look like; a checkbox because it retouches the view, and switching
  // back to the raw observations must stay one tap away.
  const bloomRef = { ctl: null, busy: false };
  const bloomToggle = addToggle(catalogList, {
    label: 'Clean bright stars', color: '#fff2b0', checked: true, sub: true,
    onToggle: async (v) => {
      if (v && !bloomRef.ctl && !bloomRef.busy) {
        bloomRef.busy = true;
        bloomToggle.setLoading(true);
        try { bloomRef.ctl = await initStarBloom(aladin); } catch (err) { /* data missing */ }
        bloomRef.busy = false;
        bloomToggle.setLoading(false);
        if (!bloomRef.ctl) { bloomToggle.setChecked(false); return; }
      }
      if (!bloomRef.ctl) return;
      if (bloomToggle.isChecked()) bloomRef.ctl.show(); else bloomRef.ctl.hide();
    }
  });
  // Sound effects: the synthesized audio responses on flights, fades,
  // toggles and panels (js/sound.js). All on-device, nothing fetched.
  const sfxToggle = addToggle(catalogList, {
    label: 'Sound effects', color: '#64d2ff', checked: true, sub: true,
    onToggle: (v) => setSfxEnabled(v)
  });
  setSfxEnabled(sfxToggle.isChecked()); // saved OFF never boot-fires: sync explicitly

  return { onTrackingStart };
}
