// Shared evaluation seams. No scorer, process implementation, or participant code loads here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TIMEOUT_MS = 300000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1048576;
export const WORKER_PROTOCOL_VERSION = 1;
export const STAGES = Object.freeze(['typecheck', 'build', 'visible', 'browser', 'useful', 'inspection']);
export const INFRASTRUCTURE_CODES = Object.freeze([
  'TIMEOUT', 'CANCELLED', 'MISSING_PREREQUISITE', 'TOOL_CRASH',
  'OUTPUT_LIMIT', 'INVALID_TOOL_OUTPUT', 'CLEANUP_FAILED',
]);
export const CANONICAL_TOOLING = Object.freeze([
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
]);
export const STAGE_WORKER_PATH = fileURLToPath(new URL('./stage-worker.mjs', import.meta.url));

export class EvaluationInfrastructureError extends Error {
  constructor(stage, code, message, details = {}) {
    super(message);
    this.name = 'EvaluationInfrastructureError';
    if (!INFRASTRUCTURE_CODES.includes(code)) throw new TypeError('Unknown infrastructure code');
    this.stage = stage;
    this.code = code;
    this.details = details;
  }
}

export class EvaluationRefusalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EvaluationRefusalError';
    this.code = code;
    this.details = details;
  }
}

export function throwIfAborted(signal, stage) {
  if (signal?.aborted) throw new EvaluationInfrastructureError(stage, 'CANCELLED', 'Evaluation cancelled');
}

export function requireCompleted(result, stage) {
  if (result?.status === 'infrastructure-error') {
    throw new EvaluationInfrastructureError(stage, result.error.code, result.error.message, {
      ...result.error.details, stdoutLog: result.stdoutLog, stderrLog: result.stderrLog,
    });
  }
  if (result?.status !== 'completed' || !Number.isInteger(result.exitCode) || result.signal !== null) {
    throw new EvaluationInfrastructureError(stage, 'TOOL_CRASH', 'Tool did not exit normally');
  }
  return result;
}

export function stageSuccess(stage, value, processResult = null) {
  return { stage, status: 'success', value, process: processResult };
}

// Parent-only child protocol. The runner is injected, so stage unit tests need no process module.
export async function runWorkerStage(context, stage) {
  if (!['browser', 'useful', 'inspection'].includes(stage)) throw new TypeError('Unknown worker stage');
  throwIfAborted(context.signal, stage);
  const requestFile = path.join(context.artifactRoot, 'worker-request.json');
  const resultFile = path.join(context.artifactRoot, 'worker-result.json');
  fs.writeFileSync(requestFile, JSON.stringify({
    protocolVersion: WORKER_PROTOCOL_VERSION,
    appRoot: context.appRoot, artifactRoot: context.artifactRoot,
    tempRoot: context.tempRoot, maxOutputBytes: context.maxOutputBytes,
  }), { flag: 'wx' });
  const result = requireCompleted(await context.runProcess({
    executable: process.execPath,
    args: [STAGE_WORKER_PATH, stage, requestFile, resultFile],
    cwd: context.appRoot, env: context.env,
    timeoutMs: context.timeoutMs, maxOutputBytes: context.maxOutputBytes,
    signal: context.signal,
    stdoutLog: path.join(context.artifactRoot, 'stdout.log'),
    stderrLog: path.join(context.artifactRoot, 'stderr.log'),
  }), stage);
  if (result.exitCode !== 0) {
    throw new EvaluationInfrastructureError(stage, 'TOOL_CRASH', 'Evaluation worker exited unsuccessfully', { exitCode: result.exitCode });
  }
  let record;
  try {
    const stat = fs.lstatSync(resultFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > context.maxOutputBytes) throw Error('Worker result is not a bounded ordinary file');
    record = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (record.protocolVersion !== WORKER_PROTOCOL_VERSION) throw Error('Unknown worker protocol');
    if (record.status === 'infrastructure-error' && INFRASTRUCTURE_CODES.includes(record.error?.code)) {
      throw new EvaluationInfrastructureError(stage, record.error.code, record.error.message, record.error.details);
    }
    if (record.status !== 'success' || !Object.hasOwn(record, 'value')) throw Error('Incomplete worker result');
  } catch (error) {
    if (error instanceof EvaluationInfrastructureError) throw error;
    throw new EvaluationInfrastructureError(stage, 'INVALID_TOOL_OUTPUT', error.message);
  }
  return stageSuccess(stage, record.value, result);
}
