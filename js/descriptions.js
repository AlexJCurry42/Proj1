// Project Planetarium — bundled two-sentence descriptions for the most
// notable catalog objects. The 75 tour destinations carry hand-written
// captions; data/descriptions.json (English Wikipedia lead extracts,
// refreshed by the data pipeline, CC BY-SA 4.0) covers the next ~1,000
// objects, so tapping around the sky reads as learning, not as a table of
// coordinates. Everything here is decoration: a missing file, a missing
// entry, or a failed fetch must never break a panel.

import { fetchJSON } from './net.js';
import { matchKeysFor } from './objnames.js';
import { findRenderFor } from './render3d.js';

let promise = null;
function load() {
  // Action-generated: the file legitimately doesn't exist until the first
  // data-refresh run after a deploy, and that must read as "no descriptions
  // yet", not as an error.
  promise ??= fetchJSON('data/descriptions.json').catch((err) => {
    // A 404 means the pipeline hasn't published the file — that's stable,
    // cache the null. A TRANSIENT failure resets so the next lookup
    // retries (net.js evicts its own cache entry for the same reason).
    if (!/^HTTP 4/.test(err?.message || '')) promise = null;
    return null;
  });
  return promise;
}

/** Look up a bundled description: { text, title, url } or null. */
export async function findDescriptionFor(name, aliases = []) {
  const data = await load();
  if (!data) return null;
  for (const key of matchKeysFor(name, aliases)) {
    // hasOwnProperty, not [key]: alias strings come from external catalogs,
    // and a name like "constructor" must miss, not walk the prototype.
    const i = Object.prototype.hasOwnProperty.call(data.index, key) ? data.index[key] : undefined;
    if (i !== undefined) {
      const [title, text] = data.articles[i];
      return { title, text, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}` };
    }
  }
  return null;
}

/** The attribution CC BY-SA requires wherever an extract is shown: a link
 *  back to the source article. */
export function descriptionCredit(d) {
  const a = document.createElement('a');
  a.className = 'obj-desc-credit';
  a.href = d.url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = 'Wikipedia · CC BY-SA 4.0';
  return a;
}

/**
 * Fill the detail panel's description slot (fire-and-forget). Objects whose
 * render entry carries a hand-written blurb keep it — the curated voice
 * wins over the encyclopedia's — so this only fills the silence.
 */
export async function attachDescription(slotEl, obj) {
  if (!slotEl) return;
  try {
    const famous = await findRenderFor(obj.name, obj.aliases, obj.typeLabel);
    if (famous?.blurb) return;
    const d = await findDescriptionFor(obj.name, obj.aliases);
    if (!d || !slotEl.isConnected) return;
    const p = document.createElement('p');
    p.className = 'obj-desc';
    p.textContent = d.text;
    slotEl.append(p, descriptionCredit(d));
    slotEl.hidden = false;
  } catch (err) { /* decoration only */ }
}
