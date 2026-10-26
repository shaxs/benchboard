/**
 * Type declarations for `packages/core/dependencies.mjs` (C2 / T2).
 *
 * These declarations describe the public runtime surface exactly as
 * implemented. They are checked with the repository's pinned TypeScript
 * compiler in the focused initialisation test (no install, no project-wide
 * typecheck, no emitted output). The `.d.ts` and `.d.mts` files are required to
 * be byte-identical, so one declaration pair serves both a `require`-style and
 * an ESM consumer of the same JavaScript module.
 *
 * Domain separation that must never be collapsed:
 *  - The **workload** tree digest uses `benchboard-sha256-tree-v1`
 *    (`packages/core/identity.mjs`).
 *  - A **dependency** digest uses `DEPENDENCY_HASH_ALGORITHM_ID`, i.e.
 *    `benchboard-dependency-tree-v1`. It is a separate domain and the two
 *    values are never interchangeable, even though both are built from
 *    SHA-256 path/digest pairs.
 */

/** Immutable array alias used by the declarations below. */
export type ReadonlyList<T> = readonly T[];

/** The three explicitly declared dependency modes. Never inferred. */
export type DependencyMode = 'none' | 'prepared' | 'install';

/**
 * Machine-readable, stable refusal codes. Every rejection thrown by this
 * module is a `DependencyError` carrying exactly one of these values.
 */
export interface DependencyErrorCodes {
  readonly INVALID_ARGUMENT: 'INVALID_ARGUMENT';
  readonly INVALID_ROOT: 'INVALID_ROOT';
  readonly ROOT_NOT_FOUND: 'ROOT_NOT_FOUND';
  readonly ROOT_NOT_A_DIRECTORY: 'ROOT_NOT_A_DIRECTORY';
  readonly ROOT_IS_FILESYSTEM_ROOT: 'ROOT_IS_FILESYSTEM_ROOT';
  readonly LINK_ANCESTOR: 'LINK_ANCESTOR';
  readonly ROOTS_OVERLAP: 'ROOTS_OVERLAP';
  readonly WORKSPACE_NOT_SCRATCH: 'WORKSPACE_NOT_SCRATCH';
  readonly WORKSPACE_METADATA_PRESENT: 'WORKSPACE_METADATA_PRESENT';
  /** A lock-family file in the workspace contradicts the lock being prepared. */
  readonly WORKSPACE_LOCK_MISMATCH: 'WORKSPACE_LOCK_MISMATCH';
  /** `metadataPath` falls inside a protected root; nothing is written. */
  readonly METADATA_PATH_IN_PROTECTED_ROOT: 'METADATA_PATH_IN_PROTECTED_ROOT';
  readonly MODE_NOT_DECLARED: 'MODE_NOT_DECLARED';
  readonly MODE_OPTION_MISMATCH: 'MODE_OPTION_MISMATCH';
  readonly PREPARED_ROOT_REQUIRED: 'PREPARED_ROOT_REQUIRED';
  readonly CACHE_PROVENANCE_REQUIRED: 'CACHE_PROVENANCE_REQUIRED';
  readonly CACHE_LOCK_MISSING: 'CACHE_LOCK_MISSING';
  readonly CACHE_LOCK_MISMATCH: 'CACHE_LOCK_MISMATCH';
  readonly CACHE_DIGEST_MISMATCH: 'CACHE_DIGEST_MISMATCH';
  readonly DEPENDENCY_DIGEST_MISMATCH: 'DEPENDENCY_DIGEST_MISMATCH';
  readonly TARGET_EXISTS: 'TARGET_EXISTS';
  readonly TARGET_PRESENT: 'TARGET_PRESENT';
  readonly STAGING_FAILED: 'STAGING_FAILED';
  readonly SOURCE_CHANGED_DURING_COPY: 'SOURCE_CHANGED_DURING_COPY';
  readonly COPY_VERIFICATION_FAILED: 'COPY_VERIFICATION_FAILED';
  readonly LINK_IN_DEPENDENCY_TREE: 'LINK_IN_DEPENDENCY_TREE';
  readonly SPECIAL_FILE_IN_DEPENDENCY_TREE: 'SPECIAL_FILE_IN_DEPENDENCY_TREE';
  readonly CASE_COLLISION: 'CASE_COLLISION';
  readonly TREE_LIMIT_EXCEEDED: 'TREE_LIMIT_EXCEEDED';
  readonly FILE_TOO_LARGE: 'FILE_TOO_LARGE';
  readonly TREE_CHANGED_DURING_READ: 'TREE_CHANGED_DURING_READ';
  readonly NPM_EXECUTABLE_REQUIRED: 'NPM_EXECUTABLE_REQUIRED';
  readonly NPM_EXECUTABLE_NOT_FOUND: 'NPM_EXECUTABLE_NOT_FOUND';
  readonly NPM_COMMAND_STRATEGY_UNSUPPORTED: 'NPM_COMMAND_STRATEGY_UNSUPPORTED';
  readonly NPM_LOCKFILE_REQUIRED: 'NPM_LOCKFILE_REQUIRED';
  readonly NPM_LOCKFILE_MISSING: 'NPM_LOCKFILE_MISSING';
  readonly NPM_LOCKFILE_CHANGED: 'NPM_LOCKFILE_CHANGED';
  readonly SCRATCH_ROOT_REQUIRED: 'SCRATCH_ROOT_REQUIRED';
  readonly OFFLINE_UNSUPPORTED: 'OFFLINE_UNSUPPORTED';
  readonly NPM_SPAWN_FAILED: 'NPM_SPAWN_FAILED';
  readonly NPM_TIMEOUT: 'NPM_TIMEOUT';
  readonly NPM_EXIT_NONZERO: 'NPM_EXIT_NONZERO';
  readonly NPM_OUTPUT_UNBOUNDED: 'NPM_OUTPUT_UNBOUNDED';
  readonly CLEANUP_FAILED: 'CLEANUP_FAILED';
  /** A publication survived a failure and was deliberately kept. */
  readonly PUBLICATION_RETAINED: 'PUBLICATION_RETAINED';
  /** A partial publication from a failed preparation was removed. */
  readonly PUBLICATION_PARTIAL: 'PUBLICATION_PARTIAL';
}

/** The frozen code table itself. */
export const DEPENDENCY_ERROR_CODES: DependencyErrorCodes;

/** One code value of `DEPENDENCY_ERROR_CODES`. */
export type DependencyErrorCode = DependencyErrorCodes[keyof DependencyErrorCodes];

/** Identity constants of the dependency contract. */
export const DEPENDENCIES_MODULE_ID: 'benchboard.core.dependencies';
export const DEPENDENCIES_CONTRACT_VERSION: '1.0.0';

/**
 * The dependency hash domain. Distinct from the workload algorithm id
 * `benchboard-sha256-tree-v1`; a value from one domain is never valid in the
 * other.
 */
export const DEPENDENCY_HASH_ALGORITHM_ID: 'benchboard-dependency-tree-v1';

/** Name of the dependency directory inside a workspace. */
export const DEPENDENCIES_DIRECTORY_NAME: 'node_modules';

/**
 * Owner-side provenance marker name for a prepared cache. It is deliberately
 * never copied into a participant workspace and never enters a dependency
 * digest.
 */
export const DEPENDENCIES_METADATA_FILE_NAME: '.benchboard-dependencies.json';

/** The declared modes, in their canonical order. */
export const DEPENDENCY_MODES: ReadonlyList<DependencyMode>;

/**
 * Bound set for a single preparation. Every bound is a hard failure, never a
 * silent truncation.
 */
export interface DependencyLimits {
  /** Maximum number of regular files in one dependency tree. */
  readonly maxEntries: number;
  /** Maximum size of one file in bytes. */
  readonly maxFileBytes: number;
  /** Maximum sum of all file sizes in bytes. */
  readonly maxTotalBytes: number;
  /** Wall-clock bound for one npm invocation, in milliseconds. */
  readonly npmTimeoutMs: number;
  /** Maximum captured bytes of npm output per stream. */
  readonly npmMaxOutputBytes: number;
}

/** The shipped default bounds. */
export const DEPENDENCY_LIMITS: DependencyLimits;

/**
 * Recorded policy for executable shims inside a dependency tree
 * (`node_modules/.bin/*`). This build implements the **refusal** half of the
 * Captain rule: nothing inside a dependency tree is materialised or followed,
 * and links are never silently accepted.
 */
export interface NpmBinLinkPolicy {
  readonly policyId: 'benchboard-npm-bin-link-v1';
  /** Links, junctions and shims are refused, never materialised. */
  readonly materialisation: 'refused';
  /** A link would at most be legal inside the helper-owned cache. */
  readonly insideCacheOnly: true;
  /** Link targets are never resolved or followed. */
  readonly resolveTargets: false;
  readonly note: string;
}

export const NPM_BIN_LINK_POLICY: NpmBinLinkPolicy;

/** How an npm executable is carried into a `shell: false` spawn. */
export interface NpmCommandStrategies {
  /** Execute the image directly. */
  readonly DIRECT: 'direct';
  /** Carry the command through `cmd.exe /d /c` as separate argv elements. */
  readonly CMD_EXE: 'cmdexe';
}

export const NPM_COMMAND_STRATEGIES: NpmCommandStrategies;

/**
 * Environment variable names forwarded to npm. Nothing else of the parent
 * environment reaches the child, and the cache location is always the
 * helper-owned staging cache.
 */
export const NPM_FORWARDED_ENVIRONMENT: ReadonlyList<string>;

/**
 * What became of the dependency directory when an operation failed after it had
 * already claimed the name. The reason an operation failed and the state of the
 * bytes it left are two different facts, and only this type carries the second:
 * a caller that does not know whether verified bytes are in place has to throw
 * away a working installation or keep a half-written one.
 *
 * A partial publication reports `removed` as the outcome it observed rather
 * than as a promise: the claim this call made is empty by construction, so it is
 * retired, but a byte that is in place under that name is not one this module
 * can show it wrote, and it is preserved rather than deleted. `residue` names
 * what is still standing, which is why `removed: false` is not a failed cleanup.
 *
 * `unreadable` means the tree could not even be inventoried. No code is attached
 * to it, because no code describes it and deleting bytes on an assumption is the
 * worse error.
 */
export type DependencyPublicationFate = Readonly<
  | {
      readonly code: 'PUBLICATION_RETAINED';
      readonly path: string;
      readonly digest: string;
      readonly removed: false;
    }
  | {
      readonly code: 'PUBLICATION_PARTIAL';
      readonly path: string;
      readonly digest: string;
      /** `false` when a byte this call can not prove it created kept the name in place. */
      readonly removed: boolean;
      /** Paths still standing under the claimed name; empty when it is gone. */
      readonly residue: readonly string[];
    }
  | {
      readonly path: string;
      readonly state: 'unreadable';
      readonly cause: string;
    }
>;

/** Error thrown for every refusal; `code` is machine-readable and stable. */
export class DependencyError extends Error {
  readonly name: 'DependencyError';
  readonly code: DependencyErrorCode;
  /** Non-secret, serialisable context; absent when nothing further is known. */
  readonly details?: Readonly<Record<string, unknown>>;
  /**
   * Present only when the failure happened at or after the point where the
   * dependency directory name was claimed by this call. The claim is this call's
   * own name, but the bytes inside it are not thereby this call's bytes: it
   * writes no tree there directly, so anything found there is reported by this
   * type rather than deleted, and a caller that needs the name back can act on
   * `removed` and `residue`.
   */
  readonly publication?: DependencyPublicationFate;
  constructor(code: DependencyErrorCode, message: string, details?: Record<string, unknown>);
}

/** One inventoried regular file of a dependency tree. */
export interface DependencyInventoryEntry {
  /** Exact relative POSIX path inside the dependency tree. */
  readonly path: string;
  /** Byte length of the file. */
  readonly bytes: number;
  /** Lowercase 64-hex SHA-256 of the file bytes. */
  readonly sha256: string;
}

/**
 * The full inventory of one dependency tree. `digest` is the dependency-domain
 * digest of the sorted `[path, sha256]` pairs.
 */
export interface DependencyInventory {
  readonly mode: DependencyMode | null;
  readonly hashAlgorithmId: 'benchboard-dependency-tree-v1';
  /** Display path (forward slashes) of the inventoried root, or `null` when empty. */
  readonly root: string | null;
  readonly entries: ReadonlyList<DependencyInventoryEntry>;
  readonly digest: string | null;
  readonly totalBytes: number;
}

/** How the npm invocation was actually built and how it ended. */
export type DependencyCommandReport = Readonly<{
  readonly strategy: 'direct' | 'cmdexe';
  readonly file: string;
  readonly args: ReadonlyList<string>;
  readonly shell: false;
  /**
   * True when the command line was passed verbatim to `cmd.exe` instead of being
   * escaped by the runtime, which is the rule the `cmdexe` strategy requires.
   */
  readonly windowsVerbatimArguments: boolean;
  /** Display path (forward slashes) the command ran in. */
  readonly workingDirectory: string;
  readonly timeoutMs: number;
  readonly status: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stderrTail: string;
  readonly stdoutTail: string;
  readonly npmBinLinkPolicy: NpmBinLinkPolicy;
}>;

/** Recorded provenance of a prepared cache or of an install. */
export type DependencyProvenance = Readonly<Record<string, unknown>>;

/**
 * The result record of one preparation. It is always returned, and it is
 * persisted only when an explicit `metadataPath` outside the participant
 * workspace was supplied.
 */
export interface DependencyRecord {
  readonly schemaVersion: '1.0.0';
  readonly module: 'benchboard.core.dependencies';
  readonly hashAlgorithmId: 'benchboard-dependency-tree-v1';
  readonly mode: DependencyMode;
  readonly workspaceRoot: string;
  /** `node_modules` for a real preparation, `null` for mode `none`. */
  readonly dependencyDirectory: string | null;
  readonly provenance: DependencyProvenance | null;
  readonly npm: DependencyCommandReport | null;
  readonly persisted: boolean;
  readonly metadataPath: string | null;
  /** Whether a command was executed; `false` for `none` and `prepared`. */
  readonly executed: boolean;
  readonly copiedFiles: number;
  readonly copiedBytes: number;
  /** Helper-created paths that were removed again, in removal order. */
  readonly cleanedUp: ReadonlyList<string>;
}

/** The resolved process request handed to a `DependencyProcessAdapter`. */
export interface DependencyProcessRequest {
  readonly file: string;
  readonly args: ReadonlyList<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly shell: false;
  /**
   * Spawn options carried from `buildDependencyCommand`. `shell` is always
   * `false`; `windowsVerbatimArguments` is `true` exactly when `file` is
   * `cmd.exe`, because Node otherwise re-escapes the quoted command tail with
   * backslashes, which `cmd.exe` does not accept.
   */
  readonly options: DependencySpawnOptions;
}

/** The subset of Node spawn options this build may set. */
export interface DependencySpawnOptions {
  readonly shell: false;
  /**
   * Pass each argument through to the child command line without re-escaping.
   * Required for `cmd.exe /d /c "<command>" …`; absent for a direct strategy,
   * where Node's own escaping is correct.
   */
  readonly windowsVerbatimArguments?: true;
}

/** The outcome a process adapter must resolve with. */
export interface DependencyProcessResult {
  /** Exit status, `null` when the process was signalled. */
  status: number | null;
  /** Termination signal, `null` on a clean exit. */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Present when the process could not be started at all. */
  spawnError?: string | null;
  /** `true` when the bound expired and the process was terminated. */
  timedOut?: boolean;
  /** `true` when captured output exceeded the configured bound. */
  overflow?: boolean;
}

/**
 * Injectable process port. Tests supply a deterministic adapter, so the
 * `install` mode is fully testable without a network and without a real
 * package installation. Settlement must mean all process/output writers have
 * stopped. Only .npm-cache and node_modules are declared outputs; their creation
 * identities are captured once after settlement, never adopted on later reads.
 * Cleanup requires unchanged creation/ancestor identities and file digests, not
 * just matching contents. This is cooperative, not adversarial OS containment.
 */
export type DependencyProcessAdapter = (
  request: DependencyProcessRequest,
) => Promise<DependencyProcessResult> | DependencyProcessResult;

/** Options accepted by `prepareDependencies`. */
export interface PrepareDependenciesOptions {
  /** Required and never inferred; an absent or unknown mode is a refusal. */
  readonly mode: DependencyMode;
  /** Exclusive caller-owned scratch workspace; never a repository root. */
  readonly workspaceRoot: string;
  /** Mode `prepared`: the explicit, compatible, non-overlapping cache root. */
  readonly preparedRoot?: string;
  /** Mode `prepared`: expected cache digest, 64 lowercase hex characters. */
  readonly cacheDigest?: string;
  /** Locked dependency source root, always outside the participant workspace. */
  readonly sourceRoot?: string;
  /** Mode `install`: the root this helper owns for the duration of the install. */
  readonly scratchRoot?: string;
  /** Mode `install`: explicit absolute executable; no `PATH` lookup is done. */
  readonly npmExecutable?: string;
  /** Force a command strategy; `auto` decides from the platform and extension. */
  readonly executableStrategy?: 'auto' | 'direct' | 'cmdexe';
  /**
   * npm install strategy, passed verbatim as `--install-strategy=` and recorded
   * in provenance. Only the link-free npm strategies are admissible; the
   * default is `hoisted`. `linked` is refused with `LINK_IN_DEPENDENCY_TREE`
   * because it stores packages under `node_modules/.store` and links them into
   * place, which is a link inside the dependency tree. An unlisted value such as
   * `short` is refused with `INVALID_ARGUMENT`: it is not an npm strategy.
   */
  readonly installStrategy?: 'hoisted' | 'nested' | 'shallow';
  /** `true` is refused for `install`; `false` adds `--offline=false`. */
  readonly offline?: boolean;
  /** Expected resulting dependency digest, 64 lowercase hex characters. */
  readonly expectedDependencyDigest?: string;
  /** Where to persist the record; must be outside the participant workspace. */
  readonly metadataPath?: string;
  /** Single path segment names of the locked source. */
  readonly lockfileName?: string;
  readonly manifestFileName?: string;
  /** Overrides of the shipped bounds. */
  readonly maxEntries?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly timeoutMs?: number;
  /** Fixed argument vectors; each element is re-validated before use. */
  readonly npmArgumentsPrefix?: ReadonlyList<string>;
  readonly npmArgumentsSuffix?: ReadonlyList<string>;
  /** Runtime allowlist overrides only (case-insensitive NPM_FORWARDED_ENVIRONMENT);
   * npm config/credentials/redirects and duplicate aliases are rejected before writes.
   * Private npm cache and user/global config paths are reserved and forced. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Platform override, so the Windows strategy is testable on any host. */
  readonly platform?: string;
  /** Process port for `install`; required for a deterministic test run. */
  readonly processAdapter?: DependencyProcessAdapter;
}

/** The frozen result of `prepareDependencies`. */
export interface PrepareDependenciesResult {
  readonly mode: DependencyMode;
  /** Dependency-domain digest, or `null` for mode `none`. */
  readonly dependencyDigest: string | null;
  readonly inventory: DependencyInventory;
  readonly metadata: DependencyRecord;
}

/**
 * Prepare the dependencies of a caller-owned scratch workspace.
 *
 * Mode `none` executes nothing and writes nothing. Mode `prepared` copies an
 * explicit, provenance-verified cache into the workspace as **ordinary files
 * only**, verifying each file's digest before and after the copy. Mode
 * `install` is opt-in and bounded: the locked source bytes are copied
 * unchanged into helper-owned scratch and installed with `shell: false` and a
 * validated argument vector, never with a shell string.
 *
 * @throws {DependencyError} see `DEPENDENCY_ERROR_CODES`
 */
export function prepareDependencies(options: PrepareDependenciesOptions): Promise<PrepareDependenciesResult>;

/** Options of `resolveDependencyCommandStrategy`. */
export interface ResolveCommandStrategyOptions {
  /** Platform to decide for; defaults to the running platform. */
  readonly platform?: string;
  /** Absolute path of the npm executable or shim. */
  readonly executablePath: string;
  /** Requested strategy; defaults to `auto`. */
  readonly executableStrategy?: 'auto' | 'direct' | 'cmdexe';
}

/** A resolved way to carry one command without a shell. */
export interface ResolvedCommandStrategy {
  readonly strategy: 'direct' | 'cmdexe';
  /** The file to spawn; `cmd.exe` for the shim strategy. */
  readonly file: string;
  /** Leading elements inserted before the command, e.g. `/d`, `/c`. */
  readonly forwardArguments: ReadonlyList<string>;
  /** Whether the command and its arguments are carried through `cmd.exe`. */
  readonly wrapForCmdExe: boolean;
  readonly shell: false;
  readonly reason: string;
}

/**
 * Decide how an npm invocation must be built for a platform **without**
 * spawning anything, so the Windows `.cmd` question is testable on any host.
 *
 * @throws {DependencyError} code `NPM_COMMAND_STRATEGY_UNSUPPORTED`, `INVALID_ROOT`, `INVALID_ARGUMENT`
 */
export function resolveDependencyCommandStrategy(options: ResolveCommandStrategyOptions): ResolvedCommandStrategy;

/** The command vector to build. */
export interface DependencyCommand {
  readonly command: string;
  readonly args?: ReadonlyList<string>;
}

/**
 * A fully built `shell: false` spawn request.
 *
 * `windowsVerbatimArguments` is present and `true` only for a command line that
 * has to reach `cmd.exe` verbatim, because the runtime would otherwise re-escape
 * the quoted command element. It is absent rather than `false` for a directly
 * spawned command, which is why the property is optional and narrowed to `true`.
 */
export interface BuiltDependencyCommand {
  readonly file: string;
  readonly args: ReadonlyList<string>;
  readonly options: { readonly shell: false; readonly windowsVerbatimArguments?: true };
}

/**
 * Build the final argument vector for a resolved strategy. Every element is
 * re-validated: no C0/DEL control byte, no quote or expansion metacharacter,
 * and no `cmd` metacharacter when the element is carried through
 * `cmd.exe /d /c`.
 *
 * @throws {DependencyError} code `INVALID_ARGUMENT`
 */
export function buildDependencyCommand(resolved: ResolvedCommandStrategy, command: DependencyCommand): BuiltDependencyCommand;

/** Options of `createNodeSpawnAdapter`. */
export interface NodeSpawnAdapterOptions {
  /** Wall-clock bound in milliseconds. */
  readonly timeoutMs?: number;
  /** Per-stream capture bound in bytes. */
  readonly maxOutputBytes?: number;
  /** Signal used to terminate an expired process. */
  readonly killSignal?: string;
}

/**
 * The default process port, built on `child_process.spawn` with
 * `shell: false`. Provided so a caller can reuse it; tests inject their own.
 */
export function createNodeSpawnAdapter(options?: NodeSpawnAdapterOptions): DependencyProcessAdapter;
