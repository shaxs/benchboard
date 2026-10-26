import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvaluationInfrastructureError, STAGE_WORKER_PATH } from '../../packages/evaluation/contracts.mjs';
import { executeUsefulTestsStage, runUsefulTestsStage } from '../../packages/evaluation/useful-stage.mjs';

const MISSING_MESSAGE = "node:internal/modules/cjs/wrappers/loader: cannot find package 'vitest'";

function zeroAdded() {
  return Object.freeze({ addedCount: 0, baselinePassed: false, killedMutations: Object.freeze([]) });
}

function nonzeroResult() {
  return Object.freeze({
    addedCount: 4, baselinePassed: true,
    killedMutations: Object.freeze(['storage-drop', 'focus-drop']),
    method: 'Five independent fault domains: persistence, interaction, accessibility, normalization, chronology; added tests alone; no test-count reward',
  });
}

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeRequest(root) {
  const artifactRoot = path.join(root, 'artifacts', 'useful');
  return Object.freeze(Object.freeze({
    protocolVersion: 1, appRoot: path.join(root, 'app'), artifactRoot,
    tempRoot: path.join(root, 'temp'), maxOutputBytes: 1048576,
  }));
}

function makeParentContext(root, overrides = {}) {
  return {
    appRoot: root, artifactRoot: root, tempRoot: root, timeoutMs: 300000, maxOutputBytes: 1048576,
    env: {}, runProcess: async request => {
      assert.deepEqual(request.args.slice(0, 2), [STAGE_WORKER_PATH, 'useful']);
      fs.writeFileSync(request.args[3], JSON.stringify({ protocolVersion: 1, status: 'success', value: nonzeroResult() }));
      return { status: 'completed', exitCode: 0, signal: null, stdout: '', stderr: '', stdoutLog: request.stdoutLog, stderrLog: request.stderrLog };
    },
    ...overrides,
  };
}

test('executeUsefulTestsStage calls the collaborator with exactly appRoot and artifactRoot and forwards its exact value', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-useful-zero-'));
  const zero = zeroAdded();
  const calls = [];
  const value = await executeUsefulTestsStage(request, {
    usefulTestsCooperative: (...args) => { calls.push(args); return zero; },
  });
  assert.deepEqual(calls, [[request.appRoot, request.artifactRoot]]);
  assert.equal(value, zero);
  assert.deepEqual(value, { addedCount: 0, baselinePassed: false, killedMutations: [] });
});

test('a nonzero useful-tests result is forwarded byte-for-byte with all five mutation names untouched', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-useful-nonzero-'));
  const full = nonzeroResult();
  const value = await executeUsefulTestsStage(request, {
    usefulTestsCooperative: () => full,
  });
  assert.equal(value, full);
  assert.deepEqual(value.killedMutations, ['storage-drop', 'focus-drop']);
  assert.equal(value.addedCount, 4);
  assert.equal(value.baselinePassed, true);
});

test('a promise-returning collaborator is awaited and its resolved value is the returned value', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-useful-promise-'));
  const full = nonzeroResult();
  const value = await executeUsefulTestsStage(request, {
    usefulTestsCooperative: async () => full,
  });
  assert.equal(value, full);
});

test('the default collaborator is the unchanged evaluator module and the five fixed mutation names stay intact', async t => {
  tempRoot(t, 'bb-eval-useful-default-');
  const module = await import('../../evaluator/useful-tests.mjs');
  assert.equal(typeof module.usefulTestsCooperative, 'function');
  assert.deepEqual([...module.usefulMutations], ['storage-drop', 'input-drop', 'focus-drop', 'label-case', 'date-order']);
  assert.equal(module.usefulMutations.length, 5);
});

test('a synchronous collaborator crash leaves no partial score and the nested scratch is still removed', async t => {
  const root = tempRoot(t, 'bb-eval-useful-crash-');
  const request = makeRequest(root);
  // Owns a tiny child scratch exactly like the cooperative module does (created inside a try and
  // removed in its own finally), so the nested-cleanup contract is exercised without
  // reimplementing any useful-test semantics. The stage must still fail closed: a throw, never a
  // partial score.
  const scratchRoot = path.join(root, 'temp');
  fs.mkdirSync(scratchRoot, { recursive: true });
  let scratchSeen = null;
  await assert.rejects(
    executeUsefulTestsStage(request, {
      usefulTestsCooperative: () => {
        const scratch = fs.mkdtempSync(path.join(scratchRoot, 'bb-useful-'));
        scratchSeen = scratch;
        try {
          fs.writeFileSync(path.join(scratch, 'partial.json'), '{"numTotalTests":1}');
          throw Error('vitest child exited with SIGKILL');
        } finally {
          fs.rmSync(scratch, { recursive: true, force: true });
        }
      },
    }),
    error => error instanceof EvaluationInfrastructureError && error.stage === 'useful' &&
      error.code === 'TOOL_CRASH' && /SIGKILL/.test(error.details.cause),
  );
  assert.ok(scratchSeen);
  assert.equal(fs.existsSync(scratchSeen), false);
  assert.equal(fs.existsSync(path.join(request.artifactRoot, 'useful.json')), false);
});

test('a collaborator that itself cleaned up before throwing still yields no returned value on failure', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-useful-cleanup-'));
  await assert.rejects(
    executeUsefulTestsStage(request, {
      usefulTestsCooperative: () => { throw Error('baseline report is not valid JSON'); },
    }),
    error => error.code === 'TOOL_CRASH' && error.stage === 'useful',
  );
});

test('a missing prerequisite surfaces as MISSING_PREREQUISITE, never as a partial score', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-useful-missing-'));
  await assert.rejects(
    executeUsefulTestsStage(request, {
      usefulTestsCooperative: () => { throw Error(MISSING_MESSAGE); },
    }),
    error => error instanceof EvaluationInfrastructureError && error.code === 'MISSING_PREREQUISITE' &&
      error.stage === 'useful',
  );
});

test('an infrastructure error from the collaborator passes through unchanged', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-useful-passthru-'));
  const original = new EvaluationInfrastructureError('useful', 'CANCELLED', 'Evaluation cancelled');
  await assert.rejects(
    executeUsefulTestsStage(request, {
      usefulTestsCooperative: () => { throw original; },
    }),
    error => error === original,
  );
});

test('the raw ETIMEDOUT error rethrown by the nested spawnSync is a TIMEOUT infrastructure error with its cause preserved', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-useful-etimedout-'));
  // Exactly the shape the unchanged usefulTestsCooperative rethrows when its 60000-ms nested
  // spawnSync expires: a plain error carrying code 'ETIMEDOUT'.
  const raw = Error("spawnSync 'node' ETIMEDOUT");
  raw.code = 'ETIMEDOUT';
  let returned = false;
  try {
    await executeUsefulTestsStage(request, { usefulTestsCooperative: () => { throw raw; } });
    returned = true;
  } catch (error) {
    assert.ok(error instanceof EvaluationInfrastructureError);
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.stage, 'useful');
    assert.match(error.details.cause, /ETIMEDOUT/);
  }
  assert.equal(returned, false, 'a timed-out nested tool must never yield a useful-tests value');
});

test('an explicit timed-out tool message classifies as TIMEOUT even without an error code', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-useful-msgtimeout-'));
  await assert.rejects(
    executeUsefulTestsStage(request, {
      usefulTestsCooperative: () => { throw Error('vitest run timed out after 60000ms'); },
    }),
    error => error instanceof EvaluationInfrastructureError && error.code === 'TIMEOUT' &&
      error.stage === 'useful' && /timed out/.test(error.details.cause),
  );
});

test('a genuine non-timeout crash still classifies as TOOL_CRASH, not TIMEOUT, with no returned value', async t => {
  const request = makeRequest(tempRoot(t, 'bb-eval-useful-genuine-crash-'));
  const crash = Error('vitest worker crashed: assertion 0xdeadbeef');
  crash.code = 'ERR_INTERNAL_ASSERTION';
  await assert.rejects(
    executeUsefulTestsStage(request, {
      usefulTestsCooperative: () => { throw crash; },
    }),
    error => error instanceof EvaluationInfrastructureError && error.code === 'TOOL_CRASH' &&
      error.stage === 'useful' && /crashed/.test(error.details.cause),
  );
});

test('runUsefulTestsStage invokes the parent worker runner for the useful stage and returns its result', async t => {
  const root = tempRoot(t, 'bb-eval-useful-parent-');
  const result = await runUsefulTestsStage(makeParentContext(root));
  assert.equal(result.stage, 'useful');
  assert.equal(result.status, 'success');
  assert.deepEqual(result.value, nonzeroResult());
});

test('cancellation aborts before the runner starts and a child timeout surfaces as TIMEOUT with no value', async t => {
  const root = tempRoot(t, 'bb-eval-useful-cancel-');
  let started = false;
  const base = makeParentContext(root);
  await assert.rejects(
    runUsefulTestsStage({ ...base, signal: AbortSignal.abort() }),
    error => error.code === 'CANCELLED' && error.stage === 'useful',
  );
  assert.equal(started, false);
  await assert.rejects(
    runUsefulTestsStage({ ...base, runProcess: async request => ({ status: 'infrastructure-error', exitCode: null, signal: null, stdout: '', stderr: '', stdoutLog: request.stdoutLog, stderrLog: request.stderrLog, error: { code: 'TIMEOUT', message: 'Worker exceeded its timeout' } }) }),
    error => error.code === 'TIMEOUT' && error.stage === 'useful',
  );
});

test('a timed-out child result and a crashed worker child both fail closed without partial evidence', async t => {
  // The child wrote a result envelope that reports infrastructure failure: the parent must not
  // read it as a value. Separate artifact roots because the protocol writes its request wx-only.
  await assert.rejects(
    runUsefulTestsStage({ ...makeParentContext(tempRoot(t, 'bb-eval-useful-closed-')), runProcess: async request => {
      fs.writeFileSync(request.args[3], JSON.stringify({ protocolVersion: 1, status: 'infrastructure-error', error: { code: 'TIMEOUT', message: 'Worker exceeded its timeout' } }));
      return { status: 'completed', exitCode: 0, signal: null, stdout: '', stderr: '', stdoutLog: request.stdoutLog, stderrLog: request.stderrLog };
    } }),
    error => error.code === 'TIMEOUT' && error.stage === 'useful',
  );
  await assert.rejects(
    runUsefulTestsStage({ ...makeParentContext(tempRoot(t, 'bb-eval-useful-crash-')), runProcess: async request => ({ status: 'completed', exitCode: 1, signal: null, stdout: '', stderr: '', stdoutLog: request.stdoutLog, stderrLog: request.stderrLog }) }),
    error => error.code === 'TOOL_CRASH' && error.stage === 'useful',
  );
});

test('the stage never imports the real useful-tests runner, a process module, or any protected module statically', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../../packages/evaluation/useful-stage.mjs', import.meta.url)), 'utf8');
  const statics = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;\n]*from\s*'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(statics, ['./contracts.mjs']);
  assert.doesNotMatch(source, /runner\/|report\.mjs|browser-stage|usefulTestsTrusted|node:child_process|spawnSync|process\.env|@playwright/);
});

test('paired declarations are byte-identical', () => {
  const root = fileURLToPath(new URL('../../packages/evaluation/useful-stage', import.meta.url));
  assert.deepEqual(fs.readFileSync(root + '.d.ts'), fs.readFileSync(root + '.d.mts'));
});
