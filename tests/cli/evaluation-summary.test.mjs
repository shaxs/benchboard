// Synthetic projection proofs, not real CLI execution or C4 evidence or human judgment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summariseEvaluation } from '../../cli/evaluation-summary.mjs';

const CANARY = 'private-canary-not-a-diagnostic';

function syntheticReport(quality) {
  return {
    schemaVersion: '1.0.0', kind: 'Report', reportId: 'report-synthetic', createdAt: '2026-10-20T00:00:00.000Z',
    reportDigest: 'a'.repeat(64),
    bindings: { manifestId: 'manifest-synthetic', runId: 'run-synthetic' },
    configuration: { harness: CANARY, model: CANARY, workerCount: null, executionMode: 'MANUAL', declaredCeilingMinutes: null },
    execution: { agentOutcome: null, evaluatorExecution: 'SUCCESS', humanReview: 'NOT_REVIEWED', assessmentTrust: 'LOCAL_SELF_ASSESSMENT', enforcement: 'manual', enforced: false },
    quality,
    evidence: { evaluationId: 'eval-synthetic', bundleDigest: 'b'.repeat(64), bundle: { score: quality, logs: [CANARY], artifacts: [CANARY], operator: CANARY, configuration: CANARY, errors: [CANARY], roots: [CANARY] } },
    artifacts: [CANARY],
  };
}

const opened = { runId: 'run-synthetic', manifestId: 'manifest-synthetic', request: { storeRoot: CANARY } };
const attempt = { attemptId: 'attempt-synthetic', outputRoot: CANARY };
const terminal = { attemptId: 'attempt-synthetic', status: 'SUCCEEDED', evaluationId: 'eval-synthetic', reportId: 'report-synthetic', reportDigest: 'a'.repeat(64) };
const selection = { snapshotId: 'snap-synthetic', frozenSubmissionId: 'submission-synthetic', snapshotRoot: CANARY, workspaceMatchesFrozenInventory: false };

const KEYS = ['command', 'attemptId', 'runId', 'manifestId', 'snapshotId', 'frozenSubmissionId', 'evaluationId',
  'reportId', 'reportDigest', 'status', 'evaluatorExecution', 'humanReview', 'agentOutcome', 'enforcement',
  'enforced', 'automated', 'humanUI', 'quality', 'workspaceMatchesFrozenInventory'];

test('summary is exactly the named local identifiers, digests and statuses with no extra keys', () => {
  const result = summariseEvaluation({ opened, attempt, terminal, report: syntheticReport(null), selection });
  assert.deepEqual(Object.keys(result).sort(), [...KEYS].sort());
  assert.equal(result.command, 'evaluate');
  assert.equal(result.attemptId, 'attempt-synthetic');
  assert.equal(result.runId, 'run-synthetic');
  assert.equal(result.manifestId, 'manifest-synthetic');
  assert.equal(result.snapshotId, 'snap-synthetic');
  assert.equal(result.frozenSubmissionId, 'submission-synthetic');
  assert.equal(result.evaluationId, 'eval-synthetic');
  assert.equal(result.reportId, 'report-synthetic');
  assert.equal(result.reportDigest, 'a'.repeat(64));
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.evaluatorExecution, 'SUCCESS');
  assert.equal(result.humanReview, 'NOT_REVIEWED');
  assert.equal(result.agentOutcome, null);
  assert.equal(result.enforcement, 'manual');
  assert.equal(result.enforced, false);
  assert.equal(result.workspaceMatchesFrozenInventory, false);
  assert.ok(Object.isFrozen(result));
});

test('baseline report quality stays null rather than zero across automated humanUI and quality', () => {
  const result = summariseEvaluation({ opened, attempt, terminal, report: syntheticReport(null), selection });
  assert.equal(result.automated, null);
  assert.equal(result.humanUI, null);
  assert.equal(result.quality, null);
});

test('genuine automated zero and false drift stay themselves while pending human review stays null', () => {
  const zero = summariseEvaluation({ opened, attempt, terminal,
    report: syntheticReport({ automated: 0, automatedMaximum: 80, humanUI: null, humanMaximum: 20, quality: null, status: 'PARTIAL' }),
    selection: { ...selection, workspaceMatchesFrozenInventory: false } });
  assert.equal(zero.automated, 0);
  assert.equal(zero.humanUI, null);
  assert.equal(zero.quality, null);
  assert.equal(zero.workspaceMatchesFrozenInventory, false);
  const fractional = summariseEvaluation({ opened, attempt, terminal,
    report: syntheticReport({ automated: 62.5, automatedMaximum: 80, humanUI: null, humanMaximum: 20, quality: null, status: 'PARTIAL' }),
    selection });
  assert.equal(fractional.automated, 62.5);
});

test('canaries in roots, operator, raw error, worksheet, report configuration and evidence logs are never copied', () => {
  const report = syntheticReport(null);
  report.errors = [{ message: CANARY }];
  report.provenance = { parentReportId: null, review: { worksheet: CANARY }, sources: [CANARY] };
  const result = summariseEvaluation({ opened, attempt, terminal, report, selection });
  assert.equal(JSON.stringify(result).includes(CANARY), false);
  assert.equal(JSON.stringify(result).includes(CANARY.slice(0, 8)), false);
});

test('missing workspace observation projects to null and input objects are unchanged', () => {
  const selectionWithoutObservation = { snapshotId: 'snap-synthetic', frozenSubmissionId: 'submission-synthetic' };
  const report = syntheticReport(null);
  const snapshot = JSON.stringify({ opened, attempt, terminal, report, selection: selectionWithoutObservation });
  const result = summariseEvaluation({ opened, attempt, terminal, report, selection: selectionWithoutObservation });
  assert.equal(result.workspaceMatchesFrozenInventory, null);
  assert.equal(JSON.stringify({ opened, attempt, terminal, report, selection: selectionWithoutObservation }), snapshot);
});
