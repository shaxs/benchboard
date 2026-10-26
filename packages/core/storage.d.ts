/**
 * Type declarations for the BenchBoard neutral storage transactions module
 * (C1 T3; amended in C1 T5 for immutable replacement refusal and same-instance
 * transaction ownership; amended in C1 T6 for interrupted-publication
 * recovery: bound identity reservations before immutable byte publication and
 * conservative refusal of reserved/unregistered published targets through the
 * mutable API; amended in C1 T10 for type-preserving recovery: bound pending
 * mutable reservations before first-time mutable byte publication, so an
 * interrupted first mutable publication recovers as the same MUTABLE identity
 * through an identical replaceMutable retry and later updates stay allowed).
 * Node builtins only; no DSH dependencies.
 */

/**
 * Typed storage error. Every refusal carries a stable `code` such as
 * `ERR_STORAGE_DUPLICATE_IDENTITY`, `ERR_STORAGE_IMMUTABLE_REPLACEMENT`,
 * `ERR_STORAGE_TYPE_CONFLICT`, `ERR_STORAGE_DIGEST_MISMATCH`,
 * `ERR_STORAGE_LOCK_CONFLICT`,
 * `ERR_STORAGE_TARGET_EXISTS`, `ERR_STORAGE_ENVELOPE_MALFORMED`,
 * `ERR_STORAGE_NOT_REGULAR_FILE`, `ERR_STORAGE_ROOT_LINK`,
 * `ERR_STORAGE_VALUE_NOT_JSON`, `ERR_STORAGE_HOOK_ABORT`, and related
 * `ERR_STORAGE_*` codes. Duplicate-identity details include a
 * `pendingRegistration: true` flag and the reserved path/digest when the
 * refusal is caused by an interrupted-publication reservation.
 */
export declare class StorageError extends Error {
  /** Stable refusal code. */
  readonly code: string;
  /** Structured context, when applicable. */
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>);
}

/** Context passed to instrumentation hooks (test/observation seam only). */
export interface StorageHookContext {
  operation: 'createImmutable' | 'replaceMutable';
  relativePath: string;
  kind: string;
  id: string;
  /** Undefined before the envelope digest exists (beforeStage). */
  digest: string | undefined;
}

/** Hooks may throw to inject transaction failures. Callers must await. */
export interface StorageHooks {
  beforeStage?(context: StorageHookContext): void | Promise<void>;
  beforePublish?(context: StorageHookContext): void | Promise<void>;
  beforeRegister?(context: StorageHookContext): void | Promise<void>;
}

export interface CreateStorageOptions {
  /** Explicit absolute storage root. No defaults, no environment lookup. */
  root: string;
  /** Optional failure-injection/observation hooks. */
  hooks?: StorageHooks;
}

/** Location + identity key for a record. */
export interface StorageReadKey {
  /** POSIX relative path inside the explicit root; never absolute/traversal. */
  relativePath: string;
  /** Restricted `[A-Za-z][A-Za-z0-9._:-]{0,127}` identity kind. */
  kind: string;
  /** Non-empty identity id, unique across locations within the root. */
  id: string;
}

export interface StorageWritePayload extends StorageReadKey {
  /** JSON-representable value (callers own domain/schema validation). */
  value: unknown;
}

export interface StorageOperationResult {
  kind: string;
  id: string;
  relativePath: string;
  digest: string;
  recordType: 'immutable' | 'mutable';
  /** Mutable only: true when an existing record at this path was replaced. */
  replaced?: boolean;
  /**
   * True when the operation reconciled an interrupted prior publication:
   * either it completed the registry entry for already-published identical
   * bytes (registration-only completion), or it republished identical bytes
   * under a bound reservation left behind by an interrupted transaction
   * (reservation recovery). Recovery is type-preserving: a completed
   * immutable reservation registers immutable, a completed pending mutable
   * reservation registers mutable.
   */
  recovered?: boolean;
}

export interface Storage {
  /** Absolute real path of the storage root. */
  readonly root: string;
  /**
   * Read a record value after full integrity and identity verification.
   * The storage root is re-validated against the current filesystem on every
   * read (a root externally replaced by a symlink/junction is refused, never
   * read through). Rejects (never returns undefined) for missing, corrupt,
   * digest-mismatched or identity-mismatched records.
   */
  read<T = unknown>(key: StorageReadKey): Promise<T>;
  /**
   * Publish a verified immutable record exclusively without overwrite
   * (exclusive link publication). Duplicate (kind, id) across any location in
   * the root is refused.
   *
   * Bound reservation guarantee (C1 T6, type-gated in C1 T10): BEFORE any
   * byte of an immutable
   * publication can appear at the target, the identity is reserved in the
   * local registry as a pending immutable reservation
   * (`{ relativePath, digest, recordType: 'immutable', pending: true }`).
   * A transaction interrupted after that point (hook abort, crash or process
   * kill between publication and registration) leaves a recoverable
   * interrupted state that is explicitly bound:
   *   - the identity stays reserved at its publication path; creating the
   *     same identity at ANOTHER location is refused
   *     (ERR_STORAGE_DUPLICATE_IDENTITY, pendingRegistration: true);
   *   - retrying with DIFFERENT bytes at the reserved path is refused;
   *   - retrying with byte-identical content at the reserved path completes
   *     the registration and returns `recovered: true`;
   *   - a pending MUTABLE reservation is never type-converted through this
   *     method (ERR_STORAGE_TYPE_CONFLICT with `pendingRegistration: true`
   *     and the reserved digest/type); such an identity reconciles only
   *     through an identical replaceMutable retry at the reserved path;
   *   - reserved immutable or published-but-unregistered bytes are never
   *     overwritten or type-converted through the mutable API (see
   *     replaceMutable); their recovery is therefore only reachable through
   *     this immutable API.
   * Reservations are recoverable, not auto-expiring: a never-reconciled
   * reservation keeps the identity reserved until an identical retry or an
   * explicit operator registry correction. Corrupt, malformed,
   * digest-mismatched, foreign-identity or non-regular-file targets at the
   * reconciliation path fail closed; no OS-level power-loss durability
   * claim is made.
   */
  createImmutable(payload: StorageWritePayload): Promise<StorageOperationResult>;
  /**
   * Atomically replace (or first-time create) a mutable record by staged
   * same-directory rename under the exclusive root-wide lock. Identity
   * (kind, id, path) is immutable; the value may change. A record registered
   * as immutable is never replaced or type-converted through this method
   * (ERR_STORAGE_IMMUTABLE_REPLACEMENT); its bytes, identity and registry
   * entry are preserved.
   *
   * Type-preserving first-publication reservation (C1 T10): BEFORE any byte
   * of a FIRST-TIME mutable publication can appear at the target, the
   * identity is reserved in the local registry as a pending mutable
   * reservation (`{ relativePath, digest, recordType: 'mutable',
   * pending: true }`). An interrupted first-time publication therefore
   * recovers as the SAME mutable identity: a byte-identical retry at the
   * reserved path completes the registration as MUTABLE (`recovered: true`;
   * registration-only completion when the bytes were already published,
   * reservation-backed republish when they were not) and LATER value
   * changes remain allowed. A retry with different bytes, a retry at
   * another location (ERR_STORAGE_DUPLICATE_IDENTITY with
   * `pendingRegistration: true`), or an immutable conversion over the
   * pending mutable reservation (createImmutable:
   * ERR_STORAGE_TYPE_CONFLICT) is refused and preserves the interrupted
   * bytes/identity. Reservations are never auto-expired and recovery never
   * changes the reserved record type.
   *
   * Conservative unregistered-target refusal (C1 T6): when the record target
   * already holds published bytes WITHOUT any reservation or registration —
   * an interrupted immutable publication or externally placed bytes whose
   * record type is not recoverable — replaceMutable refuses them
   * (ERR_STORAGE_IMMUTABLE_REPLACEMENT with `pendingRegistration` in the
   * details) and preserves the bytes untouched; such a target reconciles
   * only through createImmutable with identical bytes, which registers the
   * published bytes as immutable, or an explicit operator disposition (no
   * current record type is invented for them). An uninterrupted
   * first-time mutable replacement of an already-registered mutable
   * identity still heals normally. Corrupt or foreign-identity target bytes
   * fail closed through integrity verification before any refusal.
   */
  replaceMutable(payload: StorageWritePayload): Promise<StorageOperationResult>;
  /**
   * Run an operation while holding the exclusive root-wide single-writer
   * lock. Locks are never stolen; writers on another container instance or
   * another process are refused. Within one container, independent
   * concurrent operations are serialized in FIFO order, and causally nested
   * same-container operations (e.g. writes awaited inside this callback)
   * join the holder through per-run child queues and are fully drained
   * before the lock is released.
   */
  withLock<T>(operation: () => T | Promise<T>): Promise<T>;
}

export declare function createStorage(options: CreateStorageOptions): Storage;
