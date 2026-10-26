/**
 * C7a.S11.T8 — Lock receipt captured at acquisition, verified before the first registry rename.
 *
 * Public-API acceptance only: the exclusive lock (root/.storage/lock) is held when beforeStage
 * runs, and the policy must bind to the ORIGINAL lock captured AT ACQUISITION. A replacement at
 * the same pathname carrying identical bytes but a different inode is foreign, and changed
 * original-lock bytes are likewise uncertain — both refuse with ERR_STORAGE_REGISTRY_UNAVAILABLE
 * (an Error cause) before immutable bytes or a pending registry reservation are published, with
 * no unlinking of the foreign lock on refusal.
 *
 * Scratch: a fresh random mkdtemp root under tests/contracts/.tmp/registry-lock-receipt per test;
 * the finally clause removes ONLY that fresh root, never the shared parent.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lstat as lstatAsync,
  mkdir as mkdirAsync,
  mkdtemp,
  readFile as readFileAsync,
  rename as renameAsync,
  rm as rmAsync,
  writeFile as writeFileAsync,
} from 'node:fs/promises';
import { createStorage, StorageError } from '../../packages/core/storage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratchBase = path.join(here, '.tmp', 'registry-lock-receipt');

/** Seed registry written directly before storage is created: empty records, schema version 1. */
const SEED_REGISTRY_BYTES = Buffer.from('{"schemaVersion":1,"records":{}}', 'utf8');

/**
 * The identity tuple a receipt must bind: device, inode and birth time in nanoseconds, as
 * bigints from one lstat call. Two tuples are equal only when all three components are.
 */
function identityOf(stat) {
  return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
}

function identitiesMatch(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

/** Read lock bytes plus its bigint lstat identity from one snapshot of state. */
async function readLockSnapshot(lockPath) {
  const [bytes, stat] = await Promise.all([
    readFileAsync(lockPath),
    lstatAsync(lockPath, { bigint: true }),
  ]);
  return { bytes, identity: identityOf(stat) };
}

const PAYLOAD = Object.freeze({
  relativePath: 'records/proof.json',
  kind: 'r.report',
  id: 'proof',
  value: Object.freeze({ ok: true }),
});

async function seedStorageRoot(root) {
  await mkdirAsync(path.join(root, '.storage'), { recursive: true });
  await writeFileAsync(path.join(root, '.storage/registry.json'), SEED_REGISTRY_BYTES);
}

/** Verify the shared post-refusal facts: seed registry intact, nothing published. */
async function assertNothingPublished(root) {
  const registryBytes = await readFileAsync(path.join(root, '.storage/registry.json'));
  assert.deepEqual(registryBytes, SEED_REGISTRY_BYTES, 'seed registry bytes are unchanged');
  assert.equal(
    await readFileAsync(path.join(root, 'records/proof.json')).then(
      () => null,
      (error) => error.code,
    ),
    'ENOENT',
    'no immutable bytes were published at the final target',
  );
}

/**
 * Assert the precise storage refusal: StorageError carrying ERR_STORAGE_REGISTRY_UNAVAILABLE
 * and an Error cause — not merely any error.
 */
async function assertRefused(promise) {
  await assert.rejects(
    promise,
    (error) => {
      assert.ok(error instanceof StorageError, `refusal is a StorageError, got ${error?.constructor?.name}`);
      assert.equal(
        error.code,
        'ERR_STORAGE_REGISTRY_UNAVAILABLE',
        `expected ERR_STORAGE_REGISTRY_UNAVAILABLE, got ${error.code}`,
      );
      assert.ok(error.cause instanceof Error, 'refusal carries an Error cause');
      return true;
    },
    'createImmutable refuses the uncertain lock receipt',
  );
}

describe('original lock receipt before the first registry rename', () => {
  const createdRoots = [];

  async function freshRoot(label) {
    const root = await mkdtemp(path.join(scratchBase, `${label}-`));
    createdRoots.push(root);
    return root;
  }

  before(async () => {
    await mkdirAsync(scratchBase, { recursive: true });
  });

  after(async () => {
    // Remove each owned fresh root only — never the shared scratch parent.
    for (const root of createdRoots) {
      await rmAsync(root, { recursive: true, force: true });
    }
  });

  it('refuses a same-bytes replacement lock whose inode differs from the acquired one', async () => {
    const root = await freshRoot('replaced');
    await seedStorageRoot(root);
    const lockPath = path.join(root, '.storage/lock');
    const backupPath = path.join(root, '.storage/lock.acquired-backup');

    let acquired = null;
    let replacement = null;
    let hookCalls = 0;

    const storage = createStorage({
      root,
      hooks: {
        beforeStage: async () => {
          hookCalls += 1;
          // The original exclusive lock is held here, before any publication.
          acquired = await readLockSnapshot(lockPath);

          // Move the acquired lock aside to a fresh backup path under the same owned root,
          // then write its exact bytes to a NEWLY CREATED lock at the original pathname.
          await renameAsync(lockPath, backupPath);
          await writeFileAsync(lockPath, acquired.bytes);
          replacement = await readLockSnapshot(lockPath);

          assert.ok(!identitiesMatch(acquired.identity, replacement.identity),
            'the replacement lock must differ from the acquired one in dev/ino/birthtimeNs');
          assert.deepEqual(replacement.bytes, acquired.bytes,
            'the replacement carries identical bytes, differing only in inode identity');
        },
      },
    });

    await assertRefused(storage.createImmutable(PAYLOAD));

    assert.equal(hookCalls, 1, 'beforeStage ran exactly once; refusal precedes any retry');

    await assertNothingPublished(root);

    // The acquired lock is preserved unchanged at the backup path — not unlinked, not repaired.
    const backup = await readLockSnapshot(backupPath);
    assert.deepEqual(backup.bytes, acquired.bytes, 'preserved backup keeps the original lock bytes');
    assert.ok(identitiesMatch(backup.identity, acquired.identity),
      'the backup holds the original inode identity that the receipt was bound to');

    // The same-bytes replacement at the original pathname survives the refusal untouched.
    const after = await readLockSnapshot(lockPath);
    assert.deepEqual(after.bytes, acquired.bytes, 'replacement lock bytes are unchanged after refusal');
    assert.ok(identitiesMatch(after.identity, replacement.identity),
      'replacement lock keeps its distinct current identity after refusal');
    assert.ok(!identitiesMatch(after.identity, acquired.identity),
      'the original and replacement identities remain distinct after refusal');
  });

  it('refuses when the acquired lock bytes are changed in place at the same inode', async () => {
    const root = await freshRoot('changed');
    await seedStorageRoot(root);
    const lockPath = path.join(root, '.storage/lock');
    const FOREIGN_BYTES = Buffer.from('{"foreign":true}', 'utf8');

    let acquired = null;
    let overwritten = null;
    let hookCalls = 0;

    const storage = createStorage({
      root,
      hooks: {
        beforeStage: async () => {
          hookCalls += 1;
          // Snapshot the original identity and bytes first.
          acquired = await readLockSnapshot(lockPath);

          // Overwrite the acquired lock in place with a different ordinary valid JSON document.
          await writeFileAsync(lockPath, FOREIGN_BYTES);
          overwritten = await readLockSnapshot(lockPath);

          assert.ok(identitiesMatch(overwritten.identity, acquired.identity),
            'the in-place overwrite keeps the same dev/ino/birthtimeNs identity');
          assert.notDeepEqual(overwritten.bytes, acquired.bytes,
            'the lock bytes differ from the ones captured at acquisition');
          assert.deepEqual(overwritten.bytes, FOREIGN_BYTES, 'the changed bytes are the foreign document');
        },
      },
    });

    await assertRefused(storage.createImmutable(PAYLOAD));

    assert.equal(hookCalls, 1, 'beforeStage ran exactly once; refusal precedes any retry');

    await assertNothingPublished(root);

    // No byte-repair: the changed lock and its identity are exactly as the hook left them.
    const after = await readLockSnapshot(lockPath);
    assert.deepEqual(after.bytes, FOREIGN_BYTES, 'changed lock bytes remain untouched after refusal');
    assert.ok(identitiesMatch(after.identity, overwritten.identity),
      'changed lock keeps the identity the hook observed after the overwrite');
    assert.ok(identitiesMatch(after.identity, acquired.identity),
      'the same-inode overwrite left the acquired identity itself unchanged');
  });
});
