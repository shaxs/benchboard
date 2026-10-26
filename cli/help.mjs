/**
 * `cli/help.mjs` — the pure help renderer for the checkout CLI (C6.S1).
 *
 * `renderHelp(command = null)` builds help text from the Captain-owned command
 * grammar and shared pure readiness table. It reads no installed assets, writes
 * nothing, and executes no command handler; it is a pure string builder.
 *
 * Command handlers are integrated in subsequent C6 stories. In this checkout a
 * command that is not connected yet is refused with COMMAND_UNAVAILABLE, and no
 * command work is started; the help text says so rather than presenting an
 * unconnected command as a successful no-op.
 */

import { COMMANDS } from './command-contract.mjs';
import { COMMAND_LOADERS } from './command-readiness.mjs';

function line(...parts) {
  return parts.join('');
}

function describeOptions(commandName, indent) {
  const specification = COMMANDS[commandName];
  const names = Object.keys(specification.options);
  if (names.length === 0) return '';
  const rows = names.map((name) => {
    const detail = specification.options[name];
    const required = specification.required.includes(name) ? ' (required)' : '';
    const shape = detail.kind === 'boolean' ? '' : ' VALUE';
    return line('  ', indent, '--', name.slice(2), shape, required, ' — ', detail.description);
  });
  rows.push(line('  ', indent, '--help  — Show this help (also -h).'));
  return `${rows.join('\n')}\n`;
}

function commandBlock(name) {
  const specification = COMMANDS[name];
  return line(
    `benchboard ${name}\n`,
    `  ${specification.description}\n`,
    `  Prerequisites (required flags): ${specification.required.join(', ')}\n`,
    '  Options:\n',
    describeOptions(name, '    '),
  );
}

function globalHelp() {
  const lines = [];
  lines.push('BenchBoard checkout CLI\n');
  lines.push('Usage: node cli/benchboard.mjs <command> [options]\n');
  lines.push('Commands (each command\'s required flags appear in <command> --help; run\n');
  lines.push('"node cli/benchboard.mjs <command> --help" for a command\'s options and required flags):\n');
  for (const name of Object.keys(COMMANDS)) {
    lines.push(`  ${name} — ${COMMANDS[name].description}\n`);
  }
  lines.push('\nGlobal help: run with no arguments, or pass --help or -h on its own.\n');
  lines.push('One command\'s help: run <command> --help or <command> -h; the flag follows the command\n');
  lines.push('name. A help flag before a command name is not accepted.\n');
  lines.push('\nThis help text is built from the built-in command contract; it reads no installed\n');
  lines.push('assets and writes nothing when you request it.\n');
  lines.push(readinessSection());
  return lines.join('');
}

function readinessSection() {
  const lines = [];
  const connected = Object.keys(COMMANDS).filter(name => Object.hasOwn(COMMAND_LOADERS, name));
  const disconnected = Object.keys(COMMANDS).filter(name => !Object.hasOwn(COMMAND_LOADERS, name));
  lines.push('\nCommand readiness in this checkout:\n');
  lines.push(`  Connected commands: ${connected.join(', ') || 'none'}.\n`);
  lines.push(`  Disconnected commands: ${disconnected.join(', ') || 'none'}.\n`);
  lines.push('  A command whose handler is disconnected exits with code 3 and reports COMMAND_UNAVAILABLE; no command work is started\n');
  lines.push('  for a disconnected command, and nothing is reported as a successful no-op.\n');
  return lines.join('');
}

function exitCategoriesSection() {
  const lines = [];
  lines.push('\nExit categories for every command:\n');
  lines.push('  0   command completed (a completed quality evaluation is a success even when checks failed)\n');
  lines.push('  2   usage error\n');
  lines.push('  3   state or conflict, including COMMAND_UNAVAILABLE for a disconnected command\n');
  lines.push('  4   integrity or safety refusal\n');
  lines.push('  5   infrastructure or internal failure\n');
  lines.push('  130 handled cancellation\n');
  return lines.join('');
}

function resultsDistinctionSection() {
  const lines = [];
  lines.push('\nLocal summaries versus safe exports:\n');
  lines.push('  Standard output: a connected command writes its local JSON summary to standard\n');
  lines.push('  output for the person working in this checkout to read. That summary may name the\n');
  lines.push('  selected filesystem paths, so it is not a privacy-safe export.\n');
  lines.push('  Retained private results: records under the results root (default\n');
  lines.push('  <run>.benchboard-results/ next to the run container) are retained files for this\n');
  lines.push('  checkout, a surface separate from the standard-output summary line.\n');
  lines.push('  Safe exports: the export command writes an explicit fresh directory holding the\n');
  lines.push('  JSON and text summary forms, a surface separate from the standard-output summary\n');
  lines.push('  and from the retained records.\n');
  return lines.join('');
}

function commandHelp(command) {
  return line(
    commandBlock(command),
    readinessSection(),
    exitCategoriesSection(),
    resultsDistinctionSection(),
  );
}

function commonFooter() {
  const lines = [];
  lines.push('\nScope of this checkout:\n');
  lines.push('  This CLI is for development use in a BenchBoard checkout and supports local\n');
  lines.push('  self-assessment. It halts no agent, certifies nothing, publishes no release, and\n');
  lines.push('  provides no operating-system sandbox.\n');
  return lines.join('');
}

/**
 * Render help text for `command`, or global help when `command` is null.
 * Returns a string. A command name not in the contract throws a TypeError;
 * this function reads no files, writes nothing and starts no command.
 */
export function renderHelp(command = null) {
  if (command === null) {
    return line(globalHelp(), exitCategoriesSection(), resultsDistinctionSection(), commonFooter());
  }
  if (typeof command !== 'string' || !Object.hasOwn(COMMANDS, command)) {
    throw new TypeError('Unknown command for help rendering');
  }
  return line(commandHelp(command), commonFooter());
}
