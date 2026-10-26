// Captain diagnostic boundary tests: real C1/C3/C5 with explicitly synthetic C4 artifacts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makePublicationFixture } from '../results/publication-fixture.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { saveReport } from '../../packages/results/publication.mjs';
import { openSelectedRun, ensureResultsContext } from '../../cli/run-context.mjs';
import { reserveEvaluationAttempt, readEvaluationAttempts, finishEvaluationAttempt } from '../../cli/attempt-records.mjs';
import { recordEvaluationExecution } from '../../cli/execution-records.mjs';
import { resolveCliReport } from '../../cli/report-selection.mjs';
import { summariseLifecycle } from '../../cli/lifecycle-summary.mjs';

test('execution validates the bound results root before locking and captures returned primitive facts before await', async t => {
  const p = await makePublicationFixture(t), opened = await openSelectedRun(p.runRoot), context = await ensureResultsContext(opened);
  const selection = { snapshotId: p.input.selection.snapshotId, frozenSubmissionId: p.input.selection.frozenSubmissionId };
  const start = await reserveEvaluationAttempt(opened, context, selection);
  const foreign = path.join(p.fixture.root, 'foreign results'); fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'private-canary.txt'), 'Preserve foreign root without even a storage lock.');
  const before = inventoryTree({ root: foreign, skipNames: [] });
  const facts = { evaluationId: p.report.evidence.evaluationId, reportId: p.report.reportId, evaluatorExecution: 'SUCCESS' };
  await assert.rejects(recordEvaluationExecution(opened, { ...context, resultsRoot: foreign }, start.attemptId, facts), error => error.category === 'integrity');
  assert.deepEqual(inventoryTree({ root: foreign, skipNames: [] }), before);
  const originalId = facts.reportId;
  const pending = recordEvaluationExecution(opened, context, start.attemptId, facts);
  facts.reportId = 'report-mutated-after-call';
  const execution = await pending;
  assert.equal(execution.reportId, originalId);
  assert.equal(execution.outputRoot, start.outputRoot);
  const attempts = await readEvaluationAttempts(opened, context);
  assert.equal(attempts[0].terminal, null);
  const summary = summariseLifecycle('status', { state: 'FROZEN', diagnosis: 'consistent', runId: opened.runId, manifestId: opened.manifestId }, attempts);
  assert.equal(summary.attempts[0].status, 'INCOMPLETE');
  assert.equal(summary.attempts[0].evaluationId, null);
  assert.equal(summary.attempts[0].reportId, null);
  assert.equal(summary.attempts[0].publicationIntent.reportId, originalId);
  assert.equal(JSON.stringify(summary).includes(start.outputRoot), false);
});

test('report resolution refuses an unexecuted or incomplete reference and permits only the committed matching baseline', async t => {
  const p = await makePublicationFixture(t), opened = await openSelectedRun(p.runRoot), context = await ensureResultsContext(opened);
  const start = await reserveEvaluationAttempt(opened, context, { snapshotId: p.input.selection.snapshotId, frozenSubmissionId: p.input.selection.frozenSubmissionId });
  fs.cpSync(p.evaluationRoot, start.outputRoot, { recursive: true });
  const options = { evaluationId: p.report.evidence.evaluationId, reportId: undefined, baselineOnly: true };
  await recordEvaluationExecution(opened, context, start.attemptId, { evaluationId: p.report.evidence.evaluationId,
    reportId: p.report.reportId, evaluatorExecution: 'SUCCESS' });
  await assert.rejects(resolveCliReport(opened, options), error => error.category === 'state');
  await saveReport({ storeRoot: context.storeRoot, runRoot: p.runRoot, evaluationRoot: start.outputRoot, report: p.report });
  // A committed C5 report alone is still not a completed CLI attempt.
  await assert.rejects(resolveCliReport(opened, options), error => error.category === 'state');
  await finishEvaluationAttempt(opened, context, start.attemptId, { status: 'SUCCEEDED', evaluationId: p.report.evidence.evaluationId, reportId: p.report.reportId });
  const selected = await resolveCliReport(opened, options);
  assert.equal(selected.report.reportId, p.report.reportId);
  assert.equal(selected.attempt.start.attemptId, start.attemptId);
  await assert.rejects(resolveCliReport(opened, { ...options, evaluationId: 'eval-foreign' }), error => error.category === 'state');
});
