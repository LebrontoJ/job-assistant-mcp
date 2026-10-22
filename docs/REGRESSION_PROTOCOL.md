# Regression protocol (01)

Baseline source: `ea62638`. `evals/baselines/01/manifest.json` pins source, suite and lockfile hashes.
The initial offline baseline is 168 passing tests and a passing typecheck; tests.json and retrieval.txt are fresh offline artifacts.
Historical live results (95/99 case-runs) remain in EVALS.md. They are NOT a new live baseline and are not directly comparable to a changed suite.

## Splits and procedure

- Existing core/extended agent cases remain comparable to their own frozen versions.
- `evals/regression/dev` is the working claim-regression set: inflation, borrowed numbers, added skills, valid paraphrases and suggestions.
- `evals/regression/heldout` is a frozen final audit set. Do not tune prompts, thresholds or examples against it. Its expected labels are for final review, not development tests. These small author-labelled sets are a starting point, not evidence of general accuracy.
- Compare the frozen baseline checkout and candidate on the SAME expanded suite, provider/model, judge, retrieval configuration and cache policy. Run at least three independent samples per case. Pin prompt/source and fixture hashes for both.
- Preserve per-case answers, outcomes, citations, trace and errors in a sanitized run artifact; never commit personal profiles, credentials or raw production traces.
- Report task success, citation support precision/coverage, unsupported factual claims and false rejections. Explicitly give denominators, run errors, skipped and ungraded counts; also show overall completion including infrastructure failures. Judge failures are never model successes or failures.
- A deterministic scripted-model test proves host enforcement, not live model quality. No live improvement claim until a same-suite live comparison exists.

## Milestone acceptance

01 baseline/protocol; 02 structured evidence report; 03 bounded validation/repair; 04 exact explicit approvals;
05 transactions/idempotency; 06 timeout/recovery; 07 correlated redacted trace; 08 local JD-to-board app.
