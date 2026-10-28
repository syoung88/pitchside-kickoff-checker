import { mkdir, writeFile } from 'node:fs/promises';
import { rankResults } from './rank.js';
import { utcToLocal } from './time.js';

const GUIDE = 5;
const DIVIDER = 'beyond the usual five a day, lower urgency';
const VERDICT_TITLE = {
  confirmed: 'CONFIRMED',
  change_recommended: 'CHANGE RECOMMENDED',
  needs_review: 'NEEDS REVIEW',
  insufficient_evidence: 'INSUFFICIENT EVIDENCE',
  out_of_scope: 'OUT OF SCOPE',
  could_not_check: 'COULD NOT CHECK',
};

const timeOf = (utc, tz) => (utc ? { utc, local: utcToLocal(utc, tz).label } : null);
const evidenceLine = (l) => ({
  evidence_id: l.evidenceId, label: l.label, at: l.at, quote: l.quote, working: l.working, ignored_times: l.ignoredTimes, note: l.note,
});
const fixtureInfo = (f) => ({ id: f.id, home: f.home, away: f.away, competition: f.competition, venue: `${f.venue?.name ?? ''}, ${f.venue?.city ?? ''}` });

function actionableItem(ranked, index) {
  const { result, hours, band, beyondGuide } = ranked;
  const { fixture, decision } = result;
  const tz = fixture.venue.timezone;
  return {
    rank: index + 1,
    fixture: fixtureInfo(fixture),
    verdict: decision.verdict,
    rule: decision.rule,
    urgency: { band, hours: Number(hours.toFixed(1)) },
    confidence: decision.confidence,
    feed: timeOf(fixture.kickoff_utc, tz),
    suggested: timeOf(decision.suggestedUtc, tz),
    reason: decision.reason,
    evidence_used: decision.evidenceUsed.map(evidenceLine),
    evidence_not_used: decision.evidenceNotUsed.map(evidenceLine),
    caveats: decision.caveats,
    last_verified_at: fixture.last_verified_at ?? null,
    beyond_guide: beyondGuide,
  };
}

function otherItem(result) {
  const { fixture, status, decision } = result;
  if (status === 'could_not_check') {
    return { fixture: fixtureInfo(fixture), verdict: 'could_not_check', rule: null, confidence: null, reason: result.reason };
  }
  return { fixture: fixtureInfo(fixture), verdict: decision.verdict, rule: decision.rule, confidence: decision.confidence, reason: decision.reason };
}

export function buildReportModel(results, { asOf, sourceKind }) {
  const ranked = rankResults(results, asOf);
  const others = ranked.others.map(otherItem);
  const count = (verdict) => others.filter((o) => o.verdict === verdict).length;
  return {
    meta: { asOf, source: sourceKind },
    tally: {
      actionable: ranked.actionable.length,
      guide: GUIDE,
      confirmed: count('confirmed'),
      insufficient_evidence: count('insufficient_evidence'),
      out_of_scope: count('out_of_scope'),
      could_not_check: count('could_not_check'),
      past_kickoff: ranked.past.length,
    },
    actionable: ranked.actionable.map(actionableItem),
    past: ranked.past.map((p, i) => actionableItem(p, i)),
    others,
  };
}

const names = (f) => `${f.home} v ${f.away}`;
const quoted = (q) => (q ? `\n  - Said: "${q}"` : '');

function renderUsed(l) {
  const lines = [`- **${l.label}**${l.at ? ` · ${l.at}` : ''}`];
  if (l.quote) lines.push(`  - Said: "${l.quote}"`);
  for (const w of l.working) lines.push(`  - Working: ${w}`);
  lines.push(`  - Role: ${l.note}`);
  if (l.ignored_times.length > 0) lines.push(`  - Other times mentioned, not kickoff: ${l.ignored_times.join('; ')}`);
  return lines.join('\n');
}

function renderNotUsed(l) {
  const head = `- **${l.label}**${l.at ? ` · ${l.at}` : ''} — ${l.note}`;
  return `${head}${quoted(l.quote)}${l.ignored_times.length > 0 ? `\n  - Other times mentioned, not kickoff: ${l.ignored_times.join('; ')}` : ''}`;
}

function renderItem(item) {
  const title = VERDICT_TITLE[item.verdict];
  const confidence = item.confidence ? ` · confidence ${item.confidence.toUpperCase()}` : '';
  const feed = `${item.feed.utc} (${item.feed.local})`;
  const suggestedLabel = item.verdict === 'needs_review' ? 'Suggested if it stands' : 'Suggested';
  const suggested = item.suggested ? `${item.suggested.utc} (${item.suggested.local})` : 'none';
  const out = [
    `### ${item.rank}. ${title} — ${item.fixture.id} ${names(item.fixture)}`,
    `Kicks off in ${Math.round(item.urgency.hours)}h · ${item.urgency.band.toUpperCase()}${confidence} · rule ${item.rule}`,
    '',
    `- Feed: ${feed}`,
    `- ${suggestedLabel}: ${suggested}`,
    `- Why: ${item.reason}`,
    item.last_verified_at ? `- Feed last verified: ${item.last_verified_at} (context only)` : null,
    '',
    '**Evidence used**',
    item.evidence_used.length > 0 ? item.evidence_used.map(renderUsed).join('\n') : '- none',
    '',
    '**Evidence not used**',
    item.evidence_not_used.length > 0 ? item.evidence_not_used.map(renderNotUsed).join('\n') : '- none',
  ];
  if (item.caveats.length > 0) out.push('', '**Caveats**', ...item.caveats.map((c) => `- ${c}`));
  return out.filter((l) => l !== null).join('\n');
}

export function renderMarkdown(model) {
  const { meta, tally } = model;
  const source = meta.source === 'offline-snapshot' ? '**OFFLINE SNAPSHOT: saved data, not a live check**' : 'live API';
  const lines = [
    '# Pitchside kickoff check',
    '',
    `As of ${meta.asOf} · Data source: ${source}`,
    '',
    `${tally.actionable} need action (guide: ${tally.guide}) · ${tally.confirmed} confirmed · ${tally.insufficient_evidence} insufficient evidence · ${tally.out_of_scope} out of scope · ${tally.could_not_check} could not check`,
  ];
  const failed = model.others.filter((o) => o.verdict === 'could_not_check');
  if (failed.length > 0) {
    lines.push('', `⚠ Could not check ${failed.length} fixture${failed.length === 1 ? '' : 's'}: ${failed.map((f) => `${f.fixture.id} (${f.reason})`).join(', ')}`);
  }

  lines.push('', '## Needs action', '');
  if (model.actionable.length === 0) lines.push('Nothing needs action.');
  model.actionable.forEach((item, index) => {
    if (index === GUIDE) lines.push(`> **${DIVIDER}**`, '');
    lines.push(renderItem(item), '');
  });

  if (model.past.length > 0) {
    lines.push('## Past kickoff', '');
    for (const p of model.past) lines.push(`- ${p.fixture.id} ${names(p.fixture)}: past kickoff, not actionable (feed ${p.feed.utc})`);
    lines.push('');
  }

  if (model.others.length > 0) {
    lines.push('## Other fixtures', '', '| Fixture | Outcome | Why |', '|---|---|---|');
    for (const o of model.others) {
      const confidence = o.confidence ? ` (${o.confidence})` : '';
      lines.push(`| ${o.fixture.id} ${names(o.fixture)} | ${VERDICT_TITLE[o.verdict]}${confidence} | ${String(o.reason).replace(/\|/g, '/')} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export const renderJson = (model) => `${JSON.stringify(model, null, 2)}\n`;

export async function writeReport(model, outDir) {
  await mkdir(outDir, { recursive: true });
  const mdPath = `${outDir}/report.md`;
  const jsonPath = `${outDir}/report.json`;
  await writeFile(mdPath, renderMarkdown(model));
  await writeFile(jsonPath, renderJson(model));
  return { mdPath, jsonPath };
}
