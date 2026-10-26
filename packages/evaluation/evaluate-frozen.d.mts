import type { ChallengeIdentity, EvaluatorIdentity } from '../core/manifest.mjs';
import type { InfrastructureDiagnostic, StageResult } from './contracts.mjs';
import type { EvidenceBundle } from './bundle.mjs';
export interface FrozenSelection { readonly runRoot: string; readonly runId: string; readonly manifestId: string; readonly snapshotId: string; readonly frozenSubmissionId: string; readonly expectedDigest: string }
export interface EvaluationRequest {
  readonly challenge: ChallengeIdentity;
  readonly evaluator: EvaluatorIdentity;
  readonly submission: FrozenSelection;
  /** Exclusively new output directory; its parent must exist. Never a participant/protected directory. */
  readonly outputRoot: string;
  readonly environment?: Readonly<{ label?: string | null }>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}
export interface SnapshotObservation { readonly before: string; readonly after: string | null; readonly workspaceMatchesFrozen: boolean | null }
export interface CleanupObservation { readonly removed: boolean; readonly residue: readonly string[]; readonly errors: readonly InfrastructureDiagnostic[] }
export interface EvaluationSuccess { readonly status: 'success'; readonly evaluationId: string; readonly bundle: EvidenceBundle; readonly evidence: Record<string, unknown>; readonly stages: readonly StageResult[]; readonly score: null; readonly snapshot: SnapshotObservation; readonly environment: Record<string, unknown>; readonly cleanup: CleanupObservation; readonly artifacts: readonly string[] }
export interface EvaluationFailure { readonly status: 'infrastructure-error'; readonly evaluationId: string | null; readonly bundle: null; readonly error: InfrastructureDiagnostic & { readonly stage: string }; readonly evidence: null; readonly score: null; readonly snapshot: SnapshotObservation | null; readonly cleanup: CleanupObservation; readonly artifacts: readonly string[] }
/**
 * The supported entry point over real production collaborators only: no public runtime or
 * collaborator injection exists, and an undocumented request option (for example a `runtime`) is
 * refused, never honored. Success resolves with the unchanged S1 fields plus one additive, validated
 * complete `bundle`; the automated score is `bundle.score` while the top-level `score` stays null for
 * compatibility on both result shapes. A modeled infrastructure fault RETURNS the
 * infrastructure-error shape with a null bundle, null evidence and no points — including
 * `CLEANUP_FAILED`, which the controller may report when scratch cleanup or retained-output ownership
 * is not confirmed and the bundle-attachment step may report when the controller-owned output claim is
 * no longer intact; only an infrastructure error converts this way, and an incomplete result never
 * becomes a bundle or partial points. A typed evidence-integrity rejection (`EvaluationIntegrityError`,
 * `EVIDENCE_INTEGRITY`) or a typed request/safety rejection (`EvaluationRefusalError`) still REJECTS,
 * as does any unknown error: unmodeled errors are never swallowed or relabelled. On rejection no raw
 * S1 result, bundle or partial score is returned.
 */
export declare function evaluateFrozen(request: EvaluationRequest): Promise<EvaluationSuccess | EvaluationFailure>;
