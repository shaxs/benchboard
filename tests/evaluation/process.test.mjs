// Unit tests for the bounded runner using tiny controlled Node children. No server, browser or
// install. Tests own and reap every sentinel child they spawn (the runner reaps its own trees).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../../packages/evaluation/process.mjs';
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from '../../packages/evaluation/contracts.mjs';

const IS_WINDOWS = process.platform === 'win32';
const ENV = {};
for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'HOME']) if (process.env[key]) ENV[key] = process.env[key];

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-eval-process-'));
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, 'ok.mjs'),
    `console.log('hello-out'); console.error('hello-err'); process.exitCode = Number(process.argv[2] ?? 0);\n`);
  fs.writeFileSync(path.join(scripts, 'sleep.mjs'),
    `import fs from 'node:fs';\nif (process.argv[2]) fs.writeFileSync(process.argv[2], String(process.pid));\n` +
    `setTimeout(() => {}, Number(process.argv[3] ?? 60000));\n`);
  fs.writeFileSync(path.join(scripts, 'hold.mjs'),
    `import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], String(process.pid));\nsetTimeout(() => {}, 600000);\n`);
  fs.writeFileSync(path.join(scripts, 'tree.mjs'),
    `import fs from 'node:fs';\nimport { spawn } from 'node:child_process';\n` +
    `import { fileURLToPath } from 'node:url';\n` +
    `fs.writeFileSync(process.argv[2], String(process.pid));\n` +
    `const c = spawn(process.execPath, [fileURLToPath(new URL('./hold.mjs', import.meta.url)), process.argv[3]], { stdio: 'ignore', windowsHide: true });\n` +
    `fs.writeFileSync(process.argv[3], String(c.pid));\n` +
    `setTimeout(() => {}, 600000);\n`);
  fs.writeFileSync(path.join(scripts, 'overflow.mjs'),
    `process.stdout.write('x'.repeat(200000));\nsetTimeout(() => {}, 600000);\n`);
  fs.writeFileSync(path.join(scripts, 'suicide.mjs'),
    `// abort(): a real signal death on POSIX (SIGABRT reported by the OS) and on Windows a raw\n` +
    `// {exitCode:134,signal:null} with NO normal-completion witness (the preload never runs its\n` +
    `// exit hook), so the runner classifies it from genuine facts rather than an inferred signal.\n` +
    `process.abort();\n`);
  fs.writeFileSync(path.join(scripts, 'uncaught.mjs'),
    `throw new Error('controlled uncaught tool failure');\n`);
  fs.writeFileSync(path.join(scripts, 'exitcode.mjs'),
    `process.exit(Number(process.argv[2] ?? 0));\n`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return { root, scripts };
}

function request(scripts, script, overrides = {}) {
  const [scriptName, ...scriptArgs] = script.split(' ');
  return {
    executable: process.execPath,
    args: [path.join(scripts, scriptName), ...scriptArgs],
    cwd: path.dirname(scripts), env: ENV,
    timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    stdoutLog: '', stderrLog: '', ...overrides,
  };
}

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

test('successful run returns bounded evidence and retains both logs', async t => {
  const { root, scripts } = workspace(t);
  const stdoutLog = path.join(root, 'logs', 'stdout.log');
  const stderrLog = path.join(root, 'logs', 'stderr.log');
  const result = await runProcess(request(scripts, 'ok.mjs 0', { stdoutLog, stderrLog }));
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.trim(), 'hello-out');
  assert.equal(result.stderr.trim(), 'hello-err');
  assert.match(fs.readFileSync(stdoutLog, 'utf8'), /hello-out/);
  assert.match(fs.readFileSync(stderrLog, 'utf8'), /hello-err/);
  const witnesses = fs.readdirSync(path.dirname(stdoutLog)).filter(f => f.startsWith('exit-witness-'));
  assert.equal(witnesses.length, 1, 'the bounded witness record is retained as diagnostic evidence');
  const record = JSON.parse(fs.readFileSync(path.join(path.dirname(stdoutLog), witnesses[0]), 'utf8'));
  assert.equal(record.normal, true);
  assert.equal(record.exitCode, 0);
  assert.equal(record.version, 1);
});

test('ordinary nonzero exit is completed evidence, not an infrastructure failure', async t => {
  const { root, scripts } = workspace(t);
  const result = await runProcess(request(scripts, 'ok.mjs 3', {
    stdoutLog: path.join(root, 'stdout.log'), stderrLog: path.join(root, 'stderr.log'),
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 3);
  assert.equal(result.signal, null);
  assert.ok(!('error' in result));
});

test('missing executable is MISSING_PREREQUISITE, distinct from a crashed tool', async t => {
  const { root, scripts } = workspace(t);
  const result = await runProcess(request(scripts, 'ok.mjs 0', {
    executable: path.join(root, 'definitely-missing-executable-12345.exe'), args: [],
    stdoutLog: path.join(root, 'stdout.log'), stderrLog: path.join(root, 'stderr.log'),
  }));
  assert.equal(result.status, 'infrastructure-error');
  assert.equal(result.error.code, 'MISSING_PREREQUISITE');
  assert.equal(result.exitCode, null);
});

// Attempt 2, corrected against raw OS facts and the Captain's fixed witness seam: the previous
// version of this test asserted an inferred terminating signal. On Windows a Node process.abort()
// is raw-indistinguishable from a deliberate exit(134) ({exitCode:134,signal:null} for both), so
// inferring a signal violated unknown-is-null. The runner now consults only genuine facts: an
// actually reported POSIX signal, or the bounded nonce-bound normal-completion witness for the
// real Node executable. A deliberate nonzero exit keeps its code (witness normal:true); an abort
// or uncaught failure is classified from the witness with the ACTUAL raw exit facts in details
// and an unknown signal left null.
test('self-abort is a genuine abnormal classification with actual raw facts and no inferred signal', async t => {
  const { root, scripts } = workspace(t);
  const result = await runProcess(request(scripts, 'suicide.mjs', {
    stdoutLog: path.join(root, 'stdout.log'), stderrLog: path.join(root, 'stderr.log'),
  }));
  assert.equal(result.status, 'infrastructure-error');
  assert.equal(result.error.code, 'TOOL_CRASH');
  if (IS_WINDOWS) {
    // Raw facts are {exitCode:134,signal:null}; abort kills the preload before it can witness,
    // so the honest classification is 'no witness written' with the raw 134 in details, signal null.
    assert.equal(result.error.details.exitCode, 134, 'details carry the actual raw exit code');
    assert.equal(result.error.details.signal, null, 'Windows reports no signal; unknown stays null');
    assert.equal(typeof result.error.details.witness, 'string');
  } else {
    // On POSIX the OS actually reports the terminating signal, so the genuine fact is preserved.
    assert.equal(result.error.details.signal, 'SIGABRT');
    assert.equal(result.error.details.exitCode, null);
  }
  assert.equal(result.exitCode, null, 'infrastructure facts stay unknown, never inferred');
  assert.ok(fs.existsSync(path.join(root, 'stderr.log')), 'diagnostic logs retained');
});

test('deliberate ordinary exit(134) under the witness seam is completed evidence, not a signal death', async t => {
  const { root, scripts } = workspace(t);
  const result = await runProcess(request(scripts, 'exitcode.mjs 134', {
    stdoutLog: path.join(root, 'stdout.log'), stderrLog: path.join(root, 'stderr.log'),
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 134);
  assert.equal(result.signal, null);
});

test('uncaught Node failure is a genuine abnormal classification: raw code, null signal, abnormal witness', async t => {
  const { root, scripts } = workspace(t);
  const result = await runProcess(request(scripts, 'uncaught.mjs', {
    stdoutLog: path.join(root, 'stdout.log'), stderrLog: path.join(root, 'stderr.log'),
  }));
  assert.equal(result.status, 'infrastructure-error');
  assert.equal(result.error.code, 'TOOL_CRASH');
  assert.equal(typeof result.error.details.witness, 'string', 'classification names the witness verdict');
  assert.equal(result.signal, null, 'Windows reports no signal; unknown stays null');
});

test('a nonzero native (non-Node) exit keeps only reported facts: completed, raw code, null signal', async t => {
  // The witness seam applies only to the real Node executable; C4 production tools all run under
  // Node. A native executable's raw facts are preserved exactly, with no synthesized signal.
  const native = IS_WINDOWS
    ? { executable: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/c', 'exit 7'] }
    : { executable: '/bin/sh', args: ['-c', 'exit 7'] };
  const { root, scripts } = workspace(t);
  const result = await runProcess({
    executable: native.executable, args: native.args, cwd: root, env: ENV,
    timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    stdoutLog: path.join(root, 'stdout.log'), stderrLog: path.join(root, 'stderr.log'),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
});

test('timeout kills the owned tree before settling and reports TIMEOUT', async t => {
  const { root, scripts } = workspace(t);
  const pidFile = path.join(root, 'root.pid');
  const gpFile = path.join(root, 'grandchild.pid');
  const controller = new AbortController();
  const promise = runProcess(request(scripts, 'tree.mjs', {
    args: [path.join(scripts, 'tree.mjs'), pidFile, gpFile],
    timeoutMs: 700,
    signal: controller.signal,
    stdoutLog: path.join(root, 'stdout.log'), stderrLog: path.join(root, 'stderr.log'),
  }));
  await waitForFile(gpFile);
  const result = await promise;
  assert.equal(result.status, 'infrastructure-error');
  assert.equal(result.error.code, 'TIMEOUT');
  await waitGone('root', Number(fs.readFileSync(pidFile, 'utf8')));
  await waitGone('grandchild', Number(fs.readFileSync(gpFile, 'utf8')));
});

test('cancellation mid-run reports CANCELLED after reaping the owned tree', async t => {
  const { root, scripts } = workspace(t);
  const pidFile = path.join(root, 'child.pid');
  const controller = new AbortController();
  const promise = runProcess(request(scripts, 'sleep.mjs', {
    args: [path.join(scripts, 'sleep.mjs'), pidFile, '600000'],
    signal: controller.signal,
    stdoutLog: path.join(root, 'stdout.log'), stderrLog: path.join(root, 'stderr.log'),
  }));
  await waitForFile(pidFile);
  controller.abort();
  const result = await promise;
  assert.equal(result.status, 'infrastructure-error');
  assert.equal(result.error.code, 'CANCELLED');
  await waitGone('child', Number(fs.readFileSync(pidFile, 'utf8')));
});

test('already-aborted signal never spawns and returns CANCELLED', async t => {
  const { root, scripts } = workspace(t);
  const pidFile = path.join(root, 'never.pid');
  const stdoutLog = path.join(root, 'stdout.log');
  const result = await runProcess(request(scripts, 'sleep.mjs', {
    args: [path.join(scripts, 'sleep.mjs'), pidFile, '600000'],
    signal: AbortSignal.abort(),
    stdoutLog, stderrLog: path.join(root, 'stderr.log'),
  }));
  assert.equal(result.status, 'infrastructure-error');
  assert.equal(result.error.code, 'CANCELLED');
  assert.equal(result.exitCode, null);
  assert.equal(result.stdout, '');
  assert.equal(fs.readFileSync(stdoutLog, 'utf8'), '');
  assert.ok(!fs.existsSync(pidFile), 'no child was ever started');
});

test('output overflow is capped, reported as OUTPUT_LIMIT and killed', async t => {
  const { root, scripts } = workspace(t);
  const stdoutLog = path.join(root, 'stdout.log');
  const result = await runProcess(request(scripts, 'overflow.mjs', {
    maxOutputBytes: 1000,
    stdoutLog, stderrLog: path.join(root, 'stderr.log'),
  }));
  assert.equal(result.status, 'infrastructure-error');
  assert.equal(result.error.code, 'OUTPUT_LIMIT');
  assert.equal(Buffer.byteLength(result.stdout, 'utf8'), 1000);
  assert.equal(fs.readFileSync(stdoutLog).byteLength, 1000);
});

test('invalid internal arguments throw TypeError before any spawn', async () => {
  const base = {
    executable: process.execPath, args: [], cwd: process.cwd(), env: {},
    timeoutMs: 1000, maxOutputBytes: 1000, stdoutLog: 'C:\\x.log', stderrLog: 'C:\\y.log',
  };
  assert.throws(() => runProcess({ ...base, timeoutMs: Number.POSITIVE_INFINITY }), TypeError);
  assert.throws(() => runProcess({ ...base, timeoutMs: 0 }), TypeError);
  assert.throws(() => runProcess({ ...base, maxOutputBytes: 0 }), TypeError);
  assert.throws(() => runProcess({ ...base, args: 'not-array' }), TypeError);
  assert.throws(() => runProcess({ ...base, executable: 'relative.exe' }), TypeError);
  assert.throws(() => runProcess({ ...base, signal: 'yes' }), TypeError);
  assert.throws(() => runProcess({ ...base, stdoutLog: 'rel.log' }), TypeError);
});

test('paired process declarations are byte-identical', () => {
  const root = new URL(`../../packages/evaluation/process`, import.meta.url);
  assert.deepEqual(fs.readFileSync(fileURLToPath(root) + '.d.ts'), fs.readFileSync(fileURLToPath(root) + '.d.mts'));
});
