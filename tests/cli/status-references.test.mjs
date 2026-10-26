// Captain-owned integration acceptance for status references. The C3/C5 authority
// is real; evaluation artifacts are explicitly synthetic, not a browser evaluation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makePublicationFixture } from '../results/publication-fixture.mjs';
import { snapshotInputs, assertInputsUnchanged } from '../evaluation/helpers.mjs';
import { saveReport } from '../../packages/results/publication.mjs';
import { openSelectedRun, ensureResultsContext } from '../../cli/run-context.mjs';
import { reserveEvaluationAttempt, finishEvaluationAttempt } from '../../cli/attempt-records.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';

test('actual status separates committed synthetic report references from an incomplete attempt without creating output', async t => {
  const p = await makePublicationFixture(t), before = snapshotInputs(p.fixture);
  const opened = await openSelectedRun(p.runRoot), context = await ensureResultsContext(opened);
  const selection = { snapshotId: p.input.selection.snapshotId, frozenSubmissionId: p.input.selection.frozenSubmissionId };
  const completed = await reserveEvaluationAttempt(opened, context, selection);
  fs.cpSync(p.evaluationRoot, completed.outputRoot, { recursive: true });
  await saveReport({ storeRoot: context.storeRoot, runRoot: p.runRoot, evaluationRoot: completed.outputRoot, report: p.report });
  await finishEvaluationAttempt(opened, context, completed.attemptId, {
    status: 'SUCCEEDED', evaluationId: p.report.evidence.evaluationId, reportId: p.report.reportId,
  });
  const incomplete = await reserveEvaluationAttempt(opened, context, selection);
  const resultsBefore = inventoryTree({ root: context.resultsRoot, skipNames: [] });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../cli/benchboard.mjs', import.meta.url)), 'status', '--run', p.runRoot], {
    cwd: p.fixture.root, encoding: 'utf8', shell: false, timeout: 15000, maxBuffer: 1048576, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.state, 'FROZEN');
  assert.equal(summary.diagnosis, 'consistent');
  assert.equal(summary.elapsedMs, null, 'a clockless synthetic fixture has unavailable elapsed time');
  assert.equal(summary.attempts.length, 2);
  const byId = new Map(summary.attempts.map(attempt => [attempt.attemptId, attempt]));
  assert.deepEqual(byId.get(completed.attemptId), {
    attemptId: completed.attemptId, snapshotId: selection.snapshotId, frozenSubmissionId: selection.frozenSubmissionId,
    status: 'SUCCEEDED', evaluationId: p.report.evidence.evaluationId, reportId: p.report.reportId, reportDigest: p.report.reportDigest,
  });
  assert.deepEqual(byId.get(incomplete.attemptId), {
    attemptId: incomplete.attemptId, snapshotId: selection.snapshotId, frozenSubmissionId: selection.frozenSubmissionId,
    status: 'INCOMPLETE', evaluationId: null, reportId: null, reportDigest: null,
  });
  for (const forbidden of ['journal', 'findings', 'stopAttestation', 'rawError', 'score', 'quality']) assert.equal(forbidden in summary, false);
  assert.equal(fs.existsSync(incomplete.outputRoot), false);
  assert.deepEqual(inventoryTree({ root: context.resultsRoot, skipNames: [] }), resultsBefore,
    'status preserves all results context, attempt and committed-store bytes');
  assertInputsUnchanged(p.fixture, before);
});
