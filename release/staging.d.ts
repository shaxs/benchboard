/** Declarations for the staging function at release/staging.mjs. Handles and errors
 *  are private local evidence, not sanitized public exports. */

import type { ProfileEntry } from './profiles.mjs';

/** Thrown when staging, verification or cleanup refuses. `code` is a stable string
 *  such as `RELEASE_STAGE_ROOT`, `RELEASE_STAGE_OVERLAP`, `RELEASE_STAGE_EXISTS`,
 *  `RELEASE_STAGE_PROFILE_BLOCKED`, `RELEASE_STAGE_GENERATOR_UNAVAILABLE`,
 *  `RELEASE_STAGE_INTEGRITY`, `RELEASE_STAGE_FAILED` or `RELEASE_STAGE_RETAINED`.
 *  Retained failures carry the original cause and a `retained` flag; the constructor
 *  is precise, not a replacement for ordinary errors. */
export declare class ReleaseStageError extends Error {
  readonly name: 'ReleaseStageError';
  readonly code: string;
  readonly retained: boolean;
  /** Present only when failed staging also failed its guarded cleanup. Private diagnostic. */
  readonly cleanupError?: ReleaseStageError;
  constructor(code: string, cause?: unknown, retained?: boolean);
}

/** Options object accepted by `stageRelease`. Both roots are explicit absolute local
 *  paths, not filesystem roots, UNC or extended-namespace forms; `profile` is the
 *  unknown-typed input passed to the profile validator unmodified. No default
 *  source/output root, callback, hook or renderer option exists. */
export interface StageReleaseOptions {
  readonly sourceRoot: string;
  readonly destination: string;
  readonly profile: unknown;
}

/** Deeply immutable result of a successful synthetic staging: the fresh private
 *  output tree plus a cleanup closure that captures the operation's own receipts.
 *  There are no nullable fields; a failed operation instead reports `retained`. */
export interface StagedRelease {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'StagedRelease';
  readonly profile: 'synthetic';
  /** Absolute path of the created private destination directory. */
  readonly directory: string;
  /** The accepted synthetic profile's entries, as returned by the validator. */
  readonly entries: readonly ProfileEntry[];
  /** Removes the staged tree. Takes no receipt, option or path from the caller and
     is idempotent after one successful run. */
  readonly cleanup: () => void;
}

/** Stages a synthetic release profile into a fresh, exclusive output tree. Runs
 *  synchronously. Only the synthetic profile is accepted; the participant profile
 *  reaches staging and is refused there (`RELEASE_STAGE_PROFILE_BLOCKED`), while
 *  `owner-development` and `end-user-tooling` are refused earlier by the profile
 *  validator, which throws `ReleaseProfileError` with `RELEASE_PROFILE_BLOCKED`
 *  and propagates. The named generator `synthetic-metadata-v1` is the only one
 *  rendered, to
 *  `release-metadata.json` with fixed bytes; every other recognized generator name
 *  is refused as unavailable (`RELEASE_STAGE_GENERATOR_UNAVAILABLE`). The profile's
 *  declared size and digest must match the rendered bytes exactly. Preflight reads
 *  and hashes every selected source before the target is created; ancestry, source
 *  identity and byte equality are rechecked during and after copying, and each
 *  output file's size, digest and containing-directory inventory are verified
 *  before the handle is returned. Excluded checkout and ignored files are never
 *  enumerated or copied, and source content is not modified. A mid-operation
 *  failure attempts a guarded cleanup and may report `retained`; cleanup itself
 *  verifies the output inventory and originals before removing only the owned tree,
 *  refusing foreign changes and retaining uncertain residue. No network access,
 *  install, archive or publication occurs, and callers receive no verification
 *  customization. */
export declare function stageRelease(options: StageReleaseOptions): StagedRelease;
