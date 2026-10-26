// C4.S1.T4b — independent failure and cleanup acceptance (Captain-fixed case matrix; test only).
//
// Real C3 verification and filesystem containment stay live; the accepted T4a helpers build fresh
// frozen fixtures; the REAL T2 bounded runner (packages/evaluation/process.mjs) drives every
// timeout, cancellation and crash fault. Attempt-2 rework (Captain-fixed): liveness is captured as
// IMMEDIATE raw facts at the exact runProcess-return boundary — synchronously on runner settle,
// BEFORE any controller cleanup or extra awaits — and those captured booleans are asserted verbatim
// (never polled into truth). Useful/server sentinels own a real ready-verified hold.mjs descendant
// and publish BOTH pids in their metadata before sleeping or aborting, so the settlement-boundary
// snapshot proves the runner reaped the whole owned tree, not just a root. Fault fixtures register
// failure-safe emergency cleanup for exactly their own recorded pids, bounded, after the acceptance
// snapshot was already captured (cleanup can never turn a red liveness fact green). The external
// canary lives in a per-run mkdtempSync-exclusive root whose only removal is registered. The
// "server/browser" fault branches are CONTROLLED FAULT-SEAM SENTINELS (a loopback Node server and
// Node workers): NO real Chromium is launched and production evaluateFrozen is never called here —
// real reference browser execution is owned by T4c. Missing-tool and missing-dependencies inputs are
// genuine staging-preflight faults (preflight stage, tool named); missing-browser is an injected
// prerequisite failure expressed through the real worker-result protocol, never an
// environment-cache override. Retained per-stage artifacts live in outputRoot/<stage>/, which
// survives scratch cleanup, so settlement-boundary witnesses are readable after the run.
// Child/temp roots used by sentinels are the controller's own claim.tempRoot.
//
// C4.S1.T4b.R reserve repair (attempt 1 on reserve), all changes confined to this file:
// (a) emergency reap selects ONLY the whitelisted `pid`/`child` keys of the fully-acquired
//     metadata PLUS the explicitly registered early-readiness PID files — never other metadata
//     numbers (a negative control's exitCode:1 was previously a kill candidate); every candidate
//     must be a safe integer > 1 and not process.pid, and an unsafe registered PID is rejected
//     with a diagnostic, never killed; (b) the per-test FaultWatch is created by the local
//     createCaseFixture BEFORE createFrozenFixture registers its recursive-removal hook, so
//     node:test's after-hook registration-order execution runs the snapshot/emergency-reap guard
//     BEFORE the fixture or fault directories are removed; the guard hook itself is try/finally
//     so a failing snapshot cannot skip the reap; (c) partial acquisition: sentinels write their
//     OWN root PID early (before spawning the hold child) and the hold child writes its own
//     readiness PID — both files' exact paths are registered while the fixture is still
//     known-owned, so emergency cleanup can read them even when the fully-acquired meta.json was
//     never published; the cancel-on-acquire watcher still keys on the FULL meta.json only, and
//     the full metadata is still published last.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../../packages/evaluation/process.mjs';
import { requireCompleted, stageSuccess, WORKER_PROTOCOL_VERSION } from '../../packages/evaluation/contracts.mjs';
import { runTypecheckStage, runBuildStage, runVisibleStage } from '../../packages/evaluation/tool-stages.mjs';
import { runBrowserStage } from '../../packages/evaluation/browser-stage.mjs';
import { evaluateWithRuntime } from '../../packages/evaluation/controller.mjs';
import { createFrozenFixture, snapshotInputs, assertInputsUnchanged } from './helpers.mjs';

const STAGE_ORDER = ['typecheck', 'build', 'visible', 'browser', 'useful', 'inspection'];
const FULL_SUCCESS_EVENTS = ['verify-before', 'copy-frozen', 'canonical-replacement', 'prepared-dependencies',
  'typecheck', 'build', 'visible', 'browser', 'useful', 'verify-after', 'inspection', 'cleanup'];

// ---------------------------------------------------------------- unique external canary root
// A per-run mkdtempSync-exclusive directory (never a shared fixed name) holding only this run's
// canary. The ONLY removal ever registered is for this exact owned directory; every
// canary-survival assertion below reads it back unchanged.
const CANARY_DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bb-eval-t4b-canary-'));
const CANARY_TEXT = 'foreign-owner-bytes-must-never-be-touched\n';
fs.writeFileSync(path.join(CANARY_DIR, 'canary.bin'), CANARY_TEXT, { flag: 'wx' });
test.after(() => fs.rmSync(CANARY_DIR, { recursive: true, force: true, maxRetries: 10 }));
const CANARY_FILE = path.join(CANARY_DIR, 'canary.bin');
function assertCanaryIntact() {
  assert.equal(fs.readFileSync(CANARY_FILE, 'utf8'), CANARY_TEXT, 'the foreign ownership canary in the run-exclusive external root survives untouched');
}

// ---------------------------------------------------------------- fault fixture sources
// Fault sources import ./common.mjs (written into every fault directory). Full acquisition is
// signalled by writing FAULT_META LAST — after the loopback bind, nested-scratch publication and
// the hold descendant's readiness pid file — so the cancel-on-acquire watchers never race a
// half-acquired sentinel. In addition, the sentinel root writes its own PID to the registered
// ROOT PID file EARLY (before spawning the hold child), and the hold child writes its own
// readiness PID — those two early files are the explicit partial-acquisition witnesses that
// emergency cleanup may read when the full meta.json was never published.
const COMMON_MJS = `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitFor(file, limitMs = 10000) {
  const deadline = Date.now() + limitMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + file);
    await delay(25);
  }
}
export async function spawnHold() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./hold.mjs', import.meta.url)), process.env.FAULT_CHILD],
    { stdio: 'ignore', windowsHide: true });
  await waitFor(process.env.FAULT_CHILD);
  return Number(fs.readFileSync(process.env.FAULT_CHILD, 'utf8').trim());
}
`;
const HOLD_MJS = `import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], String(process.pid));\nsetTimeout(() => {}, 300000);\n`;
const FAULT_SOURCES = Object.freeze({
  // Staged-tool stand-in: records its pid, then outlives the bounded deadline.
  sleep: `import fs from 'node:fs';
fs.writeFileSync(process.env.FAULT_META, JSON.stringify({ pid: process.pid }));
setTimeout(() => {}, 300000);
`,
  // Staged-tool stand-in: an ordinary completed exit with the caller-chosen code.
  exit: `import fs from 'node:fs';
fs.writeFileSync(process.env.FAULT_META, JSON.stringify({ pid: process.pid, exitCode: Number(process.env.FAULT_EXIT) }));
process.exit(Number(process.env.FAULT_EXIT));
`,
  // Staged-tool stand-in for the visible stage: pid, a valid 17/17 JSON report, then the exit code.
  visible: `import fs from 'node:fs';
fs.writeFileSync(process.env.FAULT_META, JSON.stringify({ pid: process.pid, exitCode: Number(process.env.FAULT_EXIT) }));
const output = (process.env.FAULT_ARGS ?? '').split(' ').find(a => a.startsWith('--outputFile='));
if (output) fs.writeFileSync(output.slice('--outputFile='.length), JSON.stringify({ numPassedTests: 17, numTotalTests: 17 }));
process.exit(Number(process.env.FAULT_EXIT));
`,
  // Staged-tool stand-in: an abrupt self-termination, not an ordinary exit.
  crash: `process.abort();
`,
  // Controlled server/browser sentinel (NOT a real Chromium): binds a loopback port, writes its
  // OWN root PID early, acquires a ready-verified hold descendant, then publishes the full
  // pid+port+child metadata last and outlives the deadline.
  server: `import fs from 'node:fs';
import net from 'node:net';
import { spawnHold } from './common.mjs';
const server = net.createServer(() => {});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(process.env.FAULT_ROOT_PID, String(process.pid));
const child = await spawnHold();
fs.writeFileSync(process.env.FAULT_META, JSON.stringify({ pid: process.pid, port: server.address().port, child }));
setTimeout(() => {}, 300000);
`,
  // Controlled browser-worker sentinel: loopback port + READY-verified Node descendant, published
  // first, and only then does it die abruptly — a pid value alone would not prove it started.
  'crash-browser': `import fs from 'node:fs';
import net from 'node:net';
import { spawnHold } from './common.mjs';
const server = net.createServer(() => {});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(process.env.FAULT_ROOT_PID, String(process.pid));
const child = await spawnHold();
fs.writeFileSync(process.env.FAULT_META, JSON.stringify({ pid: process.pid, port: server.address().port, child }));
process.abort();
`,
  // Controlled useful-worker sentinel: nested scratch under the private temp root, a ready-verified
  // hold descendant, full acquisition published last, then it outlives the deadline.
  useful: `import fs from 'node:fs';
import { spawnHold } from './common.mjs';
fs.mkdirSync(process.env.FAULT_NESTED, { recursive: true });
fs.writeFileSync(process.env.FAULT_NESTED + '/mutation-state.json', '{"started":true}');
fs.writeFileSync(process.env.FAULT_ROOT_PID, String(process.pid));
const child = await spawnHold();
fs.writeFileSync(process.env.FAULT_NESTED + '/nested-child.pid', String(child));
fs.writeFileSync(process.env.FAULT_META, JSON.stringify({ pid: process.pid, child }));
setTimeout(() => {}, 300000);
`,
  // Controlled useful-worker sentinel: nested scratch + READY-verified Node descendant published
  // before the delayed abrupt death. The meta (pid + descendant pid) survives in the artifact root;
  // the nested scratch itself is removed by scratch cleanup.
  'crash-useful': `import fs from 'node:fs';
import { spawnHold } from './common.mjs';
fs.mkdirSync(process.env.FAULT_NESTED, { recursive: true });
fs.writeFileSync(process.env.FAULT_NESTED + '/mutation-state.json', '{"started":true}');
fs.writeFileSync(process.env.FAULT_ROOT_PID, String(process.pid));
const child = await spawnHold();
fs.writeFileSync(process.env.FAULT_NESTED + '/nested-child.pid', String(child));
fs.writeFileSync(process.env.FAULT_META, JSON.stringify({ pid: process.pid, child }));
setTimeout(() => process.abort(), 300);
`,
});

// One fault directory per test (the sources plus their shared common.mjs and hold.mjs helper).
function faultDir(t, sources) {
  if (!t.__faultDirs) t.__faultDirs = new Map();
  const key = sources.join('+');
  if (t.__faultDirs.has(key)) return t.__faultDirs.get(key);
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bb-eval-t4b-fault-'));
  fs.writeFileSync(path.join(root, 'common.mjs'), COMMON_MJS);
  fs.writeFileSync(path.join(root, 'hold.mjs'), HOLD_MJS);
  for (const name of sources) fs.writeFileSync(path.join(root, name + '.mjs'), FAULT_SOURCES[name]);
  t.__faultDirs.set(key, root);
  t.after(() => { for (const dir of t.__faultDirs.values()) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); });
  return root;
}
function sharedFaultDir(t) { return faultDir(t, ['sleep', 'exit', 'visible', 'crash']); }

// ---------------------------------------------------------------- settlement-boundary liveness capture
function readPidFile(file) {
  try {
    const value = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch { return null; } // file absent or unreadable → no recorded pid
}
// One bounded loopback connect. It never retries — at the settlement boundary an answer of
// "connection refused" IS the released-port fact; a positive connect is recorded as still-open.
function probePort(port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
class FaultWatch {
  // The constructor registers NO-ARG hooks in strict capture-before-cleanup order: every
  // acceptance snapshot is taken first, and only afterwards does the bounded emergency cleanup
  // touch recorded pids. createCaseFixture creates this watch BEFORE createFrozenFixture
  // registers its recursive-removal hook, and node:test executes t.after hooks in registration
  // order — so this guard always finishes snapshot/emergency reap BEFORE the fixture or fault
  // directories are removed.
  constructor(t, options = {}) {
    this.hooks = [];
    this.registered = new Map(); // metaFile → { pidFiles }
    this.diagnostics = [];
    this.hookEvents = [];
    this.aliveProbe = options.aliveProbe ?? (pid => {
      try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; }
    });
    this.kill = options.kill ?? (pid => { try { process.kill(pid, 'SIGKILL'); } catch { /* final liveness check below decides */ } });
    t.after(async () => { for (const hook of this.hooks) { await hook(); } });
  }
  // Ensures the meta file is snapshotted at settlement and its pids emergency-reaped if still
  // alive, even when the run itself throws before the snapshot could be captured.
  // `pidFiles` are the EXPLICIT early-readiness PID file paths registered while the fixture was
  // still known-owned (the sentinel's own root PID file, its child/nested readiness files); they
  // may supply owned PIDs when the fully-acquired meta.json was never published.
  register(metaFile, pidFiles = []) {
    if (this.registered.has(metaFile)) return;
    this.registered.set(metaFile, { pidFiles });
    this.hooks.push(async () => {
      try {
        await this.snapshot(metaFile);
      } catch (error) {
        // A snapshot that fails must never skip the emergency reap: one failed snapshot cannot
        // bypass all the guards. The failure is recorded as a diagnostic (the acceptance facts
        // are the inline boundary snapshots the test body asserts) and the reap still runs.
        this.diagnostics.push('snapshot failed for ' + metaFile + ': ' + (error?.message ?? String(error)) + ' — the emergency reap still runs');
        this.hookEvents.push('snapshot-failed');
      }
      await this.reap(metaFile);
      this.hookEvents.push('reap-done');
    });
  }
  // Reads the retained metadata NOW (the exact runProcess-return boundary) and records, per pid,
  // the immediate liveness answer and, for servers, the immediate port answer. No polling, no
  // waits: these raw facts are what the tests assert. Only the whitelisted pid-bearing keys
  // (`pid`, `child`) are probed — an ordinary-exit metadata also carries a small exitCode number,
  // which is not a process id.
  async snapshot(metaFile) {
    if (this.captured ??= new Set(), this.captured.has(metaFile)) return; // the inline boundary fact wins
    this.captured.add(metaFile);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { return; } // not written → no owned resources to capture
    const pids = Object.entries(meta).filter(([key, value]) => ['pid', 'child'].includes(key) && Number.isSafeInteger(value) && value > 0).map(([key, value]) => ({ key, pid: value, goneNow: !this.aliveProbe(value) }));
    const ports = Number.isSafeInteger(meta.port) && meta.port > 0 ? [{ port: meta.port, openNow: await probePort(meta.port) }] : [];
    (this.snapshots ??= []).push({ metaFile, meta, pids, ports });
  }
  // Failure-safe emergency cleanup for EXACTLY this fixture's owned pids — the whitelisted
  // `pid`/`child` entries of the fully-acquired metadata (when it exists) plus the pids read from
  // the explicitly registered early-readiness files — no process scans, no name-based matching, no
  // unrelated kills. Runs after every acceptance snapshot; a sentinel that somehow survived
  // settlement is reaped directly and its final absence asserted, so the suite never leaks.
  async reap(metaFile) {
    const entry = this.registered.get(metaFile) ?? { pidFiles: [] };
    const candidates = [];
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* full metadata never published — partial-acquisition files only */ }
    if (meta) {
      for (const [key, value] of Object.entries(meta)) {
        // ONLY the whitelisted process-bearing keys are PIDs. Every other metadata number
        // (exitCode, port, counts) is data, never a kill candidate.
        if (['pid', 'child'].includes(key) && Number.isSafeInteger(value)) candidates.push({ pid: value, source: 'meta:' + key });
      }
    }
    for (const file of entry.pidFiles) {
      const pid = readPidFile(file);
      if (pid !== null) candidates.push({ pid, source: 'file:' + path.basename(file) });
    }
    const targets = [];
    for (const candidate of candidates) {
      const pid = candidate.pid;
      // A safe, owned PID is a safe integer > 1 that is not this process itself. Anything else
      // (pid 1, process.pid, zero, negatives, out-of-range) is REJECTED with a diagnostic and
      // never killed — no process-name scans, no PID enumeration, no unrelated kills.
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
        this.diagnostics.push('rejected unsafe registered pid ' + pid + ' from ' + metaFile + ' (' + candidate.source + ') — not killed');
        continue;
      }
      if (!targets.some(target => target.pid === pid)) targets.push(candidate);
    }
    for (const target of targets) {
      if (this.aliveProbe(target.pid)) {
        try { this.kill(target.pid); } catch { /* final liveness check below decides */ }
      }
    }
    const deadline = Date.now() + 10000;
    for (const target of targets) {
      while (this.aliveProbe(target.pid)) {
        if (Date.now() > deadline) assert.fail('emergency cleanup: fault pid ' + target.pid + ' (from ' + metaFile + ') could not be reaped — a test-owned sentinel would leak');
        await new Promise(done => setTimeout(done, 25));
      }
    }
  }
}
function watchOf(t) { return (t.__faultWatch ??= new FaultWatch(t)); }
// Local test-only wrapper (C4.S1.T4b.R): creates the per-test FaultWatch FIRST so its guard hook
// is registered before createFrozenFixture's recursive-removal hook; node:test's registration-order
// after-hook execution then guarantees the guard finishes snapshot/emergency reap before
// fixture/fault-directory removal. The shared helper is unchanged — this only calls watchOf(t)
// and delegates.
async function createCaseFixture(t, options) {
  watchOf(t);
  return createFrozenFixture(t, options);
}
// Asserts the SNAPSHOT-TIME (runProcess-return boundary) facts verbatim, and only prints the
// current state inside a failure message for diagnosis. A later controller cleanup can never
// retroactively turn a red settlement fact green.
function assertReapedAtSettlement(t, stage) {
  const snapshots = watchOf(t).snapshots ?? [];
  assert.ok(snapshots.length > 0, stage + ': a settlement-boundary liveness snapshot was captured');
  const recorded = snapshots.flatMap(s => [...s.pids.map(p => stage + ' ' + p.key + ' pid=' + p.pid + ' goneNow=' + p.goneNow),
    ...s.ports.map(p => stage + ' port=' + p.port + ' openNow=' + p.openNow)]);
  for (const snapshot of snapshots) {
    for (const entry of snapshot.pids) assert.equal(entry.goneNow, true, 'the runner had ALREADY reaped the owned pid at its own settlement (captured raw fact, never polled; ' + recorded.join('; ') + ')');
    for (const entry of snapshot.ports) assert.equal(entry.openNow, false, 'the owned loopback port was ALREADY released at runner settlement (captured raw fact; ' + recorded.join('; ') + ')');
  }
  return snapshots[0].meta;
}

// ---------------------------------------------------------------- fault seams
// Drives the REAL accepted tool-stage function through the REAL bounded runner against a tiny
// fault tool: only the executable argv, the bounded deadline and the fault env are substituted, so
// the fixed stage name, the report path, the signal wiring and log retention all come from the
// accepted implementation (requireCompleted semantics preserved through the real stage itself).
// The retained meta file is registered for settlement capture + emergency cleanup, and the snapshot
// is also taken immediately at each runProcess return (the wrapper below adds no awaits).
function toolFaultStage(t, realStage, faultSource, options = {}) {
  return async ctx => {
    const metaFile = options.metaOverride ?? path.join(ctx.artifactRoot, 'meta.json');
    watchOf(t).register(metaFile);
    return realStage({ ...ctx, runProcess: async request => {
      const result = await runProcess({ ...request,
        args: [path.join(sharedFaultDir(t), faultSource + '.mjs')],
        timeoutMs: options.timeoutMs ?? request.timeoutMs,
        env: { ...request.env, FAULT_META: metaFile,
          FAULT_EXIT: options.exitCode ?? '0', FAULT_ARGS: request.args.join(' '), ...options.env } });
      await watchOf(t).snapshot(metaFile); // the exact runner-return boundary
      return result;
    } });
  };
}
// The explicit early-readiness PID file paths for a sentinel source, registered while its fixture
// directory is still known-owned — before the sentinel is launched, so the paths must not require
// the files to exist yet (reap tolerates an absent file). The sentinel root's own PID file is
// written EARLY (before the hold child exists); the hold child's readiness file — or, for the
// useful sentinels, the nested child pid file inside the nested scratch — is written by the
// child itself. These are the partial-acquisition witnesses emergency cleanup may read when
// meta.json was never published; the cancel-on-acquire watcher still keys on the FULL meta.json
// only.
function sentinelPidFiles(faults, faultSource, options = {}) {
  return [
    path.join(faults, 'root.pid'),
    path.join(faults, 'hold-child.pid'),
    ...(faultSource === 'useful' || faultSource === 'crash-useful' ? [path.join(options.nested ?? '', 'nested-child.pid')] : []),
  ];
}
// Shared controlled-resource fault run through the REAL runner. ctx/appRoot/artifactRoot/tempRoot
// are real controller values; only argv/env/deadline are the fault. The settlement-boundary
// snapshot is captured synchronously at the runProcess return, before this function yields.
async function runSentinel(ctx, t, faultSource, options) {
  const faults = faultDir(t, [faultSource]);
  const rootPidFile = path.join(faults, 'root.pid');
  // Partial acquisition: register the exact metadata/root-PID/child-readiness paths NOW, while
  // the fixture is still known-owned, before the sentinel is launched.
  const metaFile = path.join(ctx.artifactRoot, 'meta.json');
  watchOf(t).register(metaFile, sentinelPidFiles(faults, faultSource, options));
  const result = await runProcess({
    executable: process.execPath, args: [path.join(faults, faultSource + '.mjs')], cwd: ctx.appRoot,
    env: { ...ctx.env, FAULT_META: metaFile, FAULT_ROOT_PID: rootPidFile, FAULT_CHILD: path.join(faults, 'hold-child.pid'), FAULT_NESTED: options.nested ?? '', ...options.env },
    timeoutMs: options.timeoutMs ?? ctx.timeoutMs, maxOutputBytes: ctx.maxOutputBytes, signal: ctx.signal,
    stdoutLog: path.join(ctx.artifactRoot, 'sentinel.stdout.log'), stderrLog: path.join(ctx.artifactRoot, 'sentinel.stderr.log'),
  });
  await watchOf(t).snapshot(metaFile); // the exact runner-return boundary
  return { result, metaFile };
}
// The production browser/useful stages launch the real stage worker (which would need the real
// browser/vitest); the sentinel branches run the controlled fault through the REAL runner instead
// and preserve the fixed stage name/code via requireCompleted.
function sentinelStage(t, stage, faultSource, options = {}) {
  return async ctx => {
    const { result } = await runSentinel(ctx, t, faultSource, options);
    requireCompleted(result, stage);
    return stageSuccess(stage, null, result);
  };
}
// Fires the controller's own AbortSignal once the sentinel's FULL metadata exists — which the
// sentinels publish only AFTER full acquisition (loopback bind, nested-state publication, the hold
// descendant's readiness pid file) — so the abort always races a fully started, fully owned tree.
// The early root-PID record is deliberately NOT an acquisition signal for this watcher.
function sentinelStageAbortOnAcquire(t, stage, faultSource, options = {}) {
  return async ctx => {
    // The exact metadata/root-PID/child-readiness paths are registered by runSentinel below,
    // while the fixture is still known-owned; this watcher deliberately keys on the FULL
    // meta.json only, so an early root-PID record is never treated as full acquisition.
    const metaFile = path.join(ctx.artifactRoot, 'meta.json');
    const watch = setInterval(() => {
      if (!fs.existsSync(metaFile)) return;
      clearInterval(watch);
      options.controller.abort();
    }, 25);
    try {
      const { result } = await runSentinel(ctx, t, faultSource, options);
      requireCompleted(result, stage);
      return stageSuccess(stage, null, result);
    } finally { clearInterval(watch); }
  };
}

// ---------------------------------------------------------------- shared case gates
function assertEventTrace(f, stage) {
  const names = f.events.map(event => event.name);
  assert.equal(names.at(-1), 'cleanup', 'cleanup settlement is observed before the run returns (awaited, not an unawaited promise)');
  const stop = names.lastIndexOf(stage);
  assert.ok(stop >= 0, 'the failing stage was observed');
  assert.deepEqual(names.slice(stop + 1), ['cleanup'], 'no stage after the failure ran');
  const seen = STAGE_ORDER.filter(name => names.includes(name));
  assert.deepEqual(seen, STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(stage) + 1), 'earlier stages ran in the established order and nothing later did');
}
function assertNoScratchResidue(f) {
  if (!fs.existsSync(f.request.outputRoot)) return;
  for (const entry of fs.readdirSync(f.request.outputRoot)) {
    assert.ok(!entry.startsWith('scratch-'), 'the disposable product scratch must not survive (found ' + entry + ')');
  }
}
function assertInfrastructureCase(f, code, stage) {
  const result = f.lastResult;
  // (1) infrastructure result — never a claimed success, never scored or evidenced.
  assert.equal(result.status, 'infrastructure-error');
  assert.equal(result.error.code, code);
  assert.equal(result.error.stage, stage);
  assert.equal(result.score, null);
  assert.equal(result.evidence, null);
  assert.ok(typeof result.error.message === 'string' && result.error.message.length > 0, 'an explicit diagnostic message is present');
  // (2) ordered trace: no stage after the failure; settlement was awaited.
  assertEventTrace(f, stage);
  // (3) product scratch gone; the run-exclusive external canary survives untouched; pre-failure
  // diagnostics remain readable outside the disposable product scratch (preflight failures carry
  // the explicit error message instead of a fictitious tool log).
  assertNoScratchResidue(f);
  assertCanaryIntact();
  if (stage !== 'preflight') {
    const logs = fs.readdirSync(path.join(f.request.outputRoot, stage)).filter(name => name.endsWith('.log'));
    assert.ok(logs.length >= 1, 'pre-failure diagnostic logs are retained in the artifact root');
  }
  // (4) frozen snapshot and live workspace bytes unchanged.
  assertInputsUnchanged(f, f.before);
  // (5) cleanup fully settled and honestly reported.
  assert.equal(typeof result.cleanup.removed, 'boolean');
  assert.ok(Array.isArray(result.cleanup.residue) && Array.isArray(result.cleanup.errors));
  return result;
}
async function runCase(f) {
  f.before = snapshotInputs(f);
  f.lastResult = await evaluateWithRuntime(f.request, f.runtime);
  return f.lastResult;
}

// ================================================================ timeout matrix (4)
for (const [stageName, realStage] of [['typecheck', runTypecheckStage], ['build', runBuildStage], ['visible', runVisibleStage]]) {
  test('timeout-plain ' + stageName + ': the bounded deadline is exceeded, the failing stage is named, and no later stage or inspection runs', { timeout: 120000 }, async t => {
    const f = await createCaseFixture(t);
    f.runtime.stageOverrides[stageName] = toolFaultStage(t, realStage, 'sleep', { timeoutMs: 2000 });
    const result = await runCase(f);
    assertInfrastructureCase(f, 'TIMEOUT', stageName);
    assert.match(result.error.message, /timeout/i, 'the underlying runner deadline error is preserved');
    const meta = assertReapedAtSettlement(t, stageName);
    assert.ok(meta.pid > 0, 'the child physically started before the deadline reaped it');
    assert.notEqual(result.error.details.cleanupUnconfirmed, true, 'tree termination of the owned child was confirmed');
  });
}

test('timeout-browser: the controlled server/browser sentinel times out after acquisition and its owned resources are reaped before settle', { timeout: 120000 }, async t => {
  const f = await createCaseFixture(t);
  // CONTROLLED FAULT SEAM: a loopback Node server plus a ready hold descendant stand in for
  // server+browser acquisition; no real Chromium exists in this deterministic fault suite (real
  // browser execution belongs to T4c).
  f.runtime.stageOverrides.browser = sentinelStage(t, 'browser', 'server', { timeoutMs: 2500 });
  const result = await runCase(f);
  assertInfrastructureCase(f, 'TIMEOUT', 'browser');
  assert.match(result.error.message, /timeout/i);
  const meta = assertReapedAtSettlement(t, 'browser');
  assert.ok(Number.isSafeInteger(meta.child) && meta.child > 0, 'the owned resource tree included a physically started hold descendant');
  assert.notEqual(result.error.details.cleanupUnconfirmed, true, 'the owned sentinel tree termination was confirmed');
});

test('timeout-useful: the useful sentinel times out after nested scratch creation; descendants reaped and the nested private scratch is absent', { timeout: 120000 }, async t => {
  const f = await createCaseFixture(t);
  let nested = null;
  // The nested scratch lives under the controller's own private temp root (claim.tempRoot), so
  // scratch cleanup owns its removal.
  f.runtime.stageOverrides.useful = ctx => {
    nested = path.join(ctx.tempRoot, 'useful-nested');
    return sentinelStage(t, 'useful', 'useful', { timeoutMs: 2500, nested })(ctx);
  };
  const result = await runCase(f);
  assertInfrastructureCase(f, 'TIMEOUT', 'useful');
  const meta = assertReapedAtSettlement(t, 'useful');
  assert.ok(Number.isSafeInteger(meta.child) && meta.child > 0, 'the useful sentinel had acquired a ready hold descendant before it timed out');
  assert.equal(fs.existsSync(nested), false, 'the nested private scratch under the private temp root must not survive scratch cleanup');
});

// ================================================================ cancellation matrix (4)
test('cancelled-before: an already-aborted signal stops before staging; no tool/server/browser was created and no scratch claim is retained', { timeout: 120000 }, async t => {
  const f = await createCaseFixture(t);
  f.request = { ...f.request, signal: AbortSignal.abort() };
  const result = await runCase(f);
  assert.equal(result.status, 'infrastructure-error');
  assert.equal(result.error.code, 'CANCELLED');
  assert.equal(result.error.stage, 'preflight');
  assert.equal(result.score, null);
  assert.equal(result.evidence, null);
  assert.deepEqual(f.events.map(event => event.name), ['cleanup'], 'not even verification/staging was observed after the pre-stage abort');
  assert.equal(f.contexts.length, 0, 'no tool, server or browser context was ever created');
  assert.equal(fs.existsSync(f.request.outputRoot), false, 'no scratch claim was created or retained');
  assert.equal(result.cleanup.removed, true);
  assertCanaryIntact();
  assertInputsUnchanged(f, f.before);
});

test('cancelled-build: aborting after the build child started reports CANCELLED; the started child is reaped and no visible/browser/useful execution occurs', { timeout: 120000 }, async t => {
  const f = await createCaseFixture(t);
  const controller = new AbortController();
  f.request = { ...f.request, signal: controller.signal };
  f.runtime.stageOverrides.build = async ctx => {
    const started = setTimeout(() => controller.abort(), 2000);
    try {
      const { result } = await runSentinel(ctx, t, 'sleep', {});
      requireCompleted(result, 'build');
      return stageSuccess('build', null, result);
    } finally { clearTimeout(started); }
  };
  const result = await runCase(f);
  assertInfrastructureCase(f, 'CANCELLED', 'build');
  const meta = assertReapedAtSettlement(t, 'build');
  assert.ok(meta.pid > 0, 'the child physically started before the cancellation reaped it');
  assert.equal(f.events.some(event => event.name === 'visible'), false);
  assert.equal(f.events.some(event => event.name === 'browser'), false);
  assert.equal(f.contexts.some(c => ['visible', 'browser', 'useful', 'inspection'].includes(c.stage)), false, 'no visible/browser/useful execution');
});

test('cancelled-browser: aborting after server/browser acquisition reaps the sentinel tree and useful never starts', { timeout: 120000 }, async t => {
  const f = await createCaseFixture(t);
  const controller = new AbortController();
  f.request = { ...f.request, signal: controller.signal };
  // CONTROLLED FAULT SEAM: loopback sentinel acquisition proof (server bind + ready hold descendant
  // before the metadata publish), not a real Chromium.
  f.runtime.stageOverrides.browser = sentinelStageAbortOnAcquire(t, 'browser', 'server', { controller });
  const result = await runCase(f);
  assertInfrastructureCase(f, 'CANCELLED', 'browser');
  const meta = assertReapedAtSettlement(t, 'browser');
  assert.ok(Number.isSafeInteger(meta.child) && meta.child > 0, 'the acquired tree included a physically started hold descendant');
  assert.equal(f.events.some(event => event.name === 'useful'), false, 'useful never starts');
  assert.equal(f.contexts.some(c => ['useful', 'inspection'].includes(c.stage)), false);
});

test('cancelled-useful: aborting after the useful sentinel acquired its nested scratch reaps the worker and removes the scratch', { timeout: 120000 }, async t => {
  const f = await createCaseFixture(t);
  const controller = new AbortController();
  f.request = { ...f.request, signal: controller.signal };
  let nested = null;
  f.runtime.stageOverrides.useful = ctx => {
    nested = path.join(ctx.tempRoot, 'useful-nested');
    return sentinelStageAbortOnAcquire(t, 'useful', 'useful', { controller, nested })(ctx);
  };
  const result = await runCase(f);
  assertInfrastructureCase(f, 'CANCELLED', 'useful');
  const meta = assertReapedAtSettlement(t, 'useful');
  assert.ok(Number.isSafeInteger(meta.child) && meta.child > 0, 'the useful sentinel had acquired a ready hold descendant before the cancellation');
  assert.equal(fs.existsSync(nested), false, 'the acquired nested scratch must be removed by scratch cleanup');
});

// ================================================================ missing-prerequisite matrix (5)
test('missing-dependencies: an absent prepared dependency input names the prerequisite and starts zero tools', { timeout: 120000 }, async t => {
  const f = await createCaseFixture(t);
  const missing = path.join(f.root, 'definitely-absent-dependencies');
  assert.equal(fs.existsSync(missing), false);
  f.runtime.dependencyRoot = missing;
  const result = await runCase(f);
  assert.equal(result.status, 'infrastructure-error');
  assert.equal(result.error.code, 'MISSING_PREREQUISITE');
  assert.equal(result.error.stage, 'preflight');
  assert.match(result.error.message, /Prepared starter\/node_modules is missing/, 'the prerequisite is named');
  assert.equal(result.score, null);
  assert.equal(result.evidence, null);
  assert.deepEqual(f.events.map(event => event.name), ['verify-before', 'cleanup'], 'zero tool starts; only the cleanup diagnostic follows');
  assert.equal(f.contexts.length, 0);
  assert.equal(fs.existsSync(f.request.outputRoot), false);
  assert.equal(result.cleanup.removed, true);
  assertCanaryIntact();
  assertInputsUnchanged(f, f.before);
});

const MISSING_TOOL_NAMES = Object.freeze({ typecheck: 'typescript/bin/tsc', build: 'vite/bin/vite.js', visible: 'vitest/vitest.mjs' });
for (const stageName of Object.keys(MISSING_TOOL_NAMES)) {
  test('missing-tool ' + stageName + ': the absent entrypoint is named by the staging preflight before any stage, with no fabricated boolean or count', { timeout: 120000 }, async t => {
    const f = await createCaseFixture(t);
    fs.rmSync(path.join(f.dependencyRoot, MISSING_TOOL_NAMES[stageName]), { force: true, maxRetries: 5 });
    const result = await runCase(f);
    assert.equal(result.status, 'infrastructure-error');
    assert.equal(result.error.code, 'MISSING_PREREQUISITE');
    assert.equal(result.error.stage, 'preflight', 'missing-tool input is detected by the staging preflight before any stage runs');
    assert.match(result.error.message, new RegExp('Missing prepared tool: ' + MISSING_TOOL_NAMES[stageName].replaceAll('/', '\\/')), 'the missing tool is named exactly');
    assert.equal(result.score, null);
    assert.equal(result.evidence, null, 'no fabricated boolean or count');
    assert.deepEqual(f.events.map(event => event.name), ['verify-before', 'cleanup'], 'no stage ran');
    assert.equal(f.contexts.length, 0);
    assert.equal(fs.existsSync(f.request.outputRoot), false);
    assert.equal(result.cleanup.removed, true);
    assertCanaryIntact();
    assertInputsUnchanged(f, f.before);
  });
}

test('missing-browser: the runtime reports a missing Chromium through the real worker-result protocol before property execution — never 25 failed properties', { timeout: 120000 }, async t => {
  const f = await createCaseFixture(t);
  // Injected prerequisite failure (NOT an environment-cache override): the fake runner answers the
  // REAL runWorkerStage protocol exactly as the real stage worker reports a missing Chromium
  // executable — an infrastructure-error worker result bound to the browser stage — so the real
  // parent classification seam is exercised without launching any browser.
  const message = 'browserType.executable doesn\'t exist at the injected missing-chromium path';
  f.runtime.stageOverrides.browser = ctx => runBrowserStage({ ...ctx, runProcess: async request => {
    const resultFile = request.args[3];
    fs.writeFileSync(resultFile, JSON.stringify({ protocolVersion: WORKER_PROTOCOL_VERSION,
      status: 'infrastructure-error', error: { code: 'MISSING_PREREQUISITE', message, details: { injected: 'missing chromium executable' } } }));
    // The real bounded runner always retains the worker's (here empty) stdout/stderr diagnostics
    // outside the disposable product scratch; mirror that retention so the pre-failure diagnostic
    // assertion proves the same fact as in every other case.
    fs.writeFileSync(request.stdoutLog, '');
    fs.writeFileSync(request.stderrLog, 'injected missing-chromium diagnostic\n');
    return { status: 'completed', exitCode: 0, signal: null, stdout: '', stderr: '', stdoutLog: request.stdoutLog, stderrLog: request.stderrLog };
  } });
  const result = await runCase(f);
  assertInfrastructureCase(f, 'MISSING_PREREQUISITE', 'browser');
  assert.match(result.error.message, /executable doesn't exist/);
  assert.equal(/F\d{2}/.test(JSON.stringify(result.evidence ?? {})), false, 'never 25 failed properties');
  assert.equal(f.events.some(event => event.name === 'useful'), false, 'browser and useful results are absent');
  assert.equal(f.contexts.some(c => ['useful', 'inspection'].includes(c.stage)), false);
});

// ================================================================ crash matrix (3)
test('crash-tool: an abruptly terminated controlled child is TOOL_CRASH, distinct from a quality failure and from the deadline, with retained diagnostics', { timeout: 120000 }, async t => {
  const f = await createCaseFixture(t);
  f.runtime.stageOverrides.typecheck = toolFaultStage(t, runTypecheckStage, 'crash');
  const result = await runCase(f);
  assertInfrastructureCase(f, 'TOOL_CRASH', 'typecheck');
  assert.equal(/timeout/i.test(result.error.message), false, 'a crash is distinct from the deadline');
  const artifactRoot = path.join(f.request.outputRoot, 'typecheck');
  assert.ok(fs.existsSync(path.join(artifactRoot, 'typecheck.stdout.log')), 'the runner retained the crashed child diagnostic logs');
  assert.ok(fs.existsSync(path.join(artifactRoot, 'typecheck.stderr.log')));
  assert.ok(result.error.details.exitCode !== undefined || result.error.details.signal !== undefined, 'raw OS facts ride in the preserved underlying error');
  assert.equal(f.events.some(event => event.name === 'build'), false, 'an ordinary exit 1 would have completed and let the next stage run; an abrupt death stops the run — distinct from quality evidence');
});

test('crash-browser: the browser sentinel dies after server/resource acquisition; every owned descendant probe is gone before settle', { timeout: 120000 }, async t => {
  const f = await createCaseFixture(t);
  // CONTROLLED FAULT SEAM: Node loopback + a READY-verified Node descendant (readiness proven before
  // the abort) prove the real runner reaps the whole owned tree; no real Chromium is involved
  // (real reference browser execution belongs to T4c).
  f.runtime.stageOverrides.browser = sentinelStage(t, 'browser', 'crash-browser');
  const result = await runCase(f);
  assertInfrastructureCase(f, 'TOOL_CRASH', 'browser');
  const meta = assertReapedAtSettlement(t, 'browser');
  assert.ok(Number.isSafeInteger(meta.child) && meta.child > 0, 'the descendant was readiness-verified before the sentinel aborted');
});

test('crash-useful: the useful sentinel dies after nested scratch creation; no partial mutation evidence and the scratch/descendant are gone', { timeout: 120000 }, async t => {
  const f = await createCaseFixture(t);
  let nested = null;
  f.runtime.stageOverrides.useful = ctx => {
    nested = path.join(ctx.tempRoot, 'useful-nested');
    return sentinelStage(t, 'useful', 'crash-useful', { nested })(ctx);
  };
  const result = await runCase(f);
  assertInfrastructureCase(f, 'TOOL_CRASH', 'useful');
  const meta = assertReapedAtSettlement(t, 'useful');
  assert.ok(meta.pid > 0);
  assert.ok(Number.isSafeInteger(meta.child) && meta.child > 0, 'the descendant was readiness-verified before the sentinel aborted');
  assert.equal(fs.existsSync(nested), false, 'the nested scratch and everything in it are gone');
  assert.equal(result.evidence, null, 'no partial mutation evidence is admitted');
});

// ================================================================ cleanup-failure exception (1)
test('cleanup-failure: the primary TIMEOUT stays primary, a separate CLEANUP_FAILED observation names the residue, and nothing is deleted through an unproven ownership chain', { timeout: 120000 }, async t => {
  const f = await createCaseFixture(t);
  let scratch = null;
  const inner = toolFaultStage(t, runTypecheckStage, 'sleep', { timeoutMs: 2000 });
  f.runtime.stageOverrides.typecheck = ctx => { scratch = path.dirname(ctx.tempRoot); return inner(ctx); };
  // Injected cleanup fault — a COLLABORATOR-LEVEL observation (the real physical ownership boundary
  // is proven by the staging-security suite, not here). It is the deliberate exception to full
  // scratch removal: residue is reported, never hidden, and nothing outside a proven ownership
  // chain is deleted.
  f.runtime.cleanupScratch = claim => ({ removed: false, residue: [claim.scratchRoot], errors: [{ code: 'CLEANUP_FAILED', message: 'injected cleanup fault: ownership chain could not be proven' }] });
  const result = await runCase(f);
  assert.equal(result.status, 'infrastructure-error');
  assert.equal(result.error.code, 'TIMEOUT', 'the top-level primary code remains TIMEOUT');
  assert.equal(result.error.stage, 'typecheck');
  assert.equal(result.score, null);
  assert.equal(result.evidence, null);
  assert.equal(result.cleanup.removed, false);
  assert.equal(result.cleanup.errors[0].code, 'CLEANUP_FAILED', 'the cleanup diagnostic is a separate observation, never a replacement primary and never a claim of success');
  assert.equal(result.cleanup.residue.length, 1, 'the residue is explicitly reported');
  assert.equal(result.cleanup.residue[0], scratch);
  assert.ok(fs.existsSync(result.cleanup.residue[0]), 'the residue is disclosed, never hidden');
  assertCanaryIntact();
  assertInputsUnchanged(f, f.before);
});

// ================================================================ negative controls (3)
for (const [stageName, realStage, faultSource, checkEvidence] of [
  ['typecheck', runTypecheckStage, 'exit', evidence => assert.equal(evidence.typecheck, false, 'a completed typecheck exit 1 is ordinary false quality evidence')],
  ['build', runBuildStage, 'exit', evidence => assert.equal(evidence.build, false, 'a completed build exit 1 is ordinary false quality evidence')],
  ['visible', runVisibleStage, 'visible', evidence => assert.equal(evidence.visiblePassed, 17, 'the actual visible count comes through with a valid report at exit 1')],
]) {
  test('negative control ' + stageName + ': a completed exit 1 stays ordinary quality evidence, not TOOL_CRASH or infrastructure-error', { timeout: 120000 }, async t => {
    const f = await createCaseFixture(t);
    const metaFile = path.join(faultDir(t, ['sleep', 'exit', 'visible', 'crash']), stageName + '.meta.json');
    f.runtime.stageOverrides[stageName] = toolFaultStage(t, realStage, faultSource, { exitCode: '1', metaOverride: metaFile });
    const result = await runCase(f);
    assert.equal(result.status, 'success', 'a completed ordinary nonzero exit is quality evidence, never an infrastructure error');
    checkEvidence(result.evidence);
    assert.equal(result.score, null, 'no numeric scores are invented in S1');
    assert.deepEqual(f.events.map(event => event.name), FULL_SUCCESS_EVENTS, 'the full stage order progresses past the exit-1 stage');
    const stageResult = result.stages.find(entry => entry.stage === stageName);
    assert.equal(stageResult.process.status, 'completed');
    assert.equal(stageResult.process.exitCode, 1);
    assert.equal(stageResult.process.signal, null);
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    assert.equal(meta.exitCode, 1);
    assertInputsUnchanged(f, f.before);
  });
}

// ================================================================ focused nondestructive guard tests (3)
// These three guard the C4.S1.T4b.R safety repairs. Every one of them uses TEST-ONLY injected
// pid-probe/kill callbacks (private to this file) and never any real PID: the fake PIDs are
// chosen outside any live range, and process.kill is stubbed for the whole guarded body, so a
// regression that reaches for a real kill fails the test instead of touching the machine.
test('guard: emergency cleanup selects exactly the whitelisted pid/child keys and rejects unsafe or self PIDs instead of killing them', { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bb-eval-t4b-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
  const metaFile = path.join(root, 'meta.json');
  const rootPidFile = path.join(root, 'root.pid');
  const childPidFile = path.join(root, 'hold-child.pid');
  // The exact metadata from the packet: exitCode:1 and port:51000 must never be kill candidates.
  fs.writeFileSync(metaFile, JSON.stringify({ pid: 50101, child: 50102, exitCode: 1, port: 51000 }));
  // The unsafe/self PID probes ride in the explicitly registered early-readiness PID files.
  fs.writeFileSync(rootPidFile, '1');
  fs.writeFileSync(childPidFile, String(process.pid));
  assert.ok(![50101, 50102].includes(process.pid), 'precondition: the fake owned PIDs do not collide with this test process');
  const alive = new Set([50101, 50102, 1, process.pid]);
  const killed = [];
  const probe = pid => alive.has(pid);
  const kill = pid => { alive.delete(pid); killed.push(pid); };
  const realKill = process.kill;
  let watch;
  process.kill = () => { throw new Error('guard test: a real process.kill was invoked — injected fakes must be the only liveness/kill seam'); };
  try {
    watch = new FaultWatch({ after: () => {} }, { aliveProbe: probe, kill });
    watch.register(metaFile, [rootPidFile, childPidFile]);
    await watch.hooks[0](); // run the registered guard hook (snapshot + emergency reap)
  } finally {
    process.kill = realKill;
  }
  assert.deepEqual(watch.snapshots[0].pids.map(p => [p.key, p.pid]), [['pid', 50101], ['child', 50102]], 'only the whitelisted pid/child metadata keys are process facts');
  assert.deepEqual(killed, [50101, 50102], 'emergency cleanup selected exactly the owned 50101/50102 — never 1, never the self pid, never exitCode 1, never port 51000');
  assert.equal(killed.includes(1), false, 'pid 1 was never a kill target');
  assert.equal(killed.includes(51000), false, 'the port number was never a kill target');
  assert.equal(killed.includes(process.pid), false, 'the self pid was never a kill target');
  assert.equal(watch.diagnostics.length, 2, 'both unsafe registered pids were rejected with diagnostics');
  assert.ok(watch.diagnostics.some(d => d.includes('pid 1 ')), 'the pid-1 rejection is diagnosed');
  assert.ok(watch.diagnostics.some(d => d.includes('pid ' + process.pid)), 'the self-pid rejection is diagnosed');
});

test('guard: the guard/reap hook completes before the registered fixture/metadata removal, even when a simulated snapshot callback throws', { timeout: 20000 }, async t => {
  // Explicit ordered captured-hook harness, exactly the alternative the Captain's rework permits
  // ("actual node:test hook execution OR an explicit ordered captured-hook harness"). The hooks
  // are CAPTURED in registration order — the guard hook first (as createCaseFixture registers it
  // before createFrozenFixture's recursive-removal hook), the fixture-removal hook second — and
  // then executed in that captured order. That is precisely how node:test executes t.after hooks
  // (registration order, verified separately for this runtime), so the harness faithfully models
  // the real hook execution with no sleep-based proof.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bb-eval-t4b-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
  const fixtureRoot = path.join(root, 'fixture');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const metaFile = path.join(fixtureRoot, 'meta.json');
  const rootPidFile = path.join(fixtureRoot, 'root.pid');
  fs.writeFileSync(metaFile, JSON.stringify({ pid: 50101 }));
  fs.writeFileSync(rootPidFile, '50101');
  assert.ok(![50101].includes(process.pid), 'precondition: the fake owned PID does not collide with this test process');
  const events = [];
  const killed = [];
  const registeredHooks = [];
  const fakeContext = { after: hook => registeredHooks.push(hook) };
  const watch = new FaultWatch(fakeContext, {
    aliveProbe: () => false, // everything already gone: the reap is a pure ordering witness
    kill: pid => { killed.push(pid); },
  });
  watch.hookEvents = events; // capture the guard hook's events into the shared log
  watch.register(metaFile, [rootPidFile]); // the guard hook — registered FIRST
  // Simulated snapshot callback failure: the guard hook must still run the reap.
  watch.snapshot = async () => { throw new Error('simulated snapshot failure'); };
  // The fixture-removal hook (the role createFrozenFixture's hook plays) — registered SECOND,
  // exactly like the helper registers it after the watch hook.
  registeredHooks.push(() => { events.push('fixture-removed'); fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10 }); });
  // Execute the captured hooks in node:test's registration order.
  for (const hook of registeredHooks) await hook();
  const guardIndex = events.indexOf('reap-done');
  const removedIndex = events.indexOf('fixture-removed');
  assert.ok(guardIndex >= 0, 'the guard/reap hook ran (reap still ran even though the snapshot callback threw)');
  assert.ok(removedIndex >= 0, 'the fixture-removal hook ran');
  assert.ok(guardIndex < removedIndex, 'the guard/reap hook completed BEFORE the registered fixture/metadata removal hook ran');
  assert.equal(fs.existsSync(metaFile), false, 'the fixture/metadata files were removed after the guard, by the removal hook itself');
  assert.deepEqual(killed, [], 'nothing was killed: every recorded pid was already gone at reap time');
});

test('guard: missing final metadata with registered root/child readiness files still cleans only those known PIDs and never overwrites a captured alive fact', { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bb-eval-t4b-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
  const metaFile = path.join(root, 'meta.json'); // deliberately NEVER published
  const rootPidFile = path.join(root, 'root.pid');
  const childPidFile = path.join(root, 'nested-child.pid');
  fs.writeFileSync(rootPidFile, '50101');
  fs.writeFileSync(childPidFile, '50102');
  assert.equal(fs.existsSync(metaFile), false, 'the fully-acquired metadata was never published');
  assert.ok(![50101, 50102].includes(process.pid), 'precondition: the fake owned PIDs do not collide with this test process');
  const alive = new Set([50101]); // the root is still alive at capture; the child already exited
  const killed = [];
  const probe = pid => alive.has(pid);
  const kill = pid => { alive.delete(pid); killed.push(pid); };
  const realKill = process.kill;
  process.kill = () => { throw new Error('guard test: a real process.kill was invoked — injected fakes must be the only liveness/kill seam'); };
  let watch;
  try {
    watch = new FaultWatch({ after: () => {} }, { aliveProbe: probe, kill });
    watch.register(metaFile, [rootPidFile, childPidFile]);
    // Immediate raw capture at the simulated runner-return boundary (the packet's acceptance
    // pattern, never polled): record what liveness says NOW, before any cleanup.
    const captured = [
      { file: rootPidFile, pid: 50101, aliveNow: probe(50101) },
      { file: childPidFile, pid: 50102, aliveNow: probe(50102) },
    ];
    assert.deepEqual(captured.map(c => [c.pid, c.aliveNow]), [[50101, true], [50102, false]], 'the captured boundary facts are alive=false/true as set up');
    const before = JSON.stringify(captured);
    // The guard hook: snapshot records no metadata-backed facts (meta.json missing) and the
    // reap cleans exactly the still-alive registered readiness PIDs.
    await watch.hooks[0]();
    assert.deepEqual(killed, [50101], 'emergency cleanup cleaned ONLY the still-alive known fake root pid; the already-gone child pid was not re-killed and no other pid was touched');
    assert.deepEqual(watch.diagnostics, [], 'no unsafe-pid diagnostics were expected for this fixture');
    // The earlier captured alive=false/true fact is immutable: cleanup changed the process
    // world but never overwrote the recorded boundary facts.
    const after = JSON.stringify(captured);
    assert.equal(after, before, 'the captured alive=false/true boundary facts were not overwritten after cleanup');
    assert.equal(probe(50101), false, 'the root pid is confirmed gone after the bounded emergency reap (world changed, record unchanged)');
    assert.equal(probe(50102), false, 'the child pid remained gone');
  } finally {
    process.kill = realKill;
  }
});
