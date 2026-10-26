// Public S3 UI worksheet helpers: a bound pending template, a JSON-text reader and the
// projection into the unchanged scorer. Metadata only: no filesystem or network access, no
// evidence opening, no reviewer authentication, no publication. All validation is the Captain
// contract's; upstream report/C4 errors propagate, worksheet refusals are UIWorksheetError.
import { score, uiCaps } from '../../evaluator/score.mjs';
import { scorerEvidenceOf } from '../evaluation/bundle.mjs';
import { UIWorksheetError, worksheetBindingsOf, validateUIWorksheet } from './ui-contract.mjs';

const fail = message => { throw new UIWorksheetError(message); };

/**
 * Builds a plain mutable pending JSON template from a successful bound report: the exact
 * bindings and baseline the Captain contract returns, blank review identity, baselineCompared
 * false, empty evidence, a null score and empty note for every uiCaps category and no
 * improvements. The blank template is intentionally invalid — it is never a reviewed zero — and
 * validateUIWorksheet refuses it until a reviewer completes it. Non-bound reports propagate the
 * contract's own refusals.
 */
export function createUIWorksheetTemplate(report) {
  const { bindings, baseline } = worksheetBindingsOf(report);
  const scores = {}, notes = {};
  for (const key of Object.keys(uiCaps)) { scores[key] = null; notes[key] = ''; }
  return {
    schemaVersion: '1.0.0',
    kind: 'UIWorksheet',
    reviewId: '',
    reviewer: '',
    reviewedAt: '',
    baselineCompared: false,
    bindings,
    baseline,
    evidence: [],
    scores,
    notes,
    improvements: {},
  };
}

/**
 * Parses UI worksheet JSON text and returns the Captain contract's validated defensive copy.
 * Performs no IO. Non-string input and malformed JSON are wrapped as UIWorksheetError; a
 * semantically invalid worksheet raises the contract's own UIWorksheetError and an invalid
 * parent report propagates its report/C4 error class unchanged.
 */
export function readUIWorksheet(text, report) {
  if (typeof text !== 'string') fail('UI worksheet JSON text required');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('Invalid UI worksheet JSON text');
  }
  return validateUIWorksheet(value, report);
}

/**
 * Validates the worksheet through the Captain contract, then returns the unchanged evaluator
 * scorer's result for the report's bound evidence bundle plus a closed projection of the
 * validated UI review: reviewer, reviewedAt, the contract-enforced baselineCompared true, the
 * evidence serialized as JSON text, the category scores and each improvement's description
 * string. No custom sum or formula, and neither the report nor the worksheet is modified.
 */
export function scoreUIWorksheet(report, worksheet) {
  const reviewed = validateUIWorksheet(worksheet, report);
  const improvements = {};
  for (const [key, improvement] of Object.entries(reviewed.improvements)) improvements[key] = improvement.description;
  return score(scorerEvidenceOf(report.evidence.bundle), {
    reviewer: reviewed.reviewer,
    reviewedAt: reviewed.reviewedAt,
    baselineCompared: true,
    evidence: JSON.stringify(reviewed.evidence),
    scores: reviewed.scores,
    improvements,
  });
}
