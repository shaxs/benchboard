/**
 * Independent subprocess acceptance for the installed initialization command
 * (task packet C6.S3.T2).
 *
 * Every case here drives the real executable `cli/benchboard.mjs` through a
 * shell-free, bounded `spawnSync` against the real installed identities
 * (the production `loadInstallation()` and the real 26-file challenge), plus
 * the accepted sealed-run read-back path through `openSelectedRun`. No command
 * output is simulated: summaries are read back from real sealed manifests, not from
 * synthetic identity fixtures or folder names, and the prepared-mode case
 * proves the copy against a tiny synthetic cache whose provenance is computed
 * from the ACTUAL copied starter `package.json` / `package-lock.json` bytes.
 *
 * Scope notes fixed by the packet:
 *   - every run uses a fresh external temporary root whose path contains a
 *     space, cleaned up in `t.after`;
 *   - success is exit 0, empty stderr and one JSON line on stdout; controlled
 *     errors are stderr-only `CLI_USAGE` (exit 2) / `CLI_STATE` (exit 3) with
 *     no stack dump and no echo of private canary material;
 *   - install mode is never invoked, not even to test missing prerequisites;
 *     no npm, browsers, servers or participant agents run;
 *   - the cancellation case drives the actual production export
 *     `initializeCommand` with its allowed `AbortController.signal` — it proves
 *     the adapter's own pre-work refusal only, not SIGINT behaviour during a
 *     C4 evaluation;
 *   - the prepared-mode cache is synthetic evidence of the copy path, not a
 *     real toolchain install or evaluation.
 */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inventoryTree, sha256 } from '../../packages/core/identity.mjs';
import { canonicalJson } from '../../packages/core/manifest.mjs';
import {
  DEPENDENCY_HASH_ALGORITHM_ID,
  DEPENDENCIES_METADATA_FILE_NAME,
} from '../../packages/core/dependencies.mjs';
import { loadInstallation } from '../../cli/installation.mjs';
import { openSelectedRun } from '../../cli/run-context.mjs';
import { initializeCommand } from '../../cli/initialize-command.mjs';
import { CommandError } from '../../cli/command-error.mjs';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const entrypoint = path.join(repositoryRoot, 'cli', 'benchboard.mjs');
const starterRoot = path.join(repositoryRoot, 'starter');

/* Bounds so a hung or chatty child cannot outlive the test run. */
const SPAWN_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 1_048_576;

const HEX64 = /^[0-9a-f]{64}$/;
const COMPARE = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Run the entrypoint as one argv array (never through a shell), so every array
 * element — including a path containing a space — is exactly one argument.
 */
function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    encoding: 'utf8',
    shell: false,
    cwd,
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, `the child process completed without a spawn error: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const trimmed = (text) => text.replace(/\r\n/g, '\n').trimEnd();

/** One external temporary root whose generated path contains a space. */
const temporaryRoots = [];
function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bb-init cmd ${label} `));
  temporaryRoots.push(root);
  return root;
}
after(() => {
  for (const root of temporaryRoots)
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 });
});

/** A successful run: exit 0, empty stderr, exactly one parseable JSON line. */
function runExpectingSuccess(args, cwd, label) {
  const result = runCli(args, cwd);
  assert.equal(result.status, 0, `${label}: a completed init exits with status 0`);
  assert.equal(trimmed(result.stderr), '', `${label}: a completed init writes nothing to stderr`);
  const out = trimmed(result.stdout);
  assert.equal(out.split('\n').length, 1, `${label}: the success report is one JSON line`);
  return JSON.parse(out);
}

/** A controlled refusal: stderr-only code, one line, no stack, no stdout. */
function runExpectingRefusal(args, cwd, expectedCode, expectedStatus, canary, label) {
  const result = runCli(args, cwd);
  assert.equal(result.status, expectedStatus, `${label}: exit status is ${expectedStatus}`);
  assert.equal(result.stdout, '', `${label}: a refusal writes nothing to stdout`);
  const err = trimmed(result.stderr);
  assert.equal(err.split('\n').length, 1, `${label}: the refusal is one controlled line: ${JSON.stringify(err)}`);
  assert.ok(err.startsWith(`${expectedCode}: `), `${label}: stderr opens with ${expectedCode}: ${JSON.stringify(err)}`);
  assert.ok(!err.includes('\n    at ') && !err.includes('\n\tat '),
    `${label}: the refusal reports guidance, not a stack dump`);
  if (canary !== void 0)
    assert.ok(!err.includes(canary), `${label}: the refusal does not echo the private canary material`);
  return result;
}

/** A short path that contains a space, usable as one argv element. */
function pathWithSpace(base, name) {
  return path.join(base, name);
}

/** The full byte inventory of a tree, skip names off. */
const rawInventory = (root) => inventoryTree({ root, skipNames: [] });

/* ========================================================================== */
/* Check 1 — two real default-mode exports, read back through the C2 path     */
/* ========================================================================== */

describe('initialize command — check 1: real default-mode init through the actual executable', (t) => {
  const root = tempRoot('export');

  test('two spaced exports report the real roots, identities and cleanup', async () => {
    const installed = loadInstallation();
    const outputA = pathWithSpace(root, 'first container');
    const outputB = pathWithSpace(root, 'second container');

    const summaryA = runExpectingSuccess(['init', '--output', outputA], root, 'export A');
    const summaryB = runExpectingSuccess(['init', '--output', outputB], root, 'export B');

    for (const [label, summary, output] of [['A', summaryA, outputA], ['B', summaryB, outputB]]) {
      assert.equal(summary.command, 'init', `export ${label}: the summary names the command`);
      assert.equal(summary.status, 'initialised', `export ${label}: the summary reports the initialised status`);
      /* The summary identifies the real roots, not synthetic or relative ones. */
      assert.equal(path.resolve(summary.output), path.resolve(output), `export ${label}: the summary output root is the requested container`);
      assert.equal(path.resolve(summary.workspaceRoot), path.resolve(output, 'workspace'), `export ${label}: the workspace root is the container workspace`);
      assert.equal(path.resolve(summary.stateRoot), path.resolve(output, '.benchboard'), `export ${label}: the state root is the container state directory`);
      assert.ok(fs.existsSync(summary.workspaceRoot) && fs.existsSync(summary.stateRoot),
        `export ${label}: both reported roots exist on disk`);
      assert.equal(summary.workloadFileCount, 26, `export ${label}: the workload carries 26 files`);
      assert.equal(summary.workloadDigest, installed.descriptor.workloadDigest,
        `export ${label}: the workload digest is the exact loaded installation digest`);
      assert.equal(summary.dependencyMode, 'none', `export ${label}: the default dependency mode is none`);
      assert.equal(summary.dependencyDigest, null, `export ${label}: mode none records no dependency digest`);
      assert.match(summary.manifestId, /^manifest-[0-9a-f]{32}$/, `export ${label}: the manifest id is a real minted identity`);
      assert.match(summary.runId, /^run-[0-9a-f]{32}$/, `export ${label}: the run id is a real minted identity`);
      /* The temporary challenge source was disposed after the run. */
      assert.equal(summary.sourceCleanup?.status, 'removed', `export ${label}: the materialised source reports removal`);
      assert.ok(!fs.existsSync(summary.sourceCleanup.root), `export ${label}: the source root no longer exists on disk`);
      /* The summary is a run summary, not a manifest or an error dump. */
      for (const forbiddenKey of ['manifest', 'storage', 'journal', 'errors', 'storageRoot', 'journalRoot'])
        assert.ok(!(forbiddenKey in summary), `export ${label}: the summary carries no raw ${forbiddenKey} field`);
    }

    /* The two exports are separate runs with separate identities. */
    assert.notEqual(summaryA.manifestId, summaryB.manifestId, 'the two exports seal separate manifest ids');
    assert.notEqual(summaryA.runId, summaryB.runId, 'the two exports mint separate run ids');

    /* The run architecture id is its own domain, separate from the three
     * bound identity domains, and separate between the two exports. This
     * reads the sealed manifests back through the accepted C2 open path, so
     * it is the real record — not a synthetic identity fixture. */
    const openedA = await openSelectedRun(summaryA.output);
    const openedB = await openSelectedRun(summaryB.output);
    assert.equal(openedA.runId, summaryA.runId, 'export A: the opened run id matches the summary');
    assert.equal(openedA.manifestId, summaryA.manifestId, 'export A: the opened manifest id matches the summary');
    assert.equal(openedB.runId, summaryB.runId, 'export B: the opened run id matches the summary');
    for (const [label, opened] of [['A', openedA], ['B', openedB]]) {
      const manifest = opened.manifest;
      assert.equal(manifest.harness, 'manual', `export ${label}: the sealed manifest records the harness as manual`);
      const domains = [
        manifest.architectureId,
        manifest.bindings.tooling.architectureId,
        manifest.bindings.challenge.architectureId,
        manifest.bindings.evaluator.architectureId,
      ];
      assert.equal(new Set(domains).size, 4,
        `export ${label}: the run architecture id and the tooling, challenge and evaluator architecture ids are pairwise distinct: ${JSON.stringify(domains)}`);
      /* The accepted unknown-is-never-zero assertions (mirroring the accepted
       * C2 test at init.test.mjs:568-585), applied to the real sealed manifest.
       * No model, worker count, location, os or node version is invented. */
      const configuration = manifest.configuration;
      assert.ok(configuration !== void 0 && configuration !== null, `export ${label}: a configuration record exists`);
      for (const key of ['model', 'location', 'os', 'nodeVersion']) {
        assert.ok(!(key in configuration) || configuration[key] === null,
          `export ${label}: configuration.${key} is absent or null, because nobody stated it`);
        assert.notEqual(configuration[key], 0, `export ${label}: configuration.${key} is not zero`);
        assert.notEqual(configuration[key], '', `export ${label}: configuration.${key} is not an empty string`);
        assert.ok(configuration.unknownFields.includes(key), `export ${label}: configuration.unknownFields names ${key}`);
      }
      assert.equal(configuration.unknown, 'UNKNOWN', `export ${label}: the configuration record says it is unknown`);
      assert.equal(manifest.securityModel, 'UNSPECIFIED', `export ${label}: no security model is inferred`);
    }
    assert.notEqual(openedA.manifest.architectureId, openedB.manifest.architectureId,
      'the two exports mint separate run architecture domains');

    /* Each workspace, walked with nothing skipped, is exactly the 26 real
     * installed workload files — no state, evaluator, CLI or owner material,
     * and the two workspaces are byte-identical. */
    const expectedPaths = [...installed.challenge.fileManifest].sort(COMPARE);
    const inventories = [];
    for (const [label, opened] of [['A', openedA], ['B', openedB]]) {
      const inventory = rawInventory(opened.workspaceRoot);
      const paths = inventory.entries.map((entry) => entry.path).sort(COMPARE);
      assert.deepEqual(paths, expectedPaths,
        `export ${label}: the workspace holds exactly the ${expectedPaths.length} installed workload files`);
      assert.equal(inventory.digest, installed.descriptor.workloadDigest,
        `export ${label}: the raw workspace tree digest equals the installed workload digest`);
      for (const forbidden of ['.benchboard', 'evaluator', 'node_modules', 'fixtures', 'reference', 'artifacts'])
        assert.ok(!paths.some((one) => one === forbidden || one.startsWith(`${forbidden}/`)),
          `export ${label}: no ${forbidden} material inside the workspace`);
      inventories.push(inventory);
    }
    assert.deepEqual(inventories[0].entries, inventories[1].entries,
      'the two workspaces are byte-identical file for file');
    assert.notEqual(inventories[0].root, inventories[1].root, 'the two workspaces are separate roots');

    /* A second load captures the current selected bytes; compare its manifest
     * with the captured pre-run manifest, not an assumed tooling release hash.
     * Canonical challenge facts are also reverified by that load. */
    const after = loadInstallation();
    assert.deepEqual(JSON.parse(canonicalJson(after.descriptor)), JSON.parse(canonicalJson(installed.descriptor)),
      'the installation descriptor is unchanged after the exports');
    assert.deepEqual(after.assetManifest.map((entry) => `${entry.path}:${entry.sha256}`),
      installed.assetManifest.map((entry) => `${entry.path}:${entry.sha256}`),
      'every selected asset byte is unchanged after the exports');
    const starterRecheck = inventoryTree({ root: starterRoot });
    assert.equal(starterRecheck.digest, installed.descriptor.workloadDigest,
      'the installed starter tree still hashes to the recorded workload digest');
  });
});

/* ========================================================================== */
/* Check 2 — the real adapter error map, against real subprocess runs          */
/* ========================================================================== */

describe('initialize command — check 2: controlled refusals through the actual executable', () => {
  const root = tempRoot('refusals');
  const CANARY = 'private canary material — never echo this';

  test('existing output with foreign material is refused and fully preserved', () => {
    const output = pathWithSpace(root, 'occupied container');
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'foreign file.txt'), CANARY, 'utf8');
    const before = rawInventory(output);
    runExpectingRefusal(['init', '--output', output], root, 'CLI_STATE', 3, CANARY, 'occupied output');
    const after = rawInventory(output);
    assert.deepEqual(after.entries, before.entries,
      'the refused run left the existing output inventory byte-identical');
  });

  test('a missing output parent is refused without creating parents', () => {
    const missingParent = pathWithSpace(root, 'no such parent folder');
    const output = path.join(missingParent, 'container');
    runExpectingRefusal(['init', '--output', output], root, 'CLI_STATE', 3, void 0, 'missing parent');
    assert.equal(fs.existsSync(missingParent), false, 'the missing parent was not created');
    assert.equal(fs.existsSync(output), false, 'no output container was created');
  });

  test('mode prepared without --prepared-root is refused and creates no output', () => {
    const output = pathWithSpace(root, 'prepared without root');
    runExpectingRefusal(['init', '--output', output, '--dependency-mode', 'prepared'],
      root, 'CLI_STATE', 3, void 0, 'prepared without root');
    assert.equal(fs.existsSync(output), false, 'no output container was created');
  });

  test('an unknown dependency mode is a usage refusal before any output', () => {
    const output = pathWithSpace(root, 'sideways mode');
    runExpectingRefusal(['init', '--output', output, '--dependency-mode', 'sideways'],
      root, 'CLI_USAGE', 2, void 0, 'unknown mode');
    assert.equal(fs.existsSync(output), false, 'no output container was created');
  });

  test('mode none with --prepared-root is refused rather than ignored', () => {
    /* The flag names a real existing directory so the refusal can only come
     * from the mode/mode-option mismatch, not from a missing path. Install
     * mode is never invoked, per the packet. */
    const decoy = pathWithSpace(root, 'prepared decoy');
    fs.mkdirSync(decoy);
    const output = pathWithSpace(root, 'mode none with prepared root');
    runExpectingRefusal(['init', '--output', output, '--dependency-mode', 'none', '--prepared-root', decoy],
      root, 'CLI_STATE', 3, void 0, 'mode none with prepared root');
    assert.equal(fs.existsSync(output), false, 'no output container was created');
  });
});

/* ========================================================================== */
/* Check 3 — explicit prepared mode against a synthetic cache                 */
/* ========================================================================== */

describe('initialize command — check 3: explicit prepared mode copies a declared cache', () => {
  /* This is synthetic cache evidence for the copy path, not a real toolchain
   * install and not an evaluation. The provenance digests below are computed
   * from the ACTUAL copied starter lock bytes. */
  const root = tempRoot('prepared');

  test('a declared synthetic cache lands in the workspace with its own digest domain', () => {
    /* The locked source: the real installed starter lock bytes, copied to a
     * separate external directory so the cache can declare what it was built
     * from without the CLI being pointed at the installation root. */
    const lockedSource = pathWithSpace(root, 'locked source');
    fs.mkdirSync(lockedSource);
    for (const file of ['package.json', 'package-lock.json'])
      fs.copyFileSync(path.join(starterRoot, file), path.join(lockedSource, file));

    /* The tiny synthetic cache, built the way the accepted C2 example builds
     * one: an ordinary package directory plus the provenance marker whose lock
     * and manifest digests are the sha256 of the actual copied bytes. */
    const cacheRoot = pathWithSpace(root, 'dep cache');
    const preparedRoot = path.join(cacheRoot, 'node_modules');
    const packageRoot = path.join(preparedRoot, 'synthetic-dep');
    fs.mkdirSync(packageRoot, { recursive: true });
    const packageBytes = Buffer.from('{"name":"synthetic-dep"}\n', 'utf8');
    fs.writeFileSync(path.join(packageRoot, 'package.json'), packageBytes);
    const marker = {
      schemaVersion: '1.0.0',
      module: 'benchboard.core.dependencies',
      hashAlgorithmId: DEPENDENCY_HASH_ALGORITHM_ID,
      mode: 'prepared',
      provenance: {
        lockfileName: 'package-lock.json',
        manifestFileName: 'package.json',
        lockDigest: sha256(fs.readFileSync(path.join(lockedSource, 'package-lock.json'))),
        manifestDigest: sha256(fs.readFileSync(path.join(lockedSource, 'package.json'))),
      },
    };
    fs.writeFileSync(path.join(preparedRoot, DEPENDENCIES_METADATA_FILE_NAME), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

    const cacheBefore = rawInventory(cacheRoot);
    const lockedBefore = rawInventory(lockedSource);

    const output = pathWithSpace(root, 'prepared container');
    const summary = runExpectingSuccess(
      ['init', '--output', output, '--dependency-mode', 'prepared',
        '--source-root', lockedSource, '--prepared-root', preparedRoot],
      root, 'prepared run');

    assert.equal(summary.dependencyMode, 'prepared', 'the summary reports the declared prepared mode');
    assert.match(summary.dependencyDigest, HEX64, 'the dependency digest is a 64-hex value');
    assert.notEqual(summary.dependencyDigest, summary.workloadDigest,
      'the dependency digest lives in its own hash domain, separate from the workload digest');
    assert.equal(summary.workloadFileCount, 26, 'the canonical 26 workload files are retained ahead of the optional dependencies');
    assert.equal(summary.sourceCleanup?.status, 'removed', 'the materialised source reports removal');
    assert.ok(!fs.existsSync(summary.sourceCleanup.root), 'the source root no longer exists on disk');

    /* The synthetic package sits in the participant tree byte-for-byte, and
     * the provenance marker is kept out of it. */
    const workspace = path.resolve(summary.workspaceRoot);
    const workspaceInventory = rawInventory(workspace);
    const dependencyEntry = workspaceInventory.entries.find(
      (entry) => entry.path === 'node_modules/synthetic-dep/package.json');
    assert.ok(dependencyEntry !== void 0, 'the synthetic dependency package was copied into the workspace');
    assert.equal(dependencyEntry.sha256, sha256(packageBytes), 'the copied package bytes are byte-identical to the cache');
    assert.ok(!workspaceInventory.entries.some((entry) => entry.path.split('/').includes(DEPENDENCIES_METADATA_FILE_NAME)),
      `the ${DEPENDENCIES_METADATA_FILE_NAME} provenance marker was excluded from the participant tree`);
    /* The canonical workload files remain exactly the 26 declared ones. */
    const workloadPaths = workspaceInventory.entries
      .map((entry) => entry.path)
      .filter((one) => !one.startsWith('node_modules/'))
      .sort(COMPARE);
    assert.deepEqual(workloadPaths, [...loadInstallation().challenge.fileManifest].sort(COMPARE),
      'the workspace still carries exactly the 26 canonical workload files');

    /* The cache, the locked source and the installed bytes are unchanged by
     * the run: a byte-for-byte before/after on both external trees plus a
     * full re-load of the installation. */
    assert.deepEqual(rawInventory(cacheRoot).entries, cacheBefore.entries, 'the synthetic cache bytes are unchanged');
    assert.deepEqual(rawInventory(lockedSource).entries, lockedBefore.entries, 'the locked source bytes are unchanged');
    const installed = loadInstallation();
    assert.equal(inventoryTree({ root: starterRoot }).digest, installed.descriptor.workloadDigest,
      'the installed challenge bytes are unchanged after the prepared run');
  });
});

/* ========================================================================== */
/* Check 4 — the production export refuses an already-aborted signal           */
/* ========================================================================== */

describe('initialize command — check 4: a pre-aborted signal is refused before any work', () => {
  /* This drives the actual production export with its allowed signal — the
   * adapter's own documented refusal of a signal that was already aborted. It
   * proves no more than that: not SIGINT behaviour during a C4 evaluation, and
   * nothing about interruption of already-committed work. */
  const root = tempRoot('aborted');

  test('initializeCommand rejects category cancelled before creating output', async () => {
    const output = pathWithSpace(root, 'aborted container');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      initializeCommand({ '--output': output }, { signal: controller.signal }),
      (error) => error instanceof CommandError && error.category === 'cancelled',
      'the already-aborted signal rejects with the cancelled category',
    );
    assert.equal(fs.existsSync(output), false, 'the refusal created no output container');
  });
});
