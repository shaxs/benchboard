import type { PropertyRecord, StageContext, StageResult, WorkerRequest } from './contracts.mjs';
export type BrowserStageCollaborators = Readonly<{
  /** Defaults to the unchanged evaluator/local-server.mjs export, loaded by dynamic import. */
  readonly localServer?: (appRoot: string) => Promise<Readonly<{ readonly url: string; readonly close: () => unknown; readonly logs?: () => string }>>;
  /** Defaults to the unchanged evaluator/browser.mjs export; must be invoked with no property filter. */
  readonly browserEvaluate?: (url: string, artifactRoot: string) => Promise<readonly PropertyRecord[]>;
}>;
/** Parent entry: runs the browser stage as a supervised worker child via the T1 worker protocol. */
export declare function runBrowserStage(context: StageContext): Promise<StageResult<readonly PropertyRecord[]>>;
/** Child handler for the Captain-owned stage worker. Paths and bounds were validated upstream. */
export declare function executeBrowserStage(request: WorkerRequest, dependencies?: BrowserStageCollaborators): Promise<readonly PropertyRecord[]>;
