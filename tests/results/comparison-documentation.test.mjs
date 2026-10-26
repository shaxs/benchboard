import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('S7 guide names actual descriptive predicate, refusal/disclosure and no-formal limits',()=>{
  const text=fs.readFileSync(new URL('../../docs/COMPARISON.md',import.meta.url),'utf8').replace(/\s+/g,' ');
  for(const name of ['compareResults','validateComparison','renderComparisonJSON','renderComparisonText','baselineIndex','INPUT_REFUSED','AUTOMATED_ONLY','formalComparisonAvailable','ComparisonError','COMPARISON_INVALID'])assert.ok(text.includes(name),name);
  for(const re of [/challenge/i,/workload/i,/semantic/i,/package/i,/ceiling/i,/review/i,/timing/i,/trust/i,/candidate minus baseline/i,/not.*controlled/i,/null/i,/dictionary/i,/every.*input/i])assert.match(text,re);
  for(const name of ['reviewerRef','harnessRef','modelRef','reviewedAt'])assert.ok(text.includes(name),name);
  assert.match(text,/pseudonymized, not anonymized/i);assert.match(text,/deliberate|intentionally/i);
  assert.doesNotMatch(text,/reviewer identity never enters the rendered form/i);
});
