// C4.S1.T4c — independent reference-copy smoke acceptance (production path only).
//
// This suite is the real-browser proof: it builds a FRESH frozen C3 publication whose workspace
// carries reference source bytes (helper variant 'reference'), then calls ONLY the supported
// production facade evaluateFrozen (packages/evaluation/evaluate-frozen.mjs). The helper's
// canonicalRoot/dependencyRoot/runtime descriptor (fake runProcess, fake stage collaborators) are
// deliberately IGNORED: the production runtime binds the real bounded process runner, the real
// Playwright Chromium preflight, the real starter tooling (starter/node_modules tsc/vite/vitest),
// the unchanged loopback server and the unchanged hidden property list. Nothing here injects a
// participant-controlled module, and the browser cache comes only from the command environment set
// by the packet's wrapped PowerShell proof (never discovered or set in any tracked file).
//
// Scratch lifetime is observed from OUTSIDE the runtime with a bounded timer scoped to the
// request output root. The expectation table (17 visible, the 25 property IDs/areas, hygiene) lives
// in this test, never in the helper. Full score parity/repeat belongs to S3 and is not asserted
// here; the raw S1 result score must stay null at this layer. The S2.R1.P block below asserts only
// the ACTUAL production bundle the facade attached (score recomputed from the raw evidence through
// the unchanged scorer, real identity bindings, real artifact bytes, relative-path privacy walk),
// never an invented full-reference 80 or an S3 parity claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateFrozen } from '../../packages/evaluation/evaluate-frozen.mjs';
import { OWNER_ROOT, verifySelection } from '../../packages/evaluation/staging.mjs';
import { inventoryTree, sha256 } from '../../packages/core/identity.mjs';
import { identityDigestOf } from '../../packages/core/manifest.mjs';
import { validateScorerEvidence, validateEvidenceBundle } from '../../packages/evaluation/bundle-contract.mjs';
import { readEvidenceBundle } from '../../packages/evaluation/bundle.mjs';
import { computeEvaluatorIdentity } from '../../packages/evaluation/evaluator-identity.mjs';
import { score } from '../../evaluator/score.mjs';
import { createFrozenFixture, snapshotInputs, assertInputsUnchanged } from './helpers.mjs';

// The 25 expected property records exactly as the hidden list names them: ids, areas, unique names.
const EXPECTED_PROPERTIES = Object.freeze([
  ...Array.from({ length: 13 }, (_, i) => ({ id: 'F' + String(i + 1).padStart(2, '0'), area: 'functional' })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: 'P' + String(i + 1).padStart(2, '0'), area: 'persistence' })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: 'E' + String(i + 1).padStart(2, '0'), area: 'edge' })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: 'I' + String(i + 1).padStart(2, '0'), area: 'integration' })),
]);

// Byte digests of every protected input domain the smoke must leave untouched. Default skip names
// exclude node_modules/dist/VCS, matching how the recorded evidence trees were established.
function sourceDigests(fixture) {
  return Object.freeze({
    starter: inventoryTree({ root: path.join(OWNER_ROOT, 'starter') }).digest,
    reference: inventoryTree({ root: path.join(OWNER_ROOT, 'reference') }).digest,
    fixtures: inventoryTree({ root: path.join(OWNER_ROOT, 'fixtures') }).digest,
    hiddenTests: inventoryTree({ root: path.join(OWNER_ROOT, 'evaluator/hidden-tests') }).digest,
    frozen: snapshotInputs(fixture).frozen,
    workspace: snapshotInputs(fixture).workspace,
  });
}

// Honest external scratch witness: a bounded interval that may only look at the request output
// root. It records first-sighting of a scratch- directory and its removal. Synchronous cleanup can
// remove the scratch just before evaluateFrozen resolves, so one bounded sample function is shared
// by the interval AND called immediately before stop clears the timer (the Captain-identified
// scheduling bug in attempt 1's observer). It can never claim to have seen every microsecond of
// the scratch lifetime, and a witnessed clean removal proves only this run's scratch was removed,
// not general crash-reaping.
function startScratchWitness(outputRoot) {
  const events = [];
  let seen = null;
  let stopped = false;
  const sample = () => {
    if (stopped) return;
    let present;
    try { present = fs.readdirSync(outputRoot).filter(name => name.startsWith('scratch-')); }
    catch { present = []; }
    const next = new Set(present);
    for (const name of present) if (!seen?.has(name)) events.push({ phase: 'appeared', name });
    for (const name of seen ?? []) if (!next.has(name)) events.push({ phase: 'removed', name });
    seen = next;
  };
  const timer = setInterval(sample, 200);
  timer.unref();
  return { events, sample, stop() { sample(); stopped = true; clearInterval(timer); } };
}

test('production evaluateFrozen on a temporary frozen reference copy: real tools, real Chromium, 17/25, hygiene, cleanup, inputs intact', async t => {
  const fixture = await createFrozenFixture(t, { variant: 'reference' });
  // The accepted request default timeoutMs (300000) is exercised unmodified: the observed real run
  // is well below it. If a measured timeout ever occurs, this smoke stops and reports; no request
  // override, no source default change.
  const request = fixture.request;

  const sourcesBefore = sourceDigests(fixture);
  const inputsBefore = snapshotInputs(fixture);
  const witness = startScratchWitness(request.outputRoot);
  let result;
  try {
    result = await evaluateFrozen(request);
  } finally {
    witness.stop();
  }
  // Report the actual production outcome honestly BEFORE asserting, so a red run still tells the
  // Captain exactly which parts matched (evidence values) and which did not (cleanup observation).
  console.log('production result summary:', JSON.stringify({
    status: result.status,
    stages: result.stages?.map(s => s.stage + ':' + s.status),
    visible: result.evidence ? { passed: result.evidence.visiblePassed, total: result.stages.find(s => s.stage === 'visible').value.total } : null,
    hidden: result.evidence ? { count: result.evidence.hidden.length, passed: result.evidence.hidden.filter(r => r.passed).length } : null,
    typecheck: result.evidence?.typecheck ?? null, build: result.evidence?.build ?? null,
    useful: result.evidence ? { addedCount: result.evidence.usefulTests.addedCount, baselinePassed: result.evidence.usefulTests.baselinePassed, killed: result.evidence.usefulTests.killedMutations } : null,
    noSuppression: result.evidence?.noSuppression ?? null, hygiene: result.evidence?.hygiene ?? null,
    error: result.error ?? null, cleanup: result.cleanup,
  }));
  assert.equal(result.status, 'success', 'production smoke must succeed: error=' + JSON.stringify(result.error ?? null) + ' cleanup=' + JSON.stringify(result.cleanup ?? null));

  // --- successful tool order: stages completed in the established sequence (inspection last) ---
  assert.deepEqual(result.stages.map(stage => stage.stage), ['typecheck', 'build', 'visible', 'browser', 'useful', 'inspection']);
  for (const stage of result.stages) assert.equal(stage.status, 'success', stage.stage + ' must be a successful real stage: ' + JSON.stringify(stage));

  // --- real evidence: 17 visible results, all 25 unique expected property records, reference hygiene ---
  const evidence = result.evidence;
  const visibleStage = result.stages.find(stage => stage.stage === 'visible');
  assert.equal(evidence.typecheck, true);
  assert.equal(evidence.build, true);
  assert.deepEqual({ passed: evidence.visiblePassed, total: visibleStage.value.total }, { passed: 17, total: 17 });
  const actual = evidence.hidden.map(record => ({ id: record.id, area: record.area, passed: record.passed }));
  assert.deepEqual(actual, EXPECTED_PROPERTIES.map(expected => ({ ...expected, passed: true })));
  assert.equal(new Set(evidence.hidden.map(r => r.id)).size, 25);
  assert.equal(new Set(evidence.hidden.map(r => r.name)).size, 25, 'every property record must carry a unique name');
  assert.equal(evidence.hidden.every(r => !('error' in r) && !('phase' in r)), true, 'no property may carry a failure record');
  // The retained browser artifact must agree with the returned evidence.
  const hiddenArtifact = JSON.parse(fs.readFileSync(path.join(request.outputRoot, 'browser/hidden.json'), 'utf8'));
  assert.deepEqual(hiddenArtifact.map(r => ({ id: r.id, passed: r.passed })), evidence.hidden.map(r => ({ id: r.id, passed: r.passed })));
  // Reference has no added tests: the cooperative stage truthfully reports the empty baseline.
  assert.deepEqual({ addedCount: evidence.usefulTests.addedCount, baselinePassed: evidence.usefulTests.baselinePassed, killed: evidence.usefulTests.killedMutations }, { addedCount: 0, baselinePassed: false, killed: [] });
  assert.equal(evidence.noSuppression, true);
  assert.deepEqual(evidence.hygiene, { visibleIntact: true, lockedDependencies: true, noSecrets: true, noDebugLogging: true, noNetwork: true }, 'reference hygiene measured on the frozen originals');
  assert.match(evidence.analysisMethod, /TypeScript syntax tree/);
  assert.equal(result.score, null, 'score parity belongs to S3; this layer never scores');

  // --- retained logs for every real stage (bounded retained artifacts) ---
  const artifacts = new Set(result.artifacts);
  for (const retained of [
    'typecheck/typecheck.stdout.log', 'typecheck/typecheck.stderr.log',
    'build/build.stdout.log', 'build/build.stderr.log',
    'visible/visible.json', 'visible/visible.stdout.log', 'visible/visible.stderr.log',
    'browser/server.log', 'browser/hidden.json', 'browser/stdout.log', 'browser/stderr.log',
    'useful/stdout.log', 'inspection/stdout.log',
  ]) assert.ok(artifacts.has(retained), 'retained log missing: ' + retained);
  assert.ok(result.artifacts.some(p => p.startsWith('inspection/exit-witness-')), 'real Node runs leave their bounded exit witnesses');

  // --- scratch absence on completion + honest witness report ---
  assert.equal(result.cleanup.removed, true, 'scratch cleanup must be confirmed: ' + JSON.stringify(result.cleanup));
  assert.deepEqual(fs.readdirSync(request.outputRoot).filter(name => name.startsWith('scratch-')), [], 'no scratch residue may remain');
  assert.equal(result.artifacts.filter(p => p.startsWith('scratch-')).length, 0);
  // Honest witness claim: if it ever saw the scratch appear, it must also have seen it removed;
  // a 200 ms interval can legitimately miss a short appearance, so appearance itself is reported,
  // not required, and a clean removal here proves only this run's scratch, never crash-reaping.
  if (witness.events.some(e => e.phase === 'appeared')) assert.ok(witness.events.some(e => e.phase === 'removed'), 'scratch the witness saw appear must also be seen removed');
  console.log('scratch witness events:', JSON.stringify(witness.events));
  console.log('snapshot:', JSON.stringify(result.snapshot), 'cleanup:', JSON.stringify(result.cleanup));

  // --- hash proof: frozen copy, participant workspace and protected sources unchanged ---
  assert.equal(result.snapshot.before, inputsBefore.frozen);
  assert.equal(result.snapshot.after, inputsBefore.frozen);
  assert.deepEqual(sourceDigests(fixture), sourcesBefore, 'protected inputs (reference source, frozen copy, starter tooling, fixtures, hidden tests) must be byte-identical after the run');
  assertInputsUnchanged(fixture, inputsBefore);

  // --- S2.R1.P (review F2): the ACTUAL production EvidenceBundle attached by evaluateFrozen ---
  // These assert the real bundle the production facade attached: presence, schema roundtrip, a score
  // recomputed from the raw evidence through the unchanged scorer (NOT an invented full-80 — this
  // limited 26-file reference fixture has no added tests, so usefulTests stays 0 and automated < 80),
  // identity bindings taken from the real C3 manifest/request, artifact digests over the real file
  // bytes, snapshot hashes of the real inputs, and a privacy walk rejecting host paths or private
  // report/error keys. Full-reference 80-point parity is an S3 claim and is asserted nowhere here.
  const bundle = result.bundle;
  assert.ok(bundle !== null && typeof bundle === 'object' && !Array.isArray(bundle), 'production evaluateFrozen must attach an EvidenceBundle');
  // JSON roundtrip through the accepted reader and the Captain validator must reproduce it exactly.
  const roundtripped = readEvidenceBundle(JSON.stringify(bundle));
  assert.deepEqual(roundtripped, bundle, 'readEvidenceBundle roundtrip must reproduce the production bundle');
  assert.deepEqual(validateEvidenceBundle(JSON.parse(JSON.stringify(bundle))), bundle, 'validateEvidenceBundle must accept the production bundle unchanged');

  // Score: recomputed through the unchanged scorer over the Captain-validated raw evidence, never
  // invented. The fixture has no added tests, so usefulTests is truthfully 0 and automated < 80.
  const expectedScore = score(validateScorerEvidence(result.evidence), null);
  assert.deepEqual(bundle.score, expectedScore, 'bundle score must equal the unchanged scorer applied to the raw evidence');
  assert.notEqual(bundle.score, null, 'the attached bundle carries the scorer result while the raw S1 result score stays null');
  assert.deepEqual(bundle.score.areas.usefulTests, 0, 'this limited reference fixture added no tests: usefulTests points are truthfully zero');
  assert.ok(bundle.score.automated < bundle.score.automatedMaximum, 'no full-reference 80 is claimed at this layer (S3 owns full score parity)');

  // Projected evidence must agree with the raw evidence exactly: all 25 property records, the visible
  // count, and every scalar/hygiene/usefulTests field.
  assert.deepEqual(bundle.properties, result.evidence.hidden.map(r => ({ id: r.id, area: r.area, passed: r.passed })), 'all 25 projected properties must equal the raw evidence records');
  assert.deepEqual({ passed: bundle.visible.passed, total: bundle.visible.total }, { passed: result.evidence.visiblePassed, total: 17 }, 'projected visible must equal the raw evidence count');
  assert.equal(bundle.typecheck, result.evidence.typecheck);
  assert.equal(bundle.build, result.evidence.build);
  assert.equal(bundle.noSuppression, result.evidence.noSuppression);
  assert.deepEqual(bundle.hygiene, result.evidence.hygiene);
  assert.deepEqual(bundle.usefulTests, { baselinePassed: result.evidence.usefulTests.baselinePassed, addedCount: result.evidence.usefulTests.addedCount, killedMutations: [...result.evidence.usefulTests.killedMutations] });
  assert.equal(bundle.kind, 'EvidenceBundle');
  assert.equal(bundle.executionStatus, 'success');
  assert.equal(bundle.evaluationId, result.evaluationId);

  // Identity bindings must be the ACTUAL C3 manifest/request values, not copies of the raw result.
  const verified = await verifySelection(fixture.request);
  assert.deepEqual(bundle.identities.challenge, { id: request.challenge.challengeId, digest: identityDigestOf(request.challenge) }, 'challenge binding must come from the request challenge');
  assert.deepEqual(bundle.identities.tooling, { id: verified.manifest.bindings.tooling.toolingId, digest: verified.manifest.bindings.tooling.toolingIdentityDigest }, 'tooling binding must come from the actual C3 run manifest');
  assert.equal(bundle.identities.evaluator.binding.id, request.evaluator.evaluatorId, 'C1 evaluator binding id must come from the request');
  const installed = computeEvaluatorIdentity();
  assert.deepEqual(bundle.identities.evaluator.binding.digest, identityDigestOf(request.evaluator), 'C1 binding digest is the request evaluator identity digest');
  assert.notEqual(bundle.identities.evaluator.binding.digest, installed.semanticDigest, 'the installed semantic identity must stay distinct from the C1 binding digest');
  assert.deepEqual(bundle.identities.evaluator.semanticManifest, installed.semanticManifest, 'installed semantic manifest must equal computeEvaluatorIdentity');
  assert.equal(bundle.identities.evaluator.semanticDigest, installed.semanticDigest, 'installed semantic digest must equal computeEvaluatorIdentity');
  assert.deepEqual(bundle.identities.evaluator.packageManifest, installed.packageManifest, 'installed package manifest must equal computeEvaluatorIdentity');
  assert.equal(bundle.identities.evaluator.packageDigest, installed.packageDigest, 'installed package digest must equal computeEvaluatorIdentity');
  assert.deepEqual(bundle.identities.submission, { runId: request.submission.runId, snapshotId: request.submission.snapshotId, frozenSubmissionId: request.submission.frozenSubmissionId, manifestDigest: request.submission.expectedDigest, treeDigest: verified.treeDigest }, 'submission identity must come from the actual request and C3 verification');

  // Artifact digests must cover exactly the retained artifact list with real file bytes and hashes.
  assert.deepEqual([...bundle.artifactDigests.map(entry => entry.path)].sort(), [...result.artifacts].sort(), 'bundle artifact digests must name exactly result.artifacts');
  for (const entry of bundle.artifactDigests) {
    const bytes = fs.readFileSync(path.join(request.outputRoot, entry.path));
    assert.equal(entry.bytes, bytes.length, entry.path + ' recorded bytes must equal the real file length');
    assert.equal(entry.sha256, sha256(bytes), entry.path + ' recorded sha256 must equal the real file bytes');
  }

  // Snapshot must carry the real before/after input hashes.
  assert.deepEqual(bundle.snapshot, { before: inputsBefore.frozen, after: inputsBefore.frozen, workspaceMatchesFrozen: result.snapshot.workspaceMatchesFrozen }, 'bundle snapshot must carry the actual input hashes');

  // Privacy walk: no host/volume/UNC absolute path and no private report/error key anywhere in the
  // serialized production bundle. Manifest and artifact paths stay relative by construction.
  const serialized = JSON.stringify(bundle);
  for (const value of bundleStrings(JSON.parse(serialized))) {
    assert.ok(!value.includes('\\'), 'bundle string must not contain a backslash host path: ' + value);
    assert.ok(!value.startsWith('//'), 'bundle string must not start with a UNC path: ' + value);
    assert.ok(!value.startsWith('/'), 'bundle string must not start with a POSIX absolute path: ' + value);
    assert.ok(!/^[A-Za-z]:/.test(value), 'bundle string must not start with a drive-volume path: ' + value);
  }
  const bundleKeys = new Set();
  (function collectKeys(node) {
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) { bundleKeys.add(key); collectKeys(value); }
    }
  })(bundle);
  for (const key of bundleKeys) {
    assert.ok(!/^(reportPath|reportpath)$/i.test(key), 'bundle must not leak a raw reportPath key');
    assert.ok(!/^(error|errors|errorStack|details)$/i.test(key), 'bundle must not leak a private error key: ' + key);
  }
  // Artifact paths in the bundle must themselves be relative (the privacy walk above covers every
  // string in the bundle; this names the specific invariant the reviewer asked for).
  for (const entry of bundle.artifactDigests) {
    assert.ok(!entry.path.startsWith('/') && !entry.path.includes('\\') && !/^[A-Za-z]:/.test(entry.path), 'artifact path must remain output-relative: ' + entry.path);
  }
  for (const entry of [...bundle.identities.evaluator.semanticManifest, ...bundle.identities.evaluator.packageManifest]) {
    assert.ok(!entry.path.startsWith('/') && !entry.path.includes('\\') && !/^[A-Za-z]:/.test(entry.path), 'identity manifest path must remain repository-relative: ' + entry.path);
  }

  // Succinct actual production-bundle summary for the reviewer (never an expected grade).
  console.log('production bundle summary:', JSON.stringify({
    schemaVersion: bundle.schemaVersion, kind: bundle.kind, executionStatus: bundle.executionStatus,
    score: bundle.score, automatedBelowMaximum: bundle.score.automated < bundle.score.automatedMaximum,
    visible: bundle.visible, properties: bundle.properties.length,
    challenge: bundle.identities.challenge, toolingId: bundle.identities.tooling.id,
    evaluatorBinding: bundle.identities.evaluator.binding.id, semanticDigest: bundle.identities.evaluator.semanticDigest,
    packageDigest: bundle.identities.evaluator.packageDigest, artifacts: bundle.artifactDigests.length,
    snapshot: bundle.snapshot,
  }));
});

// Every string value inside a JSON value, for the privacy walk (keys are checked separately).
function bundleStrings(node) {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(bundleStrings);
  if (node !== null && typeof node === 'object') return Object.values(node).flatMap(bundleStrings);
  return [];
}
