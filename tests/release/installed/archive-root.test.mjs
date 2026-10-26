/** C7a.S4.T5 — boundary-only ancestor refusal. Black-box: only the public
 *  buildSyntheticArchive contract is exercised against the repository root
 *  itself and its parent directory, both of which are boundary ancestors a
 *  caller must never be able to stage from. A TEST-LOCAL fs.readdirSync stub
 *  records calls and throws before touching the real filesystem; the refusal
 *  must happen prior to any enumeration, so enumerationCount stays 0 (the
 *  load-bearing guard: a wrapped incidental inventory error would otherwise
 *  look identical). No implementation reading, no fixture staging, no real
 *  root walk, no installs, processes or scratch. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createHash } from 'node:crypto';
import { buildSyntheticArchive } from '../../../release/archive-build.mjs';
import { ArchiveIntegrityError } from '../../../release/archive-audit.mjs';

const REFUSAL = 'Synthetic archive integrity or limited content policy refused';
const repo = url.fileURLToPath(new URL('../../../', import.meta.url));
const ancestors = [path.parse(repo).root, path.dirname(repo)];
const profile = { schemaVersion: '1.0.0', kind: 'ReleaseProfile',
  profile: 'synthetic', authorization: 'synthetic-only',
  entries: [{ path: 'a.txt', source: 'a.txt',
    bytes: 0, sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex') }] };

test('S4 repository root and parent refuse as ancestors before any directory enumeration', () => {
  const original = fs.readdirSync;
  let enumerationCount = 0;
  fs.readdirSync = (...args) => {
    enumerationCount += 1;
    throw new Error('UNEXPECTED_ENUMERATION');
  };
  try {
    for (const directory of ancestors) {
      assert.throws(() => buildSyntheticArchive({ directory, profile }), (error) =>
        error instanceof ArchiveIntegrityError
        && error.code === 'RELEASE_ARCHIVE_REFUSED'
        && error.message === REFUSAL);
    }
    assert.equal(enumerationCount, 0, 'refusal precedes all directory enumeration');
  } finally {
    fs.readdirSync = original;
    assert.equal(fs.readdirSync, original, 'stub restored in finally');
  }
});
