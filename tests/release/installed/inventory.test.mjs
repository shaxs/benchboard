// C7a.S1 installed-contract test group 1 — static checks against the accepted C0
// inventory in release/inventory.json.
//
// This file is a synthetic first installed-contract test: it reads the accepted
// inventory and the 26 explicitly listed starter files, and asserts their shape
// and bytes. It performs no installation, writes nothing, recurses nothing and
// makes no installed-workflow or public-release claim. Registry-tier integration
// is the Captain's decision, not this file's.
//
// The repository root is three levels up from tests/release/installed/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const REPO_ROOT = new URL('../../../', import.meta.url);
const INVENTORY_URL = new URL('release/inventory.json', REPO_ROOT);

const inventory = JSON.parse(readFileSync(INVENTORY_URL, 'utf8'));

// ---------------------------------------------------------------------------
// Group 1 — schema discriminator, file count and exact allowlist set equality
// ---------------------------------------------------------------------------
// The schema string is the strict discriminator asserted first: an unknown or
// future inventory version fails here, so no later group can misread its shape.

test('1 — inventory schema, participant fileCount and the exact allowlist path set', () => {
  assert.equal(inventory.schema, 'benchboard.c0.participant-inventory/1');

  const { files } = inventory.participant;
  assert.equal(inventory.participant.fileCount, 26);
  assert.equal(Array.isArray(files), true);
  assert.equal(files.length, 26);

  // Every listed path is a clean relative POSIX path with no duplicate.
  const seen = new Set();
  for (const entry of files) {
    const p = entry.path;
    assert.equal(typeof p, 'string');
    assert.equal(p.includes('\\'), false);
    assert.equal(p.startsWith('/'), false);
    assert.equal(/^[A-Za-z]:/.test(p), false);
    const segments = p.split('/');
    for (const segment of segments) {
      assert.ok(segment.length > 0);
      assert.notEqual(segment, '.');
      assert.notEqual(segment, '..');
    }
    assert.equal(seen.has(p), false);
    seen.add(p);
  }
  assert.equal(seen.size, 26);

  // The path set equals profiles.participant.allowlist exactly.
  const allowlist = inventory.profiles.participant.allowlist;
  assert.equal(Array.isArray(allowlist), true);
  assert.equal(allowlist.length, 26);
  assert.equal(new Set(allowlist).size, 26);
  assert.deepEqual([...seen].sort(), [...allowlist].sort());
});

// ---------------------------------------------------------------------------
// Group 2 — the explicit files on disk: ordinary non-link, exact bytes, exact hash
// ---------------------------------------------------------------------------
// Hashes cover only these 26 explicit paths; nothing is enumerated or recursed,
// in particular not starter/node_modules.

test('2 — every explicit participant path is an ordinary non-link file with exact bytes and SHA-256', () => {
  for (const entry of inventory.participant.files) {
    const target = fileURLToPath(new URL(`starter/${entry.path}`, REPO_ROOT));
    // lstat does not follow a link, so a symlink never reports as a regular file.
    const st = lstatSync(target);
    assert.equal(st.isSymbolicLink(), false, `${entry.path} is a symbolic link`);
    assert.equal(st.isFile(), true, `${entry.path} is not an ordinary file`);

    const raw = readFileSync(target);
    assert.equal(raw.byteLength, entry.bytes, `${entry.path} byte length`);
    assert.equal(
      createHash('sha256').update(raw).digest('hex'),
      entry.sha256,
      `${entry.path} sha256`,
    );
  }
});

// ---------------------------------------------------------------------------
// Group 3 — profile decisions and release status: nothing is approved
// ---------------------------------------------------------------------------
// These assertions read only the recorded decisions. They infer no evaluator
// asset exception, no license selection and no release approval.

test('3 — profile decisions and releaseStatus carry no approval', () => {
  assert.equal(inventory.profiles.participant.decision, 'ALLOWLIST_ONLY');
  assert.equal(
    inventory.profiles.ownerDevelopmentInstallation.decision,
    'NOT_FOR_EXTERNAL_RELEASE',
  );
  assert.equal(inventory.profiles.endUserToolingInstallation.decision, 'BLOCKED');

  assert.equal(inventory.releaseStatus.approved, false);
  assert.equal(inventory.releaseStatus.published, false);
  assert.equal(inventory.releaseStatus.licenseSelected, false);
});

// ---------------------------------------------------------------------------
// Group 4 — protected-area exclusion and exactly-one config files
// ---------------------------------------------------------------------------

test('4 — participant path set excludes protected areas and has one each of the config files', () => {
  // Directory names that must not appear as any path segment of a participant file.
  const FORBIDDEN_SEGMENTS = [
    'reference',
    'evaluator',
    'runner',
    'spec',
    'workflow',
    'artifacts',
    '.ai',
    '.git',
    '.agent-teams',
    'node_modules',
  ];

  const paths = inventory.participant.files.map((entry) => entry.path);
  for (const p of paths) {
    const segments = new Set(p.split('/'));
    for (const forbidden of FORBIDDEN_SEGMENTS) {
      assert.equal(segments.has(forbidden), false, `${p} contains protected segment ${forbidden}/`);
    }
  }

  // Exactly one PRODUCT_PRD.md, package.json and package-lock.json among the 26.
  const baseCounts = new Map();
  for (const p of paths) {
    const base = path.posix.basename(p);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  assert.equal(baseCounts.get('PRODUCT_PRD.md'), 1);
  assert.equal(baseCounts.get('package.json'), 1);
  assert.equal(baseCounts.get('package-lock.json'), 1);
});
