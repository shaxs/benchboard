/**
 * BenchBoard core identity primitives (C1 / T1).
 *
 * Harness-neutral ES module: imports Node builtins only. No configuration
 * lookup, no owner-root or user-directory resolution, no network access, and no
 * import of the historical `runner/` surface or of any DSH module.
 *
 * Hash compatibility contract (the BenchBoard workload hash, as documented by
 * the neutral architecture's identity section):
 *   POSIX relative paths sorted lexically, pairs `[path, sha256(bytes)]`,
 *   SHA-256 over the JSON serialisation of those pairs. No newline or encoding
 *   normalisation. This is the algorithm of the preserved `runner/files.mjs`
 *   tree helper, reproduced here without importing it, so workload hashes stay
 *   comparable across the migration.
 *
 * Lineage stays separate: nothing here conflates tooling identity with
 * challenge/candidate identity. Callers hash the bytes they are given.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable identifier of the hash algorithm reproduced by this module. */
export const HASH_ALGORITHM_ID = 'benchboard-sha256-tree-v1';

/** Default directory names that are never entered (preserved behaviour). */
export const DEFAULT_SKIP_NAMES = Object.freeze(['node_modules', 'dist', '.git']);

const PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;
const MAX_PREFIX_LENGTH = 40;
const MAX_ID_LENGTH = 128;
const RANDOM_BYTES = 16;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * SHA-256 of raw bytes, lowercase hex. Bytes are hashed verbatim: no newline,
 * encoding or line-ending normalisation is applied.
 *
 * @param {string | ArrayBuffer | ArrayBufferView | ReadonlyArray<number>} bytes
 * @returns {string} 64 lowercase hex characters
 */
export function sha256(bytes) {
  if (typeof bytes === 'string') return hash().update(bytes, 'utf8').digest('hex');
  if (bytes instanceof ArrayBuffer) return hash().update(new Uint8Array(bytes)).digest('hex');
  if (ArrayBuffer.isView(bytes)) return hash().update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest('hex');
  if (Array.isArray(bytes)) return hash().update(Uint8Array.from(bytes)).digest('hex');
  throw TypeError('sha256(bytes): bytes must be a string, Buffer, ArrayBuffer, typed array or byte array.');
}

/**
 * Digest a set of entries exactly as the preserved tree algorithm does.
 *
 * Accepts `{ path, sha256 }` pairs — the `bytes` field of an inventory entry is
 * deliberately not part of the hash pair — or bare `[path, digest]` pairs.
 * Paths must be exact relative POSIX file paths. Entries are ordered by raw
 * lexical comparison before serialisation; no field is added and no path or
 * digest is normalised.
 *
 * @param {ReadonlyArray<IdentityHashInputEntry>} entries
 * @returns {string} SHA-256 hex of `JSON.stringify(sorted [path, sha256])`
 */
export function hashEntries(entries) {
  if (!Array.isArray(entries)) throw TypeError('hashEntries(entries): entries must be an array.');
  const pairs = [];
  const seen = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const isPair = Array.isArray(entry);
    if (entry === null || (typeof entry !== 'object' && !isPair)) {
      throw TypeError(`hashEntries(entries): entry at index ${index} must be an object or a [path, sha256] pair.`);
    }
    const relativePath = isPair ? entry[0] : entry.path;
    const digest = isPair ? entry[1] : entry.sha256;
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      throw TypeError(`hashEntries(entries): entry at index ${index} needs a non-empty string path.`);
    }
    if (typeof digest !== 'string' || !HEX64.test(digest)) {
      throw TypeError(`hashEntries(entries): entry "${relativePath}" needs a 64-character lowercase hex sha256.`);
    }
    // A path spelling outside the exact relative POSIX domain (backslash,
    // drive colon, C0/DEL control bytes, traversal, redundant segments,
    // absolute forms) is refused by the hash step under the same rule the
    // record validators and the companion JSON Schemas enforce (one exact
    // path definition).
    if (!isExactRelativePosixPath(relativePath)) {
      throw TypeError(`hashEntries(entries): entry path "${relativePath}" is not an exact relative POSIX file path.`);
    }
    const previous = seen.get(relativePath);
    if (previous !== void 0) {
      throw Error(previous === digest
        ? `hashEntries(entries): duplicate path "${relativePath}".`
        : `hashEntries(entries): conflicting digests for path "${relativePath}".`);
    }
    seen.set(relativePath, digest);
    pairs.push([relativePath, digest]);
  }
  pairs.sort(compareLexical);
  return sha256(JSON.stringify(pairs));
}

/**
 * Walk a root and produce the canonical file inventory and tree digest.
 *
 * Traversal semantics are byte-identical to the preserved tree helper: the
 * root itself must not be a link, entry links are rejected, so is every special
 * (non regular file) entry, the documented skip names are not entered, relative
 * paths use POSIX separators and the entry list is sorted lexically. A root
 * whose own name is listed in `skipNames` is still walked, matching preserved
 * behaviour. An explicit absolute root is mandatory; nothing is resolved
 * against a module, repository, owner or current-directory default.
 *
 * @param {InventoryTreeOptions} options
 * @returns {InventoryTreeResult}
 */
export function inventoryTree(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw TypeError('inventoryTree({ root, skipNames }): an options object with an explicit absolute root is required.');
  }
  const unknownKeys = Object.keys(options).filter((key) => key !== 'root' && key !== 'skipNames');
  if (unknownKeys.length > 0) throw TypeError(`inventoryTree({ root, skipNames }): unknown option(s): ${unknownKeys.join(', ')}.`);
  const { root, skipNames } = options;
  const rootPath = requireAbsoluteRoot(root, 'inventoryTree({ root, skipNames }): root');
  const skip = normaliseSkipNames(skipNames);

  const rootStatus = fs.lstatSync(rootPath);
  if (rootStatus.isSymbolicLink()) throw Error(`inventoryTree: root link prohibited: ${rootPath}`);
  if (!rootStatus.isDirectory()) throw Error(`inventoryTree: root must be a directory: ${rootPath}`);
  assertNoLinkAncestor(rootPath);

  const entries = [];
  const foldOwners = new Map();
  const foldRoot = foldCase(rootPath);
  walkDirectory(rootPath, rootPath, skip, entries, foldOwners, foldRoot);
  entries.sort((a, b) => compareLexical(a.path, b.path));

  return Object.freeze({
    root: toDisplayPath(rootPath),
    hashAlgorithmId: HASH_ALGORITHM_ID,
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    digest: hashEntries(entries),
  });
}

/**
 * Create a unique random identifier. IDs are never derived from a folder name,
 * a path, a timestamp or any other caller-visible material.
 *
 * @param {createIdOptions | string} [options] `{ prefix }` or the prefix string
 * @returns {string} `<prefix>-<16 random bytes as hex>`, or bare hex with no prefix
 */
export function createId(options) {
  let prefix = '';
  if (options === void 0 || options === null) prefix = '';
  else if (typeof options === 'string') prefix = options;
  else if (typeof options === 'object' && !Array.isArray(options)) {
    const unknownKeys = Object.keys(options).filter((key) => key !== 'prefix');
    if (unknownKeys.length > 0) throw TypeError(`createId({ prefix }): unknown option(s): ${unknownKeys.join(', ')}.`);
    prefix = options.prefix === void 0 || options.prefix === null ? '' : options.prefix;
  } else throw TypeError('createId({ prefix }): options must be an object or a prefix string.');

  if (typeof prefix !== 'string') throw TypeError('createId({ prefix }): prefix must be a string.');
  if (prefix.length > MAX_PREFIX_LENGTH) {
    throw RangeError(`createId({ prefix }): prefix must be at most ${MAX_PREFIX_LENGTH} characters, got ${prefix.length}.`);
  }
  if (prefix.length > 0 && !PREFIX_PATTERN.test(prefix)) {
    throw TypeError(`createId({ prefix }): prefix "${prefix}" must match ${PREFIX_PATTERN.source}.`);
  }
  const suffix = crypto.randomBytes(RANDOM_BYTES).toString('hex');
  const id = prefix.length > 0 ? `${prefix}-${suffix}` : suffix;
  if (id.length > MAX_ID_LENGTH) throw RangeError(`createId({ prefix }): the generated id exceeds ${MAX_ID_LENGTH} characters.`);
  return id;
}

function hash() {
  return crypto.createHash('sha256');
}

function walkDirectory(directory, rootPath, skip, entries, foldOwners, foldRoot) {
  for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
    if (skip.has(dirent.name)) continue;
    const absolute = path.join(directory, dirent.name);
    if (fs.lstatSync(absolute).isSymbolicLink()) throw Error(`inventoryTree: links are prohibited: ${absolute}`);
    if (dirent.isDirectory()) {
      walkDirectory(absolute, rootPath, skip, entries, foldOwners, foldRoot);
      continue;
    }
    if (!dirent.isFile()) throw Error(`inventoryTree: special file prohibited: ${absolute}`);
    const relativePath = path.relative(rootPath, absolute).replaceAll('\\', '/');
    assertNoFoldCollision(foldOwners, foldRoot, relativePath, absolute);
    entries.push(Object.freeze({ path: relativePath, bytes: fs.statSync(absolute).size, sha256: sha256(fs.readFileSync(absolute)) }));
  }
}

/**
 * Reject two distinct paths that differ only by case-insensitive spelling.
 *
 * On a case-insensitive filesystem the underlying create/write would already
 * fail with `EEXIST`; this check makes the rejection deterministic and portable
 * on case-sensitive filesystems as well. It is defence in depth, not a
 * guarantee, and is why no path is ever rewritten into a folded form.
 */
function assertNoFoldCollision(foldOwners, foldRoot, relativePath, absolute) {
  const key = foldRoot + foldCase(relativePath);
  const owner = foldOwners.get(key);
  if (owner !== void 0 && owner !== relativePath) {
    throw Error(`inventoryTree: case-insensitive path collision between "${owner}" and "${relativePath}" under ${path.dirname(absolute)}.`);
  }
  foldOwners.set(key, relativePath);
}

/** Case fold used only for collision detection; never used to rewrite a path. */
function foldCase(value) {
  return value.normalize('NFD').toUpperCase().normalize('NFC');
}

function normaliseSkipNames(skipNames) {
  if (skipNames === void 0 || skipNames === null) return new Set(DEFAULT_SKIP_NAMES);
  if (skipNames instanceof Set || Array.isArray(skipNames)) {
    for (const value of skipNames) assertSkipName(value);
    return new Set(skipNames);
  }
  throw TypeError('inventoryTree({ root, skipNames }): skipNames must be an array or Set of single path segment names.');
}

function assertSkipName(value) {
  if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw TypeError(`inventoryTree({ root, skipNames }): skip names must be single path segment names, got ${JSON.stringify(value)}.`);
  }
}

/** Exact relative POSIX path: no backslash, drive colon, C0/DEL control character, absolute form, traversal, dot, empty or redundant segment. */
function isExactRelativePosixPath(value) {
  if (value.includes('\\') || value.includes(':')) return false;
  /* Every ASCII control character is refused, not only NUL: the pre-existing
   * NUL-only check silently hashed entries whose paths carried LF, Tab or DEL
   * bytes even though the exact path contract already refused them everywhere
   * else (C1 SOTA2 F1). The refusal is exhaustive over U+0000–U+001F and DEL,
   * so LF/Tab/DEL file names can no longer differ between the two checks. */
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith('/') || value === '.' || value === '..') return false;
  if (value.startsWith('./') || value.endsWith('/.') || value.includes('/./')) return false;
  if (value.startsWith('../') || value.includes('/../') || value.endsWith('/..')) return false;
  if (value.startsWith('//') || value.endsWith('/') || value.includes('//')) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** Raw lexical comparison (code-unit order), the order the digest depends on. */
function compareLexical(a, b) {
  const left = typeof a === 'string' ? a : a[0];
  const right = typeof b === 'string' ? b : b[0];
  return left < right ? -1 : left > right ? 1 : 0;
}

/** POSIX display form of an absolute root, so records never carry host separators. */
function toDisplayPath(rootPath) {
  return path.sep === '/' ? rootPath : rootPath.replaceAll('\\', '/');
}

function requireAbsoluteRoot(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw TypeError(`${label}: an explicit absolute root path string is required.`);
  }
  if (value.startsWith('\\\\?\\') || value.startsWith('//') || value.startsWith('\\\\')) {
    throw TypeError(`${label}: extended-length and UNC roots are not supported: ${value}`);
  }
  let spelling = value;
  if (spelling.startsWith('file://')) spelling = fileURLToPath(spelling);
  if (isRelativeSpelling(spelling)) {
    throw TypeError(`${label}: roots are always explicit and absolute, got the relative path ${JSON.stringify(value)}.`);
  }
  const resolved = path.resolve(spelling);
  if (!path.isAbsolute(resolved)) {
    throw TypeError(`${label}: an explicit absolute root path is required, got ${JSON.stringify(value)}.`);
  }
  return resolved;
}

/** True for any spelling that is not written as an absolute path, including drive-relative `C:dir`. */
function isRelativeSpelling(value) {
  if (value === '.' || value === '..' || value.startsWith('./') || value.startsWith('../')) return true;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  return !/^[A-Za-z]:[\\/]/.test(value) && !value.startsWith('\\\\');
}

/** Rejected because a link above the root silently re-roots every contained check. */
function assertNoLinkAncestor(rootPath) {
  let at = path.resolve(rootPath);
  for (;;) {
    if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) throw Error(`link ancestor prohibited: ${at}`);
    const parent = path.dirname(at);
    if (parent === at) return;
    at = parent;
  }
}
