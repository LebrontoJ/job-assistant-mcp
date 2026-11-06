# JD parsing implementation validation — 2026-11-06

The parser now uses Gemini structured output with source validation and the original regex parser as fallback.
Personal Markdown chunking and indexing were not changed. All 255 automated tests, TypeScript checking and the build pass.
Tests use injected fake SDK responses; live evaluation sends synthetic JD text only.

## Small development-set comparison

Model: `gemini-3.1-flash-lite`, parser protocol: `jd-v1`. Eight manually labelled synthetic cases cover English headings,
Chinese prose/headings, nonstandard prose, multiple experience requirements, unfamiliar skills, symbols, missing requirements
and an embedded malicious template note. This is a development set, not an independent test set or a population estimate.
Matching ignores case, punctuation and whitespace; semantic paraphrases do not count as exact extracts.

| Metric | Original rules | Gemini + fallback, warm run | Gemini + fallback, cold run |
| --- | --- | --- | --- |
| Scalar fields correct | 31/40 (77.5%) | 38/40 (95%) | 33/40 (82.5%) |
| Mandatory requirement recall | 7/12 (58.3%) | 11/12 (91.7%) | 9/12 (75%) |
| Mandatory requirement precision | 7/7 (100%) | 11/11 (100%) | 9/9 (100%) |
| Preferred qualification recall | 2/5 (40%) | 4/5 (80%) | 3/5 (60%) |
| Responsibility recall | 2/5 (40%) | 4/5 (80%) | 3/5 (60%) |
| Skill recall | 9/18 (50%) | 15/18 (83.3%) | 14/18 (77.8%) |
| Fallback cases | — | 1/8 | 4/8 |

The warm run reused one previously cached successful extraction and made seven new API calls. The cold run disabled disk caching,
made eight calls and used the configured 10s budget. Four cold cases accepted Gemini output, three timed out and one failed
source validation; all four failures returned rule results. Cold p50 was 5927ms, p95 10006ms, including fallbacks.
The cold run reported 1229 input and 704 output tokens; requests that timed out without provider usage are not included in token totals.

On the cold run's four accepted Gemini cases, scalar accuracy was 20/20, requirements 8/8, preferred qualifications 3/3,
responsibilities 3/3 and skills 11/11. These denominators exclude the four fallback cases; they must not be used as the overall success rate.
The warm run also omitted one expected skill in the injection case. Source-presence validation does not prove semantic correctness,
complete extraction, or universal injection resistance. An evidence rejection is not automatically a hallucination.

Both runs improve end-to-end requirement recall on this small set, but API latency changes how much improvement reaches users.
The original 10s fallback budget remains in place; increasing the budget above 12s requires revisiting the 15s MCP tool deadline.
No extra retry or model-switch path was added to improve the benchmark score.

## Reproduce

```bash
pnpm eval:jd                              # offline rules, no key needed
pnpm eval:jd --live                       # configured Gemini, may reuse disk cache
JD_PARSER_CACHE_DIR=off pnpm eval:jd --live # cold calls, synthetic data only
pnpm exec vitest run
pnpm typecheck
pnpm build
```

`--limit=1` is available for a single-case smoke test. Live commands require `GEMINI_API_KEY`; free access depends on the
configured Google project's tier/quota. End-to-end and API-success-only metrics and denominators are printed separately.
[Recorded summaries and per-case metadata](assets/jd-parsing-comparison-2026-11-06.json) include both runs. The warm run preceded
the failed-response token-accounting fix, so its failed-response usage is incomplete; use the cold run for known usage totals.

The subsequent PR review added regressions for Chinese duration matching and shared-call usage ownership; see [JD_PARSING_REVIEW.md](JD_PARSING_REVIEW.md). These fixes do not change the recorded extraction benchmark.
