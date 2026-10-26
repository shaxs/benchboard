import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { initialiseRun } from '../../packages/core/init.mjs';
import { freezeRun } from '../../packages/core/freeze.mjs';
import { startRun } from '../../packages/core/lifecycle.mjs';
import { loadFixture } from '../contracts/fixtures/contracts/index.mjs';
import { stageFrozen, cleanupScratch, assertDirectoryChain, validateEvaluationRequest, verifySelection, OWNER_ROOT } from '../../packages/evaluation/staging.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-eval-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshotRoot = path.join(root, 'frozen'), canonicalRoot = path.join(root, 'canonical');
  const put = (base, relative, bytes) => { const to = path.join(base, relative); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, bytes); };
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'tests/contracts.test.tsx']) {
    put(snapshotRoot, name, 'participant-' + name);
    put(canonicalRoot, name, 'canonical-' + name);
  }
  put(snapshotRoot, 'src/app.ts', 'unchanged');
  put(snapshotRoot, 'tests/added.test.ts', 'participant extra');
  for (const name of ['typescript/bin/tsc', 'vite/bin/vite.js', 'vitest/vitest.mjs']) put(canonicalRoot, 'node_modules/' + name, 'prepared');
  const treeDigest = inventoryTree({ root: snapshotRoot, skipNames: [] }).digest;
  return { root, snapshotRoot, treeDigest, canonicalRoot, outputRoot: path.join(root, 'evaluation') };
}

test('canonical scratch overlay preserves added tests and frozen originals, and cleans only scratch', async t => {
  const f = fixture(t), events = [];
  const claim = await stageFrozen(f, f, { canonicalRoot: f.canonicalRoot, onEvent: name => events.push(name) });
  assert.deepEqual(events, ['copy-frozen', 'canonical-replacement', 'prepared-dependencies']);
  assert.equal(fs.readFileSync(path.join(claim.appRoot, 'package.json'), 'utf8'), 'canonical-package.json');
  assert.equal(fs.readFileSync(path.join(claim.appRoot, 'tests/contracts.test.tsx'), 'utf8'), 'canonical-tests/contracts.test.tsx');
  assert.equal(fs.readFileSync(path.join(claim.appRoot, 'tests/added.test.ts'), 'utf8'), 'participant extra');
  assert.equal(inventoryTree({ root: f.snapshotRoot, skipNames: [] }).digest, f.treeDigest);
  fs.writeFileSync(path.join(f.outputRoot, 'retained.log'), 'diagnostic');
  fs.mkdirSync(path.join(claim.appRoot, 'dist')); fs.writeFileSync(path.join(claim.appRoot, 'dist/app.js'), 'generated');
  assert.deepEqual(cleanupScratch(claim), { removed: true, residue: [], errors: [] });
  assert.equal(fs.existsSync(claim.scratchRoot), false);
  assert.equal(fs.readFileSync(path.join(f.outputRoot, 'retained.log'), 'utf8'), 'diagnostic');
});

test('missing prerequisites refuse before creating evaluation output', async t => {
  const f = fixture(t);
  await assert.rejects(stageFrozen(f, f, { canonicalRoot: f.canonicalRoot, dependencyRoot: path.join(f.root, 'absent') }), error => error.code === 'MISSING_PREREQUISITE');
  assert.equal(fs.existsSync(f.outputRoot), false);
});

test('source mismatch refuses before staging', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.snapshotRoot, 'src/app.ts'), 'tampered');
  await assert.rejects(stageFrozen(f, f, { canonicalRoot: f.canonicalRoot }), error => error.code === 'SNAPSHOT_REFUSED');
  assert.equal(fs.existsSync(f.outputRoot), false);
});

test('junctions in source/dependencies and linked ancestors are refused without following them', async t => {
  for (const location of ['source', 'dependencies']) {
    const f = fixture(t), foreign = path.join(f.root, 'foreign'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'canary'), 'keep');
    const link = path.join(location === 'source' ? f.snapshotRoot : path.join(f.canonicalRoot, 'node_modules'), 'injected');
    fs.symlinkSync(foreign, link, 'junction');
    await assert.rejects(stageFrozen(f, f, { canonicalRoot: f.canonicalRoot }), /[Ll]ink/);
    assert.equal(fs.readFileSync(path.join(foreign, 'canary'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(f.outputRoot), false);
    assert.throws(() => assertDirectoryChain(link), /[Ll]ink/);
  }
});

test('cleanup preserves a replaced root and unexpected foreign insertion as disclosed residue', async t => {
  for (const replace of [true, false]) {
    const f = fixture(t), claim = await stageFrozen(f, f, { canonicalRoot: f.canonicalRoot });
    if (replace) { fs.renameSync(claim.scratchRoot, claim.scratchRoot + '-original'); fs.mkdirSync(claim.scratchRoot); }
    fs.writeFileSync(path.join(claim.scratchRoot, 'foreign-canary'), 'keep');
    const result = cleanupScratch(claim);
    assert.equal(result.removed, false); assert.equal(result.errors[0].code, 'CLEANUP_FAILED');
    assert.equal(fs.readFileSync(path.join(claim.scratchRoot, 'foreign-canary'), 'utf8'), 'keep');
  }
});

test('pre-aborted staging creates no output', async t => {
  const f = fixture(t);
  await assert.rejects(stageFrozen(f, { ...f, signal: AbortSignal.abort() }, { canonicalRoot: f.canonicalRoot }), error => error.code === 'CANCELLED');
  assert.equal(fs.existsSync(f.outputRoot), false);
});

test('generated Vite cache content can be atomically replaced beneath its still-owned cache root', async t => {
  const f = fixture(t), cache = path.join(f.canonicalRoot, 'node_modules/.vite');
  fs.mkdirSync(path.join(cache, 'deps'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'deps', 'generated.js'), 'copied cache');
  const claim = await stageFrozen(f, f, { canonicalRoot: f.canonicalRoot });
  const stagedCache = path.join(claim.appRoot, 'node_modules/.vite');
  fs.renameSync(path.join(stagedCache, 'deps'), path.join(stagedCache, 'deps-retired'));
  fs.mkdirSync(path.join(stagedCache, 'deps'));
  fs.writeFileSync(path.join(stagedCache, 'deps', 'generated.js'), 'fresh tool cache');
  assert.deepEqual(cleanupScratch(claim), { removed: true, residue: [], errors: [] });
  assert.equal(inventoryTree({ root: f.snapshotRoot, skipNames: [] }).digest, f.treeDigest);
});

test('generated-cache allowance never adopts replaced cache/dependency roots or another dependency', async t => {
  for (const replace of ['node_modules/.vite', 'node_modules', 'node_modules/typescript/bin/tsc']) {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.canonicalRoot, 'node_modules/.vite/deps'), { recursive: true });
    const claim = await stageFrozen(f, f, { canonicalRoot: f.canonicalRoot });
    const target = path.join(claim.appRoot, replace);
    fs.renameSync(target, target + '-original');
    if (replace.endsWith('/tsc')) fs.writeFileSync(target, 'foreign-canary');
    else { fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'foreign-canary'), 'keep'); }
    const result = cleanupScratch(claim);
    assert.equal(result.removed, false); assert.equal(result.errors[0].code, 'CLEANUP_FAILED');
    assert.equal(fs.existsSync(replace.endsWith('/tsc') ? target : path.join(target, 'foreign-canary')), true);
  }
});

test('generated-cache allowance refuses a junction and preserves external content', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.canonicalRoot, 'node_modules/.vite/deps'), { recursive: true });
  const claim = await stageFrozen(f, f, { canonicalRoot: f.canonicalRoot });
  const external = path.join(f.root, 'external'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'canary'), 'keep');
  fs.symlinkSync(external, path.join(claim.appRoot, 'node_modules/.vite/deps/linked'), 'junction');
  assert.equal(cleanupScratch(claim).removed, false);
  assert.equal(fs.readFileSync(path.join(external, 'canary'), 'utf8'), 'keep');
});

test('special dependency entries are refused before any write (deterministic lstat branch)', async t => {
  const f = fixture(t), target = path.join(f.canonicalRoot, 'node_modules/typescript/bin/tsc');
  const original = fs.lstatSync;
  const probe = t.mock.method(fs, 'lstatSync', function (at, ...args) {
    const stat = original.call(fs, at, ...args);
    if (String(at) !== target) return stat;
    return { ...stat, isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false };
  });
  try {
    await assert.rejects(stageFrozen(f, f, { canonicalRoot: f.canonicalRoot }), error => error.code === 'UNSAFE_ENTRY');
    assert.equal(fs.existsSync(f.outputRoot), false);
  } finally { probe.mock.restore(); }
});

test('internal staging seam independently refuses protected/source overlap and existing output', async t => {
  const f = fixture(t);
  for (const outputRoot of [path.join(OWNER_ROOT, 'evaluator', 'must-not-create'), f.snapshotRoot, f.root, f.canonicalRoot]) {
    await assert.rejects(stageFrozen(f, { ...f, outputRoot }, { canonicalRoot: f.canonicalRoot }), error => error.code === 'ROOTS_OVERLAP');
  }
  fs.mkdirSync(f.outputRoot); fs.writeFileSync(path.join(f.outputRoot, 'foreign-canary'), 'keep');
  await assert.rejects(stageFrozen(f, f, { canonicalRoot: f.canonicalRoot }), error => error.code === 'OUTPUT_EXISTS');
  assert.equal(fs.readFileSync(path.join(f.outputRoot, 'foreign-canary'), 'utf8'), 'keep');
});

test('partial-staging fault never adopts a foreign insertion for cleanup', async t => {
  const f = fixture(t); let inserted;
  await assert.rejects(stageFrozen(f, f, { canonicalRoot: f.canonicalRoot, onEvent: (_name, facts) => {
    inserted = path.join(path.dirname(facts.appRoot), 'foreign-canary');
    fs.writeFileSync(inserted, 'keep');
    throw new Error('controlled staging fault');
  } }), error => error.message === 'controlled staging fault' && error.cleanup.removed === false && error.cleanup.errors[0].code === 'CLEANUP_FAILED');
  assert.equal(fs.readFileSync(inserted, 'utf8'), 'keep');
});

test('a linked replacement between copy and canonical overlay is never written through', async t => {
  const f = fixture(t), foreign = path.join(f.root, 'foreign');
  fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'package.json'), 'foreign-canary');
  await assert.rejects(stageFrozen(f, f, { canonicalRoot: f.canonicalRoot, onEvent: (name, facts) => {
    if (name !== 'copy-frozen') return;
    fs.renameSync(facts.appRoot, facts.appRoot + '-owned');
    fs.symlinkSync(foreign, facts.appRoot, 'junction');
  } }), /replaced|[Ll]ink/);
  assert.equal(fs.readFileSync(path.join(foreign, 'package.json'), 'utf8'), 'foreign-canary');
});

async function realRun(t, freeze = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-eval-c3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = JSON.parse(fs.readFileSync(new URL('../../release/inventory.json', import.meta.url))).participant.files.map(e => e.path);
  const sourceRoot = path.join(root, 'source');
  for (const name of paths) {
    const to = path.join(sourceRoot, name); fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(OWNER_ROOT, 'starter', name), to);
  }
  const challenge = structuredClone(loadFixture('challenge.identity'));
  const inventory = inventoryTree({ root: sourceRoot, skipNames: [] });
  challenge.starterInventory = inventory.entries.map(e => [e.path, e.sha256]);
  challenge.workloadDigest = inventory.digest;
  const evaluator = structuredClone(loadFixture('evaluator.identity'));
  const run = await initialiseRun({
    output: path.join(root, 'run'), challenge: { identity: challenge, sourceRoot, fileManifest: paths, ownerRoots: [OWNER_ROOT], evaluatorRoots: [path.join(OWNER_ROOT, 'evaluator')] },
    toolingIdentity: structuredClone(loadFixture('tooling.identity')), evaluatorIdentity: evaluator,
    architectureId: 'evaluation-test-run', harness: 'manual', dependencies: { mode: 'none' },
  });
  const binding = { runRoot: run.output, runId: run.manifest.runId, manifestId: run.manifest.manifestId, expectedDigest: run.manifest.manifestDigest };
  let saved;
  if (freeze) saved = await freezeRun({ ...binding, clockless: true, attestation: { operator: 'test-operator', agentStopped: true, statement: 'Controlled test workspace is stopped.', clockless: true } });
  return { root, run, request: { challenge, evaluator, outputRoot: path.join(root, 'evaluation'), submission: { ...binding, snapshotId: saved?.snapshotId ?? 'snap-unpublished', frozenSubmissionId: saved?.frozenSubmission.frozenSubmissionId ?? 'submission-unpublished' } } };
}

test('real C3 verification binds identities, accepts saved bytes despite later live edits, and detects tampering', async t => {
  const f = await realRun(t);
  const request = validateEvaluationRequest(f.request);
  const verified = await verifySelection(request);
  assert.equal(verified.workspaceMatchesFrozen, true);
  fs.appendFileSync(path.join(f.run.workspace.root, 'src/App.tsx'), '\n// later live edit\n');
  assert.equal((await verifySelection(request)).workspaceMatchesFrozen, false);
  const wrong = structuredClone(request); wrong.evaluator.notes = 'changed binding';
  await assert.rejects(verifySelection(wrong), error => error.code === 'IDENTITY_MISMATCH');
  fs.appendFileSync(path.join(verified.snapshotRoot, 'src/App.tsx'), '\n// frozen tampering\n');
  await assert.rejects(verifySelection(request), error => error.code === 'SNAPSHOT_REFUSED');
  assert.equal(fs.existsSync(request.outputRoot), false);
});

test('active and incomplete/unpublished C3 runs are refused without staging', async t => {
  const f = await realRun(t, false);
  const request = validateEvaluationRequest(f.request);
  await assert.rejects(verifySelection(request), error => error.code === 'SNAPSHOT_REFUSED');
  await startRun({ runRoot: f.run.output, runId: f.run.manifest.runId, manifestId: f.run.manifest.manifestId,
    declaration: { harness: 'manual', model: null, workerCount: null, executionMode: 'MANUAL', declaredCeilingMinutes: null } });
  await assert.rejects(verifySelection(request), error => error.code === 'SNAPSHOT_REFUSED');
  assert.equal(fs.existsSync(request.outputRoot), false);
});

test('public request refuses protected/run overlaps, existing output, unknown options and noncanonical paths', async t => {
  const f = await realRun(t);
  for (const outputRoot of [path.join(OWNER_ROOT, 'artifacts', 'never-create'), path.join(f.run.output, 'evaluations'), f.root + path.sep + '..' + path.sep + path.basename(f.root) + path.sep + 'alias']) {
    assert.throws(() => validateEvaluationRequest({ ...f.request, outputRoot }), /overlap|disjoint|absolute/i);
  }
  assert.throws(() => validateEvaluationRequest({ ...f.request, runtime: {} }), /Unknown/);
  assert.throws(() => validateEvaluationRequest({ ...f.request, challenge: {} }), error => error.name === 'EvaluationRefusalError' && error.code === 'IDENTITY_INVALID');
  assert.throws(() => validateEvaluationRequest({ ...f.request, outputRoot: path.join(f.root, 'absent-parent', 'output') }), error => error.name === 'EvaluationRefusalError' && error.code === 'INVALID_PATH');
  assert.throws(() => validateEvaluationRequest({ ...f.request, outputRoot: f.root }), /disjoint/);
  fs.mkdirSync(f.request.outputRoot);
  assert.throws(() => validateEvaluationRequest(f.request), /exclusively new/);
});

test('physical-alias public refusal: ordinary alias parent resolves inside run/repository (deterministic native-realpath branch)', async t => {
  const f = await realRun(t);
  const aliasParent = path.join(f.root, 'ordinary-alias-parent'); fs.mkdirSync(aliasParent);
  const outputRoot = path.join(aliasParent, 'must-not-create');
  for (const physicalTarget of [f.run.output, path.join(OWNER_ROOT, 'artifacts')].filter(target => fs.existsSync(target))) {
    const native = fs.realpathSync.native;
    const probe = t.mock.method(fs.realpathSync, 'native', (at, ...args) => path.resolve(String(at)) === aliasParent ? physicalTarget : native(at, ...args));
    try {
      assert.throws(() => validateEvaluationRequest({ ...f.request, outputRoot }), error => error.code === 'ROOTS_OVERLAP');
      assert.equal(fs.existsSync(outputRoot), false);
    } finally { probe.mock.restore(); }
  }
});

test('physical-alias internal refusal: alias parent resolves under protected inputs before any staging write', async t => {
  for (const target of ['canonicalRoot', 'snapshotRoot', 'dependencies']) {
    const f = fixture(t), aliasParent = path.join(f.root, 'ordinary-alias-parent'); fs.mkdirSync(aliasParent);
    const outputRoot = path.join(aliasParent, 'must-not-create');
    const native = fs.realpathSync.native;
    const physicalTarget = target === 'dependencies' ? path.join(f.canonicalRoot, 'node_modules') : f[target];
    const probe = t.mock.method(fs.realpathSync, 'native', (at, ...args) => path.resolve(String(at)) === aliasParent ? physicalTarget : native(at, ...args));
    try {
      await assert.rejects(stageFrozen(f, { ...f, outputRoot }, { canonicalRoot: f.canonicalRoot }), error => error.code === 'ROOTS_OVERLAP');
      assert.equal(fs.existsSync(outputRoot), false);
    } finally { probe.mock.restore(); }
  }
});

test('physical Windows short-name alias cannot bypass the run-output boundary', async t => {
  if (process.platform !== 'win32') { t.skip('Windows8.3 alias capability only; deterministic realpath refusal is independently tested'); return; }
  const f = await realRun(t);
  // Read-only short-path expansion; no drive mapping, service control or filesystem mutation.
  const command = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  const result = spawnSync(command, ['/d', '/c', `for %I in ("${f.run.output}") do @echo %~sI`], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(result.status, 0, 'read-only Windows short-name query failed: ' + result.stderr);
  const alias = result.stdout.trim();
  assert.ok(path.isAbsolute(alias));
  if (alias.toLowerCase() === f.run.output.toLowerCase() || !/~\d/.test(alias)) {
    t.skip('this volume/path exposes no distinct8.3 short-name alias; deterministic native-realpath branch covers refusal, not a physical capability PASS'); return;
  }
  const outputRoot = path.join(alias, 'must-not-create');
  assert.throws(() => validateEvaluationRequest({ ...f.request, outputRoot }), error => error.code === 'ROOTS_OVERLAP');
  assert.equal(fs.existsSync(outputRoot), false);
});

test('real prepared dependency bytes stage and retire without launching tools or browsers', async t => {
  const f = fixture(t);
  const claim = await stageFrozen(f, f);
  assert.equal(fs.readFileSync(path.join(claim.appRoot, 'node_modules/typescript/bin/tsc'), 'utf8'), fs.readFileSync(path.join(OWNER_ROOT, 'starter/node_modules/typescript/bin/tsc'), 'utf8'));
  const result = cleanupScratch(claim);
  assert.deepEqual(result, { removed: true, residue: [], errors: [] });
  assert.equal(fs.existsSync(claim.scratchRoot), false);
});

test('scratch is staged under a short scratch parent, never inside the attempt output root', async t => {
  const f = fixture(t), parent = path.join(f.root, 'short');
  fs.mkdirSync(parent);
  const claim = await stageFrozen(f, f, { canonicalRoot: f.canonicalRoot, scratchParent: parent });
  assert.equal(path.dirname(claim.scratchRoot), fs.realpathSync.native(parent));
  assert.match(path.basename(claim.scratchRoot), /^bbs-/);
  assert.deepEqual(fs.readdirSync(f.outputRoot), []);
  assert.deepEqual(cleanupScratch(claim), { removed: true, residue: [], errors: [] });
  assert.equal(fs.existsSync(claim.scratchRoot), false);
});

test('a scratch parent inside a protected root is refused before any output exists', async t => {
  const f = fixture(t);
  await assert.rejects(stageFrozen(f, f, { canonicalRoot: f.canonicalRoot, scratchParent: f.canonicalRoot }), error => error.code === 'ROOTS_OVERLAP');
  assert.equal(fs.existsSync(f.outputRoot), false);
});

test('on Windows a scratch parent too deep for executables and Chromium refuses at once with PATH_TOO_LONG', { skip: process.platform !== 'win32' && 'Windows MAX_PATH only' }, async t => {
  const f = fixture(t);
  let deep = f.root;
  while (deep.length < 200) deep = path.join(deep, 'deep-folder-segment');
  fs.mkdirSync(deep, { recursive: true });
  await assert.rejects(stageFrozen(f, f, { canonicalRoot: f.canonicalRoot, scratchParent: deep }),
    error => error.code === 'PATH_TOO_LONG' && /shorter folder/.test(error.message));
  assert.equal(fs.existsSync(f.outputRoot), false);
  assert.deepEqual(fs.readdirSync(deep), []);
});
