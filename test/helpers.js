// Builders for decision-engine tests. Defaults describe an official club claim for an fx-2209-like fixture.
export function makeFixture(overrides = {}) {
  return {
    id: 'fx-2209',
    competition: 'Continental Soccer League',
    home: 'Cactus Athletic',
    away: 'Summit Rovers',
    status: 'scheduled',
    kickoff_utc: '2026-07-01T01:00:00Z',
    venue: { name: 'Sonoran Bowl', city: 'Phoenix', timezone: 'America/Phoenix' },
    last_verified_at: '2026-06-04T10:00:00Z',
    ...overrides,
  };
}

export function makeItem({
  id, at = '2026-06-19T17:40:00Z', tier = 'official', role = 'club', org = 'club:cactusathletic',
  label = `${id} source`, utc = '2026-07-01T02:00:00Z', aboutFixture = 'yes', isPostponement = false,
  isTbc = false, dateCheck = 'ok', caveats = [], unusableReason, quote = `quote for ${id}`, ignoredTimes = [],
} = {}) {
  return {
    evidenceId: id,
    at,
    claim: { evidenceId: id, at, aboutFixture, timeLocal: utc ? '19:00' : null, zoneText: null, dateText: null,
      isPostponement, isRumour: false, isTbc, quote, ignoredTimes },
    source: { tier, role, org, label },
    resolution: { utc, working: utc ? [`${id} -> ${utc}`] : [], dateCheck, caveats,
      unusableReason: unusableReason ?? (utc ? null : 'no kickoff time stated') },
  };
}
