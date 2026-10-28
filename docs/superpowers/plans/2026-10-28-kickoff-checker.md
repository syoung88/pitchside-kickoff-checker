# Pitchside Kickoff Checker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node.js CLI that checks every monitored fixture's kickoff time against gathered evidence and writes a ranked, fully explained recommendation report for Pitchside's ops team. It never writes to the feed.

**Architecture:** Per-fixture pipeline: fetch (retrying) -> LLM claim extraction (cached, validated) -> pure code for time resolution, source classification and tiered decision rules -> ranking -> Markdown/JSON report. Only fetch, extract and report touch network or disk.

**Tech Stack:** Node >=20.12 ESM, built-in `fetch`, `Intl`, `node:test`. No runtime dependencies (the `openai` package already in `package.json` is removed in Task 9; the LLM is called with `fetch`).

**Spec:** `docs/design-spec.md` (section numbers below refer to it). Sample data: `data/snapshot/`.

## Global Constraints
- Recommend only; no code path writes to the feed. Postponed/cancelled (any status other than `scheduled`) fixtures never get a time and their evidence is never fetched.
- API: 8s timeout per call; retry up to 3 times (backoff 500ms, 1s, 2s plus jitter) on network error, timeout, 5xx, 429 (honour `Retry-After`); no retry on other 4xx; 3 fixtures at a time.
- LLM: `gpt-4.1-mini` (env `OPENAI_MODEL`), temperature 0, 20s timeout, 2 retries (5xx/429/timeout), strict JSON schema, `quote` must appear verbatim in the text.
- All UTC strings are canonical `YYYY-MM-DDTHH:MM:SSZ`. Weekdays are numbers 0=Sunday..6=Saturday.
- Prompt version constant `PROMPT_VERSION = 'v1'`; cache in `data/llm-cache/` (committed), key = sha256 of model + version + fixture context + text.
- Default `--as-of` = latest evidence timestamp. `--out` default `./output`. Exit 0 for completed runs, non-zero only if no report is possible.
- Report labels exactly: `Evidence used`, `Evidence not used`; JSON keys `evidence_used`, `evidence_not_used`. Divider text: `beyond the usual five a day, lower urgency`.
- Secrets only from `.env` (gitignored). Tests never call the live API or LLM.
- Every task ends with a commit whose message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Data shapes (referenced by all tasks)
- **Fixture / Evidence:** exactly as returned by the API (see `data/snapshot/`). Evidence `type` is `social_post | web_page | feed_listing`.
- **Claim:** `{ evidenceId, at, aboutFixture: 'yes'|'no'|'unclear', timeLocal: 'HH:MM'|null, zoneText, dateText, isPostponement, isRumour, isTbc, quote, ignoredTimes: string[], listedUtc?: string }` (`at` = `posted_at`/`fetched_at`/`retrieved_at`; `listedUtc` only for ScoreFeed).
- **Source:** `{ tier: 'official'|'aggregator'|'press'|'unofficial', role: 'league'|'club'|'club_site'|'press'|'unofficial'|'aggregator', org: string|null, label: string }`.
- **Resolution:** `{ utc: string|null, working: string[], dateCheck: 'ok'|'mismatch'|'none', caveats: string[], unusableReason: string|null }`.
- **Item:** `{ evidenceId, at, claim, source, resolution }`.
- **Decision:** `{ verdict: 'confirmed'|'change_recommended'|'needs_review'|'insufficient_evidence'|'out_of_scope', rule: 'R1'|'R2'|'R4'|'R5'|'R6'|'R7'|'R8'|'G1', suggestedUtc: string|null, confidence: 'high'|'medium'|null, reason: string, evidenceUsed: EvidenceLine[], evidenceNotUsed: EvidenceLine[], caveats: string[] }`, where `EvidenceLine = { evidenceId, label, at, quote, working: string[], ignoredTimes: string[], note: string }` (`note` is the reason for not-used lines, the role in the decision for used lines).
- **FixtureResult:** `{ fixture, status: 'checked'|'could_not_check', decision: Decision|null, reason: string|null }`.

## Review Focus
- A club in Phoenix says "7 PM MT"/"Mountain"/"MST": must be UTC-7 year-round (02:00Z), not Denver time (Task 2).
- Fixture status other than `scheduled` (e.g. `cancelled`, `live`, unknown): out of scope, evidence never fetched (Task 10).
- An official post the LLM calls `unclear` is treated as unreadable, so it triggers G1 instead of being silently dropped (Task 6).
- Empty evidence list gives insufficient evidence; a non-array/garbage evidence response gives could-not-check, never a crash (Tasks 5, 8).
- Quote check survives emoji, double spaces, NBSP and smart quotes in the source text; and `--as-of nonsense` exits non-zero with a clear message (Tasks 9, 1).

---

### Task 1: Config and CLI parsing

**Files:**
- Create: `src/config.js`, `test/config.test.js`
- Modify: `package.json` (engines `>=20.12`; `start` script `node index.js`)

**Interfaces:**
- Produces: `parseArgs(argv: string[], env: Record<string,string|undefined>) -> Config`, throws `Error` with a clear message on bad input. `loadEnv(path = '.env'): void` (calls `process.loadEnvFile`, ignores a missing file).
- `Config = { asOf: string|null, offline: boolean, outDir: string, apiBase: string, openaiKey: string|null, model: string, snapshotDir: string, cacheDir: string, concurrency: 3 }`. Defaults: `apiBase` `https://everyday-sim-463015353641.us-east1.run.app/api/challenge`, `model` `env.OPENAI_MODEL ?? 'gpt-4.1-mini'`, `snapshotDir` `data/snapshot`, `cacheDir` `data/llm-cache`, `outDir` `output`.

- [ ] **Step 1: Write failing tests** in `test/config.test.js`: no args gives defaults (`offline:false`, `asOf:null`, `outDir:'output'`, `concurrency:3`); `['--offline','--out','x','--as-of','2026-06-20T08:25:00Z']` gives `offline:true,outDir:'x',asOf:'2026-06-20T08:25:00Z'`; `--as-of nonsense` throws matching `/--as-of/`; unknown flag `--nope` throws matching `/unknown/i`; `OPENAI_MODEL=m` env overrides model; `--as-of` without a value throws.
- [ ] **Step 2:** Run `node --test test/config.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `parseArgs` and `loadEnv` in `src/config.js` with a small hand-rolled flag loop (no dependency); normalise a valid `--as-of` to canonical `...Z` form.
- [ ] **Step 4:** Run the same command. Expected: all PASS.
- [ ] **Step 5: Commit** `git add src/config.js test/config.test.js package.json && git commit -m "Add CLI config parsing"`

### Task 2: Time primitives

**Files:** Create `src/time.js`, `test/time.test.js`

**Interfaces:**
- Produces (all exported from `src/time.js`):
  - `toIsoZ(date: Date) -> string` canonical UTC string.
  - `resolveZone(zoneText: string|null, venueTz: string) -> { tz: string, via: 'stated'|'venue' } | { error: string }`
  - `localToUtc(ymd: string, hm: string, tz: string) -> string` (canonical UTC; handles DST)
  - `utcToLocal(utc: string, tz: string) -> { ymd: string, hm: string, weekday: number, label: string }` where `label` looks like `Tue 30 Jun 18:00 MST`.

- [ ] **Step 1: Write failing tests** in `test/time.test.js`:
  - `localToUtc('2026-06-20','18:00','America/New_York') === '2026-06-20T22:00:00Z'`; `localToUtc('2026-06-30','19:00','America/Phoenix') === '2026-07-01T02:00:00Z'`; `localToUtc('2026-06-27','23:30','America/Los_Angeles') === '2026-06-28T06:30:00Z'` (rolls into next UTC day).
  - `utcToLocal('2026-07-01T01:00:00Z','America/Phoenix')` gives `ymd '2026-06-30'`, `hm '18:00'`, `weekday 2`, `label 'Tue 30 Jun 18:00 MST'`.
  - `resolveZone('ET','America/Denver')` -> `{tz:'America/New_York',via:'stated'}`; also `Eastern`, `CT`/`Central` -> `America/Chicago`, `MT`/`Mountain` -> `America/Denver`, `PT`/`Pacific` -> `America/Los_Angeles`; `'hora de Denver'` with venue `America/New_York` -> `America/Denver`; `null` -> `{tz: venueTz, via:'venue'}`.
  - Phoenix cases: `resolveZone('MT','America/Phoenix')` and `('Mountain','America/Phoenix')` -> `{tz:'America/Phoenix', via:'venue'}`; `resolveZone('MST','America/Denver')` -> `{tz:'MST', via:'stated'}` (fixed UTC-7).
  - `resolveZone('Klingon time','America/Denver')` -> object with `error` matching `/Klingon/`.
- [ ] **Step 2:** Run `node --test test/time.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** in `src/time.js`. `localToUtc`: start from `Date.UTC` of the wall-clock fields, read the zone offset with `Intl.DateTimeFormat(...,{timeZone}).formatToParts`, adjust, and repeat once to settle DST. Zone table is a plain object keyed by lowercased wording; "hora de X" looks X up in a small city table (Denver, Chicago, New York, Los Angeles, Phoenix); the Phoenix-venue rule applies only to MT/Mountain wording.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Add time conversion primitives"` (after `git add src/time.js test/time.test.js`).

### Task 3: Claim time resolution and date wording

**Files:** Modify `src/time.js`, `test/time.test.js`

**Interfaces:**
- Consumes: Task 2 functions.
- Produces: `parseWeekday(text: string|null) -> number|null` (English and Spanish: `Saturday`, `sábado`, `martes`...); `parseExplicitDate(text: string|null, year: number) -> string|null` (`'Wednesday 8 July'`, `'July 18'` -> `'YYYY-MM-DD'`); `resolveClaimTime(claim: Claim, fixture: Fixture) -> Resolution`.
- Behaviour (spec section 5): date = explicit date in `dateText` else the feed's venue-local date (`utcToLocal(fixture.kickoff_utc, venue.timezone)`); zone via `resolveZone(claim.zoneText, venue.timezone)`; `working` gets one human line, e.g. `"7:00 PM" no zone stated -> venue zone America/Phoenix -> 19:00 MST on 2026-06-30 = 2026-07-01T02:00:00Z`. `dateCheck`: `'mismatch'` if weekday or explicit date differs from the feed's local date, `'ok'` if it matches, `'none'` if no readable date wording. If `dateCheck` is `'ok'` via weekday and the nearest such weekday on/after the evidence's local date differs from the feed's local date, add a caveat naming both dates (e.g. contains `23 Jun` and `30 Jun`). Unusable (null time, unknown zone) -> `utc:null` with `unusableReason`.

- [ ] **Step 1: Write failing tests** (use fixtures from `data/snapshot/fixtures.json`):
  - `parseWeekday('este sábado') === 6`, `('Saturday night') === 6`, `('martes') === 2`, `('tomorrow') === null`; `parseExplicitDate('Wednesday 8 July',2026) === '2026-07-08'`, `('Saturday',2026) === null`.
  - fx-2209 claim `{timeLocal:'19:00',zoneText:null,dateText:'Tuesday night',at:'2026-06-19T17:40:00Z'}` -> `utc '2026-07-01T02:00:00Z'`, `dateCheck 'ok'`, one caveat matching `/23 Jun.*30 Jun/`.
  - fx-2202 claim `{timeLocal:'19:00',zoneText:'hora de Denver',dateText:'este sábado',at:'2026-06-15T02:30:00Z'}` -> `utc '2026-06-21T01:00:00Z'`, `dateCheck 'ok'`, no caveats; same fixture with `{timeLocal:'21:00',zoneText:'Eastern',dateText:'Saturday night'}` -> same `utc`.
  - fx-2201 `{timeLocal:'18:00',zoneText:'ET',dateText:'Saturday'}` -> `'2026-06-20T22:00:00Z'`; fx-2209 claim with `dateText:'Friday'` -> `dateCheck 'mismatch'`; `timeLocal:null` and `zoneText:'Klingon'` each -> `utc:null` with non-empty `unusableReason`.
- [ ] **Step 2:** Run `node --test test/time.test.js`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the three functions in `src/time.js`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Add claim time resolution and date wording checks"`.

### Task 4: Source classification

**Files:** Create `src/sources.js`, `test/sources.test.js`

**Interfaces:**
- Produces: `classifySource(evidence: Evidence, fixture: Fixture) -> Source`.
- Rules (spec section 6): normalise names to lowercase alphanumerics and strip a trailing `fc`/`sc`/`afc` from team names. League: social display name equals the competition, or a web page whose `title` contains the competition -> `tier official, role league, org 'league'`. Club: verified social account whose handle or display name contains a participating team's name -> `official, club, org 'club:<team>'`; web page whose hostname (not path) contains a participating team's name -> `official, club_site`, same org. `feed_listing` -> `aggregator`. Other web pages and verified unaffiliated accounts -> `press`. Everything else (unverified) -> `unofficial`. `label` reads like `Harbour City FC (club, verified)`.

- [ ] **Step 1: Write failing tests** against real snapshot evidence: ev-2201-a on fx-2201 -> official/club/`club:harbourcity`; ev-2201-c -> official/league; ev-2205-b -> league; ev-2202-d (`@pacificcrown_es`) on fx-2202 -> `club:pacificcrown`; ev-2207-a and ev-2207-b share the same `org`; ev-2204-c -> aggregator; ev-2206-a (unverified) -> unofficial; ev-2206-b and ev-2202-c -> press; a verified `@CalderaFC` post evaluated against fx-2204 (Caldera not playing) -> press; a verified `@RandomPundit` -> press.
- [ ] **Step 2:** Run `node --test test/sources.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `classifySource` in `src/sources.js`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/sources.js test/sources.test.js && git commit -m "Add source classification"`.

### Task 5: Decision engine, part 1 (gates, insufficient evidence, evidence accounting)

**Files:** Create `src/decide.js`, `test/helpers.js`, `test/decide.test.js`

**Interfaces:**
- Consumes: shapes above.
- Produces: `decide({ fixture, items, unreadable, skipped }: { fixture: Fixture, items: Item[], unreadable: {evidenceId, source: Source, reason: string}[], skipped: {evidenceId, reason: string}[] }) -> Decision`. `test/helpers.js` exports `makeFixture(overrides)` (fx-2209-like, Phoenix) and `makeItem({ id, at, tier, role, org, utc, aboutFixture, isPostponement, isTbc, dateCheck, ...})` with sensible defaults.
- This task implements R1 (status not `scheduled` -> `out_of_scope`, rule `R1`, no evidence lines), R2, R7, R8 and the accounting rule: every item/unreadable/skipped id appears in exactly one of `evidenceUsed`/`evidenceNotUsed` (except out of scope). Not-used reasons: different match (`aboutFixture 'no'`), unclear, no kickoff time stated, unusable time (`unusableReason`), unofficial source, aggregator is informational only (say whether its time equals the feed), skipped (malformed). Evaluation order is spec section 6; R3-R6 come in Task 6, so here the engine falls through to R8 when R2/R7 don't fire.

- [ ] **Step 1: Write failing tests** in `test/decide.test.js`:
  - R1: `status:'postponed'` and `status:'cancelled'` and `status:'live'` -> `verdict 'out_of_scope', rule 'R1', suggestedUtc null`, empty evidence lists even with a strong official item.
  - R2: scheduled fixture + official item `isPostponement:true` -> `needs_review`, rule `R2`, `suggestedUtc null`.
  - R7: only official item is `isTbc:true` -> `needs_review`, rule `R7`; an official kickoff item with a later `at` than the TBC item does not trigger R7 (falls through; Task 6 asserts the final verdict).
  - R8: no items -> `insufficient_evidence`, rule `R8`; unofficial + press + aggregator items only -> `insufficient_evidence`, `suggestedUtc null`, and when the aggregator utc differs from `fixture.kickoff_utc` the reason mentions ScoreFeed.
  - Accounting: for a mixed set (`aboutFixture:'no'` item, unofficial item, a skipped id), union of used+notUsed ids equals the input ids, with no duplicates, and each not-used `note` is non-empty.
- [ ] **Step 2:** Run `node --test test/decide.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the above in `src/decide.js`, building `EvidenceLine` objects from `item.claim`, `item.source.label` and `item.resolution.working`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/decide.js test/ && git commit -m "Add decision engine gates and evidence accounting"`.

### Task 6: Decision engine, part 2 (R3-R6, confidence, guard G1)

**Files:** Modify `src/decide.js`, `test/decide.test.js`

**Interfaces:** Consumes Task 5's `decide`. Adds no new exports.
- Behaviour (spec section 6): usable official item = tier `official`, `aboutFixture 'yes'`, `resolution.utc` set, not postponement/TBC. R3: group by `source.org`, latest `at` wins (tie -> higher `evidenceId`); same-org items with the same utc are `evidenceUsed` (counted once); same-org older items with a different utc go to `evidenceNotUsed` as superseded. R6: any winning claim with `dateCheck 'mismatch'` -> `needs_review`, rule `R6`, `suggestedUtc` = that claim's utc. R4: winners' utcs differ -> `needs_review`, rule `R4`, `suggestedUtc` = utc of the latest winner. R5: all equal; equal to `fixture.kickoff_utc` -> `confirmed` (`suggestedUtc null`) else `change_recommended` (`suggestedUtc` = agreed utc). Confidence: `high` if >=2 orgs or a press item with the same utc; else `medium`; `null` for other verdicts. Press agreeing -> used (supports); press differing -> not used. Caveats = deduped `resolution.caveats` of used items. G1: any `unreadable` entry with `source.tier 'official'`, or any official item with `aboutFixture 'unclear'`, turns a would-be `confirmed`/`change_recommended`/`insufficient_evidence` into `needs_review`, rule `G1`, `suggestedUtc null`, reason naming the unreadable evidence id and the verdict it replaced.

- [ ] **Step 1: Write failing tests**, using the spec section 11 values:
  - R5 change (fx-2201 shape): three official items from orgs `club:harbourcity`, `club:redvaleunited`, `league`, utc `2026-06-20T22:00:00Z`, feed `...T20:00:00Z` -> `change_recommended`, `suggestedUtc '2026-06-20T22:00:00Z'`, `confidence 'high'`.
  - R5 confirmed (fx-2202 shape): two orgs agree with the feed -> `confirmed`, `suggestedUtc null`, `high`.
  - R3 (fx-2204 shape): one org with an earlier claim `2026-06-23T22:00:00Z` and a later `2026-06-24T00:30:00Z`, feed `...T00:00:00Z`, plus an aggregator item at `22:00:00Z` -> `change_recommended`, `suggestedUtc '2026-06-24T00:30:00Z'`, `medium`; earlier claim in `evidenceNotUsed` with a note containing `superseded`; aggregator in not-used.
  - Same org account + site agreeing (fx-2207 shape) -> one org, `medium`, both items in `evidenceUsed`.
  - Press agreement (fx-2209 shape): one official org + press with equal utc -> `high`; press with a different utc -> `medium`.
  - R4 (fx-2205 shape): club `2026-06-28T01:00:00Z` at 15 Jun, league `2026-06-28T01:30:00Z` at 16 Jun -> `needs_review`, rule `R4`, `suggestedUtc '2026-06-28T01:30:00Z'`, `confidence null`; with the club later than the league the suggestion is the club's value.
  - R6: winning claim `dateCheck 'mismatch'` -> `needs_review`, rule `R6`.
  - G1: an `unreadable` official entry plus a would-be `change_recommended` -> `needs_review`, rule `G1`; same with an official `aboutFixture:'unclear'` item; an `unreadable` unofficial entry changes nothing.
  - R7 not triggered when a later official kickoff claim follows the TBC notice (verdict then comes from R5).
- [ ] **Step 2:** Run `node --test test/decide.test.js`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** R3-R6, confidence and G1 in `src/decide.js` (G1 is a final override after the other rules).
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Add official-claim rules, confidence and G1 guard"`.

### Task 7: Urgency and ranking

**Files:** Create `src/rank.js`, `test/rank.test.js`

**Interfaces:**
- Produces: `hoursToKickoff({ feedUtc, suggestedUtc, asOf }) -> number` (hours to the earlier of feed and suggested; suggested may be null); `urgencyBand(hours) -> 'critical'|'soon'|'later'|'past'`; `rankResults(results: FixtureResult[], asOf: string) -> { actionable: RankedItem[], others: FixtureResult[], past: RankedItem[] }` where `RankedItem = { result: FixtureResult, hours: number, band: string, beyondGuide: boolean }`.
- Actionable = `change_recommended` or `needs_review`. Sort: band (critical, soon, later), hours ascending, `needs_review` before `change_recommended`, confidence high before medium, then fixture id ascending. `beyondGuide` is true from the sixth item on (index >= 5). Past-kickoff actionable items go to `past`. `others` = confirmed, insufficient, out of scope, could-not-check, in fixture id order.

- [ ] **Step 1: Write failing tests:** `hoursToKickoff` for fx-2201 (`feedUtc 2026-06-20T20:00:00Z`, `suggestedUtc ...22:00:00Z`, `asOf 2026-06-20T08:25:00Z`) is within 0.01 of 11.58; with `suggestedUtc` earlier than feed the earlier is used; `urgencyBand`: `23.9 -> critical`, `24 -> soon`, `71.9 -> soon`, `72 -> later`, `-1 -> past`. Using the nine spec section 11 results in shuffled order (include fx-2209 before fx-2208), `actionable` ids are `['fx-2201','fx-2204','fx-2207','fx-2208','fx-2205','fx-2209']` with `beyondGuide` true only for fx-2209; equal hours puts needs_review first and then orders by id; a kicked-off fixture lands in `past`.
- [ ] **Step 2:** Run `node --test test/rank.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** in `src/rank.js`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/rank.js test/rank.test.js && git commit -m "Add urgency ranking"`.

### Task 8: API client and evidence sources

**Files:** Create `src/api.js`, `test/api.test.js`

**Interfaces:**
- Produces:
  - `class ApiError extends Error { reason: string }`
  - `fetchWithRetry(url: string, init?: RequestInit, opts?: { fetchFn?, timeoutMs = 8000, retries = 3, sleep?, random? }) -> Promise<any>` (parsed JSON). Delays `500 * 2**attempt` plus `random() * 250`; `Retry-After` seconds override; non-retryable 4xx and malformed JSON throw `ApiError` immediately; exhausted retries throw `ApiError` whose `reason` names the last status/failure.
  - `normalizeEvidence(raw: unknown) -> { items: Evidence[], skipped: {evidenceId: string|null, reason: string}[] }`; throws `ApiError('malformed evidence response')` if `raw.evidence` is not an array. Skips items missing `id`/`type`, an unknown `type`, a social post without `text`, a web page without `snippet`, or a feed listing without `listed_kickoff_utc`.
  - `createLiveSource(config: Config, fetchFn?) -> EvidenceSource` and `createSnapshotSource(dir: string) -> EvidenceSource`, where `EvidenceSource = { kind: 'live'|'offline-snapshot', listFixtures(): Promise<Fixture[]>, getEvidence(id: string): Promise<{ items: Evidence[], skipped: ... }> }`. Both throw `ApiError` on failure. The snapshot source reads `fixtures.json` and `evidence-<id>.json`.

- [ ] **Step 1: Write failing tests** with a fake `fetchFn` and injected `sleep`/`random`: 503 then 200 returns the body in 2 calls, recorded delays `[500]` with `random: () => 0`; 429 with `Retry-After: 2` waits 2000; a fetch that never resolves but honours `AbortSignal` rejects after `timeoutMs: 20` and is retried; 404 makes 1 call and throws; always-503 makes 4 calls and throws `ApiError` with `reason` matching `/503/`; 200 with invalid JSON throws `ApiError` matching `/malformed/`. `normalizeEvidence`: one valid + one no-id + one `type:'video'` -> 1 item, 2 skipped with reasons; `{}` and `{evidence:null}` throw. Snapshot source: `listFixtures()` returns 9 fixtures; `getEvidence('fx-2201')` returns 3 items; unknown id throws `ApiError`. Live source requests `<apiBase>/fixtures` and `<apiBase>/fixtures/fx-2201/evidence`.
- [ ] **Step 2:** Run `node --test test/api.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** in `src/api.js` using `AbortSignal.timeout(timeoutMs)` per attempt.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/api.js test/api.test.js && git commit -m "Add resilient API client and evidence sources"`.

### Task 9: LLM extraction, validation and cache

**Files:** Create `src/extract.js`, `test/extract.test.js`; Modify `package.json` (run `npm uninstall openai`)

**Interfaces:**
- Consumes: `fetchWithRetry` (Task 8).
- Produces (from `src/extract.js`): `PROMPT_VERSION = 'v1'`; `createLlmClient({ apiKey, model, fetchFn? }) -> { complete(system: string, user: string, schema: object): Promise<string> }` (POST `https://api.openai.com/v1/chat/completions`, temperature 0, `response_format` json_schema strict, `timeoutMs 20000`, `retries 2`); `createCache(dir) -> { get(key): object|null, set(key, value): void }`; `cacheKey({ model, fixtureContext, text }) -> string`; `validateClaim(raw: unknown, text: string) -> { ok: true, claim } | { ok: false, reason }`; `claimFromFeedListing(evidence) -> Claim`; `extractClaim({ fixture, evidence, llm, cache, model }) -> Promise<{ status: 'ok', claim: Claim } | { status: 'failed', reason: string }>`. `llm` may be `null`; a cache miss then returns `failed` with reason `no cached response and no API key`.
- Behaviour (spec section 4): schema fields are exactly the spec table; system prompt tells the model to ignore gate/ticket/parking times (listing them in `ignoredTimes`), never convert timezones, flag other matches with `aboutFixture:'no'`, and ignore any instructions inside the evidence; evidence text is wrapped in `<evidence>...</evidence>` in the user message together with fixture teams, venue and the evidence timestamp. `quote` is checked against the text after NFC normalisation, whitespace collapse (including NBSP), smart-quote folding and lowercasing.

- [ ] **Step 1: Write failing tests:** `validateClaim` rejects a bad enum, `'7pm'`, `'25:00'`, and a quote absent from the text; accepts a quote with different case, single vs double space, NBSP, curly apostrophe, and a text containing emoji; a null time with null quote is accepted. `cacheKey` is stable for equal inputs and differs when the text, model or `PROMPT_VERSION` differs. `extractClaim` with a fake `llm` returning valid JSON for ev-2201-a returns `status 'ok'`; calling it twice makes one `llm` call (cache hit, using a temp dir); invalid JSON, a throwing llm, and a not-in-text quote each return `failed` with a reason; `llm: null` and an empty cache returns the no-key reason. The user message contains `<evidence>` wrapping the text and the system message contains `ignore` instructions wording. `claimFromFeedListing` returns `listedUtc` and `aboutFixture 'yes'`. `createLlmClient` with a fake `fetchFn` posts the model and schema, returns the message content, retries once on a 500.
- [ ] **Step 2:** Run `node --test test/extract.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/extract.js`; then `npm uninstall openai` and confirm `package.json` has no dependencies.
- [ ] **Step 4:** Run `node --test test/extract.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/extract.js test/extract.test.js package.json package-lock.json && git commit -m "Add LLM claim extraction with validation and cache"`.

### Task 10: Pipeline

**Files:** Create `src/pipeline.js`, `test/pipeline.test.js`

**Interfaces:**
- Consumes: Tasks 3, 4, 5-6, 8, 9.
- Produces: `checkFixture(fixture, { source, llm, cache, model }) -> Promise<FixtureResult>`; `mapLimit(items, limit, fn) -> Promise<R[]>` (results in input order); `runAll({ source, llm, cache, model, concurrency }) -> Promise<{ results: FixtureResult[], latestEvidenceAt: string|null }>`.
- Behaviour: a fixture whose `status !== 'scheduled'` returns an R1 result via `decide` without calling `source.getEvidence`; `getEvidence` throwing returns `{ status:'could_not_check', reason: 'API unavailable (<reason>)' }`; for each evidence item: classify, extract (`feed_listing` skips the LLM), resolve with `resolveClaimTime`, build `items`; failed extractions become `unreadable` (with their classified source) and `skipped` ones pass through. `runAll` never rejects because of one fixture; fixture-list failure is allowed to throw. `latestEvidenceAt` is the max timestamp across all fetched evidence (used for the default `--as-of`).

- [ ] **Step 1: Write failing tests** with fake `source`/`llm`: status `cancelled` makes zero `getEvidence` calls and yields `out_of_scope`; `getEvidence` rejecting for one fixture gives `could_not_check` for that one only while others complete; an llm that throws for an official post gives `needs_review` rule `G1`; the same throw for a fan post leaves the verdict unchanged; `mapLimit` never exceeds 3 in-flight and returns results in input order; empty evidence gives `insufficient_evidence`; `latestEvidenceAt` equals the maximum timestamp.
- [ ] **Step 2:** Run `node --test test/pipeline.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/pipeline.js`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/pipeline.js test/pipeline.test.js && git commit -m "Add per-fixture pipeline with failure isolation"`.

### Task 11: Report

**Files:** Create `src/report.js`, `test/report.test.js`

**Interfaces:**
- Consumes: `rankResults` (Task 7), `utcToLocal` (Task 2).
- Produces: `buildReportModel(results: FixtureResult[], { asOf: string, sourceKind: 'live'|'offline-snapshot' }) -> ReportModel`; `renderMarkdown(model) -> string`; `renderJson(model) -> string`; `writeReport(model, outDir: string) -> Promise<{ mdPath, jsonPath }>`. Output is deterministic (no generation timestamp).
- Model (spec section 8): `{ meta: { asOf, source }, tally: { actionable, guide: 5, confirmed, insufficient_evidence, out_of_scope, could_not_check }, actionable: Item[], past: Item[], others: {...}[] }`; each actionable item has `rank, fixture (id, home, away, competition, venue), verdict, rule, urgency {band, hours}, confidence, feed {utc, local}, suggested {utc, local}|null, reason, evidence_used, evidence_not_used, caveats, last_verified_at, beyond_guide`. Markdown shows header (`OFFLINE SNAPSHOT` banner when offline, API failures called out), the numbered list with the divider line `beyond the usual five a day, lower urgency` before the sixth item, per-item `Evidence used` / `Evidence not used` blocks (with `ignoredTimes` as a short note), a `Caveats` block, a past-kickoff line, and a compact table for others with a one-line reason each.

- [ ] **Step 1: Write failing tests** using the nine section 11 results (build them in the test): header contains `OFFLINE SNAPSHOT` only when `sourceKind` is offline and tally text states `6` actionable against the guide of `5`; Markdown contains `Evidence used` and `Evidence not used`, the divider text appears exactly once and sits after item 5 and before fx-2209; the fx-2201 block shows both `20:00Z` and the local `16:00 EDT` for the feed time; JSON parses and has `evidence_used`, `evidence_not_used`, `meta.source === 'offline-snapshot'`; a `could_not_check` result appears in the header and in the others table; `writeReport` writes both files to a temp dir.
- [ ] **Step 2:** Run `node --test test/report.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/report.js`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/report.js test/report.test.js && git commit -m "Add Markdown and JSON report"`.

### Task 12: Entry point, recorded LLM cache and golden test

**Files:** Create `index.js`, `test/golden.test.js`, `test/cli.test.js`, `README.md`, `data/llm-cache/*.json` (generated)

**Interfaces:**
- Consumes: everything above.
- Produces: `main(argv, env, deps?) -> Promise<number>` exported from `index.js` (returns the exit code; prints the Markdown report to stdout; prints errors to stderr; runs only when executed directly). Flow: `loadEnv`, `parseArgs`, choose source (`createSnapshotSource` when `--offline`), build `llm` only if `openaiKey` is set, `runAll`, `asOf = config.asOf ?? latestEvidenceAt`, `buildReportModel`, `writeReport`. Fixture-list failure or bad flags print one clear line and return non-zero.

- [ ] **Step 1: Write failing tests.** `test/golden.test.js`: run `runAll` + `buildReportModel` offline on `data/snapshot` with `as-of 2026-06-20T08:25:00Z` and an `llm` that throws if called (cache only); assert `latestEvidenceAt === '2026-06-20T08:25:00Z'` and the spec section 11 table (verdict, rule, `suggestedUtc`, `confidence` per fixture) and the actionable order `fx-2201, fx-2204, fx-2207, fx-2208, fx-2205, fx-2209` with only fx-2209 `beyond_guide`; assert fx-2203 has no suggested time and no evidence lines, and that ev-2207-c (different match) is in fx-2207's `evidence_not_used`. `test/cli.test.js`: spawn `node index.js --offline --out <tmpdir>` with an empty `OPENAI_API_KEY`, expect exit 0 and both report files; `--as-of nonsense` expects a non-zero exit and a stderr line mentioning `--as-of`.
- [ ] **Step 2:** Run `node --test test/golden.test.js test/cli.test.js`. Expected: FAIL (no `index.js`, no cache).
- [ ] **Step 3: Implement** `index.js`.
- [ ] **Step 4: Record the cache.** With the real key in `.env`, run `node index.js --offline --out /tmp/pk-out`; this fills `data/llm-cache/`. Read the printed report against spec section 11. If an LLM extraction differs from the expectation, fix the prompt in `src/extract.js`, bump `PROMPT_VERSION` to `'v2'`, delete `data/llm-cache/`, and rerun; do not edit the golden expectations to match the model.
- [ ] **Step 5:** Run `npm test`. Expected: all tests PASS with no network and no key (unset `OPENAI_API_KEY` to confirm).
- [ ] **Step 6: Write `README.md`** (what it does, `npm start`, flags, `--offline`, key setup, `npm test`, where the report lands; under 40 lines).
- [ ] **Step 7: Commit** `git add index.js README.md data/llm-cache test/ && git commit -m "Add entry point, recorded LLM cache and golden test"`.

### Task 13: NOTES.md

**Files:** Create `NOTES.md`

- [ ] **Step 1:** Write `NOTES.md` (under 120 lines) with the five sections the brief requires, drawing on spec sections 2, 6 and 12 and on the actual run: requirements gathered and assumptions; key design decisions (tiered rules, source weighting, conflict handling, output design, LLM only extracts); surprises in the data and how each was handled; pushback (five-a-day cap, ScoreFeed circularity, review-on-every-club-vs-league); what was set aside; what to do with more time. Use real numbers from the final report. Do not include anything from `decisionslog.md`.
- [ ] **Step 2:** Run `npm test` and `npm start -- --offline` once more; confirm the NOTES.md claims match the output.
- [ ] **Step 3: Commit** `git add NOTES.md && git commit -m "Add NOTES.md" && git push origin main`.
