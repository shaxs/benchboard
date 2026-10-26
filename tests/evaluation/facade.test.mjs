// Integration uses the REAL process runner and tiny fixed tools, never Chromium or a server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as facade from '../../packages/evaluation/evaluate-frozen.mjs';
import { evaluateWithRuntime } from '../../packages/evaluation/controller.mjs';
import { runProcess } from '../../packages/evaluation/process.mjs';
import { stageSuccess } from '../../packages/evaluation/contracts.mjs';
import { OWNER_ROOT } from '../../packages/evaluation/staging.mjs';
import { initialiseRun } from '../../packages/core/init.mjs';
import { freezeRun } from '../../packages/core/freeze.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { loadFixture } from '../contracts/fixtures/contracts/index.mjs';

async function fixture(t, build = 'pass') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-eval-facade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = JSON.parse(fs.readFileSync(new URL('../../release/inventory.json', import.meta.url))).participant.files.map(e => e.path);
  const put = (base, name, value) => { const to = path.join(base, name); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, value); };
  const sourceRoot = path.join(root, 'source');
  for (const name of paths) put(sourceRoot, name, fs.readFileSync(path.join(OWNER_ROOT, 'starter', name)));
  const challenge = structuredClone(loadFixture('challenge.identity'));
  const source = inventoryTree({ root: sourceRoot, skipNames: [] });
  challenge.starterInventory = source.entries.map(e => [e.path, e.sha256]); challenge.workloadDigest = source.digest;
  const evaluator = structuredClone(loadFixture('evaluator.identity'));
  const run = await initialiseRun({ output: path.join(root, 'run'), challenge: { identity: challenge, sourceRoot, fileManifest: paths, ownerRoots: [OWNER_ROOT], evaluatorRoots: [path.join(OWNER_ROOT, 'evaluator')] }, toolingIdentity: structuredClone(loadFixture('tooling.identity')), evaluatorIdentity: evaluator, architectureId: 'facade-fixture-run', harness: 'manual', dependencies: { mode: 'none' } });
  // Freeze original tampering, never mutate the saved publication: inspection must see originals.
  fs.appendFileSync(path.join(run.workspace.root, 'package-lock.json'), '\n');
  fs.appendFileSync(path.join(run.workspace.root, 'tests/contracts.test.tsx'), '\n// participant edit\n');
  const frozen = await freezeRun({ runRoot: run.output, runId: run.manifest.runId, manifestId: run.manifest.manifestId, clockless: true, attestation: { operator: 'test-operator', agentStopped: true, statement: 'Controlled facade fixture is stopped.', clockless: true } });
  const canonicalRoot = path.join(root, 'canonical');
  put(canonicalRoot, 'package.json', '{"name":"controlled-tool-fixture","type":"module"}');
  put(canonicalRoot, 'package-lock.json', '{"lockfileVersion":3,"packages":{}}');
  put(canonicalRoot, 'tsconfig.json', '{}'); put(canonicalRoot, 'vite.config.ts', 'export default {};');
  put(canonicalRoot, 'tests/contracts.test.tsx', '// canonical fixture'); put(canonicalRoot, 'tests/setup.ts', '// setup');
  put(canonicalRoot, 'node_modules/typescript/package.json', '{"type":"commonjs"}');
  put(canonicalRoot, 'node_modules/typescript/bin/tsc', 'console.log("controlled typecheck");');
  put(canonicalRoot, 'node_modules/vite/package.json', '{"type":"commonjs"}');
  const buildProgram = build === 'crash' ? 'process.abort();' : build === 'fail' ? 'console.error("controlled normal build failure");process.exit(1);' : 'const fs=require("node:fs");fs.mkdirSync("dist");fs.writeFileSync("dist/index.html","controlled build");console.log("controlled build");';
  put(canonicalRoot, 'node_modules/vite/bin/vite.js', buildProgram);
  put(canonicalRoot, 'node_modules/vitest/vitest.mjs', 'import fs from "node:fs";const out=process.argv.find(x=>x.startsWith("--outputFile=")).slice(13);fs.writeFileSync(out,JSON.stringify({numPassedTests:17,numTotalTests:17}));console.log("controlled visible tests");');
  const events = [], properties = [];
  for (const [prefix, area, count] of [['F', 'functional', 13], ['P', 'persistence', 4], ['E', 'edge', 4], ['I', 'integration', 4]]) for (let i = 1; i <= count; i++) properties.push({ id: prefix + String(i).padStart(2, '0'), area, passed: true });
  const runtime = { runProcess, preflight: async () => {}, canonicalRoot,
    stageOverrides: { browser: async () => stageSuccess('browser', properties), useful: async () => stageSuccess('useful', { addedCount: 0, baselinePassed: false, killedMutations: [] }) },
    onEvent: (name, facts) => events.push({ name, facts }) };
  const request = { challenge, evaluator, outputRoot: path.join(root, 'evaluation'), timeoutMs: 10000,
    submission: { runRoot: run.output, runId: run.manifest.runId, manifestId: run.manifest.manifestId, expectedDigest: run.manifest.manifestDigest, snapshotId: frozen.snapshotId, frozenSubmissionId: frozen.frozenSubmission.frozenSubmissionId } };
  return { root, run, frozen, runtime, request, events };
}

test('production facade exports only evaluateFrozen and refuses public collaborator injection before any browser', async t => {
  assert.deepEqual(Object.keys(facade), ['evaluateFrozen']);
  const f = await fixture(t);
  await assert.rejects(facade.evaluateFrozen({ ...f.request, runtime: f.runtime }), error => error.name === 'EvaluationRefusalError');
  assert.equal(fs.existsSync(f.request.outputRoot), false);
});

test('real runner drives fixed plain tools plus bounded original-source inspection, no browser', async t => {
  const f = await fixture(t), before = inventoryTree({ root: f.frozen.snapshotRoot, skipNames: [] }).digest;
  const result = await evaluateWithRuntime(f.request, f.runtime);
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.evidence.typecheck, true); assert.equal(result.evidence.build, true); assert.equal(result.evidence.visiblePassed, 17);
  assert.equal(result.evidence.hygiene.lockedDependencies, false); assert.equal(result.evidence.hygiene.visibleIntact, false);
  assert.equal(result.snapshot.before, before); assert.equal(result.snapshot.after, before); assert.equal(result.cleanup.removed, true);
  assert.equal(result.score, null); assert.ok(result.artifacts.some(p => p.startsWith('inspection/exit-witness-')));
  assert.ok(result.artifacts.includes('visible/visible.json'));
});

test('real runner normal build exit1 remains false quality evidence rather than infrastructure', async t => {
  const f = await fixture(t, 'fail'), result = await evaluateWithRuntime(f.request, f.runtime);
  assert.equal(result.status, 'success', JSON.stringify(result)); assert.equal(result.evidence.build, false);
  assert.equal(result.evidence.visiblePassed, 17); assert.equal(result.cleanup.removed, true);
  assert.equal(result.stages.find(s => s.stage === 'build').process.exitCode, 1);
});

test('real crashed tool returns distinct infrastructure failure, no later browser stage or partial score', async t => {
  const f = await fixture(t, 'crash'), result = await evaluateWithRuntime(f.request, f.runtime);
  assert.equal(result.status, 'infrastructure-error'); assert.equal(result.error.code, 'TOOL_CRASH'); assert.equal(result.error.stage, 'build');
  assert.equal(result.evidence, null); assert.equal(result.score, null); assert.equal(result.cleanup.removed, true);
  assert.equal(f.events.some(e => e.name === 'browser'), false); assert.ok(result.artifacts.includes('build/build.stderr.log'));
});
