// C7a.S8.T2 independent optional adapter scaffold acceptance, written from the task contract alone:
// the dsh index and its package JSON are touched only at test runtime (dynamic import / read) and
// this worker run is the syntax proof, with the Captain running the suite after the terminal.
// Reading a direct import proves the scaffold is a standalone pure literal; it claims no installed
// package resolution and no incompatible-version runtime handling, and the exact peer pin means
// other versions are unsupported metadata rather than a resolver guarantee. Independent pack/install
// is C7b and is not inferred here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../../', import.meta.url);
const read = (relative) => readFileSync(fileURLToPath(new URL(relative, ROOT)), 'utf8');
const importAdapter = () => import(new URL('adapters/dsh/index.mjs', ROOT).href);

const TOOLING = Object.freeze({ name: '@benchboard/synthetic-tooling', version: '0.0.0-synthetic' });
const EXPECTED = {
  schemaVersion: '1.0.0',
  kind: 'AdapterPackageScaffold',
  adapter: 'dsh',
  status: 'scaffold-only',
  compatibleTooling: { name: TOOLING.name, version: TOOLING.version },
  capabilities: { runtimeIntegration: false, telemetry: false, executionAuthority: false,
    review: false, supervision: false, certification: false },
};
const PACKAGE_KEYS = ['exports', 'files', 'name', 'peerDependencies', 'peerDependenciesMeta',
  'private', 'type', 'version'];
const BANNED_PACKAGE_KEYS = ['scripts', 'license', 'dependencies', 'bin', 'engines'];
// Comments may name an unavailable capability, so only comment-free code is token-checked.
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((line) => line.replace(/\/\/.*/, '')).join('\n');
const FORBIDDEN_TOKENS = [/\bimport\b/, /\brequire\b/, /\bprocess\b/, /\benv\b/, /\bnetwork\b/,
  /\bfs\b/, /\bconfig\b/];

test('case 1: dynamic import exposes only the frozen scaffold-only literal, no live capability', async () => {
  const module = await importAdapter();
  assert.deepEqual(Object.keys(module).sort(), ['adapterScaffold'], 'adapterScaffold is the only export');
  for (const [name, value] of Object.entries(module)) {
    assert.notEqual(typeof value, 'function', `${name} is not a function export`);
  }
  const scaffold = module.adapterScaffold;
  assert.deepEqual(scaffold, EXPECTED, 'scaffold equals the contract value field for field');
  assert.equal(scaffold.status, 'scaffold-only', 'status records scaffold-only');
  assert.ok(Object.isFrozen(scaffold), 'scaffold object is frozen');
  for (const [key, value] of Object.entries(scaffold)) {
    if (value && typeof value === 'object') {
      assert.ok(Object.isFrozen(value), `nested object ${key} is frozen`);
    }
  }
  for (const [capability, granted] of Object.entries(scaffold.capabilities)) {
    assert.equal(granted, false, `capability ${capability} is not claimed live`);
  }
});

test('case 2: adapter package JSON carries exactly the contract fields and pins the S5 tooling', () => {
  const pkg = JSON.parse(read('adapters/dsh/package.json'));
  assert.deepEqual(Object.keys(pkg).sort(), PACKAGE_KEYS, 'exactly the contract package fields');
  assert.equal(pkg.name, '@benchboard/synthetic-adapter-dsh', 'package name');
  assert.equal(pkg.version, TOOLING.version, 'package version');
  assert.equal(pkg.private, true, 'private true');
  assert.equal(pkg.type, 'module', 'type module');
  assert.equal(pkg.exports, './index.mjs', 'root export is the literal index path');
  assert.deepEqual(pkg.files, ['index.mjs'], 'files list only index.mjs');
  assert.deepEqual(pkg.peerDependencies, { [TOOLING.name]: TOOLING.version }, 'exact tooling peer pin');
  assert.deepEqual(pkg.peerDependenciesMeta, { [TOOLING.name]: { optional: true } },
    'the peer is declared optional');
  for (const key of BANNED_PACKAGE_KEYS) {
    assert.ok(!(key in pkg), `package has no ${key}`);
  }
  assert.ok(!JSON.stringify(pkg).includes('*'), 'no wildcard appears anywhere in the package JSON');
  const template = JSON.parse(read('release/templates/tooling-package.json'));
  assert.equal(pkg.peerDependencies[template.name], template.version,
    'peer name and version match the accepted S5 tooling template');
});

test('case 3: default tooling ships no adapter or DSH dependency and the index needs no runtime', async () => {
  const template = JSON.parse(read('release/templates/tooling-package.json'));
  assert.ok(!Object.keys(template.dependencies).some((name) => /adapter|dsh/i.test(name)),
    'default tooling dependencies name no adapter and no DSH package');
  assert.ok(template.files.includes('adapters/manual/'), 'default files include adapters/manual/');
  assert.ok(!template.files.some((entry) => entry.startsWith('adapters/dsh')),
    'default files omit adapters/dsh');
  const code = stripComments(read('adapters/dsh/index.mjs'));
  for (const token of FORBIDDEN_TOKENS) {
    assert.ok(!token.test(code), `comment-free index code has no ${token.source} token`);
  }
  assert.deepEqual((await importAdapter()).adapterScaffold, EXPECTED,
    'a direct import yields the same pure literal on its own');
});
