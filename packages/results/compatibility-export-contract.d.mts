/** Typed public surface of packages/results/compatibility-export-contract.mjs: the closed, prose-free safe wrapper that carries the unchanged S5 projection for a current Report and a deliberately limited, non-promoting declared-state classification for C1 Results and historical records, its validator and its refusal class. The wrapper carries no raw source payload; validation here is structural and intrinsic, never authentication of authorship; this module publishes nothing, writes no file and certifies nothing. */
import type { DigestHex, EvaluationTrust, EvaluatorExecutionStatus, HumanReviewStatus, LifecycleState, RunStatus, ScoreEligibility } from '../core/manifest.mjs';
import type { ExportProjection } from './export-contract.mjs';

/** One of the six fixed warning names; no other warning is representable. */
export type CompatibilityExportWarning =
  | 'LOCAL_SELF_ASSESSMENT_NOT_CERTIFIED'
  | 'C1_RESULT_NOT_C4_EVIDENCE'
  | 'C1_REVIEW_NOT_CURRENT_WORKSHEET'
  | 'UNBOUND_HISTORICAL'
  | 'HISTORICAL_CLAIMS_NOT_CURRENT_AUTHORITY'
  | 'HISTORICAL_UI_NOT_CURRENT_WORKSHEET';

/** The fixed per-family warning list, order included, exactly as the validator pins it: REPORT carries one notice, C1_RESULT two, LEGACY three. The runtime schema bounds the array at three items drawn from the six names; validation additionally requires it to equal the family's list verbatim. */
export type CompatibilityExportWarnings =
  | readonly ['LOCAL_SELF_ASSESSMENT_NOT_CERTIFIED']
  | readonly ['C1_RESULT_NOT_C4_EVIDENCE', 'C1_REVIEW_NOT_CURRENT_WORKSHEET']
  | readonly ['UNBOUND_HISTORICAL', 'HISTORICAL_CLAIMS_NOT_CURRENT_AUTHORITY', 'HISTORICAL_UI_NOT_CURRENT_WORKSHEET'];

/** The classification of the underlying record, reduced to fixed vocabulary names or nulls. Its sources differ by field: the C1 axes (`lifecycle`, `runStatus`, `declaredEvaluatorExecution`, `declaredHumanReview`, `scoreEligibility`) are declarations copied from the record's own slots, while `bindingStatus`, `recognizedLegacyVersion` and `legacyShape` are reader-derived classifications of a legacy envelope and `lifecycle` under LEGACY is the reader's 'DRAFT' ceiling, not necessarily the record's own assertion. Nothing here is a current finding: a SCORED `declaredHumanReview` states what the record itself declared about its past review and is a different statement from the wrapper's `currentHumanReview`, which reports today's review status. Null means the axis is not declared or not derived for that family. `promotionAllowed` is always the literal false — that flag is this layer's policy, not a historical claim — and no record, of any family, is promoted to current authority by being classified. */
export interface CompatibilityClassification {
  /** The literal 'UNBOUND_HISTORICAL' for a LEGACY record; null for every other family. */
  readonly bindingStatus: 'UNBOUND_HISTORICAL' | null;
  /** The recognised legacy schema version, one of the three known names; null outside LEGACY. */
  readonly recognizedLegacyVersion: '1.0' | '1.1' | '1.2' | null;
  /** The recognised legacy shape; null outside LEGACY. */
  readonly legacyShape: 'result' | 'telemetry' | null;
  /** The record's declared lifecycle state; the LEGACY ceiling is always 'DRAFT'. Null for REPORT. */
  readonly lifecycle: LifecycleState | null;
  /** The declared run status from the record's own run slot; null for REPORT. */
  readonly runStatus: RunStatus | null;
  /** The declared evaluator-execution status; declared only by C1 Results, null for REPORT and LEGACY. */
  readonly declaredEvaluatorExecution: EvaluatorExecutionStatus | null;
  /** The declared human-review status as the record states it; declared only by C1 Results, null for REPORT and LEGACY. */
  readonly declaredHumanReview: HumanReviewStatus | null;
  /** The declared score eligibility as the record states it; declared only by C1 Results, null for REPORT and LEGACY. */
  readonly scoreEligibility: ScoreEligibility | null;
  /** Always the literal false for every family. */
  readonly promotionAllowed: false;
}

/** The closed, privacy-reviewed safe compatibility export; the nested report is the unchanged S5 projection for a REPORT and null for every older family. The wrapper's own metadata fields are bounded enum names, hex digests, fixed literals or nulls, and the older families' metadata is deliberately limited to those names; a REPORT additionally nests the unchanged S5 projection, whose approved numeric scores and measurements and canonical UTC timestamps are retained exactly as that projection defines them, arrays and objects included. Either way the form is closed: there is no free-text field, no raw record and no open index signature; anything outside these slots is not representable. Historical numeric outcomes stay outside the wrapper while a current Report's numerical quality stays inside its S5 projection. `sourceDigest` is a NEW SHA-256 computed over the canonical local reader output — the untouched sourceRecord for a LEGACY record, the validated record for a Report or C1 Result (a C1 record's defaults may normalize it) — and is not any existing reportDigest nor a digest of the original JSON bytes. `sourceRef` is a NEW domain-separated opaque hash of the family plus that digest. Both values enable correlation and dictionary inference; neither provides anonymity. Structural validity is intrinsic, never authentication, and a valid export makes no publication, certification or comparison claim. */
export interface CompatibilityExport {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'SafeCompatibilityExport';
  /** The discriminating family; the cross-field rules below are enforced per family. */
  readonly family: 'REPORT' | 'C1_RESULT' | 'LEGACY';
  /** A NEW SHA-256 over the canonical local reader output, as described above; never a transported source digest. */
  readonly sourceDigest: DigestHex;
  /** A NEW domain-separated opaque hash of family plus sourceDigest. */
  readonly sourceRef: DigestHex;
  /** The reader's assessment-trust ceiling for the family; 'UNTRUSTED_LEGACY' under the LEGACY ceiling. */
  readonly assessmentTrust: EvaluationTrust;
  /** Whether a complete bound evidence bundle is available; true only for a REPORT, never for the older families. Availability, not certification. */
  readonly currentEvidence: boolean;
  /** Today's review status: the Report's own review state, and always 'NOT_REVIEWED' for the older families. Independent of classification.declaredHumanReview. */
  readonly currentHumanReview: HumanReviewStatus;
  /** Always the literal false for every family: no safe export asserts a formal comparison. */
  readonly formalComparisonAvailable: false;
  /** The fixed per-family warning list, order included. */
  readonly warnings: CompatibilityExportWarnings;
  /** The declared-state classification; fully null (apart from the literal-false flag) for a REPORT. */
  readonly classification: CompatibilityClassification;
  /** The unchanged S5 projection for a REPORT; null for C1_RESULT and LEGACY — null, never a zero or an empty stand-in. */
  readonly report: ExportProjection | null;
}

/** Raised for this wrapper layer's own refusals (code COMPATIBILITY_EXPORT_INTEGRITY): a value outside the closed wrapper shape, an extra property, a text value outside the fixed enum/digest slots, a warnings list that is not the family's fixed list, or cross-field disagreement between the wrapper and its nested projection. It never carries the refused value or any private content. */
export declare class CompatibilityExportError extends Error {
  readonly code: 'COMPATIBILITY_EXPORT_INTEGRITY';
  constructor();
}

/** Validates a value that already claims to be a safe compatibility wrapper: the closed shape, the fixed vocabularies, the family's pinned warnings list, the per-family cross-field rules (a REPORT carries a non-null projection with a fully-null classification and agrees with it on trust, evidence availability and review status; the older families carry a null report, false currentEvidence and a NOT_REVIEWED current review, with the LEGACY trust ceiling, binding marker, recognized version and DRAFT lifecycle and the C1 declared-state requirements) and nothing more — never a raw source record. Returns a defensive copy. The wrapper's own refusals raise CompatibilityExportError; because a REPORT's nested projection is re-validated through the S5 layer here, that nested S5 validation may propagate ExportIntegrityError, which keeps its own class rather than being relabelled — there is no universal wrapper error class. This checks structure and internal agreement only; it is not authentication of authorship and not a publication check. */
export declare function validateCompatibilityExport(value: unknown): CompatibilityExport;
/** Reads the raw value through the local compatibility reader and wraps the classified record in the deliberately limited safe form: the unchanged S5 projection for a REPORT, a fully null classification, and for C1 Results and historical records a null report with only the fixed declared-state classification, so raw numeric outcomes, preserved outcomes and official or eligibility claims stay verbatim in the local read view and are omitted here. Performs no filesystem or network IO, verifies no artifact, marker or authorship, and makes no publication or certification claim. The wrapper's own refusals are CompatibilityExportError; the nested S5 validation may propagate ExportIntegrityError; input, C1, Report, evidence-bundle and measurement errors propagate in their own existing classes unchanged and without an exhaustive list. No single universal error class is promised. */
export declare function createCompatibilityExport(raw: unknown): CompatibilityExport;
