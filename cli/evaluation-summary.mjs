// Captain-owned explicit local JSON projection, never a privacy-safe export.
// Receives already-verified private facts (committed baseline, terminal record and validated
// Report); it does not validate, authenticate or evaluate. The command handler uses this after a
// committed successful baseline plus terminal only. No fields from raw report.evidence,
// bundle/logs/artifacts, operator, configuration, errors or roots appear here.
export function summariseEvaluation({ opened, attempt, terminal, report, selection }) {
  return Object.freeze({
    command: 'evaluate',
    attemptId: attempt.attemptId,
    runId: opened.runId,
    manifestId: opened.manifestId,
    snapshotId: selection.snapshotId,
    frozenSubmissionId: selection.frozenSubmissionId,
    evaluationId: terminal.evaluationId,
    reportId: report.reportId,
    reportDigest: report.reportDigest,
    status: terminal.status,
    evaluatorExecution: report.execution.evaluatorExecution,
    humanReview: report.execution.humanReview,
    agentOutcome: report.execution.agentOutcome,
    enforcement: report.execution.enforcement,
    enforced: report.execution.enforced,
    automated: report.quality?.automated ?? null,
    humanUI: report.quality?.humanUI ?? null,
    quality: report.quality?.quality ?? null,
    workspaceMatchesFrozenInventory: selection.workspaceMatchesFrozenInventory ?? null,
  });
}
