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

// --- Task 6: R3-R6, confidence, guard G1 ---
const club = (id, org, over = {}) => makeItem({ id, org, role: 'club', ...over });
const league = (id, over = {}) => makeItem({ id, org: 'league', role: 'league', ...over });
const press = (id, over = {}) => makeItem({ id, tier: 'press', role: 'press', org: null, ...over });
const officialUnreadable = { evidenceId: 'lost', source: { tier: 'official', role: 'club', org: 'club:x', label: 'X (club, verified)' }, reason: 'llm down' };

test('R5 change recommended: three organisations agree and differ from the feed (fx-2201 shape)', () => {
  const fixture = makeFixture({ kickoff_utc: '2026-06-20T20:00:00Z' });
  const utc = '2026-06-20T22:00:00Z';
  const d = run(fixture, [club('a', 'club:harbourcity', { utc }), club('b', 'club:redvaleunited', { utc }), league('c', { utc })]);
  assert.deepEqual([d.verdict, d.rule, d.suggestedUtc, d.confidence], ['change_recommended', 'R5', utc, 'high']);
  assert.equal(d.evidenceUsed.length, 3);
});

test('R5 confirmed: two organisations agree with the feed (fx-2202 shape)', () => {
  const utc = '2026-06-21T01:00:00Z';
  const d = run(makeFixture({ kickoff_utc: utc }), [club('a', 'club:summitrovers', { utc }), club('b', 'club:pacificcrown', { utc })]);
  assert.deepEqual([d.verdict, d.rule, d.suggestedUtc, d.confidence], ['confirmed', 'R5', null, 'high']);
});

test('R3: a later post from the same organisation supersedes its earlier one; ScoreFeed is ignored (fx-2204 shape)', () => {
  const fixture = makeFixture({ kickoff_utc: '2026-06-24T00:00:00Z' });
  const d = run(fixture, [
    club('early', 'club:prairieunion', { at: '2026-06-08T16:00:00Z', utc: '2026-06-23T22:00:00Z' }),
    club('late', 'club:prairieunion', { at: '2026-06-14T19:30:00Z', utc: '2026-06-24T00:30:00Z' }),
    makeItem({ id: 'sf', tier: 'aggregator', role: 'aggregator', org: null, at: '2026-06-16T05:00:00Z', utc: '2026-06-23T22:00:00Z' }),
  ]);
  assert.deepEqual([d.verdict, d.suggestedUtc, d.confidence], ['change_recommended', '2026-06-24T00:30:00Z', 'medium']);
  assert.match(d.evidenceNotUsed.find((l) => l.evidenceId === 'early').note, /superseded/i);
  assert.ok(d.evidenceNotUsed.some((l) => l.evidenceId === 'sf'));
  assert.deepEqual(d.evidenceUsed.map((l) => l.evidenceId), ['late']);
});

test('a club account and its own site count as one organisation (fx-2207 shape)', () => {
  const fixture = makeFixture({ kickoff_utc: '2026-06-26T22:00:00Z' });
  const utc = '2026-06-26T23:00:00Z';
  const d = run(fixture, [club('tweet', 'club:redvaleunited', { utc }), makeItem({ id: 'site', org: 'club:redvaleunited', role: 'club_site', utc })]);
  assert.deepEqual([d.verdict, d.confidence], ['change_recommended', 'medium']);
  assert.deepEqual(d.evidenceUsed.map((l) => l.evidenceId).sort(), ['site', 'tweet']);
});

test('press agreeing raises confidence to high; press disagreeing does not (fx-2209 shape)', () => {
  const agree = run(makeFixture(), [club('a', 'club:cactusathletic'), press('p', { utc: '2026-07-01T02:00:00Z' })]);
  assert.equal(agree.confidence, 'high');
  assert.ok(agree.evidenceUsed.some((l) => l.evidenceId === 'p'));
  const differ = run(makeFixture(), [club('a', 'club:cactusathletic'), press('p', { utc: '2026-07-01T03:00:00Z' })]);
  assert.equal(differ.confidence, 'medium');
  assert.ok(differ.evidenceNotUsed.some((l) => l.evidenceId === 'p'));
});

test('R4: club and league disagree, the later value is suggested (fx-2205 shape)', () => {
  const fixture = makeFixture({ kickoff_utc: '2026-06-28T01:00:00Z' });
  const d = run(fixture, [
    club('club', 'club:pacificcrown', { at: '2026-06-15T21:20:00Z', utc: '2026-06-28T01:00:00Z' }),
    league('league', { at: '2026-06-16T17:45:00Z', utc: '2026-06-28T01:30:00Z' }),
  ]);
  assert.deepEqual([d.verdict, d.rule, d.suggestedUtc, d.confidence], ['needs_review', 'R4', '2026-06-28T01:30:00Z', null]);
  const reversed = run(fixture, [
    club('club', 'club:pacificcrown', { at: '2026-06-17T21:20:00Z', utc: '2026-06-28T01:00:00Z' }),
    league('league', { at: '2026-06-16T17:45:00Z', utc: '2026-06-28T01:30:00Z' }),
  ]);
  assert.equal(reversed.suggestedUtc, '2026-06-28T01:00:00Z');
});

test('R6: a decisive claim with a different weekday needs review', () => {
  const d = run(makeFixture(), [club('a', 'club:cactusathletic', { dateCheck: 'mismatch' })]);
  assert.deepEqual([d.verdict, d.rule, d.suggestedUtc], ['needs_review', 'R6', '2026-07-01T02:00:00Z']);
});

test('week-offset caveats are carried onto the decision', () => {
  const d = run(makeFixture(), [club('a', 'club:cactusathletic', { caveats: ['week offset noted'] })]);
  assert.deepEqual(d.caveats, ['week offset noted']);
});

test('a later official kickoff claim after a TBC notice decides the verdict', () => {
  const d = run(makeFixture(), [
    league('tbc', { at: '2026-06-09T12:00:00Z', isTbc: true, utc: null }),
    club('time', 'club:cactusathletic', { at: '2026-06-18T12:00:00Z' }),
  ]);
  assert.deepEqual([d.verdict, d.rule], ['change_recommended', 'R5']);
});

test('G1: an unreadable official item turns would-be verdicts into needs review', () => {
  const change = run(makeFixture(), [club('a', 'club:cactusathletic')], { unreadable: [officialUnreadable] });
  assert.deepEqual([change.verdict, change.rule, change.suggestedUtc, change.confidence], ['needs_review', 'G1', null, null]);
  assert.match(change.reason, /lost/);
  const none = run(makeFixture(), [], { unreadable: [officialUnreadable] });
  assert.equal(none.rule, 'G1');
  const utc = '2026-07-01T01:00:00Z';
  const confirmed = run(makeFixture({ kickoff_utc: utc }), [club('a', 'club:cactusathletic', { utc })], { unreadable: [officialUnreadable] });
  assert.equal(confirmed.rule, 'G1');
});

test('G1: an official item the model calls unclear is treated as unreadable', () => {
  const d = run(makeFixture(), [club('a', 'club:cactusathletic'), club('u', 'club:cactusathletic', { aboutFixture: 'unclear' })]);
  assert.deepEqual([d.verdict, d.rule], ['needs_review', 'G1']);
});

test('G1 is not triggered by an unreadable unofficial item', () => {
  const fan = { evidenceId: 'fan', source: { tier: 'unofficial', role: 'unofficial', org: null, label: 'fan' }, reason: 'llm down' };
  const d = run(makeFixture(), [club('a', 'club:cactusathletic')], { unreadable: [fan] });
  assert.equal(d.verdict, 'change_recommended');
});

test('the reason reads correctly for one organisation and for several', () => {
  const one = run(makeFixture(), [club('a', 'club:cactusathletic')]);
  assert.match(one.reason, /\bstates\b/);
  const utc = '2026-07-01T02:00:00Z';
  const many = run(makeFixture(), [club('a', 'club:cactusathletic', { utc }), league('b', { utc })]);
  assert.doesNotMatch(many.reason, /\bstates\b/);
  assert.match(many.reason, /\bstate\b/);
});
