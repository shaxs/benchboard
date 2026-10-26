import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('S8 comparison guide links completed-flow guidance without weakening descriptive limits',()=>{
  const text=fs.readFileSync(new URL('../../docs/COMPARISON.md',import.meta.url),'utf8').replace(/\s+/g,' ');
  assert.match(text,/RESULTS_API\.md/);assert.match(text,/SCORING\.md/);
  assert.doesNotMatch(text,/flow proof is later work|S8 work and is later|until that proof exists/i);
  assert.match(text,/not formally controlled/i);assert.match(text,/synthetic/i);
});
