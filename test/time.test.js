import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toIsoZ, resolveZone, localToUtc, utcToLocal, parseWeekday, parseExplicitDate, resolveClaimTime } from '../src/time.js';

const fixtures = JSON.parse(readFileSync(new URL('../data/snapshot/fixtures.json', import.meta.url))).fixtures;
const fx = (id) => fixtures.find((f) => f.id === id);
const claim = (o) => ({ evidenceId: 'ev-x', at: null, aboutFixture: 'yes', timeLocal: null, zoneText: null, dateText: null,
  isPostponement: false, isRumour: false, isTbc: false, quote: null, ignoredTimes: [], ...o });

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

test('resolveZone: Spanish city names, with or without accents', () => {
  assert.deepEqual(resolveZone('hora de Nueva York', 'America/Denver'), { tz: 'America/New_York', via: 'stated' });
  assert.deepEqual(resolveZone('Hora de Los Ángeles', 'America/Denver'), { tz: 'America/Los_Angeles', via: 'stated' });
  assert.deepEqual(resolveZone('hora de Fénix', 'America/Denver'), { tz: 'America/Phoenix', via: 'stated' });
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

test('parseWeekday reads English and Spanish', () => {
  assert.equal(parseWeekday('este sábado'), 6);
  assert.equal(parseWeekday('Saturday night'), 6);
  assert.equal(parseWeekday('martes'), 2);
  assert.equal(parseWeekday("Tuesday's match"), 2);
  assert.equal(parseWeekday('tomorrow'), null);
  assert.equal(parseWeekday(null), null);
});

test('parseExplicitDate reads day-month wording', () => {
  assert.equal(parseExplicitDate('Wednesday 8 July', '2026-07-01'), '2026-07-08');
  assert.equal(parseExplicitDate('July 18', '2026-07-01'), '2026-07-18');
  assert.equal(parseExplicitDate('Saturday', '2026-07-01'), null);
  assert.equal(parseExplicitDate(null, '2026-07-01'), null);
});

test('parseExplicitDate reads Spanish wording', () => {
  assert.equal(parseExplicitDate('el sábado 8 de julio', '2026-07-01'), '2026-07-08');
  assert.equal(parseExplicitDate('3 de enero', '2026-12-30'), '2027-01-03');
});

test('parseExplicitDate rejects impossible dates and picks the year nearest the feed date', () => {
  assert.equal(parseExplicitDate('31 Feb', '2026-02-20'), null);
  assert.equal(parseExplicitDate('July 32', '2026-07-01'), null);
  assert.equal(parseExplicitDate('29 Feb', '2027-03-01'), '2028-02-29');
  assert.equal(parseExplicitDate('January 3', '2026-12-30'), '2027-01-03');
  assert.equal(parseExplicitDate('December 28', '2027-01-02'), '2026-12-28');
});

test('parseExplicitDate ignores a clock time that follows or is introduced like a month name', () => {
  assert.equal(parseExplicitDate('gates may 7:30', '2026-07-01'), null);
  assert.equal(parseExplicitDate('kicks off at 7 may be delayed', '2026-07-01'), null);
  assert.equal(parseExplicitDate('May 7', '2026-05-01'), '2026-05-07');
});

test('resolveZone converts fixed-offset names deterministically', () => {
  const cases = [['UTC', 'UTC'], ['GMT', 'Etc/GMT'], ['BST', 'Etc/GMT-1'], ['CET', 'Etc/GMT-1'], ['CEST', 'Etc/GMT-2'],
    ['PST', 'Etc/GMT+8'], ['Pacific Standard Time', 'Etc/GMT+8'], ['Pacific Daylight Time', 'Etc/GMT+7']];
  for (const [text, tz] of cases) assert.deepEqual(resolveZone(text, 'America/Denver'), { tz, via: 'stated' }, text);
  assert.equal(localToUtc('2026-06-20', '19:00', 'Etc/GMT-1'), '2026-06-20T18:00:00Z');
  assert.equal(localToUtc('2026-06-20', '19:00', 'Etc/GMT+7'), '2026-06-21T02:00:00Z');
  assert.equal(localToUtc('2026-06-20', '19:00', 'UTC'), '2026-06-20T19:00:00Z');
});

test('resolveClaimTime: date wording that cannot be parsed is unusable, not applied to the feed date', () => {
  for (const dateText of ['tomorrow', 'mañana', 'next week']) {
    const r = resolveClaimTime(claim({ timeLocal: '15:00', dateText }), fx('fx-2209'));
    assert.equal(r.utc, null, dateText);
    assert.match(r.unusableReason, /date wording not understood/);
  }
  const ok = resolveClaimTime(claim({ timeLocal: '19:00', dateText: 'el sábado 8 de julio' }), fx('fx-2209'));
  assert.equal(ok.dateCheck, 'mismatch');
});

test('resolveClaimTime: Phoenix zoneless 7 PM is 02:00Z, weekday ok, week offset is a caveat', () => {
  const r = resolveClaimTime(claim({ timeLocal: '19:00', dateText: 'Tuesday night', at: '2026-06-19T17:40:00Z' }), fx('fx-2209'));
  assert.equal(r.utc, '2026-07-01T02:00:00Z');
  assert.equal(r.dateCheck, 'ok');
  assert.equal(r.caveats.length, 1);
  assert.match(r.caveats[0], /23 Jun.*30 Jun/);
  assert.equal(r.unusableReason, null);
  assert.match(r.working[0], /2026-07-01T02:00:00Z/);
});

test('resolveClaimTime: Spanish "hora de Denver" and press "Eastern" agree on 01:00Z', () => {
  const club = resolveClaimTime(claim({ timeLocal: '19:00', zoneText: 'hora de Denver', dateText: 'este sábado', at: '2026-06-15T02:30:00Z' }), fx('fx-2202'));
  const press = resolveClaimTime(claim({ timeLocal: '21:00', zoneText: 'Eastern', dateText: 'Saturday night' }), fx('fx-2202'));
  assert.equal(club.utc, '2026-06-21T01:00:00Z');
  assert.equal(club.dateCheck, 'ok');
  assert.deepEqual(club.caveats, []);
  assert.equal(press.utc, '2026-06-21T01:00:00Z');
});

test('resolveClaimTime: stated ET at a New York venue', () => {
  const r = resolveClaimTime(claim({ timeLocal: '18:00', zoneText: 'ET', dateText: 'Saturday' }), fx('fx-2201'));
  assert.equal(r.utc, '2026-06-20T22:00:00Z');
});

test('resolveClaimTime: a different weekday is a mismatch', () => {
  const r = resolveClaimTime(claim({ timeLocal: '19:00', dateText: 'Friday' }), fx('fx-2209'));
  assert.equal(r.dateCheck, 'mismatch');
});

test('resolveClaimTime: explicit date is used and compared with the feed date', () => {
  const r = resolveClaimTime(claim({ timeLocal: '19:00', dateText: 'Wednesday 8 July' }), fx('fx-2209'));
  assert.equal(r.dateCheck, 'mismatch');
  assert.equal(r.utc, '2026-07-09T02:00:00Z');
});

test('resolveClaimTime: no date wording means dateCheck none', () => {
  assert.equal(resolveClaimTime(claim({ timeLocal: '19:00' }), fx('fx-2209')).dateCheck, 'none');
});

test('resolveClaimTime: missing time or unknown zone is unusable with a reason', () => {
  const noTime = resolveClaimTime(claim({ timeLocal: null }), fx('fx-2209'));
  assert.equal(noTime.utc, null);
  assert.ok(noTime.unusableReason.length > 0);
  const badZone = resolveClaimTime(claim({ timeLocal: '19:00', zoneText: 'Klingon' }), fx('fx-2209'));
  assert.equal(badZone.utc, null);
  assert.match(badZone.unusableReason, /Klingon/);
});
