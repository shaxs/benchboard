// Captain acceptance/privacy tests, separate from render implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createExportProjection,validateExportProjection,ExportIntegrityError} from '../../packages/results/export-contract.mjs';
import {privateExportFixture,PRIVATE_CANARIES} from './export-fixture.mjs';
import {createReport} from '../../packages/results/report.mjs';
import {reportDigestOf,digestOf} from '../../packages/results/report-contract.mjs';
import {lifecycleStateDigestOf} from '../../packages/core/lifecycle.mjs';
import {physicalWorksheet} from './publication-fixture.mjs';
import {prepareReviewedReport} from '../../packages/results/reviewed-report.mjs';

test('S5 validated projection preserves numeric evidence/digests, pseudonymizes every label and never mutates private inputs',async t=>{
  const f=await privateExportFixture(t);
  for(const r of [f.parent,f.child,f.report]){
    const before=JSON.stringify(r),out=createExportProjection(r),serialized=JSON.stringify(out);
    for(const canary of PRIVATE_CANARIES)assert.ok(!serialized.includes(canary),canary);
    assert.deepEqual(out.quality,r.quality);assert.equal(out.identity.reportDigest,r.reportDigest);assert.equal(out.identity.bundleDigest,r.evidence.bundleDigest);
    assert.equal(out.bindings.workloadDigest,r.bindings.workloadDigest);assert.equal(out.actualEvaluator.semanticDigest,r.actualEvaluator.semanticDigest);
    assert.deepEqual(out.configuration.workerCount,r.configuration.workerCount);assert.equal(out.execution.agentOutcome,null);assert.equal(out.execution.enforced,false);
    assert.deepEqual(validateExportProjection(out),out);assert.equal(JSON.stringify(r),before);
    assert.ok(!('evidence' in out));assert.ok(!('provenance' in out));assert.ok(!('environment' in out));
    assert.equal(out.measurements.length,r.measurements.length);
    for(let i=0;i<r.measurements.length;i++)for(const k of ['metric','unit','value','measurementKind'])assert.deepEqual(out.measurements[i][k],r.measurements[i][k]);
    assert.deepEqual(out.sources,r.provenance.sources.map(({kind,digest})=>({kind,digest})));
    out.identity.reportDigest='0'.repeat(64);assert.equal(JSON.stringify(r),before);
  }
  const p=createExportProjection(f.parent),c=createExportProjection(f.child);
  assert.equal(p.quality.humanUI,null);assert.equal(p.quality.quality,null);assert.equal(p.review,null);
  assert.equal(c.quality.humanUI,20);assert.equal(c.identity.parentReportRef,createExportProjection(f.report).identity.reportRef);assert.notEqual(c.review.reviewerRef,f.child.provenance.review.reviewer);
  assert.equal(p.versions.challenge.core,'1.2.3');assert.equal(p.versions.challenge.suffixWithheld,true);assert.equal(p.versions.scoring.core,null);
  assert.equal(p.artifacts[0].sha256,f.parent.artifacts[0].sha256);assert.equal(c.review.artifacts[0].sha256,f.child.provenance.review.evidence[0].sha256);
});
test('S5 infrastructure/unavailable facts stay null; source attestation prose is withheld',async t=>{
  const f=await privateExportFixture(t),failure=await createReport({...f.input,evaluation:{status:'infrastructure-error',evaluationId:null,bundle:null,evidence:null,score:null,error:{code:'TIMEOUT'}}});
  const r=structuredClone(f.report),lc=r.provenance.sources.find(s=>s.kind==='lifecycle');
  lc.record.stopAttestation.operator=PRIVATE_CANARIES[2];lc.record.stopAttestation.statement=PRIVATE_CANARIES[3];lc.record.stateDigest=lifecycleStateDigestOf(lc.record);lc.digest=digestOf(lc.record);r.reportDigest=reportDigestOf(r);
  const out=createExportProjection(r);assert.ok(!JSON.stringify(out).includes(PRIVATE_CANARIES[2]));assert.ok(!JSON.stringify(out).includes(PRIVATE_CANARIES[3]));
  const projected=createExportProjection(failure);assert.equal(projected.quality,null);assert.equal(projected.actualEvaluator,null);assert.equal(projected.identity.bundleDigest,null);assert.deepEqual(projected.artifacts,[]);assert.equal(projected.execution.evaluatorExecution,'INFRASTRUCTURE_ERROR');
});
test('S5 closed renderer schema refuses free text in every exported primitive slot and unknown properties',async t=>{
  const f=await privateExportFixture(t),safe=createExportProjection(f.child),invalid=e=>e instanceof ExportIntegrityError&&e.code==='EXPORT_INTEGRITY'&&e.message==='Invalid safe export projection';
  const paths=[];
  const visit=(v,p=[])=>{if(v&&typeof v==='object')for(const [k,x]of Object.entries(v))visit(x,[...p,k]);else paths.push(p);};visit(safe);
  for(const keys of paths){const v=structuredClone(safe);let cursor=v;for(const k of keys.slice(0,-1))cursor=cursor[k];cursor[keys.at(-1)]=PRIVATE_CANARIES[5];assert.throws(()=>validateExportProjection(v),invalid,keys.join('.'));}
  for(const extra of ['rawLogs','runtimeFlags','endpoint','sourceRecord','reviewer'])assert.throws(()=>validateExportProjection({...safe,[extra]:PRIVATE_CANARIES[3]}),invalid);
  const disguised=structuredClone(safe);Object.defineProperty(disguised,'toJSON',{value:()=>({...safe,rawLogs:PRIVATE_CANARIES[3]})});assert.throws(()=>validateExportProjection(disguised),invalid);
  const broken=structuredClone(safe);broken.quality.humanUI=null;assert.throws(()=>validateExportProjection(broken),invalid);
  const metric=structuredClone(safe);metric.measurements[0].value=999999;assert.throws(()=>validateExportProjection(metric),invalid);
  const procedure=structuredClone(safe);procedure.measurements[0].procedureCode='ENTERED_V1';assert.throws(()=>validateExportProjection(procedure),invalid);
  const incomplete=structuredClone(safe);incomplete.measurements.pop();assert.throws(()=>validateExportProjection(incomplete),invalid);
  for(const change of [v=>{v.identity.evaluationRef=null;},v=>{v.sources=[];},v=>{v.sources.find(s=>s.kind==='evaluation').digest='0'.repeat(64);},v=>{v.timing.elapsedMs=1;},v=>{v.review.artifacts.pop();}]){const v=structuredClone(safe);change(v);assert.throws(()=>validateExportProjection(v),invalid);}
  assert.throws(()=>createExportProjection({...f.child,reportDigest:'0'.repeat(64)}));
});
test('S5 entered zero/cache semantics and reviewed zero remain known without exporting token source labels',async t=>{
  const f=await privateExportFixture(t);
  for(const inputTokens of [0,100]){
    const r=await createReport({...f.input,metrics:{schemaVersion:'1.0.0',kind:'NeutralTokenInput',sourceId:'PRIVATE_CANARY_TOKEN-source',scope:'RUN_TOTAL',inputIncludesCacheReads:true,inputTokens,outputTokens:0,cacheReadTokens:inputTokens}}),out=createExportProjection(r),rows=Object.fromEntries(out.measurements.map(row=>[row.metric,row]));
    assert.equal(rows.totalTokens.value,inputTokens);assert.equal(rows.outputTokens.value,0);assert.equal(rows.cacheReadTokens.value,inputTokens);assert.equal(rows.finalQuality.value,null);
    assert.ok(!JSON.stringify(out).includes('PRIVATE_CANARY_TOKEN'));
  }
  const worksheet=physicalWorksheet(f.report,f.reviewRoot,false),zero=prepareReviewedReport({parent:f.report,worksheet,reportId:'review-zero-export',createdAt:'2026-01-04T00:00:00.000Z'}),out=createExportProjection(zero);
  assert.equal(out.quality.humanUI,0);assert.equal(out.quality.quality,f.report.quality.automated);assert.equal(out.execution.humanReview,'SCORED');
  const same=structuredClone(f.parent);same.configuration.harness='same-private-label';same.configuration.model='same-private-label';same.reportDigest=reportDigestOf(same);const p=createExportProjection(same);assert.notEqual(p.configuration.harnessRef,p.configuration.modelRef);
});
