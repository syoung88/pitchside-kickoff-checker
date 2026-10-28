import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, fetchWithRetry, normalizeEvidence, createLiveSource, createSnapshotSource } from '../src/api.js';

const resp = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => {
    if (body === undefined) throw new SyntaxError('Unexpected token');
    return body;
  },
});
const sequence = (...responses) => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push(url);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof next === 'function' ? next(url, init) : next;
  };
  return { fetchFn, calls };
};
const instant = () => {
  const delays = [];
  return { delays, sleep: async (ms) => { delays.push(ms); }, random: () => 0 };
};

test('503 then 200 returns the body after one backoff of 500ms', async () => {
  const { fetchFn, calls } = sequence(resp(503, {}), resp(200, { ok: 1 }));
  const t = instant();
  assert.deepEqual(await fetchWithRetry('http://x', {}, { fetchFn, ...t }), { ok: 1 });
  assert.equal(calls.length, 2);
  assert.deepEqual(t.delays, [500]);
});

test('backoff doubles and exhausted retries throw ApiError naming the status', async () => {
  const { fetchFn, calls } = sequence(resp(503, {}));
  const t = instant();
  await assert.rejects(fetchWithRetry('http://x', {}, { fetchFn, ...t }), (e) => e instanceof ApiError && /503/.test(e.reason));
  assert.equal(calls.length, 4);
  assert.deepEqual(t.delays, [500, 1000, 2000]);
});

test('429 honours Retry-After seconds', async () => {
  const { fetchFn } = sequence(resp(429, {}, { 'retry-after': '2' }), resp(200, { ok: 1 }));
  const t = instant();
  await fetchWithRetry('http://x', {}, { fetchFn, ...t });
  assert.deepEqual(t.delays, [2000]);
});

test('a hanging call times out and is retried', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const { fetchFn, calls } = sequence(hang, resp(200, { ok: 1 }));
  const t = instant();
  assert.deepEqual(await fetchWithRetry('http://x', {}, { fetchFn, timeoutMs: 20, ...t }), { ok: 1 });
  assert.equal(calls.length, 2);
});

test('a call that always hangs fails with a timeout reason', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const { fetchFn } = sequence(hang);
  await assert.rejects(fetchWithRetry('http://x', {}, { fetchFn, timeoutMs: 10, retries: 1, ...instant() }), (e) => /timeout/i.test(e.reason));
});

test('a network error is retried', async () => {
  const { fetchFn, calls } = sequence(() => { throw new TypeError('fetch failed'); }, resp(200, { ok: 1 }));
  assert.deepEqual(await fetchWithRetry('http://x', {}, { fetchFn, ...instant() }), { ok: 1 });
  assert.equal(calls.length, 2);
});

test('404 is not retried', async () => {
  const { fetchFn, calls } = sequence(resp(404, {}));
  await assert.rejects(fetchWithRetry('http://x', {}, { fetchFn, ...instant() }), (e) => /404/.test(e.reason));
  assert.equal(calls.length, 1);
});

test('200 with invalid JSON throws a malformed error without retrying', async () => {
  const { fetchFn, calls } = sequence(resp(200, undefined));
  await assert.rejects(fetchWithRetry('http://x', {}, { fetchFn, ...instant() }), (e) => /malformed/i.test(e.reason));
  assert.equal(calls.length, 1);
});

test('normalizeEvidence keeps valid items and reports skipped ones with reasons', () => {
  const good = { id: 'a', type: 'feed_listing', provider: 'ScoreFeed', retrieved_at: '2026-06-16T05:00:00Z', fixture_name: 'x', listed_kickoff_utc: '2026-06-23T22:00:00Z' };
  const noId = { type: 'social_post', account: { handle: '@x' }, posted_at: '2026-06-16T05:00:00Z', text: 't' };
  const video = { id: 'v', type: 'video' };
  const noText = { id: 't', type: 'social_post', account: { handle: '@x' }, posted_at: '2026-06-16T05:00:00Z' };
  const { items, skipped } = normalizeEvidence({ fixture_id: 'fx-1', evidence: [good, noId, video, noText, null] });
  assert.deepEqual(items.map((i) => i.id), ['a']);
  assert.equal(skipped.length, 4);
  assert.ok(skipped.every((s) => s.reason.length > 0));
  assert.match(skipped.find((s) => s.evidenceId === 'v').reason, /unsupported/i);
});

test('normalizeEvidence rejects a response without an evidence array', () => {
  assert.throws(() => normalizeEvidence({}), ApiError);
  assert.throws(() => normalizeEvidence({ evidence: null }), ApiError);
  assert.deepEqual(normalizeEvidence({ evidence: [] }), { items: [], skipped: [] });
});

test('snapshot source reads the saved API responses', async () => {
  const source = createSnapshotSource('data/snapshot');
  assert.equal(source.kind, 'offline-snapshot');
  assert.equal((await source.listFixtures()).length, 9);
  assert.equal((await source.getEvidence('fx-2201')).items.length, 3);
  await assert.rejects(source.getEvidence('fx-0000'), ApiError);
});

test('live source requests the fixtures and evidence URLs', async () => {
  const { fetchFn, calls } = sequence(resp(200, { fixtures: [{ id: 'fx-1' }] }), resp(200, { fixture_id: 'fx-1', evidence: [] }));
  const source = createLiveSource({ apiBase: 'http://h/api' }, fetchFn);
  assert.equal(source.kind, 'live');
  assert.deepEqual(await source.listFixtures(), [{ id: 'fx-1' }]);
  assert.deepEqual(await source.getEvidence('fx-1'), { items: [], skipped: [] });
  assert.deepEqual(calls, ['http://h/api/fixtures', 'http://h/api/fixtures/fx-1/evidence']);
});

test('live source rejects a fixtures response without a fixtures array', async () => {
  const { fetchFn } = sequence(resp(200, { nope: true }));
  await assert.rejects(createLiveSource({ apiBase: 'http://h' }, fetchFn).listFixtures(), ApiError);
});

test('evidence with an unparseable timestamp is skipped', () => {
  const bad = { id: 'b', type: 'web_page', url: 'u', title: 't', snippet: 's', fetched_at: 'yesterday-ish' };
  const { items, skipped } = normalizeEvidence({ evidence: [bad] });
  assert.equal(items.length, 0);
  assert.match(skipped[0].reason, /timestamp/);
});

test('a huge Retry-After is capped', async () => {
  const { fetchFn } = sequence(resp(429, {}, { 'retry-after': '3600' }), resp(200, { ok: 1 }));
  const t = instant();
  await fetchWithRetry('http://x', {}, { fetchFn, ...t });
  assert.deepEqual(t.delays, [30000]);
});
