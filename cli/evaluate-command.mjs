// Captain-owned production-only composition. The public facade receives no collaborators.
import fs from 'node:fs';
import { createId } from '../packages/core/identity.mjs';
import { evaluateFrozen } from '../packages/evaluation/evaluate-frozen.mjs';
import { createReport } from '../packages/results/report.mjs';
import { validateNeutralTokenInput } from '../packages/results/measurement-contract.mjs';
import { saveReport } from '../packages/results/publication.mjs';
import { openSelectedRun, ensureResultsContext } from './run-context.mjs';
import { loadInstallation } from './installation.mjs';
import { selectVerifiedFrozen, snapshotOption } from './frozen-selection.mjs';
import { reserveEvaluationAttempt, finishEvaluationAttempt } from './attempt-records.mjs';
import { recordEvaluationExecution } from './execution-records.mjs';
import { evaluationArgumentsOf } from './evaluation-arguments.mjs';
import { summariseEvaluation } from './evaluation-summary.mjs';
import { diagnosticOf } from './diagnostics.mjs';
import { CommandError } from './command-error.mjs';
import { existingDirectory, canonicalRoot, readOrdinaryJson } from './filesystem.mjs';

// Optional run-total token statement (NeutralTokenInput), refused before any run state is opened.
function tokenMetricsOf(file) {
  if (file === undefined) return null;
  const value = readOrdinaryJson(canonicalRoot(file), 65536);
  try { return validateNeutralTokenInput(value); }
  catch { throw new CommandError('usage'); }
}

export async function evaluateCommand(options, { signal } = {}) {
  if (signal?.aborted) throw new CommandError('cancelled');
  const bounds = evaluationArgumentsOf(options), snapshot = snapshotOption(options['--snapshot']);
  const metrics = tokenMetricsOf(options['--tokens-file']);
  const runRoot = options['--run'], resultsRoot = options['--results-root'];
  const opened = await openSelectedRun(runRoot);
  let selection;
  try { selection = await selectVerifiedFrozen(opened, snapshot); }
  catch (error) {
    if (error instanceof CommandError && error.category === 'state') {
      // The fixed state category remains private-safe; no automatic freeze or repair.
      throw new CommandError('state');
    }
    throw error;
  }
  const installation = loadInstallation();
  const context = await ensureResultsContext(opened, resultsRoot);
  const attempt = await reserveEvaluationAttempt(opened, context, {
    snapshotId: selection.snapshotId, frozenSubmissionId: selection.frozenSubmissionId });
  const submission = Object.freeze({ ...opened.request, snapshotId: selection.snapshotId,
    frozenSubmissionId: selection.frozenSubmissionId });
  let executionRecorded = false, terminalRecorded = false, returnedEvaluationId = null;
  try {
    const evaluation = await evaluateFrozen({ challenge: installation.challenge.identity,
      evaluator: installation.evaluatorIdentity, submission, outputRoot: attempt.outputRoot, ...bounds,
      ...(signal === undefined ? {} : { signal }) });
    returnedEvaluationId = evaluation.evaluationId;
    const succeeded = evaluation.status === 'success';
    const cancelled = !succeeded && evaluation.error?.code === 'CANCELLED';
    let outputExists = false;
    try { fs.lstatSync(attempt.outputRoot); outputExists = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (outputExists) existingDirectory(attempt.outputRoot);
    // Cancellation never promotes a partial evaluation to a baseline report.
    const reportId = !cancelled && (succeeded || outputExists) ? createId('report') : null;
    await recordEvaluationExecution(opened, context, attempt.attemptId, {
      evaluationId: evaluation.evaluationId, reportId,
      evaluatorExecution: succeeded ? 'SUCCESS' : 'INFRASTRUCTURE_ERROR' });
    executionRecorded = true;
    if (reportId === null) {
      await finishEvaluationAttempt(opened, context, attempt.attemptId, {
        status: cancelled ? 'CANCELLED' : 'INFRASTRUCTURE', evaluationId: evaluation.evaluationId, reportId: null });
      terminalRecorded = true;
      throw new CommandError(cancelled ? 'cancelled' : 'infrastructure');
    }
    const report = await createReport({ reportId, createdAt: new Date().toISOString(), selection: submission, evaluation,
      ...(metrics === null ? {} : { metrics }) });
    await saveReport({ storeRoot: context.storeRoot, runRoot: opened.runRoot, evaluationRoot: attempt.outputRoot, report });
    const terminal = await finishEvaluationAttempt(opened, context, attempt.attemptId, {
      status: succeeded ? 'SUCCEEDED' : 'INFRASTRUCTURE', evaluationId: evaluation.evaluationId, reportId: report.reportId });
    terminalRecorded = true;
    if (!succeeded) throw new CommandError('infrastructure');
    // C4 already awaited bounded cleanup. A late signal never relabels a committed result.
    return summariseEvaluation({ opened, attempt, terminal, report, selection: Object.freeze({ ...selection,
      workspaceMatchesFrozenInventory: evaluation.snapshot?.workspaceMatchesFrozen ?? null }) });
  } catch (error) {
    if (returnedEvaluationId === null && !executionRecorded && !terminalRecorded) {
      const exit = diagnosticOf(error).exitCode;
      const status = exit === 130 ? 'CANCELLED' : exit === 4 || exit === 3 ? 'REFUSED' : 'INFRASTRUCTURE';
      try { await finishEvaluationAttempt(opened, context, attempt.attemptId, { status, evaluationId: returnedEvaluationId, reportId: null }); }
      catch { /* Retain incomplete metadata and preserve the original refusal/error. */ }
    }
    // Once C4 returns, bookkeeping errors must not relabel its outcome. A missing
    // execution envelope stays incomplete; no automatic repair/retry is attempted.
    throw error;
  }
}
