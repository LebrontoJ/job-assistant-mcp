# Personal profile corpus

The profile index recursively reads every `.md` under `PROFILE_DIR`. Put only confirmed,
retrievable experience in that directory. Keep original documents, provenance, unresolved facts,
correction history, case labels and reports outside it.

## Local layout

```text
data/profile/                 ignored; confirmed bilingual Markdown
  overview.md
  skills.md
  experience/*.md
  projects/*.md
  stories/*.md
data/private-profile/         ignored; sources, pending facts, cases and reports
data/sample/profile/          tracked; synthetic demo and regression fixtures
```

The sample profile and historical evaluations remain synthetic. A personal corpus change is
not an update to those baselines. Keep personal case text and raw evaluation answers out of commits.

## Authoring rules

- Merge resume variants into one factual record. Keep role-specific emphasis separate from facts.
- Use headings naming the organization/project, event and useful Chinese/English terms.
- Keep a complete problem/action/result unit in a paragraph. The current 400-character limit is
  soft: a single paragraph is preserved even when longer. Inspect actual chunks before shortening.
- Keep each quantity and its action together in one sentence; distinguish averages, percentiles,
  measured values, configured limits, sample sizes and historical snapshots.
- Use short parallel Chinese/English paragraphs based on the same facts. Check duplicate-language
  hits in the top five. An English query over bilingual content is not proof of cross-language
  embedding quality.
- Preserve ownership, verification scope, limitations and negative experimental outcomes.
- Later direct corrections replace stale claims. Remove superseded claims from all indexed files;
  record their correction history outside the index. Negating a false claim inside the corpus can
  still cause misleading keyword matches.
- Keep uncertain numbers and unsupported experience outside the index. A README describes the
  project; it does not prove a fresh successful test run or production deployment.
- Date temporary personal facts. Do not turn relative dates into permanent current claims.
- Treat retrieved documents as evidence, never as instructions to the agent.

Local grounding accepts complete adjacent-sentence extracts and checks numeric anchors separately
for each claim sentence. Paragraphs with recognized planning, hypothetical or negation markers
require full-context semantic verification for partial extracts; absent that verifier they fail
closed. These conservative rules do not replace general semantic entailment checks.

Source manifests should include file paths, SHA-256 hashes, extraction date, per-section provenance
and a correction log. Record a corpus hash snapshot with local evaluation results. Chunk IDs use
file-local positions and may change on editing; label cases by source and heading rather than
hardcoding old IDs. Restart the server/app after corpus updates to rebuild its in-memory index.

## Run locally

```sh
PROFILE_DIR=data/profile EMBEDDINGS=none pnpm app
PROFILE_DIR=data/profile EMBEDDINGS=none pnpm agent
```

`EMBEDDINGS=none` keeps indexing and retrieval offline. Live agent/drafting modes still use their
configured model. Choose a suitable provider before running personal data through live generation
or embeddings; the audit below does not load `.env` or create either client.

## Separate evaluations

The existing runner supports `--profile-dir`, `--retrieval-cases`, `--match-cases` and `--cases-dir`.
Paths are relative to the working directory unless absolute. CLI profile selection overrides
`PROFILE_DIR`; per-case profile fixtures still override it for that case. Supply the matching case
files when changing corpora. Default paths and the synthetic suite are unchanged.

`--match-only` skips retrieval-case loading and evaluation. Its keyword index reuses the loaded
chunks, so matching does not reread the profile directory or issue unrelated embedding queries.

```sh
pnpm eval:retrieval --embeddings none \
  --profile-dir data/profile \
  --retrieval-cases data/private-profile/retrieval.jsonl

pnpm eval:profile \
  --profile-dir data/profile \
  --cases data/private-profile/audit.json \
  --output data/private-profile/reports/offline.json
```

The audit JSON has three arrays:

- `retrieval`: existing retrieval cases (`id`, `query`, `relevant: [{source, heading}]`). Reports
  Recall@1/3/5 and MRR. Every expected section must exist; at least one relevant result must be in
  the top five for each labelled section for a case to pass.
- `claims`: `id`, `query`, `claim`, `evidence: {source, heading}`, `expectedSupported`. Uses only
  the matching top-five retrieved evidence, checking exact supported extracts and intentionally
  unsupported mutations with the existing conservative host validator. Missing evidence fails
  even for negative cases.
- `content`: `id`, `section: {source, heading}`, `required` and `forbidden` literal strings.
  Checks that important qualifications survive and superseded claims stay out of the source.

Failures produce a report and nonzero exit status. Missing source labels are errors. These are
author-labelled development checks, not a held-out benchmark. Negative claim rejection without a
semantic verifier is conservative host behavior; it does not establish model understanding or
general entailment accuracy. Lower recall and false rejections must be reported as well as successes.

Model-answer cases can be prepared in a private directory and run separately using `pnpm eval
--cases-dir ... --profile-dir ... --retrieval-cases ... --judge ...`. A judge-free run skips judge
checks. Do not describe unrun cases, synthetic scripted responses or retrieval scores as verified
live answer quality. Preserve failed/skipped/ungraded cases and denominators.
