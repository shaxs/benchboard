/** Typed public surface of packages/results/ui-worksheet.mjs: the three pure S3 entry points over the Captain UI contract, the C4 evidence projection and the unchanged evaluator scorer. Metadata validation only: no evidence file access, no reviewer authentication, no publication. */
import type { Report } from './report-contract.mjs';
import type { UIWorksheet, UICategory, UIEvidence, UIImprovement } from './ui-contract.mjs';

export type { UIWorksheet, UICategory, UIEvidence, UIImprovement } from './ui-contract.mjs';

/** The pending template returned by createUIWorksheetTemplate: plain mutable JSON with blank strings and false baselineCompared, the report's exact bindings and baseline, and a deliberately uncompletable Record<UICategory, null> score row (null is the absent value, never a reviewed zero). Intentionally invalid until a reviewer completes every field. */
export interface UIWorksheetTemplate {
  schemaVersion: string;
  kind: 'UIWorksheet';
  reviewId: string;
  reviewer: string;
  reviewedAt: string;
  baselineCompared: false;
  bindings: UIWorksheet['bindings'];
  baseline: UIWorksheet['baseline'];
  evidence: UIEvidence[];
  scores: Record<UICategory, null>;
  notes: Record<UICategory, string>;
  improvements: Partial<Record<UICategory, UIImprovement>>;
}

/** The unchanged evaluator scorer's result shape when a completed UI review is supplied (evaluator/score.mjs with ui non-null): numeric humanUI and quality with status 'SCORED'. */
export interface UIScoredQuality {
  readonly automated: number;
  readonly automatedMaximum: 80;
  readonly areas: Readonly<Record<string, number>>;
  readonly humanUI: number;
  readonly humanMaximum: 20;
  readonly quality: number;
  readonly qualityMaximum: 100;
  readonly status: 'SCORED';
}

/** Builds a plain mutable pending JSON template from a successful bound report: the exact Captain-contract bindings and baseline, blank identity and time, baselineCompared false, empty evidence, a null score and empty note per uiCaps category and no improvements. The blank template is intentionally invalid, never a reviewed zero. A report that fails its own validation propagates the upstream report-layer, C4 bundle, measurement (MEASUREMENT_INTEGRITY) and C1 checks in their own classes; this is not an exhaustive list. An intrinsically valid but non-success report is not an upstream error: the contract raises UIWorksheetError (UI_WORKSHEET_INVALID) with 'UI review requires a successful bound automated report'. Performs no IO. */
export declare function createUIWorksheetTemplate(report: Report): UIWorksheetTemplate;
/** Parses UI worksheet JSON text and returns the Captain contract's validated defensive copy. Performs no IO. Non-string input and malformed JSON are wrapped as UIWorksheetError (UI_WORKSHEET_INVALID); a semantically invalid worksheet raises that class from the contract. The report argument behaves as in createUIWorksheetTemplate: report-layer, C4 bundle, measurement and C1 validation failures propagate in their own classes (not an exhaustive list), while a valid non-success report is refused as UIWorksheetError. */
export declare function readUIWorksheet(text: string, report: Report): UIWorksheet;
/** Validates the worksheet through the Captain contract and returns the unchanged evaluator scorer's result over the report's bound evidence bundle plus a closed UI projection (evidence serialized as JSON text, improvements as description strings): numeric humanUI and quality with status 'SCORED'. No custom sum or formula, and neither input is modified. Worksheet refusals and a valid non-success report are UIWorksheetError (UI_WORKSHEET_INVALID); a report failing its own report-layer, C4 bundle, measurement or C1 checks propagates those classes unchanged, without an exhaustive list. */
export declare function scoreUIWorksheet(report: Report, worksheet: UIWorksheet): UIScoredQuality;
