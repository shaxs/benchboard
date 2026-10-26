// C4.S2.T3 independent bundle acceptance tests (fixed S2 contract, 2026-10-17).
// Pure unit tests: synthetic data and exclusively-owned external temp files only.
// No browser, server, tool launch, repository mutation or protected-module import.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { score } from '../../evaluator/score.mjs';
import { hashEntries, inventoryTree, sha256 } from '../../packages/core/identity.mjs';
import { validateScorerEvidence, validateEvidenceBundle, EvaluationIntegrityError } from '../../packages/evaluation/bundle-contract.mjs';
import { assembleEvidenceBundle, scorerEvidenceOf, readEvidenceBundle } from '../../packages/evaluation/bundle.mjs';
import { computeEvaluatorIdentity } from '../../packages/evaluation/evaluator-identity.mjs';

/* ---------- synthetic material (no real evaluation data) ---------- */

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const HEX_0 = '0'.repeat(64);
const EVALUATION_ID = 'eval-test-0001';

function areas(prefix, count, passed, areaName) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${String(i + 1).padStart(2, '0')}`,
    area: areaName,
    passed: i < passed,
  }));
}

// A complete, raw, fully-passing scorer evidence record (S1 shape incl. analysisMethod).
function rawEvidence(overrides = {}) {
  return {
    visiblePassed: 17,
    hidden: [...areas('F', 13, 13, 'functional'), ...areas('P', 4, 4, 'persistence'),
      ...areas('E', 4, 4, 'edge'), ...areas('I', 4, 4, 'integration')],
    typecheck: true,
    build: true,
    usefulTests: { baselinePassed: true, addedCount: 2, killedMutations: ['storage-drop', 'input-drop', 'focus-drop', 'label-case', 'date-order'] },
    noSuppression: true,
    hygiene: { visibleIntact: true, lockedDependencies: true, noSecrets: true, noDebugLogging: true, noNetwork: true },
    analysisMethod: 'ast-only',
    ...overrides,
  };
}

// A complete raw evidence record whose observations are all genuinely zero/false
// (every hidden property failed) — distinct from null or missing.
function zeroedEvidence() {
  const raw = rawEvidence({ visiblePassed: 0, typecheck: false, build: false, noSuppression: false,
    usefulTests: { baselinePassed: false, addedCount: 0, killedMutations: [] } });
  raw.hidden = raw.hidden.map(p => ({ ...p, passed: false }));
  raw.hygiene = { visibleIntact: false, lockedDependencies: false, noSecrets: false, noDebugLogging: false, noNetwork: false };
  return raw;
}

const FILE = (p, content = 'x') => ({ path: p, bytes: content.length, sha256: sha256(content) });

function evaluatorIdentity() {
  const semanticManifest = [FILE('evaluator/score.mjs', 'score'), FILE('evaluator/browser.mjs')].sort((a, b) => (a.path < b.path ? -1 : 1));
  const packageManifest = [FILE('packages/evaluation/bundle.mjs', 'bundle'), FILE('schemas/evidence-bundle.schema.json', '{}')].sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    binding: { id: EVALUATION_ID, digest: DIGEST_B },
    evaluatorVersion: '0.1.0', scoringVersion: '0.1.0',
    hashAlgorithm: 'benchboard-sha256-tree-v1',
    semanticManifest, semanticDigest: hashEntries(semanticManifest),
    packageManifest, packageDigest: hashEntries(packageManifest),
    originalCandidate: { evaluator: DIGEST_B, scoring: semanticManifest.find(e => e.path === 'evaluator/score.mjs').sha256 },
  };
}

function identities() {
  return {
    challenge: { id: 'challenge-test-0001', digest: DIGEST_A },
    tooling: { id: 'tooling-test-0001', digest: DIGEST_A },
    submission: { runId: 'run-test-0001', snapshotId: 'snap-test-0001', frozenSubmissionId: 'frozen-test-0001', manifestDigest: DIGEST_B, treeDigest: DIGEST_A },
    evaluator: evaluatorIdentity(),
  };
}

function successResult(overrides = {}) {
  const evidence = rawEvidence(overrides.evidence || {});
  const stages = ['typecheck', 'build', 'visible', 'browser', 'useful', 'inspection']
    .map(stage => ({ stage, status: 'success', value: {}, process: null }));
  return {
    status: 'success', evaluationId: EVALUATION_ID, evidence, score: null, stages,
    snapshot: { before: DIGEST_A, after: DIGEST_A, workspaceMatchesFrozen: true },
    environment: { label: 'synthetic', nodeVersion: process.version, platform: process.platform, architecture: process.arch, browserVersion: null },
    cleanup: { removed: true, residue: [], errors: [] },
    artifacts: ['typecheck/report.json', 'build/report.json'],
    ...overrides.result,
  };
}

function assembleInputs(resultOverrides = {}, artifactOverrides = {}) {
  const result = successResult(resultOverrides);
  const artifactDigests = result.artifacts.map(p => FILE(p, 'artifact') );
  return { result, identities: identities(), artifactDigests: artifactOverrides.artifactDigests ?? artifactDigests };
}

// A complete valid bundle derived from the same scorer the contract requires.
function validBundle(evidenceOverrides = {}) {
  const raw = rawEvidence(evidenceOverrides);
  const evidence = validateScorerEvidence(raw);
  const ids = identities();
  return {
    schemaVersion: '1.0.0', kind: 'EvidenceBundle', evaluationId: EVALUATION_ID, executionStatus: 'success',
    identities: ids,
    properties: evidence.hidden,
    visible: { passed: evidence.visiblePassed, total: 17 },
    build: evidence.build, typecheck: evidence.typecheck,
    usefulTests: evidence.usefulTests, noSuppression: evidence.noSuppression,
    hygiene: evidence.hygiene,
    environment: { label: 'synthetic', nodeVersion: process.version, platform: process.platform, architecture: process.arch, browserVersion: null },
    artifactDigests: [FILE('typecheck/report.json', 'artifact'), FILE('build/report.json', 'artifact')],
    snapshot: { before: DIGEST_A, after: DIGEST_A, workspaceMatchesFrozen: true },
    score: score(evidence, null),
  };
}

const integrity = error => error instanceof EvaluationIntegrityError && error.code === 'EVIDENCE_INTEGRITY';
const clone = value => structuredClone(value);

/* ---------- assemble: the only route to a bundle ---------- */

test('assemble projects a fully valid success result into a contract-exact bundle', () => {
  const inputs = assembleInputs();
  const bundle = assembleEvidenceBundle(inputs);
  assert.equal(bundle.schemaVersion, '1.0.0');
  assert.equal(bundle.kind, 'EvidenceBundle');
  assert.equal(bundle.executionStatus, 'success');
  assert.equal(bundle.evaluationId, EVALUATION_ID);
  assert.equal(bundle.visible.total, 17);
  assert.equal(bundle.identities, inputs.identities);
  assert.equal(bundle.artifactDigests, inputs.artifactDigests);
  assert.equal(bundle.snapshot, inputs.result.snapshot);
  assert.equal(bundle.environment, inputs.result.environment);
  // No private inspection fields survive the projection.
  assert.ok(!Object.hasOwn(bundle, 'analysisMethod'));
  assert.ok(bundle.properties.every(p => Object.keys(p).join() === 'id,area,passed'));
  // Score is exactly the unchanged scorer over the validated evidence, no human points.
  const expected = score(validateScorerEvidence(inputs.result.evidence), null);
  assert.deepEqual(bundle.score, expected);
  assert.equal(bundle.score.humanUI, null);
  assert.equal(bundle.score.quality, null);
  // validateEvidenceBundle returns the validated JSON value (a JSON round trip per contract),
  // so acceptance is deep equality, not reference identity.
  assert.deepEqual(validateEvidenceBundle(bundle), bundle);
});

/* ---------- refuse incomplete or non-success results: no partial points ---------- */

test('non-success, dirty cleanup, snapshot drift and stage irregularities refuse without any partial score', () => {
  const refusals = [
    ['infrastructure result', { result: { status: 'infrastructure-error' } }],
    ['cleanup not removed', { result: { cleanup: { removed: false, residue: ['scratch'], errors: [] } } }],
    ['cleanup errors present', { result: { cleanup: { removed: true, residue: [], errors: [{ code: 'CLEANUP_FAILED', message: 'x' }] } } }],
    ['cleanup residue present', { result: { cleanup: { removed: true, residue: ['scratch'], errors: [] } } }],
    ['snapshot before missing', { result: { snapshot: { before: null, after: DIGEST_A, workspaceMatchesFrozen: true } } }],
    ['snapshot after missing', { result: { snapshot: { before: DIGEST_A, after: null, workspaceMatchesFrozen: true } } }],
    ['snapshot before differs from after', { result: { snapshot: { before: DIGEST_A, after: DIGEST_B, workspaceMatchesFrozen: true } } }],
    ['one stage missing', { result: { stages: successResult().stages.slice(0, 5) } }],
    ['stages out of contract order', { result: { stages: [successResult().stages[1], successResult().stages[0], ...successResult().stages.slice(2)] } }],
    ['one stage not successful', { result: { stages: successResult().stages.map(s => s.stage === 'useful' ? { ...s, status: 'infrastructure-error' } : s) } }],
    ['evidence invalid (one property missing)', { result: { evidence: { ...rawEvidence(), hidden: rawEvidence().hidden.slice(0, 24) } } }],
    ['evidence missing', { result: { evidence: null } }],
  ];
  for (const [label, override] of refusals) {
    assert.throws(() => assembleEvidenceBundle(assembleInputs(override)), integrity, `assemble must refuse: ${label}`);
  }
  // An infrastructure result carries no bundle; the contract keeps the S1 envelope with bundle:null.
  const infra = { status: 'infrastructure-error', evidence: null, score: null, bundle: null };
  assert.equal(infra.bundle, null);
  assert.equal(infra.score, null);
});

/* ---------- scorer-evidence validation: missing, duplicate, unknown, wrong area ---------- */

test('missing fields are never defaulted to 0 or true and never coerced', () => {
  for (const key of ['visiblePassed', 'typecheck', 'build', 'noSuppression']) {
    const raw = rawEvidence(); delete raw[key];
    assert.throws(() => validateScorerEvidence(raw), integrity, `missing ${key}`);
  }
  assert.throws(() => validateScorerEvidence({ ...rawEvidence(), visiblePassed: null }), integrity, 'null count');
  assert.throws(() => validateScorerEvidence({ ...rawEvidence(), visiblePassed: '17' }), integrity, 'string count');
  assert.throws(() => validateScorerEvidence({ ...rawEvidence(), typecheck: 1 }), integrity, 'number boolean');
  assert.throws(() => validateScorerEvidence({ ...rawEvidence(), typecheck: null }), integrity, 'null boolean');
  for (const key of ['visibleIntact', 'lockedDependencies', 'noSecrets', 'noDebugLogging', 'noNetwork']) {
    const raw = rawEvidence(); delete raw.hygiene[key];
    assert.throws(() => validateScorerEvidence(raw), integrity, `missing hygiene ${key}`);
    const nulled = rawEvidence(); nulled.hygiene[key] = null;
    assert.throws(() => validateScorerEvidence(nulled), integrity, `null hygiene ${key}`);
    const zeroed = rawEvidence(); zeroed.hygiene[key] = 0;
    assert.throws(() => validateScorerEvidence(zeroed), integrity, `zero hygiene ${key}`);
  }
  const noBaseline = rawEvidence(); delete noBaseline.usefulTests.baselinePassed;
  assert.throws(() => validateScorerEvidence(noBaseline), integrity, 'missing baselinePassed');
  assert.throws(() => validateScorerEvidence({ ...rawEvidence(), usefulTests: { ...rawEvidence().usefulTests, baselinePassed: null } }), integrity, 'null baselinePassed');
  // Individual count/mutation cases: never defaulted to 0 or [].
  for (const [label, useful] of [
    ['absent addedCount', (() => { const u = { ...rawEvidence().usefulTests }; delete u.addedCount; return u; })()],
    ['null addedCount', { ...rawEvidence().usefulTests, addedCount: null }],
    ['string addedCount', { ...rawEvidence().usefulTests, addedCount: '2' }],
    ['absent killedMutations', (() => { const u = { ...rawEvidence().usefulTests }; delete u.killedMutations; return u; })()],
    ['null killedMutations', { ...rawEvidence().usefulTests, killedMutations: null }],
  ]) {
    assert.throws(() => validateScorerEvidence({ ...rawEvidence(), usefulTests: useful }), integrity, label);
  }
  // Missing hidden.passed is its own case, never defaulted to false.
  const passedMissing = rawEvidence(); delete passedMissing.hidden[0].passed;
  assert.throws(() => validateScorerEvidence(passedMissing), integrity, 'missing hidden passed');
  assert.throws(() => validateScorerEvidence({ ...rawEvidence(), hidden: rawEvidence().hidden.map((p, i) => i === 0 ? { id: p.id, area: p.area } : p) }), integrity, 'absent passed never defaults to false');
});

test('false and 0 are accepted as real observations, distinct from null', () => {
  const zeroed = zeroedEvidence();
  const evidence = validateScorerEvidence(zeroed);
  assert.equal(evidence.visiblePassed, 0);
  assert.equal(evidence.usefulTests.baselinePassed, false);
  const bundle = validBundle();
  Object.assign(bundle, {
    properties: evidence.hidden, visible: { passed: 0, total: 17 },
    build: false, typecheck: false, noSuppression: false,
    usefulTests: evidence.usefulTests, hygiene: evidence.hygiene,
    score: score(evidence, null),
  });
  assert.equal(bundle.score.automated, 0);
  assert.equal(validateEvidenceBundle(bundle).score.automated, 0);
});

test('duplicate, unknown and area-mismatched hidden properties are refused', () => {
  const dup = rawEvidence(); dup.hidden.push({ ...dup.hidden[0] });
  assert.throws(() => validateScorerEvidence(dup), integrity, '26 properties / duplicate id');
  const sameIdTwice = rawEvidence(); sameIdTwice.hidden[1] = { ...sameIdTwice.hidden[0] };
  assert.throws(() => validateScorerEvidence(sameIdTwice), integrity, 'duplicate id in place');
  const unknownId = rawEvidence(); unknownId.hidden[0] = { id: 'Z01', area: 'functional', passed: true };
  assert.throws(() => validateScorerEvidence(unknownId), integrity, 'unknown id');
  const unknownLetter = rawEvidence(); unknownLetter.hidden[0] = { id: 'F14', area: 'functional', passed: true };
  assert.throws(() => validateScorerEvidence(unknownLetter), integrity, 'id beyond count');
  const wrongArea = rawEvidence(); wrongArea.hidden[0] = { id: 'F01', area: 'edge', passed: true };
  assert.throws(() => validateScorerEvidence(wrongArea), integrity, 'id/area mismatch');
  const unknownArea = rawEvidence(); unknownArea.hidden[0] = { id: 'F01', area: 'ui', passed: true };
  assert.throws(() => validateScorerEvidence(unknownArea), integrity, 'unknown area name');
  const shortArea = rawEvidence(); shortArea.hidden = shortArea.hidden.filter(p => p.id !== 'P04');
  assert.throws(() => validateScorerEvidence(shortArea), integrity, 'incomplete area counts');
  const passedNull = rawEvidence(); passedNull.hidden[0] = { ...passedNull.hidden[0], passed: null };
  assert.throws(() => validateScorerEvidence(passedNull), integrity, 'null passed');
});

test('unknown, duplicate or non-string mutation names are refused', () => {
  assert.throws(() => validateScorerEvidence({ ...rawEvidence(), usefulTests: { ...rawEvidence().usefulTests, killedMutations: ['storage-drop', 'sneaky-drop'] } }), integrity, 'unknown mutation');
  assert.throws(() => validateScorerEvidence({ ...rawEvidence(), usefulTests: { ...rawEvidence().usefulTests, killedMutations: ['storage-drop', 'storage-drop'] } }), integrity, 'duplicate mutation');
  assert.throws(() => validateScorerEvidence({ ...rawEvidence(), usefulTests: { ...rawEvidence().usefulTests, killedMutations: [1] } }), integrity, 'non-string mutation');
});

test('scorerEvidenceOf re-projects and refuses tampered bundle evidence', () => {
  const bundle = validBundle();
  assert.deepEqual(scorerEvidenceOf(bundle), validateScorerEvidence(rawEvidence()));
  const tampered = clone(bundle); tampered.properties[0].id = 'Z99';
  assert.throws(() => scorerEvidenceOf(tampered), integrity);
  const flipped = clone(bundle); flipped.properties[0].passed = 'true';
  assert.throws(() => scorerEvidenceOf(flipped), integrity);
});

/* ---------- schema-level refusals ---------- */

test('schema refuses unknown major version, wrong kind and unknown keys at every closed level', () => {
  // The published pattern accepts any 1.x minor (forward compatible) and rejects unknown majors.
  for (const version of ['2.0.0', '0.9.0', '1.0', '', '11.0.0', 'x1.0.0']) {
    const bad = clone(validBundle()); bad.schemaVersion = version;
    assert.throws(() => validateEvidenceBundle(bad), integrity, `schemaVersion ${JSON.stringify(version)}`);
  }
  const badKind = clone(validBundle()); badKind.kind = 'EvidenceBundleV2';
  assert.throws(() => validateEvidenceBundle(badKind), integrity, 'unknown kind');
  const badExec = clone(validBundle()); badExec.executionStatus = 'partial';
  assert.throws(() => validateEvidenceBundle(badExec), integrity, 'executionStatus must be const success');
  for (const extra of [{ topLevel: 1 }, { score: 0 }]) {
    const bad = clone(validBundle()); Object.assign(bad, extra);
    assert.throws(() => validateEvidenceBundle(bad), integrity, `unknown top-level key ${Object.keys(extra)[0]}`);
  }
  const badIdentity = clone(validBundle()); badIdentity.identities.submission.extra = 'x';
  assert.throws(() => validateEvidenceBundle(badIdentity), integrity, 'unknown submission key');
  const badEvaluator = clone(validBundle()); badEvaluator.identities.evaluator.hashAlgorithm = 'benchboard-md5-tree-v0';
  assert.throws(() => validateEvidenceBundle(badEvaluator), integrity, 'wrong hash algorithm');
  const badHygiene = clone(validBundle()); badHygiene.hygiene.unusedFlag = true;
  assert.throws(() => validateEvidenceBundle(badHygiene), integrity, 'unknown hygiene key');
  const badProperty = clone(validBundle()); badProperty.properties[0].diagnostic = 'private text';
  assert.throws(() => validateEvidenceBundle(badProperty), integrity, 'unknown property key');
  const badMutation = clone(validBundle()); badMutation.usefulTests.killedMutations = ['unknown-drop'];
  assert.throws(() => validateEvidenceBundle(badMutation), integrity, 'unknown mutation in bundle');
  const badCount = clone(validBundle()); badCount.visible.total = 18;
  assert.throws(() => validateEvidenceBundle(badCount), integrity, 'visible.total is the fixed scoring denominator 17');
  const badArea = clone(validBundle()); badArea.properties[0].area = 'ui';
  assert.throws(() => validateEvidenceBundle(badArea), integrity, 'unknown area via schema');
});

/* ---------- corruption of an otherwise valid bundle ---------- */

test('tampered score, semantic digest, scoring binding, artifact and snapshot are refused with EVIDENCE_INTEGRITY', () => {
  const corruptions = [
    ['score area tampered (functional off the recomputed value)', b => { b.score.areas.functional = 29; }],
    ['score automated total tampered', b => { b.score.automated = 79; }],
    ['score status changed', b => { b.score.status = 'SCORED'; }],
    ['semantic digest stale', b => { b.identities.evaluator.semanticManifest[1].sha256 = HEX_0; }],
    ['package digest stale', b => { b.identities.evaluator.packageManifest[0].sha256 = HEX_0; }],
    ['scoring identity binding broken', b => { b.identities.evaluator.originalCandidate.scoring = DIGEST_B; }],
    ['duplicate artifact path', b => { b.artifactDigests[1] = { ...b.artifactDigests[0] }; }],
    ['private absolute artifact path', b => { b.artifactDigests[0] = { ...b.artifactDigests[0], path: 'C:/private/report.json' }; }],
    ['backslash artifact path', b => { b.artifactDigests[0] = { ...b.artifactDigests[0], path: 'typecheck\\report.json' }; }],
    ['snapshot before drifted', b => { b.snapshot.before = DIGEST_B; }],
    ['submission tree digest drifted', b => { b.identities.submission.treeDigest = DIGEST_B; }],
  ];
  for (const [label, mutate] of corruptions) {
    const bad = clone(validBundle());
    mutate(bad);
    assert.throws(() => validateEvidenceBundle(bad), integrity, `corruption refused: ${label}`);
  }
});

/* ---------- JSON transport round trip (exclusively-owned external temp file) ---------- */

test('JSON write/read round trip through readEvidenceBundle preserves 0, false and null exactly', t => {
  const evidence = validateScorerEvidence(zeroedEvidence());
  const bundle = validBundle();
  Object.assign(bundle, {
    properties: evidence.hidden, visible: { passed: 0, total: 17 },
    build: false, typecheck: false, noSuppression: false,
    usefulTests: evidence.usefulTests, hygiene: evidence.hygiene,
    artifactDigests: [{ path: 'typecheck/empty.json', bytes: 0, sha256: sha256('') }, ...bundle.artifactDigests],
    score: score(evidence, null),
  });
  assert.ok(bundle.score.automated < 80);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-bundle-roundtrip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bundle.json');
  fs.writeFileSync(file, JSON.stringify(bundle));
  const restored = readEvidenceBundle(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(restored, bundle);
  assert.equal(restored.score.humanUI, null);
  assert.equal(restored.score.quality, null);
  assert.equal(restored.snapshot.workspaceMatchesFrozen, true);
  assert.equal(restored.environment.browserVersion, null);
  assert.equal(restored.artifactDigests[0].bytes, 0);
  assert.equal(restored.typecheck, false);
});

test('readEvidenceBundle refuses malformed JSON and invalid bundles', () => {
  assert.throws(() => readEvidenceBundle('{ not json'), integrity, 'malformed JSON is an exact integrity refusal, never a SyntaxError escape');
  const bad = clone(validBundle()); bad.kind = 'Nope';
  assert.throws(() => readEvidenceBundle(JSON.stringify(bad)), integrity);
});

/* ---------- score agreement with the unchanged scorer ---------- */

test('bundle score areas and total equal the unchanged evaluator/score.mjs over the projected evidence', () => {
  for (const overrides of [
    {}, // perfect run
    { visiblePassed: 9, typecheck: false, build: false,
      usefulTests: { baselinePassed: true, addedCount: 1, killedMutations: ['date-order'] } },
    { visiblePassed: 0, typecheck: false, build: false, noSuppression: false,
      usefulTests: { baselinePassed: false, addedCount: 0, killedMutations: [] } },
  ]) {
    const raw = rawEvidence(overrides);
    const bundle = validBundle(overrides);
    const expected = score(validateScorerEvidence(raw), null);
    assert.deepEqual(bundle.score.areas, expected.areas);
    assert.equal(bundle.score.automated, expected.automated);
    assert.equal(expected.automatedMaximum, 80);
    assert.equal(bundle.score.humanUI, null);
    assert.equal(bundle.score.quality, null);
  }
  // And the perfect synthetic run really tops out at 80 automated.
  assert.equal(validBundle().score.automated, 80);
});

/* ---------- schema and runtime independently agree ---------- */

test('schema and runtime agree independently: own Ajv compile of the actual JSON schema', () => {
  // Independent path: compile the published schema directly, strictly, with no runtime help.
  const schemaBytes = fs.readFileSync(new URL('../../schemas/evidence-bundle.schema.json', import.meta.url), 'utf8');
  const schema = JSON.parse(schemaBytes);
  const check = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  const bundle = validBundle();
  // 1. Both independent paths accept the ordinary valid bundle.
  assert.equal(check(bundle), true, JSON.stringify(check.errors));
  assert.deepEqual(validateEvidenceBundle(bundle), bundle);

  // 2. Both independent paths reject the same ordinary invalid cases.
  for (const [label, mutate] of [
    ['wrong major version', b => { b.schemaVersion = '2.0.0'; }],
    ['null boolean', b => { b.properties[0].passed = null; }],
    ['unknown top-level key', b => { b.extras = 1; }],
    ['unknown property key', b => { b.properties[0].diagnostic = 'x'; }],
    ['wrong kind', b => { b.kind = 'Other'; }],
    ['non-hex digest', b => { b.identities.challenge.digest = 'zz'.repeat(32); }],
  ]) {
    const bad = clone(bundle);
    mutate(bad);
    assert.equal(check(bad), false, `independent schema must reject: ${label}`);
    assert.throws(() => validateEvidenceBundle(bad), integrity, `runtime must reject: ${label}`);
  }

  // 3. Structural schema alone does not settle cross-field semantics; the runtime does.
  const wrongArea = clone(bundle); wrongArea.properties[0] = { id: 'F01', area: 'edge', passed: true };
  assert.equal(check(wrongArea), true, 'schema claims no id/area cross-field arithmetic');
  assert.throws(() => validateEvidenceBundle(wrongArea), integrity, 'runtime semantic check must settle id/area mismatch');
  const duplicateTuple = clone(bundle); duplicateTuple.properties[1] = { ...duplicateTuple.properties[0] };
  assert.equal(check(duplicateTuple), true, 'schema claims no hidden-id uniqueness');
  assert.throws(() => validateEvidenceBundle(duplicateTuple), integrity, 'runtime semantic check must settle duplicate property');
});

/* ---------- evaluator identity sensitivity (internal read-only test roots) ---------- */

test('computeEvaluatorIdentity reflects actual bytes of synthetic roots and is bound to a fixed recorded lineage', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-identity-root-'));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-identity-pkg-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(packageRoot, { recursive: true, force: true }); });
  const put = (base, rel, content) => { const to = path.join(base, rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, content); };
  for (const f of ['evaluator/score.mjs', 'evaluator/hidden-tests/properties.mjs', 'evaluator/browser.mjs',
    'evaluator/useful-tests.mjs', 'evaluator/collect-evidence.mjs', 'evaluator/local-server.mjs']) put(root, f, `// ${f}\n`);
  for (const f of ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts']) put(root, 'starter/' + f, '{}');
  put(root, 'starter/tests/visible.test.tsx', '// synthetic\n');
  put(root, 'fixtures/seed.json', '{}');
  put(root, 'version.json', JSON.stringify({ version: '9.9.9-synthetic' }));
  put(packageRoot, 'packages/evaluation/module.txt', 'synthetic\n');
  put(packageRoot, 'schemas/evidence-bundle.schema.json', '{}');

  // The synthetic recorded baseline: fixed ONCE from the pre-mutation original evaluator bytes
  // (inventoryTree over root/evaluator, the scoring file digest and the version). It is never
  // refreshed after a mutation — production uses the fixed recorded default, never a live value.
  const lineage = Object.freeze({
    candidateVersion: '9.9.9-synthetic',
    evaluator: inventoryTree({ root: path.join(root, 'evaluator') }).digest,
    scoring: sha256(fs.readFileSync(path.join(root, 'evaluator/score.mjs'))),
  });

  const identity = computeEvaluatorIdentity({ root, packageRoot, lineage });
  assert.equal(identity.evaluatorVersion, '9.9.9-synthetic');
  assert.equal(identity.scoringVersion, '9.9.9-synthetic');
  assert.equal(identity.hashAlgorithm, 'benchboard-sha256-tree-v1');
  assert.ok(identity.semanticManifest.some(e => e.path === 'evaluator/score.mjs'));
  assert.ok(identity.semanticManifest.some(e => e.path === 'starter/tests/visible.test.tsx'));
  assert.ok(identity.semanticManifest.some(e => e.path === 'fixtures/seed.json'));
  assert.equal(identity.semanticDigest, hashEntries(identity.semanticManifest));
  assert.equal(identity.packageDigest, hashEntries(identity.packageManifest));
  assert.equal(identity.originalCandidate.scoring, identity.semanticManifest.find(e => e.path === 'evaluator/score.mjs').sha256);
  assert.deepEqual(identity.originalCandidate, { evaluator: lineage.evaluator, scoring: lineage.scoring });

  // Semantic sensitivity comes from non-original-evaluator bytes (fixture/tooling mutation),
  // checked against the SAME fixed record: the semantic digest moves, the package stays put.
  put(root, 'fixtures/seed.json', '{"tampered":true}');
  const changed = computeEvaluatorIdentity({ root, packageRoot, lineage });
  assert.notEqual(changed.semanticDigest, identity.semanticDigest);
  assert.equal(changed.packageDigest, identity.packageDigest);
  assert.deepEqual(changed.originalCandidate, identity.originalCandidate);
  put(root, 'fixtures/seed.json', '{}');

  // Mutating the original evaluator afterwards must be refused against the same fixed record:
  // installed drift is rejected, never relabelled as the original candidate. Never refresh.
  put(root, 'evaluator/score.mjs', '// tampered scoring\n');
  assert.throws(() => computeEvaluatorIdentity({ root, packageRoot, lineage }), integrity,
    'tampered original scoring must refuse against the fixed synthetic record');

  // Corrupt-record and wrong-version negatives, against the restored tree plus the fixed bytes:
  // only the record field differs, so each refusal isolates that field.
  put(root, 'evaluator/score.mjs', '// evaluator/score.mjs\n');
  assert.equal(inventoryTree({ root: path.join(root, 'evaluator') }).digest, lineage.evaluator, 'restored tree matches the fixed record');
  assert.throws(() => computeEvaluatorIdentity({ root, packageRoot, lineage: { ...lineage, evaluator: HEX_0 } }), integrity, 'corrupt record evaluator hash must refuse');
  assert.throws(() => computeEvaluatorIdentity({ root, packageRoot, lineage: { ...lineage, scoring: HEX_0 } }), integrity, 'corrupt record scoring hash must refuse');
  assert.throws(() => computeEvaluatorIdentity({ root, packageRoot, lineage: { ...lineage, candidateVersion: '8.8.8-synthetic' } }), integrity, 'wrong record version must refuse');

  fs.rmSync(path.join(root, 'version.json'));
  // A missing version must be refused, not defaulted: the identity helper normalizes it to integrity.
  assert.throws(() => computeEvaluatorIdentity({ root, packageRoot, lineage }), integrity, 'missing version must refuse, never default');
});
