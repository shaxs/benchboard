// Unit tests for `cli/manual-arguments.mjs` (C6.S4.T2).
//
// This is pure input-projection evidence only: it proves how the declared
// flags map, not that a lifecycle gate accepted anything or that any agent
// started or stopped.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ArgumentError } from '../../cli/arguments.mjs';
import { startDeclarationOf, stopAttestationOf } from '../../cli/manual-arguments.mjs';

test('start: absent flags produce four explicit nulls plus MANUAL', () => {
  assert.deepEqual(startDeclarationOf({}), {
    harness: null,
    model: null,
    workerCount: null,
    executionMode: 'MANUAL',
    declaredCeilingMinutes: null,
  });
});

test('start: stated fields preserve exact text and numeric values', () => {
  const out = startDeclarationOf({
    '--harness': 'my harness label',
    '--model': '  kept-as-is  ',
    '--worker-count': '3',
    '--declared-ceiling-minutes': '240',
  });
  assert.equal(out.harness, 'my harness label');
  assert.equal(out.model, '  kept-as-is  ');
  assert.equal(out.workerCount, 3);
  assert.equal(out.executionMode, 'MANUAL');
  assert.equal(out.declaredCeilingMinutes, 240);
});

test('start: explicit null harness/model stay null (unknown), as in C3', () => {
  const out = startDeclarationOf({ '--harness': null, '--model': null });
  assert.equal(out.harness, null);
  assert.equal(out.model, null);
});

test('start: harness boundary 1..128 (untrimmed), model 1..512', () => {
  assert.equal(startDeclarationOf({ '--harness': 'h'.repeat(1) }).harness, 'h'.repeat(1));
  assert.equal(startDeclarationOf({ '--harness': 'h'.repeat(128) }).harness, 'h'.repeat(128));
  assert.equal(startDeclarationOf({ '--model': 'm'.repeat(512) }).model, 'm'.repeat(512));
});

const BAD_START_STRINGS = [
  ['--harness', 'h'.repeat(129)],
  ['--harness', ''],
  ['--harness', 7],
  ['--model', 'm'.repeat(513)],
  ['--model', ''],
  ['--model', {}],
];
for (const [key, value] of BAD_START_STRINGS) {
  test(`start: supplied bad ${key} value is refused as INVALID_VALUE without echo`, () => {
    try {
      startDeclarationOf({ [key]: value });
      assert.fail('expected throw');
    } catch (error) {
      assert.ok(error instanceof ArgumentError, 'must be a controlled ArgumentError');
      assert.equal(error.code, 'INVALID_VALUE');
      if (typeof value === 'string' && value.length > 0) {
        assert.equal(error.message.includes(value), false, 'message must not echo the value');
      }
    }
  });
}

test('start: error messages never contain canary string text', () => {
  const over = { '--harness': 128, '--model': 512 };
  for (const [key, max] of Object.entries(over)) {
    try {
      startDeclarationOf({ [key]: `${'x'.repeat(max + 1)}CANARY` });
      assert.fail('expected throw');
    } catch (error) {
      assert.equal(error.message.includes('CANARY'), false);
    }
  }
});

test('start: worker count accepts boundary safe integer string', () => {
  assert.equal(
    startDeclarationOf({ '--worker-count': String(Number.MAX_SAFE_INTEGER) }).workerCount,
    Number.MAX_SAFE_INTEGER,
  );
});

const BAD_WORKER_VALUES = ['0', '-1', '1.5', '1e2', '+2', ' 2', '2 ', '', '01', 'NaN'];
for (const value of BAD_WORKER_VALUES) {
  test(`start: worker count "${value.replace(/\s/g, '·')}" is refused without echoing input`, () => {
    try {
      startDeclarationOf({ '--worker-count': value });
      assert.fail('expected throw');
    } catch (error) {
      assert.ok(error instanceof ArgumentError, 'must be a controlled ArgumentError');
      if (String(value).length > 0) {
        assert.equal(error.message.includes(String(value)), false, 'message must not echo the value');
      }
    }
  });
}

test('start: unsafe integer string (2^53) is refused', () => {
  assert.throws(
    () => startDeclarationOf({ '--worker-count': '9007199254740993' }),
    (error) => error instanceof ArgumentError && error.code === 'INVALID_VALUE',
  );
});

test('start: ceiling rejects 0 and 1441, accepts 1 and 1440', () => {
  for (const bad of ['0', '1441']) {
    try {
      startDeclarationOf({ '--declared-ceiling-minutes': bad });
      assert.fail(`expected throw for ${bad}`);
    } catch (error) {
      assert.ok(error instanceof ArgumentError);
      assert.equal(error.message.includes(bad), false);
    }
  }
  assert.equal(startDeclarationOf({ '--declared-ceiling-minutes': '1' }).declaredCeilingMinutes, 1);
  assert.equal(startDeclarationOf({ '--declared-ceiling-minutes': '1440' }).declaredCeilingMinutes, 1440);
});

test('start: error messages never contain canary numeric text', () => {
  for (const key of ['--worker-count', '--declared-ceiling-minutes']) {
    try {
      startDeclarationOf({ [key]: '123456789CANARY' });
      assert.fail('expected throw');
    } catch (error) {
      assert.equal(error.message.includes('12'), false);
      assert.equal(error.message.includes('CANARY'), false);
    }
  }
});

test('start: result is frozen with exactly the fixed keys', () => {
  const out = startDeclarationOf({ '--worker-count': '2' });
  assert.ok(Object.isFrozen(out));
  assert.deepEqual(Object.keys(out).sort(), [
    'declaredCeilingMinutes',
    'executionMode',
    'harness',
    'model',
    'workerCount',
  ]);
});

test('stop: missing operator and missing flag each refuse', () => {
  assert.throws(() => stopAttestationOf({}), ArgumentError);
  assert.throws(() => stopAttestationOf({ '--operators': 'op', '--agents-stopped': true }), ArgumentError);
  assert.throws(
    () => stopAttestationOf({ '--operator': 'op' }),
    (error) => error instanceof ArgumentError && error.code === 'MISSING_OPTION',
  );
  assert.throws(() => stopAttestationOf({ '--agents-stopped': true }), ArgumentError);
  assert.throws(
    () => stopAttestationOf({ '--operator': 'op', '--agents-stopped': false }),
    ArgumentError,
  );
  assert.throws(
    () => stopAttestationOf({ '--agents-stopped': true, '--operator': 7 }),
    ArgumentError,
  );
});

test('stop: a normal operator produces the exact attested statement', () => {
  const out = stopAttestationOf({ '--operator': 'shaxs', '--agents-stopped': true });
  assert.equal(out.operator, 'shaxs');
  assert.equal(out.agentStopped, true);
  assert.equal(
    out.statement,
    'The operator attests all participant agents have stopped; BenchBoard did not stop them.',
  );
});

test('stop: operator length boundary is 2..256 untrimmed', () => {
  assert.equal(
    stopAttestationOf({ '--operator': 'a'.repeat(2), '--agents-stopped': true }).operator,
    'a'.repeat(2),
  );
  assert.equal(
    stopAttestationOf({ '--operator': 'a'.repeat(256), '--agents-stopped': true }).operator,
    'a'.repeat(256),
  );
  for (const bad of ['a', 'a'.repeat(257), 'a'.repeat(258)]) {
    assert.throws(
      () => stopAttestationOf({ '--operator': bad, '--agents-stopped': true }),
      (error) => error instanceof ArgumentError && error.code === 'INVALID_VALUE',
      `expected INVALID_VALUE for operator of length ${bad.length}`,
    );
  }
});

test('stop: supplied invalid operator is INVALID_VALUE, not MISSING_OPTION', () => {
  for (const bad of [7, null, '', 'x', 'x'.repeat(257)]) {
    assert.throws(
      () => stopAttestationOf({ '--operator': bad, '--agents-stopped': true }),
      (error) => error instanceof ArgumentError && error.code === 'INVALID_VALUE',
      `expected INVALID_VALUE for operator ${typeof bad}`,
    );
  }
});

test('stop: operator error messages never echo the value', () => {
  try {
    stopAttestationOf({ '--operator': `o${'p'.repeat(300)}CANARY`, '--agents-stopped': true });
    assert.fail('expected throw');
  } catch (error) {
    assert.ok(error instanceof ArgumentError);
    assert.equal(error.message.includes('CANARY'), false);
  }
});

test('stop: no timestamp, quality or process claim appears', () => {
  const out = stopAttestationOf({ '--operator': 'shaxs', '--agents-stopped': true });
  const text = JSON.stringify(out);
  for (const forbidden of ['timestamp', 'time', 'quality', 'score', 'kill', 'terminate', 'process', 'pid']) {
    assert.equal(text.includes(forbidden), false, `unexpected token: ${forbidden}`);
  }
  assert.deepEqual(Object.keys(out).sort(), ['agentStopped', 'operator', 'statement']);
});

test('stop: result is frozen', () => {
  assert.ok(Object.isFrozen(stopAttestationOf({ '--operator': 'shaxs', '--agents-stopped': true })));
});
