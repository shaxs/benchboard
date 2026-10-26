// Captain-owned policy tests. Synthetic views prove mapping only; subprocess acceptance is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFreezeRequest, parseRecoveryOptions, bindRecoveryIntent, summariseFreeze, summariseRecovery } from '../../cli/recovery-contract.mjs';
import { selectFromVerification, snapshotOption } from '../../cli/frozen-selection.mjs';
import { ArgumentError } from '../../cli/arguments.mjs';
import { CommandError } from '../../cli/command-error.mjs';
const digest = 'a'.repeat(64);
const operator = 'synthetic-operator';
const stopped = { operator, agentStopped: true, statement: 'Synthetic stopped-agent attestation.' };
const stoppedView = { diagnosis: 'consistent', state: 'STOP_RECORDED', lifecycle: { stopAttestation: stopped, elapsedMs: 0 } };
const category = expected => error => error instanceof CommandError && error.category === expected;

test('normal freeze uses exact bound stop attestation and rejects extra route claims', () => {
  const prepared = prepareFreezeRequest({}, stoppedView);
  assert.equal(prepared.attestation, stopped);
  assert.equal(prepared.clockless, false);
  for (const flag of ['--operator', '--agents-stopped']) assert.throws(() => prepareFreezeRequest({ [flag]: true }, stoppedView), ArgumentError);
});
test('clockless freeze needs explicit bounded attestation and only untouched consistent state', () => {
  const view = { diagnosis: 'consistent', state: 'INITIALIZED', lifecycle: null };
  assert.throws(() => prepareFreezeRequest({ '--clockless': true }, view), ArgumentError);
  const options = { '--clockless': true, '--operator': operator, '--agents-stopped': true };
  assert.equal(prepareFreezeRequest(options, view).attestation.clockless, true);
  assert.throws(() => prepareFreezeRequest({}, view), category('state'));
  assert.throws(() => prepareFreezeRequest(options, stoppedView), category('state'));
  assert.throws(() => prepareFreezeRequest({}, { ...stoppedView, state: 'RUNNING' }), category('state'));
  assert.throws(() => prepareFreezeRequest({}, { ...stoppedView, diagnosis: 'incomplete' }), category('state'));
  assert.throws(() => prepareFreezeRequest({}, { ...stoppedView, diagnosis: 'inconsistent' }), category('integrity'));
});
test('recovery grammar keeps distinct accepted decisions and exact digest/operator prerequisites', () => {
  for (const [operation, disposition] of [['start', 'COMPLETE'], ['stop', 'LEAVE_AS_IS'], ['freeze', 'KEEP_INTERRUPTED']]) {
    const parsed = parseRecoveryOptions({ '--operation': operation, '--disposition': disposition, '--operator': operator, '--intent': digest });
    assert.equal(parsed.operation, operation.toUpperCase());
    assert.equal(parsed.decision, disposition);
    assert.ok(Object.isFrozen(parsed));
  }
  const base = { '--operation': 'start', '--disposition': 'COMPLETE', '--operator': operator, '--intent': digest };
  for (const overrides of [{ '--operation': 'other' }, { '--disposition': 'KEEP_INTERRUPTED' }, { '--intent': '../canary' }, { '--operator': 'x' }, { '--intent': undefined }]) {
    assert.throws(() => parseRecoveryOptions({ ...base, ...overrides }), ArgumentError);
  }
});
test('intent binding uses actual public event shape, refuses wrong operation/digest and healthy no-op', () => {
  const parsed = { operation: 'START', intentDigest: digest };
  const view = { diagnosis: 'incomplete', journal: { events: [{ kind: 'START_INTENT', eventDigest: digest }] } };
  assert.doesNotThrow(() => bindRecoveryIntent(parsed, view));
  assert.throws(() => bindRecoveryIntent({ ...parsed, operation: 'FREEZE' }, view), category('state'));
  assert.throws(() => bindRecoveryIntent({ ...parsed, intentDigest: 'b'.repeat(64) }, view), category('state'));
  assert.throws(() => bindRecoveryIntent(parsed, { ...view, diagnosis: 'consistent' }), category('state'));
  assert.throws(() => bindRecoveryIntent(parsed, { diagnosis: 'incomplete', journal: { events: [{ event: view.journal.events[0] }] } }), category('state'));
});

test('intent binding refuses historical committed operations during another pending operation', () => {
  const start = { kind: 'START_INTENT', eventDigest: digest }, startCommit = { kind: 'START_COMMIT', eventDigest: 'b'.repeat(64) };
  const stop = { kind: 'STOP_RECORDED', eventDigest: 'c'.repeat(64) }, freeze = { kind: 'FREEZE_INTENT', eventDigest: 'd'.repeat(64) };
  const view = { state: 'STOP_RECORDED', diagnosis: 'incomplete', lifecycle: { stopAttestation: stopped },
    journal: { events: [start, startCommit, stop, freeze] } };
  for (const [operation, event] of [['START', start], ['STOP', stop]]) {
    assert.throws(() => bindRecoveryIntent({ operation, intentDigest: event.eventDigest }, view), category('state'));
  }
  assert.doesNotThrow(() => bindRecoveryIntent({ operation: 'FREEZE', intentDigest: freeze.eventDigest }, view));
  assert.doesNotThrow(() => bindRecoveryIntent({ operation: 'FREEZE', intentDigest: freeze.eventDigest }, { ...view, state: 'FROZEN' }));
  assert.throws(() => bindRecoveryIntent({ operation: 'FREEZE', intentDigest: freeze.eventDigest }, {
    ...view, journal: { events: [...view.journal.events, { kind: 'FREEZE_COMMIT', eventDigest: 'e'.repeat(64) }] } }), category('state'));
  const tornStop = { ...view, state: 'RUNNING', diagnosis: 'inconsistent', lifecycle: { stopAttestation: null }, journal: { events: [start, startCommit, stop] } };
  assert.doesNotThrow(() => bindRecoveryIntent({ operation: 'STOP', intentDigest: stop.eventDigest }, tornStop));
  assert.throws(() => bindRecoveryIntent({ operation: 'STOP', intentDigest: stop.eventDigest }, { ...tornStop, lifecycle: { stopAttestation: stopped } }), category('state'));
});
test('frozen selection refuses missing, ambiguous and damaged authority, while drift is disclosure', () => {
  const selected = { snapshotId: `snap-${'a'.repeat(32)}`, frozenSubmissionId: 'fsub-synthetic', snapshotRoot: 'synthetic-root', treeDigest: digest,
    fileCount: 26, byteCount: 100, frozenAt: '2026-01-01T00:00:00.000Z', ok: true };
  const verified = { ok: true, state: 'FROZEN', runFindings: [], submissions: [selected], workspace: { matchesFrozenInventory: false } };
  assert.equal(selectFromVerification(verified).workspaceMatchesFrozenInventory, false);
  assert.equal(selectFromVerification({ ...verified, workspace: null }).workspaceMatchesFrozenInventory, null);
  assert.throws(() => selectFromVerification({ ...verified, submissions: [] }), category('state'));
  assert.throws(() => selectFromVerification({ ...verified, submissions: [selected, selected] }), category('state'));
  assert.throws(() => selectFromVerification({ ...verified, ok: false }), category('integrity'));
  assert.throws(() => selectFromVerification({ ...verified, runFindings: ['private canary'] }), category('integrity'));
  assert.throws(() => snapshotOption('../private-canary'), ArgumentError);
  assert.equal(snapshotOption(selected.snapshotId), selected.snapshotId);
});
test('summary reports actual repair action and preserves genuine zero without raw operator/journal', () => {
  const opened = { runId: 'run-synthetic', manifestId: 'manifest-synthetic' };
  const result = { state: 'FROZEN', route: 'STOP_RECORDED', snapshotId: 'snap-synthetic', snapshotRoot: 'private-local-root',
    frozenSubmission: { frozenSubmissionId: 'fsub-synthetic' }, proof: { treeDigest: digest, fileCount: 26, byteCount: 100 },
    frozenAt: '2026-01-01T00:00:00.000Z', frozenAtProvenance: 'lifecycle.stoppedAt', stopAssurance: 'operator-attested', enforced: false };
  const summary = summariseFreeze(opened, result, { ...stoppedView, state: 'FROZEN' });
  assert.equal(summary.elapsedMs, 0);
  assert.equal(summary.stopEnforced, false);
  assert.equal(JSON.stringify(summary).includes(operator), false);
  const recovery = summariseRecovery(opened, { operation: 'STOP', decision: 'COMPLETE', intentDigest: digest },
    { action: 'LEAVE_AS_IS', diagnosis: 'inconsistent', history: ['private canary'] }, { state: 'RUNNING', diagnosis: 'inconsistent', findings: ['private canary'] });
  assert.equal(recovery.repaired, false);
  assert.equal(recovery.action, 'LEAVE_AS_IS');
  assert.equal(JSON.stringify(recovery).includes('private canary'), false);
});
