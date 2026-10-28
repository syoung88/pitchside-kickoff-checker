import { readFile } from 'node:fs/promises';

export class ApiError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ApiError';
    this.reason = reason;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GET/POST JSON with a per-attempt timeout; retries network errors, timeouts, 5xx and 429 with backoff.
export async function fetchWithRetry(url, init = {}, opts = {}) {
  const { fetchFn = fetch, timeoutMs = 8000, retries = 3, sleep = wait, random = Math.random } = opts;
  let lastReason = 'unknown failure';
  for (let attempt = 0; attempt <= retries; attempt++) {
    let retryAfterMs = null;
    try {
      const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        try {
          return await res.json();
        } catch {
          throw new ApiError('malformed JSON response');
        }
      }
      if (res.status !== 429 && res.status < 500) throw new ApiError(`HTTP ${res.status}`);
      lastReason = `HTTP ${res.status}`;
      const seconds = Number(res.headers?.get('retry-after'));
      if (Number.isFinite(seconds) && seconds > 0) retryAfterMs = seconds * 1000;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      lastReason = err?.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : `network error: ${err?.message ?? err}`;
    }
    if (attempt < retries) await sleep(retryAfterMs ?? 500 * 2 ** attempt + random() * 250);
  }
  throw new ApiError(`${lastReason} after ${retries + 1} attempts`);
}

const REQUIRED = {
  social_post: ['account', 'text', 'posted_at'],
  web_page: ['snippet', 'fetched_at'],
  feed_listing: ['listed_kickoff_utc', 'retrieved_at'],
};

export function normalizeEvidence(raw) {
  if (!raw || !Array.isArray(raw.evidence)) throw new ApiError('malformed evidence response');
  const items = [];
  const skipped = [];
  for (const e of raw.evidence) {
    const evidenceId = typeof e?.id === 'string' && e.id ? e.id : null;
    if (!e || typeof e !== 'object') skipped.push({ evidenceId: null, reason: 'not an object' });
    else if (!evidenceId) skipped.push({ evidenceId: null, reason: 'missing id' });
    else if (!REQUIRED[e.type]) skipped.push({ evidenceId, reason: `unsupported type "${e.type}"` });
    else {
      const missing = REQUIRED[e.type].filter((field) => !e[field]);
      if (missing.length > 0) skipped.push({ evidenceId, reason: `missing ${missing.join(', ')}` });
      else items.push(e);
    }
  }
  return { items, skipped };
}

function fixturesFrom(data) {
  if (!data || !Array.isArray(data.fixtures)) throw new ApiError('malformed fixtures response');
  return data.fixtures;
}

export function createLiveSource(config, fetchFn = fetch) {
  const get = (path) => fetchWithRetry(`${config.apiBase}${path}`, {}, { fetchFn });
  return {
    kind: 'live',
    listFixtures: async () => fixturesFrom(await get('/fixtures')),
    getEvidence: async (id) => normalizeEvidence(await get(`/fixtures/${encodeURIComponent(id)}/evidence`)),
  };
}

export function createSnapshotSource(dir) {
  const read = async (name) => {
    try {
      return JSON.parse(await readFile(`${dir}/${name}`, 'utf8'));
    } catch (err) {
      throw new ApiError(`snapshot file ${name} unavailable: ${err.code ?? err.message}`);
    }
  };
  return {
    kind: 'offline-snapshot',
    listFixtures: async () => fixturesFrom(await read('fixtures.json')),
    getEvidence: async (id) => normalizeEvidence(await read(`evidence-${id}.json`)),
  };
}
