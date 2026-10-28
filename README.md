# Pitchside kickoff checker

Checks every monitored fixture's kickoff time against the evidence Pitchside has gathered and tells the ops team what to do. It only recommends: it never writes to the feed.

Each fixture ends up as one of: **confirmed**, **change recommended**, **needs review**, **insufficient evidence** (postponed/cancelled fixtures are out of scope and never get a time). Every recommendation shows the evidence used and not used, who said it, when, and the local-to-UTC conversion. See `docs/design-spec.md` for the rules and `NOTES.md` for the decisions behind them.

## Run

```
npm start                      # live API; needs OPENAI_API_KEY in .env (copy .env.example)
npm start -- --offline         # saved API responses in data/snapshot; needs no key (uses data/llm-cache)
npm start -- --as-of 2026-06-20T08:25:00Z --out ./output
```

- `--as-of`: reference time for urgency. Default: the latest evidence timestamp (the sample data is from June 2026).
- `--offline`: reads `data/snapshot/`. It is never an automatic fallback: if a live call fails, that fixture is reported "could not check". Offline reports carry an `OFFLINE SNAPSHOT` banner.
- `--out`: where `report.md` and `report.json` are written (default `./output`). The Markdown report is also printed.

## Test

```
npm test        # no network and no API key needed
```

The golden test replays the nine sample fixtures from recorded LLM answers in `data/llm-cache/` and checks every verdict and the ranking.

## Layout

`index.js` entry point; `src/` api, extract (LLM + cache), time, sources, decide, rank, pipeline, report; `test/`; `data/snapshot/` raw API responses; `data/llm-cache/` recorded LLM answers.
