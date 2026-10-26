// Captain-decided pure measurement cases; no agent telemetry or interval engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMeasurements } from '../../packages/results/measurements.mjs';
import { validateNeutralTokenInput, MeasurementIntegrityError } from '../../packages/results/measurement-contract.mjs';
import { validateRecord } from '../../packages/core/manifest.mjs';
const tokens = (inputTokens=100,outputTokens=20,cacheReadTokens=40) => ({schemaVersion:'1.0.0',kind:'NeutralTokenInput',sourceId:'tokens-synthetic-001',scope:'RUN_TOTAL',inputIncludesCacheReads:true,inputTokens,outputTokens,cacheReadTokens});
const input = (elapsedMs=null,tokenInput=null,quality={automated:80,humanUI:null,quality:null}) => ({idPrefix:'report-measurements-001',timing:{elapsedMs},tokens:tokenInput,quality});
const rows = value => Object.fromEntries(value.map(m=>[m.metric,m]));
test('S2 null is unavailable, genuine zero survives, cache reads are not added twice, every row is a C1 Measurement',()=>{
  const missing=rows(projectMeasurements(input()));
  assert.equal(Object.keys(missing).length,13);
  for(const key of ['elapsedWallMs','elapsedWallSeconds','inputTokens','outputTokens','cacheReadTokens','totalTokens','humanUIQuality','finalQuality','automatedPointsPerThousandTokens','finalPointsPerThousandTokens','qualityPointsPerWallSecond','utilization']) {assert.equal(missing[key].value,null);assert.equal(missing[key].measurementKind,'UNAVAILABLE');assert.equal(missing[key].source,null);}
  const zero=rows(projectMeasurements(input(0,tokens(0,0,0))));
  assert.equal(zero.elapsedWallMs.value,0);assert.equal(zero.elapsedWallSeconds.value,0);assert.equal(zero.totalTokens.value,0);assert.equal(zero.automatedPointsPerThousandTokens.value,null);
  const known=projectMeasurements(input(2000,tokens(),{automated:80,humanUI:20,quality:100})), indexed=rows(known);
  assert.equal(indexed.totalTokens.value,120);assert.equal(indexed.cacheReadTokens.value,40);assert.equal(indexed.elapsedWallSeconds.value,2);
  assert.equal(indexed.automatedPointsPerThousandTokens.value,80*1000/120);assert.equal(indexed.finalPointsPerThousandTokens.value,100*1000/120);assert.equal(indexed.qualityPointsPerWallSecond.value,50);assert.equal(indexed.utilization.value,null);
  assert.equal(indexed.inputTokens.measurementKind,'ENTERED');assert.equal(indexed.totalTokens.measurementKind,'DERIVED');
  for(const record of known){assert.deepEqual(validateRecord('Measurement',record),record);assert.equal(record.source?.recordKind,undefined);}
  assert.deepEqual(JSON.parse(JSON.stringify(known)),known);
});
test('S2 partial token input prevents totals/efficiency; ambiguous caches, duplicate totals and actor aggregates are refused',()=>{
  const partial=rows(projectMeasurements(input(1000,tokens(null,20,null))));
  assert.equal(partial.outputTokens.value,20);assert.equal(partial.totalTokens.value,null);assert.equal(partial.automatedPointsPerThousandTokens.value,null);
  const bad = e=>e instanceof MeasurementIntegrityError&&e.code==='MEASUREMENT_INTEGRITY';
  for(const value of [{...tokens(),inputIncludesCacheReads:false},{...tokens(),inputIncludesCacheReads:null},{...tokens(),totalTokens:120},{...tokens(),actors:[]},{...tokens(),scope:'ACTOR_TOTALS'},tokens(1,1,2),{...tokens(),inputTokens:-1},{...tokens(),outputTokens:1.5}]) assert.throws(()=>validateNeutralTokenInput(value),bad);
  assert.deepEqual(validateNeutralTokenInput(tokens(0,0,0)),tokens(0,0,0));assert.equal(validateNeutralTokenInput(null),null);
});
test('S2 final efficiencies cannot bypass unavailable quality components through a supplied total',()=>{
  for(const quality of [{automated:80,humanUI:null,quality:100},{automated:null,humanUI:20,quality:100}]) {
    const actual=rows(projectMeasurements(input(2000,tokens(),quality)));
    for(const name of ['finalQuality','finalPointsPerThousandTokens','qualityPointsPerWallSecond']) {
      assert.equal(actual[name].value,null,name+' requires both quality components');
      assert.equal(actual[name].measurementKind,'UNAVAILABLE');
    }
  }
});
