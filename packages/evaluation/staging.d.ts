import type { EvaluationRequest } from './evaluate-frozen.mjs';
import type { InventoryTreeResult } from '../core/identity.mjs';
export declare const OWNER_ROOT: string;
export interface DirectoryClaim { readonly path: string; readonly identity: string }
export interface VerifiedSelection { readonly runRoot: string; readonly stateRoot: string; readonly workspaceRoot: string; readonly manifest: Record<string, unknown>; readonly snapshotRoot: string; readonly treeDigest: string; readonly workspaceMatchesFrozen: boolean | null }
export interface StagingClaim { readonly scratchRoot: string; readonly appRoot: string; readonly tempRoot: string; readonly chain: readonly DirectoryClaim[]; readonly outputChain: readonly DirectoryClaim[]; readonly initial: Map<string, string> }
export declare function assertDirectoryChain(root: string): DirectoryClaim[];
export declare function validateEvaluationRequest(request: EvaluationRequest): EvaluationRequest & { readonly timeoutMs: number; readonly maxOutputBytes: number };
export declare function verifySelection(request: EvaluationRequest): Promise<VerifiedSelection>;
/** Private trusted test seam; production never accepts canonical/dependency roots from public options. */
export declare function stageFrozen(verified: VerifiedSelection, request: EvaluationRequest, options?: { readonly canonicalRoot?: string; readonly dependencyRoot?: string; readonly onEvent?: (name: string, facts: Record<string, unknown>) => void }): Promise<StagingClaim>;
export declare function cleanupScratch(claim: StagingClaim | null): { removed: boolean; residue: string[]; errors: { code: 'CLEANUP_FAILED'; message: string }[] };
