/** Typed boundary of packages/results/report-context.mjs: the explicit report request and the verified C3/C4 context the pure projection receives. */
import type { RunManifest } from '../core/manifest.mjs';
import type { EvidenceBundle } from '../evaluation/bundle.mjs';
import type { EvaluationFailure, EvaluationSuccess, FrozenSelection } from '../evaluation/evaluate-frozen.mjs';
import type { ReportBindings } from './report-contract.mjs';
import type { NeutralTokenInput } from './measurement-contract.mjs';
import type { MeasurementContext } from './measurement-context.mjs';

/** Explicit report request, with optional bounded cache-inclusive run-total tokens. A returned C4 evaluation, never a refusal or undocumented option. */
export interface ReportRequest {
  readonly reportId: string;
  readonly createdAt: string;
  readonly selection: FrozenSelection;
  readonly evaluation: EvaluationSuccess | EvaluationFailure;
  readonly metrics?: NeutralTokenInput | null;
}

/** The context returned only after real C3 verification and every identity check: the opened run's manifest, the closed run/submission bindings including the selected snapshot, the validated bundle (null for an infrastructure outcome), the evaluation's identity and its discriminating status. */
export interface ReportContext {
  readonly reportId: string;
  readonly createdAt: string;
  readonly manifest: RunManifest;
  readonly bindings: ReportBindings;
  readonly bundle: EvidenceBundle | null;
  readonly evaluationId: string | null;
  readonly status: 'success' | 'infrastructure-error';
  readonly measurementContext: MeasurementContext;
}

/** Verifies the frozen bytes and every binding of the request against the real run, then returns the context for the pure projection. This contract's own refusals (tampering, active run, mismatch, arbitrary input) throw ReportIntegrityError (REPORT_INTEGRITY); verification errors from upstream C3, staging or bundle checks propagate unchanged with their own error classes. No refused request returns a report. The caller's input is captured before awaiting, so a mid-await rebind cannot occur. */
export declare function resolveReportContext(request: ReportRequest): Promise<ReportContext>;
