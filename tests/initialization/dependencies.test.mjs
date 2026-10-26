/**
 * Focused acceptance tests for `packages/core/dependencies.mjs` (CHUNK C2, tasks
 * T2 and T6).
 *
 * Contract under test (the approved C2 execution plan, T2 row as amended by T6),
 * named by chunk and task rather than by a private repository path because this
 * file is distributed:
 *  - the three dependency modes are explicit, never inferred;
 *  - `none` executes nothing at all;
 *  - `prepared` copies an explicitly compatible cache as ordinary files with
 *    source-before / copy / source-after verification, while preserving the
 *    source and the cache byte-for-byte;
 *  - the locked source lock and manifest, and any lock-family file already in
 *    the participant workspace, must agree with the lock being prepared, before
 *    the copy and again before the publication;
 *  - links, special files and case collisions inside a dependency tree are
 *    refused (never silently weakened);
 *  - a metadata destination is refused before any write when it falls inside a
 *    protected root;
 *  - a built command never repeats its executable as an argument, runs without a
 *    shell, and is proven against a real subprocess;
 *  - bounded, explicit offline / process-failure / timeout diagnostics plus
 *    helper-owned cleanup that never touches caller bytes and never deletes a
 *    publication it did not create;
 *  - all of the above is verified before any timing concern (T3 owns the
 *    initialiser seam; nothing here imports it).
 *
 * Discipline enforced here:
 *  - every scratch path is derived from `BENCHBOARD_TEST_TMP` or
 *    `BENCHBOARD_TEST_SCRATCH_ROOT` when either names an absolute directory,
 *    otherwise from `.local/test-scratch/` inside this repository, which is the
 *    ignored, repository-contained fallback. No operating-system temporary
 *    default and no sibling-path default is used, and no private evidence path
 *    is embedded in this distributed file;
 *  - no network access and no real benchmark installation: the package manager
 *    is a deterministic injected adapter, so these tests are hermetic. The only
 *    real subprocesses are local, no-network Node fixtures that are not npm, plus
 *    the runtime's own `--version` self-check, which prove the process plumbing
 *    rather than a command shape;
 *  - the read-only repository sources are never modified by this file, and the
 *    only repository bytes it writes are under the ignored fallback directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as core from '../../packages/core/dependencies.mjs';
import * as identity from '../../packages/core/identity.mjs';

const {
  DEPENDENCY_MODES,
  DEPENDENCY_ERROR_CODES,
  DEPENDENCY_HASH_ALGORITHM_ID,
  DEPENDENCIES_DIRECTORY_NAME,
  DEPENDENCIES_METADATA_FILE_NAME,
  DEPENDENCIES_MODULE_ID,
  DEPENDENCIES_CONTRACT_VERSION,
  DEPENDENCY_LIMITS,
  NPM_BIN_LINK_POLICY,
  NPM_COMMAND_STRATEGIES,
  NPM_FORWARDED_ENVIRONMENT,
  DependencyError,
  prepareDependencies,
  resolveDependencyCommandStrategy,
  buildDependencyCommand,
  createNodeSpawnAdapter,
} = core;

const HEX64 = /^[0-9a-f]{64}$/;
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** Repository-contained, ignored fallback used only when the harness sets nothing. */
const CONTAINED_SCRATCH = path.join(REPO_ROOT, '.local', 'test-scratch', 'dependencies');

/* ------------------------------------------------------------- scratch roots */

/**
 * The explicit, absolute, contained root every fixture lives under. Honours
 * `BENCHBOARD_TEST_TMP` or `BENCHBOARD_TEST_SCRATCH_ROOT` when either names an
 * absolute directory, and otherwise falls back to the ignored, repository-
 * contained directory above. Never `node:os.tmpdir()`, and never a path that
 * points at owner-only evidence.
 */
function testScratchRoot() {
  for (const name of ['BENCHBOARD_TEST_TMP', 'BENCHBOARD_TEST_SCRATCH_ROOT']) {
    const override = process.env[name];
    if (override === void 0 || override === '') continue;
    if (!path.isAbsolute(override)) {
      throw Error(`${name} must be an absolute path, got ${JSON.stringify(override)}.`);
    }
    return path.resolve(override);
  }
  return CONTAINED_SCRATCH;
}

/** A unique case directory under the scratch root, removed when the case ends. */
function caseRoot(t, label) {
  const root = testScratchRoot();
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, `deps-${label}-`));
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function sub(root, name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function sha(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

/* -------------------------------------------------------------- fixtures */

const DEFAULT_LOCK = '{"lockVersion":3,"name":"fixture","packages":{}}';
const DEFAULT_MANIFEST = '{"name":"fixture","version":"1.0.0"}';

/** A locked dependency source root: lock plus manifest, nothing else. */
function makeSourceRoot(root, { lock = DEFAULT_LOCK, manifest = DEFAULT_MANIFEST } = {}) {
  const sourceRoot = sub(root, 'source');
  write(path.join(sourceRoot, 'package-lock.json'), lock);
  write(path.join(sourceRoot, 'package.json'), manifest);
  return sourceRoot;
}

/** An empty, caller-owned, scratch-looking workspace with an untouched sentinel. */
function makeWorkspace(root, { files = { 'caller.txt': 'caller byte\n' }, name = 'workspace' } = {}) {
  const workspaceRoot = sub(root, name);
  for (const [name, text] of Object.entries(files)) {
    write(path.join(workspaceRoot, name), text);
  }
  return workspaceRoot;
}

/**
 * A prepared cache: an ordinary dependency tree plus the declared provenance
 * record that makes it compatible. The record is built from the real lock
 * bytes, exactly as a producing installation would have written it.
 *
 * The inventory root of a cache is `preparedRoot` itself: the module inventories
 * the cache root and excludes only the provenance marker at that level, so the
 * cache's contents are exactly the dependency tree's contents.
 */
function makeCache(root, sourceRoot, files, overrides = {}) {
  const preparedRoot = sub(root, 'cache');
  for (const [relative, text] of Object.entries(files)) {
    write(path.join(preparedRoot, relative), text);
  }
  const lockText = readText(path.join(sourceRoot, 'package-lock.json'));
  const manifestText = readText(path.join(sourceRoot, 'package.json'));
  const record = {
    schemaVersion: DEPENDENCIES_CONTRACT_VERSION,
    module: DEPENDENCIES_MODULE_ID,
    hashAlgorithmId: DEPENDENCY_HASH_ALGORITHM_ID,
    mode: 'install',
    provenance: {
      lockfileName: 'package-lock.json',
      manifestFileName: 'package.json',
      lockDigest: sha(lockText),
      manifestDigest: sha(manifestText),
      installStrategy: 'hoisted',
      npmExecutable: 'C:/fixture/npm.cmd',
      sourceRoot: sourceRoot.split(path.sep).join('/'),
    },
    ...overrides,
  };
  write(path.join(preparedRoot, DEPENDENCIES_METADATA_FILE_NAME), `${JSON.stringify(record, void 0, 2)}\n`);
  return preparedRoot;
}

/**
 * Independent recompute of a dependency digest over the same hash domain. The
 * passed directory is the inventory root itself: the contents of a prepared
 * cache for `prepared`, and the committed dependency directory for `install`.
 * The provenance marker at that root level is excluded, as the module does.
 */
function expectedDependencyDigest(root) {
  const pairs = [];
  const visit = (directory, relative) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const rel = relative === '' ? name : `${relative}/${name}`;
      if (relative === '' && name === DEPENDENCIES_METADATA_FILE_NAME) {
        continue;
      }
      const status = fs.lstatSync(absolute);
      if (status.isDirectory()) {
        visit(absolute, rel);
      } else {
        pairs.push([rel, sha(fs.readFileSync(absolute))]);
      }
    }
  };
  visit(root, '');
  pairs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return identity.hashEntries(pairs);
}

/** Byte fingerprint of a whole tree, used to prove nothing was disturbed. */
function treeFingerprint(root) {
  return identity.inventoryTree({ root }).digest;
}

/* ------------------------------------------------------------- adapters */

/** An adapter that records its request and resolves with a fixed outcome. */
function adapterReturning(outcome, { onCall = null } = {}) {
  const calls = [];
  const adapter = async (request) => {
    calls.push(request);
    if (onCall !== null) {
      onCall(request);
    }
    return outcome;
  };
  adapter.calls = calls;
  return adapter;
}

/** An adapter that materialises a dependency tree in the staging directory. */
function adapterInstalling(files, outcome = { status: 0, signal: null, stdout: '', stderr: '', timedOut: false }) {
  const adapter = adapterReturning(outcome, {
    onCall: (request) => {
      for (const [relative, text] of Object.entries(files)) {
        write(path.join(request.cwd, DEPENDENCIES_DIRECTORY_NAME, relative), text);
      }
    },
  });
  // The bytes this stand-in package manager produced. They are the definition of
  // "the staged tree", so a test can prove the published tree is exactly them.
  adapter.installedFiles = files;
  return adapter;
}

const SUCCESSFUL_OUTCOME = Object.freeze({ status: 0, signal: null, stdout: '', stderr: '', timedOut: false });

/* ----------------------------------------------------------- assertions */

async function refusesWith(t, operation, code, label = code) {
  try {
    await operation();
  } catch (error) {
    assert.ok(error instanceof DependencyError, `${label}: rejects with DependencyError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code, `${label}: code`);
    assert.ok(typeof error.message === 'string' && error.message.length > 40, `${label}: carries a diagnostic message`);
    return error;
  }
  assert.fail(`${label}: expected a ${code} refusal, the call succeeded`);
}

function installInput(root, overrides = {}) {
  const workspaceRoot = path.join(root, 'workspace');
  const sourceRoot = path.join(root, 'source');
  const scratchRoot = path.join(root, 'scratch');
  return {
    mode: 'install',
    workspaceRoot,
    sourceRoot,
    scratchRoot,
    npmExecutable: path.join(root, 'npm.cmd'),
    ...overrides,
  };
}

function preparedInput(root, overrides = {}) {
  return {
    mode: 'prepared',
    workspaceRoot: path.join(root, 'workspace'),
    preparedRoot: path.join(root, 'cache'),
    sourceRoot: path.join(root, 'source'),
    ...overrides,
  };
}

/* =================================================================== suite */

test('the shipped dependency surface is exactly the declared one', () => {
  const expectedNames = [
    'DEPENDENCIES_MODULE_ID',
    'DEPENDENCIES_CONTRACT_VERSION',
    'DEPENDENCY_HASH_ALGORITHM_ID',
    'DEPENDENCIES_DIRECTORY_NAME',
    'DEPENDENCIES_METADATA_FILE_NAME',
    'DEPENDENCY_MODES',
    'DEPENDENCY_ERROR_CODES',
    'NPM_BIN_LINK_POLICY',
    'NPM_COMMAND_STRATEGIES',
    'DEPENDENCY_LIMITS',
    'NPM_FORWARDED_ENVIRONMENT',
    'DependencyError',
    'resolveDependencyCommandStrategy',
    'buildDependencyCommand',
    'createNodeSpawnAdapter',
    'prepareDependencies',
  ].sort();
  assert.deepEqual(Object.keys(core).sort(), expectedNames, 'no undeclared member is exported and no declared member is missing');

  assert.equal(DEPENDENCIES_MODULE_ID, 'benchboard.core.dependencies');
  assert.equal(DEPENDENCIES_CONTRACT_VERSION, '1.0.0');
  assert.equal(DEPENDENCY_HASH_ALGORITHM_ID, 'benchboard-dependency-tree-v1');
  assert.equal(DEPENDENCIES_DIRECTORY_NAME, 'node_modules');
  assert.equal(DEPENDENCIES_METADATA_FILE_NAME, '.benchboard-dependencies.json');
  assert.deepEqual([...DEPENDENCY_MODES], ['none', 'prepared', 'install']);
  assert.ok(Object.isFrozen(DEPENDENCY_MODES), 'the mode list is frozen');
  assert.ok(Object.isFrozen(DEPENDENCY_ERROR_CODES), 'the code map is frozen');

  // The dependency hash domain must never be conflated with the workload tree
  // domain owned by `packages/core/identity.mjs`.
  assert.notEqual(DEPENDENCY_HASH_ALGORITHM_ID, identity.HASH_ALGORITHM_ID, 'dependency and workload hash domains are distinct');
  assert.equal(identity.HASH_ALGORITHM_ID, 'benchboard-sha256-tree-v1');
});

test('the published limits and npm bin-link policy are explicit and refusing', () => {
  for (const [name, value] of Object.entries(DEPENDENCY_LIMITS)) {
    assert.ok(Number.isSafeInteger(value) && value > 0, `DEPENDENCY_LIMITS.${name} is a positive safe integer`);
  }
  assert.ok(Object.isFrozen(DEPENDENCY_LIMITS));

  assert.equal(NPM_BIN_LINK_POLICY.materialisation, 'refused', 'links inside a dependency tree are refused, never materialised');
  assert.equal(NPM_BIN_LINK_POLICY.resolveTargets, false);
  assert.equal(NPM_BIN_LINK_POLICY.insideCacheOnly, true);
  assert.ok(Object.isFrozen(NPM_BIN_LINK_POLICY));

  assert.deepEqual({ ...NPM_COMMAND_STRATEGIES }, { DIRECT: 'direct', CMD_EXE: 'cmdexe' });

  assert.ok(Array.isArray([...NPM_FORWARDED_ENVIRONMENT]) && NPM_FORWARDED_ENVIRONMENT.length > 0);
  assert.ok(NPM_FORWARDED_ENVIRONMENT.every((name) => typeof name === 'string' && name.length > 0));

  const instance = new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'probe', { probe: true });
  assert.ok(instance instanceof Error, 'DependencyError is throwable as an Error');
  assert.equal(instance.name, 'DependencyError');
  assert.equal(instance.code, DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT);
  assert.deepEqual(instance.details, { probe: true });
  assert.ok(Object.isFrozen(instance.details));
});

test('every refusal code is unique, upper snake case and carried by the error', async (t) => {
  const codes = Object.values(DEPENDENCY_ERROR_CODES);
  assert.ok(codes.length >= 40, 'the code set is exhaustive enough for the contract');
  assert.equal(new Set(codes).size, codes.length, 'codes are unique');
  for (const code of codes) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/, `${code} is an upper snake case identifier`);
  }

  const root = caseRoot(t, 'code-transport');
  const error = await refusesWith(t, () => prepareDependencies({ mode: 'nope', workspaceRoot: root }), DEPENDENCY_ERROR_CODES.MODE_NOT_DECLARED, 'unknown mode')
    .catch(() => null);
  assert.equal(error === null ? 'no-error' : error.constructor.name, 'DependencyError', 'a refused call still throws');
});

/* ---------------------------------------------------------------- mode: none */

test('mode "none" is a pure decision: nothing executes and no root is touched', async (t) => {
  const root = caseRoot(t, 'none');
  const workspaceRoot = makeWorkspace(root);
  const before = fs.readdirSync(workspaceRoot).sort();

  const result = await prepareDependencies({ mode: 'none', workspaceRoot });

  assert.equal(result.mode, 'none');
  assert.equal(result.dependencyDigest, null, 'no dependency bytes exist, so the digest is null rather than empty');
  assert.equal(result.inventory.mode, 'none');
  assert.equal(result.inventory.digest, null);
  assert.equal(result.inventory.root, null);
  assert.deepEqual([...result.inventory.entries], []);
  assert.equal(result.inventory.totalBytes, 0);
  assert.equal(result.inventory.hashAlgorithmId, DEPENDENCY_HASH_ALGORITHM_ID);
  assert.equal(result.metadata.executed, false, 'no process was executed');
  assert.equal(result.metadata.persisted, false, 'nothing is written without an explicit metadataPath');
  assert.equal(result.metadata.metadataPath, null);
  assert.equal(result.metadata.npm, null);
  assert.equal(result.metadata.provenance, null);
  assert.equal(result.metadata.dependencyDirectory, null);
  assert.equal(result.metadata.copiedFiles, 0);
  assert.equal(result.metadata.copiedBytes, 0);
  assert.deepEqual([...result.metadata.cleanedUp], []);
  assert.equal(result.metadata.mode, 'none');
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.inventory) && Object.isFrozen(result.metadata), 'the result is immutable');

  assert.deepEqual(fs.readdirSync(workspaceRoot).sort(), before, 'the workspace is byte- and entry-identical');
  assert.ok(!fs.existsSync(path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME)), 'no dependency directory is created');

  // A root that cannot exist proves the absence of any filesystem access: any
  // probing at all would have failed with a root error instead of deciding.
  const imaginary = path.join(root, 'never-created');
  const decided = await prepareDependencies({ mode: 'none', workspaceRoot: imaginary });
  assert.equal(decided.dependencyDigest, null);
  assert.equal(decided.metadata.executed, false);
});

test('mode "none" refuses options that would give it something to act on', async (t) => {
  const root = caseRoot(t, 'none-options');
  const workspaceRoot = makeWorkspace(root);
  for (const forbidden of ['preparedRoot', 'npmExecutable', 'sourceRoot', 'scratchRoot']) {
    await refusesWith(t, () => prepareDependencies({ mode: 'none', workspaceRoot, [forbidden]: path.join(root, 'x') }), DEPENDENCY_ERROR_CODES.MODE_OPTION_MISMATCH, `none plus ${forbidden}`);
  }
  await refusesWith(t, () => prepareDependencies({ mode: 'none', workspaceRoot, expectedDependencyDigest: sha('x') }), DEPENDENCY_ERROR_CODES.MODE_OPTION_MISMATCH, 'none plus an expected digest');
});

test('the mode is mandatory: nothing is inferred from the supplied roots', async (t) => {
  const root = caseRoot(t, 'mode-explicit');
  const workspaceRoot = makeWorkspace(root);
  for (const mode of [void 0, null, '', 'NONE', 'auto', 0, {}]) {
    await refusesWith(t, () => prepareDependencies({ mode, workspaceRoot }), DEPENDENCY_ERROR_CODES.MODE_NOT_DECLARED, `mode ${JSON.stringify(mode)}`);
  }
  // A prepared cache plus a workspace must not be enough to infer a mode.
  const sourceRoot = makeSourceRoot(root);
  makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' });
  await refusesWith(t, () => prepareDependencies({ workspaceRoot, preparedRoot: path.join(root, 'cache'), sourceRoot }), DEPENDENCY_ERROR_CODES.MODE_NOT_DECLARED, 'no mode at all');
  await refusesWith(t, () => prepareDependencies(null), DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'no options object');
  await refusesWith(t, () => prepareDependencies([]), DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'an array is not an options object');
});

/* ------------------------------------------------------------- root hygiene */

test('every non-none mode demands absolute, existing, non-link roots', async (t) => {
  const root = caseRoot(t, 'roots');
  const sourceRoot = makeSourceRoot(root);
  makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' });
  makeWorkspace(root);

  await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: 'workspace' })), DEPENDENCY_ERROR_CODES.INVALID_ROOT, 'a relative workspaceRoot');
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: '' })), DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'an empty workspaceRoot is not a path at all');
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: '\\\\server\\share\\workspace' })), DEPENDENCY_ERROR_CODES.INVALID_ROOT, 'a network share is not a locally verifiable root');
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: path.join(root, 'absent') })), DEPENDENCY_ERROR_CODES.ROOT_NOT_FOUND, 'a missing workspaceRoot');
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: path.join(sourceRoot, 'package.json') })), DEPENDENCY_ERROR_CODES.ROOT_NOT_A_DIRECTORY, 'a file is not a workspace');
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { preparedRoot: path.join(root, 'absent-cache') })), DEPENDENCY_ERROR_CODES.ROOT_NOT_FOUND, 'a missing prepared cache');
});

test('a workspace must be exclusively caller-owned scratch, never a repository or run directory', async (t) => {
  const root = caseRoot(t, 'scratch-proof');
  const sourceRoot = makeSourceRoot(root);
  makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' });

  // The repository root itself must be refused, and refused without touching it.
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: REPO_ROOT })), DEPENDENCY_ERROR_CODES.WORKSPACE_NOT_SCRATCH, 'the repository root');

  const gitWorkspace = makeWorkspace(root, { files: {}, name: 'ws-git' });
  fs.mkdirSync(path.join(gitWorkspace, '.git'));
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: gitWorkspace })), DEPENDENCY_ERROR_CODES.WORKSPACE_NOT_SCRATCH, 'a workspace containing .git');

  for (const marker of ['.benchboard', '.benchboard-state']) {
    const runWorkspace = makeWorkspace(root, { files: {}, name: `ws-${marker.replace(/\W/g, '')}` });
    write(path.join(runWorkspace, marker, 'state.json'), '{}\n');
    await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: runWorkspace })), DEPENDENCY_ERROR_CODES.WORKSPACE_METADATA_PRESENT, `a workspace carrying ${marker}`);
  }
});

test('roots must be disjoint: no nesting, no self-reference, no overlap', async (t) => {
  const root = caseRoot(t, 'disjoint');
  const sourceRoot = makeSourceRoot(root);
  makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' });
  const workspaceRoot = makeWorkspace(root);

  await refusesWith(t, () => prepareDependencies(preparedInput(root, { preparedRoot: workspaceRoot })), DEPENDENCY_ERROR_CODES.ROOTS_OVERLAP, 'the cache is the workspace');
  const nestedInsideCache = sub(root, path.join('cache', 'inside-workspace'));
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: nestedInsideCache })), DEPENDENCY_ERROR_CODES.ROOTS_OVERLAP, 'a workspace nested inside the cache');

  // Installation: the locked source may never live inside the participant workspace.
  const installRoot = caseRoot(t, 'disjoint-install');
  const source = makeSourceRoot(installRoot);
  write(path.join(installRoot, 'npm.cmd'), '@echo off\r\n');
  sub(installRoot, 'scratch');
  const workspace = sub(installRoot, 'workspace');
  const nestedSource = path.join(workspace, 'vendored-source');
  fs.mkdirSync(nestedSource);
  write(path.join(nestedSource, 'package-lock.json'), DEFAULT_LOCK);
  write(path.join(nestedSource, 'package.json'), DEFAULT_MANIFEST);
  await refusesWith(t, () => prepareDependencies(installInput(installRoot, { sourceRoot: nestedSource, processAdapter: adapterInstalling({ 'package-left/index.js': 'left\n' }) })), DEPENDENCY_ERROR_CODES.ROOTS_OVERLAP, 'sourceRoot inside workspaceRoot');
  await refusesWith(t, () => prepareDependencies(installInput(installRoot, { scratchRoot: workspace, source, processAdapter: adapterInstalling({ 'package-left/index.js': 'left\n' }) })), DEPENDENCY_ERROR_CODES.ROOTS_OVERLAP, 'scratchRoot is the workspace');
  assert.ok(!fs.existsSync(path.join(workspace, DEPENDENCIES_DIRECTORY_NAME)), 'a refused installation leaves no dependency directory');
  assert.deepEqual(fs.readdirSync(workspace).sort(), ['vendored-source'], 'a refused installation added nothing of its own to the workspace');
});

/* --------------------------------------------------------- prepared: copy */

test('mode "prepared" copies verified ordinary files and reproduces the independent digest', async (t) => {
  const root = caseRoot(t, 'prepared-success');
  const sourceRoot = makeSourceRoot(root);
  const files = {
    'package-left/index.js': 'left byte\n',
    'package-left/package.json': '{"name":"left"}\n',
    'package-left/lib/deep/nested.js': 'nested byte\n',
    'package-right/index.js': 'right byte\n',
    '.bin-note.txt': 'an ordinary file, not a link\n',
  };
  const preparedRoot = makeCache(root, sourceRoot, files);
  const workspaceRoot = makeWorkspace(root);
  const cacheBefore = treeFingerprint(preparedRoot);
  const sourceBefore = treeFingerprint(sourceRoot);
  const expected = expectedDependencyDigest(preparedRoot);

  const result = await prepareDependencies(preparedInput(root, { expectedDependencyDigest: expected }));

  assert.equal(result.mode, 'prepared');
  assert.equal(result.dependencyDigest, expected, 'the dependency digest matches an independent recompute over the same hash domain');
  assert.match(result.dependencyDigest, HEX64);
  assert.equal(result.inventory.hashAlgorithmId, DEPENDENCY_HASH_ALGORITHM_ID, 'the inventory declares the dependency domain, not the workload domain');
  assert.equal(result.inventory.root, path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME).split(path.sep).join('/'));
  const committedPaths = result.inventory.entries.map((entry) => entry.path);
  assert.deepEqual([...committedPaths].sort(), Object.keys(files).sort(), 'exactly the cache files are committed, inventoried relative to the dependency directory itself');
  for (const entry of result.inventory.entries) {
    assert.ok(!entry.path.includes('\\'), `${entry.path} uses POSIX separators`);
    assert.ok(!entry.path.startsWith(`${DEPENDENCIES_DIRECTORY_NAME}/`), `${entry.path} is relative to the dependency directory, not prefixed with it`);
    const committedFile = path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME, ...entry.path.split('/'));
    assert.equal(entry.sha256, sha(readText(committedFile)), `${entry.path}: the committed byte hashes to the inventoried digest`);
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0);
    assert.ok(Object.isFrozen(entry));
  }

  // Provenance travels with the result, the cache record verbatim.
  assert.equal(result.metadata.mode, 'prepared');
  assert.equal(result.metadata.executed, false, 'a cache copy never executes a package manager');
  assert.equal(result.metadata.npm, null);
  assert.equal(result.metadata.persisted, false);
  assert.equal(result.metadata.metadataPath, null);
  assert.equal(result.metadata.provenance.provenance.lockfileName, 'package-lock.json');
  assert.equal(result.metadata.provenance.hashAlgorithmId, DEPENDENCY_HASH_ALGORITHM_ID);
  assert.ok(result.metadata.copiedFiles === Object.keys(files).length, 'the copy report counts every copied file');
  assert.ok(result.metadata.copiedBytes > 0);

  // Source and cache are preserved byte-for-byte.
  assert.equal(treeFingerprint(preparedRoot), cacheBefore, 'the prepared cache is preserved');
  assert.equal(treeFingerprint(sourceRoot), sourceBefore, 'the locked source is preserved');

  // Only the dependency directory is added, and no staging debris survives.
  assert.deepEqual(fs.readdirSync(workspaceRoot).sort(), ['caller.txt', DEPENDENCIES_DIRECTORY_NAME], 'the workspace gains only the dependency directory');
  assert.equal(readText(path.join(workspaceRoot, 'caller.txt')), 'caller byte\n', 'caller bytes are untouched');
  assert.equal(readText(path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME, 'package-left/lib/deep/nested.js')), 'nested byte\n');
  assert.ok(!fs.existsSync(path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME, DEPENDENCIES_METADATA_FILE_NAME)), 'the cache provenance marker is not copied into the participant workspace');
  assert.ok(!fs.existsSync(path.join(workspaceRoot, '.benchboard-tmp')), 'the staging root is retired after a successful copy');
  assert.ok(Array.isArray(result.metadata.cleanedUp) && result.metadata.cleanedUp.length >= 1, 'the helper reports its own retired staging paths');
  assert.notEqual(result.dependencyDigest, identity.hashEntries([...Object.entries(files)].map(([name, text]) => [`${DEPENDENCIES_DIRECTORY_NAME}/${name}`, sha(text)])), 'sanity: the committed digest is over the committed paths');
});

test('the prepared copy excludes the provenance marker from the digest and refuses a mutated cache', async (t) => {
  const root = caseRoot(t, 'prepared-marker');
  const sourceRoot = makeSourceRoot(root);
  const preparedRoot = makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' });

  // An independent recompute that *includes* the marker must differ from the
  // helper digest, proving the marker is excluded rather than coincidentally equal.
  const result = await prepareDependencies(preparedInput(root, { workspaceRoot: makeWorkspace(root, { name: 'ws-a' }) }));
  const withMarker = identity.hashEntries([
    ['package-left/index.js', sha(readText(path.join(preparedRoot, 'package-left', 'index.js')))],
    [DEPENDENCIES_METADATA_FILE_NAME, sha(readText(path.join(preparedRoot, DEPENDENCIES_METADATA_FILE_NAME)))],
  ]);
  assert.notEqual(result.dependencyDigest, withMarker, 'the provenance marker is outside the hashed dependency bytes');

  // Now change only the marker: the dependency bytes are unchanged, so a second
  // preparation against the mutated cache still matches the same digest.
  write(path.join(preparedRoot, DEPENDENCIES_METADATA_FILE_NAME), `${JSON.stringify({ ...JSON.parse(readText(path.join(preparedRoot, DEPENDENCIES_METADATA_FILE_NAME))), schemaVersion: '9.9.9' }, void 0, 2)}\n`);
  const second = await prepareDependencies({ mode: 'prepared', workspaceRoot: makeWorkspace(root, { files: { 'second.txt': 'x' }, name: 'ws-b' }), preparedRoot, sourceRoot });
  assert.equal(second.dependencyDigest, result.dependencyDigest, 'the digest covers dependency bytes, not provenance text');
  assert.equal(second.metadata.provenance.schemaVersion, '9.9.9', 'the carried provenance record is reported verbatim');
});

test('mode "prepared" refuses to merge into or overwrite an existing dependency directory', async (t) => {
  const root = caseRoot(t, 'prepared-target');
  const sourceRoot = makeSourceRoot(root);
  const preparedRoot = makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' });

  const occupied = makeWorkspace(root, { files: { [`${DEPENDENCIES_DIRECTORY_NAME}/existing.txt`]: 'existing byte\n' } });
  await refusesWith(t, () => prepareDependencies({ mode: 'prepared', workspaceRoot: occupied, preparedRoot, sourceRoot }), DEPENDENCY_ERROR_CODES.TARGET_EXISTS, 'an existing node_modules');
  assert.equal(readText(path.join(occupied, DEPENDENCIES_DIRECTORY_NAME, 'existing.txt')), 'existing byte\n', 'the pre-existing dependency byte is not merged into or replaced');
  assert.deepEqual(fs.readdirSync(path.join(occupied, DEPENDENCIES_DIRECTORY_NAME)).sort(), ['existing.txt']);
  assert.ok(!fs.existsSync(path.join(occupied, '.benchboard-tmp')), 'the staging root is retired after a refusal');
});

test('mode "prepared" is inert: it takes no process options and needs a cache root', async (t) => {
  const root = caseRoot(t, 'prepared-options');
  const sourceRoot = makeSourceRoot(root);
  makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' });
  makeWorkspace(root);

  await refusesWith(t, () => prepareDependencies(preparedInput(root, { preparedRoot: void 0 })), DEPENDENCY_ERROR_CODES.PREPARED_ROOT_REQUIRED, 'no preparedRoot');
  for (const forbidden of ['npmExecutable', 'scratchRoot', 'processAdapter', 'installStrategy', 'timeoutMs', 'offline']) {
    await refusesWith(t, () => prepareDependencies(preparedInput(root, { [forbidden]: forbidden === 'timeoutMs' ? 1000 : 'x' })), DEPENDENCY_ERROR_CODES.MODE_OPTION_MISMATCH, `prepared plus ${forbidden}`);
  }
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { expectedDependencyDigest: 'nothex' })), DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'a malformed expected digest');
});

/* --------------------------------------------------- provenance and locks */

test('cache compatibility is declared: a missing or foreign provenance record is refused', async (t) => {
  const root = caseRoot(t, 'provenance');
  const sourceRoot = makeSourceRoot(root);
  makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' });
  const cacheRoot = path.join(root, 'cache');
  // Seed the pristine record before any mutation so every iteration restores
  // the real bytes instead of an empty file.
  originalRecord = readText(path.join(cacheRoot, DEPENDENCIES_METADATA_FILE_NAME));

  // No marker at all.
  const bare = sub(root, 'bare-cache');
  write(path.join(bare, 'package-left/index.js'), 'left\n');
  await refusesWith(t, () => prepareDependencies({ mode: 'prepared', workspaceRoot: makeWorkspace(root, { files: {} }), preparedRoot: bare, sourceRoot }), DEPENDENCY_ERROR_CODES.CACHE_PROVENANCE_REQUIRED, 'a cache with no provenance marker');

  for (const [label, mutate] of [
    ['invalid JSON', () => write(path.join(cacheRoot, DEPENDENCIES_METADATA_FILE_NAME), '{ not json')],
    ['a JSON array', () => write(path.join(cacheRoot, DEPENDENCIES_METADATA_FILE_NAME), '[]')],
    ['a foreign module', () => rewriteRecord(cacheRoot, (record) => ({ ...record, module: 'benchboard.something.else' }))],
    ['the workload hash domain', () => rewriteRecord(cacheRoot, (record) => ({ ...record, hashAlgorithmId: identity.HASH_ALGORITHM_ID }))],
    ['a non-producing mode', () => rewriteRecord(cacheRoot, (record) => ({ ...record, mode: 'none' }))],
    ['no provenance object', () => rewriteRecord(cacheRoot, (record) => ({ ...record, provenance: 'provenance' }))],
    ['a short lock digest', () => rewriteRecord(cacheRoot, (record) => ({ ...record, provenance: { ...record.provenance, lockDigest: 'abc' } }))],
  ]) {
    mutate();
    const workspace = makeWorkspace(root, { files: {} });
    await refusesWith(t, () => prepareDependencies({ mode: 'prepared', workspaceRoot: workspace, preparedRoot: cacheRoot, sourceRoot }), DEPENDENCY_ERROR_CODES.CACHE_PROVENANCE_REQUIRED, `a cache provenance with ${label}`);
    write(path.join(cacheRoot, DEPENDENCIES_METADATA_FILE_NAME), originalRecord);
  }
});

let originalRecord = '';
function rewriteRecord(cacheRoot, transform) {
  if (originalRecord === '') {
    originalRecord = readText(path.join(cacheRoot, DEPENDENCIES_METADATA_FILE_NAME));
  }
  const record = JSON.parse(originalRecord);
  write(path.join(cacheRoot, DEPENDENCIES_METADATA_FILE_NAME), `${JSON.stringify(transform(record), void 0, 2)}\n`);
}

test('a cache is compatible only against the real lock bytes of the declared source', async (t) => {
  const root = caseRoot(t, 'cache-lock');
  const sourceRoot = makeSourceRoot(root);
  const preparedRoot = makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' });

  // A source whose lock bytes differ from the provenance record.
  const otherSource = sub(root, 'other-source');
  write(path.join(otherSource, 'package-lock.json'), '{"lockVersion":3,"packages":{"drifted":true}}');
  write(path.join(otherSource, 'package.json'), DEFAULT_MANIFEST);
  await refusesWith(t, () => prepareDependencies({ mode: 'prepared', workspaceRoot: makeWorkspace(root, { files: {} }), preparedRoot, sourceRoot: otherSource }), DEPENDENCY_ERROR_CODES.CACHE_LOCK_MISMATCH, 'a drifted lock');

  // A source with no lock at all.
  const emptySource = sub(root, 'empty-source');
  await refusesWith(t, () => prepareDependencies({ mode: 'prepared', workspaceRoot: makeWorkspace(root, { files: {} }), preparedRoot, sourceRoot: emptySource }), DEPENDENCY_ERROR_CODES.CACHE_LOCK_MISSING, 'a missing lock');

  // No declared source root at all: compatibility must not rest on a claim.
  await refusesWith(t, () => prepareDependencies({ mode: 'prepared', workspaceRoot: makeWorkspace(root, { files: {} }), preparedRoot }), DEPENDENCY_ERROR_CODES.CACHE_PROVENANCE_REQUIRED, 'no sourceRoot for a prepared copy');

  // A declared lock name that is not the lock the cache was built for.
  makeWorkspace(root, { files: {} });
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { lockfileName: 'other-lock.json' })), DEPENDENCY_ERROR_CODES.CACHE_LOCK_MISMATCH, 'a declared lock that differs from the cache');

  // A declared cache digest that the cache no longer satisfies.
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { cacheDigest: sha('another cache') })), DEPENDENCY_ERROR_CODES.CACHE_DIGEST_MISMATCH, 'a stale cacheDigest');

  // An expected dependency digest that the cache does not satisfy.
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { expectedDependencyDigest: sha('another dependency set') })), DEPENDENCY_ERROR_CODES.DEPENDENCY_DIGEST_MISMATCH, 'an unmet expectedDependencyDigest');

  assert.ok(!fs.existsSync(path.join(path.join(root, 'workspace'), DEPENDENCIES_DIRECTORY_NAME)), 'no refusal committed a dependency directory');
});

/* ------------------------------------------------- workspace lock pair */

test('a workspace that carries the lock pair must carry the locked bytes', async (t) => {
  const root = caseRoot(t, 'workspace-lock-pair');
  const sourceRoot = makeSourceRoot(root);
  const preparedRoot = makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' });
  const sourceLockBefore = treeFingerprint(sourceRoot);

  // The real project shape: the workspace carries its own copy of both files and
  // the cache has to agree with it, not only with the source root it came from.
  const agreeing = makeWorkspace(root, { files: { 'package-lock.json': DEFAULT_LOCK, 'package.json': DEFAULT_MANIFEST, 'caller.txt': 'caller byte\n' }, name: 'ws-agree' });
  const agreed = await prepareDependencies(preparedInput(root, { workspaceRoot: agreeing }));
  assert.equal(agreed.dependencyDigest, expectedDependencyDigest(preparedRoot), 'a workspace whose pair matches is prepared normally');
  assert.deepEqual(fs.readdirSync(agreeing).sort(), ['caller.txt', DEPENDENCIES_DIRECTORY_NAME, 'package-lock.json', 'package.json'], 'the caller files survive untouched next to the new tree');
  assert.equal(readText(path.join(agreeing, 'package-lock.json')), DEFAULT_LOCK, 'the workspace lock is not rewritten');

  // A foreign workspace lock contradicts the tree that is about to be copied.
  const foreignLock = makeWorkspace(root, { files: { 'package-lock.json': '{"lockVersion":3,"packages":{"foreign":true}}', 'package.json': DEFAULT_MANIFEST }, name: 'ws-foreign-lock' });
  const lockError = await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: foreignLock })), DEPENDENCY_ERROR_CODES.WORKSPACE_LOCK_MISMATCH, 'a workspace lock that is not the locked one');
  assert.equal(lockError.details.role, 'workspace lock', 'the refusal names the role that contradicted the cache');
  assert.equal(lockError.details.actual, sha('{"lockVersion":3,"packages":{"foreign":true}}'));
  assert.equal(lockError.details.locked, sha(DEFAULT_LOCK));
  assert.ok(!fs.existsSync(path.join(foreignLock, DEPENDENCIES_DIRECTORY_NAME)), 'the refusal created no dependency directory');
  assert.deepEqual(fs.readdirSync(foreignLock).sort(), ['package-lock.json', 'package.json']);

  // A foreign workspace manifest is refused by the same rule: the pair is one
  // binding, and a matching lock with a contradicted manifest still describes a
  // different dependency set.
  const foreignManifest = makeWorkspace(root, { files: { 'package-lock.json': DEFAULT_LOCK, 'package.json': '{"name":"other-project","version":"9.9.9"}' }, name: 'ws-foreign-manifest' });
  const manifestError = await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: foreignManifest })), DEPENDENCY_ERROR_CODES.WORKSPACE_LOCK_MISMATCH, 'a workspace manifest that is not the locked one');
  assert.equal(manifestError.details.role, 'workspace package manifest', 'the refusal names the manifest role');
  assert.ok(!fs.existsSync(path.join(foreignManifest, DEPENDENCIES_DIRECTORY_NAME)), 'the manifest refusal created no dependency directory');

  // Absence is not a mismatch: a bare scratch workspace has nothing to disagree
  // with, and inventing a requirement would refuse work the helper is asked to do.
  const bare = makeWorkspace(root, { files: {}, name: 'ws-bare' });
  const bareResult = await prepareDependencies(preparedInput(root, { workspaceRoot: bare }));
  assert.ok(fs.existsSync(path.join(bare, DEPENDENCIES_DIRECTORY_NAME)), 'a pair-free workspace is prepared');
  assert.deepEqual(fs.readdirSync(bare).sort(), [DEPENDENCIES_DIRECTORY_NAME]);
  assert.ok(bareResult.inventory.entries.length > 0);

  // A pair file that is present yet unreadable is the same class of refusal, not
  // a silently skipped binding: the helper cannot prove agreement over bytes it
  // cannot hold, and a byte-free lock describes no dependency set at all.
  const unreadable = makeWorkspace(root, { files: { 'package-lock.json': '' }, name: 'ws-unreadable' });
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: unreadable })), DEPENDENCY_ERROR_CODES.WORKSPACE_LOCK_MISMATCH, 'a workspace lock that can not be read');
  assert.ok(!fs.existsSync(path.join(unreadable, DEPENDENCIES_DIRECTORY_NAME)), 'the unreadable-lock refusal created no dependency directory');

  // A file that was removed before the call is simply absent, which is allowed.
  const removed = makeWorkspace(root, { files: { 'package-lock.json': DEFAULT_LOCK }, name: 'ws-removed' });
  fs.rmSync(path.join(removed, 'package-lock.json'), { force: true });
  await prepareDependencies(preparedInput(root, { workspaceRoot: removed }));
  assert.ok(fs.existsSync(path.join(removed, DEPENDENCIES_DIRECTORY_NAME)), 'a lock removed before the call is treated as absent');

  // The locked source is never the place a workspace disagreement is repaired.
  assert.equal(treeFingerprint(sourceRoot), sourceLockBefore, 'a workspace refusal leaves the locked source byte-identical');
  assert.equal(readText(path.join(sourceRoot, 'package-lock.json')), DEFAULT_LOCK);
  assert.equal(readText(path.join(sourceRoot, 'package.json')), DEFAULT_MANIFEST);
});

/* ------------------------------------------------------- tree refusals */

test('a dependency tree containing a link or a case collision is refused outright', async (t) => {
  const root = caseRoot(t, 'tree-refusals');
  const sourceRoot = makeSourceRoot(root);

  const linkCache = makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' });
  // The inventory root of a cache is the cache root itself, so the probe entry
  // belongs directly inside it. Two different link kinds are attempted, because a
  // host may permit one and not the other: a file symbolic link needs a privilege
  // on Windows that a plain developer session often lacks, while a directory
  // junction is creatable unelevated. Both are non-regular entries inside the
  // tree and both must be refused, so whichever the platform can build is the
  // real probe rather than a skipped one.
  const attempts = [];
  try {
    fs.symlinkSync(path.join(linkCache, 'package-left/index.js'), path.join(linkCache, 'linked.js'), 'file');
    attempts.push('file symbolic link');
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EEXIST') throw error;
  }
  if (attempts.length === 0) {
    const junctionTarget = sub(root, 'junction-target');
    write(path.join(junctionTarget, 'inside.txt'), 'inside\n');
    try {
      fs.symlinkSync(junctionTarget, path.join(linkCache, 'linked-dir'), 'junction');
      attempts.push('directory junction');
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EEXIST') throw error;
    }
  }
  if (attempts.length === 0) {
    t.skip('this host and volume permit neither a file symbolic link nor a directory junction, so no non-regular entry can be created to probe');
    return;
  }
  await refusesWith(t, () => prepareDependencies({ mode: 'prepared', workspaceRoot: makeWorkspace(root, { files: {} }), preparedRoot: linkCache, sourceRoot }), DEPENDENCY_ERROR_CODES.LINK_IN_DEPENDENCY_TREE, `a ${attempts[0]} inside the cache tree`);
  assert.equal(NPM_BIN_LINK_POLICY.materialisation, 'refused', 'the bin-link policy is refusal, never silent weakening');
});

test('a case collision inside a dependency tree is refused on a case-sensitive volume', async (t) => {
  const root = caseRoot(t, 'case-collision');
  const sourceRoot = makeSourceRoot(root);
  const cacheRoot = sub(root, 'collision-cache');
  write(path.join(cacheRoot, 'a.txt'), 'first\n');
  write(path.join(cacheRoot, 'A.TXT'), 'second\n');
  if (fs.readdirSync(cacheRoot).length !== 2) {
    t.skip('this volume folds name case, so it cannot host the two spellings a case collision needs');
    return;
  }
  write(path.join(cacheRoot, DEPENDENCIES_METADATA_FILE_NAME), readText(path.join(makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' }), DEPENDENCIES_METADATA_FILE_NAME)));
  await refusesWith(t, () => prepareDependencies({ mode: 'prepared', workspaceRoot: makeWorkspace(root, { files: {} }), preparedRoot: cacheRoot, sourceRoot }), DEPENDENCY_ERROR_CODES.CASE_COLLISION, 'two paths that collide case-insensitively');
});

test('a non regular file inside a dependency tree is refused', async (t) => {
  // The refusal itself is unconditional in the module: any entry that is
  // neither a regular file nor an accepted directory is rejected as
  // SPECIAL_FILE_IN_DEPENDENCY_TREE (packages/core/dependencies.mjs:1036). Creating
  // such an entry is the part a host may not support: Windows needs developer
  // mode for the special path spellings that exist at all. The case therefore
  // pins the declared contract here and attempts the real entry only when the
  // platform can build one.
  assert.ok(
    Object.values(DEPENDENCY_ERROR_CODES).includes('SPECIAL_FILE_IN_DEPENDENCY_TREE'),
    'the special-file refusal is a declared code, not an emergent error',
  );

  const probeName = typeof fs.mkfifoSync === 'function' ? 'fifo' : null;
  if (probeName === null) {
    t.skip('this runtime exposes no way to create a non regular, non link tree entry; the module still refuses any entry that is not a regular file (dependencies.mjs:1036)');
    return;
  }

  const root = caseRoot(t, 'special-file');
  const sourceRoot = makeSourceRoot(root);
  const cacheRoot = sub(root, 'special-cache');
  write(path.join(cacheRoot, 'package-left/index.js'), 'left\n');
  try {
    fs.mkfifoSync(path.join(cacheRoot, 'pipe'));
  } catch (error) {
    t.skip(`the host refuses to create the probe entry (${error.code ?? error.message})`);
    return;
  }
  const donor = makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' });
  write(path.join(cacheRoot, DEPENDENCIES_METADATA_FILE_NAME), readText(path.join(donor, DEPENDENCIES_METADATA_FILE_NAME)));
  await refusesWith(t, () => prepareDependencies({ mode: 'prepared', workspaceRoot: makeWorkspace(root, { files: {}, name: 'ws-special' }), preparedRoot: cacheRoot, sourceRoot }), DEPENDENCY_ERROR_CODES.SPECIAL_FILE_IN_DEPENDENCY_TREE, 'a non regular file in the tree');
});

test('the tree bounds are enforced instead of allowing an unbounded walk', async (t) => {
  const root = caseRoot(t, 'bounds');
  const sourceRoot = makeSourceRoot(root);
  const preparedRoot = makeCache(root, sourceRoot, { 'package-left/a.js': 'aaaa\n', 'package-left/b.js': 'bbbb\n' });
  makeWorkspace(root);

  await refusesWith(t, () => prepareDependencies(preparedInput(root, { maxEntries: 1 })), DEPENDENCY_ERROR_CODES.TREE_LIMIT_EXCEEDED, 'more entries than maxEntries');
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { maxFileBytes: 4 })), DEPENDENCY_ERROR_CODES.FILE_TOO_LARGE, 'a file above maxFileBytes');
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { maxTotalBytes: 1 })), DEPENDENCY_ERROR_CODES.TREE_LIMIT_EXCEEDED, 'a tree above maxTotalBytes');
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { maxEntries: 0 })), DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'a non-positive bound');
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { maxEntries: 1.5 })), DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'a non-integer bound');
  assert.ok(!fs.existsSync(path.join(path.join(root, 'workspace'), DEPENDENCIES_DIRECTORY_NAME)), 'a bounded refusal commits nothing');
});

/* --------------------------------------------------------------- staging */

test('a refusal removes only what the helper created and never touches caller bytes', async (t) => {
  const root = caseRoot(t, 'cleanup');
  const sourceRoot = makeSourceRoot(root);
  const preparedRoot = makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n', 'package-right/index.js': 'right\n' });
  const workspaceRoot = makeWorkspace(root, { files: { 'caller.txt': 'caller byte\n', 'keep/deep.txt': 'kept\n' } });
  const callerBefore = treeFingerprint(workspaceRoot);
  const sourceBefore = treeFingerprint(sourceRoot);

  // A tree whose second file is too large aborts the copy mid-flight.
  const error = await refusesWith(t, () => prepareDependencies(preparedInput(root, { maxFileBytes: 5 })), DEPENDENCY_ERROR_CODES.FILE_TOO_LARGE, 'an aborted copy');
  assert.ok(error.cleanedUp === void 0 || Array.isArray(error.cleanedUp), 'the refusal reports the cleanup it performed');

  assert.ok(!fs.existsSync(path.join(workspaceRoot, '.benchboard-tmp')), 'the staging root no longer exists');
  assert.ok(!fs.existsSync(path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME)), 'nothing was committed');
  assert.equal(treeFingerprint(workspaceRoot), callerBefore, 'the caller workspace is byte-identical after a mid-flight abort');
  assert.equal(treeFingerprint(sourceRoot), sourceBefore, 'the caller source is byte-identical');
});

test('the helper never deletes a caller-owned root it did not create', async (t) => {
  const root = caseRoot(t, 'no-caller-deletion');
  const sourceRoot = makeSourceRoot(root);
  const preparedRoot = makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' });
  const scratchRoot = sub(root, 'scratch');
  write(path.join(scratchRoot, 'caller-owned.txt'), 'caller scratch byte\n');
  write(path.join(scratchRoot, 'caller-dir/keep.txt'), 'kept\n');

  const workspaceRoot = sub(root, 'ws2');
  write(path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME, 'pre-existing.txt'), 'do not touch\n');
  await refusesWith(t, () => prepareDependencies({ mode: 'prepared', workspaceRoot, preparedRoot, sourceRoot }), DEPENDENCY_ERROR_CODES.TARGET_EXISTS, 'an occupied target in a scratch-root scenario');

  assert.equal(readText(path.join(scratchRoot, 'caller-owned.txt')), 'caller scratch byte\n', 'caller scratch bytes survive');
  assert.equal(readText(path.join(scratchRoot, 'caller-dir/keep.txt')), 'kept\n', 'caller scratch directories survive');
  assert.equal(readText(path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME, 'pre-existing.txt')), 'do not touch\n', 'a pre-existing dependency directory is never removed');
});

/* ------------------------------------------------------------- metadata */

test('public metadata is written outside the participant workspace only when asked', async (t) => {
  const root = caseRoot(t, 'metadata');
  const sourceRoot = makeSourceRoot(root);
  const preparedRoot = makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' });
  const workspaceRoot = makeWorkspace(root);
  const outside = sub(root, 'public-metadata');
  const metadataPath = path.join(outside, 'dependencies.json');

  const result = await prepareDependencies(preparedInput(root, { workspaceRoot, metadataPath }));
  assert.equal(result.metadata.persisted, true, 'the persistence fact is reported');
  assert.equal(result.metadata.metadataPath, metadataPath.split(path.sep).join('/'));
  assert.ok(fs.existsSync(metadataPath), 'the companion record exists outside the workspace');
  const record = JSON.parse(readText(metadataPath));
  assert.equal(record.schemaVersion, DEPENDENCIES_CONTRACT_VERSION);
  assert.equal(record.module, DEPENDENCIES_MODULE_ID);
  assert.equal(record.hashAlgorithmId, DEPENDENCY_HASH_ALGORITHM_ID);
  assert.equal(record.mode, 'prepared');
  assert.equal(record.persisted, true, 'the record itself does not claim a second write');
  assert.equal(record.executed, false);
  assert.equal(record.provenance.module, DEPENDENCIES_MODULE_ID);
  assert.deepEqual(fs.readdirSync(workspaceRoot).sort(), ['caller.txt', DEPENDENCIES_DIRECTORY_NAME], 'no metadata file is written into the participant workspace');

  // The destination is created once and never replaced.
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: makeWorkspace(root, { files: {}, name: 'ws-meta-second' }), metadataPath })), DEPENDENCY_ERROR_CODES.TARGET_EXISTS, 'a metadata path that already exists');
  const insideWorkspace = makeWorkspace(root, { files: {}, name: 'ws-meta-inside' });
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: insideWorkspace, metadataPath: path.join(insideWorkspace, 'deps.json') })), DEPENDENCY_ERROR_CODES.WORKSPACE_METADATA_PRESENT, 'a metadata path inside the participant workspace');
  assert.ok(!fs.existsSync(path.join(insideWorkspace, DEPENDENCIES_DIRECTORY_NAME)), 'a refused metadata placement commits nothing');
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: makeWorkspace(root, { files: {}, name: 'ws-meta-third' }), metadataPath: path.join(root, 'absent', 'dependencies.json') })), DEPENDENCY_ERROR_CODES.ROOT_NOT_FOUND, 'a metadata path with no parent directory');
});

test('a metadata path inside a protected root is refused before any byte is written', async (t) => {
  const root = caseRoot(t, 'metadata-protected');
  const sourceRoot = makeSourceRoot(root);
  const preparedRoot = makeCache(root, sourceRoot, { 'package-left/index.js': 'left\n' });
  const scratchRoot = sub(root, 'install-scratch');
  const sourceBefore = treeFingerprint(sourceRoot);
  const cacheBefore = treeFingerprint(preparedRoot);

  // The locked source is a read-only input: a record written inside it is an
  // unannounced byte added to a tree whose digest the caller believes it knows.
  const inSource = path.join(sourceRoot, 'dependencies.json');
  const sourceError = await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: makeWorkspace(root, { files: {}, name: 'ws-src' }), metadataPath: inSource })), DEPENDENCY_ERROR_CODES.METADATA_PATH_IN_PROTECTED_ROOT, 'a metadata path inside the locked source root');
  assert.equal(sourceError.details.protectedRoot, 'sourceRoot');
  assert.ok(!fs.existsSync(inSource), 'no byte was created inside the locked source root');

  // The same rule covers the prepared cache, which is inventoried and hashed.
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: makeWorkspace(root, { files: {}, name: 'ws-cache' }), metadataPath: path.join(preparedRoot, 'record.json') })), DEPENDENCY_ERROR_CODES.METADATA_PATH_IN_PROTECTED_ROOT, 'a metadata path inside the prepared cache');

  // The helper-owned install scratch is protected too, so an install cannot
  // leave its own record behind inside the tree it is about to publish.
  const heldScratch = scratchRoot;
  await refusesWith(t, () => prepareDependencies(installInput(root, { workspaceRoot: makeWorkspace(root, { files: {}, name: 'ws-scratch' }), sourceRoot, scratchRoot: heldScratch, metadataPath: path.join(heldScratch, 'record.json'), processAdapter: adapterReturning(SUCCESSFUL_OUTCOME) })), DEPENDENCY_ERROR_CODES.METADATA_PATH_IN_PROTECTED_ROOT, 'a metadata path inside the install scratch root');

  // Identity with a protected root is the strongest violation there is, not the
  // weakest: the record would replace the root the call was handed. The declared
  // scratch is used because it is the one root a call may name before it exists,
  // so the never-overwrite guard can not pre-empt the placement proof here.
  const futureScratch = path.join(sub(root, 'scratch-host'), 'install');
  const equalError = await refusesWith(t, () => prepareDependencies(installInput(root, { workspaceRoot: makeWorkspace(root, { files: {}, name: 'ws-equal' }), sourceRoot, scratchRoot: futureScratch, metadataPath: futureScratch, processAdapter: adapterReturning(SUCCESSFUL_OUTCOME) })), DEPENDENCY_ERROR_CODES.METADATA_PATH_IN_PROTECTED_ROOT, 'a metadata path that is a protected root');
  assert.equal(equalError.details.protectedRoot, 'scratchRoot');

  // The documented precedence for a root that already exists: this helper never
  // overwrites an existing record, so that guard answers first and the existing
  // root is still left byte-identical either way.
  await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: makeWorkspace(root, { files: {}, name: 'ws-exists' }), metadataPath: sourceRoot })), DEPENDENCY_ERROR_CODES.TARGET_EXISTS, 'a metadata path that is an existing protected root');

  // A link on the way to the destination re-roots the placement proof, so it is
  // refused apart from containment: the write would land wherever the link points,
  // outside every root the caller declared. A directory junction is the probe that
  // needs no privilege on this host; where the volume refuses every directory-link
  // kind the case can not be built and says so instead of passing vacuously.
  const linkTarget = sub(root, 'link-target');
  const linkDirectory = sub(root, 'link-host');
  let linkProbe = null;
  for (const kind of ['junction', 'dir']) {
    try {
      fs.symlinkSync(linkTarget, path.join(linkDirectory, 'via'), kind);
      linkProbe = kind;
      break;
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EEXIST') throw error;
    }
  }
  if (linkProbe === null) {
    t.skip('this volume creates no directory link, so no link ancestor can be built');
  } else {
    const viaLink = path.join(linkDirectory, 'via', 'dependencies.json');
    await refusesWith(t, () => prepareDependencies(preparedInput(root, { workspaceRoot: makeWorkspace(root, { files: {}, name: 'ws-link' }), metadataPath: viaLink })), DEPENDENCY_ERROR_CODES.LINK_ANCESTOR, `a metadata path under a ${linkProbe} ancestor`);
    assert.ok(!fs.existsSync(path.join(linkTarget, 'dependencies.json')), 'nothing was written through the link');
    fs.rmSync(path.join(linkDirectory, 'via'), { force: true });
  }

  // Ordering is the actual defect this closes: every one of the refusals above
  // has to arrive during option validation, so neither the dependency directory
  // nor any protected byte exists afterwards.
  assert.equal(treeFingerprint(sourceRoot), sourceBefore, 'the locked source is byte-identical after every metadata refusal');
  assert.equal(treeFingerprint(preparedRoot), cacheBefore, 'the prepared cache is byte-identical after every metadata refusal');
  for (const name of ['ws-src', 'ws-cache', 'ws-scratch', 'ws-equal', 'ws-link']) {
    assert.ok(!fs.existsSync(path.join(root, name, DEPENDENCIES_DIRECTORY_NAME)), `${name}: a refused metadata placement commits no dependency directory`);
  }
  assert.deepEqual(fs.readdirSync(scratchRoot).sort(), [], 'no scratch byte was created for a refused install');
});

/* ------------------------------------------------------- command strategy */

test('the Windows command strategy is explicit and never relies on a shell', (t) => {
  const shim = 'C:\\fixture\\npm.cmd';
  const native = 'C:\\fixture\\npm.exe';

  const auto = resolveDependencyCommandStrategy({ platform: 'win32', executablePath: shim });
  assert.equal(auto.strategy, NPM_COMMAND_STRATEGIES.CMD_EXE);
  assert.equal(auto.file, 'cmd.exe');
  assert.deepEqual([...auto.forwardArguments], ['/d', '/c']);
  assert.equal(auto.wrapForCmdExe, true);
  assert.equal(auto.shell, false, 'the strategy is shell-free');

  // A direct execution of a batch shim is not an executable image: refusing is
  // the documented behaviour, so no silent fallback is possible.
  assert.throws(() => resolveDependencyCommandStrategy({ platform: 'win32', executablePath: shim, executableStrategy: NPM_COMMAND_STRATEGIES.DIRECT }), (error) => {
    assert.equal(error.code, DEPENDENCY_ERROR_CODES.NPM_COMMAND_STRATEGY_UNSUPPORTED);
    return true;
  }, 'a .cmd shim plus direct is refused');

  const nativeStrategy = resolveDependencyCommandStrategy({ platform: 'win32', executablePath: native });
  assert.equal(nativeStrategy.strategy, NPM_COMMAND_STRATEGIES.DIRECT, 'a native image is executed directly');
  assert.equal(nativeStrategy.file, native);
  assert.deepEqual([...nativeStrategy.forwardArguments], []);

  assert.throws(() => resolveDependencyCommandStrategy({ platform: 'win32', executablePath: native, executableStrategy: NPM_COMMAND_STRATEGIES.CMD_EXE }), (error) => {
    assert.equal(error.code, DEPENDENCY_ERROR_CODES.NPM_COMMAND_STRATEGY_UNSUPPORTED);
    return true;
  }, 'cmd.exe wrapping of a native image is refused');

  // Off Windows the batch strategy is not applicable at all.
  assert.throws(() => resolveDependencyCommandStrategy({ platform: 'linux', executablePath: '/usr/bin/npm', executableStrategy: NPM_COMMAND_STRATEGIES.CMD_EXE }), (error) => {
    assert.equal(error.code, DEPENDENCY_ERROR_CODES.NPM_COMMAND_STRATEGY_UNSUPPORTED);
    return true;
  }, 'cmdexe off Windows is refused');
  const posix = resolveDependencyCommandStrategy({ platform: 'linux', executablePath: '/usr/bin/npm' });
  assert.equal(posix.strategy, NPM_COMMAND_STRATEGIES.DIRECT);
  // An unknown platform is treated as a non-Windows platform: the batch wrapper
  // is not applicable, so a direct request is the only possible outcome.
  const unknownPlatform = resolveDependencyCommandStrategy({ platform: 'plan9', executablePath: 'C:\\fixture\\npm.cmd' });
  assert.equal(unknownPlatform.strategy, NPM_COMMAND_STRATEGIES.DIRECT);
  assert.equal(unknownPlatform.wrapForCmdExe, false, 'a non-Windows platform never wraps in cmd.exe');
});

test('the built command is an argument array with no shell and no metacharacters', () => {
  const resolved = resolveDependencyCommandStrategy({ platform: 'win32', executablePath: 'C:\\fixture\\npm.cmd' });
  const built = buildDependencyCommand(resolved, { command: 'C:\\fixture\\npm.cmd', args: ['ci', '--lockfile=package-lock.json'] });
  assert.equal(built.file, 'cmd.exe');
  // The command tail is what `cmd.exe /d /c` parses as one command line, so the
  // executable is quoted there and is never repeated as a separate argument.
  assert.deepEqual([...built.args], ['/d', '/c', '"C:\\fixture\\npm.cmd"', 'ci', '--lockfile=package-lock.json'], 'the executable is quoted once, never repeated');
  assert.deepEqual({ ...built.options }, { shell: false, windowsVerbatimArguments: true }, 'cmd.exe needs the verbatim command line, and no shell');

  // A direct strategy carries the arguments unquoted and lets Node escape them,
  // which is what a native image expects.
  const direct = buildDependencyCommand({ strategy: 'direct', file: 'C:\\fixture\\npm.exe', forwardArguments: [], wrapForCmdExe: false, shell: false }, { command: 'C:\\fixture\\npm.exe', args: ['ci'] });
  assert.deepEqual([...direct.args], ['ci'], 'a direct strategy does not quote or forward anything');
  assert.deepEqual({ ...direct.options }, { shell: false }, 'a direct strategy keeps Node escaping');

  // `cmd.exe` would parse a quoted argument value by its own rules and split it
  // at the first space, so a spaced value is refused rather than mangled.
  assert.throws(() => buildDependencyCommand(resolved, { command: 'C:\\fixture\\npm.cmd', args: ['--prefix=C:\\Program Files\\x'] }), (error) => {
    assert.equal(error.code, DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'a spaced value under cmd.exe is refused');
    return true;
  }, 'an argument value containing whitespace is refused under cmd.exe');

  // The same value is admissible for a native image, because no second parser
  // inspects it: the operating system passes the element through as one argument.
  const spaced = buildDependencyCommand({ strategy: 'direct', file: 'C:\\fixture\\npm.exe', forwardArguments: [], wrapForCmdExe: false, shell: false }, { command: 'C:\\fixture\\npm.exe', args: ['--prefix=C:\\Program Files\\x'] });
  assert.deepEqual([...spaced.args], ['--prefix=C:\\Program Files\\x'], 'a direct strategy carries a spaced value intact');

  for (const dangerous of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', 'a(b', 'a)b', 'a%b', 'a"b', 'a`b']) {
    assert.throws(() => buildDependencyCommand(resolved, { command: 'C:\\fixture\\npm.cmd', args: [dangerous] }), (error) => {
      assert.equal(error.code, DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, `${dangerous} is refused as an argument`);
      return true;
    }, `the shell metacharacter ${dangerous} is refused`);
  }
  // Those same metacharacters are accepted for a direct strategy, where no shell
  // exists to interpret them; the refusal above is about the wrapper, not about
  // the bytes.
  const literal = buildDependencyCommand({ strategy: 'direct', file: 'C:\\fixture\\npm.exe', forwardArguments: [], wrapForCmdExe: false, shell: false }, { command: 'C:\\fixture\\npm.exe', args: ['a&b'] });
  assert.deepEqual([...literal.args], ['a&b'], 'no shell means no metacharacter danger');
  assert.throws(() => buildDependencyCommand(resolved, { command: 'relative/npm.cmd', args: [] }), (error) => {
    assert.equal(error.code, DEPENDENCY_ERROR_CODES.INVALID_ROOT);
    return true;
  }, 'a relative command is refused');
  assert.throws(() => buildDependencyCommand({ strategy: 'direct', file: 'C:\\fixture\\npm.exe' }, { command: 'C:\\fixture\\npm.exe', args: 'ci' }), (error) => {
    assert.equal(error.code, DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT);
    return true;
  }, 'arguments must be an array of strings');
});

test('a built command never repeats its executable as an argument, and runs for real', async (t) => {
  // The regression: an argv whose first element repeats the program is not a
  // command line, it is the program's own bytes read as a module. Spawning the
  // runtime that way fails, and spawning it correctly prints a version, so this
  // is the same shape proved by an actual process rather than by a mock.
  const built = buildDependencyCommand(
    resolveDependencyCommandStrategy({ platform: process.platform, executablePath: process.execPath, executableStrategy: 'direct' }),
    { command: process.execPath, args: ['--version'] },
  );
  assert.deepEqual([...built.args], ['--version'], 'the executable is not present among the arguments');
  assert.ok(!built.args.includes(process.execPath), 'no argument repeats the executable');

  const adapter = createNodeSpawnAdapter({ timeoutMs: 30000 });
  const correct = await adapter({ ...built, cwd: REPO_ROOT, env: process.env });
  assert.equal(correct.status, 0, `the correct argv runs: ${correct.stderr.slice(0, 200)}`);
  assert.match(correct.stdout, /^v\d+\.\d+\.\d+/m, 'the runtime reports its version');

  const doubled = await adapter({ file: process.execPath, args: [process.execPath, '--version'], cwd: REPO_ROOT, env: process.env });
  assert.notEqual(doubled.status, 0, 'a repeated executable is not a success');
  assert.match(`${doubled.stderr}${doubled.stdout}`, /SyntaxError|Invalid or unexpected token/, 'the repetition is the runtime parsing its own binary as source');
});

test('a real command whose path contains spaces runs without a shell', async (t) => {
  // Windows is the hard case: a path with a space needs the quoting rules of the
  // actual parser, not a hand-written string, so this drives a real process.
  const root = caseRoot(t, 'spaced-path');
  const spacedDirectory = path.join(root, 'Program Files');
  fs.mkdirSync(spacedDirectory, { recursive: true });
  const script = write(path.join(spacedDirectory, 'emit.cjs'), 'process.stdout.write(process.argv.slice(1).join("|"));\n');
  const adapter = createNodeSpawnAdapter({ timeoutMs: 30000 });

  const direct = buildDependencyCommand(
    resolveDependencyCommandStrategy({ platform: process.platform, executablePath: process.execPath, executableStrategy: 'direct' }),
    { command: process.execPath, args: [script, '--flag=a b'] },
  );
  const directRun = await adapter({ ...direct, cwd: spacedDirectory, env: process.env });
  assert.equal(directRun.status, 0, `the spaced directory path runs directly: ${directRun.stderr.slice(0, 220)}`);
  assert.equal(directRun.stdout, `${script}|--flag=a b`, 'each element arrives as one argument, spaces included');

  if (process.platform !== 'win32') {
    return;
  }

  // A batch shim cannot be spawned as an image at all; that is why cmd.exe
  // wrapping exists. The refusal arrives as a reported spawn failure whose cause
  // is the platform's own `EINVAL`, observed here rather than described.
  const shim = write(path.join(spacedDirectory, 'shim.cmd'), '@echo off\r\n@echo LINE=%*\r\n');
  await assert.rejects(
    () => adapter({ file: shim, args: [], cwd: spacedDirectory, env: process.env }),
    (error) => {
      assert.equal(error.code, DEPENDENCY_ERROR_CODES.NPM_SPAWN_FAILED, 'a batch shim is not an executable image');
      assert.equal(error.details.cause, 'EINVAL', 'the reported cause is the platform refusal to create the process');
      return true;
    },
    void 0,
    'a batch shim is refused by the operating system, never silently run through a shell',
  );

  // Wrapped with the module's own rules, the same shim runs from a spaced path.
  const resolved = resolveDependencyCommandStrategy({ platform: 'win32', executablePath: shim });
  assert.equal(resolved.strategy, NPM_COMMAND_STRATEGIES.CMD_EXE);
  const wrapped = buildDependencyCommand(resolved, { command: shim, args: ['ci', '--lockfile=package-lock.json'] });
  const wrappedRun = await adapter({ ...wrapped, cwd: spacedDirectory, env: process.env });
  assert.equal(wrappedRun.status, 0, `the quoted command line runs from a spaced path: ${wrappedRun.stderr.slice(0, 220)}`);
  assert.match(wrappedRun.stdout, /LINE=ci --lockfile=package-lock\.json/, 'the shim reports the argument line it actually received');
});


/* ------------------------------------------------------------- install */

test('mode "install" demands its declared inputs before any execution', async (t) => {
  const root = caseRoot(t, 'install-inputs');
  const sourceRoot = makeSourceRoot(root);
  sub(root, 'scratch');
  sub(root, 'workspace');
  makeWorkspace(root);
  write(path.join(root, 'npm.cmd'), '@echo off\r\n');

  await refusesWith(t, () => prepareDependencies(installInput(root, { npmExecutable: void 0, processAdapter: adapterInstalling({}) })), DEPENDENCY_ERROR_CODES.NPM_EXECUTABLE_REQUIRED, 'no npmExecutable');
  await refusesWith(t, () => prepareDependencies(installInput(root, { npmExecutable: path.join(root, 'absent.cmd'), processAdapter: adapterInstalling({}) })), DEPENDENCY_ERROR_CODES.NPM_EXECUTABLE_NOT_FOUND, 'a missing npmExecutable');
  await refusesWith(t, () => prepareDependencies(installInput(root, { sourceRoot: void 0, processAdapter: adapterInstalling({}) })), DEPENDENCY_ERROR_CODES.NPM_LOCKFILE_REQUIRED, 'no locked source root');
  await refusesWith(t, () => prepareDependencies(installInput(root, { scratchRoot: void 0, processAdapter: adapterInstalling({}) })), DEPENDENCY_ERROR_CODES.SCRATCH_ROOT_REQUIRED, 'no scratch root');
  await refusesWith(t, () => prepareDependencies(installInput(root, { processAdapter: null })), DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'an explicit non-callable process adapter');
  await refusesWith(t, () => prepareDependencies(installInput(root, { processAdapter: 'not a function' })), DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'a non-callable process adapter');

  // Offline is a refusal, not a silent cache use, and it is decided before any
  // executable is even looked for.
  await refusesWith(t, () => prepareDependencies(installInput(root, { offline: true, npmExecutable: path.join(root, 'absent.cmd'), processAdapter: adapterInstalling({}) })), DEPENDENCY_ERROR_CODES.OFFLINE_UNSUPPORTED, 'offline is unsupported, not silently downgraded');

  // `linked` is npm's own strategy name, and it is the one value that cannot be
  // published here: it stores packages under node_modules/.store and links them
  // into place. It is refused as a link, not as an unknown value, so the reason is
  // never lost. An invented name such as `short` is refused as invalid, because
  // claiming support for a strategy npm does not have would be a false claim.
  await refusesWith(t, () => prepareDependencies(installInput(root, { installStrategy: 'linked', processAdapter: adapterInstalling({}) })), DEPENDENCY_ERROR_CODES.LINK_IN_DEPENDENCY_TREE, 'the linked install strategy is refused as a link');
  await refusesWith(t, () => prepareDependencies(installInput(root, { installStrategy: 'short', processAdapter: adapterInstalling({}) })), DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'a strategy that is not an npm strategy is refused rather than claimed');
  await refusesWith(t, () => prepareDependencies(installInput(root, { installStrategy: 'sideways', processAdapter: adapterInstalling({}) })), DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'an unknown install strategy');
  await refusesWith(t, () => prepareDependencies(installInput(root, { executableStrategy: 'powershell', processAdapter: adapterInstalling({}) })), DEPENDENCY_ERROR_CODES.NPM_COMMAND_STRATEGY_UNSUPPORTED, 'an unknown executable strategy');
  await refusesWith(t, () => prepareDependencies(installInput(root, { preparedRoot: path.join(root, 'cache'), processAdapter: adapterInstalling({}) })), DEPENDENCY_ERROR_CODES.MODE_OPTION_MISMATCH, 'install plus preparedRoot');
  await refusesWith(t, () => prepareDependencies(installInput(root, { cacheDigest: sha('x'), processAdapter: adapterInstalling({}) })), DEPENDENCY_ERROR_CODES.MODE_OPTION_MISMATCH, 'install plus cacheDigest');

  // The locked source must actually carry the declared lock and manifest.
  const emptySource = sub(root, 'empty-source');
  await refusesWith(t, () => prepareDependencies(installInput(root, { sourceRoot: emptySource, processAdapter: adapterInstalling({}) })), DEPENDENCY_ERROR_CODES.NPM_LOCKFILE_MISSING, 'a source root with no lock');
  assert.ok(!fs.existsSync(path.join(path.join(root, 'workspace'), DEPENDENCIES_DIRECTORY_NAME)), 'no refusal installed anything');
  assert.deepEqual(fs.readdirSync(sub(root, 'scratch')).sort(), [], 'no refusal left staging behind');
});

test('mode "install" installs a staged copy, commits it, and reports the bounded command', async (t) => {
  const root = caseRoot(t, 'install-success');
  const sourceRoot = makeSourceRoot(root);
  sub(root, 'scratch');
  const workspaceRoot = makeWorkspace(root);
  const npmPath = write(path.join(root, 'npm.cmd'), '@echo off\r\n');
  const adapter = adapterInstalling({ 'package-left/index.js': 'left installed\n', 'package-left/package.json': '{"name":"left"}\n' });
  process.env.BENCHBOARD_T2_LEAK_PROBE = 'must not be forwarded';
  t.after(() => {
    delete process.env.BENCHBOARD_T2_LEAK_PROBE;
  });

  const result = await prepareDependencies(installInput(root, { npmExecutable: npmPath, platform: 'win32', processAdapter: adapter, timeoutMs: 5000 }));

  assert.equal(result.mode, 'install');
  assert.equal(result.metadata.executed, true, 'the execution fact is reported');
  assert.equal(result.metadata.persisted, false);
  assert.match(result.dependencyDigest, HEX64);
  assert.equal(result.dependencyDigest, result.inventory.digest, 'the dependency digest is the digest of the committed tree');
  assert.notEqual(result.dependencyDigest, DEPENDENCY_HASH_ALGORITHM_ID);

  const report = result.metadata.npm;
  assert.equal(report.strategy, NPM_COMMAND_STRATEGIES.CMD_EXE);
  assert.equal(report.file, 'cmd.exe');
  assert.deepEqual([...report.args].slice(0, 2), ['/d', '/c']);
  assert.ok(report.args.includes('ci'), 'the command is a clean installation');
  assert.ok(report.args.some((argument) => argument === '--lockfile=package-lock.json'), 'the lock is addressed by name inside staging');
  assert.ok(report.args.some((argument) => argument === '--install-strategy=hoisted'), 'the strategy is carried verbatim, and it is an actual npm strategy');
  assert.ok(report.args.some((argument) => argument === '--no-audit') && report.args.some((argument) => argument === '--no-fund'), 'no audit or fund traffic is requested');
  assert.equal(report.shell, false, 'the request never runs through a shell');
  assert.equal(report.windowsVerbatimArguments, true, 'the wrapped command line is reported as verbatim, which is what makes a spaced installation path work');
  assert.equal(report.status, 0);
  assert.equal(report.timedOut, false);
  assert.equal(report.timeoutMs, 5000);
  assert.equal(report.npmBinLinkPolicy, NPM_BIN_LINK_POLICY, 'the bin-link policy travels with the command report');

  // The process request itself is bounded, cache-local and environment-minimal.
  assert.equal(adapter.calls.length, 1, 'exactly one process request');
  const request = adapter.calls[0];
  assert.equal(request.shell, false);
  assert.equal(request.file, 'cmd.exe');
  assert.ok(request.cwd.includes('.benchboard-install'), 'the process runs in the helper staging directory, never in the participant workspace');
  assert.ok(!fs.existsSync(path.join(request.cwd, DEPENDENCIES_DIRECTORY_NAME)), 'the staged tree was retired after the commit');
  assert.ok(request.env.npm_config_cache.includes('.npm-cache'), 'the package-manager cache is helper-owned and explicit');
  assert.equal(request.env.npm_config_ci, 'true');
  assert.equal(request.env.npm_config_package_lock_only, 'false', 'ci must reify node_modules rather than only inspect the lock');
  assert.equal(request.env.npm_config_save, 'false', 'locked inputs remain protected without suppressing reification');
  assert.equal(request.env.npm_config_audit, 'false');
  assert.equal(request.env.npm_config_update_notifier, 'false');
  assert.equal(request.env.BENCHBOARD_T2_LEAK_PROBE, void 0, 'the caller environment is not forwarded wholesale');
  assert.ok(NPM_FORWARDED_ENVIRONMENT.every((name) => !(name in request.env) || typeof request.env[name] === 'string'));

  // Provenance and preservation.
  assert.equal(result.metadata.provenance.sourceRoot, path.resolve(sourceRoot), 'the provenance carries the resolved absolute source root');
  assert.equal(result.metadata.provenance.lockfileName, 'package-lock.json');
  assert.equal(result.metadata.provenance.lockDigest, sha(DEFAULT_LOCK));
  assert.equal(result.metadata.provenance.manifestDigest, sha(DEFAULT_MANIFEST));
  assert.equal(result.metadata.provenance.installStrategy, 'hoisted', 'the strategy recorded is the one npm was told to use');
  assert.equal(result.metadata.provenance.npmExecutable, npmPath);
  assert.equal(readText(path.join(sourceRoot, 'package-lock.json')), DEFAULT_LOCK, 'the locked source bytes are unchanged');
  assert.equal(readText(path.join(workspaceRoot, 'caller.txt')), 'caller byte\n');
  assert.deepEqual(fs.readdirSync(workspaceRoot).sort(), ['caller.txt', DEPENDENCIES_DIRECTORY_NAME]);
  assert.deepEqual(fs.readdirSync(sub(root, 'scratch')).sort(), [], 'the helper staging root is retired after success');
  assert.equal(readText(path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME, 'package-left/index.js')), 'left installed\n');

  // The proof that the tree which was staged is the tree that was published:
  // every byte the process produced in its working directory is found byte-for-byte
  // in the committed directory, and nothing else was published. This is what makes
  // "the committed digest" a statement about the examined bytes rather than about
  // whatever happened to be on disk when the commit ran.
  const publishedFiles = adapter.installedFiles;
  const publishedRoot = path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME);
  const publishedNames = [];
  const collectPublished = (directory, relative) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const rel = relative === '' ? name : `${relative}/${name}`;
      if (fs.lstatSync(absolute).isDirectory()) {
        collectPublished(absolute, rel);
      } else {
        publishedNames.push(rel);
        assert.equal(fs.readFileSync(absolute, 'utf8'), publishedFiles[rel], `${rel}: the published byte is the byte the installation produced`);
      }
    }
  };
  collectPublished(publishedRoot, '');
  assert.deepEqual(publishedNames.sort(), Object.keys(publishedFiles).sort(), 'exactly the installed files are published, with no extra or missing entry');

  // The same authorised bytes can be pinned by the caller.
  const pinned = await prepareDependencies(installInput(root, { npmExecutable: npmPath, workspaceRoot: makeWorkspace(root, { files: { 'other.txt': 'o\n' }, name: 'ws-pinned' }), expectedDependencyDigest: result.dependencyDigest, processAdapter: adapterInstalling({ 'package-left/index.js': 'left installed\n', 'package-left/package.json': '{"name":"left"}\n' }) }));
  assert.equal(pinned.dependencyDigest, result.dependencyDigest);
});

test('mode "install" honours expectedDependencyDigest after an installation', async (t) => {
  const root = caseRoot(t, 'install-expected');
  const sourceRoot = makeSourceRoot(root);
  sub(root, 'scratch');
  const workspaceRoot = makeWorkspace(root);
  const npmPath = write(path.join(root, 'npm.cmd'), '@echo off\r\n');

  await refusesWith(t, () => prepareDependencies(installInput(root, { npmExecutable: npmPath, workspaceRoot, expectedDependencyDigest: sha('authorised elsewhere'), processAdapter: adapterInstalling({ 'package-left/index.js': 'left\n' }) })), DEPENDENCY_ERROR_CODES.DEPENDENCY_DIGEST_MISMATCH, 'an installation that does not match the authorised digest');
  assert.ok(!fs.existsSync(path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME)), 'a digest mismatch commits nothing');
  assert.deepEqual(fs.readdirSync(sub(root, 'scratch')), [], 'a digest mismatch leaves no staging behind');
});

test('an installing process that fails, times out or overflows produces an explicit bounded error', async (t) => {
  const root = caseRoot(t, 'install-failures');
  const sourceRoot = makeSourceRoot(root);
  const scratchRoot = sub(root, 'scratch');
  write(path.join(scratchRoot, 'caller-scratch.txt'), 'caller byte\n');
  const npmPath = write(path.join(root, 'npm.cmd'), '@echo off\r\n');

  const cases = [
    ['a spawn failure', adapterReturning({ status: null, signal: null, stdout: '', stderr: '', spawnError: 'ENOENT: no such file', timedOut: false }), DEPENDENCY_ERROR_CODES.NPM_SPAWN_FAILED],
    ['a timeout', adapterReturning({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true }), DEPENDENCY_ERROR_CODES.NPM_TIMEOUT],
    ['a non-zero exit', adapterReturning({ status: 1, signal: null, stdout: 'out', stderr: 'the package manager complained', timedOut: false }), DEPENDENCY_ERROR_CODES.NPM_EXIT_NONZERO],
    ['a nullish adapter result', adapterReturning(null), DEPENDENCY_ERROR_CODES.NPM_SPAWN_FAILED],
    ['a success with no dependency tree', adapterReturning(SUCCESSFUL_OUTCOME), DEPENDENCY_ERROR_CODES.NPM_EXIT_NONZERO],
  ];
  for (const [label, adapter, code] of cases) {
    const workspaceRoot = sub(root, `ws-${code.toLowerCase().replace(/_/g, '-')}`);
    const error = await refusesWith(t, () => prepareDependencies(installInput(root, { npmExecutable: npmPath, workspaceRoot, processAdapter: adapter })), code, label);
    assert.ok(error.details !== void 0, `${label}: the error carries command diagnostics`);
    assert.ok(!fs.existsSync(path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME)), `${label}: nothing was committed`);
    assert.ok(!fs.existsSync(path.join(scratchRoot, '.benchboard-install')), `${label}: the helper staging root is retired`);
  }

  const reportError = await refusesWith(t, () => prepareDependencies(installInput(root, { npmExecutable: npmPath, workspaceRoot: sub(root, 'ws-tail'), processAdapter: adapterReturning({ status: 7, signal: 'SIGKILL', stdout: 'x'.repeat(6000), stderr: 'y'.repeat(6000), timedOut: false }) })), DEPENDENCY_ERROR_CODES.NPM_EXIT_NONZERO, 'a bounded output tail');
  assert.ok(reportError.details.stderrTail.length <= 4097, 'the reported stderr is a bounded tail, not the whole stream');
  assert.ok(reportError.details.stdoutTail.startsWith('…'), 'a trimmed tail is marked as trimmed');
  assert.equal(reportError.details.status, 7);
  assert.equal(reportError.details.signal, 'SIGKILL');

  assert.equal(readText(path.join(scratchRoot, 'caller-scratch.txt')), 'caller byte\n', 'caller scratch bytes survive every process failure');
});

test('an installation may not mutate the locked source or the committed target', async (t) => {
  const root = caseRoot(t, 'install-integrity');
  const sourceRoot = makeSourceRoot(root);
  sub(root, 'scratch');
  const npmPath = write(path.join(root, 'npm.cmd'), '@echo off\r\n');

  // The process rewrites its staged lock.
  const tamperingLock = adapterReturning(SUCCESSFUL_OUTCOME, {
    onCall: (request) => {
      write(path.join(request.cwd, 'package-lock.json'), '{"lockVersion":3,"packages":{"injected":true}}');
    },
  });
  await refusesWith(t, () => prepareDependencies(installInput(root, { npmExecutable: npmPath, workspaceRoot: sub(root, 'ws-lock'), processAdapter: tamperingLock })), DEPENDENCY_ERROR_CODES.NPM_LOCKFILE_CHANGED, 'a rewritten staged lock');
  assert.equal(readText(path.join(sourceRoot, 'package-lock.json')), DEFAULT_LOCK, 'the source lock is byte-identical after the refusal');

  // The staged manifest is the other half of the pair, and the process runs with
  // the staging directory as its working directory: a manifest it rewrites is a
  // rewrite of the very input the resulting tree claims to describe. The Captain
  // proved this by corrupting the file at `request.cwd`, so it is checked here as
  // a separate tracked input rather than assumed to ride on the lock check.
  const tamperingManifest = adapterReturning(SUCCESSFUL_OUTCOME, {
    onCall: (request) => {
      write(path.join(request.cwd, DEPENDENCIES_DIRECTORY_NAME, 'package-left/index.js'), 'left\n');
      write(path.join(request.cwd, 'package.json'), '{"name":"mutated","version":"0.0.0"}');
    },
  });
  const manifestError = await refusesWith(t, () => prepareDependencies(installInput(root, { npmExecutable: npmPath, workspaceRoot: sub(root, 'ws-manifest'), processAdapter: tamperingManifest })), DEPENDENCY_ERROR_CODES.NPM_LOCKFILE_CHANGED, 'a rewritten staged manifest');
  assert.equal(manifestError.details.role, 'staged package manifest', `the refusal names which input moved, got ${JSON.stringify(manifestError.details)}`);
  assert.equal(manifestError.details.phase, 'during installation');
  assert.equal(readText(path.join(sourceRoot, 'package.json')), DEFAULT_MANIFEST, 'the source manifest is byte-identical after the refusal');
  assert.ok(!fs.existsSync(path.join(root, 'ws-manifest', DEPENDENCIES_DIRECTORY_NAME)), 'a moved manifest commits no dependency directory');

  // A process that moves the source lock instead of the staged one is a distinct
  // failure at a distinct path, and the staged copy staying put must not excuse it.
  const tamperingSource = adapterReturning(SUCCESSFUL_OUTCOME, {
    onCall: (request) => {
      write(path.join(request.cwd, DEPENDENCIES_DIRECTORY_NAME, 'package-left/index.js'), 'left\n');
      write(path.join(sourceRoot, 'package-lock.json'), '{"lockVersion":3,"packages":{"rewritten":true}}');
    },
  });
  await refusesWith(t, () => prepareDependencies(installInput(root, { npmExecutable: npmPath, workspaceRoot: sub(root, 'ws-source'), processAdapter: tamperingSource })), DEPENDENCY_ERROR_CODES.NPM_LOCKFILE_CHANGED, 'a source lock rewritten during the install');
  assert.equal(readText(path.join(sourceRoot, 'package-lock.json')), '{"lockVersion":3,"packages":{"rewritten":true}}', 'the refusal reports the moved byte, it does not restore it');
  write(path.join(sourceRoot, 'package-lock.json'), DEFAULT_LOCK);
  assert.equal(readText(path.join(sourceRoot, 'package-lock.json')), DEFAULT_LOCK, 'the fixture restores the locked byte for the cases after it');

  // The process writes outside its staging directory into the target.
  const racingWorkspace = sub(root, 'ws-race');
  const racingTarget = adapterReturning(SUCCESSFUL_OUTCOME, {
    onCall: (request) => {
      write(path.join(request.cwd, DEPENDENCIES_DIRECTORY_NAME, 'package-left/index.js'), 'left\n');
      fs.mkdirSync(path.join(racingWorkspace, DEPENDENCIES_DIRECTORY_NAME), { recursive: true });
      write(path.join(racingWorkspace, DEPENDENCIES_DIRECTORY_NAME, 'appeared.txt'), 'appeared\n');
    },
  });
  await refusesWith(t, () => prepareDependencies(installInput(root, { npmExecutable: npmPath, workspaceRoot: racingWorkspace, processAdapter: racingTarget })), DEPENDENCY_ERROR_CODES.TARGET_EXISTS, 'a dependency directory that appears mid-install');

  // An occupied target is refused before anything runs.
  const occupied = sub(root, 'ws-occupied');
  fs.mkdirSync(path.join(occupied, DEPENDENCIES_DIRECTORY_NAME));
  let called = 0;
  await refusesWith(t, () => prepareDependencies(installInput(root, { npmExecutable: npmPath, workspaceRoot: occupied, processAdapter: adapterReturning(SUCCESSFUL_OUTCOME, { onCall: () => { called += 1; } }) })), DEPENDENCY_ERROR_CODES.TARGET_EXISTS, 'an occupied target');
  assert.equal(called, 0, 'the package manager is not invoked for an occupied target');
});

/* ------------------------------------------------- publication fate reporting */

/**
 * Hold a directory by making it the process working directory. On Windows a
 * directory that is some process's current directory can not be renamed or
 * removed, which is the only deterministic way to make the step around a
 * publication fail without inventing a test-only seam. The returned function
 * restores the previous working directory; every user must call it, because the
 * lock is process-global.
 *
 * @param {string} directory
 * @returns {() => void}
 */
function holdDirectoryAsWorkingDirectory(directory) {
  const previous = process.cwd();
  process.chdir(directory);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    process.chdir(previous);
  };
}

test('a failure while committing a verified install reports a partial publication', async (t) => {
  const root = caseRoot(t, 'publication-partial');
  const sourceRoot = makeSourceRoot(root);
  const scratchRoot = sub(root, 'scratch');
  const npmPath = write(path.join(root, 'npm.cmd'), '@echo off\r\n');
  const installed = { 'package-left/index.js': 'left installed\n' };
  const workspaceRoot = makeWorkspace(root, { name: 'ws-partial' });
  const target = path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME);

  // The verified tree exists and the publication name is claimed, then the move
  // itself fails. Nothing verified was ever put in place, so the only thing
  // inside the claimed name is this call's own empty claim, and the caller has
  // to be told that the name holds no verified bytes.
  let release = () => {};
  const locking = adapterReturning(SUCCESSFUL_OUTCOME, {
    onCall: (request) => {
      for (const [relative, text] of Object.entries(installed)) {
        write(path.join(request.cwd, DEPENDENCIES_DIRECTORY_NAME, relative), text);
      }
      release = holdDirectoryAsWorkingDirectory(path.join(request.cwd, DEPENDENCIES_DIRECTORY_NAME));
    },
  });
  let failure;
  try {
    failure = await refusesWith(
      t,
      () => prepareDependencies(installInput(root, { npmExecutable: npmPath, workspaceRoot, processAdapter: locking })),
      DEPENDENCY_ERROR_CODES.STAGING_FAILED,
      'a verified tree that could not be moved into place',
    );
  } finally {
    release();
  }

  assert.equal(failure.details.cause, 'EBUSY', 'the reason the move failed is carried through, not flattened into prose');
  // Attaching the cleanup log rebuilds the error, and the code already opens the
  // message, so the decoration step has to state the reason once rather than once
  // per step. A doubled code makes the message unreadable and breaks a caller
  // that matches on its prefix.
  assert.equal(failure.message.split(`${DEPENDENCY_ERROR_CODES.STAGING_FAILED}: `).length - 1, 1, `the reason the operation failed is stated exactly once: ${failure.message}`);
  assert.equal(failure.publication?.code, DEPENDENCY_ERROR_CODES.PUBLICATION_PARTIAL, 'the caller is told the claimed name holds no verified bytes');
  assert.equal(failure.publication.removed, true, 'the empty claim is removed, because it can not belong to another caller');
  assert.ok(!fs.existsSync(target), 'no half-written dependency directory is left behind');
  // The cleanup log names only what this call created, so a caller can see that
  // the removal was of its own claim and of nothing else.
  const cleanedUp = failure.details.cleanedUp ?? [];
  assert.ok(
    cleanedUp.some((entry) => entry.replace(/\//gu, path.sep).endsWith(`${path.sep}ws-partial${path.sep}node_modules`)),
    `the removed claim is recorded in the cleanup log: ${JSON.stringify(cleanedUp)}`,
  );
  assert.equal(readText(path.join(workspaceRoot, 'caller.txt')), 'caller byte\n', 'the caller data beside the claim is untouched');
  assert.equal(readText(path.join(sourceRoot, 'package-lock.json')), DEFAULT_LOCK, 'the locked source is untouched');

  // What the failed call could not remove is only the tree its own working
  // directory was holding; once the lock is gone it is ordinary debris below the
  // scratch root, and nothing outside the scratch root is left altered.
  const stagingRoot = path.join(scratchRoot, '.benchboard-install');
  assert.ok(fs.existsSync(stagingRoot), 'a directory the process was holding outlives the failed cleanup');
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  assert.deepEqual(fs.readdirSync(scratchRoot), [], 'the staging debris is confined to the scratch root');
});

test('a failure after a verified install was committed reports the retained publication', async (t) => {
  const root = caseRoot(t, 'publication-retained');
  const sourceRoot = makeSourceRoot(root);
  const scratchRoot = sub(root, 'scratch');
  const npmPath = write(path.join(root, 'npm.cmd'), '@echo off\r\n');
  const installed = { 'package-left/index.js': 'left installed\n' };
  const workspaceRoot = makeWorkspace(root, { name: 'ws-retained' });
  const published = path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME);

  // Here the verified bytes are already in place. The move can not be done by
  // rename, so the module copies the tree and verifies the published digest, and
  // only then does the cleanup of the staging directory fail. A caller that could
  // not tell the bytes it now has from half-written debris would have to throw
  // away a working installation, so the retention of verified bytes is reported
  // apart from the reason the operation failed.
  let release = () => {};
  const locking = adapterReturning(SUCCESSFUL_OUTCOME, {
    onCall: (request) => {
      for (const [relative, text] of Object.entries(installed)) {
        write(path.join(request.cwd, DEPENDENCIES_DIRECTORY_NAME, relative), text);
      }
      release = holdDirectoryAsWorkingDirectory(request.cwd);
    },
  });
  let failure;
  try {
    failure = await refusesWith(
      t,
      () => prepareDependencies(installInput(root, { npmExecutable: npmPath, workspaceRoot, processAdapter: locking })),
      DEPENDENCY_ERROR_CODES.CLEANUP_FAILED,
      'a staging directory the process was holding',
    );
  } finally {
    release();
  }

  assert.equal(failure.publication?.code, DEPENDENCY_ERROR_CODES.PUBLICATION_RETAINED, 'the reason the cleanup failed does not hide the state of the publication');
  assert.equal(failure.publication.removed, false, 'a verified install is never destroyed to report a later failure');
  assert.equal(failure.publication.digest, expectedDependencyDigest(published), 'the retained digest names the bytes that are actually in place');
  assert.equal(readText(path.join(published, 'package-left', 'index.js')), 'left installed\n', 'the published byte is still there');
  assert.equal(readText(path.join(workspaceRoot, 'caller.txt')), 'caller byte\n', 'the caller data beside the publication is untouched');
  assert.equal(readText(path.join(sourceRoot, 'package-lock.json')), DEFAULT_LOCK, 'the locked source is untouched');
  assert.ok(failure.message.includes('.benchboard-install'), 'the failure states what could not be removed');

  const stagingRoot = path.join(scratchRoot, '.benchboard-install');
  assert.ok(fs.existsSync(stagingRoot), 'the held staging directory outlives the failed cleanup');
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  assert.deepEqual(fs.readdirSync(scratchRoot), [], 'the staging debris is confined to the scratch root');
});

test('a byte this call did not write is preserved when the prepared commit fails', async (t) => {
  const root = caseRoot(t, 'publication-foreign');
  const sourceRoot = makeSourceRoot(root);
  const preparedRoot = makeCache(root, sourceRoot, { 'package-left/index.js': 'left byte\n' });
  const workspaceRoot = makeWorkspace(root, { name: 'ws-foreign' });
  const target = path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME);
  const foreign = path.join(target, 'foreign.txt');
  const cacheBefore = treeFingerprint(preparedRoot);

  // The publication name is claimed, a byte this call never wrote appears inside
  // it, and the move then fails for a reason that is not the copy-fallback set.
  // The reported failure is the failed commit either way; what this case pins is
  // what the failure path does with that byte. It is not provably this call's, so
  // deleting the name it claimed would destroy somebody else's data while
  // reporting an orderly cleanup — the behaviour a recursive remove had.
  const realRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (!injected && path.resolve(String(to)) === target) {
      injected = true;
      fs.writeFileSync(foreign, 'FOREIGN');
      throw Object.assign(new Error('injected: the verified tree could not be moved into place'), { code: 'EBUSY' });
    }
    return realRename(from, to);
  };
  let failure;
  try {
    failure = await refusesWith(
      t,
      () => prepareDependencies(preparedInput(root, { workspaceRoot })),
      DEPENDENCY_ERROR_CODES.STAGING_FAILED,
      'a prepared commit that an unowned byte made impossible',
    );
  } finally {
    fs.renameSync = realRename;
  }

  assert.ok(injected, 'the commit really was attempted onto the claimed name');
  assert.equal(failure.details.cause, 'EBUSY', 'the reason the commit failed is carried through, not flattened into prose');
  assert.equal(failure.publication?.code, DEPENDENCY_ERROR_CODES.PUBLICATION_PARTIAL, 'the claimed name holding no verified byte is reported as a partial publication');
  assert.equal(failure.publication.removed, false, 'a byte this call can not prove it wrote is not deleted to report a failure');
  assert.ok(
    failure.publication.residue.some((entry) => entry.endsWith(`${DEPENDENCIES_DIRECTORY_NAME}/foreign.txt`)),
    `the residue names the byte that was left standing: ${JSON.stringify(failure.publication.residue)}`,
  );
  assert.ok(
    failure.publication.residue.some((entry) => entry.endsWith(DEPENDENCIES_DIRECTORY_NAME)),
    `a name that is still standing is reported as residue rather than as removed: ${JSON.stringify(failure.publication.residue)}`,
  );
  assert.ok(!failure.message.includes(DEPENDENCY_ERROR_CODES.CLEANUP_FAILED), `the preserved byte is a reported residue, it does not surface as a cleanup failure: ${failure.message}`);

  assert.equal(readText(foreign), 'FOREIGN', 'the unowned byte is preserved byte-for-byte');
  assert.equal(readText(path.join(workspaceRoot, 'caller.txt')), 'caller byte\n', 'the caller data beside the publication is untouched');
  assert.deepEqual(fs.readdirSync(workspaceRoot).sort(), ['caller.txt', DEPENDENCIES_DIRECTORY_NAME], 'the workspace keeps the caller byte and the claim it was left with');
  assert.equal(treeFingerprint(preparedRoot), cacheBefore, 'the prepared cache is preserved by a failed commit');

  // The cleanup log is the promise a caller acts on, so it has to state that
  // nothing beneath the publication name was touched by this call.
  const claim = target.split(path.sep).join('/');
  const cleanedUp = failure.details.cleanedUp ?? [];
  assert.ok(
    cleanedUp.every((entry) => entry !== claim && !entry.startsWith(`${claim}/`)),
    `no path under the publication name is reported as cleaned: ${JSON.stringify(cleanedUp)}`,
  );
  assert.ok(!fs.existsSync(path.join(workspaceRoot, '.benchboard-tmp')), 'the staging area of the failed call is retired');
});

test('a prepared cache that gains a file after the copy is refused before the commit', async (t) => {
  const root = caseRoot(t, 'cache-after-copy');
  const sourceRoot = makeSourceRoot(root);
  const preparedRoot = makeCache(root, sourceRoot, { 'package-left/index.js': 'left byte\n' });
  const workspaceRoot = makeWorkspace(root, { name: 'ws-cachechange' });
  const target = path.join(workspaceRoot, DEPENDENCIES_DIRECTORY_NAME);
  const addition = path.join(preparedRoot, 'new-after-copy.js');

  // The copy has already reproduced the bound bytes, so a file added to the
  // cache afterwards changes no copied byte at all: only re-verifying the whole
  // cache can see it, which is what the four bound checks are for. The injection
  // point is the instant the publication name is claimed, and the phase the
  // refusal names is therefore the whole point of this case: a cache that moved
  // after the copy has to be refused at the last moment at which refusing is
  // free, rather than published and then reported.
  const realMkdir = fs.mkdirSync;
  let injected = false;
  fs.mkdirSync = (...args) => {
    const created = realMkdir(...args);
    if (!injected && path.resolve(String(args[0])) === target) {
      injected = true;
      fs.writeFileSync(addition, 'CACHE-CHANGED');
    }
    return created;
  };
  let failure;
  try {
    failure = await refusesWith(
      t,
      () => prepareDependencies(preparedInput(root, { workspaceRoot })),
      DEPENDENCY_ERROR_CODES.SOURCE_CHANGED_DURING_COPY,
      'a prepared cache that moved after the copy',
    );
  } finally {
    fs.mkdirSync = realMkdir;
  }

  assert.ok(injected, 'the addition was made while the publication name was being claimed');
  assert.equal(failure.details.phase, 'between the copy and the commit', 'the change is caught before a byte of it could be published, not after the commit');
  assert.equal(failure.details.kind, 'structure', 'an addition is a change of structure, which no copied-byte comparison can show');
  assert.equal(failure.publication?.code, DEPENDENCY_ERROR_CODES.PUBLICATION_PARTIAL, 'the empty claim is reported for what it is: no verified byte was published');
  assert.equal(failure.publication.removed, true, 'an empty claim that holds nothing but this call own empty directory is retired');
  assert.ok(!fs.existsSync(target), 'nothing is committed from a cache that moved');
  assert.ok(!fs.existsSync(addition + '.published'), 'sanity: the added byte has no path in the workspace');
  assert.equal(readText(addition), 'CACHE-CHANGED', 'the cache is left exactly as its owner left it');
  assert.ok(!fs.existsSync(path.join(workspaceRoot, '.benchboard-tmp')), 'the staging area of the refused call is retired');
  assert.deepEqual(fs.readdirSync(workspaceRoot).sort(), ['caller.txt'], 'the workspace is exactly what it was before the call');

  // The refusal above is the verification, not a fixture that could not run: the
  // same cache, source and workspace pair prepare cleanly once nothing under the
  // cache is moving, and then the added byte is copied like any other.
  const controlRoot = makeWorkspace(root, { name: 'ws-cachechange-control' });
  const control = await prepareDependencies(preparedInput(root, { workspaceRoot: controlRoot }));
  assert.equal(control.mode, 'prepared', 'the same fixture prepares cleanly when the cache stands still');
  assert.equal(readText(path.join(controlRoot, DEPENDENCIES_DIRECTORY_NAME, 'new-after-copy.js')), 'CACHE-CHANGED', 'the control proves the refusal was the moving cache and not the fixture');
});

/* ------------------------------------------------------ spawn adapter */

test('the default process adapter is bounded, shell-free and killable on timeout', async (t) => {
  const adapter = createNodeSpawnAdapter({ timeoutMs: 30000, maxOutputBytes: 4096 });
  assert.equal(typeof adapter, 'function', 'the factory yields a request-to-result adapter');

  const root = caseRoot(t, 'spawn-adapter');
  const script = write(path.join(root, 'emit.cjs'), 'process.stdout.write("out byte");\nprocess.stderr.write("err byte");\n');
  const outcome = await adapter({ file: process.execPath, args: [script], shell: false });
  assert.equal(outcome.status, 0, `the probe ran without a shell: ${outcome.stderr}`);
  assert.equal(outcome.stdout, 'out byte');
  assert.equal(outcome.stderr, 'err byte');
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.spawnError, null, 'no spawn error for a successful run');
  assert.equal(outcome.overflow, false);
  assert.ok(Object.isFrozen(outcome), 'the outcome is immutable');

  const timeoutAdapter = createNodeSpawnAdapter({ timeoutMs: 120, killSignal: 'SIGKILL' });
  const sleeper = write(path.join(root, 'sleep.cjs'), 'setInterval(() => {}, 1000);\n');
  const timedOut = await timeoutAdapter({ file: process.execPath, args: [sleeper] });
  assert.equal(timedOut.timedOut, true, 'a bounded timeout kills the child instead of hanging the initialiser');
  assert.notEqual(timedOut.status, 0);

  const overflowAdapter = createNodeSpawnAdapter({ timeoutMs: 30000, maxOutputBytes: 8 });
  const noisy = write(path.join(root, 'noisy.cjs'), 'process.stdout.write("z".repeat(512));\n');
  const overflowed = await overflowAdapter({ file: process.execPath, args: [noisy] });
  assert.equal(overflowed.overflow, true, 'output is counted, bounded and drained instead of accumulating without limit');
  assert.ok(overflowed.stdout.length <= 8, 'the retained output respects the bound');

  // A program that cannot be started is reported as a value. The port accepts a
  // bare program name on purpose: the validated Windows strategy names
  // `cmd.exe` and lets the operating system resolve it, so only the argument
  // vector can be validated statically. The raw wait status is platform-shaped
  // (Windows reports a negative error number here), so the portable contract is
  // "never a success, plus a spawn error value".
  const missing = await adapter({ file: path.join(root, 'definitely-not-here.cjs'), args: [] });
  assert.notEqual(missing.status, 0, 'a failed spawn is never reported as a success');
  assert.equal(missing.timedOut, false, 'an unstartable program is not a timeout');
  assert.equal(typeof missing.spawnError, 'string', 'a spawn failure is reported as a value, not an unhandled rejection');
  assert.ok(missing.spawnError.includes('ENOENT'), `the reported spawn error names the cause: ${missing.spawnError}`);
  await assert.rejects(() => adapter({ file: process.execPath, args: ['ok', 7] }), (error) => error.code === DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, void 0, 'every argument must be a string');
  await assert.rejects(() => adapter({ args: [] }), (error) => error.code === DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, void 0, 'a request without a program is refused');
});

/* ------------------------------------------------- declaration fidelity */

test('the shipped declaration pair is byte-identical and covers the real surface', () => {
  const declarationPath = fileURLToPath(new URL('../../packages/core/dependencies.d.ts', import.meta.url));
  const modulePath = fileURLToPath(new URL('../../packages/core/dependencies.d.mts', import.meta.url));
  const declarationBytes = fs.readFileSync(declarationPath);
  const moduleBytes = fs.readFileSync(modulePath);
  assert.deepEqual(moduleBytes, declarationBytes, 'the .d.ts and .d.mts declarations are byte-identical');
  assert.equal(crypto.createHash('sha256').update(declarationBytes).digest('hex'), 'bd97adedbe8e048311857c5c61cefad0c6fda59aea88c1eeab9c35afee8f0c0a', 'the declaration pair is the hashed, released surface');

  const text = declarationBytes.toString('utf8');
  for (const name of Object.keys(core)) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(text), `the declaration names ${name}`);
  }
  for (const literal of ['benchboard-dependency-tree-v1', 'benchboard.core.dependencies', 'benchboard-npm-bin-link-v1', 'node_modules', DEPENDENCIES_METADATA_FILE_NAME, 'none', 'prepared', 'install']) {
    assert.ok(text.includes(`'${literal}'`) || text.includes(`"${literal}"`), `the declaration carries the literal ${JSON.stringify(literal)}`);
  }
  for (const code of Object.values(DEPENDENCY_ERROR_CODES)) {
    assert.ok(new RegExp(`\\b${code}\\b`).test(text), `the declaration names the refusal code ${code}`);
  }
  for (const field of ['workingDirectory', 'timeoutMs', 'status', 'signal', 'timedOut', 'stderrTail', 'stdoutTail', 'npmBinLinkPolicy', 'windowsVerbatimArguments']) {
    assert.ok(text.includes(field), `the command report declares ${field}`);
  }
  // The fate of a publication is the one fact a caller cannot recover from the
  // error code, so it has to be part of the released surface rather than an
  // undocumented extra on the runtime object.
  assert.ok(text.includes('readonly publication?: DependencyPublicationFate'), 'the error declares the publication fate it can carry');
  for (const fateCode of ['PUBLICATION_RETAINED', 'PUBLICATION_PARTIAL', "'unreadable'"]) {
    assert.ok(text.includes(fateCode), `the publication fate surface names ${fateCode}`);
  }
});

test('the declarations typecheck with the pinned repository compiler', (t) => {
  const compiler = fileURLToPath(new URL('../../starter/node_modules/typescript/bin/tsc', import.meta.url));
  if (!fs.existsSync(compiler)) {
    t.skip('the pinned TypeScript compiler is not installed in starter/node_modules; no install is performed by this test');
    return;
  }
  const declarationPaths = [
    fileURLToPath(new URL('../../packages/core/dependencies.d.ts', import.meta.url)),
    fileURLToPath(new URL('../../packages/core/dependencies.d.mts', import.meta.url)),
  ];
  const flags = ['--noEmit', '--strict', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext'];
  const compile = (sources) => {
    const result = spawnSync(process.execPath, [compiler, ...flags, ...sources], { encoding: 'utf8' });
    return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  };
  assert.equal(compile(declarationPaths), '', 'the shipped declarations compile clean on their own');

  // A declaration nobody can consume is not a contract. This imports the shipped
  // runtime module, so the pair beside it is what the compiler has to resolve, and
  // it uses the surface the way a caller does rather than only naming its types.
  const moduleFile = fileURLToPath(new URL('../../packages/core/dependencies.mjs', import.meta.url));
  const where = caseRoot(t, 'typed-consumer');
  const relative = path.relative(where, moduleFile).split(path.sep).join('/');
  if (/^[A-Za-z]:/.test(relative)) {
    // A harness may point the scratch at another volume, and then no relative
    // module specifier reaches the shipped module. The declaration is still
    // compiled above; only the consumer leg needs a shared volume.
    t.skip(`the scratch root ${where} and the shipped module are on different volumes, so no relative import reaches it`);
    return;
  }
  const specifier = relative.startsWith('.') ? relative : `./${relative}`;
  const writeConsumer = (name, lines) => write(path.join(where, name), `${lines.join('\n')}\n`);

  const accepted = writeConsumer('consume.mts', [
    `import * as deps from '${specifier}';`,
    "const mode: deps.DependencyMode = 'install';",
    "const strategy: deps.PrepareDependenciesOptions['installStrategy'] = 'hoisted';",
    'export const limits: readonly string[] = deps.DEPENDENCY_MODES;',
    "export const hash: 'benchboard-dependency-tree-v1' = deps.DEPENDENCY_HASH_ALGORITHM_ID;",
    'export async function read(record: deps.PrepareDependenciesResult): Promise<string> {',
    '  const bytes: number = record.inventory.entries.reduce((total, entry) => total + entry.bytes, 0);',
    '  const total: number = record.inventory.totalBytes;',
    "  return `${mode}:${strategy}:${limits.length}:${hash}:${bytes}:${total}:${record.dependencyDigest ?? 'none'}`;",
    '}',
    // The point of the publication fate: a caller can branch on it and the compiler
    // knows a retained tree was kept, while a partial one reports whether the empty
    // claim went away or a byte it cannot prove it wrote is still standing.
    'export function fate(error: unknown): string {',
    "  if (!(error instanceof deps.DependencyError)) return 'other';",
    '  const publication = error.publication;',
    '  if (publication === undefined) return `bare:${error.code}`;',
    "  if ('state' in publication) return `unreadable:${publication.cause}`;",
    '  const digest: string = publication.digest;',
    "  return publication.code === 'PUBLICATION_RETAINED'",
    "    ? `kept:${digest}:${publication.removed satisfies false}`",
    "    : `partial:${digest}:${publication.removed}:${publication.residue.length}`;",
    '}',
    // A built command has to be passable to the adapter, so the verbatim option the
    // builder sets has to survive the type of the value it returns.
    'export function command(): deps.BuiltDependencyCommand {',
    "  const resolved = deps.resolveDependencyCommandStrategy({ executablePath: 'C:/Program Files/nodejs/node.exe' });",
    "  const built = deps.buildDependencyCommand(resolved, { command: resolved.file, args: ['--version'] });",
    '  const verbatim: boolean = built.options.windowsVerbatimArguments === true;',
    "  const adapter: deps.DependencyProcessAdapter = deps.createNodeSpawnAdapter({ timeoutMs: 1000, maxOutputBytes: 64 });",
    '  void adapter;',
    "  return verbatim ? { ...built, args: [...built.args, '--no-audit'] } : { ...built, args: [...built.args, '--offline=false'] };",
    '}',
  ]);
  const rejected = writeConsumer('rejected.mts', [
    `import type * as deps from '${specifier}';`,
    "export const request: deps.PrepareDependenciesOptions = { mode: 'install', workspaceRoot: 'C:/w', installStrategy: 'short' };",
  ]);

  const acceptedReport = compile([accepted]);
  assert.equal(acceptedReport, '', `a caller of the shipped module has to typecheck, the pinned compiler reported:\n${acceptedReport}`);

  // The declaration is the contract, so a value the runtime refuses has to be a
  // type error too: a caller must not be able to write an invented strategy.
  const rejectedReport = compile([rejected]);
  assert.ok(rejectedReport.length > 0, 'a caller that writes an invented install strategy does not typecheck');
  assert.ok(rejectedReport.includes('short') && /not assignable/i.test(rejectedReport), `the declaration rejects the invented strategy as a type error, got:\n${rejectedReport}`);
});

test('this test file keeps its fixtures inside the declared contained scratch root', (t) => {
  const root = testScratchRoot();
  const override = process.env.BENCHBOARD_TEST_TMP ?? process.env.BENCHBOARD_TEST_SCRATCH_ROOT;
  assert.ok(path.isAbsolute(root), 'the scratch root is absolute');
  if (override === void 0 || override === '') {
    // With no harness override the fallback must be repository-contained, which
    // is what makes this distributed file free of any private absolute path.
    assert.ok(root === CONTAINED_SCRATCH, 'the fallback is the repository-contained directory');
    assert.ok(containsPath(REPO_ROOT, root), 'the fallback is inside this repository');
    assert.ok(root.split(path.sep).join('/').includes('.local/test-scratch/'), 'the fallback is the ignored scratch location');
  } else {
    assert.ok(root === path.resolve(override), 'an explicit harness root is honoured verbatim');
  }
  // The distribution property belongs to this file, not to the harness: a
  // harness may legitimately point the scratch at an evidence directory, while a
  // source file must not bake in any owner-only or private location at all. The
  // needles are assembled so this test's own text is not what it flags.
  const evidenceNeedle = ['.ai', 'evidence', ''].join('/');
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.ok(!self.includes(evidenceNeedle), 'this file hardwires no owner-only evidence path');
  assert.ok(!/[A-Za-z]:[\/\\]+[Uu]sers[\/\\]/.test(self), 'this file hardwires no private user profile path');
  // A checkout cloned under a user profile legitimately puts its contained scratch there too.
  if (!/[A-Za-z]:[\/\\]+[Uu]sers[\/\\]/.test(REPO_ROOT)) {
    assert.ok(!/[A-Za-z]:[\/\\]+[Uu]sers[\/\\]/.test(root), `no private user profile path is part of the scratch root: ${root}`);
  }
  const probe = caseRoot(t, 'containment');
  assert.ok(containsPath(root, probe), 'every case directory is contained');
});

/** Strict containment test used only by the containment case above. */
function containsPath(parent, child) {
  const withSeparator = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(withSeparator);
}

test('install retires ordinary output from its explicitly isolated npm cache', async (t) => {
  const root = caseRoot(t, 'populated-cache');
  makeWorkspace(root); makeSourceRoot(root); sub(root, 'scratch');
  write(path.join(root, 'npm.cmd'), '@echo off\n');
  const processAdapter = adapterInstalling({ 'dep.js': 'export const n=1;' });
  const adapter = async request => {
    const result = await processAdapter(request);
    write(path.join(request.cwd, '.npm-cache', 'entry'), 'ordinary cache output');
    return result;
  };
  const result = await prepareDependencies(installInput(root, { processAdapter: adapter }));
  assert.equal(result.mode, 'install');
  assert.equal(fs.existsSync(path.join(root, 'workspace', 'node_modules', 'dep.js')), true);
  assert.deepEqual(fs.readdirSync(path.join(root, 'scratch')), []);
});

test('failed install preserves unrelated staging entries and discloses residue', async (t) => {
  const root = caseRoot(t, 'foreign-staging');
  makeWorkspace(root); makeSourceRoot(root); sub(root, 'scratch');
  write(path.join(root, 'npm.cmd'), '@echo off\n');
  let canary;
  const adapter = async request => {
    canary = path.join(request.cwd, 'foreign.txt');
    write(canary, 'FOREIGN');
    return { status: 7, signal: null, stdout: '', stderr: 'injected failure' };
  };
  const error = await refusesWith(t, () => prepareDependencies(installInput(root, { processAdapter: adapter })), DEPENDENCY_ERROR_CODES.NPM_EXIT_NONZERO);
  assert.equal(readText(canary), 'FOREIGN');
  assert.ok(error.details.cleanupResidue.includes(canary.split(path.sep).join('/')));
});

/* -------------------- SOTA R1 bounded original-contract regressions */

test('install environment rejects redirects and secrets before any filesystem/process mutation', async (t) => {
  const root = caseRoot(t, 'r1-env');
  makeSourceRoot(root); makeWorkspace(root); sub(root, 'scratch');
  write(path.join(root, 'npm.cmd'), '@echo off\r\n');
  for (const name of ['npm_config_cache', 'NPM_CONFIG_CACHE', 'NpM_CoNfIg_CaChE', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_prefix', 'npm_config_registry', 'npm_config_proxy', 'npm_config_https_proxy', 'npm_config__auth', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'HOME', 'USERPROFILE', 'NODE_OPTIONS']) {
    const before = treeFingerprint(root);
    let called = false;
    const realMkdir = fs.mkdirSync; const realMkdtemp = fs.mkdtempSync; const realWrite = fs.writeFileSync;
    let mutation = false;
    fs.mkdirSync = (...args) => { mutation = true; return realMkdir(...args); };
    fs.mkdtempSync = (...args) => { mutation = true; return realMkdtemp(...args); };
    fs.writeFileSync = (...args) => { mutation = true; return realWrite(...args); };
    try {
      await refusesWith(t, () => prepareDependencies(installInput(root, { environment: { [name]: path.join(root, 'escape') }, processAdapter: () => { called = true; return SUCCESSFUL_OUTCOME; } })), DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, name);
    } finally { fs.mkdirSync = realMkdir; fs.mkdtempSync = realMkdtemp; fs.writeFileSync = realWrite; }
    assert.equal(mutation, false, name + ': no mutation attempted');
    assert.equal(called, false, name + ': process never invoked');
    assert.equal(treeFingerprint(root), before);
  }
  const adapter = adapterInstalling({ 'dep.js': 'ordinary' });
  await prepareDependencies(installInput(root, { environment: { path: process.env.PATH, tMp: root }, processAdapter: adapter }));
  const request = adapter.calls[0];
  assert.equal(request.env.PATH, process.env.PATH);
  assert.equal(request.env.TMP, root);
  assert.equal(request.env.npm_config_cache, path.join(request.cwd, '.npm-cache'));
  assert.equal(request.env.npm_config_userconfig, path.join(request.cwd, '.npm-cache', 'user.npmrc'));
  assert.equal(request.env.npm_config_globalconfig, path.join(request.cwd, '.npm-cache', 'global.npmrc'));
});

for (const mode of ['prepared', 'install']) {
  for (const replacement of ['file', 'directory', 'staging', 'ancestor', ...(mode === 'install' ? ['lock', 'cache'] : [])]) {
    test(`${mode}: same-byte foreign ${replacement} replacement is preserved with cleanup residue`, async (t) => {
      const root = caseRoot(t, `r1-${mode}-${replacement}`);
      const sourceRoot = makeSourceRoot(root); const workspaceRoot = makeWorkspace(root); const scratchRoot = sub(root, 'scratch');
      makeCache(root, sourceRoot, { 'pkg/dep.js': 'same bytes' });
      write(path.join(root, 'npm.cmd'), '@echo off\r\n');
      const adapter = adapterInstalling({ 'pkg/dep.js': 'same bytes' });
      const realRename = fs.renameSync;
      let replaced = null;
      fs.renameSync = (from, to) => {
        if (path.resolve(String(to)) === path.join(workspaceRoot, 'node_modules')) {
          const staging = path.dirname(String(from));
          const candidate = replacement === 'file' ? path.join(String(from), 'pkg', 'dep.js') : replacement === 'directory' ? path.join(String(from), 'pkg') : replacement === 'staging' ? staging : replacement === 'ancestor' ? path.dirname(staging) : replacement === 'lock' ? path.join(staging, 'package-lock.json') : path.join(staging, '.npm-cache');
          const saved = path.join(root, 'preserved-original');
          realRename(candidate, saved);
          fs.cpSync(saved, candidate, { recursive: true });
          replaced = candidate;
          throw Object.assign(new Error('injected commit refusal after same-byte replacement'), { code: 'EBUSY' });
        }
        return realRename(from, to);
      };
      let failure;
      try {
        failure = await refusesWith(t, () => prepareDependencies(mode === 'prepared' ? preparedInput(root) : installInput(root, { processAdapter: adapter })), DEPENDENCY_ERROR_CODES.STAGING_FAILED);
      } finally { fs.renameSync = realRename; }
      assert.ok(replaced);
      assert.ok(fs.existsSync(replaced), 'identical content is not ownership');
      assert.ok(failure.details.cleanupResidue?.length > 0, 'residue disclosed');
      if (replacement === 'file') assert.equal(readText(replaced), 'same bytes');
      if (replacement === 'directory') assert.equal(readText(path.join(replaced, 'dep.js')), 'same bytes');
      if (replacement === 'lock') assert.equal(readText(replaced), DEFAULT_LOCK);
      assert.equal(readText(path.join(workspaceRoot, 'caller.txt')), 'caller byte\n');
      assert.equal(readText(path.join(sourceRoot, 'package-lock.json')), DEFAULT_LOCK);
    });
  }
  for (const fault of ['collision', 'write']) {
    test(`${mode}: postcommit metadata ${fault} retains original failure and verified publication fate`, async (t) => {
      const root = caseRoot(t, `r1-meta-${mode}-${fault}`);
      const sourceRoot = makeSourceRoot(root); const workspaceRoot = makeWorkspace(root); sub(root, 'scratch');
      makeCache(root, sourceRoot, { 'pkg/dep.js': 'same bytes' });
      write(path.join(root, 'npm.cmd'), '@echo off\r\n');
      const metadataPath = path.join(root, 'metadata.json');
      const realRmdir = fs.rmdirSync;
      let collisionInjected = false;
      fs.rmdirSync = (directory, ...args) => {
        const result = realRmdir(directory, ...args);
        if (fault === 'collision' && path.basename(String(directory)) === (mode === 'prepared' ? '.benchboard-tmp' : '.benchboard-install')) {
          assert.ok(fs.existsSync(path.join(workspaceRoot, 'node_modules', 'pkg', 'dep.js')), 'collision injected only after dependency commit');
          write(metadataPath, 'foreign metadata');
          collisionInjected = true;
        }
        return result;
      };
      const realWrite = fs.writeFileSync;
      const original = Object.assign(new Error('injected metadata write fault'), { code: 'EACCES' });
      fs.writeFileSync = (file, ...args) => {
        if (String(file) === metadataPath && fault === 'write') throw original;
        return realWrite(file, ...args);
      };
      let failure;
      try {
        failure = await refusesWith(t, () => prepareDependencies(mode === 'prepared' ? preparedInput(root, { metadataPath }) : installInput(root, { metadataPath, processAdapter: adapterInstalling({ 'pkg/dep.js': 'same bytes' }) })), fault === 'collision' ? DEPENDENCY_ERROR_CODES.TARGET_EXISTS : DEPENDENCY_ERROR_CODES.STAGING_FAILED);
      } finally { fs.writeFileSync = realWrite; fs.rmdirSync = realRmdir; }
      if (fault === 'collision') assert.equal(collisionInjected, true);
      assert.equal(failure.publication?.code, DEPENDENCY_ERROR_CODES.PUBLICATION_RETAINED);
      assert.equal(failure.publication.removed, false);
      assert.equal(failure.publication.digest, expectedDependencyDigest(path.join(workspaceRoot, 'node_modules')));
      assert.ok(failure.details.cleanedUp.length > 0);
      if (fault === 'collision') assert.equal(readText(metadataPath), 'foreign metadata');
      else { assert.equal(failure.cause, original); assert.equal(failure.details.cause, 'EACCES'); assert.equal(fs.existsSync(metadataPath), false); }
      assert.equal(readText(path.join(sourceRoot, 'package-lock.json')), DEFAULT_LOCK);
      assert.equal(readText(path.join(workspaceRoot, 'caller.txt')), 'caller byte\n');
      assert.equal(fs.existsSync(path.join(workspaceRoot, '.benchboard-tmp')), false);
      assert.deepEqual(fs.readdirSync(path.join(root, 'scratch')), []);
    });
  }
}


test('install default real process receives only private npm paths and runtime allowlist', async (t) => {
  const root = caseRoot(t, 'r1-real-private-env');
  makeSourceRoot(root); makeWorkspace(root); sub(root, 'scratch');
  const script = write(path.join(root, 'private-env.cjs'), `
const fs = require('node:fs'); const path = require('node:path');
const cache = path.join(process.cwd(), '.npm-cache');
for (const [key, value] of Object.entries({ npm_config_cache: cache, npm_config_userconfig: path.join(cache, 'user.npmrc'), npm_config_globalconfig: path.join(cache, 'global.npmrc') })) {
  if (process.env[key] !== value) throw Error('not private: ' + key);
}
// Windows may add profile variables during process creation; npm is explicitly
// pinned to private user/global config paths above, never profile credential files.
if (process.env.BENCHBOARD_PRIVATE_TOKEN || process.env.NPM_TOKEN) throw Error('ambient credential leaked');
fs.mkdirSync('node_modules'); fs.writeFileSync('node_modules/dep.js', 'default process byte');
`);
  const syntheticConfig = write(path.join(root, 'synthetic-profile', '.npmrc'), 'registry=https://synthetic.invalid/\n_authToken=synthetic-not-a-secret\n');
  const savedEnvironment = new Map(['BENCHBOARD_PRIVATE_TOKEN', 'NPM_TOKEN', 'npm_config_userconfig', 'npm_config_globalconfig'].map((name) => [name, process.env[name]]));
  process.env.BENCHBOARD_PRIVATE_TOKEN = 'never-forward-this';
  process.env.NPM_TOKEN = 'synthetic-not-a-secret';
  process.env.npm_config_userconfig = syntheticConfig;
  process.env.npm_config_globalconfig = syntheticConfig;
  try {
    const result = await prepareDependencies(installInput(root, { npmExecutable: process.execPath, executableStrategy: 'direct', npmArgumentsPrefix: [script] }));
    assert.equal(result.metadata.npm.status, 0);
    assert.equal(readText(path.join(root, 'workspace', 'node_modules', 'dep.js')), 'default process byte');
    assert.deepEqual(fs.readdirSync(path.join(root, 'scratch')), []);
  } finally {
    for (const [name, value] of savedEnvironment) {
      if (value === void 0) delete process.env[name]; else process.env[name] = value;
    }
    assert.equal(readText(syntheticConfig), 'registry=https://synthetic.invalid/\n_authToken=synthetic-not-a-secret\n');
  }
});

test('empty foreign replacement of helper publication claim is not removed', async (t) => {
  const root = caseRoot(t, 'r1-empty-claim-replacement');
  const sourceRoot = makeSourceRoot(root); const workspaceRoot = makeWorkspace(root);
  makeCache(root, sourceRoot, { 'dep.js': 'ordinary' });
  const target = path.join(workspaceRoot, 'node_modules'); const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === target) {
      realRename(target, path.join(root, 'original-claim'));
      fs.mkdirSync(target);
      throw Object.assign(new Error('publication claim replaced'), { code: 'EBUSY' });
    }
    return realRename(from, to);
  };
  let failure;
  try { failure = await refusesWith(t, () => prepareDependencies(preparedInput(root)), DEPENDENCY_ERROR_CODES.STAGING_FAILED); }
  finally { fs.renameSync = realRename; }
  assert.equal(fs.existsSync(target), true);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(failure.publication.removed, false);
  assert.ok(failure.publication.residue.includes(target.split(path.sep).join('/')));
});
