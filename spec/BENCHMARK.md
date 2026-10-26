# BenchBoard v1.0 Benchmark Specification

**Status:** Frozen design specification\
**Primary purpose:** Benchmark local LLM software-engineering
performance inside DSH Agent Teams\
**Target duration:** 30--60 minutes for a competent two-worker team\
**Hard time limit:** 75 minutes

## 1. Purpose

BenchBoard is **not primarily a web-development benchmark**. It is a
**local-agent engineering-throughput benchmark that uses a standardized
web application as its workload**.

It measures four primary dimensions:

  -----------------------------------------------------------------------
  Dimension                           Question
  ----------------------------------- -----------------------------------
  Quality                             Can the local model produce
                                      correct, polished,
                                      production-quality work?

  Speed                               How quickly does useful engineering
                                      work get completed?

  Efficiency                          How many tokens, model steps,
                                      compactions, retries, sessions, and
                                      GPU-hours are required?

  Agent behavior                      Does the model finish autonomously,
                                      integrate with other workers,
                                      recover correctly, and avoid
                                      stalls/rework?
  -----------------------------------------------------------------------

The workload must exercise project inspection, decomposition, parallel
and sequential implementation, debugging, state/data modeling,
integration, testing, UI/UX work, and final QA. Raw decode tok/s is
recorded but is not the primary performance metric.

## 2. Core Experimental Questions

BenchBoard should answer:

-   How good is Qwen Flash as a real coding worker?
-   Does higher raw decode speed translate into faster completed
    engineering work?
-   Does fresh independent-task context reduce input-token processing
    and compaction?
-   Does persistent context eventually slow workers or reduce quality?
-   Does a slower but stronger model outperform a faster model after
    rework is included?
-   How much does Captain quality affect utilization and wall-clock
    completion?
-   Does adding cloud-worker capacity reduce critical-path time or
    increase coordination overhead?
-   How much useful engineering work does each local GPU produce per
    hour?
-   Which architecture gives the best quality-adjusted engineering
    throughput?
-   How often do workers stall, falsely complete, retry, or need human
    intervention?
-   Is the harness keeping workers productively occupied?

## 3. Standard Product Workload

Participants receive an intentionally incomplete but runnable
**BenchBoard** application: a polished local project/issue manager
inspired by Linear/Trello.

Technology:

-   React
-   TypeScript
-   Vite
-   CSS
-   localStorage
-   Vitest

No backend, database, or network access is required.

## 4. Product Surface

``` text
BenchBoard
├── Header
│   ├── project title
│   ├── search
│   ├── filters
│   └── completion summary
├── Kanban Board
│   ├── Backlog
│   ├── In Progress
│   └── Done
├── Issue Cards
│   ├── priority
│   ├── labels
│   ├── assignee
│   └── title
├── Issue Drawer
│   ├── title / description
│   ├── status / priority
│   ├── assignee / labels
│   └── activity history
├── Analytics
│   ├── completion %
│   ├── status counts
│   ├── priority counts
│   └── assignee workload
└── Persistence
    └── reload-safe local state
```

## 5. Functional Requirements

### Board

Issues appear in Backlog, In Progress, and Done. Drag/drop must update
status, preserve relative ordering, update analytics, create exactly one
activity event, and survive reload.

### Issue Editing

Clicking a card opens a drawer. Users can edit title, description,
priority, status, assignee, and labels. Changes update immediately.
Deletion requires confirmation.

### Search and Filters

Search is case-insensitive across title, description, labels, and
assignee.

Filters include priority, assignee, labels, and status. Multiple filters
use **AND semantics**, and search combines with active filters using AND
semantics.

### Analytics

Analytics update immediately and show total issues, completed issues,
completion percentage, counts by status, priority, and assignee.

### Activity

Record meaningful changes such as creation, status, priority, assignee,
label, and general edits. One user action must not create duplicate
events. Events display newest-first.

### Persistence

localStorage must preserve issues, ordering, activity, and edits across
reload. Filters need not persist.

## 6. Fixture Dataset

Start with **18 realistic issues**.

Assignees: Maya Chen, Alex Rivera, Jordan Kim, Sam Patel.

Priorities: Critical, High, Medium, Low.

Labels: frontend, backend, bug, testing, docs, performance,
accessibility, design.

Initial distribution:

  Status          Count
  ------------- -------
  Backlog             8
  In Progress         6
  Done                4

Use realistic issue titles rather than generic numbered tasks.

## 7. Seeded Defects

The starter contains seven deliberate cross-component defects:

1.  Drag/drop visually moves a card but persists the old order.
2.  Deleting an issue leaves analytics stale.
3.  Multiple filters use OR instead of AND.
4.  Drawer status edits fail to reposition cards correctly.
5.  Labels such as `Frontend` and `frontend` can duplicate.
6.  Some edits create duplicate activity records.
7.  Activity is sorted using formatted strings instead of raw
    timestamps.

The PRD specifies correct behavior but does not reveal defect locations.

## 8. Legacy Migration Trap

Fixtures include v0 localStorage state using `tasks`; v1 expects
`issues`. The app must migrate v0 → v1 without losing IDs or issues.

## 9. Natural Parallelism

The PRD must not prescribe decomposition, but the workload should
naturally support:

``` text
                     Data/state
                         │
       ┌─────────────────┼─────────────────┐
       ▼                 ▼                 ▼
    Board/DnD        Issue Drawer      Search/Filters
       │                 │                 │
       └────────────┬────┴───────┬────────┘
                    ▼            ▼
                Analytics    Persistence
                    │            │
                    └──────┬─────┘
                           ▼
                    Integration/UI
                           │
                           ▼
                       Final QA
```

A good Captain should discover useful parallelism. Decomposition quality
is benchmark signal.

## 10. Expected Task Count

Typical successful runs should produce roughly **6--10 worker tasks**.
The benchmark must not tell the Captain the intended decomposition.

## 11. Visible Tests

Include about 15--20 visible tests establishing basic contracts without
exposing hidden traps. Suggested initial state: roughly 12 passing and 5
failing.

## 12. Hidden Evaluator

Participants must not see hidden tests. Use roughly 25 hidden properties
including persistence after drag, ordering, drawer synchronization,
analytics after deletion, AND filtering, search+filter composition,
label normalization, activity deduplication, timestamp sorting, v0
migration, malformed storage recovery, empty-board handling, zero-issue
completion percentage, filtered editing, and drawer behavior after
deletion.

## 13. UI/UX Requirements

Require a polished professional project-management product without
supplying an exact target screenshot.

Expect clear hierarchy, responsive layout, readable cards, polished
drawer, hover/focus states, keyboard accessibility, sensible empty
states, and no obvious overflow.

Test at 1440px, 1024px, and 768px.

## 14. Quality Scoring

Total quality: **100 points**.

### Automated --- 80

  Area                               Points
  -------------------------------- --------
  Visible tests                          10
  Hidden functional tests                25
  Persistence/migration                   5
  Edge cases                              5
  Integration quality                    15
  Code quality                           10
  Participant-added useful tests          5
  Hygiene                                 5

### Human UI --- 20

  Category                  Points
  ----------------------- --------
  Overall polish                 5
  Information hierarchy          3
  Cards/board                    3
  Issue drawer                   3
  Interaction feedback           2
  Responsive quality             2
  Detail consistency             2

## 15. Primary Local-LLM Metrics

Per worker/task capture when available:

**Model performance:** TTFT, decode tok/s, input tokens, cache-read
tokens, output tokens, model steps, model wall time.

**Engineering performance:** task start, first meaningful artifact,
first passing test, completion, focused tests at completion, rework,
retries.

**Context performance:** session ID/generation, starting and ending
context size, compactions, context/cache growth, fresh vs reused.

**Reliability:** intervention-free completion, false completion, stall,
Captain wake-up, invalid tool call, scope expansion, integration defect,
retry/reassignment.

## 16. Worker-Level Results

Preserve individual worker records, not only team totals, so Flash vs
27B, local vs cloud, and task-type performance can be compared inside
and across runs.

## 17. Worker Utilization

Record available worker time, useful busy time, blocked-on-dependency
time, scheduler idle time, and unexplained idle time.

Compute:

`worker utilization = useful busy time / available worker time`

This distinguishes slow models from poor orchestration.

## 18. Session-Lifecycle Telemetry

For every worker task record:

-   logicalMember
-   taskId
-   attemptId
-   dispatchClass
-   sessionId
-   sessionGeneration
-   startedAt / completedAt
-   input/output/cache-read tokens
-   steps
-   compactions

This directly compares persistent versus fresh-session architectures.

## 19. Orchestration Metrics

Record tasks, dependencies, peak parallelism, utilization, idle time,
reassignments, retries, failed attempts, Captain takeovers, human
interventions, and review/SOTA findings if used.

## 20. Quality-Adjusted Engineering Throughput

Keep quality and speed separately visible. Primary visualization:
wall-clock minutes on X, quality score on Y; better systems move
upper-left.

Also calculate:

-   quality points / local GPU-hour
-   completed engineering tasks / GPU-hour
-   hidden tests passed / GPU-hour
-   tokens / completed task
-   minutes / completed task
-   quality points / million tokens

These are more useful for hardware decisions than raw decode speed
alone.

## 21. Time Limits

Target: **30--60 minutes**. Hard ceiling: **75 minutes**.

At the ceiling, stop and score the existing result as `TIME_LIMIT`.
Successful runs are `COMPLETED`.

## 22. Human Intervention

Default is **no human intervention**. Record every operator prompt
needed to wake, correct, or redirect the team. Target: zero.

## 23. Internet Policy

Disable web research. Allow repository, terminal, tests, and browser/UI
inspection. This reduces run-to-run variability.

## 24. Dependency Policy

Starter dependencies are locked/installed. No network installation
should be necessary. Added dependencies are reviewed under hygiene
scoring.

## 25. Reference Implementation

Maintain a private reference implementation with 100% visible/hidden
tests, passing typecheck/build, zero console errors, and approximately
18--20/20 UI quality. Participants never receive it.

## 26. Calibration

Before production comparisons run:

1.  Strong SOTA single agent --- establish quality ceiling.
2.  Captain + two capable workers --- establish expected team duration.
3.  Deliberately weaker configuration --- confirm discrimination.

Desired rough score distribution:

-   weak: 50--65
-   reasonable: 70--85
-   strong: 85--95
-   excellent: 95+

## 27. Initial Experimental Matrix

Focus first on local Flash.

  ---------------------------------------------------------------------------------
  Run            Captain          Workers        Session Policy Purpose
  -------------- ---------------- -------------- -------------- -------------------
  A              Flash            2× Flash       all reuse      Persistent baseline

  B              Flash            2× Flash       fresh          Session-policy
                                                 independent    effect

  C              stronger/cloud   2× Flash       fresh          Captain-quality
                                                                effect

  D              Flash            2× Flash + GLM fresh          Extra-concurrency
                                  overflow                      effect
  ---------------------------------------------------------------------------------

Repeat A and B at least once before drawing conclusions.

A vs B is the primary initial experiment: wall time, tokens/task,
compactions, stalls, rework, utilization, and quality.

## 28. Benchmark Report

Every run should generate a structured report containing configuration,
completion status, wall time, quality, visible/hidden results, UI score,
task/attempt/retry counts, peak parallelism, human interventions,
session rotations, compactions, token totals, utilization, and
efficiency metrics.

Example summary:

``` text
BENCHBOARD v1 — RUN bb-017

Captain        Qwen3.8 Flash
Workers        2× Qwen3.8 Flash
Session mode   fresh-independent

Status         COMPLETED
Wall clock     41m 18s
Quality        89 / 100
Automated      72 / 80
UI             17 / 20

Tasks          9
Attempts       10
Retries        1
Peak parallel  2
Human help     0

Worker sessions       6
Independent rotations 4
Compactions           1
```

## 29. Repository Isolation

Use a separate benchmark repository, e.g.:

``` text
<parent folder>/BenchBoard-Benchmark
```

Suggested private structure:

``` text
BenchBoard-Benchmark/
├── spec/
│   ├── BENCHMARK.md
│   ├── PRODUCT_PRD.md
│   └── SCORING.md
├── starter/
├── evaluator/
│   ├── hidden-tests/
│   ├── score.mjs
│   └── report.mjs
├── reference/
├── fixtures/
└── runner/
    ├── create-run.ps1
    ├── collect-metrics.mjs
    └── reset.ps1
```

A DSH team receives only a generated run directory containing the
starter app and PRODUCT_PRD.md. It must not see the evaluator, reference
solution, hidden tests, or scoring internals.

## 30. Repeatability and Run Isolation

Every run starts from identical immutable starter bytes, fixed fixture
data, and fixed IDs/timestamps where practical. Nothing from a previous
run survives.

Runner tooling creates isolated run directories/worktrees and records
benchmark/spec version plus starter hash.

## 31. Freeze and Version Rules

After calibration, freeze BenchBoard v1.0.

Do not change a bug because a particular model struggled. Do not clarify
the PRD because one model misunderstood it. Meaningful changes create a
new benchmark version, e.g. BenchBoard v1.1, and results from different
versions must not be mixed.

## 32. Implementation Deliverables

A fresh Codex/VS Code implementation session should build:

1.  starter application;
2.  realistic fixture dataset;
3.  seven seeded defects;
4.  visible tests;
5.  private hidden evaluator;
6.  private reference implementation;
7.  scoring engine;
8.  reset/run tooling;
9.  telemetry schema/collector;
10. benchmark documentation.

The benchmark designer should validate that the reference implementation
achieves the intended ceiling and that the starter workload fits the
target duration before v1.0 is frozen.

## 33. Guiding Principle

BenchBoard exists to answer:

> **How good is my local AI coding infrastructure at completing real
> engineering work?**

The web application is the standardized workload. The models, server
topology, DSH harness, Captain, worker architecture, context policy, and
orchestration behavior are the subjects under test.
