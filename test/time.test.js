import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toIsoZ, resolveZone, localToUtc, utcToLocal } from '../src/time.js';

test('toIsoZ drops milliseconds', () => {
  assert.equal(toIsoZ(new Date('2026-06-20T22:00:00.000Z')), '2026-06-20T22:00:00Z');
});

test('localToUtc converts New York daylight time', () => {
  assert.equal(localToUtc('2026-06-20', '18:00', 'America/New_York'), '2026-06-20T22:00:00Z');
});

test('localToUtc: Phoenix has no daylight saving, 7 PM is 02:00Z next day', () => {
  assert.equal(localToUtc('2026-06-30', '19:00', 'America/Phoenix'), '2026-07-01T02:00:00Z');
});

test('localToUtc rolls into the next UTC day', () => {
  assert.equal(localToUtc('2026-06-27', '23:30', 'America/Los_Angeles'), '2026-06-28T06:30:00Z');
});

test('utcToLocal gives date, time, weekday and label', () => {
  const l = utcToLocal('2026-07-01T01:00:00Z', 'America/Phoenix');
  assert.equal(l.ymd, '2026-06-30');
  assert.equal(l.hm, '18:00');
  assert.equal(l.weekday, 2);
  assert.equal(l.label, 'Tue 30 Jun 18:00 MST');
});

test('resolveZone maps North American wording to IANA zones', () => {
  const cases = [
    ['ET', 'America/New_York'], ['Eastern', 'America/New_York'],
    ['CT', 'America/Chicago'], ['Central', 'America/Chicago'],
    ['MT', 'America/Denver'], ['Mountain', 'America/Denver'],
    ['PT', 'America/Los_Angeles'], ['Pacific', 'America/Los_Angeles'],
  ];
  for (const [text, tz] of cases) {
    assert.deepEqual(resolveZone(text, 'America/Denver'), { tz, via: 'stated' }, text);
  }
});

test('resolveZone: "hora de Denver" overrides a New York venue', () => {
  assert.deepEqual(resolveZone('hora de Denver', 'America/New_York'), { tz: 'America/Denver', via: 'stated' });
});

test('resolveZone: no wording uses the venue zone', () => {
  assert.deepEqual(resolveZone(null, 'America/Phoenix'), { tz: 'America/Phoenix', via: 'venue' });
});

test('resolveZone: Mountain wording at a Phoenix venue means Phoenix time, not Denver', () => {
  assert.deepEqual(resolveZone('MT', 'America/Phoenix'), { tz: 'America/Phoenix', via: 'venue' });
  assert.deepEqual(resolveZone('Mountain', 'America/Phoenix'), { tz: 'America/Phoenix', via: 'venue' });
});

test('resolveZone: literal MST is fixed UTC-7', () => {
  assert.deepEqual(resolveZone('MST', 'America/Denver'), { tz: 'MST', via: 'stated' });
  assert.equal(localToUtc('2026-06-30', '19:00', 'MST'), '2026-07-01T02:00:00Z');
});

test('resolveZone rejects unknown wording', () => {
  const r = resolveZone('Klingon time', 'America/Denver');
  assert.match(r.error, /Klingon/);
});
