# job-assistant-mcp

An MCP job-search assistant: a tool-calling agent over an MCP server, a lightweight RAG layer over
your own profile, and a small eval harness that tells you whether a change made things better.

> Status: **M2 (RAG)**. MCP server, provider-neutral agent loop and profile retrieval work end to end.
> The eval harness is next, see [docs/PLAN.md](docs/PLAN.md).

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

The agent host (`src/agent`) connects to the server over stdio and drives any model through a small
`LLMClient` interface, so the model can be swapped without touching the loop. Gemini (free tier) is the
first adapter; Claude is planned so the same evals can compare both.

## Retrieval

`data/sample/profile/*.md` (or `PROFILE_DIR`) is chunked by heading (`Resume > Experience > Role`), indexed with
BM25, and optionally fused with dense vectors via reciprocal rank fusion when an `Embedder` is supplied. The
server stays model-free: `match_resume` is a lexical coverage signal and says so in its output.

Known limits (these are what the eval set should measure): numeric requirements ("5+ years") are not
computed, and paraphrases with little word overlap score `weak` until a real embedder is plugged in.

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
tests/        vitest; the agent loop is tested against the real server with a scripted model
```
