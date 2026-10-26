/** Typed public surface of packages/results/reviewed-report.mjs: the single pure S4 entry point that prepares a reviewed child Report from a validated parent, a completed UI worksheet and a fresh identity. No IO, no storage write, no publication; every check delegates to the Captain report and UI contracts and the unchanged evaluator scorer. */
import type { Report } from './report-contract.mjs';
import type { UIWorksheet } from './ui-contract.mjs';

/** Arguments of prepareReviewedReport: the Captain-validated parent Report, the completed UIWorksheet bound to it, and the child's own distinct reportId and canonical UTC createdAt timestamp. */
export interface ReviewedReportInput {
  readonly parent: Report;
  readonly worksheet: UIWorksheet;
  readonly reportId: string;
  readonly createdAt: string;
}

/**
 * Prepares, synchronously and with no IO or mutation of either input, the validated reviewed child
 * Report: the parent's fields with the supplied reportId and createdAt, quality replaced by the
 * unchanged evaluator scorer's result over the parent's bound evidence plus the validated review,
 * execution humanReview 'SCORED', and provenance naming the exact parent (its reportId and
 * reportDigest) with the validated worksheet attached; all original bindings, evidence, actual
 * evaluator, artifacts, configuration and measurement sources are retained. The measurements are
 * re-projected from the child's own source-backed facts (its new idPrefix and the source/bundle
 * invariants included) and the reportDigest is reportDigestOf over the unsigned draft, so no
 * copied parent digest enters the hash. The complete record passes validateReport once more and
 * its defensive copy is returned. Same-ID child, invalid IDs, timestamps, quality or parentage are
 * refused by the report contract (REPORT_INTEGRITY); worksheet refusals are UIWorksheetError; a
 * parent or evidence failing its own report-layer, C4 bundle, measurement or C1 checks propagates
 * those classes unchanged, without an exhaustive list.
 */
export declare function prepareReviewedReport(input: ReviewedReportInput): Report;
