import { toIsoZ } from './iso.js';

export { toIsoZ };

const STATED_ZONES = {
  et: 'America/New_York', eastern: 'America/New_York', edt: 'America/New_York',
  ct: 'America/Chicago', central: 'America/Chicago', cdt: 'America/Chicago',
  mt: 'America/Denver', mountain: 'America/Denver', mdt: 'America/Denver',
  pt: 'America/Los_Angeles', pacific: 'America/Los_Angeles', pdt: 'America/Los_Angeles',
  'hora del este': 'America/New_York', 'hora central': 'America/Chicago', 'hora del centro': 'America/Chicago',
  'hora de la montana': 'America/Denver', 'hora de montana': 'America/Denver', 'hora del pacifico': 'America/Los_Angeles',
  mst: 'MST', // literal Mountain Standard Time: fixed UTC-7, as Arizona uses all year
  // Named zones with a fixed offset (Etc/GMT signs are inverted); "standard" and "daylight" spell out which one.
  utc: 'UTC', gmt: 'Etc/GMT', bst: 'Etc/GMT-1', cet: 'Etc/GMT-1', cest: 'Etc/GMT-2',
  est: 'Etc/GMT+5', cst: 'Etc/GMT+6', pst: 'Etc/GMT+8',
  'eastern standard': 'Etc/GMT+5', 'eastern daylight': 'Etc/GMT+4',
  'central standard': 'Etc/GMT+6', 'central daylight': 'Etc/GMT+5',
  'mountain standard': 'MST', 'mountain daylight': 'Etc/GMT+6',
  'pacific standard': 'Etc/GMT+8', 'pacific daylight': 'Etc/GMT+7',
};

const CITY_ZONES = {
  denver: 'America/Denver',
  chicago: 'America/Chicago',
  'new york': 'America/New_York',
  'nueva york': 'America/New_York',
  'los angeles': 'America/Los_Angeles',
  phoenix: 'America/Phoenix',
  fenix: 'America/Phoenix',
};

export function resolveZone(zoneText, venueTz) {
  if (zoneText == null || zoneText.trim() === '') return { tz: venueTz, via: 'venue' };
  const key = plain(zoneText).trim().replace(/\.$/, '').replace(/ time$/, '');

  // Arizona observes Mountain time all year, so "Mountain" at a Phoenix venue means Phoenix time.
  if (['mt', 'mountain', 'hora de la montana', 'hora de montana'].includes(key) && venueTz === 'America/Phoenix') {
    return { tz: venueTz, via: 'venue' };
  }
  if (STATED_ZONES[key]) return { tz: STATED_ZONES[key], via: 'stated' };

  const city = key.match(/^hora de (.+)$/);
  if (city && CITY_ZONES[city[1]]) return { tz: CITY_ZONES[city[1]], via: 'stated' };

  return { error: `unrecognised timezone wording "${zoneText}"` };
}

function zoneParts(utcMs, tz, extra = {}) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', ...extra,
  }).formatToParts(new Date(utcMs));
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

function offsetMs(utcMs, tz) {
  const p = zoneParts(utcMs, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return asUtc - Math.floor(utcMs / 60000) * 60000;
}

export function localToUtc(ymd, hm, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - offsetMs(guess, tz);
  return toIsoZ(new Date(guess));
}

export function utcToLocal(utc, tz) {
  const ms = Date.parse(utc);
  const p = zoneParts(ms, tz, { weekday: 'short', month: 'short', timeZoneName: 'short' });
  const numeric = zoneParts(ms, tz);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${numeric.year}-${pad(numeric.month)}-${pad(numeric.day)}`;
  const hm = `${numeric.hour}:${numeric.minute}`;
  const weekday = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return { ymd, hm, weekday, label: `${p.weekday} ${p.day} ${p.month} ${hm} ${p.timeZoneName}` };
}

const WEEKDAYS = {
  sunday: 0, domingo: 0, monday: 1, lunes: 1, tuesday: 2, martes: 2, wednesday: 3, miercoles: 3,
  thursday: 4, jueves: 4, friday: 5, viernes: 5, saturday: 6, sabado: 6,
};
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const SPANISH_MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTH_INDEX = new Map([
  ...MONTHS.flatMap((m, i) => [[m, i], [m.slice(0, 3), i]]),
  ...SPANISH_MONTHS.map((m, i) => [m, i]),
  ['setiembre', 8],
]);
const MONTH_PATTERN = `(${[...MONTH_INDEX.keys()].sort((x, y) => y.length - x.length).join('|')})`;

const plain = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function parseWeekday(text) {
  if (!text) return null;
  const m = plain(text).match(new RegExp(`\\b(${Object.keys(WEEKDAYS).join('|')})\\b`));
  return m ? WEEKDAYS[m[1]] : null;
}

const pad2 = (n) => String(n).padStart(2, '0');
const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
// A number that is really a clock time ("may 7:30", "7 pm", "at 7 may") is not a day of the month.
const looksLikeClock = (t, end, start) => /^\s*(:\d|\.\d\d|\s?[ap]\.?m\b|h\b)/.test(t.slice(end)) || /\b(at|@|a las)\s*$/.test(t.slice(0, start));

// Returns YYYY-MM-DD, taking the year (this, last or next) that puts the date nearest `nearYmd`; null if no valid date is named.
export function parseExplicitDate(text, nearYmd) {
  if (!text) return null;
  const t = plain(text);
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:de\\s+)?${MONTH_PATTERN}\\b`).exec(t);
  const monthFirst = new RegExp(`\\b${MONTH_PATTERN}\\s+(\\d{1,2})\\b`).exec(t);
  let day;
  let month;
  let found;
  if (dayFirst) [found, day, month] = [dayFirst, dayFirst[1], dayFirst[2]];
  else if (monthFirst) [found, month, day] = [monthFirst, monthFirst[1], monthFirst[2]];
  else return null;
  const numberStart = found.index + (found === dayFirst ? 0 : found[0].length - day.length);
  if (looksLikeClock(t, numberStart + day.length, numberStart)) return null;
  const monthNumber = MONTH_INDEX.get(month) + 1;
  const near = Date.parse(`${nearYmd}T00:00:00Z`);
  const year = Number(nearYmd.slice(0, 4));
  const candidates = [year - 1, year, year + 1]
    .filter((y) => Number(day) >= 1 && Number(day) <= daysIn(y, monthNumber))
    .map((y) => `${y}-${pad2(monthNumber)}-${pad2(day)}`);
  candidates.sort((x, y) => Math.abs(Date.parse(`${x}T00:00:00Z`) - near) - Math.abs(Date.parse(`${y}T00:00:00Z`) - near));
  return candidates[0] ?? null;
}

const addDays = (ymd, days) => toIsoZ(new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400000)).slice(0, 10);
const shortDate = (ymd) => `${Number(ymd.slice(8))} ${MONTHS[Number(ymd.slice(5, 7)) - 1].slice(0, 3).replace(/^./, (c) => c.toUpperCase())}`;

const unusable = (unusableReason) => ({ utc: null, working: [], dateCheck: 'none', caveats: [], unusableReason });

export function resolveClaimTime(claim, fixture) {
  const venueTz = fixture.venue.timezone;
  if (!claim.timeLocal) return unusable('no kickoff time stated');

  const zone = resolveZone(claim.zoneText, venueTz);
  if (zone.error) return unusable(zone.error);

  const feedLocal = utcToLocal(fixture.kickoff_utc, venueTz);
  const explicit = parseExplicitDate(claim.dateText, feedLocal.ymd);
  const weekday = parseWeekday(claim.dateText);
  // Wording like "tomorrow" or "next Friday" is not resolved here; applying the time to the feed's date would be a guess.
  if (claim.dateText?.trim() && !explicit && weekday === null) return unusable(`date wording not understood: "${claim.dateText}"`);
  const ymd = explicit ?? feedLocal.ymd;
  const utc = localToUtc(ymd, claim.timeLocal, zone.tz);

  let dateCheck = 'none';
  if (explicit) dateCheck = explicit === feedLocal.ymd ? 'ok' : 'mismatch';
  else if (weekday !== null) dateCheck = weekday === feedLocal.weekday ? 'ok' : 'mismatch';

  const caveats = [];
  if (dateCheck === 'ok' && !explicit && claim.at) {
    const posted = utcToLocal(claim.at, venueTz);
    const nearest = addDays(posted.ymd, (weekday - posted.weekday + 7) % 7);
    if (nearest !== feedLocal.ymd) {
      caveats.push(`"${claim.dateText}" in a post from ${shortDate(posted.ymd)} points to ${shortDate(nearest)}, but the feed date is ${shortDate(feedLocal.ymd)}; the weekday matches so it is only noted`);
    }
  }

  const zoneNote = zone.via === 'stated' ? `${zone.tz} (stated "${claim.zoneText}")` : `${zone.tz} (venue zone, none stated)`;
  const working = [`"${claim.quote ?? claim.timeLocal}" -> ${claim.timeLocal} ${zoneNote} on ${ymd} = ${utc}`];
  return { utc, working, dateCheck, caveats, unusableReason: null };
}
