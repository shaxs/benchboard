// Declarations for packages/evaluation/packaged-identity.mjs.
// Runtime behavior is defined by that module; these types describe its public surface.

/**
 * One packaged manifest entry: a POSIX-relative path with its byte size and
 * 64-lowercase-hex SHA-256 digest.
 */
export interface PackagedEvaluatorManifestEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Result of a successful verification of the pinned packaged installation.
 * The returned record, both manifest arrays and each entry are frozen.
 */
export interface PackagedEvaluatorIdentity {
  readonly evaluatorVersion: string;
  readonly scoringVersion: string;
  readonly hashAlgorithm: 'benchboard-sha256-tree-v1';
  readonly semanticManifest: readonly PackagedEvaluatorManifestEntry[];
  readonly semanticDigest: string;
  readonly packageManifest: readonly PackagedEvaluatorManifestEntry[];
  readonly packageDigest: string;
  /** Declared/pinned historical evaluator and scoring lineage digests, carried through, not recomputed from the reduced tree. */
  readonly originalCandidate: Readonly<{ evaluator: string; scoring: string }>;
}

/**
 * Raised (as the sole public failure mode) for descriptor mismatch, missing or
 * changed selected bytes, or an unexpected verification failure. The message is
 * fixed, does not echo failure details, and no cause or detail fields are exposed.
 */
export declare class PackagedEvaluatorError extends Error {
  constructor();
  readonly name: 'PackagedEvaluatorError';
  readonly code: 'ERR_PACKAGED_EVALUATOR_INTEGRITY';
}

/**
 * Verifies the installed packaged evaluator at a fixed root and returns the
 * frozen identity above. The function takes no arguments and no options.
 */
export declare function verifyPackagedEvaluator(): PackagedEvaluatorIdentity;
