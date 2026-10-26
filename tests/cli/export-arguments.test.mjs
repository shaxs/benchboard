// Unit tests for `cli/export-arguments.mjs` (C6.S8.T3).
//
// This is pure input-projection evidence only: it proves how the declared
// `export` flags map onto the selector. It claims no filesystem proof and
// nothing about path containment, committed baseline/child resolution, output
// privacy, or what a later stage does with the paths.

import assert from "node:assert/strict";
import test from "node:test";

import { ArgumentError } from "../../cli/arguments.mjs";
import { exportArgumentsOf } from "../../cli/export-arguments.mjs";

// ---------------------------------------------------------------------------
// Valid selectors
// ---------------------------------------------------------------------------

test("base: --evaluation and --output with no --report yield the three keys with reportId undefined", () => {
  const out = exportArgumentsOf({
    "--run": "r1",
    "--evaluation": "eval.001",
    "--output": "C:\\private\\exports",
  });
  assert.deepEqual(out, {
    evaluationId: "eval.001",
    reportId: undefined,
    output: "C:\\private\\exports",
  });
  assert.deepEqual(Object.keys(out).sort(), [
    "evaluationId",
    "output",
    "reportId",
  ]);
});

test("explicit report: --report yields the reportId key with the supplied identifier", () => {
  const out = exportArgumentsOf({
    "--evaluation": "evaluation-a",
    "--report": "report_one",
    "--output": "out",
  });
  assert.equal(out.evaluationId, "evaluation-a");
  assert.equal(out.reportId, "report_one");
  assert.equal(out.output, "out");
  assert.deepEqual(Object.keys(out).sort(), [
    "evaluationId",
    "output",
    "reportId",
  ]);
});

test("there is no implicit latest: a missing --report yields undefined, never a value", () => {
  const out = exportArgumentsOf({
    "--evaluation": "abc",
    "--output": "o",
  });
  assert.equal(out.reportId, undefined);
  assert.equal(Object.hasOwn(out, "reportId"), true);
});

test("the --run value and any extra key are never copied into the result", () => {
  const out = exportArgumentsOf({
    "--run": "CANARY-run-value",
    "--snapshot": "CANARY-snapshot-value",
    "--evaluation": "abc",
    "--output": "o",
  });
  assert.deepEqual(Object.keys(out).sort(), [
    "evaluationId",
    "output",
    "reportId",
  ]);
  assert.equal(Object.hasOwn(out, "--run"), false);
  assert.equal(out.run, undefined);
  for (const key of Object.keys(out)) {
    assert.equal(String(out[key]).includes("CANARY"), false);
  }
});

test("paths are kept exactly as supplied, never normalized or trimmed", () => {
  const out = exportArgumentsOf({
    "--evaluation": "abc",
    "--output": "./mixed\\path/../keep me ",
  });
  assert.equal(out.output, "./mixed\\path/../keep me ");
});

test("selector identifiers of any accepted spelling are kept exactly as supplied", () => {
  const out = exportArgumentsOf({
    "--evaluation": "Eval_2.5-x",
    "--report": "rep.007",
    "--output": "o",
  });
  assert.equal(out.evaluationId, "Eval_2.5-x");
  assert.equal(out.reportId, "rep.007");
});

test("selector length boundaries 3 and 128 are accepted, for both selectors", () => {
  const out = exportArgumentsOf({
    "--evaluation": "abc",
    "--report": "a".repeat(128),
    "--output": "o",
  });
  assert.equal(out.evaluationId, "abc");
  assert.equal(out.reportId, "a".repeat(128));

  const out2 = exportArgumentsOf({
    "--evaluation": "a".repeat(128),
    "--report": "abc",
    "--output": "o",
  });
  assert.equal(out2.evaluationId, "a".repeat(128));
});

// ---------------------------------------------------------------------------
// Frozen results and purity
// ---------------------------------------------------------------------------

test("the result is frozen", () => {
  const out = exportArgumentsOf({
    "--evaluation": "abc",
    "--output": "o",
  });
  assert.ok(Object.isFrozen(out));
});

test("no mutation: the supplied map is unchanged by the call", () => {
  const options = {
    "--run": "r1",
    "--evaluation": "abc",
    "--report": "rep",
    "--output": "out",
  };
  const before = structuredClone(options);
  exportArgumentsOf(options);
  assert.deepEqual(options, before);
});

test("prototype keys do not count as supplied (absence is Object.hasOwn)", () => {
  const options = Object.create({ "--report": "from prototype" });
  Object.assign(options, {
    "--evaluation": "abc",
    "--output": "o",
  });
  const out = exportArgumentsOf(options);
  assert.equal(out.reportId, undefined);
});

// ---------------------------------------------------------------------------
// Rejections — every one a controlled ArgumentError INVALID_VALUE
// ---------------------------------------------------------------------------

function expectInvalid(label, options) {
  test(`${label} is refused as INVALID_VALUE`, () => {
    assert.throws(
      () => exportArgumentsOf(options),
      (error) => {
        assert.ok(
          error instanceof ArgumentError,
          "must be a controlled ArgumentError",
        );
        assert.equal(error.name, "ArgumentError");
        assert.equal(error.code, "INVALID_VALUE");
        return true;
      },
    );
  });
}

// Missing or malformed required fields.
expectInvalid("an empty map", {});
expectInvalid("a map with only --run", { "--run": "r" });
expectInvalid("a missing --evaluation", { "--output": "o" });
expectInvalid("a missing --output", { "--evaluation": "abc" });

// Own-undefined values count as supplied and are refused.
expectInvalid("--evaluation present with an own undefined value", {
  "--evaluation": undefined,
  "--output": "o",
});
expectInvalid("--report present with an own undefined value", {
  "--evaluation": "abc",
  "--report": undefined,
  "--output": "o",
});
expectInvalid("--output present with an own undefined value", {
  "--evaluation": "abc",
  "--output": undefined,
});

// Nonobject and null maps.
expectInvalid("a null map", null);
expectInvalid("a nonobject (number) map", 7);

// Nonstring or blank output values.
expectInvalid("--output that is not a string (number)", {
  "--evaluation": "abc",
  "--output": 7,
});
expectInvalid("--output that is not a string (object)", {
  "--evaluation": "abc",
  "--output": {},
});
expectInvalid("--output that is the empty string", {
  "--evaluation": "abc",
  "--output": "",
});
expectInvalid("--output that is only whitespace", {
  "--evaluation": "abc",
  "--output": "   ",
});

// Nonstring selectors.
expectInvalid("--evaluation that is not a string", {
  "--evaluation": 7,
  "--output": "o",
});
expectInvalid("--report that is not a string", {
  "--evaluation": "abc",
  "--report": {},
  "--output": "o",
});
expectInvalid("--evaluation that is the empty string", {
  "--evaluation": "",
  "--output": "o",
});
expectInvalid("--evaluation that is only whitespace", {
  "--evaluation": "  ",
  "--output": "o",
});

// Unsafe selector identifiers (pattern /^[A-Za-z][A-Za-z0-9._-]{2,127}$/),
// exercised for --evaluation and --report alike.
const UNSAFE_IDENTIFIERS = [
  "ab", // two characters: below the minimum
  "a".repeat(129), // above the maximum
  "1abc", // leading digit
  ".abc", // leading dot
  "_abc", // leading underscore
  "-abc", // leading dash
  "ab cd", // embedded space
  "ab/cd", // embedded slash
  "ab\\cd", // embedded backslash
  "ab$cd", // embedded dollar sign
  "ab!cd", // embedded bang
];
for (const id of UNSAFE_IDENTIFIERS) {
  const label = `a selector that fails the safe identifier pattern (${JSON.stringify(id).slice(0, 20)})`;
  expectInvalid(`${label} as --evaluation`, {
    "--evaluation": id,
    "--output": "o",
  });
  expectInvalid(`${label} as --report`, {
    "--evaluation": "abc",
    "--report": id,
    "--output": "o",
  });
}

// ---------------------------------------------------------------------------
// Error messages never echo caller data
// ---------------------------------------------------------------------------

test("error messages never echo supplied values (canary check)", () => {
  const cases = [
    { "--evaluation": "CANARYeval!!", "--output": "o" },
    {
      "--evaluation": "CANARYeval",
      "--report": "CANARYreport!!",
      "--output": "o",
    },
    {
      // --report is checked before --output, so the refusal reports no output.
      "--evaluation": "abc",
      "--report": "CANARYreport!!",
      "--output": "o",
    },
    {
      // A nonstring output carrying the canary, refused on the output check.
      "--evaluation": "abc",
      "--report": "ok.report",
      "--output": { canary: "CANARYOUTPUT" },
    },
    { "--evaluation": undefined, "--output": "CANARYOUT" },
    { "--evaluation": "CANARY", "--output": undefined },
  ];
  for (const options of cases) {
    assert.throws(
      () => exportArgumentsOf(options),
      (error) => {
        assert.ok(error instanceof ArgumentError);
        assert.equal(error.code, "INVALID_VALUE");
        assert.equal(
          error.message.includes("CANARY"),
          false,
          "message must not echo the value",
        );
        return true;
      },
    );
  }
});
