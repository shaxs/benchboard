// Synthetic projection tests for the CLI safe-content delegate, not real CLI execution, production
// C4 evidence, or a real human assessment. They show exportContentOf delegates both formats to the
// accepted C5 boundary and renderers, keeps the input unchanged, freezes its result, and lets C5
// refusals propagate unchanged. They do not prove writer, destination or publication behaviour;
// those are Captain-owned and tested separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportContentOf } from '../../cli/export-content.mjs';
import { createExportProjection, validateExportProjection, ExportIntegrityError } from '../../packages/results/export-contract.mjs';
import { renderReportJSON, renderReportText } from '../../packages/results/exports.mjs';
import { validateReport, reportDigestOf, ReportIntegrityError } from '../../packages/results/report-contract.mjs';
import { makeReportFixture } from '../results/report-fixture.mjs';
import { makePublicationFixture, physicalWorksheet } from '../results/publication-fixture.mjs';
import { privateExportFixture, PRIVATE_CANARIES } from '../results/export-fixture.mjs';
import { prepareReviewedReport } from '../../packages/results/reviewed-report.mjs';
import { createReport } from '../../packages/results/report.mjs';

const reportRefusal = error => error instanceof ReportIntegrityError && error.code === 'REPORT_INTEGRITY';
const exportRefusal = error => error instanceof ExportIntegrityError && error.code === 'EXPORT_INTEGRITY' && error.message === 'Invalid safe export projection';

test('S8 exportContentOf equals the accepted C5 projection and both renderers, keeps nulls and the genuine automated value, and returns a frozen two-string result', async t => {
  const { input } = await makeReportFixture(t), inputBefore = JSON.stringify(input);
  const report = await createReport(input);
  assert.equal(JSON.stringify(input), inputBefore, 'the delegate never mutates the report it was given');

  const out = exportContentOf(report), projection = createExportProjection(report);
  assert.deepEqual(Object.keys(out), ['json', 'text']);
  assert.ok(Object.isFrozen(out), 'the returned object is frozen');
  assert.ok(!Object.isFrozen(report), 'the input report is left as the contract copy, not frozen by the delegate');
  for (const value of Object.values(out)) assert.equal(typeof value, 'string');
  assert.equal(out.json, renderReportJSON(projection), 'byte-for-byte the accepted JSON renderer output');
  assert.equal(out.text, renderReportText(projection), 'byte-for-byte the accepted text renderer output');
  assert.deepEqual(JSON.parse(out.json), projection, 'the JSON string parses back to the same validated projection');
  assert.equal(out.json.endsWith('\n'), true);
  assert.match(out.text, /^BenchBoard — Local self-assessment; not certified; manual stopping is not enforced\.\n/);

  // Pending human review keeps nulls; the genuine automated value survives untouched.
  assert.equal(report.quality.status, 'HUMAN_REVIEW_PENDING');
  const parsed = JSON.parse(out.json);
  assert.deepEqual(validateExportProjection(parsed), projection, 'the serialized JSON revalidates to the same projection');
  assert.equal(parsed.quality.humanUI, null);
  assert.equal(parsed.quality.quality, null);
  assert.equal(parsed.quality.automated, report.quality.automated, 'the real automated total is preserved, not rounded or zeroed');
  assert.equal(parsed.quality.status, 'HUMAN_REVIEW_PENDING');
  assert.ok(out.text.includes('quality.humanUI: null\n') && out.text.includes('quality.quality: null\n'));

  // A reviewed synthetic child carries a human score; a fresh automated-only report keeps nulls.
  const { report: parent, reviewRoot } = await makePublicationFixture(t);
  const child = prepareReviewedReport({ parent, worksheet: physicalWorksheet(parent, reviewRoot), reportId: 'report-synthetic-s8-child', createdAt: '2026-01-04T00:00:00.000Z' });
  const childOut = exportContentOf(child), childParsed = JSON.parse(childOut.json);
  assert.equal(child.quality.humanUI, 20);
  assert.equal(childParsed.quality.humanUI, 20);
  assert.equal(childParsed.quality.quality, child.quality.quality);
  assert.equal(childParsed.quality.automated, child.quality.automated);

  // Infrastructure failure: quality and its parts stay null, never zero.
  const failure = await createReport({ ...input, reportId: 'report-synthetic-s8-failure', evaluation: { status: 'infrastructure-error', evaluationId: null, bundle: null, evidence: null, score: null, error: { code: 'TIMEOUT' } } });
  assert.equal(failure.quality, null);
  const failureOut = exportContentOf(failure), failureParsed = JSON.parse(failureOut.json);
  assert.equal(failureParsed.quality, null);
  assert.equal(failureParsed.execution.evaluatorExecution, 'INFRASTRUCTURE_ERROR');

  // Passing the raw report (not its safe projection) to a renderer is refused by C5 directly.
  for (const render of [renderReportJSON, renderReportText]) assert.throws(() => render(report), exportRefusal);
});

test('S8 canaries in operator, reviewer, narrative, config and log fields of a valid private fixture never reach either format', async t => {
  const f = await privateExportFixture(t);
  for (const raw of [f.parent, f.child, f.report]) {
    const { json, text } = exportContentOf(raw);
    for (const canary of PRIVATE_CANARIES) {
      assert.ok(!json.includes(canary), 'json must not contain ' + canary);
      assert.ok(!text.includes(canary), 'text must not contain ' + canary);
    }
  }
  // Explicitly source-safe fields the packet names: opaque references and preserved digests.
  const out = JSON.parse(exportContentOf(f.child).json);
  assert.equal(out.identity.reportDigest, f.child.reportDigest);
  assert.equal(out.identity.bundleDigest, f.child.evidence.bundleDigest);
  assert.match(out.review.reviewerRef, /^[0-9a-f]{64}$/, 'the reviewer label is replaced by an opaque reference');
  assert.notEqual(out.review.reviewerRef, f.child.provenance.review.reviewer);
  assert.ok(!Object.keys(out.configuration).includes('harness') && !Object.keys(out.configuration).includes('model'));
  assert.equal(typeof out.configuration.harnessRef, 'string');
  assert.notEqual(out.configuration.harnessRef, out.configuration.modelRef, 'two different private labels do not collide into one reference');
});

test('S8 invalid objects, unknown fields and serialization payloads hit the accepted C5 boundaries and the same error class and code propagate unwrapped', async t => {
  const { input } = await makeReportFixture(t);
  const report = await createReport(input);

  // Unknown field with a recomputed digest: refused at the report contract before any export work.
  const extra = structuredClone(report); extra.rawLogs = ['PRIVATE_NOT_FOR_EXPORT']; extra.reportDigest = reportDigestOf(extra);
  assert.throws(() => validateReport(extra), reportRefusal);
  assert.throws(() => exportContentOf(extra), reportRefusal, 'the delegate surfaces the report-contract error class and code, not a relabelled one');

  // A serialization-style payload that is not a Report shape.
  assert.throws(() => exportContentOf({ json: '{}', encoding: 'utf8' }), reportRefusal);
  // An invalid raw object the report contract rejects outright.
  assert.throws(() => exportContentOf('not-an-object'), reportRefusal);

  // An accepted projection tampered after the fact: export-boundary error propagates through a renderer,
  // the same way exportContentOf's own second validation pass would refuse it.
  const safe = createExportProjection(report);
  const tampered = structuredClone(safe); tampered.quality.humanUI = 20;
  assert.throws(() => renderReportJSON(tampered), exportRefusal);
  assert.throws(() => renderReportText(tampered), exportRefusal);
  const smuggled = structuredClone(safe); smuggled.rawLogs = ['PRIVATE_NOT_FOR_EXPORT'];
  assert.throws(() => renderReportJSON(smuggled), exportRefusal);

  // Direct equality with the accepted C5 functions on the valid path (parity for both formats).
  const out = exportContentOf(report);
  assert.equal(out.json, renderReportJSON(createExportProjection(report)));
  assert.equal(out.text, renderReportText(createExportProjection(report)));
});
