# AGENTS.md

Guidance for coding assistants working in this repo.

## Brief
Build a small Node.js program for Pitchside Data, a sports data company that sells a fixture feed (matches, venues, kickoff times) to broadcasters, betting operators and apps. Kickoff times in the feed go stale when clubs and leagues move matches. The tool researches the available evidence, decides whether each monitored fixture's kickoff time is right, and produces a report telling the operations team what to do.

For each fixture the report must say: what the tool concluded about the kickoff time, what it recommends, why (grounded in the evidence), and how the evidence was weighed.

This is a job-interview challenge. It is assessed on decision-making and clear justification, not on how much is built. A smaller tool with well-explained decisions beats a bigger one that confidently answers everything.

## Data sources
- `GET https://everyday-sim-463015353641.us-east1.run.app/api/challenge/fixtures` returns `{fixtures: [...]}` with `id`, `competition`, `home`, `away`, `status`, `kickoff_utc`, `venue {name, city, timezone (IANA)}`, `last_verified_at`.
- `GET .../api/challenge/fixtures/{id}/evidence` returns `{fixture_id, evidence: [...]}`. Items are `social_post` (platform, account {handle, display_name, verified}, posted_at, text, likes), `web_page` (url, title, snippet, fetched_at) or `feed_listing` (provider "ScoreFeed", retrieved_at, fixture_name, listed_kickoff_utc).
- Evidence times are mostly free text in venue-local time, often with no zone, with relative dates ("this Saturday") and sometimes non-English. Some evidence is about a different match. Tool output needs a configurable "as-of" time because the data is from June 2026.

## Customer requirements (from Sam Kowalski, Head of Operations)
- **Recommend only.** The tool never writes to the production feed. The last tool did, shifted a match three hours from a stale aggregator time, and the customer lost a client. This is non-negotiable.
- **Source trust.** Verified club accounts are the most trusted single source. The league's official account is the final word on broadcast-driven changes and is often ahead of the club, but an older league page does not automatically beat a newer club post. Other sources: club websites and ScoreFeed (a licensed aggregator that can be stale). Fan accounts and blogs can only prompt a harder look at official sources, never justify a change alone.
- **Conflicts.** A club-versus-league disagreement goes to a human for review before anything changes.
- **Timezones.** A club's "7 PM" means stadium-local time, usually without a zone stated. The feed is UTC, so convert using the venue's IANA timezone (note Arizona has no daylight saving time).
- **Four distinct outcomes:** confirmed (officials corroborate the feed), change recommended, needs review, insufficient evidence. A fan rumour alone is "insufficient evidence".
- **Out of scope:** postponed or cancelled fixtures. Never recommend a time for them, even with strong official evidence of a new date.
- **Show the working.** Every recommendation shows what the evidence was, who said it, when, and why the tool concluded what it did, including the local-to-UTC conversion where it matters.
- **Urgency and queue size.** A suspected error close to kickoff is more urgent than one weeks away. The output goes to two analysts with about half an hour a day between them, so it must be skimmable and ranked by urgency or confidence. Around five fixtures flagged for human review on a normal day is the maximum. Forty flags is not help.

## Team guidance
- Evidence API is unreliable (occasional 503s, hangs for a few seconds). One bad call must not take down a run.
- Pulling the kickoff time out of raw social text is the fiddly part (emojis, gate-opening times, ticket deadlines).
- Weight who is speaking, not how often a time is mentioned.
- The customer must be able to see why for every recommendation, or they won't run the tool.

## Engineering notes
- Node.js; runnable with `npm start` (or `node index.js`).
- Use timeouts and retries on API calls and surface per-fixture failures in the report instead of aborting.
- An LLM (OpenAI API) is required for extracting kickoff times from raw evidence text. Keep LLM output structured and validated. Do the timezone conversion and decision logic in deterministic code, not in the model.
- Never commit secrets. The API key goes in `.env` (gitignored); provide `.env.example`.
- Keep the code small and clearly organised; match the style of surrounding code.

## Docs
`NOTES.md` is a deliverable covering requirements gathered and assumptions, key design decisions, surprises in the data, any requirement worth pushing back on, what was set aside, and what to do with more time. It is written after the design spec is agreed. Do not create it before then.

## Local-only files (gitignored, do not commit)
`brief_and_notes.md` and `fixtures-evidence-summary.md` may exist locally as reference material.
