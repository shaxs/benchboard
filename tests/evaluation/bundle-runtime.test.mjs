import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attachEvidenceBundle } from '../../packages/evaluation/bundle-runtime.mjs';
import { computeEvaluatorIdentity } from '../../packages/evaluation/evaluator-identity.mjs';
import { evaluateWithRuntime } from '../../packages/evaluation/controller.mjs';
import { createFrozenFixture, snapshotInputs, assertInputsUnchanged } from './helpers.mjs';
import { sha256 } from '../../packages/core/identity.mjs';
import { EvaluationRefusalError } from '../../packages/evaluation/contracts.mjs';

test('bundle integration binds real C3 selection, separate actual evaluator and relative artifact digests; controlled stages only', async t => {
  const f = await createFrozenFixture(t), before = snapshotInputs(f), installed = computeEvaluatorIdentity();
  const raw = await evaluateWithRuntime(f.request, f.runtime);
  const result = await attachEvidenceBundle(f.request, raw, installed);
  assert.equal(result.score, null);
  assert.equal(result.bundle.score.automated, 75);
  assert.equal(result.bundle.score.quality, null);
  assert.equal(result.bundle.identities.submission.treeDigest, before.frozen);
  assert.equal(result.bundle.identities.evaluator.semanticDigest, installed.semanticDigest);
  assert.notEqual(result.bundle.identities.evaluator.binding.digest, installed.semanticDigest);
  assert.equal(result.bundle.artifactDigests.length, result.artifacts.length);
  for (const entry of result.bundle.artifactDigests) assert.equal(entry.sha256, sha256(fs.readFileSync(path.join(f.request.outputRoot, entry.path))));
  assertInputsUnchanged(f, before);
});
test('infrastructure result has no bundle and installed mutation refuses successful evidence', async t => {
  assert.deepEqual(await attachEvidenceBundle({}, { status: 'infrastructure-error', score: null, evidence: null }, null), { status: 'infrastructure-error', score: null, evidence: null, bundle: null });
  const f = await createFrozenFixture(t), installed = computeEvaluatorIdentity(), raw = await evaluateWithRuntime(f.request, f.runtime);
  installed.semanticDigest = '0'.repeat(64);
  await assert.rejects(attachEvidenceBundle(f.request, raw, installed), error => error.code === 'EVIDENCE_INTEGRITY');
});
test('post-claim refusal retains cleanup AND its actual relative diagnostic artifacts', async t => {
  const f = await createFrozenFixture(t);
  f.runtime.stageOverrides.build = async context => {
    fs.writeFileSync(path.join(context.artifactRoot, 'diagnostic.log'), 'controlled refusal');
    throw new EvaluationRefusalError('CONTROLLED_REFUSAL', 'test refusal after artifact acquisition');
  };
  await assert.rejects(evaluateWithRuntime(f.request, f.runtime), error => error.code === 'CONTROLLED_REFUSAL' && error.cleanup.removed && error.artifacts.includes('build/diagnostic.log'));
});

test('bundle finalization never adopts a substituted artifact output after controller settlement', async t => {
  const f = await createFrozenFixture(t), installed = computeEvaluatorIdentity();
  const raw = await evaluateWithRuntime(f.request, f.runtime);
  fs.renameSync(f.request.outputRoot, f.request.outputRoot + '-saved');
  fs.mkdirSync(f.request.outputRoot);
  fs.writeFileSync(path.join(f.request.outputRoot, 'foreign.txt'), 'do not adopt or delete');
  await assert.rejects(attachEvidenceBundle(f.request, raw, installed), error => error.code === 'CLEANUP_FAILED');
  assert.equal(fs.readFileSync(path.join(f.request.outputRoot, 'foreign.txt'), 'utf8'), 'do not adopt or delete');
  await assert.rejects(attachEvidenceBundle(f.request, structuredClone(raw), installed), error => error.code === 'CLEANUP_FAILED');
});

test('post-settlement missing artifact or output produces a typed no-score failure, not raw filesystem rejection', async t => {
  for (const fault of ['artifact', 'root']) {
    const f = await createFrozenFixture(t), installed = computeEvaluatorIdentity();
    const raw = await evaluateWithRuntime(f.request, f.runtime);
    if (fault === 'artifact') fs.unlinkSync(path.join(f.request.outputRoot, raw.artifacts[0]));
    else fs.renameSync(f.request.outputRoot, f.request.outputRoot + '-saved');
    await assert.rejects(attachEvidenceBundle(f.request, raw, installed), error => error.code === (fault === 'artifact' ? 'EVIDENCE_INTEGRITY' : 'CLEANUP_FAILED'));
  }
});

test('late C3 selection refusal retains actual cleanup and artifact diagnostics without returning a partial bundle', async t => {
  const f = await createFrozenFixture(t), installed = computeEvaluatorIdentity();
  const raw = await evaluateWithRuntime(f.request, f.runtime);
  const invalid = { ...f.request, submission: { ...f.request.submission, expectedDigest: '0'.repeat(64) } };
  await assert.rejects(attachEvidenceBundle(invalid, raw, installed), error => {
    assert.ok(error instanceof EvaluationRefusalError);
    assert.equal(error.code, 'SNAPSHOT_REFUSED');
    assert.deepEqual(error.cleanup, raw.cleanup);
    assert.deepEqual(error.artifacts, raw.artifacts);
    assert.equal('bundle' in error, false);
    return true;
  });
});
