/**
 * `cli/evaluation-arguments.mjs` — pure projection of evaluation bound flags
 * (C6.S6.T1).
 *
 * `evaluationArgumentsOf(options)` takes the frozen `options` map produced by
 * the outer parser (`parseArguments`) and projects the two numeric bound flags
 * into the shape the evaluation staging layer consumes as request fields
 * (`timeoutMs`, `maxOutputBytes` in `packages/evaluation/staging.mjs`).
 *
 * The projection is pure: no filesystem, process, environment, clock or command
 * execution, and no imports beyond `ArgumentError` from `cli/arguments.mjs`.
 *
 * Only supplied fields appear in the result. An absent flag is omitted
 * entirely, so the accepted C4 defaults inside the staging layer remain the
 * authority for anything the caller did not state. Nothing is inferred from
 * configuration, environment or host values.
 *
 * Accepted numeric text is parsed to an exact safe integer. Returned objects
 * are frozen. Error messages are fixed and never echo caller input.
 *
 * This module proves only that stated numbers were restated faithfully. It
 * does not start an evaluation, prove bounds were enforced by any controller,
 * or perform any browser or cancellation behaviour.
 */

import { ArgumentError } from './arguments.mjs';

// Closed parser error codes (values of ARGUMENT_ERROR_CODES in arguments.mjs).
const INVALID_VALUE = 'INVALID_VALUE';

// Numeric flags accept only plain positive decimal integers with no sign,
// decimal point, exponent, whitespace or hexadecimal spelling, and only when
// the parsed number is a safe integer.
const NUMERIC_PATTERN = /^[1-9][0-9]*$/;

// Bounds mirror `validateEvaluationRequest` in `packages/evaluation/staging.mjs`
// (lines 96-98): timeoutMs 1..3600000, maxOutputBytes 256..16777216. The CLI
// refuses out-of-range values early rather than letting the staging layer
// reject them later.
const TIMEOUT_MIN_MS = 1;
const TIMEOUT_MAX_MS = 3600000;
const OUTPUT_MIN_BYTES = 256;
const OUTPUT_MAX_BYTES = 16777216;

/**
 * Parse a supplied flag value against a closed inclusive numeric range. A
 * supplied value that is not a plain positive decimal integer string, is not
 * a safe integer, or falls outside `min..max` is refused with INVALID_VALUE
 * and a fixed message that never echoes the value.
 */
function parseBoundedInteger(value, { min, max }) {
  if (typeof value !== 'string' || !NUMERIC_PATTERN.test(value)) {
    throw new ArgumentError(INVALID_VALUE);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ArgumentError(INVALID_VALUE);
  }
  return parsed;
}

/**
 * Project the supplied evaluation bound flags into `{ timeoutMs?, maxOutputBytes? }`.
 * A key absent from `options` is omitted from the result so the staging
 * defaults stay authoritative. A key that is present carries its value through
 * the bounded-integer check above; a present key whose value is `null`,
 * `undefined` or any nonstring is INVALID_VALUE. The returned object is frozen
 * and carries only the supplied keys.
 */
export function evaluationArgumentsOf(options) {
  const result = {};
  if (Object.hasOwn(options, '--timeout-ms')) {
    result.timeoutMs = parseBoundedInteger(options['--timeout-ms'], {
      min: TIMEOUT_MIN_MS,
      max: TIMEOUT_MAX_MS,
    });
  }
  if (Object.hasOwn(options, '--max-output-bytes')) {
    result.maxOutputBytes = parseBoundedInteger(options['--max-output-bytes'], {
      min: OUTPUT_MIN_BYTES,
      max: OUTPUT_MAX_BYTES,
    });
  }
  return Object.freeze(result);
}
