import type { EvaluationRequest, EvaluationSuccess, EvaluationFailure, CleanupObservation } from './evaluate-frozen.mjs';
import type { ProcessRunner, StageName, StageContext, StageResult } from './contracts.mjs';
import type { StagingClaim } from './staging.mjs';
/** Internal trusted collaborators only; not an option on the public evaluateFrozen API. */
export interface EvaluationRuntime {
  readonly runProcess: ProcessRunner;
  readonly preflight: (request: EvaluationRequest) => void | Promise<void>;
  readonly canonicalRoot?: string;
  readonly dependencyRoot?: string;
  readonly stageOverrides?: Partial<Record<StageName, (context: StageContext) => StageResult | Promise<StageResult>>>;
  readonly onEvent?: (name: string, facts: unknown) => void;
  readonly cleanupScratch?: (claim: StagingClaim) => CleanupObservation | Promise<CleanupObservation>;
}
export declare function evaluateWithRuntime(request: EvaluationRequest, runtime: EvaluationRuntime): Promise<Omit<EvaluationSuccess, 'bundle'> | Omit<EvaluationFailure, 'bundle'>>;
/** Internal in-process ownership check; serialized or reconstructed results cannot grant a claim. */
export declare function assertEvaluationResultClaim(result: object, outputRoot: string): void;
