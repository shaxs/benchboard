/**
 * Type declarations for `packages/core/challenge-export.mjs` (C2 / T1 as
 * repaired by T5).
 *
 * These declarations describe the public runtime surface exactly as
 * implemented and are checked with the repository's pinned TypeScript compiler
 * in the focused initialization test (no install, no project-wide typecheck, no
 * emitted output).
 */

import type { ChallengeIdentity } from './manifest.mjs';

/** Immutable array alias used by the declarations below. */
export type ReadonlyList<T> = readonly T[];

/** Machine-readable rejection reasons emitted by `ChallengeExportError.code`. */
export interface ExportErrorCodes {
  /** The options object or one of its members was missing, extra or malformed. */
  readonly INVALID_ARGUMENT: 'INVALID_ARGUMENT';
  /** A root was rejected by the disjointness contract. */
  readonly INVALID_ROOT: 'INVALID_ROOT';
  /** The output equals a protected root, as the accepted comparator spells it. */
  readonly DUPLICATE_ROOT: 'DUPLICATE_ROOT';
  /** The output contains or sits inside a protected root. */
  readonly ROOTS_OVERLAP: 'ROOTS_OVERLAP';
  /** The source root, or a component of it, does not exist. */
  readonly SOURCE_NOT_FOUND: 'SOURCE_NOT_FOUND';
  /** The source root or an entry inside it is a link, special or otherwise unsafe. */
  readonly SOURCE_UNSAFE: 'SOURCE_UNSAFE';
  /** The physical source workload does not equal the declared workload. */
  readonly WORKLOAD_MISMATCH: 'WORKLOAD_MISMATCH';
  /** The source changed between the pre-copy and post-copy verification rounds. */
  readonly WORKLOAD_CHANGED: 'WORKLOAD_CHANGED';
  /** The destination already exists; an existing destination is never overwritten. */
  readonly DESTINATION_EXISTS: 'DESTINATION_EXISTS';
  /** The directory that must contain the destination is missing or unusable. */
  readonly DESTINATION_PARENT_MISSING: 'DESTINATION_PARENT_MISSING';
  /** The destination parent is a link or sits beneath one. */
  readonly DESTINATION_UNSAFE: 'DESTINATION_UNSAFE';
  /** The operation-owned staging container could not be created or filled. */
  readonly STAGING_FAILED: 'STAGING_FAILED';
  /** The published container could not be reserved, filled or re-verified. */
  readonly PUBLICATION_FAILED: 'PUBLICATION_FAILED';
  /** Material this call created could not be removed. */
  readonly CLEANUP_FAILED: 'CLEANUP_FAILED';
  /** An unexpected failure was normalised instead of being reported raw. */
  readonly INTERNAL: 'INTERNAL';
}

/** The frozen, stable set of rejection codes. */
export const EXPORT_ERROR_CODES: ExportErrorCodes;

/**
 * Exact number of workload files a public workspace must contain. A manifest
 * naming any other count is refused as a different contract.
 */
export const EXPECTED_WORKLOAD_FILE_COUNT: 26;

/** Prefix of the privately created, operation-owned staging directory. */
export const STAGING_PREFIX: '.benchboard-export-';

/** Mode requested for every published file: owner-writable, others read-only. */
export const EXPORTED_FILE_MODE: 0o644;

/**
 * The identity a package carries is the C1 `ChallengeIdentity` contract itself.
 *
 * The full shape is owned by `packages/core/manifest.mjs`, which validates the
 * record before any member here is consulted. Consuming the C1 type rather
 * than restating the members this module happens to read keeps one identity
 * schema in the codebase: a package that will not validate as a C1 identity is
 * not expressible here, and a future required identity member cannot be
 * silently omitted from this declaration.
 */

/** One challenge package: an identity, its physical source and its boundary. */
export interface ChallengePackage {
  /** Validated C1 identity for the challenge being exported. */
  readonly identity: ChallengeIdentity;
  /** Explicit absolute source root; never defaulted or discovered. */
  readonly sourceRoot: string;
  /** Exact relative POSIX paths of the workload files, no duplicates. */
  readonly fileManifest: ReadonlyList<string>;
  /**
   * Protected owner roots the destination must not touch. Required; an empty
   * list states that there are none, while an omitted or null list is a malformed
   * package rather than a default.
   */
  readonly ownerRoots: ReadonlyList<string>;
  /**
   * Protected evaluator roots the destination must not touch. Required under the
   * same rule as `ownerRoots`. Protected roots may nest, overlap or repeat: they
   * are compared with the destination, never with each other.
   */
  readonly evaluatorRoots: ReadonlyList<string>;
}

/** Options for `exportChallenge`. */
export interface ExportChallengeOptions {
  /** The challenge package to export. */
  readonly challenge: ChallengePackage;
  /** Explicit absolute destination root that must not exist yet. */
  readonly output: string;
}

/** One published workload file, verified by reading the published bytes back. */
export interface ExportedFileEntry {
  /** Exact relative POSIX path as listed in `fileManifest`. */
  readonly path: string;
  /** Byte length of the published file. */
  readonly bytes: number;
  /** SHA-256 of the published bytes. */
  readonly sha256: string;
}

/** Successful export result. */
export interface ExportResult {
  /** The destination root, now a complete byte-exact public workspace. */
  readonly workspaceRoot: string;
  /** The workload digest recomputed from the published bytes. */
  readonly workloadDigest: string;
  /** One entry per published file, in `fileManifest` order. */
  readonly inventory: ReadonlyList<ExportedFileEntry>;
}

/** Error carrying one stable machine-readable `code` from `EXPORT_ERROR_CODES`. */
export class ChallengeExportError extends Error {
  readonly name: 'ChallengeExportError';
  /** One of the `EXPORT_ERROR_CODES` values. */
  readonly code: ExportErrorCodes[keyof ExportErrorCodes];
  /** Path the rejection is about, when the rejection has one. */
  readonly path?: string;
  /** Underlying error that caused this rejection. */
  readonly cause?: unknown;
  /**
   * Present when a failed transaction could not also remove the material it
   * created. The original rejection stays the thrown error; this records the
   * residue instead of replacing the cause.
   */
  readonly cleanup?: ChallengeExportError;
  constructor(
    code: ExportErrorCodes[keyof ExportErrorCodes],
    message: string,
    details?: { readonly cause?: unknown; readonly path?: string },
  );
}

/**
 * Export one challenge package into a complete, byte-exact public workspace.
 *
 * Bytes and inventory are verified before the copy; every write is derived from
 * bytes whose digest was proved against the identity at the moment of the write;
 * the source is verified again after the staged copy and after publication; publication reserves the
 * destination exclusively, so an existing destination is refused rather than
 * overwritten. Success is returned only after the published container has been
 * re-walked with no name skipped and re-read against the identity digest.
 *
 * After a failed transaction only entries this call created and can still
 * identify are removed, one by one and never recursively. Material that is not
 * provably this call's is kept and disclosed on `cleanup` as `CLEANUP_FAILED`.
 * Directory visibility is cooperative rather than atomic and no lock is taken, so
 * residue can be reported instead of removed when a concurrent writer is present.
 *
 * @returns the published workspace root, its recomputed workload digest and the
 * verified per-file inventory
 * @throws {ChallengeExportError} see `EXPORT_ERROR_CODES`
 */
export function exportChallenge(options: ExportChallengeOptions): Promise<ExportResult>;
