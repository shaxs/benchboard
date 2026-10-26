/** Typed public surface of packages/results/export-contract.mjs: the closed, prose-free privacy projection of a validated private Report, its structural validator and its refusal class. Validation here is structural and intrinsic, never authentication; this module publishes nothing, writes no file and certifies nothing. */
import type { DigestHex } from '../core/manifest.mjs';

/** The fixed seven notices carried verbatim by every projection; the projection's `notices` field must equal the frozen list below, in order. */
export type ExportNotice = 'LOCAL_SELF_ASSESSMENT' | 'NOT_CERTIFIED' | 'MANUAL_UNENFORCED' | 'LABELS_PSEUDONYMIZED' | 'PSEUDONYMS_NOT_ANONYMOUS' | 'PRIVATE_PAYLOADS_OMITTED' | 'NOT_PUBLICATION_PROOF';

/** The exact fixed notice list (order included) that the closed schema pins as a const value. */
export type ExportNotices = readonly ['LOCAL_SELF_ASSESSMENT', 'NOT_CERTIFIED', 'MANUAL_UNENFORCED', 'LABELS_PSEUDONYMIZED', 'PSEUDONYMS_NOT_ANONYMOUS', 'PRIVATE_PAYLOADS_OMITTED', 'NOT_PUBLICATION_PROOF'];

/** One of the thirteen fixed export metric names; no other metric name is representable. */
export type ExportMetric = 'elapsedWallMs' | 'elapsedWallSeconds' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'totalTokens' | 'automatedQuality' | 'humanUIQuality' | 'finalQuality' | 'automatedPointsPerThousandTokens' | 'finalPointsPerThousandTokens' | 'qualityPointsPerWallSecond' | 'utilization';

/** One of the five fixed measurement units. */
export type ExportUnit = 'ms' | 's' | 'tokens' | 'points' | 'ratio';

/** How a measurement value was obtained; UNAVAILABLE is the absent value, never a zero. */
export type ExportMeasurementKind = 'MEASURED' | 'ENTERED' | 'DERIVED' | 'UNAVAILABLE';

/** Fixed origin vocabulary for a measurement source; null means the row carries no source. */
export type ExportMeasurementSourceKind = 'COMPUTED' | 'SELF_ASSESSMENT';

/** Fixed procedure code naming the fixed attestation procedure behind a measurement; null when the value is absent. */
export type ExportProcedureCode = 'MEASURED_V1' | 'ENTERED_V1' | 'DERIVED_V1';

/** Fixed formula code naming the fixed derivation behind a measurement; null when no derivation applies. Arbitrary formula text is not representable. */
export type ExportFormulaCode = 'MS_TO_SECONDS' | 'INPUT_PLUS_OUTPUT' | 'AUTOMATED_PLUS_UI' | 'AUTOMATED_PER_1000_TOKENS' | 'FINAL_PER_1000_TOKENS' | 'FINAL_PER_SECOND';

/** Fixed reference kinds for an operational source record; only the kind and the record digest are carried, never the record itself. */
export type ExportSourceRecordKind = 'lifecycle' | 'snapshot-proof' | 'evaluation' | 'token-input';

/** Canonical UTC instant in exactly the form `YYYY-MM-DDTHH:MM:SS.mmmZ`; the closed schema refuses any other text. */
export type ExportTimestamp = string;

/** A version reduced to a bounded numeric core plus a computed full-label digest. `core` is the bounded `major.minor.patch` core when the source label carries one and null when it does not. `fullDigest` is a NEW domain-separated opaque digest computed over the complete version label at projection time, not an existing source digest transported unchanged. `suffixWithheld` is true whenever the complete label is not exactly the bare bounded core — either a prerelease/build suffix is being withheld, or the label is outside the bounded numeric shape so `core` is null — and false only when the label is exactly the bare core. */
export interface ExportVersion {
  readonly core: string | null;
  readonly fullDigest: DigestHex;
  readonly suffixWithheld: boolean;
}

/** Identity of the projected report: pseudonymized references for report, run, manifest, submission, snapshot, evaluation and (for a reviewed report) parent report, plus the unchanged parent-report and evaluation-bundle digests. The parent reference and parent digest are null when human review is NOT_REVIEWED and present when it is SCORED. For a successful evaluation both evaluationRef and bundleDigest are known; for an infrastructure report bundleDigest is null while evaluationRef may still be known, because the evaluation id can name the recorded infrastructure outcome. No raw identifier string is carried. */
export interface ExportIdentity {
  readonly reportRef: DigestHex;
  readonly reportDigest: DigestHex;
  readonly runRef: DigestHex;
  readonly manifestRef: DigestHex;
  readonly submissionRef: DigestHex;
  readonly snapshotRef: DigestHex;
  readonly parentReportRef: DigestHex | null;
  readonly parentReportDigest: DigestHex | null;
  readonly evaluationRef: DigestHex | null;
  readonly bundleDigest: DigestHex | null;
}

/** Challenge/evaluator/tooling references pseudonymized, identity and workload digests unchanged; raw environment names, flags, endpoints and paths are not representable. */
export interface ExportBindings {
  readonly challengeRef: DigestHex;
  readonly evaluatorRef: DigestHex;
  readonly toolingRef: DigestHex;
  readonly challengeIdentityDigest: DigestHex;
  readonly evaluatorIdentityDigest: DigestHex;
  readonly toolingIdentityDigest: DigestHex;
  readonly workloadDigest: DigestHex;
  readonly manifestDigest: DigestHex;
  readonly treeDigest: DigestHex;
}

/** The seven version slots of the projection, each the version core/digest form, null when the slot has no source version. */
export interface ExportVersions {
  readonly report: ExportVersion | null;
  readonly challenge: ExportVersion | null;
  readonly candidate: ExportVersion | null;
  readonly evaluatorBinding: ExportVersion | null;
  readonly tooling: ExportVersion | null;
  readonly actualEvaluator: ExportVersion | null;
  readonly scoring: ExportVersion | null;
}

/** The evaluator actually run, as four unchanged digests; null when the report records no actual evaluator (an infrastructure report). */
export interface ExportActualEvaluator {
  readonly semanticDigest: DigestHex;
  readonly packageDigest: DigestHex;
  readonly originalEvaluatorDigest: DigestHex;
  readonly originalScoringDigest: DigestHex;
}

/** Declared run configuration with the harness and model reduced to pseudonymized references; the execution mode is always the literal 'MANUAL'. */
export interface ExportConfiguration {
  readonly harnessRef: DigestHex | null;
  readonly modelRef: DigestHex | null;
  /** Whole workers, at least 1; null when unconfigured. */
  readonly workerCount: number | null;
  /** Declared ceiling in minutes, between 1 and 1440; null when undeclared. */
  readonly declaredCeilingMinutes: number | null;
  readonly executionMode: 'MANUAL';
}

/** The four independent status axes of the projected report — outcome, evaluator execution, human review and assessment trust — plus the fixed manual-enforcement facts. `agentOutcome` is always the literal null: a manual, unenforced run establishes no agent completion, so the outcome is withheld rather than inferred. `humanReview` is the enum 'NOT_REVIEWED' or 'SCORED'; it is never null. */
export interface ExportExecution {
  readonly agentOutcome: null;
  readonly evaluatorExecution: 'SUCCESS' | 'INFRASTRUCTURE_ERROR';
  readonly humanReview: 'NOT_REVIEWED' | 'SCORED';
  readonly assessmentTrust: 'LOCAL_SELF_ASSESSMENT';
  readonly enforcement: 'manual';
  readonly enforced: false;
}

/** The eight fixed automated score areas, each a number between 0 and its category maximum: visible 7, functional 30, persistence 10, edge 5, integration 15, code 5, usefulTests 5, hygiene 3. No other area is representable. */
export interface ExportQualityAreas {
  readonly visible: number;
  readonly functional: number;
  readonly persistence: number;
  readonly edge: number;
  readonly integration: number;
  readonly code: number;
  readonly usefulTests: number;
  readonly hygiene: number;
}

/** The seven fixed human UI score categories, each an integer (a JS number at runtime) between 0 and its category maximum: polish 5, hierarchy 3, board 3, drawer 3, feedback 2, responsive 2, consistency 2. No free-text notes are carried. */
export interface ExportUIScores {
  readonly polish: number;
  readonly hierarchy: number;
  readonly board: number;
  readonly drawer: number;
  readonly feedback: number;
  readonly responsive: number;
  readonly consistency: number;
}

/** The full score block: automated points out of 80 with the eight fixed areas above, human UI points out of 20 (null while review is pending), and the combined quality out of 100 (null while review is pending). The maxima are the literal constants. */
export interface ExportQuality {
  readonly automated: number;
  readonly automatedMaximum: 80;
  readonly areas: ExportQualityAreas;
  readonly humanUI: number | null;
  readonly humanMaximum: 20;
  readonly quality: number | null;
  readonly qualityMaximum: 100;
  readonly status: 'HUMAN_REVIEW_PENDING' | 'SCORED';
}

/** Operator-attested run timing; the fields are independently optional. Each endpoint may be missing on its own. `provenance` is OPERATOR_ATTESTED only when both observed endpoints are present, and UNAVAILABLE otherwise; it attests observed endpoints, never an enforced or trusted elapsed duration. `elapsedMs` is null whenever a usable elapsed interval is not derivable from the record — including when the endpoints exist but the clock is reversed or erroneous — so a present pair of endpoints does not itself guarantee a non-null `elapsedMs`. `clockError` records only whether the source attested a clock error. No group of fields is required to go null together. */
export interface ExportTiming {
  readonly startedAt: ExportTimestamp | null;
  readonly stoppedAt: ExportTimestamp | null;
  readonly elapsedMs: number | null;
  readonly provenance: 'OPERATOR_ATTESTED' | 'UNAVAILABLE';
  readonly clockError: boolean;
}

/** One bounded measurement row: value plus kind, with fixed code names for origin, procedure and formula. A UNAVAILABLE row carries a null value and null source, procedure and formula codes; arbitrary procedure, formula or note text is not representable. Values are non-negative numbers. */
export interface ExportMeasurement {
  readonly metric: ExportMetric;
  readonly unit: ExportUnit;
  readonly measurementKind: ExportMeasurementKind;
  readonly value: number | null;
  readonly sourceKind: ExportMeasurementSourceKind | null;
  readonly procedureCode: ExportProcedureCode | null;
  readonly formulaCode: ExportFormulaCode | null;
}

/** A reference to an operational source record: only its fixed kind and unchanged digest, never the record contents. */
export interface ExportSourceRef {
  readonly kind: ExportSourceRecordKind;
  readonly digest: DigestHex;
}

/** A pseudonymized artifact reference with its unchanged size and content digest; raw artifact paths and payloads are not carried. */
export interface ExportArtifactRef {
  readonly artifactRef: DigestHex;
  /** Byte count, at least 0. */
  readonly bytes: number;
  readonly sha256: DigestHex;
}

/** Completed human UI review: the reviewer reduced to a pseudonymized reference, the unchanged review instant, the seven fixed integer category scores and the bounded artifact references. Review prose and screenshots are not carried. */
export interface ExportReview {
  readonly reviewerRef: DigestHex;
  readonly reviewedAt: ExportTimestamp;
  readonly scores: ExportUIScores;
  readonly artifacts: readonly ExportArtifactRef[];
}

/** The closed, privacy-reviewed export projection of one current Report: every field is a bounded enum name, a hex digest, a pseudonymized reference, a bounded numeric value, a fixed-instant timestamp or a null for an absent value. There is no free-text field and no open index signature; anything outside these slots is not representable. Structural validity is an intrinsic property, never authentication of authorship, and a valid projection makes no publication or certification claim. */
export interface ExportProjection {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'SafeResultExport';
  /** The projection family; only a projected current Report exists today. */
  readonly family: 'REPORT';
  /** The exact fixed notice list, order included. */
  readonly notices: ExportNotices;
  readonly identity: ExportIdentity;
  readonly bindings: ExportBindings;
  readonly versions: ExportVersions;
  readonly actualEvaluator: ExportActualEvaluator | null;
  readonly configuration: ExportConfiguration;
  readonly execution: ExportExecution;
  /** The full score block; null for an infrastructure report that produced no quality. */
  readonly quality: ExportQuality | null;
  readonly timing: ExportTiming;
  /** At most 13 rows, one per metric name with no duplicates. */
  readonly measurements: readonly ExportMeasurement[];
  /** At most 4 operational source references (kind plus digest only). */
  readonly sources: readonly ExportSourceRef[];
  /** The completed human review, null until review is SCORED. */
  readonly review: ExportReview | null;
  /** Evaluation artifacts as pseudonymized references (bounded list). */
  readonly artifacts: readonly ExportArtifactRef[];
}

/** Raised for this export layer's own refusals (code EXPORT_INTEGRITY): a value outside the closed projection shape, an extra property, text outside the fixed enum/digest/timestamp slots, or cross-field disagreement inside the projection. It never carries the refused value or any private content. */
export declare class ExportIntegrityError extends Error {
  readonly code: 'EXPORT_INTEGRITY';
  constructor();
}

/** Validates the value against the closed projection shape and its cross-field agreement rules, returning a defensive copy; refusal raises ExportIntegrityError. This checks structure and internal agreement only — it is not authentication of authorship and not a publication check. */
export declare function validateExportProjection(value: unknown): ExportProjection;
/** Validates the input as a private Report and projects it into the closed export form, returning a defensive copy. The Report checks may propagate their own upstream error classes (report, evidence-bundle, measurement and earlier-layer errors) unchanged and without an exhaustive list; this function performs no filesystem or network IO, re-reads no external evidence or publication marker, and makes no publication or certification claim. */
export declare function createExportProjection(raw: unknown): ExportProjection;
