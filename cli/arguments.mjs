/**
 * `cli/arguments.mjs` — the strict, pure argument parser for the checkout CLI (C6.S1).
 *
 * `parseArguments(argv)` accepts only the grammar described by the Captain-owned
 * `COMMANDS` table in `cli/command-contract.mjs`. It performs no work of its own:
 * no filesystem, process or environment access, and no command handler is invoked
 * during parsing.
 *
 * Grammar summary (all rejections raise `ArgumentError` with a fixed message that
 * never contains caller data):
 *   - no arguments, or a leading `--help`/`-h`, returns global help;
 *   - `<command> --help` returns that command's help. Help still validates every
 *     supplied token, but required flags are enforced only when help is false;
 *   - long options only (`--name value` or `--name` for booleans), plus the `-h`
 *     alias for `--help`. Equals syntax, short options other than `-h`, and
 *     positional operands are refused;
 *   - a value that is absent or begins with `-` is a missing value; an empty or
 *     whitespace-only value is an invalid value;
 *   - duplicates are refused, and `-h` and `--help` are one option for this rule;
 *   - the argument list is bounded (128 arguments, 4096 characters per argument).
 *
 * Returned structures are frozen. Keys in `options` retain the exact long flag
 * spellings from the command contract.
 */

import { COMMANDS } from './command-contract.mjs';

/** The most arguments a single invocation may carry. */
export const MAX_ARGUMENTS = 128;
/** The most characters any single argument may carry. */
export const MAX_ARGUMENT_LENGTH = 4096;

/** The closed set of parser error codes. */
export const ARGUMENT_ERROR_CODES = Object.freeze({
  USAGE: 'USAGE',
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
  UNKNOWN_OPTION: 'UNKNOWN_OPTION',
  DUPLICATE_OPTION: 'DUPLICATE_OPTION',
  MISSING_VALUE: 'MISSING_VALUE',
  MISSING_OPTION: 'MISSING_OPTION',
  INVALID_VALUE: 'INVALID_VALUE',
});

// Fixed messages. Caller data is deliberately absent from every one of them.
const MESSAGES = Object.freeze({
  USAGE: 'The arguments do not match the accepted command grammar.',
  UNKNOWN_COMMAND: 'The command is not a known BenchBoard command.',
  UNKNOWN_OPTION: 'An option is not defined for this command.',
  DUPLICATE_OPTION: 'An option was supplied more than once.',
  MISSING_VALUE: 'An option that takes a value was not given one.',
  MISSING_OPTION: 'A required option for this command was not supplied.',
  INVALID_VALUE: 'An option value is not acceptable.',
});

/** A usage-class parsing failure carrying one of the closed error codes. */
export class ArgumentError extends Error {
  constructor(code) {
    if (!Object.hasOwn(MESSAGES, code)) throw new TypeError('Unknown argument error code');
    super(MESSAGES[code]);
    this.name = 'ArgumentError';
    this.code = code;
  }
}

const HELP_KEY = '--help';
// A well-formed long flag name: a letter followed by letters, digits or dashes.
// A token starting with '--' that fails this is a usage error, not an unknown option.
const LONG_FLAG = /^[A-Za-z][A-Za-z0-9-]*$/;

function frozenResult(command, help, options) {
  return Object.freeze({ command, help, options: Object.freeze(options) });
}

// A leading flag position: only the help flag may appear, with no other token
// besides additional help spellings (which the duplicate rule refuses).
function parseGlobalHelp(argv) {
  let seenHelp = false;
  for (const token of argv) {
    if (token === '--help' || token === '-h') {
      if (seenHelp) throw new ArgumentError(ARGUMENT_ERROR_CODES.DUPLICATE_OPTION);
      seenHelp = true;
      continue;
    }
    if (!token.startsWith('-')) throw new ArgumentError(ARGUMENT_ERROR_CODES.USAGE);
    if (token.startsWith('--')) {
      const name = token.slice(2);
      if (name.length === 0 || token.includes('=')) {
        throw new ArgumentError(ARGUMENT_ERROR_CODES.USAGE);
      }
      if (!LONG_FLAG.test(name)) throw new ArgumentError(ARGUMENT_ERROR_CODES.USAGE);
      throw new ArgumentError(ARGUMENT_ERROR_CODES.UNKNOWN_OPTION);
    }
    throw new ArgumentError(ARGUMENT_ERROR_CODES.USAGE);
  }
  return frozenResult(null, true, {});
}

/**
 * Parse `argv` against the command contract and return
 * `{ command, help, options }`. `command` is null only for global help;
 * `options` is empty for global help. All returned structures are frozen.
 */
export function parseArguments(argv) {
  if (!Array.isArray(argv)) throw new ArgumentError(ARGUMENT_ERROR_CODES.USAGE);
  if (argv.length > MAX_ARGUMENTS) throw new ArgumentError(ARGUMENT_ERROR_CODES.USAGE);
  for (const token of argv) {
    if (typeof token !== 'string') throw new ArgumentError(ARGUMENT_ERROR_CODES.INVALID_VALUE);
    if (token.length > MAX_ARGUMENT_LENGTH) throw new ArgumentError(ARGUMENT_ERROR_CODES.USAGE);
  }

  if (argv.length === 0) return frozenResult(null, true, {});
  if (argv[0].startsWith('-')) return parseGlobalHelp(argv);

  const command = argv[0];
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new ArgumentError(ARGUMENT_ERROR_CODES.UNKNOWN_COMMAND);
  }
  const specification = COMMANDS[command];

  const options = {};
  const seen = new Set();
  let help = false;
  let index = 1;

  while (index < argv.length) {
    const token = argv[index];
    if (!token.startsWith('-')) throw new ArgumentError(ARGUMENT_ERROR_CODES.USAGE);

    let key;
    let kind;
    if (token.startsWith('--')) {
      const name = token.slice(2);
      if (name.length === 0 || token.includes('=') || !LONG_FLAG.test(name)) {
        throw new ArgumentError(ARGUMENT_ERROR_CODES.USAGE);
      }
      key = `--${name}`;
      if (key === HELP_KEY) {
        kind = 'boolean';
      } else if (Object.hasOwn(specification.options, key)) {
        // The contract stores option names with their leading dashes.
        kind = specification.options[key].kind;
      } else {
        throw new ArgumentError(ARGUMENT_ERROR_CODES.UNKNOWN_OPTION);
      }
    } else if (token === '-h') {
      key = HELP_KEY;
      kind = 'boolean';
    } else {
      throw new ArgumentError(ARGUMENT_ERROR_CODES.USAGE);
    }

    if (seen.has(key)) throw new ArgumentError(ARGUMENT_ERROR_CODES.DUPLICATE_OPTION);
    seen.add(key);
    index += 1;

    if (kind === 'boolean') {
      if (key === HELP_KEY) help = true;
      options[key] = true;
      continue;
    }

    if (index >= argv.length || argv[index].startsWith('-')) {
      throw new ArgumentError(ARGUMENT_ERROR_CODES.MISSING_VALUE);
    }
    const value = argv[index];
    if (value.trim().length === 0) throw new ArgumentError(ARGUMENT_ERROR_CODES.INVALID_VALUE);
    options[key] = value;
    index += 1;
  }

  if (!help) {
    for (const required of specification.required) {
      if (!Object.hasOwn(options, required)) {
        throw new ArgumentError(ARGUMENT_ERROR_CODES.MISSING_OPTION);
      }
    }
  }
  return frozenResult(command, help, options);
}
