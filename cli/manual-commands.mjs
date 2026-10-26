/**
 * `cli/manual-commands.mjs` — thin manual lifecycle command adapters (C6.S4).
 *
 * These three adapters carry a parsed manual command to the accepted C3
 * lifecycle through the manual adapter index, and nothing else. They hold no
 * declaration or attestation grammar (that is `cli/manual-arguments.mjs`) and
 * no summary policy (that is `cli/lifecycle-summary.mjs`, Captain-owned). Each
 * returns only the summary object its summary projection produces; nothing is
 * written to any console, and the application layer serializes the result.
 *
 * What they deliberately do not do:
 *   - they add no execution collaborator, clock override, configuration lookup
 *     or process control; the identity request from `openSelectedRun` is passed
 *     through unchanged and the C3 default clock is the only clock in play;
 *   - they do not wrap C3 errors into messages of their own. A typed
 *     `LifecycleError`, `StorageError` or `CommandError` propagates as thrown
 *     and is classified by `cli/diagnostics.mjs`;
 *   - `statusCommand` never calls `ensureResultsContext` or reconciliation, does
 *     not invent a results context, repair an incomplete journal, steal a lock or
 *     choose a latest report. Accepted collaborators retain their own locks.
 *     An incomplete or inconsistent diagnosis is a
 *     verified status view, not a failure to repair;
 *   - a cancellation is refused before a run is opened, so a start or stop that
 *     reached C3 and committed is never relabelled as cancelled afterwards.
 */

import { startRun, stopRun, readRunLifecycle } from '../adapters/manual/index.mjs';
import { openSelectedRun, readResultsContext } from './run-context.mjs';
import { readEvaluationAttempts } from './attempt-records.mjs';
import { startDeclarationOf, stopAttestationOf } from './manual-arguments.mjs';
import { summariseLifecycle } from './lifecycle-summary.mjs';
import { CommandError } from './command-error.mjs';

function refuseIfAborted(signal) {
  if (signal?.aborted === true) throw new CommandError('cancelled');
}

/**
 * Manual start: build the declaration first (pure validation of the outer
 * flags), then open the selected run and hand C3 its own identity request
 * extended with that declaration. The returned view is summarised only.
 */
export async function startCommand(options, { signal } = {}) {
  refuseIfAborted(signal);
  const declaration = startDeclarationOf(options);
  const opened = await openSelectedRun(options['--run']);
  const view = await startRun({ ...opened.request, declaration });
  return summariseLifecycle('start', view);
}

/**
 * Manual stop: build the attestation first, then open the selected run and
 * record the operator statement through C3. C3 owns the refusal of a repeated
 * stop; that typed error propagates unchanged.
 */
export async function stopCommand(options, { signal } = {}) {
  refuseIfAborted(signal);
  const attestation = stopAttestationOf(options);
  const opened = await openSelectedRun(options['--run']);
  const view = await stopRun({ ...opened.request, attestation });
  return summariseLifecycle('stop', view);
}

/**
 * Manual status: read the verified lifecycle view, then attach the evaluation
 * attempts recorded against the run's results context when one exists. With no
 * context, attempts is the empty list; no context is created and no journal is
 * repaired.
 */
export async function statusCommand(options, { signal } = {}) {
  refuseIfAborted(signal);
  const opened = await openSelectedRun(options['--run']);
  const view = await readRunLifecycle(opened.request);
  const context = await readResultsContext(opened);
  const attempts = context === null ? [] : await readEvaluationAttempts(opened, context);
  return summariseLifecycle('status', view, attempts);
}
