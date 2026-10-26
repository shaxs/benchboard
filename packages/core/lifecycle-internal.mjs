/**
 * BenchBoard manual run lifecycle (C3 T1).
 *
 * Standalone core module: Node builtins plus the accepted C1/C2 seams
 * (storage, manifest, paths, init identity constants) only. No DSH import, no
 * environment or global discovery, no network, no process launch, no signal,
 * and no reach into any historical automation surface.
 *
 * Contract (C3 EXECUTION_PLAN T1 section, as adjudicated):
 *  - Every API takes an explicit absolute `runRoot` plus the expected
 *    `manifestId` and `runId`. There is no global discovery, no folder-derived
 *    identity, no DSH or environment lookup. The accepted C2 sealed RunManifest
 *    is read back through the accepted storage key
 *    `{relativePath:'state/run.json', kind:'benchboard:run-initialisation', id:manifestId}`;
 *    the persisted roots are revalidated against it, so a substituted, copied,
 *    foreign or link-aliased container is rejected before any write. An
 *    `expectedDigest` may additionally be supplied by a caller that already
 *    knows it; no caller has to discover internal state paths.
 *  - `withRunTransaction(request, callback)` holds the accepted
 *    `createStorage({root: manifest.evidenceRoot}).withLock` for the whole
 *    command and provides the narrow callback context
 *    `{manifest, storage, workspaceRoot, stateRoot, lifecycle, appendEvent,
 *    commitState}`. Cross-process lock conflicts are refused; locks are never
 *    stolen and never expire. The callback cannot invent facts: state moves go
 *    through the checked seams below.
 *  - States: derived `INITIALIZED`, then `RUNNING` from a valid start, then
 *    `STOP_RECORDED` from an attested stop, then `FROZEN` from a verified
 *    freeze. There is no `RUNNING -> FROZEN` permission anywhere, including
 *    through the command seam: a freeze requires either a `STOP_RECORDED` run
 *    with a bound stop attestation or an explicit `INITIALIZED` clockless
 *    attestation. This module never performs the freeze itself (T3 owns it)
 *    and exposes only the precondition table plus checked state writes.
 *  - The journal is append-only and hash-chained: every ordered event after
 *    the first binds the digest of its immediate predecessor. A missing,
 *    reordered, duplicated or corrupt predecessor binding is a journal
 *    violation that refuses the operation; it is never repaired silently.
 *  - Clocks: the default clock is the observed current wall clock. A caller may
 *    inject a clock shaped `{now(): timestamp}`. Equal readings and a
 *    legitimate elapsed of zero are valid. An unknown instant stays `null`
 *    (never zero), and a reversed or discontinuous clock is retained as a
 *    clock error with elapsed unavailable — nothing is clamped or invented.
 *  - `stopRun` records an operator-entered assertion plus the observed
 *    timestamp, returns `stopAssurance:'operator-attested'` and
 *    `enforced:false`, and never signals, terminates, launches or surveys
 *    processes or agents.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { createStorage } from './storage.mjs';
import { validateRecord } from './manifest.mjs';
import { resolveWithinRoot, assertDisjointRoots } from './paths.mjs';
import { INIT_STATE_KIND, STATE_DIRECTORY_NAME, RUN_STATE_RELATIVE_PATH } from './init.mjs';

/* ========================================================================== */
/* Contract constants                                                          */
/* ========================================================================== */

/** Stable machine-readable refusal reasons; callers branch on `code`. */
export const LIFECYCLE_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_ROOT: 'INVALID_ROOT',
  FIELD_REQUIRED: 'FIELD_REQUIRED',
  NOT_FOUND: 'NOT_FOUND',
  PROVENANCE_MISMATCH: 'PROVENANCE_MISMATCH',
  STATE_TRANSITION_REFUSED: 'STATE_TRANSITION_REFUSED',
  DECLARATION_INVALID: 'DECLARATION_INVALID',
  DECLARATION_ALREADY_BOUND: 'DECLARATION_ALREADY_BOUND',
  ATTESTATION_INVALID: 'ATTESTATION_INVALID',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  CLOCK_INVALID: 'CLOCK_INVALID',
  JOURNAL_INVALID: 'JOURNAL_INVALID',
  SCHEMA_VALIDATION_FAILED: 'SCHEMA_VALIDATION_FAILED',
  READBACK_FAILED: 'READBACK_FAILED',
  STORAGE_REFUSED: 'STORAGE_REFUSED',
});

export const LIFECYCLE_MODULE_ID = 'benchboard-core-lifecycle-v1';
export const LIFECYCLE_SCHEMA_VERSION = '1.0.0';

/** Storage identities of the lifecycle record and of journal events. */
export const LIFECYCLE_STATE_KIND = 'benchboard.lifecycle.state.v1';
export const LIFECYCLE_EVENT_KIND = 'benchboard.lifecycle.event.v1';
export const LIFECYCLE_STATE_RELATIVE_PATH = 'lifecycle/state.json';
export const LIFECYCLE_JOURNAL_DIRECTORY = 'lifecycle/journal';

/** The C2 sealed run record key the lifecycle binds to. */
export const RUN_MANIFEST_STATE_KEY = Object.freeze({
  relativePath: RUN_STATE_RELATIVE_PATH,
  kind: INIT_STATE_KIND,
});

/** The state the container reports before any lifecycle record exists. */
export const LIFECYCLE_DERIVED_STATE = 'INITIALIZED';

/** Committed states a lifecycle record can carry. */
export const LIFECYCLE_COMMITTED_STATES = Object.freeze([
  'INITIALIZED',
  'RUNNING',
  'STOP_RECORDED',
  'FROZEN',
]);

/** Journal event kinds this contract understands. */
export const LIFECYCLE_EVENT_KINDS = Object.freeze([
  'START_INTENT',
  'START_COMMIT',
  'STOP_RECORDED',
  'FREEZE_INTENT',
  'FREEZE_COMMIT',
]);

/**
 * The freeze precondition table. It is the single source of truth for who may
 * reach `FROZEN`, and it states plainly that `RUNNING` may not: a freeze is
 * permitted from `STOP_RECORDED` with a bound stop attestation, or from
 * `INITIALIZED` with an explicit clockless attestation.
 *
 * `attestationRequired` is the whole justification for a freeze: an operator
 * statement binding the exact attestation the run carries. `clockRequired`
 * states whether a *clock-observed* instant is part of the requirement, and for
 * both routes it is `false`: when a clock honestly reported nothing (unknown,
 * reversed or discontinuous), the recorded stop instant is `null` and the
 * freeze still proceeds with that `null` rather than this contract inventing,
 * clamping or substituting a time in order to satisfy a gate.
 */
export const FREEZE_PRECONDITIONS = Object.freeze({
  STOP_RECORDED: Object.freeze({ requires: 'BOUND_STOP_ATTESTATION', attestationRequired: true, clockRequired: false }),
  INITIALIZED: Object.freeze({ requires: 'CLOCKLESS_ATTESTATION', attestationRequired: true, clockRequired: false }),
});

/** The complete transition permission table enforced by every state write. */
export const LIFECYCLE_TRANSITIONS = Object.freeze({
  ABSENT: Object.freeze(['INITIALIZED', 'RUNNING']),
  INITIALIZED: Object.freeze(['RUNNING', 'STOP_RECORDED', 'FROZEN']),
  RUNNING: Object.freeze(['STOP_RECORDED']),
  STOP_RECORDED: Object.freeze(['FROZEN']),
  FROZEN: Object.freeze([]),
});

/** The only execution mode this release records. */
export const LIFECYCLE_EXECUTION_MODE = 'MANUAL';

/** The assurance a recorded stop carries: attested, never enforced. */
export const STOP_ASSURANCE = 'operator-attested';
export const STOP_ENFORCED = false;

const RUN_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{2,127}$/;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{2,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const OPERATOR_MIN_LENGTH = 2;
const OPERATOR_MAX_LENGTH = 256;
const MAX_JOURNAL_EVENTS = 4096;
const SELF_STATE_FIELD = 'stateDigest';
const SELF_EVENT_FIELD = 'eventDigest';
const HASH_ALGORITHM = 'sha256';

/* ========================================================================== */
/* Error                                                                       */
/* ========================================================================== */

/** A refusal carrying one stable `code` from the code table. */
export class LifecycleError extends Error {
  constructor(code, message, details) {
    if (typeof LIFECYCLE_ERROR_CODES[code] !== 'string') {
      throw new Error(`Unknown lifecycle error code: ${String(code)}`);
    }
    super(`${code}: ${message}`);
    this.name = 'LifecycleError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new LifecycleError(code, message, details);
}

/* ========================================================================== */
/* Guards                                                                      */
/* ========================================================================== */

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function need(value, label) {
  if (value === undefined) fail(LIFECYCLE_ERROR_CODES.FIELD_REQUIRED, `${label} is required.`);
  return value;
}

function wantObject(value, label, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(LIFECYCLE_ERROR_CODES.FIELD_REQUIRED, `${label} is required.`);
    return undefined;
  }
  if (!isObject(value)) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `${label} must be a plain object, got ${describe(value)}.`);
  return value;
}

function wantString(value, label, { required = false, minLength = 1, maxLength = 4096, pattern } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(LIFECYCLE_ERROR_CODES.FIELD_REQUIRED, `${label} is required.`);
    return null;
  }
  if (typeof value !== 'string') fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `${label} must be a string, got ${describe(value)}.`);
  if (value.length < minLength) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `${label} must be at least ${minLength} characters.`);
  if (value.length > maxLength) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `${label} must be at most ${maxLength} characters.`);
  if (pattern !== undefined && !pattern.test(value)) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `${label} must match ${pattern.source}.`);
  return value;
}

function wantStringOrNull(value, label, { maxLength = 4096 } = {}) {
  if (value === undefined || value === null) return null;
  return wantString(value, label, { required: true, maxLength });
}

function wantAbsolute(value, label, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(LIFECYCLE_ERROR_CODES.FIELD_REQUIRED, `${label} is required.`);
    return null;
  }
  if (typeof value !== 'string') fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `${label} must be a path string, got ${describe(value)}.`);
  if (!path.isAbsolute(value)) fail(LIFECYCLE_ERROR_CODES.INVALID_ROOT, `${label} must be an absolute host path, got ${JSON.stringify(value)}.`);
  return path.resolve(value);
}

function parseIso(value, label, { required = false } = {}) {
  const text = wantString(value, label, {
    required,
    minLength: 20,
    maxLength: 40,
    pattern: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/,
  });
  if (text === null) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `${label} is not a parseable ISO-8601 UTC instant: ${JSON.stringify(text)}.`);
  return ms;
}

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

/* ========================================================================== */
/* Canonical JSON and digests                                                  */
/* ========================================================================== */

function canonicalJson(value) {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'number') {
    if (!Number.isFinite(value)) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'canonical JSON carries no non-finite number.');
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (kind === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `canonical JSON carries no ${kind} value.`);
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** The digest of an object with its own self-digest field removed. */
function selfDigestOf(object, fieldName) {
  const body = {};
  for (const key of Object.keys(object)) if (key !== fieldName) body[key] = object[key];
  return sha256Hex(canonicalJson(body));
}

function clone(value) {
  return structuredClone(value);
}

/* ========================================================================== */
/* Clock seam                                                                  */
/* ========================================================================== */

/**
 * The default clock: the observed current wall clock. Nothing here returns a
 * fabricated instant; when the wall clock is not knowable the reading is
 * `null`, and a caller that needs an instant treats `null` as unknown rather
 * than as zero.
 */
export const DEFAULT_CLOCK = Object.freeze({
  name: 'observed-wallclock',
  now() {
    const value = Date.now();
    return Number.isFinite(value) ? value : null;
  },
});

/**
 * Read one clock through the `{now(): timestamp}` seam.
 *
 *  - `undefined` clock: unknown; the reading is `null`, never a guess.
 *  - a clock whose `now()` yields `null`/`undefined`: unknown, `null`.
 *  - a clock whose `now()` throws or yields a non-finite or negative value: a
 *    retained clock error (`CLOCK_INVALID`), because that is a broken
 *    instrument rather than an unknown instant.
 *  - a reading below `floor` (the last instant this run already recorded): a
 *    reversal or discontinuity, retained as an error rather than clamped
 *    forward. Equal readings are valid: time standing still is not time going
 *    backwards, and it is what makes a legitimate elapsed of zero possible.
 *
 * @returns {{ ok: true, ms: number|null } | { ok: false, code: string, error: string }}
 */
export function readClockReading(clock, floor) {
  if (clock === undefined || clock === null) return { ok: true, ms: null };
  if (typeof clock !== 'object' || typeof clock.now !== 'function') {
    return { ok: false, code: LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, error: 'an injected clock must be an object with a now() method returning epoch milliseconds or null.' };
  }
  let raw;
  try {
    raw = clock.now();
  } catch (error) {
    return { ok: false, code: LIFECYCLE_ERROR_CODES.CLOCK_INVALID, error: `clock.now() raised: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (raw === null || raw === undefined) return { ok: true, ms: null };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, code: LIFECYCLE_ERROR_CODES.CLOCK_INVALID, error: `clock.now() returned a value that is not a finite epoch-millisecond number: ${String(raw)}.` };
  }
  if (raw < 0) {
    return { ok: false, code: LIFECYCLE_ERROR_CODES.CLOCK_INVALID, error: `clock.now() returned ${String(raw)}; a negative epoch reading is a broken instrument, not an unknown instant.` };
  }
  if (floor !== null && floor !== undefined && raw < floor) {
    return { ok: false, code: LIFECYCLE_ERROR_CODES.CLOCK_INVALID, error: `clock.now() returned ${String(raw)} which is below ${String(floor)}, the last instant already recorded for this run: the clock has reversed or jumped discontinuously. Elapsed time is reported as unavailable; nothing is clamped forward.` };
  }
  return { ok: true, ms: raw };
}

/**
 * Compute elapsed milliseconds between two recorded instants. An unknown
 * endpoint yields `null` (unknown), never `0`. Equal endpoints yield `0`,
 * which is a legitimate measured elapsed.
 */
export function elapsedBetween(earlierIso, laterIso) {
  const earlier = parseIso(earlierIso, 'earlier instant') ?? parseIsoValue(earlierIso);
  const later = parseIso(laterIso, 'later instant') ?? parseIsoValue(laterIso);
  if (earlier === null || later === null) return null;
  if (later < earlier) return null;
  return later - earlier;
}

function parseIsoValue(value) {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/* ========================================================================== */
/* Declaration and attestation shapes                                          */
/* ========================================================================== */

const DECLARATION_FIELDS = Object.freeze(['harness', 'model', 'workerCount', 'executionMode', 'declaredCeilingMinutes']);

/**
 * Validate the C3 declaration companion. The accepted C1 configuration carries
 * no worker count and no execution mode, so those live here, in the immutable
 * declaration the lifecycle records. `null` means unknown and stays unknown.
 */
function validateDeclaration(value, { label = 'the start declaration' } = {}) {
  const declaration = wantObject(value, label);
  const unknown = Object.keys(declaration).filter((key) => !DECLARATION_FIELDS.includes(key));
  if (unknown.length > 0) fail(LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, `${label} carries undeclared field(s): ${unknown.join(', ')}.`);

  const harness = wantStringOrNull(declaration.harness, `${label}.harness`, { maxLength: 128 });
  const model = wantStringOrNull(declaration.model, `${label}.model`, { maxLength: 512 });
  const executionMode = wantString(declaration.executionMode, `${label}.executionMode`, { required: true, maxLength: 64 });
  if (executionMode !== LIFECYCLE_EXECUTION_MODE) {
    fail(LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, `${label}.executionMode must be ${JSON.stringify(LIFECYCLE_EXECUTION_MODE)}, got ${JSON.stringify(executionMode)}.`);
  }

  if (declaration.workerCount !== undefined && declaration.workerCount !== null) {
    if (typeof declaration.workerCount !== 'number' || !Number.isInteger(declaration.workerCount) || declaration.workerCount < 1) {
      fail(LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, `${label}.workerCount must be a positive integer or null, got ${String(declaration.workerCount)}.`);
    }
  }
  if (declaration.declaredCeilingMinutes !== undefined && declaration.declaredCeilingMinutes !== null) {
    const ceiling = declaration.declaredCeilingMinutes;
    if (typeof ceiling !== 'number' || !Number.isInteger(ceiling) || ceiling < 1 || ceiling > 1440) {
      fail(LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, `${label}.declaredCeilingMinutes must be an integer within 1..1440 or null, got ${String(ceiling)}.`);
    }
  }

  return Object.freeze({
    harness,
    model,
    workerCount: declaration.workerCount ?? null,
    executionMode,
    declaredCeilingMinutes: declaration.declaredCeilingMinutes ?? null,
  });
}

/**
 * Bind a declaration to the values the accepted manifest and challenge identity
 * already state. A conflict is a refusal; a value the manifest does not state
 * is left unknown (`null`) rather than guessed. `manual` is the harness this
 * seam serves.
 */
function bindDeclaration(declaration, manifest) {
  const conflicts = [];
  const configuration = isObject(manifest.configuration) ? manifest.configuration : {};

  if (declaration.harness !== null && manifest.harness !== undefined && declaration.harness !== manifest.harness) {
    conflicts.push(`harness: declaration ${JSON.stringify(declaration.harness)} versus accepted manifest ${JSON.stringify(manifest.harness)}`);
  }
  const manifestModel = Object.hasOwn(configuration, 'model') ? configuration.model : null;
  if (declaration.model !== null && manifestModel !== null && declaration.model !== manifestModel) {
    conflicts.push(`model: declaration ${JSON.stringify(declaration.model)} versus accepted manifest ${JSON.stringify(manifestModel)}`);
  }
  if (declaration.declaredCeilingMinutes !== null && manifest.declaredCeilingMinutes !== null && declaration.declaredCeilingMinutes !== manifest.declaredCeilingMinutes) {
    conflicts.push(`declaredCeilingMinutes: declaration ${String(declaration.declaredCeilingMinutes)} versus accepted manifest ${String(manifest.declaredCeilingMinutes)}`);
  }
  const challengeCeiling = challengeCeilingMinutesOf(manifest);
  if (declaration.declaredCeilingMinutes !== null && challengeCeiling !== null && declaration.declaredCeilingMinutes > challengeCeiling) {
    conflicts.push(`declaredCeilingMinutes: declaration ${String(declaration.declaredCeilingMinutes)} exceeds the challenge bound ceiling ${String(challengeCeiling)}`);
  }
  if (conflicts.length > 0) {
    fail(LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, `the declaration conflicts with the accepted identity: ${conflicts.join('; ')}.`, { conflicts });
  }
  return Object.freeze({
    harness: declaration.harness ?? manifest.harness ?? null,
    model: declaration.model ?? null,
    workerCount: declaration.workerCount,
    executionMode: declaration.executionMode,
    declaredCeilingMinutes: declaration.declaredCeilingMinutes ?? manifest.declaredCeilingMinutes ?? null,
  });
}

function challengeCeilingMinutesOf(manifest) {
  const identity = manifest.challengeIdentity;
  if (!isStringBase64(identity) && isObject(identity)) {
    const direct = identity.declaredCeilingMinutes ?? identity.ceilingMinutes ?? null;
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  }
  return null;
}

function isStringBase64(value) {
  return typeof value === 'string';
}

/** Validate a stop attestation: an operator statement, not an instruction. */
function validateStopAttestation(value) {
  const attestation = wantObject(need(value, 'the stop attestation'), 'the stop attestation');
  const allowed = ['operator', 'agentStopped', 'statement', 'observedAt'];
  const unknown = Object.keys(attestation).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, `the stop attestation carries undeclared field(s): ${unknown.join(', ')}. An attestation states a witnessed fact and carries no instruction field.`);
  }
  const operator = wantString(attestation.operator, 'attestation.operator', { required: true, minLength: OPERATOR_MIN_LENGTH, maxLength: OPERATOR_MAX_LENGTH });
  if (attestation.agentStopped !== true) {
    fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'attestation.agentStopped must be the boolean true: the operator asserts that the cooperating agents stopped of their own cooperation.');
  }
  const statement = wantString(attestation.statement, 'attestation.statement', { required: true, minLength: 8, maxLength: 2000 });
  const observedAt = wantStringOrNull(attestation.observedAt, 'attestation.observedAt');
  if (observedAt !== null) parseIso(observedAt, 'attestation.observedAt');
  return Object.freeze({ operator, agentStopped: true, statement, observedAt });
}

/* -------------------------------------------------------------------------- */
/* The authority a journal entry must carry                                    */
/* -------------------------------------------------------------------------- */

/**
 * The journaled form of an operator stop statement. The entry is the written
 * record of a witnessed fact, so it must carry the fact itself plus the two
 * assurances that qualify it: the statement is attested, and nothing was
 * enforced. A detail that merely names an operator is not a stop.
 */
function validateStopDetail(value) {
  if (value === undefined || value === null) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'a journaled stop must carry its stop event detail: the entry is the written record of an operator statement, so an entry that states no statement records no stop.');
  const detail = wantObject(value, 'the stop event detail');
  const unknown = Object.keys(detail).filter((key) => !['operator', 'agentStopped', 'statement', 'observedAt', 'assurance', 'enforced'].includes(key));
  if (unknown.length > 0) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, `the stop event detail carries undeclared field(s): ${unknown.join(', ')}.`);
  /* The journaled entry states the witnessed instant as part of the fact: it is
   * nullable, and it is required. An entry that omits the claim and an entry that
   * attests no instant are two different statements, so the seam cannot accept the
   * first by normalising it into the second. Presence is therefore tested on the
   * key itself, which is what keeps an explicit null distinguishable from an
   * absent field. */
  if (!Object.hasOwn(detail, 'observedAt')) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'the stop event detail must state observedAt: the journaled stop records the instant the operator witnessed the stop at, and states it as null when the clock reported nothing. An entry that omits the claim is not the same statement as one that states no instant, so the field is required and nullable rather than optional.');
  const attestation = validateStopAttestation({ operator: detail.operator, agentStopped: detail.agentStopped, statement: detail.statement, observedAt: detail.observedAt });
  if (detail.assurance !== STOP_ASSURANCE) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, `the stop event detail must state assurance ${JSON.stringify(STOP_ASSURANCE)}: a journaled stop is an operator attestation, never an unattested observation.`);
  if (detail.enforced !== STOP_ENFORCED) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, `the stop event detail must state enforced ${String(STOP_ENFORCED)}: this release attests a stop, it does not enforce one.`);
  /* The journaled entry carries the witnessed instant as the contract states it:
   * nullable, and present as an explicit null when the operator reported none, so
   * an entry that omits the field and an entry that states no instant are not the
   * same claim. The assurance fields qualify the entry; the instant is part of the
   * fact. */
  return Object.freeze({ operator: attestation.operator, agentStopped: true, statement: attestation.statement, observedAt: attestation.observedAt, assurance: STOP_ASSURANCE, enforced: STOP_ENFORCED });
}

/**
 * The journaled authority to freeze. A freeze intent states the same witnessed
 * fact a stop states — who attests it, that no agent was left running, and the
 * statement itself — plus the two assurances that qualify it. The freeze route
 * is carried by `clockless`, which is a required boolean rather than an optional
 * flag: `false` is the bound route over a journaled stop and `true` is the route
 * of a run frozen without ever starting while no time was observed, so an entry
 * that omitted the route would state a different fact from one that states the
 * bound route. Which run state a stated route may appear on is checked by the
 * append seam against the journal, because the route is a claim about the run.
 * Either way the attestation block itself is mandatory: an intent that names
 * only an operator states no fact and authorises nothing.
 */
function validateFreezeIntentDetail(value) {
  if (value === undefined || value === null) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'a freeze intent must carry its freeze intent detail: an intent states the operator attestation that authorises the freeze, or the explicit statement that the run is frozen clocklessly, and an entry that states neither authorises nothing.');
  const detail = wantObject(value, 'the freeze intent detail');
  const unknown = Object.keys(detail).filter((key) => !['operator', 'agentStopped', 'statement', 'observedAt', 'assurance', 'enforced', 'clockless'].includes(key));
  if (unknown.length > 0) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, `the freeze intent detail carries undeclared field(s): ${unknown.join(', ')}.`);
  /* The witnessed instant is part of the attested fact and is nullable: required
   * as a key, and stated as null when no clock reported one. Presence is tested on
   * the key so an omission cannot be normalised into an attested null. */
  if (!Object.hasOwn(detail, 'observedAt')) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'the freeze intent detail must state observedAt: the intent carries the same witnessed fact a stop carries, and the instant is part of that fact. An intent that omits the claim is not the same statement as one that states no instant, so the field is required and nullable rather than optional.');
  const attestation = validateStopAttestation({ operator: detail.operator, agentStopped: detail.agentStopped, statement: detail.statement, observedAt: detail.observedAt });
  if (detail.assurance !== STOP_ASSURANCE) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, `the freeze intent detail must state assurance ${JSON.stringify(STOP_ASSURANCE)}: a freeze intent is an operator attestation, not a bare request.`);
  if (detail.enforced !== STOP_ENFORCED) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, `the freeze intent detail must state enforced ${String(STOP_ENFORCED)}.`);
  /* The route is a statement the entry makes, not a field the seam may infer. An
   * omitted route is refused rather than read as `false`, and a stated `false` is
   * kept: dropping it would erase the distinction between the two routes. */
  if (!Object.hasOwn(detail, 'clockless')) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'the freeze intent detail must state clockless as a boolean: the intent states which of the two routes it authorises, so an entry that omits the route states an authority the seam would have to choose. A bound freeze states clockless: false and a clockless freeze states clockless: true.');
  if (typeof detail.clockless !== 'boolean') fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'the freeze intent detail states clockless as something other than a boolean.');
  /* The accepted event detail carries the witnessed instant the way the field
   * contract states it: nullable and explicit, so an intent that names no instant
   * is distinguishable from one that omits the claim. The route is carried
   * verbatim, both when it is the bound route and when it is the clockless one. */
  return Object.freeze({ operator: attestation.operator, agentStopped: true, statement: attestation.statement, observedAt: attestation.observedAt, assurance: STOP_ASSURANCE, enforced: STOP_ENFORCED, clockless: detail.clockless });
}

/**
 * The digest a commit entry binds. A commit is the journaled statement "this
 * projection is committed", so it names the projection by digest; a commit that
 * binds nothing is an assertion about no run. A reconciled commit binds the
 * projection in addition to naming the intent it completed from.
 */
function validateCommitDetail(value, { label }) {
  if (value === undefined || value === null) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, `${label} is refused: a commit is the journaled statement that a projection was committed, so an entry that binds no projection digest is not a commit.`);
  const detail = wantObject(value, label);
  const reconciled=detail.reconciliation===true&&!label.includes('FREEZE_COMMIT');
  const allowed=reconciled?['stateEventDigest','reconciliation','operator','completedFromIntentDigest']:['stateEventDigest'];
  const unknown = Object.keys(detail).filter(key=>!allowed.includes(key));
  if (unknown.length > 0) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, `${label} carries undeclared field(s): ${unknown.join(', ')}.`);
  if (detail.reconciliation === true) {
    wantString(detail.operator, `${label}.operator`, { minLength: OPERATOR_MIN_LENGTH, maxLength: OPERATOR_MAX_LENGTH });
    if (typeof detail.completedFromIntentDigest !== 'string' || !DIGEST_PATTERN.test(detail.completedFromIntentDigest)) {
      fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, `${label} must name the intent digest it completed from.`);
    }
  }
  if (typeof detail.stateEventDigest !== 'string' || !DIGEST_PATTERN.test(detail.stateEventDigest)) {
    fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, `${label} must bind the digest of the state record it commits as stateEventDigest: a commit that names no projection is not a commit.`);
  }
  return Object.freeze({ ...clone(detail) });
}

/**
 * What the journal must already hold before this kind may be written, expressed
 * as the complete valid next-event order. The order is the whole shape of a run:
 * a start opens it, a commit completes the operation its intent opened, a stop
 * is one attested observation, and a freeze closes the run. A kind whose
 * authority is absent has no business being appended, so this is the place where
 * a callback is stopped from skipping an intent, repeating an observation, or
 * opening an operation it never declared.
 */
function validateEventAuthority({ kind, events, counts, state, detail = null }) {
 if(!validJournalPrefix([...events,{kind}]))fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,'append refuses an illegal journal state transition');
  switch (kind) {
    case 'START_INTENT': {
      if (counts.START_INTENT > 0) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'the journal already carries this run start intent; a start is opened once, so a second start intent is refused.');
      if (state !== LIFECYCLE_DERIVED_STATE) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, `a start intent may only open a run that reports ${LIFECYCLE_DERIVED_STATE}; this run already reports ${state}, so a fresh start intent would be an invented restart.`);
      return;
    }
    case 'START_COMMIT': {
      if (counts.START_INTENT === 0) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'a start commit may not be journaled over a run whose journal carries no start intent: the commit binds an opening that was never declared.');
      if (counts.START_COMMIT > 0) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'the journal already carries this start commit.');
      return;
    }
    case 'STOP_RECORDED': {
      if (counts.STOP_RECORDED > 0) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'the journal already carries the one attested stop of this run; a second stop observation is not recorded.');
      if (counts.START_INTENT === 0) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'a stop may not be journaled over a run whose journal carries no start intent: there is no started run to stop.');
      return;
    }
    case 'FREEZE_INTENT': {
      if (counts.FREEZE_INTENT > 0) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'the journal already carries an uncommitted freeze intent for this run.');
      if (state === 'RUNNING') fail(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a run that is still RUNNING has no freeze route, so its freeze intent is refused.');
      if (state === 'FROZEN') fail(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a frozen run is closed; no further intent is journaled over it.');
      if (events.length === 0 && state !== LIFECYCLE_DERIVED_STATE) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, `the journal of a run that reports ${state} must open with its start intent.`);
      /* The route the entry states is a claim about the run, so it is checked
       * against the run the journal describes. A stated `true` is the operator's
       * statement that nothing ran while no time was observed, which belongs to the
       * derived state alone; a stated `false` is a freeze over a journaled stop,
       * which a run that never started does not have. The same two routes are
       * checked the same way when the projection is committed, so an intent cannot
       * be written past the state it will later be refused for committing. */
      if (detail !== null) {
        if (detail.clockless === true && state !== LIFECYCLE_DERIVED_STATE) {
          fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, `a freeze intent that states the clockless route belongs to a run that reports ${JSON.stringify(LIFECYCLE_DERIVED_STATE)}, while this run reports ${JSON.stringify(state)}: a run that did start cannot be attested into having never run.`);
        }
        if (detail.clockless === false && state === LIFECYCLE_DERIVED_STATE) {
          fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'a freeze intent that states the bound route authorises a freeze over a journaled stop, while this run reports the derived INITIALIZED state and carries no stop to freeze over: the clockless route is the one a run that never started has.');
        }
      }
      return;
    }
    case 'FREEZE_COMMIT': {
      if (counts.FREEZE_INTENT === 0) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'a freeze commit may not be journaled over a run whose journal carries no freeze intent.');
      if (counts.FREEZE_COMMIT > 0) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'the journal already carries this freeze commit.');
      return;
    }
    default:
      return;
  }
}

/* -------------------------------------------------------------------------- */
/* The persisted state projection, validated before it is reported or used     */
/* -------------------------------------------------------------------------- */

/** The field set the state schema describes; an extra field is not a record. */
const STATE_RECORD_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'module', 'runId', 'manifestId', 'manifestDigest', 'state',
  'declaration', 'startedAt', 'stoppedAt', 'elapsedMs', 'stopAssurance', 'stopAttestation',
  'clockError', 'journalCommitAt', 'history', 'hashAlgorithm', SELF_STATE_FIELD,
]);

const STATE_RECORD_STATES = Object.freeze([...LIFECYCLE_COMMITTED_STATES]);

/**
 * Validate a state record that was read out of storage before anything reports
 * it or drives a decision from it.
 *
 * The accepted storage seam proves the envelope: that the bytes under this path
 * carry this kind and id and match their stored digest. That is not a statement
 * about the lifecycle document inside it. An envelope can therefore hold a
 * record of some other shape, of another run, or of this run with a field value
 * nothing produced, and the record can recompute its own self digest while
 * asserting facts no writer ever authored — an external rewrite recomputes the
 * self digest as a matter of course. So the fields, the identity binding and the
 * self digest are checked here, at the only place a projection is read, and a
 * record that fails them is refused rather than reported.
 *
 * A refusal here is the report of a corrupt projection. It is not a repair: the
 * bytes stay exactly where they were found.
 */
/**
 * The report raised when a stored projection fails its own integrity check. The
 * shape and identity of a record are stated through
 * `LIFECYCLE_STATE_CONTRACT_REFUSED`, which the caller's accepted contract
 * validator raises on a payload whose shape, schema version, kind or run and
 * manifest binding is not the one this path describes. The module's own
 * recomputation — the state digest that is not what the read bytes produce —
 * gets the same report with its own message.
 */

// Builtin-only operational contract evaluator. This is the checked schema itself,
// not a second abbreviated list of fields that can drift from nested domains.
const stateSchema = JSON.parse(fs.readFileSync(new URL('../../schemas/lifecycle.schema.json', import.meta.url), 'utf8'));
function schemaAccepts(value, rule, root = stateSchema) {
 if(rule.$ref){const r=rule.$ref.slice(2).split('/').reduce((a,k)=>a[k],root);return schemaAccepts(value,r,root);}
 if(Object.hasOwn(rule,'const')&&canonicalJson(value)!==canonicalJson(rule.const))return false;
 if(rule.enum&&!rule.enum.some(x=>canonicalJson(x)===canonicalJson(value)))return false;
 if(rule.type){const types=Array.isArray(rule.type)?rule.type:[rule.type];if(!types.some(t=>t==='null'?value===null:t==='object'?isObject(value):t==='array'?Array.isArray(value):t==='integer'?Number.isSafeInteger(value):t==='number'?typeof value==='number'&&Number.isFinite(value):typeof value===t))return false;}
 if(rule.oneOf&&rule.oneOf.filter(r=>schemaAccepts(value,r,root)).length!==1)return false;
 if(rule.anyOf&&!rule.anyOf.some(r=>schemaAccepts(value,r,root)))return false;
 if(rule.allOf&&!rule.allOf.every(r=>schemaAccepts(value,r,root)))return false;
 if(rule.if&&schemaAccepts(value,rule.if,root)&&rule.then&&!schemaAccepts(value,rule.then,root))return false;
 if(typeof value==='string'){if(rule.minLength!==undefined&&value.length<rule.minLength||rule.maxLength!==undefined&&value.length>rule.maxLength||rule.pattern&&!new RegExp(rule.pattern).test(value))return false;}
 if(typeof value==='number'){if(rule.minimum!==undefined&&value<rule.minimum||rule.maximum!==undefined&&value>rule.maximum)return false;}
 if(Array.isArray(value)){if(rule.minItems!==undefined&&value.length<rule.minItems||rule.maxItems!==undefined&&value.length>rule.maxItems)return false;if(rule.items&&!value.every(x=>schemaAccepts(x,rule.items,root)))return false;}
 if(isObject(value)){if(rule.required?.some(k=>!Object.hasOwn(value,k)))return false;for(const k of Object.keys(value)){if(rule.properties?.[k]){if(!schemaAccepts(value[k],rule.properties[k],root))return false;}else if(rule.additionalProperties===false)return false;}}
 return true;
}
function assertCompleteState(record,manifest){
 if(!record)return;
 if(!schemaAccepts(record,stateSchema))throw stateContractRefusal('nested lifecycle schema/domain validation failed');
 if(record.manifestDigest!==(manifest.manifestDigest??null))throw stateContractRefusal('manifestDigest does not bind the sealed run manifest');
 for(const field of ['startedAt','stoppedAt','journalCommitAt'])if(record[field]!==null)parseIso(record[field],field);
 if(record.declaration){if(canonicalJson(validateDeclaration(record.declaration))!==canonicalJson(record.declaration))throw stateContractRefusal('declaration is not a complete normalized value');bindDeclaration(record.declaration,manifest);}
 if(record.stopAttestation){const {clockless,...stop}=record.stopAttestation;const normal=validateStopAttestation(stop);if(canonicalJson(normal)!==canonicalJson(stop))throw stateContractRefusal('stop attestation is not complete and normalized');if(clockless!==undefined&&clockless!==true)throw stateContractRefusal('invalid clockless attestation');}
 if(record.clockError&&(record.clockError.code!==LIFECYCLE_ERROR_CODES.CLOCK_INVALID||record.elapsedMs!==null))throw stateContractRefusal('clock-error contract requires unavailable elapsed');
 for(const entry of record.history){parseIso(entry.at,'history.at');for(const key of Object.keys(entry))if(/Digest$/.test(key)&&!DIGEST_PATTERN.test(entry[key]))throw stateContractRefusal('history contains a malformed digest claim');}
 if(record.startedAt!==null&&record.stoppedAt!==null&&record.clockError===null&&record.elapsedMs!==null&&record.elapsedMs!==elapsedBetween(record.startedAt,record.stoppedAt))throw stateContractRefusal('elapsedMs does not match recorded instants');
}
function assertAuthoredState(record,journal,verification){
 if(!record)return;
 const events=journal.events.map(e=>e.event),start=events.find(e=>e.kind==='START_INTENT'),stop=events.find(e=>e.kind==='STOP_RECORDED'),freeze=events.find(e=>e.kind==='FREEZE_INTENT');
 const refuse=m=>{throw stateContractRefusal(m);};
 if(record.declaration&&(!start||canonicalJson(start.declaration)!==canonicalJson(record.declaration)))refuse('projection declaration differs from journal authority');
 if(start&&record.startedAt!==start.occurredAt&&start.occurredAt!==null)refuse('projection start instant differs from journal authority');
 if(record.state==='STOP_RECORDED'||record.state==='FROZEN'&&!record.stopAttestation?.clockless){if(!stop)refuse('projection stop has no journal authority');const d=stop.detail;if(canonicalJson(record.stopAttestation)!==canonicalJson({operator:d.operator,agentStopped:d.agentStopped,statement:d.statement,observedAt:d.observedAt}))refuse('projection attestation differs from journal authority');if(record.stoppedAt!==stop.occurredAt)refuse('projection stop instant differs from journal authority');}
 if(record.state==='FROZEN'){if(!freeze)refuse('projection freeze has no intent authority');const d=freeze.detail;if(d.clockless!==(record.stopAttestation?.clockless===true))refuse('freeze route differs from intent');if(d.operator!==record.stopAttestation.operator||d.statement!==record.stopAttestation.statement||d.observedAt!==record.stopAttestation.observedAt)refuse('freeze attestation differs from intent');}
 for(const h of record.history){for(const k of ['intentEventDigest','stopEventDigest','completedFromIntentDigest','freezeIntentEventDigest'])if(h[k]&&!events.some(e=>e.eventDigest===h[k]))refuse('history event binding is not journaled');}
 const startCommit=events.find(e=>e.kind==='START_COMMIT');
 if(startCommit&&record.state==='RUNNING'){
  const history=record.history.filter(h=>h.operation==='START'||h.operation==='RECONCILE');
  const candidates=[null,record.clockError].flatMap(clockError=>[startCommit.journalCommitAt,start.journalCommitAt,null].map(journalCommitAt=>buildState({manifest:{runId:record.runId,manifestId:record.manifestId,manifestDigest:record.manifestDigest},state:'RUNNING',declaration:start.declaration,startedAt:record.startedAt,stoppedAt:null,elapsedMs:null,stopAssurance:null,stopAttestation:null,clockError,journalCommitAt,history})));
  if(!candidates.some(candidate=>candidate.stateDigest===startCommit.detail.stateEventDigest))refuse('start commit does not bind the authored RUNNING projection');
 }
 const commit=events.findLast(e=>e.kind==='FREEZE_COMMIT');if(commit&&commit.detail.stateEventDigest!==record.stateDigest)refuse('freeze commit differs from projection digest');
}


const eventSchema=JSON.parse(fs.readFileSync(new URL('../../schemas/run-event.schema.json',import.meta.url),'utf8'));
const journalRoutes=[['START_INTENT','START_COMMIT','STOP_RECORDED','FREEZE_INTENT','FREEZE_COMMIT'],['FREEZE_INTENT','FREEZE_COMMIT']];
function validJournalPrefix(events){return journalRoutes.some(route=>events.length<=route.length&&events.every((entry,i)=>(entry.event??entry).kind===route[i]));}
function assertEventContract(event){
 if(event.kind==='START_INTENT'&&Object.hasOwn(event,'detail'))fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,'START_INTENT defines no detail payload');
 if(!schemaAccepts(event,eventSchema,eventSchema))fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,'persisted event fails complete operational event schema');
 for(const key of ['occurredAt','journalCommitAt'])if(event[key]!==null)parseIso(event[key],key);
 if(event.declaration&&canonicalJson(validateDeclaration(event.declaration))!==canonicalJson(event.declaration))fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,'event declaration is incomplete');
 if(event.kind==='STOP_RECORDED')validateStopDetail(event.detail);
 if(event.kind==='FREEZE_INTENT')validateFreezeIntentDetail(event.detail);
 if(event.kind==='START_COMMIT'||event.kind==='FREEZE_COMMIT')validateCommitDetail(event.detail,{label:event.kind});
}
function assertJournalContracts(journal,verification){if(verification.findings.some(f=>/event contract|legal journal|commit authority|route authority/.test(f)))fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,'journal event contract or legal sequence refuses this operation',{findings:verification.findings});}

function stateContractRefusal(reason) {
  return new LifecycleError(
    LIFECYCLE_ERROR_CODES.SCHEMA_VALIDATION_FAILED,
    `the lifecycle state record at this path was refused by the accepted state contract validator: ${reason}`,
  );
}

function assertStateRecordIntegrity(record, { manifestId, runId, label = 'the lifecycle state record' }) {
  if (record === null || record === void 0) return null;
  const refuse = (reason) => { throw stateContractRefusal(reason); };
  if (!isObject(record)) {
    refuse(`${label} is not a lifecycle state record: the value read from storage is ${describe(record)}`);
  }
  const missing = STATE_RECORD_FIELDS.filter((field) => !Object.hasOwn(record, field));
  if (missing.length > 0) {
    refuse(`${label} is missing the field(s) ${missing.join(', ')} the lifecycle state contract describes`);
  }
  const unexpected = Object.keys(record).filter((field) => !STATE_RECORD_FIELDS.includes(field));
  if (unexpected.length > 0) {
    refuse(`${label} carries the undeclared field(s) ${unexpected.join(', ')}: a record with fields no contract describes is not a record this module may act on`);
  }
  if (record.schemaVersion !== LIFECYCLE_SCHEMA_VERSION) {
    refuse(`${label} states schemaVersion ${JSON.stringify(record.schemaVersion)}, not the ${JSON.stringify(LIFECYCLE_SCHEMA_VERSION)} this module reads`);
  }
  if (record.kind !== LIFECYCLE_STATE_KIND) {
    refuse(`${label} states kind ${JSON.stringify(record.kind)}, not the ${JSON.stringify(LIFECYCLE_STATE_KIND)} state record this path carries: a record of another kind is not this run's state`);
  }
  if (record.module !== LIFECYCLE_MODULE_ID) {
    refuse(`${label} states module ${JSON.stringify(record.module)}, not ${JSON.stringify(LIFECYCLE_MODULE_ID)}: a projection written by another module is not read as this module's state`);
  }
  if (record.hashAlgorithm !== HASH_ALGORITHM) {
    refuse(`${label} states hashAlgorithm ${JSON.stringify(record.hashAlgorithm)}, not ${JSON.stringify(HASH_ALGORITHM)}`);
  }
  if (record.runId !== runId) {
    refuse(`${label} is bound to run ${JSON.stringify(record.runId)} while this operation names run ${JSON.stringify(runId)}: a projection of another run is not this run's state`);
  }
  if (record.manifestId !== manifestId) {
    refuse(`${label} is bound to manifest ${JSON.stringify(record.manifestId)} while this container carries ${JSON.stringify(manifestId)}`);
  }
  if (!STATE_RECORD_STATES.includes(record.state)) {
    refuse(`${label} states the state ${JSON.stringify(record.state)}, which is not one of the states this contract defines (${STATE_RECORD_STATES.join(', ')})`);
  }
  if (!Array.isArray(record.history)) {
    refuse(`${label}.history is not the array of history entries the contract describes`);
  }
  if (typeof record[SELF_STATE_FIELD] !== 'string' || !DIGEST_PATTERN.test(record[SELF_STATE_FIELD])) {
    refuse(`${label}.${SELF_STATE_FIELD} is not a 64-hex-digit digest, so the record carries no self digest to check`);
  }
  /* The self digest is the record's own claim about its bytes. It is recomputed
   * here, over the bytes that were read, exactly as the state contract states:
   * a record whose stored claim does not match the bytes it is read with has
   * been modified outside this module or was written torn. */
  const recomputed = selfDigestOf(record, SELF_STATE_FIELD);
  if (recomputed !== record[SELF_STATE_FIELD]) {
    refuse(`${label}.${SELF_STATE_FIELD} does not recompute from the bytes that were read: the projection has been modified outside the lifecycle module or was written torn, so it is refused and its bytes are preserved`);
  }
  return record;
}

/**
 * The one report a command raises when the stored projection is refused. The
 * read surface reports the state contract refusal itself, because a read is the
 * report of what was found. A command reports recovery-required over the same
 * refusal: nothing may be written on a run whose projection cannot be
 * established, the bytes are left exactly where they were found, and the reason
 * is carried along so the operator can see what failed.
 */
function corruptProjectionGuard(refusal, operation) {
  return new LifecycleError(
    LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,
    `${operation} is refused over a lifecycle projection that fails its own integrity check: ${refusal.message} The stored projection and the journal are preserved untouched; reconcile the run before writing to it.`,
    { reason: refusal.message, code: refusal.code },
  );
}

/* ========================================================================== */
/* openRun: explicit root plus expected identities                             */
/* ========================================================================== */

function requireRequestShape(request, label) {
  const value = wantObject(request, label);
  const runRoot = wantAbsolute(need(value.runRoot, `${label}.runRoot`), `${label}.runRoot`);
  const manifestId = wantString(need(value.manifestId, `${label}.manifestId`), `${label}.manifestId`, { minLength: 3, maxLength: 128, pattern: ID_PATTERN });
  const runId = wantString(need(value.runId, `${label}.runId`), `${label}.runId`, { minLength: 3, maxLength: 128, pattern: RUN_ID_PATTERN });
  const expectedDigest = wantStringOrNull(value.expectedDigest, `${label}.expectedDigest`);
  if (expectedDigest !== null && !DIGEST_PATTERN.test(expectedDigest)) {
    fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `${label}.expectedDigest must be a 64-hex-digit digest when supplied.`);
  }
  const operationName = wantString(value.operationName, `${label}.operationName`, { maxLength: 128 }) ?? label;
  return Object.freeze({ runRoot, manifestId, runId, expectedDigest, operationName });
}

/** True only for a real ordinary directory that is not a link. */
async function isOrdinaryDirectory(candidate) {
  try {
    const st = await fs.promises.lstat(candidate);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

async function isOrdinaryFile(candidate) {
  try {
    const st = await fs.promises.lstat(candidate);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Open one run container by its explicit absolute `runRoot` plus the expected
 * `manifestId` and `runId`, and verify it against the accepted sealed
 * RunManifest.
 *
 * The candidate state root follows the accepted container convention
 * (`<runRoot>/<state directory>`); it is not trusted because it is derived —
 * the read-back manifest must name that same root, otherwise the container is
 * rejected as substituted or foreign. An optional `expectedDigest` binds the
 * caller to one exact sealed manifest.
 *
 * @param {{runRoot:string, manifestId:string, runId:string, expectedDigest?:string|null, operationName?:string}} request
 * @returns {Promise<{manifest:object, storage:object, workspaceRoot:string, stateRoot:string, runRoot:string, runId:string, manifestId:string, manifestDigest:string|null}>}
 */
export async function openRun(request) {
  const opened = requireRequestShape(request, 'the run request');
  let container;
  try {
    container = await fs.promises.lstat(opened.runRoot);
  } catch (error) {
    throw new LifecycleError(LIFECYCLE_ERROR_CODES.INVALID_ROOT, `the run root ${JSON.stringify(opened.runRoot)} could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!container.isDirectory() || container.isSymbolicLink()) {
    fail(LIFECYCLE_ERROR_CODES.INVALID_ROOT, `the run root ${JSON.stringify(opened.runRoot)} is not an ordinary directory.`);
  }

  const stateRoot = path.resolve(opened.runRoot, STATE_DIRECTORY_NAME);
  if (!(await isOrdinaryDirectory(stateRoot))) {
    fail(LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, `the run root ${JSON.stringify(opened.runRoot)} does not carry an ordinary ${STATE_DIRECTORY_NAME}/ state container; this is not an initialised run container.`);
  }
  /* The state container must sit strictly inside the run root: a state name
   * that resolved outside it (a traversal-shaped or absolute value) is refused. */
  if (!pathIsWithin(opened.runRoot, stateRoot)) {
    fail(LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, 'the state container does not live inside the run root.');
  }

  let storage;
  try {
    storage = createStorage({ root: stateRoot });
  } catch (error) {
    throw storageRefusal(error);
  }

  let manifest;
  try {
    manifest = await storage.read({ ...RUN_MANIFEST_STATE_KEY, id: opened.manifestId });
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : undefined;
    if (code === 'ERR_STORAGE_NOT_FOUND') {
      throw new LifecycleError(LIFECYCLE_ERROR_CODES.NOT_FOUND, `no sealed run record is bound to manifestId ${JSON.stringify(opened.manifestId)} at ${JSON.stringify(stateRoot)}.`, { storageCode: code });
    }
    /* The accepted seam refuses a record whose bound identity is not the one
     * requested. That is the read-back proving the container does not hold the
     * run the caller named, so it is reported as a provenance refusal with the
     * names the caller can act on, not as an opaque storage fault. */
    if (code === 'ERR_STORAGE_IDENTITY_MISMATCH') {
      throw new LifecycleError(LIFECYCLE_ERROR_CODES.NOT_FOUND, `the run container holds no record bound to ${JSON.stringify(RUN_MANIFEST_STATE_KEY.kind)} for manifestId ${JSON.stringify(opened.manifestId)}: the record at that key carries ${JSON.stringify(error?.details?.envelopeId ?? 'another identity')}.`, { storageCode: code, expectedIdentity: `${RUN_MANIFEST_STATE_KEY.kind}/${opened.manifestId}`, foundIdentity: error?.details?.envelopeId ?? null });
    }
    throw storageRefusal(error);
  }

  verifyManifest(manifest, opened, stateRoot);
  const workspaceRoot = path.resolve(manifest.participantWorkspaceRoot);
  const actualStateRoot = path.resolve(manifest.evidenceRoot);
  if (actualStateRoot !== path.resolve(stateRoot)) {
    fail(LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, `the sealed manifest binds its state root to ${JSON.stringify(actualStateRoot)} while the container opened at ${JSON.stringify(stateRoot)}: a copied or aliased container is refused.`);
  }
  if (!pathIsWithin(opened.runRoot, workspaceRoot)) {
    fail(LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, `the sealed manifest binds the participant workspace to ${JSON.stringify(workspaceRoot)}, which is not inside the opened run root ${JSON.stringify(opened.runRoot)}.`);
  }
  if (!(await isOrdinaryDirectory(workspaceRoot))) {
    fail(LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, `the bound participant workspace ${JSON.stringify(workspaceRoot)} is not an ordinary directory.`);
  }
  try {
    assertDisjointRoots([
      { label: 'participantWorkspaceRoot', path: workspaceRoot },
      { label: 'stateRoot', path: stateRoot },
    ]);
  } catch (error) {
    throw new LifecycleError(LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, `the accepted path boundary refuses this root pairing: ${error instanceof Error ? error.message : String(error)}`);
  }
  /* Reject a link-aliased state record path before any write. */
  if (!(await isOrdinaryFile(path.join(stateRoot, RUN_MANIFEST_STATE_KEY.relativePath)))) {
    fail(LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, 'the sealed run record is not an ordinary file inside the state container.');
  }
  try {
    resolveWithinRoot({ root: stateRoot, relativePath: RUN_MANIFEST_STATE_KEY.relativePath });
  } catch (error) {
    throw storageRefusal(error);
  }

  return Object.freeze({
    runRoot: opened.runRoot,
    stateRoot,
    workspaceRoot,
    runId: opened.runId,
    manifestId: opened.manifestId,
    manifestDigest: manifest.manifestDigest ?? null,
    manifest: Object.freeze(clone(manifest)),
    operationName: opened.operationName,
  });
}

function verifyManifest(manifest, opened, stateRoot) {
  if (!isObject(manifest) || manifest.kind !== 'RunManifest') {
    fail(LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, 'the state run record does not carry a RunManifest value.');
  }
  try {
    validateRecord('RunManifest', manifest);
  } catch (error) {
    throw new LifecycleError(LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, `the persisted run record was refused by the accepted contract validator: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.manifestId !== opened.manifestId) {
    fail(LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, `the record at that key carries manifestId ${JSON.stringify(manifest.manifestId)} while the caller expects ${JSON.stringify(opened.manifestId)}.`);
  }
  if (manifest.runId !== opened.runId) {
    fail(LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, `the record binds runId ${JSON.stringify(manifest.runId)} while the caller expects ${JSON.stringify(opened.runId)}.`);
  }
  if (opened.expectedDigest !== null && manifest.manifestDigest !== opened.expectedDigest) {
    fail(LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, `the record carries manifestDigest ${JSON.stringify(manifest.manifestDigest)} while the caller expects ${JSON.stringify(opened.expectedDigest)}.`);
  }
  if (manifest.harness !== 'manual') {
    fail(LIFECYCLE_ERROR_CODES.PROVENANCE_MISMATCH, `the manual lifecycle seam serves the manual harness; this manifest binds harness ${JSON.stringify(manifest.harness)}.`);
  }
  void stateRoot;
}

function pathIsWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function storageRefusal(error) {
  if (error instanceof LifecycleError) return error;
  const code = error && typeof error.code === 'string' ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'ERR_STORAGE_NOT_FOUND') return new LifecycleError(LIFECYCLE_ERROR_CODES.NOT_FOUND, `the run container does not carry the record: ${message}`, { storageCode: code });
  return new LifecycleError(LIFECYCLE_ERROR_CODES.STORAGE_REFUSED, `the accepted storage seam refused the run operation: ${message}`, { storageCode: code });
}

/* ========================================================================== */
/* Journal and record I/O                                                      */
/* ========================================================================== */

function stateIdOf(manifestId) {
  return `${manifestId}:lifecycle-state`;
}

function eventIdOf(manifestId, sequence) {
  return `${manifestId}:event:${String(sequence).padStart(5, '0')}`;
}

function eventPathOf(sequence) {
  return `${LIFECYCLE_JOURNAL_DIRECTORY}/${String(sequence).padStart(5, '0')}.json`;
}

async function readStateRecord(storage, manifestId, runId) {
  let record;
  try {
    record = await storage.read({ relativePath: LIFECYCLE_STATE_RELATIVE_PATH, kind: LIFECYCLE_STATE_KIND, id: stateIdOf(manifestId) });
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : undefined;
    if (code === 'ERR_STORAGE_NOT_FOUND') return null;
    throw storageRefusal(error);
  }
  /* The record is validated here, at the one place a projection is read, so no
   * caller can report it or decide from it before it has been checked. See
   * `assertStateRecordIntegrity` for what the accepted envelope does and does
   * not prove. */
  const checked=assertStateRecordIntegrity(record,{manifestId,runId});
  const manifest=await storage.read({...RUN_MANIFEST_STATE_KEY,id:manifestId});
  try{assertCompleteState(checked,manifest);}catch(error){if(error instanceof LifecycleError&&error.code===LIFECYCLE_ERROR_CODES.SCHEMA_VALIDATION_FAILED)throw error;throw stateContractRefusal(error.message);}
  return checked;
}

async function listJournal(storage) {
  let root;
  try {
    root = storage.root;
  } catch {
    fail(LIFECYCLE_ERROR_CODES.STORAGE_REFUSED, 'the storage container does not report its root.');
  }
  const directory = path.join(root, LIFECYCLE_JOURNAL_DIRECTORY);
  const entries = [];
  const foreign = [];
  let directoryListed = false;
  try {
    const names = await fs.promises.readdir(directory);
    directoryListed = true;
    for (const name of names) {
      const match = /^([0-9]{5})\.json$/.exec(name);
      if (match === null) {
        foreign.push(name);
        continue;
      }
      entries.push({ sequence: Number(match[1]), relativePath: `${LIFECYCLE_JOURNAL_DIRECTORY}/${name}` });
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw storageRefusal(error);
  }
  entries.sort((left, right) => left.sequence - right.sequence);
  if (entries.length > MAX_JOURNAL_EVENTS) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, `the journal carries ${String(entries.length)} entries, above the contract bound of ${String(MAX_JOURNAL_EVENTS)}.`);
  return { entries, foreign, directoryListed };
}

async function readJournal(storage, manifestId) {
  const listed = await listJournal(storage);
  const events = [];
  const unreadable = [];
  for (const entry of listed.entries) {
    try {
      const value = await storage.read({ relativePath: entry.relativePath, kind: LIFECYCLE_EVENT_KIND, id: eventIdOf(manifestId, entry.sequence) });
      events.push({ sequence: entry.sequence, event: value });
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : undefined;
      /* A journal entry that cannot be read back under its bound identity is
       * a finding about the journal, not a reason to fail the whole read: a
       * corrupt, digest-mismatched, foreign-identity or missing entry must be
       * reported so an operator can see what the journal states. */
      unreadable.push({
        sequence: entry.sequence,
        reason: code === 'ERR_STORAGE_NOT_FOUND'
          ? 'the journal file is not readable back under its bound identity'
          : `the journal entry was refused by the accepted storage read (${String(code ?? 'unknown')})`,
      });
      continue;
    }
  }
  return { events, unreadable, foreign: listed.foreign, directoryListed: listed.directoryListed };
}

/**
 * Verify the append-only journal against itself. This is the hash-chain check
 * that makes a missing, duplicated, reordered or externally modified entry a
 * refusal rather than a state the lifecycle will keep operating on:
 *  - contiguous sequence starting at zero;
 *  - every event bound to this run and manifest;
 *  - every event digest recomputed from its own bytes;
 *  - every event after the first naming the digest of its immediate predecessor.
 */
function verifyJournal(journal, manifest) {
  const findings = [];
  if(!validJournalPrefix(journal.events))findings.push('legal journal sequence violates the lifecycle state machine');
  for(const {sequence,event}of journal.events){try{assertEventContract(event);}catch(error){findings.push('event contract '+sequence+': '+error.message);}}
  for(const {event}of journal.events){if(event?.kind==='START_COMMIT'&&event.detail?.completedFromIntentDigest&&event.detail.completedFromIntentDigest!==journal.events[0]?.event?.eventDigest)findings.push('commit authority does not bind start intent');if(event?.kind==='FREEZE_INTENT'){const clockless=journal.events[0]?.event?.kind==='FREEZE_INTENT';if(event.detail?.clockless!==clockless)findings.push('route authority contradicts journal start/stop sequence');}}
  for (const entry of journal.unreadable) findings.push(`journal entry ${String(entry.sequence)}: ${entry.reason}`);
  for (const name of journal.foreign) findings.push(`the journal directory carries a foreign entry ${JSON.stringify(name)}`);

  let expected = 0;
  let previousDigest = null;
  const counts = {};
  for (const kind of LIFECYCLE_EVENT_KINDS) counts[kind] = 0;

  for (const { sequence, event } of journal.events) {
    if (sequence !== expected) {
      findings.push(`journal sequence break: expected ${String(expected)}, found ${String(sequence)}`);
      expected = sequence;
    }
    expected = sequence + 1;
    if (!isObject(event)) {
      findings.push(`journal entry ${String(sequence)} does not carry an event object`);
      previousDigest = null;
      continue;
    }
    if (event.manifestId !== manifest.manifestId || event.runId !== manifest.runId) {
      findings.push(`journal entry ${String(sequence)} is bound to a different run or manifest`);
    }
    if (event.sequence !== sequence) {
      findings.push(`journal entry ${String(sequence)} states sequence ${String(event.sequence)} in its own bytes`);
    }
    if (typeof event.eventDigest !== 'string' || selfDigestOf(event, SELF_EVENT_FIELD) !== event.eventDigest) {
      findings.push(`journal entry ${String(sequence)} fails its recomputed digest check: external modification or a torn write`);
    }
    if (sequence === 0) {
      if (event.previousEventDigest !== null) findings.push(`journal entry 0 must carry previousEventDigest null`);
      if (event.kind !== 'START_INTENT' && event.kind !== 'FREEZE_INTENT') findings.push('the journal does not begin with a START_INTENT or a FREEZE_INTENT event');
    } else {
      if (typeof event.previousEventDigest !== 'string' || event.previousEventDigest.length !== 64) {
        findings.push(`journal entry ${String(sequence)} carries no digest binding to its immediate predecessor: the hash chain is broken`);
      } else if (previousDigest === null || event.previousEventDigest !== previousDigest) {
        findings.push(`journal entry ${String(sequence)} names a predecessor digest that is not the digest of entry ${String(sequence - 1)}`);
      }
    }
    if (!LIFECYCLE_EVENT_KINDS.includes(event.kind)) findings.push(`journal entry ${String(sequence)} carries the unknown kind ${JSON.stringify(event.kind)}`);
    else counts[event.kind] += 1;
    previousDigest = typeof event.eventDigest === 'string' ? event.eventDigest : null;
  }

  if (counts.START_INTENT > 1) findings.push('the journal carries more than one START_INTENT event');
  if (counts.START_COMMIT > 1) findings.push('the journal carries more than one START_COMMIT event');
  if (counts.STOP_RECORDED > 1) findings.push('the journal carries more than one STOP_RECORDED event: an operator stop is a single observation');
  if (counts.FREEZE_INTENT > 1) findings.push('the journal carries more than one FREEZE_INTENT event');
  if (counts.FREEZE_COMMIT > 1) findings.push('the journal carries more than one FREEZE_COMMIT event');
  if (counts.FREEZE_COMMIT > 0 && counts.FREEZE_INTENT === 0) findings.push('the journal carries a FREEZE_COMMIT event without any FREEZE_INTENT event');
  if (counts.FREEZE_INTENT > 0 && journal.events.some(({ event }) => event?.kind === 'FREEZE_INTENT') && journal.events[0]?.event?.kind === 'FREEZE_INTENT' && (counts.START_INTENT > 0 || counts.START_COMMIT > 0 || counts.STOP_RECORDED > 0)) {
    findings.push('a journal that begins with a clockless FREEZE_INTENT carries no start or stop events: a run frozen without ever starting has nothing to start');
  }
  if (counts.START_COMMIT > 0 && counts.START_INTENT === 0) findings.push('the journal carries a START_COMMIT event without any START_INTENT event');
  if (journal.events.length >= 2 && journal.events[1].event?.kind === 'START_COMMIT') {
    const intent = journal.events[0]?.event;
    if (isObject(intent) && isObject(journal.events[1].event) && canonicalJson(intent.declaration) !== canonicalJson(journal.events[1].event.declaration)) {
      findings.push('event contract: the START_COMMIT event states a declaration that is not the one captured by the START_INTENT event');
    }
  }
  return { findings, counts };
}

function buildEvent({ manifest, sequence, kind, occurredAt, journalCommitAt, declaration, previousEventDigest, detail }) {
  const event = {
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    kind,
    runId: manifest.runId,
    manifestId: manifest.manifestId,
    sequence,
    previousEventDigest,
    occurredAt,
    journalCommitAt,
    hashAlgorithm: HASH_ALGORITHM,
    [SELF_EVENT_FIELD]: '',
  };
  if (declaration !== undefined && declaration !== null) event.declaration = clone(declaration);
  if (detail !== undefined) event.detail = clone(detail);
  event[SELF_EVENT_FIELD] = selfDigestOf(event, SELF_EVENT_FIELD);
  return event;
}

function buildState({ manifest, state, declaration, startedAt, stoppedAt, stopAssurance, stopAttestation, clockError, journalCommitAt, elapsedMs, history }) {
  const record = {
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    kind: LIFECYCLE_STATE_KIND,
    module: LIFECYCLE_MODULE_ID,
    runId: manifest.runId,
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest ?? null,
    state,
    declaration: declaration === undefined ? null : clone(declaration),
    startedAt: startedAt ?? null,
    stoppedAt: stoppedAt ?? null,
    elapsedMs: elapsedMs === undefined ? null : elapsedMs,
    stopAssurance: stopAssurance ?? null,
    stopAttestation: stopAttestation === undefined ? null : clone(stopAttestation),
    clockError: clockError === undefined ? null : clone(clockError),
    journalCommitAt: journalCommitAt ?? null,
    history: Object.freeze((history ?? []).map((entry) => Object.freeze(clone(entry)))),
    hashAlgorithm: HASH_ALGORITHM,
    [SELF_STATE_FIELD]: '',
  };
  record[SELF_STATE_FIELD] = selfDigestOf(record, SELF_STATE_FIELD);
  return record;
}

/* ========================================================================== */
/* The checked write seams (what a transaction callback gets)                  */
/* ========================================================================== */

async function publishEvent(storage, manifest, event) {
  const relativePath = eventPathOf(event.sequence);
  const id = eventIdOf(manifest.manifestId, event.sequence);
  try {
    await storage.createImmutable({ relativePath, kind: LIFECYCLE_EVENT_KIND, id, value: event });
    const readback = await storage.read({ relativePath, kind: LIFECYCLE_EVENT_KIND, id });
    if (canonicalJson(readback) !== canonicalJson(event)) {
      fail(LIFECYCLE_ERROR_CODES.READBACK_FAILED, `journal event ${String(event.sequence)} did not read back byte-equal to what was published.`);
    }
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    throw storageRefusal(error);
  }
}

async function publishState(storage, manifest, record) {
  const id = stateIdOf(manifest.manifestId);
  try {
    await storage.replaceMutable({ relativePath: LIFECYCLE_STATE_RELATIVE_PATH, kind: LIFECYCLE_STATE_KIND, id, value: record });
    const readback = await storage.read({ relativePath: LIFECYCLE_STATE_RELATIVE_PATH, kind: LIFECYCLE_STATE_KIND, id });
    if (canonicalJson(readback) !== canonicalJson(record)) {
      fail(LIFECYCLE_ERROR_CODES.READBACK_FAILED, 'the lifecycle state record did not read back byte-equal to what was written.');
    }
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    throw storageRefusal(error);
  }
}

function validateStateTransition(fromState, toState) {
  const permitted = LIFECYCLE_TRANSITIONS[fromState] ?? LIFECYCLE_TRANSITIONS.ABSENT;
  if (!permitted.includes(toState)) {
    fail(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED,
      `the state move ${fromState} -> ${toState} is not one of the permitted moves ${permitted.length > 0 ? permitted.join(', ') : '(none: a frozen run is closed)'}.`);
  }
}

/**
 * The narrow append seam a transaction callback receives. The callback states
 * an event kind plus its own payload; the sequence, the predecessor digest
 * binding, the identity, the digests and the journal write belong to this
 * module. There is no way to state a sequence or a predecessor through it, so a
 * callback cannot invent facts or reorder the chain.
 */
function makeAppendEvent(context) {
  return async function appendEvent(eventRequest) {
    const request = wantObject(eventRequest, 'the journal append request');
    const allowed = ['kind', 'occurredAt', 'journalCommitAt', 'declaration', 'detail'];
    const unknown = Object.keys(request).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `the journal append request carries undeclared field(s): ${unknown.join(', ')}; sequence and predecessor binding are assigned by the module.`);
    const kind = wantString(need(request.kind, 'the journal append request.kind'), 'the journal append request.kind', { maxLength: 64 });
    if (!LIFECYCLE_EVENT_KINDS.includes(kind)) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `unknown journal event kind ${JSON.stringify(kind)}.`);

    const journal = await readJournal(context.storage, context.manifest.manifestId);
    const verification = verifyJournal(journal, context.manifest);
    if (verification.findings.length > 0) {
      fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'the recovery journal does not verify; no event is appended onto an unverified chain.', { findings: verification.findings });
    }
    const sequence = journal.events.length;
    const previousEventDigest = sequence === 0 ? null : journal.events[sequence - 1].event.eventDigest;
    if (sequence === 0 && kind !== 'START_INTENT' && kind !== 'FREEZE_INTENT') {
      fail(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'the first journal event of a run must be START_INTENT, or FREEZE_INTENT for a run frozen clocklessly without ever starting.');
    }
    const occurredAt = wantStringOrNull(request.occurredAt, 'the journal append request.occurredAt');
    if (occurredAt !== null) parseIso(occurredAt, 'the journal append request.occurredAt');
    const journalCommitAt = wantStringOrNull(request.journalCommitAt, 'the journal append request.journalCommitAt');
    if (journalCommitAt !== null) parseIso(journalCommitAt, 'the journal append request.journalCommitAt');
    /* The payload a kind has to carry before it may be written. This is checked
     * before the ordering rules because an entry that states no fact is refused
     * for what it is, whatever the journal looks like: a stop without its
     * operator statement, a freeze intent without an attestation or an explicit
     * clockless route, and a commit that binds no projection. */
    let detail = request.detail;
    if (kind === 'STOP_RECORDED') detail = validateStopDetail(request.detail);
    else if (kind === 'FREEZE_INTENT') detail = validateFreezeIntentDetail(request.detail);
    else if (kind === 'START_COMMIT' || kind === 'FREEZE_COMMIT') {
      detail = validateCommitDetail(request.detail, { label: `the ${kind} event detail` });
      /* A commit names the projection it commits, so what it names has to be the
       * projection this transaction is holding. A commit that binds some other
       * digest, or a digest of a projection this run does not have, is not a
       * commit of this run. */
      const bound = context.lifecycle;
      if (bound === null) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, `a ${kind} event is refused: it binds a projection while this run carries none, so there is nothing for the commit to commit.`);
      if (detail.stateEventDigest !== bound[SELF_STATE_FIELD]) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, `the ${kind} event binds stateEventDigest ${JSON.stringify(detail.stateEventDigest)} while the projection this transaction holds carries ${JSON.stringify(bound[SELF_STATE_FIELD])}: a commit that does not name the projection it commits is refused.`);
    }
    else if (kind === 'START_INTENT' && request.declaration === undefined) fail(LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, 'a START_INTENT event must carry the immutable declaration it opens the run with: the intent is the moment the declaration becomes bound, so an intent without one states no run.');
    /* The complete valid next-event order, read off the journal that just
     * verified. This is what stops a callback from skipping an intent, repeating
     * an observation, or opening an operation the journal never declared. */
    validateEventAuthority({ kind, events: journal.events, counts: verification.counts, state: currentStateOf(context.lifecycle), detail: kind === 'FREEZE_INTENT' ? detail : null });
    const event = buildEvent({
      manifest: context.manifest,
      sequence,
      kind,
      occurredAt,
      journalCommitAt,
      declaration: request.declaration,
      detail,
      previousEventDigest,
    });
    assertEventContract(event);
    const candidateJournal={...journal,events:[...journal.events,{sequence,event}]};
    const candidateVerification=verifyJournal(candidateJournal,context.manifest);
    if(candidateVerification.findings.length)fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,'candidate event fails full journal authority before publication',{findings:candidateVerification.findings});
    await publishEvent(context.storage, context.manifest, event);
    return Object.freeze(clone(event));
  };
}

/**
 * The checked state-write seam. A transaction callback names the state it is
 * moving to and the facts that justify it; this module verifies the
 * transition, the freeze precondition table and the attestation pairing before
 * it writes, and reads the record back. There is no unconditioned state write.
 */
function makeCommitState(context, onCommitted) {
  return async function commitState(stateRequest) {
    const request = wantObject(stateRequest, 'the state commit request');
    const allowed = ['state', 'declaration', 'startedAt', 'stoppedAt', 'stopAttestation', 'stopAssurance', 'elapsedMs', 'clockError', 'journalCommitAt', 'historyEntry', 'reconciliation'];
    const unknown = Object.keys(request).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `the state commit request carries undeclared field(s): ${unknown.join(', ')}.`);

    /* The from-state is what the container reports: the derived INITIALIZED
     * state while no record exists yet, otherwise the recorded state. A
     * clockless freeze from INITIALIZED therefore has its route, while a
     * still-RUNNING run has none. */
    const from = context.lifecycle === null ? LIFECYCLE_DERIVED_STATE : context.lifecycle.state;
    const to = wantString(need(request.state, 'the state commit request.state'), 'the state commit request.state', { maxLength: 32 });
    if (!LIFECYCLE_COMMITTED_STATES.includes(to)) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `the state commit request states the unknown state ${JSON.stringify(to)}.`);
    /* Reconciliation is the one declared exception to the move table: it can
     * re-record the state a half-finished command already wrote, because the
     * justification is the journaled intent rather than a new move. The flag is
     * checked against the history entry, so it is not a way around the table. */
    const reconciliation = request.reconciliation === true;
    if (reconciliation) {
      if (to !== from) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'a reconciliation commit must name the state the run already reports; a reconciliation is not a state move.');
      const entry = request.historyEntry;
      if (entry === undefined || entry === null || entry.operation !== 'RECONCILE') fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'a reconciliation commit must carry a history entry whose operation is RECONCILE.');
    } else {
      validateStateTransition(from, to);
    }

    if (to === 'FROZEN') {
      /* The single source of truth: a freeze is permitted from STOP_RECORDED
       * with the bound stop attestation, or from INITIALIZED with an explicit
       * clockless attestation. A RUNNING run has no freeze route at all. */
      const precondition = FREEZE_PRECONDITIONS[from];
      if (precondition === undefined) {
        fail(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, `a freeze from state ${from} has no defined precondition in this contract.`);
      }
      const attestation = wantObject(need(request.stopAttestation, 'the freeze attestation'), 'the freeze attestation');
      if (precondition.requires === 'BOUND_STOP_ATTESTATION') {
        /* The comparison is normalised on both sides: the attestation the run
         * stored carries the fields this module fills in, so an equivalent
         * restatement by the operator binds, while a different operator,
         * statement, stop assertion or observed instant does not. */
        const stored = context.lifecycle === null ? null : context.lifecycle.stopAttestation;
        const normalisedStored = stored === null ? null : validateStopAttestation(stored);
        const normalisedAttempted = validateStopAttestation(attestation);
        if (normalisedStored === null || canonicalJson(normalisedStored) !== canonicalJson(normalisedAttempted)) {
          fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'a freeze from STOP_RECORDED must repeat the exact stop attestation the run already carries; a freeze with an unbound or different attestation is refused.');
        }
        /* The bound attestation is the whole justification. A null recorded
         * stop instant means the clock honestly reported nothing, and the
         * freeze carries that null forward rather than being blocked until a
         * time exists that this contract is not permitted to invent. */
      } else {
        const clocklessAllowed = ['operator', 'agentStopped', 'statement', 'observedAt', 'clockless'];
        const clocklessUnknown = Object.keys(attestation).filter((key) => !clocklessAllowed.includes(key));
        if (clocklessUnknown.length > 0) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, `the clockless freeze attestation carries undeclared field(s): ${clocklessUnknown.join(', ')}.`);
        wantString(need(attestation.operator, 'the clockless freeze attestation.operator'), 'the clockless freeze attestation.operator', { minLength: OPERATOR_MIN_LENGTH, maxLength: OPERATOR_MAX_LENGTH });
        if (attestation.agentStopped !== true) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'a clockless freeze attestation must state agentStopped: true: the operator attests that no agent was left running.');
        if (attestation.clockless !== true) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'a freeze from INITIALIZED must state clockless: true: the operator attests that nothing ran while no time was observed.');
        if (request.stoppedAt !== undefined && request.stoppedAt !== null) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'a clockless freeze from INITIALIZED records no stop instant.');
      }
    }

    const history = [...(context.lifecycle === null ? [] : context.lifecycle.history)];
    if (request.historyEntry !== undefined) {
      const entry = wantObject(request.historyEntry, 'the state commit history entry');
      history.push({ at: new Date().toISOString(), ...clone(entry) });
    }

    /* A projection is the projection of something: it states facts the authority
     * has to carry. So the move is checked against the journal that is on disk
     * before the record is built, which is what stops a callback from publishing
     * a stop nobody attested in the journal or naming an authority event that
     * does not exist. The authority is read through the chain verifier: a journal
     * that does not verify against itself carries no authority at all, so a write
     * over it is refused before any of the facts below are consulted, and no raw
     * scan of unverifiable bytes is ever treated as an authority event. */
    const authority = await readJournal(context.storage, context.manifest.manifestId);
    const authorityVerification = verifyJournal(authority, context.manifest);
    if (authorityVerification.findings.length > 0) {
      fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'a state commit is refused over a journal that does not verify against itself: an unverified chain carries no authority, so no projection may be published from it.', { findings: Object.freeze([...authorityVerification.findings]) });
    }
    const authorityEvents = authority.events.map((entry) => entry.event);
    const stopEvent = authorityEvents.find((event) => event?.kind === 'STOP_RECORDED');
    const freezeIntentEvent = authorityEvents.find((event) => event?.kind === 'FREEZE_INTENT');
    if (to === 'STOP_RECORDED') {
      /* A stop is an attested observation, and the journaled entry is the written
       * record of it. So a projection that states STOP_RECORDED needs the journaled
       * stop itself, unconditionally — not merely the absence of a contradiction.
       * The comparison is on the normalised journaled form, so the operator, the
       * attested fact, the statement and the witnessed instant all have to be the
       * ones the entry recorded. */
      const stated = request.stopAttestation !== undefined ? request.stopAttestation : (context.lifecycle === null ? null : context.lifecycle.stopAttestation);
      if (stated === null || stated === void 0) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'a projection that states STOP_RECORDED must carry the operator attestation of that stop: a stop is an attested observation, so a projection cannot state one from a field set alone.');
      if (stopEvent === void 0) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'a projection that states STOP_RECORDED is refused: the journal carries no STOP_RECORDED event, so the projection would state an attested observation the authority does not record.');
      const journaled = validateStopDetail(stopEvent.detail);
      const bound = validateStopAttestation(stated);
      const journaledInstant = journaled.observedAt ?? null;
      const boundInstant = bound.observedAt ?? null;
      if (journaled.operator !== bound.operator || journaled.statement !== bound.statement || journaledInstant !== boundInstant) {
        fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'a projection that states STOP_RECORDED must carry the attestation the journaled stop recorded: a projection restating a different operator, statement or witnessed instant than the STOP_RECORDED entry is not the projection of that stop.');
      }
    }
    if (to === 'RUNNING') {
      /* A projection that reports RUNNING is the projection of a declared start,
       * so the declaration has to be on it and the journal has to carry the
       * intent that bound that declaration. This is the start-side half of the
       * rule that stops a projection from stating an operation no authority
       * recorded. */
      const intentEvent = authorityEvents.find((event) => event?.kind === 'START_INTENT');
      if (intentEvent === void 0) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'a projection that reports RUNNING is refused: the journal carries no START_INTENT event, so the run would report a start that was never declared.');
      const stated = request.declaration !== undefined ? request.declaration : (context.lifecycle === null ? null : context.lifecycle.declaration);
      if (stated === null || stated === void 0) fail(LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, 'a projection that reports RUNNING must carry the immutable declaration its start intent bound.');
      if (canonicalJson(stated) !== canonicalJson(intentEvent.declaration)) fail(LIFECYCLE_ERROR_CODES.DECLARATION_INVALID, 'a projection that reports RUNNING states a declaration that is not the one the journaled START_INTENT bound: the declaration is captured once, with the intent, and a projection cannot restate it.');
    }
    if (to === 'FROZEN') {
      /* The freeze is the operation this contract closes a run with, so it is the
       * operation with the least room for a projection to state on its own
       * authority. Both routes are gated: the bound route from STOP_RECORDED and
       * the clockless route from the derived state each have to find their
       * journaled FREEZE_INTENT carrying the very attestation the projection
       * binds. A frozen projection that no intent authored is a fabricated
       * submission, which is the claim this whole contract exists to prevent, so
       * there is no route to it and no exception from it. */
      /* The attestation the freeze binds is normalised on its attested fields:
       * `clockless` states which route the freeze takes and is checked against
       * the journal below, so it is not part of the fact being compared. */
      const statedFreeze = request.stopAttestation !== undefined ? request.stopAttestation : (context.lifecycle === null ? null : context.lifecycle.stopAttestation);
      const statedRecord = wantObject(statedFreeze, 'the freeze attestation');
      const bound = validateStopAttestation({ operator: statedRecord.operator, agentStopped: statedRecord.agentStopped, statement: statedRecord.statement, observedAt: statedRecord.observedAt });
      if (freezeIntentEvent === void 0) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, `a projection that states FROZEN from ${from} is refused: the journal carries no FREEZE_INTENT event, so the freeze it reports was never authorised. A freeze is journaled as an intent before it is committed, and a projection is not a substitute for that entry.`);
      const journaled = validateFreezeIntentDetail(freezeIntentEvent.detail);
      /* The fact the intent authorises the freeze with is the operator and the
       * attested statement. The witnessed instant is not compared here: the intent
       * states the instant the freeze operation itself witnessed, while the bound
       * route's stop instant is bound against the journaled stop below. Insisting
       * the two were one value would bind a fact no attestation claims. */
      if (journaled.operator !== bound.operator || journaled.statement !== bound.statement) {
        fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'a freeze must bind the attestation its journaled freeze intent carried: the intent and the freeze attestation state a different operator or statement.');
      }
      /* The route the intent states is the route the freeze takes, and the two
       * routes are not interchangeable. A clockless intent is the operator's
       * explicit statement that nothing ran while no time was observed, so it
       * belongs to the clockless route from the derived state alone; a run that
       * did start cannot be attested afterwards into never having run. */
      const intentIsClockless = journaled.clockless === true;
      if (intentIsClockless && from !== LIFECYCLE_DERIVED_STATE) {
        fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, `a run that reports ${from} freezes over its journaled stop, while its journaled freeze intent states the clockless route: a run that did start cannot be attested into having never run.`);
      }
      if (!intentIsClockless && from === LIFECYCLE_DERIVED_STATE) {
        fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'a freeze from the derived INITIALIZED state is the clockless route, so its journaled freeze intent has to state that route: an intent that names no clockless route over a run that never started states an authority that does not exist.');
      }
      /* On the bound route the freeze rests on a journaled stop as well as on its
       * own intent, so the stop has to be there and has to be the one the freeze
       * binds. */
      if (!intentIsClockless) {
        if (stopEvent === void 0) fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'a freeze from STOP_RECORDED is a freeze over the journaled stop, while the journal carries no STOP_RECORDED event: the projection would state a freeze over an observation the authority does not record.');
        const stopJournaled = validateStopDetail(stopEvent.detail);
        const stopBound = request.stopAttestation !== undefined ? validateStopAttestation(request.stopAttestation) : validateStopAttestation(context.lifecycle.stopAttestation);
        if (stopJournaled.operator !== stopBound.operator || stopJournaled.statement !== stopBound.statement || (stopJournaled.observedAt ?? null) !== (stopBound.observedAt ?? null)) {
          fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'a freeze over the journaled stop must bind the attestation that stop carried: the journaled stop and the freeze attestation state different operator statements.');
        }
      }
    }

    const record = buildState({
      manifest: context.manifest,
      state: to,
      declaration: request.declaration !== undefined ? request.declaration : (context.lifecycle === null ? null : context.lifecycle.declaration),
      startedAt: request.startedAt !== undefined ? request.startedAt : (context.lifecycle === null ? null : context.lifecycle.startedAt),
      stoppedAt: request.stoppedAt !== undefined ? request.stoppedAt : (context.lifecycle === null ? null : context.lifecycle.stoppedAt),
      stopAttestation: request.stopAttestation !== undefined ? (request.stopAttestation.clockless===true?{...validateStopAttestation((({clockless,...rest})=>rest)(request.stopAttestation)),clockless:true}:validateStopAttestation(request.stopAttestation)) : (context.lifecycle === null ? null : context.lifecycle.stopAttestation),
      stopAssurance: request.stopAssurance !== undefined ? request.stopAssurance : (context.lifecycle === null ? null : context.lifecycle.stopAssurance),
      elapsedMs: request.elapsedMs !== undefined ? request.elapsedMs : (context.lifecycle === null ? null : context.lifecycle.elapsedMs),
      clockError: request.clockError !== undefined ? request.clockError : (context.lifecycle === null ? null : context.lifecycle.clockError),
      journalCommitAt: request.journalCommitAt !== undefined ? request.journalCommitAt : (context.lifecycle === null ? null : context.lifecycle.journalCommitAt),
      history,
    });
    await publishState(context.storage, context.manifest, record);
    onCommitted(record);
    return Object.freeze(clone(record));
  };
}

/* ========================================================================== */
/* withRunTransaction: the shared whole-command seam                           */
/* ========================================================================== */

/**
 * Run one whole command against one run container under the accepted root-wide
 * lock held for the entire command.
 *
 * The callback receives the narrow context
 * `{manifest, storage, workspaceRoot, stateRoot, lifecycle, appendEvent,
 * commitState, clock}`. `lifecycle` is `null` while the container reports the
 * derived `INITIALIZED` state. Every read of the run binding happens again
 * before success, so a container swapped out from under the command fails
 * closed. Lock conflicts from another process or instance are refused by the
 * accepted seam: nothing here expires or steals a lock.
 *
 * @param {{runRoot:string, manifestId:string, runId:string, expectedDigest?:string, clock?:{now():number|null}}} request
 * @param {(context:object) => unknown} callback
 */
export async function withRunTransaction(request, callback) {
  if (typeof callback !== 'function') fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'withRunTransaction(request, callback) requires a callback function.');
  const opened = await openRun(request);
  const storage = createStorage({ root: opened.stateRoot });

  let result;
  try {
    result = await storage.withLock(async () => {
    const manifest = await storage.read({ ...RUN_MANIFEST_STATE_KEY, id: opened.manifestId });
    verifyManifest(manifest, { runRoot: opened.runRoot, manifestId: opened.manifestId, runId: opened.runId, expectedDigest: opened.manifestDigest }, opened.stateRoot);
    const lifecycleRecord = await readStateRecord(storage, opened.manifestId, opened.runId).catch((error) => {
      /* A command may not write on a run whose projection cannot be
       * established. The read surface reports the state contract refusal; a
       * command reports recovery-required over the same cause, because the
       * operator's route is the explicit reconciliation, not a retry. No byte is
       * touched on the way out. */
      if (error instanceof LifecycleError && error.code === LIFECYCLE_ERROR_CODES.SCHEMA_VALIDATION_FAILED) {
        throw corruptProjectionGuard(error, request.operationName ?? 'this lifecycle command');
      }
      throw error;
    });
    /* A projection the authority does not author is refused before the command
     * runs, so no callback can compound it: the same cause the read surface
     * reports as a read refusal is reported here as the recovery route. The
     * journal is read for this decision only, and nothing is written on the
     * way out. */
    if (lifecycleRecord !== null) {
      const authorityJournal = await readJournal(storage, opened.manifestId);
      const authorityVerification = verifyJournal(authorityJournal, { manifestId: opened.manifestId, runId: opened.runId });
      try{if(authorityVerification.findings.length===0)assertAuthoredState(lifecycleRecord,authorityJournal,authorityVerification);}catch(error){throw corruptProjectionGuard(error,request.operationName??'command');}
       const unauthored = unauthoredProjectionRefusal(lifecycleRecord, authorityVerification);
      if (unauthored !== null) throw unauthoredProjectionCommandRefusal(unauthored, request.operationName ?? 'this lifecycle command');
    }
    const initialJournal=await readJournal(storage,opened.manifestId);
    const initialVerification=verifyJournal(initialJournal,manifest);
    assertJournalContracts(initialJournal,initialVerification);
    let currentState = lifecycleRecord;
    const context = {
      manifest: Object.freeze(clone(manifest)),
      storage,
      workspaceRoot: opened.workspaceRoot,
      stateRoot: opened.stateRoot,
      runRoot: opened.runRoot,
      runId: opened.runId,
      manifestId: opened.manifestId,
      /* The current lifecycle record, or null while the container reports the
       * derived INITIALIZED state. The seams below update it as they write. */
      get lifecycle() {
        return currentState === null ? null : Object.freeze(clone(currentState));
      },
      clock: request.clock ?? DEFAULT_CLOCK,
      appendEvent: null,
      commitState: null,
    };
    context.appendEvent = makeAppendEvent(context);
    context.commitState = makeCommitState(context, (record) => {
      currentState = record;
    });
      const outcome = await callback(Object.freeze(context));
      /* Re-verify the run binding before the command reports success. */
      const verified = await storage.read({ ...RUN_MANIFEST_STATE_KEY, id: opened.manifestId });
      verifyManifest(verified, { runRoot: opened.runRoot, manifestId: opened.manifestId, runId: opened.runId, expectedDigest: opened.manifestDigest }, opened.stateRoot);
      const finalRecord=await readStateRecord(storage,opened.manifestId,opened.runId);
       const finalJournal=await readJournal(storage,opened.manifestId);
       const finalVerification=verifyJournal(finalJournal,verified);
       if(finalVerification.findings.some(f=>!initialVerification.findings.includes(f)))fail(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,'journal integrity changed during transaction',{findings:finalVerification.findings});
       if(finalVerification.findings.length===0)assertAuthoredState(finalRecord,finalJournal,finalVerification);
       return outcome;
    });
  } catch (error) {
    /* A refusal from the accepted seam — a held lock, a refused publication, a
     * read-back mismatch — is reported as a lifecycle refusal that names the
     * seam code, so a caller can branch on one error type. Nothing here retries
     * the operation, expires a lock, or removes one. */
    if (error instanceof LifecycleError) throw error;
    throw storageRefusal(error);
  }
  return result;
}

/* ========================================================================== */
/* The lifecycle operations                                                     */
/* ========================================================================== */

function currentStateOf(lifecycleRecord) {
  return lifecycleRecord === null ? LIFECYCLE_DERIVED_STATE : lifecycleRecord.state;
}

/**
 * The class of projection/authority disagreement that is a refusal rather than
 * a report: a projection that states an operation the authority does not carry.
 *
 * The journal is the authority for what happened, so a projection reporting
 * RUNNING while the journal holds no start intent is not a lagging view of a
 * real run — it is a record of an operation that was never declared. The same
 * holds with stronger force for a frozen projection: a freeze is the act that
 * closes a run and makes its bytes a submission, and it is journaled as an
 * intent before it is committed, so a FROZEN projection with no journaled intent
 * is a fabricated submission rather than a lagging view. Neither can be reported
 * (the read would publish a fact no authority supports) and neither may be
 * written over (the write would compound one fabrication with another).
 *
 * Every other disagreement between the two authorities stays a reported finding:
 * an operation that journaled its intent without landing its projection is a
 * recoverable torn run, and reporting it is what lets an operator reconcile it.
 * Only the unauthorable claim is refused, and nothing is ever repaired here.
 */
function unauthoredProjectionRefusal(record, verification) {
  if (record === null || record === void 0) return null;
  if (record.state === 'RUNNING' && verification.counts.START_INTENT === 0) {
    return 'the projection reports RUNNING while the journal carries no START_INTENT event, so no journaled start authors the start the projection reports';
  }
  if (record.state === 'FROZEN' && verification.counts.FREEZE_INTENT === 0) {
    return 'the projection reports FROZEN while the journal carries no FREEZE_INTENT event, so no journaled freeze intent authors the freeze the projection reports';
  }
  return null;
}

/** The read-face report of an unauthored projection: refused, never repaired. */
function unauthoredProjectionReadRefusal(reason) {
  return new LifecycleError(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, `the lifecycle projection of this run is refused rather than reported: ${reason}. The stored bytes are preserved untouched.`, { reason });
}

/** The command-face report of the same cause: the explicit reconciliation route. */
function unauthoredProjectionCommandRefusal(reason, operationName) {
  return new LifecycleError(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED, `${operationName} is refused over a lifecycle projection the authority does not author: ${reason}. The stored projection and the journal are preserved untouched; reconcile the run before writing to it.`, { reason });
}

function viewOf(manifest, record, journal) {
  return Object.freeze({
    runId: manifest.runId,
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest ?? null,
    state: currentStateOf(record),
    lifecycle: record === null ? null : Object.freeze(clone(record)),
    journal: journal === null ? null : Object.freeze({
      entryCount: journal.events.length,
      foreignEntries: Object.freeze([...journal.foreign]),
      events: Object.freeze(journal.events.map((entry) => Object.freeze(clone(entry.event)))),
    }),
  });
}

async function journalFloor(context) {
  const journal = await readJournal(context.storage, context.manifest.manifestId);
  let floor = null;
  for (const entry of journal.events) {
    const ms = parseIsoValue(entry.event?.journalCommitAt);
    if (ms !== null) floor = floor === null ? ms : Math.max(floor, ms);
  }
  return floor;
}

function clockErrorOf(reading) {
  return { code: reading.code, error: reading.error, elapsedAvailable: false };
}

/**
 * Start one manual run: capture the operator declaration, append the
 * START_INTENT event, publish the lifecycle state record, then append the
 * START_COMMIT event, all inside one transaction.
 *
 * The declaration becomes immutable with the intent: a later start carrying a
 * different declaration is refused as a declaration conflict, and a start after
 * an interrupted start is refused as recovery-required rather than re-binding a
 * declaration. A clock that is broken is retained as an error on the record; a
 * clock that reports nothing leaves the instants unknown.
 */
export async function startRun(request) {
  const value = wantObject(request, 'the start request');
  const operationName = wantString(value.operationName, 'the start request.operationName', { maxLength: 128 }) ?? 'startRun';
  const declaration = validateDeclaration(need(value.declaration, 'the start request.declaration'));
  return withRunTransaction({ runRoot: value.runRoot, manifestId: value.manifestId, runId: value.runId, expectedDigest: value.expectedDigest, clock: value.clock, operationName }, async (context) => {
    const journal = await readJournal(context.storage, context.manifest.manifestId);
    const verification = verifyJournal(journal, context.manifest);
    if (verification.findings.length > 0) {
      fail(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED, 'the recovery journal does not verify; reconcile the run explicitly before any start.', { findings: verification.findings });
    }
    if (context.lifecycle !== null && context.lifecycle.state === 'FROZEN') {
      fail(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'the run is FROZEN and closed; there is no start to make on a frozen run.');
    }
    if (verification.counts.START_INTENT > 0 || journal.events.length > 0) {
      const captured = journal.events[0].event.declaration;
      const attempted = bindDeclaration(declaration, context.manifest);
      const alreadyStarted = verification.counts.START_COMMIT > 0;
      /* An identical restatement of the captured declaration is not a
       * declaration conflict. What it reveals instead depends on whether the
       * journaled start finished: a complete start means the run is simply
       * already started, while a start with no commit is the interrupted
       * operation that only explicit reconciliation may resolve. */
      if (canonicalJson(captured) !== canonicalJson(attempted)) {
        fail(LIFECYCLE_ERROR_CODES.DECLARATION_ALREADY_BOUND, 'the run already carries a captured start declaration; a start stating different values is refused and the captured declaration stands unchanged.', { captured, attempted });
      }
      if (alreadyStarted) {
        fail(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'the run is already started: its start intent and commit are both in the journal, so there is no second start to make.');
      }
      fail(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,
        'a prior start was interrupted: its intent is in the journal while its state record or commit event is not. Reconcile the interrupted operation explicitly before any start.');
    }
    if (context.lifecycle !== null) {
      fail(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, `the run already carries a lifecycle record in state ${JSON.stringify(context.lifecycle.state)}; a start happens once, from the derived INITIALIZED state.`);
    }

    const bound = bindDeclaration(declaration, context.manifest);
    const floor = await journalFloor(context);
    const reading = readClockReading(context.clock, floor);
    const occurredAt = reading.ok ? iso(reading.ms) : null;
    const clockError = reading.ok ? null : clockErrorOf(reading);

    const intent = await context.appendEvent({ kind: 'START_INTENT', occurredAt: occurredAt, journalCommitAt: occurredAt, declaration: bound });
    const record = await context.commitState({
      state: 'RUNNING',
      declaration: bound,
      startedAt: occurredAt,
      journalCommitAt: occurredAt,
      clockError,
      historyEntry: { operation: 'START', intentEventDigest: intent.eventDigest },
    });
    const commit = await context.appendEvent({ kind: 'START_COMMIT', occurredAt: occurredAt, journalCommitAt: occurredAt, declaration: bound, detail: { stateEventDigest: record.stateDigest } });
    void commit;
    return viewOf(context.manifest, record, await readJournal(context.storage, context.manifest.manifestId));
  });
}

/**
 * Record an operator-attested stop.
 *
 * This writes what a named human asserts — that the cooperating agents stopped
 * of their own cooperation — plus the observed instant. It returns
 * `stopAssurance:'operator-attested'` with `enforced:false`. It has no ability
 * to signal, terminate, launch or survey a process, session or agent, and it
 * imports no OS or supervisor module to get one.
 *
 * A legitimate elapsed of zero is reported as zero. An unknown instant is
 * reported as `null`. A reversed clock is retained as a clock error with
 * elapsed unavailable; nothing is clamped.
 */
export async function stopRun(request) {
  const value = wantObject(request, 'the stop request');
  const operationName = wantString(value.operationName, 'the stop request.operationName', { maxLength: 128 }) ?? 'stopRun';
  const attestation = validateStopAttestation(need(value.attestation, 'the stop request.attestation'));
  return withRunTransaction({ runRoot: value.runRoot, manifestId: value.manifestId, runId: value.runId, expectedDigest: value.expectedDigest, clock: value.clock, operationName }, async (context) => {
    const journal = await readJournal(context.storage, context.manifest.manifestId);
    const verification = verifyJournal(journal, context.manifest);
    if (verification.findings.length > 0) {
      fail(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED, 'the recovery journal does not verify; reconcile the run explicitly before a stop is recorded.', { findings: verification.findings });
    }
    if (context.lifecycle === null) {
      if (verification.counts.START_INTENT > 0 && verification.counts.START_COMMIT === 0) {
        fail(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED, 'the run carries an interrupted start (intent without commit); reconcile the interrupted operation before a stop is recorded.');
      }
      fail(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'a stop observation requires a started run; this run reports the derived INITIALIZED state with no recorded activity.');
    }
    if (context.lifecycle.state === 'FROZEN') {
      fail(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, 'the run is FROZEN and closed; a stop recorded after the freeze is refused.');
    }
    if (context.lifecycle.state === 'RUNNING' && verification.counts.START_COMMIT === 0) {
      fail(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED, 'the run reports RUNNING while its start has no commit event; reconcile the interrupted operation first.');
    }
    /* A stop is one operator observation of one event. Once one is recorded the
     * run is STOP_RECORDED and there is no second stop to record — not even an
     * identical restatement, which would otherwise let a repeat pass for a
     * fresh observation. This is checked before the clock is read and before
     * anything is journaled, so a refused repeat writes nothing at all. */
    if (context.lifecycle.stopAttestation !== null || context.lifecycle.state === 'STOP_RECORDED') {
      const attestedBy = context.lifecycle.stopAttestation === null ? 'an earlier observation' : JSON.stringify(context.lifecycle.stopAttestation.operator);
      fail(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, `a stop has already been attested for this run by ${attestedBy}; a run already STOP_RECORDED accepts no second stop, identical or otherwise, and the attested stop stands.`);
    }
    /* The repeat-stop rule above reads the projection, so over a run whose
     * authority already journals a stop while that projection never landed the
     * rule alone would let a second observation be written. The journal is the
     * authority and an operator stop is one observation, so the seam consults it
     * too, through the same coherence comparison the read surface publishes —
     * no second validator, and still under the whole-run lock the command
     * already holds. Any disagreement between the authority and its projection is
     * reported before the clock is read and before anything is journaled, so a
     * refused repeat writes nothing at all. */
    const coherenceFindings = diagnoseProjectionCoherence(context.lifecycle, journal, verification);
    if (coherenceFindings.length > 0) {
      fail(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED, `the journal and the state projection state different facts about this run: ${coherenceFindings.join('; ')}; a stop is refused over that disagreement, so the run must be reconciled rather than written over.`, { findings: Object.freeze([...coherenceFindings]) });
    }

    const startedAt = context.lifecycle.startedAt;
    const observedFloor = Math.max(parseIsoValue(startedAt) ?? 0, await journalFloor(context) ?? 0);
    const reading = readClockReading(context.clock, observedFloor);
    const clockError = reading.ok ? (context.lifecycle.clockError ?? null) : clockErrorOf(reading);
    const observedAt = reading.ok ? iso(reading.ms) : null;
    const stopInstant = observedAt ?? attestation.observedAt;
    const elapsed = reading.ok ? elapsedBetween(startedAt, stopInstant) : null;

    const event = await context.appendEvent({
      kind: 'STOP_RECORDED',
      occurredAt: stopInstant,
      journalCommitAt: observedAt,
      declaration: context.lifecycle.declaration,
      detail: { operator: attestation.operator, agentStopped: true, statement: attestation.statement, observedAt: attestation.observedAt, assurance: STOP_ASSURANCE, enforced: STOP_ENFORCED },
    });
    const record = await context.commitState({
      state: 'STOP_RECORDED',
      stoppedAt: stopInstant,
      stopAttestation: attestation,
      stopAssurance: STOP_ASSURANCE,
      elapsedMs: elapsed,
      clockError,
      journalCommitAt: observedAt,
      historyEntry: { operation: 'STOP', stopEventDigest: event.eventDigest, elapsedAvailable: elapsed !== null || clockError === null },
    });
    return Object.freeze({ ...viewOf(context.manifest, record, await readJournal(context.storage, context.manifest.manifestId)), stopAssurance: STOP_ASSURANCE, enforced: STOP_ENFORCED });
  });
}

/**
 * Read the lifecycle state of one run: the state (the derived
 * `INITIALIZED` while no record exists), the record, the verified journal and
 * the reconciliation diagnosis. Publishes nothing.
 */
export async function readRunLifecycle(request) {
  const value = wantObject(request, 'the lifecycle read request');
  const opened = await openRun({ ...value, operationName: value.operationName ?? 'readRunLifecycle' });
  const storage = createStorage({ root: opened.stateRoot });
  /* The whole run read happens under the accepted container lock so the state
   * record and the journal it reports are one consistent snapshot rather than
   * a record from one instant and a journal from another. A writer that holds
   * the lock therefore makes this read refuse: the module does not queue, does
   * not bypass the lock, and above all does not remove a lock it does not own.
   * A refusal from the seam is reported as a lifecycle refusal naming the seam
   * code, so the caller can tell "another writer owns this run right now" from
   * any other failure. */
  let result;
  try {
    result = await storage.withLock(async () => {
      const record = await readStateRecord(storage, opened.manifestId, opened.runId);
      const journal = await readJournal(storage, opened.manifestId);
      const verification = verifyJournal(journal, { manifestId: opened.manifestId, runId: opened.runId });
       assertJournalContracts(journal,verification);
      /* Two distinct authorities must agree: the journal against itself (the
       * hash chain) and the projection against that authority. A run whose
       * projection lags behind a journaled event is reported here rather than
       * described as consistent; the read publishes nothing either way. */
      if(verification.findings.length===0)assertAuthoredState(record,journal,verification);
       const coherenceFindings = diagnoseProjectionCoherence(record, journal, verification);
      /* A projection that states a start no authority carries is refused rather
       * than reported; every other disagreement between the two authorities is
       * reported as a finding, because reporting it is what lets an operator
       * reconcile a torn run. */
      const unauthored = unauthoredProjectionRefusal(record, verification);
      if (unauthored !== null) throw unauthoredProjectionReadRefusal(unauthored);
      const findings = [...verification.findings, ...coherenceFindings];
      const diagnosis = diagnose(record, verification, journal);
      return Object.freeze({ ...viewOf(opened, record, journal), diagnosis, findings: Object.freeze(findings) });
    });
  } catch (error) {
    /* A projection that fails its own integrity check is reported here as the
     * read refusal it is: the read of this run cannot be completed, so it is
     * reported with the state-transition code the read surface already uses for
     * "this run cannot be reported as it stands", with the reason kept in the
     * message. A corrupt projection is never repaired by a read. */
    if (error instanceof LifecycleError && error.code === LIFECYCLE_ERROR_CODES.SCHEMA_VALIDATION_FAILED) {
      throw new LifecycleError(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, `the lifecycle projection of this run is refused rather than reported: ${error.message} The stored bytes are preserved untouched.`, { reason: error.message });
    }
    if (error instanceof LifecycleError) throw error;
    throw storageRefusal(error);
  }
  return result;
}

/**
 * Compare the projection (the state record) against the verified journal and
 * report every place where the two disagree.
 *
 * The journal is the authority and the state record is its projection, so an
 * operation that journaled an event without landing its projection commit (or
 * the reverse: a projection that claims an event the authority never recorded)
 * is a torn run. It is not a state this contract may describe as
 * `consistent`, and it is not a state it may quietly repair: a read reports the
 * disagreement and writes nothing.
 *
 * The rules are deliberately narrow — they cover only claims the journal and
 * the record can both be read to make:
 *  - a journaled stop with no stop in the projection (torn STOP_RECORDED: the
 *    state was never advanced, or the attestation never landed);
 *  - a projection that states a stop the journal does not carry;
 *  - a journaled start commit whose projection is absent or carries a different
 *    immutable declaration;
 *  - a clockless-frozen projection with no clockless freeze authority;
 *  - a journaled freeze commit that binds a projection digest other than the
 *    projection that is read back.
 * A projection frozen through the clockless route from `INITIALIZED` is an
 * attested freeze with no start and no stop by design, so it is matched to its
 * FREEZE_INTENT rather than to a stop.
 */
function diagnoseProjectionCoherence(record, journal, verification) {
  const findings = [];
  const events = journal === null || journal === void 0 ? [] : journal.events.map((entry) => entry.event);
  const stopEvent = events.find((event) => event?.kind === 'STOP_RECORDED');
  const freezeCommit = [...events].reverse().find((event) => event?.kind === 'FREEZE_COMMIT');

  if (stopEvent !== void 0 && verification.counts.STOP_RECORDED > 0) {
    /* The authority records a stop. The projection must carry its result: a
     * state of STOP_RECORDED or FROZEN and the attestation the stop attested. */
    if (record === null) {
      findings.push('the journal carries a STOP_RECORDED event while the projection is absent: the stop was journaled without its projection commit');
    } else {
      if (record.state === 'INITIALIZED' || record.state === 'RUNNING') {
        findings.push(`the journal carries a STOP_RECORDED event while the projection still reports ${record.state}: the journaled stop has no projection commit`);
      }
      if (record.stopAttestation === null || record.stopAttestation === void 0) {
        findings.push('the journal carries a STOP_RECORDED event while the projection carries no stop attestation: the attested stop has no projection commit');
      } else {
        /* The projection carries an attestation, so the two must state one and
         * the same stop. The released stop writes the event detail and the
         * projection fields from the one attestation, so a divergence here is a
         * projection that was not produced by the journaled stop. This is the
         * same integrity claim the released freeze gate makes. */
        const detail = stopEvent.detail ?? {};
        if (record.stopAttestation.operator !== detail.operator || record.stopAttestation.statement !== detail.statement) {
          findings.push('the projection states a stop attestation whose operator or statement is not the one the STOP_RECORDED event journaled');
        }
        if (record.stoppedAt !== stopEvent.occurredAt) {
          findings.push('the projection states a stop instant that is not the instant the STOP_RECORDED event journaled');
        }
      }
    }
  }

  if (stopEvent === void 0 && record !== null) {
    /* The projection claims a stop the authority never journaled. A FROZEN
     * projection carries the freeze justification in the same field: the
     * clockless route states it by design with no start and no stop, and the
     * bound route is already checked by the rule above when the journal does
     * carry a stop. Only an unambiguous stop claim is reported here. */
    const clocklessFreeze = record.state === 'FROZEN' && record.stopAttestation?.clockless === true;
    const claimsStop = record.state === 'STOP_RECORDED' || (record.state !== 'FROZEN' && record.stopAttestation !== null);
    if (claimsStop && !clocklessFreeze) findings.push('the projection carries a stop while the journal carries no STOP_RECORDED event: the projection states an event the authority does not carry');
  }

  if (record === null && verification.counts.START_COMMIT > 0) {
    findings.push('the journal carries a START_COMMIT event while the projection is absent: the start committed without its projection commit');
  }
  if (record !== null && verification.counts.START_COMMIT > 0) {
    const commit = events.find((event) => event?.kind === 'START_COMMIT');
    if (commit !== void 0 && canonicalJson(commit.declaration) !== canonicalJson(record.declaration)) {
      findings.push('the START_COMMIT event carries an immutable declaration that is not the declaration the projection carries');
    }
  }

  if (record !== null && record.state === 'FROZEN') {
    const clockless = record.stopAttestation !== null && record.stopAttestation.clockless === true;
    if (clockless && verification.counts.FREEZE_INTENT === 0) {
      findings.push('the projection reports a clockless freeze while the journal carries no FREEZE_INTENT event: the clockless freeze has no journaled authority');
    }
  }

  if (record !== null && freezeCommit !== void 0) {
    const boundDigest = freezeCommit.detail?.stateEventDigest;
    if (typeof boundDigest === 'string' && boundDigest.length === 64 && boundDigest !== record.stateDigest) {
      findings.push('the FREEZE_COMMIT event binds a projection digest that is not the digest of the projection that was read back');
    }
  }

  return findings;
}

/**
 * Derive the reconciliation diagnosis. The journal is the source of truth: an
 * intent without its commit is an interrupted operation, an unverified chain is
 * an inconsistent run, and a projection that disagrees with that authority is an
 * inconsistent run too. `diagnose` reports; it never repairs.
 *
 * An interrupted operation keeps its own diagnosis even when the projection also
 * lags behind it: the projection lag is the very interruption the operator is
 * being told to reconcile, so it must not be relabelled as corruption.
 */
function diagnose(record, verification, journal) {
  if (verification.findings.length > 0) return 'inconsistent';
  if (verification.counts.START_INTENT === 1 && verification.counts.START_COMMIT === 0) return 'incomplete';
  if (verification.counts.FREEZE_INTENT > 0 && verification.counts.FREEZE_COMMIT === 0) return 'incomplete';
  if (record === null && verification.counts.START_COMMIT > 0) return 'incomplete';
  if (diagnoseProjectionCoherence(record, journal, verification).length > 0) return 'inconsistent';
  return 'consistent';
}

/**
 * Reconcile an interrupted operation explicitly. Nothing else heals a run.
 *
 * The caller names the interrupted operation and states the operator
 * disposition. The full error history is retained: reconciliation completes
 * the command that was interrupted from the bytes the journal already holds,
 * or reports that it will not touch the run, and never forges a timestamp,
 * never retries different bytes at a pending identity, and never removes a
 * stale lock.
 */
export async function reconcileRun(request) {
  const value = wantObject(request, 'the reconciliation request');
  const interruptedOperation = wantString(need(value.interruptedOperation, 'the reconciliation request.interruptedOperation'), 'the reconciliation request.interruptedOperation', { maxLength: 64 });
  if (interruptedOperation !== 'START' && interruptedOperation !== 'STOP') {
    fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `the reconciliation request names the unsupported interrupted operation ${JSON.stringify(interruptedOperation)}.`);
  }
  const disposition = wantObject(need(value.disposition, 'the reconciliation request.disposition'), 'the reconciliation request.disposition');
  const unknownDisposition = Object.keys(disposition).filter((key) => !['operator', 'decision', 'attestation'].includes(key));
  if (unknownDisposition.length > 0) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `the reconciliation disposition carries undeclared field(s): ${unknownDisposition.join(', ')}.`);
  const operator = wantString(need(disposition.operator, 'the reconciliation disposition.operator'), 'the reconciliation disposition.operator', { minLength: OPERATOR_MIN_LENGTH, maxLength: OPERATOR_MAX_LENGTH });
  const decision = wantString(need(disposition.decision, 'the reconciliation disposition.decision'), 'the reconciliation disposition.decision', { maxLength: 32 });
  if (!['COMPLETE', 'LEAVE_AS_IS'].includes(decision)) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `the reconciliation disposition states the unknown decision ${JSON.stringify(decision)}.`);
  const operatorAttestation = wantString(need(disposition.attestation, 'the reconciliation disposition.attestation'), 'the reconciliation disposition.attestation', { minLength: 8, maxLength: 2000 });

  return withRunTransaction({ runRoot: value.runRoot, manifestId: value.manifestId, runId: value.runId, expectedDigest: value.expectedDigest, clock: value.clock, operationName: value.operationName ?? 'reconcileRun' }, async (context) => {
    const journal = await readJournal(context.storage, context.manifest.manifestId);
    const verification = verifyJournal(journal, context.manifest);
    /* A run whose authority and projection disagree is not a run this command
     * may advance. Completing an interrupted operation is the one repair this
     * contract knows, and rewriting a projection to chase a journaled event is
     * a different repair that would be invented here — so the disagreement is
     * reported and every byte is left exactly where it was found. */
    const coherenceFindings = diagnoseProjectionCoherence(context.lifecycle, journal, verification);
    const diagnosis = diagnose(context.lifecycle, verification, journal);

    if (verification.findings.length === 0 && coherenceFindings.length > 0) {
      return Object.freeze({ runId: context.manifest.runId, manifestId: context.manifest.manifestId, diagnosis, action: 'LEAVE_AS_IS', note: 'the journal and the state record state different facts about this run; reconciliation reports the disagreement and preserves every byte it found.', findings: Object.freeze([...coherenceFindings]), state: currentStateOf(context.lifecycle), history: context.lifecycle === null ? Object.freeze([]) : context.lifecycle.history });
    }

    if (verification.findings.length > 0 && !(diagnosis === 'incomplete' && verification.findings.every((finding) => finding.includes('START_COMMIT')))) {
      return Object.freeze({ runId: context.manifest.runId, manifestId: context.manifest.manifestId, diagnosis, action: 'LEAVE_AS_IS', note: 'the journal does not verify against itself; reconciliation reports the findings and preserves every byte it found.', findings: Object.freeze([...verification.findings]), state: currentStateOf(context.lifecycle), history: context.lifecycle === null ? Object.freeze([]) : context.lifecycle.history });
    }
    if (diagnosis === 'consistent') {
      return Object.freeze({ runId: context.manifest.runId, manifestId: context.manifest.manifestId, diagnosis, action: 'LEAVE_AS_IS', note: 'nothing is interrupted; no repair was needed.', findings: Object.freeze([]), state: currentStateOf(context.lifecycle), history: context.lifecycle === null ? Object.freeze([]) : context.lifecycle.history });
    }
    if (decision === 'LEAVE_AS_IS') {
      return Object.freeze({ runId: context.manifest.runId, manifestId: context.manifest.manifestId, diagnosis, action: 'LEAVE_AS_IS', note: `the operator stated LEAVE_AS_IS; the interrupted ${interruptedOperation} is retained exactly as it stands.`, findings: Object.freeze([...verification.findings]), state: currentStateOf(context.lifecycle), history: context.lifecycle === null ? Object.freeze([]) : context.lifecycle.history });
    }
    if (interruptedOperation !== 'START') {
      return Object.freeze({ runId: context.manifest.runId, manifestId: context.manifest.manifestId, diagnosis, action: 'LEAVE_AS_IS', note: 'this contract knows one recoverable interrupted operation, the start; a stop is recorded wholly or not at all.', findings: Object.freeze([...verification.findings]), state: currentStateOf(context.lifecycle), history: context.lifecycle === null ? Object.freeze([]) : context.lifecycle.history });
    }

    const intent = journal.events.find((entry) => entry.event?.kind === 'START_INTENT');
    if (intent === undefined) {
      fail(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED, 'the journal names no start intent, so there is nothing for reconciliation to complete.');
    }
    const captured = intent.event.declaration;
    if (context.lifecycle !== null && canonicalJson(context.lifecycle.declaration) !== canonicalJson(captured)) {
      return Object.freeze({ runId: context.manifest.runId, manifestId: context.manifest.manifestId, diagnosis, action: 'LEAVE_AS_IS', note: 'the state record states a declaration that is not the one the journal captured; reconciliation will not overwrite either.', findings: Object.freeze([...verification.findings]), state: currentStateOf(context.lifecycle) });
    }

    const reading = readClockReading(context.clock, await journalFloor(context));
    const occurredAt = reading.ok ? iso(reading.ms) : null;
    const clockError = reading.ok ? (context.lifecycle?.clockError ?? null) : clockErrorOf(reading);
    const record = context.lifecycle === null
      ? await context.commitState({ state: 'RUNNING', declaration: captured, startedAt: intent.event.occurredAt ?? occurredAt, journalCommitAt: occurredAt, clockError, historyEntry: { operation: 'RECONCILE', interruptedOperation, decision, operator, operatorAttestation, completedFromIntentDigest: intent.event.eventDigest } })
      : await context.commitState({ state: context.lifecycle.state, reconciliation: true, historyEntry: { operation: 'RECONCILE', interruptedOperation, decision, operator, operatorAttestation, completedFromIntentDigest: intent.event.eventDigest } });
    await context.appendEvent({ kind: 'START_COMMIT', occurredAt: occurredAt, journalCommitAt: occurredAt, declaration: captured, detail: { stateEventDigest: record[SELF_STATE_FIELD], reconciliation: true, operator, completedFromIntentDigest: intent.event.eventDigest } });

    const after = await readJournal(context.storage, context.manifest.manifestId);
    return Object.freeze({ runId: context.manifest.runId, manifestId: context.manifest.manifestId, diagnosis: 'repaired', action: 'COMPLETE', note: 'the interrupted start was completed from the bytes the journal already carried; no timestamp was forged and no lock was removed.', findings: Object.freeze([]), state: currentStateOf(record), history: record.history });
  });
}

/**
 * The freeze precondition gate the freeze task (T3) calls before it commits a
 * freeze, so the no-`RUNNING`-freeze rule lives in exactly one place.
 */
export function freezePreconditionFor(state) {
  if (!LIFECYCLE_COMMITTED_STATES.includes(state)) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `unknown lifecycle state ${JSON.stringify(state)}.`);
  const precondition = FREEZE_PRECONDITIONS[state];
  if (precondition === undefined) {
    return Object.freeze({ permitted: false, requires: null, attestationRequired: false, clockRequired: false, reason: `a freeze from state ${state} has no defined precondition: ${state === 'RUNNING' ? 'a run that is still running may not be frozen' : 'a frozen run is already closed'}.` });
  }
  return Object.freeze({ permitted: true, requires: precondition.requires, attestationRequired: precondition.attestationRequired, clockRequired: precondition.clockRequired, reason: null });
}

/** Recompute the digest of a state record from its own bytes. */
export function lifecycleStateDigestOf(record) {
  return selfDigestOf(wantObject(record, 'the lifecycle state record'), SELF_STATE_FIELD);
}

/** Recompute the digest of a journal event from its own bytes. */
export function lifecycleEventDigestOf(event) {
  return selfDigestOf(wantObject(event, 'the lifecycle journal event'), SELF_EVENT_FIELD);
}

/** The canonical JSON every digest in this contract is computed over. */
export function lifecycleCanonicalJson(value) {
  return canonicalJson(value);
}
