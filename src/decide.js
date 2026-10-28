const at = (item) => Date.parse(item.at);

// A web page's timestamp is when we crawled it, not when it was published, so only posts can be ordered in time.
const ordered = (i) => i.type !== 'web_page';
const laterPost = (a, b) => ordered(a) && ordered(b) && at(a) > at(b);
const isFirm = (i) => !i.claim.isRumour && Boolean(i.claim.isPostponement || i.claim.isTbc || i.resolution.utc);
const stance = (i) => (i.claim.isTbc ? 'TBC' : String(Date.parse(i.resolution.utc)));
const stanceLabel = (i) => (i.claim.isTbc ? 'TBC' : i.resolution.utc);

// Later firm statement from the same organisation that overrides `item`, if the two can be ordered.
const supersededBy = (item, pool, accept = () => true) =>
  pool.find((o) => o !== item && o.source.org === item.source.org && isFirm(o) && accept(o) && laterPost(o, item));

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
  if (claim.isRumour) return 'unconfirmed or rumoured; not used as a kickoff time';
  if (claim.isPostponement) return 'postponement notice, not a kickoff time';
  if (claim.isTbc) return 'TBC notice superseded by a later official statement';
  return resolution.unusableReason ?? 'not decisive';
}

// Builds the used / not-used lists so every piece of evidence appears exactly once.
function account({ fixture, items, unreadable, skipped }, usedNotes, notUsedNotes) {
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

function result(ctx, { verdict, rule, reason, suggestedUtc = null, confidence = null, used = new Map(), notUsed = new Map() }) {
  return { verdict, rule, suggestedUtc, confidence, reason, ...account(ctx, used, new Map([...ctx.baseNotes, ...notUsed])) };
}

function decideCore({ fixture, items, unreadable = [], skipped = [] }) {
  const ctx = { fixture, items, unreadable, skipped, baseNotes: new Map() };

  if (fixture.status !== 'scheduled') {
    return { verdict: 'out_of_scope', rule: 'R1', suggestedUtc: null, confidence: null,
      reason: `Fixture status is "${fixture.status}"; out of scope, no kickoff time is recommended`,
      evidenceUsed: [], evidenceNotUsed: [], caveats: [] };
  }

  const official = items.filter((i) => i.source.tier === 'official' && i.claim.aboutFixture === 'yes');

  // A postponement stays live unless the same organisation later posted a firm time or TBC notice (a reinstatement).
  const postponements = [];
  for (const i of official.filter((x) => x.claim.isPostponement && !x.claim.isRumour)) {
    const later = supersededBy(i, official, (o) => !o.claim.isPostponement);
    if (later) ctx.baseNotes.set(i.evidenceId, `postponement superseded by a later post from ${later.source.label} (${later.at})`);
    else postponements.push(i);
  }
  if (postponements.length > 0) {
    const first = postponements[0];
    return result(ctx, {
      verdict: 'needs_review', rule: 'R2',
      reason: `${first.source.label} reports a postponement or cancellation but the feed shows the match as scheduled; no time is suggested`,
      used: new Map(postponements.map((i) => [i.evidenceId, 'reports a postponement or cancellation'])),
    });
  }

  const statements = official.filter((i) => !i.claim.isRumour && (i.claim.isTbc || i.resolution.utc));
  const byOrgStatements = new Map();
  for (const i of statements) byOrgStatements.set(i.source.org, [...(byOrgStatements.get(i.source.org) ?? []), i]);
  const winners = [];
  for (const group of byOrgStatements.values()) {
    const winner = latestOf(group);
    winners.push(winner);
    const clash = group.find((i) => !ordered(i) && i !== winner && stance(i) !== stance(winner));
    if (clash) {
      return result(ctx, {
        verdict: 'needs_review', rule: 'R9', suggestedUtc: winner.resolution.utc ?? null,
        reason: `${clash.source.label} says ${stanceLabel(clash)} but ${winner.source.label} says ${stanceLabel(winner)}; a web page has no publish date, so the tool cannot tell which is newer`,
        used: new Map([[winner.evidenceId, `states ${stanceLabel(winner)}`], [clash.evidenceId, `undated web page says ${stanceLabel(clash)}; cannot be ordered against the post`]]),
      });
    }
  }
  // An undated page can't be placed after or before another organisation's post, so a TBC page always forces review.
  const latest = winners.find((w) => w.claim.isTbc && !ordered(w)) ?? latestOf(winners);
  if (latest?.claim.isTbc) {
    return result(ctx, {
      verdict: 'needs_review', rule: 'R7',
      reason: `${latest.source.label} says kickoff times are TBC; the feed's time is not official, re-check once confirmed`,
      used: new Map([[latest.evidenceId, 'latest official statement says kickoff is TBC']]),
    });
  }

  const usable = official.filter((i) => i.resolution.utc && !i.claim.isPostponement && !i.claim.isTbc && !i.claim.isRumour);
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

// Posts are ordered by when they were posted; an undated page only wins if nothing else is available.
function latestOf(list) {
  return list.reduce((best, i) => {
    if (!best) return i;
    if (ordered(i) !== ordered(best)) return ordered(i) ? i : best;
    if (at(i) !== at(best)) return at(i) > at(best) ? i : best;
    if (Boolean(i.claim.isTbc) !== Boolean(best.claim.isTbc)) return i.claim.isTbc ? i : best;
    return i.evidenceId > best.evidenceId ? i : best;
  }, null);
}
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
  const verb = winners.length === 1 ? 'states' : 'state';
  if (sameInstant(agreed, fixture.kickoff_utc)) {
    return result(ctx, { verdict: 'confirmed', rule: 'R5', confidence, used, notUsed,
      reason: `${names} ${verb} the same time as the feed (${agreed})` });
  }
  return result(ctx, { verdict: 'change_recommended', rule: 'R5', suggestedUtc: agreed, confidence, used, notUsed,
    reason: `${names} ${verb} ${agreed}, but the feed has ${fixture.kickoff_utc}` });
}

// G2: an official rumour that nothing firmer from the same organisation has replaced, and that points away from the
// verdict's time (or at a postponement), means the tool cannot confirm, change or call "insufficient".
function withRumourGuard({ fixture, items }, base) {
  const official = items.filter((i) => i.source.tier === 'official' && i.claim.aboutFixture === 'yes');
  const compareTo = base.suggestedUtc ?? fixture.kickoff_utc;
  const live = official.filter((i) => i.claim.isRumour && !supersededBy(i, official)
    && (i.claim.isPostponement || (i.resolution.utc && !sameInstant(i.resolution.utc, compareTo))));
  if (live.length === 0) return base;
  const ids = new Set(live.map((i) => i.evidenceId));
  const moved = base.evidenceNotUsed.filter((l) => ids.has(l.evidenceId))
    .map((l) => ({ ...l, note: 'unconfirmed claim: not used as evidence, but it signals a possible change' }));
  const first = live[0];
  const what = first.claim.isPostponement ? 'a possible postponement' : `${first.resolution.utc}`;
  return { ...base, verdict: 'needs_review', rule: 'G2', suggestedUtc: null, confidence: null,
    evidenceUsed: [...base.evidenceUsed, ...moved],
    evidenceNotUsed: base.evidenceNotUsed.filter((l) => !ids.has(l.evidenceId)),
    reason: `${first.source.label} hints at ${what} but marks it unconfirmed; the tool cannot rely on it, but it cannot rule out a change either, so a person should check; without it the verdict would have been "${base.verdict.replace('_', ' ')}"` };
}

const GUARDED = new Set(['confirmed', 'change_recommended', 'insufficient_evidence']);

// G1: never confirm, change or call "insufficient" while an official post could not be read.
export function decide(input) {
  const base = decideCore(input);
  if (!GUARDED.has(base.verdict)) return base;
  const unreadable = input.unreadable.filter((u) => u.source.tier === 'official').map((u) => u.evidenceId);
  const unclear = input.items.filter((i) => i.source.tier === 'official' && i.claim.aboutFixture === 'unclear').map((i) => i.evidenceId);
  const unresolved = input.items
    .filter((i) => i.source.tier === 'official' && i.claim.aboutFixture === 'yes' && i.claim.timeLocal && !i.resolution.utc
      && !i.claim.isPostponement && !i.claim.isTbc)
    .map((i) => i.evidenceId);
  const ids = [...unreadable, ...unclear, ...unresolved];
  if (ids.length === 0) return withRumourGuard(input, base);
  return { ...base, verdict: 'needs_review', rule: 'G1', suggestedUtc: null, confidence: null,
    reason: `An official post (${ids.join(', ')}) could not be read or converted, so the tool cannot rule out a change; without it the verdict would have been "${base.verdict.replace('_', ' ')}"` };
}
