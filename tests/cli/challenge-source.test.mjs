// Captain-owned source ownership proofs; no challenge or owner dependency edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareChallengeSource } from '../../cli/challenge-source.mjs';
import { loadInstallation } from '../../cli/installation.mjs';
import { inventoryTree, sha256 } from '../../packages/core/identity.mjs';

function staged(t) {
  const installed = loadInstallation(), source = prepareChallengeSource(installed);
  t.after(() => fs.rmSync(source.sourceRoot, { recursive: true, force: true, maxRetries: 4 }));
  return { installed, source, root: source.sourceRoot };
}
test('materialization copies exactly verified 26 raw files and disposes only its own scratch', t => {
  const f = staged(t), second = prepareChallengeSource(f.installed);
  t.after(() => fs.rmSync(second.sourceRoot, { recursive: true, force: true, maxRetries: 4 }));
  const expected = f.installed.challenge.identity;
  assert.notEqual(f.root, second.sourceRoot);
  for (const root of [f.root, second.sourceRoot]) {
    const actual = inventoryTree({ root, skipNames: [] });
    assert.equal(actual.entries.length, 26);
    assert.equal(actual.digest, expected.workloadDigest);
    for (const [relative, digest] of expected.starterInventory) {
      const bytes = fs.readFileSync(path.join(root, relative));
      assert.equal(sha256(bytes), digest);
      assert.deepEqual(bytes, fs.readFileSync(path.join(f.installed.challenge.sourceRoot, relative)));
    }
  }
  assert.deepEqual(f.source.dispose(), { status: 'removed', root: f.root });
  assert.equal(fs.existsSync(f.root), false);
  assert.equal(fs.existsSync(second.sourceRoot), true);
  assert.deepEqual(f.source.dispose(), { status: 'removed', root: f.root });
  assert.equal(second.dispose().status, 'removed');
});
for (const kind of ['foreign-file', 'foreign-empty-directory', 'changed-file', 'same-byte-file-replacement']) {
  test(`source disposal retains ${kind} and does not partially delete the tree`, t => {
    const f = staged(t), file = path.join(f.root, 'PRODUCT_PRD.md');
    if (kind === 'foreign-file') fs.writeFileSync(path.join(f.root, 'foreign-canary'), 'foreign bytes');
    if (kind === 'foreign-empty-directory') fs.mkdirSync(path.join(f.root, 'foreign-empty'));
    if (kind === 'changed-file') fs.appendFileSync(file, '\nchanged test-owned copy\n');
    if (kind === 'same-byte-file-replacement') {
      const bytes = fs.readFileSync(file);
      fs.renameSync(file, `${file}.retained`);
      fs.writeFileSync(file, bytes);
      fs.unlinkSync(`${file}.retained`);
    }
    const before = inventoryTree({ root: f.root, skipNames: [] });
    assert.equal(f.source.dispose().status, 'retained');
    assert.deepEqual(inventoryTree({ root: f.root, skipNames: [] }), before);
    if (kind === 'foreign-empty-directory') assert.equal(fs.statSync(path.join(f.root, 'foreign-empty')).isDirectory(), true);
  });
}
test('a replaced source root or junction is retained without entering the foreign target', t => {
  const f = staged(t), retained = `${f.root}-owned-retained`, foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-source-foreign-'));
  t.after(() => fs.rmSync(retained, { recursive: true, force: true }));
  t.after(() => fs.rmSync(foreign, { recursive: true, force: true }));
  fs.writeFileSync(path.join(foreign, 'canary'), 'foreign target bytes');
  fs.renameSync(f.root, retained);
  fs.symlinkSync(foreign, f.root, process.platform === 'win32' ? 'junction' : 'dir');
  const before = inventoryTree({ root: foreign, skipNames: [] });
  assert.equal(f.source.dispose().status, 'retained');
  assert.deepEqual(inventoryTree({ root: foreign, skipNames: [] }), before);
  assert.equal(inventoryTree({ root: retained, skipNames: [] }).entries.length, 26);
});
test('cleanup detects an intermediate-directory replacement even with original file inodes moved back', t => {
  const f = staged(t), relative = f.installed.challenge.fileManifest.find(file => file.startsWith('src/'));
  const originalUnlink = fs.unlinkSync, moved = path.join(f.root, 'test-owned-retained-src');
  let replaced = false;
  fs.unlinkSync = function(file, ...args) {
    const result = originalUnlink.call(this, file, ...args);
    if (!replaced && String(file).startsWith(f.root + path.sep)) {
      replaced = true;
      fs.renameSync(path.join(f.root, 'src'), moved);
      fs.mkdirSync(path.join(f.root, 'src'));
      const suffix = relative.slice(4), destination = path.join(f.root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(path.join(moved, suffix), destination);
    }
    return result;
  };
  try { assert.equal(f.source.dispose().status, 'retained'); }
  finally { fs.unlinkSync = originalUnlink; }
  assert.equal(replaced, true, 'the replacement really happened after cleanup began');
  assert.equal(fs.existsSync(path.join(f.root, relative)), true, 'moved-back original file belongs to a replaced parent and is preserved');
});
test('a preparation write fault retains its partial source and exposes only structured private residue', t => {
  const installed = loadInstallation(), originalWrite = fs.writeFileSync;
  let residue;
  fs.writeFileSync = function(file, ...args) {
    const result = originalWrite.call(this, file, ...args);
    if (typeof file === 'string' && path.basename(path.dirname(file)).startsWith('bb-cli-source-')) {
      const error = new Error('Synthetic local write fault');
      error.code = 'EIO';
      throw error;
    }
    return result;
  };
  try {
    assert.throws(() => prepareChallengeSource(installed), error => {
      residue = error.sourceResidue;
      return error.code === 'EIO' && typeof residue === 'string';
    });
  } finally { fs.writeFileSync = originalWrite; }
  t.after(() => fs.rmSync(residue, { recursive: true, force: true }));
  assert.equal(fs.existsSync(residue), true);
  assert.equal(inventoryTree({ root: residue, skipNames: [] }).entries.length, 1);
});
