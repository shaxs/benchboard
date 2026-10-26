# Publication API (additive)

This guide documents the additive S4 publication surface: three async functions
that save a validated Report immutably into a caller-owned store, read a
committed Report back, and attach a completed human UI review — with its
physical evidence files verified — as a new reviewed child Report. It is written
against the current checkout — the public module
`packages/results/publication.mjs`, its internal runtime
`packages/results/publication-runtime.mjs`, the cooperative artifact boundary
`packages/results/artifact-verification.mjs`, the C1 storage layer and the
Captain report/UI contracts. It is checkout documentation, not an approved
public release, and it changes nothing about `docs/REPORTING.md` or
`docs/HUMAN_UI.md`, which keep describing the Report surface and the worksheet
helpers exactly as they are.

## Purpose and trust limits

Publication is local bookkeeping over caller-named roots. It commits a Report as
an immutable stored record with a deterministic commit marker, and it verifies
that the files the Report names are present, ordinary, unlinked and byte-identical
to their recorded digests at the moments it observes them. That is a cooperative
integrity boundary, not an operating-system sandbox: it makes no hostile-writer
or power-loss durability guarantee, and nothing here authenticates a reviewer, a
machine or a moment in time. A stored Report and its review evidence remain
private local self-assessment material — see the privacy section below.

## Modules

| Module | Role |
| --- | --- |
| `packages/results/publication.mjs` | The public surface. Exports exactly three async functions — `saveReport(request)`, `readPublishedReport(request)`, `attachUIReview(request)` — each returning `Promise<Report>`, and nothing else. There is no options object, no hooks parameter, no callback and no lock-stealing, expiry or force flag; a request carrying any field beyond its closed shape (including `hooks`) is refused as `PublicationError` `PUBLICATION_REQUEST` ("unknown options refused"). |
| `packages/results/publication-runtime.mjs` | The Captain-owned publication core. Its `saveReportWithStorageHooks` is the only place the C1 test/observation `StorageHooks` seam reaches publication, and it is an internal import for Captain fault-injection acceptance, never a public option. `publicationKeysOf`, `readPublishedReportInternal` and `attachUIReviewInternal` are its other exports. |
| `packages/results/artifact-verification.mjs` | The cooperative file/root boundary: `PublicationError`, `publicationRefusal`, `assertReportRoots` and `verifyReportArtifacts`. Checks, not a sandbox. |
| `packages/core/storage.mjs` | The reused C1 storage transactions: the single store lock (`withLock`), exclusive no-overwrite immutable publication (`createImmutable`) with its bound identity reservations, and `StorageError`. Publication adds no registry, no lock stealing, no lock expiry and no automatic unlock of its own. |

## The three functions

```ts
await saveReport({ storeRoot, runRoot, evaluationRoot, report });
await readPublishedReport({ storeRoot, reportId });
await attachUIReview({ storeRoot, runRoot, evaluationRoot, parentReportId,
                       reportId, createdAt, worksheet, reviewRoot });
```

Import them from the public module:

```js
import {
  saveReport,
  readPublishedReport,
  attachUIReview,
} from './packages/results/publication.mjs';
```

A symbolic caller looks like this. Every name below is a caller-provided
variable, never a real host path or a real run:

```js
const report = await createReport(reportRequest);   // a baseline you already created
const baseline = await saveReport({
  storeRoot, runRoot, evaluationRoot, report,
});                                                   // committed baseline Report
const worksheet = /* a completed worksheet the reviewer produced, per HUMAN_UI.md */;
const child = await attachUIReview({
  storeRoot, runRoot, evaluationRoot, reviewRoot,
  parentReportId: baseline.reportId,
  reportId: myNewChildId,                             // a fresh distinct id
  createdAt: myUtcTimestamp,
  worksheet,
});
const again = await readPublishedReport({ storeRoot, reportId: baseline.reportId });
```

The API infers nothing and creates no input for you: it never derives a root
from the current working directory and never creates a run, a store, an
evaluation output directory or a review directory, and takes no CLI, install,
browser or server role. It does write: the records and storage metadata it is
meant to publish (report, commit marker and the C1 store's own metadata) are
created under the store root you name. Every input root is an existing,
ordinary (non-link, non-junction), canonical absolute directory you already
hold. Store, run, evaluation and review roots plus
the repository root must be pairwise disjoint both lexically and after real-path
resolution; an overlap, a duplicate or a linked ancestor is a refusal
(`PublicationError` `PUBLICATION_PATH`, `PathError` `DUPLICATE_ROOT` /
`ROOTS_OVERLAP`, or the staging `EvaluationRefusalError` `UNSAFE_PATH`).

## What is stored, and how it is committed

Store filenames are hashed from the report id, so a publication is a pair of
records: the Report itself and a deterministic commit marker carrying the
report's id, digest and its evaluation, bundle, snapshot, tree and parent
references. Both are written through the C1 exclusive-immutable publication
under the store's single lock, so a completed report id can never be overwritten:
a second complete publication of the same id is refused (`PUBLICATION_DUPLICATE`).
The store can hold many immutable Reports side by side; nothing here deletes,
replaces or rolls back any stored or foreign bytes.

The Report value is validated and JSON-copied before storage; your object is
never stored by reference. What a saved baseline is: `createReport`'s record with
`execution.humanReview` required to be `NOT_REVIEWED` — saving an already-reviewed
report is refused (`PUBLICATION_REQUEST`), because reviewed records arrive only
through attachment with physical evidence.

## Baseline saving verifies the run and its evidence

`saveReport` re-runs the real C3 verification of the frozen submission the
report is bound to (the sealed run must still verify and still be frozen) and
verifies every artifact in the report's evidence list against the evaluation
root — once before the report bytes are published, and again after they exist
and immediately before the commit marker is created. After the marker exists,
only the evidence artifacts are re-checked; the C3 run verification does not
re-run post-marker. Evaluation artifacts are addressed by
their bundle-relative paths; each must be an ordinary file with exactly one link,
of the recorded byte count and SHA-256, under a link-free ancestor chain whose
ownership is re-checked. The inventory is bounded (at most 512 artifacts, 128 MiB
per file, 512 MiB total). A missing, added-size, tampered, hardlinked, symlinked
or traversing file refuses the save — the checks reject links, hardlinks,
traversal, non-ordinary files, missing files and tampered bytes they observe.
Crucially, the verification is read-only: the source evaluation artifacts,
the parent Reports and the frozen submission are never rewritten by
publication. A pre-marker refusal leaves the publication unavailable. A late
error can retain a complete publication, as described under interruption and
recovery; a thrown error is not proof that nothing was published.

## Attachment: a reviewed child, never an edit

`attachUIReview` reads the **committed parent** from the store by
`parentReportId` (it is not taken from you by value), validates the completed
worksheet against it through the Captain UI contract, re-verifies the frozen run
and the parent's evaluation evidence, verifies the physical review files under
`reviewRoot` — each named exactly by its worksheet `artifactId` directly under
that root, with no guessed extension — against the recorded bytes and SHA-256
under tighter review bounds (16 MiB per file, 192 MiB total), scores the review
through the **unchanged evaluator scorer**, and publishes a **new child Report**
under the fresh `reportId` with its own marker: the run, evidence and review
files are re-verified again immediately before the marker is created, and the
evidence and review files (not a new C3 run verification) are re-checked after it
exists. The child carries the explicit
parent id and parent digest, the explicit evaluation, bundle and snapshot
references, and the parent's original automated score block and evidence
untouched; only the human dimensions and the review provenance change. Changing
a review later means publishing a new child under a new id — no stored record is
ever revised. Same-id attachment against a completed publication is refused like
any duplicate.

Publication captures nothing: it launches no browser, takes no screenshot,
measures no viewport and authenticates no reviewer; it only compares existing
files to recorded digests. The repository's own publication tests drive this with
synthetic non-image bytes, not real UI captures. Two honest notes on the review's
human content, restating the [Human UI worksheet API](HUMAN_UI.md) limits at the
point where files meet records: the
worksheet's canonical UTC timestamp is a well-formed claim, not independently
authenticated chronology, and a positive category score is a human assertion that
the matching, byte-verified evidence files do not automatically prove. Optional
improvements recorded against zero-scored categories are validated and passed
through to the scorer without awarding points. The worksheet's `starterDigest`
is the manifest-verified `workloadDigest`, not a second baseline.

## Reading: records, not bytes

`readPublishedReport` requires the commit marker to exist, validates the stored
Report, requires its id to match the selected id and re-derives the marker from
the report and compares them field-for-field. A missing marker is
`PUBLICATION_INCOMPLETE`; a mismatched marker or a record whose id disagrees
with its container is `PUBLICATION_INTEGRITY`. This is verification of the stored
records and their agreement — on later reads it does not re-open the filesystem
artifacts or re-verify the frozen source, and it is not certification of
anyone. A read takes the same C1 writer lock and may create storage/lock
metadata; an active or orphaned lock yields `ERR_STORAGE_LOCK_CONFLICT`
and is never stolen.

## Interruption and recovery

There is one store lock and no second lock system. Publication inherits the C1
recovery semantics exactly:

- An interruption between publishing the report bytes and its marker leaves the
  publication **unavailable**: reads answer `PUBLICATION_INCOMPLETE`, and a
  *different* report bytes set under the same reserved identity is refused, never
  overwritten (`StorageError` `ERR_STORAGE_DUPLICATE_IDENTITY`).
- Retrying the **exact same baseline input** reconciles the state: the accepted
  immutable reservation and registered report are reused and the marker
  completes the publication, so the retry returns the committed report.
- A late error after the marker can retain a complete publication; the API
  discloses no rollback and performs none — read the record to inspect it before
  deciding any operator disposition.
- An orphaned accepted lock is reported as a lock conflict and is never expired,
  stolen or automatically unlocked.

## Errors keep their classes

This layer's own refusals are `PublicationError` with its source code
(`PUBLICATION_ID`, `PUBLICATION_PATH`, `PUBLICATION_REQUEST`,
`PUBLICATION_INCOMPLETE`, `PUBLICATION_INTEGRITY`, `PUBLICATION_DUPLICATE`,
`PUBLICATION_ARTIFACT`). Raw C1 `StorageError`, C3 lifecycle errors, `PathError`,
staging `EvaluationRefusalError`, raw filesystem errors and the UI/measurement/report
contract errors propagate in their own classes — there is no universal wrapping
and no new retry API. None of these lists is exhaustive, and no error class here
means an authenticated party refused you; the public request simply also rejects
unknown hooks or runtime injection as an unknown-option refusal.

## A publication is not a safe export

A stored Report embeds its evidence bundle and inventory, a worksheet embeds a
reviewer name and narratives, and the review evidence files are private local
bytes; none of that is a privacy-safe export, and none of it carries an
independently authenticated or externally issued certificate or attestation —
records may embed operator-attested claims, but those remain claims, not
external certification, and publishing to a local store is not publishing to
anyone. A safe projection is now available separately through the
[Safe export API](EXPORTS.md): saving a local Report is not a safe export, and
the renderers never read a marker or artifact files. The separate
[Comparison API](COMPARISON.md) makes only explicitly descriptive local quality
comparisons; storing a publication in this store confers no formal comparison. This guide carries no real private paths,
endpoints, reference UI material or numerical reference score; see [Reporting](REPORTING.md)
for what a Report records and [Measurements](MEASUREMENTS.md) for what its
measurement rows do and do not establish.
