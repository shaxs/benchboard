// Captain-owned UI input/baseline binding boundary. Metadata validation is not human authentication.
import { validateReport } from './report-contract.mjs';
import { UIWorksheetError, validateUIWorksheetFacts } from './ui-validation.mjs';
export { UIWorksheetError } from './ui-validation.mjs';
const fail = message => { throw new UIWorksheetError(message); };

export function worksheetBindingsOf(report) {
  const r = validateReport(report);
  if (r.execution.evaluatorExecution !== 'SUCCESS' || r.evidence.bundle === null) fail('UI review requires a successful bound automated report');
  return {
    bindings: { reportId: r.reportId, reportDigest: r.reportDigest, evaluationId: r.evidence.evaluationId, bundleDigest: r.evidence.bundleDigest, snapshotId: r.bindings.snapshotId, treeDigest: r.bindings.treeDigest },
    baseline: { challengeIdentityDigest: r.bindings.challengeIdentityDigest, starterDigest: r.bindings.workloadDigest, workloadDigest: r.bindings.workloadDigest },
  };
}

export function validateUIWorksheet(value, report) {
  return validateUIWorksheetFacts(value, worksheetBindingsOf(report));
}
