// Captain diagnostic: actual C1 terminal failure over real C3/C5 synthetic artifacts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { makePublicationFixture } from '../results/publication-fixture.mjs';
import { saveReport, readPublishedReport } from '../../packages/results/publication.mjs';
import { openSelectedRun, ensureResultsContext } from '../../cli/run-context.mjs';
import { reserveEvaluationAttempt, finishEvaluationAttempt, readEvaluationAttempts } from '../../cli/attempt-records.mjs';
import { recordEvaluationExecution } from '../../cli/execution-records.mjs';
import { diagnosticOf } from '../../cli/diagnostics.mjs';

test('actual terminal link failure retains committed baseline and execution intent without inventing a terminal', async t => {
  const p = await makePublicationFixture(t), opened = await openSelectedRun(p.runRoot), context = await ensureResultsContext(opened);
  const start = await reserveEvaluationAttempt(opened, context, { snapshotId: p.input.selection.snapshotId, frozenSubmissionId: p.input.selection.frozenSubmissionId });
  fs.cpSync(p.evaluationRoot, start.outputRoot, { recursive: true });
  await recordEvaluationExecution(opened, context, start.attemptId, { evaluationId: p.report.evidence.evaluationId, reportId: p.report.reportId, evaluatorExecution: 'SUCCESS' });
  await saveReport({ storeRoot: context.storeRoot, runRoot: p.runRoot, evaluationRoot: start.outputRoot, report: p.report });
  const terminalPath = path.join(context.resultsRoot, 'cli-attempts', start.attemptId, 'terminal.json');
  const original = fsp.link; let intercepted = 0;
  fsp.link = async function(source, destination, ...rest) {
    if (path.resolve(String(destination)) === terminalPath) {
      intercepted++;
      throw Object.assign(new Error('Synthetic terminal link failure'), { code: 'EIO' });
    }
    return original.call(this, source, destination, ...rest);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(finishEvaluationAttempt(opened, context, start.attemptId, {
      status: 'SUCCEEDED', evaluationId: p.report.evidence.evaluationId, reportId: p.report.reportId }),
    error => diagnosticOf(error).exitCode === 5);
  } finally { fsp.link = original; syncBuiltinESMExports(); }
  assert.equal(intercepted, 1, 'actual terminal link intercepted, not a public runtime hook');
  assert.equal(fs.existsSync(terminalPath), false);
  const attempts = await readEvaluationAttempts(opened, context);
  assert.equal(attempts[0].terminal, null);
  assert.equal(attempts[0].execution.reportId, p.report.reportId);
  assert.equal((await readPublishedReport({ storeRoot: context.storeRoot, reportId: p.report.reportId })).reportDigest, p.report.reportDigest);
});

test('after-link failure can leave a published terminal that accepted C1 envelope reads verify without registry repair', async t => {
  const p = await makePublicationFixture(t), opened = await openSelectedRun(p.runRoot), context = await ensureResultsContext(opened);
  const start = await reserveEvaluationAttempt(opened, context, { snapshotId: p.input.selection.snapshotId, frozenSubmissionId: p.input.selection.frozenSubmissionId });
  fs.cpSync(p.evaluationRoot, start.outputRoot, { recursive: true });
  await recordEvaluationExecution(opened, context, start.attemptId, { evaluationId: p.report.evidence.evaluationId, reportId: p.report.reportId, evaluatorExecution: 'SUCCESS' });
  await saveReport({ storeRoot: context.storeRoot, runRoot: p.runRoot, evaluationRoot: start.outputRoot, report: p.report });
  const terminalPath = path.join(context.resultsRoot, 'cli-attempts', start.attemptId, 'terminal.json');
  const original = fsp.link; let intercepted = 0;
  fsp.link = async function(source, destination, ...rest) {
    const result = await original.call(this, source, destination, ...rest);
    if (path.resolve(String(destination)) === terminalPath) {
      intercepted++;
      throw Object.assign(new Error('Synthetic failure after the actual link'), { code: 'EIO' });
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(finishEvaluationAttempt(opened, context, start.attemptId, {
      status: 'SUCCEEDED', evaluationId: p.report.evidence.evaluationId, reportId: p.report.reportId }), error => diagnosticOf(error).exitCode === 5);
  } finally { fsp.link = original; syncBuiltinESMExports(); }
  assert.equal(intercepted, 1);
  const retainedBytes = fs.readFileSync(terminalPath);
  const registryPath = path.join(context.resultsRoot, '.storage', 'registry.json');
  const registryBeforeRead = fs.readFileSync(registryPath);
  const attempts = await readEvaluationAttempts(opened, context);
  assert.equal(attempts[0].terminal.status, 'SUCCEEDED', 'C1 read verifies the envelope, not final registry registration');
  assert.deepEqual(fs.readFileSync(registryPath), registryBeforeRead, 'no automatic registry repair occurred');
  assert.deepEqual(fs.readFileSync(terminalPath), retainedBytes);
  assert.equal((await readPublishedReport({ storeRoot: context.storeRoot, reportId: p.report.reportId })).reportDigest, p.report.reportDigest);
});

test('a late registry error can leave a committed terminal that subsequent accepted reads verify honestly', async t => {
  const p = await makePublicationFixture(t), opened = await openSelectedRun(p.runRoot), context = await ensureResultsContext(opened);
  const start = await reserveEvaluationAttempt(opened, context, { snapshotId: p.input.selection.snapshotId, frozenSubmissionId: p.input.selection.frozenSubmissionId });
  fs.cpSync(p.evaluationRoot, start.outputRoot, { recursive: true });
  await recordEvaluationExecution(opened, context, start.attemptId, { evaluationId: p.report.evidence.evaluationId, reportId: p.report.reportId, evaluatorExecution: 'SUCCESS' });
  await saveReport({ storeRoot: context.storeRoot, runRoot: p.runRoot, evaluationRoot: start.outputRoot, report: p.report });
  const registryPath = path.join(context.resultsRoot, '.storage', 'registry.json');
  const original = fsp.rename; let intercepted = 0;
  fsp.rename = async function(source, destination, ...rest) {
    const result = await original.call(this, source, destination, ...rest);
    if (path.resolve(String(destination)) === registryPath) {
      intercepted++;
      // First rename reserves the identity; second records the linked publication.
      if (intercepted === 2) throw Object.assign(new Error('Synthetic failure after actual registry publication'), { code: 'EIO' });
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(finishEvaluationAttempt(opened, context, start.attemptId, {
      status: 'SUCCEEDED', evaluationId: p.report.evidence.evaluationId, reportId: p.report.reportId }), error => diagnosticOf(error).exitCode === 5);
  } finally { fsp.rename = original; syncBuiltinESMExports(); }
  assert.equal(intercepted, 2);
  const attempts = await readEvaluationAttempts(opened, context);
  assert.equal(attempts[0].terminal.status, 'SUCCEEDED');
  assert.equal(attempts[0].terminal.reportDigest, p.report.reportDigest);
  assert.equal(attempts[0].execution.reportId, p.report.reportId);
});
