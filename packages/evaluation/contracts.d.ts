export declare const DEFAULT_TIMEOUT_MS: 300000;
export declare const DEFAULT_MAX_OUTPUT_BYTES: 1048576;
export declare const WORKER_PROTOCOL_VERSION: 1;
export type StageName = 'typecheck' | 'build' | 'visible' | 'browser' | 'useful' | 'inspection';
export type InfrastructureCode = 'TIMEOUT' | 'CANCELLED' | 'MISSING_PREREQUISITE' | 'TOOL_CRASH' | 'OUTPUT_LIMIT' | 'INVALID_TOOL_OUTPUT' | 'CLEANUP_FAILED';
export declare const STAGES: readonly StageName[];
export declare const INFRASTRUCTURE_CODES: readonly InfrastructureCode[];
export declare const CANONICAL_TOOLING: readonly string[];
export declare const STAGE_WORKER_PATH: string;
export interface ProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly stdoutLog: string;
  readonly stderrLog: string;
}
export interface InfrastructureDiagnostic { readonly code: InfrastructureCode; readonly message: string; readonly details?: Record<string, unknown> }
export interface ProcessFacts { readonly exitCode: number | null; readonly signal: string | null; readonly stdout: string; readonly stderr: string; readonly stdoutLog: string; readonly stderrLog: string }
export type ProcessResult = (ProcessFacts & { readonly status: 'completed'; readonly exitCode: number; readonly signal: null }) | (ProcessFacts & { readonly status: 'infrastructure-error'; readonly error: InfrastructureDiagnostic });
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;
export interface StageContext {
  readonly appRoot: string;
  readonly artifactRoot: string;
  readonly tempRoot: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runProcess: ProcessRunner;
}
export interface WorkerRequest { readonly protocolVersion: 1; readonly appRoot: string; readonly artifactRoot: string; readonly tempRoot: string; readonly maxOutputBytes: number }
export interface PropertyRecord { readonly id: string; readonly area: string; readonly name?: string; readonly passed: boolean; readonly [key: string]: unknown }
export interface UsefulTests { readonly baselinePassed: boolean; readonly addedCount: number; readonly killedMutations: readonly string[]; readonly method?: string }
export interface VisibleTests { readonly passed: number; readonly total: number; readonly reportPath: string }
export interface StageResult<T = unknown> { readonly stage: StageName; readonly status: 'success'; readonly value: T; readonly process: ProcessResult | null }
export declare class EvaluationInfrastructureError extends Error { readonly stage: string; readonly code: InfrastructureCode; readonly details: Record<string, unknown>; constructor(stage: string, code: InfrastructureCode, message: string, details?: Record<string, unknown>); }
export declare class EvaluationRefusalError extends Error { readonly code: string; readonly details: Record<string, unknown>; constructor(code: string, message: string, details?: Record<string, unknown>); }
export declare function throwIfAborted(signal: AbortSignal | undefined, stage: string): void;
export declare function requireCompleted(result: ProcessResult, stage: StageName): ProcessResult & { readonly status: 'completed' };
export declare function stageSuccess<T>(stage: StageName, value: T, processResult?: ProcessResult | null): StageResult<T>;
export declare function runWorkerStage(context: StageContext, stage: 'browser'): Promise<StageResult<readonly PropertyRecord[]>>;
export declare function runWorkerStage(context: StageContext, stage: 'useful'): Promise<StageResult<UsefulTests>>;
export declare function runWorkerStage(context: StageContext, stage: 'inspection'): Promise<StageResult<Record<string, unknown>>>;
