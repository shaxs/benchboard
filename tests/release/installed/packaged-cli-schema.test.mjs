// C7a.S7.T3 — Synthetic CLI descriptor structural schema acceptance.
//
// Checks a fully literal in-memory descriptor against the published JSON Schema. Nothing here is
// read from disk beyond the schema itself: no CLI is installed or executed, no asset file exists,
// and no byte, pin, expected asset or legal-rights claim is made. Passing structure is not
// authenticity, runtime, publisher or exposure approval.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const REPO_ROOT = new URL('../../../', import.meta.url);
const schema = JSON.parse(readFileSync(fileURLToPath(new URL('schemas/release-cli-installation.schema.json', REPO_ROOT)), 'utf8'));
const check = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const passes = (label, doc) => { assert.equal(check(structuredClone(doc)), true, `${label}: ${JSON.stringify(check.errors)}`); };
const fails = (label, doc) => { assert.equal(check(structuredClone(doc)), false, `${label} must not pass the schema`); };
const cloneMutate = (fn) => { const clone = structuredClone(descriptor()); fn(clone); return clone; };

// Synthetic literal only; no such package, CLI or asset file exists or is installed.
const descriptor = () => ({ kind: 'benchboard.cli.synthetic-installation.v1', schemaVersion: '1.0.0',
  authorization: 'synthetic-only', toolingVersion: '0.1.0', challengeVersion: '1.0.0', evaluatorVersion: '1.0.0',
  packageName: '@benchboard/synthetic-tooling', packageVersion: '0.0.0-synthetic', assets: 'cli/installed-assets.json',
  assetsSha256: '0'.repeat(64), workloadDigest: '0'.repeat(64), publicPrdDigest: '0'.repeat(64),
  visibleDigest: '0'.repeat(64), fixtureDigest: '0'.repeat(64) });

test('1 — the literal descriptor validates; the closed keylist and the three identity versions are exact', () => {
  passes('literal descriptor', descriptor());
  assert.deepEqual(Object.keys(structuredClone(descriptor())).sort(), schema.required.slice().sort(), 'closed keylist unchanged');
  assert.deepEqual(Object.keys(schema.properties).sort(), schema.required.slice().sort(), 'no optional or undeclared properties');
  assert.equal(schema.additionalProperties, false, 'unknown root fields are refused by the schema');
  for (const key of ['toolingVersion', 'challengeVersion', 'evaluatorVersion']) {
    assert.match(descriptor()[key], /^\d+\.\d+\.\d+$/, `${key} is numeric semver text`);
    assert.notEqual(descriptor()[key], descriptor().packageVersion, `${key} is separate from the synthetic package version`);
  }
  assert.equal(descriptor().packageVersion, '0.0.0-synthetic', 'the synthetic package version stays pinned');
  // The published schema itself declares the limit: shape only, never runtime, publisher or
  // exposure approval.
  assert.match(schema.title, /not authenticity or path approval/, 'the schema documents its own scope');
  assert.equal('approval' in schema.properties, false, 'no exposure-approval property exists');
});

test('2 — each independent clone mutation is refused and labelled; the original is untouched', () => {
  const baseline = structuredClone(descriptor());
  const mutations = [
    ['kind development', (c) => { c.kind = 'benchboard.cli.development-installation.v1'; }],
    ['schemaVersion 2.0.0', (c) => { c.schemaVersion = '2.0.0'; }],
    ['authorization released', (c) => { c.authorization = 'released'; }],
    ['packageName other', (c) => { c.packageName = '@benchboard/other-tooling'; }],
    ['packageVersion 0.1.0', (c) => { c.packageVersion = '0.1.0'; }],
    ['assets ../x', (c) => { c.assets = '../x'; }],
    ['assetsSha256 uppercase 64A', (c) => { c.assetsSha256 = 'A'.repeat(64); }],
    ['workloadDigest null', (c) => { c.workloadDigest = null; }],
    ['toolingVersion 01.0.0', (c) => { c.toolingVersion = '01.0.0'; }],
    ['extra root field publicRelease true', (c) => { c.publicRelease = true; }],
  ];
  for (const [label, fn] of mutations) fails(label, cloneMutate(fn));
  assert.deepEqual(structuredClone(descriptor()), baseline, 'mutation attempts never alter the original fixture');
});

test('3 — every required key is independently required; an arbitrary hash still passes as STRUCTURE', () => {
  for (const key of schema.required) fails(`missing ${key}`, cloneMutate((c) => { delete c[key]; }));
  passes('original after all removals', descriptor());
  const arbitrary = cloneMutate((c) => { for (const key of ['assetsSha256', 'workloadDigest', 'publicPrdDigest', 'visibleDigest', 'fixtureDigest']) c[key] = 'ab'.repeat(32); });
  passes('arbitrary valid lowercase 64-hex digests', arbitrary);
  // Explicit, not implied: well-formed hashes pass because only their shape is checked. The schema
  // authenticates no bytes, pins, expected assets or legal rights, and here no such bytes exist.
  assert.notEqual(arbitrary.assetsSha256, descriptor().assetsSha256, 'passing STRUCTURE never means the bytes match anything');
});
