import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkFixture, mapLimit, runAll } from '../src/pipeline.js';
import { ApiError } from '../src/api.js';

const snapshot = new URL('../data/snapshot/', import.meta.url);
const fixtures = JSON.parse(readFileSync(new URL('fixtures.json', snapshot))).fixtures;
const fx = (id, over = {}) => ({ ...fixtures.find((f) => f.id === id), ...over });

const clubPost = (id = 'e1', over = {}) => ({
  id, type: 'social_post', platform: 'twitter', likes: 1,
  account: { handle: '@HarbourCityFC', display_name: 'Harbour City FC', verified: true },
  posted_at: '2026-06-15T15:02:00Z', text: 'Saturday kickoff now 6:00 PM ET', ...over,
});
const fanPost = (id = 'fan') => ({
  id, type: 'social_post', platform: 'twitter', likes: 1,
  account: { handle: '@fan', display_name: 'A Fan', verified: false },
  posted_at: '2026-06-16T09:00:00Z', text: 'FANPOST maybe 8pm???',
});
const listing = (id = 'sf') => ({
  id, type: 'feed_listing', provider: 'ScoreFeed', retrieved_at: '2026-06-16T05:00:00Z',
  fixture_name: 'Harbour City FC vs Red Vale United', listed_kickoff_utc: '2026-06-20T20:00:00Z',
});

const claimJson = (quote, time = '18:00') => JSON.stringify({
  about_this_fixture: 'yes', kickoff_time_24h: time, timezone_stated: 'ET', date_text: 'Saturday',
  is_postponement_or_cancellation: false, is_rumour_or_unconfirmed: false, is_tbc: false, quote, ignored_times: [],
});
const llm = (failOn = []) => ({
  complete: async (system, user) => {
    if (failOn.some((marker) => user.includes(marker))) throw new Error('llm down');
    if (user.includes('FANPOST')) return claimJson('maybe 8pm', '20:00');
    return claimJson('6:00 PM ET');
  },
});
const sourceOf = (evidenceById) => ({
  kind: 'live',
  listFixtures: async () => Object.keys(evidenceById).map((id) => fx(id)),
  getEvidence: async (id) => {
    const v = evidenceById[id];
    if (v instanceof Error) throw v;
    return { items: v, skipped: [] };
  },
});
const deps = (source, model = 'm', l = llm()) => ({ source, llm: l, cache: null, model });

test('a non-scheduled fixture is out of scope and its evidence is never fetched', async () => {
  let fetched = 0;
  const source = { kind: 'live', getEvidence: async () => { fetched++; return { items: [], skipped: [] }; } };
  for (const status of ['cancelled', 'postponed', 'live']) {
    const r = await checkFixture(fx('fx-2201', { status }), deps(source));
    assert.equal(r.status, 'checked');
    assert.equal(r.decision.verdict, 'out_of_scope');
  }
  assert.equal(fetched, 0);
});

test('an official club post is classified, extracted, resolved and decided', async () => {
  const r = await checkFixture(fx('fx-2201'), deps(sourceOf({ 'fx-2201': [clubPost(), listing()] })));
  assert.equal(r.status, 'checked');
  assert.equal(r.decision.verdict, 'change_recommended');
  assert.equal(r.decision.suggestedUtc, '2026-06-20T22:00:00Z');
  assert.equal(r.decision.evidenceNotUsed.find((l) => l.evidenceId === 'sf').note.includes('ScoreFeed'), true);
});

test('empty evidence is insufficient evidence', async () => {
  const r = await checkFixture(fx('fx-2201'), deps(sourceOf({ 'fx-2201': [] })));
  assert.equal(r.decision.verdict, 'insufficient_evidence');
});

test('ScoreFeed listings need no LLM', async () => {
  const r = await checkFixture(fx('fx-2201'), deps(sourceOf({ 'fx-2201': [listing()] }), 'm', null));
  assert.equal(r.status, 'checked');
  assert.equal(r.decision.verdict, 'insufficient_evidence');
});

test('an evidence fetch failure marks only that fixture could-not-check', async () => {
  const source = sourceOf({ 'fx-2201': [clubPost()], 'fx-2202': new ApiError('HTTP 503 after 4 attempts') });
  const { results } = await runAll({ ...deps(source), concurrency: 3 });
  assert.deepEqual(results.map((r) => r.status), ['checked', 'could_not_check']);
  assert.match(results[1].reason, /API unavailable.*503/);
  assert.equal(results[1].decision, null);
});

test('an LLM failure on an official post forces needs review (G1)', async () => {
  const r = await checkFixture(fx('fx-2201'), deps(sourceOf({ 'fx-2201': [clubPost('e1', { text: 'Saturday kickoff now 6:00 PM ET' })] }), 'm', llm(['kickoff now'])));
  assert.deepEqual([r.decision.verdict, r.decision.rule], ['needs_review', 'G1']);
});

test('an LLM failure on a fan post leaves the verdict unchanged', async () => {
  const r = await checkFixture(fx('fx-2201'), deps(sourceOf({ 'fx-2201': [clubPost(), fanPost()] }), 'm', llm(['FANPOST'])));
  assert.equal(r.decision.verdict, 'change_recommended');
  assert.match(r.decision.evidenceNotUsed.find((l) => l.evidenceId === 'fan').note, /could not be read/);
});

test('unexpected bad data in one fixture becomes could-not-check, not a crash', async () => {
  const broken = fx('fx-2201');
  delete broken.venue;
  const r = await checkFixture(broken, deps(sourceOf({ 'fx-2201': [clubPost()] })));
  assert.equal(r.status, 'could_not_check');
  assert.match(r.reason, /unexpected/i);
});

test('mapLimit never exceeds the limit and keeps input order', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([...Array(8).keys()], 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5 * ((n % 3) + 1)));
    inFlight--;
    return n * 2;
  });
  assert.deepEqual(out, [0, 2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
});

test('runAll reports the latest evidence timestamp across all fixtures', async () => {
  const source = sourceOf({ 'fx-2201': [clubPost(), listing()], 'fx-2202': [] });
  const out = await runAll({ ...deps(source), concurrency: 3 });
  assert.equal(out.latestEvidenceAt, '2026-06-16T05:00:00Z');
  assert.equal(out.sourceKind, 'live');
  assert.equal(out.results.length, 2);
});
