# Candidate.8 scoped independent review scope (owner-only)

Candidate.8 remediates the independent candidate.7 CHANGES_REQUESTED verdict,
preserved verbatim at `artifacts/fairness-review-candidate.7.md`. The
candidate.5 and candidate.6 verdicts are preserved alongside it.

Participant workload, hidden evaluator semantics, reference implementation and
`evaluator/score.mjs` remain byte-identical to candidate.4.

## Root correction: one immutable execution identity

The candidate.7 reviewer proved that individually-correct records could be
validated without belonging to one actual governed execution: a genuine
synthetic watchdog lifecycle with no official dispatch and no official
execution record still produced all four validity/eligibility flags true.

`runner/execution-identity.mjs` makes the lifecycle binding durable. An
execution identity is minted ONLY by `OFFICIAL_DSH_BENCHMARK` launch and binds
run, team, candidate/workload, declared ceiling, startedAt, deadlineAt,
watchdog PID and the watchdog instance nonce. Its digest is recomputed on every
use, so recombined or edited evidence cannot pass.

```
seeded run (persisted on disk, authoritative)
  -> governed launch mints RUN EXECUTION IDENTITY
  -> watchdog ARMED record + live heartbeat carrying the instance nonce
  -> first Captain dispatch (revalidated against the identity)
  -> continuous supervision
  -> natural completion OR deadline halt
  -> positively proven quiescence (coverage over validated identities)
  -> execution record
  -> schema 1.2 telemetry bound to the identity
  -> private evaluation eligibility
  -> formal comparison eligibility
```

Every official downstream artifact carries and validates the same identity.
No execution identity means no current official outcome; a wrong one is rejected.

| Finding | Correction |
|---|---|
| ROOT | execution identity minted only by the governed launch; every artifact binds to it |
| H1 | the persisted disk seed is authoritative; a caller manifest is only a claim, compared then discarded; cross-run supervision evidence refused; legacy schemas cannot be promoted |
| H2 dispatch | instance proof by heartbeat nonce plus ARMED freshness and the watchdog's shared clock, not PID liveness alone |
| H2 terminal | positive verification of identity, run, team, instance, deadline, admissible outcome, `quiescent === true` and stop/completion proof |
| H2 eligibility | one `projectOutcomeEligibility` projection; all flags derived and frozen |
| H2 marker | a lost or failed supervision lifecycle keeps a durable marker so the run never looks cleanly finalized |
| EVAL | private evaluation requires the exact identity, a valid record, verified termination, confirmed quiescence and a frozen submission hash |
| report() | the official API consumes the bound execution record; descriptive analysis must be requested explicitly |
| H3 | identity-set validation (missing/empty/duplicate/conflicting) before any coverage map; no positional synthesis |
| H4 | whole-run completion is the last required authority to go quiescent, with task/worker/Captain instants preserved separately |
| H6 | positive, correctly typed completeness; contradictory governance fields fail closed |

## Mutation evidence

`artifacts/candidate8-mutations/` holds 25 PERMISSIVE mutations: the safety
check still executes but stops rejecting the unsafe state, so a red designated
test proves the property rather than proving malformed code crashes. This
directly addresses the two weak candidate.7 cases:

- `ROOT-governed-record-required` replaces the missing-manifest mutation that merely raised `TypeError`.
- `H2-missing-terminal-record` replaces the terminal-file mutation that merely raised `ENOENT`.

The 25th, `SELFTEST-manifest-side-effect`, covers the finding below.

Each mutation directory contains the applied patch, the full test output log
and a result record. `summary.json` aggregates them.

## Owner self-test side effect (found during this pass, not reported by the reviewer)

Running `npm run self-test` against a committed
`artifacts/candidate-manifest.json` that does not equal the recomputed tuple
made the review-input no-mutation regression FAIL. That is the reviewer's own
fresh-checkout condition, so it mattered.

Cause: `runner/tests/ceiling.test.mjs` called `writeSnapshot()` without
`BENCHBOARD_MANIFEST_PATH`, so the reviewed manifest was rewritten whenever the
recomputed tuple differed from the committed bytes. The run then looked clean
on every subsequent invocation, because the manifest was already current.

This is the same class of defect the candidate.2 reviewer reported for
`artifacts/deadline-smoke.json`, and it was the remaining instance of it.

Correction: the ceiling suite redirects the snapshot to disposable scratch, and
a new behavioural regression in `runner/tests/preservation.test.mjs` stales the
manifest on purpose, runs the snapshot-touching suites in a child process with
`NODE_TEST_CONTEXT` stripped, requires positive evidence that the child really
executed, and requires the reviewed bytes to survive. `SELFTEST-manifest-side-effect`
is its permissive mutation. `artifacts/candidate8-selftest.json` records both
the clean run and the deliberately-stale run so the property is measured.

## Test consolidation

`artifacts/candidate8-test-consolidation.json` records, for each of the eight
candidate.6/.7 tests removed, the strictly stronger candidate.8 test that
subsumes it and why. The map exists so an independent reviewer can verify test
by test that no property lost coverage.

## In scope

Execution-identity minting and binding; disk-seed authority and legacy
classification; dispatch instance proof, freshness and shared clock; terminal
stop proof; eligibility projection; durable failure markers; the private
evaluation termination gate; the official reporting API; identity-set
validation; whole-run completion attribution; strict formal comparability;
H5/M1/UI non-regression; owner self-test side-effect freedom; provenance and
preserved verdicts.

## Out of scope unless the hash proof fails

Participant workload, PRD, visible contracts, fixtures, hidden properties,
reference implementation and scoring semantics.

## Reviewer independence

The governed execution identity was authored by the implementation author.
Route this scoped review to an independent reviewer that did not implement it.
