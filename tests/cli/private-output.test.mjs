// Captain safety diagnostics; synthetic private JSON, no reviewed/scored authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { explicitFilePath, privateTemplateDestination, writePrivateTemplate } from '../../cli/private-output.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-private-template-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const protectedRoot = path.join(root, 'protected run'); fs.mkdirSync(protectedRoot);
  return { root, protectedRoot, output: path.join(root, 'private worksheet.json') };
}
test('private template writes exact complete JSON once and refuses existing, traversal, relative and protected output', t => {
  const f = fixture(t), value = { synthetic: 'private, not a sharing projection', scores: { layout: null } };
  assert.equal(writePrivateTemplate(f.output, value, [f.protectedRoot]), f.output);
  const bytes = fs.readFileSync(f.output);
  assert.equal(bytes.toString('utf8'), JSON.stringify(value, null, 2) + '\n');
  assert.throws(() => writePrivateTemplate(f.output, { overwrite: true }, [f.protectedRoot]), e => e.category === 'state');
  assert.deepEqual(fs.readFileSync(f.output), bytes);
  assert.throws(() => privateTemplateDestination(path.join(f.protectedRoot, 'unsafe.json'), [f.protectedRoot]), e => e.code === 'ROOTS_OVERLAP' || e.category === 'integrity');
  assert.throws(() => privateTemplateDestination('relative.json', []), e => e.category === 'integrity');
  assert.throws(() => privateTemplateDestination(f.root + '/elsewhere/../unsafe.json', []), e => e.category === 'integrity');
});
test('private output refuses a junction parent and preserves a same-byte foreign replacement after write', t => {
  const f = fixture(t), foreign = path.join(f.root, 'foreign'); fs.mkdirSync(foreign);
  const junction = path.join(f.root, 'linked'); fs.symlinkSync(foreign, junction, 'junction');
  assert.throws(() => privateTemplateDestination(path.join(junction, 'private.json'), []));
  assert.deepEqual(fs.readdirSync(foreign), []);
  const original = fs.writeFileSync, value = { private: 'synthetic canary' };
  let replaced = false;
  fs.writeFileSync = function(file, bytes, ...rest) {
    const result = original.call(this, file, bytes, ...rest);
    if (typeof file === 'number' && !replaced) {
      replaced = true;
      fs.renameSync(f.output, f.output + '.owned');
      original.call(this, f.output, bytes);
    }
    return result;
  };
  try { assert.throws(() => writePrivateTemplate(f.output, value, []), e => e.category === 'integrity'); }
  finally { fs.writeFileSync = original; }
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(f.output, 'utf8'), JSON.stringify(value, null, 2) + '\n');
  assert.equal(fs.existsSync(f.output + '.owned'), true);
});

test('partial private write preserves uncertain bytes and its original IO error, never a success', t => {
  const f = fixture(t), original = fs.writeFileSync;
  const fault = Object.assign(new Error('Synthetic partial private file IO failure'), { code: 'EIO' });
  fs.writeFileSync = function(file, bytes, ...rest) {
    if (typeof file === 'number') { fs.writeSync(file, bytes.subarray(0, 7)); throw fault; }
    return original.call(this, file, bytes, ...rest);
  };
  try { assert.throws(() => writePrivateTemplate(f.output, { private: 'synthetic incomplete JSON' }, []), e => e === fault); }
  finally { fs.writeFileSync = original; }
  assert.equal(fs.readFileSync(f.output).length, 7);
  assert.throws(() => JSON.parse(fs.readFileSync(f.output, 'utf8')));
});

test('private cleanup removes only exact owned complete bytes and retains edited bytes', t => {
  const f = fixture(t), original = fs.writeFileSync;
  const fault = Object.assign(new Error('Synthetic late private write IO failure'), { code: 'EIO' });
  fs.writeFileSync = function(file, bytes, ...rest) {
    const result = original.call(this, file, bytes, ...rest);
    if (typeof file === 'number') throw fault;
    return result;
  };
  try { assert.throws(() => writePrivateTemplate(f.output, { private: 'exact bytes' }, []), e => e === fault); }
  finally { fs.writeFileSync = original; }
  assert.equal(fs.existsSync(f.output), false, 'only the exact owned completed write was removed after the error');
  fs.writeFileSync = function(file, bytes, ...rest) {
    const result = original.call(this, file, bytes, ...rest);
    if (typeof file === 'number') { original.call(this, f.output, 'Synthetic foreign byte mutation'); throw fault; }
    return result;
  };
  try { assert.throws(() => writePrivateTemplate(f.output, { private: 'not these bytes' }, []), e => e === fault); }
  finally { fs.writeFileSync = original; }
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'Synthetic foreign byte mutation');
});

test('a replaced private output ancestor is never traversed during cleanup', t => {
  const f = fixture(t), parent = path.join(f.root, 'private parent'); fs.mkdirSync(parent);
  const output = path.join(parent, 'worksheet.json'), moved = parent + '.owned';
  const original = fs.closeSync; let replaced = false;
  fs.closeSync = function(descriptor) {
    const result = original.call(this, descriptor);
    // Windows refuses parent rename while the file descriptor is open. Mutate at
    // the actual close boundary, before the production read-back/cleanup checks.
    if (!replaced && fs.existsSync(output)) {
      replaced = true;
      const bytes = fs.readFileSync(output);
      fs.renameSync(parent, moved); fs.mkdirSync(parent);
      fs.writeFileSync(output, bytes);
      fs.writeFileSync(path.join(parent, 'foreign-canary'), 'Preserve every foreign byte');
    }
    return result;
  };
  try { assert.throws(() => writePrivateTemplate(output, { private: 'same-byte replacement' }, []), e => e.category === 'integrity'); }
  finally { fs.closeSync = original; }
  assert.equal(fs.readFileSync(path.join(parent, 'foreign-canary'), 'utf8'), 'Preserve every foreign byte');
  assert.equal(fs.existsSync(output), true);
  assert.equal(fs.existsSync(path.join(moved, 'worksheet.json')), true);
});

test('private ordinary-path policy refuses streams, device names and aliases before any IO', t => {
  const f = fixture(t), file = path.join(f.root, 'foreign.json'); fs.writeFileSync(file, 'Preserve foreign base file');
  const before = fs.readdirSync(f.root);
  for (const leaf of ['foreign.json:stream', 'NUL', 'CON.json', 'CONIN$', 'CONOUT$', 'COM1.txt', 'LPT¹.txt', 'private.json.', 'private.json ', 'unsafe?.json']) {
    assert.throws(() => explicitFilePath(path.join(f.root, leaf)), e => e.category === 'integrity');
    assert.throws(() => writePrivateTemplate(path.join(f.root, leaf), { private: 'not written' }, []), e => e.category === 'integrity');
  }
  assert.deepEqual(fs.readdirSync(f.root), before);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Preserve foreign base file');
});
