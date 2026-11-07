# Independent end-to-end evaluation protocol (e2e-v1)

This suite evaluates the HTTP workbench from raw JD/profile input through analysis, draft, preview, human decision and durable application state. Existing conversation and requirement-level suites remain diagnostic baselines.

## Independence and eligibility

- Inputs and gold labels live in separate objects. Only public inputs reach providers, MCP tools or the application. A canary regression checks this boundary.
- Gold references use profile path + contiguous source quote, never production chunk positions. Graders must not import production matching/grounding decision functions.
- Candidate fixtures are author-labelled synthetic data, not independently verified benchmark truth. An external human submits blind labels in a separate review file. The reviewer must differ from the recorded author; identity is declared, not authenticated by this local tool.
- Unreviewed cases may run in development and remain explicitly provisional. Official audit requires independently agreed labels and verified frozen file hashes. Disagreement is unresolved, not automatically accepted. Frozen acceptance cases must not be tuned against.
- Split by profile and JD origin/template family. Translations, variants and shared events remain in one split. A workflow variant does not become another independent semantic case.

## Outcomes and denominators

A successful task must meet required parsing/requirement coverage, matching (where applicable), useful grounded draft coverage, citation support and exact write behavior. Empty drafts or blanket refusals cannot pass a positive-content rubric merely by avoiding hallucination.

Separate operational completion, necessary grading completion, full-task success, provisional versus reviewed results, and run/grader errors. A known product failure remains a failure even if another grader is unavailable. Necessary ungraded semantics cannot become a pass. Infrastructure failures remain in end-to-end denominators. A zero denominator is null, not 100%.

Retrieval mode has no semantic assessment contract: do not make it fail solely for missing four-way verdicts. Compare common draft/coverage/write outcomes across all modes; report semantic matching separately. Label any retrieval-label projection as a proxy.

## Runtime tracks

- `offline`: actual rule parsing, retrieval and extractive output; no credentials or network calls.
- `scripted`: injected SDK/transport responses exercise real parser, provider adapters, MCP, matching, task and HTTP code. Host execution tests, never model quality scores.
- `live`: actual configured providers, synthetic fixtures only. Explicit opt-in. Failed or ungraded runs remain visible.
- Fault injection is a separate reliability track and cannot inflate live semantic quality.

The harness supplies approve/cancel/no-decision/retry decisions through the HTTP host boundary. The model never grants user approval. Each case owns its temporary profile, database, MCP pair and local HTTP server; startup, grading and cleanup errors must be recorded.

## Comparison and reproduction

Full-workflow runs start with raw JDs and the actual parser. Controlled matching ablations may replay frozen parser output and must be labelled ablations, not fresh parsing success. Paired samples share case/sample ids and fixed configuration. Use at least three independent samples for live comparisons; cached response replay is a separate condition.

Record source revision and working-tree content hashes, fixture/prompt/schema hashes, provider/model, parser/retrieval settings, budgets, cache policy, seed/sample, per-stage latency and known token usage. Default exports use synthetic data and redacted trace metadata; never read personal PROFILE_DIR for this suite.

## Delivery sequence

1. Protocol; 2. versioned data and candidate fixtures; 3. real HTTP runner;
4. independent grading; 5. approval/fault workflows; 6. reports/manifests;
7. paired comparisons and blind review tooling; 8. offline CI and usage documentation.

## Run and inspect

Requires Node 24 and `pnpm install --frozen-lockfile`. All examples run from the repository root.
Flags use `--name=value`. Reports go to ignored `evals/results/`; they include synthetic profile/JD extracts.
The suite creates temporary profiles, HTTP servers, MCP connections and SQLite databases, and removes them after each case. It never loads your personal profile. Offline and scripted execution require no credentials.

```sh
# CI smoke gates: a known positive workflow, including the physical SQLite write.
pnpm eval:e2e --mode=offline --limit=1 --gate=pass --output=evals/results/e2e-offline.json
pnpm eval:e2e --mode=scripted --compare=matching --limit=1 --gate=pass --output=evals/results/e2e-scripted.json

# Full provisional development set: retain failures rather than gate on model quality.
pnpm eval:e2e --mode=offline --output=evals/results/e2e-dev-offline.json
pnpm eval:e2e --mode=scripted --output=evals/results/e2e-dev-scripted.json

# A separate reliability experiment; tests cover all eight fault values.
pnpm eval:e2e --mode=scripted --limit=1 --fault=lost_response --gate=pass

# Explicit live calls: uses existing Gemini/Anthropic environment configuration.
pnpm eval:e2e --mode=live --compare=matching --repeat=3 --output=evals/results/e2e-live.json
# Optional semantic judge: choose a provider/model different from both tested models.
# Append --judge-provider=anthropic --judge-model=<different-model> to a live command.
```

`--split=dev` is the default; `validation` is available for development checks.
`--case-timeout-ms=240000` bounds each case, including grading; cleanup has a separate 5s grace period.
`--gate=report` (default) exits 0 after collecting product failures/ungraded scores, 2 on execution errors.
`--gate=pass` additionally exits 1 if any case is failed or ungraded. Invalid configuration exits nonzero.
Live runs can incur provider charges. Credentials and `.env` are read only in live mode.

Report groups separate runtime, matching mode, workflow/reliability track and full workflow/parser ablation.
Every metric retains numerator/denominator; zero denominators produce `null`. Failures include check names and
stage errors. Redacted trace metadata locates parser, tool and matching activity; HTTP stage timings are
reported separately. Token usage includes observed successful responses, not estimates for missing usage.
Operational completion means the HTTP/state workflow completed; required quality checks determine task success.
A semantic paraphrase without an independent judge stays ungraded. Exact source quotes can be graded locally.

## Paired matching ablation

`--compare=matching` runs retrieval, assessment and agent modes on the same case/sample IDs.
The paired report compares agent with assessment and preserves regressions and recoveries; retrieval is
reported in its own group because it has no four-way semantic verdict contract. Full-workflow comparisons
include fresh parsing, so parser variability is part of those outcomes. To hold parsing fixed explicitly:

```sh
pnpm eval:e2e:replay evals/results/e2e-live.json evals/results/parser-replay.json
pnpm eval:e2e --mode=live --compare=matching --repeat=3 --parser-replay=evals/results/parser-replay.json --output=evals/results/e2e-ablation.json
```

Replay takes the first available full-workflow parse per case and verifies the trimmed JD hash (the HTTP
host trims input). It supplies no gold labels. These rows are labelled `matching_ablation`, record the
replay file hash, and cannot be used as fresh parser results or official audit results. Keep the source
report and replay file together. Repeated scripted samples are deterministic host checks, not stability evidence.

## Independent review and frozen acceptance

There are 30 candidate tasks across six synthetic profile families: dev 15, validation 5, heldout 10.
Five variants per profile share a split. Counts describe tasks, not 30 independent resume populations.
All current labels are author-produced and pending independent human review. No reviewed quality score
or live before/after improvement is claimed by this implementation.

```sh
# Give this blind input/schema packet to an independent human, outside the SUT.
pnpm eval:e2e:review --action=export --split=heldout --output=evals/results/blind-heldout.json
# Import the human's JSON array of labels; do not copy author labels into it.
pnpm eval:e2e:review --action=record --split=heldout --input=evals/results/human-labels.json --output=evals/results/reviews.json
# Only after agreement; frozen cases must not be used for development/tuning.
pnpm eval:e2e --mode=live --split=heldout --purpose=audit --repeat=3 --reviews=evals/results/reviews.json --output=evals/results/heldout-audit.json
```

Each submitted label is `{caseId, caseHash, reviewer, reviewerKind: "human", gold}`; the packet provides
case hashes, raw inputs and the gold schema, but omits author gold values. Import records agreement or
disagreement. Missing, stale, self-authored or disputed reviews keep audit locked. Review identity is
self-declared; this tool cannot establish a human's independence. Resolve disagreements through external
review and a versioned dataset revision, not automatic relabelling to match system output.
Official audit requires live full workflows, all selected cases, at least three samples, no fault injection
and no parser replay. Gates run before provider creation. Local fixtures remain readable in the repository;
this is a procedural freeze, not a secret evaluation service.

## Implementation and limits

- `evals/e2e/fixtures/manifest.json`: frozen hashes; `types.ts`/`load.ts`: schemas and source-quote validation.
- `environment.ts`/`runner.ts`: real HTTP/MCP workflow and independent physical state inspection.
- `grading.ts`: independent coverage/verdict/grounding checks; no production support-decision imports.
- `faults.ts`: parser timeout, partial match failure, search failure, draft failure, user cancellation,
  unapproved write, version conflict and lost response/idempotent retry.
- `report.ts`/`comparison.ts`/`review.ts`: reproducible manifests, paired outcomes and blind review gate.
- `tests/e2e-*.test.ts`: leakage canary, scoring counterexamples, workflow/fault, deadline and review regressions.

This suite currently fixes retrieval to BM25. Matching comparisons do not establish BM25 versus hybrid
retrieval quality. The live runner uses current provider interfaces; no real-provider run or real user
feedback is supplied by automated SDK fixtures. Candidate rubric coverage, human review and repeated live
measurements are still required before publishing general quality or improvement claims. CI gates host
behavior using smoke cases plus all regression tests; it does not require every candidate fixture to pass.

## Local implementation validation (2026-11-06)

`pnpm test`: 35 files / 317 tests passed, including all eight fault scenarios.
`pnpm typecheck` and `pnpm build` passed. Both strict CI smoke commands passed locally;
fresh and replayed three-mode smoke comparisons passed. The heldout/audit CLI was also checked to reject
unreviewed or non-live configurations before creating providers. No heldout workflow was executed.

Full provisional dev results, one sample per case, with all failures retained:

| Runtime / matching | Operational completion | Required task checks passed | Run errors |
| --- | --- | --- | --- |
| offline / retrieval | 15/15 | 4/15 | 0/15 |
| scripted / agent | 15/15 | 11/15 | 0/15 |

The offline failures expose parser/coverage gaps and irrelevant drafts on no-answer requests.
Scripted failures expose one extraction/assessment gap and three missing labelled assessment citations.
These scores compare different host execution conditions; their difference is **not** model improvement.
Artifacts are generated locally at `evals/results/e2e-dev-offline.json` and
`evals/results/e2e-dev-scripted.json` (git-ignored); source and fixture hashes are recorded in each report.
No live model, independent human labelling or real-user study was run for this implementation.
