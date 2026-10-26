// Captain-owned refusal tests at the filesystem boundary, with real C3 state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initialiseRun } from '../../packages/core/init.mjs';
import { startRun, LifecycleError } from '../../packages/core/lifecycle.mjs';
import { EvaluationRefusalError } from '../../packages/evaluation/contracts.mjs';
import { ReportIntegrityError } from '../../packages/results/report-contract.mjs';
import { createReport } from '../../packages/results/report.mjs';
import { loadFixture } from '../contracts/fixtures/contracts/index.mjs';
import { OWNER_ROOT } from '../../packages/evaluation/staging.mjs';
import { makeReportFixture } from './report-fixture.mjs';

test('S1 propagates C3 NOT_FOUND for a started run with no frozen publication, preserving its state', async t => {
  const { fixture, input } = await makeReportFixture(t);
  const participantPaths = fixture.request.challenge.starterInventory.map(([name]) => name);
  const run = await initialiseRun({
    output: path.join(fixture.root, 'active-run'),
    challenge: { identity: fixture.request.challenge, sourceRoot: path.join(fixture.root, 'source'), fileManifest: participantPaths, ownerRoots: [OWNER_ROOT], evaluatorRoots: [path.join(OWNER_ROOT, 'evaluator')] },
    toolingIdentity: structuredClone(loadFixture('tooling.identity')),
    evaluatorIdentity: fixture.request.evaluator, architectureId: 'report-active-run', harness: 'manual', dependencies: { mode: 'none' },
  });
  await startRun({ runRoot: run.output, runId: run.manifest.runId, manifestId: run.manifest.manifestId,
    declaration: { harness: 'manual', model: null, workerCount: null, executionMode: 'MANUAL', declaredCeilingMinutes: run.manifest.declaredCeilingMinutes ?? null } });
  const statePath = path.join(run.state.root, 'lifecycle', 'state.json');
  const before = fs.readFileSync(statePath);
  await assert.rejects(createReport({ ...input, selection: { ...input.selection, runRoot: run.output, runId: run.manifest.runId, manifestId: run.manifest.manifestId, expectedDigest: run.manifest.manifestDigest } }), error => error instanceof LifecycleError && error.code === 'NOT_FOUND' && /published no frozen submission/.test(error.message));
  assert.deepEqual(fs.readFileSync(statePath), before);
});

test('S1 refuses a linked run ancestor and malformed selected paths', async t => {
  const { fixture, input } = await makeReportFixture(t);
  const alias = path.join(fixture.root, 'linked-run');
  fs.symlinkSync(fixture.run.output, alias, 'junction');
  await assert.rejects(createReport({ ...input, selection: { ...input.selection, runRoot: alias } }), error => error instanceof EvaluationRefusalError && error.code === 'UNSAFE_PATH' && /Linked or non-directory ancestor refused/.test(error.message));
  for (const runRoot of ['relative/run', fixture.run.output + path.sep + '..' + path.sep + path.basename(fixture.run.output)]) {
    await assert.rejects(createReport({ ...input, selection: { ...input.selection, runRoot } }), error => error instanceof ReportIntegrityError && error.code === 'REPORT_INTEGRITY' && /Canonical absolute run root required/.test(error.message));
  }
});
