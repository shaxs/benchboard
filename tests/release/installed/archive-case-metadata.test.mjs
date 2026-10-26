/** C7a.S4.T4 — case-aliasing of the reserved metadata path. Black-box: only the public
 *  buildSyntheticArchive / auditSyntheticArchive contracts are exercised, and the one case here
 *  targets an UPPERCASE actual filename (RELEASE-METADATA.JSON). Canonical positive build and
 *  independent audit first, then a same-length body poison refused by the audit with a matching
 *  declared file digest, then the same poisoned bytes on disk refused by the build while preserving
 *  the input. Fresh owned mkdtemp root under os.tmpdir, removed afterwards. No install, extraction,
 *  hook, process or shared scratch sweep; no OS alias or mount is used. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildSyntheticArchive } from '../../../release/archive-build.mjs';
import { auditSyntheticArchive, ArchiveIntegrityError } from '../../../release/archive-audit.mjs';

const NAME = 'RELEASE-METADATA.JSON';
const CANONICAL = '{"schemaVersion":"1.0.0","kind":"SyntheticReleaseMetadata","publicRelease":false}\n';
const REFUSAL = 'Synthetic archive integrity or limited content policy refused';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const refusesArchive = (error) => error instanceof ArchiveIntegrityError
  && error.code === 'RELEASE_ARCHIVE_REFUSED' && error.message === REFUSAL;
const view = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset ?? 0, bytes.byteLength);
const AT = CANONICAL.indexOf('false');
const POISONED = CANONICAL.slice(0, AT) + 'true ' + CANONICAL.slice(AT + 5);
const profileFor = (content) => ({ schemaVersion: '1.0.0', kind: 'ReleaseProfile',
  profile: 'synthetic', authorization: 'synthetic-only',
  entries: [{ path: NAME, source: 'origin.json',
    bytes: Buffer.byteLength(content), sha256: digest(content) }] });

test('S4 uppercase reserved filename alias: canonical passes, same-length poison refused both ways', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchboard-case-'));
  try {
    const stage = path.join(root, 'stage');
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, NAME), CANONICAL);
    const profile = profileFor(CANONICAL);
    const built = buildSyntheticArchive({ directory: stage, profile });
    const audit = auditSyntheticArchive(built.bytes, profile);
    assert.equal(audit.status, 'complete');
    assert.equal(audit.publicRelease, false);
    assert.equal(audit.archiveSha256, digest(built.bytes), 'archive digest covers the captured bytes');
    assert.equal(Buffer.byteLength(POISONED), Buffer.byteLength(CANONICAL), 'body-only same length');
    const header = Buffer.from(view(built.bytes).subarray(0, 512));
    view(built.bytes).write('true ', 512 + AT, 'ascii');
    assert.deepEqual(view(built.bytes).subarray(0, 512), header, 'header and checksum untouched');
    const payload = view(built.bytes).subarray(512, 512 + Buffer.byteLength(CANONICAL));
    assert.deepEqual(payload, Buffer.from(POISONED), 'only the payload body changed');
    const poisoned = profileFor(POISONED);
    assert.equal(poisoned.entries[0].bytes, payload.length, 'declared size matches the payload');
    assert.equal(poisoned.entries[0].sha256, digest(payload), 'declared hash matches the payload');
    assert.equal(poisoned.entries[0].generated, undefined, 'source origin carries no generated field');
    assert.throws(() => auditSyntheticArchive(built.bytes, poisoned), refusesArchive);
    fs.writeFileSync(path.join(stage, NAME), POISONED);
    assert.throws(() => buildSyntheticArchive({ directory: stage, profile: poisoned }), refusesArchive);
    assert.equal(fs.readFileSync(path.join(stage, NAME), 'utf8'), POISONED, 'refused build kept the input');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
