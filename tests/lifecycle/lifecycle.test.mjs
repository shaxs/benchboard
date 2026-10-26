/* BenchBoard manual lifecycle — focused tests for the C3 T1 core.
 *
 * Contract: the approved C3 execution plan, T1 (manual lifecycle, immutable
 * declaration, recovery journal). The contract is named by chunk and task and
 * not by a private planning path, because this file is distributed with the
 * product and must not point at owner-only material.
 *
 * What this suite is for. The lifecycle module is the seam between the accepted
 * C2 storage/manifest/initialisation surface and the human operator, so the
 * load-bearing assertions here are about the seam: which roots and identities a
 * caller must state, what the read-back of the sealed manifest rejects, which
 * state moves exist, what an interrupted start looks like, what a clock that
 * lies causes, and what an attested stop does not do.
 *
 * The containers are built through the accepted storage publication path with
 * the accepted contract fixture identities. That is the same key and the same
 * record kind the accepted initialiser publishes, so the read-back under test is
 * a real C2 read-back and not a fixture of this suite's own invention.
 *
 * Containment: scratch comes from BENCHBOARD_TEST_TMP or
 * BENCHBOARD_TEST_SCRATCH_ROOT when either names an absolute directory,
 * otherwise from a directory inside this repository. The read-only starter tree
 * is refused as scratch, no operating-system temporary directory is used, and no
 * sibling directory is entered.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  LifecycleError,
  LIFECYCLE_ERROR_CODES,
  LIFECYCLE_STATE_KIND,
  LIFECYCLE_EVENT_KIND,
  LIFECYCLE_STATE_RELATIVE_PATH,
  LIFECYCLE_JOURNAL_DIRECTORY,
  LIFECYCLE_DERIVED_STATE,
  DEFAULT_CLOCK,
  STOP_ASSURANCE,
  STOP_ENFORCED,
  FREEZE_PRECONDITIONS,
  openRun,
  withRunTransaction,
  startRun,
  stopRun,
  reconcileRun,
  readRunLifecycle,
  readClockReading,
  elapsedBetween,
  freezePreconditionFor,
  lifecycleStateDigestOf,
  lifecycleEventDigestOf,
} from '../../packages/core/lifecycle.mjs';
import { createStorage } from '../../packages/core/storage.mjs';
import { createRunManifest } from '../../packages/core/manifest.mjs';
import {
  INIT_STATE_KIND,
  STATE_DIRECTORY_NAME,
  WORKSPACE_DIRECTORY_NAME,
  RUN_STATE_RELATIVE_PATH,
} from '../../packages/core/init.mjs';
import { loadFixture } from '../contracts/fixtures/contracts/index.mjs';

/* ----------------------------------------------------------------- constants */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STARTER_ROOT = path.join(REPO_ROOT, 'starter');
const HEX64 = /^[0-9a-f]{64}$/;

/** Scratch root: an explicit absolute override, else a contained directory. */
function scratchRoot() {
  const names = ['BENCH' + 'BOARD_TEST_TMP', 'BENCH' + 'BOARD_TEST_SCRATCH_ROOT'];
  for (const name of names) {
    const value = process.env[name];
    if (value === void 0 || value.length === 0) continue;
    if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute directory, got ${JSON.stringify(value)}`);
    fs.mkdirSync(value, { recursive: true });
    const resolved = path.resolve(value);
    const starter = path.resolve(STARTER_ROOT);
    if (starter === resolved || starter.startsWith(resolved + path.sep)) {
      throw new Error(`${name} must not contain the read-only starter tree at ${starter}`);
    }
    return resolved;
  }
  const contained = fileURLToPath(new URL('./.tmp/lifecycle/', import.meta.url));
  fs.mkdirSync(contained, { recursive: true });
  return contained;
}

/** One throwaway directory per test, removed when that test finishes. */
function scratch(t, name) {
  const directory = fs.mkdtempSync(path.join(scratchRoot(), `c3-t1-${name}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/* ------------------------------------------------------------------- fixtures */

/** One sealed manual RunManifest over the accepted contract fixtures. */
function sealedManifest({ runRoot, manifestId, runId, ceilingMinutes = 45, model = null, harness = 'manual', workspaceRoot = path.join(runRoot, WORKSPACE_DIRECTORY_NAME) }) {
  return createRunManifest({
    manifestId,
    runId,
    createdAt: '2026-04-01T09:00:00.000Z',
    architectureId: 'arch-run-seam',
    harness,
    declaredCeilingMinutes: ceilingMinutes,
    configuration: { harness, model },
    participantWorkspaceRoot: workspaceRoot,
    evidenceRoot: path.join(runRoot, STATE_DIRECTORY_NAME),
    toolingIdentity: loadFixture('tooling.identity'),
    challengeIdentity: loadFixture('challenge.identity'),
    evaluatorIdentity: loadFixture('evaluator.identity'),
  });
}

/**
 * Build one real run container: an ordinary workspace directory, an ordinary
 * state directory, and the sealed manifest published under the accepted C2 key
 * `{relativePath:'state/run.json', kind:'benchboard:run-initialisation'}`.
 */
async function buildContainer(t, name, options = {}) {
  const root = scratch(t, name);
  const runRoot = path.join(root, 'container');
  const stateRoot = path.join(runRoot, STATE_DIRECTORY_NAME);
  fs.mkdirSync(path.join(runRoot, WORKSPACE_DIRECTORY_NAME), { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  const manifestId = options.manifestId ?? `manifest-${name}-001`;
  const runId = options.runId ?? `run-${name}-001`;
  const manifest = options.manifest ?? sealedManifest({ runRoot, manifestId, runId, ...options.manifestOptions });
  const storage = createStorage({ root: stateRoot });
  await storage.withLock(() => storage.createImmutable({
    relativePath: RUN_STATE_RELATIVE_PATH,
    kind: INIT_STATE_KIND,
    id: manifestId,
    value: manifest,
  }));
  return {
    root,
    runRoot,
    stateRoot,
    manifestId,
    runId,
    manifest,
    request: Object.freeze({ runRoot, manifestId, runId }),
  };
}

/** The declaration a manual run states, with overrides applied key by key. */
function declaration(overrides = {}) {
  return {
    harness: 'manual',
    model: null,
    workerCount: 2,
    executionMode: 'MANUAL',
    declaredCeilingMinutes: 45,
    ...overrides,
  };
}

/** The attestation a stop requires, with overrides applied key by key. */
function attestation(overrides = {}) {
  return {
    operator: 'operator-one',
    agentStopped: true,
    statement: 'the cooperating participants stopped of their own cooperation',
    ...overrides,
  };
}

/** A deterministic clock; `null` states that the wall clock is unknown. */
function clockAt(value) {
  return { now: () => value };
}

/**
 * The journaled authority a freeze needs, stated once so a fixture cannot
 * accidentally test a freeze that was never authorised.
 *
 * A freeze is journaled as a FREEZE_INTENT before its projection is committed,
 * which is what makes an interrupted freeze visible and what makes a frozen
 * projection the record of an authorised operation rather than an assertion. The
 * production freeze route does exactly this. These fixtures drive the state seam
 * directly, so the intent is appended here first: the detail is the journaled
 * form of the very attestation the commit binds, with the route stated as the
 * boolean the wire contract requires — `true` on the clockless route and `false`
 * on the bound route, never omitted.
 */
async function journalFreezeIntent(context, attestationValue) {
  const detail = {
    operator: attestationValue.operator,
    agentStopped: true,
    statement: attestationValue.statement,
    observedAt: attestationValue.observedAt ?? null,
    assurance: STOP_ASSURANCE,
    enforced: false,
    clockless: attestationValue.clockless === true,
  };
  return context.appendEvent({ kind: 'FREEZE_INTENT', occurredAt: null, journalCommitAt: null, detail });
}

/**
 * Freeze a run the way the freeze route does, from inside one transaction.
 *
 * The journaled intent comes first, then the projection commit the intent
 * authorises, then the journaled commit that binds that projection by digest. The
 * three together are what make a frozen run a complete operation: the intent is
 * the authority, the projection is the view, and the commit is the statement that
 * binds the two, so a run with any one of them missing is an interrupted
 * operation rather than a closed run.
 */
async function commitFreeze(context, attestationValue) {
  await journalFreezeIntent(context, attestationValue);
  const record = await context.commitState({ state: 'FROZEN', stopAttestation: structuredClone(attestationValue) });
  await context.appendEvent({ kind: 'FREEZE_COMMIT', occurredAt: null, journalCommitAt: null, detail: { stateEventDigest: record.stateDigest } });
  return record;
}

/** Capture a rejection, or undefined when the promise resolves. */
async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return void 0;
}

/** Assert one fail-closed refusal carrying the expected code, spelled first. */
async function expectCode(promise, code, label) {
  const error = await rejection(promise);
  assert.ok(error !== void 0, `${label}: a rejection was expected`);
  assert.ok(error instanceof LifecycleError, `${label}: a LifecycleError was expected, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, `${label}: error code (${error.message})`);
  assert.match(error.message, new RegExp(`^${code}: `), `${label}: the message names the code first`);
  return error;
}

/** A journal entry the module would have produced, written by a test. */
async function writeInterruptedStart(container, { declarationValue }) {
  return withRunTransaction(container.request, async (context) => {
    const intent = await context.appendEvent({ kind: 'START_INTENT', declaration: declarationValue, occurredAt: null, journalCommitAt: null });
    await context.commitState({ state: 'RUNNING', declaration: declarationValue, startedAt: null, historyEntry: { operation: 'START' } });
    /* The command is "interrupted" here: the START_COMMIT event is never
     * appended, which is exactly the state a killed process leaves behind. */
    return intent;
  });
}

/* ========================================================================== */
/* Explicit root plus expected identities, and the C2 read-back                */
/* ========================================================================== */

test('openRun opens by explicit runRoot plus expected IDs and reads the C2 value back', async (t) => {
  const container = await buildContainer(t, 'open-basic');
  const opened = await openRun(container.request);
  assert.equal(opened.runId, container.runId, 'the runId is the expected one');
  assert.equal(opened.manifestId, container.manifestId, 'the manifestId is the expected one');
  assert.equal(opened.stateRoot, container.stateRoot, 'the state root is the container state directory');
  assert.equal(opened.workspaceRoot, path.join(container.runRoot, WORKSPACE_DIRECTORY_NAME), 'the workspace root comes from the sealed manifest');
  assert.equal(opened.manifest.kind, 'RunManifest', 'the read-back returns the record value, not an envelope');
  assert.equal(opened.manifest.manifestId, container.manifestId, 'the read-back manifest identity matches');
  assert.match(opened.manifestDigest, HEX64, 'the sealed manifest digest is reported');
});

test('openRun requires an absolute runRoot and every expected identity', async (t) => {
  const container = await buildContainer(t, 'open-args');
  await expectCode(openRun({ ...container.request, runRoot: 'container' }), LIFECYCLE_ERROR_CODES.INVALID_ROOT, 'a relative runRoot');
  await expectCode(openRun({ ...container.request, runRoot: 42 }), LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'a numeric runRoot');
  await expectCode(openRun({ runRoot: container.runRoot, runId: container.runId }), LIFECYCLE_ERROR_CODES.FIELD_REQUIRED, 'a missing manifestId');
  await expectCode(openRun({ runRoot: container.runRoot, manifestId: container.manifestId }), LIFECYCLE_ERROR_CODES.FIELD_REQUIRED, 'a missing runId');
  await expectCode(openRun({ ...container.request, expectedDigest: 'nope' }), LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'a malformed expectedDigest');
  await expectCode(openRun({}), LIFECYCLE_ERROR_CODES.FIELD_REQUIRED, 'an empty request');
});

test('openRun rejects a wrong expected identity or digest before any write', async (t) => {
  const container = await buildContainer(t, 'open-identity');
  await expectCode(openRun({ ...container.request, manifestId: 'manifest-other-001' }), LIFECYCLE_ERROR_CODES.NOT_FOUND, 'an unknown manifestId');
  await expectCode(openRun({ ...container.request, runId: 'run-somebody-else' }), LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, 'a runId the manifest does not bind');
  await expectCode(openRun({ ...container.request, expectedDigest: 'f'.repeat(64) }), LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, 'an expectedDigest the manifest does not carry');
  const state = path.join(container.stateRoot, LIFECYCLE_STATE_RELATIVE_PATH);
  assert.equal(fs.existsSync(state), false, 'a refused open leaves no lifecycle state behind');
});

test('openRun rejects a container whose state directory is missing or aliased', async (t) => {
  const container = await buildContainer(t, 'open-links');
  fs.rmSync(container.stateRoot, { recursive: true, force: true });
  await expectCode(openRun(container.request), LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, 'a container without its state directory');

  const other = await buildContainer(t, 'open-links-b');
  fs.rmSync(other.stateRoot, { recursive: true, force: true });
  /* Point the state slot at a container that really exists: the sealed
   * manifest read back from there names a different root, so the substitution
   * is refused rather than trusted. */
  fs.symlinkSync(container.stateRoot, other.stateRoot, 'junction');
  await expectCode(openRun(other.request), LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, 'a state directory that is not an ordinary directory of this container');
});

test('openRun rejects a manifest whose bound roots do not match the container', async (t) => {
  /* A sealed manifest that binds its participant workspace outside the run root
   * it sits in is the copied-or-renamed container case: the record identity and
   * digest read back cleanly, so the refusal must come from the root pairing. */
  const root = scratch(t, 'open-roots');
  const runRoot = path.join(root, 'container');
  const stateRoot = path.join(runRoot, STATE_DIRECTORY_NAME);
  fs.mkdirSync(stateRoot, { recursive: true });
  const manifestId = 'manifest-stray-workspace-001';
  const runId = 'run-stray-workspace-001';
  const stray = sealedManifest({
    runRoot,
    manifestId,
    runId,
    workspaceRoot: path.join(root, 'elsewhere', WORKSPACE_DIRECTORY_NAME),
  });
  const storage = createStorage({ root: stateRoot });
  await storage.withLock(() => storage.createImmutable({
    relativePath: RUN_STATE_RELATIVE_PATH,
    kind: INIT_STATE_KIND,
    id: manifestId,
    value: stray,
  }));
  await expectCode(
    openRun({ runRoot, manifestId, runId }),
    LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH,
    'a workspace root the container does not carry',
  );
});

/* ========================================================================== */
/* The clock seam: default observed clock, equal readings, honest unknown      */
/* ========================================================================== */

test('the default clock reports the observed wall clock and never a guess', () => {
  const before = Date.now();
  const reading = readClockReading(DEFAULT_CLOCK, null);
  const after = Date.now();
  assert.equal(reading.ok, true, 'the observed wall clock reads cleanly');
  assert.ok(reading.ms >= before && reading.ms <= after, 'the default reading is the current wall clock');
  assert.equal(readClockReading(void 0, null).ms, null, 'an absent clock is unknown, not zero');
  assert.equal(readClockReading(clockAt(null), null).ms, null, 'a clock that reports nothing is unknown, not zero');
});

test('a clock that lies is retained as an error and elapsed is unavailable', () => {
  const reversal = readClockReading(clockAt(1000), 2000);
  assert.equal(reversal.ok, false, 'a reading below the last recorded instant is a reversal');
  assert.equal(reversal.code, LIFECYCLE_ERROR_CODES.CLOCK_INVALID, 'the reversal is reported as a broken instrument');
  assert.match(reversal.error, /clamped/i, 'the refusal says nothing is clamped forward');
  assert.equal(readClockReading(clockAt(0), null).ok, true, 'a zero reading is a legitimate epoch value, not an error');
  assert.equal(readClockReading(clockAt(1000), 1000).ok, true, 'an equal reading is valid: time standing still is not going backwards');
  assert.equal(readClockReading(clockAt(Number.NaN), null).code, LIFECYCLE_ERROR_CODES.CLOCK_INVALID, 'a non-finite reading is an error');
  assert.equal(readClockReading({ now: () => { throw new Error('device gone'); } }, null).code, LIFECYCLE_ERROR_CODES.CLOCK_INVALID, 'a clock that throws is an error');
  assert.equal(readClockReading({ notNow: true }, null).code, LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'a clock must be a now() object');
  assert.equal(elapsedBetween('2026-04-01T09:00:00.000Z', '2026-04-01T09:00:00.000Z'), 0, 'a legitimate elapsed of zero is zero');
  assert.equal(elapsedBetween(null, '2026-04-01T09:00:00.000Z'), null, 'an unknown endpoint yields no elapsed');
  assert.equal(elapsedBetween('2026-04-01T09:00:01.000Z', '2026-04-01T09:00:00.000Z'), null, 'a backwards pair yields no elapsed rather than a clamped one');
});

test('start and stop with equal clock readings record a legitimate elapsed of zero', async (t) => {
  const container = await buildContainer(t, 'clock-zero');
  const fixed = 1777000000000;
  const started = await startRun({ ...container.request, clock: clockAt(fixed), declaration: declaration() });
  assert.equal(started.lifecycle.startedAt, new Date(fixed).toISOString(), 'the start records the injected instant');
  const stopped = await stopRun({ ...container.request, clock: clockAt(fixed), attestation: attestation() });
  assert.equal(stopped.state, 'STOP_RECORDED', 'the stop is recorded');
  assert.equal(stopped.lifecycle.elapsedMs, 0, 'equal readings measure a zero elapsed, not a null and not an error');
  assert.equal(stopped.lifecycle.clockError, null, 'nothing is flagged when the clock merely stands still');
});

test('a reversed clock is retained on the record and elapsed stays unavailable', async (t) => {
  const container = await buildContainer(t, 'clock-reversal');
  const started = await startRun({ ...container.request, clock: clockAt(1777000005000), declaration: declaration() });
  assert.ok(started.lifecycle.startedAt !== null, 'the start carries an instant');
  const stopped = await stopRun({ ...container.request, clock: clockAt(1777000000000), attestation: attestation() });
  assert.equal(stopped.state, 'STOP_RECORDED', 'the attested stop is still recorded: the operator statement is not the clock');
  assert.equal(stopped.lifecycle.elapsedMs, null, 'elapsed is unavailable rather than invented or clamped');
  assert.ok(stopped.lifecycle.clockError !== null, 'the clock error is retained on the record');
  assert.match(stopped.lifecycle.clockError.error, /reversed|discontinu/i, 'the retained error names the reversal');
  assert.equal(stopped.lifecycle.clockError.elapsedAvailable, false, 'the record states plainly that elapsed is not available');
});

test('an unknown clock leaves the timestamps null, never zero', async (t) => {
  const container = await buildContainer(t, 'clock-unknown');
  const started = await startRun({ ...container.request, clock: clockAt(null), declaration: declaration() });
  assert.equal(started.state, 'RUNNING', 'a start is still a start when no time was observed');
  assert.equal(started.lifecycle.startedAt, null, 'an unknown start instant stays null');
  assert.equal(started.lifecycle.elapsedMs, null, 'no elapsed is derived from an unknown instant');
});

/* ========================================================================== */
/* The state machine: valid moves, refused moves, freeze preconditions         */
/* ========================================================================== */

test('the derived INITIALIZED state precedes any record and reports no findings', async (t) => {
  const container = await buildContainer(t, 'state-derived');
  const view = await readRunLifecycle(container.request);
  assert.equal(view.state, LIFECYCLE_DERIVED_STATE, 'a container with no record reports the derived state');
  assert.equal(view.lifecycle, null, 'there is no record to report');
  assert.equal(view.diagnosis, 'consistent', 'nothing is interrupted');
  assert.deepEqual([...view.findings], [], 'a pristine journal carries no findings');
  assert.equal(view.journal.entryCount, 0, 'the journal is empty');
});

test('start records an immutable declaration bound to the accepted manifest', async (t) => {
  const container = await buildContainer(t, 'start-declaration');
  const started = await startRun({ ...container.request, declaration: declaration({ workerCount: 3 }) });
  assert.equal(started.state, 'RUNNING', 'a valid start moves the run to RUNNING');
  assert.deepEqual([...started.journal.events.map((event) => event.kind)], ['START_INTENT', 'START_COMMIT'], 'the intent is journaled before the commit');
  assert.deepEqual(structuredClone(started.lifecycle.declaration), declaration({ workerCount: 3 }), 'the declaration is recorded as stated');
  assert.equal(started.lifecycle.declaration.executionMode, 'MANUAL', 'the execution mode is the one this release records');
  await expectCode(
    startRun({ ...container.request, declaration: declaration({ workerCount: 4 }) }),
    LIFECYCLE_ERROR_CODES.DECLARATION_ALREADY_BOUND,
    'a different declaration after a committed start is refused',
  );
  await expectCode(
    startRun({ ...container.request, declaration: declaration({ workerCount: 3 }) }),
    LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED,
    'a repeat start of the same declaration is refused because the run is already started',
  );
  const after = await readRunLifecycle(container.request);
  assert.deepEqual(structuredClone(after.lifecycle.declaration), declaration({ workerCount: 3 }), 'the refused start left the captured declaration untouched');
});

test('a declaration that conflicts with the accepted manifest or schema is refused', async (t) => {
  const container = await buildContainer(t, 'start-decl-invalid');
  await expectCode(startRun({ ...container.request, declaration: declaration({ declaredCeilingMinutes: 46 }) }), LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, 'a ceiling the manifest does not state');
  await expectCode(startRun({ ...container.request, declaration: declaration({ harness: 'auto' }) }), LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, 'a harness the manifest does not bind');
  await expectCode(startRun({ ...container.request, declaration: declaration({ executionMode: 'AUTOMATED' }) }), LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, 'an execution mode this release does not have');
  await expectCode(startRun({ ...container.request, declaration: declaration({ workerCount: 0 }) }), LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, 'a worker count of zero');
  await expectCode(startRun({ ...container.request, declaration: declaration({ workerCount: 1.5 }) }), LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, 'a worker count that is not an integer');
  await expectCode(startRun({ ...container.request, declaration: declaration({ declaredCeilingMinutes: 1441 }) }), LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, 'a ceiling outside the contract range');
  await expectCode(startRun({ ...container.request, declaration: { ...declaration(), extra: true } }), LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, 'an undeclared declaration field');
  await expectCode(startRun(container.request), LIFECYCLE_ERROR_CODES.FIELD_REQUIRED, 'a start with no declaration at all');
  const after = await readRunLifecycle(container.request);
  assert.equal(after.state, LIFECYCLE_DERIVED_STATE, 'every refused start left the run untouched');
  assert.equal(after.journal.entryCount, 0, 'no refused start journaled anything');

  /* The manifest leaves the model unknown, so the operator statement is the
   * only source and is accepted; where the manifest does name a model, a
   * declaration naming another one is the conflict that gets refused. */
  const unknownModel = await buildContainer(t, 'start-decl-model-unknown');
  const stated = await startRun({ ...unknownModel.request, declaration: declaration({ model: 'gpt-5.1-sol' }) });
  assert.equal(stated.lifecycle.declaration.model, 'gpt-5.1-sol', 'a model the manifest leaves unknown may be declared by the operator');

  const knownModel = await buildContainer(t, 'start-decl-model-known', {
    manifestOptions: { model: 'gpt-5.1-sol' },
  });
  await expectCode(startRun({ ...knownModel.request, declaration: declaration({ model: 'claude-5-opus' }) }), LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, 'a model the accepted manifest contradicts');
  const agreed = await startRun({ ...knownModel.request, declaration: declaration({ model: 'gpt-5.1-sol' }) });
  assert.equal(agreed.lifecycle.declaration.model, 'gpt-5.1-sol', 'a declaration that agrees with the manifest binds');
});

test('a stop requires an operator attestation and records assurance without enforcement', async (t) => {
  const container = await buildContainer(t, 'stop-attestation');
  await startRun({ ...container.request, declaration: declaration() });
  const stopped = await stopRun({ ...container.request, attestation: attestation() });
  assert.equal(stopped.state, 'STOP_RECORDED', 'an attested stop moves the run to STOP_RECORDED');
  assert.equal(stopped.stopAssurance, STOP_ASSURANCE, 'the assurance is the operator attestation');
  assert.equal(stopped.enforced, STOP_ENFORCED, 'nothing is enforced by recording a stop');
  assert.equal(stopped.lifecycle.stopAssurance, STOP_ASSURANCE, 'the record carries the assurance');
  assert.deepEqual(structuredClone(stopped.lifecycle.stopAttestation), { ...attestation(), observedAt: null }, 'the attestation is stored as stated, with an unstated observation instant left unknown');
  const kinds = stopped.journal.events.map((event) => event.kind);
  assert.deepEqual([...kinds], ['START_INTENT', 'START_COMMIT', 'STOP_RECORDED'], 'the stop is journaled');
});

test('an attestation that is not an operator statement is refused', async (t) => {
  const container = await buildContainer(t, 'stop-invalid');
  await startRun({ ...container.request, declaration: declaration() });
  await expectCode(stopRun({ ...container.request, attestation: attestation({ agentStopped: false }) }), LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'an attestation that does not assert the agents stopped');
  await expectCode(stopRun({ ...container.request, attestation: attestation({ agentStopped: 'yes' }) }), LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'a non-boolean stop assertion');
  await expectCode(stopRun({ ...container.request, attestation: attestation({ operator: 'x' }) }), LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'an operator name too short to attribute');
  await expectCode(stopRun({ ...container.request, attestation: attestation({ signal: 'SIGTERM' }) }), LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'an attestation carrying an instruction field');
  await expectCode(stopRun(container.request), LIFECYCLE_ERROR_CODES.FIELD_REQUIRED, 'a stop with no attestation');
  const after = await readRunLifecycle(container.request);
  assert.equal(after.state, 'RUNNING', 'a refused stop leaves the run running');
  assert.equal(after.journal.entryCount, 2, 'a refused stop journaled nothing');
});

test('a second stop is refused even when it repeats the attestation exactly', async (t) => {
  const container = await buildContainer(t, 'stop-repeat');
  await startRun({ ...container.request, declaration: declaration() });
  const first = await stopRun({ ...container.request, attestation: attestation() });

  /* A stop is one operator observation of one event. A run already
   * STOP_RECORDED has no second stop to record, and accepting an identical
   * restatement would let a repeat pass for a fresh observation. */
  const before = await readRunLifecycle(container.request);
  const attempted = await rejection(stopRun({ ...container.request, attestation: attestation() }));
  assert.ok(attempted instanceof LifecycleError, 'the identical repeat is refused');
  assert.equal(attempted.code, LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, `a repeat stop is an invalid transition (${attempted.message})`);
  await expectCode(stopRun({ ...container.request, attestation: attestation({ statement: 'a different statement about the same run' }) }), LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a second, different attestation');

  const after = await readRunLifecycle(container.request);
  assert.equal(after.journal.entryCount, before.journal.entryCount, 'a refused repeat journaled nothing');
  assert.deepEqual(structuredClone(after.lifecycle.stopAttestation), structuredClone(before.lifecycle.stopAttestation), 'the attested stop stands unchanged');
  assert.deepEqual(structuredClone(after.lifecycle), structuredClone(before.lifecycle), 'a refused repeat rewrote no state');
  assert.equal(after.state, 'STOP_RECORDED', 'the run still reports the single attested stop');
  assert.equal(first.state, 'STOP_RECORDED', 'the first stop was recorded');
});

test('a stop needs a started run and a frozen run is closed', async (t) => {
  const container = await buildContainer(t, 'stop-closed');
  await expectCode(stopRun({ ...container.request, attestation: attestation() }), LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a stop on a run that never started');
  await startRun({ ...container.request, declaration: declaration() });
  await stopRun({ ...container.request, attestation: attestation() });
  await withRunTransaction(container.request, async (context) => commitFreeze(context, attestation()));
  await expectCode(stopRun({ ...container.request, attestation: attestation({ statement: 'a later observation after the freeze happened' }) }), LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a stop after the freeze');
});

test('the freeze gate has no route from a running run', async (t) => {
  const container = await buildContainer(t, 'freeze-gate');
  await startRun({ ...container.request, declaration: declaration() });

  const gate = freezePreconditionFor('RUNNING');
  assert.equal(gate.permitted, false, 'a running run has no freeze precondition');
  assert.match(gate.reason, /may not be frozen/, 'the gate states the reason');
  assert.equal(FREEZE_PRECONDITIONS.RUNNING, void 0, 'the table carries no RUNNING entry at all');

  await expectCode(
    withRunTransaction(container.request, async (context) => context.commitState({ state: 'FROZEN', stopAttestation: attestation() })),
    LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED,
    'a freeze through the command seam while the run is active',
  );
  const after = await readRunLifecycle(container.request);
  assert.equal(after.state, 'RUNNING', 'the refused freeze left the run running');
  assert.equal(after.journal.entryCount, 2, 'a refused freeze journaled nothing');

  const unknown = freezePreconditionFor('STOP_RECORDED');
  assert.equal(unknown.permitted, true, 'a stopped run may be frozen');
  assert.equal(unknown.requires, 'BOUND_STOP_ATTESTATION', 'it needs the bound stop attestation');
  assert.equal(unknown.attestationRequired, true, 'the attestation is the justification for the freeze');
  assert.equal(unknown.clockRequired, false, 'a clock reading is not the justification: an honestly unknown time must not block a bound freeze');
  const clockless = freezePreconditionFor(LIFECYCLE_DERIVED_STATE === 'INITIALIZED' ? 'INITIALIZED' : 'INITIALIZED');
  assert.equal(clockless.requires, 'CLOCKLESS_ATTESTATION', 'an unstarted run may be frozen only clocklessly');
  assert.equal(clockless.attestationRequired, true, 'the clockless statement is the justification');
  assert.equal(clockless.clockRequired, false, 'a clockless freeze by definition has no clock');
});

test('a freeze after an honestly unavailable clock binds the attestation, not a time', async (t) => {
  /* The operator statement is what authorises a freeze. When the clock reported
   * nothing usable, the recorded stop instant is null and the freeze carries
   * that null forward: this contract never invents, clamps or substitutes a
   * timestamp to satisfy its own gate. */
  const container = await buildContainer(t, 'freeze-unknown-clock');
  await startRun({ ...container.request, clock: clockAt(null), declaration: declaration() });
  const record = await stopRun({ ...container.request, clock: clockAt(null), attestation: attestation() });
  assert.equal(record.state, 'STOP_RECORDED', 'an unknown clock does not prevent an attested stop');
  assert.equal(record.lifecycle.stoppedAt, null, 'no stop instant is available');

  /* The journal is the authority for the freeze, so this fixture journals the
   * intent and commits it the way the freeze route does. */
  const frozen = await withRunTransaction(container.request, async (context) => commitFreeze(context, record.lifecycle.stopAttestation));
  assert.equal(frozen.state, 'FROZEN', 'the bound attestation authorises the freeze with no time available');
  assert.equal(frozen.stoppedAt, null, 'the freeze carries the unknown stop instant forward as null');
  assert.equal(frozen.elapsedMs, null, 'no elapsed is fabricated for the frozen run');
  const after = await readRunLifecycle(container.request);
  assert.equal(after.diagnosis, 'consistent', 'a freeze with its journaled intent and commit is the complete operation it reports');
});

test('a freeze binds the recorded stop attestation or states clockless explicitly', async (t) => {
  const stopped = await buildContainer(t, 'freeze-bound');
  await startRun({ ...stopped.request, declaration: declaration() });
  const record = await stopRun({ ...stopped.request, attestation: attestation() });
  await expectCode(
    withRunTransaction(stopped.request, async (context) => context.commitState({ state: 'FROZEN', stopAttestation: attestation({ statement: 'an attestation that was never recorded' }) })),
    LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID,
    'a freeze claiming an attestation the run does not carry',
  );
  /* The precondition is checked against the run's own attestation before the
   * journal is consulted, so an unbound attestation is refused on that ground. */
  await expectCode(
    withRunTransaction(stopped.request, async (context) => context.commitState({ state: 'FROZEN', stopAttestation: structuredClone(record.lifecycle.stopAttestation) })),
    LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,
    'a bound freeze that no journaled freeze intent authorised',
  );
  const frozen = await withRunTransaction(stopped.request, async (context) => commitFreeze(context, record.lifecycle.stopAttestation));
  assert.equal(frozen.state, 'FROZEN', 'the bound attestation authorises the freeze once its intent is journaled');

  const unstarted = await buildContainer(t, 'freeze-clockless');
  await expectCode(
    withRunTransaction(unstarted.request, async (context) => context.commitState({ state: 'FROZEN', stopAttestation: attestation() })),
    LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID,
    'a freeze from INITIALIZED without the clockless statement',
  );
  await expectCode(
    withRunTransaction(unstarted.request, async (context) => context.commitState({ state: 'FROZEN', stopAttestation: { ...attestation(), clockless: true } })),
    LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,
    'a clockless freeze that no journaled clockless intent authorised',
  );
  const clockless = await withRunTransaction(unstarted.request, async (context) => commitFreeze(context, { ...attestation(), clockless: true }));
  assert.equal(clockless.state, 'FROZEN', 'the explicit clockless attestation authorises the freeze');
  assert.equal(clockless.stoppedAt, null, 'a clockless freeze records no stop instant');
});

test('a freeze without its journaled intent is refused and leaves the run untouched', async (t) => {
  /* This is the fabrication the contract exists to prevent: a projection that
   * states a closed, submitted run while the authority carries no freeze intent
   * behind it. It is refused on both routes, and nothing is written on the way
   * out — a refusal that half-freezes a run would be worse than the fabrication
   * it refuses. */
  const stopped = await buildContainer(t, 'freeze-fabricated-stopped');
  await startRun({ ...stopped.request, declaration: declaration() });
  const record = await stopRun({ ...stopped.request, attestation: attestation() });
  const beforeStopped = await readRunLifecycle(stopped.request);
  const stoppedError = await expectCode(
    withRunTransaction(stopped.request, async (context) => context.commitState({ state: 'FROZEN', stopAttestation: structuredClone(record.lifecycle.stopAttestation) })),
    LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,
    'a bound freeze with no journaled intent behind it',
  );
  assert.match(stoppedError.message, /FREEZE_INTENT/, 'the refusal names the authority event it is missing');
  const afterStopped = await readRunLifecycle(stopped.request);
  assert.equal(afterStopped.state, 'STOP_RECORDED', 'the refused freeze left the run stopped, not frozen');
  assert.equal(afterStopped.journal.entryCount, beforeStopped.journal.entryCount, 'the refused freeze journaled nothing');
  assert.deepEqual(structuredClone(afterStopped.lifecycle), structuredClone(beforeStopped.lifecycle), 'the refused freeze rewrote no projection byte');

  const unstarted = await buildContainer(t, 'freeze-fabricated-clockless');
  const beforeClockless = await readRunLifecycle(unstarted.request);
  await expectCode(
    withRunTransaction(unstarted.request, async (context) => context.commitState({ state: 'FROZEN', stopAttestation: { ...attestation(), clockless: true } })),
    LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,
    'a clockless freeze with no journaled intent behind it',
  );
  const afterClockless = await readRunLifecycle(unstarted.request);
  assert.equal(afterClockless.state, 'INITIALIZED', 'the refused clockless freeze left the run unstarted');
  assert.equal(afterClockless.journal.entryCount, 0, 'the refused clockless freeze journaled nothing');
  assert.equal(afterClockless.lifecycle, null, 'the refused clockless freeze created no projection');
  void beforeClockless;
});

test('a stop without its journaled event is refused and leaves the run untouched', async (t) => {
  /* The same rule read from the other side: a projection that states an attested
   * stop needs the journaled stop behind it, so the gate is not satisfied by an
   * optional digest the caller happens to name. */
  const container = await buildContainer(t, 'stop-fabricated');
  await startRun({ ...container.request, declaration: declaration() });
  const before = await readRunLifecycle(container.request);
  const error = await expectCode(
    withRunTransaction(container.request, async (context) => context.commitState({
      state: 'STOP_RECORDED',
      stoppedAt: '2026-04-01T09:20:00.000Z',
      stopAttestation: attestation(),
      stopAssurance: STOP_ASSURANCE,
    })),
    LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,
    'a stop the journal never recorded',
  );
  assert.match(error.message, /STOP_RECORDED event/, 'the refusal names the authority event it is missing');
  const after = await readRunLifecycle(container.request);
  assert.equal(after.state, 'RUNNING', 'the refused stop left the run running');
  assert.equal(after.journal.entryCount, before.journal.entryCount, 'the refused stop journaled nothing');
  assert.deepEqual(structuredClone(after.lifecycle), structuredClone(before.lifecycle), 'the refused stop rewrote no projection byte');
});

test('a clockless freeze journales a freeze intent without inventing a start', async (t) => {
  /* The freeze task needs an intent/commit pair for a run that never started.
   * The journal can begin with FREEZE_INTENT, and nothing here manufactures a
   * START_INTENT, a timestamp or a state the operator did not attest. */
  const container = await buildContainer(t, 'journal-freeze-intent');
  const before = await readRunLifecycle(container.request);
  assert.equal(before.journal.entryCount, 0, 'the journal starts empty');

  const events = await withRunTransaction(container.request, async (context) => {
    const intent = await context.appendEvent({ kind: 'FREEZE_INTENT', occurredAt: null, journalCommitAt: null, detail: { operator: 'ops-desk', agentStopped: true, statement: 'nothing was started and nothing is running', observedAt: null, assurance: STOP_ASSURANCE, enforced: false, clockless: true } });
    const record = await context.commitState({ state: 'FROZEN', stopAttestation: { operator: 'ops-desk', agentStopped: true, statement: 'nothing was started and nothing is running', clockless: true } });
    const commit = await context.appendEvent({ kind: 'FREEZE_COMMIT', occurredAt: null, journalCommitAt: null, detail: { stateEventDigest: record.stateDigest } });
    return { intent, commit };
  });

  assert.equal(events.intent.sequence, 0, 'the freeze intent is the first event of a run that never started');
  assert.equal(events.intent.previousEventDigest, null, 'the first event binds no predecessor');
  assert.equal(events.commit.sequence, 1, 'the commit follows the intent');
  assert.equal(events.commit.previousEventDigest, events.intent.eventDigest, 'the commit binds its immediate predecessor');

  const after = await readRunLifecycle(container.request);
  assert.equal(after.state, 'FROZEN', 'the run is frozen without ever having started');
  assert.deepEqual([...after.journal.events.map((event) => event.kind)], ['FREEZE_INTENT', 'FREEZE_COMMIT'], 'no start event was invented');
  assert.equal(after.diagnosis, 'consistent', 'a complete intent/commit pair verifies');
  assert.deepEqual([...after.findings], [], 'nothing is reported against the journal');
  assert.equal(after.lifecycle.startedAt, null, 'no start instant exists on a run that never started');
  assert.equal(after.lifecycle.stoppedAt, null, 'no stop instant exists on a run that never started');

  /* An intent without its commit is the interrupted case, diagnosed the same
   * way a half-written start is, and reconciliation names the operation. */
  const torn = await buildContainer(t, 'journal-freeze-torn');
  const tornEvents = await withRunTransaction(torn.request, async (context) => context.appendEvent({ kind: 'FREEZE_INTENT', occurredAt: null, journalCommitAt: null, detail: { operator: 'ops-desk', agentStopped: true, statement: 'nothing was started and nothing is running', observedAt: null, assurance: STOP_ASSURANCE, enforced: false, clockless: true } }));
  assert.equal(tornEvents.kind, 'FREEZE_INTENT', 'the torn freeze journaled its intent');
  const tornView = await readRunLifecycle(torn.request);
  assert.equal(tornView.diagnosis, 'incomplete', 'a freeze intent without its commit is reported as incomplete');
});

test('a frozen run accepts no further state move', async (t) => {
  const container = await buildContainer(t, 'freeze-closed');
  await startRun({ ...container.request, declaration: declaration() });
  const record = await stopRun({ ...container.request, attestation: attestation() });
  await withRunTransaction(container.request, async (context) => commitFreeze(context, structuredClone(record.lifecycle.stopAttestation)));
  await expectCode(
    withRunTransaction(container.request, async (context) => context.commitState({ state: 'RUNNING' })),
    LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED,
    'a move out of the frozen state',
  );
  await expectCode(startRun({ ...container.request, declaration: declaration() }), LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a start after the freeze');
});

/* ========================================================================== */
/* The append-only, hash-chained journal                                       */
/* ========================================================================== */

test('every journal event after the first binds its immediate predecessor', async (t) => {
  const container = await buildContainer(t, 'journal-chain');
  await startRun({ ...container.request, declaration: declaration() });
  const stopped = await stopRun({ ...container.request, attestation: attestation() });
  const events = stopped.journal.events;
  assert.equal(events[0].previousEventDigest, null, 'the first event binds no predecessor');
  for (let index = 1; index < events.length; index += 1) {
    assert.equal(events[index].previousEventDigest, events[index - 1].eventDigest, `event ${String(index)} binds the digest of event ${String(index - 1)}`);
  }
  for (const event of events) {
    assert.equal(lifecycleEventDigestOf(event), event.eventDigest, 'each event digest recomputes from its own bytes');
  }
});

test('a broken hash chain is reported as inconsistent and blocks further writes', async (t) => {
  const container = await buildContainer(t, 'journal-broken');
  await startRun({ ...container.request, declaration: declaration() });
  await stopRun({ ...container.request, attestation: attestation() });
  /* A test that edits bytes simulates what an external modification looks like:
   * the module must detect it, not repair it. */
  const eventPath = path.join(container.stateRoot, LIFECYCLE_JOURNAL_DIRECTORY, '00002.json');
  const bytes = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  bytes.value.sequence = 7;
  fs.writeFileSync(eventPath, `${JSON.stringify(bytes, void 0, 2)}\n`, 'utf8');
  const view = await readRunLifecycle(container.request);
  assert.equal(view.diagnosis, 'inconsistent', 'the tampered journal is reported, not healed');
  assert.ok(view.findings.length > 0, 'the findings say what broke');
  await expectCode(
    withRunTransaction(container.request, async (context) => context.appendEvent({ kind: 'STOP_RECORDED' })),
    LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,
    'an append onto an unverified chain',
  );
});

test('a missing journal entry is reported as a chain break', async (t) => {
  const container = await buildContainer(t, 'journal-missing');
  await startRun({ ...container.request, declaration: declaration() });
  await stopRun({ ...container.request, attestation: attestation() });
  fs.rmSync(path.join(container.stateRoot, LIFECYCLE_JOURNAL_DIRECTORY, '00001.json'), { force: true });
  await expectCode(readRunLifecycle(container.request),LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,'a hole with an illegal sequence refuses journal authority');
});

test('a foreign entry in the journal directory is reported and preserved', async (t) => {
  const container = await buildContainer(t, 'journal-foreign');
  await startRun({ ...container.request, declaration: declaration() });
  fs.writeFileSync(path.join(container.stateRoot, LIFECYCLE_JOURNAL_DIRECTORY, 'notes.txt'), 'someone else\n', 'utf8');
  const view = await readRunLifecycle(container.request);
  assert.deepEqual([...view.journal.foreignEntries], ['notes.txt'], 'the foreign entry is named');
  assert.equal(fs.existsSync(path.join(container.stateRoot, LIFECYCLE_JOURNAL_DIRECTORY, 'notes.txt')), true, 'the module preserved it');
  await expectCode(
    withRunTransaction(container.request, async (context) => context.appendEvent({ kind: 'STOP_RECORDED' })),
    LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,
    'an append while a foreign entry sits in the journal',
  );
});

test('the append seam assigns sequence and predecessor and refuses invented ones', async (t) => {
  const container = await buildContainer(t, 'journal-seam');
  await expectCode(
    withRunTransaction(container.request, async (context) => context.appendEvent({ kind: 'START_INTENT', sequence: 9, declaration: declaration() })),
    LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT,
    'a callback that states its own sequence',
  );
  await expectCode(
    withRunTransaction(container.request, async (context) => context.appendEvent({ kind: 'STOP_RECORDED', previousEventDigest: 'a'.repeat(64) })),
    LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT,
    'a callback that states its own predecessor digest',
  );
  await expectCode(
    withRunTransaction(container.request, async (context) => context.appendEvent({ kind: 'NOT_A_KIND' })),
    LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT,
    'an unknown event kind',
  );
  const view = await readRunLifecycle(container.request);
  assert.equal(view.journal.entryCount, 0, 'nothing was appended by the refused calls');
});

test('the state seam refuses an unknown state and an unauthorised field set', async (t) => {
  const container = await buildContainer(t, 'state-seam');
  await expectCode(
    withRunTransaction(container.request, async (context) => context.commitState({ state: 'HALF_DONE' })),
    LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT,
    'an unknown state name',
  );
  await expectCode(
    withRunTransaction(container.request, async (context) => context.commitState({ state: 'RUNNING', arbitrary: true })),
    LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT,
    'a commit carrying an undeclared field',
  );
  const reported = await withRunTransaction(container.request, () => void 0);
  assert.equal(reported, void 0, 'a command that reports nothing yields nothing: the seam invents no success value');
  const after = await readRunLifecycle(container.request);
  assert.equal(after.state, LIFECYCLE_DERIVED_STATE, 'a command that wrote nothing left no state behind');
});

test('the state record digest recomputes from the persisted bytes', async (t) => {
  const container = await buildContainer(t, 'state-digest');
  const started = await startRun({ ...container.request, declaration: declaration() });
  assert.equal(lifecycleStateDigestOf(started.lifecycle), started.lifecycle.stateDigest, 'the digest recomputes');
  const storage = createStorage({ root: container.stateRoot });
  const persisted = await storage.read({ relativePath: LIFECYCLE_STATE_RELATIVE_PATH, kind: LIFECYCLE_STATE_KIND, id: `${container.manifestId}:lifecycle-state` });
  assert.deepEqual(structuredClone(persisted), structuredClone(started.lifecycle), 'the read-back equals what was published');
});

/** Capture the bytes of every file under a root so preservation can be proved. */
function captureTree(root) {
  const files = new Map();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.set(path.relative(root, full), fs.readFileSync(full));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return files;
}

/** Stage a journaled stop whose projection commit never landed. */
async function appendTornStop(container) {
  return withRunTransaction(container.request, async (context) => context.appendEvent({
    kind: 'STOP_RECORDED',
    occurredAt: '2026-04-01T09:20:00.000Z',
    journalCommitAt: '2026-04-01T09:20:00.000Z',
    declaration: context.lifecycle.declaration,
    detail: { operator: 'operator-one', agentStopped: true, statement: 'the cooperating participants stopped of their own cooperation', observedAt: '2026-04-01T09:20:00.000Z', assurance: 'operator-attested', enforced: false },
  }));
}

/* ========================================================================== */
/* Journal/projection coherence in the read diagnostic (C3 T7)                  */
/* ========================================================================== */

test('a journaled stop without its projection commit is reported, never called consistent', async (t) => {
  /* The T5 handoff finding, reproduced exactly: a completed start, then a
   * STOP_RECORDED appended through the seam with the projection commit missing.
   * The journal is the authority and the projection still reports RUNNING with
   * no attestation, so the read must report the incoherence instead of reporting
   * the run as consistent with no findings. The read still publishes nothing. */
  const container = await buildContainer(t, 'coherence-torn-stop');
  await startRun({ ...container.request, declaration: declaration() });
  const event = await appendTornStop(container);

  const view = await readRunLifecycle(container.request);
  assert.equal(view.state, 'RUNNING', 'the reported state is still what the projection carries: the read rewrites nothing');
  assert.notEqual(view.diagnosis, 'consistent', 'a stop in the authority without its projection is not a consistent run');
  assert.equal(view.diagnosis, 'inconsistent', 'the incoherence is reported as its own diagnosis');
  assert.ok(view.findings.length > 0, 'the findings are not empty');
  const report = JSON.stringify(view.findings);
  assert.match(report, /STOP_RECORDED/, 'the findings name the journaled stop event');
  assert.match(report, /no projection commit/, 'the findings state the missing projection commit');
  assert.ok(event.eventDigest.length === 64, 'the journaled stop is a real chained event');

  /* The read is non-mutating: a second read reports the same bytes and the same
   * findings, so reporting the gap cannot drift the run it reports. */
  const bytesBefore = captureTree(container.stateRoot);
  const again = await readRunLifecycle(container.request);
  assert.deepEqual(structuredClone(again.findings), structuredClone(view.findings), 'the report is stable across reads');
  assert.deepEqual([...captureTree(container.stateRoot).keys()], [...bytesBefore.keys()], 'no file appeared or vanished');
  for (const [name, bytes] of captureTree(container.stateRoot)) {
    assert.ok(bytes.equals(bytesBefore.get(name)), `the bytes of ${name} are unchanged by the read`);
  }

  /* The gates that already refuse this run keep refusing it: the diagnostic
   * repair adds a report and removes no refusal. */
  assert.equal(freezePreconditionFor('RUNNING').permitted, false, 'a run the projection still reports RUNNING has no freeze route');

  /* The write gate is closed over the same shape the read reports. The stop seam
   * no longer evaluates its repeat-stop rule against the projection alone: the
   * journal already carries the operator's stop, so a second `stopRun` — even
   * one repeating the attestation byte for byte — is refused before anything is
   * read from the clock or written to the journal. Accepting it would journal a
   * second STOP_RECORDED over an authority that already states one observation
   * happened, and the released journal rule is that a stop is one observation. */
  const repeatAttempt = await expectCode(
    stopRun({ ...container.request, attestation: attestation() }),
    LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,
    'a repeat stop over a journaled stop whose projection never landed',
  );
  assert.match(repeatAttempt.message, /STOP_RECORDED/, 'the refusal names the journaled stop it will not write over');
  const afterGate = await captureTree(container.stateRoot);
  assert.deepEqual([...afterGate.keys()], [...bytesBefore.keys()], 'the refused repeat created no file and removed none');
  for (const [name, bytes] of afterGate) {
    assert.ok(bytes.equals(bytesBefore.get(name)), `the refused repeat left the bytes of ${name} exactly as they were`);
  }
});

test('reconciliation of a torn stop reports the incoherence and does not complete a start over it', async (t) => {
  /* The journal of this run carries no pending start, so the released start
   * completion would have appended a START_COMMIT and rewritten the projection
   * — a second invention on a run that already disagrees with itself. The
   * coherence report must stop it before any write. */
  const container = await buildContainer(t, 'coherence-reconcile-torn-stop');
  await startRun({ ...container.request, declaration: declaration() });
  await appendTornStop(container);

  const bytesBefore = captureTree(container.stateRoot);
  const result = await reconcileRun({
    ...container.request,
    interruptedOperation: 'START',
    disposition: { operator: 'operator-one', decision: 'COMPLETE', attestation: 'the operator directed completion of the interrupted operation' },
  });
  assert.equal(result.diagnosis, 'inconsistent', 'the reconciliation reports the incoherence it found');
  assert.equal(result.action, 'LEAVE_AS_IS', 'no repair is attempted over a run whose authorities disagree');
  assert.ok(result.findings.length > 0, 'the reconciliation names what disagrees');
  const bytesAfter = captureTree(container.stateRoot);
  assert.deepEqual([...bytesAfter.keys()], [...bytesBefore.keys()], 'no journal entry was appended and no file was removed');
  for (const [name, bytes] of bytesAfter) {
    assert.ok(bytes.equals(bytesBefore.get(name)), `the bytes of ${name} are exactly what was found`);
  }
});

test('every legitimate state still reports consistent with no coherence findings', async (t) => {
  /* The repair must not read a healthy run as broken: the derived INITIALIZED
   * state, a committed start, an attested stop, a bound freeze and a clockless
   * freeze all report consistent with an empty findings array. */
  const untouched = await buildContainer(t, 'coherence-ok-initialized');
  const untouchedView = await readRunLifecycle(untouched.request);
  assert.equal(untouchedView.diagnosis, 'consistent', 'a container with no record and no journal is consistent');
  assert.deepEqual([...untouchedView.findings], [], 'and it carries no findings');

  const running = await buildContainer(t, 'coherence-ok-running');
  await startRun({ ...running.request, declaration: declaration() });
  const runningView = await readRunLifecycle(running.request);
  assert.equal(runningView.state, 'RUNNING');
  assert.equal(runningView.diagnosis, 'consistent', 'a start with intent, commit and projection is consistent');
  assert.deepEqual([...runningView.findings], []);

  const stopped = await buildContainer(t, 'coherence-ok-stopped');
  await startRun({ ...stopped.request, declaration: declaration() });
  const record = await stopRun({ ...stopped.request, attestation: attestation() });
  const stoppedView = await readRunLifecycle(stopped.request);
  assert.equal(stoppedView.state, 'STOP_RECORDED');
  assert.equal(stoppedView.diagnosis, 'consistent', 'a stop whose event and projection were written together is consistent');
  assert.deepEqual([...stoppedView.findings], [], 'the fidelity rules do not fire against a stop written by the release');

  const frozen = await buildContainer(t, 'coherence-ok-frozen');
  await startRun({ ...frozen.request, declaration: declaration() });
  const stopRecord = await stopRun({ ...frozen.request, attestation: attestation() });
  await withRunTransaction(frozen.request, async (context) => commitFreeze(context, stopRecord.lifecycle.stopAttestation));
  const frozenView = await readRunLifecycle(frozen.request);
  assert.equal(frozenView.state, 'FROZEN');
  assert.equal(frozenView.diagnosis, 'consistent', 'a frozen projection keeps the stop its authority carries, so it is coherent');
  assert.deepEqual([...frozenView.findings], []);

  const clockless = await buildContainer(t, 'coherence-ok-clockless');
  await withRunTransaction(clockless.request, async (context) => {
    await context.appendEvent({ kind: 'FREEZE_INTENT', occurredAt: null, journalCommitAt: null, detail: { operator: 'ops-desk', agentStopped: true, statement: 'nothing was started and nothing is running', observedAt: null, assurance: STOP_ASSURANCE, enforced: false, clockless: true } });
    await context.commitState({ state: 'FROZEN', stopAttestation: { operator: 'ops-desk', agentStopped: true, statement: 'nothing was started and nothing is running', clockless: true } });
    await context.appendEvent({ kind: 'FREEZE_COMMIT', occurredAt: null, journalCommitAt: null, detail: { stateEventDigest: context.lifecycle.stateDigest } });
  });
  const clocklessView = await readRunLifecycle(clockless.request);
  assert.equal(clocklessView.state, 'FROZEN');
  assert.equal(clocklessView.diagnosis, 'consistent', 'a clockless freeze is the attested route with no start and no stop by design');
  assert.deepEqual([...clocklessView.findings], [], 'the stop rule does not fire against a clockless freeze attestation');
  void record;
});

test('honest clock outcomes keep their own report while coherence stays clean', async (t) => {
  /* An unknown clock leaves the instants null and an equal-clock pair is a
   * legitimate elapsed of zero. Neither is an incoherence, and the coherence
   * rules must not invent findings over either. */
  const unknown = await buildContainer(t, 'coherence-clock-unknown');
  await startRun({ ...unknown.request, declaration: declaration(), clock: clockAt(null) });
  await stopRun({ ...unknown.request, attestation: attestation(), clock: clockAt(null) });
  const unknownView = await readRunLifecycle(unknown.request);
  assert.equal(unknownView.lifecycle.startedAt, null, 'an unknown clock stays null');
  assert.equal(unknownView.lifecycle.stoppedAt, null, 'the stop instant stays null rather than being invented');
  assert.equal(unknownView.diagnosis, 'consistent', 'two null instants are the honest report, not a disagreement');
  assert.deepEqual([...unknownView.findings], []);

  const equal = await buildContainer(t, 'coherence-clock-equal');
  await startRun({ ...equal.request, declaration: declaration(), clock: clockAt(1777000000000) });
  await stopRun({ ...equal.request, attestation: attestation(), clock: clockAt(1777000000000) });
  const equalView = await readRunLifecycle(equal.request);
  assert.equal(equalView.lifecycle.elapsedMs, 0, 'equal readings are a legitimate elapsed of zero');
  assert.equal(equalView.diagnosis, 'consistent', 'zero elapsed is not a fault');
  assert.deepEqual([...equalView.findings], []);
});

test('a projection that states a stop the authority does not carry is reported', async (t) => {
  /* The incoherence runs in both directions: a projection that claims a stopped
   * run the journal never recorded is reported just as plainly. The write seam
   * refuses to publish such a projection at all, which is shown in the gate test
   * for itself, so the only way this disagreement can exist on disk is an
   * external rewrite of the projection bytes — exactly the construction below,
   * with the self digest recomputed so the digest check cannot be what fires. */
  const container = await buildContainer(t, 'coherence-stop-without-event');
  await startRun({ ...container.request, declaration: declaration() });
  const storage = createStorage({ root: container.stateRoot });
  const persisted = await storage.read({ relativePath: LIFECYCLE_STATE_RELATIVE_PATH, kind: LIFECYCLE_STATE_KIND, id: `${container.manifestId}:lifecycle-state` });
  const rewritten = structuredClone(persisted);
  rewritten.state = 'STOP_RECORDED';
  rewritten.stoppedAt = '2026-04-01T09:20:00.000Z';
  rewritten.stopAttestation = structuredClone(attestation());
  rewritten.stopAssurance = STOP_ASSURANCE;
  rewritten.elapsedMs = null;
  rewritten.stateDigest = '';
  rewritten.stateDigest = lifecycleStateDigestOf(rewritten);
  await storage.withLock(() => storage.replaceMutable({ relativePath: LIFECYCLE_STATE_RELATIVE_PATH, kind: LIFECYCLE_STATE_KIND, id: `${container.manifestId}:lifecycle-state`, value: rewritten }));
  assert.equal(lifecycleStateDigestOf(rewritten), rewritten.stateDigest, 'the rewritten record passes its own digest check');

  /* The projection advanced without a journaled event: the authority is missing
   * the observation the projection states. */
  await expectCode(readRunLifecycle(container.request), LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a forged stop projection is refused rather than reported');
});

test('a projection whose stated stop is not the journaled stop is reported', async (t) => {
  /* The authority journaled one stop while the projection carries another one.
   * The released write produces the two from one attestation, so a projection
   * that states a different operator, statement or instant cannot be the
   * projection of that event; this is the same check the released freeze gate
   * makes before it publishes. */
  const container = await buildContainer(t, 'coherence-stop-fidelity');
  await startRun({ ...container.request, declaration: declaration() });
  await stopRun({ ...container.request, attestation: attestation() });
  /* Replace the projection with a byte-identical record that carries a
   * different operator and instant, and recompute its own digest, which is
   * what an external rewrite of the projection looks like. */
  const storage = createStorage({ root: container.stateRoot });
  const persisted = await storage.read({ relativePath: LIFECYCLE_STATE_RELATIVE_PATH, kind: LIFECYCLE_STATE_KIND, id: `${container.manifestId}:lifecycle-state` });
  const rewritten = structuredClone(persisted);
  rewritten.stoppedAt = '2026-04-02T09:20:00.000Z';
  rewritten.stopAttestation = structuredClone(attestation({ operator: 'operator-other', statement: 'a statement the journal does not carry' }));
  rewritten.stateDigest = '';
  /* The self digest is computed over the record with its own digest field
   * excluded, so recomputing it is exactly what an external rewrite of the
   * projection would do: the digest check passes and only the coherence
   * comparison can fire. */
  rewritten.stateDigest = lifecycleStateDigestOf(rewritten);
  await storage.withLock(() => storage.replaceMutable({ relativePath: LIFECYCLE_STATE_RELATIVE_PATH, kind: LIFECYCLE_STATE_KIND, id: `${container.manifestId}:lifecycle-state`, value: rewritten }));
  assert.equal(lifecycleStateDigestOf(rewritten), rewritten.stateDigest, 'the rewritten record passes its own digest check');

  await expectCode(readRunLifecycle(container.request), LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a forged stop instant and attestation are refused rather than reported');
});

test('an interrupted operation keeps its own diagnosis over the coherence report', async (t) => {
  /* The precedence is deliberate: a lagging projection is usually the very
   * interruption the operator is being told to reconcile, so it must stay
   * `incomplete` with the recovery route open rather than be relabelled as
   * corruption. The read still names the lag so the report is not lost. */
  const container = await buildContainer(t, 'coherence-precedence');
  const captured = declaration({ workerCount: 4 });
  await writeInterruptedStart(container, { declarationValue: captured });
  const view = await readRunLifecycle(container.request);
  assert.equal(view.diagnosis, 'incomplete', 'an intent without its commit is still diagnosed as the interrupted operation');

  /* A stopped run whose freeze intent never committed keeps the freeze route
   * visible through the intent-without-commit diagnosis and through the
   * coherence rules alike: the run is reported, never repaired. */
  const tornFreeze = await buildContainer(t, 'coherence-precedence-freeze');
  await startRun({ ...tornFreeze.request, declaration: declaration() });
  await stopRun({ ...tornFreeze.request, attestation: attestation() });
  await withRunTransaction(tornFreeze.request, async (context) => context.appendEvent({ kind: 'FREEZE_INTENT', occurredAt: null, journalCommitAt: null, detail: { operator: 'ops-desk', agentStopped: true, statement: 'the cooperating participants stopped of their own cooperation', observedAt: null, assurance: STOP_ASSURANCE, enforced: false, clockless: false } }));
  const freezeView = await readRunLifecycle(tornFreeze.request);
  assert.equal(freezeView.diagnosis, 'incomplete', 'the torn freeze is reported as the interrupted operation it is');
  assert.deepEqual([...freezeView.findings], [], 'a coherent stop and projection add no coherence findings');
});

/* ========================================================================== */
/* Interruption, reconciliation, and the stale lock                            */
/* ========================================================================== */

test('an interrupted start is diagnosed and keeps its declaration bound', async (t) => {
  const container = await buildContainer(t, 'reconcile-diagnose');
  const captured = declaration({ workerCount: 5 });
  await writeInterruptedStart(container, { declarationValue: captured });
  const view = await readRunLifecycle(container.request);
  assert.equal(view.diagnosis, 'incomplete', 'an intent without its commit is an interrupted operation');
  assert.equal(view.state, 'RUNNING', 'the record the interrupted command left stands');
  await expectCode(startRun({ ...container.request, declaration: declaration({ workerCount: 6 }) }), LIFECYCLE_ERROR_CODES.DECLARATION_ALREADY_BOUND, 'a divergent declaration after an interrupted start');
  await expectCode(startRun({ ...container.request, declaration: captured }), LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED, 'a matching declaration after an interrupted start');
  await expectCode(stopRun({ ...container.request, attestation: attestation() }), LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED, 'a stop before the interruption is resolved');
  const unchanged = await readRunLifecycle(container.request);
  assert.deepEqual(structuredClone(unchanged.lifecycle.declaration), captured, 'the captured declaration is preserved unchanged');
});

test('reconciliation requires the interrupted operation and an operator disposition', async (t) => {
  const container = await buildContainer(t, 'reconcile-args');
  await writeInterruptedStart(container, { declarationValue: declaration() });
  await expectCode(reconcileRun({ ...container.request, disposition: { operator: 'op-1', decision: 'COMPLETE', attestation: 'the operator directed completion' } }), LIFECYCLE_ERROR_CODES.FIELD_REQUIRED, 'a reconciliation without the interrupted operation');
  await expectCode(reconcileRun({ ...container.request, interruptedOperation: 'START' }), LIFECYCLE_ERROR_CODES.FIELD_REQUIRED, 'a reconciliation without a disposition');
  await expectCode(reconcileRun({ ...container.request, interruptedOperation: 'PRINTING', disposition: { operator: 'op-1', decision: 'COMPLETE', attestation: 'the operator directed completion' } }), LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'an unsupported interrupted operation');
  await expectCode(reconcileRun({ ...container.request, interruptedOperation: 'START', disposition: { operator: 'op-1', decision: 'FORCE', attestation: 'the operator directed completion' } }), LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'an unknown disposition decision');
});

test('reconciliation completes an interrupted start from the journaled bytes', async (t) => {
  const container = await buildContainer(t, 'reconcile-complete');
  const captured = declaration({ workerCount: 7 });
  await writeInterruptedStart(container, { declarationValue: captured });
  const result = await reconcileRun({
    ...container.request,
    interruptedOperation: 'START',
    disposition: { operator: 'operator-one', decision: 'COMPLETE', attestation: 'the operator directed that the started run stands' },
  });
  assert.equal(result.diagnosis, 'repaired', 'the interrupted operation was completed');
  assert.equal(result.state, 'RUNNING', 'the run reports RUNNING once its commit exists');
  const view = await readRunLifecycle(container.request);
  assert.equal(view.diagnosis, 'consistent', 'the journal verifies once more');
  assert.deepEqual([...view.journal.events.map((event) => event.kind)], ['START_INTENT', 'START_COMMIT'], 'the commit was appended after the intent');
  assert.equal(view.journal.events[1].detail.reconciliation, true, 'the repaired commit says it came from reconciliation');
  assert.deepEqual(structuredClone(view.lifecycle.declaration), captured, 'the declaration the journal captured is the one that stands');
  assert.ok(JSON.stringify(view.lifecycle.history).includes('RECONCILE'), 'the reconciliation is in the retained history');
});

test('reconciliation leaves the bytes alone when the operator says so', async (t) => {
  const container = await buildContainer(t, 'reconcile-leave');
  await writeInterruptedStart(container, { declarationValue: declaration() });
  const before = await readRunLifecycle(container.request);
  const result = await reconcileRun({
    ...container.request,
    interruptedOperation: 'START',
    disposition: { operator: 'operator-one', decision: 'LEAVE_AS_IS', attestation: 'the operator directed that nothing be changed' },
  });
  assert.equal(result.action, 'LEAVE_AS_IS', 'the disposition is reported back');
  const after = await readRunLifecycle(container.request);
  assert.deepEqual(structuredClone(after.journal), structuredClone(before.journal), 'not one journal byte changed');
  assert.equal(after.diagnosis, 'incomplete', 'the interruption is still visible');
});

test('reconciliation of a healthy run reports that nothing needs repair', async (t) => {
  const container = await buildContainer(t, 'reconcile-nothing');
  await startRun({ ...container.request, declaration: declaration() });
  const result = await reconcileRun({
    ...container.request,
    interruptedOperation: 'START',
    disposition: { operator: 'operator-one', decision: 'COMPLETE', attestation: 'the operator directed completion' },
  });
  assert.equal(result.diagnosis, 'consistent', 'nothing was interrupted');
  assert.equal(result.action, 'LEAVE_AS_IS', 'nothing was changed');
});

test('a lock held by another writer is refused and never taken over', async (t) => {
  const container = await buildContainer(t, 'lock-conflict');
  /* A real contending writer through the accepted seam: it takes the container
   * lock and holds it until the test lets go. While it holds, every lifecycle
   * operation on the same container must refuse — including a read, which is
   * reported as the same mapped refusal rather than as a bypassed or queued
   * read — and the holder's lock bytes must be left exactly as they were. */
  const holder = createStorage({ root: container.stateRoot });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const holderCommand = holder.withLock(async () => {
    await held;
    return 'released';
  });
  const lockPath = path.join(container.stateRoot, '.storage', 'lock');
  const deadline = Date.now() + 5000;
  let lockBytesWhileHeld = '';
  for (;;) {
    if (fs.existsSync(lockPath)) {
      /* The holder creates the lock file before it writes its record, so wait
       * for a complete record before capturing the bytes that must not change. */
      lockBytesWhileHeld = fs.readFileSync(lockPath, 'utf8');
      if (lockBytesWhileHeld.trim().length > 0) break;
    }
    if (Date.now() > deadline) {
      release();
      await holderCommand;
      assert.fail('the contending writer never published a container lock record, so the test cannot measure contention');
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  const attempted = await rejection(startRun({ ...container.request, declaration: declaration() }));
  assert.ok(attempted instanceof LifecycleError, 'the second writer is refused');
  assert.equal(attempted.code, LIFECYCLE_ERROR_CODES.STORAGE_REFUSED, `the refusal comes from the accepted seam (${attempted.message})`);
  assert.match(attempted.message, /lock/i, 'the refusal names the lock');

  const readAttempt = await rejection(readRunLifecycle(container.request));
  assert.ok(readAttempt instanceof LifecycleError, 'a read under contention is reported as a lifecycle refusal, not a raw seam error');
  assert.equal(readAttempt.code, LIFECYCLE_ERROR_CODES.STORAGE_REFUSED, `the read refusal is mapped too (${readAttempt.message})`);

  assert.ok(fs.existsSync(lockPath), 'the held lock file is still there: nothing was evicted');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), lockBytesWhileHeld, 'the holder lock bytes are untouched: no lock theft');

  release();
  assert.equal(await holderCommand, 'released', 'the holder finished on its own terms');
  const view = await readRunLifecycle(container.request);
  assert.equal(view.state, LIFECYCLE_DERIVED_STATE, 'after the owner releases, the run still reports INITIALIZED');
  assert.equal(view.journal.entryCount, 0, 'the refused writers journaled nothing');
  const started = await startRun({ ...container.request, declaration: declaration() });
  assert.equal(started.state, 'RUNNING', 'the run can be started once the holder releases the lock');
});

/* ========================================================================== */
/* The shared transaction seam                                                  */
/* ========================================================================== */

test('the transaction seam exposes the verified identity for the whole command', async (t) => {
  const container = await buildContainer(t, 'transaction-context');
  await startRun({ ...container.request, declaration: declaration() });
  const seen = await withRunTransaction({ ...container.request, clock: clockAt(1777000000000) }, async (context) => ({
    manifestId: context.manifest.manifestId,
    runId: context.manifest.runId,
    stateRoot: context.stateRoot,
    workspaceRoot: context.workspaceRoot,
    state: context.lifecycle.state,
    hasStorage: typeof context.storage.read === 'function' && context.storage.withLock === undefined,
    hasAppend: typeof context.appendEvent === 'function',
    hasCommit: typeof context.commitState === 'function',
    clockName: context.clock === void 0 ? null : typeof context.clock.now,
  }));
  assert.equal(seen.manifestId, container.manifestId, 'the verified manifest identity is exposed');
  assert.equal(seen.stateRoot, container.stateRoot, 'the state root is exposed');
  assert.equal(seen.workspaceRoot, path.join(container.runRoot, WORKSPACE_DIRECTORY_NAME), 'the workspace root is exposed');
  assert.equal(seen.state, 'RUNNING', 'the current lifecycle record is exposed');
  assert.equal(seen.hasStorage, true, 'the storage seam is exposed');
  assert.equal(seen.hasAppend, true, 'the narrow append seam is exposed');
  assert.equal(seen.hasCommit, true, 'the checked state seam is exposed');
  assert.equal(seen.clockName, 'function', 'the caller clock is available to the command');
});

test('the transaction seam requires a callback and a valid request', async (t) => {
  const container = await buildContainer(t, 'transaction-args');
  await expectCode(withRunTransaction(container.request), LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'a command with no callback');
  await expectCode(withRunTransaction({ ...container.request, runId: 7 }, () => 'x'), LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'a numeric runId');
});

test('a command that throws leaves the honest partial state and reports the error', async (t) => {
  const container = await buildContainer(t, 'transaction-throw');
  const error = await rejection(withRunTransaction(container.request, async (context) => {
    await context.appendEvent({ kind: 'START_INTENT', declaration: declaration() });
    throw new Error('the command was interrupted here');
  }));
  assert.match(error.message, /interrupted here/, 'the command error is what surfaces');
  const view = await readRunLifecycle(container.request);
  assert.equal(view.diagnosis, 'incomplete', 'the half-done command is visible as an interruption');
  assert.equal(view.journal.entryCount, 1, 'the journaled intent survived, as it must');
});

/* ========================================================================== */
/* The manual adapter, the paired declarations and the operational schemas     */
/* ========================================================================== */

/**
 * Compile one consumer against the shipped declarations with the pinned
 * compiler, in its own scratch directory so its relative specifiers and its
 * expected-error count are unambiguous.
 */
function compileConsumer(t, name, source) {
  const directory = scratch(t, 'types');
  const consumer = path.join(directory, name);
  fs.writeFileSync(consumer, source);
  const compiler = path.join(STARTER_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [compiler, '--noEmit', '--strict', '--exactOptionalPropertyTypes',
    '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', consumer], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

/** The relative specifier from a scratch consumer to a repository module. */
function relativeSpecifier(fromFile, toFile) {
  const relative = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

test('the manual adapter exposes the same operations and states what it cannot do', async () => {
  const adapter = await import('../../adapters/manual/index.mjs');
  const core = await import('../../packages/core/lifecycle.mjs');
  for (const name of ['openRun', 'withRunTransaction', 'startRun', 'stopRun', 'reconcileRun', 'readRunLifecycle']) {
    assert.equal(adapter[name], core[name], `the adapter re-exports the core ${name} rather than wrapping a second copy`);
    assert.equal(adapter.manualLifecycleOperations[name], core[name], `the operations record carries the same ${name}`);
  }
  assert.equal(Object.keys(adapter.manualLifecycleOperations).length, 6, 'the operations record is the six, not a wider surface');
  assert.equal(adapter.capabilities.executionMode, 'MANUAL', 'the adapter declares itself manual');
  assert.equal(adapter.capabilities.halt, false, 'the adapter cannot halt an agent');
  assert.equal(adapter.capabilities.deadlineEnforcement, false, 'the adapter enforces no deadline or ceiling');
  assert.equal(adapter.capabilities.stopAssurance, STOP_ASSURANCE, 'the stated assurance is the value a stop returns');
  assert.equal(adapter.capabilities.stopEnforced, STOP_ENFORCED, 'the stated enforcement is the value a stop returns');
  assert.equal(Object.isFrozen(adapter.capabilities), true, 'the capability statement cannot be widened by a caller');
  assert.equal(Object.isFrozen(adapter.manualLifecycleOperations), true, 'the operations record cannot be swapped by a caller');

  const source = fs.readFileSync(new URL('../../adapters/manual/index.mjs', import.meta.url), 'utf8');
  /* The structural claim: every module the adapter imports from is the core
   * lifecycle module and nothing else. Prose may name what is absent; the
   * import list is what decides what is present. */
  const specifiers = [];
  const importPattern = /from\s+'([^']+)'/g;
  let match = importPattern.exec(source);
  while (match !== null) {
    specifiers.push(match[1]);
    match = importPattern.exec(source);
  }
  assert.ok(specifiers.length >= 1, 'the adapter has an import list to inspect');
  for (const specifier of specifiers) {
    assert.equal(specifier.endsWith('packages/core/lifecycle.mjs'), true, `the adapter imports only the core lifecycle module, not ${specifier}`);
  }
  for (const forbidden of ['node:child_process', 'node:worker_threads', 'node:cluster', 'node:net', 'node:http', 'node:fs', 'node:os', 'process.kill', '.kill(', 'SIGKILL', 'SIGTERM', 'process.env']) {
    assert.equal(source.includes(forbidden), false, `the manual adapter must not reference ${forbidden}`);
  }
  assert.equal(/import\s+[^\n]*dsh/i.test(source), false, 'the manual adapter must not import a DSH module');
  /* Only a callable could act on a process, so the scan is over the functions
   * this boundary exposes. A boolean named for what it denies is the honest way
   * to state a limit, and the three negative capabilities above are what make
   * that statement true. */
  for (const [name, value] of Object.entries(adapter)) {
    if (typeof value !== 'function') continue;
    assert.equal(/halt|kill|terminate|launch|spawn|signal|enforce|stop_|wait/i.test(name), false, `no adapter operation may claim control of a process (${name})`);
  }
  assert.equal(adapter.capabilities.processControl, false, 'the adapter states plainly that it controls no process');
  assert.equal(adapter.capabilities.halt, false, 'and states plainly that it halts nothing');
});

test('the declaration pairs are byte-identical and describe the shipped module', async (t) => {
  for (const base of ['packages/core/lifecycle', 'adapters/manual/index']) {
    const ts = new URL(`../../${base}.d.ts`, import.meta.url);
    const mts = new URL(`../../${base}.d.mts`, import.meta.url);
    assert.deepEqual(fs.readFileSync(ts), fs.readFileSync(mts), `${base}: the .d.ts and .d.mts siblings are byte-identical`);
  }

  const core = await import('../../packages/core/lifecycle.mjs');
  const adapter = await import('../../adapters/manual/index.mjs');
  const declaration = fs.readFileSync(new URL('../../packages/core/lifecycle.d.ts', import.meta.url), 'utf8');
  for (const name of Object.keys(core)) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(declaration), `the core declaration names ${name}`);
  }
  for (const name of Object.keys(adapter)) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(fs.readFileSync(new URL('../../adapters/manual/index.d.ts', import.meta.url), 'utf8')) || /Type$/.test(name), `the adapter declaration names ${name}`);
  }
});

/** The body a valid consumer compiles against the shipped declarations. */
function validConsumer(core, adapter) {
  return `
import * as core from '${core}';
import * as manual from '${adapter}';
import type {
  RunDeclaration,
  StopAttestation,
  RunLifecycleRequest,
  StartRunRequest,
  StopRunRequest,
  LifecycleView,
  LifecycleEvent,
  LifecycleStateRecord,
  RunTransactionContext,
} from '${core}';
import type { ManualCapabilities as AdapterCapabilities, ManualStopAttestation } from '${adapter}';

const clock = { now: (): number | null => 1_777_000_000_000 };
const declaration: RunDeclaration = {
  harness: 'manual',
  model: null,
  workerCount: 2,
  executionMode: 'MANUAL',
  declaredCeilingMinutes: 45,
};
const attestation: StopAttestation = { operator: 'ops-desk', agentStopped: true, statement: 'it stopped' };
const request: RunLifecycleRequest = { runRoot: 'C:/synthetic/container', manifestId: 'm', runId: 'r', clock };
const startRequest: StartRunRequest = { ...request, declaration };
const stopRequest: StopRunRequest = { ...request, attestation };

export async function exercise(): Promise<void> {
  const started: LifecycleView = await core.startRun(startRequest);
  const stopped: LifecycleView = await manual.stopRun(stopRequest);
  const read: LifecycleView = await manual.readRunLifecycle(request);
  const state: 'INITIALIZED' | 'RUNNING' | 'STOP_RECORDED' | 'FROZEN' = read.state;
  const record: LifecycleStateRecord | null = started.lifecycle;
  const events: readonly LifecycleEvent[] = stopped.journal.events;
  const head: readonly string[] = stopped.journal.foreignEntries;
  const written: LifecycleEvent = await core.withRunTransaction(request, async (context: RunTransactionContext): Promise<LifecycleEvent> => {
    const at: string | null = context.lifecycle?.stoppedAt ?? null;
    void at;
    return context.appendEvent({ kind: 'FREEZE_INTENT', occurredAt: null, detail: { operator: 'ops-desk', agentStopped: true, statement: 'nothing was started and nothing is running', observedAt: null, assurance: 'operator-attested', enforced: false, clockless: true } });
  });
  const gate = core.freezePreconditionFor(read.state);
  const permitted: boolean = gate.permitted;
  const capabilities: AdapterCapabilities = manual.capabilities;
  const same: AdapterCapabilities = capabilities;
  const attested: ManualStopAttestation = attestation;
  void [started, stopped, read, state, record, events, head, written, permitted, capabilities, same, attested];
}
`;
}

/** Uses of the declarations that must be diagnosed rather than compiled. */
function invalidConsumer(core, adapter) {
  return `
import * as core from '${core}';
import * as manual from '${adapter}';
import type { RunDeclaration, StopAttestation, RunLifecycleRequest } from '${core}';
import type { ManualCapabilities as AdapterCapabilities } from '${adapter}';

const declaration: RunDeclaration = { harness: 'manual', model: null, workerCount: 2, executionMode: 'MANUAL', declaredCeilingMinutes: 45 };

// a stop attestation must claim agentStopped
export const missingClaim: StopAttestation = { operator: 'ops-desk', statement: 'it stopped' };
// the execution mode is the one this release records
export const wrongMode: RunDeclaration = { ...declaration, executionMode: 'AUTOMATED' };
// a run must be named by path and by both identities
export const anonymous: RunLifecycleRequest = { manifestId: 'm', runId: 'r' };
// a manual adapter claims no halt capability
export const canHalt: AdapterCapabilities = { ...manual.capabilities, halt: true };
// a journaled sequence is a number
export const sequenced = core.lifecycleEventDigestOf({ sequence: 'zero' });
void [missingClaim, wrongMode, anonymous, canHalt, sequenced];
`;
}

test('a real consumer imports the shipped module against its declarations', async (t) => {
  const coreModule = fileURLToPath(new URL('../../packages/core/lifecycle.mjs', import.meta.url));
  const adapterModule = fileURLToPath(new URL('../../adapters/manual/index.mjs', import.meta.url));
  const directory = scratch(t, 'consumer');
  const probe = path.join(directory, 'probe.mts');
  const core = relativeSpecifier(probe, coreModule);
  const adapter = relativeSpecifier(probe, adapterModule);

  const valid = compileConsumer(t, 'valid.mts', validConsumer(core, adapter));
  assert.equal(valid.status, 0, `the valid consumer must compile against the shipped declarations:\n${valid.output}`);

  const invalidSource = invalidConsumer(core, adapter);
  const invalid = compileConsumer(t, 'invalid.mts', invalidSource);
  const diagnosed = [...invalid.output.matchAll(/error TS[0-9]+:/g) ?? []];
  assert.notEqual(invalid.status, 0, `the invalid consumer must not compile:\n${invalid.output}`);
  assert.ok(diagnosed.length >= 5, `every invalid use is diagnosed (${diagnosed.length} diagnostics):\n${invalid.output}`);
  assert.match(invalid.output, /agentStopped/, `the missing attestation claim is named:\n${invalid.output}`);
  assert.match(invalid.output, /executionMode|MANUAL/, `the wrong execution mode is named:\n${invalid.output}`);
  assert.match(invalid.output, /runRoot/, `the missing run root is named:\n${invalid.output}`);
  /* A capability typed as the literal false has no wording that names itself, so
   * the proof is positional: the diagnostic lands on the very line that claims
   * the halt. That is the assertion a reader can check against the source. */
  const claimedHaltLine = invalidSource.split('\n').findIndex((line) => line.includes('halt: true')) + 1;
  assert.ok(claimedHaltLine > 0, 'the invalid consumer really contains the claimed halt');
  assert.match(invalid.output, new RegExp(`invalid\\.mts\\(${claimedHaltLine},`), `the claimed halt capability is refused on its own line (${claimedHaltLine}):\n${invalid.output}`);
});

test('the operational schemas are Draft 2020-12 and describe the persisted records', async (t) => {
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const read = (name) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schemas', name), 'utf8'));
  const stateSchema = read('lifecycle.schema.json');
  const eventSchema = read('run-event.schema.json');
  assert.equal(stateSchema.$schema, 'https://json-schema.org/draft/2020-12/schema', 'the state schema is Draft 2020-12');
  assert.equal(eventSchema.$schema, 'https://json-schema.org/draft/2020-12/schema', 'the event schema is Draft 2020-12');
  for (const schema of [stateSchema, eventSchema]) {
    assert.equal(schema.$id.startsWith('https://benchboard.local.neutral/schemas/'), true, 'the schema is addressed under the project namespace');
    assert.equal(schema.additionalProperties, false, 'the record shape is closed');
  }
  /* The C3 operational schemas are new. They share no identity with the
   * immutable C1 run and submission schemas, which describe what was submitted
   * rather than when a lifecycle operation was journaled. */
  for (const name of ['run.schema.json', 'submission.schema.json']) {
    if (!fs.existsSync(path.join(REPO_ROOT, 'schemas', name))) continue;
    assert.notEqual(read(name).$id, stateSchema.$id, `the state schema shares no $id with ${name}`);
    assert.notEqual(read(name).$id, eventSchema.$id, `the event schema shares no $id with ${name}`);
  }
  const validateState = ajv.compile(stateSchema);
  const validateEvent = ajv.compile(eventSchema);
  assert.equal(validateState.errors, null, `the state schema compiles clean: ${JSON.stringify(validateState.errors)}`);
  assert.equal(validateEvent.errors, null, `the event schema compiles clean: ${JSON.stringify(validateEvent.errors)}`);

  /* A validator that never refuses a broken schema is not a gate, so the clean
   * compile above is only a statement because the strict compiler is shown to
   * reject a defective one. The shipped schemas are proven clean against a
   * compiler that demonstrably notices an unresolvable reference and a keyword
   * that does not exist. */
  const refusedSchema = (label, broken) => {
    let thrown = null;
    try { new Ajv2020({ strict: true, allErrors: true }).compile(broken); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof Error, `${label} must be refused by the strict compiler`);
  };
  refusedSchema('a schema whose reference resolves to nothing', { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://benchboard.local.neutral/schemas/malformed-reference.json', $ref: '#/$defs/not-defined-here' });
  refusedSchema('a schema carrying a keyword that does not exist', { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://benchboard.local.neutral/schemas/malformed-keyword.json', requiredProperties: ['state'] });
  refusedSchema('a schema that states a type that is not a type', { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://benchboard.local.neutral/schemas/malformed-type.json', type: 'object', properties: { state: { type: 'stringg' } } });

  const container = await buildContainer(t, 'schema-parity');
  const started = await startRun({ ...container.request, declaration: declaration() });
  const stopped = await stopRun({ ...container.request, attestation: attestation() });

  /* Parity is asserted against the bytes on disk, which is what a reader that
   * only holds the schema would have to work with. */
  const stateBytes = JSON.parse(fs.readFileSync(path.join(container.stateRoot, LIFECYCLE_STATE_RELATIVE_PATH), 'utf8')).value;
  const eventBytes = JSON.parse(fs.readFileSync(path.join(container.stateRoot, LIFECYCLE_JOURNAL_DIRECTORY, '00000.json'), 'utf8')).value;
  assert.equal(validateState(stateBytes), true, `the persisted state record satisfies the state schema: ${JSON.stringify(validateState.errors)}`);
  assert.equal(validateEvent(eventBytes), true, `the journaled event satisfies the event schema: ${JSON.stringify(validateEvent.errors)}`);

  /* Parity of coverage, in both directions and with the right kind of claim.
   * The event schema describes the union of every kind's shape, so a single
   * entry legitimately carries a subset; what must never happen is a field the
   * module persists that no schema describes (that would pass only because the
   * shape is open), or a described field that nothing ever persists. Every
   * persisted entry of every kind is checked, so the union is covered by the
   * set of entries rather than by any one of them. */
  const describedKeys = (schema) => new Set(Object.keys(schema.properties));
  const checkCoverage = (label, persisted, schema) => {
    const described = describedKeys(schema);
    for (const key of Object.keys(persisted)) {
      assert.ok(described.has(key), `the ${label} schema describes the persisted field ${key}`);
    }
    for (const key of schema.required) {
      assert.ok(Object.hasOwn(persisted, key), `a ${label} record always carries the required field ${key}`);
    }
  };
  checkCoverage('state', stateBytes, stateSchema);
  /* Walk the whole journal so every kind that was written is covered. */
  const journalDirectory = path.join(container.stateRoot, LIFECYCLE_JOURNAL_DIRECTORY);
  const journaled = fs.readdirSync(journalDirectory).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(fs.readFileSync(path.join(journalDirectory, name), 'utf8')).value);
  assert.ok(journaled.length >= 2, `the journal has entries to check (${journaled.length})`);
  const coveredByJournal = new Set();
  for (const entry of journaled) {
    checkCoverage('event', entry, eventSchema);
    assert.equal(validateEvent(entry), true, `the journaled ${entry.kind} entry satisfies the event schema: ${JSON.stringify(validateEvent.errors)}`);
    for (const key of Object.keys(entry)) coveredByJournal.add(key);
  }
  const neverPersisted = [...describedKeys(eventSchema)].filter((key) => !coveredByJournal.has(key));
  assert.deepEqual(neverPersisted, [], 'every field the event schema describes is persisted by some kind of entry');
  const neverPersistedInState = [...describedKeys(stateSchema)].filter((key) => !Object.hasOwn(stateBytes, key));
  assert.deepEqual(neverPersistedInState, [], 'every field the state schema describes is persisted by the state record');

  /* And the schema refuses what the module must refuse. A schema states a shape,
   * not an honesty policy: a fabricated but well-formed instant is schema-valid
   * precisely because detecting fabrication is the module's job, and the test
   * says so out loud so a reader is not misled into thinking the schema guards it. */
  const refused = (validate, value, what) => assert.equal(validate(value), false, `${what} must be refused: ${JSON.stringify(validate.errors)}`);
  const accepted = (validate, value, what) => assert.equal(validate(value), true, `${what} must be accepted: ${JSON.stringify(validate.errors)}`);
  refused(validateState, { ...stateBytes, state: 'RUNNING_TOO' }, 'an unknown state');
  accepted(validateState, { ...stateBytes, elapsedMs: 0 }, 'a legitimate elapsed of zero, which is a measurement and not an absence');
  accepted(validateState, { ...stateBytes, stoppedAt: '1970-01-01T00:00:00.000Z', elapsedMs: null }, 'a fabricated but well-formed instant, because the schema states a shape and not an honesty policy');
  refused(validateState, { ...stateBytes, stateDigest: 'z'.repeat(64) }, 'a malformed self digest');
  const { manifestDigest: _droppedManifestDigest, ...withoutManifestDigest } = stateBytes;
  refused(validateState, withoutManifestDigest, 'a state record with a required field dropped');
  /* The state domains beyond the field list: a record states who authored it,
   * what state it is in, and what authority that state needs. Each of these is a
   * contract the module enforces at the write seam, so a reader holding only the
   * schema has to be able to see the same rule, and each case below is a record
   * the module itself will not publish. */
  refused(validateState, { ...stateBytes, state: 'RUNNING', declaration: null }, 'a record that reports RUNNING with no declaration to author the start it reports');
  refused(validateState, { ...stateBytes, state: 'STOP_RECORDED', stopAttestation: null }, 'a record that reports a stop with no attestation to author it');
  refused(validateState, { ...stateBytes, state: 'FROZEN', stopAttestation: null }, 'a record that reports a freeze with no attestation behind the stop it rests on');
  accepted(validateState, { ...stateBytes, state: 'FROZEN', stopAttestation: attestation() }, 'a frozen record that carries its attested statement, which is the clockless route where the assurance is still null');
  refused(validateState, { ...stateBytes, state: 'FROZEN', stopAttestation: { ...attestation(), agentStopped: false } }, 'an attestation that does not attest that the agents stopped');
  refused(validateState, { ...stateBytes, state: 'FROZEN', stopAttestation: { ...attestation(), witness: 'somebody else' } }, 'an attestation carrying a field the attestation does not declare');
  refused(validateState, { ...stateBytes, history: [{ at: '2026-04-01T09:05:00.000Z', operation: 'TELEPORT' }] }, 'a history entry for an operation this contract is not able to perform');
  refused(validateEvent, { ...eventBytes, previousEventDigest: 'a'.repeat(63) }, 'a predecessor binding that is not a full digest');
  accepted(validateEvent, { ...eventBytes, kind: 'FREEZE_INTENT', detail: { operator: 'ops-desk', agentStopped: true, statement: 'nothing was started and nothing is running', observedAt: null, assurance: 'operator-attested', enforced: false, clockless: true } }, 'a journal opening with a clockless freeze intent that carries its attestation');
  refused(validateEvent, { ...eventBytes, kind: 'FREEZE_INTENT', detail: { operator: 'ops-desk', agentStopped: true, statement: 'nothing was started and nothing is running', assurance: 'operator-attested', enforced: false, clockless: true } }, 'a freeze intent that leaves its witnessed instant unstated instead of stating it as unknown');
  refused(validateEvent, { ...eventBytes, kind: 'FREEZE_INTENT', detail: { operator: 'ops-desk', clockless: true } }, 'a freeze intent that names an operator but states no attested fact');
  refused(validateEvent, { ...eventBytes, kind: 'FREEZE_INTENT' }, 'a freeze intent with no detail at all');
  /* The freeze intent wire contract in both directions. The route the entry
   * authorises is a statement it makes, so `false` is as legitimate a value as
   * `true` and an omitted route is as unacceptable as an omitted instant: a
   * reader holding only the schema must be able to see that an intent stating
   * nothing about the route is not the same entry as one stating the bound route. */
  const intentWire = { operator: 'ops-desk', agentStopped: true, statement: 'the cooperating participants stopped of their own cooperation', observedAt: '2026-04-01T09:20:00.000Z', assurance: 'operator-attested', enforced: false };
  accepted(validateEvent, { ...eventBytes, kind: 'FREEZE_INTENT', detail: { ...intentWire, clockless: false } }, 'a freeze intent that states the bound route over a journaled stop');
  accepted(validateEvent, { ...eventBytes, kind: 'FREEZE_INTENT', detail: { ...intentWire, observedAt: null, clockless: true } }, 'a clockless freeze intent that states no instant because none was observed');
  const { clockless: _droppedRoute, ...intentWithoutRoute } = { ...intentWire, clockless: false };
  refused(validateEvent, { ...eventBytes, kind: 'FREEZE_INTENT', detail: intentWithoutRoute }, 'a freeze intent that omits the route it authorises instead of stating it');
  refused(validateEvent, { ...eventBytes, kind: 'FREEZE_INTENT', detail: { ...intentWire, clockless: 'false' } }, 'a freeze intent whose route is stated as something other than a boolean');
  refused(validateEvent, { ...eventBytes, kind: 'STOP_RECORDED', detail: { operator: 'ops-desk', agentStopped: true, statement: 'the cooperating participants stopped of their own cooperation', assurance: 'operator-attested', enforced: false } }, 'a journaled stop that omits the witnessed instant instead of stating it as unknown');
  /* Every commit binds the projection it commits. There is no kind of commit and
   * no shape of entry the digest may be waived for, so both commit kinds are
   * tested rather than only the one that happened to be written wrong. */
  for (const commitKind of ['START_COMMIT', 'FREEZE_COMMIT']) {
    const { detail: _droppedDetail, ...commitWithoutDetail } = eventBytes;
    refused(validateEvent, { ...commitWithoutDetail, kind: commitKind }, `a ${commitKind} entry with no detail to bind the projection in`);
    refused(validateEvent, { ...commitWithoutDetail, kind: commitKind, detail: { operator: 'ops-desk' } }, `a ${commitKind} entry that names an operator but binds no projection digest`);
    refused(validateEvent, { ...commitWithoutDetail, kind: commitKind, detail: { stateEventDigest: 'a'.repeat(63) } }, `a ${commitKind} entry whose bound digest is not a full one`);
  }
  refused(validateEvent, { ...eventBytes, kind: 'STOP_RECORDED' }, 'a stop entry without its attestation detail');
  const { declaration: _droppedDeclaration, ...startWithoutDeclaration } = eventBytes;
  refused(validateEvent, startWithoutDeclaration, 'a start entry without the declaration it binds');
  refused(validateEvent, { ...eventBytes, unexpected: 1 }, 'an un-described field on a journaled entry');
});

/* ========================================================================== */
/* Write-seam integrity and the validated state projection (C3 T10)             */
/* ========================================================================== */

/* The independent published envelope used by the projection tests below.
 *
 * These bytes are built here, key by key, from the shape the module documents —
 * deliberately NOT copied out of a run the module just produced. A fixture that
 * is lifted out of production output inherits production's own blind spot, so a
 * tampering this suite is meant to catch could be encoded into the fixture and
 * go undetected. Building it independently is what makes "an invalid self digest
 * is a real core failure" testable rather than self-confirming. */
function publishedStateRecord(overrides = {}) {
  const record = {
    schemaVersion: '1.0.0',
    kind: LIFECYCLE_STATE_KIND,
    module: 'benchboard-core-lifecycle-v1',
    runId: 'run-state-validation-001',
    manifestId: 'manifest-state-validation-001',
    manifestDigest: null,
    state: 'RUNNING',
    declaration: declaration(),
    startedAt: '2026-04-01T09:05:00.000Z',
    stoppedAt: null,
    elapsedMs: null,
    stopAssurance: null,
    stopAttestation: null,
    clockError: null,
    journalCommitAt: null,
    history: [{ operation: 'START', intentEventDigest: 'a'.repeat(64) }],
    hashAlgorithm: 'sha256',
    stateDigest: '',
    ...overrides,
  };
  record.stateDigest = lifecycleStateDigestOf(record);
  return record;
}

/** Stage one exact state record into the container as its storage value. */
async function stageState(container, record) {
  const storage = createStorage({ root: container.stateRoot });
  await storage.withLock(() => storage.replaceMutable({
    relativePath: LIFECYCLE_STATE_RELATIVE_PATH,
    kind: LIFECYCLE_STATE_KIND,
    id: `${container.manifestId}:lifecycle-state`,
    value: record,
  }));
}

/** The raw state file bytes, so "no new write" can be proved byte-exactly. */
function stateFileBytes(container) {
  return fs.readFileSync(path.join(container.stateRoot, LIFECYCLE_STATE_RELATIVE_PATH));
}

/** The journal file names currently on disk. */
function journalFileNames(container) {
  const directory = path.join(container.stateRoot, LIFECYCLE_JOURNAL_DIRECTORY);
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

/**
 * A run whose projection claims a start that was never journaled: the storage is
 * byte-consistent (the self digest recomputes) and the journal is empty, so the
 * only thing wrong is that the record was never produced by the journal. This is
 * the storage-consistent tampering the prior suite never staged — the earlier
 * version mutated an in-memory clone, which no read ever saw.
 */
async function buildFalsifiedContainer(t, name) {
  const container = await buildContainer(t, name, {
    manifestId: 'manifest-state-validation-001',
    runId: 'run-state-validation-001',
  });
  await stageState(container, publishedStateRecord());
  return container;
}

test('a storage-consistent state record with a false self digest is refused before it is reported or used', async (t) => {
  /* The falsification this test exists for: a record that recomputes its own
   * digest but asserts a history the journal does not carry. Every field the
   * envelope claims is in place, so nothing but the recomputation itself — plus
   * the journal comparison — can tell it apart. */
  const container = await buildFalsifiedContainer(t, 'state-false-claim');
  const before = stateFileBytes(container);
  const beforeJournal = journalFileNames(container);

  const read = await expectCode(
    readRunLifecycle(container.request),
    LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED,
    'a read of a projection the journal does not author',
  );
  assert.match(read.message, /projection/i, 'the refusal says the projection is not authored');

  await expectCode(
    startRun({ ...container.request, declaration: declaration() }),
    LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,
    'a start over an unauthorable projection',
  );
  await expectCode(
    stopRun({ ...container.request, attestation: attestation() }),
    LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,
    'a stop over an unauthorable projection',
  );
  await expectCode(
    reconcileRun({ ...container.request, interruptedOperation: 'START', disposition: { operator: 'operator-one', decision: 'COMPLETE', attestation: 'the operator states the start completed' } }),
    LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,
    'a reconciliation over an unauthorable projection',
  );

  assert.deepEqual([...journalFileNames(container)], beforeJournal, 'no journal entry was added by the refused operations');
  assert.deepEqual([...stateFileBytes(container)], [...before], 'the tampered projection is preserved byte-for-byte, not repaired');
});

test('a state record whose stored self digest does not recompute is refused as corrupt', async (t) => {
  const container = await buildContainer(t, 'state-bad-digest', {
    manifestId: 'manifest-state-validation-001',
    runId: 'run-state-validation-001',
  });
  const record = publishedStateRecord();
  record.stateDigest = 'f'.repeat(64);
  await stageState(container, record);
  const before = stateFileBytes(container);
  const beforeJournal = journalFileNames(container);

  const error = await expectCode(
    readRunLifecycle(container.request),
    LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED,
    'a projection that fails its recomputed self digest',
  );
  assert.match(error.message, /digest/i, 'the refusal names the digest check that failed');
  await expectCode(
    startRun({ ...container.request, declaration: declaration() }),
    LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,
    'a start over a corrupt projection',
  );
  assert.deepEqual([...journalFileNames(container)], beforeJournal, 'nothing was journaled');
  assert.deepEqual([...stateFileBytes(container)], [...before], 'the corrupt projection is preserved, never overwritten');
});

test('a state record with an unknown field, a foreign kind or another run identity is refused', async (t) => {
  const shapes = [
    { name: 'unknown-field', label: 'an envelope field the schema does not describe', mutate: (record) => ({ ...record, extra: true }) },
    { name: 'foreign-kind', label: 'a record of a different kind at the state path', mutate: (record) => ({ ...record, kind: 'benchboard.something.else.v1' }) },
    { name: 'other-run', label: 'a record bound to a different run', mutate: (record) => ({ ...record, runId: 'run-somewhere-else-001' }) },
    { name: 'foreign-module', label: 'a record written by a different implementation', mutate: (record) => ({ ...record, module: 'benchboard-core-lifecycle-v9' }) },
  ];
  for (const shape of shapes) {
    const container = await buildContainer(t, `state-shape-${shape.name}`, {
      manifestId: 'manifest-state-validation-001',
      runId: 'run-state-validation-001',
    });
    const base = publishedStateRecord();
    const mutated = shape.mutate(base);
    /* Keep the self digest correct for the mutated bytes: only the structural
     * defect may be the reason this is refused, never a stale digest. */
    mutated.stateDigest = lifecycleStateDigestOf(mutated);
    await stageState(container, mutated);
    const error = await expectCode(
      readRunLifecycle(container.request),
      LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED,
      `a read of ${shape.label}`,
    );
    assert.ok(error.message.length > 0, `the refusal for ${shape.name} says why`);
  }
});

test('an arbitrary callback cannot fabricate a stop, a commit, a projection, or skip an intent', async (t) => {
  const container = await buildContainer(t, 'seam-fabrication');
  await startRun({ ...container.request, declaration: declaration() });
  const before = captureTree(container.runRoot);

  /* A stop is an observation of a real halt, so the seam will not write one from
   * a bare field set. */
  await expectCode(
    withRunTransaction(container.request, async (context) => context.commitState({ state: 'STOP_RECORDED', stoppedAt: '2026-04-01T09:20:00.000Z', historyEntry: { operation: 'STOP' } })),
    LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID,
    'a projection that states a stop with no attested stop',
  );
  /* A commit names the projection it commits; it cannot be appended free. */
  await expectCode(
    withRunTransaction(container.request, async (context) => context.appendEvent({ kind: 'START_COMMIT', occurredAt: null, journalCommitAt: null })),
    LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,
    'a START_COMMIT with nothing bound to it',
  );
  /* A second intent after the run has moved on is an out-of-order write. */
  await expectCode(
    withRunTransaction(container.request, async (context) => context.appendEvent({ kind: 'START_INTENT', occurredAt: null, journalCommitAt: null, declaration: declaration() })),
    LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,
    'a second START_INTENT after the run has started',
  );
  /* A stop event without the operator statement behind it is a fabrication. */
  await expectCode(
    withRunTransaction(container.request, async (context) => context.appendEvent({ kind: 'STOP_RECORDED', occurredAt: null, journalCommitAt: null })),
    LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID,
    'a journaled stop carrying no attestation block',
  );
  /* A freeze intent without its attestation or an explicit clockless route is
   * not an authorised intent. */
  await expectCode(
    withRunTransaction(container.request, async (context) => context.appendEvent({ kind: 'FREEZE_INTENT', occurredAt: null, journalCommitAt: null })),
    LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID,
    'a freeze intent that states neither an attestation nor the clockless route',
  );

  const after = captureTree(container.runRoot);
  assert.deepEqual(
    [...after.keys()].sort(),
    [...before.keys()].sort(),
    'the refused fabrications added no file anywhere under the run root',
  );
  for (const [name, bytes] of after) {
    assert.deepEqual([...bytes], [...(before.get(name) ?? new Uint8Array())], `${name}: its bytes are unchanged`);
  }
  const view = await readRunLifecycle(container.request);
  assert.equal(view.state, 'RUNNING', 'the run is exactly where it was before the attempts');
});

test('every journaled commit binds the projection digest it commits, including a reconciled one', async (t) => {
  const container = await buildContainer(t, 'commit-binds-projection');
  await writeInterruptedStart(container, { declarationValue: declaration() });
  const repaired = await reconcileRun({
    ...container.request,
    interruptedOperation: 'START',
    disposition: { operator: 'operator-one', decision: 'COMPLETE', attestation: 'the operator states the start completed' },
  });
  assert.equal(repaired.diagnosis, 'repaired', 'the interrupted start is completed from the journaled bytes');
  const view = await readRunLifecycle(container.request);
  const commit = view.journal.events.find((event) => event.kind === 'START_COMMIT');
  assert.equal(commit !== void 0, true, 'the reconciliation appended the commit');
  assert.equal(commit.detail.reconciliation, true, 'and it says it came from reconciliation');
  assert.equal(typeof commit.detail.stateEventDigest, 'string', 'a commit without a bound projection digest is not a commit');
  assert.equal(commit.detail.stateEventDigest, view.lifecycle.stateDigest, 'the bound digest is the projection that is read back');
});

test('a stop projection may not be published before its journaled stop', async (t) => {
  const container = await buildContainer(t, 'stop-before-journal');
  await startRun({ ...container.request, declaration: declaration() });
  const before = captureTree(container.runRoot);
  await expectCode(
    withRunTransaction(container.request, async (context) => context.commitState({
      state: 'STOP_RECORDED',
      stoppedAt: '2026-04-01T09:20:00.000Z',
      stopAttestation: attestation(),
      historyEntry: { operation: 'STOP', stopEventDigest: 'b'.repeat(64) },
    })),
    LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,
    'the projection of a stop the authority does not carry',
  );
  const after = captureTree(container.runRoot);
  for (const name of after.keys()) {
    assert.deepEqual([...after.get(name)], [...(before.get(name) ?? new Uint8Array())], `${name}: byte-for-byte preserved`);
  }
});

test('a persisted frozen projection with no journaled intent is refused on read and on command', async (t) => {
  /* A freeze is the act that closes a run and makes its bytes a submission, and
   * the released route journals its intent before it commits anything. So a
   * FROZEN projection over a journal that carries no FREEZE_INTENT is not a
   * lagging view of a real freeze: it is a fabricated submission. The write seam
   * will not publish it (see the two gate tests above), so the only way it can
   * exist on disk is an external rewrite of the projection bytes — staged here
   * with the self digest recomputed, so the digest check cannot be what fires
   * and only the authority comparison can. The read refuses to report it and a
   * command over it is sent to the explicit reconciliation route; the stored
   * bytes are preserved rather than repaired. */
  const container = await buildContainer(t, 'state-frozen-without-intent', {
    manifestId: 'manifest-state-validation-001',
    runId: 'run-state-validation-001',
  });
  await stageState(container, publishedStateRecord({
    state: 'FROZEN',
    stoppedAt: '2026-04-01T09:20:00.000Z',
    stopAssurance: null,
    stopAttestation: structuredClone(attestation()),
  }));
  const before = stateFileBytes(container);
  const beforeJournal = journalFileNames(container);
  assert.deepEqual(beforeJournal, [], 'the journal carries no freeze intent, and indeed no event at all');

  const read = await expectCode(
    readRunLifecycle(container.request),
    LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED,
    'a read of a frozen projection the authority does not author',
  );
  assert.match(read.message, /FREEZE_INTENT|schema|contract/, 'the malformed or unauthored projection is refused');

  await expectCode(
    startRun({ ...container.request, declaration: declaration() }),
    LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,
    'a start over a fabricated submission',
  );
  await expectCode(
    stopRun({ ...container.request, attestation: attestation() }),
    LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,
    'a stop over a fabricated submission',
  );
  await expectCode(
    withRunTransaction(container.request, async (context) => context.appendEvent({ kind: 'FREEZE_COMMIT', occurredAt: null, journalCommitAt: null, detail: { stateEventDigest: 'c'.repeat(64) } })),
    LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,
    'a commit that would seal the fabrication',
  );

  assert.deepEqual([...journalFileNames(container)], beforeJournal, 'no refused operation journaled anything');
  assert.deepEqual([...stateFileBytes(container)], [...before], 'the fabricated projection is preserved byte-for-byte, not repaired');
});

test('the module exposes no way to signal, launch or halt anything', async () => {
  const source = fs.readFileSync(new URL('../../packages/core/lifecycle.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['node:child_process', 'node:worker_threads', 'node:cluster', 'node:net', 'node:http', 'process.kill', '.kill(', 'SIGKILL', 'SIGTERM', 'Signal']) {
    assert.equal(source.includes(forbidden), false, `the lifecycle module must not reference ${forbidden}`);
  }
  const exported = await import('../../packages/core/lifecycle.mjs');
  for (const name of Object.keys(exported)) {
    assert.equal(/halt|kill|terminate|launch|spawn|signal/i.test(name), false, `no exported name may claim control of a process (${name})`);
  }
  assert.match(STOP_ASSURANCE, /attested/, 'the stop assurance is an attestation');
  assert.equal(STOP_ENFORCED, false, 'recording a stop enforces nothing');
});



function retainedTree(root){const out={};for(const name of fs.readdirSync(root,{recursive:true}).sort()){const p=path.join(root,name);const stat=fs.lstatSync(p);out[name]=stat.isFile()?fs.readFileSync(p).toString('base64'):stat.isDirectory()?'directory':'link-or-special';}return out;}
test('public transaction capability never exposes raw storage writers',async t=>{
 for(const name of ['createImmutable','replaceMutable','write','remove','delete','reserve','withLock']){
  const c=await buildContainer(t,'public-writer-'+name);const before=retainedTree(c.stateRoot);
  const error=await rejection(withRunTransaction(c.request,async context=>{
   assert.equal(context.storage[name],undefined,'raw writer capability is absent');
   await context.storage[name]({relativePath:'lifecycle/state.json',kind:LIFECYCLE_STATE_KIND,id:c.manifestId+':lifecycle-state',value:{state:'FROZEN'}});
  }));assert.ok(error);assert.deepEqual(retainedTree(c.stateRoot),before);
 }
});

test('runtime result keys and typed consumers describe the actual operation shapes',async t=>{
 const c=await buildContainer(t,'runtime-type-parity');
 const opened=await openRun(c.request);assert.deepEqual(Object.keys(opened).sort(),['runRoot','stateRoot','workspaceRoot','runId','manifestId','manifestDigest','manifest','operationName'].sort());
 const started=await startRun({...c.request,declaration:declaration()});assert.deepEqual(Object.keys(started.journal).sort(),['entryCount','events','foreignEntries'].sort());assert.equal(Object.hasOwn(started,'diagnosis'),false);
 const stopped=await stopRun({...c.request,attestation:attestation()});assert.equal(stopped.enforced,false);assert.equal(Object.hasOwn(stopped,'findings'),false);
 const read=await readRunLifecycle(c.request);assert.equal(typeof read.diagnosis,'string');assert.ok(Array.isArray(read.findings));
 const reconciliation=await reconcileRun({...c.request,interruptedOperation:'START',disposition:{operator:'ops-desk',decision:'LEAVE_AS_IS',attestation:'leave the complete run unchanged'}});assert.deepEqual(Object.keys(reconciliation).sort(),['runId','manifestId','diagnosis','action','note','findings','state','history'].sort());assert.equal(Object.hasOwn(reconciliation,'journal'),false);
 const value=await withRunTransaction(c.request,()=>({value:42}));assert.deepEqual(value,{value:42});assert.deepEqual(readClockReading({now:()=>null}),{ok:true,ms:null});
 const core=fileURLToPath(new URL('../../packages/core/lifecycle.mjs',import.meta.url)).split(path.sep).join('/');
 const source='import * as core from '+JSON.stringify(core)+';\nexport async function consume(request:core.RunLifecycleRequest){const opened=await core.openRun(request);const root:string=opened.stateRoot;const binding=opened.manifest;const read=await core.readRunLifecycle(request);const fields:readonly string[]=read.journal.foreignEntries;const findings:readonly string[]=read.findings;const r=await core.reconcileRun({...request,interruptedOperation:"START",disposition:{operator:"ops-desk",decision:"LEAVE_AS_IS",attestation:"leave it unchanged"}});const action:string=r.action;const note:string=r.note;const value:number=await core.withRunTransaction(request,()=>7);const clock=core.readClockReading({now:()=>null},null);if(clock.ok){const ms:number|null=clock.ms;}return [root,binding,fields,findings,action,note,value];}\n';
 const compiled=compileConsumer(t,'actual-result-fields.mts',source);assert.equal(compiled.status,0,compiled.output);
});

test('event schema requires true stop claims and proof schema requires the exact selection policy',async t=>{
 const ajvModule=await import('ajv/dist/2020.js');const Ajv=ajvModule.default;const ajv=new Ajv({strict:true});const schema=JSON.parse(fs.readFileSync(new URL('../../schemas/run-event.schema.json',import.meta.url)));const validate=ajv.compile(schema);const c=await buildContainer(t,'schema-domain-negatives');await startRun({...c.request,declaration:declaration()});await stopRun({...c.request,attestation:attestation()});const view=await readRunLifecycle(c.request);const stop=view.journal.events.find(e=>e.kind==='STOP_RECORDED');assert.equal(validate(stop),true);const falseClaim=structuredClone(stop);falseClaim.detail.agentStopped=false;assert.equal(validate(falseClaim),false);
 const proofSchema=JSON.parse(fs.readFileSync(new URL('../../schemas/snapshot-proof.schema.json',import.meta.url)));assert.deepEqual(proofSchema.properties.selectionExclusions.const,['.git','node_modules','dist','.agent-teams','.benchboard','.cache','coverage','.vite']);
 const policy=ajv.compile(proofSchema.properties.selectionExclusions);const list=proofSchema.properties.selectionExclusions.const;assert.equal(policy(list),true);for(const invalid of [list.slice(1),[...list,list[0]],[...list].reverse(),[...list,'private-extra']])assert.equal(policy(invalid),false);
});

test('checked callback cannot stop an interrupted post-projection start before its start commit',async t=>{
 const c=await buildContainer(t,'interrupted-start-order');await withRunTransaction(c.request,async context=>{await context.appendEvent({kind:'START_INTENT',occurredAt:null,journalCommitAt:null,declaration:declaration()});await context.commitState({state:'RUNNING',declaration:declaration(),startedAt:null,historyEntry:{operation:'START'}});});const before=captureTree(c.runRoot);
 await expectCode(withRunTransaction(c.request,async context=>{await context.appendEvent({kind:'STOP_RECORDED',occurredAt:null,journalCommitAt:null,declaration:context.lifecycle.declaration,detail:{operator:'ops-desk',agentStopped:true,statement:'it stopped',observedAt:null,assurance:'operator-attested',enforced:false}});await context.commitState({state:'STOP_RECORDED',stopAttestation:attestation(),historyEntry:{operation:'STOP'}});await context.appendEvent({kind:'START_COMMIT',occurredAt:null,journalCommitAt:null,declaration:context.lifecycle.declaration,detail:{stateEventDigest:context.lifecycle.stateDigest}});}),LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,'STOP before START_COMMIT is not legal authority');assert.deepEqual(captureTree(c.runRoot),before);
});

test('checked callback rejects wrong-kind known fields and unbound reconciliation tuples before writes',async t=>{
 const c=await buildContainer(t,'closed-kind-callback');const before=captureTree(c.runRoot);await assert.rejects(withRunTransaction(c.request,context=>context.appendEvent({kind:'START_INTENT',occurredAt:null,declaration:declaration(),detail:{operator:'ops-desk'}})));assert.deepEqual(captureTree(c.runRoot),before);
 await withRunTransaction(c.request,async context=>{await context.appendEvent({kind:'START_INTENT',occurredAt:null,declaration:declaration()});await context.commitState({state:'RUNNING',declaration:declaration(),historyEntry:{operation:'START'}});});
 for(const bad of [{operator:'ops-desk'},{completedFromIntentDigest:'a'.repeat(64)},{reconciliation:false},{reconciliation:true,operator:'ops-desk'},{reconciliation:true,completedFromIntentDigest:'a'.repeat(64)},{reconciliation:true,operator:'ops-desk',completedFromIntentDigest:'a'.repeat(64)}]){const b=captureTree(c.runRoot);await assert.rejects(withRunTransaction(c.request,context=>context.appendEvent({kind:'START_COMMIT',occurredAt:null,declaration:context.lifecycle.declaration,detail:{stateEventDigest:context.lifecycle.stateDigest,...bad}})));assert.deepEqual(captureTree(c.runRoot),b);}
 const frozen=await buildContainer(t,'freeze-closed-kind');await withRunTransaction(frozen.request,async context=>{const value={...attestation(),clockless:true};await journalFreezeIntent(context,value);await context.commitState({state:'FROZEN',stopAttestation:value});});
 for(const bad of [{operator:'ops-desk'},{reconciliation:true,operator:'ops-desk',completedFromIntentDigest:'a'.repeat(64)}]){const b=captureTree(frozen.runRoot);await assert.rejects(withRunTransaction(frozen.request,context=>context.appendEvent({kind:'FREEZE_COMMIT',occurredAt:null,detail:{stateEventDigest:context.lifecycle.stateDigest,...bad}})));assert.deepEqual(captureTree(frozen.runRoot),b);}
});
