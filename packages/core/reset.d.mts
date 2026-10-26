import type {InitRequest, InitResult} from './init.mjs';
import type {SealedRunManifest} from './manifest.mjs';
import type {LifecycleClock} from './lifecycle.mjs';
export declare const RESET_ERROR_CODES: Readonly<Record<'INVALID_ARGUMENT'|'INVALID_ROOT'|'OUTPUT_NOT_FRESH'|'OUTPUT_UNUSABLE'|'OUTPUT_ALIAS'|'OUTPUT_LINK_ANCESTOR'|'ROOTS_OVERLAP'|'PROVENANCE_MISMATCH'|'CHALLENGE_MISMATCH'|'STATE_REFUSED'|'JOURNAL_INCOMPLETE'|'JOURNAL_INCONSISTENT'|'IDENTITY_NOT_DISTINCT'|'READBACK_FAILED'|'STORAGE_REFUSED'|'INITIALISE_FAILED', string>>;
export declare const RESET_ELIGIBLE_STATES: readonly ['INITIALIZED','STOP_RECORDED','FROZEN'];
export declare const RESET_REFUSED_STATES: readonly ['RUNNING'];
export declare class ResetError extends Error {
 readonly code: string;
 readonly publicationFate?: string;
 readonly cause?: unknown;
 constructor(code:string,message:string,details?:Record<string,unknown>);
}
export interface ResetRequest {
 readonly runRoot:string;
 readonly manifestId:string;
 readonly runId:string;
 readonly output:string;
 readonly initializationRequest:Omit<InitRequest,'output'>;
 readonly expectedDigest?:string;
 readonly protectedRoots?:readonly string[];
 readonly clock?:LifecycleClock;
 readonly operationName?:string;
}
export interface ResetResult {
 readonly source:Readonly<{runId:string;manifestId:string;state:'INITIALIZED'|'STOP_RECORDED'|'FROZEN';manifestDigest:string|null}>;
 readonly manifest:SealedRunManifest;
 readonly initResult:InitResult;
 readonly output:string;
 readonly fresh:true;
 readonly oldContainerMutation:'none';
}
/** Fresh-container-only reset. Never mutates, deletes or reuses the old identity. */
export declare function resetRun(request:ResetRequest):Promise<ResetResult>;
