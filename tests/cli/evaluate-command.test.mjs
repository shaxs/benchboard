/**
 * Independent real evaluation refusal and no-output infrastructure proof
 * (task packet C6.S6.T4).
 *
 * Every behavior the packet states as a command behavior is asserted against a
 * real shell-free `spawnSync` of `cli/benchboard.mjs` (working directory: the
 * external fixture root, timeout 15000, maxBuffer 1048576) built from the real
 * installed identities through `realRunFixture`. The only environment change is
 * a CHILD-ONLY `PLAYWRIGHT_BROWSERS_PATH` pointing at a guaranteed nonexistent
 * TEST-OWNED path — no browser or dependency is installed or removed, and the
 * owner environment is not changed. In-process calls appear only at labelled
 * places: accepted reads of persisted state (`readResultsContext`,
 * `readEvaluationAttempts`) and the one direct production `evaluateCommand` call
 * the packet states (the pre-aborted proof in check 4). No public runtime or
 * collaborator injection exists or is used.
 *
 * The missing-browser proof intentionally refuses at the C4 preflight, BEFORE
 * any browser/server/staging tool can run. Real success, mid-evaluation SIGINT
 * and cancellation delivery are separately scheduled (S11) and are NOT claimed
 * here; no OS process census is performed or claimed.
 *
 * Contract facts asserted here come from the task packet:
 * - refusals: empty stdout, one fixed `CLI_*: guidance` stderr line, no private
 *   path/canary/stack echo, and the workspace/snapshot inventories stand still;
 * - an unfrozen run is the state category with the fixed status/freeze guidance,
 *   and the evaluate command never automatically freezes and (on that route)
 *   never creates the results binding or the default companion root;
 * - invalid timeout/output bounds are usage refusals raised before the selected
 *   run is opened, so a nonexistent run combined with bad bounds is still usage;
 * - a real frozen run with the child missing-browser env exits infrastructure5
 *   with no quality/success stdout, while the returned C4 evaluationId (fresh,
 *   and its output directory never created) and a null report are bound in the
 *   execution record (`evaluatorExecution: INFRASTRUCTURE_ERROR`) and the terminal
 *   record (`status: INFRASTRUCTURE`, null reportId/reportDigest); no committed
 *   baseline marker exists in the C5 store;
 * - repeats carry distinct attemptId/outputRoot/evaluationId, both retained
 *   diagnosis records stay readable, status reports both attempts with no
 *   implicit latest and no fabricated report/quality; a foreign lock is never
 *   stolen; a conflicting results override refuses and its foreign target is
 *   never created; tests use only test-owned roots;
 * - a saved-byte tamper is the integrity category before any evaluation or
 *   default-results creation; a pre-aborted direct production `evaluateCommand`
 *   is cancelled/130 before state or output work.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realRunFixture } from './run-fixture.mjs';
import { openSelectedRun, readResultsContext } from '../../cli/run-context.mjs';
import { readEvaluationAttempts } from '../../cli/attempt-records.mjs';
import { evaluateCommand } from '../../cli/evaluate-command.mjs';
import { CATEGORIES } from '../../cli/command-error.mjs';
import { CommandError } from '../../cli/command-error.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const entrypoint = path.join(repositoryRoot, 'cli', 'benchboard.mjs');

/* Bounds so a hung or chatty child cannot outlive the test run. */
const SPAWN_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 1_048_576;

/** One stderr line shaped `CLI_CODE: guidance`, and nothing else. */
const CONTROLLED_CLI_LINE = /^CLI_[A-Z0-9_]+: \S[^\n]*$/;

/** A child-only, test-owned, guaranteed nonexistent browsers root. */
const MISSING_BROWSERS = path.join(os.tmpdir(), 'bb-t4-absent-browsers-root');
assert.equal(fs.existsSync(MISSING_BROWSERS), false,
  'the child browsers-path value must not exist and must not be created by this test');

/** Synthetic canaries that no controlled diagnostic may echo. */
const CANARY = Object.freeze(['synthetic-model', 'synthetic-operator', 'synthetic-explicit-model']);

const trimmed = (text) => text.replace(/\r\n/g, '\n').trimEnd();

/* --------------------------------------------------------------------------- */
/* Fixtures and subprocess helpers (the actual production CLI, never a stub)     */
/* --------------------------------------------------------------------------- */

/**
 * SUBPROCESS: invoke the actual entrypoint as one argv array (never through a
 * shell), from the external fixture root as the working directory. The env is
 * passed only where the packet states the child-only missing-browser value.
 */
function invoke(cwd, argv, env = undefined) {
  const result = spawnSync(process.execPath, [entrypoint, ...argv], {
    encoding: 'utf8',
    shell: false,
    cwd,
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
    ...(env === undefined ? {} : { env }),
  });
  assert.equal(result.error, undefined,
    `the ${argv[0]} subprocess completed within its bound; got ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** SUBPROCESS: one evaluate invocation against one run container path. */
const evaluateOn = (cwd, runRoot, argv, env) =>
  invoke(cwd, ['evaluate', ...argv, '--run', runRoot], env);

/** SUBPROCESS: the same evaluate against the fixture's own run, child-only browser env. */
const evaluateFixture = (f, argv = []) => evaluateOn(f.root, f.run.output, argv, missingBrowserEnv());

const missingBrowserEnv = () => ({ ...process.env, PLAYWRIGHT_BROWSERS_PATH: MISSING_BROWSERS });
const defaultResultsRoot = (runRoot) => `${runRoot}.benchboard-results`;
const stateDir = (runRoot) => path.join(runRoot, '.benchboard');

/**
 * A real installed run (external root, spaced names) reached through the real
 * subprocess start/stop/freeze route, exactly as `freeze-reconcile.test.mjs`
 * proves that route (there the clockless stopped assertion is the accepted C3
 * route; here the recorded operator stop is the same accepted stopped route).
 * LABEL: fixture setup is the accepted core through `realRunFixture` plus
 * SUBPROCESS lifecycle commands; no test-only injection.
 */
async function frozenFixture(t) {
  const f = await realRunFixture(t);
  /* The `realRunFixture` manifest binds the model `synthetic-explicit-model`,
   * and the accepted start refuses a declaration that conflicts with the
   * manifest binding, so the start states the run's bound model. */
  const start = invoke(f.root, ['start', '--model', 'synthetic-explicit-model', '--worker-count', '2',
    '--declared-ceiling-minutes', '5', '--run', f.run.output]);
  assert.equal(start.status, 0, `fixture start: ${JSON.stringify(start)}`);
  const stop = invoke(f.root, ['stop', '--operator', 'synthetic-operator', '--agents-stopped',
    '--run', f.run.output]);
  assert.equal(stop.status, 0, `fixture stop: ${JSON.stringify(stop)}`);
  const freeze = invoke(f.root, ['freeze', '--run', f.run.output]);
  assert.equal(freeze.status, 0, `fixture freeze: ${JSON.stringify(freeze)}`);
  const summary = JSON.parse(trimmed(freeze.stdout).split('\n')[0]);
  return { ...f, snapshotId: summary.snapshotId };
}

/** The snapshot-identity pattern (the frozen fixture reads its real one). */
const ABSENT_SNAPSHOT = 'snap-' + 'a'.repeat(32);

/**
 * A refusal: empty stdout, one fixed controlled `CLI_*: guidance` line, the
 * fixed code prefix, no stack frames and no echo of the canaries or the extra
 * forbidden values.
 */
function parseRefusal(result, label, exitCode, code, extraForbidden = []) {
  assert.equal(result.status, exitCode,
    `${label}: refusal exits ${exitCode}; got ${result.status}, stderr ${JSON.stringify(result.stderr)}`);
  assert.equal(result.stdout, '', `${label}: a refusal writes nothing to stdout`);
  const lines = trimmed(result.stderr).split('\n');
  assert.equal(lines.length, 1, `${label}: exactly one stderr line, got ${JSON.stringify(result.stderr)}`);
  assert.ok(CONTROLLED_CLI_LINE.test(lines[0]),
    `${label}: stderr is one controlled coded line; got ${JSON.stringify(lines[0])}`);
  assert.ok(lines[0].startsWith(`${code}: `),
    `${label}: stderr carries the fixed code ${code}; got ${JSON.stringify(lines[0])}`);
  assert.ok(!result.stderr.includes('\n    at ') && !result.stderr.includes('\n\tat '),
    `${label}: no stack dump`);
  for (const secret of CANARY.concat(extraForbidden))
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret),
      `${label}: the controlled diagnostic does not echo ${JSON.stringify(secret)}`);
  return lines[0];
}

/** Byte inventories of the parts of the run container the evaluation may not move. */
function treeEntries(root) {
  return fs.existsSync(root) ? inventoryTree({ root, skipNames: [] }).entries : [];
}
function protectedInventories(runRoot) {
  return {
    workspace: treeEntries(path.join(runRoot, 'workspace')),
    snapshots: treeEntries(path.join(runRoot, 'snapshots')),
  };
}

/** The status keys exactly as the Captain's lifecycle projection emits them. */
const STATUS_KEYS = Object.freeze(['command', 'runId', 'manifestId', 'state', 'diagnosis',
  'findingCount', 'guidance', 'startedAt', 'stoppedAt', 'elapsedMs', 'declaration',
  'stopAssurance', 'stopEnforced', 'clockError', 'attempts']);

/* =========================================================================== */
/* Check 1a — unfrozen state refusal, bounds-before-run-access, grammar and      */
/* containement refusals, all before any evaluation work                         */
/* =========================================================================== */

describe('evaluate check 1a: unfrozen run, bounds and grammar refusals before any evaluation work', () => {
  test('an INITIALIZED run is a state refusal with freeze guidance; no binding, companion or automatic freeze', async t => {
    const f = await realRunFixture(t);
    const before = protectedInventories(f.run.output);

    /* SUBPROCESS: the plain evaluate over the untouched INITIALIZED run. */
    const line = parseRefusal(evaluateFixture(f), 'evaluate over INITIALIZED', 3, 'CLI_STATE');
    assert.equal(line, `CLI_STATE: ${CATEGORIES.state.guidance}`,
      'the state refusal carries the fixed guidance text');
    assert.match(CATEGORIES.state.guidance, /status/i, 'the guidance points at status');
    assert.match(CATEGORIES.state.guidance, /frozen/i, 'the guidance points at freezing explicitly');

    /* Never an automatic freeze: the persisted state is still INITIALIZED and
     * no submission exists. SUBPROCESS read of the same production projection. */
    const status = invoke(f.root, ['status', '--run', f.run.output]);
    assert.equal(status.status, 0, `status read: ${JSON.stringify(status)}`);
    const view = JSON.parse(trimmed(status.stdout).split('\n')[0]);
    assert.deepEqual(Object.keys(view).sort(), [...STATUS_KEYS].sort(), 'the status summary schema stands');
    assert.equal(view.state, 'INITIALIZED', 'evaluate refused instead of freezing the run');
    assert.equal(view.attempts.length, 0, 'no attempt bookkeeping was created on this refusal route');

    /* No results binding in the state root and never the default companion. */
    assert.equal(fs.existsSync(path.join(stateDir(f.run.output), 'cli', 'results.json')), false,
      'the refusal route created no results binding');
    assert.equal(fs.existsSync(defaultResultsRoot(f.run.output)), false,
      'the refusal route created no default results companion root');

    /* The workspace and snapshot bytes stand exactly still. */
    assert.deepEqual(protectedInventories(f.run.output), before,
      'the refused evaluate moved no workspace or snapshot byte');

    /* An explicit snapshot identity the run does not carry is the same state
     * category (the selection, not the browser, refuses). */
    parseRefusal(evaluateFixture(f, ['--snapshot', ABSENT_SNAPSHOT]),
      'evaluate with an absent snapshot identity', 3, 'CLI_STATE');

    /* Invalid timeout/output bounds are grammar refusals raised before the
     * selected run is opened: with a nonexistent run combined with bad bounds
     * the result is usage2, not a run/state complaint. */
    for (const [flag, value] of [['--timeout-ms', '0'], ['--timeout-ms', '4000000'],
      ['--timeout-ms', '1o'], ['--max-output-bytes', '10'], ['--max-output-bytes', '20000000']]) {
      parseRefusal(evaluateOn(f.root, path.join(f.root, 'no such run'), [flag, value],
        missingBrowserEnv()), `bad bound ${flag}=${value} with a nonexistent run`, 2, 'CLI_USAGE',
        ['no such run']);
    }
    /* Alone, the same nonexistent run is the state category (bounds passed):
     * the ordering proof is the usage2 result above, not this line. */
    parseRefusal(evaluateOn(f.root, path.join(f.root, 'no such run'), [], missingBrowserEnv()),
      'nonexistent run with valid bounds', 3, 'CLI_STATE', ['no such run']);

    /* A malformed snapshot spelling is the usage category before any
     * evaluation work (the accepted grammar is snap- plus 32 lowercase hex;
     * selection grammar is validated when the selection is projected). */
    parseRefusal(evaluateFixture(f, ['--snapshot', 'snap-not-a-real-id']),
      'malformed snapshot identity', 2, 'CLI_USAGE', ['snap-not-a-real-id']);

    /* Linked run root: the containement boundary refuses a link-named run root
     * through the real entrypoint (skipped where the host disallows creating
     * the link). */
    const linkPath = path.join(f.root, 'link-named run root');
    let linkCreated = false;
    try { fs.symlinkSync(f.run.output, linkPath, 'junction'); linkCreated = true; }
    catch { /* the host disallows link creation for this user */ }
    if (linkCreated) {
      parseRefusal(evaluateOn(f.root, linkPath, [], missingBrowserEnv()),
        'evaluate through a link-named run root', 4, 'CLI_INTEGRITY');
    }

    /* Lexical traversal spellings of the very same run normalize and reach the
     * same state refusal — the path is checked after normalization, so no
     * traversal form unlocks a different target. */
    parseRefusal(evaluateOn(f.root, path.join(f.run.output, 'snapshots', '..', 'workspace', '..'),
      [], missingBrowserEnv()), 'traversal-spelled run root', 3, 'CLI_STATE');

    assert.deepEqual(protectedInventories(f.run.output), before,
      'every refusal above moved no workspace or snapshot byte');
  });
});

/* =========================================================================== */
/* Check 1b — snapshot grammar on a real frozen run                              */
/* =========================================================================== */

describe('evaluate check 1b: snapshot grammar before run access on a real frozen run', () => {
  test('a malformed snapshot is usage2 before the frozen run is opened', async t => {
    const f = await frozenFixture(t);
    const before = protectedInventories(f.run.output);
    parseRefusal(evaluateFixture(f, ['--snapshot', 'snap-NO0TREAL']),
      'malformed snapshot over a frozen run', 2, 'CLI_USAGE', ['NO0TREAL']);
    assert.deepEqual(protectedInventories(f.run.output), before,
      'the grammar refusal moved no workspace or snapshot byte');
  });
});

/* =========================================================================== */
/* Check 2 — real frozen run + child missing browser: infrastructure5, no output */
/* =========================================================================== */

describe('evaluate check 2: missing-browser infrastructure refusal carries the known evaluation and no output', () => {
  test('exit5, no success/quality stdout, bound records with the returned evaluationId, null report, no committed baseline', async t => {
    const f = await frozenFixture(t);
    const before = protectedInventories(f.run.output);

    /* SUBPROCESS: the real frozen run with the child-only missing-browser env.
     * The C4 preflight refuses before staging or any browser/server tool can
     * run. */
    const result = evaluateFixture(f);
    parseRefusal(result, 'evaluate with a missing browser', 5, 'CLI_INFRASTRUCTURE',
      [f.run.output, MISSING_BROWSERS]);
    assert.match(CATEGORIES.infrastructure.guidance, /score/i,
      'the infrastructure guidance states that no score or completion is implied');

    /* LABEL: in-process accepted reads of the actual bound context and attempts. */
    const opened = await openSelectedRun(f.run.output);
    const context = await readResultsContext(opened);
    assert.ok(context !== null, 'the evaluate run bound its results context');
    assert.equal(context.resultsRoot, defaultResultsRoot(f.run.output),
      'the default companion root is the bound results root');
    const attempts = await readEvaluationAttempts(opened, context);
    assert.equal(attempts.length, 1, `one attempt stands, got ${attempts.length}`);
    const attempt = attempts[0];

    /* Terminal status INFRASTRUCTURE with the known fresh evaluation ID and
     * null report/digest. */
    assert.equal(attempt.terminal.status, 'INFRASTRUCTURE');
    assert.match(attempt.terminal.evaluationId, /^eval-[a-f0-9-]{36}$/,
      'the returned C4 evaluation identity is retained even though its output directory never exists');
    assert.equal(attempt.terminal.reportId, null, 'no report was planned or produced');
    assert.equal(attempt.terminal.reportDigest, null, 'no report digest was invented');

    /* The execution record binds the returned status/ID and a null report, and
     * records the evaluator execution as INFRASTRUCTURE_ERROR. */
    assert.ok(attempt.execution != null, 'the execution (publication-intent) record exists');
    assert.equal(attempt.execution.evaluatorExecution, 'INFRASTRUCTURE_ERROR');
    assert.equal(attempt.execution.evaluationId, attempt.terminal.evaluationId,
      'the execution record binds the returned evaluation identity');
    assert.equal(attempt.execution.reportId, null, 'the execution record binds the null report');

    /* The attempt output root was never created (no staging, no scratch). */
    assert.equal(fs.existsSync(attempt.start.outputRoot), false,
      'the C4 preflight refusal created no attempt output directory');

    /* The C5 store holds no committed baseline marker. */
    assert.equal(fs.existsSync(path.join(context.storeRoot, 'reports')), false,
      'no report was committed to the store');
    assert.equal(fs.existsSync(path.join(context.storeRoot, 'commits')), false,
      'no baseline commit marker exists');

    /* The saved snapshot and the workspace bytes stand still; the C4 preflight
     * read-only verification moved no byte. */
    assert.deepEqual(protectedInventories(f.run.output), before,
      'the missing-browser refusal moved no workspace or snapshot byte');

    /* The CLI binding file exists: the bookkeeping is real (the packet states
     * the evaluation may create its binding/attempt metadata), while the
     * protected bytes above did not move. */
    assert.equal(fs.existsSync(path.join(stateDir(f.run.output), 'cli', 'results.json')), true);
  });
});

/* =========================================================================== */
/* Check 3 — repeat, retained diagnosis, no latest, locks, override policy       */
/* =========================================================================== */

describe('evaluate check 3: repeats keep separate retained attempts, no latest, no lock stealing, bound override', () => {
  test('a second missing-browser run carries distinct identities and both records stay readable', async t => {
    const f = await frozenFixture(t);

    /* SUBPROCESS: first missing-browser evaluate. */
    parseRefusal(evaluateFixture(f), 'first evaluate', 5, 'CLI_INFRASTRUCTURE');

    /* LABEL: in-process accepted read of the first attempt. */
    let opened = await openSelectedRun(f.run.output);
    let context = await readResultsContext(opened);
    const first = (await readEvaluationAttempts(opened, context))[0];

    /* SUBPROCESS: the repeat with the same command carries a distinct attempt,
     * output root and evaluation identity, and refuses again. */
    parseRefusal(evaluateFixture(f), 'repeat evaluate', 5, 'CLI_INFRASTRUCTURE');
    opened = await openSelectedRun(f.run.output);
    context = await readResultsContext(opened);
    const attempts = await readEvaluationAttempts(opened, context);
    assert.equal(attempts.length, 2, 'both attempts are retained');
    const second = attempts.find((entry) => entry.start.attemptId !== first.start.attemptId);
    assert.ok(second != null, 'the repeat created a distinct attemptId');
    assert.notEqual(second.start.outputRoot, first.start.outputRoot,
      'the repeat carries a distinct per-attempt output root');
    assert.notEqual(second.terminal.evaluationId, first.terminal.evaluationId,
      'the repeat carries a distinct evaluation identity');
    for (const entry of [first, second]) {
      assert.equal(entry.terminal.status, 'INFRASTRUCTURE',
        'both retained diagnosis records report the infrastructure terminal status');
      assert.equal(entry.terminal.reportId, null, 'neither attempt carries a report');
      assert.equal(entry.terminal.reportDigest, null);
      assert.equal(entry.execution.reportId, null);
      assert.ok(fs.existsSync(path.join(context.resultsRoot, 'cli-attempts',
        entry.start.attemptId, 'terminal.json')));
      assert.ok(fs.existsSync(path.join(context.resultsRoot, 'cli-attempts',
        entry.start.attemptId, 'execution.json')));
      assert.equal(fs.existsSync(entry.start.outputRoot), false,
        'neither preflight refusal created its attempt output directory');
    }
    assert.equal(fs.existsSync(path.join(context.storeRoot, 'reports')), false,
      'no report or quality was fabricated for either attempt');

    /* SUBPROCESS: the status read shows both separate attempts, no implicit
     * latest and no fabricated report/quality. */
    const status = invoke(f.root, ['status', '--run', f.run.output]);
    assert.equal(status.status, 0, status.stderr);
    const view = JSON.parse(trimmed(status.stdout).split('\n')[0]);
    assert.deepEqual(view.attempts.map((entry) => entry.status).sort(),
      ['INFRASTRUCTURE', 'INFRASTRUCTURE'], 'status reports the two infrastructure attempts');
    assert.ok(view.attempts.every((entry) => typeof entry.evaluationId === 'string' &&
      entry.evaluationId.length > 0), 'each attempt reports its own known evaluation identity');
    assert.equal(new Set(view.attempts.map((entry) => entry.evaluationId)).size, 2,
      'the two attempts keep distinct evaluation identities');
    assert.ok(view.attempts.every((entry) => entry.reportId === null && entry.reportDigest === null),
      'no report or digest is claimed for either attempt');
    assert.ok(!JSON.stringify(view).includes('SUCCEEDED'), 'nothing is reported as succeeded');
    const summaryText = JSON.stringify(view);
    assert.ok(!/latest/i.test(summaryText), 'the summary carries no latest selection or field');

    /* No lock stealing: a foreign storage lock left by another writer is
     * refused and retained byte-identical; the CLI neither removes it nor
     * repairs the run. (No-stealing retention is the accepted storage contract.) */
    const lockPath = path.join(context.resultsRoot, '.storage', 'lock');
    assert.equal(fs.existsSync(path.dirname(lockPath)), true,
      'the results root carries its accepted storage bookkeeping directory');
    fs.writeFileSync(lockPath, 'foreign-writer-keeps-this-lock\n', 'utf8');
    const lockBytes = fs.readFileSync(lockPath);
    parseRefusal(evaluateFixture(f), 'evaluate while the results lock is foreign-held',
      3, 'CLI_STATE');
    assert.deepEqual(fs.readFileSync(lockPath), lockBytes,
      'the CLI left the foreign lock exactly where it was and did not steal it');
    fs.rmSync(lockPath, { force: true });

    /* Explicit override binds once: the default root is already bound, so a
     * conflicting --results-root is a state refusal and its foreign target is
     * never created. */
    const foreignTarget = path.join(f.root, 'foreign results override');
    parseRefusal(evaluateFixture(f, ['--results-root', foreignTarget]),
      'conflicting results override', 3, 'CLI_STATE', ['foreign results override']);
    assert.equal(fs.existsSync(foreignTarget), false,
      'the conflicting override refused without creating its foreign target');

    /* LABEL: in-process accepted read — the bound context still names the
     * original default root after all of the above. */
    const finalContext = await readResultsContext(await openSelectedRun(f.run.output));
    assert.equal(finalContext.resultsRoot, defaultResultsRoot(f.run.output),
      'the single binding stands; the override never rebound it');
  });
});

/* =========================================================================== */
/* Check 4 — saved-byte tamper, pre-abort cancellation, containment               */
/* =========================================================================== */

describe('evaluate check 4: tamper and pre-abort refuse before evaluation or default-results creation', () => {
  test('a tampered snapshot byte is integrity4 with no results creation, and a pre-aborted command is cancelled130 before state work', async t => {
    /* SUBPROCESS: saved-byte tamper through the same production selection the
     * evaluate command uses (the snapshot byte check fails, not the folder). */
    const f = await frozenFixture(t);
    const snapshotFile = path.join(f.run.output, 'snapshots', f.snapshotId, 'workspace', 'package.json');
    fs.writeFileSync(snapshotFile, 'tampered snapshot byte\n', 'utf8');
    parseRefusal(evaluateFixture(f), 'evaluate over a tampered snapshot', 4, 'CLI_INTEGRITY');
    assert.equal(fs.existsSync(defaultResultsRoot(f.run.output)), false,
      'the integrity refusal created no default results root');
    assert.equal(fs.existsSync(path.join(stateDir(f.run.output), 'cli', 'results.json')), false,
      'the integrity refusal created no results binding');

    /* A pre-aborted direct production evaluateCommand refuses cancelled/130
     * before any state or output work. LABEL: direct production call the packet
     * states (not a subprocess); this is distinct from the real mid-evaluation
     * SIGINT delivery proof, which is separately scheduled (S11) and is not
     * simulated or claimed here, and no OS process census is taken. */
    const g = await realRunFixture(t);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      evaluateCommand({ '--run': g.run.output }, { signal: controller.signal }),
      (error) => error instanceof CommandError && error.category === 'cancelled' &&
        CATEGORIES.cancelled.exitCode === 130,
      'the pre-aborted command is the cancelled category (130) before state or output work');
    assert.equal(fs.existsSync(defaultResultsRoot(g.run.output)), false,
      'the pre-abort refusal created no default results root');
    assert.equal(fs.existsSync(path.join(stateDir(g.run.output), 'cli', 'results.json')), false,
      'the pre-abort refusal created no results binding');

    /* The already-committed-result rule (a late signal must not relabel a
     * committed result) needs a committed result; real success/cancellation
     * delivery is separately scheduled S11 and is deliberately NOT simulated
     * in this file. */

    /* Containment once more on the frozen route: a fresh results-root inside
     * the run container is the disjoint-root integrity refusal before any
     * evaluation or results creation, and its target is never created. */
    const h = await frozenFixture(t);
    const insideTarget = path.join(h.run.output, 'results-inside-run');
    parseRefusal(evaluateFixture(h, ['--results-root', insideTarget]),
      'fresh results-root inside the run root', 4, 'CLI_INTEGRITY');
    assert.equal(fs.existsSync(insideTarget), false,
      'the containment refusal created no in-run results target');
    assert.equal(fs.existsSync(path.join(stateDir(h.run.output), 'cli', 'results.json')), false,
      'the containment refusal created no results binding');
  });
});
