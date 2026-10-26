// Pure S1 report projection. All filesystem and identity verification happened in the
// Captain-owned context resolver; this module only projects the returned facts into the
// closed Report schema, hashes them and returns the contract's validated defensive copy.
// No evaluation, no inference beyond the returned facts, no filesystem access, no injection.
import { resolveReportContext } from './report-context.mjs';
import { refuseReport, validateReport, digestOf, reportDigestOf, actualEvaluatorOf } from './report-contract.mjs';
import { projectMeasurements } from './measurements.mjs';

/** Projects a verified C3/C4 context into a validated Report; refusals propagate as thrown errors. */
export async function createReport(request) {
  const { reportId, createdAt, bindings, bundle, evaluationId, status, measurementContext } = await resolveReportContext(request);
  const unsigned = {
    schemaVersion: '1.0.0',
    kind: 'Report',
    reportId,
    createdAt,
    bindings,
    actualEvaluator: actualEvaluatorOf(bundle),
    configuration: measurementContext.configuration,
    execution: {
      agentOutcome: null,
      evaluatorExecution: status === 'success' ? 'SUCCESS' : 'INFRASTRUCTURE_ERROR',
      humanReview: 'NOT_REVIEWED',
      assessmentTrust: 'LOCAL_SELF_ASSESSMENT',
      enforcement: 'manual',
      enforced: false,
    },
    quality: bundle ? bundle.score : null,
    evidence: { evaluationId, bundleDigest: bundle ? digestOf(bundle) : null, bundle },
    measurements: projectMeasurements(measurementContext.projection),
    provenance: { parentReportId: null, parentReportDigest: null, review: null, sources: measurementContext.sources },
    artifacts: bundle ? bundle.artifactDigests : [],
  };
  return validateReport({ ...unsigned, reportDigest: reportDigestOf(unsigned) });
}

/** Parses Report JSON text, refuses non-string input, and returns the contract's validated copy. */
export function readReport(text) {
  if (typeof text !== 'string') refuseReport('Report JSON text required');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    refuseReport('Invalid Report JSON text');
  }
  return validateReport(value);
}
