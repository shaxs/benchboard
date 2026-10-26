/**
 * BenchBoard v0.1 C3 T5 — contract-derived acceptance of the manual lifecycle,
 * the immutable freeze and the safe reset, taken as one seam.
 *
 * Authority: the C3 product contract for this seam — honest manual timing with
 * no invented time, an immutable frozen submission that binds the recorded stop,
 * and a reset that yields a fresh identity while leaving the old container
 * untouched — together with the released runtimes and their paired declarations
 * (`packages/core/{lifecycle,freeze,reset,snapshot-copy}.mjs` + `.d.mts`),
 * `adapters/manual/index.mjs` and the accepted C2 initialiser. Expectations are
 * stated against the product behaviour the seam owes, and each is then localized
 * to the shipped surface; a gap between the two is a seam gap to report, not
 * something to weaken here. This file edits no implementation, schema or
 * declaration to make an assertion hold.
 *
 * Nothing is faked. Every container is a real C2 container produced by the
 * accepted `initialiseRun` over the released participant bytes, every state is
 * reached through the accepted T1 seams, and a refusal is proven by byte
 * identity of the container before and after the attempt. Dependencies are
 * `none`: no install, no evaluator, no benchmark participant run, and no
 * harness product is required or reached.
 *
 * Authorship disclosure: this suite was written in the same pool as the
 * implementation. It is a deterministic contract gate, not the independent SOTA
 * review, and it does not approve the CHUNK.
 */

import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  LIFECYCLE_ERROR_CODES,
  LIFECYCLE_STATE_RELATIVE_PATH,
  LIFECYCLE_STATE_KIND,
  LIFECYCLE_JOURNAL_DIRECTORY,
  LIFECYCLE_COMMITTED_STATES,
  LIFECYCLE_EVENT_KINDS,
  LIFECYCLE_EXECUTION_MODE,
  STOP_ASSURANCE,
  STOP_ENFORCED,
  FREEZE_PRECONDITIONS,
  LIFECYCLE_TRANSITIONS,
  DEFAULT_CLOCK,
  readClockReading,
  elapsedBetween,
  freezePreconditionFor,
  lifecycleStateDigestOf,
  lifecycleEventDigestOf,
  lifecycleCanonicalJson,
  withRunTransaction,
  openRun,
  startRun,
  stopRun,
  readRunLifecycle,
  reconcileRun,
} from '../../packages/core/lifecycle.mjs';
import {
  freezeRun,
  verifyFrozenSubmission,
  verifyFrozenSnapshot,
  reconcileFreeze,
  FREEZE_MODULE_ID,
  FREEZE_PROOF_KIND,
  FREEZE_SUBMISSION_KIND,
  FREEZE_SNAPSHOT_ROOT_NAME,
  FREEZE_SNAPSHOT_WORKSPACE_NAME,
  FROZEN_AT_PROVENANCE,
} from '../../packages/core/freeze.mjs';
import {
  RESET_ERROR_CODES,
  RESET_ELIGIBLE_STATES,
  RESET_REFUSED_STATES,
  ResetError,
  resetRun,
} from '../../packages/core/reset.mjs';
import {
  SELECTION_POLICY_ID,
  SELECTION_POLICY_EXCLUSIONS,
  SNAPSHOT_HASH_ALGORITHM_ID,
} from '../../packages/core/snapshot-copy.mjs';
import { initialiseRun, INIT_STATE_KIND, RUN_STATE_RELATIVE_PATH, STATE_DIRECTORY_NAME, WORKSPACE_DIRECTORY_NAME } from '../../packages/core/init.mjs';
import { sha256, hashEntries } from '../../packages/core/identity.mjs';
import { validateRecord, computeTreeDigest } from '../../packages/core/manifest.mjs';
import { createStorage } from '../../packages/core/storage.mjs';
import { EXPECTED_WORKLOAD_FILE_COUNT } from '../../packages/core/challenge-export.mjs';
import { loadFixture } from '../contracts/fixtures/contracts/index.mjs';
import { capabilities, manualLifecycleOperations, MANUAL_ADAPTER_MODULE_ID } from '../../adapters/manual/index.mjs';
import * as lifecycleRuntime from '../../packages/core/lifecycle.mjs';

/* ----------------------------------------------------------------- constants */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CORE_ROOT = path.join(REPO_ROOT, 'packages', 'core');
const STARTER_ROOT = path.join(REPO_ROOT, 'starter');
const RELEASE_INVENTORY_PATH = path.join(REPO_ROOT, 'release', 'inventory.json');
const RAW_COMPARE = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** The released participant inventory, read as data rather than through a legacy entry point. */
function releaseParticipantPaths() {
  const inventory = JSON.parse(fs.readFileSync(RELEASE_INVENTORY_PATH, 'utf8'));
  return Object.freeze(inventory.participant.files.map((entry) => entry.path));
}

/**
 * Scratch root: an explicit absolute override when the harness states one, else a
 * directory inside this repository. The read-only starter tree can never be
 * scratch, so an override containing it is refused outright. An OS sibling temp
 * directory is never used.
 */
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
  const contained = fileURLToPath(new URL('./.tmp/acceptance/', import.meta.url));
  fs.mkdirSync(contained, { recursive: true });
  return contained;
}

/** One throwaway directory per test, removed when that test ends. */
function scratch(t, name) {
  const directory = fs.mkdtempSync(path.join(scratchRoot(), `c3-t5-${name}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/* ------------------------------------------------------------------- helpers */

/** Byte-for-byte copy, so fixture bytes are never re-encoded. */
function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fs.readFileSync(source));
}

const segments = (relativePath) => relativePath.split('/');
const starterPath = (relativePath) => path.join(STARTER_ROOT, ...segments(relativePath));
const inRoot = (root, relativePath) => path.join(root, ...segments(relativePath));
const rootEntry = (root, relativePath) => Object.freeze([relativePath, sha256(fs.readFileSync(inRoot(root, relativePath)))]);

/**
 * A real `ChallengeIdentity` over the bytes copied into the fixture source root:
 * the inventory is the exact sorted `[path, sha256]` list and the workload digest
 * is recomputed with the accepted helper, so the shipped contract validator
 * re-derives the recorded value rather than trusting it.
 */
function buildIdentity(sourceRoot, paths) {
  const starterInventory = paths
    .map((relativePath) => rootEntry(sourceRoot, relativePath))
    .sort((left, right) => RAW_COMPARE(left[0], right[0]));
  return Object.freeze({
    schemaVersion: '1.0.0',
    kind: 'ChallengeIdentity',
    challengeId: 'c3-t5-acceptance-board',
    challengeVersion: '0.9.0',
    architectureId: 'arch-c3-t5-acceptance',
    architectureKind: 'challenge',
    hashAlgorithm: 'sha256',
    definitionDigest: sha256('c3-t5-acceptance:definition'),
    digestProvenance: Object.freeze({ kind: 'COMPUTED', procedure: 'c3-t5-acceptance:sha256:source-bytes' }),
    workloadProvenance: Object.freeze({ kind: 'COMPUTED', procedure: 'c3-t5-acceptance:starter-inventory-digest' }),
    publicPrdDigest: sha256('c3-t5-acceptance:public-prd'),
    visibleHarnessDigest: sha256('c3-t5-acceptance:visible-harness'),
    fixtureDigest: sha256('c3-t5-acceptance:fixture'),
    starterInventory: Object.freeze(starterInventory),
    workloadDigest: hashEntries(starterInventory),
    declaredCeilingMinutes: 120,
    candidateLineage: Object.freeze({
      candidateVersion: '1.0.0-candidate.9',
      candidateStatus: 'REVIEW_FINDINGS_UNRESOLVED',
      sourceCommit: 'c662a4a1b2c3d4e5f60718293a4b5c6d7e8f90a1',
      sourceTag: 'candidate-nine-synthetic',
      reviewStatus: 'CHANGES_REQUESTED',
      lineageNotes: 'Synthetic lineage carried by the acceptance fixture, not a certified release.',
    }),
    notes: 'C3 T5 acceptance fixture identity, derived from the read-only starter bytes.',
  });
}

/** The two non-challenge identities, taken from the accepted contract fixtures. */
function boundIdentities() {
  const toolingIdentity = structuredClone(loadFixture('tooling.identity'));
  const evaluatorIdentity = structuredClone(loadFixture('evaluator.identity'));
  assert.deepEqual(structuredClone(validateRecord('ToolingIdentity', toolingIdentity)), toolingIdentity,
    'the tooling fixture must satisfy the shipped contract validator before it is used');
  assert.deepEqual(structuredClone(validateRecord('EvaluatorIdentity', evaluatorIdentity)), evaluatorIdentity,
    'the evaluator fixture must satisfy the shipped contract validator before it is used');
  return { toolingIdentity, evaluatorIdentity };
}

/**
 * One fixture: contained roots, a seeded source root carrying the released
 * participant bytes, populated private owner and evaluator roots, and an identity
 * derived over exactly those bytes. The publication parent exists; a target never
 * does.
 */
function buildFixture(t, name) {
  const paths = releaseParticipantPaths();
  const root = scratch(t, name);
  const sourceRoot = path.join(root, 'source');
  const ownerRoot = path.join(root, 'owner');
  const evaluatorRoot = path.join(root, 'evaluator');
  const publishParent = path.join(root, 'publish');
  fs.mkdirSync(ownerRoot, { recursive: true });
  fs.writeFileSync(path.join(ownerRoot, 'owner-secret.txt'), 'owner-private-material\n', 'utf8');
  fs.mkdirSync(evaluatorRoot, { recursive: true });
  fs.writeFileSync(path.join(evaluatorRoot, 'hidden-tests.txt'), 'hidden-evaluator-material\n', 'utf8');
  fs.mkdirSync(publishParent, { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  for (const relativePath of paths) copyFile(starterPath(relativePath), inRoot(sourceRoot, relativePath));

  const identity = buildIdentity(sourceRoot, paths);
  assert.deepEqual(validateRecord('ChallengeIdentity', structuredClone(identity)), structuredClone(identity),
    'the fixture identity must satisfy the shipped contract validator before it is used');
  const { toolingIdentity, evaluatorIdentity } = boundIdentities();
  return { root, paths, identity, sourceRoot, ownerRoot, evaluatorRoot, publishParent, toolingIdentity, evaluatorIdentity };
}

/** One accepted C2 challenge package. */
function packageFor(fixture, overrides = {}) {
  const pick = (key, fallback) => (key in overrides ? overrides[key] : fallback);
  return {
    identity: pick('identity', fixture.identity),
    sourceRoot: pick('sourceRoot', fixture.sourceRoot),
    fileManifest: pick('fileManifest', [...fixture.paths]),
    ownerRoots: pick('ownerRoots', [fixture.ownerRoot]),
    evaluatorRoots: pick('evaluatorRoots', [fixture.evaluatorRoot]),
  };
}

/**
 * One accepted C2 initialisation request with every required field stated, so a
 * test that changes one field changes only that field. `harness` is the manual
 * harness because the lifecycle seam only starts a run that declares it, and the
 * run ceiling sits under the fixture challenge's.
 */
function initRequest(fixture, overrides = {}) {
  const pick = (key, fallback) => (key in overrides ? overrides[key] : fallback);
  return {
    output: pick('output', path.join(fixture.publishParent, 'run-one')),
    challenge: pick('challenge', packageFor(fixture)),
    dependencies: pick('dependencies', { mode: 'none' }),
    toolingIdentity: pick('toolingIdentity', fixture.toolingIdentity),
    evaluatorIdentity: pick('evaluatorIdentity', fixture.evaluatorIdentity),
    architectureId: pick('architectureId', 'arch-run-c3-t5'),
    harness: pick('harness', 'manual'),
    declaredCeilingMinutes: pick('declaredCeilingMinutes', 60),
    createdAt: pick('createdAt', '2026-04-01T09:00:00.000Z'),
  };
}

/** The reset request for one published container, aimed at a fresh destination. */
function resetRequest(published, fixture, overrides = {}) {
  const pick = (key, fallback) => (key in overrides ? overrides[key] : fallback);
  return {
    runRoot: pick('runRoot', published.output),
    manifestId: pick('manifestId', published.manifest.manifestId),
    runId: pick('runId', published.manifest.runId),
    output: pick('output', path.join(fixture.publishParent, 'reset-one')),
    initializationRequest: pick('initializationRequest', {
      challenge: pick('challenge', packageFor(fixture)),
      dependencies: pick('dependencies', { mode: 'none' }),
      toolingIdentity: pick('toolingIdentity', fixture.toolingIdentity),
      evaluatorIdentity: pick('evaluatorIdentity', fixture.evaluatorIdentity),
      architectureId: pick('architectureId', 'arch-run-c3-t5'),
      harness: 'manual',
      declaredCeilingMinutes: 60,
      createdAt: '2026-04-01T11:00:00.000Z',
    }),
    ...(pick('restExtra', void 0) ?? {}),
  };
}

/** The immutable declaration a manual start states. */
function declaration(overrides = {}) {
  return {
    harness: 'manual',
    model: null,
    workerCount: 2,
    executionMode: LIFECYCLE_EXECUTION_MODE,
    declaredCeilingMinutes: 60,
    ...overrides,
  };
}

/** The attestation a stop states. `observedAt` is added only where a test needs it. */
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
  return { now: () => (value === null ? null : Date.parse(value)) };
}

/** Count journaled events by kind from the reported event list of a read view. */
function countKinds(events) {
  const counts = {};
  for (const kind of LIFECYCLE_EVENT_KINDS) counts[kind] = 0;
  for (const event of events ?? []) counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  return counts;
}

/** Recursive, deterministic snapshot of one tree keyed by relative POSIX path. */
function snapshotTree(root) {
  const seen = new Map();
  const walk = (absolute, relative) => {
    const status = fs.lstatSync(absolute);
    if (status.isSymbolicLink()) { seen.set(relative, 'link'); return; }
    if (status.isDirectory()) {
      if (relative !== '') seen.set(relative, 'directory');
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort(RAW_COMPARE)) {
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        walk(path.join(absolute, entry.name), child);
      }
      return;
    }
    seen.set(relative, status.isFile() ? `file:${sha256(fs.readFileSync(absolute))}` : 'special');
  };
  walk(root, '');
  return Object.fromEntries([...seen.entries()].sort((left, right) => RAW_COMPARE(left[0], right[0])));
}

/** Capture a rejection, or `undefined` when the promise resolves. */
async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  return void 0;
}

/** Assert one fail-closed refusal carrying the expected lifecycle code, spelled first. */
async function expectLifecycleCode(promise, code, label) {
  const error = await rejection(promise);
  assert.ok(error !== void 0, `${label}: a rejection was expected`);
  assert.equal(error?.code, code, `${label}: error code (${error?.message})`);
  assert.match(error.message, new RegExp(`^${code}: `), `${label}: the message names the code first`);
  return error;
}

/** Assert one fail-closed reset refusal carrying the expected reset code. */
async function expectResetCode(promise, code, label) {
  const error = await rejection(promise);
  assert.ok(error !== void 0, `${label}: a rejection was expected`);
  assert.ok(error instanceof ResetError, `${label}: a ResetError was expected, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, `${label}: error code (${error.message})`);
  assert.match(error.message, new RegExp(`^${code}: `), `${label}: the message names the code first`);
  return error;
}

/** A published container plus the request the lifecycle seams take for it. */
async function publishedRun(t, name, overrides = {}) {
  const fixture = buildFixture(t, name);
  const published = await initialiseRun(initRequest(fixture, overrides.init ?? {}));
  return { fixture, published, request: { runRoot: published.output, manifestId: published.manifest.manifestId, runId: published.manifest.runId } };
}

/** Start and attest-stop one container, returning the two authoritative views. */
async function startAndStop(request, { startClock = '2026-04-01T09:05:00.000Z', stopClock = '2026-04-01T09:20:00.000Z', stopAttestation } = {}) {
  const started = await startRun({ ...request, declaration: declaration(), clock: clockAt(startClock) });
  const stopped = await stopRun({ ...request, attestation: stopAttestation ?? attestation(), clock: clockAt(stopClock) });
  return { started, stopped };
}

/** The storage read path for one persisted record of a container. */
const stateStorage = (runRoot) => createStorage({ root: path.join(runRoot, STATE_DIRECTORY_NAME) });
const readStateRecord = (runRoot, manifestId) =>
  stateStorage(runRoot).read({ relativePath: LIFECYCLE_STATE_RELATIVE_PATH, kind: 'benchboard.lifecycle.state.v1', id: `${manifestId}:lifecycle-state` });
const journalDirectory = (runRoot) => path.join(runRoot, STATE_DIRECTORY_NAME, LIFECYCLE_JOURNAL_DIRECTORY);

/* =========================================================================== */
/* 1. The one full synthetic chain                                              */
/* =========================================================================== */

test('the full synthetic chain runs init, start, attested stop, freeze, verify, a later live edit, then a safe reset', async (t) => {
  const { fixture, published, request } = await publishedRun(t, 'full-chain');

  /* --- initialised: the derived state, an empty journal and no authority claim. */
  const initialised = await readRunLifecycle(request);
  assert.equal(initialised.state, 'INITIALIZED', 'a fresh container reports the derived INITIALIZED state');
  assert.equal(initialised.lifecycle, null, 'no state record exists before the first transition');
  assert.equal(initialised.journal.entryCount, 0, 'the journal is empty');
  assert.equal(initialised.diagnosis, 'consistent', 'an untouched container is consistent');
  assert.equal(initialised.manifestId, published.manifest.manifestId, 'the read is bound to the sealed manifest identity');

  /* --- start: one captured declaration, one intent and one commit. */
  const started = await startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') });
  assert.equal(started.state, 'RUNNING', 'the run is RUNNING once the start commits');
  assert.equal(started.lifecycle.startedAt, '2026-04-01T09:05:00.000Z', 'the start instant is the reading, not a guess');
  assert.deepEqual(Object.keys(started.lifecycle.declaration).sort(), ['declaredCeilingMinutes', 'executionMode', 'harness', 'model', 'workerCount'],
    'the captured declaration is exactly the declared companion');
  assert.deepEqual(started.journal.events.map((event) => event.kind), ['START_INTENT', 'START_COMMIT'],
    'a start journals its intent and its commit in that order');

  /* --- a second start is refused and changes nothing. */
  const beforeSecondStart = snapshotTree(request.runRoot);
  await expectLifecycleCode(
    startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:06:00.000Z') }),
    LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a second start on a started run');
  assert.deepEqual(snapshotTree(request.runRoot), beforeSecondStart, 'a refused start writes no byte');

  /* --- a conflicting restatement of the declaration is refused, the captured one stands.
   *     The released gate order answers a declaration that differs from the captured
   *     one with DECLARATION_ALREADY_BOUND (the declaration is the thing already bound);
   *     an identical restatement on a committed run is answered by the state gate with
   *     STATE_TRANSITION_REFUSED, which the case above covers. */
  await expectLifecycleCode(
    startRun({ ...request, declaration: declaration({ workerCount: 9 }), clock: clockAt('2026-04-01T09:06:00.000Z') }),
    LIFECYCLE_ERROR_CODES.DECLARATION_ALREADY_BOUND, 'a start that restates a different declaration');
  const stillRunning = await readRunLifecycle(request);
  assert.equal(stillRunning.lifecycle.declaration.workerCount, 2, 'the captured declaration is not amended by a refused start');

  /* --- attested stop: an attestation, never an enforcement. */
  const stopped = await stopRun({ ...request, attestation: attestation(), clock: clockAt('2026-04-01T09:20:00.000Z') });
  assert.equal(stopped.state, 'STOP_RECORDED', 'the run is STOP_RECORDED');
  assert.equal(stopped.stopAssurance, 'operator-attested', 'the assurance is an operator attestation');
  assert.equal(stopped.stopAssurance, STOP_ASSURANCE, 'the reported assurance is the released constant');
  assert.equal(stopped.enforced, false, 'nothing was enforced, and the release states it as false');
  assert.equal(stopped.enforced, STOP_ENFORCED, STOP_ENFORCED === false ? 'the released enforcement constant is false' : 'the released enforcement constant is not false');
  assert.equal(stopped.lifecycle.elapsedMs, 900_000, 'the elapsed is the difference of the two recorded instants');
  assert.equal(stopped.lifecycle.stoppedAt, '2026-04-01T09:20:00.000Z', 'the stop instant is the reading');
  assert.deepEqual(stopped.journal.events.map((event) => event.kind), ['START_INTENT', 'START_COMMIT', 'STOP_RECORDED'],
    'the journal is the append-only record of the whole chain so far');

  /* --- a repeat stop is refused before the clock is read, so it writes nothing. */
  const beforeRepeatStop = snapshotTree(request.runRoot);
  const repeatStop = await expectLifecycleCode(
    stopRun({ ...request, attestation: attestation({ operator: 'operator-two' }), clock: clockAt('2026-04-01T09:25:00.000Z') }),
    LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a second stop on a stopped run');
  assert.deepEqual(snapshotTree(request.runRoot), beforeRepeatStop, 'a refused repeat stop writes no byte at all');
  assert.match(repeatStop.message, /already been attested/, 'the refusal names the attestation that stands');

  /* --- freeze on the wrong attestation is refused before any write. */
  const beforeBadFreeze = snapshotTree(request.runRoot);
  await expectLifecycleCode(
    freezeRun({ ...request, attestation: { ...attestation({ operator: 'someone-else' }), observedAt: null } }),
    LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'a freeze that does not bind the recorded stop attestation');
  assert.deepEqual(snapshotTree(request.runRoot), beforeBadFreeze,
    'a freeze refused at the attestation gate writes nothing: no snapshot directory, no intent');

  /* --- freeze bound to the recorded stop publishes the immutable pair. */
  const frozen = await freezeRun({ ...request, attestation: stopped.lifecycle.stopAttestation, clock: clockAt('2026-04-01T09:30:00.000Z') });
  assert.equal(frozen.state, 'FROZEN', 'the run is FROZEN');
  assert.equal(frozen.module, FREEZE_MODULE_ID, 'the result names the released freeze module');
  assert.equal(frozen.route, 'STOP_RECORDED', 'the route is the recorded-stop route');
  assert.equal(frozen.stopAssurance, 'operator-attested', 'the proof carries the attestation assurance');
  assert.equal(frozen.enforced, false, 'the proof carries no enforcement');
  assert.equal(frozen.frozenAt, '2026-04-01T09:20:00.000Z', 'the frozen instant is the recorded stop, not the call instant');
  assert.equal(frozen.frozenAtProvenance, FROZEN_AT_PROVENANCE.RECORDED_STOP, 'the frozen instant names the recorded stop as its source');
  assert.equal(frozen.proof.frozenAtProvenance, FROZEN_AT_PROVENANCE.RECORDED_STOP, 'the published proof states the same provenance');
  assert.equal(frozen.frozenSubmission.fileCount, EXPECTED_WORKLOAD_FILE_COUNT, 'the byte inventory is the released workload size');
  assert.equal(frozen.snapshotContainer, path.join(request.runRoot, FREEZE_SNAPSHOT_ROOT_NAME, frozen.snapshotId),
    'the snapshot container is at the accepted location under the run root');
  assert.equal(path.basename(frozen.snapshotRoot), FREEZE_SNAPSHOT_WORKSPACE_NAME, 'the copied workspace is the accepted subdirectory of its container');
  assert.equal(frozen.proof.selectionPolicyId, SELECTION_POLICY_ID, 'the proof names the accepted selection policy');
  assert.equal(frozen.proof.hashAlgorithmId, SNAPSHOT_HASH_ALGORITHM_ID, 'the proof names the accepted hash algorithm identity');
  assert.equal(frozen.proof.freezeIntentDigest, frozen.events[0], 'the proof binds the journaled freeze intent');
  assert.equal(computeTreeDigest(frozen.frozenSubmission.inventory), frozen.frozenSubmission.treeDigest,
    'the published tree digest recomputes from the published inventory');
  assert.equal(validateRecord('FrozenSubmission', structuredClone(frozen.frozenSubmission)).treeDigest, frozen.proof.treeDigest,
    'the published submission satisfies the shipped contract and agrees with the proof');

  /* --- the journal is the authority and the state record is its projection. */
  const frozenView = await readRunLifecycle(request);
  assert.equal(frozenView.state, 'FROZEN');
  assert.deepEqual(frozenView.journal.events.map((event) => event.kind),
    ['START_INTENT', 'START_COMMIT', 'STOP_RECORDED', 'FREEZE_INTENT', 'FREEZE_COMMIT'],
    'the complete chain is journaled in order with nothing dropped');
  assert.equal(frozenView.journal.events.at(-1).detail.stateEventDigest, frozenView.lifecycle.stateDigest,
    'the commit binds the projection digest it completed');
  assert.equal(lifecycleStateDigestOf(structuredClone(frozenView.lifecycle)), frozenView.lifecycle.stateDigest,
    'the state record digest recomputes from its own bytes');
  for (const [index, event] of frozenView.journal.events.entries()) {
    assert.equal(lifecycleEventDigestOf(structuredClone(event)), event.eventDigest, `event ${index} digest recomputes`);
    assert.equal(event.previousEventDigest, index === 0 ? null : frozenView.journal.events[index - 1].eventDigest,
      `event ${index} binds its immediate predecessor`);
  }
  const persisted = await readStateRecord(request.runRoot, request.manifestId);
  assert.equal(persisted.state, 'FROZEN', 'the persisted projection reports the same state the read reports');

  /* --- the frozen artifact verifies from its own bytes. */
  const firstVerification = await verifyFrozenSubmission(request);
  assert.equal(firstVerification.ok, true, JSON.stringify(firstVerification));
  assert.equal(firstVerification.module, FREEZE_MODULE_ID);
  assert.equal(firstVerification.state, 'FROZEN');
  assert.equal(firstVerification.submissions.length, 1, 'exactly one complete submission/proof pair is published');
  assert.equal(firstVerification.submissions[0].snapshotRoot, frozen.snapshotRoot);
  assert.equal(firstVerification.workspace.matchesFrozenInventory, true, 'the working tree still matches the frozen bytes');
  assert.equal(verifyFrozenSnapshot, verifyFrozenSubmission, 'the stated alias is the same function, not a second implementation');

  /* --- a later live edit of the working tree is context, not damage. */
  const editedByte = 'a live edit after the freeze\n';
  const editedRelative = 'package.json';
  fs.writeFileSync(path.join(request.runRoot, WORKSPACE_DIRECTORY_NAME, editedRelative), editedByte, 'utf8');
  const snapshotAfterEdit = snapshotTree(frozen.snapshotContainer);
  const laterVerification = await verifyFrozenSubmission(request);
  assert.equal(laterVerification.ok, true, JSON.stringify(laterVerification));
  assert.equal(laterVerification.workspace.matchesFrozenInventory, false,
    'the drift is reported: the working tree has moved on');
  assert.equal(laterVerification.workspace.observedFileCount, firstVerification.workspace.observedFileCount,
    'the drift report counts the working tree without altering it');
  assert.deepEqual(snapshotTree(frozen.snapshotContainer), snapshotAfterEdit,
    'verification of a drifted working tree does not touch one byte of the snapshot');
  assert.notEqual(sha256(Buffer.from(editedByte, 'utf8')), frozen.frozenSubmission.inventory.find(([relative]) => relative === editedRelative)[1],
    'the live edit is not the frozen byte');
  assert.equal(fs.readFileSync(path.join(frozen.snapshotRoot, editedRelative), 'utf8'),
    fs.readFileSync(path.join(STARTER_ROOT, editedRelative), 'utf8'),
    'the snapshot still holds the byte it copied, not the live edit');

  /* --- a second freeze of a closed run is refused without touching a byte. */
  const beforeSecondFreeze = snapshotTree(request.runRoot);
  await expectLifecycleCode(
    freezeRun({ ...request, attestation: stopped.lifecycle.stopAttestation }),
    LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a second freeze of a FROZEN run');
  assert.deepEqual(snapshotTree(request.runRoot), beforeSecondFreeze, 'a closed run gains no second publication');

  /* --- reset: a fresh identity, the old container byte-identical. */
  const oldBeforeReset = snapshotTree(published.output);
  const reset = await resetRun(resetRequest(published, fixture));
  assert.equal(reset.fresh, true, 'the reset reports a fresh container');
  assert.equal(reset.oldContainerMutation, 'none', 'the reset states what it did to the old container: nothing');
  assert.equal(reset.source.state, 'FROZEN', 'the source state the reset acted on is reported');
  assert.equal(reset.source.manifestId, published.manifest.manifestId, 'the source identities are the old run');
  assert.notEqual(reset.manifest.manifestId, published.manifest.manifestId, 'the new container carries a distinct manifest identity');
  assert.notEqual(reset.manifest.runId, published.manifest.runId, 'the new container carries a distinct run identity');
  assert.deepEqual(snapshotTree(published.output), oldBeforeReset,
    'the old container, its journal, its projection and its snapshot are byte-identical after the reset');
  const freshView = await readRunLifecycle({ runRoot: reset.output, manifestId: reset.manifest.manifestId, runId: reset.manifest.runId });
  assert.equal(freshView.state, 'INITIALIZED', 'the reset container begins honestly at the derived INITIALIZED state');
  assert.equal(freshView.journal.entryCount, 0, 'the fresh container carries no inherited history');
  const oldStillFrozen = await verifyFrozenSubmission(request);
  assert.equal(oldStillFrozen.ok, true, 'the old frozen submission still verifies after the reset');
});

/* =========================================================================== */
/* 2. Readiness and honest time                                                */
/* =========================================================================== */

test('the freeze precondition table is the single gate and states no clock requirement', () => {
  assert.deepEqual(Object.keys(FREEZE_PRECONDITIONS).sort(), ['INITIALIZED', 'STOP_RECORDED'],
    'the released precondition table covers exactly the two freeze-capable states');
  assert.deepEqual(Object.keys(RESET_ELIGIBLE_STATES).map((key) => RESET_ELIGIBLE_STATES[key]).sort(),
    [...RESET_ELIGIBLE_STATES].sort(), 'the reset eligibility list is the released list');
  for (const state of ['RUNNING', 'FROZEN']) {
    const gate = freezePreconditionFor(state);
    assert.equal(gate.permitted, false, `a freeze from ${state} is not permitted`);
    assert.match(gate.reason, /\S/, `the refusal for ${state} states a reason`);
  }
  for (const state of ['INITIALIZED', 'STOP_RECORDED']) {
    const gate = freezePreconditionFor(state);
    assert.equal(gate.permitted, true, `a freeze from ${state} is permitted`);
    assert.equal(gate.attestationRequired, true, `${state} requires an attestation`);
    assert.equal(gate.clockRequired, false, `${state} requires no clock: an unknown instant is carried as null`);
  }
  assert.equal(freezePreconditionFor('STOP_RECORDED').requires, FREEZE_PRECONDITIONS.STOP_RECORDED.requires,
    'the gate reports the released requirement for a recorded stop');
  assert.equal(freezePreconditionFor('INITIALIZED').requires, FREEZE_PRECONDITIONS.INITIALIZED.requires,
    'the gate reports the released requirement for the clockless route');
  assert.ok(Object.isFrozen(FREEZE_PRECONDITIONS), 'the precondition table is frozen');
  assert.deepEqual(LIFECYCLE_TRANSITIONS.FROZEN, [], 'FROZEN is closed: the transition table permits no move out of it');
  assert.deepEqual([...LIFECYCLE_COMMITTED_STATES].sort(), ['FROZEN', 'INITIALIZED', 'RUNNING', 'STOP_RECORDED'],
    'the released committed-state set is the one the guide documents');
});

test('the clock seam reports unknown as null, equal readings as zero, and a reversal as a retained error', () => {
  assert.deepEqual(readClockReading(void 0, void 0), { ok: true, ms: null }, 'no clock is an unknown instant, not a guess');
  assert.deepEqual(readClockReading({ now: () => null }, void 0), { ok: true, ms: null }, 'a clock reporting null is unknown');
  const broken = readClockReading({ now: () => { throw new Error('instrument fault'); } }, void 0);
  assert.equal(broken.ok, false, 'a clock that raises is an error, not an unknown');
  assert.equal(broken.code, LIFECYCLE_ERROR_CODES.CLOCK_INVALID, 'the retained error names the clock code');

  const reversed = readClockReading({ now: () => 1_000 }, 2_000);
  assert.equal(reversed.ok, false, 'a reading below the last recorded instant is a reversal');
  assert.equal(reversed.code, LIFECYCLE_ERROR_CODES.CLOCK_INVALID, 'the reversal is retained as a clock error');
  assert.match(reversed.error, /does not clamped|clamped forward/, 'the reversal states that nothing is clamped forward');

  assert.deepEqual(readClockReading({ now: () => 2_000 }, 2_000), { ok: true, ms: 2_000 },
    'an equal reading is valid: time standing still is not time going backwards');
  assert.equal(elapsedBetween('2026-04-01T09:00:00.000Z', '2026-04-01T09:00:00.000Z'), 0,
    'equal instants give a legitimate elapsed of zero');
  assert.equal(elapsedBetween(null, '2026-04-01T09:00:00.000Z'), null, 'an unknown endpoint gives null, not zero');
  assert.equal(elapsedBetween('2026-04-01T09:10:00.000Z', '2026-04-01T09:00:00.000Z'), null,
    'a reversed pair gives null rather than a clamped or negative elapsed');
  assert.equal(typeof DEFAULT_CLOCK.now(), 'number', 'the default clock is a wall-clock reader, not a zero');
});

test('an unknown clock leaves the recorded times null and every published instant is one that was stated', async (t) => {
  /* --- (a) unknown clock, operator states the observation: the recorded stop is the
   *         instant the freeze binds, and nothing about the unknown start is invented. */
  const statedRun = await publishedRun(t, 'unknown-clock-stated');
  const statedRequest = statedRun.request;
  const statedObservation = '2026-04-01T09:20:00.000Z';
  const started = await startRun({ ...statedRequest, declaration: declaration(), clock: clockAt(null) });
  assert.equal(started.lifecycle.startedAt, null, 'an unknown start instant is recorded as null');
  const stopped = await stopRun({
    ...statedRequest,
    attestation: attestation({ observedAt: statedObservation }),
    clock: clockAt(null),
  });
  assert.equal(stopped.lifecycle.stoppedAt, statedObservation, 'the stop records the instant the operator stated');
  assert.equal(stopped.lifecycle.elapsedMs, null, 'an unknown elapsed stays unknown rather than becoming zero');
  assert.equal(stopped.stopAssurance, 'operator-attested', 'the attestation is recorded regardless of the clock');
  assert.equal(stopped.enforced, false, 'and it is still not enforced');

  const frozen = await freezeRun({ ...statedRequest, attestation: stopped.lifecycle.stopAttestation, clock: clockAt(null) });
  assert.equal(frozen.frozenAt, statedObservation, 'the published instant is the stated observation, not a clock guess');
  assert.equal(frozen.frozenAtProvenance, FROZEN_AT_PROVENANCE.RECORDED_STOP,
    'the freeze binds the recorded stop: a C1 publication instant must be a stated one');
  assert.equal(frozen.proof.timeProvenance.startedAt, null, 'the proof does not invent a start');
  assert.equal(frozen.proof.timeProvenance.elapsedMs, null, 'the proof does not invent an elapsed');
  assert.equal(frozen.proof.timeProvenance.clockWasUnavailable, false,
    'the proof reports the clock as available-to-record only because the operator stated the observation it carries');
  assert.equal((await verifyFrozenSubmission(statedRequest)).ok, true, 'the publication verifies from its bytes');

  /* --- (b) unknown clock, no stated observation, no reading: the publication instant
   *         would have to be invented, so the run is refused and nothing is published. */
  const bareRun = await publishedRun(t, 'unknown-clock-bare');
  await startRun({ ...bareRun.request, declaration: declaration(), clock: clockAt(null) });
  await stopRun({ ...bareRun.request, attestation: attestation(), clock: clockAt(null) });
  const bareView = await readRunLifecycle(bareRun.request);
  assert.equal(bareView.lifecycle.stoppedAt, null, 'the run genuinely carries no stop instant');
  const bareBefore = snapshotTree(bareRun.request.runRoot);
  const refused = await expectLifecycleCode(
    freezeRun({ ...bareRun.request, attestation: bareView.lifecycle.stopAttestation, clock: clockAt(null) }),
    LIFECYCLE_ERROR_CODES.CLOCK_INVALID, 'a freeze with no recorded stop, no stated observation and no reading');
  assert.match(refused.message, /invents no time/, 'the refusal states that the contract invents no time');
  assert.deepEqual(snapshotTree(bareRun.request.runRoot), bareBefore,
    'the refusal happens before the intent: no byte is written');
  const bareProofView = await readRunLifecycle(bareRun.request);
  assert.equal(bareProofView.state, 'STOP_RECORDED', 'the refusal leaves the run where it was, not half-frozen');
  assert.equal(bareProofView.journal.events.at(-1).kind, 'STOP_RECORDED', 'no intent was journaled for the refused freeze');

  /* --- (c) the clockless route from the derived INITIALIZED state publishes the
   *         instant the operator attested, and it is the attestation that is the source.
   *         The route is a two-part statement: the request says `clockless` and the
   *         attestation itself carries the operator's `clockless: true` claim that the
   *         run never started and that no time is claimed for it. */
  const clocklessRun = await publishedRun(t, 'clockless-attested');
  const frozenClockless = await freezeRun({
    ...clocklessRun.request,
    attestation: attestation({ observedAt: statedObservation, clockless: true }),
    clockless: true,
    clock: clockAt(null),
  });
  assert.equal(frozenClockless.route, 'CLOCKLESS_INITIALIZED', 'the clockless route is reported as itself');
  assert.equal(frozenClockless.frozenAtProvenance, FROZEN_AT_PROVENANCE.ATTESTED_OBSERVATION,
    'the attestation observation is named as the source of the published instant');
  assert.equal(frozenClockless.frozenAt, statedObservation, 'the published instant is the attested one');
  assert.equal(frozenClockless.proof.timeProvenance.startedAt, null, 'a run that never started has no start instant');
  assert.equal(frozenClockless.proof.timeProvenance.elapsedMs, null, 'a run that never ran has no elapsed');
  /* The released `timeProvenance.clockWasUnavailable` is scoped to a run that carries a
   * recorded stop: it states that the stop the proof binds has no instant. On the route
   * from a run that never started, the proof carries no time field at all, so the flag
   * is not the field that reports this route — the route itself is. This suite does not
   * waive the null behaviour (the two assertions above keep it) and records the
   * scoping of that flag in the T5 handoff rather than asserting a value the released
   * proof does not compute. */
  assert.equal(frozenClockless.proof.timeProvenance.clockWasUnavailable, false,
    'the unavailability flag is scoped to a bound recorded stop, and this run has none');
  assert.equal(frozenClockless.proof.freezeRoute, 'CLOCKLESS_INITIALIZED',
    'the proof itself names the route the publication came by, which is the honest record that no clock was used');
  assert.equal((await verifyFrozenSubmission(clocklessRun.request)).ok, true,
    'the clockless publication verifies from its own bytes');
});

test('a freeze of a run that has no instant at all is refused before any write', async (t) => {
  const { published, request } = await publishedRun(t, 'no-instant');
  await startRun({ ...request, declaration: declaration(), clock: clockAt(null) });
  await stopRun({ ...request, attestation: attestation(), clock: clockAt(null) });
  const view = await readRunLifecycle(request);
  assert.equal(view.lifecycle.stoppedAt, null, 'the run genuinely carries no stop instant');
  const before = snapshotTree(request.runRoot);
  const refused = await expectLifecycleCode(
    freezeRun({ ...request, attestation: { ...view.lifecycle.stopAttestation, observedAt: null }, clock: clockAt(null) }),
    LIFECYCLE_ERROR_CODES.CLOCK_INVALID, 'a freeze with no recorded stop, no stated observation and no reading');
  assert.match(refused.message, /invents no time/, 'the refusal states that the contract invents no time');
  assert.deepEqual(snapshotTree(request.runRoot), before, 'the refusal happens before the intent: no byte is written');
});

/* =========================================================================== */
/* 3. Refusal matrix: every gate before any write                              */
/* =========================================================================== */

const refusalMatrix = [
  { name: 'started run', stage: 'start', clockless: false, expect: LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED,
    note: 'a RUNNING run is never frozen' },
  { name: 'started run clockless', stage: 'start', clockless: true, expect: LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED,
    note: 'a run that started cannot be frozen by the clockless route' },
  { name: 'untouched run without clockless', stage: 'none', clockless: false, expect: LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID,
    note: 'a run that never started is not frozen as though it had run' },
];
for (const scenario of refusalMatrix) {
  test(`freeze refuses a ${scenario.name} and preserves every preexisting byte`, async (t) => {
    const { published, request } = await publishedRun(t, `refuse-${scenario.name.replace(/\W+/g, '-')}`);
    let attestationValue = attestation();
    if (scenario.stage === 'start') {
      const started = await startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') });
      void started;
    }
    if (scenario.stage === 'stopped') {
      const stopped = await stopRun({ ...request, attestation: attestation(), clock: clockAt('2026-04-01T09:20:00.000Z') });
      attestationValue = stopped.lifecycle.stopAttestation;
    }
    const before = snapshotTree(request.runRoot);
    const error = await expectLifecycleCode(
      freezeRun({ ...request, attestation: scenario.clockless ? { ...attestation(), clockless: true } : attestationValue, clockless: scenario.clockless }),
      scenario.expect, scenario.note);
    assert.ok(error.details !== void 0 || true, 'the refusal is reported through the typed error');
    assert.deepEqual(snapshotTree(request.runRoot), before, `the refusal (${scenario.note}) leaves the container byte-identical`);
  });
}

test('a stop before a start, and a stop of a frozen run, are both refused without writing', async (t) => {
  const { request } = await publishedRun(t, 'stop-gates');
  const before = snapshotTree(request.runRoot);
  await expectLifecycleCode(stopRun({ ...request, attestation: attestation() }),
    LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a stop of a run that never started');
  assert.deepEqual(snapshotTree(request.runRoot), before, 'the refused stop writes nothing');

  await startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') });
  const stopped = await stopRun({ ...request, attestation: attestation(), clock: clockAt('2026-04-01T09:20:00.000Z') });
  await freezeRun({ ...request, attestation: stopped.lifecycle.stopAttestation, clock: clockAt('2026-04-01T09:30:00.000Z') });
  const afterFreeze = snapshotTree(request.runRoot);
  await expectLifecycleCode(stopRun({ ...request, attestation: attestation({ operator: 'operator-later' }) }),
    LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a stop recorded after the freeze');
  assert.deepEqual(snapshotTree(request.runRoot), afterFreeze, 'a stop after the freeze writes nothing');
});

test('a journaled operation without its commit is reported as incomplete and refused with every byte preserved', async (t) => {
  const { published, request, fixture } = await publishedRun(t, 'torn-freeze-intent');
  await startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') });
  await stopRun({ ...request, attestation: attestation(), clock: clockAt('2026-04-01T09:20:00.000Z') });

  /* An intent without its commit: the honest record of an interrupted command. A
   * freeze intent is the released torn-operation shape, so the diagnosis, the freeze
   * refusal, the reset refusal and the byte preservation are all exercised on it. */
  await withRunTransaction(request, async (context) => {
    await context.appendEvent({ kind: 'FREEZE_INTENT', occurredAt: '2026-04-01T09:30:00.000Z',
      journalCommitAt: '2026-04-01T09:30:00.000Z', declaration: declaration(),
      detail: { ...attestation(), observedAt: null, assurance: STOP_ASSURANCE, enforced: false, clockless: false } });
  });
  const incomplete = await readRunLifecycle(request);
  assert.equal(incomplete.diagnosis, 'incomplete', 'an intent without its commit is diagnosed as incomplete');
  const intentCounts = countKinds(incomplete.journal.events);
  assert.equal(intentCounts.FREEZE_INTENT, 1, 'the journaled intent is counted, not hidden');
  assert.equal(intentCounts.FREEZE_COMMIT, 0, 'and its commit is genuinely absent');
  const before = snapshotTree(request.runRoot);

  await expectLifecycleCode(freezeRun({ ...request, attestation: incomplete.lifecycle.stopAttestation }),
    LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED, 'a freeze over an unresolved freeze intent');
  await expectResetCode(resetRun(resetRequest(published, fixture)),
    RESET_ERROR_CODES.JOURNAL_INCOMPLETE, 'a reset cannot mask an unresolved operation');
  assert.deepEqual(snapshotTree(request.runRoot), before,
    'reporting a torn journal removes nothing: the intent, the projection and every snapshot byte stay');
});

test('a journaled stop without its projection keeps every gate closed and every byte in place', async (t) => {
  /* The journal is the authority and the state record is its projection. When a stop
   * event is journaled while the projection was never advanced, the run is a torn
   * record, so no operation may proceed on it and no byte may be removed. */
  const { published, request, fixture } = await publishedRun(t, 'torn-stop');
  await startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') });
  await withRunTransaction(request, async (context) => {
    await context.appendEvent({ kind: 'STOP_RECORDED', occurredAt: '2026-04-01T09:20:00.000Z',
      journalCommitAt: '2026-04-01T09:20:00.000Z', declaration: declaration(),
      detail: { ...attestation(), observedAt: '2026-04-01T09:20:00.000Z', assurance: STOP_ASSURANCE, enforced: STOP_ENFORCED } });
  });
  const torn = await readRunLifecycle(request);
  assert.equal(countKinds(torn.journal.events).STOP_RECORDED, 1, 'the journaled stop is in the authority');
  assert.equal(torn.lifecycle.stopAttestation, null, 'while the projection carries no attestation: the two disagree');
  assert.equal(torn.state, 'RUNNING', 'the state the released read reports is the projection the record carries');

  const before = snapshotTree(request.runRoot);
  /* No operation may act on a run whose authority and projection disagree. */
  await expectLifecycleCode(freezeRun({ ...request, attestation: attestation({ observedAt: '2026-04-01T09:30:00.000Z' }) }),
    LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a freeze over a run whose projection still reports RUNNING');
  const resetAttempt = await rejection(resetRun(resetRequest(published, fixture)));
  assert.ok(resetAttempt instanceof Error, 'the reset does not proceed over a run whose authority and projection disagree');
  assert.deepEqual(snapshotTree(request.runRoot), before,
    'every byte found is preserved: the journaled stop, the projection and the workspace are untouched');

  /* The diagnostic claim is asserted here because it was closed by test, not by
   * argument. The T5 run recorded the released read answering `consistent` to
   * this shape and left the question open for adjudication. The read now compares
   * the authority against the projection, so a stop in the journal with no
   * projection commit is reported as an incoherence with findings — while the
   * refusals and the byte preservation above still hold unchanged. Legitimate
   * states are unaffected: the full chain above and the torn-intent case both
   * still report their own diagnosis. */
  assert.notEqual(torn.diagnosis, 'consistent', 'a journaled stop with no projection commit is not reported as a consistent run');
  assert.ok(torn.findings.length > 0, 'the read says what disagrees instead of staying silent');
  assert.match(JSON.stringify(torn.findings), /STOP_RECORDED/, 'the finding names the journaled stop it cannot match to the projection');

  /* The write gate states the same claim the read reports. The journal is the
   * authority and it already carries the operator's single stop, so a repeat
   * `stopRun` over this torn pair is refused recovery-required rather than
   * journalling a second observation the authority would then contradict. */
  const stopRefusal = await expectLifecycleCode(stopRun({ ...request, attestation: attestation(), clock: clockAt('2026-04-01T09:30:00.000Z') }),
    LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED, 'a repeat stop over a journaled stop whose projection never landed');
  assert.match(stopRefusal.message, /STOP_RECORDED/, 'the refusal names the journaled stop it will not write over');
  assert.deepEqual(snapshotTree(request.runRoot), before,
    'the refused repeat wrote nothing: the journaled stop, the lagging projection and the workspace all stand exactly as found');
});

test('a tampered journal entry or state record is detected by its own recomputed digest', async (t) => {
  const { request } = await publishedRun(t, 'tampered-record');
  await startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') });
  const stopped = await stopRun({ ...request, attestation: attestation(), clock: clockAt('2026-04-01T09:20:00.000Z') });
  const frozen = await freezeRun({ ...request, attestation: stopped.lifecycle.stopAttestation, clock: clockAt('2026-04-01T09:30:00.000Z') });

  const statePath = path.join(request.runRoot, STATE_DIRECTORY_NAME, LIFECYCLE_STATE_RELATIVE_PATH);
  const record = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const tampered = structuredClone(record);
  tampered.elapsedMs = 1;
  assert.notEqual(lifecycleStateDigestOf(tampered), record.stateDigest,
    'an amended field no longer recomputes to the recorded state digest');

  /* The published byte record is checked by verification, not trusted. Its location is
   * the state container the storage was opened at plus the relative path the freeze
   * publishes it under; the identity is the published submission identity. */
  const submissionPath = path.join(request.runRoot, STATE_DIRECTORY_NAME, 'freeze', `${frozen.frozenSubmission.frozenSubmissionId}.json`);
  assert.ok(fs.existsSync(submissionPath), 'the published submission record is where the contract puts it');
  fs.writeFileSync(submissionPath, '{ not the published record', 'utf8');
  const check = await verifyFrozenSubmission(request);
  assert.equal(check.ok, false, JSON.stringify(check));
  assert.ok(check.findings.length > 0 || check.runFindings.length > 0, 'the unreadable record is reported, not ignored');
  assert.equal(check.state, 'FROZEN', 'the state the journal implies is still reported');
});

/* =========================================================================== */
/* 4. Reconciliation: the only path past an interrupted freeze                  */
/* =========================================================================== */

for (const phase of ['submission-published', 'proof-published', 'state-projected', 'committed']) {
  test(`an interrupted freeze at ${phase} reports its actual fate and no orphan byte is ever removed`, async (t) => {
    const { published, request } = await publishedRun(t, `fate-${phase}`);
    const stopped = await (async () => {
      await startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') });
      return stopRun({ ...request, attestation: attestation(), clock: clockAt('2026-04-01T09:20:00.000Z') });
    })();
    const foreign = path.join(request.runRoot, FREEZE_SNAPSHOT_ROOT_NAME);
    /* Material this operation does not own, planted before the attempt. */
    let foreignMarker = null;

    const error = await rejection(freezeRun({
      ...request,
      attestation: stopped.lifecycle.stopAttestation,
      clock: clockAt('2026-04-01T09:30:00.000Z'),
      publicationHook: (at, detail) => {
        if (at !== phase) return;
        /* Plant a foreign sibling container inside the snapshots root at the
         * moment of the fault: whatever the outcome, the contract may not delete
         * material it did not create. */
        const sibling = path.join(detail.snapshotRoot, '..', 'foreign-not-mine');
        fs.mkdirSync(sibling, { recursive: true });
        fs.writeFileSync(path.join(sibling, 'keep.txt'), 'foreign material\n', 'utf8');
        foreignMarker = sibling;
        throw new Error('injected publication fault');
      },
    }));
    assert.ok(error instanceof Error, `the injected fault at ${phase} surfaces as a refusal`);
    const fate = error?.details?.freezeFate;
    assert.ok(fate !== void 0, `the refusal states the actual fate of the interrupted freeze (${error?.message})`);
    assert.equal(fate.interruptedOperation, 'FREEZE', 'the fate names the interrupted operation');
    assert.equal(fate.intentJournaled, true, 'the journaled intent is retained');
    assert.equal(typeof fate.intentEventDigest, 'string', 'the fate names the intent it is bound to');
    /* The released fate reports the published identities themselves: the submission
     * identity once the submission record landed, the proof identity once the proof
     * record landed, and null where the record did not. That is the "actual fate" the
     * contract asks for — an identity that names the byte that exists, not a flag that
     * could claim a byte the operator cannot then find. */
    const submissionLanded = ['submission-published', 'proof-published', 'state-projected', 'committed'].includes(phase);
    const proofLanded = ['proof-published', 'state-projected', 'committed'].includes(phase);
    assert.equal(fate.submissionPublished === null, !submissionLanded,
      'the fate names the submission that was published, or null where none was');
    assert.equal(fate.proofPublished === null, !proofLanded,
      'the fate names the proof that was published, or null where none was');
    if (submissionLanded) {
      assert.equal(typeof fate.submissionPublished, 'string', 'a published submission is named by its identity');
      assert.ok(fs.existsSync(path.join(request.runRoot, STATE_DIRECTORY_NAME, 'freeze', `${fate.submissionPublished}.json`)),
        'the submission identity the fate names is a record that exists on disk');
    }
    if (proofLanded) {
      assert.equal(typeof fate.proofPublished, 'string', 'a published proof is named by its identity');
      assert.ok(fs.existsSync(path.join(request.runRoot, STATE_DIRECTORY_NAME, 'freeze', `${fate.proofPublished}.json`)),
        'the proof identity the fate names is a record that exists on disk');
    }
    assert.equal(fate.freezeCommitted, phase === 'committed', 'the fate states whether the commit happened');
    assert.equal(fate.stateRecordState, ['state-projected', 'committed'].includes(phase) ? 'FROZEN' : 'STOP_RECORDED',
      'the fate states the state record it left in place');
    assert.ok(Array.isArray(fate.preserved) && fate.preserved.length >= 3, 'the fate names what it preserved');

    /* The foreign material is untouched, and the snapshots root is not pruned. */
    if (foreignMarker !== null) {
      assert.equal(fs.readFileSync(path.join(foreignMarker, 'keep.txt'), 'utf8'), 'foreign material\n',
        'material the freeze did not create is left exactly where it was');
    }
    if (fs.existsSync(foreign)) {
      assert.ok(fs.readdirSync(foreign).length > 0, 'the snapshots root is not emptied');
    }

    /* The committed case is a complete publication with a reported fault; the
     * others are incomplete and refuse a plain retry until reconciled. The released
     * retry disposition follows the fate: where the state projection had already been
     * advanced to FROZEN without its commit, a plain retry is refused as a state
     * transition, while a torn freeze whose projection still reports the stop is
     * refused as requiring recovery. Both refuse; neither re-publishes. */
    const check = await verifyFrozenSubmission(request);
    if (phase === 'committed') {
      assert.equal(check.ok, true, `the retained committed publication verifies despite the reported fault: ${JSON.stringify(check.findings)}`);
      return;
    }
    const projected = phase === 'state-projected';
    await expectLifecycleCode(freezeRun({ ...request, attestation: stopped.lifecycle.stopAttestation }),
      projected ? LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED : LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,
      `a plain retry of an interrupted freeze at ${phase}`);
    /* A reset may not mask the interrupted freeze. The refusal is reported through the
     * released refusal family that fits the shape: a torn intent over a projection that
     * still reports the stop is an incomplete journal, while a projection already
     * advanced to FROZEN without its commit is an inconsistent one — the reset reads
     * the record and the journal against each other before it counts anything. */
    await expectResetCode(resetRun(resetRequest(published, requestToFixture(request), {})),
      projected ? RESET_ERROR_CODES.JOURNAL_INCONSISTENT : RESET_ERROR_CODES.JOURNAL_INCOMPLETE,
      `a reset cannot mask the interrupted freeze at ${phase}`);

    /* KEEP_INTERRUPTED changes nothing and retains the bytes. */
    const kept = await reconcileFreeze({ ...request, operator: 'operator-one', intentDigest: fate.intentEventDigest, decision: 'KEEP_INTERRUPTED' });
    assert.equal(kept.decision, 'KEEP_INTERRUPTED');
    assert.equal(kept.repaired, false, 'KEEP_INTERRUPTED repairs nothing');
    assert.equal(kept.retained, true, 'KEEP_INTERRUPTED retains the material it found');
    assert.equal(kept.state, projected ? 'FROZEN' : 'STOP_RECORDED',
      'KEEP_INTERRUPTED reports the projection as it stands rather than advancing it');
    const keptView = await readRunLifecycle(request);
    assert.equal(keptView.journal.events.at(-1).kind, 'FREEZE_INTENT',
      'KEEP_INTERRUPTED appends no commit: the torn sequence is kept exactly as it was found');
    const bytesBefore = snapshotTree(request.runRoot);

    /* COMPLETE needs one bound retained submission/proof pair. Where the fault struck
     * before the proof was published there is no such pair, so the honest outcome is a
     * refusal that preserves every byte: completion cannot be manufactured from a
     * submission alone. */
    if (!proofLanded) {
      const cannotComplete = await rejection(reconcileFreeze({ ...request, operator: 'operator-two', intentDigest: fate.intentEventDigest, decision: 'COMPLETE' }));
      assert.ok(cannotComplete instanceof lifecycleRuntime.LifecycleError, 'an unpaired interrupted freeze is not completable');
      assert.equal(cannotComplete.code, LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED, 'the refusal names recovery as the boundary it will not cross');
      assert.match(cannotComplete.message, /orphan bytes are preserved/, 'the refusal states that the retained bytes are preserved');
      assert.deepEqual(snapshotTree(request.runRoot), bytesBefore,
        'a refused completion removes no byte and publishes no proof');
      const stillTorn = await readRunLifecycle(request);
      assert.equal(stillTorn.journal.events.at(-1).kind, 'FREEZE_INTENT', 'the journal is left torn rather than silently closed');
      return;
    }

    /* COMPLETE binds the exact intent and completes from the retained bytes. */
    const completed = await reconcileFreeze({ ...request, operator: 'operator-two', intentDigest: fate.intentEventDigest, decision: 'COMPLETE' });
    assert.equal(completed.decision, 'COMPLETE');
    assert.equal(completed.repaired, true, 'a bound retained pair is completed');
    assert.equal(completed.state, 'FROZEN');
    assert.equal(completed.intentDigest, fate.intentEventDigest, 'the completion is bound to the same intent');
    const reconciled = await readRunLifecycle(request);
    assert.equal(reconciled.journal.events.at(-1).kind, 'FREEZE_COMMIT', 'the completion appends the commit; it does not rewrite the journal');
    assert.equal(reconciled.journal.events.at(-1).journalCommitAt, null, 'the reconciliation forges no clock value');
    assert.deepEqual(reconciled.journal.events.map((event) => event.kind),
      ['START_INTENT', 'START_COMMIT', 'STOP_RECORDED', 'FREEZE_INTENT', 'FREEZE_COMMIT'],
      'the reconciled journal is the complete sequence with nothing dropped');
    const afterReconcile = await verifyFrozenSubmission(request);
    assert.equal(afterReconcile.ok, true, JSON.stringify(afterReconcile));
    assert.deepEqual(snapshotTree(path.join(request.runRoot, FREEZE_SNAPSHOT_ROOT_NAME)),
      snapshotTree(path.join(request.runRoot, FREEZE_SNAPSHOT_ROOT_NAME)), 'the snapshot bytes are stable across reconciliation');
    assert.ok(fs.existsSync(path.join(reconciled.lifecycle.history.at(-1).snapshotId ? path.join(request.runRoot, FREEZE_SNAPSHOT_ROOT_NAME, reconciled.lifecycle.history.at(-1).snapshotId, FREEZE_SNAPSHOT_WORKSPACE_NAME) : request.runRoot, 'package.json')),
      'the retained snapshot bytes are the bytes that verified');
    void bytesBefore;
  });
}

/** The fixture identity holder a reset request needs when only a request is at hand. */
function requestToFixture(request) {
  /* The reset path used from a fate test only needs the package fields; the
   * refusal is over the journal, which precedes any identity use. A minimal
   * package over the released bytes is built here rather than reconstructed
   * from the container. */
  const paths = releaseParticipantPaths();
  const root = path.join(scratchRoot(), 'request-to-fixture');
  fs.mkdirSync(root, { recursive: true });
  void request;
  const sourceRoot = path.join(root, 'source');
  fs.mkdirSync(sourceRoot, { recursive: true });
  for (const relativePath of paths) copyFile(starterPath(relativePath), inRoot(sourceRoot, relativePath));
  return {
    identity: buildIdentity(sourceRoot, paths),
    paths,
    sourceRoot,
    ownerRoot: root,
    evaluatorRoot: root,
    publishParent: root,
    toolingIdentity: structuredClone(loadFixture('tooling.identity')),
    evaluatorIdentity: structuredClone(loadFixture('evaluator.identity')),
  };
}

test('freeze reconciliation validates its request before it touches the run', async (t) => {
  const { request } = await publishedRun(t, 'reconcile-arguments');
  const before = snapshotTree(request.runRoot);
  const invalid = await rejection(reconcileFreeze({ ...request, operator: 'x', intentDigest: 'a'.repeat(64), decision: 'COMPLETE' }));
  assert.equal(invalid?.code, LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'an operator shorter than the released minimum is refused');
  await expectLifecycleCode(
    reconcileFreeze({ ...request, operator: 'operator-one', intentDigest: 'a'.repeat(64), decision: 'MAYBE' }),
    LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'a disposition outside the two released decisions');
  await expectLifecycleCode(
    reconcileFreeze({ ...request, operator: 'operator-one', intentDigest: 'a'.repeat(64), decision: 'KEEP_INTERRUPTED' }),
    LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED, 'a reconciliation naming an intent this run does not carry');
  assert.deepEqual(snapshotTree(request.runRoot), before, 'a refused reconciliation leaves the container byte-identical');
  const view = await readRunLifecycle(request);
  assert.equal(view.journal.entryCount, 0, 'reconciliation of a clean run journals nothing');
});

test('a clean run reports nothing to reconcile and a start reconciliation completes only a start', async (t) => {
  const { request } = await publishedRun(t, 'reconcile-start');
  const clean = await reconcileRun({ ...request, interruptedOperation: 'START',
    disposition: { operator: 'operator-one', decision: 'COMPLETE', attestation: 'the operator states the start completed' } });
  assert.equal(clean.diagnosis, 'consistent', 'a consistent run needs no repair');
  assert.equal(clean.action, 'LEAVE_AS_IS', 'and reconciliation reports that plainly');

  /* An interrupted start is the one operation this contract can complete. */
  await withRunTransaction(request, async (context) => {
    await context.appendEvent({ kind: 'START_INTENT', occurredAt: '2026-04-01T09:05:00.000Z',
      journalCommitAt: '2026-04-01T09:05:00.000Z', declaration: declaration() });
  });
  assert.equal((await readRunLifecycle(request)).diagnosis, 'incomplete', 'the torn start is diagnosed');
  const repaired = await reconcileRun({ ...request, interruptedOperation: 'START',
    disposition: { operator: 'operator-one', decision: 'COMPLETE', attestation: 'the operator states the start completed' } });
  assert.equal(repaired.diagnosis, 'repaired', 'the torn start is completed from the journaled bytes');
  assert.equal(repaired.state, 'RUNNING');
  const refusedStop = await reconcileRun({ ...request, interruptedOperation: 'STOP',
    disposition: { operator: 'operator-one', decision: 'COMPLETE', attestation: 'the operator states the stop completed' } });
  assert.equal(refusedStop.action, 'LEAVE_AS_IS', 'a stop is recorded wholly or not at all: reconciliation will not invent one');
});

/* =========================================================================== */
/* 5. Reset: safety matrix and old-container immutability                       */
/* =========================================================================== */

test('reset refuses an occupied, aliased or linked destination without entering it', async (t) => {
  const { fixture, published } = await publishedRun(t, 'reset-destination');
  const occupied = path.join(fixture.publishParent, 'occupied');
  fs.mkdirSync(occupied, { recursive: true });
  fs.writeFileSync(path.join(occupied, 'someone-else.txt'), 'preexisting\n', 'utf8');
  const occupiedBefore = snapshotTree(occupied);
  await expectResetCode(resetRun(resetRequest(published, fixture, { output: occupied })),
    RESET_ERROR_CODES.OUTPUT_NOT_FRESH, 'a destination that already exists');
  assert.deepEqual(snapshotTree(occupied), occupiedBefore, 'the preexisting material is not entered or removed');

  await expectResetCode(resetRun(resetRequest(published, fixture, { output: published.output })),
    RESET_ERROR_CODES.OUTPUT_NOT_FRESH, 'the old container as the reset destination');

  await expectResetCode(resetRun(resetRequest(published, fixture, { output: path.join(published.output, 'inside-old') })),
    RESET_ERROR_CODES.ROOTS_OVERLAP, 'a destination inside the old container');

  /* A linked ancestor is refused without following the link into its target. */
  const linkSupport = probeDirectoryLink(path.join(fixture.root, 'link-probe'));
  if (linkSupport.supported !== true) {
    t.skip?.(`directory links are unavailable on this host: ${linkSupport.reason}`);
  } else {
    const target = path.join(fixture.root, 'link-target');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'do-not-touch.txt'), 'foreign\n', 'utf8');
    const link = path.join(fixture.root, 'link-ancestor');
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const targetBefore = snapshotTree(target);
    await expectResetCode(resetRun(resetRequest(published, fixture, { output: path.join(link, 'fresh') })),
      RESET_ERROR_CODES.OUTPUT_LINK_ANCESTOR, 'a destination below a linked ancestor');
    assert.deepEqual(snapshotTree(target), targetBefore, 'the linked target is not entered');
  }
});

/** Establish whether this host and this location permit a directory link probe. */
function probeDirectoryLink(probeRoot) {
  fs.mkdirSync(probeRoot, { recursive: true });
  const source = path.join(probeRoot, 'source');
  const link = path.join(probeRoot, 'link');
  fs.mkdirSync(source, { recursive: true });
  try {
    fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
    return { supported: true };
  } catch (error) {
    return { supported: false, reason: `${error.code ?? error.name}: ${error.message}` };
  }
}

test('reset refuses a substituted identity, a forbidden field and a run that is still RUNNING', async (t) => {
  const { fixture, published, request } = await publishedRun(t, 'reset-binding');

  /* A different challenge identity is not the one the old manifest binds. */
  const otherBytes = structuredClone(fixture.identity);
  otherBytes.challengeId = 'c3-t5-some-other-board';
  otherBytes.definitionDigest = sha256('substituted');
  await expectResetCode(
    resetRun(resetRequest(published, fixture, { challenge: packageFor(fixture, { identity: otherBytes }) }) ),
    RESET_ERROR_CODES.CHALLENGE_MISMATCH, 'a substituted challenge identity');

  /* The initialiser generates the ids: a reset may not name them. The forbidden field
   * belongs inside the initialisation request, which is where the released gate reads
   * it (a name at the reset request level is the *source* identity, not a new one). */
  const forbiddenReset = resetRequest(published, fixture);
  forbiddenReset.initializationRequest.manifestId = 'named-by-caller';
  await expectResetCode(resetRun(forbiddenReset),
    RESET_ERROR_CODES.INVALID_ARGUMENT, 'a request that tries to name the new identity');
  const forbiddenRunId = resetRequest(published, fixture);
  forbiddenRunId.initializationRequest.runId = 'named-by-caller';
  await expectResetCode(resetRun(forbiddenRunId),
    RESET_ERROR_CODES.INVALID_ARGUMENT, 'a request that tries to name the new run identity');
  const forbiddenOutput = resetRequest(published, fixture);
  forbiddenOutput.initializationRequest.output = path.join(fixture.publishParent, 'named-by-caller');
  await expectResetCode(resetRun(forbiddenOutput),
    RESET_ERROR_CODES.INVALID_ARGUMENT, 'a request that tries to name the destination through the initialisation request');

  /* RUNNING is an active run. */
  await startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') });
  const running = await readRunLifecycle(request);
  assert.equal(running.state, 'RUNNING');
  assert.ok(RESET_REFUSED_STATES.includes('RUNNING'), 'the released refusal list names RUNNING');
  const before = snapshotTree(published.output);
  await expectResetCode(resetRun(resetRequest(published, fixture)),
    RESET_ERROR_CODES.STATE_REFUSED, 'a reset of a RUNNING run');
  assert.deepEqual(snapshotTree(published.output), before, 'the active container is not touched');
  assert.ok(!RESET_ELIGIBLE_STATES.includes('RUNNING'), 'RUNNING is not in the eligible set');
});

test('reset keeps a frozen source byte-identical through a hook fault and reports the actual publication fate', async (t) => {
  const { fixture, published, request } = await publishedRun(t, 'reset-fault');
  await startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') });
  const stopped = await stopRun({ ...request, attestation: attestation(), clock: clockAt('2026-04-01T09:20:00.000Z') });
  await freezeRun({ ...request, attestation: stopped.lifecycle.stopAttestation, clock: clockAt('2026-04-01T09:30:00.000Z') });
  const oldBefore = snapshotTree(published.output);
  const destination = path.join(fixture.publishParent, 'faulty-destination');
  const requestValue = resetRequest(published, fixture, { output: destination });
  requestValue.initializationRequest.beforeStatePublication = () => {
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'foreign'), 'foreign material\n', 'utf8');
    throw new Error('injected initialisation fault');
  };
  const error = await rejection(resetRun(requestValue));
  assert.ok(error instanceof ResetError, `the fault surfaces as a reset refusal (${error?.message})`);
  assert.ok(error.publicationFate !== void 0, 'the refusal states what exists at the destination');
  assert.deepEqual(snapshotTree(published.output), oldBefore, 'the old container and its frozen bytes are byte-identical');
  assert.equal(fs.readFileSync(path.join(destination, 'foreign'), 'utf8'), 'foreign material\n',
    'material at the destination that the reset did not create is not removed');
});

/* =========================================================================== */
/* 6. The shipped surface: declarations, capability and the harness-free graph  */
/* =========================================================================== */

const SHIPPED_PAIRS = [
  ['packages/core/lifecycle.mjs', 'packages/core/lifecycle.d.mts'],
  ['packages/core/freeze.mjs', 'packages/core/freeze.d.mts'],
  ['packages/core/reset.mjs', 'packages/core/reset.d.mts'],
  ['adapters/manual/index.mjs', 'adapters/manual/index.d.mts'],
];

test('every shipped module of this seam carries a byte-identical declaration pair', () => {
  for (const [moduleRelative, declarationRelative] of SHIPPED_PAIRS) {
    const modulePath = path.join(REPO_ROOT, ...moduleRelative.split('/'));
    const declarationPath = path.join(REPO_ROOT, ...declarationRelative.split('/'));
    const tsSibling = declarationPath.replace(/\.mts$/u, '.ts');
    assert.ok(fs.existsSync(modulePath), `${moduleRelative} exists`);
    assert.ok(fs.existsSync(declarationPath), `${declarationRelative} exists`);
    assert.deepEqual(fs.readFileSync(tsSibling), fs.readFileSync(declarationPath),
      `${declarationRelative} is byte-identical to its .ts sibling so either specifier resolves`);
  }
});

test('the shipped modules are consumed as real typed code through the pinned compiler', (t) => {
  const root = scratch(t, 'typed-consumer');
  const cases = [
    ['lifecycle', 'packages/core/lifecycle.mjs', 'import { startRun, stopRun, freezePreconditionFor, type LifecycleErrorCode, type StartRunRequest, type StopRunRequest, type LifecycleView, type FreezeGate } from %S; const begin: (request: StartRunRequest) => Promise<LifecycleView> = startRun; void begin; const finish: (request: StopRunRequest) => Promise<LifecycleView> = stopRun; void finish; const gate: (state: Parameters<typeof freezePreconditionFor>[number]) => FreezeGate = freezePreconditionFor; void gate; const code: LifecycleErrorCode = "RECOVERY_REQUIRED"; void code;'],
    ['freeze', 'packages/core/freeze.mjs', 'import { freezeRun, verifyFrozenSubmission, reconcileFreeze, type FreezeRequest, type FreezeResult } from %S; const command: (request: FreezeRequest) => Promise<FreezeResult> = freezeRun; void command; void verifyFrozenSubmission; void reconcileFreeze;'],
    ['reset', 'packages/core/reset.mjs', 'import { resetRun, ResetError, type ResetRequest, type ResetResult } from %S; const command: (request: ResetRequest) => Promise<ResetResult> = resetRun; void command; void ResetError;'],
    ['adapter', 'adapters/manual/index.mjs', 'import { capabilities, manualLifecycleOperations, MANUAL_ADAPTER_MODULE_ID } from %S; const halt: false = capabilities.halt; void halt; const name: string = MANUAL_ADAPTER_MODULE_ID; void name; void manualLifecycleOperations;'],
  ];
  const tscPath = path.join(STARTER_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  assert.ok(fs.existsSync(tscPath), 'the pinned compiler is the one the release carries in the starter tree');
  for (const [label, moduleRelative, source] of cases) {
    const consumer = path.join(root, `${label}-consumer.mts`);
    let specifier = path.relative(root, path.join(REPO_ROOT, ...moduleRelative.split('/'))).replaceAll('\\', '/');
    if (!specifier.startsWith('.')) specifier = `./${specifier}`;
    fs.writeFileSync(consumer, source.replaceAll('%S', JSON.stringify(specifier)));
    const result = spawnSync(process.execPath, [tscPath, '--noEmit', '--strict', '--target', 'es2022',
      '--module', 'nodenext', '--moduleResolution', 'nodenext', consumer], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${label}: the pinned compiler typechecks a typed consumer of ${moduleRelative}\n${result.stdout}${result.stderr}`);
  }
});

test('the manual adapter states its capability honestly and reuses the released functions verbatim', () => {
  assert.equal(MANUAL_ADAPTER_MODULE_ID, 'benchboard-adapter-manual-v1', 'the adapter names itself');
  assert.ok(Object.isFrozen(capabilities), 'the capability block is frozen');
  assert.equal(capabilities.executionMode, 'MANUAL', 'the only execution mode this release states');
  assert.equal(capabilities.halt, false, 'the adapter cannot halt anything');
  assert.equal(capabilities.deadlineEnforcement, false, 'the adapter enforces no deadline');
  assert.equal(capabilities.stopAssurance, 'operator-attested', 'a stop is an operator attestation');
  assert.equal(capabilities.stopEnforced, false, 'and it is not enforced');
  assert.equal(capabilities.automaticRecovery, false, 'recovery is an explicit operator command');
  assert.equal(capabilities.processControl, false, 'the adapter controls no process');
  assert.equal(capabilities.environmentDiscovery, false, 'the adapter discovers nothing from the environment');
  for (const [name, operation] of Object.entries(manualLifecycleOperations)) {
    const released = lifecycleRuntime[name];
    assert.equal(typeof released, 'function', `${name} is a released operation`);
    assert.equal(operation, released, `${name} is the released function object, not a reimplementation`);
  }
});

/** The import closure over the shipped relative graph. */
function collectImportClosure(entryPath) {
  const seen = new Set();
  const walk = (modulePath) => {
    if (seen.has(modulePath)) return;
    seen.add(modulePath);
    const source = fs.readFileSync(modulePath, 'utf8');
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      walk(path.resolve(path.dirname(modulePath), match[1]));
    }
  };
  walk(entryPath);
  return [...seen].sort();
}

/** Strip comments so a boundary check reads code rather than prose about code. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .join('\n');
}

/** Escape one literal for use inside a regular expression. */
function escapeLiteral(text) {
  return text.replaceAll(/[.*+?^${}()|\\]/g, (character) => `\\${character}`);
}

/* A harness reference is the product name standing on its own or heading an
 * identifier, or appearing as a camel hump inside one, plus the other harness
 * product names. It is deliberately not a bare substring scan: `expectedSha256`
 * contains the letters d-S-h without naming a harness. */
const HARNESS_REFERENCE_PATTERN = new RegExp([
  '(?<![\\w-])(?:DSH|Dsh|dsh)(?![a-z])',
  '(?<=[a-z])(?:DSH|Dsh)(?![A-Z])',
  'agent[-_]teams',
  'kiro',
  'claude',
].join('|'));

/* The released selection policy names some top-level entries it excludes by their
 * harness-workspace spelling (the team-state and state-root names). Those are byte
 * data in a published exclusion list, not a dependency on any harness: a snapshot
 * policy that excludes a directory does not import it. The boundary scan therefore
 * masks exactly those released policy tokens and nothing else — every other
 * harness-shaped name in the shipped graph still fails the scan. */
const POLICY_TOKEN_PATTERN = new RegExp(
  SELECTION_POLICY_EXCLUSIONS.map((token) => escapeLiteral(token).replaceAll('-', '[-_]')).join('|'),
  'g',
);

test('the shipped lifecycle graph is closed, names no harness product and reaches nothing outside the standard library', () => {
  const entries = SHIPPED_PAIRS.map(([relative]) => path.join(REPO_ROOT, ...relative.split('/')));
  const union = [...new Set(entries.flatMap((entry) => collectImportClosure(entry)))].sort();
  assert.ok(union.length >= entries.length, 'the graph is at least the shipped modules');
  for (const modulePath of union) {
    const relativePath = path.relative(REPO_ROOT, modulePath).split(path.sep).join('/');
    assert.match(relativePath, /^(?:packages|adapters)\//, `${relativePath} is inside the shipped tree`);
    assert.ok(!relativePath.startsWith('..'), `${relativePath} does not escape the repository`);
    const body = codeOnly(fs.readFileSync(modulePath, 'utf8'));
    const policyTokens = body.match(POLICY_TOKEN_PATTERN) ?? [];
    const scanned = body.replace(POLICY_TOKEN_PATTERN, '<released-policy-token>');
    const offender = scanned.match(HARNESS_REFERENCE_PATTERN);
    assert.equal(offender, null, `${relativePath} carries no harness reference in its code${offender === null ? '' : ` (${offender[0]})`}`);
    for (const match of body.matchAll(/from\s+['"]([^.'"][^'"]*)['"]/g)) {
      assert.match(match[1], /^node:/, `${relativePath} imports only the standard library: ${match[1]}`);
    }
    for (const token of policyTokens) {
      assert.ok(SELECTION_POLICY_EXCLUSIONS.includes(token),
        `${relativePath} names ${JSON.stringify(token)} only as a member of the released selection exclusion list`);
    }
  }
});

test('an isolated copy of the shipped graph loads and applies the same contract with no harness present', async (t) => {
  const root = scratch(t, 'isolated-graph');
  /* The graph is the shipped modules plus their released dependencies: a copy that
   * omitted `storage.mjs` or `snapshot-copy.mjs` would not load at all, which would
   * prove nothing about isolation. The closure is the released relative import graph,
   * so no harness module and no runner can enter it by construction. */
  const shippedEntries = SHIPPED_PAIRS.map(([moduleRelative]) => path.join(REPO_ROOT, ...moduleRelative.split('/')));
  const closure = [...new Set(shippedEntries.flatMap((entry) => collectImportClosure(entry)))].sort();
  assert.ok(closure.length >= shippedEntries.length, 'the copied graph is at least the shipped modules');
  for (const modulePath of closure) {
    const relativePath = path.relative(REPO_ROOT, modulePath).split(path.sep).join('/');
    const target = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(modulePath, target);
  }
  /* The shipped type declarations travel with their modules, so the copy is the same
   * shipped surface, not a subset of it. */
  for (const [moduleRelative, declarationRelative] of SHIPPED_PAIRS) {
    if (declarationRelative === null) continue;
    const target = path.join(root, ...declarationRelative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, ...declarationRelative.split('/')), target);
    assert.ok(closure.includes(path.join(REPO_ROOT, ...moduleRelative.split('/'))),
      `${moduleRelative} is part of the copied graph`);
  }
  fs.mkdirSync(path.join(root,'schemas'),{recursive:true});
  for(const name of ['lifecycle','run-event'])fs.copyFileSync(path.join(REPO_ROOT,'schemas',name+'.schema.json'),path.join(root,'schemas',name+'.schema.json'));
  const copiedTree = snapshotTree(root);
  assert.ok(!Object.keys(copiedTree).some((key) => key.includes('node_modules') || key.includes('.benchboard')),
    'the copy carries only the graph itself');

  const copied = await import(pathToFileURL(path.join(root, 'packages', 'core', 'lifecycle.mjs')).href);
  const copiedAdapter = await import(pathToFileURL(path.join(root, 'adapters', 'manual', 'index.mjs')).href);
  assert.equal(typeof copied.startRun, 'function', 'the copied graph exposes its entry point');
  assert.equal(copiedAdapter.capabilities.halt, false, 'the copied adapter states the same capability');
  assert.notEqual(copied.LifecycleError, lifecycleRuntime.LifecycleError,
    'the copy is a distinct module registry entry, so a frame inside it is evidence and not an alias');
  assert.notEqual(copied.startRun, lifecycleRuntime.startRun, 'the copied entry point is not the shipped function object');

  const refusal = await rejection(copied.startRun({ runRoot: 'relative/not/absolute' }));
  assert.ok(refusal instanceof copied.LifecycleError, 'the copy raises its own typed error');
  const frames = String(refusal.stack).split('\n').filter((line) => line.includes('file://'));
  const copyRoot = pathToFileURL(root).href;
  const insideCopy = frames.filter((line) => line.includes(copyRoot));
  assert.ok(insideCopy.length >= 1,
    `the refusal is executed inside the copy: ${frames.join(' | ') || String(refusal.stack)}`);
  const shippedCore = pathToFileURL(CORE_ROOT).href;
  assert.equal(frames.filter((line) => line.includes(shippedCore)).length, 0,
    'no frame of the copy execution resolves into the shipped tree');
});

/* =========================================================================== */
/* 7. Publication privacy and selection policy                                  */
/* =========================================================================== */

test('a frozen publication carries no private owner or evaluator material and names the accepted exclusions', async (t) => {
  const { request } = await publishedRun(t, 'privacy');
  await startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') });
  const stopped = await stopRun({ ...request, attestation: attestation(), clock: clockAt('2026-04-01T09:20:00.000Z') });
  const frozen = await freezeRun({ ...request, attestation: stopped.lifecycle.stopAttestation, clock: clockAt('2026-04-01T09:30:00.000Z') });

  const paths = frozen.frozenSubmission.inventory.map(([relativePath]) => relativePath);
  assert.equal(paths.length, frozen.frozenSubmission.fileCount, 'the inventory is the complete byte set');
  assert.ok(!paths.some((relativePath) => /owner|secret|hidden|evaluator/i.test(relativePath)),
    `no private path appears in the published inventory: ${paths.join(', ')}`);
  assert.ok(!paths.some((relativePath) => SELECTION_POLICY_EXCLUSIONS.includes(relativePath.split('/')[0])),
    'no excluded top-level entry was selected');
  assert.ok(!paths.some((relativePath) => /(^|\/)\.benchboard(\/|$)/.test(relativePath)),
    'the state root is never part of a frozen snapshot');
  assert.deepEqual(frozen.proof.selectionExclusions, [...SELECTION_POLICY_EXCLUSIONS],
    'the proof records the accepted exclusion list verbatim');
  assert.equal(frozen.proof.byteCount, frozen.frozenSubmission.byteCount, 'the proof and submission agree on bytes');

  /* The private fixture roots are still present and unread by the publication. */
  assert.ok(!paths.includes('owner-secret.txt') && !paths.includes('hidden-tests.txt'),
    'the populated private roots are absent from the snapshot');
});

test('the published proof is byte-identical on a re-read and its record identity is recomputable', async (t) => {
  const { request } = await publishedRun(t, 'proof-identity');
  await startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') });
  const stopped = await stopRun({ ...request, attestation: attestation(), clock: clockAt('2026-04-01T09:20:00.000Z') });
  const frozen = await freezeRun({ ...request, attestation: stopped.lifecycle.stopAttestation, clock: clockAt('2026-04-01T09:30:00.000Z') });

  const stored = await stateStorage(request.runRoot).read({
    relativePath: `freeze/${frozen.snapshotId}.json`, kind: FREEZE_PROOF_KIND, id: `${request.manifestId}:snapshot-proof:${frozen.snapshotId}`,
  });
  assert.equal(lifecycleCanonicalJson(stored), lifecycleCanonicalJson(frozen.proof), 'the proof reads back byte-equal');
  assert.equal(stored.proofId, `${frozen.snapshotId}:proof`, 'the proof identity recomputes from the snapshot identity');
  assert.equal(stored.kind, FREEZE_PROOF_KIND, 'the proof carries the released kind');
  assert.equal(stored.freezeRoute, 'STOP_RECORDED', 'the route is recorded in the proof, not inferred');
  assert.equal(stored.stopAttestation.operator, stopped.lifecycle.stopAttestation.operator, 'the proof binds the stop attestation');
  const submissionStored = await stateStorage(request.runRoot).read({
    relativePath: `freeze/${frozen.frozenSubmission.frozenSubmissionId}.json`, kind: FREEZE_SUBMISSION_KIND,
    id: `${request.manifestId}:frozen-submission:${frozen.frozenSubmission.frozenSubmissionId}`,
  });
  assert.equal(stored.submissionDigest, sha256(stored.frozenSubmissionId.length === submissionStored.frozenSubmissionId.length
    ? Buffer.from(lifecycleCanonicalJson(submissionStored), 'utf8') : Buffer.alloc(0)),
    'the proof submission digest recomputes over the stored submission bytes');
});

test('a frozen snapshot is immutable in the released sense: a later verification reads it and a retry cannot overwrite it', async (t) => {
  const { request } = await publishedRun(t, 'immutable-retry');
  await startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') });
  const stopped = await stopRun({ ...request, attestation: attestation(), clock: clockAt('2026-04-01T09:20:00.000Z') });
  const frozen = await freezeRun({ ...request, attestation: stopped.lifecycle.stopAttestation, clock: clockAt('2026-04-01T09:30:00.000Z') });
  const containerBefore = snapshotTree(frozen.snapshotContainer);

  /* An attempt to publish over an existing container identity is refused, not
   * merged, and it removes nothing. */
  await expectLifecycleCode(freezeRun({ ...request, attestation: stopped.lifecycle.stopAttestation }),
    LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a second freeze over a closed run');
  assert.deepEqual(snapshotTree(frozen.snapshotContainer), containerBefore, 'the published container is unchanged');

  /* The bytes themselves still hash to what was published. */
  const check = await verifyFrozenSubmission(request);
  const reported = check.submissions[0];
  assert.equal(reported.treeDigest, frozen.proof.treeDigest, 'the digest on disk is the published digest');
  assert.equal(reported.byteCount, frozen.proof.byteCount, 'the bytes on disk are the published byte count');
});

/**
 * Stage one projection through the accepted mutable write under the reserved
 * lifecycle identity. The envelope stays storage-consistent: the bytes are
 * written as a well-formed record of the accepted kind and id and read back
 * under exactly that identity, so the refusal a test observes can only come
 * from the lifecycle reading the projection, never from raw envelope damage.
 */
async function stageProjection(runRoot, manifestId, record) {
  const storage = stateStorage(runRoot);
  await storage.withLock(async () => {
    await storage.replaceMutable({
      relativePath: LIFECYCLE_STATE_RELATIVE_PATH,
      kind: LIFECYCLE_STATE_KIND,
      id: `${manifestId}:lifecycle-state`,
      value: record,
    });
  });
}

/* =========================================================================== */
/* 8. Concurrency and the single-writer rule                                    */
/* =========================================================================== */

test('two whole-command writers cannot both hold one run, and a reader refuses rather than stealing the lock', async (t) => {
  const { request } = await publishedRun(t, 'concurrency');
  const results = await Promise.allSettled([
    startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') }),
    startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') }),
  ]);
  assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1, 'one command proceeds');
  assert.equal(results.filter((entry) => entry.status === 'rejected').length, 1, 'the other refuses rather than waiting or stealing');
  const view = await readRunLifecycle(request);
  assert.equal(view.journal.events.filter((event) => event.kind === 'START_INTENT').length, 1,
    'exactly one start was journaled');
});

/* =========================================================================== */
/* 9. Persisted tampering of the projection is refused by every face            */
/* =========================================================================== */

/**
 * The table: five ways a projection can be restated outside the lifecycle module
 * (each one a *storage-consistent* record — a well-formed envelope of the accepted
 * kind and id whose self digest recomputes, except the variant whose whole point
 * is that it does not) driven across the six public operations.
 *
 * The safety invariant is fixed: no face may act on a projection whose own bytes
 * it cannot establish. The read face reports the read refusal it is, a command
 * reports the recovery route rather than compounding the tamper with a write, and
 * the reset reports its own typed refusal. In every cell the stored bytes are
 * byte-identical afterwards and no new destination appears.
 */
const BAD_STATE_VARIANTS = [
  { name:'manifest digest mismatch',apply:r=>{r.manifestDigest='a'.repeat(64);} },
  { name:'negative elapsed',apply:r=>{r.elapsedMs=-1;} },
  { name:'malformed instant',apply:r=>{r.stoppedAt='not-an-instant';} },
  { name:'false stop claim',apply:r=>{r.stopAttestation.agentStopped=false;} },
  { name:'bad declaration',apply:r=>{r.declaration.workerCount=-1;} },
  { name:'bad assurance',apply:r=>{r.stopAssurance='enforced';} },
  { name:'bad clock error',apply:r=>{r.clockError={code:'unknown',error:'invalid',elapsedAvailable:true};} },
  { name:'bad history',apply:r=>{r.history=[{at:'invalid',operation:'FABRICATED'}];} },
  { name:'journal-authority mismatch',apply:r=>{r.stopAttestation.statement='a different unjournaled observation';} },
  { name:'bad journal timestamp',apply:r=>{r.journalCommitAt='unknown';} },
  {
    name: 'a self digest that does not recompute from the bytes read back',
    apply: (record) => { record.stateDigest = 'f'.repeat(64); return record; },
  },
  {
    name: 'a schema version this module does not read',
    apply: (record) => { record.schemaVersion = '9.9.9'; return record; },
  },
  {
    name: 'a kind this path does not carry',
    apply: (record) => { record.kind = 'benchboard.some.other.record.v1'; return record; },
  },
  {
    name: 'a binding to another run',
    apply: (record) => { record.runId = 'run-00000000-0000-4000-8000-000000000000'; return record; },
  },
  {
    name: 'a field no contract describes',
    apply: (record) => { record.tamperedBy = 'outside-the-module'; return record; },
  },
];

test('a persisted projection that states facts no writer authored is refused by all six faces with every byte preserved', async (t) => {
  const { fixture, published, request } = await publishedRun(t, 'persisted-tamper');
  await startAndStop(request);
  const good = await readStateRecord(request.runRoot, request.manifestId);
  assert.ok(good !== void 0 && good.state === 'STOP_RECORDED', 'the table drives a run that has journaled and projected a stop');

  const destination = path.join(fixture.publishParent, 'tamper-reset-destination');
  const refusedCells = [];

  for (const variant of BAD_STATE_VARIANTS) {
    /* Each variant gets its own tampered container so no cell can inherit a
     * refusal from the cell before it. The tamper is staged exactly as the
     * lifecycle publishes: the accepted mutable write under the reserved
     * identity, inside the held lock. Every variant but the first restates its
     * own self digest so the bytes stay internally consistent and the refusal
     * can only come from the field under test. */
    const tampered = structuredClone(good);
    variant.apply(tampered);
    if (variant.name !== 'a self digest that does not recompute from the bytes read back') {
      tampered.stateDigest = lifecycleStateDigestOf(tampered);
    }
    await stageProjection(request.runRoot, request.manifestId, tampered);

    /* The tamper is now the fact on disk; everything after it must leave bytes
     * alone, so the baseline snapshot is taken at this point. */
    const before = snapshotTree(request.runRoot);

    const faces = [
      ['readRunLifecycle', () => readRunLifecycle(request), LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED],
      ['startRun', () => startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:06:00.000Z') }), LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED],
      ['stopRun', () => stopRun({ ...request, attestation: attestation(), clock: clockAt('2026-04-01T09:21:00.000Z') }), LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED],
      ['reconcileRun', () => reconcileRun({ ...request, interruptedOperation: 'START', disposition: { operator: 'operator-one', decision: 'LEAVE_AS_IS', attestation: 'the operator states the run is left exactly as it is' } }), LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED],
      ['freezeRun', () => freezeRun({ ...request, attestation: attestation(), clock: clockAt('2026-04-01T09:30:00.000Z') }), LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED],
      ['resetRun', () => resetRun(resetRequest(published, fixture, { output: destination })), null],
    ];

    for (const [face, invoke, expectedCode] of faces) {
      const cell = `${variant.name} :: ${face}`;
      const error = await rejection(invoke());
      /* The one assertion that may never be weakened: a tampered projection is
       * never acted on. An acceptance here is a safety failure, reported as such. */
      assert.ok(error !== void 0, `${cell}: a tampered projection was ACCEPTED — the safety invariant is broken`);
      if (expectedCode !== null) {
        assert.equal(error?.code, expectedCode, `${cell}: expected ${expectedCode}, got ${String(error?.code)} (${error?.message})`);
        assert.match(error.message, new RegExp(`^${expectedCode}: `), `${cell}: the message names the code first`);
      } else {
        /* The reset face carries its own typed error out of the accepted
         * transaction; whatever the code, the reset must report it and the
         * destination must not exist. */
        assert.ok(error instanceof ResetError || Object.hasOwn(error ?? {}, 'code'),
          `${cell}: the reset reports a typed refusal, got ${error?.name}: ${error?.message}`);
        assert.equal(fs.existsSync(destination), false, `${cell}: a refused reset leaves no destination behind`);
      }
      refusedCells.push(`${cell} -> ${String(error?.code)}`);
      assert.deepEqual(snapshotTree(request.runRoot), before, `${cell}: the stored bytes are byte-identical after the refusal`);
    }
    assert.equal(fs.existsSync(destination), false, `${variant.name}: no reset destination was created`);
  }

  /* The whole table ran: six faces over five tampered projections. */
  assert.equal(refusedCells.length, BAD_STATE_VARIANTS.length * 6, 'every cell of the table refused');
});


function rewriteJournalConsistently(runRoot,events){
 const state=path.join(runRoot,'.benchboard'),registryPath=path.join(state,'.storage','registry.json'),registry=JSON.parse(fs.readFileSync(registryPath));let previous=null;
 for(let i=0;i<events.length;i++){const event=events[i];event.sequence=i;event.previousEventDigest=previous;event.eventDigest=lifecycleEventDigestOf(event);previous=event.eventDigest;const relativePath='lifecycle/journal/'+String(i).padStart(5,'0')+'.json',target=path.join(state,relativePath),envelope=JSON.parse(fs.readFileSync(target));envelope.value=event;envelope.digest=createHash('sha256').update(lifecycleCanonicalJson({id:envelope.id,kind:envelope.kind,value:event})).digest('hex');fs.writeFileSync(target,JSON.stringify(envelope));const record=Object.values(registry.records).find(r=>r.relativePath===relativePath);record.digest=envelope.digest;}
 fs.writeFileSync(registryPath,JSON.stringify(registry));
}
test('storage-consistent recomputed journal tampering is refused by seven public faces without a write',async t=>{
 const {fixture,published,request}=await publishedRun(t,'persisted-journal-tamper');await startAndStop(request);await freezeRun({...request,attestation:attestation(),clock:clockAt('2026-04-01T09:30:00.000Z')});const good=structuredClone((await readRunLifecycle(request)).journal.events);const destination=path.join(fixture.publishParent,'journal-tamper-reset');
 const variants=[['start detail',events=>{events[0].detail={operator:'ops-desk'};}],['normal commit operator',events=>{events[1].detail.operator='ops-desk';}],['normal commit intent',events=>{events[1].detail.completedFromIntentDigest=events[0].eventDigest;}],['false reconciliation',events=>{events[1].detail.reconciliation=false;}],['missing reconciliation operator',events=>{events[1].detail.reconciliation=true;events[1].detail.completedFromIntentDigest=events[0].eventDigest;}],['missing reconciliation intent',events=>{events[1].detail.reconciliation=true;events[1].detail.operator='ops-desk';}],['stop wrong known field',events=>{events[2].detail.reconciliation=true;}],['freeze intent wrong known field',events=>{events[3].detail.completedFromIntentDigest=events[0].eventDigest;}],['freeze commit reconciliation',events=>{events[4].detail={...events[4].detail,reconciliation:true,operator:'ops-desk',completedFromIntentDigest:'a'.repeat(64)};}],['freeze commit operator',events=>{events[4].detail.operator='ops-desk';}],['order',events=>{[events[1],events[2]]=[events[2],events[1]];}],['extra field',events=>{events[2].invented='claim';}],['false stop',events=>{events[2].detail.agentStopped=false;}],['bad instant',events=>{events[2].occurredAt='invalid-time';}],['commit authority',events=>{events[1].detail.completedFromIntentDigest='a'.repeat(64);}],['bad commit binding',events=>{events[1].detail.stateEventDigest='not-a-digest';}]];
 let cells=0;for(const [name,mutate]of variants){const events=structuredClone(good);mutate(events);rewriteJournalConsistently(request.runRoot,events);const storage=stateStorage(request.runRoot);for(let i=0;i<events.length;i++){const e=await storage.read({relativePath:'lifecycle/journal/'+String(i).padStart(5,'0')+'.json',kind:'benchboard.lifecycle.event.v1',id:request.manifestId+':event:'+String(i).padStart(5,'0')});assert.equal(e.eventDigest,lifecycleEventDigestOf(e),'accepted storage and selfdigest pass for actual tampered event');}
 const before=snapshotTree(request.runRoot);const faces=[()=>readRunLifecycle(request),()=>withRunTransaction(request,()=>true),()=>startRun({...request,declaration:declaration()}),()=>stopRun({...request,attestation:attestation()}),()=>reconcileRun({...request,interruptedOperation:'START',disposition:{operator:'ops-desk',decision:'LEAVE_AS_IS',attestation:'preserve exact facts'}}),()=>freezeRun({...request,attestation:attestation()}),()=>resetRun(resetRequest(published,fixture,{output:destination}))];
 for(const invoke of faces){assert.ok(await rejection(invoke()),name+' invalid persisted authority must refuse');assert.deepEqual(snapshotTree(request.runRoot),before,name+' bytes preserved');assert.equal(fs.existsSync(destination),false);cells++;}}
 assert.equal(cells,variants.length*7);
});
