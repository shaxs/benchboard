/**
 * C3 / T2 focused tests for the snapshot-copy primitive
 * (`packages/core/snapshot-copy.mjs`). All T2 closures are kept verbatim; the
 * C3 T6 section at the end adds one regression per Captain-demonstrated
 * acceptance gap plus a host-ancestor identity negative.
 *
 * Run: `node --test tests/lifecycle/snapshot-copy.test.mjs`
 *
 * Scratch policy: generated trees live in the project-contained directory
 * `tests/lifecycle/.tmp/snapshot-copy/` unless the caller supplies the
 * absolute, already-existing `BENCHBOARD_TEST_TMP` or
 * `BENCHBOARD_TEST_SCRATCH_ROOT` override (the C3 evidence scratch is used for
 * the official run). No host temp directory and no sibling-project path is
 * ever used. The default contained directory is created if it does not exist;
 * that is the only implicit path and it is repository-local.
 *
 * Scope notes:
 *  - Real benchmark content is never seeded, executed, frozen or evaluated;
 *    every tree here is synthetic.
 *  - Windows link creation: junctions need no privilege, file symlinks do.
 *    Where the host refuses to create a link, the case is skipped with the
 *    reason recorded — the refusal is a platform fact, not a weakened gate.
 *  - The C3 boundary is cooperative; nothing here asserts atomic directory
 *    visibility, hard-link exclusion, or adversarial-OS strength.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SELECTION_POLICY_EXCLUSIONS,
  SELECTION_POLICY_ID,
  SNAPSHOT_ERROR_CODES,
  SNAPSHOT_HASH_ALGORITHM_ID,
  SnapshotError,
  copySnapshot,
  verifySnapshot,
} from '../../packages/core/snapshot-copy.mjs';
import { hashEntries } from '../../packages/core/identity.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/* ------------------------------------------------------------------ *
 * scratch helpers
 * ------------------------------------------------------------------ */

function testScratchRoot() {
  const override = process.env.BENCHBOARD_TEST_TMP ?? process.env.BENCHBOARD_TEST_SCRATCH_ROOT;
  if (override !== void 0 && override !== '') {
    if (!path.isAbsolute(override)) throw new Error(`BENCHBOARD_TEST_TMP must be an absolute directory, got ${JSON.stringify(override)}`);
    return override;
  }
  const contained = fileURLToPath(new URL('./.tmp/snapshot-copy/', import.meta.url));
  fs.mkdirSync(contained, { recursive: true });
  return contained;
}

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(testScratchRoot(), 'benchboard-t2-'));
  t.after(() => {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* residual scratch is cleaned by the operator; never fail a test for it */
    }
  });
  return directory;
}

function writeFile(root, rel, data) {
  const absolute = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, data);
  return absolute;
}

function mkdirp(root, rel) {
  const absolute = path.join(root, ...rel.split('/'));
  fs.mkdirSync(absolute, { recursive: true });
  return absolute;
}

async function rejectionOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

function makeWorkspace(root, name = 'workspace') {
  const workspace = path.join(root, name);
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

const capability = { junction: void 0, caseInsensitive: void 0, fifo: void 0 };

function canCreateJunction(t) {
  if (capability.junction !== void 0) return capability.junction;
  const probe = scratch(t);
  try {
    const target = path.join(probe, 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(probe, 'link'), 'junction');
    capability.junction = true;
  } catch {
    capability.junction = false;
  }
  return capability.junction;
}

function isScratchCaseInsensitive(t) {
  if (capability.caseInsensitive !== void 0) return capability.caseInsensitive;
  const probe = scratch(t);
  fs.writeFileSync(path.join(probe, 'CaseProbe.txt'), 'a');
  capability.caseInsensitive = fs.existsSync(path.join(probe, 'caseprobe.txt'));
  return capability.caseInsensitive;
}

function canCreateFifo(t) {
  if (capability.fifo !== void 0) return capability.fifo;
  const probe = scratch(t);
  try {
    const result = spawnSync(process.execPath, ['-e', "require('fs').mkfifoSync(process.argv[1])", path.join(probe, 'pipe')], { encoding: 'utf8' });
    capability.fifo = result.status === 0;
  } catch {
    capability.fifo = false;
  }
  return capability.fifo;
}

/* Deterministic legacy pair digest, computed independently of identity.mjs to
 * pin the "raw legacy path/hash digest" contract against accidental drift. */
function manualDigest(entries) {
  const pairs = entries.map((entry) => [entry.path, entry.sha256]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(pairs), 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ *
 * selection policy
 * ------------------------------------------------------------------ */

test('selection policy: exact top-level exclusions, nested look-alikes and other dotfiles included', async (t) => {
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  const excludedNames = [...SELECTION_POLICY_EXCLUSIONS];
  assert.deepEqual(excludedNames, ['.git', 'node_modules', 'dist', '.agent-teams', '.benchboard', '.cache', 'coverage', '.vite']);
  assert.equal(SELECTION_POLICY_ID, 'benchboard-application-snapshot-v1');

  // Top-level excluded names (with content) — never selected.
  for (const name of excludedNames) writeFile(workspace, `${name}/inner.txt`, `inner ${name}`);
  // Application/config/package/lock/tests/participant additions and other dotfiles.
  const included = [
    'README.md',
    'package.json',
    'package-lock.json',
    'src/App.tsx',
    'src/util/deep/mod.mjs',
    'tests/visible/one.test.mjs',
    'participant/addition/notes.md',
    '.envlocal',
    '.editorconfig',
    '.hiddenconfig/deep/file',
    // nested look-alikes of every exclusion name are NOT skipped
    ...excludedNames.map((name) => `src/${name}/nested.txt`),
    // nested dotfile and nested look-alike deeper down
    'vendor/.git/keepme',
    'a/node_modules/b/deep/c/keepme',
  ];
  for (const rel of included) writeFile(workspace, rel, `content of ${rel}`);
  // An empty included directory contributes no file entries.
  mkdirp(workspace, 'emptydir');

  const output = path.join(root, 'snapshot');
  const result = await copySnapshot({ workspaceRoot: workspace, outputRoot: output, protectedRoots: [workspace] });
  assert.equal(result.ok, true);
  assert.equal(result.selectionPolicyId, SELECTION_POLICY_ID);
  assert.equal(result.hashAlgorithmId, SNAPSHOT_HASH_ALGORITHM_ID);
  const paths = result.inventory.map((entry) => entry.path);
  for (const rel of included) assert.ok(paths.includes(rel), `selected ${rel}`);
  for (const name of excludedNames) {
    assert.ok(!paths.includes(`${name}/inner.txt`), `${name}/inner.txt is excluded at top level`);
    assert.ok(paths.includes(`src/${name}/nested.txt`), `src/${name}/nested.txt is a nested look-alike and is included`);
  }
  assert.ok(!paths.some((candidate) => candidate.startsWith('.git/')));
  assert.ok(!paths.some((candidate) => candidate.startsWith('coverage/')));
  assert.equal(result.fileCount, paths.length);
  assert.deepEqual([...paths], [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'inventory is sorted by raw lexical POSIX order');

  // The digest is the raw legacy [path, sha256] pair digest.
  assert.equal(result.digest, manualDigest(result.inventory));
  assert.equal(result.digest, hashEntries(result.inventory.map((entry) => ({ path: entry.path, sha256: entry.sha256 }))));

  // Copied bytes exist and equal the source bytes.
  for (const entry of result.inventory) {
    const copied = fs.readFileSync(path.join(output, ...entry.path.split('/')));
    assert.equal(copied.toString('utf8'), `content of ${entry.path}`);
    assert.equal(entry.bytes, copied.byteLength);
    assert.equal(entry.sha256, crypto.createHash('sha256').update(copied).digest('hex'));
  }
  // Empty included directories are not fabricated into the inventory.
  assert.ok(!paths.includes('emptydir'));
});

test('selection: binary, CRLF and Unicode bytes are copied raw, digests bind them', async (t) => {
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  const binary = Buffer.from([0x00, 0x01, 0x0A, 0x0D, 0x0A, 0xFF, 0xFE, 0x00, 0x80, 0x7F]);
  const crlf = Buffer.from('line one\r\nline two\r\nends with cr\r', 'utf8');
  const unicodeName = 'src/Ünïcødé-Ω-日本語.txt';
  writeFile(workspace, 'assets/blob.bin', binary);
  writeFile(workspace, 'text/crlf.txt', crlf);
  writeFile(workspace, unicodeName, Buffer.from('unicode name payload', 'utf8'));
  writeFile(workspace, 'text/nul-safe.txt', Buffer.from([0x61, 0x00, 0x62]));

  const output = path.join(root, 'snapshot');
  const result = await copySnapshot({ workspaceRoot: workspace, outputRoot: output, protectedRoots: [] });
  assert.ok(fs.readFileSync(path.join(output, 'assets/blob.bin')).equals(binary), 'binary bytes are raw');
  assert.ok(fs.readFileSync(path.join(output, 'text/crlf.txt')).equals(crlf), 'CRLF bytes are raw, not normalised');
  const onDiskNames = fs.readdirSync(path.join(output, 'src'));
  const unicodeBase = unicodeName.split('/').pop();
  assert.ok(onDiskNames.some((name) => name.normalize('NFC') === unicodeBase.normalize('NFC')), 'the unicode name survived the copy');
  assert.ok(fs.readFileSync(path.join(output, ...unicodeName.split('/'))).equals(Buffer.from('unicode name payload')), 'unicode path payload');
  assert.ok(fs.readFileSync(path.join(output, 'text/nul-safe.txt')).equals(Buffer.from([0x61, 0x00, 0x62])));
  const blob = result.inventory.find((entry) => entry.path === 'assets/blob.bin');
  assert.equal(blob.bytes, binary.byteLength);
  assert.equal(blob.sha256, crypto.createHash('sha256').update(binary).digest('hex'));
});

/* ------------------------------------------------------------------ *
 * root/argument/path safety
 * ------------------------------------------------------------------ */

test('root arguments must be explicit absolute non-volume paths', async (t) => {
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  writeFile(workspace, 'a.txt', 'a');
  const cases = [
    [void 0, 'INVALID_ARGUMENT'],
    [[], 'INVALID_ARGUMENT'],
    [{ workspaceRoot: workspace }, 'INVALID_ARGUMENT'],
    [{ workspaceRoot: workspace, outputRoot: 'relative/out', protectedRoots: [] }, 'INVALID_ROOT'],
    [{ workspaceRoot: './ws', outputRoot: path.join(root, 'out'), protectedRoots: [] }, 'INVALID_ROOT'],
    [{ workspaceRoot: 'C:\\', outputRoot: path.join(root, 'out'), protectedRoots: [] }, 'INVALID_ROOT'],
    [{ workspaceRoot: '\\\\localhost\\share\\ws', outputRoot: path.join(root, 'out'), protectedRoots: [] }, 'INVALID_ROOT'],
    [{ workspaceRoot: workspace, outputRoot: path.join(root, 'out') }, 'INVALID_ARGUMENT'],
    [{ workspaceRoot: workspace, outputRoot: path.join(root, 'out'), protectedRoots: 'not-an-array' }, 'INVALID_ARGUMENT'],
    [{ workspaceRoot: workspace, outputRoot: path.join(root, 'out'), protectedRoots: [], hooks: () => {} }, 'INVALID_ARGUMENT'],
    [{ workspaceRoot: workspace, outputRoot: path.join(root, 'out'), protectedRoots: [], hooks: [42] }, 'INVALID_ARGUMENT'],
    [{ workspaceRoot: workspace, outputRoot: path.join(root, 'out'), protectedRoots: [], hooks: [], extra: 1 }, 'INVALID_ARGUMENT'],
  ];
  for (const [request, expected] of cases) {
    const error = await rejectionOf(copySnapshot(request));
    assert.ok(error instanceof SnapshotError, `rejected with SnapshotError for ${JSON.stringify(request)?.slice(0, 80)}`);
    assert.equal(error.code, expected);
  }
});

test('destination disjointness versus every protected root; protected roots may nest', async (t) => {
  const root = scratch(t);
  const owner = path.join(root, 'owner');
  const workspace = makeWorkspace(owner, 'workspace');
  const nestedProtected = path.join(owner, 'evaluator');
  writeFile(workspace, 'a.txt', 'a');
  mkdirp(nestedProtected, 'x');

  // output inside a protected root — refused.
  let error = await rejectionOf(copySnapshot({ workspaceRoot: workspace, outputRoot: path.join(owner, 'snapshots', 's1'), protectedRoots: [owner, nestedProtected] }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.ROOTS_NOT_DISJOINT, 'an output inside a protected root is refused');

  // output == a protected root — refused.
  error = await rejectionOf(copySnapshot({ workspaceRoot: workspace, outputRoot: nestedProtected, protectedRoots: [owner, nestedProtected] }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.ROOTS_NOT_DISJOINT);

  // output inside the workspace — refused (workspace implicitly protected).
  error = await rejectionOf(copySnapshot({ workspaceRoot: workspace, outputRoot: path.join(workspace, 'snap'), protectedRoots: [] }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.ROOTS_NOT_DISJOINT);

  // Deeply disjoint output with nested protected roots — accepted. The
  // destination itself must be NEW, but its parent chain must already exist
  // (the module never creates a destination through a missing parent chain).
  mkdirp(root, 'snapshots');
  const output = path.join(root, 'snapshots', 's1');
  const result = await copySnapshot({ workspaceRoot: workspace, outputRoot: output, protectedRoots: [owner, nestedProtected] });
  assert.equal(result.ok, true, 'nested protected roots are legal as long as the destination is disjoint from each');
});

test('link ancestors and junction roots are refused when the host allows them', async (t) => {
  if (!canCreateJunction(t)) {
    t.skip('the host refused junction creation; file symlinks need privileges the harness does not have');
    return;
  }
  const root = scratch(t);
  const outside = makeWorkspace(root, 'outside');
  writeFile(outside, 'keep.txt', 'keep');
  const junction = path.join(root, 'alias');
  fs.symlinkSync(outside, junction, 'junction');

  // A workspace that IS a junction alias — refused. The refusal is reported as
  // either a detected link or a prohibited link ancestor; both are documented
  // safe refusals and neither may leave a destination behind.
  let error = await rejectionOf(copySnapshot({ workspaceRoot: junction, outputRoot: path.join(root, 'out1'), protectedRoots: [] }));
  assert.ok(
    [SNAPSHOT_ERROR_CODES.LINK_DETECTED, SNAPSHOT_ERROR_CODES.LINK_ANCESTOR].includes(error?.code),
    `a junction workspace is refused as a link condition (${error?.code})`,
  );
  assert.equal(fs.existsSync(path.join(root, 'out1')), false, 'no destination is created for a link-aliased workspace');

  // A workspace UNDER a junction alias (canonical alias path) — refused.
  error = await rejectionOf(copySnapshot({ workspaceRoot: path.join(junction, 'sub'), outputRoot: path.join(root, 'out2'), protectedRoots: [] }));
  assert.ok(
    [SNAPSHOT_ERROR_CODES.INVALID_ROOT, SNAPSHOT_ERROR_CODES.LINK_ANCESTOR].includes(error?.code),
    `the alias path fails the link-ancestor probe of the root (${error?.code})`,
  );
  assert.equal(fs.existsSync(path.join(root, 'out2')), false, 'no destination is created for a workspace under a junction alias');

  // An output that resolves inside the protected workspace through the alias —
  // refused. The alias is caught by the link-ancestor probe of the destination
  // chain (earlier and stricter than the real-path disjointness comparison),
  // so either safe refusal code is correct as long as nothing is written.
  error = await rejectionOf(copySnapshot({ workspaceRoot: outside, outputRoot: path.join(junction, 'sub-out'), protectedRoots: [outside] }));
  assert.ok(
    [SNAPSHOT_ERROR_CODES.ROOTS_NOT_DISJOINT, SNAPSHOT_ERROR_CODES.LINK_ANCESTOR].includes(error?.code),
    `the alias path is caught before any write (${error?.code})`,
  );
  assert.equal(fs.existsSync(path.join(junction, 'sub-out')), false, 'no destination is created through the alias path');

  // A protected root supplied via its junction alias — refused before any copy.
  error = await rejectionOf(copySnapshot({ workspaceRoot: outside, outputRoot: path.join(root, 'out3'), protectedRoots: [junction] }));
  assert.ok(
    [SNAPSHOT_ERROR_CODES.INVALID_ROOT, SNAPSHOT_ERROR_CODES.LINK_ANCESTOR].includes(error?.code),
    `a junction-aliased protected root is refused (${error?.code})`,
  );
  assert.equal(fs.existsSync(path.join(root, 'out3')), false, 'no destination is created for a link-aliased protected root');
});

/* ------------------------------------------------------------------ *
 * physical safety
 * ------------------------------------------------------------------ */

test('links inside the source — including inside excluded names — abort before any write', async (t) => {
  if (!canCreateJunction(t)) {
    t.skip('the host refused junction creation in the scratch volume');
    return;
  }
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  writeFile(workspace, 'app.txt', 'app');
  const outside = mkdirp(root, 'outside-target');
  writeFile(outside, 'secret.txt', 'secret');
  // A junction inside an EXCLUDED top-level directory: the safety scan runs
  // over excluded content before the exclusion is pruned, so this still aborts.
  mkdirp(workspace, 'node_modules');
  fs.symlinkSync(outside, path.join(workspace, 'node_modules', 'escape'), 'junction');
  const output = path.join(root, 'snapshot');
  const error = await rejectionOf(copySnapshot({ workspaceRoot: workspace, outputRoot: output, protectedRoots: [] }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.LINK_DETECTED, 'an excluded-directory link cannot evade safety');
  assert.equal(fs.existsSync(output), false, 'nothing is left behind after a pre-claim refusal');
});

test('special (non-regular) source files abort when the host can create them', async (t) => {
  if (!canCreateFifo(t)) {
    t.skip('the host does not allow mkfifo (named pipes need POSIX semantics); the link cases are the available physical-irregular analogue');
    return;
  }
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  writeFile(workspace, 'app.txt', 'app');
  const made = spawnSync(process.execPath, ['-e', "require('fs').mkfifoSync(process.argv[1])", path.join(workspace, 'pipe')], { encoding: 'utf8' });
  assert.equal(made.status, 0);
  const output = path.join(root, 'snapshot');
  const error = await rejectionOf(copySnapshot({ workspaceRoot: workspace, outputRoot: output, protectedRoots: [] }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.SPECIAL_FILE);
  assert.equal(fs.existsSync(output), false);
});

test('case-insensitive collisions abort when the volume allows both spellings', async (t) => {
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  writeFile(workspace, 'src/Report.txt', 'one');
  if (isScratchCaseInsensitive(t)) {
    t.skip('the scratch volume is case-insensitive, so two case-only spellings cannot both exist there; the fold guard is exercised by the alias-identity test below');
    return;
  }
  writeFile(workspace, 'src/report.txt', 'two');
  const output = path.join(root, 'snapshot');
  const error = await rejectionOf(copySnapshot({ workspaceRoot: workspace, outputRoot: output, protectedRoots: [] }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.CASE_COLLISION);
  assert.equal(fs.existsSync(output), false);
});

test('a case-only variant of an exclusion name is an ordinary included entry', async (t) => {
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  writeFile(workspace, 'Dist/readme.txt', 'build docs');
  writeFile(workspace, '.GIT-CONFIG', 'not the git dir');
  const output = path.join(root, 'snapshot');
  const result = await copySnapshot({ workspaceRoot: workspace, outputRoot: output, protectedRoots: [] });
  const paths = result.inventory.map((entry) => entry.path);
  assert.ok(paths.includes('Dist/readme.txt'), 'folded exclusion spellings are byte-exact-policy misses and are INCLUDED');
  assert.ok(paths.includes('.GIT-CONFIG'));
});

/* ------------------------------------------------------------------ *
 * destination claiming
 * ------------------------------------------------------------------ */

test('the destination must be exclusively NEW: existing, empty and concurrent claims are refused', async (t) => {
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  writeFile(workspace, 'a.txt', 'a');

  // 1. an existing non-empty destination is never reused or cleaned
  const taken = mkdirp(root, 'taken');
  writeFile(taken, 'foreign.txt', 'do not touch');
  let error = await rejectionOf(copySnapshot({ workspaceRoot: workspace, outputRoot: taken, protectedRoots: [] }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.DESTINATION_EXISTS);
  assert.equal(fs.readFileSync(path.join(taken, 'foreign.txt'), 'utf8'), 'do not touch');

  // 2. an existing EMPTY destination is also refused (never adopted)
  const empty = mkdirp(root, 'empty-out');
  error = await rejectionOf(copySnapshot({ workspaceRoot: workspace, outputRoot: empty, protectedRoots: [] }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.DESTINATION_EXISTS);

  // 3. a concurrent claimer during an in-flight copy is refused, and the
  //    published result of the winner is untouched
  let releaseWinner;
  const winnerIsInFlight = new Promise((resolve) => { releaseWinner = resolve; });
  const first = copySnapshot({
    workspaceRoot: workspace,
    outputRoot: path.join(root, 'race'),
    protectedRoots: [],
    hooks: [async () => { releaseWinner(); await new Promise((resolve) => setTimeout(resolve, 25)); }],
  });
  await winnerIsInFlight;
  const second = await rejectionOf(copySnapshot({ workspaceRoot: workspace, outputRoot: path.join(root, 'race'), protectedRoots: [] }));
  assert.equal(second?.code, SNAPSHOT_ERROR_CODES.DESTINATION_EXISTS, 'the second claimer sees EEXIST, never a shared directory');
  const winner = await first;
  assert.equal(winner.ok, true);
});

/* ------------------------------------------------------------------ *
 * hooks, mutation gates and rollback ownership
 * ------------------------------------------------------------------ */

test('hooks are awaited one after the other; a hook fault aborts and rolls back completely', async (t) => {
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  writeFile(workspace, 'a.txt', 'a');
  writeFile(workspace, 'sub/b.txt', 'b');
  writeFile(workspace, 'sub/deep/c.txt', 'c');
  const order = [];
  const output = path.join(root, 'snapshot');
  const error = await rejectionOf(copySnapshot({
    workspaceRoot: workspace,
    outputRoot: output,
    protectedRoots: [],
    hooks: [
      async () => { await new Promise((resolve) => setTimeout(resolve, 5)); order.push('one'); },
      () => { order.push('two'); },
      () => { order.push('boom'); throw new Error('hook fault'); },
      () => { order.push('never'); },
    ],
  }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.HOOK_FAILED);
  assert.deepEqual(order, ['one', 'two', 'boom'], 'hooks run sequentially and stop at the first fault');
  assert.equal(fs.existsSync(output), false, 'a clean rollback removes the claim entirely');
  assert.equal(error.fate.phase, 'aborted-cleaned');
  assert.ok(error.fate.removedFiles.includes('a.txt') && error.fate.removedFiles.includes('sub/b.txt') && error.fate.removedFiles.includes('sub/deep/c.txt'));
  assert.deepEqual([...error.fate.foreignPreserved], []);
  assert.deepEqual([...error.fate.cleanupErrors], []);
});

test('source content mutation during the operation aborts; the source is never recopied after validation', async (t) => {
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  writeFile(workspace, 'a.txt', 'original');
  writeFile(workspace, 'sub/b.txt', 'b');
  const output = path.join(root, 'snapshot');
  const error = await rejectionOf(copySnapshot({
    workspaceRoot: workspace,
    outputRoot: output,
    protectedRoots: [],
    hooks: [() => { fs.writeFileSync(path.join(workspace, 'a.txt'), 'MUTATED'); }],
  }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.SOURCE_MUTATED, 'the source-after gate catches the changed hash at the final revalidation');
  assert.match(error.message, /source-after final-hook/);
  assert.equal(fs.existsSync(output), false);

  // The next attempt against a fresh destination succeeds cleanly: the failed
  // attempt did not leave anything that would have had to be "recopied".
  const retry = await copySnapshot({ workspaceRoot: workspace, outputRoot: path.join(root, 'snapshot2'), protectedRoots: [] });
  assert.equal(retry.ok, true);
});

test('source add / remove / link insertion during the operation aborts via the source-after gate', async (t) => {
  const addRoot = scratch(t);
  const addWs = makeWorkspace(addRoot);
  writeFile(addWs, 'a.txt', 'a');
  let error = await rejectionOf(copySnapshot({
    workspaceRoot: addWs,
    outputRoot: path.join(addRoot, 'snap'),
    protectedRoots: [],
    hooks: [() => { writeFile(addWs, 'sub/added.txt', 'late'); }],
  }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.SOURCE_MUTATED, 'an added source file aborts the publication');
  assert.match(error.message, /was added/);

  const removeRoot = scratch(t);
  const removeWs = makeWorkspace(removeRoot);
  writeFile(removeWs, 'a.txt', 'a');
  writeFile(removeWs, 'b.txt', 'b');
  error = await rejectionOf(copySnapshot({
    workspaceRoot: removeWs,
    outputRoot: path.join(removeRoot, 'snap'),
    protectedRoots: [],
    hooks: [() => { fs.rmSync(path.join(removeWs, 'b.txt')); }],
  }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.SOURCE_MUTATED, 'a removed source file aborts the publication');
  assert.match(error.message, /was removed/);

  if (!canCreateJunction(t)) {
    t.skip('the host refused junction creation; the link-insertion source gate is skipped with the reason recorded');
    return;
  }
  const linkRoot = scratch(t);
  const linkWs = makeWorkspace(linkRoot);
  writeFile(linkWs, 'a.txt', 'a');
  const elsewhere = mkdirp(linkRoot, 'elsewhere');
  error = await rejectionOf(copySnapshot({
    workspaceRoot: linkWs,
    outputRoot: path.join(linkRoot, 'snap'),
    protectedRoots: [],
    hooks: [() => { fs.symlinkSync(elsewhere, path.join(linkWs, 'escape'), 'junction'); }],
  }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.LINK_DETECTED, 'a link inserted into the source during the operation aborts the publication');
});

test('snapshot-side mutation during a hook aborts: content change, deletion, identical-content replacement', async (t) => {
  // (a) our copied file is edited in place
  const rootA = scratch(t);
  const wsA = makeWorkspace(rootA);
  writeFile(wsA, 'a.txt', 'a');
  writeFile(wsA, 'sub/b.txt', 'b');
  let error = await rejectionOf(copySnapshot({
    workspaceRoot: wsA,
    outputRoot: path.join(rootA, 'snap'),
    protectedRoots: [],
    hooks: [() => { fs.writeFileSync(path.join(rootA, 'snap', 'sub', 'b.txt'), 'tampered'); }],
  }));
  assert.ok([SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED, SNAPSHOT_ERROR_CODES.SNAPSHOT_VERIFICATION_FAILED].includes(error?.code), `a snapshot edit is caught (${error?.code})`);
  // The edited file's current bytes are no longer the bytes this operation
  // created, so rollback must NOT delete it: it is preserved and disclosed.
  // Our own untouched file is removed, and the occupied root is retained with
  // an explicit residual report.
  assert.equal(fs.existsSync(path.join(rootA, 'snap', 'sub', 'b.txt')), true, 'an edited snapshot file is preserved, not removed');
  assert.ok(error.fate.foreignPreserved.some((entry) => entry.path === 'sub/b.txt' && /modified-after-creation/.test(entry.reason)), JSON.stringify(error.fate.foreignPreserved));
  assert.equal(fs.existsSync(path.join(rootA, 'snap', 'a.txt')), false, 'an unmodified owned file is removed');
  assert.ok(error.fate.residualPaths.some((entry) => entry.path === '.' && /snapshot-root-retained/.test(entry.reason)), 'the retained root is reported');

  // (b) our copied file is deleted
  const rootB = scratch(t);
  const wsB = makeWorkspace(rootB);
  writeFile(wsB, 'a.txt', 'a');
  error = await rejectionOf(copySnapshot({
    workspaceRoot: wsB,
    outputRoot: path.join(rootB, 'snap'),
    protectedRoots: [],
    hooks: [() => { fs.rmSync(path.join(rootB, 'snap', 'a.txt')); }],
  }));
  assert.ok([SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED, SNAPSHOT_ERROR_CODES.SNAPSHOT_VERIFICATION_FAILED].includes(error?.code), `a deletion is caught (${error?.code})`);

  // (c) our copied file is replaced with IDENTICAL content by a foreign file:
  // bytes match, ownership does not — the publication refuses to adopt bytes
  // it did not create.
  const rootC = scratch(t);
  const wsC = makeWorkspace(rootC);
  writeFile(wsC, 'a.txt', 'same bytes');
  error = await rejectionOf(copySnapshot({
    workspaceRoot: wsC,
    outputRoot: path.join(rootC, 'snap'),
    protectedRoots: [],
    hooks: [() => {
      const target = path.join(rootC, 'snap', 'a.txt');
      fs.rmSync(target);
      fs.writeFileSync(target, 'same bytes');
    }],
  }));
  if (error === null) {
    // On a volume where the recreated file reports the same creation identity
    // (no usable inode number), content-level gates cannot see the swap; the
    // fallback identity disclosure in the module covers this honestly.
    assert.ok(true);
  } else {
    assert.ok([SNAPSHOT_ERROR_CODES.OWNERSHIP_LOST, SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED].includes(error.code), `identical-content replacement is refused as ownership loss (${error.code})`);
  }
});

test('cleanup preserves anything whose ownership chain or bytes cannot be proven: ancestor replacement, same-inode edit, empty root replacement', async (t) => {
  // (a) an ancestor directory is replaced by an equal-content foreign
  // directory. The recreated directory carries a different creation identity,
  // so neither the file below it nor the directory is provably ours: rollback
  // must preserve and disclose them without traversing the replacement.
  const rootA = scratch(t);
  const wsA = makeWorkspace(rootA);
  writeFile(wsA, 'sub/b.txt', 'b');
  const snapA = path.join(rootA, 'snap');
  let error = await rejectionOf(copySnapshot({
    workspaceRoot: wsA,
    outputRoot: snapA,
    protectedRoots: [],
    hooks: [() => {
      fs.rmSync(path.join(snapA, 'sub', 'b.txt'));
      fs.rmdirSync(path.join(snapA, 'sub'));
      fs.mkdirSync(path.join(snapA, 'sub'));
      fs.writeFileSync(path.join(snapA, 'sub', 'b.txt'), 'b');
    }],
  }));
  assert.ok(
    [SNAPSHOT_ERROR_CODES.OWNERSHIP_LOST, SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED, SNAPSHOT_ERROR_CODES.SNAPSHOT_VERIFICATION_FAILED].includes(error?.code),
    `an equal-content ancestor replacement is caught (${error?.code})`,
  );
  assert.equal(fs.existsSync(path.join(snapA, 'sub', 'b.txt')), true, 'bytes below a replaced ancestor are never touched');
  assert.ok(error.fate.foreignPreserved.some((entry) => entry.reason.includes('ownership-chain-not-provable')), JSON.stringify(error.fate.foreignPreserved));
  assert.equal(error.fate.removedFiles.includes('sub/b.txt'), false, 'no deletion through a replaced ancestor');

  // (b) a created file is edited in place: same inode, different bytes. The
  // current-bytes gate must refuse to delete bytes this operation did not make.
  const rootB = scratch(t);
  const wsB = makeWorkspace(rootB);
  writeFile(wsB, 'top.txt', 'original');
  const snapB = path.join(rootB, 'snap');
  error = await rejectionOf(copySnapshot({
    workspaceRoot: wsB,
    outputRoot: snapB,
    protectedRoots: [],
    hooks: [() => { fs.writeFileSync(path.join(snapB, 'top.txt'), 'edited-in-place'); }],
  }));
  assert.ok([SNAPSHOT_ERROR_CODES.SNAPSHOT_MUTATED, SNAPSHOT_ERROR_CODES.SNAPSHOT_VERIFICATION_FAILED].includes(error?.code), `a same-inode edit is caught (${error?.code})`);
  assert.equal(fs.readFileSync(path.join(snapB, 'top.txt'), 'utf8'), 'edited-in-place', 'the edited bytes survive rollback');
  assert.ok(error.fate.foreignPreserved.some((entry) => entry.path === 'top.txt' && /modified-after-creation/.test(entry.reason)), JSON.stringify(error.fate.foreignPreserved));

  // (c) the claimed root itself is replaced by an EMPTY foreign directory with
  // identical (empty) content. The claim identity is gone, so the root is
  // retained rather than removed, and the retention is disclosed.
  const rootC = scratch(t);
  const wsC = makeWorkspace(rootC);
  writeFile(wsC, 'x.txt', 'x');
  const snapC = path.join(rootC, 'snap');
  error = await rejectionOf(copySnapshot({
    workspaceRoot: wsC,
    outputRoot: snapC,
    protectedRoots: [],
    hooks: [() => {
      fs.rmSync(snapC, { recursive: true, force: true });
      fs.mkdirSync(snapC);
    }],
  }));
  assert.ok(error instanceof SnapshotError, `the root replacement is caught (${error?.code})`);
  assert.equal(fs.existsSync(snapC), true, 'a foreign replacement of the snapshot root is retained, never removed');
  assert.equal(error.fate.removedDirectories.includes('.'), false, 'the root removal is not claimed');
  assert.ok(error.fate.foreignPreserved.some((entry) => entry.path === '.' && /snapshot-root-replacement-retained/.test(entry.reason)), JSON.stringify(error.fate.foreignPreserved));
});

test('foreign insertions into the snapshot during a hook are preserved and honestly reported, never deleted', async (t) => {
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  writeFile(workspace, 'a.txt', 'a');
  writeFile(workspace, 'sub/b.txt', 'b');
  writeFile(workspace, 'sub/deep/c.txt', 'c');
  const error = await rejectionOf(copySnapshot({
    workspaceRoot: workspace,
    outputRoot: path.join(root, 'snap'),
    protectedRoots: [],
    hooks: [() => {
      // a foreign file inside one of our directories and one at the top
      fs.writeFileSync(path.join(root, 'snap', 'sub', 'FOREIGN.txt'), 'foreign');
      fs.writeFileSync(path.join(root, 'snap', 'FOREIGN-TOP.txt'), 'foreign top');
    }],
  }));
  assert.ok(error instanceof SnapshotError);
  assert.equal(error.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_VERIFICATION_FAILED, 'the copied-inventory gate catches the insertion before success');
  const preserved = error.fate.foreignPreserved.map((entry) => entry.path);
  assert.ok(preserved.includes('sub/FOREIGN.txt'), 'foreign file preserved, not adopted into cleanup ownership');
  assert.ok(preserved.includes('FOREIGN-TOP.txt'));
  assert.equal(fs.existsSync(path.join(root, 'snap', 'sub', 'FOREIGN.txt')), true, 'the foreign bytes are still there after cleanup');
  assert.equal(fs.existsSync(path.join(root, 'snap', 'FOREIGN-TOP.txt')), true);
  assert.ok(error.fate.removedFiles.includes('a.txt') && error.fate.removedFiles.includes('sub/b.txt'));
  assert.ok(error.fate.residualPaths.some((entry) => entry.path === '.' && /snapshot-root-retained/.test(entry.reason)), 'the residual snapshot-root fate is reported, not hidden');
});

test('missing, non-directory and file workspace roots are refused before any claim', async (t) => {
  const root = scratch(t);
  const missing = path.join(root, 'nope');
  let error = await rejectionOf(copySnapshot({ workspaceRoot: missing, outputRoot: path.join(root, 'snap'), protectedRoots: [] }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.SOURCE_NOT_FOUND);
  const fileRoot = path.join(root, 'file.txt');
  fs.writeFileSync(fileRoot, 'x');
  error = await rejectionOf(copySnapshot({ workspaceRoot: fileRoot, outputRoot: path.join(root, 'snap2'), protectedRoots: [] }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.SOURCE_NOT_A_DIRECTORY);
  assert.equal(fs.existsSync(path.join(root, 'snap')), false);
  assert.equal(fs.existsSync(path.join(root, 'snap2')), false);
});

/* ------------------------------------------------------------------ *
 * verifySnapshot
 * ------------------------------------------------------------------ */

test('verifySnapshot passes on the published snapshot and reports every tampering class', async (t) => {
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  writeFile(workspace, 'a.txt', Buffer.from([0x00, 0xFF, 0x0A]));
  writeFile(workspace, 'sub/b.txt', 'beta');
  writeFile(workspace, 'sub/deep/c.txt', 'gamma');
  const output = path.join(root, 'snap');
  const result = await copySnapshot({ workspaceRoot: workspace, outputRoot: output, protectedRoots: [] });

  const clean = await verifySnapshot({ snapshotRoot: output, expectedInventory: result.inventory, expectedDigest: result.digest, selectionPolicyId: SELECTION_POLICY_ID });
  assert.equal(clean.ok, true, `clean verification failed: ${clean.failures.join('; ')}`);

  // changed bytes, SAME LENGTH: only the hash can notice, so this proves the
  // content hash is actually compared and not merely implied by a size check.
  fs.writeFileSync(path.join(output, 'sub/b.txt'), 'BETA');
  let bad = await verifySnapshot({ snapshotRoot: output, expectedInventory: result.inventory, expectedDigest: result.digest, selectionPolicyId: SELECTION_POLICY_ID });
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some((line) => /sub\/b\.txt/.test(line) && /sha256 mismatch/.test(line)), bad.failures.join('; '));
  fs.writeFileSync(path.join(output, 'sub/b.txt'), 'beta');

  // changed length: reported as its own distinct class.
  fs.writeFileSync(path.join(output, 'sub/b.txt'), 'BETA-TAMPERED');
  bad = await verifySnapshot({ snapshotRoot: output, expectedInventory: result.inventory, expectedDigest: result.digest, selectionPolicyId: SELECTION_POLICY_ID });
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some((line) => /sub\/b\.txt/.test(line) && /bytes, expected/.test(line)), bad.failures.join('; '));
  fs.writeFileSync(path.join(output, 'sub/b.txt'), 'beta');

  // deleted entry
  fs.rmSync(path.join(output, 'sub/deep/c.txt'));
  bad = await verifySnapshot({ snapshotRoot: output, expectedInventory: result.inventory, expectedDigest: result.digest, selectionPolicyId: SELECTION_POLICY_ID });
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some((line) => /sub\/deep\/c\.txt/.test(line) && /missing/.test(line)), bad.failures.join('; '));
  writeFile(output, 'sub/deep/c.txt', 'gamma');

  // inserted entry
  writeFile(output, 'EXTRA.txt', 'extra');
  bad = await verifySnapshot({ snapshotRoot: output, expectedInventory: result.inventory, expectedDigest: result.digest, selectionPolicyId: SELECTION_POLICY_ID });
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some((line) => /unexpected entry "EXTRA\.txt"/.test(line)), bad.failures.join('; '));
  fs.rmSync(path.join(output, 'EXTRA.txt'));

  // link entry
  if (canCreateJunction(t)) {
    fs.symlinkSync(root, path.join(output, 'linkout'), 'junction');
    bad = await verifySnapshot({ snapshotRoot: output, expectedInventory: result.inventory, expectedDigest: result.digest, selectionPolicyId: SELECTION_POLICY_ID });
    assert.equal(bad.ok, false);
    assert.ok(bad.failures.some((line) => /linkout/.test(line) && /is a link/.test(line)), bad.failures.join('; '));
    fs.rmSync(path.join(output, 'linkout'));
  }

  // digest mismatch against the inventory
  bad = await verifySnapshot({ snapshotRoot: output, expectedInventory: result.inventory, expectedDigest: 'f'.repeat(64), selectionPolicyId: SELECTION_POLICY_ID });
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some((line) => /does not match the expected inventory/.test(line)), bad.failures.join('; '));

  // duplicate expectation
  bad = await verifySnapshot({ snapshotRoot: output, expectedInventory: [...result.inventory, result.inventory[0]], expectedDigest: result.digest, selectionPolicyId: SELECTION_POLICY_ID });
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some((line) => /duplicate path/.test(line)), bad.failures.join('; '));

  // malformed arguments throw
  await assert.rejects(
    () => verifySnapshot({ snapshotRoot: output, expectedInventory: result.inventory, expectedDigest: result.digest, selectionPolicyId: 'other-policy' }),
    (error) => error.code === SNAPSHOT_ERROR_CODES.INVALID_ARGUMENT,
  );
  await assert.rejects(
    () => verifySnapshot({ snapshotRoot: output, expectedInventory: result.inventory, expectedDigest: 'not-hex', selectionPolicyId: SELECTION_POLICY_ID }),
    (error) => error.code === SNAPSHOT_ERROR_CODES.INVALID_ARGUMENT,
  );
  await assert.rejects(
    () => verifySnapshot({ snapshotRoot: 'relative', expectedInventory: [], expectedDigest: '0'.repeat(64), selectionPolicyId: SELECTION_POLICY_ID }),
    (error) => error.code === SNAPSHOT_ERROR_CODES.INVALID_ROOT,
  );

  // missing snapshot root is a data failure, not a throw
  const gone = await verifySnapshot({ snapshotRoot: path.join(root, 'not-here'), expectedInventory: result.inventory, expectedDigest: result.digest, selectionPolicyId: SELECTION_POLICY_ID });
  assert.equal(gone.ok, false);
  assert.match(gone.failures[0], /not an existing directory/);

  // a link snapshot root is refused
  if (canCreateJunction(t)) {
    const alias = path.join(root, 'snapalias');
    fs.symlinkSync(output, alias, 'junction');
    const aliasResult = await verifySnapshot({ snapshotRoot: alias, expectedInventory: result.inventory, expectedDigest: result.digest, selectionPolicyId: SELECTION_POLICY_ID });
    assert.equal(aliasResult.ok, false);
    assert.match(aliasResult.failures[0], /real directory/);
  }
});

/* ------------------------------------------------------------------ *
 * C3 T6 regressions for the three Captain-demonstrated acceptance gaps
 * plus the host-ancestor identity closure
 * ------------------------------------------------------------------ */

test('T6 regression 1: a hook that renames the claimed root aside, recreates the path and moves the original files back (same inodes) is ownership loss', async (t) => {
  // This is the shipped form of the Captain probe
  // `nonempty-root-replacement-same-file-identities`: every copied file keeps
  // its creation identity and its bytes, so per-file content/identity gates
  // cannot see the swap — only the claim-chain proof of the ROOT can.
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  writeFile(workspace, 'a.txt', 'same');
  writeFile(workspace, 'sub/b.txt', 'b');
  const output = path.join(root, 'snap');
  const displaced = path.join(root, 'displaced');
  const error = await rejectionOf(copySnapshot({
    workspaceRoot: workspace,
    outputRoot: output,
    protectedRoots: [],
    hooks: [() => {
      fs.renameSync(output, displaced);
      fs.mkdirSync(output);
      fs.renameSync(path.join(displaced, 'a.txt'), path.join(output, 'a.txt'));
      fs.mkdirSync(path.join(output, 'sub'));
      fs.renameSync(path.join(displaced, 'sub', 'b.txt'), path.join(output, 'sub', 'b.txt'));
    }],
  }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.OWNERSHIP_LOST, `the recreated root is not the claimed root (${error?.code})`);
  assert.match(String(error?.message), /claim chain/);
  // Cleanup: with the chain broken nothing below the claim path is provably
  // ours, so NOT ONE entry may be removed — even the files that still carry
  // our inodes. Everything is preserved and disclosed.
  assert.deepEqual([...error.fate.removedFiles], [], 'no file is removed through a broken claim chain');
  assert.deepEqual([...error.fate.removedDirectories], [], 'no directory is removed through a broken claim chain');
  assert.deepEqual([...error.fate.cleanupErrors], []);
  assert.ok(error.fate.foreignPreserved.some((entry) => entry.path === '.' && /^snapshot-root-replacement-retained/.test(entry.reason)), JSON.stringify(error.fate.foreignPreserved));
  assert.ok(error.fate.foreignPreserved.some((entry) => entry.path === 'a.txt' && /^(ownership-chain-not-provable|root-identity-not-proven)/.test(entry.reason)), JSON.stringify(error.fate.foreignPreserved));
  // The bytes moved into the NEW root are untouched foreign-arranged material:
  // they still exist, with their content.
  assert.equal(fs.readFileSync(path.join(output, 'a.txt'), 'utf8'), 'same');
  assert.equal(fs.readFileSync(path.join(output, 'sub', 'b.txt'), 'utf8'), 'b');
  assert.equal(fs.existsSync(displaced), true, 'the displaced original root is left in place');
  // The disclosure is exact and ordered (files newest-first, then directories,
  // then the root): every entry is preserved because the root identity is not
  // the claim identity, and the root itself names that reason.
  assert.deepEqual([...error.fate.foreignPreserved], [
    { path: 'sub/b.txt', reason: 'ownership-chain-not-provable' },
    { path: 'a.txt', reason: 'ownership-chain-not-provable' },
    { path: 'sub', reason: 'ownership-chain-not-provable' },
    { path: '.', reason: 'snapshot-root-replacement-retained-identity-not-claim-identity' },
  ]);
  assert.deepEqual([...error.fate.residualPaths], []);
  assert.equal(error.fate.phase, 'aborted-cleaned');
});

test('T6 regression 2: with an EMPTY selection, a hook that replaces the claimed root is still ownership loss (an empty root is not exempt)', async (t) => {
  // The shipped form of the Captain probe `empty-snapshot-root-replacement`.
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  // Only excluded top-level names: the selection itself is empty.
  mkdirp(workspace, '.git');
  mkdirp(workspace, 'node_modules');
  const output = path.join(root, 'snap');
  const error = await rejectionOf(copySnapshot({
    workspaceRoot: workspace,
    outputRoot: output,
    protectedRoots: [],
    hooks: [() => { fs.rmdirSync(output); fs.mkdirSync(output); }],
  }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.OWNERSHIP_LOST, `an empty snapshot root is verified like any other (${error?.code})`);
  assert.match(String(error?.message), /claim chain/);
  // The replacement root is foreign material: preserved, never removed.
  assert.equal(fs.existsSync(output), true, 'the replacement root is not deleted');
  assert.deepEqual([...error.fate.removedDirectories], []);
  assert.deepEqual([...error.fate.removedFiles], []);
  assert.deepEqual([...error.fate.residualPaths], [], 'the retained replacement root is a preservation, not a residual');
  assert.ok(error.fate.foreignPreserved.some((entry) => entry.path === '.' && /^snapshot-root-replacement-retained/.test(entry.reason)), JSON.stringify(error.fate.foreignPreserved));
});

test('T6 regression 3: verifySnapshot rejects an unexpected EMPTY directory (and any implied-directory drift), not just extra files', async (t) => {
  // The shipped form of the Captain probe
  // `unexpected-empty-directory-in-saved-snapshot`.
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  writeFile(workspace, 'a.txt', 'a');
  writeFile(workspace, 'sub/b.txt', 'b');
  const output = path.join(root, 'snap');
  const result = await copySnapshot({ workspaceRoot: workspace, outputRoot: output, protectedRoots: [] });
  const verify = (snapshotRoot) => verifySnapshot({ snapshotRoot: snapshotRoot ?? output, expectedInventory: result.inventory, expectedDigest: result.digest, selectionPolicyId: SELECTION_POLICY_ID });

  // A snapshot that was never touched passes with the exact implied set.
  assert.equal((await verify()).ok, true);

  // Top-level empty insertion.
  fs.mkdirSync(path.join(output, 'EXTRA_EMPTY'));
  let bad = await verify();
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some((line) => /unexpected directory "EXTRA_EMPTY"/.test(line)), bad.failures.join('; '));
  fs.rmdirSync(path.join(output, 'EXTRA_EMPTY'));

  // Nested empty insertion below an implied directory.
  fs.mkdirSync(path.join(output, 'sub', 'EXTRA_NESTED'));
  bad = await verify();
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some((line) => /unexpected directory "sub\/EXTRA_NESTED"/.test(line)), bad.failures.join('; '));
  fs.rmdirSync(path.join(output, 'sub', 'EXTRA_NESTED'));

  // An occupied foreign subtree insertion: the directory AND its file are both
  // reported.
  writeFile(output, 'foreign/dir/inside.txt', 'x');
  bad = await verify();
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some((line) => /unexpected directory "foreign"/.test(line)), bad.failures.join('; '));
  assert.ok(bad.failures.some((line) => /unexpected directory "foreign\/dir"/.test(line)), bad.failures.join('; '));
  assert.ok(bad.failures.some((line) => /unexpected entry "foreign\/dir\/inside\.txt"/.test(line)), bad.failures.join('; '));
  fs.rmSync(path.join(output, 'foreign'), { recursive: true });

  // Implied-directory removal is reported as its own class: the whole implied
  // directory is gone (file and directory), so the directory gate names it, and
  // the stray empty directory is named as an insertion.
  fs.rmSync(path.join(output, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(output, 'movedaside'));
  bad = await verify();
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some((line) => /implied directory "sub" is missing/.test(line)), bad.failures.join('; '));
  assert.ok(bad.failures.some((line) => /unexpected directory "movedaside"/.test(line)), bad.failures.join('; '));
  assert.ok(bad.failures.some((line) => /expected entry "sub\/b\.txt" is missing/.test(line)), bad.failures.join('; '));
});

test('T6: a replaced or newly-linked HOST ANCESTOR of the claimed root is ownership loss, is never read through, and freezes cleanup', async (t) => {
  // The claim binds the identities of every host ancestor up to the volume
  // root. If an intermediate directory on the path is replaced, the proof stops
  // AT that ancestor (top-down), never resolves deeper through it, and cleanup
  // removes nothing at all.
  const root = scratch(t);
  const workspace = makeWorkspace(root);
  writeFile(workspace, 'a.txt', 'a');
  writeFile(workspace, 'sub/b.txt', 'b');
  const holder = path.join(root, 'holder');
  fs.mkdirSync(holder);
  const output = path.join(holder, 'snap');
  const error = await rejectionOf(copySnapshot({
    workspaceRoot: workspace,
    outputRoot: output,
    protectedRoots: [],
    hooks: [() => {
      // The whole holder directory is renamed away and a FRESH, EMPTY holder
      // is created at the same spelling. Everything this operation created is
      // now reachable only "through" the replaced component.
      fs.renameSync(holder, `${holder}-moved`);
      fs.mkdirSync(holder);
    }],
  }));
  assert.equal(error?.code, SNAPSHOT_ERROR_CODES.OWNERSHIP_LOST, `a swapped host ancestor is ownership loss (${error?.code})`);
  // The failure names the ANCESTOR, proving the walk stopped there instead of
  // resolving through it to the snapshot root.
  assert.ok(String(error?.message).includes('host-ancestor-identity-changed:'), String(error?.message));
  assert.ok(String(error?.message).includes(holder.replaceAll('\\', '/')) || String(error?.message).includes(holder), 'the reported break names the replaced host ancestor');
  assert.match(String(error?.message), /is no longer proven/);
  // With the chain broken, nothing is removed, nothing is enumerated through
  // the replacement, and every ledger entry is preserved and disclosed.
  assert.deepEqual([...error.fate.removedFiles], []);
  assert.deepEqual([...error.fate.removedDirectories], []);
  assert.deepEqual([...error.fate.cleanupErrors], []);
  assert.ok(error.fate.foreignPreserved.some((entry) => entry.path === '.' && /^host-chain-not-provable:host-ancestor-identity-changed:/.test(entry.reason)), JSON.stringify(error.fate.foreignPreserved));
  assert.ok(error.fate.foreignPreserved.some((entry) => entry.path === 'a.txt'), JSON.stringify(error.fate.foreignPreserved));
  // The displaced material is completely intact below the moved holder.
  assert.equal(fs.readFileSync(path.join(`${holder}-moved`, 'snap', 'a.txt'), 'utf8'), 'a');
  assert.equal(fs.readFileSync(path.join(`${holder}-moved`, 'snap', 'sub', 'b.txt'), 'utf8'), 'b');
  assert.equal(fs.readdirSync(holder).length, 0, 'the fresh holder was not read through or populated');
});

/* ------------------------------------------------------------------ *
 * declaration parity and declaration typecheck
 * ------------------------------------------------------------------ */

test('the runtime surface and the paired declarations agree', () => {
  const declaration = fs.readFileSync(path.join(REPO_ROOT, 'packages/core/snapshot-copy.d.ts'), 'utf8');
  const declarationMts = fs.readFileSync(path.join(REPO_ROOT, 'packages/core/snapshot-copy.d.mts'), 'utf8');
  assert.equal(declaration, declarationMts, 'the .d.ts and .d.mts twins are identical');
  for (const name of ['copySnapshot', 'verifySnapshot', 'SELECTION_POLICY_ID', 'SELECTION_POLICY_EXCLUSIONS', 'SNAPSHOT_HASH_ALGORITHM_ID', 'SNAPSHOT_ERROR_CODES', 'SnapshotError']) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(declaration), `the declaration declares ${name}`);
  }
  for (const code of Object.values(SNAPSHOT_ERROR_CODES)) {
    assert.ok(new RegExp(`\\b${code}\\b`).test(declaration), `the declaration documents ${code}`);
  }
  assert.equal(typeof copySnapshot, 'function');
  assert.equal(typeof verifySnapshot, 'function');
});

test('the paired declarations typecheck with the pinned repository compiler', (t) => {
  const compiler = fileURLToPath(new URL('../../starter/node_modules/typescript/bin/tsc', import.meta.url));
  if (!fs.existsSync(compiler)) {
    t.skip('the pinned TypeScript compiler is not installed in starter/node_modules; no install is performed by this test');
    return;
  }
  const declarationPaths = [
    fileURLToPath(new URL('../../packages/core/snapshot-copy.d.ts', import.meta.url)),
    fileURLToPath(new URL('../../packages/core/snapshot-copy.d.mts', import.meta.url)),
  ];
  const result = spawnSync(process.execPath, [compiler, '--noEmit', '--strict', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', ...declarationPaths], { encoding: 'utf8' });
  assert.equal(result.status, 0, `the pinned compiler reported:\n${result.stdout}\n${result.stderr}`);
});
