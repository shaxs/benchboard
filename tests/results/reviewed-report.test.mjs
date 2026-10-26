// Captain load-bearing child preservation/final-sum acceptance, separate from worker implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReviewedReport } from '../../packages/results/reviewed-report.mjs';
import { projectMeasurements } from '../../packages/results/measurements.mjs';
import { readReport } from '../../packages/results/report.mjs';
import { createReport } from '../../packages/results/report.mjs';
import { score } from '../../evaluator/score.mjs';
import { scorerEvidenceOf } from '../../packages/evaluation/bundle.mjs';
import { scoreUIWorksheet } from '../../packages/results/ui-worksheet.mjs';
import { ReportIntegrityError } from '../../packages/results/report-contract.mjs';
import { makePublicationFixture, physicalWorksheet } from './publication-fixture.mjs';
test('S4 final measurement sum cannot disagree with known automated and human components',()=>{
  const rows=projectMeasurements({idPrefix:'reviewed-synthetic',timing:{elapsedMs:2000},tokens:null,quality:{automated:80,humanUI:10,quality:100}});
  const m=Object.fromEntries(rows.map(r=>[r.metric,r]));
  assert.equal(m.finalQuality.value,90);assert.equal(m.qualityPointsPerWallSecond.value,45);
});
test('S4 pure child retains evidence/automated values, names exact parent, reprojects measurements and preserves inputs',async t=>{
  const f=await makePublicationFixture(t),parentBefore=JSON.stringify(f.report),worksheet=physicalWorksheet(f.report,f.reviewRoot),before=JSON.stringify(worksheet);
  const child=prepareReviewedReport({parent:f.report,worksheet,reportId:'report-reviewed-synthetic',createdAt:'2026-01-04T00:00:00.000Z'});
  assert.equal(child.provenance.parentReportId,f.report.reportId);assert.equal(child.provenance.parentReportDigest,f.report.reportDigest);
  assert.equal(child.execution.humanReview,'SCORED');assert.equal(child.execution.agentOutcome,null);assert.equal(child.execution.enforced,false);
  assert.deepEqual(child.quality,scoreUIWorksheet(f.report,worksheet));assert.equal(child.quality.humanUI,20);assert.equal(child.quality.quality,f.report.quality.automated+20);
  for(const key of ['evidence','artifacts','bindings','actualEvaluator','configuration'])assert.deepEqual(child[key],f.report[key],key);
  assert.deepEqual(child.provenance.sources,f.report.provenance.sources);
  assert.ok(child.measurements.every(m=>m.measurementId.startsWith(child.reportId+':')));
  assert.equal(child.measurements.find(m=>m.metric==='finalQuality').value,child.quality.quality);
  assert.deepEqual(readReport(JSON.stringify(child)),child);
  assert.equal(JSON.stringify(f.report),parentBefore);assert.equal(JSON.stringify(worksheet),before);
  assert.throws(()=>prepareReviewedReport({parent:f.report,worksheet,reportId:f.report.reportId,createdAt:child.createdAt}),e=>e instanceof ReportIntegrityError&&e.code==='REPORT_INTEGRITY'&&/distinct bound parent/.test(e.message));
});
test('S4 fractional reviewed measurement exactly matches unchanged scorer precision, not a binary tail',async t=>{
  const f=await makePublicationFixture(t),input=structuredClone(f.input),bundle=input.evaluation.bundle;
  bundle.visible.passed=0;bundle.build=false;
  bundle.properties=bundle.properties.map(p=>({...p,passed:['F01','F02','F03'].includes(p.id)}));
  bundle.score=score(scorerEvidenceOf(bundle),null);
  const parent=await createReport(input),worksheet=physicalWorksheet(parent,f.reviewRoot);
  for(const key of Object.keys(worksheet.scores))worksheet.scores[key]=key==='polish'?4:0;
  const expected=scoreUIWorksheet(parent,worksheet);
  assert.equal(parent.quality.automated,12.9231);assert.equal(expected.quality,16.9231);
  assert.notEqual(parent.quality.automated+4,expected.quality,'the controlled valid evidence actually exercises a binary floating tail');
  const child=prepareReviewedReport({parent,worksheet,reportId:'report-fractional-reviewed',createdAt:'2026-01-04T00:00:00.000Z'});
  assert.equal(child.measurements.find(m=>m.metric==='finalQuality').value,expected.quality);
  assert.deepEqual(child.quality,expected);
});
