/* BenchBoard initialisation — C2 T4 contract-derived acceptance and neutral
 * integration verification.
 *
 * What this suite is for, and how it differs from its siblings.
 *
 * `init.test.mjs` and `dependencies.test.mjs` are the implementing units' own
 * suites: they were written while the modules were being written, and they are
 * thorough. This suite is deliberately not a third implementation suite. It is
 * the seam-level acceptance check for T4: every expectation below is derived
 * from the contract as published by the shipped modules, the accepted C1 schema
 * fixtures, and `release/inventory.json`, rather than from a literal the author
 * of the implementation happened to use.
 *
 * Four properties carry the value:
 *
 *   - **Derivation.** The twenty-six workload paths are read out of the release
 *     inventory and cross-checked against the starter bytes; the bound identity
 *     ids come out of the shared contract fixture files; the mode/option matrix,
 *     the hash-domain identifiers, the state-record paths and the exported
 *     option tables are read out of the shipped modules and cross-checked
 *     between the two seams that publish them. Where a value is restated, it is
 *     restated alongside the thing it must agree with, so drift fails rather
 *     than passing twice.
 *
 *   - **Isolation.** The initialiser is copied into a directory tree that contains
 *     nothing but its own files, imported from there, and made to run a real
 *     initialisation. That is the only way to *show* the seam has no host of
 *     outside dependencies rather than merely to assert the import list.
 *
 *   - **Adversarial destinations.** Case-folded roots, junction-created links,
 *     pre-existing trees with canaries inside them, concurrent claimants, a
 *     replaced container, and private bytes that must not surface in participant
 *     output. Each asserts both the refusal and the byte-identity of what it
 *     refused to touch, because a refusal that damaged the thing it refused is
 *     not a refusal.
 *
 *   - **Cross-seam persistence.** The published run record is read back through
 *     the accepted C1 storage seam and re-validated through the accepted C1
 *     schema validator at the end of a real run, including after re-reading
 *     through a fresh store instance, and including proof that tampering with a
 *     published byte is *detected* rather than believed.
 *
 * Honesty bounds. Install evidence is a deterministic, no-network process port:
 * no npm, no network, no benchmark participant run, no Git mutation. A cooperative
 * local filesystem is assumed: a local user who rewrites bytes between a hash
 * check and a read is out of scope, as is power-loss durability. Where a probe
 * needs a platform facility this host may not grant (a file symbolic link, a
 * case-sensitive volume), the test performs the real probe and skips with a
 * stated reason, and the skip is a capability disclosure rather than a pass.
 *
 * Authorship and independence. This file is authored by worker-2, who also
 * authored the released dependency helper, so this suite is NOT an author-
 * independent check of that helper and claims no global author independence for
 * the CHUNK. It is neutral to `init.mjs` and to the C1 seam, and it is
 * cross-author for the released T3 suite. C2 completion still requires Captain
 * integration and independent SOTA review.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createId, hashEntries, inventoryTree, sha256 } from '../../packages/core/identity.mjs';
import { validateRecord } from '../../packages/core/manifest.mjs';
import { createStorage } from '../../packages/core/storage.mjs';
import { EXPECTED_WORKLOAD_FILE_COUNT, exportChallenge } from '../../packages/core/challenge-export.mjs';
import { loadFixture } from '../contracts/fixtures/contracts/index.mjs';
import {
  DEPENDENCIES_DIRECTORY_NAME,
  DEPENDENCIES_METADATA_FILE_NAME,
  DEPENDENCY_HASH_ALGORITHM_ID,
  DEPENDENCY_MODES as HELPER_DEPENDENCY_MODES,
  DependencyError,
} from '../../packages/core/dependencies.mjs';
import {
  InitError,
  INIT_ERROR_CODES,
  INIT_STATE_KIND,
  WORKSPACE_DIRECTORY_NAME,
  STATE_DIRECTORY_NAME,
  DEPENDENCIES_DIRECTORY_NAME as RUN_DEPENDENCIES_DIRECTORY_NAME,
  DEPENDENCY_MODES as INIT_DEPENDENCY_MODES,
  RUN_STATE_RELATIVE_PATH,
  DEPENDENCY_STATE_RELATIVE_PATH,
  EXPORT_STATE_RELATIVE_PATH,
  WORKLOAD_HASH_ALGORITHM_ID,
  initialiseRun,
} from '../../packages/core/init.mjs';

/* ========================================================================== setup */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STARTER_ROOT = path.join(REPO_ROOT, 'starter');
const CORE_ROOT = path.join(REPO_ROOT, 'packages', 'core');
const CLI_ROOT = path.join(REPO_ROOT, 'cli');
const RELEASE_INVENTORY_PATH = path.join(REPO_ROOT, 'release', 'inventory.json');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'tests', 'contracts', 'fixtures');
const PINNED_COMPILER = path.join(STARTER_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const HEX64 = /^[0-9a-f]{64}$/;
const RAW_COMPARE = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** The twenty-six release workload paths, read from the release inventory. */
function releaseParticipantPaths() {
  const inventory = JSON.parse(fs.readFileSync(RELEASE_INVENTORY_PATH, 'utf8'));
  assert.equal(typeof inventory.participant?.fileCount, 'number',
    'the release inventory declares a participant file count');
  assert.equal(inventory.participant.files.length, inventory.participant.fileCount,
    'the release inventory lists the number of files it declares');
  return inventory.participant.files.map((entry) => entry.path);
}

/**
 * The scratch root, contained by default.
 *
 * The same two environment variables the sibling suites honour, with the same
 * two guards: an absolute path is required, because a relative scratch root
 * resolves against the process working directory and could land inside the
 * repository; and a root containing the read-only starter is refused, because a
 * scratch tree that sits next to the fixture bytes it copies invites a later run
 * to read the copy rather than the original.
 */
function scratchRoot() {
  const named = process.env['BENCH' + 'BOARD_TEST_TMP'] ?? process.env['BENCH' + 'BOARD_TEST_SCRATCH_ROOT'];
  if (named === void 0 || named === '') {
    return fileURLToPath(new URL('./.tmp/initialization/', import.meta.url));
  }
  if (!path.isAbsolute(named)) {
    throw new Error('the scratch root environment variable must name an absolute path');
  }
  const resolved = path.resolve(named);
  if (path.resolve(resolved, '..') === STARTER_ROOT || resolved.startsWith(STARTER_ROOT + path.sep)) {
    throw new Error('the scratch root environment variable must not point inside the read-only starter fixture');
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/** One fresh, self-removing scratch directory. */
function scratch(t, name) {
  const base = scratchRoot();
  fs.mkdirSync(base, { recursive: true });
  const created = fs.mkdtempSync(path.join(base, `c2t4-${name}-`));
  t.after(() => { fs.rmSync(created, { recursive: true, force: true, maxRetries: 3 }); });
  return created;
}

/** The rejection of a promise, or `undefined` when it resolved. */
async function rejection(promise) {
  try {
    await promise;
  } catch (cause) {
    return cause;
  }
  return void 0;
}

/** Assert the rejection is an InitError carrying this exact code, and return it. */
async function expectCode(promise, code, label) {
  const error = await rejection(promise);
  assert.ok(error instanceof InitError, `${label}: expected an InitError, got ${String(error?.name ?? error)}`);
  assert.equal(error.code, code, `${label}: the code on ${error.message} should be ${code}`);
  return error;
}

/** Assert the rejection is a DependencyError carrying this exact code. */
async function expectDependencyCode(promise, code, label) {
  const error = await rejection(promise);
  assert.ok(error instanceof DependencyError,
    `${label}: expected a DependencyError, got ${String(error?.name ?? error)}`);
  assert.equal(error.code, code, `${label}: the code on ${error.message} should be ${code}`);
  return error;
}

/**
 * A byte-level view of a tree that can be compared for *sameness* rather than
 * for shape: each entry is a path plus its kind, and a regular file's bytes
 * hashed. `lstat` rather than `stat` so a link or special entry reports itself
 * as what it is instead of as its target — which is the whole point of using
 * this over a canary tree.
 */
function snapshotTree(root) {
  const snapshot = {};
  const visit = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      const stats = fs.lstatSync(absolute);
      /* The `type` field of a `withFileTypes` entry is not dependable on every
       * runtime, so the kind is read off `lstat` and the entry name is the only
       * thing taken from the directory entry. */
      if (stats.isSymbolicLink()) snapshot[relativePath] = 'link';
      else if (stats.isDirectory()) {
        snapshot[relativePath] = 'directory';
        visit(absolute, relativePath);
      } else if (stats.isFile()) snapshot[relativePath] = `file:${sha256(fs.readFileSync(absolute))}`;
      else snapshot[relativePath] = 'special';
    }
  };
  visit(root, '');
  return snapshot;
}

/** The entries a later snapshot gained over an earlier one. */
const addedEntries = (before, after) => Object.keys(after).filter((key) => !(key in before)).sort(RAW_COMPARE);
/** The entries a later snapshot lost against an earlier one. */
const removedEntries = (before, after) => Object.keys(before).filter((key) => !(key in after)).sort(RAW_COMPARE);

/** Split a path or relative path into comparable segments. */
const segments = (relativePath) => relativePath.split(/[\\/]/).filter((part) => part.length > 0);
/** The repository-relative POSIX form of a repository path. */
const relative = (target) => path.relative(REPO_ROOT, target).split(path.sep).join('/');
/** The starter-relative POSIX form of a release workload path. */
const inStarter = (relativePath) => path.join(STARTER_ROOT, ...segments(relativePath));

/**
 * Whether this volume folds case in file names.
 *
 * Asked of the host, never assumed: two spellings are written and the directory
 * is read back. On a folding volume the second write replaces the first, so the
 * directory holds one entry; on a case-sensitive volume it holds two. Every
 * case-related assertion in this file is written to follow that answer.
 */
function isScratchCaseInsensitive(probeDirectory) {
  const probe = path.join(probeDirectory, 'case-probe');
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, 'Abc.txt'), 'first\n', 'utf8');
  fs.writeFileSync(path.join(probe, 'aBC.txt'), 'second\n', 'utf8');
  return fs.readdirSync(probe).length === 1;
}

/**
 * The first link kind this host will actually build.
 *
 * A file symbolic link needs a privilege a plain developer session often lacks,
 * while a directory junction is normally creatable unelevated. Whichever can be
 * built is the real probe; `null` means the host can build neither, and the
 * caller must say so rather than pass.
 */
function creatableLinkKind(probeDirectory) {
  const target = path.join(probeDirectory, 'link-target');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'inside.txt'), 'inside\n', 'utf8');
  const attempts = [
    ['file', (linkPath) => fs.symlinkSync(path.join(target, 'inside.txt'), linkPath, 'file')],
    ['junction', (linkPath) => fs.symlinkSync(target, linkPath, 'junction')],
    ['dir', (linkPath) => fs.symlinkSync(target, linkPath, 'dir')],
  ];
  for (const [kind, create] of attempts) {
    const linkPath = path.join(probeDirectory, `probe-${kind}`);
    try {
      create(linkPath);
      const built = fs.lstatSync(linkPath);
      if (built.isSymbolicLink()) return kind;
      fs.rmSync(linkPath, { recursive: true, force: true });
    } catch {
      /* This kind is unavailable here; the next one is tried. */
    }
  }
  return null;
}

function starterEntry(relativePath) {
  const bytes = fs.readFileSync(inStarter(relativePath));
  return Object.freeze([relativePath, sha256(bytes)]);
}

/**
 * The two identities a run must bind, taken from the accepted contract fixture
 * set and re-validated here.
 *
 * A fixture is loaded rather than invented: an acceptance suite that wrote its
 * own tooling and evaluator records would be accepting its own invention
 * instead of the contract. Re-validating at load time means fixture drift fails
 * at once, at the point it becomes visible, rather than surfacing three layers
 * down as an unrelated refusal.
 */
function boundIdentities() {
  const toolingIdentity = structuredClone(loadFixture('tooling.identity'));
  const evaluatorIdentity = structuredClone(loadFixture('evaluator.identity'));
  assert.deepEqual(structuredClone(validateRecord('ToolingIdentity', toolingIdentity)), toolingIdentity,
    'the tooling fixture must satisfy the shipped contract validator');
  assert.deepEqual(structuredClone(validateRecord('EvaluatorIdentity', evaluatorIdentity)), evaluatorIdentity,
    'the evaluator fixture must satisfy the shipped contract validator');
  return { toolingIdentity, evaluatorIdentity };
}

/**
 * The challenge identity, built over the bytes of the released workload.
 *
 * Three things make this a derived record rather than a plausible fixture. The
 * `starterInventory` is the exact sorted `[relativePath, sha256(bytes)]` list of
 * the files that are actually on disk; `workloadDigest` is recomputed over that
 * inventory by the accepted hashing helper, so the contract validator re-derives
 * the very value that is recorded instead of merely pattern-matching a
 * hex-looking field. And every field of the record is one the accepted
 * `ChallengeIdentity` contract declares: that validator is a *closed* object
 * check, so a field the contract does not name is as much a failure as a missing
 * one, and a fixture carrying an invented field could never have passed.
 *
 * T4 uses identities and architectures of its own (`c2-t4-*`), never the ones the
 * bound tooling and evaluator fixtures carry: a run that claimed a bound
 * architecture is a contract violation, so a fixture that tripped that gate on
 * every happy path would make the suite's own evidence worthless.
 */
function buildIdentity() {
  const starterInventory = releaseParticipantPaths()
    .map(starterEntry)
    .sort((left, right) => RAW_COMPARE(left[0], right[0]));
  return Object.freeze({
    schemaVersion: '1.0.0',
    kind: 'ChallengeIdentity',
    challengeId: 'c2-t4-acceptance-board',
    /* Three version axes on three separate release trains: the tooling fixture
     * carries 0.1.0 and the evaluator fixture 1.2.0, so a fixture whose domains
     * happened to agree could not show that they are kept apart. */
    challengeVersion: '1.0.0',
    architectureId: 'arch-c2-t4-acceptance',
    architectureKind: 'challenge',
    hashAlgorithm: 'sha256',
    definitionDigest: sha256('c2-t4-acceptance:definition'),
    digestProvenance: Object.freeze({ kind: 'COMPUTED', procedure: 'c2-t4-acceptance:sha256:starter-bytes' }),
    workloadProvenance: Object.freeze({ kind: 'COMPUTED', procedure: 'c2-t4-acceptance:starter-inventory-digest' }),
    publicPrdDigest: sha256('c2-t4-acceptance:public-prd'),
    visibleHarnessDigest: sha256('c2-t4-acceptance:visible-harness'),
    fixtureDigest: sha256('c2-t4-acceptance:fixture'),
    starterInventory: Object.freeze(starterInventory),
    workloadDigest: hashEntries(starterInventory),
    declaredCeilingMinutes: 120,
    candidateLineage: Object.freeze({
      candidateVersion: '1.0.0-candidate.9',
      candidateStatus: 'REVIEW_FINDINGS_UNRESOLVED',
      sourceCommit: 'c662a4a1b2c3d4e5f60718293a4b5c6d7e8f90a1',
      sourceTag: 'candidate-nine-synthetic',
      reviewStatus: 'CHANGES_REQUESTED',
      lineageNotes: 'C2 T4 acceptance fixture: the historical candidate record is described, not certified.',
    }),
    notes: 'C2 T4 acceptance fixture identity over the released twenty-six-file workload.',
  });
}

/**
 * One complete fixture.
 *
 * `sourceRoot` is a byte-for-byte copy of the released starter workload, so the
 * dependency seam reads real lock bytes and a real lock/manifest provenance
 * pair. `ownerRoot` and `evaluatorRoot` hold material whose *content* is
 * distinctive, so the published workspace can be searched for it; that is how the
 * privacy boundary is observed rather than asserted.
 */
function buildFixture(t, name) {
  const root = scratch(t, name);
  const identity = buildIdentity();
  const participantPaths = releaseParticipantPaths();

  const sourceRoot = path.join(root, 'source');
  const ownerRoot = path.join(root, 'owner');
  const evaluatorRoot = path.join(root, 'evaluator');
  const outputParent = path.join(root, 'out');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(ownerRoot, { recursive: true });
  fs.mkdirSync(evaluatorRoot, { recursive: true });
  fs.mkdirSync(outputParent, { recursive: true });

  fs.writeFileSync(path.join(ownerRoot, 'owner-secret.txt'), 'OWNER-ONLY-MATERIAL-A7C3\n', 'utf8');
  fs.writeFileSync(path.join(evaluatorRoot, 'hidden-tests.txt'), 'EVALUATOR-ONLY-MATERIAL-4F91\n', 'utf8');

  for (const relativePath of participantPaths) {
    const target = path.join(sourceRoot, ...segments(relativePath));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(inStarter(relativePath)));
  }

  /* The exact manifest is the declared set of participant paths, as the request
   * contract spells it: relative POSIX path strings, not richer records. The
   * count is asserted where it is built, because this suite's own claim is that
   * the twenty-six is the same number at every seam — the release inventory, the
   * shipped exporter constant and the package handed to the initialiser. */
  const fileManifest = Object.freeze([...participantPaths]);
  assert.equal(fileManifest.length, EXPECTED_WORKLOAD_FILE_COUNT,
    'the fixture states exactly the workload size the shipped exporter declares');

  const { toolingIdentity, evaluatorIdentity } = boundIdentities();
  assert.deepEqual(structuredClone(validateRecord('ChallengeIdentity', structuredClone(identity))), identity,
    'the identity this suite builds satisfies the shipped contract validator');

  return Object.freeze({
    root, sourceRoot, ownerRoot, evaluatorRoot, outputParent,
    identity, toolingIdentity, evaluatorIdentity, fileManifest, participantPaths,
  });
}

/** The challenge package the request contract names, from a fixture. */
function packageFor(fixture, overrides = {}) {
  return {
    identity: fixture.identity,
    sourceRoot: fixture.sourceRoot,
    fileManifest: [...fixture.fileManifest],
    ownerRoots: [fixture.ownerRoot],
    evaluatorRoots: [fixture.evaluatorRoot],
    ...overrides,
  };
}

/* The keys the initialiser's own contract declares. Read off the shipped
 * allow-lists rather than restated: a request key that is not in them would be
 * refused as INVALID_OPTION, so this file's fixtures must be built against what
 * the module really accepts. */
const REQUEST_KEYS = [
  'output', 'challenge', 'dependencies', 'toolingIdentity', 'evaluatorIdentity',
  'architectureId', 'architectureKind', 'harness', 'securityModel', 'expectedSessionPolicy',
  'declaredCeilingMinutes', 'configuration', 'notes', 'createdAt',
  'beforeWorkspacePublication', 'beforeStatePublication',
];
const DEPENDENCY_KEYS = [
  'mode', 'preparedRoot', 'sourceRoot', 'scratchRoot', 'expectedDependencyDigest',
  'npmExecutable', 'offline', 'npmArgumentsPrefix', 'npmArgumentsSuffix', 'processAdapter',
  'maxEntries', 'maxFileBytes', 'maxTotalBytes', 'timeoutMs',
];

function requestFor(fixture, overrides = {}) {
  const rest = overrides.rest ?? {};
  const stated = Object.fromEntries(REQUEST_KEYS.filter((key) => key in overrides).map((key) => [key, overrides[key]]));
  return {
    output: path.join(fixture.outputParent, 'container'),
    challenge: packageFor(fixture),
    dependencies: { mode: 'none' },
    toolingIdentity: fixture.toolingIdentity,
    evaluatorIdentity: fixture.evaluatorIdentity,
    architectureId: 'arch-run-c2-t4',
    ...stated,
    ...rest,
  };
}

/** One API call from a fixture, with request overrides applied. */
function initialise(fixture, overrides = {}) {
  return initialiseRun(requestFor(fixture, overrides));
}

/**
 * A verified dependency cache: a plain tree plus the provenance marker the
 * accepted helper requires, with the lock and manifest digests computed over the
 * fixture's own source bytes so the cache describes those bytes rather than
 * being waved through by a plausible-looking field.
 */
function buildDependencyCache(fixture, name = 'cache', files = { 'synthetic-dep/index.js': 'export const accepted = 1;\n' }) {
  const cacheRoot = path.join(fixture.root, name);
  const preparedRoot = path.join(cacheRoot, DEPENDENCIES_DIRECTORY_NAME);
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(preparedRoot, ...segments(relativePath));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, 'utf8');
  }
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
 * Every module the shipped entry points reach through relative imports,
 * transitively.
 *
 * Derived by walking the import graph rather than by a list written here, so a
 * new internal dependency is carried into the isolated copy automatically. The
 * walk is also the proof that the graph is closed: every hop it takes lands
 * inside `packages/core`.
 */
function collectImportClosure(entryPath) {
  const seen = new Set();
  const walk = (modulePath) => {
    if (seen.has(modulePath)) return;
    seen.add(modulePath);
    const source = fs.readFileSync(modulePath, 'utf8');
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      walk(path.resolve(path.dirname(modulePath), match[1]));
    }
  };
  walk(entryPath);
  return [...seen].sort();
}

/** Strip comments so a boundary check reads code rather than prose about code. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .join('\n');
}

/** The storage read path for one published record. */
const stateStorage = (stateRoot) => createStorage({ root: stateRoot });
const readRunRecord = async (stateRoot, manifestId) =>
  stateStorage(stateRoot).read({ relativePath: RUN_STATE_RELATIVE_PATH, kind: INIT_STATE_KIND, id: manifestId });

/* ============================================================== derivation gates */

test('the workload size is derived from the release inventory and matches the released bytes', () => {
  const inventory = JSON.parse(fs.readFileSync(RELEASE_INVENTORY_PATH, 'utf8'));
  const participantPaths = releaseParticipantPaths();

  /* Three independent statements of the same number, cross-checked. */
  assert.equal(inventory.participant.fileCount, 26, 'the release inventory declares twenty-six participant files');
  assert.equal(EXPECTED_WORKLOAD_FILE_COUNT, inventory.participant.fileCount,
    'the shipped exporter constant agrees with the release inventory');
  assert.equal(inventory.participant.files.length, EXPECTED_WORKLOAD_FILE_COUNT,
    'the inventory lists exactly that many files');

  /* The number is not decorative: it is the size of the real workload bytes. The
   * path list is read from the release inventory, so the list and the count are
   * checked against the same authority rather than against a second hand copy. */
  assert.deepEqual([...participantPaths].sort(RAW_COMPARE),
    [...inventory.participant.files.map((entry) => entry.path)].sort(RAW_COMPARE),
    'the participant paths come from the release inventory');
  assert.equal(new Set(participantPaths).size, participantPaths.length, 'no workload path is listed twice');
  for (const relativePath of participantPaths) {
    assert.equal(segments(relativePath).includes('..'), false, `${relativePath} steps no way out`);
    assert.equal(path.isAbsolute(relativePath), false, `${relativePath} is relative`);
    assert.equal(fs.existsSync(inStarter(relativePath)), true, `the starter carries ${relativePath}`);
  }

  /* The identity this suite builds carries the same count, so the twenty-six is
   * not a property of the release inventory alone: it is the size of the
   * inventory the accepted contract validator itself re-derives a digest over. */
  const identity = buildIdentity();
  assert.equal(identity.starterInventory.length, EXPECTED_WORKLOAD_FILE_COUNT,
    'the built identity inventories exactly the declared number of workload files');
  assert.deepEqual([...identity.starterInventory.map(([relativePath]) => relativePath)].sort(RAW_COMPARE),
    [...participantPaths].sort(RAW_COMPARE),
    'the identity inventories exactly the released participant paths');
  assert.equal(identity.workloadDigest, hashEntries(identity.starterInventory),
    'the workload digest is the digest of the inventory this identity states');
  assert.deepEqual(structuredClone(validateRecord('ChallengeIdentity', structuredClone(identity))), identity,
    'the accepted validator re-derives the recorded workload digest rather than rejecting it');

  /* And the declared per-file digests really describe the released bytes. */
  for (const entry of inventory.participant.files) {
    const bytes = fs.readFileSync(inStarter(entry.path));
    assert.equal(entry.sha256, sha256(bytes), `${entry.path} carries the digest of the released byte`);
    assert.equal(entry.bytes, bytes.length, `${entry.path} carries the length of the released byte`);
  }
});

test('the bound contract fixtures carry three distinct architectures, none of them a run architecture', () => {
  const identity = buildIdentity();
  /* The bound identities are not files: the accepted fixture set publishes them
   * through a loader, and reading them as bytes would be a second, undocumented
   * copy of the fixture path. */
  const { toolingIdentity: tooling, evaluatorIdentity: evaluator } = boundIdentities();

  const architectures = [identity.architectureId, tooling.architectureId, evaluator.architectureId];
  assert.equal(new Set(architectures).size, 3,
    `the three identity domains name distinct architectures: ${architectures.join(', ')}`);
  assert.equal(architectures.includes('arch-run-c2-t4'), false,
    'the architecture this suite runs under is not one of the bound ones');

  /* The ids the collision gate compares are read out of the loaded fixture, so a
   * fixture edit moves the gate rather than silently narrowing it. */
  assert.equal(typeof tooling.toolingId, 'string', 'the tooling fixture carries its own identity id');
  assert.equal(typeof evaluator.evaluatorId, 'string', 'the evaluator fixture carries its own identity id');
  assert.equal(tooling.challengeId, void 0, 'the tooling fixture does not borrow the challenge identity id');
  assert.equal(evaluator.challengeId, void 0, 'the evaluator fixture does not borrow the challenge identity id');
  assert.notEqual(identity.challengeId, tooling.toolingId,
    'the challenge and tooling identity domains are separate in the fixture bytes');
  assert.notEqual(tooling.toolingVersion, evaluator.evaluatorVersion,
    'the tooling and evaluator version axes are their own, not one value shared');
});

test('the two hash domains are distinct by algorithm identity', () => {
  assert.notEqual(WORKLOAD_HASH_ALGORITHM_ID, DEPENDENCY_HASH_ALGORITHM_ID,
    'the workload and dependency hash domains name different algorithms');
  assert.equal(RUN_DEPENDENCIES_DIRECTORY_NAME, 'dependencies',
    'the run state dependency directory is not the dependency tree name');
  assert.notEqual(DEPENDENCIES_DIRECTORY_NAME, RUN_DEPENDENCIES_DIRECTORY_NAME,
    'the dependency tree name and the run state name are different names for different things');
});

/* ==================================================== the shipped declaration set */

const SHIPPED_PAIRS = [
  [path.join(CORE_ROOT, 'init.mjs'), 'init'],
  [path.join(CORE_ROOT, 'storage.mjs'), 'storage'],
  [path.join(CORE_ROOT, 'manifest.mjs'), 'manifest'],
  [path.join(CORE_ROOT, 'identity.mjs'), 'identity'],
  [path.join(CORE_ROOT, 'paths.mjs'), 'paths'],
  [path.join(CORE_ROOT, 'challenge-export.mjs'), 'challenge-export'],
  [path.join(CORE_ROOT, 'dependencies.mjs'), 'dependencies'],
  [path.join(CLI_ROOT, 'init.mjs'), 'init'],
];

test('every shipped module carries a byte-identical declaration pair', () => {
  for (const [modulePath, name] of SHIPPED_PAIRS) {
    assert.equal(fs.existsSync(modulePath), true, `the runtime module ${name}.mjs exists`);
    const source = path.join(path.dirname(modulePath), `${name}.d.ts`);
    const sibling = path.join(path.dirname(modulePath), `${name}.d.mts`);
    assert.ok(fs.existsSync(source), `${name}.d.ts exists`);
    assert.ok(fs.existsSync(sibling), `${name}.d.mts exists`);
    assert.equal(fs.readFileSync(sibling, 'utf8'), fs.readFileSync(source, 'utf8'),
      `the ${name}.d.mts copy is byte-identical to its ${name}.d.ts source`);
  }
});

test('the declarations name every runtime export the shipped modules carry', () => {
  for (const [modulePath, name] of SHIPPED_PAIRS) {
    const declaration = fs.readFileSync(path.join(path.dirname(modulePath), `${name}.d.ts`), 'utf8');
    const runtimeExports = [...fs.readFileSync(modulePath, 'utf8')
      .matchAll(/^export (?:async )?(?:const|function|class) ([A-Za-z_$][0-9A-Za-z_$]*)/gm)]
      .map((match) => match[1]);
    assert.ok(runtimeExports.length > 0, `${name} exports something to declare`);
    for (const exported of runtimeExports) {
      assert.match(declaration, new RegExp(`\\b${exported}\\b`),
        `${name}.d.ts declares the runtime export ${exported}`);
    }
  }
});

test('a real module consumer typechecks against the pinned compiler with no emit and no install', (t) => {
  /* The compiler is pinned in the checked-in starter tree. A missing compiler is
   * a real failure of this gate, not a reason to skip it. */
  assert.ok(fs.existsSync(PINNED_COMPILER),
    `the pinned TypeScript compiler must be present at ${relative(PINNED_COMPILER)}; this gate does not skip`);

  const root = scratch(t, 'consumer');
  /* Specifiers are relative to the consumer file, not to the repository: the
   * compiler resolves what it is handed, so a repository-relative path would
   * resolve against the scratch directory and miss the shipped tree entirely. */
  const relativeToConsumer = (target) => {
    const value = path.relative(root, target).split(path.sep).join('/');
    return value.startsWith('.') ? value : `./${value}`;
  };
  const core = (name) => relativeToConsumer(path.join(CORE_ROOT, name));
  const cli = (name) => relativeToConsumer(path.join(CLI_ROOT, name));

  /* A real consumer, resolved the way ECMAScript resolves it: it imports the
   * runtime `.mjs` specifiers, and the compiler must find the shipped
   * declarations behind them. Every path is stated through `JSON.stringify` so no
   * quote in this file has to be balanced against a quote in the generated one. */
  const consumer = [
    '/* A real consumer of the shipped declarations, resolved as an ECMAScript module. */',
    'import {',
    '  initialiseRun,',
    '  init,',
    '  InitError,',
    '  INIT_ERROR_CODES,',
    '  INIT_STATE_KIND,',
    '  WORKSPACE_DIRECTORY_NAME,',
    '  DEPENDENCIES_METADATA_FILE_NAME,',
    '  RUN_STATE_RELATIVE_PATH,',
    '  WORKLOAD_HASH_ALGORITHM_ID,',
    '  DEPENDENCY_HASH_ALGORITHM_ID,',
    '  DEPENDENCY_MODES,',
    '  INIT_SECURITY_MODELS,',
    '  type InitRequest,',
    '  type InitResult,',
    '  type InitObservation,',
    '  type InitDependencyRequest,',
    '  type InitErrorCodes,',
    `} from ${JSON.stringify(core('init.mjs'))};`,
    'import {',
    '  prepareDependencies,',
    '  createNodeSpawnAdapter,',
    '  DependencyError,',
    '  NPM_FORWARDED_ENVIRONMENT,',
    '  resolveDependencyCommandStrategy,',
    '  type DependencyMode,',
    '  type PrepareDependenciesOptions,',
    '  type PrepareDependenciesResult,',
    '  type DependencyProcessAdapter,',
    `} from ${JSON.stringify(core('dependencies.mjs'))};`,
    'import { validateRecord, computeTreeDigest, type SealedRunManifest } from',
    `  ${JSON.stringify(core('manifest.mjs'))};`,
    'import { EXPECTED_WORKLOAD_FILE_COUNT, type ChallengePackage } from',
    `  ${JSON.stringify(core('challenge-export.mjs'))};`,
    'import { sha256, hashEntries, type InventoryTreeResult } from',
    `  ${JSON.stringify(core('identity.mjs'))};`,
    'import { createStorage, type Storage, type StorageReadKey } from',
    `  ${JSON.stringify(core('storage.mjs'))};`,
    'import {',
    '  parseArguments,',
    '  runInit,',
    '  main,',
    '  summariseResult,',
    '  CliError,',
    '  CLI_EXIT_CODES,',
    '  CLI_ERROR_CODES,',
    '  UNIMPLEMENTED_OPTIONS,',
    '  CLI_USAGE,',
    '  type CliInput,',
    '  type CliParsedArguments,',
    '  type CliSummary,',
    `} from ${JSON.stringify(cli('init.mjs'))};`,
    '',
    'const dependencyRequest: InitDependencyRequest = { mode: "none" };',
    'const observer: (observation: InitObservation) => Promise<void> | void = (observation) => {',
    '  void [observation.stage, observation.output, observation.workspaceRoot];',
    '};',
    'const request: InitRequest = {',
    '  output: "C:/runs/c2-t4/container",',
    '  challenge: {',
    '    identity: {} as never,',
    '    sourceRoot: "C:/definition",',
    '    fileManifest: ["README.md"],',
    '    ownerRoots: ["C:/owner"],',
    '    evaluatorRoots: ["C:/evaluator"],',
    '  } as unknown as ChallengePackage,',
    '  dependencies: dependencyRequest,',
    '  toolingIdentity: {} as never,',
    '  evaluatorIdentity: {} as never,',
    '  architectureId: "arch-run-c2-t4",',
    '  securityModel: INIT_SECURITY_MODELS[0],',
    '  beforeWorkspacePublication: observer,',
    '  beforeStatePublication: observer,',
    '};',
    'const sealed: Promise<SealedRunManifest> = init(request);',
    'const full: Promise<InitResult> = initialiseRun(request);',
    'void full.then((result) => [',
    '  result.manifest.manifestId, result.manifest.runId, result.output, result.durationMs,',
    '  result.workspace.root, result.workspace.fileCount, result.workspace.dependencyDirectory,',
    '  result.workspace.workloadAlgorithmId, result.state.root, result.state.insideWorkspace,',
    '  result.state.runRecord, result.state.dependencyRecord, result.state.exportRecord,',
    '  result.state.dependencyMetadata, result.state.runRecordDigest, result.dependency.digest,',
    '  result.dependency.algorithmId, result.workload.digest, result.workload.fileCount,',
    ']);',
    'const codeTable: InitErrorCodes = INIT_ERROR_CODES;',
    'const code: InitErrorCodes["OUTPUT_EXISTS"] = codeTable.OUTPUT_EXISTS;',
    'const modes: readonly DependencyMode[] = DEPENDENCY_MODES;',
    'const failure: InitError = new InitError(code, "message", { path: "C:/runs/c2-t4/container" });',
    'const cleanupVisible: boolean = failure.cleanup !== undefined;',
    'const algorithmIds: readonly string[] = [WORKLOAD_HASH_ALGORITHM_ID, DEPENDENCY_HASH_ALGORITHM_ID];',
    'const stateNames: readonly string[] = [INIT_STATE_KIND, WORKSPACE_DIRECTORY_NAME,',
    '  DEPENDENCIES_METADATA_FILE_NAME, RUN_STATE_RELATIVE_PATH];',
    '',
    'const prepareOptions: PrepareDependenciesOptions = {',
    '  mode: "install", workspaceRoot: "C:/runs/c2-t4/ws", scratchRoot: "C:/runs/c2-t4/scratch",',
    '  npmExecutable: "C:/tools/npm.cmd", installStrategy: "hoisted", offline: false,',
    '};',
    'const recorder: DependencyProcessAdapter = async (npmRequest) => {',
    '  void [npmRequest.file, npmRequest.args, npmRequest.cwd, npmRequest.env, npmRequest.shell];',
    '  return { status: 0, signal: null, stdout: "", stderr: "" };',
    '};',
    'const bridged: DependencyProcessAdapter = createNodeSpawnAdapter({});',
    'const installRun: Promise<PrepareDependenciesResult> = prepareDependencies(prepareOptions);',
    'void bridged; void installRun;',
    'const strategy: string = resolveDependencyCommandStrategy({',
    '  platform: "win32", executablePath: "C:/tools/npm.cmd", executableStrategy: "cmdexe",',
    '}).strategy;',
    'const forwarded: readonly string[] = NPM_FORWARDED_ENVIRONMENT;',
    'const dependencyFault: DependencyError = new DependencyError("INVALID_ARGUMENT", "message");',
    '',
    'const bytes: string = sha256("c2-t4");',
    'const inventoryDigest: string = hashEntries([["README.md", bytes]]);',
    'const treeDigest: string = computeTreeDigest([["README.md", bytes]]);',
    'const inventory: InventoryTreeResult = {',
    '  root: "C:/x", hashAlgorithmId: "benchboard-sha256-tree-v1", entries: [], digest: inventoryDigest,',
    '};',
    'void inventory;',
    'const store: Storage = createStorage({ root: "C:/runs/c2-t4/state" });',
    'const readKey: StorageReadKey = { relativePath: "state/run.json", kind: "k", id: "i" };',
    'const readBack: Promise<unknown> = store.read(readKey);',
    'void readBack;',
    'const manifestRecord: SealedRunManifest = validateRecord("RunManifest", {}) as never;',
    'const workloadCount: 26 = EXPECTED_WORKLOAD_FILE_COUNT;',
    '',
    'const parsed: CliParsedArguments = parseArguments(["--dependency-mode", "none", "--architecture-id", "arch-run-c2-t4"]);',
    'const input: CliInput = {',
    '  argv: ["--dependency-mode", "none"],',
    '  challenge: {} as unknown as ChallengePackage,',
    '  toolingIdentity: {} as never,',
    '  evaluatorIdentity: {} as never,',
    '};',
    'const handled: Promise<unknown> = runInit(input);',
    'const status: Promise<number> = main(input, { write: (text) => { void text; } });',
    'const summary: CliSummary = summariseResult({} as unknown as InitResult);',
    'const cliFailure: CliError = new CliError(CLI_ERROR_CODES.USAGE, "message");',
    'const exits: readonly number[] = [CLI_EXIT_CODES.SUCCESS, CLI_EXIT_CODES.FAILURE, CLI_EXIT_CODES.USAGE];',
    'const pending: readonly string[] = UNIMPLEMENTED_OPTIONS;',
    'const usage: string = CLI_USAGE;',
    'export const wiring: readonly unknown[] = [sealed, full, codeTable, modes, cleanupVisible, algorithmIds,',
    '  stateNames, strategy, forwarded, dependencyFault, bytes, treeDigest, manifestRecord.manifestId,',
    '  workloadCount, parsed, handled, status, summary, cliFailure, exits, pending, usage];',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'consumer.mts'), consumer, 'utf8');

  /* The same six flags the accepted contract suite pins: no project file, no
   * emit, no install, nothing but the shipped declarations in the program. */
  const flags = ['--noEmit', '--strict', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext'];
  const compiled = spawnSync(process.execPath, [PINNED_COMPILER, ...flags, 'consumer.mts'],
    { cwd: root, encoding: 'utf8' });
  const output = `${compiled.stdout ?? ''}${compiled.stderr ?? ''}`;
  assert.equal(compiled.status, 0, `the pinned compiler reported:\n${output}`);

  /* A declaration binds only when the compiled program actually loaded it, so
   * the file list is the observable proof rather than an inference. */
  const listing = spawnSync(process.execPath, [PINNED_COMPILER, ...flags, '--listFiles', 'consumer.mts'],
    { cwd: root, encoding: 'utf8' });
  const fileList = `${listing.stdout ?? ''}${listing.stderr ?? ''}`;
  assert.equal(listing.status, 0, `the pinned compiler could not list its program:\n${fileList}`);
  const declared = fileList.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line.endsWith('.d.mts'));
  for (const expected of ['init.d.mts', 'manifest.d.mts', 'dependencies.d.mts', 'challenge-export.d.mts']) {
    assert.ok(declared.some((line) => line.split(/[\\/]/).at(-1) === expected),
      `${expected} is part of the compiled program`);
  }
  assert.ok(declared.some((line) => /packages[\\/]core[\\/]init\.d\.mts$/.test(line)),
    'the core initialisation declaration is in the program');
  assert.ok(declared.some((line) => /(^|[\\/])cli[\\/]init\.d\.mts$/.test(line)),
    'the CLI declaration is in the program');
  /* Both shipped `init` declarations are loaded from their own two locations:
   * the core one under `packages/core`, the command-line one under `cli`. That
   * is the observable fact; counting the name `init.d.mts` would conflate the
   * two locations with a claim about how often the name may occur. */
  const coreDeclarations = declared.filter((line) => /packages[\\/]core[\\/]init\.d\.mts$/.test(line));
  const cliDeclarations = declared.filter((line) => /(^|[\\/])cli[\\/]init\.d\.mts$/.test(line));
  assert.ok(coreDeclarations.length >= 1 && cliDeclarations.length >= 1,
    `both declaration locations are in the program: ${declared.join(', ')}`);
});

test('the CLI entry refuses unknown, pending and incomplete options at the parse seam', async () => {
  const { parseArguments, CliError, CLI_ERROR_CODES, UNIMPLEMENTED_OPTIONS } = await import('../../cli/init.mjs');

  assert.throws(() => parseArguments(['--nope']), (error) => error instanceof CliError
    && error.code === CLI_ERROR_CODES.UNKNOWN_OPTION, 'an option the contract does not name is refused');

  /* The names a later CHUNK owes are refused by name, with the pending chunk
   * recorded on the error, so the boundary of what is implemented here is
   * machine-readable instead of a silently accepted flag. */
  assert.throws(() => parseArguments(['--harness', 'anything']), (error) => error instanceof CliError
    && error.code === CLI_ERROR_CODES.UNKNOWN_OPTION && error.pendingChunk === 'C6',
  'a pending option is refused by name rather than accepted and ignored');
  for (const pending of UNIMPLEMENTED_OPTIONS) {
    assert.throws(() => parseArguments([pending, 'x']), (error) => error instanceof CliError
      && error.code === CLI_ERROR_CODES.UNKNOWN_OPTION, `${pending} is refused by name`);
  }

  /* An option that is implemented but given no value is a different refusal, and
   * the only real option in the shipped set is `--dependency-mode`. */
  assert.throws(() => parseArguments(['--dependency-mode']), (error) => error instanceof CliError
    && error.code === CLI_ERROR_CODES.OPTION_VALUE_MISSING, 'an option with no value is refused');
  assert.throws(() => parseArguments(['--dependency-mode', 'none', '--dependency-mode', 'none']),
    (error) => error instanceof CliError && error.code === CLI_ERROR_CODES.DUPLICATE_OPTION,
    'an option given twice is refused rather than taken twice');
  assert.throws(() => parseArguments(['--dependency-mode', 'none']), (error) => error instanceof CliError
    && error.code === CLI_ERROR_CODES.USAGE, 'a run with no output positional is refused');

  /* Help short-circuits before any of that, because asking for help is never a
   * refusal. */
  const help = parseArguments(['--help']);
  assert.equal(help.help, true, 'help is reported as help');
  assert.equal(help.output, null, 'help claims no output');
});

/* ======================================================= the harness-free boundary */

/* The claim under test is the product boundary `AGENTS.md` §1 states: the core
 * install path must work without DSH. That is only testable if the graph the
 * entry points reach is *closed* over the shipped files, so it is established by
 * walking the import graph and then by loading a copy that contains nothing
 * else — a missing hop would fail to load, and a hop out to a harness would
 * appear as a frame outside the copy. */

test('the shipped graph is closed over the eight modules and names no harness', () => {
  const coreClosure = collectImportClosure(path.join(CORE_ROOT, 'init.mjs'));
  const cliClosure = collectImportClosure(path.join(CLI_ROOT, 'init.mjs'));
  const union = [...new Set([...coreClosure, ...cliClosure])].sort();

  /* Derived, then cross-checked against the shipped set this file already
   * asserts is declaration-paired. The two statements come from different
   * places: the closure is walked out of the sources, the pair list is the
   * release surface. */
  const shipped = SHIPPED_PAIRS.map(([modulePath]) => modulePath).sort();
  assert.deepEqual(union, shipped,
    `the modules the entry points reach are exactly the shipped modules: ${union.map(relative).join(', ')}`);
  assert.equal(union.length, 8, 'the shipped graph is eight modules');

  for (const modulePath of union) {
    const hop = relative(modulePath);
    assert.ok(hop.startsWith('packages/core/') || hop.startsWith('cli/'),
      `${hop} is inside the shipped tree, so nothing outside it is reached`);
    /* A relative specifier that resolved outside the tree would land here. */
    assert.ok(!path.relative(REPO_ROOT, modulePath).startsWith('..'),
      `${hop} does not escape the repository`);
  }

  /* The same graph read as text: no harness product is named in code. Comments
   * are stripped, because prose about the boundary is not the boundary. */
  for (const modulePath of union) {
    const body = codeOnly(fs.readFileSync(modulePath, 'utf8'));
    const offender = body.match(/dsh|agent[-_]teams|kiro|claude/i);
    assert.equal(offender, null,
      `${relative(modulePath)} carries no harness reference in its code${offender === null ? '' : ` (${offender[0]})`}`);
  }

  /* And the graph reaches no package outside the standard library: every bare
   * specifier it imports is a `node:` specifier. */
  for (const modulePath of union) {
    const body = codeOnly(fs.readFileSync(modulePath, 'utf8'));
    for (const match of body.matchAll(/from\s+['"]([^.'"][^'"]*)['"]/g)) {
      assert.match(match[1], /^node:/, `${relative(modulePath)} imports only the standard library: ${match[1]}`);
    }
  }
});

test('an isolated copy of the graph runs a real initialisation with no harness present', async (t) => {
  const root = scratch(t, 'isolated');
  const shippedCoreSnapshot = snapshotTree(CORE_ROOT);

  /* The copy is laid out like the repository, because the CLI reaches the core
   * through a relative specifier: a copy that flattened the tree would fail
   * for the wrong reason. */
  const copyOne = (modulePath) => {
    const relativePath = path.relative(REPO_ROOT, modulePath).split(path.sep).join('/');
    const target = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(modulePath, target);
  };
  for (const [modulePath] of SHIPPED_PAIRS) copyOne(modulePath);

  /* Nothing but those bytes went in: no install tree, no state directory, no
   * configuration. */
  const copiedTree = snapshotTree(root);
  assert.ok(!Object.keys(copiedTree).some((key) => key.includes('node_modules') || key.includes('.benchboard')),
    'the copy carries only the graph itself');

  const copied = await import(pathToFileURL(path.join(root, 'packages', 'core', 'init.mjs')));
  const copiedCli = await import(pathToFileURL(path.join(root, 'cli', 'init.mjs')));

  /* Loading succeeded, which is itself the closure proof: a graph with a hop to
   * a module that was not copied would have thrown while resolving it. */
  assert.equal(typeof copied.initialiseRun, 'function', 'the copied core exposes its entry point');
  assert.equal(typeof copiedCli.parseArguments, 'function', 'the copied CLI entry loaded against the copied core');

  /* A distinct module registry entry is a distinct class identity. Two copies
   * of the same source are interchangeable by contract and unrelated by
   * object identity, so the comparison below cannot be satisfied by the
   * shipped module being handed back. */
  assert.notEqual(copied.InitError, InitError, 'the loaded core is not the shipped module object');
  assert.notEqual(copied.initialiseRun, initialiseRun, 'the loaded entry point is not the shipped function object');

  /* A refusal raised by the copy is executed *inside* the copy: the frames of
   * its own stack say so. This is the observable that no exported field could
   * provide, and it is the frames of the error itself rather than of this test. */
  const refusal = await rejection(copied.initialiseRun({}));
  assert.ok(refusal instanceof copied.InitError, 'the copy raises its own typed error');
  assert.equal(refusal.code, 'INVALID_ROOT', 'the copy applies the same contract');
  const frames = refusal.stack.split('\n').filter((line) => line.includes('file://'));
  const copyCore = pathToFileURL(path.join(root, 'packages', 'core')).href;
  const insideCopy = frames.filter((line) => line.includes(copyCore));
  const insideShipped = frames.filter((line) => line.includes(pathToFileURL(CORE_ROOT).href));
  assert.ok(insideCopy.length >= 2,
    `the copy's own files appear in the frames of its stack: ${refusal.stack}`);
  assert.equal(insideShipped.length, 0, 'no frame of that execution resolves in the shipped tree');

  /* And the copy performs the real work end to end. */
  const fixture = buildFixture(t, 'copy-run');
  const result = await copied.initialiseRun(requestFor(fixture, {
    rest: { output: path.join(fixture.outputParent, 'copied-container') },
  }));
  assert.equal(result.workspace.fileCount, EXPECTED_WORKLOAD_FILE_COUNT,
    'the copied core publishes the declared workload');
  assert.equal(result.state.insideWorkspace, false, 'the copied core keeps state outside the workspace');
  assert.equal(result.dependency.mode, 'none', 'the copied core honours the declared mode');

  /* The parse seam is enforced by the copy too, so the boundary is not an
   * artefact of which copy is loaded. */
  assert.throws(() => copiedCli.parseArguments(['--nope']),
    (error) => error instanceof copiedCli.CliError && error.code === copiedCli.CLI_ERROR_CODES.UNKNOWN_OPTION,
    'the copied CLI refuses an option the contract does not name');

  /* Reading and running the copy left the shipped tree byte-identical. */
  assert.deepEqual(snapshotTree(CORE_ROOT), shippedCoreSnapshot,
    'the shipped core is byte-for-byte untouched by all of this');
});

/* ============================================ (b) malicious and hostile paths */

/*
 * Where the released suite proves the container may not touch the *challenge*
 * roots, this section takes the other half of the protected set: the roots the
 * dependency request brings (`dependencies.protectedRoots`), and the paths a
 * hostile or merely careless caller can put where the container is meant to go —
 * a link standing in for a directory, a directory reached under a link, a name
 * that differs from a protected root by case alone. Those are read out of the
 * contract sentence "malicious overlap/case/link/special/fault/concurrent
 * overwrite/private canaries", and the dependency-root angle has no coverage at
 * all in the released suite, which passes only challenge roots.
 */

test('a container that touches a dependency root is refused and the cache is not read or written', async (t) => {
  const fixture = buildFixture(t, 'dependency-root-overlap');
  const { cacheRoot, preparedRoot } = buildDependencyCache(fixture);
  const cacheBefore = snapshotTree(cacheRoot);

  /* The three ways one root can touch another: be it, sit inside it, hold it. The
   * guard is lexical at separator boundaries, so it fires at the same moment for
   * all three and before a byte exists. */
  const overlaps = [
    ['the prepared tree itself claimed as the container', preparedRoot],
    ['a container placed inside the prepared tree', path.join(preparedRoot, 'container')],
    ['a container that encloses the prepared tree', cacheRoot],
  ];
  for (const [label, output] of overlaps) {
    const error = await expectCode(initialise(fixture, {
      output,
      dependencies: { mode: 'prepared', preparedRoot, sourceRoot: fixture.sourceRoot },
    }), INIT_ERROR_CODES.ROOTS_OVERLAP, label);
    assert.match(error.message, new RegExp(`^${INIT_ERROR_CODES.ROOTS_OVERLAP}: `), 'the code leads the message');
    assert.match(error.message, /must be disjoint from dependencies\.preparedRoot/,
      `the refusal names the dependency root it would have merged with: ${error.message}`);
    assert.match(error.message, /a container may not equal, contain or sit inside a protected root/,
      'the refusal states the rule it is enforcing');
    /* The details are hoisted onto the error by the error type itself, so a
     * caller can see which path it moved and which root it moved it onto. */
    assert.equal(error.path, output, 'the error reports the path that was refused');
    assert.equal(error.overlaps, preparedRoot, 'the error reports the protected root it overlaps');
  }

  /* A scratch root inside the container is the same collision seen from the
   * install side, and it is reported under the field that named it. */
  const scratchInside = path.join(fixture.outputParent, 'install-container', 'scratch');
  const scratchError = await expectCode(initialise(fixture, {
    output: path.join(fixture.outputParent, 'install-container'),
    dependencies: {
      mode: 'install',
      npmExecutable: path.join(fixture.root, 'npm.cmd'),
      scratchRoot: scratchInside,
    },
  }), INIT_ERROR_CODES.ROOTS_OVERLAP, 'a scratch root inside the container');
  assert.match(scratchError.message, /must be disjoint from dependencies\.scratchRoot/,
    `the refusal names the scratch root: ${scratchError.message}`);

  assert.deepEqual(snapshotTree(cacheRoot), cacheBefore,
    'the dependency cache is byte-for-byte what it was: a refused run never reads through it or into it');
  assert.deepEqual(fs.readdirSync(fixture.outputParent).sort(RAW_COMPARE), [],
    'none of the refusals created a container');
});

test('a name that differs from a dependency root only by case is refused as a merge risk', async (t) => {
  const fixture = buildFixture(t, 'dependency-case-collision');
  const { cacheRoot, preparedRoot } = buildDependencyCache(fixture);
  const folds = isScratchCaseInsensitive(fixture.root);
  const cacheBefore = snapshotTree(cacheRoot);
  /* The same path spelled with a different case: on a folding volume this *is*
   * the prepared tree, and on a case-sensitive volume it is a sibling an author
   * could easily confuse with it. Either way the run must refuse it. */
  const output = path.join(fixture.root, 'cache', 'Node_Modules');

  const error = await expectCode(initialise(fixture, {
    output,
    dependencies: { mode: 'prepared', preparedRoot, sourceRoot: fixture.sourceRoot },
  }), INIT_ERROR_CODES.ROOTS_OVERLAP, 'a container name that case-collides with the prepared tree');
  assert.equal(error.path, output, 'the error reports the refused name');
  assert.equal(error.overlaps, preparedRoot, 'the error reports the root it would merge with');
  /* Two separate refusals describe this hazard: the containment gate and the
   * case gate. Which one speaks is asserted as a fact about the shipped order
   * rather than assumed, because the acceptance claim is that the *hazard* is
   * stopped, and a suite that only checked the code could not tell the two
   * gates apart. */
  assert.match(error.message, /must be disjoint from dependencies\.preparedRoot|differs from dependencies\.preparedRoot .*only by case/,
    `the refusal is one of the two stated overlap refusals: ${error.message}`);
  t.diagnostic(`case folding on this volume: ${String(folds)}; the refusal that spoke was: `
    + (/only by case/.test(error.message) ? 'the case gate' : 'the containment gate'));

  assert.deepEqual(snapshotTree(cacheRoot), cacheBefore,
    'the refused run left the prepared tree byte-identical');
  assert.equal(fs.existsSync(path.join(output, WORKSPACE_DIRECTORY_NAME)), false,
    'no workspace was created behind the refused name');
});

test('a link or junction in the destination path is refused as what it is, not followed', async (t) => {
  const fixture = buildFixture(t, 'link-destination');
  const linkKind = creatableLinkKind(fixture.root);
  if (linkKind === null || linkKind === 'file') {
    /* A file link cannot stand in for a directory link, and this suite does not
     * claim to have proved link behaviour on a host that will not build one. */
    t.diagnostic(`no directory link is creatable on this host (probe answered ${String(linkKind)}); `
      + 'link refusal paths are therefore not exercised here, and the limitation is recorded rather than skipped silently');
    return;
  }

  /* Case one: the link *is* the destination. The reservation asks the filesystem
   * to create the directory and the filesystem reports the name as taken, which
   * is OUTPUT_EXISTS: the run refuses to reuse a container, and a link is not a
   * container it may write through. This is the behaviour the runtime actually
   * shows (mkdir over an existing link is EEXIST), and it is asserted as such
   * rather than as the more obvious-sounding LINK_OR_SPECIAL. */
  const target = path.join(fixture.root, 'junction-target');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'keep.txt'), 'TARGET-ONLY-MATERIAL-2E88\n', 'utf8');
  const targetBefore = snapshotTree(target);
  const destination = path.join(fixture.outputParent, 'container');
  fs.symlinkSync(target, destination, linkKind);

  const asDestination = await expectCode(initialise(fixture, { output: destination }),
    INIT_ERROR_CODES.OUTPUT_EXISTS, 'a link standing where the container belongs');
  assert.match(asDestination.message, /an existing container is never reused, emptied or overwritten/,
    `the refusal says an existing destination is not adopted: ${asDestination.message}`);
  assert.ok(fs.lstatSync(destination).isSymbolicLink(), 'the link itself was not replaced or unlinked');
  assert.deepEqual(snapshotTree(target), targetBefore,
    'nothing was written through the link: the bytes behind it are byte-for-byte what they were');

  /* Case two: the link is the *parent*, so the container would be created behind
   * it. That is reported by its own name, because writing beneath a link puts
   * the run\'s material wherever the link happens to point. */
  const underLink = path.join(destination, 'made-behind-the-link');
  const asParent = await expectCode(initialise(fixture, { output: underLink }),
    INIT_ERROR_CODES.LINK_OR_SPECIAL, 'an output parent that is a link');
  assert.match(asParent.message, new RegExp(`^${INIT_ERROR_CODES.LINK_OR_SPECIAL}: the output ancestor `),
    `the ancestor is reported as a link or non-directory: ${asParent.message}`);
  assert.match(asParent.message, /is a link or non-directory/, 'the refusal names what it found');
  assert.equal(asParent.path, destination, 'the error reports the link it stopped at');
  assert.deepEqual(snapshotTree(target), targetBefore,
    'and still no byte was written behind the link');
});

test('a refused run and a successful run interleaved leave only the successful container', async (t) => {
  const fixture = buildFixture(t, 'interleaved-rival');
  const { cacheRoot, preparedRoot } = buildDependencyCache(fixture);
  const cacheBefore = snapshotTree(cacheRoot);
  const output = path.join(fixture.outputParent, 'published');

  /* One request with a clean destination and one whose destination reaches into
   * the prepared tree, started together. The refusal is a validation failure
   * rather than a race for a name, so it must not cost the good run anything: no
   * half container, no rollback over the sibling, no touch on the cache. */
  const [good, bad] = await Promise.all([
    rejection(initialise(fixture, {
      output,
      dependencies: { mode: 'prepared', preparedRoot, sourceRoot: fixture.sourceRoot },
    })),
    rejection(initialise(fixture, {
      output: path.join(preparedRoot, 'sneaked-container'),
      dependencies: { mode: 'prepared', preparedRoot, sourceRoot: fixture.sourceRoot },
    })),
  ]);

  assert.equal(bad instanceof InitError, true, 'the hostile request was refused');
  assert.equal(bad.code, INIT_ERROR_CODES.ROOTS_OVERLAP, 'and refused for the overlap, not for a collision');
  assert.equal(good, void 0, 'the clean request was not disturbed by the one running beside it');

  const published = fs.readdirSync(fixture.outputParent).sort(RAW_COMPARE);
  assert.deepEqual(published, ['published'], 'exactly one container exists');
  assert.deepEqual(snapshotTree(cacheRoot), cacheBefore,
    'the prepared tree the refused run aimed at was not consumed, copied out of, or disturbed');

  /* The container that did publish carries the declared workload plus exactly
   * the dependency tree it was given, and nothing from the refused run's
   * surroundings. `result.workload.fileCount` counts the workload; the tree on
   * disk is that count plus the staged dependency entries, so both views are
   * checked rather than one being mistaken for the other. */
  const workspaceFiles = listFiles(path.join(output, WORKSPACE_DIRECTORY_NAME));
  const dependencyFiles = workspaceFiles.filter((relativePath) =>
    segments(relativePath)[0] === DEPENDENCIES_DIRECTORY_NAME);
  const workloadFiles = workspaceFiles.filter((relativePath) =>
    segments(relativePath)[0] !== DEPENDENCIES_DIRECTORY_NAME);
  assert.equal(workloadFiles.length, EXPECTED_WORKLOAD_FILE_COUNT,
    'the published workspace is the declared twenty-six workload files and nothing else beside them');
  assert.deepEqual(dependencyFiles, [`${DEPENDENCIES_DIRECTORY_NAME}/synthetic-dep/index.js`],
    'the only other bytes are the dependency tree the request declared');
  assert.equal(fs.existsSync(path.join(preparedRoot, 'sneaked-container')), false,
    'the refused request left no container behind, not even inside the cache');
});

test('owner and evaluator material never reaches the published container or its state', async (t) => {
  const fixture = buildFixture(t, 'private-canaries');
  const canaries = ['OWNER-ONLY-MATERIAL-A7C3', 'EVALUATOR-ONLY-MATERIAL-4F91'];
  const result = await initialise(fixture);

  /* The point of the two canary roots is that a run is given them as *protected
   * input* and must not carry their bytes into the participant-visible
   * workspace. Reading every published byte is the honest form of that claim: a
   * file-name listing would miss content copied under another name. */
  const scanned = [
    path.join(result.workspace.root, ''),
    path.join(result.state.root, ''),
  ];
  for (const root of scanned) {
    for (const relativePath of listFiles(root)) {
      const bytes = fs.readFileSync(path.join(root, ...segments(relativePath)));
      for (const canary of canaries) {
        assert.equal(bytes.includes(Buffer.from(canary, 'utf8')), false,
          `${relativePath} must not carry ${canary}`);
      }
    }
  }

  /* And the protected roots are still standing with their bytes, in place. */
  assert.equal(fs.readFileSync(path.join(fixture.ownerRoot, 'owner-secret.txt'), 'utf8'),
    'OWNER-ONLY-MATERIAL-A7C3\n', 'the owner root is untouched');
  assert.equal(fs.readFileSync(path.join(fixture.evaluatorRoot, 'hidden-tests.txt'), 'utf8'),
    'EVALUATOR-ONLY-MATERIAL-4F91\n', 'the evaluator root is untouched');
});

/* ============================================================ (c) mode purity: none */

/* The mode a run declares is the whole of what its dependency seam may do. Two
 * kinds of failure matter here and they are different: a request that *names* an
 * option its mode does not accept must be refused before anything is written
 * (that is what stops a "none" run from quietly becoming a fetch), and a request
 * that is accepted must leave a container that shows its mode in every place a
 * later reader would look — the workspace tree, the state tree, the result object,
 * and the persisted companion. The released suite checks the codes for a handful
 * of hand-picked pairs; this section sweeps the whole table, asserts the wording
 * that tells an operator *why*, and reads the published container back from disk. */

/* The three declared modes, read off both shipped modules. The initialiser
 * gates on its own copy of the list and the accepted helper owns the other; if
 * the two ever disagree, a request could pass one gate and be refused by the
 * other, so the list this section sweeps is taken only after the two agree. */
const DEPENDENCY_MODE_LIST = [...INIT_DEPENDENCY_MODES];
assert.deepEqual([...HELPER_DEPENDENCY_MODES], DEPENDENCY_MODE_LIST,
  'the initialiser and the dependency helper declare the same three modes');

/* Restated from the shipped contract (`MODE_FORBIDDEN_OPTIONS` in the
 * implementation, which is module-private). Restating it here is the point: if
 * the table in the module drifts from the table the contract states, this sweep
 * fails rather than following it. */
const FORBIDDEN_BY_MODE = {
  none: ['preparedRoot', 'sourceRoot', 'scratchRoot', 'npmExecutable', 'expectedDependencyDigest',
    'offline', 'timeoutMs', 'processAdapter', 'maxEntries', 'maxFileBytes', 'maxTotalBytes'],
  prepared: ['npmExecutable', 'scratchRoot', 'processAdapter', 'npmArgumentsPrefix',
    'npmArgumentsSuffix', 'timeoutMs', 'offline'],
  install: ['preparedRoot'],
};

/** A syntactically well-formed value for one dependency option. */
const OPTION_PROBE_VALUE = {
  preparedRoot: 'C:/somewhere/prepared',
  sourceRoot: 'C:/somewhere/source',
  scratchRoot: 'C:/somewhere/scratch',
  npmExecutable: 'C:/somewhere/npm.cmd',
  expectedDependencyDigest: 'a'.repeat(64),
  offline: true,
  timeoutMs: 5000,
  processAdapter: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  maxEntries: 100,
  maxFileBytes: 1024,
  maxTotalBytes: 1048576,
  npmArgumentsPrefix: ['--loglevel=warn'],
  npmArgumentsSuffix: ['--no-progress'],
};

test('the mode gate is swept over every mode and every option it does not accept', async (t) => {
  const fixture = buildFixture(t, 'mode-gate-sweep');

  assert.deepEqual(Object.keys(FORBIDDEN_BY_MODE).sort(), ['install', 'none', 'prepared'],
    'the sweep covers exactly the three declared modes');

  for (const mode of DEPENDENCY_MODE_LIST) {
    const forbidden = FORBIDDEN_BY_MODE[mode];
    /* Cross-checked against the shipped accept-list: an option that is not a
     * declared request key would be refused as an unknown field rather than as a
     * mode mismatch, and the sweep would be measuring the wrong gate. */
    for (const option of forbidden)
      assert.ok(DEPENDENCY_KEYS.includes(option),
        `${option} is a declared dependencies field, so the sweep reaches the mode gate`);

    for (const option of forbidden) {
      const refusal = await expectCode(
        initialise(fixture, { dependencies: { mode, [option]: OPTION_PROBE_VALUE[option] } }),
        INIT_ERROR_CODES.DEPENDENCY_MODE_MISMATCH,
        `mode ${mode} given ${option}`);
      /* The wording is the operator-visible contract: it must name both the
       * option and the mode that rejected it. */
      assert.equal(refusal.message,
        `${INIT_ERROR_CODES.DEPENDENCY_MODE_MISMATCH}: dependencies.${option} is not accepted for mode ${JSON.stringify(mode)}.`,
        'the refusal states which option which mode refused');
    }
  }

  /* The gate is per-mode rather than a blanket refusal of the field. `offline` is
   * accepted for install and refused for prepared; both requests reach the same
   * later gate (install needs an executable), and which field the refusal names
   * shows whether `offline` itself was let through. */
  const preparedWithOffline = await rejection(initialise(fixture, {
    dependencies: { mode: 'prepared', preparedRoot: 'C:/somewhere/prepared', offline: true },
  }));
  assert.ok(preparedWithOffline instanceof InitError, 'prepared with offline is refused');
  assert.equal(preparedWithOffline.code, INIT_ERROR_CODES.DEPENDENCY_MODE_MISMATCH);
  assert.match(preparedWithOffline.message, /dependencies\.offline is not accepted for mode "prepared"\./,
    `prepared is stopped at the offline option itself: ${preparedWithOffline.message}`);

  const installWithOffline = await rejection(initialise(fixture, {
    dependencies: { mode: 'install', npmExecutable: 'C:/somewhere/npm.cmd', offline: true },
  }));
  /* `offline` is admissible for install, so no mode gate fires and the request
   * reaches the accepted helper, which states its own required-field order: an
   * install request without a `sourceRoot` is refused as NPM_LOCKFILE_REQUIRED
   * before the named executable is even looked at. The assertion is therefore
   * about which seam spoke, and the point it proves is that the init gate did
   * not reject `offline` for install: an InitError naming the option, or a
   * refusal that mentions `offline`, would mean the gate is a blanket refusal
   * rather than a per-mode one. */
  assert.ok(installWithOffline instanceof DependencyError,
    `install was answered by the dependency helper, not by an init mode gate: ${String(installWithOffline?.message)}`);
  assert.ok(!(installWithOffline instanceof InitError),
    'and specifically not by an InitError, so the option was let through the init gate');
  assert.equal(installWithOffline.code, 'NPM_LOCKFILE_REQUIRED',
    `the request reached the helper's own required-field gate: ${installWithOffline.message}`);
  assert.equal(installWithOffline.message.includes('offline'), false,
    `nothing here objects to offline for install: ${installWithOffline.message}`);
});

test('a mode that is not one of the three is refused with the choices it may pick from', async (t) => {
  const fixture = buildFixture(t, 'mode-not-declared');

  for (const [stated, shown] of [['sideload', '"sideload"'], [void 0, 'undefined'], ['NONE', '"NONE"'], [null, 'null']]) {
    const refusal = await expectCode(
      initialise(fixture, { dependencies: stated === void 0 ? {} : { mode: stated } }),
      INIT_ERROR_CODES.DEPENDENCY_MODE_INVALID,
      `mode ${String(stated)}`);
    assert.equal(refusal.message,
      `${INIT_ERROR_CODES.DEPENDENCY_MODE_INVALID}: dependencies.mode must be exactly one of ${DEPENDENCY_MODE_LIST.join(', ')}; got ${shown}.`,
      'the refusal lists the three legal modes rather than guessing at a near miss');
  }

  /* A mode that is absent is the same refusal as a mode that is wrong: nothing is
   * inferred from the shape of the request. */
  const noModeStated = await rejection(initialise(fixture, {
    dependencies: { preparedRoot: 'C:/somewhere/prepared' },
  }));
  assert.ok(noModeStated instanceof InitError, 'a request without a mode is refused');
  assert.equal(noModeStated.code, INIT_ERROR_CODES.DEPENDENCY_MODE_INVALID,
    'and it is refused for the mode, not for the root it carried');
  assert.match(noModeStated.message, /dependencies\.mode must be exactly one of/,
    `a prepared root is never read as a prepared mode: ${noModeStated.message}`);
});

test('the mode is a declared field: a request that is not an object is refused as such', async (t) => {
  const fixture = buildFixture(t, 'mode-is-declared');

  for (const notAnObject of [void 0, null, 'prepared', ['prepared'], 7]) {
    const refusal = await expectCode(
      initialise(fixture, { dependencies: notAnObject }),
      INIT_ERROR_CODES.INVALID_ARGUMENT,
      `dependencies given ${JSON.stringify(notAnObject)}`);
    assert.equal(refusal.message,
      `${INIT_ERROR_CODES.INVALID_ARGUMENT}: dependencies must be a request object naming its mode { mode: "none" | "prepared" | "install", … }; the mode is declared and is never inferred.`,
      'the refusal says in as many words that the mode is never inferred');
  }

  /* An unknown field is its own refusal, and it names the field it did not
   * recognise rather than rejecting the request wholesale. */
  const unknown = await expectCode(
    initialise(fixture, { dependencies: { mode: 'none', fetchDependencies: true } }),
    INIT_ERROR_CODES.INVALID_OPTION, 'an undeclared dependencies field');
  assert.equal(unknown.message,
    `${INIT_ERROR_CODES.INVALID_OPTION}: the dependencies request carries unrecognised field(s): fetchDependencies.`,
    'the refusal names the field it did not recognise');

  const unknownAtTop = await expectCode(
    initialise(fixture, { rest: { skipDependencyStage: true } }),
    INIT_ERROR_CODES.INVALID_OPTION, 'an undeclared request field');
  assert.match(unknownAtTop.message,
    /^INVALID_OPTION: the init request carries unrecognised field\(s\): skipDependencyStage\.$/,
    `the request itself is closed too: ${unknownAtTop.message}`);
});

test('a mode none run publishes a container that carries nothing but the declared workload', async (t) => {
  const fixture = buildFixture(t, 'none-purity');
  const result = await initialise(fixture);
  const workspace = path.join(fixture.outputParent, 'container', WORKSPACE_DIRECTORY_NAME);
  const stateRoot = path.join(fixture.outputParent, 'container', STATE_DIRECTORY_NAME);

  /* The workspace is the twenty-six and nothing else. A dependency tree would
   * not be a stray file to tidy: mode none is the mode a run picks precisely so
   * that no third-party bytes are in front of the participant. */
  const published = listFiles(workspace);
  assert.equal(published.length, EXPECTED_WORKLOAD_FILE_COUNT,
    `the mode none workspace carries ${published.length} files, and every one of them is workload`);
  assert.equal(published.some((relativePath) => segments(relativePath)[0] === DEPENDENCIES_DIRECTORY_NAME), false,
    'there is no dependency tree inside the published workspace');

  /* The same claim read off the result object, and from the state side. */
  assert.equal(result.workspace.dependencyDirectory, null,
    'the result reports no dependency directory for mode none');
  assert.equal(result.dependency.mode, 'none', 'the result echoes the declared mode');
  assert.equal(result.dependency.digest, null, 'mode none is the only mode without a dependency digest');
  assert.equal(result.dependency.algorithmId, DEPENDENCY_HASH_ALGORITHM_ID,
    'the dependency field is still named in the dependency domain, so the two hash domains never swap');

  /* The mode decides whether the state side gets a dependency staging directory
   * at all. Its absence is what proves the seam was skipped rather than merely
   * producing nothing. */
  const stateChildren = fs.readdirSync(stateRoot).sort(RAW_COMPARE);
  assert.equal(stateChildren.includes(RUN_DEPENDENCIES_DIRECTORY_NAME), false,
    `the state root carries no staging directory of its own: ${stateChildren.join(', ')}`);
  assert.equal(fs.existsSync(path.join(fixture.outputParent, 'container', 'node_modules')), false,
    'and nothing was staged beside the container either');

  /* State sits beside the workspace, not inside it: the participant cannot reach
   * the run records through its own working tree. Asserted twice over, because a
   * boolean that is merely reported is weaker than the directories it reports on. */
  assert.equal(result.state.insideWorkspace, false, 'the result states state is outside the workspace');
  assert.equal(path.dirname(result.workspace.root), path.dirname(result.state.root),
    'the workspace and the state root share one parent, so state is a sibling of the workspace');
  assert.equal(path.basename(result.state.root), STATE_DIRECTORY_NAME,
    'the state root is the declared state directory under the container');
  assert.ok(path.relative(result.workspace.root, result.state.root).startsWith('..'),
    `reading out of the workspace cannot reach the state root: ${path.relative(result.workspace.root, result.state.root)}`);
  assert.equal(listFiles(result.state.root).some((relativePath) =>
    segments(relativePath)[0] === DEPENDENCIES_DIRECTORY_NAME), false,
  'no dependency bytes were written into the state side either');

  /* The three records exist as files, and the result names each one with the
   * digest the storage layer published it under. A mode-none run still writes a
   * dependency companion: what it records is the absence. */
  const stateFiles = listFiles(stateRoot);
  for (const relativePath of [RUN_STATE_RELATIVE_PATH, DEPENDENCY_STATE_RELATIVE_PATH, EXPORT_STATE_RELATIVE_PATH])
    assert.ok(stateFiles.includes(relativePath), `${relativePath} was published into the state root`);
  for (const [label, digest] of [
    ['the run record', result.state.runRecordDigest],
    ['the dependency companion', result.state.dependencyRecordDigest],
    ['the export proof', result.state.exportRecordDigest],
  ]) {
    assert.equal(typeof digest, 'string', `${label} carries a published digest`);
    assert.match(digest, HEX64, `the digest on ${label} is 64 lowercase hex characters`);
  }
  /* The result names where a dependency metadata file *would* live even when the
   * seam was skipped. The honest claim is therefore about the bytes: that name
   * resolves inside the state root, and nothing stands at it. */
  assert.equal(typeof result.state.dependencyMetadata, 'string',
    'the result states where dependency metadata would be recorded');
  assert.equal(result.state.dependencyMetadata,
    `${RUN_DEPENDENCIES_DIRECTORY_NAME}/${DEPENDENCIES_METADATA_FILE_NAME}`,
    'and the name it states is the declared staging location, not a path it invented');
  assert.equal(fs.existsSync(path.join(stateRoot, ...segments(result.state.dependencyMetadata))), false,
    'no bytes stand at that name for a run that declared no dependencies');

  /* Every record is published under the run-initialisation envelope kind; the
   * `kind` field inside the record is the record's own name, not the envelope's.
   * Reading with the inner name is a real mistake to rule out, because storage
   * answers it with ERR_STORAGE_IDENTITY_MISMATCH rather than with the bytes.
   * The public read returns the record itself, not an envelope wrapper, so the
   * reported digest is cross-checked against the envelope bytes on disk. */
  const companion = await stateStorage(stateRoot).read({
    relativePath: DEPENDENCY_STATE_RELATIVE_PATH,
    kind: INIT_STATE_KIND,
    id: `${result.manifest.manifestId}:dependencies`,
  });
  assert.equal(companion.kind, 'benchboard:dependency-state',
    'the companion is its own record kind, not a C1 record with fields added to it');
  assert.equal(companion.mode, 'none', 'the persisted companion says the run declared none');
  assert.equal(companion.dependencyDigest, null, 'and it carries no digest to be mistaken for one');
  assert.equal(companion.inventoryCount, 0, 'and it recorded an empty inventory');
  assert.equal(companion.hashAlgorithmId, DEPENDENCY_HASH_ALGORITHM_ID,
    'the companion is hashed in the dependency domain');

  const companionEnvelope = JSON.parse(fs.readFileSync(path.join(stateRoot, ...segments(DEPENDENCY_STATE_RELATIVE_PATH)), 'utf8'));
  assert.deepEqual(Object.keys(companionEnvelope).sort(), ['digest', 'id', 'kind', 'schemaVersion', 'value'],
    'the published envelope carries exactly the accepted C1 envelope keys');
  assert.equal(companionEnvelope.kind, INIT_STATE_KIND,
    'the envelope kind is the run-initialisation kind for every state record');
  assert.equal(companionEnvelope.id, `${result.manifest.manifestId}:dependencies`,
    'and its identity is the manifest id with the companion suffix');
  assert.equal(companionEnvelope.digest, result.state.dependencyRecordDigest,
    'the digest the publication reported is the digest written into the envelope');
  assert.match(companionEnvelope.digest, HEX64, 'and it is a lowercase hex digest');
});

/** Every regular file under `root`, as sorted root-relative POSIX paths. */
function listFiles(root) {
  const found = [];
  const visit = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      const stats = fs.lstatSync(absolute);
      if (stats.isDirectory()) visit(absolute, relativePath);
      else if (stats.isFile()) found.push(relativePath);
      else throw new Error(`the tree under ${root} carries a non-regular entry at ${relativePath}`);
    }
  };
  visit(root, '');
  return found.sort(RAW_COMPARE);
}


/* Original acceptance completion: real seams, deterministic process port only. */

test('two independent prepared runs preserve the cache and separate dependency bytes from workload identity', async (t) => {
  const fixture = buildFixture(t, 'prepared-roundtrip');
  const { cacheRoot, preparedRoot } = buildDependencyCache(fixture, 'prepared-cache', {
    'synthetic-dep/index.js': 'export const accepted = 1;\n',
    'synthetic-dep/data.bin': '\u0000\u0001dependency\r\n',
  });
  const sourceBefore = snapshotTree(fixture.sourceRoot);
  const cacheBefore = snapshotTree(cacheRoot);
  const results = [];
  for (const name of ['first', 'second']) {
    const result = await initialise(fixture, {
      output: path.join(fixture.outputParent, name),
      dependencies: { mode: 'prepared', preparedRoot, sourceRoot: fixture.sourceRoot },
    });
    results.push(result);
    assert.equal(result.workspace.fileCount, EXPECTED_WORKLOAD_FILE_COUNT);
    assert.equal(fs.statSync(path.join(result.workspace.root, 'node_modules')).isDirectory(), true);
    assert.equal(result.workload.digest, fixture.identity.workloadDigest);
    assert.equal(result.dependency.mode, 'prepared');
    assert.match(result.dependency.digest, HEX64);
    assert.notEqual(result.dependency.digest, result.workload.digest);
    for (const relativePath of fixture.participantPaths) {
      const local = relativePath.replace(/^starter\//, '');
      assert.deepEqual(fs.readFileSync(path.join(result.workspace.root, ...segments(local))),
        fs.readFileSync(inStarter(relativePath)));
    }
    const metadataPath = path.join(result.state.root, ...segments(result.state.dependencyMetadata));
    assert.equal(fs.existsSync(metadataPath), true);
    assert.equal(path.relative(result.workspace.root, metadataPath).startsWith('..'), true);
    assert.equal(fs.existsSync(path.join(result.workspace.root, 'node_modules', DEPENDENCIES_METADATA_FILE_NAME)), false);
    const companion = await stateStorage(result.state.root).read({
      relativePath: DEPENDENCY_STATE_RELATIVE_PATH, kind: INIT_STATE_KIND,
      id: `${result.manifest.manifestId}:dependencies`,
    });
    assert.equal(companion.dependencyDigest, result.dependency.digest);
    assert.equal(companion.mode, 'prepared');
    assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
    assert.deepEqual(snapshotTree(cacheRoot), cacheBefore);
  }
  assert.equal(results[0].dependency.digest, results[1].dependency.digest);
  assert.deepEqual(snapshotTree(results[0].workspace.root), snapshotTree(results[1].workspace.root));
  assert.notEqual(results[0].manifest.runId, results[1].manifest.runId);
});

// The documented result must name the dependencies actually published.
// A failing assertion is a production finding, never a passing acceptance proof.
test('prepared result reports the dependency directory it physically published', async (t) => {
    const fixture = buildFixture(t, 'prepared-result-report');
    const { preparedRoot } = buildDependencyCache(fixture);
    const result = await initialise(fixture, {
      dependencies: { mode: 'prepared', preparedRoot, sourceRoot: fixture.sourceRoot },
    });
    assert.equal(result.workspace.dependencyDirectory, DEPENDENCIES_DIRECTORY_NAME);
  });

test('mock install executes only npm ci in private staging, preserves source and publishes separate identities', async (t) => {
  const fixture = buildFixture(t, 'mock-install');
  const before = snapshotTree(fixture.sourceRoot);
  let calls = 0;
  let staging;
  const adapter = async (request) => {
    calls++;
    staging = request.cwd;
    assert.equal(request.file, process.execPath);
    assert.equal(request.shell, false);
    assert.equal(request.options.shell, false);
    assert.deepEqual(request.args, ['--loglevel=warn', 'ci', '--lockfile=package-lock.json',
      '--install-strategy=hoisted', '--no-audit', '--no-fund', '--no-package-lock',
      '--no-update-check', '--offline=false', '--no-progress']);
    assert.equal(path.relative(fixture.root, request.cwd).startsWith('..'), false);
    assert.notEqual(request.cwd, fixture.sourceRoot);
    assert.equal(request.env.npm_config_cache, path.join(request.cwd, '.npm-cache'));
    for (const name of ['package.json', 'package-lock.json'])
      assert.deepEqual(fs.readFileSync(path.join(request.cwd, name)), fs.readFileSync(path.join(fixture.sourceRoot, name)));
    fs.mkdirSync(path.join(request.cwd, 'node_modules', 'mock-dep'), { recursive: true });
    fs.writeFileSync(path.join(request.cwd, 'node_modules', 'mock-dep', 'index.js'), 'export const mock = true;\n');
    fs.writeFileSync(path.join(request.cwd, '.npm-cache', 'ordinary-cache-output'), 'cache');
    return { status: 0, signal: null, stdout: 'mock only', stderr: '' };
  };
  const result = await initialise(fixture, { dependencies: {
    mode: 'install', sourceRoot: fixture.sourceRoot, npmExecutable: process.execPath,
    processAdapter: adapter, offline: false,
    npmArgumentsPrefix: ['--loglevel=warn'], npmArgumentsSuffix: ['--no-progress'],
  } });
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(staging), false, 'declared process outputs and private staging retired');
  assert.equal(result.dependency.mode, 'install');
  assert.equal(result.workspace.dependencyDirectory, DEPENDENCIES_DIRECTORY_NAME);
  assert.equal(result.workspace.fileCount, 26);
  assert.equal(result.workload.digest, fixture.identity.workloadDigest);
  assert.match(result.dependency.digest, HEX64);
  assert.equal(fs.readFileSync(path.join(result.workspace.root, 'node_modules', 'mock-dep', 'index.js'), 'utf8'), 'export const mock = true;\n');
  const persisted = await readRunRecord(result.state.root, result.manifest.manifestId);
  assert.deepEqual(validateRecord('RunManifest', persisted), result.manifest);
  assert.equal(persisted.participantWorkspaceRoot, result.workspace.root);
  assert.equal(persisted.evidenceRoot, result.state.root);
  assert.deepEqual(snapshotTree(fixture.sourceRoot), before);
});

test('mock process failures and unexpected dependency bytes refuse publication without mutating source', async (t) => {
  for (const [label, outcome, code] of [
    ['nonzero', { status: 7, signal: null, stdout: '', stderr: 'fixture refusal' }, 'NPM_EXIT_NONZERO'],
    ['timeout', { status: null, signal: 'SIGTERM', timedOut: true, stdout: '', stderr: '' }, 'NPM_TIMEOUT'],
    ['spawn', { status: null, spawnError: 'fixture spawn refused', stdout: '', stderr: '' }, 'NPM_SPAWN_FAILED'],
    ['digest', { status: 0, signal: null, stdout: '', stderr: '' }, 'DEPENDENCY_DIGEST_MISMATCH'],
  ]) {
    const fixture = buildFixture(t, `mock-${label}`);
    const source = snapshotTree(fixture.sourceRoot);
    let calls = 0;
    let staging;
    const adapter = async request => {
      calls++;
      staging = request.cwd;
      fs.mkdirSync(path.join(request.cwd, 'node_modules'));
      fs.writeFileSync(path.join(request.cwd, 'node_modules', 'dep.js'), 'known mock bytes');
      return outcome;
    };
    const error = await rejection(initialise(fixture, { dependencies: {
      mode: 'install', sourceRoot: fixture.sourceRoot, npmExecutable: process.execPath,
      processAdapter: adapter, ...(label === 'digest' ? { expectedDependencyDigest: '0'.repeat(64) } : {}),
    } }));
    assert.ok(error instanceof DependencyError);
    assert.equal(error.code, code);
    assert.equal(calls, 1);
    assert.deepEqual(snapshotTree(fixture.sourceRoot), source);
    assert.equal(fs.existsSync(staging), false);
    const output = path.join(fixture.outputParent, 'container');
    if (fs.existsSync(output)) {
      // A failed helper's unverified residue is not adopted by outer rollback.
      // Require honest diagnostics and no successful state, not recursive deletion.
      assert.equal(error.cleanup.code, INIT_ERROR_CODES.CLEANUP_FAILED);
      for (const record of [RUN_STATE_RELATIVE_PATH, DEPENDENCY_STATE_RELATIVE_PATH, EXPORT_STATE_RELATIVE_PATH])
        assert.equal(fs.existsSync(path.join(output, STATE_DIRECTORY_NAME, ...segments(record))), false);
      assert.equal(fs.existsSync(path.join(output, WORKSPACE_DIRECTORY_NAME, 'README.md')), false);
    }
  }
});

test('all immutable state records survive fresh-store reads and reject replacement, wrong identity and tampered bytes', async (t) => {
  const fixture = buildFixture(t, 'immutable-tamper');
  const result = await initialise(fixture);
  for (const [relativePath, suffix, digest] of [
    [RUN_STATE_RELATIVE_PATH, '', result.state.runRecordDigest],
    [DEPENDENCY_STATE_RELATIVE_PATH, ':dependencies', result.state.dependencyRecordDigest],
    [EXPORT_STATE_RELATIVE_PATH, ':export', result.state.exportRecordDigest],
  ]) {
    const key = { relativePath, kind: INIT_STATE_KIND, id: result.manifest.manifestId + suffix };
    const absolute = path.join(result.state.root, ...segments(relativePath));
    const bytes = fs.readFileSync(absolute);
    const envelope = JSON.parse(bytes.toString('utf8'));
    assert.equal(envelope.digest, digest);
    const record = await stateStorage(result.state.root).read(key);
    assert.deepEqual(record, envelope.value);
    if (suffix === '') assert.deepEqual(validateRecord('RunManifest', record), result.manifest);
    const wrong = await rejection(stateStorage(result.state.root).read({ ...key, kind: 'wrong-kind' }));
    assert.equal(wrong.code, 'ERR_STORAGE_IDENTITY_MISMATCH');
    const replaced = await rejection(stateStorage(result.state.root).replaceMutable({ ...key, value: record }));
    assert.equal(replaced.code, 'ERR_STORAGE_IMMUTABLE_REPLACEMENT');
    assert.deepEqual(fs.readFileSync(absolute), bytes);
    envelope.value.notes = 'TAMPERED byte: do not trust';
    fs.writeFileSync(absolute, JSON.stringify(envelope));
    const corrupted = await rejection(stateStorage(result.state.root).read(key));
    assert.equal(corrupted.code, 'ERR_STORAGE_DIGEST_MISMATCH');
    fs.writeFileSync(absolute, bytes);
    assert.deepEqual(await stateStorage(result.state.root).read(key), record);
  }
});

test('state publication failure rolls back owned bytes but preserves foreign output and original error', async (t) => {
  for (const foreign of [false, true]) {
    const fixture = buildFixture(t, `state-fault-${foreign}`);
    const before = snapshotTree(fixture.sourceRoot);
    const output = path.join(fixture.outputParent, 'container');
    const marker = path.join(output, 'foreign-canary.txt');
    const failure = new Error('acceptance injected state-publication failure');
    const error = await rejection(initialise(fixture, { beforeStatePublication: () => {
      if (foreign) fs.writeFileSync(marker, 'DO NOT DELETE FOREIGN BYTES');
      throw failure;
    } }));
    assert.equal(error, failure);
    assert.deepEqual(snapshotTree(fixture.sourceRoot), before);
    if (foreign) {
      assert.equal(fs.readFileSync(marker, 'utf8'), 'DO NOT DELETE FOREIGN BYTES');
      assert.equal(error.cleanup.code, INIT_ERROR_CODES.CLEANUP_FAILED);
      assert.deepEqual(listFiles(output), ['foreign-canary.txt']);
    } else assert.equal(fs.existsSync(output), false);
  }
});

test('a short workload manifest is refused before export and no partial destination is left', async (t) => {
  const fixture = buildFixture(t, 'short-manifest');
  const output = path.join(fixture.outputParent, 'short');
  const error = await rejection(exportChallenge({
    challenge: packageFor(fixture, { fileManifest: fixture.fileManifest.slice(0, -1) }), output,
  }));
  assert.equal(error.code, 'WORKLOAD_MISMATCH');
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readdirSync(fixture.outputParent), []);
});

