import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('S6 guide separates private compatibility views from safe non-promoting exports',()=>{
  const text=fs.readFileSync(new URL('../../docs/COMPATIBILITY.md',import.meta.url),'utf8').replace(/\s+/g,' ');
  for(const name of ['readCompatibilityInput','createCompatibilityExport','validateCompatibilityExport','renderCompatibilityJSON','renderCompatibilityText','UNTRUSTED_LEGACY','UNBOUND_HISTORICAL','HISTORICAL_CLAIMS_NOT_CURRENT_AUTHORITY'])assert.ok(text.includes(name),name);
  assert.match(text,/raw[^.]*private/i);assert.match(text,/sourceDigest/);assert.match(text,/computed/i);assert.match(text,/declaredHumanReview/);assert.match(text,/currentHumanReview/);assert.match(text,/formalComparisonAvailable[^.]*false/i);
  assert.doesNotMatch(text,/Projection and export integration is later work/i);
});
