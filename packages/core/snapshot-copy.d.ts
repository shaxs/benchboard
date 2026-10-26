/**
 * Type declarations for `packages/core/snapshot-copy.mjs` (C3 / T2).
 *
 * These declarations describe the public runtime surface exactly as
 * implemented. They are checked with the repository's pinned TypeScript
 * compiler (no install, no project-wide typecheck, no emitted output).
 */

/** Immutable array alias used by the declarations below. */
export type ReadonlyList<T> = readonly T[];

/** Identifier of the frozen selection policy implemented by this module. */
export const SELECTION_POLICY_ID: 'benchboard-application-snapshot-v1';

/** Exact top-level basenames excluded by the frozen selection policy. */
export const SELECTION_POLICY_EXCLUSIONS: ReadonlyList<string>;

/** Identifier of the inventory digest algorithm (legacy `[path, sha256]` pairs). */
export const SNAPSHOT_HASH_ALGORITHM_ID: 'benchboard-sha256-tree-v1';

/** Machine-readable rejection reasons emitted by this module. */
export interface SnapshotErrorCodes {
  readonly INVALID_ARGUMENT: 'INVALID_ARGUMENT';
  readonly INVALID_ROOT: 'INVALID_ROOT';
  readonly ROOTS_NOT_DISJOINT: 'ROOTS_NOT_DISJOINT';
  readonly DESTINATION_EXISTS: 'DESTINATION_EXISTS';
  readonly DESTINATION_CONCURRENT_CLAIM: 'DESTINATION_CONCURRENT_CLAIM';
  readonly SOURCE_NOT_FOUND: 'SOURCE_NOT_FOUND';
  readonly SOURCE_NOT_A_DIRECTORY: 'SOURCE_NOT_A_DIRECTORY';
  readonly LINK_DETECTED: 'LINK_DETECTED';
  readonly LINK_ANCESTOR: 'LINK_ANCESTOR';
  readonly SPECIAL_FILE: 'SPECIAL_FILE';
  readonly CASE_COLLISION: 'CASE_COLLISION';
  readonly INVALID_NAME: 'INVALID_NAME';
  readonly SOURCE_MUTATED: 'SOURCE_MUTATED';
  readonly SNAPSHOT_VERIFICATION_FAILED: 'SNAPSHOT_VERIFICATION_FAILED';
  readonly OWNERSHIP_LOST: 'OWNERSHIP_LOST';
  readonly SNAPSHOT_MUTATED: 'SNAPSHOT_MUTATED';
  readonly HOOK_FAILED: 'HOOK_FAILED';
  readonly INTERNAL: 'INTERNAL';
}

export const SNAPSHOT_ERROR_CODES: SnapshotErrorCodes;

/** One selected regular file: exact relative POSIX path, byte size, content hash. */
export interface SnapshotInventoryEntry {
  /** Exact relative POSIX file path; the inventory is sorted by raw lexical order. */
  readonly path: string;
  /** Byte size of the file. */
  readonly bytes: number;
  /** SHA-256 of the raw bytes, 64 lowercase hex characters. */
  readonly sha256: string;
}

/** A protected absolute root: plain path string or labelled object. */
export type ProtectedRoot = string | { readonly label?: string; readonly path: string };

/** Cooperative observation/fault seam: zero arguments, awaited in order. */
export type SnapshotHook = () => void | Promise<void>;

/** Options for `copySnapshot`. */
export interface CopySnapshotRequest {
  /** Explicit absolute source workspace root. Required. */
  readonly workspaceRoot: string;
  /** Explicit absolute, exclusively-new snapshot destination root. Required. */
  readonly outputRoot: string;
  /** Explicit absolute protected roots; may nest each other; may be empty. */
  readonly protectedRoots: ReadonlyList<ProtectedRoot>;
  /** Optional cooperative hooks, awaited one after the other before the final revalidation. */
  readonly hooks?: ReadonlyList<SnapshotHook>;
}

/** One reported cleanup/fate entry. */
export interface SnapshotFateEntry {
  /** Relative POSIX path below the snapshot root (`'.'` is the snapshot root itself). */
  readonly path: string;
  /** Machine-readable reason for the reported fate. */
  readonly reason: string;
}

/** Honest partial-fate report attached to a failure after the claim. */
export interface SnapshotFailureFate {
  /** Lifecycle phase reached before the failure. */
  readonly phase: 'claimed' | 'copied' | 'aborted-cleaned' | 'published';
  /** Whether the ownership-aware cleanup pass ran. */
  readonly cleanupPerformed: boolean;
  /** Files unlinked because this operation still proved it created them. */
  readonly removedFiles: ReadonlyList<string>;
  /** Directories removed because they were provably empty and still owned. */
  readonly removedDirectories: ReadonlyList<string>;
  /** Paths whose actual residual state is reported rather than hidden. */
  readonly residualPaths: ReadonlyList<SnapshotFateEntry>;
  /** Foreign (replacement or insertion) entries preserved, never adopted. */
  readonly foreignPreserved: ReadonlyList<SnapshotFateEntry>;
  /** Cleanup operations that themselves failed, reported honestly. */
  readonly cleanupErrors: ReadonlyList<SnapshotFateEntry>;
}

/** Result of a successful `copySnapshot`; deep-frozen. */
export interface CopySnapshotResult {
  readonly ok: true;
  readonly selectionPolicyId: string;
  readonly hashAlgorithmId: string;
  /** Source root in POSIX display form. */
  readonly workspaceRoot: string;
  /** Destination root in POSIX display form. */
  readonly outputRoot: string;
  /** Selected inventory, sorted by `path`. */
  readonly inventory: ReadonlyList<SnapshotInventoryEntry>;
  /** Legacy `[path, sha256]` pair digest of the inventory. */
  readonly digest: string;
  /** Number of selected files. */
  readonly fileCount: number;
  /** Sum of selected byte sizes. */
  readonly totalBytes: number;
  /** Fate of the successful run (phase `published`); no cleanup performed. */
  readonly fate: SnapshotFailureFate;
}

/** Error raised by this module; carries `code` and, post-claim, `fate`. */
export class SnapshotError extends Error {
  readonly name: 'SnapshotError';
  readonly code: string;
  readonly fate?: SnapshotFailureFate;
}

/**
 * Copy the selected application view of `workspaceRoot` into the exclusively-new
 * `outputRoot`, verify byte equality and source stability, and roll back
 * ownership-aware on any gate failure. See the runtime module for the full
 * contract and the cooperative-boundary disclosures.
 *
 * C3 T6 strengthening: the exclusive claim binds the identity of the claimed
 * root AND of every host ancestor up to the volume root. Before the copy
 * traversal, at the post-copy gate and at the final-hook gate, that whole chain
 * is re-proven top-down (a replaced or newly linked parent is never read
 * through to prove it). A hook that renames the claimed root aside and
 * recreates the path — even moving the original files back so every inode and
 * every byte still matches — is detected as `OWNERSHIP_LOST`, and a root
 * replacement of an EMPTY selection is detected the same way. Cleanup deletes
 * nothing while the chain cannot be proven, and the residual enumeration does
 * not run through an unproven parent.
 */
export function copySnapshot(request: CopySnapshotRequest): Promise<CopySnapshotResult>;

/** Options for `verifySnapshot`. */
export interface VerifySnapshotRequest {
  /** Explicit absolute snapshot root to verify. */
  readonly snapshotRoot: string;
  /** Expected inventory entries (path/bytes/sha256). */
  readonly expectedInventory: ReadonlyList<SnapshotInventoryEntry>;
  /** Expected legacy pair digest of the expected inventory. */
  readonly expectedDigest: string;
  /** Must be `SELECTION_POLICY_ID`; any other value is rejected. */
  readonly selectionPolicyId: string;
}

/** Result of `verifySnapshot`; deep-frozen. */
export interface VerifySnapshotResult {
  readonly ok: boolean;
  /**
   * Every detected defect (missing/changed/link/special/extra file/extra or
   * missing directory/malformed). T6: the physical directory set must match the
   * set implied by the expected file paths exactly, so an unexpected EMPTY
   * directory is reported just like an unexpected file.
   */
  readonly failures: ReadonlyList<string>;
}

/**
 * Verify a snapshot root against an expected inventory and digest. Data-level
 * problems are reported through `failures`; only malformed arguments throw.
 * The check is set-exact over files AND over the directories implied by the
 * expected file paths: extra entries of either kind, and a missing implied
 * directory, are defects.
 */
export function verifySnapshot(request: VerifySnapshotRequest): Promise<VerifySnapshotResult>;
