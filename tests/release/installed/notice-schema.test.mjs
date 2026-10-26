// C7a.S2.T3 — Notice-inventory schema acceptance against public output only.
//
// Exercises buildNoticeInventory's returned inventory against the published JSON Schema. All
// profile and lock inputs are in-memory declarations: no file is read or installed, and no file
// exists to support the declared bytes, hashes or package metadata. This is a structural schema
// check, not SPDX/legal review or a content-privacy claim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { buildNoticeInventory } from '../../../release/notices.mjs';

const REPO_ROOT = new URL('../../../', import.meta.url);
const schema = JSON.parse(readFileSync(fileURLToPath(new URL('schemas/release-notices.schema.json', REPO_ROOT)), 'utf8'));
const check = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const passes = (label, doc) => { assert.equal(check(structuredClone(doc)), true, `${label}: ${JSON.stringify(check.errors)}`); };
const fails = (label, doc) => { assert.equal(check(structuredClone(doc)), false, `${label} must not pass the schema`); };

// Declared metadata only; none of these sources or packages exist or are installed.
const profile = () => ({ schemaVersion: '1.0.0', kind: 'ReleaseProfile', profile: 'synthetic',
  authorization: 'synthetic-only', entries: [{ path: 'lib/a.mjs', source: 'assets/a.mjs', bytes: 0, sha256: '0'.repeat(64) }] });
const ownerLock = () => ({ scope: 'owner', lockfile: { lockfileVersion: 3,
  packages: { '': {}, 'node_modules/a': { version: '1.0.0', license: 'MIT' } } } });

test('1 — actual buildNoticeInventory output validates; project and asset unknowns are null/false', () => {
  const output = buildNoticeInventory(profile(), [ownerLock()]);
  passes('actual output', output);
  assert.equal(output.schemaVersion, '1.0.0');
  assert.equal(output.kind, 'NoticeInventory');
  assert.deepEqual(output.projectLicense, { selected: null, approved: false });
  assert.equal(output.releaseApproved, false);
  for (const asset of output.assets) assert.deepEqual([asset.ownership, asset.license, asset.compatibility], [null, null, null]);
});

test('2 — independently mutated clones each fail the schema; the original output is unchanged', () => {
  const output = buildNoticeInventory(profile(), [ownerLock()]);
  const baseline = structuredClone(output);
  const mutate = (fn) => { const clone = structuredClone(output); fn(clone); return clone; };
  const mutations = [
    ['schemaVersion 2.0.0', (c) => { c.schemaVersion = '2.0.0'; }],
    ['kind Unknown', (c) => { c.kind = 'Unknown'; }],
    ['extra root field', (c) => { c.extra = 1; }],
    ['projectLicense.selected MIT', (c) => { c.projectLicense.selected = 'MIT'; }],
    ['projectLicense.approved true', (c) => { c.projectLicense.approved = true; }],
    ['releaseApproved true', (c) => { c.releaseApproved = true; }],
    ['asset ownership 0', (c) => { c.assets[0].ownership = 0; }],
    ['asset sha256 uppercase', (c) => { c.assets[0].sha256 = 'A'.repeat(64); }],
    ['asset negative bytes', (c) => { c.assets[0].bytes = -1; }],
  ];
  for (const [label, fn] of mutations) fails(label, mutate(fn));
  assert.deepEqual(structuredClone(output), baseline, 'mutation attempts never alter the original output');
});

test('3 — declared MIT license validates; invented or unsupported dependency claims fail', () => {
  const output = buildNoticeInventory(profile(), [ownerLock()]);
  const declared = structuredClone(output).dependencies.find((d) => d.name === 'a');
  assert.equal(declared.license, 'MIT'); // a declaration carried from the fake lock, not a legal review
  const mutate = (fn) => { const clone = structuredClone(output); fn(clone); return clone; };
  const mutations = [
    ['unknown license text', (c) => { c.dependencies.find((d) => d.name === 'a').license = 'Some Custom License'; }],
    ['invented dependency property', (c) => { c.dependencies.find((d) => d.name === 'a').homepage = 'example.invalid'; }],
    ['coverage evidence installed', (c) => { c.dependencyCoverage[0].evidence = 'installed'; }],
    ['dependency compatibility 0', (c) => { c.dependencies.find((d) => d.name === 'a').compatibility = 0; }],
  ];
  for (const [label, fn] of mutations) fails(label, mutate(fn));
});
