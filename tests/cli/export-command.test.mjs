// C6.S8.T2 — real safe-export command acceptance through the actual CLI entrypoint.
//
// Every command behavior decided by the packet is asserted against a shell-free `spawnSync` of
// `cli/benchboard.mjs` over the Captain-owned real C1/C3/C5 fixture (synthetic C4 artifact-protocol
// bytes, not a production evaluation, real human review or participant run). No runtime hooks, no
// manual envelopes. The one non-child call is the pre-aborted direct `exportCommand` proof in check 3,
// which proves the cooperative abort route only and claims nothing about OS signal delivery.
// Writer fates (interrupted/late/tampered/foreign/ancestry) and the two-process race are proven in
// their own files (export-publication / export-concurrency); privacy and path attacks are T6.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { makeCliExportFixture, attachSyntheticExportChild } from './export-fixture.mjs';
import { snapshotInputs, assertInputsUnchanged } from '../evaluation/helpers.mjs';
import { createExportProjection, validateExportProjection } from '../../packages/results/export-contract.mjs';
import { renderReportJSON, renderReportText } from '../../packages/results/exports.mjs';
import { readPublishedReport } from '../../packages/results/publication.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { CATEGORIES } from '../../cli/command-error.mjs';
import { exportCommand } from '../../cli/export-command.mjs';

const absoluteCli = fileURLToPath(new URL('../../cli/benchboard.mjs', import.meta.url));
const EXPORT_NAMES = ['report.json', 'report.txt'];
const MARKER = 'EXPORT_COMPLETE.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const line = result => (result.stderr + result.stdout).trimEnd();

/** One bounded shell-free child of the real entrypoint, never through a shell. */
function invoke(cwd, argv) {
  const result = spawnSync(process.execPath, [absoluteCli, 'export', ...argv], {
    cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 20_000, maxBuffer: 1_048_576 });
  assert.equal(result.error, undefined, `the export child finished within its bound: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A successful export: exact status, empty stderr, one JSON summary line, closed verified bundle. */
function exportTo(r, argv, report) {
  const output = path.join(r.p.fixture.root, `safe export ${outputCounter += 1}`);
  const result = invoke(r.p.fixture.root, [...argv, '--output', output]);
  assert.equal(result.status, 0, `expected a completed export, got ${JSON.stringify(result)}`);
  assert.equal(result.stderr, '', 'a completed export writes nothing to stderr');
  assert.match(result.stdout, /^\{[^\n]*\}\n$/u, 'the summary is exactly one JSON line');
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(summary).sort(), ['command', 'complete', 'completionMarker', 'files', 'manifestId', 'reportDigest', 'reportId', 'evaluatorExecution', 'evaluationId', 'humanUI', 'humanReview', 'automated', 'quality', 'output', 'runId'].sort());
  assert.equal(summary.command, 'export');
  assert.equal(summary.complete, true);
  assert.equal(summary.output, output);
  assert.deepEqual(summary.files, EXPORT_NAMES);
  assert.equal(summary.completionMarker, MARKER);
  assert.equal(summary.runId, r.opened.runId);
  assert.equal(summary.manifestId, r.opened.manifestId);
  assert.equal(summary.reportId, report.reportId);
  assert.equal(summary.reportDigest, report.reportDigest);
  assert.equal(summary.evaluationId, report.evidence.evaluationId);
  assert.equal(summary.evaluatorExecution, report.execution.evaluatorExecution);
  assert.equal(summary.humanReview, report.execution.humanReview);
  assert.deepEqual(summary.automated, report.quality?.automated ?? null);
  assert.deepEqual(summary.humanUI, report.quality?.humanUI ?? null);
  assert.deepEqual(summary.quality, report.quality?.quality ?? null);
  verifyBundle(output, report, r);
  return { output, summary };
}

/** The exact three fixed files, accepted C5 renderer parity and the closed marker over real bytes. */
function verifyBundle(output, report, r) {
  const projection = createExportProjection(report), json = renderReportJSON(projection), text = renderReportText(projection);
  assert.deepEqual(fs.readdirSync(output).sort(), [...EXPORT_NAMES, MARKER].sort());
  const actualJSON = fs.readFileSync(path.join(output, 'report.json')), actualText = fs.readFileSync(path.join(output, 'report.txt'));
  assert.equal(actualJSON.toString('utf8'), json);
  assert.equal(actualText.toString('utf8'), text);
  assert.deepEqual(validateExportProjection(JSON.parse(actualJSON.toString('utf8'))), projection);
  const markerText = fs.readFileSync(path.join(output, MARKER), 'utf8'), marker = JSON.parse(markerText);
  assert.deepEqual(Object.keys(marker).sort(), ['files', 'kind', 'schemaVersion']);
  assert.equal(marker.kind, 'benchboard.cli.safe-export.v1');
  assert.equal(marker.schemaVersion, '1.0.0');
  assert.deepEqual(marker.files, [[EXPORT_NAMES[0], actualJSON], [EXPORT_NAMES[1], actualText]]
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha(bytes) })));
  // The marker binds the pair only: no raw report or run identifiers anywhere in the closed record.
  for (const secret of [report.reportId, report.bindings.runId, report.evidence.evaluationId, r.opened.runRoot]) {
    assert.equal(markerText.includes(secret), false, `the marker never carries ${secret}`);
  }
}

let outputCounter = 0;
const lockFreeDigest = root => inventoryTree({ root, skipNames: ['.storage', '.benchboard-lock'] }).digest;
/** Bytes the read/export commands must leave alone, excluding C1 lock and registry metadata. */
function protectedBytes(r) {
  return {
    inputs: snapshotInputs(r.p.fixture),
    evaluation: lockFreeDigest(r.start.outputRoot),
    store: lockFreeDigest(r.context.storeRoot),
    results: lockFreeDigest(r.context.resultsRoot),
  };
}
const assertProtected = (r, before) => {
  assertInputsUnchanged(r.p.fixture, before.inputs);
  assert.equal(lockFreeDigest(r.start.outputRoot), before.evaluation);
  assert.equal(lockFreeDigest(r.context.storeRoot), before.store);
  assert.equal(lockFreeDigest(r.context.resultsRoot), before.results);
};

// Check 1 — the exact selected report reaches the exact complete safe bundle, and never the latest.
test('the actual CLI exports the pending baseline, an explicit baseline, each named child and the baseline again after both children, each to its own complete verified bundle', async t => {
  const r = await makeCliExportFixture(t);
  const zero = await attachSyntheticExportChild(r, { positive: false, suffix: 'zero' });
  const positive = await attachSyntheticExportChild(r, { positive: true, suffix: 'positive' });
  const before = protectedBytes(r);
  const publishedBefore = new Map();
  for (const report of [r.report, zero, positive]) {
    publishedBefore.set(report.reportId, JSON.stringify(await readPublishedReport({ storeRoot: r.context.storeRoot, reportId: report.reportId })));
  }
  const base = ['--run', r.opened.runRoot, '--evaluation', r.report.evidence.evaluationId];

  const pending = exportTo(r, base, r.report);
  assert.deepEqual(pending.summary.humanUI, null, 'a pending baseline keeps null human UI');
  assert.deepEqual(pending.summary.quality, null, 'a pending baseline keeps null final quality');
  assert.equal(pending.summary.humanReview, 'NOT_REVIEWED');

  const explicitBaseline = exportTo(r, [...base, '--report', r.report.reportId], r.report);
  assert.notEqual(explicitBaseline.output, pending.output, 'a repeated command requires a fresh output');

  const exportedZero = exportTo(r, [...base, '--report', zero.reportId], zero);
  const exportedPositive = exportTo(r, [...base, '--report', positive.reportId], positive);
  assert.equal(exportedZero.summary.humanUI, 0, 'a genuinely zero review is numeric zero');
  assert.equal(exportedPositive.summary.humanUI, 20, 'a fully positive synthetic review carries the capped 20');
  for (const [summary, report] of [[pending.summary, r.report], [exportedZero.summary, zero], [exportedPositive.summary, positive]]) {
    assert.deepEqual(summary.automated, report.quality.automated, 'the automated total is unchanged by review');
  }
  assert.equal(exportedPositive.summary.automated, pending.summary.automated);

  // The decisive selection fact: after two reviewed children exist, an unqualified export is still
  // the exact baseline, never the latest child.
  const afterChildren = exportTo(r, base, r.report);
  assert.equal(afterChildren.summary.reportId, r.report.reportId);
  assert.deepEqual(afterChildren.summary.humanUI, null);

  assertProtected(r, before);
  for (const [reportId, bytes] of publishedBefore) {
    assert.equal(JSON.stringify(await readPublishedReport({ storeRoot: r.context.storeRoot, reportId })), bytes, 'the committed report bytes are untouched');
  }
});

// Check 2 — refusals name their real category and touch nothing; a committed infrastructure Report
// exports its unavailable quality instead of a zero or a reviewed score.
test('an unknown evaluation or report, with or without an existing child, is a state refusal with no output and no change, while a committed infrastructure Report exports null quality', async t => {
  const r = await makeCliExportFixture(t);
  const child = await attachSyntheticExportChild(r, { positive: true, suffix: 'positive' });
  const before = protectedBytes(r);
  const settled = exportTo(r, ['--run', r.opened.runRoot, '--evaluation', r.report.evidence.evaluationId, '--report', child.reportId], child);

  const refusals = [
    ['--evaluation', 'eval-synthetic-unknown-000000'],
    ['--evaluation', 'eval-synthetic-unknown-000000', '--report', child.reportId],
    ['--evaluation', r.report.evidence.evaluationId, '--report', 'report-synthetic-unknown-000000'],
  ];
  for (const [index, extra] of refusals.entries()) {
    const output = path.join(r.p.fixture.root, `refused output ${index}`);
    const result = invoke(r.p.fixture.root, ['--run', r.opened.runRoot, ...extra, '--output', output]);
    assert.equal(result.status, CATEGORIES.state.exitCode, `the refusal is the real state category: ${line(result)}`);
    assert.equal(result.stdout, '', 'a refusal prints no summary');
    assert.equal(result.stderr, `${CATEGORIES.state.code}: ${CATEGORIES.state.guidance}\n`, 'one fixed guidance line, no private detail');
    assert.ok(!/private|canary|[A-Z]:[\\/]/.test(result.stderr), 'the guidance line carries no local path or private value');
    assert.equal(fs.existsSync(output), false, 'a refusal creates no output directory');
  }

  assertProtected(r, before);
  verifyBundle(settled.output, child, r);

  const f = await makeCliExportFixture(t, { infrastructure: true });
  const infra = exportTo(f, ['--run', f.opened.runRoot, '--evaluation', f.report.evidence.evaluationId], f.report);
  assert.equal(infra.summary.evaluatorExecution, 'INFRASTRUCTURE_ERROR');
  assert.deepEqual(infra.summary.automated, null, 'an infrastructure Report reports unavailable, never zero');
  assert.deepEqual(infra.summary.humanUI, null);
  assert.deepEqual(infra.summary.quality, null);
  const projection = validateExportProjection(JSON.parse(fs.readFileSync(path.join(infra.output, 'report.json'), 'utf8')));
  assert.equal(projection.quality, null);
  assert.equal(projection.actualEvaluator, null);
  assert.equal(projection.execution.evaluatorExecution, 'INFRASTRUCTURE_ERROR');
  assert.equal(projection.execution.humanReview, 'NOT_REVIEWED');
});

// Check 3 — the cooperative pre-abort and the usage-before-state order. No OS-signal claim.
test('a pre-aborted direct handler is cancelled130 before any state or output work, and usage refusals precede the missing-run state refusal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-export-early-refusal '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();
  const output = path.join(root, 's8t2-must-not-exist');
  const options = { '--run': path.join(root, 's8t2-no-such-run'), '--evaluation': 'eval-synthetic-any-thing', '--output': output };
  await assert.rejects(exportCommand(options, { signal: controller.signal }),
    error => error.category === 'cancelled');
  assert.equal(CATEGORIES.cancelled.exitCode, 130);
  assert.equal(fs.existsSync(output), false, 'the abort precedes any output work');

  const absent = path.join(root, 's8t2-no-such-run');
  const usage = invoke(root, ['--run', absent, '--output', path.join(root, 's8t2-usage-output')]);
  assert.equal(usage.status, CATEGORIES.usage.exitCode, `a missing required flag is usage: ${line(usage)}`);
  assert.equal(usage.stderr, `${CATEGORIES.usage.code}: ${CATEGORIES.usage.guidance}\n`);
  assert.equal(fs.existsSync(path.join(root, 's8t2-usage-output')), false);

  const state = invoke(root, ['--run', absent, '--evaluation', 'eval-synthetic-any-thing', '--output', path.join(root, 's8t2-state-output')]);
  assert.equal(state.status, CATEGORIES.state.exitCode, `a complete request over an absent run is state: ${line(state)}`);
  assert.equal(state.stderr, `${CATEGORIES.state.code}: ${CATEGORIES.state.guidance}\n`);
  assert.equal(fs.existsSync(path.join(root, 's8t2-state-output')), false);
  for (const stray of ['s8t2-must-not-exist', 's8t2-usage-output', 's8t2-state-output']) {
    assert.equal(fs.existsSync(path.join(root, stray)), false);
  }
});
