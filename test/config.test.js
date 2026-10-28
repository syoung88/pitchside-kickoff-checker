import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, loadEnv } from '../src/config.js';

test('no args gives defaults', () => {
  const c = parseArgs([], {});
  assert.equal(c.offline, false);
  assert.equal(c.asOf, null);
  assert.equal(c.outDir, 'output');
  assert.equal(c.concurrency, 3);
  assert.equal(c.model, 'gpt-4.1-mini');
  assert.equal(c.snapshotDir, 'data/snapshot');
  assert.equal(c.cacheDir, 'data/llm-cache');
  assert.equal(c.openaiKey, null);
  assert.match(c.apiBase, /everyday-sim.*\/api\/challenge$/);
});

test('flags are parsed', () => {
  const c = parseArgs(['--offline', '--out', 'x', '--as-of', '2026-06-20T08:25:00Z'], {});
  assert.equal(c.offline, true);
  assert.equal(c.outDir, 'x');
  assert.equal(c.asOf, '2026-06-20T08:25:00Z');
});

test('as-of is normalised to canonical Z form', () => {
  assert.equal(parseArgs(['--as-of', '2026-06-20T08:25:00.000Z'], {}).asOf, '2026-06-20T08:25:00Z');
});

test('invalid --as-of throws a clear error', () => {
  assert.throws(() => parseArgs(['--as-of', 'nonsense'], {}), /--as-of/);
});

test('--as-of without a value throws', () => {
  assert.throws(() => parseArgs(['--as-of'], {}), /--as-of/);
});

test('unknown flag throws', () => {
  assert.throws(() => parseArgs(['--nope'], {}), /unknown/i);
});

test('env overrides model and supplies the key; empty key is null', () => {
  const c = parseArgs([], { OPENAI_MODEL: 'm', OPENAI_API_KEY: 'k' });
  assert.equal(c.model, 'm');
  assert.equal(c.openaiKey, 'k');
  assert.equal(parseArgs([], { OPENAI_API_KEY: '' }).openaiKey, null);
});

test('loadEnv ignores a missing file', () => {
  assert.doesNotThrow(() => loadEnv('/nonexistent/.env'));
});
