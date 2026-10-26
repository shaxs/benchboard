import type { Report } from './report.mjs';
export type UICategory = 'polish' | 'hierarchy' | 'board' | 'drawer' | 'feedback' | 'responsive' | 'consistency';
export interface UIEvidence { readonly artifactId:string; readonly bytes:number; readonly sha256:string; readonly target:'starter'|'submission'; readonly width:1440|1024|768; readonly height:1000; readonly view:'board'|'drawer' }
export interface UIImprovement { readonly description:string; readonly starterArtifactId:string; readonly submissionArtifactId:string }
export interface UIBindings { readonly reportId:string; readonly reportDigest:string; readonly evaluationId:string; readonly bundleDigest:string; readonly snapshotId:string; readonly treeDigest:string }
export interface UIBaseline { readonly challengeIdentityDigest:string; readonly starterDigest:string; readonly workloadDigest:string }
export interface UIWorksheet { readonly schemaVersion:string; readonly kind:'UIWorksheet'; readonly reviewId:string; readonly reviewer:string; readonly reviewedAt:string; readonly baselineCompared:true; readonly bindings:UIBindings; readonly baseline:UIBaseline; readonly evidence:readonly UIEvidence[]; readonly scores:Readonly<Record<UICategory,number>>; readonly notes:Readonly<Record<UICategory,string>>; readonly improvements:Readonly<Partial<Record<UICategory,UIImprovement>>> }
export declare class UIWorksheetError extends Error { readonly code:'UI_WORKSHEET_INVALID'; constructor(message:string) }
/** Requires an intrinsically valid successful Report; report/C4 errors propagate. No artifact IO. */
export declare function worksheetBindingsOf(report:Report):{readonly bindings:UIBindings; readonly baseline:UIBaseline};
/** Validates worksheet metadata/bindings; UIWorksheetError for worksheet failures, upstream report/C4 errors propagate. Does not open or authenticate evidence. */
export declare function validateUIWorksheet(value:unknown,report:Report):UIWorksheet;
