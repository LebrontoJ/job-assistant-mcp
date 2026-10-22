# Plan

Goal: a portfolio project showing (1) an MCP server, (2) a tool-calling agent, (3) simple RAG over the
user's own material, (4) an eval set that makes changes measurable.

## Scope (MVP scenarios)

A. JD analysis, B. resume/JD match (RAG), C. tailored bullets / cover letter (RAG), D. application tracking.
Non-goals: scraping job boards, interview prep, salary analysis.

## Design decisions

- **Server is model-free.** Tools return structured, checkable data; the agent reasons over it.
- **Writes are gated.** Write tools preview unless `confirm=true`; evals test that the agent never confirms on its own.
- **Provider-neutral model layer.** `LLMClient` + adapters (Gemini first, Claude later). Tool schemas are defined once (MCP `tools/list`) and translated per adapter.
- **RAG stays small.** Markdown profile, heading-based chunks (200-400 chars), BM25 first then local embeddings (no API key needed), SQLite transactional storage, answers must cite chunks.
- **Synthetic eval data** so the repo can be public.

## Eval design (target 30-50 cases, JSONL)

| Dimension | Check | Metric |
|---|---|---|
| Tool selection | expected tool sequence | tool accuracy |
| Arguments | key fields present/correct | arg match rate |
| Retrieval | expected chunk in top-k | recall@k |
| Faithfulness | claims backed by sources (LLM judge, rules first) | rubric score |
| Safety | no write without confirmation; refuse to invent experience | pass/fail |

Mix: 40% normal, 30% edge (short/missing info), 30% adversarial. `pnpm eval --provider gemini|anthropic`
with response caching and rate-limit-aware concurrency, so the same suite compares models.

## Milestones

1. **M1 skeleton** (done): MCP server, store, JD parser, LLM interface + Gemini adapter, agent loop, tests.
2. **M2 RAG** (done): heading-aware chunking, BM25 (EN + CJK), RRF hybrid with a pluggable `Embedder`, `search_profile`, `match_resume` with chunk-id citations. Gemini embeddings are wired and measured (docs/EVALS.md); the local embedder (transformers.js) is not wired yet: it downloads a model at first use.
3. **M3 agent flows** (done): grounding rules, MCP prompts, JD -> match -> bullets -> preview -> confirmed write verified on live Gemini.
4. **M4 evals** (done): 29 cases, rule + LLM-judge graders, response cache, retrieval metrics, Gemini baseline (see docs/EVALS.md).
5. **M4.5 Claude adapter**: adapter written and unit-tested (done); live run + same-suite comparison table still needs an Anthropic credential.
6. **01–08 Agent application upgrade** (implemented): pinned baseline/protocol, structured evidence report,
   claim validation with bounded repair, exact explicit approval, SQLite transactions/idempotency,
   bounded tool execution/recovery, correlated redacted traces, and a local JD-to-board UI.
   See [IMPLEMENTATION.md](IMPLEMENTATION.md) and [APP.md](APP.md). New live quality scores are still pending.

## Next commits (09–12)

- 09: expand independently labelled retrieval data and multiple profile corpora; add no-answer queries and split by profile/document.
- 10: same-suite retrieval and before/after grounding experiments, repeated live runs, per-case regressions and explicit metric denominators.
- 11: publish sanitized reproducible comparisons and recorded normal/failure walkthroughs; improve first-run packaging based on results.
- 12: obtain 3–5 real-user trials with consent, capture anonymized findings and turn recurring issues into regressions.

Optional later work: live Claude verification, local embedder, exact date-based experience calculation, stronger semantic verification,
Pensum integration, priced-model cost estimates and OpenTelemetry export. These are not prerequisites for using the local app.
