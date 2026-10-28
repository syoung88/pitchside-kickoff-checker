const HOUR_MS = 3600000;
const BAND_ORDER = { critical: 0, soon: 1, later: 2 };
const CONFIDENCE_ORDER = { high: 0, medium: 1 };
const ACTIONABLE = new Set(['change_recommended', 'needs_review']);

export function hoursToKickoff({ feedUtc, suggestedUtc, asOf }) {
  const times = [feedUtc, suggestedUtc].filter(Boolean).map(Date.parse);
  const now = Date.parse(asOf);
  const hours = (Math.min(...times) - now) / HOUR_MS;
  // The earlier time has passed but a later one is still ahead: the match may be about to start, so it is urgent, not past.
  return hours < 0 && Math.max(...times) >= now ? 0 : hours;
}

export function urgencyBand(hours) {
  if (hours < 0) return 'past';
  if (hours < 24) return 'critical';
  if (hours < 72) return 'soon';
  return 'later';
}

const byId = (a, b) => (a.fixture.id < b.fixture.id ? -1 : a.fixture.id > b.fixture.id ? 1 : 0);

function compare(a, b) {
  return (
    BAND_ORDER[a.band] - BAND_ORDER[b.band]
    || a.hours - b.hours
    || (b.result.decision.verdict === 'needs_review') - (a.result.decision.verdict === 'needs_review')
    || (CONFIDENCE_ORDER[a.result.decision.confidence] ?? 2) - (CONFIDENCE_ORDER[b.result.decision.confidence] ?? 2)
    || byId(a.result, b.result)
  );
}

export function rankResults(results, asOf) {
  const actionable = [];
  const past = [];
  const others = [];
  for (const result of results) {
    if (result.status !== 'checked' || !ACTIONABLE.has(result.decision.verdict)) {
      others.push(result);
      continue;
    }
    const hours = hoursToKickoff({ feedUtc: result.fixture.kickoff_utc, suggestedUtc: result.decision.suggestedUtc, asOf });
    const item = { result, hours, band: urgencyBand(hours), beyondGuide: false };
    (item.band === 'past' ? past : actionable).push(item);
  }
  actionable.sort(compare);
  actionable.forEach((item, index) => { item.beyondGuide = index >= 5; });
  past.sort(compare);
  others.sort(byId);
  return { actionable, others, past };
}
