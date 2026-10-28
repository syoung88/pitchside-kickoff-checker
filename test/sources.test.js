import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifySource } from '../src/sources.js';

const dir = new URL('../data/snapshot/', import.meta.url);
const fixtures = JSON.parse(readFileSync(new URL('fixtures.json', dir))).fixtures;
const fx = (id) => fixtures.find((f) => f.id === id);
const ev = (fixtureId, evidenceId) =>
  JSON.parse(readFileSync(new URL(`evidence-${fixtureId}.json`, dir))).evidence.find((e) => e.id === evidenceId);
const classify = (fixtureId, evidenceId) => classifySource(ev(fixtureId, evidenceId), fx(fixtureId));

test('verified club account of a participating team is official club', () => {
  const s = classify('fx-2201', 'ev-2201-a');
  assert.deepEqual([s.tier, s.role, s.org], ['official', 'club', 'club:harbourcity']);
  assert.equal(s.label, 'Harbour City FC (club, verified)');
});

test('league site is recognised by the page title', () => {
  const s = classify('fx-2201', 'ev-2201-c');
  assert.deepEqual([s.tier, s.role, s.org], ['official', 'league', 'league']);
});

test('league social account is recognised by display name', () => {
  const s = classify('fx-2205', 'ev-2205-b');
  assert.deepEqual([s.tier, s.role, s.org], ['official', 'league', 'league']);
});

test('away club account with a suffix in its name still matches', () => {
  assert.equal(classify('fx-2202', 'ev-2202-d').org, 'club:pacificcrown');
});

test('a club account and its own website are one organisation', () => {
  const account = classify('fx-2207', 'ev-2207-a');
  const site = classify('fx-2207', 'ev-2207-b');
  assert.equal(account.role, 'club');
  assert.equal(site.role, 'club_site');
  assert.equal(account.org, site.org);
  assert.equal(account.org, 'club:redvaleunited');
});

test('ScoreFeed is an aggregator', () => {
  const s = classify('fx-2204', 'ev-2204-c');
  assert.deepEqual([s.tier, s.role, s.org], ['aggregator', 'aggregator', null]);
});

test('unverified accounts are unofficial; other websites are press', () => {
  assert.equal(classify('fx-2206', 'ev-2206-a').tier, 'unofficial');
  assert.deepEqual([classify('fx-2206', 'ev-2206-b').tier, classify('fx-2202', 'ev-2202-c').tier], ['press', 'press']);
});

test('a verified club that is not playing in the fixture is only press', () => {
  const s = classifySource(ev('fx-2207', 'ev-2207-c'), fx('fx-2204'));
  assert.deepEqual([s.tier, s.role], ['press', 'press']);
});

test('a verified unaffiliated account is press', () => {
  const evidence = { id: 'x', type: 'social_post', account: { handle: '@RandomPundit', display_name: 'Random Pundit', verified: true }, text: 't', posted_at: '2026-06-15T00:00:00Z' };
  assert.equal(classifySource(evidence, fx('fx-2201')).tier, 'press');
});

test('a press page that merely mentions the competition is not the league site', () => {
  const evidence = { id: 'y', type: 'web_page', url: 'https://www.scorelines-weekly.com/a', title: 'Preview of the Continental Soccer League weekend', snippet: 's', fetched_at: '2026-06-15T00:00:00Z' };
  assert.equal(classifySource(evidence, fx('fx-2201')).tier, 'press');
});
