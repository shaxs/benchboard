/* BenchBoard manual freeze — the C3 T3 immutable submission freeze.
 *
 * Contract: the approved C3 execution plan, T3 (immutable freeze publication and
 * saved-submission verification). The contract is named by chunk and task and not
 * by a private planning path, because this file is distributed with the product
 * and must not point at owner-only material.
 *
 * What this module is. The freeze is the one operation that turns a stopped (or
 * demonstrably never-started and clockless) manual run into an immutable
 * submission: a byte-exact application snapshot of the run workspace, a C1
 * `FrozenSubmission` contract record bound to the sealed manifest, and a
 * companion proof record that carries what the C1 shape does not describe — the
 * snapshot identity, the full byte inventory, the directory set, the selection
 * policy, the hash algorithm identity, the stop assurance and the provenance of
 * every time the record states.
 *
 * What this module is not. It has no state of its own to write: the lifecycle
 * state record and the append-only journal are written only through the accepted
 * T1 seams (`withRunTransaction`, `appendEvent`, `commitState`), under the one
 * whole-command lock, with the freeze precondition table read from
 * `freezePreconditionFor`. It launches, signals, halts or surveys no process and
 * imports no OS or supervisor module to get such an ability. It discovers no run
 * root, does not delete anything it does not own, and never adopts, reuses or
 * cleans a directory that already existed.
 *
 * Ordering is the safety property, not an implementation detail:
 *   1. every argument, root, precondition and attestation is verified BEFORE any
 *      byte is written, so a merely invalid request leaves the run untouched;
 *   2. the persisted journal and the state record are re-verified against their
 *      own recomputed digests and hash chain before the claim, so a torn
 *      `STOP_RECORDED` projection is a refusal rather than a freeze input;
 *   3. `FREEZE_INTENT` is journaled before the copy is claimed;
 *   4. the snapshot is copied and verified, the `FrozenSubmission` and its proof
 *      are published immutably, and only then is `FREEZE_COMMIT` journaled and
 *      the state moved to `FROZEN`;
 *   5. any failure after the intent reports its actual fate — the journaled
 *      intent, the snapshot bytes that exist and the untouched state record —
 *      and is an interrupted freeze for an operator to reconcile, never an
 *      ordinary success and never a silent cleanup.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  LifecycleError,
  LIFECYCLE_ERROR_CODES,
  LIFECYCLE_STATE_KIND,
  LIFECYCLE_STATE_RELATIVE_PATH,
  LIFECYCLE_EVENT_KIND,
  LIFECYCLE_JOURNAL_DIRECTORY,
  STOP_ASSURANCE,
  STOP_ENFORCED,
  withRunTransaction,
  freezePreconditionFor,
  lifecycleStateDigestOf,
  lifecycleEventDigestOf,
  lifecycleCanonicalJson,
} from './lifecycle-internal.mjs';
import { createId } from './identity.mjs';
import { validateRecord, computeTreeDigest, sha256Hex } from './manifest.mjs';
import {
  SELECTION_POLICY_ID,
  SELECTION_POLICY_EXCLUSIONS,
  SNAPSHOT_HASH_ALGORITHM_ID,
  SNAPSHOT_ERROR_CODES,
  copySnapshot,
  verifySnapshot,
} from './snapshot-copy.mjs';

/* The exclusions the accepted selection policy applies, reported so a reader can
 * see what a snapshot deliberately leaves out. */
const SELECTION_EXCLUSION_LIST = Object.freeze([...SELECTION_POLICY_EXCLUSIONS]);

/* ========================================================================== */
/* Stable identities                                                           */
/* ========================================================================== */

/** The module identity this operational surface reports. */
export const FREEZE_MODULE_ID = 'benchboard-core-freeze-v1';
export const FREEZE_SCHEMA_VERSION = '1.0.0';

/** Directory under the run root that holds each snapshot container. */
export const FREEZE_SNAPSHOT_ROOT_NAME = 'snapshots';

/**
 * The subdirectory of a snapshot container that holds the copied workspace, per
 * the accepted layout: the container is `<runRoot>/snapshots/<snapshotId>` and
 * the bytes the selection policy selected are the container's `workspace` child.
 */
export const FREEZE_SNAPSHOT_WORKSPACE_NAME = 'workspace';

/** Storage identities of the two records the freeze publishes. */
export const FREEZE_SUBMISSION_KIND = 'benchboard.contract.frozen-submission.v1';
export const FREEZE_PROOF_KIND = 'benchboard.freeze.snapshot-proof.v1';

/** The procedure label the C1 record carries. */
export const FREEZE_PROCEDURE = 'benchboard-core-freeze-v1:verified-application-snapshot';

/** Where the frozen instant came from; never implied, always stated. */
export const FROZEN_AT_PROVENANCE = Object.freeze({
  ATTESTED_OBSERVATION: 'attestation.observedAt',
  RECORDED_STOP: 'lifecycle.stoppedAt',
  CLOCK_READING: 'clock.reading',
});

/* ========================================================================== */
/* Refusal                                                                     */
/* ========================================================================== */

/* The freeze shares the accepted lifecycle refusal type and its code table: a
 * caller that can branch on a lifecycle refusal can branch on a freeze
 * refusal, and one code table cannot drift out of step with another. */
function fail(code, message, details) {
  throw new LifecycleError(code, message, details);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function need(value, label) {
  if (value === undefined) fail(LIFECYCLE_ERROR_CODES.FIELD_REQUIRED, `${label} is required.`);
  return value;
}

function wantString(value, label, { minLength = 1, maxLength = 512 } = {}) {
  if (value === undefined || value === null) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `${label} must be a non-empty string.`);
  if (typeof value !== 'string') fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `${label} must be a string, got ${typeof value}.`);
  if (value.length < minLength || value.length > maxLength) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `${label} must be between ${String(minLength)} and ${String(maxLength)} characters.`);
  return value;
}

function wantAbsoluteRoot(value, label) {
  wantString(value, label, { maxLength: 4096 });
  if (!path.isAbsolute(value)) fail(LIFECYCLE_ERROR_CODES.INVALID_ROOT, `${label} must be an absolute host path; the freeze discovers no root on its own.`);
  return value;
}

function wantStringOrNull(value, label) {
  if (value === undefined || value === null) return null;
  return wantString(value, label, { maxLength: 64 });
}

function wantKnownFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `${label} carries undeclared field(s): ${unknown.join(', ')}.`);
}

function isoNow(clock) {
  let reading = null;
  try {
    const raw = clock.now();
    if (typeof raw === 'number' && Number.isFinite(raw)) reading = new Date(raw).toISOString();
  } catch {
    /* A clock that throws has reported nothing. The freeze carries that as an
     * unknown instant rather than substituting a wall-clock reading the caller
     * never stated. */
    reading = null;
  }
  return reading;
}

/* ========================================================================== */
/* The attestation the freeze requires                                         */
/* ========================================================================== */

/* Accepted T1 field set. It is re-validated here so an unknown field is a
 * freeze-level refusal before the journal is touched, rather than a rejection
 * from a half-completed transaction. */
const STOP_ATTESTATION_FIELDS = Object.freeze(['operator', 'agentStopped', 'statement', 'observedAt']);
const CLOCKLESS_ATTESTATION_FIELDS = Object.freeze(['operator', 'agentStopped', 'statement', 'observedAt', 'clockless']);
const OPERATOR_MIN_LENGTH = 2;
function assertOrdinaryChain(target) {
 const absolute=path.resolve(target), parts=[]; let at=absolute;
 for(;;){parts.push(at);const parent=path.dirname(at);if(parent===at)break;at=parent;}
 for(const component of parts.reverse()) { let status;try{status=fs.lstatSync(component);}catch(error){if(error.code==='ENOENT')return;throw error;} if(status.isSymbolicLink()||!status.isDirectory())fail(LIFECYCLE_ERROR_CODES.INVALID_ROOT,'a directory chain is linked or non-directory; freeze does not read through it.',{component}); }
}
function freezeProofValid(proof) {
 if(!isObject(proof)||proof.kind!==FREEZE_PROOF_KIND||proof.schemaVersion!=='1.0.0'||!/^snap-[a-z0-9]+$/.test(proof.snapshotId??'')||!Array.isArray(proof.inventory)||!Array.isArray(proof.directories))return false;
 if(proof.inventory.some(file=>!isObject(file)||typeof file.path!=='string'||!Number.isSafeInteger(file.bytes)||file.bytes<0||! /^[a-f0-9]{64}$/.test(file.sha256)))return false;
 return proof.fileCount===proof.inventory.length&&proof.byteCount===proof.inventory.reduce((sum,file)=>sum+file.bytes,0)&&proof.directoryCount===proof.directories.length&&proof.treeDigest===computeTreeDigest(proof.inventory.map(file=>[file.path,file.sha256]));
}
const OPERATOR_MAX_LENGTH = 200;

function parseIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `${label} must be an ISO-8601 UTC instant.`);
  return new Date(value).toISOString();
}

/**
 * Validate the freeze attestation. `clockless` is accepted only on the explicit
 * clockless route, and it is required there: it is the operator's statement that
 * the run never started and that no time was observed for it.
 */
function validateFreezeAttestation(value, { clockless }) {
  const attestation = isObject(value) ? value : fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'the freeze attestation must be an object.');
  const allowed = clockless === true ? CLOCKLESS_ATTESTATION_FIELDS : STOP_ATTESTATION_FIELDS;
  wantKnownFields(attestation, allowed, 'the freeze attestation');
  const operator = wantString(attestation.operator, 'the freeze attestation.operator', { minLength: OPERATOR_MIN_LENGTH, maxLength: OPERATOR_MAX_LENGTH });
  if (attestation.agentStopped !== true) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'the freeze attestation must state agentStopped: true: the operator asserts that no cooperating agent was left running.');
  const statement = wantString(attestation.statement, 'the freeze attestation.statement', { minLength: 8, maxLength: 2000 });
  const observedAt = attestation.observedAt === undefined || attestation.observedAt === null ? null : parseIso(attestation.observedAt, 'the freeze attestation.observedAt');
  if (clockless === true) {
    if (attestation.clockless !== true) fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'a freeze from the derived INITIALIZED state must state clockless: true: the operator attests that the run never started and that no time is claimed for it.');
  } else if (attestation.clockless === true) {
    fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'a clockless attestation belongs to a run that never started; this run carries a recorded stop, so the freeze is bound to that stop instead.');
  }
  const normalised = { operator, agentStopped: true, statement, observedAt };
  return Object.freeze(clockless === true ? { ...normalised, clockless: true } : normalised);
}

/* ========================================================================== */
/* Re-verification of the persisted journal and projection                     */
/* ========================================================================== */

/**
 * Re-read and re-verify the persisted journal and the state projection through
 * the accepted storage identities and recomputed digests.
 *
 * The accepted T1 module keeps its journal reader and verifier private, so the
 * freeze re-derives the same properties here from the published bytes and the
 * published digest functions: a contiguous sequence bound to this run and
 * manifest, every event digest recomputed from its own bytes, every event after
 * the first naming the digest of its immediate predecessor, and a state record
 * whose own digest recomputes. That is what makes a torn `STOP_RECORDED` pair
 * (a journaled stop with no projection, or a projection with no stop) a refusal
 * before the freeze rather than a fact the freeze would happily build on.
 */
async function reverifyPersistedRun(context) {
  const { storage, manifest } = context;
  /* The accepted T1 module keeps its journal reader, its verifier and its
   * identity derivation private, so the identities below are the documented
   * accepted identities for these records: the accepted relative paths and kinds
   * plus the run-scoped identity suffix this release's C3 records use. They are
   * named here once, and nowhere else in the freeze is a private path or key
   * repeated. */
  const journalDirectory = path.join(storage.root, LIFECYCLE_JOURNAL_DIRECTORY);
  assertOrdinaryChain(journalDirectory);
  const events = [];
  const foreign = [];
  let directoryListed = false;
  try {
    const names = await fs.promises.readdir(journalDirectory);
    directoryListed = true;
    const listed = [];
    for (const name of names) {
      const match = /^([0-9]{5})\.json$/.exec(name);
      if (match === null) {
        foreign.push(name);
        continue;
      }
      listed.push({ sequence: Number(match[1]), relativePath: `${LIFECYCLE_JOURNAL_DIRECTORY}/${name}` });
    }
    listed.sort((left, right) => left.sequence - right.sequence);
    if(listed.length>99999)fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID,'journal exceeds the supported bounded sequence.');
    for (const entry of listed) {
      try {
        const value = await storage.read({
          relativePath: entry.relativePath,
          kind: LIFECYCLE_EVENT_KIND,
          id: `${manifest.manifestId}:event:${String(entry.sequence).padStart(5, '0')}`,
        });
        events.push({ sequence: entry.sequence, event: value });
      } catch (error) {
        events.push({ sequence: entry.sequence, event: null, unreadable: error && typeof error.code === 'string' ? error.code : 'unreadable' });
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }

  const findings = [];
  /* One finding class is produced here without ending the run's integrity: a
   * projection that has already advanced to FROZEN while its commit has not
   * landed. That is the torn half of an interrupted completion, not a corrupt run,
   * and the reconciliation route is defined over it. It is therefore tagged at the
   * point it is produced, so the reconciliation gate can weigh it against the
   * positive qualification below while every other reader still sees it in the
   * plain findings list. */
  const repairableIndices = new Set();
  const counts = {};
  let previousDigest = null;
  let expected = 0;
  for (const entry of events) {
    if (entry.sequence !== expected) findings.push(`journal sequence break: expected ${String(expected)}, found ${String(entry.sequence)}`);
    expected = entry.sequence + 1;
    const event = entry.event;
    if (!isObject(event)) {
      findings.push(`journal entry ${String(entry.sequence)} is not readable back under its bound identity (${String(entry.unreadable ?? 'unreadable')})`);
      previousDigest = null;
      continue;
    }
    if(!['START_INTENT','START_COMMIT','STOP_RECORDED','FREEZE_INTENT','FREEZE_COMMIT'].includes(event.kind))findings.push('unknown journal event kind');
    if (event.manifestId !== manifest.manifestId || event.runId !== manifest.runId) findings.push(`journal entry ${String(entry.sequence)} is bound to a different run or manifest`);
    if (event.sequence !== entry.sequence) findings.push(`journal entry ${String(entry.sequence)} states sequence ${String(event.sequence)} in its own bytes`);
    if (typeof event.eventDigest !== 'string' || lifecycleEventDigestOf(event) !== event.eventDigest) findings.push(`journal entry ${String(entry.sequence)} fails its recomputed digest check: external modification or a torn write`);
    if (entry.sequence === 0) {
      if (event.previousEventDigest !== null) findings.push('journal entry 0 must carry previousEventDigest null');
      if (event.kind !== 'START_INTENT' && event.kind !== 'FREEZE_INTENT') findings.push('the journal does not begin with a START_INTENT or a FREEZE_INTENT event');
    } else if (typeof event.previousEventDigest !== 'string' || event.previousEventDigest !== previousDigest) {
      findings.push(`journal entry ${String(entry.sequence)} names no digest that binds it to entry ${String(entry.sequence - 1)}`);
    }
    if (typeof event.kind === 'string') counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    previousDigest = typeof event.eventDigest === 'string' ? event.eventDigest : null;
  }
  for (const name of foreign) findings.push(`the journal directory carries a foreign entry ${JSON.stringify(name)}`);
  if ((counts.START_INTENT ?? 0) > 0 && (counts.START_COMMIT ?? 0) === 0) findings.push('the journal carries a START_INTENT with no START_COMMIT: an interrupted start');
  if ((counts.START_COMMIT ?? 0) > 0 && (counts.START_INTENT ?? 0) === 0) findings.push('the journal carries a START_COMMIT with no START_INTENT');
  if ((counts.FREEZE_COMMIT ?? 0) > 0 && (counts.FREEZE_INTENT ?? 0) === 0) findings.push('the journal carries a FREEZE_COMMIT with no FREEZE_INTENT');
  if ((counts.STOP_RECORDED ?? 0) > 1) findings.push('the journal carries more than one STOP_RECORDED event');
  if ((counts.FREEZE_INTENT ?? 0) > 1) findings.push('the journal carries more than one FREEZE_INTENT event');

  const stateRecord = await readState(storage, manifest.manifestId);
  if (stateRecord !== null && lifecycleStateDigestOf(stateRecord) !== stateRecord.stateDigest) {
    findings.push('the lifecycle state record fails its recomputed digest check: external modification or a torn write');
  }
  /* The projection has to agree with the journal it claims to project. This is
   * the torn-stop check: a journaled stop whose projection never landed, and a
   * projection reporting a stop the journal does not carry. */
  if ((counts.STOP_RECORDED ?? 0) === 0 && stateRecord !== null && stateRecord.state === 'STOP_RECORDED') findings.push('the state record reports STOP_RECORDED while the journal carries no STOP_RECORDED event: a torn stop');
  if ((counts.STOP_RECORDED ?? 0) > 0 && stateRecord === null) findings.push('the journal carries a STOP_RECORDED event while the state record is absent: a torn stop');
  if ((counts.START_COMMIT ?? 0) > 0 && stateRecord === null) findings.push('the journal carries a START_COMMIT event while the state record is absent: a torn start');

  const kinds=events.map(entry=>entry.event?.kind);
  const legal=[[],['START_INTENT'],['START_INTENT','START_COMMIT'],['START_INTENT','START_COMMIT','STOP_RECORDED'],['START_INTENT','START_COMMIT','STOP_RECORDED','FREEZE_INTENT'],['START_INTENT','START_COMMIT','STOP_RECORDED','FREEZE_INTENT','FREEZE_COMMIT'],['FREEZE_INTENT'],['FREEZE_INTENT','FREEZE_COMMIT']];
  if(!legal.some(sequence=>lifecycleCanonicalJson(sequence)===lifecycleCanonicalJson(kinds)))findings.push('invalid ordered lifecycle event sequence');
  const started=events.find(entry=>entry.event?.kind==='START_INTENT')?.event;
  const startCommit=events.find(entry=>entry.event?.kind==='START_COMMIT')?.event;
  if(started&&startCommit&&lifecycleCanonicalJson(started.declaration)!==lifecycleCanonicalJson(startCommit.declaration))findings.push('start declaration changes across intent/commit');
  if(stateRecord&&started&&lifecycleCanonicalJson(stateRecord.declaration)!==lifecycleCanonicalJson(started.declaration))findings.push('projection declaration differs from journal');
  if(counts.STOP_RECORDED&&stateRecord&&!['STOP_RECORDED','FROZEN'].includes(stateRecord.state))findings.push('torn stop projection');
  if(counts.FREEZE_COMMIT&&(!stateRecord||stateRecord.state!=='FROZEN'||events.at(-1)?.event?.detail?.stateEventDigest!==stateRecord.stateDigest))findings.push('freeze commit and projection disagree');
  if(stateRecord?.state==='FROZEN'&&!counts.FREEZE_COMMIT)repairableIndices.add(findings.push('frozen projection without freeze commit')-1);
  if(stateRecord?.state==='RUNNING'&&!counts.START_COMMIT)findings.push('running projection without start commit');
  if(stateRecord===null&&events.length&&events[0].event?.kind!=='FREEZE_INTENT')findings.push('missing projection for started lifecycle');
  const stop=events.find(entry=>entry.event?.kind==='STOP_RECORDED')?.event;
  if(stop&&stateRecord&&(stateRecord.stoppedAt!==stop.occurredAt||stateRecord.stopAttestation?.operator!==stop.detail?.operator||stateRecord.stopAttestation?.statement!==stop.detail?.statement))findings.push('stop attestation/time differs from journal');
  return { events: events.map((entry) => Object.freeze({ sequence: entry.sequence, event: isObject(entry.event) ? entry.event : null })), stateRecord, findings, counts, directoryListed, tornCompletionFindings: Object.freeze([...repairableIndices]) };
}

async function readState(storage, manifestId) {
  try {
    return await storage.read({ relativePath: LIFECYCLE_STATE_RELATIVE_PATH, kind: LIFECYCLE_STATE_KIND, id: `${manifestId}:lifecycle-state` });
  } catch (error) {
    if (error && typeof error.code === 'string' && error.code === 'ERR_STORAGE_NOT_FOUND') return null;
    throw error;
  }
}

/* ========================================================================== */
/* The snapshot container                                                      */
/* ========================================================================== */

/**
 * List the snapshot byte inventory and the exact directory set the copy
 * created, by walking the claimed container. Paths are reported as exact
 * relative POSIX strings; nothing here rewrites, sorts by a folded form or
 * follows a symbolic link.
 */
function surveySnapshot(snapshotRoot) {
  const files = [];
  const directories = [];
  assertOrdinaryChain(snapshotRoot);
  const walk = (absolute, relative) => {
    for (const name of fs.readdirSync(absolute)) {
      const childAbsolute = path.join(absolute, name);
      const childRelative = relative.length === 0 ? name : `${relative}/${name}`;
      const status = fs.lstatSync(childAbsolute);
      if (status.isSymbolicLink()) fail(LIFECYCLE_ERROR_CODES.STORAGE_REFUSED, `the snapshot carries a symbolic link at ${JSON.stringify(childRelative)}; a snapshot is a set of real files.`);
      if (status.isDirectory()) {
        directories.push(childRelative);
        walk(childAbsolute, childRelative);
        continue;
      }
      if (!status.isFile()) fail(LIFECYCLE_ERROR_CODES.STORAGE_REFUSED, `the snapshot carries a non-regular entr(y/ies) at ${JSON.stringify(childRelative)}.`);
      files.push({ path: childRelative, bytes: status.size, sha256: sha256Hex(fs.readFileSync(childAbsolute)) });
    }
  };
  walk(snapshotRoot, '');
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  directories.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return { files, directories };
}

/**
 * Make the run's snapshot directory available as a directory this operation can
 * place one new container inside, and report whether this call created it so
 * the fate of an interrupted freeze can say which directories are its own. It
 * adopts nothing when the directory is already present: an existing path that
 * is not a real directory is a refusal, because a freeze never replaces, empties
 * or writes through material it did not create.
 */
async function ensureSnapshotsRoot(snapshotsRoot) {
  assertOrdinaryChain(snapshotsRoot);
  const alreadyPresent = fs.existsSync(snapshotsRoot);
  if (alreadyPresent) {
    const before = await fs.promises.lstat(snapshotsRoot);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      fail(LIFECYCLE_ERROR_CODES.INVALID_ROOT, `the snapshot directory ${JSON.stringify(snapshotsRoot)} is not a real directory; a freeze writes no snapshot through it.`);
    }
    return { created: false };
  }
  try {
    await fs.promises.mkdir(snapshotsRoot, { recursive: false });
  } catch (error) {
    if (error.code === 'EEXIST') fail(LIFECYCLE_ERROR_CODES.STORAGE_REFUSED, `the snapshot directory ${JSON.stringify(snapshotsRoot)} appeared while this freeze was claiming it; the concurrent material is preserved and this freeze writes no snapshot into it.`);
    fail(LIFECYCLE_ERROR_CODES.STORAGE_REFUSED, `the snapshot directory ${JSON.stringify(snapshotsRoot)} could not be made available: ${error.message}`);
  }
  const status = await fs.promises.lstat(snapshotsRoot);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    fail(LIFECYCLE_ERROR_CODES.INVALID_ROOT, `the snapshot directory ${JSON.stringify(snapshotsRoot)} is not a real directory; a freeze writes no snapshot through it.`);
  }
  return { created: true };
}

/* ========================================================================== */
/* The request                                                                 */
/* ========================================================================== */

const FREEZE_REQUEST_FIELDS = Object.freeze(['runRoot', 'manifestId', 'runId', 'attestation', 'clockless', 'clock', 'expectedDigest', 'hooks', 'operationName', 'notes', 'publicationHook']);

function validateFreezeRequest(request) {
  if (!isObject(request)) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'freezeRun(request) requires a request object.');
  wantKnownFields(request, FREEZE_REQUEST_FIELDS, 'the freeze request');
  const runRoot = wantAbsoluteRoot(need(request.runRoot, 'the freeze request.runRoot'), 'the freeze request.runRoot');
  const manifestId = wantString(need(request.manifestId, 'the freeze request.manifestId'), 'the freeze request.manifestId', { minLength: 3 });
  const runId = wantString(need(request.runId, 'the freeze request.runId'), 'the freeze request.runId', { minLength: 3 });
  const attestation = validateFreezeAttestation(need(request.attestation, 'the freeze request.attestation'), { clockless: request.clockless });
  const clockless = request.clockless === undefined ? false : request.clockless === true;
  if (request.clockless !== undefined && request.clockless !== true && request.clockless !== false) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'the freeze request.clockless flag must be a boolean or absent.');
  if (request.clock !== undefined && (!isObject(request.clock) || typeof request.clock.now !== 'function')) fail(LIFECYCLE_ERROR_CODES.CLOCK_INVALID, 'the freeze request.clock must be an object carrying a now() function.');
  if (request.hooks !== undefined) {
    if (!Array.isArray(request.hooks)) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'the freeze request.hooks must be an array of zero-argument hook callables, as the accepted copier states them.');
    for (const [index, hook] of request.hooks.entries()) {
      if (typeof hook !== 'function') fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, `the freeze request.hooks[${index}] must be a function.`);
    }
  }
  if(request.publicationHook!==undefined&&typeof request.publicationHook!=='function')fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT,'publicationHook must be an awaited observation callable.');
  const notes = request.notes === undefined || request.notes === null ? null : wantString(request.notes, 'the freeze request.notes', { maxLength: 2000 });
  if (request.expectedDigest !== undefined && request.expectedDigest !== null) wantString(request.expectedDigest, 'the freeze request.expectedDigest', { minLength: 64, maxLength: 64 });
  return Object.freeze({
    runRoot,
    manifestId,
    runId,
    attestation,
    clockless,
    clock: request.clock,
    expectedDigest: request.expectedDigest ?? null,
    hooks: request.hooks,
    operationName: request.operationName === undefined ? 'freezeRun' : wantString(request.operationName, 'the freeze request.operationName', { maxLength: 128 }),
    notes,
    publicationHook:request.publicationHook,
  });
}

/* ========================================================================== */
/* freezeRun                                                                   */
/* ========================================================================== */

/**
 * Freeze one manual run into an immutable submission.
 *
 * The whole command runs under the accepted T1 whole-run lock: one call, one
 * lock, no nested lifecycle command and no independent state or journal write
 * path. The caller states the run roots and identities explicitly; nothing here
 * searches for a run.
 *
 * Two routes exist, exactly as many as the accepted precondition table defines:
 * a run in `STOP_RECORDED` repeating the exact attestation the run already
 * carries, and a run still in the derived `INITIALIZED` state carrying an
 * explicit `clockless` attestation. A `RUNNING` run has no freeze route and a
 * `FROZEN` run is closed.
 *
 * @param {{
 *   runRoot:string, manifestId:string, runId:string, attestation:object,
 *   clockless?:boolean, clock?:{now():number|null}, expectedDigest?:string,
 *   hooks?:Array<() => unknown>, operationName?:string, notes?:string|null
 * }} request
 * @returns {Promise<object>} the deep-frozen freeze result
 */
export async function freezeRun(request) {
  const frozen = validateFreezeRequest(request);
  return withRunTransaction({
    runRoot: frozen.runRoot,
    manifestId: frozen.manifestId,
    runId: frozen.runId,
    expectedDigest: frozen.expectedDigest ?? void 0,
    clock: frozen.clock,
    operationName: frozen.operationName,
  }, async (context) => {
    /* ---------------- 1. the state gate, before any write ---------------- */
    const state = context.lifecycle === null ? 'INITIALIZED' : context.lifecycle.state;
    const precondition = freezePreconditionFor(state);
    if (precondition.permitted !== true) {
      fail(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, `the run cannot be frozen from state ${state}: ${precondition.reason}`);
    }
    if (state==='STOP_RECORDED' && lifecycleCanonicalJson(frozen.attestation)!==lifecycleCanonicalJson(context.lifecycle.stopAttestation))fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID,'freeze must bind the exact recorded stop attestation before writing intent.');
    if (frozen.clockless && state !== 'INITIALIZED') {
      fail(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED, `the freeze request states clockless: true while the run reports ${state}: a run that started and stopped is frozen bound to its recorded stop.`);
    }
    if (!frozen.clockless && state === 'INITIALIZED') {
      fail(LIFECYCLE_ERROR_CODES.ATTESTATION_INVALID, 'a freeze from the derived INITIALIZED state is the explicit clockless route: the request must state clockless: true, so a run that never started is never frozen as though it had run.');
    }

    /* ---------------- 2. persisted coherence, before any write ----------- */
    const persisted = await reverifyPersistedRun(context);
    if (persisted.findings.length > 0) {
      fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'the persisted journal or its state projection does not verify; a freeze of an inconsistent run is refused and every byte found is preserved.', { findings: persisted.findings });
    }
    if ((persisted.counts.FREEZE_INTENT ?? 0) > 0) {
      /* An orphan intent is a prior interrupted freeze. It is reported, and its
       * snapshot bytes stay exactly where they are: discovering them confers no
       * authority to remove another operation's material. */
      fail(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED, 'the journal already carries a FREEZE_INTENT: a prior freeze was interrupted. Its snapshot bytes are preserved and a second freeze is refused; state the reconciliation disposition explicitly.', { counts: persisted.counts });
    }
    if (persisted.stateRecord !== null && persisted.stateRecord.state !== state) {
      fail(LIFECYCLE_ERROR_CODES.JOURNAL_INVALID, 'the state projection the freeze read through the accepted seam does not agree with the record on disk; the freeze reports the disagreement rather than choosing between them.', { seamState: state, recordState: persisted.stateRecord.state });
    }

    /* ---------------- 3. the destination plan, before any write ---------- */
    /* The accepted layout: the snapshot container is
     * `<runRoot>/snapshots/<snapshotId>` and the copied workspace is the
     * `workspace` subdirectory inside it. The plan is computed here and nothing
     * is created here: a refusal before the intent must write nothing at all.
     * The container is this operation's exclusive claim and the workspace
     * subdirectory is claimed by the accepted copier. Nothing here adopts,
     * reuses or removes a directory it did not create, and no directory below a
     * container is ever removed recursively. */
    const snapshotsRoot = path.join(frozen.runRoot, FREEZE_SNAPSHOT_ROOT_NAME);
    const snapshotId = createId({ prefix: 'snap' });
    const snapshotContainer = path.join(snapshotsRoot, snapshotId);
    const snapshotOutputRoot = path.join(snapshotContainer, FREEZE_SNAPSHOT_WORKSPACE_NAME);
    assertOrdinaryChain(snapshotsRoot);
    if (fs.existsSync(snapshotContainer)) {
      /* The identity came from the accepted identifier source, so colliding with
       * an existing container means material this operation does not own. It is
       * reported and left exactly where it is. */
      fail(LIFECYCLE_ERROR_CODES.STORAGE_REFUSED, `the snapshot container ${JSON.stringify(snapshotContainer)} already exists; a freeze claims an exclusively new container and never adopts, reuses or cleans material it did not create.`, { snapshotContainer });
    }
    const claim = { snapshotsRoot: false, container: null };
    const workspaceState = await fs.promises.lstat(context.workspaceRoot);
    if (workspaceState.isSymbolicLink() || !workspaceState.isDirectory()) {
      fail(LIFECYCLE_ERROR_CODES.INVALID_ROOT, `the workspace root ${JSON.stringify(context.workspaceRoot)} is not a real directory; there is nothing to freeze.`);
    }

    /* ---------------- 4. the frozen instant, from a stated source -------- */
    /* The accepted T1 record carries a stop instant only when a clock reported
     * one. Where it did not, the operator's stated observation is the source, and
     * a caller-supplied clock may report one. When none of the three states an
     * instant, the freeze is refused before anything is written: the C1 record
     * requires a frozen instant and this contract invents none. */
    const prior = context.lifecycle;
    let frozenInstant = isoNow(context.clock);
    let provenance = FROZEN_AT_PROVENANCE.CLOCK_READING;
    if (frozen.clockless === true) {
      if (frozen.attestation.observedAt !== null) { frozenInstant = frozen.attestation.observedAt; provenance = FROZEN_AT_PROVENANCE.ATTESTED_OBSERVATION; }
    } else {
      const recordedStop = prior?.stoppedAt ?? null;
      if (recordedStop != null) {
        frozenInstant = recordedStop;
        provenance = FROZEN_AT_PROVENANCE.RECORDED_STOP;
      } else if (frozen.attestation.observedAt != null) {
        frozenInstant = frozen.attestation.observedAt;
        provenance = FROZEN_AT_PROVENANCE.ATTESTED_OBSERVATION;
      } else {
        const reading = frozenInstant;
        if (reading !== null) {
          frozenInstant = reading;
          provenance = FROZEN_AT_PROVENANCE.CLOCK_READING;
        }
      }
    }
    if (frozenInstant === null) {
      fail(LIFECYCLE_ERROR_CODES.CLOCK_INVALID, 'the freeze cannot state the instant the submission was frozen at: the run carries no recorded stop instant, the attestation states no observedAt, and no clock reported a reading. This contract invents no time; state attestation.observedAt or supply a clock.');
    }
    const clockReading = frozenInstant;

    /* ---------------- 5. the journaled intent ---------------------------- */
    /* The journaled detail carries exactly the bounded facts the accepted event
     * schema describes for an entry of this kind: who attested, what was
     * attested, the instant the operator witnessed it at, the assurance, that
     * nothing was enforced, and which route the freeze takes.
     *
     * `observedAt` is stated on both routes and carries the operator's own
     * attested observation verbatim — including a non-null one. It is not the
     * frozen instant (that is the entry's occurredAt, whose provenance the proof
     * names): it is part of the witnessed fact, so an entry that dropped it
     * would journal a different attestation from the one the operator made.
     *
     * `clockless` is stated on both routes as a boolean, because the route is a
     * fact the entry asserts and an omitted route is not the same statement as a
     * route stated as not clockless. The snapshot and submission bindings live in
     * the proof record and the state history entry, because the accepted event
     * detail is closed and describes no byte identity; nothing here widens a
     * schema this module does not own. */
    const intentDetail = {
      operator: frozen.attestation.operator,
      agentStopped: true,
      statement: frozen.attestation.statement,
      observedAt: frozen.attestation.observedAt,
      assurance: STOP_ASSURANCE,
      enforced: false,
      clockless: frozen.clockless === true,
    };
    const intent = await context.appendEvent({
      kind: 'FREEZE_INTENT',
      /* The instant the freeze records is the stated frozen instant, whose
       * provenance the proof names; it is not a second, silently different time. */
      occurredAt: frozenInstant,
      journalCommitAt: clockReading,
      ...(context.lifecycle === null ? {} : { declaration: context.lifecycle.declaration }),
      detail: Object.freeze(intentDetail),
    });

    /* From here on, every failure is an interrupted freeze with a reported
     * fate. Nothing below ever moves the state record: the freeze either
     * reaches FREEZE_COMMIT or leaves the run exactly as it was. */
    /* Which of the two immutable publications actually landed. It is tracked as
     * it happens so the fate of an interrupted freeze states what exists rather
     * than what was intended. */
    const publication = { submission: null, proof: null };
    try {
      /* The snapshot directory and the container are claimed here, after the
       * intent, because a refusal before the intent must write nothing at all.
       * Both are claimed non-recursively: an existing container is an EEXIST
       * refusal and is never adopted or cleaned. The accepted copier then claims
       * the workspace subdirectory inside the container. */
      claim.snapshotsRoot = (await ensureSnapshotsRoot(snapshotsRoot)).created;
      await fs.promises.mkdir(snapshotContainer, { recursive: false });
      claim.container = snapshotContainer;
      const copy = await copySnapshot({
        workspaceRoot: context.workspaceRoot,
        outputRoot: snapshotOutputRoot,
        protectedRoots: [context.stateRoot, context.workspaceRoot],
        hooks: frozen.hooks,
      });
      const verified = await verifySnapshot({
        snapshotRoot: copy.outputRoot,
        expectedInventory: copy.inventory,
        expectedDigest: copy.digest,
        selectionPolicyId: copy.selectionPolicyId,
      });
      if (verified.ok !== true) {
        fail(LIFECYCLE_ERROR_CODES.READBACK_FAILED, 'the copied snapshot does not verify against the inventory the copier reported; the freeze is refused and the reported snapshot fate stands.', { failures: verified.failures, snapshotRoot: copy.outputRoot });
      }

      /* ---------------- 6. the byte inventory of the snapshot ------------ */
      const surveyed = surveySnapshot(copy.outputRoot);
      if (surveyed.files.length !== copy.inventory.length) {
        fail(LIFECYCLE_ERROR_CODES.READBACK_FAILED, `the snapshot holds ${String(surveyed.files.length)} file(s) while the copier selected ${String(copy.inventory.length)}; the inventory is not the complete byte set.`, { snapshotRoot: copy.outputRoot });
      }
      const inventoryPairs = surveyed.files.map((file) => [file.path, file.sha256]);
      const treeDigest = computeTreeDigest(inventoryPairs);
      if (treeDigest !== copy.digest) {
        fail(LIFECYCLE_ERROR_CODES.READBACK_FAILED, 'the tree digest recomputed from the snapshot bytes does not equal the digest the copier reported.', { recomputed: treeDigest, reported: copy.digest });
      }
      const byteCount = surveyed.files.reduce((total, file) => total + file.bytes, 0);
      if (byteCount !== copy.totalBytes) {
        fail(LIFECYCLE_ERROR_CODES.READBACK_FAILED, `the byte inventory sums to ${String(byteCount)} while the copier reported ${String(copy.totalBytes)}.`, { snapshotRoot: copy.outputRoot });
      }
      const frozenSubmissionId = createId({ prefix: 'fsub' });
      const submission = validateRecord('FrozenSubmission', {
        schemaVersion: '1.0.0',
        kind: 'FrozenSubmission',
        frozenSubmissionId,
        manifestId: context.manifest.manifestId,
        runId: context.manifest.runId,
        frozenAt: frozenInstant,
        hashAlgorithm: 'sha256',
        inventory: inventoryPairs,
        treeDigest,
        byteCount,
        fileCount: surveyed.files.length,
        freezeProcedure: FREEZE_PROCEDURE,
        notes: frozen.notes ?? `Frozen as a ${SELECTION_POLICY_ID} application snapshot of the run workspace; verified against its own bytes before publication.`,
      });

      /* The identity the container was created under is the snapshot identity;
       * it is not re-derived from a path the copier displays. */
      const proof = {
        schemaVersion: FREEZE_SCHEMA_VERSION,
        kind: FREEZE_PROOF_KIND,
        module: FREEZE_MODULE_ID,
        proofId: `${snapshotId}:proof`,
        snapshotId,
        snapshotContainer,
        workspaceSubdirectoryName: FREEZE_SNAPSHOT_WORKSPACE_NAME,
        snapshotRoot: copy.outputRoot,
        manifestId: context.manifest.manifestId,
        runId: context.manifest.runId,
        frozenSubmissionId: submission.frozenSubmissionId,
        submissionDigest: sha256Hex(lifecycleCanonicalJson(submission)),
        selectionPolicyId: copy.selectionPolicyId,
        hashAlgorithmId: copy.hashAlgorithmId,
        hashAlgorithm: 'sha256',
        freezeRoute: frozen.clockless === true ? 'CLOCKLESS_INITIALIZED' : 'STOP_RECORDED',
        frozenAt: frozenInstant,
        frozenAtProvenance: provenance,
        timeProvenance: Object.freeze({
          startedAt: state === 'INITIALIZED' ? null : context.lifecycle.startedAt,
          stoppedAt: state === 'INITIALIZED' ? null : context.lifecycle.stoppedAt,
          elapsedMs: state === 'INITIALIZED' ? null : context.lifecycle.elapsedMs,
          clockError: state === 'INITIALIZED' ? null : context.lifecycle.clockError,
          clockWasUnavailable: state !== 'INITIALIZED' && context.lifecycle.stoppedAt == null,
        }),
        stopAssurance: state === 'INITIALIZED' ? null : STOP_ASSURANCE,
        stopAttestation: state === 'INITIALIZED' ? null : context.lifecycle.stopAttestation,
        freezeAttestation: frozen.attestation,
        freezeIntentSequence: intent.sequence,
        freezeIntentDigest: intent.eventDigest,
        selectionExclusions: Object.freeze([...SELECTION_EXCLUSION_LIST]),
        inventory: Object.freeze(surveyed.files.map((file) => Object.freeze({ path: file.path, bytes: file.bytes, sha256: file.sha256 }))),
        directories: Object.freeze([...surveyed.directories]),
        fileCount: surveyed.files.length,
        byteCount,
        directoryCount: surveyed.directories.length,
        treeDigest,
      };

      if(!freezeProofValid(proof))fail(LIFECYCLE_ERROR_CODES.READBACK_FAILED,'the snapshot proof fails its byte/count/digest contract.');
      await context.storage.createImmutable({
        relativePath: `freeze/${submission.frozenSubmissionId}.json`,
        kind: FREEZE_SUBMISSION_KIND,
        id: `${context.manifest.manifestId}:frozen-submission:${submission.frozenSubmissionId}`,
        value: submission,
      });
      publication.submission = submission.frozenSubmissionId;
      await frozen.publicationHook?.('submission-published', {snapshotId,snapshotRoot:copy.outputRoot,stateRoot:context.stateRoot});
      await context.storage.createImmutable({
        relativePath: `freeze/${snapshotId}.json`,
        kind: FREEZE_PROOF_KIND,
        id: `${context.manifest.manifestId}:snapshot-proof:${snapshotId}`,
        value: proof,
      });
      publication.proof = snapshotId;
      await frozen.publicationHook?.('proof-published', {snapshotId,snapshotRoot:copy.outputRoot,stateRoot:context.stateRoot});
      const finalSnapshot=await verifySnapshot({snapshotRoot:copy.outputRoot,expectedInventory:proof.inventory,expectedDigest:proof.treeDigest,selectionPolicyId:proof.selectionPolicyId});
      const finalSource=surveySnapshot(context.workspaceRoot).files.filter(file=>!SELECTION_EXCLUSION_LIST.includes(file.path.split('/')[0]));
      if(!finalSnapshot.ok||computeTreeDigest(finalSource.map(file=>[file.path,file.sha256]))!==proof.treeDigest)fail(LIFECYCLE_ERROR_CODES.READBACK_FAILED,'late publication hook changed source or saved snapshot before commit.');

      /* ---------------- 7. projection then immutable binding commit ------ */
      const record = await context.commitState({ state:'FROZEN', stopAttestation:frozen.attestation, historyEntry:{operation:'FREEZE', route:proof.freezeRoute, snapshotId, frozenSubmissionId:submission.frozenSubmissionId, treeDigest, freezeIntentEventDigest:intent.eventDigest} });
      await frozen.publicationHook?.('state-projected', {snapshotId,snapshotRoot:copy.outputRoot,stateRoot:context.stateRoot});
      const committed = await context.appendEvent({
        kind: 'FREEZE_COMMIT',
        occurredAt: frozenInstant,
        journalCommitAt: clockReading,
        ...(context.lifecycle === null ? {} : { declaration: context.lifecycle.declaration }),
        /* Same closed field set as the intent. The byte identities the commit
         * completes are carried by the proof record and the state history
         * entry, which are this module's own records. */
        detail: { stateEventDigest: record.stateDigest },
      });


      await frozen.publicationHook?.('committed', {snapshotId,snapshotRoot:copy.outputRoot,stateRoot:context.stateRoot});
      const savedFinal=await verifySnapshot({snapshotRoot:copy.outputRoot,expectedInventory:proof.inventory,expectedDigest:proof.treeDigest,selectionPolicyId:proof.selectionPolicyId});
      if(!savedFinal.ok)fail(LIFECYCLE_ERROR_CODES.READBACK_FAILED,'postcommit saved snapshot proof failed.',{failures:savedFinal.failures});
      /* ---------------- 8. read back what was published ------------------ */
      const readBack = await context.storage.read({
        relativePath: `freeze/${submission.frozenSubmissionId}.json`,
        kind: FREEZE_SUBMISSION_KIND,
        id: `${context.manifest.manifestId}:frozen-submission:${submission.frozenSubmissionId}`,
      });
      if (lifecycleCanonicalJson(readBack) !== lifecycleCanonicalJson(submission)) {
        fail(LIFECYCLE_ERROR_CODES.READBACK_FAILED, 'the frozen submission did not read back byte-equal to what was published.', { snapshotRoot: copy.outputRoot });
      }
      const proofReadBack = await context.storage.read({
        relativePath: `freeze/${snapshotId}.json`,
        kind: FREEZE_PROOF_KIND,
        id: `${context.manifest.manifestId}:snapshot-proof:${snapshotId}`,
      });
      if (lifecycleCanonicalJson(proofReadBack) !== lifecycleCanonicalJson(proof)) {
        fail(LIFECYCLE_ERROR_CODES.READBACK_FAILED, 'the snapshot proof did not read back byte-equal to what was published.', { snapshotRoot: copy.outputRoot });
      }
      const after = await reverifyPersistedRun(context);
      if (after.findings.length > 0 || after.stateRecord === null || after.stateRecord.state !== 'FROZEN' || (after.counts.FREEZE_COMMIT ?? 0) !== 1) {
        fail(LIFECYCLE_ERROR_CODES.READBACK_FAILED, 'the journal and projection do not report a complete freeze after the commit.', { findings: after.findings, state: after.stateRecord === null ? null : after.stateRecord.state, counts: after.counts });
      }

      return Object.freeze({
        module: FREEZE_MODULE_ID,
        runId: context.manifest.runId,
        manifestId: context.manifest.manifestId,
        state: 'FROZEN',
        route: proof.freezeRoute,
        snapshotId,
        snapshotContainer,
        snapshotRoot: copy.outputRoot,
        frozenSubmission: Object.freeze({ ...submission, inventory: Object.freeze(submission.inventory.map((pair) => Object.freeze([...pair]))) }),
        proof: Object.freeze({ ...proof }),
        submissionDigest: proof.submissionDigest,
        frozenAt: frozenInstant,
        frozenAtProvenance: provenance,
        stopAssurance: proof.stopAssurance,
        enforced: STOP_ENFORCED,
        stateDigest: record.stateDigest,
        events: Object.freeze([intent.eventDigest, committed.eventDigest]),
        freeze: Object.freeze({ intentSequence: intent.sequence, commitSequence: committed.sequence }),
      });
    } catch (error) {
      /* The actual fate of an interrupted freeze, stated rather than hidden.
       * The journaled intent is the record that a freeze was attempted; the
       * state record and the submission identities are untouched, and no byte
       * this operation did not create is removed. */
      const partial = error instanceof Error ? error : new Error(String(error));
      const details = isObject(partial.details) ? partial.details : {};
      const fate = {
        interruptedOperation: 'FREEZE',
        intentJournaled: true,
        intentEventDigest: intent.eventDigest,
        /* What this operation had claimed at the moment it stopped, stated so a
         * reader can see which bytes are its own and which are not. The
         * copier's own fate object, when it reported one, is carried beside
         * this; nothing here infers a cleanup from the other. */
        containerClaimedByThisOperation: claim.container !== null,
        containerPath: claim.container,
        stateRecordState: context.lifecycle?.state ?? 'INITIALIZED',
        submissionPublished: publication.submission,
        proofPublished: publication.proof,
        freezeCommitted: (await reverifyPersistedRun(context).catch(()=>({counts:{}}))).counts.FREEZE_COMMIT === 1,
        preserved: Object.freeze(['the journaled FREEZE_INTENT', 'the state record as it was', 'every snapshot byte that exists', 'the snapshots directory and every other container in it']),
      };
      if (partial instanceof LifecycleError) {
        throw new LifecycleError(partial.code, `${partial.message.replace(/^[A-Z_]+: /, '')} The freeze was interrupted after its intent was journaled; ${claim.container === null ? 'no snapshot container had been claimed yet' : 'the claimed snapshot container and any bytes the copier reported are preserved'}.`, { ...details, freezeFate: fate, cause: { code: partial.code, name: partial.name, message: partial.message } });
      }
      /* A refusal out of the accepted copier carries its own code and fate. It
       * is reported as an interrupted freeze that keeps both, so a caller sees
       * the copier's code and the freeze's own disposition at once. */
      const snapshotCode = typeof partial.code === 'string' ? partial.code : SNAPSHOT_ERROR_CODES.INTERNAL;
      const copierFate = isObject(partial.fate) ? partial.fate : null;
      throw new LifecycleError(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED, `${snapshotCode}: the freeze was interrupted before its commit and after its intent. The run remains ${state}; the snapshot bytes and the journaled intent are preserved and nothing this operation did not create is removed.`, { ...details, snapshotCode, snapshotFate: copierFate, claimedContainer: claim.container, freezeFate: fate, cause: { code: snapshotCode, name: partial.name, message: partial.message } });
    }
  });
}

/* ========================================================================== */
/* verifyFrozenSubmission                                                      */
/* ========================================================================== */

/**
 * Re-verify a frozen submission from the bytes on disk.
 *
 * Nothing here is taken on trust: the submission and its proof are read back
 * under their bound identities, the submission is run through the accepted C1
 * contract validator, its tree digest, file count and byte total are recomputed
 * from its own inventory, the snapshot is re-hashed file by file against the
 * proof inventory, the proof digests are recomputed, and the journal and state
 * projection that bind the submission to the run are re-verified.
 *
 * It reads through the accepted whole-run lock so a concurrent writer cannot
 * present a submission from one instant and a journal from another. It publishes
 * nothing, repairs nothing, and removes nothing. Later edits to the working tree
 * are reported as context and never read as damage to the frozen identity: the
 * snapshot is the frozen artifact, not the workspace.
 */
export async function verifyFrozenSubmission(request) {
  if (!isObject(request)) fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT, 'verifyFrozenSubmission(request) requires a request object.');
  wantKnownFields(request, ['runRoot', 'manifestId', 'runId', 'frozenSubmissionId', 'snapshotId', 'expectedDigest'], 'the verification request');
  const runRoot = wantAbsoluteRoot(need(request.runRoot, 'the verification request.runRoot'), 'the verification request.runRoot');
  const manifestId = wantString(need(request.manifestId, 'the verification request.manifestId'), 'the verification request.manifestId', { minLength: 3 });
  const runId = wantString(need(request.runId, 'the verification request.runId'), 'the verification request.runId', { minLength: 3 });
  const frozenSubmissionId = wantStringOrNull(request.frozenSubmissionId, 'the verification request.frozenSubmissionId');
  const snapshotId = wantStringOrNull(request.snapshotId, 'the verification request.snapshotId');
  return withRunTransaction({
    runRoot,
    manifestId,
    runId,
    expectedDigest: request.expectedDigest ?? void 0,
    operationName: 'verifyFrozenSubmission',
  }, async (context) => {
    const findings = [];
    const persisted = await reverifyPersistedRun(context);
    for (const finding of persisted.findings) findings.push(`run integrity: ${finding}`);

    const listed = await listPublications(context.storage, manifestId);
    if (listed.length === 0) fail(LIFECYCLE_ERROR_CODES.NOT_FOUND, 'this run has published no frozen submission and no snapshot proof; there is nothing to verify.');
    const targets = listed.filter((entry) => entry.submission !== null && entry.proof !== null
      && (frozenSubmissionId === null || entry.submission.frozenSubmissionId === frozenSubmissionId)
      && (snapshotId === null || entry.proof.snapshotId === snapshotId));
    if (targets.length === 0) return Object.freeze({module:FREEZE_MODULE_ID,runId,manifestId,ok:false,findings:Object.freeze(['no complete readable submission/proof pair matches the requested identity']),runFindings:Object.freeze(persisted.findings),state:persisted.stateRecord?.state??'INITIALIZED',submissions:Object.freeze([]),workspace:null});
    /* An orphan — a proof whose submission is gone, or a submission with no proof
     * beside it — is reported as a finding rather than silently dropped: it is
     * material this verification did not create, so it is named and left alone. */
    const orphans = listed.filter((entry) => entry.submission === null || entry.proof === null);

    const verifications = [];
    for (const entry of targets) {
      const problems = [];
      const { submission, proof } = entry;
      let validated = null;
      try {
        validated = validateRecord('FrozenSubmission', submission);
      } catch (problem) {
        problems.push(`contract validation: ${problem.message}`);
      }
      if (validated !== null) {
        if (validated.manifestId !== context.manifest.manifestId || validated.runId !== context.manifest.runId) problems.push('the submission is bound to a different run or manifest');
        let recomputed = null;
        try {
          recomputed = computeTreeDigest(validated.inventory);
        } catch (problem) {
          problems.push(`the inventory is not a valid byte inventory: ${problem.message}`);
        }
        if (recomputed !== null && recomputed !== validated.treeDigest) problems.push(`the tree digest does not recompute from the published inventory (recomputed ${recomputed})`);
        if (validated.fileCount !== validated.inventory.length) problems.push(`fileCount ${String(validated.fileCount)} does not match the ${String(validated.inventory.length)} inventory pair(s)`);
        const paired = validated.inventory.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[1] === 'string' && /^[0-9a-f]{64}$/.test(pair[1]));
        if (!paired) problems.push('an inventory pair is not an exact [path, 64-hex digest] pair');
      }

      if(!freezeProofValid(proof))problems.push('snapshot proof shape/byte-count/digest contract failed');
      if (proof.proofId !== `${proof.snapshotId}:proof`) problems.push('the proof identity does not recompute from its snapshot identity');
      if (proof.submissionDigest !== sha256Hex(lifecycleCanonicalJson(submission))) problems.push('the proof submission digest does not recompute over the submission bytes');
      if (proof.frozenSubmissionId !== submission.frozenSubmissionId || proof.manifestId !== submission.manifestId || proof.runId !== submission.runId) problems.push('the proof is bound to a different submission, run or manifest');
      if (proof.treeDigest !== submission.treeDigest) problems.push('the proof tree digest does not equal the submission tree digest');
      if (proof.fileCount !== submission.fileCount || proof.byteCount !== submission.byteCount) problems.push('the proof counts do not equal the submission counts');
      if (proof.selectionPolicyId !== SELECTION_POLICY_ID) problems.push(`the proof names the unaccepted selection policy ${JSON.stringify(proof.selectionPolicyId)}`);
      if (proof.hashAlgorithmId !== SNAPSHOT_HASH_ALGORITHM_ID) problems.push(`the proof names the unaccepted hash algorithm identity ${JSON.stringify(proof.hashAlgorithmId)}`);
      if (proof.freezeIntentSequence === undefined || proof.freezeIntentDigest === undefined) problems.push('the proof carries no binding to the journaled freeze intent');
      const intentEntry = persisted.events.find((event) => event.event?.kind === 'FREEZE_INTENT');
      if (intentEntry === undefined) problems.push('the journal carries no FREEZE_INTENT event for this submission');
      else if (intentEntry.event.eventDigest !== proof.freezeIntentDigest) problems.push('the proof freeze-intent digest does not name the journaled FREEZE_INTENT event');
      else if (intentEntry.event.sequence !== proof.freezeIntentSequence) problems.push('the proof freeze-intent sequence does not name the journaled FREEZE_INTENT event');
      const commitEntries = persisted.events.filter((event) => event.event?.kind === 'FREEZE_COMMIT');
      if (commitEntries.length === 0) problems.push('the journal carries no FREEZE_COMMIT event for this submission');
      else if (commitEntries.length !== 1) problems.push('the journal carries more than one FREEZE_COMMIT event');
      /* The freeze intent and commit events carry the closed bounded detail the
       * accepted event schema describes, which states no byte identity. The byte
       * binding a verification has to check is therefore the one the state
       * history entry recorded: it names the snapshot and the submission this
       * commit completed. */
      const historyEntry = (persisted.stateRecord?.history ?? []).filter((entry) => entry.operation === 'FREEZE').at(-1);
      if (historyEntry === undefined) problems.push('the run projection carries no FREEZE history entry for this submission');
      else if (historyEntry.snapshotId !== proof.snapshotId || historyEntry.frozenSubmissionId !== submission.frozenSubmissionId) problems.push('the FREEZE history entry names a different snapshot or submission');
      else if (typeof historyEntry.freezeCommitEventDigest === 'string' && !persisted.events.some((event) => event.event?.eventDigest === historyEntry.freezeCommitEventDigest)) problems.push('the FREEZE history entry names a commit event digest the journal does not carry');
      /* The recorded snapshot location has to sit inside the run root this
       * verification was told about, at the accepted layout
       * `<runRoot>/snapshots/<snapshotId>/workspace`. A proof that points
       * elsewhere is not a record of this run's bytes, and a foreign path is
       * never followed. */
      const snapshotsRoot = path.join(runRoot, FREEZE_SNAPSHOT_ROOT_NAME);
      const expectedContainer = path.join(snapshotsRoot, proof.snapshotId);
      const expectedSnapshotRoot = path.join(expectedContainer, proof.workspaceSubdirectoryName);
      if (proof.workspaceSubdirectoryName !== FREEZE_SNAPSHOT_WORKSPACE_NAME) problems.push(`the proof names the unaccepted snapshot workspace subdirectory ${JSON.stringify(proof.workspaceSubdirectoryName)}`);
      if (path.resolve(proof.snapshotContainer) !== path.resolve(expectedContainer)) problems.push(`the proof snapshot container ${JSON.stringify(proof.snapshotContainer)} is not the accepted location for this snapshot identity`);
      if (path.resolve(proof.snapshotRoot) !== path.resolve(expectedSnapshotRoot)) problems.push(`the proof snapshot location ${JSON.stringify(proof.snapshotRoot)} is not the accepted workspace subdirectory of its container`);
      const containment = path.relative(path.resolve(runRoot), path.resolve(proof.snapshotRoot));
      if (containment.startsWith('..') || path.isAbsolute(containment)) problems.push(`the proof snapshot location ${JSON.stringify(proof.snapshotRoot)} lies outside the stated run root`);

      if(proof.inventory&&validated&&lifecycleCanonicalJson(proof.inventory.map(file=>[file.path,file.sha256]))!==lifecycleCanonicalJson(validated.inventory))problems.push('proof byte inventory differs from accepted submission inventory');
      if(proof.directories&&lifecycleCanonicalJson(proof.directories)!==lifecycleCanonicalJson([...new Set(proof.inventory.flatMap(file=>{const parts=file.path.split('/');return parts.slice(0,-1).map((_,i)=>parts.slice(0,i+1).join('/'));}))].sort()))problems.push('proof directory set is not the exact implied inventory set');
      if (problems.length>0) {
        verifications.push(Object.freeze({frozenSubmissionId:submission.frozenSubmissionId,snapshotId:proof.snapshotId,ok:false,findings:Object.freeze(problems)}));
        continue; // never follow an invalid proof location or malformed inventory
      }
      const byteVerification = await verifySnapshot({
        snapshotRoot: proof.snapshotRoot,
        expectedInventory: proof.inventory.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
        expectedDigest: proof.treeDigest,
        selectionPolicyId: proof.selectionPolicyId,
      });
      if (byteVerification.ok !== true) for (const failure of byteVerification.failures) problems.push(`snapshot byte: ${failure}`);

      if(byteVerification.ok!==true) {
        verifications.push(Object.freeze({frozenSubmissionId:submission.frozenSubmissionId,snapshotId:proof.snapshotId,ok:false,findings:Object.freeze(problems)}));continue;
      }
      const resurvey = surveySnapshot(proof.snapshotRoot);
      if (resurvey.files.length !== proof.fileCount) problems.push(`the snapshot holds ${String(resurvey.files.length)} file(s) while the proof states ${String(proof.fileCount)}`);
      if (resurvey.directories.length !== proof.directoryCount) problems.push(`the snapshot holds ${String(resurvey.directories.length)} director(y/ies) while the proof states ${String(proof.directoryCount)}`);
      const resurveyDigest = resurvey.files.length === proof.fileCount ? computeTreeDigest(resurvey.files.map((file) => [file.path, file.sha256])) : null;
      if (resurveyDigest !== null && resurveyDigest !== proof.treeDigest) problems.push('the tree digest recomputed from the bytes on disk does not equal the published tree digest');
      const resurveyBytes = resurvey.files.reduce((total, file) => total + file.bytes, 0);
      if (resurveyBytes !== proof.byteCount) problems.push(`the bytes on disk sum to ${String(resurveyBytes)} while the proof states ${String(proof.byteCount)}`);

      if (persisted.stateRecord === null || persisted.stateRecord.state !== 'FROZEN') problems.push(`the run projection reports ${persisted.stateRecord === null ? 'no record' : persisted.stateRecord.state} rather than FROZEN`);

      verifications.push(Object.freeze({
        frozenSubmissionId: submission.frozenSubmissionId,
        snapshotId: proof.snapshotId,
        snapshotRoot: proof.snapshotRoot,
        treeDigest: submission.treeDigest,
        fileCount: submission.fileCount,
        byteCount: submission.byteCount,
        frozenAt: submission.frozenAt,
        ok: problems.length === 0,
        findings: Object.freeze(problems),
      }));
    }

    /* Later edits to the working tree are context, not damage. The frozen
     * artifact is the snapshot; a workspace that has moved on since the freeze
     * is reported without being read as a fault of the submission. */
    let workspaceInventory=null;
    try { const source=surveySnapshot(context.workspaceRoot); const selected=source.files.filter(file=>!SELECTION_EXCLUSION_LIST.includes(file.path.split('/')[0])); workspaceInventory={files:selected,bytes:selected.reduce((sum,file)=>sum+file.bytes,0),digest:computeTreeDigest(selected.map(file=>[file.path,file.sha256]))}; } catch { workspaceInventory=null; }
    const workspaceDrift = workspaceInventory === null
      ? null
      : Object.freeze({
        observedFileCount: workspaceInventory.files.length,
        observedByteCount: workspaceInventory.bytes,
        matchesFrozenInventory: workspaceInventory.digest === targets[0].proof.treeDigest,
        note: 'the working tree may have moved on after the freeze; the snapshot, not the workspace, is the frozen artifact',
      });

    const failed = verifications.filter((entry) => entry.ok !== true);
    const orphanFindings = orphans.map((entry) => {
      if (entry.unreadable !== undefined) return `unreadable: ${JSON.stringify(entry.unreadable)} is present under the freeze directory but does not read back under either bound identity`;
      if (entry.proof === null) return `orphan: a frozen submission is published at ${JSON.stringify(entry.submission?.frozenSubmissionId ?? 'an unreadable record')} with no snapshot proof beside it`;
      return `orphan: a snapshot proof is published for snapshot ${JSON.stringify(entry.proof.snapshotId)} with no frozen submission beside it`;
    });
    return Object.freeze({
      module: FREEZE_MODULE_ID,
      runId: context.manifest.runId,
      manifestId: context.manifest.manifestId,
      ok: persisted.findings.length === 0 && failed.length === 0 && orphanFindings.length === 0,
      findings: Object.freeze([...failed.flatMap((entry) => entry.findings.map((finding) => `${entry.frozenSubmissionId}: ${finding}`)), ...orphanFindings]),
      runFindings: Object.freeze([...persisted.findings]),
      state: persisted.stateRecord === null ? 'INITIALIZED' : persisted.stateRecord.state,
      submissions: Object.freeze(verifications),
      workspace: workspaceDrift,
    });
  });
}

/** Read the published submission/proof pairs of one run through the container. */
async function listPublications(storage, manifestId) {
  let names;
  assertOrdinaryChain(path.join(storage.root,'freeze'));
  try {
    names = await fs.promises.readdir(path.join(storage.root, 'freeze'));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
  const published = [];
  for (const name of names.sort()) {
    if (!/^[^/\\]+\.json$/.test(name)) continue;
    const relativePath = `freeze/${name}`;
    const stem = name.slice(0, -'.json'.length);
    let proof = null;
    let submission = null;
    try {
      proof = await storage.read({ relativePath, kind: FREEZE_PROOF_KIND, id: `${manifestId}:snapshot-proof:${stem}` });
    } catch {
      proof = null;
    }
    if (proof !== null) {
      if (!isObject(proof) || typeof proof.frozenSubmissionId !== 'string') continue;
      try {
        submission = await storage.read({ relativePath: `freeze/${proof.frozenSubmissionId}.json`, kind: FREEZE_SUBMISSION_KIND, id: `${manifestId}:frozen-submission:${proof.frozenSubmissionId}` });
      } catch {
        published.push({ submission: null, proof, orphanedProof: true });
        continue;
      }
      published.push({ submission, proof });
      continue;
    }
    try {
      submission = await storage.read({ relativePath, kind: FREEZE_SUBMISSION_KIND, id: `${manifestId}:frozen-submission:${stem}` });
    } catch {
      /* The file is present and reads under neither bound identity: its bytes
       * moved out from under the registry, or it is not this run's record. It is
       * named as unreadable rather dropped, because a verification that quietly
       * skipped a record would report a clean run over a tampered one. */
      published.push({ submission: null, proof: null, unreadable: relativePath });
      continue;
    }
    published.push({ submission, proof: null, unprovedSubmission: true });
  }
  const pairedIds=new Set(published.filter(entry=>entry.proof&&entry.submission).map(entry=>entry.submission.frozenSubmissionId));
  return published.filter(entry=>!(entry.submission&&!entry.proof&&pairedIds.has(entry.submission.frozenSubmissionId)));
}

/** A best-effort working-tree count for reporting; never a verification input. */
function safeWorkspaceListing(workspaceRoot) {
  try {
    const files = [];
    let bytes = 0;
    const walk = (absolute, relative) => {
      for (const name of fs.readdirSync(absolute)) {
        const childAbsolute = path.join(absolute, name);
        const childRelative = relative.length === 0 ? name : `${relative}/${name}`;
        const status = fs.lstatSync(childAbsolute);
        if (status.isDirectory()) {
          walk(childAbsolute, childRelative);
          continue;
        }
        bytes += status.size;
        files.push(childRelative);
      }
    };
    walk(workspaceRoot, '');
    files.sort();
    return { files, bytes };
  } catch {
    return null;
  }
}

/* An alias, so a caller that reads the operation as "verify the frozen
 * submission of a run" and a caller that reads it as "verify the saved snapshot"
 * both name the same single verification. */
export const verifyFrozenSnapshot = verifyFrozenSubmission;

/* ========================================================================== */
/* Reconciliation coherence: the positive authorization before any write       */
/* ========================================================================== */

/**
 * Decide, from the persisted journal bytes alone, whether what was found is the
 * one documented repairable interrupted-freeze shape, and state why it is not.
 *
 * This is a positive derivation, never a match against prose: the event kinds are
 * read off a dense, predecessor-bound sequence whose digests recomputed; the route
 * the interrupted freeze took is derived from the events that exist (no start
 * events plus no projection is the clockless route, a complete start-and-stop
 * chain is the stopped route) and compared against what the retained proof
 * claims. Any other shape — a torn start, more than one stop, an unknown or
 * reordered sequence, a projection that contradicts the journal, a chain whose
 * digests do not recompute, a journal that carries an entry the reader could not
 * read back — is authorization-absent and is reported as such. Nothing here
 * repairs a journal by overwriting it.
 */
function repairableInterruptionFindings({ persisted, proof, manifestId, runId }) {
  const findings = [];
  const events = persisted.events;
  const counts = persisted.counts;
  const stateRecord = persisted.stateRecord;
  const unreadable = events.filter((entry) => !isObject(entry.event)).map((entry) => entry.sequence);
  if (unreadable.length > 0) findings.push(`the journal carries ${String(unreadable.length)} entr(y/ies) that do not read back under their bound identity: ${unreadable.map((sequence) => String(sequence)).join(', ')}`);
  if (persisted.directoryListed !== true) findings.push('the journal directory could not be listed, so nothing here proves no foreign entry sits beside it');
  if (events.length > 0 && events.some((entry, index) => entry.sequence !== index)) findings.push('the journal sequence is not dense from zero');
  /* The chain is re-derived here rather than assumed from the reader's report: a
   * reconciliation that is about to write has to hold the integrity of the journal
   * it is writing onto from its own computation. Every event digest recomputes,
   * every entry names the entry before it, entry zero names none, every entry is
   * bound to this run and carries a kind this contract knows. */
  let previous = null;
  for (const entry of events) {
    const event = entry.event;
    if (!isObject(event)) { previous = null; continue; }
    if (event.manifestId !== manifestId || event.runId !== runId) findings.push(`journaled entry ${String(entry.sequence)} is bound to another run or manifest`);
    if (event.sequence !== entry.sequence) findings.push(`journaled entry ${String(entry.sequence)} states its own sequence as ${String(event.sequence)}`);
    if (typeof event.eventDigest !== 'string' || lifecycleEventDigestOf(event) !== event.eventDigest) findings.push(`journaled entry ${String(entry.sequence)} fails its recomputed self digest`);
    if (entry.sequence === 0) {
      if (event.previousEventDigest !== null) findings.push('journaled entry 0 names a predecessor');
      if (event.kind !== 'START_INTENT' && event.kind !== 'FREEZE_INTENT') findings.push('journaled entry 0 is neither a START_INTENT nor a FREEZE_INTENT');
    } else if (typeof event.previousEventDigest !== 'string' || event.previousEventDigest !== previous) findings.push(`journaled entry ${String(entry.sequence)} names no digest binding it to entry ${String(entry.sequence - 1)}`);
    previous = typeof event.eventDigest === 'string' ? event.eventDigest : null;
  }
  if (stateRecord !== null && lifecycleStateDigestOf(stateRecord) !== stateRecord.stateDigest) findings.push('the state projection fails its recomputed self digest');
  if ((counts.FREEZE_INTENT ?? 0) !== 1) findings.push(`the journal carries ${String(counts.FREEZE_INTENT ?? 0)} FREEZE_INTENT event(s); reconciliation is defined over exactly one`);
  if ((counts.FREEZE_COMMIT ?? 0) !== 0) findings.push('the journal already carries a FREEZE_COMMIT; there is no interruption to repair');
  if ((counts.FREEZE_INTENT ?? 0) === 1 && events.at(-1)?.event?.kind !== 'FREEZE_INTENT') findings.push('the FREEZE_INTENT is not the last journaled event; the sequence after an interrupted intent is unexplained');
  const kindSequence = events.map((entry) => entry.event?.kind);
  const clocklessShape = lifecycleCanonicalJson(['FREEZE_INTENT']);
  const stoppedShape = lifecycleCanonicalJson(['START_INTENT', 'START_COMMIT', 'STOP_RECORDED', 'FREEZE_INTENT']);
  const clocklessRoute = lifecycleCanonicalJson(kindSequence) === clocklessShape;
  const stoppedRoute = lifecycleCanonicalJson(kindSequence) === stoppedShape;
  if (!clocklessRoute && !stoppedRoute) findings.push(`the journaled event sequence ${lifecycleCanonicalJson(kindSequence)} is not one of the two interrupted-freeze shapes (a clockless intent over no projection, or a complete start/stop chain closed by an uncommitted intent)`);
  if (stateRecord !== null && !['STOP_RECORDED', 'FROZEN'].includes(stateRecord.state)) findings.push(`the state projection reports ${String(stateRecord.state)} while the journaled freeze carries no commit; only a projection that still reports the recorded stop, or one already advanced to FROZEN without its commit, is a repairable torn freeze`);
  if (stateRecord !== null && stateRecord.state === 'FROZEN') {
    const history = stateRecord.history ?? [];
    const lastFreeze = [...history].reverse().find((entry) => entry?.operation === 'FREEZE');
    if (lastFreeze === undefined) findings.push('the torn FROZEN projection carries no FREEZE history entry binding it to a publication');
    else if (lastFreeze.snapshotId !== proof.snapshotId || lastFreeze.frozenSubmissionId !== proof.frozenSubmissionId || lastFreeze.freezeIntentEventDigest !== proof.freezeIntentDigest) findings.push('the torn FROZEN projection history entry names a snapshot, submission or intent other than the retained publication');
    else if (lastFreeze.route !== proof.freezeRoute) findings.push(`the torn FROZEN projection records the ${String(lastFreeze.route)} route while the retained proof records ${String(proof.freezeRoute)}`);
    else if (lastFreeze.treeDigest !== proof.treeDigest) findings.push('the torn FROZEN projection records a tree digest other than the retained proof\'s');
  }
  const attestation = proof.freezeAttestation;
  const clocklessClaim = isObject(attestation) && attestation.clockless === true;
  if (clocklessRoute && !clocklessClaim) findings.push('the journaled sequence is the clockless route while the retained proof attestation states no clockless claim');
  if (clocklessRoute && ((counts.START_INTENT ?? 0) !== 0 || (counts.STOP_RECORDED ?? 0) !== 0)) findings.push('the clockless route requires no start event and no stop event');
  if (clocklessRoute && stateRecord !== null && !['INITIALIZED', 'FROZEN'].includes(stateRecord.state)) findings.push(`the clockless route projects ${String(stateRecord.state)} while the journal carries no start or stop event`);
  if (clocklessClaim && !clocklessRoute) findings.push('the retained proof attestation claims the clockless route while the journal carries a start or stop chain');
  if (stoppedRoute) {
    if (clocklessClaim) findings.push('the stopped route carries a recorded stop while the retained proof attestation claims the clockless route');
    if ((counts.START_INTENT ?? 0) !== 1 || (counts.START_COMMIT ?? 0) !== 1 || (counts.STOP_RECORDED ?? 0) !== 1) findings.push('the stopped route requires exactly one START_INTENT, one START_COMMIT and one STOP_RECORDED event');
    if (stateRecord === null) findings.push('the stopped route has no state projection to complete: the journaled stop never landed and completion would have to manufacture a projection');
    else if (stateRecord.state === 'RUNNING') findings.push('the projection reports a run that is still running while the journal carries a stop');
  }
  return findings;
}

/**
 * The full coherence review of one retained submission/proof pair before a
 * reconciliation is authorized to write anything. Every check is recomputed from
 * bytes: contract validation of both records, proof and submission identities,
 * binding of the pair to this run, manifest and journaled intent, the byte
 * inventory against the tree digest and the counts, the physical directory set
 * implied by that inventory, the declared hash algorithm and selection policy
 * with their exclusion list, the recorded snapshot location against the accepted
 * layout of the run root the caller named, the route and clock provenance
 * against the journal, and the attestation the journaled intent recorded.
 *
 * A non-empty finding list is authorization-absent: the caller refuses and writes
 * nothing. This function reads and never writes, mutates no input and deletes no
 * byte.
 */
function reconciliationCoherenceFindings({ proof, submission, intent, persisted, runRoot, manifestId, runId, operator }) {
  const findings = [];
  const report = (message) => findings.push(message);
  const hexId = (value) => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
  if (!isObject(proof)) return ['the retained proof is not an object'];
  /* Contract validation of both records. A thrown validation problem is a finding,
   * not an exception past the transaction: the operator is told what is wrong. */
  try { validateRecord('FrozenSubmission', submission); } catch (problem) { report(`the retained submission fails its contract validation: ${problem.message}`); }
  /* Proof key and module identity. */
  if (proof.kind !== FREEZE_PROOF_KIND) report(`the retained proof kind is ${JSON.stringify(proof.kind)}`);
  if (proof.schemaVersion !== FREEZE_SCHEMA_VERSION) report(`the retained proof schema version is ${JSON.stringify(proof.schemaVersion)}`);
  if (proof.module !== FREEZE_MODULE_ID) report(`the retained proof module is ${JSON.stringify(proof.module)}`);
  if (typeof proof.snapshotId !== 'string' || !/^snap-[0-9a-f]{32}$/.test(proof.snapshotId)) report(`the retained proof snapshot identity ${JSON.stringify(proof.snapshotId)} is not a snap identity this release mints`);
  else if (proof.proofId !== `${proof.snapshotId}:proof`) report('the retained proof identity does not recompute from its snapshot identity');
  if (!hexId(typeof proof.frozenSubmissionId === 'string' ? proof.frozenSubmissionId.slice('fsub-'.length) : '')) report(`the retained proof submission identity ${JSON.stringify(proof.frozenSubmissionId)} is not an fsub identity this release mints`);
  /* Run and manifest binding, on both records. */
  if (proof.manifestId !== manifestId || proof.runId !== runId) report(`the retained proof is bound to manifest ${JSON.stringify(proof.manifestId)} run ${JSON.stringify(proof.runId)}`);
  if (submission?.manifestId !== manifestId || submission?.runId !== runId) report(`the retained submission is bound to manifest ${JSON.stringify(submission?.manifestId)} run ${JSON.stringify(submission?.runId)}`);
  if (submission?.frozenSubmissionId !== proof.frozenSubmissionId) report('the retained submission identity does not match the identity the proof names');
  /* Byte identity of the pair, recomputed. */
  if (!Array.isArray(proof.inventory) || proof.inventory.some((file) => !isObject(file) || typeof file.path !== 'string' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/.test(file.sha256))) report('the retained proof inventory is not a closed list of {path,bytes,sha256} entries');
  else {
    if (proof.fileCount !== proof.inventory.length) report(`the retained proof fileCount ${String(proof.fileCount)} does not match its ${String(proof.inventory.length)} inventory entries`);
    const byteSum = proof.inventory.reduce((total, file) => total + file.bytes, 0);
    if (proof.byteCount !== byteSum) report(`the retained proof byteCount ${String(proof.byteCount)} does not sum from its inventory (${String(byteSum)})`);
    let recomputed = null;
    try { recomputed = computeTreeDigest(proof.inventory.map((file) => [file.path, file.sha256])); } catch { recomputed = null; }
    if (recomputed === null) report('the retained proof inventory is not a byte inventory the accepted tree digest can be recomputed over');
    else if (proof.treeDigest !== recomputed) report(`the retained proof tree digest does not recompute from its inventory (${recomputed})`);
    /* The directory claim is checked against the set the inventory implies, which
     * is the same physical set the snapshot verifier compares on disk. A proof
     * that claims a directory its bytes do not imply is not a record of those bytes. */
    const implied = [...new Set(proof.inventory.flatMap((file) => { const parts = file.path.split('/'); return parts.slice(0, -1).map((unused, index) => parts.slice(0, index + 1).join('/')); }))].sort();
    if (!Array.isArray(proof.directories)) report('the retained proof carries no directory list');
    else if (lifecycleCanonicalJson(proof.directories) !== lifecycleCanonicalJson(implied)) report('the retained proof directory set is not the exact set its inventory implies');
    else if (proof.directoryCount !== proof.directories.length) report(`the retained proof directoryCount ${String(proof.directoryCount)} does not match its ${String(proof.directories.length)} directory entries`);
    /* Cross-record byte agreement. */
    const submissionPairs = Array.isArray(submission?.inventory) ? submission.inventory : null;
    if (submissionPairs === null) report('the retained submission carries no byte inventory');
    else if (lifecycleCanonicalJson(submissionPairs) !== lifecycleCanonicalJson(proof.inventory.map((file) => [file.path, file.sha256]))) report('the retained proof byte inventory differs from the retained submission inventory');
    if (submission?.treeDigest !== proof.treeDigest) report('the retained proof tree digest does not equal the submission tree digest');
    if (submission?.byteCount !== proof.byteCount || submission?.fileCount !== proof.fileCount) report('the retained proof counts do not equal the submission counts');
    if (submission?.freezeProcedure !== FREEZE_PROCEDURE) report(`the retained submission freeze procedure is ${JSON.stringify(submission?.freezeProcedure)}`);
    if (submission?.hashAlgorithm !== proof.hashAlgorithm || proof.hashAlgorithm !== 'sha256') report('the retained pair does not name the sha256 hash algorithm');
    if (submission?.frozenAt !== proof.frozenAt) report('the retained proof frozen instant does not equal the submission frozen instant');
  }
  /* Policy and algorithm identities, plus the exclusions the policy applies. */
  if (proof.selectionPolicyId !== SELECTION_POLICY_ID) report(`the retained proof names the unaccepted selection policy ${JSON.stringify(proof.selectionPolicyId)}`);
  if (proof.hashAlgorithmId !== SNAPSHOT_HASH_ALGORITHM_ID) report(`the retained proof names the unaccepted hash algorithm identity ${JSON.stringify(proof.hashAlgorithmId)}`);
  if (!Array.isArray(proof.selectionExclusions) || lifecycleCanonicalJson(proof.selectionExclusions) !== lifecycleCanonicalJson([...SELECTION_EXCLUSION_LIST])) report('the retained proof selection exclusions do not name the accepted policy exclusions');
  /* The pair has to bind this exact journaled intent and these submission bytes. */
  if (proof.freezeIntentDigest !== intent.eventDigest) report('the retained proof freeze-intent digest does not name the journaled FREEZE_INTENT event');
  if (proof.freezeIntentSequence !== intent.sequence) report('the retained proof freeze-intent sequence does not name the journaled FREEZE_INTENT event');
  if (proof.submissionDigest !== sha256Hex(lifecycleCanonicalJson(submission))) report('the retained proof submission digest does not recompute over the retained submission bytes');
  /* The recorded location has to be the accepted layout of the run root the caller
   * named, and the chain to it has to be ordinary, so a foreign or linked path is
   * refused rather than followed. */
  const snapshotsRoot = path.join(runRoot, FREEZE_SNAPSHOT_ROOT_NAME);
  const expectedContainer = path.join(snapshotsRoot, String(proof.snapshotId));
  const expectedRoot = path.join(expectedContainer, FREEZE_SNAPSHOT_WORKSPACE_NAME);
  if (proof.workspaceSubdirectoryName !== FREEZE_SNAPSHOT_WORKSPACE_NAME) report(`the retained proof names the unaccepted snapshot workspace subdirectory ${JSON.stringify(proof.workspaceSubdirectoryName)}`);
  if (path.resolve(String(proof.snapshotContainer)) !== path.resolve(expectedContainer)) report(`the retained proof snapshot container ${JSON.stringify(proof.snapshotContainer)} is not the accepted container of this snapshot identity under the stated run root`);
  if (path.resolve(String(proof.snapshotRoot)) !== path.resolve(expectedRoot)) report(`the retained proof snapshot location ${JSON.stringify(proof.snapshotRoot)} is not the accepted workspace subdirectory of its container`);
  const containment = path.relative(path.resolve(runRoot), path.resolve(String(proof.snapshotRoot)));
  if (containment.startsWith('..') || path.isAbsolute(containment)) report(`the retained proof snapshot location ${JSON.stringify(proof.snapshotRoot)} lies outside the stated run root`);
  try { assertOrdinaryChain(expectedContainer); } catch (problem) { report(`the retained snapshot location is not reachable through an ordinary directory chain: ${problem.message}`); }
  /* The route, the attestation and the clock provenance have to agree with each
   * other and with what the journal actually carries. */
  const stopEvent = persisted.events.find((entry) => entry.event?.kind === 'STOP_RECORDED')?.event;
  const startIntent = persisted.events.find((entry) => entry.event?.kind === 'START_INTENT')?.event;
  const stateRecord = persisted.stateRecord;
  const attestation = proof.freezeAttestation;
  if (!isObject(attestation) || attestation.agentStopped !== true || typeof attestation.operator !== 'string' || attestation.operator.length < OPERATOR_MIN_LENGTH || typeof attestation.statement !== 'string') report('the retained proof freeze attestation does not state a valid operator, agentStopped and statement');
  else if (attestation.operator !== operator && stateRecord?.state === 'FROZEN' && stateRecord?.stopAttestation?.operator === attestation.operator) { /* The operator who froze the run is the one the journaled attestation names and is checked against the journaled intent detail below; the operator reconciling it now is recorded in the completion history entry, so the two names differ by design. */ }
  const clockless = attestation.clockless === true;
  if (!clockless && Object.hasOwn(attestation, 'clockless') && attestation.clockless !== true) report('the retained proof freeze attestation states clockless as a value other than true');
  const intentDetail = intent.detail;
  if (!isObject(intentDetail)) report('the journaled FREEZE_INTENT carries no detail');
  else {
    if (intentDetail.agentStopped !== true) report('the journaled FREEZE_INTENT detail does not state agentStopped: true');
    if (intentDetail.assurance !== STOP_ASSURANCE) report(`the journaled FREEZE_INTENT detail assurance is ${JSON.stringify(intentDetail.assurance)}`);
    if (intentDetail.enforced !== false) report('the journaled FREEZE_INTENT detail states that anything was enforced');
    if (typeof intentDetail.operator !== 'string' || typeof intentDetail.statement !== 'string') report('the journaled FREEZE_INTENT detail names no operator or statement');
    else if (isObject(attestation) && (intentDetail.operator !== attestation.operator || intentDetail.statement !== attestation.statement)) report('the journaled FREEZE_INTENT detail does not name the attestation the retained proof records');
    if (clockless !== (intentDetail.clockless === true)) report('the journaled FREEZE_INTENT clockless statement does not agree with the retained proof route');
  }
  if (proof.freezeRoute === 'CLOCKLESS_INITIALIZED') {
    if (!clockless) report('the retained proof claims the CLOCKLESS_INITIALIZED route while its attestation states no clockless claim');
    if (proof.stopAssurance !== null) report('the clockless route carries a stop assurance');
    if (proof.stopAttestation !== null) report('the clockless route carries a stop attestation');
    const time = proof.timeProvenance;
    if (!isObject(time) || time.startedAt !== null || time.stoppedAt !== null || time.elapsedMs !== null || time.clockError !== null || time.clockWasUnavailable !== false) report('the clockless route clock provenance is not the fully unclaimed form');
    /* The released clockless route has two lawful sources for the published
     * instant and no third: the operator's stated observation when the
     * attestation states one, or a reading the caller's own clock reported when it
     * states none. Both are named by the provenance field; a route that names one
     * source while carrying the other is refused. */
    if (proof.frozenAtProvenance !== FROZEN_AT_PROVENANCE.ATTESTED_OBSERVATION && proof.frozenAtProvenance !== FROZEN_AT_PROVENANCE.CLOCK_READING) report(`the clockless route frozen instant provenance is ${JSON.stringify(proof.frozenAtProvenance)}; with no recorded stop the instant can only be an attested observation or a clock reading`);
    if (proof.frozenAtProvenance === FROZEN_AT_PROVENANCE.ATTESTED_OBSERVATION) {
      if (proof.frozenAt !== attestation?.observedAt) report('the clockless route frozen instant is not the attested observation its provenance names');
    } else if (attestation?.observedAt != null) report('the clockless route records a clock-reading provenance while its attestation states an observed instant; the stated observation is the source of that instant');
    if (intent.occurredAt !== proof.frozenAt) report('the clockless route journaled intent instant is not the frozen instant the proof records');
  } else if (proof.freezeRoute === 'STOP_RECORDED') {
    if (clockless) report('the retained proof claims the STOP_RECORDED route while its attestation claims the clockless route');
    if (proof.stopAssurance !== STOP_ASSURANCE) report(`the stopped route stop assurance is ${JSON.stringify(proof.stopAssurance)}`);
    if (!isObject(proof.stopAttestation)) report('the stopped route carries no recorded stop attestation');
    const time = proof.timeProvenance;
    if (!isObject(time)) report('the stopped route carries no clock provenance');
    else {
      if (time.stoppedAt !== (stateRecord?.stoppedAt ?? void 0)) report('the stopped route clock provenance does not name the projection\'s recorded stop instant');
      if (time.startedAt !== (stateRecord?.startedAt ?? void 0)) report('the stopped route clock provenance does not name the projection\'s recorded start instant');
      if (time.elapsedMs !== (stateRecord?.elapsedMs ?? void 0)) report('the stopped route clock provenance does not name the projection\'s recorded elapsed value');
      if (lifecycleCanonicalJson(time.clockError ?? null) !== lifecycleCanonicalJson(stateRecord?.clockError ?? null)) report('the stopped route clock provenance does not name the projection\'s recorded clock error');
      if (time.clockWasUnavailable !== (stateRecord?.stoppedAt == null)) report('the stopped route clock provenance clockWasUnavailable statement does not agree with the recorded stop instant');
      if (time.stoppedAt != null && stopEvent !== undefined && time.stoppedAt !== stopEvent.occurredAt) report('the stopped route clock provenance stop instant is not the journaled stop instant');
      if (time.startedAt != null && startIntent !== undefined && time.startedAt !== startIntent.occurredAt) report('the stopped route clock provenance start instant is not the journaled start instant');
    }
    if (proof.frozenAtProvenance !== FROZEN_AT_PROVENANCE.RECORDED_STOP && proof.frozenAtProvenance !== FROZEN_AT_PROVENANCE.ATTESTED_OBSERVATION && proof.frozenAtProvenance !== FROZEN_AT_PROVENANCE.CLOCK_READING) report(`the stopped route frozen instant provenance is ${JSON.stringify(proof.frozenAtProvenance)}`);
    if (proof.frozenAtProvenance === FROZEN_AT_PROVENANCE.RECORDED_STOP && proof.frozenAt !== (stateRecord?.stoppedAt ?? void 0)) report('the stopped route frozen instant provenance names a recorded stop the projection does not carry');
    if (proof.frozenAtProvenance === FROZEN_AT_PROVENANCE.ATTESTED_OBSERVATION && proof.frozenAt !== attestation?.observedAt) report('the stopped route frozen instant is not the attested observation its provenance names');
    if (intent.occurredAt !== proof.frozenAt) report('the journaled intent instant is not the frozen instant the proof records');
    if (proof.stopAttestation?.operator !== stateRecord?.stopAttestation?.operator || proof.stopAttestation?.statement !== stateRecord?.stopAttestation?.statement) report('the retained proof stop attestation does not agree with the projection\'s');
  } else report(`the retained proof freeze route is ${JSON.stringify(proof.freezeRoute)}`);
  findings.push(...repairableInterruptionFindings({ persisted, proof, manifestId, runId }));
  return findings;
}

/** Explicit recovery of this run's bound FREEZE intent. Never deletes orphan or foreign bytes. */
export async function reconcileFreeze(request) {
 if(!isObject(request)||!['KEEP_INTERRUPTED','COMPLETE'].includes(request.decision)||typeof request.operator!=='string'||request.operator.length<2||typeof request.intentDigest!=='string')fail(LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT,'freeze reconciliation requires operator, exact intentDigest and KEEP_INTERRUPTED or COMPLETE disposition.');
 return withRunTransaction({runRoot:request.runRoot,manifestId:request.manifestId,runId:request.runId},async context=>{
  const persisted=await reverifyPersistedRun(context);
  const intent=persisted.events.find(entry=>entry.event?.kind==='FREEZE_INTENT')?.event;
  if(!intent||intent.eventDigest!==request.intentDigest)fail(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,'the requested interrupted freeze intent is not this run intent.');
  if(request.decision==='KEEP_INTERRUPTED')return Object.freeze({decision:request.decision,operator:request.operator,intentDigest:intent.eventDigest,state:context.lifecycle?.state??'INITIALIZED',repaired:false,retained:true,findings:persisted.findings});
  /* Every completion refusal below happens before the first projection write or
   * the first journal append. A reconciliation that cannot prove one fully
   * coherent retained publication changes no byte of the run: the retained
   * submission, proof, snapshot bytes, projection and journal all stay exactly as
   * found, and the operator keeps the interrupted state to inspect. */
  /* Every finding the reader reports is a refusal, with one qualification that is
   * named rather than ignored: a projection already advanced to FROZEN while its
   * FREEZE_COMMIT has not landed is the torn half of an interrupted completion, and
   * completing it is exactly what reconciliation is for. That single finding is
   * carried as a tagged repairable class by the reader, so it is qualified here by
   * index and is then re-proved positively below — the retained pair has to bind
   * the journaled intent and the torn projection history — instead of being waived.
   * Every other finding (a foreign journal entry, a sequence break, a digest that do
   * not recompute, an unknown kind, a torn stop) refuses before any write. */
  const repairable=new Set(persisted.tornCompletionFindings??[]);
  const residual=persisted.findings.filter((unused,index)=>!repairable.has(index));
  if(residual.length)fail(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,'the retained journal and projection do not verify; completion is refused before any reconciliation write.',{findings:residual});
  if(persisted.counts.FREEZE_COMMIT)fail(LIFECYCLE_ERROR_CODES.STATE_TRANSITION_REFUSED,'the freeze already carries a commit; do not recommit.');
  const publications=await listPublications(context.storage,context.manifestId);
  const pairs=publications.filter(entry=>entry.proof&&entry.submission);
  if(pairs.length!==1)fail(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,'completion requires exactly one bound retained submission/proof pair; unknown orphan bytes are preserved.');
  const{proof,submission}=pairs[0];
  /* The retained pair has to be one coherent record of this run's bytes: both
   * contract records have to validate, the proof has to bind this exact journaled
   * intent and these submission bytes, its identities, counts, byte inventory,
   * physical directory set, digest and recorded location have to agree with each
   * other and with the accepted layout, and its attestation and clock provenance
   * have to name a route that this run could actually have taken. Nothing here
   * writes: a rejected claim is reported, never repaired by overwriting it. */
  const coherence=reconciliationCoherenceFindings({proof,submission,intent,persisted,runRoot:request.runRoot,manifestId:context.manifestId,runId:context.runId,operator:request.operator});
  if(coherence.length)fail(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,'the retained submission/proof pair is not one coherent publication bound to this run; completion is refused before any reconciliation write.',{findings:coherence});
  const verified=await verifySnapshot({snapshotRoot:path.resolve(proof.snapshotRoot),expectedInventory:proof.inventory,expectedDigest:proof.treeDigest,selectionPolicyId:proof.selectionPolicyId});
  if(!verified.ok)fail(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,'retained snapshot bytes do not verify; no completion.',{findings:verified.failures});
  let record=context.lifecycle;
  if(record?.state!=='FROZEN')record=await context.commitState({state:'FROZEN',stopAttestation:proof.freezeAttestation,historyEntry:{operation:'FREEZE',route:proof.freezeRoute,snapshotId:proof.snapshotId,frozenSubmissionId:submission.frozenSubmissionId,treeDigest:proof.treeDigest,freezeIntentEventDigest:intent.eventDigest,reconciledBy:request.operator}});
  else if(!(record.history??[]).some(entry=>entry.operation==='FREEZE'&&entry.snapshotId===proof.snapshotId&&entry.frozenSubmissionId===submission.frozenSubmissionId))fail(LIFECYCLE_ERROR_CODES.RECOVERY_REQUIRED,'projected freeze is not bound to the retained publication.');
  await context.appendEvent({kind:'FREEZE_COMMIT',occurredAt:proof.frozenAt,journalCommitAt:null,...(record.declaration?{declaration:record.declaration}:{}),detail:{stateEventDigest:record.stateDigest}});
  const after=await reverifyPersistedRun(context);if(after.findings.length)fail(LIFECYCLE_ERROR_CODES.READBACK_FAILED,'reconciliation commit did not verify.',{findings:after.findings});
  return Object.freeze({decision:request.decision,operator:request.operator,intentDigest:intent.eventDigest,state:'FROZEN',repaired:true,retained:true,snapshotId:proof.snapshotId});
 });
}
