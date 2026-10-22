# job-assistant-mcp

[![CI](https://github.com/LebrontoJ/job-assistant-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/LebrontoJ/job-assistant-mcp/actions/workflows/ci.yml) ![license](https://img.shields.io/badge/license-MIT-blue)

An MCP job-search assistant: a tool-calling agent over an MCP server, a lightweight RAG layer over
your own profile, and a small eval harness that tells you whether a change made things better.

> Status: **01–08 implemented**: local JD-to-board app, structured evidence reports, bounded claim repair,
> exact human approval, transactional/idempotent storage and correlated redacted traces.
> [Run the app](docs/APP.md) · [Implementation and checks](docs/IMPLEMENTATION.md) · [Next steps](docs/PLAN.md).
> Live scores in [docs/EVALS.md](docs/EVALS.md) are historical; no fresh live improvement claim is made for this upgrade.

## What works today

| MCP tool | Reads/writes | Notes |
|---|---|---|
| `parse_jd` | read | Deterministic JD structuring (sections, years, work mode, skills). No model inside the server. |
| `list_applications` | read | Filter by status / company. |
| `list_followups` | read | Open applications with a follow-up due in N days (overdue included). |
| `search_profile` | read | BM25 search over your Markdown profile; returns passages with citable chunk ids. Works for English and Chinese. |
| `match_resume` | read | Compares a JD to the profile: per requirement `supported` / `weak` / `no_evidence` with evidence ids and how each was matched (keyword / semantic), plus which JD skills are present or missing. |
| `add_application` | **write** | Returns a preview unless `confirm=true`; refuses duplicates. |
| `update_application` | **write** | Same confirm gate; unknown ids return an error the model can recover from. |

### About the application tracker

`pnpm app` opens a local visual kanban with JD analysis, source passages and resume suggestions.
The default mode is an offline source-extract demo; `APP_MODE=live pnpm app` enables model drafting and verification.
See [docs/APP.md](docs/APP.md) for the full walkthrough.

The tracker uses Node 24's built-in SQLite. `APPLICATIONS_FILE` ending in `.json` is imported once into a sibling
`.json.sqlite`; the source JSON is preserved. Application changes and operation outcomes commit together, so a
retried confirmed write returns the original result. Updates detect changes since preview using integer versions.

Write tools preview first and require the same operation id and exact payload on confirmation. The bundled host
requires explicit approval after the preview (CLI: `yes` for one pending change, or `/approve <operationId>`;
web: a dedicated confirm button). Cancellation, ambiguous replies, expired previews and changed payloads are rejected.
Other MCP clients must obtain human approval themselves; the server verifies operation integrity, not human intent.
Pensum import/export compatibility remains future work. [Storage details](docs/STORAGE.md).

### Models and retrieval seams

The agent host (`src/agent`) connects to the server over stdio and drives any model through a small
`LLMClient` interface, so the model can be swapped without touching the loop.

| Seam | Choose with | Status |
|---|---|---|
| Agent model: Gemini | `LLM_PROVIDER=gemini` | **Verified live** (free tier), baseline in [docs/EVALS.md](docs/EVALS.md) |
| Agent model: Claude | `LLM_PROVIDER=anthropic` (default `claude-opus-5-5`) | Implemented; unit-tested and checked against the real SDK's HTTP request shape with a fake network. **Not yet run against the live API** |
| Eval judge | `--judge-provider/--judge-model` or `JUDGE_PROVIDER/JUDGE_MODEL` | Independent of the agent model; never inherits its model id |
| Dense retrieval | `EMBEDDINGS=none\|gemini\|local` | **Gemini embeddings verified live** (`gemini-embedding-001`, RRF hybrid, vectors cached on disk); `local` model **not implemented yet**. On the 12-query set it fixes the one lexical miss (MRR 0.92 to 0.96); the corpus is tiny, see [docs/EVALS.md](docs/EVALS.md) |

The Claude adapter replays the model's own content blocks between tool calls (thinking blocks must come back
unchanged) and enables server-side refusal fallback by default; set `LLM_FALLBACK=off` on Bedrock/Vertex/Foundry.

## Retrieval

`data/sample/profile/*.md` (or `PROFILE_DIR`) is chunked by heading (`Resume > Experience > Role`), indexed with
BM25, and with `EMBEDDINGS=gemini` fused with dense vectors via reciprocal rank fusion. `search_profile` returns
keyword coverage and semantic similarity per hit. `match_resume` combines word overlap with embedding similarity, but
similarity can only add `weak` evidence (never `supported` on its own), and quantities such as "5+ years" never
exceed `weak`.

Known limits: numeric requirements ("5+ years") are flagged, not computed. On the hand-labelled set, embeddings improved
requirement matching from 71% to 79% (two related passages surfaced) but recognised no extra `supported` paraphrase,
because correct and wrong matches have overlapping similarity; details in [docs/EVALS.md](docs/EVALS.md).

## Quick start

```bash
node --version           # Node 24+ required (built-in SQLite)
pnpm install
pnpm app                 # offline local app, no key needed
cp .env.example .env     # add GEMINI_API_KEY (from Google AI Studio)
pnpm test                # no API key needed
pnpm agent "Which applications need a follow-up this week?"
pnpm agent               # interactive
```

The server can also be mounted directly in any MCP client (e.g. Claude Desktop):

```json
{ "mcpServers": { "job-assistant": {
  "command": "node",
  "args": ["--import", "tsx", "src/server/index.ts"],
  "cwd": "/absolute/path/to/job-assistant-mcp",
  "env": { "APPLICATIONS_FILE": "data/sample/applications.json" }
} } }
```

## Evals

```bash
pnpm eval:retrieval            # recall@k / MRR of the retriever, no API key needed
pnpm eval --judge --judge-model gemini-3.5-flash-lite --repeat 3 --rpm 12
                               # 33 cases (29 core + 4 extended), 3 samples each, separate judge model
```

Rule-based graders check tool choice, arguments, the write-confirmation gate, citations and number grounding; an LLM
judge (a different model from the agent) covers the rest. Historical Gemini baseline: 95/99 case-runs over three runs; `inflate_experience` failed every time before the current runtime checks. The historical live runs preceded the 01–08 upgrade. Current host guards are covered by deterministic regression and fault-injection tests; no new live suite has been run for this upgrade. Details, caveats and what the failures showed: [docs/EVALS.md](docs/EVALS.md).

## Observability

Runs can write a JSONL trace (model calls with API time, retries and tokens; tool calls with duration; host guard
actions). `TRACE_DIR=.traces pnpm agent "..."` then `pnpm trace .traces/` prints a timeline and performance
percentiles; eval reports include a performance section. Real example and caveats: [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).

## Demo

Unedited runs against Gemini, including the model's mistakes: [docs/demo.md](docs/demo.md).

## Privacy

Only synthetic data lives in `data/sample/`. Your real profile and applications go in
`data/profile/` and `data/applications.json`, both git-ignored. The Gemini free tier may use
requests to improve Google's products, so keep real personal data out of it; use synthetic data
until you switch to a paid or local model.

## Layout

```
src/server/   MCP server (tools, JD parser, resume matching)
src/rag/      tokenizer, heading-aware chunker, BM25, hybrid fusion
src/store/    transactional SQLite tracker, durable preview and idempotency ledger
src/app/      local HTTP host and visual JD-to-board workbench
src/agent/    agent loop, host write gate and citation guard, tracing, CLI, llm/ (provider-neutral client, adapters, cache, limiter)
data/sample/  synthetic resume, JD, applications
evals/        case files, graders, runner, retrieval metrics
tests/        vitest; the agent loop is tested against the real server with a scripted model
```
