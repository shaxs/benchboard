/**
 * `cli/init.mjs` — the thin command-line handler for run initialisation (C2 / T3).
 *
 * Scope, stated plainly: this is a handler skeleton, not the product CLI. It
 * parses a bounded argument list, takes the challenge package and the tooling
 * and evaluator identities as explicitly supplied values, and delegates the
 * whole operation to `packages/core/init.mjs`. It owns no transaction of its own,
 * touches no filesystem, and reports no success of its own: whatever the API
 * reports is what the caller sees.
 *
 * What it will not do, because inventing it would be a defect rather than a
 * convenience:
 *   - it reads no configuration file, environment variable, DSH state or
 *     `runner/` directory, and infers no version, model, worker count, provider
 *     or security model;
 *   - it derives no identity. The caller hands the identities in, so a run can
 *     never be attributed to a tooling or evaluator binding nobody stated;
 *   - it accepts no unknown option and no positional extra. A mistyped flag is
 *     reported as a usage error rather than being silently dropped, because a
 *     silently dropped flag would change what a run claims about itself;
 *   - it performs no packaging, `package.json`, bin, version-publication or
 *     release work, and it starts, stops and evaluates nothing. Full CLI and
 *     product-identity packaging belong to C6/C7.
 *
 * Node builtins are not needed here at all: parsing and delegation are pure.
 */

import { initialiseRun, InitError, INIT_ERROR_CODES } from '../packages/core/init.mjs';
import { validateRecord } from '../packages/core/manifest.mjs';

/* -------------------------------------------------------------------------- */
/* Contract constants                                                          */
/* -------------------------------------------------------------------------- */

/** Stable identifier of this handler. */
export const CLI_MODULE_ID = 'benchboard.cli.init';

/** The one command this handler implements. */
export const CLI_COMMAND = 'init';

/** Modes this handler accepts, mirroring the API rather than restating a policy. */
export const CLI_DEPENDENCY_MODES = Object.freeze(['none', 'prepared', 'install']);

/**
 * Process exit statuses. Two are used deliberately: `2` means "the request was
 * wrong before any work could start", so no attempt was made at all; `1` means
 * "the API refused or failed", which is the API's decision and not this
 * handler's. The handler never exits `0` without a result object.
 */
export const CLI_EXIT_CODES = Object.freeze({
  /** The container was initialised and read back. */
  SUCCESS: 0,
  /** The API reported a refusal or a failure. */
  FAILURE: 1,
  /** The argument list was not usable, so nothing was attempted. */
  USAGE: 2,
});

/** Machine-readable handler refusal reasons. */
export const CLI_ERROR_CODES = Object.freeze({
  /** The argument list was empty or malformed. */
  USAGE: 'USAGE',
  /** An option this handler does not implement was supplied. */
  UNKNOWN_OPTION: 'UNKNOWN_OPTION',
  /** An option was supplied twice. */
  DUPLICATE_OPTION: 'DUPLICATE_OPTION',
  /** An option that needs a value was given none. */
  OPTION_VALUE_MISSING: 'OPTION_VALUE_MISSING',
  /** An option value is not valid for it. */
  OPTION_VALUE_INVALID: 'OPTION_VALUE_INVALID',
  /** The explicitly supplied package or identity is not acceptable to the API. */
  INPUT_INVALID: 'INPUT_INVALID',
});

/**
 * The challenge package shape as the accepted exporter declares it. Listed here
 * only so a plainly missing field is reported before the transaction starts; the
 * API owns the deep validation and remains the authority.
 */
export const CHALLENGE_PACKAGE_KEYS = Object.freeze([
  'identity',
  'sourceRoot',
  'fileManifest',
  'ownerRoots',
  'evaluatorRoots',
]);

/**
 * The command-line options this handler implements. The surface is deliberately
 * the one this CHUNK authorises — the output root plus the dependency mode and
 * what that mode needs — together with the architecture id, which the run cannot
 * be stated without. Everything else a run may declare is stated through the API
 * (see `INITIALIZABLE_STATEMENT_KEYS`), not as a flag, so this skeleton cannot
 * grow into the product CLI on its own.
 */
export const OPTION_SPECIFICATIONS = Object.freeze({
  '--dependency-mode': Object.freeze({ field: 'mode', kind: 'mode', group: 'dependencies' }),
  '--prepared-root': Object.freeze({ field: 'preparedRoot', kind: 'path', group: 'dependencies' }),
  '--source-root': Object.freeze({ field: 'sourceRoot', kind: 'path', group: 'dependencies' }),
  '--scratch-root': Object.freeze({ field: 'scratchRoot', kind: 'path', group: 'dependencies' }),
  '--npm-executable': Object.freeze({ field: 'npmExecutable', kind: 'path', group: 'dependencies' }),
  '--expected-dependency-digest': Object.freeze({
    field: 'expectedDependencyDigest', kind: 'digest', group: 'dependencies',
  }),
  '--architecture-id': Object.freeze({ field: 'architectureId', kind: 'text', group: 'statement' }),
});

/**
 * The run-statement fields accepted through `input.statement`. They are stated
 * explicitly by the caller or omitted; the API records an omitted one as unknown.
 * They are not command-line options in this chunk.
 */
export const INITIALIZABLE_STATEMENT_KEYS = Object.freeze([
  'architectureId',
  'architectureKind',
  'harness',
  'securityModel',
  'expectedSessionPolicy',
  'declaredCeilingMinutes',
  'configuration',
  'notes',
  'createdAt',
]);

/**
 * Options the full product CLI will need but this CHUNK does not implement. They
 * are refused by name instead of being accepted and ignored, so the boundary of
 * what is implemented here is machine-readable and does not silently expand.
 */
export const UNIMPLEMENTED_OPTIONS = Object.freeze([
  '--architecture-kind',
  '--harness',
  '--security-model',
  '--declared-ceiling-minutes',
  '--created-at',
  '--notes',
  '--worker-count',
  '--execution-mode',
  '--provider',
  '--model',
  '--version',
  '--config',
  '--dry-run',
  '--force',
  '--yes',
]);

/** Help text. It states the pending boundary in the same breath as the usage. */
export const CLI_USAGE = [
  'Usage: benchboard init <output> [options]',
  '',
  'Initialise one run container: publish the participant workspace, prepare the',
  'declared dependencies and write the immutable run state, then read the whole',
  'container back and revalidate it. The container must not exist yet.',
  '',
  'Options:',
  '  --dependency-mode none|prepared|install   default: none',
  '  --prepared-root <dir>                     required for mode prepared',
  '  --source-root <dir>                       lock/manifest source root',
  '  --scratch-root <dir>                      private install scratch root',
  '  --npm-executable <path>                   required for mode install',
  '  --expected-dependency-digest <hex64>      fail unless the result equals it',
  '  --architecture-id <id>                    the architecture id of the run itself',
  '  --help                                    print this text and exit successfully',
  '',
  'The challenge package, the tooling identity and the evaluator identity are',
  'supplied to the handler explicitly; no identity is derived from the machine.',
  'A run statement that is not stated is recorded as unknown, never as zero, and',
  'never guessed.',
  '',
  'Not implemented in this chunk (pending C6): the remaining run-statement options',
  '(architecture kind, harness, security model, ceiling, creation time, notes), a',
  'configuration file, worker count, execution mode, provider, model, version',
  'selection, force/overwrite and dry run. Those names are refused rather than',
  'ignored; pass a run statement through the API for now.',
].join('\n');

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** A handler-level refusal. It always means nothing was attempted. */
export class CliError extends Error {
  /**
   * @param {string} code one of `CLI_ERROR_CODES`
   * @param {string} message human-readable reason
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = void 0) {
    super(`${code}: ${message}`);
    this.name = 'CliError';
    this.code = String(code);
    if (details !== void 0) Object.assign(this, details);
  }
}

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Parse a flat argument list into the request parts this handler can state.
 *
 * The parser is deliberately strict: one positional output root, each option at
 * most once, no unknown option, and an unimplemented option named back to the
 * caller as unimplemented rather than dropped. It resolves nothing and creates
 * nothing, so a bad argument list costs nothing.
 *
 * @param {ReadonlyArray<string>} argv arguments after the command name
 * @returns {Readonly<object>} the parsed options
 */
export function parseArguments(argv) {
  if (!Array.isArray(argv))
    throw new CliError(CLI_ERROR_CODES.USAGE, 'the argument list must be an array of strings.');

  const positionals = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string')
      throw new CliError(CLI_ERROR_CODES.USAGE, `argument ${index} is not a string.`);

    if (token === '--help' || token === '-h') {
      options.set('--help', true);
      continue;
    }
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    if (UNIMPLEMENTED_OPTIONS.includes(token))
      throw new CliError(CLI_ERROR_CODES.UNKNOWN_OPTION,
        `${token} is not implemented by this chunk; it is pending C6 and is refused rather than ignored.`,
        { option: token, pendingChunk: 'C6' });
    const specification = OPTION_SPECIFICATIONS[token];
    if (specification === void 0)
      throw new CliError(CLI_ERROR_CODES.UNKNOWN_OPTION,
        `${token} is not an option of "${CLI_COMMAND}".`, { option: token });
    if (options.has(token))
      throw new CliError(CLI_ERROR_CODES.DUPLICATE_OPTION, `${token} was supplied more than once.`,
        { option: token });

    /* `--help` needs no value, and neither does any option here. */
    const value = argv[index + 1];
    if (value === void 0 || (value.startsWith('-') && value !== '-'))
      throw new CliError(CLI_ERROR_CODES.OPTION_VALUE_MISSING, `${token} needs a value.`,
        { option: token });
    index += 1;
    options.set(token, validateOptionValue(token, value, specification));
  }

  if (options.get('--help') === true)
    return Object.freeze({ help: true, output: null, statement: Object.freeze({}), dependencies: Object.freeze({}) });

  if (positionals.length !== 1)
    throw new CliError(CLI_ERROR_CODES.USAGE,
      positionals.length === 0
        ? `"${CLI_COMMAND}" needs exactly one output root.`
        : `"${CLI_COMMAND}" needs exactly one output root; got ${positionals.length}: ${positionals.join(', ')}.`,
      { positionals });

  return Object.freeze({
    help: false,
    output: positionals[0],
    statement: Object.freeze(buildStatement(options)),
    dependencies: Object.freeze(buildDependencies(options)),
  });
}

/** Validate one option value at the boundary, so a bad value never reaches the API as a surprise. */
function validateOptionValue(token, value, specification) {
  if (specification.kind === 'mode') {
    if (!CLI_DEPENDENCY_MODES.includes(value))
      throw new CliError(CLI_ERROR_CODES.OPTION_VALUE_INVALID,
        `${token} must be one of ${CLI_DEPENDENCY_MODES.join(', ')}; got ${JSON.stringify(value)}.`,
        { option: token });
    return value;
  }
  if (specification.kind === 'digest') {
    if (!/^[0-9a-f]{64}$/.test(value))
      throw new CliError(CLI_ERROR_CODES.OPTION_VALUE_INVALID,
        `${token} must be a lower-case hexadecimal sha256 digest; got ${JSON.stringify(value)}.`,
        { option: token });
    return value;
  }
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new CliError(CLI_ERROR_CODES.OPTION_VALUE_INVALID, `${token} needs a non-empty value.`,
      { option: token });
  return value;
}

/**
 * Collect the run-statement fields the command line stated. The set is derived
 * from the option table rather than listed twice, so the table stays the single
 * description of what is accepted.
 */
function buildStatement(options) {
  const statement = {};
  for (const [token, specification] of Object.entries(OPTION_SPECIFICATIONS)) {
    if (specification.group !== 'statement') continue;
    const value = options.get(token);
    if (value !== void 0) statement[specification.field] = value;
  }
  return statement;
}

/**
 * Collect the dependency request the command line stated, including its mode.
 *
 * This reports what was stated and invents nothing: a command line with no
 * `--dependency-mode` yields an empty request, because a parser that filled in a
 * mode could not be told apart from one that read one off the command line. The
 * meaning of an unstated mode — no dependencies — is applied once, in `runInit`,
 * where the command line becomes the request that reaches the API, so that
 * request is always complete and no mode is ever inferred from the machine the
 * handler runs on.
 */
function buildDependencies(options) {
  const dependencies = {};
  for (const [token, specification] of Object.entries(OPTION_SPECIFICATIONS)) {
    if (specification.group !== 'dependencies') continue;
    if (!options.has(token)) continue;
    dependencies[specification.field] = options.get(token);
  }
  return dependencies;
}

/* -------------------------------------------------------------------------- */
/* Delegation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Validate what the caller handed in and delegate the whole operation.
 *
 * The challenge package and the two identities must be supplied here: this
 * handler has no route to a definition file, an installed tool or an evaluator,
 * and inventing one would make the run's identity a side effect of the machine
 * it happened to be started on. Each of the three is checked against the
 * accepted contract before delegation, so a malformed one is reported as
 * `INPUT_INVALID` before any byte is written rather than as a deep failure
 * mid-transaction.
 *
 * @param {object} input
 * @param {ReadonlyArray<string>} input.argv arguments after the command name
 * @param {object} input.challenge the accepted challenge package
 * @param {object} input.toolingIdentity
 * @param {object} input.evaluatorIdentity
 * @param {Record<string, unknown>} [input.statement] run-statement fields, see
 *        `INITIALIZABLE_STATEMENT_KEYS`; the command line overrides them
 * @param {(record: object) => void} [input.onResult]
 * @returns {Promise<Readonly<object>>} the API result, unchanged
 */
export async function runInit(input) {
  if (!isPlainObject(input))
    throw new CliError(CLI_ERROR_CODES.USAGE, 'the handler needs an input object.');

  const parsed = parseArguments(Array.isArray(input.argv) ? input.argv : []);
  if (parsed.help === true) return Object.freeze({ help: true, usage: CLI_USAGE });

  /* The three inputs this handler cannot derive are checked here, at the
   * boundary, so a malformed one is reported as a bad request instead of
   * surfacing mid-transaction. The identities go through the accepted contract
   * validator; the package gets a key pre-check, because its deep validation —
   * the identity inside it, the boundary roots, the file manifest — belongs to
   * the API and is not duplicated here. */
  requirePlainInput('challenge', input.challenge);
  requirePlainInput('toolingIdentity', input.toolingIdentity);
  requirePlainInput('evaluatorIdentity', input.evaluatorIdentity);
  requirePackageKeys(input.challenge);
  requireValidIdentity('toolingIdentity', 'ToolingIdentity', input.toolingIdentity);
  requireValidIdentity('evaluatorIdentity', 'EvaluatorIdentity', input.evaluatorIdentity);

  const statement = mergeStatement(input.statement, parsed.statement);

  /* A dependency request that states no mode means no dependencies. The default
   * is applied here, at the one place where a command line becomes a request, so
   * the API always receives a complete request and the parser stays a reporter
   * of what was actually stated. */
  const dependencies = parsed.dependencies.mode === void 0
    ? Object.freeze({ ...parsed.dependencies, mode: 'none' })
    : parsed.dependencies;

  /* A run cannot be attributed to an architecture domain nobody named, and the
   * API agrees, so the requirement is stated here where the caller can act on it
   * instead of discovering it from a deep refusal. */
  if (typeof statement.architectureId !== 'string' || statement.architectureId.trim().length === 0)
    throw new CliError(CLI_ERROR_CODES.USAGE,
      'a run needs an architecture id; pass --architecture-id <id> or supply statement.architectureId.',
      { option: '--architecture-id' });

  const request = Object.freeze({
    output: parsed.output,
    challenge: input.challenge,
    dependencies,
    toolingIdentity: input.toolingIdentity,
    evaluatorIdentity: input.evaluatorIdentity,
    ...statement,
  });

  /* The API is the only authority over the outcome, so its result is returned
   * verbatim: the caller sees the same sealed manifest and the same digests. */
  const result = await delegateRun(request);
  if (typeof input.onResult === 'function') input.onResult(result);
  return result;
}

/**
 * Merge the caller's explicit run statement with what the command line stated.
 *
 * Only fields the API accepts may appear, so a mistyped statement key is refused
 * here rather than reaching the request and being reported as a deep refusal.
 * The command line wins, because it is the more immediate statement of intent.
 */
function mergeStatement(explicit, fromArguments) {
  if (explicit !== void 0 && !isPlainObject(explicit))
    throw new CliError(CLI_ERROR_CODES.OPTION_VALUE_INVALID,
      'statement must be an object of run-statement fields.', { input: 'statement' });

  const source = explicit ?? {};
  const unexpected = Object.keys(source).filter((key) => !INITIALIZABLE_STATEMENT_KEYS.includes(key));
  if (unexpected.length > 0)
    throw new CliError(CLI_ERROR_CODES.OPTION_VALUE_INVALID,
      `statement carries unrecognised field(s): ${unexpected.join(', ')}. `
      + `This handler forwards only: ${INITIALIZABLE_STATEMENT_KEYS.join(', ')}.`,
      { input: 'statement', unexpected });

  return { ...source, ...fromArguments };
}

/** The single delegation point, factored out so the seam is explicit. */
async function delegateRun(request) {
  return initialiseRun(request);
}

function requirePlainInput(name, value) {
  if (!isPlainObject(value))
    throw new CliError(CLI_ERROR_CODES.INPUT_INVALID,
      `${name} must be supplied to this handler explicitly; it is not discovered from the machine.`,
      { input: name });
}

/**
 * Pre-check the package keys only. The package's own validation — the identity it
 * carries, the boundary roots, the manifest against the bytes — is the API's, and
 * restating it here would create a second, weaker copy that could drift.
 */
function requirePackageKeys(challenge) {
  const missing = CHALLENGE_PACKAGE_KEYS.filter((key) => !(key in challenge));
  if (missing.length > 0)
    throw new CliError(CLI_ERROR_CODES.INPUT_INVALID,
      `challenge is missing field(s): ${missing.join(', ')}. The package is stated, not assembled by the handler.`,
      { input: 'challenge', missing });
  const unexpected = Object.keys(challenge).filter((key) => !CHALLENGE_PACKAGE_KEYS.includes(key));
  if (unexpected.length > 0)
    throw new CliError(CLI_ERROR_CODES.INPUT_INVALID,
      `challenge carries unrecognised field(s): ${unexpected.join(', ')}.`,
      { input: 'challenge', unexpected });
}

function requireValidIdentity(name, kind, value) {
  try {
    validateRecord(kind, value);
  } catch (cause) {
    throw new CliError(CLI_ERROR_CODES.INPUT_INVALID,
      `${name} does not satisfy the accepted ${kind} contract: ${cause?.message ?? String(cause)}`,
      { input: name, cause });
  }
}

/* -------------------------------------------------------------------------- */
/* Process entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Run one command line and report a process exit status.
 *
 * Output is written through the supplied sinks so the handler stays testable
 * and never assumes a terminal. On success the concise summary is printed; on a
 * refusal the API's own code and message are printed, because the API's reason is
 * the reason the caller needs.
 *
 * @param {object} input the same input as `runInit`
 * @param {object} [sinks] where output goes
 * @param {(text: string) => void} [sinks.write]
 * @param {(text: string) => void} [sinks.writeError]
 * @returns {Promise<number>} one of `CLI_EXIT_CODES`
 */
export async function main(input, sinks = void 0) {
  const write = typeof sinks?.write === 'function' ? sinks.write : (text) => process.stdout.write(`${text}\n`);
  const writeError = typeof sinks?.writeError === 'function'
    ? sinks.writeError
    : (text) => process.stderr.write(`${text}\n`);

  try {
    const result = await runInit(input);
    if ('help' in result && result.help === true) {
      write(result.usage);
      return CLI_EXIT_CODES.SUCCESS;
    }
    write(JSON.stringify(summariseResult(result), void 0, 2));
    return CLI_EXIT_CODES.SUCCESS;
  } catch (error) {
    /* A handler refusal means nothing was attempted, so it is a usage status and
     * the handler's own code. Anything else came from the API, whose code is the
     * reason the caller needs and is therefore reported verbatim. Only an error
     * that is neither of those is reported as internal, rather than being given a
     * code it did not earn.
     *
     * Both error classes put their code at the front of the message when they are
     * built, so the message is printed as it stands: prefixing it again would
     * report `OUTPUT_EXISTS: OUTPUT_EXISTS: …` and make the line the caller
     * parses lie about how many fields it has. An error from neither class
     * carries no code of its own, which is the one case worth naming. */
    if (error instanceof CliError) {
      const note = error.pendingChunk === 'C6'
        ? `\nRun "benchboard ${CLI_COMMAND} --help" for what this chunk implements.`
        : '';
      writeError(`${error.message}${note}`);
      return CLI_EXIT_CODES.USAGE;
    }
    if (error instanceof InitError) {
      writeError(error.message);
      return CLI_EXIT_CODES.FAILURE;
    }
    /* A failure raised by a collaborator rather than by this seam keeps the code
     * the collaborator gave it: a dependency refusal reports the dependency
     * layer's code, because that is the reason the caller can act on. Relabelling
     * it as an internal fault would name the wrong component. An error with a code
     * whose message already leads with it is printed as it stands; one whose code
     * is not in the message gets the code put in front of it, once. Only an error
     * that carries no code at all is reported as internal. */
    const reportedCode = typeof error?.code === 'string' && error.code.length > 0 ? error.code : void 0;
    if (reportedCode === void 0) {
      writeError(`${INIT_ERROR_CODES.INTERNAL}: ${error?.message ?? String(error)}`);
      return CLI_EXIT_CODES.FAILURE;
    }
    const reportedMessage = typeof error.message === 'string' ? error.message : String(error);
    writeError(reportedMessage.startsWith(`${reportedCode}: `)
      ? reportedMessage
      : `${reportedCode}: ${reportedMessage}`);
    return CLI_EXIT_CODES.FAILURE;
  }
}

/** The concise success summary. It restates no digest and adds no claim. */
export function summariseResult(result) {
  return Object.freeze({
    status: 'initialised',
    output: result.output,
    workspaceRoot: result.workspace.root,
    stateRoot: result.state.root,
    workloadDigest: result.workload.digest,
    workloadFileCount: result.workload.fileCount,
    dependencyMode: result.dependency.mode,
    dependencyDigest: result.dependency.digest,
    manifestId: result.manifest.manifestId,
    runId: result.manifest.runId,
    durationMs: result.durationMs,
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
