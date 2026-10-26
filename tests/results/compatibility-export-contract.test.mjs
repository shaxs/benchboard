import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFixture} from '../contracts/fixtures/contracts/index.mjs';
import {createCompatibilityExport,validateCompatibilityExport,CompatibilityExportError} from '../../packages/results/compatibility-export-contract.mjs';
import {readCompatibilityInput} from '../../packages/results/compatibility.mjs';
import {canonicalJson,sha256Hex,ContractValidationError} from '../../packages/core/manifest.mjs';
import {ResultInputError} from '../../packages/results/input-contract.mjs';
test('S6 safe older-family contract contains only fixed classification and no raw payload, quality or current review',()=>{
  for(const name of ['legacy.result.1.0','legacy.result.1.1','legacy.result.positive.1.2','result.selfassessment','result.localscored']){
    const raw=loadFixture(name),before=JSON.stringify(raw),out=createCompatibilityExport(raw);
    assert.equal(out.currentEvidence,false);assert.equal(out.currentHumanReview,'NOT_REVIEWED');assert.equal(out.report,null);assert.equal(out.classification.promotionAllowed,false);assert.equal(out.formalComparisonAvailable,false);
    assert.equal('sourceRecord' in out,false);assert.equal('quality' in out,false);assert.deepEqual(validateCompatibilityExport(out),out);assert.equal(JSON.stringify(raw),before);
    const local=readCompatibilityInput(raw);assert.equal(out.sourceDigest,sha256Hex(canonicalJson(local.family==='LEGACY'?local.record.sourceRecord:local.record)));
    const extra={...out,sourceRecord:raw};assert.throws(()=>validateCompatibilityExport(extra),e=>e instanceof CompatibilityExportError&&e.code==='COMPATIBILITY_EXPORT_INTEGRITY');
    const promoted={...out,currentEvidence:true};assert.throws(()=>validateCompatibilityExport(promoted),e=>e instanceof CompatibilityExportError);
  }
});
test('S6 safe compatibility schema rejects free text, serialization payloads and authority upgrades in every older-family slot',()=>{
  for(const name of ['legacy.result.positive.1.2','result.localscored']){
    const safe=createCompatibilityExport(loadFixture(name)),paths=[];
    const visit=(v,p=[])=>{if(v&&typeof v==='object')for(const [key,value]of Object.entries(v))visit(value,[...p,key]);else paths.push(p);};visit(safe);
    for(const keys of paths){const value=structuredClone(safe);let at=value;for(const key of keys.slice(0,-1))at=at[key];at[keys.at(-1)]='PRIVATE_COMPATIBILITY_CANARY';assert.throws(()=>validateCompatibilityExport(value),e=>e instanceof CompatibilityExportError,keys.join('.'));}
    const toJSON=structuredClone(safe);Object.defineProperty(toJSON,'toJSON',{value:()=>({...safe,privatePayload:'PRIVATE_COMPATIBILITY_CANARY'})});assert.throws(()=>validateCompatibilityExport(toJSON),e=>e instanceof CompatibilityExportError);
    for(const mutate of [v=>{v.formalComparisonAvailable=true;},v=>{v.classification.promotionAllowed=true;},v=>{v.currentHumanReview='SCORED';},v=>{v.warnings=[];}]){const value=structuredClone(safe);mutate(value);assert.throws(()=>validateCompatibilityExport(value),e=>e instanceof CompatibilityExportError);}
  }
});
test('S6 recognized forged envelopes and unrecognized legacy-looking containers retain their actual error layers',()=>{
  const local=readCompatibilityInput(loadFixture('legacy.result.1.2')).record;
  const recognized=structuredClone(local);recognized.trust.evaluationTrust='LOCAL_SELF_ASSESSMENT';
  assert.throws(()=>createCompatibilityExport(recognized),e=>e instanceof ResultInputError&&e.code==='RESULT_INPUT_INVALID');
  const noLongerEnvelope=structuredClone(local);noLongerEnvelope.promotionAllowed=true;
  assert.throws(()=>createCompatibilityExport(noLongerEnvelope),e=>e instanceof ContractValidationError);
  const malformedSource=structuredClone(local);malformedSource.sourceRecord.official='yes';
  assert.throws(()=>createCompatibilityExport(malformedSource),e=>e.constructor===Error&&/official must be a boolean/.test(e.message),'a recognized envelope does not relabel a source-reader reconstruction refusal');
  for(const raw of [null,[],3,'not JSON'])assert.throws(()=>createCompatibilityExport(raw),e=>e instanceof ResultInputError&&e.code==='RESULT_INPUT_INVALID');
  const historicalKindCollision=structuredClone(loadFixture('legacy.result.1.0'));historicalKindCollision.kind='Report';
  const out=createCompatibilityExport(historicalKindCollision);assert.equal(out.family,'LEGACY');assert.equal(out.currentEvidence,false);assert.equal(out.currentHumanReview,'NOT_REVIEWED');
});
