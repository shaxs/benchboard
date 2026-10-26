# Complete results API flow (crosswalk)

This guide is a crosswalk: it names each supported module of the current results
flow, what it contributes, and how the calls chain on a caller who already holds
everything each step needs. It is written against the current checkout and is
checkout documentation, not an approved public release, not a CLI, and not a
promise of any guarantee beyond the contracts each module actually declares. It
changes nothing about the per-area guides it links; those stay authoritative for
their own surface.

## The flow, one call at a time

```js
import { evaluateFrozen } from './packages/evaluation/evaluate-frozen.mjs';
import { createReport } from './packages/results/report.mjs';
import { saveReport, readPublishedReport, attachUIReview } from './packages/results/publication.mjs';
import { createExportProjection } from './packages/results/export-contract.mjs';
import { renderReportJSON, renderReportText } from './packages/results/exports.mjs';
import { compareResults } from './packages/results/comparison.mjs';
import { renderComparisonJSON, renderComparisonText } from './packages/results/comparison-exports.mjs';

// Values are caller-provided: evaluationRequest selects saved frozen bytes and an
// exclusively new outputRoot whose parent exists; store/review roots already exist.
// Evaluation reads frozen files, creates output and runs its bounded tools.
// Report/publication verify files and publication writes new immutable records.
// Export/comparison operate in memory and return strings; nothing installs dependencies.

const evaluation = await evaluateFrozen(evaluationRequest);
// This example follows the successful reviewed flow only. Infrastructure results
// can be handled separately with createReport, whose quality stays null, but
// publication still requires its explicit existing roots and verified artifacts.
if (evaluation.status !== 'success') throw new Error('example stop: successful evaluation required');

const report = await createReport({
  reportId: myReportId,
  createdAt: myCreatedAt,
  selection: evaluationRequest.submission, // the same saved frozen selection the run used
  evaluation,                              // the returned C4 result (success or infrastructure-error)
});

const saved = await saveReport({
  storeRoot: myStoreRoot,
  runRoot: evaluationRequest.submission.runRoot, // the existing sealed run root
  evaluationRoot: evaluationRequest.outputRoot,  // the evaluation's own output directory
  report,
});

// ... the reviewer completes a UI worksheet outside these APIs; see HUMAN_UI.md ...

const child = await attachUIReview({
  storeRoot: myStoreRoot,
  runRoot: evaluationRequest.submission.runRoot,
  evaluationRoot: evaluationRequest.outputRoot,
  parentReportId: saved.reportId,
  reportId: myChildReportId,
  createdAt: myChildCreatedAt,
  worksheet: completedWorksheet,
  reviewRoot: myReviewRoot,
});

const published = await readPublishedReport({ storeRoot: myStoreRoot, reportId: child.reportId });
const projection = createExportProjection(published);
const reportJson = renderReportJSON(projection);   // strings; writes nothing
const reportText = renderReportText(projection);

// Compare the actually saved baseline against the actually published reviewed
// child: the caller's own held records, baseline first.
const comparison = compareResults({ inputs: [saved, published], baselineIndex: 0 });
const comparisonJson = renderComparisonJSON(comparison); // strings; writes nothing
const comparisonText = renderComparisonText(comparison);
```

The roots differ in what they must be by: the evaluation request's `outputRoot`
is an **exclusively new** directory — its parent must exist, the directory itself
must not, and the evaluation creates it exclusively (never a participant or
protected directory). Everything the later calls read — the publication
`storeRoot`, `runRoot`, `evaluationRoot` and `reviewRoot` — must already exist as
an ordinary, canonical absolute path the caller already holds, pairwise disjoint:
the publication surface refuses overlapping, duplicate or linked roots rather
than creating, resetting or inferring anything from the current working
directory. The publication `evaluationRoot` is simply the evaluation's already
produced output directory, bound to the same `evaluationRequest.outputRoot` field
above. Nothing in the chain auto-creates a run or a store.

## What each step is

| Call | Module | What it contributes |
| --- | --- | --- |
| `evaluateFrozen(request)` | `packages/evaluation/evaluate-frozen.mjs` | Runs the established stages over the verified frozen submission with real production collaborators only, creating its exclusively new `outputRoot` and the bounded stage processes it manages there. Resolves with a success carrying a validated `bundle` (top-level `score` `null`; the automated score is `bundle.score`), or returns the infrastructure-error shape with null `bundle`, `evidence` and `score`. Integrity and safety refusals reject; see [Evaluation](EVALUATION.md) and [EvidenceBundle](EVIDENCE_BUNDLE.md). |
| `createReport({reportId,createdAt,selection,evaluation})` | `packages/results/report.mjs` | Re-verifies the frozen bytes and sealed run, then projects the returned evaluation into one closed local `Report` bound to that run. See [Reporting](REPORTING.md). |
| `saveReport({storeRoot,runRoot,evaluationRoot,report})` | `packages/results/publication.mjs` | Publishes the validated baseline report immutably under its commit marker after re-verifying the run and every evidence artifact. See [Publication](PUBLICATION.md). |
| completed UI worksheet | [HUMAN_UI.md](HUMAN_UI.md) | The human review is made outside the publication calls: the worksheet helpers template, read and validate the private review; the reviewer and their own file handling own it. |
| `attachUIReview({storeRoot,runRoot,evaluationRoot,parentReportId,reportId,createdAt,worksheet,reviewRoot})` | `packages/results/publication.mjs` | Validates the worksheet against the committed parent, verifies the physical review files, scores through the unchanged scorer and publishes a new reviewed child report; the parent is never rewritten. |
| `readPublishedReport({storeRoot,reportId})` | `packages/results/publication.mjs` | Reads one committed report: requires its commit marker to match the validated stored record. The read takes the store lock and may write storage/lock metadata; it never rewrites the immutable report or marker bytes. |
| `createExportProjection(report)` | `packages/results/export-contract.mjs` | Validates the input as a private report and projects the closed, privacy-reviewed export form: bounded names, digests, pseudonyms, bounded numbers, timestamps and nulls, with no free text. See [Exports](EXPORTS.md). |
| `renderReportJSON` / `renderReportText` | `packages/results/exports.mjs` | Pure string renderers of a validated projection. They re-validate first, touch no filesystem and apply no privacy filter beyond validation. |
| `compareResults({inputs,baselineIndex})` | `packages/results/comparison.mjs` | Builds one descriptive comparison over the caller's own stored records: every input retained at its index with a disposition; numeric deltas only where challenge, workload and actual semantic identity match. Always `formalComparisonAvailable: false`. See [Comparison](COMPARISON.md). |
| `renderComparisonJSON` / `renderComparisonText` | `packages/results/comparison-exports.mjs` | Pure string renderers of a validated comparison; writes nothing. |

## Score semantics in the flow

- The human 20 points come only from a completed, bound human review. Where tests
  carry a full UI score of 20, those are synthetic test evidence bytes — a
  protocol fixture, not an actual human grade. See [Scoring](SCORING.md).
- Until a review is bound, `humanUI` and the final `quality` are `null`, never a
  zero or a default. Unknown is always null.
- A baseline-versus-child comparison is automated-only while the review is
  pending: the automated delta is available, the human-UI and quality deltas stay
  null, never zero-filled. Computing those further deltas needs two scored
  reports — a human review bound on both sides.
- Every comparison is descriptive, manual and unenforced, not formally controlled,
  and never a certification or a release.

## Privacy, and what the records are not

- A local report embeds its full evidence bundle and relative artifact
  inventory. Do not publish or export a whole raw report: use
  `createExportProjection` and its renderers for the safe summaries.
- Pseudonyms in a projection are unsalted, domain-separated hashes: anyone with a
  candidate identifier list can mount dictionary and correlation attacks, and the
  structured disclosures (scores, digests, byte counts, timestamps) are retained
  intentionally. The projection is not anonymity and not a guarantee that no
  sensitive context remains.
- Nothing here authenticates a reviewer, certifies a result, or promotes a local
  self-assessment into external authority. Trust is `LOCAL_SELF_ASSESSMENT`, not
  certified, enforcement is manual, and formal comparison is unavailable.
- There is no release, operating-system sandbox, platform or privacy guarantee
  beyond the cooperative, declared contracts of the modules themselves.

## Errors and immutability in the flow

- Modeled infrastructure failures, including CLEANUP_FAILED, return evaluation
  results with bundle, evidence and score null. A Report created from an accepted
  infrastructure result has quality:null and evidence.bundle:null; its evidence
  container and provenance remain present. Typed integrity/safety refusals and
  unhandled unknown errors reject instead of becoming a success or a zero-point
  result. Publication keeps its own root/artifact preconditions and may itself
  reject.
- The frozen submission, the evaluation result, committed reports and parent
  reports stay preserved: publication adds records and never rewrites an
  immutable one. A late error after the commit marker exists can retain a
  complete publication; the marker is what makes a record committed.
- A publication read may write lock or storage metadata while leaving the record
  bytes untouched; the export and comparison steps write nothing at all.

## Prerequisites, and no installation

None of these calls installs a dependency. The installed tooling is a
precondition of evaluating: `evaluateFrozen` preflights the installed Playwright
Chromium and fails with `MISSING_PREREQUISITE` when it is absent rather than
installing or downloading anything. It is the step that does the real reading and
running: the evaluation verifies the frozen bytes, launches and supervises its
bounded stage tool processes, and starts and stops its own loopback development
server for the browser stage; that service lives only for the evaluation, and the
caller is never asked to run a service-management command. The report and
publication calls do their own re-verification reads, and the export and
comparison calls touch no filesystem at all: `createExportProjection`, the render
helpers and the comparison are pure in-memory validation and string rendering.

## Guides

Per-area authority: [Scoring](SCORING.md) for the 80 plus 20 scoring authority,
[Human UI](HUMAN_UI.md) for the worksheet, [Publication](PUBLICATION.md) for the
store, [Exports](EXPORTS.md) for the safe projection and its privacy policy,
[Compatibility](COMPATIBILITY.md) for older-record views,
[Comparison](COMPARISON.md) for the descriptive comparison,
[EvidenceBundle](EVIDENCE_BUNDLE.md) for the bundle inside the evaluation, and
[Evaluation](EVALUATION.md) for the evaluation facade itself.

## Testing

```text
node --test tests/results/results-api-documentation.test.mjs
```

That check is static: it reads this guide, the evidence-bundle guide and the
facade sources and asserts they name the flow and keep the boundaries above. It
runs no evaluation, no publication and no server.
