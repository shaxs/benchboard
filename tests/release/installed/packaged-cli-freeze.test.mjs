/**
 * Independent nested synthetic tooling immutability acceptance (task packet C7a.S7.T4).
 *
 * One case: the synthetic installed tooling record is deeply frozen, attempted
 * mutations throw TypeError in strict ES module mode, the record is unchanged
 * afterwards, and an independently prepared reload re-derives the same identity.
 *
 * The record is derived from verified bytes only; nothing here claims publisher
 * authenticity or any external-run write. The Captain owns the loader hardening
 * and the prepared fixture; this file calls only the documented fixture surface.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { syntheticCliFixture } from './packaged-cli-fixture.mjs';

/* Every object or array reachable from the value must be frozen; cycles guarded. */
function assertAllFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.ok(Object.isFrozen(value), 'every nested object/array of the tooling record is frozen');
  for (const child of Object.values(value)) assertAllFrozen(child, seen);
}

describe('synthetic relocated installation — the tooling record is deeply frozen and reload-stable', () => {
  test('nested provenance freezes block mutation attempts, the record is unchanged, and a fresh load re-derives the same identity', async () => {
    const first = syntheticCliFixture();
    let savedClone;
    let savedDigest;
    try {
      const installed = await first.load();
      const tooling = installed.toolingIdentity;
      assert.equal(tooling.toolingComponent, 'synthetic-package-cli');
      assert.deepEqual(tooling.digestProvenance, {
        kind: 'COMPUTED',
        procedure: 'Verified synthetic installed assets and pinned descriptor',
      });
      assertAllFrozen(tooling);

      savedDigest = tooling.identityDigest;
      savedClone = structuredClone(tooling);

      /* ES modules are strict, so a write to a frozen property must throw TypeError. */
      assert.throws(() => { tooling.digestProvenance.procedure = 'changed'; }, TypeError);
      assert.throws(() => { tooling.digestProvenance.kind = 'DECLARED'; }, TypeError);
      assert.throws(() => { tooling.revision = 'tampered'; }, TypeError);

      assert.deepEqual(tooling, savedClone);
      assert.equal(tooling.identityDigest, savedDigest);
    } finally {
      first.cleanup();
    }

    const second = syntheticCliFixture();
    try {
      const again = (await second.load()).toolingIdentity;
      assert.deepEqual(again, savedClone);
      assert.equal(again.identityDigest, savedDigest);
    } finally {
      second.cleanup();
    }
  });
});
