import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialiseRun } from '../../packages/core/init.mjs';
import { freezeRun } from '../../packages/core/freeze.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { loadFixture } from '../contracts/fixtures/contracts/index.mjs';
import { OWNER_ROOT } from '../../packages/evaluation/staging.mjs';
import { EvaluationInfrastructureError, stageSuccess } from '../../packages/evaluation/contracts.mjs';
import { evaluateWithRuntime } from '../../packages/evaluation/controller.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-eval-controller-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = JSON.parse(fs.readFileSync(new URL('../../release/inventory.json', import.meta.url))).participant.files.map(e => e.path);
  const sourceRoot = path.join(root, 'source');
  const put = (base, name, bytes) => { const to = path.join(base, name); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, bytes); };
  for (const name of paths) put(sourceRoot, name, fs.readFileSync(path.join(OWNER_ROOT, 'starter', name)));
  const challenge = structuredClone(loadFixture('challenge.identity'));
  const original = inventoryTree({ root: sourceRoot, skipNames: [] });
  challenge.starterInventory = original.entries.map(e => [e.path, e.sha256]); challenge.workloadDigest = original.digest;
  const evaluator = structuredClone(loadFixture('evaluator.identity'));
  const run = await initialiseRun({ output: path.join(root, 'run'), challenge: { identity: challenge, sourceRoot, fileManifest: paths, ownerRoots: [OWNER_ROOT], evaluatorRoots: [path.join(OWNER_ROOT, 'evaluator')] }, toolingIdentity: structuredClone(loadFixture('tooling.identity')), evaluatorIdentity: evaluator, architectureId: 'controller-fixture-run', harness: 'manual', dependencies: { mode: 'none' } });
  const frozen = await freezeRun({ runRoot: run.output, runId: run.manifest.runId, manifestId: run.manifest.manifestId, clockless: true, attestation: { operator: 'test-operator', agentStopped: true, statement: 'Controlled controller fixture is stopped.', clockless: true } });
  const canonicalRoot = path.join(root, 'canonical');
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'tests/contracts.test.tsx', 'tests/setup.ts']) put(canonicalRoot, name, 'canonical-' + name);
  for (const tool of ['typescript/bin/tsc', 'vite/bin/vite.js', 'vitest/vitest.mjs']) put(canonicalRoot, 'node_modules/' + tool, 'controlled tool fixture');
  const events = [], contexts = [], properties = [];
  for (const [prefix, area, count] of [['F', 'functional', 13], ['P', 'persistence', 4], ['E', 'edge', 4], ['I', 'integration', 4]]) for (let i = 1; i <= count; i++) properties.push({ id: prefix + String(i).padStart(2, '0'), area, passed: true });
  const values = { typecheck: true, build: true, visible: { passed: 17, total: 17, reportPath: 'controlled' }, browser: properties, useful: { addedCount: 0, baselinePassed: false, killedMutations: [] }, inspection: { noSuppression: true, hygiene: { visibleIntact: true, lockedDependencies: true, noSecrets: true, noDebugLogging: true, noNetwork: true }, analysisMethod: 'controlled inspection fixture' } };
  const stageOverrides = Object.fromEntries(Object.entries(values).map(([stage, value]) => [stage, async ctx => {
    contexts.push({ stage, ...ctx });
    fs.writeFileSync(path.join(ctx.artifactRoot, 'stdout.log'), stage + ' diagnostic');
    return stageSuccess(stage, value);
  }]));
  const request = { challenge, evaluator, outputRoot: path.join(root, 'evaluation'), submission: { runRoot: run.output, runId: run.manifest.runId, manifestId: run.manifest.manifestId, expectedDigest: run.manifest.manifestDigest, snapshotId: frozen.snapshotId, frozenSubmissionId: frozen.frozenSubmission.frozenSubmissionId } };
  const runtime = { canonicalRoot, runProcess: async () => { throw Error('fake stage must not start a process'); }, preflight: async () => {}, stageOverrides, onEvent: (name, facts) => events.push({ name, facts }) };
  return { root, run, frozen, request, runtime, events, contexts };
}

test('controller uses real C3 gates, exact established order and frozen-source inspection, then cleans scratch', async t => {
  const f = await fixture(t), result = await evaluateWithRuntime(f.request, f.runtime);
  assert.equal(result.status, 'success'); assert.equal(result.score, null);
  assert.deepEqual(f.events.map(e => e.name), ['verify-before', 'copy-frozen', 'canonical-replacement', 'prepared-dependencies', 'typecheck', 'build', 'visible', 'browser', 'useful', 'verify-after', 'inspection', 'cleanup']);
  assert.equal(f.contexts.find(c => c.stage === 'inspection').appRoot, f.frozen.snapshotRoot);
  const toolContext = f.contexts.find(c => c.stage === 'typecheck');
  assert.notEqual(toolContext.appRoot, f.frozen.snapshotRoot);
  assert.equal(toolContext.env.TEMP, toolContext.tempRoot); assert.equal(toolContext.env.TMP, toolContext.tempRoot); assert.equal(toolContext.env.TMPDIR, toolContext.tempRoot);
  assert.equal(fs.existsSync(path.dirname(toolContext.appRoot)), false);
  assert.equal(result.snapshot.before, f.frozen.proof.treeDigest); assert.equal(result.snapshot.after, result.snapshot.before);
  assert.equal(result.evidence.visiblePassed, 17); assert.equal(result.evidence.hidden.length, 25);
  assert.equal(result.cleanup.removed, true); assert.ok(result.artifacts.includes('browser/stdout.log'));
  assert.equal(result.environment.label, null); assert.equal(result.environment.browserVersion, null);
});

test('controller infrastructure failure returns no score/evidence, stops stages, preserves logs and inputs', async t => {
  const f = await fixture(t);
  const before = inventoryTree({ root: f.frozen.snapshotRoot, skipNames: [] }).digest;
  f.runtime.stageOverrides.build = async ctx => { fs.writeFileSync(path.join(ctx.artifactRoot, 'stdout.log'), 'before timeout'); throw new EvaluationInfrastructureError('build', 'TIMEOUT', 'controlled build timeout'); };
  const result = await evaluateWithRuntime(f.request, f.runtime);
  assert.equal(result.status, 'infrastructure-error'); assert.equal(result.error.code, 'TIMEOUT'); assert.equal(result.error.stage, 'build');
  assert.equal(result.evidence, null); assert.equal(result.score, null);
  assert.equal(f.events.some(e => e.name === 'visible'), false); assert.equal(f.events.some(e => e.name === 'inspection'), false);
  assert.equal(result.cleanup.removed, true); assert.equal(fs.existsSync(path.join(f.request.outputRoot, 'build/stdout.log')), true);
  assert.equal(inventoryTree({ root: f.frozen.snapshotRoot, skipNames: [] }).digest, before);
});

test('public request cannot select internal runtime or test roots, even through internal controller call', async t => {
  const f = await fixture(t);
  for (const extra of [{ runtime: f.runtime }, { canonicalRoot: f.runtime.canonicalRoot }, { stageOverrides: {} }]) {
    await assert.rejects(evaluateWithRuntime({ ...f.request, ...extra }, f.runtime), error => error.name === 'EvaluationRefusalError');
  }
  assert.equal(fs.existsSync(f.request.outputRoot), false);
});

test('preflight failure never adopts a foreign output that appears before staging', async t => {
  const f = await fixture(t);
  f.runtime.preflight = async () => {
    fs.mkdirSync(f.request.outputRoot);
    fs.writeFileSync(path.join(f.request.outputRoot, 'foreign-canary'), 'keep');
    throw new EvaluationInfrastructureError('preflight', 'MISSING_PREREQUISITE', 'controlled missing prerequisite');
  };
  const result = await evaluateWithRuntime(f.request, f.runtime);
  assert.equal(result.status, 'infrastructure-error'); assert.equal(result.error.code, 'MISSING_PREREQUISITE');
  assert.deepEqual(result.artifacts, []); assert.equal(result.evidence, null); assert.equal(result.score, null);
  assert.equal(fs.readFileSync(path.join(f.request.outputRoot, 'foreign-canary'), 'utf8'), 'keep');
});

test('partial staging keeps its real cleanup residue and primary cause when no claim was returned', async t => {
  const f = await fixture(t); let canary;
  f.runtime.onEvent = (name, facts) => {
    if (name !== 'copy-frozen') return;
    canary = path.join(path.dirname(facts.appRoot), 'foreign-canary'); fs.writeFileSync(canary, 'keep');
    throw new EvaluationInfrastructureError('preflight', 'TIMEOUT', 'controlled staging interruption');
  };
  const result = await evaluateWithRuntime(f.request, f.runtime);
  assert.equal(result.error.code, 'TIMEOUT'); assert.equal(result.cleanup.removed, false);
  assert.equal(result.cleanup.errors[0].code, 'CLEANUP_FAILED'); assert.equal(result.cleanup.residue.length, 1);
  assert.equal(fs.readFileSync(canary, 'utf8'), 'keep'); assert.equal(result.evidence, null); assert.equal(result.score, null);
});

test('unconfirmed cleanup cannot publish collected successful evidence or delete a foreign canary', async t => {
  const f = await fixture(t); let canary;
  f.runtime.onEvent = (name, facts) => {
    if (name === 'inspection') { canary = path.join(path.dirname(facts.tempRoot), 'foreign-canary'); fs.writeFileSync(canary, 'keep'); }
  };
  const result = await evaluateWithRuntime(f.request, f.runtime);
  assert.equal(result.status, 'infrastructure-error'); assert.equal(result.error.code, 'CLEANUP_FAILED');
  assert.equal(result.evidence, null); assert.equal(result.score, null); assert.equal(result.cleanup.removed, false);
  assert.equal(fs.readFileSync(canary, 'utf8'), 'keep'); assert.ok(result.artifacts.includes('inspection/stdout.log'));
});

test('controller declaration pair stays byte-identical', () => {
  assert.deepEqual(fs.readFileSync(new URL('../../packages/evaluation/controller.d.ts', import.meta.url)), fs.readFileSync(new URL('../../packages/evaluation/controller.d.mts', import.meta.url)));
});
