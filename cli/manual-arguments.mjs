/**
 * `cli/manual-arguments.mjs` — pure projection of parsed manual lifecycle flags (C6.S4).
 *
 * `startDeclarationOf(options)` and `stopAttestationOf(options)` take the frozen
 * `options` map produced by the outer parser (`parseArguments`) and project it
 * into the stated declaration shapes. Both projections are pure: no filesystem,
 * process, environment, clock or command execution, and no imports beyond
 * `ArgumentError` from `cli/arguments.mjs`.
 *
 * They neither start nor stop an agent, and they do not prove that a lifecycle
 * gate accepted anything; they only restate what the caller already declared on
 * the command line. Unknown stated facts are `null`, never `0` or an inference.
 * Returned objects are frozen and carry exactly the documented keys. Error
 * messages never echo caller input.
 */

import { ArgumentError } from './arguments.mjs';

// Closed parser error codes (values of ARGUMENT_ERROR_CODES in arguments.mjs).
const INVALID_VALUE = 'INVALID_VALUE';
const MISSING_OPTION = 'MISSING_OPTION';

// Numeric flags accept only plain positive decimal integers that are safe
// integers; the ceiling additionally stays within one day (1440 minutes).
const NUMERIC_PATTERN = /^[1-9][0-9]*$/;
const MAX_CEILING_MINUTES = 1440;

// String bounds mirror the C3 declaration and attestation validators
// (`packages/core/lifecycle-internal.mjs`), which check `string.length` on the
// untrimmed text: harness 1..128, model 1..512, operator 2..256.
const HARNESS_MAX_LENGTH = 128;
const MODEL_MAX_LENGTH = 512;
const OPERATOR_MIN_LENGTH = 2;
const OPERATOR_MAX_LENGTH = 256;

function parsePositiveInteger(value, { max }) {
  if (typeof value !== 'string' || !NUMERIC_PATTERN.test(value)) {
    throw new ArgumentError(INVALID_VALUE);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new ArgumentError(INVALID_VALUE);
  }
  return parsed;
}

/**
 * Project a stated string flag against a closed length bound, mirroring the
 * C3 validators' untrimmed `string.length` checks. Absent or explicitly
 * supplied `null` stays `null` (unknown); a supplied value that is not a
 * string, or a string outside `1..max`, is refused with INVALID_VALUE without
 * echoing the value. The text is preserved exactly; nothing is trimmed.
 */
function statedStringOrNull(options, key, { max }) {
  if (!Object.hasOwn(options, key)) return null;
  const value = options[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ArgumentError(INVALID_VALUE);
  }
  return value;
}

/**
 * Project the manual `start` declaration flags into
 * `{ harness, model, workerCount, executionMode, declaredCeilingMinutes }`.
 * Absent flags are `null`; an explicitly supplied `null`/`undefined` harness
 * or model stays `null` (unknown), matching the C3 validators. A supplied
 * harness outside 1..128 or model outside 1..512 characters (untrimmed length),
 * a nonstring, or an empty string is refused with INVALID_VALUE. Supplied
 * numeric flags are validated; ceiling is capped at 1440. Accepted text is
 * preserved exactly; nothing is trimmed.
 */
export function startDeclarationOf(options) {
  const workerCount = Object.hasOwn(options, '--worker-count')
    ? parsePositiveInteger(options['--worker-count'], { max: Number.MAX_SAFE_INTEGER })
    : null;
  const declaredCeilingMinutes = Object.hasOwn(options, '--declared-ceiling-minutes')
    ? parsePositiveInteger(options['--declared-ceiling-minutes'], { max: MAX_CEILING_MINUTES })
    : null;
  return Object.freeze({
    harness: statedStringOrNull(options, '--harness', { max: HARNESS_MAX_LENGTH }),
    model: statedStringOrNull(options, '--model', { max: MODEL_MAX_LENGTH }),
    workerCount,
    executionMode: 'MANUAL',
    declaredCeilingMinutes,
  });
}

/**
 * Project the manual `stop` attestation flags into
 * `{ operator, agentStopped, statement }`. A genuinely missing operator, or a
 * missing or non-true `--agents-stopped`, is MISSING_OPTION. A supplied
 * operator that is not a string or falls outside 2..256 characters (untrimmed)
 * is INVALID_VALUE; the operator text is kept exactly and never trimmed.
 */
export function stopAttestationOf(options) {
  const operator = Object.hasOwn(options, '--operator') ? options['--operator'] : undefined;
  const agentsStopped = Object.hasOwn(options, '--agents-stopped')
    ? options['--agents-stopped']
    : undefined;
  if (operator === undefined || agentsStopped !== true) {
    throw new ArgumentError(MISSING_OPTION);
  }
  if (typeof operator !== 'string'
    || operator.length < OPERATOR_MIN_LENGTH
    || operator.length > OPERATOR_MAX_LENGTH) {
    throw new ArgumentError(INVALID_VALUE);
  }
  return Object.freeze({
    operator,
    agentStopped: true,
    statement: 'The operator attests all participant agents have stopped; BenchBoard did not stop them.',
  });
}
