// Captain input/parent policy diagnostics. Real C1/C3/C5 with synthetic C4 artifact protocol only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makePublicationFixture, physicalWorksheet } from '../results/publication-fixture.mjs';
import { createReport } from '../../packages/results/report.mjs';
import { saveReport, attachUIReview } from '../../packages/results/publication.mjs';
import { openSelectedRun, ensureResultsContext } from '../../cli/run-context.mjs';
import { reserveEvaluationAttempt, finishEvaluationAttempt } from '../../cli/attempt-records.mjs';
import { recordEvaluationExecution } from '../../cli/execution-records.mjs';
import { prepareUIContext } from '../../cli/ui-context.mjs';
import { diagnosticOf } from '../../cli/diagnostics.mjs';

async function ready(t, infrastructure = false) {
  const p = await makePublicationFixture(t), opened = await openSelectedRun(p.runRoot), context = await ensureResultsContext(opened);
  const start = await reserveEvaluationAttempt(opened, context, {
    snapshotId: p.input.selection.snapshotId, frozenSubmissionId: p.input.selection.frozenSubmissionId });
  let report = p.report;
  if (infrastructure) {
    report = await createReport({ ...p.input, reportId: 'report-synthetic-infrastructure-ui', evaluation: {
      status: 'infrastructure-error', evaluationId: 'eval-synthetic-infrastructure-ui', bundle: null,
      evidence: null, score: null, error: { code: 'TIMEOUT' } } });
    fs.mkdirSync(start.outputRoot);
  } else fs.cpSync(p.evaluationRoot, start.outputRoot, { recursive: true });
  await recordEvaluationExecution(opened, context, start.attemptId, { evaluationId: report.evidence.evaluationId,
    reportId: report.reportId, evaluatorExecution: infrastructure ? 'INFRASTRUCTURE_ERROR' : 'SUCCESS' });
  await saveReport({ storeRoot: context.storeRoot, runRoot: opened.runRoot, evaluationRoot: start.outputRoot, report });
  await finishEvaluationAttempt(opened, context, start.attemptId, { evaluationId: report.evidence.evaluationId,
    reportId: report.reportId, status: infrastructure ? 'INFRASTRUCTURE' : 'SUCCEEDED' });
  return { p, opened, context, start, report, output: path.join(p.fixture.root, 'private template.json'), input: path.join(p.fixture.root, 'private input.json') };
}
const template = r => ({ mode: 'template', output: r.output, evaluationId: r.report.evidence.evaluationId, reportId: r.report.reportId });
const integrity = error => diagnosticOf(error).exitCode === 4;

test('UI context selects the same exact executed baseline from both selectors and refuses mismatches or a reviewed-child parent', async t => {
  const r = await ready(t);
  const selected = await prepareUIContext(template(r), { '--run': r.opened.runRoot });
  assert.equal(selected.parent.reportDigest, r.report.reportDigest);
  assert.equal(fs.existsSync(r.output), false, 'preparation does not publish the private file');
  await assert.rejects(prepareUIContext({ ...template(r), evaluationId: 'eval-other' }, { '--run': r.opened.runRoot }), e => e.category === 'state');
  const worksheet = physicalWorksheet(r.report, r.p.reviewRoot, false);
  const child = await attachUIReview({ storeRoot: r.context.storeRoot, runRoot: r.opened.runRoot,
    evaluationRoot: r.start.outputRoot, parentReportId: r.report.reportId, reportId: 'report-synthetic-ui-child',
    createdAt: '2026-02-03T04:05:06.000Z', worksheet, reviewRoot: r.p.reviewRoot });
  await assert.rejects(prepareUIContext({ ...template(r), reportId: child.reportId }, { '--run': r.opened.runRoot }), e => e.category === 'state');
  fs.writeFileSync(r.input, JSON.stringify(worksheet));
  const attach = await prepareUIContext({ mode: 'attach', input: r.input, reviewRoot: r.p.reviewRoot }, { '--run': r.opened.runRoot });
  assert.equal(attach.parent.reportId, r.report.reportId);
  assert.deepEqual(attach.worksheet, worksheet);
});

test('UI context refuses bounded-file, metadata, output and evidence-root attacks without writing a template', async t => {
  const r = await ready(t), worksheet = physicalWorksheet(r.report, r.p.reviewRoot, false);
  const attach = () => prepareUIContext({ mode: 'attach', input: r.input, reviewRoot: r.p.reviewRoot }, { '--run': r.opened.runRoot });
  fs.writeFileSync(r.input, '{'); await assert.rejects(attach(), integrity);
  fs.writeFileSync(r.input, ' '.repeat(2097153)); await assert.rejects(attach(), integrity);
  fs.writeFileSync(r.input, JSON.stringify({ ...worksheet, reviewer: ' ' })); await assert.rejects(attach(), integrity);
  fs.writeFileSync(r.input, JSON.stringify(worksheet));
  await assert.rejects(prepareUIContext({ mode: 'attach', input: r.input, reviewRoot: r.context.resultsRoot }, { '--run': r.opened.runRoot }), integrity);
  const linked = path.join(r.p.fixture.root, 'linked review'); fs.symlinkSync(r.p.reviewRoot, linked, 'junction');
  await assert.rejects(prepareUIContext({ mode: 'attach', input: r.input, reviewRoot: linked }, { '--run': r.opened.runRoot }), integrity);
  await assert.rejects(prepareUIContext({ ...template(r), output: path.join(r.context.resultsRoot, 'private.json') }, { '--run': r.opened.runRoot }), integrity);
  assert.equal(fs.existsSync(r.output), false);
});

test('an exact committed infrastructure baseline remains unavailable for UI rather than being scored zero', async t => {
  const r = await ready(t, true);
  assert.equal(r.report.quality, null);
  await assert.rejects(prepareUIContext(template(r), { '--run': r.opened.runRoot }), integrity);
  assert.equal(fs.existsSync(r.output), false);
});

test('UI context captures its primitive mode and selectors before its first await', async t => {
  const r = await ready(t), parsed = template(r), options = { '--run': r.opened.runRoot };
  const pending = prepareUIContext(parsed, options);
  parsed.mode = 'attach'; parsed.input = 'private-mutated-input'; parsed.reportId = 'report-mutated';
  parsed.output = path.join(r.opened.runRoot, 'unsafe-mutated.json'); options['--run'] = 'mutated-run';
  const context = await pending;
  assert.equal(context.mode, 'template');
  assert.equal(context.parent.reportId, r.report.reportId);
  assert.equal(context.output, r.output);
  assert.equal(fs.existsSync(r.output), false);
});
