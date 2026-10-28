import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hoursToKickoff, urgencyBand, rankResults } from '../src/rank.js';
import { makeFixture } from './helpers.js';

const AS_OF = '2026-06-20T08:25:00Z';
const res = (id, verdict, kickoff, suggested = null, confidence = null) => ({
  fixture: makeFixture({ id, kickoff_utc: kickoff }),
  status: 'checked',
  decision: { verdict, suggestedUtc: suggested, confidence },
  reason: null,
});

const nine = () => [
  res('fx-2201', 'change_recommended', '2026-06-20T20:00:00Z', '2026-06-20T22:00:00Z', 'high'),
  res('fx-2202', 'confirmed', '2026-06-21T01:00:00Z', null, 'high'),
  res('fx-2203', 'out_of_scope', '2026-06-22T23:00:00Z'),
  res('fx-2204', 'change_recommended', '2026-06-24T00:00:00Z', '2026-06-24T00:30:00Z', 'medium'),
  res('fx-2205', 'needs_review', '2026-06-28T01:00:00Z', '2026-06-28T01:30:00Z'),
  res('fx-2206', 'insufficient_evidence', '2026-06-25T23:00:00Z'),
  res('fx-2207', 'change_recommended', '2026-06-26T22:00:00Z', '2026-06-26T23:00:00Z', 'medium'),
  res('fx-2209', 'change_recommended', '2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', 'high'),
  res('fx-2208', 'needs_review', '2026-06-27T02:00:00Z'),
];

test('hoursToKickoff uses the earlier of feed and suggested time', () => {
  const h = hoursToKickoff({ feedUtc: '2026-06-20T20:00:00Z', suggestedUtc: '2026-06-20T22:00:00Z', asOf: AS_OF });
  assert.ok(Math.abs(h - 11.58) < 0.01, String(h));
  const earlier = hoursToKickoff({ feedUtc: '2026-06-20T20:00:00Z', suggestedUtc: '2026-06-20T18:25:00Z', asOf: AS_OF });
  assert.ok(Math.abs(earlier - 10) < 0.01, String(earlier));
  assert.ok(Math.abs(hoursToKickoff({ feedUtc: '2026-06-20T20:00:00Z', suggestedUtc: null, asOf: AS_OF }) - 11.58) < 0.01);
});

test('urgencyBand boundaries', () => {
  assert.equal(urgencyBand(23.9), 'critical');
  assert.equal(urgencyBand(24), 'soon');
  assert.equal(urgencyBand(71.9), 'soon');
  assert.equal(urgencyBand(72), 'later');
  assert.equal(urgencyBand(-1), 'past');
});

test('the nine sample results rank in the spec order, whatever order the API returned them', () => {
  const { actionable, others } = rankResults(nine(), AS_OF);
  assert.deepEqual(actionable.map((r) => r.result.fixture.id), ['fx-2201', 'fx-2204', 'fx-2207', 'fx-2208', 'fx-2205', 'fx-2209']);
  assert.deepEqual(actionable.map((r) => r.beyondGuide), [false, false, false, false, false, true]);
  assert.equal(actionable[0].band, 'critical');
  assert.deepEqual(others.map((r) => r.fixture.id), ['fx-2202', 'fx-2203', 'fx-2206']);
});

test('ties: needs review first, then higher confidence, then fixture id', () => {
  const k = '2026-06-26T22:00:00Z';
  const { actionable } = rankResults([
    res('fx-3', 'change_recommended', k, null, 'medium'),
    res('fx-2', 'change_recommended', k, null, 'high'),
    res('fx-4', 'needs_review', k),
    res('fx-1', 'change_recommended', k, null, 'high'),
  ], AS_OF);
  assert.deepEqual(actionable.map((r) => r.result.fixture.id), ['fx-4', 'fx-1', 'fx-2', 'fx-3']);
});

test('a fixture that has already kicked off is listed as past, not actionable', () => {
  const { actionable, past } = rankResults([res('fx-1', 'change_recommended', '2026-06-19T20:00:00Z', null, 'high')], AS_OF);
  assert.equal(actionable.length, 0);
  assert.equal(past.length, 1);
  assert.equal(past[0].band, 'past');
});

test('could-not-check results go to others', () => {
  const failed = { fixture: makeFixture({ id: 'fx-9' }), status: 'could_not_check', decision: null, reason: 'API unavailable (503)' };
  const { actionable, others } = rankResults([failed], AS_OF);
  assert.equal(actionable.length, 0);
  assert.deepEqual(others.map((r) => r.fixture.id), ['fx-9']);
});

test('a feed time that has passed but a suggested time still ahead is urgent, not past', () => {
  const r = res('fx-1', 'change_recommended', '2026-06-20T19:00:00Z', '2026-06-20T22:00:00Z', 'high');
  const { actionable, past } = rankResults([r], '2026-06-20T20:00:00Z');
  assert.equal(past.length, 0);
  assert.equal(actionable[0].hours, 0);
  assert.equal(actionable[0].band, 'critical');
  assert.equal(hoursToKickoff({ feedUtc: '2026-06-20T19:00:00Z', suggestedUtc: '2026-06-20T18:00:00Z', asOf: '2026-06-20T20:00:00Z' }) < 0, true);
});
