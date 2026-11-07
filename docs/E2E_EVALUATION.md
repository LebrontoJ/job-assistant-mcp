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
