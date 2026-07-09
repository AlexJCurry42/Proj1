// Deep Sky Atlas — shared network helper: every external request gets a
// 10s timeout and a single retry, per the project's engineering standards.

const DEFAULT_TIMEOUT_MS = 10000;

export async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, attempt = 1 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    // retries: 0 disables the retry for requests where a repeat would just
    // double the pain (e.g. a 90-second full-catalog download).
    if (attempt <= retries) return fetchText(url, { timeoutMs, retries, attempt: attempt + 1 });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJSON(url, opts = {}) {
  const text = await fetchText(url, opts);
  return JSON.parse(text);
}
