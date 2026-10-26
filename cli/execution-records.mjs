// Captain-owned returned-evaluation/publication association. No public evaluator collaborator seam.
import { createStorage } from '../packages/core/storage.mjs';
import { validateCliRecord } from './context-contract.mjs';
import { readEvaluationAttempts } from './attempt-records.mjs';
import { readExecutionRecord, executionKey, EXECUTION_KIND } from './execution-contract.mjs';
import { exactKeys, rejectIntegrity } from './filesystem.mjs';
import { CommandError } from './command-error.mjs';

export async function recordEvaluationExecution(opened, context, attemptId, facts) {
  exactKeys(facts, ['evaluationId', 'reportId', 'evaluatorExecution']);
  // Capture before the first await. Only closed primitive fields enter the record.
  const captured = Object.freeze({ evaluationId: facts.evaluationId, reportId: facts.reportId, evaluatorExecution: facts.evaluatorExecution });
  for (const value of [captured.evaluationId, ...(captured.reportId === null ? [] : [captured.reportId])]) {
    if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{2,127}$/.test(value)) rejectIntegrity();
  }
  if (!['SUCCESS', 'INFRASTRUCTURE_ERROR'].includes(captured.evaluatorExecution) ||
      (captured.evaluatorExecution === 'SUCCESS' && captured.reportId === null)) rejectIntegrity();
  context = Object.freeze({ ...context });
  // Verify the supplied root binding before acquiring any write lock there.
  await readEvaluationAttempts(opened, context);
  const storage = createStorage({ root: context.resultsRoot });
  return storage.withLock(async () => {
    const attempts = await readEvaluationAttempts(opened, context);
    const current = attempts.find(attempt => attempt.start.attemptId === attemptId);
    if (!current) rejectIntegrity();
    if (current.terminal !== null) throw new CommandError('state');
    const { kind: ignoredKind, ...bindings } = current.start;
    const execution = validateCliRecord({ ...bindings, kind: EXECUTION_KIND, ...captured });
    if (execution.kind !== EXECUTION_KIND) rejectIntegrity();
    for (const prior of attempts) {
      if (prior.start.attemptId === attemptId) continue;
      for (const source of [prior.execution, prior.terminal].filter(Boolean)) {
        for (const field of ['evaluationId', 'reportId']) if (execution[field] !== null && execution[field] === source[field]) rejectIntegrity();
      }
    }
    await storage.createImmutable({ ...executionKey(attemptId), value: execution });
    return readExecutionRecord(context, current.start);
  });
}
