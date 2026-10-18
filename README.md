# job-assistant-mcp

[![CI](https://github.com/LebrontoJ/job-assistant-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/LebrontoJ/job-assistant-mcp/actions/workflows/ci.yml) ![license](https://img.shields.io/badge/license-MIT-blue)

An MCP job-search assistant: a tool-calling agent over an MCP server, a lightweight RAG layer over
your own profile, and a small eval harness that tells you whether a change made things better.

> Status: **M4 (evals)**. MCP server, provider-neutral agent loop, profile retrieval and an eval harness work end to end;
> a Gemini baseline is recorded in [docs/EVALS.md](docs/EVALS.md). Roadmap: [docs/PLAN.md](docs/PLAN.md).

## What works today

| MCP tool | Reads/writes | Notes |
|---|---|---|
| `parse_jd` | read | Deterministic JD structuring (sections, years, work mode, skills). No model inside the server. |
| `list_applications` | read | Filter by status / company. |
| `list_followups` | read | Open applications with a follow-up due in N days (overdue included). |
| `search_profile` | read | BM25 search over your Markdown profile; returns passages with citable chunk ids. Works for English and Chinese. |
| `match_resume` | read | Compares a JD to the profile: per requirement `supported` / `weak` / `no_evidence` with evidence ids, plus which JD skills are present or missing. |
| `add_application` | **write** | Returns a preview unless `confirm=true`; refuses duplicates. |
| `update_application` | **write** | Same confirm gate; unknown ids return an error the model can recover from. |

### About the application tracker

`add_application`, `update_application`, `list_applications` and `list_followups` work on a plain JSON file
(`APPLICATIONS_FILE`, default `data/sample/applications.json`): a status-tracked list of applications with follow-up
dates, not a visual kanban board. There is no export tool, and the file format is not yet compatible with the
[Pensum](https://github.com/LebrontoJ/Pensum) board's import/export format (planned, see
[docs/PLAN.md](docs/PLAN.md)). Writes are previews until `confirm=true` is passed. The server alone cannot tell who set that flag, so the bundled
agent host enforces it: a confirmed write is refused unless that exact change was previewed and a real user message
came after it (`src/agent/gate.ts`). Other MCP clients get only the preview step. The gate proves a human turn happened,
not that the answer was yes.

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
keyword coverage and semantic similarity per hit. `match_resume` is still a lexical coverage signal and says so.

Known limits: numeric requirements ("5+ years") are not computed, and `match_resume` does not yet use the embeddings,
so paraphrased requirements can still score `weak`.

## Quick start

```bash
pnpm install
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
judge (a different model from the agent) covers the rest. Gemini baseline: 95/99 case-runs over three runs; `inflate_experience`
fails every time. The agent host also refuses unapproved writes and asks the model to fix bad citations, which is unit-tested
but did not fire in the live runs. Details, caveats and what the failures showed: [docs/EVALS.md](docs/EVALS.md).

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
src/store/    application tracker storage (JSON file)
src/agent/    agent loop, CLI, llm/ (provider-neutral client + Gemini adapter)
data/sample/  synthetic resume, JD, applications
evals/        case files, graders, runner, retrieval metrics
tests/        vitest; the agent loop is tested against the real server with a scripted model
```
