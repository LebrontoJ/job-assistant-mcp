# Implementation 01–08

Each numbered item is a separate commit. This log records implementation and checks, not promised eval scores.

- 01: pinned pre-change source/suite hashes, fresh offline test/retrieval artifacts, separate development/held-out claim fixtures, comparison protocol. Initial baseline: 168 tests pass; typecheck passes. No new live calls.
- 02: added a bounded MCP JD task producing requirements, complete source passages, cited draft bullets, future suggestions and explicit limitations. Offline mode uses source extracts; model mode requests structured drafts. Task analysis does not write.
- 03: claim-level checks reject missing evidence and quantities borrowed from another event; narrowly normalised paraphrases work offline, novel wording uses a fail-closed semantic verifier. Structured drafts get at most two attempts; rejected claims are removed and model-written suggestions are replaced with grounded future actions. General chat now withholds drafts still failing citation/grounding checks after repair. Development regressions cover valid requests and failures; held-out cases were not used for tuning. Semantic verification remains probabilistic, not proof of truth.
- 04: previews now carry an operation id, full-payload digest and ten-minute expiry; the host accepts explicit approval only after that preview, rejects cancellation/ambiguity/reuse with altered fields, and supports `/approve <id>` plus trusted UI approval metadata. The MCP server rejects confirmed calls without the matching preview. Other MCP clients remain responsible for obtaining human approval; server operation ids alone do not prove consent.
- 05: migrated storage to Node 24 built-in SQLite with one-time, non-destructive JSON import, transactions, durable preview/operation ledger, canonical payload checks, cancellation, optimistic integer versions and unique business identity. Verified same-operation replay after restart, changed-payload rejection, stale preview rejection, and independent concurrent writer processes. 189 tests and typecheck pass.
- 06: shared task budgets, per-tool deadlines, cancellation propagation to MCP/model SDKs, classified bounded retries and bounded model calls/discovery/CLI connection. Only reads and confirmed durable operation ids retry; invalid/conflicting/unkeyed writes do not. Lost-response-after-commit test proves no duplicate. 194 tests and typecheck pass before CLI cleanup; CLI also now closes resources in finally. Scripts use `node --import tsx` to avoid tsx CLI IPC requirements.
- 07: correlated task/call/operation/attempt ids, individual retry and stage events, structured-task/model/claim-validation tracing, CLI connection and server profile/embedding stages, and default on-disk content redaction. Added discovery-failure/run-finalization, correlation and privacy regressions. Existing raw traces are not rewritten; MemoryTracer remains intentionally available to local graders.
- 08: delivered a local single-user Web app over real in-memory MCP transport: JD → evidence report → validated draft → exact preview → approve/cancel → persistent seven-stage board. Added stage-change previews, stale-version errors, idempotent decision retries, same-origin/session-token checks, bounded task caches, calendar-date validation, analysis cancellation and stale-JD invalidation. Extractive and live modes are explicitly labelled. Browser walkthrough on isolated synthetic data verified cancel kept 4 rows and approval produced exactly 5 rows; desktop and narrow layouts inspected. Screenshot: assets/app-board.png.

## Final validation (2026-10-22)

- `pnpm typecheck`, `pnpm build`, and `node --check src/app/public/app.js`: pass.
- `pnpm test`: 22 test files / 205 tests pass. Vitest explicitly excludes compiled duplicates by selecting tests/**/*.test.ts.
- `pnpm eval:retrieval`: unchanged BM25 recall@1 0.88, recall@3/5 0.92, MRR 0.92 on the original 12 queries. This upgrade did not optimize retrieval.
- `pnpm eval:claims`: 5/5 development factual fixtures; `pnpm eval:claims heldout`: 4/4 frozen final-audit fixtures. Future suggestions are excluded from factual entailment grading. These are tiny deterministic host-rule checks, not live model metrics. No tuning was performed after the held-out audit.
- Live drafting + semantic verification is exercised with a scripted model through the HTTP task API; no new paid/live model run or before/after live comparison was performed. Historical scores remain labelled historical.
- Remaining scope: expanded data and controlled comparisons (09–10), recorded production-model demos (11), real-user feedback (12). Semantic verification remains probabilistic; numeric experience duration is not calculated. New current-runtime success/faithfulness rates must be measured before claiming improvement.
- Compiled entrypoint smoke check: `node dist/src/app/index.js` returned HTTP 200 and recovered all 5 demo rows, including the confirmed example, from the same temporary database.

## Review fixes (single follow-up commit)

- Local claim acceptance now preserves word order and relations; numeric order is checked within the same supporting sentence. Arbitrary paraphrases require semantic verification. Multi-sentence verbatim lines are recognised as extracts, and offline outputs exclude rejected drafts.
- Experience checks also inspect ordinary questions and personal-experience language in answers. This remains a heuristic guard, not a proof that arbitrary natural-language claims are grounded. Semantic verification remains probabilistic.
- Citation parsing is shared and supports Unicode and spaces in bracketed filenames.
- Update previews return the displayed snapshot and bound version from the same SQLite transaction.
- CLI semantic verification shares the task deadline and cancellation signal, runs once per final candidate, and records a grounding stage.
- A rejected document-embedding promise is cleared so the next attempt can rebuild the index.
- Eval verdict rates exclude ungraded/run-error cases; overall completion is reported separately. Infrastructure failures are excluded from model stability verdicts.
- Tool statistics combine structured-task attempts by run/call id, preferring Agent call events when available to avoid double counting. Attempt-only durations sum execution time and exclude retry backoff.

Validation: 216 tests across 23 files, typecheck, build, development claims (5/5), frozen held-out claims (4/4), and unchanged BM25 retrieval metrics. Regression tests use isolated data and scripted models, not new live-model quality measurements.
