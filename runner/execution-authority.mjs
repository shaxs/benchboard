// The official execution authority boundary.
//
// Candidate.8 exported mintExecutionIdentity(), so ordinary code could
// manufacture a seed-compatible identity, watchdog evidence, an execution
// record and telemetry, and obtain a valid official outcome with no governed
// launch at all. Execution identity was descriptive data, not launch
// provenance.
//
// Candidate.9 makes official authority authentic by construction:
//
//   1. Nothing in this module's public surface mints an identity. The raw
//      construction is private to the module that owns the launch boundary.
//   2. The ONLY way to obtain an official execution is openOfficialExecution(),
//      which cannot run without a persisted seed, a live ARMED watchdog
//      instance and a fresh heartbeat carrying that instance's nonce.
//   3. openOfficialExecution() PERSISTS the authoritative execution record
//      exactly once (wx). Every later official stage resolves that persisted
//      record from its canonical path by run id. No stage accepts a
//      caller-supplied in-memory substitute.
//   4. Resolution re-verifies the record against the independently produced
//      watchdog artifacts it names and against the persisted seed, so holding
//      a record is not enough: the real supervision artifacts must exist and
//      agree.
//
// Honest limit: this is lifecycle authenticity inside a cooperative trust
// model, not adversarial security. Any local process can compute a SHA-256, so
// authenticity rests on the persisted record plus the live-watchdog
// cross-checks above, not on hiding arithmetic. Hand-writing owner artifact
// files is forging owner evidence, which TRUST_MODEL.md places out of scope in
// the same way as editing any other artifact.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { root } from './files.mjs';

export class ExecutionAuthorityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExecutionAuthorityError';
    this.supervisionKind = 'SUPERVISOR_FAILURE';
  }
}

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const fail = (m) => {
  throw new ExecutionAuthorityError(m);
};

// Every fact an official execution binds. All nine are mandatory everywhere.
// There is no "checked only when an expected value happens to be supplied".
export const BOUND_FACTS = [
  'runId',
  'teamId',
  'candidateVersion',
  'workloadHash',
  'timeCeilingMinutes',
  'startedAt',
  'deadlineAt',
  'watchdogPid',
  'watchdogNonce',
];

export const AUTHORITY_KIND = 'BENCHBOARD_OFFICIAL_EXECUTION_AUTHORITY';
export const IDENTITY_KIND = 'BENCHBOARD_RUN_EXECUTION_IDENTITY';
export const INCOMPLETE_SUPERVISION_KIND =
  'SUPERVISION_INCOMPLETE_REQUIRES_OWNER_VERIFICATION';

// ---------------------------------------------------------------------------
// One terminal vocabulary, shared by producer and consumer
// ---------------------------------------------------------------------------
// Candidate.8's watchdog wrote TIME_LIMIT_OVERRUN while reconciliation
// expected STOPPED, so a genuine successful producer path could not satisfy
// its consumer. There is now one vocabulary and one deterministic mapping.
export const TERMINAL_OUTCOMES = {
  NATURAL_COMPLETION: 'NATURAL_COMPLETION',
  DEADLINE_HALT: 'DEADLINE_HALT',
  DEADLINE_OVERRUN_HALT: 'DEADLINE_OVERRUN_HALT',
  STOP_FAILURE: 'STOP_FAILURE',
  SUPERVISOR_FAILURE: 'SUPERVISOR_FAILURE',
  INFRASTRUCTURE_FAILURE: 'INFRASTRUCTURE_FAILURE',
};
// Only these three are admissible terminal outcomes for a current official run.
export const ADMISSIBLE_TERMINAL_OUTCOMES = [
  TERMINAL_OUTCOMES.NATURAL_COMPLETION,
  TERMINAL_OUTCOMES.DEADLINE_HALT,
  TERMINAL_OUTCOMES.DEADLINE_OVERRUN_HALT,
];
// Deterministic mapping from the watchdog's legacy status field. Producers
// write terminalOutcome directly; this exists so historical records and the
// status field cannot disagree silently.
const STATUS_TO_TERMINAL = {
  COMPLETED: TERMINAL_OUTCOMES.NATURAL_COMPLETION,
  TIME_LIMIT: TERMINAL_OUTCOMES.DEADLINE_HALT,
  TIME_LIMIT_OVERRUN: TERMINAL_OUTCOMES.DEADLINE_OVERRUN_HALT,
  STOP_FAILURE: TERMINAL_OUTCOMES.STOP_FAILURE,
  SUPERVISOR_FAILURE: TERMINAL_OUTCOMES.SUPERVISOR_FAILURE,
  INFRASTRUCTURE_FAILURE: TERMINAL_OUTCOMES.INFRASTRUCTURE_FAILURE,
};
export function terminalOutcomeOf(record) {
  const declared = record?.terminalOutcome;
  const mapped = STATUS_TO_TERMINAL[record?.status];
  if (nonEmptyString(declared)) {
    if (!Object.hasOwn(TERMINAL_OUTCOMES, declared))
      return { outcome: null, problem: 'Unknown terminal outcome ' + declared };
    if (mapped && mapped !== declared)
      return {
        outcome: null,
        problem:
          'Terminal outcome ' +
          declared +
          ' contradicts status ' +
          record.status +
          ' (which maps to ' +
          mapped +
          ')',
      };
    return { outcome: declared, problem: null };
  }
  if (mapped) return { outcome: mapped, problem: null };
  return {
    outcome: null,
    problem: 'Record carries no terminal outcome and status ' + record?.status + ' has no mapping',
  };
}

// ---------------------------------------------------------------------------
// Identity construction (PRIVATE to this module)
// ---------------------------------------------------------------------------
function assertBoundFacts(facts) {
  for (const key of BOUND_FACTS)
    if (facts[key] === undefined || facts[key] === null)
      fail('Execution authority requires a bound ' + key);
  for (const key of [
    'runId',
    'teamId',
    'candidateVersion',
    'workloadHash',
    'startedAt',
    'deadlineAt',
    'watchdogNonce',
  ])
    if (!nonEmptyString(facts[key]))
      fail('Execution authority ' + key + ' must be a non-empty string');
  if (!Number.isInteger(facts.timeCeilingMinutes) || facts.timeCeilingMinutes <= 0)
    fail('Execution authority timeCeilingMinutes must be a positive integer');
  if (!Number.isInteger(facts.watchdogPid) || facts.watchdogPid <= 0)
    fail('Execution authority watchdogPid must be a positive integer');
  const started = Date.parse(facts.startedAt);
  const deadline = Date.parse(facts.deadlineAt);
  if (!Number.isFinite(started) || !Number.isFinite(deadline))
    fail('Execution authority timestamps must parse');
  // One shared clock: the deadline is exactly the declared ceiling after the
  // bound start. No stage may open a second execution window.
  if (deadline - started !== facts.timeCeilingMinutes * 60000)
    fail('Execution authority deadline must equal startedAt plus the declared ceiling');
  return facts;
}

function identityDigest(facts, salt) {
  return sha(JSON.stringify([salt, ...BOUND_FACTS.map((k) => facts[k])]));
}
function deriveExecutionId(salt, runId, watchdogNonce) {
  return sha(JSON.stringify([salt, runId, watchdogNonce])).slice(0, 32);
}

// Not exported. Reachable only through openOfficialExecution().
function mintIdentity(facts, salt = crypto.randomUUID()) {
  const bound = assertBoundFacts({ ...facts });
  const picked = Object.fromEntries(BOUND_FACTS.map((k) => [k, bound[k]]));
  return {
    kind: IDENTITY_KIND,
    executionId: deriveExecutionId(salt, picked.runId, picked.watchdogNonce),
    salt,
    boundFacts: picked,
    digest: identityDigest(picked, salt),
    mintedAt: new Date().toISOString(),
    mintedBy: 'OFFICIAL_DSH_BENCHMARK',
  };
}

// Reading side: a persisted identity must be internally consistent.
export function verifyExecutionIdentity(identity) {
  if (!identity || identity.kind !== IDENTITY_KIND)
    fail('Missing or unrecognised execution identity');
  if (!nonEmptyString(identity.executionId))
    fail('Execution identity has no executionId');
  if (!nonEmptyString(identity.salt)) fail('Execution identity has no salt');
  assertBoundFacts(identity.boundFacts ?? {});
  if (identityDigest(identity.boundFacts, identity.salt) !== identity.digest)
    fail('Execution identity digest does not match its bound facts');
  if (
    identity.executionId !==
    deriveExecutionId(
      identity.salt,
      identity.boundFacts.runId,
      identity.boundFacts.watchdogNonce,
    )
  )
    fail('Execution identity executionId is not derived from its bound run and watchdog nonce');
  return identity;
}

// Every official artifact must state ALL nine bound facts and agree on each.
// Absent is INVALID. Different is INVALID. There is no optional-expected bypass.
export function assertFullyBoundTo(identity, claim, what) {
  verifyExecutionIdentity(identity);
  if (!claim || typeof claim !== 'object')
    fail(what + ' carries no execution identity claim');
  if (claim.executionId !== identity.executionId)
    fail(what + ' execution identity does not match this governed execution');
  for (const key of BOUND_FACTS) {
    if (claim[key] === undefined || claim[key] === null)
      fail(what + ' does not state the bound ' + key);
    if (claim[key] !== identity.boundFacts[key])
      fail(what + ' disagrees with the governed execution on ' + key);
  }
  return true;
}

// The claim an official artifact must embed. Producers call this so the
// producer and the consumer cannot drift.
export function executionIdentityClaim(identity) {
  verifyExecutionIdentity(identity);
  return { executionId: identity.executionId, ...identity.boundFacts };
}

// ---------------------------------------------------------------------------
// Canonical persisted locations
// ---------------------------------------------------------------------------
export function runsDirectory(overrides = {}) {
  return overrides.runsDir || path.join(root, 'artifacts/runs');
}
export const authorityPathFor = (runId, overrides = {}) =>
  path.join(runsDirectory(overrides), runId + '-execution-authority.json');
export const submissionPathFor = (runId, overrides = {}) =>
  path.join(runsDirectory(overrides), runId + '-submission.json');
export const activeMarkerPathFor = (runId, overrides = {}) =>
  path.join(runsDirectory(overrides), runId + '-active.json');

// ---------------------------------------------------------------------------
// The governed launch boundary
// ---------------------------------------------------------------------------
// The only composed operation that confers official execution authority. It
// requires a proven dispatch gate (which itself requires a live ARMED watchdog
// instance and a fresh heartbeat) and persists the authoritative record once.
export function openOfficialExecution({
  runId,
  dispatchGate,
  candidateVersion,
  workloadHash,
  armedEvidencePath,
  heartbeatPath,
  finalEvidencePath,
  expectedTeamId,
  overrides = {},
}) {
  if (!dispatchGate || dispatchGate.permitted !== true)
    fail('Official execution requires a proven dispatch gate');
  if (dispatchGate.runId !== runId)
    fail('Dispatch gate belongs to another run');
  if (!nonEmptyString(armedEvidencePath) || !fs.existsSync(armedEvidencePath))
    fail('Official execution requires the ARMED evidence that proved dispatch');
  if (expectedTeamId === undefined || expectedTeamId === null)
    fail('Official execution requires the bound team identity');
  if (dispatchGate.teamId !== expectedTeamId)
    fail('Dispatch gate team does not match the bound team identity');
  const identity = mintIdentity({
    runId,
    teamId: dispatchGate.teamId,
    candidateVersion,
    workloadHash,
    timeCeilingMinutes: dispatchGate.timeCeilingMinutes,
    startedAt: dispatchGate.startedAt,
    deadlineAt: dispatchGate.deadlineAt,
    watchdogPid: dispatchGate.watchdogPid,
    watchdogNonce: dispatchGate.watchdogNonce,
  });
  const record = {
    kind: AUTHORITY_KIND,
    runId,
    executionId: identity.executionId,
    executionIdentity: identity,
    official: true,
    governedDispatchProven: true,
    openedAt: new Date().toISOString(),
    // Dispatch provenance: the independently produced artifacts this authority
    // was derived from. Resolution re-checks them, so possessing this record is
    // not sufficient on its own.
    launchProvenance: {
      armedEvidencePath: path.resolve(armedEvidencePath),
      heartbeatPath: heartbeatPath
        ? path.resolve(heartbeatPath)
        : path.resolve(armedEvidencePath).replace(/\.armed\.json$/, '.alive.json'),
      finalEvidencePath: finalEvidencePath
        ? path.resolve(finalEvidencePath)
        : path.resolve(armedEvidencePath).replace(/\.armed\.json$/, ''),
      expectedTeamId,
      authorityPath: dispatchGate.authorityPath,
      dispatchedAt: new Date().toISOString(),
    },
    // Downstream validation must not have to reconstruct supervision from
    // unrelated objects.
    supervisionEvidence: {
      runId,
      armedEvidencePath: path.resolve(armedEvidencePath),
      finalEvidencePath: finalEvidencePath
        ? path.resolve(finalEvidencePath)
        : path.resolve(armedEvidencePath).replace(/\.armed\.json$/, ''),
      expectedTeamId,
    },
  };
  const at = authorityPathFor(runId, overrides);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  try {
    fs.writeFileSync(at, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST')
      fail('An official execution authority already exists for ' + runId);
    throw error;
  }
  return { ...record, authorityRecordPath: at };
}

// Resolve the AUTHORITATIVE persisted record. Every official stage calls this.
// No stage accepts a caller-supplied in-memory execution record.
export function resolveOfficialExecution(runId, { overrides = {}, requireLaunchArtifacts = true } = {}) {
  if (!nonEmptyString(runId)) fail('runId required to resolve official execution');
  const at = authorityPathFor(runId, overrides);
  if (!fs.existsSync(at))
    fail(
      'No persisted official execution authority for ' +
        runId +
        '; without a governed launch there is no official outcome',
    );
  let record;
  try {
    record = JSON.parse(fs.readFileSync(at, 'utf8'));
  } catch {
    fail('Persisted execution authority for ' + runId + ' is not readable JSON');
  }
  if (record.kind !== AUTHORITY_KIND)
    fail('Persisted record at ' + at + ' is not an official execution authority');
  if (record.runId !== runId)
    fail('Persisted execution authority binds another run');
  if (record.official !== true || record.governedDispatchProven !== true)
    fail('Persisted execution authority does not assert a governed dispatch');
  const identity = verifyExecutionIdentity(record.executionIdentity);
  if (record.executionId !== identity.executionId)
    fail('Persisted execution authority executionId disagrees with its identity');
  if (identity.boundFacts.runId !== runId)
    fail('Persisted execution identity binds another run');
  // The record must agree with the independently produced launch artifacts it
  // names. A manufactured record with no real watchdog artifacts fails here.
  if (requireLaunchArtifacts) {
    const prov = record.launchProvenance ?? {};
    if (!nonEmptyString(prov.armedEvidencePath) || !fs.existsSync(prov.armedEvidencePath))
      fail('Official execution authority names no existing ARMED evidence');
    const armed = JSON.parse(fs.readFileSync(prov.armedEvidencePath, 'utf8'));
    if (armed.status !== 'ARMED')
      fail('Official execution authority names evidence whose status is ' + armed.status);
    if (armed.runId !== runId) fail('ARMED evidence binds another run');
    if (armed.teamId !== identity.boundFacts.teamId)
      fail('ARMED evidence team disagrees with the governed execution');
    if (armed.watchdogPid !== identity.boundFacts.watchdogPid)
      fail('ARMED evidence watchdog PID disagrees with the governed execution');
    if (armed.watchdogNonce !== identity.boundFacts.watchdogNonce)
      fail('ARMED evidence watchdog instance disagrees with the governed execution');
    if (armed.startedAt !== identity.boundFacts.startedAt)
      fail('ARMED evidence start instant disagrees with the governed execution');
    if (armed.deadlineAt !== identity.boundFacts.deadlineAt)
      fail('ARMED evidence deadline disagrees with the governed execution');
    if (armed.timeCeilingMinutes !== identity.boundFacts.timeCeilingMinutes)
      fail('ARMED evidence ceiling disagrees with the governed execution');
    if (!nonEmptyString(prov.heartbeatPath) || !fs.existsSync(prov.heartbeatPath))
      fail('Official execution authority names no existing watchdog heartbeat');
    const beat = JSON.parse(fs.readFileSync(prov.heartbeatPath, 'utf8'));
    if (beat.watchdogNonce !== identity.boundFacts.watchdogNonce)
      fail('Watchdog heartbeat instance disagrees with the governed execution');
    if (beat.watchdogPid !== identity.boundFacts.watchdogPid)
      fail('Watchdog heartbeat PID disagrees with the governed execution');
    if (beat.runId !== runId) fail('Watchdog heartbeat binds another run');
  }
  if (!record.supervisionEvidence || record.supervisionEvidence.runId !== runId)
    fail('Official execution authority carries no supervision evidence for this run');
  return { ...record, executionIdentity: identity, authorityRecordPath: at };
}

// Non-throwing probe, for consumers that must report rather than crash.
export function tryResolveOfficialExecution(runId, options = {}) {
  try {
    return { resolved: resolveOfficialExecution(runId, options), problem: null };
  } catch (error) {
    return { resolved: null, problem: error.message };
  }
}

export const outcomePathFor = (runId, overrides = {}) =>
  path.join(runsDirectory(overrides), runId + '-execution.json');

// The persisted execution OUTCOME written by the official launcher when the
// governed window closed. Candidate.8 accepted a caller-supplied object here
// and ignored its validOutcome/supervisionValid/runStatus entirely, so an
// INFRASTRUCTURE_FAILURE could still be granted eligibility. This resolves the
// record from disk and binds it to the governed identity.
export function resolveExecutionOutcome(runId, executionIdentity, { overrides = {} } = {}) {
  verifyExecutionIdentity(executionIdentity);
  const at = outcomePathFor(runId, overrides);
  if (!fs.existsSync(at))
    fail(
      'No persisted execution outcome for ' +
        runId +
        '; the governed window never closed on record',
    );
  const record = JSON.parse(fs.readFileSync(at, 'utf8'));
  if (record.runId !== runId) fail('Persisted execution outcome binds another run');
  if (record.official !== true)
    fail('Persisted execution outcome is not an official benchmark execution');
  assertFullyBoundTo(
    executionIdentity,
    record.executionIdentity
      ? { executionId: record.executionIdentity.executionId, ...record.executionIdentity.boundFacts }
      : null,
    'Persisted execution outcome',
  );
  const valid =
    record.validOutcome === true &&
    record.supervisionValid === true &&
    record.terminationProven === true &&
    record.governedDispatchProven === true &&
    !['STOP_FAILURE', 'INFRASTRUCTURE_FAILURE', 'SUPERVISOR_FAILURE'].includes(
      record.runStatus,
    );
  const problems = [];
  if (record.validOutcome !== true) problems.push('Execution outcome validOutcome is not true');
  if (record.supervisionValid !== true)
    problems.push('Execution outcome supervisionValid is not true');
  if (record.terminationProven !== true)
    problems.push('Execution outcome does not prove termination');
  if (record.governedDispatchProven !== true)
    problems.push('Execution outcome does not prove a governed dispatch');
  if (['STOP_FAILURE', 'INFRASTRUCTURE_FAILURE', 'SUPERVISOR_FAILURE'].includes(record.runStatus))
    problems.push('Execution outcome runStatus is ' + record.runStatus);
  return { ...record, outcomeRecordPath: at, executionRecordValid: valid, problems };
}

// ---------------------------------------------------------------------------
// Incomplete-supervision marker: one reading, honoured by every consumer
// ---------------------------------------------------------------------------
export function incompleteSupervisionMarker(runId, overrides = {}) {
  const at = activeMarkerPathFor(runId, overrides);
  if (!fs.existsSync(at)) return null;
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(at, 'utf8'));
  } catch {
    // An unreadable active marker is itself an unresolved supervision state.
    return { kind: INCOMPLETE_SUPERVISION_KIND, runId, unreadable: true, path: at };
  }
  if (marker.kind !== INCOMPLETE_SUPERVISION_KIND) return null;
  return { ...marker, path: at };
}

// ---------------------------------------------------------------------------
// Frozen submission: the benchmark result is the bytes at termination
// ---------------------------------------------------------------------------
// Persisted once, at authoritative termination. Private evaluation resolves
// THIS and compares; it never defines the official submission by hashing
// whatever happens to be on disk later.
export function freezeSubmission({
  runId,
  executionIdentity,
  submissionHash,
  fileCount = null,
  frozenAt = new Date().toISOString(),
  terminalOutcome,
  quiescentAt = null,
  overrides = {},
}) {
  verifyExecutionIdentity(executionIdentity);
  if (!nonEmptyString(submissionHash))
    fail('Freezing a submission requires the submission hash');
  if (!ADMISSIBLE_TERMINAL_OUTCOMES.includes(terminalOutcome))
    fail('Freezing a submission requires an admissible terminal outcome, got ' + terminalOutcome);
  const record = {
    kind: 'BENCHBOARD_FROZEN_SUBMISSION',
    runId,
    executionId: executionIdentity.executionId,
    executionIdentityClaim: executionIdentityClaim(executionIdentity),
    submissionHash,
    fileCount,
    frozenAt,
    terminalOutcome,
    quiescentAt,
    statement:
      'These bytes are the benchmark result. Official evaluation must compare the evaluated workspace against this hash and refuse if it differs.',
  };
  const at = submissionPathFor(runId, overrides);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  try {
    fs.writeFileSync(at, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST')
      fail('A frozen submission already exists for ' + runId + '; it is immutable');
    throw error;
  }
  return { ...record, submissionRecordPath: at };
}

export function resolveFrozenSubmission(runId, { overrides = {} } = {}) {
  const at = submissionPathFor(runId, overrides);
  if (!fs.existsSync(at))
    fail(
      'No frozen submission for ' +
        runId +
        '; the participant result was never frozen at termination',
    );
  const record = JSON.parse(fs.readFileSync(at, 'utf8'));
  if (record.kind !== 'BENCHBOARD_FROZEN_SUBMISSION')
    fail('Persisted record at ' + at + ' is not a frozen submission');
  if (record.runId !== runId) fail('Frozen submission binds another run');
  if (!nonEmptyString(record.submissionHash))
    fail('Frozen submission carries no submission hash');
  return { ...record, submissionRecordPath: at };
}
