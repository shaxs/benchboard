// Captain-owned S3 containment acceptance. All trees are synthetic and external.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stageRelease, ReleaseStageError } from '../../../release/staging.mjs';
import { createParticipantProfile } from '../../../release/profiles.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchboard-stage-'));
  const source = path.join(root, 'source');
  const output = path.join(root, 'stage');
  fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, 'assets'));
  fs.writeFileSync(path.join(source, 'assets', 'a.mjs'), 'synthetic bytes');
  const profile = { schemaVersion: '1.0.0', kind: 'ReleaseProfile', profile: 'synthetic',
    authorization: 'synthetic-only', entries: [{ path: 'lib/a.mjs', source: 'assets/a.mjs',
      bytes: Buffer.byteLength('synthetic bytes'), sha256: digest('synthetic bytes') }] };
  return { root, source, output, profile, stage: () => stageRelease({ sourceRoot: source, destination: output, profile }),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const code = (expected, retained = false) => (error) => error instanceof ReleaseStageError &&
  error.code === expected && error.retained === retained;
function withFixture(run) { const rig = fixture(); try { run(rig); } finally { rig.dispose(); } }

test('S3 stages only explicit bytes; decoys stay excluded; owned cleanup is idempotent', () => withFixture((rig) => {
  fs.writeFileSync(path.join(rig.source, '.env'), 'EXCLUDED_CANARY');
  fs.mkdirSync(path.join(rig.source, 'node_modules'));
  fs.writeFileSync(path.join(rig.source, 'node_modules', 'decoy'), 'EXCLUDED_CANARY');
  const before = fs.readFileSync(path.join(rig.source, 'assets', 'a.mjs'));
  const staged = rig.stage();
  assert.ok(Object.isFrozen(staged));
  assert.equal(staged.kind, 'StagedRelease');
  assert.deepEqual(fs.readdirSync(rig.output), ['lib']);
  assert.deepEqual(fs.readdirSync(path.join(rig.output, 'lib')), ['a.mjs']);
  assert.deepEqual(fs.readFileSync(path.join(rig.output, 'lib', 'a.mjs')), before);
  assert.deepEqual(fs.readFileSync(path.join(rig.source, 'assets', 'a.mjs')), before);
  staged.cleanup(); staged.cleanup();
  assert.equal(fs.existsSync(rig.output), false);
}));

test('S3 refuses source/output overlap, repository roots and existing destinations', () => withFixture((rig) => {
  assert.throws(() => stageRelease({ sourceRoot: rig.source, destination: path.join(rig.source, 'out'), profile: rig.profile }), code('RELEASE_STAGE_OVERLAP'));
  assert.throws(() => stageRelease({ sourceRoot: fileURLToPath(new URL('../../../', import.meta.url)), destination: rig.output, profile: rig.profile }), code('RELEASE_STAGE_OVERLAP'));
  fs.mkdirSync(rig.output);
  fs.writeFileSync(path.join(rig.output, 'foreign'), 'untouched');
  assert.throws(rig.stage, code('RELEASE_STAGE_EXISTS'));
  assert.equal(fs.readFileSync(path.join(rig.output, 'foreign'), 'utf8'), 'untouched');
}));

test('S3 refuses nonexplicit roots and participant staging while exposure is unresolved', () => withFixture((rig) => {
  assert.throws(() => stageRelease({ sourceRoot: '.', destination: rig.output, profile: rig.profile }), code('RELEASE_STAGE_ROOT'));
  assert.throws(() => stageRelease({ sourceRoot: rig.source, destination: rig.output, profile: createParticipantProfile() }), code('RELEASE_STAGE_PROFILE_BLOCKED'));
  assert.equal(fs.existsSync(rig.output), false);
}));

test('S3 refuses wrong source bytes/hash before creating output', () => withFixture((rig) => {
  rig.profile.entries[0].sha256 = '0'.repeat(64);
  assert.throws(rig.stage, code('RELEASE_STAGE_INTEGRITY'));
  assert.equal(fs.existsSync(rig.output), false);
}));

test('S3 refuses selected directories, hardlinks and junction ancestors without touching target', () => withFixture((rig) => {
  const file = path.join(rig.source, 'assets', 'a.mjs');
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.throws(rig.stage, code('RELEASE_STAGE_INTEGRITY'));
  fs.rmdirSync(file); fs.writeFileSync(file, 'synthetic bytes');
  fs.linkSync(file, path.join(rig.root, 'hardlink'));
  assert.throws(rig.stage, code('RELEASE_STAGE_INTEGRITY'));
  fs.unlinkSync(path.join(rig.root, 'hardlink'));
  const moved = path.join(rig.root, 'moved-assets');
  fs.renameSync(path.join(rig.source, 'assets'), moved);
  fs.symlinkSync(moved, path.join(rig.source, 'assets'), 'junction');
  assert.throws(rig.stage, code('RELEASE_STAGE_INTEGRITY'));
  assert.equal(fs.readFileSync(path.join(moved, 'a.mjs'), 'utf8'), 'synthetic bytes');
  assert.equal(fs.existsSync(rig.output), false);
}));

test('S3 cleanup retains foreign additions without deleting any selected bytes', () => withFixture((rig) => {
  const staged = rig.stage();
  fs.writeFileSync(path.join(rig.output, 'foreign'), 'foreign');
  assert.throws(staged.cleanup, code('RELEASE_STAGE_RETAINED', true));
  assert.equal(fs.readFileSync(path.join(rig.output, 'foreign'), 'utf8'), 'foreign');
  assert.equal(fs.readFileSync(path.join(rig.output, 'lib', 'a.mjs'), 'utf8'), 'synthetic bytes');
}));

for (const mutation of ['bytes', 'inode', 'root']) test(`S3 cleanup refuses ${mutation} replacement and retains foreign content`, () => withFixture((rig) => {
  const staged = rig.stage();
  const file = path.join(rig.output, 'lib', 'a.mjs');
  if (mutation === 'bytes') fs.writeFileSync(file, 'foreign');
  if (mutation === 'inode') { fs.renameSync(file, path.join(rig.root, 'original')); fs.writeFileSync(file, 'synthetic bytes'); }
  if (mutation === 'root') { fs.renameSync(rig.output, path.join(rig.root, 'original')); fs.mkdirSync(rig.output); fs.writeFileSync(path.join(rig.output, 'foreign'), 'foreign'); }
  assert.throws(staged.cleanup, code('RELEASE_STAGE_RETAINED', true));
  assert.equal(fs.existsSync(rig.output), true);
}));

test('S3 fixed generated replacement verifies expected bytes; unknown renderers refuse', () => withFixture((rig) => {
  const bytes = '{"schemaVersion":"1.0.0","kind":"SyntheticReleaseMetadata","publicRelease":false}\n';
  rig.profile.entries = [{ path: 'release-metadata.json', generated: 'synthetic-metadata-v1', bytes: Buffer.byteLength(bytes), sha256: digest(bytes) }];
  const staged = rig.stage();
  assert.equal(fs.readFileSync(path.join(rig.output, 'release-metadata.json'), 'utf8'), bytes);
  staged.cleanup();
  rig.profile.entries[0].sha256 = digest('poisoned generated metadata');
  assert.throws(rig.stage, code('RELEASE_STAGE_INTEGRITY'));
  assert.equal(fs.existsSync(rig.output), false);
  rig.profile.entries = [{ path: 'package.json', generated: 'tooling-package-v1', bytes: 0, sha256: digest('') }];
  assert.throws(rig.stage, code('RELEASE_STAGE_GENERATOR_UNAVAILABLE'));
  assert.equal(fs.existsSync(rig.output), false);
}));

test('S3 interrupted pre-write cleans only proved owned output', () => withFixture((rig) => {
  const original = fs.writeFileSync;
  fs.writeFileSync = (fd, ...args) => { if (typeof fd === 'number') throw new Error('SYNTHETIC_INTERRUPT'); return original(fd, ...args); };
  try { assert.throws(rig.stage, code('RELEASE_STAGE_FAILED')); }
  finally { fs.writeFileSync = original; }
  assert.equal(fs.existsSync(rig.output), false);
  assert.equal(fs.readFileSync(path.join(rig.source, 'assets', 'a.mjs'), 'utf8'), 'synthetic bytes');
}));

test('S3 detects source mutation after copy and removes only verified staging', () => withFixture((rig) => {
  const original = fs.writeFileSync;
  fs.writeFileSync = (fd, ...args) => {
    const result = original(fd, ...args);
    if (typeof fd === 'number') original(path.join(rig.source, 'assets', 'a.mjs'), 'changed by synthetic interleaving');
    return result;
  };
  try { assert.throws(rig.stage, code('RELEASE_STAGE_INTEGRITY')); }
  finally { fs.writeFileSync = original; }
  assert.equal(fs.existsSync(rig.output), false);
  assert.equal(fs.readFileSync(path.join(rig.source, 'assets', 'a.mjs'), 'utf8'), 'changed by synthetic interleaving');
}));

test('S3 partial interrupted write retains uncertain bytes rather than deleting them', () => withFixture((rig) => {
  const original = fs.writeFileSync;
  fs.writeFileSync = (fd, ...args) => {
    if (typeof fd !== 'number') return original(fd, ...args);
    original(fd, 'partial');
    throw new Error('SYNTHETIC_PARTIAL_INTERRUPT');
  };
  try { assert.throws(rig.stage, code('RELEASE_STAGE_FAILED', true)); }
  finally { fs.writeFileSync = original; }
  assert.equal(fs.readFileSync(path.join(rig.output, 'lib', 'a.mjs'), 'utf8'), 'partial');
}));

test('S3 cleanup refuses a replacement output junction without following it', () => withFixture((rig) => {
  const staged = rig.stage();
  const saved = path.join(rig.root, 'saved-stage');
  const foreign = path.join(rig.root, 'foreign');
  fs.renameSync(rig.output, saved);
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'keep'), 'foreign');
  fs.symlinkSync(foreign, rig.output, 'junction');
  assert.throws(staged.cleanup, code('RELEASE_STAGE_RETAINED', true));
  assert.equal(fs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'foreign');
  assert.equal(fs.readFileSync(path.join(saved, 'lib', 'a.mjs'), 'utf8'), 'synthetic bytes');
}));

test('S3 refuses a linked destination parent before creating any output', () => withFixture((rig) => {
  const foreign = path.join(rig.root, 'foreign-parent');
  fs.mkdirSync(foreign);
  const linked = path.join(rig.root, 'linked-parent');
  fs.symlinkSync(foreign, linked, 'junction');
  assert.throws(() => stageRelease({ sourceRoot: rig.source, destination: path.join(linked, 'stage'), profile: rig.profile }), code('RELEASE_STAGE_INTEGRITY'));
  assert.deepEqual(fs.readdirSync(foreign), []);
}));

test('S3 initial root identity-read failure retains and reports unreceipted output', () => withFixture((rig) => {
  const original = fs.lstatSync;
  const injected = new Error('SYNTHETIC_INITIAL_ROOT_RECEIPT_FAILURE');
  let fired = false;
  fs.lstatSync = (file, ...args) => {
    const stat = original(file, ...args);
    if (String(file) === rig.output && stat.isDirectory() && !fired) { fired = true; throw injected; }
    return stat;
  };
  try {
    assert.throws(rig.stage, (error) => {
      assert.ok(code('RELEASE_STAGE_FAILED', true)(error));
      assert.equal(error.cause, injected);
      assert.ok(code('RELEASE_STAGE_RETAINED', true)(error.cleanupError));
      return true;
    });
  } finally { fs.lstatSync = original; }
  assert.equal(fired, true);
  assert.equal(fs.statSync(rig.output).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(rig.output), []);
}));

test('S3 physical-only overlap refuses despite distinct ordinary lexical roots', () => withFixture((rig) => {
  const original = fs.realpathSync.native;
  const sourceParent = path.dirname(rig.source);
  let mapped = false;
  fs.realpathSync.native = (file, ...args) => {
    if (String(file) === sourceParent) { mapped = true; return rig.source; }
    return original(file, ...args);
  };
  try { assert.throws(rig.stage, code('RELEASE_STAGE_OVERLAP')); }
  finally { fs.realpathSync.native = original; }
  assert.equal(mapped, true);
  assert.equal(fs.existsSync(rig.output), false);
}));

test('S3 Windows roots must include a drive, not depend on the process current drive', { skip: process.platform !== 'win32' && 'Windows path grammar' }, () => withFixture((rig) => {
  assert.equal(process.platform, 'win32', 'this grammar acceptance targets the selected Windows host');
  for (const root of ['/x', '\\x', 'C:x']) {
    assert.throws(() => stageRelease({ sourceRoot: root, destination: rig.output, profile: rig.profile }), code('RELEASE_STAGE_ROOT'));
    assert.equal(fs.existsSync(rig.output), false);
  }
}));

test('S3 directory-prefix case aliases fail closed without weakening the S1 contract', { skip: process.platform !== 'win32' && 'Windows case-insensitive aliases' }, () => withFixture((rig) => {
  assert.equal(process.platform, 'win32', 'this case-alias fixture targets the selected Windows host');
  rig.profile.entries.push({ path: 'LIB/b.mjs', source: 'assets/b.mjs', bytes: 1, sha256: digest('b') });
  fs.writeFileSync(path.join(rig.source, 'assets', 'b.mjs'), 'b');
  assert.throws(rig.stage, code('RELEASE_STAGE_FAILED'));
  assert.equal(fs.existsSync(rig.output), false);
  assert.equal(fs.readFileSync(path.join(rig.source, 'assets', 'b.mjs'), 'utf8'), 'b');
}));
