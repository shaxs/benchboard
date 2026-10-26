/**
 * Type declarations for the public production-only publication surface
 * `packages/results/publication.mjs` (C5 S4). It exports exactly three async
 * functions, each returning `Promise<Report>`, plus their three closed request
 * interfaces. There are no options objects, no storage hooks, no callbacks, no
 * runtime injection and no lock-stealing or expiry parameters: a request
 * carrying any field beyond the closed interface (including `hooks`) is a
 * runtime refusal with `PublicationError` code `PUBLICATION_REQUEST` ("unknown
 * options refused"), and because the interfaces below name every accepted
 * field, TypeScript's excess-property check rejects the same shape at compile
 * time. Publication commits a validated Report into a caller-owned store as an
 * immutable record with a deterministic commit marker. This is local
 * self-assessment bookkeeping over caller-named roots: it authenticates no
 * reviewer, certifies nothing over a network and is not a privacy-safe export.
 * No DSH dependency; the dependency set is not standard-library-only (report/UI
 * validation reaches the project's existing Ajv dependency).
 */
import type { Report } from './report.mjs';
import type { UIWorksheet } from './ui-contract.mjs';

/**
 * Closed baseline-save request: exactly these four fields and no others. Every
 * root is an explicit string the caller already holds; nothing is inferred from
 * the current working directory. The call creates no input root or run for the
 * caller, though it does write the intended store records and their metadata.
 */
export interface SaveReportRequest {
  /**
   * Existing, ordinary (non-link, non-junction), canonical absolute publication
   * store root. Must be pairwise physically and lexically disjoint from the
   * run root, the evaluation root and the repository root; overlaps and
   * duplicates are refused.
   */
  readonly storeRoot: string;
  /**
   * Existing, ordinary, canonical absolute run root holding the sealed run and
   * its frozen submission the report is bound to. Re-verified from bytes before
   * the report and marker are published; never created or reset here.
   */
  readonly runRoot: string;
  /**
   * Existing, ordinary, canonical absolute evaluation output root holding the
   * report's evidence artifacts, each resolved by its bundle-relative path and
   * verified against its recorded bytes and SHA-256 before the report is
   * published and re-checked after the commit marker is written.
   */
  readonly evaluationRoot: string;
  /**
   * The complete baseline Report to publish. Its `execution.humanReview` must
   * be `'NOT_REVIEWED'`; a reviewed report is refused (`PUBLICATION_REQUEST`)
   * because reviewed children arrive through `attachUIReview` with physical
   * review evidence. The value is validated and JSON-copied; the caller's object
   * is never stored by reference or mutated.
   */
  readonly report: Report;
}

/** Closed read request: exactly these two fields and no others. */
export interface ReadPublishedReportRequest {
  /** The same explicit store root contract as in `SaveReportRequest['storeRoot']`. */
  readonly storeRoot: string;
  /**
   * The explicit report id to read. The stored record's own `reportId` and the
   * deterministic commit marker are both required to agree with it; a later read
   * verifies the stored Report and its marker, not the filesystem artifacts or
   * the frozen source again.
   */
  readonly reportId: string;
}

/** Closed attachment request: exactly these eight fields and no others. */
export interface AttachUIReviewRequest {
  /** The same explicit store root contract as in `SaveReportRequest['storeRoot']`. */
  readonly storeRoot: string;
  /** The same explicit run root contract as in `SaveReportRequest['runRoot']` (re-verified for the parent). */
  readonly runRoot: string;
  /** The same explicit evaluation root contract as in `SaveReportRequest['evaluationRoot']` (re-verified for the parent). */
  readonly evaluationRoot: string;
  /** The committed parent report id the child names; read from the store, never passed by value. */
  readonly parentReportId: string;
  /** The new child report id. It must be distinct; a complete id already in the store is refused (`PUBLICATION_DUPLICATE`). */
  readonly reportId: string;
  /** The child's explicit canonical UTC creation timestamp, validated by the report contract. */
  readonly createdAt: string;
  /** The completed UI worksheet, validated against the committed parent by the Captain UI contract. */
  readonly worksheet: UIWorksheet;
  /**
   * Existing, ordinary, canonical absolute review evidence root. Each worksheet
   * evidence entry's file is named exactly by its `artifactId` directly under
   * this root (no added extension) and verified against its recorded bytes and
   * SHA-256 under the tighter review bounds before the child is published, again
   * immediately before the commit marker is created and again after it exists.
   */
  readonly reviewRoot: string;
}

/**
 * Publishes the closed baseline Report immutably: validates the request and the
 * report, requires `NOT_REVIEWED`, checks the roots, then under the store's
 * single lock re-verifies the frozen submission from bytes, verifies every
 * evidence artifact, publishes the report through the C1 exclusive-immutable
 * write, re-verifies the run and the artifacts immediately before the commit
 * marker is created, and re-checks only the artifacts after the marker exists,
 * then returns the committed Report (a validated copy). Upstream refusals keep
 * their own classes:
 * `PublicationError` (`PUBLICATION_REQUEST`/`PUBLICATION_PATH`/
 * `PUBLICATION_DUPLICATE`/`PUBLICATION_INTEGRITY`/`PUBLICATION_ARTIFACT`),
 * `StorageError` (for example `ERR_STORAGE_LOCK_CONFLICT`,
 * `ERR_STORAGE_DUPLICATE_IDENTITY`), `PathError`, the staging
 * `EvaluationRefusalError` (`UNSAFE_PATH`) and the report/UI/measurement and C3
 * lifecycle classes. This is not an exhaustive error list and no check
 * authenticates a person or attests anything externally.
 */
export declare function saveReport(request: SaveReportRequest): Promise<Report>;

/**
 * Reads one committed Report: requires the deterministic commit marker to exist
 * and match the validated stored record and the selected id, then returns the
 * validated copy. An interrupted publication with no marker is
 * `PublicationError` `PUBLICATION_INCOMPLETE` (identical retry or explicit
 * operator disposition), a mismatched marker or mislabelled record is
 * `PUBLICATION_INTEGRITY`, and the underlying storage, path and report-layer
 * errors propagate in their own classes. Verification is intrinsic and local: a
 * committed record is a stored fact, not authentication, and this read does not
 * re-verify filesystem artifacts or the frozen source. A read takes the same
 * C1 writer lock and may create storage/lock metadata; an active or orphaned
 * lock yields `ERR_STORAGE_LOCK_CONFLICT` and is never stolen. It never
 * rewrites the immutable Report or marker bytes.
 */
export declare function readPublishedReport(request: ReadPublishedReportRequest): Promise<Report>;

/**
 * Publishes a reviewed child Report immutably: under the store lock it reads the
 * committed parent, validates the worksheet against it through the Captain UI
 * contract, re-verifies the frozen run and the parent's evidence artifacts,
 * verifies the physical review files under the review bounds, scores through the
 * unchanged evaluator scorer, and publishes the child (new id, explicit parent id
 * and digest, original automated block and evidence retained) with its commit
 * marker: the run and evidence are re-verified again immediately before the
 * marker is created, and the evidence and review files are re-checked after the
 * marker exists. Errors keep their
 * classes: `PublicationError` (`PUBLICATION_INCOMPLETE`, `PUBLICATION_INTEGRITY`,
 * `PUBLICATION_DUPLICATE`, `PUBLICATION_PATH`, `PUBLICATION_ARTIFACT`,
 * `PUBLICATION_REQUEST`), `UIWorksheetError` (`UI_WORKSHEET_INVALID`),
 * `StorageError`, `PathError`, the staging `EvaluationRefusalError` and upstream
 * report/C3 classes; not exhaustive. The parent is never rewritten, and the
 * review binds files and digests: it does not authenticate the named reviewer,
 * does not prove the reviewed pixels are real screenshots and does not make the
 * record an export-safe document.
 */
export declare function attachUIReview(request: AttachUIReviewRequest): Promise<Report>;
