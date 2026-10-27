/**
 * C7a.S11.T6 — Independent registry ownership, lock and held-handle tests.
 *
 * A registry update inside a publication is a staged rename onto
 * `.storage/registry.json`. The contract under test (task packet
 * C7a.S11.T6): a transient EPERM/EACCES/EBUSY from that registry rename on
 * win32 permits eight attempts with the fixed backoff sequence, the existing
 * lock and the staging identity/bytes carry through the retry sequence, and
 * before each retry the transaction re-verifies ancestry, stage, destination
 * registry and lock. A tampered transaction then refuses with
 * ERR_STORAGE_REGISTRY_UNAVAILABLE before the second rename, and content
 * whose certainty the transaction has lost stays in place (never unlinked).
 *
 * Deterministic timing comes from temporarily capturing and replacing the
 * default property of `node:fs/promises`.rename (then calling
 * syncBuiltinESMExports — the accepted tests/cli/terminal-fates.test.mjs
 * pattern) and, for the backoff, the global callback-form
 * `globalThis.setTimeout` the production code schedules through. Rename
 * injection
 * is scoped to calls whose destination is this test's registry.json and
 * whose source basename matches /^registry\.staging-.*\.tmp$/; every other
 * call delegates to the real builtin. No public retry hooks, options or
 * exports are used; nothing from the implementation internals is imported.
 *
 * The physical held-handle cases drive the installed Windows PowerShell
 * interpreter as a direct child process (automated acceptance requested by
 * the owner; NOT a standalone experiment). They are platform-conditional and
 * skipped with an honest label on other operating systems, where the
 * deterministic gate-based case 1 stands in.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createStorage } from '../../packages/core/storage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

/**
 * Full installed system interpreter path (never a bare executable lookup):
 * resolved from SystemRoot/WINDIR under WindowsPowerShell\v1.0.
 */
function systemPowerShellPath() {
  const roots = [process.env.SystemRoot, process.env.WINDIR].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('no installed system PowerShell found under SystemRoot/WINDIR');
}

/** Registry-only backoff sequence from the task packet's contract. */
const POLICY_BACKOFF_MS = [20, 40, 80, 160, 320, 500, 500];
const POLICY_ATTEMPTS = POLICY_BACKOFF_MS.length + 1;

/** Registry content every owned root starts from (direct writeFile). */
const EMPTY_REGISTRY = '{"schemaVersion":1,"records":{}}';

/** Transient sharing errors the registry retry policy is scoped to. */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Fresh roots created by THIS file. Cleanup removes only these tracked roots;
 * the shared parent and any untracked/foreign sibling are left alone.
 */
const ownedRoots = new Set();
const scratchBase = path.join(here, '.tmp', 'registry-retry-safety');

after(async () => {
  for (const root of ownedRoots) {
    await fsp.rm(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
  }
  ownedRoots.clear();
});

/**
 * Random tracked storage root under tests/contracts/.tmp/registry-retry-safety/
 * with an ordinary .storage/registry.json seeded by direct writeFile.
 */
async function newOwnedRoot(label) {
  await fsp.mkdir(scratchBase, { recursive: true });
  const store = await fsp.mkdtemp(path.join(scratchBase, label.replace(/[^a-z0-9_-]+/gi, '-') + '-'));
  ownedRoots.add(store);
  await fsp.mkdir(path.join(store, '.storage'), { recursive: true });
  await fsp.writeFile(path.join(store, '.storage', 'registry.json'), EMPTY_REGISTRY, 'utf8');
  return store;
}

/**
 * The REAL global callback-form timer captured once at module load, before
 * any rig ever replaces globalThis.setTimeout. The bounded within() guard
 * schedules on this so it can never self-intercept a rig's wrapped timer.
 */
const realGlobalSetTimeout = globalThis.setTimeout.bind(globalThis);
const realGlobalClearTimeout = globalThis.clearTimeout.bind(globalThis);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Bounded await so a stuck fixture or gate fails loudly, never hangs. It
 * schedules its guard on the captured REAL global timer (captured at module
 * load) so it can never self-intercept a rig's wrapped globalThis.setTimeout.
 */
async function within(promise, ms, label) {
  let timer;
  const guard = new Promise((resolve, reject) => {
    timer = realGlobalSetTimeout(() => reject(Object.assign(
      new Error(`${label} exceeded ${ms} ms`),
      { isBoundTimeout: true },
    )), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    realGlobalClearTimeout(timer);
  }
}

/** Settle a promise into a value/error pair (rejections are an expected path). */
async function settled(promise) {
  try {
    return { value: await promise, error: undefined };
  } catch (error) {
    return { value: undefined, error };
  }
}

/** Assert a StorageError refusal with the expected stable code. */
function assertStorageRefused(error, code) {
  assert.ok(error instanceof Error, `expected a rejected Error, got ${String(error)}`);
  assert.equal(
    error.name,
    'StorageError',
    `expected StorageError, got ${error && error.name}: ${error && error.message}`,
  );
  assert.equal(error.code, code, `expected ${code}, got ${error && error.code} (${error && error.message})`);
  assert.ok(String(error.code).startsWith('ERR_STORAGE_'), 'refusal codes are stable ERR_STORAGE_* codes');
}

async function bytesEqual(file, expected) {
  const bytes = await fsp.readFile(file);
  const wanted = Buffer.isBuffer(expected) ? expected : Buffer.from(String(expected), 'utf8');
  assert.deepEqual([...bytes], [...wanted], `bytes at ${file} must be preserved`);
}

/**
 * Snapshot the lock's lstat identity AND its exact bytes. Captain supplied
 * the lock shape: an ordinary readable JSON file. A read failure is a hard
 * proof failure, never a stat-only fallback.
 */
async function lockSnapshot(file) {
  if (!existsSync(file)) {
    return { kind: 'absent' };
  }
  const stat = await fsp.lstat(file, { bigint: true });
  return {
    kind: 'present',
    identity: {
      dev: String(stat.dev),
      ino: String(stat.ino),
      birthtimeNs: String(stat.birthtimeNs),
    },
    bytes: await fsp.readFile(file),
  };
}

function assertLockUnchanged(before, after, label) {
  assert.equal(after.kind, before.kind, `${label}: lock existence changed (${before.kind} -> ${after.kind})`);
  if (before.kind === 'present') {
    assert.deepEqual(after.identity, before.identity, `${label}: lock lstat identity changed`);
    assert.deepEqual([...after.bytes], [...before.bytes], `${label}: lock bytes changed`);
  }
}

/** Snapshot a plain file's lstat identity for inode-distinctness checks. */
async function inodeIdentity(file) {
  const stat = await fsp.lstat(file, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

/**
 * Scoped injection rig for the registry rename path. Replaces the default
 * property of node:fs/promises.rename (with syncBuiltinESMExports) and the
 * global callback-form globalThis.setTimeout the production backoff schedules
 * through (both restored by withRig's finally). Records every observed
 * registry rename attempt and every observed backoff delay so each test can
 * assert what the retry sequence actually did.
 *
 * Options:
 *  - failWith: 'EPERM' | 'EACCES' | 'EBUSY' synthetic first-attempt refusal,
 *    or 'native-held-handle' to delegate to the real rename and observe the
 *    genuine sharing error from the fixture child.
 *  - gateFirstBackoff: pause the first policy backoff until releaseBackoff().
 *  - secondOutcome: 'still-fail' delegates second and later attempts to the
 *    real rename (used with the permanent physical hold).
 *  - onFirstNativeTransient(error, rig) awaited after the first real
 *    transient refusal, before it is rethrown.
 */
class RegistryRig {
  constructor(root, options = {}) {
    this.root = root;
    this.registryJson = path.join(root, '.storage', 'registry.json');
    this.lockPath = path.join(root, '.storage', 'lock');
    this.options = options;
    this.attempts = []; // { source, destination } per observed registry rename
    this.delays = []; // observed policy backoff delays
    this.capturedStages = new Map(); // stage basename -> { firstAttemptNumber, stageBytes, lock }
    this.firstBackoff = deferred();
    this.firstBackoffSeen = deferred();
    this.operation = undefined; // the one already-started storage promise
    this.operationOutcome = undefined; // settled { value, error } once drained
    this._originals = null;
  }

  /**
   * Track the one storage operation this rig runs and attach its rejection
   * handler immediately, so an assertion or fixture error before any release
   * can neither surface an unhandled rejection nor strand the paused
   * operation. Returns the same promise for the body to await.
   */
  trackOperation(promise) {
    assert.equal(this.operation, undefined, 'one rig runs one already-started operation');
    this.operation = promise;
    promise.then(
      (value) => { this.operationOutcome = { value, error: undefined }; },
      (error) => { this.operationOutcome = { value: undefined, error }; },
    );
    return promise;
  }

  /**
   * Bounded drain of that one already-started promise — never a second or
   * retried operation. Returns the tracked settled outcome, or undefined when
   * the operation is still running after the bound expired.
   */
  async drainOperation(ms = 45000) {
    if (!this.operation || this.operationOutcome) {
      return this.operationOutcome;
    }
    try {
      await within(this.operation, ms, 'tracked storage operation drain');
    } catch {
      // The immediate tracker records the outcome; a bound expiry leaves it
      // undefined and the caller fails loudly.
    }
    return this.operationOutcome;
  }

  isRegistryRename(source, destination) {
    return (
      path.resolve(String(destination)) === this.registryJson &&
      /^registry\.staging-.*\.tmp$/.test(path.basename(String(source)))
    );
  }

  isBackoffDelay(delay) {
    return POLICY_BACKOFF_MS.includes(Number(delay));
  }

  /** The capture for the stage that was seen first (the retried stage). */
  firstCapturedStage() {
    const entries = [...this.capturedStages.entries()];
    assert.ok(entries.length >= 1, 'at least one registry stage was observed');
    entries.sort((a, b) => a[1].firstAttemptNumber - b[1].firstAttemptNumber);
    return entries[0][1];
  }

  /** Group recorded attempts by stage basename, in first-seen order. */
  attemptsByStage() {
    const order = [];
    const byStage = new Map();
    for (const attempt of this.attempts) {
      const key = path.basename(attempt.source);
      if (!byStage.has(key)) {
        byStage.set(key, []);
        order.push(key);
      }
      byStage.get(key).push(attempt);
    }
    return { order, byStage };
  }

  async install() {
    // The tests run serially, so the global timer seen here is the real one.
    // Capture it and install the wrapped callback-form timer; restore puts
    // back exactly what was captured.
    this._originals = { rename: fsp.rename, setTimeout: globalThis.setTimeout };
    fsp.rename = this.wrapRename();
    globalThis.setTimeout = this.wrapSetTimeout();
    syncBuiltinESMExports();
  }

  async restore() {
    fsp.rename = this._originals.rename;
    globalThis.setTimeout = this._originals.setTimeout;
    syncBuiltinESMExports();
  }

  /** Release the paused first backoff so the retry sequence continues. */
  releaseBackoff() {
    this.firstBackoff.resolve();
  }

  wrapRename() {
    const real = this._originals.rename;
    const rig = this;
    return async function patchedRename(source, destination, ...rest) {
      if (!rig.isRegistryRename(source, destination)) {
        return real.call(this, source, destination, ...rest);
      }
      rig.attempts.push({ source: String(source), destination: String(destination) });
      const attemptNumber = rig.attempts.length;
      const stageKey = path.basename(String(source));
      if (!rig.capturedStages.has(stageKey)) {
        // Capture the identity/bytes that exist BEFORE this stage is first
        // refused, so the paused-state assertions can prove they carried
        // through. Distinct stages (reservation vs final registration) are
        // captured and counted separately.
        rig.capturedStages.set(stageKey, {
          firstAttemptNumber: attemptNumber,
          stageBytes: await fsp.readFile(String(source)),
          lock: await lockSnapshot(rig.lockPath),
        });
      }
      if (attemptNumber === 1) {
        if (rig.options.failWith === 'native-held-handle') {
          // Physical cases: delegate to the REAL rename and let the actual
          // EPERM/EACCES/EBUSY (from the fixture handle) drive the policy.
          try {
            return await real.call(this, source, destination, ...rest);
          } catch (error) {
            if (TRANSIENT_CODES.has(error && error.code) && rig.options.onFirstNativeTransient) {
              await rig.options.onFirstNativeTransient(error, rig);
            }
            throw error;
          }
        }
        if (rig.options.failWith) {
          throw Object.assign(
            new Error(`synthetic ${rig.options.failWith} on the first registry rename`),
            { code: rig.options.failWith },
          );
        }
        return real.call(this, source, destination, ...rest);
      }
      // Second and later attempts. The tamper cases assert this never runs;
      // if it does, the recorded attempt-count assertion fails the test.
      if (rig.options.secondOutcome === 'still-fail') {
        try {
          return await real.call(this, source, destination, ...rest);
        } catch (error) {
          if (TRANSIENT_CODES.has(error && error.code) && rig.options.onSubsequentNativeTransient) {
            await rig.options.onSubsequentNativeTransient(error, rig);
          }
          throw error;
        }
      }
      return real.call(this, source, destination, ...rest);
    };
  }

  /**
   * Wraps the global callback-form setTimeout `(callback, delay, ...args)`.
   * Only a numeric policy delay from [20,40,80,160,320,500,500] is observed as
   * a production backoff. The first gated policy delay registers its callback
   * to run only after rig.firstBackoff resolves (the production backoff awaits
   * `new Promise(resolve => globalThis.setTimeout(resolve, delay))`, so the
   * callback is that promise's resolve and its return value carries no
   * meaning — hence no Timeout handle is faked here). Later or ungated policy
   * delays go to the captured real timer with the exact requested delay, and
   * every non-policy timer (test runner internals included) delegates
   * untouched.
   */
  wrapSetTimeout() {
    const real = this._originals.setTimeout;
    const rig = this;
    return function patchedSetTimeout(callback, delay, ...args) {
      const isPolicyDelay = typeof delay === 'number' && rig.isBackoffDelay(delay);
      if (typeof callback !== 'function' || !isPolicyDelay) {
        return real.call(globalThis, callback, delay, ...args);
      }
      rig.delays.push(Number(delay));
      if (rig.delays.length === 1) {
        rig.firstBackoffSeen.resolve();
      }
      const gated = rig.options.gateFirstBackoff && rig.delays.length === 1;
      if (!gated) {
        // Ungated policy delays (later steps, physical cases) run on the
        // captured real timer with the exact requested delay.
        return real.call(globalThis, callback, delay, ...args);
      }
      // The first gated policy delay: its callback runs only once the test
      // releases the gate, which pauses the retry sequence deterministically.
      rig.firstBackoff.promise.then(() => callback(...args));
      return undefined;
    };
  }
}

/**
 * Install the rig for one body. The body MUST pass every storage promise it
 * starts through rig.trackOperation immediately. The finally releases any
 * deferred backoff, drains that one already-started operation with a bounded
 * await, and only then restores the builtin hooks — an assertion or fixture
 * error before a release can never strand a paused storage operation or
 * restore hooks while it still runs.
 */
async function withRig(root, options, body) {
  const rig = new RegistryRig(root, options);
  await rig.install();
  try {
    return await body(rig);
  } finally {
    try {
      // Never leave a gated backoff unheld, whichever path the body took.
      rig.releaseBackoff();
      if (rig.operation && !rig.operationOutcome) {
        const outcome = await rig.drainOperation();
        assert.notEqual(
          outcome,
          undefined,
          'the tracked storage operation must settle before hooks are restored',
        );
      }
    } finally {
      await rig.restore();
    }
  }
}

/**
 * Spawns the installed Windows PowerShell interpreter — resolved by full
 * system path, never a bare executable lookup — as a direct child holding
 * `target` open for read with FileShare.Read (FileShare.Delete is omitted, so
 * the OS refuses a rename onto the target). The owned path arrives only
 * through the child environment; no private literal appears in the script.
 * The script prints READY, waits for stdin release/EOF and disposes the
 * handle in `finally`. READY is rejected promptly on a spawn error or a
 * close before READY; both READY and cleanup are bounded, and cleanup targets
 * only this spawned child.
 */
function spawnHandleFixtureChild(target) {
  const interpreter = systemPowerShellPath();
  const script = [
    '$stream = $null',
    'try {',
    "  $stream = [System.IO.File]::Open($env:BB_HANDLE_TARGET, 'Open', 'Read', 'Read')",
    "  [Console]::Out.WriteLine('READY')",
    '  [Console]::Out.Flush()',
    '  [Console]::In.ReadToEnd() | Out-Null',
    '} finally {',
    '  if ($stream) { $stream.Dispose() }',
    '}',
  ].join('\n');
  const child = spawn(interpreter, ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BB_HANDLE_TARGET: target },
    windowsHide: true,
  });
  const outSeen = [];
  const errSeen = [];
  const ready = deferred();
  const close = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // Mark it handled so a rejection before the first bounded await cannot
  // surface as an unhandled rejection; every consumer awaits it through a
  // bounded wrapper.
  close.catch(() => undefined);
  child.stdout.on('data', (chunk) => {
    outSeen.push(String(chunk));
    if (outSeen.join('').includes('READY')) {
      ready.resolve();
    }
  });
  child.stderr.on('data', (chunk) => {
    // Consume stderr for bounded diagnostics instead of letting the child
    // block on a full pipe.
    errSeen.push(String(chunk));
  });
  const diagnostic = () => `child stdout: ${outSeen.join('')} | child stderr: ${errSeen.join('')}`;
  let releasedExit;
  return {
    child,
    close,
    diagnostic,
    /** READY within 15000 ms, or a prompt rejection on a spawn error / early close. */
    async waitReady() {
      const earlyClose = close.then((exit) => {
        throw new Error(`fixture child closed before READY (exit ${exit.code}/${exit.signal}) — ${diagnostic()}`);
      }, (error) => {
        throw new Error(`fixture child failed before READY (${error && error.message}) — ${diagnostic()}`);
      });
      // The race below is the real consumer; mark this derived promise
      // handled so winning/losing after the bound cannot read unhandled.
      earlyClose.catch(() => undefined);
      return within(
        Promise.race([ready.promise, earlyClose]),
        15000,
        `held-handle fixture READY (${interpreter})`,
      );
    },
    /**
     * Ask the script to release its handle (stdin release/EOF) and confirm
     * the direct child closed within 5000 ms. On a close timeout, kill ONLY
     * this child handle and await close once more (up to 5000 ms); a close
     * still unconfirmed after both bounds fails loudly — the timeout is
     * never swallowed and cleanup is never falsely claimed. Returns the
     * confirmed close record; callers on a success path assert its exit code.
     */
    async release() {
      if (releasedExit) {
        return releasedExit;
      }
      const first = await confirmChildClosed(child, close, 5000);
      if (first) {
        releasedExit = first;
        return first;
      }
      // The bound expired with this child still running: kill ONLY this
      // child handle and await its close once more.
      child.kill();
      const second = await confirmChildClosed(child, close, 5000);
      if (second) {
        // Confirmed termination through the kill fallback: cleanup happened,
        // and the returned record (signal, not exit 0) is not a clean exit.
        releasedExit = second;
        return second;
      }
      throw new Error(`fixture child close could not be confirmed — ${diagnostic()}`);
    },
    /**
     * finally-safe cleanup: release/confirm as above. A close that cannot be
     * confirmed fails loudly with the bounded diagnostics rather than
     * falsely claiming cleanup.
     */
    async dispose() {
      return this.release();
    },
  };
}

/**
 * Release stdin once, then await the child's own close event within the
 * bound. Returns the close record on a confirmed close, undefined when the
 * bound expired, and rethrows a real close failure (spawn error).
 */
/** Assert a fixture closed cleanly on its own: exit 0, no kill signal. */
function assertCleanClose(exit, label) {
  assert.equal(
    exit.signal,
    null,
    `${label}: the fixture must close on its own release path, not a harness kill (signal ${exit.signal})`,
  );
  assert.equal(
    exit.code,
    0,
    `${label}: a successful fixture child must exit 0, got code ${exit.code} signal ${exit.signal}`,
  );
}

async function confirmChildClosed(child, close, ms) {
  try {
    if (child.stdin && child.stdin.writable) {
      child.stdin.end();
    }
  } catch {
    // an already-closed pipe needs no release
  }
  try {
    return await within(close, ms, 'held-handle fixture child close');
  } catch (error) {
    if (!error || !error.isBoundTimeout) {
      // A real close failure (spawn error) surfaces as-is.
      throw error;
    }
    // The bound expired; the caller may kill this one child and confirm once
    // more. Still-unconfirmed after both bounds is release()'s loud failure.
    return undefined;
  }
}

describe('registry retry safety', { concurrency: 1, skip: !isWindows && 'the registry retry policy and its backoff are win32-scoped' }, () => {
  it('held/released gate: lock and stage carry through the refusal, a contender is refused while paused', async () => {
    const root = await newOwnedRoot('gate-held-released');
    const payload = {
      relativePath: 'reports/held-retry.json',
      kind: 'r.report',
      id: 'held-retry',
      value: { note: 'gate' },
    };
    const storage = createStorage({ root });
    const contender = createStorage({ root });

    const outcome = await withRig(
      root,
      { failWith: 'EPERM', gateFirstBackoff: true },
      async (rig) => {
        const operation = rig.trackOperation(storage.createImmutable(payload));
        await within(rig.firstBackoffSeen.promise, 20000, 'first registry backoff to begin');

        // Paused inside the backoff: nothing is published yet, and the
        // stage/lock identity+bytes captured before the first refusal are
        // still what the disk holds while the retry holds the existing lock.
        assert.equal(
          existsSync(path.join(root, 'reports', 'held-retry.json')),
          false,
          'nothing is published while the registry retry is paused',
        );
        const firstStage = rig.firstCapturedStage();
        const lockNow = await lockSnapshot(rig.lockPath);
        assert.equal(firstStage.lock.kind, 'present', 'the lock existed while the writer held it');
        assert.equal(lockNow.kind, 'present', 'the lock still exists while the retry is paused');
        assertLockUnchanged(firstStage.lock, lockNow, 'paused backoff');
        const stageNow = await fsp.readFile(rig.attempts[0].source);
        assert.deepEqual([...stageNow], [...firstStage.stageBytes], 'stage bytes are unchanged while paused');

        // A distinct container must be refused on the still-held lock, and
        // the refusal must not change any bytes.
        const rival = await settled(within(contender.withLock(async () => 7), 15000, 'contender withLock'));
        assertStorageRefused(rival.error, 'ERR_STORAGE_LOCK_CONFLICT');
        await bytesEqual(rig.registryJson, EMPTY_REGISTRY);
        assertLockUnchanged(lockNow, await lockSnapshot(rig.lockPath), 'contender refusal');
        const stageStill = await fsp.readFile(rig.attempts[0].source);
        assert.deepEqual([...stageStill], [...firstStage.stageBytes], 'the contender refusal changed no stage bytes');

        rig.releaseBackoff();
        const settledOperation = await settled(within(operation, 30000, 'createImmutable after the release'));
        return { rig, settledOperation };
      },
    );

    assert.equal(
      outcome.settledOperation.error,
      undefined,
      `publication after release must succeed: ${outcome.settledOperation.error && outcome.settledOperation.error.message}`,
    );
    // A successful immutable publication reaches the registry through TWO
    // distinct stages: the retried stage (one refusal, then success) and a
    // distinct final-registration stage. Total registry renames: three.
    const { order, byStage } = outcome.rig.attemptsByStage();
    assert.equal(outcome.rig.attempts.length, 3, 'three registry renames in total across the publication');
    assert.equal(order.length, 2, 'two distinct registry stages ran');
    assert.equal(byStage.get(order[0]).length, 2, 'the retried stage was attempted twice: refused, then succeeded');
    assert.equal(byStage.get(order[1]).length, 1, 'the final registration stage renamed once');
    assert.deepEqual(outcome.rig.delays, [20], 'the entire observed delay sequence is [20]');
    const result = outcome.settledOperation.value;
    assert.equal(result.relativePath, payload.relativePath);
    assert.equal(result.kind, payload.kind);
    assert.equal(result.id, payload.id);
    assert.deepEqual(await storage.read({
      relativePath: payload.relativePath,
      kind: payload.kind,
      id: payload.id,
    }), payload.value, 'readback matches the published value');
    assert.equal(existsSync(path.join(root, '.storage', 'lock')), false, 'lock removed after the successful retry');
  });

  it('stage replaced with a fresh same-byte inode during backoff: refused before the second rename, both files preserved', async () => {
    const root = await newOwnedRoot('stage-replaced-same-bytes');
    const payload = {
      relativePath: 'reports/stage-replaced.json',
      kind: 'r.report',
      id: 'stage-replaced',
      value: { note: 'replace' },
    };
    const storage = createStorage({ root });

    const outcome = await withRig(
      root,
      { failWith: 'EPERM', gateFirstBackoff: true },
      async (rig) => {
        const operation = rig.trackOperation(storage.createImmutable(payload));
        await within(rig.firstBackoffSeen.promise, 20000, 'first registry backoff to begin');
        const stagePath = rig.attempts[0].source;
        const backupPath = stagePath + '.foreign-backup.bak';
        // Foreign replacement: move the original stage away, then create a
        // fresh file with identical bytes at the original path (new inode).
        await fsp.rename(stagePath, backupPath);
        await fsp.writeFile(stagePath, rig.firstCapturedStage().stageBytes);
        rig.releaseBackoff();
        const settledOperation = await settled(within(operation, 30000, 'createImmutable after tamper'));
        return { rig, settledOperation, stagePath, backupPath };
      },
    );

    assertStorageRefused(outcome.settledOperation.error, 'ERR_STORAGE_REGISTRY_UNAVAILABLE');
    assert.equal(outcome.rig.attempts.length, 1, 'no second registry rename after the stage was replaced');
    const captured = outcome.rig.firstCapturedStage().stageBytes;
    await bytesEqual(outcome.stagePath, captured);
    await bytesEqual(outcome.backupPath, captured);
    assert.equal(existsSync(path.join(root, 'reports', 'stage-replaced.json')), false, 'the refused transaction published nothing');
  });

  it('stage bytes mutated in place during backoff: refused before the second rename, changed bytes preserved', async () => {
    const root = await newOwnedRoot('stage-mutated');
    const payload = {
      relativePath: 'reports/stage-mutated.json',
      kind: 'r.report',
      id: 'stage-mutated',
      value: { note: 'mutate' },
    };
    const storage = createStorage({ root });

    const outcome = await withRig(
      root,
      { failWith: 'EPERM', gateFirstBackoff: true },
      async (rig) => {
        const operation = rig.trackOperation(storage.createImmutable(payload));
        await within(rig.firstBackoffSeen.promise, 20000, 'first registry backoff to begin');
        const stagePath = rig.attempts[0].source;
        const mutated = '{"mutated":"by the test while the retry was paused"}';
        await fsp.writeFile(stagePath, mutated, 'utf8');
        rig.releaseBackoff();
        const settledOperation = await settled(within(operation, 30000, 'createImmutable after in-place mutation'));
        return { rig, settledOperation, stagePath, mutated };
      },
    );

    assertStorageRefused(outcome.settledOperation.error, 'ERR_STORAGE_REGISTRY_UNAVAILABLE');
    assert.equal(outcome.rig.attempts.length, 1, 'no second registry rename after the stage bytes changed');
    await bytesEqual(outcome.stagePath, outcome.mutated);
    await bytesEqual(outcome.rig.registryJson, EMPTY_REGISTRY);
  });

  it('stage path swapped for a test-local junction during backoff: refused, junction and foreign canary preserved', async (t) => {
    if (!isWindows) {
      t.skip('directory-junction placement is a win32 case; the deterministic gate and mutation cases cover the shared refusal logic on other platforms');
      return;
    }
    const root = await newOwnedRoot('stage-junction');
    // The junction's foreign target lives UNDER this fresh owned root, so it
    // is cleaned with the tracked root and never a fixed shared-parent name.
    const foreignDir = path.join(root, 'foreign-junction-target');
    await fsp.mkdir(foreignDir, { recursive: true });
    const canary = 'foreign canary bytes';
    const canaryPath = path.join(foreignDir, 'canary.txt');
    await fsp.writeFile(canaryPath, canary, 'utf8');
    const payload = {
      relativePath: 'reports/stage-junction.json',
      kind: 'r.report',
      id: 'stage-junction',
      value: { note: 'junction' },
    };
    const storage = createStorage({ root });

    const outcome = await withRig(
      root,
      { failWith: 'EPERM', gateFirstBackoff: true },
      async (rig) => {
        const operation = rig.trackOperation(storage.createImmutable(payload));
        await within(rig.firstBackoffSeen.promise, 20000, 'first registry backoff to begin');
        const stagePath = rig.attempts[0].source;
        // Test-local junction at the stage path pointing at a test-owned
        // foreign directory (no system alias configuration). The original
        // stage is moved aside, never deleted.
        const sidecar = stagePath + '.original.bak';
        await fsp.rename(stagePath, sidecar);
        await fsp.symlink(foreignDir, stagePath, 'junction');
        rig.releaseBackoff();
        const settledOperation = await settled(within(operation, 30000, 'createImmutable after junction swap'));
        return { rig, settledOperation, stagePath, sidecar };
      },
    );

    assertStorageRefused(outcome.settledOperation.error, 'ERR_STORAGE_REGISTRY_UNAVAILABLE');
    assert.equal(outcome.rig.attempts.length, 1, 'no second registry rename after the stage became a junction');
    assert.equal(existsSync(outcome.stagePath), true, 'the junction stays where the test placed it');
    assert.equal(
      path.resolve(await fsp.realpath(outcome.stagePath)),
      path.resolve(foreignDir),
      'the junction still points at the foreign directory',
    );
    await bytesEqual(canaryPath, canary);
    await bytesEqual(outcome.sidecar, outcome.rig.firstCapturedStage().stageBytes);
    await bytesEqual(outcome.rig.registryJson, EMPTY_REGISTRY);
  });

  it('registry.json overwritten with different valid JSON during backoff: refused, foreign registry and stage preserved', async () => {
    const root = await newOwnedRoot('registry-overwritten');
    const payload = {
      relativePath: 'reports/registry-overwrite.json',
      kind: 'r.report',
      id: 'registry-overwrite',
      value: { note: 'registry' },
    };
    const storage = createStorage({ root });
    const foreignRegistry = '{"schemaVersion":1,"records":{"injected":{"relativePath":"x.json","digest":"d","recordType":"mutable"}}}';

    const outcome = await withRig(
      root,
      { failWith: 'EPERM', gateFirstBackoff: true },
      async (rig) => {
        const operation = rig.trackOperation(storage.createImmutable(payload));
        await within(rig.firstBackoffSeen.promise, 20000, 'first registry backoff to begin');
        await fsp.writeFile(rig.registryJson, foreignRegistry, 'utf8');
        rig.releaseBackoff();
        const settledOperation = await settled(within(operation, 30000, 'createImmutable after registry overwrite'));
        return { rig, settledOperation };
      },
    );

    // StorageError with its stable code, not a generic exception.
    assertStorageRefused(outcome.settledOperation.error, 'ERR_STORAGE_REGISTRY_UNAVAILABLE');
    assert.equal(outcome.rig.attempts.length, 1, 'no second registry rename after the destination changed');
    await bytesEqual(outcome.rig.registryJson, foreignRegistry);
    await bytesEqual(outcome.rig.attempts[0].source, outcome.rig.firstCapturedStage().stageBytes);
  });

  it('lock file replaced by a new inode with the same bytes during backoff: refused before the second rename, replacement and backup preserved', async () => {
    const root = await newOwnedRoot('lock-reinode');
    const payload = {
      relativePath: 'reports/lock-reinode.json',
      kind: 'r.report',
      id: 'lock-reinode',
      value: { note: 'lock-reinode' },
    };
    const storage = createStorage({ root });

    const outcome = await withRig(
      root,
      { failWith: 'EPERM', gateFirstBackoff: true },
      async (rig) => {
        const operation = rig.trackOperation(storage.createImmutable(payload));
        await within(rig.firstBackoffSeen.promise, 20000, 'first registry backoff to begin');
        // Move the original lock to a backup (never unlinked), then create a
        // fresh lock at the original path holding the SAME bytes.
        const lockBackup = path.join(root, '.storage', 'lock.foreign-backup.bak');
        const originalLock = await lockSnapshot(rig.lockPath);
        assert.equal(originalLock.kind, 'present', 'the lock file exists while the writer holds it');
        await fsp.rename(rig.lockPath, lockBackup);
        await fsp.writeFile(rig.lockPath, originalLock.bytes);
        rig.releaseBackoff();
        const settledOperation = await settled(within(operation, 30000, 'createImmutable after lock replacement'));
        return { rig, settledOperation, lockBackup, originalLock };
      },
    );

    assertStorageRefused(outcome.settledOperation.error, 'ERR_STORAGE_REGISTRY_UNAVAILABLE');
    assert.equal(outcome.rig.attempts.length, 1, 'no second registry rename after the lock identity changed');
    await bytesEqual(outcome.lockBackup, outcome.originalLock.bytes);
    await bytesEqual(outcome.rig.lockPath, outcome.originalLock.bytes);
    await bytesEqual(outcome.rig.registryJson, EMPTY_REGISTRY);
    await bytesEqual(outcome.rig.attempts[0].source, outcome.rig.firstCapturedStage().stageBytes);
  });

  it('lock bytes changed during backoff: refused before the second rename, changed bytes preserved', async () => {
    const root = await newOwnedRoot('lock-bytes-changed');
    const payload = {
      relativePath: 'reports/lock-bytes.json',
      kind: 'r.report',
      id: 'lock-bytes',
      value: { note: 'lock-bytes' },
    };
    const storage = createStorage({ root });
    const changedLock = '{"owner":"a foreign writer","token":"changed-lock-bytes"}';

    const outcome = await withRig(
      root,
      { failWith: 'EPERM', gateFirstBackoff: true },
      async (rig) => {
        const operation = rig.trackOperation(storage.createImmutable(payload));
        await within(rig.firstBackoffSeen.promise, 20000, 'first registry backoff to begin');
        const originalLock = await lockSnapshot(rig.lockPath);
        assert.equal(originalLock.kind, 'present', 'the lock file exists while the writer holds it');
        await fsp.writeFile(rig.lockPath, changedLock, 'utf8');
        rig.releaseBackoff();
        const settledOperation = await settled(within(operation, 30000, 'createImmutable after lock byte change'));
        return { rig, settledOperation, originalLock };
      },
    );

    assertStorageRefused(outcome.settledOperation.error, 'ERR_STORAGE_REGISTRY_UNAVAILABLE');
    assert.equal(outcome.rig.attempts.length, 1, 'no second registry rename after the lock bytes changed');
    await bytesEqual(outcome.rig.lockPath, changedLock);
    await bytesEqual(outcome.rig.registryJson, EMPTY_REGISTRY);
    await bytesEqual(outcome.rig.attempts[0].source, outcome.rig.firstCapturedStage().stageBytes);
  });

  it('registry.json replaced by a same-byte different inode during backoff: refused, bytes preserved', async () => {
    const root = await newOwnedRoot('registry-reinode');
    const payload = {
      relativePath: 'reports/registry-reinode.json',
      kind: 'r.report',
      id: 'registry-reinode',
      value: { note: 'reinode' },
    };
    const storage = createStorage({ root });

    const outcome = await withRig(
      root,
      { failWith: 'EPERM', gateFirstBackoff: true },
      async (rig) => {
        const operation = rig.trackOperation(storage.createImmutable(payload));
        await within(rig.firstBackoffSeen.promise, 20000, 'first registry backoff to begin');
        // Inode-preserving replacement: rename the original registry to a
        // backup (never unlink it first, which could recycle the inode),
        // then create a fresh same-byte file at the original path.
        const registryBackup = path.join(root, '.storage', 'registry.foreign-backup.bak');
        const originalBytes = await fsp.readFile(rig.registryJson);
        const originalIdentity = await inodeIdentity(rig.registryJson);
        await fsp.rename(rig.registryJson, registryBackup);
        await fsp.writeFile(rig.registryJson, originalBytes);
        const replacementIdentity = await inodeIdentity(rig.registryJson);
        assert.notDeepStrictEqual(
          replacementIdentity,
          originalIdentity,
          'the replacement must be a genuinely different inode for this identity test to mean anything',
        );
        rig.releaseBackoff();
        const settledOperation = await settled(within(operation, 30000, 'createImmutable after same-byte reinode swap'));
        return { rig, settledOperation, originalBytes, registryBackup };
      },
    );

    assertStorageRefused(outcome.settledOperation.error, 'ERR_STORAGE_REGISTRY_UNAVAILABLE');
    assert.equal(outcome.rig.attempts.length, 1, 'no second registry rename after the destination inode changed');
    const after = await fsp.readFile(outcome.rig.registryJson);
    assert.deepEqual([...after], [...outcome.originalBytes], 'registry bytes preserved across the same-byte replacement');
    // The backup was never unlinked and keeps its original bytes.
    await bytesEqual(outcome.registryBackup, outcome.originalBytes);
    await bytesEqual(outcome.rig.attempts[0].source, outcome.rig.firstCapturedStage().stageBytes);
  });

  it('.storage renamed away and rebuilt with foreign content during backoff: refused, foreign bytes and backup preserved', async () => {
    const root = await newOwnedRoot('ancestry-replaced');
    const payload = {
      relativePath: 'reports/ancestry.json',
      kind: 'r.report',
      id: 'ancestry',
      value: { note: 'ancestry' },
    };
    const storage = createStorage({ root });
    const storageDir = path.join(root, '.storage');
    const backupDir = path.join(root, '.storage.foreign-backup');

    const outcome = await withRig(
      root,
      { failWith: 'EPERM', gateFirstBackoff: true },
      async (rig) => {
        const operation = rig.trackOperation(storage.createImmutable(payload));
        await within(rig.firstBackoffSeen.promise, 20000, 'first registry backoff to begin');
        const originalRegistryBytes = await fsp.readFile(rig.registryJson);
        // Replace the ancestry: move .storage away, then build a foreign
        // .storage with a foreign lock and a foreign registry canary there.
        await fsp.rename(storageDir, backupDir);
        await fsp.mkdir(storageDir, { recursive: true });
        const foreignLock = 'foreign-lock-bytes';
        const foreignRegistry = '{"schemaVersion":1,"records":{"foreign":true}}';
        await fsp.writeFile(path.join(storageDir, 'lock'), foreignLock, 'utf8');
        await fsp.writeFile(path.join(storageDir, 'registry.json'), foreignRegistry, 'utf8');
        rig.releaseBackoff();
        const settledOperation = await settled(within(operation, 30000, 'createImmutable after ancestry replacement'));
        return { rig, settledOperation, originalRegistryBytes, foreignLock, foreignRegistry };
      },
    );

    assertStorageRefused(outcome.settledOperation.error, 'ERR_STORAGE_REGISTRY_UNAVAILABLE');
    assert.equal(outcome.rig.attempts.length, 1, 'no second registry rename after the ancestry was replaced');
    // The follow-up must not carry the transaction into the replaced ancestry.
    await bytesEqual(path.join(storageDir, 'lock'), outcome.foreignLock);
    await bytesEqual(path.join(storageDir, 'registry.json'), outcome.foreignRegistry);
    // The moved-away backup keeps the bytes it had when it was renamed.
    await bytesEqual(path.join(backupDir, 'registry.json'), outcome.originalRegistryBytes);
  });

  it('physical Windows held handle: real rename refusal, test releases, retry publishes correct bytes', async (t) => {
    if (!isWindows) {
      t.skip('physical held-handle acceptance is a win32 case; on this platform the deterministic gate case stands in (scoped platform simulation)');
      return;
    }
    const root = await newOwnedRoot('physical-held-released');
    const payload = {
      relativePath: 'reports/physical.json',
      kind: 'r.report',
      id: 'physical-held',
      value: { note: 'physical' },
    };
    const storage = createStorage({ root });
    const registryJson = path.join(root, '.storage', 'registry.json');
    const fixture = spawnHandleFixtureChild(registryJson);
    try {
      await fixture.waitReady();
      let sawRealRefusal = false;
      let releaseExit;
      const outcome = await withRig(
        root,
        {
          failWith: 'native-held-handle',
          onFirstNativeTransient: async (error) => {
            // The real refusal happened while the test-owned handle was held:
            // release the fixture handle, confirm the direct child closed,
            // then rethrow the same native error so the production retry
            // sequence observes the transient failure it is scoped to.
            sawRealRefusal = true;
            t.diagnostic(`real held-handle refusal observed: ${error.code}`);
            // The handle-release path must confirm a clean close.
            releaseExit = await fixture.release();
          },
        },
        async (rig) => {
          const operation = rig.trackOperation(storage.createImmutable(payload));
          const settledOperation = await settled(within(operation, 60000, 'physical createImmutable'));
          return { rig, settledOperation };
        },
      );
      assert.equal(sawRealRefusal, true, 'this run required an actual held-handle failure before release');
      assert.equal(
        outcome.settledOperation.error,
        undefined,
        `the retry after release must publish: ${outcome.settledOperation.error && outcome.settledOperation.error.message}`,
      );
      // A successful fixture closed through its own release path with exit 0.
      assert.ok(releaseExit, 'the release path recorded the confirmed close');
      assertCleanClose(releaseExit, 'held-handle fixture after release');
      // Total observed renames: retried stage refused, retried stage
      // succeeded, final registration stage once — at least three.
      assert.ok(
        outcome.rig.attempts.length >= 3,
        `the real refusal, its successful retry and the final registration stage were all recorded (observed ${outcome.rig.attempts.length})`,
      );
      assert.deepEqual(await storage.read({
        relativePath: payload.relativePath,
        kind: payload.kind,
        id: payload.id,
      }), payload.value, 'readback after the physical retry matches the published value');
    } finally {
      await fixture.dispose();
    }
  });

  it('physical Windows permanent hold: the eight-attempt policy is exhausted while the registry stays unchanged', async (t) => {
    if (!isWindows) {
      t.skip('physical held-handle acceptance is a win32 case; deterministic refusal paths are covered by the gate cases on other platforms');
      return;
    }
    const root = await newOwnedRoot('physical-permanent');
    const payload = {
      relativePath: 'reports/physical-permanent.json',
      kind: 'r.report',
      id: 'physical-permanent',
      value: { note: 'permanent' },
    };
    const storage = createStorage({ root });
    const registryJson = path.join(root, '.storage', 'registry.json');
    const fixture = spawnHandleFixtureChild(registryJson);
    try {
      await fixture.waitReady();
      const outcome = await withRig(
        root,
        { failWith: 'native-held-handle', secondOutcome: 'still-fail' },
        async (rig) => {
          const operation = rig.trackOperation(storage.createImmutable(payload));
          const settledOperation = await settled(within(operation, 60000, 'physical createImmutable under a permanent hold'));
          return { rig, settledOperation };
        },
      );
      assertStorageRefused(outcome.settledOperation.error, 'ERR_STORAGE_REGISTRY_UNAVAILABLE');
      assert.equal(outcome.rig.attempts.length, POLICY_ATTEMPTS, `the policy permits ${POLICY_ATTEMPTS} attempts and no more`);
      assert.deepEqual(outcome.rig.delays, POLICY_BACKOFF_MS, 'the observed backoff delays match the policy sequence');
      // While the registry stayed genuinely held, nothing renamed onto it:
      // the bytes are still the ones the test seeded.
      await bytesEqual(registryJson, EMPTY_REGISTRY);
    } finally {
      // Release and confirm-close the fixture child through its own direct
      // handle only; an unconfirmed close is a loud failure, not a swallow.
      await fixture.dispose();
    }
  });
});
