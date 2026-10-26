/** C7a.S4.T3 — the reserved metadata path enforces canonical bytes independently of a caller
 *  source-origin label: a source entry with no generated field is still policy-bound. Black-box
 *  over the public buildSyntheticArchive / auditSyntheticArchive only; offsets and expected
 *  values come from the task packet, not from the implementation. Every fixture is a fresh owned
 *  mkdtemp root under os.tmpdir outside the repository, removed in finally. No process, install
 *  or extraction, and no raw NUL source bytes. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildSyntheticArchive } from '../../../release/archive-build.mjs';
import { auditSyntheticArchive, ArchiveIntegrityError } from '../../../release/archive-audit.mjs';

const CANONICAL = '{"schemaVersion":"1.0.0","kind":"SyntheticReleaseMetadata","publicRelease":false}\n';
const SOURCE = 'declared-origin.json';
const REFUSAL = 'Synthetic archive integrity or limited content policy refused';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const refuses = (error) => error instanceof ArchiveIntegrityError &&
  error.code === 'RELEASE_ARCHIVE_REFUSED' && error.message === REFUSAL;
const sourceProfile = (body) => ({ schemaVersion: '1.0.0', kind: 'ReleaseProfile',
  profile: 'synthetic', authorization: 'synthetic-only',
  entries: [{ path: 'release-metadata.json', source: SOURCE,
    bytes: Buffer.byteLength(body), sha256: digest(body) }] });

function rig(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchboard-source-origin-'));
  const stage = path.join(root, 'stage');
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, 'release-metadata.json'), body);
  return { root, stage, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('S4 reserved source-origin metadata: canonical builds and audits clean, then the false-to-true body with a refreshed matching payload hash still refuses', () => {
  const fixture = rig(CANONICAL);
  try {
    const profile = sourceProfile(CANONICAL);
    const built = buildSyntheticArchive({ directory: fixture.stage, profile });
    const audit = auditSyntheticArchive(built.bytes, profile);
    assert.equal(audit.status, 'complete');
    assert.equal(audit.publicRelease, false);
    assert.deepEqual(audit.entries, [{ path: 'release-metadata.json',
      bytes: Buffer.byteLength(CANONICAL), sha256: digest(CANONICAL) }]);
    assert.equal(audit.archiveSha256, digest(built.bytes), 'archive digest binds the actual bytes');

    const at = CANONICAL.indexOf('false');
    const poisoned = CANONICAL.slice(0, at) + 'true ' + CANONICAL.slice(at + 5);
    assert.equal(Buffer.byteLength(poisoned), Buffer.byteLength(CANONICAL), 'same-length body change');
    const work = Buffer.from(built.bytes);
    work.write('true ', 512 + at, 'ascii');

    const payload = work.subarray(512, 512 + Buffer.byteLength(CANONICAL));
    assert.deepEqual(payload, Buffer.from(poisoned), 'mutation is exactly the poisoned body');
    const refreshed = { ...profile, entries: [{ ...profile.entries[0], sha256: digest(payload) }] };
    assert.equal(refreshed.entries[0].bytes, payload.length, 'declared size matches the mutated payload');
    assert.equal(refreshed.entries[0].sha256, digest(payload), 'declared hash matches the mutated payload');
    assert.equal(refreshed.entries[0].source, SOURCE, 'source origin label is still present');
    assert.equal('generated' in refreshed.entries[0], false, 'the entry carries no generated field');

    assert.throws(() => auditSyntheticArchive(work, refreshed), refuses,
      'the reserved path enforces canonical metadata independently of the caller source label');
  } finally { fixture.dispose(); }
});

test('S4 reserved source-origin metadata: build refuses the poisoned body staged with its exact declared size and hash, inputs unchanged and no completion object', () => {
  const at = CANONICAL.indexOf('false');
  const poisoned = CANONICAL.slice(0, at) + 'true ' + CANONICAL.slice(at + 5);
  const fixture = rig(poisoned);
  try {
    const profile = sourceProfile(poisoned);
    let completion;
    assert.throws(() => { completion = buildSyntheticArchive({ directory: fixture.stage, profile }); },
      refuses);
    assert.equal(completion, undefined, 'failure returns no completion object');
    assert.equal(fs.readFileSync(path.join(fixture.stage, 'release-metadata.json'), 'utf8'), poisoned,
      'staged input bytes unchanged after the refusal');
  } finally { fixture.dispose(); }
});
