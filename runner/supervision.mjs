// One authoritative supervision chain.
//
// The seeded run manifest is the single immutable authority for a run's
// execution ceiling. Watchdog timing binds to it, telemetry claims are
// verified against it, benchmark dispatch is gated on a live watchdog bound to
// it, quiescence is only ever established from positively known activity, and
// evidence accumulated along the chain never becomes weaker.
import fs from 'node:fs';
import path from 'node:path';
import { root } from './files.mjs';
import { ceilingMinutes, ceilingSeconds, CEILING_POLICY } from './ceiling.mjs';
import { OFFICIAL_OUTCOME_CLASSES, validateIdentitySet } from './execution-identity.mjs';
import {
  ADMISSIBLE_TERMINAL_OUTCOMES,
  TERMINAL_OUTCOMES,
  assertFullyBoundTo,
  incompleteSupervisionMarker,
  terminalOutcomeOf,
  verifyExecutionIdentity,
} from './execution-authority.mjs';
export const WATCHDOG_HEARTBEAT_STALE_MS = 120_000;
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

export const DEFAULT_NETWORK_TIMEOUT_MS = 10_000;

export class SupervisionError extends Error {
  constructor(message, kind = 'SUPERVISOR_FAILURE') {
    super(message);
    this.name = 'SupervisionError';
    this.supervisionKind = kind;
  }
}

// ---------------------------------------------------------------------------
// Seeded authority (H1)
// ---------------------------------------------------------------------------
export function runsDirectory(overrides = {}) {
  return overrides.runsDir || path.join(root, 'artifacts/runs');
}
// The ONLY place an execution ceiling may originate for a real run.
export function seededAuthority(runId, overrides = {}) {
  if (typeof runId !== 'string' || !runId)
    throw new SupervisionError('runId required to resolve seeded authority');
  const file = path.join(runsDirectory(overrides), runId + '.json');
  if (!fs.existsSync(file))
    throw new SupervisionError(
      'No seeded run manifest for ' + runId + '; the ceiling has no authority',
    );
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.runId !== runId)
    throw new SupervisionError('Seeded manifest run identity mismatch');
  if (manifest.timeCeilingMinutes === undefined)
    throw new SupervisionError(
      'Seeded run manifest must declare timeCeilingMinutes before execution',
    );
  const minutes = ceilingMinutes(manifest.timeCeilingMinutes);
  const seconds = ceilingSeconds(minutes);
  if (
    manifest.timeCeilingSeconds !== undefined &&
    manifest.timeCeilingSeconds !== seconds
  )
    throw new SupervisionError(
      'Derived timeCeilingSeconds disagrees with the seeded timeCeilingMinutes',
    );
  return {
    runId,
    manifestPath: file,
    timeCeilingMinutes: minutes,
    timeCeilingSeconds: seconds,
    ceilingPolicy: manifest.ceilingPolicy || CEILING_POLICY,
    benchmarkVersion: manifest.benchmarkVersion ?? null,
    publicHash: manifest.publicHash ?? null,
  };
}
// Timing derives from the authority. A caller-supplied ceiling or deadline is
// only ever a CLAIM that must agree; it never becomes authoritative.
export function bindSupervisionTiming({
  authority,
  startedAtEpochMs,
  claimedCeilingSeconds,
  claimedDeadlineEpochMs,
}) {
  if (!authority?.timeCeilingSeconds)
    throw new SupervisionError('Seeded authority required to bind timing');
  if (!Number.isFinite(startedAtEpochMs))
    throw new SupervisionError('startedAtEpochMs must be finite');
  const deadlineEpochMs =
    startedAtEpochMs + authority.timeCeilingSeconds * 1000;
  if (
    claimedCeilingSeconds !== undefined &&
    claimedCeilingSeconds !== null &&
    Number(claimedCeilingSeconds) !== authority.timeCeilingSeconds
  )
    throw new SupervisionError(
      'Claimed ceiling ' +
        claimedCeilingSeconds +
        's conflicts with the seeded authority ' +
        authority.timeCeilingSeconds +
        's',
    );
  if (
    claimedDeadlineEpochMs !== undefined &&
    claimedDeadlineEpochMs !== null &&
    Number(claimedDeadlineEpochMs) !== deadlineEpochMs
  )
    throw new SupervisionError(
      'Claimed deadline conflicts with the seeded authority deadline',
    );
  return {
    runId: authority.runId,
    timeCeilingMinutes: authority.timeCeilingMinutes,
    timeCeilingSeconds: authority.timeCeilingSeconds,
    startedAtEpochMs,
    startedAt: new Date(startedAtEpochMs).toISOString(),
    deadlineEpochMs,
    deadlineAt: new Date(deadlineEpochMs).toISOString(),
    authorityPath: authority.manifestPath,
  };
}
// Telemetry must not be able to assert a ceiling the seeded run never declared.
// H1: the persisted seed on disk is authoritative. A caller-supplied manifest
// is only ever a CLAIM: it is compared against the resolved seed and then
// discarded. The resolved seed is what every later check uses.
export function resolveSeedAuthority(runId, callerClaim = null, overrides = {}) {
  const resolved = seededAuthority(runId, overrides);
  if (callerClaim) {
    if (callerClaim.runId !== undefined && callerClaim.runId !== runId)
      throw new SupervisionError(
        'Caller manifest claims run ' + callerClaim.runId + ' but authority is ' + runId,
      );
    if (
      callerClaim.timeCeilingMinutes !== undefined &&
      callerClaim.timeCeilingMinutes !== resolved.timeCeilingMinutes
    )
      throw new SupervisionError(
        'Caller manifest claims ' +
          callerClaim.timeCeilingMinutes +
          ' minutes but the persisted seed is ' +
          resolved.timeCeilingMinutes +
          ' minutes; the persisted seed is authoritative',
      );
    if (
      callerClaim.timeCeilingSeconds !== undefined &&
      callerClaim.timeCeilingSeconds !== resolved.timeCeilingSeconds
    )
      throw new SupervisionError(
        'Caller manifest derived seconds disagree with the persisted seed',
      );
    if (
      callerClaim.benchmarkVersion !== undefined &&
      resolved.benchmarkVersion !== null &&
      callerClaim.benchmarkVersion !== resolved.benchmarkVersion
    )
      throw new SupervisionError(
        'Caller manifest claims a different benchmark candidate than the persisted seed',
      );
  }
  return resolved;
}
export function assertTelemetryMatchesAuthority(data, authority) {
  if (!authority) return null;
  const declared = authority.timeCeilingMinutes;
  if (declared === undefined) return null;
  const minutes = ceilingMinutes(declared);
  const claimed = data?.run?.timeCeilingMinutes;
  if (claimed !== undefined && claimed !== null && claimed !== minutes)
    throw new SupervisionError(
      'Telemetry ceiling ' +
        claimed +
        ' minutes conflicts with the seeded run manifest ' +
        minutes +
        ' minutes',
    );
  const startedAt = Date.parse(data?.run?.startedAt);
  const deadlineAt = Date.parse(data?.run?.deadlineAt);
  if (Number.isFinite(startedAt) && Number.isFinite(deadlineAt)) {
    const expected = startedAt + ceilingSeconds(minutes) * 1000;
    if (deadlineAt !== expected)
      throw new SupervisionError(
        'Telemetry deadlineAt does not equal startedAt plus the seeded ceiling',
      );
  }
  return minutes;
}

// ---------------------------------------------------------------------------
// Monotonic evidence ledger (M1)
// ---------------------------------------------------------------------------
// Once a lifecycle fact is observed it can never be erased or nulled by later
// failure handling. Re-recording the same value is allowed; changing or
// clearing an observed value is not.
export class SupervisionLedger {
  constructor(seed = {}) {
    this.facts = {};
    this.events = [];
    for (const [k, v] of Object.entries(seed)) this.record(k, v);
  }
  record(key, value) {
    if (value === undefined || value === null) return this.facts[key];
    const existing = this.facts[key];
    if (
      existing !== undefined &&
      existing !== null &&
      JSON.stringify(existing) !== JSON.stringify(value)
    )
      throw new SupervisionError(
        'Monotonic supervision fact ' + key + ' cannot be rewritten',
      );
    this.facts[key] = value;
    return value;
  }
  note(type, atEpochMs, detail) {
    this.events.push({
      type,
      atEpochMs,
      at: new Date(atEpochMs).toISOString(),
      ...(detail === undefined ? {} : { detail }),
    });
    return this.events.at(-1);
  }
  has(key) {
    return this.facts[key] !== undefined && this.facts[key] !== null;
  }
  snapshot() {
    return { ...this.facts };
  }
}

// ---------------------------------------------------------------------------
// Activity classification (H3) — UNKNOWN is not IDLE, MISSING is not IDLE
// ---------------------------------------------------------------------------
export const ACTIVITY = {
  IDLE: 'IDLE',
  WORKING: 'WORKING',
  UNKNOWN: 'UNKNOWN',
  MISSING: 'MISSING',
};
const WORKING_VALUES = new Set(['working', 'running', 'busy', 'stopping']);
const IDLE_VALUES = new Set(['idle', 'stopped', 'completed', 'done', 'halted']);
// A surface is IDLE only when it positively says so.
export function classifyActivity(value) {
  if (value === undefined || value === null) return ACTIVITY.MISSING;
  if (value === true) return ACTIVITY.WORKING;
  if (value === false) return ACTIVITY.IDLE;
  if (typeof value !== 'string') return ACTIVITY.UNKNOWN;
  const v = value.trim().toLowerCase();
  if (!v) return ACTIVITY.MISSING;
  if (WORKING_VALUES.has(v)) return ACTIVITY.WORKING;
  if (IDLE_VALUES.has(v)) return ACTIVITY.IDLE;
  return ACTIVITY.UNKNOWN;
}
// A member is one surface. It is IDLE only when at least one signal positively
// says idle and no signal says working or is unrecognised. A member exposing no
// signal at all is MISSING, and an unrecognised signal makes it UNKNOWN; neither
// establishes idle.
export function classifyMember(member) {
  if (member === undefined || member === null) return ACTIVITY.MISSING;
  const signals = [member.status, member.activity];
  if (member.stopping === true) return ACTIVITY.WORKING;
  if (member.rotationState) return ACTIVITY.WORKING;
  const present = signals.filter((v) => v !== undefined && v !== null && v !== '');
  if (!present.length) return ACTIVITY.MISSING;
  const states = present.map(classifyActivity);
  if (states.includes(ACTIVITY.WORKING)) return ACTIVITY.WORKING;
  if (states.includes(ACTIVITY.UNKNOWN)) return ACTIVITY.UNKNOWN;
  return states.includes(ACTIVITY.IDLE) ? ACTIVITY.IDLE : ACTIVITY.UNKNOWN;
}
// Every authoritative surface must be positively known IDLE.
export function confirmQuiescence(surfaces) {
  const entries = Object.entries(surfaces);
  if (!entries.length)
    return {
      quiescent: false,
      reasons: ['No execution surface was observed'],
      surfaces: {},
    };
  const classified = {};
  const reasons = [];
  for (const [name, value] of entries) {
    const state = classifyActivity(value);
    classified[name] = state;
    if (state !== ACTIVITY.IDLE)
      reasons.push(name + ' is ' + state + ', which does not establish idle');
  }
  return { quiescent: reasons.length === 0, reasons, surfaces: classified };
}

// H3: quiescence is a coverage proof over the authoritative expected execution
// identity set, not a per-row "nothing says working" scan.
export function expectedExecutionIdentities(durable, config = {}) {
  // Identity comes from validated authoritative data only.
  const members = validateIdentitySet(durable?.members, { label: 'durable member' });
  const tasks = validateIdentitySet(durable?.tasks, {
    label: 'durable task',
    key: 'id',
    fallbacks: [],
  });
  return {
    captain: config.captainSessionId ?? durable?.captainSessionId ?? null,
    members: members.valid ? members.ids : null,
    tasks: tasks.valid ? tasks.ids : null,
  };
}
const TERMINAL_TASK = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_TASK = new Set(['pending', 'claimed', 'in_progress', 'running']);
export function classifyTask(task) {
  if (task === undefined || task === null) return ACTIVITY.MISSING;
  const status = task.status;
  if (status === undefined || status === null || status === '')
    return ACTIVITY.MISSING;
  if (typeof status !== 'string') return ACTIVITY.UNKNOWN;
  const v = status.trim().toLowerCase();
  if (TERMINAL_TASK.has(v)) return ACTIVITY.IDLE;
  if (ACTIVE_TASK.has(v)) return ACTIVITY.WORKING;
  return ACTIVITY.UNKNOWN;
}
export function proveQuiescence({ expected, durable, runtime, captainStopped }) {
  const reasons = [];
  const coverage = { members: {}, tasks: {} };
  // H3: identity is authoritative data. Missing, empty, duplicate or
  // conflicting identities fail closed BEFORE any coverage map is built, and
  // positional identities are never synthesized for an official proof.
  const sets = {
    'durable member': validateIdentitySet(durable?.members, { label: 'durable member' }),
    'runtime member': validateIdentitySet(runtime?.members, { label: 'runtime member' }),
    'durable task': validateIdentitySet(durable?.tasks, { label: 'durable task', key: 'id', fallbacks: [] }),
    'runtime task': validateIdentitySet(runtime?.tasks, { label: 'runtime task', key: 'id', fallbacks: [] }),
  };
  for (const [, set] of Object.entries(sets))
    if (!set.valid) reasons.push(...set.problems);
  if (reasons.length)
    return { quiescent: false, reasons, coverage, expected, identitySets: sets };
  if (expected.members === null)
    reasons.push('Durable member identity set is unavailable');
  if (expected.tasks === null)
    reasons.push('Durable task identity set is unavailable');
  const runtimeMembers = Array.isArray(runtime?.members) ? runtime.members : null;
  const runtimeTasks = Array.isArray(runtime?.tasks) ? runtime.tasks : null;
  if (runtimeMembers === null)
    reasons.push('Runtime member observation is unavailable');
  if (runtimeTasks === null)
    reasons.push('Runtime task observation is unavailable');
  // Built only from validated identity sets; no positional synthesis.
  const runtimeById = sets['runtime member'].byId ?? new Map();
  const durableById = sets['durable member'].byId ?? new Map();
  for (const id of expected.members ?? []) {
    const d = classifyMember(durableById.get(id));
    const observed = runtimeById.get(id);
    const r = observed === undefined ? ACTIVITY.MISSING : classifyMember(observed);
    coverage.members[id] = { durable: d, runtime: r };
    if (r === ACTIVITY.MISSING)
      reasons.push('Expected member ' + id + ' has no matching runtime observation');
    else if (r !== ACTIVITY.IDLE)
      reasons.push('Member ' + id + ' runtime activity is ' + r);
    if (d !== ACTIVITY.IDLE)
      reasons.push('Member ' + id + ' durable activity is ' + d);
  }
  for (const id of runtimeById.keys())
    if (expected.members !== null && !expected.members.includes(id)) {
      coverage.members[id] = {
        durable: ACTIVITY.MISSING,
        runtime: classifyMember(runtimeById.get(id)),
      };
      reasons.push(
        'Unexplained runtime member ' + id + ' is not in the expected identity set',
      );
    }
  const runtimeTaskById = sets['runtime task'].byId ?? new Map();
  const durableTaskById = sets['durable task'].byId ?? new Map();
  for (const id of expected.tasks ?? []) {
    const d = classifyTask(durableTaskById.get(id));
    const observed = runtimeTaskById.get(id);
    const r = observed === undefined ? ACTIVITY.MISSING : classifyTask(observed);
    coverage.tasks[id] = { durable: d, runtime: r };
    if (d !== ACTIVITY.IDLE) reasons.push('Task ' + id + ' durable status is ' + d);
    if (r === ACTIVITY.MISSING)
      reasons.push('Expected task ' + id + ' has no matching runtime observation');
    else if (r !== ACTIVITY.IDLE)
      reasons.push('Task ' + id + ' runtime status is ' + r);
  }
  for (const id of runtimeTaskById.keys())
    if (expected.tasks !== null && !expected.tasks.includes(id)) {
      coverage.tasks[id] = {
        durable: ACTIVITY.MISSING,
        runtime: classifyTask(runtimeTaskById.get(id)),
      };
      reasons.push(
        'Unexplained runtime task ' + id + ' is not in the expected identity set',
      );
    }
  if (expected.captain === null) reasons.push('Captain identity is unavailable');
  if (captainStopped !== true) reasons.push('Captain is not positively stopped');
  return { quiescent: reasons.length === 0, reasons, coverage, expected };
}

// ---------------------------------------------------------------------------
// Supervision lifecycle reconciliation (H2 continuous supervision)
// ---------------------------------------------------------------------------
export const TERMINAL_SUPERVISION_STATUSES = [
  'COMPLETED',
  'TIME_LIMIT',
  'TIME_LIMIT_OVERRUN',
];
// Terminal timestamp fields, in the only order a real execution can produce
// them. Candidate.8 accepted observedStoppedAt = "not-a-date", a stop before
// the execution started, and COMPLETED paired with STOP_FAILURE.
export const TERMINAL_TIMESTAMP_FIELDS = [
  'startedAt',
  'deadlineAt',
  'triggeredAt',
  'terminationRequestedAt',
  'haltAcceptedAt',
  'naturalCompletionAt',
  'observedStoppedAt',
  'completionObservedAt',
];
// Which terminal outcomes may carry which claims. Anything outside this table
// is a contradiction, not a tolerated combination.
export const TERMINAL_OUTCOME_CONTRACT = {
  [TERMINAL_OUTCOMES.NATURAL_COMPLETION]: {
    requires: ['naturalCompletionAt', 'completionObservedAt'],
    forbids: ['triggeredAt', 'terminationRequestedAt'],
    haltRequested: false,
  },
  [TERMINAL_OUTCOMES.DEADLINE_HALT]: {
    requires: ['triggeredAt', 'terminationRequestedAt', 'observedStoppedAt'],
    forbids: ['naturalCompletionAt'],
    haltRequested: true,
  },
  [TERMINAL_OUTCOMES.DEADLINE_OVERRUN_HALT]: {
    requires: ['triggeredAt', 'terminationRequestedAt', 'observedStoppedAt'],
    forbids: ['naturalCompletionAt'],
    haltRequested: true,
  },
};
// Parse and validate. Malformed dates, impossible ordering and contradictory
// status/outcome combinations are all rejected.
export function validateTerminalChronology(terminal, { startedAt, deadlineAt } = {}) {
  const problems = [];
  const at = {};
  for (const field of TERMINAL_TIMESTAMP_FIELDS) {
    const raw = terminal?.[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string' || !raw.trim()) {
      problems.push('Terminal ' + field + ' is not a timestamp string');
      continue;
    }
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) {
      problems.push('Terminal ' + field + ' is not a parseable timestamp: ' + raw);
      continue;
    }
    at[field] = t;
  }
  const { outcome, problem } = terminalOutcomeOf(terminal);
  if (problem) problems.push(problem);
  const started = at.startedAt ?? (startedAt ? Date.parse(startedAt) : NaN);
  const deadline = at.deadlineAt ?? (deadlineAt ? Date.parse(deadlineAt) : NaN);
  if (!Number.isFinite(started))
    problems.push('Terminal record has no parseable startedAt');
  if (!Number.isFinite(deadline))
    problems.push('Terminal record has no parseable deadlineAt');
  if (Number.isFinite(started) && Number.isFinite(deadline) && deadline <= started)
    problems.push('Terminal deadlineAt is not after startedAt');
  // Nothing observed may precede the bound start.
  if (Number.isFinite(started))
    for (const field of TERMINAL_TIMESTAMP_FIELDS) {
      if (field === 'startedAt' || at[field] === undefined) continue;
      if (at[field] < started)
        problems.push('Terminal ' + field + ' precedes the execution start');
    }
  // Halt ordering: trigger -> request -> accepted -> observed stop.
  const chain = ['triggeredAt', 'terminationRequestedAt', 'haltAcceptedAt', 'observedStoppedAt'];
  const present = chain.filter((f) => at[f] !== undefined);
  for (let i = 1; i < present.length; i += 1)
    if (at[present[i]] < at[present[i - 1]])
      problems.push(
        'Terminal ' + present[i] + ' precedes ' + present[i - 1] + '; impossible ordering',
      );
  // A completion cannot be observed before it happened.
  if (at.naturalCompletionAt !== undefined && at.completionObservedAt !== undefined)
    if (at.completionObservedAt < at.naturalCompletionAt)
      problems.push('Completion was observed before it occurred; impossible ordering');
  const contract = outcome ? TERMINAL_OUTCOME_CONTRACT[outcome] : null;
  if (outcome && !contract)
    problems.push('Terminal outcome ' + outcome + ' is not an admissible official outcome');
  if (contract) {
    for (const field of contract.requires)
      if (at[field] === undefined)
        problems.push('Terminal outcome ' + outcome + ' requires ' + field);
    for (const field of contract.forbids)
      if (at[field] !== undefined)
        problems.push('Terminal outcome ' + outcome + ' must not carry ' + field);
    if (
      terminal?.haltRequested !== undefined &&
      terminal.haltRequested !== contract.haltRequested
    )
      problems.push(
        'Terminal outcome ' +
          outcome +
          ' contradicts haltRequested=' +
          terminal.haltRequested,
      );
    if (
      outcome === TERMINAL_OUTCOMES.DEADLINE_HALT &&
      Number.isFinite(deadline) &&
      at.triggeredAt !== undefined &&
      at.triggeredAt < deadline
    )
      problems.push('A deadline halt cannot be triggered before the deadline');
    if (
      outcome === TERMINAL_OUTCOMES.NATURAL_COMPLETION &&
      Number.isFinite(deadline) &&
      at.naturalCompletionAt !== undefined &&
      at.naturalCompletionAt > deadline
    )
      problems.push('A natural completion cannot occur after the deadline');
  }
  // The legacy status/terminationOutcome pair must not contradict the outcome.
  if (
    outcome === TERMINAL_OUTCOMES.NATURAL_COMPLETION &&
    terminal?.terminationOutcome !== undefined &&
    !['COMPLETED', TERMINAL_OUTCOMES.NATURAL_COMPLETION].includes(terminal.terminationOutcome)
  )
    problems.push(
      'Natural completion contradicts terminationOutcome ' + terminal.terminationOutcome,
    );
  return { valid: problems.length === 0, outcome, at, problems };
}
// A valid supervised outcome requires that the SAME bound watchdog produced a
// valid terminal supervision record. A watchdog that vanished leaves the run
// supervision-invalid rather than silently valid.
export function reconcileSupervision({
  runId,
  armedEvidencePath,
  finalEvidencePath,
  expectedTeamId,
  executionIdentity,
  overrides = {},
}) {
  const problems = [];
  // Candidate.9: these are MANDATORY. Candidate.8 made the team check
  // conditional on expectedTeamId being supplied and the identity check
  // conditional on executionIdentity being supplied, so omitting either was a
  // bypass. Omission is now INVALID.
  if (expectedTeamId === undefined || expectedTeamId === null)
    return {
      supervisionValid: false,
      outcomeClass: 'SUPERVISION_INVALID',
      terminationProven: false,
      problems: ['Supervision reconciliation requires the bound team identity'],
    };
  if (!executionIdentity)
    return {
      supervisionValid: false,
      outcomeClass: 'SUPERVISION_INVALID',
      terminationProven: false,
      problems: [
        'Supervision reconciliation requires the governed execution identity',
      ],
    };
  try {
    verifyExecutionIdentity(executionIdentity);
  } catch (error) {
    return {
      supervisionValid: false,
      outcomeClass: 'SUPERVISION_INVALID',
      terminationProven: false,
      problems: ['Governed execution identity is not verifiable: ' + error.message],
    };
  }
  if (!armedEvidencePath || !fs.existsSync(armedEvidencePath))
    return {
      supervisionValid: false,
      outcomeClass: 'SUPERVISION_ABSENT',
      problems: ['No ARMED evidence for ' + runId],
    };
  const armed = JSON.parse(fs.readFileSync(armedEvidencePath, 'utf8'));
  const authority = seededAuthority(runId, overrides);
  if (armed.runId !== runId) problems.push('ARMED evidence binds another run');
  if (armed.timeCeilingMinutes !== authority.timeCeilingMinutes)
    problems.push('ARMED ceiling does not match the seeded authority');
  const suffix = '.armed.json';
  const finalPath =
    finalEvidencePath ??
    (armedEvidencePath.endsWith(suffix)
      ? armedEvidencePath.slice(0, -suffix.length)
      : armedEvidencePath + '.final.json');
  if (!fs.existsSync(finalPath)) {
    problems.push(
      'The bound watchdog produced no terminal supervision record; supervision did not complete',
    );
    // Absence is INVALID, never "absence means okay". This is stated as an
    // explicit decision so a mutation can flip it without crashing, and the
    // designated test then proves the unsafe state would be accepted.
    const absenceIsValid = false;
    return {
      supervisionValid: absenceIsValid,
      terminationProven: absenceIsValid,
      outcomeClass: absenceIsValid ? 'SUPERVISED' : 'SUPERVISION_INCOMPLETE',
      problems,
      watchdogPid: armed.watchdogPid,
    };
  }
  const terminal = JSON.parse(fs.readFileSync(finalPath, 'utf8'));
  // H2: terminal reconciliation must POSITIVELY verify a complete stop. There
  // is no "absence means okay" for a current official run.
  if (terminal.runId !== runId)
    problems.push('Terminal supervision record binds another run');
  if (terminal.teamId !== expectedTeamId)
    problems.push('Terminal supervision record binds another team');
  if (terminal.teamId !== armed.teamId)
    problems.push('Terminal supervision team disagrees with the ARMED binding');
  if (armed.teamId !== expectedTeamId)
    problems.push('ARMED evidence binds another team');
  if (terminal.watchdogPid !== armed.watchdogPid)
    problems.push(
      'Terminal supervision record was written by a different watchdog process',
    );
  if (!nonEmpty(terminal.watchdogNonce) || terminal.watchdogNonce !== armed.watchdogNonce)
    problems.push('Terminal supervision record is not the bound watchdog instance');
  // One shared terminal vocabulary. The producer writes terminalOutcome and
  // the consumer checks the same constant, so a genuine producer path can
  // satisfy its consumer without any test-only translation.
  const chronology = validateTerminalChronology(terminal, {
    startedAt: armed.startedAt,
    deadlineAt: armed.deadlineAt,
  });
  problems.push(...chronology.problems);
  const outcome = chronology.outcome;
  if (outcome !== null && !ADMISSIBLE_TERMINAL_OUTCOMES.includes(outcome))
    problems.push('Terminal outcome ' + outcome + ' is not an admissible official outcome');
  if (terminal.deadlineAt !== armed.deadlineAt)
    problems.push('Terminal supervision deadline drifted from the ARMED binding');
  if (terminal.startedAt !== armed.startedAt)
    problems.push('Terminal supervision start drifted from the ARMED binding');
  if (terminal.finalState?.quiescent !== true)
    problems.push('Terminal supervision record does not positively prove quiescence');
  const naturally = outcome === TERMINAL_OUTCOMES.NATURAL_COMPLETION;
  if (naturally && !nonEmpty(terminal.naturalCompletionAt))
    problems.push('Natural completion claimed without a completion instant');
  if (!naturally && !nonEmpty(terminal.observedStoppedAt))
    problems.push('Deadline halt claimed without an observed stop');
  // Positive stop proof for a halt, in the shared vocabulary.
  if (!naturally && terminal.stopProven !== true)
    problems.push('Deadline halt lacks a positive stop proof');
  // All nine bound facts, stated and equal, on BOTH records. No synthesis of a
  // missing ARMED claim: candidate.8 fabricated it from the identity itself.
  try {
    assertFullyBoundTo(
      executionIdentity,
      terminal.executionIdentityClaim,
      'Terminal supervision record',
    );
  } catch (error) {
    problems.push(error.message);
  }
  // The ARMED record is produced BEFORE the governed launch exists, so it
  // cannot carry the executionId. Every fact it does carry is therefore
  // compared positively against the governed identity's bound facts; the two
  // facts ARMED cannot know (candidateVersion, workloadHash) are bound by the
  // persisted authority record that this identity was resolved from. This is
  // full comparison of everything ARMED states, not an optional check.
  const bound = executionIdentity.boundFacts;
  for (const [field, expected] of [
    ['runId', bound.runId],
    ['teamId', bound.teamId],
    ['watchdogPid', bound.watchdogPid],
    ['watchdogNonce', bound.watchdogNonce],
    ['startedAt', bound.startedAt],
    ['deadlineAt', bound.deadlineAt],
    ['timeCeilingMinutes', bound.timeCeilingMinutes],
  ]) {
    if (armed[field] === undefined || armed[field] === null)
      problems.push('ARMED record does not state the bound ' + field);
    else if (armed[field] !== expected)
      problems.push('ARMED record disagrees with the governed execution on ' + field);
  }
  // The durable owner-verification marker is honoured here too, so every
  // consumer of reconciliation agrees regardless of which API was called.
  const marker = incompleteSupervisionMarker(runId, overrides);
  if (marker)
    problems.push(
      'An incomplete-supervision marker exists for this run and requires owner verification',
    );
  return {
    supervisionValid: problems.length === 0,
    outcomeClass: problems.length ? 'SUPERVISION_INVALID' : 'SUPERVISED',
    terminationProven: problems.length === 0,
    problems,
    watchdogPid: armed.watchdogPid,
    watchdogNonce: armed.watchdogNonce,
    terminalStatus: terminal.status,
    terminalOutcome: outcome,
    chronologyValid: chronology.valid,
    incompleteSupervisionMarker: marker,
    quiescent: terminal.finalState?.quiescent === true,
  };
}

// ---------------------------------------------------------------------------
// Reference UI acceptance resolution (UI evidence correction)
// ---------------------------------------------------------------------------
// Resolve the owner UI PASS hash-bound to the CURRENT reference bytes rather
// than whichever filename is canonical. Never fabricates a record.
export function resolveReferenceUiAcceptance(referenceHash, overrides = {}) {
  const dir = overrides.artifactsDir || path.join(root, 'artifacts');
  const names = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith('reference-ui-sanity') && n.endsWith('.json'))
    .sort();
  const considered = [];
  for (const name of names) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      considered.push({ name, usable: false, reason: 'unreadable' });
      continue;
    }
    const usable =
      record.kind === 'REFERENCE_UI_SANITY' &&
      record.verdict === 'PASS' &&
      !!record.reviewer &&
      !!record.reportedAt &&
      !!record.evidence &&
      record.referenceHash === referenceHash;
    considered.push({ name, usable, referenceHash: record.referenceHash ?? null });
    if (usable) return { record, source: name, considered };
  }
  return { record: null, source: null, considered };
}

// ---------------------------------------------------------------------------
// Bounded network operations (H5)
// ---------------------------------------------------------------------------
// Every supervision network operation carries its own abort deadline so one
// hung request can never defeat the outer supervision deadline.
export async function boundedFetch(
  url,
  options = {},
  { timeoutMs = DEFAULT_NETWORK_TIMEOUT_MS, fetchImpl = fetch, label = 'request' } = {},
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new SupervisionError('Bounded network timeout required for ' + label);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new SupervisionError(label + ' exceeded ' + timeoutMs + 'ms')),
    timeoutMs,
  );
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted)
      throw new SupervisionError(
        'Supervision network timeout: ' + label + ' exceeded ' + timeoutMs + 'ms',
        'STOP_FAILURE',
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
// H5: headers are not the end of a request. The abort deadline must stay armed
// through body consumption, so supervision callers use this instead of reading
// a body after boundedFetch has already cleared its timer.
export async function boundedRequestText(
  url,
  options = {},
  { timeoutMs = DEFAULT_NETWORK_TIMEOUT_MS, fetchImpl = fetch, label = 'request' } = {},
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new SupervisionError('Bounded network timeout required for ' + label);
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  const fail = () =>
    new SupervisionError(
      'Supervision network timeout: ' +
        label +
        ' exceeded ' +
        timeoutMs +
        'ms before completing its response body',
      'STOP_FAILURE',
    );
  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
    // The timer is deliberately still armed across body consumption.
    const text = await response.text();
    if (expired) throw fail();
    return { response, text };
  } catch (error) {
    if (expired || controller.signal.aborted) throw fail();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Dispatch gate (H2)
// ---------------------------------------------------------------------------
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
// No official benchmark execution may begin unless a correct watchdog process
// exists, its ARMED evidence binds run/team/PID/ceiling/deadline, and it is
// still alive at this authority edge. Fails closed.
// H2: PID liveness alone proves only that SOME process owns the PID. Dispatch
// additionally requires the live process to be the actual bound watchdog
// instance, proven by a fresh heartbeat carrying the same ARMED nonce, and the
// ARMED binding itself must still be current.
export function readWatchdogHeartbeat(armedEvidencePath) {
  const heartbeatPath = armedEvidencePath.replace(/\.armed\.json$/, '.alive.json');
  if (!fs.existsSync(heartbeatPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
  } catch {
    return null;
  }
}
export const DISPATCH_PHASES = ['PRE_DISPATCH', 'POST_EXECUTION'];
export function assertDispatchAllowed(
  runId,
  {
    armedEvidencePath,
    expectedTeamId,
    overrides = {},
    alive = processAlive,
    now = Date.now,
    heartbeat = readWatchdogHeartbeat,
    requireHeartbeat = true,
    // PRE_DISPATCH requires the bound deadline to still be in the future.
    // POST_EXECUTION revalidates the same binding AFTER the governed window,
    // where an elapsed deadline is the normal terminal condition. Candidate.8
    // reused the pre-dispatch check post-execution, so a run that legitimately
    // crossed its deadline failed revalidation and left no execution record.
    phase = 'PRE_DISPATCH',
  } = {},
) {
  if (!DISPATCH_PHASES.includes(phase))
    throw new SupervisionError('Unknown dispatch phase ' + phase);
  if (expectedTeamId === undefined || expectedTeamId === null)
    throw new SupervisionError(
      'Dispatch refused: the bound team identity is mandatory',
    );
  const authority = seededAuthority(runId, overrides);
  if (!armedEvidencePath)
    throw new SupervisionError(
      'Dispatch refused: no watchdog ARMED evidence path supplied for ' + runId,
    );
  if (!fs.existsSync(armedEvidencePath))
    throw new SupervisionError(
      'Dispatch refused: no ARMED evidence at ' + armedEvidencePath,
    );
  const armed = JSON.parse(fs.readFileSync(armedEvidencePath, 'utf8'));
  if (armed.status !== 'ARMED')
    throw new SupervisionError(
      'Dispatch refused: watchdog evidence status is ' + armed.status,
    );
  if (armed.runId !== runId)
    throw new SupervisionError(
      'Dispatch refused: ARMED evidence binds run ' + armed.runId,
    );
  if (armed.teamId !== expectedTeamId)
    throw new SupervisionError(
      'Dispatch refused: ARMED evidence binds team ' + armed.teamId,
    );
  if (armed.timeCeilingMinutes !== authority.timeCeilingMinutes)
    throw new SupervisionError(
      'Dispatch refused: ARMED ceiling ' +
        armed.timeCeilingMinutes +
        ' does not match the seeded authority ' +
        authority.timeCeilingMinutes,
    );
  const expectedDeadline =
    Date.parse(armed.startedAt) + authority.timeCeilingSeconds * 1000;
  if (Date.parse(armed.deadlineAt) !== expectedDeadline)
    throw new SupervisionError(
      'Dispatch refused: ARMED deadline is not startedAt plus the seeded ceiling',
    );
  if (!Number.isInteger(armed.watchdogPid) || armed.watchdogPid <= 0)
    throw new SupervisionError('Dispatch refused: ARMED evidence has no watchdog PID');
  if (!alive(armed.watchdogPid))
    throw new SupervisionError(
      'Dispatch refused: watchdog PID ' +
        armed.watchdogPid +
        ' is no longer alive; supervision would be absent',
    );
  // ARMED freshness: the binding must belong to the current execution and its
  // deadline must not already have passed on the shared official clock.
  if (!nonEmpty(armed.watchdogNonce))
    throw new SupervisionError(
      'Dispatch refused: ARMED evidence carries no watchdog instance nonce',
    );
  const nowMs = now();
  if (phase === 'PRE_DISPATCH' && Date.parse(armed.deadlineAt) <= nowMs)
    throw new SupervisionError(
      'Dispatch refused: ARMED deadline has already expired; this is a stale binding',
    );
  if (Date.parse(armed.startedAt) > nowMs)
    throw new SupervisionError(
      'Dispatch refused: ARMED start time is in the future; clocks disagree',
    );
  // Watchdog-instance proof: a fresh heartbeat carrying the same nonce shows
  // the live PID really is this bound watchdog, not an unrelated process that
  // happens to own the PID.
  if (requireHeartbeat) {
    const beat = heartbeat(armedEvidencePath);
    if (!beat)
      throw new SupervisionError(
        'Dispatch refused: no watchdog heartbeat; the bound instance is unproven',
      );
    if (beat.watchdogNonce !== armed.watchdogNonce)
      throw new SupervisionError(
        'Dispatch refused: heartbeat nonce does not match the ARMED binding; PID is a different process',
      );
    if (beat.watchdogPid !== armed.watchdogPid)
      throw new SupervisionError(
        'Dispatch refused: heartbeat PID does not match the ARMED binding',
      );
    if (beat.runId !== runId)
      throw new SupervisionError('Dispatch refused: heartbeat binds another run');
    const age = nowMs - Date.parse(beat.at);
    if (!Number.isFinite(age) || age < -5000)
      throw new SupervisionError(
        'Dispatch refused: watchdog heartbeat timestamp is implausible',
      );
    // Post-execution the watchdog has already finished, so its last heartbeat
    // is legitimately as old as the governed window. Staleness is only a
    // pre-dispatch liveness signal.
    if (phase === 'PRE_DISPATCH' && age > WATCHDOG_HEARTBEAT_STALE_MS)
      throw new SupervisionError(
        'Dispatch refused: watchdog heartbeat is stale',
      );
  }
  return {
    permitted: true,
    phase,
    runId,
    teamId: armed.teamId,
    watchdogPid: armed.watchdogPid,
    watchdogNonce: armed.watchdogNonce,
    timeCeilingMinutes: authority.timeCeilingMinutes,
    // The official clock is the watchdog's clock.
    startedAt: armed.startedAt,
    deadlineAt: armed.deadlineAt,
    authorityPath: authority.manifestPath,
  };
}

// ---------------------------------------------------------------------------
// Formal comparability (H6) — the single authoritative predicate
// ---------------------------------------------------------------------------
export const IDENTITY_FIELDS = [
  'spec',
  'specTree',
  'starter',
  'prd',
  'fixtures',
  'visible',
  'evaluator',
  'scoring',
  'runner',
  'reference',
];
// H6: assessment runs over the ORIGINAL requested comparison set. Presentation
// may later omit unplottable points, but it can never upgrade validity, and a
// missing required field fails eligibility rather than being a don't-care.
export const REQUIRED_COMPARISON_FIELDS = [
  'benchmarkVersion',
  'publicHash',
  'timeCeilingMinutes',
  'validOutcome',
  'quality',
];
export function formalComparability(reports) {
  const rows = Array.isArray(reports) ? reports : [];
  const reasons = [];
  if (rows.length < 2)
    reasons.push('A formal controlled comparison needs at least two runs');
  // H6: require POSITIVE, correctly typed facts. Missing, null, undefined or
  // false fail closed; no truthiness and no defaults.
  for (const [i, r] of rows.entries()) {
    const id = nonEmpty(r?.metrics?.run?.runId) ? r.metrics.run.runId : 'row-' + i;
    const need = (ok, what) => {
      if (ok !== true) reasons.push('Run ' + id + ' ' + what);
    };
    need(!!r?.metrics && typeof r.metrics === 'object', 'has no ingested metrics');
    need(Number.isFinite(r?.quality?.quality), 'has pending, absent or non-numeric quality');
    need(nonEmpty(r?.manifest?.benchmarkVersion), 'declares no valid benchmark candidate version');
    need(nonEmpty(r?.manifest?.publicHash), 'declares no valid public workload hash');
    need(
      !!r?.manifest?.hashes &&
        IDENTITY_FIELDS.every((k) => nonEmpty(r.manifest.hashes[k])),
      'lacks complete benchmark hash provenance',
    );
    need(
      Number.isInteger(r?.metrics?.timeCeilingMinutes) && r.metrics.timeCeilingMinutes > 0,
      'declares no valid execution ceiling',
    );
    need(r?.metrics?.validOutcome === true, 'is not a positively valid outcome');
    need(r?.metrics?.supervisionValid === true, 'has no positively valid supervision');
    need(
      r?.metrics?.eligibleForFormalComparison === true,
      'is not positively eligible for formal comparison',
    );
    need(nonEmpty(r?.metrics?.executionId), 'carries no governed execution identity');
    need(
      OFFICIAL_OUTCOME_CLASSES.includes(r?.metrics?.outcomeClass),
      'outcome class ' + String(r?.metrics?.outcomeClass) + ' is not an official class',
    );
    // Contradictory governance fields fail closed.
    if (
      r?.metrics?.officialOutcomeValid === false &&
      r?.metrics?.validOutcome === true
    )
      reasons.push('Run ' + id + ' has contradictory validity fields');
    if (r?.metrics?.official === false && r?.metrics?.validOutcome === true)
      reasons.push('Run ' + id + ' claims validity while not being an official run');
  }
  const scored = rows.filter((r) => r?.metrics && r?.quality?.quality !== null);
  if (scored.length < 1) reasons.push('No scored runs supplied');
  const identities = new Set();
  const ceilings = new Set();
  for (const r of scored) {
    const hashes = r.manifest?.hashes;
    if (!hashes || IDENTITY_FIELDS.some((k) => !hashes[k])) {
      reasons.push(
        'Run ' +
          (r.metrics?.run?.runId ?? 'unknown') +
          ' lacks complete benchmark hash provenance',
      );
      continue;
    }
    identities.add(
      JSON.stringify([
        r.manifest.benchmarkVersion,
        ...IDENTITY_FIELDS.map((k) => hashes[k]),
      ]),
    );
    ceilings.add(r.metrics.timeCeilingMinutes ?? null);
    if (r.metrics.validOutcome === false)
      reasons.push(
        'Run ' + r.metrics.run?.runId + ' has an invalid outcome and cannot be compared formally',
      );
    if (
      r.manifest.publicHash !== undefined &&
      r.manifest.publicHash !== hashes.starter
    )
      reasons.push(
        'Run ' + r.metrics.run?.runId + ' public workload hash does not match its starter hash',
      );
  }
  if (identities.size > 1)
    reasons.push('Benchmark candidate/workload identity differs between runs');
  if (ceilings.size > 1)
    reasons.push(
      'Declared execution ceilings differ: ' +
        [...ceilings].map((c) => (c === null ? 'unknown' : c)).join(', ') +
        ' minutes',
    );
  if (ceilings.has(null))
    reasons.push('At least one run has no declared execution ceiling');
  return {
    mode: reasons.length ? 'DESCRIPTIVE' : 'FORMAL',
    reasons,
    ceilings: [...ceilings],
    identities: identities.size,
    runs: scored.map((r) => ({
      runId: r.metrics.run?.runId ?? null,
      benchmarkVersion: r.manifest?.benchmarkVersion ?? null,
      starter: r.manifest?.hashes?.starter ?? null,
      timeCeilingMinutes: r.metrics.timeCeilingMinutes ?? null,
      validOutcome: r.metrics.validOutcome ?? null,
    })),
  };
}
export function assertFormalComparison(reports) {
  const result = formalComparability(reports);
  if (result.mode !== 'FORMAL')
    throw new SupervisionError(
      'Not a formal controlled comparison: ' + result.reasons.join('; '),
    );
  return result;
}
