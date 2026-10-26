/** Typed public surface of packages/results/measurements.mjs: the pure 13-row measurement projection for one frozen run. */
import type { Measurement } from '../core/manifest.mjs';

/** Schema-pinned single run-total token statement. `inputTokens` already includes `cacheReadTokens` (inclusive, never added to the total again); an unknown component is null, never zero. This is one run aggregate, never an actor breakdown, and its fields are the Captain-validated NeutralTokenInput mirrored here as types only (no runtime import of the contract module, which itself imports the projection). */
export interface NeutralTokenInput {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'NeutralTokenInput';
  readonly sourceId: string;
  readonly scope: 'RUN_TOTAL';
  readonly inputIncludesCacheReads: true;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
}

/** Captain-validated projection input: the id prefix, the run's wall-clock timing, the single token total (or null when the run carried no token statement) and the three quality numbers (null when unknown). Known values are finite numbers; a genuine zero is a known value, not an absence. */
export interface MeasurementProjectionInput {
  readonly idPrefix: string;
  readonly timing: { readonly elapsedMs: number | null };
  readonly tokens: NeutralTokenInput | null;
  readonly quality: {
    readonly automated: number | null;
    readonly humanUI: number | null;
    readonly quality: number | null;
  };
}

/** Projects the fixed thirteen C1 Measurements in table order (elapsedWallMs, elapsedWallSeconds, inputTokens, outputTokens, cacheReadTokens, totalTokens, automatedQuality, humanUIQuality, finalQuality, automatedPointsPerThousandTokens, finalPointsPerThousandTokens, qualityPointsPerWallSecond, utilization) from the already-validated input, without mutating it. Each draft passes through validateRecord('Measurement', …) and the returned array is exactly those validated projections with their defaults preserved; a contract refusal propagates unchanged. Unknown values are UNAVAILABLE with null value and null source, never zero. */
export declare function projectMeasurements(input: MeasurementProjectionInput): Measurement[];
