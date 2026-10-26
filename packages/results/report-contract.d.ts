/** Typed trust boundary of packages/results/report-contract.mjs: the closed Report schema surface and its schema/digest/binding checks. Hashes bind local statements, not certification. */
import type { DigestHex, ResultBindings, Measurement } from '../core/manifest.mjs';
import type { ReportMeasurementSource } from './measurement-contract.mjs';
import type { UIWorksheet } from './ui-contract.mjs';
import type { UIScoredQuality } from './ui-worksheet.mjs';
import type { EvidenceBundle, ManifestEntry } from '../evaluation/bundle.mjs';

/** The evaluator identity facts a report records from its evidence bundle. */
export interface ActualEvaluator {
  readonly semanticDigest: DigestHex;
  readonly packageDigest: DigestHex;
  readonly evaluatorVersion: string;
  readonly scoringVersion: string;
  readonly originalCandidate: { readonly evaluator: DigestHex; readonly scoring: DigestHex };
}

/** Run/submission/identity bindings a report shares with the verified run, extended with the selected snapshot. */
export type ReportBindings = ResultBindings & { readonly snapshotId: string };

/** Declared configuration from verified lifecycle or the unstarted manifest, never inferred from evaluation success. */
export interface ReportConfiguration {
  readonly harness: string | null;
  readonly model: string | null;
  readonly workerCount: number | null;
  readonly executionMode: 'MANUAL';
  readonly declaredCeilingMinutes: number | null;
}

/** Independently honest status axes; a successful evaluation establishes evaluator execution, never agent completion. */
export interface ReportExecution {
  readonly agentOutcome: null;
  readonly evaluatorExecution: 'SUCCESS' | 'INFRASTRUCTURE_ERROR';
  readonly humanReview: 'NOT_REVIEWED' | 'SCORED';
  readonly assessmentTrust: 'LOCAL_SELF_ASSESSMENT';
  readonly enforcement: 'manual';
  readonly enforced: false;
}

/** Evidence reference; bundle and bundleDigest are null together for an infrastructure report, while evaluationId may still name the evaluation whose infrastructure outcome is recorded. */
export interface ReportEvidence {
  readonly evaluationId: string | null;
  readonly bundleDigest: DigestHex | null;
  readonly bundle: EvidenceBundle | null;
}

/** Private operational measurement sources; parentage/review remain unavailable until attachment. */
export interface ReportProvenance {
  readonly parentReportId: string | null;
  readonly parentReportDigest: DigestHex | null;
  readonly review: UIWorksheet | null;
  readonly sources: readonly ReportMeasurementSource[];
}

/** The closed local self-assessment Report: every one of the schema's fourteen required fields is present; additional properties are refused by validation. A value that is absent from a report is the literal null, never an omitted key. */
export interface Report {
  readonly schemaVersion: string;
  readonly kind: 'Report';
  readonly reportId: string;
  readonly createdAt: string;
  readonly reportDigest: DigestHex;
  readonly bindings: ReportBindings;
  readonly actualEvaluator: ActualEvaluator | null;
  readonly configuration: ReportConfiguration;
  readonly execution: ReportExecution;
  readonly quality: EvidenceBundle['score'] | UIScoredQuality | null;
  readonly evidence: ReportEvidence;
  readonly measurements: readonly Measurement[];
  readonly provenance: ReportProvenance;
  readonly artifacts: readonly ManifestEntry[];
}

/** Raised for this report layer's own refusals (code REPORT_INTEGRITY): report schema shape, canonical UTC timestamp, report self-digest, cross-binding agreement, report score and evidence-reference checks, and non-string or malformed-JSON input wrapped at readReport. A refused request never returns a report; validateReport may additionally propagate EvaluationIntegrityError (EVIDENCE_INTEGRITY) from evidence-bundle validation unchanged. */
export declare class ReportIntegrityError extends Error {
  readonly code: 'REPORT_INTEGRITY';
  constructor(message: string);
}
/** Refuses the input by throwing ReportIntegrityError; never returns. */
export declare function refuseReport(message: string): never;
/** sha256 over the canonical JSON encoding of the value. */
export declare function digestOf(value: unknown): DigestHex;
/** The reportDigest over the report without its own reportDigest field. Accepts a complete report or a draft that omits reportDigest (or carries it optionally), so declared consumers can hash the unsigned draft before sealing it. */
export declare function reportDigestOf(report: Omit<Report, 'reportDigest'> & { readonly reportDigest?: DigestHex }): DigestHex;
/** Projects the report-facing evaluator identity from a bundle; the null bundle yields a null (absent) actual evaluator. */
export declare function actualEvaluatorOf(bundle: EvidenceBundle | null): ActualEvaluator | null;
/** Refuses when a bundle's identity block differs from the verified run/submission bindings. */
export declare function assertBundleBindings(bundle: EvidenceBundle, bindings: ReportBindings): void;
/** Validates the closed Report schema and timestamp/digest/evidence/score/identity/artifact/measurement agreement, returning a defensive JSON copy. Report checks use REPORT_INTEGRITY; bundle semantics propagates EVIDENCE_INTEGRITY, source/measurement disagreement uses MEASUREMENT_INTEGRITY, and upstream C1 validation errors retain their class. Self-consistency is not authentication. */
export declare function validateReport(value: unknown): Report;
