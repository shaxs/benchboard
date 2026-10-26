import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArguments,
  ArgumentError,
  ARGUMENT_ERROR_CODES,
  MAX_ARGUMENTS,
  MAX_ARGUMENT_LENGTH,
} from '../../cli/arguments.mjs';
import { renderHelp } from '../../cli/help.mjs';
import { COMMANDS } from '../../cli/command-contract.mjs';
import { COMMAND_LOADERS } from '../../cli/command-readiness.mjs';

const readinessLists = () => ({
  connected: Object.keys(COMMANDS).filter(name => Object.hasOwn(COMMAND_LOADERS, name)),
  disconnected: Object.keys(COMMANDS).filter(name => !Object.hasOwn(COMMAND_LOADERS, name)),
});

const throwsCode = (argv, code, message) => {
  assert.throws(
    () => parseArguments(argv),
    (error) => error instanceof ArgumentError && error.code === code,
    message ?? `expected ${code} for ${JSON.stringify(argv)}`,
  );
};

/* -------------------------------------------------------------------------- */
/* Valid parses                                                                */
/* -------------------------------------------------------------------------- */

test('no arguments returns global help', () => {
  const parsed = parseArguments([]);
  assert.equal(parsed.command, null);
  assert.equal(parsed.help, true);
  assert.deepEqual(parsed.options, {});
});

test('leading -h and --help return global help with empty options', () => {
  for (const flag of ['-h', '--help']) {
    const parsed = parseArguments([flag]);
    assert.equal(parsed.command, null);
    assert.equal(parsed.help, true);
    assert.deepEqual(parsed.options, {});
  }
});

test('a bare command with its required flags parses with exact long-flag keys', () => {
  const parsed = parseArguments(['status', '--run', 'C:/runs/my run']);
  assert.equal(parsed.command, 'status');
  assert.equal(parsed.help, false);
  assert.deepEqual(parsed.options, { '--run': 'C:/runs/my run' });
});

test('a path containing spaces stays one argument', () => {
  const parsed = parseArguments(['init', '--output', 'C:/my runs/fresh container']);
  assert.equal(parsed.options['--output'], 'C:/my runs/fresh container');
});

test('boolean options consume no following token', () => {
  const parsed = parseArguments([
    'stop', '--run', 'R', '--operator', 'op', '--agents-stopped',
  ]);
  assert.equal(parsed.options['--agents-stopped'], true);
  assert.equal(parsed.options['--operator'], 'op');

  const booleanThenFlag = parseArguments([
    'freeze', '--run', 'R', '--agents-stopped', '--clockless',
  ]);
  assert.equal(booleanThenFlag.options['--agents-stopped'], true);
  assert.equal(booleanThenFlag.options['--clockless'], true);
});

test('every command in the contract parses with its required flags', () => {
  for (const [name, specification] of Object.entries(COMMANDS)) {
    const argv = [name];
    for (const required of specification.required) {
      argv.push(required);
      const option = specification.options[required];
      if (option.kind !== 'boolean') argv.push('value');
    }
    const parsed = parseArguments(argv);
    assert.equal(parsed.command, name);
    for (const required of specification.required) {
      assert.ok(Object.hasOwn(parsed.options, required), `${name} ${required}`);
    }
  }
});

test('command help skips required flags yet validates supplied tokens', () => {
  const parsed = parseArguments(['export', '--help']);
  assert.equal(parsed.command, 'export');
  assert.equal(parsed.help, true);
  assert.deepEqual(parsed.options, { '--help': true });

  const partial = parseArguments(['reconcile', '-h', '--operation', 'start']);
  assert.equal(partial.help, true);
  assert.equal(partial.options['--operation'], 'start');

  throwsCode(['export', '--help', '--run'], ARGUMENT_ERROR_CODES.MISSING_VALUE,
    'help still validates supplied tokens');
  throwsCode(['export', '--help', '--nope'], ARGUMENT_ERROR_CODES.UNKNOWN_OPTION,
    'help still rejects unknown options');
});

/* -------------------------------------------------------------------------- */
/* Rejection classes                                                           */
/* -------------------------------------------------------------------------- */

test('positional operands are refused', () => {
  throwsCode(['status', 'extra'], ARGUMENT_ERROR_CODES.USAGE);
  throwsCode(['status', '--run', 'R', 'extra'], ARGUMENT_ERROR_CODES.USAGE);
  throwsCode(['--run', 'R'], ARGUMENT_ERROR_CODES.UNKNOWN_OPTION);
  throwsCode(['status', '--'], ARGUMENT_ERROR_CODES.USAGE);
  throwsCode(['status', ''], ARGUMENT_ERROR_CODES.USAGE);
});

test('equals syntax is refused', () => {
  throwsCode(['status', '--run=R'], ARGUMENT_ERROR_CODES.USAGE);
  throwsCode(['status', '--help=true'], ARGUMENT_ERROR_CODES.USAGE);
});

test('short options other than -h are refused', () => {
  throwsCode(['status', '-r', 'R'], ARGUMENT_ERROR_CODES.USAGE);
  throwsCode(['status', '--run', 'R', '-x'], ARGUMENT_ERROR_CODES.USAGE);
  throwsCode(['-x'], ARGUMENT_ERROR_CODES.USAGE);
  throwsCode(['---'], ARGUMENT_ERROR_CODES.USAGE);
});

test('unknown commands are refused', () => {
  throwsCode(['nope'], ARGUMENT_ERROR_CODES.UNKNOWN_COMMAND);
  throwsCode(['INIT'], ARGUMENT_ERROR_CODES.UNKNOWN_COMMAND);
});

test('unknown options are refused per command', () => {
  throwsCode(['status', '--output', 'x'], ARGUMENT_ERROR_CODES.UNKNOWN_OPTION);
  throwsCode(['status', '--run', 'R', '--dependency-mode', 'none'], ARGUMENT_ERROR_CODES.UNKNOWN_OPTION);
});

test('duplicates are refused, and -h and --help are one option', () => {
  throwsCode(['status', '--run', 'a', '--run', 'b'], ARGUMENT_ERROR_CODES.DUPLICATE_OPTION);
  throwsCode(['status', '--run', 'R', '--help', '--help'], ARGUMENT_ERROR_CODES.DUPLICATE_OPTION);
  throwsCode(['status', '--run', 'R', '--help', '-h'], ARGUMENT_ERROR_CODES.DUPLICATE_OPTION);
  throwsCode(['status', '--run', 'R', '-h', '--help'], ARGUMENT_ERROR_CODES.DUPLICATE_OPTION);
});

test('non-string arguments are refused', () => {
  for (const bad of [null, undefined, 7, {}, [], true]) {
    throwsCode(['status', '--run', bad], ARGUMENT_ERROR_CODES.INVALID_VALUE);
  }
  assert.throws(() => parseArguments('status'), (error) => error instanceof ArgumentError && error.code === 'USAGE');
  assert.throws(() => parseArguments(null), (error) => error instanceof ArgumentError && error.code === 'USAGE');
});

test('empty and blank values are refused as invalid', () => {
  throwsCode(['status', '--run', ''], ARGUMENT_ERROR_CODES.INVALID_VALUE);
  throwsCode(['status', '--run', '   '], ARGUMENT_ERROR_CODES.INVALID_VALUE);
});

test('a missing value, including one starting with a dash, is refused', () => {
  throwsCode(['status', '--run'], ARGUMENT_ERROR_CODES.MISSING_VALUE);
  throwsCode(['status', '--run', '--help'], ARGUMENT_ERROR_CODES.MISSING_VALUE);
  throwsCode(['status', '--run', '-x'], ARGUMENT_ERROR_CODES.MISSING_VALUE);
  throwsCode(['status', '--run', '-'], ARGUMENT_ERROR_CODES.MISSING_VALUE);
});

test('missing required flags are refused only when help is false', () => {
  throwsCode(['stop'], ARGUMENT_ERROR_CODES.MISSING_OPTION);
  throwsCode(['stop', '--run', 'R'], ARGUMENT_ERROR_CODES.MISSING_OPTION);
  assert.equal(parseArguments(['stop', '--help']).help, true);
});

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

test('argument count is bounded', () => {
  // Exactly at the bound: the size check must not trigger, so parsing continues
  // and stops at the duplicate-option rule instead.
  const atLimit = ['freeze', '--run', 'R', '--operator', 'op', '--agents-stopped'];
  while (atLimit.length < MAX_ARGUMENTS) atLimit.push('--operator');
  assert.equal(atLimit.length, MAX_ARGUMENTS);
  throwsCode(atLimit, ARGUMENT_ERROR_CODES.DUPLICATE_OPTION); // size bound not hit; grammar is
  throwsCode(Array.from({ length: MAX_ARGUMENTS + 1 }, () => 'x'), ARGUMENT_ERROR_CODES.USAGE);
});

test('per-argument length is bounded', () => {
  const atLimit = parseArguments(['status', '--run', 'x'.repeat(MAX_ARGUMENT_LENGTH)]);
  assert.equal(atLimit.options['--run'].length, MAX_ARGUMENT_LENGTH);
  throwsCode(['status', '--run', 'x'.repeat(MAX_ARGUMENT_LENGTH + 1)], ARGUMENT_ERROR_CODES.USAGE);
});

/* -------------------------------------------------------------------------- */
/* Frozen returns                                                              */
/* -------------------------------------------------------------------------- */

test('returned structures are frozen', () => {
  for (const argv of [[], ['status', '--run', 'R'], ['export', '--help']]) {
    const parsed = parseArguments(argv);
    assert.ok(Object.isFrozen(parsed));
    assert.ok(Object.isFrozen(parsed.options));
    assert.throws(() => { parsed.command = 'x'; }, TypeError);
    assert.throws(() => { parsed.options['--run'] = 'x'; }, TypeError);
  }
});

/* -------------------------------------------------------------------------- */
/* Error shape                                                                 */
/* -------------------------------------------------------------------------- */

test('ArgumentError carries a code from the closed set and never interpolates caller data', () => {
  const secret = 'C:/private/do-not-leak';
  for (const argv of [
    [secret], ['status', `--${secret}`], ['status', '--run', secret, '--run', 'b'],
    ['stop'], ['status', '--run', secret, ''], ['status', 'positional'],
  ]) {
    try {
      parseArguments(argv);
      assert.fail(`expected a rejection for ${JSON.stringify(argv)}`);
    } catch (error) {
      assert.ok(error instanceof ArgumentError);
      assert.ok(Object.values(ARGUMENT_ERROR_CODES).includes(error.code), error.code);
      assert.ok(!error.message.includes(secret), error.message);
      assert.ok(!error.message.includes('positional'), error.message);
    }
  }
  const error = new ArgumentError(ARGUMENT_ERROR_CODES.USAGE);
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'USAGE');
  assert.throws(() => new ArgumentError('NOT_A_CODE'), TypeError);
  assert.throws(() => new ArgumentError('__proto__'), TypeError);
});

/* -------------------------------------------------------------------------- */
/* Help                                                                        */
/* -------------------------------------------------------------------------- */

test('global help lists every command with its description and the checkout invocation', () => {
  const text = renderHelp();
  for (const [name, specification] of Object.entries(COMMANDS)) {
    assert.ok(text.includes(`${name} — ${specification.description}`), name);
  }
  assert.ok(text.includes('node cli/benchboard.mjs'));
  assert.ok(text.includes('COMMAND_UNAVAILABLE'));
  assert.ok(text.includes('no command work is started'));
});

test('command help lists exact option names, prerequisites and exit categories', () => {
  const text = renderHelp('evaluate');
  assert.ok(text.includes('evaluate'));
  for (const name of Object.keys(COMMANDS.evaluate.options)) {
    assert.ok(text.includes(name), name);
    assert.ok(text.includes(COMMANDS.evaluate.options[name].description), name);
  }
  assert.ok(text.includes('--help'));
  assert.ok(text.includes('Prerequisites (required flags): --run'));

  const stop = renderHelp('stop');
  assert.ok(stop.includes('--agents-stopped'), 'boolean options are listed');
  assert.ok(stop.includes('(required)'));
});

test('help states the exit categories and the local-summary versus safe-export distinction', () => {
  for (const command of [null, 'status']) {
    const text = renderHelp(command);
    for (const code of ['0', '2', '3', '4', '5', '130']) {
      assert.ok(new RegExp(`\\n\\s+${code}\\s`, 'm').test(text), `exit category ${code}`);
    }
    assert.ok(text.includes('Local summaries versus safe exports'));
    assert.ok(text.includes('.benchboard-results'));
    assert.ok(text.includes('JSON and text'));
  }
});

test('global help and every command help carry the readiness and privacy disclosures', () => {
  for (const command of [null, ...Object.keys(COMMANDS)]) {
    const label = command ?? 'global';
    const text = renderHelp(command);
    // Readiness disclosure: disconnected handlers, exit 3, COMMAND_UNAVAILABLE,
    // and no command work started for a disconnected command.
    const { connected, disconnected } = readinessLists();
    assert.ok(text.includes(`Connected commands: ${connected.join(', ') || 'none'}.`), label);
    assert.ok(text.includes(`Disconnected commands: ${disconnected.join(', ') || 'none'}.`), label);
    assert.ok(/exits with code 3 and reports COMMAND_UNAVAILABLE/.test(text), label);
    assert.ok(/no command work is started/.test(text), label);
    // The shared exit-3 table entry names COMMAND_UNAVAILABLE explicitly.
    assert.ok(/\n\s+3\s[^\n]*COMMAND_UNAVAILABLE/.test(text), `exit 3 names COMMAND_UNAVAILABLE (${label})`);
    // Local summary path disclosure and the explicit not-privacy-safe statement.
    assert.ok(/may name the\n\s+selected filesystem paths/.test(text), `local path disclosure (${label})`);
    assert.ok(/not a privacy-safe export/.test(text), `not privacy-safe (${label})`);
  }
});

test('global help states required flags via <command> --help, not a listed flag set', () => {
  const text = renderHelp();
  // The misleading claim that global help lists required flags under each
  // command is gone; the truthful claim points at the command's own help.
  assert.ok(!/flags listed under each one/.test(text), 'misleading flag-list phrase absent');
  assert.ok(/required flags appear in <command> --help/.test(text), 'required flags pointer');
});

test('help distinguishes standard-output summaries from retained results-root records', () => {
  for (const command of [null, 'evaluate']) {
    const text = renderHelp(command);
    // The local summary the user reads goes to standard output; it is not
    // described as living in the results root.
    assert.ok(/local JSON summary to standard\n\s+output/.test(text), 'stdout summary wording');
    assert.ok(/Retained private results/.test(text), 'retained-results wording');
    assert.ok(!/local summary lives in the results root/.test(text), 'results root holds retained records, not the stdout summary');
  }
});

test('help describes the help-flag invocations the parser actually accepts', () => {
  const text = renderHelp();
  // Global help: no arguments, or a help flag on its own.
  assert.equal(parseArguments([]).help, true);
  for (const flag of ['--help', '-h']) {
    assert.equal(parseArguments([flag]).help, true);
    assert.ok(text.includes(flag), flag);
  }
  // Command help: the flag follows the command name.
  assert.equal(parseArguments(['status', '--help']).help, true);
  assert.equal(parseArguments(['status', '--help']).command, 'status');
  assert.ok(/<command> --help/.test(text), 'command help invocation');
  // A help flag before a command name is not accepted, as the help text states.
  throwsCode(['--help', 'status'], ARGUMENT_ERROR_CODES.USAGE);
  assert.ok(/before a command name is not accepted/.test(text), 'refusal wording');
});

test('help states development-only local self-assessment limits', () => {
  for (const command of [null, ...Object.keys(COMMANDS)]) {
    const text = renderHelp(command);
    assert.ok(text.includes('development'), command ?? 'global');
    assert.ok(text.includes('self-assessment'));
    assert.ok(text.includes('halts no agent'));
    assert.ok(text.includes('certifies nothing'));
    assert.ok(text.includes('release'));
    assert.ok(text.includes('operating-system sandbox'));
  }
});

test('help is pure: same input, same string, and unknown help input raises TypeError', () => {
  assert.equal(renderHelp('ui'), renderHelp('ui'));
  assert.equal(renderHelp(null), renderHelp());
  assert.throws(() => renderHelp('nope'), TypeError);
});
