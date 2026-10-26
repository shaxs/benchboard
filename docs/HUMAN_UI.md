# Human UI Worksheet API (additive)

This guide documents the additive S3 UI worksheet surface: three functions that
turn a completed local human UI review into the unchanged scorer's human points,
bound to the report the review was made against. It is written against the
current checkout — the public module `packages/results/ui-worksheet.mjs`, the
Captain trust boundary `packages/results/ui-contract.mjs`, the closed JSON
Schema `schemas/ui-worksheet.schema.json` and the unchanged evaluator scorer
`evaluator/score.mjs`. It is checkout documentation, not an approved public
release, and it changes nothing about `docs/REPORTING.md`,
`docs/EVIDENCE_BUNDLE.md` or `docs/EVALUATION.md`.

## Purpose and trust limits

The worksheet is for a **private local self-assessment** of your own
submission's visible UI quality. It is not certification, not authentication,
and not an attestation that a named reviewer is who the text claims. The
parent Report stays exactly as `createReport` produced it: these helpers do
not attach a worksheet to a report, do not rewrite or re-digest a report, do not
publish anything, and do not open, hash or authenticate any screenshot, file or
network resource. S3 validates **worksheet metadata only**. Physical artifact
checks (bytes, digests, the real files behind each evidence entry) and immutable
attachment of a completed review to a report belong to the separate
[Publication API](PUBLICATION.md), not these metadata helpers. Raw worksheets, reviewer names and improvement
narratives are private participant material; they are **not** privacy-safe
exports and must not be shipped with a submission or a publication.

## Modules

| Module | Role |
| --- | --- |
| `packages/results/ui-worksheet.mjs` | The public surface. Exports exactly three functions: `createUIWorksheetTemplate(report)`, `readUIWorksheet(text, report)` and `scoreUIWorksheet(report, worksheet)`. No IO, no publication. |
| `packages/results/ui-contract.mjs` | The Captain trust boundary: `worksheetBindingsOf` and `validateUIWorksheet`, plus `UIWorksheetError` (code `UI_WORKSHEET_INVALID`). All validation lives here; the public helpers add none of their own. |
| `schemas/ui-worksheet.schema.json` | The closed JSON Schema (draft 2020-12). Unknown keys and invalid primitives are refused everywhere (`additionalProperties: false`). |
| `evaluator/score.mjs` | The unchanged scorer. The UI caps (`uiCaps`) and its `score(evidence, ui)` entry are used exactly as they are; nothing here re-implements or adjusts them. |

## The three functions

```ts
createUIWorksheetTemplate(report);
readUIWorksheet(jsonText, report);
scoreUIWorksheet(report, worksheet);
```

Import them from the public module:

```js
import {
  createUIWorksheetTemplate,
  readUIWorksheet,
  scoreUIWorksheet,
} from './packages/results/ui-worksheet.mjs';
```

A symbolic caller looks like this. Every name below is a caller-provided
variable, never a real host path or a real run:

```js
const report = await createReport(reportRequest); // a successful bound report the caller already holds
const worksheet = createUIWorksheetTemplate(report); // pending, intentionally invalid
// ... the reviewer fills reviewId, reviewer, reviewedAt, evidence, scores, notes, improvements,
// sets baselineCompared to true, and saves the JSON themselves (the caller owns all file IO) ...
const completed = readUIWorksheet(savedJsonText, report); // the contract's validated copy
const scored = scoreUIWorksheet(report, completed); // the unchanged scorer's result, status SCORED
```

- `createUIWorksheetTemplate(report)` requires a report whose evaluation
  succeeded and whose evidence bundle is bound. A report that first fails
  validation propagates the upstream report-layer, C4 bundle, measurement or
  C1 checks in their own classes (the newly integrated
  `MEASUREMENT_INTEGRITY` and C1 validation checks included; this is not an
  exhaustive list). A report that is intrinsically valid but records a
  non-success (for example infrastructure-error) evaluation is not an upstream
  error at all: it raises `UIWorksheetError` (code `UI_WORKSHEET_INVALID`)
  with the contract message `UI review requires a successful bound automated
  report`. It returns plain mutable JSON: the exact
  bindings and baseline the contract derives from the report, blank
  `reviewId`/`reviewer`/`reviewedAt`, `baselineCompared: false`, an empty
  evidence list, a `null` score and an empty note for each of the seven
  categories, and no improvements. **The blank template is intentionally
  invalid** — it exists to be completed, and a blank worksheet is never a
  reviewed zero.
- `readUIWorksheet(text, report)` takes JSON **text** (a string) and performs no
  file IO; the caller reads whatever file it already holds. Non-string input
  and malformed JSON are wrapped as `UIWorksheetError` (code
  `UI_WORKSHEET_INVALID`); everything else is the contract's validation, and the
  returned value is its defensive copy.
- `scoreUIWorksheet(report, worksheet)` validates through the contract first,
  then returns **exactly** the unchanged scorer's result for the report's bound
  evidence plus a closed projection of the validated review (evidence serialized
  as JSON text, each improvement reduced to its description string). There is no
  custom sum or formula here, and neither the report nor the worksheet is
  modified. The result carries the C4 score shape with numeric `humanUI` and
  `quality` and `status: 'SCORED'`.

Errors: a worksheet problem is always `UIWorksheetError` /
`UI_WORKSHEET_INVALID` — and so is a *valid* non-success parent report passed to
the template, which the contract refuses as "UI review requires a successful
bound automated report". A parent report that fails its own validation first
propagates the upstream report-layer, C4 bundle, measurement and C1 checks in
their own classes, without an exhaustive list.

## What validation actually checks (metadata only)

- **Bindings.** `reportId`, `reportDigest`, `evaluationId`, `bundleDigest`,
  `snapshotId` and `treeDigest` must equal, field for field, what
  `worksheetBindingsOf(report)` derives from the report, and `baseline` must
   carry the matching `challengeIdentityDigest`, `starterDigest` and
   `workloadDigest`. A substituted or stale value is a binding mismatch, refused.
   `starterDigest` equals the manifest-verified `workloadDigest`: the workload
   digest is computed from the exact starter inventory, not a second baseline.
- **Provenance.** What is actually checked: `reviewer` is a non-blank string
   (the schema requires at least two characters; the validator rejects a
  value that is empty or whitespace-only), and `reviewedAt` is a canonical UTC
  timestamp in the exact `YYYY-MM-DDThh:mm:ss.mmmZ` form that parses and
  round-trips identically (so an impossible date or an offset form is refused).
  `baselineCompared` must be `true`. These checks establish that a review names
  someone and a valid time; they do **not** authenticate the name and do not
  detect every placeholder or dishonest name — a made-up name that satisfies
  the format passes the metadata check, which is exactly why the trust limits
   above say this is a private self-assessment, not certification.
   A canonical timestamp is not independently authenticated chronology: these
   metadata helpers do not constrain it against report creation time or now.
- **Evidence metadata.** Exactly twelve entries — the two targets (`starter`,
  `submission`) × the three widths (1440, 1024, 768) × the two views (`board`,
  `drawer`) at height 1000 — each with a unique logical `artifactId` (a symbolic
  name like `submission-1024-drawer`, never a host path), a plausible `bytes`
  count and a 64-hex-digit `sha256` digest. These are recorded identity facts
  for a later physical check; **this layer never opens the files behind them or
  verifies that a digest matches anything.**
- **Scores and notes.** Every one of the seven categories needs an integer score
  within its cap and a meaningful evidence note. A positive score needs a
  matching positive **improvement pair**: a concrete, specific comparison
  description of at least a dozen characters plus a `starterArtifactId` and a
  `submissionArtifactId` naming the same width and view on the two targets.
   Inherited presentation alone earns zero, and zero never needs an improvement.
   Optional improvements on zero-scored categories are validated and passed
   through to the unchanged scorer; their presence does not award extra points.
- **Zero versus blank.** A completed worksheet that awards zero everywhere is a
  real reviewed zero: it scores, with `humanUI: 0`. The blank template is not
  zero — it is invalid, and `validateUIWorksheet` refuses it.

## The rubric (unchanged)

The seven categories and their caps come from the unchanged `uiCaps` and total
20 human points, always added to the automated 80:

| Category | Cap |
| --- | ---: |
| Overall polish (`polish`) | 5 |
| Information hierarchy (`hierarchy`) | 3 |
| Cards/board (`board`) | 3 |
| Issue drawer (`drawer`) | 3 |
| Interaction feedback (`feedback`) | 2 |
| Responsive quality (`responsive`) | 2 |
| Detail consistency (`consistency`) | 2 |
| Human total | 20 |

There is **no numerical reference score**. The recorded owner reference sanity
review is a pass/fail record of reference bytes, not a target score, and it is
not part of this API.

## How to review (public-safe script)

Compare the **same exact starter workload** the submission began from against
the submission itself, at logical widths **1440×1000, 1024×1000 and 768×1000**.
Capture board and drawer screenshots for the starter and for the submission at
each width: twelve screenshots in total. Record each one's logical artifact id,
byte count and SHA-256 in the worksheet's evidence list. Then work through the
same script on both sides:

1. Initial board impression; information hierarchy and overall polish.
2. Move one issue physically (drag) and once more by keyboard alone.
3. Open an issue in the drawer and edit title, description, priority, assignee
   and labels.
4. Change status in the drawer, close it, and press Escape.
5. Search; combine filters; a no-match result; clear the filters.
6. Reload the page and inspect persistence, the activity view and the analytics
   view.
7. Create and delete an issue, including the confirmation step, keyboard focus
   and focus return.
8. Repeat the board, drawer and filtered views at all three widths.

Score **visible product quality**, not preferred colors, pixel matching or
resemblance to any owner reference. Keep correctness findings separate, and do
not count one visible failure in more than one category. Write a concrete note
per category describing what you observed; for every positive score write the
starter/submission comparison it is based on. This guide includes no launch or
install commands; run both workloads however your environment provides, using
symbolic names for everything you record.

## The blank shipped worksheet

`docs/UI_WORKSHEET.json` is an **invalid blank illustration** showing the same
keys: placeholder ids, all-zero digest placeholders, `baselineCompared: false`,
blank reviewer/time/notes, `null` scores, empty evidence and empty
improvements. It is not a usable worksheet in this state — it stays invalid
until its placeholders are replaced with the real report bindings and the
review is completed and validated. Completing it by hand is possible but
discouraged for a real review: hand-typed values can easily leave a placeholder
digest or id standing as if it were a real fact. Generating the template from
the actual report with `createUIWorksheetTemplate(report)` gives the correct
bindings directly and avoids copying placeholders as facts. Either way, always
pass a completed worksheet back through `readUIWorksheet` (or
`validateUIWorksheet`) before scoring it — a completed worksheet must validate
before it can score.
