// Pocket Planetarium — the animations switch. One shared answer to "should
// this animate?" for every module (flights, fades, reveals, CSS).
//
// Animations are ON by default for everybody. (An earlier build followed
// the OS prefers-reduced-motion flag by default, but many desktops report
// it without the user ever choosing to — Windows 11 commonly ships with
// "Animation effects" off — which silently froze the whole app.) The
// Animations switch in the layer dock is the one authority: flip it off
// and everything goes instant, on this device, persistently.
//
// CSS side: initMotion() mirrors the effective state onto
// <body class="reduce-motion">, which a single global rule uses to shorten
// every animation/transition to nothing (see style.css).

import { readPref, writePref } from './prefs.js';

let enabled = readPref('animations', null) !== false; // only a stored OFF disables

export function motionOK() {
  return enabled;
}

export function setAnimationsEnabled(v) {
  enabled = !!v;
  writePref('animations', enabled);
  apply();
}

function apply() {
  try { document.body.classList.toggle('reduce-motion', !enabled); } catch (err) { /* pre-DOM */ }
}

export function initMotion() {
  apply();
}
