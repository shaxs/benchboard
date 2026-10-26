// Unit tests for `cli/ui-arguments.mjs` (C6.S7.T1).
//
// This is pure input-projection evidence only: it proves how the declared `ui`
// flags map onto the two routes. It claims no filesystem proof and nothing about
// path containment, state reads, or what a later stage does with the paths.

import assert from "node:assert/strict";
import test from "node:test";

import { ArgumentError } from "../../cli/arguments.mjs";
import { uiArgumentsOf } from "../../cli/ui-arguments.mjs";

// ---------------------------------------------------------------------------
// Valid template routes
// ---------------------------------------------------------------------------

test("template: --evaluation selector only yields both identifier keys exactly", () => {
  const out = uiArgumentsOf({
    "--run": "r1",
    "--template": true,
    "--output": "C:\\private\\sheet.xlsx",
    "--evaluation": "eval.001",
  });
  assert.deepEqual(out, {
    mode: "template",
    output: "C:\\private\\sheet.xlsx",
    evaluationId: "eval.001",
    reportId: undefined,
  });
  assert.deepEqual(Object.keys(out).sort(), [
    "evaluationId",
    "mode",
    "output",
    "reportId",
  ]);
});

test("template: --report selector only yields both identifier keys exactly", () => {
  const out = uiArgumentsOf({
    "--template": true,
    "--output": "out",
    "--report": "report_one",
  });
  assert.equal(out.mode, "template");
  assert.equal(out.output, "out");
  assert.equal(out.evaluationId, undefined);
  assert.equal(out.reportId, "report_one");
  assert.deepEqual(Object.keys(out).sort(), [
    "evaluationId",
    "mode",
    "output",
    "reportId",
  ]);
});

test("template: both selectors may be supplied; the same baseline is resolved by the caller", () => {
  const out = uiArgumentsOf({
    "--template": true,
    "--output": "out",
    "--evaluation": "evaluation-a",
    "--report": "report.b",
  });
  assert.equal(out.evaluationId, "evaluation-a");
  assert.equal(out.reportId, "report.b");
});

test("template: the --run value and any extra key are never copied into the result", () => {
  const out = uiArgumentsOf({
    "--run": "CANARY-run-value",
    "--template": true,
    "--output": "out",
    "--evaluation": "abc",
  });
  assert.equal(out.run, undefined);
  assert.equal(Object.hasOwn(out, "--run"), false);
  for (const key of Object.keys(out)) {
    assert.equal(String(out[key]).includes("CANARY"), false);
  }
});

test("template: paths are kept exactly as supplied, never normalized or trimmed", () => {
  const out = uiArgumentsOf({
    "--template": true,
    "--output": "./mixed\\path/../keep me",
    "--evaluation": "abc",
  });
  assert.equal(out.output, "./mixed\\path/../keep me");
});

test("template: selector length boundaries 3 and 128 are accepted", () => {
  assert.equal(
    uiArgumentsOf({
      "--template": true,
      "--output": "o",
      "--evaluation": "abc",
    }).evaluationId,
    "abc",
  );
  assert.equal(
    uiArgumentsOf({
      "--template": true,
      "--output": "o",
      "--evaluation": "a".repeat(128),
    }).evaluationId,
    "a".repeat(128),
  );
});

// ---------------------------------------------------------------------------
// Valid attach routes
// ---------------------------------------------------------------------------

test("attach: absent --template with --input and --review-root yields the attach route", () => {
  const out = uiArgumentsOf({
    "--run": "r1",
    "--input": "done sheet.xlsx",
    "--review-root": "D:\\private\\reviews",
  });
  assert.deepEqual(out, {
    mode: "attach",
    input: "done sheet.xlsx",
    reviewRoot: "D:\\private\\reviews",
  });
  assert.deepEqual(Object.keys(out).sort(), ["input", "mode", "reviewRoot"]);
});

test("attach: paths are kept exactly as supplied", () => {
  const out = uiArgumentsOf({
    "--input": "..\\kept\\as-is ",
    "--review-root": "/kept/as-is",
  });
  assert.equal(out.input, "..\\kept\\as-is ");
  assert.equal(out.reviewRoot, "/kept/as-is");
});

// ---------------------------------------------------------------------------
// Frozen results and purity
// ---------------------------------------------------------------------------

test("both routes return frozen objects", () => {
  assert.ok(
    Object.isFrozen(
      uiArgumentsOf({
        "--template": true,
        "--output": "o",
        "--report": "abc",
      }),
    ),
  );
  assert.ok(
    Object.isFrozen(
      uiArgumentsOf({
        "--input": "i",
        "--review-root": "r",
      }),
    ),
  );
});

test("no mutation: the supplied map is unchanged by the call", () => {
  const options = {
    "--run": "r1",
    "--template": true,
    "--output": "out",
    "--evaluation": "abc",
  };
  const before = structuredClone(options);
  uiArgumentsOf(options);
  assert.deepEqual(options, before);
});

test("prototype keys do not count as supplied (absence is Object.hasOwn)", () => {
  const options = Object.create({ "--input": "from prototype" });
  Object.assign(options, {
    "--template": true,
    "--output": "out",
    "--evaluation": "abc",
  });
  const out = uiArgumentsOf(options);
  assert.equal(out.mode, "template");
});

// ---------------------------------------------------------------------------
// Rejections — every one a controlled ArgumentError INVALID_VALUE
// ---------------------------------------------------------------------------

function expectInvalid(label, options) {
  test(`${label} is refused as INVALID_VALUE`, () => {
    assert.throws(
      () => uiArgumentsOf(options),
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

// Missing or all-empty mode fields.
expectInvalid("an empty map", {});
expectInvalid("template route without a selector", {
  "--template": true,
  "--output": "out",
});
expectInvalid("attach route without --input", { "--review-root": "r" });
expectInvalid("attach route without --review-root", { "--input": "i" });
expectInvalid("attach route with both fields missing", { "--run": "r" });

// Contradictory mode fields (forbidden flags count even when own-valued undefined).
expectInvalid("template route with own undefined --input", {
  "--template": true,
  "--output": "o",
  "--evaluation": "abc",
  "--input": undefined,
});
expectInvalid("template route with a supplied --review-root", {
  "--template": true,
  "--output": "o",
  "--report": "abc",
  "--review-root": "r",
});
expectInvalid("attach route with own undefined --output", {
  "--input": "i",
  "--review-root": "r",
  "--output": undefined,
});
expectInvalid("attach route with a supplied --evaluation", {
  "--input": "i",
  "--review-root": "r",
  "--evaluation": "abc",
});
expectInvalid("attach route with a supplied --report", {
  "--input": "i",
  "--review-root": "r",
  "--report": "abc",
});
expectInvalid("--template supplied as false", {
  "--template": false,
  "--input": "i",
  "--review-root": "r",
});
expectInvalid("--template supplied with an own undefined value", {
  "--template": undefined,
  "--input": "i",
  "--review-root": "r",
});

// Nonstring or blank required values.
expectInvalid("--output that is not a string", {
  "--template": true,
  "--output": 7,
  "--evaluation": "abc",
});
expectInvalid("--output that is only whitespace", {
  "--template": true,
  "--output": "   ",
  "--evaluation": "abc",
});
expectInvalid("--input that is not a string", {
  "--input": {},
  "--review-root": "r",
});
expectInvalid("--review-root that is only whitespace", {
  "--input": "i",
  "--review-root": " ",
});
expectInvalid("--evaluation that is not a string", {
  "--template": true,
  "--output": "o",
  "--evaluation": 7,
});

// Unsafe selector identifiers (pattern /^[A-Za-z][A-Za-z0-9._-]{2,127}$/).
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
  expectInvalid(
    `template selector that fails the safe identifier pattern (${JSON.stringify(id).slice(0, 20)})`,
    {
      "--template": true,
      "--output": "o",
      "--evaluation": id,
    },
  );
}

// ---------------------------------------------------------------------------
// Error messages never echo caller data
// ---------------------------------------------------------------------------

test("error messages never echo supplied values (canary check)", () => {
  const cases = [
    {
      "--template": true,
      "--output": "CANARYOUTPUT",
      "--evaluation": "CANARY!!bad",
    },
    {
      "--template": true,
      "--output": "x".repeat(500) + "CANARY",
      "--evaluation": "abc",
      "--input": undefined,
    },
    { "--template": true, "--output": "o", "--evaluation": "CANARYeval!!" },
    { "--input": "CANARYINPUT", "--review-root": " " },
    {
      "--input": "CANARYINPUTCANARY",
      "--review-root": "r",
      "--report": "CANARYreport",
    },
    { "--template": false, "--input": "CANARYT", "--review-root": "r" },
  ];
  for (const options of cases) {
    assert.throws(
      () => uiArgumentsOf(options),
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
