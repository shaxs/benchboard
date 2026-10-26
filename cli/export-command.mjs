// Production C5 safe projection/rendering with Captain-held exact selection and file publication.
import { openSelectedRun } from './run-context.mjs';
import { resolveCliReport } from './report-selection.mjs';
import { exportArgumentsOf } from './export-arguments.mjs';
import { exportContentOf } from './export-content.mjs';
import { publishSafeExport } from './export-publication.mjs';
import { CommandError } from './command-error.mjs';

export async function exportCommand(options, { signal } = {}) {
  if (signal?.aborted) throw new CommandError('cancelled');
  const parsed = exportArgumentsOf(options), run = options['--run'];
  const opened = await openSelectedRun(run);
  const selected = await resolveCliReport(opened, { evaluationId: parsed.evaluationId, reportId: parsed.reportId, baselineOnly: false });
  const { report, context } = selected;
  const content = exportContentOf(report);
  if (signal?.aborted) throw new CommandError('cancelled');
  const published = publishSafeExport({ output: parsed.output, json: content.json, text: content.text,
    protectedRoots: [opened.runRoot, context.resultsRoot] });
  return Object.freeze({ command: 'export', runId: opened.runId, manifestId: opened.manifestId,
    evaluationId: report.evidence.evaluationId, reportId: report.reportId, reportDigest: report.reportDigest,
    evaluatorExecution: report.execution.evaluatorExecution, humanReview: report.execution.humanReview,
    automated: report.quality?.automated ?? null, humanUI: report.quality?.humanUI ?? null, quality: report.quality?.quality ?? null,
    output: published.output, complete: published.complete, files: published.files, completionMarker: published.completionMarker });
}
