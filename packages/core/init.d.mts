/**
 * Type declarations for `packages/core/init.mjs` (C2 / T3).
 *
 * These declarations describe the public runtime surface exactly as
 * implemented and are checked with the repository's pinned TypeScript compiler
 * in the focused initialization test (no install, no project-wide typecheck, no
 * emitted output). The `.d.mts` sibling is a byte-identical copy, which the same
 * test asserts.
 *
 * Ownership rule kept visible here: the identity records, the sealed manifest
 * and the dependency mode are not restated. They are imported from the modules
 * that own them, so a required identity member or a new dependency mode cannot
 * be silently dropped from this declaration, and no second, weaker copy of the
 * C1 contract can come into existence through this file.
 */

import type { SealedRunManifest, SecurityModel, ToolingIdentity, EvaluatorIdentity, RunConfiguration } from './manifest.mjs';
import type { ChallengePackage } from './challenge-export.mjs';
import type { DependencyMode, DependencyProvenance, DependencyCommandReport, ReadonlyList } from './dependencies.mjs';

/* -------------------------------------------------------------------------- */
/* Contract constants                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Machine-readable refusal reasons emitted by `InitError.code`. A code is
 * stable across releases: a caller branches on it, never on the message.
 */
export interface InitErrorCodes {
  /** The request object itself is missing or not a plain object. */
  readonly INVALID_ARGUMENT: 'INVALID_ARGUMENT';
  /** An option has the wrong type or an unrecognised shape. */
  readonly INVALID_OPTION: 'INVALID_OPTION';
  /** An option the contract requires was not supplied. */
  readonly OPTION_REQUIRED: 'OPTION_REQUIRED';
  /** A root was not an absolute host path. */
  readonly INVALID_ROOT: 'INVALID_ROOT';
  /** An explicit root does not exist or is not a directory. */
  readonly ROOT_NOT_FOUND: 'ROOT_NOT_FOUND';
  /** A path component is a symbolic link or a special file. */
  readonly LINK_OR_SPECIAL: 'LINK_OR_SPECIAL';
  /** An output would equal, contain or sit inside a protected or owned root. */
  readonly ROOTS_OVERLAP: 'ROOTS_OVERLAP';
  /** The dependency mode is not one of the three declared modes. */
  readonly DEPENDENCY_MODE_INVALID: 'DEPENDENCY_MODE_INVALID';
  /** Dependency options do not match the declared mode. */
  readonly DEPENDENCY_MODE_MISMATCH: 'DEPENDENCY_MODE_MISMATCH';
  /** A supplied identity record failed the accepted contract validation. */
  readonly IDENTITY_INVALID: 'IDENTITY_INVALID';
  /** A run architecture or an identity identifier collides with another. */
  readonly IDENTITY_COLLISION: 'IDENTITY_COLLISION';
  /** A ceiling exceeds the ceiling the challenge identity binds. */
  readonly CEILING_EXCEEDED: 'CEILING_EXCEEDED';
  /** A version or identity domain was conflated (a digest used in the wrong role). */
  readonly DOMAIN_CONFLATION: 'DOMAIN_CONFLATION';
  /** The output already exists, or a concurrent writer reserved it first. */
  readonly OUTPUT_EXISTS: 'OUTPUT_EXISTS';
  /** The output parent is missing, is a file, or refused an exclusive create. */
  readonly OUTPUT_UNUSABLE: 'OUTPUT_UNUSABLE';
  /** A published container failed the read-back verification. */
  readonly PUBLICATION_INVALID: 'PUBLICATION_INVALID';
  /** A state record could not be written, published or read back. */
  readonly STATE_WRITE_FAILED: 'STATE_WRITE_FAILED';
  /** An accepted dependency returned a shape this seam cannot record. */
  readonly DEPENDENCY_RESULT_INVALID: 'DEPENDENCY_RESULT_INVALID';
  /** Rollback completed; the material this call created is gone again. */
  readonly INIT_FAILED_ROLLED_BACK: 'INIT_FAILED_ROLLED_BACK';
  /** Material this call created could not be removed; it is disclosed, not destroyed. */
  readonly CLEANUP_FAILED: 'CLEANUP_FAILED';
  /** A failure this module cannot attribute to a named refusal. */
  readonly INTERNAL: 'INTERNAL';
}

/** The frozen, stable set of rejection codes. */
export const INIT_ERROR_CODES: InitErrorCodes;

/** Any code this module can report. */
export type InitErrorCode = InitErrorCodes[keyof InitErrorCodes];

/** Stable identifier of this module, recorded in the state records. */
export const INIT_MODULE_ID: 'benchboard.core.init';

/** Schema version of the run-initialisation state records. */
export const INIT_STATE_SCHEMA_VERSION: '1.0.0';

/** Record kind of every state record this module publishes. */
export const INIT_STATE_KIND: 'benchboard:run-initialisation';

/** Directory inside the container that becomes the participant workspace. */
export const WORKSPACE_DIRECTORY_NAME: 'workspace';

/** Directory inside the container that holds this run's state, outside the workspace. */
export const STATE_DIRECTORY_NAME: '.benchboard';

/** Directory inside the state root that holds dependency material. */
export const DEPENDENCIES_DIRECTORY_NAME: 'dependencies';

/** State-relative path of the sealed run manifest record. */
export const RUN_STATE_RELATIVE_PATH: 'state/run.json';

/** State-relative path of the immutable dependency companion record. */
export const DEPENDENCY_STATE_RELATIVE_PATH: 'state/dependencies.json';

/** State-relative path of the immutable export proof record. */
export const EXPORT_STATE_RELATIVE_PATH: 'state/export.json';

/** Identifier of the workload hash domain. Never interchangeable with the dependency one. */
export const WORKLOAD_HASH_ALGORITHM_ID: 'benchboard-sha256-tree-v1';

/** Identifier of the dependency hash domain. Never interchangeable with the workload one. */
export const DEPENDENCY_HASH_ALGORITHM_ID: 'benchboard-dependency-tree-v1';

/** File name of the dependency helper's own metadata record. */
export const DEPENDENCIES_METADATA_FILE_NAME: '.benchboard-dependencies.json';

/** The three dependency modes the accepted helper declares. Never inferred. */
export const DEPENDENCY_MODES: ReadonlyList<DependencyMode>;

/**
 * The security models the accepted contract binds, re-exported from that
 * contract rather than restated here. Nothing is inferred; the only default is
 * `UNSPECIFIED`.
 */
export const INIT_SECURITY_MODELS: ReadonlyList<SecurityModel>;

/* -------------------------------------------------------------------------- */
/* Error                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Typed initialisation error. Every refusal this module raises on its own
 * account is an `InitError` carrying one of `INIT_ERROR_CODES`, and its message
 * is prefixed with that code. Where the transaction fails because an accepted
 * dependency or exporter reported a fault, the foreign error is rethrown
 * unchanged with the rollback outcome attached (`initialisationFailed`,
 * `cleanup`), so the real reason stays visible.
 */
export class InitError extends Error {
  readonly name: 'InitError';
  /** One stable code from `INIT_ERROR_CODES`. */
  readonly code: InitErrorCode;
  /** The path the refusal is about, when the refusal is path-specific. */
  readonly path?: string;
  /** The underlying failure, when this refusal wraps one. */
  readonly cause?: unknown;
  /** Present when material this call created could not be removed. */
  readonly cleanup?: InitError;
  /**
   * @param code one of `INIT_ERROR_CODES`
   * @param message human-readable reason
   */
  constructor(code: string, message: string, details?: Record<string, unknown>);
}

/* -------------------------------------------------------------------------- */
/* Request                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The dependency part of a request. Which fields are legal is decided by the
 * mode, exactly as the accepted helper decides it: a mode that cannot honour an
 * option is refused rather than having the option ignored.
 */
export interface InitDependencyRequest {
  /** `none` leaves the workspace without dependencies; `install` needs the network. */
  readonly mode: DependencyMode;
  /** Required for `prepared`: the populated cache directory to copy from. */
  readonly preparedRoot?: string;
  /** Required for `prepared` and `install`: the root holding the lock files. */
  readonly sourceRoot?: string;
  /** Optional for `install`: where private install scratch may be created. */
  readonly scratchRoot?: string;
  /** Optional for `prepared` and `install`: the digest the result must equal. */
  readonly expectedDependencyDigest?: string;
  /** Required for `install`. */
  readonly npmExecutable?: string;
  /** `install` with `offline: true` is refused; no silent fallback exists. */
  readonly offline?: boolean;
  readonly npmArgumentsPrefix?: ReadonlyList<string>;
  readonly npmArgumentsSuffix?: ReadonlyList<string>;
  readonly processAdapter?: unknown;
  readonly maxEntries?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly timeoutMs?: number;
}

/**
 * The observation a transaction seam is handed. Which fields arrive depends on
 * the seam; the object is frozen, so a hook can observe and abort but cannot
 * rewrite the transaction's intent.
 */
export interface InitObservation {
  readonly stage: 'beforeWorkspacePublication' | 'beforeStatePublication';
  readonly output: string;
  readonly workspaceRoot: string;
  readonly stateRoot?: string;
  readonly manifestId?: string;
  readonly runId?: string;
}

/** A seam callback. Throwing (or returning a rejected promise) aborts the transaction. */
export type InitHook = (observation: InitObservation) => void | Promise<void>;

/**
 * One run-initialisation request. Every root is explicit and absolute; nothing
 * is read from configuration, the environment, DSH or a `runner/` directory, and
 * no unknown value is coerced to zero or an empty string.
 */
export interface InitRequest {
  /** The container to create exclusively. An existing target is never entered. */
  readonly output: string;
  /** The accepted challenge package: identity, physical source, boundary. */
  readonly challenge: ChallengePackage;
  /** How dependencies are provided. Omitted means no dependency preparation. */
  readonly dependencies?: InitDependencyRequest;
  /** Supplied, never discovered. */
  readonly toolingIdentity: ToolingIdentity;
  /** Supplied, never discovered. */
  readonly evaluatorIdentity: EvaluatorIdentity;
  /** The run's own architecture id; it must differ from every bound identity's. */
  readonly architectureId: string;
  /** Defaults to `run`. */
  readonly architectureKind?: string;
  /** Omitted records `UNKNOWN` rather than guessing a harness. */
  readonly harness?: string;
  /** Omitted records `UNSPECIFIED`; never inferred from the machine. */
  readonly securityModel?: SecurityModel;
  /** Stated field by field; a value that is not stated stays absent. */
  readonly expectedSessionPolicy?: Readonly<Record<string, string>>;
  /** Must not exceed the ceiling the challenge identity binds. */
  readonly declaredCeilingMinutes?: number;
  /**
   * Stated configuration only; unstated members remain unknown rather than
   * becoming zero. The accepted field set is exactly the one the C1
   * `RunConfiguration` declares — an additional field is a type error here and an
   * `INVALID_OPTION` refusal at runtime, because inventing a configuration field
   * would put an unschematised claim into the run manifest.
   */
  readonly configuration?: Partial<RunConfiguration>;
  readonly notes?: string;
  /** Observed at the call when omitted. No start or stop clock is read. */
  readonly createdAt?: string;
  /** Test/observation seam immediately before the workspace is published. */
  readonly beforeWorkspacePublication?: InitHook;
  /** Test/observation seam immediately before the state records are published. */
  readonly beforeStatePublication?: InitHook;
}

/* -------------------------------------------------------------------------- */
/* Result                                                                      */
/* -------------------------------------------------------------------------- */

/** The dependency companion record as this module persists and re-reads it. */
export interface InitDependencyCompanion {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'benchboard:dependency-state';
  readonly module: 'benchboard.core.init';
  readonly manifestId: string;
  readonly runId: string;
  readonly mode: DependencyMode | null;
  readonly hashAlgorithmId: 'benchboard-dependency-tree-v1';
  /** The dependency domain digest, or `null` when nothing was prepared. */
  readonly dependencyDigest: string | null;
  /** `node_modules` for a real preparation, `null` for mode `none`. */
  readonly dependencyDirectory: string | null;
  readonly workspaceRoot: string;
  readonly metadataPath: string | null;
  readonly inventoryDigest: string | null;
  readonly inventoryCount: number;
  /** Total size of the inventory, or `null` when the helper reported none. */
  readonly totalBytes: number | null;
  readonly npm: DependencyCommandReport | null;
  readonly provenance: DependencyProvenance | null;
  readonly executed: boolean;
  readonly copiedFiles: number | null;
  readonly copiedBytes: number | null;
  readonly cleanedUp: ReadonlyList<string>;
  readonly notes: string;
}

/** The export proof this module persists in the workload domain. */
export interface InitExportProof {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'benchboard:export-state';
  readonly module: 'benchboard.core.init';
  readonly manifestId: string;
  readonly runId: string;
  readonly hashAlgorithmId: 'benchboard-sha256-tree-v1';
  readonly workloadDigest: string;
  /** The count the challenge package's `fileManifest` declared. */
  readonly declaredFileCount: number;
  /** The count the accepted exporter physically published and re-read. */
  readonly publishedFileCount: number;
  readonly releaseWorkloadFileCount: 26;
  readonly workspaceRoot: string;
  readonly sourceRoot: string;
  readonly inventory: ReadonlyList<{ readonly path: string; readonly bytes: number; readonly sha256: string }>;
  readonly notes: string;
}

/** The full outcome of one successful transaction. */
export interface InitResult {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'benchboard:run-initialisation-result';
  readonly module: 'benchboard.core.init';
  /** The accepted sealed record; its self digest was recomputed on read-back. */
  readonly manifest: SealedRunManifest;
  /** The published container root. */
  readonly output: string;
  readonly workspace: Readonly<{
    /** The final participant workspace root named by the manifest. */
    readonly root: string;
    readonly workloadDigest: string;
    readonly workloadAlgorithmId: 'benchboard-sha256-tree-v1';
    /** Number of files physically present in the published workspace. */
    readonly fileCount: number;
    /** Dependency directory inside the workspace, or `null` for mode `none`. */
    readonly dependencyDirectory: string | null;
  }>;
  readonly state: Readonly<{
    /** The state root named by the manifest as `evidenceRoot`; outside the workspace. */
    readonly root: string;
    /** Always `false`: state is never carried inside a participant workspace. */
    readonly insideWorkspace: boolean;
    readonly runRecord: 'state/run.json';
    readonly dependencyRecord: 'state/dependencies.json';
    readonly exportRecord: 'state/export.json';
    /** State-relative path of the persisted dependency metadata record. */
    readonly dependencyMetadata: string;
    /** Storage envelope digest of the run record, or `null` when unrecorded. */
    readonly runRecordDigest: string | null;
    readonly dependencyRecordDigest: string | null;
    readonly exportRecordDigest: string | null;
  }>;
  /** The dependency domain. */
  readonly dependency: Readonly<{
    readonly mode: DependencyMode;
    /** `null` for mode `none`: nothing was prepared, so nothing is asserted. */
    readonly digest: string | null;
    readonly algorithmId: 'benchboard-dependency-tree-v1';
  }>;
  /** The workload domain; never comparable with `dependency.digest`. */
  readonly workload: Readonly<{
    readonly digest: string;
    readonly algorithmId: 'benchboard-sha256-tree-v1';
    readonly fileCount: number;
  }>;
  /** Wall time of the transaction. A duration, never a run start or stop time. */
  readonly durationMs: number;
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Initialise one run container and return its sealed run manifest.
 *
 * The single transaction is: validate the request and the identities, reserve
 * the output exclusively, publish and verify the workspace, prepare the
 * dependencies outside the workspace, publish the immutable state records, then
 * read the container back and revalidate it. Success is reported only after
 * every one of those proofs holds.
 *
 * A failure removes only the container this call created: a pre-existing target,
 * a concurrent writer's container and any foreign file are preserved and
 * disclosed, never deleted and never overwritten.
 *
 * @throws {InitError} see `INIT_ERROR_CODES`
 */
export function init(request: InitRequest): Promise<SealedRunManifest>;

/**
 * The same single transaction as `init()`, returning the whole result record:
 * the sealed manifest plus the container layout, the two domain digests and the
 * state-record identities. This seam never recomputes or re-derives anything.
 *
 * @throws {InitError} see `INIT_ERROR_CODES`
 */
export function initialiseRun(request: InitRequest): Promise<InitResult>;
