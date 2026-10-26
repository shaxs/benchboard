// Synthetic projection proofs, not real CLI/lifecycle execution evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summariseLifecycle } from '../../cli/lifecycle-summary.mjs';
const base = { runId: 'run-synthetic', manifestId: 'manifest-synthetic', state: 'INITIALIZED', lifecycle: null,
  diagnosis: 'consistent', findings: [] };
test('summary preserves unknown lifecycle values as null rather than inventing zero', () => {
  const result = summariseLifecycle('status', base);
  assert.equal(result.elapsedMs, null);
  assert.equal(result.startedAt, null);
  assert.equal(result.stoppedAt, null);
  assert.equal(result.declaration, null);
  assert.equal(result.stopAssurance, null);
  assert.equal(result.stopEnforced, null);
  assert.equal(result.findingCount, 0);
  assert.deepEqual(result.attempts, []);
  assert.ok(Object.isFrozen(result));
});
test('summary retains genuine elapsed zero and false enforcement while excluding raw private objects', () => {
  const canary = 'private-canary-not-a-diagnostic';
  const view = { ...base, state: 'STOP_RECORDED', rawError: { message: canary }, toJSON() { throw Error(canary); },
    lifecycle: { elapsedMs: 0, startedAt: null, stoppedAt: null, stopAssurance: 'operator-attested',
      stopAttestation: { statement: canary }, history: [canary], clockError: { code: 'CLOCK_INVALID', error: canary },
      declaration: { harness: 'manual', model: null, workerCount: null, executionMode: 'MANUAL', declaredCeilingMinutes: null } },
    journal: { events: [{ private: canary }] } };
  const result = summariseLifecycle('stop', view);
  assert.equal(result.elapsedMs, 0);
  assert.equal(result.stopEnforced, false);
  assert.equal(result.declaration.model, null);
  assert.deepEqual(result.clockError, { code: 'CLOCK_INVALID', elapsedAvailable: false });
  assert.equal(JSON.stringify(result).includes(canary), false);
});
test('diagnosis remains separate from lifecycle state and incomplete attempts stay incomplete', () => {
  const attempts = [{ start: { attemptId: 'attempt-synthetic', snapshotId: 'snapshot-synthetic', frozenSubmissionId: 'submission-synthetic', outputRoot: 'private-path' }, terminal: null }];
  const result = summariseLifecycle('status', { ...base, state: 'RUNNING', diagnosis: 'incomplete', findings: ['private-text'] }, attempts);
  assert.equal(result.state, 'RUNNING');
  assert.equal(result.diagnosis, 'incomplete');
  assert.equal(result.findingCount, 1);
  assert.match(result.guidance, /explicit reconciliation/);
  assert.equal(result.attempts[0].status, 'INCOMPLETE');
  assert.equal(result.attempts[0].evaluationId, null);
  assert.equal(result.attempts[0].reportId, null);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});
