// Non-export compatibility views: a pure wrapper over the Captain input classification.
// Every input goes through classifyResultInput, which accepts JSON text or records, validates
// each as its own family and refuses unknown/malformed/forged envelopes. This module adds no
// parsing, trust validation, legacy conversion or score logic, never grants official status,
// eligibility, scores or trust, and never mutates caller data. The returned view keeps the raw
// private source payload intact and is a local read only — it is NOT a safe export surface.
import { classifyResultInput } from './input-contract.mjs';

/** Exact per-family warnings in contract order; frozen so no caller can rewrite the ceiling. */
const WARNINGS = Object.freeze({
  REPORT: Object.freeze(['LOCAL_SELF_ASSESSMENT_NOT_CERTIFIED']),
  C1_RESULT: Object.freeze(['C1_RESULT_NOT_C4_EVIDENCE', 'C1_REVIEW_NOT_CURRENT_WORKSHEET']),
  LEGACY: Object.freeze(['UNBOUND_HISTORICAL', 'HISTORICAL_CLAIMS_NOT_CURRENT_AUTHORITY', 'HISTORICAL_UI_NOT_CURRENT_WORKSHEET']),
});

/**
 * Map one classified input to its fixed, non-promoting compatibility view:
 * `{family, record, assessmentTrust, currentEvidence, currentHumanReview, warnings}`.
 * The record is the classifier's validated output, unchanged; `currentEvidence` reports
 * complete bound bundle availability, never certification; historical numeric scores never
 * become current human review. Invalid JSON and non-object inputs surface as ResultInputError
 * (RESULT_INPUT_INVALID). A recognized legacy envelope is reconstructed via the unchanged
 * readLegacyResult; only a successfully reconstructed source whose canonical envelope differs
 * from the claimed envelope surfaces as ResultInputError. If reconstruction itself refuses the
 * malformed source, that original legacy-reader error propagates. Unknown/unsupported legacy
 * schemas, malformed legacy flags and objects no longer recognized as envelopes are refused by
 * the unchanged legacy reader in its own class. Existing C1/Report/evidence/measurement errors
 * propagate unchanged. No universal error class is promised.
 */
export function readCompatibilityInput(raw) {
  const { family, record } = classifyResultInput(raw);
  switch (family) {
    case 'REPORT':
      return {
        family,
        record,
        assessmentTrust: record.execution.assessmentTrust,
        currentEvidence: record.evidence.bundle !== null,
        currentHumanReview: record.execution.humanReview,
        warnings: WARNINGS.REPORT,
      };
    case 'C1_RESULT':
      return {
        family,
        record,
        assessmentTrust: record.evaluationTrust,
        currentEvidence: false,
        currentHumanReview: 'NOT_REVIEWED',
        warnings: WARNINGS.C1_RESULT,
      };
    case 'LEGACY':
      return {
        family,
        record,
        assessmentTrust: record.trust.evaluationTrust,
        currentEvidence: false,
        currentHumanReview: 'NOT_REVIEWED',
        warnings: WARNINGS.LEGACY,
      };
    default:
      // Unreachable: classifyResultInput's family set is closed.
      throw new Error(`Unhandled classified family: ${String(family)}`);
  }
}
