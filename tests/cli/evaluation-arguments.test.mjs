// Unit tests for `cli/evaluation-arguments.mjs` (C6.S6.T1).
//
// This is pure input-projection evidence only: it proves how supplied numeric
// bound flags are restated or refused. It does not start an evaluation, prove
// that any controller enforced a bound, or show browser or cancellation
// behaviour.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ArgumentError } from '../../cli/arguments.mjs';
import { evaluationArgumentsOf } from '../../cli/evaluation-arguments.mjs';

// ---------------------------------------------------------------------------
// Absence: the accepted C4 defaults stay the authority
// ---------------------------------------------------------------------------

test('empty map produces a frozen empty object', () => {
  const out = evaluationArgumentsOf({});
  assert.deepEqual(out, {});
  assert.equal(Object.isFrozen(out), true);
});

test('absent flags are omitted entirely so C4 defaults remain authority', () => {
  const timeoutOnly = evaluationArgumentsOf({ '--timeout-ms': '5000' });
  assert.deepEqual(Object.keys(timeoutOnly), ['timeoutMs']);
  assert.equal('maxOutputBytes' in timeoutOnly, false);

  const outputOnly = evaluationArgumentsOf({ '--max-output-bytes': '4096' });
  assert.deepEqual(Object.keys(outputOnly), ['maxOutputBytes']);
  assert.equal('timeoutMs' in outputOnly, false);
});

test('unrelated keys in the map are not projected', () => {
  const out = evaluationArgumentsOf({ '--run': 'C:\\somewhere', '--help': false });
  assert.deepEqual(out, {});
});

// ---------------------------------------------------------------------------
// Supplied values: exact numeric restatement
// ---------------------------------------------------------------------------

test('supplied values combine exactly with no extra keys', () => {
  const out = evaluationArgumentsOf({
    '--timeout-ms': '300000',
    '--max-output-bytes': '1048576',
  });
  assert.deepEqual(Object.keys(out).sort(), ['maxOutputBytes', 'timeoutMs']);
  assert.equal(out.timeoutMs, 300000);
  assert.equal(out.maxOutputBytes, 1048576);
  assert.equal(Object.isFrozen(out), true);
});

test('result objects are frozen against mutation', () => {
  const out = evaluationArgumentsOf({ '--timeout-ms': '1' });
  assert.throws(() => {
    Object.defineProperty(out, 'timeoutMs', { value: 2 });
  }, TypeError);
});

// ---------------------------------------------------------------------------
// Inclusive boundaries (check 2)
// ---------------------------------------------------------------------------

test('timeout boundaries: 1 and 3600000 pass, 0 and 3600001 fail', () => {
  assert.equal(evaluationArgumentsOf({ '--timeout-ms': '1' }).timeoutMs, 1);
  assert.equal(evaluationArgumentsOf({ '--timeout-ms': '3600000' }).timeoutMs, 3600000);
  for (const bad of ['0', '3600001']) {
    assert.throws(
      () => evaluationArgumentsOf({ '--timeout-ms': bad }),
      (error) => error instanceof ArgumentError && error.code === 'INVALID_VALUE',
      `expected ${bad} to be refused`,
    );
  }
});

test('output boundaries: 256 and 16777216 pass, 255 and 16777217 fail', () => {
  assert.equal(
    evaluationArgumentsOf({ '--max-output-bytes': '256' }).maxOutputBytes, 256,
  );
  assert.equal(
    evaluationArgumentsOf({ '--max-output-bytes': '16777216' }).maxOutputBytes, 16777216,
  );
  for (const bad of ['255', '16777217']) {
    assert.throws(
      () => evaluationArgumentsOf({ '--max-output-bytes': bad }),
      (error) => error instanceof ArgumentError && error.code === 'INVALID_VALUE',
      `expected ${bad} to be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// Grammar rejections (checks 1 and 2): decimal, exponent, sign, whitespace,
// hex, unsafe integer, nonstring, empty, overflow — every one INVALID_VALUE
// ---------------------------------------------------------------------------

const MALFORMED = [
  '001',      // leading zero
  '0',        // zero
  '+1',       // explicit sign
  '-1',       // negative
  '1.5',      // decimal point
  '1e3',      // exponent
  ' 1',       // leading whitespace
  '1 ',       // trailing whitespace
  '0x10',     // hexadecimal
  '',         // empty
  '١٢',       // non-ASCII digits
  '9007199254740993',          // beyond Number.MAX_SAFE_INTEGER
  '99999999999999999999',      // far overflow
];
const NONSTRINGS = [7, 3.5, null, undefined, true, false, {}, [], Symbol('canary')];

for (const value of MALFORMED) {
  test(`malformed timeout text is refused without echo: ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => evaluationArgumentsOf({ '--timeout-ms': value }),
      (error) => error instanceof ArgumentError && error.code === 'INVALID_VALUE',
    );
    assert.throws(
      () => evaluationArgumentsOf({ '--max-output-bytes': value }),
      (error) => error instanceof ArgumentError && error.code === 'INVALID_VALUE',
    );
  });
}

for (const value of NONSTRINGS) {
  const label = typeof value === 'symbol' ? 'Symbol' : JSON.stringify(value);
  test(`nonstring timeout value is refused: ${label}`, () => {
    assert.throws(
      () => evaluationArgumentsOf({ '--timeout-ms': value }),
      (error) => error instanceof ArgumentError && error.code === 'INVALID_VALUE',
    );
  });
  test(`nonstring output value is refused: ${label}`, () => {
    assert.throws(
      () => evaluationArgumentsOf({ '--max-output-bytes': value }),
      (error) => error instanceof ArgumentError && error.code === 'INVALID_VALUE',
    );
  });
}

test('own property with undefined value is invalid; absence omits', () => {
  // An own key carrying undefined was "supplied" by the caller and is refused.
  assert.throws(
    () => evaluationArgumentsOf({ '--timeout-ms': undefined }),
    (error) => error instanceof ArgumentError && error.code === 'INVALID_VALUE',
  );
  // A key that is not an own property at all is absence, not an error.
  const proto = { '--timeout-ms': '10' };
  const viaProto = Object.create(proto);
  assert.deepEqual(evaluationArgumentsOf(viaProto), {});
});

// ---------------------------------------------------------------------------
// No echo: error messages are fixed and never carry caller data
// ---------------------------------------------------------------------------

test('error messages never contain canary input', () => {
  const canaries = [
    ['--timeout-ms', `9${'9'.repeat(40)}CANARY`],
    ['--timeout-ms', 'CANARY'],
    ['--max-output-bytes', `9${'9'.repeat(40)}CANARY`],
    ['--max-output-bytes', 'CANARY'],
  ];
  for (const [key, value] of canaries) {
    try {
      evaluationArgumentsOf({ [key]: value });
      assert.fail('expected throw');
    } catch (error) {
      assert.ok(error instanceof ArgumentError, 'must be a controlled ArgumentError');
      assert.equal(error.code, 'INVALID_VALUE');
      assert.equal(error.message.includes('CANARY'), false, 'message must not echo the value');
    }
  }
});

// ---------------------------------------------------------------------------
// Purity: no side effects
// ---------------------------------------------------------------------------

test('projection is pure: same input, equal output, no mutation of input', () => {
  const input = Object.freeze({ '--timeout-ms': '4321', '--max-output-bytes': '9999' });
  const first = evaluationArgumentsOf(input);
  const second = evaluationArgumentsOf(input);
  assert.deepEqual(first, second);
  assert.notEqual(first, second, 'fresh object per call');
  assert.equal(input['--timeout-ms'], '4321', 'input map untouched');
});
