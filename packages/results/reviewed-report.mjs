// Pure S4 child-report preparation: attaches a Captain-validated UI review to a validated parent
// report and re-projects the measurements, with no IO, no storage write, no publication and no
// injection. Every validation delegates to the Captain boundaries: validateReport for the report
// layer (including the scored-report parentage and unchanged-scorer checks), validateUIWorksheet
// for the review's bindings and facts, and the unchanged evaluator scorer through scoreUIWorksheet.
// Inputs are read, never mutated; all upstream error classes propagate unwrapped.
import { validateReport, reportDigestOf } from './report-contract.mjs';
import { validateUIWorksheet } from './ui-contract.mjs';
import { scoreUIWorksheet } from './ui-worksheet.mjs';
import { measurementProjectionInput } from './measurement-contract.mjs';
import { projectMeasurements } from './measurements.mjs';

/**
 * Builds the unsigned reviewed child from validated parts: the parent's own fields with the new
 * reportId/createdAt and the scorer's result as quality, execution humanReview 'SCORED', and
 * provenance naming the exact parent (its id and digest) with the validated review attached. All
 * original bindings, evidence, actual evaluator, artifacts, configuration and sources are retained,
 * and no parent digest is recomputed by hand: reportDigestOf hashes the unsigned draft without its
 * own reportDigest.
 */
function unsignedReviewedReport(checked, reviewed, quality, reportId, createdAt) {
  return {
    ...checked,
    reportId,
    createdAt,
    quality,
    execution: { ...checked.execution, humanReview: 'SCORED' },
    provenance: {
      ...checked.provenance,
      parentReportId: checked.reportId,
      parentReportDigest: checked.reportDigest,
      review: reviewed,
    },
  };
}

/**
 * Prepares a validated reviewed child Report from a Captain-validated parent report, a completed
 * UI worksheet, a fresh reportId and a UTC createdAt timestamp, synchronously and with no IO. The
 * parent and worksheet are validated first, the score comes only from the unchanged scorer, and the
 * measurements are re-projected from the child's own source-backed facts through
 * measurementProjectionInput and projectMeasurements. Same-ID child, invalid IDs, timestamps,
 * quality or parentage are refused by the Captain report contract and the error class propagates.
 */
export function prepareReviewedReport({ parent, worksheet, reportId, createdAt }) {
  const checked = validateReport(parent);
  const reviewed = validateUIWorksheet(worksheet, checked);
  const quality = scoreUIWorksheet(checked, reviewed);
  const unsigned = unsignedReviewedReport(checked, reviewed, quality, reportId, createdAt);
  // The measurements are part of the unsigned draft before hashing: the digest covers the child's
  // own re-projected rows, never the copied parent's, and reportDigestOf excludes any digest field.
  const unsignedComplete = {
    ...unsigned,
    measurements: projectMeasurements(measurementProjectionInput(unsigned)),
  };
  return validateReport({ ...unsignedComplete, reportDigest: reportDigestOf(unsignedComplete) });
}
