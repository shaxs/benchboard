// Captain-owned diagnostics: tiny owned Node processes, no browser/server/service.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runProcess } from '../../packages/evaluation/process.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-eval-process-diagnostic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, request: {
    executable: process.execPath, args: [], cwd: root, env: {}, timeoutMs: 300,
    maxOutputBytes: 4096, stdoutLog: path.join(root, 'stdout.log'), stderrLog: path.join(root, 'stderr.log'),
  } };
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function reapOwnedLeaf(pid) {
  if (!pid || !alive(pid)) return;
  process.kill(pid, 'SIGKILL'); // This test created this exact leaf, which spawns no descendants.
  const deadline = Date.now() + 2000;
  while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(alive(pid), false, 'diagnostic must not leave its owned leaf running');
}

test('deliberate ordinary exit 134 is not fabricated SIGABRT evidence', async t => {
  const { root, request } = fixture(t);
  const ordinary = spawnSync(process.execPath, ['-e', 'process.exit(134)'], { cwd: root, env: {}, encoding: 'utf8', timeout: 3000, windowsHide: true });
  const aborted = spawnSync(process.execPath, ['-e', 'process.abort()'], { cwd: root, env: {}, encoding: 'utf8', timeout: 3000, windowsHide: true });
  t.diagnostic('Raw OS exit facts: ' + JSON.stringify({ ordinary: { exitCode: ordinary.status, signal: ordinary.signal }, aborted: { exitCode: aborted.status, signal: aborted.signal } }));
  const result = await runProcess({ ...request, args: ['-e', 'process.exit(134)'] });
  assert.equal(result.status, 'completed', 'an ordinary exit is not a witnessed signal death');
  assert.equal(result.exitCode, 134);
  assert.equal(result.signal, null);
});

test('abrupt root death reaps its owned descendant before the runner settles', { timeout: 10000 }, async t => {
  const { root, request } = fixture(t);
  const descendantFile = path.join(root, 'descendant.pid');
  const rootFile = path.join(root, 'root.pid');
  const leaf = `require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.stdout.write('owned descendant ready\\n');setInterval(()=>{},600000);`;
  const source = `const fs=require('node:fs');fs.writeFileSync(process.argv[2],String(process.pid));const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)},process.argv[1]],{stdio:'inherit',windowsHide:true});child.unref();const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(timer);process.abort();}},5);`;
  const pending = runProcess({ ...request, timeoutMs: 1000, args: ['-e', source, descendantFile, rootFile] });
  let guard, observed;
  try {
    observed = await Promise.race([
      pending,
      new Promise(resolve => { guard = setTimeout(() => resolve({ diagnosticGuardExpired: true }), 3500); }),
    ]);
    const descendantPid = fs.existsSync(descendantFile) ? Number(fs.readFileSync(descendantFile, 'utf8')) : null;
    const descendantAliveAtSettlement = descendantPid ? alive(descendantPid) : null;
    t.diagnostic('Runner settlement: ' + JSON.stringify({ guardExpired: observed.diagnosticGuardExpired === true, status: observed.status ?? null, code: observed.error?.code ?? null, descendantAlive: descendantAliveAtSettlement }));
    if (observed.diagnosticGuardExpired) {
      assert.ok(fs.existsSync(rootFile), 'root started before the diagnostic guard');
      assert.equal(alive(Number(fs.readFileSync(rootFile, 'utf8'))), false, 'root had already exited');
      assert.equal(descendantAliveAtSettlement, true, 'inherited pipe really remained live');
    }
    assert.notEqual(observed.diagnosticGuardExpired, true, 'runner exceeded its 1000-ms deadline after root exit (3500-ms independent guard)');
    assert.equal(observed.status, 'infrastructure-error');
    assert.equal(observed.error.code, 'TOOL_CRASH');
    assert.equal(descendantAliveAtSettlement, false, 'owned descendant must be gone before runner settlement');
  } finally {
    clearTimeout(guard);
    if (fs.existsSync(descendantFile)) await reapOwnedLeaf(Number(fs.readFileSync(descendantFile, 'utf8')));
    t.diagnostic('Diagnostic-owned leaf cleanup confirmed; no fixture descendant left running');
    // Once our held pipe is closed, also drain the runner promise so no child/stream leaks out of this test.
    let drainGuard;
    try { await Promise.race([pending, new Promise((_, reject) => { drainGuard = setTimeout(() => reject(Error('runner did not drain after diagnostic cleanup')), 2500); })]); }
    finally { clearTimeout(drainGuard); }
  }
});
