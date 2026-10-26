// Independent Captain diagnostics for the binding seam; no dependency on the worker projector.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReportContext } from '../../packages/results/report-context.mjs';
import { makeReportFixture } from './report-fixture.mjs';

test('S1 context resolves real C3 authority and captures caller inputs before its first await', async t => {
  const { fixture, input } = await makeReportFixture(t);
  const expectedRun = input.selection.runId;
  const pending = resolveReportContext(input);
  input.selection.runId = 'run-mutated-after-call';
  input.evaluation.bundle.score.automated = 0;
  const context = await pending;
  assert.equal(context.bindings.runId, expectedRun);
  assert.equal(context.bindings.manifestDigest, fixture.run.manifest.manifestDigest);
  assert.equal(context.bindings.treeDigest, fixture.frozen.frozenSubmission.treeDigest);
  assert.equal(context.bundle.score.automated, 75);
  assert.equal(context.evaluationId, context.bundle.evaluationId);
  assert.equal(context.manifest.runId, expectedRun);
  assert.equal(input.selection.runId, 'run-mutated-after-call', 'the seam neither follows nor repairs later caller mutations');
});
