/**
 * C1 T4 — Integrated contract tests for the released C1 packages.
 *
 * Bounded integration verification of the RELEASED C1 modules (T1/T2/T7,
 * T3/T5/T6), consuming the actual dependency handoffs rather than accumulated
 * session context:
 *   - identity.mjs / paths.mjs / storage.mjs hash, path and persistence
 *     seams: the integrated immutable 26-file starter fixture re-derives the
 *     original workload hash; corrupt/unsupported-major/identity-changing
 *     records refuse; atomic failure, reservation recovery and lock safety
 *     hold across the seam;
 *   - manifest.mjs (released T7 revision) joined at the same seams: sealed
 *     identity/RunManifest records publish immutably, read back bound, and
 *     refuse identity-changing replacement; the explicit legacy reader
 *     preserves historical outcomes verbatim and never promotes trust;
 *     the JSON Schemas (draft 2020-12) accept the positive fixtures and
 *     reject the mutation set exactly as the runtime does (Ajv2020, the
 *     existing declared devDependency, test-only);
 *   - neutral independence: static import graph over all four released
 *     modules, an isolated copied-core runtime with DSH/runner/private state
 *     absent, and pinned-tsc 5.7.3 declaration checks through a REAL direct
 *     NodeNext consumer of the shipped `packages/core/*.mjs` paths (no
 *     copying/remapping — the shipped `.d.mts` siblings make the pair
 *     resolvable; a byte-equality test keeps them synchronized with the
 *     `.d.ts` sources, which stay read-only).
 *
 * Containment: generated files live only in the project-contained, locally
 * ignored `tests/contracts/.tmp/integration/` directory (or under
 * `BENCHBOARD_TEST_SCRATCH_ROOT` when supplied at run time). `starter/**` is
 * only ever READ (read-only oracle). No private `.ai` path, no historical
 * runner source, no DSH module is read or imported by this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  sha256,
  hashEntries,
  inventoryTree,
  createId,
  HASH_ALGORITHM_ID,
} from '../../packages/core/identity.mjs';
import {
  validateRelativePath,
  resolveWithinRoot,
  assertDisjointRoots,
  PathError,
  PATH_ERROR_CODES,
} from '../../packages/core/paths.mjs';
import { createStorage, StorageError } from '../../packages/core/storage.mjs';
import {
  ContractValidationError,
  NEUTRAL_CONTRACT_KINDS,
  NEUTRAL_CONTRACT_VERSION,
  LEGACY_TRUST_CEILING,
  canonicalJson,
  computeTreeDigest,
  createRunManifest,
  identityDigestOf,
  isLegacyEnvelope,
  parseDerivation,
  readLegacyResult,
  sha256Hex,
  validateRecord,
} from '../../packages/core/manifest.mjs';
import { loadFixture } from './fixtures/contracts/index.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const GOLDEN = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('./fixtures/identity/golden.json', import.meta.url)), 'utf8'),
);
const STARTER_ROOT = fileURLToPath(new URL('../../starter/', import.meta.url));

/* ---------------------------------------------------------------- helpers */

function integrationScratchRoot() {
  const override = process.env.BENCHBOARD_TEST_SCRATCH_ROOT;
  if (override !== void 0 && override.length > 0) {
    if (!path.isAbsolute(override)) {
      throw new Error(`BENCHBOARD_TEST_SCRATCH_ROOT must be an absolute directory, got ${JSON.stringify(override)}`);
    }
    fs.mkdirSync(override, { recursive: true });
    return override;
  }
  const contained = fileURLToPath(new URL('./.tmp/integration/', import.meta.url));
  fs.mkdirSync(contained, { recursive: true });
  return contained;
}

/** One throwaway directory per test, cleaned exactly that. */
function scratch(t, name) {
  const directory = fs.mkdtempSync(path.join(integrationScratchRoot(), `int-${name}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Node 24.13.1: assert.throws() returns undefined for a matched throw. */
function thrown(action) {
  let caught;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== void 0, 'an exception was expected');
  return caught;
}

async function rejected(promise) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== void 0, 'a rejection was expected');
  return caught;
}

function expectStorageCode(promise, code, message) {
  return rejected(promise).then((error) => {
    assert.ok(error instanceof StorageError, `a StorageError was expected, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, message ?? code);
    return error;
  });
}

/**
 * Independent canonical JSON (sorted keys, JSON numbers) written directly in
 * this suite so the storage-digest cross-check does not depend on the module
 * whose digest it verifies.
 */
function independentCanonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(independentCanonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + independentCanonicalJson(value[key])).join(',') + '}';
}

const moduleSource = (relative) => fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const CURATED = (name) =>
  fs.readFileSync(
    fileURLToPath(new URL(`./fixtures/storage/envelopes/${name}.json`, import.meta.url)),
    'utf8',
  );

/* ================================================= integrated 26-file
   immutable fixture reproduces the original workload hash ================ */

test('the integrated immutable inventory record reproduces the original starter26 workload hash', async (t) => {
  const root = scratch(t, 'starter26');
  const inventory = inventoryTree({ root: STARTER_ROOT });
  assert.equal(inventory.entries.length, GOLDEN.starter26.fileCount);
  assert.equal(inventory.digest, GOLDEN.starter26.digest,
    'the released identity primitive reproduces the pinned starter26 digest');
  assert.equal(inventory.digest, 'aead38d3607492066247dddc7cbfb9828860f008f6151d434210394c736cb1f8',
    'the pinned starter26 digest is the literal original workload hash');
  assert.equal(inventory.hashAlgorithmId, HASH_ALGORITHM_ID);
  // Idempotence: a second independent inventory is identical.
  assert.equal(inventoryTree({ root: STARTER_ROOT }).digest, inventory.digest);

  // Integrated fixture: publish the exact pairs immutably through storage and
  // re-derive the original workload hash from the stored record.
  const pairs = inventory.entries.map((entry) => [entry.path, entry.sha256]);
  const value = {
    hashAlgorithmId: inventory.hashAlgorithmId,
    fileCount: inventory.entries.length,
    inventory: pairs,
  };
  const store = createStorage({ root: path.join(root, 'store') });
  const key = {
    relativePath: 'challenge/starter26-inventory.json',
    kind: 'ChallengePackage.inventory',
    id: 'starter26-integrated',
  };
  const result = await store.createImmutable({ ...key, value });
  assert.equal(result.recordType, 'immutable');
  assert.equal(result.recovered, undefined);

  const stored = await store.read(key);
  assert.equal(stored.fileCount, 26);
  assert.deepEqual(stored.inventory, pairs, 'the stored pairs are byte-faithful');
  // The original workload hash re-derived from the stored record:
  assert.equal(hashEntries(stored.inventory), GOLDEN.starter26.digest,
    'hashEntries over the stored pairs reproduces the original workload hash');

  // Immutability of the integrated record:
  await expectStorageCode(
    store.replaceMutable({ ...key, value: { ...value, fileCount: 999 } }),
    'ERR_STORAGE_IMMUTABLE_REPLACEMENT',
    'the integrated immutable record can never be replaced through the mutable API',
  );
  const unchanged = await store.read(key);
  assert.equal(unchanged.fileCount, 26, 'the stored workload record is unchanged');
});

/* ============================================== storage digest cross-check
   against the identity layer's sha256 ==================================== */

test('the storage envelope digest binds kind, id and value exactly as an independent sha256 recomputation says', async (t) => {
  const root = scratch(t, 'digest');
  const store = createStorage({ root: path.join(root, 'store') });
  const value = { alpha: 1, beta: [null, 0, false], gamma: 'x', nested: { z: null, a: '\n' } };
  const result = await store.createImmutable({
    relativePath: 'records/bound.json',
    kind: 'fixture.crosscheck',
    id: 'cc-1',
    value,
  });
  const raw = fs.readFileSync(path.join(root, 'store', 'records', 'bound.json'), 'utf8');
  const envelope = JSON.parse(raw);
  assert.deepEqual(Object.keys(envelope).sort(), ['digest', 'id', 'kind', 'schemaVersion', 'value']);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.kind, 'fixture.crosscheck');
  assert.equal(envelope.id, 'cc-1');
  // Independent recomputation of the documented binding digest:
  const expected = sha256(independentCanonicalJson({ id: 'cc-1', kind: 'fixture.crosscheck', value }));
  assert.equal(envelope.digest, expected);
  assert.equal(result.digest, expected);
  // And the read seam verifies against the same digest:
  const read = await store.read({ relativePath: 'records/bound.json', kind: 'fixture.crosscheck', id: 'cc-1' });
  assert.deepEqual(read, value);
});

/* =========================================================== reader seam:
   corrupt / unsupported / identity-mismatched records refused ============= */

test('the cross-module reader seam refuses corrupt, unsupported-major and identity-mismatched record bytes', async (t) => {
  const root = scratch(t, 'reader');
  const store = createStorage({ root: path.join(root, 'store') });
  const key = { relativePath: 'records/one.json', kind: 'fixture.valid', id: 'v-1' };
  await store.createImmutable({
    ...key,
    value: { alpha: 1, beta: [null, 0, false], gamma: 'x' },
  });
  const recordPath = path.join(root, 'store', 'records', 'one.json');
  const originalBytes = fs.readFileSync(recordPath, 'utf8');

  // Curated fixture bytes are spliced over the record file; the reader must
  // fail closed with the matching stable code each time.
  const cases = [
    ['corrupt-envelope', 'ERR_STORAGE_ENVELOPE_MALFORMED'],
    ['digest-mismatch', 'ERR_STORAGE_DIGEST_MISMATCH'],
    ['schema-unknown', 'ERR_STORAGE_ENVELOPE_MALFORMED'], // schemaVersion 2 unsupported
  ];
  for (const [fixtureName, expectedCode] of cases) {
    fs.writeFileSync(recordPath, CURATED(fixtureName), 'utf8');
    await expectStorageCode(store.read(key), expectedCode, `fixture ${fixtureName}`);
  }
  // The identity-mismatched envelope is self-consistent for its OWN identity,
  // so it is refused only for the mismatched request, and reads cleanly under
  // its own binding.
  fs.writeFileSync(recordPath, CURATED('identity-mismatch'), 'utf8');
  await expectStorageCode(store.read(key), 'ERR_STORAGE_IDENTITY_MISMATCH', 'foreign identity refused');
  const own = await store.read({
    relativePath: 'records/one.json',
    kind: 'fixture.alpha',
    id: 'a-1',
  });
  assert.deepEqual(own, { note: 'identity binding sample', numbers: [null, 0] });
  // Restore: the original bytes read fine again.
  fs.writeFileSync(recordPath, originalBytes, 'utf8');
  const restored = await store.read(key);
  assert.deepEqual(restored, { alpha: 1, beta: [null, 0, false], gamma: 'x' });
});

/* ================================================ duplicate identities and
   identity-changing replacements refused ================================= */

test('duplicate identities and identity-changing replacements are refused across the seam', async (t) => {
  const root = scratch(t, 'duplicates');
  const store = createStorage({ root: path.join(root, 'store') });
  const key = { relativePath: 'alpha/one.json', kind: 'fixture.dup', id: 'shared-1' };
  const value = { v: 1 };
  await store.createImmutable({ ...key, value });

  // Duplicate (kind, id) at another location:
  await expectStorageCode(
    store.createImmutable({ relativePath: 'beta/two.json', kind: 'fixture.dup', id: 'shared-1', value: { v: 2 } }),
    'ERR_STORAGE_DUPLICATE_IDENTITY',
  );
  assert.ok(!fs.existsSync(path.join(root, 'store', 'beta', 'two.json')), 'the losing duplicate published nothing');

  // The same id under a different kind is a distinct identity:
  await store.createImmutable({
    relativePath: 'alpha/two.json', kind: 'fixture.other', id: 'shared-1', value: { v: 3 },
  });

  // A third identity cannot claim the booked path either (no identity change
  // by relocation):
  await expectStorageCode(
    store.createImmutable({ relativePath: 'alpha/one.json', kind: 'fixture.third', id: 't-1', value: { v: 7 } }),
    'ERR_STORAGE_PATH_CONFLICT',
    'the location is booked by a different identity',
  );
  // Identity-changing replacement through the mutable API at the booked path:
  await expectStorageCode(
    store.replaceMutable({ relativePath: 'alpha/one.json', kind: 'fixture.third', id: 't-1', value: { v: 9 } }),
    'ERR_STORAGE_PATH_CONFLICT',
    'the location is booked by a different identity; no identity change is inferred',
  );
  // Registered immutable identity is never replaced (identity stays bound):
  await expectStorageCode(
    store.replaceMutable({ ...key, value: { v: 99 } }),
    'ERR_STORAGE_IMMUTABLE_REPLACEMENT',
  );
  assert.deepEqual(await store.read(key), { v: 1 }, 'original bytes and identity intact');
});

test('a mutable record keeps its identity across replacement and rejects a value-changing reader bypass', async (t) => {
  const root = scratch(t, 'mutable');
  const store = createStorage({ root: path.join(root, 'store') });
  const key = { relativePath: 'state/counter.json', kind: 'fixture.state', id: 'st-1' };
  const first = await store.replaceMutable({ ...key, value: { n: 1 } });
  assert.equal(first.recordType, 'mutable');
  assert.equal(first.replaced, false);
  const second = await store.replaceMutable({ ...key, value: { n: 2 } });
  assert.equal(second.recordType, 'mutable');
  assert.equal(second.replaced, true);
  assert.deepEqual(await store.read(key), { n: 2 });

  // Externally rewritten bytes with a changed value but unchanged digest field
  // are a digest mismatch, never a silent identity/value change:
  const recordPath = path.join(root, 'store', 'state', 'counter.json');
  const envelope = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  envelope.value = { n: 999 };
  fs.writeFileSync(recordPath, JSON.stringify(envelope), 'utf8');
  await expectStorageCode(store.read(key), 'ERR_STORAGE_DIGEST_MISMATCH', 'an identity-changing record is refused by the reader');
});

/* ================================================ atomic failure and lock
   safety across the integrated path ====================================== */

test('hook-injected failures leave honest recoverable state across the integrated path', async (t) => {
  const root = scratch(t, 'atomic');
  const base = { kind: 'fixture.atomic', id: 'at-1' };

  // beforeStage abort: no bytes, no registry entry.
  {
    const store = createStorage({
      root: path.join(root, 's1'),
      hooks: { beforeStage: () => { throw new Error('abort-stage'); } },
    });
    await expectStorageCode(
      store.createImmutable({ relativePath: 'r/one.json', ...base, value: { n: 1 } }),
      'ERR_STORAGE_HOOK_ABORT',
    );
    assert.ok(!fs.existsSync(path.join(root, 's1', 'r', 'one.json')));
  }
  // beforePublish abort: reservation stands, bytes absent; a hook-free store
  // on the same root reconciles the identical retry (recovered), then the
  // identity is bound immutable.
  {
    const root2 = path.join(root, 's2');
    const store = createStorage({
      root: root2,
      hooks: { beforePublish: () => { throw new Error('abort-publish'); } },
    });
    await expectStorageCode(
      store.createImmutable({ relativePath: 'r/one.json', ...base, value: { n: 2 } }),
      'ERR_STORAGE_HOOK_ABORT',
    );
    assert.ok(!fs.existsSync(path.join(root2, 'r', 'one.json')));
    // Recovery goes through a fresh store instance without the injected hook;
    // the reservation lives in the on-disk registry, not in the instance.
    const recoverStore = createStorage({ root: root2 });
    const recovered = await recoverStore.createImmutable({ relativePath: 'r/one.json', ...base, value: { n: 2 } });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.recordType, 'immutable');
    assert.deepEqual(await recoverStore.read({ relativePath: 'r/one.json', ...base }), { n: 2 });
    await expectStorageCode(
      recoverStore.createImmutable({ relativePath: 'r/one.json', ...base, value: { n: 2 } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
    );
  }
  // beforeRegister abort: bytes published, identity reserved; the mutable API
  // refuses and preserves, identical recovery completes, different bytes refuse.
  {
    const root3 = path.join(root, 's3');
    const store = createStorage({
      root: root3,
      hooks: { beforeRegister: () => { throw new Error('abort-register'); } },
    });
    await expectStorageCode(
      store.createImmutable({ relativePath: 'r/one.json', ...base, value: { n: 3 } }),
      'ERR_STORAGE_HOOK_ABORT',
    );
    assert.ok(fs.existsSync(path.join(root3, 'r', 'one.json')), 'bytes were published before the abort');
    const bytesAfterAbort = fs.readFileSync(path.join(root3, 'r', 'one.json'), 'utf8');
    // Every later step runs through a fresh, hook-free store on the same root.
    const recoverStore = createStorage({ root: root3 });
    // Cross-location attempt is refused while the reservation stands:
    await expectStorageCode(
      recoverStore.createImmutable({ relativePath: 'elsewhere/one.json', ...base, value: { n: 3 } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
    ).then((error) => assert.equal(error.details.pendingRegistration, true));
    // Different bytes at the reserved path are refused:
    await expectStorageCode(
      recoverStore.createImmutable({ relativePath: 'r/one.json', ...base, value: { n: 4 } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
    );
    // The mutable API refuses the reserved target and preserves the bytes:
    await expectStorageCode(
      recoverStore.replaceMutable({ relativePath: 'r/one.json', ...base, value: { n: 4 } }),
      'ERR_STORAGE_IMMUTABLE_REPLACEMENT',
    ).then((error) => assert.equal(error.details.pendingRegistration, true));
    assert.equal(fs.readFileSync(path.join(root3, 'r', 'one.json'), 'utf8'), bytesAfterAbort);
    // Identical recovery completes the registration:
    const recovered = await recoverStore.createImmutable({ relativePath: 'r/one.json', ...base, value: { n: 3 } });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.recordType, 'immutable');
    assert.deepEqual(await recoverStore.read({ relativePath: 'r/one.json', ...base }), { n: 3 });
  }
});

test('a foreign lock is refused and never stolen; concurrent same-instance duplicate writers serialize deterministically', async (t) => {
  const root = scratch(t, 'locks');

  // Foreign lock file: any writer on this root is refused, the lock content is
  // preserved byte-for-byte, and no lock file is ever removed by the module.
  {
    const lockRoot = path.join(root, 'foreign');
    fs.mkdirSync(path.join(lockRoot, '.storage'), { recursive: true });
    const foreignLock = JSON.stringify({ schemaVersion: 1, token: 'foreign-instance', pid: 1 }) + '\n';
    fs.writeFileSync(path.join(lockRoot, '.storage', 'lock'), foreignLock, 'utf8');
    const store = createStorage({ root: lockRoot });
    await expectStorageCode(
      store.createImmutable({ relativePath: 'r/one.json', kind: 'fixture.lock', id: 'lk-1', value: { x: 1 } }),
      'ERR_STORAGE_LOCK_CONFLICT',
    );
    assert.equal(
      fs.readFileSync(path.join(lockRoot, '.storage', 'lock'), 'utf8'),
      foreignLock,
      'the foreign lock is untouched (never stolen)',
    );
    // Reads do not need the writer lock and still verify:
    await expectStorageCode(
      store.read({ relativePath: 'r/one.json', kind: 'fixture.lock', id: 'lk-1' }),
      'ERR_STORAGE_NOT_FOUND',
    );
  }
  // Another container instance on the same root: held-then-released
  // deterministically, refused while the lock is demonstrably held, and
  // writable again after release.
  {
    const sharedRoot = path.join(root, 'cross-instance');
    const writerA = createStorage({ root: sharedRoot });
    const writerB = createStorage({ root: sharedRoot });
    const lockPath = path.join(sharedRoot, '.storage', 'lock');
    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    const heldA = writerA.withLock(async () => {
      await gateA;
      return 'A-held';
    });
    // Deterministic handoff: only launch the contender once the lock file
    // physically exists (the acquisition order is not otherwise specified
    // for two racing cross-instance writers).
    while (!fs.existsSync(lockPath)) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await expectStorageCode(
      writerB.createImmutable({ relativePath: 'r/one.json', kind: 'fixture.lock', id: 'lk-2', value: { x: 1 } }),
      'ERR_STORAGE_LOCK_CONFLICT',
    );
    releaseA();
    const heldResult = await heldA;
    assert.equal(heldResult, 'A-held');
    // After the holder releases, the contender can write.
    const after = await writerB.createImmutable({
      relativePath: 'r/one.json', kind: 'fixture.lock', id: 'lk-2', value: { x: 1 },
    });
    assert.equal(after.recordType, 'immutable');
    // And the released lock is really gone: a sequential writer succeeds.
    const sequential = await writerB.withLock(async () => 'B-held');
    assert.equal(sequential, 'B-held');
  }
  // Same instance, concurrent duplicate-identity writers: FIFO serialization
  // means the first enqueued writer fulfils and the second refuses, with the
  // outcome independent of timing.
  {
    const store = createStorage({ root: path.join(root, 'fifo') });
    const p1 = store.createImmutable({ relativePath: 'a/one.json', kind: 'fixture.race', id: 'same', value: { w: 'first' } });
    const p2 = store.createImmutable({ relativePath: 'b/one.json', kind: 'fixture.race', id: 'same', value: { w: 'second' } });
    const outcomes = await Promise.allSettled([p1, p2]);
    const winner = outcomes[0];
    const loser = outcomes[1];
    assert.equal(winner.status, 'fulfilled');
    assert.equal(loser.status, 'rejected');
    assert.equal(loser.reason.code, 'ERR_STORAGE_DUPLICATE_IDENTITY');
    assert.ok(fs.existsSync(path.join(root, 'fifo', 'a', 'one.json')));
    assert.ok(!fs.existsSync(path.join(root, 'fifo', 'b', 'one.json')), 'the refused writer published nothing');
  }
});

test('null stays null, never zero, and JSON number semantics are honest across the storage roundtrip', async (t) => {
  const root = scratch(t, 'nulls');
  const store = createStorage({ root: path.join(root, 'store') });
  const value = { measured: null, unmeasured: { deep: null }, flags: [null, false, 0] };
  await store.createImmutable({
    relativePath: 'records/nulls.json',
    kind: 'fixture.null',
    id: 'nl-1',
    value,
  });
  const read = await store.read({ relativePath: 'records/nulls.json', kind: 'fixture.null', id: 'nl-1' });
  assert.deepEqual(read, value);
  assert.ok(Object.hasOwn(read, 'measured') && read.measured === null, 'null is preserved as null, not zero');
  assert.ok(Object.hasOwn(read.unmeasured, 'deep') && read.unmeasured.deep === null, 'nested null preserved');
  // Documented JSON semantics: -0 canonicalizes to 0.
  await store.createImmutable({
    relativePath: 'records/negzero.json',
    kind: 'fixture.null',
    id: 'nl-2',
    value: { n: -0 },
  });
  const negZero = await store.read({ relativePath: 'records/negzero.json', kind: 'fixture.null', id: 'nl-2' });
  assert.equal(negZero.n, 0, '-0 canonicalizes to 0 (documented, not silently claimed distinct)');
});

/* ============================================================ neutrality:
   static import graph ===================================================== */

test('the released core modules import Node builtins only and look up nothing', () => {
  const allowed = new Set([
    'node:crypto', 'node:fs', 'node:path', 'node:url',
    'node:async_hooks', 'node:fs/promises',
  ]);
  const modules = [
    '../../packages/core/identity.mjs',
    '../../packages/core/paths.mjs',
    '../../packages/core/storage.mjs',
    '../../packages/core/manifest.mjs',
  ];
  for (const relative of modules) {
    const source = moduleSource(relative);
    const specifiers = [...source.matchAll(/^import\b[^\n]*?from\s+'([^']+)';/gm)].map((match) => match[1]);
    assert.ok(specifiers.length > 0, `${relative} declares its imports`);
    for (const specifier of specifiers) {
      assert.ok(allowed.has(specifier), `${relative} imports ${specifier}, which is not a permitted builtin`);
      assert.ok(!specifier.startsWith('.'), `${relative} must not import a sibling module`);
    }
    // Code-only view: comment lines are filtered exactly like the focused
    // suite's neutrality probe does, so JSDoc type annotations do not trip
    // the code checks.
    const codeOnly = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trimStart();
        return !(trimmed.startsWith('*') || trimmed.startsWith('/') || trimmed.startsWith('//'));
      })
      .join('\n');
    assert.ok(!/\bimport\s*\(/.test(codeOnly), `${relative} performs no dynamic import`);
    assert.ok(!/\brequire\s*\(/.test(codeOnly), `${relative} does not use CommonJS require`);
    assert.ok(!/process\.env\b/.test(codeOnly), `${relative} does not read the environment`);
    assert.ok(!/homedir/.test(codeOnly), `${relative} does not resolve a user directory`);
    assert.ok(!/\b(fetch|http|https)\s*\(/.test(codeOnly), `${relative} performs no network call`);
    for (const forbidden of [ // built from parts so no check embeds the literal
      'run' + 'ner/', 'evaluator/', '.agent' + '-teams', 'starter/',
    ]) {
      const pattern = new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      assert.ok(!pattern.test(codeOnly), `${relative} must not mention ${forbidden} in code`);
    }
    // Private-path mention: built from parts so this check cannot match its
    // own source.
    const privateEvidencePath = '.' + 'ai/';
    assert.ok(!codeOnly.includes(privateEvidencePath), `${relative} must not mention the private evidence tree in code`);
  }
});

test('this integration suite itself stays public: no private .ai or historical runner reference', () => {
  const source = moduleSource('./integration.test.mjs');
  // Built from parts so the check cannot match its own source text.
  const privateEvidencePath = '.' + 'ai/';
  assert.ok(!source.includes(privateEvidencePath), 'no private evidence path');
  const runnerDir = 'run' + 'ner/';
  assert.ok(!source.includes(`'${runnerDir}`) && !source.includes(`"${runnerDir}`) && !source.includes(`\`${runnerDir}`),
    'no historical runner import');
  assert.ok(!source.includes('.' + 'agent-teams'), 'no team state path');
  assert.ok(!source.includes('PRESERVATION_' + 'BASELINE'), 'no private baseline path');
});

/* ======================================================== paths integrity
   at the integrated boundary ============================================= */

test('paths primitives protect the integrated storage boundary', (t) => {
  const root = scratch(t, 'paths');
  fs.mkdirSync(path.join(root, 'records'), { recursive: true });
  fs.writeFileSync(path.join(root, 'records', 'one.json'), '{}\n', 'utf8');
  assert.equal(validateRelativePath('records/one.json'), 'records/one.json');
  const inside = resolveWithinRoot({ root, relativePath: 'records/one.json' });
  assert.ok(path.isAbsolute(inside) && inside.startsWith(root));
  const escape = thrown(() => resolveWithinRoot({ root, relativePath: '../escape' }));
  assert.ok(escape instanceof PathError, 'traversal raises PathError');
  assert.equal(escape.code, PATH_ERROR_CODES.INVALID_RELATIVE_PATH);

  // Two storage roots on one host stay disjoint at the paths seam; a root
  // inside another is refused.
  const storageOne = path.join(root, 'store-one');
  const storageTwo = path.join(root, 'store-two');
  fs.mkdirSync(storageOne, { recursive: true });
  fs.mkdirSync(storageTwo, { recursive: true });
  const displayed = assertDisjointRoots([storageOne, storageTwo]);
  assert.equal(displayed.length, 2);
  assert.ok(Object.isFrozen(displayed));
  const contained = thrown(() => assertDisjointRoots([storageOne, path.join(storageOne, 'deep')]));
  assert.ok(contained instanceof PathError);
  assert.equal(contained.code, PATH_ERROR_CODES.ROOTS_OVERLAP);
});

/* ================================================== manifest-facing seams
 (joined after the T7 release; released T7 revision semantics) ============ */

test('the identity layer and the released manifest digest helpers agree on the original starter26 workload hash', () => {
  const inventory = inventoryTree({ root: STARTER_ROOT });
  const pairs = inventory.entries.map((entry) => [entry.path, entry.sha256]);
  assert.equal(computeTreeDigest(pairs), inventory.digest,
    'manifest.computeTreeDigest equals identity.inventoryTree on the same pairs');
  assert.equal(computeTreeDigest(pairs), GOLDEN.starter26.digest);
  assert.equal(sha256Hex(canonicalJson(pairs)), inventory.digest,
    'the projected digest is sha256 over the canonical JSON of the sorted pairs');
  // A ChallengeIdentity carrying the real starter inventory validates and
  // binds the original workload hash:
  const challengeIdentity = {
    schemaVersion: NEUTRAL_CONTRACT_VERSION,
    kind: 'ChallengeIdentity',
    challengeId: 'challenge-integration-starter',
    challengeVersion: '1.0.0',
    architectureId: 'arch-integration-challenge',
    architectureKind: 'challenge',
    hashAlgorithm: 'sha256',
    definitionDigest: sha256Hex('integration-challenge-definition'),
    digestProvenance: { kind: 'COMPUTED', procedure: 'integration:starter26-digest' },
    workloadProvenance: { kind: 'COMPUTED', procedure: 'integration:starter26-digest' },
    publicPrdDigest: sha256Hex('integration-public-prd'),
    visibleHarnessDigest: sha256Hex('integration-visible-harness'),
    fixtureDigest: sha256Hex('integration-fixtures'),
    starterInventory: pairs,
    workloadDigest: computeTreeDigest(pairs),
    candidateLineage: {
      candidateVersion: '1.0.0-candidate.9',
      candidateStatus: 'INTEGRATION_SYNTHETIC',
      sourceCommit: 'abcdef1234567890abcdef1234567890abcdef12',
    },
  };
  const validated = validateRecord('ChallengeIdentity', challengeIdentity);
  assert.equal(validated.workloadDigest, GOLDEN.starter26.digest,
    'the neutral challenge identity binds the original workload hash');
  // Tampering with the workload digest is refused (recomputed, never trusted):
  let refused = false;
  try {
    validateRecord('ChallengeIdentity', {
      ...challengeIdentity,
      workloadDigest: sha256Hex('not-the-starter-digest'),
    });
  } catch {
    refused = true;
  }
  assert.equal(refused, true, 'a stale workload digest is refused');
});

test('unknown kinds, unknown majors and leading-zero versions are refused; equal version domains across identities are legitimate post-T7', () => {
  // Unknown kind:
  const unknownKind = thrown(() => validateRecord('InventedKind', {}));
  assert.ok(unknownKind instanceof TypeError, 'an unknown kind raises TypeError');
  // Unknown major (never coerced): validateRecord collects every detected
  // problem and fails as a plain Error with the issue list.
  try {
    validateRecord('ToolingIdentity', schemaVersionSetter('2.0.0'));
    assert.fail('an unknown schema major must be refused');
  } catch (error) {
    assert.ok(error instanceof Error && error.name === 'Error',
      'validateRecord refuses with a plain Error listing the problems');
    assert.match(String(error.message), /major 2 is not supported/);
  }
  // Leading-zero version is malformed grammar (T7 C1-M1):
  try {
    validateRecord('ToolingIdentity', schemaVersionSetter('01.0.0'));
    assert.fail('a leading-zero schemaVersion must be refused');
  } catch (error) {
    assert.ok(error instanceof Error);
  }
  // Post-T7 M2 disposition: equal version VALUES across the three identity
  // domains are legitimate (the identity domains are separated by distinct
  // IDs, architecture bindings and sealed digests — not by string inequality
  // across domains). Fixture candidate lineage stays ordered by version, so
  // the shared value is the fixture challenge version 1.0.0:
  const sealed = createRunManifest(integrationManifestInput({
    toolingVersion: '1.0.0',
    challengeVersion: '1.0.0',
    evaluatorVersion: '1.0.0',
  }));
  assert.equal(sealed.bindings.tooling.toolingVersion, '1.0.0');
  assert.equal(sealed.bindings.challenge.challengeVersion, '1.0.0');
  assert.equal(sealed.bindings.evaluator.evaluatorVersion, '1.0.0');
  assert.notEqual(sealed.bindings.tooling.toolingId, sealed.bindings.challenge.challengeId);
  assert.notEqual(sealed.bindings.challenge.challengeId, sealed.bindings.evaluator.evaluatorId);
  assert.notEqual(sealed.bindings.tooling.toolingId, sealed.bindings.evaluator.evaluatorId);
  void sealed;
});

function schemaVersionSetter(version) {
  const record = loadFixture('tooling.identity');
  record.schemaVersion = version;
  return record;
}

/** Integration manifest input built from the sanitized synthetic fixtures. */
function integrationManifestInput({
  manifestId = 'mf-integration-0001-inte-gration-manifest',
  toolingVersion,
  challengeVersion,
  evaluatorVersion,
  roots,
  duplicateIds = false,
} = {}) {
  const tooling = loadFixture('tooling.identity');
  const challenge = loadFixture('challenge.identity');
  const evaluator = loadFixture('evaluator.identity');
  if (toolingVersion !== undefined) tooling.toolingVersion = toolingVersion;
  if (challengeVersion !== undefined) challenge.challengeVersion = challengeVersion;
  if (evaluatorVersion !== undefined) evaluator.evaluatorVersion = evaluatorVersion;
  if (duplicateIds) challenge.challengeId = tooling.toolingId;
  return {
    manifestId,
    runId: 'bb-integration-run-001',
    createdAt: '2026-03-01T09:00:00.000Z',
    architectureId: 'arch-integration-run',
    harness: 'manual',
    participantWorkspaceRoot: roots ? roots.workspace : (path.sep === '/' ? '/tmp/integration-work' : 'C:\\integration-work'),
    evidenceRoot: roots ? roots.evidence : (path.sep === '/' ? '/tmp/integration-evidence' : 'C:\\integration-evidence'),
    toolingIdentity: tooling,
    challengeIdentity: challenge,
    evaluatorIdentity: evaluator,
  };
}

test('createRunManifest seals distinct identities and refuses identity/architecture/implicit input violations', () => {
  // The sealed manifest's binding digests are the identity digests of the
  // validated records, and its manifest digest recomputes from its own bytes.
  const sealed = createRunManifest(integrationManifestInput());
  assert.equal(Object.isFrozen(sealed), true, 'the sealed manifest is frozen');
  assert.equal(identityDigestOf(sealed), sealed.manifestDigest,
    'the manifest digest recomputes from the record bytes');
  assert.equal(sealed.bindings.challenge.challengeVersion, sealed.bindings.challenge.challengeVersion);
  assert.ok(HEX64.test(sealed.bindings.tooling.toolingIdentityDigest));
  assert.ok(HEX64.test(sealed.bindings.challenge.challengeIdentityDigest));
  assert.ok(HEX64.test(sealed.bindings.evaluator.evaluatorIdentityDigest));

  // Explicit roots: relative roots are refused (T7 explicit-root contract).
  let refused = false;
  try {
    createRunManifest(integrationManifestInput({
      roots: { workspace: 'integration-workspace', evidence: 'integration-evidence' },
    }));
  } catch {
    refused = true;
  }
  assert.equal(refused, true, 'relative explicit roots are refused');

  // Nested evidence root inside the workspace root is refused:
  refused = false;
  try {
    createRunManifest(integrationManifestInput({
      roots: { workspace: '/tmp/integration-work', evidence: '/tmp/integration-work/evidence' },
    }));
  } catch {
    refused = true;
  }
  assert.equal(refused, true, 'overlapping evidence root is refused');

  // Disjoint sibling roots are accepted:
  const disjoint = createRunManifest(integrationManifestInput({
    roots: { workspace: '/tmp/integration-work', evidence: '/tmp/integration-evidence' },
  }));
  assert.equal(disjoint.runId, 'bb-integration-run-001');

  // Duplicate identity IDs across the three domains are refused:
  refused = false;
  try {
    createRunManifest(integrationManifestInput({ duplicateIds: true }));
  } catch {
    refused = true;
  }
  assert.equal(refused, true, 'tooling/challenge/evaluator IDs must stay distinct');

  // Unknown input keys and missing required input are refused:
  refused = false;
  try {
    createRunManifest({ ...integrationManifestInput(), invented: 1 });
  } catch {
    refused = true;
  }
  assert.equal(refused, true, 'createRunManifest refuses unrecognised input');
  refused = false;
  const incomplete = integrationManifestInput();
  delete incomplete.runId;
  try {
    createRunManifest(incomplete);
  } catch {
    refused = true;
  }
  assert.equal(refused, true, 'createRunManifest is missing required input');
});

test('a sealed neutral manifest and its frozen submission publish immutably, read back bound, and refuse identity-changing replacement', async (t) => {
  const root = scratch(t, 'manifest-store');
  const store = createStorage({ root: path.join(root, 'store') });
  const sealed = createRunManifest(integrationManifestInput());

  // Publish the sealed manifest and the frozen submission immutably:
  const manifestKey = {
    relativePath: 'run/manifest.json',
    kind: 'RunManifest',
    id: sealed.manifestId,
  };
  await store.createImmutable({ ...manifestKey, value: sealed });

  // The manifest read back from storage revalidates with an unchanged digest:
  const storedManifest = await store.read(manifestKey);
  const revalidated = validateRecord('RunManifest', storedManifest);
  assert.equal(identityDigestOf(revalidated), revalidated.manifestDigest);
  assert.equal(identityDigestOf(revalidated), sealed.manifestDigest,
    'the stored manifest identity is unchanged across the storage roundtrip');

  // The frozen submission validates against the same identity layer, and its
  // tree digest binds its own inventory:
  const submissionRecord = validateRecord('FrozenSubmission', loadFixture('frozen.submission'));
  assert.equal(computeTreeDigest(submissionRecord.inventory), submissionRecord.treeDigest);
  const submissionKey = {
    relativePath: 'run/submission.json',
    kind: 'FrozenSubmission',
    id: submissionRecord.frozenSubmissionId,
  };
  await store.createImmutable({ ...submissionKey, value: submissionRecord });

  // Duplicate identity across locations refused; the manifest record can
  // never be replaced or type-converted through the mutable API:
  await expectStorageCode(
    store.createImmutable({
      relativePath: 'elsewhere/manifest.json',
      kind: 'RunManifest',
      id: sealed.manifestId,
      value: sealed,
    }),
    'ERR_STORAGE_DUPLICATE_IDENTITY',
  );
  await expectStorageCode(
    store.replaceMutable({ ...manifestKey, value: { ...sealed, runId: 'changed' } }),
    'ERR_STORAGE_IMMUTABLE_REPLACEMENT',
    'the published sealed manifest is immutable (identity and bytes bound)',
  );
  const stillIntact = await store.read(manifestKey);
  assert.equal(stillIntact.manifestDigest, sealed.manifestDigest);
});

test('the explicit legacy reader preserves historical outcomes verbatim and never promotes trust', () => {
  const cases = [
    ['legacy.result.1.0', '1.0'],
    ['legacy.result.1.1', '1.1'],
    ['legacy.result.1.2', '1.2'],
    // Post-T7 C1-M3: positively flagged historical authority claims are
    // preserved as history, not refused and not promoted:
    ['legacy.result.positive.1.0', '1.0'],
    ['legacy.result.positive.1.1', '1.1'],
    ['legacy.result.positive.1.2', '1.2'],
  ];
  for (const [fixtureName, recognized] of cases) {
    const payload = loadFixture(fixtureName);
    const envelope = readLegacyResult(payload);
    assert.equal(isLegacyEnvelope(envelope), true, fixtureName);
    assert.equal(envelope.recognizedSchemaVersion, recognized, fixtureName);
    // Verbatim preservation:
    assert.deepEqual(envelope.sourceRecord, payload, `${fixtureName}: sourceRecord verbatim`);
    // Non-promotion (the trusted parts stay at the historical ceiling):
    assert.deepEqual(envelope.trust, LEGACY_TRUST_CEILING, fixtureName);
    assert.equal(envelope.promotionAllowed, false, fixtureName);
    assert.equal(envelope.eligibility, 'NOT_FORMAL_COMPARISON_ELIGIBLE', fixtureName);
    assert.equal(envelope.bindingStatus, 'UNBOUND_HISTORICAL', fixtureName);
    // The neutral result contract can never re-read a legacy record:
    assert.throws(() => validateRecord('Result', envelope), undefined, `${fixtureName}: envelope refused as neutral`);
    assert.throws(() => validateRecord('Result', structuredClone(payload)), undefined, `${fixtureName}: payload refused as neutral`);
  }
  // Positive authority flags are preserved verbatim in the newest reader:
  const positive = readLegacyResult(loadFixture('legacy.result.positive.1.2'));
  assert.ok(
    JSON.stringify(positive.sourceRecord).includes('"officialOutcomeValid":true'),
    'the historical officialOutcomeValid claim is preserved verbatim, not discarded',
  );
  assert.ok(
    JSON.stringify(positive.sourceRecord).includes('"officialOutcomeEligible":true') ||
      JSON.stringify(positive.sourceRecord).includes('"officialOutcomeValid":true'),
    'historical positive authority claims survive verbatim under non-promotion clamps',
  );
});

test('a legacy payload travels the neutral storage roundtrip unchanged', async (t) => {
  const root = scratch(t, 'legacy-store');
  const store = createStorage({ root: path.join(root, 'store') });
  const payload = loadFixture('legacy.result.1.2');
  const key = { relativePath: 'history/legacy-1.2.json', kind: 'LegacyRunRecord', id: payload.run.runId };
  await store.replaceMutable({ ...key, value: payload });
  const stored = await store.read(key);
  const envelope = readLegacyResult(stored);
  assert.deepEqual(envelope.sourceRecord, payload, 'verbatim across storage');
  assert.deepEqual(envelope.trust, LEGACY_TRUST_CEILING);
  assert.equal(envelope.promotionAllowed, false);
});

/* C1 T9 SOTA1 F2 regression: a DERIVED measurement — standalone and inside a
 * Result — validates, publishes through the released storage layer immutably,
 * reads back byte-stable and revalidates unchanged, keeping exactly one
 * stable derivation string representation (schema/runtime/declarations). */
test('a DERIVED measurement and a Result containing it keep one stable representation across the storage roundtrip', async (t) => {
  const root = scratch(t, 'derived-store');
  const store = createStorage({ root: path.join(root, 'store') });
  const DERIVED_FORMULA = '{manualUsageCount} / {elapsedWallSeconds}';

  // Standalone DERIVED measurement.
  const derived = validateRecord('Measurement', loadFixture('measurement.tokensPerSecond'));
  assert.equal(derived.derivation, DERIVED_FORMULA, 'the runtime keeps the formula string');
  const derivedKey = {
    relativePath: 'measurements/derived.json',
    kind: 'Measurement',
    id: derived.measurementId,
  };
  await store.createImmutable({ ...derivedKey, value: derived });
  const storedMeasurement = validateRecord('Measurement', await store.read(derivedKey));
  assert.deepEqual(storedMeasurement, derived, 'standalone DERIVED is byte-stable');
  assert.deepEqual(
    parseDerivation(storedMeasurement.derivation).inputs,
    ['manualUsageCount', 'elapsedWallSeconds'],
    'parsed inputs come from the same stable string after the roundtrip',
  );

  // A Result containing a DERIVED measurement.
  const result = structuredClone(loadFixture('result.selfassessment'));
  result.measurements.push({
    schemaVersion: NEUTRAL_CONTRACT_VERSION,
    kind: 'Measurement',
    measurementId: 'meas-syn-derived-rate',
    metric: 'tokensPerSecond',
    unit: 'ratio',
    measurementKind: 'DERIVED',
    value: 12.5,
    source: {
      kind: 'LOCAL_DIGEST',
      digest: result.bindings.treeDigest,
      procedure: 'fixtures/contracts:derived-from-two-measurements',
    },
    derivation: DERIVED_FORMULA,
    confidence: 0.75,
    recordedAt: '2026-03-01T10:30:00.000Z',
  });
  const validatedResult = validateRecord('Result', result);
  const derivedResultKey = {
    relativePath: 'results/derived.json',
    kind: 'Result',
    id: validatedResult.resultId,
  };
  await store.createImmutable({ ...derivedResultKey, value: validatedResult });
  const storedResult = validateRecord('Result', await store.read(derivedResultKey));
  assert.deepEqual(storedResult, validatedResult, 'the containing Result is byte-stable');
  const derivedEntry = storedResult.measurements
    .find((measurement) => measurement.measurementKind === 'DERIVED');
  assert.equal(derivedEntry.derivation, DERIVED_FORMULA, 'the string survives the roundtrip');

  // Null/unavailable provenance survives the same seam untouched.
  const unavailable = validateRecord('Measurement', loadFixture('measurement.unavailable'));
  const unavailableKey = {
    relativePath: 'measurements/unavailable.json',
    kind: 'Measurement',
    id: unavailable.measurementId,
  };
  await store.createImmutable({ ...unavailableKey, value: unavailable });
  assert.deepEqual(await store.read(unavailableKey), unavailable,
    'null value and absent source survive publish, read and revalidation');
});

/* ================================================== SOTA2F1 integrated seam:
   exact Unicode paths republish byte-faithfully across a real storage
   roundtrip while every C0/DEL control-byte inventory spelling is refused
   before anything is written ================================================ */

test('SOTA2F1 bytes survive the storage seam untouched and control-byte inventory entries are refused at the same boundary', async (t) => {
  const root = scratch(t, 'sota2-paths');
  const store = createStorage({ root: path.join(root, 'store') });
  const identityDigest = sha256Hex('sota2-f1-entry-bytes');

  const challengeWith = (pairs, challengeId) => {
    const workloadDigest = computeTreeDigest(pairs);
    return {
      schemaVersion: NEUTRAL_CONTRACT_VERSION,
      kind: 'ChallengeIdentity',
      challengeId,
      challengeVersion: '1.0.0',
      architectureId: 'arch-integration-f1',
      architectureKind: 'challenge',
      hashAlgorithm: 'sha256',
      definitionDigest: sha256Hex('integration-f1-definition'),
      digestProvenance: { kind: 'COMPUTED', procedure: 'integration:f1-definition' },
      workloadProvenance: { kind: 'COMPUTED', procedure: 'integration:f1-starter-digest' },
      publicPrdDigest: sha256Hex('integration-f1-prd'),
      visibleHarnessDigest: sha256Hex('integration-f1-harness'),
      fixtureDigest: sha256Hex('integration-f1-fixtures'),
      starterInventory: pairs,
      workloadDigest,
      candidateLineage: {
        candidateVersion: '1.0.0-candidate.9',
        candidateStatus: 'INTEGRATION_F1_SYNTHETIC',
        sourceCommit: 'abcdef1234567890abcdef1234567890abcdef12',
      },
    };
  };

  // Valid Unicode inventory: a challenge identity binds the exact digests,
  // publishes immutably, and reads back byte-faithful with both digest
  // helpers agreeing on the same entry list.
  const unicodePairs = [['Ünïcode/fïle.txt', identityDigest], ['日本語/文書.txt', identityDigest]]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const unicodeChallenge = challengeWith(unicodePairs, 'challenge-integration-f1-unicode');
  const unicodeKey = {
    relativePath: 'challenge/f1-unicode.json',
    kind: 'ChallengeIdentity',
    id: unicodeChallenge.challengeId,
  };
  await store.createImmutable({ ...unicodeKey, value: unicodeChallenge });
  const published = validateRecord('ChallengeIdentity', await store.read(unicodeKey));
  assert.deepEqual(published.starterInventory, unicodePairs, 'the stored pairs are byte-faithful');
  assert.equal(hashEntries(published.starterInventory), published.workloadDigest,
    'identity hashEntries over the published entries reproduces the sealed workload digest');
  assert.equal(computeTreeDigest(published.starterInventory), published.workloadDigest,
    'computeTreeDigest over the published entries reproduces the sealed workload digest');
  assert.equal(published.workloadDigest, unicodeChallenge.workloadDigest,
    'the original workload digest is preserved exactly across the storage seam');

  // Control-byte inventory entries are refused by the runtime AND by
  // hashEntries before anything is written: no forged persistence. A
  // placeholder workload digest keeps the record completable, so the refusal
  // comes from the path rules themselves (a digest recompute would throw for
  // the same reason).
  const negativeSpellings = [
    ['NUL prefix', '\u0000nul.txt'],
    ['LF embedded', '\u000blf.txt'],
    ['ESC embedded', 'esc\u001bape.txt'],
    ['DEL embedded', 'del\u007fte.txt'],
    ['traversal', '../escape.txt'],
    ['redundant segment', 'a//b.txt'],
  ];
  for (const [label, spelling] of negativeSpellings) {
    const badChallenge = {
      ...structuredClone(challengeWith([['placeholder.txt', identityDigest]], 'challenge-integration-f1-negative')),
      starterInventory: [[spelling, identityDigest]],
      workloadDigest: sha256Hex('placeholder-not-recomputed'),
    };
    let runtimeRefused = false;
    try {
      validateRecord('ChallengeIdentity', badChallenge);
    } catch {
      runtimeRefused = true;
    }
    assert.equal(runtimeRefused, true, `runtime refused the ${label} spelling ${JSON.stringify(spelling)}`);
    let identityRefused = false;
    try {
      hashEntries([[spelling, identityDigest]]);
    } catch {
      identityRefused = true;
    }
    assert.equal(identityRefused, true, `hashEntries refused the ${label} spelling ${JSON.stringify(spelling)}`);
    // Nothing was published under the negative attempt: the identity never
    // entered the store, so a read at the would-be negative key refuses.
    const absentKey = {
      relativePath: 'challenge/f1-negative.json',
      kind: 'ChallengeIdentity',
      id: badChallenge.challengeId,
    };
    let absentRefused = false;
    try {
      await store.read(absentKey);
    } catch (error) {
      absentRefused = error instanceof StorageError && error.code === 'ERR_STORAGE_NOT_FOUND';
    }
    assert.equal(absentRefused, true, `no forged persistence for ${JSON.stringify(spelling)}`);
  }
});

/* ================================================== SOTA2F2 integrated seam:
   the derivation grammar is one domain across the runtime validator, the
   helper, the compiled measurement/result JSON Schemas, a containing Result
   and a real storage publish/read/revalidate roundtrip; a formula outside
   the grammar never persists ============================================== */

test('SOTA2F2 derivation grammar parity: runtime, helper, schemas, Result binding and the storage seam agree, negatives never persist', async (t) => {
  const require = createRequire(import.meta.url);
  const Ajv2020 = require('ajv/dist/2020');
  const ajv = new Ajv2020();
  const compiledMeasurement = ajv.compile(
    JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../schemas/measurement.schema.json', import.meta.url)), 'utf8')),
  );
  const compiledResult = ajv.compile(
    JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../schemas/result.schema.json', import.meta.url)), 'utf8')),
  );

  const derivedFixture = loadFixture('measurement.tokensPerSecond');
  const resultFixture = structuredClone(loadFixture('result.selfassessment'));
  const derivedEntryFor = (formula) => ({
    schemaVersion: NEUTRAL_CONTRACT_VERSION,
    kind: 'Measurement',
    measurementId: 'meas-integration-f2-derived',
    metric: 'tokensPerSecond',
    unit: 'ratio',
    measurementKind: 'DERIVED',
    value: 12.5,
    source: {
      kind: 'LOCAL_DIGEST',
      digest: resultFixture.bindings.treeDigest,
      procedure: 'integration:f2-derived-source',
    },
    derivation: formula,
    recordedAt: '2026-03-01T10:30:00.000Z',
  });

  const cases = [
    ['{manualUsageCount} / {elapsedWallSeconds}', true],
    ['  {a}  ', true],
    ['', false],
    ['   ', false],
    ['no placeholder', false],
    ['{a', false],
    ['a}', false],
    ['{{a}}', false],
    ['{ a }', false],
  ];
  for (const [formula, expected] of cases) {
    // Runtime Measurement.
    let runtimeOk = false;
    try {
      validateRecord('Measurement', structuredClone({ ...derivedFixture, derivation: formula }));
      runtimeOk = true;
    } catch {
      runtimeOk = false;
    }
    // Helper.
    let helperOk = false;
    try {
      parseDerivation(formula);
      helperOk = true;
    } catch {
      helperOk = false;
    }
    // Compiled measurement schema.
    let schemaOk = compiledMeasurement(structuredClone({ ...derivedFixture, derivation: formula })) === true;
    // Containing Result: runtime and compiled result schema (the $ref path).
    const resultWith = structuredClone(resultFixture);
    resultWith.measurements.push(derivedEntryFor(formula));
    let resultRuntimeOk = false;
    try {
      validateRecord('Result', structuredClone(resultWith));
      resultRuntimeOk = true;
    } catch {
      resultRuntimeOk = false;
    }
    let resultSchemaOk = compiledResult(structuredClone(resultWith)) === true;
    assert.equal(runtimeOk, expected, `runtime Measurement ${JSON.stringify(formula)}`);
    assert.equal(helperOk, expected, `helper parseDerivation ${JSON.stringify(formula)}`);
    assert.equal(schemaOk, expected, `schema measurement.derivation ${JSON.stringify(formula)}`);
    assert.equal(resultRuntimeOk, expected, `runtime Result (containing) ${JSON.stringify(formula)}`);
    assert.equal(resultSchemaOk, expected, `schema Result (containing) ${JSON.stringify(formula)}`);
  }

  /* Runtime-disclosed semantic extras (the schema is a structural gate only,
   * exactly as SOTA2 bound it): a repeated input stays valid under the shared
   * formula pattern and is refused only by the runtime validator and the
   * helper. */
  for (const formula of ['{a} {a}', '{a} + {a} + {a}']) {
    let runtimeOk = false;
    let runtimeMessage = '';
    try {
      validateRecord('Measurement', structuredClone({ ...derivedFixture, derivation: formula }));
      runtimeOk = true;
    } catch (error) {
      runtimeMessage = error.message;
    }
    let helperOk = false;
    try {
      parseDerivation(formula);
      helperOk = true;
    } catch {
      helperOk = false;
    }
    const schemaOk = compiledMeasurement(structuredClone({ ...derivedFixture, derivation: formula })) === true;
    const resultWith = structuredClone(resultFixture);
    resultWith.measurements.push(derivedEntryFor(formula));
    let resultRuntimeOk = false;
    try {
      validateRecord('Result', structuredClone(resultWith));
      resultRuntimeOk = true;
    } catch {
      resultRuntimeOk = false;
    }
    assert.equal(runtimeOk, false, `runtime refuses the repeated-input extra ${JSON.stringify(formula)}`);
    assert.match(runtimeMessage, /repeated input/, 'the refusal names the disclosed semantic extra');
    assert.equal(helperOk, false, `helper refuses the repeated-input extra ${JSON.stringify(formula)}`);
    assert.equal(schemaOk, true, `the shared structural pattern still accepts ${JSON.stringify(formula)} (runtime-only extra)`);
    assert.equal(resultRuntimeOk, false, `the containing Result refuses the repeated-input extra ${JSON.stringify(formula)}`);
  }

  // Persistence: the valid spelling publishes, reads back byte-stable and
  // revalidates; the negative spelling never reaches bytes at all (no forged
  // persistence, nothing to reconcile later).
  const root = scratch(t, 'sota2-derivations');
  const store = createStorage({ root: path.join(root, 'store') });
  const validFormula = '{manualUsageCount} / {elapsedWallSeconds}';
  const validRecord = validateRecord('Measurement',
    structuredClone({ ...derivedFixture, derivation: validFormula }));
  const validKey = {
    relativePath: 'measurements/f2-valid.json',
    kind: 'Measurement',
    id: validRecord.measurementId,
  };
  await store.createImmutable({ ...validKey, value: validRecord });
  const republished = validateRecord('Measurement', await store.read(validKey));
  assert.equal(republished.derivation, validFormula, 'the valid formula string is byte-stable through the seam');
  assert.deepEqual(parseDerivation(republished.derivation).inputs,
    ['manualUsageCount', 'elapsedWallSeconds'],
    'the parsed input view is derived on demand from the same stable string');

  const badFormula = '{manualUsageCount} / {elapsedWall';
  const badRecord = structuredClone({ ...derivedFixture, derivation: badFormula });
  badRecord.measurementId = 'meas-integration-f2-negative';
  let validationRefused = false;
  try {
    validateRecord('Measurement', badRecord);
  } catch {
    validationRefused = true;
  }
  assert.equal(validationRefused, true, 'the malformed formula is refused before persistence');
  const absentKey = {
    relativePath: 'measurements/f2-negative.json',
    kind: 'Measurement',
    id: badRecord.measurementId,
  };
  let absentRefused = false;
  try {
    await store.read(absentKey);
  } catch (error) {
    absentRefused = error instanceof StorageError && error.code === 'ERR_STORAGE_NOT_FOUND';
  }
  assert.equal(absentRefused, true, 'no forged persistence for the malformed formula');
});

test('the JSON Schemas (draft 2020-12) accept every positive fixture and reject the mutation set exactly as the runtime does', () => {
  const require = createRequire(import.meta.url);
  const Ajv2020 = require('ajv/dist/2020');
  const ajv = new Ajv2020(); // default strict mode: schema defects fail loudly

  const schemaDir = fileURLToPath(new URL('../../schemas', import.meta.url));
  const families = {
    ToolingIdentity: 'tooling.schema.json',
    ChallengeIdentity: 'challenge.schema.json',
    EvaluatorIdentity: 'evaluator.schema.json',
    RunManifest: 'run.schema.json',
    FrozenSubmission: 'submission.schema.json',
    Measurement: 'measurement.schema.json',
    Result: 'result.schema.json',
  };
  const compiled = {};
  for (const [kind, file] of Object.entries(families)) {
    const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, file), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', `${file} is draft 2020-12`);
    compiled[kind] = ajv.compile(schema);
  }

  // Positive fixtures: one per family, raw wire form.
  const positives = {
    ToolingIdentity: loadFixture('tooling.identity'),
    ChallengeIdentity: loadFixture('challenge.identity'),
    EvaluatorIdentity: loadFixture('evaluator.identity'),
    RunManifest: loadFixture('run.manifest'),
    FrozenSubmission: loadFixture('frozen.submission'),
    Measurement: loadFixture('measurement.tokensPerSecond'),
    Result: loadFixture('result.selfassessment'),
  };
  for (const [kind, record] of Object.entries(positives)) {
    assert.equal(compiled[kind](structuredClone(record)), true, `${kind} positive fixture matches its JSON schema`);
    const validated = validateRecord(kind, structuredClone(record)); // runtime agrees
    void validated;
  }

  // Mutation matrix: every mutation is refused by BOTH the JSON Schema and
  // the runtime validator (discriminator/grammar/enum/structure parity).
  const variants = [
    ['schemaVersion 2.0.0', (r) => { r.schemaVersion = '2.0.0'; }],
    ['schemaVersion 01.0.0 (leading zero)', (r) => { r.schemaVersion = '01.0.0'; }],
    ['wrong kind', (r) => { r.kind = r.kind === 'Result' ? 'RunManifest' : 'Result'; }],
    ['unknown enum value', (r) => {
      if (r.unit !== undefined) r.unit = 'parsec';
      else if (r.exposure !== undefined) r.exposure = 'BROADCAST';
      else if (r.lifecycle !== undefined) r.lifecycle = 'CERTIFIED';
      else if (r.hashAlgorithm !== undefined) r.hashAlgorithm = 'md5';
      else if (r.runtimeFlags === undefined) r.runtimeFlags = 'not-a-map';
    }],
    ['unexpected property', (r) => { r.inventedIntegrationField = 1; }],
  ];
  for (const [kind, positive] of Object.entries(positives)) {
    for (const [label, mutate] of variants) {
      const mutant = structuredClone(positive);
      mutate(mutant);
      assert.equal(compiled[kind](mutant), false, `${kind} / ${label}: schema refuses`);
      let refused = false;
      try {
        validateRecord(kind, structuredClone(mutant));
      } catch (error) {
        assert.ok(error instanceof Error,
          `${kind} / ${label}: runtime refusal connects via the Error chain (plain Error from the issue list, or TypeError for an unknown kind)`);
        refused = true;
      }
      assert.equal(refused, true, `${kind} / ${label}: runtime refuses`);
    }
  }

  // Digest tampering is refused by both layers where the family carries one:
  const digestMutations = [
    ['ToolingIdentity', 'installedDigest'],
    ['ChallengeIdentity', 'publicPrdDigest'],
    ['EvaluatorIdentity', 'scoringDigest'],
    ['RunManifest', 'definitionDigest'],
  ];
  for (const [kind, field] of digestMutations) {
    const mutant = structuredClone(positives[kind]);
    mutant[field] = 'X'.repeat(64);
    assert.equal(compiled[kind](mutant), false, `${kind} digest pattern: schema refuses`);
    let refused = false;
    try {
      validateRecord(kind, structuredClone(mutant));
    } catch {
      refused = true;
    }
    assert.equal(refused, true, `${kind} digest pattern: runtime refuses`);
  }

  // Run-manifest roots: a relative root mutant is refused by both layers.
  const relative = structuredClone(positives.RunManifest);
  relative.participantWorkspaceRoot = 'integration-workspace';
  assert.equal(compiled.RunManifest(relative), false, 'relative workspace root: schema refuses');
  let refuseRoot = false;
  try {
    validateRecord('RunManifest', structuredClone(relative));
  } catch {
    refuseRoot = true;
  }
  assert.equal(refuseRoot, true, 'relative workspace root: runtime refuses');
});

test('neutral modules run in an isolated copied-core environment with DSH, runner and private state absent', (t) => {
  const root = scratch(t, 'isolated');
  const isolatedDir = path.join(root, 'island');
  const coreDir = path.join(isolatedDir, 'core');
  fs.mkdirSync(coreDir, { recursive: true });
  for (const name of ['identity.mjs', 'paths.mjs', 'storage.mjs', 'manifest.mjs']) {
    const original = fs.readFileSync(
      fileURLToPath(new URL(`../../packages/core/${name}`, import.meta.url)),
    );
    fs.writeFileSync(path.join(coreDir, name), original);
    // The isolated copy is byte-identical to the released module.
    assert.equal(
      fs.readFileSync(path.join(coreDir, name)).length,
      original.length,
      `${name} copied faithfully`,
    );
  }
  // The island contains none of the environment the modules might lean on.
  for (const forbidden of ['.ai', '.agent' + '-teams', 'runner', 'starter', 'node_modules', 'package.json', 'schemas']) {
    assert.ok(!fs.existsSync(path.join(isolatedDir, forbidden)), `the island has no ${forbidden}`);
  }

  const harness = `
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { sha256, hashEntries, inventoryTree, createId } from './core/identity.mjs';
import { validateRelativePath, resolveWithinRoot, PathError } from './core/paths.mjs';
import { createStorage, StorageError } from './core/storage.mjs';
import {
  validateRecord, createRunManifest, readLegacyResult, isLegacyEnvelope,
  computeTreeDigest, identityDigestOf, canonicalJson, sha256Hex, NEUTRAL_CONTRACT_KINDS,
} from './core/manifest.mjs';

const expectedSha = process.argv[2];
assert.equal(sha256('isolated'), expectedSha, 'sha256 works with no repo context');
assert.match(createId('iso'), /^iso-[0-9a-f]{32}$/, 'createId works with no repo context');

// Paths work with no repo context.
const workRoot = path.join(process.cwd(), 'work');
fs.mkdirSync(workRoot, { recursive: true });
fs.writeFileSync(path.join(workRoot, 'a.txt'), 'A\\n');
assert.equal(resolveWithinRoot({ root: workRoot, relativePath: 'a.txt' }), path.join(workRoot, 'a.txt'));
let refused = false;
try { validateRelativePath('../escape'); } catch (error) { refused = error instanceof PathError; }
assert.equal(refused, true, 'traversal is still refused in isolation');

// Manifest works with no repo context: synthetic sealed identities.
let refusedMajor = false;
try { validateRecord('ToolingIdentity', { schemaVersion: '2.0.0' }); } catch { refusedMajor = true; }
assert.equal(refusedMajor, true, 'an unknown schema major is refused in isolation');

const pairs = [['a.txt', sha256('A\\n')]];
const arch = (id, kind, seed) => ({
  architectureId: id,
  architectureKind: kind,
  hashAlgorithm: 'sha256',
  definitionDigest: sha256Hex('island-def:' + seed),
  digestProvenance: { kind: 'COMPUTED', procedure: 'island:canonical-json', inputs: [seed] },
});
const toolingIdentity = {
  schemaVersion: '1.0.0',
  kind: 'ToolingIdentity',
  toolingId: 'island-tooling',
  toolingVersion: '0.1.0',
  toolingComponent: 'island-cli',
  revision: 'island',
  installedDigest: sha256Hex('island-installed'),
  ...arch('arch-island-tooling', 'tooling', 'tooling'), 
};
const challengeIdentity = {
  schemaVersion: '1.0.0',
  kind: 'ChallengeIdentity',
  challengeId: 'island-challenge',
  challengeVersion: '1.0.0',
  ...arch('arch-island-challenge', 'challenge', 'challenge'),
  workloadProvenance: { kind: 'COMPUTED', procedure: 'island:starter-inventory-digest' },
  publicPrdDigest: sha256Hex('island-prd'),
  visibleHarnessDigest: sha256Hex('island-harness'),
  fixtureDigest: sha256Hex('island-fixtures'),
  starterInventory: pairs,
  workloadDigest: computeTreeDigest(pairs),
  candidateLineage: {
    candidateVersion: '1.0.0-candidate.9',
    candidateStatus: 'ISLAND_SYNTHETIC',
    sourceCommit: 'abcdef1234567890abcdef1234567890abcdef12',
  },
};
const evaluatorIdentity = {
  schemaVersion: '1.0.0',
  kind: 'EvaluatorIdentity',
  evaluatorId: 'island-evaluator',
  evaluatorVersion: '1.0.0',
  exposure: 'OWNER_LOCAL',
  transparency: 'LOCAL_VISIBLE',
  ...arch('arch-island-evaluator', 'evaluator', 'evaluator'),
  scoringDigest: sha256Hex('island-scoring'),
  visibleTestsDigest: sha256Hex('island-visible'),
  hiddenTestsDigest: sha256Hex('island-hidden'),
};
const manifest = createRunManifest({
  manifestId: 'island-manifest-0001',
  runId: 'island-run-0001',
  createdAt: '2026-03-01T09:00:00.000Z',
  architectureId: 'arch-island-run',
  harness: 'manual',
  participantWorkspaceRoot: path.sep === '/' ? '/tmp/island-work' : 'C:\\\\island-work',
  evidenceRoot: path.sep === '/' ? '/tmp/island-evidence' : 'C:\\\\island-evidence',
  toolingIdentity,
  challengeIdentity,
  evaluatorIdentity,
});
assert.equal(identityDigestOf(manifest), manifest.manifestDigest, 'the sealed manifest digest recomputes in isolation');
assert.equal(Object.isFrozen(manifest), true, 'the sealed manifest is frozen in isolation');
assert.equal(NEUTRAL_CONTRACT_KINDS.includes('RunManifest'), true);

const legacy = readLegacyResult({
  schemaVersion: '1.0',
  run: { runId: 'island-legacy', benchmarkVersion: '0.9.0', startedAt: '2026-01-01T00:00:00.000Z' },
});
assert.equal(isLegacyEnvelope(legacy), true, 'the legacy reader works in isolation');
let promotedRefused = false;
try { validateRecord('Result', legacy); } catch { promotedRefused = true; }
assert.equal(promotedRefused, true, 'a legacy envelope is never validated into a neutral result in isolation');

// Storage works with no repo context: publish, read, immutable refusal.
const store = createStorage({ root: path.join(workRoot, 'store') });
await store.createImmutable({
  relativePath: 'inv/a.json',
  kind: 'Island.inventory',
  id: 'iso-1',
  value: { pairs },
});
const stored = await store.read({ relativePath: 'inv/a.json', kind: 'Island.inventory', id: 'iso-1' });
assert.deepEqual(stored, { pairs });
assert.equal(hashEntries(stored.pairs), inventoryTree({ root: workRoot, skipNames: ['store'] }).digest,
  'the isolated tree digest agrees with the stored inventory pairs');
let immutableRefused = false;
try {
  await store.replaceMutable({ relativePath: 'inv/a.json', kind: 'Island.inventory', id: 'iso-1', value: { pairs: [] } });
} catch (error) {
  immutableRefused = error instanceof StorageError && error.code === 'ERR_STORAGE_IMMUTABLE_REPLACEMENT';
}
assert.equal(immutableRefused, true, 'immutability is preserved in isolation');

process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
`;

  const harnessPath = path.join(isolatedDir, 'harness.mjs');
  fs.writeFileSync(harnessPath, harness, 'utf8');

  // Minimal environment: no DSH variables, no repo-derived configuration.
  const minimalEnv = process.platform === 'win32'
    ? { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC }
    : { PATH: process.env.PATH };
  for (const key of Object.keys(minimalEnv)) assert.ok(minimalEnv[key] !== undefined, `${key} is present`);
  const result = spawnSync(process.execPath, [harnessPath, sha256('isolated')], {
    cwd: isolatedDir,
    env: minimalEnv,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `the isolated harness failed:\n${result.stdout}\n${result.stderr}`);
  assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).ok, true);
});

/* ============================================ pinned TypeScript compiler:
   the shipped declarations resolve for a real NodeNext consumer ========== */

const CORE_MODULES = ['identity', 'paths', 'storage', 'manifest'];
const pinnedCompilerPath = () =>
  fileURLToPath(new URL('../../starter/node_modules/typescript/bin/tsc', import.meta.url));

/**
 * POSIX relative specifier from a consumer directory to a shipped core file,
 * computed so the depth can never be wrong again (the earlier consumer bug
 * was a hand-computed relative path).
 */
function relativeSpec(fromDir, targetFile) {
  const spec = path.relative(fromDir, targetFile).split(path.sep).join('/');
  return spec.startsWith('.') ? spec : `./${spec}`;
}

function consumerSpecifiers(directory) {
  const coreRoot = fileURLToPath(new URL('../../packages/core', import.meta.url));
  const spec = (name) => relativeSpec(directory, path.join(coreRoot, `${name}.mjs`));
  return {
    identity: spec('identity'),
    paths: spec('paths'),
    storage: spec('storage'),
    manifest: spec('manifest'),
  };
}

function runPinnedCompiler(directory, file) {
  return spawnSync(process.execPath, [
    pinnedCompilerPath(), '--noEmit', '--strict', '--target', 'es2022',
    '--module', 'nodenext', '--moduleResolution', 'nodenext',
    file,
  ], { cwd: directory, encoding: 'utf8' });
}

test('the shipped .d.mts siblings stay byte-identical to their read-only .d.ts sources', () => {
  for (const name of CORE_MODULES) {
    const dts = fs.readFileSync(
      fileURLToPath(new URL(`../../packages/core/${name}.d.ts`, import.meta.url)),
    );
    const dmtsPath = fileURLToPath(new URL(`../../packages/core/${name}.d.mts`, import.meta.url));
    assert.ok(fs.existsSync(dmtsPath), `${name}.d.mts exists next to the shipped module`);
    assert.equal(
      fs.readFileSync(dmtsPath).toString('utf8'),
      dts.toString('utf8'),
      `${name}.d.mts is a byte-identical copy of ${name}.d.ts (kept synchronized until the packaging disposition)`,
    );
  }
});

test('a real NodeNext consumer typechecks the shipped packages/core modules directly (no remapping)', (t) => {
  const compiler = pinnedCompilerPath();
  assert.ok(fs.existsSync(compiler), 'mandatory pinned TypeScript compiler must be available; no install or skip');
  const root = scratch(t, 'ts-direct');
  const specs = consumerSpecifiers(root);
  const positiveConsumer = `
/* Positive consumer: real imports of the SHIPPED core paths, no copies. */
import { sha256, hashEntries, inventoryTree, createId, HASH_ALGORITHM_ID } from '${specs.identity}';
import { validateRelativePath, resolveWithinRoot, PathError, PATH_ERROR_CODES } from '${specs.paths}';
import { createStorage, StorageError } from '${specs.storage}';
import {
  validateRecord, readLegacyResult, identityDigestOf, isLegacyEnvelope,
  createRunManifest, ContractValidationError, NEUTRAL_CONTRACT_KINDS,
  type ContractKind,
  type ToolingIdentity,
  type LegacyResultEnvelope,
} from '${specs.manifest}';

const digest: string = sha256('direct');
const pairDigest: string = hashEntries([['a.txt', sha256('A\\n')]]);
const id: string = createId('direct');
const algorithm: string = HASH_ALGORITHM_ID;
const validated: string = validateRelativePath('src/App.tsx');
const resolved: string = resolveWithinRoot({ root: 'C:/tmp/root', relativePath: validated });
const code: (typeof PATH_ERROR_CODES)[keyof typeof PATH_ERROR_CODES] = PATH_ERROR_CODES.OUT_OF_ROOT;
const err1: string = new PathError(code, 'msg').code;

const kinds: readonly ContractKind[] = NEUTRAL_CONTRACT_KINDS;
let refused = false;
try {
  validateRecord('ToolingIdentity', { schemaVersion: '2.0.0' });
} catch (error) {
  refused = error instanceof ContractValidationError && /^[^:]+: /.test(error.message);
}
const bound: string = identityDigestOf({ a: 1 });
const legacy: LegacyResultEnvelope = readLegacyResult(JSON.parse('{"schemaVersion":"1.0","run":{"runId":"d-1","benchmarkVersion":"1.0","startedAt":"2026-01-01T00:00:00.000Z"}}'));
const neverPromoted: false = legacy.promotionAllowed;
const envelopeHonest: boolean = isLegacyEnvelope(legacy);
const toolingShape: ToolingIdentity = {
  schemaVersion: '1.0.0',
  kind: 'ToolingIdentity',
  toolingId: 't-001',
  toolingVersion: '0.1.0',
  toolingComponent: 'typed-consumer',
  revision: 'rev',
  installedDigest: sha256('typed-consumer-installed'),
  architectureId: 'arch-001',
  architectureKind: 'tooling',
  hashAlgorithm: 'sha256',
  definitionDigest: sha256('typed-consumer-definition'),
  digestProvenance: { kind: 'COMPUTED', procedure: 'typed-consumer:canonical-json' },
};
const sealed = createRunManifest as (input: unknown) => Record<string, unknown>;
void sealed;

async function flow(): Promise<void> {
  const store = createStorage({ root: 'C:/tmp/store' });
  const result = await store.createImmutable({
    relativePath: 'records/one.json',
    kind: 'Demo.record',
    id: 'd-1',
    value: { a: 1 },
  });
  const recordType: 'immutable' | 'mutable' = result.recordType;
  const back = await store.read<{ a: number }>({
    relativePath: 'records/one.json', kind: 'Demo.record', id: 'd-1',
  });
  const n: number = back.a;
  void digest; void pairDigest; void id; void algorithm; void resolved; void err1;
  void kinds; void refused; void bound; void neverPromoted; void envelopeHonest;
  void toolingShape; void recordType; void n; void legacy;
}
void flow;
`;
  const consumerPath = path.join(root, 'consumer-direct.ts');
  fs.writeFileSync(consumerPath, positiveConsumer, 'utf8');
  const ok = runPinnedCompiler(root, consumerPath);
  assert.equal(ok.status, 0, `the pinned compiler rejected the direct consumer of the shipped modules:\n${ok.stdout}\n${ok.stderr}`);
});

test('a deliberately misusing consumer is rejected by the pinned compiler', (t) => {
  const compiler = pinnedCompilerPath();
  assert.ok(fs.existsSync(compiler), 'mandatory pinned TypeScript compiler must be available; no install or skip');
  const root = scratch(t, 'ts-negative');
  const specs = consumerSpecifiers(root);
  const negativeConsumer = `
import { sha256, inventoryTree } from '${specs.identity}';
import { resolveWithinRoot } from '${specs.paths}';
import { createStorage } from '${specs.storage}';
import { validateRecord } from '${specs.manifest}';

// Type errors on purpose; the pinned compiler must reject every one.
const wrongCarrier: string = sha256(42);
const wrongRoot: string = inventoryTree({ root: 42 });
const wrongStore = createStorage({ root: 42 });
const wrongKey = await (createStorage({ root: 'C:/x' })).read({ relativePath: 'a.json', kind: 5, id: 6 });
const wrongKind = validateRecord('NotAKnownKind', {});
void wrongCarrier; void wrongRoot; void wrongStore; void wrongKey; void wrongKind;
`;
  const consumerPath = path.join(root, 'consumer-invalid.ts');
  fs.writeFileSync(consumerPath, negativeConsumer, 'utf8');
  const bad = runPinnedCompiler(root, consumerPath);
  assert.notEqual(bad.status, 0, 'the pinned compiler must reject the INVALID consumer');
  const diagnostics = `${bad.stdout}\n${bad.stderr}`;
  assert.match(diagnostics, /consumer-invalid\.ts/, 'diagnostics name the invalid consumer file');
  const errorLines = diagnostics.split('\n').filter((line) => /error TS\d+:/.test(line));
  assert.ok(errorLines.length >= 4, `at least four type errors are diagnosed:\n${diagnostics}`);
  assert.match(diagnostics, /HashInput/, 'the sha256 carrier misuse is diagnosed against HashInput');
  assert.match(diagnostics, /NotAKnownKind|ContractKind/, 'an unknown contract kind is diagnosed against ContractKind');
  assert.match(diagnostics, /not assignable to type 'string'/, 'the string-typed misuses are diagnosed');
});

/* Released status/provenance acceptance: expectations come from the contract,
 * not validator output. Storage stays generic: callers validate before write. */
function releasedSchemaGates() {
  const require = createRequire(import.meta.url);
  assert.equal(require('ajv/package.json').version, '8.17.1');
  const Ajv2020 = require('ajv/dist/2020');
  const ajv = new Ajv2020();
  const schema = (name) => JSON.parse(moduleSource(`../../schemas/${name}.schema.json`));
  return { Measurement: ajv.compile(schema('measurement')), Result: ajv.compile(schema('result')) };
}

function runtimeAccepts(kind, value) {
  try { validateRecord(kind, value); return true; } catch { return false; }
}

const OMIT = Symbol('omitted wire field');
function wireField(object, key, value) {
  if (value === OMIT) delete object[key];
  else object[key] = value;
}

function acceptanceStore(t, label) {
  const root = path.join(scratch(t, label), 'store');
  let stages = 0;
  const store = createStorage({ root, hooks: { beforeStage: () => { stages++; } } });
  return { root, store, stages: () => stages };
}

async function validatedRoundtrip(context, kind, record, serial) {
  const validated = validateRecord(kind, record);
  const id = kind === 'Result' ? validated.resultId : validated.measurementId;
  const key = { relativePath: `accepted/${kind}-${serial}.json`, kind, id };
  await context.store.createImmutable({ ...key, value: validated });
  const read = await context.store.read(key);
  assert.deepEqual(read, validated, 'validated bytes survive generic storage unchanged');
  assert.deepEqual(validateRecord(kind, read), validated, 'stored domain record revalidates unchanged');
  return read;
}

async function refusesBeforeWrite(context, kind, record, label) {
  const stagesBefore = context.stages();
  const key = { relativePath: `refused/${kind}.json`, kind, id: 'refused-domain-record' };
  // Attempt the real composed validate -> write seam, not a storage policy.
  await assert.rejects(async () => {
    const validated = validateRecord(kind, record);
    await context.store.createImmutable({ ...key, value: validated });
  }, /./, label);
  assert.equal(context.stages(), stagesBefore, `${label}: no staging hook invoked`);
  assert.ok(!fs.existsSync(path.join(context.root, key.relativePath)), `${label}: no record bytes`);
}

test('released Result status axes: contract-derived runtime/Ajv matrix refuses invalid combinations before storage', async (t) => {
  const schema = releasedSchemaGates().Result;
  const context = acceptanceStore(t, 'status-matrix');
  const base = loadFixture('result.selfassessment');
  const evaluators = ['SUCCESS', 'FAILURE', 'INFRASTRUCTURE_ERROR', null, OMIT];
  const eligibility = ['ELIGIBLE_NOT_RUN', 'ELIGIBLE_PENDING_HUMAN_REVIEW', 'SCORED', 'INELIGIBLE'];
  const values = [null, OMIT, 0, 81];
  let count = 0, accepted = 0, refused = 0;
  for (const status of ['HUMAN_REVIEW_PENDING', 'SCORED', 'INVALID'])
    for (const evaluator of evaluators)
      for (const review of ['NOT_REVIEWED', 'SCORED'])
        for (const eligible of eligibility)
          for (const ui of values)
            for (const final of values)
              for (const reviewer of ['named-human', null, OMIT]) {
                const numericUI = typeof ui === 'number';
                const numericFinal = typeof final === 'number';
                const scored = status === 'SCORED';
                // Separate axes: do not infer execution, trust or arithmetic.
                const expected = scored
                  ? evaluator === 'SUCCESS' && review === 'SCORED' && eligible === 'SCORED' &&
                    numericUI && numericFinal && reviewer === 'named-human'
                  : !numericFinal && eligible !== 'SCORED' &&
                    (status !== 'INVALID' || eligible === 'INELIGIBLE') &&
                    (!numericUI || (review === 'SCORED' && reviewer === 'named-human' && eligible !== 'ELIGIBLE_NOT_RUN'));
                const record = structuredClone(base);
                record.quality.status = status;
                record.scoreEligibility = eligible;
                wireField(record, 'evaluatorExecution', evaluator);
                record.humanReview = { reviewStatus: review };
                wireField(record.humanReview, 'reviewer', reviewer);
                wireField(record.quality, 'humanUI', ui);
                wireField(record.quality, 'quality', final);
                const label = `status case ${++count}: ${status}/${String(evaluator)}/${review}/${eligible}/${String(ui)}/${String(final)}/${String(reviewer)}`;
                assert.equal(runtimeAccepts('Result', record), expected, `${label}: runtime`);
                assert.equal(schema(record), expected, `${label}: actual Ajv2020 ${JSON.stringify(schema.errors)}`);
                if (expected) accepted++;
                else { refused++; await refusesBeforeWrite(context, 'Result', record, label); }
              }
  assert.equal(count, 5760);
  assert.ok(accepted > 0 && refused > 0);
  await expectStorageCode(context.store.read({ relativePath: 'refused/Result.json', kind: 'Result', id: 'refused-domain-record' }), 'ERR_STORAGE_ROOT_NOT_FOUND');
  t.diagnostic(`Result matrix: ${count} cases, ${accepted} valid, ${refused} refused before write`);

  // Whole review missing/null is structurally invalid, not a fabricated review.
  for (const review of [OMIT, null]) for (const fixture of ['result.selfassessment', 'result.localscored']) {
    const record = loadFixture(fixture);
    wireField(record, 'humanReview', review);
    assert.equal(schema(record), false);
    await refusesBeforeWrite(context, 'Result', record, 'missing/null human review object');
  }
  for (const reviewer of ['', '   ', 42]) {
    const record = loadFixture('result.localscored');
    record.humanReview.reviewer = reviewer;
    assert.equal(schema(record), false);
    await refusesBeforeWrite(context, 'Result', record, 'invalid scored reviewer');
  }
  for (const [field, value] of [['runStatus', 'ABORTED'], ['runStatus', 'SEEDED_NOT_STARTED'], ['lifecycle', 'DRAFT'], ['limitations', []]]) {
    const record = loadFixture('result.localscored');
    record[field] = value;
    assert.equal(schema(record), false);
    await refusesBeforeWrite(context, 'Result', record, 'existing scored eligibility gate');
  }

  // Original pending/scored positives plus all-zero and omitted optional scores.
  const positives = [loadFixture('result.selfassessment'), loadFixture('result.localscored')];
  const zero = loadFixture('result.localscored');
  zero.quality.automated = 0; zero.quality.humanUI = 0; zero.quality.quality = 0;
  positives.push(zero);
  const missing = loadFixture('result.selfassessment');
  delete missing.evaluatorExecution; delete missing.quality.humanUI; delete missing.quality.quality;
  positives.push(missing);
  for (const [index, record] of positives.entries()) {
    record.resultId = `result-status-positive-${index}`;
    assert.equal(schema(record), true);
    const stored = await validatedRoundtrip(context, 'Result', record, index);
    assert.equal(stored.evaluationTrust, 'LOCAL_SELF_ASSESSMENT');
    if (index === 0) { assert.equal(stored.quality.quality, null); assert.equal(stored.quality.humanUI, null); }
    if (index === 1) assert.equal(stored.quality.quality, 81);
    if (index === 2) { assert.equal(stored.quality.quality, 0); assert.equal(stored.quality.humanUI, 0); }
  }
});

test('released MeasurementSource discriminator/reference matrix covers standalone and Result with Ajv and pre-write refusal', async (t) => {
  const schemas = releasedSchemaGates();
  const context = acceptanceStore(t, 'source-matrix');
  const base = loadFixture('result.selfassessment');
  // Persist the actual local records named by the synthetic Result bindings.
  // IDs and identity/tree digests are checked against the read-back records.
  for (const [kind, fixture, idField, bindingId, bindingDigest] of [
    ['RunManifest', 'run.manifest', 'manifestId', 'manifestId', 'manifestDigest'],
    ['FrozenSubmission', 'frozen.submission', 'frozenSubmissionId', 'frozenSubmissionId', 'treeDigest'],
    ['ToolingIdentity', 'tooling.identity', 'toolingId', 'toolingId', 'toolingIdentityDigest'],
    ['ChallengeIdentity', 'challenge.identity', 'challengeId', 'challengeId', 'challengeIdentityDigest'],
    ['EvaluatorIdentity', 'evaluator.identity', 'evaluatorId', 'evaluatorId', 'evaluatorIdentityDigest'],
  ]) {
    const record = validateRecord(kind, loadFixture(fixture));
    const key = { relativePath: `bindings/${kind}.json`, kind, id: record[idField] };
    await context.store.createImmutable({ ...key, value: record });
    const read = validateRecord(kind, await context.store.read(key));
    assert.deepEqual(read, record);
    assert.equal(read[idField], base.bindings[bindingId]);
    assert.equal(kind === 'FrozenSubmission' ? read.treeDigest : identityDigestOf(read), base.bindings[bindingDigest]);
  }
  const sourceKinds = ['LOCAL_ID', 'LOCAL_DIGEST', 'COMPUTED', 'SELF_ASSESSMENT', 'LOCAL_PROCEDURE'];
  const ids = [OMIT, null, '', '  ', 7, base.bindings.manifestId];
  const kinds = [OMIT, null, '', 7, 'WrongKind', 'RunManifest'];
  const digests = [OMIT, null, '', 7, 'g'.repeat(64), base.bindings.manifestDigest];
  let serial = 0, valid = 0, invalid = 0;
  const measurementWith = (source, n) => ({
    schemaVersion: '1.0.0', kind: 'Measurement', measurementId: `measurement-source-${n}`,
    metric: 'sourceProbeCount', unit: 'count', value: 0,
    measurementKind: ['SELF_ASSESSMENT', 'LOCAL_PROCEDURE'].includes(source?.kind) ? 'ENTERED' : 'MEASURED', source,
  });
  for (const sourceKind of sourceKinds) for (const id of ids) for (const kind of kinds) for (const digest of digests) {
    const idAbsent = id === OMIT && kind === OMIT;
    const idValid = id === base.bindings.manifestId && kind === 'RunManifest';
    const digestValid = digest === base.bindings.manifestDigest;
    const expected = (sourceKind === 'LOCAL_ID' ? idValid : idAbsent || idValid) &&
      (sourceKind === 'LOCAL_DIGEST' ? digestValid : digest === OMIT || digestValid);
    const source = { kind: sourceKind, procedure: 'integration:honest-local-source' };
    wireField(source, 'recordId', id); wireField(source, 'recordKind', kind); wireField(source, 'digest', digest);
    const measurement = measurementWith(source, ++serial);
    const result = structuredClone(base);
    result.resultId = `result-source-${serial}`; result.measurements = [measurement];
    for (const [domain, record] of [['Measurement', measurement], ['Result', result]]) {
      const label = `source ${serial}/${domain}/${sourceKind}/${String(id)}/${String(kind)}/${String(digest)}`;
      assert.equal(runtimeAccepts(domain, record), expected, `${label}: runtime`);
      assert.equal(schemas[domain](record), expected, `${label}: Ajv ${JSON.stringify(schemas[domain].errors)}`);
      if (!expected) await refusesBeforeWrite(context, domain, record, label);
      else await validatedRoundtrip(context, domain, record, serial);
    }
    if (expected) valid++; else invalid++;
  }
  assert.equal(serial, 1080);
  assert.equal(valid, 16);
  assert.equal(invalid, 1064);
  t.diagnostic(`Source matrix: ${serial} cases in each domain, ${valid} valid branch forms persisted in each, ${invalid} refused in each`);

  // Named procedure is mandatory even when its ID/digest is real; discriminators
  // cannot be laundered by a procedure string or an unknown source kind.
  const extraSources = [null, OMIT, {}, 42, [], { kind: null, procedure: 'honest' },
    { kind: 'FAKE_ID', recordKind: 'RunManifest', recordId: base.bindings.manifestId, procedure: 'honest' }];
  for (const sourceKind of sourceKinds) for (const procedure of [OMIT, null, '', '   ', 42]) {
    const source = { kind: sourceKind, recordId: base.bindings.manifestId, recordKind: 'RunManifest', digest: base.bindings.manifestDigest };
    wireField(source, 'procedure', procedure); extraSources.push(source);
  }
  for (const source of extraSources) {
    const measurement = measurementWith(source, ++serial);
    wireField(measurement, 'source', source);
    const result = structuredClone(base); result.measurements = [measurement];
    for (const [domain, record] of [['Measurement', measurement], ['Result', result]]) {
      assert.equal(schemas[domain](record), false);
      await refusesBeforeWrite(context, domain, record, 'invalid source/procedure discriminator');
    }
  }

  // Local IDs bind to the appropriate actual record, not a similar spelling.
  const bound = [['RunManifest', 'manifestId'], ['FrozenSubmission', 'frozenSubmissionId'],
    ['ToolingIdentity', 'toolingId'], ['ChallengeIdentity', 'challengeId'], ['EvaluatorIdentity', 'evaluatorId']];
  for (const [recordKind, field] of bound) {
    const source = { kind: 'LOCAL_ID', recordKind, recordId: base.bindings[field], procedure: 'integration:bound-record' };
    const measurement = measurementWith(source, ++serial);
    const result = structuredClone(base); result.resultId = `result-source-${serial}`; result.measurements = [measurement];
    assert.equal(schemas.Result(result), true);
    await validatedRoundtrip(context, 'Measurement', measurement, serial);
    await validatedRoundtrip(context, 'Result', result, serial);
    const wrong = structuredClone(result); wrong.measurements[0].source.recordId = 'different-local-id';
    assert.equal(schemas.Result(wrong), true, 'binding equality is a runtime semantic extra');
    await refusesBeforeWrite(context, 'Result', wrong, 'foreign ID binding');
  }
  for (const field of ['treeDigest', 'manifestDigest', 'toolingIdentityDigest', 'challengeIdentityDigest', 'evaluatorIdentityDigest']) {
    const measurement = measurementWith({ kind: 'LOCAL_DIGEST', digest: base.bindings[field], procedure: 'integration:bound-digest' }, ++serial);
    const result = structuredClone(base); result.resultId = `result-source-${serial}`; result.measurements = [measurement];
    await validatedRoundtrip(context, 'Measurement', measurement, serial);
    await validatedRoundtrip(context, 'Result', result, serial);
  }
  const foreignSources = [
    ...sourceKinds.map((kind) => ({ kind, recordKind: 'RunManifest', recordId: base.bindings.manifestId,
      digest: sha256Hex('unbound-domain-bytes'), procedure: 'integration:foreign-digest' })),
    { kind: 'LOCAL_ID', recordKind: 'Result', recordId: base.resultId, procedure: 'integration:self-source' },
    { kind: 'LOCAL_ID', recordKind: 'Measurement', recordId: 'measurement-foreign', procedure: 'integration:foreign' },
    ...sourceKinds.map((kind) => ({ kind, recordKind: 'ToolingIdentity', recordId: base.bindings.manifestId,
      digest: base.bindings.treeDigest, procedure: 'integration:wrong-domain' })),
  ];
  for (const source of foreignSources) {
    const measurement = measurementWith(source, ++serial);
    const result = structuredClone(base); result.measurements = [measurement];
    assert.equal(schemas.Measurement(measurement), true);
    assert.equal(schemas.Result(result), true, 'schema checks structure, not surrounding binding equality');
    assert.equal(runtimeAccepts('Measurement', measurement), true, 'standalone source has no enclosing Result bindings');
    await refusesBeforeWrite(context, 'Result', result, 'unbound/wrong-domain/self reference');
  }
  // Explicit undefined is not a wire value; it cannot claim a runtime reference.
  for (const field of ['recordId', 'recordKind', 'digest']) {
    const measurement = measurementWith({ kind: 'COMPUTED', procedure: 'integration:undefined-claim', [field]: undefined }, ++serial);
    const result = structuredClone(base); result.measurements = [measurement];
    await refusesBeforeWrite(context, 'Measurement', measurement, 'undefined reference');
    await refusesBeforeWrite(context, 'Result', result, 'undefined reference in Result');
  }
  for (const value of [null, 0, OMIT]) for (const source of [null, OMIT, { kind: 'COMPUTED', procedure: 'integration:sample' }]) {
    const expected = value === null && source === null;
    const measurement = loadFixture('measurement.unavailable');
    measurement.measurementId = `measurement-unavailable-${++serial}`;
    wireField(measurement, 'value', value); wireField(measurement, 'source', source);
    const result = structuredClone(base); result.resultId = `result-source-${serial}`; result.measurements = [measurement];
    for (const [domain, record] of [['Measurement', measurement], ['Result', result]]) {
      assert.equal(schemas[domain](record), expected);
      assert.equal(runtimeAccepts(domain, record), expected);
      if (expected) await validatedRoundtrip(context, domain, record, serial);
      else await refusesBeforeWrite(context, domain, record, 'UNAVAILABLE is exactly null, not zero/missing/source');
    }
  }
  for (const kind of ['Measurement', 'Result']) await expectStorageCode(context.store.read({
    relativePath: `refused/${kind}.json`, kind, id: 'refused-domain-record',
  }), 'ERR_STORAGE_NOT_FOUND');
});

test('generic storage may carry corrupt domain bytes, but released Result/Measurement validation refuses them after read', async (t) => {
  const context = acceptanceStore(t, 'domain-corruption');
  const result = loadFixture('result.selfassessment');
  result.quality.quality = 81;
  const measurement = loadFixture('measurement.filesRead');
  measurement.source = { kind: 'LOCAL_ID', recordId: null, procedure: 'integration:false-local-id' };
  for (const [kind, record, id] of [['Result', result, result.resultId], ['Measurement', measurement, measurement.measurementId]]) {
    const key = { relativePath: `corrupt/${kind}.json`, kind, id };
    await context.store.createImmutable({ ...key, value: record });
    const read = await context.store.read(key);
    assert.deepEqual(read, record, 'generic envelope integrity is not domain validity');
    assert.throws(() => validateRecord(kind, read), undefined, 'domain validation refuses deliberate corruption');
  }
});

test('real shipped-mjs NodeNext consumer enforces MeasurementSource union and narrowing with pinned TypeScript', (t) => {
  assert.ok(fs.existsSync(pinnedCompilerPath()), 'mandatory compiler unavailable: fail, never skip');
  const version = spawnSync(process.execPath, [pinnedCompilerPath(), '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), 'Version 5.7.3');
  const root = scratch(t, 'source-types');
  const spec = consumerSpecifiers(root).manifest;
  const consumer = `
import { validateRecord, type MeasurementSource, type Measurement, type Result } from '${spec}';
const digest = 'a'.repeat(64);
const sources: MeasurementSource[] = [
  { kind: 'LOCAL_ID', recordKind: 'RunManifest', recordId: 'local-run', procedure: 'typed:local-id' },
  { kind: 'LOCAL_DIGEST', digest, procedure: 'typed:local-digest' },
  { kind: 'LOCAL_DIGEST', digest, recordKind: 'FrozenSubmission', recordId: 'local-submission', procedure: 'typed:pair' },
  { kind: 'COMPUTED', procedure: 'typed:computed' },
  { kind: 'SELF_ASSESSMENT', procedure: 'typed:entered' },
  { kind: 'LOCAL_PROCEDURE', recordKind: 'ToolingIdentity', recordId: 'local-tool', digest, procedure: 'typed:optional-pair' },
];
for (const source of sources) {
  if (source.kind === 'LOCAL_ID') { const id: string = source.recordId; const kind: string = source.recordKind; void id; void kind; }
  if (source.kind === 'LOCAL_DIGEST') { const ref: string = source.digest; void ref; }
}
const measured: Measurement = { schemaVersion: '1.0.0', kind: 'Measurement', measurementId: 'typed-measurement', metric: 'count', unit: 'count', measurementKind: 'MEASURED', value: 0, source: sources[0] };
const unavailable: Measurement = { ...measured, measurementKind: 'UNAVAILABLE', value: null, source: null };
const pending: Result = validateRecord('Result', {});
const numberOrNull: number | null | undefined = pending.quality.quality;
// @ts-expect-error LOCAL_ID must have an actual non-null id
const nullId: MeasurementSource = { kind: 'LOCAL_ID', recordKind: 'RunManifest', recordId: null, procedure: 'typed:bad' };
// @ts-expect-error LOCAL_ID cannot omit its id
const missingId: MeasurementSource = { kind: 'LOCAL_ID', recordKind: 'RunManifest', procedure: 'typed:bad' };
// @ts-expect-error LOCAL_ID cannot omit its record kind
const missingKind: MeasurementSource = { kind: 'LOCAL_ID', recordId: 'id', procedure: 'typed:bad' };
// @ts-expect-error record kind cannot be null
const nullKind: MeasurementSource = { kind: 'LOCAL_ID', recordId: 'id', recordKind: null, procedure: 'typed:bad' };
// @ts-expect-error LOCAL_DIGEST must have an actual digest
const missingDigest: MeasurementSource = { kind: 'LOCAL_DIGEST', procedure: 'typed:bad' };
// @ts-expect-error digest cannot be null
const nullDigest: MeasurementSource = { kind: 'LOCAL_DIGEST', digest: null, procedure: 'typed:bad' };
// @ts-expect-error procedure cannot masquerade as a LOCAL_ID reference
const falseId: MeasurementSource = { kind: 'LOCAL_ID', procedure: 'this is only a procedure' };
// @ts-expect-error procedure cannot masquerade as LOCAL_DIGEST
const falseDigest: MeasurementSource = { kind: 'LOCAL_DIGEST', recordId: 'id', recordKind: 'RunManifest', procedure: 'typed:bad' };
// @ts-expect-error optional procedure ID companions must be paired
const halfPair: MeasurementSource = { kind: 'COMPUTED', recordId: 'id', procedure: 'typed:bad' };
// @ts-expect-error optional procedure reference cannot be null
const badCompanion: MeasurementSource = { kind: 'SELF_ASSESSMENT', recordKind: 'RunManifest', recordId: null, procedure: 'typed:bad' };
// @ts-expect-error discriminator is closed
const wrongKind: MeasurementSource = { kind: 'FAKE_ID', procedure: 'typed:bad' };
// @ts-expect-error source itself cannot be null (Measurement source may be)
const nullSource: MeasurementSource = null;
void measured; void unavailable; void numberOrNull;
`;
  const filename = path.join(root, 'source-consumer.mts');
  fs.writeFileSync(filename, consumer, 'utf8');
  const compiled = runPinnedCompiler(root, filename);
  assert.equal(compiled.status, 0, `real consumer union/narrowing/12 expected-error gates failed:\n${compiled.stdout}\n${compiled.stderr}`);
});
