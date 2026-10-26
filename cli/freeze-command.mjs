/**
 * `cli/freeze-command.mjs` — the thin stopped-and-clockless freeze command (C6.S5).
 *
 * This adapter carries a parsed manual freeze to the accepted core `freezeRun`
 * and nothing else. It adds no execution collaborator, no clock, no runtime and
 * no configuration or version inference: the route and attestation policy lives
 * in `cli/recovery-contract.mjs` (Captain-owned), the identity request comes
 * from `openSelectedRun` unchanged, and the summary is exactly what
 * `summariseFreeze` returns — private local serializable command facts only.
 *
 * What it deliberately does not do:
 *   - it passes no hooks, operationName, notes or clock to `freezeRun`; the core
 *     defaults stand. The normal route reuses the bound stop attestation the
 *     run already carries; the clockless route carries the operator's explicit
 *     `--clockless` flag with operator/true, never an inferred stop;
 *   - a cancellation is refused before any read and once more immediately before
 *     `freezeRun` is entered; after the core returns, its result is reported as
 *     it is — no late-signal relabeling of a committed freeze;
 *   - there is no implicit reconciliation, no automatic second freeze, no lock
 *     stealing and no cleanup of material this command did not create. A
 *     journaled freeze intent is the core's RECOVERY_REQUIRED report, left to
 *     the explicit recovery command;
 *   - exceptions propagate unchanged for controlled diagnostic classification
 *     by `cli/diagnostics.mjs`.
 */

import { readRunLifecycle } from '../adapters/manual/index.mjs';
import { openSelectedRun } from './run-context.mjs';
import { freezeRun } from '../packages/core/freeze.mjs';
import { CommandError } from './command-error.mjs';
import { prepareFreezeRequest, summariseFreeze } from './recovery-contract.mjs';

/**
 * Manual freeze: read the verified lifecycle view, let the Captain's contract
 * validate the route and attestation against it, then freeze through the core
 * and summarise. No parameter here accepts a collaborator, clock or runtime.
 */
export async function freezeCommand(options, { signal } = {}) {
  if (signal?.aborted === true) throw new CommandError('cancelled');
  const opened = await openSelectedRun(options['--run']);
  const view = await readRunLifecycle(opened.request);
  const prepared = prepareFreezeRequest(options, view);
  if (signal?.aborted === true) throw new CommandError('cancelled');
  const result = await freezeRun({ ...opened.request, ...prepared });
  const viewAfter = await readRunLifecycle(opened.request);
  return summariseFreeze(opened, result, viewAfter);
}
