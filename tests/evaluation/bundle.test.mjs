// C4.S2.T2 routine unit tests for the pure bundle assembler/reader.
// Synthetic complete identities and manifests only (hashEntries/sha256 used in TEST only).
// No filesystem, browser, server, process or evaluation execution; no protected-module change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { score } from '../../evaluator/score.mjs';
import { hashEntries, sha256 } from '../../packages/core/identity.mjs';
import { validateScorerEvidence, validateEvidenceBundle, EvaluationIntegrityError } from '../../packages/evaluation/bundle-contract.mjs';
import { assembleEvidenceBundle, scorerEvidenceOf, readEvidenceBundle } from '../../packages/evaluation/bundle.mjs';

/* ------------------------- synthetic material ------------------------- */

const DIGEST_A = sha256('synthetic-tree-a');
const DIGEST_B = sha256('synthetic-tree-b');
const EVAL_ID = 'eval-bundle-unit-0001';

function properties(prefix, count, area, failing = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: prefix + String(index + 1).padStart(2, '0'), area, passed: index < count - failing,
  }));
}

/** Complete raw S1 evidence (accepted stage shape, including analysisMethod). */
function rawEvidence(overrides = {}) {
  return {
    visiblePassed: 17,
    hidden: [...properties('F', 13, 'functional'), ...properties('P', 4, 'persistence'),
      ...properties('E', 4, 'edge'), ...properties('I', 4, 'integration')],
    typecheck: true,
    build: true,
    usefulTests: { baselinePassed: true, addedCount: 3, killedMutations: ['storage-drop', 'input-drop', 'focus-drop', 'label-case', 'date-order'] },
    noSuppression: true,
    hygiene: { visibleIntact: true, lockedDependencies: true, noSecrets: true, noDebugLogging: true, noNetwork: true },
    analysisMethod: 'ast-only',
    ...overrides,
  };
}

const entry = (path, content = 'x') => ({ path, bytes: content.length, sha256: sha256(content) });
const sorted = entries => [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));

/** Complete synthetic evaluator identity block, digests computed with the real algorithm. */
function evaluatorBlock() {
  const semanticManifest = sorted([entry('evaluator/score.mjs', 'scorer'), entry('evaluator/hidden-tests/properties.mjs', 'hidden'),
    entry('starter/package.json', '{}'), entry('fixtures/v0.json', '{}')]);
  const packageManifest = sorted([entry('packages/evaluation/bundle.mjs', 'bundle'), entry('schemas/evidence-bundle.schema.json', '{}')]);
  return {
    binding: { id: 'evaluator-binding-unit-0001', digest: DIGEST_B },
    evaluatorVersion: '1.0.0-candidate.9', scoringVersion: '1.0.0-candidate.9',
    hashAlgorithm: 'benchboard-sha256-tree-v1',
    semanticManifest, semanticDigest: hashEntries(semanticManifest),
    packageManifest, packageDigest: hashEntries(packageManifest),
    originalCandidate: { evaluator: DIGEST_B, scoring: semanticManifest.find(e => e.path === 'evaluator/score.mjs').sha256 },
  };
}

function identities() {
  return {
    challenge: { id: 'challenge-unit-0001', digest: DIGEST_A },
    tooling: { id: 'tooling-unit-0001', digest: DIGEST_A },
    submission: { runId: 'run-unit-0001', snapshotId: 'snapshot-unit-0001', frozenSubmissionId: 'frozen-unit-0001', manifestDigest: DIGEST_B, treeDigest: DIGEST_A },
    evaluator: evaluatorBlock(),
  };
}

/** A clean, complete, six-stage successful S1 success result. */
function successResult(overrides = {}) {
  const stages = ['typecheck', 'build', 'visible', 'browser', 'useful', 'inspection']
    .map(stage => ({ stage, status: 'success', value: {}, process: null }));
  return {
    status: 'success', evaluationId: EVAL_ID, evidence: rawEvidence(), score: null, stages,
    snapshot: { before: DIGEST_A, after: DIGEST_A, workspaceMatchesFrozen: true },
    environment: { label: 'unit', nodeVersion: process.version, platform: process.platform, architecture: process.arch, browserVersion: null },
    cleanup: { removed: true, residue: [], errors: [] },
    artifacts: ['typecheck/stdout.log', 'build/stdout.log'],
    ...overrides,
  };
}

function assembleInputs(resultOverrides = {}, extra = {}) {
  const result = successResult(resultOverrides);
  return {
    result, identities: identities(),
    artifactDigests: result.artifacts.map(p => entry(p, 'artifact bytes')),
    ...extra,
  };
}

const integrity = error => error instanceof EvaluationIntegrityError && error.code === 'EVIDENCE_INTEGRITY';

/* ------------------------- assemble: valid projection ------------------------- */

test('a complete clean success result assembles into a contract-exact bundle', () => {
  const inputs = assembleInputs();
  const bundle = assembleEvidenceBundle(inputs);
  assert.deepEqual(Object.keys(bundle).sort(), ['artifactDigests', 'build', 'environment', 'evaluationId', 'executionStatus', 'hygiene', 'identities', 'kind', 'noSuppression', 'properties', 'schemaVersion', 'score', 'snapshot', 'typecheck', 'usefulTests', 'visible'].sort());
  assert.equal(bundle.schemaVersion, '1.0.0');
  assert.equal(bundle.kind, 'EvidenceBundle');
  assert.equal(bundle.executionStatus, 'success');
  assert.equal(bundle.evaluationId, EVAL_ID);
  assert.equal(bundle.visible.total, 17);
  assert.equal(bundle.visible.passed, 17);
  assert.equal(bundle.identities, inputs.identities, 'identities are passed through, not recomputed');
  assert.equal(bundle.artifactDigests, inputs.artifactDigests, 'artifact digests are passed through');
  assert.equal(bundle.snapshot, inputs.result.snapshot);
  assert.equal(bundle.environment, inputs.result.environment);
  // Property and useful records are the exact validated projections.
  assert.ok(bundle.properties.every(record => Object.keys(record).join(',') === 'id,area,passed'));
  assert.equal(bundle.properties.length, 25);
  assert.deepEqual(Object.keys(bundle.usefulTests).sort(), ['addedCount', 'baselinePassed', 'killedMutations']);
  // No private analysisMethod or diagnostic text crosses the projection boundary.
  assert.ok(!Object.hasOwn(bundle, 'analysisMethod'));
  assert.ok(!JSON.stringify(bundle).includes('ast-only'));
  // Score is exactly the unchanged scorer over the validated evidence, no human points.
  assert.deepEqual(bundle.score, score(validateScorerEvidence(inputs.result.evidence), null));
  assert.equal(bundle.score.automated, 80);
  assert.equal(bundle.score.humanUI, null);
  assert.equal(bundle.score.quality, null);
  assert.equal(bundle.score.status, 'HUMAN_REVIEW_PENDING');
  // The Captain validator accepts the assembled projection.
  assert.deepEqual(validateEvidenceBundle(bundle), bundle);
});

test('an imperfect but complete run scores via the unchanged scorer with nulls preserved', () => {
  const inputs = assembleInputs({ evidence: rawEvidence({
    visiblePassed: 9, typecheck: false, build: false, noSuppression: false,
    usefulTests: { baselinePassed: false, addedCount: 0, killedMutations: [] },
    hidden: [...properties('F', 13, 'functional', 3), ...properties('P', 4, 'persistence', 1),
      ...properties('E', 4, 'edge', 2), ...properties('I', 4, 'integration', 0)],
    hygiene: { visibleIntact: true, lockedDependencies: false, noSecrets: true, noDebugLogging: true, noNetwork: false },
  }) });
  const bundle = assembleEvidenceBundle(inputs);
  assert.deepEqual(bundle.score, score(validateScorerEvidence(inputs.result.evidence), null));
  assert.ok(bundle.score.automated < 80 && bundle.score.automated > 0);
  assert.equal(bundle.typecheck, false);
  assert.equal(bundle.build, false);
  assert.equal(bundle.noSuppression, false);
  assert.equal(bundle.usefulTests.baselinePassed, false);
  assert.equal(bundle.usefulTests.addedCount, 0);
  assert.deepEqual(bundle.usefulTests.killedMutations, []);
  assert.equal(bundle.hygiene.lockedDependencies, false);
  // false and 0 survived as real observations, and validation accepted the result unchanged.
  assert.deepEqual(validateEvidenceBundle(bundle), bundle);
});

/* ------------------------- assemble: refusals, no partial points ------------------------- */

test('incomplete or non-clean results can never build a bundle', () => {
  const refusals = [
    ['infrastructure result', { status: 'infrastructure-error', evidence: null, score: null }],
    ['missing status', { status: undefined }],
    ['cleanup not removed', { cleanup: { removed: false, residue: [], errors: [] } }],
    ['cleanup residue present', { cleanup: { removed: true, residue: ['scratch'], errors: [] } }],
    ['cleanup errors present', { cleanup: { removed: true, residue: [], errors: [{ code: 'CLEANUP_FAILED', message: 'x' }] } }],
    ['snapshot after null', { snapshot: { before: DIGEST_A, after: null, workspaceMatchesFrozen: true } }],
    ['snapshot before null', { snapshot: { before: null, after: DIGEST_A, workspaceMatchesFrozen: true } }],
    ['snapshot drift', { snapshot: { before: DIGEST_A, after: DIGEST_B, workspaceMatchesFrozen: true } }],
    ['five of six stages', { stages: successResult().stages.slice(0, 5) }],
    ['stage out of order', { stages: [successResult().stages[1], ...successResult().stages.slice(0, 1), ...successResult().stages.slice(2)] }],
    ['one stage failed', { stages: successResult().stages.map(s => s.stage === 'inspection' ? { ...s, status: 'infrastructure-error' } : s) }],
    ['evidence null', { evidence: null }],
    ['hidden evidence incomplete', { evidence: rawEvidence({ hidden: rawEvidence().hidden.slice(0, 24) }) }],
  ];
  for (const [label, override] of refusals) {
    assert.throws(() => assembleEvidenceBundle(assembleInputs(override)), integrity, 'must refuse: ' + label);
  }
  // Missing identity inputs are integrity refusals too, never guesses.
  assert.throws(() => assembleEvidenceBundle({ result: successResult(), artifactDigests: [] }), integrity, 'missing identities');
  assert.throws(() => assembleEvidenceBundle({ result: successResult(), identities: identities() }), integrity, 'missing artifactDigests array');
});

test('a raw boolean or count that is absent is never defaulted to 0 or false', () => {
  // analysisMethod is optional scorer input; its absence is fine. The scoring keys never are.
  const noMethod = rawEvidence();
  delete noMethod.analysisMethod;
  assembleEvidenceBundle(assembleInputs({ evidence: noMethod }));
  for (const key of ['visiblePassed', 'typecheck', 'build', 'noSuppression']) {
    const evidence = rawEvidence();
    delete evidence[key];
    assert.throws(() => assembleEvidenceBundle(assembleInputs({ evidence })), integrity, 'missing ' + key);
  }
  for (const key of ['visibleIntact', 'lockedDependencies', 'noSecrets', 'noDebugLogging', 'noNetwork']) {
    const evidence = rawEvidence();
    delete evidence.hygiene[key];
    assert.throws(() => assembleEvidenceBundle(assembleInputs({ evidence })), integrity, 'missing hygiene ' + key);
  }
  const noBaseline = rawEvidence();
  delete noBaseline.usefulTests.baselinePassed;
  assert.throws(() => assembleEvidenceBundle(assembleInputs({ evidence: noBaseline })), integrity, 'missing baselinePassed');
});

test('tampered hidden records or mutation names are refused before any score', () => {
  const unknown = rawEvidence();
  unknown.hidden[0] = { id: 'Z01', area: 'functional', passed: true };
  assert.throws(() => assembleEvidenceBundle(assembleInputs({ evidence: unknown })), integrity, 'unknown property id');
  const wrongArea = rawEvidence();
  wrongArea.hidden[0] = { id: 'F01', area: 'edge', passed: true };
  assert.throws(() => assembleEvidenceBundle(assembleInputs({ evidence: wrongArea })), integrity, 'property/area mismatch');
  const duplicate = rawEvidence();
  duplicate.hidden[1] = { ...duplicate.hidden[0] };
  assert.throws(() => assembleEvidenceBundle(assembleInputs({ evidence: duplicate })), integrity, 'duplicate property id');
  const badMutation = rawEvidence();
  badMutation.usefulTests = { ...badMutation.usefulTests, killedMutations: ['sneaky-drop'] };
  assert.throws(() => assembleEvidenceBundle(assembleInputs({ evidence: badMutation })), integrity, 'unknown mutation name');
});

/* ------------------------- scorerEvidenceOf ------------------------- */

test('scorerEvidenceOf re-projects validated evidence and refuses tampering', () => {
  const inputs = assembleInputs();
  const bundle = assembleEvidenceBundle(inputs);
  assert.deepEqual(scorerEvidenceOf(bundle), validateScorerEvidence(inputs.result.evidence));
  const tampered = structuredClone(bundle);
  tampered.properties[0].id = 'Z99';
  assert.throws(() => scorerEvidenceOf(tampered), integrity, 'tampered property id');
  const coerced = structuredClone(bundle);
  coerced.properties[0].passed = 'true';
  assert.throws(() => scorerEvidenceOf(coerced), integrity, 'string passed is not a boolean');
});

/* ------------------------- readEvidenceBundle ------------------------- */

test('readEvidenceBundle round-trips exact JSON and preserves 0, false and null', () => {
  const inputs = assembleInputs({ evidence: rawEvidence({
    visiblePassed: 0, typecheck: false, build: false, noSuppression: false,
    usefulTests: { baselinePassed: false, addedCount: 0, killedMutations: [] },
    hygiene: { visibleIntact: false, lockedDependencies: false, noSecrets: false, noDebugLogging: false, noNetwork: false },
  }) });
  const bundle = assembleEvidenceBundle(inputs);
  const restored = readEvidenceBundle(JSON.stringify(bundle));
  assert.deepEqual(restored, bundle, 'the validated JSON value equals the assembled bundle');
  assert.equal(restored.visible.passed, 0);
  assert.equal(restored.typecheck, false);
  assert.equal(restored.usefulTests.addedCount, 0);
  assert.equal(restored.score.humanUI, null);
  assert.equal(restored.score.quality, null);
  assert.equal(restored.environment.browserVersion, null);
});

test('readEvidenceBundle refuses malformed JSON, invalid bundles and non-text', () => {
  assert.throws(() => readEvidenceBundle('{ "kind": '), integrity, 'malformed JSON is an integrity refusal');
  const bad = structuredClone(assembleEvidenceBundle(assembleInputs()));
  bad.kind = 'EvidenceBundleV2';
  assert.throws(() => readEvidenceBundle(JSON.stringify(bad)), integrity, 'wrong kind');
  const unknownMajor = structuredClone(assembleEvidenceBundle(assembleInputs()));
  unknownMajor.schemaVersion = '2.0.0';
  assert.throws(() => readEvidenceBundle(JSON.stringify(unknownMajor)), integrity, 'unknown schema major');
  const withExtra = structuredClone(assembleEvidenceBundle(assembleInputs()));
  withExtra.extraneous = true;
  assert.throws(() => readEvidenceBundle(JSON.stringify(withExtra)), integrity, 'unknown key');
  assert.throws(() => readEvidenceBundle(''), integrity, 'empty text');
  assert.throws(() => readEvidenceBundle(undefined), integrity, 'non-string');
});

/* ------------------------- purity and boundaries ------------------------- */

test('the module is a pure projection: no IO, subprocess, crypto or governed imports', () => {
  const source = readFileSync(new URL('../../packages/evaluation/bundle.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/^import .*$/gm)].map(line => line[0]),
    [`import { EvaluationIntegrityError, validateScorerEvidence, validateEvidenceBundle } from './bundle-contract.mjs';`,
      `import { score } from '../../evaluator/score.mjs';`],
    'only the Captain boundary and the unchanged scorer may be imported');
  assert.ok(!/node:(fs|child_process|crypto|net|http|https|worker_threads)/.test(source), 'no IO/subprocess/crypto/node runtime imports');
  assert.ok(!/\bimport\s*\(/.test(source), 'no dynamic imports');
  assert.ok(!/require\s*\(/.test(source), 'no require calls');
  assert.ok(!/process\.env/.test(source), 'no environment access');
});

test('the paired declarations are byte-identical', () => {
  assert.deepEqual(
    readFileSync(new URL('../../packages/evaluation/bundle.d.ts', import.meta.url)),
    readFileSync(new URL('../../packages/evaluation/bundle.d.mts', import.meta.url)));
});
