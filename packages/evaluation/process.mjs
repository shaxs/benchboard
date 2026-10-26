// Bounded process runner. Sole runtime export: runProcess. No shell, no stage imports, no npm.
// An ordinary nonzero exit is completed evidence; spawn failure, timeout, cancellation, output
// overflow and abrupt death are infrastructure results, never thrown. Invalid internal arguments
// throw TypeError. Paths are internal trusted absolute inputs per the T1 ProcessRequest contract.
// Exit classification is fact-based only: no exit-code-to-signal synthesis. For the actual Node
// executable the Captain-owned private preload (exit-witness.mjs, read-only seam) supplies a
// bounded nonce/pid/exit-code-bound normal-completion record; unknown facts stay unknown (null).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';
const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const WITNESS_KEY = 'BENCHBOARD_EVALUATION_EXIT_WITNESS';
const WITNESS_PRELOAD = new URL('./exit-witness.mjs', import.meta.url).href; // FILE URL, not a Windows path
const WITNESS_MAX_BYTES = 4096;
// Explicit finite bounds so a killed tree's lingering inherited pipe can never become unbounded.
const STREAM_WAIT_MS = 5000;
const REAP_WAIT_MS = 10000;

function validate(request) {
  if (request === null || typeof request !== 'object') throw new TypeError('runProcess requires a request object');
  const { executable, args, cwd, env, timeoutMs, maxOutputBytes, signal } = request;
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) throw new TypeError('executable must be an absolute string path');
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new TypeError('args must be an array of strings');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new TypeError('cwd must be an absolute string path');
  if (env === null || typeof env !== 'object' || Object.values(env).some(v => v !== undefined && typeof v !== 'string')) throw new TypeError('env must be an object of explicit string or undefined values');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a finite positive number');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new TypeError('maxOutputBytes must be a positive safe integer');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
  for (const name of ['stdoutLog', 'stderrLog']) {
    const value = request[name];
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute string path`);
  }
}

// A missing or unlaunchable executable is a distinct infrastructure condition from a crashed tool.
function spawnErrorCode(error) {
  const code = error?.code;
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'ENOTDIR') return 'MISSING_PREREQUISITE';
  return 'TOOL_CRASH';
}

function pidGone(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
}

// Terminate only this run's owned process tree (never an unrelated pid) and report honestly:
// 'confirmed' = the tree termination itself was confirmed; 'root-gone' = only the root's absence
// is known, so descendant disappearance is NOT claimed; 'failed' = nothing could be confirmed.
// Windows: taskkill /T /F, whose exit 0 confirms the whole tree. POSIX: the child is a detached
// group leader, so SIGKILL to the group reaches the whole tree. Bounded so a stuck killer cannot
// hold settlement open.
function reapTree(pid) {
  return new Promise(done => {
    if (!Number.isInteger(pid) || pid <= 0) { done('confirmed'); return; }
    let settled = false;
    const finish = outcome => { if (!settled) { settled = true; done(outcome); } };
    const bound = setTimeout(() => finish(pidGone(pid) ? 'root-gone' : 'failed'), REAP_WAIT_MS);
    bound.unref();
    if (IS_WINDOWS) {
      let killer;
      try {
        killer = spawn(path.join(SYSTEM32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch {
        clearTimeout(bound);
        finish('failed');
        return;
      }
      killer.once('close', status => { clearTimeout(bound); finish(status === 0 ? 'confirmed' : pidGone(pid) ? 'root-gone' : 'failed'); });
      killer.once('error', () => { clearTimeout(bound); finish(pidGone(pid) ? 'root-gone' : 'failed'); });
    } else {
      clearTimeout(bound);
      try { process.kill(-pid, 'SIGKILL'); finish('confirmed'); }
      catch (error) { finish(error?.code === 'ESRCH' ? 'root-gone' : 'failed'); }
    }
  });
}

// Read and validate the preload's bounded witness. Returns {verdict:'normal'} for a valid
// normal:true record bound to this run, {verdict:'abnormal'} for a valid normal:false record, or
// {verdict:'none', reason} for missing/invalid records. Validation failures are reasons, never
// guesses; the raw exit facts always come from the OS event, never from the witness.
function readWitness(file, nonce, pid, exitCode) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return { verdict: 'none', reason: 'witness is not an ordinary file' };
    if (stat.size > WITNESS_MAX_BYTES) return { verdict: 'none', reason: 'witness exceeds its bound' };
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record === null || typeof record !== 'object') return { verdict: 'none', reason: 'witness is not an object' };
    if (record.version !== 1) return { verdict: 'none', reason: 'unknown witness version' };
    if (record.nonce !== nonce) return { verdict: 'none', reason: 'witness nonce mismatch' };
    if (record.pid !== pid) return { verdict: 'none', reason: 'witness pid mismatch' };
    if (!Number.isInteger(record.exitCode)) return { verdict: 'none', reason: 'witness exitCode is not an integer' };
    if (record.exitCode !== exitCode) return { verdict: 'none', reason: 'witness exitCode is not bound to the reported code' };
    if (typeof record.normal !== 'boolean') return { verdict: 'none', reason: 'witness normal is not a boolean' };
    return record.normal ? { verdict: 'normal' } : { verdict: 'abnormal' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { verdict: 'none', reason: 'no witness written' };
    return { verdict: 'none', reason: `witness unreadable: ${error?.message ?? error}` };
  }
}

export function runProcess(request) {
  validate(request);
  const { executable, args, cwd, env, timeoutMs, maxOutputBytes, signal, stdoutLog, stderrLog } = request;
  const cleanEnv = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) cleanEnv[key] = value;

  const writeLogs = buffers => {
    const errors = [];
    for (const [file, data] of [[stdoutLog, buffers.stdout], [stderrLog, buffers.stderr]]) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, data);
      } catch (error) { errors.push(`${file}: ${error.message}`); }
    }
    return errors;
  };

  // An already-aborted signal never reaches a spawn. CANCELLED stays primary; log retention
  // failures are secondary diagnostics, never a replacement code.
  if (signal?.aborted) {
    return Promise.resolve().then(() => {
      const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      const logErrors = writeLogs(buffers);
      return {
        status: 'infrastructure-error', exitCode: null, signal: null,
        stdout: '', stderr: '', stdoutLog, stderrLog,
        error: {
          code: 'CANCELLED',
          message: 'Run was cancelled before the process started',
          details: logErrors.length ? { logErrors } : {},
        },
      };
    });
  }

  return new Promise(resolve => {
    const isNode = executable === process.execPath;
    // Fresh private witness path under the trusted log directory; nonce binds it to this run.
    // The key is added to the child env copy only; the caller's env object is never mutated.
    const witness = isNode ? (() => {
      const nonce = crypto.randomBytes(16).toString('hex');
      return { file: path.join(path.dirname(stdoutLog), `exit-witness-${nonce}.json`), nonce };
    })() : null;
    if (witness) cleanEnv[WITNESS_KEY] = JSON.stringify(witness);

    const state = {
      settled: false, started: false, exited: false, exitCode: null, procSignal: null,
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
      code: null, message: null, details: {},
      forced: false, reapAttempted: false, cleanupUnconfirmed: false,
      streamsExpected: 0, streamsClosed: 0, logErrors: [],
    };
    let timer = null;
    let onAbort = null;
    let child = null;

    function removeWatchers() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal && onAbort) { signal.removeEventListener('abort', onAbort); onAbort = null; }
    }

    // The preload's witness record is retained in the owned log/artifact directory as bounded
    // local diagnostic evidence (it is nonce-named, size-bounded and preload-exclusive-created).
    // It is never adopted as anything stronger than a classification input, and it is never
    // unconditionally deleted — an unverified metadata path is not safe to remove.

    function settle() {
      if (state.settled) return;
      state.settled = true;
      removeWatchers();
      state.logErrors = writeLogs({ stdout: state.stdout, stderr: state.stderr });
      const facts = {
        exitCode: state.exited ? state.exitCode : null,
        signal: state.exited ? state.procSignal : null,
        stdout: state.stdout.toString('utf8'),
        stderr: state.stderr.toString('utf8'),
        stdoutLog, stderrLog,
      };
      const code = state.code ?? (state.logErrors.length ? 'CLEANUP_FAILED' : null);
      if (code) {
        const details = { ...state.details };
        if (state.forced && state.cleanupUnconfirmed) details.cleanupUnconfirmed = true;
        if (state.logErrors.length) details.logErrors = state.logErrors;
        resolve({
          status: 'infrastructure-error', ...facts,
          exitCode: null, signal: null,
          error: {
            code,
            message: state.message ?? (state.code ? 'Run ended abnormally' : 'Run output could not be retained'),
            details,
          },
        });
      } else {
        resolve({ status: 'completed', ...facts, exitCode: facts.exitCode, signal: null });
      }
    }

    // After a trigger the owned tree must be reaped and the pipes closed before the result settles.
    function maybeSettle() {
      if (state.settled) return;
      if (!state.exited) return;
      if (state.streamsClosed < state.streamsExpected) return;
      if (state.forced && !state.reapAttempted) return;
      settle();
    }

    function trigger(code, message) {
      if (state.settled || state.code) return;
      state.code = code;
      state.message = message;
      state.forced = true;
      reapTree(child?.pid).then(outcome => {
        state.reapAttempted = true;
        if (outcome !== 'confirmed') state.cleanupUnconfirmed = true;
        maybeSettle();
      });
      // A killed child's pipes close on their own; if an inherited handle is held elsewhere,
      // bounded-wait then force-close so every infrastructure result still settles.
      const fallback = setTimeout(() => {
        state.streamsClosed = Math.max(state.streamsClosed, state.streamsExpected);
        maybeSettle();
      }, STREAM_WAIT_MS);
      fallback.unref();
    }

    function onChunk(key) {
      return chunk => {
        const remaining = maxOutputBytes - state[key].length;
        if (remaining > 0) state[key] = Buffer.concat([state[key], chunk.subarray(0, remaining)]);
        if (chunk.length > remaining) trigger('OUTPUT_LIMIT', `Run exceeded its ${maxOutputBytes}-byte ${key} bound`);
      };
    }

    // Classify the raw exit at the exit event so a crash can begin its bounded reap immediately.
    // Facts order: an actually reported signal (POSIX) is a signal death; a Node nonzero exit
    // requires a valid normal:true witness to be ordinary evidence; a Node zero exit is ordinary
    // unless its witness explicitly says abnormal. Native executables keep only reported facts.
    function classifyExit() {
      const { exitCode, procSignal } = { exitCode: state.exitCode, procSignal: state.procSignal };
      if (procSignal !== null) {
        return { code: 'TOOL_CRASH', message: 'Tool terminated abnormally', details: { exitCode, signal: procSignal } };
      }
      if (!isNode || exitCode === null) return null;
      if (exitCode === 0) {
        const w = readWitness(witness.file, witness.nonce, child.pid, exitCode);
        if (w.verdict === 'abnormal') {
          return { code: 'TOOL_CRASH', message: 'Tool completed with an explicitly abnormal witness', details: { exitCode, signal: null, witness: 'abnormal' } };
        }
        return null;
      }
      const w = readWitness(witness.file, witness.nonce, child.pid, exitCode);
      if (w.verdict === 'normal') return null; // valid normal:true preserves every ordinary nonzero code
      return {
        code: 'TOOL_CRASH',
        message: 'Tool exited nonzero without a valid normal-completion witness',
        details: { exitCode, signal: null, witness: w.verdict === 'abnormal' ? 'abnormal' : w.reason ?? 'unverified' },
      };
    }

    try {
      if (witness) fs.mkdirSync(path.dirname(witness.file), { recursive: true });
      // The witness preload seam applies only to the actual Node executable; original tool argv
      // is untouched (the two execArgv entries precede it) and the public request never sees either.
      const spawnArgs = witness ? ['--import', WITNESS_PRELOAD, ...args] : [...args];
      child = spawn(executable, spawnArgs, {
        cwd, env: cleanEnv, shell: false,
        detached: !IS_WINDOWS, // POSIX: own process group so the entire tree is signalable
        windowsHide: true,
      });
    } catch (error) {
      Promise.resolve().then(() => {
        state.code = spawnErrorCode(error);
        state.message = error.message;
        settle();
      });
      return;
    }

    state.streamsExpected = (child.stdout ? 1 : 0) + (child.stderr ? 1 : 0);
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      if (!stream) continue;
      stream.on('data', onChunk(key));
      stream.on('error', () => {});
      stream.once('close', () => { state.streamsClosed += 1; maybeSettle(); });
    }
    child.stdin?.on('error', () => {});
    child.stdin?.end();

    child.once('spawn', () => {
      state.started = true;
      if (signal?.aborted) { trigger('CANCELLED', 'Run was cancelled before the process could start'); return; }
      // The deadline stays active until final settlement (not merely the root exit), so pending
      // inherited pipes cannot turn into an unbounded wait; it can no longer convert an already
      // settled run, and the first trigger wins.
      timer = setTimeout(() => trigger('TIMEOUT', `Run exceeded its ${timeoutMs}-ms timeout`), timeoutMs);
      onAbort = () => trigger('CANCELLED', 'Run was cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    child.once('error', error => {
      if (!state.code) { state.code = spawnErrorCode(error); state.message = error.message; }
      if (!state.started) {
        // Spawn failed: exit/close may not follow, and the pipes are already dead.
        state.exited = true;
        state.streamsClosed = state.streamsExpected;
        state.forced = true;
        state.reapAttempted = true; // nothing started, so there is no tree to reap
        Promise.resolve().then(maybeSettle);
      }
    });

    child.once('exit', (exitCode, procSignal) => {
      state.exited = true;
      state.exitCode = exitCode;
      state.procSignal = procSignal;
      // The timeout/abort watchers stay armed until final settlement (settle clears them): a
      // deadline or cancellation that fires while inherited pipes are still draining converts
      // the run honestly instead of letting the wait run unbounded.
      if (!state.code) {
        const verdict = classifyExit();
        if (verdict) {
          state.code = verdict.code;
          state.message = verdict.message;
          state.details = verdict.details;
          state.forced = true;
          // An abrupt death can leave descendants holding the pipes: reap the owned tree first.
          reapTree(child.pid).then(outcome => {
            state.reapAttempted = true;
            if (outcome !== 'confirmed') state.cleanupUnconfirmed = true;
            maybeSettle();
          });
          const fallback = setTimeout(() => {
            state.streamsClosed = Math.max(state.streamsClosed, state.streamsExpected);
            maybeSettle();
          }, STREAM_WAIT_MS);
          fallback.unref();
        }
      }
    });

    child.once('close', () => {
      // The exit-stream ordering can leave a pipe 'close' pending; bound the wait like the trigger path.
      const fallback = setTimeout(() => {
        state.streamsClosed = Math.max(state.streamsClosed, state.streamsExpected);
        maybeSettle();
      }, STREAM_WAIT_MS);
      fallback.unref();
      maybeSettle();
    });
  });
}
