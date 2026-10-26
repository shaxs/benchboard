// Captain-owned route, attestation, intent and summary policy over accepted C3.
import { ArgumentError } from './arguments.mjs';
import { CommandError } from './command-error.mjs';
import { stopAttestationOf } from './manual-arguments.mjs';

export function prepareFreezeRequest(options, view) {
  const clockless = options['--clockless'] === true;
  if (!clockless && (Object.hasOwn(options, '--operator') || Object.hasOwn(options, '--agents-stopped'))) throw new ArgumentError('INVALID_VALUE');
  const attestation = clockless ? Object.freeze({ ...stopAttestationOf(options), clockless: true }) : view.lifecycle?.stopAttestation;
  if (view.diagnosis === 'inconsistent') throw new CommandError('integrity');
  if (view.diagnosis !== 'consistent' || view.state !== (clockless ? 'INITIALIZED' : 'STOP_RECORDED')) throw new CommandError('state');
  if (!attestation || attestation.agentStopped !== true) throw new CommandError('integrity');
  return Object.freeze({ attestation, clockless });
}

export function parseRecoveryOptions(options) {
  const operations = { start: 'START', stop: 'STOP', freeze: 'FREEZE' };
  const operation = Object.hasOwn(operations, options['--operation']) ? operations[options['--operation']] : null;
  const decision = options['--disposition'], intentDigest = options['--intent'];
  if (operation === null || !(operation === 'FREEZE' ? ['COMPLETE', 'KEEP_INTERRUPTED'] : ['COMPLETE', 'LEAVE_AS_IS']).includes(decision) ||
      typeof intentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(intentDigest)) throw new ArgumentError('INVALID_VALUE');
  const operator = stopAttestationOf({ '--operator': options['--operator'], '--agents-stopped': true }).operator;
  return Object.freeze({ operation, decision, operator, intentDigest });
}

export function bindRecoveryIntent(parsed, view) {
  if (view.diagnosis === 'consistent') throw new CommandError('state');
  const kind = { START: 'START_INTENT', STOP: 'STOP_RECORDED', FREEZE: 'FREEZE_INTENT' }[parsed.operation];
  // The accepted public view exposes event values, not internal {event} wrappers.
  const events = view.journal?.events ?? [];
  const count = eventKind => events.filter(event => event?.kind === eventKind).length;
  const matches = events.filter(event => event?.kind === kind);
  if (matches.length !== 1 || matches[0].eventDigest !== parsed.intentDigest) throw new CommandError('state');
  // A historical intent is not permission to reconcile a different later fault.
  const startPending = count('START_INTENT') === 1 && count('START_COMMIT') === 0;
  const freezePending = count('FREEZE_INTENT') === 1 && count('FREEZE_COMMIT') === 0;
  const stopPending = count('STOP_RECORDED') === 1 && view.state === 'RUNNING' && view.lifecycle?.stopAttestation == null;
  const pending = { START: startPending && !freezePending && count('STOP_RECORDED') === 0,
    STOP: stopPending && !startPending && count('FREEZE_INTENT') === 0,
    FREEZE: freezePending && !startPending };
  if (pending[parsed.operation] !== true) throw new CommandError('state');
}

export function summariseFreeze(opened, result, viewAfter) {
  return Object.freeze({ command: 'freeze', runId: opened.runId, manifestId: opened.manifestId,
    state: result.state, diagnosis: viewAfter.diagnosis, route: result.route,
    snapshotId: result.snapshotId, frozenSubmissionId: result.frozenSubmission.frozenSubmissionId,
    snapshotRoot: result.snapshotRoot, treeDigest: result.proof.treeDigest,
    fileCount: result.proof.fileCount, byteCount: result.proof.byteCount,
    frozenAt: result.frozenAt, frozenAtProvenance: result.frozenAtProvenance,
    elapsedMs: viewAfter.lifecycle?.elapsedMs ?? null, stopAssurance: result.stopAssurance ?? null,
    stopEnforced: result.enforced });
}

export function summariseRecovery(opened, parsed, result, viewAfter) {
  const action = result.action ?? result.decision;
  return Object.freeze({ command: 'reconcile', runId: opened.runId, manifestId: opened.manifestId,
    operation: parsed.operation, intentDigest: parsed.intentDigest, requestedDisposition: parsed.decision,
    action, repaired: result.repaired ?? (action === 'COMPLETE' && result.diagnosis === 'repaired'),
    retained: true, state: viewAfter.state, diagnosis: viewAfter.diagnosis,
    snapshotId: result.snapshotId ?? null, findingCount: viewAfter.findings?.length ?? 0 });
}
