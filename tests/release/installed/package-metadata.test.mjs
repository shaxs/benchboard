// S5 static installation-metadata acceptance: synthetic tooling package metadata against the
// decided contract. release/installation-metadata.mjs and its templates are terminal/accepted and
// this suite runs as the runtime proof at Captain integration.
// Contract clarifications: case 2's files list is metadata only (it approves no evaluator exposure
// and proves no real archive is complete); case 4's preparation constraints are not support or
// installed-browser claims and no test here executes the bin or installs anything; the packet's
// "bin path without leading ./" is read as lock packages[''].bin.benchboard === 'cli/benchboard.mjs'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderSyntheticPackageMetadata } from '../../../release/installation-metadata.mjs';

const ROOT = new URL('../../../', import.meta.url);
const from = (url) => fileURLToPath(url);
const readUtf8 = (relative) => readFileSync(from(new URL(relative, ROOT)), 'utf8');
const render = () => renderSyntheticPackageMetadata();
const parsePackage = () => JSON.parse(render().packageJson);
const parseLock = () => JSON.parse(render().packageLock);

// The two fixed templates, byte-for-byte; renderer output must equal them exactly.
const TEMPLATE = Object.freeze({
  packageJson: readUtf8('release/templates/tooling-package.json'),
  packageLock: readUtf8('release/templates/tooling-package-lock.json'),
});

// Case 1 and 2 tables.
const NO_ARG_MESSAGE = 'Synthetic package metadata takes no arguments';
const PKG_KEYS = ['bin', 'dependencies', 'engines', 'files', 'name', 'private', 'type', 'version'];
const PKG_VALUES = {
  name: '@benchboard/synthetic-tooling',
  version: '0.0.0-synthetic',
  private: true,
  type: 'module',
  bin: { benchboard: './cli/benchboard.mjs' },
  engines: { node: '24.13.1', npm: '11.8.0' },
  dependencies: { '@playwright/test': '1.51.1', ajv: '8.17.1' },
};
const PKG_FILES = ['cli/', 'packages/core/', 'packages/evaluation/', 'packages/results/', 'schemas/',
  'adapters/manual/', 'starter/', 'fixtures/', 'evaluator/score.mjs',
  'evaluator/hidden-tests/properties.mjs', 'evaluator/browser.mjs', 'evaluator/useful-tests.mjs',
  'evaluator/collect-evidence.mjs', 'evaluator/local-server.mjs', 'runner/files.mjs',
  'release/inventory.json', 'version.json'];
const BANNED_FILE_FRAGMENTS = ['reference', 'spec', 'workflow', 'artifacts', '.ai', 'node_modules', '**', '*'];
const ABSENT_PACKAGE_WORDS = ['devDependencies', 'scripts', 'license', 'exports', 'DSH'];

// Case 3 and 4 tables.
const LOCK_ROOT_KEYS = ['lockfileVersion', 'name', 'packages', 'requires', 'version'];
const LOCK_ROOT_ENTRY_KEYS = ['bin', 'dependencies', 'engines', 'name', 'version'];
const SELECTED_RECORDS = ['', 'node_modules/@playwright/test', 'node_modules/ajv',
  'node_modules/fast-deep-equal', 'node_modules/fast-uri', 'node_modules/fsevents',
  'node_modules/json-schema-traverse', 'node_modules/playwright', 'node_modules/playwright-core',
  'node_modules/require-from-string'];
// Fields/flags matching the root package-lock.json record once it loses only dev/devOptional.
const LOCK_STABLE_FIELDS = ['version', 'resolved', 'integrity'];
const LOCK_STABLE_FLAGS = ['optional', 'os', 'hasInstallScript'];

test('case 1: renderer takes no arguments and returns frozen template bytes', () => {
  const first = render();
  const second = render();
  assert.ok(Object.isFrozen(first), 'renderer output object is frozen');
  assert.deepEqual(Object.keys(first).sort(), ['packageJson', 'packageLock']);
  assert.equal(first.packageJson, TEMPLATE.packageJson, 'packageJson equals template bytes');
  assert.equal(first.packageLock, TEMPLATE.packageLock, 'packageLock equals template bytes');
  assert.equal(second.packageJson, first.packageJson, 'repeated call yields same package bytes');
  assert.equal(second.packageLock, first.packageLock, 'repeated call yields same lock bytes');
  for (const bad of [undefined, {}]) {
    assert.throws(() => renderSyntheticPackageMetadata(bad),
      (err) => err instanceof TypeError && err.message === NO_ARG_MESSAGE,
      `passing ${typeof bad} refuses with the exact TypeError message`);
  }
});

test('case 2: parsed package has exact keys, values and file order; root package untouched', () => {
  const before = readUtf8('package.json');
  const pkg = parsePackage();
  const rawLower = render().packageJson.toLowerCase();
  assert.deepEqual(Object.keys(pkg).sort(), PKG_KEYS);
  for (const [key, value] of Object.entries(PKG_VALUES)) {
    assert.deepEqual(pkg[key], value, `package ${key}`);
  }
  assert.deepEqual(pkg.files, PKG_FILES);
  assert.deepEqual(pkg.files.filter((entry) => BANNED_FILE_FRAGMENTS.some((bad) => entry.includes(bad))), [],
    'file list excludes reference/spec/workflow/artifacts/.ai/node_modules and wildcards');
  for (const word of ABSENT_PACKAGE_WORDS) {
    assert.ok(!rawLower.includes(word.toLowerCase()), `package has no ${word}`);
  }
  assert.equal(JSON.parse(readUtf8('package.json')).private, true, 'root package.json still private');
  assert.equal(readUtf8('package.json'), before, 'root package.json bytes unchanged');
});

test('case 3: parsed lock has exact root fields; selected records mirror the root lock', () => {
  const before = readUtf8('package-lock.json');
  const lock = parseLock();
  const pkg = parsePackage();
  assert.deepEqual(Object.keys(lock).sort(), LOCK_ROOT_KEYS);
  assert.equal(lock.name, pkg.name, 'lock name matches package');
  assert.equal(lock.version, pkg.version, 'lock version matches package');
  assert.equal(lock.lockfileVersion, 3, 'lockfileVersion 3');
  assert.equal(lock.requires, true, 'requires true');
  assert.deepEqual(Object.keys(lock.packages).sort(), [...SELECTED_RECORDS].sort());
  assert.ok(!Object.keys(lock.packages).some((key) => key.toLowerCase().includes('prettier')),
    'prettier excluded from the lock');
  const entry = lock.packages[''];
  assert.deepEqual(Object.keys(entry).sort(), [...LOCK_ROOT_ENTRY_KEYS].sort());
  assert.equal(entry.name, pkg.name, 'root entry name');
  assert.equal(entry.version, pkg.version, 'root entry version');
  assert.deepEqual(entry.dependencies, pkg.dependencies, 'root entry dependencies');
  assert.deepEqual(entry.engines, pkg.engines, 'root entry engines');
  assert.deepEqual(entry.bin, { benchboard: 'cli/benchboard.mjs' }, 'root entry bin path has no leading ./');
  const source = JSON.parse(before).packages;
  for (const key of SELECTED_RECORDS.slice(1)) {
    const record = lock.packages[key];
    assert.ok(source[key], `root package-lock.json has ${key}`);
    const { dev: _dev, devOptional: _devOptional, ...stripped } = source[key];
    assert.deepEqual(record, stripped, `${key} equals the source record with only dev/devOptional removed`);
    for (const field of LOCK_STABLE_FIELDS) {
      assert.ok(field in stripped, `source ${key} has ${field}`);
      assert.equal(record[field], stripped[field], `${key} ${field} unchanged versus source lock`);
    }
    for (const flag of LOCK_STABLE_FLAGS) {
      assert.equal(flag in record, flag in stripped, `${key} ${flag} presence matches source`);
      if (flag in stripped) assert.deepEqual(record[flag], stripped[flag], `${key} ${flag} unchanged`);
    }
  }
  assert.equal(readUtf8('package-lock.json'), before, 'root package-lock.json bytes unchanged');
});

test('case 4: direct pins, edge resolution, ajv ranges versus source, ordinary bin target', () => {
  const pkg = parsePackage();
  const lock = parseLock();
  const sourceLock = JSON.parse(readUtf8('package-lock.json'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@playwright/test', 'ajv']);
  for (const [name, pin] of Object.entries(pkg.dependencies)) {
    const key = `node_modules/${name}`;
    assert.equal(lock.packages[''].dependencies[name], pin, `${name} pinned identically in lock root`);
    assert.equal(lock.packages[key].version, pin, `${name} selected record version equals the pin`);
    assert.notEqual(lock.packages[key].dev, true, `${name} is not dev-only`);
  }
  for (const key of SELECTED_RECORDS) {
    for (const edgeKey of ['dependencies', 'optionalDependencies']) {
      for (const edge of Object.keys(lock.packages[key][edgeKey] ?? {})) {
        assert.ok(SELECTED_RECORDS.includes(`node_modules/${edge}`),
          `${key} ${edgeKey}.${edge} resolves to a selected top-level record`);
      }
    }
  }
  for (const edgeKey of ['dependencies', 'optionalDependencies']) {
    assert.deepEqual(lock.packages['node_modules/ajv'][edgeKey] ?? {},
      sourceLock.packages['node_modules/ajv'][edgeKey] ?? {},
      `ajv transitive ${edgeKey} ranges match the unchanged source lock`);
  }
  const binUrl = new URL('cli/benchboard.mjs', ROOT);
  const binStats = lstatSync(binUrl);
  assert.ok(!binStats.isSymbolicLink(), 'bin target is not a symbolic link');
  assert.ok(binStats.isFile(), 'bin target is an ordinary file');
  assert.ok(readFileSync(from(binUrl), 'utf8').startsWith('#!'), 'bin target has a #! header');
  assert.ok(!('scripts' in pkg) && !('scripts' in lock.packages['']),
    'no lifecycle scripts in package or lock root entry');
});
