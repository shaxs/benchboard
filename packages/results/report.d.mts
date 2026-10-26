/** Typed public surface of packages/results/report.mjs: the two pure entry points plus the Report type family re-exported from the trust boundary and the request contract re-exported from the context boundary. */
import type { Report } from './report-contract.mjs';
import type { ReportRequest } from './report-context.mjs';

export type {
  ActualEvaluator,
  Report,
  ReportBindings,
  ReportConfiguration,
  ReportEvidence,
  ReportExecution,
  ReportProvenance,
} from './report-contract.mjs';
export type { ReportRequest } from './report-context.mjs';

/** Projects verified C3/C4 context, configuration and measurements into a defensive Report. Report-layer refusals use REPORT_INTEGRITY; semantically invalid bundles propagate EVIDENCE_INTEGRITY, and measurement/provenance failures use MEASUREMENT_INTEGRITY. Upstream C1/C3/storage/staging and raw filesystem errors propagate, including LifecycleError NOT_FOUND/PROVENANCE_MISMATCH and staging UNSAFE_PATH; this is not an exhaustive list. Refusals never return reports; raw evaluation diagnostics are not carried. */
export declare function createReport(request: ReportRequest): Promise<Report>;
/** Parses Report JSON text and returns a defensive copy; no file IO. Non-string/bad JSON uses REPORT_INTEGRITY, invalid bundle semantics propagates EVIDENCE_INTEGRITY, source/measurement checks may raise MEASUREMENT_INTEGRITY or C1 errors, and child review failures can propagate UI_WORKSHEET_INVALID. This is not an exhaustive error list; intrinsic agreement is not authentication. */
export declare function readReport(text: string): Report;
