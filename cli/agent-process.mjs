// Launches one agent process for `run`, streams its output to files and enforces the time
// ceiling by killing the whole process tree. Cooperative, not an OS sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const SYSTEM32 = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32');

export function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync(path.join(SYSTEM32, 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}

/**
 * @param {{file:string,args:string[],windowsVerbatimArguments?:boolean,shell?:boolean|string}} plan
 * @returns {Promise<{exitCode:number|null,signal:string|null,timedOut:boolean,cancelled:boolean,spawnError:string|null,startedAt:string,endedAt:string,elapsedMs:number}>}
 */
export function runAgentProcess(plan, { cwd, env, stdoutFile, stderrFile, timeoutMs, signal }) {
  return new Promise(resolve => {
    const stdout = fs.createWriteStream(stdoutFile, { flags: 'wx' });
    const stderr = fs.createWriteStream(stderrFile, { flags: 'wx' });
    const startedAt = new Date(), started = performance.now();
    let timedOut = false, cancelled = false, settled = false, spawnError = null;
    const child = spawn(plan.file, plan.args, {
      // PWD matches cwd: an inherited PWD names the launching shell's folder, and some harnesses
      // (OpenCode) trust it over the real working directory.
      cwd, env: { ...env, PWD: cwd }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      shell: plan.shell ?? false, windowsVerbatimArguments: plan.windowsVerbatimArguments ?? false,
      // A POSIX process group lets the ceiling kill grandchildren (dev servers, test runners).
      detached: process.platform !== 'win32',
    });
    // Ended explicitly in finish() so a spawn error and a normal close settle the same way.
    child.stdout.pipe(stdout, { end: false });
    child.stderr.pipe(stderr, { end: false });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => { cancelled = true; killTree(child); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const endedAt = new Date(), elapsedMs = Math.round(performance.now() - started);
      let open = 2;
      const done = () => { if (--open === 0) resolve({ exitCode, signal: exitSignal, timedOut, cancelled, spawnError, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), elapsedMs }); };
      stdout.end(done); stderr.end(done);
    };
    child.once('error', error => { spawnError = error.code ?? error.message; finish(null, null); });
    child.once('close', finish);
  });
}
