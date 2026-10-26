// Captain exact-parent/child selection diagnostics, synthetic C4/C5 protocol not human assessment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makePublicationFixture, physicalWorksheet } from '../results/publication-fixture.mjs';
import { createReport } from '../../packages/results/report.mjs';
import { saveReport, attachUIReview } from '../../packages/results/publication.mjs';
import { createExportProjection } from '../../packages/results/export-contract.mjs';
import { openSelectedRun, ensureResultsContext } from '../../cli/run-context.mjs';
import { reserveEvaluationAttempt, finishEvaluationAttempt } from '../../cli/attempt-records.mjs';
import { recordEvaluationExecution } from '../../cli/execution-records.mjs';
import { resolveCliReport } from '../../cli/report-selection.mjs';
import { makeCliExportFixture, attachSyntheticExportChild } from './export-fixture.mjs';

async function ready(t, infrastructure = false) {
  const p = await makePublicationFixture(t), opened = await openSelectedRun(p.runRoot), context = await ensureResultsContext(opened);
  const start = await reserveEvaluationAttempt(opened, context, {
    snapshotId: p.input.selection.snapshotId, frozenSubmissionId: p.input.selection.frozenSubmissionId });
  const report = infrastructure ? await createReport({ ...p.input, reportId: 'report-synthetic-infrastructure-export', evaluation: {
    status: 'infrastructure-error', evaluationId: 'eval-synthetic-infrastructure-export', bundle: null,
    evidence: null, score: null, error: { code: 'TIMEOUT' } } }) : p.report;
  if (infrastructure) fs.mkdirSync(start.outputRoot);
  else fs.cpSync(p.evaluationRoot, start.outputRoot, { recursive: true });
  await recordEvaluationExecution(opened, context, start.attemptId, { evaluationId: report.evidence.evaluationId,
    reportId: report.reportId, evaluatorExecution: infrastructure ? 'INFRASTRUCTURE_ERROR' : 'SUCCESS' });
  await saveReport({ storeRoot: context.storeRoot, runRoot: opened.runRoot, evaluationRoot: start.outputRoot, report });
  await finishEvaluationAttempt(opened, context, start.attemptId, { evaluationId: report.evidence.evaluationId,
    reportId: report.reportId, status: infrastructure ? 'INFRASTRUCTURE' : 'SUCCEEDED' });
  return { p, opened, context, start, report };
}

test('export selection defaults only to its exact baseline and permits either explicitly named direct child', async t => {
  const r = await ready(t), children = [];
  for (const [index, positive] of [false, true].entries()) {
    children.push(await attachUIReview({ storeRoot: r.context.storeRoot, runRoot: r.opened.runRoot,
      evaluationRoot: r.start.outputRoot, parentReportId: r.report.reportId, reportId: `report-synthetic-export-child-${index}`,
      createdAt: '2026-02-03T04:05:06.000Z', worksheet: physicalWorksheet(r.report, r.p.reviewRoot, positive), reviewRoot: r.p.reviewRoot }));
  }
  const selector = { evaluationId: r.report.evidence.evaluationId, reportId: undefined, baselineOnly: false };
  const baseline = await resolveCliReport(r.opened, selector);
  assert.equal(baseline.report.reportId, r.report.reportId, 'two children never trigger latest selection');
  assert.equal(baseline.report.quality.humanUI, null);
  for (const child of children) {
    const selected = await resolveCliReport(r.opened, { ...selector, reportId: child.reportId });
    assert.equal(selected.report.reportDigest, child.reportDigest);
    assert.equal(selected.baseline.reportId, r.report.reportId);
    assert.equal(selected.report.evidence.bundleDigest, r.report.evidence.bundleDigest);
  }
  assert.equal(children[0].quality.humanUI, 0);
  assert.equal(children[1].quality.humanUI, 20);
  await assert.rejects(resolveCliReport(r.opened, { ...selector, evaluationId: 'eval-foreign', reportId: children[0].reportId }), e => e.category === 'state');
});

test('a physically committed report from another run in the store cannot become this run evaluation baseline', async t => {
  const r = await ready(t), foreign = await makePublicationFixture(t);
  const foreignReport = await createReport({ ...foreign.input, reportId: 'report-synthetic-foreign-export' });
  await saveReport({ storeRoot: r.context.storeRoot, runRoot: foreign.runRoot,
    evaluationRoot: foreign.evaluationRoot, report: foreignReport });
  await assert.rejects(resolveCliReport(r.opened, { evaluationId: r.report.evidence.evaluationId,
    reportId: foreignReport.reportId, baselineOnly: false }), e => e.category === 'state');
});

test('committed infrastructure export selection preserves unavailable quality instead of refusing or scoring zero', async t => {
  const r = await ready(t, true);
  const selected = await resolveCliReport(r.opened, { evaluationId: r.report.evidence.evaluationId, reportId: undefined, baselineOnly: false });
  assert.equal(selected.report.execution.evaluatorExecution, 'INFRASTRUCTURE_ERROR');
  assert.equal(selected.report.quality, null);
  const projection = createExportProjection(selected.report);
  assert.equal(projection.quality, null);
  assert.equal(projection.execution.evaluatorExecution, 'INFRASTRUCTURE_ERROR');
});

test('the independent CLI fixture publishes real bound synthetic children with private review facts', async t => {
  const r = await makeCliExportFixture(t);
  const child = await attachSyntheticExportChild(r, { suffix: 'fixture-canary', privateCanary: true });
  const selected = await resolveCliReport(r.opened, { evaluationId: r.report.evidence.evaluationId, reportId: child.reportId, baselineOnly: false });
  assert.equal(selected.report.reportDigest, child.reportDigest);
  assert.equal(child.quality.humanUI, 20);
  assert.equal(child.provenance.review.reviewer, 'PRIVATE_CLI_EXPORT_REVIEWER_CANARY');
});
