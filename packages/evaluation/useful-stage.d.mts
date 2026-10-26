import type { StageContext, StageResult, UsefulTests, WorkerRequest } from './contracts.mjs';
export type UsefulTestsStageCollaborators = Readonly<{
  /** Defaults to the unchanged evaluator/useful-tests.mjs export, loaded by dynamic import. Synchronous in the default; a replacement may return a promise. */
  readonly usefulTestsCooperative?: (appRoot: string, artifactRoot: string) => UsefulTests | Promise<UsefulTests>;
}>;
/** Parent entry: runs the useful-tests stage as a supervised worker child via the T1 worker protocol. */
export declare function runUsefulTestsStage(context: StageContext): Promise<StageResult<UsefulTests>>;
/** Child handler for the Captain-owned stage worker. Paths and bounds were validated upstream. The default collaborator is loaded by dynamic import only, so no unit-test path loads vitest. */
export declare function executeUsefulTestsStage(request: WorkerRequest, dependencies?: UsefulTestsStageCollaborators): UsefulTests | Promise<UsefulTests>;
