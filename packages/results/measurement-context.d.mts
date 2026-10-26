import type { FrozenSelection } from '../evaluation/evaluate-frozen.mjs';
import type { EvidenceBundle } from '../evaluation/bundle.mjs';
import type { RunManifest } from '../core/manifest.mjs';
import type { ReportBindings, ReportConfiguration } from './report-contract.mjs';
import type { MeasurementProjectionInput, ReportMeasurementSource } from './measurement-contract.mjs';
export interface MeasurementContext {readonly sources:readonly ReportMeasurementSource[];readonly configuration:ReportConfiguration;readonly projection:MeasurementProjectionInput}
/** Captures verified C3 sources through its transaction/storage capability; upstream C3/storage/filesystem errors propagate, own provenance failures use MEASUREMENT_INTEGRITY. */
export declare function buildMeasurementContext(input:{readonly selection:FrozenSelection;readonly manifest:RunManifest;readonly bindings:ReportBindings;readonly bundle:EvidenceBundle|null;readonly metrics:unknown;readonly reportId:string}):Promise<MeasurementContext>;
