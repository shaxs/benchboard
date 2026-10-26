// C7a.S2.T1 — Independent notice-projection acceptance (installed contract).
//
// Exercises only the decided public seam: buildNoticeInventory and NoticeInventoryError from
// release/notices.mjs, plus createParticipantProfile from release/profiles.mjs. Implementation
// internals are never read, no installation is performed, the two real lockfiles are read read-only,
// and every other fixture is local memory only. The five groups below are table driven and follow
// the packet's decided seam; the license vocabulary is deliberately limited and is a declaration,
// not SPDX validation or redistribution proof. This file claims no release, no installation, no
// license approval and no runtime dependency closure.
//
// Every expectation comes from the decided public contract, not implementation internals.
// Captain acceptance reruns the cases against frozen source; task-history observations belong
// in private evidence, not as an unsupported claim about the source in this test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildNoticeInventory, NoticeInventoryError } from '../../../release/notices.mjs';
import { createParticipantProfile, ReleaseProfileError } from '../../../release/profiles.mjs';

const REPO_ROOT = new URL('../../../', import.meta.url);
const readLock = (relative) => JSON.parse(readFileSync(fileURLToPath(new URL(relative, REPO_ROOT)), 'utf8'));

const ZERO64 = '0'.repeat(64);

// ---------------------------------------------------------------------------
// Shared memory fixtures and expectation helpers (all derived from the packet).
// ---------------------------------------------------------------------------

/** Synthetic S1 profile fixture with the one decided asset binding. */
const syntheticProfile = () => structuredClone({
  schemaVersion: '1.0.0',
  kind: 'ReleaseProfile',
  profile: 'synthetic',
  authorization: 'synthetic-only',
  entries: [{ path: 'lib/a.mjs', bytes: 0, sha256: ZERO64, source: 'assets/a.mjs' }],
});

/** A version-3 lock document with caller-supplied packages and root extras. */
const lockDoc = (packages, root) => structuredClone({
  lockfileVersion: 3,
  name: 'fixture-root',
  version: '1.0.0',
  packages,
  ...root,
});

const owner = (lockfile) => ({ scope: 'owner', lockfile });
const participant = (lockfile) => ({ scope: 'participant', lockfile });

/** The packet's version rule: numeric three parts, optional prerelease and build suffixes. */
const SEMVER_LIKE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The packet's deliberately limited declaration vocabulary, matched exactly. */
const DECLARED_LICENSES = [
  'MIT', 'MIT-0', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC-BY-4.0', '(MIT OR Apache-2.0)',
];

/** Projected version: the declared text when semver-like, otherwise null. */
const expectVersion = (declared) => (typeof declared === 'string' && SEMVER_LIKE.test(declared) ? declared : null);

/** Projected licence plus its source, both from the declaration only. */
const expectLicense = (declared) => (DECLARED_LICENSES.includes(declared)
  ? { license: declared, licenseSource: 'lockfile-declaration' }
  : { license: null, licenseSource: 'unavailable' });

/** Expected name: the package component after the last node_modules/ marker. */
const expectName = (location) => {
  const marker = 'node_modules/';
  const at = location.lastIndexOf(marker);
  assert.ok(at >= 0, `fixture location ${location} sits under a node_modules/ marker`);
  return location.slice(at + marker.length);
};

/** Code-unit comparison on scope then location, the decided ordering. */
const byScopeThenLocation = (a, b) => {
  if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
  return a.location < b.location ? -1 : a.location > b.location ? 1 : 0;
};
const codeUnitSorted = (values) => [...values].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

/** Own-enumerable-key set equality; order is not part of the decided seam. */
const exactObjectKeys = (label, value, keys) => {
  assert.equal(typeof value, 'object', `${label} is an object`);
  assert.notEqual(value, null, `${label} is not null`);
  assert.deepEqual(codeUnitSorted(Object.keys(value)), codeUnitSorted(keys), `${label} has exactly the decided keys`);
};

const ASSET_KEYS = ['path', 'bytes', 'sha256', 'ownership', 'license', 'compatibility', 'evidence'];
const DEPENDENCY_KEYS = ['scope', 'location', 'name', 'version', 'license', 'licenseSource', 'ownership', 'compatibility'];
const INVENTORY_KEYS = ['schemaVersion', 'kind', 'profile', 'projectLicense', 'releaseApproved',
  'assets', 'dependencies', 'dependencyCoverage'];

const expectRefusedLock = (locks, detail) => {
  assert.throws(
    () => buildNoticeInventory(createParticipantProfile(), locks),
    (error) => {
      assert.ok(error instanceof NoticeInventoryError, `${detail}: refusal is a NoticeInventoryError instance`);
      assert.equal(error.code, 'RELEASE_NOTICES_INVALID', `${detail}: exact refusal code`);
      return true;
    },
    `${detail}: expected NoticeInventoryError with exact code RELEASE_NOTICES_INVALID`,
  );
};

/** Lock-only field names that must never reach the projection. `name` is deliberately absent:
 *  a dependency record carries its own decided `name`, derived from the lock key. */
const FORBIDDEN_FIELD_NAMES = ['resolved', 'integrity', 'scripts', 'engines', 'dev', 'private', 'funding', 'bin', 'os', 'bundleDependencies'];

/** True when no object node in the tree carries a forbidden field name. */
const withoutForbiddenFields = (value, seen) => {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  seen.add(value);
  const offenders = Object.keys(value).filter((key) => FORBIDDEN_FIELD_NAMES.includes(key));
  assert.deepEqual(offenders, [], `no forbidden lock field is projected (found ${JSON.stringify(offenders)})`);
  return Object.values(value).every((child) => withoutForbiddenFields(child, seen));
};

const deepFrozen = (value, seen) => {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  seen.add(value);
  assert.ok(Object.isFrozen(value), 'every projection node is frozen');
  return Object.values(value).every((child) => deepFrozen(child, seen));
};

/** The full expected dependency record set for a set of supplied locks. */
const expectedDependencies = (records) => codeUnitSorted([]).concat(
  ...records.map(({ scope, lockfile }) => Object.keys(lockfile.packages)
    .filter((location) => location !== '')
    .map((location) => {
      const item = lockfile.packages[location];
      return {
        scope,
        location,
        name: expectName(location),
        version: expectVersion(item.version),
        ...expectLicense(item.license),
        ownership: null,
        compatibility: null,
      };
    })),
).sort(byScopeThenLocation);

// ---------------------------------------------------------------------------
// Group 1 — canonical profile with both real read-only lockfiles
// ---------------------------------------------------------------------------

test('1 — canonical profile and both real locks: 26 asset bindings, lock-derived declarations, separate coverage scopes', () => {
  const rootLock = readLock('package-lock.json');
  const starterLock = readLock('starter/package-lock.json');
  const profile = createParticipantProfile();
  const sourceSnapshot = JSON.stringify([rootLock, starterLock]);

  const inventory = buildNoticeInventory(profile, [owner(rootLock), participant(starterLock)]);

  exactObjectKeys('inventory', inventory, INVENTORY_KEYS);
  assert.equal(inventory.schemaVersion, '1.0.0');
  assert.equal(inventory.kind, 'NoticeInventory');
  assert.equal(inventory.profile, 'participant', 'the profile tag names the accepted profile, nothing more');

  // No project selection, no approval, no release: the legal fields stay unclaimed.
  exactObjectKeys('projectLicense', inventory.projectLicense, ['selected', 'approved']);
  assert.equal(inventory.projectLicense.selected, null, 'no licence is selected');
  assert.equal(inventory.projectLicense.approved, false, 'nothing is approved');
  assert.equal(inventory.releaseApproved, false, 'the inventory never claims a release');

  // Exactly 26 asset bindings, one per profile entry, in profile order.
  assert.equal(inventory.assets.length, 26);
  assert.deepEqual(inventory.assets.map((asset) => asset.path), profile.entries.map((entry) => entry.path));
  for (const [index, asset] of inventory.assets.entries()) {
    const entry = profile.entries[index];
    exactObjectKeys(`asset ${entry.path}`, asset, ASSET_KEYS);
    assert.equal(asset.path, entry.path);
    assert.equal(asset.bytes, entry.bytes);
    assert.equal(asset.sha256, entry.sha256);
    assert.equal(asset.ownership, null, 'ownership is unknown, never inferred');
    assert.equal(asset.license, null, 'a profile path carries no licence declaration');
    assert.equal(asset.compatibility, null, 'compatibility is unknown, never inferred');
    assert.equal(asset.evidence, 'release-profile-declaration');
  }

  // Dependency records equal every non-empty packages key of each supplied lock, and nothing else.
  const expected = expectedDependencies([
    { scope: 'owner', lockfile: rootLock },
    { scope: 'participant', lockfile: starterLock },
  ]);
  assert.equal(inventory.dependencies.length, expected.length, 'one record per non-empty packages key');
  assert.deepEqual(inventory.dependencies, expected);

  for (const dependency of inventory.dependencies) {
    exactObjectKeys(`dependency ${dependency.scope}:${dependency.location}`, dependency, DEPENDENCY_KEYS);
    assert.equal(dependency.ownership, null);
    assert.equal(dependency.compatibility, null);
    assert.ok(dependency.license === null || typeof dependency.license === 'string', 'a licence is declared text or null');
    assert.ok(['lockfile-declaration', 'unavailable'].includes(dependency.licenseSource), 'licence source is the declaration state');
    assert.notEqual(dependency.version, 0, 'an unusable version is null, never an invented zero');
    assert.ok(!('resolved' in dependency) && !('integrity' in dependency) && !('scripts' in dependency), 'no resolved URL, integrity or script is projected');
  }

  // The two supplied scopes stay separate records, and coverage is sorted.
  const scopes = new Set(inventory.dependencies.map((dependency) => dependency.scope));
  assert.deepEqual([...scopes].sort(), ['owner', 'participant']);
  for (const scope of ['owner', 'participant']) {
    const supplied = scope === 'owner' ? rootLock : starterLock;
    const expectedLocations = codeUnitSorted(Object.keys(supplied.packages).filter((location) => location !== ''));
    const actualLocations = codeUnitSorted(inventory.dependencies
      .filter((dependency) => dependency.scope === scope)
      .map((dependency) => dependency.location));
    assert.deepEqual(actualLocations, expectedLocations, `${scope} coverage is exactly its own lock keys`);
  }

  // Sorting: scope first, then location, by UTF-16 code units.
  const order = inventory.dependencies.map((dependency) => [dependency.scope, dependency.location]);
  assert.deepEqual(order, [...order].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));

  // Nested duplicate names keep their own records; nothing collapses or is invented. A name may
  // repeat across the two scopes at the same location string, so the record identity is the pair.
  const byName = new Map();
  for (const dependency of inventory.dependencies) {
    byName.set(dependency.name, [...(byName.get(dependency.name) ?? []), dependency]);
  }
  const repeatedNames = [...byName].filter(([, list]) => list.length > 1);
  assert.ok(repeatedNames.length > 0, 'the supplied locks contain a repeated package name');
  for (const [name, list] of repeatedNames) {
    const identities = new Set(list.map((dependency) => `${dependency.scope}\u0000${dependency.location}`));
    assert.equal(identities.size, list.length, `records for the repeated name ${name} stay distinct`);
  }
  const nestedWithinOneScope = repeatedNames.find(([, list]) => new Set(list.map((dependency) => dependency.scope)).size === 1);
  assert.ok(nestedWithinOneScope !== undefined, 'a name repeats at nested locations inside one supplied lock');
  const [, nested] = nestedWithinOneScope;
  assert.ok(new Set(nested.map((dependency) => dependency.location)).size === nested.length,
    'each nested location keeps its own record instead of collapsing');

  // Coverage describes the supplied declarations as two separated scopes, sorted by scope.
  const expectedCoverage = [
    { scope: 'owner', evidence: 'lockfile-v3-declaration' },
    { scope: 'participant', evidence: 'lockfile-v3-declaration' },
  ];
  assert.deepEqual(inventory.dependencyCoverage, expectedCoverage, 'coverage is the two supplied declaration scopes');
  const coverageScopes = inventory.dependencyCoverage.map((record) => record.scope);
  assert.deepEqual(coverageScopes, codeUnitSorted(coverageScopes), 'coverage records are sorted by scope');
  for (const record of inventory.dependencyCoverage) {
    exactObjectKeys(`coverage ${record.scope}`, record, ['scope', 'evidence']);
    assert.equal(record.evidence, 'lockfile-v3-declaration', 'coverage evidence names the declaration, not a resolution');
  }

  // No installation claim anywhere in the projection.
  const serialized = JSON.stringify(inventory);
  assert.ok(!serialized.toLowerCase().includes('install'), 'the projection never claims an installation');
  assert.ok(withoutForbiddenFields(inventory, new Set()), 'only projection fields are present');

  // The supplied locks are read-only inputs: they are byte-identical after the call.
  assert.equal(JSON.stringify([rootLock, starterLock]), sourceSnapshot, 'the read-only lockfiles are not modified');
});

// ---------------------------------------------------------------------------
// Group 2 — allowed fields survive, canaries do not; frozen and detached
// ---------------------------------------------------------------------------

test('2 — canary lock metadata is dropped, exact projection keys hold the profile data, output is deeply frozen and detached', () => {
  const profile = syntheticProfile();
  const canaries = [
    'CANARYRESOLVED', 'CANARYINTEGRITY', 'CANARYSCRIPT', 'CANARYENGINE', 'CANARYPRIVATE',
    'CANARYROOTRESOLVED', 'CANARYROOTSCRIPT', 'CANARYROOTINTEGRITY', 'CANARYROOTPRIVATE',
    'CANARYTOPRESOLVED', 'CANARYTOPINTEGRITY', 'CANARYTOPSCRIPT', 'CANARYTOPPRIVATE',
  ];
  const lockfile = lockDoc({
    '': {
      name: 'fixture-root',
      version: '1.0.0',
      resolved: 'CANARYROOTRESOLVED',
      integrity: 'CANARYROOTINTEGRITY',
      scripts: { postinstall: 'CANARYROOTSCRIPT' },
      private: 'CANARYROOTPRIVATE',
    },
    'node_modules/a': {
      version: '1.0.0',
      license: 'MIT',
      resolved: 'CANARYRESOLVED',
      integrity: 'CANARYINTEGRITY',
      scripts: { prepare: 'CANARYSCRIPT' },
      engines: { node: 'CANARYENGINE' },
      private: 'CANARYPRIVATE',
    },
  }, {
    resolved: 'CANARYTOPRESOLVED',
    integrity: 'CANARYTOPINTEGRITY',
    scripts: { prepare: 'CANARYTOPSCRIPT' },
    private: 'CANARYTOPPRIVATE',
  });

  const inventory = buildNoticeInventory(profile, [owner(lockfile)]);

  // Every canary is absent from the serialised projection.
  const serialized = JSON.stringify(inventory);
  for (const canary of canaries) {
    assert.ok(!serialized.includes(canary), `canary ${canary} never reaches the projection`);
  }
  assert.ok(withoutForbiddenFields(inventory, new Set()), 'only the decided projection fields survive');

  // Exact keys, holding exactly the profile data.
  exactObjectKeys('inventory', inventory, INVENTORY_KEYS);
  exactObjectKeys('profile licence state', inventory.projectLicense, ['selected', 'approved']);
  assert.deepEqual(inventory.projectLicense, { selected: null, approved: false });
  assert.equal(inventory.releaseApproved, false);
  exactObjectKeys('selected asset', inventory.assets[0], ASSET_KEYS);
  assert.deepEqual(inventory.assets, [{
    path: 'lib/a.mjs',
    bytes: 0,
    sha256: ZERO64,
    ownership: null,
    license: null,
    compatibility: null,
    evidence: 'release-profile-declaration',
  }]);
  assert.equal(inventory.dependencies.length, 1, 'only the named lock entry is projected');
  exactObjectKeys('dependency', inventory.dependencies[0], DEPENDENCY_KEYS);
  assert.deepEqual(inventory.dependencies, [{
    scope: 'owner',
    location: 'node_modules/a',
    name: 'a',
    version: '1.0.0',
    license: 'MIT',
    licenseSource: 'lockfile-declaration',
    ownership: null,
    compatibility: null,
  }]);
  assert.equal(inventory.profile, 'synthetic');
  assert.equal(inventory.kind, 'NoticeInventory');
  assert.equal(inventory.schemaVersion, '1.0.0');

  // Deeply frozen, in every node.
  assert.ok(deepFrozen(inventory, new Set()), 'the projection is deeply frozen');

  // The caller cannot change the returned value: direct writes are refused.
  assert.throws(() => { inventory.releaseApproved = true; }, TypeError, 'a frozen scalar field cannot be reassigned');
  assert.throws(() => { inventory.assets.length = 0; }, TypeError, 'the frozen asset list cannot be truncated');
  assert.throws(() => { inventory.dependencies[0].license = 'GPL-3.0'; }, TypeError, 'a frozen dependency field cannot be reassigned');
  assert.equal(inventory.releaseApproved, false);
  assert.equal(inventory.assets.length, 1);
  assert.equal(inventory.dependencies[0].license, 'MIT');

  // Detachment: mutating the inputs afterwards cannot change the returned value.
  const snapshot = JSON.stringify(inventory);
  lockfile.packages['node_modules/evil'] = { version: '9.9.9', license: 'MIT' };
  lockfile.packages['node_modules/a'].version = '9.9.9';
  profile.entries.push({ path: 'zz.mjs', bytes: 0, sha256: ZERO64, source: 'assets/zz.mjs' });
  assert.equal(JSON.stringify(inventory), snapshot, 'later caller mutation of the inputs does not reach the projection');
  assert.equal(inventory.dependencies.length, 1, 'the projection kept its own dependency list');
  assert.equal(inventory.assets.length, 1, 'the projection kept its own asset list');
  assert.notEqual(inventory.assets, profile.entries, 'the asset list is detached from the profile');
});

// ---------------------------------------------------------------------------
// Group 3 — locations, names, sorting, and null-not-zero fallbacks
// ---------------------------------------------------------------------------

test('3 — fake lock: exact locations, names and sorting; unknown or missing licences and bad versions are null, never invented', () => {
  const lockfile = lockDoc({
    '': { name: 'fixture-root', version: '1.0.0' },
    'node_modules/zzz': { version: 'not-a-version', license: 'MIT' },
    'node_modules/a': { version: '1.0.0', license: 'MIT' },
    'node_modules/a/node_modules/b': { version: '2.0.0', license: 'ISC' },
    'node_modules/@scope/c': { version: '3.0.0', license: 'GPL-3.0' },
    'node_modules/d': { version: '4.0.0' },
  });

  const inventory = buildNoticeInventory(syntheticProfile(), [owner(lockfile)]);
  const expected = [
    {
      scope: 'owner',
      location: 'node_modules/@scope/c',
      name: '@scope/c',
      version: '3.0.0',
      license: null,
      licenseSource: 'unavailable',
      ownership: null,
      compatibility: null,
    },
    {
      scope: 'owner',
      location: 'node_modules/a',
      name: 'a',
      version: '1.0.0',
      license: 'MIT',
      licenseSource: 'lockfile-declaration',
      ownership: null,
      compatibility: null,
    },
    {
      scope: 'owner',
      location: 'node_modules/a/node_modules/b',
      name: 'b',
      version: '2.0.0',
      license: 'ISC',
      licenseSource: 'lockfile-declaration',
      ownership: null,
      compatibility: null,
    },
    {
      scope: 'owner',
      location: 'node_modules/d',
      name: 'd',
      version: '4.0.0',
      license: null,
      licenseSource: 'unavailable',
      ownership: null,
      compatibility: null,
    },
    {
      scope: 'owner',
      location: 'node_modules/zzz',
      name: 'zzz',
      version: null,
      license: 'MIT',
      licenseSource: 'lockfile-declaration',
      ownership: null,
      compatibility: null,
    },
  ];

  assert.deepEqual(inventory.dependencies, expected, 'locations, names, sorting and null fallbacks are exact');
  const byLocation = new Map(inventory.dependencies.map((dependency) => [dependency.location, dependency]));
  assert.equal(byLocation.get('node_modules/a/node_modules/b').name, 'b', 'the nested record names its own component');
  assert.equal(byLocation.get('node_modules/@scope/c').name, '@scope/c', 'the scoped record keeps its scope in the name');
  assert.equal(byLocation.get('node_modules/zzz').version, null, 'malformed version text is null');
  assert.notEqual(byLocation.get('node_modules/zzz').version, 0, 'null, never an invented zero');
  assert.equal(byLocation.get('node_modules/d').license, null, 'a missing licence is null');
  assert.equal(byLocation.get('node_modules/d').licenseSource, 'unavailable', 'a missing licence is reported unavailable');
  assert.equal(byLocation.get('node_modules/@scope/c').license, null, 'an unrecognised licence is null');
  assert.ok(withoutForbiddenFields(inventory, new Set()));
});

// ---------------------------------------------------------------------------
// Group 4 — refusal codes; blocked profiles propagate, never promoted
// ---------------------------------------------------------------------------

test('4 — invalid lock documents are refused with the exact code, and a blocked S1 profile propagates unreformatted', () => {
  const validPackages = { 'node_modules/a': { version: '1.0.0', license: 'MIT' } };
  const validLock = lockDoc(validPackages);
  const cases = [
    ['empty lock list', []],
    ['duplicate scope', [owner(validLock), owner(validLock)]],
    ['unknown scope', [{ scope: 'administrator', lockfile: validLock }]],
    ['scope is not a string', [{ scope: 7, lockfile: validLock }]],
    ['lock record without a lockfile', [{ scope: 'owner' }]],
    ['version-2 lockfile', [owner({ ...validLock, lockfileVersion: 2 })]],
    ['missing packages map', [owner({ lockfileVersion: 3 })]],
    ['packages is an array', [owner({ lockfileVersion: 3, packages: [] })]],
    ['escaping package path', [owner(lockDoc({ 'node_modules/../x': { version: '1.0.0', license: 'MIT' } }))]],
    ['absolute package path', [owner(lockDoc({ '/abs/package': { version: '1.0.0', license: 'MIT' } }))]],
    ['drive-letter package path', [owner(lockDoc({ 'C:/package': { version: '1.0.0', license: 'MIT' } }))]],
    ['package item is an array', [owner(lockDoc({ 'node_modules/a': [] }))]],
    ['package item is a string', [owner(lockDoc({ 'node_modules/a': 'MIT' }))]],
    ['three lock records', [owner(validLock), participant(validLock), participant(validLock)]],
  ];
  for (const [detail, locks] of cases) expectRefusedLock(locks, detail);

  // A blocked S1 profile propagates the S1 error; the notice layer neither promotes nor
  // recategorises it, so the code and the error class stay exactly as S1 raised them.
  const blocked = structuredClone({
    schemaVersion: '1.0.0',
    kind: 'ReleaseProfile',
    profile: 'end-user-tooling',
    authorization: 'blocked',
    entries: [{ path: 'lib/a.mjs', bytes: 0, sha256: ZERO64, source: 'assets/a.mjs' }],
  });
  assert.throws(
    () => buildNoticeInventory(blocked, [owner(lockDoc(validPackages))]),
    (error) => {
      assert.ok(error instanceof ReleaseProfileError, 'the S1 error class reaches the caller unchanged');
      assert.equal(error.code, 'RELEASE_PROFILE_BLOCKED', 'the S1 code reaches the caller unchanged');
      assert.ok(!(error instanceof NoticeInventoryError), 'the notice layer does not recategorise the refusal');
      return true;
    },
    'a blocked profile propagates ReleaseProfileError with exact code RELEASE_PROFILE_BLOCKED',
  );
});

// ---------------------------------------------------------------------------
// Group 5 — selected assets versus declared coverage
// ---------------------------------------------------------------------------

test('5 — selected assets are the profile paths only; declared coverage is not a runtime dependency closure', () => {
  const lockfile = lockDoc({
    '': { name: 'fixture-root', version: '1.0.0' },
    'node_modules/extra-one': { version: '1.0.0', license: 'Apache-2.0' },
    'node_modules/extra-two': { version: '2.0.0', license: 'BSD-3-Clause', resolved: 'x', integrity: 'y' },
  }, { extraRootField: 'present-but-not-selected' });

  const profile = syntheticProfile();
  const inventory = buildNoticeInventory(profile, [owner(lockfile)]);

  // The selected asset set is exactly the one profile path, whatever the lock root also declares.
  assert.deepEqual(inventory.assets, [{
    path: 'lib/a.mjs',
    bytes: 0,
    sha256: ZERO64,
    ownership: null,
    license: null,
    compatibility: null,
    evidence: 'release-profile-declaration',
  }], 'the lock declares nothing about selection; the profile decides it');
  assert.equal(inventory.assets.length, 1);
  assert.ok(inventory.assets.every((asset) => asset.ownership === null && asset.compatibility === null && asset.license === null),
    'every unknown legal field stays null on a selected asset');
  assert.deepEqual([inventory.projectLicense.selected, inventory.projectLicense.approved, inventory.releaseApproved], [null, false, false],
    'no selection, approval or release is implied by declared locks');

  // Coverage counts the declared lock entries; that is not the runtime closure of the assets.
  assert.equal(inventory.dependencies.length, 2, 'the two declared entries are described');
  assert.ok(inventory.dependencies.every((dependency) => !inventory.assets.some((asset) => asset.path === dependency.location)),
    'a declared entry is not presented as a selected asset');
  assert.deepEqual(inventory.dependencyCoverage, [{ scope: 'owner', evidence: 'lockfile-v3-declaration' }],
    'coverage records the declared lock scope only');
  assert.ok(withoutForbiddenFields(inventory, new Set()));
});
