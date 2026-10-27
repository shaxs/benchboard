/* BenchBoard initialisation — focused tests for the C2 challenge exporter.
 *
 * Contract: the approved C2 execution plan, T1 plus the frozen trust boundary as
 * repaired by T5. The contract is named by chunk and task rather than by a
 * private repository path, because this file is distributed to participants and
 * must not point at owner-only planning material.
 * These tests read the accepted starter bytes read-only, synthesise one real
 * ChallengeIdentity over them, and then drive the exported API through the
 * positive path, the fail-closed negatives, the concurrent destination canary
 * and the two declaration checks (byte identity plus the pinned compiler).
 *
 * Containment: scratch comes from BENCHBOARD_TEST_TMP or
 * BENCHBOARD_TEST_SCRATCH_ROOT when either names an absolute directory,
 * otherwise from a directory inside this repository. No sibling directory and no
 * operating-system temporary directory is used, and no private evidence path is
 * embedded in the module under test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  ChallengeExportError,
  EXPORT_ERROR_CODES,
  EXPECTED_WORKLOAD_FILE_COUNT,
  EXPORTED_FILE_MODE,
  STAGING_PREFIX,
  exportChallenge,
} from '../../packages/core/challenge-export.mjs';
import { hashEntries, sha256 } from '../../packages/core/identity.mjs';
import { validateRecord } from '../../packages/core/manifest.mjs';

/* ------------------------------------------------------------------ constants */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STARTER_ROOT = path.join(REPO_ROOT, 'starter');
const CORE_ROOT = path.join(REPO_ROOT, 'packages', 'core');
const RELEASE_INVENTORY_PATH = path.join(REPO_ROOT, 'release', 'inventory.json');
const PINNED_COMPILER = path.join(STARTER_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const MODULE_UNDER_TEST = path.join(CORE_ROOT, 'challenge-export.mjs');
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
  const contained = fileURLToPath(new URL('./.tmp/challenge-export/', import.meta.url));
  fs.mkdirSync(contained, { recursive: true });
  return contained;
}

/** One throwaway directory per test, removed when that test finishes. */
function scratch(t, name) {
  const directory = fs.mkdtempSync(path.join(scratchRoot(), `c2t1-${name}-`));
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
 * Assert one fail-closed outcome: a ChallengeExportError carrying the expected
 * code, with the code spelled first. A resolve, a foreign error type or a wrong
 * code all report what actually happened.
 */
async function expectCode(promise, code, label) {
  const error = await rejection(promise);
  assert.ok(error !== void 0, `${label}: a rejection was expected`);
  assert.ok(
    error instanceof ChallengeExportError,
    `${label}: a ChallengeExportError was expected, got ${error?.name}: ${error?.message}`,
  );
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

/**
 * The contract pair for one accepted starter file: the exact relative POSIX
 * path and the digest of its raw bytes, read without any re-encoding.
 */
function starterEntry(relativePath) {
  const bytes = fs.readFileSync(starterPath(relativePath));
  return Object.freeze([relativePath, sha256(bytes)]);
}

/** The contract pair for one file as it sits inside one root. */
function rootEntry(root, relativePath) {
  const bytes = fs.readFileSync(inRoot(root, relativePath));
  return Object.freeze([relativePath, sha256(bytes)]);
}

/**
 * Synthesise a real ChallengeIdentity over the bytes that were actually copied
 * into the source root: the inventory is the exact sorted
 * `[relativePath, sha256(rawBytes)]` list and the workload digest is recomputed
 * with the accepted helper, so the contract validator re-derives the very value
 * that is recorded.
 *
 * An unseeded fixture has no bytes on disk yet, so its inventory is derived
 * from the read-only starter bytes it would have carried: the record stays a
 * valid identity for argument gates, which are refused before any file is read.
 */
function buildIdentity(sourceRoot, paths, { seeded = true } = {}) {
  const entryFor = seeded ? (relativePath) => rootEntry(sourceRoot, relativePath) : starterEntry;
  const starterInventory = paths
    .map(entryFor)
    .sort((left, right) => RAW_COMPARE(left[0], right[0]));
  return Object.freeze({
    schemaVersion: '1.0.0',
    kind: 'ChallengeIdentity',
    challengeId: 'c2-t1-fixture-board',
    challengeVersion: '0.1.0',
    architectureId: 'arch-c2-t1-fixture',
    architectureKind: 'challenge',
    hashAlgorithm: 'sha256',
    definitionDigest: sha256('c2-t1-fixture:definition'),
    digestProvenance: Object.freeze({ kind: 'COMPUTED', procedure: 'c2-t1-fixture:sha256:source-bytes' }),
    workloadProvenance: Object.freeze({ kind: 'COMPUTED', procedure: 'c2-t1-fixture:starter-inventory-digest' }),
    publicPrdDigest: sha256('c2-t1-fixture:public-prd'),
    visibleHarnessDigest: sha256('c2-t1-fixture:visible-harness'),
    fixtureDigest: sha256('c2-t1-fixture:fixture'),
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
    notes: 'C2 T1 focused fixture identity, derived from the read-only starter bytes.',
  });
}

/**
 * Fold one package out of a fixture and explicit overrides. An override is
 * applied when its key is present, so an explicit `null` or `void 0` reaches the
 * exporter instead of silently falling back to the fixture value. Every test
 * mutates only its own fixture, so a negative can never leak into a positive.
 */
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

/** One export call from a fixture, an explicit destination and overrides. */
function exportTo(fixture, output, overrides = {}) {
  return exportChallenge({
    challenge: packageFor(fixture, overrides),
    output: overrides.output ?? output,
  });
}

/** The default publish target inside a fixture. */
function publishTarget(fixture, name = 'workspace') {
  return path.join(fixture.outputParent, name);
}

/**
 * Build one fixture: fresh directories plus a complete package. Seeding copies
 * the accepted starter bytes and derives the identity from those very bytes;
 * an unseeded fixture is only useful for argument gates, which run before any
 * filesystem access.
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
  if (options.seed !== false) {
    fs.mkdirSync(sourceRoot, { recursive: true });
    for (const relativePath of paths) {
      copyFile(starterPath(relativePath), inRoot(sourceRoot, relativePath));
    }
  }
  const identity = buildIdentity(sourceRoot, paths, { seeded: options.seed !== false });
  assert.deepEqual(
    validateRecord('ChallengeIdentity', structuredClone(identity)),
    structuredClone(identity),
    'the fixture identity must satisfy the shipped contract validator before it is used',
  );
  return { root, paths, identity, sourceRoot, ownerRoot, evaluatorRoot, outputParent };
}

/**
 * Replace one member of the single shared promises namespace for the duration
 * of one test, then put it back. The namespace object is shared process-wide,
 * so this is how a file link or a special file is observed on a host that
 * refuses to create one; the patch never escapes the test that installs it.
 */
function patchPromiseNamespace(t, name, replacement) {
  const original = fs.promises[name];
  assert.equal(typeof original, 'function', `node:fs promises exposes ${name}`);
  fs.promises[name] = replacement;
  t.after(() => {
    fs.promises[name] = original;
  });
  return original;
}

/** A directory entry as a listing reports it, without touching the disk. */
function syntheticEntry(name, kind) {
  return {
    name,
    isSymbolicLink: () => kind === 'link',
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
  };
}

/**
 * True when the scratch volume treats `Name.txt` and `name.txt` as one file.
 * The capability is probed, never assumed: a case-folding volume cannot host the
 * two spellings a real case collision needs, exactly as the accepted C1 suite
 * established for this volume.
 */
function isScratchCaseInsensitive(t) {
  const probe = scratch(t, 'case-probe');
  try {
    fs.writeFileSync(path.join(probe, 'CaseProbe.TXT'), 'x', 'utf8');
    return fs.existsSync(path.join(probe, 'caseprobe.txt'));
  } catch {
    return false;
  }
}

/**
 * Report whether this host lets an unprivileged process create the hostile
 * primitive, so a stubbed negative is always disclosed together with the real
 * host capability.
 */
function hostCanCreate(directory, kind, name) {
  const target = path.join(directory, name);
  try {
    if (kind === 'symlink') fs.symlinkSync(path.join(directory, 'nowhere-target'), target, 'file');
    else if (kind === 'fifo') fs.mkfifoSync(target, 0o644);
    else throw new Error(`no such probe kind: ${kind}`);
    fs.rmSync(target, { force: true });
    return true;
  } catch (error) {
    // A runtime that does not expose the primitive at all reports a missing
    // function rather than an errno; that is a capability answer, not a failure.
    if (error?.code === void 0 && String(error?.message ?? '').includes('is not a function')) return false;
    assert.ok(['EPERM', 'ENOSYS', 'ENOENT'].includes(error?.code ?? ''),
      `creating a ${kind} failed with an unexpected error: ${error?.code} ${error?.message}`);
    return false;
  }
}

/* ================================================================ workload set */

test('the accepted participant inventory is the workload the exporter demands', () => {
  const paths = releaseParticipantPaths();
  assert.equal(paths.length, EXPECTED_WORKLOAD_FILE_COUNT, 'the accepted participant file count');
  assert.equal(new Set(paths).size, paths.length, 'the accepted inventory repeats no path');
  for (const relativePath of paths) {
    assert.ok(!relativePath.includes('\\'), `${relativePath} is spelled with forward slashes`);
    assert.equal(fs.existsSync(starterPath(relativePath)), true, `${relativePath} is present`);
  }
});

test('the shipped surface is frozen, complete and free of ambient state', () => {
  assert.ok(Object.isFrozen(EXPORT_ERROR_CODES), 'EXPORT_ERROR_CODES is frozen');
  const codes = Object.values(EXPORT_ERROR_CODES);
  assert.equal(new Set(codes).size, codes.length, 'each code value is distinct');
  for (const [name, value] of Object.entries(EXPORT_ERROR_CODES)) {
    assert.match(name, /^[A-Z0-9_]+$/, `${name} is spelled in upper case`);
    assert.equal(name, value, `${name} carries its own name as its value`);
  }
  for (const required of ['INVALID_ARGUMENT', 'INVALID_ROOT', 'DUPLICATE_ROOT', 'ROOTS_OVERLAP', 'SOURCE_NOT_FOUND',
    'SOURCE_UNSAFE', 'WORKLOAD_MISMATCH', 'WORKLOAD_CHANGED', 'DESTINATION_EXISTS', 'DESTINATION_PARENT_MISSING',
    'DESTINATION_UNSAFE', 'STAGING_FAILED', 'PUBLICATION_FAILED', 'CLEANUP_FAILED', 'INTERNAL']) {
    assert.ok(codes.includes(required), `the contract names ${required}`);
  }
  assert.equal(EXPECTED_WORKLOAD_FILE_COUNT, 26, 'the demanded workload count is the accepted participant count');
  assert.match(STAGING_PREFIX, /^[.-]/, 'staging material is hidden on POSIX and on Windows');
  assert.equal(EXPORTED_FILE_MODE & 0o002, 0, 'a published file is not world-writable');

  const source = fs.readFileSync(MODULE_UNDER_TEST, 'utf8');
  const code = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(trimmed.startsWith('*') || trimmed.startsWith('/'));
    })
    .join('\n');
  const specifiers = [...code.matchAll(/^import\b[^\n]*?from\s+'([^']+)';/gm)].map((match) => match[1]);
  assert.ok(specifiers.length > 0, 'the exporter declares its imports statically');
  const allowed = new Set(['node:path', 'node:fs', './identity.mjs', './paths.mjs', './manifest.mjs']);
  for (const specifier of specifiers) {
    assert.ok(allowed.has(specifier), `the exporter imports ${specifier}, outside the allowed set`);
  }
  assert.ok(!/\bimport\s*\(/.test(code), 'no dynamic import');
  assert.ok(!/\brequire\s*\(/.test(code), 'no CommonJS require');
  assert.ok(!/process\.env\b/.test(code), 'the environment is never consulted');
  assert.ok(!/homedir/i.test(code), 'no user directory is resolved');
  assert.ok(!/\b(fetch|http|https)\s*\(/.test(code), 'no network call is made');
  assert.ok(!/\b(exec|spawn)\w*\s*\(/.test(code), 'no child process is started');
  assert.ok(!code.includes('.' + 'ai/'), 'no private evidence path is embedded in shipped code');
  assert.ok(!code.includes('.' + 'agent' + '-teams'), 'no team state path is embedded in shipped code');
  const runnerReference = `'run` + `ner/`;
  assert.ok(!code.includes(runnerReference), 'no legacy runner module is referenced');
  assert.ok(!code.includes("'evaluator/"), 'no legacy evaluator directory is referenced');
  assert.ok(!code.includes("'starter/"), 'no fixed starter location is referenced');
});

/* ================================================================ positive path */

test('a verified workload publishes as a fresh, exact and byte-identical workspace', async (t) => {
  const fixture = buildFixture(t, 'positive');
  const output = publishTarget(fixture);

  const result = await exportTo(fixture, output);

  assert.ok(Object.isFrozen(result), 'the result is frozen');
  assert.deepEqual(Object.keys(result).sort(), ['inventory', 'workloadDigest', 'workspaceRoot'], 'the documented result shape');
  assert.equal(result.workspaceRoot, path.resolve(output), 'the workspace root is the requested destination');
  assert.equal(result.workloadDigest, fixture.identity.workloadDigest, 'the identity workload digest is reported');
  assert.equal(result.inventory.length, EXPECTED_WORKLOAD_FILE_COUNT, 'every workload file is reported');
  for (const entry of result.inventory) {
    assert.ok(Object.isFrozen(entry), 'each inventory entry is frozen');
    assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'path', 'sha256'], 'the inventory entry shape');
    assert.match(entry.sha256, HEX64, `${entry.path} reports a lowercase digest`);
    const onDisk = fs.readFileSync(inRoot(output, entry.path));
    assert.equal(entry.bytes, onDisk.byteLength, `${entry.path} reports the byte length that is on disk`);
    assert.equal(entry.sha256, sha256(onDisk), `${entry.path} reports the digest of the bytes that are on disk`);
    const expected = fixture.identity.starterInventory.find(([name]) => name === entry.path);
    assert.deepEqual([entry.path, entry.sha256], [...expected], `${entry.path} matches the identity inventory`);
  }
  const published = snapshotTree(output);
  // Entries other than the 26 workload files are refused, and an intermediate
  // directory is a necessary consequence of a nested path, not extra material.
  const publishedEntries = Object.entries(published).filter(([, kind]) => kind !== 'directory').map(([name]) => name);
  assert.deepEqual(publishedEntries, [...fixture.paths].sort(RAW_COMPARE), 'the published set is exactly the workload');
  for (const relativePath of fixture.paths) {
    const source = fs.readFileSync(inRoot(fixture.sourceRoot, relativePath));
    const publishedBytes = fs.readFileSync(inRoot(output, relativePath));
    assert.deepEqual([...publishedBytes], [...source], `${relativePath} is byte identical to its source`);
  }
  assert.deepEqual(fs.readdirSync(fixture.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'no staging residue survives a successful export');
  assert.equal(snapshotTree(fixture.ownerRoot)['owner-secret.txt'], 'file:23', 'the owner root is untouched');
  assert.deepEqual([...fs.readFileSync(path.join(output, 'README.md'))],
    [...fs.readFileSync(path.join(STARTER_ROOT, 'README.md'))], 'the bytes come from the accepted starter bytes');
  const recomputed = hashEntries(result.inventory.map((entry) => Object.freeze([entry.path, entry.sha256])));
  assert.equal(recomputed, result.workloadDigest, 'the reported inventory re-derives the reported digest');
});

test('the accepted starter bytes reproduce the preserved golden workload digest', () => {
  const paths = releaseParticipantPaths();
  const inventory = paths.map(starterEntry).sort((left, right) => RAW_COMPARE(left[0], right[0]));
  const golden = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests', 'contracts', 'fixtures', 'identity', 'golden.json'), 'utf8'));
  assert.equal(inventory.length, golden.starter26.fileCount, 'the preserved file count is reproduced');
  assert.equal(hashEntries(inventory), golden.starter26.digest, 'the preserved starter tree digest is reproduced');
});

test('two independent exports of one workload are equal and leave each other alone', async (t) => {
  const fixture = buildFixture(t, 'repeat');
  const firstOutput = publishTarget(fixture, 'first');
  const secondOutput = publishTarget(fixture, 'second');
  const foreignCanary = path.join(fixture.outputParent, 'foreign.txt');
  fs.writeFileSync(foreignCanary, 'foreign-sibling-material\n', 'utf8');

  const first = await exportTo(fixture, firstOutput);
  const second = await exportTo(fixture, secondOutput);

  assert.equal(second.workspaceRoot, path.resolve(secondOutput), 'the second call reports its own destination');
  assert.equal(first.workloadDigest, second.workloadDigest, 'the digest is deterministic across calls');
  assert.deepEqual(structuredClone(first.inventory), structuredClone(second.inventory), 'the inventory is deterministic');
  assert.deepEqual(snapshotTree(firstOutput), snapshotTree(secondOutput), 'both workspaces hold the same bytes');
  assert.equal(fs.readFileSync(foreignCanary, 'utf8'), 'foreign-sibling-material\n', 'a sibling file is untouched');
  assert.ok(fs.lstatSync(firstOutput).isDirectory(), 'the first workspace still exists after the second export');
  assert.deepEqual(fs.readdirSync(fixture.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'neither call left staging material behind');
});

test('a protected layout that nests or repeats itself still publishes', async (t) => {
  // This is the layout the boundary used to refuse: one host directory that carries
  // the participant source and the hidden evaluator underneath the owner's own root,
  // with the owner root stated by both protected lists. Those roots overlap and
  // repeat by design — that is what a host directory does — while the destination is
  // disjoint from every one of them, so the only honest verdict is to publish.
  const root = scratch(t, 'nested-host');
  const ownerRoot = path.join(root, 'owner');
  const sourceRoot = path.join(ownerRoot, 'hosted', 'source');
  const evaluatorRoot = path.join(ownerRoot, 'hosted', 'evaluator');
  const outputParent = path.join(root, 'publish');
  fs.mkdirSync(ownerRoot, { recursive: true });
  fs.writeFileSync(path.join(ownerRoot, 'owner-secret.txt'), 'owner-private-material\n', 'utf8');
  fs.mkdirSync(evaluatorRoot, { recursive: true });
  fs.writeFileSync(path.join(evaluatorRoot, 'hidden-tests.txt'), 'hidden-evaluator-material\n', 'utf8');
  fs.mkdirSync(outputParent, { recursive: true });
  const paths = releaseParticipantPaths();
  fs.mkdirSync(sourceRoot, { recursive: true });
  for (const relativePath of paths) {
    copyFile(starterPath(relativePath), inRoot(sourceRoot, relativePath));
  }
  const identity = buildIdentity(sourceRoot, paths);
  // The owner root is named twice on purpose, and the source and evaluator roots
  // both sit inside it: repetition and containment inside the protected set widen
  // what must be kept out of the destination, they are not a defect of the destination.
  const nestedPackage = () => ({
    identity,
    sourceRoot,
    fileManifest: [...paths],
    ownerRoots: Object.freeze([ownerRoot, sourceRoot, ownerRoot]),
    evaluatorRoots: Object.freeze([ownerRoot, evaluatorRoot]),
  });
  const output = path.join(outputParent, 'workspace');

  const result = await exportChallenge({ challenge: nestedPackage(), output });

  assert.equal(result.workloadDigest, identity.workloadDigest, 'the nested host publishes its workload');
  assert.equal(result.inventory.length, EXPECTED_WORKLOAD_FILE_COUNT, 'every workload file is reported');
  assert.deepEqual(Object.entries(snapshotTree(output)).filter(([, kind]) => kind !== 'directory')
    .map(([name]) => name), [...paths].sort(RAW_COMPARE), 'the published set is exactly the workload');
  for (const relativePath of paths) {
    assert.deepEqual([...fs.readFileSync(inRoot(output, relativePath))],
      [...fs.readFileSync(inRoot(sourceRoot, relativePath))], `${relativePath} is byte identical to its source`);
  }
  assert.equal(snapshotTree(ownerRoot)['owner-secret.txt'], 'file:23', 'the owner material is untouched');
  assert.equal(snapshotTree(evaluatorRoot)['hidden-tests.txt'], 'file:26', 'the evaluator material is untouched');
  assert.deepEqual(fs.readdirSync(outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'no staging residue survives the export');

  // Widening the protected set does not loosen the gate: a destination inside that
  // host is still refused, by the containment rule rather than by any comparison of
  // the protected roots with each other.
  const inside = path.join(ownerRoot, 'workspace');
  await expectCode(exportChallenge({ challenge: nestedPackage(), output: inside }),
    EXPORT_ERROR_CODES.ROOTS_OVERLAP, 'a destination inside the nested host');
  assert.equal(fs.existsSync(inside), false, 'a refused nested destination is not created');
});

/* ============================================================== argument gates */

test('a request that is not the documented shape is refused without a filesystem write', async (t) => {
  const fixture = buildFixture(t, 'shape', { seed: false });
  const output = publishTarget(fixture);
  const before = snapshotTree(fixture.outputParent);

  await expectCode(exportChallenge({ output }), EXPORT_ERROR_CODES.INVALID_ARGUMENT, 'a missing challenge');
  await expectCode(exportChallenge({ challenge: packageFor(fixture) }), EXPORT_ERROR_CODES.INVALID_ARGUMENT,
    'a missing output');
  await expectCode(exportChallenge(null), EXPORT_ERROR_CODES.INVALID_ARGUMENT,
    'a null options object');
  await expectCode(exportChallenge([]), EXPORT_ERROR_CODES.INVALID_ARGUMENT, 'an array of options');
  await expectCode(exportChallenge(packageFor(fixture)), EXPORT_ERROR_CODES.INVALID_ARGUMENT,
    'a package passed instead of an options object');
  await expectCode(exportTo(fixture, output, { packageExtra: { extraMember: true } }),
    EXPORT_ERROR_CODES.INVALID_ARGUMENT, 'an unknown package member');
  await expectCode(exportChallenge({ challenge: packageFor(fixture), output, extraOption: true }),
    EXPORT_ERROR_CODES.INVALID_ARGUMENT, 'an unknown option');
  for (const required of ['identity', 'sourceRoot', 'fileManifest']) {
    const packageObject = packageFor(fixture);
    delete packageObject[required];
    await expectCode(exportChallenge({ challenge: packageObject, output }), EXPORT_ERROR_CODES.INVALID_ARGUMENT,
      `${required} is required`);
  }
  assert.deepEqual(snapshotTree(fixture.outputParent), before, 'a refused request writes nothing at all');
});

test('an identity that is not a valid record is refused before the workload is read', async (t) => {
  const fixture = buildFixture(t, 'identity');
  const output = publishTarget(fixture);

  const staleDigest = structuredClone(fixture.identity);
  staleDigest.starterInventory = Object.freeze([...structuredClone(staleDigest.starterInventory).slice(1)]);
  await expectCode(exportTo(fixture, output, { identity: staleDigest }), EXPORT_ERROR_CODES.INVALID_ARGUMENT,
    'an identity whose inventory no longer matches its digest');

  const missingField = structuredClone(fixture.identity);
  delete missingField.challengeVersion;
  await expectCode(exportTo(fixture, output, { identity: missingField }), EXPORT_ERROR_CODES.INVALID_ARGUMENT,
    'a missing identity field');

  await expectCode(exportTo(fixture, output, { identity: { schemaVersion: '1.0.0' } }),
    EXPORT_ERROR_CODES.INVALID_ARGUMENT, 'an almost empty identity');
  await expectCode(exportTo(fixture, output, { identity: null }), EXPORT_ERROR_CODES.INVALID_ARGUMENT,
    'a null identity');
  assert.equal(fs.existsSync(output), false, 'a refused identity creates no destination');
  assert.deepEqual(fs.readdirSync(fixture.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'a refused identity creates no staging material');
});

test('roots and manifest entries are validated exactly as documented', async (t) => {
  const fixture = buildFixture(t, 'roots', { seed: false });
  const output = publishTarget(fixture);

  // Two different refusals for two different defects. A spelling that is not an
  // explicit absolute path at all is an argument error; a spelling that is a
  // whole volume root passes the absoluteness check and is then refused by the
  // disjointness contract, which never admits a root that contains everything.
  for (const bad of ['relative/source', '', '\\\\host\\share']) {
    await expectCode(exportTo(fixture, output, { sourceRoot: bad }), EXPORT_ERROR_CODES.INVALID_ARGUMENT,
      `the root spelling ${JSON.stringify(bad)}`);
  }
  for (const volume of ['/', ...(process.platform === 'win32' ? ['C:\\'] : [])]) {
    await expectCode(exportTo(fixture, output, { sourceRoot: volume }), EXPORT_ERROR_CODES.INVALID_ROOT,
      `the volume root ${JSON.stringify(volume)}`);
  }
  await expectCode(exportTo(fixture, path.join(fixture.outputParent, 'bad\u0000name')),
    EXPORT_ERROR_CODES.INVALID_ARGUMENT, 'a destination with a control character');
  await expectCode(exportTo(fixture, output, { ownerRoots: ['..'] }), EXPORT_ERROR_CODES.INVALID_ARGUMENT,
    'a relative owner root');
  await expectCode(exportTo(fixture, output, { ownerRoots: 'a string' }), EXPORT_ERROR_CODES.INVALID_ARGUMENT,
    'an owner root list that is not a list');
  // The protected lists are part of the contract: "nothing to protect" is stated
  // by an empty list, never by silence, so an omitted or null list is a malformed
  // package rather than an implicit empty one.
  await expectCode(exportTo(fixture, output, { ownerRoots: null }), EXPORT_ERROR_CODES.INVALID_ARGUMENT,
    'a null owner root list');
  await expectCode(exportTo(fixture, output, { evaluatorRoots: null }), EXPORT_ERROR_CODES.INVALID_ARGUMENT,
    'a null evaluator root list');
  await expectCode(exportTo(fixture, output, { ownerRoots: void 0 }), EXPORT_ERROR_CODES.INVALID_ARGUMENT,
    'an omitted owner root list');
  await expectCode(exportTo(fixture, output, { evaluatorRoots: void 0 }), EXPORT_ERROR_CODES.INVALID_ARGUMENT,
    'an omitted evaluator root list');

  /* Repetition, equality and nesting inside the protected set are accepted. */
  // A protected set is a set of places to keep out of the destination, not a list
  // of peers to compare with each other. A real challenge host holds the source,
  // the owner's private material and the hidden evaluator at once, so these
  // packages name more protected ground and must reach the filesystem rather
  // than be refused here; the unseeded fixture reports the missing source root,
  // which is the observable proof that the root gate let them through.
  const reachedTheFilesystem = EXPORT_ERROR_CODES.SOURCE_NOT_FOUND;
  await expectCode(exportTo(fixture, output, { ownerRoots: [fixture.ownerRoot, fixture.ownerRoot] }),
    reachedTheFilesystem, 'an owner root named twice is protected twice, not refused');
  await expectCode(exportTo(fixture, output, { ownerRoots: [fixture.sourceRoot] }),
    reachedTheFilesystem, 'an owner root that is the source root');
  await expectCode(exportTo(fixture, output, { ownerRoots: [path.join(fixture.sourceRoot, 'src')] }),
    reachedTheFilesystem, 'an owner root inside the source root');
  await expectCode(exportTo(fixture, output, { evaluatorRoots: [fixture.ownerRoot] }),
    reachedTheFilesystem, 'an evaluator root that is the owner root');
  await expectCode(exportTo(fixture, output, { evaluatorRoots: [path.join(fixture.ownerRoot, 'hidden-tests')] }),
    reachedTheFilesystem, 'an evaluator root inside the owner root');
  // The two lists may overlap each other and themselves: the owner's hidden test
  // directory is both owner ground and evaluator ground, so a package that names it
  // from both sides is describing one place accurately rather than conflicting.
  await expectCode(exportTo(fixture, output, {
    ownerRoots: [fixture.ownerRoot, path.join(fixture.ownerRoot, 'hidden-tests'), fixture.evaluatorRoot],
    evaluatorRoots: [fixture.evaluatorRoot, fixture.ownerRoot],
  }), reachedTheFilesystem, 'a protected set whose members contain each other');
  // An empty protected list is the documented way to state "there is none", so it
  // is accepted by the gate and reaches the very same filesystem stage.
  await expectCode(exportTo(fixture, output, { ownerRoots: [], evaluatorRoots: [] }),
    reachedTheFilesystem, 'an explicitly empty protected set');

  /* The destination is still gated against every protected root, both ways. */
  // Two distinct defects, two distinct codes: naming the same directory twice is
  // a duplicate, while a root that contains or sits inside another is an overlap.
  await expectCode(exportTo(fixture, path.join(fixture.sourceRoot, 'workspace')),
    EXPORT_ERROR_CODES.ROOTS_OVERLAP, 'a destination inside the source root');
  await expectCode(exportTo(fixture, fixture.sourceRoot),
    EXPORT_ERROR_CODES.DUPLICATE_ROOT, 'a destination naming the source root again');
  await expectCode(exportTo(fixture, fixture.root),
    EXPORT_ERROR_CODES.ROOTS_OVERLAP, 'a destination that is an ancestor of the source root');
  await expectCode(exportTo(fixture, path.join(fixture.evaluatorRoot, 'workspace')),
    EXPORT_ERROR_CODES.ROOTS_OVERLAP, 'a destination inside the evaluator root');
  await expectCode(exportTo(fixture, fixture.evaluatorRoot),
    EXPORT_ERROR_CODES.DUPLICATE_ROOT, 'a destination naming the evaluator root again');
  await expectCode(exportTo(fixture, path.join(fixture.ownerRoot, 'workspace')),
    EXPORT_ERROR_CODES.ROOTS_OVERLAP, 'a destination inside the owner root');
  await expectCode(exportTo(fixture, fixture.ownerRoot),
    EXPORT_ERROR_CODES.DUPLICATE_ROOT, 'a destination naming the owner root again');
  // A destination that escapes only one of several protected roots still escapes,
  // so the gate is applied to each of them in turn rather than to the first.
  await expectCode(exportTo(fixture, path.join(fixture.ownerRoot, 'nested'), { evaluatorRoots: [] }),
    EXPORT_ERROR_CODES.ROOTS_OVERLAP, 'a destination inside the owner root with no evaluator root stated');
  await expectCode(exportTo(fixture, path.join(fixture.evaluatorRoot, 'nested'), { ownerRoots: [] }),
    EXPORT_ERROR_CODES.ROOTS_OVERLAP, 'a destination inside the evaluator root with no owner root stated');
  // And a set may grow: adding an ancestor to the protected ground immediately
  // encloses a destination that was admissible before, which is what proves every
  // member is gated rather than only the first of them.
  await expectCode(exportTo(fixture, path.join(fixture.outputParent, 'workspace'), { ownerRoots: [fixture.root] }),
    EXPORT_ERROR_CODES.ROOTS_OVERLAP, 'a destination enclosed by an extra protected ancestor');

  await expectCode(exportTo(fixture, output, { fileManifest: [...fixture.paths.slice(0, -1), '../escape'] }),
    EXPORT_ERROR_CODES.INVALID_ARGUMENT, 'a traversal manifest entry');
  await expectCode(exportTo(fixture, output, { fileManifest: [...fixture.paths.slice(0, -1), 'src\\App.tsx'] }),
    EXPORT_ERROR_CODES.INVALID_ARGUMENT, 'a backslash manifest entry');
  await expectCode(exportTo(fixture, output, { fileManifest: [...fixture.paths.slice(0, -1), './README.md'] }),
    EXPORT_ERROR_CODES.INVALID_ARGUMENT, 'a manifest entry with a dot segment');
  await expectCode(exportTo(fixture, output, { fileManifest: [...fixture.paths, fixture.paths[0]] }),
    EXPORT_ERROR_CODES.INVALID_ARGUMENT, 'a repeated manifest entry');
  await expectCode(exportTo(fixture, output, { fileManifest: 'README.md' }),
    EXPORT_ERROR_CODES.INVALID_ARGUMENT, 'a manifest that is not a list');
  await expectCode(exportTo(fixture, output, { fileManifest: [...fixture.paths.slice(0, -1), null] }),
    EXPORT_ERROR_CODES.INVALID_ARGUMENT, 'a manifest entry that is not a string');
  assert.equal(fs.existsSync(output), false, 'a refused root or manifest creates nothing');
});

test('a manifest that is not the accepted workload contract is refused', async (t) => {
  const fixture = buildFixture(t, 'manifest-count');
  const output = publishTarget(fixture);

  await expectCode(exportTo(fixture, output, { fileManifest: fixture.paths.slice(0, 25) }),
    EXPORT_ERROR_CODES.WORKLOAD_MISMATCH, 'a manifest with one file too few');
  await expectCode(exportTo(fixture, output, { fileManifest: [...fixture.paths, 'extra.txt'] }),
    EXPORT_ERROR_CODES.WORKLOAD_MISMATCH, 'a manifest with one file too many');
  // A manifest that names 26 files which are not the identity inventory is a
  // different workload, even though the count alone would look right.
  const renamed = [...fixture.paths.slice(0, -1), 'not-in-the-identity.txt'];
  await expectCode(exportTo(fixture, output, { fileManifest: renamed }),
    EXPORT_ERROR_CODES.WORKLOAD_MISMATCH, 'a manifest that is not the identity inventory');
  assert.equal(fs.existsSync(output), false, 'a refused manifest publishes nothing');
});

/* ================================================================= source gates */

test('source bytes that do not match the identity are refused before publication', async (t) => {
  const fixture = buildFixture(t, 'drift');
  const output = publishTarget(fixture);

  fs.writeFileSync(path.join(fixture.sourceRoot, 'README.md'), 'changed by somebody else\n', 'utf8');
  const error = await expectCode(exportTo(fixture, output), EXPORT_ERROR_CODES.WORKLOAD_MISMATCH,
    'a mutated workload file');
  // The whole-workload digest is compared first, so the refusal is the identity
  // mismatch and carries both digests rather than one file name.
  assert.match(error.message, /does not match the challenge identity/, 'the refusal states the identity mismatch');
  assert.match(error.message, new RegExp(fixture.identity.workloadDigest), 'the refusal carries the expected digest');
  assert.equal(error.path, void 0, 'a whole-workload mismatch names no single file');
  assert.equal(fs.existsSync(output), false, 'a mismatching source publishes nothing');

  const second = buildFixture(t, 'private-extra');
  fs.writeFileSync(path.join(second.sourceRoot, 'private-notes.txt'), 'previous solution material\n', 'utf8');
  const extra = await expectCode(exportTo(second, publishTarget(second)), EXPORT_ERROR_CODES.WORKLOAD_MISMATCH,
    'a private extra file inside the source');
  assert.match(extra.message, /private-notes\.txt/, 'the refusal names the private extra file');
  assert.deepEqual(fs.readdirSync(second.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'a refused source leaves no staging residue');
});

test('a source that is absent, incomplete or not a regular file set is refused', async (t) => {
  const fixture = buildFixture(t, 'source-shape');

  const absent = buildFixture(t, 'source-absent', { seed: false });
  await expectCode(exportTo(absent, publishTarget(absent)), EXPORT_ERROR_CODES.SOURCE_NOT_FOUND,
    'a source root that does not exist');

  const trimmed = buildFixture(t, 'source-trimmed');
  fs.rmSync(path.join(trimmed.sourceRoot, 'README.md'), { force: true });
  await expectCode(exportTo(trimmed, publishTarget(trimmed)), EXPORT_ERROR_CODES.WORKLOAD_MISMATCH,
    'a workload file that is absent');

  const asDirectory = buildFixture(t, 'source-directory');
  fs.rmSync(path.join(asDirectory.sourceRoot, 'package.json'), { force: true });
  fs.mkdirSync(path.join(asDirectory.sourceRoot, 'package.json'), { recursive: true });
  await expectCode(exportTo(asDirectory, publishTarget(asDirectory)), EXPORT_ERROR_CODES.WORKLOAD_MISMATCH,
    'a workload path that is a directory');

  const asFile = buildFixture(t, 'source-as-file', { seed: false });
  fs.writeFileSync(path.join(asFile.root, 'not-a-directory'), 'a file where a root is named\n', 'utf8');
  await expectCode(exportTo(asFile, publishTarget(asFile), { sourceRoot: path.join(asFile.root, 'not-a-directory') }),
    EXPORT_ERROR_CODES.SOURCE_NOT_FOUND, 'a source root that is a file');
  assert.equal(fs.existsSync(publishTarget(asFile)), false, 'no destination is created for an absent source');
});

test('a source that is not link-safe is refused, including a link above the root', async (t) => {
  const fixture = buildFixture(t, 'source-link');
  const output = publishTarget(fixture);

  fs.symlinkSync(fixture.sourceRoot, path.join(fixture.root, 'junction-source'), 'junction');
  await expectCode(exportTo(fixture, output, { sourceRoot: path.join(fixture.root, 'junction-source') }),
    EXPORT_ERROR_CODES.SOURCE_UNSAFE, 'a source root reached through a junction');

  const second = buildFixture(t, 'source-inner-link');
  fs.symlinkSync(path.join(second.ownerRoot, 'owner-secret.txt'),
    path.join(second.sourceRoot, 'owner-secret.txt'), 'junction');
  const inner = await expectCode(exportTo(second, publishTarget(second)), EXPORT_ERROR_CODES.SOURCE_UNSAFE,
    'a link standing inside the source tree');
  assert.match(inner.message, /owner-secret\.txt/, 'the refusal names the link');
  assert.equal(fs.existsSync(publishTarget(second)), false, 'an unsafe source publishes nothing');
  assert.deepEqual(fs.readFileSync(path.join(second.ownerRoot, 'owner-secret.txt'), 'utf8'),
    'owner-private-material\n', 'the private owner material was not read into a workspace');
});

test('a case-folded collision inside the source is refused', async (t) => {
  if (isScratchCaseInsensitive(t)) {
    t.skip('the scratch volume folds name case, so README.md and README.MD cannot both exist here; the volume ' +
      'itself makes the twin a rewrite of the declared file, which the mutated-bytes refusal already covers');
    return;
  }

  const fixture = buildFixture(t, 'collision');
  const output = publishTarget(fixture);
  const twin = 'README.MD';

  fs.writeFileSync(path.join(fixture.sourceRoot, twin), 'case-folded twin\n', 'utf8');
  const error = await expectCode(exportTo(fixture, output), EXPORT_ERROR_CODES.WORKLOAD_MISMATCH,
    'a case-folded collision in the source inventory');
  assert.match(error.message, new RegExp(twin.replace('.', '\\.')), 'the refusal names the colliding spelling');
  assert.equal(fs.existsSync(output), false, 'a colliding source publishes nothing');
});

/* ========================================================== destination refusal */

test('an existing destination is refused and nothing about it is changed', async (t) => {
  const fixture = buildFixture(t, 'existing');

  const occupied = publishTarget(fixture, 'occupied');
  fs.mkdirSync(occupied, { recursive: true });
  fs.writeFileSync(path.join(occupied, 'existing-file.txt'), 'pre-existing content\n', 'utf8');
  const before = snapshotTree(occupied);
  await expectCode(exportTo(fixture, occupied), EXPORT_ERROR_CODES.DESTINATION_EXISTS,
    'a destination directory that already exists');
  assert.deepEqual(snapshotTree(occupied), before, 'the existing destination is byte-for-byte unchanged');

  const asFile = publishTarget(fixture, 'file-destination');
  fs.writeFileSync(asFile, 'a file in the way\n', 'utf8');
  await expectCode(exportTo(fixture, asFile), EXPORT_ERROR_CODES.DESTINATION_EXISTS,
    'a destination path that is an existing file');
  assert.equal(fs.readFileSync(asFile, 'utf8'), 'a file in the way\n', 'the existing file is untouched');
  assert.deepEqual(fs.readdirSync(fixture.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'a refused destination leaves no staging residue');
});

test('a destination whose parent is absent or not a directory is refused without a write', async (t) => {
  const fixture = buildFixture(t, 'parent');
  const missing = path.join(fixture.outputParent, 'absent-parent', 'workspace');
  await expectCode(exportTo(fixture, missing), EXPORT_ERROR_CODES.DESTINATION_PARENT_MISSING,
    'a destination whose parent does not exist');
  assert.equal(fs.existsSync(path.join(fixture.outputParent, 'absent-parent')), false,
    'no parent is created on the way to a refusal');

  const blocked = path.join(fixture.outputParent, 'blocked');
  fs.writeFileSync(blocked, 'a file where a parent is named\n', 'utf8');
  await expectCode(exportTo(fixture, path.join(blocked, 'workspace')), EXPORT_ERROR_CODES.DESTINATION_PARENT_MISSING,
    'a destination whose parent is a file');
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'a file where a parent is named\n', 'the blocking file is untouched');
});

test('a destination parent that is, or sits beneath, a link is refused as unsafe', async (t) => {
  const fixture = buildFixture(t, 'parent-link');
  const realTarget = path.join(fixture.root, 'real-target');
  fs.mkdirSync(realTarget, { recursive: true });
  fs.symlinkSync(realTarget, path.join(fixture.root, 'linked-parent'), 'junction');

  await expectCode(exportTo(fixture, path.join(fixture.root, 'linked-parent', 'workspace')),
    EXPORT_ERROR_CODES.DESTINATION_UNSAFE, 'a destination parent reached through a junction');
  assert.deepEqual(snapshotTree(realTarget), {}, 'no staging material appears behind the junction');

  const second = buildFixture(t, 'parent-junction');
  fs.symlinkSync(second.outputParent, path.join(second.root, 'junction-parent'), 'junction');
  await expectCode(exportTo(second, path.join(second.root, 'junction-parent', 'workspace')),
    EXPORT_ERROR_CODES.DESTINATION_UNSAFE, 'a destination parent that is a junction');
  assert.deepEqual(fs.readdirSync(second.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'no staging material is created through a linked parent');
});

test('a concurrent writer that reserved the destination first is left alone', async (t) => {
  const fixture = buildFixture(t, 'concurrent');
  const output = publishTarget(fixture);
  const foreignFile = path.join(output, 'solution.json');

  // A concurrent publication created the destination while this export was
  // verifying its source, so the export must refuse it and leave it untouched.
  fs.mkdirSync(output, { recursive: false });
  fs.writeFileSync(foreignFile, '{"stolen":true}\n', 'utf8');

  await expectCode(exportTo(fixture, output), EXPORT_ERROR_CODES.DESTINATION_EXISTS,
    'a destination a concurrent writer created first');
  assert.equal(fs.readFileSync(foreignFile, 'utf8'), '{"stolen":true}\n', 'the concurrent material is untouched');
  assert.deepEqual(Object.keys(snapshotTree(output)), ['solution.json'], 'nothing else was written there');
  assert.deepEqual(fs.readdirSync(fixture.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'the refused call removed its own staging directory');
});

test('foreign staging material of another operation is never touched', async (t) => {
  const fixture = buildFixture(t, 'foreign-staging');
  const output = publishTarget(fixture);
  const foreignStaging = path.join(fixture.outputParent, `${STAGING_PREFIX}foreign`);
  fs.mkdirSync(foreignStaging, { recursive: true });
  fs.writeFileSync(path.join(foreignStaging, 'foreign-staged.bin'), 'foreign staged bytes\n', 'utf8');
  fs.mkdirSync(output, { recursive: true });

  await expectCode(exportTo(fixture, output), EXPORT_ERROR_CODES.DESTINATION_EXISTS, 'the reserved destination');
  const residue = fs.readdirSync(fixture.outputParent).filter((name) => name.startsWith(STAGING_PREFIX));
  assert.deepEqual(residue, [`${STAGING_PREFIX}foreign`], 'only the foreign staging directory remains');
  assert.equal(fs.readFileSync(path.join(foreignStaging, 'foreign-staged.bin'), 'utf8'), 'foreign staged bytes\n',
    'the foreign staged bytes are byte-identical');
  assert.equal(fs.existsSync(path.join(output, 'README.md')), false,
    'nothing was published into the reserved destination');
});

/* =================================================== hostile primitives, proven both ways */

/*
 * A link or a special file inside the source is proven twice over, by two
 * different means, because a single run of either one is not evidence on every
 * host:
 *
 *   - the real primitive, when this host permits creating it (the link tests in
 *     the source-gate section create a genuine link and read a genuine refusal);
 *   - the reported entry, injected into the directory listing the module itself
 *     reads, which proves the refusal on every host and is independent of whether
 *     this volume permits links or FIFOs at all.
 *
 * The stubbed branch therefore runs unconditionally. It never asserts that the
 * host is unable: when the host can create the primitive, the diagnostic states
 * that the real-primitive test carries the same claim as well, so the suite is
 * honest about which of the two proofs was available here.
 */
test('a file link inside the source fails closed, reported or real', async (t) => {
  const probeDirectory = scratch(t, 'symlink-probe');
  const realLinkAvailable = hostCanCreate(probeDirectory, 'symlink', 'probe-link');
  if (realLinkAvailable) {
    t.diagnostic('this host may create file links, so the real-primitive proof in the source-gate section '
      + 'applies to this case as well; the reported-entry proof below is run regardless');
  }

  const fixture = buildFixture(t, 'stub-link');
  const output = publishTarget(fixture);
  const original = patchPromiseNamespace(t, 'readdir', async (...call) => {
    const entries = await original(...call);
    const target = String(call[0]);
    if (path.resolve(target) !== path.resolve(fixture.sourceRoot)) return entries;
    return [...entries, syntheticEntry('secret-link', 'link')];
  });

  const error = await expectCode(exportTo(fixture, output), EXPORT_ERROR_CODES.SOURCE_UNSAFE,
    'a file link reported inside the source');
  assert.match(error.message, /secret-link/, 'the refusal names the link');
  assert.equal(error.path, 'secret-link', 'the refusal carries the offending relative path');
  assert.equal(fs.existsSync(output), false, 'nothing was published');
  assert.deepEqual(fs.readdirSync(fixture.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'no staging residue is left behind');
});

test('a special file inside the source fails closed, reported or real', async (t) => {
  const probeDirectory = scratch(t, 'fifo-probe');
  if (hostCanCreate(probeDirectory, 'fifo', 'probe-fifo')) {
    t.diagnostic('this host may create a FIFO, so a real special file can be placed in the source here; '
      + 'the reported-entry proof below is run regardless');
  }

  const fixture = buildFixture(t, 'stub-special');
  const output = publishTarget(fixture);
  const original = patchPromiseNamespace(t, 'readdir', async (...call) => {
    const entries = await original(...call);
    if (path.resolve(String(call[0])) !== path.resolve(fixture.sourceRoot)) return entries;
    return [...entries, syntheticEntry('weird-entry', 'special')];
  });

  const error = await expectCode(exportTo(fixture, output), EXPORT_ERROR_CODES.SOURCE_UNSAFE,
    'a non-regular file reported inside the source');
  assert.match(error.message, /weird-entry/, 'the refusal names the special file');
  assert.equal(fs.existsSync(output), false, 'nothing was published');
});

test('a published container that is not exactly the workload fails closed', async (t) => {
  const fixture = buildFixture(t, 'stub-published');
  const output = publishTarget(fixture);
  // The destination is listed exactly once: inside the published verification
  // round, after every workload byte was written into the reserved container.
  // Injecting one non-regular entry into that listing is therefore the narrowest
  // way to prove the published container is validated, not assumed.
  const original = patchPromiseNamespace(t, 'readdir', async (...call) => {
    const entries = await original(...call);
    if (path.resolve(String(call[0])) !== path.resolve(output)) return entries;
    return [...entries, syntheticEntry('injected-special', 'special')];
  });

  const error = await expectCode(exportTo(fixture, output), EXPORT_ERROR_CODES.PUBLICATION_FAILED,
    'a published container with a non-regular entry');
  assert.match(error.message, /injected-special/, 'the refusal names the injected entry');
  assert.equal(error.path, 'injected-special', 'the refusal carries the offending relative path');
  assert.deepEqual(fs.readdirSync(fixture.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'no staging residue is left behind');
  // The refused container is owned by this operation, so it is removed with the
  // staging directory and no half-published workspace is left to be mistaken.
  assert.equal(fs.existsSync(output), false, 'the unverified container is not left behind');
  assert.ok(!fs.lstatSync(fixture.sourceRoot).isSymbolicLink(), 'the source root is still a plain directory');
});

/* ============================================ T5 boundary and cleanup regressions */

/*
 * The failures the C2 review demonstrated are pinned here as permanent regressions:
 * a link hidden under a dependency directory, foreign material inside a directory
 * this call reserved, a published container that is not exactly the workload, an
 * injected fault in the middle of the published copy, a published file that some
 * other writer replaced, and the path-spelling guard on a volume that cannot host
 * the two spellings a real collision needs.
 *
 * Every case is driven by the narrowest injection that still reaches the guard
 * under test, and every injection is disclosed by a diagnostic so the evidence is
 * never mistaken for a fault the host produced on its own.
 */

test('a link hidden under a dependency directory in the source is still seen and refused', async (t) => {
  // Dependency material is excluded from the published workload, but it was never
  // a reason to stop looking at it: a link buried inside `node_modules` escapes the
  // published bytes yet must still stop the transaction, because the source is
  // scanned as a physical tree, not as a filtered one.
  const fixture = buildFixture(t, 'hidden-dep-link');
  const output = publishTarget(fixture);
  const hiddenRelative = 'node_modules/foreign-link';
  const hiddenDirectory = path.join(fixture.sourceRoot, 'node_modules');
  const hiddenAbsolute = path.join(hiddenDirectory, 'foreign-link');

  let realJunction = false;
  try {
    fs.mkdirSync(hiddenDirectory, { recursive: true });
    // A directory junction into the protected owner root: private material reachable
    // through a dependency directory, exactly the shape the review demonstrated.
    fs.symlinkSync(fixture.ownerRoot, hiddenAbsolute, 'junction');
    realJunction = true;
  } catch (error) {
    assert.ok(['EPERM', 'ENOSYS', 'ENOENT'].includes(error?.code ?? ''),
      `creating a junction failed with an unexpected error: ${error?.code} ${error?.message}`);
    fs.rmSync(hiddenDirectory, { recursive: true, force: true });
    // The same entry is reported instead, into the listing the module itself reads:
    // the dependency directory in the source listing, the link in its own listing.
    const original = patchPromiseNamespace(t, 'readdir', async (...call) => {
      const target = String(call[0]);
      if (path.resolve(target) === path.resolve(hiddenDirectory)) return [syntheticEntry('foreign-link', 'link')];
      const entries = await original(...call);
      if (path.resolve(target) === path.resolve(fixture.sourceRoot)) {
        return [...entries, syntheticEntry('node_modules', 'directory')];
      }
      return entries;
    });
    void original;
  }
  t.diagnostic(realJunction
    ? 'a real junction inside a real node_modules tree was created here, so the traversal itself is under test'
    : 'this host refused to create a junction, so the same directory and link are reported through the listing '
      + 'the module reads; the traversal and the refusal are the module own');

  const error = await expectCode(exportTo(fixture, output, { ownerRoots: [], evaluatorRoots: [] }),
    EXPORT_ERROR_CODES.SOURCE_UNSAFE, 'a symbolic link inside a dependency directory');
  assert.equal(error.path, hiddenRelative, 'the refusal names the hidden link by its relative path');
  assert.match(error.message, /symbolic link/, 'the refusal says what it found');
  assert.equal(fs.existsSync(output), false, 'nothing was published');
  assert.deepEqual(fs.readdirSync(fixture.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'no staging residue is left behind');
  if (realJunction) {
    // Refusing is not the same as repairing: the unsafe entry is left exactly where it
    // was found, because removing it would be this call destroying source material.
    assert.ok(fs.lstatSync(hiddenAbsolute).isSymbolicLink(), 'the unsafe source entry is left in place');
  }
  assert.ok(fs.existsSync(path.join(fixture.ownerRoot, 'owner-secret.txt')),
    'the private material the link pointed at is untouched');
});

test('a foreign file written inside the reserved destination is preserved and reported, never deleted', async (t) => {
  // A recursive sweep through a published root would destroy what a concurrent writer
  // put there. The refusal therefore keeps the foreign bytes and says so.
  const fixture = buildFixture(t, 'foreign-canary');
  const output = publishTarget(fixture);
  const before = snapshotTree(fixture.sourceRoot);
  const canaryPath = path.join(output, 'foreign-canary.txt');
  const canaryBytes = 'FOREIGN-DO-NOT-DELETE';

  let injected = false;
  const original = patchPromiseNamespace(t, 'open', async (...call) => {
    const [target, flags] = call;
    if (!injected && typeof target === 'string' && typeof flags === 'string'
      && path.dirname(target) === output) {
      // The first read-back inside the reserved container is the moment a concurrent
      // writer is given; the entry then really exists before the container is listed.
      injected = true;
      fs.writeFileSync(canaryPath, canaryBytes, 'utf8');
    }
    return original(...call);
  });
  void original;

  const error = await expectCode(exportTo(fixture, output), EXPORT_ERROR_CODES.PUBLICATION_FAILED,
    'a published container a concurrent writer put a file into');
  assert.ok(injected, 'the concurrent write actually happened');
  assert.match(error.message, /is not exactly the workload \(missing: 0, extra: 1\)/,
    'the container is validated against the workload, not trusted');
  assert.equal(error.path, void 0, 'a whole-container refusal names no single path');
  // The refusal counts the discrepancy rather than echoing a foreign entry's name into
  // a public error; where the material sits is disclosed by the residue report below.

  // The disclosed residue: what this call wrote is removed, what it did not write stays.
  assert.ok(error.cleanup instanceof ChallengeExportError, 'the residue is reported on the failure');
  assert.equal(error.cleanup.code, EXPORT_ERROR_CODES.CLEANUP_FAILED, 'the residue is reported as cleanup residue');
  assert.match(error.cleanup.message, /kept because it is not this call's material/, 'the residue is named as such');
  assert.ok(error.cleanup.message.includes(JSON.stringify(output)),
    'the residue names the directory that was kept, so the operator can find it');

  assert.equal(fs.existsSync(output), true, 'a directory holding foreign material is not taken down');
  assert.deepEqual(fs.readdirSync(output), ['foreign-canary.txt'],
    'only the foreign entry is left; every byte this call wrote was removed');
  assert.equal(fs.readFileSync(canaryPath, 'utf8'), canaryBytes, 'the foreign bytes are byte-identical');
  assert.deepEqual(fs.readdirSync(fixture.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'no staging residue is left behind');
  assert.deepEqual(snapshotTree(fixture.sourceRoot), before, 'the source is untouched');
});

test('a dependency directory inside the published workspace is refused as not exactly the workload', async (t) => {
  // No dependency or version-control material is published, so its presence in the
  // container is a defect, not something to tolerate.
  const fixture = buildFixture(t, 'published-extra-dir');
  const output = publishTarget(fixture);
  // A real dependency directory appearing inside the reserved destination during
  // publication, as a concurrent installer would leave it. The container is verified from
  // the filesystem, so the injection has to be a real one: a listing stub could only
  // invent a directory the very same listing is then asked to descend into.
  let injected = false;
  const original = patchPromiseNamespace(t, 'open', async (...call) => {
    const [target, flags] = call;
    if (!injected && typeof target === 'string' && typeof flags === 'string'
      && path.dirname(target) === output) {
      injected = true;
      fs.mkdirSync(path.join(output, 'node_modules'));
    }
    return original(...call);
  });
  void original;

  const error = await expectCode(exportTo(fixture, output), EXPORT_ERROR_CODES.PUBLICATION_FAILED,
    'a published container with an extra dependency directory');
  assert.ok(injected, 'the dependency directory actually appeared inside the destination');
  assert.match(error.message, /is not exactly the workload \(missing: 0, extra: 1\)/,
    'the extra entry is counted, not skipped');
  assert.equal(error.path, void 0, 'a whole-container refusal names no single path');
  // The count is the disclosure; the entry name is deliberately not echoed into a public
  // error, and where the material sits is disclosed by the residue report.

  assert.ok(error.cleanup instanceof ChallengeExportError, 'the kept material is reported on the failure');
  assert.equal(error.cleanup.code, EXPORT_ERROR_CODES.CLEANUP_FAILED, 'it is reported as residue');
  assert.match(error.cleanup.message, /kept because it is not this call's material/, 'the residue is named as such');
  assert.ok(fs.existsSync(path.join(output, 'node_modules')),
    'material this call did not create is left in place, never deleted');
  assert.equal(fs.existsSync(output), true, 'a container holding foreign material is not taken down');
  assert.deepEqual(fs.readdirSync(fixture.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'no staging residue is left behind');
});

test('a dependency directory in the source is refused outright instead of published around', async (t) => {
  const fixture = buildFixture(t, 'source-dep-dir');
  const output = publishTarget(fixture);
  fs.mkdirSync(path.join(fixture.sourceRoot, 'dist', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(fixture.sourceRoot, 'dist', 'assets', 'built.js'), 'bundled\n', 'utf8');

  const error = await expectCode(exportTo(fixture, output), EXPORT_ERROR_CODES.WORKLOAD_MISMATCH,
    'a source carrying a build directory');
  assert.match(error.message, /dependency or version-control director/, 'the refusal says what kind of entry it is');
  assert.match(error.message, /dist/, 'the refusal names the offending directory');
  assert.equal(error.path, void 0, 'a whole-source refusal names no single path');
  assert.equal(fs.existsSync(output), false, 'nothing was published');
  assert.deepEqual(fs.readdirSync(fixture.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'no staging residue is left behind');
});

test('an injected fault in the published copy leaves no half workspace and no residue', async (t) => {
  const fixture = buildFixture(t, 'published-fault');
  const output = publishTarget(fixture);
  const before = snapshotTree(fixture.sourceRoot);
  const victim = 'README.md';
  const victimAbsolute = path.join(output, victim);

  let faulted = false;
  const original = patchPromiseNamespace(t, 'open', async (...call) => {
    const [target, flags] = call;
    if (!faulted && typeof target === 'string' && target === victimAbsolute
      && typeof flags === 'number' && (flags & fs.constants.O_WRONLY) === fs.constants.O_WRONLY) {
      faulted = true;
      const fault = new Error('simulated storage failure while the published copy was in flight');
      fault.code = 'ENOSPC';
      throw fault;
    }
    return original(...call);
  });
  void original;

  const error = await expectCode(exportTo(fixture, output), EXPORT_ERROR_CODES.PUBLICATION_FAILED,
    'a published write the filesystem refuses');
  assert.ok(faulted, 'the fault was applied to the published copy');
  assert.equal(error.path, victim, 'the failure names the file that could not be written');
  assert.match(error.message, /could not be written/, 'the failure says what it was doing');
  // The refused write names its path through `error.path`, which is where the machine
  // readable location is carried; the message states the operation, and the relative
  // path is quoted inside it rather than repeated as the whole message.
  assert.match(error.message, /"README\.md"/, 'the message quotes the file it could not write');
  assert.ok(error.cleanup === void 0,
    'everything this call created was its own, so no residue is reported');
  assert.equal(fs.existsSync(output), false, 'no half-published workspace survives the failure');
  assert.deepEqual(fs.readdirSync(fixture.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'no staging residue is left behind');
  assert.deepEqual(snapshotTree(fixture.sourceRoot), before, 'the source is untouched');
});

test('a published file another writer replaced is kept as residue rather than deleted', async (t) => {
  const fixture = buildFixture(t, 'published-replaced');
  const output = publishTarget(fixture);
  const victim = 'README.md';
  const victimAbsolute = path.join(output, victim);
  const foreignBytes = 'REPLACED-BY-ANOTHER-WRITER';
  // The published pass ends with the last workload file in digested order; until that
  // file exists the copy is still in flight, and a write caught mid-flight is the
  // publication pass' own error. This proof is about the verification round, so the
  // replacement waits for the copy to be complete.
  const lastWorkloadFile = path.join(output, 'vite.config.ts');

  let replaced = false;
  const original = patchPromiseNamespace(t, 'open', async (...call) => {
    const [target, flags] = call;
    if (!replaced && typeof target === 'string' && target === victimAbsolute && typeof flags === 'string'
      && fs.existsSync(lastWorkloadFile)) {
      // The published verification round is about to read this file back; another
      // writer's bytes are what it finds.
      replaced = true;
      fs.writeFileSync(victimAbsolute, foreignBytes, 'utf8');
    }
    return original(...call);
  });
  void original;

  const error = await expectCode(exportTo(fixture, output), EXPORT_ERROR_CODES.WORKLOAD_MISMATCH,
    'a published file that no longer holds this call bytes');
  assert.ok(replaced, 'the replacement actually happened');
  // The published bytes are verified against the identity, and the whole-inventory form
  // of that verdict is what a single replaced file raises. Its wording names the source
  // inventory even for the published round; see the handoff finding on that wording.
  assert.match(error.message, /does not match the challenge identity/, 'the published bytes are verified, not assumed');

  assert.ok(error.cleanup instanceof ChallengeExportError, 'the residue is reported on the failure');
  assert.equal(error.cleanup.code, EXPORT_ERROR_CODES.CLEANUP_FAILED, 'the residue is reported as cleanup residue');
  assert.match(error.cleanup.message, /kept because it is not this call's material/, 'the residue is named as such');

  assert.equal(fs.existsSync(output), true, 'the container holding foreign bytes is not taken down');
  assert.deepEqual(fs.readdirSync(output), [victim], 'only the replaced file is left behind');
  assert.equal(fs.readFileSync(victimAbsolute, 'utf8'), foreignBytes,
    'bytes this call did not write are never removed');
  assert.deepEqual(fs.readdirSync(fixture.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'no staging residue is left behind');
});

test('the path-spelling guard fires on a volume that cannot host a real collision', async (t) => {
  // The real two-spelling case cannot exist on a case-folding volume, which is why the
  // source-shape case that needs it skips there. The guard itself is the thing under
  // test, so the listing the accepted resolver reads is made to report the folded
  // spelling here, which is exactly what a case-folding volume would genuinely report.
  const fixture = buildFixture(t, 'spelling-guard');
  const output = publishTarget(fixture);
  const declared = 'README.md';
  const reported = 'ReadME.md';
  const folding = isScratchCaseInsensitive(t);
  t.diagnostic(folding
    ? 'this scratch volume folds name case, so the real two-spelling case is impossible here and this proof is the only one'
    : 'this scratch volume is case-sensitive, so a real collision is possible; the reported spelling below is '
      + 'still what a folding volume would report for the same bytes');

  const target = path.resolve(fixture.sourceRoot);
  const original = fs.readdirSync;
  assert.equal(typeof original, 'function', 'node:fs exposes the synchronous listing the resolver uses');
  fs.readdirSync = (directory, ...rest) => {
    const names = original(directory, ...rest);
    if (!Array.isArray(names) || path.resolve(String(directory)) !== target) return names;
    if (!names.includes(declared)) return names;
    return names.filter((name) => name !== declared).concat(reported);
  };
  t.after(() => {
    fs.readdirSync = original;
  });

  const error = await expectCode(exportTo(fixture, output), EXPORT_ERROR_CODES.SOURCE_UNSAFE,
    'a workload file whose on-disk spelling is not the declared one');
  assert.equal(error.path, declared, 'the refusal names the declared path');
  assert.match(error.message, /is not a safe in-root file/, 'the refusal says the path is not safe inside the root');
  assert.match(error.message, /CASE_COLLISION/, 'the refusal carries the accepted path code');
  assert.match(error.message, new RegExp(`^${EXPORT_ERROR_CODES.SOURCE_UNSAFE}: `), 'the code prefixes the message');
  assert.equal(fs.existsSync(output), false, 'nothing was published');
  assert.deepEqual(fs.readdirSync(fixture.outputParent).filter((name) => name.startsWith(STAGING_PREFIX)), [],
    'no staging residue is left behind');
  assert.ok(fs.existsSync(path.join(fixture.sourceRoot, declared)),
    'the source file itself is still there under its declared spelling');
});

/* ========================================================================== types */

test('the shipped declaration pair stays byte-identical and declares the runtime surface', () => {
  const declarationPath = path.join(CORE_ROOT, 'challenge-export.d.ts');
  const siblingPath = path.join(CORE_ROOT, 'challenge-export.d.mts');
  assert.ok(fs.existsSync(siblingPath), 'a .d.mts sibling exists next to the module');
  const declaration = fs.readFileSync(declarationPath, 'utf8');
  assert.equal(fs.readFileSync(siblingPath, 'utf8'), declaration, 'the .d.mts copy is byte-identical to the .d.ts source');

  const source = fs.readFileSync(MODULE_UNDER_TEST, 'utf8');
  const runtimeExports = [...source.matchAll(/^export (?:async )?(?:const|function|class) ([A-Za-z_$][0-9A-Za-z_$]*)/gm)]
    .map((match) => match[1]).sort();
  assert.ok(runtimeExports.length >= 6, `the module exports ${runtimeExports.join(', ')}`);
  for (const name of runtimeExports) {
    assert.match(declaration, new RegExp(`\\b${name}\\b`), `the runtime export ${name} is declared`);
  }
  for (const typeName of ['ChallengePackage', 'ExportChallengeOptions', 'ExportResult', 'ExportedFileEntry']) {
    assert.match(declaration, new RegExp(`export interface ${typeName}\\b`), `${typeName} is declared`);
  }
  assert.match(declaration, /export function exportChallenge\(options: ExportChallengeOptions\): Promise<ExportResult>/,
    'the documented function signature is declared exactly once');
  assert.equal([...declaration.matchAll(/export function exportChallenge/g)].length, 1, 'one declaration of the entry point');
});

test('the pinned TypeScript compiler typechecks the shipped declarations for a real module consumer', (t) => {
  assert.ok(fs.existsSync(PINNED_COMPILER), 'the pinned compiler must be available; no install and no skip');
  const root = scratch(t, 'types');
  const specifier = (name) => {
    const relative = path.relative(root, path.join(CORE_ROOT, name)).split(path.sep).join('/');
    return relative.startsWith('.') ? relative : `./${relative}`;
  };
  const consumer = [
    '/* A real consumer of the shipped declarations, resolved as an ECMAScript module. */',
    `import { sha256 } from "${specifier('identity.mjs')}";`,
    '// The identity type is owned by the C1 contract module, which is where the',
    '// shipped declaration imports it from; a consumer names it at its source.',
    `import { type ChallengeIdentity } from ${JSON.stringify(specifier('manifest.mjs'))};`,
    'import {',
    '  exportChallenge,',
    '  ChallengeExportError,',
    '  EXPORT_ERROR_CODES,',
    '  EXPECTED_WORKLOAD_FILE_COUNT,',
    '  STAGING_PREFIX,',
    '  EXPORTED_FILE_MODE,',
    '  type ChallengePackage,',
    '  type ExportChallengeOptions,',
    '  type ExportResult,',
    '  type ExportedFileEntry,',
    '  type ExportErrorCodes,',
    '  type ReadonlyList,',
    '} from ' + JSON.stringify(specifier('challenge-export.mjs')) + ';',
    '',
    'const entry: ExportedFileEntry = { path: "README.md", bytes: 1, sha256: sha256("a") };',
    'const entries: ReadonlyList<ExportedFileEntry> = [entry];',
    '// The real C1 identity type, with every required member of the shipped contract:',
    '// an omitted or misspelled member is a compile error rather than a silent hole.',
    'const identity: ChallengeIdentity = {',
    '  schemaVersion: "1.0.0",',
    '  kind: "ChallengeIdentity",',
    '  challengeId: "consumer-challenge",',
    '  challengeVersion: "0.1.0",',
    '  architectureId: "arch-consumer",',
    '  architectureKind: "challenge",',
    '  hashAlgorithm: "sha256",',
    '  definitionDigest: sha256("definition"),',
    '  digestProvenance: { kind: "COMPUTED", procedure: "consumer:sha256" },',
    '  workloadProvenance: { kind: "COMPUTED", procedure: "consumer:starter-inventory" },',
    '  publicPrdDigest: sha256("public-prd"),',
    '  visibleHarnessDigest: sha256("visible-harness"),',
    '  fixtureDigest: sha256("fixture"),',
    '  starterInventory: [[entry.path, entry.sha256]] as const,',
    '  workloadDigest: sha256("w"),',
    '  declaredCeilingMinutes: 120,',
    '  candidateLineage: {',
    '    candidateVersion: "1.0.0-candidate.9",',
    '    candidateStatus: "REVIEW_FINDINGS_UNRESOLVED",',
    '    sourceCommit: "c662a4a1b2c3d4e5f60718293a4b5c6d7e8f90a1",',
    '    reviewStatus: "CHANGES_REQUESTED",',
    '  },',
    '};',
    'const challenge: ChallengePackage = {',
    '  identity,',
    '  sourceRoot: "C:/work/source",',
    '  fileManifest: [entry.path],',
    '  ownerRoots: ["C:/work/owner"],',
    '  evaluatorRoots: ["C:/work/evaluator"],',
    '};',
    'const request: ExportChallengeOptions = { challenge, output: "C:/work/out" };',
    'const pending: Promise<ExportResult> = exportChallenge(request);',
    'void pending.then((result) => [result.workspaceRoot, result.workloadDigest, result.inventory.length,',
    '  result.inventory[0]?.path ?? ""]);',
    'const codes: ExportErrorCodes = EXPORT_ERROR_CODES;',
    'const code: ExportErrorCodes["DESTINATION_EXISTS"] = codes.DESTINATION_EXISTS;',
    'const expected: 26 = EXPECTED_WORKLOAD_FILE_COUNT;',
    'const hidden: ".benchboard-export-" = STAGING_PREFIX;',
    'const mode: 0o644 = EXPORTED_FILE_MODE;',
    'const failure: ChallengeExportError = new ChallengeExportError(code, "message", { path: entry.path });',
    'const reported: string = failure.code;',
    'const hadResidue: boolean = failure.cleanup !== void 0;',
    'const summary: readonly (string | number | boolean | ExportedFileEntry)[] =',
    '  [reported, hadResidue, expected, hidden, mode, entries[0]!];',
    'void summary;',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'consumer.mts'), consumer, 'utf8');

  // The same six flags the accepted contract suite pins; nothing else is
  // requested, so no installation, project file or emitted output is involved.
  const flags = ['--noEmit', '--strict', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext'];
  const result = spawnSync(process.execPath, [PINNED_COMPILER, ...flags, 'consumer.mts'], { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `the pinned compiler reported:\n${output}`);

  // The declaration binds only when the program actually loads the shipped
  // .d.mts sibling, so the file list is the observable proof of that binding.
  const listed = spawnSync(process.execPath, [PINNED_COMPILER, ...flags, '--listFiles', 'consumer.mts'], { cwd: root, encoding: 'utf8' });
  const fileList = `${listed.stdout ?? ''}${listed.stderr ?? ''}`;
  assert.equal(listed.status, 0, `the pinned compiler could not list its program:\n${fileList}`);
  assert.match(fileList, /challenge-export\.d\.mts/, 'the shipped module declaration is part of the compiled program');
  assert.match(fileList, /identity\.d\.mts/, 'the accepted identity declaration is part of the compiled program');
});

test('a source mutation after publication is refused before success', async (t) => {
  const fixture = buildFixture(t, 'late-source-change');
  const output = publishTarget(fixture);
  const original = fs.promises.readdir;
  let changed = false;
  fs.promises.readdir = async (...args) => {
    if (!changed && path.resolve(String(args[0])) === output) {
      changed = true;
      fs.writeFileSync(path.join(fixture.sourceRoot, 'README.md'), 'late source mutation');
    }
    return original(...args);
  };
  t.after(() => { fs.promises.readdir = original; });
  const error = await rejection(exportTo(fixture, output));
  assert.ok(changed);
  assert.ok(error instanceof ChallengeExportError);
  assert.equal(error.code, EXPORT_ERROR_CODES.WORKLOAD_MISMATCH);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.readFileSync(path.join(fixture.sourceRoot, 'README.md'), 'utf8'), 'late source mutation');
});

test('a replaced destination root is never cleaned through its old ownership claim', async (t) => {
  const fixture = buildFixture(t, 'replaced-root');
  const output = publishTarget(fixture);
  const saved = path.join(fixture.outputParent, 'saved-owned-root');
  const original = fs.promises.readdir;
  let replaced = false;
  fs.promises.readdir = async (...args) => {
    if (!replaced && path.resolve(String(args[0])) === output) {
      replaced = true;
      fs.renameSync(output, saved);
      fs.mkdirSync(output);
      for (const name of fs.readdirSync(saved)) fs.cpSync(path.join(saved, name), path.join(output, name), { recursive: true });
      fs.writeFileSync(path.join(output, 'foreign.txt'), 'foreign root contents');
    }
    return original(...args);
  };
  t.after(() => { fs.promises.readdir = original; });
  const error = await rejection(exportTo(fixture, output));
  assert.ok(replaced);
  assert.ok(error instanceof ChallengeExportError);
  assert.ok(error.cleanup instanceof ChallengeExportError);
  assert.equal(fs.readFileSync(path.join(output, 'foreign.txt'), 'utf8'), 'foreign root contents');
  assert.deepEqual(fs.readdirSync(output).sort(), [...fs.readdirSync(saved), 'foreign.txt'].sort());
});

test('a partial write failure removes the exclusively created partial file', async (t) => {
  const fixture = buildFixture(t, 'partial-write');
  const output = publishTarget(fixture);
  const original = fs.promises.open;
  let injected = false;
  fs.promises.open = async (...args) => {
    const handle = await original(...args);
    if (!injected && args[0] === path.join(output, 'README.md') && typeof args[1] === 'number') {
      injected = true;
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async bytes => { await write(bytes.subarray(0, 3)); throw Object.assign(new Error('partial write'), { code: 'ENOSPC' }); };
    }
    return handle;
  };
  t.after(() => { fs.promises.open = original; });
  const error = await rejection(exportTo(fixture, output));
  assert.ok(injected);
  assert.ok(error instanceof ChallengeExportError);
  assert.equal(error.cleanup, undefined);
  assert.equal(fs.existsSync(output), false);
});
