// Pure C5 measurement projection: the fixed 13-row set for one frozen run, with no IO and no
// mutation of its input. Rows follow the Captain-fixed table in .ai/tasks/C5.S2.T1.md (corrected:
// a known MEASURED row carries a COMPUTED source kind — the C1 runtime refuses MEASURED paired
// with SELF_ASSESSMENT or LOCAL_PROCEDURE; see the 'needs a local ID, a local digest or a COMPUTED
// source' rule in packages/core/manifest.mjs). Every emitted draft is validated by validateRecord,
// the final authority, and its refusal would surface unchanged.
import { validateRecord } from '../core/manifest.mjs';

const PROCEDURE_MEASURED = 'benchboard-c5-measured-v1';
const PROCEDURE_ENTERED = 'benchboard-c5-entered-v1';
const PROCEDURE_DERIVED = 'benchboard-c5-derived-v1';

/** A genuine numeric zero is known; only a non-finite or non-number value is unknown. Never test
 *  truthiness of a value: 0 is known and stays 0. */
const known = (value) => typeof value === 'number' && Number.isFinite(value);

const unavailable = (idPrefix, metric, unit) => ({
  schemaVersion: '1.0.0',
  kind: 'Measurement',
  measurementId: idPrefix + ':' + metric,
  metric,
  unit,
  measurementKind: 'UNAVAILABLE',
  value: null,
  source: null,
});

const measured = (idPrefix, metric, unit, value) => ({
  schemaVersion: '1.0.0',
  kind: 'Measurement',
  measurementId: idPrefix + ':' + metric,
  metric,
  unit,
  measurementKind: 'MEASURED',
  value,
  source: { kind: 'COMPUTED', procedure: PROCEDURE_MEASURED },
});

const entered = (idPrefix, metric, unit, value) => ({
  schemaVersion: '1.0.0',
  kind: 'Measurement',
  measurementId: idPrefix + ':' + metric,
  metric,
  unit,
  measurementKind: 'ENTERED',
  value,
  source: { kind: 'SELF_ASSESSMENT', procedure: PROCEDURE_ENTERED },
});

const derived = (idPrefix, metric, unit, value, formula) => ({
  schemaVersion: '1.0.0',
  kind: 'Measurement',
  measurementId: idPrefix + ':' + metric,
  metric,
  unit,
  measurementKind: 'DERIVED',
  value,
  source: { kind: 'COMPUTED', procedure: PROCEDURE_DERIVED },
  derivation: formula,
});

/** Known-or-unavailable row pickers: an unknown source value yields the UNAVAILABLE row, never a
 *  fabricated zero and never a numberless "known" row. */
const byValue = (idPrefix, metric, unit, value, kind) =>
  known(value) ? (kind === 'MEASURED' ? measured : entered)(idPrefix, metric, unit, value)
    : unavailable(idPrefix, metric, unit);
const bySum = (idPrefix, metric, unit, a, b, formula) =>
  known(a) && known(b) ? derived(idPrefix, metric, unit, a + b, formula)
    : unavailable(idPrefix, metric, unit);
const byRate = (idPrefix, metric, unit, numerator, denominator, formula, scale = 1) =>
  known(numerator) && known(denominator) && denominator > 0
    ? derived(idPrefix, metric, unit, (numerator * scale) / denominator, formula)
    : unavailable(idPrefix, metric, unit);

/**
 * Projects the fixed 13 measurements for one run from Captain-validated input:
 * `{ idPrefix, timing: { elapsedMs }, tokens: NeutralTokenInput | null,
 *    quality: { automated, humanUI, quality } }`.
 * Token input is one RUN_TOTAL aggregate whose input already includes cache reads; it is never an
 * actor list and never carries a second total. Input is read only, never mutated. Each draft goes
 * through validateRecord('Measurement', …), so the returned array is exactly the validated C1
 * projections (their defaults preserved) and any contract refusal propagates unchanged.
 */
export function projectMeasurements(input) {
  const { idPrefix, timing, tokens, quality } = input;
  const elapsedMs = timing?.elapsedMs ?? null;
  const inputTokens = tokens?.inputTokens ?? null;
  const outputTokens = tokens?.outputTokens ?? null;
  const cacheReadTokens = tokens?.cacheReadTokens ?? null;
  const automated = quality?.automated ?? null;
  const humanUI = quality?.humanUI ?? null;
  const qualityTotal = quality?.quality ?? null;

  const elapsedWallMs = known(elapsedMs) ? measured(idPrefix, 'elapsedWallMs', 'ms', elapsedMs)
    : unavailable(idPrefix, 'elapsedWallMs', 'ms');
  const elapsedWallSeconds = known(elapsedMs)
    ? derived(idPrefix, 'elapsedWallSeconds', 's', elapsedMs / 1000, '{elapsedWallMs} / 1000')
    : unavailable(idPrefix, 'elapsedWallSeconds', 's');
  const inputTokensRow = byValue(idPrefix, 'inputTokens', 'tokens', inputTokens, 'ENTERED');
  const outputTokensRow = byValue(idPrefix, 'outputTokens', 'tokens', outputTokens, 'ENTERED');
  const cacheReadTokensRow = byValue(idPrefix, 'cacheReadTokens', 'tokens', cacheReadTokens, 'ENTERED');
  // Total tokens adds input and output only when both are known. Cache reads are never added:
  // they are already inside input, so adding them would double count.
  const totalTokens = bySum(idPrefix, 'totalTokens', 'tokens', inputTokens, outputTokens,
    '{inputTokens} + {outputTokens}');
  const automatedRow = byValue(idPrefix, 'automatedQuality', 'points', automated, 'MEASURED');
  const humanUIRow = byValue(idPrefix, 'humanUIQuality', 'points', humanUI, 'ENTERED');
  // Final quality is the recomputed sum of the two known components, never the caller's total: the
  // condition still requires all three values known, but a mismatched supplied total can no longer
  // make the row claim a different sum than the formula it names. The sum carries the unchanged
  // scorer's four-decimal score precision (evaluator/score.mjs toFixed(4)), so a binary floating
  // tail such as 12.9231 + 4 becoming 16.923099999999998 rounds back to the scorer's 16.9231.
  const finalQuality = known(automated) && known(humanUI) && known(qualityTotal)
    ? derived(idPrefix, 'finalQuality', 'points', Number((automated + humanUI).toFixed(4)),
        '{automatedQuality} + {humanUIQuality}')
    : unavailable(idPrefix, 'finalQuality', 'points');
  const automatedPointsPerThousandTokens = byRate(idPrefix, 'automatedPointsPerThousandTokens',
    'ratio', automated, totalTokens.value, '{automatedQuality} * 1000 / {totalTokens}', 1000);
  // Both final efficiencies take their numerator from the projected finalQuality row itself: a
  // supplied total never resurrects a final quality whose components are incomplete, so an
  // UNAVAILABLE final quality (null value) keeps both rates UNAVAILABLE too.
  const finalPointsPerThousandTokens = byRate(idPrefix, 'finalPointsPerThousandTokens',
    'ratio', finalQuality.value, totalTokens.value, '{finalQuality} * 1000 / {totalTokens}', 1000);
  const pointsPerWallSecond = byRate(idPrefix, 'qualityPointsPerWallSecond',
    'ratio', finalQuality.value, elapsedWallSeconds.value, '{finalQuality} / {elapsedWallSeconds}');

  const drafts = [
    elapsedWallMs,
    elapsedWallSeconds,
    inputTokensRow,
    outputTokensRow,
    cacheReadTokensRow,
    totalTokens,
    automatedRow,
    humanUIRow,
    finalQuality,
    automatedPointsPerThousandTokens,
    finalPointsPerThousandTokens,
    pointsPerWallSecond,
    // C5 has no complete interval denominator, so utilization is honestly unavailable, never zero.
    unavailable(idPrefix, 'utilization', 'ratio'),
  ];
  return drafts.map((draft) => validateRecord('Measurement', draft));
}
