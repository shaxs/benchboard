// C7a.S1.T2 — Independent release-profile security acceptance (installed contract).
//
// Exercises the decided public seam of release/profiles.mjs — RELEASE_PROFILE_STATES,
// ReleaseProfileError, validateReleaseProfile, createParticipantProfile — plus the published
// JSON Schema and the read-only C0 inventory. No implementation internals are read, no source
// files are inspected, and every fixture below is local memory only. The structural schema layer
// and the runtime policy layer are asserted separately (group 7). This file claims no release,
// no license and makes no filesystem writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  RELEASE_PROFILE_STATES,
  ReleaseProfileError,
  validateReleaseProfile,
  createParticipantProfile,
} from '../../../release/profiles.mjs';

const REPO_ROOT = new URL('../../../', import.meta.url);
const inventory = JSON.parse(readFileSync(fileURLToPath(new URL('release/inventory.json', REPO_ROOT)), 'utf8'));
const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

// The decided synthetic fixture. Its source path exists nowhere; this validator is metadata-only.
const fixture = () => ({
  schemaVersion: '1.0.0',
  kind: 'ReleaseProfile',
  profile: 'synthetic',
  authorization: 'synthetic-only',
  entries: [{ path: 'lib/tool.mjs', bytes: 0, sha256: EMPTY_SHA256, source: 'assets/tool.mjs' }],
});
const clone = (value) => structuredClone(value);
const entry = (path, source = 'assets/tool.mjs') => ({ path, bytes: 0, sha256: EMPTY_SHA256, source });

function expectRefused(profile, code) {
  assert.throws(
    () => validateReleaseProfile(profile),
    (error) => {
      assert.ok(error instanceof ReleaseProfileError, 'refusals are ReleaseProfileError instances');
      assert.equal(error.code, code);
      return true;
    },
    `expected ReleaseProfileError with exact code ${code}`,
  );
}
function expectAccepted(profile) {
  const result = validateReleaseProfile(profile);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.entries) && result.entries.every(Object.isFrozen));
  const paths = result.entries.map((entry) => entry.path);
  assert.deepEqual(paths, [...paths].sort(), 'returned metadata is sorted by output path');
  return result;
}

// ---------------------------------------------------------------------------
// Group 1 — canonical participant factory: C0 bindings, deep freeze, sorting
// ---------------------------------------------------------------------------

test('1 — canonical factory: exact C0 bindings, 26 entries, state map, deep freeze, sorted detached result', () => {
  const profile = createParticipantProfile();
  assert.deepEqual(RELEASE_PROFILE_STATES, {
    participant: 'participant-only',
    'owner-development': 'private-only',
    'end-user-tooling': 'blocked',
    synthetic: 'synthetic-only',
  });
  assert.deepEqual(profile.entries.map((e) => [e.path, e.bytes, e.sha256, e.source]),
    inventory.participant.files.map((f) => [f.path, f.bytes, f.sha256, `starter/${f.path}`]));
  assert.equal(profile.entries.length, 26);

  assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.entries) && profile.entries.every(Object.isFrozen));
  const again = createParticipantProfile();
  assert.notEqual(profile, again, 'every call returns a detached value');
  assert.deepEqual(profile, again);

  const result = expectAccepted(profile);
  assert.notEqual(result, profile, 'the validator returns detached metadata');
  assert.notEqual(result.entries, profile.entries, 'the entry list is detached as well');
  const paths = result.entries.map((e) => e.path);
  assert.deepEqual(paths, [...paths].sort(), 'entries leave the validator sorted by code units');

  // Caller mutation after validation cannot change the returned value (frozen result, detached).
  const mutable = clone(profile);
  const frozen = expectAccepted(mutable);
  mutable.entries.push({ path: 'zz.txt', bytes: 0, sha256: EMPTY_SHA256, source: 'assets/zz.txt' });
  assert.equal(frozen.entries.length, 26);

  // Metadata-only proof: an unsorted synthetic profile with declared bytes that match no existing
  // source still validates, and its output is sorted by UTF-16 code units.
  const unsorted = { ...fixture(), entries: [
    entry('zeta/z.mjs', 'assets/nope-z.mjs'),
    entry('alpha/a.mjs', 'assets/nope-a.mjs'),
    { path: 'Mid/M.txt', bytes: 12345, sha256: EMPTY_SHA256, source: 'assets/nope-m.mjs' },
  ] };
  const out = expectAccepted(unsorted);
  assert.deepEqual(out.entries.map((e) => e.path), ['Mid/M.txt', 'alpha/a.mjs', 'zeta/z.mjs']);
  assert.deepEqual(out.entries.map((e) => e.bytes), [12345, 0, 0]);
});

// ---------------------------------------------------------------------------
// Group 2 — profile envelope and authorization policy
// ---------------------------------------------------------------------------

test('2 — envelope refusals and authorization blocks carry exact codes', () => {
  const cases = [
    ['unknown schemaVersion', () => ({ ...fixture(), schemaVersion: '2.0.0' }), 'RELEASE_PROFILE_INVALID'],
    ['unknown kind', () => ({ ...fixture(), kind: 'ReleaseManifest' }), 'RELEASE_PROFILE_INVALID'],
    ['null top level', () => null, 'RELEASE_PROFILE_INVALID'],
    ['array top level', () => [], 'RELEASE_PROFILE_INVALID'],
    ['extra top-level field', () => ({ ...fixture(), extra: 1 }), 'RELEASE_PROFILE_INVALID'],
    ['unknown profile', () => ({ ...fixture(), profile: 'administrator' }), 'RELEASE_PROFILE_UNKNOWN'],
    ['__proto__ profile', () => ({ ...fixture(), profile: '__proto__' }), 'RELEASE_PROFILE_UNKNOWN'],
    ['wrong declared authorization', () => ({ ...fixture(), profile: 'participant', authorization: 'blocked' }), 'RELEASE_PROFILE_BLOCKED'],
    ['private owner profile', () => ({ ...fixture(), profile: 'owner-development', authorization: 'private-only' }), 'RELEASE_PROFILE_BLOCKED'],
    ['end-user profile', () => ({ ...fixture(), profile: 'end-user-tooling', authorization: 'blocked' }), 'RELEASE_PROFILE_BLOCKED'],
    // A caller-asserted license flag is an unknown top-level field and promotes nothing.
    ['licenseApproved extra field', () => ({ ...fixture(), licenseApproved: true }), 'RELEASE_PROFILE_INVALID'],
  ];
  for (const [, make, code] of cases) {
    expectRefused(make(), code);
  }

  // A class instance carrying the same data fields is not a plain JSON object.
  class NonPlain {
    constructor(fields) { Object.assign(this, fields); }
  }
  expectRefused(new NonPlain(fixture()), 'RELEASE_PROFILE_INVALID');

  // A root-level accessor field is refused without its getter ever being executed.
  let getterCalls = 0;
  const withAccessors = fixture();
  Object.defineProperty(withAccessors, 'sneaky', {
    enumerable: true, configurable: true, get() { getterCalls += 1; return 'x'; },
  });
  expectRefused(withAccessors, 'RELEASE_PROFILE_INVALID');
  assert.equal(getterCalls, 0, 'the getter must not be invoked');
});

// ---------------------------------------------------------------------------
// Group 3 — participant tampering against the canonical 26
// ---------------------------------------------------------------------------

test('3 — participant removals, additions and altered bindings are refused with the exact mismatch code', () => {
  const tamper = (mutate) => {
    const profile = clone(createParticipantProfile());
    mutate(profile);
    expectRefused(profile, 'RELEASE_PARTICIPANT_MISMATCH');
  };
  const indexOf = (path) => {
    const i = createParticipantProfile().entries.findIndex((e) => e.path === path);
    assert.ok(i >= 0, `fixture path ${path} exists in the canonical profile`);
    return i;
  };
  const i = indexOf('src/App.tsx');
  tamper((p) => p.entries.splice(i, 1));
  tamper((p) => p.entries.push(entry('extra/notes.txt', 'assets/notes.txt')));
  tamper((p) => { p.entries[i] = { ...p.entries[i], bytes: p.entries[i].bytes + 1 }; });
  tamper((p) => { p.entries[i] = { ...p.entries[i], sha256: 'f'.repeat(64) }; });
  tamper((p) => { p.entries[i] = { ...p.entries[i], source: 'starter/other.tsx' }; });
  // Recognized tooling generator in place of the canonical package.json, with its original
  // declared size/hash: still a participant mismatch, and no fixture on disk is touched.
  tamper((p) => {
    const j = indexOf('package.json');
    p.entries[j] = { path: 'package.json', bytes: p.entries[j].bytes, sha256: p.entries[j].sha256, generated: 'tooling-package-v1' };
  });
});

// ---------------------------------------------------------------------------
// Group 4 — output and source collisions
// ---------------------------------------------------------------------------

test('4 — duplicate, case-folded, prefix-colliding and shared-source paths are refused', () => {
  const collide = (label, entries) => {
    const profile = { ...fixture(), entries };
    expectRefused(profile, 'RELEASE_PATH_COLLISION');
  };
  collide('duplicate outputs', [entry('a.txt', 'assets/one.txt'), entry('a.txt', 'assets/two.txt')]);
  collide('case-folded duplicates', [entry('src/app.mjs', 'assets/a'), entry('src/App.mjs', 'assets/b')]);
  collide('file/directory prefix', [entry('lib', 'assets/a'), entry('lib/tool.mjs', 'assets/b')]);
  collide('duplicate source, distinct outputs', [entry('a.txt', 'assets/dup'), entry('b.txt', 'assets/dup')]);
});

// ---------------------------------------------------------------------------
// Group 5 — path acceptlist
// ---------------------------------------------------------------------------

test('5 — every decided invalid path is refused on both sides; runner/files.mjs is ordinary metadata only', () => {
  const invalid = [
    '../x', '/x', 'C:/x', 'lib\\tool.mjs', '//server/x', 'a//b', 'a/./b', 'a/../b', 'a/', 'a.',
    'NUL.txt', 'COM1', 'ads:stream.txt', 'glob*.txt', 'glob?.txt', 'brack[et].txt',
    'control\u0000name.txt', 'café/m.txt', 'workflow/a', 'Reference/a', 'x/.env.local',
    'node_modules/x', 'runner/reset.mjs',
  ];
  for (const bad of invalid) {
    expectRefused({ ...fixture(), entries: [entry(bad, 'assets/ok.txt')] }, 'RELEASE_PATH_INVALID');
  }
  // The source side is checked to the same standard, not only the output side.
  expectRefused({ ...fixture(), entries: [{ path: 'ok.txt', bytes: 0, sha256: EMPTY_SHA256, source: '../x' }] }, 'RELEASE_PATH_INVALID');
  // runner/files.mjs may appear as ordinary synthetic metadata; that never unlocks a real
  // tooling profile and never copies a live source (runner/reset.mjs above stays refused).
  expectAccepted({ ...fixture(), entries: [entry('runner/files.mjs', 'assets/synthetic-file.mjs')] });
});

// ---------------------------------------------------------------------------
// Group 6 — entry shape and the fixed generated-output map
// ---------------------------------------------------------------------------

test('6 — malformed entries are refused; each recognized generator sits at its one fixed path', () => {
  const withEntry = (mutate) => {
    const profile = fixture();
    mutate(profile.entries[0]);
    expectRefused(profile, 'RELEASE_ENTRY_INVALID');
  };
  expectRefused({ ...fixture(), entries: [] }, 'RELEASE_ENTRY_INVALID');
  const sparse = fixture();
  sparse.entries.length = 3;
  expectRefused(sparse, 'RELEASE_ENTRY_INVALID');
  withEntry((e) => { e.bytes = -1; });
  withEntry((e) => { e.bytes = 1.5; });
  withEntry((e) => { e.bytes = 9007199254740993; });
  withEntry((e) => { e.sha256 = 'a'.repeat(63); });
  withEntry((e) => { e.sha256 = 'A'.repeat(64); });
  withEntry((e) => { e.generated = 'synthetic-metadata-v1'; }); // both origins
  withEntry((e) => { delete e.source; }); // neither origin
  withEntry((e) => { e.extra = 1; }); // unknown entry field

  // An accessor entry field is refused without executing the getter.
  let entryGetterCalls = 0;
  const accessor = fixture();
  Object.defineProperty(accessor.entries[0], 'sneaky', {
    enumerable: true, configurable: true, get() { entryGetterCalls += 1; return 'x'; },
  });
  expectRefused(accessor, 'RELEASE_ENTRY_INVALID');
  assert.equal(entryGetterCalls, 0, 'the entry getter must not be invoked');

  const generated = (path, name) => ({ path, bytes: 0, sha256: EMPTY_SHA256, generated: name });
  const generatorMap = [
    ['synthetic-metadata-v1', 'release-metadata.json'],
    ['tooling-package-v1', 'package.json'],
    ['tooling-lock-v1', 'package-lock.json'],
    ['installed-assets-v1', 'cli/installed-assets.json'],
    ['adapter-package-v1', 'adapters/dsh/package.json'],
  ];
  for (const [name, path] of generatorMap) {
    expectAccepted({ ...fixture(), entries: [generated(path, name)] });
  }
  expectRefused({ ...fixture(), entries: [generated('release-metadata.json', 'made-up-v1')] }, 'RELEASE_ENTRY_INVALID');
  expectRefused({ ...fixture(), entries: [generated('wrong/path.json', 'tooling-package-v1')] }, 'RELEASE_ENTRY_INVALID');
});

// ---------------------------------------------------------------------------
// Group 7 — structural JSON Schema (Ajv 2020) vs runtime policy
// ---------------------------------------------------------------------------

test('7 — the published schema accepts the valid shapes and rejects the negatives; runtime blocks policy', () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL('schemas/release-profile.schema.json', REPO_ROOT)), 'utf8'));
  const ajv = new Ajv2020({ strict: true });
  const check = ajv.compile(schema);
  const passes = (label, doc) => { assert.equal(check(doc), true, `${label}: ${JSON.stringify(check.errors)}`); };
  const fails = (label, doc) => { assert.equal(check(doc), false, `${label} must not pass the schema`); };

  passes('canonical participant profile', createParticipantProfile());
  passes('ordinary synthetic profile', fixture());

  fails('unknown schemaVersion', { ...fixture(), schemaVersion: '2.0.0' });
  fails('unknown field', { ...fixture(), extra: 1 });
  fails('wrong state pairing', { ...fixture(), authorization: 'blocked' });
  const bothOrigins = { ...fixture(), entries: [{ ...fixture().entries[0], generated: 'synthetic-metadata-v1' }] };
  fails('both origins', bothOrigins);
  const neitherOrigin = { ...fixture(), entries: [{ path: 'lib/tool.mjs', bytes: 0, sha256: EMPTY_SHA256 }] };
  fails('neither origin', neitherOrigin);
  const upperHash = { ...fixture(), entries: [{ ...fixture().entries[0], sha256: 'A'.repeat(64) }] };
  fails('malformed hash', upperHash);
  const negativeBytes = { ...fixture(), entries: [{ ...fixture().entries[0], bytes: -1 }] };
  fails('negative size', negativeBytes);

  // The documented layer difference: a structurally valid end-user descriptor with the blocked
  // pairing satisfies the schema, and the runtime authorization check still refuses it. The
  // schema is structure; the runtime is the authority — no promotion is implied.
  const endUser = { ...fixture(), profile: 'end-user-tooling', authorization: 'blocked' };
  passes('blocked end-user descriptor (structure only)', endUser);
  expectRefused(endUser, 'RELEASE_PROFILE_BLOCKED');
});
