/* Fixed-schedule diagnostic replay — a release-test support script.
 *
 * This is a support script, not an automatically discovered *.test.mjs file,
 * and it is not a product change or a test-gate replacement.
 *
 * What it does. It runs the existing, unmodified test file
 * `tests/lifecycle/lifecycle.test.mjs` under Node's test runner over a fixed
 * observation matrix: three serial rounds of one child, then three concurrent
 * rounds of two children, nine planned children in total, with no retries and
 * no reruns until green. The runner selects exactly four named lifecycle
 * tests through one fully anchored, regex-escaped alternation passed as
 * --test-name-pattern; matching is by exact whole test name.
 *
 * Each child's raw stdout and stderr bytes are retained unmodified in this
 * driver's own stdout. Every child block carries a preceding JSON metadata
 * line: label, exact executable and args, start and finish instants in ISO
 * form, elapsed milliseconds, exit code (null when unknown), signal (null when
 * absent), a timeout boolean and a tapSummaryComplete flag, which says
 * whether that child's retained stdout carried the complete expected TAP
 * summary footer. A JSON summary closes the output: it counts the children
 * whose retained stdout lacked that complete footer (incompleteSummaryCount),
 * and a completed matrix requires that count to be zero, so a missing,
 * partial, skipped or todo summary cannot pass even when the child exit code
 * is 0. The driver writes no files.
 *
 * Limits. The 20000 ms per-child timer is a kill-request timer, not a
 * guaranteed wall-clock deadline: on expiry the one directly spawned Node
 * runner handle is asked to die, that handle's close event is awaited, and
 * scheduling of further rounds stops. The kill targets only the direct
 * spawned Node runner. Node's default per-file test isolation can create a
 * nested process for the test file, and that nested process can survive the
 * direct-runner kill, even though the selected test bodies do not themselves
 * spawn processes. The driver awaits close without a second deadline, so
 * closure after a kill is not bounded by this script; the caller must retain
 * an outer foreground shell timeout around this driver. Each stream is capped
 * at 4 MiB of captured bytes; an overflow stops scheduling, kills that child
 * and marks the observation incomplete — it is not a pass. Only spawned child
 * handles are ever killed; no process is killed by a discovered PID or a broad
 * image name, and no process-tree cleanup is claimed. The four selected tests
 * do not spawn subprocesses of their own. These timeout, post-kill closure
 * and overflow failure paths were not exercised by the prior observations,
 * which had no timeouts. The limitation is explicit and documented, accepted
 * as a review-fix option; it is not a launch-environment or storage
 * workaround.
 *
 * Output byte rules. Stream bytes are held as raw Buffer chunks and written
 * verbatim; nothing that is written out is decoded and re-encoded along the
 * way. The one exception is read-only and internal: the TAP summary
 * completeness check decodes retained stdout for inspection alone, and the
 * bytes written remain the original Buffers. A framing newline is added after
 * a block whose final byte is not a newline, and that framing byte is
 * separate from the retained stream bytes.
 *
 * Environment metadata is limited to platform, Node version, libuv version,
 * architecture and the operating system's parallelism hint; the process
 * environment, endpoints and model configuration are not printed. Children
 * inherit this process's environment unchanged; the driver neither invents nor
 * overrides scratch roots, and the selected tests create and clean their own
 * per-test scratch.
 *
 * This fixed observation matrix is not proof of a clean full gate. A failed
 * or incomplete observation sets the exit code to 1. No failure is classified,
 * forgiven or retried by this script.
 */

import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasCompleteTapSummary } from './tap-summary.mjs';

/* ------------------------------------------------------------------ constants */

/** Repository root: this file lives three directories below it. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The existing test file, named by a path relative to the repository root. */
const TEST_FILE = 'tests/lifecycle/lifecycle.test.mjs';

/** The exact four test names, in the order fixed by the diagnostic brief. */
const TEST_NAMES = Object.freeze([
  'every legitimate state still reports consistent with no coherence findings',
  'a state record with an unknown field, a foreign kind or another run identity is refused',
  'a declaration that conflicts with the accepted manifest or schema is refused',
  'an interrupted operation keeps its own diagnosis over the coherence report',
]);

/**
 * One kill-request timer and one capture cap, both per child, per stream.
 * CHILD_TIMEOUT_MS is when a kill is requested for the direct runner handle,
 * not a guaranteed wall-clock deadline: closure afterwards is unbounded here.
 */
const CHILD_TIMEOUT_MS = 20000;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;

/** Fixed plan: three serial rounds of one child, then three concurrent of two. */
const SERIAL_ROUNDS = 3;
const CONCURRENT_ROUNDS = 3;
const PLANNED_CHILDREN = SERIAL_ROUNDS * 1 + CONCURRENT_ROUNDS * 2;

/* ---------------------------------------------------------------- name pattern */

/**
 * Escape regex metacharacters so a name can only match itself. Conservative by
 * design: every metacharacter gets a leading backslash and every other
 * character stays verbatim.
 */
function escapeRegExpLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, (character) => '\\' + character);
}

/**
 * One alternation fully anchored at both ends of every alternative: the group
 * keeps ^ and $ in force for each name, so a match is an exact whole name and
 * never a substring or prefix of one.
 */
function buildNamePattern(names) {
  return '^(?:' + names.map(escapeRegExpLiteral).join('|') + ')$';
}

/* --------------------------------------------------------------------- output */

/** One line of JSON, kept separate from the raw child bytes that follow it. */
function printJsonLine(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

/**
 * Write retained stream bytes verbatim, then a framing newline when the last
 * retained byte is not already a newline. The framing byte is output framing;
 * it is not appended to the retained bytes themselves.
 */
function writeStream(chunks) {
  for (const chunk of chunks) {
    process.stdout.write(chunk);
  }
  if (chunks.length > 0) {
    const last = chunks[chunks.length - 1];
    if (last.length === 0 || last[last.length - 1] !== 0x0a) {
      process.stdout.write('\n');
    }
  }
}

/* ------------------------------------------------------------- child execution */

/**
 * Spawn one child of the fixed matrix, retain both streams as raw Buffer
 * chunks, and resolve a deterministic result block once the child has closed.
 *
 * Lifecycle rules. A ChildProcess that was actually created settles on its
 * close event alone: the error event never settles it and never clears the
 * kill-request timer early. On supported Node versions a spawn failure
 * surfaces as an
 * error event emitted before the close event; the error is recorded and the
 * stop of further scheduling is requested, and the close that follows ends the
 * observation. A synchronous throw from spawn is a setup failure with no child
 * at all: it is recorded and resolved immediately, because there is nothing to
 * await. Outcome facts stay null where unknown: a signalled or setup-failed
 * child has no numeric exit code. Overflow truncates capture (and marks the
 * observation incomplete); it never rewrites the bytes that were captured.
 * Each result carries tapSummaryComplete, derived from the retained stdout
 * bytes decoded as UTF-8 for the check alone: the chunks themselves stay the
 * original Buffers and are never replaced or rewritten. A child that never
 * started (a synchronous spawn throw) has tapSummaryComplete false.
 */
function runChild(label, argv) {
  return new Promise((resolve) => {
    const startInstant = new Date();
    const startedAt = performance.now();

    const settle = (facts) => {
      resolve({
        label,
        executable: argv[0],
        args: Object.freeze([...argv.slice(1)]),
        startISO: startInstant.toISOString(),
        finishISO: new Date().toISOString(),
        elapsedMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        ...facts,
      });
    };

    // A synchronous spawn throw is a setup failure with no child at all.
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: REPO_ROOT,
        shell: false,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      stopScheduling = true;
      const empty = Object.freeze([]);
      settle({
        exitCode: null,
        signal: null,
        timeout: false,
        overflow: false,
        setupError: String(error && error.stack ? error.stack : error),
        // No child ever ran, so no TAP summary can exist.
        tapSummaryComplete: false,
        stdoutChunks: empty,
        stderrChunks: empty,
      });
      return;
    }

    // Child created: retain raw chunks, and settle on close alone.
    const stdoutChunks = [];
    const stderrChunks = [];
    const streamBytes = { stdout: 0, stderr: 0 };
    let timedOut = false;
    let overflow = false;
    let setupError = null;
    let settled = false;

    const requestStop = () => {
      // Stop scheduling further rounds after this round's children close.
      stopScheduling = true;
    };

    const killSelf = () => {
      try {
        child.kill();
      } catch {
        // A child that already closed cannot be killed; its close ends it.
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      requestStop();
      // The kill request targets only the direct spawned Node runner handle.
      // Node's default per-file test isolation can create a nested process
      // that may survive this kill, even though the selected test bodies do
      // not themselves spawn processes. Closure after a kill is not bounded
      // by this script, which awaits close without a second deadline; the
      // caller must retain an outer foreground shell timeout.
      killSelf();
      // No settle here: the close that follows the kill ends the observation.
    }, CHILD_TIMEOUT_MS);

    const consume = (name) => (chunk) => {
      if (overflow) return; // capture is already stopped; keep the bytes held
      const nextBytes = streamBytes[name] + chunk.length;
      if (nextBytes > MAX_STREAM_BYTES) {
        overflow = true;
        requestStop();
        killSelf();
        return;
      }
      (name === 'stdout' ? stdoutChunks : stderrChunks).push(chunk);
      streamBytes[name] = nextBytes;
    };

    child.stdout.on('data', consume('stdout'));
    child.stderr.on('data', consume('stderr'));

    // Recorded on error; the observation still ends on close, not here.
    child.on('error', (error) => {
      if (settled) return;
      setupError = String(error && error.stack ? error.stack : error);
      requestStop();
    });

    // The single settlement point for a created child.
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // UTF-8 decoding here is for the completeness check only; the retained
      // chunks below stay the original Buffers, byte-for-byte untouched.
      const tapSummaryComplete = hasCompleteTapSummary(
        Buffer.concat(stdoutChunks).toString('utf8'),
      );
      settle({
        exitCode: code === void 0 ? null : code,
        signal: signal === void 0 ? null : signal,
        timeout: timedOut,
        overflow,
        setupError,
        tapSummaryComplete,
        stdoutChunks: Object.freeze(stdoutChunks),
        stderrChunks: Object.freeze(stderrChunks),
      });
    });
  });
}

/* ------------------------------------------------------------------- schedule */

/** Set by a timed-out, overflowing or setup-failed child: no further rounds. */
let stopScheduling = false;

/** The matrix as data: labels are deterministic and appear in the metadata. */
function buildPlan() {
  const plan = [];
  for (let round = 1; round <= SERIAL_ROUNDS; round += 1) {
    plan.push(Object.freeze({
      round,
      kind: 'serial',
      labels: Object.freeze([`round-${round}-serial-1`]),
    }));
  }
  for (let roundIndex = 0; roundIndex < CONCURRENT_ROUNDS; roundIndex += 1) {
    const round = SERIAL_ROUNDS + roundIndex + 1;
    plan.push(Object.freeze({
      round,
      kind: 'concurrent',
      labels: Object.freeze([`round-${round}-concurrent-1`, `round-${round}-concurrent-2`]),
    }));
  }
  return plan;
}

async function main() {
  if (process.argv.length > 2) {
    process.stderr.write(
      `This driver takes no arguments; received: ${JSON.stringify(process.argv.slice(2))}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const pattern = buildNamePattern(TEST_NAMES);
  const argv = Object.freeze([
    process.execPath,
    '--test',
    '--test-reporter=tap',
    '--test-name-pattern=' + pattern,
    TEST_FILE,
  ]);

  printJsonLine({
    kind: 'driver-environment',
    platform: process.platform,
    nodeVersion: process.version,
    uvVersion: process.versions.uv ?? null,
    arch: process.arch,
    availableParallelism: typeof os.availableParallelism === 'function' ? os.availableParallelism() : null,
  });

  const results = [];
  for (const round of buildPlan()) {
    if (stopScheduling) break;
    // One round awaits every child closure before the next round is started.
    const children = await Promise.all(round.labels.map((label) => runChild(label, argv)));
    for (const child of children) {
      results.push(child);
      // Deterministic per-child block: metadata line, then the raw bytes.
      const { stdoutChunks, stderrChunks, ...facts } = child;
      printJsonLine({ kind: 'child', round: round.round, roundKind: round.kind, ...facts });
      writeStream(stdoutChunks);
      writeStream(stderrChunks);
    }
  }

  const completedChildren = results.length;
  const childNonzeroCount = results.filter((r) => r.exitCode !== 0).length;
  const timedOutCount = results.filter((r) => r.timeout).length;
  const overflowCount = results.filter((r) => r.overflow).length;
  const setupErrorCount = results.filter((r) => r.setupError !== null).length;
  const signalCount = results.filter((r) => r.signal !== null).length;
  // A missing, partial, skipped or todo TAP summary is incomplete even when
  // the child exit code is 0: completeness comes from the retained stdout.
  const incompleteSummaryCount = results.filter((r) => r.tapSummaryComplete !== true).length;
  const completedMatrix =
    completedChildren === PLANNED_CHILDREN
    && childNonzeroCount === 0
    && timedOutCount === 0
    && overflowCount === 0
    && setupErrorCount === 0
    && signalCount === 0
    && incompleteSummaryCount === 0;

  printJsonLine({
    kind: 'summary',
    plannedChildren: PLANNED_CHILDREN,
    completedChildren,
    childNonzeroCount,
    timedOutCount,
    overflowCount,
    setupErrorCount,
    signalCount,
    incompleteSummaryCount,
    completedMatrix,
  });

  // Exit 0 only when every planned child closed with code 0, carried the
  // complete TAP summary footer, and no signal, timeout or overflow was
  // observed. Failed or incomplete observations exit 1.
  process.exitCode = completedMatrix ? 0 : 1;
}

try {
  await main();
} catch (error) {
  // A setup error is also an incomplete observation: report it and exit nonzero.
  process.stderr.write(`Diagnostic driver failed: ${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
