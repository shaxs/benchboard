// C4.S1.T4a — independent order/import acceptance (order half).
//
// These tests accept the controller/staging sequence against the story contract
// using the shared T4a helpers only: real C3 verification and freeze APIs, real
// staging byte-copy with canonical replacement, controlled stage collaborators
// and a fake plain-tool runner. No Chromium, no server, no real process module.
// Expected grade shapes below are asserted here (not hidden in fixture
// construction): the 25 valid property IDs/areas, the 17-test visible value and
// the five useful-test fault domains.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateWithRuntime } from '../../packages/evaluation/controller.mjs';
import { OWNER_ROOT } from '../../packages/evaluation/staging.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { runTypecheckStage, runBuildStage, runVisibleStage } from '../../packages/evaluation/tool-stages.mjs';
import { createFrozenFixture, snapshotInputs, assertInputsUnchanged } from './helpers.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

// The established order the contract fixes. The names are the events the real
// controller and staging emit; deepEqual on the whole list asserts the exact
// sequence, not merely that each name occurred somewhere.
const ESTABLISHED_ORDER = Object.freeze([
  'verify-before',            // real C3 verification of the frozen submission
  'copy-frozen',              // frozen bytes copied into the staged product
  'canonical-replacement',    // canonical tooling and tests substituted
  'prepared-dependencies',    // prepared dependency tree copied
  'typecheck',
  'build',
  'visible',
  'browser',                  // loopback/browser stage with all 25 properties
  'useful',
  'verify-after',             // snapshot re-verification before inspection
  'inspection',               // inspectPublic on the frozen ORIGINAL
  'cleanup',
]);

const EXPECTED_PROPERTIES = Object.freeze([...Array.from({ length: 13 }, (_, i) => ['F' + String(i + 1).padStart(2, '0'), 'functional']),
  ...Array.from({ length: 4 }, (_, i) => ['P' + String(i + 1).padStart(2, '0'), 'persistence']),
  ...Array.from({ length: 4 }, (_, i) => ['E' + String(i + 1).padStart(2, '0'), 'edge']),
  ...Array.from({ length: 4 }, (_, i) => ['I' + String(i + 1).padStart(2, '0'), 'integration'])]);

test('real C3 verification precedes every stage and the full sequence runs in the exact established order', async t => {
  const f = await createFrozenFixture(t);
  const before = snapshotInputs(f);
  const result = await evaluateWithRuntime(f.request, f.runtime);
  assert.equal(result.status, 'success', JSON.stringify(result));

  // Exact ordering, asserted as one list (no "all names occurred" shortcut).
  assert.deepEqual(f.events.map(event => event.name), [...ESTABLISHED_ORDER]);
  assert.deepEqual(f.contexts.map(context => context.stage), ['typecheck', 'build', 'visible', 'browser', 'useful', 'inspection']);

  // C3 verification facts, not just an event name: the before event names the submission and the
  // snapshot re-verification sits between the useful stage and inspection.
  assert.deepEqual(f.events[0].facts.selection, f.request.submission);
  assert.ok(ESTABLISHED_ORDER.indexOf('verify-after') === 9);
  assert.ok(ESTABLISHED_ORDER.indexOf('inspection') === 10);

  // Snapshot digests: the run started from the saved C3 proof and ended identical.
  assert.equal(result.snapshot.before, f.frozen.proof.treeDigest);
  assert.equal(result.snapshot.after, result.snapshot.before);

  // Evidence shape asserted HERE (the test owns the expectation, not the fixture):
  assert.deepEqual(result.evidence.hidden.map(({ id, area }) => [id, area]), EXPECTED_PROPERTIES.map(([id, area]) => [id, area]));
  assert.equal(result.evidence.hidden.length, 25);
  assert.equal(result.evidence.visiblePassed, 17);
  assert.equal(result.evidence.noSuppression, true);
  assert.equal(result.evidence.usefulTests.method.split(';')[0].includes('persistence'), true);
  for (const domain of ['persistence', 'interaction', 'accessibility', 'normalization', 'chronology']) {
    assert.ok(result.evidence.usefulTests.method.includes(domain), 'five fault domains preserved: ' + domain);
  }
  assert.equal(result.score, null);
  assertInputsUnchanged(f, before);
});

test('inspection runs on the frozen ORIGINAL while every tool stage sees the STAGED product', async t => {
  const f = await createFrozenFixture(t);
  const result = await evaluateWithRuntime(f.request, f.runtime);
  assert.equal(result.status, 'success', JSON.stringify(result));

  const inspection = f.contexts.find(context => context.stage === 'inspection');
  assert.equal(inspection.appRoot, f.frozen.snapshotRoot, 'inspection appRoot must be the saved frozen snapshot, not a staged copy');

  for (const stage of ['typecheck', 'build', 'visible', 'browser', 'useful']) {
    const context = f.contexts.find(candidate => candidate.stage === stage);
    assert.notEqual(context.appRoot, f.frozen.snapshotRoot, stage + ' must run against the staged copy');
    // Scratch lives under the short OS temp root (Windows MAX_PATH), outside the run and repository.
    assert.ok(context.appRoot.startsWith(fs.realpathSync.native(os.tmpdir()) + path.sep), stage + ' product must live under the short scratch root');
    for (const root of [OWNER_ROOT, f.frozen.snapshotRoot, f.request.outputRoot]) assert.ok(!context.appRoot.startsWith(root + path.sep), stage + ' product must be outside ' + root);
  }

  // The copy-frozen event names the same staged product the tool stages later see.
  assert.equal(f.events.find(event => event.name === 'copy-frozen').facts.appRoot,
    f.contexts.find(context => context.stage === 'typecheck').appRoot);
});

test('the helper fake runProcess satisfies the accepted T1 result shape through the REAL plain tool stages without launching anything', async t => {
  const f = await createFrozenFixture(t);
  const helperSource = fs.readFileSync(new URL('./helpers.mjs', import.meta.url), 'utf8');
  // The fake never loads the real process implementation and never spawns: no import of
  // process.mjs and no child_process use in the helper source (checked as import forms so
  // prose cannot satisfy or break the check).
  assert.equal(/import[^;]*process\.mjs/.test(helperSource), false);
  assert.equal(/import[^;]*child_process/.test(helperSource), false);

  const appRoot = path.join(f.root, 'fake-tool-app');
  fs.mkdirSync(appRoot, { recursive: true });
  const base = stage => ({
    appRoot,
    artifactRoot: path.join(f.request.outputRoot, 'seam-' + stage),
    tempRoot: path.join(f.root, 'temp'),
    timeoutMs: 10000, maxOutputBytes: 1048576, signal: undefined,
    env: { TEMP: f.root, TMP: f.root, TMPDIR: f.root },
    runProcess: f.runtime.runProcess,
  });

  const typecheck = await runTypecheckStage(base('typecheck'));
  assert.equal(typecheck.status, 'success');
  assert.equal(typecheck.value, true);
  // T1-shaped completed result: reported integer exit code, no synthesized signal.
  assert.equal(typecheck.process.status, 'completed');
  assert.equal(typecheck.process.exitCode, 0);
  assert.equal(typecheck.process.signal, null);
  assert.equal(typeof typecheck.process.stdout, 'string');
  assert.equal(typecheck.process.stdoutLog, path.join(base('typecheck').artifactRoot, 'typecheck.stdout.log'));
  assert.ok(fs.existsSync(typecheck.process.stdoutLog), 'the requested log path is recorded');

  const build = await runBuildStage(base('build'));
  assert.equal(build.value, true);

  const visible = await runVisibleStage(base('visible'));
  assert.equal(visible.value.passed, 17);
  assert.equal(visible.value.total, 17);
  // The fake writes the valid 17-test JSON where the invocation requested it.
  assert.deepEqual(JSON.parse(fs.readFileSync(visible.value.reportPath, 'utf8')), { numPassedTests: 17, numTotalTests: 17 });
  assert.ok(fs.existsSync(path.join(base('visible').artifactRoot, 'visible.stdout.log')));
});

test('the reference variant replaces only the test-owned live workspace source before the freeze while the challenge binding stays the original starter', async t => {
  let sawWorkspace = null;
  const marker = 't4a-mutation-marker.txt';
  const f = await createFrozenFixture(t, {
    variant: 'reference',
    mutateWorkspace: async workspaceRoot => {
      sawWorkspace = workspaceRoot;
      fs.writeFileSync(path.join(workspaceRoot, marker), 'mutated before freeze\n');
    },
  });

  // mutateWorkspace received the live workspace root, never a snapshot path.
  assert.equal(sawWorkspace, f.run.workspace.root);

  // The mutation ran BEFORE the freeze: the saved snapshot carries it.
  assert.equal(fs.readFileSync(path.join(f.frozen.snapshotRoot, marker), 'utf8'), 'mutated before freeze\n');

  // The live workspace source carries reference bytes for a manifest file, and they differ from the starter.
  const referenceApp = fs.readFileSync(path.join(OWNER_ROOT, 'reference', 'src/App.tsx'));
  const starterApp = fs.readFileSync(path.join(OWNER_ROOT, 'starter', 'src/App.tsx'));
  assert.notEqual(referenceApp.toString('utf8'), starterApp.toString('utf8'));
  assert.deepEqual(fs.readFileSync(path.join(f.run.workspace.root, 'src/App.tsx')), referenceApp);

  // The sealed challenge binding is still the ORIGINAL starter challenge: the frozen reference bytes do not
  // change the bound workload digest, and the two domains are provably different here.
  assert.equal(f.run.manifest.bindings.challenge.workloadDigest, f.request.challenge.workloadDigest);
  assert.notEqual(f.frozen.proof.treeDigest, f.request.challenge.workloadDigest,
    'reference snapshot bytes must not be conflated with the bound starter workload digest');

  // The saved snapshot is never re-mutated afterwards.
  const before = snapshotInputs(f);
  const result = await evaluateWithRuntime(f.request, f.runtime);
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.snapshot.before, f.frozen.proof.treeDigest);
  assertInputsUnchanged(f, before);
});

test('the fixture request is the accepted public shape: manifest-digest expectedDigest and output outside the repository and the run container', async t => {
  const f = await createFrozenFixture(t);
  assert.equal(f.request.submission.expectedDigest, f.run.manifest.manifestDigest, 'expectedDigest is the C3 MANIFEST digest');
  for (const key of ['runRoot', 'runId', 'manifestId', 'snapshotId', 'frozenSubmissionId']) {
    assert.equal(typeof f.request.submission[key], 'string');
    assert.ok(f.request.submission[key].length >= 3);
  }
  assert.equal(f.request.submission.snapshotId, f.frozen.snapshotId);
  assert.equal(f.request.submission.frozenSubmissionId, f.frozen.frozenSubmission.frozenSubmissionId);
  // Output root is outside the repository and outside the run container.
  for (const container of [REPO_ROOT, f.run.output]) {
    const relativeOut = path.relative(container, f.request.outputRoot);
    assert.ok(relativeOut.startsWith('..') || path.isAbsolute(relativeOut), 'outputRoot must lie outside ' + container);
  }
  const tempRoot = fs.realpathSync(os.tmpdir()).toLowerCase();
  assert.ok(f.request.outputRoot.toLowerCase().startsWith(tempRoot), 'output lives in an external temporary directory, got ' + f.request.outputRoot);
  // No browser cache or environment override anywhere in the helper or these test sources.
  // The patterns are assembled from fragments so this check cannot match its own literal text.
  const forbidden = [
    new RegExp('process' + String.fromCharCode(46) + 'env' + String.fromCharCode(46) + '[A-Z_]+\\s*='),
    new RegExp(['PLAY', 'WRIGHT', '_[A-Z_]*PATH'].join('')),
    new RegExp(['BROWSER', '_?CACHE'].join('')),
    new RegExp(['chrom', 'ium', '\\.'].join('')),
  ];
  for (const source of [fs.readFileSync(new URL('./helpers.mjs', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('./stage-order.test.mjs', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('./import-graph.test.mjs', import.meta.url), 'utf8')]) {
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source), false, 'no browser-cache or environment override in helper or test source: ' + pattern.source);
    }
  }
});

test('canonical tooling/tests exist before any tool sees the product; original and staged input bytes stay unchanged', async t => {
  const f = await createFrozenFixture(t);
  const before = snapshotInputs(f);

  // Distinguishability first: the canonical bytes differ from the starter bytes,
  // so the in-stage probe below cannot pass vacuously.
  const starterLock = fs.readFileSync(path.join(OWNER_ROOT, 'starter', 'package-lock.json'));
  const canonicalLock = '{"lockfileVersion":3,"packages":{}}';
  assert.notEqual(starterLock.toString('utf8').slice(0, canonicalLock.length), canonicalLock);

  const originalTypecheck = f.runtime.stageOverrides.typecheck;
  let probed = false;
  f.runtime.stageOverrides.typecheck = async context => {
    // At the first tool stage the substitution must already be complete.
    assert.equal(fs.readFileSync(path.join(context.appRoot, 'package-lock.json'), 'utf8'), canonicalLock,
      'canonical package-lock must replace the participant copy before the first tool runs');
    assert.equal(fs.readFileSync(path.join(context.appRoot, 'tests/contracts.test.tsx'), 'utf8'),
      '// canonical visible test fixture\n', 'canonical visible test must replace the participant copy');
    assert.equal(fs.readFileSync(path.join(context.appRoot, 'tsconfig.json'), 'utf8'), '{}');
    assert.equal(fs.readFileSync(path.join(context.appRoot, 'vite.config.ts'), 'utf8'), 'export default {};');
    // Prepared dependencies were copied before the tool stage started.
    assert.equal(fs.readFileSync(path.join(context.appRoot, 'node_modules/typescript/bin/tsc'), 'utf8'), '// prepared typecheck placeholder\n');
    // The frozen original was NOT substituted: it still carries the starter bytes.
    assert.equal(fs.readFileSync(path.join(f.frozen.snapshotRoot, 'package-lock.json'), 'utf8'), starterLock.toString('utf8'));
    probed = true;
    return originalTypecheck(context);
  };

  const result = await evaluateWithRuntime(f.request, f.runtime);
  assert.equal(probed, true, 'the typecheck stage override must have run');
  assert.equal(result.status, 'success', JSON.stringify(result));
  assertInputsUnchanged(f, before);
  assert.equal(inventoryTree({ root: f.frozen.snapshotRoot, skipNames: [] }).digest, f.frozen.proof.treeDigest);
});
