/** Typed public surface of packages/results/comparison-arithmetic.mjs: internal trusted-policy fixed-precision delta arithmetic over prevalidated quality objects, called only by the fixed Captain comparison policy. No eligibility, authentication, identity or privacy claim. */
import type { ExportQuality } from './export-contract.mjs';

/** The closed comparison dispositions produced by the fixed Captain policy. */
type ComparisonDisposition = 'BASELINE' | 'REFUSED' | 'BLOCKED' | 'AUTOMATED_ONLY' | 'REVIEWED';

/** The three descriptive quality deltas; each is a four-decimal-rounded difference or null when no delta is representable. Null is never replaced by zero. */
export interface ComparisonDeltas {
  readonly automated: number | null;
  readonly humanUI: number | null;
  readonly quality: number | null;
}

/**
 * Computes fixed-precision descriptive quality deltas between two prevalidated quality objects. For any mode outside
 * `AUTOMATED_ONLY` and `REVIEWED` (including the nullish or unknown ones) it returns a fresh all-null `ComparisonDeltas`,
 * never converting an unknown delta to zero. For `AUTOMATED_ONLY` it yields `automated` as the four-decimal-rounded
 * candidate-minus-baseline difference with `humanUI` and `quality` left null; `REVIEWED` additionally yields `humanUI`
 * and `quality` with the same subtraction and precision. The quality objects are prevalidated upstream; a missing or
 * null quality object under an allowed mode throws (a `TypeError`), it is never coerced to zero. No policy, identity,
 * eligibility, authentication or privacy check happens here, and no input is mutated.
 */
export declare function projectQualityDeltas(input: {
  readonly mode: ComparisonDisposition;
  readonly baseline: ExportQuality | null;
  readonly candidate: ExportQuality | null;
}): ComparisonDeltas;
