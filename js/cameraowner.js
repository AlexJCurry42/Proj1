// Project Planetarium — the single "who owns the view" arbiter.
//
// Three features take over the camera or the whole viewport and each drives
// its own per-frame loop: Sky Now gyro tracking (js/skynow.js), time-lapse
// playback (js/timeui.js + js/timesky.js), and the Cosmic Web 3-D mode
// (js/cosmos3d.js). Left uncoordinated they stack — two loops fight over
// gotoRaDec, the clock ticks invisibly under the 3-D takeover, gyro tracking
// keeps running with no way to stop it. This module makes ownership mutually
// exclusive: acquiring the view evicts whoever held it before.
//
// Deliberately DOM-free and engine-free so the invariant is unit-testable.

let owner = null;      // { name, onEvict } or null
let evicting = false;  // re-entrancy guard: an onEvict that re-acquires must not recurse

/**
 * Claim the view for `name`. If someone else holds it, their `onEvict` runs
 * first (so they can stop their loop / release their lock cleanly). Calling
 * acquire for the CURRENT owner is a no-op that just refreshes its evictor.
 * onEvict must be idempotent and must NOT itself call acquire for a third
 * party (it may call release()).
 */
export function acquireView(name, onEvict) {
  if (owner && owner.name === name) { owner.onEvict = onEvict; return; }
  if (owner && !evicting) {
    evicting = true;
    const prev = owner;
    owner = null;
    try { prev.onEvict?.(); } catch (err) { /* a bad evictor must not block the new owner */ }
    evicting = false;
  }
  owner = { name, onEvict };
}

/** Release the view if `name` currently holds it (idempotent; a stale
 *  release from an already-evicted owner is ignored). */
export function releaseView(name) {
  if (owner && owner.name === name) owner = null;
}

/** The current owner's name, or null. (Diagnostics / tests.) */
export function viewOwner() { return owner ? owner.name : null; }
