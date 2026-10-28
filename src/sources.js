const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const teamKey = (name) => norm(name).replace(/(afc|fc|sc)$/, '');

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// A league site names the league as the last segment of its page title ("Matchweek 16 | Continental Soccer League").
const lastTitleSegment = (title) => String(title ?? '').split(/[|–—-]/).pop().trim();

function participant(fixture, haystacks) {
  return [fixture.home, fixture.away].find((team) => {
    const key = teamKey(team);
    return key && haystacks.some((h) => norm(h).includes(key));
  });
}

export function classifySource(evidence, fixture) {
  if (evidence.type === 'feed_listing') {
    return { tier: 'aggregator', role: 'aggregator', org: null, label: `${evidence.provider ?? 'ScoreFeed'} (aggregator)` };
  }

  if (evidence.type === 'social_post') {
    const { handle, display_name: name, verified } = evidence.account ?? {};
    if (!verified) return { tier: 'unofficial', role: 'unofficial', org: null, label: `${name ?? handle} (unverified account)` };
    if (norm(name) === norm(fixture.competition)) {
      return { tier: 'official', role: 'league', org: 'league', label: `${name} (league, verified)` };
    }
    const team = participant(fixture, [handle, name]);
    if (team) return { tier: 'official', role: 'club', org: `club:${teamKey(team)}`, label: `${name} (club, verified)` };
    return { tier: 'press', role: 'press', org: null, label: `${name ?? handle} (verified account, unaffiliated)` };
  }

  if (evidence.type === 'web_page') {
    const host = hostOf(evidence.url);
    if (norm(lastTitleSegment(evidence.title)) === norm(fixture.competition)) {
      return { tier: 'official', role: 'league', org: 'league', label: `${fixture.competition} (league site)` };
    }
    const team = participant(fixture, [host]);
    if (team) return { tier: 'official', role: 'club_site', org: `club:${teamKey(team)}`, label: `${host} (club site)` };
    return { tier: 'press', role: 'press', org: null, label: `${host} (press site)` };
  }

  return { tier: 'unofficial', role: 'unofficial', org: null, label: 'unknown source' };
}
