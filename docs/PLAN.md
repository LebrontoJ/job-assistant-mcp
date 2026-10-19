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
- **RAG stays small.** Markdown profile, heading-based chunks (200-400 chars), BM25 first then local embeddings (no API key needed), SQLite or JSON storage, answers must cite chunks.
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
6. **M5 iterate + polish**: one measured improvement round, README demo and results.

## Open items

- Run the suite on Claude (agent and, separately, judge) and publish the comparison table; until then the Claude path is untested live.

- Held-out prompts for `inflate_experience`-style failures before touching the prompt; a stronger or non-Gemini judge; grow adversarial and faithfulness cases.
- Observability follow-ups: OpenTelemetry export, cost estimates when running a priced model, embedding-call latency.

- Local embedding model (no key needed); grow the retrieval and match sets and the corpus so recall@k and the match numbers mean something.
- `match_resume` flags quantities (years) but does not compute them; a date parser over the profile could.
- Recognising paraphrased `supported` requirements needs more than cosine similarity (a reranker or an LLM check over the retrieved passage, measured on the same labelled set).

- Verify the Gemini adapter against the live API (needs a key); confirm the free-tier model ID and quota in AI Studio.
- Pensum JSON compatibility for the tracker store.
