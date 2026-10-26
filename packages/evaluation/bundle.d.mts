import type { ScorerEvidence } from './bundle-contract.mjs';
import type { EvaluationSuccess } from './evaluate-frozen.mjs';
export interface IdentityRef { readonly id: string; readonly digest: string }
export interface SubmissionIdentity { readonly runId: string; readonly snapshotId: string; readonly frozenSubmissionId: string; readonly manifestDigest: string; readonly treeDigest: string }
export interface ManifestEntry { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface EvaluatorIdentityBlock {
  readonly binding: IdentityRef;
  readonly evaluatorVersion: string; readonly scoringVersion: string;
  readonly hashAlgorithm: 'benchboard-sha256-tree-v1';
  readonly semanticManifest: readonly ManifestEntry[]; readonly semanticDigest: string;
  readonly packageManifest: readonly ManifestEntry[]; readonly packageDigest: string;
  readonly originalCandidate: { readonly evaluator: string; readonly scoring: string };
}
export interface BundleIdentities { readonly challenge: IdentityRef; readonly tooling: IdentityRef; readonly submission: SubmissionIdentity; readonly evaluator: EvaluatorIdentityBlock }
/** The closed versioned EvidenceBundle. All keys are required; no additional key exists. */
export interface EvidenceBundle {
  readonly schemaVersion: string; readonly kind: 'EvidenceBundle'; readonly evaluationId: string; readonly executionStatus: 'success';
  readonly identities: BundleIdentities;
  readonly properties: { readonly id: string; readonly area: string; readonly passed: boolean }[];
  readonly visible: { readonly passed: number; readonly total: 17 };
  readonly build: boolean; readonly typecheck: boolean; readonly noSuppression: boolean;
  readonly usefulTests: ScorerEvidence['usefulTests']; readonly hygiene: ScorerEvidence['hygiene'];
  readonly environment: Record<string, unknown>;
  readonly artifactDigests: readonly ManifestEntry[];
  readonly snapshot: { readonly before: string; readonly after: string; readonly workspaceMatchesFrozen: boolean | null };
  readonly score: { readonly automated: number; readonly automatedMaximum: 80; readonly areas: Record<string, number>; readonly humanUI: null; readonly humanMaximum: 20; readonly quality: null; readonly qualityMaximum: 100; readonly status: 'HUMAN_REVIEW_PENDING' };
}
export interface AssembleInputs { readonly result: Omit<EvaluationSuccess, 'bundle'>; readonly identities: BundleIdentities; readonly artifactDigests: readonly ManifestEntry[] }
/** Assembles a closed EvidenceBundle from a fully clean success result; any ineligible input throws EvaluationIntegrityError. Pure projection: no filesystem, subprocess or crypto work. */
export declare function assembleEvidenceBundle(input: AssembleInputs): EvidenceBundle;
/** Re-projects a bundle's evidence back to scorer input, refusing tampered values. */
export declare function scorerEvidenceOf(bundle: EvidenceBundle): ScorerEvidence;
/** Parses JSON text and validates it as an EvidenceBundle. Performs no IO. */
export declare function readEvidenceBundle(text: string): EvidenceBundle;
