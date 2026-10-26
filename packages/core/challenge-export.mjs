/**
 * Exact challenge exporter and path-safe copy transaction (C2 / T1).
 *
 * `exportChallenge` turns a validated challenge package into a complete,
 * byte-exact public workspace. It is the only path from a private challenge
 * source tree to a participant-visible workspace, so there is one production
 * code path and no bypass switch: every rejection is a thrown error and no
 * check can be asked to relax.
 *
 * Trust boundary implemented here:
 *  - no global root, configuration, harness or environment lookup: only Node
 *    built-ins plus the accepted neutral `identity`, `paths` and `manifest`
 *    modules are imported, and the working directory is never consulted;
 *  - every root is an explicit absolute host path supplied by the caller; there
 *    is no default, discovered or inferred root anywhere in this module;
 *  - bytes are copied verbatim and the accepted sorted POSIX legacy digest is
 *    recomputed from those raw bytes, with no separator, encoding, newline or
 *    case normalisation;
 *  - metadata is trusted only after the accepted contract validator accepts it
 *    and the exact source inventory proves it against both the identity and
 *    the caller's manifest;
 *  - the protected boundary is the source root, the published workspace, the
 *    owner roots and the evaluator roots: the destination is compared with each
 *    protected root on its own and is refused when it equals, contains or sits
 *    inside one, as is any link in an ancestor chain; the protected roots are
 *    never compared among themselves, because one host directory legitimately
 *    holds the source, the hidden evaluator and the owner's own material, and
 *    protected roots that nest, overlap or repeat protect more, not less;
 *  - the published workspace contains exactly the manifest's workload files, so
 *    no version-control, harness, owner, state or previous-solution material can
 *    travel with it. Extra material in the source is a reason to refuse the
 *    export, never a reason to relax the exact-inventory requirement;
 *  - the whole physical source is walked for links and special files with no
 *    name ever skipped, while the workload inventory is the exact manifest set:
 *    material that merely shares a name with harness convention is still
 *    checked, and extra material in either walk is a refusal. The source is
 *    verified again after the copy, so a mutation during the transaction is
 *    detected instead of published.
 *
 * Transaction order:
 *  1. the source bytes and inventory are verified before anything is copied;
 *  2. bytes are staged in a privately created, operation-owned directory beside
 *     the destination, and the staged bytes are read back and verified;
 *  3. the source is verified again, and only then is the container published;
 *  4. publication reserves the destination atomically: an existing destination
 *     is refused and never overwritten or renamed over, empty or not;
 *  5. every write takes its bytes from a read whose digest is proved against the
 *     identity at that moment, so no byte is published that was not verified for
 *     the write it belongs to, and a source that moves mid-transaction is
 *     reported as `WORKLOAD_CHANGED` rather than published and noticed later;
 *  6. only material this call provably created is ever removed, entry by entry
 *     and never recursively, so a concurrent destination or a foreign canary is
 *     left exactly as it was found;
 *  7. success is returned only after verification, publication and re-verification
 *     of the published tree, and an error or interruption is preserved as thrown
 *     rather than converted into success.
 *
 * No lock is taken and no link is followed. There is therefore no cross-process
 * mutual exclusion: directory creation is the only exclusive primitive used,
 * because a directory becomes visible as a complete container without any
 * lock-based handshake, and that visibility is cooperative rather than atomic —
 * another process can list or enter it between the reservation and the last
 * write. An interrupted run can leave a private staging directory behind, a
 * concurrent writer that wins the reservation is refused rather than displaced,
 * and a concurrent writer that entered a reserved container makes its material
 * residue that is reported as `CLEANUP_FAILED` rather than deleted.
 *
 * @module
 */

import path from 'node:path';
import fs from 'node:fs';

import { DEFAULT_SKIP_NAMES, createId, hashEntries, sha256 } from './identity.mjs';
import { PathError, PATH_ERROR_CODES, assertDisjointRoots, resolveWithinRoot, validateRelativePath } from './paths.mjs';
import { validateRecord } from './manifest.mjs';

/** Machine-readable failure reasons; stable, additive and test-assertable. */
export const EXPORT_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_ROOT: 'INVALID_ROOT',
  ROOTS_OVERLAP: 'ROOTS_OVERLAP',
  DUPLICATE_ROOT: 'DUPLICATE_ROOT',
  SOURCE_NOT_FOUND: 'SOURCE_NOT_FOUND',
  SOURCE_UNSAFE: 'SOURCE_UNSAFE',
  WORKLOAD_MISMATCH: 'WORKLOAD_MISMATCH',
  WORKLOAD_CHANGED: 'WORKLOAD_CHANGED',
  DESTINATION_EXISTS: 'DESTINATION_EXISTS',
  DESTINATION_PARENT_MISSING: 'DESTINATION_PARENT_MISSING',
  DESTINATION_UNSAFE: 'DESTINATION_UNSAFE',
  STAGING_FAILED: 'STAGING_FAILED',
  PUBLICATION_FAILED: 'PUBLICATION_FAILED',
  CLEANUP_FAILED: 'CLEANUP_FAILED',
  INTERNAL: 'INTERNAL',
});

/**
 * The exact workload file count a public workspace must contain. A challenge
 * whose manifest lists a different count is a different contract and is refused
 * rather than silently accepted, so an incomplete source cannot look like
 * success.
 */
export const EXPECTED_WORKLOAD_FILE_COUNT = 26;

/** Prefix of the privately created, operation-owned staging directory. */
export const STAGING_PREFIX = '.benchboard-export-';

/** Mode requested for every published file: owner-writable, others read-only. */
export const EXPORTED_FILE_MODE = 0o644;

/** Errno codes that mean "this path simply is not there". */
const MISSING_CODES = Object.freeze(['ENOENT', 'ENOTDIR']);

/** Lowercase SHA-256 spelling, the only digest form the workload accepts. */
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The accepted comparator's root-gate verdicts translated into this module's
 * codes. The three codes are deliberately the same spellings, so a caller sees
 * one vocabulary; the mapping is explicit rather than a pass-through so an
 * unexpected comparator code cannot leak a code this module never declares.
 */
const ACCEPTED_ROOT_GATE_CODES = Object.freeze({
  [PATH_ERROR_CODES.INVALID_ROOT]: EXPORT_ERROR_CODES.INVALID_ROOT,
  [PATH_ERROR_CODES.DUPLICATE_ROOT]: EXPORT_ERROR_CODES.DUPLICATE_ROOT,
  [PATH_ERROR_CODES.ROOTS_OVERLAP]: EXPORT_ERROR_CODES.ROOTS_OVERLAP,
});

/** Raw code-unit ordering, the order the accepted workload digest depends on. */
const RAW_COMPARE = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** Names that are never part of the workload inventory, from the accepted module. */
const SKIPPED_NAMES = DEFAULT_SKIP_NAMES;

/**
 * Decide whether the last segment of a relative POSIX path is one of the
 * accepted convention names. The decision is always made by kind first at the
 * call site: only a *directory* bearing such a name is ever treated as
 * dependency, build or version-control material, so a link or a file with the
 * same name is reported under its real kind.
 *
 * @param {string} relativePath relative POSIX path of a physical entry
 * @returns {boolean}
 */
function isSkippedName(relativePath) {
  const separator = relativePath.lastIndexOf('/');
  return SKIPPED_NAMES.includes(separator < 0 ? relativePath : relativePath.slice(separator + 1));
}

/**
 * Error type carrying a stable machine code, the offending path and the cause.
 *
 * @augments {Error}
 */
export class ChallengeExportError extends Error {
  /**
   * @param {string} code one of EXPORT_ERROR_CODES
   * @param {string} message human-readable detail, never used for control flow
   * @param {{ cause?: unknown, path?: string }} [details]
   */
  constructor(code, message, details = void 0) {
    super(`${code}: ${message}`);
    this.name = 'ChallengeExportError';
    this.code = code;
    if (details?.path !== void 0) this.path = details.path;
    if (details?.cause !== void 0) this.cause = details.cause;
  }
}

/**
 * True when a filesystem error reports an absent path.
 *
 * `ENOTDIR` counts as absent because a non-directory parent makes every child
 * lookup under it unresolvable, which the callers treat as "not there".
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissing(error) {
  return typeof error?.code === 'string' && MISSING_CODES.includes(error.code);
}

/**
 * Normalise one explicit absolute root to its host-resolved form.
 *
 * Roots are always explicit. A relative spelling, an empty string, a control
 * character, a bare drive letter, a device namespace or a UNC path is refused
 * rather than resolved against the process working directory, which is what
 * keeps root discovery out of this module entirely.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string} absolute resolved root
 */
function absoluteRoot(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
      `${label}: an explicit absolute path string is required, got ${JSON.stringify(value)}.`);
  }
  if (/^[A-Za-z]:$/.test(value) || value.startsWith('\\\\') || value.startsWith('//')) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
      `${label}: a bare drive letter, UNC or device-namespace root is not supported: ${JSON.stringify(value)}.`);
  }
  const looksAbsolute = value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value);
  if (!looksAbsolute) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
      `${label}: roots are always explicit and absolute, got the relative path ${JSON.stringify(value)}.`);
  }
  return path.resolve(value);
}

/**
 * Normalise a required list of protected roots, preserving order.
 *
 * The protected-root lists are part of the contract and must be stated, so an
 * omitted or null list is refused rather than silently read as "nothing to
 * protect": a caller that has no owner or evaluator material states that by
 * passing an empty list, which is accepted. Entries are absolute-root checked
 * individually, so a defective entry is named by position.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {ReadonlyArray<string>} possibly empty, never absent
 */
function requiredRootList(value, label) {
  if (value === void 0 || value === null) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
      `${label}: an explicit list of absolute root paths is required, an empty list is how "none" is stated, got ${JSON.stringify(value)}.`);
  }
  if (!Array.isArray(value)) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
      `${label}: a list of absolute root paths is required, got ${JSON.stringify(value)}.`);
  }
  return Object.freeze(value.map((entry, index) => absoluteRoot(entry, `${label}[${index}]`)));
}

/**
 * Validate the exact relative POSIX manifest and return it as a frozen list.
 *
 * Spelling is preserved verbatim and only the shape is checked here: a listed
 * path is proved to exist against the filesystem later. A repeated path is
 * refused now, because two entries for one destination cannot both be published.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {ReadonlyArray<string>}
 */
function fileManifestList(value, label) {
  if (!Array.isArray(value)) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
      `${label}: a list of exact relative POSIX paths is required, got ${JSON.stringify(value)}.`);
  }
  const seen = new Set();
  const checked = value.map((entry, index) => {
    const at = `${label}[${index}]`;
    if (typeof entry !== 'string') {
      throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
        `${at}: an exact relative POSIX path string is required, got ${JSON.stringify(entry)}.`);
    }
    try {
      validateRelativePath(entry);
    } catch (error) {
      throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
        `${at}: ${error.message}`, { path: entry, cause: error });
    }
    if (seen.has(entry)) {
      throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
        `${at}: the path ${JSON.stringify(entry)} is listed more than once.`, { path: entry });
    }
    seen.add(entry);
    return entry;
  });
  return Object.freeze(checked);
}

/**
 * Compare the destination with one protected root through the accepted
 * disjointness comparator, and report its verdict in this module's codes.
 *
 * Exactly two roots are handed to `assertDisjointRoots`, never the protected
 * set as a whole: the accepted comparator is pairwise and rejects any equality
 * or containment inside the set it is given, which is right for
 * "destination against this one protected root" and wrong for
 * "protected roots among themselves", because a host directory legitimately
 * holds the source, the hidden evaluator and the owner's own material at once.
 * No containment rule is re-implemented here, so the case-folded identity
 * namespace, the "no stat'ing" property and the duplicate-before-overlap
 * ordering stay exactly where they are decided.
 *
 * @param {{ destination: string, protectedRoot: { label: string, path: string } }} request
 * @returns {void}
 */
function assertDestinationApartFrom({ destination, protectedRoot }) {
  try {
    assertDisjointRoots([
      { label: 'output', path: destination },
      { label: protectedRoot.label, path: protectedRoot.path },
    ]);
  } catch (error) {
    if (!(error instanceof PathError)) throw error;
    const code = Object.prototype.hasOwnProperty.call(ACCEPTED_ROOT_GATE_CODES, error.code)
      ? ACCEPTED_ROOT_GATE_CODES[error.code]
      : EXPORT_ERROR_CODES.INVALID_ROOT;
    const acceptedPrefix = `${error.code}: `;
    const detail = error.message.startsWith(acceptedPrefix) ? error.message.slice(acceptedPrefix.length) : error.message;
    throw new ChallengeExportError(code,
      `the destination ${JSON.stringify(destination)} must be disjoint from ${protectedRoot.label} ${JSON.stringify(protectedRoot.path)}: ${detail}`,
      { cause: error });
  }
}

/**
 * Fold the caller's package into one validated operation record.
 *
 * Nothing here touches the filesystem: the identity is folded through the
 * accepted neutral contract validator, every root must be explicit and absolute,
 * the manifest must name exactly the expected workload count, and the
 * destination is compared with every protected root in turn, so it can never
 * equal, contain or sit inside one. The protected roots are never compared with
 * each other: nesting, overlap and repetition among them widen the protected
 * set, which is a reason to accept the package, not to refuse it.
 *
 * @param {{ challenge: object, output: string }} options
 * @returns {object} mutable internal operation record
 */
function beginOperation(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
      'exportChallenge({ challenge, output }): an options object is required.');
  }
  const unknownKeys = Object.keys(options).filter((key) => key !== 'challenge' && key !== 'output');
  if (unknownKeys.length > 0) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
      `exportChallenge({ challenge, output }): unknown option(s): ${unknownKeys.join(', ')}.`);
  }
  const { challenge, output } = options;
  if (challenge === null || typeof challenge !== 'object' || Array.isArray(challenge)) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
      'exportChallenge({ challenge, output }): a challenge package object is required.');
  }
  const allowedPackage = ['identity', 'sourceRoot', 'fileManifest', 'ownerRoots', 'evaluatorRoots'];
  const extraPackage = Object.keys(challenge).filter((key) => !allowedPackage.includes(key));
  if (extraPackage.length > 0) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
      `challenge package: unknown member(s): ${extraPackage.join(', ')}.`);
  }
  for (const required of ['identity', 'sourceRoot', 'fileManifest', 'ownerRoots', 'evaluatorRoots']) {
    if (challenge[required] === void 0) {
      throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
        `challenge package: ${required} is required.`);
    }
  }

  let identity;
  try {
    identity = validateRecord('ChallengeIdentity', challenge.identity);
  } catch (error) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
      `challenge identity: ${error.message}`, { cause: error });
  }

  const sourceRoot = absoluteRoot(challenge.sourceRoot, 'challenge.sourceRoot');
  const manifest = fileManifestList(challenge.fileManifest, 'challenge.fileManifest');
  const ownerRoots = requiredRootList(challenge.ownerRoots, 'challenge.ownerRoots');
  const evaluatorRoots = requiredRootList(challenge.evaluatorRoots, 'challenge.evaluatorRoots');
  const destination = absoluteRoot(output, 'output');

  if (!HEX64.test(String(identity.workloadDigest))) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.INVALID_ARGUMENT,
      'challenge identity: workloadDigest must be 64 lowercase hexadecimal characters.');
  }
  if (manifest.length !== EXPECTED_WORKLOAD_FILE_COUNT) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.WORKLOAD_MISMATCH,
      `challenge fileManifest must list exactly ${EXPECTED_WORKLOAD_FILE_COUNT} workload files, got ${manifest.length}.`);
  }
  const identityPaths = new Set(identity.starterInventory.map(([relativePath]) => relativePath));
  if (identityPaths.size !== manifest.length || manifest.some((entry) => !identityPaths.has(entry))) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.WORKLOAD_MISMATCH,
      'challenge fileManifest must name exactly the files listed by the identity workload inventory.');
  }

  // The protected set is the source root plus every stated owner and evaluator
  // root. Each of them is compared against the destination on its own: a
  // destination may not equal, contain or sit inside any protected root. They
  // are deliberately never compared among themselves, because a real challenge
  // layout legitimately nests protected material — a source or an evaluator that
  // lives under the owner root, or the same owner root listed by both lists —
  // and that is a reason to protect more, not a reason to refuse a destination
  // that is disjoint from all of them.
  const protectedRoots = [
    { label: 'challenge.sourceRoot', path: sourceRoot },
    ...ownerRoots.map((entry, index) => ({ label: `challenge.ownerRoots[${index}]`, path: entry })),
    ...evaluatorRoots.map((entry, index) => ({ label: `challenge.evaluatorRoots[${index}]`, path: entry })),
  ];
  for (const protectedRoot of protectedRoots) {
    assertDestinationApartFrom({ destination, protectedRoot });
  }

  return {
    identity,
    sourceRoot,
    manifest,
    ownerRoots,
    evaluatorRoots,
    output: destination,
    stagingParent: path.dirname(destination),
    expectedDigest: identity.workloadDigest,
    identityDigests: new Map(identity.starterInventory),
    observed: null,
    stagingRoot: null,
    stagingOwned: false,
    destinationReserved: false,
    // Every entry this call created, recorded at the moment of creation with the
    // identity needed to recognise it again. This list, not the shape of the tree,
    // is what the cleanup is allowed to act on.
    created: [],
  };
}

/**
 * Prove a root exists, is a directory, and is neither a link nor under one.
 *
 * A link above a root silently re-roots every contained check, so the whole
 * ancestor chain is proved link-free before any path below the root is opened.
 * Anything the filesystem refuses to report fails closed as unsafe rather than
 * being assumed safe.
 *
 * @param {string} root
 * @param {string} label
 * @param {{ missing: string, unsafe: string }} codes
 * @returns {Promise<void>}
 */
async function assertLinkFreeRoot(root, label, codes) {
  let cursor = root;
  for (;;) {
    let status;
    try {
      status = await fs.promises.lstat(cursor);
    } catch (error) {
      if (isMissing(error)) {
        throw new ChallengeExportError(codes.missing,
          `${label} does not exist at ${JSON.stringify(cursor)}.`, { path: cursor, cause: error });
      }
      throw new ChallengeExportError(codes.unsafe,
        `${label} cannot be inspected at ${JSON.stringify(cursor)}: ${error.message}`, { path: cursor, cause: error });
    }
    if (status.isSymbolicLink()) {
      throw new ChallengeExportError(codes.unsafe,
        `${label} must not be, or sit beneath, a symbolic link: ${JSON.stringify(cursor)}.`, { path: cursor });
    }
    if (!status.isDirectory()) {
      throw new ChallengeExportError(codes.missing,
        `${label} is not a directory at ${JSON.stringify(cursor)}.`, { path: cursor });
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

/**
 * Read one file through the accepted in-root resolver.
 *
 * The resolver proves the relative path stays inside the root and rejects a
 * link, a special file, a non-directory intermediate segment and a case-folded
 * spelling at every step, so a returned handle cannot be steered outside.
 *
 * @param {{ root: string, relativePath: string, code: string }} request
 * @returns {Promise<Uint8Array>} the raw bytes, unmodified
 */
async function readContainedFile(request) {
  const { root, relativePath, code } = request;
  let absolute;
  try {
    absolute = resolveWithinRoot({ root, relativePath });
  } catch (error) {
    throw new ChallengeExportError(code,
      `${JSON.stringify(relativePath)} is not a safe in-root file: ${error.message}`,
      { path: relativePath, cause: error });
  }
  let handle;
  try {
    handle = await fs.promises.open(absolute, 'r');
    const status = await handle.stat();
    if (!status.isFile()) {
      throw new ChallengeExportError(code,
        `${JSON.stringify(relativePath)} is not a regular file: ${absolute}.`, { path: relativePath });
    }
    return new Uint8Array(await handle.readFile());
  } catch (error) {
    if (error instanceof ChallengeExportError) throw error;
    if (isMissing(error)) {
      throw new ChallengeExportError(code,
        `${JSON.stringify(relativePath)} is listed by the manifest but absent: ${absolute}.`,
        { path: relativePath, cause: error });
    }
    throw new ChallengeExportError(code,
      `${JSON.stringify(relativePath)} could not be read: ${error.message}`,
      { path: relativePath, cause: error });
  } finally {
    if (handle !== void 0) await handle.close();
  }
}

/**
 * Walk a tree without following links, as sorted relative POSIX entries.
 *
 * Entry kinds come from a directory listing that reports the link itself, so a
 * link, a special file or an unexpected extra entry surfaces as exactly what it
 * is instead of being silently traversed.
 *
 * The walk is split by purpose, and the two purposes must not be confused:
 *
 *  - `safety` reports *every* physical entry, so a name that is conventional for
 *    a dependency, build or version-control directory never hides an entry from
 *    the safety question. Skipping such a name from the safety walk would let a
 *    link or a special file stand inside the source, and one entry there is
 *    enough for the whole source root to be unsafe, because that root is the
 *    same tree a participant may be pointed at.
 *  - `workload` selects the published file set. A *directory* bearing one of the
 *    accepted skip names holds dependency, build or version-control material: it
 *    is separate material that is not published and its ordinary files are not
 *    "extras outside the manifest", which is why its files are not selected
 *    while its own existence is still known through this very walk.
 *
 * Both walks therefore agree on what is dangerous and differ only on which
 * regular files become workload material. Anything other than a directory that
 * carries a skip name is not dependency material at all, so both walks report it
 * under its real kind: a link named `node_modules` is reported as a link.
 *
 * @param {{ root: string, code: string, purpose: 'safety' | 'workload' }} request
 * @returns {Promise<Array<{ relativePath: string, kind: string, insideSkipped: boolean }>>}
 */
async function scanTree(request) {
  const { root, code, purpose } = request;
  const found = [];
  const pending = [{ absolute: root, relative: '', insideSkipped: false }];
  while (pending.length > 0) {
    const current = pending.shift();
    let entries;
    try {
      entries = await fs.promises.readdir(current.absolute, { withFileTypes: true });
    } catch (error) {
      throw new ChallengeExportError(code,
        `the directory ${JSON.stringify(current.absolute)} cannot be listed: ${error.message}`,
        { path: current.absolute, cause: error });
    }
    for (const entry of entries) {
      const relative = current.relative === '' ? entry.name : `${current.relative}/${entry.name}`;
      const absolute = path.join(current.absolute, entry.name);
      const insideSkipped = current.insideSkipped === true;
      const skippedDirectory = entry.isDirectory() && SKIPPED_NAMES.includes(entry.name);
      if (entry.isSymbolicLink()) {
        found.push({ relativePath: relative, kind: 'link', insideSkipped });
      } else if (entry.isDirectory()) {
        const descendantSkipped = insideSkipped || skippedDirectory;
        // Neither walk lets a conventional name end the descent: the safety walk
        // must see what stands inside it, the workload walk must know the entries
        // below it are separate material rather than unknown ground.
        pending.push({ absolute, relative, insideSkipped: descendantSkipped });
        if (purpose === 'safety') {
          found.push({ relativePath: relative, kind: 'directory', insideSkipped });
        }
      } else if (entry.isFile()) {
        // Workload material is a regular file that is neither a skipped name
        // itself nor reached through one; those files are separate material.
        if (purpose === 'safety' || (!skippedDirectory && !insideSkipped)) {
          found.push({ relativePath: relative, kind: 'file', insideSkipped });
        }
      } else {
        found.push({ relativePath: relative, kind: 'special', insideSkipped });
      }
    }
  }
  found.sort((left, right) => RAW_COMPARE(left.relativePath, right.relativePath));
  return found;
}

/**
 * Report the safety findings of a whole-physical-tree walk.
 *
 * A link or a special file anywhere in the tree is returned first, deepest
 * reason last and relative path first, so the caller can turn it into a refusal
 * naming the exact entry; directories are not reported here because entering one
 * is what the walk is for.
 *
 * @param {Array<{ relativePath: string, kind: string }>} entries
 * @returns {{ kind: 'link' | 'special', relativePath: string } | null}
 */
function firstUnsafeEntry(entries) {
  for (const entry of entries) {
    if (entry.kind === 'link' || entry.kind === 'special') {
      return { kind: entry.kind, relativePath: entry.relativePath };
    }
  }
  return null;
}

/**
 * Prove the physical source is link-safe and that its workload is exactly what
 * was declared.
 *
 * Safety is answered over the whole physical source, with no name skipped, so
 * a link or a special file cannot hide inside a directory whose name merely
 * matches a harness convention; that check runs before any workload comparison
 * and long before any byte is copied. The workload set is then demanded to be
 * exactly the declared manifest, so owner, harness, version-control, state or
 * previous-solution material cannot be exported even by accident, and the
 * declared set must be present, so a trimmed source cannot pass as a clean one.
 * Only a skipped-name directory's own ordinary files are separate material, and
 * such a directory is refused outright in a source, because the source is the
 * single declared workload and dependency material belongs to a later step.
 *
 * @param {object} operation
 * @returns {Promise<void>}
 */
async function assertSourceInventory(operation) {
  const safety = await scanTree({
    root: operation.sourceRoot,
    code: EXPORT_ERROR_CODES.SOURCE_UNSAFE,
    purpose: 'safety',
  });
  const unsafe = firstUnsafeEntry(safety);
  if (unsafe !== null) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.SOURCE_UNSAFE,
      unsafe.kind === 'link'
        ? `the source contains a symbolic link at ${JSON.stringify(unsafe.relativePath)}.`
        : `the source contains a special (non regular) file at ${JSON.stringify(unsafe.relativePath)}.`,
      { path: unsafe.relativePath });
  }
  const skipped = safety.filter((entry) => entry.kind === 'directory' && isSkippedName(entry.relativePath));
  if (skipped.length > 0) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.WORKLOAD_MISMATCH,
      `the source contains ${skipped.length} dependency or version-control director(ies) outside the workload manifest: ${skipped.map((entry) => entry.relativePath).join(', ')}.`);
  }
  const workload = await scanTree({
    root: operation.sourceRoot,
    code: EXPORT_ERROR_CODES.SOURCE_UNSAFE,
    purpose: 'workload',
  });
  const present = new Set(workload.map((entry) => entry.relativePath));
  const missing = operation.manifest.filter((entry) => !present.has(entry));
  if (missing.length > 0) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.WORKLOAD_MISMATCH,
      `the source is missing ${missing.length} declared workload file(s): ${missing.join(', ')}.`);
  }
  const extra = [...present].filter((entry) => !operation.manifest.includes(entry));
  if (extra.length > 0) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.WORKLOAD_MISMATCH,
      `the source contains ${extra.length} file(s) outside the workload manifest: ${extra.join(', ')}.`);
  }
}

/**
 * Read the whole workload and return its per-file byte counts and digests.
 *
 * @param {object} operation
 * @param {string} code error code for any read or safety failure
 * @returns {Promise<Map<string, { bytes: number, sha256: string }>>}
 */
async function readWorkload(operation, code) {
  const observed = new Map();
  for (const relativePath of operation.manifest) {
    const bytes = await readContainedFile({ root: operation.sourceRoot, relativePath, code });
    observed.set(relativePath, Object.freeze({ bytes: bytes.byteLength, sha256: sha256(bytes) }));
  }
  return observed;
}

/**
 * Compare one verification round against the identity and against the previous
 * round, and return the recomputed workload digest.
 *
 * The first comparison proves the source really is the workload the identity
 * names, both by digest and per file; the second proves the source did not move
 * while bytes were being copied, which is what stops a mutated source from
 * being published.
 *
 * @param {object} operation
 * @param {Map<string, { bytes: number, sha256: string }>} round
 * @returns {string}
 */
function verifyWorkloadRound(operation, round) {
  const pairs = [...round.entries()]
    .map(([relativePath, entry]) => Object.freeze([relativePath, entry.sha256]))
    .sort((left, right) => RAW_COMPARE(left[0], right[0]));
  let digest;
  try {
    digest = hashEntries(pairs);
  } catch (error) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.WORKLOAD_MISMATCH,
      `the workload inventory cannot be digested: ${error.message}`, { cause: error });
  }
  if (digest !== operation.expectedDigest) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.WORKLOAD_MISMATCH,
      `the source inventory does not match the challenge identity: expected ${operation.expectedDigest}, computed ${digest}.`);
  }
  for (const [relativePath, entry] of round) {
    const declared = operation.identityDigests.get(relativePath);
    if (declared !== entry.sha256) {
      throw new ChallengeExportError(EXPORT_ERROR_CODES.WORKLOAD_MISMATCH,
        `${JSON.stringify(relativePath)} does not match the identity workload inventory: expected ${declared}, read ${entry.sha256}.`,
        { path: relativePath });
    }
  }
  if (operation.observed !== null) {
    if (round.size !== operation.observed.size) {
      throw new ChallengeExportError(EXPORT_ERROR_CODES.WORKLOAD_CHANGED,
        'the source changed during the transaction: the workload file count differs between verification rounds.');
    }
    for (const [relativePath, entry] of round) {
      const before = operation.observed.get(relativePath);
      if (before === void 0 || before.sha256 !== entry.sha256 || before.bytes !== entry.bytes) {
        throw new ChallengeExportError(EXPORT_ERROR_CODES.WORKLOAD_CHANGED,
          `the source changed during the transaction at ${JSON.stringify(relativePath)}.`, { path: relativePath });
      }
    }
  }
  operation.observed = round;
  return digest;
}

/**
 * Verify the source before any byte is copied and again after they are copied.
 *
 * @param {object} operation
 * @param {string} code error code for a read failure
 * @returns {Promise<void>}
 */
async function verifySource(operation, code) {
  await assertLinkFreeRoot(operation.sourceRoot, 'challenge.sourceRoot', {
    missing: EXPORT_ERROR_CODES.SOURCE_NOT_FOUND,
    unsafe: EXPORT_ERROR_CODES.SOURCE_UNSAFE,
  });
  await assertSourceInventory(operation);
  const round = await readWorkload(operation, code);
  verifyWorkloadRound(operation, round);
}

/**
 * Create the operation-owned staging directory as a fresh, previously absent
 * path, in a directory that is proved link-free.
 *
 * The name is generated rather than derived, and an occupied name is never
 * reused, emptied or entered: creation is exclusive, so the staging directory
 * is provably owned by this call and nothing else can already be in it.
 *
 * @param {object} operation
 * @returns {Promise<void>}
 */
async function createStaging(operation) {
  await assertLinkFreeRoot(operation.stagingParent, 'the destination parent', {
    missing: EXPORT_ERROR_CODES.DESTINATION_PARENT_MISSING,
    unsafe: EXPORT_ERROR_CODES.DESTINATION_UNSAFE,
  });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(operation.stagingParent, `${STAGING_PREFIX}${createId({ prefix: 'c2t1' })}`);
    try {
      await fs.promises.mkdir(candidate, { recursive: false });
      operation.stagingRoot = candidate;
      operation.stagingOwned = true;
      operation.created.push({ scope: 'staging', absolute: candidate, relativePath: '', kind: 'directory', identity: await fs.promises.lstat(candidate) });
      return;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      if (isMissing(error)) {
        throw new ChallengeExportError(EXPORT_ERROR_CODES.DESTINATION_PARENT_MISSING,
          `the destination parent ${JSON.stringify(operation.stagingParent)} is not usable: ${error.message}`,
          { path: operation.stagingParent, cause: error });
      }
      throw new ChallengeExportError(EXPORT_ERROR_CODES.STAGING_FAILED,
        `a private staging directory could not be created under ${JSON.stringify(operation.stagingParent)}: ${error.message}`,
        { path: operation.stagingParent, cause: error });
    }
  }
  throw new ChallengeExportError(EXPORT_ERROR_CODES.STAGING_FAILED,
    `a free private staging directory name could not be found under ${JSON.stringify(operation.stagingParent)}.`,
    { path: operation.stagingParent });
}

/**
 * Ensure the parent directories of one relative path exist inside a root this
 * call owns, refusing a link or a non-directory where a directory is required.
 *
 * Every directory this call actually created is recorded with the root it was
 * created under, because the only safe basis for removing a directory again is
 * the knowledge that this call created it. A directory that answered `EEXIST`
 * was created by somebody else and is therefore never recorded, and so can
 * never be named by the cleanup, whether or not it later holds foreign material.
 *
 * @param {{ root: string, relativePath: string, code: string, operation: object, scope: 'staging' | 'published' }} request
 * @returns {Promise<void>}
 */
async function ensureOwnedDirectories(request) {
  const { root, relativePath, code, operation, scope } = request;
  const segments = relativePath.split('/').slice(0, -1);
  let cursor = root;
  let relative = '';
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    relative = relative === '' ? segment : `${relative}/${segment}`;
    let createdHere = false;
    try {
      await fs.promises.mkdir(cursor, { recursive: false });
      createdHere = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw new ChallengeExportError(code,
          `a directory could not be created at ${JSON.stringify(cursor)}: ${error.message}`,
          { path: cursor, cause: error });
      }
    }
    let status;
    try {
      status = await fs.promises.lstat(cursor);
    } catch (error) {
      throw new ChallengeExportError(code,
        `the directory at ${JSON.stringify(cursor)} cannot be inspected: ${error.message}`,
        { path: cursor, cause: error });
    }
    if (status.isSymbolicLink()) {
      throw new ChallengeExportError(code,
        `a symbolic link stands where an owned directory is required: ${JSON.stringify(cursor)}.`, { path: cursor });
    }
    if (!status.isDirectory()) {
      throw new ChallengeExportError(code,
        `an existing entry is not a directory: ${JSON.stringify(cursor)}.`, { path: cursor });
    }
    if (createdHere) {
      operation.created.push({ scope, absolute: cursor, relativePath: relative, kind: 'directory', identity: status });
    }
  }
}

/**
 * Prove one path is still exactly the entry this call created.
 *
 * A recorded file must still be a regular file with the byte count and digest
 * that were written to it; a recorded directory must still be a directory. A
 * recorded path that has been replaced by a link, turned into something else, or
 * had its bytes changed is no longer this call's material, and removing it then
 * would delete somebody else's work.
 *
 * @param {{ absolute: string, kind: string, bytes?: number, sha256?: string }} entry
 * @returns {Promise<{ removable: boolean, why: string | null }>>}
 */
async function ownedEntryIsStillOurs(entry) {
  let status;
  try {
    status = await fs.promises.lstat(entry.absolute);
  } catch (error) {
    if (isMissing(error)) return { removable: false, why: 'it is already gone' };
    return { removable: false, why: `it cannot be inspected (${error.message})` };
  }
  if (status.isSymbolicLink()) return { removable: false, why: 'a symbolic link now stands at the recorded path' };
  if (!entry.identity || status.dev !== entry.identity.dev || status.ino !== entry.identity.ino || status.birthtimeMs !== entry.identity.birthtimeMs) {
    return { removable: false, why: 'the recorded entry was replaced by a different filesystem identity' };
  }
  if (entry.kind === 'directory') {
    if (!status.isDirectory()) return { removable: false, why: 'a non-directory now stands at the recorded path' };
    return { removable: true, why: null };
  }
  if (!status.isFile()) return { removable: false, why: 'a non-regular entry now stands at the recorded path' };
  let handle;
  let bytes;
  try {
    handle = await fs.promises.open(entry.absolute, 'r');
    bytes = new Uint8Array(await handle.readFile());
  } catch (error) {
    return { removable: false, why: `its bytes cannot be read back (${error.message})` };
  } finally {
    if (handle !== void 0) await handle.close();
  }
  if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
    return { removable: false, why: 'its bytes are not the bytes this call wrote' };
  }
  return { removable: true, why: null };
}

/**
 * Write the workload bytes into a root this call owns, creating nothing that
 * already exists, and record what was created.
 *
 * Bytes are taken from the source root and their digest is proved to still be
 * the digest the identity names *before* a single byte is written, so no write is
 * ever derived from bytes that were not verified at the moment of the write: a
 * source that moves between a verification round and a write is reported as
 * source drift instead of being published and only then noticed. Each file is
 * opened create-exclusively, so an entry that appeared in the meantime is reported
 * as a collision instead of being overwritten, and each written file is read back
 * and compared against the expected byte count and digest before the next file
 * is written.
 *
 * Every file this call creates is recorded with its byte count and digest, which
 * is what lets the later cleanup tell its own material from a concurrent writer's.
 *
 * @param {{ root: string, sourceRoot: string, manifest: ReadonlyArray<string>, expected: Map<string, { bytes: number, sha256: string }>, code: string, operation: object, scope: 'staging' | 'published' }} request
 * @returns {Promise<void>}
 */
async function writeAndVerify(request) {
  const { root, sourceRoot, manifest, expected, code, operation, scope } = request;
  for (const relativePath of manifest) {
    const absolute = path.join(root, ...relativePath.split('/'));
    await ensureOwnedDirectories({ root, relativePath, code, operation, scope });
    const source = await readContainedFile({ root: sourceRoot, relativePath, code });
    const declared = expected.get(relativePath);
    const sourceDigest = sha256(source);
    if (sourceDigest !== declared.sha256 || source.byteLength !== declared.bytes) {
      throw new ChallengeExportError(EXPORT_ERROR_CODES.WORKLOAD_CHANGED,
        `the source changed during the transaction at ${JSON.stringify(relativePath)}: expected ${declared.sha256} of ${declared.bytes} bytes, read ${sourceDigest} of ${source.byteLength} bytes.`,
        { path: relativePath });
    }
    let handle;
    try {
      handle = await fs.promises.open(absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, EXPORTED_FILE_MODE);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new ChallengeExportError(code,
          `an entry already exists where a workload file is to be written: ${JSON.stringify(relativePath)}.`,
          { path: relativePath, cause: error });
      }
      throw new ChallengeExportError(code,
        `the workload file ${JSON.stringify(relativePath)} could not be written: ${error.message}`,
        { path: relativePath, cause: error });
    }
    const created = { scope, absolute, relativePath, kind: 'file', identity: await handle.stat(), bytes: 0, sha256: sha256(new Uint8Array()) };
    operation.created.push(created);
    try {
      await handle.writeFile(source);
      created.bytes = source.byteLength;
      created.sha256 = sourceDigest;
    } catch (error) {
      // A failed write may leave an owned partial file. Capture its actual bytes
      // only while the exclusive handle still names the same filesystem entry.
      const current = await fs.promises.lstat(absolute);
      if (!current.isSymbolicLink() && current.dev === created.identity.dev && current.ino === created.identity.ino && current.birthtimeMs === created.identity.birthtimeMs) {
        const partial = await fs.promises.readFile(absolute);
        created.bytes = partial.byteLength;
        created.sha256 = sha256(partial);
      }
      throw error;
    } finally {
      await handle.close();
    }
    const readBackHandle = await fs.promises.open(absolute, 'r');
    let readBack;
    try {
      readBack = new Uint8Array(await readBackHandle.readFile());
    } finally {
      await readBackHandle.close();
    }
    const digest = sha256(readBack);
    if (digest !== declared.sha256 || readBack.byteLength !== declared.bytes) {
      throw new ChallengeExportError(code,
        `${JSON.stringify(relativePath)} was written with the wrong bytes: expected ${declared.sha256} of ${declared.bytes} bytes, read ${digest} of ${readBack.byteLength} bytes.`,
        { path: relativePath });
    }
  }
}

/**
 * Reserve the destination as an empty directory this call created.
 *
 * Reservation is the only exclusive directory primitive that is race-free
 * everywhere: creating the directory itself refuses an existing destination, so
 * nothing is renamed over, emptied or replaced, whether or not the destination
 * is empty, and a concurrent writer that got there first is left untouched.
 *
 * @param {object} operation
 * @returns {Promise<void>}
 */
async function reserveDestination(operation) {
  try {
    await fs.promises.mkdir(operation.output, { recursive: false });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new ChallengeExportError(EXPORT_ERROR_CODES.DESTINATION_EXISTS,
        `the destination ${JSON.stringify(operation.output)} already exists; an existing destination is never overwritten.`,
        { path: operation.output, cause: error });
    }
    if (isMissing(error)) {
      throw new ChallengeExportError(EXPORT_ERROR_CODES.DESTINATION_PARENT_MISSING,
        `the destination parent ${JSON.stringify(operation.stagingParent)} does not exist: ${error.message}`,
        { path: operation.stagingParent, cause: error });
    }
    throw new ChallengeExportError(EXPORT_ERROR_CODES.PUBLICATION_FAILED,
      `the destination ${JSON.stringify(operation.output)} could not be reserved: ${error.message}`,
      { path: operation.output, cause: error });
  }
  operation.destinationReserved = true;
  operation.created.push({ scope: 'published', absolute: operation.output, relativePath: '', kind: 'directory', identity: await fs.promises.lstat(operation.output) });
}

/**
 * Prove the published tree is exactly the workload, and nothing else.
 *
 * The published container is re-listed and re-read: the whole physical tree is
 * walked with no name skipped, so a link or a special file cannot hide inside a
 * directory whose name merely matches a harness convention; no such directory is
 * admitted at all, because a standalone published workspace is the workload plus
 * its own directory skeleton and nothing else. The file set must be exactly the
 * manifest, and the recomputed digest over the read-back bytes must equal the
 * identity workload digest. A container that is not provably complete and
 * byte-exact is never reported as success.
 *
 * @param {object} operation
 * @returns {Promise<Array<{ path: string, bytes: number, sha256: string }>>}
 */
async function verifyPublished(operation) {
  const entries = await scanTree({
    root: operation.output,
    code: EXPORT_ERROR_CODES.PUBLICATION_FAILED,
    purpose: 'safety',
  });
  const unsafe = firstUnsafeEntry(entries);
  if (unsafe !== null) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.PUBLICATION_FAILED,
      unsafe.kind === 'link'
        ? `the published workspace contains a symbolic link at ${JSON.stringify(unsafe.relativePath)}.`
        : `the published workspace contains a special (non regular) file at ${JSON.stringify(unsafe.relativePath)}.`,
      { path: unsafe.relativePath });
  }
  // The only directories a published workspace may hold are the ones the manifest
  // itself implies; anything else, whatever its name, is foreign material.
  const allowed = new Set(operation.manifest);
  for (const relativePath of operation.manifest) {
    let cursor = '';
    for (const segment of relativePath.split('/').slice(0, -1)) {
      cursor = cursor === '' ? segment : `${cursor}/${segment}`;
      allowed.add(cursor);
    }
  }
  const publishedPaths = new Set(entries.map((entry) => entry.relativePath));
  const missing = operation.manifest.filter((entry) => !publishedPaths.has(entry));
  const extra = entries.map((entry) => entry.relativePath).filter((entry) => !allowed.has(entry));
  if (missing.length > 0 || extra.length > 0) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.PUBLICATION_FAILED,
      `the published workspace is not exactly the workload (missing: ${missing.length}, extra: ${extra.length}).`);
  }
  const inventory = [];
  const round = new Map();
  for (const relativePath of operation.manifest) {
    const bytes = await readContainedFile({
      root: operation.output,
      relativePath,
      code: EXPORT_ERROR_CODES.PUBLICATION_FAILED,
    });
    const entry = Object.freeze({ path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) });
    inventory.push(entry);
    round.set(relativePath, Object.freeze({ bytes: entry.bytes, sha256: entry.sha256 }));
  }
  const digest = verifyWorkloadRound(operation, round);
  if (digest !== operation.expectedDigest) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.PUBLICATION_FAILED,
      `the published workspace digest ${digest} does not match the identity workload digest ${operation.expectedDigest}.`);
  }
  return inventory;
}

/**
 * Remove one path, non-recursively, only after it was proved to still be empty
 * of material this call did not create.
 *
 * An empty directory is removed; a directory that still holds anything — a
 * concurrent writer's file, a canary dropped next to it, or bytes this call cannot
 * account for — is kept and reported, because the point of the cleanup is to
 * remove this call's material and never to destroy anybody else's. Deleting a
 * directory recursively would do the opposite: it would follow no ownership claim
 * at all and erase whatever a race had put inside.
 *
 * @param {string} absolute
 * @param {string} kind `file` or `directory`
 * @returns {Promise<'removed' | 'kept' | 'failed'>}
 */
async function removeOwnedEntry(absolute, kind) {
  // An own-status probe: the injected listing of a *directory* cannot be
  // confused with the status of the directory itself, and every removal is
  // proved against the path it names rather than against a listing of its parent.
  let status;
  try {
    status = await fs.promises.lstat(absolute);
  } catch (error) {
    if (isMissing(error)) return 'removed';
    return 'failed';
  }
  if (kind === 'file') {
    if (!status.isFile()) return 'kept';
    try {
      await fs.promises.unlink(absolute);
      return 'removed';
    } catch (error) {
      if (isMissing(error)) return 'removed';
      if (error?.code === 'EISDIR') return 'kept';
      return 'failed';
    }
  }
  if (!status.isDirectory()) return 'kept';
  // The emptiness question is not asked of a listing, it is asked of the
  // filesystem: `rmdir` is non-recursive by construction and removes a directory
  // only when it holds nothing at all, so it cannot destroy material this call
  // did not create and cannot be talked out of an entry it would refuse. A
  // refusal that says "not empty" is the race form of "somebody else is in
  // here": the directory stays exactly where it is and is reported as residue.
  try {
    await fs.promises.rmdir(absolute);
    return 'removed';
  } catch (error) {
    if (isMissing(error)) return 'removed';
    if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST' || error?.code === 'ENOTDIR') return 'kept';
    return 'failed';
  }
}

/**
 * Remove the staging directory this call created.
 *
 * It is removed before the destination is reserved, so a failure to clean up is
 * detected while nothing has been published yet. Only a directory this call
 * provably created is ever named here, and it is taken down through the same
 * ownership-respecting path as everything else: its contents are removed
 * individually and the directory itself only when it is empty.
 *
 * @param {object} operation
 * @returns {Promise<void>}
 */
async function removeStaging(operation) {
  if (!operation.stagingOwned || operation.stagingRoot === null) return;
  const stagingRoot = operation.stagingRoot;
  const residue = [];
  const failures = [];
  const outcome = await removeOwnedTree(operation, 'staging', stagingRoot, residue, failures);
  if (outcome.residue.length > 0 || outcome.failures.length > 0) {
    throw new ChallengeExportError(EXPORT_ERROR_CODES.CLEANUP_FAILED,
      `the staging directory ${JSON.stringify(stagingRoot)} could not be taken down to its owned bytes only: ${outcome.summary}`,
      { path: stagingRoot });
  }
  operation.stagingRoot = null;
  operation.stagingOwned = false;
}

/**
 * Take down one scope's created material, owned bytes only.
 *
 * Entries are handled deepest first and each one is re-checked before it is
 * touched: a recorded file must still hold the bytes this call wrote and a
 * recorded directory must be empty of anything this call did not create. So a
 * published root into which a concurrent writer has put material keeps that
 * material, and the residue is reported rather than deleted.
 *
 * @param {object} operation
 * @param {'staging' | 'published'} scope
 * @param {string} root the root of that scope, named so a kept residue can be reported
 * @param {Array<{ path: string, reason: string }>} residue accumulated residue, shared across scopes
 * @param {Array<{ path: string, reason: string }>} failures accumulated failures, shared across scopes
 * @returns {Promise<{ residue: Array<{ path: string, reason: string }>, failures: Array<{ path: string, reason: string }>, summary: string }>}
 */
async function removeOwnedTree(operation, scope, root, residue, failures) {
  const mine = operation.created.filter((entry) => entry.scope === scope);
  mine.sort((left, right) => right.absolute.length - left.absolute.length);
  const stillThere = new Set(mine.map((entry) => entry.absolute));
  const containers = mine.filter((entry) => entry.kind === 'directory');
  for (const entry of mine) {
    if (!stillThere.has(entry.absolute)) continue;
    let changedAncestor = false;
    for (const ancestor of containers) {
      const relative = path.relative(ancestor.absolute, entry.absolute);
      if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        const check = await ownedEntryIsStillOurs(ancestor);
        if (!check.removable) {
          residue.push({ path: entry.absolute, reason: 'an operation-owned ancestor was replaced; its current contents are foreign' });
          changedAncestor = true;
          break;
        }
      }
    }
    if (changedAncestor) continue;
    const check = await ownedEntryIsStillOurs(entry);
    if (!check.removable) {
      // Not our bytes any more: keep it, and stop naming its ancestors, which can
      // no longer be shown to be empty of material that is not ours.
      residue.push({ path: entry.absolute, reason: check.why });
      let cut = entry.absolute;
      for (;;) {
        stillThere.delete(cut);
        const parent = path.dirname(cut);
        if (parent === cut || !stillThere.has(parent)) break;
        cut = parent;
      }
      continue;
    }
    const outcome = await removeOwnedEntry(entry.absolute, entry.kind);
    if (outcome === 'removed') {
      stillThere.delete(entry.absolute);
      continue;
    }
    if (outcome === 'kept') {
      residue.push({ path: entry.absolute, reason: 'it still holds material this call did not create' });
      let cut = entry.absolute;
      for (;;) {
        stillThere.delete(cut);
        const parent = path.dirname(cut);
        if (parent === cut || !stillThere.has(parent)) break;
        cut = parent;
      }
      continue;
    }
    failures.push({ path: entry.absolute, reason: 'the filesystem refused to remove it' });
  }
  // Scope roots are recorded with their creation identity and handled above;
  // never remove a root merely because its pathname was once reserved.
  operation.created = operation.created.filter((entry) => entry.scope !== scope);
  const summary = [...failures, ...residue]
    .map((entry) => `${JSON.stringify(entry.path)} (${entry.reason})`)
    .join('; ');
  return { residue, failures, summary };
}

/**
 * Remove only material this call provably created, after a failed transaction.
 *
 * The staging directory and a reserved destination are taken down only when this
 * call created them, and only entry by entry: a recorded file is removed when it
 * still holds the bytes this call wrote, and a recorded directory when it is
 * empty of material this call did not create. A destination that already existed
 * was refused before it was ever owned, and material a concurrent writer placed
 * inside a reserved destination is left exactly where it was found. What cannot be
 * removed in that way is kept, disclosed, and reported as `CLEANUP_FAILED`, which
 * is the honest outcome: residue is a defect to report, not material to destroy.
 *
 * @param {object} operation
 * @returns {Promise<void>}
 */
async function cleanupOwned(operation) {
  const residue = [];
  const failures = [];
  if (operation.stagingOwned && operation.stagingRoot !== null) {
    await removeOwnedTree(operation, 'staging', operation.stagingRoot, residue, failures);
    operation.stagingOwned = false;
  }
  if (operation.destinationReserved) {
    await removeOwnedTree(operation, 'published', operation.output, residue, failures);
    operation.destinationReserved = false;
  }
  if (failures.length === 0 && residue.length === 0) return;
  const parts = [];
  if (failures.length > 0) parts.push(`could not be removed: ${failures.map((entry) => JSON.stringify(entry.path)).join(', ')}`);
  if (residue.length > 0) parts.push(`kept because it is not this call's material: ${residue.map((entry) => JSON.stringify(entry.path)).join(', ')}`);
  throw new ChallengeExportError(EXPORT_ERROR_CODES.CLEANUP_FAILED,
    `material left behind by the failed transaction — ${parts.join('; ')}.`);
}

/**
 * Export one challenge package into a complete, byte-exact public workspace.
 *
 * The returned workspace is the destination root itself. It contains exactly the
 * manifest's workload files with their original bytes, and the reported digest
 * is recomputed from the published files, not copied from the request.
 *
 * The transaction runs in this order: verify the source, stage and read back a
 * private copy, verify the source again, reserve the destination exclusively,
 * publish, then re-verify the published container. On any failure the material
 * this call created is removed and the failure is rethrown; if that cleanup
 * itself fails, the cleanup error is attached to the rethrown failure instead of
 * replacing it, so the original reason stays visible and the residue is still
 * disclosed.
 *
 * @param {{ challenge: {
 *   identity: object,
 *   sourceRoot: string,
 *   fileManifest: ReadonlyArray<string>,
 *   ownerRoots: ReadonlyArray<string>,
 *   evaluatorRoots: ReadonlyArray<string>,
 * }, output: string }} options
 * @returns {Promise<{ workspaceRoot: string, workloadDigest: string, inventory: ReadonlyArray<{ path: string, bytes: number, sha256: string }> }>}
 */
export async function exportChallenge(options) {
  const operation = beginOperation(options);
  try {
    await verifySource(operation, EXPORT_ERROR_CODES.SOURCE_UNSAFE);
    await createStaging(operation);
    await writeAndVerify({
      root: operation.stagingRoot,
      sourceRoot: operation.sourceRoot,
      manifest: operation.manifest,
      expected: operation.observed,
      code: EXPORT_ERROR_CODES.STAGING_FAILED,
      operation,
      scope: 'staging',
    });
    await removeStaging(operation);
    await verifySource(operation, EXPORT_ERROR_CODES.SOURCE_UNSAFE);
    await reserveDestination(operation);
    await writeAndVerify({
      root: operation.output,
      sourceRoot: operation.sourceRoot,
      manifest: operation.manifest,
      expected: operation.observed,
      code: EXPORT_ERROR_CODES.PUBLICATION_FAILED,
      operation,
      scope: 'published',
    });
    const inventory = await verifyPublished(operation);
    await verifySource(operation, EXPORT_ERROR_CODES.SOURCE_UNSAFE);
    return Object.freeze({
      workspaceRoot: operation.output,
      workloadDigest: operation.expectedDigest,
      inventory: Object.freeze(inventory.map((entry) => Object.freeze({ ...entry }))),
    });
  } catch (error) {
    const failure = error instanceof ChallengeExportError ? error
      : new ChallengeExportError(EXPORT_ERROR_CODES.INTERNAL,
        `the export transaction failed unexpectedly: ${error?.message ?? String(error)}`, { cause: error });
    try {
      await cleanupOwned(operation);
    } catch (cleanupError) {
      failure.cleanup = cleanupError instanceof ChallengeExportError ? cleanupError
        : new ChallengeExportError(EXPORT_ERROR_CODES.CLEANUP_FAILED,
          `material created by this call could not be removed: ${cleanupError?.message ?? String(cleanupError)}`,
          { cause: cleanupError });
    }
    throw failure;
  }
}
