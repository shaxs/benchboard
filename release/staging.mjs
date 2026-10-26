/** Cooperative, explicit synthetic staging. Handles and errors are private local evidence. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateReleaseProfile } from './profiles.mjs';

const REPOSITORY = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const syntheticMetadata = Buffer.from('{"schemaVersion":"1.0.0","kind":"SyntheticReleaseMetadata","publicRelease":false}\n');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fold = (value) => path.resolve(value).toLowerCase();
const overlaps = (a, b) => fold(a) === fold(b) || fold(a).startsWith(fold(b) + path.sep) || fold(b).startsWith(fold(a) + path.sep);
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.birthtimeNs}`;
const physical = (value) => fs.realpathSync.native(value).replace(/^\\\\\?\\/, '');

export class ReleaseStageError extends Error {
  constructor(code, cause, retained = false) {
    super(code, { cause });
    this.name = 'ReleaseStageError';
    this.code = code;
    this.retained = retained;
  }
}
const refuse = (code = 'RELEASE_STAGE_INTEGRITY') => { throw new ReleaseStageError(code); };

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) ||
      (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(value)) ||
      value.startsWith('\\\\') || value.startsWith('//') || path.parse(value).root === path.resolve(value)) {
    refuse('RELEASE_STAGE_ROOT');
  }
  return path.resolve(value);
}

function directoryChain(directory) {
  const result = [];
  let at = directory;
  for (;;) {
    const stat = fs.lstatSync(at, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) refuse();
    result.push({ path: at, id: identity(stat) });
    const parent = path.dirname(at);
    if (parent === at) return result;
    at = parent;
  }
}

function verifyChain(chain) {
  for (const item of chain) {
    const stat = fs.lstatSync(item.path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || identity(stat) !== item.id) refuse();
  }
}

function readOrdinary(file) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) refuse();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (identity(opened) !== identity(before) || opened.nlink !== 1n) refuse();
    const bytes = fs.readFileSync(fd);
    const after = fs.lstatSync(file, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n ||
        identity(before) !== identity(after) || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) refuse();
    return { id: identity(after), bytes, digest: hash(bytes), size: bytes.length };
  } finally { fs.closeSync(fd); }
}

function sameFile(actual, expected) {
  if (actual.id !== expected.id || actual.size !== expected.size || actual.digest !== expected.digest) refuse();
}

/** No caller hooks, renderer injection, overwrite, or implicit source/output root. */
export function stageRelease({ sourceRoot, destination, profile }) {
  const selected = validateReleaseProfile(profile);
  if (selected.profile !== 'synthetic') refuse('RELEASE_STAGE_PROFILE_BLOCKED');
  const source = absolute(sourceRoot);
  const target = absolute(destination);
  if (overlaps(source, target) || overlaps(source, REPOSITORY) || overlaps(target, REPOSITORY)) refuse('RELEASE_STAGE_OVERLAP');
  let sourceChain;
  let parentChain;
  const sources = [];
  const files = new Map();
  const directories = new Map();
  let created = false;
  let cleaned = false;

  function verifyDirectories() {
    verifyChain(parentChain);
    for (const [directory, id] of directories) {
      const stat = fs.lstatSync(directory, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory() || identity(stat) !== id) refuse();
    }
  }

  function verifyOutput() {
    verifyChain(parentChain);
    for (const [dir, id] of directories) {
      const stat = fs.lstatSync(dir, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== id) refuse();
      const expected = [...directories.keys(), ...files.keys()].filter((item) => item !== dir && path.dirname(item) === dir)
        .map((item) => path.basename(item)).sort();
      const actual = fs.readdirSync(dir).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) refuse();
    }
    for (const [file, receipt] of files) sameFile(readOrdinary(file), receipt);
  }

  function cleanup() {
    if (cleaned) return;
    try {
      if (created && !directories.has(target)) refuse();
      verifyOutput();
      for (const file of [...files.keys()].reverse()) {
        verifyChain(parentChain);
        for (const dir of directoryChain(path.dirname(file))) {
          if (directories.has(dir.path) && directories.get(dir.path) !== dir.id) refuse();
        }
        sameFile(readOrdinary(file), files.get(file));
        fs.unlinkSync(file);
        files.delete(file);
      }
      for (const dir of [...directories.keys()].reverse()) {
        verifyChain(parentChain);
        const stat = fs.lstatSync(dir, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== directories.get(dir) || fs.readdirSync(dir).length) refuse();
        fs.rmdirSync(dir);
        directories.delete(dir);
      }
      cleaned = true;
    } catch (cause) { throw new ReleaseStageError('RELEASE_STAGE_RETAINED', cause, true); }
  }

  try {
    sourceChain = directoryChain(source);
    parentChain = directoryChain(path.dirname(target));
    const actualSource = physical(source);
    const actualTarget = path.join(physical(path.dirname(target)), path.basename(target));
    const actualRepository = physical(REPOSITORY);
    if (overlaps(actualSource, actualTarget) || overlaps(actualSource, actualRepository) ||
        overlaps(actualTarget, actualRepository)) refuse('RELEASE_STAGE_OVERLAP');
    try { fs.lstatSync(target); refuse('RELEASE_STAGE_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Preflight every selected source before any write; excluded files are never enumerated.
    for (const entry of selected.entries) {
      if (entry.generated) {
        if (entry.generated !== 'synthetic-metadata-v1') refuse('RELEASE_STAGE_GENERATOR_UNAVAILABLE');
        if (entry.bytes !== syntheticMetadata.length || entry.sha256 !== hash(syntheticMetadata)) refuse();
        sources.push({ entry, bytes: syntheticMetadata });
      } else {
        const file = path.join(source, ...entry.source.split('/'));
        const chain = directoryChain(path.dirname(file));
        const receipt = readOrdinary(file);
        if (receipt.size !== entry.bytes || receipt.digest !== entry.sha256) refuse();
        sources.push({ entry, file, chain, receipt, bytes: receipt.bytes });
      }
    }
    verifyChain(sourceChain);
    verifyChain(parentChain);
    fs.mkdirSync(target);
    created = true;
    directories.set(target, identity(fs.lstatSync(target, { bigint: true })));
    for (const item of sources) {
      verifyDirectories();
      if (item.file) { verifyChain(item.chain); sameFile(readOrdinary(item.file), item.receipt); }
      const output = path.join(target, ...item.entry.path.split('/'));
      let dir = target;
      for (const segment of item.entry.path.split('/').slice(0, -1)) {
        dir = path.join(dir, segment);
        if (!directories.has(dir)) {
          verifyDirectories();
          fs.mkdirSync(dir);
          directories.set(dir, identity(fs.lstatSync(dir, { bigint: true })));
        }
      }
      verifyDirectories();
      const fd = fs.openSync(output, 'wx');
      try {
        const owned = fs.fstatSync(fd, { bigint: true });
        // Register before the write: a partial write remains provable by its current receipt.
        files.set(output, { id: identity(owned), size: 0, digest: hash(Buffer.alloc(0)) });
        fs.writeFileSync(fd, item.bytes);
        files.set(output, { id: identity(owned), size: item.bytes.length, digest: hash(item.bytes) });
      } finally { fs.closeSync(fd); }
    }
    verifyChain(sourceChain);
    for (const item of sources) if (item.file) { verifyChain(item.chain); sameFile(readOrdinary(item.file), item.receipt); }
    verifyOutput();
    return Object.freeze({
      schemaVersion: '1.0.0', kind: 'StagedRelease', profile: 'synthetic', directory: target,
      entries: selected.entries, cleanup,
    });
  } catch (cause) {
    if (created) {
      try { cleanup(); } catch (retained) {
        const failure = new ReleaseStageError('RELEASE_STAGE_FAILED', cause, retained.retained);
        failure.cleanupError = retained;
        throw failure;
      }
    }
    if (cause instanceof ReleaseStageError) throw cause;
    throw new ReleaseStageError('RELEASE_STAGE_FAILED', cause);
  }
}
