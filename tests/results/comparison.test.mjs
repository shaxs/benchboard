// Captain acceptance/binding/privacy policy tests independent from worker arithmetic/rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import {compareResults,validateComparison,ComparisonError} from '../../packages/results/comparison.mjs';
import {renderComparisonJSON,renderComparisonText} from '../../packages/results/comparison-exports.mjs';
import {privateExportFixture,PRIVATE_CANARIES} from './export-fixture.mjs';
import {loadFixture} from '../contracts/fixtures/contracts/index.mjs';
import {actualEvaluatorOf,digestOf,reportDigestOf,validateReport} from '../../packages/results/report-contract.mjs';
import {createReport} from '../../packages/results/report.mjs';
import {prepareReviewedReport} from '../../packages/results/reviewed-report.mjs';
import {physicalWorksheet} from './publication-fixture.mjs';
import {hashEntries} from '../../packages/core/identity.mjs';
import {score} from '../../evaluator/score.mjs';
import {scorerEvidenceOf} from '../../packages/evaluation/bundle.mjs';
function vary(parent,change){
  const r=structuredClone(parent);change(r);
  // Synthetic identity variations must remain internally consistent. Never edit the
  // real evaluator files/manifests or special scoring entry to exercise a mismatch.
  const evaluator=r.evidence.bundle.identities.evaluator,original=parent.evidence.bundle.identities.evaluator;
  for(const [manifest,key]of [['semanticManifest','semanticDigest'],['packageManifest','packageDigest']])if(evaluator[key]!==original[key]){
    const entry=evaluator[manifest].find(e=>e.path!=='evaluator/score.mjs');assert.ok(entry);
    entry.sha256=evaluator[key];evaluator[key]=hashEntries(evaluator[manifest]);assert.notEqual(evaluator[key],original[key]);
  }
  r.actualEvaluator=actualEvaluatorOf(r.evidence.bundle);r.evidence.bundleDigest=digestOf(r.evidence.bundle);r.reportDigest=reportDigestOf(r);return validateReport(r);
}
test('S7 matching semantics permit only descriptive automated deltas pending review; reviewed zero is not unavailable',async t=>{
  const f=await privateExportFixture(t),r=f.parent;
  const invalid=structuredClone(r);invalid.evidence.bundle.identities.evaluator.semanticDigest='3'.repeat(64);invalid.actualEvaluator=actualEvaluatorOf(invalid.evidence.bundle);invalid.evidence.bundleDigest=digestOf(invalid.evidence.bundle);invalid.reportDigest=reportDigestOf(invalid);
  assert.throws(()=>validateReport(invalid),/Evaluator manifest digest mismatch/,'retain the C4 guard; valid comparison fixtures must reseal manifest digests');
  const same=compareResults({inputs:[r,r],baselineIndex:0});assert.equal(same.items[0].disposition,'BASELINE');assert.equal(same.items[0].deltas.automated,null);
  assert.equal(same.items[1].disposition,'AUTOMATED_ONLY');assert.deepEqual(same.items[1].deltas,{automated:0,humanUI:null,quality:null});
  const zero=prepareReviewedReport({parent:f.report,worksheet:physicalWorksheet(f.report,f.reviewRoot,false),reportId:'comparison-zero-child',createdAt:'2026-01-05T00:00:00.000Z'});
  const reviewed=compareResults({inputs:[f.child,zero],baselineIndex:0});assert.equal(reviewed.items[1].disposition,'REVIEWED');assert.deepEqual(reviewed.items[1].deltas,{automated:0,humanUI:-20,quality:-20});
  const reverse=compareResults({inputs:[f.child,zero],baselineIndex:1});assert.deepEqual(reverse.items[0].deltas,{automated:0,humanUI:20,quality:20});
  assert.equal(reviewed.formalComparisonAvailable,false);assert.ok(reviewed.notices.includes('NOT_FORMALLY_CONTROLLED'));
});
test('S7 independent challenge/workload/actual-semantic changes block quality, not just version or binding checks',async t=>{
  const f=await privateExportFixture(t),r=f.parent;
  const cases=[
    ['CHALLENGE_IDENTITY_DIFFERS',x=>{x.bindings.challengeId='different-challenge';x.evidence.bundle.identities.challenge.id=x.bindings.challengeId;}],
    ['CHALLENGE_IDENTITY_DIFFERS',x=>{x.bindings.challengeIdentityDigest='1'.repeat(64);x.evidence.bundle.identities.challenge.digest=x.bindings.challengeIdentityDigest;}],
    ['WORKLOAD_DIFFERS',x=>{x.bindings.workloadDigest='2'.repeat(64);}],
    ['SEMANTIC_IDENTITY_DIFFERS',x=>{x.evidence.bundle.identities.evaluator.semanticDigest='3'.repeat(64);}]
  ];
  for(const [reason,change]of cases){const out=compareResults({inputs:[r,vary(r,change)],baselineIndex:0});assert.equal(out.items[1].disposition,'BLOCKED');assert.ok(out.items[1].reasons.includes(reason),reason);assert.deepEqual(out.items[1].deltas,{automated:null,humanUI:null,quality:null});}
  const bindingOnly=vary(r,x=>{x.bindings.evaluatorIdentityDigest='4'.repeat(64);x.evidence.bundle.identities.evaluator.binding.digest=x.bindings.evaluatorIdentityDigest;});
  const out=compareResults({inputs:[r,bindingOnly],baselineIndex:0});assert.equal(out.items[1].disposition,'AUTOMATED_ONLY');assert.ok(out.items[1].disclosures.includes('EVALUATOR_BINDING_DIFFERS'));
});
test('S7 package/tooling/ceiling/configuration/timing/review differences disclose rather than claim controlled conditions',async t=>{
  const f=await privateExportFixture(t),r=f.parent;
  const changed=vary(r,x=>{x.evidence.bundle.identities.evaluator.packageDigest='5'.repeat(64);x.bindings.toolingIdentityDigest='6'.repeat(64);x.evidence.bundle.identities.tooling.digest=x.bindings.toolingIdentityDigest;x.configuration.declaredCeilingMinutes=1;x.configuration.workerCount=9;});
  const out=compareResults({inputs:[r,changed],baselineIndex:0});assert.equal(out.items[1].disposition,'AUTOMATED_ONLY');
  for(const code of ['MANUAL_UNENFORCED','NOT_FORMALLY_CONTROLLED','EVALUATOR_PACKAGE_DIFFERS','TOOLING_DIFFERS','CEILING_DIFFERS','DECLARATION_DIFFERS','TIMING_UNAVAILABLE','REVIEW_UNAVAILABLE'])assert.ok(out.items[1].disclosures.includes(code),code);
  const review=compareResults({inputs:[f.report,f.child],baselineIndex:0});assert.equal(review.items[1].disposition,'AUTOMATED_ONLY');assert.ok(review.items[1].disclosures.includes('REVIEW_AVAILABILITY_DIFFERS'));
});
test('S7 every malformed/legacy/C1/infrastructure input and duplicate retains disposition and safe data without private errors',async t=>{
  const f=await privateExportFixture(t),infra=await createReport({...f.input,evaluation:{status:'infrastructure-error',evaluationId:null,bundle:null,evidence:null,score:null,error:{code:'TIMEOUT'}}});
  const inputs=[f.parent,loadFixture('legacy.result.positive.1.2'),loadFixture('result.localscored'),infra,{schemaVersion:'9.0',private:PRIVATE_CANARIES.join(' ')},f.parent],before=JSON.stringify(inputs),out=compareResults({inputs,baselineIndex:0});
  assert.equal(out.items.length,inputs.length);assert.deepEqual(out.items.map(item=>item.index),[0,1,2,3,4,5]);assert.deepEqual(out.items.map(i=>i.disposition),['BASELINE','BLOCKED','BLOCKED','BLOCKED','REFUSED','AUTOMATED_ONLY']);
  assert.ok(out.items[1].disclosures.includes('TRUST_DIFFERS'));assert.equal(out.items[4].summary,null);assert.deepEqual(out.items[4].reasons,['INPUT_REFUSED']);
  assert.ok(out.items[3].reasons.includes('INPUT_INFRASTRUCTURE'));
  assert.ok(out.items[3].reasons.includes('SEMANTIC_PROVENANCE_UNAVAILABLE'));
  assert.equal(JSON.stringify(inputs),before);
  for(const baselineIndex of [1,2,3,4]){
    const other=compareResults({inputs,baselineIndex});assert.equal(other.items.length,inputs.length);assert.ok(other.items.filter(i=>i.disposition!=='BASELINE').every(i=>i.deltas.automated===null));
    const base=other.items[baselineIndex];
    if(baselineIndex===4){assert.equal(base.disposition,'REFUSED');assert.deepEqual(base.reasons,['INPUT_REFUSED']);for(const i of [0,1,2,3,5]){assert.equal(other.items[i].disposition,'BLOCKED');assert.deepEqual(other.items[i].reasons,['BASELINE_UNAVAILABLE']);}}
    else{assert.equal(base.disposition,'BASELINE');assert.deepEqual(base.reasons,['BASELINE_NO_SELF_DELTA']);assert.deepEqual(base.deltas,{automated:null,humanUI:null,quality:null});}
  }
  for(const render of [renderComparisonJSON,renderComparisonText]){const text=render(out);for(const canary of PRIVATE_CANARIES)assert.ok(!text.includes(canary),canary);}
});
test('S7 a valid fractional Report reaches creator, independent final arithmetic and both safe formats',async t=>{
  const f=await privateExportFixture(t),baseline=f.parent,partial=structuredClone(baseline);
  assert.equal(baseline.evidence.bundle.visible.passed,17);
  partial.evidence.bundle.visible.passed=10;
  partial.evidence.bundle.score=score(scorerEvidenceOf(partial.evidence.bundle),null);
  partial.quality=structuredClone(partial.evidence.bundle.score);
  partial.evidence.bundleDigest=digestOf(partial.evidence.bundle);partial.reportDigest=reportDigestOf(partial);
  validateReport(partial);
  const comparison=compareResults({inputs:[baseline,partial],baselineIndex:0});
  assert.equal(comparison.items[1].disposition,'AUTOMATED_ONLY');assert.equal(comparison.items[1].deltas.automated,-2.8824);assert.equal(comparison.items[1].deltas.quality,null);
  assert.deepEqual(validateComparison(comparison),comparison);assert.deepEqual(JSON.parse(renderComparisonJSON(comparison)),comparison);assert.ok(renderComparisonText(comparison).includes('items.1.deltas.automated: -2.8824\n'));
});
test('S7 both exports preserve every validated comparison leaf and refuse forged deltas, masks, omissions and raw inputs',async t=>{
  const f=await privateExportFixture(t),out=compareResults({inputs:[f.parent,f.child],baselineIndex:0}),json=renderComparisonJSON(out),text=renderComparisonText(out);
  assert.deepEqual(JSON.parse(json),out);assert.deepEqual(validateComparison(out),out);
  const walk=(v,key='')=>{if(v!==null&&typeof v==='object'){if(Object.keys(v).length===0)assert.ok(text.includes(key+': '+(Array.isArray(v)?'[]':'{}')+'\n'));else for(const [k,x]of Object.entries(v))walk(x,key?key+'.'+k:k);}else assert.ok(text.includes(key+': '+JSON.stringify(v)+'\n'),key);};walk(out);
  for(const mutate of [v=>{v.items[1].deltas.quality=0;},v=>{v.items[1].deltas.automated=1;},v=>{v.items[1].disposition='REVIEWED';},v=>{v.items[1].disclosures=[];},v=>{v.items[1].index=8;},v=>{v.rawLogs=PRIVATE_CANARIES[3];},v=>{v.formalComparisonAvailable=true;}]){const v=structuredClone(out);mutate(v);for(const validate of [validateComparison,renderComparisonJSON,renderComparisonText])assert.throws(()=>validate(v),e=>e instanceof ComparisonError);}
  for(const request of [{inputs:[f.parent],baselineIndex:0},{inputs:[f.parent,f.child],baselineIndex:-1},{inputs:[f.parent,f.child],baselineIndex:2},{inputs:[f.parent,f.child],baselineIndex:0,options:{}}])assert.throws(()=>compareResults(request),e=>e instanceof ComparisonError);
  for(const render of [renderComparisonJSON,renderComparisonText])assert.throws(()=>render(f.parent),e=>e instanceof ComparisonError);
});
