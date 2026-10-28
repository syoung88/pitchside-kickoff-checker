import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (args) => spawnSync(process.execPath, ['index.js', ...args], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, OPENAI_API_KEY: '' },
  encoding: 'utf8',
});

test('--offline runs end to end with no API key and writes both reports', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'cli-')), 'out');
  const r = run(['--offline', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /# Pitchside kickoff check/);
  assert.match(r.stdout, /OFFLINE SNAPSHOT/);
  assert.match(r.stdout, /6 need action \(guide: 5\)/);
  assert.ok(existsSync(join(out, 'report.md')) && existsSync(join(out, 'report.json')));
});

test('a bad --as-of exits non-zero with a clear message', () => {
  const r = run(['--offline', '--as-of', 'nonsense']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--as-of/);
});

test('an unknown flag exits non-zero', () => {
  assert.notEqual(run(['--nope']).status, 0);
});

test('a live run without an API key exits 2 and says how to fix it', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /OPENAI_API_KEY is not set/);
});
