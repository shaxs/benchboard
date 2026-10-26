import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computeEvaluatorIdentity } from '../../packages/evaluation/evaluator-identity.mjs';
import { hashEntries, inventoryTree, sha256 } from '../../packages/core/identity.mjs';
import { OWNER_ROOT } from '../../packages/evaluation/staging.mjs';
import { hasOwnerEvidence } from '../owner-evidence.mjs';

function synthetic(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const names = ['evaluator/score.mjs', 'evaluator/hidden-tests/properties.mjs', 'evaluator/browser.mjs',
    'evaluator/useful-tests.mjs', 'evaluator/collect-evidence.mjs', 'evaluator/local-server.mjs',
    'starter/package.json', 'starter/package-lock.json', 'starter/tsconfig.json', 'starter/vite.config.ts',
    'starter/tests/contracts.test.tsx', 'fixtures/input.json', 'packages/evaluation/wrapper.mjs', 'schemas/evidence-bundle.schema.json'];
  for (const name of names) { const at = path.join(root, name); fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, name); }
  fs.writeFileSync(path.join(root, 'version.json'), '{"version":"1.0.0-test"}');
  return root;
}
function lineageOf(root) {
  return { candidateVersion: '1.0.0-test', evaluator: inventoryTree({ root: path.join(root, 'evaluator') }).digest,
    scoring: sha256(fs.readFileSync(path.join(root, 'evaluator/score.mjs'))) };
}
test('actual evaluator identity covers semantic inputs, original tree and installed wrapper separately', () => {
  const value = computeEvaluatorIdentity();
  assert.equal(hashEntries(value.semanticManifest), value.semanticDigest);
  assert.equal(hashEntries(value.packageManifest), value.packageDigest);
  assert.equal(value.originalCandidate.evaluator, inventoryTree({ root: path.join(OWNER_ROOT, 'evaluator') }).digest);
  assert.equal(value.originalCandidate.scoring, sha256(fs.readFileSync(path.join(OWNER_ROOT, 'evaluator/score.mjs'))));
  for (const prefix of ['evaluator/score.mjs', 'evaluator/hidden-tests/properties.mjs', 'starter/tests/', 'fixtures/', 'starter/package-lock.json']) assert.ok(value.semanticManifest.some(e => e.path.startsWith(prefix)));
  assert.ok(value.packageManifest.some(e => e.path === 'packages/evaluation/evaluate-frozen.mjs'));
  assert.ok(value.packageManifest.some(e => e.path === 'schemas/evidence-bundle.schema.json'));
  assert.ok(value.semanticManifest.every(e => !path.isAbsolute(e.path)));
  if (!hasOwnerEvidence('workflow/planning/PRESERVATION_BASELINE.json')) return;
  const baseline = JSON.parse(fs.readFileSync(path.join(OWNER_ROOT, 'workflow/planning/PRESERVATION_BASELINE.json'), 'utf8')).candidate;
  const record = JSON.parse(fs.readFileSync(path.join(OWNER_ROOT, 'packages/evaluation/candidate-lineage.json'), 'utf8'));
  assert.deepEqual(record, { candidateVersion: baseline.version.version, evaluator: baseline.evaluator, scoring: baseline.scoring }, 'record is copied from recorded original candidate, not refreshed from live bytes');
  assert.deepEqual(value.originalCandidate, { evaluator: baseline.evaluator, scoring: baseline.scoring });
});
test('semantic-input changes change digest or refuse original evaluator drift; wrapper changes package only', t => {
  const root = synthetic(t), options = { root, packageRoot: root, lineage: lineageOf(root) }, before = computeEvaluatorIdentity(options);
  for (const entry of before.semanticManifest) {
    const at = path.join(root, entry.path), original = fs.readFileSync(at);
    fs.appendFileSync(at, 'changed');
    if (entry.path.startsWith('evaluator/')) assert.throws(() => computeEvaluatorIdentity(options), error => error.code === 'EVIDENCE_INTEGRITY', entry.path + ' must refuse installed drift, not relabel it original');
    else {
      const after = computeEvaluatorIdentity(options);
      assert.notEqual(after.semanticDigest, before.semanticDigest, entry.path);
      assert.equal(after.packageDigest, before.packageDigest);
    }
    fs.writeFileSync(at, original);
  }
  fs.appendFileSync(path.join(root, 'packages/evaluation/wrapper.mjs'), 'wrapper change');
  const after = computeEvaluatorIdentity(options);
  assert.equal(after.semanticDigest, before.semanticDigest);
  assert.notEqual(after.packageDigest, before.packageDigest);
});
test('identity refuses a missing mandatory semantic module without modifying other inputs', t => {
  const root = synthetic(t), at = path.join(root, 'evaluator/score.mjs');
  const lineage = lineageOf(root);
  fs.unlinkSync(at);
  assert.throws(() => computeEvaluatorIdentity({ root, packageRoot: root, lineage }), error => error.code === 'EVIDENCE_INTEGRITY');
});
test('fixed recorded lineage rejects installed mismatches, malformed lineage and missing version', t => {
  const root = synthetic(t), lineage = lineageOf(root), options = { root, packageRoot: root, lineage };
  for (const key of ['evaluator', 'scoring']) assert.throws(() => computeEvaluatorIdentity({ ...options, lineage: { ...lineage, [key]: '0'.repeat(64) } }), error => error.code === 'EVIDENCE_INTEGRITY');
  assert.throws(() => computeEvaluatorIdentity({ ...options, lineage: { ...lineage, candidateVersion: '9.0.0' } }), error => error.code === 'EVIDENCE_INTEGRITY');
  fs.unlinkSync(path.join(root, 'version.json'));
  assert.throws(() => computeEvaluatorIdentity(options), error => error.code === 'EVIDENCE_INTEGRITY');
});
test('identity and validator declaration pairs are byte-identical', () => {
  for (const name of ['evaluator-identity', 'bundle-contract']) assert.deepEqual(fs.readFileSync(new URL('../../packages/evaluation/' + name + '.d.ts', import.meta.url)), fs.readFileSync(new URL('../../packages/evaluation/' + name + '.d.mts', import.meta.url)));
});
