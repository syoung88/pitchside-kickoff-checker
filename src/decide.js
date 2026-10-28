const at = (item) => Date.parse(item.at);

function line(item, note) {
  return {
    evidenceId: item.evidenceId,
    label: item.source.label,
    at: item.at,
    quote: item.claim.quote,
    working: item.resolution.working,
    ignoredTimes: item.claim.ignoredTimes ?? [],
    note,
  };
}

function notUsedNote(item, fixture) {
  const { claim, source, resolution } = item;
  if (claim.aboutFixture === 'no') return 'about a different match';
  if (claim.aboutFixture === 'unclear') return 'unclear whether it is about this fixture';
  if (source.tier === 'aggregator') {
    const same = Date.parse(resolution.utc) === Date.parse(fixture.kickoff_utc);
    return `ScoreFeed is informational only; it lists ${resolution.utc}, which ${same ? 'matches' : 'differs from'} the feed`;
  }
  if (source.tier === 'unofficial') return 'unofficial source; cannot justify a change on its own';
  if (source.tier === 'press') return 'press source; supports other evidence but is not decisive';
  if (claim.isPostponement) return 'postponement notice, not a kickoff time';
  if (claim.isTbc) return 'TBC notice superseded by a later official statement';
  return resolution.unusableReason ?? 'not decisive';
}

// Builds the used / not-used lists so every piece of evidence appears exactly once.
function account({ fixture, items, unreadable, skipped }, usedNotes, notUsedNotes = new Map()) {
  const evidenceUsed = [];
  const evidenceNotUsed = [];
  for (const item of items) {
    if (usedNotes.has(item.evidenceId)) evidenceUsed.push(line(item, usedNotes.get(item.evidenceId)));
    else evidenceNotUsed.push(line(item, notUsedNotes.get(item.evidenceId) ?? notUsedNote(item, fixture)));
  }
  for (const u of unreadable) {
    evidenceNotUsed.push({ evidenceId: u.evidenceId, label: u.source.label, at: null, quote: null, working: [],
      ignoredTimes: [], note: `could not be read: ${u.reason}` });
  }
  for (const s of skipped) {
    evidenceNotUsed.push({ evidenceId: s.evidenceId, label: 'unknown source', at: null, quote: null, working: [],
      ignoredTimes: [], note: `unsupported or malformed: ${s.reason}` });
  }
  const caveats = [...new Set(items.filter((i) => usedNotes.has(i.evidenceId)).flatMap((i) => i.resolution.caveats))];
  return { evidenceUsed, evidenceNotUsed, caveats };
}

function result(ctx, { verdict, rule, reason, suggestedUtc = null, confidence = null, used = new Map(), notUsed }) {
  return { verdict, rule, suggestedUtc, confidence, reason, ...account(ctx, used, notUsed) };
}

function decideCore({ fixture, items, unreadable = [], skipped = [] }) {
  const ctx = { fixture, items, unreadable, skipped };

  if (fixture.status !== 'scheduled') {
    return { verdict: 'out_of_scope', rule: 'R1', suggestedUtc: null, confidence: null,
      reason: `Fixture status is "${fixture.status}"; out of scope, no kickoff time is recommended`,
      evidenceUsed: [], evidenceNotUsed: [], caveats: [] };
  }

  const official = items.filter((i) => i.source.tier === 'official' && i.claim.aboutFixture === 'yes');

  const postponements = official.filter((i) => i.claim.isPostponement);
  if (postponements.length > 0) {
    const first = postponements[0];
    return result(ctx, {
      verdict: 'needs_review', rule: 'R2',
      reason: `${first.source.label} reports a postponement or cancellation but the feed shows the match as scheduled; no time is suggested`,
      used: new Map(postponements.map((i) => [i.evidenceId, 'reports a postponement or cancellation'])),
    });
  }

  const statements = official.filter((i) => i.claim.isTbc || i.resolution.utc);
  const latest = statements.reduce((best, i) => (!best || at(i) > at(best) || (at(i) === at(best) && i.claim.isTbc) ? i : best), null);
  if (latest?.claim.isTbc) {
    return result(ctx, {
      verdict: 'needs_review', rule: 'R7',
      reason: `${latest.source.label} says kickoff times are TBC; the feed's time is not official, re-check once confirmed`,
      used: new Map([[latest.evidenceId, 'latest official statement says kickoff is TBC']]),
    });
  }

  const usable = official.filter((i) => i.resolution.utc && !i.claim.isPostponement && !i.claim.isTbc);
  if (usable.length > 0) return decideFromOfficial(ctx, usable);

  const differing = items.find((i) => i.source.tier === 'aggregator' && i.resolution.utc
    && Date.parse(i.resolution.utc) !== Date.parse(fixture.kickoff_utc));
  const scoreFeedNote = differing
    ? ` ScoreFeed lists ${differing.resolution.utc}, which differs from the feed; treat that as a prompt to find an official source.`
    : '';
  return result(ctx, {
    verdict: 'insufficient_evidence', rule: 'R8',
    reason: (items.length === 0
      ? 'No evidence was found for this fixture.'
      : 'No official source states a kickoff time; only unofficial, press or aggregator evidence.') + scoreFeedNote,
  });
}

const latestOf = (list) => list.reduce((best, i) =>
  (!best || at(i) > at(best) || (at(i) === at(best) && i.evidenceId > best.evidenceId) ? i : best), null);
const sameInstant = (a, b) => Date.parse(a) === Date.parse(b);

// R3 (latest claim per organisation), R6 (date check), R4 (organisations disagree), R5 (agree).
function decideFromOfficial(ctx, usable) {
  const { fixture, items } = ctx;
  const byOrg = new Map();
  for (const i of usable) byOrg.set(i.source.org, [...(byOrg.get(i.source.org) ?? []), i]);
  const used = new Map();
  const notUsed = new Map();
  const winners = [];
  for (const group of byOrg.values()) {
    const winner = latestOf(group);
    winners.push(winner);
    used.set(winner.evidenceId, `states ${winner.resolution.utc}`);
    for (const other of group) {
      if (other === winner) continue;
      if (sameInstant(other.resolution.utc, winner.resolution.utc)) {
        used.set(other.evidenceId, 'same organisation and same time as its latest post, counted once');
      } else {
        notUsed.set(other.evidenceId, `superseded by a later post from ${winner.source.label} (${winner.at})`);
      }
    }
  }

  const mismatched = winners.filter((w) => w.resolution.dateCheck === 'mismatch');
  if (mismatched.length > 0) {
    const w = latestOf(mismatched);
    return result(ctx, {
      verdict: 'needs_review', rule: 'R6', suggestedUtc: w.resolution.utc, used, notUsed,
      reason: `${w.source.label} names a different day than the feed's date, so the match may have moved day; check before changing`,
    });
  }

  const times = new Set(winners.map((w) => Date.parse(w.resolution.utc)));
  if (times.size > 1) {
    const w = latestOf(winners);
    const others = winners.filter((x) => x !== w).map((x) => `${x.source.label} says ${x.resolution.utc}`).join('; ');
    return result(ctx, {
      verdict: 'needs_review', rule: 'R4', suggestedUtc: w.resolution.utc, used, notUsed,
      reason: `Official sources disagree: ${others}; the later ${w.source.label} says ${w.resolution.utc} (suggested if it stands)`,
    });
  }

  const agreed = winners[0].resolution.utc;
  const supporting = items.filter((i) => i.source.tier === 'press' && i.claim.aboutFixture === 'yes'
    && i.resolution.utc && sameInstant(i.resolution.utc, agreed));
  for (const p of supporting) used.set(p.evidenceId, 'press source agrees; supports the official statement');
  const confidence = winners.length >= 2 || supporting.length > 0 ? 'high' : 'medium';
  const names = winners.map((w) => w.source.label).join(', ');
  if (sameInstant(agreed, fixture.kickoff_utc)) {
    return result(ctx, { verdict: 'confirmed', rule: 'R5', confidence, used, notUsed,
      reason: `${names} state the same time as the feed (${agreed})` });
  }
  return result(ctx, { verdict: 'change_recommended', rule: 'R5', suggestedUtc: agreed, confidence, used, notUsed,
    reason: `${names} state ${agreed}, but the feed has ${fixture.kickoff_utc}` });
}

const GUARDED = new Set(['confirmed', 'change_recommended', 'insufficient_evidence']);

// G1: never confirm, change or call "insufficient" while an official post could not be read.
export function decide(input) {
  const base = decideCore(input);
  if (!GUARDED.has(base.verdict)) return base;
  const unreadable = input.unreadable.filter((u) => u.source.tier === 'official').map((u) => u.evidenceId);
  const unclear = input.items.filter((i) => i.source.tier === 'official' && i.claim.aboutFixture === 'unclear').map((i) => i.evidenceId);
  const ids = [...unreadable, ...unclear];
  if (ids.length === 0) return base;
  return { ...base, verdict: 'needs_review', rule: 'G1', suggestedUtc: null, confidence: null,
    reason: `An official post (${ids.join(', ')}) could not be read, so the tool cannot rule out a change; without it the verdict would have been "${base.verdict.replace('_', ' ')}"` };
}
