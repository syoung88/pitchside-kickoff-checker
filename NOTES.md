# Notes

How to run it is in `README.md`; the full rules are in `docs/design-spec.md`. This file covers the thinking.

## 1. Requirements gathered and assumptions

I had eight questions with Sam (Head of Operations). What I took from the call:

- **Recommend only.** The last tool wrote a stale ScoreFeed time straight into production, shifted a match three hours and lost Pitchside a client. This tool never writes; it produces a report.
- **Four distinct answers:** confirmed, change recommended, needs review, insufficient evidence. Corroborated feed times are reported as confirmed, not only suspected errors.
- **Trust:** verified club accounts are the best single source; the league's account is final on broadcast-driven changes but an older league page doesn't automatically beat a newer club post; a club-vs-league disagreement goes to a human. Fan accounts and blogs only prompt a harder look.
- **Timezones:** a club's "7 PM" is stadium-local with no zone; the feed is UTC, so the conversion must be right and shown.
- **Out of scope:** postponed/cancelled fixtures, even with a clear new date. Never recommend a time for them.
- **Output:** show the working; rank by urgency; two analysts with about half an hour a day, so roughly five flags a day at most.

Assumptions where I had no answer: one clear statement from a verified club or the league is enough for "change recommended" (medium confidence); ScoreFeed agreeing with the feed never confirms it; press only supports official evidence; `last_verified_at` is shown but ignored, since I don't know what it means to Pitchside; any status other than `scheduled` is out of scope.

## 2. Key design decisions

- **The LLM only reads text; code decides.** The model turns each post or snippet into a structured claim (time as written, zone wording, date wording, a verbatim quote, and flags). Timezone conversion, source weighting and verdicts are plain functions, so the logic is testable and can be explained to Sam. A claim is discarded if its quote isn't in the source text or doesn't contain the stated time, which guards against invented times.
- **Tiered rules, not a score.** Sources are official (league, or a club in the fixture), aggregator, press or unofficial; the first is the only one that can justify a verdict. The verdict names the rule that fired (R1 to R9, G1, G2). I chose rules over weighted scores because a number can't be defended to an analyst, and the senior developer's note (weight who is speaking, not how often) maps directly onto tiers. A club's account and its own website count as one organisation, so repeating a time never adds weight.
- **Conflict handling.** The latest claim per organisation wins; club-vs-league disagreements go to review with the later value pre-filled; a day that doesn't match the feed's goes to review; a league "TBC" notice goes to review. A web page's timestamp is when it was crawled, not when it was published, so a page that disagrees with a post from the same organisation can't be ordered and goes to review (R9). An official post marked unconfirmed is never used as a time, but if it points away from the verdict it forces review (G2).
- **Fail loudly, not quietly.** If an official post can't be read (LLM failure, or the model can't tell what it's about), the verdict becomes needs review (guard G1) rather than confirming or staying silent. An API failure marks only that fixture "could not check". Offline mode is an explicit flag with a banner and never an automatic fallback, because silently using old data is the incident Sam described.
- **Output.** One ranked list, with the feed and suggested time in UTC and venue-local, then "Evidence used" and "Evidence not used" with a reason for each. Urgency uses the earlier of the feed and suggested kickoff. A fixture that has already kicked off but still has an unresolved verdict is shown first (PAST KICKOFF). A JSON copy is written alongside.

## 3. Surprises in the data

- **Weekday wording often points at a different week than the feed** (four of nine fixtures, e.g. "Tuesday" posted 19 Jun means 23 Jun, feed says 30 Jun). Posts name the opponent, so the match is identified. I check the weekday only, and show a week offset as a caveat; strict checking would have flagged half the list.
- **Arizona has no daylight saving.** A naive "Mountain" conversion for Phoenix is an hour out; the venue's IANA zone fixes it, and "Mountain" wording at a Phoenix venue means Phoenix time.
- **A tweet about a different match** (Caldera's 18 July game, in fx-2207's evidence) and gate/ticket/parking times sit next to real kickoff times. Both are listed as not used, with the reason.
- **The league account is named for one competition but speaks for another.** fx-2208 is a Founders Cup fixture and the notice comes from the Continental Soccer League account. The tool treats an account named after any monitored competition as that league.
- **ScoreFeed is stale or predates later notices on three fixtures,** and on fx-2204 it still shows the superseded 5 PM time.
- **fx-2203 is already postponed but `last_verified_at` predates the postponement posts.**
- **The API never failed for me** (every call 200 in about 0.5s), so retries, timeouts and 429 handling are tested with injected failures, not observed ones.
- **Web page timestamps are crawl times, not publish times.** The evidence gives `fetched_at` only, so an older page can look newer than a post. Pages are never used to supersede a post.
- **The model blurs flags and phrases.** It often ticks both "TBC" and "rumour" on one post, and it read "moved to 6 PM" (a same-day time change) as a postponement. Code sorts out the flags, and the prompt now separates same-day time changes from reschedules (prompt v4).
- **The model was cautious.** My first prompt made it say "unclear" on official posts that named no opponent. The G1 guard correctly turned those into reviews, which is how I caught it; I changed the prompt, not the expected results.

## 4. Pushback

- **The five-a-day cap.** On this list six fixtures need action, because most feed times are stale. A hard cut at five would hide a real correction, so the report keeps one ranked list with a divider after the fifth. Suggest measuring real daily volume in the pilot before treating five as a limit.
- **ScoreFeed may be circular.** If the feed is seeded from ScoreFeed, ScoreFeed agreeing proves nothing, which is why it never confirms. Worth asking Pitchside.
- **Reviewing every club-vs-league disagreement** is safe but adds to the queue even when the league explicitly overrides for broadcast. I kept it for the pilot; revisit with data on how often the later league value was right.

## 5. Set aside, and what I'd do with more time

**Set aside:** postponed and cancelled fixtures, any feed write-back, a UI, scheduling and alerts, and reading images in posts.

**Known limits:** a post from a club that names no opponent is read as being about this fixture (the weekday check is the backstop); zone wording is a fixed list (North American names, UTC/GMT/BST/CET, English and Spanish), and anything else makes the claim unusable, which forces review for an official post; a stated zone far from the venue with a very late time could land on the wrong calendar day (the report shows the resulting instant).

**With more time:** backtest the rules on past corrections and calibrate confidence; add a review-feedback loop so analysts' decisions refine the rules; handle more zone wording and languages; run on a schedule with alerts for critical items; test the retry logic against the real API's failure modes once they show up.

*Built with Claude Code, test-first. 165 tests, none of which need a network or an API key.*
