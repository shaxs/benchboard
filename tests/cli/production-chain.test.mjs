/**
 * C6.S11.T1 rework2 — the actual normal-lifecycle production chain through two
 * real production evaluations and the unchanged-snapshot repeat.
 *
 * Every command is the actual shell-free bounded child that
 * `./production-fixture.mjs` invokes (cwd: the external spaced root, 1 MiB
 * output bound; each evaluate child carries its own explicit 600000 timeout).
 * The lifecycle leg is the NORMAL route through the real CLI — init with
 * dependency mode `none` into a fresh external container, an explicit start
 * declaration, an operator-attested stop and the plain stopped-route freeze —
 * never the helper's clockless fixture route, and the two evaluate calls run
 * the real production facade at default accepted bounds with no runtime
 * collaborator, browser override or environment opt-in. No participant agent,
 * no benchmark run, no reference-solution restoration, no dependency install,
 * no public runtime injection anywhere in this file; the canonical starter is
 * read-only and the packet's own hash capture excludes it from a full-tree
 * traverse. The fast contract check launches nothing.
 *
 * The independently authored post-evaluation helper completes actual safe exports,
 * synthetic UI protocol attachment and fresh reset within this same slow test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRODUCTION_REPO, PRODUCTION_CLI, invokeProduction, successSummary } from './production-fixture.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { openSelectedRun, readResultsContext } from '../../cli/run-context.mjs';
import { readEvaluationAttempts } from '../../cli/attempt-records.mjs';
import { readPublishedReport } from '../../packages/results/publication.mjs';
import { completeProductionChain } from './production-chain-reporting.mjs';

/** The one place the intended full production order is written down. */
const SYNTHETIC_UI_LABEL = 'synthetic UI protocol, not human judgment';
const RUN = '<run container>';
const EVAL = '<evaluation id>';
const REPORT = '<child report id>';
const OUT = '<fresh output>';
const INPUT = '<completed worksheet file>';
const REVIEW = '<existing review root>';
const PRODUCTION_PLAN = Object.freeze({
  entrypoint: 'cli/benchboard.mjs',
  label: SYNTHETIC_UI_LABEL,
  steps: Object.freeze([
    Object.freeze({ command: 'init', argv: Object.freeze(['init', '--dependency-mode', 'none', '--output', RUN]) }),
    Object.freeze({ command: 'start', argv: Object.freeze(['start', '--run', RUN, '--harness', 'manual',
      '--model', 'synthetic-production-model', '--worker-count', '1', '--declared-ceiling-minutes', '60']) }),
    Object.freeze({ command: 'stop', argv: Object.freeze(['stop', '--run', RUN, '--operator',
      'synthetic-production-operator', '--agents-stopped']) }),
    Object.freeze({ command: 'freeze', argv: Object.freeze(['freeze', '--run', RUN]) }),
    Object.freeze({ command: 'evaluate', argv: Object.freeze(['evaluate', '--run', RUN]) }),
    Object.freeze({ command: 'export', argv: Object.freeze(['export', '--run', RUN, '--evaluation', EVAL, '--output', OUT]) }),
    Object.freeze({ command: 'ui-template', argv: Object.freeze(['ui', '--run', RUN, '--template',
      '--evaluation', EVAL, '--output', OUT]) }),
    Object.freeze({ command: 'ui-attach', argv: Object.freeze(['ui', '--run', RUN, '--input', INPUT, '--review-root', REVIEW]) }),
    Object.freeze({ command: 'export-reviewed', argv: Object.freeze(['export', '--run', RUN, '--evaluation', EVAL, '--report', REPORT, '--output', OUT]) }),
    Object.freeze({ command: 'reset', argv: Object.freeze(['reset', '--run', RUN, '--output', OUT, '--dependency-mode', 'none']) }),
  ]),
});

/** Path/hash pairs only — the comparison binds bytes, not timestamps. */
const hashEntriesOf = root => inventoryTree({ root }).entries.map(({ path: relative, sha256 }) => ({ path: relative, sha256 }));

test('production chain proof contract', () => {
  assert.equal(PRODUCTION_PLAN.entrypoint, 'cli/benchboard.mjs');
  assert.equal(fs.existsSync(path.join(PRODUCTION_REPO, 'cli', 'benchboard.mjs')), true, 'the stated production entrypoint exists');
  assert.equal(PRODUCTION_PLAN.label, 'synthetic UI protocol, not human judgment');
  assert.deepEqual(PRODUCTION_PLAN.steps.map(step => step.command),
    ['init', 'start', 'stop', 'freeze', 'evaluate', 'export', 'ui-template', 'ui-attach', 'export-reviewed', 'reset'],
    'the full intended command order');
  for (const step of PRODUCTION_PLAN.steps) {
    assert.ok(Array.isArray(step.argv) && step.argv.length > 0 && step.argv.every(argument => typeof argument === 'string'));
    assert.equal(step.argv[0], step.command.split('-')[0], 'each step argv opens with its command');
  }
  const flags = step => new Set(step.argv.filter(argument => argument.startsWith('--')));
  for (const [index, step] of PRODUCTION_PLAN.steps.entries()) {
    if (step.command === 'init' || step.command === 'reset') {
      const expected = ['--run', '--output', '--dependency-mode'].filter(flag => step.argv.includes(flag)).sort();
      assert.deepEqual([...flags(step)].sort(), expected, 'init and reset state only their route and dependency flags');
      assert.equal(step.argv[step.argv.indexOf('--dependency-mode') + 1], 'none', 'no dependency install is planned');
    } else assert.equal(step.argv.includes('--dependency-mode'), false, 'only init and reset state dependencies');
    assert.equal(step.argv.includes('--clockless'), false, 'the plan is the normal route, never the clockless one');
    assert.equal(step.argv.includes('--timeout-ms'), false, 'the plan evaluates at the accepted C4 default bounds');
    assert.equal(step.argv.includes('--max-output-bytes'), false, 'the plan evaluates at the accepted C4 default bounds');
    if (step.command === 'ui-attach') {
      assert.equal(step.argv.includes('--output'), false, 'the attach route takes no template selector');
      assert.equal(step.argv.includes('--evaluation'), false, 'the completed worksheet bootstraps its bound parent');
      assert.equal(step.argv.includes('--report'), false, 'the completed worksheet bootstraps its bound parent');
    }
    if (step.command === 'ui-template') assert.ok(step.argv.includes('--template') && step.argv.includes('--evaluation'));
    if (step.command === 'export') { assert.ok(step.argv.includes('--evaluation')); assert.equal(step.argv.includes('--report'), false, 'the first export selects its evaluation baseline'); }
    if (step.command === 'export-reviewed') assert.ok(step.argv.includes('--evaluation') && step.argv.includes('--report'), 'the reviewed export names its exact child');
    if (step.command === 'evaluate') assert.equal(step.argv.length, 3, 'the evaluate step is the run alone at default bounds');
    assert.equal(step.argv.some(argument => path.isAbsolute(argument)), false, 'the plan holds placeholders, never an absolute machine path');
  }
});

test('actual complete CLI chain: normal lifecycle, real evaluation/repeat, synthetic UI, safe exports and preserved fresh reset', { timeout: 900000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb production chain '));
  /* This test owns only this external root and the children it started; the
   * root stays alive until the slow body returns, then removal follows. */
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 }));
  /* The block below scopes the chain; every value the T6 integration consumes
   * ({root, runRoot, init, frozen, opened, context, first, baseline}) is bound
   * in it, and the root stays alive until this slow body returns. */
  {
    const runRoot = path.join(root, 'run container');

    /* Leg 1 — the actual CLI, the normal route: init none, explicit start,
     * operator-attested stop, plain stopped-route freeze. */
    const init = successSummary(invokeProduction(root, ['init', '--output', runRoot, '--dependency-mode', 'none']));
    assert.equal(init.status, 'initialised');
    assert.equal(init.dependencyMode, 'none', 'no participant dependency was installed');
    assert.equal(init.workloadFileCount, 26, 'init materialised the canonical 26-file workload');
    const started = successSummary(invokeProduction(root, ['start', '--run', runRoot, '--harness', 'manual',
      '--model', 'synthetic-production-model', '--worker-count', '1', '--declared-ceiling-minutes', '60']));
    assert.equal(started.command, 'start');
    assert.equal(started.state, 'RUNNING');
    assert.equal(started.runId, init.runId);
    assert.equal(started.manifestId, init.manifestId);
    assert.deepEqual(started.declaration, { harness: 'manual', model: 'synthetic-production-model',
      workerCount: 1, executionMode: 'MANUAL', declaredCeilingMinutes: 60 }, 'the start returned the exact stated declaration');
    const stopped = successSummary(invokeProduction(root, ['stop', '--run', runRoot, '--operator',
      'synthetic-production-operator', '--agents-stopped']));
    assert.equal(stopped.state, 'STOP_RECORDED');
    assert.equal(stopped.runId, init.runId);
    assert.equal(stopped.manifestId, init.manifestId);
    assert.equal(stopped.stopAssurance, 'operator-attested');
    assert.equal(stopped.stopEnforced, false, 'the attested stop enforced nothing');
    const frozen = successSummary(invokeProduction(root, ['freeze', '--run', runRoot]));
    assert.equal(frozen.command, 'freeze');
    assert.equal(frozen.state, 'FROZEN');
    assert.equal(frozen.route, 'STOP_RECORDED', 'the plain freeze took the stopped route over the recorded stop');
    assert.equal(frozen.stopAssurance, 'operator-attested', 'the stopped route reuses the recorded stop attestation');
    assert.equal(frozen.stopEnforced, false);
    assert.equal(frozen.fileCount, 26, 'the snapshot holds the canonical 26-file workspace');
    assert.equal(frozen.treeDigest, init.workloadDigest);
    assert.equal(frozen.runId, init.runId);
    assert.equal(frozen.manifestId, init.manifestId);
    assert.equal(typeof frozen.snapshotId, 'string');
    assert.equal(typeof frozen.frozenSubmissionId, 'string');

    /* Independent read verification and the before-capture. The canonical
     * starter uses inventoryTree's default skips on purpose: the starter tree
     * carries the installed node_modules, which a full traverse would enter. */
    const f = { root, runRoot, init, frozen };
    const opened = await openSelectedRun(f.runRoot);
    assert.equal(opened.runId, init.runId);
    assert.equal(opened.manifestId, init.manifestId);
    const before = {
      canonicalStarter: hashEntriesOf(path.join(PRODUCTION_REPO, 'starter')),
      workspace: hashEntriesOf(f.init.workspaceRoot),
      snapshots: hashEntriesOf(path.join(f.runRoot, 'snapshots')),
    };
    assert.equal(before.workspace.length, 26, 'the live workspace is the 26-file workload before evaluation');

    /* Leg 2 — two actual production evaluations at default accepted bounds. */
    const first = successSummary(invokeProduction(f.root, ['evaluate', '--run', f.runRoot], { timeout: 600000 }));
    const second = successSummary(invokeProduction(f.root, ['evaluate', '--run', f.runRoot], { timeout: 600000 }));
    for (const summary of [first, second]) {
      assert.equal(summary.command, 'evaluate');
      assert.equal(summary.status, 'SUCCEEDED');
      assert.equal(summary.evaluatorExecution, 'SUCCESS');
      assert.equal(summary.humanReview, 'NOT_REVIEWED', 'the review has not happened on a baseline');
      assert.equal(summary.humanUI, null, 'unknown is null, never zero');
      assert.equal(summary.quality, null);
      assert.equal(typeof summary.automated, 'number');
      assert.ok(summary.automated >= 0 && summary.automated <= 80, 'the automated score stays inside the 80-point automated maximum');
      assert.equal(summary.runId, f.init.runId);
      assert.equal(summary.manifestId, f.init.manifestId);
      assert.equal(summary.snapshotId, f.frozen.snapshotId, 'the evaluation ran on the freeze-returned snapshot');
      assert.equal(summary.frozenSubmissionId, f.frozen.frozenSubmissionId);
      assert.equal(summary.workspaceMatchesFrozenInventory, true, 'the unchanged live workspace agrees with the evaluated frozen bytes');
    }
    assert.equal(first.attemptId !== second.attemptId, true, 'each evaluate reserved its own attempt');
    assert.equal(first.evaluationId !== second.evaluationId, true);
    assert.equal(first.reportId !== second.reportId, true);

    const context = await readResultsContext(opened);
    assert.ok(context, 'the actual evaluate created its verified results binding');
    const baseline = await readPublishedReport({ storeRoot: context.storeRoot, reportId: first.reportId });
    const other = await readPublishedReport({ storeRoot: context.storeRoot, reportId: second.reportId });
    for (const [summary, report] of [[first, baseline], [second, other]]) {
      assert.equal(report.reportId, summary.reportId);
      assert.equal(report.reportDigest, summary.reportDigest);
      assert.equal(report.evidence.evaluationId, summary.evaluationId);
      assert.equal(report.bindings.snapshotId, summary.snapshotId);
      assert.equal(report.bindings.frozenSubmissionId, summary.frozenSubmissionId);
      assert.ok(report.evidence.bundle !== null, 'the committed report carries its evidence bundle');
      assert.equal(report.execution.evaluatorExecution, 'SUCCESS');
      assert.equal(report.execution.humanReview, 'NOT_REVIEWED');
      assert.equal(report.quality.humanUI, null);
      assert.equal(report.quality.quality, null);
      assert.equal(report.quality.automated, summary.automated, 'the summary restates the committed report, not a synthetic score');
      assert.equal(report.quality.automatedMaximum, 80);
    }

    /* Both actual attempts, each with its own real output root. */
    const attempts = await readEvaluationAttempts(opened, context);
    assert.equal(attempts.length, 2, 'both evaluations booked their own attempt');
    const attemptIds = attempts.map(({ start }) => start.attemptId).sort();
    assert.deepEqual(attemptIds, [first.attemptId, second.attemptId].sort());
    const outputRoots = new Set(attempts.map(({ start }) => start.outputRoot));
    assert.equal(outputRoots.size, 2, 'the two attempts hold two distinct actual output roots');
    for (const attempt of attempts) {
      assert.ok(attempt.terminal !== null && attempt.terminal.status === 'SUCCEEDED');
      const summary = attempt.start.attemptId === first.attemptId ? first : second;
      assert.equal(attempt.terminal.evaluationId, summary.evaluationId);
      assert.equal(attempt.terminal.reportId, summary.reportId);
    }

    /* The repeat on the unchanged snapshot: semantically identical automated
     * categories, with no timing or other environment-dependent metric. */
    assert.deepEqual(other.quality.areas, baseline.quality.areas, 'the automated areas repeat identically');
    assert.equal(other.quality.automated, baseline.quality.automated, 'the automated total repeats identically');
    assert.deepEqual({ ...other.quality, status: null }, { ...baseline.quality, status: null });

    assert.deepEqual(hashEntriesOf(path.join(PRODUCTION_REPO, 'starter')), before.canonicalStarter, 'the canonical starter is byte-unchanged');
    assert.deepEqual(hashEntriesOf(f.init.workspaceRoot), before.workspace, 'the live workspace is byte-unchanged after both evaluations');
    assert.deepEqual(hashEntriesOf(path.join(f.runRoot, 'snapshots')), before.snapshots, 'the saved snapshot is byte-unchanged after both evaluations');

    await completeProductionChain(t, { root, runRoot, init, frozen, opened, context, first, baseline });
    console.log('S11 complete-chain evidence: real C4 success/repeat with distinct identities and equal categories; synthetic UI protocol, not human judgment; exact safe exports and complete old-run/results preservation across fresh reset.');
  }
});
