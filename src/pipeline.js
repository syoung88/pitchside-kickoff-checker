import { classifySource } from './sources.js';
import { claimFromFeedListing, evidenceTime, extractClaim } from './extract.js';
import { resolveClaimTime, toIsoZ } from './time.js';
import { decide } from './decide.js';

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const latestTime = (times) => times.reduce((best, t) => (!best || Date.parse(t) > Date.parse(best) ? t : best), null);

function listingResolution(claim) {
  const ms = Date.parse(claim.listedUtc);
  if (Number.isNaN(ms)) {
    return { utc: null, working: [], dateCheck: 'none', caveats: [], unusableReason: 'listed kickoff time is not a valid date' };
  }
  const utc = toIsoZ(new Date(ms));
  return { utc, working: [`ScoreFeed lists ${utc}`], dateCheck: 'none', caveats: [], unusableReason: null };
}

async function buildItem(fixture, evidence, { llm, cache, model, leagueNames }) {
  const source = classifySource(evidence, fixture, leagueNames);
  if (evidence.type === 'feed_listing') {
    const claim = claimFromFeedListing(evidence);
    return { item: { evidenceId: evidence.id, type: evidence.type, at: claim.at, claim, source, resolution: listingResolution(claim) } };
  }
  const extracted = await extractClaim({ fixture, evidence, llm, cache, model });
  if (extracted.status === 'failed') return { unreadable: { evidenceId: evidence.id, source, reason: extracted.reason } };
  const { claim } = extracted;
  return { item: { evidenceId: evidence.id, type: evidence.type, at: claim.at, claim, source, resolution: resolveClaimTime(claim, fixture) } };
}

export async function checkFixture(fixture, deps) {
  try {
    if (fixture.status !== 'scheduled') {
      const decision = decide({ fixture, items: [], unreadable: [], skipped: [] });
      return { fixture, status: 'checked', decision, reason: null, latestEvidenceAt: null };
    }

    let fetched;
    try {
      fetched = await deps.source.getEvidence(fixture.id);
    } catch (err) {
      return { fixture, status: 'could_not_check', decision: null, reason: `API unavailable (${err.reason ?? err.message})`, latestEvidenceAt: null };
    }

    const built = await Promise.all(fetched.items.map((evidence) => buildItem(fixture, evidence, deps)));
    const items = built.flatMap((b) => (b.item ? [b.item] : []));
    const unreadable = built.flatMap((b) => (b.unreadable ? [b.unreadable] : []));
    const decision = decide({ fixture, items, unreadable, skipped: fetched.skipped });
    return { fixture, status: 'checked', decision, reason: null, latestEvidenceAt: latestTime(fetched.items.map(evidenceTime)) };
  } catch (err) {
    return { fixture, status: 'could_not_check', decision: null, reason: `unexpected error: ${err.message}`, latestEvidenceAt: null };
  }
}

export async function runAll({ source, llm, cache, model, concurrency = 3 }) {
  const fixtures = await source.listFixtures();
  const leagueNames = [...new Set(fixtures.map((f) => f.competition).filter(Boolean))];
  const results = await mapLimit(fixtures, concurrency, (fixture) => checkFixture(fixture, { source, llm, cache, model, leagueNames }));
  return { results, latestEvidenceAt: latestTime(results.map((r) => r.latestEvidenceAt).filter(Boolean)), sourceKind: source.kind };
}
