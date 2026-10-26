import type { LifecycleStateRecord } from '../core/lifecycle.mjs';
import type { SnapshotProof } from '../core/freeze.mjs';
import type { Report } from './report.mjs';
export interface NeutralTokenInput {readonly schemaVersion:'1.0.0';readonly kind:'NeutralTokenInput';readonly sourceId:string;readonly scope:'RUN_TOTAL';readonly inputIncludesCacheReads:true;readonly inputTokens:number|null;readonly outputTokens:number|null;readonly cacheReadTokens:number|null}
export type ReportMeasurementSource = {readonly kind:'lifecycle';readonly digest:string;readonly record:LifecycleStateRecord}|{readonly kind:'snapshot-proof';readonly digest:string;readonly record:SnapshotProof}|{readonly kind:'token-input';readonly digest:string;readonly record:NeutralTokenInput}|{readonly kind:'evaluation';readonly digest:string;readonly recordId:string};
export interface MeasurementProjectionInput {readonly idPrefix:string;readonly timing:{readonly elapsedMs:number|null};readonly tokens:NeutralTokenInput|null;readonly quality:{readonly automated:number|null;readonly humanUI:number|null;readonly quality:number|null}}
export declare class MeasurementIntegrityError extends Error {readonly code:'MEASUREMENT_INTEGRITY';constructor(message:string)}
export declare function validateNeutralTokenInput(value:unknown):NeutralTokenInput|null;
export declare function measurementProjectionInput(report:Pick<Report,'reportId'|'bindings'|'configuration'|'provenance'|'evidence'|'quality'>):MeasurementProjectionInput;
/** Revalidates C1 records and fixed derivations; intrinsic provenance integrity, not source authentication. Upstream C1 validation errors may propagate. */
export declare function validateReportMeasurements(report:Report):void;
