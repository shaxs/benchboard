// Captain-owned bound fixture: real C3 verification, controlled C4 stages, no browser/server.
import { createFrozenFixture } from '../evaluation/helpers.mjs';
import { evaluateWithRuntime } from '../../packages/evaluation/controller.mjs';
import { attachEvidenceBundle } from '../../packages/evaluation/bundle-runtime.mjs';
import { computeEvaluatorIdentity } from '../../packages/evaluation/evaluator-identity.mjs';

export async function makeReportFixture(t) {
  const fixture = await createFrozenFixture(t);
  const installed = computeEvaluatorIdentity();
  const raw = await evaluateWithRuntime(fixture.request, fixture.runtime);
  const evaluation = await attachEvidenceBundle(fixture.request, raw, installed);
  return { fixture, input: { reportId: 'report-synthetic-001', createdAt: '2026-01-02T03:04:05.000Z', selection: fixture.request.submission, evaluation } };
}
