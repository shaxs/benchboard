// Captain acceptance/privacy: historical claims survive locally and never enter current authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFixture} from '../contracts/fixtures/contracts/index.mjs';
import {readCompatibilityInput} from '../../packages/results/compatibility.mjs';
import {createCompatibilityExport,validateCompatibilityExport,CompatibilityExportError} from '../../packages/results/compatibility-export-contract.mjs';
import {renderCompatibilityJSON,renderCompatibilityText} from '../../packages/results/compatibility-exports.mjs';
import {privateExportFixture,PRIVATE_CANARIES} from './export-fixture.mjs';
import {createReport} from '../../packages/results/report.mjs';
import {ExportIntegrityError} from '../../packages/results/export-contract.mjs';

const verify=(raw)=>{
  const before=JSON.stringify(raw),out=createCompatibilityExport(raw),json=renderCompatibilityJSON(out),text=renderCompatibilityText(out);
  assert.deepEqual(JSON.parse(json),out);assert.deepEqual(validateCompatibilityExport(out),out);assert.equal(out.formalComparisonAvailable,false);
  for(const canary of PRIVATE_CANARIES)for(const output of [json,text])assert.ok(!output.includes(canary),canary);
  assert.equal(JSON.stringify(raw),before);
  const walk=(v,key='')=>{if(v!==null&&typeof v==='object'){if(Object.keys(v).length===0)assert.ok(text.includes(key+': '+(Array.isArray(v)?'[]':'{}')+'\n'));else for(const [k,x]of Object.entries(v))walk(x,key?key+'.'+k:k);}else assert.ok(text.includes(key+': '+JSON.stringify(v)+'\n'),key);};walk(out);
  return out;
};
test('S6 all historical versions and asserted authority remain local, unbound and non-promoting in both safe formats',()=>{
  for(const version of ['1.0','1.1','1.2'])for(const positive of [false,true]){
    const raw=structuredClone(loadFixture(`legacy.result.${positive?'positive.':''}${version}`));
    raw.privateCanary=PRIVATE_CANARIES.join(' ');raw.run.runId='PRIVATE_CANARY_ID-run';raw.run.benchmarkVersion='1.2.3-PRIVATE_CANARY_TOKEN';raw.run.terminationOutcome=PRIVATE_CANARIES[3];
    const before=JSON.stringify(raw),local=readCompatibilityInput(raw),out=verify(raw);
    assert.equal(out.family,'LEGACY');assert.equal(out.assessmentTrust,'UNTRUSTED_LEGACY');assert.equal(out.currentEvidence,false);assert.equal(out.currentHumanReview,'NOT_REVIEWED');assert.equal(out.report,null);
    assert.equal(out.classification.bindingStatus,'UNBOUND_HISTORICAL');assert.equal(out.classification.recognizedLegacyVersion,version);assert.equal(out.classification.promotionAllowed,false);
    assert.ok(out.warnings.includes('HISTORICAL_CLAIMS_NOT_CURRENT_AUTHORITY'));assert.ok(out.warnings.includes('HISTORICAL_UI_NOT_CURRENT_WORKSHEET'));
    assert.deepEqual(local.record.sourceRecord,raw);assert.equal(JSON.stringify(raw),before);
    assert.deepEqual(createCompatibilityExport(JSON.stringify(raw)),out);assert.deepEqual(createCompatibilityExport(local.record),out);
  }
});
test('S6 C1 Result classifications remain declared only, never current C4 evidence or bound worksheet',()=>{
  for(const name of ['result.selfassessment','result.localscored']){
    const raw=structuredClone(loadFixture(name));raw.resultId='PRIVATE_CANARY_ID-result';raw.notes=PRIVATE_CANARIES.join(' ');raw.humanReview.reviewer='PRIVATE_CANARY_REVIEWER';
    const out=verify(raw);assert.equal(out.family,'C1_RESULT');assert.equal(out.report,null);assert.equal(out.currentEvidence,false);assert.equal(out.currentHumanReview,'NOT_REVIEWED');
    assert.equal(out.classification.declaredHumanReview,raw.humanReview.reviewStatus);assert.equal(out.classification.runStatus,raw.runStatus);assert.equal(out.assessmentTrust,raw.evaluationTrust);assert.ok(out.warnings.includes('C1_RESULT_NOT_C4_EVIDENCE'));
  }
});
test('S6 current Report retains the unchanged S5 safe projection while refusing source/ref/authority forgery',async t=>{
  const f=await privateExportFixture(t),out=verify(f.child);assert.equal(out.family,'REPORT');assert.equal(out.currentEvidence,true);assert.equal(out.currentHumanReview,'SCORED');assert.deepEqual(out.report.quality,f.child.quality);
  const pending=verify(f.parent);assert.equal(pending.currentHumanReview,'NOT_REVIEWED');assert.equal(pending.report.quality.humanUI,null);
  const infra=await createReport({...f.input,evaluation:{status:'infrastructure-error',evaluationId:null,bundle:null,evidence:null,score:null,error:{code:'TIMEOUT'}}});
  const failed=verify(infra);assert.equal(failed.family,'REPORT');assert.equal(failed.currentEvidence,false);assert.equal(failed.report.quality,null);assert.equal(failed.report.execution.evaluatorExecution,'INFRASTRUCTURE_ERROR');
  for(const mutate of [v=>{v.currentEvidence=false;},v=>{v.sourceRef='0'.repeat(64);},v=>{v.warnings=[];},v=>{v.rawSource=PRIVATE_CANARIES[3];},v=>{v.family='LEGACY';}]){const v=structuredClone(out);mutate(v);assert.throws(()=>validateCompatibilityExport(v),e=>e instanceof CompatibilityExportError);}
  assert.throws(()=>createCompatibilityExport({schemaVersion:'9.0',run:{}}));
  const forged=structuredClone(readCompatibilityInput(loadFixture('legacy.result.1.2')).record);forged.promotionAllowed=true;assert.throws(()=>createCompatibilityExport(forged));
  const nested=structuredClone(out);nested.report.quality.areas.visible-=1;
  for(const render of [renderCompatibilityJSON,renderCompatibilityText])assert.throws(()=>render(nested),e=>e instanceof ExportIntegrityError&&e.code==='EXPORT_INTEGRITY');
});
test('S6 both renderers refuse raw local compatibility/source records instead of serializing private payloads',()=>{
  const raw=loadFixture('legacy.result.positive.1.2'),view=readCompatibilityInput(raw),safe=createCompatibilityExport(raw);
  for(const render of [renderCompatibilityJSON,renderCompatibilityText])for(const input of [raw,view,view.record,{...safe,sourceRecord:raw}])assert.throws(()=>render(input),e=>e instanceof CompatibilityExportError&&e.code==='COMPATIBILITY_EXPORT_INTEGRITY');
});
