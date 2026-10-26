// Captain API consistency check: documentation must not invent a score-bypass option.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const doc=fs.readFileSync(new URL('../../docs/MEASUREMENTS.md',import.meta.url),'utf8');
test('S2 guide documents the implemented single-request token input, not arbitrary human points',()=>{
  const code=[...doc.matchAll(/```(?:js|ts)\s*([\s\S]*?)```/g)].map(m=>m[1]).join('\n');
  assert.match(code,/createReport\(\{/);
  assert.match(code,/metrics:\s*myNeutralTokenInput/);
  assert.doesNotMatch(code,/createReport\(\{[^;]*?\},\s*\{/);
  assert.doesNotMatch(code,/humanUIQuality\s*:/);
  assert.doesNotMatch(doc,/not yet in the shipped|planned optional|Shape as planned/i);
  assert.match(doc,/RUN_TOTAL/);
  assert.match(doc,/inputIncludesCacheReads/);
  assert.match(doc,/MEASURED\s*\/\s*`COMPUTED`/);
  assert.match(doc,/UNAVAILABLE/);
  assert.match(doc,/not.*measured telemetry/);
  assert.match(doc,/operator attestation/);
  assert.match(doc,/local and private/);
});
