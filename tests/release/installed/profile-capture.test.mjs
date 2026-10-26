/** C7a.S1.T4 — Capture tests: caller-controlled getters/traps cannot re-authorize metadata.
 *  Cooperative in-process input-capture tests, not a sandbox for arbitrary Proxy code. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReleaseProfile, ReleaseProfileError } from '../../../release/profiles.mjs';

const ZERO64 = '0'.repeat(64);

/** The decided valid synthetic fixture, as a fresh in-memory copy. */
function fixture() {
  return {
    schemaVersion: '1.0.0',
    kind: 'ReleaseProfile',
    profile: 'synthetic',
    authorization: 'synthetic-only',
    entries: [{ path: 'lib/a.mjs', source: 'assets/a.mjs', bytes: 0, sha256: ZERO64 }],
  };
}

/** Predicate asserting the exact ReleaseProfileError instance carrying the stable code. */
const releaseError = (code) => (error) =>
  error instanceof ReleaseProfileError && error.code === code;

test('case 1: a root get-trap proxy never runs and later caller edits cannot promote the profile', () => {
  const base = fixture();
  let getCalls = 0;
  const proxied = new Proxy(base, {
    get() {
      getCalls += 1;
      throw new Error('root get trap executed');
    },
  });

  const result = validateReleaseProfile(proxied);

  assert.equal(getCalls, 0);
  assert.equal(result.profile, 'synthetic');
  assert.equal(result.authorization, 'synthetic-only');
  assert.equal(result.entries[0].path, 'lib/a.mjs');
  assert.equal(result.entries[0].sha256, ZERO64);

  base.profile = 'owner-development';
  base.authorization = 'blocked';
  assert.equal(result.profile, 'synthetic');
  assert.equal(result.authorization, 'synthetic-only');
});

test('case 2: entry and entries array behind get-trap proxies capture identically, zero gets, frozen and detached output', () => {
  const entryBase = fixture();
  let entryGets = 0;
  const entryProxy = new Proxy(entryBase.entries[0], {
    get() {
      entryGets += 1;
      throw new Error('entry get trap executed');
    },
  });
  const entryResult = validateReleaseProfile({ ...entryBase, entries: [entryProxy] });
  assert.equal(entryGets, 0);
  assert.equal(entryResult.authorization, 'synthetic-only');
  assert.equal(entryResult.entries[0].path, 'lib/a.mjs');
  assert.equal(entryResult.entries[0].sha256, ZERO64);
  assert.ok(Object.isFrozen(entryResult));
  assert.ok(Object.isFrozen(entryResult.entries));
  assert.ok(Object.isFrozen(entryResult.entries[0]));
  assert.notEqual(entryResult.entries[0], entryProxy);

  const arrayBase = fixture();
  let arrayGets = 0;
  const arrayProxy = new Proxy(arrayBase.entries, {
    get() {
      arrayGets += 1;
      throw new Error('entries get trap executed');
    },
  });
  const arrayResult = validateReleaseProfile({ ...arrayBase, entries: arrayProxy });
  assert.equal(arrayGets, 0);
  assert.equal(arrayResult.entries[0].path, 'lib/a.mjs');
  assert.ok(Object.isFrozen(arrayResult.entries));
  assert.ok(Object.isFrozen(arrayResult.entries[0]));
  assert.notEqual(arrayResult.entries, arrayProxy);
  assert.notEqual(arrayResult.entries[0], arrayBase.entries[0]);
});

test('case 3: throwing snapshot traps refuse with the exact profile and entry codes', () => {
  const boom = new Error('snapshot trap executed');
  const noKeys = new Proxy(fixture(), {
    ownKeys() {
      throw boom;
    },
  });
  assert.throws(() => validateReleaseProfile(noKeys), releaseError('RELEASE_PROFILE_INVALID'));

  const noDescriptors = new Proxy(fixture(), {
    getOwnPropertyDescriptor() {
      throw boom;
    },
  });
  assert.throws(
    () => validateReleaseProfile(noDescriptors),
    releaseError('RELEASE_PROFILE_INVALID'),
  );

  const base = fixture();
  const noArrayDescriptors = new Proxy(base.entries, {
    getOwnPropertyDescriptor() {
      throw boom;
    },
  });
  assert.throws(
    () => validateReleaseProfile({ ...base, entries: noArrayDescriptors }),
    releaseError('RELEASE_ENTRY_INVALID'),
  );
});

test('case 4: an entry path accessor is refused without executing its getter', () => {
  let accessorCalls = 0;
  const entry = {
    get path() {
      accessorCalls += 1;
      throw new Error('path accessor getter executed');
    },
    source: 'assets/a.mjs',
    bytes: 0,
    sha256: ZERO64,
  };
  const base = fixture();

  assert.throws(
    () => validateReleaseProfile({ ...base, entries: [entry] }),
    releaseError('RELEASE_ENTRY_INVALID'),
  );
  assert.equal(accessorCalls, 0);
});
