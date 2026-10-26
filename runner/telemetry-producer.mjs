// The official telemetry producer.
//
// The candidate.8 reviewer found that candidate.8's tests manufactured records
// the real producers do not emit, so a genuine successful producer path could
// not satisfy its consumer. There was in fact no producer for official
// telemetry at all: every test hand-wrote it.
//
// This module is that producer. It RESOLVES the authoritative persisted
// execution record and the persisted execution outcome, and emits the
// governance half of schema 1.2 telemetry from them. Callers supply only
// participant measurements (captain, workers, tasks, attempts, GPU,
// orchestration, cloud) — never governance facts. A caller therefore cannot
// state a bound fact at all, so it cannot state one incorrectly.
import {
  executionIdentityClaim,
  resolveExecutionOutcome,
  resolveOfficialExecution,
  terminalOutcomeOf,
  TERMINAL_OUTCOMES,
} from './execution-authority.mjs';

// Map the governed terminal outcome onto the telemetry run status vocabulary
// the ingest contract already uses. One mapping, defined once.
const RUN_STATUS_FOR = {
  [TERMINAL_OUTCOMES.NATURAL_COMPLETION]: 'COMPLETED',
  [TERMINAL_OUTCOMES.DEADLINE_HALT]: 'TIME_LIMIT',
  [TERMINAL_OUTCOMES.DEADLINE_OVERRUN_HALT]: 'TIME_LIMIT_OVERRUN',
};

export function produceOfficialTelemetry(
  runId,
  {
    overrides = {},
    architectureId = 'SYNTHETIC_NOT_A_CALIBRATION',
    sessionPolicy = 'unspecified',
    configuration = {},
    captain,
    workers = [],
    tasks = [],
    attempts = [],
    gpuReservations = [],
    orchestration = {
      captainTakeovers: 0,
      humanInterventions: 0,
      reassignments: 0,
      independentRotations: 0,
      reviewFindings: 0,
      sotaFindings: 0,
    },
    cloud = { costUsd: null, provider: null },
    provenance = {},
  } = {},
) {
  const authority = resolveOfficialExecution(runId, { overrides });
  const identity = authority.executionIdentity;
  const outcome = resolveExecutionOutcome(runId, identity, { overrides });
  const claim = executionIdentityClaim(identity);
  const { outcome: terminal, problem } = terminalOutcomeOf({
    status: outcome.runStatus === 'COMPLETED' ? 'COMPLETED' : outcome.status,
    terminalOutcome: outcome.supervision?.terminalOutcome,
  });
  if (problem)
    throw Error('Cannot produce official telemetry: ' + problem);
  const status = RUN_STATUS_FOR[terminal];
  if (!status)
    throw Error(
      'Cannot produce official telemetry for non-admissible terminal outcome ' + terminal,
    );
  return {
    schemaVersion: '1.2',
    run: {
      // Governance facts, all nine, taken from the governed identity only.
      runId: claim.runId,
      executionId: claim.executionId,
      teamId: claim.teamId,
      candidateVersion: claim.candidateVersion,
      workloadHash: claim.workloadHash,
      timeCeilingMinutes: claim.timeCeilingMinutes,
      startedAt: claim.startedAt,
      deadlineAt: claim.deadlineAt,
      watchdogPid: claim.watchdogPid,
      watchdogNonce: claim.watchdogNonce,
      // Observed execution facts, taken from the persisted outcome only.
      benchmarkVersion: outcome.benchmarkVersion ?? claim.candidateVersion,
      status,
      completedAt: outcome.completedAt ?? null,
      observationEndedAt: outcome.observationEndedAt,
      terminationRequestedAt: outcome.terminationRequestedAt ?? null,
      terminationOutcome: outcome.terminationOutcome ?? null,
      stopResult:
        outcome.terminationOutcome === 'PROCESS_EXIT'
          ? 'COMPLETED'
          : outcome.terminationOutcome,
      architectureId,
      sessionPolicy,
      configuration,
    },
    provenance: {
      source: 'runner/telemetry-producer.mjs from the persisted execution authority',
      exportedAt: new Date().toISOString(),
      sourceHash: null,
      ...provenance,
    },
    captain,
    workers,
    tasks,
    attempts,
    gpuReservations,
    orchestration,
    cloud,
  };
}
