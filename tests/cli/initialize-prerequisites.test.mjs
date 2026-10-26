/**
 * Independent regression for the prepared-mode source prerequisite and the
 * absolute-output rule (task packet C6.S3.T4, independent review F1).
 *
 * Every case drives the real executable `cli/benchboard.mjs` through a
 * shell-free, bounded `spawnSync` from a fresh external temporary root whose
 * generated path contains a space. No command output is simulated.
 *
 * Check 1 supplies a valid tiny synthetic prepared cache (synthetic evidence
 * of the copy protocol, not a real toolchain install) with canonical
 * provenance computed from the ACTUAL installed starter `package.json` /
 * `package-lock.json` bytes, deliberately omits `--source-root`, and requires
 * the controlled CLI_STATE refusal to name `--source-root`. The child's
 * TEMP/TMP/TMPDIR are redirected into an exclusively test-owned empty ordinary
 * directory, so the materialised `bb-cli-source-*` root is observable in a
 * location this test alone owns and its absence afterwards proves the cleanup
 * path without any production hook.
 *
 * Check 2 checks the real `init --help` text semantically (per flag line, not
 * by brittle line widths) and confirms `--output` is the only globally
 * required flag, because help needs no run or output prerequisites.
 *
 * Check 3 documents the unchanged C2 behaviour: a relative `--output` is an
 * integrity refusal (CLI_INTEGRITY, exit 4) that creates nothing, and help
 * states the output is an absolute path. No normalization or fallback is
 * asserted, only the refusal.
 *
 * Scope fixed by the packet: no install mode, npm, server, browser or
 * participant agent; controlled refusals are stderr-only with no stack dump
 * and no echo of private canary material; the synthetic cache, the locked
 * source and the installed starter bytes must be byte-unchanged afterwards.
 */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inventoryTree, sha256 } from '../../packages/core/identity.mjs';
import {
  DEPENDENCIES_MODULE_ID,
  DEPENDENCY_HASH_ALGORITHM_ID,
  DEPENDENCIES_METADATA_FILE_NAME,
} from '../../packages/core/dependencies.mjs';
import { loadInstallation } from '../../cli/installation.mjs';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const entrypoint = path.join(repositoryRoot, 'cli', 'benchboard.mjs');
const starterRoot = path.join(repositoryRoot, 'starter');

/* Bounds so a hung or chatty child cannot outlive the test run. */
const SPAWN_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 1_048_576;

/* A private token embedded in a path element: if any refusal ever echoed raw
 * error text, this token (or the private path holding it) would surface. */
const CANARY = 'bb-canary-8f27b1e9-never-echo';

const trimmed = (text) => text.replace(/\r\n/g, '\n').trimEnd();
const COMPARE = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const rawInventory = (root) => inventoryTree({ root, skipNames: [] });

/**
 * Run the entrypoint as one argv array (never through a shell), so every array
 * element — including a path containing a space — is exactly one argument.
 * When `env` is supplied the child inherits `process.env` overridden by it.
 */
function runCli(args, cwd, env = void 0) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    encoding: 'utf8',
    shell: false,
    cwd,
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
    ...(env === void 0 ? {} : { env }),
  });
  assert.equal(result.error, undefined, `the child process completed without a spawn error: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** One external temporary root whose generated path contains a space. */
const temporaryRoots = [];
function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bb-init prereq ${label} `));
  temporaryRoots.push(root);
  return root;
}
after(() => {
  for (const root of temporaryRoots)
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 });
});

/** A controlled refusal: exit status, empty stdout, one stderr line, no stack,
 *  no echo of the canary token and no echo of the private root holding it. */
function runExpectingRefusal(args, cwd, expectedCode, expectedStatus, label, env = void 0) {
  const result = runCli(args, cwd, env);
  assert.equal(result.status, expectedStatus, `${label}: exit status is ${expectedStatus}`);
  assert.equal(result.stdout, '', `${label}: a refusal writes nothing to stdout`);
  const err = trimmed(result.stderr);
  assert.equal(err.split('\n').length, 1, `${label}: the refusal is one controlled line: ${JSON.stringify(err)}`);
  assert.ok(err.startsWith(`${expectedCode}: `), `${label}: stderr opens with ${expectedCode}: ${JSON.stringify(err)}`);
  assert.ok(!err.includes('\n    at ') && !err.includes('\n\tat '),
    `${label}: the refusal reports guidance, not a stack dump`);
  assert.ok(!err.includes(CANARY), `${label}: the refusal does not echo the canary token`);
  return { result, err };
}

/**
 * Build the accepted prepared-cache example shape around a real installed
 * lock pair: the ACTUAL starter `package.json` / `package-lock.json` bytes are
 * copied to a separate locked source, and the tiny synthetic cache declares
 * provenance over exactly those copied bytes. This is synthetic copy-protocol
 * evidence of the declared-cache path, not a real toolchain install.
 */
function buildSyntheticCache(root) {
  const lockedSource = path.join(root, 'locked source');
  fs.mkdirSync(lockedSource);
  for (const file of ['package.json', 'package-lock.json'])
    fs.copyFileSync(path.join(starterRoot, file), path.join(lockedSource, file));

  const cacheRoot = path.join(root, 'dep cache');
  const preparedRoot = path.join(cacheRoot, 'node_modules');
  const packageRoot = path.join(preparedRoot, 'synthetic-dep');
  fs.mkdirSync(packageRoot, { recursive: true });
  const packageBytes = Buffer.from('{"name":"synthetic-dep"}\n', 'utf8');
  fs.writeFileSync(path.join(packageRoot, 'package.json'), packageBytes);
  const marker = {
    schemaVersion: '1.0.0',
    module: DEPENDENCIES_MODULE_ID,
    hashAlgorithmId: DEPENDENCY_HASH_ALGORITHM_ID,
    mode: 'prepared',
    provenance: {
      lockfileName: 'package-lock.json',
      manifestFileName: 'package.json',
      lockDigest: sha256(fs.readFileSync(path.join(lockedSource, 'package-lock.json'))),
      manifestDigest: sha256(fs.readFileSync(path.join(lockedSource, 'package.json'))),
    },
  };
  fs.writeFileSync(
    path.join(preparedRoot, DEPENDENCIES_METADATA_FILE_NAME),
    `${JSON.stringify(marker, null, 2)}\n`,
    'utf8',
  );
  return { cacheRoot, preparedRoot, lockedSource };
}

/* ========================================================================== */
/* Check 1 — prepared mode with a valid cache but no --source-root             */
/* ========================================================================== */

describe('prepared-source prerequisite — check 1: a valid cache without --source-root is refused with cleanup', () => {
  /* The canary token is part of the external root name, so a refusal that ever
   * echoed a raw path or message would surface it. */
  const root = tempRoot(`${CANARY} space root`);

  test('the CLI_STATE refusal names --source-root, creates no output and leaves no source residue', () => {
    const { cacheRoot, preparedRoot, lockedSource } = buildSyntheticCache(root);

    /* The child's temp environment goes to an exclusively test-owned, empty,
     * ordinary directory, so the materialised bb-cli-source-* root lands where
     * this test can observe its absence without a production hook. */
    const childTemp = fs.mkdtempSync(path.join(root, 'child tmp '));
    assert.deepEqual(fs.readdirSync(childTemp), [], 'the redirected child temporary directory starts empty');

    const cacheBefore = rawInventory(cacheRoot);
    const lockedBefore = rawInventory(lockedSource);

    const output = path.join(root, 'prepared container');
    const { err } = runExpectingRefusal(
      ['init', '--output', output, '--dependency-mode', 'prepared', '--prepared-root', preparedRoot],
      root, 'CLI_STATE', 3, 'prepared without source root',
      { ...process.env, TEMP: childTemp, TMP: childTemp, TMPDIR: childTemp },
    );

    /* The one guidance line names the exact missing prerequisite. */
    assert.ok(err.includes('--source-root'),
      `the guidance names the missing --source-root prerequisite: ${JSON.stringify(err)}`);
    /* The refusal is guidance only: no private path of the canary root leaks. */
    assert.ok(!err.includes(root), 'the refusal does not echo the private canary root path');

    /* C2 rolls back its reserved output; the redirected temp holds no source residue. */
    assert.equal(fs.existsSync(output), false, 'no output container remains after refusal');
    const residue = fs.readdirSync(childTemp);
    assert.deepEqual(residue, [], `the child temporary directory holds no bb-cli-source residue: ${JSON.stringify(residue)}`);
    assert.ok(!residue.some((name) => name.startsWith('bb-cli-source-')),
      'no materialised challenge source root remains in the child temporary directory');

    /* The synthetic cache, the locked source and the installed starter bytes
     * are byte-unchanged by the refused run. */
    assert.deepEqual(rawInventory(cacheRoot).entries, cacheBefore.entries, 'the synthetic cache bytes are unchanged');
    assert.deepEqual(rawInventory(lockedSource).entries, lockedBefore.entries, 'the locked source bytes are unchanged');
    /* The installed bytes: the same accepted convention the prepared-mode
     * example uses — a default-skip inventory of the starter tree against the
     * loaded installation digest. */
    const installed = loadInstallation();
    assert.equal(inventoryTree({ root: starterRoot }).digest, installed.descriptor.workloadDigest,
      'the installed starter tree still hashes to the recorded workload digest');
  });
});

/* ========================================================================== */
/* Check 2 — the real init --help states the mode-conditional prerequisites    */
/* ========================================================================== */

describe('prepared-source prerequisite — check 2: init --help states the mode-conditional prerequisites', () => {
  const cwd = tempRoot('help');

  test('help says --prepared-root needs prepared mode and --source-root needs prepared and install', () => {
    /* Help runs with no --output, no installation and no output prerequisites,
     * and still completes with status 0 — the help-needs-no-prerequisites rule
     * itself. */
    const help = runCli(['init', '--help'], cwd);
    assert.equal(help.status, 0, 'init --help with no other flags completes with status 0');
    assert.equal(trimmed(help.stderr), '', 'init --help writes nothing to stderr');

    const lines = trimmed(help.stdout).split('\n');
    /* The option's own description row: a row whose trimmed form opens with
     * the flag name, not a prose line that merely mentions it. */
    const lineNaming = (flag) => lines.find((line) => line.trimStart().startsWith(flag));

    /* Checked semantically on each flag's own description line, never on line
     * width or alignment. */
    const preparedLine = lineNaming('--prepared-root');
    assert.ok(preparedLine !== void 0, 'help lists --prepared-root');
    assert.match(preparedLine, /required.*prepared mode/is,
      `--prepared-root is stated as required for prepared mode: ${JSON.stringify(preparedLine)}`);

    const sourceLine = lineNaming('--source-root');
    assert.ok(sourceLine !== void 0, 'help lists --source-root');
    assert.match(sourceLine, /required for prepared and install/i,
      `--source-root is stated as required for prepared and install modes: ${JSON.stringify(sourceLine)}`);

    /* The globally required flags stay exactly --output; the two dependency
     * flags above are mode-conditional prerequisites, not global ones. */
    const prerequisites = lines.find((line) => line.includes('Prerequisites (required flags):'));
    assert.ok(prerequisites !== void 0, 'help lists the command prerequisites');
    const listed = prerequisites.slice(prerequisites.indexOf(':') + 1).split(',').map((one) => one.trim()).filter(Boolean);
    assert.deepEqual(listed, ['--output'], 'the required-flags table lists --output and nothing else');

    /* Help itself demands no run or output: the same --help run above already
     * proved it (status 0 with no --output supplied). */
    assert.ok(help.stdout.includes('--help'), 'help documents the help flag itself');
  });
});

/* ========================================================================== */
/* Check 3 — a relative --output is the unchanged C2 integrity refusal         */
/* ========================================================================== */

describe('prepared-source prerequisite — check 3: a relative --output is refused with no output created', () => {
  const cwd = tempRoot('relative');

  test('a relative output refuses CLI_INTEGRITY with exit 4 and creates no relative output', () => {
    /* One argv element, deliberately relative. This documents the unchanged C2
     * rule that the output root must be absolute; no normalization or fallback
     * against the working directory is added or asserted. */
    const relative = path.join('fresh container', 'nested run');
    const { result } = runExpectingRefusal(
      ['init', '--output', relative], cwd, 'CLI_INTEGRITY', 4, 'relative output');
    assert.equal(result.status, 4, 'the relative output refuses with exit status 4');

    /* Nothing was created under the working directory. */
    assert.equal(fs.existsSync(path.join(cwd, 'fresh container')), false,
      'no relative output container was created under the working directory');
    assert.equal(fs.existsSync(path.resolve(cwd, relative)), false,
      'no nested relative output was created');

    /* Help states the absolute-path rule the refusal enforces. */
    const help = runCli(['init', '--help'], cwd);
    assert.equal(help.status, 0, 'init --help still completes with status 0');
    /* The option's own row (its trimmed form opens with the flag), not the
     * prerequisites line that merely names --output. */
    const outputLine = trimmed(help.stdout).split('\n')
      .find((line) => line.trimStart().startsWith('--output'));
    assert.ok(outputLine !== void 0, 'help lists --output');
    assert.match(outputLine, /absolute/i,
      `the --output description states the path is absolute: ${JSON.stringify(outputLine)}`);
  });
});
