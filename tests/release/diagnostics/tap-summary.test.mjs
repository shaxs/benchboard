// C7a.S11 acceptance tests for the fixed TAP-footer summary contract.
//
// Independently owned contract test: it asserts only the documented public
// behaviour of hasCompleteTapSummary and never reads the helper's source.
// The valid footer is exactly one each of the six unindented hash-count lines
//   # tests 4    # pass 4    # fail 0
//   # cancelled 0   # skipped 0   # todo 0
// with unsigned decimal counts, joined by LF or CRLF. Unrelated TAP lines are
// harmless; malformed, missing, duplicated, partial or trailing-text footer
// lines are refused; non-string inputs return false without throwing. The
// helper's contract is boolean: accepted input yields strictEqual true, and
// every refusal yields strictEqual false.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasCompleteTapSummary } from './tap-summary.mjs';

const REQUIRED_LINES = [
  '# tests 4',
  '# pass 4',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
];

// Field names of the six required footer lines, derived so the case 9b loop and
// REQUIRED_LINES never drift apart. Each line is "# <field> <count>".
const FIELD_NAMES = REQUIRED_LINES.map((line) => line.split(' ')[1]);

/**
 * Builds a footer string from the required lines (or caller-supplied lines),
 * optionally preceded by unrelated TAP lines, joined by `eol` and closed by a
 * final line terminator by default.
 */
function makeFooter({ eol = '\n', prefix = [], lines = REQUIRED_LINES } = {}) {
  return [...prefix, ...lines].join(eol) + eol;
}

/**
 * Replaces exactly one footer line of the valid footer, leaving the rest
 * valid. The target line is the one beginning with `# ${key} ` — the actual
 * Node TAP hash-count footer syntax.
 */
function footerWith(key, replacement) {
  const marker = `# ${key} `;
  const lines = REQUIRED_LINES.map((line) => (line.startsWith(marker) ? replacement : line));
  return makeFooter({ lines });
}

/** Records the call result and whether it threw, without failing on a throw. */
function capture(input) {
  let threw = false;
  let result;
  try {
    result = hasCompleteTapSummary(input);
  } catch {
    threw = true;
  }
  return { threw, result };
}

// Case 1 — valid six-line LF and CRLF footers pass, also when preceded by
// ordinary TAP version/subtest/ok lines. (Only ok children are used here.)
test('case 1: valid six-line footer passes with LF and with CRLF', () => {
  assert.strictEqual(hasCompleteTapSummary(makeFooter()), true, 'LF footer must be accepted');
  assert.strictEqual(
    hasCompleteTapSummary(makeFooter({ eol: '\r\n' })),
    true,
    'CRLF footer must be accepted',
  );
});

test('case 1b: ordinary TAP version/subtest/ok lines before the footer are harmless', () => {
  const prefix = [
    'TAP version 14',
    '1..4',
    '# Subtest: grouping',
    'ok 1 - first',
    'ok 2 - second',
    'ok 3 - third',
    'ok 4 - fourth',
  ];
  assert.strictEqual(
    hasCompleteTapSummary(makeFooter({ prefix })),
    true,
    'LF footer behind ordinary TAP lines must be accepted',
  );
  assert.strictEqual(
    hasCompleteTapSummary(makeFooter({ prefix, eol: '\r\n' })),
    true,
    'CRLF footer behind ordinary TAP lines must be accepted',
  );
});

// Case 2 — empty input, all-zero counts, partial counts and a count mismatch
// between tests and pass all refuse.
test('case 2: empty input, tests=0/pass=0, tests=3/pass=3 and tests=4/pass=3 refuse', () => {
  assert.strictEqual(hasCompleteTapSummary(''), false, 'empty input must refuse');

  const allZeros = makeFooter({
    lines: ['# tests 0', '# pass 0', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'],
  });
  assert.strictEqual(
    hasCompleteTapSummary(allZeros),
    false,
    'tests count 0 with pass count 0 must refuse',
  );

  const partial = makeFooter({
    lines: ['# tests 3', '# pass 3', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'],
  });
  assert.strictEqual(
    hasCompleteTapSummary(partial),
    false,
    'tests count 3 with pass count 3 must refuse',
  );

  const mismatched = makeFooter({
    lines: ['# tests 4', '# pass 3', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'],
  });
  assert.strictEqual(
    hasCompleteTapSummary(mismatched),
    false,
    'tests count 4 with pass count 3 must refuse',
  );
});

// Case 3 — each of fail, cancelled, skipped and todo being 1 refuses, each
// tested separately against an otherwise valid footer.
test('case 3: fail=1, cancelled=1, skipped=1 and todo=1 each refuse', () => {
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) {
    assert.strictEqual(
      hasCompleteTapSummary(footerWith(key, `# ${key} 1`)),
      false,
      `# ${key} 1 must refuse`,
    );
  }
});

// Case 4 — remove each required footer line in turn; every case refuses.
test('case 4: removing each required footer line in turn refuses', () => {
  for (const removed of REQUIRED_LINES) {
    const lines = REQUIRED_LINES.filter((line) => line !== removed);
    assert.strictEqual(
      hasCompleteTapSummary(makeFooter({ lines })),
      false,
      `footer missing "${removed}" must refuse`,
    );
  }
});

// Case 5 — duplicate each required footer line in turn; every case refuses,
// even when the duplicated values are identical.
test('case 5: duplicating each required footer line in turn refuses', () => {
  for (const duplicate of REQUIRED_LINES) {
    const lines = [...REQUIRED_LINES, duplicate];
    assert.strictEqual(
      hasCompleteTapSummary(makeFooter({ lines })),
      false,
      `footer duplicating "${duplicate}" must refuse even with identical values`,
    );
  }
});

// Case 6 — negative counts, nonnumeric counts, trailing junk on a footer line,
// indentation on a required footer with count 4, and a fractional count 4.5
// all refuse.
test('case 6: negative, nonnumeric, trailing-junk, indented and fractional counts refuse', () => {
  const refusals = [
    ['negative required count tests -4', footerWith('tests', '# tests -4')],
    ['negative flag count fail -1', footerWith('fail', '# fail -1')],
    ['nonnumeric count tests abc', footerWith('tests', '# tests abc')],
    ['trailing junk after tests 4', footerWith('tests', '# tests 4 extra')],
    ['indented required footer with count 4', footerWith('tests', '  # tests 4')],
    ['fractional count tests 4.5', footerWith('tests', '# tests 4.5')],
  ];
  for (const [label, input] of refusals) {
    assert.strictEqual(hasCompleteTapSummary(input), false, `${label} must refuse`);
  }
});

// Case 7 — null, undefined, number and object inputs refuse without throwing.
test('case 7: null, undefined, number and object inputs refuse without throwing', () => {
  const inputs = [null, undefined, 4, {}, { tests: 4, pass: 4, fail: 0 }];
  for (const input of inputs) {
    const label = input === null ? 'null' : input === undefined ? 'undefined' : typeof input;
    const { threw, result } = capture(input);
    assert.equal(threw, false, `non-string input (${label}) must not throw`);
    assert.strictEqual(result, false, `non-string input (${label}) must refuse`);
  }
});

// Case 8 — a frozen object input is not mutated by the check, and a valid
// string is unchanged after checking.
test('case 8: frozen object input is not mutated and a valid string stays unchanged', () => {
  const frozen = Object.freeze({ tests: 4, pass: 4, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  const before = { ...frozen };

  hasCompleteTapSummary(frozen);

  assert.ok(Object.isFrozen(frozen), 'input object must still be frozen after the check');
  assert.deepStrictEqual({ ...frozen }, before, 'input object properties must be unchanged');

  const footer = makeFooter();
  const snapshot = footer.slice();
  assert.strictEqual(
    hasCompleteTapSummary(footer),
    true,
    'valid footer string must still be accepted',
  );
  assert.strictEqual(footer, snapshot, 'valid footer string must be unchanged after the check');
});

// Case 9 — appending a malformed top-level candidate line to an otherwise
// fully valid footer refuses, so a malformed or duplicate candidate cannot hide
// alongside a valid line of the same field.
test('case 9: malformed extra top-level lines alongside a valid footer refuse', () => {
  const extras = ['# pass nope', '# tests 4 extra', '# fail -1', '# pass 100.00%', '# cancelled'];
  for (const extra of extras) {
    const input = makeFooter({ lines: [...REQUIRED_LINES, extra] });
    assert.strictEqual(
      hasCompleteTapSummary(input),
      false,
      `appending malformed top-level line "${extra}" must refuse`,
    );
  }
});

// Case 9b — for every footer field, appending a `# <field> junk` line with a
// nonnumeric count to an otherwise fully valid footer refuses.
test('case 9b: a "# <field> junk" line for each footer field alongside a valid footer refuses', () => {
  for (const field of FIELD_NAMES) {
    const extra = `# ${field} junk`;
    const input = makeFooter({ lines: [...REQUIRED_LINES, extra] });
    assert.strictEqual(
      hasCompleteTapSummary(input),
      false,
      `appending malformed top-level line "${extra}" must refuse`,
    );
  }
});

// Case 10 — an unrelated near-miss field name and an indented (top-level only)
// footer-shaped line are harmless next to a fully valid footer.
test('case 10: unrelated "# passed 4" and indented "    # pass 1" lines are harmless', () => {
  const prefix = ['# passed 4', '    # pass 1'];
  assert.strictEqual(
    hasCompleteTapSummary(makeFooter({ prefix })),
    true,
    'near-miss field name and indented footer-shaped line must not disturb a valid footer',
  );
  assert.strictEqual(
    hasCompleteTapSummary(makeFooter({ prefix, eol: '\r\n' })),
    true,
    'the same harmless lines must not disturb a valid CRLF footer',
  );
});
