/** C7a.S4.T1 — independent archive-byte security acceptance. Black-box: only the public
 *  buildSyntheticArchive / auditSyntheticArchive / stageRelease contracts are exercised;
 *  mutation offsets and the checksum rule come from the task packet, not from the
 *  implementation. Every fixture is a fresh owned mkdtemp root under os.tmpdir, outside
 *  the repository, removed after the test. No process, server, install or extraction. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildSyntheticArchive } from '../../../release/archive-build.mjs';
import { auditSyntheticArchive, ArchiveIntegrityError } from '../../../release/archive-audit.mjs';
import { stageRelease } from '../../../release/staging.mjs';

const REPOSITORY = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const CANARY = 'CANARY_ARCHIVE_PRIVATE';
const DEFAULT_CONTENT = 'synthetic memory content';
const GENERATED = '{"schemaVersion":"1.0.0","kind":"SyntheticReleaseMetadata","publicRelease":false}\n';
const REFUSAL = 'Synthetic archive integrity or limited content policy refused';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const refusesArchive = (error) => error instanceof ArchiveIntegrityError &&
  error.code === 'RELEASE_ARCHIVE_REFUSED' && error.message === REFUSAL;
const view = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset ?? 0, bytes.byteLength);
const copy = (bytes) => Buffer.from(view(bytes));
/** Packet rule: blank 148..155 with spaces, sum all 512 header bytes, write six octal
 *  digits plus NUL and space at 148, so a refusal cannot be blamed on a stale checksum. */
const recalcChecksum = (bytes) => { const header = view(bytes);
  header.fill(32, 148, 156); let sum = 0;
  for (const byte of header.subarray(0, 512)) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii'); };
const setName = (bytes, name) => { const header = view(bytes);
  header.fill(0, 0, 100); header.write(name, 0, 'ascii'); };

function rig(content = DEFAULT_CONTENT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchboard-archive-'));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'input.txt'), content);
  const profile = { schemaVersion: '1.0.0', kind: 'ReleaseProfile', profile: 'synthetic',
    authorization: 'synthetic-only', entries: [{ path: 'lib/a.txt', source: 'input.txt',
      bytes: Buffer.byteLength(content), sha256: digest(content) }] };
  const stage = () => stageRelease({ sourceRoot: source, destination: path.join(root, 'stage'), profile });
  const build = (directory, over = profile) => buildSyntheticArchive({ directory, profile: over });
  return { root, source, profile, stage, build,
    dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function withRig(run, content = DEFAULT_CONTENT) {
  const fixture = rig(content); try { run(fixture); } finally { fixture.dispose(); }
}
const rehashed = (fixture, sha256) => ({ ...fixture.profile,
  entries: [{ ...fixture.profile.entries[0], sha256 }] });

test('S4 group 1: positive build audits independently; frozen evidence; rebuild identical; no extraction', () => withRig((fixture) => {
  const handle = fixture.stage();
  const before = fs.readdirSync(handle.directory, { recursive: true });
  const built = fixture.build(handle.directory);
  assert.ok(Object.isFrozen(built), 'build handle frozen');
  const audit = auditSyntheticArchive(built.bytes, fixture.profile);
  assert.deepEqual(audit.entries, [{ path: 'lib/a.txt',
    bytes: Buffer.byteLength(DEFAULT_CONTENT), sha256: digest(DEFAULT_CONTENT) }]);
  assert.deepEqual({ schemaVersion: audit.schemaVersion, kind: audit.kind, status: audit.status,
    publicRelease: audit.publicRelease, contentPolicy: audit.contentPolicy },
    { schemaVersion: '1.0.0', kind: 'SyntheticArchiveAudit', status: 'complete',
      publicRelease: false, contentPolicy: 'synthetic-utf8-markers-v1' });
  assert.equal(audit.archiveSha256, digest(built.bytes), 'digest is SHA-256 of the captured bytes');
  assert.match(audit.inventorySha256, /^[0-9a-f]{64}$/);
  assert.equal(audit.inventorySha256, digest(JSON.stringify(audit.entries)),
    'inventory digest is SHA-256 of the JSON inventory');
  assert.deepEqual(built.audit, audit, 'build-captured audit equals the independent audit');
  assert.ok(Object.isFrozen(audit) && Object.isFrozen(audit.entries) && Object.isFrozen(audit.entries[0]));
  assert.deepEqual(fs.readdirSync(handle.directory, { recursive: true }), before, 'audit extracted nothing');
  assert.deepEqual(copy(fixture.build(handle.directory).bytes), copy(built.bytes), 'rebuild byte-identical');
  assert.equal(fs.readFileSync(path.join(fixture.source, 'input.txt'), 'utf8'), DEFAULT_CONTENT);
}));

/* Group 2 — header mutations that keep a correct checksum, so a refusal is policy, not rot. */
const HEADER_CASES = [
  ['typeflag 2 (symlink)', (b) => { b[156] = 0x32; recalcChecksum(b); }],
  ['typeflag 5 (directory)', (b) => { b[156] = 0x35; recalcChecksum(b); }],
  ['typeflag x (other)', (b) => { b[156] = 0x78; recalcChecksum(b); }],
  ['traversal name ../x', (b) => { setName(b, '../x'); recalcChecksum(b); }],
  ['excluded name workflow/private.txt', (b) => { setName(b, 'workflow/private.txt'); recalcChecksum(b); }],
  ['filename byte value 255 at offset 0', (b) => { b[0] = 255; recalcChecksum(b); }],
  ['bad checksum without recalc', (b) => { b[156] = 0x32; }],
];
for (const [label, mutate] of HEADER_CASES) test(`S4 group 2: header ${label} refused`, () => withRig((fixture) => {
  const handle = fixture.stage();
  const built = fixture.build(handle.directory);
  const work = copy(built.bytes);
  mutate(work);
  assert.throws(() => auditSyntheticArchive(work, fixture.profile), refusesArchive);
}));

/* Group 3 — record-structure refusals: duplicates, framing, padding and size-field rot. */
const STRUCTURAL_CASES = [
  ['duplicate same record before end blocks', (b) => Buffer.concat([b.subarray(0, 1024), b.subarray(0, 1024), b.subarray(1024)])],
  ['missing end blocks', (b) => copy(b.subarray(0, 1024))],
  ['truncation off block boundary', (b) => copy(b.subarray(0, 1999))],
  ['trailing nonzero byte after end blocks', (b) => Buffer.concat([b, Buffer.from([0x78])])],
  ['nonzero padding byte after payload', (b) => { const w = copy(b); w[600] = 0x41; return w; }],
  ['size field digit 9 with recomputed checksum', (b) => { const w = copy(b); const h = view(w);
    h.fill(0, 124, 136); h.write('9'.repeat(11) + '\0', 124, 'ascii'); recalcChecksum(w); return w; }],
];
for (const [label, mutate] of STRUCTURAL_CASES) test(`S4 group 3: ${label} refused`, () => withRig((fixture) => {
  const handle = fixture.stage();
  const built = fixture.build(handle.directory);
  assert.throws(() => auditSyntheticArchive(mutate(built.bytes), fixture.profile), refusesArchive);
}));

/* Group 4 — contamination of an allowed file: digest matching must not outrank content policy. */
test('S4 group 4: canary payload with matching declared digest still refused on content policy', () => withRig((fixture) => {
  const handle = fixture.stage();
  const built = fixture.build(handle.directory);
  const work = copy(built.bytes);
  view(work).write(CANARY, 512, CANARY.length, 'ascii');
  /* The expected hash is the FILE PAYLOAD digest only, never a digest of the whole tar, so
   * ordinary size/digest checks must pass and the refusal can only come from content policy. */
  const payload = view(work).subarray(512, 512 + fixture.profile.entries[0].bytes);
  const poisoned = rehashed(fixture, digest(payload));
  assert.deepEqual(payload, Buffer.from(CANARY));
  assert.equal(poisoned.entries[0].bytes, payload.length, 'declared size still matches the payload');
  assert.equal(poisoned.entries[0].sha256, digest(payload), 'declared hash still matches the payload');
  assert.throws(() => auditSyntheticArchive(work, poisoned), refusesArchive);
}, 'x'.repeat(CANARY.length)));

test('S4 group 4: canary directly in selected source refuses build with no result', () => withRig((fixture) => {
  const handle = fixture.stage();
  assert.throws(() => fixture.build(handle.directory), refusesArchive);
}, CANARY));

test('S4 group 4: canary-bearing extra file in stage tree refuses build, not silently ignored', () => withRig((fixture) => {
  const handle = fixture.stage();
  fs.mkdirSync(path.join(handle.directory, 'extra'));
  fs.writeFileSync(path.join(handle.directory, 'extra', 'canary.txt'), CANARY);
  assert.throws(() => fixture.build(handle.directory), refusesArchive);
  assert.equal(fs.readFileSync(path.join(handle.directory, 'extra', 'canary.txt'), 'utf8'), CANARY);
}));

/* Group 5 — poisoned fixed-renderer metadata: byte-identical length, refreshed digest, refused. */
test('S4 group 5: false to true-spaces metadata mutation refused despite fresh digest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchboard-archive-'));
  try {
    const stage = path.join(root, 'stage');
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, 'release-metadata.json'), GENERATED);
    const profile = { schemaVersion: '1.0.0', kind: 'ReleaseProfile', profile: 'synthetic',
      authorization: 'synthetic-only', entries: [{ path: 'release-metadata.json',
        generated: 'synthetic-metadata-v1', bytes: Buffer.byteLength(GENERATED), sha256: digest(GENERATED) }] };
    const built = buildSyntheticArchive({ directory: stage, profile });
    assert.equal(auditSyntheticArchive(built.bytes, profile).status, 'complete');
    const at = GENERATED.indexOf('false');
    const poisonedText = GENERATED.slice(0, at) + 'true ' + GENERATED.slice(at + 5);
    assert.equal(Buffer.byteLength(poisonedText), Buffer.byteLength(GENERATED));
    const work = copy(built.bytes);
    view(work).write('true ', 512 + at, 'ascii');
    const poisoned = { ...profile, entries: [{ ...profile.entries[0], sha256: digest(poisonedText) }] };
    assert.throws(() => auditSyntheticArchive(work, poisoned), refusesArchive);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* Group 6 — invalid UTF-8 refusal: a lone 0xff byte cannot decode as UTF-8 text. This proves
   invalid-UTF-8 refusal for the synthetic text policy, not a general binary-file classifier. */
test('S4 group 6: single 0xff payload byte with refreshed payload digest still refused', () => withRig((fixture) => {
  const handle = fixture.stage();
  const built = fixture.build(handle.directory);
  const work = copy(built.bytes);
  work[512] = 0xff;
  /* Payload-only expected hash: the size/digest pair matches the mutated bytes exactly, so the
   * refusal comes from UTF-8 decoding, not from an unrelated hash mismatch. */
  const payload = view(work).subarray(512, 512 + fixture.profile.entries[0].bytes);
  const poisoned = rehashed(fixture, digest(payload));
  assert.equal(payload.length, poisoned.entries[0].bytes, 'declared size still matches the payload');
  assert.equal(poisoned.entries[0].sha256, digest(payload), 'declared hash still matches the payload');
  assert.throws(() => auditSyntheticArchive(work, poisoned), refusesArchive);
}, 'x'));

/* Group 7 — returned bytes are mutable; a captured audit never transfers to later mutations. */
test('S4 group 7: audit digest stops matching once caller mutates the bytes', () => withRig((fixture) => {
  const handle = fixture.stage();
  const built = fixture.build(handle.directory);
  const audit = auditSyntheticArchive(built.bytes, fixture.profile);
  assert.equal(audit.archiveSha256, digest(built.bytes));
  assert.equal(audit.publicRelease, false, 'no public completion can be inferred');
  built.bytes[512] = 0x53;
  assert.notEqual(audit.archiveSha256, digest(built.bytes));
  assert.throws(() => auditSyntheticArchive(built.bytes, fixture.profile), refusesArchive);
}));

test('S4 group 7: audit reads only the bytes it is given and never edits them', () => withRig((fixture) => {
  const handle = fixture.stage();
  const built = fixture.build(handle.directory);
  const given = copy(built.bytes);
  const captured = copy(built.bytes);
  handle.cleanup();
  assert.equal(fs.existsSync(handle.directory), false);
  assert.equal(auditSyntheticArchive(given, fixture.profile).archiveSha256, digest(captured),
    'audit needs no stage tree');
  assert.deepEqual(given, captured, 'audit copied the bytes instead of rewriting them');
}));

/* Group 8 — source boundary: bytes and identity decide, not names, defaults or inventories. */
test('S4 group 8: wrong hash, hardlink, unapproved directory and live repository root all refuse build', () => withRig((fixture) => {
  const handle = fixture.stage();
  const file = path.join(handle.directory, 'lib', 'a.txt');
  const original = fs.readFileSync(file);
  assert.throws(() => fixture.build(handle.directory, rehashed(fixture, '0'.repeat(64))), refusesArchive);
  assert.deepEqual(fs.readFileSync(file), original);
  fs.linkSync(file, path.join(fixture.root, 'hardlink'));
  assert.throws(() => fixture.build(handle.directory), refusesArchive);
  fs.unlinkSync(path.join(fixture.root, 'hardlink'));
  assert.deepEqual(fs.readFileSync(file), original);
  fs.mkdirSync(path.join(handle.directory, 'unapproved'));
  assert.throws(() => fixture.build(handle.directory), refusesArchive);
  assert.ok(fs.existsSync(path.join(handle.directory, 'unapproved')), 'not silently deleted');
  assert.throws(() => fixture.build(REPOSITORY), refusesArchive);
}));
