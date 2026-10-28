# Design spec: Pitchside kickoff checker

Status: implemented. Agreed section by section with the author, then built test-first; kept in sync with the code (`NOTES.md` carries the reasoning).

## 1. Purpose and scope

Pitchside Data sells a UTC fixture feed to broadcasters, betting operators and apps. Kickoff times go stale when clubs and leagues move matches. This tool reads the monitored fixtures and the evidence collected for each, decides whether the feed's kickoff time is right, and writes a report telling the operations team (two analysts, with half an hour a day between them) what to do.

**The tool recommends only. It never writes to the production feed.** The previous tool did, and it cost Pitchside a client. This is non-negotiable for the pilot.

**In scope:** kickoff-time verification for fixtures with status `scheduled`.
**Out of scope:** postponed or cancelled fixtures (no time is ever recommended for them), reschedules, any write to the feed, a web UI, and monitoring or alerting.

Success looks like:
- Every fixture gets exactly one outcome, with the working visible.
- Thin evidence yields "insufficient evidence", never a guess.
- The report is skimmable and ranked by urgency, with the actionable list kept short.
- One failing API call or LLM call never takes down the run.

## 2. Requirements gathered (from the Head of Operations)

| Topic | Requirement |
|---|---|
| Division of labour | Tool recommends with evidence; humans apply corrections. |
| Source trust | Verified club accounts are the most trusted single source. The league's official account is the final word on broadcast-driven changes, but an older league page does not automatically beat a newer club post. Other sources: club websites, ScoreFeed (licensed aggregator, can be stale). |
| Conflicts | A club-vs-league disagreement is reviewed by a human before anything changes. |
| Timezones | A club's "7 PM" is stadium-local, usually with no zone stated. The feed is UTC, so the tool must convert correctly. |
| Thin evidence | A fan rumour alone is "not enough evidence", not a recommended change. Fans and blogs can only prompt a harder look at official sources. |
| Outcomes | Four distinct answers: confirmed, change recommended, needs review, insufficient evidence. Corroborated feed times are reported as confirmed. |
| Status changes | Postponed/cancelled fixtures are out of scope. Never recommend a time for them. |
| Transparency | Every recommendation shows what the evidence was, who said it, when, and why; including the local-to-UTC conversion. |
| Urgency | A suspected error hours away outranks one weeks away. Output must be skimmable and ranked. About five flagged fixtures a day is the maximum useful volume. |

### Assumptions (made where no answer was available)
1. One clear statement from a verified club or the league is enough for "change recommended" (medium confidence).
2. "Confirmed" needs an official source that agrees with the feed. ScoreFeed agreeing with the feed never confirms it, because the feed may itself derive from ScoreFeed and a stale aggregator time is what caused the earlier incident.
3. When club and league disagree, the verdict is "needs review", with the later value pre-filled as a suggestion.
4. Press previews only support other evidence. Fan accounts and blogs alone give "insufficient evidence".
5. Date wording is checked by weekday only (section 6); a week offset is a caveat, not a verdict change.
6. `last_verified_at` is shown as context but does not affect any verdict, because its meaning to Pitchside is unknown.

## 3. Architecture and data flow

A pipeline run once per fixture. Fixtures are independent, so a failure in one does not affect the others. Only steps 1, 2 and 7 touch the network or disk; steps 3 to 6 are pure functions.

1. **Fetch** (`src/api.js`): fixture list, then each fixture's evidence.
2. **Extract** (`src/extract.js`): social posts and web snippets go to the LLM and return structured claims. ScoreFeed listings are already structured and skip the LLM.
3. **Resolve** (`src/time.js`): local time, zone wording and date wording become a UTC instant, with the conversion steps recorded.
4. **Classify** (`src/sources.js`): each piece of evidence is placed in a source tier.
5. **Decide** (`src/decide.js`): ordered rules produce a verdict, a suggested time, a confidence and the rule that fired.
6. **Rank** (`src/rank.js`): urgency and ordering.
7. **Report** (`src/report.js`): terminal output, `report.md`, `report.json`.

`index.js` wires these together. `src/config.js` holds flags and environment.

### CLI
```
npm start [-- --as-of <ISO time>] [-- --offline] [-- --out <dir>]
```
- `--as-of`: the reference time for urgency. Default: the latest timestamp in the evidence (about 20 Jun 2026), because the sample data is from June 2026. In production this would be the current time.
- `--offline`: read `data/snapshot/` instead of the API. This is never an automatic fallback: if a live call fails the fixture is reported "could not check". Offline runs show a banner on the terminal output and `report.md`, and set `"source": "offline-snapshot"` in `report.json`.
- `--out`: output directory, default `./output`.
- A live run (without `--offline`) needs `OPENAI_API_KEY`; without it the tool exits non-zero at once with a clear message instead of failing every extraction.
- Exit code 0 for a completed run (including partial failures, which are shown in the report). Non-zero only if no report is possible, e.g. the fixture list cannot be fetched.

## 4. Claims (LLM extraction)

For each social post and web snippet the LLM returns one claim, constrained by a strict JSON schema:

| Field | Meaning |
|---|---|
| `about_this_fixture` | `yes`, `no` or `unclear` |
| `kickoff_time_24h` | The kickoff time exactly as stated, `HH:MM`, or null. No timezone conversion. |
| `timezone_stated` | Zone wording as written ("ET", "Eastern", "hora de Denver") or null |
| `date_text` | Date wording as written ("this Saturday", "8 July") or null |
| `is_postponement_or_cancellation` | boolean |
| `is_rumour_or_unconfirmed` | boolean; an official rumour is never used as a time, but can force review (G2) |
| `is_tbc` | boolean |
| `quote` | Shortest verbatim span containing the time |
| `ignored_times` | Non-kickoff times mentioned (gates, ticket office, parking), as written; shown in the report as a note |

The model is told to ignore gate-opening, ticket-office and parking times, and to mark evidence about a different match as `about_this_fixture: no`. The fixture's teams, venue, competition, who posted it and the evidence timestamp are given as context. A reschedule to another day or date counts as a postponement; a same-day time change ("now kicks off at 6 PM") does not.

**Validation in code:** enum values and `HH:MM` format are checked, and `quote` must appear verbatim in the original text and contain the stated time (hour and minutes, 12h or 24h form, and not a time the model also listed as ignored); otherwise the claim is discarded, a guard against invented times. Who posted decides the tier; the rumour flag only gates official claims (a live rumour is never used as a time and forces review, G2), and it is ignored on TBC notices, which the model often ticks as both.

**Settings:** model `gpt-4.1-mini` (override with `OPENAI_MODEL`), temperature 0, 20s timeout, 2 retries on 5xx/429/timeout. Post text is untrusted: it is delimited in the prompt, the model is told to ignore instructions inside it, and the output is schema-constrained and never executed.

**Cache:** responses are stored in `data/llm-cache/`, keyed by a hash of the model, prompt version, the full prompt and schema, fixture context and text. The cache is committed so the golden test and `--offline` runs work with no API key. Changing the prompt or schema forces live calls until the cache is re-recorded.

## 5. Time resolution

Done in code, never by the model.

- **Zone lookup:** a fixed table maps wording to zones: ET/Eastern, CT/Central, MT/Mountain, PT/Pacific (daylight-aware), "hora de <city>" and the Spanish regional names, and named zones with a fixed offset (UTC, GMT, BST, CET/CEST, EST/CST/PST, MST, and "Eastern standard"-style wording). Unknown wording makes the claim unusable for a change, and the working says why; for an official post that forces review (G1).
- **Stated zone beats venue zone.** "9 PM Eastern" for a Denver match is converted as Eastern.
- **No stated zone** means the venue's IANA zone (`venue.timezone`). This handles Arizona automatically: Phoenix has no daylight saving time, so 7 PM there is 02:00Z.
- **Calendar date:** the feed's venue-local date, unless the claim gives an explicit date. The conversion is recorded step by step and shown in the report.
- **Known limitation:** a stated zone far from the venue combined with a very late or early time could land on a different calendar day. The report shows the resulting instant, so such cases are visible.

### Date wording
Weekday words are read in code from an English and Spanish lexicon ("sábado" as well as "Saturday"); date wording the code cannot read (for example "tomorrow") makes the claim unusable rather than guessing a date, and for an official post that forces review (G1). Explicit dates are read in English and Spanish, with the year chosen nearest the feed's date. A claim is date-compatible if its weekday (or explicit date) matches the feed's venue-local date. A different weekday means the day may have moved, so the verdict is needs review. A week offset (for example "Tuesday" posted on 19 Jun, which points to 23 Jun, while the feed date is 30 Jun) is shown as a caveat but does not change the verdict. In the sample data, four fixtures have this offset (fx-2204, fx-2205, fx-2207, fx-2209); the posts name the opponent, so the match is identified, and treating every offset as an error would flag half the list.

## 6. Sources and decision rules

### Source tiers
Decided in code. An account or host counts as a club only if its name is the team's name plus at most an "official" or language suffix ("Pacific Crown Español"), not merely containing it; a club site is matched on the host's registrable name. A league account must be named after one of the monitored competitions, and a league site needs the competition as its page title and a league-like host. Anything unclassifiable drops to the lower tier.

| Tier | Who | Role |
|---|---|---|
| Official | The league's account or site; a club in this fixture (verified account or its own site) | Can justify a verdict |
| Aggregator | ScoreFeed | Shown for information. Never confirms, never blocks a change. |
| Press | Verified but unaffiliated accounts; press sites | Raises confidence, never decisive alone |
| Unofficial | Unverified, fan, blog | Insufficient evidence on its own |

A club's account and its own website count as **one organisation**.

### Rules (labels are stable and appear in the report)
| Rule | Condition | Verdict |
|---|---|---|
| R1 | Feed status is postponed or cancelled | Out of scope. No time. |
| R2 | An official source reports a postponement or cancellation but the feed says scheduled | Needs review. No time suggested. |
| R3 | Per organisation, the latest usable official claim wins (a later post supersedes an earlier one from the same organisation). Posts are ordered by posted time; a web page's timestamp is when it was crawled, so pages cannot be ordered against posts (see R9) | (feeds R4 and R5) |
| R4 | Latest claims from different official organisations disagree | Needs review. Later value pre-filled as a suggestion. |
| R5 | Official claims agree. Equal to the feed: **confirmed**. Different: **change recommended**. | Confirmed / Change recommended |
| R6 | A decisive claim's weekday or explicit date does not match the feed's venue-local date | Needs review |
| R7 | The latest official statement is a TBC notice | Needs review: feed time is not official, re-check |
| R8 | No usable official claim (only unofficial, press or ScoreFeed evidence, or none) | Insufficient evidence. Notes if ScoreFeed differs from the feed. |
| R9 | An undated web page disagrees with a post (or another page) from the same organisation | Needs review: a page's timestamp is crawl time, so the tool can't tell which is newer |
| G2 | Guard: a live official rumour (not superseded by a later firm post from the same organisation) differs from the verdict's time, or hints at a postponement | Needs review: "unconfirmed official claim signals a possible change" |
| G1 | Guard: an official-tier item could not be read (extraction failed, the model could not tell what it is about, or its stated time could not be converted) and the verdict would otherwise be confirmed, change recommended or insufficient | Needs review: "an official post couldn't be read" |

**Evaluation order:** R1, R2 (a postponement superseded by a later firm post from the same organisation is dropped), R9, R7, then R3 to R5 with the R6 date check applied to the claims they use, then R8, then G1 and G2 as final overrides.

### Confidence
Shown only for confirmed and change-recommended verdicts:
- **High:** two or more official organisations agree, or one official organisation plus press.
- **Medium:** one official organisation alone.

Needs-review items show their reason instead of a confidence level.

## 7. Urgency and ranking

- **Hours to kickoff** = hours from the as-of time to the earlier of the feed's kickoff and the suggested kickoff, because the match could start at either.
- **Bands:** critical (under 24h), soon (under 72h), later.
- If the earlier of the two times has passed but the later is still ahead, hours are treated as 0 (critical): the match may be about to start.
- A match that has already kicked off with a needs-review or change verdict is shown in full, counts as need action, and ranks first (PAST KICKOFF).
- **Actionable** items are change recommended and needs review. They are ranked by band, then hours to kickoff, then needs-review before change at equal hours, then confidence.
- The report shows **one ranked list with a divider after the fifth item** ("beyond the usual five a day, lower urgency"). Nothing is hidden. The header states the count against the Head of Operations' guide of five.
- Confirmed, insufficient-evidence, out-of-scope and could-not-check fixtures appear in a compact table below the list, with a one-line reason each.

## 8. Report

`report.md` and the terminal output carry the same content. `report.json` mirrors it for tooling.

**Header:** as-of time, data source (`live API` or `OFFLINE SNAPSHOT`), and a one-line tally (actionable vs the guide of five; confirmed; insufficient evidence; out of scope; could not check). API failures are called out here.

**Each actionable item:**
- verdict, fixture, urgency band and hours, confidence
- feed time and suggested time, each in UTC and venue-local
- the rule that fired and a one-line reason
- **Evidence used:** for each item, who said it (name, tier, verified), when, the quote, and the conversion (for example `"6pm Eastern" -> 18:00 America/New_York = 22:00Z`)
- **Evidence not used:** each item with the reason (different match, unofficial source, superseded by a later claim, unconfirmed or rumoured, unsupported or malformed, matches a superseded claim). Gate, ticket and parking times appear as a short note under the evidence item they came from.
- **Caveats:** for example a week offset in the date wording.

`report.json` uses `evidence_used` and `evidence_not_used` with the same fields. The feed's `last_verified_at` is shown as context.

## 9. Resilience

**Pitchside API**
- 8s timeout per call. Network errors, timeouts, 5xx and 429 are retried up to 3 times with exponential backoff (about 0.5s, 1s, 2s) plus jitter, honouring `Retry-After`. Other 4xx responses are not retried.
- Fixtures are processed 3 at a time.
- If a fixture's evidence cannot be fetched after retries, it becomes "could not check: API unavailable (reason)". The rest of the run continues.
- If the fixture list cannot be fetched, the tool exits non-zero with a clear message.
- Response shapes are validated lightly. A malformed or unknown evidence item is skipped and listed under Evidence not used as "unsupported or malformed".

**LLM**
- Failure on one item marks only that item unreadable. See guard G1 for official-tier items.
- Evidence text is untrusted input (section 4).

**Secrets:** the API key is read from `.env` only. `.env` is gitignored and `.env.example` is committed.

## 10. Testing

`node --test`. No test calls the live API or the live LLM.

- **time:** Arizona has no daylight saving (7 PM Phoenix = 02:00Z); stated "Eastern" beats the venue zone; "hora de Denver"; evening times that roll into the next UTC day; unknown zone wording rejected; weekday match and mismatch.
- **sources:** classification of league, club, club site, press and unofficial from handle, domain and names; unclassifiable sources drop a tier.
- **decide:** one test per rule R1 to R9 and the guards G1 and G2 using hand-built claims, including the postponement signal on a scheduled fixture, club-vs-league conflict and the TBC rule.
- **api:** a fake `fetch` simulates 503 then success, a hang past the timeout, 429 with `Retry-After`, 404 and malformed JSON; one bad fixture never aborts the run.
- **extract:** a fake LLM client returns bad JSON, an invalid time, and a quote that is not in the text; each is rejected.
- **golden:** the full pipeline on the snapshot with the recorded LLM responses, asserting the nine expected outcomes below and their ranked order.
- **report:** labels, the divider after the fifth item, and the offline banner.

## 11. Expected results on the sample data (as of about 20 Jun 2026 08:25Z)

| Fixture | Verdict | Suggested (UTC) | Confidence | Notes |
|---|---|---|---|---|
| fx-2201 | Change recommended | 20 Jun 22:00 | High | Club, club and league site all say 6 PM ET; feed is 2h early |
| fx-2202 | Confirmed | none | High | Both clubs agree; zoneless "7 PM" resolved with venue zone (Denver) |
| fx-2203 | Out of scope | none | none | Feed status postponed (R1) |
| fx-2204 | Change recommended | 24 Jun 00:30 | Medium | Club's later post supersedes its earlier one; feed matches neither; ScoreFeed shows the superseded time |
| fx-2205 | Needs review | 28 Jun 01:30 if league stands | none | Club (01:00Z) vs later, broadcast-driven league post (01:30Z) (R4) |
| fx-2206 | Insufficient evidence | none | none | Fan account and blog only (R8) |
| fx-2207 | Change recommended | 26 Jun 23:00 | Medium | One organisation; Caldera tweet is a different match, gate and ticket times ignored |
| fx-2208 | Needs review | none | none | League says quarter-final times TBC; ScoreFeed predates that notice (R7) |
| fx-2209 | Change recommended | 1 Jul 02:00 | High | Phoenix is MST (no daylight saving); press "10 PM Eastern" agrees |

Expected ranked actionable order (hours from as-of to the earlier of the feed and suggested time): fx-2201 (about 12h, critical), fx-2204 (about 88h), fx-2207 (about 158h), fx-2208 (about 162h), fx-2205 (about 185h), then the divider, then fx-2209 (about 257h). Six actionable items against a guide of five.

## 12. Items to carry into NOTES.md

**Pushback and proposals**
- The five-a-day cap is a sensible target for a normal day, but this fixture list yields six actionable items because most feed times are stale. Cutting the list at five would hide a real correction, so the report keeps one ranked list with a divider and says so. Proposal: measure actual daily volume during the pilot before treating five as a hard limit.
- ScoreFeed agreeing with the feed does not confirm it (assumption 2). Proposal: ask Pitchside whether the feed is seeded from ScoreFeed.
- Requiring human review for every club-vs-league disagreement is safe but adds to the queue even when the league explicitly overrides for broadcast. Proposal: keep review for the pilot; revisit once there is history of how often the later league value was right.

**Surprises in the data**
- Weekday wording in posts often points to a different week than the feed's date (four of nine fixtures).
- fx-2203 is already postponed in the feed but `last_verified_at` predates the postponement posts.
- fx-2207 evidence includes a tweet about a different match (Caldera vs Fogline, 18 Jul).
- Arizona has no daylight saving time, which makes a naive "Mountain Time" conversion off by an hour.
- ScoreFeed is stale or pre-dates later notices on fx-2203, fx-2204 and fx-2208.
- The API returned 200 on every call during exploration; the 503s and hangs warned about were not observed, so resilience is tested with injected failures.

**Set aside**
- Postponed and cancelled fixtures, any feed write-back, a UI, scheduling or alerting, learning source weights from history, non-English beyond what the LLM handles, and reading images in posts.

**With more time**
- Backtest the rules against known past corrections; calibrate confidence; handle zone wording beyond the fixed list; add a review-feedback loop so analysts' decisions refine the rules; run on a schedule with alerts for critical items.
