/* TAP footer-completeness check — a release-test support helper.
 *
 * This is a support module, not a test file and not a product change. It
 * exports one pure function that answers a single yes-or-no question about a
 * captured TAP stream: does it carry the complete, exact summary footer that
 * the diagnostic driver's four-test selection must produce?
 *
 * The accepted footer, for each of the fields tests, pass, fail, cancelled,
 * skipped and todo, is exactly one unindented top-level line of the shape
 * `# <field> <unsigned decimal integer>`: a leading `# `, the field name, one
 * space, a non-negative decimal number, then the end of that line. Lines may
 * end with LF or CRLF. The expected counts are tests=4 and pass=4 with every
 * other field 0.
 *
 * Refusals, in order of recognition. First, for each field, the top-level
 * candidate lines are found: unindented lines that begin with `# <field>`
 * followed by whitespace or the end of the line. There must be exactly one
 * candidate; a duplicate field name is a refusal, and so is a malformed
 * candidate line — one that names the field but does not carry the exact count
 * syntax `# <field> <unsigned decimal integer>` end to end, for example
 * `# pass nope`, `# pass 100.00%`, `# tests 4 extra` or `# fail -1`. No shape
 * of candidate text (percentage, trailing words, a sign, anything else) is
 * excepted: a malformed candidate refuses even beside a correct line for the
 * same field. A single valid-syntax candidate whose count differs from the
 * expected one also refuses.
 *
 * A line that is not a candidate for any field is unrelated and harmless: the
 * plan line `1..4`, an indented `# tests …` inside a subtest block, a name
 * such as `# passed 4` that is not one of the six field names, or any other
 * text elsewhere in the stream.
 *
 * The function accepts a string and returns a boolean. For a non-string
 * input it returns false rather than throwing. It never mutates its input,
 * uses no dependencies beyond the JavaScript standard library, and prints
 * nothing.
 */

/** The six summary fields the footer must carry, each exactly once. */
const FOOTER_FIELDS = Object.freeze(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']);

/** The fixed expected counts: the four selected tests all pass, nothing else. */
const EXPECTED_COUNTS = Object.freeze({
  tests: '4',
  pass: '4',
  fail: '0',
  cancelled: '0',
  skipped: '0',
  todo: '0',
});

/**
 * Two anchored patterns per field, each matched against one split-off line.
 * The candidate pattern recognises a top-level footer candidate: `^` plus a
 * literal `# ` means no indentation is accepted, and the field name must be
 * followed by whitespace or the end of the line, so a longer name that merely
 * starts with the field (for example `# passed 4`) is not a candidate and
 * `# tests4` is not one either. The count pattern then demands the whole
 * candidate be the exact count line: one space, a plain unsigned decimal
 * integer without leading zeros (so a negative, a leading-zero, a fractional
 * or a nonnumeric value never matches), and end of line, so any trailing text
 * keeps it from matching. A candidate the count pattern refuses is malformed
 * and refuses the stream on its own.
 */
const FOOTER_PATTERNS = Object.freeze(
  Object.fromEntries(
    FOOTER_FIELDS.map((field) => [
      field,
      Object.freeze({
        candidate: new RegExp(`^# ${field}(?:[ \\t]|$)`),
        count: new RegExp(`^# ${field} (0|[1-9][0-9]*)$`),
      }),
    ]),
  ),
);

/**
 * True when stdout is a string whose complete TAP summary footer is present
 * and exact — for all six fields, exactly one unindented top-level candidate
 * line each, and that candidate carrying the expected count in the exact
 * count syntax — and false for every other input. A malformed candidate
 * refuses even alongside a valid line. See the header for the full rules.
 */
export function hasCompleteTapSummary(stdout) {
  if (typeof stdout !== 'string') return false;

  // CRLF and LF are both line ends; splitting changes nothing and leaves a
  // trailing empty entry after a final newline, which is no candidate.
  const lines = stdout.split(/\r?\n/);

  for (const field of FOOTER_FIELDS) {
    const { candidate, count } = FOOTER_PATTERNS[field];
    const expected = EXPECTED_COUNTS[field];
    let seen = 0;
    for (const line of lines) {
      if (candidate.exec(line) === null) continue; // unrelated line
      seen += 1;
      // More than one candidate for one field is a refusal, not a tie-break.
      // This also catches a malformed line sitting beside a valid one.
      if (seen > 1) return false;
      const match = count.exec(line);
      // A lone candidate must itself be the exact count line; a malformed
      // shape (percentage, trailing words, sign, nonnumber) refuses here.
      if (match === null) return false;
      // The number must equal the expected count digit for digit.
      if (match[1] !== expected) return false;
    }
    // No candidate at all for a required field is a refusal.
    if (seen !== 1) return false;
  }

  return true;
}
