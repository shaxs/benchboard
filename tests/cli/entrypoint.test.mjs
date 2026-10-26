/**
 * Independent subprocess acceptance for the executable entrypoint `cli/benchboard.mjs`.
 *
 * Scope (task packet C6.S1.T2): these tests call the executable only through a
 * shell-free, bounded `spawnSync` and check the fixed acceptance cases. They
 * assert exit codes, stderr-only error reporting, stable uppercase error codes
 * with controlled guidance, help content, and that malformed invocations cause
 * no writes to an external canary directory. They check codes and the presence
 * of controlled guidance rather than exact prose.
 *
 * Contract facts asserted here come from the task packet:
 * - exit 2 usage; 3 state/conflict; 4 integrity/safety; 5 infrastructure/internal;
 *   130 cancellation; 0 completed;
 * - help has no JSON success object; errors report through stderr only;
 * - help and parse rejection need no assets and cause no writes;
 * - local command summaries can contain selected filesystem paths and are not
 *   safe exports.
 *
 * The tests stay future-compatible as command handlers become connected: they
 * do not assert that valid operational commands remain unavailable.
 */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../../cli/command-contract.mjs';
import { COMMAND_LOADERS } from '../../cli/command-readiness.mjs';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const entrypoint = path.join(repositoryRoot, 'cli', 'benchboard.mjs');

/* Bounds so a hung or chatty child cannot outlive the test run. */
const SPAWN_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Run the entrypoint as one argv array (never through a shell), so every array
 * element is one argument and paths containing spaces cannot re-split.
 */
function runEntrypoint(args, options = {}) {
  /* The entrypoint is created by a concurrent task; fail clearly if it is not there yet. */
  assert.ok(fs.existsSync(entrypoint),
    `the executable ${entrypoint} is not present; rerun this suite after the entrypoint is integrated`);
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    shell: false,
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  if (result.error)
    throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const trimmed = (text) => text.replace(/\r\n/g, '\n').trimEnd();

/** One stderr line shaped `CODE: guidance` with an upper-case code. */
const CONTROLLED_ERROR_LINE = /^[A-Z][A-Z0-9_]{2,}: \S+/;

test('readiness is shared with dispatch and a still-disconnected command really refuses without writes', t => {
  for (const [name, loader] of Object.entries(COMMAND_LOADERS)) {
    assert.ok(Object.hasOwn(COMMANDS, name));
    assert.equal(typeof loader, 'function');
  }
  const name = Object.keys(COMMANDS).find(command => !Object.hasOwn(COMMAND_LOADERS, command));
  if (name === undefined) {
    assert.equal(Object.keys(COMMAND_LOADERS).length, Object.keys(COMMANDS).length);
    return; // The disconnected branch is inapplicable once all commands connect.
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-disconnected-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'canary'), 'untouched');
  const args = [name, ...COMMANDS[name].required.flatMap(option =>
    COMMANDS[name].options[option].kind === 'boolean' ? [option] : [option, path.join(root, 'selected path')])];
  const result = runEntrypoint(args, { cwd: root });
  assert.equal(result.status, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^COMMAND_UNAVAILABLE:/);
  assert.deepEqual(fs.readdirSync(root), ['canary']);
  assert.equal(fs.readFileSync(path.join(root, 'canary'), 'utf8'), 'untouched');
});

/** A usage refusal: exit 2, no stdout, one controlled uppercase-coded stderr line. */
function assertUsageRejection(result, label) {
  assert.equal(result.status, 2, `${label}: a usage refusal exits with status 2`);
  assert.equal(trimmed(result.stdout), '', `${label}: an error writes nothing to stdout`);
  const firstLine = trimmed(result.stderr).split('\n')[0] ?? '';
  assert.ok(CONTROLLED_ERROR_LINE.test(firstLine),
    `${label}: stderr opens with a stable upper-case code and guidance; got ${JSON.stringify(firstLine)}`);
  const guidance = firstLine.slice(firstLine.indexOf(':') + 1);
  assert.ok(guidance.trim().length >= 10,
    `${label}: the guidance after the code is actionable text; got ${JSON.stringify(guidance)}`);
  assert.ok(!result.stderr.includes('\n    at '),
    `${label}: the rejection reports guidance, not a stack dump`);
  return firstLine;
}

/** A successful help run: exit 0, prose (not a JSON success object), empty stderr. */
function assertHelpRun(result, label) {
  assert.equal(result.status, 0, `${label}: help exits with status 0`);
  assert.equal(trimmed(result.stderr), '', `${label}: help writes nothing to stderr`);
  const help = trimmed(result.stdout);
  assert.ok(help.length > 0, `${label}: help prints text`);
  assert.throws(() => JSON.parse(help), undefined,
    `${label}: help is prose and not a JSON success object`);
  return help;
}

/** A short path that contains a space, usable as one argv element. */
function pathWithSpace(base, name = 'run folder') {
  return path.join(base, name);
}

describe('entrypoint — case 1: help surface and package wiring', () => {
  test('no arguments prints the root help and exits 0', () => {
    const help = assertHelpRun(runEntrypoint([]), 'no arguments');
    const stated = Object.keys(COMMANDS).filter((name) => help.includes(name));
    assert.ok(stated.length >= Object.keys(COMMANDS).length / 2,
      `root help names the available commands; found ${JSON.stringify(stated)}`);
  });

  test('--help prints the root help and exits 0', () => {
    const help = assertHelpRun(runEntrypoint(['--help']), '--help');
    assert.ok(/help/i.test(help), 'root help explains how to get help');
  });

  for (const [name, spec] of Object.entries(COMMANDS)) {
    test(`${name} --help prints relevant help, needs no prerequisites, exits 0`, () => {
      /* Run from an empty external directory: help has no asset, run or output prerequisites. */
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-help-probe-'));
      try {
        const help = assertHelpRun(runEntrypoint([name, '--help'], { cwd: scratch }), `${name} --help`);
        assert.ok(help.includes(name), `${name} --help names the command`);
        const mentioned = spec.required.filter((option) => help.includes(option));
        assert.ok(mentioned.length >= 1,
          `${name} --help states at least one required field; required ${JSON.stringify(spec.required)}`);
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 4 });
      }
    });
  }

  test('an invalid option still fails while --help is present', () => {
    const result = runEntrypoint(['evaluate', '--help', '--not-an-option', 'x']);
    assertUsageRejection(result, 'evaluate --help --not-an-option');
  });

  test('an invalid option still fails while --help is present on another command', () => {
    const result = runEntrypoint(['init', '--help', '--definitely-not-an-option', 'y']);
    assertUsageRejection(result, 'init --help --definitely-not-an-option');
  });

  test('the root package declares the benchboard bin and script and keeps the existing scripts', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.bin?.benchboard, 'cli/benchboard.mjs',
      'bin.benchboard points at the entrypoint');
    assert.equal(manifest.scripts?.benchboard, 'node cli/benchboard.mjs',
      'scripts.benchboard runs the entrypoint');
    for (const [name, body] of Object.entries({
      test: 'node --test "tests/**/*.test.mjs"',
      'self-test': 'node runner/self-test.mjs',
      validate: 'node evaluator/self-validate.mjs',
    }))
      assert.equal(manifest.scripts?.[name], body, `the existing script "${name}" is preserved`);
  });
});

describe('entrypoint — case 2: usage rejections before command work', () => {
  const usageCases = [
    { label: 'unknown command', args: ['no-such-command'] },
    { label: 'unknown flag', args: ['status', '--definitely-not-an-option', 'v', '--run', 'p'] },
    { label: 'duplicate flag', args: ['init', '--output', 'a', '--output', 'b'] },
    { label: 'missing required flag', args: ['status'] },
    { label: 'missing required flag with other options', args: ['evaluate', '--snapshot', 's1'] },
    { label: 'missing option value', args: ['evaluate', '--run'] },
    { label: 'missing required fields on export', args: ['export', '--run', 'p'] },
    { label: 'extra positional', args: ['status', 'alpha', 'beta', '--run', 'p'] },
    { label: 'equals syntax', args: ['init', '--output=some/path'] },
    { label: 'repeated help alias', args: ['--help', '--help'] },
    { label: 'repeated help alias mixed forms', args: ['--help', '-h'] },
    { label: 'repeated help alias on a command', args: ['init', '--help', '-h'] },
  ];
  for (const { label, args } of usageCases)
    test(`${label} exits 2 with a coded guidance line and no stdout`, () => {
      assertUsageRejection(runEntrypoint(args), label);
    });

  test('a path containing a space parses as one argument on a help short-circuit', () => {
    /* Help needs no prerequisites, so exit 0 proves the spaced value parsed as one argument. */
    const spaced = pathWithSpace(os.tmpdir());
    const result = runEntrypoint(['evaluate', '--run', spaced, '--help']);
    assert.equal(result.status, 0,
      `--run ${JSON.stringify(spaced)} --help is a help run; stderr ${JSON.stringify(trimmed(result.stderr))}`);
    assert.equal(trimmed(result.stderr), '', 'the spaced path caused no error output');
  });

  test('a path containing a space causes no usage failure on a non-help invocation', () => {
    /* Whatever the handler then decides, parsing succeeded: a parse failure is the usage status 2. */
    const spaced = pathWithSpace(os.tmpdir());
    const result = runEntrypoint(['status', '--run', spaced]);
    assert.notEqual(result.status, 2,
      `a spaced path is one argument, not a usage failure; stderr ${JSON.stringify(trimmed(result.stderr))}`);
  });
});

describe('entrypoint — case 3: malformed operations write nothing to an external canary', () => {
  /* One external existing temporary directory whose name contains a space. */
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-canary probe '));
  const canaryName = 'canary.txt';
  const canaryBody = 'canary body — must survive every malformed invocation\n';
  fs.writeFileSync(path.join(base, canaryName), canaryBody, 'utf8');
  fs.mkdirSync(path.join(base, 'nested folder'));
  fs.writeFileSync(path.join(base, 'nested folder', 'inner.txt'), 'inner body\n', 'utf8');

  const inventory = () => fs.readdirSync(base, { recursive: true }).slice().sort()
    .map((relative) => {
      const stat = fs.statSync(path.join(base, relative));
      return {
        path: relative.split(path.sep).join('/'),
        kind: stat.isDirectory() ? 'directory' : 'file',
        ...(stat.isFile() ? { size: stat.size, modifiedMs: stat.mtimeMs } : {}),
      };
    });

  const before = { inventory: inventory(), canary: fs.readFileSync(path.join(base, canaryName), 'utf8') };

  after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 4 }));

  test('malformed init/evaluate/export/reset against the canary directory exit 2', () => {
    const spaced = base; /* The canary directory itself: its name contains a space. */
    const malformed = [
      { label: 'init: extra positional and missing --output', args: ['init', spaced, 'extra-positional'] },
      { label: 'evaluate: snapshot option left without a value', args: ['evaluate', '--run', spaced, '--snapshot'] },
      { label: 'export: required output and evaluation absent', args: ['export', '--run', spaced] },
      { label: 'reset: required output absent', args: ['reset', '--run', spaced] },
    ];
    for (const { label, args } of malformed)
      assertUsageRejection(runEntrypoint(args, { cwd: base }), label);
  });

  test('the canary file and the directory inventory are exactly unchanged', () => {
    assert.equal(fs.readFileSync(path.join(base, canaryName), 'utf8'), before.canary,
      'the canary file content is unchanged');
    assert.deepEqual(inventory(), before.inventory,
      'the canary directory inventory is unchanged');
  });
});

describe('entrypoint — case 4: help wording distinguishes assessment kinds and export safety', () => {
  const helpText = () => {
    const root = runEntrypoint(['--help']);
    assert.equal(root.status, 0, 'root help exits 0 before its wording is inspected');
    const command = runEntrypoint(['export', '--help']);
    assert.equal(command.status, 0, 'export help exits 0 before its wording is inspected');
    return `${root.stdout}\n${command.stdout}`.toLowerCase();
  };

  test('help frames human assessment as manual self-assessment, not certification', () => {
    const combined = helpText();
    assert.ok(/manual/.test(combined), 'help uses the word manual for the human step');
    assert.ok(/self[- ]assessment|self[- ]attested|attest/.test(combined),
      'help says the human step is self-assessment or attestation');
    assert.ok(/(no|not|never|non)[^.\n]{0,60}certif|certif[^.\n]{0,40}(not|no)\b/.test(combined),
      'help states that the result is not a certification');
  });

  test('help distinguishes safe exports from local command summaries', () => {
    const combined = helpText();
    /* The two concepts are both named... */
    assert.ok(/safe export/.test(combined), 'help names safe exports');
    assert.ok(/local (result|summar)|summar/.test(combined), 'help names the local result/summary side');
    /* ...and the text puts them side by side rather than equating them. */
    assert.ok(/local.{0,80}(versus|verses|rather than|instead of)|versus.{0,40}local/.test(combined)
        || /safe export[\s\S]{0,600}local|local[\s\S]{0,600}safe export/.test(combined),
      'help sets local results and safe exports against each other');
    /* Each side carries a defining property from the contract. */
    assert.ok(/excludes private|only the json and text|json\/text summaries/.test(combined),
      'help defines a safe export by its restricted contents');
    assert.ok(/results root/.test(combined), 'help locates local results at the results root');
  });
});
