/**
 * BenchBoard core path-boundary primitives (C1 / T1).
 *
 * Harness-neutral ES module: imports Node builtins only. Every filesystem
 * entry point here takes an **explicit absolute root** argument. There is no
 * module-relative, repository, owner, user-profile, configuration or
 * current-directory default, no network or registry lookup, and no import of
 * the historical `runner/` surface or of any DSH module.
 *
 * Rejected by design: traversal and otherwise malformed relative paths,
 * absolute relative paths, backslash spellings, symbolic links (including a
 * link anywhere above the root), non-regular files, case-insensitive path
 * collisions, and overlapping or duplicated roots.
 *
 * These checks are defence in depth for a cooperative harness boundary, not a
 * filesystem permission sandbox. A path that passes must still be opened by its
 * own caller without re-resolving it through a link.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Machine-readable rejection reasons; stable, additive and test-assertable. */
export const PATH_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_ROOT: 'INVALID_ROOT',
  ROOT_NOT_FOUND: 'ROOT_NOT_FOUND',
  ROOT_NOT_A_DIRECTORY: 'ROOT_NOT_A_DIRECTORY',
  ROOT_IS_FILESYSTEM_ROOT: 'ROOT_IS_FILESYSTEM_ROOT',
  INVALID_RELATIVE_PATH: 'INVALID_RELATIVE_PATH',
  OUT_OF_ROOT: 'OUT_OF_ROOT',
  LINK_ANCESTOR: 'LINK_ANCESTOR',
  SYMLINK_DETECTED: 'SYMLINK_DETECTED',
  REAL_PATH_OUT_OF_ROOT: 'REAL_PATH_OUT_OF_ROOT',
  NOT_FOUND: 'NOT_FOUND',
  NOT_A_DIRECTORY: 'NOT_A_DIRECTORY',
  NOT_REGULAR_FILE: 'NOT_REGULAR_FILE',
  CASE_COLLISION: 'CASE_COLLISION',
  DUPLICATE_ROOT: 'DUPLICATE_ROOT',
  ROOTS_OVERLAP: 'ROOTS_OVERLAP',
});

const CONTROL_CHARACTERS = /[\0-\x1F\x7F]/;
const CASE_FOLD = (value) => value.normalize('NFD').toUpperCase().normalize('NFC');

/**
 * Validate an exact relative POSIX path and return it unchanged.
 *
 * Accepted: `src/App.tsx`, `tests/contracts/a.test.mjs`, `a/b/../` is **not**
 * accepted, nor is anything absolute, drive-qualified, UNC, backslash-spelled,
 * empty, `.`/`..`, traversal-containing, `//`-containing or `/`-terminated. The
 * value is returned byte-for-byte: no separator, case, Unicode or segment
 * normalisation is applied, because downstream digests depend on exact spelling.
 *
 * @throws {PathError} code INVALID_RELATIVE_PATH
 */
export function validateRelativePath(relativePath) {
  if (typeof relativePath !== 'string') {
    throw new PathError(PATH_ERROR_CODES.INVALID_RELATIVE_PATH, `relative path must be a string, got ${describe(relativePath)}.`);
  }
  const reason = relativePathReason(relativePath);
  if (reason !== void 0) throw new PathError(PATH_ERROR_CODES.INVALID_RELATIVE_PATH, `invalid relative POSIX path ${JSON.stringify(relativePath)}: ${reason}`);
  return relativePath;
}

/**
 * Resolve a relative path inside an explicit absolute root and prove that the
 * result stays inside it.
 *
 * The root must exist and must not be — or sit under — a symbolic link. Every
 * intermediate segment is checked with `lstat` before it is entered, so a link
 * cannot be used to hop out of the root, and the fully resolved real path is
 * required to stay inside the real root as well. The final entry must be an
 * existing regular file or directory; special files are rejected. A segment
 * whose on-disk spelling differs only by case/Unicode folding is rejected, and
 * a path whose lexical spelling leaves the root is rejected even when a
 * matching file exists deeper down.
 *
 * @param {ResolveWithinRootOptions} options
 * @returns {string} absolute in-root path with host separators, unchanged spelling
 * @throws {PathError} see PATH_ERROR_CODES
 */
export function resolveWithinRoot(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new PathError(PATH_ERROR_CODES.INVALID_ARGUMENT, 'resolveWithinRoot({ root, relativePath }): an options object is required.');
  }
  const unknownKeys = Object.keys(options).filter((key) => key !== 'root' && key !== 'relativePath');
  if (unknownKeys.length > 0) throw new PathError(PATH_ERROR_CODES.INVALID_ARGUMENT, `resolveWithinRoot({ root, relativePath }): unknown option(s): ${unknownKeys.join(', ')}.`);
  const { root, relativePath } = options;
  const rootPath = requireAbsoluteRoot(root, 'resolveWithinRoot({ root, relativePath }): root');
  validateRelativePath(relativePath);

  if (isFilesystemRoot(rootPath)) {
    throw new PathError(PATH_ERROR_CODES.ROOT_IS_FILESYSTEM_ROOT, `a containment root must be a subdirectory, got the filesystem root ${JSON.stringify(root)}.`);
  }

  const rootStatus = linkFreeRoot(rootPath, root);
  const relativeAbsolute = path.resolve(rootPath, ...relativePath.split('/'));
  if (!isStrictlyInside(rootPath, relativeAbsolute)) {
    throw new PathError(PATH_ERROR_CODES.OUT_OF_ROOT, `${JSON.stringify(relativePath)} resolves to ${JSON.stringify(relativeAbsolute)} which is not strictly inside root ${JSON.stringify(root)}.`);
  }

  const realRoot = realpathOrThrow(rootPath, PATH_ERROR_CODES.ROOT_NOT_FOUND, root);
  if (pathIdentity(realRoot) !== pathIdentity(rootPath)) {
    throw new PathError(PATH_ERROR_CODES.LINK_ANCESTOR, `root ${JSON.stringify(root)} resolves to ${JSON.stringify(realRoot)} through a link above the root.`);
  }

  const segments = relativePath.split('/');
  let lexical = rootPath;
  let real = realRoot;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const candidate = path.join(lexical, segment);
    const isFinal = index === segments.length - 1;
    const status = lstatOrThrow(candidate, segment, relativePath);

    if (status.isSymbolicLink()) {
      throw new PathError(PATH_ERROR_CODES.SYMLINK_DETECTED, `${isFinal ? 'target' : 'directory component'} of ${JSON.stringify(relativePath)} is a symbolic link: ${JSON.stringify(candidate)}.`);
    }
    if (!isFinal && !status.isDirectory()) {
      throw new PathError(PATH_ERROR_CODES.NOT_A_DIRECTORY, `directory component of ${JSON.stringify(relativePath)} is not a directory: ${JSON.stringify(candidate)}.`);
    }
    if (isSpecial(status)) {
      throw new PathError(PATH_ERROR_CODES.NOT_REGULAR_FILE, `${isFinal ? 'target' : 'directory component'} of ${JSON.stringify(relativePath)} is not a regular file or directory: ${JSON.stringify(candidate)}.`);
    }

    const listed = exactChildSpelling(lexical, segment);
    if (listed !== void 0 && listed !== segment) {
      throw new PathError(PATH_ERROR_CODES.CASE_COLLISION, `${JSON.stringify(relativePath)} asks for ${JSON.stringify(segment)} but ${JSON.stringify(listed)} is the exact spelling under ${JSON.stringify(lexical)}; path spelling is never normalised.`);
    }

    real = realpathOrThrow(candidate, PATH_ERROR_CODES.NOT_FOUND, relativePath);
    if (!isStrictlyInside(realRoot, real)) {
      throw new PathError(PATH_ERROR_CODES.REAL_PATH_OUT_OF_ROOT, `${JSON.stringify(relativePath)} resolves to ${JSON.stringify(real)} which escapes the real root ${JSON.stringify(realRoot)}.`);
    }
    lexical = candidate;
  }

  void rootStatus;
  return relativeAbsolute;
}

/**
 * Assert that a set of roots is pairwise disjoint and return their display
 * forms.
 *
 * Identical roots and any root that contains another are rejected, so an
 * output root can never overwrite a source, evaluator or owner root. Comparison
 * is syntactic and performed on a separator- and case-folded namespace form on
 * the platform that separates case the way the host filesystem does; roots are
 * not stat'ed, so the check is safe for roots that do not exist yet. Because
 * case sensitivity is a mount property that cannot be queried reliably, the
 * case-insensitive comparison is the conservative choice: two spellings of the
 * same directory on a case-sensitive mount are still refused.
 *
 * @param {ReadonlyArray<RootEntry>} roots
 * @returns {ReadonlyArray<string>} one display path per input entry, in order
 * @throws {PathError} codes DUPLICATE_ROOT, ROOTS_OVERLAP, INVALID_ROOT
 */
export function assertDisjointRoots(roots) {
  if (!Array.isArray(roots)) {
    throw new PathError(PATH_ERROR_CODES.INVALID_ARGUMENT, 'assertDisjointRoots(roots): roots must be an array of root paths or { label, path } objects.');
  }
  if (roots.length === 0) {
    throw new PathError(PATH_ERROR_CODES.INVALID_ARGUMENT, 'assertDisjointRoots(roots): at least one root is required.');
  }
  const entries = roots.map((entry, index) => {
    if (typeof entry === 'string') return { label: `roots[${index}]`, value: entry };
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const value = entry.path === void 0 ? entry.root : entry.path;
      const label = typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : `roots[${index}]`;
      return { label, value };
    }
    throw new PathError(PATH_ERROR_CODES.INVALID_ROOT, `${describeRootLabel(`roots[${index}]`)} must be a path string or a { label, path } object, got ${describe(entry)}.`);
  });
  const resolved = entries.map(({ label, value }) => {
    const absolute = requireAbsoluteRoot(value, describeRootLabel(label));
    if (isFilesystemRoot(absolute)) {
      throw new PathError(PATH_ERROR_CODES.INVALID_ROOT, `${describeRootLabel(label)} must be a subdirectory, not the filesystem or volume root ${JSON.stringify(value)}.`);
    }
    return { label, display: String(value), identity: rootIdentity(absolute) };
  });

  for (let index = 0; index < resolved.length; index += 1) {
    for (let other = index + 1; other < resolved.length; other += 1) {
      const left = resolved[index];
      const right = resolved[other];
      if (left.identity === right.identity) {
        throw new PathError(PATH_ERROR_CODES.DUPLICATE_ROOT, `${describeRootLabel(left.label)} ${JSON.stringify(left.display)} and ${describeRootLabel(right.label)} ${JSON.stringify(right.display)} name the same directory.`);
      }
      if (isIdentityInside(left.identity, right.identity)) {
        throw new PathError(PATH_ERROR_CODES.ROOTS_OVERLAP, `${describeRootLabel(right.label)} ${JSON.stringify(right.display)} is inside ${describeRootLabel(left.label)} ${JSON.stringify(left.display)}.`);
      }
      if (isIdentityInside(right.identity, left.identity)) {
        throw new PathError(PATH_ERROR_CODES.ROOTS_OVERLAP, `${describeRootLabel(left.label)} ${JSON.stringify(left.display)} is inside ${describeRootLabel(right.label)} ${JSON.stringify(right.display)}.`);
      }
    }
  }
  return Object.freeze(resolved.map(({ display }) => display));
}

/** Error type carrying a stable machine code alongside the human message. */
export class PathError extends Error {
  /**
   * @param {string} code one of PATH_ERROR_CODES
   * @param {string} message
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'PathError';
    this.code = code;
  }
}

function relativePathReason(value) {
  if (value.length === 0) return 'the path is empty.';
  if (CONTROL_CHARACTERS.test(value)) return 'the path contains a control character.';
  if (value.includes('\\')) return 'backslash separators are not accepted; use POSIX "/" separators.';
  if (value.includes(':')) return 'drive- or scheme-qualified paths are not accepted.';
  if (value.startsWith('/')) return 'the path is absolute; supply it as the root instead.';
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0)) return 'the path contains an empty segment (leading, repeated or trailing "/").';
  if (segments.some((segment) => segment === '.' || segment === '..')) return 'the path contains "." or ".." segments.';
  return void 0;
}

function requireAbsoluteRoot(value, label) {
  if (typeof value !== 'string') {
    throw new PathError(PATH_ERROR_CODES.INVALID_ROOT, `${describeRootLabel(label)} must be an explicit absolute path string, got ${describe(value)}.`);
  }
  if (value.length === 0 || value.includes('\0')) {
    throw new PathError(PATH_ERROR_CODES.INVALID_ROOT, `${describeRootLabel(label)} must be a non-empty absolute path string, got ${describe(value)}.`);
  }
  let candidate = value.startsWith('file://') ? fileURLToPath(value) : value;
  if (candidate.startsWith('\\\\?\\') || candidate.startsWith('//')) {
    throw new PathError(PATH_ERROR_CODES.INVALID_ROOT, `${describeRootLabel(label)} must not use an extended-length or UNC root: ${JSON.stringify(value)}`);
  }
  if (candidate.startsWith('\\\\')) {
    throw new PathError(PATH_ERROR_CODES.INVALID_ROOT, `${describeRootLabel(label)} must not use a UNC root: ${JSON.stringify(value)}`);
  }
  if (isRelativeSpelling(candidate)) {
    throw new PathError(PATH_ERROR_CODES.INVALID_ROOT, `${describeRootLabel(label)} must be an absolute path, got the relative path ${JSON.stringify(value)}; roots are always explicit.`);
  }
  const resolved = path.resolve(candidate);
  if (!path.isAbsolute(resolved)) {
    throw new PathError(PATH_ERROR_CODES.INVALID_ROOT, `${describeRootLabel(label)} must resolve to an absolute path, got ${JSON.stringify(value)}.`);
  }
  return resolved;
}

function isRelativeSpelling(value) {
  if (value.startsWith('./') || value.startsWith('../') || value === '.' || value === '..') return true;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  return !/^[A-Za-z]:[\\/]/.test(value) && !value.startsWith('\\\\');
}

function linkFreeRoot(rootPath, display) {
  let status;
  try {
    status = fs.lstatSync(rootPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new PathError(PATH_ERROR_CODES.ROOT_NOT_FOUND, `root ${JSON.stringify(display)} does not exist.`);
    throw error;
  }
  if (status.isSymbolicLink()) throw new PathError(PATH_ERROR_CODES.SYMLINK_DETECTED, `root link prohibited: ${JSON.stringify(display)}.`);
  if (!status.isDirectory()) throw new PathError(PATH_ERROR_CODES.ROOT_NOT_A_DIRECTORY, `root must be a directory, got ${JSON.stringify(display)}.`);
  assertNoLinkAncestor(rootPath);
  return status;
}

function assertNoLinkAncestor(rootPath) {
  let at = path.resolve(rootPath);
  for (;;) {
    if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) {
      throw new PathError(PATH_ERROR_CODES.LINK_ANCESTOR, `link ancestor prohibited: ${JSON.stringify(at)} is above the requested root.`);
    }
    const parent = path.dirname(at);
    if (parent === at) return;
    at = parent;
  }
}

function lstatOrThrow(candidate, segment, relativePath) {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new PathError(PATH_ERROR_CODES.NOT_FOUND, `${JSON.stringify(relativePath)} does not exist inside the root; component ${JSON.stringify(segment)} is missing.`);
    }
    throw error;
  }
}

function realpathOrThrow(target, code, label) {
  try {
    return stripNamespace(fs.realpathSync.native(target));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new PathError(code, `${describe(label)} could not be resolved: ${error.message}`);
    throw error;
  }
}

function exactChildSpelling(directory, segment) {
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return void 0;
  }
  if (names.includes(segment)) return segment;
  const folded = CASE_FOLD(segment);
  return names.find((name) => CASE_FOLD(name) === folded);
}

/** Namespace-form identity used only for comparison, never for I/O or output. */
function pathIdentity(target) {
  const namespace = stripNamespace(target).split('\\').join('/');
  return path.sep === '/' ? namespace : namespace.toLowerCase();
}

function rootIdentity(target) {
  let identity = pathIdentity(path.resolve(target));
  const rootForm = path.parse(identity).root.split('\\').join('/');
  if (identity === rootForm) return identity;
  return identity.endsWith('/') ? identity.slice(0, -1) : identity;
}

function stripNamespace(target) {
  if (target.startsWith('\\\\?\\UNC\\')) return `\\\\${target.slice(8)}`;
  if (target.startsWith('\\\\?\\')) return target.slice(4);
  return target;
}

function isStrictlyInside(parent, child) {
  const parentForm = ensureTrailing(path.resolve(parent));
  const childForm = path.resolve(child);
  return childForm.length > parentForm.length && childForm.startsWith(parentForm);
}

function isIdentityInside(parentIdentity, childIdentity) {
  const parentForm = parentIdentity.endsWith('/') ? parentIdentity : `${parentIdentity}/`;
  return childIdentity.length > parentForm.length && childIdentity.startsWith(parentForm);
}

function ensureTrailing(value) {
  if (value.endsWith('/') || value.endsWith('\\')) return value;
  return `${value}${path.sep}`;
}

function isFilesystemRoot(candidate) {
  const resolved = path.resolve(candidate);
  const rootForm = path.parse(resolved).root;
  return rootForm !== '' && (resolved === rootForm || resolved === rootForm.slice(0, -1));
}

function isSpecial(status) {
  return !status.isFile() && !status.isDirectory();
}

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (value === void 0) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

function describeRootLabel(label) {
  return `root ${label}`;
}
