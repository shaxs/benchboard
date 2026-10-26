/**
 * Type declarations for `packages/core/paths.mjs` (C1 / T1).
 *
 * These declarations describe the public runtime surface exactly as
 * implemented and are checked with the repository's pinned TypeScript compiler
 * in the focused contract test (no install, no project-wide typecheck, no
 * emitted output).
 */

/** Immutable array alias used by the declarations below. */
export type ReadonlyList<T> = readonly T[];

/** Machine-readable rejection reasons emitted by `PathError.code`. */
export interface PathErrorCodes {
  /** The options object itself was missing or malformed. */
  readonly INVALID_ARGUMENT: 'INVALID_ARGUMENT';
  /** The root was missing, relative, UNC/extended-length or otherwise unusable. */
  readonly INVALID_ROOT: 'INVALID_ROOT';
  /** The root does not exist. */
  readonly ROOT_NOT_FOUND: 'ROOT_NOT_FOUND';
  /** The root exists but is not a directory. */
  readonly ROOT_NOT_A_DIRECTORY: 'ROOT_NOT_A_DIRECTORY';
  /** A drive/root volume was supplied instead of a subdirectory. */
  readonly ROOT_IS_FILESYSTEM_ROOT: 'ROOT_IS_FILESYSTEM_ROOT';
  /** The relative path is empty, absolute, traversing, backslashed or redundant. */
  readonly INVALID_RELATIVE_PATH: 'INVALID_RELATIVE_PATH';
  /** The relative path resolves outside the root. */
  readonly OUT_OF_ROOT: 'OUT_OF_ROOT';
  /** A link exists above the root. */
  readonly LINK_ANCESTOR: 'LINK_ANCESTOR';
  /** The root, a directory component or the target is a symbolic link. */
  readonly SYMLINK_DETECTED: 'SYMLINK_DETECTED';
  /** The resolved real path escapes the real root. */
  readonly REAL_PATH_OUT_OF_ROOT: 'REAL_PATH_OUT_OF_ROOT';
  /** A required component does not exist. */
  readonly NOT_FOUND: 'NOT_FOUND';
  /** A directory component is not a directory. */
  readonly NOT_A_DIRECTORY: 'NOT_A_DIRECTORY';
  /** The target is a special file (fifo, socket, device). */
  readonly NOT_REGULAR_FILE: 'NOT_REGULAR_FILE';
  /** The requested spelling differs from the on-disk spelling by case/folding. */
  readonly CASE_COLLISION: 'CASE_COLLISION';
  /** Two entries name the same directory. */
  readonly DUPLICATE_ROOT: 'DUPLICATE_ROOT';
  /** One root contains another. */
  readonly ROOTS_OVERLAP: 'ROOTS_OVERLAP';
}

/** The frozen, stable set of rejection codes. */
export const PATH_ERROR_CODES: PathErrorCodes;

/** Error carrying one stable machine-readable `code` from `PATH_ERROR_CODES`. */
export class PathError extends Error {
  readonly name: 'PathError';
  /** One of the `PATH_ERROR_CODES` values. */
  readonly code: PathErrorCodes[keyof PathErrorCodes];
  constructor(code: PathErrorCodes[keyof PathErrorCodes], message: string);
}

/** Options for `resolveWithinRoot`. */
export interface ResolveWithinRootOptions {
  /** Explicit absolute root directory; never defaulted. */
  readonly root: string;
  /** Exact relative POSIX path validated by `validateRelativePath`. */
  readonly relativePath: string;
}

/** One root entry accepted by `assertDisjointRoots`. */
export interface RootEntry {
  /** Human label used in the rejection message, e.g. `output`. */
  readonly label?: string;
  /** Explicit absolute root path. */
  readonly path: string;
}

/**
 * Validate an exact relative POSIX path and return it byte-for-byte unchanged.
 *
 * @throws {PathError} code `INVALID_RELATIVE_PATH`
 */
export function validateRelativePath(relativePath: string): string;

/**
 * Resolve `relativePath` inside an explicit absolute `root` and prove containment.
 *
 * @returns absolute in-root path using host separators and the requested spelling
 * @throws {PathError} see `PATH_ERROR_CODES`
 */
export function resolveWithinRoot(options: ResolveWithinRootOptions): string;

/**
 * Assert that roots are pairwise disjoint (no duplicates, no containment).
 *
 * @returns one display path per input entry, in input order
 * @throws {PathError} codes `INVALID_ROOT`, `DUPLICATE_ROOT`, `ROOTS_OVERLAP`
 */
export function assertDisjointRoots(roots: ReadonlyList<string | RootEntry>): ReadonlyList<string>;
