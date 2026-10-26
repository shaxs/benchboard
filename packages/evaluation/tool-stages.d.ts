import type { StageContext, StageResult, VisibleTests } from './contracts.mjs';
/** Runs the fixed staged `node node_modules/typescript/bin/tsc --noEmit` in context.appRoot. A normal nonzero exit is `false` evidence; infrastructure outcomes throw. */
export declare function runTypecheckStage(context: StageContext): Promise<StageResult<boolean>>;
/** Runs the fixed staged `node node_modules/vite/bin/vite.js build` in context.appRoot. A normal nonzero exit is `false` evidence; infrastructure outcomes throw. */
export declare function runBuildStage(context: StageContext): Promise<StageResult<boolean>>;
/** Runs the fixed staged visible contract tests with the JSON reporter into `artifactRoot/visible.json`. A completed run with a valid bounded report is evidence even when tests fail; missing, oversized or malformed reports and infrastructure outcomes throw. */
export declare function runVisibleStage(context: StageContext): Promise<StageResult<VisibleTests>>;
