# Candidate.9 scoped independent review scope (owner-only)

Candidate.9 remediates the independent candidate.8 CHANGES_REQUESTED verdict,
preserved verbatim at `artifacts/fairness-review-candidate.8.md`. The
candidate.5, candidate.6 and candidate.7 verdicts are preserved alongside it.

Participant workload, hidden evaluator semantics, reference implementation and
`evaluator/score.mjs` remain byte-identical to candidate.4.

## Root correction: official authority is authentic by construction

The candidate.8 reviewer proved that `mintExecutionIdentity()` was exported and
required no governed launch, so ordinary code could manufacture a
seed-compatible identity, watchdog evidence, an execution record and telemetry
and obtain all three eligibility flags. Execution identity was descriptive
data, not launch provenance.

`runner/execution-authority.mjs` is the new launch boundary.

1. Nothing in its public surface mints an identity. The raw construction is
   private to the module that owns the launch boundary.
2. The only composed way in is `openOfficialExecution()`, which cannot run
   without a persisted seed, a live ARMED watchdog instance and a fresh
   heartbeat carrying that instance's nonce.
3. `openOfficialExecution()` PERSISTS the authoritative execution record
   exactly once (`wx`). Every later official stage calls
   `resolveOfficialExecution(runId)` and reads that record from its canonical
   path. No stage accepts a caller-supplied in-memory substitute.
4. Resolution re-verifies the record against the independently produced
   watchdog artifacts it names, so holding a record is not sufficient: the real
   ARMED record and heartbeat must exist and agree on run, team, PID, instance
   nonce, start, deadline and ceiling.

```
persisted seed
  -> official governed launch (openOfficialExecution)
  -> persisted authoritative execution record
       (execution id, run/team, candidate/workload, seeded ceiling,
        shared startedAt/deadlineAt, watchdog instance, dispatch provenance,
        supervision evidence)
  -> watchdog resolves it and binds its terminal record to it
  -> telemetry producer resolves it and states all nine bound facts
  -> ingest resolves it, never a caller object
  -> evaluation resolves it, plus the frozen submission
  -> report/formal comparison consumes the validated official outcome
```

**Honest limit.** This is lifecycle authenticity inside the cooperative trust
model, not adversarial security. Any local process can compute a SHA-256, so
authenticity rests on the persisted record plus the live-watchdog cross-checks
above, not on hiding arithmetic. Hand-writing owner artifact files is forging
owner evidence, which `TRUST_MODEL.md` places out of scope in the same way as
editing any other artifact. The property that IS enforced behaviourally is the
one the reviewer specified: no official launch -> no authoritative persisted
execution record -> no valid official telemetry, evaluation or report.

| Finding | Correction |
|---|---|
| ROOT | identity construction is private to the launch boundary; authority exists only as a persisted record created once by the governed launch and cross-checked against the real watchdog artifacts |
| Nine bound facts | `assertFullyBoundTo` requires every one of runId, teamId, candidateVersion, workloadHash, timeCeilingMinutes, startedAt, deadlineAt, watchdogPid, watchdogNonce to be stated and equal; absent is INVALID, different is INVALID, and there is no optional `expectedTeamId` bypass |
| H1 | the persisted seed and the persisted execution record are authoritative; a caller claim is compared then discarded |
| Producer/consumer | the real chain is tested end to end; the watchdog emits the identity claim, the launcher emits supervision evidence, and producer and consumer share one terminal vocabulary |
| Terminal vocabulary | `TERMINAL_OUTCOMES` with a deterministic mapping from the producer's status; `TIME_LIMIT_OVERRUN` now maps to `DEADLINE_OVERRUN_HALT` on both sides |
| One shared clock | the launch adopts the bound `startedAt`/`deadlineAt` and consumes `remainingMs = deadlineAt - now`; post-execution revalidation uses a `POST_EXECUTION` phase in which an elapsed deadline is the normal terminal condition |
| Eligibility monotonicity | one frozen projection additionally consumes the resolved authority, the persisted outcome's own validity, the incomplete-supervision marker and the frozen submission |
| Marker | `SUPERVISION_INCOMPLETE_REQUIRES_OWNER_VERIFICATION` blocks reconciliation, ingest and evaluation alike, whichever API was called |
| Submission freeze | the bytes at authoritative termination are persisted once (`wx`) and official evaluation compares against THAT hash, refusing if the workspace differs |
| Timestamps | malformed dates, impossible ordering and contradictory status/outcome combinations are all rejected, with the allowed combinations defined explicitly |
| H4 | an authoritative completion instant requires COMPLETE stop evidence; otherwise the conservative confirming observation is used and the missing timestamps are reported |

## Real producer -> consumer integration

`runner/tests/governed-chain.test.mjs` runs the actual chain:

```
createRun -> runWatchdog -> supervise(OFFICIAL_DSH_BENCHMARK)
  -> the watchdog's own terminal record -> reconcileSupervision
  -> produceOfficialTelemetry -> report/ingest -> assertEvaluationEligible
```

No hand-manufactured fields are injected between stages; every consumer reads
the previous producer's serialized output from disk. The DSH surface is a
loopback HTTP server plus the durable state files the watchdog reads, as the
reviewer's own probe used. No live DSH.

`runner/tests/governed-fixture.mjs` no longer hand-assembles records either: it
runs the real chain once per declared ceiling through
`runner/tests/produce-chain.mjs` and derives every fixture from those
serialized bytes, injecting exactly one defect per negative case.

## Mutation evidence, honestly categorised

`artifacts/candidate9-mutations/` holds 26 PERMISSIVE mutations. Each RED is
classified by what it actually demonstrates, and the categories are reported
separately rather than aggregated:

- `PROPERTY_PROVING` — the check still executes but stops rejecting, and the
  designated test catches the unsafe ACCEPTANCE.
- `CRASH_ONLY` — the test failed only because malformed code threw. Not offered
  as property proof.
- `PRESENCE_ONLY` — a required input was removed and the only failure is its
  absence.

**The candidate.8 25/25 claim is withdrawn.** The reviewer reproduced that
`ROOT-governed-record-required` failed only with a `TypeError`. It is replaced
by `ROOT-authority-not-required` and `ROOT-execution-outcome-ignored`, both
permissive, where a missing or invalid authoritative governed record would
otherwise be treated as valid. The useful missing-terminal and
manifest-side-effect mutations are kept; the missing-terminal case was
rewritten to be permissive rather than `ENOENT`-driven.

Four mutations initially SURVIVED and two were UNDETERMINED. Those were gaps in
candidate.9's own coverage, not reporting problems, and are closed by six new
tests (the projection's own contribution, authority without supervision
evidence, dispatch phases, H3 identity sets, M1 monotonicity, UI hash binding).

## Test consolidation

`artifacts/candidate9-test-consolidation.json` maps each property of the
removed `execution-identity.test.mjs` to the stricter candidate.9 test that
covers it. That suite could not be adapted because every test in it called the
factory the reviewer required to be made private.

## In scope

Execution-origin authenticity; persisted execution-record authority; the nine
mandatory bound facts; persisted-seed authority; the real producer -> consumer
chain; terminal vocabulary; the shared clock and dispatch phases; supervision
evidence serialization; eligibility monotonicity; incomplete-supervision
propagation; the frozen submission and the private-evaluation gate; terminal
timestamp chronology; conservative whole-run completion; H3/H5/M1/H6/UI
non-regression; self-test side-effect freedom; provenance and preserved
verdicts.

## Out of scope unless the hash proof fails

Participant workload, PRD, visible contracts, fixtures, hidden properties,
reference implementation and scoring semantics.

## Reviewer independence

The execution-authority boundary was authored by the implementation author.
Route this scoped review to an independent reviewer that did not implement it.
Candidate.9 carries no independent acceptance verdict.
