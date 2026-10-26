/**
 * Independent actual-subprocess acceptance for the connected fresh-container reset
 * command (task packet C6.S9.T2).
 *
 * Every case here drives the real executable `cli/benchboard.mjs` through a
 * shell-free, bounded `spawnSync` against fresh external temporary roots whose
 * generated paths contain a space, using the real installed identities
 * (`loadInstallation()`, the real 26-file challenge). No identity fixture is
 * synthesized. The production code runs unmodified: no test-only hook, clock,
 * collaborator or runtime injection. This file writes no production code.
 *
 * Scope facts fixed by the packet:
 *   - success is exit 0, empty stderr and exactly one JSON summary line;
 *     controlled refusals are one `CLI_*` stderr line with no stack dump, no
 *     echo of private paths or canary values, and empty stdout;
 *   - a reset publishes only at a fresh destination and leaves the old run
 *     container and the bound external results byte-identical;
 *   - the architecture id stays the bound old domain per the accepted reset —
 *     no new architecture is asserted anywhere here;
 *   - install mode is never invoked by any case in this file, not even to test
 *     missing prerequisites; no npm, browsers, servers or participant agents run;
 *   - the attempt/reserve evidence in check 2 is synthetic preservation
 *     evidence: plainly labeled ordinary synthetic canary files. It proves byte
 *     preservation of the old run and results, not an actual C4 evaluation or a
 *     C5 publication (C6.S11 covers reset after real evaluation/review);
 *   - the prepared-mode cache in check 4 is synthetic copy-protocol evidence,
 *     not a real toolchain install or evaluation;
 *   - the pre-aborted `resetCommand` case drives the actual production export
 *     with its allowed `AbortController.signal`. It proves the adapter's own
 *     pre-work refusal only, not SIGINT behaviour, and it is kept separate from
 *     the actual subprocess acceptance above it;
 *   - real orphan locks are not deleted by anything here, and path/link
 *     security has its own Captain-owned coverage.
 *
 * Every path is passed as exactly one argv element (the fixture roots contain
 * spaces), so a split path cannot masquerade as several arguments.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryTree, sha256, createId } from '../../packages/core/identity.mjs';
import { initialiseRun } from '../../packages/core/init.mjs';
import { withRunTransaction } from '../../adapters/manual/index.mjs';
import {
  DEPENDENCY_HASH_ALGORITHM_ID,
  DEPENDENCIES_METADATA_FILE_NAME,
} from '../../packages/core/dependencies.mjs';
import { loadInstallation } from '../../cli/installation.mjs';
import { openSelectedRun, ensureResultsContext } from '../../cli/run-context.mjs';
import { reserveEvaluationAttempt, readEvaluationAttempts } from '../../cli/attempt-records.mjs';
import { resetCommand } from '../../cli/reset-command.mjs';
import { CommandError } from '../../cli/command-error.mjs';
const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const entrypoint = path.join(repositoryRoot, 'cli', 'benchboard.mjs');
const starterRoot = path.join(repositoryRoot, 'starter');
/* Bounds so a hung or chatty child cannot outlive the test run. */
const SPAWN_TIMEOUT_MS = 20_000;
const MAX_BUFFER_BYTES = 1_048_576;
const HEX64 = /^[0-9a-f]{64}$/;
const COMPARE = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** The exact reset summary key set (accepted init facts plus the reset facts). */
const RESET_SUMMARY_KEYS = Object.freeze(['status', 'output', 'workspaceRoot', 'stateRoot',
  'workloadDigest', 'workloadFileCount', 'dependencyMode', 'dependencyDigest', 'manifestId',
  'runId', 'durationMs', 'command', 'source', 'fresh', 'oldContainerMutation', 'sourceCleanup']);
/* --------------------------------------------------------------------------- */
/* Subprocess helpers (pattern shared with initialize-command.test.mjs)         */
/* --------------------------------------------------------------------------- */
/**
 * Run the entrypoint as one argv array (never through a shell), from the
 * external fixture root as the working directory.
 */
function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    encoding: 'utf8',
    shell: false,
    cwd,
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, `the child process completed without a spawn error: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
const trimmed = (text) => text.replace(/\r\n/g, '\n').trimEnd();
/** A successful run: exit 0, empty stderr, exactly one parseable JSON line. */
function runExpectingSuccess(args, cwd, label) {
  const result = runCli(args, cwd);
  assert.equal(result.status, 0, `${label}: a completed run exits with status 0; stderr ${JSON.stringify(result.stderr)}`);
  assert.equal(trimmed(result.stderr), '', `${label}: a completed run writes nothing to stderr`);
  const out = trimmed(result.stdout);
  assert.equal(out.split('\n').length, 1, `${label}: the success report is one JSON line`);
  return JSON.parse(out);
}
/**
 * A controlled refusal: the fixed exit status, empty stdout, one `CLI_*` line on
 * stderr with no stack frames. Nothing in `forbidden` (private fixture roots and
 * canary values) may appear on either stream.
 */
function runExpectingRefusal(args, cwd, expectedCode, expectedStatus, label, forbidden = []) {
  const result = runCli(args, cwd);
  assert.equal(result.status, expectedStatus, `${label}: exit status is ${expectedStatus}; stderr ${JSON.stringify(result.stderr)}`);
  assert.equal(result.stdout, '', `${label}: a refusal writes nothing to stdout`);
  const err = trimmed(result.stderr);
  assert.equal(err.split('\n').length, 1, `${label}: the refusal is one controlled line: ${JSON.stringify(err)}`);
  assert.ok(err.startsWith(`${expectedCode}: `), `${label}: stderr opens with ${expectedCode}: ${JSON.stringify(err)}`);
  assert.ok(!err.includes('\n    at ') && !err.includes('\n\tat '),
    `${label}: the refusal reports guidance, not a stack dump`);
  for (const secret of forbidden) {
    assert.ok(!err.includes(secret) && !result.stdout.includes(secret),
      `${label}: the controlled diagnostic does not echo ${JSON.stringify(secret)}`);
  }
  return result;
}
/* --------------------------------------------------------------------------- */
/* Fixture roots and inventories                                                */
/* --------------------------------------------------------------------------- */
/**
 * One fresh external temporary root whose generated path contains a space,
 * removed by this test's own `t.after` cleanup.
 */
function tempRoot(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bb-reset probe ${label} `));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 }));
  return root;
}
/** A short path that contains a space, usable as one argv element. */
const pathWithSpace = (base, name) => path.join(base, name);
/** The complete raw file inventory (paths, sizes, digests) of one tree. */
const rawInventory = (root) => inventoryTree({ root, skipNames: [] });
/** Snapshot then later compare the whole raw inventory of one tree. */
function trackTree(root) {
  const before = rawInventory(root);
  return (label) => {
    const after = rawInventory(root);
    assert.deepEqual(after.entries, before.entries, `${label}: the complete raw inventory of ${JSON.stringify(root)} is byte-identical`);
    assert.equal(after.digest, before.digest, `${label}: the tree digest of ${JSON.stringify(root)} is unchanged`);
  };
}
/**
 * Initialise one run through the real executable with the real installed
 * identities, at a fresh spaced output under the fixture root.
 */
function cliInit(root, name, label) {
  const output = pathWithSpace(root, name);
  const summary = runExpectingSuccess(['init', '--output', output], root, label);
  assert.equal(summary.command, 'init');
  return { output, summary };
}
/**
 * Initialise one run in-process through the accepted `initialiseRun` with the
 * real installed identities and the exact canonical challenge files (the same
 * pattern as `manual-commands.test.mjs`). Used where the command under test is
 * the reset itself, so the fixture does not need a second subprocess.
 */
async function inProcessRun(root, name) {
  const installation = loadInstallation();
  const sourceRoot = pathWithSpace(root, `${name} source`);
  fs.mkdirSync(sourceRoot);
  for (const relative of installation.challenge.fileManifest) {
    const target = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(installation.challenge.sourceRoot, relative), target);
  }
  const run = await initialiseRun({
    output: pathWithSpace(root, `${name} run`),
    challenge: { ...installation.challenge, sourceRoot },
    toolingIdentity: installation.toolingIdentity,
    evaluatorIdentity: installation.evaluatorIdentity,
    architectureId: createId('reset-probe'), harness: 'manual', dependencies: { mode: 'none' },
  });
  return { runRoot: run.output, opened: await openSelectedRun(run.output) };
}
/** Common assertions on one successful reset summary against its old run. */
function assertResetSummary(summary, old, expectedOldState) {
  assert.deepEqual(Object.keys(summary).sort(), [...RESET_SUMMARY_KEYS].sort(),
    'the one line is the accepted reset summary schema, not a raw result');
  assert.equal(summary.command, 'reset');
  assert.equal(summary.status, 'initialised');
  assert.equal(summary.fresh, true, 'the summary reports the destination as fresh');
  assert.equal(summary.oldContainerMutation, 'none', 'the summary reports no old-container mutation');
  /* The accepted init facts of the NEW container. */
  assert.equal(summary.dependencyMode, 'none');
  assert.ok(path.isAbsolute(summary.output) && path.isAbsolute(summary.workspaceRoot) && path.isAbsolute(summary.stateRoot),
    'the accepted init facts report absolute roots');
  assert.notEqual(summary.manifestId, old.opened.manifestId, 'the new manifestId is distinct from the old');
  assert.notEqual(summary.runId, old.opened.runId, 'the new runId is distinct from the old');
  assert.equal(summary.workloadFileCount, 26, 'the new workspace carries the canonical 26 workload files');
  assert.equal(summary.workloadDigest, loadInstallation().challenge.identity.workloadDigest,
    'the new workload digest is the exact original challenge digest');
  /* The old source facts are named, not hidden. */
  assert.equal(summary.source.runId, old.opened.runId, 'the summary names the old runId');
  assert.equal(summary.source.manifestId, old.opened.manifestId, 'the summary names the old manifestId');
  assert.ok(summary.source.manifestDigest === null || HEX64.test(summary.source.manifestDigest));
  assert.equal(summary.source.state, expectedOldState, 'the summary reports the old state it reset from');
  /* The staged source cleanup reports removal and the root is gone. */
  assert.equal(summary.sourceCleanup.status, 'removed');
  assert.equal(fs.existsSync(summary.sourceCleanup.root), false, 'the staged source root no longer exists');
}
/** Shared controlled fixture values (synthetic, never personal). */
const FULL_DECLARATION = Object.freeze({
  harness: 'manual', model: null, workerCount: null, executionMode: 'MANUAL', declaredCeilingMinutes: null,
});
const MODEL_CANARY = 'synthetic-model-probe';
const OPERATOR_CANARY = 'synthetic-operator-probe';
/** The workspace file this file edits in check 1 (one canonical path). */
const editedRelative = 'index.html';
/* ========================================================================== */
/* Check 1 — real init → reset, the stopped and clockless-frozen variants      */
/* ========================================================================== */
describe('reset command — check 1: real connected init/lifecycle then reset leaves old bytes intact', () => {
  /** Common assertions that the NEW container starts clean: INITIALIZED, no inheritance. */
  const assertFreshNewContainer = async (root, output, label) => {
    const summary = runExpectingSuccess(['status', '--run', output], root, `${label}: status of the new container`);
    assert.equal(summary.state, 'INITIALIZED', 'the new container reports INITIALIZED');
    assert.equal(summary.diagnosis, 'consistent');
    assert.equal(summary.declaration, null, 'no old declaration is inherited');
    assert.equal(summary.startedAt, null);
    assert.equal(summary.stoppedAt, null);
    assert.equal(summary.elapsedMs, null);
    assert.deepEqual(summary.attempts, [], 'no old attempt reference is inherited');
    /* No old companion structures are carried over. */
    assert.equal(fs.existsSync(path.join(output, '.benchboard', 'cli', 'results.json')), false,
      'the new container carries no results binding');
    assert.equal(fs.existsSync(path.join(output, 'snapshots')), false,
      'the new container carries no snapshots of the old run');
    assert.equal(fs.existsSync(`${output}.benchboard-results`), false,
      'a reset creates no default results root');
  };
  test('INITIALIZED variant: edited old workspace bytes do not become the new workload', async t => {
    const root = tempRoot(t, 'init');
    const { output: oldRun } = cliInit(root, 'old initialized run', 'init old');
    const old = { opened: await openSelectedRun(oldRun) };
    /* Edit one canonical live workspace byte in the OLD container before the reset. */
    const editedFile = path.join(oldRun, 'workspace', editedRelative);
    assert.ok(fs.existsSync(editedFile), `the canonical file ${editedRelative} exists in the old workspace`);
    fs.appendFileSync(editedFile, ' synthetic-live-edit');
    const trackOld = trackTree(oldRun);
    const output = pathWithSpace(root, 'fresh destination');
    const summary = runExpectingSuccess(['reset', '--run', oldRun, '--output', output], root, 'reset from INITIALIZED');
    assertResetSummary(summary, old, 'INITIALIZED');
    /* The whole old container — state, journal, workspace, everything — is byte-identical. */
    trackOld('reset from INITIALIZED');
    /* The new workspace carries the exact canonical 26 paths and raw digest, and the
     * edited file in the NEW container is the original canonical bytes. */
    const workspace = rawInventory(summary.workspaceRoot);
    const installation = loadInstallation();
    assert.deepEqual(workspace.entries.map((entry) => entry.path).sort(COMPARE),
      [...installation.challenge.fileManifest].sort(COMPARE),
      'the new workspace carries exactly the 26 canonical paths');
    assert.equal(workspace.digest, installation.challenge.identity.workloadDigest,
      'the new workspace raw digest is the exact original challenge digest');
    const editedInNew = workspace.entries.find((entry) => entry.path === editedRelative);
    const editedInOld = rawInventory(path.join(oldRun, 'workspace')).entries.find((entry) => entry.path === editedRelative);
    assert.notEqual(editedInNew.sha256, editedInOld.sha256,
      'the old live edit is present in the old workspace and not in the new workload');
    /* The architecture id stays the bound old domain (no new architecture is asserted). */
    const newOpened = await openSelectedRun(output);
    assert.equal(newOpened.manifest.architectureId, old.opened.manifest.architectureId,
      'the accepted reset keeps the architecture id bound by the old manifest');
    await assertFreshNewContainer(root, output, 'INITIALIZED variant');
  });
  test('stopped variant: the full init/start/stop/reset connected cycle preserves old bytes', async t => {
    const root = tempRoot(t, 'stopped');
    const { output: oldRun } = cliInit(root, 'old stopped run', 'init old stopped');
    const old = { opened: await openSelectedRun(oldRun) };
    /* The real connected lifecycle commands, not in-process shortcuts. */
    const started = runExpectingSuccess(['start', '--run', oldRun, '--model', MODEL_CANARY], root, 'start old');
    assert.equal(started.state, 'RUNNING');
    const stopped = runExpectingSuccess(['stop', '--run', oldRun, '--operator', OPERATOR_CANARY,
      '--agents-stopped'], root, 'stop old');
    assert.equal(stopped.state, 'STOP_RECORDED');
    const trackOld = trackTree(oldRun);
    const output = pathWithSpace(root, 'stopped fresh destination');
    const summary = runExpectingSuccess(['reset', '--run', oldRun, '--output', output], root, 'reset from STOP_RECORDED');
    assertResetSummary(summary, old, 'STOP_RECORDED');
    trackOld('reset from STOP_RECORDED');
    /* The committed lifecycle journal bytes are among the preserved old bytes; the
     * new container reports none of it. */
    await assertFreshNewContainer(root, output, 'stopped variant');
  });
  test('clockless-frozen variant: snapshot, journal and state bytes all stand still', async t => {
    const root = tempRoot(t, 'frozen');
    const { output: oldRun } = cliInit(root, 'old frozen run', 'init old frozen');
    const old = { opened: await openSelectedRun(oldRun) };
    const frozen = runExpectingSuccess(['freeze', '--run', oldRun, '--clockless',
      '--operator', OPERATOR_CANARY, '--agents-stopped'], root, 'clockless freeze old');
    assert.equal(frozen.state, 'FROZEN');
    assert.ok(fs.existsSync(path.join(oldRun, 'snapshots', frozen.snapshotId)),
      'the clockless freeze published its snapshot container in the old run');
    const trackOld = trackTree(oldRun);
    const output = pathWithSpace(root, 'frozen fresh destination');
    const summary = runExpectingSuccess(['reset', '--run', oldRun, '--output', output], root, 'reset from FROZEN');
    assertResetSummary(summary, old, 'FROZEN');
    trackOld('reset from FROZEN');
    /* The snapshot container itself is byte-identical after the reset. */
    const snapshotNow = rawInventory(path.join(oldRun, 'snapshots'));
    assert.ok(snapshotNow.entries.length > 0);
    await assertFreshNewContainer(root, output, 'frozen variant');
  });
});
/* ========================================================================== */
/* Check 2 — bound results, a reserved incomplete attempt and synthetic canaries */
/* ========================================================================== */
describe('reset command — check 2: bound results, reserved attempt and canary bytes survive a frozen reset untouched', () => {
  test('the entire old run and results inventories are byte-identical; nothing relocates, adopts or deletes', async t => {
    const root = tempRoot(t, 'results');
    /* A real frozen run through the connected commands, so the snapshot the attempt
     * is reserved against is a real verified frozen submission. */
    const { output: oldRun } = cliInit(root, 'results old run', 'init results');
    runExpectingSuccess(['start', '--run', oldRun, '--model', MODEL_CANARY], root, 'start results');
    runExpectingSuccess(['stop', '--run', oldRun, '--operator', OPERATOR_CANARY, '--agents-stopped'],
      root, 'stop results');
    const frozen = runExpectingSuccess(['freeze', '--run', oldRun], root, 'freeze results');
    assert.equal(frozen.state, 'FROZEN');
    /* Bind the real external results through the accepted context seam, then reserve
     * one real INCOMPLETE attempt against the verified snapshot. The reservation is
     * metadata-only; no terminal is ever written, so the attempt stays incomplete. */
    const opened = await openSelectedRun(oldRun);
    const context = await ensureResultsContext(opened);
    const selection = { snapshotId: frozen.snapshotId, frozenSubmissionId: frozen.frozenSubmissionId };
    const start = await reserveEvaluationAttempt(opened, context, selection);
    /* Plainly labeled ordinary synthetic canary files under the attempt output root
     * and the store. These are preservation targets only: no claim of a committed
     * evaluation or report is made anywhere here, and no C4/C5 publication occurred. */
    fs.mkdirSync(start.outputRoot, { recursive: true });
    fs.writeFileSync(path.join(start.outputRoot, 'synthetic-canary.txt'),
      'SYNTHETIC CANARY - ordinary file, not a committed evaluation or report.\n');
    fs.writeFileSync(path.join(context.storeRoot, 'synthetic-canary-note.txt'),
      'SYNTHETIC CANARY - ordinary file under the store, not publication content.\n');
    const trackOldRun = trackTree(oldRun);
    const trackResults = trackTree(context.resultsRoot);
    const output = pathWithSpace(root, 'results fresh destination');
    const summary = runExpectingSuccess(['reset', '--run', oldRun, '--output', output], root, 'reset with bound results');
    assertResetSummary(summary, { opened }, 'FROZEN');
    /* The ENTIRE old run and the ENTIRE results tree are byte-identical. */
    trackOldRun('reset with bound results');
    trackResults('reset with bound results');
    assert.equal(fs.existsSync(path.join(start.outputRoot, 'synthetic-canary.txt')), true,
      'the canary under the attempt output root is still in its original place');
    assert.equal(fs.existsSync(path.join(context.storeRoot, 'synthetic-canary-note.txt')), true,
      'the canary under the store is still in its original place');
    /* No metadata reference relocation, adoption or deletion: the old run still owns
     * its binding, the incomplete attempt still reads as its own, and the new
     * container adopted nothing. */
    const attempts = await readEvaluationAttempts(opened, await ensureResultsContext(opened));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].start.attemptId, start.attemptId, 'the reserved attempt is still enumerated for the old run');
    assert.equal(attempts[0].start.snapshotId, selection.snapshotId, 'the attempt still names the old snapshot');
    assert.equal(attempts[0].terminal, null, 'the attempt is still incomplete — a reset completes nothing');
    const statusOld = runExpectingSuccess(['status', '--run', oldRun], root, 'status old after reset');
    assert.equal(statusOld.attempts.length, 1, 'the old run status still reports its one attempt');
    const statusNew = runExpectingSuccess(['status', '--run', output], root, 'status new after reset');
    assert.deepEqual(statusNew.attempts, [], 'the new container adopted no attempt reference');
    assert.equal(fs.existsSync(path.join(output, '.benchboard', 'cli', 'results.json')), false,
      'the new container carries no results binding');
    assert.equal(summary.source.runId, opened.runId, 'the reset still reports the old run as its source');
  });
});
/* ========================================================================== */
/* Check 3 — controlled refusals with unchanged old inventories                 */
/* ========================================================================== */
describe('reset command — check 3: RUNNING, interrupted, occupied, missing-parent, overlapping and dependency refusals move no byte', () => {
  /** Snapshot the run, expect the refusal, prove the run (and any extra tree) unchanged. */
  const refusedWithStillRun = (root, runRoot, argv, code, exit, label, forbidden, extraTrees = []) => {
    const trackRun = trackTree(runRoot);
    const trackExtra = extraTrees.map(trackTree);
    runExpectingRefusal(argv, root, code, exit, label, [path.basename(root), ...forbidden]);
    trackRun(label);
    for (const track of trackExtra) track(label);
  };
  test('a RUNNING run is an active run: state refusal, no output, no silent results creation', async t => {
    const root = tempRoot(t, 'running');
    const { runRoot } = await inProcessRun(root, 'running');
    const started = runExpectingSuccess(['start', '--run', runRoot, '--model', MODEL_CANARY], root, 'start for reset refusal');
    assert.equal(started.state, 'RUNNING');
    const output = pathWithSpace(root, 'running fresh destination');
    refusedWithStillRun(root, runRoot, ['reset', '--run', runRoot, '--output', output],
      'CLI_STATE', 3, 'reset of a RUNNING run', [MODEL_CANARY]);
    assert.equal(fs.existsSync(output), false, 'no output container was created');
    assert.equal(fs.existsSync(`${runRoot}.benchboard-results`), false,
      'the bound results read created no default results root where none was bound');
    assert.equal(fs.existsSync(path.join(runRoot, '.benchboard', 'cli', 'results.json')), false,
      'no results binding was silently created');
  });
  test('an interrupted start (public C3 journal setup) is a state refusal and repairs nothing', async t => {
    const root = tempRoot(t, 'interrupted');
    const { runRoot, opened } = await inProcessRun(root, 'interrupted');
    /* The controlled interruption through the public transaction seam, exactly the
     * way `manual-commands.test.mjs` states it: append the intent, commit no state. */
    await withRunTransaction(opened.request,
      (context) => context.appendEvent({ kind: 'START_INTENT', declaration: FULL_DECLARATION }));
    const trackJournal = trackTree(path.join(runRoot, '.benchboard'));
    const output = pathWithSpace(root, 'interrupted fresh destination');
    refusedWithStillRun(root, runRoot, ['reset', '--run', runRoot, '--output', output],
      'CLI_STATE', 3, 'reset over the interrupted start', []);
    trackJournal('interrupted journal view');
    assert.equal(fs.existsSync(output), false);
  });
  test('an occupied destination with a foreign canary is a state refusal and the canary stands', async t => {
    const root = tempRoot(t, 'occupied');
    const { runRoot } = await inProcessRun(root, 'occupied');
    const output = pathWithSpace(root, 'occupied destination');
    fs.mkdirSync(output);
    const canary = path.join(output, 'foreign-canary.txt');
    fs.writeFileSync(canary, 'FOREIGN-CANARY-VALUE\n');
    const trackOccupied = trackTree(output);
    refusedWithStillRun(root, runRoot, ['reset', '--run', runRoot, '--output', output],
      'CLI_STATE', 3, 'reset onto an occupied destination', ['FOREIGN-CANARY-VALUE']);
    trackOccupied('occupied destination');
    assert.equal(fs.readFileSync(canary, 'utf8'), 'FOREIGN-CANARY-VALUE\n',
      'the foreign canary byte is not read through, moved or removed');
  });
  test('a missing parent of the destination is a state refusal', async t => {
    const root = tempRoot(t, 'missing');
    const { runRoot } = await inProcessRun(root, 'missing');
    const output = path.join(root, 'no such parent dir', 'fresh container');
    refusedWithStillRun(root, runRoot, ['reset', '--run', runRoot, '--output', output],
      'CLI_STATE', 3, 'reset with a missing parent', []);
    assert.equal(fs.existsSync(path.join(root, 'no such parent dir')), false,
      'the missing parent was not created on the way to the refusal');
  });
  test('a destination inside the bound old results root is an overlapping integrity refusal', async t => {
    const root = tempRoot(t, 'overlap');
    const { runRoot, opened } = await inProcessRun(root, 'overlap');
    const context = await ensureResultsContext(opened);
    const trackResults = trackTree(context.resultsRoot);
    const output = path.join(context.resultsRoot, 'nested fresh container');
    refusedWithStillRun(root, runRoot, ['reset', '--run', runRoot, '--output', output],
      'CLI_INTEGRITY', 4, 'reset nested in the bound old results root', [], [context.resultsRoot]);
    trackResults('bound results root');
    assert.equal(fs.existsSync(output), false, 'the nested container was not created');
  });
  test('prepared-mode missing prerequisites are state refusals and an unknown mode is a usage refusal', async t => {
    const root = tempRoot(t, 'deps');
    const { runRoot } = await inProcessRun(root, 'deps');
    const trackRun = trackTree(runRoot);
    /* Missing prepared prerequisites: mode prepared with no cache at all, then with a
     * cache but no locked source. Both are state refusals (the accepted prepared-input
     * diagnostic), and neither creates the destination. Install mode is never invoked. */
    const outA = pathWithSpace(root, 'prepared no roots');
    runExpectingRefusal(['reset', '--run', runRoot, '--output', outA, '--dependency-mode', 'prepared'],
      root, 'CLI_STATE', 3, 'prepared with neither root', [path.basename(root)]);
    assert.equal(fs.existsSync(outA), false);
    const cacheDecoy = pathWithSpace(root, 'prepared decoy cache');
    fs.mkdirSync(cacheDecoy);
    const outB = pathWithSpace(root, 'prepared no source');
    runExpectingRefusal(['reset', '--run', runRoot, '--output', outB, '--dependency-mode', 'prepared',
      '--prepared-root', cacheDecoy], root, 'CLI_STATE', 3, 'prepared without the locked source',
      [path.basename(root)]);
    assert.equal(fs.existsSync(outB), false);
    /* An unknown dependency mode is a usage refusal: the value never reaches the core. */
    const outC = pathWithSpace(root, 'unknown mode container');
    runExpectingRefusal(['reset', '--run', runRoot, '--output', outC, '--dependency-mode', 'install-mode-is-never-run'],
      root, 'CLI_USAGE', 2, 'unknown dependency mode', [path.basename(root)]);
    assert.equal(fs.existsSync(outC), false);
    trackRun('dependency refusals');
    assert.equal(fs.existsSync(path.join(runRoot, '.benchboard', 'cli', 'results.json')), false,
      'no results binding was created by any refused reset');
  });
});
/* ========================================================================== */
/* Check 4 — explicit prepared reset against a synthetic cache; pre-abort       */
/* ========================================================================== */
describe('reset command — check 4: explicit prepared reset copies a declared cache; the pre-aborted export refuses', () => {
  /* SYNTHETIC COPY PROTOCOL: this is synthetic cache evidence for the copy path,
   * not a real toolchain install and not an evaluation. The provenance digests are
   * computed from the ACTUAL canonical starter package/lock bytes. */
  test('a declared synthetic cache lands in the reset workspace with canonical 26 and its own digest', async t => {
    const root = tempRoot(t, 'prepared');
    /* The locked source: the real canonical starter lock bytes in a separate
     * external directory with a spaced path. */
    const lockedSource = pathWithSpace(root, 'locked source');
    fs.mkdirSync(lockedSource);
    for (const file of ['package.json', 'package-lock.json'])
      fs.copyFileSync(path.join(starterRoot, file), path.join(lockedSource, file));
    /* The tiny synthetic cache, built the way the accepted C2 example builds one:
     * an ordinary package directory plus the provenance marker whose lock and
     * manifest digests are the sha256 of the actual copied bytes. */
    const cacheRoot = pathWithSpace(root, 'dep cache');
    const preparedRoot = path.join(cacheRoot, 'node_modules');
    const packageRoot = path.join(preparedRoot, 'synthetic-dep');
    fs.mkdirSync(packageRoot, { recursive: true });
    const packageBytes = Buffer.from('{"name":"synthetic-dep"}\n', 'utf8');
    fs.writeFileSync(path.join(packageRoot, 'package.json'), packageBytes);
    const marker = {
      schemaVersion: '1.0.0',
      module: 'benchboard.core.dependencies',
      hashAlgorithmId: DEPENDENCY_HASH_ALGORITHM_ID,
      mode: 'prepared',
      provenance: {
        lockfileName: 'package-lock.json',
        manifestFileName: 'package.json',
        lockDigest: sha256(fs.readFileSync(path.join(lockedSource, 'package-lock.json'))),
        manifestDigest: sha256(fs.readFileSync(path.join(lockedSource, 'package.json'))),
      },
    };
    fs.writeFileSync(path.join(preparedRoot, DEPENDENCIES_METADATA_FILE_NAME), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    const { runRoot } = await inProcessRun(root, 'prepared old');
    const cacheBefore = rawInventory(cacheRoot);
    const lockedBefore = rawInventory(lockedSource);
    const trackOldRun = trackTree(runRoot);
    const output = pathWithSpace(root, 'prepared fresh destination');
    const summary = runExpectingSuccess(['reset', '--run', runRoot, '--output', output,
      '--dependency-mode', 'prepared', '--source-root', lockedSource, '--prepared-root', preparedRoot],
    root, 'prepared reset');
    assert.equal(summary.command, 'reset');
    assert.equal(summary.fresh, true);
    assert.equal(summary.oldContainerMutation, 'none');
    assert.equal(summary.dependencyMode, 'prepared', 'the summary reports the declared prepared mode');
    assert.match(summary.dependencyDigest, HEX64, 'the dependency digest is a 64-hex value');
    assert.notEqual(summary.dependencyDigest, summary.workloadDigest,
      'the dependency digest is a separate digest domain from the workload digest');
    assert.equal(summary.workloadFileCount, 26,
      'the canonical 26 workload files are retained ahead of the optional dependencies');
    assert.equal(summary.sourceCleanup.status, 'removed');
    assert.ok(!fs.existsSync(summary.sourceCleanup.root), 'the staged source root no longer exists');
    /* The workspace carries the canonical 26 plus the exact synthetic bytes; the
     * provenance marker stays out of the participant tree. */
    const installation = loadInstallation();
    const workspace = rawInventory(summary.workspaceRoot);
    const dependencyEntry = workspace.entries.find((entry) => entry.path === 'node_modules/synthetic-dep/package.json');
    assert.ok(dependencyEntry !== void 0, 'the synthetic dependency package was copied into the reset workspace');
    assert.equal(dependencyEntry.sha256, sha256(packageBytes), 'the copied package bytes are byte-identical to the cache');
    assert.ok(!workspace.entries.some((entry) => entry.path.split('/').includes(DEPENDENCIES_METADATA_FILE_NAME)),
      `the ${DEPENDENCIES_METADATA_FILE_NAME} provenance marker was excluded from the participant tree`);
    const workloadPaths = workspace.entries.map((entry) => entry.path)
      .filter((one) => !one.startsWith('node_modules/')).sort(COMPARE);
    assert.deepEqual(workloadPaths, [...installation.challenge.fileManifest].sort(COMPARE),
      'the reset workspace still carries exactly the 26 canonical workload files');
    assert.equal(inventoryTree({ root: summary.workspaceRoot }).digest, installation.challenge.identity.workloadDigest,
      'the default dependency exclusion leaves the exact canonical raw workload digest');
    /* The cache, the locked source and the old run are unchanged: byte-for-byte. */
    assert.deepEqual(rawInventory(cacheRoot).entries, cacheBefore.entries, 'the synthetic cache bytes are unchanged');
    assert.deepEqual(rawInventory(lockedSource).entries, lockedBefore.entries, 'the locked source bytes are unchanged');
    trackOldRun('prepared reset');
  });
  test('the actual pre-aborted production resetCommand refuses cancelled and creates no output', async t => {
    /* This drives the actual production export with its allowed signal. It proves
     * the adapter's own documented pre-work refusal only: not SIGINT behaviour
     * during a reset and not interruption of committed work, which is separate from
     * the actual subprocess acceptance above. */
    const abortedRoot = tempRoot(t, 'aborted');
    const output = pathWithSpace(abortedRoot, 'aborted fresh destination');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      resetCommand({ '--run': pathWithSpace(abortedRoot, 'no run exists'), '--output': output },
        { signal: controller.signal }),
      (error) => error instanceof CommandError && error.category === 'cancelled',
      'the pre-aborted resetCommand rejects with the cancelled category',
    );
    assert.equal(fs.existsSync(output), false, 'the pre-aborted refusal created no output');
  });
});
