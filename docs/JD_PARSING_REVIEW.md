# JD parsing PR review — 2026-11-06

Scope: the complete Gemini JD extraction change, including configuration, source validation, caching,
cancellation, MCP integration, matching, UI metadata, traces and evaluation tooling.

## Findings fixed before commit

### [P2] Chinese duration requirements could be marked supported

The Gemini parser can now extract Chinese requirement prose, but `isQuantitative()` only recognized English
durations and plus-number expressions. With sufficient keyword overlap, `需要3年以上工作经验` was marked
`supported`, despite the tool's promise that retrieval does not verify years of experience.

Extended the quantitative guard to Chinese year/month expressions and numeric ranges. Added a retrieval
regression that first reproduced `supported` with coverage 1, and now requires `weak` plus the quantity note.
Detection checks also cover Chinese numerals, months and ranges.

Files: `src/server/match.ts`, `tests/match.test.ts`, `tests/match-semantic.test.ts`.

### [P2] Cancelling the first shared caller lost API usage accounting

Concurrent subscribers shared one extraction, but only the original subscriber could receive nonzero API usage.
If that subscriber cancelled, surviving subscribers received cache-style metadata with zero API calls/tokens,
so trace totals omitted an actual request.

Usage ownership now goes to the first surviving subscriber that consumes the completed result. Subsequent
subscribers and cache replays still report zero additional API usage. Strengthened the cancellation regression:
it reproduced zero calls/tokens before the fix and now verifies one call with its input/output usage.

Files: `src/parsing/service.ts`, `tests/jd-parsing.test.ts`.

## Final validation

- 25 test files, 255 tests passed.
- TypeScript typecheck and build passed.
- Git whitespace/diff check passed.
- No other commit-blocking finding identified in this review.

The eight-case live evaluation remains a small development sample. Free-tier latency and source-presence
validation's semantic limitations remain documented in `docs/JD_PARSING_EVAL.md`; these are not claims of
production-wide accuracy or complete prompt-injection resistance.
