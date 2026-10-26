/**
 * The harness-neutral manual adapter index (C3 T1).
 *
 * This is a thin re-export boundary, not a second implementation. It exists so a
 * manual operator (and any later manual command surface) can import the run
 * lifecycle from one stable path without importing `packages/core/*` directly,
 * and so the manual path can state plainly what it can and cannot do.
 *
 * What it adds over the core module: nothing but the capability statement and
 * the operations record. What it deliberately does not do:
 *   - it imports no DSH, Agent Teams, supervisor or process-control module;
 *   - it launches nothing, signals nothing, halts nothing and waits for nothing;
 *   - it enforces no deadline and no ceiling: a declared ceiling is a recorded
 *     operator statement, never a timer;
 *   - it reads no environment variable, configuration file or ambient directory
 *     to decide which run to open: every call still names the container
 *     explicitly by path and by both identities.
 *
 * A stop through this adapter is exactly the core stop: an operator attestation
 * returned with `stopAssurance: 'operator-attested'` and `enforced: false`. The
 * operations record holds the same function objects the core exports, so a
 * caller cannot obtain a laxer path through this boundary. Node builtins only;
 * no DSH dependency.
 */

export * from '../../packages/core/lifecycle.mjs';

import * as lifecycle from '../../packages/core/lifecycle.mjs';

/**
 * The honest capability statement of the manual path. Every value here is a
 * limitation the caller must design around, not a feature to be enabled later by
 * a flag in this file.
 *
 * - `halt: false` — the adapter cannot stop an agent. `stopRun` records that an
 *   operator states the agent stopped; it performs no action on any process.
 * - `deadlineEnforcement: false` — nothing here observes a clock to interrupt a
 *   run. The clock is read once per operation to date a record.
 * - `executionMode: 'MANUAL'` — the only mode this release records.
 * - `stopAssurance: 'operator-attested'` and `stopEnforced: false` — the exact
 *   values the core returns on a recorded stop.
 * - `automaticRecovery: false` — an interrupted command stays interrupted until
 *   an operator reconciles it explicitly and by name.
 * - `no DSH dependency` is asserted structurally by the source scan in the
 *   focused lifecycle test, not by this field.
 */
export const capabilities = Object.freeze({
  executionMode: 'MANUAL',
  halt: false,
  deadlineEnforcement: false,
  stopAssurance: 'operator-attested',
  stopEnforced: false,
  automaticRecovery: false,
  processControl: false,
  environmentDiscovery: false,
});

/**
 * The six operations of the manual path as one record. The values are the core
 * function objects themselves, taken through the namespace, so this record
 * cannot become a second, divergent copy of the surface.
 */
export const manualLifecycleOperations = Object.freeze({
  openRun: lifecycle.openRun,
  withRunTransaction: lifecycle.withRunTransaction,
  startRun: lifecycle.startRun,
  stopRun: lifecycle.stopRun,
  reconcileRun: lifecycle.reconcileRun,
  readRunLifecycle: lifecycle.readRunLifecycle,
});

/** The adapter identity, for a consumer that wants to record what it imported. */
export const MANUAL_ADAPTER_MODULE_ID = 'benchboard-adapter-manual-v1';
