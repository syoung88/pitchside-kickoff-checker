import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/decide.js';
import { makeFixture, makeItem } from './helpers.js';

const run = (fixture, items = [], extra = {}) => decide({ fixture, items, unreadable: [], skipped: [], ...extra });

test('R1: any status other than scheduled is out of scope with no time and no evidence lines', () => {
  for (const status of ['postponed', 'cancelled', 'live']) {
    const d = run(makeFixture({ status }), [makeItem({ id: 'a' })]);
    assert.equal(d.verdict, 'out_of_scope', status);
    assert.equal(d.rule, 'R1');
    assert.equal(d.suggestedUtc, null);
    assert.deepEqual([d.evidenceUsed, d.evidenceNotUsed], [[], []]);
    assert.match(d.reason, new RegExp(status));
  }
});

test('R2: official postponement report on a scheduled fixture needs review with no time', () => {
  const d = run(makeFixture(), [makeItem({ id: 'a', isPostponement: true, utc: null })]);
  assert.equal(d.verdict, 'needs_review');
  assert.equal(d.rule, 'R2');
  assert.equal(d.suggestedUtc, null);
  assert.deepEqual(d.evidenceUsed.map((l) => l.evidenceId), ['a']);
});

test('R7: latest official statement is a TBC notice', () => {
  const d = run(makeFixture(), [makeItem({ id: 'a', isTbc: true, utc: null, role: 'league', org: 'league' })]);
  assert.equal(d.verdict, 'needs_review');
  assert.equal(d.rule, 'R7');
  assert.equal(d.suggestedUtc, null);
});

test('R7 does not fire when a later official kickoff claim follows the TBC notice', () => {
  const d = run(makeFixture(), [
    makeItem({ id: 'tbc', at: '2026-06-09T12:00:00Z', isTbc: true, utc: null, role: 'league', org: 'league' }),
    makeItem({ id: 'time', at: '2026-06-18T12:00:00Z' }),
  ]);
  assert.notEqual(d.rule, 'R7');
});

test('R8: no evidence at all is insufficient evidence', () => {
  const d = run(makeFixture(), []);
  assert.equal(d.verdict, 'insufficient_evidence');
  assert.equal(d.rule, 'R8');
  assert.equal(d.suggestedUtc, null);
  assert.equal(d.confidence, null);
});

test('R8: unofficial, press and aggregator evidence only; ScoreFeed difference is mentioned', () => {
  const d = run(makeFixture(), [
    makeItem({ id: 'fan', tier: 'unofficial', role: 'unofficial', org: null }),
    makeItem({ id: 'press', tier: 'press', role: 'press', org: null }),
    makeItem({ id: 'sf', tier: 'aggregator', role: 'aggregator', org: null, utc: '2026-07-01T03:00:00Z' }),
  ]);
  assert.equal(d.verdict, 'insufficient_evidence');
  assert.equal(d.rule, 'R8');
  assert.equal(d.suggestedUtc, null);
  assert.match(d.reason, /ScoreFeed/);
  assert.equal(d.evidenceUsed.length, 0);
  assert.equal(d.evidenceNotUsed.length, 3);
});

test('evidence accounting: every id appears exactly once with a non-empty note', () => {
  const d = run(
    makeFixture(),
    [makeItem({ id: 'other', aboutFixture: 'no' }), makeItem({ id: 'fan', tier: 'unofficial', role: 'unofficial', org: null }),
      makeItem({ id: 'unclear', aboutFixture: 'unclear', tier: 'press', role: 'press', org: null })],
    { skipped: [{ evidenceId: 'bad', reason: 'missing text' }], unreadable: [{ evidenceId: 'gone', source: { tier: 'unofficial', role: 'unofficial', org: null, label: 'x' }, reason: 'llm down' }] },
  );
  const ids = [...d.evidenceUsed, ...d.evidenceNotUsed].map((l) => l.evidenceId).sort();
  assert.deepEqual(ids, ['bad', 'fan', 'gone', 'other', 'unclear']);
  for (const line of [...d.evidenceUsed, ...d.evidenceNotUsed]) assert.ok(line.note.length > 0, line.evidenceId);
  const note = (id) => d.evidenceNotUsed.find((l) => l.evidenceId === id).note;
  assert.match(note('other'), /different match/i);
  assert.match(note('bad'), /malformed/i);
});
