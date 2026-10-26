/**
 * `cli/initialize-command.mjs` — the thin installed initialization adapter (C6.S3).
 *
 * This module adapts the frozen outer parser's option map to the accepted C2
 * handler `runInit` in `cli/init.mjs`. It owns no transaction: the C2 handler
 * and the core API behind it decide every outcome, and this adapter restates
 * nothing beyond what they returned. The fixed steps, in order:
 *
 *   1. refuse an already-aborted signal before any work;
 *   2. rebuild the accepted handler's argument list from the exact flag names
 *      the outer parser produced, so the accepted parser's mode and value
 *      validation runs before any installation or source work;
 *   3. load the installation, materialise the verified challenge source into an
 *      exclusive external temporary root, and run initialization against it;
 *   4. dispose the temporary source in all cases and report the result together
 *      with the nonthrowing disposal outcome.
 *
 * What it will not do, because the packet says so:
 *   - no config discovery, implicit installation, server, browser or collaborator
 *     injection, and no request or override hooks beyond the fixed list below;
 *   - no invented model, worker count, configuration or security model;
 *   - no automated invocation of install mode: automated work passes none,
 *     prepared or an explicit mode the operator stated, and the accepted
 *     `runInit` applies the `none` default when no mode was stated;
 *   - no relabelling of an already committed initialization as cancelled when a
 *     late signal arrives, and no promise of interruption of C2 work or agent
 *     termination.
 *
 * The security behaviour of source materialisation and disposal belongs to
 * the Captain's `./challenge-source.mjs`; this adapter only calls it.
 */

import { CommandError } from './command-error.mjs';
import { loadInstallation } from './installation.mjs';
import {
  parseArguments as parseInitializedArguments,
  runInit,
  summariseResult,
} from './init.mjs';
import { prepareChallengeSource } from './challenge-source.mjs';
import { createId } from '../packages/core/identity.mjs';

/** The dependency flags forwarded, in the fixed order, from the option map. */
const DEPENDENCY_FLAGS = Object.freeze([
  '--dependency-mode',
  '--prepared-root',
  '--source-root',
  '--scratch-root',
  '--npm-executable',
  '--expected-dependency-digest',
]);

/**
 * Run one installed initialization from the outer parser's frozen option map.
 *
 * @param {Readonly<Record<string, string | boolean>>} options the frozen outer
 *        parser map, with the exact long-flag spellings as keys
 * @param {{ signal?: AbortSignal }} [environment]
 * @returns {Promise<Readonly<object>>} the serializable run summary with the
 *          command name and the source-disposal result
 */
export async function initializeCommand(options, { signal } = {}) {
  /* Refuse a signal that is already aborted before any work of any kind. */
  if (signal?.aborted === true) throw new CommandError('cancelled');

  /* Rebuild the accepted handler's argument list: the output root first (it is
   * a positional to the accepted parser), then each supplied dependency flag in
   * the fixed order. The accepted parser then runs before any installation or
   * source work, so its mode and value validation applies unchanged. */
  const argv = [options['--output']];
  for (const flag of DEPENDENCY_FLAGS) {
    const value = options[flag];
    if (value !== void 0) argv.push(flag, value);
  }
  parseInitializedArguments(argv);

  const installation = loadInstallation();
  const prepared = prepareChallengeSource(installation);
  const challenge = Object.freeze({ ...installation.challenge, sourceRoot: prepared.sourceRoot });

  let result;
  let sourceCleanup;
  try {
    /* Checked again immediately before delegation; a signal that arrives after
     * `runInit` has committed is not used to relabel the committed run. */
    if (signal?.aborted === true) throw new CommandError('cancelled');

    result = await runInit({
      argv,
      challenge,
      toolingIdentity: installation.toolingIdentity,
      evaluatorIdentity: installation.evaluatorIdentity,
      statement: { architectureId: createId('architecture'), harness: 'manual' },
    });
  } finally {
    /* The disposal runs on both the success and the failure path. When the
     * run threw, its exception is preserved: the finally block neither returns
     * nor throws, so the disposal outcome of a failed run is not reported and
     * the original error is what the caller sees. `dispose()` is contractually
     * nonthrowing; the guard is the narrow belt so an unexpected disposal fault
     * becomes a reported retained cleanup rather than a second error
     * competing with the run's outcome. */
    try {
      sourceCleanup = prepared.dispose();
    } catch {
      sourceCleanup = Object.freeze({ status: 'retained', root: prepared.sourceRoot });
    }
  }

  /* Reached only when `runInit` returned. A retained source does not erase a
   * successfully initialized run: the summary restates the run and the cleanup
   * result states the cleanup, so a reader sees both facts. Nothing beyond the
   * accepted summary is serialized. */
  return Object.freeze({
    ...summariseResult(result),
    command: 'init',
    sourceCleanup,
  });
}
