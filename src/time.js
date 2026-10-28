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
