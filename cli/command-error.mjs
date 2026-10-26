// Pure command error vocabulary: help and usage do not load operational schemas.
export const CATEGORIES = Object.freeze({
  usage: Object.freeze({ exitCode: 2, code: 'CLI_USAGE', guidance: 'Check command flags with --help; no command work was started.' }),
  state: Object.freeze({ exitCode: 3, code: 'CLI_STATE', guidance: 'Check status, prerequisites and fresh destinations; evaluate requires an explicitly frozen submission. Use explicit reconcile for interrupted operations. Never remove or steal a lock.' }),
  integrity: Object.freeze({ exitCode: 4, code: 'CLI_INTEGRITY', guidance: 'Inputs or paths failed verification; preserve the local evidence and check identities, links and root separation.' }),
  infrastructure: Object.freeze({ exitCode: 5, code: 'CLI_INFRASTRUCTURE', guidance: 'Command did not complete; check local prerequisites and retained state before retrying. No score or completion is implied.' }),
  cancelled: Object.freeze({ exitCode: 130, code: 'CLI_CANCELLED', guidance: 'Cancellation handled; cleanup was awaited. Check status and retained local evidence before retrying.' }),
  unavailable: Object.freeze({ exitCode: 3, code: 'COMMAND_UNAVAILABLE', guidance: 'This development checkout has not connected this command yet; no command work was started.' }),
});
export class CommandError extends Error {
  constructor(category) {
    if (!Object.hasOwn(CATEGORIES, category)) throw new TypeError('Unknown command error category');
    super(CATEGORIES[category].code);
    this.category = category;
  }
}
