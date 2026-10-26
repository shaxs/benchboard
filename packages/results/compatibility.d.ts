/** Local, non-export compatibility views of packages/results/compatibility.mjs: one pure wrapper over the Captain input classification. The view never grants official status, eligibility, scores or trust, and it embeds raw private source records, so it is not a safe export. */
import type { ClassifiedInput } from './input-contract.mjs';
import type { EvaluationTrust, HumanReviewStatus } from '../core/manifest.mjs';

/** Per-family record types, unchanged from the classifier's validated output. */
type ReportRecord = Extract<ClassifiedInput, { readonly family: 'REPORT' }>['record'];
type C1ResultRecord = Extract<ClassifiedInput, { readonly family: 'C1_RESULT' }>['record'];
type LegacyRecord = Extract<ClassifiedInput, { readonly family: 'LEGACY' }>['record'];

/** The read-only compatibility view of one classified input; the discriminant is `family`. `currentEvidence` reports complete bound bundle availability, never certification; a Report's intrinsic validation is not authentication; historical flags stay attributed claims inside the record. Warnings are fixed per family, in contract order. */
export type CompatibilityView =
  | { readonly family: 'REPORT'; readonly record: ReportRecord; readonly assessmentTrust: 'LOCAL_SELF_ASSESSMENT'; readonly currentEvidence: boolean; readonly currentHumanReview: HumanReviewStatus; readonly warnings: readonly ['LOCAL_SELF_ASSESSMENT_NOT_CERTIFIED'] }
  | { readonly family: 'C1_RESULT'; readonly record: C1ResultRecord; readonly assessmentTrust: EvaluationTrust; readonly currentEvidence: false; readonly currentHumanReview: 'NOT_REVIEWED'; readonly warnings: readonly ['C1_RESULT_NOT_C4_EVIDENCE', 'C1_REVIEW_NOT_CURRENT_WORKSHEET'] }
  | { readonly family: 'LEGACY'; readonly record: LegacyRecord; readonly assessmentTrust: EvaluationTrust; readonly currentEvidence: false; readonly currentHumanReview: 'NOT_REVIEWED'; readonly warnings: readonly ['UNBOUND_HISTORICAL', 'HISTORICAL_CLAIMS_NOT_CURRENT_AUTHORITY', 'HISTORICAL_UI_NOT_CURRENT_WORKSHEET'] };

/** Classifies `raw` (JSON text or a record) through Captain `classifyResultInput` and maps it to the fixed non-promoting view; no parsing, trust validation or legacy conversion happens here, the caller's data is never mutated and the record is returned unchanged. Invalid JSON and non-object inputs surface as ResultInputError (RESULT_INPUT_INVALID). A recognized legacy envelope is reconstructed via the unchanged readLegacyResult; only a successfully reconstructed source whose canonical envelope differs from the claimed envelope surfaces as ResultInputError. If reconstruction itself refuses the malformed source, that original legacy-reader error propagates in its own class. Existing C1/Report/evidence/measurement errors propagate unchanged. No single universal error class is promised. */
export declare function readCompatibilityInput(raw: unknown): CompatibilityView;
