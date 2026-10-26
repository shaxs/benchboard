// Captain-owned attempt/reference authority. A success reference requires a committed C5 baseline.
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../packages/core/manifest.mjs';
import { createStorage } from '../packages/core/storage.mjs';
import { createId } from '../packages/core/identity.mjs';
import { verifyFrozenSubmission } from '../packages/core/freeze.mjs';
import { readPublishedReport } from '../packages/results/publication.mjs';
import { verifyReportArtifacts } from '../packages/results/artifact-verification.mjs';
import { readResultsContext } from './results-context.mjs';
import { validateCliRecord } from './context-contract.mjs';
import { readOrdinaryJson, existingDirectory, exactKeys, rejectIntegrity } from './filesystem.mjs';
import { CommandError } from './command-error.mjs';
import { readExecutionRecord, assertExecutionTerminalAgreement } from './execution-contract.mjs';
const START = 'benchboard.cli.attempt.v1', TERMINAL = 'benchboard.cli.attempt-terminal.v1';
const safeId = id => {
  if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{2,127}$/.test(id)) rejectIntegrity();
  return id;
};
const startKey = id => ({ relativePath: `cli-attempts/${safeId(id)}/start.json`, kind: START, id });
const terminalKey = id => ({ relativePath: `cli-attempts/${safeId(id)}/terminal.json`, kind: TERMINAL, id });
async function verifiedContext(opened, supplied) {
  const actual = await readResultsContext(opened);
  if (actual === null || canonicalJson(actual) !== canonicalJson(supplied)) rejectIntegrity();
  return actual;
}
function bindings(context, value) {
  for (const field of ['contextId', 'runId', 'manifestId', 'manifestDigest']) if (value[field] !== context[field]) rejectIntegrity();
}
async function startOf(context, attemptId) {
  const key = startKey(attemptId);
  readOrdinaryJson(path.join(context.resultsRoot, key.relativePath));
  const value = validateCliRecord(await createStorage({ root: context.resultsRoot }).read(key));
  bindings(context, value);
  if (value.kind !== START || value.attemptId !== attemptId || value.outputRoot !== path.join(context.attemptsRoot, attemptId)) rejectIntegrity();
  return value;
}
async function verifyReport(context, start, terminal, physical = false) {
  if (terminal.reportId === null) return;
  safeId(terminal.reportId);
  const report = await readPublishedReport({ storeRoot: context.storeRoot, reportId: terminal.reportId });
  for (const field of ['runId', 'manifestId', 'manifestDigest', 'snapshotId', 'frozenSubmissionId']) {
    if (report.bindings[field] !== start[field]) rejectIntegrity();
  }
  if (report.evidence.evaluationId !== terminal.evaluationId || report.reportDigest !== terminal.reportDigest ||
      report.provenance.parentReportId !== null ||
      report.execution.evaluatorExecution !== (terminal.status === 'SUCCEEDED' ? 'SUCCESS' : 'INFRASTRUCTURE_ERROR')) rejectIntegrity();
  if (physical) {
    existingDirectory(start.outputRoot);
    verifyReportArtifacts(start.outputRoot, report.artifacts);
  }
}
export async function reserveEvaluationAttempt(opened, suppliedContext, selection) {
  exactKeys(selection, ['snapshotId', 'frozenSubmissionId']);
  selection = Object.freeze({ snapshotId: selection.snapshotId, frozenSubmissionId: selection.frozenSubmissionId });
  const context = await verifiedContext(opened, suppliedContext);
  const verified = await verifyFrozenSubmission({ ...opened.request, snapshotId: selection.snapshotId, frozenSubmissionId: selection.frozenSubmissionId });
  if (!verified.ok || verified.submissions.length !== 1 || !verified.submissions[0].ok) throw new CommandError('integrity');
  const attemptId = createId('attempt');
  const start = validateCliRecord({ kind: START, schemaVersion: '1.0.0', attemptId, contextId: context.contextId,
    runId: context.runId, manifestId: context.manifestId, manifestDigest: context.manifestDigest,
    snapshotId: verified.submissions[0].snapshotId, frozenSubmissionId: verified.submissions[0].frozenSubmissionId,
    outputRoot: path.join(context.attemptsRoot, attemptId) });
  await createStorage({ root: context.resultsRoot }).createImmutable({ ...startKey(attemptId), value: start });
  return startOf(context, attemptId);
}
export async function finishEvaluationAttempt(opened, suppliedContext, attemptId, disposition) {
  exactKeys(disposition, ['status', 'evaluationId', 'reportId']);
  disposition = Object.freeze({ status: disposition.status, evaluationId: disposition.evaluationId, reportId: disposition.reportId });
  const context = await verifiedContext(opened, suppliedContext);
  const storage = createStorage({ root: context.resultsRoot });
  return storage.withLock(async () => {
    await verifiedContext(opened, context);
    const start = await startOf(context, attemptId);
    const attempts = await attemptsOf(context);
    let reportDigest = null;
    if (disposition.reportId !== null) {
      safeId(disposition.reportId);
      reportDigest = (await readPublishedReport({ storeRoot: context.storeRoot, reportId: disposition.reportId })).reportDigest;
    }
    const terminal = validateCliRecord({ kind: TERMINAL, schemaVersion: '1.0.0', attemptId, contextId: context.contextId,
      runId: context.runId, manifestId: context.manifestId, manifestDigest: context.manifestDigest,
      ...disposition, reportDigest });
    assertExecutionTerminalAgreement(attempts.find(attempt => attempt.start.attemptId === attemptId)?.execution ?? null, terminal);
    // A committed evaluation/report is one attempt's evidence, never reusable success.
    for (const prior of attempts) {
      if (prior.start.attemptId === attemptId) continue;
      for (const source of [prior.terminal, prior.execution].filter(Boolean)) {
        for (const field of ['reportId', 'evaluationId']) {
          if (terminal[field] !== null && terminal[field] === source[field]) rejectIntegrity();
        }
      }
    }
    await verifyReport(context, start, terminal, true);
    // Use this instance so the nested immutable write joins its held root lock.
    await storage.createImmutable({ ...terminalKey(attemptId), value: terminal });
    return terminal;
  });
}
export async function readEvaluationAttempts(opened, suppliedContext) {
  return attemptsOf(await verifiedContext(opened, suppliedContext));
}
async function attemptsOf(context) {
  const directory = path.join(context.resultsRoot, 'cli-attempts');
  try { fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') return Object.freeze([]); throw error; }
  existingDirectory(directory);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length > 512) rejectIntegrity();
  const attempts = [], reportIds = new Set(), evaluationIds = new Set();
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) rejectIntegrity();
    const start = await startOf(context, safeId(entry.name)), key = terminalKey(entry.name);
    const terminalFile = path.join(context.resultsRoot, key.relativePath);
    let terminal = null, present = true;
    try { fs.lstatSync(terminalFile); } catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
    if (present) {
      readOrdinaryJson(terminalFile);
      terminal = validateCliRecord(await createStorage({ root: context.resultsRoot }).read(key));
      bindings(context, terminal);
      if (terminal.kind !== TERMINAL || terminal.attemptId !== start.attemptId) rejectIntegrity();
      await verifyReport(context, start, terminal);
    }
    const execution = await readExecutionRecord(context, start);
    assertExecutionTerminalAgreement(execution, terminal);
    for (const [field, assigned] of [['reportId', reportIds], ['evaluationId', evaluationIds]]) {
      const identity = execution?.[field] ?? terminal?.[field] ?? null;
      if (identity === null) continue;
      if (assigned.has(identity)) rejectIntegrity();
      assigned.add(identity);
    }
    attempts.push(Object.freeze({ start, terminal, ...(execution === null ? {} : { execution }) }));
  }
  return Object.freeze(attempts);
}
