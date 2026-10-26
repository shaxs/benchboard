/**
 * Type declarations for the cooperative file/root boundary
 * `packages/results/artifact-verification.mjs` (C5 S4). These checks are
 * cooperative containment and integrity checks against caller-named roots: roots
 * must be ordinary, link-free directories with an unchanging ancestor chain, and
 * each artifact must be an ordinary, unlinked file of the recorded identity and
 * size, re-checked before and after a descriptor read so an observed concurrent
 * mutation is a refusal, not a silent adoption. They are explicitly NOT an
 * operating-system sandbox and make no hostile-writer or power-loss durability
 * guarantee: a writer that races the final observation can still change bytes
 * after the last check, and the checks only refuse what they can observe. No DSH
 * dependency; the surrounding publication graph is not standard-library-only
 * (report/UI validation reaches the project's existing Ajv dependency).
 */

/**
 * This layer's own refusal. Carries the stable machine code from the source
 * (`PUBLICATION_ID`, `PUBLICATION_PATH`, `PUBLICATION_REQUEST`,
 * `PUBLICATION_INCOMPLETE`, `PUBLICATION_INTEGRITY`, `PUBLICATION_DUPLICATE`,
 * `PUBLICATION_ARTIFACT`). Upstream errors from storage, paths, staging,
 * freeze, report, UI or measurement layers keep their own classes; this class is
 * not a universal wrapper and no general wrapping or retry API is promised.
 */
export declare class PublicationError extends Error {
  readonly name: 'PublicationError';
  /** Stable refusal code naming the check that refused. */
  readonly code: string;
  constructor(code: string, message: string);
}

/** Throws a `PublicationError` with the given code and message; never returns. */
export declare function publicationRefusal(code: string, message: string): never;

/**
 * Validates a caller-supplied list of publication roots: each must be an
 * explicit, canonical absolute, non-volume, control-character-free ordinary
 * directory with a link-free ancestor chain (checked through the staging chain
 * check), and the roots plus the repository root must be pairwise disjoint both
 * lexically and after real-path resolution. Refusals: `PublicationError`
 * `PUBLICATION_PATH` for a malformed root, `PathError`
 * (`DUPLICATE_ROOT`/`ROOTS_OVERLAP` and friends) from disjointness, and the
 * staging `EvaluationRefusalError` (`UNSAFE_PATH`) or raw filesystem errors from
 * the chain checks. This is a cooperative boundary check, not a sandbox.
 */
export declare function assertReportRoots(roots: readonly string[]): void;

/** Bounds for one `verifyReportArtifacts` call; both default to the evaluation-evidence bounds. */
export interface VerifyReportArtifactsOptions {
  /** Maximum bytes of one artifact (default 134217728, i.e. 128 MiB). */
  readonly maxFileBytes?: number;
  /** Maximum total bytes of the inventory (default 536870912, i.e. 512 MiB). */
  readonly maxTotalBytes?: number;
}

/** One recorded artifact reference: its root-relative path, byte count and lowercase 64-hex SHA-256. */
export interface ArtifactRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Verifies a bounded inventory (at most 512 entries) of recorded artifacts under
 * one root: every entry is resolved strictly inside the root through the path
 * boundary, must be an ordinary file with exactly one link whose size matches the
 * record, is then opened with `O_NOFOLLOW` where the platform provides it (the
 * flag is dropped to none where it is unavailable, leaving the descriptor/name/
 * ancestor re-checks as the protection), and its identity, content, digest and
 * ancestor ownership are re-checked before and after the read so an observed
 * mutation, link, substitution, duplicate path, out-of-bound total or missing file
 * is a refusal. A mutation that no observation catches cannot be refused; this is
 * cooperative, with no hostile-writer guarantee. Refusals here are `PublicationError`
 * `PUBLICATION_ARTIFACT` and `PathError` from the shared resolver for
 * path-boundary violations; in addition a missing file or chain problem can
 * surface as a raw filesystem error or a staging error of the chain check. The
 * list is not exhaustive and no universal wrapping is claimed.
 * The default bounds cover evaluation evidence (128 MiB per file, 512 MiB total);
 * review evidence uses the tighter 16 MiB / 192 MiB bounds passed explicitly.
 * Cooperative verification against observed races — not an OS sandbox, not
 * durability across power loss, and byte agreement is not authorship.
 */
export declare function verifyReportArtifacts(
  root: string,
  records: readonly ArtifactRecord[],
  options?: VerifyReportArtifactsOptions,
): void;
