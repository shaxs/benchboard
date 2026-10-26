import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('S8 scoring guide uses executable 80 plus optional 20, no invented review or authority',()=>{
  const text=fs.readFileSync(new URL('../../docs/SCORING.md',import.meta.url),'utf8').replace(/\s+/g,' ');
  for(const phrase of ['80','20','100','visible','functional','persistence','edge','integration','code','usefulTests','hygiene','polish','hierarchy','board','drawer','feedback','responsive','consistency'])assert.ok(text.includes(phrase),phrase);
  assert.match(text,/evaluator\/score\.mjs/);assert.match(text,/null/);assert.match(text,/local self-assessment/i);assert.match(text,/not.*certif/i);assert.match(text,/infrastructure/i);assert.match(text,/toFixed\(4\)/);assert.match(text,/PRD.*85|85.*PRD/i);
  assert.doesNotMatch(text,/Seven categories, all optional|Failing tests and refusals earn no partial credit/i);
  assert.match(text,/all seven|seven.*required/i);assert.match(text,/earned.*elsewhere|points.*elsewhere/i);
});
