// C4.S4.T2 — bounded output and mutation domain acceptance (adversarial-output half).
//
// Controlled output-flood acceptance for the bounded runner and for the internal controller using
// the SAME real runProcess. Every child is a tiny owned Node script launched through the real
// runner only — no tsc, vite, vitest, Chromium, server, network or install — and every flood is
// bounded to about 1MB total so memory and disk stay bounded while the runner still sees a
// genuine over-bound burst. The root PID is captured from the child's own readiness file (the
// exact PID the child wrote for itself), never from an arbitrary numeric field; a pre-registered
// emergency cleanup reaps ONLY that known-positive PID if a test failed before the runner settled,
// never this test process and never anything process-wide, and it kills no canary or service.
//
// Raw-PID capture timing and actual scope: the child writes its readiness file as its very first
// action, before any flood byte, so once the readiness file exists the captured PID names the
// flooded root for the whole remainder of the run; the readiness file is awaited before the runner
// result is awaited, mirroring the accepted T1 process tests. Liveness is then measured directly AT
// runner return: flood() records pidGone(rootPid) on the very next statement after the awaited
// promise resolves — before any wait, reaper or cleanup — and every flood case asserts that fact
// true; the controller case wraps only the real runProcess and samples the known readiness-file
// PID's liveness at the runner's own return, strictly before the controller's cleanup phase. The
// bounded waitGone helper exists solely for the pre-registered emergency reaper's own post-kill
// confirmation; it is NOT presented as return-time proof. If the at-return liveness fact is false,
// the test fails and reports the actual observation — no retry, no weakening, no product fix.
// Scope of the runner kill is exactly its own spawned tree; no other process is signalled.
//
// Controller proof: the real controller stages a fresh frozen copy, then the REAL typecheck stage
// drives the REAL runProcess against a tiny controlled "typecheck tool" (a plain Node script
// placed in the test-owned prepared-dependency root, never a real tsc) whose output exceeds the
// small request bound. No stage override fakes the output failure. Later stages use the accepted
// recording collaborators and must never run. The result is the infra OUTPUT_LIMIT at typecheck
// with a null top-level score and no evidence; no bundle can exist for an infrastructure result
// (the accepted S2 assembler gate is asserted once on the actual result object). Scratch is fully
// removed with empty residue/errors, retained logs are within the bound, and both protected input
// digests are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../../packages/evaluation/process.mjs';
import { runTypecheckStage } from '../../packages/evaluation/tool-stages.mjs';
import { evaluateWithRuntime } from '../../packages/evaluation/controller.mjs';
import { assembleEvidenceBundle } from '../../packages/evaluation/bundle.mjs';
import { EvaluationIntegrityError } from '../../packages/evaluation/bundle-contract.mjs';
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from '../../packages/evaluation/contracts.mjs';
import { createFrozenFixture, snapshotInputs, assertInputsUnchanged } from './helpers.mjs';

const ENV = {};
for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'HOME']) if (process.env[key]) ENV[key] = process.env[key];
const FLOOD_TOTAL_BYTES = 1048576; // ~1MB: clearly over every bound below, yet bounded itself

function pidGone(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
}
async function waitGone(label, pid, limitMs = 15000) {
  const deadline = Date.now() + limitMs;
  while (!pidGone(pid)) {
    if (Date.now() > deadline) throw new Error(`${label} pid ${pid} still alive after ${limitMs}ms`);
    await new Promise(r => setTimeout(r, 50));
  }
}
async function waitForFile(file, limitMs = 15000) {
  const deadline = Date.now() + limitMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${file} never appeared`);
    await new Promise(r => setTimeout(r, 50));
  }
}

// Pre-registered emergency reaper: registered BEFORE any run starts and given only the readiness
// file paths, so at teardown it can signal nothing except a known-positive PID that file names,
// and only when it is still alive. It never signals this test process, never a process-wide tree
// and never an arbitrary pid.
function emergencyReaper(t) {
  const readinessFiles = [];
  t.after(async () => {
    for (const file of readinessFiles) {
      let pid = Number.NaN;
      try { pid = Number(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
      if (pidGone(pid)) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      await waitGone('emergency', pid, 5000);
    }
  });
  return readinessFiles;
}

// The only flood worker: writes its own PID first (readiness), then bounded chunks on the
// requested streams, then idles so the runner must kill it. Never an infinite producer.
function floodScript(dir) {
  const file = path.join(dir, 'flood.mjs');
  fs.writeFileSync(file,
    `import fs from 'node:fs';\n` +
    `fs.writeFileSync(process.argv[2], String(process.pid));\n` +
    `const mode = process.argv[3];\n` +
    `const chunk = 'x'.repeat(4096);\n` +
    `let written = 0;\n` +
    `const interval = setInterval(() => {\n` +
    `  if (written >= Number(process.argv[4])) { clearInterval(interval); return; }\n` +
    `  if (mode !== 'stderr') process.stdout.write(chunk);\n` +
    `  if (mode !== 'stdout') process.stderr.write(chunk);\n` +
    `  written += chunk.length;\n` +
    `}, 2);\n` +
    `setTimeout(() => {}, 30000);\n`);
  return file;
}

function floodRequest(scripts, readinessFiles, { mode, maxOutputBytes, stdoutLog, stderrLog }) {
  const readiness = path.join(path.dirname(stdoutLog), 'root.pid');
  readinessFiles.push(readiness); // registered before the run starts, resolved only to the file's own pid
  return {
    base: {
      executable: process.execPath,
      args: [scripts, readiness, mode, String(FLOOD_TOTAL_BYTES)],
      cwd: path.dirname(scripts), env: ENV,
      timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes,
      stdoutLog, stderrLog,
    },
    readiness,
  };
}

async function flood(t, readinessFiles, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-eval-adversarial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const scripts = floodScript(root);
  const logDir = path.join(root, 'logs');
  const { base, readiness } = floodRequest(scripts, readinessFiles, {
    stdoutLog: path.join(logDir, 'stdout.log'), stderrLog: path.join(logDir, 'stderr.log'), ...options,
  });
  const promise = runProcess(base);
  await waitForFile(readiness);
  const rootPid = Number(fs.readFileSync(readiness, 'utf8'));
  assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0 && rootPid !== process.pid, 'the captured root PID is the child-reported positive pid');
  const result = await promise;
  // The demanded absence fact: sampled on the first statement after the runner resolves, before
  // any wait, reaper action or cleanup. It is returned verbatim; nothing here re-samples it.
  const rootGoneAtReturn = pidGone(rootPid);
  return { result, rootPid, rootGoneAtReturn, logDir };
}

function assertWithinBound(bytes, bound, label) {
  assert.ok(bytes <= bound, `${label} retained ${bytes} bytes must stay within the ${bound}-byte bound`);
}

/* ---------- 2. the real bounded runner against controlled floods ---------- */

test('a controlled stdout flood settles as infrastructure OUTPUT_LIMIT, caps both retained logs and leaves the root gone', async t => {
  const reaper = emergencyReaper(t);
  for (const bound of [256, 1024]) {
    const { result, rootPid, rootGoneAtReturn, logDir } = await flood(t, reaper, { mode: 'stdout', maxOutputBytes: bound });
    assert.equal(rootGoneAtReturn, true, 'the root PID must be gone AT runner return (bound ' + bound + '), not merely eventually');
    assert.equal(result.status, 'infrastructure-error', 'a flood is never completed evidence, whatever the exit code would have been');
    assert.equal(result.error.code, 'OUTPUT_LIMIT');
    assert.equal(result.exitCode, null, 'infrastructure facts stay unknown, never inferred from the flood');
    assertWithinBound(Buffer.byteLength(result.stdout, 'utf8'), bound, 'returned stdout');
    assertWithinBound(fs.readFileSync(path.join(logDir, 'stdout.log')).byteLength, bound, 'retained stdout log');
    assertWithinBound(fs.readFileSync(path.join(logDir, 'stderr.log')).byteLength, bound, 'retained stderr log');
  }
});

test('a controlled stderr-only flood trips the bound on stderr alone, with an empty stderr-capped log pair', async t => {
  const reaper = emergencyReaper(t);
  const { result, rootPid, rootGoneAtReturn, logDir } = await flood(t, reaper, { mode: 'stderr', maxOutputBytes: 1024 });
  assert.equal(rootGoneAtReturn, true, 'the stderr-flood root PID must be gone AT runner return');
  assert.equal(result.status, 'infrastructure-error');
  assert.equal(result.error.code, 'OUTPUT_LIMIT');
  assert.match(result.error.message, /stderr/, 'the bound breach names the flooded stream');
  assertWithinBound(fs.readFileSync(path.join(logDir, 'stdout.log')).byteLength, 1024, 'quiet stdout log');
  assertWithinBound(fs.readFileSync(path.join(logDir, 'stderr.log')).byteLength, 1024, 'flooded stderr log');
});

test('a combined stdout+stderr flood stays bounded on both streams separately', async t => {
  const reaper = emergencyReaper(t);
  const { result, rootPid, rootGoneAtReturn, logDir } = await flood(t, reaper, { mode: 'both', maxOutputBytes: 1024 });
  assert.equal(rootGoneAtReturn, true, 'the combined-flood root PID must be gone AT runner return');
  assert.equal(result.status, 'infrastructure-error');
  assert.equal(result.error.code, 'OUTPUT_LIMIT');
  assertWithinBound(Buffer.byteLength(result.stdout, 'utf8'), 1024, 'combined-run stdout');
  assertWithinBound(Buffer.byteLength(result.stderr, 'utf8'), 1024, 'combined-run stderr');
  assertWithinBound(fs.readFileSync(path.join(logDir, 'stdout.log')).byteLength, 1024, 'combined-run stdout log');
  assertWithinBound(fs.readFileSync(path.join(logDir, 'stderr.log')).byteLength, 1024, 'combined-run stderr log');
});

/* ---------- 3. the internal controller through the same real runner ---------- */

test('the internal controller reports infra OUTPUT_LIMIT at typecheck from the real runner, stops later stages and cleans up fully', async t => {
  const reaper = emergencyReaper(t);
  const fixture = await createFrozenFixture(t);
  const before = snapshotInputs(fixture);

  // Test-owned prepared-dependency root: three plain Node placeholders, the "typecheck tool"
  // being a bounded flood script — never a real tsc, vite or vitest. The readiness path is baked
  // in because the stage call shape is fixed (the tool only receives --noEmit).
  const dependencyRoot = path.join(fixture.root, 'flood-dependencies');
  const readiness = path.join(fixture.root, 'typecheck-root.pid');
  reaper.push(readiness);
  fs.mkdirSync(path.join(dependencyRoot, 'typescript/bin'), { recursive: true });
  fs.mkdirSync(path.join(dependencyRoot, 'vite/bin'), { recursive: true });
  fs.mkdirSync(path.join(dependencyRoot, 'vitest'), { recursive: true });
  fs.writeFileSync(path.join(dependencyRoot, 'typescript/bin/tsc'),
    `import fs from 'node:fs';\n` +
    `fs.writeFileSync(${JSON.stringify(readiness)}, String(process.pid));\n` +
    `const chunk = 'x'.repeat(4096);\n` +
    `let written = 0;\n` +
    `const interval = setInterval(() => {\n` +
    `  if (written >= ${FLOOD_TOTAL_BYTES}) { clearInterval(interval); return; }\n` +
    `  process.stdout.write(chunk);\n` +
    `  written += chunk.length;\n` +
    `}, 2);\n` +
    `setTimeout(() => {}, 30000);\n`);
  fs.writeFileSync(path.join(dependencyRoot, 'vite/bin/vite.js'), '// unused placeholder\n');
  fs.writeFileSync(path.join(dependencyRoot, 'vitest/vitest.mjs'), '// unused placeholder\n');

  const bound = 4096; // a request-level bound the ~1MB controlled flood genuinely exceeds
  fixture.runtime.dependencyRoot = dependencyRoot;
  // The SAME real bounded runner, wrapped only to observe the known readiness-file PID's liveness
  // directly at the runner's own return — strictly before the controller's finally/cleanup phase.
  // The wrapper changes nothing: the exact runProcess result object is returned unchanged, and a
  // missing or unreadable readiness file is recorded as a null fact, never as a fake failure.
  const runnerReturns = [];
  fixture.runtime.runProcess = async request => {
    const processResult = await runProcess(request);
    let observedPid = Number.NaN;
    let goneAtRunnerReturn = null;
    try {
      const value = Number(fs.readFileSync(readiness, 'utf8'));
      if (Number.isSafeInteger(value) && value > 0) {
        observedPid = value;
        goneAtRunnerReturn = pidGone(value);
      }
    } catch { /* absence is recorded honestly as a null fact */ }
    runnerReturns.push({ observedPid, goneAtRunnerReturn });
    return processResult;
  };
  fixture.runtime.stageOverrides.typecheck = runTypecheckStage; // real stage: no faked output failure

  const result = await evaluateWithRuntime({ ...fixture.request, maxOutputBytes: bound }, fixture.runtime);
  // Controller-return fact is a later sample with no test-side wait/reaper. The earlier runner
  // sample above, not this later observation, proves absence before controller cleanup.
  const controllerReturnObservation = runnerReturns.length === 1 ? pidGone(runnerReturns[0].observedPid) : null;

  assert.equal(result.status, 'infrastructure-error');
  assert.equal(result.error.code, 'OUTPUT_LIMIT');
  assert.equal(result.error.stage, 'typecheck');
  assert.equal(result.score, null, 'an infrastructure result carries no score');
  assert.equal(result.evidence, null, 'an infrastructure result carries no evidence');
  // No bundle after the internal attachment's infra projection: the accepted S2 gate rejects this
  // very result object, so no EvidenceBundle can exist for an infrastructure outcome.
  assert.throws(() => assembleEvidenceBundle({ result, identities: {}, artifactDigests: [] }), error => error instanceof EvaluationIntegrityError);

  // Later stages recorded if called — none was. The accepted recording collaborators push a context
  // per invocation, and the event log shows the run ended right after the typecheck stage.
  assert.deepEqual(fixture.contexts, [], 'no later stage collaborator may run after the typecheck output failure');
  const eventNames = fixture.events.map(event => event.name);
  assert.ok(eventNames.includes('typecheck') && !eventNames.includes('build') && !eventNames.includes('visible') &&
    !eventNames.includes('browser') && !eventNames.includes('useful') && !eventNames.includes('inspection'),
  'the stage loop stops at the first infrastructure failure: ' + eventNames.join(','));

  // Full cleanup and bounded retention.
  assert.equal(result.cleanup.removed, true, 'scratch removal must be confirmed');
  assert.deepEqual(result.cleanup.residue, []);
  assert.deepEqual(result.cleanup.errors, []);
  assert.ok(!fs.readdirSync(fixture.request.outputRoot).some(name => name.startsWith('scratch-')), 'no scratch directory survives under the output root');
  assert.ok(result.artifacts.includes('typecheck/typecheck.stdout.log'), 'the flooded stage log is retained');
  for (const relative of result.artifacts.filter(name => name.startsWith('typecheck/'))) {
    const size = fs.statSync(path.join(fixture.request.outputRoot, relative)).size;
    assertWithinBound(size, bound, 'retained typecheck artifact ' + relative);
  }
  // The exact flood-root PID from the readiness file: the at-runner-return fact was sampled by the
  // observing wrapper BEFORE the controller's cleanup phase, and the controller-return fact was
  // sampled directly after evaluateWithRuntime resolved — no test-side wait or reaper preceded it.
  const rootPid = Number(fs.readFileSync(readiness, 'utf8'));
  assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0 && rootPid !== process.pid);
  assert.equal(runnerReturns.length, 1, 'exactly one real runProcess call occurred (the typecheck flood)');
  assert.equal(runnerReturns[0].observedPid, rootPid, 'the wrapper observed exactly the known readiness-file child pid');
  assert.equal(runnerReturns[0].goneAtRunnerReturn, true, 'the flood root must be gone AT runner return, before any controller cleanup');
  assert.equal(controllerReturnObservation, true, 'the flood root must still be reported gone AT controller return');
  // Foreign-file safety: both protected input domains are byte-identical.
  assertInputsUnchanged(fixture, before);
});
