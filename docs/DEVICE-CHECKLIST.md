# Pre-release iPhone checklist (~10 minutes)

Run this on a real iPhone in Safari **before telling anyone about a
release**. It exists because every bug that actually shipped in this app's
history was iOS-only — the Range-request audio failure, the sound-unlock
gesture rules, the ignored `element.volume`, the invisible CSS filters —
and the Chromium CI suite was green through all of them. The WebKit CI job
catches engine-level differences; this list catches the device-level ones
nothing headless can see.

Items are ordered by how often their area has actually bitten.

## 1. Update path (2 min) — the #1 historical trap

- [ ] Open the site with the **previous** version still installed (don't
      clear anything). Within one reload the About panel shows the **new
      shell version** (About → "App build").
- [ ] The installed home-screen PWA also picks up the new version on launch.
- [ ] No blank screen / stuck boot bar after the update reload.

## 2. Audio (2 min) — iOS ignores `element.volume`; gestures gate playback

- [ ] Toggle a layer switch: the tick sound plays **after** your first tap
      (never before — boot must be silent).
- [ ] Sound effects checkbox off → later taps are silent.
- [ ] Easter egg (time panel → slider to ∞ → play): the track starts, at a
      comfortable loudness (the fade/level is baked into the file — if it's
      loud, the wrong file shipped), and **stops** on Back to now.
- [ ] Lock the phone mid-egg, unlock: no stuck audio.

## 3. Gestures & sheets (2 min)

- [ ] Pinch-zoom and drag feel continuous (no rubber-banding against page
      scroll; the page itself must never scroll).
- [ ] Detail panel: opens as bottom sheet, drags down to dismiss, inner
      content scrolls without dragging the sheet.
- [ ] Layer dock: opens from the pill, collapses on an outside tap AND on a
      view pan. No dock label is ellipsized (…).
- [ ] Toast and crosshair card swipe away sideways.

## 4. Visual chrome (1.5 min) — CSS filters/effects render differently on WebKit

- [ ] Made in Heaven theme (egg armed): violet chrome, button aura, clock
      hands — all visible, UI stays legible, and it fully reverts on stop.
- [ ] Red-light mode: everything readable, nothing stays white.
- [ ] Safe areas: nothing hides under the notch/home indicator, portrait
      and landscape.

## 5. Location & Sky Now (1 min)

- [ ] Fresh visit (Settings → Safari → clear site data first): **no**
      location prompt at boot; the prompt appears only after tapping
      Sky Now.
- [ ] Decline → app keeps working; Sky Now asks again politely next tap.
- [ ] Accept → horizon line + compass appear; gyro view tracks the sky
      smoothly.

## 6. Offline (1 min)

- [ ] Airplane mode → relaunch the installed PWA: the app boots to a usable
      shell (tiles may be missing; no crash, a clear offline message on
      searches).

## 7. Content spot checks (45 s)

- [ ] Tap a mid-catalog object (e.g. search "NGC 6946"): the panel shows a
      two-sentence description with a "Wikipedia · CC BY-SA 4.0" link.
- [ ] A famous object (M31) shows its photo; the crosshair card describes
      it when centered.
- [ ] Cosmic web 3-D (layer dock → Universe): the point cloud appears,
      one-finger orbit and pinch fly-through feel smooth (not slideshow),
      and "Back to the sky" returns cleanly with the switch off.

## If something fails

File it in the repo issues with the iOS version + a screen recording, fix
it, bump the shell version, and run this list again from step 1 — the
update path must be re-verified after *every* fix, because that's the step
that decides whether users actually receive the others.
