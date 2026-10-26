import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EvaluationInfrastructureError, INFRASTRUCTURE_CODES, requireCompleted, runWorkerStage, STAGE_WORKER_PATH, throwIfAborted } from '../../packages/evaluation/contracts.mjs';

test('contract preserves ordinary nonzero exits and distinguishes infrastructure codes', () => {
  for (const exitCode of [0, 1, 2]) assert.equal(requireCompleted({ status: 'completed', exitCode, signal: null }, 'build').exitCode, exitCode);
  for (const code of INFRASTRUCTURE_CODES) assert.throws(() => requireCompleted({ status: 'infrastructure-error', error: { code, message: code } }, 'build'), error => error.code === code && error.stage === 'build');
  assert.throws(() => requireCompleted({ status: 'completed', exitCode: null, signal: 'SIGTERM' }, 'build'), error => error.code === 'TOOL_CRASH');
  assert.throws(() => new EvaluationInfrastructureError('build', 'MADE_UP', 'bad'), TypeError);
  assert.throws(() => throwIfAborted(AbortSignal.abort(), 'build'), error => error.code === 'CANCELLED');
});

test('paired declarations are byte-identical', () => {
  for (const name of ['contracts', 'evaluate-frozen']) {
    const root = new URL(`../../packages/evaluation/${name}`, import.meta.url);
    assert.deepEqual(fs.readFileSync(fileURLToPath(root) + '.d.ts'), fs.readFileSync(fileURLToPath(root) + '.d.mts'));
  }
});

test('worker protocol is usable with a fake runner and no process implementation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-eval-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = { appRoot: root, artifactRoot: root, tempRoot: root, timeoutMs: 300000, maxOutputBytes: 1048576, env: {}, runProcess: async request => {
    assert.equal(request.executable, process.execPath);
    assert.deepEqual(request.args.slice(0, 2), [STAGE_WORKER_PATH, 'browser']);
    const payload = JSON.parse(fs.readFileSync(request.args[2], 'utf8'));
    assert.equal(payload.protocolVersion, 1);
    fs.writeFileSync(request.args[3], JSON.stringify({ protocolVersion: 1, status: 'success', value: [] }));
    return { status: 'completed', exitCode: 0, signal: null, stdout: '', stderr: '', stdoutLog: request.stdoutLog, stderrLog: request.stderrLog };
  } };
  const result = await runWorkerStage(ctx, 'browser');
  assert.deepEqual(result.value, []);
  assert.equal(result.stage, 'browser');
});

test('unknown child stages are refused before reading a request or loading semantic modules', () => {
  const result = spawnSync(process.execPath, [STAGE_WORKER_PATH, '../participant-module', 'missing', 'missing'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Invalid evaluation worker invocation/);
});

test('fixed inspection child reads source as data, and oversized evidence is an explicit output error', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-eval-inspection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  const source = 'console.log("AST only, never execute participant source");';
  fs.writeFileSync(path.join(root, 'src/app.ts'), source);
  for (const maxOutputBytes of [1048576, 256]) {
    const request = path.join(root, `request-${maxOutputBytes}.json`), resultFile = path.join(root, `result-${maxOutputBytes}.json`);
    fs.writeFileSync(request, JSON.stringify({ protocolVersion: 1, appRoot: root, artifactRoot: root, tempRoot: root, maxOutputBytes }));
    const processResult = spawnSync(process.execPath, [STAGE_WORKER_PATH, 'inspection', request, resultFile], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(processResult.status, 0, processResult.stderr);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (maxOutputBytes === 256) assert.equal(result.error.code, 'OUTPUT_LIMIT');
    else { assert.equal(result.status, 'success'); assert.equal(result.value.hygiene.noDebugLogging, false); }
  }
  assert.equal(fs.readFileSync(path.join(root, 'src/app.ts'), 'utf8'), source);
});

test('fixed runner/public declarations typecheck for a real NodeNext consumer', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-eval-types-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contracts = fileURLToPath(new URL('../../packages/evaluation/contracts.mjs', import.meta.url)).replaceAll('\\', '/');
  const facade = fileURLToPath(new URL('../../packages/evaluation/evaluate-frozen.mjs', import.meta.url)).replaceAll('\\', '/');
  const consumer = path.join(root, 'consumer.mts');
  fs.writeFileSync(consumer, `import type { ProcessRunner, StageContext } from ${JSON.stringify(contracts)};
import { evaluateFrozen } from ${JSON.stringify(facade)};
const runner: ProcessRunner = async r => ({status:'completed',exitCode:0,signal:null,stdout:'',stderr:'',stdoutLog:r.stdoutLog,stderrLog:r.stderrLog});
const ctx: StageContext = {appRoot:'synthetic',artifactRoot:'synthetic',tempRoot:'synthetic',timeoutMs:1,maxOutputBytes:256,env:{},runProcess:runner};
void ctx; void evaluateFrozen;
`);
  const compiler = fileURLToPath(new URL('../../starter/node_modules/typescript/bin/tsc', import.meta.url));
  const result = spawnSync(process.execPath, [compiler, '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', consumer], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
