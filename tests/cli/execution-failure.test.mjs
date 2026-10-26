/**
 * Independent proof that a returned C4 infrastructure outcome is not relabeled
 * when the execution.json bookkeeping publication fails (task packet C6.S6.T6).
 *
 * Two real production routes run in-process against `evaluateCommand` itself,
 * on a real installed run with a real accepted clockless freeze
 * (`freezeRun`, the same accepted route `frozen-selection.test.mjs` uses):
 *
 *  1. BEFORE the execution.json immutable link: a test-local
 *     `fs/promises.link` interception (restored in `finally` through
 *     `syncBuiltinESMExports`, the accepted `terminal-fates.test.mjs` pattern)
 *     throws EIO. The real C4 preflight has already returned the missing-browser
 *     infrastructure outcome with a generated evaluation id before this fault,
 *     and the staged execution envelope carries it. The actual production
 *     `evaluateCommand` then rejects with the controlled storage publication
 *     failure (diagnostic infrastructure5), and the attempt keeps terminal
 *     null with no execution envelope on disk: no REFUSED and no INFRASTRUCTURE
 *     terminal is inferred from the bookkeeping IO error.
 *  2. AFTER the actual link: the interception calls the original link first and
 *     then throws. The handler preserves that error, manufactures no terminal
 *     and performs no retry or repair. The accepted `readEvaluationAttempts`
 *     reads verify the published execution (known evaluation id, null report,
 *     evaluatorExecution INFRASTRUCTURE_ERROR) despite the incomplete registry
 *     registration; the raw execution and registry bytes are unchanged across
 *     reads.
 *
 * The browser is made unavailable with a process-test-local, guaranteed
 * nonexistent `PLAYWRIGHT_BROWSERS_PATH` (saved and restored in `finally`;
 * `node --test` gives this file its own process). The playwright registry
 * module reads the variable once, at its first load, which is the lazy dynamic
 * import inside the C4 preflight, so setting it before the first
 * `evaluateCommand` call in this process takes effect. No browser, staging or
 * server runs: the preflight refuses before staging, and the tests assert the
 * attempt output root was never created.
 *
 * Shared invariants for both variants (check 3): the workspace and snapshot
 * byte inventories stand still, no evaluation output directory and no C5 report
 * marker exists, and the storage root lock is released normally (a later
 * writer acquires it; it was not stolen).
 *
 * Not claimed here and out of scope: a real success or CANCELLED outcome, OS
 * signal delivery, or the generic source guard — those are the scheduled S11
 * scope. No production runtime injection, owner-environment or cache change and
 * no code transformation is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { realRunFixture } from './run-fixture.mjs';
import { freezeRun } from '../../packages/core/freeze.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { StorageError, createStorage } from '../../packages/core/storage.mjs';
import { evaluateCommand } from '../../cli/evaluate-command.mjs';
import { readResultsContext } from '../../cli/run-context.mjs';
import { readEvaluationAttempts } from '../../cli/attempt-records.mjs';
import { diagnosticOf } from '../../cli/diagnostics.mjs';

/** A process-test-local, guaranteed nonexistent browsers root. */
const MISSING_BROWSERS = path.join(os.tmpdir(), 'bb-t6-absent-browsers-root');
assert.equal(fs.existsSync(MISSING_BROWSERS), false,
  'the browsers-path value must not exist and must not be created by this test');

/** Save/restore of the one environment variable the proof needs, test-local. */
function useMissingBrowserEnv() {
  const saved = Object.hasOwn(process.env, 'PLAYWRIGHT_BROWSERS_PATH')
    ? process.env.PLAYWRIGHT_BROWSERS_PATH : undefined;
  process.env.PLAYWRIGHT_BROWSERS_PATH = MISSING_BROWSERS;
  return () => {
    if (saved === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = saved;
  };
}

/** Byte inventories of the parts of the run container the evaluation may not move. */
function protectedInventories(runRoot) {
  const tree = (root) => fs.existsSync(root) ? inventoryTree({ root, skipNames: [] }).entries : [];
  return {
    workspace: tree(path.join(runRoot, 'workspace')),
    snapshots: tree(path.join(runRoot, 'snapshots')),
  };
}

/** The real accepted clockless freeze over the never-started fixture run. */
async function clocklessFreeze(f) {
  return freezeRun({ ...f.opened.request, clockless: true, attestation: {
    operator: 'synthetic-failure-operator', agentStopped: true, clockless: true,
    statement: 'Synthetic fixture explicitly attests a never-started stopped workspace.' } });
}

/**
 * Install the execution.json link fault through the accepted builtin-export
 * sync (the `terminal-fates.test.mjs` pattern). `afterLink` decides whether the
 * original link runs before the throw. Returns the capture state and a restorer.
 */
function installExecutionLinkFault({ afterLink, captureStaged }) {
  const original = fsp.link;
  const state = { intercepted: 0, target: null, staged: null };
  fsp.link = async function (source, destination, ...rest) {
    let result;
    if (afterLink) result = await original.call(this, source, destination, ...rest);
    if (path.basename(String(destination)) === 'execution.json') {
      state.intercepted += 1;
      state.target = String(destination);
      if (captureStaged) {
        // The staged envelope bytes still exist before the link; read the
        // returned-outcome fields the publication was carrying.
        try { state.staged = JSON.parse(fs.readFileSync(String(source), 'utf8')).value; }
        catch { /* the injected fault below is the point of this interception */ }
      }
      if (!afterLink) throw Object.assign(new Error('Synthetic pre-link execution publication fault'), { code: 'EIO' });
      throw Object.assign(new Error('Synthetic failure after the actual execution link'), { code: 'EIO' });
    }
    return afterLink ? result : original.call(this, source, destination, ...rest);
  };
  syncBuiltinESMExports();
  return { state, restore: () => { fsp.link = original; syncBuiltinESMExports(); } };
}

/**
 * The shared post-fault invariants (check 3): inventories still, no evaluation
 * output directory, no report marker in the C5 store, and the root lock
 * released and acquirable by a later writer (never stolen).
 */
async function assertSharedInvariants(f, before, label) {
  const context = await readResultsContext(f.opened);
  assert.deepEqual(protectedInventories(f.run.output), before,
    `${label}: the fault moved no workspace or snapshot byte`);
  assert.equal(fs.existsSync(path.join(context.storeRoot, 'reports')), false,
    `${label}: the fault published no C5 report marker`);
  assert.equal(fs.existsSync(path.join(context.resultsRoot, '.storage', 'lock')), false,
    `${label}: the storage root lock file was released`);
  const storage = createStorage({ root: context.resultsRoot });
  assert.equal(await storage.withLock(async () => 'acquired'), 'acquired',
    `${label}: a later writer acquires the released lock normally`);
  return context;
}

/* =========================================================================== */
/* Check 1 — fault before the execution.json link: no terminal is inferred      */
/* =========================================================================== */

test('pre-link execution publication fault: the returned C4 outcome stands, no terminal and no execution envelope', async t => {
  const f = await realRunFixture(t);
  const frozen = await clocklessFreeze(f);
  const before = protectedInventories(f.run.output);

  const { state, restore } = installExecutionLinkFault({ afterLink: false, captureStaged: true });
  const restoreEnv = useMissingBrowserEnv();
  let error = null;
  try {
    await evaluateCommand({ '--run': f.run.output, '--snapshot': frozen.snapshotId });
    assert.fail('the actual evaluateCommand must reject on the injected storage publish fault');
  } catch (caught) {
    error = caught;
  } finally {
    restore();
    restoreEnv();
  }

  // The actual production handler rejects with the controlled storage
  // publication failure kept from the bookkeeping write, diagnosed infrastructure5.
  assert.ok(error instanceof StorageError && error.code === 'ERR_STORAGE_PUBLISH_FAILED',
    `the original controlled storage publish failure is preserved; got ${error?.name}/${error?.code}`);
  assert.equal(diagnosticOf(error).exitCode, 5, 'the fault diagnoses infrastructure5');
  assert.equal(diagnosticOf(error).code, 'CLI_INFRASTRUCTURE');

  // The intercepted write was the execution.json publication, exactly once, and
  // the staged envelope it carried is the returned C4 missing-browser outcome
  // with its generated evaluation id.
  assert.equal(state.intercepted, 1, 'the fault was intercepted once, not a public runtime hook');
  const context = await readResultsContext(f.opened);
  assert.ok(state.target.startsWith(path.join(context.resultsRoot, 'cli-attempts') + path.sep),
    'the intercepted link targets the attempt execution record');
  assert.ok(state.staged !== null && typeof state.staged.evaluationId === 'string'
    && state.staged.evaluationId.startsWith('eval-'),
    'the real C4 had returned the infrastructure outcome with a generated evaluation id before the fault');
  assert.equal(state.staged.reportId, null);
  assert.equal(state.staged.evaluatorExecution, 'INFRASTRUCTURE_ERROR');

  // Pre-link failure: no execution envelope was published and no terminal was
  // inferred from the bookkeeping IO error — neither REFUSED nor INFRASTRUCTURE.
  const attempts = await readEvaluationAttempts(f.opened, context);
  assert.equal(attempts.length, 1);
  const attempt = attempts[0];
  assert.equal(attempt.terminal, null, 'no terminal is manufactured for the bookkeeping fault');
  assert.equal(attempt.execution, undefined, 'the pre-link failure published no execution envelope');
  const attemptDir = path.join(context.resultsRoot, 'cli-attempts', attempt.start.attemptId);
  assert.deepEqual(fs.readdirSync(attemptDir), ['start.json'],
    'the attempt directory holds only the start record; no terminal and no execution file');
  assert.equal(fs.existsSync(path.join(attemptDir, 'terminal.json')), false);
  assert.equal(fs.existsSync(path.join(attemptDir, 'execution.json')), false);
  assert.equal(fs.existsSync(attempt.start.outputRoot), false,
    'the accepted C4 missing-browser returned outcome is real but no stages ran');

  await assertSharedInvariants(f, before, 'pre-link');
});

/* =========================================================================== */
/* Check 2 — fault after the actual link: the published execution is verifiable  */
/* =========================================================================== */

test('after-link execution publication fault: the handler preserves it and accepted reads verify the published execution', async t => {
  const f = await realRunFixture(t);
  const frozen = await clocklessFreeze(f);
  const before = protectedInventories(f.run.output);

  const { state, restore } = installExecutionLinkFault({ afterLink: true, captureStaged: false });
  const restoreEnv = useMissingBrowserEnv();
  let error = null;
  try {
    await evaluateCommand({ '--run': f.run.output, '--snapshot': frozen.snapshotId });
    assert.fail('the actual evaluateCommand must reject on the injected after-link fault');
  } catch (caught) {
    error = caught;
  } finally {
    restore();
    restoreEnv();
  }

  // The handler preserves the original controlled storage publish failure and
  // runs no retry or repair of its own.
  assert.ok(error instanceof StorageError && error.code === 'ERR_STORAGE_PUBLISH_FAILED',
    `the original error is preserved; got ${error?.name}/${error?.code}`);
  assert.equal(diagnosticOf(error).exitCode, 5);
  assert.equal(state.intercepted, 1, 'exactly one execution link ran, then the fault');

  const context = await readResultsContext(f.opened);
  const registryPath = path.join(context.resultsRoot, '.storage', 'registry.json');
  const executionBytes = fs.readFileSync(state.target);
  const registryBytes = fs.readFileSync(registryPath);

  // The accepted read verifies the published execution despite the incomplete
  // registry registration: the known evaluation id, null report and
  // INFRASTRUCTURE_ERROR execution disposition are all in the published record.
  const first = await readEvaluationAttempts(f.opened, context);
  assert.equal(first.length, 1);
  const attempt = first[0];
  assert.equal(attempt.terminal, null, 'no terminal was manufactured and none is inferred');
  assert.ok(attempt.execution !== undefined, 'the accepted read verifies the published execution');
  assert.ok(attempt.execution.evaluationId.startsWith('eval-'), 'the returned evaluation id is known');
  assert.equal(attempt.execution.reportId, null);
  assert.equal(attempt.execution.evaluatorExecution, 'INFRASTRUCTURE_ERROR');

  // A second accepted read, with the raw bytes unchanged across both reads and
  // no automatic registry repair.
  const second = await readEvaluationAttempts(f.opened, context);
  assert.deepEqual(second.map(entry => entry.execution), [attempt.execution]);
  assert.deepEqual(fs.readFileSync(state.target), executionBytes,
    'the raw execution bytes are unchanged across the reads');
  assert.deepEqual(fs.readFileSync(registryPath), registryBytes,
    'the registry bytes are unchanged: no automatic repair occurred');

  assert.equal(fs.existsSync(path.join(path.dirname(state.target), 'terminal.json')), false);
  assert.equal(fs.existsSync(attempt.start.outputRoot), false,
    'no evaluation output was created; no stages ran');

  await assertSharedInvariants(f, before, 'after-link');
});
