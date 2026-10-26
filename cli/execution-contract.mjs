// Captain-owned optional execution-intent reader. Bookkeeping, not evaluator authentication.
import fs from 'node:fs';
import path from 'node:path';
import { createStorage } from '../packages/core/storage.mjs';
import { validateCliRecord } from './context-contract.mjs';
import { readOrdinaryJson, rejectIntegrity } from './filesystem.mjs';

export const EXECUTION_KIND = 'benchboard.cli.execution.v1';
export function executionKey(attemptId) {
  if (typeof attemptId !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{2,127}$/.test(attemptId)) rejectIntegrity();
  return { relativePath: `cli-attempts/${attemptId}/execution.json`, kind: EXECUTION_KIND, id: `${attemptId}:execution` };
}
export async function readExecutionRecord(context, start) {
  const key = executionKey(start.attemptId), file = path.join(context.resultsRoot, key.relativePath);
  try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  readOrdinaryJson(file);
  const record = validateCliRecord(await createStorage({ root: context.resultsRoot }).read(key));
  if (record.kind !== EXECUTION_KIND) rejectIntegrity();
  for (const field of ['attemptId', 'contextId', 'runId', 'manifestId', 'manifestDigest', 'snapshotId', 'frozenSubmissionId', 'outputRoot']) {
    if (record[field] !== start[field]) rejectIntegrity();
  }
  return record;
}
export function assertExecutionTerminalAgreement(execution, terminal) {
  if (execution === null || terminal === null) return;
  if (execution.evaluationId !== terminal.evaluationId || execution.reportId !== terminal.reportId || terminal.status === 'REFUSED' ||
      execution.evaluatorExecution !== (terminal.status === 'SUCCEEDED' ? 'SUCCESS' : 'INFRASTRUCTURE_ERROR')) rejectIntegrity();
}
