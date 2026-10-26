/* BenchBoard initialisation — focused tests for the C2 run initialiser.
 *
 * Contract: the approved C2 execution plan, T3, plus the frozen trust boundary
 * and the transaction rule it states. The contract is named by chunk and task
 * rather than by a private repository path, because this file is distributed to
 * participants and must not point at owner-only planning material.
 *
 * What this suite is for. The initialiser is the seam that joins three modules
 * that were each tested on their own — the exported challenge workspace, the
 * dependency helper, and the accepted storage and manifest contract — so the
 * load-bearing assertions here are about the seam, not about the internals it
 * delegates to: which roots are final, which bytes are where, which two hash
 * domains never meet, what survives a failure, and what the handler forwards.
 *
 * Containment: scratch comes from BENCHBOARD_TEST_TMP or
 * BENCHBOARD_TEST_SCRATCH_ROOT when either names an absolute directory,
 * otherwise from a directory inside this repository. No sibling directory and no
 * operating-system temporary directory is used, and no private evidence path is
 * embedded in the module under test. Every fixture root — source, owner,
 * evaluator, dependency cache, output parent — is created inside that contained
 * scratch, so a test cannot reach a real participant workspace.
 *
 * Install orchestration is exercised end to end with a deterministic process
 * adapter, including populated private npm cache and immutable state read-back.
 * Real networked npm installation is not authorized or claimed by this suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  InitError,
  INIT_ERROR_CODES,
  INIT_MODULE_ID,
  INIT_STATE_KIND,
  INIT_STATE_SCHEMA_VERSION,
  INIT_SECURITY_MODELS,
  WORKSPACE_DIRECTORY_NAME,
  STATE_DIRECTORY_NAME,
  DEPENDENCIES_DIRECTORY_NAME,
  DEPENDENCIES_METADATA_FILE_NAME,
  DEPENDENCY_STATE_RELATIVE_PATH,
  RUN_STATE_RELATIVE_PATH,
  EXPORT_STATE_RELATIVE_PATH,
  WORKLOAD_HASH_ALGORITHM_ID,
  DEPENDENCY_HASH_ALGORITHM_ID,
  DEPENDENCY_MODES,
  init,
  initialiseRun,
} from '../../packages/core/init.mjs';
import { hashEntries, sha256, inventoryTree } from '../../packages/core/identity.mjs';
import { validateRecord, SECURITY_MODELS } from '../../packages/core/manifest.mjs';
import { EXPECTED_WORKLOAD_FILE_COUNT } from '../../packages/core/challenge-export.mjs';
import { loadFixture } from '../contracts/fixtures/contracts/index.mjs';
import {
  CLI_EXIT_CODES,
  CLI_ERROR_CODES,
  CHALLENGE_PACKAGE_KEYS,
  INITIALIZABLE_STATEMENT_KEYS,
  OPTION_SPECIFICATIONS,
  UNIMPLEMENTED_OPTIONS,
  CLI_USAGE,
  CliError,
  parseArguments,
  runInit,
  main,
  summariseResult,
} from '../../cli/init.mjs';

/* ------------------------------------------------------------------ constants */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STARTER_ROOT = path.join(REPO_ROOT, 'starter');
const CORE_ROOT = path.join(REPO_ROOT, 'packages', 'core');
const CLI_ROOT = path.join(REPO_ROOT, 'cli');
const RELEASE_INVENTORY_PATH = path.join(REPO_ROOT, 'release', 'inventory.json');
const PINNED_COMPILER = path.join(STARTER_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const CORE_MODULE_UNDER_TEST = path.join(CORE_ROOT, 'init.mjs');
const CLI_MODULE_UNDER_TEST = path.join(CLI_ROOT, 'init.mjs');

const HEX64 = /^[0-9a-f]{64}$/;
const RAW_COMPARE = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/* -------------------------------------------------------------------- helpers */

/** Read the accepted participant inventory as raw data, importing nothing legacy. */
function releaseParticipantPaths() {
  const inventory = JSON.parse(fs.readFileSync(RELEASE_INVENTORY_PATH, 'utf8'));
  return Object.freeze(inventory.participant.files.map((entry) => entry.path));
}

/**
 * Scratch root: an explicit absolute environment override when the harness
 * supplies one, else a directory inside this repository. The read-only starter
 * tree must never be entered as scratch, so an override that contains it is
 * refused outright.
 */
function scratchRoot() {
  const names = ['BENCH' + 'BOARD_TEST_TMP', 'BENCH' + 'BOARD_TEST_SCRATCH_ROOT'];
  for (const name of names) {
    const value = process.env[name];
    if (value === void 0 || value.length === 0) continue;
    if (!path.isAbsolute(value)) {
      throw new Error(`${name} must be an absolute directory, got ${JSON.stringify(value)}`);
    }
    fs.mkdirSync(value, { recursive: true });
    const resolved = path.resolve(value);
    const starter = path.resolve(STARTER_ROOT);
    if (starter === resolved || starter.startsWith(resolved + path.sep)) {
      throw new Error(`${name} must not contain the read-only starter tree at ${starter}`);
    }
    return resolved;
  }
  const contained = fileURLToPath(new URL('./.tmp/initialization/', import.meta.url));
  fs.mkdirSync(contained, { recursive: true });
  return contained;
}

/** One throwaway directory per test, removed when that test finishes. */
function scratch(t, name) {
  const directory = fs.mkdtempSync(path.join(scratchRoot(), `c2t3-${name}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Capture the error a promise rejects with, or undefined when it resolves. */
async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return void 0;
}

/**
 * Assert one fail-closed outcome: an InitError carrying the expected code, with
 * the code spelled first. A resolve, a foreign error type or a wrong code all
 * report what actually happened.
 */
async function expectCode(promise, code, label) {
  const error = await rejection(promise);
  assert.ok(error !== void 0, `${label}: a rejection was expected`);
  assert.ok(error instanceof InitError, `${label}: an InitError was expected, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, `${label}: error code (${error.message})`);
  assert.match(error.message, new RegExp(`^${code}: `), `${label}: the message names the code first`);
  return error;
}

/**
 * Assert one handler refusal: a CliError with the expected code and the code
 * spelled first. The handler's own refusals mean nothing was attempted, so they
 * are distinct from an API refusal by construction as well as by type.
 */
async function expectCliCode(promise, code, label) {
  const error = await rejection(promise);
  assert.ok(error !== void 0, `${label}: a rejection was expected`);
  assert.ok(error instanceof CliError, `${label}: a CliError was expected, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, `${label}: error code (${error.message})`);
  assert.match(error.message, new RegExp(`^${code}: `), `${label}: the message names the code first`);
  return error;
}

/** Recursive, deterministic snapshot of one tree, keyed by relative POSIX path. */
function snapshotTree(root) {
  const seen = new Map();
  const walk = (absolute, relative) => {
    const status = fs.lstatSync(absolute);
    if (status.isSymbolicLink()) {
      seen.set(relative, 'link');
      return;
    }
    if (status.isDirectory()) {
      if (relative !== '') seen.set(relative, 'directory');
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort(RAW_COMPARE)) {
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        walk(path.join(absolute, entry.name), child);
      }
      return;
    }
    seen.set(relative, status.isFile() ? `file:${fs.readFileSync(absolute).byteLength}` : 'special');
  };
  walk(root, '');
  return Object.fromEntries([...seen.entries()].sort((left, right) => RAW_COMPARE(left[0], right[0])));
}

/** The entries added to a snapshot, or removed from it. */
function addedEntries(before, after) {
  return Object.keys(after).filter((key) => !(key in before)).sort(RAW_COMPARE);
}
function removedEntries(before, after) {
  return Object.keys(before).filter((key) => !(key in after)).sort(RAW_COMPARE);
}

/** Byte-for-byte copy, so fixture bytes can never be re-encoded. */
function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fs.readFileSync(source));
}

/** Split a relative POSIX path into host segments. */
const segments = (relativePath) => relativePath.split('/');

/** Absolute path of one accepted read-only starter file. */
const starterPath = (relativePath) => path.join(STARTER_ROOT, ...segments(relativePath));

/** Absolute path of one file inside a fixture root. */
const inRoot = (root, relativePath) => path.join(root, ...segments(relativePath));

/** The contract pair for one file as it sits inside one root. */
function rootEntry(root, relativePath) {
  const bytes = fs.readFileSync(inRoot(root, relativePath));
  return Object.freeze([relativePath, sha256(bytes)]);
}

/**
 * Synthesise a real ChallengeIdentity over the bytes actually copied into the
 * source root: the inventory is the exact sorted `[relativePath, sha256(bytes)]`
 * list and the workload digest is recomputed with the accepted helper, so the
 * contract validator re-derives the very value that is recorded. This is the
 * same derivation the released exporter suite uses, so both suites bind the same
 * bytes.
 */
function buildIdentity(sourceRoot, paths) {
  const starterInventory = paths
    .map((relativePath) => rootEntry(sourceRoot, relativePath))
    .sort((left, right) => RAW_COMPARE(left[0], right[0]));
  return Object.freeze({
    schemaVersion: '1.0.0',
    kind: 'ChallengeIdentity',
    challengeId: 'c2-t3-fixture-board',
    /* Deliberately unlike the tooling fixture's 0.1.0 and the evaluator fixture's
     * 1.2.0: a fixture whose three version domains happened to agree could not
     * show that they are kept apart. */
    challengeVersion: '0.9.0',
    architectureId: 'arch-c2-t3-fixture',
    architectureKind: 'challenge',
    hashAlgorithm: 'sha256',
    definitionDigest: sha256('c2-t3-fixture:definition'),
    digestProvenance: Object.freeze({ kind: 'COMPUTED', procedure: 'c2-t3-fixture:sha256:source-bytes' }),
    workloadProvenance: Object.freeze({ kind: 'COMPUTED', procedure: 'c2-t3-fixture:starter-inventory-digest' }),
    publicPrdDigest: sha256('c2-t3-fixture:public-prd'),
    visibleHarnessDigest: sha256('c2-t3-fixture:visible-harness'),
    fixtureDigest: sha256('c2-t3-fixture:fixture'),
    starterInventory: Object.freeze(starterInventory),
    workloadDigest: hashEntries(starterInventory),
    declaredCeilingMinutes: 120,
    candidateLineage: Object.freeze({
      candidateVersion: '1.0.0-candidate.9',
      candidateStatus: 'REVIEW_FINDINGS_UNRESOLVED',
      sourceCommit: 'c662a4a1b2c3d4e5f60718293a4b5c6d7e8f90a1',
      sourceTag: 'candidate-nine-synthetic',
      reviewStatus: 'CHANGES_REQUESTED',
      lineageNotes: 'Synthetic lineage carried by the focused fixture, not a certified release.',
    }),
    notes: 'C2 T3 focused fixture identity, derived from the read-only starter bytes.',
  });
}

/**
 * The two identities a run must bind. They come from the accepted contract
 * fixture set — a test inventing its own identity record would be testing its
 * own invention rather than the contract — and they are re-validated here so a
 * fixture drift fails at once instead of surfacing as a deep refusal.
 */
function boundIdentities() {
  const toolingIdentity = structuredClone(loadFixture('tooling.identity'));
  const evaluatorIdentity = structuredClone(loadFixture('evaluator.identity'));
  assert.deepEqual(structuredClone(validateRecord('ToolingIdentity', toolingIdentity)), toolingIdentity,
    'the tooling fixture must satisfy the shipped contract validator before it is used');
  assert.deepEqual(structuredClone(validateRecord('EvaluatorIdentity', evaluatorIdentity)), evaluatorIdentity,
    'the evaluator fixture must satisfy the shipped contract validator before it is used');
  return { toolingIdentity, evaluatorIdentity };
}

/**
 * Build one fixture: fresh contained directories, a seeded source root carrying
 * the accepted starter bytes, populated private owner and evaluator roots, and a
 * package built from the identity derived over those bytes. The output parent
 * exists so the container it holds can be reserved; the container itself never
 * does.
 */
function buildFixture(t, name, options = {}) {
  const paths = releaseParticipantPaths();
  const root = scratch(t, name);
  const sourceRoot = path.join(root, 'source');
  const ownerRoot = path.join(root, 'owner');
  const evaluatorRoot = path.join(root, 'evaluator');
  const outputParent = path.join(root, 'publish');
  fs.mkdirSync(ownerRoot, { recursive: true });
  fs.writeFileSync(path.join(ownerRoot, 'owner-secret.txt'), 'owner-private-material\n', 'utf8');
  fs.mkdirSync(evaluatorRoot, { recursive: true });
  fs.writeFileSync(path.join(evaluatorRoot, 'hidden-tests.txt'), 'hidden-evaluator-material\n', 'utf8');
  fs.mkdirSync(outputParent, { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  for (const relativePath of paths)
    copyFile(starterPath(relativePath), inRoot(sourceRoot, relativePath));

  const identity = buildIdentity(sourceRoot, paths);
  assert.deepEqual(
    validateRecord('ChallengeIdentity', structuredClone(identity)),
    structuredClone(identity),
    'the fixture identity must satisfy the shipped contract validator before it is used',
  );

  const { toolingIdentity, evaluatorIdentity } = boundIdentities();
  return {
    root,
    paths,
    identity,
    sourceRoot,
    ownerRoot,
    evaluatorRoot,
    outputParent,
    toolingIdentity,
    evaluatorIdentity,
  };
}

/** The package for a fixture, with explicit overrides applied key by key. */
function packageFor(fixture, overrides = {}) {
  const pick = (key, fallback) => (key in overrides ? overrides[key] : fallback);
  return {
    identity: pick('identity', fixture.identity),
    sourceRoot: pick('sourceRoot', fixture.sourceRoot),
    fileManifest: pick('fileManifest', [...fixture.paths]),
    ownerRoots: pick('ownerRoots', [fixture.ownerRoot]),
    evaluatorRoots: pick('evaluatorRoots', [fixture.evaluatorRoot]),
    ...(overrides.packageExtra ?? {}),
  };
}

/**
 * One request from a fixture. Every field the API requires is stated here, so a
 * test that changes one field is changing only that field; nothing is defaulted
 * by the module under test from the machine it runs on.
 */
const REQUEST_CORE_KEYS = Object.freeze([
  'output', 'challenge', 'dependencies', 'toolingIdentity', 'evaluatorIdentity', 'architectureId',
]);

function requestFor(fixture, overrides = {}) {
  const pick = (key, fallback) => (key in overrides ? overrides[key] : fallback);
  /* Any key that is not one of the six structural fields is a stated run fact,
   * whether the call site wrote it at the top level or nested it under `rest`: a
   * test that states `harness: "custom"` and a test that states it under `rest`
   * mean the same thing here, and neither form is silently dropped. A `rest` key
   * is never itself part of the request; its contents always are. */
  const spread = (collected, [key, value]) => Object.assign(collected, { [key]: value });
  const stated = Object.entries(overrides)
    .filter(([key]) => !REQUEST_CORE_KEYS.includes(key) && key !== 'rest')
    .reduce(spread, {});
  /* A nested `rest` states the same kind of run fact, so it is merged with the
   * same precedence: a top-level statement wins over a nested one, and no field
   * is dropped according to which of the two spellings a call site used. */
  if (overrides.rest !== void 0)
    Object.entries(overrides.rest).reduce(spread, stated);
  return {
    output: pick('output', path.join(fixture.outputParent, 'container')),
    challenge: pick('challenge', packageFor(fixture)),
    dependencies: pick('dependencies', { mode: 'none' }),
    toolingIdentity: pick('toolingIdentity', fixture.toolingIdentity),
    evaluatorIdentity: pick('evaluatorIdentity', fixture.evaluatorIdentity),
    architectureId: pick('architectureId', 'arch-run-c2-t3'),
    ...stated,
  };
}

/** One API call from a fixture, with request overrides applied. */
function initialise(fixture, overrides = {}) {
  return initialiseRun(requestFor(fixture, overrides));
}

/**
 * Build one verified dependency cache: a plain `node_modules` tree plus the
 * provenance marker the accepted helper requires, whose lock and manifest
 * digests are computed over the fixture source bytes so the cache is honestly
 * described rather than faked.
 */
function buildDependencyCache(fixture, name = 'cache') {
  const cacheRoot = path.join(fixture.root, name);
  const preparedRoot = path.join(cacheRoot, 'node_modules');
  const packageRoot = path.join(preparedRoot, 'synthetic-dep');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"synthetic-dep"}\n', 'utf8');
  fs.writeFileSync(path.join(preparedRoot, DEPENDENCIES_METADATA_FILE_NAME), `${JSON.stringify({
    schemaVersion: '1.0.0',
    module: 'benchboard.core.dependencies',
    hashAlgorithmId: DEPENDENCY_HASH_ALGORITHM_ID,
    mode: 'prepared',
    provenance: {
      lockfileName: 'package-lock.json',
      manifestFileName: 'package.json',
      lockDigest: sha256(fs.readFileSync(path.join(fixture.sourceRoot, 'package-lock.json'))),
      manifestDigest: sha256(fs.readFileSync(path.join(fixture.sourceRoot, 'package.json'))),
    },
  }, null, 2)}\n`, 'utf8');
  return { cacheRoot, preparedRoot };
}

/**
 * Strip the comments out of a module, so a boundary check tests the code rather
 * than the prose that describes what the code is not. Block comments and lines
 * whose first token is a comment marker go; string literals stay, because a
 * refused option name is real code.
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .join('\n');
}

/** The path of one file inside a published container. */
const inContainer = (container, ...parts) => path.join(container, ...parts);

/**
 * What a call left behind in the output parent. The output parent starts empty
 * and holds nothing but containers, so an empty list is the proof that a failed
 * transaction undid itself completely, and any other list is the residue.
 */
const publishResidue = (fixture) => fs.readdirSync(fixture.outputParent).sort(RAW_COMPARE);

/* =========================================================================== API */

test('a mode-none run publishes the container it declared, at the roots it declared', async (t) => {
  const fixture = buildFixture(t, 'happy-none');
  const output = inContainer(fixture.outputParent, 'container');

  const result = await initialise(fixture, { output });

  /* The container layout is the contract: one workspace, one sibling state root. */
  assert.equal(result.output, output, 'the result names the requested output root');
  assert.equal(result.workspace.root, path.join(output, WORKSPACE_DIRECTORY_NAME),
    `the workspace is <output>/${WORKSPACE_DIRECTORY_NAME}`);
  assert.equal(result.state.root, path.join(output, STATE_DIRECTORY_NAME),
    `the state root is <output>/${STATE_DIRECTORY_NAME}`);
  assert.ok(fs.existsSync(result.workspace.root), 'the workspace exists on disk');
  assert.ok(fs.existsSync(result.state.root), 'the state root exists on disk');
  assert.ok(fs.lstatSync(output).isDirectory(), 'the container itself is a real directory');

  /* The three state records are where the module says they are. */
  for (const relativePath of [RUN_STATE_RELATIVE_PATH, DEPENDENCY_STATE_RELATIVE_PATH, EXPORT_STATE_RELATIVE_PATH])
    assert.ok(fs.existsSync(inContainer(result.state.root, ...segments(relativePath))),
      `the state record ${relativePath} was published`);

  assert.equal(result.manifest.participantWorkspaceRoot, result.workspace.root,
    'the manifest names the final workspace root, not a staging path');
  assert.equal(result.manifest.evidenceRoot, result.state.root,
    'the manifest names the final state root, not a staging path');
  assert.ok(HEX64.test(result.manifest.manifestDigest), 'the sealed manifest carries its own digest');
  assert.equal(result.state.runRecordDigest !== result.manifest.manifestDigest, true,
    'the storage record digest and the manifest self digest are different digests of different things');
});

test('the initialiser publishes exactly the twenty-six workload files and no foreign material', async (t) => {
  const fixture = buildFixture(t, 'workload-26');
  const result = await initialise(fixture);

  assert.equal(EXPECTED_WORKLOAD_FILE_COUNT, 26, 'the released exporter still declares twenty-six workload files');
  assert.equal(result.workload.fileCount, 26, 'the workload file count is twenty-six');
  assert.equal(result.workspace.fileCount, 26, 'the published workspace is counted at twenty-six files');

  const workspaceFiles = Object.entries(snapshotTree(result.workspace.root))
    .filter(([, kind]) => kind.startsWith('file:'))
    .map(([relativePath]) => relativePath)
    .sort(RAW_COMPARE);
  assert.deepEqual(workspaceFiles, [...fixture.paths].sort(RAW_COMPARE),
    'the published files are exactly the declared participant paths');
  assert.equal(workspaceFiles.length, 26, 'no extra file reached the workspace');

  /* Private, state and version material has no route into a participant root. */
  const violations = workspaceFiles.filter((relativePath) => /(^|\/)(\.git|\.benchboard|node_modules)(\/|$)/
    .test(relativePath) || relativePath.startsWith('.benchboard-export-'));
  assert.deepEqual(violations, [], 'no state, version-control or dependency path is part of the workload');
  assert.equal(fs.existsSync(inContainer(result.output, 'state')), false,
    'state is not a directory inside the container root either');

  /* The fixture's own private roots were the only private material around. */
  assert.match(snapshotTree(fixture.ownerRoot)['owner-secret.txt'], /^file:/, 'the owner root is untouched');
  assert.match(snapshotTree(fixture.evaluatorRoot)['hidden-tests.txt'], /^file:/, 'the evaluator root is untouched');
});

test('the state root sits beside the workspace, never inside the participant workspace', async (t) => {
  const fixture = buildFixture(t, 'state-outside');
  const result = await initialise(fixture);

  assert.equal(result.state.insideWorkspace, false, 'the result states that state is not inside the workspace');
  const workspaceKey = path.resolve(result.workspace.root).replaceAll('\\', '/').toLowerCase();
  const stateKey = path.resolve(result.state.root).replaceAll('\\', '/').toLowerCase();
  assert.equal(stateKey.startsWith(`${workspaceKey}/`), false, 'the state root is not under the workspace root');
  /* Both sides are normalised to the same separator before they are compared: the
   * point of the assertion is the parent relationship, not which separator this
   * host happens to print. */
  assert.equal(path.dirname(result.state.root).replaceAll('\\', '/'),
    path.resolve(result.output).replaceAll('\\', '/'),
    'the state root is a direct child of the container, as a sibling of the workspace');

  const workspaceEntries = fs.readdirSync(result.workspace.root).sort(RAW_COMPARE);
  assert.equal(workspaceEntries.includes(STATE_DIRECTORY_NAME), false,
    'the participant workspace holds no state root of its own');

  const published = fs.readdirSync(result.state.root).sort(RAW_COMPARE);
  assert.ok(published.includes('state'), `the state root holds its state records: ${published.join(', ')}`);
});

test('the workload hash and the dependency hash are two domains that never meet', async (t) => {
  const fixture = buildFixture(t, 'two-domains');
  const { preparedRoot } = buildDependencyCache(fixture);

  const noneResult = await initialise(fixture, {
    output: inContainer(fixture.outputParent, 'none'),
    dependencies: { mode: 'none' },
  });
  const preparedResult = await initialise(fixture, {
    output: inContainer(fixture.outputParent, 'prepared'),
    dependencies: { mode: 'prepared', preparedRoot, sourceRoot: fixture.sourceRoot },
  });

  assert.equal(noneResult.workload.algorithmId, WORKLOAD_HASH_ALGORITHM_ID,
    'the workload digest is named by the workload algorithm identifier');
  assert.equal(noneResult.dependency.algorithmId, DEPENDENCY_HASH_ALGORITHM_ID,
    'the dependency digest is named by the dependency algorithm identifier');
  assert.notEqual(WORKLOAD_HASH_ALGORITHM_ID, DEPENDENCY_HASH_ALGORITHM_ID,
    'the two domain names are different strings');

  assert.equal(noneResult.dependency.digest, null, 'mode none reports no dependency digest');
  assert.ok(HEX64.test(preparedResult.dependency.digest), 'mode prepared reports a dependency digest');
  assert.notEqual(preparedResult.dependency.digest, preparedResult.workload.digest,
    'a dependency digest never equals the workload digest');

  /* The workload digest of both runs is the identity's, so the dependency tree
   * did not bend it: a shared domain would show up right here. */
  assert.equal(preparedResult.workload.digest, fixture.identity.workloadDigest,
    'the workload digest is the identity workload digest even with dependencies present');
  assert.equal(noneResult.workload.digest, preparedResult.workload.digest,
    'adding dependencies does not change the workload digest');
});

test('the run never versions a challenge: challenge version and tooling version stay where they belong', async (t) => {
  const fixture = buildFixture(t, 'no-version-conflation');
  const result = await initialise(fixture);

  /* The initialiser mints a run, not a software release: it has no version of
   * its own to record and must not borrow one from a bound identity. The bound
   * identities travel inside the manifest's binding envelopes — the accepted C1
   * record has no root challenge or tooling identity field — so the version
   * domains are read from where the contract actually carries them. */
  const bound = structuredClone(result.manifest.bindings);
  assert.equal('version' in result.manifest, false, 'the run manifest carries no version field of its own');
  assert.equal(bound.challenge.challengeVersion, fixture.identity.challengeVersion,
    'the challenge version travels inside the challenge binding and nowhere else');
  assert.equal(bound.tooling.toolingVersion, fixture.toolingIdentity.toolingVersion,
    'the tooling version travels inside the tooling binding and nowhere else');
  assert.notEqual(bound.challenge.challengeVersion, bound.tooling.toolingVersion,
    'the fixture keeps the two version domains observably apart');
  assert.notEqual(bound.challenge.challengeId, bound.tooling.toolingId,
    'the challenge identity and the tooling identity are different domains');
  assert.notEqual(result.manifest.runId, bound.challenge.challengeId,
    'the run id is not the challenge id');
});

test('an unstated run fact is recorded as unknown, never as zero and never as a guess', async (t) => {
  const fixture = buildFixture(t, 'unknown-is-null');
  const result = await initialise(fixture);
  const configuration = result.manifest.configuration;

  assert.ok(configuration !== void 0 && configuration !== null, 'a configuration record exists to describe the unknown');
  /* The accepted contract records an unstated scalar by leaving it out and naming
   * it in `unknownFields`; it never fills one in with a plausible value. Absent
   * and explicit null are both "nobody said", and neither is ever a zero. */
  for (const key of ['model', 'location', 'os', 'nodeVersion']) {
    assert.ok(!(key in configuration) || configuration[key] === null,
      `configuration.${key} is absent or null, because nobody stated it`);
    assert.notEqual(configuration[key], 0, `configuration.${key} is not zero`);
    assert.notEqual(configuration[key], '', `configuration.${key} is not an empty string`);
    assert.ok(configuration.unknownFields.includes(key), `configuration.unknownFields names ${key}`);
  }
  assert.equal(configuration.unknown, 'UNKNOWN', 'the configuration record says it is unknown');
  assert.equal(result.dependency.digest, null, 'an absent dependency digest is null, not zero');
  assert.equal(result.manifest.securityModel, 'UNSPECIFIED',
    'no security model is inferred; the default names itself as unspecified');
  assert.equal(result.manifest.harness, 'UNKNOWN', 'no harness is inferred from the machine that runs this');
});

test('stated run facts are carried verbatim, and an unrecognised field is refused', async (t) => {
  const fixture = buildFixture(t, 'stated-facts');
  const createdAt = '2026-10-08T12:34:56.000Z';
  const result = await initialise(fixture, {
    harness: 'synthetic-harness',
    securityModel: 'OS_CONTAINED_WORKSPACE',
    declaredCeilingMinutes: 90,
    architectureKind: 'run',
    notes: 'a stated note',
    createdAt,
    /* The accepted contract carries runtime flags as a map of name to stated
     * value, not as a bare list, so the fixture states them the way the record
     * stores them. */
    configuration: { model: null, runtimeFlags: { synthetic: 'true' } },
    expectedSessionPolicy: { network: 'denied' },
    rest: {},
  });

  assert.equal(result.manifest.harness, 'synthetic-harness', 'a stated harness is carried');
  assert.equal(result.manifest.securityModel, 'OS_CONTAINED_WORKSPACE', 'a stated security model is carried');
  assert.equal(result.manifest.declaredCeilingMinutes, 90, 'a stated ceiling is carried');
  assert.equal(result.manifest.architectureKind, 'run', 'a stated architecture kind is carried');
  assert.equal(result.manifest.notes, 'a stated note', 'a stated note is carried');
  assert.equal(result.manifest.createdAt, createdAt, 'an explicit timestamp is observed as stated');
  assert.deepEqual(structuredClone(result.manifest.configuration.runtimeFlags), { synthetic: 'true' },
    'stated runtime flags are carried as they were stated');
  assert.equal(result.manifest.expectedSessionPolicy?.network, 'denied', 'a stated session policy is carried');
  assert.ok(INIT_SECURITY_MODELS.includes('OS_CONTAINED_WORKSPACE'),
    'a stated model was accepted because the accepted contract list carries it');
  assert.equal(INIT_SECURITY_MODELS.includes('LOCAL_ISOLATED'), false,
    'a model the contract does not define is not accepted by the seam');

  const overCeiling = await expectCode(initialise(fixture, {
    output: inContainer(fixture.outputParent, 'over'),
    declaredCeilingMinutes: 999,
    rest: {},
  }), INIT_ERROR_CODES.CEILING_EXCEEDED, 'a ceiling above the challenge ceiling');
  assert.match(overCeiling.message, /120/, 'the refusal names the ceiling the challenge binds');

  await expectCode(initialise(fixture, {
    output: inContainer(fixture.outputParent, 'unknown-key'),
    rest: { configuration: { workerCount: 4 } },
  }), INIT_ERROR_CODES.INVALID_OPTION, 'a configuration field outside the accepted record');

  await expectCode(initialise(fixture, {
    output: inContainer(fixture.outputParent, 'unknown-root-key'),
    rest: { participantRoot: 'C:/somewhere' },
  }), INIT_ERROR_CODES.INVALID_OPTION, 'a request field the contract does not name');
});

test('dependency mode none performs no filesystem work beyond the run itself', async (t) => {
  const fixture = buildFixture(t, 'mode-none-pure');
  const before = snapshotTree(fixture.root);
  const result = await initialise(fixture, {
    output: inContainer(fixture.outputParent, 'container'),
    dependencies: { mode: 'none' },
  });

  assert.equal(result.dependency.mode, 'none', 'mode none is reported back as none');
  assert.equal(result.dependency.digest, null, 'mode none reports no dependency digest');

  const after = snapshotTree(fixture.root);
  /* The container the run published is itself the expected addition, and a tree
   * snapshot records a directory under its own key as well as under its
   * children, so the container is excluded by name as well as by prefix. Anything
   * else that appeared would be work outside the container. */
  const containerKey = path.relative(fixture.root, inContainer(fixture.outputParent, 'container'))
    .split(path.sep).join('/');
  const outsideContainer = Object.keys(after)
    .filter((key) => !(key in before))
    .filter((key) => key !== containerKey && !key.startsWith(`${containerKey}/`))
    .sort(RAW_COMPARE);
  assert.deepEqual(outsideContainer, [], 'mode none wrote nothing outside the container');
  assert.deepEqual(fs.readdirSync(fixture.sourceRoot).sort(RAW_COMPARE),
    [...releaseParticipantPaths()].sort(RAW_COMPARE).map((p) => p.split('/')[0])
      .filter((value, index, all) => all.indexOf(value) === index),
    'the source root still holds exactly its own top-level entries');
});

test('dependency mode prepared stages the tree inside the workspace and its identity outside it', async (t) => {
  const fixture = buildFixture(t, 'mode-prepared');
  const { preparedRoot } = buildDependencyCache(fixture);
  const output = inContainer(fixture.outputParent, 'container');

  const result = await initialise(fixture, {
    output,
    dependencies: { mode: 'prepared', preparedRoot, sourceRoot: fixture.sourceRoot },
  });

  assert.equal(result.dependency.mode, 'prepared', 'the declared mode is the mode that ran');

  /* The dependency tree itself belongs with the workspace: a participant needs
   * it on its module resolution path. */
  const nodeModules = path.join(result.workspace.root, 'node_modules');
  assert.ok(fs.existsSync(nodeModules), 'the dependency tree was staged into the workspace');
  assert.ok(fs.existsSync(path.join(nodeModules, 'synthetic-dep', 'package.json')),
    'the declared package is present in the workspace tree');

  /* Its identity and its metadata record are evidence, so they live in the
   * state root: a participant must neither read nor be able to rewrite them. The
   * path is reported relative to the state root, so it is a plain downward path
   * with no parent step in it; what puts it outside the participant workspace is
   * that the state root itself is a sibling of the workspace. */
  const statedMetadata = result.state.dependencyMetadata;
  const metadataPath = inContainer(result.state.root, ...segments(statedMetadata));
  assert.equal(statedMetadata.startsWith('../'), false,
    'the metadata path steps no way out of the state root it is stated against');
  assert.equal(segments(statedMetadata).includes('..'), false,
    'no parent step is hidden in the middle of the path either');
  assert.equal(path.resolve(metadataPath).startsWith(path.resolve(result.state.root) + path.sep), true,
    'the metadata record resolves inside the state root');
  assert.equal(path.resolve(metadataPath).startsWith(path.resolve(result.workspace.root) + path.sep), false,
    'the metadata record resolves outside the participant workspace');
  assert.ok(fs.existsSync(metadataPath), `the dependency metadata record exists at ${statedMetadata}`);
  assert.equal(fs.existsSync(path.join(result.workspace.root, DEPENDENCIES_METADATA_FILE_NAME)), false,
    'no dependency metadata record was written into the workspace root');

  /* The companion is a separate immutable record with its own digest, so the
   * C1 manifest keeps exactly its own fields. */
  const companionPath = inContainer(result.state.root, ...segments(DEPENDENCY_STATE_RELATIVE_PATH));
  assert.ok(fs.existsSync(companionPath), 'the dependency companion record exists');
  assert.ok(HEX64.test(result.state.dependencyRecordDigest), 'the companion carries its own record digest');
  assert.notEqual(result.state.dependencyRecordDigest, result.state.runRecordDigest,
    'the companion and the run record are separately hashed records');
  const companion = JSON.parse(fs.readFileSync(companionPath, 'utf8'));
  const companionValue = companion.value ?? companion;
  assert.equal(companionValue.mode ?? companionValue.metadata?.mode, 'prepared',
    'the companion records the mode that ran');
  /* The sealed record identifies itself by the kind the accepted contract names
   * and by the digest sealed inside it; a wrapper of this module's own invention
   * would be a second, unschematised shape, so none is expected here. */
  assert.equal(result.manifest.kind, 'RunManifest',
    'the manifest is the sealed C1 record, unchanged in kind');
  assert.ok(HEX64.test(result.manifest.manifestDigest),
    'the manifest still carries the digest sealed inside it');
  assert.equal('value' in result.manifest, false, 'no storage envelope field leaked into the record');

  /* The workload stayed the workload: dependency material is ordinary files
   * under node_modules, not extra workload entries. */
  assert.equal(result.workload.fileCount, 26, 'the workload count is still twenty-six');
  assert.equal(result.workload.digest, fixture.identity.workloadDigest,
    'the workload digest is still the identity workload digest');

  /* The declared cache was read, not consumed. */
  assert.ok(fs.existsSync(path.join(preparedRoot, 'synthetic-dep', 'package.json')),
    'the declared cache still holds its package');
});

test('a dependency digest the caller expected is enforced before the run is recorded', async (t) => {
  const fixture = buildFixture(t, 'expected-digest');
  const { preparedRoot } = buildDependencyCache(fixture);
  const ok = await initialise(fixture, {
    output: inContainer(fixture.outputParent, 'ok'),
    dependencies: { mode: 'prepared', preparedRoot, sourceRoot: fixture.sourceRoot },
  });

  const wrong = '0'.repeat(64);
  assert.notEqual(ok.dependency.digest, wrong, 'the fixture digest and the wrong one really differ');
  /* The expectation is checked by the accepted dependency helper, which owns the
   * dependency digest domain and refuses with its own error type and its own
   * code. The initialiser deliberately does not dress that refusal up as one of
   * its own codes: a caller sees the dependency layer's own verdict, so this test
   * asserts the code that is actually raised rather than the seam's name for it. */
  /* The accepted helper freezes the details pair it was built with under a
   * `details` field, so the expected and actual digests are read from there and
   * not from the error object itself. */
  const expectedKey = 'details';
  const error = await rejection(initialise(fixture, {
    output: inContainer(fixture.outputParent, 'mismatch'),
    dependencies: { mode: 'prepared', preparedRoot, sourceRoot: fixture.sourceRoot, expectedDependencyDigest: wrong },
  }));
  assert.ok(error !== void 0, 'an expected dependency digest that does not match is refused');
  assert.equal(error.constructor.name, 'DependencyError', `the dependency layer's own error type is reported, got ${error?.constructor?.name}`);
  assert.equal(error.code, 'DEPENDENCY_DIGEST_MISMATCH', `the dependency layer reports its own code (${error?.message})`);
  assert.equal(error[expectedKey]?.expected, wrong, 'the refusal names what the caller expected');
  assert.equal(error[expectedKey]?.actual, ok.dependency.digest, 'and the digest the cache really carries');
  assert.equal(fs.existsSync(inContainer(fixture.outputParent, 'mismatch')), false,
    'the container of the refused run was taken down again');
});

test('dependency options that contradict their mode are refused before any work', async (t) => {
  const fixture = buildFixture(t, 'mode-gates');

  await expectCode(initialise(fixture, {
    output: inContainer(fixture.outputParent, 'a'),
    dependencies: { mode: 'sideload' },
  }), INIT_ERROR_CODES.DEPENDENCY_MODE_INVALID, 'a mode outside the three declared modes');

  await expectCode(initialise(fixture, {
    output: inContainer(fixture.outputParent, 'b'),
    dependencies: { mode: 'none', preparedRoot: fixture.sourceRoot },
  }), INIT_ERROR_CODES.DEPENDENCY_MODE_MISMATCH, 'a cache root named for mode none');

  await expectCode(initialise(fixture, {
    output: inContainer(fixture.outputParent, 'c'),
    dependencies: { mode: 'prepared' },
  }), INIT_ERROR_CODES.DEPENDENCY_MODE_MISMATCH, 'mode prepared with no cache root');

  await expectCode(initialise(fixture, {
    output: inContainer(fixture.outputParent, 'd'),
    dependencies: { mode: 'install' },
  }), INIT_ERROR_CODES.DEPENDENCY_MODE_MISMATCH, 'mode install with no npm executable');

  const modeKeyError = await expectCode(initialise(fixture, {
    output: inContainer(fixture.outputParent, 'e'),
    dependencies: { mode: 'none', cacheRoot: 'C:/somewhere' },
  }), INIT_ERROR_CODES.INVALID_OPTION, 'a dependency field the interface does not name');
  assert.match(modeKeyError.message, /cacheRoot/, 'the refusal names the unknown field');
  assert.equal(fs.existsSync(inContainer(fixture.outputParent, 'a')), false, 'nothing was created');
  assert.deepEqual(DEPENDENCY_MODES, ['none', 'prepared', 'install'], 'the declared mode list is the contract');
});

test('an existing destination is never reused, emptied or overwritten', async (t) => {
  const fixture = buildFixture(t, 'existing-destination');
  const output = inContainer(fixture.outputParent, 'occupied');
  fs.mkdirSync(inContainer(output, 'keep-me'), { recursive: true });
  fs.writeFileSync(inContainer(output, 'keep-me', 'foreign.txt'), 'foreign-byte\n', 'utf8');
  const canaryBefore = snapshotTree(output);

  const error = await expectCode(initialise(fixture, { output }), INIT_ERROR_CODES.OUTPUT_EXISTS,
    'an output root that already exists');
  assert.equal(error.path, output, 'the refusal names the output it refused to touch');
  assert.deepEqual(snapshotTree(output), canaryBefore, 'the existing tree is byte-for-byte what it was');

  /* The same refusal holds for a plain file standing in the way. */
  const blocked = path.join(fixture.outputParent, 'a-file');
  fs.writeFileSync(blocked, 'not-a-directory\n', 'utf8');
  await expectCode(initialise(fixture, { output: blocked }), INIT_ERROR_CODES.OUTPUT_EXISTS,
    'an output root that is a plain file');
});

test('the output parent is never invented, and the reason says so', async (t) => {
  const fixture = buildFixture(t, 'missing-parent');
  const missing = path.join(fixture.outputParent, 'no-such-parent', 'container');

  const error = await expectCode(initialise(fixture, { output: missing }), INIT_ERROR_CODES.OUTPUT_UNUSABLE,
    'an output whose parent does not exist');
  assert.match(error.message, /does not exist/, 'the refusal states that the parent does not exist');
  assert.equal(fs.existsSync(path.join(fixture.outputParent, 'no-such-parent')), false,
    'no parent directory was created on the caller\'s behalf');
});

test('a destination that touches a protected root is refused and the roots stay intact', async (t) => {
  const fixture = buildFixture(t, 'protected-roots');
  const ownerBefore = snapshotTree(fixture.ownerRoot);
  const evaluatorBefore = snapshotTree(fixture.evaluatorRoot);
  const sourceBefore = snapshotTree(fixture.sourceRoot);

  const overlaps = [
    ['the source root itself', fixture.sourceRoot],
    ['inside the source root', path.join(fixture.sourceRoot, 'container')],
    ['the owner root itself', fixture.ownerRoot],
    ['inside the owner root', path.join(fixture.ownerRoot, 'container')],
    ['the evaluator root itself', fixture.evaluatorRoot],
    ['inside the evaluator root', path.join(fixture.evaluatorRoot, 'container')],
  ];
  for (const [label, output] of overlaps) {
    const error = await expectCode(initialise(fixture, { output }), INIT_ERROR_CODES.ROOTS_OVERLAP,
      `an output that is ${label}`);
    assert.equal(typeof error.path, 'string', 'the refusal names the offending path');
  }

  /* An ancestor of a protected root is refused too: publishing there would put
   * the container around the private tree rather than beside it, which is the
   * same containment the rule exists to stop. The fixture root is a real ancestor
   * of the source, owner and evaluator roots. */
  const ancestor = await expectCode(initialise(fixture, { output: fixture.root }),
    INIT_ERROR_CODES.ROOTS_OVERLAP, 'a destination that encloses a protected root');
  assert.equal(typeof ancestor.path, 'string', 'the refusal names the offending path');
  assert.match(ancestor.message, /disjoint|contain/i, 'the refusal says what is wrong with the overlap');

  assert.deepEqual(snapshotTree(fixture.ownerRoot), ownerBefore, 'the owner root was not written to');
  assert.deepEqual(snapshotTree(fixture.evaluatorRoot), evaluatorBefore, 'the evaluator root was not written to');
  assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore, 'the source root was not written to');
});

test('a destination whose only difference from a protected root is case is refused', async (t) => {
  const fixture = buildFixture(t, 'case-collision');
  const fold = (value) => value.replaceAll('\\', '/').toLowerCase();
  const output = path.join(fixture.root, 'Owner');

  /* A case-insensitive host would treat that as the owner root; a case-sensitive
   * host would not collide at all. The assertion is therefore written to follow
   * the host, and states which of the two it observed. */
  const error = await rejection(initialise(fixture, { output }));
  const collides = fold(fixture.ownerRoot) === fold(output);
  if (collides) {
    assert.ok(error instanceof InitError, `a case-identical root must be refused, got ${error?.name}`);
    assert.equal(error.code, INIT_ERROR_CODES.ROOTS_OVERLAP,
      `the case collision is reported as an overlap: ${error?.message}`);
  } else {
    assert.ok(error === void 0 || error.code !== INIT_ERROR_CODES.ROOTS_OVERLAP,
      'on a case-sensitive host the roots are genuinely different');
  }
});

test('identities and architecture domains stay separate: a collision is refused', async (t) => {
  const fixture = buildFixture(t, 'identity-collisions');

  /* A run that claims a bound architecture would let one record stand in for two
   * identity domains. */
  for (const [label, architectureId] of [
    ['the challenge architecture', fixture.identity.architectureId],
    ['the tooling architecture', fixture.toolingIdentity.architectureId],
    ['the evaluator architecture', fixture.evaluatorIdentity.architectureId],
  ]) {
    const error = await expectCode(initialise(fixture, {
      output: inContainer(fixture.outputParent, `collide-${label.split(' ')[0]}`),
      architectureId,
    }), INIT_ERROR_CODES.IDENTITY_COLLISION, `a run architecture equal to ${label}`);
    assert.match(error.message, new RegExp(`^${INIT_ERROR_CODES.IDENTITY_COLLISION}: `), 'the code leads');
  }

  /* Two identity domains sharing one identifier is the same conflation. */
  const twinTooling = { ...fixture.toolingIdentity, toolingId: fixture.identity.challengeId };
  await expectCode(initialise(fixture, {
    output: inContainer(fixture.outputParent, 'twin'),
    toolingIdentity: twinTooling,
  }), INIT_ERROR_CODES.IDENTITY_COLLISION, 'a tooling id that is the challenge id');

  await expectCode(initialise(fixture, {
    output: inContainer(fixture.outputParent, 'short'),
    architectureId: 'ab',
  }), INIT_ERROR_CODES.INVALID_OPTION, 'an architecture id shorter than the contract');

  assert.equal(fs.readdirSync(fixture.outputParent).sort(RAW_COMPARE).length, 0,
    'not one container was created by the refusals');
});

test('a malformed identity is refused by the accepted validator before any byte is written', async (t) => {
  const fixture = buildFixture(t, 'identity-validation');

  const brokenTooling = { ...fixture.toolingIdentity, digestProvenance: { kind: 'GUESSED' } };
  const error = await expectCode(initialise(fixture, {
    output: inContainer(fixture.outputParent, 'broken'),
    toolingIdentity: brokenTooling,
  }), INIT_ERROR_CODES.IDENTITY_INVALID, 'an identity the contract validator refuses');
  assert.equal(error.identityKind, 'ToolingIdentity', 'the refusal names which identity kind was refused');

  await expectCode(initialise(fixture, {
    output: inContainer(fixture.outputParent, 'broken-challenge'),
    challenge: packageFor(fixture, { identity: { ...fixture.identity, hashAlgorithm: 'md5' } }),
  }), INIT_ERROR_CODES.IDENTITY_INVALID, 'a challenge identity the contract validator refuses');

  assert.equal(fs.readdirSync(fixture.outputParent).sort(RAW_COMPARE).length, 0, 'nothing was created');
});

test('a request that is not the contract request is refused, with no side effect', async (t) => {
  const fixture = buildFixture(t, 'request-gates');

  /* These three carry no fixture at all: the point is that the API refuses a
   * request that is not an object before it touches any path, so they go to the
   * API directly instead of through the fixture wrapper, which always states an
   * output path. */
  await expectCode(initialiseRun(null), INIT_ERROR_CODES.INVALID_ARGUMENT, 'no request at all');
  await expectCode(initialiseRun([]), INIT_ERROR_CODES.INVALID_ARGUMENT, 'an array instead of a request');
  /* An empty object is an object, so it clears the shape gate and the unknown-key
   * gate — it names no key that the contract does not allow — and then meets the
   * very next gate, which is that the output root must be stated as an absolute
   * host path. Either gate refuses it, both without touching a path, and the
   * second one is what a caller actually sees. */
  await expectCode(initialiseRun({}), INIT_ERROR_CODES.INVALID_ROOT, 'an empty request');

  await expectCode(initialise(fixture, {
    output: 'relative/container',
  }), INIT_ERROR_CODES.INVALID_ROOT, 'a relative output root');
  await expectCode(initialise(fixture, {
    output: inContainer(fixture.outputParent, 'x'),
    challenge: packageFor(fixture, { sourceRoot: 'source' }),
  }), INIT_ERROR_CODES.INVALID_ROOT, 'a relative source root');

  assert.equal(fs.readdirSync(fixture.outputParent).sort(RAW_COMPARE).length, 0,
    'the gates ran before anything could be created');
});

/* ==================================================================== rollback */

test('a fault between the workspace and the state leaves neither container nor residue', async (t) => {
  const fixture = buildFixture(t, 'fault-between-stages');
  const output = inContainer(fixture.outputParent, 'rolled');
  const before = snapshotTree(fixture.outputParent);
  const injected = new Error('injected: interruption between workspace and state');

  const error = await rejection(initialise(fixture, {
    output,
    beforeStatePublication: () => { throw injected; },
    rest: {},
  }));

  assert.equal(error, injected, 'the foreign failure is rethrown rather than dressed up as this module\'s own');
  assert.equal(fs.existsSync(output), false, 'the container this call created is gone again');
  assert.deepEqual(addedEntries(before, snapshotTree(fixture.outputParent)), [], 'nothing was added');
  assert.deepEqual(removedEntries(before, snapshotTree(fixture.outputParent)), [], 'nothing was removed');
  assert.equal(error.initialisationFailed?.code, INIT_ERROR_CODES.INIT_FAILED_ROLLED_BACK,
    'the error discloses that the run was rolled back');
  /* The disclosure names the material it removed rather than merely claiming
   * that something was removed, so a caller can verify the claim itself. Nothing
   * had to be kept, so no cleanup failure is attached. */
  assert.ok(Array.isArray(error.initialisationFailed.removed),
    'the disclosure lists what was removed, as paths');
  assert.deepEqual(error.initialisationFailed.removed, [output],
    'exactly the container this call created was removed');
  assert.deepEqual(error.rolledBackTo?.removed, [output],
    'the rollback disclosure and the failure disclosure agree');
  assert.equal('cleanup' in error, false, 'nothing had to be disclosed instead of destroyed');
});

test('a fault inside the workspace export leaves no container and no staging residue', async (t) => {
  const fixture = buildFixture(t, 'fault-in-export');
  const output = inContainer(fixture.outputParent, 'export-fault');
  const before = snapshotTree(fixture.outputParent);

  const error = await rejection(initialise(fixture, {
    output,
    beforeWorkspacePublication: () => { throw new Error('injected: before the workspace existed'); },
    rest: {},
  }));

  assert.match(String(error?.message), /before the workspace existed/, 'the injected failure is the reported one');
  assert.equal(fs.existsSync(output), false, 'the reserved container was removed');
  assert.deepEqual(addedEntries(before, snapshotTree(fixture.outputParent)), [],
    'no staging directory of any prefix survives the failure');
});

test('a concurrent reservation of the same destination reports one owner and leaves the other intact', async (t) => {
  const fixture = buildFixture(t, 'concurrent-destination');
  const output = inContainer(fixture.outputParent, 'contended');
  const canaryParent = path.join(fixture.outputParent, 'foreign');
  fs.mkdirSync(inContainer(canaryParent, 'keep'), { recursive: true });
  fs.writeFileSync(inContainer(canaryParent, 'keep', 'foreign.txt'), 'foreign-byte\n', 'utf8');
  const canaryBefore = snapshotTree(canaryParent);

  const attempts = await Promise.allSettled([
    initialise(fixture, { output }),
    initialise(fixture, { output }),
  ]);

  const fulfilled = attempts.filter((entry) => entry.status === 'fulfilled');
  const rejected = attempts.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1, `exactly one call may succeed, got ${fulfilled.length}`);
  assert.equal(rejected.length, 1, 'the other call must be refused');
  assert.equal(rejected[0].reason instanceof InitError, true, 'the loser reports the module\'s own error type');
  assert.equal(rejected[0].reason.code, INIT_ERROR_CODES.OUTPUT_EXISTS,
    `the loser reports that the destination exists, got ${rejected[0].reason?.code}`);

  /* The winner's container is complete, and the concurrent foreign tree beside
   * it was never entered. */
  assert.equal(fs.existsSync(path.join(fulfilled[0].value.workspace.root, 'README.md')), true,
    'the winning container is published');
  assert.deepEqual(snapshotTree(canaryParent), canaryBefore, 'the foreign canary tree is untouched');
});

test('rollback removes only material this call created; what it cannot remove is disclosed', async (t) => {
  const fixture = buildFixture(t, 'cleanup-disclosure');
  const output = inContainer(fixture.outputParent, 'stubborn');
  const injected = new Error('injected: after the container existed');
  /* The module rolls a container back through the asynchronous removal the
   * promise filesystem API offers, so the fault is arranged against that call.
   * Only the container path is refused; every other removal still works, so the
   * fixture's own teardown is unaffected. */
  const realRm = fs.promises.rm;

  fs.promises.rm = async (target, options) => {
    if (path.resolve(String(target)) === path.resolve(output))
      throw Object.assign(new Error(`injected: EBUSY on ${target}`), { code: 'EBUSY' });
    return realRm(target, options);
  };
  t.after(() => { fs.promises.rm = realRm; });

  const error = await rejection(initialise(fixture, {
    output,
    beforeStatePublication: () => { throw injected; },
    rest: {},
  }));

  assert.equal(error, injected, 'the original failure keeps its own identity');
  assert.ok(error.cleanup instanceof InitError, 'the residue is attached to the original failure');
  assert.equal(error.cleanup.code, INIT_ERROR_CODES.CLEANUP_FAILED, 'the residue is reported as cleanup failure');
  assert.match(error.cleanup.message, /stubborn/, 'the disclosure names what it could not remove');
  assert.equal('kept' in error.cleanup, true, 'the residue is listed with the reason it was kept');
  assert.deepEqual(error.cleanup.kept.map((entry) => entry.path), [output],
    'exactly the container that could not be removed is disclosed');
  assert.equal(error.initialisationFailed?.removed.length, 0,
    'nothing is disclosed as removed when the removal failed');
  assert.ok(fs.existsSync(output), 'the material that could not be removed was left in place, not forced');
});

/* =================================================================== immutabil */

test('a published state record is immutable and is read back through the storage contract', async (t) => {
  const fixture = buildFixture(t, 'immutable-state');
  const result = await initialise(fixture);
  const { createStorage } = await import('../../packages/core/storage.mjs');
  const storage = createStorage({ root: result.state.root });

  /* The three records are re-readable through the same storage contract, which
   * is keyed by relative path plus the record kind and id and hands back the
   * stored value itself. The envelope — schema version, kind, id and the digest
   * over the stored bytes — belongs to the storage layer and is verified by the
   * read, so the value this call receives is exactly what was published: the
   * sealed run record, with no wrapper between the caller and it. The digest of
   * the stored record is the one the module reported when it published it. */
  const readValue = await storage.read({
    relativePath: RUN_STATE_RELATIVE_PATH,
    kind: INIT_STATE_KIND,
    id: result.manifest.manifestId,
  });
  assert.equal(readValue.manifestId, result.manifest.manifestId,
    'the record read back carries the same manifest identity');
  assert.equal(readValue.runId, result.manifest.runId,
    'the record read back is the same run, not a record that merely shares a path');
  assert.ok(HEX64.test(result.state.runRecordDigest), 'the published record carries a record digest');
  assert.notEqual(result.state.runRecordDigest, result.manifest.manifestDigest,
    'the digest of the stored record and the digest sealed inside the manifest are different digests of different things');

  /* Replacement under the same path is refused by the storage layer. A different
   * identity at an occupied location is refused as well. */
  const replacement = await rejection(storage.createImmutable({
    relativePath: RUN_STATE_RELATIVE_PATH,
    kind: INIT_STATE_KIND,
    id: 'another-run-entirely',
    value: { replaced: true },
  }));
  assert.ok(replacement !== void 0, 'a published record cannot be replaced under its path');
  assert.match(String(replacement?.code ?? replacement?.message), /ERR_STORAGE_/,
    'the storage layer reports the refusal in its own code space');

  const manifestFile = inContainer(result.state.root, ...segments(RUN_STATE_RELATIVE_PATH));
  const bytesBefore = fs.readFileSync(manifestFile);
  const after = await rejection(storage.createImmutable({
    relativePath: RUN_STATE_RELATIVE_PATH,
    kind: INIT_STATE_KIND,
    id: result.manifest.manifestId,
    value: { tampered: true },
  }));
  assert.ok(after !== void 0, 'the same identity cannot be republished either');
  assert.deepEqual(fs.readFileSync(manifestFile), bytesBefore, 'the published bytes did not change');

  /* The state root reports no mutable surface for these records. The mutable API
   * is keyed by the same identity the record was published under, so the
   * refusal it raises is the one about immutability and not a complaint about a
   * malformed request. */
  assert.equal(typeof storage.replaceMutable, 'function', 'the storage contract itself distinguishes mutable records');
  const mutableAttempt = await rejection(storage.replaceMutable({
    relativePath: RUN_STATE_RELATIVE_PATH,
    kind: INIT_STATE_KIND,
    id: result.manifest.manifestId,
    value: { tampered: true },
  }));
  assert.ok(mutableAttempt !== void 0, 'an immutable record refuses a mutable replacement');
  assert.match(String(mutableAttempt?.code ?? mutableAttempt?.message), /ERR_STORAGE_IMMUTABLE_REPLACEMENT/,
    'the refusal names immutability as the reason');
});

test('the persisted manifest is the accepted C1 record with no field added to it', async (t) => {
  const fixture = buildFixture(t, 'no-extra-fields');
  const result = await initialise(fixture);
  const { createStorage } = await import('../../packages/core/storage.mjs');
  const storage = createStorage({ root: result.state.root });

  const storedValue = structuredClone(await storage.read({
    relativePath: RUN_STATE_RELATIVE_PATH,
    kind: INIT_STATE_KIND,
    id: result.manifest.manifestId,
  }));
  assert.deepEqual(structuredClone(validateRecord('RunManifest', structuredClone(storedValue))),
    structuredClone(storedValue),
    'the manifest inside the stored record satisfies the accepted contract as it was stored');

  /* The dependency and export facts travel as their own records, so nothing was
   * bolted onto the C1 record to carry them. */
  for (const forbidden of ['dependencyDigest', 'dependencyInventory', 'workloadDigest', 'exportInventory'])
    assert.equal(forbidden in storedValue, false,
      `the C1 manifest carries no unschematised ${forbidden} field`);
  assert.equal(storedValue.manifestId, result.manifest.manifestId, 'the stored record is the run\'s own');
  assert.ok(fs.existsSync(inContainer(result.state.root, ...segments(DEPENDENCY_STATE_RELATIVE_PATH))),
    'the dependency fact has its own record instead');
  assert.ok(fs.existsSync(inContainer(result.state.root, ...segments(EXPORT_STATE_RELATIVE_PATH))),
    'the export fact has its own record instead');
});

/* ==================================================================== published */

test('the published roots are final: no staging path is ever recorded or left behind', async (t) => {
  const fixture = buildFixture(t, 'published-not-staged');
  const output = inContainer(fixture.outputParent, 'container');
  const result = await initialise(fixture, { output });

  const stagingMarkers = ['.benchboard-export-', '.benchboard-init-', '.tmp-', '~'];
  const recorded = [result.output, result.workspace.root, result.state.root];
  for (const rootPath of recorded) {
    assert.ok(path.isAbsolute(rootPath), `${rootPath} is an absolute host root`);
    for (const marker of stagingMarkers)
      assert.equal(String(rootPath).includes(marker), false, `${rootPath} carries no staging marker ${marker}`);
    assert.equal(String(rootPath).endsWith(path.join(WORKSPACE_DIRECTORY_NAME, '.benchboard-export-x')), false);
  }

  /* The manifest names the same final roots the result does. */
  assert.equal(result.manifest.participantWorkspaceRoot, result.workspace.root);
  assert.equal(result.manifest.evidenceRoot, result.state.root);

  /* And on disk: the container holds its two published directories and nothing
   * else, so no staging sibling survived publication. */
  const containerEntries = fs.readdirSync(output).sort(RAW_COMPARE);
  assert.deepEqual(containerEntries, [STATE_DIRECTORY_NAME, WORKSPACE_DIRECTORY_NAME].sort(RAW_COMPARE),
    `the container holds only the published roots, got ${containerEntries.join(', ')}`);
  const leftovers = Object.keys(snapshotTree(fixture.outputParent))
    .filter((key) => key.includes('.benchboard-') && !key.startsWith(`container/${STATE_DIRECTORY_NAME}/`))
    .filter((key) => !key.endsWith(DEPENDENCIES_METADATA_FILE_NAME))
    .sort(RAW_COMPARE);
  assert.deepEqual(leftovers, [], 'no staging tree of any module is left in the output parent');
});

test('the exported workload is re-checked after the export and before the run is recorded', async (t) => {
  /* The transaction rule states the order: prove the source, copy it, then prove
   * it again before anything is published. The observable consequence is that a
   * workspace byte which changes between the export and the recording of the run
   * cannot produce a recorded run, because the digest re-taken over the published
   * workspace no longer equals the digest the identity binds.
   *
   * The seam makes that window reachable without racing anything: the state
   * seam fires after the workspace has been exported and re-verified and before
   * any state byte exists, so the tamper it performs is a real byte change
   * between the export proof and the state proof. */
  const fixture = buildFixture(t, 'late-workspace-change');
  const output = inContainer(fixture.outputParent, 'container');
  const observed = [];

  const error = await expectCode(initialise(fixture, {
    output,
    beforeStatePublication: (observation) => {
      observed.push(observation.stage);
      const workloadFile = inRoot(observation.workspaceRoot, 'README.md');
      fs.writeFileSync(workloadFile, `${fs.readFileSync(workloadFile, 'utf8')}\ntampered after the export\n`, 'utf8');
    },
  }), INIT_ERROR_CODES.PUBLICATION_INVALID,
  'a workload that diverges from its proof after the export is a publication failure');

  assert.deepEqual(observed, ['beforeStatePublication'], 'the seam reported the stage it is named for');
  assert.match(error.message, /workload|digest/i, `the reason names what disagreed: ${error.message}`);

  /* Changed participant bytes are foreign to the recorded export; preservation
   * takes precedence over destructive rollback. Residue is explicitly failed,
   * never returned as a successful initialized run. */
  assert.equal(fs.existsSync(output), true);
  assert.match(fs.readFileSync(inRoot(path.join(output, 'workspace'), 'README.md'), 'utf8'), /tampered after the export/);
  assert.ok(error.cleanup instanceof InitError);
  assert.equal(error.code, INIT_ERROR_CODES.PUBLICATION_INVALID);
});

test('a source that changes under the exporter is reported through the export step', async (t) => {
  /* The other side of the same rule: when the source itself moves, the fault
   * belongs to the export step. The byte change here is not a guess about timing
   * — the identity is built over the bytes as they were copied, so the source
   * genuinely no longer matches the identity it is exported under. */
  const fixture = buildFixture(t, 'late-source-change');
  const output = inContainer(fixture.outputParent, 'container');
  const sourceFile = inRoot(fixture.sourceRoot, 'README.md');
  fs.writeFileSync(sourceFile, `${fs.readFileSync(sourceFile, 'utf8')}\nchanged after the identity was derived\n`,
    'utf8');

  /* The export step is the accepted exporter's own, and it owns its own error
   * type and code space. When the source no longer matches the bytes the identity
   * was derived over, the exporter's refusal is what a caller sees: the
   * initialiser takes the container down and rethrows that refusal unchanged
   * rather than renaming someone else's verdict as its own. */
  const error = await rejection(initialise(fixture, { output }));
  assert.ok(error !== void 0, 'a changed source is refused');
  assert.equal(error.constructor.name, 'ChallengeExportError',
    `the export step reports in its own error type, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, 'WORKLOAD_MISMATCH', `the export step reports its own code (${error?.message})`);
  assert.match(error.message, /workload/i, 'the reason names the workload as what disagreed');
  assert.equal(fs.existsSync(output), false, 'the container is removed');
  assert.deepEqual(publishResidue(fixture), [], 'no residue of a failed export');
});

test('the same setup without the tamper publishes, so the refusals above are about the tamper', async (t) => {
  /* This is the control for the two tests before it: the identical fixture with
   * a seam that only observes publishes cleanly and records the identity's own
   * workload digest. Without it, a refusal could be a fault of the technique. */
  const fixture = buildFixture(t, 'late-change-control');
  const stages = [];
  const result = await initialise(fixture, {
    output: inContainer(fixture.outputParent, 'control'),
    beforeWorkspacePublication: (observation) => stages.push(observation.stage),
    beforeStatePublication: (observation) => stages.push(observation.stage),
  });

  assert.deepEqual(stages, ['beforeWorkspacePublication', 'beforeStatePublication'],
    'both seams are offered, in transaction order');
  assert.equal(result.workload.digest, fixture.identity.workloadDigest,
    'the recorded workload digest is the identity workload digest');
  assert.equal(result.workspace.fileCount, 26, 'the control published the whole workload');
  assert.deepEqual(publishResidue(fixture), ['control'],
    'the only thing in the output parent is the one published container');
});

/* ========================================================================== CLI */

test('the handler accepts the output root, the dependency mode and the run identity only', () => {
  const parsed = parseArguments([
    'C:/runs/container',
    '--dependency-mode', 'prepared',
    '--prepared-root', 'C:/cache/node_modules',
    '--source-root', 'C:/definition',
    '--expected-dependency-digest', 'a'.repeat(64),
    '--architecture-id', 'arch-run-cli',
  ]);

  assert.equal(parsed.help, false, 'a real command line is not help');
  assert.equal(parsed.output, 'C:/runs/container', 'the output root is the single positional');
  assert.deepEqual(parsed.dependencies, {
    mode: 'prepared',
    preparedRoot: 'C:/cache/node_modules',
    sourceRoot: 'C:/definition',
    expectedDependencyDigest: 'a'.repeat(64),
  }, 'the dependency options reach the dependency request');
  assert.deepEqual(parsed.statement, { architectureId: 'arch-run-cli' },
    'the architecture id reaches the run statement');

  const minimal = parseArguments(['C:/runs/container']);
  assert.deepEqual(minimal.dependencies, {}, 'an omitted mode is not invented by the parser');
  assert.deepEqual(minimal.statement, {}, 'an omitted run statement stays empty');

  const help = parseArguments(['--help']);
  assert.equal(help.help, true, 'help is recognised');
  assert.equal(help.output, null, 'help names no output root');
  assert.deepEqual(fsHelpSurface(), [], 'the help text and the option tables agree');
});

/**
 * Cross-check the help text against the machine-readable option tables.
 *
 * The help text and the tables are two descriptions of one boundary, so they can
 * disagree. This returns the disagreements instead of asserting a fixed string:
 * an implemented option the help omits, an option the help advertises that no
 * table implements, a name that is both implemented and pending, and a pending
 * boundary the help does not disclose. An empty list is the honest case.
 */
function fsHelpSurface() {
  const problems = [];
  const lines = CLI_USAGE.split('\n');
  const start = lines.indexOf('Options:');
  if (start < 0) return ['the help text has no Options section'];

  const advertised = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) break;
    if (line.startsWith('  -')) advertised.push(line.trim().split(/\s+/)[0]);
  }

  const implemented = Object.keys(OPTION_SPECIFICATIONS).sort(RAW_COMPARE);
  for (const name of implemented)
    if (!advertised.includes(name)) problems.push(`the implemented option ${name} is not listed in the help text`);
  for (const name of advertised)
    if (name !== '--help' && !implemented.includes(name))
      problems.push(`the help text advertises ${name}, which no option table implements`);

  for (const name of implemented)
    if (UNIMPLEMENTED_OPTIONS.includes(name))
      problems.push(`${name} is listed both as implemented and as pending`);

  if (UNIMPLEMENTED_OPTIONS.length > 0 && !/Not implemented/i.test(CLI_USAGE))
    problems.push('the help text does not disclose the pending boundary at all');
  return problems;
}

test('the handler refuses a command line it cannot honour, naming the reason', async () => {
  /* These refusals all belong to the handler, before any request is built, so no
   * fixture and no file system is needed: the point is that nothing is attempted.
   * The `argv` values are therefore inert paths that never have to exist. */
  const base = { argv: ['C:/runs/container'] };
  await expectCliCode(runInit({ ...base, argv: [] }), CLI_ERROR_CODES.USAGE, 'no output root at all');
  await expectCliCode(runInit({ ...base, argv: ['C:/a', 'C:/b'] }), CLI_ERROR_CODES.USAGE,
    'two positional output roots');
  await expectCliCode(runInit({ ...base, argv: ['C:/a', '--dependency-mode'] }), CLI_ERROR_CODES.OPTION_VALUE_MISSING,
    'an option with no value');
  await expectCliCode(runInit({ ...base, argv: ['C:/a', '--dependency-mode', 'sideload'] }),
    CLI_ERROR_CODES.OPTION_VALUE_INVALID, 'a dependency mode outside the three');
  await expectCliCode(runInit({ ...base, argv: ['C:/a', '--expected-dependency-digest', 'nope'] }),
    CLI_ERROR_CODES.OPTION_VALUE_INVALID, 'a dependency digest that is not sixty-four hex characters');
  await expectCliCode(runInit({ ...base, argv: ['C:/a', '--no-such-flag'] }), CLI_ERROR_CODES.UNKNOWN_OPTION,
    'a flag this handler does not know');
  await expectCliCode(runInit({ ...base, argv: ['C:/a', '--architecture-id', 'x', '--architecture-id', 'y'] }),
    CLI_ERROR_CODES.DUPLICATE_OPTION, 'the same flag twice');
});

test('the handler refuses a pending option instead of accepting and ignoring it', async () => {
  const pendingCases = [
    ['--harness', 'synthetic'], ['--security-model', 'LOCAL_ISOLATED'],
    ['--declared-ceiling-minutes', '90'], ['--provider', 'somebody'],
    ['--model', 'somebody'], ['--version', '1.2.3'], ['--config', 'x.json'],
    ['--dry-run'], ['--force'], ['--yes'],
  ];
  for (const [flag, value] of pendingCases) {
    const argv = ['C:/runs/container', flag, ...(value === void 0 ? [] : [value])];
    /* A pending option is refused in the same shape as any option this command
     * does not implement — it genuinely is not an option of this command — and
     * additionally discloses the chunk that owns it, so the caller learns that
     * the name is planned rather than mistyped. */
    const error = await expectCliCode(runInit({ argv }), CLI_ERROR_CODES.UNKNOWN_OPTION,
      `the pending option ${flag} is refused by name`);
    assert.equal(error.pendingChunk, 'C6', `${flag} is disclosed as pending in C6`);
    assert.match(error.message, /C6|not implemented|pending/i, `${flag} says it is not implemented here`);
    assert.ok(UNIMPLEMENTED_OPTIONS.includes(flag), `${flag} is on the declared pending list`);
  }
});

test('the handler requires the package and the two identities to be handed to it', async (t) => {
  const fixture = buildFixture(t, 'cli-inputs');
  const argv = [inContainer(fixture.outputParent, 'from-cli'), '--architecture-id', 'arch-run-cli'];
  const valid = {
    argv,
    challenge: packageFor(fixture),
    toolingIdentity: fixture.toolingIdentity,
    evaluatorIdentity: fixture.evaluatorIdentity,
  };

  for (const missing of ['challenge', 'toolingIdentity', 'evaluatorIdentity']) {
    const input = { ...valid };
    delete input[missing];
    const error = await expectCliCode(runInit(input), CLI_ERROR_CODES.INPUT_INVALID,
      `a call with no ${missing} is refused rather than discovered`);
    assert.equal(error.input, missing, `the refusal names ${missing}`);
  }

  await expectCliCode(runInit({ ...valid, challenge: { identity: fixture.identity } }),
    CLI_ERROR_CODES.INPUT_INVALID, 'a package missing its boundary fields');
  await expectCliCode(runInit({ ...valid, challenge: { ...packageFor(fixture), extraRoots: ['C:/x'] } }),
    CLI_ERROR_CODES.INPUT_INVALID, 'a package carrying a field the interface does not name');
  await expectCliCode(runInit({ ...valid, toolingIdentity: { ...fixture.toolingIdentity, hashAlgorithm: 'md5' } }),
    CLI_ERROR_CODES.INPUT_INVALID, 'an identity the accepted validator refuses');

  assert.deepEqual(CHALLENGE_PACKAGE_KEYS,
    ['identity', 'sourceRoot', 'fileManifest', 'ownerRoots', 'evaluatorRoots'],
    'the handler validates exactly the approved package fields');

  /* Nothing was created by the refusals. */
  assert.deepEqual(fs.readdirSync(fixture.outputParent).sort(RAW_COMPARE), [], 'the refusals wrote nothing');
});

test('the handler states only the run facts the API accepts, and the command line wins', async (t) => {
  const fixture = buildFixture(t, 'cli-statement');
  const argv = [inContainer(fixture.outputParent, 'cli-container'), '--architecture-id', 'arch-from-argv'];
  const base = {
    argv,
    challenge: packageFor(fixture),
    toolingIdentity: fixture.toolingIdentity,
    evaluatorIdentity: fixture.evaluatorIdentity,
  };

  const noId = await expectCliCode(runInit({ ...base, argv: [inContainer(fixture.outputParent, 'x')] }),
    CLI_ERROR_CODES.USAGE, 'a run with no architecture id stated anywhere');
  assert.equal(noId.option, '--architecture-id', 'the refusal names the option that would state it');

  await expectCliCode(runInit({ ...base, statement: { harness: 'synthetic', securityMode: 'LOCAL_ISOLATED' }, argv }),
    CLI_ERROR_CODES.OPTION_VALUE_INVALID, 'a statement field outside the accepted set');

  const result = await runInit({
    ...base,
    statement: { architectureId: 'arch-from-statement', harness: 'synthetic-harness' },
  });
  assert.equal(result.manifest.architectureId, 'arch-from-argv',
    'the command line overrides the programmatic statement');
  assert.equal(result.manifest.harness, 'synthetic-harness', 'a programmatic run fact still travels');
  assert.equal(result.manifest.securityModel, 'UNSPECIFIED',
    'a run fact that nobody stated is recorded as unknown, not guessed');
  assert.ok(INITIALIZABLE_STATEMENT_KEYS.includes('declaredCeilingMinutes'),
    'the ceiling is stated through the programmatic statement');

  const summary = summariseResult(result);
  assert.equal(summary.output, result.output, 'the summary restates the output root');
  assert.equal(summary.workspaceRoot, result.workspace.root, 'the summary names the workspace root');
  assert.equal(summary.stateRoot, result.state.root, 'the summary names the state root');
  assert.equal(summary.workloadFileCount, 26, 'the summary reports the workload count');
  assert.equal(summary.dependencyMode, 'none', 'the summary reports the dependency mode');
  assert.equal(Object.keys(summary).includes('manifestDigest'), false,
    'the summary does not invent fields beyond what the run reported');
});

test('the handler delegates the whole operation to the API and reports its outcome verbatim', async (t) => {
  const fixture = buildFixture(t, 'cli-delegation');
  const output = inContainer(fixture.outputParent, 'delegated');
  const seen = [];
  const status = await main({
    argv: [output, '--architecture-id', 'arch-run-main'],
    challenge: packageFor(fixture),
    toolingIdentity: fixture.toolingIdentity,
    evaluatorIdentity: fixture.evaluatorIdentity,
    onResult: (result) => seen.push(result),
  }, { write: () => void 0, writeError: () => void 0 });

  assert.equal(status, CLI_EXIT_CODES.SUCCESS, 'a successful run exits with the success status');
  assert.equal(seen.length, 1, 'the caller observed the result once');
  assert.equal(seen[0].manifest.architectureId, 'arch-run-main',
    'the result the caller sees is the API result, with the API fields');
  assert.ok(fs.existsSync(path.join(seen[0].workspace.root, 'README.md')),
    'the handler produced a real published container, not a stand-in');

  /* A refusal is reported with the API's own code and a failure status, because
   * the API's reason is the reason the caller needs. */
  const errors = [];
  const failureStatus = await main({
    argv: [output, '--architecture-id', 'arch-run-again'],
    challenge: packageFor(fixture),
    toolingIdentity: fixture.toolingIdentity,
    evaluatorIdentity: fixture.evaluatorIdentity,
  }, { write: () => void 0, writeError: (text) => errors.push(text) });
  assert.equal(failureStatus, CLI_EXIT_CODES.FAILURE, 'an API refusal exits with the failure status');
  assert.equal(errors.length, 1, 'exactly one line went to the error sink');
  assert.match(errors[0], new RegExp(`^${INIT_ERROR_CODES.OUTPUT_EXISTS}: `),
    `the API's own code leads the report: ${errors[0]}`);

  /* A handler refusal is a usage status, and a pending option points at help. The
   * status and the code are two different answers: the status classifies how far
   * the run got — nothing was attempted — while the code names the reason, which
   * for an unimplemented option is that the option is unknown. */
  const usageLines = [];
  const usageStatus = await main({ argv: ['--harness', 'x'] },
    { write: () => void 0, writeError: (text) => usageLines.push(text) });
  assert.equal(usageStatus, CLI_EXIT_CODES.USAGE, 'a usage refusal exits with the usage status');
  assert.match(usageLines[0], new RegExp(`^${CLI_ERROR_CODES.UNKNOWN_OPTION}: `),
    `the handler code leads, once and no twice: ${usageLines[0]}`);
  assert.equal([...usageLines[0].matchAll(new RegExp(`^${CLI_ERROR_CODES.UNKNOWN_OPTION}: `, 'gm'))].length, 1,
    'the code is not printed a second time on top of the message that already carries it');
  assert.match(usageLines[0], /--help/, 'a pending refusal tells the caller where to look');

  /* Help is a success and prints the usage. */
  const printed = [];
  const helpStatus = await main({ argv: ['--help'] },
    { write: (text) => printed.push(text), writeError: () => void 0 });
  assert.equal(helpStatus, CLI_EXIT_CODES.SUCCESS, 'help is not an error');
  assert.equal(printed[0], CLI_USAGE, 'the printed text is the usage contract');
});

test('a collaborator refusal is reported under its own code, never re-labelled or doubled', async (t) => {
  /* The dependency helper owns the dependency digest domain and refuses with its
   * own error type and its own code, and the seam reports that verdict rather than
   * dressing it up (see the expected-digest test). What is decided here is what the
   * caller actually reads: the dependency layer's code must lead the report, once.
   * Relabelling it as an internal fault would send the caller to the wrong
   * component, and prefixing a message that already starts with its code would
   * double the field the caller parses. */
  const fixture = buildFixture(t, 'cli-collaborator');
  const { preparedRoot } = buildDependencyCache(fixture);
  const argvFor = (name) => [
    inContainer(fixture.outputParent, name),
    '--architecture-id', 'arch-collaborator',
    '--dependency-mode', 'prepared',
    '--prepared-root', preparedRoot,
    '--source-root', fixture.sourceRoot,
    '--expected-dependency-digest', '0'.repeat(64),
  ];

  const lines = [];
  const status = await main({
    argv: argvFor('mismatch'),
    challenge: packageFor(fixture),
    toolingIdentity: fixture.toolingIdentity,
    evaluatorIdentity: fixture.evaluatorIdentity,
  }, { write: () => void 0, writeError: (text) => lines.push(text) });

  assert.equal(status, CLI_EXIT_CODES.FAILURE, 'a collaborator refusal is a failure, not a usage status');
  assert.equal(lines.length, 1, 'exactly one line went to the error sink');
  assert.match(lines[0], /^DEPENDENCY_DIGEST_MISMATCH: /,
    `the collaborator's own code leads the report: ${lines[0]}`);
  assert.equal(lines[0].split('DEPENDENCY_DIGEST_MISMATCH').length - 1, 1,
    `the code appears once, not once per layer: ${lines[0]}`);
  assert.equal(lines[0].includes(INIT_ERROR_CODES.INTERNAL), false,
    'a dependency refusal is not reported as an internal fault');
  assert.equal(fs.existsSync(inContainer(fixture.outputParent, 'mismatch')), false,
    'the reporting did not leave a half-built container behind');

  /* The internal label is for the one remaining case: an error that carries no code
   * of its own at all. A caller hook that throws is that case, reached from the
   * handler's own success path. */
  const internalLines = [];
  const internalStatus = await main({
    argv: [inContainer(fixture.outputParent, 'hook'), '--architecture-id', 'arch-hook'],
    challenge: packageFor(fixture),
    toolingIdentity: fixture.toolingIdentity,
    evaluatorIdentity: fixture.evaluatorIdentity,
    onResult: () => { throw new TypeError('a hook that carries no code'); },
  }, { write: () => void 0, writeError: (text) => internalLines.push(text) });

  assert.equal(internalStatus, CLI_EXIT_CODES.FAILURE, 'a codeless failure is a failure');
  assert.match(internalLines[0], new RegExp(`^${INIT_ERROR_CODES.INTERNAL}: `),
    `an error with no code of its own is labelled internal, once: ${internalLines[0]}`);
});

test('the handler performs no packaging, bin, version, host or runner work', () => {
  /* The comments in the handler say what it is not yet; what matters is what the
   * code does, so the prose is stripped first and only the code is scanned. These
   * are the surfaces the later chunks own: a match here would mean the skeleton
   * grew into the product CLI it is explicitly not yet. */
  const code = codeOnly(fs.readFileSync(CLI_MODULE_UNDER_TEST, 'utf8'));

  const forbiddenPatterns = [
    [/\bpackage\.json\b/, 'a reference to a package manifest'],
    [/\bbin\b\s*:/, 'a bin declaration'],
    [/\bcreateRequire\b|\brequire\.resolve\b/, 'a module resolution strategy'],
    [/\bprocess\.env\b/, 'an environment read'],
    [/\bprocess\.version\b/, 'a runtime version read'],
    [/\bDocker\b/, 'a container reference'],
    [/\bgit\b/, 'a version-control reference'],
    [/\brunner\b/, 'a runner reference'],
    [/\bdsh\b/i, 'a DSH reference'],
    [/\bchild_process\b/, 'a process runner'],
    [/\bfetch\(|node:https?\b/, 'a network client'],
    [/\bspawn\b/, 'a process spawn'],
  ];
  const hits = forbiddenPatterns.filter(([pattern]) => pattern.test(code)).map(([, label]) => label);
  assert.deepEqual(hits, [], `the handler must stay a thin delegating seam, found: ${hits.join(', ')}`);

  /* And positively: it delegates the whole operation exactly once, so there is no
   * second path through which product work could accrete. */
  const delegated = [...code.matchAll(/\binitialiseRun\(/g)].length;
  assert.equal(delegated, 1, 'the handler delegates to initialiseRun exactly once');

  /* The help boundary is honest: every option it advertises is one the handler
   * implements, and a pending name is refused rather than silently accepted. */
  assert.equal(/\B--config\b/.test(code), true, 'the pending configuration option is refused by name');
  assert.equal(/\breadFile|node:fs\b/.test(code), false, 'the handler reads no file system itself');
});

/* ================================================================== declarations */

test('both shipped declaration pairs are byte-identical and declare the runtime surface', () => {
  for (const [modulePath, coreRoot, name, typeNames] of [
    [CORE_MODULE_UNDER_TEST, CORE_ROOT, 'init',
      ['InitRequest', 'InitResult', 'InitErrorCodes', 'InitObservation', 'InitDependencyCompanion', 'InitExportProof']],
    [CLI_MODULE_UNDER_TEST, CLI_ROOT, 'init',
      ['CliInput', 'CliParsedArguments', 'CliSummary', 'CliHelpResult', 'CliErrorCodes', 'CliSinks']],
  ]) {
    const declarationPath = path.join(coreRoot, `${name}.d.ts`);
    const siblingPath = path.join(coreRoot, `${name}.d.mts`);
    assert.ok(fs.existsSync(declarationPath), `${name}.d.ts exists for the shipped module`);
    assert.ok(fs.existsSync(siblingPath), `${name}.d.mts exists for the shipped module`);
    const declaration = fs.readFileSync(declarationPath, 'utf8');
    assert.equal(fs.readFileSync(siblingPath, 'utf8'), declaration,
      `the ${name}.d.mts copy is byte-identical to the ${name}.d.ts source`);

    const source = fs.readFileSync(modulePath, 'utf8');
    const runtimeExports = [...source.matchAll(/^export (?:async )?(?:const|function|class) ([A-Za-z_$][0-9A-Za-z_$]*)/gm)]
      .map((match) => match[1]).sort();
    assert.ok(runtimeExports.length >= 8, `${name} exports ${runtimeExports.join(', ')}`);
    for (const exported of runtimeExports)
      assert.match(declaration, new RegExp(`\\b${exported}\\b`), `the runtime export ${exported} is declared`);
    for (const typeName of typeNames)
      assert.match(declaration, new RegExp(`export (?:interface|type) ${typeName}\\b`),
        `${typeName} is declared`);
    assert.equal([...declaration.matchAll(/export (?:async )?function init\b/g)].length <= 1, true,
      'the entry point is declared at most once per pair');
  }
});

test('the pinned TypeScript compiler typechecks both declaration pairs for a real module consumer', (t) => {
  assert.ok(fs.existsSync(PINNED_COMPILER), 'the pinned compiler must be available; no install and no skip');
  const root = scratch(t, 'types');

  /* One consumer resolves both modules through the package roots, so the type
   * graph of the seam itself is what gets checked: the run request, the result,
   * the CLI input and the C1 types they borrow. */
  const relative = (target) => {
    const value = path.relative(root, target).split(path.sep).join('/');
    return value.startsWith('.') ? value : `./${value}`;
  };
  const core = relative(CORE_MODULE_UNDER_TEST);
  const cli = relative(CLI_MODULE_UNDER_TEST);
  const consumer = [
    '/* A real consumer of the shipped declarations, resolved as an ECMAScript module. */',
    'import {',
    '  init,',
    '  initialiseRun,',
    '  InitError,',
    '  INIT_ERROR_CODES,',
    '  INIT_SECURITY_MODELS,',
    '  DEPENDENCY_MODES,',
    '  type InitRequest,',
    '  type InitResult,',
    '  type InitObservation,',
    '  type InitDependencyRequest,',
    '  type InitErrorCodes,',
    `} from ${JSON.stringify(core)};`,
    'import {',
    '  parseArguments,',
    '  runInit,',
    '  main,',
    '  summariseResult,',
    '  CliError,',
    '  CLI_EXIT_CODES,',
    '  CLI_ERROR_CODES,',
    '  CHALLENGE_PACKAGE_KEYS,',
    '  INITIALIZABLE_STATEMENT_KEYS,',
    '  UNIMPLEMENTED_OPTIONS,',
    '  CLI_USAGE,',
    '  type CliInput,',
    '  type CliParsedArguments,',
    '  type CliSummary,',
    '  type CliHelpResult,',
    `} from ${JSON.stringify(cli)};`,
    'import { type SealedRunManifest } from',
    `  ${JSON.stringify(relative(path.join(CORE_ROOT, 'manifest.mjs')))};`,
    'import { type ChallengePackage } from',
    `  ${JSON.stringify(relative(path.join(CORE_ROOT, 'challenge-export.mjs')))};`,
    '',
    'const dependencies: InitDependencyRequest = { mode: "prepared", preparedRoot: "C:/cache/node_modules" };',
    'const hook: (observation: InitObservation) => Promise<void> | void = (observation) => {',
    '  void [observation.stage, observation.output, observation.workspaceRoot];',
    '};',
    'const request: InitRequest = {',
    '  output: "C:/runs/container",',
    '  challenge: {',
    '    identity: {} as never,',
    '    sourceRoot: "C:/definition",',
    '    fileManifest: ["README.md"],',
    '    ownerRoots: ["C:/owner"],',
    '    evaluatorRoots: ["C:/evaluator"],',
    '  } as unknown as ChallengePackage,',
    '  dependencies,',
    '  toolingIdentity: {} as never,',
    '  evaluatorIdentity: {} as never,',
    '  architectureId: "arch-run",',
    '  securityModel: INIT_SECURITY_MODELS[0],',
    '  beforeStatePublication: hook,',
    '};',
    'const sealed: Promise<SealedRunManifest> = init(request);',
    'const full: Promise<InitResult> = initialiseRun(request);',
    'void full.then((result) => [',
    '  result.manifest.manifestId, result.manifest.runId, result.output, result.durationMs,',
    '  result.workspace.root, result.workspace.fileCount, result.workspace.dependencyDirectory,',
    '  result.state.root, result.state.insideWorkspace, result.state.dependencyMetadata,',
    '  result.state.runRecordDigest, result.dependency.digest, result.workload.algorithmId,',
    ']);',
    'const codes: InitErrorCodes = INIT_ERROR_CODES;',
    'const code: InitErrorCodes["OUTPUT_EXISTS"] = codes.OUTPUT_EXISTS;',
    'const modes: readonly ("none" | "prepared" | "install")[] = DEPENDENCY_MODES;',
    'const failure: InitError = new InitError(code, "message", { path: "C:/runs/container" });',
    'const sealedFailure: InitError = new InitError(codes.OUTPUT_EXISTS, "m", { cause: failure });',
    'const reported: boolean = sealedFailure.cleanup !== void 0;',
    'void sealed;',
    '',
    'const argv: readonly string[] = ["C:/runs/container", "--dependency-mode", "none"];',
    'const parsed: CliParsedArguments = parseArguments([...argv]);',
    'const output: string | null = parsed.output;',
    'const mode: "none" | "prepared" | "install" | undefined = parsed.dependencies.mode;',
    'const statementKeys: readonly string[] = INITIALIZABLE_STATEMENT_KEYS;',
    'const packageKeys: readonly string[] = CHALLENGE_PACKAGE_KEYS;',
    'const pending: readonly string[] = UNIMPLEMENTED_OPTIONS;',
    'const usage: string = CLI_USAGE;',
    'const input: CliInput = {',
    '  argv: [...argv],',
    '  challenge: parsed.output === null ? void 0 as never : {} as never,',
    '  toolingIdentity: {} as never,',
    '  evaluatorIdentity: {} as never,',
    '  statement: { architectureId: "arch-run", declaredCeilingMinutes: void 0 },',
    '};',
    'const summary: CliSummary = summariseResult(void 0 as never);',
    'const summaryFields: readonly (string | number | null)[] =',
    '  [summary.status, summary.output, summary.workloadDigest, summary.workloadFileCount, summary.runId];',
    'const help: Promise<CliHelpResult | InitResult> = runInit(input);',
    'void help;',
    'const exit: Promise<number> = main(input, { write: (text: string) => void text });',
    'const statuses: readonly (0 | 1 | 2)[] = [CLI_EXIT_CODES.SUCCESS, CLI_EXIT_CODES.FAILURE, CLI_EXIT_CODES.USAGE];',
    'const cliCode: string = CLI_ERROR_CODES.USAGE;',
    'const cliFailure: CliError = new CliError(CLI_ERROR_CODES.USAGE, "message", { pendingChunk: "C6" });',
    'const pendingChunk: "C6" | undefined = cliFailure.pendingChunk;',
    'const everything: readonly (string | number | boolean | null | undefined)[] =',
    '  [reported, output, mode, cliCode, pendingChunk, statuses[0], summaryFields[0], statementKeys[0],',
    '   packageKeys[0], pending[0], usage.length, code, modes[0]];',
    'void everything;',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'consumer.mts'), consumer, 'utf8');

  /* The same six flags the accepted contract suite pins; nothing else is
   * requested, so no installation, project file or emitted output is involved.
   * The compiler path is absolute because the program runs from the scratch. */
  const flags = ['--noEmit', '--strict', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext'];
  const result = spawnSync(process.execPath, [PINNED_COMPILER, ...flags, 'consumer.mts'],
    { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `the pinned compiler reported:\n${output}`);

  /* A declaration binds only when the program actually loads the shipped
   * .d.mts sibling, so the file list is the observable proof of that binding. */
  const listed = spawnSync(process.execPath, [PINNED_COMPILER, ...flags, '--listFiles', 'consumer.mts'],
    { cwd: root, encoding: 'utf8' });
  const fileList = `${listed.stdout ?? ''}${listed.stderr ?? ''}`;
  assert.equal(listed.status, 0, `the pinned compiler could not list its program:\n${fileList}`);
  assert.match(fileList, /[\\/]init\.d\.mts/, 'a module declaration is part of the compiled program');
  assert.match(fileList, /[\\/]manifest\.d\.mts/, 'the accepted manifest declaration is in the program');
  assert.match(fileList, /[\\/]challenge-export\.d\.mts/, 'the released exporter declaration is in the program');
  assert.match(fileList, /[\\/]dependencies\.d\.mts/, 'the released dependency declaration is in the program');
  /* `matchAll` iterates match objects, whose first entry is the matched text, so
   * the names are read off that entry. The real claim is about two distinct
   * locations: the core and the CLI each ship a declaration of the same base
   * name, so the program must carry one under the core root and one under the
   * CLI root, and a program that loaded only one of the two would fail here. */
  const listedLines = fileList.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const declarationPaths = listedLines.filter((line) => line.endsWith('.d.mts'));
  const declarations = declarationPaths.map((line) => line.split(/[\\/]/).at(-1));
  assert.ok(declarationPaths.some((line) => /packages[\\/]core[\\/]init\.d\.mts$/.test(line)),
    'the core declaration is in the compiled program');
  assert.ok(declarationPaths.some((line) => /(^|[\\/])cli[\\/]init\.d\.mts$/.test(line)),
    'the CLI declaration is in the compiled program');
  assert.equal(declarations.filter((value) => value === 'init.d.mts').length, 2,
    `exactly the two shipped init declarations are loaded: ${declarationPaths.join(', ')}`);
});

/* ======================================================================= exports */

test('the module surface is the contract, re-exported rather than restated', () => {
  assert.equal(INIT_MODULE_ID, 'benchboard.core.init', 'the module names itself');
  assert.equal(INIT_STATE_KIND, 'benchboard:run-initialisation', 'the state records carry their own kind');
  assert.equal(INIT_STATE_SCHEMA_VERSION, '1.0.0', 'the state schema version is a major-one version');
  assert.equal(WORKSPACE_DIRECTORY_NAME, 'workspace', 'the workspace directory name is the contract');
  assert.equal(STATE_DIRECTORY_NAME, '.benchboard', 'the state directory name is the contract');
  assert.notEqual(DEPENDENCIES_DIRECTORY_NAME, 'node_modules',
    'the state dependencies directory is not the dependency helper\'s node_modules name');

  /* The security models are the contract layer's own list, re-exported rather
   * than restated: the same array object, so it cannot drift from the validator
   * that judges the very field. */
  assert.equal(INIT_SECURITY_MODELS, SECURITY_MODELS, 'the list is the accepted one, not a copy of it');
  assert.ok(Object.isFrozen(INIT_SECURITY_MODELS), 'the accepted list is frozen');
  assert.ok(INIT_SECURITY_MODELS.includes('UNSPECIFIED'), 'the accepted list carries its unspecified member');

  const source = fs.readFileSync(CORE_MODULE_UNDER_TEST, 'utf8');

  /* The seam imports its collaborators; it does not re-implement or reach around
   * them, and it has no route to a host configuration, a runner or DSH. */
  for (const specifier of ['./identity.mjs', './manifest.mjs', './storage.mjs', './challenge-export.mjs',
    './dependencies.mjs'])
    assert.ok(source.includes(`from '${specifier}'`) || source.includes(`from "${specifier}"`),
      `the module imports ${specifier}`);
  assert.match(source, /createRunManifest/, 'the manifest is created through the accepted factory');
  assert.match(source, /validateRecord/, 'records go through the accepted validator');
  assert.match(source, /createStorage/, 'state goes through the accepted storage layer');
  assert.match(source, /exportChallenge/, 'the workspace goes through the released exporter');
  assert.match(source, /prepareDependencies/, 'dependencies go through the released helper');

  /* A call of an accepted collaborator is exactly what the seam is for; what must
   * not appear is a local definition of one of those authorities, because that
   * would be a second implementation of the same decision. The patterns therefore
   * look for definitions, and for specifiers that reach outside the module's own
   * directory or the node builtins. */
  const forbidden = [
    [/^\s*(?:export\s+)?(?:async\s+)?function\s+createRunManifest\b/m, 'a local manifest factory definition'],
    [/^\s*(?:export\s+)?(?:async\s+)?function\s+validateRecord\b/m, 'a local contract validator definition'],
    [/^\s*(?:export\s+)?(?:async\s+)?function\s+createStorage\b/m, 'a local storage factory definition'],
    [/^\s*(?:export\s+)?(?:async\s+)?function\s+exportChallenge\b/m, 'a local workspace exporter definition'],
    [/^\s*(?:export\s+)?(?:async\s+)?function\s+prepareDependencies\b/m, 'a local dependency preparer definition'],
    [/\bprocess\.env\b/, 'an environment read'],
    [/\bDocker\b/, 'a container reference'],
    [/\bfetch\(|node:https?\b/, 'a network client'],
    [/\bchild_process\b/, 'a process runner'],
    [/from ['"](?!\.|node:)[A-Za-z@]/, 'a bare package specifier import'],
    [/from ['"]\.\.\/packages\/runner/, 'a runner import'],
    [/\bdsh\b/i, 'a DSH reference'],
    [/['"][A-Za-z]:[\\/][^'"]*(?:Users|Roaming|\.ai[\\/]evidence)/, 'a host-specific private path'],
  ];
  /* The scan runs over the code with its comments taken out. This module's prose
   * deliberately *names* the boundaries it must not cross — it documents that it
   * reads no environment, no DSH and no runner — and a boundary check that reads
   * that prose would report the disclosure as the violation. String literals
   * survive the stripping, so a refused option name or a path literal in real
   * code is still seen. */
  const code = codeOnly(source);
  const hits = forbidden.filter(([pattern]) => pattern.test(code)).map(([, label]) => label);
  assert.deepEqual(hits, [], `the module surface must stay public and bounded, found: ${hits.join(', ')}`);

  /* The error space is stable code strings, and every code is used. */
  for (const [key, value] of Object.entries(INIT_ERROR_CODES)) {
    assert.equal(key, value, `the code ${key} is its own name`);
    assert.match(value, /^[A-Z_]+$/, `the code ${key} is upper snake case`);
  }
});

/* ========================================================================== notes */

/* Actual networked installation and other OS qualification are not exercised.
 * Install orchestration is tested with a deterministic no-network process port.
 * Exporter/dependency suites separately exercise link and special-file guards.
 */

test('install init persists and revalidates final roots with a populated private cache', async (t) => {
  const fixture = buildFixture(t, 'install-roundtrip');
  const before = inventoryTree({ root: fixture.sourceRoot }).digest;
  const adapter = async request => {
    fs.mkdirSync(path.join(request.cwd, 'node_modules'));
    fs.writeFileSync(path.join(request.cwd, 'node_modules', 'dep.js'), 'export const n=1;');
    fs.writeFileSync(path.join(request.cwd, '.npm-cache', 'entry'), 'normal cache output');
    return { status: 0, signal: null, stdout: '', stderr: '' };
  };
  const result = await initialise(fixture, { dependencies: { mode: 'install', sourceRoot: fixture.sourceRoot, npmExecutable: process.execPath, processAdapter: adapter } });
  assert.equal(result.dependency.mode, 'install');
  assert.equal(fs.existsSync(path.join(result.workspace.root, 'node_modules', 'dep.js')), true);
  assert.equal(result.manifest.participantWorkspaceRoot, result.workspace.root);
  assert.equal(result.manifest.evidenceRoot, result.state.root);
  assert.equal(inventoryTree({ root: fixture.sourceRoot }).digest, before);
  const { createStorage } = await import('../../packages/core/storage.mjs');
  const storage = createStorage({ root: result.state.root });
  const record = await storage.read({ relativePath: RUN_STATE_RELATIVE_PATH, kind: INIT_STATE_KIND, id: result.manifest.manifestId });
  assert.equal(validateRecord('RunManifest', record).manifestDigest, result.manifest.manifestDigest);
});

test('outer rollback preserves a foreign container canary', async (t) => {
  const fixture = buildFixture(t, 'outer-foreign');
  const output = path.join(fixture.outputParent, 'foreign-residue');
  const canary = path.join(output, 'foreign.txt');
  const failure = new Error('injected state failure');
  const error = await rejection(initialise(fixture, { output, beforeStatePublication: () => { fs.writeFileSync(canary, 'FOREIGN'); throw failure; } }));
  assert.equal(error, failure);
  assert.equal(fs.readFileSync(canary, 'utf8'), 'FOREIGN');
  assert.ok(error.cleanup instanceof InitError);
  assert.equal(fs.existsSync(path.join(output, 'workspace', 'README.md')), false);
});

test('a replaced initialized container is not traversed during rollback', async (t) => {
  const fixture = buildFixture(t, 'replaced-container');
  const output = path.join(fixture.outputParent, 'replaced');
  const saved = path.join(fixture.outputParent, 'original-owned');
  const failure = new Error('replaced container');
  const error = await rejection(initialise(fixture, { output, beforeStatePublication: () => {
    fs.renameSync(output, saved); fs.mkdirSync(output);
    fs.cpSync(path.join(saved, 'workspace'), path.join(output, 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(output, 'foreign.txt'), 'FOREIGN');
    throw failure;
  } }));
  assert.equal(error, failure);
  assert.equal(fs.readFileSync(path.join(output, 'foreign.txt'), 'utf8'), 'FOREIGN');
  assert.equal(fs.existsSync(path.join(output, 'workspace', 'README.md')), true);
  assert.ok(error.cleanup instanceof InitError);
});


/* C2 review2: exact physical workspace, without generated-name blind spots. */
function physicalProofDependencies(fixture, mode) {
  if (mode === 'none') return { mode };
  if (mode === 'prepared') return { mode, preparedRoot: buildDependencyCache(fixture).preparedRoot,
    sourceRoot: fixture.sourceRoot };
  return { mode, sourceRoot: fixture.sourceRoot, npmExecutable: process.execPath,
    processAdapter: async request => {
      fs.mkdirSync(path.join(request.cwd, 'node_modules'));
      fs.writeFileSync(path.join(request.cwd, 'node_modules', 'dep.js'), 'ORIGINAL');
      return { status: 0, signal: null, stdout: '', stderr: '' };
    } };
}

for (const mode of DEPENDENCY_MODES) {
  const additions = ['.git', 'dist', 'src/.git', 'src/dist', 'src/node_modules'];
  if (mode === 'none') additions.push('node_modules');
  for (const relative of additions) {
    for (const kind of ['file', 'directory']) {
      test('physical workspace proof refuses ' + mode + ' extra ' + relative + ' ' + kind, async t => {
        const fixture = buildFixture(t, 'physical-extra');
        const sourceBefore = snapshotTree(fixture.sourceRoot);
        const sourceDigest = inventoryTree({ root: fixture.sourceRoot, skipNames: [] }).digest;
        const output = path.join(fixture.outputParent, 'container');
        let injected, foreign;
        const error = await expectCode(initialise(fixture, { output,
          dependencies: physicalProofDependencies(fixture, mode),
          beforeStatePublication: observation => {
            injected = inRoot(observation.workspaceRoot, relative);
            if (kind === 'directory') {
              fs.mkdirSync(injected);
              foreign = path.join(injected, 'foreign.txt');
            } else foreign = injected;
            fs.writeFileSync(foreign, 'FOREIGN');
          },
        }), INIT_ERROR_CODES.PUBLICATION_INVALID, 'physical extra');
        assert.equal(error.path, injected);
        assert.equal(fs.readFileSync(foreign, 'utf8'), 'FOREIGN');
        assert.equal(error.cleanup?.code, INIT_ERROR_CODES.CLEANUP_FAILED);
        assert.deepEqual(error.cleanup.kept.map(entry => entry.path), [output]);
        assert.equal(fs.existsSync(path.join(output, 'workspace', 'README.md')), false);
        assert.equal(fs.existsSync(path.join(output, STATE_DIRECTORY_NAME)), false);
        assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
        assert.equal(inventoryTree({ root: fixture.sourceRoot, skipNames: [] }).digest, sourceDigest);
      });
    }
  }
  for (const relative of ['.git', 'dist']) {
    test('physical workspace proof refuses ' + mode + ' empty ' + relative, async t => {
      const fixture = buildFixture(t, 'physical-empty');
      const output = path.join(fixture.outputParent, 'container');
      const injected = path.join(output, 'workspace', relative);
      const error = await expectCode(initialise(fixture, { output,
        dependencies: physicalProofDependencies(fixture, mode),
        beforeStatePublication: () => fs.mkdirSync(injected),
      }), INIT_ERROR_CODES.PUBLICATION_INVALID, 'empty foreign directory');
      assert.equal(error.path, injected);
      assert.ok(fs.lstatSync(injected).isDirectory());
      assert.deepEqual(fs.readdirSync(injected), []);
      assert.equal(error.cleanup?.code, INIT_ERROR_CODES.CLEANUP_FAILED);
      assert.deepEqual(error.cleanup.kept.map(entry => entry.path), [output]);
    });
  }
}

for (const [mode, relative, kind] of [
  ['none', 'node_modules', 'file'], ['none', 'node_modules', 'dir'],
  ['none', 'node_modules', 'junction'], ['prepared', '.git', 'dir'], ['install', 'dist', 'dir'],
]) {
  test('physical workspace proof never follows ' + mode + ' ' + relative + ' ' + kind + ' link', async t => {
    const fixture = buildFixture(t, 'physical-link');
    const output = path.join(fixture.outputParent, 'container');
    const injected = path.join(output, 'workspace', relative);
    const target = kind === 'file' ? path.join(fixture.ownerRoot, 'owner-secret.txt') : fixture.ownerRoot;
    const beforeTarget = snapshotTree(fixture.ownerRoot);
    const realLstat = fs.lstatSync;
    const realRead = fs.readFileSync;
    const realList = fs.readdirSync;
    let stub = false, targetReads = 0;
    fs.readFileSync = (absolute, ...rest) => {
      if (absolute === injected || String(absolute).startsWith(injected + path.sep)) targetReads++;
      return realRead(absolute, ...rest);
    };
    fs.readdirSync = (absolute, ...rest) => {
      if (absolute === injected || String(absolute).startsWith(injected + path.sep)) targetReads++;
      return realList(absolute, ...rest);
    };
    let error;
    try {
      error = await expectCode(initialise(fixture, { output,
        dependencies: physicalProofDependencies(fixture, mode),
        beforeStatePublication: () => {
          try { fs.symlinkSync(target, injected, kind); }
          catch (failure) {
            if (!['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(failure.code)) throw failure;
            t.diagnostic('host link creation unavailable (' + failure.code + '); deterministic lstat link branch, not a physical capability PASS');
            fs.writeFileSync(injected, 'FOREIGN');
            stub = true;
            fs.lstatSync = (absolute, ...rest) => absolute === injected
              ? { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false }
              : realLstat(absolute, ...rest);
          }
        },
      }), INIT_ERROR_CODES.PUBLICATION_INVALID, 'foreign link');
    } finally {
      fs.lstatSync = realLstat; fs.readFileSync = realRead; fs.readdirSync = realList;
    }
    assert.equal(error.path, injected);
    assert.equal(targetReads, 0, 'neither proof nor rollback enters or reads the foreign target');
    if (stub) assert.equal(fs.readFileSync(injected, 'utf8'), 'FOREIGN');
    else {
      assert.ok(fs.lstatSync(injected).isSymbolicLink());
      assert.equal(fs.readlinkSync(injected), kind === 'junction' && process.platform === 'win32'
        ? path.resolve(target) : target);
    }
    assert.deepEqual(snapshotTree(fixture.ownerRoot), beforeTarget);
    assert.equal(error.cleanup?.code, INIT_ERROR_CODES.CLEANUP_FAILED);
    assert.deepEqual(error.cleanup.kept.map(entry => entry.path), [output]);
  });
}

for (const mode of DEPENDENCY_MODES) {
  test('physical workspace proof refuses ' + mode + ' special entry without reading it', async t => {
    const fixture = buildFixture(t, 'physical-special');
    const output = path.join(fixture.outputParent, 'container');
    const injected = path.join(output, 'workspace', mode === 'none' ? 'node_modules' : 'dist');
    const realLstat = fs.lstatSync;
    const realRead = fs.readFileSync;
    let stub = false, reads = 0;
    fs.readFileSync = (absolute, ...rest) => {
      if (absolute === injected) { reads++; throw new Error('special entry must not be read'); }
      return realRead(absolute, ...rest);
    };
    let error;
    try {
      error = await expectCode(initialise(fixture, { output,
        dependencies: physicalProofDependencies(fixture, mode),
        beforeStatePublication: () => {
          const probe = spawnSync('mkfifo', [injected], { encoding: 'utf8' });
          // MSYS mkfifo (Git Bash on Windows) exits 0 but writes a .lnk emulation, not a FIFO.
          const fifo = probe.status === 0 && fs.lstatSync(injected, { throwIfNoEntry: false })?.isFIFO();
          if (fifo) t.diagnostic('physical FIFO created and rejected');
          else {
            fs.rmSync(injected + '.lnk', { force: true });
            assert.equal(fs.existsSync(injected), false, 'failed special probe left no material');
            t.diagnostic('physical FIFO unavailable on host (' + (probe.error?.code ?? probe.status) + '); deterministic lstat special branch, not a physical capability PASS');
            fs.writeFileSync(injected, 'FOREIGN'); stub = true;
            fs.lstatSync = (absolute, ...rest) => absolute === injected
              ? { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false }
              : realLstat(absolute, ...rest);
          }
        },
      }), INIT_ERROR_CODES.PUBLICATION_INVALID, 'special entry');
    } finally { fs.lstatSync = realLstat; fs.readFileSync = realRead; }
    assert.equal(error.path, injected);
    assert.equal(reads, 0);
    if (stub) assert.equal(fs.readFileSync(injected, 'utf8'), 'FOREIGN');
    else assert.ok(fs.lstatSync(injected).isFIFO());
    assert.equal(error.cleanup?.code, INIT_ERROR_CODES.CLEANUP_FAILED);
    assert.deepEqual(error.cleanup.kept.map(entry => entry.path), [output]);
  });
}

/* C2 independent-review regressions: final proof, pre-write roots, partial state. */
for (const mode of ['prepared', 'install']) {
  for (const change of ['mutate', 'add', 'remove', 'replace']) {
    test('final dependency proof refuses ' + mode + ' hook ' + change, async t => {
      const fixture = buildFixture(t, 'dep-' + mode + '-' + change);
      const output = path.join(fixture.outputParent, 'container');
      const prepared = mode === 'prepared' ? buildDependencyCache(fixture) : null;
      const relative = mode === 'prepared' ? 'synthetic-dep/package.json' : 'dep.js';
      const dependencies = mode === 'prepared'
        ? { mode, preparedRoot: prepared.preparedRoot, sourceRoot: fixture.sourceRoot }
        : { mode, sourceRoot: fixture.sourceRoot, npmExecutable: process.execPath,
          processAdapter: async request => {
            fs.mkdirSync(path.join(request.cwd, 'node_modules'));
            fs.writeFileSync(path.join(request.cwd, 'node_modules', 'dep.js'), 'ORIGINAL');
            return { status: 0, signal: null, stdout: '', stderr: '' };
          } };
      const beforeSource = inventoryTree({ root: fixture.sourceRoot }).digest;
      let foreign;
      const error = await expectCode(initialise(fixture, { output, dependencies,
        beforeStatePublication: observation => {
          const root = path.join(observation.workspaceRoot, 'node_modules');
          const file = inRoot(root, relative);
          if (change === 'remove') fs.unlinkSync(file);
          else if (change === 'add') {
            // Nested skip-name bytes must participate in the complete hash.
            foreign = path.join(root, 'dist', 'extra.js');
            fs.mkdirSync(path.dirname(foreign)); fs.writeFileSync(foreign, 'FOREIGN');
          } else {
            foreign = file;
            if (change === 'replace') fs.unlinkSync(file);
            fs.writeFileSync(file, 'FOREIGN');
          }
        },
      }), INIT_ERROR_CODES.PUBLICATION_INVALID, 'final dependency proof');
      assert.match(error.message, /dependency/i);
      assert.equal(inventoryTree({ root: fixture.sourceRoot }).digest, beforeSource);
      if (foreign) {
        assert.equal(fs.readFileSync(foreign, 'utf8'), 'FOREIGN');
        assert.equal(error.cleanup?.code, INIT_ERROR_CODES.CLEANUP_FAILED);
        assert.deepEqual(error.cleanup.kept.map(entry => entry.path), [output]);
      } else {
        assert.equal(fs.existsSync(output), false);
        assert.deepEqual(error.rolledBackTo.removed, [output]);
      }
    });
  }
}

for (const protectedName of ['sourceRoot', 'ownerRoot', 'evaluatorRoot']) {
  test('dot aliases of ' + protectedName + ' refuse before any mkdir', async t => {
    const fixture = buildFixture(t, 'alias-' + protectedName);
    const before = snapshotTree(fixture.root);
    const realMkdir = fs.promises.mkdir;
    let writes = 0;
    fs.promises.mkdir = async (...args) => { writes++; return realMkdir(...args); };
    try {
      const output = fixture.outputParent + path.sep + '..' + path.sep + path.basename(fixture[protectedName]) + path.sep + 'new';
      await expectCode(initialise(fixture, { output }), INIT_ERROR_CODES.INVALID_ROOT, 'dot alias');
      const challenge = packageFor(fixture);
      const spelling = fixture[protectedName] + path.sep + '.';
      if (protectedName === 'sourceRoot') challenge.sourceRoot = spelling;
      else challenge[protectedName === 'ownerRoot' ? 'ownerRoots' : 'evaluatorRoots'] = [spelling];
      await expectCode(initialise(fixture, { challenge }), INIT_ERROR_CODES.INVALID_ROOT, 'protected root dot spelling');
    } finally { fs.promises.mkdir = realMkdir; }
    assert.equal(writes, 0);
    assert.deepEqual(snapshotTree(fixture.root), before);
  });
}

test('redundant separators cannot bypass protected root comparisons', async t => {
  const fixture = buildFixture(t, 'redundant-root');
  const before = snapshotTree(fixture.root);
  for (const root of [fixture.sourceRoot, fixture.ownerRoot, fixture.evaluatorRoot]) {
    const output = root + path.sep + path.sep + 'new';
    await expectCode(initialise(fixture, { output }), INIT_ERROR_CODES.ROOTS_OVERLAP, 'redundant separator alias');
  }
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test('deep linked output ancestor with ordinary immediate parent performs zero writes', async t => {
  const fixture = buildFixture(t, 'deep-link');
  const link = path.join(fixture.outputParent, 'linked');
  const nested = path.join(fixture.ownerRoot, 'ordinary');
  fs.mkdirSync(nested);
  try { fs.symlinkSync(fixture.ownerRoot, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('host denies directory links'); return; }
    throw error;
  }
  const before = snapshotTree(fixture.ownerRoot);
  const realMkdir = fs.promises.mkdir;
  let writes = 0;
  fs.promises.mkdir = async (...args) => { writes++; return realMkdir(...args); };
  try {
    await expectCode(initialise(fixture, { output: path.join(link, 'ordinary', 'new') }),
      INIT_ERROR_CODES.LINK_OR_SPECIAL, 'deep linked ancestor');
  } finally { fs.promises.mkdir = realMkdir; }
  assert.equal(writes, 0);
  assert.deepEqual(snapshotTree(fixture.ownerRoot), before);
});

for (const count of [1, 2]) {
  test('failure after ' + count + ' immutable records removes owned state and keeps foreign collision', async t => {
    const fixture = buildFixture(t, 'partial-state-' + count);
    const output = path.join(fixture.outputParent, 'container');
    const stateDirectory = path.join(output, STATE_DIRECTORY_NAME, 'state');
    const failingPath = count === 1 ? DEPENDENCY_STATE_RELATIVE_PATH : EXPORT_STATE_RELATIVE_PATH;
    const foreign = path.join(output, STATE_DIRECTORY_NAME, ...segments(failingPath));
    const realMkdir = fs.promises.mkdir;
    fs.promises.mkdir = async (target, options) => {
      const result = await realMkdir(target, options);
      if (target === stateDirectory) fs.writeFileSync(foreign, 'FOREIGN-COLLISION');
      return result;
    };
    let error;
    try { error = await expectCode(initialise(fixture, { output }), INIT_ERROR_CODES.STATE_WRITE_FAILED, 'partial publication'); }
    finally { fs.promises.mkdir = realMkdir; }
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'FOREIGN-COLLISION');
    assert.equal(fs.existsSync(path.join(output, STATE_DIRECTORY_NAME, RUN_STATE_RELATIVE_PATH)), false);
    if (count === 2) assert.equal(fs.existsSync(path.join(output, STATE_DIRECTORY_NAME, DEPENDENCY_STATE_RELATIVE_PATH)), false);
    assert.equal(fs.existsSync(path.join(output, STATE_DIRECTORY_NAME, '.storage')), false, 'owned registry/directory removed');
    assert.equal(fs.existsSync(path.join(output, 'workspace')), false);
    assert.equal(error.cleanup?.code, INIT_ERROR_CODES.CLEANUP_FAILED);
    assert.deepEqual(error.cleanup.kept.map(entry => entry.path), [output]);
  });
}

for (const location of ['state-root', 'storage-directory']) {
  test('state publication never adopts foreign insertion in ' + location, async t => {
    const fixture = buildFixture(t, 'state-foreign-' + location);
    const output = path.join(fixture.outputParent, 'container');
    let foreign;
    const realMkdir = fs.promises.mkdir;
    if (location === 'storage-directory') fs.promises.mkdir = async (target, options) => {
      const result = await realMkdir(target, options);
      if (target === path.join(output, STATE_DIRECTORY_NAME, '.storage')) {
        foreign = path.join(target, 'foreign.txt'); fs.writeFileSync(foreign, 'FOREIGN');
      }
      return result;
    };
    let error;
    try {
      error = await expectCode(initialise(fixture, { output,
        beforeStatePublication: observation => {
          fs.writeFileSync(path.join(observation.workspaceRoot, 'README.md'), 'CHANGED');
          if (location === 'state-root') {
            foreign = path.join(observation.stateRoot, 'foreign.txt'); fs.writeFileSync(foreign, 'FOREIGN');
          }
        },
      }), INIT_ERROR_CODES.PUBLICATION_INVALID, 'late failure with foreign state');
    } finally { fs.promises.mkdir = realMkdir; }
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'FOREIGN');
    assert.equal(error.cleanup?.code, INIT_ERROR_CODES.CLEANUP_FAILED);
    for (const record of [RUN_STATE_RELATIVE_PATH, DEPENDENCY_STATE_RELATIVE_PATH, EXPORT_STATE_RELATIVE_PATH])
      assert.equal(fs.existsSync(path.join(output, STATE_DIRECTORY_NAME, record)), false);
  });
}
