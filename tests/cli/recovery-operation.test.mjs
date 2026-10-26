/**
 * Independent wrong-operation recovery refusal acceptance (task packet C6.S5.T6).
 *
 * These tests drive the production route end to end: every refusal and success
 * the packet states as a command behavior is asserted against a real, shell-free,
 * bounded `spawnSync` of `cli/benchboard.mjs` against the external spaced-name
 * run container of `realRunFixture`. No production code receives a test-only
 * injection: the child processes carry no clock, no runtime and no hook.
 * In-process calls appear at three labelled kinds of place and each is labelled
 * at the call site:
 *   - fixture setup through the accepted core (`startRun`, `withRunTransaction`,
 *     and the accepted C3 `freezeRun` whose existing `publicationHook` is the
 *     only way the C3 contract can leave an interrupted freeze at the
 *     proof-published point; the CLI exposes no hook);
 *   - independent reads of persisted state through the accepted
 *     `readRunLifecycle`;
 *   - byte-inventory snapshots for the completeness comparisons.
 *
 * The wrong-operation claim proved here: over a run whose ACTUAL pending
 * operation is the journaled FREEZE (START_INTENT, START_COMMIT, STOP_RECORDED
 * and FREEZE_INTENT journaled, no FREEZE_COMMIT), reconciling an older journaled
 * intent — the START or the STOP — is a state refusal (exit 3 CLI_STATE) with
 * whole-run byte stability, for either disposition, including the old START
 * digest given to `--operation start` with `--disposition COMPLETE`, which is
 * exactly the invocation that would drive the destructive START-completion route
 * in the accepted core over this run. The core is deliberately never invoked
 * directly on that path; the CLI's own binding gate is what is exercised. The
 * correct FREEZE disposition remains the one route that resolves the run:
 * KEEP_INTERRUPTED reports no repair with every raw byte unchanged, and
 * COMPLETE repairs to FROZEN over the same snapshot identity. A run over no
 * pending operation (a complete healthy start) accepts no disposition at all.
 *
 * Contract facts asserted here come from the task packet:
 * - a refusal: empty stdout, one controlled `CLI_*: guidance` stderr line with
 *   the fixed CLI_STATE code and exit 3, no stack frame, no canary or raw-path
 *   echo, and a complete run file inventory that stands still (no foreign
 *   deletion, no implicit repair);
 * - the KEEP_INTERRUPTED success: repaired false, every raw byte unchanged;
 * - the freeze COMPLETE success: repaired true, state FROZEN, diagnosis
 *   consistent, the same snapshot identity the interrupted freeze named;
 * - the torn-START run: the correct LEAVE_AS_IS stays permitted, COMPLETE
 *   repairs, and a further COMPLETE or LEAVE_AS_IS over the healthy closed
 *   journal is a state refusal with unchanged bytes;
 * - a run whose journal is a legal prefix that the reader still cannot diagnose
 *   (an intent with no commit while no projection was authored) is reported with
 *   the incomplete diagnosis, and the unique old intent with its matching
 *   commit present still refuses every wrong-operation binding.
 *
 * Scope of the two synthetic-view tests: they exercise the pure Captain policy
 * function `bindRecoveryIntent` directly (the binding gate the reconcile command
 * calls after opening the run), so they prove the binding rule itself, not the
 * subprocess route; every subprocess claim above is proved by a real child.
 * They install no runtime hook; a bare object stands in for the view only
 * because a pure policy function takes a plain value.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realRunFixture } from './run-fixture.mjs';
import { bindRecoveryIntent } from '../../cli/recovery-contract.mjs';
import { CommandError } from '../../cli/command-error.mjs';
import { startRun, stopRun, withRunTransaction, readRunLifecycle } from '../../adapters/manual/index.mjs';
import { freezeRun } from '../../packages/core/freeze.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const entrypoint = path.join(repositoryRoot, 'cli', 'benchboard.mjs');

/* Bounds so a hung or chatty child cannot outlive the test run. */
const SPAWN_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 1_048_576;

/** One stderr line shaped `CLI_CODE: guidance`, and nothing else. */
const CONTROLLED_CLI_LINE = /^CLI_[A-Z0-9_]+: \S[^\n]*$/;

/* Shared controlled-fixture values (synthetic, never personal). */
const CANARY = Object.freeze(['synthetic-operator', 'synthetic-model']);
const START_DECLARATION = Object.freeze({
  harness: 'manual', model: null, workerCount: null, executionMode: 'MANUAL', declaredCeilingMinutes: null,
});
const STOP_ATTESTATION = Object.freeze({
  operator: 'synthetic-operator', agentStopped: true,
  statement: 'Controlled protocol fixture; no participant process ran.',
});

/** A 64-hex digest that no journal event can carry (pattern-legal, value-absent). */
const ABSENT_INTENT = 'f'.repeat(64);
assert.match(ABSENT_INTENT, /^[a-f0-9]{64}$/);

/* Summary key sets exactly as the Captain's projections emit them. */
const RECONCILE_KEYS = Object.freeze(['command', 'runId', 'manifestId', 'operation',
  'intentDigest', 'requestedDisposition', 'action', 'repaired', 'retained', 'state',
  'diagnosis', 'snapshotId', 'findingCount']);

/* --------------------------------------------------------------------------- */
/* Subprocess helpers (the actual production CLI, never a stub)                  */
/* --------------------------------------------------------------------------- */

/**
 * SUBPROCESS: invoke the actual entrypoint as one argv array (never through a
 * shell), from the external fixture root as the working directory. Every path
 * is one argv element (the fixture roots contain spaces).
 */
function invoke(f, argv) {
  const result = spawnSync(process.execPath, [entrypoint, ...argv, '--run', f.run.output], {
    encoding: 'utf8',
    shell: false,
    cwd: f.root,
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  assert.equal(result.error, undefined,
    `the ${argv[0]} subprocess completed within its bound; got ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const trimmed = (text) => text.replace(/\r\n/g, '\n').trimEnd();

/** Complete-file-inventory digest / entries of one tree (byte-stability checks). */
const treeDigest = (root) => inventoryTree({ root, skipNames: [] }).digest;
const treeInventory = (root) => inventoryTree({ root, skipNames: [] }).entries;

/**
 * A refusal: exit with the fixed category code, empty stdout, one controlled
 * coded stderr line, no stack frame, and no echo of the canary values or the
 * raw run container path.
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
  const firstLine = parseRefusal(invoke(f, argv), label, exitCode, code,
    CANARY.concat(extraForbidden, f.run.output));
  assert.equal(treeDigest(f.run.output), before.digest, `${label}: the run digest is unchanged`);
  assert.deepEqual(treeInventory(f.run.output), before.inventory,
    `${label}: the complete run file inventory is unchanged`);
  return firstLine;
}

/** A success: exit 0, empty stderr, exactly one JSON summary line. */
function parseSummary(result, label, keys) {
  assert.equal(result.status, 0, `${label}: success exits with status 0; stderr ${JSON.stringify(result.stderr)}`);
  assert.equal(trimmed(result.stderr), '', `${label}: success writes nothing to stderr`);
  const lines = trimmed(result.stdout).split('\n');
  assert.equal(lines.length, 1, `${label}: success writes exactly one line, got ${lines.length}`);
  const summary = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(summary).sort(), [...keys].sort(),
    `${label}: the line is the stated summary schema, not a raw result or journal`);
  return summary;
}

/* --------------------------------------------------------------------------- */
/* In-process accepted helpers (labelled; not subprocess stand-ins)               */
/* --------------------------------------------------------------------------- */

/** IN-PROCESS accepted read of the persisted lifecycle view. */
const readView = (f) => readRunLifecycle(f.opened.request);

/**
 * Fixture setup through the accepted core: start with the bounded controlled
 * clock of `recovery-boundaries.test.mjs`, then record the fixed operator stop
 * through the accepted `stopRun`, reaching a clean STOP_RECORDED projection the
 * stopped route freezes from. (The `appendEvent` stop pattern of
 * `recovery-boundaries.test.mjs` deliberately leaves a torn stop — journaled
 * without its projection commit — which is a different fixture and not this
 * one.) Labelled: not a subprocess, and the only clock any call receives is
 * this setup call's.
 */
async function reachStoppedRecorded(f) {
  const clock = { now: () => Date.parse('2026-01-01T00:00:00.000Z') };
  await startRun({ ...f.opened.request, clock, declaration: { ...START_DECLARATION } });
  await stopRun({ ...f.opened.request, clock, attestation: { ...STOP_ATTESTATION, observedAt: '2026-01-01T00:00:00.000Z' } });
}

/**
 * Fixture setup through the accepted C3: freeze over the recorded stop with the
 * existing publicationHook faulting at the proof-published point, leaving the
 * journaled FREEZE_INTENT with both immutable publications retained and no
 * FREEZE_COMMIT. The CLI exposes no hook and none is passed to any subprocess.
 */
async function interruptFreezeAfterProof(f) {
  const view = await readView(f);
  const fault = await freezeRun({ ...f.opened.request,
    attestation: view.lifecycle.stopAttestation,
    publicationHook: (at) => { if (at === 'proof-published') throw new Error('injected publication fault'); },
  }).then(() => null, (error) => error);
  assert.ok(fault instanceof Error, 'the injected fault surfaces as a refusal');
  const fate = fault.details?.freezeFate;
  assert.equal(fate.interruptedOperation, 'FREEZE');
  assert.equal(fate.intentJournaled, true);
  assert.equal(typeof fate.proofPublished, 'string', 'the retained proof is named');
  assert.equal(typeof fate.submissionPublished, 'string', 'the retained submission is named');
  return fate;
}

/** The exact journaled kind sequence of the public view, read independently. */
const journalKinds = (view) => view.journal.events.map((event) => event.kind);

/* =========================================================================== */
/* Check 1 — a STOP_RECORDED run with a pending FREEZE refuses the old START    */
/* =========================================================================== */

describe('recovery operation check 1: the old START digest over the pending freeze is refused', () => {
  test('--operation start with the journaled START digest and either disposition is a state refusal with byte stability', async t => {
    const f = await realRunFixture(t);
    await reachStoppedRecorded(f);
    const fate = await interruptFreezeAfterProof(f);

    /* IN-PROCESS accepted read: the actual public journal carries the stopped
     * route with the pending freeze — intent journaled, no commit. */
    const pending = await readView(f);
    assert.deepEqual(journalKinds(pending), ['START_INTENT', 'START_COMMIT', 'STOP_RECORDED', 'FREEZE_INTENT'],
      'the journal states the stopped route with a pending FREEZE and no FREEZE_COMMIT');
    const startDigest = pending.journal.events.find((event) => event.kind === 'START_INTENT').eventDigest;
    assert.match(startDigest, /^[a-f0-9]{64}$/);
    assert.equal(pending.journal.events.findLast((event) => event.kind === 'FREEZE_INTENT').eventDigest,
      fate.intentEventDigest, 'the read and the reported fate name the same journaled freeze intent');

    /* Plant foreign residue inside the run container that no recovery route may
     * delete across a refusal. */
    const foreign = path.join(f.run.output, 'snapshots', 'foreign-not-mine');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'keep.txt'), 'foreign material\n', 'utf8');

    /* SUBPROCESS: the old START digest with --operation start and either
     * decision is the state refusal over the pending freeze, including the
     * COMPLETE combination that would drive the destructive START-completion
     * route in the accepted core if it were reached. Whole-run byte stability
     * is gated on every refusal. */
    for (const decision of ['COMPLETE', 'LEAVE_AS_IS']) {
      refusedStable(f, ['reconcile', '--operation', 'start', '--disposition', decision,
        '--operator', 'synthetic-operator', '--intent', startDigest],
        3, 'CLI_STATE', `reconcile --operation start ${decision} over the pending freeze`, [startDigest]);
    }

    /* The refusal left the journaled sequence, the retained publications and
     * the foreign residue exactly where they were: no implicit repair, no
     * foreign deletion. */
    const after = await readView(f);
    assert.deepEqual(journalKinds(after), journalKinds(pending), 'the refused commands appended no journal event');
    assert.equal(fs.readFileSync(path.join(foreign, 'keep.txt'), 'utf8'), 'foreign material\n',
      'the recovery left the foreign material exactly where it was');
    assert.equal(fs.existsSync(path.join(f.run.output, '.benchboard', 'freeze', `${fate.proofPublished}.json`)), true,
      'the retained proof record stands where the interrupted freeze left it');
  });
});

/* =========================================================================== */
/* Check 2 — same run: the old STOP route refuses; the FREEZE route resolves     */
/* =========================================================================== */

describe('recovery operation check 2: the fully projected stop route refuses while the pending freeze resolves', () => {
  test('old STOP_RECORDED and wrong FREEZE digests refuse with raw bytes unchanged; KEEP reports no repair; COMPLETE repairs the same snapshot', async t => {
    const f = await realRunFixture(t);
    await reachStoppedRecorded(f);
    const fate = await interruptFreezeAfterProof(f);

    /* Plant foreign residue before the first command; it must survive every
     * refusal and the repair. */
    const foreign = path.join(f.run.output, 'snapshots', 'foreign-not-mine');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'keep.txt'), 'foreign material\n', 'utf8');

    /* IN-PROCESS accepted read of the actual digests the commands must be given. */
    const pending = await readView(f);
    assert.deepEqual(journalKinds(pending), ['START_INTENT', 'START_COMMIT', 'STOP_RECORDED', 'FREEZE_INTENT']);
    const stopDigest = pending.journal.events.find((event) => event.kind === 'STOP_RECORDED').eventDigest;
    const freezeDigest = pending.journal.events.findLast((event) => event.kind === 'FREEZE_INTENT').eventDigest;
    assert.equal(freezeDigest, fate.intentEventDigest);

    /* SUBPROCESS: the old STOP_RECORDED digest with --operation stop and either
     * decision is the state refusal — that stop is fully projected into the
     * STOP_RECORDED record and the actual pending operation is the FREEZE. */
    for (const decision of ['COMPLETE', 'LEAVE_AS_IS']) {
      refusedStable(f, ['reconcile', '--operation', 'stop', '--disposition', decision,
        '--operator', 'synthetic-operator', '--intent', stopDigest],
        3, 'CLI_STATE', `reconcile --operation stop ${decision} over the fully projected stop`, [stopDigest]);
    }

    /* SUBPROCESS: a pattern-legal digest that is not the journaled FREEZE intent
     * is the state refusal over the same pending operation. */
    refusedStable(f, ['reconcile', '--operation', 'freeze', '--disposition', 'COMPLETE',
      '--operator', 'synthetic-operator', '--intent', ABSENT_INTENT],
      3, 'CLI_STATE', 'freeze COMPLETE with a wrong intent digest', [ABSENT_INTENT]);

    /* Snapshot the immutable raw records and the snapshot tree before the
     * repair, so "raw bytes unchanged" is byte comparison, not a digest echo. */
    const freezeStateRoot = path.join(f.run.output, '.benchboard', 'freeze');
    const proofPath = path.join(freezeStateRoot, `${fate.proofPublished}.json`);
    const submissionPath = path.join(freezeStateRoot, `${fate.submissionPublished}.json`);
    const proofBytes = fs.readFileSync(proofPath);
    const submissionBytes = fs.readFileSync(submissionPath);
    const snapshotTreeBefore = treeInventory(path.join(f.run.output, 'snapshots'));
    const fullBefore = treeInventory(f.run.output);

    /* SUBPROCESS: KEEP_INTERRUPTED with the exact digest reports no repair and
     * moves no byte of the whole run container. */
    const kept = parseSummary(invoke(f, ['reconcile', '--operation', 'freeze', '--disposition', 'KEEP_INTERRUPTED',
      '--operator', 'synthetic-operator', '--intent', freezeDigest]), 'reconcile KEEP_INTERRUPTED', RECONCILE_KEYS);
    assert.equal(kept.action, 'KEEP_INTERRUPTED');
    assert.equal(kept.repaired, false, 'KEEP_INTERRUPTED claims no repair');
    assert.equal(kept.retained, true);
    assert.equal(kept.state, 'STOP_RECORDED', 'KEEP reports the projection as it stands');
    assert.deepEqual(treeInventory(f.run.output), fullBefore,
      'KEEP_INTERRUPTED moved no byte of the whole run container');

    /* SUBPROCESS: COMPLETE with the exact digest repairs to FROZEN over the
     * same snapshot identity, and the immutable proof/submission records and
     * the snapshot bytes are byte-identical to what the interrupted freeze left. */
    const done = parseSummary(invoke(f, ['reconcile', '--operation', 'freeze', '--disposition', 'COMPLETE',
      '--operator', 'synthetic-operator', '--intent', freezeDigest]), 'reconcile freeze COMPLETE', RECONCILE_KEYS);
    assert.equal(done.action, 'COMPLETE');
    assert.equal(done.repaired, true);
    assert.equal(done.state, 'FROZEN');
    assert.equal(done.diagnosis, 'consistent');
    assert.equal(done.snapshotId, fate.proofPublished, 'the repair is over the same snapshot identity');
    assert.deepEqual(fs.readFileSync(proofPath), proofBytes,
      'the immutable proof bytes stand byte-identical through the repair');
    assert.deepEqual(fs.readFileSync(submissionPath), submissionBytes,
      'the immutable submission bytes stand byte-identical through the repair');
    const snapshotTreeAfter = treeInventory(path.join(f.run.output, 'snapshots'));
    for (const entry of snapshotTreeBefore)
      assert.ok(snapshotTreeAfter.some((after) => after.path === entry.path && after.sha256 === entry.sha256),
        `the retained snapshot byte ${entry.path} stands unchanged`);

    /* IN-PROCESS accepted read: the completion appended the commit; the foreign
     * residue was not deleted by the repair. */
    const repaired = await readView(f);
    assert.deepEqual(journalKinds(repaired).slice(-1), ['FREEZE_COMMIT'],
      'the repair appends the commit rather than rewriting the journal');
    assert.equal(fs.readFileSync(path.join(foreign, 'keep.txt'), 'utf8'), 'foreign material\n',
      'the repair left the foreign material exactly where it was');
  });
});

/* =========================================================================== */
/* Check 3 — the C3 torn-START fixture: only the START route has authority       */
/* =========================================================================== */

describe('recovery operation check 3: over the torn start, old-freeze bindings refuse while the start route resolves', () => {
  test('correct LEAVE_AS_IS is permitted, COMPLETE repairs, further dispositions refuse the healthy closed journal', async t => {
    const f = await realRunFixture(t);
    /* LABEL: in-process accepted-transaction setup, the exact interrupted-start
     * pattern of `manual-commands.test.mjs` check 4: one journaled intent, no
     * commit, no CLI hook of any kind. */
    await withRunTransaction(f.opened.request,
      (context) => context.appendEvent({ kind: 'START_INTENT', declaration: START_DECLARATION }));

    /* IN-PROCESS accepted read: the single event kind present is START_INTENT. */
    const torn = await readView(f);
    assert.equal(torn.diagnosis, 'incomplete');
    assert.deepEqual(journalKinds(torn), ['START_INTENT']);
    const intentDigest = torn.journal.events[0].eventDigest;
    assert.match(intentDigest, /^[a-f0-9]{64}$/);

    /* SUBPROCESS: the operation with no journaled intent of its kind — a
     * pattern-legal digest under the stop and freeze routes — is the state
     * refusal, no matter what the run's diagnosis reports. No second pending
     * operation is invented for this; the absent-kind binding is the refusal. */
    for (const operation of ['stop', 'freeze']) {
      const disposition = operation === 'stop' ? 'LEAVE_AS_IS' : 'KEEP_INTERRUPTED';
      refusedStable(f, ['reconcile', '--operation', operation, '--disposition', disposition,
        '--operator', 'synthetic-operator', '--intent', ABSENT_INTENT],
        3, 'CLI_STATE', `${operation} ${disposition} over a journal with no ${operation.toUpperCase()}_INTENT`, [ABSENT_INTENT]);
    }

    /* SUBPROCESS: the correct START LEAVE_AS_IS remains permitted: exit 0, no
     * repair claimed, every byte where it was. */
    const left = parseSummary(invoke(f, ['reconcile', '--operation', 'start', '--disposition', 'LEAVE_AS_IS',
      '--operator', 'synthetic-operator', '--intent', intentDigest]), 'reconcile LEAVE_AS_IS', RECONCILE_KEYS);
    assert.equal(left.action, 'LEAVE_AS_IS');
    assert.equal(left.repaired, false, 'LEAVE_AS_IS claims no repair');
    assert.equal(left.snapshotId, null);

    /* SUBPROCESS: COMPLETE with the correct digest repairs from the journaled
     * declaration. */
    const done = parseSummary(invoke(f, ['reconcile', '--operation', 'start', '--disposition', 'COMPLETE',
      '--operator', 'synthetic-operator', '--intent', intentDigest]), 'reconcile COMPLETE', RECONCILE_KEYS);
    assert.equal(done.action, 'COMPLETE');
    assert.equal(done.repaired, true);

    /* IN-PROCESS accepted read: the run closed healthy; the journal carries the
     * intent and its commit and nothing else. */
    const repaired = await readView(f);
    assert.deepEqual(journalKinds(repaired), ['START_INTENT', 'START_COMMIT'],
      'the completion appends the commit');
    assert.equal(repaired.diagnosis, 'consistent');

    /* SUBPROCESS: a further COMPLETE or LEAVE_AS_IS over the healthy closed
     * journal is the state refusal with unchanged bytes. */
    refusedStable(f, ['reconcile', '--operation', 'start', '--disposition', 'COMPLETE',
      '--operator', 'synthetic-operator', '--intent', intentDigest],
      3, 'CLI_STATE', 'repeat COMPLETE over the repaired run', [intentDigest]);
    refusedStable(f, ['reconcile', '--operation', 'start', '--disposition', 'LEAVE_AS_IS',
      '--operator', 'synthetic-operator', '--intent', intentDigest],
      3, 'CLI_STATE', 'LEAVE_AS_IS over the repaired run', [intentDigest]);
    const afterRefusals = await readView(f);
    assert.deepEqual(afterRefusals.journal.events.map((event) => event.eventDigest),
      repaired.journal.events.map((event) => event.eventDigest), 'the refused repeats appended nothing');
  });
});

/* =========================================================================== */
/* Check 4 — synthetic binding views: scope stated, not subprocess proof         */
/* =========================================================================== */

describe('recovery operation check 4: the binding gate over synthetic views (pure policy, not subprocess proof)', () => {
  const oldStartDigest = 'a'.repeat(64);
  const stopDigest = 'c'.repeat(64);
  const freezeDigest = 'd'.repeat(64);

  /** The real journal-shape kinds/digests of a stopped run with a pending freeze. */
  const pendingFreezeView = () => ({
    state: 'STOP_RECORDED', diagnosis: 'incomplete', lifecycle: { stopAttestation: STOP_ATTESTATION },
    journal: { events: [
      { kind: 'START_INTENT', eventDigest: oldStartDigest },
      { kind: 'START_COMMIT', eventDigest: 'b'.repeat(64) },
      { kind: 'STOP_RECORDED', eventDigest: stopDigest },
      { kind: 'FREEZE_INTENT', eventDigest: freezeDigest },
    ] },
  });

  const stateRefusal = (error) => error instanceof CommandError && error.category === 'state';

  test('the unique old START intent with its matching commit refuses even when the view is incomplete for another reason', () => {
    /* A unique START_INTENT exists AND its START_COMMIT matches, so the START
     * route is closed while the FREEZE is the pending operation: every
     * wrong-operation binding refuses whatever else the reader found. */
    for (const diagnosis of ['incomplete', 'inconsistent']) {
      const view = { ...pendingFreezeView(), diagnosis };
      for (const [operation, eventDigest] of [['START', oldStartDigest], ['STOP', stopDigest]])
        assert.throws(() => bindRecoveryIntent({ operation, intentDigest: eventDigest }, view),
          stateRefusal, `${operation} over the ${diagnosis} view with a pending freeze is the state refusal`);
      /* The one binding with authority on this view is the FREEZE itself. */
      assert.doesNotThrow(() => bindRecoveryIntent({ operation: 'FREEZE', intentDigest: freezeDigest }, view),
        'the pending FREEZE binding remains permitted over the same view');
    }
  });

  test('the healthy consistent view accepts no binding of its own journaled intent', () => {
    /* The scope distinction the packet asks to state: check 3 proved the real
     * end-to-end no-op over a healthy closed journal; this view states the same
     * rule at the policy layer — a consistent diagnosis is refused before any
     * event matching happens. */
    const healthy = { state: 'RUNNING', diagnosis: 'consistent', lifecycle: { stopAttestation: null },
      journal: { events: [{ kind: 'START_INTENT', eventDigest: oldStartDigest }] } };
    assert.throws(() => bindRecoveryIntent({ operation: 'START', intentDigest: oldStartDigest }, healthy),
      stateRefusal, 'the old intent over the healthy journal is the state refusal');
  });
});
