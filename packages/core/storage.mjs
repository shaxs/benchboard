/**
 * BenchBoard neutral storage transactions (C1 T3).
 *
 * Standalone module: Node builtins only. No DSH imports, no environment,
 * config, global-state or network lookups. Storage roots are always explicit
 * absolute paths supplied by the caller.
 *
 * Model:
 *  - Every record lives in a JSON envelope binding { schemaVersion, kind, id,
 *    value, digest }. The digest is the SHA-256 hex of the canonical JSON of
 *    { id, kind, value } (recursive, lexicographically sorted object keys).
 *  - Identities are (kind, id) pairs. They are unique across all locations
 *    within the explicit output root (tracked by a local registry inside
 *    `<root>/.storage/registry.json`; there is no network or global registry).
 *  - createImmutable stages complete bytes in the target directory, writes a
 *    bound identity reservation into the registry BEFORE any byte
 *    publication, and publishes with an exclusive link() (fails if the
 *    target exists), so immutable publication can never overwrite.
 *  - replaceMutable stages complete bytes and publishes them with an atomic
 *    same-directory rename() while holding the exclusive root-wide lock.
 *    A first-time mutable publication reserves the identity as a bound
 *    pending mutable reservation in the registry BEFORE any byte
 *    publication; an interrupted first-time publication is therefore
 *    recoverable as the SAME mutable identity: an identical replaceMutable
 *    retry finalizes the record as mutable and later value changes remain
 *    allowed, while a different-bytes retry, a cross-location retry or a
 *    createImmutable type conversion over the pending mutable reservation
 *    is refused (bytes and identity preserved).
 *    A record registered as immutable can never be replaced or type-converted
 *    through replaceMutable: the original bytes, identity binding and
 *    registry entry are preserved (ERR_STORAGE_IMMUTABLE_REPLACEMENT).
 *    Published-but-reserved (or unregistered) immutable bytes occupying the
 *    target are likewise never overwritten or type-converted through the
 *    mutable API: replaceMutable refuses them and recovery is explicit
 *    (createImmutable with identical bytes at the reserved path).
 *  - A single root-wide lock file (`<root>/.storage/lock`) enforces one
 *    writer. Locks are never stolen: a lock held by another writer (other
 *    instance or process) is refused, and stale locks left by an interrupted
 *    process must be resolved by an operator, never removed automatically.
 *  - Within one container, independent concurrent transactions are serialized
 *    in FIFO order by a per-container transaction gate, so concurrent
 *    same-instance writers can never interleave registry state or publish
 *    duplicate identities. Container-token equality alone is NOT re-entrancy:
 *    a re-entrant call joins the holder only when it is causally nested inside
 *    the holder's coherent async chain (AsyncLocalStorage scope); the holder
 *    drains its nested transactions before releasing the root-wide lock.
 *  - Reads re-validate the storage root on every call (no cached root is
 *    trusted after external replacement, e.g. by a symlink/junction), and
 *    root creation refuses linked ancestors upfront instead of first
 *    creating directories through them.
 *  - Failure semantics (supported scope): any failure before the bound
 *    reservation is written leaves no final bytes at the target path and no
 *    registry entry. Before any FIRST byte publication (immutable or
 *    first-time mutable), the registry carries a bound reservation
 *    `(kind, id) -> { relativePath, digest, recordType: 'immutable' |
 *    'mutable', pending: true }`.
 *    An interruption after that point (including a crash or process kill
 *    between publication and registration) is a conservative, recoverable
 *    interrupted state:
 *    - the identity is reserved at its publication path; a retry at ANOTHER
 *      location is refused (ERR_STORAGE_DUPLICATE_IDENTITY) so recovery can
 *      never republish or relocate the reserved identity;
 *    - a retry with DIFFERENT bytes at the reserved path is refused;
 *    - a retry with byte-identical content at the reserved path recovers
 *      through the API that owns the reserved record type:
 *      createImmutable registers the immutable bytes with `recovered: true`,
 *      and replaceMutable finalizes the first-time mutable publication as
 *      MUTABLE with `recovered: true` (later value changes remain allowed);
 *      recovery never changes the reserved record type;
 *    - a record type conversion over a pending mutable reservation
 *      (createImmutable where the reservation is mutable) is refused
 *      (ERR_STORAGE_TYPE_CONFLICT); likewise replaceMutable refuses a
 *      pending-or-final immutable reservation at its reserved path
 *      (ERR_STORAGE_IMMUTABLE_REPLACEMENT), keeping every reservation
 *      type-preserving;
 *    - replaceMutable refuses reserved immutable or externally-placed
 *      unregistered published targets (ERR_STORAGE_IMMUTABLE_REPLACEMENT):
 *      such bytes are never overwritten or type-converted through the
 *      mutable API, so their recovery stays explicitly bound to the
 *      immutable API.
 *    Interrupted mutable REPLACEMENTS (identity already registered mutable)
 *    still heal on the next replacement with the same identity. Corrupt,
 *    malformed, digest-mismatched, foreign-identity or non-regular-file
 *    targets fail closed. A registry entry with no record file (mutable
 *    registration, no bytes) is refused for mutation (ERR_STORAGE_RECORD_
 *    MISSING); immutable reservations without bytes are refused for mutation
 *    and recover through identical-byte republication; pending mutable
 *    reservations recover through the identical-byte replaceMutable retry
 *    that reserves them (never converted). Only the staging file
 *    owned by the current transaction is cleaned up. This module does NOT
 *    claim power-loss durability or defense against an adversarial process
 *    mutating the directory under it.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const REGISTRY_DIRNAME = '.storage';
const REGISTRY_FILENAME = 'registry.json';
const LOCK_FILENAME = 'lock';
const STAGE_INFIX = '.staging-';
const STAGE_SUFFIX = '.tmp';
const INTERNAL_STAGE_PREFIX = 'registry.staging-';
const REGISTRY_RETRY_DELAYS = Object.freeze([20, 40, 80, 160, 320, 500, 500]);
const REGISTRY_RETRY_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

const REGISTRY_KEYS = new Set(['records', 'schemaVersion']);

/** Typed error surface; every refusal has a stable `code`. */
export class StorageError extends Error {
  /**
   * @param {string} code stable error code (ERR_STORAGE_*)
   * @param {string} message human-readable description
   * @param {{[key: string]: unknown}} [details] structured context
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    if (details !== undefined) {
      /** @type {{[key: string]: unknown}} */
      this.details = details;
    }
  }
}

/* ------------------------------------------------------------------ */
/* JSON value validation and canonical serialization                   */
/* ------------------------------------------------------------------ */

/**
 * Validate that a value is exactly representable as JSON. Storage enforces
 * digest/binding integrity; the caller remains responsible for the semantic
 * domain of the value (schema validation happens outside this module).
 *
 * @param {unknown} value
 * @param {string} hint path inside the value for error messages
 * @param {Set<object>} seen recursion guard for circular structure
 * @returns {void}
 */
function assertJsonValue(value, hint = 'value', seen = new Set()) {
  if (value === null) return;
  switch (typeof value) {
    case 'string':
      return;
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new StorageError(
          'ERR_STORAGE_VALUE_NOT_JSON',
          `Value at ${hint} is not JSON-representable: non-finite number`,
        );
      }
      return;
    case 'object': {
      if (Array.isArray(value)) {
        if (seen.has(value)) {
          throw new StorageError(
            'ERR_STORAGE_VALUE_NOT_JSON',
            `Value at ${hint} is not JSON-representable: circular structure`,
          );
        }
        seen.add(value);
        for (let i = 0; i < value.length; i += 1) {
          assertJsonValue(value[i], `${hint}[${i}]`, seen);
        }
        seen.delete(value);
        return;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new StorageError(
          'ERR_STORAGE_VALUE_NOT_JSON',
          `Value at ${hint} is not a plain JSON object`,
        );
      }
      if (seen.has(value)) {
        throw new StorageError(
          'ERR_STORAGE_VALUE_NOT_JSON',
          `Value at ${hint} is not JSON-representable: circular structure`,
        );
      }
      seen.add(value);
      for (const key of Object.keys(value)) {
        assertJsonValue(value[key], `${hint}.${key}`, seen);
      }
      seen.delete(value);
      return;
    }
    default:
      throw new StorageError(
        'ERR_STORAGE_VALUE_NOT_JSON',
        `Value at ${hint} is not JSON-representable (type ${typeof value})`,
      );
  }
}

/** Bytewise-ish deterministic string comparison (UTF-16 code units). */
function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Canonical JSON: sorted object keys, no whitespace, deterministic numbers.
 * -0 canonicalizes to 0 (JSON semantics; noted in evidence, not claimed as a
 * distinct value).
 *
 * @param {unknown} value validated JSON value
 * @returns {string}
 */
function canonicalize(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return JSON.stringify(value);
    default: {
      if (Array.isArray(value)) {
        const items = value.map((item) => canonicalize(item));
        return `[${items.join(',')}]`;
      }
      const keys = Object.keys(value).sort(compareStrings);
      const members = keys.map(
        (key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`,
      );
      return `{${members.join(',')}}`;
    }
  }
}

/**
 * Fold values canonically even after validation, catching invalid shapes
 * defensively (e.g. data that mutated between validation and hashing).
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalizeVerified(value) {
  let out;
  try {
    out = canonicalize(value);
  } catch (error) {
    throw new StorageError(
      'ERR_STORAGE_VALUE_NOT_JSON',
      `Value is not canonically serializable: ${error.message}`,
    );
  }
  return out;
}

/**
 * Digest of the identity/value binding: SHA-256 hex over the canonical JSON
 * of { id, kind, value }.
 *
 * @param {string} kind
 * @param {string} id
 * @param {unknown} value
 * @returns {string}
 */
function computeDigest(kind, id, value) {
  const canonical = `{"id":${JSON.stringify(id)},"kind":${JSON.stringify(kind)},"value":${canonicalizeVerified(value)}}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

const HEX_DIGEST_RE = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ */
/* Envelope construction and verification                              */
/* ------------------------------------------------------------------ */

/**
 * @param {string} kind
 * @param {string} id
 * @param {unknown} value
 * @returns {{ bytes: Buffer, digest: string }}
 */
function buildEnvelopeBytes(kind, id, value) {
  const digest = computeDigest(kind, id, value);
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    kind,
    id,
    value,
    digest,
  };
  const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
  return { bytes, digest };
}

/**
 * Strictly verify envelope bytes. Returns the verified envelope payload.
 *
 * @param {Buffer|string} bytes raw file bytes
 * @returns {{ kind: string, id: string, value: unknown, digest: string }}
 */
function verifyEnvelopeBytes(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new StorageError(
      'ERR_STORAGE_ENVELOPE_MALFORMED',
      'Record is not valid JSON',
    );
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new StorageError(
      'ERR_STORAGE_ENVELOPE_MALFORMED',
      'Record envelope must be a JSON object',
    );
  }
  const expected = new Set([
    'schemaVersion',
    'kind',
    'id',
    'value',
    'digest',
  ]);
  const actual = new Set(Object.keys(parsed));
  const missing = [...expected].filter((key) => !actual.has(key));
  const extra = [...actual].filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new StorageError(
      'ERR_STORAGE_ENVELOPE_MALFORMED',
      `Envelope key set mismatch (missing: ${missing.join(',') || 'none'}, unexpected: ${extra.join(',') || 'none'})`,
    );
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new StorageError(
      'ERR_STORAGE_ENVELOPE_MALFORMED',
      `Unsupported record schemaVersion (${JSON.stringify(parsed.schemaVersion)})`,
    );
  }
  if (typeof parsed.kind !== 'string' || parsed.kind.length === 0) {
    throw new StorageError(
      'ERR_STORAGE_ENVELOPE_MALFORMED',
      'Envelope kind must be a non-empty string',
    );
  }
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
    throw new StorageError(
      'ERR_STORAGE_ENVELOPE_MALFORMED',
      'Envelope id must be a non-empty string',
    );
  }
  if (
    typeof parsed.digest !== 'string' ||
    !HEX_DIGEST_RE.test(parsed.digest)
  ) {
    throw new StorageError(
      'ERR_STORAGE_ENVELOPE_MALFORMED',
      'Envelope digest must be a 64-character lowercase hex string',
    );
  }
  const observed = computeDigest(parsed.kind, parsed.id, parsed.value);
  const a = Buffer.from(parsed.digest, 'hex');
  const b = Buffer.from(observed, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new StorageError(
      'ERR_STORAGE_DIGEST_MISMATCH',
      `Digest mismatch: recorded ${parsed.digest}, observed ${observed}`,
      { recordedDigest: parsed.digest, observedDigest: observed },
    );
  }
  return {
    kind: parsed.kind,
    id: parsed.id,
    value: parsed.value,
    digest: parsed.digest,
  };
}

/* ------------------------------------------------------------------ */
/* Path validation and filesystem checks                               */
/* ------------------------------------------------------------------ */

const KIND_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

/**
 * @param {string} kind
 * @returns {void}
 */
function assertKind(kind) {
  if (typeof kind !== 'string' || !KIND_PATTERN.test(kind)) {
    throw new StorageError(
      'ERR_STORAGE_INVALID_IDENTITY',
      `kind must match ${KIND_PATTERN.source}`,
    );
  }
}

/**
 * @param {string} id
 * @returns {void}
 */
function assertId(id) {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 512 ||
    id.includes('\u0000')
  ) {
    throw new StorageError(
      'ERR_STORAGE_INVALID_IDENTITY',
      'id must be a non-empty string of at most 512 characters without NUL',
    );
  }
}

/**
 * Validate a caller-supplied relative path. Rejects unsafe paths (absolute,
 * traversal, Windows separators, reserved internal namespace, empty/`.`/`..`
 * segments, NUL, drive-relative forms).
 *
 * @param {unknown} relativePath
 * @returns {string} the validated relative path (POSIX separators)
 */
function validateRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new StorageError(
      'ERR_STORAGE_INVALID_PATH',
      'relativePath must be a non-empty string',
    );
  }
  if (relativePath.includes('\u0000')) {
    throw new StorageError(
      'ERR_STORAGE_INVALID_PATH',
      'relativePath contains a NUL byte',
    );
  }
  if (relativePath.includes('\\')) {
    throw new StorageError(
      'ERR_STORAGE_INVALID_PATH',
      'relativePath must use POSIX "/" separators',
    );
  }
  if (path.posix.isAbsolute(relativePath)) {
    throw new StorageError(
      'ERR_STORAGE_INVALID_PATH',
      `relativePath must be relative, received ${relativePath}`,
    );
  }
  if (/^[A-Za-z]:/.test(relativePath)) {
    throw new StorageError(
      'ERR_STORAGE_INVALID_PATH',
      `relativePath must not be drive-qualified, received ${relativePath}`,
    );
  }
  const segments = relativePath.split('/');
  if (segments.length === 0) {
    throw new StorageError(
      'ERR_STORAGE_INVALID_PATH',
      'relativePath must name a record',
    );
  }
  if (segments[0] === REGISTRY_DIRNAME) {
    throw new StorageError(
      'ERR_STORAGE_RESERVED_PATH',
      `relativePath must not enter the reserved ${REGISTRY_DIRNAME}/ namespace`,
    );
  }
  for (const segment of segments) {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..'
    ) {
      throw new StorageError(
        'ERR_STORAGE_INVALID_PATH',
        `relativePath segments must not be empty, "." or "..", received ${relativePath}`,
      );
    }
  }
  return relativePath;
}

/**
 * Case-fold a real root/registry path for Windows case ambiguity checks.
 *
 * @param {string} value
 * @returns {string}
 */
function casefoldPath(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * Find the closest already-existing component on the directory chain of
 * `absoluteRoot` (walking upwards). Returns undefined when nothing up to the
 * filesystem root exists. Used to check ancestors for links BEFORE creating
 * the storage root, so nothing is ever created through a linked ancestor.
 *
 * @param {string} absoluteRoot
 * @returns {Promise<{ path: string, st: import('node:fs').Stats } | undefined>}
 */
async function nearestExistingAncestor(absoluteRoot) {
  let current = absoluteRoot;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    let st;
    try {
      st = await lstat(parent);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new StorageError(
          'ERR_STORAGE_ROOT_NOT_DIRECTORY',
          `Cannot inspect ancestor ${parent} of storage root ${absoluteRoot}: ${error.message}`,
        );
      }
      current = parent;
      continue;
    }
    return { path: parent, st };
  }
}

/**
 * Ensure the root exists (optionally creating it), is a directory, is not a
 * symlink, and has no symlinked ancestor. Returns the resolved real root.
 * Before creating a missing root, the nearest existing ancestor is checked
 * upfront for links so creation never happens through a linked ancestor.
 *
 * @param {string} absoluteRoot caller-supplied absolute root
 * @param {{ create: boolean }} options
 * @returns {Promise<string>} realpath of the storage root
 */
async function ensureRealRoot(absoluteRoot, { create }) {
  let st;
  try {
    st = await lstat(absoluteRoot);
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (!create) {
        throw new StorageError(
          'ERR_STORAGE_ROOT_NOT_FOUND',
          `Storage root does not exist: ${absoluteRoot}`,
        );
      }
      // Upfront ancestor check: refuse a linked ancestor before any mkdir so
      // no directories are ever created through a link.
      const ancestor = await nearestExistingAncestor(absoluteRoot);
      if (ancestor !== undefined) {
        if (ancestor.st.isSymbolicLink()) {
          throw new StorageError(
            'ERR_STORAGE_ROOT_LINK',
            `Ancestor ${ancestor.path} of storage root ${absoluteRoot} is a symlink; refusing to create the root through it`,
          );
        }
        const realAncestor = await realpath(ancestor.path);
        if (casefoldPath(realAncestor) !== casefoldPath(ancestor.path)) {
          throw new StorageError(
            'ERR_STORAGE_ROOT_LINK',
            `Ancestor ${ancestor.path} of storage root ${absoluteRoot} resolves through a link (${ancestor.path} -> ${realAncestor}); refusing to create the root through it`,
          );
        }
      }
      try {
        await mkdir(absoluteRoot, { recursive: true });
      } catch (mkError) {
        throw new StorageError(
          'ERR_STORAGE_ROOT_NOT_DIRECTORY',
          `Failed to create storage root ${absoluteRoot}: ${mkError.message}`,
        );
      }
      st = await lstat(absoluteRoot);
    } else {
      throw new StorageError(
        'ERR_STORAGE_ROOT_NOT_DIRECTORY',
        `Cannot inspect storage root ${absoluteRoot}: ${error.message}`,
      );
    }
  }
  if (st.isSymbolicLink()) {
    throw new StorageError(
      'ERR_STORAGE_ROOT_LINK',
      `Storage root must not be a symlink: ${absoluteRoot}`,
    );
  }
  if (!st.isDirectory()) {
    throw new StorageError(
      'ERR_STORAGE_ROOT_NOT_DIRECTORY',
      `Storage root must be a directory: ${absoluteRoot}`,
    );
  }
  const real = await realpath(absoluteRoot);
  if (casefoldPath(real) !== casefoldPath(absoluteRoot)) {
    // An ancestor (or the platform itself) resolved through a link; realpath
    // diverging from the explicitly named root means the caller pointed at a
    // linked location.
    if (
      process.platform === 'win32'
        ? real.toLowerCase() !== absoluteRoot.toLowerCase()
        : real !== absoluteRoot
    ) {
      throw new StorageError(
        'ERR_STORAGE_ROOT_LINK',
        `Storage root resolves through a link (${absoluteRoot} -> ${real})`,
      );
    }
  }
  return real;
}

/**
 * Walk the directory chain for a validated relative path from the real root,
 * rejecting missing or linked/non-directory ancestors. Returns map of details
 * per level so write paths can create missing directories.
 *
 * @param {string} realRoot realpath of storage root
 * @param {string} relativePath validated relative path
 * @param {{ create: boolean }} options create missing intermediate dirs
 * @returns {Promise<string>} directory that contains the record
 */
async function ensureParentDirectory(realRoot, relativePath, { create }) {
  const segments = relativePath.split('/');
  let current = realRoot;
  for (const segment of segments.slice(0, -1)) {
    const next = path.join(current, segment);
    let st;
    try {
      st = await lstat(next);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new StorageError(
          'ERR_STORAGE_PATH_UNUSABLE',
          `Cannot inspect ${next}: ${error.message}`,
        );
      }
      st = undefined;
    }
    if (st === undefined) {
      if (!create) {
        throw new StorageError(
          'ERR_STORAGE_NOT_FOUND',
          `Record path does not exist: ${relativePath}`,
        );
      }
      try {
        await mkdir(next, { recursive: false });
      } catch (mkError) {
        if (mkError.code !== 'EEXIST') {
          throw new StorageError(
            'ERR_STORAGE_PATH_UNUSABLE',
            `Cannot create directory ${next}: ${mkError.message}`,
          );
        }
      }
      st = await lstat(next);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new StorageError(
        'ERR_STORAGE_LINKED_OR_NON_DIRECTORY',
        `Record path contains a linked or non-directory component: ${next}`,
      );
    }
    const realNext = await realpath(next);
    if (casefoldPath(realNext) !== casefoldPath(next)) {
      throw new StorageError(
        'ERR_STORAGE_LINKED_OR_NON_DIRECTORY',
        `Directory ${next} resolves through a link to ${realNext}`,
      );
    }
    current = next;
  }
  return current;
}

/**
 * Locate the record file itself (no creation). Returns its lstat result.
 *
 * @param {string} parentDirectory
 * @param {string} basename
 * @returns {Promise<{ st: import('node:fs').Stats | undefined }>}
 */
async function lstatRecord(parentDirectory, basename) {
  const target = path.join(parentDirectory, basename);
  try {
    const st = await lstat(target);
    return { st };
  } catch (error) {
    if (error.code === 'ENOENT') return { st: undefined };
    throw new StorageError(
      'ERR_STORAGE_PATH_UNUSABLE',
      `Cannot inspect ${target}: ${error.message}`,
    );
  }
}

/**
 * Verify a record target is an existing regular file (never a symlink or
 * special file).
 *
 * @param {import('node:fs').Stats} st
 * @param {string} target
 * @returns {void}
 */
function assertRegularFileTarget(st, target) {
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new StorageError(
      'ERR_STORAGE_NOT_REGULAR_FILE',
      `Record target must be a regular file, received other file type: ${target}`,
    );
  }
}

/**
 * Read the record bytes and strictly verify the envelope. Enforces the
 * identity binding against the requested kind/id.
 *
 * @param {string} target
 * @param {{ kind: string, id: string }} identity
 * @returns {Promise<{ value: unknown, digest: string }>}
 */
async function readAndVerifyRecord(target, identity) {
  let bytes;
  try {
    bytes = await readFile(target);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new StorageError(
        'ERR_STORAGE_NOT_FOUND',
        `Record not found: ${target}`,
      );
    }
    throw new StorageError(
      'ERR_STORAGE_PATH_UNUSABLE',
      `Cannot read record ${target}: ${error.message}`,
    );
  }
  const envelope = verifyEnvelopeBytes(bytes);
  if (envelope.kind !== identity.kind || envelope.id !== identity.id) {
    throw new StorageError(
      'ERR_STORAGE_IDENTITY_MISMATCH',
      `Record identity ${envelope.kind}/${envelope.id} does not match requested ${identity.kind}/${identity.id}`,
      {
        envelopeKind: envelope.kind,
        envelopeId: envelope.id,
        requestedKind: identity.kind,
        requestedId: identity.id,
      },
    );
  }
  return { value: envelope.value, digest: envelope.digest };
}

/* ------------------------------------------------------------------ */
/* Registry (local, explicit-root only)                                */
/* ------------------------------------------------------------------ */

/**
 * Key for (kind, id): JSON array encoding keeps it unambiguous.
 *
 * @param {string} kind
 * @param {string} id
 * @returns {string}
 */
function identityKey(kind, id) {
  return JSON.stringify([kind, id]);
}

/**
 * @param {string} registryPath
 * @returns {Promise<{ schemaVersion: number, records: Record<string, {
 *   relativePath: string, digest: string, recordType: 'immutable'|'mutable',
 *   pending?: true
 * }> } | undefined>}
 */
async function loadRegistry(registryPath) {
  let raw;
  try {
    raw = await readFile(registryPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new StorageError(
      'ERR_STORAGE_REGISTRY_CORRUPT',
      `Cannot read registry ${registryPath}: ${error.message}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StorageError(
      'ERR_STORAGE_REGISTRY_CORRUPT',
      `Registry is not valid JSON: ${registryPath}`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new StorageError(
      'ERR_STORAGE_REGISTRY_CORRUPT',
      'Registry must be a JSON object',
    );
  }
  const actualKeys = new Set(Object.keys(parsed));
  if (
    actualKeys.size !== REGISTRY_KEYS.size ||
    [...actualKeys].some((key) => !REGISTRY_KEYS.has(key))
  ) {
    throw new StorageError(
      'ERR_STORAGE_REGISTRY_CORRUPT',
      `Registry key set mismatch; expected only ${[...REGISTRY_KEYS].join(',')}`,
    );
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION || !parsed.records) {
    throw new StorageError(
      'ERR_STORAGE_REGISTRY_CORRUPT',
      `Unsupported registry schemaVersion (${JSON.stringify(parsed.schemaVersion)})`,
    );
  }
  if (
    typeof parsed.records !== 'object' ||
    Array.isArray(parsed.records) ||
    parsed.records === null
  ) {
    throw new StorageError(
      'ERR_STORAGE_REGISTRY_CORRUPT',
      'Registry records must be a JSON object',
    );
  }
  // Validate every entry; refuse unknown/malformed shapes instead of guessing.
  const casefoldIndex = new Map();
  for (const [key, entry] of Object.entries(parsed.records)) {
    let identity;
    try {
      identity = JSON.parse(key);
    } catch {
      throw new StorageError(
        'ERR_STORAGE_REGISTRY_CORRUPT',
        `Registry key is not a JSON identity array: ${key}`,
      );
    }
    if (
      !Array.isArray(identity) ||
      identity.length !== 2 ||
      typeof identity[0] !== 'string' ||
      typeof identity[1] !== 'string'
    ) {
      throw new StorageError(
        'ERR_STORAGE_REGISTRY_CORRUPT',
        `Registry key must be [kind, id]: ${key}`,
      );
    }
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry)
    ) {
      throw new StorageError(
        'ERR_STORAGE_REGISTRY_CORRUPT',
        `Registry entry must be a JSON object: ${key}`,
      );
    }
    const entryKeys = new Set(Object.keys(entry));
    const baseShape =
      typeof entry.relativePath === 'string' &&
      typeof entry.digest === 'string' &&
      HEX_DIGEST_RE.test(entry.digest) &&
      (entry.recordType === 'immutable' || entry.recordType === 'mutable');
    // Final registration: exactly { relativePath, digest, recordType }.
    const finalShape = baseShape && entryKeys.size === 3;
    // Bound reservation (interrupted publication, either record type):
    // exactly { relativePath, digest, recordType, pending: true }.
    const reservationShape =
      baseShape &&
      entryKeys.size === 4 &&
      entryKeys.has('pending') &&
      entry.pending === true;
    if (!finalShape && !reservationShape) {
      throw new StorageError(
        'ERR_STORAGE_REGISTRY_CORRUPT',
        `Registry entry shape invalid for ${key}`,
      );
    }
    const folded = casefoldPath(entry.relativePath);
    const seen = casefoldIndex.get(folded);
    if (
      seen !== undefined &&
      (seen !== entry.relativePath || parsed.records[key].relativePath !== seen)
    ) {
      throw new StorageError(
        'ERR_STORAGE_REGISTRY_CORRUPT',
        `Registry contains case-ambiguous paths for ${folded}`,
      );
    }
    casefoldIndex.set(folded, entry.relativePath);
  }
  return { schemaVersion: SCHEMA_VERSION, records: parsed.records };
}

// Retry receipts are private to the locked transaction. Checks are cooperative,
// not an operating-system sandbox or an atomic snapshot against hostile writers.
function sameRegistryEntry(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

function registryProofRefusal() {
  return new StorageError('ERR_STORAGE_REGISTRY_UNAVAILABLE',
    'Registry staging ownership or namespace changed; refusing replacement or cleanup');
}

async function registryFileProof(target, expected = undefined, absentAllowed = false) {
  let before;
  try { before = await lstat(target, { bigint: true }); }
  catch (error) {
    if (absentAllowed && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      (expected && !sameRegistryEntry(before, expected.stat))) throw registryProofRefusal();
  const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameRegistryEntry(before, opened) || !opened.isFile() || opened.nlink !== 1n) throw registryProofRefusal();
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameRegistryEntry(opened, after) || after.size !== BigInt(bytes.length) ||
        after.nlink !== 1n) throw registryProofRefusal();
  } finally { await handle.close(); }
  const current = await lstat(target, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
      !sameRegistryEntry(before, current) || current.size !== BigInt(bytes.length) ||
      (expected && !bytes.equals(expected.bytes))) throw registryProofRefusal();
  return { path: target, stat: current, bytes };
}

async function registryNamespaceProof(storageDir, expected = undefined) {
  const directories = [];
  for (let at = storageDir;; at = path.dirname(at)) {
    const stat = await lstat(at, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw registryProofRefusal();
    directories.push({ path: at, stat });
    if (path.dirname(at) === at) break;
  }
  if (casefoldPath(await realpath(storageDir)) !== casefoldPath(path.resolve(storageDir))) throw registryProofRefusal();
  if (expected && (directories.length !== expected.directories.length ||
      directories.some((entry, index) => entry.path !== expected.directories[index].path ||
        !sameRegistryEntry(entry.stat, expected.directories[index].stat)))) throw registryProofRefusal();
  const acquiredLock = rootLocks.get(casefoldPath(path.dirname(storageDir)))?.receipt;
  if (!acquiredLock) throw registryProofRefusal();
  const lock = await registryFileProof(path.join(storageDir, LOCK_FILENAME), expected?.lock ?? acquiredLock);
  const registry = await registryFileProof(path.join(storageDir, REGISTRY_FILENAME), expected?.registry ?? undefined, true);
  if (expected && Boolean(registry) !== Boolean(expected.registry)) throw registryProofRefusal();
  return { directories, lock, registry };
}

async function verifyRegistryStage(storageDir, stagePath, namespace, stage) {
  await registryNamespaceProof(storageDir, namespace);
  await registryFileProof(stagePath, stage);
}

/**
 * Atomically replace the registry file under the exclusive lock. Windows-only
 * transient rename retries keep this lock, stage and bytes; other writes never
 * inherit this policy. The schedule bounds waiting, not filesystem wall time.
 *
 * @param {string} storageDir
 * @param {string} registryPath
 * @param {Record<string, unknown>} records
 * @returns {Promise<void>}
 */
async function saveRegistry(storageDir, registryPath, records) {
  const stageName = `${INTERNAL_STAGE_PREFIX}${randomUUID()}${STAGE_SUFFIX}`;
  const stagePath = path.join(storageDir, stageName);
  let bytes;
  try {
    bytes = Buffer.from(
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, records }),
      'utf8',
    );
  } catch (error) {
    throw new StorageError(
      'ERR_STORAGE_REGISTRY_CORRUPT',
      `Registry content is not serializable: ${error.message}`,
    );
  }
  let namespace;
  let stage;
  let firstRenameError;
  try {
    namespace = await registryNamespaceProof(storageDir);
    const handle = await open(stagePath, 'wx', 0o644);
    try {
      stage = { stat: await handle.stat({ bigint: true }), bytes };
      await handle.writeFile(bytes);
      stage.stat = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
    for (let attempt = 0;; attempt += 1) {
      try {
        await rename(stagePath, registryPath);
        break;
      } catch (error) {
        firstRenameError ??= error;
        if (process.platform !== 'win32' || !REGISTRY_RETRY_ERRORS.has(error.code)) throw error;
        if (attempt === REGISTRY_RETRY_DELAYS.length) throw firstRenameError;
        await new Promise((resolve) => setTimeout(resolve, REGISTRY_RETRY_DELAYS[attempt]));
        try { await verifyRegistryStage(storageDir, stagePath, namespace, stage); }
        catch (verificationError) {
          verificationError.cause ??= firstRenameError;
          throw verificationError;
        }
      }
    }
  } catch (error) {
    let retained = Boolean(stage);
    if (stage && namespace) {
      try {
        await verifyRegistryStage(storageDir, stagePath, namespace, stage);
        await unlink(stagePath);
        retained = false;
      } catch { /* Uncertain ownership: retain, never unlink by pathname alone. */ }
    }
    const refusal = new StorageError(
      'ERR_STORAGE_REGISTRY_UNAVAILABLE',
      `Failed to persist registry: ${error.message}`,
      retained ? { registryStageRetained: true } : undefined,
    );
    refusal.cause = error;
    throw refusal;
  }
}

/**
 * Run a lifecycle hook, wrapping injected failures in a phase-tagged stable
 * error code. Cleanup is handled by the surrounding transaction finally.
 *
 * @param {StorageHooks} hooks
 * @param {string} phase
 * @param {{ operation: string, relativePath: string, kind: string, id: string, digest: string | undefined }} context
 * @returns {Promise<void>}
 */
async function runHook(hooks, phase, context) {
  const hook = hooks[phase];
  if (typeof hook !== 'function') return;
  try {
    await hook(context);
  } catch (error) {
    throw new StorageError(
      'ERR_STORAGE_HOOK_ABORT',
      `Hook ${phase} aborted the ${context.operation} transaction for ${context.relativePath}: ${error.message}`,
      {
        phase,
        operation: context.operation,
        relativePath: context.relativePath,
        injectedMessage: error.message,
      },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Root-wide exclusive lock (never stolen)                             */
/* ------------------------------------------------------------------ */

/**
 * @typedef {{ token: string, depth: number, receipt: { stat: import('node:fs').BigIntStats, bytes: Buffer } }} LockState
 */

/** @type {Map<string, LockState>} cross-instance coordination per real root */
const rootLocks = new Map();

/**
 * @param {{ absRoot: string, rootToken: string, realRoot: string }} state
 * @param {string} lockPath
 * @returns {Promise<() => Promise<void>>} release function
 */
async function acquireRootLock({ rootToken, realRoot }, lockPath) {
  const lockKey = casefoldPath(realRoot);
  const existing = rootLocks.get(lockKey);
  if (existing !== undefined) {
    if (existing.token !== rootToken) {
      throw new StorageError(
        'ERR_STORAGE_LOCK_CONFLICT',
        'Storage root is locked by another container in this process',
      );
    }
    // Nested re-entrancy for the same storage container (same writer).
    existing.depth += 1;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      existing.depth -= 1;
      if (existing.depth === 0) {
        rootLocks.delete(lockKey);
      }
    };
  }
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o644);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new StorageError(
        'ERR_STORAGE_LOCK_CONFLICT',
        `Storage root lock is held by another writer: ${lockPath} (no lock stealing; interrupted writer must be reconciled explicitly)`,
        { lockPath },
      );
    }
    throw new StorageError(
      'ERR_STORAGE_LOCK_UNAVAILABLE',
      `Cannot acquire storage lock ${lockPath}: ${error.message}`,
    );
  }
  let lockReceipt;
  try {
    const tokenDoc = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      token: rootToken,
      pid: process.pid,
    });
    const bytes = Buffer.from(`${tokenDoc}\n`, 'utf8');
    await handle.writeFile(bytes);
    lockReceipt = { stat: await handle.stat({ bigint: true }), bytes };
  } finally {
    await handle.close();
  }
  rootLocks.set(lockKey, { token: rootToken, depth: 1, receipt: lockReceipt });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    rootLocks.delete(lockKey);
    try {
      const proof = await registryFileProof(lockPath, lockReceipt);
      const doc = JSON.parse(proof.bytes.toString('utf8'));
      if (doc && doc.token === rootToken) {
        await unlink(lockPath).catch(() => {});
      }
      // Mismatch means the file was replaced by another writer; we do not
      // unlink content we do not own (no stealing).
    } catch {
      // File already gone or unreadable: nothing to steal, nothing to do.
    }
  };
}

/* ------------------------------------------------------------------ */
/* Per-container transaction gate (async-context-scoped ownership)      */
/* ------------------------------------------------------------------ */

/**
 * @typedef {{ queue: Promise<void> }} GateScope
 */

/**
 * Serialize the container's own transaction bodies inside one process.
 *
 * Facets of the fix for the same-instance writer race (instance-token
 * equality alone is not re-entrancy):
 *  - Independent (non-nested) operations of one container run one at a time
 *    in FIFO order, so two concurrent same-instance writers can never
 *    interleave registry state, publish duplicate identities, or make a
 *    refused writer's outcome depend on timing.
 *  - A call made while causally nested inside the holder's coherent async
 *    chain (detected via AsyncLocalStorage scope propagation — e.g. an
 *    awaited nested write inside `withLock`) joins the holder: it enqueues on
 *    the *holder's* nested queue, so even sibling nested calls (e.g.
 *    `Promise.all` inside `withLock`) serialize against each other instead of
 *    racing the holder.
 *  - The holder drains its nested queue before the root-wide lock is
 *    released, so detached nested work cannot race a successor under a
 *    released lock.
 *  - Writers from another container instance or another process are still
 *    refused by the root-wide file lock (never stolen).
 *
 * @returns {{
 *   runOwned: <T>(operation: () => T | Promise<T>) => Promise<T>,
 *   quiesceNested: () => Promise<void>,
 * }}
 */
function createTransactionGate() {
  /**
   * @typedef {{
   *   children: Promise<unknown>[],
   *   childQueue: Promise<void>,
   * }} RunTicket
   */

  /** @type {AsyncLocalStorage<{ run: RunTicket }>} */
  const runScopes = new AsyncLocalStorage();
  /** @type {Promise<void>} */
  let tail = Promise.resolve();

  /**
   * Drain every nested child of the current run until quiescent. Intended to
   * be called by the holder while it still owns the outer lock. Children are
   * themselves drained before their own promises settle, so awaiting the
   * children promises transitively awaits all descendants; new children
   * appended during the drain are awaited by re-snapshotting.
   *
   * @returns {Promise<void>}
   */
  async function quiesceNested() {
    const store = runScopes.getStore();
    if (store === undefined) {
      return;
    }
    /** @type {Set<Promise<unknown>>} */
    const awaited = new Set();
    for (;;) {
      const fresh = store.run.children.filter((p) => !awaited.has(p));
      if (fresh.length === 0) {
        return;
      }
      for (const child of fresh) {
        awaited.add(child);
      }
      // Observe settlement without inheriting rejections: a refused nested
      // child must not fail the holder's transaction or its release path.
      await Promise.all(fresh.map((child) => child.then(() => {}, () => {})));
    }
  }

  /**
   * @template T
   * @param {() => T | Promise<T>} operation
   * @returns {Promise<T>}
   */
  function runOwned(operation) {
    const store = runScopes.getStore();
    /** @type {RunTicket} */
    const ticket = { children: [], childQueue: Promise.resolve() };
    if (store !== undefined) {
      // Causally nested call inside the holder's coherent async chain: join
      // the holder as one of its children. Sibling nested calls (e.g. two
      // writes under Promise.all inside withLock) serialize on the holder's
      // childQueue instead of racing each other; grandchildren queue on their
      // own parent's ticket, so awaiting nested work never deadlocks.
      const parent = store.run;
      const run = parent.childQueue.then(
        () => /** @type {Promise<T> | T} */ (runScopes.run({ run: ticket }, operation)),
      );
      parent.childQueue = run.then(() => {}, () => {});
      parent.children.push(run);
      return /** @type {Promise<T>} */ (run);
    }
    // Independent call: take the next FIFO slot of the container-wide tail.
    const started = tail.then(
      () => /** @type {Promise<T> | T} */ (runScopes.run({ run: ticket }, operation)),
    );
    tail = started.then(() => {}, () => {});
    return /** @type {Promise<T>} */ (started);
  }

  return { runOwned, quiesceNested };
}

/* ------------------------------------------------------------------ */
/* Storage container                                                   */
/* ------------------------------------------------------------------ */

/**
 * @typedef {{
 *   beforeStage?: (context: { operation: string, relativePath: string, kind: string, id: string, digest: string | undefined }) => void | Promise<void>,
 *   beforePublish?: (context: { operation: string, relativePath: string, kind: string, id: string, digest: string }) => void | Promise<void>,
 *   beforeRegister?: (context: { operation: string, relativePath: string, kind: string, id: string, digest: string }) => void | Promise<void>,
 * }} StorageHooks
 */

/**
 * @typedef {{
 *   root: string,
 *   hooks?: StorageHooks,
 * }} CreateStorageOptions
 */

/**
 * @typedef {{
 *   relativePath: string,
 *   kind: string,
 *   id: string,
 *   value: unknown,
 * }} StorageWritePayload
 */

/**
 * @typedef {{
 *   relativePath: string,
 *   kind: string,
 *   id: string,
 * }} StorageReadKey
 */

/**
 * @typedef {{
 *   kind: string,
 *   id: string,
 *   relativePath: string,
 *   digest: string,
 *   recordType: 'immutable' | 'mutable',
 *   replaced?: boolean,
 *   recovered?: boolean,
 * }} StorageOperationResult
 */

/**
 * Neutral storage container. All roots explicit; single-writer at the root.
 *
 * @param {CreateStorageOptions} options
 * @returns {{
 *   root: string,
 *   read: (key: StorageReadKey) => Promise<unknown>,
 *   createImmutable: (payload: StorageWritePayload) => Promise<StorageOperationResult>,
 *   replaceMutable: (payload: StorageWritePayload) => Promise<StorageOperationResult>,
 *   withLock: <T>(operation: () => T | Promise<T>) => Promise<T>,
 * }}
 */
export function createStorage(options) {
  if (options === null || typeof options !== 'object') {
    throw new StorageError(
      'ERR_STORAGE_ROOT_REQUIRED',
      'Storage options must be provided: { root }',
    );
  }
  if (typeof options.root !== 'string' || options.root.length === 0) {
    throw new StorageError(
      'ERR_STORAGE_ROOT_REQUIRED',
      'An explicit absolute storage root must be provided',
    );
  }
  if (!path.isAbsolute(options.root)) {
    throw new StorageError(
      'ERR_STORAGE_ROOT_NOT_ABSOLUTE',
      `Storage root must be an absolute path, received ${options.root}`,
    );
  }
  const absRoot = path.resolve(options.root);
  const rootToken = randomUUID();
  /** @type {StorageHooks} */
  const hooks = options.hooks ?? {};
  for (const [name, hook] of Object.entries(hooks)) {
    if (hook !== undefined && typeof hook !== 'function') {
      throw new StorageError(
        'ERR_STORAGE_HOOK_INVALID',
        `Hook ${name} must be a function or undefined`,
      );
    }
  }

  /** @type {string | undefined} */
  let cachedRealRoot;

  /**
   * Resolve the real root, creating it when the caller is writing. The root
   * is always re-validated against the current filesystem (no cached root is
   * trusted after external replacement); the cache only avoids recomputing.
   *
   * @param {{ create: boolean }} createOption
   * @returns {Promise<string>}
   */
  async function resolveRealRoot({ create }) {
    if (cachedRealRoot !== undefined && !create) {
      // Reads re-validate: the root may have been externally replaced (e.g.
      // deleted and recreated as a symlink/junction) since last resolution.
      const realRoot = await ensureRealRoot(absRoot, { create: false });
      cachedRealRoot = realRoot;
      return realRoot;
    }
    const realRoot = await ensureRealRoot(absRoot, { create });
    cachedRealRoot = realRoot;
    return realRoot;
  }

  /**
   * Resolve the registry path and the internal storage directory.
   *
   * @param {string} realRoot
   * @returns {Promise<{ registryPath: string, storageDir: string }>}
   */
  async function resolveInternalPaths(realRoot, { create }) {
    const storageDir = path.join(realRoot, REGISTRY_DIRNAME);
    let st;
    try {
      st = await lstat(storageDir);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new StorageError(
          'ERR_STORAGE_REGISTRY_UNAVAILABLE',
          `Cannot inspect ${storageDir}: ${error.message}`,
        );
      }
      st = undefined;
    }
    if (st === undefined) {
      if (create) {
        try {
          await mkdir(storageDir, { recursive: false });
        } catch (mkError) {
          if (mkError.code !== 'EEXIST') {
            throw new StorageError(
              'ERR_STORAGE_REGISTRY_UNAVAILABLE',
              `Cannot create ${storageDir}: ${mkError.message}`,
            );
          }
        }
        st = await lstat(storageDir);
      }
    }
    if (st !== undefined) {
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new StorageError(
          'ERR_STORAGE_LINKED_OR_NON_DIRECTORY',
          `Internal storage namespace ${storageDir} must be an owned directory`,
        );
      }
      const real = await realpath(storageDir);
      if (casefoldPath(real) !== casefoldPath(storageDir)) {
        throw new StorageError(
          'ERR_STORAGE_LINKED_OR_NON_DIRECTORY',
          `Internal storage namespace ${storageDir} resolves through a link`,
        );
      }
    }
    return {
      registryPath: path.join(storageDir, REGISTRY_FILENAME),
      storageDir,
    };
  }

  const gate = createTransactionGate();

  /**
   * Run one locked, registry-authoritative transaction under the container's
   * transaction gate while holding the root-wide exclusive file lock for the
   * whole duration. Causally nested same-container operations join this
   * holder; independent concurrent same-container operations are serialized
   * in FIFO order; writers from another container instance or another
   * process are refused by the file lock, which is never stolen.
   *
   * @template T
   * @param {() => Promise<T>} lockedOperation body that runs under the lock
   * @returns {Promise<T>}
   */
  async function runOwnedTransaction(lockedOperation) {
    return gate.runOwned(async () => {
      const release = await acquire({ create: true });
      let result;
      try {
        result = await lockedOperation();
      } finally {
        // Drain causally nested transactions BEFORE releasing, so detached
        // nested work can never race a successor under a released lock.
        await gate.quiesceNested();
        await release();
      }
      return result;
    });
  }

  /**
   * Acquire the root-wide exclusive lock for this container.
   *
   * @param {{ create?: boolean }} createOption whether writes may create root
   * @returns {Promise<() => Promise<void>>} release
   */
  async function acquire({ create = true } = {}) {
    const realRoot = await resolveRealRoot({ create });
    const { storageDir } = await resolveInternalPaths(realRoot, { create });
    return acquireRootLock({ rootToken, realRoot }, path.join(storageDir, LOCK_FILENAME));
  }

  /**
   * Run an operation while holding the root-wide exclusive lock. Locks are
   * never stolen; concurrent writers on the same root are refused. Operated
   * under the container's transaction gate: independent concurrent calls are
   * serialized in FIFO order, and causally nested same-container calls join
   * the holder instead of racing it.
   *
   * @template T
   * @param {() => T | Promise<T>} operation
   * @returns {Promise<T>}
   */
  async function withLock(operation) {
    if (typeof operation !== 'function') {
      throw new StorageError(
        'ERR_STORAGE_LOCK_OPERATION_REQUIRED',
        'withLock(operation) requires an operation function',
      );
    }
    return runOwnedTransaction(operation);
  }

  /**
   * @param {StorageReadKey} key
   * @returns {Promise<unknown>}
   */
  async function read(key) {
    if (key === null || typeof key !== 'object') {
      throw new StorageError(
        'ERR_STORAGE_IDENTITY_INVALID_REQUEST',
        'read(key) requires { relativePath, kind, id }',
      );
    }
    const relativePath = validateRelativePath(key.relativePath);
    assertKind(key.kind);
    assertId(key.id);
    const realRoot = await resolveRealRoot({ create: false });
    const parentDirectory = await ensureParentDirectory(realRoot, relativePath, { create: false });
    const basename = relativePath.split('/').slice(-1)[0];
    const target = path.join(parentDirectory, basename);
    const { st } = await lstatRecord(parentDirectory, basename);
    if (st === undefined) {
      throw new StorageError(
        'ERR_STORAGE_NOT_FOUND',
        `Record not found: ${relativePath}`,
      );
    }
    assertRegularFileTarget(st, target);
    const verified = await readAndVerifyRecord(target, {
      kind: key.kind,
      id: key.id,
    });
    return verified.value;
  }

  /**
   * @param {StorageWritePayload} payload
   * @returns {Promise<StorageOperationResult>}
   */
  async function createImmutable(payload) {
    if (payload === null || typeof payload !== 'object') {
      throw new StorageError(
        'ERR_STORAGE_IDENTITY_INVALID_REQUEST',
        'createImmutable(payload) requires { relativePath, kind, id, value }',
      );
    }
    assertKind(payload.kind);
    assertId(payload.id);
    assertJsonValue(payload.value);
    const relativePath = validateRelativePath(payload.relativePath);
    const { bytes, digest } = buildEnvelopeBytes(
      payload.kind,
      payload.id,
      payload.value,
    );
    return runOwnedTransaction(async () => {
      const realRoot = await resolveRealRoot({ create: true });
      const { registryPath, storageDir } = await resolveInternalPaths(realRoot, { create: true });
      const parentDirectory = await ensureParentDirectory(realRoot, relativePath, { create: true });
      const basename = relativePath.split('/').slice(-1)[0];
      const target = path.join(parentDirectory, basename);
      const registry = await loadRegistry(registryPath);
      const records = registry === undefined ? {} : registry.records;
      const key = identityKey(payload.kind, payload.id);
      const existingEntry = records[key];
      let pendingRecovery = false;
      if (existingEntry !== undefined) {
        if (existingEntry.pending === true) {
          // Bound reservation from an interrupted publication: the identity
          // is claimed until an identical-byte reconciliation at the
          // reserved path completes it. Nothing else can claim it meanwhile,
          // here or at another location. Recovery never converts the record
          // type: a pending mutable reservation reconciles through
          // replaceMutable, so an immutable attempt over it is refused.
          if (existingEntry.relativePath !== relativePath) {
            throw new StorageError(
              'ERR_STORAGE_DUPLICATE_IDENTITY',
              `Identity ${payload.kind}/${payload.id} is reserved for interrupted-publication recovery at ${existingEntry.relativePath}; refusing creation at ${relativePath}`,
              {
                kind: payload.kind,
                id: payload.id,
                reservedRelativePath: existingEntry.relativePath,
                relativePath,
                pendingRegistration: true,
              },
            );
          }
          if (
            typeof existingEntry.digest !== 'string' ||
            !HEX_DIGEST_RE.test(existingEntry.digest)
          ) {
            throw new StorageError(
              'ERR_STORAGE_REGISTRY_CORRUPT',
              `Registry entry shape invalid for ${key}`,
            );
          }
          if (
            existingEntry.recordType !== 'immutable' &&
            existingEntry.recordType !== 'mutable'
          ) {
            throw new StorageError(
              'ERR_STORAGE_REGISTRY_CORRUPT',
              `Registry reservation recordType invalid for ${key}`,
            );
          }
          if (existingEntry.recordType === 'mutable') {
            // Type conversion over a pending mutable reservation is refused;
            // the identity reconciles only through the identical-byte
            // replaceMutable retry that reserved it.
            throw new StorageError(
              'ERR_STORAGE_TYPE_CONFLICT',
              `Identity ${payload.kind}/${payload.id} is reserved as a pending MUTABLE record at ${relativePath}; refusing immutable creation over it (recovery requires an identical replaceMutable retry)`,
              {
                kind: payload.kind,
                id: payload.id,
                relativePath,
                reservedDigest: existingEntry.digest,
                reservedRecordType: existingEntry.recordType,
                pendingRegistration: true,
              },
            );
          }
          if (existingEntry.digest !== digest) {
            throw new StorageError(
              'ERR_STORAGE_DUPLICATE_IDENTITY',
              `Identity ${payload.kind}/${payload.id} is reserved for interrupted-publication recovery with different bytes at ${relativePath}; refusing overwrite (recovery requires identical bytes)`,
              {
                kind: payload.kind,
                id: payload.id,
                relativePath,
                reservedDigest: existingEntry.digest,
                preparedDigest: digest,
                pendingRegistration: true,
              },
            );
          }
          pendingRecovery = true;
        } else {
          if (existingEntry.relativePath !== relativePath) {
            throw new StorageError(
              'ERR_STORAGE_DUPLICATE_IDENTITY',
              `Identity ${payload.kind}/${payload.id} is already registered at ${existingEntry.relativePath}`,
              {
                kind: payload.kind,
                id: payload.id,
                registeredRelativePath: existingEntry.relativePath,
              },
            );
          }
          throw new StorageError(
            'ERR_STORAGE_DUPLICATE_IDENTITY',
            `Identity ${payload.kind}/${payload.id} is already registered at ${relativePath}`,
            {
              kind: payload.kind,
              id: payload.id,
              registeredRelativePath: relativePath,
            },
          );
        }
      }
      // Case-ambiguity/path booking: no other identity may own this location.
      const foldedTarget = casefoldPath(relativePath);
      for (const otherKey of Object.keys(records)) {
        if (otherKey === key) continue;
        const other = records[otherKey];
        if (casefoldPath(other.relativePath) === foldedTarget) {
          throw new StorageError(
            'ERR_STORAGE_PATH_CONFLICT',
            `Record path ${relativePath} is already booked by identity ${JSON.stringify(otherKey)} under case-equivalent path ${other.relativePath}`,
          );
        }
      }
      const { st } = await lstatRecord(parentDirectory, basename);
      if (st !== undefined) {
        // Reconcile an interrupted createImmutable that published but never
        // registered. Only identical bytes with matching identity recover.
        assertRegularFileTarget(st, target);
        const previous = await readAndVerifyRecord(target, {
          kind: payload.kind,
          id: payload.id,
        });
        if (previous.digest !== digest) {
          throw new StorageError(
            'ERR_STORAGE_TARGET_EXISTS',
            `Record target exists with different bytes; refusing overwrite: ${target}`,
            { target: relativePath },
          );
        }
        // Same identity, same bytes: complete the interrupted registration.
        records[key] = {
          relativePath,
          digest,
          recordType: 'immutable',
        };
        await saveRegistry(storageDir, registryPath, records);
        return {
          kind: payload.kind,
          id: payload.id,
          relativePath,
          digest,
          recordType: 'immutable',
          recovered: true,
        };
      }
      if (typeof hooks.beforeStage === 'function') {
        await runHook(hooks, 'beforeStage', {
          operation: 'createImmutable',
          relativePath,
          kind: payload.kind,
          id: payload.id,
          digest: undefined,
        });
      }
      const stageName = `.${basename}${STAGE_INFIX}${randomUUID()}${STAGE_SUFFIX}`;
      const stagePath = path.join(parentDirectory, stageName);
      let stageVerified = false;
      try {
        const handle = await open(stagePath, 'wx', 0o644);
        try {
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
        // Verify the staged bytes are complete and correctly bound before
        // publishing.
        const stagedBytes = await readFile(stagePath);
        const verified = verifyEnvelopeBytes(stagedBytes);
        if (
          verified.kind !== payload.kind ||
          verified.id !== payload.id ||
          verified.digest !== digest
        ) {
          throw new StorageError(
            'ERR_STORAGE_STAGE_VERIFY_FAILED',
            `Staged bytes do not verify for ${relativePath}`,
          );
        }
        stageVerified = true;
        if (!pendingRecovery) {
          // Bound identity reservation BEFORE any byte publication: an
          // interruption after this point leaves the identity reserved for
          // explicit recovery; the same identity at any other location, or
          // through the mutable API, is refused until the reservation is
          // reconciled with identical bytes at the reserved path.
          records[key] = {
            relativePath,
            digest,
            recordType: 'immutable',
            pending: true,
          };
          await saveRegistry(storageDir, registryPath, records);
        }
        if (typeof hooks.beforePublish === 'function') {
          await runHook(hooks, 'beforePublish', {
            operation: 'createImmutable',
            relativePath,
            kind: payload.kind,
            id: payload.id,
            digest,
          });
        }
        // Exclusive atomic publication: link fails if target appears.
        try {
          await link(stagePath, target);
        } catch (publishError) {
          if (publishError.code === 'EEXIST') {
            throw new StorageError(
              'ERR_STORAGE_TARGET_EXISTS',
              `Record target already exists; refusing overwrite: ${target}`,
              { target: relativePath },
            );
          }
          if (
            publishError.code === 'EXDEV' ||
            publishError.code === 'EPERM' ||
            publishError.code === 'EACCES'
          ) {
            throw new StorageError(
              'ERR_STORAGE_PUBLISH_UNSUPPORTED',
              `Cross-volume or restricted publication is unsupported: ${publishError.message}`,
            );
          }
          throw new StorageError(
            'ERR_STORAGE_PUBLISH_FAILED',
            `Failed to publish immutable record: ${publishError.message}`,
          );
        }
        await unlink(stagePath).catch(() => {});
        stageVerified = false;
        if (typeof hooks.beforeRegister === 'function') {
          await runHook(hooks, 'beforeRegister', {
            operation: 'createImmutable',
            relativePath,
            kind: payload.kind,
            id: payload.id,
            digest,
          });
        }
        records[key] = {
          relativePath,
          digest,
          recordType: 'immutable',
        };
        await saveRegistry(storageDir, registryPath, records);
        const result = {
          kind: payload.kind,
          id: payload.id,
          relativePath,
          digest,
          recordType: 'immutable',
        };
        if (pendingRecovery) {
          result.recovered = true;
        }
        return result;
      } finally {
        // Clean only this transaction's own staging scratch. After a
        // successful publication the stage is already unlinked; this is a
        // no-op then (ENOENT ignored).
        await unlink(stagePath).catch(() => {});
      }
    });
  }

  /**
   * @param {StorageWritePayload} payload
   * @returns {Promise<StorageOperationResult>}
   */
  async function replaceMutable(payload) {
    if (payload === null || typeof payload !== 'object') {
      throw new StorageError(
        'ERR_STORAGE_IDENTITY_INVALID_REQUEST',
        'replaceMutable(payload) requires { relativePath, kind, id, value }',
      );
    }
    assertKind(payload.kind);
    assertId(payload.id);
    assertJsonValue(payload.value);
    const relativePath = validateRelativePath(payload.relativePath);
    const { bytes, digest } = buildEnvelopeBytes(
      payload.kind,
      payload.id,
      payload.value,
    );
    return runOwnedTransaction(async () => {
      const realRoot = await resolveRealRoot({ create: true });
      const { registryPath, storageDir } = await resolveInternalPaths(realRoot, { create: true });
      const parentDirectory = await ensureParentDirectory(realRoot, relativePath, { create: true });
      const basename = relativePath.split('/').slice(-1)[0];
      const target = path.join(parentDirectory, basename);
      const registry = await loadRegistry(registryPath);
      const records = registry === undefined ? {} : registry.records;
      const key = identityKey(payload.kind, payload.id);
      const existingEntry = records[key];
      let pendingRecordType;
      if (existingEntry !== undefined) {
        if (existingEntry.pending === true) {
          // Bound reservation from an interrupted publication (immutable or
          // first-time mutable). The reserved record type is fixed: recovery
          // is type-preserving. A mutable replacement over an immutable
          // reservation is refused below, exactly like a registered
          // immutable record; a pending MUTABLE reservation is the recovery
          // state of an interrupted first-time publication and completes
          // here with identical bytes only.
          if (existingEntry.relativePath !== relativePath) {
            throw new StorageError(
              'ERR_STORAGE_DUPLICATE_IDENTITY',
              `Identity ${payload.kind}/${payload.id} is reserved for interrupted-publication recovery at ${existingEntry.relativePath}; refusing replacement at ${relativePath}`,
              {
                kind: payload.kind,
                id: payload.id,
                reservedRelativePath: existingEntry.relativePath,
                relativePath,
                pendingRegistration: true,
              },
            );
          }
          if (
            existingEntry.recordType !== 'immutable' &&
            existingEntry.recordType !== 'mutable'
          ) {
            throw new StorageError(
              'ERR_STORAGE_REGISTRY_CORRUPT',
              `Registry reservation recordType invalid for ${key}`,
            );
          }
          if (existingEntry.recordType === 'mutable') {
            // Recovery contract: an identical-byte retry. A different value
            // would replace the interrupted identity's bound content before
            // it was ever registered.
            if (existingEntry.digest !== digest) {
              throw new StorageError(
                'ERR_STORAGE_DUPLICATE_IDENTITY',
                `Identity ${payload.kind}/${payload.id} is reserved for interrupted-first-publication recovery with different bytes at ${relativePath}; refusing replacement (recovery requires identical bytes)`,
                {
                  kind: payload.kind,
                  id: payload.id,
                  relativePath,
                  reservedDigest: existingEntry.digest,
                  preparedDigest: digest,
                  pendingRegistration: true,
                },
              );
            }
          }
          pendingRecordType = existingEntry.recordType;
        } else {
          if (existingEntry.relativePath !== relativePath) {
            throw new StorageError(
              'ERR_STORAGE_IDENTITY_LOCATION_CONFLICT',
              `Identity ${payload.kind}/${payload.id} is registered at ${existingEntry.relativePath}; refusing replacement at ${relativePath}`,
              {
                kind: payload.kind,
                id: payload.id,
                registeredRelativePath: existingEntry.relativePath,
              },
            );
          }
          if (existingEntry.recordType === 'immutable') {
            // Registered immutable records are never replaced or
            // type-converted through the mutable API: the original bytes,
            // identity binding and registry entry are preserved untouched.
            throw new StorageError(
              'ERR_STORAGE_IMMUTABLE_REPLACEMENT',
              `Immutable record ${payload.kind}/${payload.id} at ${relativePath} cannot be replaced through replaceMutable`,
              {
                kind: payload.kind,
                id: payload.id,
                relativePath,
                registeredDigest: existingEntry.digest,
              },
            );
          }
        }
      }
      const foldedTarget = casefoldPath(relativePath);
      for (const otherKey of Object.keys(records)) {
        if (otherKey === key) continue;
        const other = records[otherKey];
        if (casefoldPath(other.relativePath) === foldedTarget) {
          throw new StorageError(
            'ERR_STORAGE_PATH_CONFLICT',
            `Record path ${relativePath} is already booked by identity ${otherKey} under case-equivalent path ${other.relativePath}`,
          );
        }
      }
      const { st } = await lstatRecord(parentDirectory, basename);
      if (st !== undefined) {
        assertRegularFileTarget(st, target);
        const previous = await readAndVerifyRecord(target, {
          kind: payload.kind,
          id: payload.id,
        });
        if (pendingRecordType === 'mutable') {
          // Type-preserving recovery (SOTA1 F4) of an interrupted first-time
          // mutable publication: the bytes on disk must be exactly the
          // reserved bytes; identical content needs no republish, the
          // registration below finalizes the identity AS MUTABLE. Anything
          // else at the target fails closed (no overwrite, no conversion).
          if (previous.digest !== digest) {
            throw new StorageError(
              'ERR_STORAGE_TARGET_EXISTS',
              `Record target does not hold the reserved recovery bytes; refusing overwrite: ${target}`,
              {
                target: relativePath,
                reservedDigest: existingEntry.digest,
                publishedDigest: previous.digest,
                pendingRegistration: true,
              },
            );
          }
          records[key] = {
            relativePath,
            digest,
            recordType: 'mutable',
          };
          await saveRegistry(storageDir, registryPath, records);
          return {
            kind: payload.kind,
            id: payload.id,
            relativePath,
            digest,
            recordType: 'mutable',
            replaced: false,
            recovered: true,
          };
        }
        if (pendingRecordType === 'immutable' || existingEntry === undefined) {
          // Conservative rejection (C1 T6): reserved-or-unregistered immutable
          // bytes occupy the target. The mutable API never overwrites or
          // type-converts them — no mutable overwrite is inferred from an
          // absent or pending registry — so recovery stays explicit:
          // reconcile through createImmutable with identical bytes at the
          // reserved path. Corrupt, digest-mismatched or foreign-identity
          // bytes above already failed closed.
          throw new StorageError(
            'ERR_STORAGE_IMMUTABLE_REPLACEMENT',
            `Unregistered immutable publication occupies ${relativePath} for ${payload.kind}/${payload.id}; refusing mutable overwrite (reconcile via createImmutable with identical bytes)`,
            {
              kind: payload.kind,
              id: payload.id,
              relativePath,
              publishedDigest: previous.digest,
              pendingRegistration: pendingRecordType === 'immutable',
            },
          );
        }
        // If the registry carries a stale digest from an interrupted earlier
        // replacement (publication succeeded, registration did not), the
        // integrity-verified, identity-bound file bytes are authoritative and
        // the registry heals when this transaction re-registers. No refusal
        // is issued for a digest that only the local registry holds stale.
      } else {
        if (pendingRecordType === 'immutable') {
          throw new StorageError(
            'ERR_STORAGE_DUPLICATE_IDENTITY',
            `Identity ${payload.kind}/${payload.id} is reserved for interrupted-publication recovery at ${relativePath}; refusing mutable replacement before reconciliation`,
            {
              kind: payload.kind,
              id: payload.id,
              relativePath,
              reservedDigest: existingEntry.digest,
              pendingRegistration: true,
            },
          );
        }
        if (existingEntry !== undefined && pendingRecordType === undefined) {
          // Registered identity with no file: conservative refusal (state
          // inconsistent, recoverable only by regenerating the record). A
          // pending mutable reservation (pendingRecordType === 'mutable')
          // falls through instead: its bytes were never published, so this
          // transaction republishes the reserved identical bytes and
          // finalizes as mutable.
          throw new StorageError(
            'ERR_STORAGE_RECORD_MISSING',
            `Identity ${payload.kind}/${payload.id} is registered but no record exists at ${relativePath}`,
          );
        }
        // Fresh first-time publication (no entry): the bound pending mutable
        // reservation is written below, after stage verification and before
        // any byte publication, exactly like the immutable reservation.
      }
      if (typeof hooks.beforeStage === 'function') {
        await runHook(hooks, 'beforeStage', {
          operation: 'replaceMutable',
          relativePath,
          kind: payload.kind,
          id: payload.id,
          digest: undefined,
        });
      }
      const stageName = `.${basename}${STAGE_INFIX}${randomUUID()}${STAGE_SUFFIX}`;
      const stagePath = path.join(parentDirectory, stageName);
      let stageVerified = false;
      try {
        const handle = await open(stagePath, 'wx', 0o644);
        try {
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
        const stagedBytes = await readFile(stagePath);
        const verified = verifyEnvelopeBytes(stagedBytes);
        if (
          verified.kind !== payload.kind ||
          verified.id !== payload.id ||
          verified.digest !== digest
        ) {
          throw new StorageError(
            'ERR_STORAGE_STAGE_VERIFY_FAILED',
            `Staged bytes do not verify for ${relativePath}`,
          );
        }
        stageVerified = true;
        if (existingEntry === undefined) {
          // Bound identity reservation BEFORE any byte publication of a
          // first-time mutable record (SOTA1 F4): an interruption after this
          // point leaves the identity reserved AS MUTABLE for explicit
          // recovery; the same identity at any other location, with
          // different bytes, or through the immutable API is refused until
          // the identical-byte replaceMutable retry finalizes the
          // reservation as a mutable registration.
          records[key] = {
            relativePath,
            digest,
            recordType: 'mutable',
            pending: true,
          };
          await saveRegistry(storageDir, registryPath, records);
        }
        if (typeof hooks.beforePublish === 'function') {
          await runHook(hooks, 'beforePublish', {
            operation: 'replaceMutable',
            relativePath,
            kind: payload.kind,
            id: payload.id,
            digest,
          });
        }
        // Atomic same-directory rename replaces the existing file.
        try {
          await rename(stagePath, target);
        } catch (renameError) {
          if (renameError.code === 'EPERM' || renameError.code === 'EACCES') {
            throw new StorageError(
              'ERR_STORAGE_PUBLISH_UNSUPPORTED',
              `Restricted publication is unsupported: ${renameError.message}`,
            );
          }
          throw new StorageError(
            'ERR_STORAGE_PUBLISH_FAILED',
            `Failed to replace mutable record: ${renameError.message}`,
          );
        }
        stageVerified = false;
        if (typeof hooks.beforeRegister === 'function') {
          await runHook(hooks, 'beforeRegister', {
            operation: 'replaceMutable',
            relativePath,
            kind: payload.kind,
            id: payload.id,
            digest,
          });
        }
        // Final registration always records this identity as mutable; a
        // pending first-publication reservation is completed, never
        // converted, and a registered-mutable replacement re-registers.
        records[key] = {
          relativePath,
          digest,
          recordType: 'mutable',
        };
        await saveRegistry(storageDir, registryPath, records);
        const result = {
          kind: payload.kind,
          id: payload.id,
          relativePath,
          digest,
          recordType: 'mutable',
          replaced: st !== undefined,
        };
        if (existingEntry !== undefined && existingEntry.pending === true) {
          result.recovered = true;
        }
        return result;
      } finally {
        await unlink(stagePath).catch(() => {});
      }
    });
  }

  return {
    root: absRoot,
    read,
    createImmutable,
    replaceMutable,
    withLock,
  };
}
