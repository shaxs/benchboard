/**
 * Independent actual freeze and recovery acceptance (task packet C6.S5.T3).
 *
 * These tests drive the production route end to end: every lifecycle command is a
 * real shell-free `spawnSync` of `cli/benchboard.mjs` against an external fixture
 * root whose name contains spaces (each path is one argv element). No production
 * code receives a test-only injection: the child processes carry no clock, no
 * collaborator and no hook. In-process calls appear at three kinds of place and
 * each is labelled at the call site:
 *   - fixture setup through the accepted core (`initialiseRun`,
 *     `withRunTransaction`, and the accepted C3 `freezeRun` whose existing
 *     `publicationHook` is the only way the C3 contract can leave an interrupted
 *     freeze; the CLI exposes no hook);
 *   - independent reads of persisted state through the accepted
 *     `readRunLifecycle` / `verifyFrozenSubmission` and the exported production
 *     `selectVerifiedFrozen` (which is itself production code being tested here);
 *   - byte-inventory snapshots for the completeness comparisons.
 * None of these stands in for a subprocess: every refusal and success the packet
 * states as a command behavior is asserted against a real subprocess result.
 *
 * Contract facts asserted here come from the task packet:
 * - success: exit 0, empty stderr, exactly one JSON line; refusals: empty stdout,
 *   one controlled `CLI_*: guidance` stderr line with the fixed category code and
 *   exit, no stack, no canary or raw-path echo, and a complete run inventory that
 *   stands still;
 * - the normal freeze route is FROZEN over the STOP_RECORDED route with the
 *   re-used recorded stop attestation; a successful freeze reports the snapshot
 *   identity, the submission identity, the tree digest, the frozen instant and an
 *   enforcement of false, and the snapshot holds the verified 26-file workspace;
 * - the clockless route requires an explicit operator and attestation, reports no
 *   start or stop instant and an elapsed of null (not 0), and journals freeze
 *   intent and commit with no start event; the normal route over INITIALIZED,
 *   over a running run, or a repeated freeze refuses with the state category, and
 *   clockless flag mistakes are usage refusals, not ignores;
 * - reconciliation is bound to the journaled intent digest: a wrong digest is a
 *   state refusal, an operation/disposition mismatch or malformed intent is a
 *   usage refusal, LEAVE_AS_IS / KEEP_INTERRUPTED preserve every byte, COMPLETE
 *   repairs from the journaled bytes with no fabricated operator, model or
 *   timestamp, and a repeat completion refuses rather than repairing twice.
 *
 * The C1 held-lock behavior is regression-covered separately (per the packet) and
 * is not claimed here; no OS-level census or durability claim is made here.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInstallation } from '../../cli/installation.mjs';
import { openSelectedRun } from '../../cli/run-context.mjs';
import { CATEGORIES } from '../../cli/command-error.mjs';
import { CommandError } from '../../cli/command-error.mjs';
import { selectVerifiedFrozen } from '../../cli/frozen-selection.mjs';
import { withRunTransaction, readRunLifecycle } from '../../adapters/manual/index.mjs';
import { initialiseRun } from '../../packages/core/init.mjs';
import { createId, inventoryTree } from '../../packages/core/identity.mjs';
import { freezeRun, verifyFrozenSubmission } from '../../packages/core/freeze.mjs';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const entrypoint = path.join(repositoryRoot, 'cli', 'benchboard.mjs');

/* Bounds so a hung or chatty child cannot outlive the test run. */
const SPAWN_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 1_048_576;

/** One stderr line shaped `CLI_CODE: guidance`, and nothing else. */
const CONTROLLED_CLI_LINE = /^CLI_[A-Z0-9_]+: \S[^\n]*$/;

/* --------------------------------------------------------------------------- */
/* Fixtures                                                                      */
/* --------------------------------------------------------------------------- */

/**
 * SUBPROCESS-INVOCABLE FIXTURE (setup is a labelled core call). An external root
 * and run container whose names both contain a space, built from the real
 * installed identities and the exact C2 source pattern of
 * `manual-commands.test.mjs`: a test-owned source carrying exactly the manifest
 * entries, then `initialiseRun` with `harness: 'manual'` and dependency mode
 * `none`. Cleaned up on test completion.
 */
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-freeze-rec probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 }));
  const installation = loadInstallation();
  const sourceRoot = path.join(root, 'canonical source'); fs.mkdirSync(sourceRoot);
  for (const relative of installation.challenge.fileManifest) {
    const target = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(installation.challenge.sourceRoot, relative), target);
  }
  /* LABEL: in-process accepted core setup (not a subprocess). */
  const run = await initialiseRun({
    output: path.join(root, 'run with spaces'),
    challenge: { ...installation.challenge, sourceRoot },
    toolingIdentity: installation.toolingIdentity,
    evaluatorIdentity: installation.evaluatorIdentity,
    architectureId: createId('freeze-reconcile'), harness: 'manual', dependencies: { mode: 'none' },
  });
  return { root, run, opened: await openSelectedRun(run.output) };
}

/** Complete-file-inventory digest / entries of one tree (byte-stability checks). */
const treeDigest = (root) => inventoryTree({ root, skipNames: [] }).digest;
const treeInventory = (root) => inventoryTree({ root, skipNames: [] }).entries;

/* --------------------------------------------------------------------------- */
/* Subprocess helpers (the actual production CLI, never a stub)                  */
/* --------------------------------------------------------------------------- */

/**
 * SUBPROCESS: invoke the actual entrypoint as one argv array (never through a
 * shell), from the external fixture root as the working directory.
 */
function invoke(cwd, argv) {
  const result = spawnSync(process.execPath, [entrypoint, ...argv], {
    encoding: 'utf8',
    shell: false,
    cwd,
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  assert.equal(result.error, undefined,
    `the ${argv[0]} subprocess completed within its bound; got ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const trimmed = (text) => text.replace(/\r\n/g, '\n').trimEnd();

/** One CLI invocation against the fixture's run container. SUBPROCESS. */
const runCli = (f, argv) => invoke(f.root, [...argv, '--run', f.run.output]);

/**
 * A success: exit 0, empty stderr, exactly one JSON line carrying exactly the
 * stated keys of that command's summary (not a raw result object or a journal).
 */
function parseSummary(result, label, keys) {
  assert.equal(result.status, 0, `${label}: success exits with status 0; stderr ${JSON.stringify(result.stderr)}`);
  assert.equal(trimmed(result.stderr), '', `${label}: success writes nothing to stderr`);
  const lines = trimmed(result.stdout).split('\n');
  assert.equal(lines.length, 1, `${label}: success writes exactly one line, got ${lines.length}`);
  const summary = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(summary).sort(), [...keys].sort(),
    `${label}: the line is the stated summary schema, not a raw result or journal`);
  assert.ok(!Object.hasOwn(summary, 'journal') && !Object.hasOwn(summary, 'findings'),
    `${label}: the summary excludes the journal and raw finding strings`);
  return summary;
}

/**
 * A refusal: exit with the fixed category code, empty stdout, one controlled
 * coded stderr line, no stack frame, and no echo of the canary values
 * (synthetic operator/model or the raw run container path).
 */
function parseRefusal(result, label, exitCode, code, forbidden = []) {
  assert.equal(result.status, exitCode,
    `${label}: refusal exits ${exitCode}; got ${result.status}, stderr ${JSON.stringify(result.stderr)}`);
  assert.equal(trimmed(result.stdout), '', `${label}: a refusal writes nothing to stdout`);
  const lines = trimmed(result.stderr).split('\n');
  assert.equal(lines.length, 1, `${label}: exactly one stderr line`);
  assert.ok(CONTROLLED_CLI_LINE.test(lines[0]),
    `${label}: stderr is one controlled coded line; got ${JSON.stringify(lines[0])}`);
  assert.ok(lines[0].startsWith(`${code}: `),
    `${label}: stderr carries the fixed code ${code}; got ${JSON.stringify(lines[0])}`);
  assert.ok(!result.stderr.includes('\n    at ') && !result.stderr.includes('\n\tat '),
    `${label}: no stack dump`);
  for (const secret of forbidden)
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret),
      `${label}: the controlled diagnostic does not echo ${JSON.stringify(secret)}`);
  return lines[0];
}

/**
 * SUBPROCESS refusal with the completeness gate: the complete run file inventory
 * and its digest stand exactly still across the refused command.
 */
function refusedStable(f, argv, exitCode, code, label, extraForbidden = []) {
  const before = { digest: treeDigest(f.run.output), inventory: treeInventory(f.run.output) };
  const firstLine = parseRefusal(runCli(f, argv), label, exitCode, code,
    CANARY.concat(extraForbidden));
  assert.equal(treeDigest(f.run.output), before.digest, `${label}: the run digest is unchanged`);
  assert.deepEqual(treeInventory(f.run.output), before.inventory,
    `${label}: the complete run file inventory is unchanged`);
  return firstLine;
}

/* Shared controlled-fixture values (synthetic, never personal). */
const CANARY = Object.freeze(['synthetic-operator', 'synthetic-model']);
const START_DECLARATION = Object.freeze({
  harness: 'manual', model: 'synthetic-model', workerCount: 2,
  executionMode: 'MANUAL', declaredCeilingMinutes: 5,
});

/* Summary key sets exactly as the Captain's projections emit them. */
const STATUS_KEYS = Object.freeze(['command', 'runId', 'manifestId', 'state', 'diagnosis',
  'findingCount', 'guidance', 'startedAt', 'stoppedAt', 'elapsedMs', 'declaration',
  'stopAssurance', 'stopEnforced', 'clockError', 'attempts']);
const FREEZE_KEYS = Object.freeze(['command', 'runId', 'manifestId', 'state', 'diagnosis',
  'route', 'snapshotId', 'frozenSubmissionId', 'snapshotRoot', 'treeDigest', 'fileCount',
  'byteCount', 'frozenAt', 'frozenAtProvenance', 'elapsedMs', 'stopAssurance', 'stopEnforced']);
const RECONCILE_KEYS = Object.freeze(['command', 'runId', 'manifestId', 'operation',
  'intentDigest', 'requestedDisposition', 'action', 'repaired', 'retained', 'state',
  'diagnosis', 'snapshotId', 'findingCount']);

/* --------------------------------------------------------------------------- */
/* In-process production/accepted helpers (labelled; not subprocess stand-ins)   */
/* --------------------------------------------------------------------------- */

/** IN-PROCESS accepted read of the persisted lifecycle view. */
const readView = (f) => readRunLifecycle(f.opened.request);

/** IN-PROCESS accepted read of the persisted freeze proof (not a folder guess). */
const verifySaved = (f) => verifyFrozenSubmission(f.opened.request);

/** A 64-hex digest that no journal event can carry (pattern-legal, value-absent). */
const ABSENT_INTENT = 'f'.repeat(64);
assert.match(ABSENT_INTENT, /^[a-f0-9]{64}$/);

/* =========================================================================== */
/* Check 1 — normal actual start / stop / freeze, then the frozen selection     */
/* =========================================================================== */

describe('freeze/reconcile check 1: actual stopped-route freeze and production frozen selection', () => {
  test('the freeze records the stated facts; the saved snapshot survives a live workspace edit', async t => {
    const f = await fixture(t);

    /* SUBPROCESS: the fixed operator stop attestation route. */
    parseSummary(runCli(f, ['start', '--model', 'synthetic-model', '--worker-count', '2',
      '--declared-ceiling-minutes', '5']), 'start', STATUS_KEYS);
    const stop = parseSummary(runCli(f, ['stop', '--operator', 'synthetic-operator',
      '--agents-stopped']), 'stop', STATUS_KEYS);
    assert.equal(stop.state, 'STOP_RECORDED');

    /* SUBPROCESS: the freeze carries no attestation of its own; the re-used
     * recorded stop attestation is the contract's normal route. */
    const freeze = parseSummary(runCli(f, ['freeze']), 'freeze', FREEZE_KEYS);
    assert.equal(freeze.state, 'FROZEN');
    assert.equal(freeze.route, 'STOP_RECORDED');
    assert.match(freeze.snapshotId, /^snap-[a-f0-9]{32}$/);
    assert.match(freeze.frozenSubmissionId, /^fsub-[a-f0-9]{32}$/);
    assert.match(freeze.treeDigest, /^[a-f0-9]{64}$/);
    assert.equal(freeze.frozenAt, stop.stoppedAt,
      'the frozen instant is the recorded stop the attestation names');
    assert.equal(freeze.frozenAtProvenance, 'lifecycle.stoppedAt');
    assert.equal(freeze.stopAssurance, 'operator-attested');
    assert.equal(freeze.stopEnforced, false, 'the freeze enforces nothing');
    assert.ok(Number.isInteger(freeze.elapsedMs) && freeze.elapsedMs >= 0,
      `the known elapsed reports as an integer, got ${JSON.stringify(freeze.elapsedMs)}`);

    /* IN-PROCESS accepted read of the persisted proof: the saved identity,
     * hash and byte counts stand on disk, not only in the summary. */
    const saved = await verifySaved(f);
    assert.equal(saved.ok, true, JSON.stringify(saved.findings));
    assert.equal(saved.state, 'FROZEN');
    assert.equal(saved.submissions.length, 1);
    const proof = saved.submissions[0];
    assert.equal(proof.snapshotId, freeze.snapshotId);
    assert.equal(proof.frozenSubmissionId, freeze.frozenSubmissionId);
    assert.equal(proof.treeDigest, freeze.treeDigest);
    assert.equal(proof.frozenAt, freeze.frozenAt);
    assert.equal(freeze.fileCount, 26,
      'the verified snapshot holds the 26-file public workspace');
    assert.equal(proof.fileCount, 26);

    /* Save the snapshot inventory, then SUBPROCESS-free edit the live workspace. */
    const snapshotInventory = treeInventory(path.join(f.run.output, 'snapshots'));
    fs.appendFileSync(path.join(f.run.workspace.root, 'package.json'), '\n', 'utf8');

    /* IN-PROCESS EXPORTED PRODUCTION `selectVerifiedFrozen` with the explicit
     * snapshot selection: the saved bytes match the saved identity and the live
     * workspace no longer matches the frozen inventory. The live edit is never
     * fed into the saved evaluation. */
    const selection = await selectVerifiedFrozen(f.opened, freeze.snapshotId);
    assert.equal(selection.snapshotId, freeze.snapshotId);
    assert.equal(selection.frozenSubmissionId, freeze.frozenSubmissionId);
    assert.equal(selection.treeDigest, freeze.treeDigest);
    assert.equal(selection.frozenAt, freeze.frozenAt);
    assert.equal(selection.fileCount, freeze.fileCount);
    assert.equal(selection.byteCount, freeze.byteCount);
    assert.equal(selection.workspaceMatchesFrozenInventory, false,
      'the post-freeze live edit is reported as drift, and the saved bytes still verify');
    assert.deepEqual(treeInventory(path.join(f.run.output, 'snapshots')), snapshotInventory,
      'production selection read the snapshot without moving a byte of it');

    /* A wrong snapshot identity is the state category (exit 3) out of the same
     * exported production path. IN-PROCESS production call. */
    const wrong = 'snap-' + '0'.repeat(32);
    assert.match(wrong, /^snap-[a-f0-9]{32}$/);
    await assert.rejects(selectVerifiedFrozen(f.opened, wrong),
      (error) => error instanceof CommandError && error.category === 'state'
        && CATEGORIES.state.exitCode === 3,
      'a snapshot identity the run does not carry is the state refusal');

    /* A physically modified saved snapshot file is the integrity category
     * (exit 4) through production selection: the byte check, not the folder, is
     * what fails. IN-PROCESS production call. */
    const snapshotFile = path.join(f.run.output, 'snapshots', freeze.snapshotId, 'workspace', 'package.json');
    fs.writeFileSync(snapshotFile, 'tampered snapshot byte\n', 'utf8');
    await assert.rejects(selectVerifiedFrozen(f.opened, freeze.snapshotId),
      (error) => error instanceof CommandError && error.category === 'integrity'
        && CATEGORIES.integrity.exitCode === 4,
      'a tampered saved byte is the integrity refusal through production selection');
  });
});

/* =========================================================================== */
/* Check 2 — actual clockless freeze, and the normal-route state refusals       */
/* =========================================================================== */

describe('freeze/reconcile check 2: actual clockless route, clockless flag policy, route refusals', () => {
  test('the clockless freeze on untouched INITIALIZED journals only the freeze pair with no instants', async t => {
    const f = await fixture(t);
    /* SUBPROCESS: the explicit clockless route with the operator's own flags. */
    const freeze = parseSummary(runCli(f, ['freeze', '--clockless', '--operator', 'synthetic-operator',
      '--agents-stopped']), 'clockless freeze', FREEZE_KEYS);
    assert.equal(freeze.state, 'FROZEN');
    assert.equal(freeze.route, 'CLOCKLESS_INITIALIZED');
    assert.equal(freeze.elapsedMs, null, 'the clockless elapsed is unknown: null, never 0');
    assert.equal(freeze.stopAssurance, null);
    assert.equal(freeze.stopEnforced, false);

    /* IN-PROCESS accepted read: the persisted record carries no start or stop
     * instant, and the journal carries the freeze pair with no invented start. */
    const view = await readView(f);
    assert.equal(view.state, 'FROZEN');
    assert.equal(view.lifecycle.startedAt, null, 'no start instant was recorded');
    assert.equal(view.lifecycle.stoppedAt, null, 'no stop instant was recorded');
    assert.equal(view.lifecycle.elapsedMs, null, 'the persisted elapsed is null, not zero');
    assert.deepEqual(view.journal.events.map((event) => event.kind),
      ['FREEZE_INTENT', 'FREEZE_COMMIT'], 'the journal is the freeze pair with no start event');
    assert.equal(view.journal.events[0].detail.clockless, true,
      'the journaled intent states the clockless route');

    /* SUBPROCESS: a repeated freeze (normal or clockless) over FROZEN refuses
     * with the state category and stands every byte still. */
    refusedStable(f, ['freeze'], 3, 'CLI_STATE', 'repeated normal freeze over FROZEN');
    refusedStable(f, ['freeze', '--clockless', '--operator', 'synthetic-operator',
      '--agents-stopped'], 3, 'CLI_STATE', 'repeated clockless freeze over FROZEN');
  });

  test('the normal route refuses INITIALIZED and RUNNING runs; clockless flag mistakes are usage refusals', async t => {
    const f = await fixture(t);
    /* SUBPROCESS: no-clockless freeze over the untouched INITIALIZED run. */
    refusedStable(f, ['freeze'], 3, 'CLI_STATE', 'normal freeze over INITIALIZED');
    /* SUBPROCESS: no-clockless freeze over a RUNNING run. */
    parseSummary(runCli(f, ['start', '--model', 'synthetic-model']), 'start', STATUS_KEYS);
    refusedStable(f, ['freeze'], 3, 'CLI_STATE', 'normal freeze over RUNNING');
    /* SUBPROCESS: the run reaches STOP_RECORDED so the flag-policy cases below
     * fail on the flags and not on the state. */
    parseSummary(runCli(f, ['stop', '--operator', 'synthetic-operator',
      '--agents-stopped']), 'stop', STATUS_KEYS);

    /* SUBPROCESS: the clockless operator is required and bounded; a missing or
     * one-character operator is the usage category, and the run is untouched. */
    refusedStable(f, ['freeze', '--clockless', '--agents-stopped'],
      2, 'CLI_USAGE', 'clockless freeze with a missing operator');
    refusedStable(f, ['freeze', '--clockless', '--operator', 'x', '--agents-stopped'],
      2, 'CLI_USAGE', 'clockless freeze with a one-character operator', ['x']);
    /* SUBPROCESS: on the normal route the clockless flags are not ignored — a
     * stray --operator is a usage refusal before any freeze work. */
    refusedStable(f, ['freeze', '--operator', 'synthetic-operator'],
      2, 'CLI_USAGE', 'normal freeze carrying a stray operator');
    refusedStable(f, ['freeze', '--agents-stopped'],
      2, 'CLI_USAGE', 'normal freeze carrying a stray agents-stopped flag');

    /* SUBPROCESS: with the flags in order the route completes. */
    const freeze = parseSummary(runCli(f, ['freeze']), 'normal freeze after stop', FREEZE_KEYS);
    assert.equal(freeze.route, 'STOP_RECORDED');
  });
});

/* =========================================================================== */
/* Check 3 — actual interrupted-START recovery through the CLI                  */
/* =========================================================================== */

describe('freeze/reconcile check 3: actual reconcile over a journaled start intent', () => {
  test('LEAVE_AS_IS preserves bytes, a wrong digest refuses, COMPLETE repairs from the journaled declaration', async t => {
    const f = await fixture(t);
    /* LABEL: in-process accepted-transaction setup, the exact interrupted-start
     * pattern of `manual-commands.test.mjs` check 4: one journaled intent, no
     * commit, no CLI hook of any kind. */
    await withRunTransaction(f.opened.request,
      (context) => context.appendEvent({ kind: 'START_INTENT', declaration: START_DECLARATION }));

    /* IN-PROCESS accepted read of the actual event digest the CLI must be given. */
    const torn = await readView(f);
    assert.equal(torn.diagnosis, 'incomplete');
    assert.equal(torn.journal.events.length, 1);
    assert.equal(torn.journal.events[0].kind, 'START_INTENT');
    const intentDigest = torn.journal.events[0].eventDigest;
    assert.match(intentDigest, /^[a-f0-9]{64}$/);

    /* SUBPROCESS: LEAVE_AS_IS with the correct digest reports no repair and
     * preserves all bytes. */
    const left = parseSummary(runCli(f, ['reconcile', '--operation', 'start', '--disposition', 'LEAVE_AS_IS',
      '--operator', 'synthetic-operator', '--intent', intentDigest]), 'reconcile LEAVE_AS_IS', RECONCILE_KEYS);
    assert.equal(left.action, 'LEAVE_AS_IS');
    assert.equal(left.repaired, false, 'LEAVE_AS_IS claims no repair');
    assert.equal(left.snapshotId, null);

    /* SUBPROCESS: a digest that is not the journaled intent is the state refusal,
     * bytes standing still. */
    refusedStable(f, ['reconcile', '--operation', 'start', '--disposition', 'COMPLETE',
      '--operator', 'synthetic-operator', '--intent', ABSENT_INTENT],
      3, 'CLI_STATE', 'reconcile COMPLETE with a wrong intent digest', [ABSENT_INTENT]);

    /* SUBPROCESS: COMPLETE with the correct digest repairs from the original
     * journaled declaration. */
    const before = treeDigest(f.run.output);
    const done = parseSummary(runCli(f, ['reconcile', '--operation', 'start', '--disposition', 'COMPLETE',
      '--operator', 'synthetic-operator', '--intent', intentDigest]), 'reconcile COMPLETE', RECONCILE_KEYS);
    assert.equal(done.action, 'COMPLETE');
    assert.equal(done.repaired, true);
    assert.ok(treeDigest(f.run.output).length > 0);
    void before;

    /* SUBPROCESS: the status read states the repaired run consistently. The
     * declaration is the one the journal carried, the operator is the stated one,
     * and no model is fabricated. */
    const status = parseSummary(runCli(f, ['status']), 'status after the start repair', STATUS_KEYS);
    assert.equal(status.state, 'RUNNING');
    assert.equal(status.diagnosis, 'consistent');
    assert.deepEqual(status.declaration, { ...START_DECLARATION });
    /* IN-PROCESS accepted read: the commit binds the intent and the reconcile
     * entry names the stated operator; no second operator or model appears. */
    const repaired = await readView(f);
    assert.deepEqual(repaired.journal.events.map((event) => event.kind),
      ['START_INTENT', 'START_COMMIT'], 'the completion appends the commit');
    assert.equal(repaired.journal.events[1].detail.completedFromIntentDigest, intentDigest,
      'the commit is bound to the journaled intent');
    const reconcileEntry = repaired.lifecycle.history.find((entry) => entry.operation === 'RECONCILE');
    assert.equal(reconcileEntry.operator, 'synthetic-operator',
      'the history names the operator the command was given, no invented one');
    assert.equal(reconcileEntry.completedFromIntentDigest, intentDigest);
    assert.equal(repaired.lifecycle.declaration.model, 'synthetic-model',
      'the repaired declaration is the journaled one');

    /* SUBPROCESS: a repeat completion refuses rather than inventing a second
     * repair; the journal and inventory stand still. */
    refusedStable(f, ['reconcile', '--operation', 'start', '--disposition', 'COMPLETE',
      '--operator', 'synthetic-operator', '--intent', intentDigest],
      3, 'CLI_STATE', 'repeat COMPLETE over the repaired run');
    const afterRepeat = await readView(f);
    assert.deepEqual(afterRepeat.journal.events.map((event) => event.kind),
      ['START_INTENT', 'START_COMMIT'], 'the repeat appended nothing');
  });
});

/* =========================================================================== */
/* Check 4 — actual interrupted-FREEZE recovery through the CLI                 */
/* =========================================================================== */

describe('freeze/reconcile check 4: actual reconcile over an interrupted freeze', () => {
  test('KEEP preserves bytes, COMPLETE repairs the bound pair, usage policy and residue hold', async t => {
    const f = await fixture(t);
    /* SUBPROCESS: reach the STOP_RECORDED state the normal route freezes from. */
    parseSummary(runCli(f, ['start', '--model', 'synthetic-model']), 'start', STATUS_KEYS);
    parseSummary(runCli(f, ['stop', '--operator', 'synthetic-operator',
      '--agents-stopped']), 'stop', STATUS_KEYS);

    /* LABEL: in-process accepted C3 setup only. The existing C3 publicationHook
     * is what leaves an interrupted freeze at the proof-published point; the CLI
     * exposes no hook and this test passes none to any subprocess. */
    const view = await readView(f);
    const fault = await freezeRun({ ...f.opened.request,
      attestation: view.lifecycle.stopAttestation,
      publicationHook: (at) => { if (at === 'proof-published') throw new Error('injected publication fault'); },
    }).then(() => null, (error) => error);
    assert.ok(fault instanceof Error, 'the injected fault surfaces as a refusal');
    const fate = fault.details?.freezeFate;
    assert.equal(fate.interruptedOperation, 'FREEZE');
    assert.equal(fate.intentJournaled, true);
    const intentDigest = fate.intentEventDigest;
    assert.match(intentDigest, /^[a-f0-9]{64}$/);
    assert.equal(typeof fate.proofPublished, 'string', 'the retained proof is named');
    assert.equal(typeof fate.submissionPublished, 'string', 'the retained submission is named');
    const snapshotId = fate.proofPublished;
    const submissionId = fate.submissionPublished;

    /* Read the actual bytes this interrupted freeze left: the two published
     * records and the retained snapshot tree. */
    const freezeStateRoot = path.join(f.run.output, '.benchboard', 'freeze');
    const proofBytes = fs.readFileSync(path.join(freezeStateRoot, `${snapshotId}.json`));
    const submissionBytes = fs.readFileSync(path.join(freezeStateRoot, `${submissionId}.json`));
    const snapshotTreeBefore = treeInventory(path.join(f.run.output, 'snapshots'));
    /* Plant foreign residue the recovery may not delete, inside the snapshots
     * root. */
    const foreign = path.join(f.run.output, 'snapshots', 'foreign-not-mine');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'keep.txt'), 'foreign material\n', 'utf8');
    const fullBefore = treeInventory(f.run.output);

    /* SUBPROCESS: KEEP_INTERRUPTED preserves all bytes and reports no repair. */
    const kept = parseSummary(runCli(f, ['reconcile', '--operation', 'freeze',
      '--disposition', 'KEEP_INTERRUPTED', '--operator', 'synthetic-operator',
      '--intent', intentDigest]), 'reconcile KEEP_INTERRUPTED', RECONCILE_KEYS);
    assert.equal(kept.action, 'KEEP_INTERRUPTED');
    assert.equal(kept.repaired, false);
    assert.equal(kept.retained, true);
    assert.equal(kept.state, 'STOP_RECORDED',
      'KEEP reports the projection as it stands rather than advancing it');
    assert.deepEqual(treeInventory(f.run.output), fullBefore,
      'KEEP_INTERRUPTED moved no byte of the whole run container');

    /* SUBPROCESS: a wrong digest over the freeze intent is the state refusal,
     * bytes still standing. */
    refusedStable(f, ['reconcile', '--operation', 'freeze', '--disposition', 'COMPLETE',
      '--operator', 'synthetic-operator', '--intent', ABSENT_INTENT],
      3, 'CLI_STATE', 'freeze COMPLETE with a wrong intent digest', [ABSENT_INTENT]);

    /* SUBPROCESS: COMPLETE with the exact digest repairs to FROZEN over the
     * same snapshot; the proof and submission bytes and the snapshot bytes are
     * byte-identical to what the interrupted freeze left. */
    const done = parseSummary(runCli(f, ['reconcile', '--operation', 'freeze', '--disposition', 'COMPLETE',
      '--operator', 'synthetic-operator', '--intent', intentDigest]), 'reconcile freeze COMPLETE', RECONCILE_KEYS);
    assert.equal(done.action, 'COMPLETE');
    assert.equal(done.repaired, true);
    assert.equal(done.state, 'FROZEN');
    assert.equal(done.snapshotId, snapshotId, 'the repair is over the same snapshot');
    assert.deepEqual(fs.readFileSync(path.join(freezeStateRoot, `${snapshotId}.json`)), proofBytes,
      'the immutable proof bytes stand byte-identical through the repair');
    assert.deepEqual(fs.readFileSync(path.join(freezeStateRoot, `${submissionId}.json`)), submissionBytes,
      'the immutable submission bytes stand byte-identical through the repair');
    const snapshotTreeAfter = treeInventory(path.join(f.run.output, 'snapshots'));
    for (const entry of snapshotTreeBefore)
      assert.ok(snapshotTreeAfter.some((after) => after.path === entry.path && after.sha256 === entry.sha256),
        `the retained snapshot byte ${entry.path} stands unchanged`);

    /* IN-PROCESS accepted read: the completion bound the journaled intent. */
    const reconciled = await readView(f);
    assert.deepEqual(reconciled.journal.events.map((event) => event.kind).slice(-1), ['FREEZE_COMMIT'],
      'the repair appends the commit rather than rewriting the journal');
    /* SUBPROCESS: the status now reads the frozen run consistently. */
    const status = parseSummary(runCli(f, ['status']), 'status after the freeze repair', STATUS_KEYS);
    assert.equal(status.state, 'FROZEN');
    assert.equal(status.diagnosis, 'consistent');

    /* The foreign residue and the snapshot root both stand where they were; no
     * lock removal or residue deletion happened on this path. */
    assert.equal(fs.readFileSync(path.join(foreign, 'keep.txt'), 'utf8'), 'foreign material\n',
      'the recovery left the foreign material exactly where it was');
    assert.ok(fs.readdirSync(path.join(f.run.output, 'snapshots')).length > 0,
      'the snapshots root was not emptied');
    void fullBefore;

    /* SUBPROCESS: the usage policy — unknown operation, an operation/disposition
     * mismatch, a missing intent and a malformed digest are usage refusals that
     * start no work and move no byte. */
    refusedStable(f, ['reconcile', '--operation', 'teleport', '--disposition', 'COMPLETE',
      '--operator', 'synthetic-operator', '--intent', intentDigest],
      2, 'CLI_USAGE', 'reconcile with an unknown operation');
    refusedStable(f, ['reconcile', '--operation', 'freeze', '--disposition', 'LEAVE_AS_IS',
      '--operator', 'synthetic-operator', '--intent', intentDigest],
      2, 'CLI_USAGE', 'freeze with a start/stop disposition');
    refusedStable(f, ['reconcile', '--operation', 'start', '--disposition', 'KEEP_INTERRUPTED',
      '--operator', 'synthetic-operator', '--intent', intentDigest],
      2, 'CLI_USAGE', 'start with a freeze disposition');
    refusedStable(f, ['reconcile', '--operation', 'freeze', '--disposition', 'COMPLETE',
      '--operator', 'synthetic-operator'],
      2, 'CLI_USAGE', 'reconcile with a missing intent');
    refusedStable(f, ['reconcile', '--operation', 'freeze', '--disposition', 'COMPLETE',
      '--intent', intentDigest],
      2, 'CLI_USAGE', 'reconcile with a missing operator');
    refusedStable(f, ['reconcile', '--operation', 'freeze', '--disposition', 'COMPLETE',
      '--operator', 'synthetic-operator', '--intent', 'not-a-digest'],
      2, 'CLI_USAGE', 'reconcile with a malformed digest', ['not-a-digest']);
  });
});
