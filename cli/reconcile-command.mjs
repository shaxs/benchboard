/**
 * `cli/reconcile-command.mjs` — the thin explicit supported recovery command (C6.S5.T2).
 *
 * This adapter carries an operator's explicit reconciliation of one journaled
 * interrupted operation of one named run to the accepted recovery functions.
 * Every decision is stated by the operator and validated by
 * `parseRecoveryOptions`; the journaled intent is bound by
 * `bindRecoveryIntent` against the exact event kind and digest, and the
 * accepted core still rechecks its own authority under its own transaction.
 * This precheck is therefore a stated-intent match, not a generic CAS.
 *
 * What this command deliberately does not do:
 *   - it chooses no latest run and guesses nothing: operation, decision,
 *     operator and intent digest all come from the parsed options;
 *   - it adds no lock takeover, retry, timestamp forging or filesystem
 *     cleanup of orphan or foreign residue;
 *   - it relabels nothing after a late cancellation signal: the abort is
 *     checked before the options are parsed and again before the recovery is
 *     delegated, so an accepted reconciliation is returned as it was accepted;
 *   - it claims no repair beyond the accepted result: a STOP handed
 *     `COMPLETE` can come back `LEAVE_AS_IS` by the core's own refusal, and
 *     the summary states what was done, not what was requested.
 *
 * Errors are thrown unchanged (typed `CommandError`, `ArgumentError`,
 * `LifecycleError`, `StorageError`, `PathError`) and classified by
 * `cli/diagnostics.mjs`; nothing is written to any console here.
 */

import { reconcileRun, readRunLifecycle } from '../adapters/manual/index.mjs';
import { reconcileFreeze } from '../packages/core/freeze.mjs';
import { openSelectedRun } from './run-context.mjs';
import { CommandError } from './command-error.mjs';
import { parseRecoveryOptions, bindRecoveryIntent, summariseRecovery } from './recovery-contract.mjs';

function refuseIfAborted(signal) {
  if (signal?.aborted === true) throw new CommandError('cancelled');
}

const RECONCILE_ATTESTATION =
  'The operator explicitly dispositions this journaled operation; no lock or foreign residue is removed.';

/**
 * Explicit recovery: the operator names the run, the interrupted operation,
 * the journaled intent digest and the disposition. The command opens the run,
 * binds the stated intent to the journaled event, and delegates to the
 * accepted recovery function for the operation (freeze recovery for FREEZE,
 * run reconciliation for START/STOP). The returned summary is
 * `summariseRecovery`'s projection of the accepted result and the reread
 * lifecycle view.
 */
export async function reconcileCommand(options, { signal } = {}) {
  refuseIfAborted(signal);
  const parsed = parseRecoveryOptions(options);
  const opened = await openSelectedRun(options['--run']);
  const view = await readRunLifecycle(opened.request);
  bindRecoveryIntent(parsed, view);
  refuseIfAborted(signal);
  const result = parsed.operation === 'FREEZE'
    ? await reconcileFreeze({
        runRoot: opened.runRoot,
        manifestId: opened.manifestId,
        runId: opened.runId,
        intentDigest: parsed.intentDigest,
        operator: parsed.operator,
        decision: parsed.decision,
      })
    : await reconcileRun({
        ...opened.request,
        interruptedOperation: parsed.operation,
        disposition: {
          operator: parsed.operator,
          decision: parsed.decision,
          attestation: RECONCILE_ATTESTATION,
        },
      });
  const viewAfter = await readRunLifecycle(opened.request);
  return summariseRecovery(opened, parsed, result, viewAfter);
}
