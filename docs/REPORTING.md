# Report API (additive)

This guide documents the additive Report surface: two functions that project a
returned C4 evaluation, bound to the real C3 verification of the frozen run it
came from, into one closed local record. It is written against the current
checkout — the public module `packages/results/report.mjs`, the Captain trust
boundary `packages/results/report-contract.mjs`, the Captain verification seam
`packages/results/report-context.mjs` and the closed JSON schema
`schemas/report.schema.json`. It is checkout documentation, not an approved
public release, and it changes nothing about `docs/EVALUATION.md` or
`docs/EVIDENCE_BUNDLE.md`, which keep describing the evaluation result and the
evidence bundle exactly as they are.

## Modules

| Module | Role |
| --- | --- |
| `packages/results/report.mjs` | The public surface. Exports exactly two functions: `createReport(request)` and `readReport(text)`. It publishes nothing and returns a validated defensive copy. |
| `packages/results/report-contract.mjs` | The Captain trust boundary. Schema validation, digest recomputation and bundle-binding checks; its own contract refusals throw `ReportIntegrityError` (code `REPORT_INTEGRITY`). |
| `packages/results/report-context.mjs` | The Captain verification seam `resolveReportContext(request)`: the real C3 re-verification of the frozen selection and sealed run that every report is bound to. It is not a public import of this guide. |
| `schemas/report.schema.json` | The closed JSON Schema (draft 2020-12), supplemented by semantic checks. Operational source records retain their established C3 schemas. |

## The two functions

```ts
await createReport({ reportId, createdAt, selection, evaluation });
readReport(jsonText);
```

The optional `metrics` request field accepts one bounded, cache-inclusive neutral
run total. Omit it when token counts are unavailable; see [Measurements](MEASUREMENTS.md).

`createReport` is asynchronous: it re-verifies the frozen bytes and the sealed
run before it projects anything. `readReport` is synchronous over JSON **text**
(a string) — it does no file IO; the caller reads whatever file it already
holds, and neither function writes, publishes or sends anything.

A symbolic caller looks like this. Every name below is a caller-provided
variable, never a real host path or a real run:

```js
const evaluation = await evaluateFrozen(evaluationRequest); // caller's own C4 call, first
if (evaluation.status !== 'success' && evaluation.status !== 'infrastructure-error') {
  // evaluateFrozen refused: that is a thrown error, and this branch never runs.
}
const selection = savedSelection; // a C4 FrozenSelection the caller already holds
const report = await createReport({
  reportId: myReportId,
  createdAt: myCreatedAt, // an explicit UTC timestamp the caller supplies
  selection,
  evaluation,
});
const roundTripped = readReport(JSON.stringify(report)); // same validated record
```

`selection` is the C4 `FrozenSelection` with exactly its six fields: `runRoot`
(a canonical absolute path the caller already has), `runId`, `manifestId`,
`snapshotId`, `frozenSubmissionId` and `expectedDigest` (the sealed
run-manifest digest). The caller first awaits `evaluateFrozen` separately and
hands its **returned** result in; only the two returned statuses
(`success` and `infrastructure-error`) are report inputs. A thrown refusal —
the evaluation's request/safety refusals and evidence-integrity rejections, or
this surface's own integrity refusals — is **not caught and made into a
report**; it propagates to the caller, who holds it. There is no verification
bypass, no other evaluator and no option to relax any check: an undocumented
request key is refused outright.

## What `createReport` verifies

Before any projection, `createReport` runs the real C3 verification through the
Captain seam and refuses unless:

- the explicit saved selection verifies: the frozen bytes match their recorded
  hashes (`verifyFrozenSubmission`), the snapshot and frozen-submission ids
  match, and the state is frozen;
- the sealed run opens and its manifest recomputes to exactly `expectedDigest`
  — the explicit saved C3 selection and the sealed run are both re-checked, not
  trusted;
- the returned evaluation's bundle, if any, matches every run, challenge,
  tooling, evaluator and submission binding, and its evaluation id matches;
- the projected report itself passes the closed schema, a recomputed
  `reportDigest`, a valid UTC timestamp and the evidence re-checks (bundle
  validity, binding agreement, bundle digest, score equality against the
  unchanged scorer, actual-evaluator identity and artifact agreement).

Modified frozen bytes, an active or mismatched run, a tampered digest or an
inconsistent bundle are refusals, not degraded reports, and no successful
report is returned on any of them. The refusal classes are honestly separated
per layer. This report layer's own checks — the report's schema shape, the
canonical UTC timestamp, the report self-digest, the report self-evidence
references (evaluation id, bundle digest, carried score, actual evaluator,
artifact list) and the bundle-vs-report cross-binding agreement — throw
`ReportIntegrityError` (code `REPORT_INTEGRITY`), and `readReport` wraps
malformed JSON or non-string input in that same class. A semantically invalid
evidence bundle throws `EvaluationIntegrityError` (code `EVIDENCE_INTEGRITY`)
propagated from the bundle validation, even when the report's JSON schema and
self digest are otherwise valid: for example a bundle score that differs from
the unchanged scorer, a semantic or package manifest digest mismatch, an
original scoring identity mismatch, a snapshot/tree digest inconsistency or a
duplicate artifact path — so a digest- or evidence-invalid report is not
categorically a `REPORT_INTEGRITY`. `createReport` additionally propagates
the C3 `LifecycleError` it raises from the seam — for example `NOT_FOUND` for
no saved publication or `PROVENANCE_MISMATCH` for a wrong manifest digest — and
the staging `EvaluationRefusalError` code `UNSAFE_PATH` for a linked run
ancestor, plus the `EVIDENCE_INTEGRITY` of a success bundle it validates.
Neither layer rewrites the other's errors: a JSON parse failure is a
`REPORT_INTEGRITY`, not a `LifecycleError`. What is constant across every
class: a refused request yields no report. Creation and read do not publish
anything: no network, no export step, no persistence for you.

Measurement/source checks can also throw `MeasurementIntegrityError` (code
`MEASUREMENT_INTEGRITY`); C1 Measurement validation errors retain their own class.
These are not exhaustive error lists: raw filesystem errors such as `ENOENT`
from a missing run root can propagate unchanged. No error becomes a zero score.
For a reviewed child, worksheet metadata/binding errors may propagate as
`UIWorksheetError` (`UI_WORKSHEET_INVALID`); reading never repairs the review.

## Report versus Result: additive, and the C1 Result is unchanged

The Report is a new, separate record (`kind: 'Report'`). The C1 `Result` and
the S1 evaluation result envelope are untouched by it: nothing is removed,
renumbered or reinterpreted, and no existing consumer is forced to read a
Report. The Report **binds** them together: its `bindings` block carries the
verified run, snapshot, submission and identity records, its `evidence.bundle`
carries the complete validated evidence bundle, and its `quality` is that
bundle's score.

That statement describes baseline creation. A reviewed child created through
[Publication](PUBLICATION.md) retains the same automated block/evidence but
carries the unchanged scorer's bound human and final quality, explicit parent
ID/digest and its private validated worksheet. It never edits the baseline.

## Quality: the unchanged scorer's block, and the pending human dimensions

The success quality comes from `evaluation.bundle.score` — the unchanged
established scorer's output, recomputed and required to match exactly. It is
**never** the top-level score: the evaluation result's top-level score is
`null` in both shapes, deliberately, for earlier-consumer compatibility. The
Report copies `bundle.score` and nothing else.

The human UI dimension of a newly created baseline is pending, not scored here: the carried score block
shows `humanUI: null` with `humanMaximum: 20`, `quality: null` with
`qualityMaximum: 100`, and the execution axis `humanReview: 'NOT_REVIEWED'`. No
zero or default stands in for the missing human review, and no human points
are invented. Likewise a successful evaluation never establishes that the agent
finished: `agentOutcome` is `null` — unknown, never a guess.

## The returned infrastructure failure

A returned C4 `infrastructure-error` result becomes a report with
`evaluatorExecution: 'INFRASTRUCTURE_ERROR'`, `quality: null`,
`actualEvaluator: null`, `evidence.bundle: null`, `evidence.bundleDigest: null`
and an empty `artifacts` array. No partial points, no partial evidence, no
zero. The failure's raw error diagnostic (its message and other private
detail) is **not** a report field and never appears in the record. Integrity
and safety refusals are not this path: they stay thrown and never become a
report at all.

## The axes are distinct, and enforcement is manual

`execution` carries four genuinely different axes, never collapsed into one
verdict:

- `agentOutcome` — `null` (unknown; not established by scoring);
- `evaluatorExecution` — `SUCCESS` or `INFRASTRUCTURE_ERROR` (did the
  evaluation machinery complete);
- `humanReview` — `NOT_REVIEWED` on baselines or `SCORED` on validated reviewed children;
- `assessmentTrust` — the constant `LOCAL_SELF_ASSESSMENT` (this record is a
  local self-assessment, not an externally attested result).

`enforcement` is the constant `'manual'` with `enforced: false`: nothing in
this surface enforces anything, and no report claims otherwise. The
`configuration` block preserves the verified lifecycle declaration's `harness`,
`model`, `workerCount` and `declaredCeilingMinutes`. For an unstarted clockless
freeze it uses the sealed manifest's configuration and leaves `workerCount`
`null`. `executionMode` is the constant `'MANUAL'` — a successful evaluation
never lets the report infer configuration. Stopping is operator-attested, not
enforced by this report.

New reports carry thirteen C1 `measurements`, including unavailable rows with
literal null values and genuine measured zero where recorded. Private
`provenance.sources` retain the lifecycle, snapshot proof, evaluation reference
and optional entered token source. The reader checks source digests, overlapping
bindings and fixed derivations. Older S1 reports with both arrays empty remain
readable without inventing measurements. Baseline parentage/review are null;
the separate attachment API creates new records with explicit parentage/review.

## The binding digest and the actual evaluator digests are different things

`bindings.evaluatorIdentityDigest` is the neutral evaluator **binding**
identity recorded and sealed in the run manifest. `actualEvaluator` is the
projected identity of the evaluator that actually ran, taken from the bundle:
`semanticDigest`, `packageDigest`, `evaluatorVersion`, `scoringVersion` and
the recorded `originalCandidate` hashes. These are different hash domains by
design, and each field is checked against its own bound source:
`actualEvaluator.semanticDigest` must equal the bundle's evaluator
`semanticDigest`, `packageDigest` must equal the bundle's `packageDigest`, and
`bindings.evaluatorIdentityDigest` must equal the sealed binding digest the
verification read from the manifest. A substituted value is refused when it
differs from its own bound source — that is the check; the domains being
different is what the fields mean, not a categorical rule that equaling a
digest from another domain is itself grounds for refusal. The digests are
change detectors, not signatures: the digests prove nothing about who produced
the bytes.

## What `readReport` validates — and what it cannot

`readReport(text)` parses JSON text, applies the same closed schema,
recomputes and compares the report digest, requires a real UTC timestamp, and
for a successful report re-runs the intrinsic evidence checks: the bundle
validates, its identities agree with the report's bindings, the evaluation id
and bundle digest match, the quality equals the carried bundle score, the
actual evaluator matches the bundle's, and the artifact list matches the
bundle's. For a scored child, quality instead equals the unchanged scorer
invoked with its intrinsically validated parent-bound worksheet; this is not
independent confirmation that the named parent was physically published.
The publication API loads that parent from the committed store at attachment.
A tampered report throws; it is never repaired.

That is **intrinsic** validation: the record is checked against itself and
against the identities it carries. It is not certification and not independent
authentication. Reading a report does not contact anyone who could confirm the
run happened, re-verify bytes on a machine elsewhere, or attest the author. A
well-formed forged record that is internally consistent still passes
`readReport`; that is the declared limit of the local self-assessment trust
level, and the `LOCAL_SELF_ASSESSMENT` constant states it.

Two further intrinsic limits fix what the reader's cross-checks cover.
`readReport` cross-checks only the overlapping bundle fields the record
carries: the challenge, tooling and evaluator ids and digests, and the
`runId`, `snapshotId`, `frozenSubmissionId`, `manifestDigest` and
`treeDigest` bindings. The `manifestId`, the version labels and
`workloadDigest` are sourced from the verified manifest only at creation, so
the reader cannot independently re-verify them. The configuration is likewise
sourced at creation; when a lifecycle declaration is carried, the reader checks
its agreement but does not authenticate its origin. And an infrastructure report carries no
bundle binding proof connecting its `evaluationId` to the selected run: the
association is caller-attributed, while the selected frozen run is reverified
at creation and no quality is granted.

## A local report is not a privacy-safe export

The current local Report embeds its bound evidence bundle in full, including
the relative artifact inventory (`{ path, bytes, sha256 }` records with
output-relative paths). That makes the record useful locally and **not** a
privacy-safe export: the carried bundle and its surroundings can contain
material no export policy has reviewed. Do not publish raw local reports.
The [Human UI worksheet API](HUMAN_UI.md) now templates, reads and scores private
review metadata without modifying a Report or opening evidence files. The
separate [Publication API](PUBLICATION.md) verifies ordinary local artifacts and
saves immutable baseline/derived records. The separate
[Safe export API](EXPORTS.md) builds a closed, privacy-reviewed projection with
`createExportProjection` and renders it with `renderReportJSON` or
`renderReportText`. Saving a local Report is not a safe export. The separate
[Comparison API](COMPARISON.md) is now available for explicitly descriptive
local quality differences: `compareResults({inputs,baselineIndex})` and its
`renderComparisonJSON`/`renderComparisonText` renderers compute numerical
deltas only where challenge, workload and actual semantic identity match, stay
automated-only pending review UI, give every input a disposition, and imply no
formal comparison or eligibility.

## Current workflow, scoring and checkout command cross-links

This guide is an API reference for the two Report functions — `createReport` is
asynchronous and performs real C3 verification (filesystem reads and
re-verification), while `readReport` is synchronous validation over JSON text.
No other input method is added here. The rest of
the local workflow is documented in its own current guides:
[SCORING.md](SCORING.md)
states the fixed score areas; [CLI.md](CLI.md) and
[CLI_EVALUATION.md](CLI_EVALUATION.md) cover the checkout command line that
drives the lifecycle and the evaluation; [CLI_UI.md](CLI_UI.md) covers the
human-UI template and attachment commands; and [CLI_EXPORT.md](CLI_EXPORT.md)
covers the export command.

The command line is additive composition over these APIs. Programmatic Report
readers (`readReport`, the publication read APIs) and this Report surface stay
independent of CLI attempt history: they consume returned records and committed
publications, and nothing here requires a CLI history to work.

The score facts are the executable scorer's facts: the automated maximum is 80
and the optional human-UI maximum is 20, so a combined available quality can be
**at most 100** once a valid completed self-assessment exists — a completed
review is not guaranteed 100, and any other total including zero remains a real
score. While that review is pending, `humanUI`
and final quality remain `null` — a real unknown — which stays distinct from a
genuine completed zero in a scored child.

## Testing

```text
node --test tests/results/report-documentation.test.mjs
```

That documentation check is static: it reads this guide and asserts it names
the two APIs and the semantics above. It never runs a report, an evaluation, a
browser or a server. The functional suites for the report modules are separate
sibling suites and are not run here.
