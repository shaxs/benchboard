// The three plain tool stages: typecheck, build and visible tests. Each drives one fixed staged
// invocation through the injected context.runProcess (accepted T1 seam) in the supplied app cwd,
// so stage unit tests use fake ProcessResults and never load a process implementation. The T2
// runner is not imported; the real runner is exercised at T6b. Ordering across stages belongs to
// the facade, never here. Infrastructure outcomes propagate as errors through requireCompleted and
// never become declared evidence.
import fs from 'node:fs';
import path from 'node:path';
import { EvaluationInfrastructureError, requireCompleted, stageSuccess, throwIfAborted } from './contracts.mjs';

const VISIBLE_REPORT_NAME = 'visible.json';

function stagedTool(appRoot, tool) {
  // Mirrors the historical evaluate tooling at lines 199-220 exactly: node runs the tool file
  // resolved inside the staged node_modules, with the app directory as cwd.
  return path.join(appRoot, 'node_modules', tool);
}

async function runFixedTool(context, stage, tool, args, stdoutLog, stderrLog) {
  throwIfAborted(context.signal, stage);
  fs.mkdirSync(context.artifactRoot, { recursive: true });
  const result = requireCompleted(await context.runProcess({
    executable: process.execPath,
    args: [stagedTool(context.appRoot, tool), ...args],
    cwd: context.appRoot,
    env: context.env,
    timeoutMs: context.timeoutMs,
    maxOutputBytes: context.maxOutputBytes,
    signal: context.signal,
    stdoutLog,
    stderrLog,
  }), stage);
  return result;
}

export async function runTypecheckStage(context) {
  const result = await runFixedTool(context, 'typecheck', 'typescript/bin/tsc', ['--noEmit'],
    path.join(context.artifactRoot, 'typecheck.stdout.log'),
    path.join(context.artifactRoot, 'typecheck.stderr.log'));
  // An ordinary nonzero exit is evidence of failure, never an infrastructure outcome.
  return stageSuccess('typecheck', result.exitCode === 0, result);
}

export async function runBuildStage(context) {
  const result = await runFixedTool(context, 'build', 'vite/bin/vite.js', ['build'],
    path.join(context.artifactRoot, 'build.stdout.log'),
    path.join(context.artifactRoot, 'build.stderr.log'));
  return stageSuccess('build', result.exitCode === 0, result);
}

function readVisibleReport(reportPath, maxOutputBytes) {
  let record;
  try {
    const stat = fs.lstatSync(reportPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxOutputBytes) {
      throw Error('Visible report is not a bounded ordinary file');
    }
    record = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (error) {
    // A missing, unbounded or unparseable report cannot become points.
    throw new EvaluationInfrastructureError('visible', 'INVALID_TOOL_OUTPUT', 'Visible test report is unreadable', {
      cause: String(error?.message ?? error ?? '').slice(0, 4000),
    });
  }
  const passed = record?.numPassedTests;
  const total = record?.numTotalTests;
  // Finite integer counts only; a missing or non-integer count is never fabricated as zero.
  const valid = typeof record === 'object' && record !== null && !Array.isArray(record)
    && Number.isInteger(passed) && passed >= 0
    && Number.isInteger(total) && total >= 0 && passed <= total;
  if (!valid) {
    throw new EvaluationInfrastructureError('visible', 'INVALID_TOOL_OUTPUT', 'Visible test report lacks finite integer counts');
  }
  return { passed, total };
}

export async function runVisibleStage(context) {
  throwIfAborted(context.signal, 'visible');
  fs.mkdirSync(context.artifactRoot, { recursive: true });
  const reportPath = path.join(context.artifactRoot, VISIBLE_REPORT_NAME);
  const result = requireCompleted(await context.runProcess({
    executable: process.execPath,
    args: [
      stagedTool(context.appRoot, 'vitest/vitest.mjs'),
      'run',
      'tests/contracts.test.tsx',
      '--reporter=json',
      '--outputFile=' + reportPath,
    ],
    cwd: context.appRoot,
    env: context.env,
    timeoutMs: context.timeoutMs,
    maxOutputBytes: context.maxOutputBytes,
    signal: context.signal,
    stdoutLog: path.join(context.artifactRoot, 'visible.stdout.log'),
    stderrLog: path.join(context.artifactRoot, 'visible.stderr.log'),
  }), 'visible');
  // A completed visible run with a valid report is evidence even when tests failed (nonzero exit).
  const { passed, total } = readVisibleReport(reportPath, context.maxOutputBytes);
  return stageSuccess('visible', Object.freeze({ passed, total, reportPath }), result);
}
