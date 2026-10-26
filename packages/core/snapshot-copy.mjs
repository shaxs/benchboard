/**
 * BenchBoard core snapshot-copy primitive (C3 / T2, repaired under T6).
 *
 * T6 integrity repair (three Captain-demonstrated acceptance gaps, closed
 * here without changing the selection policy, the legacy digest, the source
 * gates or any error-code vocabulary):
 *   - a hook may rename the claimed root aside, create a NEW root at the same
 *     path and move the original files into it — the file inodes are still
 *     ours, so per-file gates alone cannot see the swap;
 *   - when the selection is EMPTY, removing the claimed root and recreating it
 *     as a foreign empty directory was likewise accepted (no file gate existed
 *     for an empty selection);
 *   - `verifySnapshot` reported unexpected extra FILES but silently accepted
 *     unexpected extra DIRECTORIES (including empty ones).
 * The claim now binds the full identity chain — the claimed root plus every
 * host ancestor below it to the volume root — and every gate and the cleanup
 * re-prove that chain, so a replaced root or swapped ancestor is always
 * detected as ownership loss regardless of content or file inodes (an empty
 * selected root is NOT exempt). `verifySnapshot` now verifies the exact
 * physical directory set implied by the expected file paths and rejects any
 * extra directory exactly as it rejects an extra file.
 *
 * Harness-neutral ES module: imports Node builtins plus the accepted C1 core
 * modules (`paths.mjs`, `identity.mjs`) only. No lifecycle/state/schema
 * integration, no DSH, no configuration, owner-root or current-directory
 * defaults, and no import of the historical `runner/` surface.
 *
 * This module is the frozen C3 snapshot-copy contract implementation: the
 * copy primitive that freeze integration consumes. It copies a *selected*
 * view of an application workspace into an
 * exclusively-new snapshot workspace, byte-exactly, with a verifiable
 * path/bytes/SHA-256 inventory, and removes its own material again when any
 * integrity gate fails. Removal is ownership-aware and nonrecursive: only paths
 * this call created AND still proves it created (creation identity +
 * post-replacement checks + content digest) are ever unlinked. Foreign
 * insertions and identical-content foreign replacements are never adopted into
 * cleanup ownership; their actual fate is reported honestly.
 *
 * Cooperative boundary, stated explicitly. These checks detect tampering by a
 * cooperating or careless operator inside the cooperative harness protocol.
 * They are NOT an adversarial-OS guarantee. Specifically:
 *   - a racing process can, inside a microscopic window, swap bytes between a
 *     read and its re-read undetected unless the changed bytes survive to the
 *     verification re-read;
 *   - no directory "atomic visibility" or atomic-directory-creation property is
 *     claimed or relied on: exclusion of a concurrent claimer rests on an
 *     exclusive `mkdir` (EEXIST for the loser) plus emptiness revalidation;
 *   - hard links cannot be excluded as a data channel here: on this Windows
 *     scratch volume a hard-link creation was measured to succeed (link count
 *     became 2), so the hard-link hazard is disclosed as an unqualified
 *     limitation rather than claimed to be mitigated;
 *   - `O_NOFOLLOW` is not defined by Node/libuv on win32 (measured: undefined);
 *     the create path therefore uses `O_WRONLY|O_CREAT|O_EXCL` only and does
 *     not claim nofollow semantics on Windows;
 *   - power loss, mandatory locks, and privileged external actors are out of
 *     scope.
 *
 * Selection policy `benchboard-application-snapshot-v1`:
 *   excluded = EXACT top-level (immediate child of `workspaceRoot`) names,
 *   compared byte-for-byte (no case/Unicode folding):
 *     .git  node_modules  dist  .agent-teams  .benchboard  .cache  coverage  .vite
 *   Everything else at the top level — application files, configuration, the
 *   original package/lock files, visible tests, participant additions and all
 *   other dotfiles — is copied with raw bytes. A nested directory whose name
 *   equals an exclusion (e.g. `src/node_modules`, `vendor/.git`) is NOT skipped:
 *   the exclusion set is exact top-level matching only, deliberately, so the
 *   policy is a single unambiguous function of the workspace listing and a
 *   participant cannot reason about a moving "any depth" skip rule. A top-level
 *   entry whose spelling differs from an exclusion only by case/Unicode folding
 *   is therefore INCLUDED, and the full-tree case-collision guard still rejects
 *   the workspace when such a spelling collides with another entry.
 *   Exclusions are pruned from selection only after the whole-tree physical
 *   safety scan has passed, so a link or special file inside an excluded name
 *   can never evade safety by sitting there.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PathError, assertDisjointRoots } from './paths.mjs';
import { hashEntries, sha256 } from './identity.mjs';

/** Identifier of the frozen selection policy implemented here. */
export const SELECTION_POLICY_ID = 'benchboard-application-snapshot-v1';

/**
 * The one authoritative exclusion set. Entries are exact top-level basenames,
 * matched byte-for-byte. Do not extend informally: the policy id above freezes
 * this list for C3.
 */
export const SELECTION_POLICY_EXCLUSIONS = Object.freeze([
  '.git',
  'node_modules',
  'dist',
  '.agent-teams',
  '.benchboard',
  '.cache',
  'coverage',
  '.vite',
]);

/** Identifier of the inventory digest algorithm (the accepted legacy pair digest). */
export const SNAPSHOT_HASH_ALGORITHM_ID = 'benchboard-sha256-tree-v1';

/** Machine-readable rejection reasons; stable, additive, test-assertable. */
export const SNAPSHOT_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_ROOT: 'INVALID_ROOT',
  ROOTS_NOT_DISJOINT: 'ROOTS_NOT_DISJOINT',
  DESTINATION_EXISTS: 'DESTINATION_EXISTS',
  DESTINATION_CONCURRENT_CLAIM: 'DESTINATION_CONCURRENT_CLAIM',
  SOURCE_NOT_FOUND: 'SOURCE_NOT_FOUND',
  SOURCE_NOT_A_DIRECTORY: 'SOURCE_NOT_A_DIRECTORY',
  LINK_DETECTED: 'LINK_DETECTED',
  LINK_ANCESTOR: 'LINK_ANCESTOR',
  SPECIAL_FILE: 'SPECIAL_FILE',
  CASE_COLLISION: 'CASE_COLLISION',
  INVALID_NAME: 'INVALID_NAME',
  SOURCE_MUTATED: 'SOURCE_MUTATED',
  SNAPSHOT_VERIFICATION_FAILED: 'SNAPSHOT_VERIFICATION_FAILED',
  OWNERSHIP_LOST: 'OWNERSHIP_LOST',
  SNAPSHOT_MUTATED: 'SNAPSHOT_MUTATED',
  HOOK_FAILED: 'HOOK_FAILED',
  INTERNAL: 'INTERNAL',
});

/** Sentinel for "this subtree is excluded by policy". */
const EXCLUDED = Symbol('excluded');

/** Sentinel for "this directory is included but holds no selected content". */
const EMPTY_SELECTED = Symbol('empty-selected');

/** Error type carrying a stable machine code and, post-claim, an honest fate. */
class SnapshotError extends Error {
  /**
   * @param {string} code one of SNAPSHOT_ERROR_CODES
   * @param {string} message
   * @param {SnapshotFailureFate} [fate] present once the destination was claimed
   */
  constructor(code, message, fate) {
    super(`${code}: ${message}`);
    this.name = 'SnapshotError';
    this.code = code;
    if (fate !== void 0) this.fate = fate;
  }
}

/**
 * Copy the selected application view of `workspaceRoot` into the exclusively-new
 * `outputRoot`, verify it byte-for-byte, and remove it again if any gate fails.
 *
 * Pipeline (the order is part of the contract):
 *   1. argument validation; roots explicit, absolute, non-UNC, non-volume-root;
 *   2. link-free ancestor check for every involved root (canonical aliases
 *      rejected), and destination disjointness against EACH supplied protected
 *      root compared through real paths (protected roots may nest each other —
 *      protected-versus-protected overlap is deliberately not rejected);
 *   3. whole-source physical safety scan (links, specials, case/fold
 *      collisions, invalid names — inside excluded names as well). Exclusions
 *      are pruned only AFTER this scan;
 *   4. selected inventory `{path, bytes, sha256}` sorted by raw POSIX lexical
 *      order; digest = legacy `[path, sha256]` pair digest of `identity.mjs`;
 *   5. exclusive destination claim: `mkdir` must succeed. An existing target
 *      (even an empty directory) and a concurrent claimer are refused, never
 *      adopted, never cleaned;
 *   6. copy directory-by-directory parent-first, file-by-file, registering each
 *      created path's identity incrementally (created-file + ancestor identity
 *      ownership, filled as work proceeds, not reconstructed afterwards);
 *   7. verification pass (the "pre / copy / source-after / copied inventory"
 *      gate): every copied file is re-read from disk and re-hashed against the
 *      selection; every created directory is re-proven to still be a real
 *      directory with its creation identity; the full snapshot inventory is
 *      recomputed and must equal the pre-copy selected inventory exactly
 *      (path, bytes, sha256) with an equal digest; the source is re-listed and
 *      re-hashed (source-after gate);
 *   8. every hook awaited, one after the other; then the FINAL revalidation
 *      (the same gate again, after ALL hooks) before success;
 *   9. on any failure after the claim: nonrecursive, ownership-proven cleanup
 *      (unlink of files still proven created by us, rmdir of provably-empty
 *      directories still carrying our creation identity — never `rm -rf`,
 *      never an adoption or deletion of a foreign replacement), then an error
 *      whose `fate` object reports the actual removed / residual / preserved-
 *      foreign paths and cleanup errors.
 *
 * There is no retry or recopy after the verification pass: once bytes have been
 * verified they are never re-read from the source into the publication again; a
 * failing gate aborts instead.
 *
 * @param {CopySnapshotRequest} request
 * @returns {Promise<CopySnapshotResult>} deep-frozen on success
 */
export async function copySnapshot(request) {
  const { workspaceRoot, outputRoot, protectedRoots, hooks } = validateCopyRequest(request);

  // (2) canonical-alias safety for every root we will touch. A root that does
  // not exist yet (a planned snapshot destination parent, for example) still
  // gets its existing ancestor chain link-checked; with no real path to
  // compare, disjointness falls back to lexical identity for that root.
  const workspaceReal = requireLinkFreeRealRoot(workspaceRoot, 'workspaceRoot');
  const outputParentReal = requireLinkFreeRealRoot(path.dirname(outputRoot), 'outputRoot parent');
  const protectedReals = protectedRoots.map((root, index) => requireLinkFreeRealRoot(root, `protectedRoots[${index}]`));

  // Destination disjointness against each protected root and against the
  // workspace, compared through real paths so a canonical alias is caught.
  const outputIdentity = pathIdentity(outputRoot);
  const comparisons = [
    ['workspaceRoot', workspaceReal, workspaceRoot],
    ...protectedRoots.map((root, index) => [`protectedRoots[${index}]`, protectedReals[index], root]),
  ];
  for (const [label, real, display] of comparisons) {
    assertDisjointPair(outputIdentity, outputRoot, label, real ?? pathIdentity(display));
  }

  // The claim site must sit strictly inside its (link-free) parent, and the
  // parent chain must actually be walkable so the claim is possible.
  if (outputParentReal === null) {
    throw new SnapshotError(
      SNAPSHOT_ERROR_CODES.INVALID_ROOT,
      `the parent chain of outputRoot ${JSON.stringify(outputRoot)} does not exist; a snapshot destination is never created through a missing parent chain.`,
    );
  }
  if (!isStrictlyInsideReal(pathIdentity(outputParentReal), outputIdentity)) {
    throw new SnapshotError(
      SNAPSHOT_ERROR_CODES.ROOTS_NOT_DISJOINT,
      `outputRoot ${JSON.stringify(outputRoot)} is not a strict child of its resolved parent ${JSON.stringify(outputParentReal)}.`,
    );
  }

  // (3) whole-source safety BEFORE exclusions are pruned, then (4) selection.
  const selected = scanAndSelect(workspaceRoot);
  const preInventory = buildInventory(selected);
  const preDigest = digestOf(preInventory);

  // (5) exclusive claim of the destination. The claim returns the creation
  // identity of the claimed root together with the identities of its host
  // ancestors: removal of the root — and every later ownership proof — is only
  // ever attempted while that full chain is still present (T6).
  const claim = claimDestination(outputRoot);
  const fate = {
    phase: 'claimed',
    cleanupPerformed: false,
    removedFiles: [],
    removedDirectories: [],
    residualPaths: [],
    foreignPreserved: [],
    cleanupErrors: [],
  };

  // Incremental ownership ledger, filled as the copy creates each path.
  const directoryLedger = []; // parent-first, one entry per created directory
  const fileLedger = []; // creation order, one entry per created file
  const ancestorIdentities = new Map(); // absolute path -> identity at creation

  try {
    // (6a) Before the copy traversal begins, re-prove the full claim chain
    // (claimed root + every captured host ancestor). A swap that happened in
    // the microscopic window between the claim and the traversal is ownership
    // loss before a single byte is written (T6).
    const claimChainBeforeTraversal = proveClaimChain(outputRoot, claim);
    if (claimChainBeforeTraversal !== null) {
      throw new SnapshotError(
        SNAPSHOT_ERROR_CODES.OWNERSHIP_LOST,
        `the snapshot-root claim chain is no longer proven before the copy traversal: ${claimChainBeforeTraversal}.`,
      );
    }

    // (6) directories first, parents before children, so an ancestor is always
    // registered before any descendant of it exists.
    for (const relDir of planDirectories(selected)) {
      const absolute = path.join(outputRoot, ...relDir.split('/'));
      try {
        fs.mkdirSync(absolute);
      } catch (error) {
        throw new SnapshotError(
          SNAPSHOT_ERROR_CODES.INTERNAL,
          `could not create snapshot directory ${JSON.stringify(relDir)}: ${error.message}`,
        );
      }
      const status = fs.lstatSync(absolute);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new SnapshotError(
          SNAPSHOT_ERROR_CODES.OWNERSHIP_LOST,
          `snapshot directory ${JSON.stringify(relDir)} is not a real directory immediately after creation.`,
        );
      }
      directoryLedger.push({ relPath: relDir, absolute, createdInode: identityOf(status) });
      ancestorIdentities.set(absolute, identityOf(status));
    }

    for (const entry of selected) {
      const absolute = path.join(outputRoot, ...entry.path.split('/'));
      const sourceAbsolute = path.join(workspaceRoot, ...entry.path.split('/'));
      let buffer;
      try {
        buffer = fs.readFileSync(sourceAbsolute);
      } catch (error) {
        throw new SnapshotError(
          SNAPSHOT_ERROR_CODES.SOURCE_MUTATED,
          `source file ${JSON.stringify(entry.path)} could not be read during the copy pass: ${error.message}`,
        );
      }
      // O_EXCL makes an already-existing target an error; O_NOFOLLOW is not
      // available on win32 and is therefore deliberately not combined here.
      // `openSync` returns a numeric file descriptor on this runtime, so the
      // write/close go through the descriptor-based sync API.
      const descriptor = fs.openSync(absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      try {
        fs.writeFileSync(descriptor, buffer);
      } finally {
        fs.closeSync(descriptor);
      }
      const after = fs.lstatSync(absolute);
      if (after.isSymbolicLink() || !after.isFile()) {
        throw new SnapshotError(
          SNAPSHOT_ERROR_CODES.OWNERSHIP_LOST,
          `snapshot file ${JSON.stringify(entry.path)} is not a regular file immediately after creation.`,
        );
      }
      if (buffer.byteLength !== entry.bytes || sha256(buffer) !== entry.sha256) {
        throw new SnapshotError(
          SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED,
          `snapshot file ${JSON.stringify(entry.path)} does not match the selected inventory at the copy pass (bytes ${buffer.byteLength}/${entry.bytes}).`,
        );
      }
      fileLedger.push({ relPath: entry.path, absolute, createdInode: identityOf(after), expectedSha256: entry.sha256 });
      // Record the ancestor-identity binding for this file's chain explicitly
      // so a later ancestor swap is detectable even if the parent directory
      // was created for another file.
      for (const ancestor of ancestorsOf(outputRoot, entry.path)) {
        if (!ancestorIdentities.has(ancestor)) {
          throw new SnapshotError(
            SNAPSHOT_ERROR_CODES.OWNERSHIP_LOST,
            `snapshot ancestor ${JSON.stringify(relativeOf(outputRoot, ancestor))} of ${JSON.stringify(entry.path)} was never registered as created by this operation.`,
          );
        }
      }
    }
    fate.phase = 'copied';

    // (7) verification pass. No recopy from the source into the publication
    // happens in or after this pass; a failing gate aborts.
    const ledger = { directoryLedger, fileLedger, ancestorIdentities };
    verifyPass(outputRoot, claim, workspaceRoot, selected, preInventory, preDigest, ledger, 'post-copy');

    // (8) hooks: cooperative, awaited, one after the other. A hook is an
    // observation/fault seam; its own failure aborts the publication.
    for (const [index, hook] of hooks.entries()) {
      try {
        await hook();
      } catch (error) {
        if (error instanceof SnapshotError) throw error;
        throw new SnapshotError(
          SNAPSHOT_ERROR_CODES.HOOK_FAILED,
          `hook at index ${index} failed: ${error && error.message ? error.message : String(error)}`,
        );
      }
    }

    // (9) FINAL revalidation after every hook has completed.
    verifyPass(outputRoot, claim, workspaceRoot, selected, preInventory, preDigest, ledger, 'final-hook');

    // Success: the publication stands. The ledger is NOT applied on success —
    // the snapshot is the product; nothing is unlinked or removed.
    return Object.freeze({
      ok: true,
      selectionPolicyId: SELECTION_POLICY_ID,
      hashAlgorithmId: SNAPSHOT_HASH_ALGORITHM_ID,
      workspaceRoot: toDisplay(workspaceRoot),
      outputRoot: toDisplay(outputRoot),
      inventory: Object.freeze(preInventory.map((entry) => Object.freeze({ ...entry }))),
      digest: preDigest,
      fileCount: preInventory.length,
      totalBytes: preInventory.reduce((sum, entry) => sum + entry.bytes, 0),
      fate: Object.freeze({ ...fate, phase: 'published' }),
    });
  } catch (error) {
    // Ownership-aware, nonrecursive rollback. Never `rm -rf`; never touch an
    // entry whose current identity is not the identity we created.
    fate.cleanupPerformed = true;
    runCleanup({ outputRoot, claim, fileLedger, directoryLedger, fate });
    if (error instanceof SnapshotError) {
      error.fate = Object.freeze({ ...fate });
      throw error;
    }
    const internal = new SnapshotError(
      SNAPSHOT_ERROR_CODES.INTERNAL,
      `unexpected internal failure during snapshot copy: ${error && error.message ? error.message : String(error)}`,
    );
    internal.fate = Object.freeze({ ...fate });
    throw internal;
  }
}

/**
 * Verify a snapshot root against an expected inventory and digest.
 *
 * Reads only what the expected inventory names, lstat-checks every entry (a
 * link, a special file, a vanished file or a size/hash change is a failure) and
 * additionally refuses any unexpected entry below `snapshotRoot` (extra files
 * or directories, i.e. insertions) and any duplicate/malformed expectation.
 * Data-level problems are returned as `{ ok:false, failures:[…] }` — the full
 * concrete list, not just the first — so callers can report every defect; only
 * malformed *arguments* throw.
 *
 * @param {VerifySnapshotRequest} request
 * @returns {Promise<VerifySnapshotResult>} deep-frozen
 */
export async function verifySnapshot(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ARGUMENT, 'verifySnapshot({ snapshotRoot, expectedInventory, expectedDigest, selectionPolicyId }): an options object is required.');
  }
  const unknown = Object.keys(request).filter((key) => key !== 'snapshotRoot' && key !== 'expectedInventory' && key !== 'expectedDigest' && key !== 'selectionPolicyId');
  if (unknown.length > 0) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ARGUMENT, `verifySnapshot(...): unknown option(s): ${unknown.join(', ')}.`);
  }
  const { snapshotRoot, expectedInventory, expectedDigest, selectionPolicyId } = request;
  const rootPath = requireAbsoluteRoot(snapshotRoot, 'snapshotRoot');
  if (!Array.isArray(expectedInventory)) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ARGUMENT, 'verifySnapshot(...): expectedInventory must be an array of { path, bytes, sha256 } entries.');
  }
  if (typeof expectedDigest !== 'string' || !/^[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ARGUMENT, 'verifySnapshot(...): expectedDigest must be a 64-character lowercase hex string.');
  }
  if (selectionPolicyId !== SELECTION_POLICY_ID) {
    throw new SnapshotError(
      SNAPSHOT_ERROR_CODES.INVALID_ARGUMENT,
      `verifySnapshot(...): selectionPolicyId must be ${JSON.stringify(SELECTION_POLICY_ID)}, got ${JSON.stringify(selectionPolicyId)}.`,
    );
  }

  const failures = [];
  let rootStatus;
  try {
    rootStatus = fs.lstatSync(rootPath);
  } catch {
    return Object.freeze({ ok: false, failures: Object.freeze([`snapshotRoot is not an existing directory: ${JSON.stringify(snapshotRoot)}`]) });
  }
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    return Object.freeze({ ok: false, failures: Object.freeze([`snapshotRoot must be a real directory, not a link or file: ${JSON.stringify(snapshotRoot)}`]) });
  }
  requireLinkFreeRealRoot(snapshotRoot, 'snapshotRoot');

  // Normalise the expectation. Duplicates and malformed entries are failures
  // of the expectation itself, reported as data, not thrown.
  const expectedByPath = new Map();
  for (const [index, entry] of expectedInventory.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      failures.push(`expectedInventory[${index}] is not an object`);
      continue;
    }
    const okPath = typeof entry.path === 'string' && isExactRelativePosixPath(entry.path);
    const okSha = typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256);
    const okBytes = Number.isInteger(entry.bytes) && entry.bytes >= 0;
    if (!okPath || !okSha || !okBytes) {
      failures.push(`expectedInventory[${index}] is malformed (path/bytes/sha256 domain violation)`);
      continue;
    }
    if (expectedByPath.has(entry.path)) {
      failures.push(`expectedInventory contains a duplicate path ${JSON.stringify(entry.path)}`);
      continue;
    }
    expectedByPath.set(entry.path, entry);
  }

  // Walk the snapshot root for physical safety and unexpected entries. T6:
  // directories are collected as well (kind 'directory') so the EXACT physical
  // directory set can be compared against the set implied by the expected
  // file paths — an unexpected directory (empty or occupied) is an insertion
  // just like an unexpected file.
  let actual;
  try {
    const all = [];
    collectAllEntries(rootPath, rootPath, all, failures);
    all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    actual = all;
  } catch (error) {
    failures.push(`snapshot root could not be walked safely: ${error && error.message ? error.message : String(error)}`);
    actual = [];
  }
  const actualFiles = actual.filter((entry) => entry.kind === 'file');
  const actualDirectories = new Set(actual.filter((entry) => entry.kind === 'directory').map((entry) => entry.path));
  const actualByPath = new Map(actualFiles.map((entry) => [entry.path, entry]));

  for (const [expectedPath, expectedEntry] of expectedByPath) {
    const found = actualByPath.get(expectedPath);
    const probe = path.join(rootPath, ...expectedPath.split('/'));
    if (found === void 0) {
      let kind = 'missing';
      try {
        const status = fs.lstatSync(probe);
        if (status.isSymbolicLink()) kind = 'replaced-by-link';
        else if (status.isFile()) kind = 'present-but-unwalkable';
        else kind = 'replaced-by-special';
      } catch { /* genuinely missing */ }
      failures.push(`expected entry ${JSON.stringify(expectedPath)} is ${kind} in the snapshot`);
      continue;
    }
    if (found.bytes !== expectedEntry.bytes) {
      failures.push(`entry ${JSON.stringify(expectedPath)} has ${found.bytes} bytes, expected ${expectedEntry.bytes}`);
      continue;
    }
    let actualSha;
    try {
      actualSha = sha256(fs.readFileSync(probe));
    } catch (error) {
      failures.push(`entry ${JSON.stringify(expectedPath)} could not be read: ${error.message}`);
      continue;
    }
    if (actualSha !== expectedEntry.sha256) {
      failures.push(`entry ${JSON.stringify(expectedPath)} sha256 mismatch (content changed)`);
    }
  }
  for (const entry of actualFiles) {
    if (!expectedByPath.has(entry.path)) {
      failures.push(`unexpected entry ${JSON.stringify(entry.path)} exists in the snapshot (insertion or selection drift)`);
    }
  }

  // (T6) Exact physical directory set: the snapshot must contain EXACTLY the
  // directories implied by the expected file paths. An extra directory — empty
  // or occupied — is an insertion and fails just like an extra file; a missing
  // implied directory would already have failed an expected-file lookup, but
  // it is named here as well for a complete report.
  const impliedDirectories = collectPlannedDirectories([...expectedByPath.values()]);
  for (const directoryPath of [...actualDirectories].sort()) {
    if (!impliedDirectories.has(directoryPath)) {
      failures.push(`unexpected directory ${JSON.stringify(directoryPath)} exists in the snapshot (directory insertion or selection drift)`);
    }
  }
  for (const directoryPath of [...impliedDirectories].sort()) {
    if (!actualDirectories.has(directoryPath)) {
      failures.push(`implied directory ${JSON.stringify(directoryPath)} is missing from the snapshot`);
    }
  }

  if (failures.length === 0) {
    // Digest gate over the expected set: the digest binds [path, sha256].
    const ordered = [...expectedByPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    let recomputed;
    try {
      recomputed = digestOf(ordered);
    } catch (error) {
      failures.push(`expected inventory digest could not be computed: ${error.message}`);
      recomputed = null;
    }
    if (recomputed !== null && recomputed !== expectedDigest) {
      failures.push(`expectedDigest does not match the expected inventory (computed ${recomputed})`);
    }
  }

  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
}

/* ------------------------------------------------------------------ *
 * request validation
 * ------------------------------------------------------------------ */

function validateCopyRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ARGUMENT, 'copySnapshot({ workspaceRoot, outputRoot, protectedRoots, hooks? }): an options object is required.');
  }
  const unknown = Object.keys(request).filter((key) => key !== 'workspaceRoot' && key !== 'outputRoot' && key !== 'protectedRoots' && key !== 'hooks');
  if (unknown.length > 0) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ARGUMENT, `copySnapshot(...): unknown option(s): ${unknown.join(', ')}.`);
  }
  const { workspaceRoot, outputRoot, protectedRoots, hooks } = request;
  // A required option that is simply not supplied is a malformed request
  // (INVALID_ARGUMENT); a supplied value that is not a usable root is a bad
  // root (INVALID_ROOT). Keeping the two classes apart makes the failure mode
  // legible to callers.
  for (const required of ['workspaceRoot', 'outputRoot', 'protectedRoots']) {
    if (request[required] === void 0) {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ARGUMENT, `copySnapshot(...): ${required} is a required option and was not supplied.`);
    }
  }
  const workspace = requireAbsoluteRoot(workspaceRoot, 'workspaceRoot');
  const output = requireAbsoluteRoot(outputRoot, 'outputRoot');
  if (!Array.isArray(protectedRoots)) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ARGUMENT, 'copySnapshot(...): protectedRoots must be an array of explicit absolute root paths (possibly empty).');
  }
  const protectedList = protectedRoots.map((entry, index) => {
    const value = typeof entry === 'string'
      ? entry
      : (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.path === 'string' ? entry.path : null);
    if (value === null) {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ARGUMENT, `copySnapshot(...): protectedRoots[${index}] must be an absolute path string or a { label, path } object.`);
    }
    return requireAbsoluteRoot(value, `protectedRoots[${index}]`);
  });
  if (hooks !== void 0 && !Array.isArray(hooks)) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ARGUMENT, 'copySnapshot(...): hooks must be an array of zero-argument callables.');
  }
  if (hooks !== void 0) {
    for (const [index, hook] of hooks.entries()) {
      if (typeof hook !== 'function') {
        throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ARGUMENT, `copySnapshot(...): hooks[${index}] must be a function.`);
      }
    }
  }
  // Lexical self-check: the workspace is implicitly protected.
  try {
    assertDisjointRoots([
      { label: 'workspaceRoot', path: workspace },
      { label: 'outputRoot', path: output },
    ]);
  } catch (error) {
    if (error instanceof PathError) {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.ROOTS_NOT_DISJOINT, error.message);
    }
    throw error;
  }
  for (const [index, protectedPath] of protectedList.entries()) {
    if (isSameRoot(protectedPath, output)) {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.ROOTS_NOT_DISJOINT, `outputRoot names the same directory as protectedRoots[${index}].`);
    }
    // A protected root may legitimately contain the workspace or the other
    // protected roots; only identity with the destination is refused here.
    void index;
  }
  return { workspaceRoot: workspace, outputRoot: output, protectedRoots: protectedList, hooks: hooks === void 0 ? [] : hooks };
}

/* ------------------------------------------------------------------ *
 * root helpers
 * ------------------------------------------------------------------ */

function requireAbsoluteRoot(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ROOT, `${label}: an explicit absolute path string is required.`);
  }
  if (value.startsWith('\\\\?\\') || value.startsWith('//') || value.startsWith('\\\\')) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ROOT, `${label}: extended-length and UNC roots are not supported: ${value}`);
  }
  let spelling = value.startsWith('file://') ? fileURLToPath(value) : value;
  if (isRelativeSpelling(spelling)) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ROOT, `${label}: roots are always explicit and absolute, got the relative path ${JSON.stringify(value)}.`);
  }
  const resolved = path.resolve(spelling);
  if (!path.isAbsolute(resolved)) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ROOT, `${label}: an explicit absolute path is required, got ${JSON.stringify(value)}.`);
  }
  if (isFilesystemRoot(resolved)) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ROOT, `${label}: a root must be a subdirectory, not the filesystem/volume root ${JSON.stringify(value)}.`);
  }
  return resolved;
}

function isRelativeSpelling(value) {
  if (value === '.' || value === '..' || value.startsWith('./') || value.startsWith('../')) return true;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  return !/^[A-Za-z]:[\\/]/.test(value) && !value.startsWith('\\\\');
}

function isFilesystemRoot(candidate) {
  const resolved = path.resolve(candidate);
  const rootForm = path.parse(resolved).root;
  return rootForm !== '' && (resolved === rootForm || resolved === rootForm.slice(0, -1));
}

function requireLinkFreeRealRoot(value, label) {
  const resolved = path.resolve(value);
  let at = resolved;
  for (;;) {
    let status;
    try {
      status = fs.lstatSync(at);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        // This component does not exist; its own ancestors are still checked
        // by the continuing loop (the parent of a missing path is probed).
        const parent = path.dirname(at);
        if (parent === at) break;
        at = parent;
        continue;
      }
      throw new SnapshotError(
        SNAPSHOT_ERROR_CODES.INVALID_ROOT,
        `${label} ${JSON.stringify(value)} or one of its ancestors could not be inspected: ${error.message}`,
      );
    }
    if (status.isSymbolicLink()) {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.LINK_ANCESTOR, `${label}: link ancestor prohibited: ${JSON.stringify(at)}.`);
    }
    const parent = path.dirname(at);
    if (parent === at) break;
    at = parent;
  }
  try {
    return stripNamespace(fs.realpathSync.native(resolved));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      // Non-existing roots (a planned snapshot destination, for example) have
      // no canonical alias to compare against; their link safety was just
      // proven for the existing ancestor chain, and callers that need a real
      // path must require existence separately.
      return null;
    }
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_ROOT, `${label} could not be resolved: ${error.message}`);
  }
}

function stripNamespace(target) {
  if (target.startsWith('\\\\?\\UNC\\')) return `\\\\${target.slice(8)}`;
  if (target.startsWith('\\\\?\\')) return target.slice(4);
  return target;
}

function pathIdentity(target) {
  const namespace = stripNamespace(path.resolve(target)).split('\\').join('/');
  return path.sep === '/' ? namespace : namespace.toLowerCase();
}

function isSameRoot(left, right) {
  return pathIdentity(left) === pathIdentity(right);
}

function assertDisjointPair(outputIdentity, outputDisplay, label, realOfOther) {
  const otherIdentity = pathIdentity(realOfOther);
  if (outputIdentity === otherIdentity) {
    throw new SnapshotError(
      SNAPSHOT_ERROR_CODES.ROOTS_NOT_DISJOINT,
      `outputRoot ${JSON.stringify(outputDisplay)} names the same directory as ${label} (compared through real paths).`,
    );
  }
  if (isStrictlyInsideReal(outputIdentity, otherIdentity) || isStrictlyInsideReal(otherIdentity, outputIdentity)) {
    throw new SnapshotError(
      SNAPSHOT_ERROR_CODES.ROOTS_NOT_DISJOINT,
      `outputRoot ${JSON.stringify(outputDisplay)} is not disjoint from ${label} (compared through real paths).`,
    );
  }
}

function isStrictlyInsideReal(parentIdentity, childIdentity) {
  const parentForm = parentIdentity.endsWith('/') ? parentIdentity : `${parentIdentity}/`;
  return childIdentity.length > parentForm.length && childIdentity.startsWith(parentForm);
}

/* ------------------------------------------------------------------ *
 * safety scan + selection (whole tree first, exclusions pruned after)
 * ------------------------------------------------------------------ */

/**
 * Physically safety-scan the entire source tree (including everything inside
 * an excluded top-level name) and return the selected file list sorted by raw
 * POSIX lexical path order.
 */
function scanAndSelect(rootPath) {
  const rootStatus = lstatProbe(rootPath);
  if (rootStatus === null) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.SOURCE_NOT_FOUND, `workspaceRoot ${JSON.stringify(rootPath)} does not exist.`);
  }
  if (rootStatus.isSymbolicLink()) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.LINK_DETECTED, `workspaceRoot must not be a link: ${JSON.stringify(rootPath)}.`);
  }
  if (!rootStatus.isDirectory()) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.SOURCE_NOT_A_DIRECTORY, `workspaceRoot must be a directory: ${JSON.stringify(rootPath)}.`);
  }

  const selected = [];
  const foldOwners = new Map();
  const foldRoot = foldCase(rootPath);
  const topNames = listDir(rootPath, '.');
  assertUniqueFoldNames(topNames.map((entry) => entry.name), rootPath);
  const excludedNames = new Set(SELECTION_POLICY_EXCLUSIONS);
  for (const dirent of topNames) {
    assertValidEntryName(dirent.name, rootPath);
    const absolute = path.join(rootPath, dirent.name);
    const excluded = excludedNames.has(dirent.name); // byte-exact policy match
    // Safety first, for excluded entries as well: a link or special file in
    // an excluded directory must not evade detection.
    const outcome = walkForSafety(absolute, rootPath, dirent.name, foldOwners, foldRoot, excluded ? EXCLUDED : null);
    if (outcome === EXCLUDED || outcome === EMPTY_SELECTED) continue;
    if (Array.isArray(outcome)) selected.push(...outcome);
    else selected.push(outcome);
  }
  selected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return selected;
}

/**
 * Recursively lstat every entry (files, directories and excluded subtrees
 * alike). Returns EXCLUDED for a wholly excluded subtree, EMPTY_SELECTED for
 * an included directory without selected content, one inventory entry for a
 * selected file, or an array of entries for a selected directory. Throws on any
 * physical-safety violation regardless of exclusion state.
 */
function walkForSafety(absolute, rootPath, rel, foldOwners, foldRoot, exclusionState) {
  const status = lstatProbe(absolute);
  if (status === null) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.SOURCE_MUTATED, `entry ${JSON.stringify(rel)} vanished during the safety scan (removal or racing rename).`);
  }
  if (status.isSymbolicLink()) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.LINK_DETECTED, `links are prohibited anywhere in the source tree, including inside excluded names: ${JSON.stringify(rel)}.`);
  }
  if (status.isDirectory()) {
    assertNoFoldCollision(foldOwners, foldRoot, rel, absolute);
    const children = listDir(absolute, rel);
    assertUniqueFoldNames(children.map((entry) => entry.name), absolute);
    const results = [];
    for (const child of children) {
      assertValidEntryName(child.name, absolute);
      const outcome = walkForSafety(path.join(absolute, child.name), rootPath, `${rel}/${child.name}`, foldOwners, foldRoot, exclusionState);
      if (outcome === EXCLUDED || outcome === EMPTY_SELECTED) continue;
      if (Array.isArray(outcome)) results.push(...outcome);
      else results.push(outcome);
    }
    if (exclusionState === EXCLUDED) return EXCLUDED;
    if (results.length === 0) return EMPTY_SELECTED;
    return results;
  }
  if (!status.isFile()) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.SPECIAL_FILE, `special (neither regular file nor directory) entries are prohibited anywhere in the source tree, including inside excluded names: ${JSON.stringify(rel)}.`);
  }
  assertNoFoldCollision(foldOwners, foldRoot, rel, absolute);
  if (exclusionState === EXCLUDED) return EXCLUDED;
  return { path: rel, bytes: status.size, sha256: sha256(fs.readFileSync(absolute)) };
}

function listDir(absolute, rel) {
  try {
    return fs.readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.SOURCE_MUTATED, `directory ${JSON.stringify(rel)} could not be listed during the safety scan: ${error.message}`);
  }
}

function lstatProbe(absolute) {
  try {
    return fs.lstatSync(absolute);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.SOURCE_NOT_FOUND, `entry ${JSON.stringify(absolute)} could not be inspected: ${error.message}`);
  }
}

function assertValidEntryName(name, directory) {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes(':') ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INVALID_NAME, `entry name ${JSON.stringify(name)} under ${JSON.stringify(directory)} is not a safe single path segment.`);
  }
}

/** Reject two sibling names that fold to the same spelling (portable guard). */
function assertUniqueFoldNames(names, directory) {
  const seen = new Map();
  for (const name of names) {
    const folded = foldCase(name);
    const prior = seen.get(folded);
    if (prior !== void 0 && prior !== name) {
      throw new SnapshotError(
        SNAPSHOT_ERROR_CODES.CASE_COLLISION,
        `case-insensitive name collision under ${JSON.stringify(directory)}: ${JSON.stringify(prior)} vs ${JSON.stringify(name)}.`,
      );
    }
    seen.set(folded, name);
  }
}

/** Reject two distinct full paths that fold to the same spelling. */
function assertNoFoldCollision(foldOwners, foldRoot, relativePath, absolute) {
  const key = foldRoot + foldCase(relativePath);
  const owner = foldOwners.get(key);
  if (owner !== void 0 && owner !== relativePath) {
    throw new SnapshotError(
      SNAPSHOT_ERROR_CODES.CASE_COLLISION,
      `case-insensitive path collision between ${JSON.stringify(owner)} and ${JSON.stringify(relativePath)} under ${JSON.stringify(path.dirname(absolute))}.`,
    );
  }
  foldOwners.set(key, relativePath);
}

function foldCase(value) {
  return value.normalize('NFD').toUpperCase().normalize('NFC');
}

/* ------------------------------------------------------------------ *
 * inventory
 * ------------------------------------------------------------------ */

function buildInventory(selected) {
  const list = selected.map((entry) => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }));
  list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return list;
}

function digestOf(inventory) {
  return hashEntries(inventory.map((entry) => ({ path: entry.path, sha256: entry.sha256 })));
}

/**
 * Recompute the full physical inventory of a root under the EXACT selection
 * policy and byte hashes. Independent of the copy ledger by construction: it
 * re-walks and re-hashes the tree (used for the copied-inventory and the
 * source-after gates).
 */
function computePhysicalInventory(rootPath) {
  return buildInventory(scanAndSelect(rootPath));
}

function inventoriesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index].path !== b[index].path || a[index].bytes !== b[index].bytes || a[index].sha256 !== b[index].sha256) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * destination claim
 * ------------------------------------------------------------------ */

/**
 * Claim `outputRoot` exclusively. Returns the claim object: the creation
 * identity of the claimed directory PLUS the creation identities of every host
 * ancestor below the claimed root up to (and including) the volume root,
 * captured atomically around the claim. The chain is what a later rollback or
 * gate re-proves: a renamed-aside root, a swapped ancestor or a foreign
 * recreation at the claim path is ownership loss regardless of content and
 * regardless of the inodes of the files still sitting below it (T6 repair —
 * the file-inode gates alone cannot see a root swap, and an EMPTY selection
 * has no file gate at all).
 */
function claimDestination(outputRoot) {
  try {
    fs.mkdirSync(outputRoot);
  } catch (error) {
    if (error.code === 'EEXIST') {
      // An existing target — empty or not — is never adopted or cleaned.
      // EEXIST is also what a concurrent claimer produces; both are refused,
      // and nothing below the target is inspected to decide anything.
      throw new SnapshotError(
        SNAPSHOT_ERROR_CODES.DESTINATION_EXISTS,
        `outputRoot ${JSON.stringify(outputRoot)} already exists or was claimed concurrently; the snapshot destination must be exclusively NEW and is never reused.`,
      );
    }
    if (error.code === 'ENOENT') {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.DESTINATION_EXISTS, `the outputRoot parent vanished while claiming ${JSON.stringify(outputRoot)}: ${error.message}`);
    }
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INTERNAL, `could not claim outputRoot ${JSON.stringify(outputRoot)}: ${error.message}`);
  }
  let status;
  try {
    status = fs.lstatSync(outputRoot);
  } catch (error) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INTERNAL, `outputRoot vanished immediately after the claim: ${error.message}`);
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.LINK_DETECTED, 'the claimed outputRoot is not a real directory.');
  }
  // Exclusivity proof by emptiness revalidation. (A link-count proof is not
  // available on this platform: libuv reports nlink 1 for every Windows
  // directory, so nlink is not used as a gate; hard links are disclosed as an
  // unqualified limitation.)
  let names;
  try {
    names = fs.readdirSync(outputRoot);
  } catch (error) {
    throw new SnapshotError(SNAPSHOT_ERROR_CODES.INTERNAL, `the claimed outputRoot could not be revalidated: ${error.message}`);
  }
  if (names.length !== 0) {
    throw new SnapshotError(
      SNAPSHOT_ERROR_CODES.DESTINATION_CONCURRENT_CLAIM,
      `the freshly claimed outputRoot already contains ${names.length} entr(y/ies); a concurrent writer is present and the destination is not exclusively ours.`,
    );
  }
  // Bind the host-ancestor chain AFTER the emptiness revalidation and BEFORE
  // any traversal, so a later swap of the root or of any ancestor below the
  // volume root is detectable at every subsequent gate.
  const ancestorIdentities = captureHostAncestors(outputRoot);
  return { rootCreatedIdentity: identityOf(status), hostAncestors: ancestorIdentities };
}

/**
 * Capture the creation identity of every existing ancestor directory of
 * `outputRoot`, bottom-up, stopping at (and including) the volume root. A link
 * anywhere on the chain is the documented `LINK_ANCESTOR` refusal; a vanished
 * component ends the chain (the claim simply reaches as far up as the host
 * exists — every captured entry is re-proven later).
 */
function captureHostAncestors(outputRoot) {
  const chain = [];
  let at = path.dirname(outputRoot);
  for (;;) {
    let status;
    try {
      status = fs.lstatSync(at);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') break;
      throw new SnapshotError(
        SNAPSHOT_ERROR_CODES.INTERNAL,
        `host ancestor ${JSON.stringify(at)} of the claimed outputRoot could not be inspected at the claim: ${error.message}`,
      );
    }
    if (status.isSymbolicLink()) {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.LINK_ANCESTOR, `the claimed destination has a link ancestor that appeared after the root check: ${JSON.stringify(at)}.`);
    }
    if (!status.isDirectory()) {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.INTERNAL, `host ancestor ${JSON.stringify(at)} of the claimed outputRoot is no longer a directory.`);
    }
    chain.push({ absolute: at, identity: identityOf(status) });
    const parent = path.dirname(at);
    if (parent === at) break;
    at = parent;
  }
  return chain;
}

/**
 * Re-prove the full claim chain. The host ancestors are proven TOP-DOWN —
 * volume root first, then each component down to the immediate parent — and the
 * walk STOPS at the first component that fails, so a deeper path is never
 * resolved THROUGH a parent that turned out to be replaced or newly linked
 * (resolving `A/b/c` follows a replacement `b`, which is exactly what must not
 * be read through to prove it). Only once the whole host chain is proven is
 * the claimed root itself lstat'ed and compared, and only then are any
 * descendants reached. Returns null when the whole chain is proven, otherwise
 * a machine-readable reason. This is the gate that closes the T6
 * root-replacement gaps: content and file inodes are irrelevant here, only the
 * identity of the very directories that were bound at the claim.
 */
function proveClaimChain(outputRoot, claim) {
  const hostBreak = proveHostAncestors(claim);
  if (hostBreak !== null) return hostBreak;
  return proveClaimedRoot(outputRoot, claim);
}

/**
 * Prove ONLY the host-ancestor chain (top-down, stopping at the first
 * failure). This is what cleanup and the fate enumeration need: while a host
 * ancestor is unproven, no path below it may be resolved at all. Returns null
 * when every host ancestor still carries its claimed identity.
 */
function proveHostAncestors(claim) {
  // The capture order is bottom-up, so the proof runs it in reverse (volume
  // root first). Any failure stops the proof immediately.
  for (let index = claim.hostAncestors.length - 1; index >= 0; index -= 1) {
    const entry = claim.hostAncestors[index];
    let current;
    try {
      current = fs.lstatSync(entry.absolute);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return `host-ancestor-missing:${entry.absolute}`;
      return `host-ancestor-inspection-failed:${entry.absolute}:${error.code ?? 'ERR'}`;
    }
    if (current.isSymbolicLink()) return `host-ancestor-is-a-link:${entry.absolute}`;
    if (!current.isDirectory()) return `host-ancestor-is-not-a-directory:${entry.absolute}`;
    if (identityOf(current) !== entry.identity) return `host-ancestor-identity-changed:${entry.absolute}`;
  }
  return null;
}

/**
 * Prove the claimed root itself — lstat'ed only once the host chain above it
 * is proven. Returns null when the root is still an ordinary directory
 * carrying the identity captured at the claim.
 */
function proveClaimedRoot(outputRoot, claim) {
  let status;
  try {
    status = fs.lstatSync(outputRoot);
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'snapshot-root-missing' : `snapshot-root-inspection-failed:${error.code ?? 'ERR'}`;
  }
  if (status.isSymbolicLink()) return 'snapshot-root-is-a-link';
  if (!status.isDirectory()) return 'snapshot-root-is-not-a-directory';
  if (identityOf(status) !== claim.rootCreatedIdentity) return 'snapshot-root-identity-is-not-the-claim-identity';
  return null;
}

/* ------------------------------------------------------------------ *
 * verification pass (runs after the copy and again after every hook)
 * ------------------------------------------------------------------ */

function verifyPass(outputRoot, claim, workspaceRoot, plannedSelected, preInventory, preDigest, ledger, gate) {
  // (a0) The claimed root and its full host-ancestor chain must still carry
  // the identities bound at the claim (T6). This closes the demonstrated gap
  // where a hook renames the claimed root aside, creates a NEW root at the
  // path and moves the original files into it: the file inodes are unchanged
  // and the file contents still hash correctly, yet the snapshot root is no
  // longer the directory this operation claimed — publication must not proceed
  // and, for an EMPTY selection (where no file gate exists at all), the root
  // replacement is caught here as well.
  const claimChain = proveClaimChain(outputRoot, claim);
  if (claimChain !== null) {
    throw new SnapshotError(
      SNAPSHOT_ERROR_CODES.OWNERSHIP_LOST,
      `the snapshot-root claim chain (claimed root plus host ancestors) is no longer proven at the ${gate} gate: ${claimChain}.`,
    );
  }

  // (a) snapshot files: read each one back from disk and re-hash it against
  // the selection; prove the ancestor chain is still our own creation.
  for (const fileEntry of ledger.fileLedger) {
    if (!ancestorsProvenOwned(fileEntry.relPath, outputRoot, ledger.ancestorIdentities)) {
      throw new SnapshotError(
        SNAPSHOT_ERROR_CODES.OWNERSHIP_LOST,
        `snapshot file ${JSON.stringify(fileEntry.relPath)} no longer sits under a provably-owned directory chain (${gate} gate).`,
      );
    }
    const current = lstatProbe(fileEntry.absolute);
    if (current === null) {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED, `snapshot file ${JSON.stringify(fileEntry.relPath)} was deleted after the copy (${gate} gate).`);
    }
    if (current.isSymbolicLink()) {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED, `snapshot file ${JSON.stringify(fileEntry.relPath)} was replaced by a link (${gate} gate).`);
    }
    if (!current.isFile()) {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED, `snapshot file ${JSON.stringify(fileEntry.relPath)} is no longer a regular file (${gate} gate).`);
    }
    if (identityOf(current) !== fileEntry.createdInode) {
      // The creation identity is gone. Even identical content means foreign
      // material: the publication never adopts bytes it did not create.
      throw new SnapshotError(
        SNAPSHOT_ERROR_CODES.OWNERSHIP_LOST,
        `snapshot file ${JSON.stringify(fileEntry.relPath)} was replaced after creation (creation identity lost, ownership of publication bytes gone) (${gate} gate).`,
      );
    }
    let readBack;
    try {
      readBack = sha256(fs.readFileSync(fileEntry.absolute));
    } catch (error) {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED, `snapshot file ${JSON.stringify(fileEntry.relPath)} could not be re-read at the ${gate} gate: ${error.message}`);
    }
    if (readBack !== fileEntry.expectedSha256) {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED, `snapshot file ${JSON.stringify(fileEntry.relPath)} changed after the copy pass (${gate} gate).`);
    }
  }

  // (b) snapshot directories: each ledger directory must still exist with its
  // creation identity as a real directory.
  for (const entry of ledger.directoryLedger) {
    const status = lstatProbe(entry.absolute);
    if (status === null) {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED, `snapshot directory ${JSON.stringify(entry.relPath)} was deleted after creation (${gate} gate).`);
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED, `snapshot directory ${JSON.stringify(entry.relPath)} is no longer an owned real directory (${gate} gate).`);
    }
    if (identityOf(status) !== entry.createdInode) {
      throw new SnapshotError(SNAPSHOT_ERROR_CODES.OWNERSHIP_LOST, `snapshot directory ${JSON.stringify(entry.relPath)} was replaced after creation (creation identity changed) (${gate} gate).`);
    }
  }

  // (c) copied-inventory equality against the pre-copy selected inventory,
  // recomputed by an independent physical walk + rehash of the snapshot.
  const snapshotInventory = computePhysicalInventory(outputRoot);
  const copyDigest = digestOf(snapshotInventory);
  if (!inventoriesEqual(snapshotInventory, preInventory) || copyDigest !== preDigest) {
    const detail = firstInventoryDifference(preInventory, snapshotInventory);
    throw new SnapshotError(
      SNAPSHOT_ERROR_CODES.SNAPSHOT_VERIFICATION_FAILED,
      `the copied inventory does not equal the pre-copy selected inventory at the ${gate} gate: ${detail}.`,
    );
  }

  // (d) source-after gate: re-list and re-hash the source under the same
  // policy. Any add/remove/change/link/special insertion aborts; the source is
  // NOT recopied — the publication fails instead.
  let sourceAfter;
  try {
    sourceAfter = computePhysicalInventory(workspaceRoot);
  } catch (error) {
    if (error instanceof SnapshotError) {
      throw new SnapshotError(error.code, `${error.message} (observed at the source-after ${gate} gate)`);
    }
    throw error;
  }
  if (!inventoriesEqual(sourceAfter, preInventory)) {
    const detail = firstInventoryDifference(preInventory, sourceAfter);
    throw new SnapshotError(
      SNAPSHOT_ERROR_CODES.SOURCE_MUTATED,
      `the source changed during the operation: ${detail} (source-after ${gate} gate). The source is never recopied after validation; the snapshot is aborted.`,
    );
  }

  // (e) plan-vs-actual count cross-check.
  if (plannedSelected.length !== snapshotInventory.length) {
    throw new SnapshotError(
      SNAPSHOT_ERROR_CODES.SNAPSHOT_VERIFICATION_FAILED,
      `planned ${plannedSelected.length} file(s), the snapshot holds ${snapshotInventory.length} at the ${gate} gate.`,
    );
  }

  // (f) T6 exact physical directory set: the snapshot must contain EXACTLY the
  // directories implied by the selected file paths. An extra directory — empty
  // or occupied — inserted during a hook is a post-creation mutation and
  // publication must not proceed, the same way an extra file never publishes.
  const snapshotEntries = [];
  const snapshotWalkFailures = [];
  collectAllEntries(outputRoot, outputRoot, snapshotEntries, snapshotWalkFailures);
  if (snapshotWalkFailures.length > 0) {
    throw new SnapshotError(
      SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED,
      `the snapshot walk reported unsafe entries at the ${gate} gate: ${snapshotWalkFailures.join('; ')}`,
    );
  }
  const actualDirectorySet = new Set(snapshotEntries.filter((entry) => entry.kind === 'directory').map((entry) => entry.path));
  const impliedDirectorySet = collectPlannedDirectories(plannedSelected);
  for (const directoryPath of [...actualDirectorySet].sort()) {
    if (!impliedDirectorySet.has(directoryPath)) {
      throw new SnapshotError(
        SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED,
        `snapshot directory ${JSON.stringify(directoryPath)} exists but is not implied by any selected file (directory insertion) (${gate} gate).`,
      );
    }
  }
  for (const directoryPath of [...impliedDirectorySet].sort()) {
    if (!actualDirectorySet.has(directoryPath)) {
      throw new SnapshotError(
        SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED,
        `implied snapshot directory ${JSON.stringify(directoryPath)} was deleted after creation (${gate} gate).`,
      );
    }
  }
}

function firstInventoryDifference(expected, actual) {
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  for (const [entryPath, entry] of expectedByPath) {
    const other = actualByPath.get(entryPath);
    if (other === void 0) return `${JSON.stringify(entryPath)} was removed`;
    if (other.sha256 !== entry.sha256) return `${JSON.stringify(entryPath)} was modified`;
    if (other.bytes !== entry.bytes) return `${JSON.stringify(entryPath)} size changed`;
  }
  for (const [entryPath] of actualByPath) {
    if (!expectedByPath.has(entryPath)) return `${JSON.stringify(entryPath)} was added`;
  }
  return 'an unexplained inventory difference';
}

function ancestorsOf(rootPath, relPath) {
  const segments = relPath.split('/');
  const out = [];
  let at = rootPath;
  for (let index = 0; index < segments.length - 1; index += 1) {
    at = path.join(at, segments[index]);
    out.push(at);
  }
  return out;
}

function ancestorsProvenOwned(relPath, outputRoot, ancestorIdentities) {
  for (const ancestor of ancestorsOf(outputRoot, relPath)) {
    const registered = ancestorIdentities.get(ancestor);
    if (registered === void 0) return false;
    const status = lstatProbe(ancestor);
    if (status === null || status.isSymbolicLink() || !status.isDirectory()) return false;
    if (identityOf(status) !== registered) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * ownership-aware nonrecursive cleanup
 * ------------------------------------------------------------------ */

/**
 * Ownership-aware, nonrecursive rollback.
 *
 * Nothing is read, unlinked or rmdir'ed unless the operation can still prove
 * the WHOLE chain down to that path: the claimed root must still carry its
 * claim identity, EVERY captured host ancestor must still carry the identity
 * bound at the claim (T6 — a renamed-aside root or a swapped ancestor means
 * the whole subtree is out of bounds, even when the files below it still
 * carry our inodes), and every ancestor directory must still carry the identity
 * recorded when it was created. A path whose chain cannot be proven is
 * preserved and reported, and the walk never descends through a replaced or
 * foreign directory (and never follows a link), so bytes the operation did not
 * create are never adopted, read or deleted.
 *
 * @param {{
 *   outputRoot: string,
 *   claim: { rootCreatedIdentity: string, hostAncestors: Array<{ absolute: string, identity: string }> },
 *   fileLedger: Array<object>,
 *   directoryLedger: Array<object>,
 *   fate: object,
 * }} context
 */
function runCleanup({ outputRoot, claim, fileLedger, directoryLedger, fate }) {
  const rootCreatedIdentity = claim.rootCreatedIdentity;
  // Identity table for the directories this operation created, keyed by
  // relative POSIX path; the snapshot root itself is keyed by '.'.
  const createdDirectories = new Map([['.', rootCreatedIdentity]]);
  for (const entry of directoryLedger) createdDirectories.set(entry.relPath, entry.createdInode);

  // T6: the host-ancestor chain is part of every cleanup proof. When it is
  // broken, NOTHING below the claim path is provably ours any longer: every
  // ledger entry is preserved, nothing is unlinked or rmdir'ed, and the break
  // is disclosed. The proof is host-ancestors-only here on purpose — with a
  // broken ancestor the claimed root is not even lstat'ed, because its path
  // would have to be resolved THROUGH the very component being detected.
  const hostChainBreak = proveHostAncestors(claim);
  const hostChainProvable = hostChainBreak === null;

  /**
   * Prove that `relPath` (a directory) and every ancestor up to and including
   * the snapshot root still carry the identity this operation recorded.
   * Returns the proven chain, or null with the first failing path recorded.
   */
  const proveChain = (relPath) => {
    const segments = relPath === '.' ? [] : relPath.split('/');
    let at = outputRoot;
    let status;
    try {
      status = fs.lstatSync(at);
    } catch {
      return null;
    }
    if (status.isSymbolicLink() || !status.isDirectory()) return null;
    if (identityOf(status) !== rootCreatedIdentity) return null;
    for (let index = 0; index < segments.length; index += 1) {
      at = path.join(at, segments[index]);
      const expected = createdDirectories.get(segments.slice(0, index + 1).join('/'));
      if (expected === void 0) return null;
      let childStatus;
      try {
        childStatus = fs.lstatSync(at);
      } catch {
        return null;
      }
      if (childStatus.isSymbolicLink() || !childStatus.isDirectory()) return null;
      if (identityOf(childStatus) !== expected) return null;
    }
    return segments;
  };

  // Files newest-first. Deletion requires: (1) the full chain down to the file
  // still carries the creation identities, (2) the file itself is still a
  // non-link regular file carrying its creation identity, and (3) its CURRENT
  // bytes still hash to the digest of the bytes this operation wrote. Any
  // failed condition means the bytes are no longer provably ours: the entry is
  // preserved and disclosed, never removed and never descended through.
  for (let index = fileLedger.length - 1; index >= 0; index -= 1) {
    const entry = fileLedger[index];
    const parentRel = entry.relPath.includes('/') ? entry.relPath.slice(0, entry.relPath.lastIndexOf('/')) : '.';
    if (!hostChainProvable) {
      // T6: the claimed root or a host ancestor was swapped; the file may
      // still carry our inode, but it is reached through a path that is no
      // longer provably the one we claimed — preserve, never touch.
      fate.foreignPreserved.push({ path: entry.relPath, reason: `host-chain-not-provable:${hostChainBreak}` });
      continue;
    }
    if (proveChain(parentRel) === null) {
      fate.foreignPreserved.push({ path: entry.relPath, reason: 'ownership-chain-not-provable' });
      continue;
    }
    const status = lstatProbe(entry.absolute);
    if (status === null) {
      fate.residualPaths.push({ path: entry.relPath, reason: 'already-absent' });
      continue;
    }
    if (status.isSymbolicLink() || !status.isFile()) {
      fate.foreignPreserved.push({ path: entry.relPath, reason: 'replaced-by-foreign-entry' });
      continue;
    }
    if (identityOf(status) !== entry.createdInode) {
      let reason = 'replaced-by-foreign-file';
      try {
        if (sha256(fs.readFileSync(entry.absolute)) === entry.expectedSha256) reason = 'replaced-by-identical-content-foreign-file';
      } catch { /* keep the generic reason */ }
      fate.foreignPreserved.push({ path: entry.relPath, reason });
      continue;
    }
    // Current-bytes gate: a same-inode edit means the bytes are not the ones
    // this operation created, so they are no longer ours to remove.
    let currentDigest;
    try {
      currentDigest = sha256(fs.readFileSync(entry.absolute));
    } catch (error) {
      fate.foreignPreserved.push({ path: entry.relPath, reason: `current-bytes-unreadable:${error.code ?? 'ERR'}` });
      continue;
    }
    if (currentDigest !== entry.expectedSha256) {
      fate.foreignPreserved.push({ path: entry.relPath, reason: 'modified-after-creation-bytes-not-created-by-this-operation' });
      continue;
    }
    try {
      fs.unlinkSync(entry.absolute);
      fate.removedFiles.push(entry.relPath);
    } catch (error) {
      fate.cleanupErrors.push({ path: entry.relPath, message: `${error.code ?? 'ERR'}: ${error.message}` });
    }
  }

  // Directories deepest-first (the ledger is parent-first). Removal requires
  // the full proven chain plus emptiness; an unprovable or occupied directory
  // is preserved and reported.
  for (let index = directoryLedger.length - 1; index >= 0; index -= 1) {
    const entry = directoryLedger[index];
    if (!hostChainProvable) {
      fate.foreignPreserved.push({ path: entry.relPath, reason: `host-chain-not-provable:${hostChainBreak}` });
      continue;
    }
    if (proveChain(entry.relPath) === null) {
      fate.foreignPreserved.push({ path: entry.relPath, reason: 'ownership-chain-not-provable' });
      continue;
    }
    const status = lstatProbe(entry.absolute);
    if (status === null) {
      fate.residualPaths.push({ path: entry.relPath, reason: 'already-absent' });
      continue;
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      fate.foreignPreserved.push({ path: entry.relPath, reason: 'replaced-by-foreign-entry' });
      continue;
    }
    if (identityOf(status) !== entry.createdInode) {
      fate.foreignPreserved.push({ path: entry.relPath, reason: 'directory-identity-changed' });
      continue;
    }
    let names;
    try {
      names = fs.readdirSync(entry.absolute);
    } catch (error) {
      fate.cleanupErrors.push({ path: entry.relPath, message: `${error.code ?? 'ERR'}: ${error.message}` });
      continue;
    }
    if (names.length !== 0) {
      fate.foreignPreserved.push({ path: entry.relPath, reason: `contains-${names.length}-entr(y/ies)` });
      continue;
    }
    try {
      fs.rmdirSync(entry.absolute);
      fate.removedDirectories.push(entry.relPath);
    } catch (error) {
      // ENOTEMPTY / EEXIST / EACCES / EPERM mean "still occupied or not ours
      // to remove": report, never escalate to a recursive removal.
      fate.cleanupErrors.push({ path: entry.relPath, message: `${error.code ?? 'ERR'}: ${error.message}` });
    }
  }

  // The claimed root itself: removed only when the full host-ancestor chain
  // is still proven (T6) — an unproven parent is never read through to prove
  // it, so with a broken chain the root is not probed at all — and the root is
  // still the very directory this operation claimed (identical creation
  // identity) and is empty. A foreign replacement — even an empty directory
  // with identical content — is retained and reported.
  if (!hostChainProvable) {
    fate.foreignPreserved.push({ path: '.', reason: `host-chain-not-provable:${hostChainBreak}` });
  } else {
    const topStatus = lstatProbe(outputRoot);
    if (topStatus === null) {
      fate.residualPaths.push({ path: '.', reason: 'already-absent' });
    } else if (topStatus.isSymbolicLink() || !topStatus.isDirectory()) {
      fate.foreignPreserved.push({ path: '.', reason: 'replaced-by-foreign-entry' });
    } else if (identityOf(topStatus) !== rootCreatedIdentity) {
      fate.foreignPreserved.push({ path: '.', reason: 'snapshot-root-replacement-retained-identity-not-claim-identity' });
    } else {
      let names = null;
      try {
        names = fs.readdirSync(outputRoot);
      } catch (error) {
        fate.cleanupErrors.push({ path: '.', message: `${error.code ?? 'ERR'}: ${error.message}` });
      }
      if (names !== null) {
        if (names.length === 0) {
          try {
            fs.rmdirSync(outputRoot);
            fate.removedDirectories.push('.');
          } catch (error) {
            fate.cleanupErrors.push({ path: '.', message: `${error.code ?? 'ERR'}: ${error.message}` });
          }
        } else {
          fate.residualPaths.push({ path: '.', reason: `snapshot-root-retained-with-${names.length}-residual-entr(y/ies)` });
        }
      }
    }
  }

  // Honest residual enumeration for the fate report. It is read-only reporting
  // only: it names what remains, it never adopts or deletes anything, it is
  // bounded, and it descends only into directories whose ownership chain is
  // still provable — never through a junction, a replaced directory or a
  // foreign-created directory. When the claim chain (root plus host ancestors,
  // proven top-down) is broken, the enumeration does not run at all: it must
  // not read through a replaced or newly-linked parent just to describe it.
  if (hostChainProvable) {
    for (const residual of enumerateResidual(outputRoot, rootCreatedIdentity, createdDirectories)) {
      fate.foreignPreserved.push(residual);
    }
  }
  fate.phase = 'aborted-cleaned';
}

/**
 * Bounded, read-only listing of what still exists below the claimed root, for
 * fate reporting only.
 *
 * Safety and bounds: every probe is an lstat; at most 64 entries are reported
 * (a cap entry says the listing was truncated) and the descent stops at depth
 * 8; a link is named but never followed; a special file is named but never
 * touched; a directory is descended into only when its own ownership chain
 * (root plus every created ancestor) still carries the recorded creation
 * identity — a foreign, replaced or unprovable directory is named, not
 * entered. The result never grants cleanup ownership to any listed entry.
 */
function enumerateResidual(outputRoot, rootCreatedIdentity, createdDirectories) {
  const MAX_ENTRIES = 64;
  const MAX_DEPTH = 8;
  const out = [];
  let truncated = false;
  const isProvenOwned = (relSegments) => {
    let at = outputRoot;
    let status;
    try {
      status = fs.lstatSync(at);
    } catch {
      return false;
    }
    if (status.isSymbolicLink() || !status.isDirectory()) return false;
    if (identityOf(status) !== rootCreatedIdentity) return false;
    const prefix = [];
    for (const segment of relSegments) {
      at = path.join(at, segment);
      prefix.push(segment);
      const expected = createdDirectories.get(prefix.join('/'));
      if (expected === void 0) return false;
      let childStatus;
      try {
        childStatus = fs.lstatSync(at);
      } catch {
        return false;
      }
      if (childStatus.isSymbolicLink() || !childStatus.isDirectory()) return false;
      if (identityOf(childStatus) !== expected) return false;
    }
    return true;
  };
  const visit = (absolute, relPrefix, depth) => {
    if (truncated) return;
    let names;
    try {
      names = fs.readdirSync(absolute);
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= MAX_ENTRIES) {
        truncated = true;
        out.push({ path: relPrefix === '' ? '.' : relPrefix, reason: 'entry-cap-reached-listing-truncated' });
        return;
      }
      const absoluteChild = path.join(absolute, name);
      const rel = relPrefix === '' ? name : `${relPrefix}/${name}`;
      let status;
      try {
        status = fs.lstatSync(absoluteChild);
      } catch {
        continue;
      }
      if (status.isSymbolicLink()) {
        out.push({ path: rel, reason: 'residual-link-listed-not-followed' });
        continue;
      }
      if (status.isDirectory()) {
        const segments = rel.split('/');
        const owned = isProvenOwned(segments);
        out.push({ path: rel, reason: owned ? 'residual-owned-directory-still-occupied' : 'residual-directory-not-provably-owned-listed-only' });
        if (owned && depth < MAX_DEPTH) visit(absoluteChild, rel, depth + 1);
        continue;
      }
      if (!status.isFile()) {
        out.push({ path: rel, reason: 'residual-special-file-not-touched' });
        continue;
      }
      out.push({ path: rel, reason: 'residual-file-not-created-by-this-operation' });
    }
  };
  let topStatus;
  try {
    topStatus = fs.lstatSync(outputRoot);
  } catch {
    return out;
  }
  if (topStatus.isSymbolicLink() || !topStatus.isDirectory()) return out;
  if (identityOf(topStatus) !== rootCreatedIdentity) return out;
  visit(outputRoot, '', 1);
  return out;
}

/* ------------------------------------------------------------------ *
 * misc helpers
 * ------------------------------------------------------------------ */

/** All ancestor directories of every planned file, parent-first, deduplicated. */
function planDirectories(selected) {
  const wanted = new Set();
  for (const entry of selected) {
    const segments = entry.path.split('/');
    const prefix = [];
    for (let index = 0; index < segments.length - 1; index += 1) {
      prefix.push(segments[index]);
      wanted.add(prefix.join('/'));
    }
  }
  // Lexical parent-first order: every parent string precedes its children.
  return [...wanted].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Identity of an lstat result. With a usable inode number this is the
 * creation identity used for the ownership proof; where the platform reports
 * no inode (or always 0) identity degrades to size+mtime+mode resolution,
 * which detects replacement reliably for any material change but can miss a
 * same-size, same-mtime swap. Disclosed limitation, no hidden strength claim.
 */
function identityOf(status) {
  if (typeof status.ino === 'number' && status.ino !== 0 && typeof status.dev === 'number') {
    return `ino:${status.dev}:${status.ino}`;
  }
  return `stat:${status.size}:${Math.round(status.mtimeMs * 1000)}:${Number(status.mode)}`;
}

function relativeOf(root, absolute) {
  return path.relative(root, absolute).replaceAll('\\', '/');
}

function collectAllFiles(directory, rootPath, sink, failures) {
  const entries = [];
  const walkFailures = [];
  collectAllEntries(directory, rootPath, entries, walkFailures);
  for (const entry of entries) {
    if (entry.kind === 'file') sink.push({ path: entry.path, bytes: entry.bytes, sha256: null });
  }
  for (const failure of walkFailures) failures.push(failure);
}

/**
 * Recursively collect EVERY physical entry below `directory` as
 * `{ path, kind: 'file' | 'directory', bytes }` (T6: directories are collected
 * as well, so the exact physical directory set can be verified; links and
 * special files are reported through `failures` and are not added to `sink`).
 */
function collectAllEntries(directory, rootPath, sink, failures) {
  for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
    assertValidEntryName(dirent.name, directory);
    const absolute = path.join(directory, dirent.name);
    const posixRel = relPathFromRoot(rootPath, absolute);
    const status = fs.lstatSync(absolute);
    if (status.isSymbolicLink()) {
      failures.push(`snapshot entry ${JSON.stringify(posixRel)} is a link`);
      continue;
    }
    if (status.isDirectory()) {
      sink.push({ path: posixRel, kind: 'directory', bytes: status.size });
      collectAllEntries(absolute, rootPath, sink, failures);
      continue;
    }
    if (!status.isFile()) {
      failures.push(`snapshot entry ${JSON.stringify(posixRel)} is a special file`);
      continue;
    }
    sink.push({ path: posixRel, kind: 'file', bytes: status.size });
  }
}

/**
 * The exact directory set a snapshot of `selected` implies: every ancestor
 * prefix of every selected file path, relative to the snapshot root.
 */
function collectPlannedDirectories(selected) {
  const wanted = new Set();
  for (const entry of selected) {
    const segments = entry.path.split('/');
    const prefix = [];
    for (let index = 0; index < segments.length - 1; index += 1) {
      prefix.push(segments[index]);
      wanted.add(prefix.join('/'));
    }
  }
  return wanted;
}

function relPathFromRoot(rootPath, absolute) {
  return path.relative(rootPath, absolute).split(path.sep).join('/');
}

function isExactRelativePosixPath(value) {
  if (value.includes('\\') || value.includes(':')) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith('/') || value === '.' || value === '..') return false;
  if (value.startsWith('./') || value.endsWith('/.') || value.includes('/./')) return false;
  if (value.startsWith('../') || value.includes('/../') || value.endsWith('/..')) return false;
  if (value.startsWith('//') || value.endsWith('/') || value.includes('//')) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function toDisplay(rootPath) {
  return path.sep === '/' ? rootPath : rootPath.replaceAll('\\', '/');
}

export { SnapshotError };
