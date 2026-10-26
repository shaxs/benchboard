/**
 * BenchBoard C3 T4 — fresh-identity reset of a run container.
 *
 * `resetRun` creates a NEW run in a FRESH destination while the OLD container is
 * left byte-for-byte intact. There is no in-place, destructive or archive mode:
 * the only effect on the old container during a reset is the lock this module
 * temporarily owns through the accepted T1 whole-command transaction.
 *
 * Rules this module will not violate:
 *  - The whole command runs inside one accepted `withRunTransaction` over the
 *    OLD container, so the old binding is read at entry and re-verified by that
 *    seam before the command reports success, and no second, non-cooperating
 *    lock exists for the same container.
 *  - The accepted transaction seam hands out the manifest, the storage container
 *    and the PROJECTED lifecycle record; it does not hand out a verified journal
 *    or a diagnosis. Eligibility is therefore never taken from the projection
 *    alone. This module re-reads the state record and the whole journal through
 *    the SAME transaction storage (calling the accepted `readRunLifecycle` here
 *    would open a second storage instance against a container whose lock this
 *    transaction already holds and would only produce a lock conflict) and
 *    verifies the hash chain, the identity binding and the intent/commit pairing
 *    itself. An unresolved intent, an incoherent journal or a torn state record
 *    denies the reset BEFORE any output byte is touched, even when the
 *    projection reads `STOP_RECORDED`, `FROZEN` or `null`.
 *  - The caller supplies the challenge package and the identities explicitly. A
 *    missing identity is refused and never rebuilt out of the old binding. The
 *    supplied challenge identity must equal the identity bound in the old
 *    manifest, and the exact original workload hash must survive.
 *  - The new `runId` and `manifestId` come from the accepted C2 initialiser,
 *    which generates them itself, so they are independently fresh. This module
 *    additionally refuses the publication when either id is not distinct.
 *  - A failure keeps whatever the accepted initialiser actually published and
 *    keeps foreign material visible. Nothing outside the provenance of this
 *    operation is cleaned up, and no old byte is deleted.
 *
 * Node builtins plus the accepted C1/C2/T1 modules only.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  LIFECYCLE_DERIVED_STATE,
  LIFECYCLE_EVENT_KIND,
  LIFECYCLE_EVENT_KINDS,
  LIFECYCLE_JOURNAL_DIRECTORY,
  LIFECYCLE_STATE_KIND,
  LIFECYCLE_STATE_RELATIVE_PATH,
  lifecycleCanonicalJson,
  lifecycleEventDigestOf,
  lifecycleStateDigestOf,
  withRunTransaction,
} from './lifecycle-internal.mjs';
import { initialiseRun } from './init.mjs';
import { createStorage } from './storage.mjs';
import { identityDigestOf, validateRecord } from './manifest.mjs';
import { sha256 } from './identity.mjs';

/* -------------------------------------------------------------------------- */
/* Public surface                                                              */
/* -------------------------------------------------------------------------- */

/** Stable machine-readable refusal reasons; callers branch on `code`. */
export const RESET_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'RESET_INVALID_ARGUMENT',
  INVALID_ROOT: 'RESET_INVALID_ROOT',
  OUTPUT_NOT_FRESH: 'RESET_OUTPUT_NOT_FRESH',
  OUTPUT_UNUSABLE: 'RESET_OUTPUT_UNUSABLE',
  OUTPUT_ALIAS: 'RESET_OUTPUT_ALIAS',
  OUTPUT_LINK_ANCESTOR: 'RESET_OUTPUT_LINK_ANCESTOR',
  ROOTS_OVERLAP: 'RESET_ROOTS_OVERLAP',
  PROVENANCE_MISMATCH: 'RESET_PROVENANCE_MISMATCH',
  CHALLENGE_MISMATCH: 'RESET_CHALLENGE_MISMATCH',
  STATE_REFUSED: 'RESET_STATE_REFUSED',
  JOURNAL_INCOMPLETE: 'RESET_JOURNAL_INCOMPLETE',
  JOURNAL_INCONSISTENT: 'RESET_JOURNAL_INCONSISTENT',
  IDENTITY_NOT_DISTINCT: 'RESET_IDENTITY_NOT_DISTINCT',
  READBACK_FAILED: 'RESET_READBACK_FAILED',
  STORAGE_REFUSED: 'RESET_STORAGE_REFUSED',
  INITIALISE_FAILED: 'RESET_INITIALISE_FAILED',
});

/** The lifecycle states a reset may be asked for at all. */
export const RESET_ELIGIBLE_STATES = Object.freeze([
  'INITIALIZED',
  'STOP_RECORDED',
  'FROZEN',
]);

/** The states that are named by the contract but never eligible. */
export const RESET_REFUSED_STATES = Object.freeze(['RUNNING']);

/** The request keys a reset accepts; an unknown key is a refusal, not a guess. */
const RESET_REQUEST_KEYS = Object.freeze([
  'runRoot',
  'manifestId',
  'runId',
  'output',
  'initializationRequest',
  'expectedDigest',
  'protectedRoots',
  'clock',
  'operationName',
]);

/** The keys a caller may not hand to the accepted initialiser from here. */
const FORBIDDEN_INITIALIZATION_KEYS = Object.freeze(['manifestId', 'runId', 'output']);

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_JOURNAL_EVENTS = 4096;
const SELF_STATE_FIELD = 'stateDigest';
const SELF_EVENT_FIELD = 'eventDigest';

/** Error type carrying one stable machine code and what the refusal observed. */
export class ResetError extends Error {
  /**
   * @param {string} code one of `RESET_ERROR_CODES`
   * @param {string} message human-readable reason
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    if (!Object.values(RESET_ERROR_CODES).includes(code)) {
      throw new TypeError(`ResetError requires one of the declared codes, got ${String(code)}.`);
    }
    if (typeof message !== 'string' || message.length === 0) {
      throw new TypeError('ResetError requires a message.');
    }
    const { cause, ...rest } = details;
    super(`${code}: ${message}`);
    this.name = 'ResetError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    for (const [key, value] of Object.entries(rest)) this[key] = value;
    Object.setPrototypeOf(this, ResetError.prototype);
  }
}

function fail(code, message, details) {
  throw new ResetError(code, message, details);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wantObject(value, label) {
  if (!isObject(value)) fail(RESET_ERROR_CODES.INVALID_ARGUMENT, `${label} must be a plain object, got ${describe(value)}.`);
  return value;
}

function wantString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(RESET_ERROR_CODES.INVALID_ARGUMENT, `${label} must be a non-empty string, got ${describe(value)}.`);
  }
  return value;
}

function wantAbsoluteRoot(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail(RESET_ERROR_CODES.INVALID_ROOT, `${label} must be an explicit absolute host path, got ${describe(value)}.`);
  }
  if (!path.isAbsolute(value)) {
    fail(RESET_ERROR_CODES.INVALID_ROOT, `${label} must be an absolute path, got ${JSON.stringify(value)}.`);
  }
  if (value.startsWith('\\\\?\\') || value.startsWith('//')) {
    fail(RESET_ERROR_CODES.INVALID_ROOT, `${label} must not use an extended-length or UNC form: ${JSON.stringify(value)}.`);
  }
  return value;
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const kind = typeof value;
  if (kind === 'string') return JSON.stringify(value);
  if (kind === 'object') return 'an object';
  return String(value);
}

function clone(value) {
  return structuredClone(value);
}

/* ========================================================================== */
/* Request validation                                                           */
/* ========================================================================== */

function prepareRequest(request) {
  const value = wantObject(request, 'the reset request');
  const unknown = Object.keys(value).filter((key) => !RESET_REQUEST_KEYS.includes(key));
  if (unknown.length > 0) {
    fail(RESET_ERROR_CODES.INVALID_ARGUMENT, `the reset request carries undeclared field(s): ${unknown.join(', ')}.`);
  }

  const runRoot = wantAbsoluteRoot(value.runRoot, 'the reset request.runRoot');
  const output = wantAbsoluteRoot(value.output, 'the reset request.output');
  const initializationRequest = wantObject(value.initializationRequest, 'the reset request.initializationRequest');

  const forbidden = FORBIDDEN_INITIALIZATION_KEYS.filter((key) => initializationRequest[key] !== undefined);
  if (forbidden.length > 0) {
    fail(
      RESET_ERROR_CODES.INVALID_ARGUMENT,
      `the reset request.initializationRequest must not name ${forbidden.join(', ')}: the fresh ids come from the accepted initialiser and the destination is the reset request's own output.`,
      { fields: forbidden },
    );
  }

  const protectedRoots = value.protectedRoots === undefined
    ? []
    : (Array.isArray(value.protectedRoots)
      ? value.protectedRoots.map((root, index) => wantAbsoluteRoot(root, `the reset request.protectedRoots[${String(index)}]`))
      : fail(RESET_ERROR_CODES.INVALID_ARGUMENT, 'the reset request.protectedRoots must be an array of absolute paths.'));

  return {
    runRoot,
    manifestId: wantString(value.manifestId, 'the reset request.manifestId'),
    runId: wantString(value.runId, 'the reset request.runId'),
    output,
    initializationRequest: { ...initializationRequest },
    expectedDigest: value.expectedDigest,
    protectedRoots,
    clock: value.clock,
    operationName: value.operationName ?? 'resetRun',
  };
}

/* ========================================================================== */
/* The fresh-destination gate (runs before any lifecycle read)                  */
/* ========================================================================== */

/**
 * Prove the destination is a fresh, unaliased location that is apart from the
 * old container, every ancestor of it, and every protected root the caller
 * named. A canonical alias of a protected root, a link in an ancestor, and an
 * already-published foreign container are all refused here, before the accepted
 * initialiser could write a single byte.
 */
async function assertFreshDestination(prepared, context) {
  const output = prepared.output;
  const oldContainer = path.resolve(prepared.runRoot);

  /* Check the whole existing ancestor chain before inspecting the leaf. */
  if (await directoryHasLinkAncestor(output)) {
    fail(RESET_ERROR_CODES.OUTPUT_LINK_ANCESTOR, 'the reset destination has a linked or non-directory ancestor.', {output});
  }
  /* A fresh destination is absent, never an existing empty directory. */
  const stat = await lstatOrNull(output);
  if (stat !== null) {
    if (stat.isSymbolicLink()) {
      fail(RESET_ERROR_CODES.OUTPUT_LINK_ANCESTOR, `the reset output ${JSON.stringify(output)} is a symbolic link; a reset never publishes through a link.`, { output });
    }
    if (!stat.isDirectory()) {
      fail(RESET_ERROR_CODES.OUTPUT_UNUSABLE, `the reset output ${JSON.stringify(output)} exists and is not a directory.`, { output });
    }
    fail(RESET_ERROR_CODES.OUTPUT_NOT_FRESH, 'the reset output already exists; even an empty directory is foreign to this operation.', {output});
  }

  /* (b) apart from the old container and its ancestors. The direction matters
   *     here: a fresh destination that merely shares a parent directory with the
   *     old container is a sibling and is legitimate, while a destination that IS
   *     an ancestor of the old container would swallow it. */
  const outputReal = await canonicalOrSelf(output);
  const oldReal = await canonicalOrSelf(oldContainer);
  assertApartFrom(outputReal, oldReal, 'the old run container', output, oldContainer);
  for (const ancestor of ancestorChain(oldReal)) {
    assertNoAncestorCapture(outputReal, ancestor, output);
  }

  /* (c) apart from every protected root the caller supplied, plus the roots the
   *    old manifest binds: the workspace and the state container. */
  const protectedEntries = [];
  for (const [index, root] of prepared.protectedRoots.entries()) {
    protectedEntries.push({ label: `protectedRoots[${String(index)}]`, display: root, real: await canonicalOrSelf(root) });
  }
  protectedEntries.push({ label: 'the old participant workspace', display: context.manifest.participantWorkspaceRoot, real: await canonicalOrSelf(context.manifest.participantWorkspaceRoot) });
  protectedEntries.push({ label: 'the old state container', display: context.manifest.evidenceRoot, real: await canonicalOrSelf(context.manifest.evidenceRoot) });
  for (const entry of protectedEntries) {
    assertApartFrom(outputReal, entry.real, entry.label, output, entry.display);
  }
}

/**
 * Refuse a destination that IS an ancestor of the old container (or names it),
 * because publishing there would put the new container around the old one. A
 * destination that merely SHARES an ancestor with the old container is a sibling
 * and is legitimate, so containment in the other direction is not refused here.
 */
function assertNoAncestorCapture(outputReal, ancestorReal, outputDisplay) {
  const foldedOutput = foldCase(outputReal);
  const foldedAncestor = foldCase(ancestorReal);
  if (foldedOutput === foldedAncestor) {
    fail(RESET_ERROR_CODES.OUTPUT_ALIAS, `the reset output ${JSON.stringify(outputDisplay)} IS an ancestor directory of the old run container ${JSON.stringify(ancestorReal)}; a reset never publishes around or in place of the run it resets.`, { output: outputDisplay, captures: ancestorReal });
  }
  if (isStrictlyInside(foldedOutput, foldedAncestor)) {
    fail(RESET_ERROR_CODES.ROOTS_OVERLAP, `the reset output ${JSON.stringify(outputDisplay)} contains the ancestor directory ${JSON.stringify(ancestorReal)} of the old run container, which would capture the old run.`, { output: outputDisplay, captures: ancestorReal });
  }
}

function assertApartFrom(outputReal, otherReal, label, outputDisplay, otherDisplay) {
  if (otherReal === null || outputReal === null) return;
  const foldedOutput = foldCase(outputReal);
  const foldedOther = foldCase(otherReal);
  if (foldedOutput === foldedOther) {
    fail(RESET_ERROR_CODES.OUTPUT_ALIAS, `the reset output ${JSON.stringify(outputDisplay)} names the same directory as ${label} ${JSON.stringify(otherDisplay)}; a canonical or case alias of a protected root is refused before any write.`, { output: outputDisplay, clashesWith: otherDisplay, role: label });
  }
  if (isStrictlyInside(foldedOther, foldedOutput) || isStrictlyInside(foldedOutput, foldedOther)) {
    fail(RESET_ERROR_CODES.ROOTS_OVERLAP, `the reset output ${JSON.stringify(outputDisplay)} is contained by or contains ${label} ${JSON.stringify(otherDisplay)}.`, { output: outputDisplay, overlapsWith: otherDisplay, role: label });
  }
}

function isStrictlyInside(maybeParent, maybeChild) {
  if (maybeParent === maybeChild) return false;
  const prefix = maybeParent.endsWith('/') ? maybeParent : `${maybeParent}/`;
  return maybeChild.startsWith(prefix);
}

/**
 * The comparison namespace used for every root comparison here. Separators are
 * folded and case is folded unconditionally: case sensitivity is a mount
 * property that cannot be queried reliably, so treating two spellings of the
 * same directory on a case-sensitive mount as a clash is the conservative
 * choice and matches the accepted path boundary.
 */
function foldCase(value) {
  return value.replace(/\\/gu, '/').replace(/\/+$/gu, '').toLowerCase();
}

function ancestorChain(absolute) {
  const chain = [];
  let cursor = absolute;
  for (;;) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    chain.push(parent.replace(/\\/gu, '/'));
    cursor = parent;
  }
  return chain;
}

function toForward(absolute) {
  return absolute.replace(/\\/gu, '/');
}

async function canonicalOrSelf(absolute) {
  try {
    return toForward(await fs.realpath(absolute));
  } catch {
    return toForward(path.resolve(absolute));
  }
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    /* Any other inspection failure is reported as an unusable destination
     * rather than swallowed, so a reset never publishes onto a location it
     * could not look at. */
    fail(RESET_ERROR_CODES.OUTPUT_UNUSABLE, `the reset output ${JSON.stringify(target)} could not be inspected: ${error instanceof Error ? error.message : String(error)}`, { output: target, cause: error });
  }
}

/** True when any existing component of `directory` is a link or special file. */
async function directoryHasLinkAncestor(directory) {
  const chain = [path.resolve(directory), ...ancestorChain(path.resolve(directory))].reverse().map((entry) => path.normalize(entry));
  for (const component of chain) {
    if (component === path.parse(component).root) continue;
    const stat = await lstatOrNull(component);
    if (stat === null) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
  }
  return false;
}

/**
 * Reset a run by creating a brand-new run container at a fresh destination.
 *
 * The old container is never modified: this command holds the accepted
 * whole-command lock over it, reads and re-verifies its binding and lifecycle,
 * and then calls the accepted C2 initialiser for the new destination with the
 * caller-supplied identities and challenge package bound to the old manifest.
 *
 * @param {{
 *   runRoot: string,
 *   manifestId: string,
 *   runId: string,
 *   output: string,
 *   initializationRequest: object,
 *   expectedDigest?: string,
 *   protectedRoots?: string[],
 *   clock?: {now(): number|null},
 *   operationName?: string,
 * }} request
 * @returns {Promise<{
 *   source: {runId: string, manifestId: string, state: string, manifestDigest: string|null},
 *   manifest: object,
 *   initResult: object,
 *   output: string,
 *   fresh: true,
 *   oldContainerMutation: 'none',
 * }>}
 */
export async function resetRun(request) {
  const prepared = prepareRequest(request);

  /* The accepted transaction maps any foreign error out of its callback into a
   * storage refusal. A reset refusal is not a storage fault and its code must
   * survive verbatim, so the outcome is carried out of the callback and
   * rethrown unchanged here, after the lock has been released. Nothing is
   * retried and no lock is removed. */
  const outcome = await withRunTransaction(
    {
      runRoot: prepared.runRoot,
      manifestId: prepared.manifestId,
      runId: prepared.runId,
      expectedDigest: prepared.expectedDigest,
      clock: prepared.clock,
      operationName: prepared.operationName,
    },
    async (context) => {
      try {
        return { ok: true, value: await resetUnderLock(prepared, context) };
      } catch (error) {
        return { ok: false, error };
      }
    },
  );

  if (outcome.ok !== true) {
    if (outcome.error instanceof Error && outcome.error.publicationFate === undefined) outcome.error.publicationFate = await describePublicationFate(prepared.output);
    throw outcome.error;
  }
  return outcome.value;
}

async function resetUnderLock(prepared, context) {
  /* 1. The destination must be provably fresh BEFORE the journal is consulted,
   *    so a refusal over the destination never even reads the old lifecycle,
   *    and a refusal over the lifecycle never touches the destination. Both
   *    refusals therefore leave the old bytes alone. */
  await assertFreshDestination(prepared, context);

  /* 2. The projection is not eligibility: re-read and verify the state record
   *    and the whole journal through the SAME storage the transaction holds. */
  const journal = await readVerifiedJournal(context.storage, context.manifestId);
  const state = await readStateRecord(context.storage, context.manifestId);
  const diagnosis = diagnoseResetEligibility(context, state, journal);

  /* 3. The caller's identities and challenge package must match what the old
   *    manifest binds, and must carry the exact original workload hash.
   *    Nothing is inferred from the mutable workspace. */
  const initializationRequest = bindInitializationRequest(prepared, context.manifest);

  const oldProof = await oldContainerProof(prepared.runRoot);
  let result;
  try {
    result = await runAcceptedInitialisation(initializationRequest, prepared, context);
    const finalJournal = await readVerifiedJournal(context.storage, context.manifestId);
    const finalState = await readStateRecord(context.storage, context.manifestId);
    diagnoseResetEligibility(context, finalState, finalJournal);
    if (canonical(await oldContainerProof(prepared.runRoot)) !== canonical(oldProof)) {
      fail(RESET_ERROR_CODES.PROVENANCE_MISMATCH, 'the old run changed during reset; retained new publication is not reported as successful.', {oldContainerMutation:'detected', output:prepared.output});
    }
  } catch (error) {
    if (error instanceof Error) error.publicationFate = await describePublicationFate(prepared.output);
    throw error;
  }

  /* 4. The accepted initialiser generated the ids; prove they are distinct from
   *    the old run before the new container is reported. */
  assertDistinctIdentity(result.manifest, context.manifest);

  await assertNewContainerPublished(result, prepared);

  return Object.freeze({
    source: Object.freeze({
      runId: context.manifest.runId,
      manifestId: context.manifest.manifestId,
      manifestDigest: context.manifest.manifestDigest ?? null,
      state: diagnosis.state,
    }),
    manifest: Object.freeze(clone(result.manifest)),
    initResult: Object.freeze(clonePublic(result)),
    output: prepared.output,
    fresh: true,
    oldContainerMutation: 'none',
  });
}

/* ========================================================================== */
/* Journal and state read-back inside the held transaction                      */
/* ========================================================================== */

/**
 * Read the state record through the storage the transaction already holds.
 * A missing record is the derived `INITIALIZED` state, reported as `null`.
 */
async function readStateRecord(storage, manifestId) {
  try {
    return await storage.read({
      relativePath: LIFECYCLE_STATE_RELATIVE_PATH,
      kind: LIFECYCLE_STATE_KIND,
      id: `${manifestId}:lifecycle-state`,
    });
  } catch (error) {
    if (error?.code === 'ERR_STORAGE_NOT_FOUND') return null;
    throw storageRefusal(error);
  }
}

/**
 * Read the whole journal through the storage the transaction already holds,
 * naming each entry by the accepted identity for its sequence. An entry that
 * cannot be read back is reported as a finding rather than thrown, so the
 * diagnosis below can see exactly what the journal states.
 */
async function readVerifiedJournal(storage, manifestId) {
  const directory = path.join(String(storage.root), LIFECYCLE_JOURNAL_DIRECTORY);
  const events = [];
  const foreign = [];
  const unreadable = [];
  let names = [];
  if (await directoryHasLinkAncestor(directory)) {
    fail(RESET_ERROR_CODES.JOURNAL_INCONSISTENT, 'the journal directory has a linked or non-directory ancestor; it is not read through.');
  }
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw storageRefusal(error);
  }
  const sequences = [];
  for (const name of names) {
    const match = /^([0-9]{5})\.json$/.exec(name);
    if (match === null) {
      foreign.push(name);
      continue;
    }
    sequences.push(Number(match[1]));
  }
  sequences.sort((left, right) => left - right);
  if (sequences.length > MAX_JOURNAL_EVENTS) {
    fail(RESET_ERROR_CODES.JOURNAL_INCONSISTENT, `the journal carries ${String(sequences.length)} entries, above the contract bound of ${String(MAX_JOURNAL_EVENTS)}.`);
  }
  for (const sequence of sequences) {
    const relativePath = `${LIFECYCLE_JOURNAL_DIRECTORY}/${String(sequence).padStart(5, '0')}.json`;
    try {
      const event = await storage.read({
        relativePath,
        kind: LIFECYCLE_EVENT_KIND,
        id: `${manifestId}:event:${String(sequence).padStart(5, '0')}`,
      });
      events.push({ sequence, event });
    } catch (error) {
      unreadable.push({
        sequence,
        reason: error?.code === 'ERR_STORAGE_NOT_FOUND'
          ? 'the journal file is not readable back under its bound identity'
          : `the accepted storage read refused the entry (${String(error?.code ?? 'unknown')})`,
      });
    }
  }
  return { events, foreign, unreadable };
}

/**
 * Verify the journal against itself and against the state record, then derive
 * reset eligibility. This is the gate the accepted projection cannot provide:
 *  - contiguous sequences bound to this run and manifest;
 *  - every digest recomputed from the entry's own bytes;
 *  - every entry after the first naming its immediate predecessor's digest;
 *  - no intent without its commit and no commit without its intent.
 *
 * Any finding denies the reset, so a torn stop/freeze or a pending
 * `FREEZE_INTENT` is refused even when the projected state looks eligible.
 */
function diagnoseResetEligibility(context, state, journal) {
  const manifest = context.manifest;
  const findings = [];
  for (const entry of journal.unreadable) findings.push(`journal entry ${String(entry.sequence)}: ${entry.reason}`);
  for (const name of journal.foreign) findings.push(`the journal directory carries a foreign entry ${JSON.stringify(name)}`);

  const counts = {};
  for (const kind of LIFECYCLE_EVENT_KINDS) counts[kind] = 0;

  let expected = 0;
  let previousDigest = null;
  for (const { sequence, event } of journal.events) {
    if (sequence !== expected) findings.push(`journal sequence break: expected ${String(expected)}, found ${String(sequence)}`);
    expected = sequence + 1;
    if (!isObject(event)) {
      findings.push(`journal entry ${String(sequence)} does not carry an event object`);
      previousDigest = null;
      continue;
    }
    if (event.manifestId !== manifest.manifestId || event.runId !== manifest.runId) {
      findings.push(`journal entry ${String(sequence)} is bound to a different run or manifest`);
    }
    if (event.sequence !== sequence) findings.push(`journal entry ${String(sequence)} states sequence ${String(event.sequence)} in its own bytes`);
    if (typeof event.eventDigest !== 'string' || safeEventDigest(event) !== event.eventDigest) {
      findings.push(`journal entry ${String(sequence)} fails its recomputed digest check: external modification or a torn write`);
    }
    if (sequence === 0) {
      if (event.previousEventDigest !== null) findings.push('journal entry 0 must carry previousEventDigest null');
    } else if (typeof event.previousEventDigest !== 'string' || !DIGEST_PATTERN.test(event.previousEventDigest)) {
      findings.push(`journal entry ${String(sequence)} carries no digest binding to its immediate predecessor: the hash chain is broken`);
    } else if (previousDigest === null || event.previousEventDigest !== previousDigest) {
      findings.push(`journal entry ${String(sequence)} names a predecessor digest that is not the digest of entry ${String(sequence - 1)}`);
    }
    if (!LIFECYCLE_EVENT_KINDS.includes(event.kind)) findings.push(`journal entry ${String(sequence)} carries the unknown kind ${JSON.stringify(event.kind)}`);
    else counts[event.kind] += 1;
    previousDigest = typeof event.eventDigest === 'string' ? event.eventDigest : null;
  }

  const kinds = journal.events.map(({event}) => event?.kind);
  const allowedSequences = [[], ['START_INTENT'], ['START_INTENT','START_COMMIT'], ['START_INTENT','START_COMMIT','STOP_RECORDED'], ['START_INTENT','START_COMMIT','STOP_RECORDED','FREEZE_INTENT'], ['START_INTENT','START_COMMIT','STOP_RECORDED','FREEZE_INTENT','FREEZE_COMMIT'], ['FREEZE_INTENT'], ['FREEZE_INTENT','FREEZE_COMMIT']];
  if (!allowedSequences.some(sequence => canonical(sequence) === canonical(kinds))) findings.push('the journal event order is not a valid lifecycle sequence');
  const intent = journal.events.find(({event}) => event?.kind === 'START_INTENT')?.event;
  const startCommit = journal.events.find(({event}) => event?.kind === 'START_COMMIT')?.event;
  if (intent && startCommit && canonical(intent.declaration) !== canonical(startCommit.declaration)) findings.push('the start commit changes the immutable declaration');
  if (state && intent && canonical(state.declaration) !== canonical(intent.declaration)) findings.push('the projection changes the immutable declaration');
  if (counts.FREEZE_COMMIT && state && journal.events.at(-1)?.event?.detail?.stateEventDigest !== state.stateDigest) findings.push('the freeze commit does not bind the current projection digest');
  if (counts.START_COMMIT && !counts.STOP_RECORDED && !counts.FREEZE_INTENT && state && startCommit?.detail?.stateEventDigest !== state.stateDigest) findings.push('the start commit does not bind the current projection digest');
  const stopEvent = journal.events.find(({event}) => event?.kind === 'STOP_RECORDED')?.event;
  if (stopEvent && state && (state.stoppedAt !== stopEvent.occurredAt || state.stopAttestation?.operator !== stopEvent.detail?.operator || state.stopAttestation?.agentStopped !== stopEvent.detail?.agentStopped || state.stopAttestation?.statement !== stopEvent.detail?.statement)) findings.push('the stop journal and projection attestation/time disagree');

  if (counts.START_INTENT > 1) findings.push('the journal carries more than one START_INTENT event');
  if (counts.START_COMMIT > 1) findings.push('the journal carries more than one START_COMMIT event');
  if (counts.STOP_RECORDED > 1) findings.push('the journal carries more than one STOP_RECORDED event');
  if (counts.FREEZE_INTENT > 1) findings.push('the journal carries more than one FREEZE_INTENT event');
  if (counts.FREEZE_COMMIT > 1) findings.push('the journal carries more than one FREEZE_COMMIT event');
  if (counts.START_COMMIT > 0 && counts.START_INTENT === 0) findings.push('the journal carries a START_COMMIT event without any START_INTENT event');
  if (counts.FREEZE_COMMIT > 0 && counts.FREEZE_INTENT === 0) findings.push('the journal carries a FREEZE_COMMIT event without any FREEZE_INTENT event');

  /* The state record must be the record the journal implies, bound to this run,
   * and must carry its own recomputed digest. */
  if (state !== null) {
    if (!isObject(state)) findings.push('the lifecycle state record is not an object');
    else {
      if (state.manifestId !== manifest.manifestId || state.runId !== manifest.runId) {
        findings.push('the lifecycle state record is bound to a different run or manifest');
      }
      if (typeof state.stateDigest !== 'string' || safeStateDigest(state) !== state.stateDigest) {
        findings.push('the lifecycle state record fails its recomputed digest check: external modification or a torn write');
      }
      if (state.manifestDigest !== null && manifest.manifestDigest !== null && state.manifestDigest !== manifest.manifestDigest) {
        findings.push('the lifecycle state record binds a manifest digest the run record does not carry');
      }
      const implied = impliedStateOf(counts);
      if (implied !== null && state.state !== implied) {
        findings.push(`the lifecycle state record states ${JSON.stringify(state.state)} while the journal implies ${JSON.stringify(implied)}`);
      }
    }
  } else if (counts.START_COMMIT === 0 && counts.FREEZE_COMMIT === 0 && journal.events.length === 0) {
    /* No record and an empty journal is the honest derived INITIALIZED state. */
  } else if (counts.START_COMMIT > 0 || counts.FREEZE_COMMIT > 0) {
    findings.push('the journal carries a committed transition while no lifecycle state record exists');
  }

  if (findings.length > 0) {
    fail(
      RESET_ERROR_CODES.JOURNAL_INCONSISTENT,
      `the reset is refused because the run's journal or state record cannot be verified: ${findings.join('; ')}`,
      { findings, state: state?.state ?? LIFECYCLE_DERIVED_STATE },
    );
  }

  /* Unresolved intent: an operation was interrupted. The run is mid-flight, so
   * a reset must not start a fresh identity over it. */
  if (counts.START_INTENT > counts.START_COMMIT) {
    fail(
      RESET_ERROR_CODES.JOURNAL_INCOMPLETE,
      'the journal carries a START_INTENT event without its START_COMMIT event: the run has an unresolved operation and a reset would mask it.',
      { interruptedOperation: 'START', state: state?.state ?? LIFECYCLE_DERIVED_STATE },
    );
  }
  if (counts.FREEZE_INTENT > counts.FREEZE_COMMIT) {
    fail(
      RESET_ERROR_CODES.JOURNAL_INCOMPLETE,
      'the journal carries a FREEZE_INTENT event without its FREEZE_COMMIT event: the run has an unresolved operation and a reset would mask it.',
      { interruptedOperation: 'FREEZE', state: state?.state ?? LIFECYCLE_DERIVED_STATE },
    );
  }

  const state0 = state === null ? LIFECYCLE_DERIVED_STATE : state.state;
  if (state0 === 'RUNNING') {
    fail(RESET_ERROR_CODES.STATE_REFUSED, 'a run whose lifecycle reports RUNNING is an active run and is never reset; record the stop first.', { state: state0 });
  }
  if (!RESET_ELIGIBLE_STATES.includes(state0)) {
    fail(RESET_ERROR_CODES.STATE_REFUSED, `the lifecycle state ${JSON.stringify(state0)} is not one of the states a reset may act on (${RESET_ELIGIBLE_STATES.join(', ')}).`, { state: state0 });
  }

  return Object.freeze({ state: state0, counts: Object.freeze(counts), entryCount: journal.events.length });
}

/** The state the accepted transition table implies from the journal counts. */
function impliedStateOf(counts) {
  if (counts.FREEZE_COMMIT > 0) return 'FROZEN';
  if (counts.STOP_RECORDED > 0) return 'STOP_RECORDED';
  if (counts.START_COMMIT > 0) return 'RUNNING';
  if (counts.START_INTENT > 0 || counts.FREEZE_INTENT > 0) return null;
  return 'INITIALIZED';
}

function safeEventDigest(event) {
  try {
    return lifecycleEventDigestOf(event);
  } catch {
    return null;
  }
}

function safeStateDigest(record) {
  try {
    return lifecycleStateDigestOf(record);
  } catch {
    return null;
  }
}

function storageRefusal(error) {
  if (error instanceof ResetError) return error;
  return new ResetError(
    RESET_ERROR_CODES.STORAGE_REFUSED,
    `the accepted storage seam refused the reset read: ${error instanceof Error ? error.message : String(error)}`,
    { storageCode: error?.code, cause: error },
  );
}

/* ========================================================================== */
/* Binding the caller's identities and challenge to the old manifest            */
/* ========================================================================== */

/**
 * Validate the caller-supplied initialisation request against what the old
 * manifest binds. The identities and the challenge package are the caller's:
 * a missing one is refused, never reconstructed out of the old binding. What is
 * checked here is that the supplied challenge identity is byte-identical to the
 * identity the old run bound, so the workload hash that carries into the new
 * manifest is the exact original one, and that the challenge source is the
 * original source root rather than a workspace or a solutions tree.
 */
function bindInitializationRequest(prepared, manifest) {
  const request = prepared.initializationRequest;
  const challenge = wantObject(request.challenge, 'the reset request.initializationRequest.challenge');
  for (const key of ['identity', 'sourceRoot', 'fileManifest', 'ownerRoots', 'evaluatorRoots']) {
    if (challenge[key] === undefined || challenge[key] === null) {
      fail(
        RESET_ERROR_CODES.CHALLENGE_MISMATCH,
        `the reset request.initializationRequest.challenge must carry ${key} explicitly; a reset never rebuilds a missing identity out of the old binding.`,
        { missingField: key },
      );
    }
  }

  /* The accepted RunManifest binds each identity by a digest that the manifest
   * contract recomputes from the identity record itself, so the binding cannot
   * be forged or left stale. The reset proves the supplied identity is THE
   * identity the old run bound by recomputing that self digest and comparing it
   * against the binding the old manifest carries. This is the accepted C1
   * binding, not a private hash convention. */
  const supplied = validateRecord('ChallengeIdentity', challenge.identity);
  const bound = manifest.bindings?.challenge;
  const boundDigest = typeof bound?.challengeIdentityDigest === 'string' ? bound.challengeIdentityDigest : null;
  if (boundDigest === null || !DIGEST_PATTERN.test(boundDigest)) {
    fail(RESET_ERROR_CODES.CHALLENGE_MISMATCH, 'the old run manifest carries no well-formed challenge binding to bind the reset to; a reset refuses to proceed against an unverifiable binding.');
  }
  if (identityDigestOf(supplied) !== boundDigest) {
    fail(
      RESET_ERROR_CODES.CHALLENGE_MISMATCH,
      'the challenge identity the reset carries is not the identity bound by the old run manifest: the challenge must be bound to the old manifest, not substituted.',
      {
        expectedChallengeId: bound?.challengeId ?? null,
        suppliedChallengeId: supplied?.challengeId ?? null,
        expectedChallengeIdentityDigest: boundDigest,
        suppliedChallengeIdentityDigest: identityDigestOf(supplied),
      },
    );
  }
  if (typeof bound.workloadDigest !== 'string' || !DIGEST_PATTERN.test(bound.workloadDigest)) {
    fail(RESET_ERROR_CODES.CHALLENGE_MISMATCH, 'the old manifest carries no well-formed workload digest to bind the reset to.');
  }
  if (supplied.workloadDigest !== bound.workloadDigest) {
    fail(RESET_ERROR_CODES.CHALLENGE_MISMATCH, 'the supplied challenge workload digest is not the exact original workload hash.', {
      expected: bound.workloadDigest,
      supplied: supplied.workloadDigest,
    });
  }

  for (const [key, bindingKey] of [['toolingIdentity', 'tooling'], ['evaluatorIdentity', 'evaluator']]) {
    if (request[key] === undefined || request[key] === null) {
      fail(RESET_ERROR_CODES.INVALID_ARGUMENT, `the reset request.initializationRequest must carry ${key} explicitly.`, { missingField: key });
    }
    const binding = manifest.bindings?.[bindingKey];
    const expected = typeof binding?.[`${bindingKey}IdentityDigest`] === 'string' ? binding[`${bindingKey}IdentityDigest`] : null;
    if (expected === null || !DIGEST_PATTERN.test(expected)) {
      fail(RESET_ERROR_CODES.PROVENANCE_MISMATCH, `the old run manifest carries no well-formed ${bindingKey} binding to bind the reset to.`, { field: key });
    }
    validateRecord(bindingKey === 'tooling' ? 'ToolingIdentity' : 'EvaluatorIdentity', request[key]);
    if (identityDigestOf(request[key]) !== expected) {
      fail(
        RESET_ERROR_CODES.PROVENANCE_MISMATCH,
        `the ${key} the reset carries is not the identity bound by the old run manifest.`,
        { field: key, expectedIdentityDigest: expected, suppliedIdentityDigest: identityDigestOf(request[key]) },
      );
    }
  }

  for (const key of ['architectureId', 'architectureKind', 'harness', 'securityModel']) {
    if (request[key] !== undefined && request[key] !== manifest[key]) {
      fail(
        RESET_ERROR_CODES.PROVENANCE_MISMATCH,
        `the reset request.initializationRequest.${key} is ${JSON.stringify(request[key])} while the old manifest binds ${JSON.stringify(manifest[key])}.`,
        { field: key },
      );
    }
  }
  if (request.declaredCeilingMinutes !== undefined && request.declaredCeilingMinutes !== manifest.declaredCeilingMinutes) {
    fail(RESET_ERROR_CODES.PROVENANCE_MISMATCH, 'the reset request.initializationRequest.declaredCeilingMinutes is not the ceiling the old manifest binds.', { field: 'declaredCeilingMinutes' });
  }

  /* The source of a reset is the ORIGINAL challenge source root, never a
   * workspace or a solutions tree. The accepted manifest binds the workspace and
   * state roots, so what can be proved here is that the named source is not
   * inside the old run's own mutable material. */
  const oldWorkspace = foldCase(path.resolve(manifest.participantWorkspaceRoot));
  const oldContainer = foldCase(path.resolve(manifest.evidenceRoot));
  const suppliedSource = foldCase(path.resolve(String(challenge.sourceRoot)));
  if (suppliedSource === oldWorkspace || suppliedSource === oldContainer || isStrictlyInside(oldWorkspace, suppliedSource) || isStrictlyInside(oldContainer, suppliedSource)) {
    fail(RESET_ERROR_CODES.PROVENANCE_MISMATCH, `a reset must source the original challenge source root, not the old run's own material: ${JSON.stringify(challenge.sourceRoot)} is the old workspace or state container or lies inside it.`, {
      suppliedSourceRoot: challenge.sourceRoot,
      oldWorkspaceRoot: manifest.participantWorkspaceRoot,
    });
  }

  return { ...request, output: prepared.output };
}

function canonical(value) {
  try {
    return lifecycleCanonicalJson(structuredClone(value));
  } catch {
    return `\u0000unserialisable:${describe(value)}`;
  }
}

/* ========================================================================== */
/* The accepted initialisation and its read-back                                */
/* ========================================================================== */

/**
 * Call the accepted C2 initialiser for the fresh destination and disclose the
 * actual outcome of the attempt. Nothing is cleaned up here: what the accepted
 * call published or left behind is reported with the failure, because a broad
 * delete outside the provenance of this operation would itself be the mutation
 * this command exists to avoid.
 */
async function runAcceptedInitialisation(initializationRequest, prepared, context) {
  let result;
  try {
    result = await initialiseRun(initializationRequest);
  } catch (error) {
    const fate = await describePublicationFate(prepared.output);
    const carried = error instanceof Error ? error.message : String(error);
    throw new ResetError(
      RESET_ERROR_CODES.INITIALISE_FAILED,
      `the accepted initialiser refused the fresh container (${carried}); the old run container is unchanged and the destination was left exactly as the accepted call left it.`,
      {
        cause: error,
        output: prepared.output,
        publicationFate: fate,
        oldContainerMutation: 'none',
        oldRunId: context.manifest.runId,
        oldManifestId: context.manifest.manifestId,
      },
    );
  }
  return result;
}

/** Report what actually exists at the destination after an attempt. */
async function describePublicationFate(output) {
  const stat = await lstatOrNull(output);
  if (stat === null) return 'nothing was created at the destination';
  if (stat.isSymbolicLink()) return 'a symbolic link stands at the destination';
  if (!stat.isDirectory()) return 'a non-directory stands at the destination';
  try {
    const names = await fs.readdir(output);
    if (names.length === 0) return 'an empty directory stands at the destination';
    return `the destination holds ${String(names.length)} top-level entr(y|ies) left behind: ${names.slice(0, 8).join(', ')}`;
  } catch (error) {
    return `the destination exists but could not be listed (${String(error?.code ?? 'unknown')})`;
  }
}

function assertDistinctIdentity(manifest, oldManifest) {
  const collisions = [];
  if (manifest.manifestId === oldManifest.manifestId) collisions.push('manifestId');
  if (manifest.runId === oldManifest.runId) collisions.push('runId');
  if (collisions.length > 0) {
    fail(
      RESET_ERROR_CODES.IDENTITY_NOT_DISTINCT,
      `the freshly created container reuses ${collisions.join(' and ')} of the old run; a reset must carry independently fresh identifiers.`,
      { fields: collisions, runId: manifest.runId, manifestId: manifest.manifestId },
    );
  }
}

/**
 * Read the new container back through the accepted storage seam before the
 * reset reports success, so the command returns only a container the accepted
 * storage verifies under its own bound identity.
 */
async function assertNewContainerPublished(result, prepared) {
  const stateRoot = path.join(prepared.output, '.benchboard');
  let storage;
  try {
    storage = createStorage({ root: stateRoot });
  } catch (error) {
    fail(RESET_ERROR_CODES.READBACK_FAILED, `the new state container ${JSON.stringify(stateRoot)} could not be opened for read-back: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  let readback;
  try {
    readback = await storage.read({
      relativePath: 'state/run.json',
      kind: 'benchboard:run-initialisation',
      id: result.manifest.manifestId,
    });
  } catch (error) {
    fail(RESET_ERROR_CODES.READBACK_FAILED, `the new container does not read back the manifest the reset reports: ${error instanceof Error ? error.message : String(error)}`, { cause: error, manifestId: result.manifest.manifestId });
  }
  validateRecord('RunManifest', readback);
  if (readback.manifestId !== result.manifest.manifestId || readback.runId !== result.manifest.runId) {
    fail(RESET_ERROR_CODES.READBACK_FAILED, 'the new container reads back a manifest bound to different identifiers than the reset reports.', {
      expectedRunId: result.manifest.runId,
      foundRunId: readback.runId,
    });
  }
  if (canonical(readback) !== canonical(result.manifest)) {
    fail(RESET_ERROR_CODES.READBACK_FAILED, 'the new container manifest does not match the complete accepted publication.', { manifestId: result.manifest.manifestId });
  }
}

async function oldContainerProof(root) {
  const entries = [];
  async function walk(directory, relative) {
    const status = await fs.lstat(directory);
    if (status.isSymbolicLink() || !status.isDirectory()) fail(RESET_ERROR_CODES.PROVENANCE_MISMATCH, 'the old container contains a linked or replaced directory.');
    entries.push([relative, 'directory', String(status.dev), String(status.ino)]);
    for (const name of (await fs.readdir(directory)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      if (child === '.benchboard/.storage/lock') continue; // this command's temporary lock
      const absolute = path.join(directory, name);
      const item = await fs.lstat(absolute);
      if (item.isSymbolicLink()) fail(RESET_ERROR_CODES.PROVENANCE_MISMATCH, 'the old container contains a link; reset does not read through it.');
      if (item.isDirectory()) await walk(absolute, child);
      else if (item.isFile()) entries.push([child, 'file', String(item.dev), String(item.ino), sha256(await fs.readFile(absolute))]);
      else fail(RESET_ERROR_CODES.PROVENANCE_MISMATCH, 'the old container contains a non-regular entry.');
    }
  }
  if (await directoryHasLinkAncestor(root)) fail(RESET_ERROR_CODES.PROVENANCE_MISMATCH, 'the old container ancestor is not ordinary.');
  await walk(root, '');
  return entries;
}

function clonePublic(value) {
  const plain = structuredClone(value);
  return deepFreeze(plain);
}

function deepFreeze(value) {
  if (typeof value !== 'object' || value === null) return value;
  for (const key of Object.keys(value)) value[key] = deepFreeze(value[key]);
  return Object.freeze(value);
}