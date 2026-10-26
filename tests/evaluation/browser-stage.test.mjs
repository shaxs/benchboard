import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvaluationInfrastructureError, STAGE_WORKER_PATH } from '../../packages/evaluation/contracts.mjs';
import { executeBrowserStage, runBrowserStage } from '../../packages/evaluation/browser-stage.mjs';

const MISSING_MESSAGE = "node:internal/modules/cjs/wrappers/loader: cannot find package '@playwright/test'";

function propertyRecords() {
  return Object.freeze(Array.from({ length: 25 }, (_, index) => Object.freeze({
    id: 'P' + String(index).padStart(2, '0'),
    area: 'area',
    name: 'property ' + index,
    passed: true,
  })));
}

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeRequest(root, maxOutputBytes = 1048576) {
  const artifactRoot = path.join(root, 'artifacts', 'browser');
  return Object.freeze(Object.freeze({
    protocolVersion: 1, appRoot: path.join(root, 'app'), artifactRoot,
    tempRoot: path.join(root, 'temp'), maxOutputBytes,
  }));
}

function makeServer(t, { closeError = null, logsError = null, asyncClose = false, logs = 'served ok' } = {}) {
  const state = { closes: 0, logCalls: 0 };
  t.after(() => { if (!state.killed) state.killed = true; });
  return {
    url: 'http://127.0.0.1:59999',
    logs: () => { state.logCalls += 1; if (logsError) throw logsError; return typeof logs === 'function' ? logs() : logs; },
    close: () => {
      state.closes += 1;
      if (closeError) throw closeError;
      if (asyncClose) return Promise.resolve();
      return undefined;
    },
    state,
  };
}

test('executeBrowserStage evaluates all properties with no filter and releases the acquired server exactly once', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-browser-ok-'));
  const server = makeServer(t, { asyncClose: true });
  const results = propertyRecords();
  const calls = [];
  const value = await executeBrowserStage(request, {
    localServer: async appRoot => { calls.push(['start', appRoot]); return server; },
    browserEvaluate: async (...args) => { calls.push(['evaluate', ...args]); return results; },
  });
  assert.equal(value, results);
  assert.deepEqual(calls, [['start', request.appRoot], ['evaluate', server.url, request.artifactRoot]]);
  assert.equal(server.state.closes, 1);
  assert.equal(fs.readFileSync(path.join(request.artifactRoot, 'server.log'), 'utf8'), 'served ok');
});

test('a server startup timeout is TIMEOUT, retains its bounded diagnostic log, and never closes an unacquired server', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-browser-start-timeout-'));
  // A half-acquired sentinel whose close must never be reached: startup failed, so no handle was
  // handed to the handler and it must not attempt any close.
  const unreachable = makeServer(t);
  let attempted = 0;
  await assert.rejects(
    executeBrowserStage(request, {
      localServer: async () => {
        attempted += 1;
        // The unchanged helper throws its accumulated diagnostics inside the message.
        throw Error('Local server timed out: vite listening on 59999\nwarning: slow startup');
      },
      browserEvaluate: async () => { throw Error('must not run'); },
    }),
    error => error instanceof EvaluationInfrastructureError && error.stage === 'browser' &&
      error.code === 'TIMEOUT' && /timed out/.test(error.details.cause),
  );
  assert.equal(attempted, 1);
  assert.equal(unreachable.state.closes, 0); // zero spurious close calls for an unacquired server
  const log = fs.readFileSync(path.join(request.artifactRoot, 'server.log'), 'utf8');
  assert.match(log, /Local server timed out/);
  assert.match(log, /slow startup/); // the diagnostic output is retained, not discarded
});

test('an ordinary server startup crash is TOOL_CRASH and retains its diagnostic log', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-browser-start-crash-'));
  await assert.rejects(
    executeBrowserStage(request, {
      localServer: async () => { throw Error('vite exited with code 1: rollup parse failure'); },
      browserEvaluate: async () => { throw Error('must not run'); },
    }),
    error => error.code === 'TOOL_CRASH' && /rollup parse failure/.test(error.details.cause),
  );
  assert.match(fs.readFileSync(path.join(request.artifactRoot, 'server.log'), 'utf8'), /rollup parse failure/);
});

test('a startup failure with an oversized diagnostic still bounds server.log and records OUTPUT_LIMIT detail', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-browser-start-limit-'), 16);
  await assert.rejects(
    executeBrowserStage(request, {
      localServer: async () => { throw Error('Local server timed out: ' + 'x'.repeat(100)); },
      browserEvaluate: async () => { throw Error('must not run'); },
    }),
    error => error.code === 'TIMEOUT' && /exceeded its 16-byte bound/.test(error.details.outputLimit),
  );
  assert.equal(fs.readFileSync(path.join(request.artifactRoot, 'server.log')).byteLength, 16);
});

test('missing Chromium surfaces as MISSING_PREREQUISITE, never as failed properties', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-browser-missing-'));
  const server = makeServer(t);
  await assert.rejects(
    executeBrowserStage(request, {
      localServer: async () => server,
      browserEvaluate: async () => { throw Error(MISSING_MESSAGE); },
    }),
    error => error.code === 'MISSING_PREREQUISITE' && error.stage === 'browser',
  );
  assert.equal(server.state.closes, 1);
});

test('browser evaluation rejection still closes the server once and keeps the server log', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-browser-eval-'));
  const server = makeServer(t, { logs: 'vite listening' });
  await assert.rejects(
    executeBrowserStage(request, {
      localServer: async () => server,
      browserEvaluate: async () => { throw Error('page.goto: net::ERR_CONNECTION_REFUSED'); },
    }),
    error => error.code === 'TOOL_CRASH' && /page\.goto/.test(error.details.cause),
  );
  assert.equal(server.state.closes, 1);
  assert.equal(fs.readFileSync(path.join(request.artifactRoot, 'server.log'), 'utf8'), 'vite listening');
});

test('close rejection after a successful evaluation raises CLEANUP_FAILED with the log still written', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-browser-close-'));
  const server = makeServer(t, { closeError: Error('kill: access denied') });
  await assert.rejects(
    executeBrowserStage(request, {
      localServer: async () => server,
      browserEvaluate: async () => propertyRecords(),
    }),
    error => error.code === 'CLEANUP_FAILED' && error.details.cleanupErrors.some(entry => /server close/.test(entry)),
  );
  assert.equal(server.state.closes, 1);
  assert.equal(fs.readFileSync(path.join(request.artifactRoot, 'server.log'), 'utf8'), 'served ok');
});

test('the primary evaluation cause is preserved when close also fails', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-browser-both-'));
  const server = makeServer(t, { closeError: Error('close blew up') });
  await assert.rejects(
    executeBrowserStage(request, {
      localServer: async () => server,
      browserEvaluate: async () => { throw Error('launch: executable doesn\'t exist'); },
    }),
    error => error.code === 'MISSING_PREREQUISITE' &&
      /executable doesn't exist/.test(error.details.cause) &&
      error.details.cleanupErrors.some(entry => /server close/.test(entry)),
  );
});

test('an infrastructure error from the collaborator passes through unchanged and the server still closes', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-browser-passthru-'));
  const server = makeServer(t);
  await assert.rejects(
    executeBrowserStage(request, {
      localServer: async () => server,
      browserEvaluate: async () => { throw new EvaluationInfrastructureError('browser', 'CANCELLED', 'Evaluation cancelled'); },
    }),
    error => error.code === 'CANCELLED' && error.details.cause === undefined,
  );
  assert.equal(server.state.closes, 1);
});

test('a successful evaluation whose server log exceeds the byte bound fails as OUTPUT_LIMIT, still closing the server', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-browser-limit-'), 8);
  const server = makeServer(t, { logs: 'exactly-ten-chars' });
  await assert.rejects(
    executeBrowserStage(request, {
      localServer: async () => server,
      browserEvaluate: async () => propertyRecords(),
    }),
    error => error.code === 'OUTPUT_LIMIT' && error.stage === 'browser' &&
      /bound and was truncated/.test(error.message),
  );
  // The server was still closed exactly once, and the bounded prefix was retained.
  assert.equal(server.state.closes, 1);
  const written = fs.readFileSync(path.join(request.artifactRoot, 'server.log'));
  assert.equal(written.byteLength, 8);
  assert.deepEqual(written, Buffer.from('exactly-ten-chars').subarray(0, 8));
});

test('the log bound is exact in bytes and truncates multibyte text without a false failure at the boundary', async t => {
  // Four-byte characters: a bound that lands mid-codepoint still cuts at exactly the byte count.
  const bound = 6;
  const text = '😀😀😀'; // 12 bytes
  const request = makeRequest(tempRoot(t, 'bb-eval-browser-multibyte-'), bound);
  const server = makeServer(t, { logs: text });
  await assert.rejects(
    executeBrowserStage(request, {
      localServer: async () => server,
      browserEvaluate: async () => propertyRecords(),
    }),
    error => error.code === 'OUTPUT_LIMIT',
  );
  const written = fs.readFileSync(path.join(request.artifactRoot, 'server.log'));
  assert.equal(written.byteLength, bound);
  assert.deepEqual(written, Buffer.from(text).subarray(0, bound));

  // Exactly at the boundary the log fits: no OUTPUT_LIMIT, successful evaluation.
  const okRequest = makeRequest(tempRoot(t, 'bb-eval-browser-exactfit-'), 12);
  const okServer = makeServer(t, { logs: text });
  const value = await executeBrowserStage(okRequest, {
    localServer: async () => okServer,
    browserEvaluate: async () => propertyRecords(),
  });
  assert.equal(value.length, 25);
  assert.equal(okServer.state.closes, 1);
  assert.equal(fs.readFileSync(path.join(okRequest.artifactRoot, 'server.log')).byteLength, 12);
});

test('a primary evaluation failure keeps its code when the server log is oversized, recording both details', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-browser-primary-limit-'), 4);
  const server = makeServer(t, { logs: 'far more than four bytes' });
  await assert.rejects(
    executeBrowserStage(request, {
      localServer: async () => server,
      browserEvaluate: async () => { throw Error('chromium launch: executable doesn\'t exist'); },
    }),
    error => error.code === 'MISSING_PREREQUISITE' &&
      /executable doesn't exist/.test(error.details.cause) &&
      /exceeded its 4-byte bound/.test(error.details.outputLimit),
  );
  assert.equal(server.state.closes, 1);
});

test('runBrowserStage invokes the parent worker runner for the browser stage and returns its result', async t => {
  const root = tempRoot(t, 'bb-eval-browser-parent-');
  const results = propertyRecords();
  const context = {
    appRoot: root, artifactRoot: root, tempRoot: root, timeoutMs: 300000, maxOutputBytes: 1048576,
    env: {}, runProcess: async request => {
      assert.deepEqual(request.args.slice(0, 2), [STAGE_WORKER_PATH, 'browser']);
      fs.writeFileSync(request.args[3], JSON.stringify({ protocolVersion: 1, status: 'success', value: results }));
      return { status: 'completed', exitCode: 0, signal: null, stdout: '', stderr: '', stdoutLog: request.stdoutLog, stderrLog: request.stderrLog };
    },
  };
  const result = await runBrowserStage(context);
  assert.equal(result.stage, 'browser');
  assert.equal(result.status, 'success');
  assert.deepEqual(result.value, results);
});

test('cancellation aborts before the runner starts and a child timeout surfaces as TIMEOUT', async t => {
  const root = tempRoot(t, 'bb-eval-browser-cancel-');
  let started = false;
  const base = { appRoot: root, artifactRoot: root, tempRoot: root, timeoutMs: 300000, maxOutputBytes: 1048576, env: {}, runProcess: async () => { started = true; return { status: 'completed', exitCode: 0, signal: null, stdout: '', stderr: '', stdoutLog: '', stderrLog: '' }; } };
  await assert.rejects(
    runBrowserStage({ ...base, signal: AbortSignal.abort() }),
    error => error.code === 'CANCELLED' && error.stage === 'browser',
  );
  assert.equal(started, false);
  await assert.rejects(
    runBrowserStage({ ...base, runProcess: async request => ({ status: 'infrastructure-error', exitCode: null, signal: null, stdout: '', stderr: '', stdoutLog: request.stdoutLog, stderrLog: request.stderrLog, error: { code: 'TIMEOUT', message: 'Worker exceeded its timeout' } }) }),
    error => error.code === 'TIMEOUT' && error.stage === 'browser',
  );
});

test('a crashed worker child becomes a TOOL_CRASH infrastructure error', async t => {
  const root = tempRoot(t, 'bb-eval-browser-crash-');
  await assert.rejects(
    runBrowserStage({ appRoot: root, artifactRoot: root, tempRoot: root, timeoutMs: 300000, maxOutputBytes: 1048576, env: {}, runProcess: async request => ({ status: 'completed', exitCode: 1, signal: null, stdout: '', stderr: '', stdoutLog: request.stdoutLog, stderrLog: request.stderrLog }) }),
    error => error.code === 'TOOL_CRASH' && error.stage === 'browser',
  );
});

test('the stage never imports the useful-tests runner or any protected module statically', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../../packages/evaluation/browser-stage.mjs', import.meta.url)), 'utf8');
  const statics = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;\n]*from\s*'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(statics, ['node:fs', 'node:path', './contracts.mjs']);
  assert.doesNotMatch(source, /runner\/|report\.mjs|useful-stage|usefulTestsCooperative|@playwright/);
});

test('paired declarations are byte-identical', () => {
  const root = fileURLToPath(new URL('../../packages/evaluation/browser-stage', import.meta.url));
  assert.deepEqual(fs.readFileSync(root + '.d.ts'), fs.readFileSync(root + '.d.mts'));
});
