Evaluate the COMPLETED BenchBoard benchmark run identified below.

This is a PRIVATE OWNER-SIDE evaluation.

Do NOT allow the participant Captain/workers to resume.

Do NOT modify the participant submission.

Do NOT repair failures.

Do NOT expose hidden tests/reference/scoring to the participant workspace.

======================================================================
RUN
======================================================================

RUN ID:

<INSERT RUN ID>

Before evaluation, resolve the run manifest and participant workspace from the
BenchBoard owner records.

Do not guess paths from naming conventions if the manifest provides them.

======================================================================
PRE-EVALUATION FREEZE
======================================================================

Before running any evaluator:

1. Confirm DSH participant execution has stopped.

2. Confirm Captain and all workers are quiescent.

3. Confirm no pending Agent Teams session transition remains.

4. Confirm the run has valid stop/completion evidence, including the declared
   timeCeilingMinutes, deadlineAt, terminationRequestedAt, observedStoppedAt,
   overrunSeconds, terminationOutcome and a runStatus of COMPLETED, TIME_LIMIT,
   TIME_LIMIT_OVERRUN, STOP_FAILURE or INFRASTRUCTURE_FAILURE. Prefer the
   independent watchdog record where one exists; a STOP_FAILURE or unconfirmed
   stop makes the outcome invalid rather than scoreable as completed.

5. Hash/snapshot the participant workspace BEFORE evaluation.

6. Record the final participant tree hash.

7. Preserve the raw DSH/team/session evidence.

The evaluator must not alter the submission.

If participant execution is still active:

STOP.

======================================================================
BENCHMARK IDENTITY
======================================================================

Verify the run is bound to the exact benchmark candidate recorded at seeding.

Verify:

- benchmark version;
- benchmark commit;
- starter/public hash;
- run manifest;
- evaluator version/hash.

Do not silently evaluate a submission with a different benchmark version.

======================================================================
VISIBLE EVALUATION
======================================================================

Run the benchmark's official post-run visible-test evaluation.

Record:

- pass/fail count;
- failures;
- raw output;
- exit status.

Do not substitute tests the Captain may have run during execution.

======================================================================
PRIVATE HIDDEN EVALUATION
======================================================================

Run the official private hidden evaluator against the frozen participant
submission.

The hidden evaluator remains owner-only.

Record:

- all property results;
- category totals;
- raw evaluator evidence;
- browser evidence/screenshots where configured;
- console errors where configured.

Do NOT copy hidden evaluator files into the participant workspace.

======================================================================
AUTOMATED SCORING
======================================================================

Run the official BenchBoard scorer.

Calculate the full automated score out of:

80

Use only official evaluator evidence.

Do not manually adjust points.

Report category breakdown.

The automated score must remain deterministic.

======================================================================
PARTICIPANT-ADDED TEST QUALITY
======================================================================

Run the official useful-test/mutation evaluation.

Record:

- added participant tests;
- baseline status;
- each fault domain;
- which mutations were killed;
- points awarded.

Do not award credit based merely on test count.

======================================================================
DSH TELEMETRY INGESTION
======================================================================

Ingest the raw DSH evidence preserved by Codex ChatGPT Desktop.

Normalize it using the benchmark's official telemetry tooling.

Keep separate:

CAPTAIN

LOCAL WORKERS

CLOUD WORKERS, if any.

Do not infer metrics that cannot be safely attributed.

Unknown remains null.

======================================================================
SESSION-LIFECYCLE REPORT
======================================================================

Produce a timeline for each worker:

task
→ attempt
→ dispatch class
→ session ID
→ generation
→ start/end

Explicitly identify observed:

- independent-task fresh rotations;
- same-attempt continuation reuse;
- retry rotations;
- unexplained rotations, if any.

For a fresh-session run, determine whether independent tasks actually received
fresh generations.

Do not judge correctness merely from generation count; bind each rotation to
its dispatch class.

======================================================================
CONCURRENCY / UTILIZATION
======================================================================

From raw timestamps, derive where supportable:

- peak useful worker parallelism;
- worker-1 busy time;
- worker-2 busy time;
- both-worker overlap;
- dependency-blocked time;
- unexplained idle time;
- Captain planning/decomposition periods;
- gaps between task completion and new useful work.

If timestamps do not support a metric, return null.

Do not fabricate utilization.

======================================================================
TOKEN / CONTEXT ANALYSIS
======================================================================

Where attributable, report separately:

CAPTAIN:

- input;
- cache read;
- uncached input;
- output;
- steps;
- compactions;
- wall time.

EACH LOCAL WORKER:

- input;
- cache read;
- uncached input;
- output;
- TTFT;
- decode TPS;
- steps;
- compactions;
- context start/end where available.

Also provide aggregate LOCAL WORKER metrics.

Do not fold Captain/cloud usage into local-worker efficiency.

For session-policy experiments, highlight:

- context growth;
- compactions;
- fresh-session starting context;
- continuation context;
- decode behavior over successive tasks.

======================================================================
EFFICIENCY
======================================================================

Calculate only officially supported metrics, including where valid:

- total wall time;
- tasks completed;
- retries;
- local GPU-hours;
- cloud GPU-hours;
- completed tasks/local GPU-hour;
- quality/local GPU-hour where valid;
- tokens/completed task;
- fresh tokens/completed task;
- minutes/completed task.

Keep quality and speed separately visible.

Do not invent one opaque composite benchmark score.

======================================================================
HUMAN UI
======================================================================

DO NOT self-award the 20 UI points.

Prepare the finished participant app for OWNER review.

Report the exact launch command and URL.

Create/populate the blank human UI worksheet associated with this run but
leave scores empty.

The owner will provide:

Overall polish        /5
Information hierarchy /3
Cards/board           /3
Issue drawer          /3
Interaction feedback  /2
Responsive quality    /2
Detail consistency    /2

Total                 /20

======================================================================
INTERIM RESULT
======================================================================

Until human UI scoring is supplied, report:

Automated quality: X / 80
Human UI: PENDING
Final quality: PENDING

Do not manufacture a /100 result.

======================================================================
AFTER OWNER UI SCORE
======================================================================

When I later provide the seven human scores:

1. validate they respect category caps;
2. record the owner UI evidence;
3. compute final quality /100;
4. regenerate the final benchmark report.

Do not rerun model execution or modify the submission.

======================================================================
FINAL REPORT CONTENT
======================================================================

The report should ultimately include:

CONFIGURATION

- benchmark version;
- Captain;
- workers;
- session policy;
- hardware/server identity.

RESULT

- run status;
- wall time;
- automated quality;
- UI quality;
- final quality.

CORRECTNESS

- visible tests;
- hidden tests;
- category breakdown.

EXECUTION

- Captain task graph;
- task count;
- attempts;
- retries;
- human interventions.

CONCURRENCY

- peak parallelism;
- utilization/overlap where available.

SESSIONS

- per-worker session timeline;
- independent rotations;
- continuations;
- retries;
- compactions.

TOKENS

- Captain separately;
- local workers separately;
- cloud separately;
- total and uncached/fresh framing.

EFFICIENCY

- supported GPU/time/token metrics.

LIMITATIONS

- unavailable telemetry;
- infrastructure events;
- stop overrun;
- anything affecting interpretation.

======================================================================
SUBMISSION IMMUTABILITY
======================================================================

After evaluation, verify the participant workspace still matches its
pre-evaluation tree hash.

If the evaluator changed participant bytes:

STOP and report an evaluator-integrity failure.

======================================================================
RETURN — FIRST EVALUATION PASS
======================================================================

Report:

A. RUN ID / STATUS

B. PARTICIPANT WORKSPACE + FINAL TREE HASH

C. VISIBLE TEST RESULT

D. HIDDEN TEST RESULT

E. AUTOMATED SCORE /80 + BREAKDOWN

F. USEFUL-TEST/MUTATION RESULT

G. CAPTAIN EXECUTION SUMMARY

H. LOCAL-WORKER EXECUTION SUMMARY

I. SESSION TIMELINES

J. CONCURRENCY/UTILIZATION

K. TOKEN/CONTEXT/COMPACTION METRICS

L. EFFICIENCY METRICS

M. HUMAN INTERVENTIONS

N. TELEMETRY GAPS/LIMITATIONS

O. UI REVIEW LAUNCH COMMAND + URL

P. HUMAN UI WORKSHEET PATH

Q. FINAL QUALITY:
   PENDING HUMAN UI

R. PARTICIPANT SUBMISSION UNCHANGED BY EVALUATION:
   YES/NO

Then STOP and wait for my UI scores.
