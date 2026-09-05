// Project Planetarium — shared network helper: every external request gets a
// 10s timeout and a single retry, per the project's engineering standards.

const DEFAULT_TIMEOUT_MS = 10000;

export async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, attempt = 1 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } catch (err) {
    // retries: 0 disables the retry for requests where a repeat would just
    // double the pain (e.g. a 90-second full-catalog download) — and a
    // 4xx is permanent, so retrying it is a guaranteed wasted request.
    const permanent = err.status && err.status < 500;
    if (!permanent && attempt <= retries) return fetchText(url, { timeoutMs, retries, attempt: attempt + 1 });
    // A clear offline story beats "TypeError: Failed to fetch": every
    // layer/search toast built from this message now says WHY.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new Error('you appear to be offline');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Bundled data files are immutable within a session (the service worker
// refreshes them BETWEEN sessions), yet several modules want the same file —
// tours.json and messier_ngc.json were each fetched three separate times per
// session (cool button, crosshair ID, search index...), triple-downloaded on
// a first visit and triple-parsed on every one. One shared promise per URL
// serves them all. External URLs (TAP queries, live services) are never
// cached — those must stay live. Consumers treat the shared object as
// read-only (verified: the one shuffler copies first).
const dataCache = new Map();

export function fetchJSON(url, opts = {}) {
  if (!url.startsWith('data/')) return fetchText(url, opts).then((t) => JSON.parse(t));
  let p = dataCache.get(url);
  if (!p) {
    p = fetchText(url, opts).then((t) => JSON.parse(t));
    p.catch(() => dataCache.delete(url)); // a failure must not poison later retries
    dataCache.set(url, p);
  }
  return p;
}
