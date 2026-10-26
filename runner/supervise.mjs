import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  root,
  assertSnapshot,
  contained,
  rejectLinksTo,
  files,
  tree,
} from './files.mjs';
import {
  CEILING_POLICY,
  ceilingMs,
  ceilingSeconds,
  declaredCeiling,
  deadlineFrom,
  projectRunStatus,
} from './ceiling.mjs';
import {
  assertDispatchAllowed,
  reconcileSupervision,
} from './supervision.mjs';
import {
  freezeSubmission,
  openOfficialExecution,
  terminalOutcomeOf,
} from './execution-authority.mjs';
export const OFFICIAL_DSH_BENCHMARK = 'OFFICIAL_DSH_BENCHMARK';
export const GENERIC_COMMAND = 'GENERIC_COMMAND';
export function stopProcessTree(child) {
  if (!child.pid) return { requested: false, reason: 'No process ID' };
  if (process.platform === 'win32') {
    const p = spawnSync(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    );
    return {
      requested: p.status === 0,
      code: p.status,
      error: p.error?.message || null,
      output: (p.stdout || '') + (p.stderr || ''),
    };
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
    return { requested: true };
  } catch (e) {
    return { requested: false, error: String(e) };
  }
}
// Low-level primitive. The deadline is always supplied by the caller; there is
// no global execution ceiling. Official runs derive it from the run manifest's
// declared timeCeilingMinutes.
export async function executeCommand(
  command,
  cwd,
  { deadlineMs, stop = stopProcessTree, officialWindow = null } = {},
) {
  if (
    !Array.isArray(command) ||
    !command.length ||
    command.some((x) => typeof x !== 'string' || !x)
  )
    throw Error('Whole-run executable and argument array required');
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
    throw Error('Invalid deadline');
  // ONE SHARED CLOCK. An official run passes the absolutes already bound
  // before first dispatch; this function then reports THOSE, never a second
  // window of its own. Candidate.8 recomputed startedAt/deadlineAt here, which
  // put the execution deadline 125ms after the watchdog's.
  if (
    officialWindow &&
    (!Number.isFinite(Date.parse(officialWindow.startedAt)) ||
      !Number.isFinite(Date.parse(officialWindow.deadlineAt)))
  )
    throw Error('Official execution window must carry parseable absolutes');
  const observationStartedAt = new Date().toISOString();
  const startedAt = officialWindow?.startedAt ?? observationStartedAt;
  const child = spawn(command[0], command.slice(1), {
    cwd,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let logs = '',
    expired = false,
    terminationRequest = null,
    terminationRequestedAt = null,
    watchdog;
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  let timer;
  const result = await new Promise((resolve) => {
    let finished = false;
    const finish = (extra) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(watchdog);
      resolve(extra);
    };
    child.once('error', (error) =>
      finish({
        exitCode: null,
        launchError: String(error),
        processExitObserved: false,
      }),
    );
    child.once('exit', (code, signal) =>
      finish({ exitCode: code, signal, processExitObserved: true }),
    );
    timer = setTimeout(() => {
      expired = true;
      terminationRequestedAt = new Date().toISOString();
      try {
        terminationRequest = stop(child);
      } catch (e) {
        terminationRequest = { requested: false, error: String(e) };
      }
      watchdog = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish({ exitCode: null, processExitObserved: false });
      }, 2000);
    }, deadlineMs);
  });
  const observationEndedAt = new Date().toISOString();
  const observedStoppedAt = result.processExitObserved
    ? observationEndedAt
    : null;
  // The authoritative deadline is the bound one, not observationStart + remaining.
  const deadlineAt =
    officialWindow?.deadlineAt ??
    new Date(Date.parse(startedAt) + deadlineMs).toISOString();
  const stopFailure =
    expired && (!terminationRequest?.requested || !result.processExitObserved);
  const actualWallSeconds =
    (Date.parse(observationEndedAt) - Date.parse(startedAt)) / 1000;
  const ceilingSecondsForWindow =
    (Date.parse(deadlineAt) - Date.parse(startedAt)) / 1000;
  const overrunSeconds = Math.max(
    0,
    (Date.parse(observationEndedAt) - Date.parse(deadlineAt)) / 1000,
  );
  return {
    startedAt,
    deadlineAt,
    completedAt: observedStoppedAt,
    cutoffAt: deadlineAt,
    observationEndedAt,
    deadlineOverrunSeconds: overrunSeconds,
    overrunSeconds,
    observedStoppedAt,
    terminationRequestedAt,
    observedWallSeconds: actualWallSeconds,
    actualWallSeconds,
    observationStartedAt,
    officialWallSeconds: Math.min(actualWallSeconds, ceilingSecondsForWindow),
    status: expired ? 'TIME_LIMIT' : result.exitCode === 0 ? 'COMPLETED' : null,
    // Single projection of the evidence above onto the run status vocabulary.
    runStatus: projectRunStatus({
      expired,
      launchError: result.launchError,
      exitCode: result.exitCode,
      stopFailure,
      overrunSeconds,
    }),
    validOutcome:
      !stopFailure &&
      (expired ||
        (result.exitCode === 0 &&
          Date.parse(observationEndedAt) <= Date.parse(deadlineAt))),
    harnessBehavior: stopFailure
      ? 'STOP_FAILURE'
      : expired
        ? 'DEADLINE_STOP_REQUESTED'
        : 'PROCESS_EXIT',
    terminationRequest,
    terminationOutcome: stopFailure
      ? 'STOP_FAILURE'
      : expired
        ? terminationRequest?.requested
          ? 'STOPPED'
          : 'STOP_NOT_REQUESTED'
        : 'PROCESS_EXIT',
    ...result,
    logs,
  };
}
// Official benchmark execution has exactly one route and it structurally
// requires a live supervision binding. GENERIC_COMMAND exists for non-benchmark
// host commands and is explicitly not an official benchmark outcome, rather than
// being the same path with the gate switched off.
export async function supervise(
  id,
  command,
  {
    timeCeilingMinutes,
    armedEvidencePath,
    expectedTeamId,
    mode = OFFICIAL_DSH_BENCHMARK,
  } = {},
) {
  if (![OFFICIAL_DSH_BENCHMARK, GENERIC_COMMAND].includes(mode))
    throw Error('Unknown supervision mode ' + mode);
  // Argument/binding validation precedes any owner-state checks so the official
  // route cannot be entered at all without a supervision binding.
  if (mode === OFFICIAL_DSH_BENCHMARK) {
    if (!armedEvidencePath)
      throw Error(
        'Official DSH benchmark execution requires watchdog ARMED evidence; use GENERIC_COMMAND for non-benchmark commands',
      );
    if (expectedTeamId === undefined)
      throw Error('Official DSH benchmark execution requires the bound team identity');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw Error('Invalid ID');
  const hashes = assertSnapshot();
  const record = path.join(root, 'artifacts/runs', id + '.json');
  const m = JSON.parse(fs.readFileSync(record));
  if (
    m.runId !== id ||
    path.resolve(m.destination) !== path.resolve(m.base, id) ||
    !contained(m.base, m.destination) ||
    contained(root, m.destination)
  )
    throw Error('Unsafe registered workspace');
  rejectLinksTo(m.destination);
  files(m.destination, new Set());
  if (
    JSON.stringify(m.hashes) !== JSON.stringify(hashes) ||
    tree(m.destination).hash !== m.publicHash
  )
    throw Error('Run must start from exact fresh candidate');
  // The ceiling is read from the seeded manifest, never from the launch call.
  const ceiling = declaredCeiling(m);
  if (timeCeilingMinutes !== undefined && timeCeilingMinutes !== ceiling)
    throw Error(
      'Declared run ceiling is immutable; seeded manifest says ' +
        ceiling +
        ' minutes',
    );
  // H2: official execution may not begin unless a correct watchdog process
  // exists, its ARMED evidence binds run/team/PID/ceiling/deadline, and it is
  // still alive at this authority edge. Fails closed.
  const official = mode === OFFICIAL_DSH_BENCHMARK;
  let dispatchGate = null;
  let executionIdentity = null;
  let authority = null;
  if (official)
    dispatchGate = assertDispatchAllowed(id, {
      armedEvidencePath,
      expectedTeamId,
      phase: 'PRE_DISPATCH',
    });
  const out = path.join(root, 'artifacts/runs', id + '-execution.json');
  if (fs.existsSync(out)) throw Error('Run ID already executed');
  const active = path.join(root, 'artifacts/runs', id + '-active.json');
  // The official clock is the watchdog's clock: an official run adopts the
  // ARMED startedAt/deadlineAt rather than starting a second independent one.
  const officialStartedAt = official
    ? dispatchGate.startedAt
    : new Date().toISOString();
  if (official) {
    // The ONLY way official execution authority comes into existence. It
    // persists the authoritative record that every later stage resolves from
    // disk; no stage accepts a caller-supplied substitute.
    authority = openOfficialExecution({
      runId: id,
      dispatchGate,
      candidateVersion: hashes.version.version,
      workloadHash: hashes.starter,
      armedEvidencePath,
      expectedTeamId,
    });
    executionIdentity = authority.executionIdentity;
  }
  fs.writeFileSync(
    active,
    JSON.stringify({
      kind: 'COOPERATIVE_EXECUTION',
      startedAt: officialStartedAt,
      timeCeilingMinutes: ceiling,
      ceilingPolicy: CEILING_POLICY,
      deadlineAt: official
        ? dispatchGate.deadlineAt
        : deadlineFrom(officialStartedAt, ceiling),
      executionId: executionIdentity?.executionId ?? null,
    }),
    { flag: 'wx' },
  );
  let execution;
  try {
    const result = {
      runId: id,
      benchmarkVersion: m.benchmarkVersion,
      trustModel: 'COOPERATIVE_WORKSPACE_NO_ADVERSARIAL_OS_CONTAINMENT',
      configuredTimeCeilingMinutes: ceiling,
      timeCeilingSeconds: ceilingSeconds(ceiling),
      ceilingPolicy: CEILING_POLICY,
      mode,
      official,
      dispatchGate,
      executionIdentity,
      supervisionRequired: official,
      ...(await executeCommand(command, m.destination, {
        // ONE SHARED CLOCK: an official run consumes the REMAINING time to the
        // already-bound deadline and reports the bound absolutes. A generic
        // command keeps its own full-ceiling window.
        deadlineMs: official
          ? Math.max(1, Date.parse(dispatchGate.deadlineAt) - Date.now())
          : ceilingMs(ceiling),
        officialWindow: official
          ? {
              startedAt: dispatchGate.startedAt,
              deadlineAt: dispatchGate.deadlineAt,
            }
          : null,
      })),
    };
    // Structural immutability check: the declared ceiling must not have been
    // edited while the official clock was running.
    const afterwards = JSON.parse(fs.readFileSync(record));
    if (declaredCeiling(afterwards) !== ceiling)
      throw Error(
        'Run ceiling changed after official execution started; evidence rejected',
      );
    if (official) {
      // Revalidate the binding immediately after the governed window: the same
      // watchdog must still own it, and its terminal record decides validity.
      // POST_EXECUTION: the same binding is revalidated after the governed
      // window, where an elapsed deadline is the normal terminal condition
      // rather than a stale binding.
      const stillBound = assertDispatchAllowed(id, {
        armedEvidencePath,
        expectedTeamId,
        alive: () => true,
        phase: 'POST_EXECUTION',
      });
      const reconciled = reconcileSupervision({
        runId: id,
        armedEvidencePath,
        expectedTeamId,
        executionIdentity,
      });
      result.supervisionBinding = stillBound;
      result.supervision = reconciled;
      result.supervisionValid = reconciled.supervisionValid;
      result.outcomeClass = reconciled.outcomeClass;
      result.terminationProven = reconciled.terminationProven === true;
      result.governedDispatchProven = true;
      result.authorityRecordPath = authority.authorityRecordPath;
      result.supervisionEvidence = authority.supervisionEvidence;
      if (!reconciled.supervisionValid) {
        result.validOutcome = false;
        result.runStatus = 'STOP_FAILURE';
      } else {
        // SUBMISSION FREEZE. At authoritative termination with proven
        // quiescence, the participant bytes ARE the benchmark result. They are
        // hashed and persisted once here; private evaluation resolves THIS and
        // refuses if the workspace later differs.
        const submission = tree(m.destination);
        const frozen = freezeSubmission({
          runId: id,
          executionIdentity,
          submissionHash: submission.hash,
          fileCount: submission.entries?.length ?? null,
          terminalOutcome: reconciled.terminalOutcome,
          quiescentAt: result.observedStoppedAt ?? result.completedAt ?? null,
        });
        result.frozenSubmission = {
          submissionHash: frozen.submissionHash,
          frozenAt: frozen.frozenAt,
          recordPath: frozen.submissionRecordPath,
        };
      }
    } else {
      result.supervisionValid = null;
      result.outcomeClass = 'GENERIC_NON_BENCHMARK';
      result.validOutcome = false;
    }
    fs.writeFileSync(out, JSON.stringify(result, null, 2), { flag: 'wx' });
    execution = result;
    return result;
  } finally {
    // Truthful terminal handling. A clean supervised completion or deadline
    // halt clears the active marker; a lost/failed supervision lifecycle keeps
    // a durable marker so the run can never look cleanly finalized.
    const supervisionIncomplete =
      execution === undefined ||
      execution.harnessBehavior === 'STOP_FAILURE' ||
      (execution.official === true && execution.supervisionValid !== true);
    if (supervisionIncomplete)
      fs.writeFileSync(
        active,
        JSON.stringify(
          {
            kind: 'SUPERVISION_INCOMPLETE_REQUIRES_OWNER_VERIFICATION',
            runId: id,
            mode,
            executionId: executionIdentity?.executionId ?? null,
            terminalState:
              execution === undefined
                ? 'NO_EXECUTION_RECORD'
                : execution.supervision?.outcomeClass ??
                  execution.harnessBehavior ??
                  'UNKNOWN',
            supervisionProblems: execution?.supervision?.problems ?? null,
            recordedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    else fs.rmSync(active, { force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(
    JSON.stringify(
      await supervise(process.argv[2], process.argv.slice(3)),
      null,
      2,
    ),
  );
