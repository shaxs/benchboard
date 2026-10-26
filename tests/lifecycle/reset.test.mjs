/**
 * BenchBoard v0.1 C3 T4 — the fresh-identity reset without destructive
 * old-run mutation.
 *
 * Every container here is a real C2 container produced by the accepted
 * `initialiseRun` over synthetic fixture bytes, and every lifecycle state is
 * reached through the accepted T1 seams. Nothing is faked: a refusal is proven
 * by observing that no byte appeared at the destination and that the old
 * container's bytes hash identically before and after the attempt. Dependencies
 * are `none` or a synthetic `prepared` cache only — no real install is run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  RESET_ERROR_CODES,
  RESET_ELIGIBLE_STATES,
  ResetError,
  resetRun,
} from '../../packages/core/reset.mjs';
import { initialiseRun, INIT_STATE_KIND, RUN_STATE_RELATIVE_PATH, STATE_DIRECTORY_NAME, WORKSPACE_DIRECTORY_NAME } from '../../packages/core/init.mjs';
import { sha256, hashEntries } from '../../packages/core/identity.mjs';
import { validateRecord } from '../../packages/core/manifest.mjs';
import { EXPECTED_WORKLOAD_FILE_COUNT } from '../../packages/core/challenge-export.mjs';
import { loadFixture } from '../contracts/fixtures/contracts/index.mjs';
import {
  LIFECYCLE_JOURNAL_DIRECTORY,
  LIFECYCLE_STATE_RELATIVE_PATH,
  STOP_ASSURANCE,
  withRunTransaction,
  startRun,
  stopRun,
  readRunLifecycle,
} from '../../packages/core/lifecycle.mjs';
// FROZEN fixtures use only released T1 seams; T3 may be actively edited.
import { createStorage } from '../../packages/core/storage.mjs';

/* ----------------------------------------------------------------- constants */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STARTER_ROOT = path.join(REPO_ROOT, 'starter');
const RELEASE_INVENTORY_PATH = path.join(REPO_ROOT, 'release', 'inventory.json');
const HEX64 = /^[0-9a-f]{64}$/;
const RAW_COMPARE = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** Read the accepted participant inventory as raw data, importing nothing legacy. */
function releaseParticipantPaths() {
  const inventory = JSON.parse(fs.readFileSync(RELEASE_INVENTORY_PATH, 'utf8'));
  return Object.freeze(inventory.participant.files.map((entry) => entry.path));
}

/**
 * Scratch root: an explicit absolute override when the harness supplies one,
 * else a directory inside this repository. The read-only starter tree must never
 * be entered as scratch, so an override containing it is refused outright.
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
  const contained = fileURLToPath(new URL('./.tmp/reset/', import.meta.url));
  fs.mkdirSync(contained, { recursive: true });
  return contained;
}

/** One throwaway directory per test, removed when that test finishes. */
function scratch(t, name) {
  const directory = fs.mkdtempSync(path.join(scratchRoot(), `c3-t4-${name}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/* ------------------------------------------------------------------- helpers */

/** Byte-for-byte copy, so fixture bytes can never be re-encoded. */
function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fs.readFileSync(source));
}

const segments = (relativePath) => relativePath.split('/');
const starterPath = (relativePath) => path.join(STARTER_ROOT, ...segments(relativePath));
const inRoot = (root, relativePath) => path.join(root, ...segments(relativePath));

function rootEntry(root, relativePath) {
  return Object.freeze([relativePath, sha256(fs.readFileSync(inRoot(root, relativePath)))]);
}

/**
 * A real ChallengeIdentity over the bytes actually copied into the fixture
 * source root: the inventory is the exact sorted `[path, sha256]` list and the
 * workload digest is recomputed with the accepted helper, so the shipped
 * contract validator re-derives the recorded value.
 */
function buildIdentity(sourceRoot, paths) {
  const starterInventory = paths
    .map((relativePath) => rootEntry(sourceRoot, relativePath))
    .sort((left, right) => RAW_COMPARE(left[0], right[0]));
  return Object.freeze({
    schemaVersion: '1.0.0',
    kind: 'ChallengeIdentity',
    challengeId: 'c3-t4-fixture-board',
    challengeVersion: '0.9.0',
    architectureId: 'arch-c3-t4-fixture',
    architectureKind: 'challenge',
    hashAlgorithm: 'sha256',
    definitionDigest: sha256('c3-t4-fixture:definition'),
    digestProvenance: Object.freeze({ kind: 'COMPUTED', procedure: 'c3-t4-fixture:sha256:source-bytes' }),
    workloadProvenance: Object.freeze({ kind: 'COMPUTED', procedure: 'c3-t4-fixture:starter-inventory-digest' }),
    publicPrdDigest: sha256('c3-t4-fixture:public-prd'),
    visibleHarnessDigest: sha256('c3-t4-fixture:visible-harness'),
    fixtureDigest: sha256('c3-t4-fixture:fixture'),
    starterInventory: Object.freeze(starterInventory),
    workloadDigest: hashEntries(starterInventory),
    declaredCeilingMinutes: 120,
    candidateLineage: Object.freeze({
      candidateVersion: '1.0.0-candidate.9',
      candidateStatus: 'REVIEW_FINDINGS_UNRESOLVED',
      sourceCommit: 'c662a4a1b2c3d4e5f60718293a4b5c6d7e8f90a1',
      sourceTag: 'candidate-nine-synthetic',
      reviewStatus: 'CHANGES_REQUESTED',
      lineageNotes: 'Synthetic lineage carried by the focused fixture, not a certified release.',
    }),
    notes: 'C3 T4 focused fixture identity, derived from the read-only starter bytes.',
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
 * One fixture: contained roots, a seeded source root carrying the accepted
 * starter bytes, populated private owner and evaluator roots, and an identity
 * derived over exactly those bytes. The reset target parent exists; a target
 * never does.
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

/** One accepted C2 challenge package for a fixture. */
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
 * One accepted C2 initialisation request. Every field the API requires is stated
 * here so a test that changes one field changes only that field; the module
 * under test infers nothing from the machine it runs on.
 */
function initRequest(fixture, overrides = {}) {
  const pick = (key, fallback) => (key in overrides ? overrides[key] : fallback);
  return {
    output: pick('output', path.join(fixture.publishParent, 'run-one')),
    challenge: pick('challenge', packageFor(fixture)),
    dependencies: pick('dependencies', { mode: 'none' }),
    toolingIdentity: pick('toolingIdentity', fixture.toolingIdentity),
    evaluatorIdentity: pick('evaluatorIdentity', fixture.evaluatorIdentity),
    architectureId: pick('architectureId', 'arch-run-c3-t4'),
    /* The lifecycle seam only permits a manual start on a run that declares the
     * manual harness, and the ceiling must sit under the fixture challenge's. */
    harness: pick('harness', 'manual'),
    declaredCeilingMinutes: pick('declaredCeilingMinutes', 60),
    createdAt: pick('createdAt', '2026-04-01T09:00:00.000Z'),
  };
}

/**
 * The reset request for one published container: the same identities and the
 * same challenge package the old run bound, aimed at a fresh destination. `runRoot`
 * is the old container root — the directory holding `workspace/` and
 * `.benchboard/` — and the fresh ids are never named here, because the accepted
 * initialiser generates them.
 */
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
      architectureId: pick('architectureId', 'arch-run-c3-t4'),
      harness: pick('harness', 'manual'),
      declaredCeilingMinutes: pick('declaredCeilingMinutes', 60),
      createdAt: pick('createdAt', '2026-04-01T10:00:00.000Z'),
      ...(pick('requestExtra', void 0) ?? {}),
    }),
    ...(pick('restExtra', void 0) ?? {}),
  };
}

/** Recursive, deterministic snapshot of one tree, keyed by relative POSIX path. */
function snapshotTree(root) {
  const seen = new Map();
  const walk = (absolute, relative) => {
    const status = fs.lstatSync(absolute);
    if (status.isSymbolicLink()) {
      seen.set(relative, 'link');
      return;
    }
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

/** The entries added to a snapshot, or removed from it. */
function addedEntries(before, after) {
  return Object.keys(after).filter((key) => !(key in before)).sort(RAW_COMPARE);
}
function removedEntries(before, after) {
  return Object.keys(before).filter((key) => !(key in after)).sort(RAW_COMPARE);
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

/** Assert one fail-closed refusal carrying the expected reset code, spelled first. */
async function expectCode(promise, code, label) {
  const error = await rejection(promise);
  assert.ok(error !== void 0, `${label}: a rejection was expected`);
  assert.ok(error instanceof ResetError, `${label}: a ResetError was expected, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, `${label}: error code (${error.message})`);
  assert.match(error.message, new RegExp(`^${code}: `), `${label}: the message names the code first`);
  return error;
}

/** The immutable declaration a manual run states. */
function declaration(overrides = {}) {
  return {
    harness: 'manual',
    model: null,
    workerCount: 2,
    executionMode: 'MANUAL',
    declaredCeilingMinutes: 60,
    ...overrides,
  };
}

/** The attestation a stop requires. */
function attestation(overrides = {}) {
  return {
    operator: 'operator-one',
    agentStopped: true,
    statement: 'the cooperating participants stopped of their own cooperation',
    ...overrides,
  };
}

/** The journaled authority a FREEZE_INTENT entry must carry: the same attested
 *  operator statement a stop carries, plus the two assurances that qualify it. */
function freezeIntentDetail(overrides = {}) {
  return {
    operator: 'operator-one',
    agentStopped: true,
    statement: 'the cooperating participants stopped of their own cooperation',
    observedAt: null,
    assurance: STOP_ASSURANCE,
    enforced: false,
    /* The route is a stated fact of the intent, not a field a writer may leave
     * out: every fixture here stages a freeze over a journaled stop, which is
     * the bound route. */
    clockless: false,
    ...overrides,
  };
}

/** A deterministic clock; `null` states that the wall clock is unknown. */
function clockAt(value) {
  return { now: () => value };
}

/* =========================================================================== */
/* The first proof: a derived INITIALIZED reset, and refusal before any write   */
/* =========================================================================== */

test('a derived INITIALIZED run resets to a fresh C2 container with independent ids', async (t) => {
  const fixture = buildFixture(t, 'fresh-init');
  const before = await initialiseRun(initRequest(fixture));
  const oldContainerBefore = snapshotTree(before.output);

  const result = await resetRun(resetRequest(before, fixture));

  /* The new container is a real published C2 run. */
  assert.ok(HEX64.test(result.manifest.manifestDigest ?? ''), 'the new manifest carries a digest');
  assert.equal(result.oldContainerMutation, 'none', 'the command reports that it mutated nothing of the old run');
  assert.equal(result.fresh, true, 'the result states a fresh container');
  assert.notEqual(result.manifest.manifestId, before.manifest.manifestId, 'the manifestId is independently fresh');
  assert.notEqual(result.manifest.runId, before.manifest.runId, 'the runId is independently fresh');
  assert.match(result.manifest.manifestId, /^manifest-/, 'the fresh manifestId comes from the accepted generator');
  assert.match(result.manifest.runId, /^run-/, 'the fresh runId comes from the accepted generator');

  /* The challenge identity carries into the new manifest unchanged: same
   * challenge, same exact workload hash, and the full 26-file workload. */
  assert.equal(result.manifest.bindings.challenge.challengeId, fixture.identity.challengeId, 'the challenge id is the old one');
  assert.equal(
    result.manifest.bindings.challenge.workloadDigest,
    before.manifest.bindings.challenge.workloadDigest,
    'the workload digest is the exact original workload hash',
  );
  assert.equal(result.manifest.bindings.challenge.workloadDigest, fixture.identity.workloadDigest, 'the workload hash is the one derived over the starter bytes');
  assert.equal(
    result.manifest.bindings.challenge.challengeIdentityDigest,
    before.manifest.bindings.challenge.challengeIdentityDigest,
    'the challenge identity digest bound by the new manifest is the exact one the old run bound',
  );
  assert.equal(result.initResult.workload.fileCount, EXPECTED_WORKLOAD_FILE_COUNT, `the new workspace carries the ${String(EXPECTED_WORKLOAD_FILE_COUNT)} workload files`);
  assert.notEqual(result.manifest.participantWorkspaceRoot, before.manifest.participantWorkspaceRoot, 'the new workspace is a different location');

  /* The new container reads back through the accepted storage seam. */
  const storage = createStorage({ root: path.join(result.output, STATE_DIRECTORY_NAME) });
  const readback = await storage.read({
    relativePath: RUN_STATE_RELATIVE_PATH,
    kind: INIT_STATE_KIND,
    id: result.manifest.manifestId,
  });
  assert.equal(readback.runId, result.manifest.runId, 'the published container reads back the reported run');

  /* The old container is byte-identical: same entries, same content hashes. */
  assert.deepEqual(snapshotTree(before.output), oldContainerBefore, 'the old container is byte-for-byte preserved');
  /* The source bytes the reset read are untouched. */
  const sourcePackage = sha256(fs.readFileSync(inRoot(fixture.sourceRoot, 'package.json')));
  const starterPackage = sha256(fs.readFileSync(starterPath('package.json')));
  assert.equal(sourcePackage, starterPackage, 'the original source bytes are preserved');
});

test('a STOP_RECORDED run resets while its stopped journal and record are preserved', async (t) => {
  const fixture = buildFixture(t, 'stop-recorded');
  const before = await initialiseRun(initRequest(fixture));
  const request = { runRoot: before.output, manifestId: before.manifest.manifestId, runId: before.manifest.runId };
  await startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') });
  await stopRun({
    ...request,
    attestation: attestation(),
    clock: clockAt('2026-04-01T09:20:00.000Z'),
  });
  const oldState = await readRunLifecycle(request);
  assert.equal(oldState.state, 'STOP_RECORDED', 'the fixture really reached STOP_RECORDED');
  const oldContainerBefore = snapshotTree(before.output);

  const result = await resetRun(resetRequest(before, fixture));

  assert.notEqual(result.manifest.runId, before.manifest.runId, 'the reset identity is independent of the stopped run');
  assert.equal(result.manifest.bindings.challenge.workloadDigest, fixture.identity.workloadDigest, 'the stopped run keeps the same challenge bytes');
  const after = await readRunLifecycle(request);
  assert.equal(after.state, 'STOP_RECORDED', 'the old lifecycle still reports its stopped state');
  assert.deepEqual(snapshotTree(before.output), oldContainerBefore, 'the stopped container is byte-for-byte preserved');
});

test('a FROZEN run resets to a fresh container with its history intact', async (t) => {
  const fixture = buildFixture(t, 'frozen');
  const before = await initialiseRun(initRequest(fixture));
  const request = { runRoot: before.output, manifestId: before.manifest.manifestId, runId: before.manifest.runId };
  await startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') });
  const stopped = await stopRun({ ...request, attestation: attestation(), clock: clockAt('2026-04-01T09:20:00.000Z') });
  /* A freeze from STOP_RECORDED must repeat the exact bound stop attestation, and
   * its journaled intent must carry the same attested operator and statement: the
   * authority is read before the projection is written. */
  await withRunTransaction(request, async context => {
    const bound = structuredClone(stopped.lifecycle.stopAttestation);
    await context.appendEvent({kind:'FREEZE_INTENT', occurredAt:null, journalCommitAt:null, detail:{ operator:bound.operator, agentStopped:true, statement:bound.statement, observedAt:bound.observedAt ?? null, assurance:STOP_ASSURANCE, enforced:false, clockless:false }});
    const frozenState = await context.commitState({state:'FROZEN', stopAttestation:bound});
    await context.appendEvent({kind:'FREEZE_COMMIT', occurredAt:null, journalCommitAt:null, detail:{stateEventDigest:frozenState.stateDigest}});
  });
  const frozen = await readRunLifecycle(request);
  assert.equal(frozen.state, 'FROZEN', 'the fixture really reached FROZEN');
  const oldContainerBefore = snapshotTree(before.output);

  const result = await resetRun(resetRequest(before, fixture));
  assert.equal(result.source.state, 'FROZEN', 'the reset names the state it acted on');
  const after = await readRunLifecycle(request);
  assert.equal(after.state, 'FROZEN', 'the frozen run stays frozen and closed');
  assert.deepEqual(snapshotTree(before.output), oldContainerBefore, 'the frozen container is byte-for-byte preserved');
});

/* --------------------------------------------------------- refusal before write */

test('a RUNNING run is refused as an active run and no destination is created', async (t) => {
  const fixture = buildFixture(t, 'running-refused');
  const before = await initialiseRun(initRequest(fixture));
  const request = { runRoot: before.output, manifestId: before.manifest.manifestId, runId: before.manifest.runId };
  await startRun({ ...request, declaration: declaration(), clock: clockAt('2026-04-01T09:05:00.000Z') });
  const active = await readRunLifecycle(request);
  assert.equal(active.state, 'RUNNING', 'the run is active');
  const output = path.join(fixture.publishParent, 'reset-should-not-exist');

  const error = await expectCode(
    resetRun(resetRequest(before, fixture, { output })),
    RESET_ERROR_CODES.STATE_REFUSED,
    'a reset of an active run',
  );
  assert.equal(error.state, 'RUNNING', 'the refusal names the state it refused');
  assert.equal(fs.existsSync(output), false, 'the refused reset created no destination');
  assert.equal((await readRunLifecycle(request)).state, 'RUNNING', 'the active run is untouched');
});

test('an interrupted start (unresolved START_INTENT) is refused before any write', async (t) => {
  const fixture = buildFixture(t, 'interrupted-start');
  const before = await initialiseRun(initRequest(fixture));
  const request = { runRoot: before.output, manifestId: before.manifest.manifestId, runId: before.manifest.runId };
  /* Leave exactly what a killed process leaves: the intent journaled, no commit. */
  await withRunTransaction(request, async (context) => {
    await context.appendEvent({ kind: 'START_INTENT', declaration: declaration(), occurredAt: null, journalCommitAt: null });
    await context.commitState({ state: 'RUNNING', declaration: declaration(), startedAt: null, historyEntry: { operation: 'START' } });
    return 'interrupted';
  });
  const output = path.join(fixture.publishParent, 'reset-should-not-exist');

  const error = await expectCode(
    resetRun(resetRequest(before, fixture, { output })),
    RESET_ERROR_CODES.JOURNAL_INCOMPLETE,
    'a reset over an interrupted start',
  );
  assert.equal(error.interruptedOperation, 'START', 'the refusal names the interrupted operation');
  assert.equal(fs.existsSync(output), false, 'the refused reset created no destination');
});

test('a pending FREEZE_INTENT is refused under STOP_RECORDED, FROZEN projection and null instants', async (t) => {
  /* The projected state looks eligible in every one of these shapes, which is
   * exactly why the journal itself is read: an unresolved freeze intent is an
   * operation in flight and a reset must not start a fresh identity over it. */
  const shapes = [
    { name: 'stop-recorded', expected: RESET_ERROR_CODES.JOURNAL_INCOMPLETE },
    /* The shape where the record already claims FROZEN while the freeze commit
     * is absent: that is a journal-versus-projection contradiction, which is
     * refused as an inconsistency before the pending intent is ever reached. */
    { name: 'frozen-projection', expected: RESET_ERROR_CODES.JOURNAL_INCONSISTENT },
    { name: 'null-instants', expected: RESET_ERROR_CODES.JOURNAL_INCOMPLETE },
  ];
  for (const shape of shapes) {
    const fixture = buildFixture(t, `pending-freeze-${shape.name}`);
    const before = await initialiseRun(initRequest(fixture));
    const request = { runRoot: before.output, manifestId: before.manifest.manifestId, runId: before.manifest.runId };
    await withRunTransaction(request, async (context) => {
      /* A start and stop that completed, then a freeze intent with no commit. */
      await context.appendEvent({ kind: 'START_INTENT', declaration: declaration(), occurredAt: '2026-04-01T09:05:00.000Z', journalCommitAt: null });
      await context.commitState({ state: 'RUNNING', declaration: declaration(), startedAt: '2026-04-01T09:05:00.000Z', historyEntry: { operation: 'START' } });
      await context.appendEvent({ kind: 'START_COMMIT', declaration: declaration(), occurredAt: '2026-04-01T09:05:00.000Z', journalCommitAt:null, detail: { stateEventDigest: context.lifecycle.stateDigest } });
      await context.appendEvent({ kind: 'STOP_RECORDED', declaration:declaration(), occurredAt: shape.name === 'null-instants' ? null : '2026-04-01T09:20:00.000Z', detail:{...attestation(), observedAt: null, assurance:'operator-attested', enforced:false} });
      await context.commitState({
        state: 'STOP_RECORDED',
        stoppedAt: shape.name === 'null-instants' ? null : '2026-04-01T09:20:00.000Z',
        stopAttestation: attestation(),
        historyEntry: { operation: 'STOP' },
      });
      if (shape.name === 'frozen-projection') {
        /* The record advances to FROZEN while the freeze COMMIT event never
         * lands: the projection says FROZEN, the journal implies STOP_RECORDED. */
        await context.appendEvent({ kind: 'FREEZE_INTENT', occurredAt: '2026-04-01T09:30:00.000Z', detail: freezeIntentDetail() });
        await context.commitState({
          state: 'FROZEN',
          stopAttestation: attestation(),
          journalCommitAt: '2026-04-01T09:30:00.000Z',
          historyEntry: { operation: 'FREEZE' },
        });
      } else {
        await context.appendEvent({ kind: 'FREEZE_INTENT', occurredAt: '2026-04-01T09:30:00.000Z', detail: freezeIntentDetail() });
      }
      return 'staged';
    });
    const output = path.join(fixture.publishParent, 'reset-should-not-exist');
    const error = await expectCode(
      resetRun(resetRequest(before, fixture, { output })),
      shape.expected,
      `a reset with a pending freeze intent (${shape.name})`,
    );
    if (shape.expected === RESET_ERROR_CODES.JOURNAL_INCOMPLETE) {
      assert.equal(error.interruptedOperation, 'FREEZE', `the refusal names the interrupted freeze (${shape.name})`);
    } else {
      assert.ok(Array.isArray(error.findings) && error.findings.length > 0, `the refusal lists what did not verify (${shape.name})`);
    }
    assert.equal(fs.existsSync(output), false, `the refused reset created no destination (${shape.name})`);
  }
});

test('a lock held by another writer refuses the reset and is never taken over', async (t) => {
  const fixture = buildFixture(t, 'held-lock');
  const before = await initialiseRun(initRequest(fixture));
  const stateRoot = path.join(before.output, STATE_DIRECTORY_NAME);
  const holder = createStorage({ root: stateRoot });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const holderCommand = holder.withLock(async () => {
    await held;
    return 'released';
  });
  const lockPath = path.join(stateRoot, '.storage', 'lock');
  const deadline = Date.now() + 5000;
  let lockBytes = '';
  for (;;) {
    if (fs.existsSync(lockPath)) {
      lockBytes = fs.readFileSync(lockPath, 'utf8');
      if (lockBytes.length > 0) break;
    }
    assert.ok(Date.now() < deadline, 'the contending writer acquired the container lock');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const output = path.join(fixture.publishParent, 'reset-should-not-exist');
  const error = await rejection(resetRun(resetRequest(before, fixture, { output })));
  assert.ok(error !== void 0, 'a reset cannot run while another writer holds the container lock');
  /* The accepted seam owns this refusal, and its code is reported unchanged
   * rather than relabelled: a lock conflict is a storage refusal, not a
   * judgement about the run's lifecycle. */
  assert.equal(error.code, 'STORAGE_REFUSED', `the accepted lock refusal is surfaced as-is (${error.message})`);
  assert.equal(fs.existsSync(output), false, 'the refused reset created no destination');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), lockBytes, 'the holder lock bytes were not disturbed');
  release();
  await holderCommand;
});

// Captain contract-derived negatives; fixtures remain synthetic and contained.
for (const scenario of ['empty-output','foreign-output','old-output','nested-output','wrong-id','wrong-challenge','source-workspace','torn-stop','corrupt-journal','linked-journal']) {
 test(`reset refuses ${scenario} before new publication and preserves old bytes`, async t => {
  const f=buildFixture(t,scenario); const old=await initialiseRun(initRequest(f));
  const req=resetRequest(old,f); const open={runRoot:old.output,manifestId:old.manifest.manifestId,runId:old.manifest.runId};
  if(scenario==='empty-output') fs.mkdirSync(req.output);
  if(scenario==='foreign-output'){fs.mkdirSync(req.output);fs.writeFileSync(path.join(req.output,'foreign'),'canary');}
  if(scenario==='old-output') req.output=old.output;
  if(scenario==='nested-output') req.output=path.join(old.output,'new-run');
  if(scenario==='wrong-id') req.runId='run-foreign';
  if(scenario==='wrong-challenge') req.initializationRequest.challenge.identity={...f.identity,challengeId:'foreign-challenge'};
  if(scenario==='source-workspace') req.initializationRequest.challenge.sourceRoot=old.manifest.participantWorkspaceRoot;
  if(['torn-stop','corrupt-journal','linked-journal'].includes(scenario)){
   await startRun({...open,declaration:declaration(),clock:clockAt('2026-04-01T09:05:00.000Z')});
   if(scenario==='torn-stop') await withRunTransaction(open,async c=>{await c.appendEvent({kind:'STOP_RECORDED',declaration:declaration(),occurredAt:null,detail:{...attestation(),observedAt:null,assurance:'operator-attested',enforced:false}});});
   if(scenario==='corrupt-journal') fs.writeFileSync(path.join(old.manifest.evidenceRoot,LIFECYCLE_JOURNAL_DIRECTORY,'00000.json'),'corrupt');
   if(scenario==='linked-journal'){
    const journal=path.join(old.manifest.evidenceRoot,LIFECYCLE_JOURNAL_DIRECTORY);fs.renameSync(journal,journal+'-saved');
    fs.symlinkSync(journal+'-saved',journal,process.platform==='win32'?'junction':'dir');
   }
  }
  const before=snapshotTree(old.output); const existed=fs.existsSync(req.output);const outputBefore=existed?snapshotTree(req.output):null;
  const error=await rejection(resetRun(req)); assert.ok(error,scenario+' must refuse');
  /* A destination that exists is refused as not fresh whatever it holds: the
   * guide states absent-only semantics, so an empty directory is refused with the
   * same code and the same statement that it is foreign to this operation. */
  if(scenario==='empty-output')assert.equal(error.code,RESET_ERROR_CODES.OUTPUT_NOT_FRESH,'an empty directory at the destination is not a fresh destination');
  if(scenario==='empty-output')assert.match(error.message,/even an empty directory is foreign/,'the refusal says that an empty directory is foreign material');
  if(scenario==='empty-output')assert.equal(fs.existsSync(req.output),true,'the empty directory the reset did not create is left exactly where it was');
  assert.deepEqual(snapshotTree(old.output),before,'old bytes and journal preserved');
  if(existed)assert.deepEqual(snapshotTree(req.output),outputBefore,'foreign existing bytes preserved');
  else assert.equal(fs.existsSync(req.output),false,'no new destination');
 });
}
test('reset final proof catches old-workspace mutation and discloses retained new publication',async t=>{
 const f=buildFixture(t,'late-old-mutation');const old=await initialiseRun(initRequest(f));const req=resetRequest(old,f);
 req.initializationRequest.beforeStatePublication=()=>{fs.writeFileSync(path.join(old.output,'workspace','foreign-note'),'foreign mutation');};
 const error=await rejection(resetRun(req));assert.ok(error instanceof ResetError);assert.match(error.message,/old run changed/);
 assert.ok(error.publicationFate);assert.equal(fs.readFileSync(path.join(old.output,'workspace','foreign-note'),'utf8'),'foreign mutation');
 assert.ok(fs.existsSync(req.output),'verified new publication retained, not broad-deleted');
});
test('reset caller hook failure preserves old run and foreign destination material',async t=>{
 const f=buildFixture(t,'hook-failure');const old=await initialiseRun(initRequest(f));const req=resetRequest(old,f);const before=snapshotTree(old.output);
 req.initializationRequest.beforeStatePublication=()=>{fs.writeFileSync(path.join(req.output,'foreign'),'foreign');throw new Error('injected hook failure');};
 const error=await rejection(resetRun(req));assert.ok(error instanceof ResetError);assert.ok(error.publicationFate);
 assert.deepEqual(snapshotTree(old.output),before);assert.equal(fs.readFileSync(path.join(req.output,'foreign'),'utf8'),'foreign');
});
test('deep output junction refuses without entering the foreign target',async t=>{
 const f=buildFixture(t,'deep-junction');const old=await initialiseRun(initRequest(f));const target=path.join(f.root,'foreign-target');fs.mkdirSync(target);fs.mkdirSync(path.join(target,'nested'));
 const link=path.join(f.publishParent,'link');fs.symlinkSync(target,link,process.platform==='win32'?'junction':'dir');
 const req=resetRequest(old,f,{output:path.join(link,'nested','new')});const before=snapshotTree(target);assert.ok(await rejection(resetRun(req)));assert.deepEqual(snapshotTree(target),before);
});
test('reset declarations resolve through the real shipped mjs import',t=>{
 const root=scratch(t,'types');const here=path.join(root,'consumer.mts');let spec=path.relative(root,path.join(REPO_ROOT,'packages/core/reset.mjs')).replaceAll('\\','/');if(!spec.startsWith('.'))spec='./'+spec;
 fs.writeFileSync(here,`import {resetRun, type ResetRequest, type ResetResult} from ${JSON.stringify(spec)}; const command:(r:ResetRequest)=>Promise<ResetResult>=resetRun; void command;`);
 const result=spawnSync(process.execPath,[path.join(STARTER_ROOT,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--module','nodenext','--moduleResolution','nodenext','--target','es2022',here],{encoding:'utf8'});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.deepEqual(fs.readFileSync(path.join(REPO_ROOT,'packages/core/reset.d.ts')),fs.readFileSync(path.join(REPO_ROOT,'packages/core/reset.d.mts')));
});

test('reset prepared mode copies independent ordinary dependencies and preserves source/cache',async t=>{
 const f=buildFixture(t,'prepared'); const old=await initialiseRun(initRequest(f));
 const cache=path.join(f.root,'prepared-cache');fs.mkdirSync(cache);copyFile(path.join(f.sourceRoot,'package.json'),path.join(cache,'package.json'));copyFile(path.join(f.sourceRoot,'package-lock.json'),path.join(cache,'package-lock.json'));fs.mkdirSync(path.join(cache,'node_modules','synthetic'),{recursive:true});fs.writeFileSync(path.join(cache,'node_modules','synthetic','index.js'),'export const fixture = true;');
 const preparedRoot=path.join(cache,'node_modules');
 fs.writeFileSync(path.join(preparedRoot,'.benchboard-dependencies.json'),JSON.stringify({schemaVersion:'1.0.0',module:'benchboard.core.dependencies',hashAlgorithmId:'benchboard-dependency-tree-v1',mode:'prepared',provenance:{lockfileName:'package-lock.json',manifestFileName:'package.json',lockDigest:sha256(fs.readFileSync(path.join(f.sourceRoot,'package-lock.json'))),manifestDigest:sha256(fs.readFileSync(path.join(f.sourceRoot,'package.json')))}}));
 const req=resetRequest(old,f);req.initializationRequest.dependencies={mode:'prepared',preparedRoot,sourceRoot:f.sourceRoot};
 const before=snapshotTree(old.output),cacheBefore=snapshotTree(cache),sourceBefore=snapshotTree(f.sourceRoot);
 const result=await resetRun(req);assert.equal(result.initResult.dependency.mode,'prepared');assert.ok(result.initResult.dependency.digest);
 assert.equal(fs.readFileSync(path.join(result.output,'workspace','node_modules','synthetic','index.js'),'utf8'),'export const fixture = true;');
 assert.deepEqual(snapshotTree(old.output),before);assert.deepEqual(snapshotTree(cache),cacheBefore);assert.deepEqual(snapshotTree(f.sourceRoot),sourceBefore);
});
test('a concurrent start and reset cannot both enter the old whole-command transaction',async t=>{
 const f=buildFixture(t,'concurrent-start-reset'); const old=await initialiseRun(initRequest(f));const req=resetRequest(old,f);
 const results=await Promise.allSettled([startRun({runRoot:old.output,runId:old.manifest.runId,manifestId:old.manifest.manifestId,declaration:declaration()}),resetRun(req)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'one exclusive command succeeds');
 assert.equal(results.filter(r=>r.status==='rejected').length,1,'other command refuses rather than stealing lock');
});
