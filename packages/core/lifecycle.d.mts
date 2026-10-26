import type {RunManifest} from './manifest.mjs';
/**
 * Type declarations for the BenchBoard manual run-lifecycle module (C3 T1).
 *
 * Honest manual timing, an immutable operator-declared start, and an
 * append-only, hash-chained recovery journal. The module runs no process,
 * signals nothing, launches nothing and enforces no deadline: a stop is an
 * operator attestation with `stopAssurance: 'operator-attested'` and
 * `enforced: false`. Node builtins only; no DSH, operating-system or supervisor
 * dependency.
 *
 * On-disk layout inside a run container (the state root is derived from the
 * accepted C2 run record and is never a caller input):
 *   `<runRoot>/.benchboard/lifecycle/state.json`   the mutable projection
 *   `<runRoot>/.benchboard/lifecycle/journal/NNNNN.json`  the journal authority
 * The journal is the authority: append-only, sequence-dense, and every event
 * after the first binds the digest of its immediate predecessor. The state
 * record is a projection of it and is never trusted on its own.
 */

/** Stable refusal code carried by every `LifecycleError`. */
export type LifecycleErrorCode =
  | 'INVALID_ARGUMENT'
  | 'FIELD_REQUIRED'
  | 'NOT_FOUND'
  | 'PROVENANCE_MISMATCH'
  | 'STORAGE_REFUSED'
  | 'STATE_TRANSITION_REFUSED'
  | 'DECLARATION_INVALID'
  | 'DECLARATION_ALREADY_BOUND'
  | 'ATTESTATION_INVALID'
  | 'CLOCK_INVALID'
  | 'JOURNAL_INVALID'
  | 'RECOVERY_REQUIRED'
  | string;

/** The complete code table, frozen. Keys and values are the same strings. */
export declare const LIFECYCLE_ERROR_CODES: Readonly<Record<string, LifecycleErrorCode>>;

/** Module identity recorded on every state record. */
export declare const LIFECYCLE_MODULE_ID: 'benchboard-core-lifecycle-v1';
/** Record schema version carried in every record and event. */
export declare const LIFECYCLE_SCHEMA_VERSION: '1.0.0';
/** Envelope kind of the state record. */
export declare const LIFECYCLE_STATE_KIND: 'benchboard.lifecycle.state.v1';
/** Envelope kind of a journal event. */
export declare const LIFECYCLE_EVENT_KIND: 'benchboard.lifecycle.event.v1';
/** Container-relative path of the state record. */
export declare const LIFECYCLE_STATE_RELATIVE_PATH: 'lifecycle/state.json';
/** Container-relative directory of the journal. */
export declare const LIFECYCLE_JOURNAL_DIRECTORY: 'lifecycle/journal';

/** The accepted C2 run-record key the lifecycle binds to. */
export declare const RUN_MANIFEST_STATE_KEY: Readonly<{
  relativePath: string;
  kind: string;
}>;

/** State reported by a container that carries no lifecycle record. */
export declare const LIFECYCLE_DERIVED_STATE: 'INITIALIZED';

/** States a committed record can carry. */
export type LifecycleCommittedState = 'INITIALIZED' | 'RUNNING' | 'STOP_RECORDED' | 'FROZEN';
export declare const LIFECYCLE_COMMITTED_STATES: Readonly<LifecycleCommittedState[]>;

/**
 * Journal event kinds. A run that never started may open its journal with
 * `FREEZE_INTENT` instead of `START_INTENT`, so a clockless freeze needs no
 * invented start.
 */
export type LifecycleEventKind =
  | 'START_INTENT'
  | 'START_COMMIT'
  | 'STOP_RECORDED'
  | 'FREEZE_INTENT'
  | 'FREEZE_COMMIT';
export declare const LIFECYCLE_EVENT_KINDS: Readonly<LifecycleEventKind[]>;

/**
 * The freeze precondition table: the single source of truth for who may reach
 * `FROZEN`. A freeze needs the bound attestation, never a clock reading:
 * `clockRequired` is `false` for both routes because an honestly unavailable
 * clock must not block an attested freeze, and this contract never invents,
 * clamps or substitutes a timestamp to satisfy a gate.
 */
export interface FreezePrecondition {
  readonly requires: 'BOUND_STOP_ATTESTATION' | 'CLOCKLESS_ATTESTATION';
  readonly attestationRequired: true;
  readonly clockRequired: false;
}
export declare const FREEZE_PRECONDITIONS: Readonly<Partial<Record<LifecycleCommittedState, FreezePrecondition>>>;

/** The complete transition permission table enforced by every state write. */
export declare const LIFECYCLE_TRANSITIONS: Readonly<{
  readonly ABSENT: readonly LifecycleCommittedState[];
  readonly INITIALIZED: readonly LifecycleCommittedState[];
  readonly RUNNING: readonly LifecycleCommittedState[];
  readonly STOP_RECORDED: readonly LifecycleCommittedState[];
  readonly FROZEN: readonly [];
}>;

/** The only execution mode this release records. */
export declare const LIFECYCLE_EXECUTION_MODE: 'MANUAL';
/** A recorded stop is attested by the operator and never enforced. */
export declare const STOP_ASSURANCE: 'operator-attested';
export declare const STOP_ENFORCED: false;

/** Structured error for every refusal. `details` is context, never a secret. */
export declare class LifecycleError extends Error {
  readonly code: LifecycleErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: LifecycleErrorCode, message: string, details?: Record<string, unknown>);
}

/**
 * The clock seam. `now()` returns epoch milliseconds, or `null` when the wall
 * clock honestly reports nothing. The default observes the host wall clock; a
 * caller may inject its own `{ now() }`.
 */
export interface LifecycleClock {
  now(): number | null;
}
export declare const DEFAULT_CLOCK: Readonly<LifecycleClock>;

/** Result of one clock read. `ok: false` carries a code and never a guess. */
export type ClockReading =
  | { readonly ok: true; readonly ms: number | null }
  | { readonly ok: false; readonly code: LifecycleErrorCode; readonly error: string };

/** Read one clock value through the seam, rejecting a non-`{ now() }` object. */
export declare function readClockReading(clock: unknown, floor: number | null): ClockReading;

/**
 * Elapsed milliseconds between two ISO instants: a legitimate equal pair yields
 * `0`, an unknown endpoint yields `null`, and a backwards pair yields `null`
 * rather than a clamped value.
 */
export declare function elapsedBetween(earlierIso: string | null, laterIso: string | null): number | null;

/** ISO-8601 UTC instant, or `null` when no time was observed. */
export type IsoInstantOrNull = string | null;

/** The operator-declared start facts, bound against the accepted manifest. */
export interface RunDeclaration {
  readonly harness: string | null;
  readonly model: string | null;
  readonly workerCount: number | null;
  readonly executionMode: 'MANUAL';
  readonly declaredCeilingMinutes: number | null;
}

/** The operator statement that records a stop. It attests; it does not command. */
export interface StopAttestation {
  readonly operator: string;
  readonly agentStopped: true;
  readonly statement: string;
  readonly observedAt?: IsoInstantOrNull;
  /** Only for a clockless freeze from `INITIALIZED`. */
  readonly clockless?: true;
}

/** The error retained when a clock was unavailable or discontinuous. */
export interface ClockError {
  readonly code: LifecycleErrorCode;
  readonly error: string;
  readonly elapsedAvailable: false;
}

/** One journaled event. `previousEventDigest` binds the immediate predecessor. */
export interface LifecycleEvent {
  readonly schemaVersion: '1.0.0';
  readonly kind: LifecycleEventKind;
  readonly runId: string;
  readonly manifestId: string;
  readonly sequence: number;
  readonly previousEventDigest: string | null;
  readonly occurredAt: IsoInstantOrNull;
  readonly journalCommitAt: IsoInstantOrNull;
  readonly hashAlgorithm: 'sha256';
  readonly eventDigest: string;
  readonly declaration?: RunDeclaration;
  readonly detail?: Record<string, unknown>;
}

/** One history entry of the state record. */
export interface LifecycleHistoryEntry {
  readonly at: string;
  /** Which operation appended the entry. The domain is the set of operations this
   *  contract is able to record, and it is the same domain the operational state
   *  schema states, so a reader holding either artifact sees the same rule. */
  readonly operation: 'START' | 'STOP' | 'RECONCILE' | 'FREEZE';
  readonly intentEventDigest?: string;
  readonly stopEventDigest?: string;
  readonly elapsedAvailable?: boolean;
  readonly interruptedOperation?: string;
  readonly decision?: string;
  readonly operator?: string;
  readonly operatorAttestation?: string;
  readonly completedFromIntentDigest?: string;
  readonly [key: string]: unknown;
}

/** The persisted lifecycle state record (the mutable projection). */
export interface LifecycleStateRecord {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'benchboard.lifecycle.state.v1';
  readonly module: 'benchboard-core-lifecycle-v1';
  readonly runId: string;
  readonly manifestId: string;
  readonly manifestDigest: string | null;
  readonly state: LifecycleCommittedState;
  readonly declaration: RunDeclaration | null;
  readonly startedAt: IsoInstantOrNull;
  readonly stoppedAt: IsoInstantOrNull;
  readonly elapsedMs: number | null;
  readonly stopAssurance: 'operator-attested' | null;
  readonly stopAttestation: StopAttestation | null;
  readonly clockError: ClockError | null;
  readonly journalCommitAt: IsoInstantOrNull;
  readonly history: readonly LifecycleHistoryEntry[];
  readonly hashAlgorithm: 'sha256';
  readonly stateDigest: string;
}

/** The verified journal view. */
export interface LifecycleJournalView {
  readonly entryCount: number;
  readonly events: readonly LifecycleEvent[];
  readonly foreignEntries: readonly string[];
}

/** Diagnosis of one run: what the journal says about the last command. */
export type LifecycleDiagnosis = 'consistent' | 'incomplete' | 'inconsistent';

/** The view every operation returns. */
export interface LifecycleView {
  readonly runId: string;
  readonly manifestId: string;
  readonly manifestDigest: string | null;
  readonly state: LifecycleCommittedState;
  readonly lifecycle: LifecycleStateRecord | null;
  readonly journal: LifecycleJournalView;
  readonly diagnosis?: LifecycleDiagnosis;
  readonly findings?: readonly string[];
  readonly stopAssurance?: 'operator-attested';
  readonly enforced?: false;
}

/**
 * Every request names the container explicitly and by identity. The state root
 * is derived from the accepted C2 record and revalidated; a caller never
 * supplies it.
 */
export interface RunLifecycleRequest {
  /** Absolute path of the run container. */
  readonly runRoot: string;
  /** The manifest identity the caller expects the container to carry. */
  readonly manifestId: string;
  /** The run identity the caller expects the container to carry. */
  readonly runId: string;
  /** Optional expected manifest digest; omit to rely on the two identities. */
  readonly expectedDigest?: string;
  /** Optional clock seam; defaults to the observed wall clock. */
  readonly clock?: LifecycleClock;
  /** Label used in refusals and journaled context. */
  readonly operationName?: string;
}

/** Opened and bound view of one run container. */
export declare function openRun(request: RunLifecycleRequest): Promise<OpenedRun>;

/**
 * The journaled form of an operator stop statement. The witnessed instant is
 * part of the attested fact and is nullable: a stop that attests no instant
 * states `null`, and an entry that omits the claim is a different statement, so
 * the field is required rather than optional.
 */
export interface StopEventDetail {
  readonly operator: string;
  readonly agentStopped: true;
  readonly statement: string;
  readonly observedAt: IsoInstantOrNull;
  readonly assurance: 'operator-attested';
  readonly enforced: false;
}

/**
 * The journaled authority to freeze: the same attested statement a stop carries,
 * plus the route the freeze takes. `clockless` is a required boolean because the
 * route is a statement the entry makes: `false` is the bound route over a
 * journaled stop, `true` is a run frozen without ever starting while no time was
 * observed, and an omitted route states neither.
 */
export interface FreezeIntentEventDetail extends StopEventDetail {
  readonly clockless: boolean;
}

/** The journaled statement that a projection was committed. */
export type CommitEventDetail =
 | {readonly stateEventDigest:string;readonly reconciliation?:never;readonly operator?:never;readonly completedFromIntentDigest?:never}
 | {readonly stateEventDigest:string;readonly reconciliation:true;readonly operator:string;readonly completedFromIntentDigest:string};

/**
 * The narrow append request: no sequence, no predecessor, no identity. The
 * request is discriminated on `kind` so the payload a kind has to carry is
 * visible in the type: an entry whose detail omits the attested instant or the
 * route it authorises is a type error, not a value the module has to choose.
 */
export type JournalAppendRequest =
  | {
    readonly kind: 'START_INTENT';
    readonly occurredAt?: IsoInstantOrNull;
    readonly journalCommitAt?: IsoInstantOrNull;
    readonly declaration: RunDeclaration;
    readonly detail?: undefined;
  }
  | {
    readonly kind: 'STOP_RECORDED';
    readonly occurredAt?: IsoInstantOrNull;
    readonly journalCommitAt?: IsoInstantOrNull;
    readonly declaration?: RunDeclaration;
    readonly detail: StopEventDetail;
  }
  | {
    readonly kind: 'FREEZE_INTENT';
    readonly occurredAt?: IsoInstantOrNull;
    readonly journalCommitAt?: IsoInstantOrNull;
    readonly declaration?: RunDeclaration;
    readonly detail: FreezeIntentEventDetail;
  }
  | {
    readonly kind: 'START_COMMIT';
    readonly occurredAt?: IsoInstantOrNull;
    readonly journalCommitAt?: IsoInstantOrNull;
    readonly declaration?: RunDeclaration;
    readonly detail: CommitEventDetail;
  }
  | {
    readonly kind:'FREEZE_COMMIT';
    readonly occurredAt?:IsoInstantOrNull;
    readonly journalCommitAt?:IsoInstantOrNull;
    readonly declaration?:RunDeclaration;
    readonly detail:{readonly stateEventDigest:string;readonly reconciliation?:never;readonly operator?:never;readonly completedFromIntentDigest?:never};
  };

/** The checked state-commit request. There is no unconditioned state write. */
export interface StateCommitRequest {
  readonly state: LifecycleCommittedState;
  readonly declaration?: RunDeclaration | null;
  readonly startedAt?: IsoInstantOrNull;
  readonly stoppedAt?: IsoInstantOrNull;
  readonly stopAttestation?: StopAttestation | null;
  readonly stopAssurance?: 'operator-attested' | null;
  readonly elapsedMs?: number | null;
  readonly clockError?: ClockError | null;
  readonly journalCommitAt?: IsoInstantOrNull;
  readonly historyEntry?: Record<string, unknown>;
  /** Declares the commit as reconciliation of the state already reported. */
  readonly reconciliation?: true;
}

/**
 * The verified context one whole command runs under. The append and commit
 * seams are the only writes: a command cannot state a sequence, a predecessor
 * digest, an identity, or a state the tables do not permit.
 */
export interface RunTransactionContext {
  readonly manifest: Record<string, unknown>;
  readonly storage: ReadonlyStorage;
  readonly runRoot: string;
  readonly stateRoot: string;
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly manifestId: string;
  readonly lifecycle: LifecycleStateRecord | null;
  readonly clock: LifecycleClock;
  appendEvent(request: JournalAppendRequest): Promise<LifecycleEvent>;
  commitState(request: StateCommitRequest): Promise<LifecycleStateRecord>;
}

/** Run one whole command under the accepted container lock for its full length. */
export declare function withRunTransaction<T>(
  request: RunLifecycleRequest,
  callback: (context: RunTransactionContext) => T | Promise<T>,
): Promise<Awaited<T>>;

/** A start request: the operator-declared facts to capture and bind. */
export interface StartRunRequest extends RunLifecycleRequest {
  readonly declaration: RunDeclaration;
}
/** Capture an immutable declaration and move the run to `RUNNING`. */
export declare function startRun(request: StartRunRequest): Promise<LifecycleView>;

/** A stop request: an operator attestation, never an instruction. */
export interface StopRunRequest extends RunLifecycleRequest {
  readonly attestation: StopAttestation;
}
/**
 * Record an operator-attested stop. A second stop is refused, identical or
 * otherwise, and the attested stop stands.
 */
export declare function stopRun(request: StopRunRequest): Promise<LifecycleView>;

/** Read the state, verified journal and diagnosis. Publishes nothing. */
export declare function readRunLifecycle(request: RunLifecycleRequest): Promise<LifecycleReadView>;

/** The reconciliation request for an interrupted command. */
export interface ReconcileRunRequest extends RunLifecycleRequest {
  readonly interruptedOperation: 'START' | 'STOP';
  readonly disposition: {
    readonly operator: string;
    readonly decision: 'COMPLETE' | 'LEAVE_AS_IS';
    readonly attestation: string;
  };
}
/** Repair an interrupted command explicitly, from bytes the journal holds. */
export declare function reconcileRun(request: ReconcileRunRequest): Promise<ReconcileRunResult>;

/** The freeze gate result a freeze command must consult. */
export interface FreezeGate {
  readonly permitted: boolean;
  readonly requires: 'BOUND_STOP_ATTESTATION' | 'CLOCKLESS_ATTESTATION' | null;
  readonly attestationRequired: boolean;
  readonly clockRequired: boolean;
  readonly reason: string | null;
}
/** The single source of truth for whether a state may be frozen. */
export declare function freezePreconditionFor(state: LifecycleCommittedState): FreezeGate;

/** Recompute a state-record digest from its own bytes. */
export declare function lifecycleStateDigestOf(record: LifecycleStateRecord): string;
/** Recompute a journal-event digest from its own bytes. */
export declare function lifecycleEventDigestOf(event: LifecycleEvent): string;
/** The canonical JSON form every digest in this contract is computed over. */
export declare function lifecycleCanonicalJson(value: unknown): string;

export interface OpenedRun {readonly runRoot:string;readonly stateRoot:string;readonly workspaceRoot:string;readonly runId:string;readonly manifestId:string;readonly manifestDigest:string|null;readonly manifest:RunManifest;readonly operationName:string}
export interface LifecycleReadView extends LifecycleView {readonly diagnosis:LifecycleDiagnosis;readonly findings:readonly string[]}
export interface ReconcileRunResult {readonly runId:string;readonly manifestId:string;readonly diagnosis:LifecycleDiagnosis|'repaired';readonly action:'LEAVE_AS_IS'|'COMPLETE';readonly note:string;readonly findings:readonly string[];readonly state:LifecycleCommittedState;readonly history?:readonly LifecycleHistoryEntry[]}
export interface ReadonlyStorage {readonly root:string;read(request:Readonly<{relativePath:string;kind:string;id:string}>):Promise<unknown>;list?(request?:unknown):Promise<unknown>;inspect?(request?:unknown):Promise<unknown>}
