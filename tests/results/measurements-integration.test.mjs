// Captain source-binding acceptance. Real C3 clocks/journal/proof, controlled C4 stages only.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { initialiseRun } from '../../packages/core/init.mjs';
import { startRun, stopRun, lifecycleStateDigestOf } from '../../packages/core/lifecycle.mjs';
import { freezeRun } from '../../packages/core/freeze.mjs';
import { loadFixture } from '../contracts/fixtures/contracts/index.mjs';
import { createFrozenFixture } from '../evaluation/helpers.mjs';
import { evaluateWithRuntime } from '../../packages/evaluation/controller.mjs';
import { attachEvidenceBundle } from '../../packages/evaluation/bundle-runtime.mjs';
import { computeEvaluatorIdentity } from '../../packages/evaluation/evaluator-identity.mjs';
import { OWNER_ROOT } from '../../packages/evaluation/staging.mjs';
import { createReport, readReport } from '../../packages/results/report.mjs';
import { digestOf, reportDigestOf } from '../../packages/results/report-contract.mjs';
import { MeasurementIntegrityError } from '../../packages/results/measurement-contract.mjs';
import { ReportIntegrityError } from '../../packages/results/report-contract.mjs';
import { makeReportFixture } from './report-fixture.mjs';

const metricInput = {schemaVersion:'1.0.0',kind:'NeutralTokenInput',sourceId:'tokens-synthetic-integration',scope:'RUN_TOTAL',inputIncludesCacheReads:true,inputTokens:200,outputTokens:100,cacheReadTokens:40};
const rows = r => Object.fromEntries(r.measurements.map(m=>[m.metric,m]));
const failure = e=>e instanceof MeasurementIntegrityError&&e.code==='MEASUREMENT_INTEGRITY';
async function timedFixture(t,start,stop) {
  const base=await createFrozenFixture(t);
  const run=await initialiseRun({output:path.join(base.root,'timed-run'),challenge:{identity:base.request.challenge,sourceRoot:path.join(base.root,'source'),fileManifest:base.request.challenge.starterInventory.map(([p])=>p),ownerRoots:[OWNER_ROOT],evaluatorRoots:[path.join(OWNER_ROOT,'evaluator')]},toolingIdentity:loadFixture('tooling.identity'),evaluatorIdentity:base.request.evaluator,architectureId:'measurement-timed-run',harness:'manual',declaredCeilingMinutes:1,configuration:{model:'synthetic-model'},dependencies:{mode:'none'}});
  const selected={runRoot:run.output,runId:run.manifest.runId,manifestId:run.manifest.manifestId,expectedDigest:run.manifest.manifestDigest};
  await startRun({...selected,clock:{now:()=>start},declaration:{harness:'manual',model:'synthetic-model',workerCount:2,executionMode:'MANUAL',declaredCeilingMinutes:1}});
  const attestation={operator:'synthetic-operator',agentStopped:true,statement:'Controlled source-clock test; not an enforced stop.',observedAt:'2026-01-02T00:00:10.000Z'};
  await stopRun({...selected,clock:{now:()=>stop},attestation});
  const frozen=await freezeRun({...selected,attestation});
  const request={...base.request,outputRoot:path.join(base.root,'timed-evaluation'),submission:{...selected,snapshotId:frozen.snapshotId,frozenSubmissionId:frozen.frozenSubmission.frozenSubmissionId}};
  const installed=computeEvaluatorIdentity(), raw=await evaluateWithRuntime(request,base.runtime), evaluation=await attachEvidenceBundle(request,raw,installed);
  return {reportId:'report-timed-synthetic',createdAt:'2026-01-03T00:00:00.000Z',selection:request.submission,evaluation,metrics:metricInput};
}
test('S2 verified timing preserves genuine zero, known elapsed, unknown clocks and reversal without inventing time',async t=>{
  const start=Date.parse('2026-01-02T00:00:00.000Z');
  for(const [label,first,last,expected] of [['zero',start,start,0],['known',start,start+2000,2000],['missing-start',null,start+2000,null],['missing-both',null,null,null],['reversed',start+2000,start,null]]) {
    await t.test(label,async st=>{
      const input=await timedFixture(st,first,last), report=await createReport(input), m=rows(report);
      assert.equal(m.elapsedWallMs.value,expected);assert.equal(m.elapsedWallSeconds.value,expected===null?null:expected/1000);
      assert.equal(report.configuration.workerCount,2);assert.equal(report.configuration.model,'synthetic-model');assert.equal(report.configuration.declaredCeilingMinutes,1);assert.equal(report.configuration.executionMode,'MANUAL');assert.equal(report.execution.enforced,false);
      assert.equal(m.totalTokens.value,300);assert.equal(m.cacheReadTokens.value,40);assert.equal(m.finalPointsPerThousandTokens.value,null);assert.equal(m.qualityPointsPerWallSecond.value,null);assert.equal(m.utilization.value,null);
      const lc=report.provenance.sources.find(s=>s.kind==='lifecycle');const proof=report.provenance.sources.find(s=>s.kind==='snapshot-proof');
      assert.equal(lc.digest,digestOf(lc.record));assert.equal(proof.digest,digestOf(proof.record));assert.equal(proof.record.timeProvenance.elapsedMs,expected);
      if(label==='reversed')assert.equal(lc.record.clockError.code,'CLOCK_INVALID');
      assert.deepEqual(readReport(JSON.stringify(report)),report);
    });
  }
});
test('S2 clockless source, null round trip and source/measurement/configuration tampering are explicit',async t=>{
  const {input}=await makeReportFixture(t), report=await createReport({...input,metrics:metricInput}), m=rows(report);
  assert.equal(m.elapsedWallMs.value,null);assert.equal(m.totalTokens.value,300);assert.equal(report.configuration.workerCount,null);
  assert.equal(report.provenance.sources.find(s=>s.kind==='snapshot-proof').record.freezeRoute,'CLOCKLESS_INITIALIZED');
  for(const [mutate,ErrorClass,code,cause] of [
    [r=>{r.measurements.find(m=>m.metric==='totalTokens').value+=40;},MeasurementIntegrityError,'MEASUREMENT_INTEGRITY',/measurements differ from bound source facts/],
    [r=>{r.provenance.sources[0].digest='0'.repeat(64);},MeasurementIntegrityError,'MEASUREMENT_INTEGRITY',/source digest mismatch/],
    [r=>{r.provenance.sources.push(structuredClone(r.provenance.sources[0]));},ReportIntegrityError,'REPORT_INTEGRITY',/Invalid Report schema/],
    [r=>{r.configuration.workerCount=1;},MeasurementIntegrityError,'MEASUREMENT_INTEGRITY',/unstarted run has no declared worker count/],
    [r=>{r.measurements.find(m=>m.metric==='inputTokens').source.recordKind='EvidenceBundle';},ReportIntegrityError,'REPORT_INTEGRITY',/Invalid Report schema/],
    [r=>{const s=r.provenance.sources.find(s=>s.kind==='snapshot-proof');s.record.treeDigest='0'.repeat(64);s.digest=digestOf(s.record);},MeasurementIntegrityError,'MEASUREMENT_INTEGRITY',/sources differ from report run\/snapshot bindings/],
    [r=>{r.provenance.sources.find(s=>s.kind==='evaluation').digest='0'.repeat(64);},MeasurementIntegrityError,'MEASUREMENT_INTEGRITY',/Evaluation measurement source differs/],
    [r=>{const s=r.provenance.sources.find(s=>s.kind==='lifecycle');s.record.startedAt='2026-01-02T00:00:00.000Z';s.record.stateDigest=lifecycleStateDigestOf(s.record);s.digest=digestOf(s.record);},MeasurementIntegrityError,'MEASUREMENT_INTEGRITY',/Freeze\/lifecycle timing provenance differs/],
  ]) {
    const changed=structuredClone(report);mutate(changed);changed.reportDigest=reportDigestOf(changed);
    assert.throws(()=>readReport(JSON.stringify(changed)),e=>e instanceof ErrorClass&&e.code===code&&cause.test(e.message));
  }
  await assert.rejects(createReport({...input,metrics:{...metricInput,inputTokens:NaN}}),failure);
  await assert.rejects(createReport({...input,metrics:{...metricInput,actors:[]}}),failure);
  await assert.rejects(createReport({...input,metrics:{...metricInput,totalTokens:300}}),failure);
  assert.deepEqual(readReport(JSON.stringify(report)),report);
});
