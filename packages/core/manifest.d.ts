/**
 * Type declarations for `packages/core/manifest.mjs` (C1 / T2).
 *
 * These declarations describe the public runtime surface exactly as
 * implemented. They are checked with the repository's pinned TypeScript
 * compiler in the focused contract test (no install, no project-wide
 * typecheck, no emitted output).
 *
 * Domain notes that bind the types to the runtime documentation:
 *   - `schemaVersion` is a `<major>.<minor>.<patch>` discriminator; only
 *     major 1 is read and unknown/malformed majors are rejected, never
 *     coerced, consistently by the runtime and the companion JSON Schemas.
 *   - tooling, challenge, evaluator, run, submission and result identities
 *     are distinct objects with distinct ID and version fields, each version
 *     naming its own release train; separately bound identities whose version
 *     strings happen to be equal stay valid, while ID collisions, re-bound
 *     digests and corrupt self digests are refused.
 *   - digests are the preserved algorithm: sha256 over the canonical JSON of
 *     the sorted `[path, fileDigest]` pairs. `identityDigest`/`manifestDigest`
 *     fields are computed over the record's canonical bytes minus the
 *     self-digest fields themselves.
 *   - measurement provenance distinguishes measured/entered/derived from
 *     unavailable, and `null` (unknown) is never replaced by `0`.
 *   - assessment trust carries no certification state: this release
 *     implements no review grant or certification mechanism, so
 *     `LOCAL_SELF_ASSESSMENT` is the ceiling and no field may upgrade it.
 */

/** Immutable array alias used by the declarations below. */
export type ReadonlyList<T> = readonly T[];

/* -------------------------------------------------------------------------- */
/* Enumerated vocabularies                                                    */
/* -------------------------------------------------------------------------- */

/** Every neutral contract family, each with its own schema and identity domain. */
export type ContractKind =
  | 'ToolingIdentity'
  | 'ChallengeIdentity'
  | 'EvaluatorIdentity'
  | 'RunManifest'
  | 'FrozenSubmission'
  | 'Measurement'
  | 'Result';

/** `<major>.<minor>.<patch>` schema discriminator (schema major 1 only). */
export type SchemaVersion = string;

/** IPv4-style 64 lowercase hex characters. */
export type DigestHex = string;

/** The provenance kinds a digest provenance record can state. */
export type DigestProvenanceKind = 'COMPUTED' | 'INHERITED';

/** How a digest was obtained, so a number is never unsourced. */
export interface Provenance {
  readonly kind: DigestProvenanceKind;
  /** Human-readable procedure, at least 3 characters. */
  readonly procedure: string;
  /** Record identifiers the digest was derived from (required when INHERITED). */
  readonly inputs?: ReadonlyList<string>;
}

/** Lifecycle axis: where a record stands in the run/evaluation workflow. */
export type LifecycleState = 'DRAFT' | 'FROZEN' | 'EVALUATED' | 'ARCHIVED';

/** Measurement provenance values (architecture: measured|entered|derived|unavailable). */
export type MeasurementKind = 'MEASURED' | 'ENTERED' | 'DERIVED' | 'UNAVAILABLE';

/** Units accepted by the neutral measurement contract. */
export type MeasurementUnit =
  | 's'
  | 'ms'
  | 'min'
  | 'tokens'
  | 'points'
  | 'count'
  | 'bytes'
  | 'ratio'
  | 'usd';

/** Assessment-trust axis. No value here is a certification. */
export type EvaluationTrust = 'UNTRUSTED_LEGACY' | 'INELIGIBLE_LOCAL_ASSESSMENT' | 'LOCAL_SELF_ASSESSMENT';

/** Evaluator-execution axis: reported separately from the agent outcome. */
export type EvaluatorExecutionStatus = 'SUCCESS' | 'FAILURE' | 'INFRASTRUCTURE_ERROR';

/** Human-review axis: pending/scored only; no review outcome is encoded. */
export type HumanReviewStatus = 'NOT_REVIEWED' | 'SCORED';

/** Whether a result may carry a score at all, stated separately from trust. */
export type ScoreEligibility =
  | 'ELIGIBLE_NOT_RUN'
  | 'ELIGIBLE_PENDING_HUMAN_REVIEW'
  | 'SCORED'
  | 'INELIGIBLE';

/** Neutral run outcome vocabulary (superset of the historical one). */
export type RunStatus =
  | 'COMPLETED'
  | 'TIME_LIMIT'
  | 'TIME_LIMIT_OVERRUN'
  | 'STOP_FAILURE'
  | 'INFRASTRUCTURE_FAILURE'
  | 'ABORTED'
  | 'SEEDED_NOT_STARTED';

/** Stop-request outcome vocabulary, shared with the historical shape. */
export type StopResult = 'COMPLETED' | 'STOPPED' | 'STOP_FAILURE' | 'UNKNOWN';

/** Evaluator exposure about its own visibility. */
export type EvaluatorExposure = 'PUBLIC' | 'OWNER_LOCAL' | 'PRIVATE';

/** Evaluator transparency towards the participant. */
export type EvaluatorTransparency = 'OPEN_SOURCE' | 'LOCAL_VISIBLE' | 'NOT_VISIBLE_TO_PARTICIPANT';

/** Declared run security model. */
export type SecurityModel =
  | 'COOPERATIVE_WORKSPACE_NO_ADVERSARIAL_OS_CONTAINMENT'
  | 'OS_CONTAINED_WORKSPACE'
  | 'UNSPECIFIED';

/** How a reported quality record stands. */
export type QualityStatus = 'HUMAN_REVIEW_PENDING' | 'SCORED' | 'INVALID';

/** Declared comparability of a result. */
export type Comparability = 'NOT_COMPARABLE' | 'LOCAL_ONLY' | 'DECLARED_CEILING_ONLY' | 'FULL';

/* -------------------------------------------------------------------------- */
/* Version and vocabulary constants                                           */
/* -------------------------------------------------------------------------- */

/** Baseline contract version shared by every neutral family. */
export declare const NEUTRAL_CONTRACT_VERSION: SchemaVersion;

/** The only schema major this release reads; unknown majors are rejected. */
export declare const SUPPORTED_SCHEMA_MAJOR: number;

/** Neutral contract families, frozen in this order. */
export declare const NEUTRAL_CONTRACT_KINDS: ReadonlyList<ContractKind>;

/** Historical result/telemetry schema versions this module may read. */
export declare const LEGACY_RESULT_SCHEMA_VERSIONS: ReadonlyList<'1.0' | '1.1' | '1.2'>;

/** Historical records are descriptive; they can never be official or certified. */
export interface LegacyTrustCeiling {
  readonly lifecycle: 'DRAFT';
  readonly evaluationTrust: 'UNTRUSTED_LEGACY';
  readonly humanReviewStatus: 'NOT_REVIEWED';
}

export declare const LEGACY_TRUST_CEILING: LegacyTrustCeiling;

export declare const MEASUREMENT_KINDS: ReadonlyList<MeasurementKind>;
export declare const LIFECYCLE_STATES: ReadonlyList<LifecycleState>;
export declare const EVALUATION_TRUSTS: ReadonlyList<EvaluationTrust>;
export declare const EVALUATOR_EXECUTION_STATUSES: ReadonlyList<EvaluatorExecutionStatus>;
export declare const HUMAN_REVIEW_STATUSES: ReadonlyList<HumanReviewStatus>;
export declare const MEASUREMENT_UNITS: ReadonlyList<MeasurementUnit>;
export declare const RUN_STATUSES: ReadonlyList<RunStatus>;
/** A run that never produced an attempt is not scorable. */
export declare const NON_SCORABLE_RUN_STATUSES: ReadonlyList<RunStatus>;
export declare const STOP_RESULTS: ReadonlyList<StopResult>;
export declare const EVALUATOR_EXPOSURES: ReadonlyList<EvaluatorExposure>;
export declare const EVALUATOR_TRANSPARENCIES: ReadonlyList<EvaluatorTransparency>;
export declare const SECURITY_MODELS: ReadonlyList<SecurityModel>;

/** The only trust a self-assessing local producer may claim. */
export declare const MAX_SELF_ISSUED_EVALUATION_TRUST: 'LOCAL_SELF_ASSESSMENT';

/** Field carrying the untouched historical payload returned by the reader. */
export declare const LEGACY_SOURCE_FIELD: 'sourceRecord';

/** Discriminator marking a value produced by `readLegacyResult`. */
export declare const LEGACY_ENVELOPE_MARKER: 'legacyEnvelope';

/* -------------------------------------------------------------------------- */
/* Error type and validation entry point                                      */
/* -------------------------------------------------------------------------- */

/**
 * Error thrown for a single, well-localised input problem (for example the
 * historical reader rejecting unreadable data). Batch validators group
 * problems on a plain `Error` instead.
 */
export declare class ContractValidationError extends Error {
  /** Path inside the record the rejection refers to. */
  readonly contractPath: string;
  /** The rejection message inside that path. */
  readonly contractMessage: string;
  constructor(path: string, message: string, value?: unknown);
}

/* -------------------------------------------------------------------------- */
/* ToolingIdentity                                                            */
/* -------------------------------------------------------------------------- */

/** The contracts one tooling component can serve. */
export interface SupportedContracts {
  readonly contractsVersion: SchemaVersion;
  readonly kinds: ReadonlyList<ContractKind>;
}

export interface ToolingIdentity {
  readonly schemaVersion: SchemaVersion;
  readonly kind: 'ToolingIdentity';
  readonly toolingId: string;
  /** Tooling releases on its own train (for example `0.1.0`); a version domain separate from challenge, candidate and evaluator versions, so equal strings across domains do not conflate the identities. */
  readonly toolingVersion: string;
  readonly toolingComponent: string;
  readonly revision: string;
  readonly installedDigest: DigestHex;
  readonly adapterName?: string;
  /** Requires `adapterName` to be present as well. */
  readonly adapterVersion?: string;
  /* Architecture binding of this identity. */
  readonly architectureId: string;
  readonly architectureKind: string;
  readonly hashAlgorithm: 'sha256';
  readonly definitionDigest: DigestHex;
  readonly digestProvenance: Provenance;
  readonly supportedContracts?: SupportedContracts;
  readonly notes?: string | null;
  /** Recomputed over this record's canonical bytes (excluding self-digest fields). */
  readonly identityDigest?: DigestHex;
}

/* -------------------------------------------------------------------------- */
/* ChallengeIdentity                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The original candidate lineage, preserved rather than rewritten into the
 * neutral identity: historical version, status, source commit/tag and the
 * review/evidence digests survive alongside the new architecture binding.
 */
export interface CandidateLineage {
  readonly candidateVersion: string;
  readonly candidateStatus: string;
  readonly sourceCommit: string;
  readonly sourceTag?: string;
  readonly reviewPacketDigest?: DigestHex;
  readonly reviewStatus?: string;
  readonly evidenceManifestDigest?: DigestHex;
  readonly lineageNotes?: string;
}

export interface ChallengeIdentity {
  readonly schemaVersion: SchemaVersion;
  readonly kind: 'ChallengeIdentity';
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly architectureId: string;
  readonly architectureKind: string;
  readonly hashAlgorithm: 'sha256';
  readonly definitionDigest: DigestHex;
  readonly digestProvenance: Provenance;
  readonly workloadProvenance: Provenance;
  /** Required when `workloadProvenance.kind` is `INHERITED`. */
  readonly provenanceInputs?: ReadonlyList<string>;
  readonly publicPrdDigest: DigestHex;
  readonly visibleHarnessDigest: DigestHex;
  readonly fixtureDigest: DigestHex;
  /** Sorted `[path, fileDigest]` pairs with unique POSIX relative paths. */
  readonly starterInventory: ReadonlyList<readonly [string, DigestHex]>;
  readonly workloadDigest: DigestHex;
  readonly declaredCeilingMinutes?: number | null;
  readonly candidateLineage: CandidateLineage;
  readonly notes?: string | null;
  readonly identityDigest?: DigestHex;
}

/* -------------------------------------------------------------------------- */
/* EvaluatorIdentity                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The declared score split. Scoring authority stays external: this carries
 * numbers a result can cite, no arithmetic and no rubric.
 */
export interface ScoringBindings {
  readonly automatedMaximum: number;
  readonly humanMaximum: number;
  readonly maximum: number;
  readonly categories: Readonly<Record<string, number>>;
}

export interface EvaluatorIdentity {
  readonly schemaVersion: SchemaVersion;
  readonly kind: 'EvaluatorIdentity';
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly exposure: EvaluatorExposure;
  readonly transparency: EvaluatorTransparency;
  /** Default false; OpenSource + secretClaim is refused. */
  readonly secretClaim: boolean;
  readonly architectureId: string;
  readonly architectureKind: string;
  readonly hashAlgorithm: 'sha256';
  readonly definitionDigest: DigestHex;
  readonly digestProvenance: Provenance;
  readonly scoringDigest: DigestHex;
  readonly visibleTestsDigest: DigestHex;
  readonly hiddenTestsDigest: DigestHex;
  readonly harnessDigest?: DigestHex | null;
  readonly scoringBindings?: ScoringBindings | null;
  readonly notes?: string | null;
  readonly identityDigest?: DigestHex;
}

/* -------------------------------------------------------------------------- */
/* RunManifest                                                                */
/* -------------------------------------------------------------------------- */

/** Run configuration. `null` means "not known here" and stays null. */
export interface RunConfiguration {
  readonly harness?: string | null;
  readonly model?: string | null;
  readonly location?: string | null;
  readonly os?: string | null;
  readonly nodeVersion?: string | null;
  readonly runtimeFlags?: Readonly<Record<string, string>> | null;
  readonly unknown?: 'UNKNOWN' | 'UNSET' | null;
  /** Meaningful only while `unknown` is `UNKNOWN`. */
  readonly unknownFields?: ReadonlyList<string>;
}

/** A tooling binding envelope inside a run manifest. */
export interface ToolingBinding {
  readonly toolingId: string;
  readonly architectureId: string;
  readonly toolingIdentityDigest: DigestHex;
  readonly toolingVersion: string;
  readonly toolingComponent: string;
  readonly installedDigest: DigestHex;
  readonly adapterName?: string;
  readonly adapterVersion?: string | null;
}

/** A challenge binding envelope inside a run manifest. */
export interface ChallengeBinding {
  readonly challengeId: string;
  readonly architectureId: string;
  readonly challengeIdentityDigest: DigestHex;
  readonly challengeVersion: string;
  readonly workloadDigest: DigestHex;
  readonly declaredCeilingMinutes?: number | null;
  /** Preserved candidate lineage version; preserved data of its own release train, never an ordering gate across domains. */
  readonly candidateVersion: string;
}

/** An evaluator binding envelope inside a run manifest. */
export interface EvaluatorBinding {
  readonly evaluatorId: string;
  readonly architectureId: string;
  readonly evaluatorIdentityDigest: DigestHex;
  readonly evaluatorVersion: string;
  readonly scoringDigest: DigestHex;
  readonly exposure: EvaluatorExposure;
}

export interface RunBindings {
  readonly tooling: ToolingBinding;
  readonly challenge: ChallengeBinding;
  readonly evaluator: EvaluatorBinding;
}

export interface RunManifest {
  readonly schemaVersion: SchemaVersion;
  readonly kind: 'RunManifest';
  readonly manifestId: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly architectureId: string;
  readonly architectureKind: string;
  readonly hashAlgorithm: 'sha256';
  readonly definitionDigest: DigestHex;
  readonly digestProvenance: Provenance;
  readonly bindings: RunBindings;
  readonly harness: string;
  readonly securityModel: SecurityModel;
  readonly expectedSessionPolicy?: Readonly<Record<string, string>> | null;
  readonly declaredCeilingMinutes?: number | null;
  readonly configuration: RunConfiguration;
  /** Explicit native absolute host root argument (POSIX `/root`, Windows `C:\root`/`C:/root` or UNC), recorded in the host's own path syntax and lexically disjoint from `evidenceRoot`. */
  readonly participantWorkspaceRoot: string;
  /** Explicit native absolute host root argument (POSIX `/root`, Windows `C:\root`/`C:/root` or UNC), recorded in the host's own path syntax and lexically disjoint from `participantWorkspaceRoot`. */
  readonly evidenceRoot: string;
  readonly notes?: string | null;
}

/* -------------------------------------------------------------------------- */
/* FrozenSubmission                                                           */
/* -------------------------------------------------------------------------- */

export interface FrozenSubmission {
  readonly schemaVersion: SchemaVersion;
  readonly kind: 'FrozenSubmission';
  readonly frozenSubmissionId: string;
  readonly manifestId: string;
  readonly runId: string;
  readonly frozenAt: string;
  readonly hashAlgorithm: 'sha256';
  readonly inventory: ReadonlyList<readonly [string, DigestHex]>;
  readonly treeDigest: DigestHex;
  readonly byteCount: number;
  readonly fileCount: number;
  readonly freezeProcedure: string;
  readonly notes?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Measurement                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where a measurement value came from. `LOCAL_ID`/`LOCAL_DIGEST` point at
 * local records; `SELF_ASSESSMENT`/`LOCAL_PROCEDURE` are honest non-computed
 * statements; `COMPUTED` names a procedure. An unmeasured value carries no
 * source at all.
 */
/** Optional companion IDs are either a complete non-null pair or absent. */
type MeasurementRecordReference =
  | { readonly recordKind: ContractKind; readonly recordId: string }
  | { readonly recordKind?: never; readonly recordId?: never };

/** Discriminators require their actual reference, never null or a procedure
 * masquerading as an ID/digest. Procedure sources may claim no references;
 * complete optional references are validated against a containing Result.
 * Nonempty strings and 64-hex digests are enforced at runtime/schema. */
export type MeasurementSource =
  | { readonly kind: 'LOCAL_ID'; readonly recordKind: ContractKind;
      readonly recordId: string; readonly digest?: DigestHex; readonly procedure: string }
  | ({ readonly kind: 'LOCAL_DIGEST'; readonly digest: DigestHex;
       readonly procedure: string } & MeasurementRecordReference)
  | ({ readonly kind: 'COMPUTED'; readonly digest?: DigestHex;
       readonly procedure: string } & MeasurementRecordReference)
  | ({ readonly kind: 'SELF_ASSESSMENT'; readonly digest?: DigestHex;
       readonly procedure: string } & MeasurementRecordReference)
  | ({ readonly kind: 'LOCAL_PROCEDURE'; readonly digest?: DigestHex;
       readonly procedure: string } & MeasurementRecordReference);

/**
 * A `DERIVED` measurement's dependency statement, parsed from its formula by
 * `parseDerivation`. The measurement record itself stores the formula string
 * only — the one stable representation on the wire, in the runtime, in the
 * schema and in these declarations, so a validated record always validates
 * again.
 */
export interface MeasurementDerivation {
  readonly formula: string;
  /** The placeholders named by the formula, in order. */
  readonly inputs: ReadonlyList<string>;
}

export interface Measurement {
  readonly schemaVersion: SchemaVersion;
  readonly kind: 'Measurement';
  readonly measurementId: string;
  readonly metric: string;
  readonly unit: MeasurementUnit;
  readonly measurementKind: MeasurementKind;
  /** For UNAVAILABLE exactly null; null is never replaced by zero. */
  readonly value: number | null;
  readonly source: MeasurementSource | null;
  /** The derivation formula string, e.g. `'{totalTokens} / {elapsedWallSeconds}'`; required for DERIVED, refused otherwise. One shared formula grammar applies everywhere: at least one whole `{metricName}` placeholder (metric-grammar name), every `{`/`}` belonging to exactly one token, no empty/placeholder-free/whitespace-only formula (the runtime's semantic extras — repeated inputs, measurementKind coupling — are runtime-only). Parsed views come from `parseDerivation`. */
  readonly derivation?: string;
  readonly confidence?: number | null;
  readonly recordedAt?: string | null;
  readonly notes?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Result                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What an assessment trust rests on. Only the two honest bases exist: the
 * person who made the assessment, or a local procedure was executed. There is
 * deliberately no grant, authority or certificate field.
 */
export interface TrustBasis {
  readonly basisKind: 'SELF_ASSESSMENT' | 'LOCAL_PROCEDURE';
  /** Never a binding digest presented as an external grant. */
  readonly basisDigest?: DigestHex | null;
  readonly reviewer?: string | null;
}

export interface HumanReview {
  readonly reviewId?: string | null;
  readonly reviewStatus: HumanReviewStatus;
  readonly reviewer?: string | null;
  /** Required together with a review status other than NOT_REVIEWED. */
  readonly reviewDigest?: DigestHex | null;
  /** Required together with a review status other than NOT_REVIEWED. */
  readonly reviewedAt?: string | null;
}

/** Bindings a result shares with the run, submission and identities it describes. */
export interface ResultBindings {
  readonly manifestId: string;
  readonly runId: string;
  readonly frozenSubmissionId: string;
  readonly treeDigest: DigestHex;
  readonly manifestDigest: DigestHex;
  readonly toolingIdentityDigest: DigestHex;
  readonly challengeIdentityDigest: DigestHex;
  readonly evaluatorIdentityDigest: DigestHex;
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly candidateVersion: string;
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly toolingId: string;
  readonly toolingVersion: string;
  readonly workloadDigest: DigestHex;
}

export interface QualityRecord {
  readonly automated: number;
  readonly automatedMaximum: number;
  readonly humanUI?: number | null;
  readonly humanMaximum: number;
  /** Null/absent unless status is SCORED. SCORED requires numeric quality and
   * humanUI (zero is valid), evaluatorExecution SUCCESS, a SCORED named human
   * review, and scoreEligibility SCORED; validation enforces these axes. */
  readonly quality?: number | null;
  readonly qualityMaximum: number;
  readonly status: QualityStatus;
  readonly categories: Readonly<Record<string, number>>;
}

export interface Result {
  readonly schemaVersion: SchemaVersion;
  readonly kind: 'Result';
  readonly resultId: string;
  readonly lifecycle: LifecycleState;
  readonly runStatus: RunStatus;
  readonly evaluatorExecution?: EvaluatorExecutionStatus | null;
  readonly scoreEligibility: ScoreEligibility;
  readonly stopResult?: StopResult | null;
  readonly architectureId: string;
  readonly hashAlgorithm: 'sha256';
  readonly bindings: ResultBindings;
  readonly quality: QualityRecord;
  readonly measurements: ReadonlyList<Measurement>;
  /** Assessment trust; validated implementation never accepts a higher state. */
  readonly evaluationTrust: EvaluationTrust;
  readonly evaluationTrustBasis: TrustBasis;
  readonly humanReview: HumanReview;
  /** Nothing is elevated by a reader; a non-empty list is refused. */
  readonly declaredTrustChanges?: ReadonlyList<string> | null;
  /** A scored result must state the limitations that keep it honest. */
  readonly limitations: ReadonlyList<string>;
  readonly comparability?: Comparability | null;
  readonly historical?: boolean;
  readonly notes?: string | null;
}

/* -------------------------------------------------------------------------- */
/* validateRecord                                                             */
/* -------------------------------------------------------------------------- */

/** Any one neutral record family. */
export type NeutralRecord =
  | ToolingIdentity
  | ChallengeIdentity
  | EvaluatorIdentity
  | RunManifest
  | FrozenSubmission
  | Measurement
  | Result;

/**
 * Validate one record against its family schema and invariants and return the
 * validated projection (declared fields only; omitted optionals are
 * default-applied and every field keeps the representation it was written in,
 * so a validated record validates again unchanged).
 *
 * Throws with every problem listed at once for: unknown kind, malformed data,
 * an unsupported schema major, duplicate or conflicting identity bindings, or
 * a declared digest that does not match recalculation.
 */
export declare function validateRecord(kind: 'ToolingIdentity', value: unknown): ToolingIdentity;
export declare function validateRecord(kind: 'ChallengeIdentity', value: unknown): ChallengeIdentity;
export declare function validateRecord(kind: 'EvaluatorIdentity', value: unknown): EvaluatorIdentity;
export declare function validateRecord(kind: 'RunManifest', value: unknown): RunManifest;
export declare function validateRecord(kind: 'FrozenSubmission', value: unknown): FrozenSubmission;
export declare function validateRecord(kind: 'Measurement', value: unknown): Measurement;
export declare function validateRecord(kind: 'Result', value: unknown): Result;
export declare function validateRecord(kind: ContractKind, value: unknown): NeutralRecord;

/* -------------------------------------------------------------------------- */
/* Digest helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Canonical JSON: object keys sorted, array order preserved. */
export declare function canonicalJson(value: unknown): string;

/** sha256 hex over UTF-8 text. */
export declare function sha256Hex(text: string): string;

/**
 * The preserved tree digest over `[path, fileDigest]` pairs: the exact path
 * strings sorted lexically, sha256 over the canonical JSON of the pair list —
 * the same bytes `identity.hashEntries` hashes. Paths are never rewritten or
 * normalised; a non-exact relative POSIX spelling (backslash, drive letter,
 * leading `./`, dot/traversal segment, repeated, leading or trailing
 * separator, absolute form, control character) is refused before hashing, raw
 * bytes and Unicode paths are carried verbatim, and duplicate or
 * case-insensitive colliding paths are refused.
 */
export declare function computeTreeDigest(entries: ReadonlyList<readonly [string, string]>): string;

/**
 * Parse the inputs a derivation formula names — the same well-formedness rules
 * `validateRecord` applies to a `DERIVED` measurement's `derivation` string,
 * and the same grammar the `measurement.schema.json` `derivation` pattern
 * enforces structurally: at least one whole `{metricName}` placeholder
 * (metric-grammar name), every `{`/`}` belonging to exactly one token; an
 * empty, placeholder-free or whitespace-only formula is refused. The runtime's
 * semantic extras (repeated inputs, measurementKind coupling) stay
 * runtime-only. Throws on a malformed formula; the record itself always
 * carries the formula string, never a parsed projection of it.
 */
export declare function parseDerivation(formula: string): MeasurementDerivation;

/**
 * Self digest of a record: sha256 over its canonical bytes excluding the
 * `identityDigest` and `manifestDigest` fields themselves.
 */
export declare function identityDigestOf(recordValue: Readonly<Record<string, unknown>>): string;

/* -------------------------------------------------------------------------- */
/* createRunManifest                                                          */
/* -------------------------------------------------------------------------- */

/** Input for `createRunManifest`; every binding field is derived from validated identities. */
export interface RunManifestInput {
  readonly manifestId: string;
  readonly runId: string;
  readonly createdAt: string;
  /** Must differ from each identity's own architecture binding. */
  readonly architectureId: string;
  readonly architectureKind?: string;
  readonly harness: string;
  readonly securityModel?: SecurityModel;
  readonly expectedSessionPolicy?: Readonly<Record<string, string>> | null;
  /** Must not exceed the ceiling bound by the challenge identity. */
  readonly declaredCeilingMinutes?: number | null;
  /** `null`/`undefined` records "unknown here": unknown fields stay null and listed. */
  readonly configuration?: RunConfiguration | null;
  /** Explicit native absolute host root arguments (POSIX `/root`, Windows `C:\root`/`C:/root` or UNC), recorded in the host's own path syntax and lexically disjoint from each other. */
  readonly participantWorkspaceRoot: string;
  /** See `participantWorkspaceRoot`. */
  readonly evidenceRoot: string;
  readonly notes?: string;
  readonly toolingIdentity: ToolingIdentity;
  readonly challengeIdentity: ChallengeIdentity;
  readonly evaluatorIdentity: EvaluatorIdentity;
}

/** A sealed, deeply frozen manifest with its recomputed manifest digest. */
export type SealedRunManifest = Readonly<
  RunManifest & { readonly manifestDigest: DigestHex }
>;

/**
 * Build a sealed `RunManifest` from three validated identity records. Refuses
 * ID or version collisions with tooling, an excessively declared ceiling and
 * unrecognised input keys; unknown configuration is preserved as null and
 * listed, never defaulted to zero or an empty string.
 */
export declare function createRunManifest(input: RunManifestInput): SealedRunManifest;

/* -------------------------------------------------------------------------- */
/* Legacy reader                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A marked legacy envelope. The untouched historical payload is `sourceRecord`
 * verbatim; `preservedOutcome` is the outcome-bearing object the historical
 * shape actually emitted (the whole emitted telemetry projection when it
 * carries numeric quality and top-level authority/outcome flags, otherwise the
 * inner metrics or run object) — including well-typed historical validity,
 * eligibility and execution-binding statements at their real locations, whose
 * truth never promotes the record. The trust ceiling binds and
 * `promotionAllowed` is always false.
 */
export interface LegacyResultEnvelope {
  readonly legacyEnvelope: true;
  readonly legacyReaderVersion: SchemaVersion;
  readonly recognizedSchemaVersion: '1.0' | '1.1' | '1.2';
  readonly legacyShape: 'telemetry' | 'result';
  readonly bindingStatus: 'UNBOUND_HISTORICAL';
  readonly trust: LegacyTrustCeiling;
  readonly eligibility: 'NOT_FORMAL_COMPARISON_ELIGIBLE';
  readonly promotionAllowed: false;
  readonly outcomePreservation: 'VERBATIM';
  /** `null` when the source carries no outcome object at all. */
  readonly preservedOutcome: unknown;
  readonly sourceRecord: Readonly<Record<string, unknown>>;
}

/**
 * Read a historical result/telemetry record (schema 1.0, 1.1 or 1.2) into a
 * marked legacy envelope. Unrecognised or malformed data is refused; recognised
 * data keeps trust clamped to the ceiling with no promotion path, whatever its
 * source records about its own validity or eligibility.
 */
export declare function readLegacyResult(value: unknown): LegacyResultEnvelope;

/** True only for an envelope produced by `readLegacyResult`. */
export declare function isLegacyEnvelope(value: unknown): boolean;
