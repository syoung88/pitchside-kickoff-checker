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

// A name is "the club" only if it is the team name plus, at most, a short official or language suffix
// ("Pacific Crown Español"); a name that merely contains the team ("Denver Rapids News") is not.
const OFFICIAL_SUFFIXES = new Set(['', 'official', 'es', 'espanol', 'fr', 'francais', 'en', 'uk', 'us']);

function isTeamName(candidate, team) {
  const key = teamKey(team);
  const name = norm(candidate).replace(/(afc|fc|sc)$/, '');
  return key !== '' && name.startsWith(key) && OFFICIAL_SUFFIXES.has(name.slice(key.length));
}

const participant = (fixture, candidates) =>
  [fixture.home, fixture.away].find((team) => candidates.some((c) => isTeamName(c, team)));

const hostLabel = (host) => host.split('.').slice(0, -1).join('');
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').toLowerCase();

// A league site names the league in its title AND lives on a host that looks like the league's
// ("cslsoccer.com" for the Continental Soccer League); a press page titled with the league name does not.
function leagueSiteName(host, title, leagueNames) {
  const named = leagueNames.find((league) => norm(league) === norm(lastTitleSegment(title)));
  if (!named) return null;
  const label = norm(hostLabel(host));
  const short = initials(named);
  return label.includes(norm(named)) || (short.length >= 3 && label.startsWith(short)) ? named : null;
}

export function classifySource(evidence, fixture, leagueNames = [fixture.competition]) {
  const isLeagueName = (name) => leagueNames.some((league) => norm(league) === norm(name));
  if (evidence.type === 'feed_listing') {
    return { tier: 'aggregator', role: 'aggregator', org: null, label: `${evidence.provider ?? 'ScoreFeed'} (aggregator)` };
  }

  if (evidence.type === 'social_post') {
    const { handle, display_name: name, verified } = evidence.account ?? {};
    if (!verified) return { tier: 'unofficial', role: 'unofficial', org: null, label: `${name ?? handle} (unverified account)` };
    if (isLeagueName(name)) {
      return { tier: 'official', role: 'league', org: 'league', label: `${name} (league, verified)` };
    }
    const team = participant(fixture, [handle, name]);
    if (team) return { tier: 'official', role: 'club', org: `club:${teamKey(team)}`, label: `${name} (club, verified)` };
    return { tier: 'press', role: 'press', org: null, label: `${name ?? handle} (verified account, unaffiliated)` };
  }

  if (evidence.type === 'web_page') {
    const host = hostOf(evidence.url);
    const leagueSite = leagueSiteName(host, evidence.title, leagueNames);
    if (leagueSite) {
      return { tier: 'official', role: 'league', org: 'league', label: `${leagueSite} (league site)` };
    }
    const team = participant(fixture, [hostLabel(host)]);
    if (team) return { tier: 'official', role: 'club_site', org: `club:${teamKey(team)}`, label: `${host} (club site)` };
    return { tier: 'press', role: 'press', org: null, label: `${host} (press site)` };
  }

  return { tier: 'unofficial', role: 'unofficial', org: null, label: 'unknown source' };
}
