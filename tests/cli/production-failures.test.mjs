/**
 * Real production missing-prerequisite proofs (task packet C6.S11.T2 rework 2).
 *
 * Two slow proofs run the actual production CLI (`cli/benchboard.mjs`) over a real
 * initialized-and-clockless-frozen run created through the Captain-supplied
 * `production-fixture.mjs` helpers, and one fast contract check (run by name by the
 * worker) validates the frozen case plan and its explicit limitations without
 * launching anything. Handled cancellation is NOT here: it moved to the separate
 * C6.S11.T5 proof.
 *
 * What the two slow proofs establish:
 * 1. A child-only `PLAYWRIGHT_BROWSERS_PATH` naming a test-owned nonexistent
 *    directory (the owner environment and any owner browser cache are not changed)
 *    drives the real C4 preflight into the infrastructure category: exit 5, empty
 *    stdout and the fixed `CATEGORIES.infrastructure` stderr line. The retained
 *    bookkeeping then carries the known returned evaluation identity with a null
 *    report in both the execution and terminal records, the attempt output root
 *    is never created, the store has no reports or commits directory, and the
 *    actual `status` command exposes the same known identity with no fabricated
 *    quality. Workspace, snapshot and canonical-starter inventories stand still.
 * 2. A copied installation built with the accepted installation-boundaries
 *    copiedInstallation pattern — every node_modules/.git/dist subtree filtered,
 *    plus the single allowed `runner/files.mjs` utility for imports, with a
 *    root-level junction to the original libraries for MODULE RESOLUTION ONLY and
 *    no `starter/node_modules` junction — must present byte-identical
 *    tooling/challenge/evaluator identity records before use, because copying may
 *    not silently change authority. Running the copy's own `cli/benchboard.mjs`
 *    against the original run then fails at the staging dependency scan with the
 *    infrastructure category; production staging scans the prepared dependency
 *    root and checks the three tool entrypoints BEFORE creating the evaluation
 *    output root, so this route leaves no output directory and no committed report.
 *
 * Explicit limitations (also encoded in the fast contract below): these are
 * production-integration evidence, not quality-zero claims — a missing prerequisite
 * is an infrastructure condition, and unknowns remain null. The child-only
 * environment value and the copy junction are private test control, never owner
 * environment, cache or installation changes. The copy's init/freeze route stays on
 * the original installation (init from a copy beneath the OS temp parent correctly
 * refuses source/temp overlap); this proof never bypasses that. No runtime,
 * collaborator or handler is injected, and nothing here proves OS-signal delivery,
 * host-wide process census, Windows durability or sandbox qualification.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInstallation } from '../../cli/installation.mjs';
import { CATEGORIES } from '../../cli/command-error.mjs';
import { invokeProduction, productionInputs, productionAttempt, createProductionRun } from './production-fixture.mjs';

/** One controlled CLI stderr line: the fixed code, the fixed guidance, nothing else. */
const CONTROLLED_INFRASTRUCTURE_LINE = `${CATEGORIES.infrastructure.code}: ${CATEGORIES.infrastructure.guidance}`;

/** A test deadline generous for a real (refusing) production evaluation child. */
const CHILD_BOUND_MS = 120_000;
const TEST_DEADLINE_MS = 600_000;

/**
 * File-local copy of the accepted installation-boundaries copiedInstallation
 * pattern (that module keeps its own helper private). Every node_modules, .git
 * and dist subtree is filtered; nothing outside the accepted selection — no
 * reference sources, private histories or solutions — is copied.
 */
function copiedInstallation(installed, parentRoot) {
  const root = fs.mkdtempSync(path.join(parentRoot, 'copied installation '));
  for (const relative of ['cli', 'packages', 'schemas', 'release', 'starter', 'fixtures', 'evaluator', 'adapters/manual']) {
    fs.cpSync(path.join(installed.root, relative), path.join(root, relative), { recursive: true,
      filter: source => !['node_modules', '.git', 'dist'].includes(path.basename(source)) });
  }
  for (const relative of ['package.json', 'package-lock.json', 'version.json']) {
    fs.copyFileSync(path.join(installed.root, relative), path.join(root, relative));
  }
  /* The historical runner contributed exactly one allowed utility module; no
   * governed runner code is copied. */
  fs.mkdirSync(path.join(root, 'runner'));
  fs.copyFileSync(path.join(installed.root, 'runner', 'files.mjs'), path.join(root, 'runner', 'files.mjs'));
  /* Reuse prepared dependencies solely for module resolution at the copy root;
   * this is never a starter/node_modules junction. */
  const link = path.join(root, 'node_modules');
  fs.symlinkSync(path.join(installed.root, 'node_modules'), link, process.platform === 'win32' ? 'junction' : 'dir');
  // The caller explicitly unlinks this test-owned junction in its own finally,
  // before its body returns and fixture root cleanup can start; no hook order assumption.
  return root;
}

/* =========================================================================== */
/* Fast contract — the frozen proof plan and its explicit limitations          */
/* =========================================================================== */

describe('production failure proofs', () => {
  test('production failure proof contract', () => {
    const plan = Object.freeze({
      entrypoint: 'cli/benchboard.mjs (shell-free spawnSync through the Captain helper)',
      fixture: 'tests/cli/production-fixture.mjs — real CLI init --dependency-mode none and explicit clockless freeze',
      cases: Object.freeze([
        Object.freeze({
          name: 'missing browser',
          control: 'child-only PLAYWRIGHT_BROWSERS_PATH naming a test-owned nonexistent directory',
          outcome: Object.freeze({ exitCode: 5, stdout: '', stderr: CONTROLLED_INFRASTRUCTURE_LINE }),
          state: Object.freeze({
            executionEvaluatorExecution: 'INFRASTRUCTURE_ERROR', terminalStatus: 'INFRASTRUCTURE',
            evaluationId: 'the returned C4 identity, retained', reportId: null, reportDigest: null,
            outputRootCreated: false, storeReportsOrCommits: false, statusFabricatedQuality: false,
          }),
        }),
        Object.freeze({
          name: 'missing prepared dependencies',
          control: 'the copy has no starter/node_modules; the copy-root node_modules junction is module resolution only',
          precondition: 'copied toolingIdentity/challenge.identity/evaluatorIdentity equal the original before use',
          outcome: Object.freeze({ exitCode: 5, stdout: '', stderr: CONTROLLED_INFRASTRUCTURE_LINE }),
          state: 'same known-identity/no-report/no-output shape as the missing-browser case',
        }),
      ]),
      limitations: Object.freeze([
        'handled cancellation is proven separately in the C6.S11.T5 file, not here',
        'a missing prerequisite is an infrastructure condition, not a quality-zero claim',
        'child-only environment values and the copy junction are private test control, not owner environment, cache or installation changes',
        'init/freeze stay on the original installation; init from a temp-contained copy refuses source/temp overlap and is not bypassed',
        'no runtime, collaborator or public handler injection exists or is used',
        'no OS-signal delivery, host-wide process census, Windows durability or sandbox qualification is claimed',
      ]),
    });
    assert.equal(plan.entrypoint.startsWith('cli/benchboard.mjs'), true);
    assert.equal(plan.cases.length, 2);
    for (const one of plan.cases) {
      assert.equal(one.outcome.exitCode, CATEGORIES.infrastructure.exitCode);
      assert.equal(one.outcome.stderr, `${CATEGORIES.infrastructure.code}: ${CATEGORIES.infrastructure.guidance}`);
      assert.equal(one.outcome.stdout, '');
    }
    assert.equal(CATEGORIES.infrastructure.exitCode, 5);
    assert.equal(plan.limitations.length, 6);
    /* Launching nothing is the point of this check: the file's slow children only
     * start inside their own test bodies. */
  });

  /* ===================================================================== */
  /* Slow proof 1 — real run, child-only missing browser                    */
  /* ===================================================================== */

  test('a child-only missing browser is the infrastructure category with retained known state and no output',
    { timeout: TEST_DEADLINE_MS }, async t => {
      const f = await createProductionRun(t);
      const before = productionInputs(f);
      const missingBrowsers = path.join(f.root, 'nonexistent browsers');
      assert.equal(fs.existsSync(missingBrowsers), false,
        'the child-only browsers path is test-owned and must not already exist');

      /* SUBPROCESS: the real entrypoint with the child-only environment copy. */
      const result = invokeProduction(f.root, ['evaluate', '--run', f.runRoot], {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: missingBrowsers }, timeout: CHILD_BOUND_MS });
      assert.equal(result.status, 5, `infrastructure refusal exits 5; stderr was ${JSON.stringify(result.stderr)}`);
      assert.equal(result.stdout, '', 'a refusal writes nothing to stdout');
      assert.equal(result.stderr.trimEnd(), CONTROLLED_INFRASTRUCTURE_LINE,
        'the stderr is exactly the fixed infrastructure code and guidance');

      /* LABEL: in-process accepted reads of the retained bookkeeping. */
      const { context, attempt } = await productionAttempt(f);
      assert.match(attempt.execution.evaluationId, /^eval-[a-f0-9-]{36}$/,
        'the execution record retains the returned evaluation identity as a known value');
      assert.equal(attempt.execution.evaluatorExecution, 'INFRASTRUCTURE_ERROR');
      assert.equal(attempt.execution.reportId, null);
      assert.equal(attempt.terminal.status, 'INFRASTRUCTURE');
      assert.equal(attempt.terminal.evaluationId, attempt.execution.evaluationId,
        'the terminal record carries the same known evaluation identity');
      assert.equal(attempt.terminal.reportId, null);
      assert.equal(attempt.terminal.reportDigest, null);
      assert.equal(fs.existsSync(attempt.start.outputRoot), false,
        'the preflight refusal created no attempt output directory');
      assert.equal(fs.existsSync(path.join(context.storeRoot, 'reports')), false);
      assert.equal(fs.existsSync(path.join(context.storeRoot, 'commits')), false);

      /* SUBPROCESS: the actual status command exposes the same known identity. */
      const status = invokeProduction(f.root, ['status', '--run', f.runRoot]);
      assert.equal(status.status, 0, `status read failed: ${JSON.stringify(status.stderr)}`);
      const view = JSON.parse(status.stdout.trimEnd());
      assert.equal(view.attempts.length, 1);
      assert.equal(view.attempts[0].attemptId, attempt.start.attemptId);
      assert.equal(view.attempts[0].status, 'INFRASTRUCTURE');
      assert.equal(view.attempts[0].evaluationId, attempt.terminal.evaluationId);
      assert.equal(view.attempts[0].reportId, null, 'status reports no report and no fabricated quality');
      assert.equal(view.attempts[0].reportDigest, null);

      assert.equal(fs.existsSync(missingBrowsers), false, 'the CLI created no browsers root');
      assert.deepEqual(productionInputs(f), before,
        'workspace, snapshots and the canonical starter stand byte-identical');
    });

  /* ===================================================================== */
  /* Slow proof 2 — copied installation without starter/node_modules        */
  /* ===================================================================== */

  test('a copied installation missing the prepared dependencies refuses before creating any output',
    { timeout: TEST_DEADLINE_MS }, async t => {
      const f = await createProductionRun(t);
      const installed = loadInstallation();
      const copy = copiedInstallation(installed, f.root);
      const before = productionInputs(f);
      try {
      const { chromium } = await import('@playwright/test');
      assert.equal(fs.statSync(chromium.executablePath()).isFile(), true,
        'the missing-dependencies case has the real installed browser prerequisite');
      assert.equal(fs.existsSync(path.join(copy, 'starter', 'node_modules')), false,
        'the accepted filter removed every node_modules subtree, including the prepared starter dependencies');

      /* The copy must carry the same authority before it is ever used. */
      const copyModule = await import(pathToFileURL(path.join(copy, 'cli', 'installation.mjs')).href);
      const copied = copyModule.loadInstallation();
      assert.notEqual(copied.root, installed.root, 'the copy is a distinct root on purpose');
      assert.deepEqual(copied.toolingIdentity, installed.toolingIdentity);
      assert.deepEqual(copied.challenge.identity, installed.challenge.identity);
      assert.deepEqual(copied.evaluatorIdentity, installed.evaluatorIdentity);

      /* SUBPROCESS: the copy's own entrypoint over the original frozen run, with
       * the ordinary existing browser environment (no override) and the default
       * sibling results root. The absence of the copied prepared dependencies
       * refuses at the staging dependency scan, which runs before staging creates
       * the evaluation output root. */
      const result = invokeProduction(f.root, ['evaluate', '--run', f.runRoot], {
        entrypoint: path.join(copy, 'cli', 'benchboard.mjs'), timeout: CHILD_BOUND_MS });
      assert.equal(result.status, 5, `infrastructure refusal exits 5; stderr was ${JSON.stringify(result.stderr)}`);
      assert.equal(result.stdout, '', 'a refusal writes nothing to stdout');
      assert.equal(result.stderr.trimEnd(), CONTROLLED_INFRASTRUCTURE_LINE,
        'the stderr is exactly the fixed infrastructure code and guidance');

      /* Same retained known/no-report shape as the missing-browser proof. */
      const { context, attempt } = await productionAttempt(f);
      assert.match(attempt.execution.evaluationId, /^eval-[a-f0-9-]{36}$/,
        'the execution record retains the returned evaluation identity as a known value');
      assert.equal(attempt.execution.evaluatorExecution, 'INFRASTRUCTURE_ERROR');
      assert.equal(attempt.execution.reportId, null);
      assert.equal(attempt.terminal.status, 'INFRASTRUCTURE');
      assert.equal(attempt.terminal.evaluationId, attempt.execution.evaluationId);
      assert.equal(attempt.terminal.reportId, null);
      assert.equal(attempt.terminal.reportDigest, null);
      assert.equal(fs.existsSync(attempt.start.outputRoot), false,
        'the dependency-scan refusal happened before the output root was created');
      assert.equal(fs.existsSync(path.join(context.storeRoot, 'reports')), false);
      assert.equal(fs.existsSync(path.join(context.storeRoot, 'commits')), false);

      const status = invokeProduction(f.root, ['status', '--run', f.runRoot]);
      assert.equal(status.status, 0);
      assert.equal(status.stderr, '');
      const view = JSON.parse(status.stdout.trimEnd());
      assert.equal(view.attempts[0].evaluationId, attempt.execution.evaluationId);
      assert.equal(view.attempts[0].status, 'INFRASTRUCTURE');
      assert.equal(view.attempts[0].reportId, null);
      assert.equal(view.attempts[0].reportDigest, null);
      assert.deepEqual(productionInputs(f), before,
         'workspace, snapshots and the canonical starter stand byte-identical');
      } finally {
        const link = path.join(copy, 'node_modules');
        fs.unlinkSync(link);
        assert.equal(fs.existsSync(link), false, 'remove only the resolution junction before fixture cleanup');
      }
    });
});
