/**
 * `cli/export-arguments.mjs` — pure selector mapping of the parsed `export`
 * flags (C6.S8).
 *
 * `exportArgumentsOf(options)` takes the frozen `options` map produced by the
 * outer parser (`parseArguments`) and projects it into the export selector
 * `{ evaluationId, reportId, output }`:
 *
 *   - `--evaluation` is required and must match the safe identifier pattern;
 *   - `--report` is optional; when absent the `reportId` key is present with
 *     the value `undefined`, and there is no implicit "latest" child and no
 *     guessed report identifier;
 *   - `--output` is required and must be a nonblank string, kept exactly as
 *     given.
 *
 * The projection is pure: no filesystem, process, environment, clock or command
 * execution, and the only import is `ArgumentError` from `cli/arguments.mjs`.
 * It performs no path containment and no path normalization, and it makes no
 * claim that a path is safe or that a supplied report belongs to a supplied
 * evaluation — those decisions belong to the caller (the committed baseline and
 * child resolution and the output privacy boundary). It rejects missing or
 * malformed selector fields before any state is read, raising `ArgumentError`
 * with the fixed `INVALID_VALUE` message, which never contains caller data.
 *
 * Absence of a flag is judged with `Object.hasOwn` on the supplied map, not by
 * truthiness and not through the prototype chain: a key that is present with
 * an `undefined` value counts as a supplied flag and is refused. The returned
 * object is frozen and carries exactly the three documented keys; no `--run`
 * value and no other extra key is copied into it. The outer parser owns the
 * required `--run` flag and unknown-flag rejection.
 */

import { ArgumentError } from "./arguments.mjs";

// Closed parser error code (value of ARGUMENT_ERROR_CODES in arguments.mjs).
const INVALID_VALUE = "INVALID_VALUE";

// A safe selector identifier: a letter followed by two to one hundred twenty
// seven letters, digits, dots, underscores or dashes (three to one hundred
// twenty eight characters in total).
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{2,127}$/;

function invalidValue() {
  return new ArgumentError(INVALID_VALUE);
}

// A supplied, nonblank string kept exactly as given (never trimmed).
function nonblankString(options, key) {
  if (!Object.hasOwn(options, key)) throw invalidValue();
  const value = options[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidValue();
  }
  return value;
}

// A supplied selector identifier checked against the safe pattern.
function safeIdentifier(options, key) {
  const value = nonblankString(options, key);
  if (!SAFE_IDENTIFIER.test(value)) throw invalidValue();
  return value;
}

/**
 * Project the parsed `export` command options into the frozen selector
 * `{ evaluationId, reportId, output }`.
 *
 * A key that is present with an `undefined` value counts as supplied (the
 * check is `Object.hasOwn`), so such a map is refused. Any missing required
 * flag, blank or nonstring required value, or selector that fails the safe
 * identifier pattern raises `ArgumentError` with the fixed `INVALID_VALUE`
 * message. An absent `--report` yields `reportId: undefined`; there is no
 * default to a latest child. Paths are kept exactly as supplied; nothing is
 * normalized, and no path-safety or report-association claim is made here.
 */
export function exportArgumentsOf(options) {
  if (options === null || typeof options !== "object") throw invalidValue();
  return Object.freeze({
    evaluationId: safeIdentifier(options, "--evaluation"),
    reportId: Object.hasOwn(options, "--report")
      ? safeIdentifier(options, "--report")
      : undefined,
    output: nonblankString(options, "--output"),
  });
}
