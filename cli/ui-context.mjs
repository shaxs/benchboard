// Captain-owned worksheet bootstrap and exact baseline/evidence-root boundary.
import { readUIWorksheet } from '../packages/results/ui-worksheet.mjs';
import { openSelectedRun } from './run-context.mjs';
import { resolveCliReport } from './report-selection.mjs';
import { externalRoot, readOrdinaryBytes, rejectIntegrity } from './filesystem.mjs';
import { explicitFilePath, privateTemplateDestination } from './private-output.mjs';

const reportIdOf = value => {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{2,127}$/.test(value)) rejectIntegrity();
  return value;
};
export async function prepareUIContext(parsed, options) {
  const run = options['--run'];
  parsed = Object.freeze({ mode: parsed.mode, input: parsed.input, reviewRoot: parsed.reviewRoot,
    output: parsed.output, evaluationId: parsed.evaluationId, reportId: parsed.reportId });
  const opened = await openSelectedRun(run);
  let text, evaluationId = parsed.evaluationId, reportId = parsed.reportId;
  if (parsed.mode === 'attach') {
    text = readOrdinaryBytes(explicitFilePath(parsed.input), 2097152).toString('utf8');
    let input;
    try { input = JSON.parse(text); } catch { rejectIntegrity(); }
    // Only the bounded parent ID bootstraps lookup; every remaining fact is checked by C5.
    reportId = reportIdOf(input?.bindings?.reportId);
    evaluationId = undefined;
  }
  const selected = await resolveCliReport(opened, { evaluationId, reportId, baselineOnly: true });
  const parent = selected.baseline;
  if (parent.execution.evaluatorExecution !== 'SUCCESS' || parent.evidence.bundle === null) rejectIntegrity();
  const protectedRoots = Object.freeze([opened.runRoot, selected.context.resultsRoot]);
  if (parsed.mode === 'template') {
    const output = privateTemplateDestination(parsed.output, protectedRoots);
    return Object.freeze({ mode: 'template', opened, parent, output, protectedRoots });
  }
  const reviewRoot = externalRoot(explicitFilePath(parsed.reviewRoot), protectedRoots);
  const worksheet = readUIWorksheet(text, parent);
  return Object.freeze({ mode: 'attach', opened, parent, context: selected.context,
    evaluationRoot: selected.attempt.start.outputRoot, reviewRoot, worksheet });
}
