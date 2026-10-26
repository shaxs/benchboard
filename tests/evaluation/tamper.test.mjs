// C4.S4.T1 — canonical-tooling tamper resistance and original-measured hygiene.
//
// A participant can poison the four canonical tooling files and the two canonical visible tests
// before the freeze; the staging overlay must replace every one of them with the ACTUAL canonical
// (starter) bytes before any tool runs, while the frozen originals stay poisoned and continue to
// carry the participant's extra data. The old evaluator measured hygiene (visibleIntact /
// lockedDependencies) on the frozen ORIGINAL, so a tampered submission keeps those two flags false
// while the score comes only from the canonical run. This file owns the two acceptance tests:
//
//   'controlled canonical overlay preserves original hygiene'
//     No tools, no browser, no server, no process module: the internal stageFrozen seam over the
//     real starter canonical tree (the packet's explicit seam probe), then the internal controlled
//     controller over the poisoned frozen copy with the shared fake stages. The controlled run must
//     actually execute, never skip.
//
//   'production tampered reference preserves original hygiene'
//     The ONLY supported public entry, evaluateFrozen, on the same poisoned frozen reference copy:
//     real bounded tooling, real loopback browser stage, real cooperative useful stage. It must NOT
//     be executed at module load; a worker runs only the controlled test and reports this one as
//     not run. Expected values (17 visible, 25/25 properties, the eight score areas, automated
//     73.8/80) are asserted exactly as the packet fixes them — never refreshed, retuned or rounded,
//     and the unchanged scorer stays the sole scoring authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateFrozen } from '../../packages/evaluation/evaluate-frozen.mjs';
import { evaluateWithRuntime } from '../../packages/evaluation/controller.mjs';
import { stageFrozen, cleanupScratch, verifySelection, OWNER_ROOT } from '../../packages/evaluation/staging.mjs';
import { inventoryTree, sha256 } from '../../packages/core/identity.mjs';
import { validateScorerEvidence, validateEvidenceBundle } from '../../packages/evaluation/bundle-contract.mjs';
import { readEvidenceBundle } from '../../packages/evaluation/bundle.mjs';
import { score } from '../../evaluator/score.mjs';
import { createFrozenFixture, snapshotInputs, assertInputsUnchanged } from './helpers.mjs';

// Deterministic poison: invalid JSON or throw-only JS. It never executes a shell, a network call or
// a process operation, and the src reference bytes are never touched, so the tampering cannot leak
// into any tool through the source tree.
const POISON = Object.freeze({
  'package.json': '{ "name": "tampered-participant", "type": "commonjs" } ### not valid json',
  'package-lock.json': '{{{ invalid lockfile poison',
  'tsconfig.json': 'this is not a tsconfig document',
  'vite.config.ts': 'throw new Error("tampered participant vite config");',
  'tests/contracts.test.tsx': 'throw new Error("tampered participant visible test");',
  'tests/setup.ts': 'throw new Error("tampered participant setup");',
});
const TOOLING = Object.freeze(['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts']);
const VISIBLE_TESTS = Object.freeze(['tests/contracts.test.tsx', 'tests/setup.ts']);
// The frozen copy also carries one retained participant data file under tests/. It survives the
// canonical overlay, and by the unchanged cooperative module's *.test|spec.<cm>[jt]sx filter it is
// not a candidate added test, so the limited fixture truthfully reports added 0 / baseline false.
const EXTRA_DATA_PATH = 'tests/extra-data.json';
const EXTRA_DATA_BYTES = '{"retained":"participant data"}\n';

// The packet-fixed expectation table. hygiene is the scorer's own binary floating sum of three
// 3/5 terms — the exact value 3 * (3 / 5), deliberately NOT the rounded 1.8 — and every number here
// is compared against the unchanged scorer's own output, never tuned to it.
const EXPECTED_AREAS = Object.freeze({
  visible: 7, functional: 30, persistence: 10, edge: 5, integration: 15, code: 5, usefulTests: 0,
  hygiene: 3 * (3 / 5),
});
const EXPECTED_AUTOMATED = Number(Object.values(EXPECTED_AREAS).reduce((a, b) => a + b, 0).toFixed(4));
const EXPECTED_PROPERTIES = Object.freeze([
  ...Array.from({ length: 13 }, (_, i) => ({ id: 'F' + String(i + 1).padStart(2, '0'), area: 'functional' })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: 'P' + String(i + 1).padStart(2, '0'), area: 'persistence' })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: 'E' + String(i + 1).padStart(2, '0'), area: 'edge' })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: 'I' + String(i + 1).padStart(2, '0'), area: 'integration' })),
]);

// Success-only fixture retirement (test-local adapter; the shared helper is NOT edited).
//
// createFrozenFixture registers an unconditional t.after(() => rm(root)) hook, and Node's test
// runner also executes after-hooks when a test FAILS — so a red run would delete exactly the frozen
// fixture, staged output and logs the acceptance requires preserved for diagnosis. This adapter
// intercepts that hook registration (the helper only ever uses t.after), gates it on an explicit
// markSuccess() placed after every assertion, and otherwise preserves the fixture root and prints
// its exact path. The gate is registered BEFORE fixture construction, so a construction fault is
// reported too; the root of a faulted fixture is then unknown and is never invented.
async function createRetainedFixture(t, options) {
  const retention = { hooks: [], root: null, succeeded: false };
  t.after(() => {
    if (!retention.succeeded) {
      console.log('tamper test failed: fixture diagnostic root PRESERVED: '
        + (retention.root ?? '<unknown — fixture construction faulted before its root was returned; never invented>'));
      return;
    }
    for (const hook of retention.hooks) hook();
  });
  const fixture = await createFrozenFixture(Object.create(t, { after: { value: hook => retention.hooks.push(hook) } }), options);
  retention.root = fixture.root;
  return { fixture, markSuccess: () => { retention.succeeded = true; } };
}

/** Poison the four tooling files and both canonical visible tests of the live workspace, pre-freeze. */
function poisonWorkspace(workspaceRoot) {
  for (const [name, bytes] of Object.entries(POISON)) fs.writeFileSync(path.join(workspaceRoot, name), bytes);
  fs.writeFileSync(path.join(workspaceRoot, EXTRA_DATA_PATH), EXTRA_DATA_BYTES);
}

function starterBytes(name) {
  return fs.readFileSync(path.join(OWNER_ROOT, 'starter', name));
}

function frozenPath(fixture, name) {
  return path.join(fixture.frozen.snapshotRoot, name);
}

/** Byte digests of every recorded/protected input domain, as the acceptance requires before/after. */
function inputDigests() {
  return Object.freeze({
    starter: inventoryTree({ root: path.join(OWNER_ROOT, 'starter') }).digest,
    reference: inventoryTree({ root: path.join(OWNER_ROOT, 'reference') }).digest,
    fixtures: inventoryTree({ root: path.join(OWNER_ROOT, 'fixtures') }).digest,
    hiddenTests: inventoryTree({ root: path.join(OWNER_ROOT, 'evaluator/hidden-tests') }).digest,
    artifacts: fs.existsSync(path.join(OWNER_ROOT, 'artifacts')) ? inventoryTree({ root: path.join(OWNER_ROOT, 'artifacts') }).digest : null,
  });
}

function assertNoScratchResidue(outputRoot) {
  assert.deepEqual(fs.readdirSync(outputRoot).filter(name => name.startsWith('scratch-')), [], 'no scratch residue may remain under the output root');
}

// Common pre-run proof: the frozen snapshot carries the poison, the retained extra data and the
// reference source bytes, and it is still the exact C3-verified tree.
async function assertPoisonedFrozen(fixture) {
  for (const name of [...TOOLING, ...VISIBLE_TESTS]) {
    assert.equal(fs.readFileSync(frozenPath(fixture, name), 'utf8'), POISON[name], 'frozen original must still carry the participant poison: ' + name);
    assert.notDeepEqual(starterBytes(name), Buffer.from(POISON[name], 'utf8'), 'the poison must differ from the canonical bytes it is expected to lose to: ' + name);
  }
  assert.equal(fs.readFileSync(frozenPath(fixture, EXTRA_DATA_PATH), 'utf8'), EXTRA_DATA_BYTES);
  assert.deepEqual(fs.readFileSync(frozenPath(fixture, 'src/App.tsx')), fs.readFileSync(path.join(OWNER_ROOT, 'reference', 'src/App.tsx')), 'frozen src must carry the preserved reference bytes');
  const verified = await verifySelection(fixture.request);
  assert.equal(verified.treeDigest, inventoryTree({ root: fixture.frozen.snapshotRoot, skipNames: [] }).digest, 'the frozen tree must equal the C3-verified tree');
  return verified;
}

test('controlled canonical overlay preserves original hygiene', async t => {
  const { fixture, markSuccess } = await createRetainedFixture(t, { variant: 'reference', mutateWorkspace: poisonWorkspace });
  const verified = await assertPoisonedFrozen(fixture);
  const inputsBefore = inputDigests();
  const before = snapshotInputs(fixture);

  // The public facade binds production collaborators only: the runtime seam cannot be injected
  // through it. (The controlled flow below deliberately uses the internal controller seam.)
  assert.equal(evaluateFrozen.length, 1, 'evaluateFrozen accepts the request alone');

  // Seam probe (Captain-fixed): call the internal stageFrozen directly over the ACTUAL starter
  // canonical tree, so "canonical" here is the real challenge bytes and not the helper stand-in.
  const seamRoot = path.join(fixture.root, 'seam-evaluation');
  const claim = await stageFrozen(verified, { ...fixture.request, outputRoot: seamRoot }, { canonicalRoot: path.join(OWNER_ROOT, 'starter') });
  try {
    for (const name of TOOLING) {
      assert.deepEqual(fs.readFileSync(path.join(claim.appRoot, name)), starterBytes(name), 'staged canonical tooling must equal the actual starter bytes: ' + name);
      assert.notEqual(fs.readFileSync(path.join(claim.appRoot, name), 'utf8'), POISON[name], 'poisoned tooling must not survive into the staged product: ' + name);
    }
    for (const name of VISIBLE_TESTS) {
      assert.deepEqual(fs.readFileSync(path.join(claim.appRoot, name)), starterBytes(name), 'staged canonical visible test must equal the actual starter bytes: ' + name);
      assert.notEqual(fs.readFileSync(path.join(claim.appRoot, name), 'utf8'), POISON[name], 'poisoned visible test must not survive into the staged product: ' + name);
    }
    assert.equal(fs.readFileSync(path.join(claim.appRoot, EXTRA_DATA_PATH), 'utf8'), EXTRA_DATA_BYTES, 'the retained participant data file must survive the overlay');
    // The overlay touched only the staged copy: the frozen originals are still poisoned and intact.
    assert.equal(inventoryTree({ root: fixture.frozen.snapshotRoot, skipNames: [] }).digest, verified.treeDigest, 'the frozen snapshot must be unchanged by staging');
    for (const name of [...TOOLING, ...VISIBLE_TESTS]) assert.equal(fs.readFileSync(frozenPath(fixture, name), 'utf8'), POISON[name], 'frozen original must remain poisoned after staging: ' + name);
  } finally {
    const seamCleanup = cleanupScratch(claim);
    assert.deepEqual(seamCleanup, { removed: true, residue: [], errors: [] }, 'the seam probe retires exactly its own scratch');
    assert.equal(fs.existsSync(claim.scratchRoot), false);
    assertNoScratchResidue(seamRoot);
  }

  // Then the controlled controller over the same poisoned frozen copy. Each stage is probed AT THE
  // MOMENT it runs (the scratch is gone once the controller returns, so a post-run read could not
  // prove anything): the wrapped override inspects the live staged product, then defers to the shared
  // helper override. Wrapping is test-local; no helper file is edited. The helper's canonical stand-in
  // replaces the poison before any stage sees the product, and nothing here launches a tool, a
  // server, a browser or a real process.
  const probes = [];
  for (const stage of ['typecheck', 'build', 'visible', 'browser', 'useful']) {
    const original = fixture.runtime.stageOverrides[stage];
    fixture.runtime.stageOverrides[stage] = async context => {
      assert.notEqual(context.appRoot, fixture.frozen.snapshotRoot, stage + ' must see the staged product, never the frozen original');
      assert.ok(!context.appRoot.startsWith(OWNER_ROOT + path.sep) && !context.appRoot.startsWith(fixture.frozen.snapshotRoot + path.sep), 'staged product stays outside the repository and the frozen snapshot');
      for (const name of [...TOOLING, ...VISIBLE_TESTS]) {
        const staged = fs.readFileSync(path.join(context.appRoot, name), 'utf8');
        assert.notEqual(staged, POISON[name], 'the canonical overlay must have replaced the poison before ' + stage + ' saw the product: ' + name);
      }
      assert.equal(fs.readFileSync(path.join(context.appRoot, EXTRA_DATA_PATH), 'utf8'), EXTRA_DATA_BYTES, 'the retained participant data file must survive for every stage');
      probes.push(stage);
      return original(context);
    };
  }
  const originalInspection = fixture.runtime.stageOverrides.inspection;
  fixture.runtime.stageOverrides.inspection = async context => {
    // Hygiene is measured on the frozen ORIGINAL: at inspection time the snapshot still carries every
    // poison byte, and the helper's inspection fake reports the frozen-original context it was given.
    for (const name of [...TOOLING, ...VISIBLE_TESTS]) assert.equal(fs.readFileSync(path.join(context.appRoot, name), 'utf8'), POISON[name], 'the frozen original must still be poisoned when hygiene runs: ' + name);
    probes.push('inspection');
    return originalInspection(context);
  };

  const result = await evaluateWithRuntime(fixture.request, fixture.runtime);
  assert.equal(result.status, 'success', JSON.stringify(result.error ?? result));
  const order = fixture.events.map(event => event.name);
  assert.deepEqual(order.slice(0, 4), ['verify-before', 'copy-frozen', 'canonical-replacement', 'prepared-dependencies'], 'the canonical overlay must complete before the first tool stage: ' + JSON.stringify(order));
  assert.deepEqual(probes, ['typecheck', 'build', 'visible', 'browser', 'useful', 'inspection'], 'every stage must have been probed while its product was live');
  const inspection = fixture.contexts.find(context => context.stage === 'inspection');
  assert.equal(inspection.appRoot, fixture.frozen.snapshotRoot, 'hygiene/inspection must run on the frozen ORIGINAL, not the staged copy');
  assert.equal(order.indexOf('inspection'), 10, 'inspection runs after the re-verification of the frozen tree');
  assert.equal(result.snapshot.before, verified.treeDigest);
  assert.equal(result.snapshot.after, result.snapshot.before);
  assert.equal(result.cleanup.removed, true, JSON.stringify(result.cleanup));
  assert.deepEqual(result.cleanup.residue, []);
  assert.deepEqual(result.cleanup.errors, []);
  assertNoScratchResidue(fixture.request.outputRoot);

  assertInputsUnchanged(fixture, before);
  assert.deepEqual(inputDigests(), inputsBefore, 'starter, reference, fixtures, hidden tests and recorded artifacts must be byte-identical');
  markSuccess(); // every assertion above passed: only now may the shared helper's retirement hook run
});

test('production tampered reference preserves original hygiene', async t => {
  const { fixture, markSuccess } = await createRetainedFixture(t, { variant: 'reference', mutateWorkspace: poisonWorkspace });
  const verified = await assertPoisonedFrozen(fixture);
  // The unchanged public evidence inspector, loaded only inside this callback (never at module load)
  // so a worker that runs only the controlled test never loads the pinned parser.
  const { inspectPublic } = await import('../../evaluator/collect-evidence.mjs');
  const inputsBefore = inputDigests();
  const before = snapshotInputs(fixture);

  // The single supported public entry: real bounded tooling, real loopback browser stage, real
  // cooperative useful stage, no injected collaborator of any kind.
  const result = await evaluateFrozen(fixture.request);
  console.log('tampered production result summary:', JSON.stringify({
    status: result.status,
    stages: result.stages?.map(stage => stage.stage + ':' + stage.status) ?? null,
    visible: result.evidence ? { passed: result.evidence.visiblePassed, total: result.stages.find(s => s.stage === 'visible').value.total } : null,
    hidden: result.evidence ? { count: result.evidence.hidden.length, passed: result.evidence.hidden.filter(r => r.passed).length } : null,
    typecheck: result.evidence?.typecheck ?? null, build: result.evidence?.build ?? null,
    useful: result.evidence ? { addedCount: result.evidence.usefulTests.addedCount, baselinePassed: result.evidence.usefulTests.baselinePassed, killed: result.evidence.usefulTests.killedMutations } : null,
    noSuppression: result.evidence?.noSuppression ?? null, hygiene: result.evidence?.hygiene ?? null,
    automated: result.bundle?.score?.automated ?? null, error: result.error ?? null, cleanup: result.cleanup,
  }));
  assert.equal(result.status, 'success', 'production tamper run must succeed: error=' + JSON.stringify(result.error ?? null) + ' cleanup=' + JSON.stringify(result.cleanup ?? null));
  assert.deepEqual(result.stages.map(stage => stage.stage), ['typecheck', 'build', 'visible', 'browser', 'useful', 'inspection']);
  for (const stage of result.stages) assert.equal(stage.status, 'success', stage.stage + ' must be a successful real stage: ' + JSON.stringify(stage));

  const evidence = result.evidence;
  const visibleTotal = result.stages.find(stage => stage.stage === 'visible').value.total;
  assert.equal(evidence.typecheck, true, 'the poisoned tsconfig/package.json must not reach tsc');
  assert.equal(evidence.build, true, 'the poisoned vite.config.ts must not reach vite');
  assert.deepEqual({ passed: evidence.visiblePassed, total: visibleTotal }, { passed: 17, total: 17 }, 'the poisoned visible tests must not reach vitest');
  assert.deepEqual(evidence.hidden.map(({ id, area, passed }) => ({ id, area, passed })), EXPECTED_PROPERTIES.map(expected => ({ ...expected, passed: true })));
  assert.equal(new Set(evidence.hidden.map(record => record.id)).size, 25);
  assert.equal(evidence.hidden.every(record => !('error' in record) && !('phase' in record)), true);

  // The limited fixture added no test, so the cooperative stage truthfully reports the empty baseline.
  assert.deepEqual({ addedCount: evidence.usefulTests.addedCount, baselinePassed: evidence.usefulTests.baselinePassed, killed: evidence.usefulTests.killedMutations }, { addedCount: 0, baselinePassed: false, killed: [] });
  assert.equal(evidence.noSuppression, true, 'the preserved reference src carries no suppression');

  // Hygiene is measured on the frozen ORIGINAL: the tampered visible tests and lockfile keep the two
  // dependent flags false, exactly as the old evaluator recorded, while the other three stay true.
  const inspected = inspectPublic(fixture.frozen.snapshotRoot);
  assert.deepEqual(inspected.hygiene, { visibleIntact: false, lockedDependencies: false, noSecrets: true, noDebugLogging: true, noNetwork: true }, 'inspectPublic on the poisoned frozen original');
  assert.equal(inspected.noSuppression, true);
  assert.deepEqual(evidence.hygiene, inspected.hygiene, 'the production evidence hygiene must equal inspectPublic(frozen)');
  assert.equal(evidence.noSuppression, inspected.noSuppression);

  // Scoring stays with the unchanged scorer over the Captain-validated raw evidence, and the packet's
  // fixed table must match it area by area. No value here is refreshed or tuned.
  const expectedScore = score(validateScorerEvidence(evidence), null);
  const bundle = result.bundle;
  assert.ok(bundle !== null && typeof bundle === 'object' && !Array.isArray(bundle), 'production evaluateFrozen must attach an EvidenceBundle');
  assert.deepEqual(bundle.score, expectedScore, 'bundle score must equal the unchanged scorer applied to the raw evidence');
  assert.deepEqual(bundle.score.areas, EXPECTED_AREAS, 'every score area must match the packet table');
  for (const [area, points] of Object.entries(EXPECTED_AREAS)) assert.equal(bundle.score.areas[area], points, 'score area ' + area);
  assert.equal(bundle.score.areas.hygiene, 3 * (3 / 5), 'hygiene is the scorer binary floating sum');
  assert.notEqual(bundle.score.areas.hygiene, 1.8, 'the score must not be rounded to 1.8');
  assert.equal(bundle.score.automated, EXPECTED_AUTOMATED);
  assert.equal(bundle.score.automated, 73.8, 'automated total of the tampered limited reference fixture');
  assert.equal(bundle.score.automatedMaximum, 80);
  assert.equal(bundle.score.humanUI, null);
  assert.equal(bundle.score.status, 'HUMAN_REVIEW_PENDING');

  // The bundle projection, snapshot and artifact digests must reflect the real run and the real bytes.
  assert.deepEqual(readEvidenceBundle(JSON.stringify(bundle)), bundle, 'readEvidenceBundle roundtrip must reproduce the production bundle');
  assert.deepEqual(validateEvidenceBundle(JSON.parse(JSON.stringify(bundle))), bundle, 'validateEvidenceBundle must accept the production bundle unchanged');
  assert.equal(bundle.kind, 'EvidenceBundle');
  assert.equal(bundle.executionStatus, 'success');
  assert.equal(bundle.evaluationId, result.evaluationId);
  assert.deepEqual(bundle.properties, evidence.hidden.map(({ id, area, passed }) => ({ id, area, passed })));
  assert.deepEqual({ passed: bundle.visible.passed, total: bundle.visible.total }, { passed: 17, total: 17 });
  assert.equal(bundle.typecheck, true);
  assert.equal(bundle.build, true);
  assert.equal(bundle.noSuppression, true);
  assert.deepEqual(bundle.hygiene, inspected.hygiene, 'bundle hygiene must equal inspectPublic(frozen)');
  assert.deepEqual(bundle.usefulTests, { baselinePassed: false, addedCount: 0, killedMutations: [] });
  const actualFrozenDigest = inventoryTree({ root: fixture.frozen.snapshotRoot, skipNames: [] }).digest;
  assert.equal(bundle.snapshot.before, actualFrozenDigest);
  assert.equal(bundle.snapshot.after, actualFrozenDigest);
  assert.equal(bundle.snapshot.before, verified.treeDigest, 'the bundle snapshot must name the actual frozen tree digest');
  assert.equal(bundle.identities.submission.treeDigest, verified.treeDigest);
  assert.deepEqual(bundle.snapshot, { before: actualFrozenDigest, after: actualFrozenDigest, workspaceMatchesFrozen: result.snapshot.workspaceMatchesFrozen });
  for (const entry of bundle.artifactDigests) {
    const bytes = fs.readFileSync(path.join(fixture.request.outputRoot, entry.path));
    assert.equal(entry.bytes, bytes.length, entry.path + ' recorded bytes must equal the retained file');
    assert.equal(entry.sha256, sha256(bytes), entry.path + ' recorded sha256 must equal the retained bytes');
  }
  assert.deepEqual([...bundle.artifactDigests.map(entry => entry.path)].sort(), [...result.artifacts].sort());

  // Cleanup and input hygiene: only the run's own scratch retired, every input byte identical.
  assert.equal(result.cleanup.removed, true, JSON.stringify(result.cleanup));
  assert.deepEqual(result.cleanup.residue, []);
  assert.deepEqual(result.cleanup.errors, []);
  assertNoScratchResidue(fixture.request.outputRoot);
  assertInputsUnchanged(fixture, before);
  assert.deepEqual(inputDigests(), inputsBefore, 'starter, reference, fixtures, hidden tests and recorded artifacts must be byte-identical');
  markSuccess(); // every assertion above passed: only now may the shared helper's retirement hook run
});
