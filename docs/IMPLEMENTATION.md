# Implementation 01–08

Each numbered item is a separate commit. This log records implementation and checks, not promised eval scores.

- 01: pinned pre-change source/suite hashes, fresh offline test/retrieval artifacts, separate development/held-out claim fixtures, comparison protocol. Initial baseline: 168 tests pass; typecheck passes. No new live calls.
- 02: added a bounded MCP JD task producing requirements, complete source passages, cited draft bullets, future suggestions and explicit limitations. Offline mode uses source extracts; model mode requests structured drafts. Task analysis does not write.
- 03: claim-level checks reject missing evidence and quantities borrowed from another event; narrowly normalised paraphrases work offline, novel wording uses a fail-closed semantic verifier. Structured drafts get at most two attempts; rejected claims are removed and model-written suggestions are replaced with grounded future actions. General chat now withholds drafts still failing citation/grounding checks after repair. Development regressions cover valid requests and failures; held-out cases were not used for tuning. Semantic verification remains probabilistic, not proof of truth.
