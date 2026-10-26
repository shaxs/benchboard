// Captain-authored binding/security and load-bearing acceptance tests for C5.S1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createReport, readReport } from '../../packages/results/report.mjs';
import { validateReport, reportDigestOf, digestOf, ReportIntegrityError } from '../../packages/results/report-contract.mjs';
import { EvaluationIntegrityError } from '../../packages/evaluation/bundle-contract.mjs';
import { LifecycleError } from '../../packages/core/lifecycle.mjs';
import { score } from '../../evaluator/score.mjs';
import { scorerEvidenceOf } from '../../packages/evaluation/bundle.mjs';
import { makeReportFixture } from './report-fixture.mjs';
import { snapshotInputs, assertInputsUnchanged } from '../evaluation/helpers.mjs';

const reportFailure = message => error => error instanceof ReportIntegrityError && error.code === 'REPORT_INTEGRITY' && message.test(error.message);
const evidenceFailure = message => error => error instanceof EvaluationIntegrityError && error.code === 'EVIDENCE_INTEGRITY' && message.test(error.message);

test('S1 binds C4 evidence to verified C3 inputs and keeps independent honest axes', async t => {
  const { fixture, input } = await makeReportFixture(t), before = snapshotInputs(fixture);
  const inputBefore = JSON.stringify(input);
  const report = await createReport(input);
  assert.equal(report.kind, 'Report');
  assert.equal(report.bindings.runId, input.selection.runId);
  assert.equal(report.bindings.snapshotId, input.selection.snapshotId);
  assert.equal(report.bindings.manifestDigest, input.selection.expectedDigest);
  assert.equal(report.bindings.workloadDigest, fixture.run.manifest.bindings.challenge.workloadDigest);
  assert.deepEqual(report.quality, score(scorerEvidenceOf(input.evaluation.bundle), null));
  assert.equal(report.quality.areas.edge, 5);
  assert.equal(report.quality.humanUI, null);
  assert.equal(report.quality.quality, null);
  assert.equal(report.execution.agentOutcome, null);
  assert.equal(report.execution.evaluatorExecution, 'SUCCESS');
  assert.equal(report.execution.humanReview, 'NOT_REVIEWED');
  assert.equal(report.execution.assessmentTrust, 'LOCAL_SELF_ASSESSMENT');
  assert.equal(report.execution.enforced, false);
  assert.equal(report.configuration.executionMode, 'MANUAL');
  assert.equal(report.configuration.workerCount, null);
  assert.equal(report.actualEvaluator.semanticDigest, input.evaluation.bundle.identities.evaluator.semanticDigest);
  assert.notEqual(report.actualEvaluator.semanticDigest, report.bindings.evaluatorIdentityDigest);
  assert.equal(report.reportDigest, reportDigestOf(report));
  assert.deepEqual(readReport(JSON.stringify(report)), report);
  assert.deepEqual(validateReport(report), report);
  assert.equal(JSON.stringify(input), inputBefore);
  assertInputsUnchanged(fixture, before);

  await t.test('fractional quality and failed checks retain exact unchanged scorer values', async () => {
    const changed = structuredClone(input), b = changed.evaluation.bundle;
    b.visible.passed = 10;
    b.properties = b.properties.map((p, index) => ({ ...p, passed: index < 3 || p.id === 'I01' }));
    b.build = false;
    b.usefulTests = { baselinePassed: false, addedCount: 0, killedMutations: [] };
    b.score = score({ visiblePassed: b.visible.passed, hidden: b.properties, typecheck: b.typecheck, build: b.build,
      noSuppression: b.noSuppression, usefulTests: b.usefulTests, hygiene: b.hygiene }, null);
    const fractional = await createReport(changed);
    assert.deepEqual(fractional.quality, b.score);
    assert.equal(fractional.quality.automated, Number(fractional.quality.automated.toFixed(4)));
    assert.equal(Number.isInteger(fractional.quality.automated), false, 'the fixture actually exercises a fractional automated total');
    assert.equal(fractional.execution.evaluatorExecution, 'SUCCESS', 'a failed quality check is not infrastructure');
    assert.equal(fractional.quality.areas.code, 3);
    assert.equal(fractional.quality.quality, null);
  });

  await t.test('returned infrastructure errors have no quality or evidence, never zero points', async () => {
    const failure = { status: 'infrastructure-error', evaluationId: null, bundle: null, evidence: null, score: null, error: { code: 'TIMEOUT', message: 'private diagnostic, not a report field' } };
    const failed = await createReport({ ...input, reportId: 'report-synthetic-failure', evaluation: failure });
    assert.equal(failed.execution.evaluatorExecution, 'INFRASTRUCTURE_ERROR');
    for (const value of [failed.quality, failed.actualEvaluator, failed.evidence.bundle, failed.evidence.bundleDigest]) assert.equal(value, null);
    assert.deepEqual(failed.artifacts, []);
    assert.equal(JSON.stringify(failed).includes('private diagnostic'), false);
    assert.equal(failed.execution.agentOutcome, null);
    assert.deepEqual(readReport(JSON.stringify(failed)), failed);
    await assert.rejects(createReport({ ...input, evaluation: { ...failure, score: 0 } }), reportFailure(/Incomplete infrastructure outcome or fabricated partial score/));
  });

  await t.test('each run, challenge, tooling, evaluator and snapshot mismatch is refused', async () => {
    const mutations = [
      b => { b.identities.challenge.id += '-other'; },
      b => { b.identities.challenge.digest = '0'.repeat(64); },
      b => { b.identities.tooling.id += '-other'; },
      b => { b.identities.tooling.digest = '0'.repeat(64); },
      b => { b.identities.evaluator.binding.id += '-other'; },
      b => { b.identities.evaluator.binding.digest = '0'.repeat(64); },
      ...['runId', 'snapshotId', 'frozenSubmissionId'].map(key => b => { b.identities.submission[key] += '-other'; }),
      b => { b.identities.submission.manifestDigest = '0'.repeat(64); },
      b => { b.identities.submission.treeDigest = b.snapshot.before = b.snapshot.after = '0'.repeat(64); },
      b => { b.evaluationId += '-other'; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const changed = structuredClone(input); mutate(changed.evaluation.bundle);
      await assert.rejects(createReport(changed), reportFailure(index === mutations.length - 1 ? /Evaluation ID mismatch/ : /Bundle identity differs from verified run\/submission bindings/), 'must refuse at the intended binding check, row ' + index);
    }
  });

  await t.test('malformed versions, invented outcomes, partial quality and modified digests refuse', async () => {
    for (const [mutate, message] of [
      [r => { r.schemaVersion = '2.0.0'; }, /Invalid Report schema/],
      [r => { r.execution.agentOutcome = 'COMPLETED'; }, /Invalid Report schema/],
      [r => { r.execution.enforced = true; }, /Invalid Report schema/],
      [r => { r.execution.assessmentTrust = 'OFFICIAL_SUPERVISED'; }, /Invalid Report schema/],
      [r => { r.quality.automated = 0; }, /Report score differs from unchanged scorer/],
      [r => { r.quality.areas.edge = 10; }, /Invalid Report schema/],
      [r => { r.evidence.bundleDigest = '0'.repeat(64); }, /Report evidence digest\/ID mismatch/],
      [r => { r.bindings.treeDigest = '0'.repeat(64); }, /Bundle identity differs from verified run\/submission bindings/],
      [r => { r.actualEvaluator.semanticDigest = r.bindings.evaluatorIdentityDigest; }, /Actual evaluator identity mismatch/],
      [r => { r.createdAt = '2026-02-30T00:00:00.000Z'; }, /Invalid UTC report timestamp/],
    ]) {
      const changed = structuredClone(report); mutate(changed); changed.reportDigest = reportDigestOf(changed);
      assert.throws(() => readReport(JSON.stringify(changed)), reportFailure(message));
    }
    const changed = structuredClone(report); changed.reportId += '-other';
    assert.throws(() => validateReport(changed), reportFailure(/Report digest mismatch/));
    assert.throws(() => readReport('not json'), reportFailure(/Invalid Report JSON text/));
    assert.throws(() => readReport({}), reportFailure(/Report JSON text required/));
  });

  await t.test('reader propagates typed C4 integrity errors for schema-valid semantic bundle tampering', () => {
    for (const [mutate, message] of [
      [b => { b.score.automated -= 1; }, /Bundle score differs from unchanged scorer/],
      [b => { b.identities.evaluator.semanticDigest = '0'.repeat(64); }, /Evaluator manifest digest mismatch/],
      [b => { b.identities.evaluator.packageDigest = '0'.repeat(64); }, /Evaluator manifest digest mismatch/],
      [b => { b.identities.evaluator.originalCandidate.scoring = '0'.repeat(64); }, /Original scoring identity mismatch/],
      [b => { b.snapshot.after = '0'.repeat(64); }, /Snapshot digest mismatch/],
      [b => { b.artifactDigests.push(structuredClone(b.artifactDigests[0])); }, /Duplicate artifact path/],
    ]) {
      const changed = structuredClone(report), b = changed.evidence.bundle;
      mutate(b);
      changed.quality = structuredClone(b.score);
      changed.artifacts = structuredClone(b.artifactDigests);
      changed.evidence.bundleDigest = digestOf(b);
      changed.reportDigest = reportDigestOf(changed);
      assert.throws(() => readReport(JSON.stringify(changed)), evidenceFailure(message));
    }
    const changed = structuredClone(input);
    changed.evaluation.bundle.identities.evaluator.packageDigest = '0'.repeat(64);
    return assert.rejects(createReport(changed), evidenceFailure(/Evaluator manifest digest mismatch/));
  });

  await t.test('refusals and arbitrary input never become reports', async () => {
    for (const evaluation of [new Error('refused evaluation'), { status: 'refused' }, { status: 'failure' }, null]) await assert.rejects(createReport({ ...input, evaluation }), reportFailure(/Only returned C4 evaluations are report inputs/));
    await assert.rejects(createReport({ ...input, undocumented: true }), reportFailure(/Explicit report request required/));
    await assert.rejects(createReport({ ...input, selection: { ...input.selection, expectedDigest: '0'.repeat(64) } }), error => error instanceof LifecycleError && error.code === 'PROVENANCE_MISMATCH' && /manifestDigest.*caller expects/.test(error.message));
    await assert.rejects(createReport({ ...input, selection: { ...input.selection, snapshotId: 'snapshot-other' } }), reportFailure(/One verified inactive frozen publication required/));
  });
});

test('S1 re-verifies frozen bytes before reporting and refuses modified saved source', async t => {
  const { fixture, input } = await makeReportFixture(t);
  const target = path.join(fixture.frozen.snapshotRoot, 'src', 'App.tsx');
  fs.appendFileSync(target, '\n// synthetic late tamper\n');
  await assert.rejects(createReport(input), reportFailure(/One verified inactive frozen publication required/));
});
