import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReportModel, renderMarkdown, renderJson, writeReport } from '../src/report.js';

const fixtures = JSON.parse(readFileSync(new URL('../data/snapshot/fixtures.json', import.meta.url))).fixtures;
const AS_OF = '2026-06-20T08:25:00Z';
const DIVIDER = 'beyond the usual five a day, lower urgency';

const used = { evidenceId: 'ev-1', label: 'Harbour City FC (club, verified)', at: '2026-06-15T15:02:00Z', quote: 'now kicks off at 6:00 PM ET',
  working: ['"now kicks off at 6:00 PM ET" -> 18:00 America/New_York = 2026-06-20T22:00:00Z'], ignoredTimes: [], note: 'states 2026-06-20T22:00:00Z' };
const notUsed = { evidenceId: 'ev-2', label: 'Caldera FC (club, verified)', at: '2026-06-16T20:15:00Z', quote: null, working: [],
  ignoredTimes: ['gates open 5:30 PM'], note: 'about a different match' };

const res = (id, verdict, suggested = null, confidence = null, rule = 'R5') => {
  const fixture = fixtures.find((f) => f.id === id);
  return { fixture, status: 'checked', reason: null, latestEvidenceAt: null,
    decision: { verdict, rule, suggestedUtc: suggested, confidence, reason: `reason for ${id}`, evidenceUsed: [used], evidenceNotUsed: [notUsed], caveats: ['week offset noted'] } };
};
const nine = () => [
  res('fx-2201', 'change_recommended', '2026-06-20T22:00:00Z', 'high'),
  res('fx-2202', 'confirmed', null, 'high'),
  res('fx-2203', 'out_of_scope', null, null, 'R1'),
  res('fx-2204', 'change_recommended', '2026-06-24T00:30:00Z', 'medium'),
  res('fx-2205', 'needs_review', '2026-06-28T01:30:00Z', null, 'R4'),
  res('fx-2206', 'insufficient_evidence', null, null, 'R8'),
  res('fx-2207', 'change_recommended', '2026-06-26T23:00:00Z', 'medium'),
  res('fx-2209', 'change_recommended', '2026-07-01T02:00:00Z', 'high'),
  res('fx-2208', 'needs_review', null, null, 'R7'),
];
const model = (over = {}, results = nine()) => buildReportModel(results, { asOf: AS_OF, sourceKind: 'live', ...over });

test('header: tally counts actionable items against the guide of five', () => {
  const md = renderMarkdown(model());
  assert.match(md, /6 need action \(guide: 5\)/);
  assert.match(md, /1 confirmed/);
  assert.match(md, /1 insufficient evidence/);
  assert.match(md, /1 out of scope/);
  assert.match(md, /As of 2026-06-20T08:25:00Z/);
});

test('the offline banner appears only for the offline snapshot', () => {
  assert.doesNotMatch(renderMarkdown(model()), /OFFLINE SNAPSHOT/);
  assert.match(renderMarkdown(model({ sourceKind: 'offline-snapshot' })), /OFFLINE SNAPSHOT/);
});

test('each item has Evidence used, Evidence not used and Caveats blocks, with ignored times as a note', () => {
  const md = renderMarkdown(model());
  assert.match(md, /Evidence used/);
  assert.match(md, /Evidence not used/);
  assert.match(md, /Caveats/);
  assert.match(md, /gates open 5:30 PM/);
  assert.match(md, /about a different match/);
});

test('the divider appears once, between the fifth and sixth items', () => {
  const md = renderMarkdown(model());
  assert.equal(md.split(DIVIDER).length - 1, 1);
  const divider = md.indexOf(DIVIDER);
  assert.ok(md.indexOf('### 5.') < divider && divider < md.indexOf('### 6.'));
  assert.ok(md.indexOf('fx-2209') > divider);
});

test('the fx-2201 block shows UTC and venue-local times for feed and suggestion', () => {
  const md = renderMarkdown(model());
  const block = md.slice(md.indexOf('### 1.'), md.indexOf('### 2.'));
  assert.match(block, /CHANGE RECOMMENDED/);
  assert.match(block, /2026-06-20T20:00:00Z.*16:00 EDT/);
  assert.match(block, /2026-06-20T22:00:00Z.*18:00 EDT/);
  assert.match(block, /CRITICAL/);
  assert.match(block, /rule R5/);
});

test('JSON mirrors the report with snake_case evidence keys and the source kind', () => {
  const json = JSON.parse(renderJson(model({ sourceKind: 'offline-snapshot' })));
  assert.equal(json.meta.source, 'offline-snapshot');
  assert.equal(json.actionable.length, 6);
  assert.equal(json.actionable[0].fixture.id, 'fx-2201');
  assert.equal(json.actionable[0].evidence_used[0].evidence_id, 'ev-1');
  assert.deepEqual(json.actionable[0].evidence_not_used[0].ignored_times, ['gates open 5:30 PM']);
  assert.equal(json.actionable[5].beyond_guide, true);
  assert.equal(json.tally.guide, 5);
});

test('could-not-check fixtures are called out in the header and listed with their reason', () => {
  const failed = { fixture: fixtures.find((f) => f.id === 'fx-2201'), status: 'could_not_check', decision: null, reason: 'API unavailable (HTTP 503)' };
  const md = renderMarkdown(model({}, [failed]));
  assert.match(md, /Could not check 1 fixture/);
  assert.match(md, /fx-2201[^\n]*API unavailable \(HTTP 503\)/);
});

test('a fixture already kicked off is listed as past kickoff and not counted as actionable', () => {
  const md = renderMarkdown(buildReportModel(nine(), { asOf: '2026-06-20T23:00:00Z', sourceKind: 'live' }));
  assert.match(md, /past kickoff, not actionable/i);
  assert.match(md, /5 need action/);
});

test('others table gives a one-line reason for each non-actionable fixture', () => {
  const md = renderMarkdown(model());
  for (const id of ['fx-2202', 'fx-2203', 'fx-2206']) assert.match(md, new RegExp(`${id}[^\\n]*reason for ${id}`));
});

test('writeReport writes report.md and report.json', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'report-')), 'nested');
  const m = model();
  const { mdPath, jsonPath } = await writeReport(m, dir);
  assert.ok(existsSync(mdPath) && existsSync(jsonPath));
  assert.equal(readFileSync(mdPath, 'utf8'), renderMarkdown(m));
  assert.equal(readFileSync(jsonPath, 'utf8'), renderJson(m));
});

test('untrusted quotes and labels cannot add lines or headings to the report', () => {
  const r = res('fx-2201', 'change_recommended', '2026-06-20T22:00:00Z', 'high');
  r.decision.evidenceUsed = [{ ...used, label: 'Evil\n### 9. CONFIRMED', quote: 'kicks off 6 PM\n### 1. CONFIRMED — fx-9999' }];
  const md = renderMarkdown(model({}, [r]));
  assert.doesNotMatch(md, /^### 9\./m);
  assert.equal((md.match(/^### /gm) ?? []).length, 1);
});
