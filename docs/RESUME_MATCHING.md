# Requirement evidence assessment and matching agent

Implemented on `feat/strengthen-resume-match`. The application layer now separates retrieval signals from model evidence judgments. Gemini and Anthropic use the existing model adapters; no additional agent SDK or public MCP deployment is required.

## Use

```sh
# Offline: read-only retrieval signals and explicitly unassessed requirements
pnpm app
# Live drafting + one structured assessment batch at a time
APP_MODE=live MATCH_MODE=assessment pnpm app
# Live drafting + bounded supplementary search (default live matching mode)
APP_MODE=live MATCH_MODE=agent pnpm app
# Preserve the original retrieval-only comparison
APP_MODE=live MATCH_MODE=retrieval pnpm app
```

`MATCH_PROVIDER` / `MATCH_MODEL` override the existing `LLM_PROVIDER` / `LLM_MODEL` selection for matching. Credentials use the existing vendor configuration. Matching consumes private profile evidence in live mode, just as existing live drafting does. The comparison command below uses synthetic fixtures only.

Defaults: `MATCH_TOTAL_MS=90000`, `MATCH_CALL_MS=30000`, `MATCH_MAX_ROUNDS=2`, `MATCH_MAX_SEARCHES=6`. Configuration rejects out-of-range values. `MATCH_CACHE=off` disables the default bounded process-local cache. Matching has no disk evidence cache.

## Data flow and contract

1. The shared JD parser extracts the original mandatory/preferred strings.
2. `requirementsOf` assigns ids based on kind, position and text hash; explicit semicolon-separated clauses become criteria. Ambiguous conjunctions remain whole. The assessor must check all constraints within a compound criterion. This is not general semantic decomposition.
3. `match_resume({jd_text, include_evidence:true})` returns the original retrieval labels and an optional `evidenceBundle`. All existing top-level retrieval fields remain available. Its top-five candidates are reused to collect full evidence; the legacy labels still use the original top-three logic.
4. The application-layer `runMatching` batches requirements, obtains structured judgments and validates identities/quotes/completeness. The MCP tool never recursively runs the agent.
5. In agent mode a planner may issue only `search_profile` for unresolved requirement ids. Up to two rounds and six supplementary reads are allowed. Duplicate queries, unknown ids, tracker writes and recursive matching are blocked by the host. New tool evidence is consolidated into the next planning context instead of replaying growing raw histories.
6. Valid judgments survive later batch/repair/search failures. The UI displays per-requirement states, source quotes, explanations, missing information, and separate mandatory/preferred counts. Draft evidence prioritizes directly supported mandatory requirements, then partial coverage; unsupported/unassessed requirements cannot supply draft sources in assessment/agent modes.

The public reusable entry point is `src/matching/agent.ts:runMatching`. The web task API consumes it. The existing conversational CLI and `match_resume` tool remain retrieval tools rather than implicitly acquiring new model calls.

| Verdict | Meaning |
| --- | --- |
| supported | Evidence explicitly covers all constraints |
| partial | Some constraints are backed, other constraints are unresolved |
| insufficient | No adequate evidence; never proof the person lacks the ability |
| contradicted | Explicit evidence of incompatibility, not mere missing information |

Unassessed/failed/timeout/context-limited states have a null verdict, never a fabricated fallback semantic label. Duration constraints (including spelled-out English quantities) cannot become verified support through a model verdict alone; supported duration judgments are capped to partial and explicitly request independent duration verification. Non-duration counts such as a number of delivered projects are not subject to this duration-only cap. Requirements and preferred qualifications are counted separately. No hiring probability or model-generated percentage is emitted.

## Bounds, integrity and limitations

Initial evidence includes up to 40 requirements, 60 distinct complete passages and 50,000 source/heading/path characters. All original requirements remain in the report; omitted contexts are marked `context_limited`. A long passage is omitted rather than clipped. Supplemental search shares the same evidence limits. The 50,000-character allowance counts evidence, not JSON overhead or requirement/reason text. Existing retrieval labels may still be computed for additional requirements before the evidence budget is applied.

Matching runs outside the 15-second MCP tool deadline, inside a child of the task budget. When drafting is enabled, 60 seconds are reserved for subsequent drafting/verification; matching itself is capped to its configured budget and the available remainder. Supplementary reads receive cancellation signals and a bounded MCP executor. A lack of remaining phase budget yields unassessed results rather than claiming retrieval labels are semantic judgments. Remote embedding implementations may finish an already-started request after MCP cancellation.

Cache keys include the original bundle/corpus snapshot, model/provider, match protocol version, mode and search/batch limits. Source ids are validated against the actual packet, references must quote exact contiguous source text, and duplicate/unknown criteria and requirements fail validation. Cache replay reports zero incremental matching calls/tokens/searches. Incomplete execution, blocked planner calls, and provider/search failures are not cached, even when earlier judgments remain available. `meta.executionErrors` records failed or blocked execution stages; planner timeouts and search failures retain their stopping reason. This is a bounded local cache, not cross-process coordination; source changes rebuild the profile on restart as before.

Quote presence, schema compliance and a model explanation do not prove entailment. Model judgments can still mishandle negation, attribution, conflicting evidence and scope. The separate conservative draft validator remains enabled. Matching is advisory and requires source review. Requirement ids are scoped to the parsed JD; source hashes capture the evidence snapshot but do not replace a future stable corpus identity system.

Gemini uses `responseMimeType` / `responseJsonSchema`; Anthropic uses the SDK schema helper for `output_config.format`, which transforms unsupported constraints while local Zod validation enforces them. See [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output) and [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

## Evaluation

```sh
# Offline label baseline; no .env, SDK, network or private corpus loading
pnpm eval:matching
# Explicit live calls on synthetic fixtures; cache disabled
pnpm eval:matching --live --limit=2
pnpm eval:matching --live --repeat=3 --output=/tmp/matching-comparison.json
# Choose a single mode or audit the frozen acceptance split
pnpm eval:matching --live --mode=agent --split=heldout --repeat=3
```

There are 40 author-labelled synthetic development cases and 12 frozen acceptance cases, with hashes in `evals/matching/manifest.json`. They cover direct/qualified support, cross-language wording, incomplete compound requirements, project vs production, ownership, plans, negation, numerical event confusion, and injection. They are not independently labelled population evidence. The acceptance cases are frozen for a later final audit; development tests check their hash only.

The baseline maps `supported/weak/no_evidence` retrieval labels to `supported/partial/insufficient` only for comparison. This does not turn retrieval into actual semantic assessment. Its development exact match is **16/40**, false support **16/25** non-supported gold cases, support precision **10/26**, and rejected supported gold cases **5/15**. These deliberately difficult fixtures do not estimate deployment-wide accuracy.

Reports include denominators, exact match, false support, support precision, lost supported cases (including unfinished positives), operational completion, judgment completion, errors, model calls/tokens/searches, paired agent recoveries/regressions against single-assessment mode, and p50/p95. `goldEvidenceOverlap` is only a labelled source/quote overlap proxy, not a measured general semantic citation correctness rate. A planner/search failure remains an operational error even if its initial judgment was already completed. Live comparison reuses application `MATCH_*` timing/search settings and records them with the results. Run errors/unassessed cases remain visible in task coverage; zero denominators return null. Scripted model tests establish host behavior, not live answer quality. No new real-model comparison or live improvement claim accompanies this implementation.

## Implementation validation

- All 279 tests across 28 test files pass; typecheck, build, existing claim development checks and original retrieval/JD rule evaluations pass.
- Browser smoke on isolated synthetic data and a scripted assessor displayed all four judgment types. Cancelling left the tracker at zero records; confirming a fresh preview added one. This demonstrates UI/host integration, not model accuracy.
- A drafting failure after a completed assessment preserves the matching report and explicitly marks the draft unavailable.
- No new live provider-quality comparison was run. Use the explicit live commands above for repeated measurements before evaluating the frozen acceptance split.

![Scripted synthetic matching report and confirmed tracker record](assets/resume-matching-demo.jpg)

PR review follow-up: real MCP search scores are excluded from evidence identity, failed execution cannot poison the cache, and duration verification is separate from non-duration counts. Added eight reproducing regressions; all 287 tests across 29 files, typecheck/build and offline comparisons pass. See [RESUME_MATCHING_REVIEW.md](RESUME_MATCHING_REVIEW.md).
