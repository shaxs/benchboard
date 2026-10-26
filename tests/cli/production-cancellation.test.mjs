/**
 * Real production handled-cancellation proof (task packet C6.S11.T5, rework 2).
 *
 * One slow proof runs the actual production CLI through the original module entry
 * (`cli/application.mjs`, imported by a test-owned inline child wrapper via
 * `pathToFileURL` in argv — never a runtime, handler, module, signal or evaluator
 * collaborator override) over a real initialized-and-clockless-frozen run created
 * through the Captain-supplied `production-fixture.mjs` helpers. One fast contract
 * check (run by name by the worker) validates a frozen file-local proof plan and its
 * explicit limitations without launching anything or reading any workspace prose.
 *
 * What the slow proof establishes: while a real evaluation has staged into its real
 * typecheck stage, a parent IPC message makes the child's own control listener emit
 * SIGINT into the listener actually installed by `cli/application.mjs`; the real
 * AbortSignal reaches the real C4 controller, which cancels and awaits its bounded
 * cleanup. The child exits 130 with empty stdout and the exactly fixed cancelled
 * stderr category, and the retained bookkeeping carries the known returned
 * evaluation identity with a null report on both the execution and terminal axes.
 *
 * Explicit limitations (also encoded and asserted in the fast contract below): the
 * cancellation is deliberately IPC-triggered listener emission, NOT physical
 * operating-system signal delivery, and nothing here proves OS-signal delivery,
 * Windows durability, host-wide process census, descendant cleanup across unrelated
 * processes or sandbox qualification. A deadline kill or unrelated early failure is
 * a test failure and can never be relabelled as a handled cancellation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createProductionRun, productionInputs, productionAttempt, invokeProduction,
  successSummary, PRODUCTION_REPO } from './production-fixture.mjs';
import { CATEGORIES } from '../../cli/command-error.mjs';

/** The exactly fixed controlled stderr line of a cancelled production command. */
const CONTROLLED_CANCELLED_LINE = `${CATEGORIES.cancelled.code}: ${CATEGORIES.cancelled.guidance}`;

/** The test-level bound is 600 s; the real child's own hard deadline is at most 180 s. */
const TEST_DEADLINE_MS = 600_000;
const CHILD_DEADLINE_MS = 180_000;
/** Fixed child output cap and the last-resort bail-out after a kill in finally. */
const OUTPUT_CAP_BYTES = 1_048_576;
const AFTER_KILL_BAILOUT_MS = 30_000;

/* =========================================================================== */
/* Fast contract — the frozen file-local proof plan and its limitations        */
/* =========================================================================== */

test('production cancellation proof contract', () => {
  /* The frozen declared plan is file-local on purpose: public npm test must not
   * depend on gitignored private workspace prose, and this check launches
   * nothing (the slow proof starts only inside its own test body). */
  const plan = Object.freeze({
    entrypoint: 'cli/application.mjs — the original module entry imported by the inline child wrapper through pathToFileURL argv, calling the actual main([evaluate, --run, runRoot])',
    fixture: 'tests/cli/production-fixture.mjs — real CLI init --dependency-mode none and explicit clockless freeze, plus accepted attempt reads',
    control: 'a parent IPC message makes the child\'s own control listener emit SIGINT into the listener actually installed by cli/application.mjs after real production staging begins: listener → AbortSignal → real C4 cleanup',
    outcome: Object.freeze({ exitCode: 130, stdout: '', stderr: CONTROLLED_CANCELLED_LINE }),
    state: Object.freeze({
      executionEvaluatorExecution: 'INFRASTRUCTURE_ERROR', executionReportId: null,
      terminalStatus: 'CANCELLED', evaluationId: 'the returned C4 identity, known and shared by execution and terminal',
      reportId: null, reportDigest: null,
      storePublications: false, scratchDirectories: false,
      inventories: 'workspace, snapshots and canonical starter remain exactly hash-equal',
      locks: 'no live storage lock file remains',
    }),
    limitations: Object.freeze([
      'the cancellation is IPC-triggered emission into the installed listener, NOT physical operating-system signal delivery',
      'killing the owned child on a deadline, or any unrelated early failure, is a test failure and can never be relabelled a handled cancellation',
      'no host-wide process census, Windows durability, crash or sandbox qualification is claimed',
      'no runtime, main, handler, module, signal or evaluator collaborator is overridden or injected',
    ]),
  });
  assert.equal(plan.control.includes('listener → AbortSignal → real C4 cleanup'), true,
    'the frozen plan still names the listener-to-AbortSignal-to-cleanup route');
  assert.equal(plan.control.includes('NOT physical operating-system signal delivery') ||
    plan.limitations.some(text => text.includes('NOT physical operating-system signal delivery')), true,
    'the frozen plan states the explicit OS-signal limitation');
  assert.equal(plan.outcome.exitCode, 130);
  assert.equal(plan.state.executionEvaluatorExecution, 'INFRASTRUCTURE_ERROR');
  assert.equal(plan.state.executionReportId, null);
  assert.equal(plan.state.terminalStatus, 'CANCELLED');
  assert.equal(plan.state.reportId, null);
  assert.equal(plan.state.reportDigest, null);
  assert.equal(plan.outcome.stderr, CONTROLLED_CANCELLED_LINE);
  assert.equal(CATEGORIES.cancelled.exitCode, 130);
  assert.equal(CATEGORIES.cancelled.code, 'CLI_CANCELLED');
  assert.equal(CATEGORIES.cancelled.guidance,
    'Cancellation handled; cleanup was awaited. Check status and retained local evidence before retrying.');
});

/* =========================================================================== */
/* Slow proof — real staged evaluation, parent-IPC-listened cancellation       */
/* =========================================================================== */

test('a parent-IPC cancellation of a real staged evaluation awaits real C4 cleanup and records a cancelled terminal with a null report',
  { timeout: TEST_DEADLINE_MS }, async t => {
    const f = await createProductionRun(t);
    const before = productionInputs(f); // full hash entries captured before the child starts
    const resultsRoot = `${f.runRoot}.benchboard-results`; // cli/results-context.mjs default root

    /* Test-only shell-free inline wrapper: it imports the ORIGINAL cli/application.mjs
     * through the fixed pathToFileURL of the app path given in argv and awaits the real
     * main with normal sinks. Its IPC control listener emits SIGINT only after the
     * parent control message. No runtime, main, handler, module, signal or evaluator
     * collaborator is overridden. The wrapper disconnects its OWN IPC channel after the
     * awaited result so no listener holds it open. */
    const childArgs = ['--input-type=module', '-e', `
      const [appPath, runRoot] = process.argv.slice(1, 3);
      const { main } = await import((await import('node:url')).pathToFileURL(appPath).href);
      process.on('message', () => { process.emit('SIGINT'); });
      const code = await main(['evaluate', '--run', runRoot]);
      process.exitCode = code;
      if (process.connected) process.disconnect(); // the child's own IPC channel only
    `, path.join(PRODUCTION_REPO, 'cli/application.mjs'), f.runRoot];

    const child = spawn(process.execPath, childArgs, {
      cwd: f.root, shell: false, windowsHide: true, env: process.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    /* Completion promise attached immediately after spawn: 'close' (after stdio has
     * fully ended, so stream capture is complete) or an 'error' event both settle it,
     * so an early completion or spawn error is observed instantly. */
    let spawnError = null, closeCode = null, closeSignal = null;
    child.on('error', error => { spawnError = error; });
    const childCompletion = new Promise(resolve =>
      child.once('close', (code, signal) => { closeCode = code; closeSignal = signal; resolve(); }));

    const collect = { stdout: '', stderr: '' };
    let capOverflowed = false;
    for (const [key, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        if (collect[key].length + chunk.length > OUTPUT_CAP_BYTES) capOverflowed = true;
        collect[key] = (collect[key] + chunk).slice(0, OUTPUT_CAP_BYTES);
      });
    }

    /* One fixed kill/deadline timer: only the owned child may be killed, and reaching
     * the deadline marks the run a failure, never a successful cancellation. */
    let deadlineHit = false;
    const killIfLive = () => {
      if (child.exitCode === null && child.signalCode === null && !child.killed) {
        try { child.kill(); } catch { /* already gone */ }
      }
    };
    const deadlineTimer = setTimeout(() => {
      deadlineHit = true;
      killIfLive();
      /* Reaching only through the completion promise; the asserts below keep the
       * original error and refuse to call this a cancellation. */
    }, CHILD_DEADLINE_MS);

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const observeControlSend = () => new Promise((resolve, reject) => {
      if (child.connected !== true) { reject(new Error('the evaluation child exited or disconnected before the control message; cancellation must be requested against a still-connected real evaluation')); return; }
      try { child.send('cancel', error => error ? reject(error) : resolve()); }
      catch (error) { reject(error); }
    });

    try {
      /* Real fs polling inside the test with a fixed deadline: observe the results
       * root's attempt output containing the actual typecheck stage directory, racing
       * short sleeps against the attached completion promise so an early exit, spawn
       * error or deadline kill is noticed immediately and can never be relabelled. */
      const attemptsRoot = path.join(resultsRoot, 'attempts');
      let sawStaging = false;
      while (!sawStaging) {
        const event = await Promise.race([sleep(25), childCompletion.then(() => 'completed')]);
        if (event === 'completed') {
          throw new Error(`the evaluation child completed or failed before staging observed (close code ${closeCode}, signal ${closeSignal ?? null}, stderr ${JSON.stringify(collect.stderr)}); an early unrelated failure times out this synchronization instead of being accepted as a handled cancellation`);
        }
        if (capOverflowed) throw new Error('the owned child output exceeded the fixed 1 MiB cap before staging was observed');
        if (spawnError !== null) throw spawnError;
        try {
          for (const entry of fs.readdirSync(attemptsRoot, { withFileTypes: true })) {
            const candidate = path.join(attemptsRoot, entry.name, 'typecheck');
            if (entry.isDirectory() && fs.lstatSync(candidate).isDirectory()) sawStaging = true;
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }

      /* Await the IPC send callback against the already-attached completion promise,
       * so a rapid exit racing the send is caught, never missed. */
      const sendOutcome = await Promise.race([observeControlSend(), childCompletion.then(() => 'completed')]);
      if (sendOutcome === 'completed') {
        throw new Error('the evaluation child exited between the staging observation and the control send; this early unrelated failure is not a handled cancellation');
      }

      /* Await the real child completion through the immediate completion promise. */
      await childCompletion;
      assert.equal(deadlineHit, false,
        'the child deadline expired and the owned child had to be killed; a timeout kill is a test failure, never a successful cancellation');

      /* Spawn error, output cap, and then the exact real outcome. */
      assert.equal(spawnError, null, 'the owned child must run without a spawn error');
      assert.equal(capOverflowed, false, 'the owned child output must stay inside the fixed 1 MiB cap');
      assert.equal(closeCode, 130,
        `the real process exit must be exactly 130 (close code ${closeCode}, signal ${closeSignal ?? null}, stderr ${JSON.stringify(collect.stderr)})`);
      assert.equal(closeSignal, null, 'a handled cancellation is a real normal exit, not a signal kill');
      assert.equal(collect.stdout, '', 'a cancelled evaluation must not print a success summary');
      assert.equal(collect.stderr, `${CONTROLLED_CANCELLED_LINE}\n`, 'main appends exactly one newline to its fixed diagnostic');
    } finally {
      /* Clear the one fixed timer, then await the owned child's completion: on any
       * failure path the still-live owned child is killed here and awaited, and the
       * original error is preserved (nothing is rethrown or relabelled in finally). */
      clearTimeout(deadlineTimer);
      killIfLive();
      let bailoutTimer;
      try {
        await Promise.race([childCompletion, new Promise(resolve => {
          bailoutTimer = setTimeout(resolve, AFTER_KILL_BAILOUT_MS);
          bailoutTimer.unref();
        })]);
      } finally { clearTimeout(bailoutTimer); }
    }

    /* Read the actual recorded attempt through the accepted helper, then verify the
     * execution and terminal identities: INFRASTRUCTURE_ERROR execution (never a
     * CANCELLED execution; the actual execution vocabulary is only
     * SUCCESS/INFRASTRUCTURE_ERROR), a known shared evaluation ID, terminal CANCELLED
     * and a null report on BOTH axes. */
    const { opened, context, attempt } = await productionAttempt(f);
    const evaluationId = attempt.execution.evaluationId;
    assert.equal(typeof evaluationId, 'string');
    assert.match(evaluationId, /^eval-[a-f0-9-]{36}$/, 'the retained evaluation identity is a known eval id');
    assert.equal(attempt.execution.evaluatorExecution, 'INFRASTRUCTURE_ERROR');
    assert.notEqual(attempt.execution.evaluatorExecution, 'CANCELLED');
    assert.equal(attempt.execution.reportId, null);
    assert.equal(attempt.terminal.status, 'CANCELLED');
    assert.equal(attempt.terminal.evaluationId, evaluationId);
    assert.equal(attempt.terminal.reportId, null);
    assert.equal(attempt.terminal.reportDigest, null);

    /* No C5 report or publication commit exists and no quality is fabricated anywhere. */
    assert.equal(fs.existsSync(path.join(context.storeRoot, 'reports')), false);
    assert.equal(fs.existsSync(path.join(context.storeRoot, 'commits')), false);

    /* After the real awaited cleanup, no scratch-* directories remain beneath the
     * attempt output root; ordinary retained logs/artifacts are allowed, so the
     * output directory itself may exist. */
    const leftovers = fs.readdirSync(attempt.start.outputRoot, { withFileTypes: true })
      .filter(entry => entry.name.startsWith('scratch-'));
    assert.deepEqual(leftovers, [], 'real C4 cleanup must have removed the scratch directories');

    /* Workspace, frozen snapshots and canonical starter inventories remain exactly hash-equal. */
    assert.deepEqual(productionInputs(f), before);

    /* No live storage lock file remains beneath either owned container root. */
    for (const root of [f.runRoot, resultsRoot]) {
      const lockFiles = [];
      const walk = at => {
        for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          const childPath = path.join(at, entry.name);
          if (entry.isDirectory()) walk(childPath);
          else if (entry.name === 'lock') lockFiles.push(childPath);
        }
      };
      walk(root);
      assert.deepEqual(lockFiles, [], `no live C1 storage lock file may remain under ${root}`);
    }

    /* The real manual status child reads the same recorded state: the same known
     * evaluation ID, the cancelled terminal and a null report. */
    const status = successSummary(invokeProduction(f.root, ['status', '--run', f.runRoot]));
    assert.equal(status.attempts.length, 1);
    const view = status.attempts[0];
    assert.equal(view.attemptId, attempt.start.attemptId);
    assert.equal(view.status, 'CANCELLED');
    assert.equal(view.evaluationId, evaluationId);
    assert.equal(view.reportId, null);
    assert.equal(view.reportDigest, null);
    assert.equal(view.publicationIntent.evaluationId, evaluationId);
    assert.equal(view.publicationIntent.evaluatorExecution, 'INFRASTRUCTURE_ERROR');
    assert.equal(view.publicationIntent.reportId, null);
  });
