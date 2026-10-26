// Captain-owned filesystem boundary. Cooperative staging is not an OS sandbox.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { inventoryTree } from '../core/identity.mjs';
import { SELECTION_POLICY_EXCLUSIONS } from '../core/snapshot-copy.mjs';
import { identityDigestOf, validateRecord } from '../core/manifest.mjs';
import { openRun } from '../core/lifecycle.mjs';
import { verifyFrozenSubmission } from '../core/freeze.mjs';
import { CANONICAL_TOOLING, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, EvaluationRefusalError, EvaluationInfrastructureError, throwIfAborted } from './contracts.mjs';

export const OWNER_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const same = (left, right) => identity(left) === identity(right);
const inside = (root, target) => {
  const relative = path.relative(root.toLowerCase(), target.toLowerCase());
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
const overlap = (a, b) => inside(a, b) || inside(b, a);
// Windows still limits launched executables (esbuild.exe) and Chromium's profile tree to MAX_PATH
// even with long paths enabled, so scratch lives under a short temp root rather than the attempt.
const WINDOWS_MAX_PATH = 259;
const CHROMIUM_PROFILE_ALLOWANCE = 160;
function refuse(code, message, details) { throw new EvaluationRefusalError(code, message, details); }
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\x00-\x1f]/.test(value) || path.dirname(value) === value) refuse('INVALID_PATH', 'An explicit canonical absolute non-volume path is required');
  return value;
}

export function assertDirectoryChain(root) {
  const chain = [];
  for (let at = root;; at = path.dirname(at)) {
    chain.unshift(at);
    if (path.dirname(at) === at) break;
  }
  return chain.map(at => {
    const stat = fs.lstatSync(at);
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('UNSAFE_PATH', 'Linked or non-directory ancestor refused', { path: at });
    return { path: at, identity: identity(stat) };
  });
}
function assertClaim(chain) {
  for (const entry of chain) {
    const stat = fs.lstatSync(entry.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== entry.identity) refuse('OWNERSHIP_LOST', 'A claimed directory or ancestor was replaced');
  }
}

// Resolve missing leaves from an existing ordinary ancestor. Windows short names and mapped
// drive aliases can be link-free yet name the same physical directory, so lexical checks alone
// are not a containment proof. This is read-only and never creates/mounts an alias.
function physicalPath(target) {
  let anchor = path.resolve(target);
  const leaves = [];
  for (;;) {
    try { fs.lstatSync(anchor); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(anchor) === anchor) throw error;
      leaves.unshift(path.basename(anchor));
      anchor = path.dirname(anchor);
    }
  }
  assertDirectoryChain(anchor);
  const physical = fs.realpathSync.native(anchor);
  assertDirectoryChain(physical);
  return path.join(physical, ...leaves);
}

function assertPhysicalDisjoint(outputRoot, protectedRoots) {
  const physicalOutput = physicalPath(outputRoot);
  for (const root of protectedRoots.filter(Boolean)) {
    const physicalRoot = physicalPath(root);
    if (overlap(physicalOutput, physicalRoot)) refuse('ROOTS_OVERLAP', 'Evaluation output physically overlaps a protected/source root');
  }
}

export function validateEvaluationRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) refuse('INVALID_ARGUMENT', 'Evaluation request required');
  const allowed = ['challenge', 'evaluator', 'submission', 'outputRoot', 'environment', 'timeoutMs', 'maxOutputBytes', 'signal'];
  if (Object.keys(request).some(key => !allowed.includes(key))) refuse('INVALID_ARGUMENT', 'Unknown evaluation request option');
  try {
    validateRecord('ChallengeIdentity', request.challenge);
    validateRecord('EvaluatorIdentity', request.evaluator);
  } catch (error) { refuse('IDENTITY_INVALID', 'Invalid evaluation identity: ' + error.message); }
  const s = request.submission;
  if (!s || Object.keys(s).some(key => !['runRoot', 'runId', 'manifestId', 'snapshotId', 'frozenSubmissionId', 'expectedDigest'].includes(key))) refuse('INVALID_SELECTION', 'Explicit frozen selection required');
  absolute(s.runRoot);
  for (const key of ['runId', 'manifestId', 'snapshotId', 'frozenSubmissionId']) if (typeof s[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(s[key])) refuse('INVALID_SELECTION', 'Invalid frozen identity: ' + key);
  if (!/^[a-f0-9]{64}$/.test(s.expectedDigest ?? '')) refuse('INVALID_SELECTION', 'Expected C3 manifest digest required');
  const outputRoot = absolute(request.outputRoot);
  if (overlap(outputRoot, OWNER_ROOT) || overlap(outputRoot, s.runRoot)) refuse('ROOTS_OVERLAP', 'Evaluation output must be disjoint from repository and run container');
  try { assertDirectoryChain(path.dirname(outputRoot)); }
  catch (error) {
    if (error instanceof EvaluationRefusalError) throw error;
    refuse('INVALID_PATH', 'Evaluation output parent must be an existing ordinary directory', { cause: error.code });
  }
  if (fs.existsSync(outputRoot)) refuse('OUTPUT_EXISTS', 'Evaluation output must be exclusively new');
  assertPhysicalDisjoint(outputRoot, [OWNER_ROOT, s.runRoot]);
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 256 || maxOutputBytes > 16777216) refuse('INVALID_ARGUMENT', 'Finite timeout/output bounds required');
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) refuse('INVALID_ARGUMENT', 'signal must be an AbortSignal');
  if (request.environment !== undefined && (!request.environment || typeof request.environment !== 'object' || Array.isArray(request.environment) || Object.keys(request.environment).some(k => k !== 'label') || (request.environment.label !== undefined && request.environment.label !== null && (typeof request.environment.label !== 'string' || !/^[\w .-]{1,100}$/.test(request.environment.label))))) refuse('INVALID_ARGUMENT', 'Environment permits a bounded non-private label only');
  return Object.freeze({ ...request, submission: Object.freeze({ ...s }), outputRoot, timeoutMs, maxOutputBytes });
}

export async function verifySelection(request) {
  let verification, opened;
  try {
    assertDirectoryChain(request.submission.runRoot);
    verification = await verifyFrozenSubmission(request.submission);
    opened = await openRun({ runRoot: request.submission.runRoot, runId: request.submission.runId, manifestId: request.submission.manifestId, expectedDigest: request.submission.expectedDigest });
  } catch (error) { refuse('SNAPSHOT_REFUSED', 'C3 frozen verification refused: ' + error.message); }
  const publication = verification.submissions[0];
  if (!verification.ok || verification.state !== 'FROZEN' || verification.submissions.length !== 1 || !publication?.ok) refuse('SNAPSHOT_REFUSED', 'C3 requires one complete, inactive, unchanged frozen publication', { findings: [...verification.findings, ...verification.runFindings] });
  if (opened.manifest.bindings.challenge.challengeIdentityDigest !== identityDigestOf(request.challenge) || opened.manifest.bindings.evaluator.evaluatorIdentityDigest !== identityDigestOf(request.evaluator)) refuse('IDENTITY_MISMATCH', 'Evaluation identities differ from sealed run bindings');
  return Object.freeze({ ...opened, snapshotRoot: publication.snapshotRoot, treeDigest: publication.treeDigest, workspaceMatchesFrozen: verification.workspace?.matchesFrozenInventory ?? null });
}

// No ignored directory names: dependencies and generated scratch receive the same link/special checks.
function scan(root, { maxFiles = 100000, maxBytes = 2147483648 } = {}) {
  assertDirectoryChain(root);
  const entries = [], folded = new Set(); let bytes = 0;
  function walk(at, relative) {
    const stat = fs.lstatSync(at);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) refuse('UNSAFE_ENTRY', 'Links and special files refused', { path: relative });
    const segments = relative.split('/');
    if (relative && segments.some(s => !s || s === '.' || s === '..' || /[\\:\x00-\x1f\x7f]/.test(s) || /[. ]$/.test(s))) refuse('INVALID_PATH', 'Unsafe inventory path');
    const fold = relative.toLowerCase();
    if (folded.has(fold)) refuse('CASE_COLLISION', 'Case-colliding tree refused');
    folded.add(fold);
    entries.push({ path: relative, stat, identity: identity(stat), directory: stat.isDirectory() });
    if (entries.length > maxFiles) refuse('TREE_LIMIT', 'Tree entry bound exceeded');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(at).sort()) walk(path.join(at, name), relative ? relative + '/' + name : name);
    } else {
      bytes += stat.size;
      if (bytes > maxBytes) refuse('TREE_LIMIT', 'Tree byte bound exceeded');
    }
  }
  walk(root, '');
  return entries;
}
function remember(claim, target) {
  claim.initial.set(path.relative(claim.scratchRoot, target).replaceAll('\\', '/'), identity(fs.lstatSync(target)));
}
function ownedParent(claim, target) {
  assertClaim(claim.chain);
  const relative = path.relative(claim.scratchRoot, target).replaceAll('\\', '/');
  if (!inside(claim.scratchRoot, target)) refuse('INVALID_PATH', 'Staging target escaped scratch');
  let at = claim.scratchRoot;
  for (const segment of relative.split('/').slice(0, -1)) {
    at = path.join(at, segment);
    const stat = fs.lstatSync(at), key = path.relative(claim.scratchRoot, at).replaceAll('\\', '/');
    if (!stat.isDirectory() || stat.isSymbolicLink() || claim.initial.get(key) !== identity(stat)) refuse('OWNERSHIP_LOST', 'Staging parent was replaced');
  }
}
function canonicalDirectory(claim, target) {
  ownedParent(claim, target);
  try { fs.mkdirSync(target); remember(claim, target); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(target), key = path.relative(claim.scratchRoot, target).replaceAll('\\', '/');
    if (!stat.isDirectory() || stat.isSymbolicLink() || claim.initial.get(key) !== identity(stat)) refuse('OWNERSHIP_LOST', 'Canonical test directory was replaced');
  }
}
function canonicalFile(claim, source, target) {
  assertDirectoryChain(path.dirname(source));
  ownedParent(claim, target);
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) refuse('UNSAFE_ENTRY', 'Canonical input is not an ordinary file');
  const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    if (!same(fs.fstatSync(input), sourceStat)) refuse('SOURCE_CHANGED', 'Canonical input replaced');
    bytes = fs.readFileSync(input);
  } finally { fs.closeSync(input); }
  let targetStat;
  try { targetStat = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const key = path.relative(claim.scratchRoot, target).replaceAll('\\', '/');
  if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink() || claim.initial.get(key) !== identity(targetStat))) refuse('OWNERSHIP_LOST', 'Canonical target is linked, foreign or replaced');
  // Open existing files WITHOUT truncation, then prove the descriptor before writing.
  const output = fs.openSync(target, targetStat ? fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0) : 'wx');
  try {
    if (targetStat && !same(fs.fstatSync(output), targetStat)) refuse('OWNERSHIP_LOST', 'Canonical target replaced while opening');
    ownedParent(claim, target);
    fs.ftruncateSync(output, 0);
    fs.writeFileSync(output, bytes);
    remember(claim, target);
  } finally { fs.closeSync(output); }
}
async function copyTree(source, target, entries, claim, signal) {
  let copied = 0;
  for (const entry of entries) {
    // Let an external abort be observed between bounded batches. Individual synchronous reads,
    // writes and the pre-copy inventory scans remain cooperative, not interruptible OS calls.
    if (copied++ % 64 === 0) await yieldImmediate();
    throwIfAborted(signal, 'preflight');
    const from = path.join(source, entry.path), to = path.join(target, entry.path);
    ownedParent(claim, to);
    const current = fs.lstatSync(from);
    if (!same(current, entry.stat) || current.isSymbolicLink() || current.size !== entry.stat.size || current.mtimeMs !== entry.stat.mtimeMs) refuse('SOURCE_CHANGED', 'Copy source changed after validation');
    if (entry.directory) fs.mkdirSync(to);
    else {
      const handle = fs.openSync(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        if (!same(fs.fstatSync(handle), entry.stat)) refuse('SOURCE_CHANGED', 'Copy source replaced while opening');
        fs.writeFileSync(to, fs.readFileSync(handle), { flag: 'wx' });
      } finally { fs.closeSync(handle); }
    }
    remember(claim, to);
  }
}

export async function stageFrozen(verified, request, options = {}) {
  const canonicalRoot = options.canonicalRoot ?? path.join(OWNER_ROOT, 'starter');
  const dependencyRoot = options.dependencyRoot ?? path.join(canonicalRoot, 'node_modules');
  const event = options.onEvent ?? (() => {});
  absolute(request.outputRoot);
  for (const protectedRoot of [OWNER_ROOT, verified.runRoot, verified.snapshotRoot, canonicalRoot, dependencyRoot].filter(Boolean)) {
    if (overlap(request.outputRoot, path.resolve(protectedRoot))) refuse('ROOTS_OVERLAP', 'Staging output overlaps a protected/source root');
  }
  assertDirectoryChain(path.dirname(request.outputRoot));
  if (fs.existsSync(request.outputRoot)) refuse('OUTPUT_EXISTS', 'Staging output must be exclusively new');
  const protectedRoots = [OWNER_ROOT, verified.runRoot, verified.snapshotRoot, canonicalRoot, dependencyRoot];
  assertPhysicalDisjoint(request.outputRoot, protectedRoots);
  // Real path: macOS temp sits behind a /var symlink, which the ancestor chain check refuses.
  const scratchParent = absolute(fs.realpathSync.native(path.resolve(options.scratchParent ?? os.tmpdir())));
  for (const protectedRoot of protectedRoots.filter(Boolean)) {
    if (inside(path.resolve(protectedRoot), scratchParent)) refuse('ROOTS_OVERLAP', 'Scratch parent lies inside a protected/source root');
  }
  assertDirectoryChain(scratchParent);
  throwIfAborted(request.signal, 'preflight');
  let dependencies;
  try { dependencies = scan(dependencyRoot); }
  catch (error) {
    if (error.code === 'ENOENT') throw new EvaluationInfrastructureError('preflight', 'MISSING_PREREQUISITE', 'Prepared starter/node_modules is missing');
    throw error;
  }
  for (const tool of ['typescript/bin/tsc', 'vite/bin/vite.js', 'vitest/vitest.mjs']) {
    if (!dependencies.some(e => !e.directory && e.path === tool)) throw new EvaluationInfrastructureError('preflight', 'MISSING_PREREQUISITE', 'Missing prepared tool: ' + tool);
  }
  const original = inventoryTree({ root: verified.snapshotRoot, skipNames: [] });
  if (original.digest !== verified.treeDigest) refuse('SNAPSHOT_REFUSED', 'Snapshot changed before staging');
  const sourceEntries = scan(verified.snapshotRoot);
  const reservedNames = new Set(SELECTION_POLICY_EXCLUSIONS.map(name => name.toLowerCase()));
  for (const entry of sourceEntries) {
    if (entry.path && !entry.path.includes('/') && reservedNames.has(entry.path.toLowerCase())) {
      refuse('UNSAFE_ENTRY', 'Snapshot contains a reserved top-level selection name or case alias', { path: entry.path });
    }
  }
  throwIfAborted(request.signal, 'preflight');
  assertDirectoryChain(path.dirname(request.outputRoot));
  assertPhysicalDisjoint(request.outputRoot, protectedRoots);
  if (process.platform === 'win32') {
    // Measured before anything is created so a too-deep temp root refuses in seconds, not minutes.
    const scratchLength = path.join(scratchParent, 'bbs-XXXXXX').length;
    const deepest = Math.max(0, ...dependencies.map(e => e.path.length)) + scratchLength + '/product/node_modules/'.length;
    const profile = scratchLength + '/temp/'.length + CHROMIUM_PROFILE_ALLOWANCE;
    if (Math.max(deepest, profile) > WINDOWS_MAX_PATH) refuse('PATH_TOO_LONG', `Evaluation scratch under ${scratchParent} would exceed the Windows ${WINDOWS_MAX_PATH + 1}-character path limit; set TEMP to a shorter folder`);
  }
  fs.mkdirSync(request.outputRoot);
  const outputChain = assertDirectoryChain(request.outputRoot);
  const scratchRoot = fs.mkdtempSync(path.join(scratchParent, 'bbs-'));
  const claim = { scratchRoot, appRoot: path.join(scratchRoot, 'product'), tempRoot: path.join(scratchRoot, 'temp'), chain: assertDirectoryChain(scratchRoot), outputChain, initial: new Map([['', identity(fs.lstatSync(scratchRoot))]]) };
  try {
    await copyTree(verified.snapshotRoot, claim.appRoot, sourceEntries, claim, request.signal);
    event('copy-frozen', { appRoot: claim.appRoot });
    throwIfAborted(request.signal, 'preflight');
    assertClaim(claim.chain);
    for (const name of CANONICAL_TOOLING) {
      throwIfAborted(request.signal, 'preflight');
      const source = path.join(canonicalRoot, name);
      canonicalFile(claim, source, path.join(claim.appRoot, name));
    }
    const canonicalTests = scan(path.join(canonicalRoot, 'tests'));
    for (const entry of canonicalTests) {
      throwIfAborted(request.signal, 'preflight');
      const to = path.join(claim.appRoot, 'tests', entry.path);
      if (entry.directory) canonicalDirectory(claim, to);
      else canonicalFile(claim, path.join(canonicalRoot, 'tests', entry.path), to);
    }
    event('canonical-replacement', { appRoot: claim.appRoot });
    throwIfAborted(request.signal, 'preflight');
    await copyTree(dependencyRoot, path.join(claim.appRoot, 'node_modules'), dependencies, claim, request.signal);
    event('prepared-dependencies', { appRoot: claim.appRoot });
    throwIfAborted(request.signal, 'preflight');
    fs.mkdirSync(claim.tempRoot);
    remember(claim, claim.tempRoot);
    assertClaim(claim.chain);
    const after = inventoryTree({ root: verified.snapshotRoot, skipNames: [] });
    if (after.digest !== original.digest) refuse('SNAPSHOT_REFUSED', 'Snapshot changed while staging');
    throwIfAborted(request.signal, 'preflight');
    return claim;
  } catch (error) {
    error.cleanup = cleanupScratch(claim);
    throw error;
  }
}

export function cleanupScratch(claim) {
  const result = { removed: false, residue: [], errors: [] };
  if (!claim) return { ...result, removed: true };
  try {
    assertClaim(claim.chain);
    const entries = scan(claim.scratchRoot);
    const directoryEntries = new Map(entries.filter(e => e.directory).map(e => [e.path, e]));
    const cachePath = 'product/node_modules/.vite';
    const cacheRoot = directoryEntries.get(cachePath);
    const ownedCacheRoot = cacheRoot && claim.initial.get(cachePath) === cacheRoot.identity;
    for (const entry of entries) {
      const expected = claim.initial.get(entry.path);
      const generated = /^(?:product\/(?:dist|node_modules)(?:\/|$)|temp(?:\/|$))/.test(entry.path);
      // Vite atomically rewrites copied optimize-deps contents. Only descendants of the
      // STILL-OWNED cache directory are disposable generated content, not the cache root,
      // node_modules root or any other remembered dependency. scan already refused links;
      // the deletion pass below revalidates every current ancestor and leaf again.
      const generatedCache = ownedCacheRoot && entry.path.startsWith(cachePath + '/');
      if ((expected && entry.identity !== expected && !generatedCache) || (!expected && claim.initial.size && !generated)) refuse('OWNERSHIP_LOST', 'Unexpected or replaced scratch entry preserved');
    }
    for (const entry of entries.reverse()) {
      assertClaim(claim.chain);
      const at = path.join(claim.scratchRoot, entry.path);
      // Revalidate every parent before deleting a leaf; never traverse a replaced directory.
      const parts = entry.path.split('/');
      for (let n = 1; n < parts.length; n++) {
        const ancestor = directoryEntries.get(parts.slice(0, n).join('/'));
        if (!ancestor) refuse('OWNERSHIP_LOST', 'Scratch ancestor was not inventoried');
        const stat = fs.lstatSync(path.join(claim.scratchRoot, ancestor.path));
        if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== ancestor.identity) refuse('OWNERSHIP_LOST', 'Scratch ancestor replaced during cleanup');
      }
      const stat = fs.lstatSync(at);
      if (identity(stat) !== entry.identity || stat.isSymbolicLink()) refuse('OWNERSHIP_LOST', 'Scratch entry replaced during cleanup');
      entry.directory ? fs.rmdirSync(at) : fs.unlinkSync(at);
    }
    result.removed = true;
  } catch (error) {
    result.residue.push(claim.scratchRoot);
    result.errors.push({ code: 'CLEANUP_FAILED', message: error.message });
  }
  return result;
}
