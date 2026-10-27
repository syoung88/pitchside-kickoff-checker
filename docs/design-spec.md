# Design spec

Status: DRAFT. To be agreed section by section before any code is written. `NOTES.md` is written from this once agreed.

## Settled so far
- Recommend-only: the tool never writes to the production feed.
- LLM extracts structured claims from evidence text; deterministic code does timezone conversion, source weighting and verdicts.
- Plain Node (>=20), built-in `fetch` and `Intl`, plus the `openai` package.
- Configurable `--as-of` time, defaulting to just after the latest evidence timestamp.
- Postponed/cancelled fixtures are listed as out of scope with no time recommended.
- Ambiguous relative dates (e.g. "this Saturday" disagreeing with the feed date) go to needs review.
- Report ranked by urgency x confidence; top five in "act now", the rest in a compact "also noted" section, nothing hidden.
- Output: Markdown to terminal and `report.md`, plus `report.json`.
- LLM responses cached locally (keyed by evidence id and text) so reruns and tests are deterministic and keyless.

## To design
1. Data flow and modules
2. Claim schema (what the LLM returns)
3. Timezone and relative-date resolution
4. Source weighting and conflict rules
5. Verdicts (confirmed / change recommended / needs review / insufficient evidence) and confidence
6. Urgency ranking and the five-flag cap
7. Report format
8. API resilience (timeouts, retries, per-fixture failure handling)
9. Testing approach
