// Captain-owned diagnostic proofs for review F2. Only test-owned external copies
// are changed; canonical challenge/evaluator bytes in the checkout remain read-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInstallation } from '../../cli/installation.mjs';
import { inventoryTree, sha256 } from '../../packages/core/identity.mjs';

function copiedInstallation(t, installed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-installed-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 }));
  for (const relative of ['cli', 'packages', 'schemas', 'release', 'starter', 'fixtures', 'evaluator', 'adapters/manual']) {
    fs.cpSync(path.join(installed.root, relative), path.join(root, relative), { recursive: true,
      filter: source => !['node_modules', '.git', 'dist'].includes(path.basename(source)) });
  }
  for (const relative of ['package.json', 'package-lock.json', 'version.json']) {
    fs.copyFileSync(path.join(installed.root, relative), path.join(root, relative));
  }
  // Reuse prepared dependencies solely for module resolution; never traverse/copy them.
  fs.symlinkSync(path.join(installed.root, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return root;
}
function changeJson(file, change) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(value);
  fs.writeFileSync(file, JSON.stringify(value));
}
const isIntegrity = error => error?.category === 'integrity';

test('copied installations distinguish inconsistent canonical inputs from changed development fingerprints', async t => {
  const installed = loadInstallation();
  const originalPaths = [...new Set([
    ...installed.assetManifest.map(entry => entry.path),
    ...installed.actualEvaluator.semanticManifest.map(entry => entry.path),
    ...installed.challenge.fileManifest.map(file => `starter/${file}`),
    ...inventoryTree({ root: path.join(installed.root, 'fixtures'), skipNames: [] }).entries.map(entry => `fixtures/${entry.path}`),
  ])];
  const originalBytes = () => originalPaths.map(file => [file, sha256(fs.readFileSync(path.join(installed.root, file)))]);
  const before = originalBytes();
  t.after(() => assert.deepEqual(originalBytes(), before, 'every observed checkout input remains byte-identical'));
  async function copyFor(subtest) {
    const root = copiedInstallation(subtest, installed);
    const module = await import(pathToFileURL(path.join(root, 'cli/installation.mjs')).href);
    return { root, load: module.loadInstallation };
  }

  for (const field of ['workloadDigest', 'visibleDigest', 'fixtureDigest', 'publicPrdDigest']) {
    await t.test(`stale ${field} refuses independently`, async subtest => {
      const f = await copyFor(subtest);
      changeJson(path.join(f.root, 'cli/installation.json'), value => { value[field] = '0'.repeat(64); });
      assert.throws(f.load, isIntegrity);
    });
  }
  await t.test('altered workload bytes refuse the real canonical inventory comparison', async subtest => {
    const f = await copyFor(subtest);
    fs.appendFileSync(path.join(f.root, 'starter/PRODUCT_PRD.md'), '\nSynthetic changed copy, not a challenge edit.\n');
    assert.throws(f.load, isIntegrity);
  });
  await t.test('missing selected dependency lock refuses with the raw ENOENT', async subtest => {
    const f = await copyFor(subtest);
    fs.unlinkSync(path.join(f.root, 'package-lock.json'));
    assert.throws(f.load, error => error?.code === 'ENOENT');
  });
  await t.test('a hardlinked selected asset refuses without touching its bytes', async subtest => {
    const f = await copyFor(subtest), lock = path.join(f.root, 'package-lock.json');
    fs.linkSync(lock, path.join(f.root, 'test-owned-lock-twin'));
    const beforeLock = fs.readFileSync(lock);
    assert.throws(f.load, isIntegrity);
    assert.deepEqual(fs.readFileSync(lock), beforeLock);
  });
  for (const field of ['version', 'status']) {
    await t.test(`candidate ${field} mismatch refuses independently`, async subtest => {
      const f = await copyFor(subtest);
      changeJson(path.join(f.root, 'version.json'), value => { value[field] = 'synthetic-mismatched-copy'; });
      // C4 verifies candidate version before the CLI's version/status comparison.
      assert.throws(f.load, field === 'version'
        ? error => error?.name === 'EvaluationIntegrityError' && error.code === 'EVIDENCE_INTEGRITY'
        : isIntegrity);
    });
  }
  await t.test('valid changed selected source changes tooling identity, not challenge/evaluator identity', async subtest => {
    const f = await copyFor(subtest), first = f.load();
    fs.appendFileSync(path.join(f.root, 'cli/help.mjs'), '\n// Synthetic development build fingerprint change.\n');
    const second = f.load();
    assert.notDeepEqual(second.toolingIdentity, first.toolingIdentity);
    assert.deepEqual(second.challenge.identity, first.challenge.identity);
    assert.deepEqual(second.evaluatorIdentity, first.evaluatorIdentity);
    assert.deepEqual(second.actualEvaluator, first.actualEvaluator);
  });
  await t.test('a selected byte changed after inventory capture is refused by the final recheck', async subtest => {
    const f = await copyFor(subtest), marker = path.join(f.root, 'cli/test-owned-recheck.txt');
    assert.ok(f.load().toolingIdentity, 'this copied installation loads before the controlled mutation');
    fs.writeFileSync(marker, 'captured-byte-a');
    const originalRead = fs.readFileSync;
    let changes = 0;
    // Test-local fs observation only, not a production collaborator injection.
    // Change a same-length copied file AFTER inventoryTree captured its bytes;
    // readOrdinaryBytes must later compare fresh bytes with that captured digest.
    fs.readFileSync = function(file, ...args) {
      const bytes = originalRead.call(this, file, ...args);
      if (typeof file === 'string' && path.resolve(file) === marker && changes === 0) {
        changes += 1;
        fs.writeFileSync(marker, 'captured-byte-b');
      }
      return bytes;
    };
    try {
      assert.throws(f.load, isIntegrity);
      assert.equal(changes, 1, 'the mutation really occurred after capture');
    } finally {
      fs.readFileSync = originalRead;
    }
    assert.equal(fs.readFileSync(marker, 'utf8'), 'captured-byte-b', 'changed bytes were never restored to bypass refusal');
  });
});
