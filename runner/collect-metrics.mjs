import fs from 'node:fs';
import crypto from 'node:crypto';
import Ajv from 'ajv';
import {
  LEGACY_FIXED_CEILING_SECONDS,
  telemetryCeilingSeconds,
} from './ceiling.mjs';
import {
  assertTelemetryMatchesAuthority,
  reconcileSupervision,
  resolveSeedAuthority,
} from './supervision.mjs';
import {
  CURRENT_OFFICIAL_SCHEMAS,

  projectOutcomeEligibility,
} from './execution-identity.mjs';
import {
  assertFullyBoundTo,
  executionIdentityClaim,
  incompleteSupervisionMarker,
  resolveExecutionOutcome,
  resolveOfficialExecution,
  resolveFrozenSubmission,
} from './execution-authority.mjs';
const schema = JSON.parse(
  fs.readFileSync(new URL('./telemetry.schema.json', import.meta.url)),
);
const validate = new Ajv({ allErrors: true }).compile(schema);
const seconds = (a, b) => (Date.parse(b) - Date.parse(a)) / 1000;
const safeRatio = (a, b) => (a === null || b === null || !b ? null : a / b);
const sumKnown = (xs) =>
  xs.some((x) => x === null) ? null : xs.reduce((a, b) => a + b, 0);
function interval(a, b, lo, hi) {
  if (
    new Date(a).toISOString().slice(0, 19) !== a.slice(0, 19) ||
    new Date(b).toISOString().slice(0, 19) !== b.slice(0, 19) ||
    !Number.isFinite(Date.parse(a)) ||
    !Number.isFinite(Date.parse(b)) ||
    seconds(a, b) < 0 ||
    Date.parse(a) < Date.parse(lo) ||
    Date.parse(b) > Date.parse(hi)
  )
    throw Error('Invalid/out-of-run interval');
}
// `official` is the current BenchBoard contract: no seeded authority means no
// valid official outcome. Legacy records may still be READ, but only as
// historical/unbound/descriptive, ineligible for a valid current outcome,
// formal comparison or calibration acceptance.
export function ingest(
  data,
  quality = null,
  hiddenPassed = null,
  manifest = null,
  {
    official = CURRENT_OFFICIAL_SCHEMAS.includes(data?.schemaVersion),
    supervision = null,
    executionRecord = null,
    runsDir,
  } = {},
) {
  // H1: a legacy schema can never be promoted into a current official outcome
  // merely by passing { official: true }.
  if (official && !CURRENT_OFFICIAL_SCHEMAS.includes(data?.schemaVersion))
    throw Error(
      'Schema ' +
        data?.schemaVersion +
        ' is historical/unbound and cannot be treated as a current official outcome',
    );
  if (
    quality !== null &&
    (!Number.isFinite(quality) || quality < 0 || quality > 100)
  )
    throw Error('Invalid quality score');
  if (
    hiddenPassed !== null &&
    (!Number.isInteger(hiddenPassed) || hiddenPassed < 0 || hiddenPassed > 25)
  )
    throw Error('Invalid hidden pass count');
  if (!validate(data)) throw Error(JSON.stringify(validate.errors));
  const recordedRun = data.run;
  const observedEnd = recordedRun.completedAt || recordedRun.observationEndedAt;
  if (!observedEnd)
    throw Error('Run requires actual observed end or observation cutoff');
  const r = { ...recordedRun, completedAt: observedEnd };
  interval(r.startedAt, observedEnd, r.startedAt, observedEnd);
  const wall = seconds(r.startedAt, observedEnd);
  // Execution ceiling is declared per run from schema 1.2; earlier records keep
  // the historical global 75-minute ceiling so their evidence stays truthful.
  // H1: when a seeded run manifest is supplied it is the single authority, and
  // telemetry may not assert a ceiling or deadline the seeded run never declared.
  const authorityProblems = [];
  let seededAuthorityValid = false;
  let governedDispatchProven = false;
  let telemetryBound = false;
  let authority = null;
  let executionIdentity = null;
  let authorityRecord = null;
  let outcomeRecord = null;
  let executionRecordValid = null;
  let marker = null;
  let frozen = null;
  if (official) {
    if (!data?.run?.runId)
      throw Error('Official telemetry must identify its run');
    // H1: resolve the persisted seed from disk; a caller manifest is only a
    // claim that must agree, and the resolved seed is what is used afterwards.
    authority = resolveSeedAuthority(data.run.runId, manifest, {
      runsDir: runsDir ?? manifest?.runsDir,
    });
    seededAuthorityValid = true;
    if (data.run.timeCeilingMinutes === undefined || data.run.timeCeilingMinutes === null)
      throw Error('Official telemetry must declare its bound timeCeilingMinutes');
    // The execution identity must come from the governed execution record and
    // the telemetry must claim exactly it.
    // ROOT (candidate.9): resolve the AUTHORITATIVE PERSISTED execution record
    // from its canonical path. A caller-supplied executionRecord is only ever a
    // CLAIM that must agree; it can never substitute for the resolved record.
    // Candidate.8 accepted the caller object, so manufactured evidence with no
    // governed launch produced a valid official outcome.
    authorityRecord = resolveOfficialExecution(data.run.runId, {
      overrides: { runsDir: runsDir ?? manifest?.runsDir },
    });
    executionIdentity = authorityRecord.executionIdentity;
    if (executionRecord) {
      // Compare the claim, then discard it.
      if (executionRecord.runId !== undefined && executionRecord.runId !== data.run.runId)
        throw Error('Caller execution record claim binds another run');
      if (
        executionRecord.executionIdentity?.executionId !== undefined &&
        executionRecord.executionIdentity.executionId !== executionIdentity.executionId
      )
        throw Error(
          'Caller execution record claim does not match the authoritative persisted execution',
        );
    }
    // All NINE bound facts must be stated by the telemetry and must agree.
    // Candidate.8 compared five, so the workload hash and candidate version
    // could differ and eligibility survived.
    assertFullyBoundTo(
      executionIdentity,
      {
        executionId: data.run.executionId,
        runId: data.run.runId,
        teamId: data.run.teamId,
        candidateVersion: data.run.candidateVersion,
        workloadHash: data.run.workloadHash,
        timeCeilingMinutes: data.run.timeCeilingMinutes,
        startedAt: data.run.startedAt,
        deadlineAt: data.run.deadlineAt,
        watchdogPid: data.run.watchdogPid,
        watchdogNonce: data.run.watchdogNonce,
      },
      'Official telemetry',
    );
    // The workload hash the telemetry binds must be the workload hash on disk.
    if (authority?.publicHash && executionIdentity.boundFacts.workloadHash !== authority.publicHash)
      authorityProblems.push(
        'Bound workload hash does not match the persisted seed public hash',
      );
    telemetryBound = true;
    // The persisted execution OUTCOME decides validity; its own flags are
    // consulted rather than ignored.
    outcomeRecord = resolveExecutionOutcome(data.run.runId, executionIdentity, {
      overrides: { runsDir: runsDir ?? manifest?.runsDir },
    });
    executionRecordValid = outcomeRecord.executionRecordValid;
    if (!executionRecordValid) authorityProblems.push(...outcomeRecord.problems);
    governedDispatchProven =
      authorityRecord.official === true &&
      authorityRecord.governedDispatchProven === true &&
      outcomeRecord.governedDispatchProven === true;
    if (!governedDispatchProven)
      authorityProblems.push('Execution record does not prove a governed dispatch');
    // The durable owner-verification marker is honoured here, not only by the
    // evaluation entry point.
    marker = incompleteSupervisionMarker(data.run.runId, {
      runsDir: runsDir ?? manifest?.runsDir,
    });
    if (marker)
      authorityProblems.push(
        'An incomplete-supervision marker requires owner verification for this execution',
      );
    // The participant result must have been frozen at termination.
    try {
      frozen = resolveFrozenSubmission(data.run.runId, {
        overrides: { runsDir: runsDir ?? manifest?.runsDir },
      });
    } catch (error) {
      frozen = null;
      authorityProblems.push(error.message);
    }
  }
  assertTelemetryMatchesAuthority(data, authority);
  const ceiling = telemetryCeilingSeconds(data);
  const deadline =
    recordedRun.deadlineAt ||
    new Date(Date.parse(r.startedAt) + ceiling * 1000).toISOString();
  if (seconds(r.startedAt, deadline) !== ceiling)
    throw Error(
      'deadlineAt must equal startedAt plus the declared execution ceiling',
    );
  if (
    data.schemaVersion === '1.0' &&
    r.status === 'TIME_LIMIT' &&
    wall !== LEGACY_FIXED_CEILING_SECONDS
  )
    throw Error('Legacy TIME_LIMIT must record its 4500-second cutoff');
  if (
    ['1.1', '1.2'].includes(data.schemaVersion) &&
    (!recordedRun.deadlineAt ||
      !recordedRun.observationEndedAt ||
      !recordedRun.stopResult)
  )
    throw Error(
      'Schema 1.1 requires explicit deadline and observation/stop evidence',
    );
  if (
    recordedRun.stopResult === 'STOP_FAILURE' &&
    recordedRun.completedAt !== null
  )
    throw Error('Unconfirmed stop cannot claim completion');
  if (
    ['1.1', '1.2'].includes(data.schemaVersion) &&
    ['TIME_LIMIT', 'TIME_LIMIT_OVERRUN'].includes(r.status) &&
    wall < ceiling
  )
    throw Error('TIME_LIMIT before ceiling');
  const overrun = Math.max(0, seconds(deadline, observedEnd));
  if (
    data.schemaVersion === '1.2' &&
    r.status === 'TIME_LIMIT_OVERRUN' &&
    overrun <= 0
  )
    throw Error('TIME_LIMIT_OVERRUN requires a recorded overrun');
  // H2: a run requiring supervision is only a valid supervised outcome when the
  // same bound watchdog produced a valid terminal supervision record.
  let supervisionValid = null;
  let terminationProven = null;
  if (official) {
    // Supervision evidence must belong to THIS run and THIS execution identity.
    // Supervision evidence comes from the AUTHORITATIVE record, which carries
    // it by construction. A caller-supplied object is only a fallback for
    // historical records and must still belong to this run.
    const bound = authorityRecord?.supervisionEvidence ?? supervision ?? null;
    if (!bound) {
      supervisionValid = false;
      terminationProven = false;
      authorityProblems.push('No supervision evidence was supplied for an official run');
    } else if (bound.runId !== undefined && bound.runId !== data.run.runId) {
      supervisionValid = false;
      terminationProven = false;
      authorityProblems.push('Supervision evidence belongs to another run');
    } else {
      const reconciled = reconcileSupervision({
        ...bound,
        runId: data.run.runId,
        expectedTeamId: bound.expectedTeamId ?? executionIdentity.boundFacts.teamId,
        executionIdentity,
        overrides: { runsDir: runsDir ?? manifest?.runsDir },
      });
      supervisionValid = reconciled.supervisionValid;
      terminationProven = reconciled.terminationProven === true;
      if (!reconciled.supervisionValid) authorityProblems.push(...reconciled.problems);
    }
  }
  const executionSane =
    !['STOP_FAILURE', 'INFRASTRUCTURE_FAILURE'].includes(recordedRun.status) &&
    recordedRun.stopResult !== 'STOP_FAILURE' &&
    (!['1.1', '1.2'].includes(data.schemaVersion) ||
      (recordedRun.completedAt !== null &&
        ['STOPPED', 'COMPLETED'].includes(recordedRun.stopResult))) &&
    (['TIME_LIMIT', 'TIME_LIMIT_OVERRUN'].includes(r.status) || wall <= ceiling);
  if (official && !executionSane)
    authorityProblems.push('Execution record is not a sane completed outcome');
  // H2: ONE authoritative eligibility projection. Nothing downstream may turn
  // an individual flag back on.
  const eligibility = projectOutcomeEligibility({
    schemaVersion: data.schemaVersion,
    executionAuthorityResolved: official ? authorityRecord !== null : false,
    executionRecordValid: official ? executionRecordValid === true : false,
    seededAuthorityValid: official ? seededAuthorityValid : false,
    governedDispatchProven: official ? governedDispatchProven : false,
    supervisionValid: official ? supervisionValid === true : false,
    terminationProven: official ? terminationProven === true && executionSane : false,
    telemetryBound: official ? telemetryBound : false,
    incompleteSupervision: official ? marker !== null : false,
    submissionFrozen: official ? frozen !== null : true,
    submissionMatchesFrozen: true,
    outcomeClass: official ? 'OFFICIAL_SUPERVISED' : 'HISTORICAL_UNBOUND_DESCRIPTIVE',
  });
  const outcomeClass = eligibility.outcomeClass;
  const validOutcome = eligibility.validOutcome;
  if (
    manifest &&
    (r.runId !== manifest.runId ||
      r.benchmarkVersion !== manifest.benchmarkVersion)
  )
    throw Error('Telemetry run identity mismatch');
  const tasks = new Map(data.tasks.map((t) => [t.taskId, t]));
  if (tasks.size !== data.tasks.length) throw Error('Duplicate task ID');
  const visited = new Set(),
    active = new Set();
  function visit(id) {
    if (!tasks.has(id)) throw Error('Unknown dependency');
    if (active.has(id)) throw Error('Dependency cycle');
    if (visited.has(id)) return;
    active.add(id);
    for (const dep of tasks.get(id).dependencies) visit(dep);
    active.delete(id);
    visited.add(id);
  }
  for (const id of tasks.keys()) visit(id);
  const members = new Map(data.workers.map((w) => [w.logicalMember, w]));
  if (members.size !== data.workers.length) throw Error('Duplicate member');
  const attemptIds = new Set();
  for (const a of data.attempts) {
    if (attemptIds.has(a.attemptId)) throw Error('Duplicate attempt');
    attemptIds.add(a.attemptId);
    if (!tasks.has(a.taskId) || !members.has(a.logicalMember))
      throw Error('Unknown attempt task/member');
    interval(a.startedAt, a.completedAt, r.startedAt, r.completedAt);
    const w = members.get(a.logicalMember);
    interval(
      a.startedAt,
      a.completedAt,
      w.availableStartedAt,
      w.availableCompletedAt,
    );
    for (const time of [a.firstMeaningfulArtifactAt, a.firstPassingTestAt])
      if (time !== null) interval(time, time, a.startedAt, a.completedAt);
    if (
      a.focusedTestsPassed !== null &&
      a.focusedTestsTotal !== null &&
      a.focusedTestsPassed > a.focusedTestsTotal
    )
      throw Error('Invalid tests count');
  }
  const utilization = [];
  const sweep = [];
  let available = 0,
    busy = 0,
    blocked = 0,
    scheduler = 0,
    idle = 0;
  let known = true;
  for (const w of data.workers) {
    interval(
      w.availableStartedAt,
      w.availableCompletedAt,
      r.startedAt,
      r.completedAt,
    );
    const availableSeconds = seconds(
      w.availableStartedAt,
      w.availableCompletedAt,
    );
    available += availableSeconds;
    if (w.intervals === null) {
      known = false;
      utilization.push({
        logicalMember: w.logicalMember,
        availableSeconds,
        busySeconds: null,
        utilization: null,
      });
      continue;
    }
    const sorted = [...w.intervals].sort(
      (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
    );
    let previous = Date.parse(w.availableStartedAt),
      wb = 0,
      wt = 0;
    for (const i of sorted) {
      interval(
        i.startedAt,
        i.completedAt,
        w.availableStartedAt,
        w.availableCompletedAt,
      );
      if (Date.parse(i.startedAt) < previous)
        throw Error('Overlapping member intervals');
      previous = Date.parse(i.completedAt);
      const duration = seconds(i.startedAt, i.completedAt);
      wt += duration;
      if (i.kind === 'busy') {
        wb += duration;
        busy += duration;
        if (duration > 0)
          sweep.push(
            [Date.parse(i.startedAt), 1],
            [Date.parse(i.completedAt), -1],
          );
      }
      if (i.kind === 'dependencyBlocked') blocked += duration;
      if (i.kind === 'schedulerIdle') scheduler += duration;
      if (i.kind === 'unexplainedIdle') idle += duration;
    }
    const uncovered = availableSeconds - wt;
    idle += uncovered;
    utilization.push({
      logicalMember: w.logicalMember,
      availableSeconds,
      busySeconds: wb,
      unexplainedIdleSeconds:
        uncovered +
        sorted
          .filter((i) => i.kind === 'unexplainedIdle')
          .reduce((n, i) => n + seconds(i.startedAt, i.completedAt), 0),
      utilization: safeRatio(wb, availableSeconds),
    });
  }
  let peak = 0,
    current = 0;
  for (const [, delta] of sweep.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    current += delta;
    peak = Math.max(peak, current);
  }
  let gpuHours = null,
    cloudGpuHours = null;
  if (data.gpuReservations !== null) {
    gpuHours = 0;
    if (data.gpuReservations.some((g) => g.location === 'cloud'))
      cloudGpuHours = 0;
    const last = new Map();
    for (const g of [...data.gpuReservations].sort(
      (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
    )) {
      if (data.schemaVersion === '1.1' && !g.location)
        throw Error('GPU reservation location required in schema 1.1');
      const gpuKey = (g.location || 'local') + ':' + g.gpuId;
      interval(g.startedAt, g.completedAt, r.startedAt, r.completedAt);
      if (Date.parse(g.startedAt) < (last.get(gpuKey) ?? -Infinity))
        throw Error('Overlapping GPU reservations');
      last.set(gpuKey, Date.parse(g.completedAt));
      if (g.location === 'cloud')
        cloudGpuHours += seconds(g.startedAt, g.completedAt) / 3600;
      else gpuHours += seconds(g.startedAt, g.completedAt) / 3600;
    }
  }
  const completed = new Set(
    data.attempts.filter((a) => a.status === 'COMPLETED').map((a) => a.taskId),
  ).size;
  const counts = new Map();
  for (const a of data.attempts)
    counts.set(a.taskId, (counts.get(a.taskId) || 0) + 1);
  const retries = [...counts.values()].reduce(
    (n, v) => n + Math.max(0, v - 1),
    0,
  );
  const actors = [data.captain, ...data.attempts];
  const totals = Object.fromEntries(
    Object.keys(data.captain.tokens).map((k) => [
      k,
      sumKnown(actors.map((a) => a.tokens[k])),
    ]),
  );
  // inputTokens includes cache reads; do not double-count cache-read tokens in total.
  const tokensByLocation = Object.fromEntries(
    ['local', 'cloud'].map((location) => [
      location,
      Object.fromEntries(
        Object.keys(data.captain.tokens).map((k) => [
          k,
          sumKnown(
            actors
              .filter((a) => a.location === location)
              .map((a) => a.tokens[k]),
          ),
        ]),
      ),
    ]),
  );
  const totalTokens = sumKnown([totals.inputTokens, totals.outputTokens]);
  for (const actor of actors)
    if (
      actor.tokens.cacheReadTokens !== null &&
      actor.tokens.inputTokens !== null &&
      actor.tokens.cacheReadTokens > actor.tokens.inputTokens
    )
      throw Error('Cache-read tokens exceed input tokens');
  const uncachedInputTokens = sumKnown(
    actors.map((a) =>
      a.tokens.inputTokens === null || a.tokens.cacheReadTokens === null
        ? null
        : a.tokens.inputTokens - a.tokens.cacheReadTokens,
    ),
  );
  const freshTokens = sumKnown([uncachedInputTokens, totals.outputTokens]);
  const freshTokensByLocation = Object.fromEntries(
    ['local', 'cloud'].map((location) => {
      const selected = actors.filter((a) => a.location === location);
      return [
        location,
        sumKnown(
          selected.map((a) =>
            a.tokens.inputTokens === null ||
            a.tokens.cacheReadTokens === null ||
            a.tokens.outputTokens === null
              ? null
              : a.tokens.inputTokens -
                a.tokens.cacheReadTokens +
                a.tokens.outputTokens,
          ),
        ),
      ];
    }),
  );
  const locations = new Set(actors.map((a) => a.location));
  const executionMix =
    locations.size === 2
      ? 'HYBRID'
      : locations.has('cloud')
        ? 'CLOUD'
        : 'LOCAL';
  const lastSuccess = new Map();
  for (const a of data.attempts.filter((a) => a.status === 'COMPLETED'))
    if (
      !lastSuccess.has(a.taskId) ||
      Date.parse(a.completedAt) >
        Date.parse(lastSuccess.get(a.taskId).completedAt)
    )
      lastSuccess.set(a.taskId, a);
  const completedTasksByLocation = Object.fromEntries(
    ['local', 'cloud'].map((l) => [
      l,
      [...lastSuccess.values()].filter((a) => a.location === l).length,
    ]),
  );
  const qualityGpuDenominator = executionMix === 'LOCAL' ? gpuHours : null;

  const sessions = new Set(
    data.attempts.map((a) => a.sessionId).filter((x) => x !== null),
  );
  return {
    schemaVersion: '1.2',
    run: recordedRun,
    observedEndAt: observedEnd,
    deadlineAt: deadline,
    timeCeilingMinutes: ceiling / 60,
    timeCeilingSeconds: ceiling,
    official,
    outcomeClass,
    supervisionValid,
    terminationProven,
    executionId: executionIdentity?.executionId ?? null,
    // Derived from the single projection; never independently assignable.
    eligibleForFormalComparison: eligibility.eligibleForFormalComparison,
    eligibleForCalibrationAcceptance: eligibility.eligibleForCalibrationAcceptance,
    officialOutcomeValid: eligibility.officialOutcomeValid,
    ineligibilityReasons: [...eligibility.ineligibilityReasons, ...authorityProblems],
    authorityProblems,
    deadlineOverrunSeconds: overrun,
    officialWindowSeconds: Math.min(wall, ceiling),
    actualWallSeconds: wall,
    stopConfirmed: ['1.1', '1.2'].includes(data.schemaVersion)
      ? recordedRun.completedAt !== null &&
        ['STOPPED', 'COMPLETED'].includes(recordedRun.stopResult)
      : null,
    validOutcome,
    timingEvidence:
      ['1.1', '1.2'].includes(data.schemaVersion)
        ? 'EXPLICIT_OBSERVATION'
        : 'LEGACY_REPORTED_END_NOT_STOP_PROOF',
    provenance: data.provenance,
    rawTelemetrySha256: crypto
      .createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex'),
    captain: data.captain,
    workers: data.workers,
    tasks: data.tasks,
    attempts: data.attempts,
    cloud: data.cloud,
    quality,
    hiddenPassed,
    wallSeconds: wall,
    taskCount: tasks.size,
    attemptCount: data.attempts.length,
    completedTasks: completed,
    retries,
    failedAttempts: data.attempts.filter((a) => a.status === 'FAILED').length,
    workerSessions: data.attempts.some((a) => a.sessionId === null)
      ? null
      : sessions.size,
    peakParallelism: known ? peak : null,
    orchestration: data.orchestration,
    tokens: totals,
    tokensByLocation,
    totalTokens,
    gpuHours,
    localGpuHours: gpuHours,
    cloudGpuHours,
    executionMix,
    completedTasksByLocation,
    uncachedInputTokens,
    freshTokens,
    freshTokensByLocation,
    utilization,
    workerAvailableSeconds: available,
    workerBusySeconds: known ? busy : null,
    dependencyBlockedSeconds: known ? blocked : null,
    schedulerIdleSeconds: known ? scheduler : null,
    unexplainedIdleSeconds: known ? idle : null,
    workerUtilization: known ? safeRatio(busy, available) : null,
    efficiency: {
      completedLocalTasksPerLocalGPUHour: safeRatio(
        completedTasksByLocation.local,
        gpuHours,
      ),
      qualityPointsPerLocalGPUHour: safeRatio(quality, qualityGpuDenominator),
      freshTokensPerCompletedTask: safeRatio(freshTokens, completed),
      qualityPointsPerMillionFreshTokens: safeRatio(
        quality,
        freshTokens === null ? null : freshTokens / 1e6,
      ),
      tokensPerCompletedTask: safeRatio(totalTokens, completed),
      minutesPerCompletedTask: safeRatio(wall / 60, completed),
      qualityPointsPerMillionTokens: safeRatio(
        quality,
        totalTokens === null ? null : totalTokens / 1e6,
      ),
      completedTasksPerGPUHour: safeRatio(completed, qualityGpuDenominator),
      hiddenTestsPerGPUHour: safeRatio(hiddenPassed, qualityGpuDenominator),
      qualityPointsPerGPUHour: safeRatio(quality, qualityGpuDenominator),
    },
  };
}
if (process.argv[2]) {
  const input = JSON.parse(fs.readFileSync(process.argv[2]));
  const result = ingest(input);
  fs.writeFileSync(
    process.argv[3] || 'metrics.json',
    JSON.stringify({ metrics: result, raw: input }, null, 2),
  );
  console.log('Telemetry ingested');
}
