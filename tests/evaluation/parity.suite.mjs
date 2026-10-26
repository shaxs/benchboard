// C4.S3.T1 — full recorded-result differential / repeat over the production path.
//
// One top-level test evaluates FOUR fresh evaluations through the supported production facade
// evaluateFrozen ONLY (no fake collaborators, no root/runtime injection): starter bytes,
// full reference bytes (including participant additions such as reference/tests/regressions.test.tsx),
// artifacts/broken-source bytes, then a SECOND evaluation of the SAME unchanged frozen reference
// publication into a distinct exclusively-new output. Every fresh run is initialised externally
// from canonical 26-file starter bytes and the original starter challenge identity through the
// existing binding API; the complete fresh ordinary source selection replaces the live workspace
// bytes BEFORE the freeze (exact top-level C3 exclusions, plus the separately disclosed owner
// fixture marker), so the frozen snapshot carries full selected participant bytes while the sealed
// challenge binding stays the starter's. Prepared starter node_modules are bound only by the
// production facade's default roots; nothing here copies or installs dependencies, evaluates the
// original trees in place, or writes any protected tree (read-only source/data access is required).
//
// Expected values are read from the immutable recorded artifacts AS DATA (starter-visible.json,
// starter-browser/hidden.json, starter-report/report.json and the reference/broken equivalents)
// plus the Captain-fixed totals table; the bundle carries the score from the unchanged
// evaluator/score.mjs. There is no blessing, no refresh, no count-only comparison: every one of the
// 25 property ids/areas/pass values is compared keyed against the recorded records, every score
// area plus automated/maxima against the recorded quality, and the repeat against
// artifacts/reference-repeat/hidden.json and the first reference run's semantic fields.
//
// Legacy reconciliation (intentional, never "fixed"): the recorded reference quality.status is
// REFERENCE_NOT_A_BENCHMARK_PARTICIPANT while the new automated status is the neutral
// HUMAN_REVIEW_PENDING — areas/totals/pending nulls are compared, legacy trust is never
// manufactured. The recorded broken usefulTests:null stays the historical unknown and is never
// rewritten or defaulted to a measured 0; the useful AREA is compared and the newly observed
// count is recorded separately.
//
// On the FIRST infrastructure failure or any property/count/area/total mismatch or integrity
// drift the run stops (single test, sequential assertions, no retries, no probes, no expected
// edits) and the owned temporary fixture roots are PRESERVED as external diagnostic roots.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateFrozen } from '../../packages/evaluation/evaluate-frozen.mjs';
import { OWNER_ROOT } from '../../packages/evaluation/staging.mjs';
import { inventoryTree, sha256 } from '../../packages/core/identity.mjs';
import { createParityFixture, paritySnapshotInputs, assertParityInputsUnchanged, domainDigest } from './parity-fixtures.mjs';

// Recorded artifacts, read as data only — never rewritten, never "refreshed".
const readJson = relative => JSON.parse(fs.readFileSync(path.join(OWNER_ROOT, 'artifacts', relative), 'utf8'));
const RECORDED = Object.freeze({
  starter: { visible: readJson('starter-visible.json'), hidden: readJson('starter-browser/hidden.json'), report: readJson('starter-report/report.json') },
  reference: { visible: readJson('reference-visible.json'), hidden: readJson('reference-browser/hidden.json'), report: readJson('reference-report/report.json') },
  broken: { visible: readJson('broken-visible.json'), hidden: readJson('broken-browser/hidden.json'), report: readJson('broken-report/report.json') },
  referenceRepeatHidden: readJson('reference-repeat/hidden.json'),
});

// Captain-fixed totals table (§3). The recorded artifacts must independently agree with it;
// observations are compared to the recorded data, and the fixed table is the drift tripwire.
const FIXED = Object.freeze({
  starter: { automated: 20.6753, visiblePassed: 10, visibleTotal: 17, hiddenPassed: 3 },
  reference: { automated: 80, visiblePassed: 17, visibleTotal: 17, hiddenPassed: 25 },
  broken: { automated: 8.4118, visiblePassed: 1, visibleTotal: 17, hiddenPassed: 0 },
});
const AREA_KEYS = Object.freeze(['visible', 'functional', 'persistence', 'edge', 'integration', 'code', 'usefulTests', 'hygiene']);
const MUTATIONS = Object.freeze(['storage-drop', 'input-drop', 'focus-drop', 'label-case', 'date-order']);

// Pure relative-artifact-layout normalization for repeat comparison (S3 packet: IDs, logs and
// artifact digests may differ between runs of the same frozen publication). Each of the six
// stages retains exactly one per-run exit witness named with that run's random 32-hex nonce
// (packages/evaluation/process.mjs: crypto.randomBytes(16).toString('hex')). NOTHING else in a
// retained artifact path is run-specific, so ONLY that 32-hex nonce is normalized; every other
// filename stays byte-for-byte and no file is dropped from the comparison. The layout is
// REQUIRED to carry exactly one well-formed witness for EACH of the six stages: missing,
// duplicate or malformed (wrong stage directory, wrong length or wrong alphabet) witness
// entries are rejected, never silently normalized away.
const WITNESS_STAGES = Object.freeze(['typecheck', 'build', 'visible', 'browser', 'useful', 'inspection']);
const WITNESS_ENTRY = /^exit-witness-.*\.json$/; // witness entry recognition: basename only
const WITNESS_PATTERN = /^(typecheck|build|visible|browser|useful|inspection)\/exit-witness-[a-f0-9]{32}\.json$/;
function normalizedWitnessStage(relativePath) {
  if (typeof relativePath !== 'string') throw new TypeError('artifact layout entry must be a relative path string');
  const basename = relativePath.split('/').pop();
  if (!WITNESS_ENTRY.test(basename)) return null; // not a retained witness entry: left unchanged
  const match = WITNESS_PATTERN.exec(relativePath);
  if (match === null) throw new Error('malformed retained exit witness (each stage retains exactly one exit-witness-[32 hex].json): ' + relativePath);
  return { stage: match[1], path: match[1] + '/exit-witness-<nonce>.json' };
}
function normalizedArtifactLayout(relativePaths) {
  if (!Array.isArray(relativePaths) || relativePaths.some(p => typeof p !== 'string')) throw new TypeError('artifact layout requires an array of relative path strings');
  const stagesSeen = Object.create(null);
  const normalized = relativePaths.map(p => {
    const witness = normalizedWitnessStage(p);
    if (witness !== null) {
      if (stagesSeen[witness.stage]) throw new Error('duplicate retained exit witness for stage ' + witness.stage + ': ' + p);
      stagesSeen[witness.stage] = true;
      return witness.path;
    }
    return p;
  });
  for (const stage of WITNESS_STAGES) {
    if (!stagesSeen[stage]) throw new Error('missing retained exit witness for stage ' + stage);
  }
  return [...normalized].sort();
}

// Fast pure proof of the layout normalization itself (packet C4.S3.T1.R item 2): source strings
// only — no evaluation, child processes, tools, browser/server or filesystem. The six stage
// directories and the exit-witness basenames mirror the retained production layout exactly
// (stage dirs: typecheck/build/visible/browser/useful/inspection; nonce: 32 lowercase hex).
const NON_WITNESS = Object.freeze([
  'typecheck/tsc.log',
  'build/build.log',
  'visible/visible.json',
  'browser/hidden.json',
  'useful/tests-added.json',
  'inspection/inspection.json',
]);
function witnessLayout(nonces) {
  // Nonces: array of six 32-hex strings in WITNESS_STAGES order.
  return [
    ...WITNESS_STAGES.map((stage, i) => stage + '/exit-witness-' + nonces[i] + '.json'),
    ...NON_WITNESS,
  ];
}
test('artifact layout preserves structure and normalizes only witness nonces', () => {
  const noncesA = ['a1'.repeat(16), 'b2'.repeat(16), 'c3'.repeat(16), 'd4'.repeat(16), 'e5'.repeat(16), 'f6'.repeat(16)];
  const noncesB = noncesA.map(n => '0' + n.slice(1)); // all six changed, all still valid 32-hex
  const layoutA = witnessLayout(noncesA);
  const layoutB = witnessLayout(noncesB);
  // 1) Same layout, only the six witness nonces changed -> normalized layouts compare equal.
  assert.notDeepEqual([...layoutA].sort(), [...layoutB].sort(), 'sanity: raw layouts differ in the six nonces');
  assert.deepEqual(normalizedArtifactLayout(layoutA), normalizedArtifactLayout(layoutB),
    'valid layouts differing only in the six 32-hex witness nonces must compare equal');
  // The normalized layout keeps every path: exactly six normalized witnesses, nothing dropped.
  const normalizedA = normalizedArtifactLayout(layoutA);
  assert.equal(normalizedA.length, layoutA.length, 'normalization must not drop or add entries');
  assert.equal(normalizedA.filter(p => p.endsWith('exit-witness-<nonce>.json')).length, 6, 'exactly one normalized witness per stage, six total');
  assert.deepEqual(normalizedA.filter(p => !p.endsWith('exit-witness-<nonce>.json')).sort(),
    [...NON_WITNESS].sort(),
    'every non-witness path stays byte-for-byte unchanged');
  // 2) A changed NON-witness path stays unequal even with identical witness nonces.
  const layoutC = witnessLayout(noncesA).map(p => (p === 'visible/visible.json' ? 'visible/other.json' : p));
  assert.notDeepEqual(normalizedArtifactLayout(layoutA), normalizedArtifactLayout(layoutC),
    'a changed non-witness path must keep the layouts unequal');
  // 3) Rejections: missing witness, duplicate same-stage witness, malformed nonces.
  assert.throws(() => normalizedArtifactLayout(layoutA.filter(p => !p.startsWith('build/'))),
    /missing retained exit witness for stage build/, 'a missing stage witness must be rejected');
  assert.throws(() => normalizedArtifactLayout([...layoutA, 'build/exit-witness-' + '0f'.repeat(16) + '.json']),
    /duplicate retained exit witness for stage build/, 'a second witness for one stage must be rejected');
  assert.throws(() => normalizedArtifactLayout(layoutA.map(p => (p.startsWith('visible/') ? p.replace(/exit-witness-[a-f0-9]{32}\.json$/, 'exit-witness-' + 'aa'.repeat(32) + '.json') : p))),
    /malformed retained exit witness/, 'a 64-hex nonce is malformed and must be rejected');
  assert.throws(() => normalizedArtifactLayout(layoutA.map(p => (p.startsWith('useful/') ? p.replace(/exit-witness-[a-f0-9]{32}\.json$/, 'exit-witness-' + 'aa'.repeat(8) + '.json') : p))),
    /malformed retained exit witness/, 'a 16-hex nonce is malformed and must be rejected');
  assert.throws(() => normalizedArtifactLayout(layoutA.map(p => (p.startsWith('browser/') ? p.replace(/exit-witness-[a-f0-9]{32}\.json$/, 'exit-witness-' + 'AA'.repeat(16) + '.json') : p))),
    /malformed retained exit witness/, 'an uppercase (non-lowercase-hex) nonce is malformed and must be rejected');
  assert.throws(() => normalizedArtifactLayout(layoutA.map(p => (p.startsWith('typecheck/') ? p.replace(/exit-witness-[a-f0-9]{32}\.json$/, 'exit-witness-' + 'g1'.repeat(16) + '.json') : p))),
    /malformed retained exit witness/, 'a non-hex nonce is malformed and must be rejected');
  assert.throws(() => normalizedArtifactLayout([...layoutA.filter(p => !p.startsWith('build/')), 'build/extra/exit-witness-' + 'b2'.repeat(16) + '.json']),
    /malformed retained exit witness/, 'a witness nested below the stage directory is malformed and must be rejected');
});

// The 25 keyed {id, area, passed} records of one property list (the recorded hidden lists or a
// fresh evidence.hidden). Keyed comparison — never a count-only comparison.
function keyedProperties(list) {
  assert.equal(Array.isArray(list) && list.length, 25, 'exactly 25 property records are required');
  return Object.fromEntries(list.map(record => [record.id, { id: record.id, area: record.area, passed: record.passed }]));
}

// Protected/recorded DATA digests taken BEFORE and re-taken AFTER every evaluation: nothing an
// evaluation touched may differ. Protected trees are read-only; the recorded variant artifacts
// the differential reads as data are hashed file-for-file (bounded, not a whole-tree walk).
const RECORDED_DATA_FILES = Object.freeze([
  'starter-visible.json', path.join('starter-browser', 'hidden.json'), path.join('starter-report', 'report.json'),
  'reference-visible.json', path.join('reference-browser', 'hidden.json'), path.join('reference-report', 'report.json'),
  'broken-visible.json', path.join('broken-browser', 'hidden.json'), path.join('broken-report', 'report.json'),
  path.join('reference-repeat', 'hidden.json'),
]);
function protectedDataDigests() {
  return Object.freeze({
    starter: domainDigest(path.join(OWNER_ROOT, 'starter')),
    reference: domainDigest(path.join(OWNER_ROOT, 'reference')),
    brokenSource: domainDigest(path.join(OWNER_ROOT, 'artifacts', 'broken-source')),
    fixtures: domainDigest(path.join(OWNER_ROOT, 'fixtures')),
    hiddenTests: domainDigest(path.join(OWNER_ROOT, 'evaluator', 'hidden-tests')),
    recordedArtifacts: sha256(RECORDED_DATA_FILES.map(f => fs.readFileSync(path.join(OWNER_ROOT, 'artifacts', f))).join('\n---\n')),
  });
}

// One variant's full differential against its recorded data. Returns the raw production result.
function checkVariant(label, fixture, result, outputRoot) {
  const recorded = RECORDED[label];
  const fixed = FIXED[label];
  // Report the ACTUAL production outcome honestly before asserting, so a red run still names the
  // exact stage/counts that diverged.
  console.log(label + ' production summary:', JSON.stringify({
    status: result.status,
    stages: result.stages?.map(s => s.stage + ':' + s.status) ?? null,
    error: result.error ?? null,
  }));
  assert.equal(result.status, 'success', label + ': production evaluation must succeed, got ' + JSON.stringify(result.error ?? null));
  assert.deepEqual(result.stages.map(s => s.stage), ['typecheck', 'build', 'visible', 'browser', 'useful', 'inspection']);
  for (const stage of result.stages) assert.equal(stage.status, 'success', label + ': stage ' + stage.stage + ' must succeed');

  const evidence = result.evidence;
  // --- visible: observed count equals the RECORDED count (denominator 17), agreed by the table ---
  assert.equal(recorded.visible.numTotalTests, 17, label + ': recorded visible denominator must be 17');
  assert.equal(recorded.visible.numPassedTests, recorded.report.evidence.visiblePassed, label + ': recorded visible report/report.json disagreement');
  assert.equal(fixed.visiblePassed, recorded.report.evidence.visiblePassed, label + ': fixed table vs recorded visible drift');
  assert.equal(fixed.visibleTotal, 17);
  assert.deepEqual({ passed: evidence.visiblePassed, total: result.stages.find(s => s.stage === 'visible').value.total },
    { passed: recorded.visible.numPassedTests, total: 17 }, label + ': visible count must equal the recorded count');

  // --- hidden: all 25 keyed {id,area,pass} equal the recorded records; counts agree three ways ---
  const observedKeyed = keyedProperties(evidence.hidden);
  const recordedKeyed = keyedProperties(recorded.hidden);
  assert.deepEqual(observedKeyed, recordedKeyed, label + ': every property id/area/pass must equal the keyed recorded records');
  const observedPassed = evidence.hidden.filter(r => r.passed).length;
  const recordedPassed = recorded.hidden.filter(r => r.passed).length;
  assert.equal(observedPassed, recordedPassed, label + ': hidden passed count must equal the recorded count');
  assert.equal(fixed.hiddenPassed, recordedPassed, label + ': fixed table vs recorded hidden drift');

  // --- typecheck/build/hygiene/noSuppression equal the recorded evidence ---
  assert.equal(evidence.typecheck, recorded.report.evidence.typecheck);
  assert.equal(evidence.build, recorded.report.evidence.build);
  assert.equal(evidence.noSuppression, recorded.report.evidence.noSuppression);
  assert.deepEqual(evidence.hygiene, recorded.report.evidence.hygiene, label + ': hygiene must equal the recorded evidence');

  // --- useful tests ---
  const recordedUseful = recorded.report.evidence.usefulTests;
  if (recordedUseful === null) {
    // Legacy broken: usefulTests:null is the historical UNKNOWN. It is preserved as data and
    // never rewritten or defaulted to a measured 0; only the useful AREA is compared below, and
    // the newly observed count is recorded separately here.
    console.log(label + ' legacy unknown: recorded usefulTests=null; newly observed addedCount='
      + evidence.usefulTests.addedCount + ', baselinePassed=' + evidence.usefulTests.baselinePassed
      + ', killed=' + JSON.stringify(evidence.usefulTests.killedMutations));
  } else {
    assert.deepEqual({
      addedCount: evidence.usefulTests.addedCount,
      baselinePassed: evidence.usefulTests.baselinePassed,
      killedMutations: [...evidence.usefulTests.killedMutations].sort(),
    }, {
      addedCount: recordedUseful.addedCount,
      baselinePassed: recordedUseful.baselinePassed,
      killedMutations: [...recordedUseful.killedMutations].sort(),
    }, label + ': useful-test evidence must equal the recorded evidence');
  }
  if (label === 'reference') {
    assert.equal(evidence.usefulTests.addedCount, 8, 'full reference must observe the recorded 8 added tests');
    assert.deepEqual([...evidence.usefulTests.killedMutations].sort(), [...MUTATIONS].sort(), 'full reference must kill all 5 recorded mutations');
  }

  // --- score: bundle score (unchanged scorer) vs the recorded quality, every area + automated/maxima ---
  const bundle = result.bundle;
  assert.ok(bundle !== null && typeof bundle === 'object', label + ': production facade must attach an EvidenceBundle');
  const recordedQuality = recorded.report.quality;
  assert.equal(recordedQuality.automatedMaximum, 80);
  assert.equal(bundle.score.automated, recordedQuality.automated, label + ': automated total must equal the recorded quality');
  assert.equal(bundle.score.automated, fixed.automated, label + ': fixed table vs recorded automated drift');
  assert.equal(bundle.score.automatedMaximum, recordedQuality.automatedMaximum);
  for (const area of AREA_KEYS) {
    assert.ok(area in bundle.score.areas && area in recordedQuality.areas, label + ': recorded/new score area ' + area);
    assert.equal(bundle.score.areas[area], recordedQuality.areas[area], label + ': score area ' + area + ' must equal the recorded quality');
  }
  assert.equal(bundle.score.humanMaximum, recordedQuality.humanMaximum);
  assert.equal(bundle.score.qualityMaximum, recordedQuality.qualityMaximum);
  // Pending nulls: human UI and the combined quality are unmeasured, so null, never 0.
  assert.equal(bundle.score.humanUI, recordedQuality.humanUI);
  assert.equal(bundle.score.humanUI, null);
  assert.equal(bundle.score.quality, recordedQuality.quality);
  assert.equal(bundle.score.quality, null);
  // New automated status is the neutral pending status for every variant...
  assert.equal(bundle.score.status, 'HUMAN_REVIEW_PENDING', label + ': new automated status must be HUMAN_REVIEW_PENDING');
  // ...and the recorded legacy status is honored exactly as recorded data: the reference is
  // historically REFERENCE_NOT_A_BENCHMARK_PARTICIPANT (the reference is not a benchmark
  // participant), which is deliberately NOT manufactured or mirrored by the new automated run.
  if (label === 'reference') {
    assert.equal(recordedQuality.status, 'REFERENCE_NOT_A_BENCHMARK_PARTICIPANT', 'recorded reference status is historical data');
  } else {
    assert.equal(recordedQuality.status, 'HUMAN_REVIEW_PENDING', label + ': recorded status must match the neutral pending status');
  }

  // --- snapshot observation: before === after === the actually-frozen bytes ---
  assert.equal(result.snapshot.before, result.snapshot.after, label + ': frozen bytes must not drift during evaluation');
  assert.equal(result.snapshot.before, paritySnapshotInputs(fixture).frozen, label + ': snapshot must carry the actual frozen tree digest');
  // Captain-authored independent acceptance gate: selected raw source bytes, not just the helper's
  // before/after observations, must be the exact physical frozen tree that production evaluated.
  const selected = fixture.selection;
  const physicalFrozen = inventoryTree({ root: fixture.frozen.snapshotRoot, skipNames: [] });
  assert.deepEqual(physicalFrozen.entries.map(e => e.path), selected.files, label + ': no starter-only path may survive the selected source copy');
  assert.deepEqual(physicalFrozen.entries.map(e => [e.path, e.bytes, e.sha256]),
    selected.files.map(relative => {
      const bytes = fs.readFileSync(path.join(selected.sourceRoot, relative));
      return [relative, bytes.length, sha256(bytes)];
    }), label + ': frozen byte inventory must equal actual selected source bytes');
  assert.equal(physicalFrozen.digest, selected.digest, label + ': frozen digest must equal selected-source digest');
  assert.equal(result.bundle.identities.submission.treeDigest, selected.digest);

  // --- cleanup: confirmed removed, no residue, no errors, no scratch in the output ---
  assert.equal(result.cleanup.removed, true, label + ': scratch cleanup must be confirmed: ' + JSON.stringify(result.cleanup));
  assert.deepEqual(result.cleanup.residue, [], label + ': cleanup residue must be empty');
  assert.deepEqual(result.cleanup.errors, [], label + ': cleanup errors must be empty');
  assert.deepEqual(fs.readdirSync(outputRoot).filter(name => name.startsWith('scratch-')), [], label + ': no scratch residue in the output root');

  // --- recorded artifacts match the actual output-relative digest entries and real bytes ---
  assert.deepEqual([...bundle.artifactDigests.map(e => e.path)].sort(), [...result.artifacts].sort(), label + ': bundle digests must name exactly result.artifacts');
  for (const entry of bundle.artifactDigests) {
    const bytes = fs.readFileSync(path.join(outputRoot, entry.path));
    assert.equal(entry.bytes, bytes.length, label + ': ' + entry.path + ' bytes must match the real file');
    assert.equal(entry.sha256, sha256(bytes), label + ': ' + entry.path + ' sha256 must match the real file');
  }
  assert.equal(bundle.snapshot.before, result.snapshot.before);
  assert.equal(bundle.identities.submission.treeDigest, result.snapshot.before);

  console.log(label + ' observed:', JSON.stringify({
    visible: evidence.visiblePassed + '/17', hiddenPassed: observedPassed,
    areas: bundle.score.areas, automated: bundle.score.automated,
    useful: { addedCount: evidence.usefulTests.addedCount, baselinePassed: evidence.usefulTests.baselinePassed, killed: evidence.usefulTests.killedMutations },
    cleanup: result.cleanup, snapshot: result.snapshot.before, evaluationId: result.evaluationId,
  }));
  return { result, bundle, evidence };
}

// The reference publication is evaluated twice: same unchanged frozen bytes, distinct
// exclusively-new output and distinct evaluation id. Semantic fields must be identical;
// ids, logs, artifact digests and timestamps may differ.
test('S3 full recorded-result differential: starter, reference, broken, then a repeat of the same frozen reference', { timeout: 3600000 }, async t => {
  // Single shared retention token: on the FIRST failure every fixture root is preserved as the
  // owned external diagnostic root instead of being deleted (no failure evidence is destroyed).
  const retain = { failed: false };
  // The accepted request default timeoutMs (300000 per stage) is exercised unmodified; no request
  // option overrides it. The wall-clock allowance here is only the test-runner's outer bound for
  // four full six-stage productions runs, never a per-stage timeout change.
  try {
    const protectedBefore = protectedDataDigests();
    const repeatFiles = fs.readdirSync(path.join(OWNER_ROOT, 'artifacts', 'reference-repeat')).sort();
    assert.deepEqual(repeatFiles, ['board-1024.png', 'board-1440.png', 'board-768.png', 'drawer-1024.png', 'drawer-1440.png', 'drawer-768.png', 'hidden.json'],
      'recorded reference-repeat contains only hidden semantic records and six nonsemantic screenshots');
    console.log('recorded repeat inventory:', JSON.stringify(repeatFiles));

    // ---- variant 1: starter bytes ----
    const starterFixture = await createParityFixture(t, { sourceTree: 'starter', outputLabel: 'evaluation', retain });
    const starterInputs = paritySnapshotInputs(starterFixture);
    const starterResult = await evaluateFrozen(starterFixture.request);
    checkVariant('starter', starterFixture, starterResult, starterFixture.request.outputRoot);
    assertParityInputsUnchanged(starterFixture, starterInputs);

    // ---- variant 2: full reference bytes (with tests/regressions.test.tsx) ----
    const referenceFixture = await createParityFixture(t, { sourceTree: 'reference', outputLabel: 'evaluation', retain });
    const referenceInputs = paritySnapshotInputs(referenceFixture);
    const referenceResult = await evaluateFrozen(referenceFixture.request);
    const reference = checkVariant('reference', referenceFixture, referenceResult, referenceFixture.request.outputRoot);

    // ---- variant 3: recorded broken bytes ----
    const brokenFixture = await createParityFixture(t, { sourceTree: 'broken', outputLabel: 'evaluation', retain });
    const brokenInputs = paritySnapshotInputs(brokenFixture);
    const brokenResult = await evaluateFrozen(brokenFixture.request);
    checkVariant('broken', brokenFixture, brokenResult, brokenFixture.request.outputRoot);
    assertParityInputsUnchanged(brokenFixture, brokenInputs);

    // ---- variant 4: second evaluation of the SAME unchanged frozen reference publication ----
    // Distinct exclusively-new output root under the same fixture; the run container, frozen
    // snapshot and live workspace bytes are untouched between the two evaluations.
    const repeatRequest = { ...referenceFixture.request, outputRoot: path.join(referenceFixture.root, 'repeat') };
    const repeatResult = await evaluateFrozen(repeatRequest);
    const repeat = checkVariant('reference', referenceFixture, repeatResult, repeatRequest.outputRoot);

    // Repeat differential: outputs and evaluation ids differ; every semantic field is identical.
    assert.notEqual(repeatRequest.outputRoot, referenceFixture.request.outputRoot);
    assert.notEqual(repeatResult.evaluationId, referenceResult.evaluationId, 'a repeat must carry a distinct evaluation id');
    const semantic = bundle => ({
      properties: bundle.properties,
      visible: bundle.visible,
      build: bundle.build,
      typecheck: bundle.typecheck,
      usefulTests: bundle.usefulTests,
      noSuppression: bundle.noSuppression,
      hygiene: bundle.hygiene,
      score: bundle.score,
      semanticDigest: bundle.identities.evaluator.semanticDigest,
      treeDigest: bundle.identities.submission.treeDigest,
    });
    assert.deepEqual(semantic(repeat.bundle), semantic(reference.bundle), 'the repeat must match the first run on every semantic field');
    assert.deepEqual(normalizedArtifactLayout(repeat.bundle.artifactDigests.map(e => e.path)), normalizedArtifactLayout(reference.bundle.artifactDigests.map(e => e.path)), 'the repeat must produce the same relative artifact set (per-run exit-witness nonces may differ)');
    assert.deepEqual(keyedProperties(repeat.bundle.properties), keyedProperties(RECORDED.referenceRepeatHidden),
      'the repeat must match every property recorded in artifacts/reference-repeat/hidden.json');
    assertParityInputsUnchanged(referenceFixture, referenceInputs);

    console.log('repeat equality:', JSON.stringify({
      semanticFieldsIdentical: true,
      evaluationIdsDiffer: repeatResult.evaluationId !== referenceResult.evaluationId,
      outputsDiffer: true,
      propertiesMatchRecordedRepeat: true,
      firstEvaluationId: referenceResult.evaluationId, repeatEvaluationId: repeatResult.evaluationId,
    }));

    // ---- protected DATA digests must be byte-identical across all four evaluations ----
    const protectedAfter = protectedDataDigests();
    assert.deepEqual(protectedAfter, protectedBefore, 'protected source/artifact data must be unchanged by evaluation');
    console.log('protected data digests:', JSON.stringify(protectedAfter));
  } catch (error) {
    // FIRST failure stops everything: no retries, no probes, no expected edits. Preserve the
    // owned fixture roots and surface the exact actual/expected diagnostic immediately.
    retain.failed = true;
    console.log('S3 PARITY STOPPED — preserve diagnostic roots; do not rerun:', error?.message ?? String(error));
    throw error;
  }
});
