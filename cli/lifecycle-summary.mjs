// Captain-owned explicit local JSON projection, never a privacy-safe export.
export function summariseLifecycle(command, view, attempts = []) {
  const state = view.lifecycle;
  const declaration = state?.declaration;
  return Object.freeze({
    command, runId: view.runId, manifestId: view.manifestId, state: view.state,
    diagnosis: view.diagnosis ?? null,
    findingCount: Array.isArray(view.findings) ? view.findings.length : null,
    guidance: view.diagnosis === 'incomplete'
      ? 'Preserve the run and use explicit reconciliation for the named interrupted operation.'
      : view.diagnosis === 'inconsistent'
        ? 'Preserve the run and inspect its verified diagnosis; no automatic repair was performed.' : null,
    startedAt: state?.startedAt ?? null, stoppedAt: state?.stoppedAt ?? null,
    elapsedMs: state?.elapsedMs ?? null,
    declaration: declaration == null ? null : Object.freeze({
      harness: declaration.harness ?? null, model: declaration.model ?? null,
      workerCount: declaration.workerCount ?? null, executionMode: declaration.executionMode,
      declaredCeilingMinutes: declaration.declaredCeilingMinutes ?? null,
    }),
    stopAssurance: view.stopAssurance ?? state?.stopAssurance ?? null,
    stopEnforced: view.enforced ?? (state?.stopAssurance === 'operator-attested' ? false : null),
    clockError: state?.clockError == null ? null : Object.freeze({ code: state.clockError.code, elapsedAvailable: false }),
    attempts: Object.freeze(attempts.map(({ start, terminal, execution }) => Object.freeze({
      attemptId: start.attemptId, snapshotId: start.snapshotId, frozenSubmissionId: start.frozenSubmissionId,
      status: terminal?.status ?? 'INCOMPLETE', evaluationId: terminal?.evaluationId ?? null,
      reportId: terminal?.reportId ?? null, reportDigest: terminal?.reportDigest ?? null,
      ...(execution === undefined ? {} : { publicationIntent: Object.freeze({
        evaluationId: execution.evaluationId, reportId: execution.reportId,
        evaluatorExecution: execution.evaluatorExecution,
      }) }),
    }))),
  });
}
