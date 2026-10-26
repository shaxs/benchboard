// Captain-owned reset containment and inherited-declaration proofs. Child acceptance is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realRunFixture } from './run-fixture.mjs';
import { prepareResetContext, summariseReset } from '../../cli/reset-context.mjs';
import { ensureResultsContext } from '../../cli/run-context.mjs';
import { resetRun } from '../../packages/core/reset.mjs';
import { inventoryTree, createId, sha256 } from '../../packages/core/identity.mjs';
import { identityDigestOf, validateRecord } from '../../packages/core/manifest.mjs';
import { initialiseRun } from '../../packages/core/init.mjs';
import { prepareChallengeSource } from '../../cli/challenge-source.mjs';
import { diagnosticOf } from '../../cli/diagnostics.mjs';

test('reset request protects retained results, repository and old container without creating a destination', async t => {
  const f = await realRunFixture(t), results = await ensureResultsContext(f.opened);
  fs.writeFileSync(path.join(results.storeRoot, 'synthetic-private-canary.txt'), 'Synthetic private old results, not a committed report.');
  const before = inventoryTree({ root: f.run.output, skipNames: [] });
  const resultsBefore = inventoryTree({ root: results.resultsRoot, skipNames: [] });
  for (const output of [path.join(results.resultsRoot, 'forbidden-reset'), path.join(f.run.output, 'forbidden-reset'), path.join(f.installation.root, 'forbidden-reset')]) {
    await assert.rejects(prepareResetContext({ '--run': f.run.output, '--output': output }), error => diagnosticOf(error).exitCode === 4);
    assert.equal(fs.existsSync(output), false);
  }
  assert.deepEqual(inventoryTree({ root: f.run.output, skipNames: [] }), before);
  assert.deepEqual(inventoryTree({ root: results.resultsRoot, skipNames: [] }), resultsBefore);
});

test('a linked destination ancestor or substituted results root is refused without entering foreign canaries', async t => {
  const f = await realRunFixture(t), results = await ensureResultsContext(f.opened);
  const foreign = path.join(f.root, 'test-owned foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'canary.txt'), 'Preserve foreign bytes.');
  const before = inventoryTree({ root: foreign, skipNames: [] });
  const linkedParent = path.join(f.root, 'linked parent');
  fs.symlinkSync(foreign, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareResetContext({ '--run': f.run.output, '--output': path.join(linkedParent, 'never-output') }), error => diagnosticOf(error).exitCode === 4);
  const moved = `${results.resultsRoot}-original`;
  fs.renameSync(results.resultsRoot, moved);
  t.after(() => fs.rmSync(moved, { recursive: true, force: true, maxRetries: 4 }));
  fs.symlinkSync(foreign, results.resultsRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const output = path.join(f.root, 'never-created output');
  await assert.rejects(prepareResetContext({ '--run': f.run.output, '--output': output }), error => diagnosticOf(error).exitCode === 4);
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(inventoryTree({ root: foreign, skipNames: [] }), before);
});

test('fresh reset inherits known declarations and architecture, not lifecycle or results, through unchanged core', async t => {
  const f = await realRunFixture(t), before = inventoryTree({ root: f.run.output, skipNames: [] });
  const output = path.join(f.root, 'fresh reset');
  const context = await prepareResetContext({ '--run': f.run.output, '--output': output });
  t.after(() => context.dispose());
  assert.equal(context.request.initializationRequest.architectureId, f.opened.manifest.architectureId);
  assert.equal(context.request.initializationRequest.configuration.model, 'synthetic-explicit-model');
  assert.deepEqual(context.request.initializationRequest.dependencies, { mode: 'none' });
  assert.equal(inventoryTree({ root: context.request.initializationRequest.challenge.sourceRoot, skipNames: [] }).entries.length, 26);
  let result, cleanup;
  try { result = await resetRun(context.request); } finally { cleanup = context.dispose(); }
  const summary = summariseReset(result, cleanup);
  assert.equal(cleanup.status, 'removed');
  assert.equal(fs.existsSync(cleanup.root), false);
  assert.notEqual(summary.runId, f.opened.runId);
  assert.notEqual(summary.manifestId, f.opened.manifestId);
  assert.equal(result.manifest.architectureId, f.opened.manifest.architectureId);
  assert.equal(result.manifest.configuration.model, 'synthetic-explicit-model');
  assert.equal(summary.fresh, true);
  assert.equal(summary.oldContainerMutation, 'none');
  assert.equal(summary.source.runId, f.opened.runId);
  assert.equal(summary.workloadDigest, f.installation.descriptor.workloadDigest);
  assert.equal(fs.existsSync(`${f.run.output}.benchboard-results`), false);
  assert.deepEqual(inventoryTree({ root: f.run.output, skipNames: [] }), before);
});

test('reset validates mode prerequisites before source staging and retains relative-output integrity refusal', async t => {
  const f = await realRunFixture(t), output = path.join(f.root, 'uncreated');
  const options = { '--run': f.run.output, '--output': output };
  for (const extra of [{ '--dependency-mode': 'prepared' }, { '--dependency-mode': 'prepared', '--prepared-root': f.root }, { '--prepared-root': f.root }]) {
    await assert.rejects(prepareResetContext({ ...options, ...extra }), error => diagnosticOf(error).exitCode === 3);
  }
  await assert.rejects(prepareResetContext({ ...options, '--dependency-mode': 'unknown' }), error => diagnosticOf(error).exitCode === 2);
  await assert.rejects(prepareResetContext({ ...options, '--output': 'relative-private-canary' }), error => diagnosticOf(error).exitCode === 4);
  assert.equal(fs.existsSync(output), false);
});

test('actual reset refuses a valid self-consistent foreign tooling binding without silently upgrading it', async t => {
  const f = await realRunFixture(t), prepared = prepareChallengeSource(f.installation);
  // Synthetic earlier/foreign tooling record: valid C1 bookkeeping, NOT proof
  // that any real older release executed this run. The CLI must refuse the mismatch.
  const tooling = structuredClone(f.installation.toolingIdentity);
  delete tooling.identityDigest;
  tooling.installedDigest = sha256('synthetic different selected tooling bytes');
  tooling.revision = `development:${tooling.installedDigest}`;
  tooling.identityDigest = identityDigestOf(tooling);
  validateRecord('ToolingIdentity', tooling);
  let old;
  try {
    old = await initialiseRun({ output: path.join(f.root, 'foreign tooling run'),
      challenge: { ...f.installation.challenge, sourceRoot: prepared.sourceRoot }, toolingIdentity: tooling,
      evaluatorIdentity: f.installation.evaluatorIdentity, architectureId: createId('architecture'), harness: 'manual', dependencies: { mode: 'none' } });
  } finally { prepared.dispose(); }
  const before = inventoryTree({ root: old.output, skipNames: [] }), output = path.join(f.root, 'never upgraded');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../cli/benchboard.mjs', import.meta.url)),
    'reset', '--run', old.output, '--output', output], { cwd: f.root, encoding: 'utf8', shell: false,
    timeout: 15000, maxBuffer: 1048576, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^CLI_INTEGRITY:/);
  assert.equal(result.stderr.includes(f.root), false);
  assert.equal(result.stderr.includes('\n    at '), false);
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(inventoryTree({ root: old.output, skipNames: [] }), before);
});
