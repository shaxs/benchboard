/**
 * Type declarations for the internal runtime module
 * `packages/results/publication-runtime.mjs` (C5 S4): the publication core the
 * Captain owns, exported for the Captain's own fault-injection acceptance and
 * key derivation. It exposes four exports. `saveReportWithStorageHooks` is the
 * only place the test/observation `StorageHooks` seam reaches publication, and
 * it is an internal import: the public module
 * `packages/results/publication.mjs` calls it with `undefined` and offers no
 * hook, callback or runtime-injection option of its own, so a production caller
 * importing the public surface cannot reach this seam. No DSH dependency; the
 * dependency set is not standard-library-only (report/UI validation reaches the
 * project's existing Ajv dependency).
 */
import type { StorageHooks, StorageReadKey } from '../core/storage.mjs';
import type { Report } from './report.mjs';
import type { SaveReportRequest, ReadPublishedReportRequest, AttachUIReviewRequest } from './publication.mjs';

/**
 * One location/identity key of a publication pair. `relativePath` is the
 * POSIX store-relative path derived from the report id's digest, `kind` the
 * storage identity family (`benchboard.result.report.v1` for the report record,
 * `benchboard.result.report-commit.v1` for the commit marker) and `id` the report id.
 */
export interface PublicationKeys {
  /** The report record's storage key. */
  readonly report: StorageReadKey;
  /** The commit marker's storage key. */
  readonly commit: StorageReadKey;
}

/**
 * Derives the two deterministic storage keys (report record and commit marker)
 * for an explicit report id. A missing or malformed id is `PublicationError`
 * code `PUBLICATION_ID` ("Explicit valid report ID required"). Performs no IO.
 */
export declare function publicationKeysOf(reportId: string): PublicationKeys;

/**
 * The publication core behind the public `saveReport`. Same request contract
 * and same immutability, root, frozen-run and artifact checks as the public
 * function, plus one internal-only parameter: `hooks` is the test/observation
 * `StorageHooks` seam of the C1 storage layer (each hook may throw to inject a
 * transaction failure; the caller must await; `undefined` means production).
 * Passing hooks here is a fault-injection capability for Captain acceptance
 * only; the public API never exposes it, and a request carrying a `hooks` field
 * instead of a second argument is still an unknown-option refusal
 * (`PublicationError` `PUBLICATION_REQUEST`). Errors keep their classes:
 * `PublicationError`, `StorageError` (including `ERR_STORAGE_HOOK_ABORT` from an
 * injected hook), `PathError`, the staging `EvaluationRefusalError` and upstream
 * report/C3 classes; not an exhaustive list.
 */
export declare function saveReportWithStorageHooks(request: SaveReportRequest, hooks: StorageHooks | undefined): Promise<Report>;

/**
 * The read core behind the public `readPublishedReport`: marker presence,
 * stored-record validation, id agreement and marker/report agreement, with the
 * same error classes and the same limit that this verifies stored records, not
 * filesystem artifacts or the frozen source.
 */
export declare function readPublishedReportInternal(request: ReadPublishedReportRequest): Promise<Report>;

/**
 * The attachment core behind the public `attachUIReview`: committed-parent read,
 * Captain worksheet validation, frozen-run and evidence re-verification, physical
 * review-file verification under the review bounds, the unchanged scorer, and
 * immutable child-plus-marker publication. Same request contract and same error
 * classes as the public function; validation is local self-assessment, never
 * reviewer authentication.
 */
export declare function attachUIReviewInternal(request: AttachUIReviewRequest): Promise<Report>;
