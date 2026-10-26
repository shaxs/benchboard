/**
 * Independent real-subprocess acceptance for the connected manual lifecycle commands
 * (task packet C6.S4.T3).
 *
 * These tests invoke the actual executable `cli/benchboard.mjs` through a shell-free,
 * bounded `spawnSync` against freshly initialised external run containers. They prove
 * the production path end to end: the thin adapters (`cli/manual-commands.mjs`), the
 * pure mapper (`cli/manual-arguments.mjs`), the Captain-owned summary projection
 * (`cli/lifecycle-summary.mjs`) and the accepted C3 lifecycle through `adapters/manual`.
 * They are acceptance, not production implementation, and they install no test-only
 * runtime hook: the CLI process gets no clock or collaborator override, inherits
 * the normal process environment and runs from an external fixture directory.
 *
 * Contract facts asserted here come from the task packet:
 * - success: exit 0, empty stderr, exactly one JSON summary line (never a raw result
 *   object or a journal); errors: empty stdout, the fixed CLI_* code and exit, no stack
 *   or private-text leakage;
 * - a declared ceiling is recorded, never enforced, and no agent process is ever started;
 * - zero elapsed is reported as 0 and unknown elapsed as null; neither is coerced;
 * - an interrupted start is diagnosed, never byte-repaired, and a status read never
 *   steals or releases a lock held by another writer;
 * - (C6.S4.T5) the pure mapper bounds its inputs before any run is opened: the
 *   operator is 2 through 256 characters and the harness label at most 128 and the
 *   model label at most 512 characters, so an over-bound value is a usage refusal
 *   (exit 2 CLI_USAGE) with no value echo; the contract text in
 *   `cli/command-contract.mjs` states these same bounds. A start that restates a
 *   different declaration after a committed start is a state refusal (exit 3
 *   CLI_STATE, the DECLARATION_ALREADY_BOUND route) and the captured declaration
 *   stands unchanged in the stored record.
 *
 * Every path is passed as one argv element (the fixture roots contain spaces), so a
 * split path cannot masquerade as several arguments.
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
import { capabilities } from '../../adapters/manual/index.mjs';
import { withRunTransaction, startRun, stopRun } from '../../adapters/manual/index.mjs';
import { initialiseRun } from '../../packages/core/init.mjs';
import { createId, inventoryTree } from '../../packages/core/identity.mjs';
import { createStorage } from '../../packages/core/storage.mjs';

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
 * A fresh external root whose name contains a space, with an initialised run whose
 * name also contains a space, from the exact small fixture pattern of
 * `context-security.test.mjs`: a test-owned source carrying exactly the manifest
 * entries, then `initialiseRun` with the real identities, `harness: 'manual'` and
 * `dependencies: { mode: 'none' }`. Cleaned up on test completion.
 */
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-manual-cli probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 }));
  const installation = loadInstallation();
  /* C2 requires an exact source tree, not the prepared owner starter directory. */
  const sourceRoot = path.join(root, 'canonical source'); fs.mkdirSync(sourceRoot);
  for (const relative of installation.challenge.fileManifest) {
    const target = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(installation.challenge.sourceRoot, relative), target);
  }
  const run = await initialiseRun({
    output: path.join(root, 'run with spaces'),
    challenge: { ...installation.challenge, sourceRoot },
    toolingIdentity: installation.toolingIdentity,
    evaluatorIdentity: installation.evaluatorIdentity,
    architectureId: createId('manual-cli'), harness: 'manual', dependencies: { mode: 'none' },
  });
  return { root, run, opened: await openSelectedRun(run.output) };
}

/** Digest over a whole container or workspace: the complete file inventory, folded. */
const treeDigest = (root) => inventoryTree({ root, skipNames: [] }).digest;
/** The complete file inventory (paths, sizes and digests) of one container. */
const treeInventory = (root) => inventoryTree({ root, skipNames: [] }).entries;

/* --------------------------------------------------------------------------- */
/* Subprocess helpers                                                            */
/* --------------------------------------------------------------------------- */

/**
 * Invoke the actual entrypoint as one argv array (never through a shell), from the
 * external fixture root as the working directory. Every array element is one argument.
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

/** The summary key schema the Captain projection states. */
const SUMMARY_KEYS = Object.freeze(['command', 'runId', 'manifestId', 'state', 'diagnosis',
  'findingCount', 'guidance', 'startedAt', 'stoppedAt', 'elapsedMs', 'declaration',
  'stopAssurance', 'stopEnforced', 'clockError', 'attempts']);

/**
 * A success: exit 0, empty stderr, exactly one JSON summary line (a summary, not a raw
 * result object or a journal dump) carrying exactly the stated schema keys.
 */
function parseSummary(result, label) {
  assert.equal(result.status, 0, `${label}: success exits with status 0; stderr ${JSON.stringify(result.stderr)}`);
  assert.equal(trimmed(result.stderr), '', `${label}: success writes nothing to stderr`);
  const lines = trimmed(result.stdout).split('\n');
  assert.equal(lines.length, 1, `${label}: success writes exactly one line, got ${lines.length}`);
  const summary = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(summary).sort(), [...SUMMARY_KEYS].sort(),
    `${label}: the line is the stated summary schema, not a raw result or journal`);
  assert.ok(!Object.hasOwn(summary, 'journal') && !Object.hasOwn(summary, 'findings'),
    `${label}: the summary excludes the journal and raw finding strings`);
  return summary;
}

/**
 * A refusal: exit with the fixed category code, empty stdout, and one controlled
 * `CLI_*: guidance` stderr line with no stack frames. `forbidden` carries the private
 * canary values (declared model, operator, conflicting harness) that must not appear.
 */
function parseRefusal(result, label, exitCode, code, forbidden = []) {
  assert.equal(result.status, exitCode,
    `${label}: refusal exits ${exitCode}; got ${result.status}, stderr ${JSON.stringify(result.stderr)}`);
  assert.equal(trimmed(result.stdout), '', `${label}: a refusal writes nothing to stdout`);
  const firstLine = trimmed(result.stderr).split('\n')[0] ?? '';
  assert.ok(CONTROLLED_CLI_LINE.test(firstLine),
    `${label}: stderr is one controlled coded line; got ${JSON.stringify(firstLine)}`);
  assert.ok(firstLine.startsWith(`${code}: `),
    `${label}: stderr carries the fixed code ${code}; got ${JSON.stringify(firstLine)}`);
  assert.equal(trimmed(result.stderr).split('\n').length, 1, `${label}: exactly one stderr line`);
  assert.ok(!result.stderr.includes('\n    at '), `${label}: no stack dump`);
  for (const secret of forbidden)
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret),
      `${label}: the controlled diagnostic does not echo the private value ${JSON.stringify(secret)}`);
  return firstLine;
}

/** One CLI invocation of one lifecycle command against the fixture's run container. */
const runCli = (f, argv) => invoke(f.root, [...argv, '--run', f.run.output]);

/* Shared controlled-fixture values (synthetic, never personal). */
const FULL_DECLARATION = Object.freeze({
  harness: 'manual', model: null, workerCount: null, executionMode: 'MANUAL', declaredCeilingMinutes: null,
});
const FULL_ATTESTATION = Object.freeze({
  operator: 'synthetic-operator', agentStopped: true,
  statement: 'Controlled protocol fixture; no participant process ran.',
});

/* Over-bound label canaries for the mapper bounds the contract states (128 harness,
 * 512 model): one character past each accepted bound, distinct private values. */
const HARNESS_OVER_BOUND = `synthetic-harness-${'x'.repeat(111)}`;   /* 129 characters */
const MODEL_OVER_BOUND = `synthetic-model-${'y'.repeat(497)}`;   /* 513 characters */
assert.equal(HARNESS_OVER_BOUND.length, 129);
assert.equal(MODEL_OVER_BOUND.length, 513);

/* --------------------------------------------------------------------------- */
/* Check 1 — normal production start / status / stop                             */
/* --------------------------------------------------------------------------- */

describe('manual commands — check 1: real start/status/stop production cycle', () => {
  test('the full cycle records the stated facts, binds no results root and touches no workspace byte', async t => {
    const f = await fixture(t);
    const resultsDefault = `${f.run.output}.benchboard-results`;
    const resultsBinding = path.join(f.run.output, '.benchboard', 'cli', 'results.json');
    const workspaceBefore = treeDigest(f.run.workspace.root);

    /* Before start: the derived INITIALIZED view with a consistent diagnosis. */
    let summary = parseSummary(runCli(f, ['status']), 'status before start');
    assert.equal(summary.command, 'status');
    assert.equal(summary.state, 'INITIALIZED');
    assert.equal(summary.diagnosis, 'consistent');
    assert.equal(summary.findingCount, 0);
    assert.equal(summary.guidance, null);
    assert.equal(summary.elapsedMs, null);
    assert.equal(summary.declaration, null);
    assert.deepEqual(summary.attempts, []);
    assert.equal(summary.runId, f.opened.runId);
    assert.equal(summary.manifestId, f.opened.manifestId);
    /* A manual status read creates no results binding on either side. */
    assert.equal(fs.existsSync(resultsDefault), false, 'the default sibling results root is not created');
    assert.equal(fs.existsSync(resultsBinding), false, 'the run-side cli/results binding is not created');

    /* Start with the stated declarations. The recorded values are exactly stated. */
    summary = parseSummary(runCli(f, ['start', '--model', 'synthetic-model',
      '--worker-count', '2', '--declared-ceiling-minutes', '5']), 'start');
    assert.equal(summary.command, 'start');
    assert.equal(summary.state, 'RUNNING');
    assert.deepEqual(summary.declaration, {
      harness: 'manual', model: 'synthetic-model', workerCount: 2,
      executionMode: 'MANUAL', declaredCeilingMinutes: 5,
    });
    assert.ok(typeof summary.startedAt === 'string', 'a start records its instant');

    /* Stop is an operator attestation with no enforcement of any kind. */
    const stopSummary = parseSummary(runCli(f, ['stop', '--operator', 'synthetic-operator',
      '--agents-stopped']), 'stop');
    assert.equal(stopSummary.state, 'STOP_RECORDED');
    assert.equal(stopSummary.stopAssurance, 'operator-attested');
    assert.equal(stopSummary.stopEnforced, false);
    const recordedElapsed = stopSummary.elapsedMs;
    assert.ok(Number.isInteger(recordedElapsed) && recordedElapsed >= 0,
      `the default host clock yields a known elapsed >= 0, got ${JSON.stringify(recordedElapsed)}`);

    /* Status returns the same recorded state and the same recorded elapsed. */
    summary = parseSummary(runCli(f, ['status']), 'status after stop');
    assert.equal(summary.state, 'STOP_RECORDED');
    assert.equal(summary.elapsedMs, recordedElapsed);
    assert.equal(summary.stoppedAt, stopSummary.stoppedAt);
    assert.equal(summary.startedAt, stopSummary.startedAt);
    assert.equal(summary.stopAssurance, 'operator-attested');
    assert.equal(summary.stopEnforced, false);
    assert.equal(summary.clockError, null);

    /* The workspace bytes are unchanged through the whole cycle, and still no binding. */
    assert.equal(treeDigest(f.run.workspace.root), workspaceBefore,
      'start/status/stop leave every workspace byte unchanged');
    assert.equal(fs.existsSync(resultsDefault), false);
    assert.equal(fs.existsSync(resultsBinding), false);

    /* The manual path the CLI drives states no process control at any seam. */
    assert.equal(capabilities.processControl, false);
    assert.equal(capabilities.halt, false);
  });
});

/* --------------------------------------------------------------------------- */
/* Check 2 — refusals before a change, and the immutable declaration             */
/* --------------------------------------------------------------------------- */

describe('manual commands — check 2: refusal codes, no byte movement, controlled diagnostics', () => {
  test('every refusal class reports its fixed code while the complete run inventory stands still', async t => {
    const f = await fixture(t);
    const canary = ['conflicting-harness', 'synthetic-operator', 'synthetic-model'];
    /**
     * Snapshot, invoke the refused command, then prove the complete run inventory
     * is unchanged. `extraForbidden` carries per-case private canary values (for
     * example an over-bound label) on top of the shared ones.
     */
    const refused = (argv, exitCode, code, label, extraForbidden = []) => {
      const before = { digest: treeDigest(f.run.output), inventory: treeInventory(f.run.output) };
      const firstLine = parseRefusal(runCli(f, argv), label, exitCode, code, canary.concat(extraForbidden));
      assert.equal(treeDigest(f.run.output), before.digest, `${label}: the run digest is unchanged`);
      assert.deepEqual(treeInventory(f.run.output), before.inventory,
        `${label}: the complete run file inventory is unchanged`);
      return firstLine;
    };

    /* Usage refusals before any change: an invalid worker count, then a missing stop flag. */
    refused(['start', '--worker-count', '0'], 2, 'CLI_USAGE', 'start --worker-count 0');
    refused(['stop', '--operator', 'synthetic-operator'], 2, 'CLI_USAGE', 'stop without --agents-stopped');
    /* A supplied operator shorter than the accepted 2-character bound is a usage
     * refusal (the mapper refuses before any run is opened). The single stderr line
     * is exactly the fixed usage guidance: no canary echo, no stack. */
    /* (The child's command is `stop --run <selected run> --operator x
     * --agents-stopped`; runCli appends the selected run itself.) */
    const shortOperatorLine = refused(['stop', '--operator', 'x',
      '--agents-stopped'], 2, 'CLI_USAGE', 'stop with a one-character operator');
    assert.equal(shortOperatorLine, `${CATEGORIES.usage.code}: ${CATEGORIES.usage.guidance}`,
      'the too-short-operator refusal is the one controlled usage-guidance line');
    /* Over-bound labels are usage refusals from the pure mapper before a run is
     * opened: accepted bounds are 128 for the harness and 512 for the model, so a
     * 129-character harness and a 513-character model each exit 2 with no echo of
     * the supplied value and no byte movement. A valid-length harness that merely
     * conflicts with the accepted manifest keeps its state refusal (the case
     * below), which is a different fault at a different seam. */
    refused(['start', '--harness', HARNESS_OVER_BOUND], 2, 'CLI_USAGE',
      'start with a 129-character harness', [HARNESS_OVER_BOUND]);
    refused(['start', '--model', MODEL_OVER_BOUND], 2, 'CLI_USAGE',
      'start with a 513-character model', [MODEL_OVER_BOUND]);
    /* A harness that conflicts with the accepted manifest refuses with the state code. */
    refused(['start', '--harness', 'conflicting-harness'], 3, 'CLI_STATE', 'start with a conflicting harness');
    /* A stop before any start is a state refusal. */
    refused(['stop', '--operator', 'synthetic-operator', '--agents-stopped'], 3, 'CLI_STATE', 'stop before start');

    /* The declaration becomes immutable with a committed start: a second start, and a
     * second stop, are state refusals that leave every byte where it was. */
    parseSummary(runCli(f, ['start', '--model', 'synthetic-model']), 'accepted start');
    /* A restated start carrying a different model value exercises the bound-declaration
     * route (DECLARATION_ALREADY_BOUND in the lifecycle): a state refusal, and the
     * captured declaration keeps the originally stated model. */
    refused(['start', '--model', 'other-model'], 3, 'CLI_STATE',
      'start restating a different model after the declaration was bound', ['other-model']);
    const boundStatus = parseSummary(runCli(f, ['status']), 'status over the bound declaration');
    assert.equal(boundStatus.state, 'RUNNING');
    assert.equal(boundStatus.declaration.model, 'synthetic-model',
      'the stored declaration still reports the originally bound model');
    /* An identical restatement of the bound declaration is refused through the
     * already-started transition instead, with the same controlled outcome. */
    refused(['start', '--model', 'synthetic-model'], 3, 'CLI_STATE', 'second start after a committed start');
    parseSummary(runCli(f, ['stop', '--operator', 'synthetic-operator', '--agents-stopped']), 'accepted stop');
    refused(['stop', '--operator', 'synthetic-operator', '--agents-stopped'], 3, 'CLI_STATE', 'second stop after a stop');
  });
});

/* --------------------------------------------------------------------------- */
/* Check 3 — real persisted timing values through controlled C3 clock records    */
/* --------------------------------------------------------------------------- */

describe('manual commands — check 3: persisted zero and unknown elapsed reach the real CLI', () => {
  /* These fixtures are written with explicitly controlled C3 clock records through
   * the public startRun/stopRun, so the CLI reports genuine persisted values rather
   * than host-clock measurements. This is not a CLI clock hook. */
  const clockRun = async (t, clock) => {
    const f = await fixture(t);
    await startRun({ ...f.opened.request, clock, declaration: FULL_DECLARATION });
    await stopRun({ ...f.opened.request, clock, attestation: FULL_ATTESTATION });
    return f;
  };

  test('a controlled equal-instant pair is reported as a real 0, never coerced to null', async t => {
    const f = await clockRun(t, { now: () => 1_777_000_000_000 });
    const summary = parseSummary(runCli(f, ['status']), 'status over the zero-elapsed record');
    assert.equal(summary.state, 'STOP_RECORDED');
    assert.equal(summary.elapsedMs, 0, 'the persisted zero is reported as 0, not null');
    assert.ok(typeof summary.startedAt === 'string' && typeof summary.stoppedAt === 'string');
    assert.equal(summary.stoppedAt, summary.startedAt);
    assert.equal(summary.clockError, null);
    assert.deepEqual(summary.declaration, FULL_DECLARATION);
  });

  test('a controlled clock that reports nothing is reported as null, never coerced to 0', async t => {
    const f = await clockRun(t, { now: () => null });
    const summary = parseSummary(runCli(f, ['status']), 'status over the unknown-elapsed record');
    assert.equal(summary.state, 'STOP_RECORDED');
    assert.equal(summary.elapsedMs, null, 'the unknown elapsed is reported as null, not 0');
    assert.equal(summary.startedAt, null);
    assert.equal(summary.stoppedAt, null);
    assert.equal(summary.clockError, null);
    assert.equal(summary.stopAssurance, 'operator-attested');
    assert.equal(summary.stopEnforced, false);
  });
});

/* --------------------------------------------------------------------------- */
/* Check 4 — interrupted-start diagnosis and an occupied container lock           */
/* --------------------------------------------------------------------------- */

describe('manual commands — check 4: interrupted start is diagnosed, locks are neither stolen nor released', () => {
  test('a journaled intent without a commit is reported as incomplete, repairs nothing and blocks a start', async t => {
    const f = await fixture(t);
    /* The controlled interruption: append the intent through the public transaction seam
     * and deliberately commit no state, leaving exactly what a torn start would leave. */
    await withRunTransaction(f.opened.request,
      (context) => context.appendEvent({ kind: 'START_INTENT', declaration: FULL_DECLARATION }));

    const before = treeDigest(f.run.output);
    const summary = parseSummary(runCli(f, ['status']), 'status over the interrupted start');
    assert.equal(summary.diagnosis, 'incomplete');
    assert.ok(typeof summary.guidance === 'string' && summary.guidance.length > 0,
      'the incomplete diagnosis carries fixed, nonempty guidance');
    assert.match(summary.guidance, /reconcil/i, 'the guidance names the explicit reconciliation route');
    assert.ok(Number.isInteger(summary.findingCount),
      `the finding count is a known number, got ${JSON.stringify(summary.findingCount)}`);
    parseRefusal(runCli(f, ['start', '--model', 'synthetic-model']),
      'start over the interrupted start', 3, 'CLI_STATE');
    assert.equal(treeDigest(f.run.output), before,
      'the status read and the refused start leave every stored byte where it was: no byte repair');
  });

  test('a status run against a held container lock refuses and neither steals nor releases the lock', async t => {
    const f = await fixture(t);
    const holder = createStorage({ root: f.run.state.root });
    let otherRejected = null;
    await holder.withLock(async () => {
      /* The child sees the held lock as a controlled state refusal with no stack. */
      parseRefusal(runCli(f, ['status']), 'status against the held lock', 3, 'CLI_STATE');
      /* The lock is still the holder's: an independent second storage instance over the
       * same root is rejected before the holder releases it. */
      const challenger = createStorage({ root: f.run.state.root });
      await assert.rejects(challenger.withLock(async () => 'acquired'),
        (error) => error.code === 'ERR_STORAGE_LOCK_CONFLICT',
        'the child run did not steal or release the existing lock');
      otherRejected = 'ERR_STORAGE_LOCK_CONFLICT';
      return 'released by the holder only';
    });
    assert.equal(otherRejected, 'ERR_STORAGE_LOCK_CONFLICT');
    /* After the legitimate holder releases its own lock, the run reads normally again. */
    const summary = parseSummary(runCli(f, ['status']), 'status after the holder released');
    assert.equal(summary.state, 'INITIALIZED');
    assert.equal(summary.diagnosis, 'consistent');
  });
});
