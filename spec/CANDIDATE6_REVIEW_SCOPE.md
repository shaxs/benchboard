# Candidate.6 scoped independent review scope (owner-only)

Candidate.6 remediates the independent candidate.5 CHANGES_REQUESTED verdict
(H1-H6, M1), preserved verbatim at `artifacts/fairness-review-candidate.5.md`.
Participant workload, hidden evaluator semantics, reference implementation and
`evaluator/score.mjs` scoring remain byte-identical to candidate.4.

Candidate.5's CHANGES_REQUESTED verdict stands as history. Candidate.4's
independent PASS does not approve candidate.6.

## Root structural correction

H1-H5 and M1 were remediated as one supervision chain in `runner/supervision.mjs`
rather than six route-specific patches, and H6 as one authoritative
formal-comparability predicate in the same module:

> The seeded run declaration and continuously-live watchdog form one
> authoritative supervision chain from pre-dispatch through
> positively-confirmed termination, and evidence accumulated along that chain
> never becomes weaker.

| Finding | Chain element |
|---|---|
| H1 | `seededAuthority` / `bindSupervisionTiming` / `assertTelemetryMatchesAuthority` |
| H2 | `assertDispatchAllowed`, enforced by `runner/supervise.mjs` |
| H3 | `classifyActivity` / `classifyMember` / `confirmQuiescence` |
| H4 | bounded durable observation in `runner/dsh-watchdog.mjs` |
| H5 | `boundedFetch` on every supervision network operation |
| M1 | `SupervisionLedger` monotonic evidence |
| H6 | `formalComparability` / `assertFormalComparison` |

## In scope

1. Seeded-manifest authority end to end: watchdog timing, telemetry ingestion,
   and the impossibility of a caller-supplied conflicting ceiling becoming
   authoritative later.
2. Structural ARMED-before-dispatch binding of run, team, PID, ceiling and
   deadline, plus fail-closed behaviour when the watchdog is not alive at the
   dispatch authority edge.
3. Quiescence: only positively known idle surfaces may establish a valid
   stopped outcome; UNKNOWN and MISSING must fail closed.
4. Natural completion attribution and the distinction between actual
   completion and watchdog confirmation.
5. Bounded supervision network operations and their failure behaviour.
6. One authoritative formal-comparability predicate used by every formal
   comparison and reporting surface.
7. Monotonic failure evidence.
8. Regression and mutation quality: each finding has a behavioural
   counterexample test, and removing the safety property must turn it red.
9. Candidate provenance: candidate.5 verdict preservation, append-only
   methodology history, unchanged participant workload proof.

## Out of scope unless the hash proof fails

Participant workload, PRD, visible contracts, fixtures, hidden properties,
reference implementation and scoring semantics. The packet carries an exact
per-field hash comparison; if any of `starter`, `prd`, `visible`, `fixtures`,
`reference`, `scoring` or `spec` differs from candidate.4, the methodology-only
claim is void.

## Outstanding owner gate, not a review item

No owner reference UI sanity PASS has ever been issued for the current
reference bytes `e2ee06e8…`. The only PASS on record binds `97d97cbc…`, the
candidate.2/.3 reference, and candidate.4 changed the reference. There is
therefore no candidate.4 UI PASS to carry forward into candidate.5 or
candidate.6, and the implementation author did not manufacture one. The
readiness UI gate remains legitimately blocked pending an owner decision.

## Reviewer independence

The candidate.6 supervision chain was authored by the implementation author.
Route this scoped review to an independent reviewer that did not implement it.
