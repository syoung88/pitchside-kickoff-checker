import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotSource } from '../src/api.js';
import { createCache } from '../src/extract.js';
import { parseArgs } from '../src/config.js';
import { runAll } from '../src/pipeline.js';
import { buildReportModel } from '../src/report.js';

// Cache-only run: any cache miss would call this and fail the test loudly.
const noLlm = { complete: async () => { throw new Error('golden test must be served from data/llm-cache'); } };
const config = parseArgs(['--offline'], {});

const run = await runAll({ source: createSnapshotSource('data/snapshot'), llm: noLlm, cache: createCache('data/llm-cache'), model: config.model, concurrency: 3 });
const model = buildReportModel(run.results, { asOf: '2026-06-20T08:25:00Z', sourceKind: run.sourceKind });
const outcome = (id) => run.results.find((r) => r.fixture.id === id).decision;

test('default as-of is the latest evidence timestamp', () => {
  assert.equal(run.latestEvidenceAt, '2026-06-20T08:25:00Z');
});

const EXPECTED = [
  ['fx-2201', 'change_recommended', 'R5', '2026-06-20T22:00:00Z', 'high'],
  ['fx-2202', 'confirmed', 'R5', null, 'high'],
  ['fx-2203', 'out_of_scope', 'R1', null, null],
  ['fx-2204', 'change_recommended', 'R5', '2026-06-24T00:30:00Z', 'medium'],
  ['fx-2205', 'needs_review', 'R4', '2026-06-28T01:30:00Z', null],
  ['fx-2206', 'insufficient_evidence', 'R8', null, null],
  ['fx-2207', 'change_recommended', 'R5', '2026-06-26T23:00:00Z', 'medium'],
  ['fx-2208', 'needs_review', 'R7', null, null],
  ['fx-2209', 'change_recommended', 'R5', '2026-07-01T02:00:00Z', 'high'],
];

for (const [id, verdict, rule, suggestedUtc, confidence] of EXPECTED) {
  test(`${id}: ${verdict}`, () => {
    const d = outcome(id);
    assert.deepEqual([d.verdict, d.rule, d.suggestedUtc, d.confidence], [verdict, rule, suggestedUtc, confidence], d.reason);
  });
}

test('actionable fixtures rank in the spec order with only the sixth beyond the guide', () => {
  assert.deepEqual(model.actionable.map((i) => i.fixture.id), ['fx-2201', 'fx-2204', 'fx-2207', 'fx-2208', 'fx-2205', 'fx-2209']);
  assert.deepEqual(model.actionable.map((i) => i.beyond_guide), [false, false, false, false, false, true]);
  assert.equal(model.actionable[0].urgency.band, 'critical');
});

test('the postponed fixture gets no time and no evidence lines', () => {
  const d = outcome('fx-2203');
  assert.equal(d.suggestedUtc, null);
  assert.deepEqual([d.evidenceUsed, d.evidenceNotUsed], [[], []]);
});

test("Caldera's tweet about another match is shown as not used on fx-2207", () => {
  const line = outcome('fx-2207').evidenceNotUsed.find((l) => l.evidenceId === 'ev-2207-c');
  assert.match(line.note, /different match/);
});

test('fx-2204: the earlier 5 PM post is superseded and ScoreFeed is informational', () => {
  const notUsed = outcome('fx-2204').evidenceNotUsed;
  assert.match(notUsed.find((l) => l.evidenceId === 'ev-2204-a').note, /superseded/);
  assert.match(notUsed.find((l) => l.evidenceId === 'ev-2204-c').note, /ScoreFeed/);
});
