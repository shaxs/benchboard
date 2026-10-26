/**
 * Type declarations for `packages/core/identity.mjs` (C1 / T1).
 *
 * These declarations describe the public runtime surface exactly as
 * implemented. They are checked with the repository's pinned TypeScript
 * compiler in the focused contract test (no install, no project-wide
 * typecheck, no emitted output).
 */

/** Immutable array alias used by the declarations below. */
export type ReadonlyList<T> = readonly T[];

/** Raw byte input accepted by `sha256`. */
export type HashInput =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | ReadonlyList<number>;

/**
 * A single path/digest pair used for hashing.
 *
 * `bytes` is optional metadata: it is never part of the hash pair, which is
 * exactly `[path, sha256]` as in the preserved tree algorithm.
 */
export interface IdentityHashInputEntry {
  /**
   * Exact relative POSIX file path, e.g. `src/App.tsx`. The exact path
   * constraints are those of the preserved algorithm: relative, POSIX
   * separators, no backslash, no colon, no C0/DEL control byte, no traversal,
   * no dot/empty/redundant segment, no path rewrite.
   */
  readonly path: string;
  /** Optional size metadata; excluded from the digest. */
  readonly bytes?: number;
  /** 64 lowercase hex characters. */
  readonly sha256: string;
}

/** Bare pair form accepted by `hashEntries`. */
export type IdentityHashEntryPair = readonly [path: string, sha256: string];

/** One inventoried regular file. */
export interface InventoryEntry {
  /** Exact relative POSIX file path, sorted lexically in the result. */
  readonly path: string;
  /** Byte size of the file, informational only. */
  readonly bytes: number;
  /** SHA-256 of the raw bytes, lowercase hex. */
  readonly sha256: string;
}

/** Options for `inventoryTree`. */
export interface InventoryTreeOptions {
  /** Explicit absolute root directory to inventory. Required. */
  readonly root: string;
  /**
   * Single path segment names that are never entered.
   * Defaults to `['node_modules', 'dist', '.git']`.
   */
  readonly skipNames?: Set<string> | ReadonlyList<string>;
}

/** Result of `inventoryTree`; deep-frozen. */
export interface InventoryTreeResult {
  /** The resolved root in POSIX display form. */
  readonly root: string;
  /** Identifier of the hash algorithm that produced `digest`. */
  readonly hashAlgorithmId: string;
  /** Regular files under the root, sorted by `path`. */
  readonly entries: ReadonlyList<InventoryEntry>;
  /** `hashEntries(entries)` — the compatibility tree digest. */
  readonly digest: string;
}

/** Options for `createId`. */
export interface createIdOptions {
  /**
   * Optional bounded prefix: `[A-Za-z][A-Za-z0-9._-]*`, at most 40 characters.
   */
  readonly prefix?: string;
}

/**
 * SHA-256 of raw bytes, lowercase hex. No encoding or line-ending
 * normalisation is applied.
 */
export function sha256(bytes: HashInput): string;

/**
 * Digest entries as `[path, sha256]` pairs sorted lexically by path.
 * Throws on a non-array argument, a malformed path (including any backslash,
 * colon or ASCII control-byte spelling), a non-hex digest or a
 * duplicate/conflicting path.
 */
export function hashEntries(entries: ReadonlyList<IdentityHashInputEntry | IdentityHashEntryPair>): string;

/**
 * Inventory every regular file below an explicit absolute root and produce the
 * compatibility tree digest. Links (including link ancestors), special files
 * and case-insensitive collisions are rejected.
 */
export function inventoryTree(options: InventoryTreeOptions): InventoryTreeResult;

/** Create a unique random identifier; never derived from a path or folder name. */
export function createId(options?: createIdOptions | string): string;

/** Stable identifier of the reproduced hash algorithm. */
export const HASH_ALGORITHM_ID: string;

/** Directory names skipped when `skipNames` is omitted. */
export const DEFAULT_SKIP_NAMES: ReadonlyList<string>;
