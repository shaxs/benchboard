// Captain-owned exact CLI baseline/direct-child selection; never implicit latest or store adoption.
import { readPublishedReport } from '../packages/results/publication.mjs';
import { verifyReportArtifacts } from '../packages/results/artifact-verification.mjs';
import { readResultsContext } from './run-context.mjs';
import { readEvaluationAttempts } from './attempt-records.mjs';
import { selectVerifiedFrozen } from './frozen-selection.mjs';
import { CommandError } from './command-error.mjs';
import { exactKeys, rejectIntegrity } from './filesystem.mjs';

function suppliedId(value) {
  if (value !== undefined && (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{2,127}$/.test(value))) rejectIntegrity();
  return value;
}
export async function resolveCliReport(opened, options) {
  exactKeys(options, ['evaluationId', 'reportId', 'baselineOnly']);
  const evaluationId = suppliedId(options.evaluationId), reportId = suppliedId(options.reportId);
  const baselineOnly = options.baselineOnly === true;
  if (evaluationId === undefined && reportId === undefined) throw new CommandError('state');
  const context = await readResultsContext(opened);
  if (context === null) throw new CommandError('state');
  const attempts = await readEvaluationAttempts(opened, context);
  const selectedReport = reportId === undefined ? null : await readPublishedReport({ storeRoot: context.storeRoot, reportId });
  const baselineId = selectedReport === null ? undefined : selectedReport.provenance.parentReportId ?? selectedReport.reportId;
  const matches = attempts.filter(({ terminal, execution }) => terminal?.reportId != null && execution != null &&
    terminal.evaluationId === execution.evaluationId && terminal.reportId === execution.reportId &&
    (evaluationId === undefined || terminal.evaluationId === evaluationId) &&
    (baselineId === undefined || terminal.reportId === baselineId));
  if (matches.length !== 1) throw new CommandError('state');
  const attempt = matches[0], baseline = await readPublishedReport({ storeRoot: context.storeRoot, reportId: attempt.terminal.reportId });
  const report = selectedReport ?? baseline;
  if (baselineOnly && report.reportId !== baseline.reportId) throw new CommandError('state');
  for (const field of ['runId', 'manifestId', 'manifestDigest', 'snapshotId', 'frozenSubmissionId', 'treeDigest']) {
    if (report.bindings[field] !== baseline.bindings[field]) rejectIntegrity();
  }
  if (report.evidence.evaluationId !== baseline.evidence.evaluationId || report.evidence.bundleDigest !== baseline.evidence.bundleDigest ||
      (report.reportId !== baseline.reportId && (report.provenance.parentReportId !== baseline.reportId || report.provenance.parentReportDigest !== baseline.reportDigest))) rejectIntegrity();
  await selectVerifiedFrozen(opened, attempt.start.snapshotId);
  verifyReportArtifacts(attempt.start.outputRoot, baseline.artifacts);
  return Object.freeze({ context, attempt, baseline, report });
}
