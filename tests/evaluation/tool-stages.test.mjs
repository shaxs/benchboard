import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvaluationInfrastructureError } from '../../packages/evaluation/contracts.mjs';
import { runBuildStage, runTypecheckStage, runVisibleStage } from '../../packages/evaluation/tool-stages.mjs';

// Unit tests drive a fake runner built from the accepted T1 contracts only. No process
// implementation, no T2 import, no fixture evaluation, no browser or server, no Chromium.

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function context(t, prefix, runProcess, overrides = {}) {
  const root = tempRoot(t, prefix);
  const appRoot = path.join(root, 'app');
  const artifactRoot = path.join(root, 'artifacts');
  fs.mkdirSync(appRoot, { recursive: true });
  const seen = [];
  return {
    appRoot, artifactRoot, tempRoot: path.join(root, 'temp'),
    timeoutMs: 300000, maxOutputBytes: 1048576, env: Object.freeze({ PATH: 'fake' }),
    seen,
    runProcess: async request => { seen.push(request); return runProcess(request); },
    ...overrides,
  };
}

function completed(exitCode) {
  return request => Object.freeze({
    status: 'completed', exitCode, signal: null, stdout: '', stderr: '',
    stdoutLog: request.stdoutLog, stderrLog: request.stderrLog,
  });
}

function infraError(code) {
  return request => Object.freeze({
    status: 'infrastructure-error', exitCode: null, signal: null,
    stdout: '', stderr: '', stdoutLog: request.stdoutLog, stderrLog: request.stderrLog,
    error: { code, message: code, details: {} },
  });
}

// Fake runner for the visible stage: writes the report as the real tool's JSON reporter would,
// through the --outputFile argument the stage itself supplied, then returns the given exit code.
function visibleRun(report, exitCode = 0) {
  return request => {
    const outputFile = request.args.find(arg => arg.startsWith('--outputFile='));
    assert.ok(outputFile, 'the fixed invocation must carry an --outputFile argument');
    fs.mkdirSync(path.dirname(outputFile.slice('--outputFile='.length)), { recursive: true });
    fs.writeFileSync(outputFile.slice('--outputFile='.length), typeof report === 'string' ? report : JSON.stringify(report));
    return completed(exitCode)(request);
  };
}

test('typecheck stage invokes the fixed staged tsc exactly and maps exit codes to evidence', async t => {
  for (const [exitCode, expected] of [[0, true], [1, false], [2, false]]) {
    const ctx = context(t, 'bb-eval-typecheck-', completed(exitCode));
    const result = await runTypecheckStage(ctx);
    assert.equal(result.stage, 'typecheck');
    assert.equal(result.status, 'success');
    assert.equal(result.value, expected);
    assert.equal(result.process.exitCode, exitCode);
    const [request] = ctx.seen;
    assert.equal(request.executable, process.execPath);
    assert.deepEqual(request.args, [path.join(ctx.appRoot, 'node_modules', 'typescript/bin/tsc'), '--noEmit']);
    assert.equal(request.cwd, ctx.appRoot);
    assert.deepEqual(request.env, { PATH: 'fake' });
    assert.equal(request.timeoutMs, 300000);
    assert.equal(request.maxOutputBytes, 1048576);
    assert.ok(request.stdoutLog.startsWith(ctx.artifactRoot + path.sep));
    assert.ok(request.stderrLog.startsWith(ctx.artifactRoot + path.sep));
  }
});

test('build stage invokes the fixed staged vite build exactly and maps exit codes to evidence', async t => {
  for (const [exitCode, expected] of [[0, true], [1, false]]) {
    const ctx = context(t, 'bb-eval-build-', completed(exitCode));
    const result = await runBuildStage(ctx);
    assert.equal(result.stage, 'build');
    assert.equal(result.value, expected);
    const [request] = ctx.seen;
    assert.equal(request.executable, process.execPath);
    assert.deepEqual(request.args, [path.join(ctx.appRoot, 'node_modules', 'vite/bin/vite.js'), 'build']);
    assert.equal(request.cwd, ctx.appRoot);
    assert.ok(request.stdoutLog.startsWith(ctx.artifactRoot + path.sep));
    assert.ok(request.stderrLog.startsWith(ctx.artifactRoot + path.sep));
  }
});

test('visible stage runs the fixed contract-test invocation and reads exact counts from its private report', async t => {
  const ctx = context(t, 'bb-eval-visible-', visibleRun({ numPassedTests: 17, numTotalTests: 17, numFailedTests: 0 }));
  const result = await runVisibleStage(ctx);
  const expectedReport = path.join(ctx.artifactRoot, 'visible.json');
  const [request] = ctx.seen;
  assert.equal(request.executable, process.execPath);
  assert.deepEqual(request.args, [
    path.join(ctx.appRoot, 'node_modules', 'vitest/vitest.mjs'),
    'run',
    'tests/contracts.test.tsx',
    '--reporter=json',
    '--outputFile=' + expectedReport,
  ]);
  assert.equal(request.cwd, ctx.appRoot);
  assert.equal(result.stage, 'visible');
  assert.deepEqual(result.value, { passed: 17, total: 17, reportPath: expectedReport });
  assert.deepEqual(Object.keys(result.value), ['passed', 'total', 'reportPath']);
  assert.equal(result.process.exitCode, 0);
});

test('a completed visible run with failing tests is still evidence; a nonzero exit does not zero the counts', async t => {
  const ctx = context(t, 'bb-eval-visible-fail-', visibleRun({ numPassedTests: 12, numTotalTests: 17, numFailedTests: 5 }, 1));
  const result = await runVisibleStage(ctx);
  assert.equal(result.value.passed, 12);
  assert.equal(result.value.total, 17);
  assert.equal(result.process.exitCode, 1);
});

test('missing, malformed, non-integer or zero-count-free visible reports are INVALID_TOOL_OUTPUT, never fabricated counts', async t => {
  const cases = [
    ['missing report', completed(0)],
    ['malformed json', visibleRun('{not json')],
    ['report without counts', visibleRun({ success: true })],
    ['fractional counts', visibleRun({ numPassedTests: 1.5, numTotalTests: 3 })],
    ['string counts', visibleRun({ numPassedTests: '2', numTotalTests: '3' })],
    ['missing passed count', visibleRun({ numTotalTests: 3 })],
    ['json array instead of object', visibleRun([1, 2])],
    ['negative counts', visibleRun({ numPassedTests: -1, numTotalTests: 3 })],
    ['passed greater than total', visibleRun({ numPassedTests: 4, numTotalTests: 3 })],
  ];
  for (const [name, run] of cases) {
    const ctx = context(t, 'bb-eval-visible-bad-', run);
    await assert.rejects(() => runVisibleStage(ctx), error =>
      error instanceof EvaluationInfrastructureError && error.stage === 'visible' && error.code === 'INVALID_TOOL_OUTPUT',
      name);
  }
});

test('a directory placed at the report path is an invalid report, not a count source', async t => {
  const ctx = context(t, 'bb-eval-visible-dir-', completed(0));
  fs.mkdirSync(path.join(ctx.artifactRoot, 'visible.json'), { recursive: true });
  await assert.rejects(() => runVisibleStage(ctx), error =>
    error.code === 'INVALID_TOOL_OUTPUT' && error.stage === 'visible');
});

test('infrastructure outcomes propagate as errors from every stage and never become declared results', async t => {
  const stages = [runTypecheckStage, runBuildStage, runVisibleStage];
  for (const stage of stages) {
    for (const code of ['TIMEOUT', 'CANCELLED', 'MISSING_PREREQUISITE', 'TOOL_CRASH', 'OUTPUT_LIMIT']) {
      const ctx = context(t, 'bb-eval-tool-infra-', infraError(code));
      await assert.rejects(() => stage(ctx), error =>
        error instanceof EvaluationInfrastructureError && error.code === code && typeof error.stage === 'string');
      assert.equal(ctx.seen.length, 1);
    }
    // A killed tool (no ordinary exit code) is a crash, never a point.
    const ctx = context(t, 'bb-eval-tool-crash-', request => Object.freeze({
      status: 'completed', exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '',
      stdoutLog: request.stdoutLog, stderrLog: request.stderrLog,
    }));
    await assert.rejects(() => stage(ctx), error => error.code === 'TOOL_CRASH');
  }
});

test('cancellation before the runner starts raises CANCELLED without calling runProcess', async t => {
  const stages = [runTypecheckStage, runBuildStage, runVisibleStage];
  for (const stage of stages) {
    const ctx = context(t, 'bb-eval-tool-cancel-', completed(0), { signal: AbortSignal.abort() });
    await assert.rejects(() => stage(ctx), error =>
      error instanceof EvaluationInfrastructureError && error.code === 'CANCELLED');
    assert.equal(ctx.seen.length, 0);
  }
});

test('each stage writes its stdout and stderr logs under its own artifact root', async t => {
  const ctx = context(t, 'bb-eval-tool-logs-', completed(0));
  await runTypecheckStage(ctx);
  await runBuildStage(ctx);
  const ctxVisible = context(t, 'bb-eval-tool-logs-v-', visibleRun({ numPassedTests: 1, numTotalTests: 1 }));
  await runVisibleStage(ctxVisible);
  assert.equal(ctx.seen.length, 2);
  const names = [...ctx.seen, ...ctxVisible.seen].map(r => [r.stdoutLog, r.stderrLog]).flat();
  for (const name of names) {
    assert.ok(name.startsWith(ctx.artifactRoot + path.sep) || name.startsWith(ctxVisible.artifactRoot + path.sep), name);
  }
  assert.equal(new Set(names).size, 6, 'each log path is distinct');
});

test('the stage module never imports the T2 runner or any process implementation statically', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../../packages/evaluation/tool-stages.mjs', import.meta.url)), 'utf8');
  const statics = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;\n]*from\s*'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(statics, ['node:fs', 'node:path', './contracts.mjs']);
  assert.doesNotMatch(source, /runner\/|report\.mjs|spawn|playwright|chromium/i);
});

test('paired declarations are byte-identical', () => {
  const root = fileURLToPath(new URL('../../packages/evaluation/tool-stages', import.meta.url));
  assert.deepEqual(fs.readFileSync(root + '.d.ts'), fs.readFileSync(root + '.d.mts'));
});
