# Candidate.5 scoped independent review scope (owner-only)

Candidate.5 is a methodology/runner correction discovered during empirical Calibration #1. The accepted candidate.4 participant workload, hidden evaluator behavior, reference implementation and scoring semantics are intended to be byte-unchanged, so this review is scoped rather than a full repeat of FAIRNESS_PROMPT.md.

Candidate.4's independent fairness PASS does not approve candidate.5. The candidate.4 acceptance records are correctly stale against the candidate.5 tuple and readiness matching was not weakened to avoid re-review.

## In scope

1. Per-run execution ceiling semantics: canonical `timeCeilingMinutes`, derived `timeCeilingSeconds`, valid range, and the absence of any competing ceiling field.
2. Deadline derivation: `deadlineAt` equals `startedAt` plus the declared run ceiling, and is not computed at seed time before a start exists.
3. Immutable run configuration: the ceiling is read from the seeded manifest rather than the launch call, a disagreeing launch-time value is rejected, evidence is rejected if the manifest ceiling changed while the official clock ran, and reset carries the declared ceiling forward.
4. Execution status and overrun fidelity: COMPLETED, TIME_LIMIT, TIME_LIMIT_OVERRUN, STOP_FAILURE and INFRASTRUCTURE_FAILURE; nominal deadline, `terminationRequestedAt`, observed stop, official and actual wall time, and overrun all retained rather than falsified or rejected.
5. Reporting: declared ceiling printed beside every quality result, quality documented as conditional on the ceiling, and absolute elapsed minutes on a shared plot axis rather than per-run normalisation.
6. A/B comparability: formal controlled comparison requires matching candidate identity and matching declared ceilings; mixed ceilings remain analysable but labelled descriptive and non-causal.
7. Methodology and provenance: append-only transition record, preserved historical anchors, and truthful current calibration documentation.

## Out of scope unless the hash proof fails

Participant workload, PRD, visible contracts, fixtures, hidden properties, reference implementation and `evaluator/score.mjs` scoring semantics. The packet carries an exact per-field hash comparison against candidate.4; if any of `starter`, `prd`, `visible`, `fixtures`, `reference`, `scoring` or `spec` differs, the methodology-only claim is void and the full review scope applies.

## Required reviewer inputs

- `artifacts/fairness-review-candidate.2.json` and `artifacts/fairness-review-candidate.4.md`: the preserved prior independent reviews, including the candidate.4 PASS this change builds on.
- `artifacts/methodology-history/methodology-change-candidate.4-to-candidate.5.json`: the append-only transition with exact before/after hashes and `participantWorkloadBytesChanged`.
- `artifacts/candidate5-ceiling-evidence.json`: the scoped ceiling evidence, including the unchanged-workload hash proof and Calibration #1 preservation proof.
- `runner/ceiling.mjs`, `runner/supervise.mjs`, `runner/create-run.mjs`, `runner/reset.mjs`, `runner/collect-metrics.mjs`, `runner/telemetry.schema.json`, `evaluator/report.mjs`.
- `runner/tests/ceiling.test.mjs` and the current harness log.
- `spec/CALIBRATION.md` execution ceiling policy, `spec/TRUST_MODEL.md`, `spec/SCORING.md` and `spec/SELF_VALIDATION.md`.

Calibration #1 run records live under `artifacts/runs/` and are deliberately excluded from review packets as run outputs; their preservation is proved by hash and recorded facts inside `artifacts/candidate5-ceiling-evidence.json`.

## Reviewer independence

A reviewer who authored the candidate.5 runner change cannot also provide its independent acceptance. Route this scoped review to an independent reviewer that did not implement it.
