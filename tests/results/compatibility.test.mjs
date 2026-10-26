// Captain-owned non-promotion cases. Raw historical records remain private local input, not exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readCompatibilityInput } from '../../packages/results/compatibility.mjs';
import { ResultInputError } from '../../packages/results/input-contract.mjs';
import { readLegacyResult, ContractValidationError } from '../../packages/core/manifest.mjs';
import { loadFixture } from '../contracts/fixtures/contracts/index.mjs';
import { makeReportFixture } from './report-fixture.mjs';
import { createReport } from '../../packages/results/report.mjs';

test('S6 supported 1.0/1.1/1.2 history preserves source/outcomes and never promotes historical authority or UI',()=>{
  for(const version of ['1.0','1.1','1.2']) for(const positive of [false,true]) {
    const source=loadFixture(`legacy.result.${positive?'positive.':''}${version}`), before=JSON.stringify(source), expected=readLegacyResult(source);
    for(const raw of [source,JSON.stringify(source),expected]) {
      const view=readCompatibilityInput(raw);
      assert.equal(view.family,'LEGACY');assert.deepEqual(view.record,expected);assert.deepEqual(view.record.sourceRecord,source);
      assert.deepEqual(view.record.preservedOutcome,expected.preservedOutcome);
      assert.equal(view.assessmentTrust,'UNTRUSTED_LEGACY');assert.equal(view.currentEvidence,false);assert.equal(view.currentHumanReview,'NOT_REVIEWED');
      assert.ok(view.warnings.includes('UNBOUND_HISTORICAL'));assert.ok(view.warnings.includes('HISTORICAL_CLAIMS_NOT_CURRENT_AUTHORITY'));assert.ok(view.warnings.includes('HISTORICAL_UI_NOT_CURRENT_WORKSHEET'));
      assert.equal(view.record.promotionAllowed,false);assert.equal(view.record.eligibility,'NOT_FORMAL_COMPARISON_ELIGIBLE');
    }
    assert.equal(JSON.stringify(source),before);
  }
});
test('S6 C1 Result stays a validated C1 input, not a C4-backed report or current UI review',()=>{
  for(const name of ['result.selfassessment','result.localscored']) {
    const source=loadFixture(name), before=JSON.stringify(source), view=readCompatibilityInput(source);
    assert.equal(view.family,'C1_RESULT');assert.equal(view.record.kind,'Result');assert.equal(view.record.resultId,source.resultId);
    assert.equal(view.currentEvidence,false);assert.equal(view.currentHumanReview,'NOT_REVIEWED');assert.equal(view.assessmentTrust,source.evaluationTrust);
    assert.ok(view.warnings.includes('C1_RESULT_NOT_C4_EVIDENCE'));assert.ok(view.warnings.includes('C1_REVIEW_NOT_CURRENT_WORKSHEET'));assert.equal(JSON.stringify(source),before);
  }
});
test('S6 current Report family retains bound evidence and infrastructure unavailability, without inventing completion',async t=>{
  const {input}=await makeReportFixture(t), report=await createReport(input), view=readCompatibilityInput(report);
  assert.equal(view.family,'REPORT');assert.equal(view.currentEvidence,true);assert.deepEqual(view.record,report);assert.equal(view.currentHumanReview,'NOT_REVIEWED');assert.equal(view.record.execution.agentOutcome,null);
  const failure=await createReport({...input,evaluation:{status:'infrastructure-error',evaluationId:null,bundle:null,evidence:null,score:null,error:{code:'TIMEOUT'}}});
  const failed=readCompatibilityInput(failure);assert.equal(failed.currentEvidence,false);assert.equal(failed.record.quality,null);
});
test('S6 malformed/unknown source and forged promoting legacy envelopes are refused',()=>{
  const invalid=e=>e instanceof ResultInputError&&e.code==='RESULT_INPUT_INVALID';
  for(const raw of [null,[],3,'not json'])assert.throws(()=>readCompatibilityInput(raw),invalid);
  assert.throws(()=>readCompatibilityInput({schemaVersion:'2.0',run:{}}),e=>e instanceof ContractValidationError&&/not a recognised historical result schema/.test(e.message));
  const legacy=structuredClone(readLegacyResult(loadFixture('legacy.result.1.2')));legacy.trust.evaluationTrust='LOCAL_SELF_ASSESSMENT';
  assert.throws(()=>readCompatibilityInput(legacy),invalid);
  const broken=structuredClone(loadFixture('legacy.result.positive.1.2'));broken.official='yes';
  assert.throws(()=>readCompatibilityInput(broken),e=>e instanceof Error&&/official must be a boolean/.test(e.message));
  const namedLikeC1=structuredClone(loadFixture('legacy.result.1.0'));namedLikeC1.kind='Result';
  assert.equal(readCompatibilityInput(namedLikeC1).family,'LEGACY','a historical version cannot be promoted by a coincidental kind tag');
});
