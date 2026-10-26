// Captain fixed arithmetic expectations, not eligibility decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {projectQualityDeltas} from '../../packages/results/comparison-arithmetic.mjs';
test('S7 arithmetic preserves signed scorer precision, reviewed zero and explicit null masks',()=>{
  const baseline={automated:20.6753,humanUI:20,quality:40.6753},candidate={automated:80,humanUI:0,quality:80};
  assert.deepEqual(projectQualityDeltas({mode:'REVIEWED',baseline,candidate}),{automated:59.3247,humanUI:-20,quality:39.3247});
  assert.deepEqual(projectQualityDeltas({mode:'AUTOMATED_ONLY',baseline,candidate}),{automated:59.3247,humanUI:null,quality:null});
  for(const mode of ['BLOCKED','REFUSED','BASELINE'])assert.deepEqual(projectQualityDeltas({mode,baseline:null,candidate:null}),{automated:null,humanUI:null,quality:null});
});
