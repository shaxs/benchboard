/**
 * `cli/ui-arguments.mjs` — pure route mapping of the parsed `ui` flags (C6.S7).
 *
 * `uiArgumentsOf(options)` takes the frozen `options` map produced by the outer
 * parser (`parseArguments`) and projects it into one of two mutually exclusive
 * routes for the `ui` command:
 *
 *   - a template route — `{ mode: 'template', output, evaluationId, reportId }`,
 *     when `--template` is true, a nonblank `--output` is supplied, and at least
 *     one of `--evaluation` / `--report` is supplied as a safe identifier;
 *   - an attach route — `{ mode: 'attach', input, reviewRoot }`, when `--template`
 *     is absent and both `--input` and `--review-root` are supplied as nonblank
 *     strings, with none of `--output` / `--evaluation` / `--report` supplied.
 *
 * The projection is pure: no filesystem, process, environment, clock or command
 * execution, and the only import is `ArgumentError` from `cli/arguments.mjs`. It
 * performs no path containment and no path normalization; those decisions belong
 * to the caller after state reads. It rejects contradictory or missing mode
 * fields before any state is read, raising `ArgumentError` with the fixed
 * `INVALID_VALUE` message, which never contains caller data.
 *
 * Absence of a flag is judged with `Object.hasOwn` on the supplied map, not by
 * truthiness and not through the prototype chain: a key that is present with an
 * `undefined` value counts as a supplied flag. Returned objects are frozen and
 * carry exactly the documented keys; no `--run` value and no other extra key is
 * copied into them.
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
 * Project the parsed `ui` command options into the template route
 * `{ mode: 'template', output, evaluationId, reportId }` or the attach route
 * `{ mode: 'attach', input, reviewRoot }`. Both returned objects are frozen.
 *
 * A key that is present with an `undefined` value counts as supplied (the check
 * is `Object.hasOwn`), so such a map is refused. Any contradictory combination
 * (a forbidden flag for the chosen route, `--template` supplied with a value
 * other than true on a non-template route, a missing required flag, a blank or
 * nonstring required value, or a selector that fails the safe identifier
 * pattern) raises `ArgumentError` with the fixed `INVALID_VALUE` message. Paths
 * are kept exactly as supplied; nothing is normalized.
 */
export function uiArgumentsOf(options) {
  if (options === null || typeof options !== "object") throw invalidValue();

  if (Object.hasOwn(options, "--template")) {
    if (options["--template"] !== true) throw invalidValue();
    for (const key of ["--input", "--review-root"]) {
      if (Object.hasOwn(options, key)) throw invalidValue();
    }
    const hasEvaluation = Object.hasOwn(options, "--evaluation");
    const hasReport = Object.hasOwn(options, "--report");
    if (!hasEvaluation && !hasReport) throw invalidValue();
    return Object.freeze({
      mode: "template",
      output: nonblankString(options, "--output"),
      evaluationId: hasEvaluation
        ? safeIdentifier(options, "--evaluation")
        : undefined,
      reportId: hasReport ? safeIdentifier(options, "--report") : undefined,
    });
  }

  for (const key of ["--output", "--evaluation", "--report"]) {
    if (Object.hasOwn(options, key)) throw invalidValue();
  }
  return Object.freeze({
    mode: "attach",
    input: nonblankString(options, "--input"),
    reviewRoot: nonblankString(options, "--review-root"),
  });
}
