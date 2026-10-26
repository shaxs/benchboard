// Captain-owned test setup: real C1/C3/C5 authority with explicitly synthetic C4 artifacts.
// No production evaluator execution, screenshot pixels or human judgment is claimed.
import fs from 'node:fs';
import { makePublicationFixture, physicalWorksheet } from '../results/publication-fixture.mjs';
import { createReport } from '../../packages/results/report.mjs';
import { saveReport, attachUIReview } from '../../packages/results/publication.mjs';
import { openSelectedRun, ensureResultsContext } from '../../cli/run-context.mjs';
import { reserveEvaluationAttempt, finishEvaluationAttempt } from '../../cli/attempt-records.mjs';
import { recordEvaluationExecution } from '../../cli/execution-records.mjs';

export async function makeCliExportFixture(t, { infrastructure = false } = {}) {
  const p = await makePublicationFixture(t), opened = await openSelectedRun(p.runRoot), context = await ensureResultsContext(opened);
  const start = await reserveEvaluationAttempt(opened, context, {
    snapshotId: p.input.selection.snapshotId, frozenSubmissionId: p.input.selection.frozenSubmissionId });
  const report = infrastructure ? await createReport({ ...p.input, reportId: 'report-synthetic-infrastructure-cli-export', evaluation: {
    status: 'infrastructure-error', evaluationId: 'eval-synthetic-infrastructure-cli-export', bundle: null,
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

export async function attachSyntheticExportChild(r, { positive = true, suffix = 'positive', privateCanary = false } = {}) {
  const worksheet = physicalWorksheet(r.report, r.p.reviewRoot, positive);
  if (privateCanary) {
    worksheet.reviewer = 'PRIVATE_CLI_EXPORT_REVIEWER_CANARY';
    for (const name of Object.keys(worksheet.notes)) worksheet.notes[name] = 'PRIVATE_CLI_EXPORT_NARRATIVE_CANARY';
    for (const improvement of Object.values(worksheet.improvements)) improvement.description = 'PRIVATE_CLI_EXPORT_IMPROVEMENT_CANARY';
  }
  return attachUIReview({ storeRoot: r.context.storeRoot, runRoot: r.opened.runRoot,
    evaluationRoot: r.start.outputRoot, parentReportId: r.report.reportId,
    reportId: `report-synthetic-cli-export-${suffix}`, createdAt: '2026-02-03T04:05:06.000Z', worksheet, reviewRoot: r.p.reviewRoot });
}
