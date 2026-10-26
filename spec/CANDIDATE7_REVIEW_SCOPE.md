# Candidate.7 scoped independent review scope (owner-only)

Candidate.7 remediates the independent candidate.6 CHANGES_REQUESTED verdict
(H1-H6 composition failures; M1 affirmed resolved), preserved verbatim at
`artifacts/fairness-review-candidate.6.md`. The candidate.5 verdict is
preserved at `artifacts/fairness-review-candidate.5.md`.

Participant workload, hidden evaluator semantics, reference implementation and
`evaluator/score.mjs` remain byte-identical to candidate.4.

## Root correction: one official governed run path

The candidate.6 reviewer established that the remaining failures were
composition failures: correct helpers existed but official stages could reach
around them. Candidate.7 establishes one governed chain in which no stage can
bypass the previous stage by calling a weaker helper.

```
seeded run manifest            seededAuthority (the only ceiling authority)
  -> supervision binding       bindSupervisionTiming
  -> watchdog ARMED + live     assertDispatchAllowed
  -> first Captain dispatch    supervise(mode OFFICIAL_DSH_BENCHMARK) only
  -> continuous supervision    observeUntilCompletionOrDeadline
  -> completion or halt        proveQuiescence coverage proof
  -> immutable record          SupervisionLedger monotonic evidence
  -> telemetry ingestion       official ingest requires authority + supervision
  -> evaluation eligibility    outcomeClass / supervisionValid
  -> formal comparison         formalComparability on the original set
```

| Finding | Composition failure | Correction |
|---|---|---|
| H1 | authority existed but official ingestion could bypass it | official ingestion resolves and requires seeded authority; legacy is explicitly historical/unbound/descriptive and ineligible |
| H2 dispatch | ARMED gate existed but was optional | `OFFICIAL_DSH_BENCHMARK` is the only benchmark route and structurally requires the binding; `GENERIC_COMMAND` is a separate, explicitly non-benchmark mode |
| H2 survival | liveness checked only at dispatch | `reconcileSupervision` requires a valid terminal record from the same bound watchdog, propagating to execution evidence, telemetry validity and eligibility |
| H3 | per-row scan, no identity coverage | `proveQuiescence` is a coverage proof over the expected execution identity set |
| H4 | one failed confirmation abandoned observation | observation continues to completion, deadline or supervisor failure; attribution is validated and failures preserved |
| H5 | bound ended before body consumption | `boundedRequestText` keeps the abort deadline armed through the body |
| H6 | predicate applied after presentation filtering | assessment runs on the original requested set with positive field completeness |
| M1 | resolved | preserved and regression-tested |

## In scope

1. Official telemetry authority and the historical/unbound classification.
2. The single official launch path and its pre-dispatch revalidation.
3. Supervision-lifecycle reconciliation and invalidity propagation.
4. Quiescence coverage proof.
5. Continuous early-completion observation and attribution validation.
6. Whole-lifecycle network bounds.
7. Original-set formal comparability and positive field completeness.
8. Mutation evidence quality, including the formerly surviving mutation.
9. Reference UI acceptance resolution by reference hash.
10. Candidate provenance and preserved prior verdicts.

## Out of scope unless the hash proof fails

Participant workload, PRD, visible contracts, fixtures, hidden properties,
reference implementation and scoring semantics.

## Mutation evidence

`artifacts/candidate7-mutations/` holds, per mutation: the applied patch, the
full test output log, and a result record stating whether the designated
behavioural test failed and whether bytes were restored byte-identically.
`summary.json` aggregates them. No source scanner is used as sole proof.

## Reviewer independence

The governed chain was authored by the implementation author. Route this
scoped review to an independent reviewer that did not implement it.
