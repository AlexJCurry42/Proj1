// Deep Sky Atlas — shared network helper: every external request gets a
// 10s timeout and a single retry, per the project's engineering standards.

const DEFAULT_TIMEOUT_MS = 10000;

export async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, attempt = 1 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (attempt < 2) return fetchText(url, { timeoutMs, attempt: attempt + 1 });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJSON(url, opts = {}) {
  const text = await fetchText(url, opts);
  return JSON.parse(text);
}
