# Demo transcripts

Real runs against `gemini-3.1-flash-lite` (free tier) on the synthetic sample data, recorded on 2026-10-18 and
**not edited or re-rolled**. Where the model got something wrong, it is left in and marked. That is the reason the
eval suite exists (see [EVALS.md](EVALS.md)).

Setup used for the first two: a scratch copy of the tracker so the demo does not modify the repo,

```bash
cp data/sample/applications.json /tmp/ja-demo/apps.json
export APPLICATIONS_FILE=/tmp/ja-demo/apps.json
```

Long tool arguments are shortened in the log; the model received them in full.

## 1. A read-only query

```bash
pnpm agent "Which applications need a follow-up in the next 7 days?"
```

```text
  [tool] list_followups({"days":7})
You have one application requiring a follow-up in the next 7 days:

*   **Contoso Data** (Data Engineer): Follow-up is due on **2026-10-12**.

(Note: Your interview with **Northwind Labs** is scheduled for a follow-up on 2026-10-18, which is slightly outside the 7-day window.)
```

> **Model mistake.** The tool returned two rows, Contoso (2026-10-12, overdue) and Northwind Labs (2026-10-18, due
> today). The model dropped Northwind and invented a reason. Tool choice and arguments were right; the
> summary was wrong. Single-case failures like this are why the evals grade answers and not only tool calls.

## 2. JD against the profile, with sources

```bash
pnpm agent "Tailor my resume to this job: write 3 resume bullets backed by my profile, cite sources, and list what my profile does not cover.

$(cat data/sample/jd-backend.txt)"
```

```text
  [tool] match_resume({"jd_text":"Senior Backend Engineer\nCompany: Northwind Labs\nLocation: Austin, TX (Hybrid)\n\nAbout the role\nJoin Northwind Labs to build … (601 chars))
Here are three resume bullets tailored for the Senior Backend Engineer role at Northwind Labs:

*   **Database Optimization:** Reduced PostgreSQL p95 query latency by 38% through rigorous index and query redesigns; managed incident response for database outages by implementing new indices, automated alerting, and technical runbooks [resume.md#0, stories.md#1].
*   **Systems Architecture:** Built a high-throughput Kafka consumer in Go to process and deduplicate data, integrated with Redis for caching, and deployed via Kubernetes (EKS) on AWS [projects.md#0].
*   **CI/CD & Engineering Productivity:** Streamlined development workflows by containerizing builds with Docker and parallelizing test execution in CI/CD pipelines, reducing release cycles from 40 minutes [stories.md#0].

### Profile Coverage
Your profile demonstrates strong alignment with the role's core technical requirements (PostgreSQL, Redis, Docker, Kubernetes, AWS, and Kafka). 

**What your profile does not cover:**
*   **Explicit gRPC/REST experience:** While you have backend engineering experience, your profile does not explicitly list "REST" or "gRPC" frameworks or experience.
*   **Specific Years of Experience:** Your profile covers 2022–2026. If you have relevant experience prior to 2022, be sure to highlight it to meet the "5+ years" requirement.
*   **LLM/RAG Integration:** While you have built a RAG assistant [projects.md#1], ensure you emphasize this experience in the context of production-grade systems if the role requires deploying LLMs at scale.
```

What worked: every bullet cites a passage id that exists, the 38% figure matches the source, and the gaps (gRPC/REST,
years of experience) are real.

> **Weak spots.** The third bullet says "reducing release cycles from 40 minutes" and drops the "to 12 minutes", which
> changes the claim. The model also relied on `match_resume` excerpts and never called `search_profile` for the full
> passages. It did not invent employers or numbers, but this is the kind of paraphrase drift the `numbers_grounded`
> check and the LLM judge look for.

## 3. A write needs a preview, then the user's approval

Two turns of one conversation, driven by the same `runAgent` loop the CLI uses (the CLI takes one prompt at a time),
over an in-memory copy of the sample tracker:

```text
> Add Initech, Site Reliability Engineer, to my tracker as wishlist.
  [tool] add_application({"role":"Site Reliability Engineer","company":"Initech","status":"wishlist"})
I've prepared the entry for the Site Reliability Engineer role at Initech as a wishlist item. Shall I go ahead and add this to your tracker?

> Yes, go ahead.
  [tool] add_application({"status":"wishlist","confirm":true,"role":"Site Reliability Engineer","company":"Initech"})
Done! I've added the Site Reliability Engineer position at Initech to your wishlist.

store after both turns: [{"company":"Initech","role":"Site Reliability Engineer","status":"wishlist"}]
```

The first call had no `confirm`, so the server returned a preview and wrote nothing. The model asked, the user said
yes, and only then did it pass `confirm: true`. Note that `confirm` is set by the model: the server cannot verify the
user's reply. The evals measure whether the model respects the gate.
