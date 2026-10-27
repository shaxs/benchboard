/**
 * C7a S11 T5 — Registry staging-rename retry policy contract tests.
 *
 * Independent black-box tests for the retry policy of the registry
 * staging-to-registry.json rename, exercised only through the public
 * createStorage API (packages/core/storage.mjs).
 *
 * Policy under test (decided by the task packet):
 *   - Only registry staging-to-registry.json renames retry: win32 plus
 *     EPERM/EACCES/EBUSY, at most eight attempts, delays exactly
 *     [20,40,80,160,320,500,500] ms. Every other error or platform fails
 *     immediately. Retries reuse the same stage path and bytes. There are no
 *     public retry options.
 *   - A failed registry storage throws StorageError with code
 *     ERR_STORAGE_REGISTRY_UNAVAILABLE; exhaustion attaches its FIRST rename
 *     error as .cause (object identity); a non-transient refusal attaches that
 *     immediate error.
 *   - Pre-publication exhaustion publishes no final record. Post-publication
 *     exhaustion retains the immutable record and the pending reservation,
 *     and identical-bytes recovery is unchanged.
 *
 * Injection design (this test process only, per the task packet):
 *   - The node:fs/promises default-export rename property is temporarily
 *     replaced, then syncBuiltinESMExports() from node:module re-syncs the ESM
 *     named exports; the property is restored in finally.
 *   - The timer seam is the global callback timer: the original
 *     globalThis.setTimeout property is captured, replaced by a callback-form
 *     shim that records the requested delay and reschedules through the
 *     captured real global timer at zero milliseconds, and restored in finally.
 *     (The module's node:timers/promises named import is test bookkeeping
 *     only and is never patched.)
 *   - The rename shim intercepts only registry staging renames: destination
 *     basename exactly 'registry.json' and source basename matching
 *     /^registry\.staging-.*\.tmp$/. Every other operation delegates to the
 *     captured real builtins.
 *   - The simulate-linux fixture sets process.platform to 'linux' inside the
 *     targeted failing registry rename only, after root setup, and the test's
 *     finally restores the original property descriptor. This is a scoped test
 *     fixture, not a production option or a global environment change.
 *   - Every test asserts the shims were reached (a registry rename was
 *     observed). A missing hook is a failure, never a skip or a pass.
 *
 * Tests in this file run one at a time (a serial lane), because the shims
 * above are process-wide while a test is active.
 *
 * Scratch lives under tests/contracts/.tmp/registry-retry (covered by the
 * repository's tests tmp-directory ignore rule); each test removes its own
 * random mkdtemp root, and this file never sweeps the shared parent.
 *
 * Runtime proof belongs to Captain acceptance; the worker proof for this file
 * is syntax only while the implementation is in flight.
 */

import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';

import fsPromises from 'node:fs/promises';

import { createStorage } from '../../packages/core/storage.mjs';

// Pin the real builtin functions at module load (before any installation) so
// test bookkeeping and delegation always reach the originals even while the
// live ESM bindings are re-synced to the shims.
const real = Object.freeze({
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  setTimeout,
});

// Original property descriptor of process.platform, captured once so the
// simulate-linux fixture can restore it exactly.
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
assert.ok(originalPlatformDescriptor, 'process.platform must have a property descriptor');

const here = path.dirname(fileURLToPath(import.meta.url));
const scratchBase = path.join(here, '.tmp', 'registry-retry');

const seededRegistryText = '{"schemaVersion":1,"records":{}}';
const seededRegistryBytes = Buffer.from(seededRegistryText, 'utf8');
const fullDelaySequence = [20, 40, 80, 160, 320, 500, 500];
const registryBasename = 'registry.json';
const stagePattern = /^registry\.staging-.*\.tmp$/;

const isWin32Host = () => process.platform === 'win32';

// ---------------------------------------------------------------------------
// Direct (unshimmed) filesystem helpers — real captured builtins only, so
// test bookkeeping never runs through the injected shims.
// ---------------------------------------------------------------------------

async function listFiles(dir, base = dir, acc = []) {
  let names;
  try {
    names = await real.readdir(dir);
  } catch {
    return acc;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    let entryStat;
    try {
      entryStat = await real.stat(full);
    } catch {
      continue;
    }
    if (entryStat.isDirectory()) {
      await listFiles(full, base, acc);
    } else if (entryStat.isFile()) {
      acc.push({
        full,
        relativePath: path.relative(base, full).split(path.sep).join('/'),
      });
    }
  }
  return acc;
}

const collectTmpLeftovers = (root) =>
  listFiles(root).then((files) => files.filter((f) => f.relativePath.endsWith('.tmp')));

const readBytes = (file) =>
  real.readFile(file, 'utf8').then((text) => Buffer.from(text, 'utf8'));

// Supplied C1 registry facts: schemaVersion is 1; records is a non-null,
// non-array JSON object keyed by JSON.stringify([kind, id]); a record has
// relativePath/digest/recordType and may have pending:true; identity lives in
// the map key rather than a record.id field.
const registryKeyOf = (kind, id) => JSON.stringify([kind, id]);

async function readRegistryRecords(registryFile) {
  const registry = JSON.parse(await real.readFile(registryFile, 'utf8'));
  assert.equal(registry.schemaVersion, 1);
  assert.ok(
    registry.records !== null
    && typeof registry.records === 'object'
    && !Array.isArray(registry.records),
    'registry records must be a JSON object keyed by JSON.stringify([kind, id])',
  );
  return registry.records;
}

async function removeTree(treePath) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await real.rm(treePath, { force: true, recursive: true });
      return;
    } catch (error) {
      lastError = error;
      await real.setTimeout(100);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Per-test scratch root with the seeded registry file.
// ---------------------------------------------------------------------------

const makeRoot = (label) => real.mkdtemp(path.join(scratchBase, `${label}-`));

async function seedRegistry(root) {
  const storageDir = path.join(root, '.storage');
  await real.mkdir(storageDir, { recursive: true });
  const registryFile = path.join(storageDir, registryBasename);
  await real.writeFile(registryFile, seededRegistryText, 'utf8');
  return registryFile;
}

// ---------------------------------------------------------------------------
// Serial lane — the process-wide shims allow one test at a time.
// ---------------------------------------------------------------------------

let lane = Promise.resolve();
const serial = (run) => {
  const settled = lane.then(run, run);
  lane = settled.catch(() => undefined);
  return settled;
};

// ---------------------------------------------------------------------------
// Process-scoped injection harness. Installed only inside activeShims and
// always restored in its finally.
// ---------------------------------------------------------------------------

const DELEGATE = Symbol('delegate-to-real-builtin');

function isRegistryStagingRename(from, to) {
  return (
    path.basename(to) === registryBasename
    && stagePattern.test(path.basename(from))
  );
}

function installShims(options = {}) {
  const { registryRenameMode, targetRenameMode, platformOnRegistryRefusal } = options;
  const previousRename = fsPromises.rename;
  const previousGlobalSetTimeout = globalThis.setTimeout;
  const renames = [];
  const delays = [];
  let installed = false;

  const renameShim = async (from, to, ...rest) => {
    if (!isRegistryStagingRename(from, to)) {
      const record = { from, to, registry: false, refused: false, bytes: undefined };
      renames.push(record);
      const decision = targetRenameMode ? await targetRenameMode(record) : undefined;
      if (decision instanceof Error) {
        record.refused = true;
        throw decision;
      }
      return real.rename(from, to, ...rest);
    }
    const record = { from, to, registry: true, refused: false, bytes: undefined };
    try {
      record.bytes = await real.readFile(from);
    } catch {
      // A stage we cannot read is still visible in the call record; the
      // rename below either succeeds, is refused by policy, or fails for real.
    }
    renames.push(record);
    let decision = registryRenameMode ? await registryRenameMode(record, renames) : undefined;
    if (decision === DELEGATE) {
      decision = undefined;
    }
    if (decision instanceof Error) {
      record.refused = true;
      if (platformOnRegistryRefusal !== undefined) {
        // Scoped fixture: the platform value is in force exactly while the
        // policy decides whether to retry this refused rename.
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: platformOnRegistryRefusal,
          writable: true,
        });
      }
      throw decision;
    }
    return real.rename(from, to, ...rest);
  };

  // Callback-form timer shim: records the requested backoff, then reschedules
  // the callback through the captured real global timer at 0 ms so the delay
  // sequence is proven without sleeping through it. The first argument is the
  // callback, not the delay (the production policy awaits a Promise that
  // resolves via this global callback timer).
  const timeoutShim = (callback, delay, ...rest) => {
    if (typeof delay === 'number') {
      delays.push(delay);
    }
    return previousGlobalSetTimeout(callback, 0, ...rest);
  };

  fsPromises.rename = renameShim;
  globalThis.setTimeout = timeoutShim;
  syncBuiltinESMExports();
  installed = true;

  return {
    renames,
    delays,
    registryRenames: () => renames.filter((r) => r.registry),
    refusedRegistryRenames: () => renames.filter((r) => r.registry && r.refused),
    isInstalled: () => installed,
    restore() {
      if (!installed) {
        return;
      }
      fsPromises.rename = previousRename;
      globalThis.setTimeout = previousGlobalSetTimeout;
      syncBuiltinESMExports();
      installed = false;
    },
  };
}

async function activeShims(options, body) {
  const shims = installShims(options);
  try {
    return await body(shims);
  } finally {
    shims.restore();
  }
}

// ---------------------------------------------------------------------------
// Shared assertions.
// ---------------------------------------------------------------------------

function assertWin32Host() {
  assert.ok(
    isWin32Host(),
    'the retry policy under test is win32-scoped; these contract tests must run on a win32 host',
  );
}

const assertRegistryStageName = (from) => {
  assert.match(path.basename(from), stagePattern, 'retried stage uses a registry staging name');
};

/**
 * Await a rejection, then assert it is a StorageError with one of the expected
 * codes (or passing a predicate), and return the error for further asserts.
 */
async function captureRefusal(promise, expected) {
  let error;
  try {
    await promise;
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, 'the operation must reject');
  assert.equal(
    error.name,
    'StorageError',
    `expected StorageError, got ${error.name}: ${error.message}`,
  );
  assert.ok(
    String(error.code).startsWith('ERR_STORAGE_'),
    `refusal codes are stable ERR_STORAGE_* codes, got ${error.code}`,
  );
  if (typeof expected === 'function') {
    assert.ok(expected(error), `refusal predicate rejected code ${error.code}: ${error.message}`);
  } else {
    const allowed = Array.isArray(expected) ? expected : [expected];
    assert.ok(
      allowed.includes(error.code),
      `expected code in [${allowed.join(', ')}], got ${error.code} (${error.message})`,
    );
  }
  return error;
}

// ---------------------------------------------------------------------------
// Fixture setup for the owned scratch base. Each test removes its own
// mkdtemp root in its finally; the ignored parent may remain (empty or with
// another run's roots) and is never swept from here.
// ---------------------------------------------------------------------------

before(async () => {
  await real.mkdir(scratchBase, { recursive: true });
});

describe('registry staging-rename retry policy (C7a.S11.T5)', { skip: process.platform !== 'win32' && 'the registry retry policy is win32-scoped' }, () => {
  // 1. Initial success: the first stage is renamed once, zero delays, a valid
  //    readback, and no leftover registry stage.
  it('renames the first registry stage once with zero delays and clean readback', () => serial(async () => {
    assertWin32Host();
    const root = await makeRoot('success');
    try {
      await seedRegistry(root);
      await activeShims({}, async (shims) => {
        assert.ok(shims.isInstalled(), 'in-process shims must be installed');
        const storage = await createStorage({ root });
        const key = { relativePath: 'records/success.json', kind: 'rec', id: 'retry-success' };
        const value = { note: 'registry-retry-initial-success' };
        const result = await storage.createImmutable({ ...key, value });
        assert.equal(result.recordType, 'immutable');
        const registryCalls = shims.registryRenames();
        assert.ok(registryCalls.length >= 1, 'the registry rename hook must be reached');
        for (const call of registryCalls) {
          assert.equal(call.refused, false);
        }
        const firstStage = registryCalls[0].from;
        assert.equal(registryCalls.filter((c) => c.from === firstStage).length, 1);
        assert.deepEqual(shims.delays, []);
        assert.deepEqual(await storage.read(key), value);
        const envelope = JSON.parse(
          await real.readFile(path.join(root, key.relativePath), 'utf8'),
        );
        assert.equal(envelope.id, key.id);
        assert.deepEqual(envelope.value, value);
        assert.equal(envelope.digest, result.digest);
        assert.deepEqual(await collectTmpLeftovers(root), []);
      });
    } finally {
      await removeTree(root);
    }
  }));

  // 2. For each transient code: refuse the first two calls of the FIRST stage,
  //    then release — exactly three attempts on that stage, delays [20,40],
  //    identical stage path and bytes, and a successful readback.
  for (const transientCode of ['EPERM', 'EACCES', 'EBUSY']) {
    it(`retries ${transientCode} refusals of the first registry stage to exactly three attempts`, () => serial(async () => {
      assertWin32Host();
      const root = await makeRoot(`transient-${transientCode}`);
      try {
        await seedRegistry(root);
        let firstStage;
        let seenOnFirstStage = 0;
        await activeShims({
          registryRenameMode(record) {
            const stage = record.from;
            if (firstStage === undefined) {
              firstStage = stage;
            }
            if (stage === firstStage) {
              seenOnFirstStage += 1;
              if (seenOnFirstStage <= 2) {
                const injected = new Error(`injected ${transientCode} on registry stage rename`);
                injected.code = transientCode;
                return injected;
              }
            }
            return DELEGATE;
          },
        }, async (shims) => {
          const storage = await createStorage({ root });
          const key = {
            relativePath: 'records/transient.json',
            kind: 'rec',
            id: `retry-${transientCode.toLowerCase()}`,
          };
          const value = { note: `registry-retry-${transientCode}` };
          await storage.createImmutable({ ...key, value });
          const registryCalls = shims.registryRenames();
          assert.ok(firstStage !== undefined, 'a registry stage rename must be observed');
          assertRegistryStageName(firstStage);
          const stageCalls = registryCalls.filter((c) => c.from === firstStage);
          assert.equal(stageCalls.length, 3);
          assert.equal(shims.refusedRegistryRenames().length, 2);
          for (const call of stageCalls) {
            assert.equal(call.to, stageCalls[0].to);
            assert.ok(call.bytes, 'the shim must observe the stage bytes');
            assert.ok(call.bytes.equals(stageCalls[0].bytes));
          }
          assert.deepEqual(shims.delays, [20, 40]);
          assert.deepEqual(await storage.read(key), value);
          const envelope = JSON.parse(
            await real.readFile(path.join(root, key.relativePath), 'utf8'),
          );
          assert.deepEqual(envelope.value, value);
          assert.match(String(envelope.digest), /^[a-f0-9]{64}$/);
        });
      } finally {
        await removeTree(root);
      }
    }));
  }

  // 3. Permanent refusal with fresh Error objects per attempt: eight calls,
  //    the exact seven-delay array, a stable error class/code, .cause bound to
  //    the first injected error (object identity), no final target before the
  //    reservation, a released root lock, and only the proven-owned stage
  //    cleaned.
  it('exhausts at eight attempts under permanent transient-class refusal and attaches the first error as cause', () => serial(async () => {
    assertWin32Host();
    const root = await makeRoot('exhaust');
    try {
      const registryFile = await seedRegistry(root);
      const injectedErrors = [];
      let failure;
      await activeShims({
        registryRenameMode() {
          const injected = new Error('injected permanent EPERM on registry stage rename');
          injected.code = 'EPERM';
          injectedErrors.push(injected);
          return injected;
        },
      }, async (shims) => {
        const storage = await createStorage({ root });
        const key = { relativePath: 'records/exhausted.json', kind: 'rec', id: 'retry-exhausted' };
        failure = await captureRefusal(
          storage.createImmutable({ ...key, value: { note: 'never-published' } }),
          'ERR_STORAGE_REGISTRY_UNAVAILABLE',
        );
        const registryCalls = shims.registryRenames();
        assert.equal(shims.refusedRegistryRenames().length, 8);
        assert.equal(registryCalls.length, 8);
        assertRegistryStageName(registryCalls[0].from);
        const stages = new Set(registryCalls.map((c) => c.from));
        assert.equal(stages.size, 1);
        for (const call of registryCalls) {
          assert.ok(call.bytes, 'the shim must observe the stage bytes');
          assert.ok(call.bytes.equals(registryCalls[0].bytes));
        }
        assert.deepEqual(shims.delays, fullDelaySequence);
        assert.equal(injectedErrors.length, 8);
        for (const injected of injectedErrors) {
          assert.equal(injected.name, 'Error');
          assert.equal(injected.code, 'EPERM');
        }
        for (let i = 1; i < injectedErrors.length; i += 1) {
          assert.notStrictEqual(injectedErrors[i], injectedErrors[i - 1]);
        }
        assert.strictEqual(failure.cause, injectedErrors[0]);
        // No final target: nothing exists at the requested record path.
        assert.deepEqual(
          (await listFiles(root)).filter((f) => f.relativePath === key.relativePath),
          [],
        );
        // Pre-publication exhaustion publishes no final record: the registry
        // file still holds exactly the seeded bytes (no reservation landed).
        assert.ok((await readBytes(registryFile)).equals(seededRegistryBytes));
        assert.equal(
          Object.keys(await readRegistryRecords(registryFile)).length,
          0,
          'no reservation may land in the registry map before publication',
        );
        // Only the proven-owned stage remains cleaned: no .tmp left behind.
        assert.deepEqual(await collectTmpLeftovers(root), []);
      });
      // Root lock released: a later operation on the same root completes.
      const followup = await createStorage({ root });
      const followKey = {
        relativePath: 'records/after-exhaustion.json',
        kind: 'rec',
        id: 'retry-followup',
      };
      const followResult = await followup.createImmutable({
        ...followKey,
        value: { note: 'lock-released-proof' },
      });
      assert.equal(followResult.recordType, 'immutable');
      assert.equal(failure.code, 'ERR_STORAGE_REGISTRY_UNAVAILABLE');
    } finally {
      await removeTree(root);
    }
  }));

  // 4. Each non-transient code: one call, zero delays, cause bound to the
  //    injected error, no final target. EPERM on a simulated linux host
  //    behaves the same way.
  for (const nonTransientCode of ['ENOSPC', 'EXDEV', 'ENOENT', 'EIO']) {
    it(`refuses non-transient ${nonTransientCode} immediately with that error as cause`, () => serial(async () => {
      assertWin32Host();
      const root = await makeRoot(`nontemp-${nonTransientCode}`);
      try {
        const registryFile = await seedRegistry(root);
        const injectedErrors = [];
        await activeShims({
          registryRenameMode() {
            const injected = new Error(`injected ${nonTransientCode} on registry stage rename`);
            injected.code = nonTransientCode;
            injectedErrors.push(injected);
            return injected;
          },
        }, async (shims) => {
          const storage = await createStorage({ root });
          const key = {
            relativePath: `records/nontemp-${nonTransientCode}.json`,
            kind: 'rec',
            id: `retry-${nonTransientCode.toLowerCase()}`,
          };
          const failure = await captureRefusal(
            storage.createImmutable({ ...key, value: { note: `never-${nonTransientCode}` } }),
            'ERR_STORAGE_REGISTRY_UNAVAILABLE',
          );
          assert.equal(shims.refusedRegistryRenames().length, 1);
          assert.equal(shims.registryRenames().length, 1);
          assert.deepEqual(shims.delays, []);
          assert.equal(injectedErrors.length, 1);
          assert.strictEqual(failure.cause, injectedErrors[0]);
          assert.deepEqual(
            (await listFiles(root)).filter((f) => f.relativePath === key.relativePath),
            [],
          );
          assert.ok((await readBytes(registryFile)).equals(seededRegistryBytes));
        });
      } finally {
        await removeTree(root);
      }
    }));
  }

  it('refuses EPERM immediately on a simulated linux platform (scoped descriptor fixture)', () => serial(async () => {
    assertWin32Host();
    const root = await makeRoot('nontemp-linux');
    try {
      const registryFile = await seedRegistry(root);
      const injectedErrors = [];
      try {
        await activeShims({
          registryRenameMode() {
            const injected = new Error('injected EPERM on registry stage rename (simulated linux)');
            injected.code = 'EPERM';
            injectedErrors.push(injected);
            return injected;
          },
          // The shim applies this platform value at the moment it refuses the
          // targeted registry rename, after root setup.
          platformOnRegistryRefusal: 'linux',
        }, async (shims) => {
          const storage = await createStorage({ root });
          const key = { relativePath: 'records/linux-refusal.json', kind: 'rec', id: 'retry-linux' };
          const failure = await captureRefusal(
            storage.createImmutable({ ...key, value: { note: 'never-linux' } }),
            'ERR_STORAGE_REGISTRY_UNAVAILABLE',
          );
          assert.equal(shims.refusedRegistryRenames().length, 1);
          assert.equal(shims.registryRenames().length, 1);
          assert.deepEqual(shims.delays, []);
          assert.equal(injectedErrors.length, 1);
          assert.strictEqual(failure.cause, injectedErrors[0]);
          assert.deepEqual(
            (await listFiles(root)).filter((f) => f.relativePath === key.relativePath),
            [],
          );
          assert.ok((await readBytes(registryFile)).equals(seededRegistryBytes));
        });
      } finally {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }
      assert.equal(process.platform, 'win32');
    } finally {
      await removeTree(root);
    }
  }));

  // 5. Refuse registry renames only AFTER the beforeRegister hook fires:
  //    eight attempts, then failure. The immutable target still exists with
  //    the correct envelope and value, and the registry keeps the pending:true
  //    reservation. With injection disabled, an identical createImmutable
  //    reports recovered:true over the same target bytes and completes the
  //    immutable registration.
  it('retains the published record and pending reservation when post-publication registry renames exhaust, then recovers identically', () => serial(async () => {
    assertWin32Host();
    const root = await makeRoot('post-publish');
    try {
      const registryFile = await seedRegistry(root);
      const key = { relativePath: 'records/post-published.json', kind: 'rec', id: 'retry-post' };
      const value = { note: 'registry-retry-post-publication' };
      const targetFile = path.join(root, key.relativePath);
      let hookFirings = 0;
      let hookFired = false;
      let failure;
      await activeShims({
        registryRenameMode() {
          if (hookFired) {
            const injected = new Error('injected permanent EPERM on registration registry rename');
            injected.code = 'EPERM';
            return injected;
          }
          return DELEGATE;
        },
      }, async (shims) => {
        const storage = await createStorage({
          root,
          hooks: {
            async beforeRegister() {
              hookFirings += 1;
              hookFired = true;
            },
          },
        });
        failure = await captureRefusal(
          storage.createImmutable({ ...key, value }),
          'ERR_STORAGE_REGISTRY_UNAVAILABLE',
        );
        assert.equal(hookFirings, 1);
        assert.equal(shims.refusedRegistryRenames().length, 8);
        const registryCalls = shims.registryRenames();
        assert.equal(registryCalls.length, 9);
        // The single pre-hook (reservation) rename succeeded; the eight
        // refused registration renames all reuse one post-hook stage path.
        const postHookStages = new Set(shims.refusedRegistryRenames().map((c) => c.from));
        assert.equal(postHookStages.size, 1);
        const postHookStage = [...postHookStages][0];
        assert.notEqual(registryCalls[0].from, postHookStage);
        assert.equal(registryCalls[0].refused, false);
        assertRegistryStageName(postHookStage);
        assert.deepEqual(shims.delays, fullDelaySequence);
        assert.equal(failure.code, 'ERR_STORAGE_REGISTRY_UNAVAILABLE');
        // Post-publication exhaustion retains the immutable record: the
        // target survives with the correct envelope and value.
        const envelope = JSON.parse(await real.readFile(targetFile, 'utf8'));
        assert.equal(envelope.id, key.id);
        assert.deepEqual(envelope.value, value);
        assert.match(String(envelope.digest), /^[a-f0-9]{64}$/);
        // The registry retains the pending reservation for this identity at
        // its exact kind/id map key.
        const reservation = (await readRegistryRecords(registryFile))[registryKeyOf(key.kind, key.id)];
        assert.ok(reservation, 'the registry must keep the interrupted publication reserved');
        assert.ok(!('id' in reservation), 'identity lives in the map key, not a record.id field');
        assert.equal(reservation.relativePath, key.relativePath);
        assert.equal(reservation.pending, true);
        assert.equal(reservation.recordType, 'immutable');
        assert.match(String(reservation.digest), /^[a-f0-9]{64}$/);
      });
      // Injection is disabled here (outside activeShims). Identical-bytes
      // recovery completes the registration unchanged.
      const bytesAfterFailure = await readBytes(targetFile);
      const second = await createStorage({ root });
      const recovered = await second.createImmutable({ ...key, value });
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.recordType, 'immutable');
      assert.ok((await readBytes(targetFile)).equals(bytesAfterFailure));
      const finalRecord = (await readRegistryRecords(registryFile))[registryKeyOf(key.kind, key.id)];
      assert.ok(finalRecord, 'the registry must hold the final record after recovery');
      assert.equal(finalRecord.relativePath, key.relativePath);
      assert.notEqual(finalRecord.pending, true);
      assert.equal(finalRecord.recordType, 'immutable');
      assert.deepEqual(await second.read(key), value);
    } finally {
      await removeTree(root);
    }
  }));

  // 6. Throw EPERM on an ordinary mutable record TARGET rename (not
  //    registry.json): the policy does not retry it. One target rename, no
  //    retry delays attributable to it, and the standard target-publication
  //    error mapping is unchanged (a StorageError whose code is not the
  //    registry-unavailable code).
  it('does not retry an EPERM on an ordinary mutable target rename', () => serial(async () => {
    assertWin32Host();
    const root = await makeRoot('target-rename');
    try {
      await seedRegistry(root);
      const key = { relativePath: 'records/mutable-target.json', kind: 'rec', id: 'retry-target' };
      const targetBasename = path.basename(key.relativePath);
      const injectedErrors = [];
      await activeShims({
        targetRenameMode(record) {
          if (path.basename(record.to) === targetBasename) {
            const injected = new Error('injected EPERM on ordinary target rename');
            injected.code = 'EPERM';
            injectedErrors.push(injected);
            return injected;
          }
          return undefined;
        },
      }, async (shims) => {
        const storage = await createStorage({ root });
        const failure = await captureRefusal(
          storage.replaceMutable({ ...key, value: { note: 'target-rename-refused' } }),
          'ERR_STORAGE_PUBLISH_UNSUPPORTED',
        );
        const targetCalls = shims.renames.filter(
          (r) => !r.registry && path.basename(r.to) === targetBasename,
        );
        assert.equal(targetCalls.length, 1);
        assert.equal(injectedErrors.length, 1);
        assert.deepEqual(shims.delays, []);
        assert.ok(
          shims.registryRenames().length >= 1,
          'the registry rename hook must be reached (policy must not have touched the registry)',
        );
        for (const registryCall of shims.registryRenames()) {
          assert.equal(registryCall.refused, false);
        }
        assert.ok(failure.code.startsWith('ERR_STORAGE_'));
        assert.deepEqual(
          (await listFiles(root)).filter((f) => f.relativePath === key.relativePath),
          [],
        );
      });
    } finally {
      await removeTree(root);
    }
  }));
});
