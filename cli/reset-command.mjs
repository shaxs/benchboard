/**
 * `cli/reset-command.mjs` — the thin fresh-container reset command (C6.S9.T1).
 *
 * This adapter carries one operator-stated fresh-container reset to the
 * accepted core `resetRun`. The request/identity/path/dependency/protection/
 * source-cleanup policy belongs to the Captain's `./reset-context.mjs`:
 * `prepareResetContext` returns the validated, fixed accepted ResetRequest
 * together with the run it opened and its owned source disposal, and
 * `summariseReset` projects the accepted result into the local serializable
 * summary. This adapter adds no hooks, clocks or request fields of its own.
 *
 * The fixed steps, in order:
 *   1. refuse an already-aborted signal before any context work, then prepare
 *      the reset context;
 *   2. check the signal once more immediately before delegation, then run the
 *      accepted `resetRun` against the prepared request;
 *   3. dispose the prepared source in every case, preserving the original
 *      reset error, and report the summary together with the disposal result.
 *
 * What this command deliberately does not do:
 *   - it invents no new architecture: the accepted reset runs against the OLD
 *     architecture carried by the opened run, and the new run and manifest
 *     identities are minted by the accepted initialization behind `resetRun`;
 *   - it has no destructive or force mode, and `--source-root` is the
 *     dependency's locked source, not the old workspace;
 *   - it adds no request fields, clocks, hooks, callbacks, config or version
 *     discovery or runtime options to the accepted request;
 *   - it relabels nothing after a late signal: a signal that arrives after the
 *     reset has committed does not turn the committed reset into a cancellation;
 *   - it cleans or modifies no old container or old results and manually rolls
 *     back no new publication; the protected old results are stated to the
 *     core by the prepared request, and the core decides every outcome.
 *
 * Errors are thrown unchanged and classified by `cli/diagnostics.mjs`;
 * nothing is written to any console here.
 */

import { CommandError } from './command-error.mjs';
import { resetRun } from '../packages/core/reset.mjs';
import { prepareResetContext, summariseReset } from './reset-context.mjs';

/**
 * Run one fresh-container reset from the outer parser's frozen option map.
 *
 * @param {Readonly<Record<string, string | boolean>>} options the frozen outer
 *        parser map, with the exact long-flag spellings as keys
 * @param {{ signal?: AbortSignal }} [environment]
 * @returns {Promise<Readonly<object>>} the serializable reset summary with the
 *          command name, the source facts and the source-disposal result
 */
export async function resetCommand(options, { signal } = {}) {
  /* Refuse a signal that is already aborted before any context work at all. */
  if (signal?.aborted === true) throw new CommandError('cancelled');

  /* The context resolves the installed identities against the old bindings,
   * stages the exact original challenge source, applies the explicit
   * default-none dependency request, reads the old bound architecture and
   * statement, confines the output to an external fresh root and protects the
   * old results. It yields the fixed accepted request and its owned dispose. */
  const context = await prepareResetContext(options);

  let result;
  let sourceCleanup;
  try {
    /* Checked again immediately before delegation; a signal that arrives after
     * `resetRun` has committed is not used to relabel the committed reset. */
    if (signal?.aborted === true) throw new CommandError('cancelled');

    result = await resetRun(context.request);
  } finally {
    /* The disposal runs on both the success and the failure path. When the
     * reset threw, its exception is preserved: the finally block neither
     * returns nor throws, so the original error is what the caller sees.
     * `dispose()` is contractually nonthrowing; the guard is the narrow belt
     * so an unexpected disposal fault becomes a reported retained cleanup
     * rather than a second error competing with the reset's outcome. */
    try {
      sourceCleanup = context.dispose();
    } catch {
      sourceCleanup = Object.freeze({
        status: 'retained',
        root: context.request.initializationRequest.challenge.sourceRoot,
      });
    }
  }

  /* Reached only when `resetRun` returned: a thrown reset propagates out of
   * the finally block before this line runs. The summary restates the accepted
   * result and the disposal outcome, so a reader sees both facts. */
  return summariseReset(result, sourceCleanup);
}
