import { toIsoZ } from './iso.js';

export { toIsoZ };

const STATED_ZONES = {
  et: 'America/New_York', eastern: 'America/New_York', edt: 'America/New_York',
  ct: 'America/Chicago', central: 'America/Chicago', cdt: 'America/Chicago',
  mt: 'America/Denver', mountain: 'America/Denver', mdt: 'America/Denver',
  pt: 'America/Los_Angeles', pacific: 'America/Los_Angeles', pdt: 'America/Los_Angeles',
  mst: 'MST', // literal Mountain Standard Time: fixed UTC-7, as Arizona uses all year
};

const CITY_ZONES = {
  denver: 'America/Denver',
  chicago: 'America/Chicago',
  'new york': 'America/New_York',
  'los angeles': 'America/Los_Angeles',
  phoenix: 'America/Phoenix',
};

export function resolveZone(zoneText, venueTz) {
  if (zoneText == null || zoneText.trim() === '') return { tz: venueTz, via: 'venue' };
  const key = zoneText.trim().toLowerCase().replace(/\.$/, '').replace(/ time$/, '');

  // Arizona observes Mountain time all year, so "Mountain" at a Phoenix venue means Phoenix time.
  if ((key === 'mt' || key === 'mountain') && venueTz === 'America/Phoenix') {
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
const MONTH_PATTERN = `(${MONTHS.join('|')}|${MONTHS.map((m) => m.slice(0, 3)).join('|')})`;

const plain = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function parseWeekday(text) {
  if (!text) return null;
  const m = plain(text).match(new RegExp(`\\b(${Object.keys(WEEKDAYS).join('|')})\\b`));
  return m ? WEEKDAYS[m[1]] : null;
}

export function parseExplicitDate(text, year) {
  if (!text) return null;
  const t = plain(text);
  const dayFirst = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_PATTERN}\\b`));
  const monthFirst = t.match(new RegExp(`\\b${MONTH_PATTERN}\\s+(\\d{1,2})\\b`));
  let day;
  let month;
  if (dayFirst) [day, month] = [dayFirst[1], dayFirst[2]];
  else if (monthFirst) [month, day] = [monthFirst[1], monthFirst[2]];
  else return null;
  const index = MONTHS.findIndex((m) => m === month || m.slice(0, 3) === month);
  return `${year}-${String(index + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
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
  const explicit = parseExplicitDate(claim.dateText, Number(feedLocal.ymd.slice(0, 4)));
  const weekday = parseWeekday(claim.dateText);
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
