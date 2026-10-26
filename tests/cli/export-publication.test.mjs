// Captain ownership/fate diagnostics. Real C5 privacy projection over synthetic C4 protocol only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { makePublicationFixture } from '../results/publication-fixture.mjs';
import { createExportProjection } from '../../packages/results/export-contract.mjs';
import { renderReportJSON, renderReportText } from '../../packages/results/exports.mjs';
import { publishSafeExport, EXPORT_NAMES, EXPORT_MARKER } from '../../cli/export-publication.mjs';

async function ready(t) {
  const p = await makePublicationFixture(t), projection = createExportProjection(p.report);
  return { p, projection, output: path.join(p.fixture.root, 'safe export output'),
    json: renderReportJSON(projection), text: renderReportText(projection), protectedRoots: [p.runRoot, p.storeRoot] };
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fault = () => Object.assign(new Error('Synthetic export publication IO fault'), { code: 'EIO' });
function verifyPair(r) {
  assert.deepEqual(fs.readdirSync(r.output).sort(), [...EXPORT_NAMES, EXPORT_MARKER].sort());
  assert.equal(fs.readFileSync(path.join(r.output, 'report.json'), 'utf8'), r.json);
  assert.equal(fs.readFileSync(path.join(r.output, 'report.txt'), 'utf8'), r.text);
  const markerText = fs.readFileSync(path.join(r.output, EXPORT_MARKER), 'utf8'), marker = JSON.parse(markerText);
  assert.deepEqual(Object.keys(marker).sort(), ['files', 'kind', 'schemaVersion']);
  assert.equal(marker.kind, 'benchboard.cli.safe-export.v1');
  assert.equal(marker.schemaVersion, '1.0.0');
  assert.deepEqual(marker.files, EXPORT_NAMES.map(name => {
    const bytes = fs.readFileSync(path.join(r.output, name));
    return { path: name, bytes: bytes.length, sha256: sha(bytes) };
  }));
  for (const secret of [r.p.report.reportId, r.p.runRoot, r.p.evaluationRoot]) {
    for (const name of [...EXPORT_NAMES, EXPORT_MARKER]) assert.equal(fs.readFileSync(path.join(r.output, name), 'utf8').includes(secret), false);
  }
}

test('safe pair publishes fixed matching files and a closed marker, never overwrites an existing output', async t => {
  const r = await ready(t), result = publishSafeExport(r);
  assert.equal(result.complete, true);
  assert.equal(Object.isFrozen(result), true);
  verifyPair(r);
  const before = [...EXPORT_NAMES, EXPORT_MARKER].map(name => fs.readFileSync(path.join(r.output, name)));
  assert.throws(() => publishSafeExport(r), error => error.category === 'state');
  for (const [index, name] of [...EXPORT_NAMES, EXPORT_MARKER].entries()) assert.deepEqual(fs.readFileSync(path.join(r.output, name)), before[index]);
});

test('invalid/mismatched safe content and unsafe destinations refuse before output creation', async t => {
  const r = await ready(t);
  assert.throws(() => publishSafeExport({ ...r, json: JSON.stringify(r.p.report) }));
  assert.equal(fs.existsSync(r.output), false);
  assert.throws(() => publishSafeExport({ ...r, text: r.text + ' PRIVATE_UNSAFE_APPEND' }), error => error.category === 'integrity');
  assert.equal(fs.existsSync(r.output), false);
  for (const output of [path.join(r.p.runRoot, 'unsafe'), r.output + ':stream', path.join(r.p.fixture.root, 'elsewhere', '..', 'unsafe')]) {
    // Preserve a literal dot spelling; path.join intentionally normalizes its own arguments.
    const literal = output.endsWith(path.sep + 'unsafe') && !output.startsWith(r.p.runRoot) ? r.p.fixture.root + '/elsewhere/../unsafe' : output;
    assert.throws(() => publishSafeExport({ ...r, output: literal }));
    assert.equal(fs.existsSync(output), false);
  }
  const linked = path.join(r.p.fixture.root, 'linked export parent'); fs.symlinkSync(r.p.reviewRoot, linked, 'junction');
  assert.throws(() => publishSafeExport({ ...r, output: path.join(linked, 'unsafe') }));
  assert.equal(fs.existsSync(path.join(r.p.reviewRoot, 'unsafe')), false);
});

test('a partial file write retains uncertain bytes and original error without a completion marker', async t => {
  const r = await ready(t), original = fs.writeFileSync, failure = fault(); let calls = 0;
  fs.writeFileSync = function(file, bytes, ...rest) {
    if (typeof file === 'number' && ++calls === 2) { original.call(this, file, bytes.subarray(0, 7)); throw failure; }
    return original.call(this, file, bytes, ...rest);
  };
  try { assert.throws(() => publishSafeExport(r), error => error === failure); }
  finally { fs.writeFileSync = original; }
  assert.deepEqual(failure.exportFate, { complete: false, cleanup: 'retained' });
  assert.equal(fs.existsSync(path.join(r.output, EXPORT_MARKER)), false);
  assert.equal(fs.existsSync(path.join(r.output, 'report.json')), false, 'the exact owned complete first file was retired');
  assert.equal(fs.readFileSync(path.join(r.output, 'report.txt')).length, 7, 'partial bytes cannot be guessed owned for removal');
});

test('a failure after the marker write retains the verifiably complete export but still throws the original error', async t => {
  const r = await ready(t), original = fs.writeFileSync, failure = fault(); let calls = 0;
  fs.writeFileSync = function(file, bytes, ...rest) {
    const result = original.call(this, file, bytes, ...rest);
    if (typeof file === 'number' && ++calls === 3) throw failure;
    return result;
  };
  try { assert.throws(() => publishSafeExport(r), error => error === failure); }
  finally { fs.writeFileSync = original; }
  assert.deepEqual(failure.exportFate, { complete: true, cleanup: 'retained' });
  verifyPair(r);
});

test('a same-byte foreign replacement is retained, never adopted as an owned completed export', async t => {
  const r = await ready(t), original = fs.closeSync; let changed = false;
  const jsonFile = path.join(r.output, 'report.json'), moved = path.join(r.p.fixture.root, 'retained owned export json');
  fs.closeSync = function(descriptor) {
    const result = original.call(this, descriptor);
    if (!changed && fs.existsSync(jsonFile)) {
      changed = true;
      const bytes = fs.readFileSync(jsonFile); fs.renameSync(jsonFile, moved); fs.writeFileSync(jsonFile, bytes);
    }
    return result;
  };
  let error;
  try { publishSafeExport(r); assert.fail('replacement must refuse'); } catch (caught) { error = caught; }
  finally { fs.closeSync = original; }
  assert.equal(changed, true);
  assert.equal(error.category, 'integrity');
  assert.deepEqual(error.exportFate, { complete: false, cleanup: 'retained' });
  assert.equal(fs.readFileSync(jsonFile, 'utf8'), r.json);
  assert.equal(fs.readFileSync(moved, 'utf8'), r.json);
  assert.equal(fs.existsSync(path.join(r.output, EXPORT_MARKER)), false);
});

test('foreign residue before marker creation is preserved while only proven-owned pair files are cleaned', async t => {
  const r = await ready(t), original = fs.closeSync; let closes = 0, changed = false;
  fs.closeSync = function(descriptor) {
    const result = original.call(this, descriptor);
    // Production close/readback also closes read-only descriptors: identify pair presence,
    // not a guessed universal close count.
    if (!changed && fs.existsSync(path.join(r.output, 'report.txt'))) {
      changed = true; fs.writeFileSync(path.join(r.output, 'foreign-canary'), 'PRIVATE_FOREIGN_NOT_AN_EXPORT');
    }
    closes++;
    return result;
  };
  let error;
  try { publishSafeExport(r); assert.fail('residue must refuse'); } catch (caught) { error = caught; }
  finally { fs.closeSync = original; }
  assert.ok(closes > 0 && changed);
  assert.equal(error.category, 'integrity');
  assert.deepEqual(error.exportFate, { complete: false, cleanup: 'retained' });
  assert.deepEqual(fs.readdirSync(r.output), ['foreign-canary']);
  assert.equal(fs.readFileSync(path.join(r.output, 'foreign-canary'), 'utf8'), 'PRIVATE_FOREIGN_NOT_AN_EXPORT');
});

test('a replaced export root is not entered for readback or cleanup', async t => {
  const r = await ready(t), originalClose = fs.closeSync, originalOpen = fs.openSync;
  const moved = r.output + '.owned'; let changed = false, foreignReads = 0;
  fs.openSync = function(file, flags, ...rest) {
    if (changed && String(file).startsWith(r.output + path.sep) && flags !== 'wx') foreignReads++;
    return originalOpen.call(this, file, flags, ...rest);
  };
  fs.closeSync = function(descriptor) {
    const result = originalClose.call(this, descriptor);
    if (!changed && fs.existsSync(path.join(r.output, 'report.json'))) {
      changed = true; fs.renameSync(r.output, moved); fs.mkdirSync(r.output);
      fs.writeFileSync(path.join(r.output, 'foreign-canary'), 'Preserve substituted directory');
    }
    return result;
  };
  let error;
  try { publishSafeExport(r); assert.fail('root replacement must refuse'); } catch (caught) { error = caught; }
  finally { fs.closeSync = originalClose; fs.openSync = originalOpen; }
  assert.equal(changed, true);
  assert.equal(error.category, 'integrity');
  assert.equal(foreignReads, 0, 'ownership failure is detected before opening foreign files');
  assert.equal(fs.readFileSync(path.join(r.output, 'foreign-canary'), 'utf8'), 'Preserve substituted directory');
  assert.equal(fs.existsSync(path.join(moved, 'report.json')), true);
  assert.deepEqual(error.exportFate, { complete: false, cleanup: 'retained' });
});

test('parent replacement refuses even when the original owned root and file objects return at the same paths', async t => {
  const r = await ready(t), parent = path.join(r.p.fixture.root, 'dedicated export parent'); fs.mkdirSync(parent);
  r.output = path.join(parent, 'safe output');
  const movedParent = parent + '.owned', original = fs.closeSync; let changed = false, rootInode;
  fs.closeSync = function(descriptor) {
    const result = original.call(this, descriptor);
    if (!changed && fs.existsSync(path.join(r.output, 'report.json'))) {
      changed = true; rootInode = fs.lstatSync(r.output).ino;
      fs.renameSync(parent, movedParent); fs.mkdirSync(parent);
      fs.renameSync(path.join(movedParent, 'safe output'), r.output);
      fs.writeFileSync(path.join(r.output, 'foreign-canary'), 'Preserve replaced parent material');
    }
    return result;
  };
  let error;
  try { publishSafeExport(r); assert.fail('parent replacement must refuse'); } catch (caught) { error = caught; }
  finally { fs.closeSync = original; }
  assert.equal(changed, true);
  assert.equal(fs.lstatSync(r.output).ino, rootInode, 'root identity alone cannot detect a replaced ancestor');
  assert.equal(error.category, 'integrity');
  assert.equal(fs.readFileSync(path.join(r.output, 'report.json'), 'utf8'), r.json);
  assert.equal(fs.readFileSync(path.join(r.output, 'foreign-canary'), 'utf8'), 'Preserve replaced parent material');
  assert.deepEqual(error.exportFate, { complete: false, cleanup: 'retained' });
});

test('same-object content tampering after marker write cannot remain a completed export', async t => {
  const r = await ready(t), original = fs.closeSync; let changed = false;
  fs.closeSync = function(descriptor) {
    const result = original.call(this, descriptor);
    if (!changed && fs.existsSync(path.join(r.output, EXPORT_MARKER))) {
      changed = true;
      const file = path.join(r.output, 'report.json'), bytes = fs.readFileSync(file);
      bytes[0] = bytes[0] === 123 ? 91 : 123; fs.writeFileSync(file, bytes);
    }
    return result;
  };
  let error;
  try { publishSafeExport(r); assert.fail('tampered content cannot complete'); } catch (caught) { error = caught; }
  finally { fs.closeSync = original; }
  assert.equal(changed, true);
  assert.equal(error.category, 'integrity');
  assert.deepEqual(error.exportFate, { complete: false, cleanup: 'retained' });
  assert.deepEqual(fs.readdirSync(r.output), ['report.json'], 'the uncertain changed file remains, the exact owned marker and text are retired');
  assert.equal(fs.statSync(path.join(r.output, 'report.json')).size, Buffer.byteLength(r.json));
});
