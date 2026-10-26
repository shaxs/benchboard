// Captain-written S6 verification acceptance. All installation assets below are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { renderSyntheticEvaluatorVerifier } from '../../../release/packaged-evaluator.mjs';
import { verifyPackagedEvaluator, PackagedEvaluatorError } from '../../../packages/evaluation/packaged-identity.mjs';
import { hashEntries, inventoryTree } from '../../../packages/core/identity.mjs';
import { computeEvaluatorIdentity } from '../../../packages/evaluation/evaluator-identity.mjs';
import Ajv2020 from 'ajv/dist/2020.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const profile = { schemaVersion: '1.0.0', kind: 'ReleaseProfile', profile: 'synthetic', authorization: 'synthetic-only',
  entries: [{ path: 'synthetic.txt', source: 'synthetic.txt', bytes: 0, sha256: sha('') }] };
const semanticNames = ['evaluator/score.mjs', 'evaluator/hidden-tests/properties.mjs', 'evaluator/browser.mjs',
  'evaluator/useful-tests.mjs', 'evaluator/collect-evidence.mjs', 'evaluator/local-server.mjs',
  'starter/package.json', 'starter/package-lock.json', 'starter/tsconfig.json', 'starter/vite.config.ts',
  'starter/tests/visible.mjs', 'fixtures/data.json'];
const wrapperNames = ['packages/evaluation/wrapper.mjs', 'schemas/evidence-bundle.schema.json'];
function makeFixture(wrapper = 'synthetic wrapper', historical = sha('historical candidate whole tree')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchboard-packaged-'));
  const put = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
  const entry = (relative) => { const bytes = fs.readFileSync(path.join(root, relative)); return { path: relative, bytes: bytes.length, sha256: sha(bytes) }; };
  for (const name of semanticNames) put(name, `synthetic semantic bytes: ${name}`);
  put(wrapperNames[0], wrapper); put(wrapperNames[1], '{"synthetic":true}');
  put('packages/core/identity.mjs', fs.readFileSync(new URL('../../../packages/core/identity.mjs', import.meta.url)));
  const descriptor = { schemaVersion: '1.0.0', kind: 'PackagedEvaluatorAssets', authorization: 'synthetic-only',
    version: 'synthetic-v1', lineage: { candidateVersion: 'synthetic-v1', evaluator: historical, scoring: entry('evaluator/score.mjs').sha256 },
    semantics: semanticNames.map(entry), wrappers: wrapperNames.map(entry) };
  const descriptorBytes = Buffer.from(JSON.stringify(descriptor));
  put('packages/evaluation/packaged-assets.json', descriptorBytes);
  put('packages/evaluation/packaged-identity.mjs', renderSyntheticEvaluatorVerifier(profile, descriptorBytes));
  return { root, put, descriptor, load: () => import(pathToFileURL(path.join(root, 'packages/evaluation/packaged-identity.mjs')).href),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const refused = (error) => error instanceof Error && error.name === 'PackagedEvaluatorError' && error.code === 'ERR_PACKAGED_EVALUATOR_INTEGRITY';
async function fixture(run, ...options) { const rig = makeFixture(...options); try { await run(rig); } finally { rig.cleanup(); } }

test('S6 unprepared checkout template refuses without changing the legacy verifier', () => {
  assert.throws(() => verifyPackagedEvaluator(), (error) => error instanceof PackagedEvaluatorError && refused(error));
});

test('S6 copied fixed-pin verifier computes exact semantic/wrapper domains and retains historical lineage', async () => fixture(async (rig) => {
  const installed = await rig.load();
  const value = installed.verifyPackagedEvaluator();
  assert.deepEqual(value.semanticManifest, [...rig.descriptor.semantics].sort((a, b) => a.path < b.path ? -1 : 1));
  assert.equal(value.semanticDigest, hashEntries(rig.descriptor.semantics));
  assert.equal(value.packageDigest, hashEntries(value.packageManifest));
  assert.equal(value.packageManifest.length, rig.descriptor.wrappers.length + 2);
  assert.equal(value.originalCandidate.evaluator, rig.descriptor.lineage.evaluator);
  assert.notEqual(value.originalCandidate.evaluator, inventoryTree({ root: path.join(rig.root, 'evaluator') }).digest);
  assert.equal(value.originalCandidate.scoring, rig.descriptor.lineage.scoring);
  assert.equal(value.hashAlgorithm, 'benchboard-sha256-tree-v1');
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.semanticManifest) && Object.isFrozen(value.originalCandidate));
  assert.throws(() => computeEvaluatorIdentity({ root: rig.root, packageRoot: rig.root, lineage: rig.descriptor.lineage }), { name: 'EvaluationIntegrityError' });
}));

for (const target of ['evaluator/score.mjs', 'fixtures/data.json', 'packages/evaluation/wrapper.mjs', 'schemas/evidence-bundle.schema.json']) {
  test(`S6 refuses substituted selected asset ${target}`, async () => fixture(async (rig) => {
    const installed = await rig.load(); rig.put(target, 'substituted bytes');
    assert.throws(() => installed.verifyPackagedEvaluator(), refused);
  }));
}

test('S6 refuses missing, unexpected and hardlinked evaluator assets', async () => {
  for (const change of ['missing', 'extra', 'hardlink', 'empty-directory']) await fixture(async (rig) => {
    const installed = await rig.load();
    if (change === 'missing') fs.unlinkSync(path.join(rig.root, 'evaluator', 'browser.mjs'));
    if (change === 'extra') rig.put('evaluator/unapproved-owner-tool.mjs', 'extra');
    if (change === 'hardlink') fs.linkSync(path.join(rig.root, 'evaluator', 'score.mjs'), path.join(rig.root, 'alias'));
    if (change === 'empty-directory') fs.mkdirSync(path.join(rig.root, 'evaluator', 'unapproved-empty-directory'));
    assert.throws(() => installed.verifyPackagedEvaluator(), refused);
  });
});

test('S6 descriptor replacement and runtime caller overrides cannot substitute a baseline', async () => fixture(async (rig) => {
  const installed = await rig.load();
  assert.throws(() => installed.verifyPackagedEvaluator({ root: rig.root, descriptor: rig.descriptor }), refused);
  rig.descriptor.authorization = 'released';
  rig.put('packages/evaluation/packaged-assets.json', JSON.stringify(rig.descriptor));
  assert.throws(() => installed.verifyPackagedEvaluator(), refused);
}));

test('S6 wrapper-only rebuild keeps semantic identity but changes selected package identity', async () => {
  let baseline;
  await fixture(async (rig) => { baseline = (await rig.load()).verifyPackagedEvaluator(); });
  await fixture(async (rig) => {
    const updated = (await rig.load()).verifyPackagedEvaluator();
    assert.equal(updated.semanticDigest, baseline.semanticDigest);
    assert.deepEqual(updated.originalCandidate, baseline.originalCandidate);
    assert.notEqual(updated.packageDigest, baseline.packageDigest);
  }, 'synthetic wrapper changed');
});

test('S6 renderer cannot promote real profiles or released descriptors', () => {
  const descriptor = Buffer.from('{"schemaVersion":"1.0.0","kind":"PackagedEvaluatorAssets","authorization":"released"}');
  assert.throws(() => renderSyntheticEvaluatorVerifier(profile, descriptor), TypeError);
  assert.throws(() => renderSyntheticEvaluatorVerifier({ ...profile, profile: 'end-user-tooling', authorization: 'blocked' }, descriptor), { code: 'RELEASE_PROFILE_BLOCKED' });
});

test('S6 descriptor schema is structural, while pinned runtime policy refuses malformed manifests', async () => fixture(async (rig) => {
  const schema = JSON.parse(fs.readFileSync(new URL('../../../schemas/release-packaged-evaluator.schema.json', import.meta.url)));
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate(rig.descriptor), true);
  for (const mutation of [
    (value) => { value.schemaVersion = '2.0.0'; },
    (value) => { value.authorization = 'released'; },
    (value) => { value.extra = true; },
    (value) => { value.semantics[0].sha256 = 'A'.repeat(64); },
  ]) { const clone = structuredClone(rig.descriptor); mutation(clone); assert.equal(validate(clone), false); }
  rig.descriptor.semantics[0].path = '../outside';
  assert.equal(validate(rig.descriptor), true); // Shape is not authorization or safe path policy.
  const data = Buffer.from(JSON.stringify(rig.descriptor));
  rig.put('packages/evaluation/packaged-assets.json', data);
  rig.put('packages/evaluation/packaged-identity.mjs', renderSyntheticEvaluatorVerifier(profile, data));
  const installed = await rig.load();
  assert.throws(() => installed.verifyPackagedEvaluator(), refused);
}));

test('S6 refuses a selected namespace junction even with identical semantic bytes', async () => fixture(async (rig) => {
  const installed = await rig.load();
  const from = path.join(rig.root, 'evaluator');
  const moved = path.join(rig.root, 'moved-evaluator');
  fs.renameSync(from, moved);
  fs.symlinkSync(moved, from, 'junction');
  assert.throws(() => installed.verifyPackagedEvaluator(), refused);
  assert.equal(fs.readFileSync(path.join(moved, 'score.mjs'), 'utf8'), 'synthetic semantic bytes: evaluator/score.mjs');
}));

test('S6 temporary selected copies preserve actual checkout semantic bindings without claiming exposure approval', async () => {
  const baseline = computeEvaluatorIdentity();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchboard-semantic-crosswalk-'));
  const put = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); };
  try {
    const wrappers = baseline.packageManifest.filter((entry) => !['packages/evaluation/packaged-identity.mjs', 'packages/evaluation/packaged-assets.json'].includes(entry.path));
    for (const entry of [...baseline.semanticManifest, ...wrappers]) {
      // Read-only copy into a temporary synthetic installation, never an in-place evaluation.
      put(entry.path, fs.readFileSync(new URL('../../../' + entry.path, import.meta.url)));
    }
    put('packages/core/identity.mjs', fs.readFileSync(new URL('../../../packages/core/identity.mjs', import.meta.url)));
    const descriptor = { schemaVersion: '1.0.0', kind: 'PackagedEvaluatorAssets', authorization: 'synthetic-only',
      version: baseline.evaluatorVersion, lineage: { candidateVersion: baseline.evaluatorVersion, ...baseline.originalCandidate },
      semantics: baseline.semanticManifest, wrappers };
    const data = Buffer.from(JSON.stringify(descriptor));
    put('packages/evaluation/packaged-assets.json', data);
    put('packages/evaluation/packaged-identity.mjs', renderSyntheticEvaluatorVerifier(profile, data));
    const module = await import(pathToFileURL(path.join(root, 'packages/evaluation/packaged-identity.mjs')).href);
    const selected = module.verifyPackagedEvaluator();
    assert.deepEqual(selected.semanticManifest, baseline.semanticManifest);
    assert.equal(selected.semanticDigest, baseline.semanticDigest);
    assert.deepEqual(selected.originalCandidate, baseline.originalCandidate);
    assert.notEqual(selected.packageDigest, baseline.packageDigest);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
