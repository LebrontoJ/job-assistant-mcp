# Observability

Every agent run can emit a trace: one JSON line per model call, tool call, host guard action and run boundary.
Nothing is sent anywhere; traces are local files.

```bash
TRACE_DIR=.traces pnpm agent "..."                  # one file per CLI session
pnpm eval --trace-dir .traces/eval ...              # one file per eval case, under run1/, run2/, ...
pnpm trace .traces/cli                              # timeline per run + aggregate performance (file or directory)
```

`.traces/` is git-ignored: new on-disk traces redact user text, tool arguments/results and guard details by default. Historical traces
may still contain profile text.

## What is recorded

| event | fields |
|---|---|
| `run_start` | run id, provider, model, the user's message (clipped) |
| `llm_call` | step, API time `ms`, `retries` (429/5xx retried inside the call), input/output tokens, finish reason, tools requested |
| `tool_call` | step, tool, arguments, duration, error / blocked flags, result (clipped) |
| `guard` | `write_blocked` (the host refused a confirmed write) or `citation_retry` (the model was sent back to fix its sources), with the reason |
| `run_end` | total time, model calls, why it stopped (`answered`, `max_steps`, `blocked`, `truncated`, `error`), token totals |

A run whose model call throws (quota, network) still gets its `run_end` with `stoppedBecause: "error"`.

## A real trace

`gemini-3.1-flash-lite`, free tier, sample data, recorded 2026-10-18:

```text
$ APPLICATIONS_FILE=/tmp/ja-demo/apps.json TRACE_DIR=.traces/cli pnpm agent "Which of my applications are in the interview stage, and what is due soon?"
$ pnpm trace .traces/cli

   +0.00s  RUN    gemini/gemini-3.1-flash-lite  "Which of my applications are in the interview stage, and what is due soon?"  [cli-t1]
  +22.45s  MODEL  step 1  22.5s  1331 in / 31 out  -> tool_calls (list_applications, list_followups)
  +22.47s  TOOL   step 1  17ms  list_followups({"days":7})
  +22.47s  TOOL   step 1  19ms  list_applications({"status":"interview"})
  +23.31s  MODEL  step 2  842ms  1867 in / 104 out  -> stop
  +23.31s  END    answered  2 model call(s)  23.3s total  3198 in / 135 out
```

What it shows, which the pass/fail evals cannot:

- **The model API is the whole cost.** Tool calls take 1-20 ms (in-process); model calls take seconds. Over six live
  eval cases: p50 2.8 s, p95 21.2 s per call, tools 1-10 ms.
- **That 22.5 s step 1 was not retries** (`retries` absent, so zero): the API was just slow. Before the retry field
  existed this was indistinguishable from a rate-limit backoff.
- **Parallel tool calls really run in parallel**: both tool calls start at +22.47 s.

## Evals report a performance section

`pnpm eval` appends model-call and run-time percentiles, per-tool call/error/blocked counts and average duration,
and tokens per call (see the `## Performance` block in the report).

## Reading the numbers correctly

- **`--rpm` adds queueing to wall time.** The rate limiter delays a call before it starts. "API time" excludes that
  wait; the timeline offsets and "agent run (wall time)" include it. In a rate-limited eval the gap between the two is
  the limiter, not the model.
- **Cached responses replay the latency of the live call that recorded them.** Calls recorded before latency
  tracking existed have no `ms` and are shown as untimed; the report says how many calls were timed.
- Latency percentiles over a handful of runs are anecdotes. The six-case run above has 12 model calls.

## Not covered

- No cost estimate: the free tier has no price, and prices change; tokens are reported instead.
- No per-tool token attribution, no distributed tracing or OpenTelemetry export, no live dashboard.
- Embedding stages are traced in app/server startup wrappers; cache lookup is included in their duration. No distributed tracing is provided.
- Correlation uses local task/run/call ids; it is not a cross-service OpenTelemetry trace.

## Correlation and redaction (01–08 upgrade)

New events carry `taskId`; tool summaries/attempts carry `toolCallId` and writes carry `operationId`.
`tool_attempt` records each attempt, error class and retry decision. `stage` distinguishes discovery, connection,
model and profile/embedding failures; run_end is emitted even if discovery fails. Structured JD tasks emit the same
trace format, including rejected-claim guard events. `pnpm trace` displays attempts and stages without exposing content.

JSONL files now redact user text, tool arguments/results and guard details by default. Correlation ids, tool/stage
names, error classes, timings and token counts remain. MemoryTracer retains content for local graders; do not export
it without sanitizing. Library callers may explicitly opt into `new JsonlTracer(file, { includeContent: true })` for
private debugging. Existing historical files are not retroactively redacted. Embedding timings include cache lookup
when wrapped around the caching embedder; cached vector calls can be near zero.

Structured-task performance summaries group `tool_attempt` events by run/call id. A recovered retry counts as one successful logical call; a final failed attempt counts as an error. Where a `tool_call` event exists, its complete duration is used once. Otherwise duration is the sum of attempt execution times (retry backoff excluded). CLI semantic validation is recorded as a bounded `grounding` stage.
