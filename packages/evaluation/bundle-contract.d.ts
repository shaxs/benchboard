export declare class EvaluationIntegrityError extends Error { readonly code: 'EVIDENCE_INTEGRITY'; constructor(message: string); }
export interface ScorerEvidence {
  visiblePassed: number; hidden: { id: string; area: string; passed: boolean }[];
  typecheck: boolean; build: boolean; noSuppression: boolean;
  usefulTests: { baselinePassed: boolean; addedCount: number; killedMutations: string[] };
  hygiene: { visibleIntact: boolean; lockedDependencies: boolean; noSecrets: boolean; noDebugLogging: boolean; noNetwork: boolean };
}
export declare function validateScorerEvidence(value: unknown): ScorerEvidence;
export declare function validateEvidenceBundle<T>(value: T): T;
