/**
 * Type declarations for `adapters/manual/index.mjs` (C3 T1).
 *
 * The manual adapter is a thin re-export boundary over the core lifecycle
 * module, so these declarations re-export the core types and values rather than
 * restating them: a type cannot drift out of agreement with the module it
 * describes when there is only one copy of it. The `.d.mts` sibling is a
 * byte-identical copy.
 *
 * The adapter adds exactly one value the core does not carry: the frozen
 * `capabilities` statement of what the manual path cannot do (no halt, no
 * deadline enforcement). It imports no DSH, operating-system or supervisor
 * module, and no call here discovers a run from the environment: every operation
 * still names the container by path and by both identities.
 */

export {
  LIFECYCLE_ERROR_CODES,
  LIFECYCLE_MODULE_ID,
  LIFECYCLE_SCHEMA_VERSION,
  LIFECYCLE_STATE_KIND,
  LIFECYCLE_EVENT_KIND,
  LIFECYCLE_STATE_RELATIVE_PATH,
  LIFECYCLE_JOURNAL_DIRECTORY,
  RUN_MANIFEST_STATE_KEY,
  LIFECYCLE_DERIVED_STATE,
  LIFECYCLE_COMMITTED_STATES,
  LIFECYCLE_EVENT_KINDS,
  FREEZE_PRECONDITIONS,
  LIFECYCLE_TRANSITIONS,
  LIFECYCLE_EXECUTION_MODE,
  STOP_ASSURANCE,
  STOP_ENFORCED,
  LifecycleError,
  DEFAULT_CLOCK,
  readClockReading,
  elapsedBetween,
  openRun,
  withRunTransaction,
  startRun,
  stopRun,
  readRunLifecycle,
  reconcileRun,
  freezePreconditionFor,
  lifecycleStateDigestOf,
  lifecycleEventDigestOf,
  lifecycleCanonicalJson,
} from '../../packages/core/lifecycle.mjs';

export type {
  LifecycleErrorCode,
  LifecycleCommittedState,
  LifecycleEventKind,
  FreezePrecondition,
  LifecycleClock,
  ClockReading,
  IsoInstantOrNull,
  RunDeclaration,
  StopAttestation,
  ClockError,
  LifecycleEvent,
  LifecycleHistoryEntry,
  LifecycleStateRecord,
  LifecycleJournalView,
  LifecycleDiagnosis,
  LifecycleView,
  OpenedRun,
  LifecycleReadView,
  ReconcileRunResult,
  ReadonlyStorage,
  RunLifecycleRequest,
  JournalAppendRequest,
  StateCommitRequest,
  RunTransactionContext,
  StartRunRequest,
  StopRunRequest,
  ReconcileRunRequest,
  FreezeGate,
} from '../../packages/core/lifecycle.mjs';

import type {
  OpenedRun,
  LifecycleReadView,
  ReconcileRunResult,
  LifecycleView,
  LifecycleClock,
  LifecycleEvent,
  LifecycleEventKind,
  LifecycleStateRecord,
  RunDeclaration,
  RunLifecycleRequest,
  StartRunRequest,
  StopAttestation,
  StopRunRequest,
  ReconcileRunRequest,
  RunTransactionContext,
  JournalAppendRequest,
  StateCommitRequest,
  FreezeGate,
  LifecycleCommittedState,
} from '../../packages/core/lifecycle.mjs';

/**
 * What the manual path can and cannot do. The limitations are literal `false`
 * types on purpose: a caller can rely at compile time on there being no halt and
 * no deadline enforcement, and a change that starts claiming them is a visible
 * type change rather than a silent widening.
 */
export interface ManualCapabilities {
  readonly executionMode: 'MANUAL';
  /** The adapter cannot stop an agent; a stop is an operator statement. */
  readonly halt: false;
  /** No timer, no ceiling enforcement, no interruption of a running run. */
  readonly deadlineEnforcement: false;
  readonly stopAssurance: 'operator-attested';
  readonly stopEnforced: false;
  /** An interrupted command is reconciled explicitly, never auto-repaired. */
  readonly automaticRecovery: false;
  /** No signalling, launching, terminating or process enumeration. */
  readonly processControl: false;
  /** No environment or ambient-directory discovery of a run. */
  readonly environmentDiscovery: false;
}
export declare const capabilities: ManualCapabilities;

/**
 * The six operations of the manual path as one frozen record. The individual
 * functions are re-exported above with the core signatures: the adapter widens
 * nothing, adds no default and drops no requirement.
 */
export declare const manualLifecycleOperations: Readonly<{
  readonly openRun: (request: RunLifecycleRequest) => Promise<OpenedRun>;
  readonly withRunTransaction: <T>(request: RunLifecycleRequest, callback: (context: RunTransactionContext) => T | Promise<T>) => Promise<Awaited<T>>;
  readonly startRun: (request: StartRunRequest) => Promise<LifecycleView>;
  readonly stopRun: (request: StopRunRequest) => Promise<LifecycleView>;
  readonly reconcileRun: (request: ReconcileRunRequest) => Promise<ReconcileRunResult>;
  readonly readRunLifecycle: (request: RunLifecycleRequest) => Promise<LifecycleReadView>;
}>;

/** Adapter identity, for a consumer that records what it imported. */
export declare const MANUAL_ADAPTER_MODULE_ID: 'benchboard-adapter-manual-v1';

/* Convenience aliases so a manual consumer can annotate what it passes without
 * importing the core module by path. */
export type ManualRunDeclaration = RunDeclaration;
export type ManualStopAttestation = StopAttestation;
export type ManualLifecycleEvent = LifecycleEvent;
export type ManualLifecycleEventKind = LifecycleEventKind;
export type ManualLifecycleStateRecord = LifecycleStateRecord;
export type ManualLifecycleState = LifecycleCommittedState;
export type ManualJournalAppendRequest = JournalAppendRequest;
export type ManualStateCommitRequest = StateCommitRequest;
export type ManualFreezeGate = FreezeGate;
export type ManualClock = LifecycleClock;
