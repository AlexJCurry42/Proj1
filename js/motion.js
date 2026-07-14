// Pocket Planetarium — the animations switch. One shared answer to "should
// this animate?" for every module (flights, fades, reveals, warp, CSS).
//
// Default: follow the OS. But desktops very commonly report
// prefers-reduced-motion: reduce without the user ever choosing it (Windows
// 11 frequently ships with "Animation effects" off; macOS Reduce Motion),
// which used to silently freeze every animation in the app. The Animations
// toggle in the layer dock stores an explicit user choice that overrides
// the OS signal in BOTH directions — off on a flashy phone, or on for a
// desktop whose OS flag the user never asked for.
//
// CSS side: initMotion() mirrors the effective state onto
// <body class="reduce-motion">, which a single global rule uses to shorten
// every animation/transition to nothing (see style.css).

import { readPref, writePref } from './prefs.js';

const mq = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

let override = readPref('animations', null); // true/false = user choice; null = follow the OS

export function motionOK() {
  if (override === true) return true;
  if (override === false) return false;
  return !(mq && mq.matches);
}

export function setAnimationsEnabled(v) {
  override = v === null ? null : !!v;
  writePref('animations', override);
  apply();
}

function apply() {
  try { document.body.classList.toggle('reduce-motion', !motionOK()); } catch (err) { /* pre-DOM */ }
}

export function initMotion() {
  apply();
  // OS setting flipped while the app is open (only matters with no override).
  mq?.addEventListener?.('change', apply);
}
