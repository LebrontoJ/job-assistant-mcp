# Resume matching PR review — 2026-11-06

Scope: the complete `feat/strengthen-resume-match` diff against `main`, including matching contracts, MCP evidence collection, model adapters, the bounded agent, caching, task/UI integration, configuration and comparison tooling.

## Findings reproduced and fixed

1. **[P1] Real supplementary MCP hits were rejected.** `search_profile` includes score/coverage fields, while `addSources` spread the entire hit into a strict source schema. The real MCP integration regression returned `insufficient` after finding supporting text. Source construction now selects only id/source/heading/text; retrieval scores also no longer alter source hashes across searches.
2. **[P1] Failed agent execution could poison the result cache.** Initial judgments were all `assessed`, so a later planner or supplementary search failure was still cacheable. A subsequent attempt replayed the failure rather than retrying. The host now tracks execution errors and caches only fully assessed reports with an error-free terminal state. Tests cover planner recovery and search recovery.
3. **[P2] Stopping reasons concealed execution failure.** A search error could become `no_new_evidence`, while a planner timeout became `completed` simply because initial judgments existed. Failed/blocked stages retain their reason and a separate error count; existing judgments remain visible. The UI now explicitly reports retained results after failed/blocked execution.
4. **[P2] Duration enforcement both missed years and rejected unrelated counts.** Spelled-out `Five years` bypassed the cap, while the broad retrieval quantity detector incorrectly capped `At least 3 delivered projects` and requested duration verification. Assessment now uses a dedicated duration detector covering numeric/spelled English and Chinese durations, with a regression preserving supported non-duration counts. The legacy retrieval baseline is unchanged.
5. **[P2] Evaluation omitted planner/search errors once an initial judgment existed.** The comparison previously checked only item status, so an unavailable planner could still produce zero reported errors and a completed run. It now separates `judgmentCompleted` from error-free operational completion, and includes execution failures in operational errors/denominators.
6. **[P2] Live comparisons ignored application matching budgets.** The CLI created only a model, leaving `MATCH_TOTAL_MS`, `MATCH_CALL_MS` and search/round settings unused. It now reuses `createMatching`, explicitly disables the cache for independent samples and records the runtime configuration. A retrieval-only comparison does not instantiate a provider.

## Validation

- Eight new review regressions, including a real in-memory MCP server/client integration. The first six regressions failed before the fixes.
- 29 test files, 287 tests passed.
- TypeScript typecheck, build, browser JavaScript syntax check and Git diff whitespace check passed.
- Original BM25 retrieval remains Recall@1 0.88, Recall@3/5 0.92 and MRR 0.92.
- The 40-case development retrieval-label projection remains exact 16/40. This is not a live-model quality result.
- Frozen acceptance fixtures were not changed or semantically re-evaluated. No real-provider quality comparison was run.

No remaining merge-blocking issue was identified in this review. Model semantic judgments remain advisory: schema and quote validation do not establish entailment, and independent duration verification is still outside this change.
