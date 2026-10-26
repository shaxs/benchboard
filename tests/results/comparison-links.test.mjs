import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('S7 prior result guides link to the delivered descriptive comparison API without authority promotion',()=>{
  for(const name of ['REPORTING','PUBLICATION','EXPORTS','COMPATIBILITY']){
    const text=fs.readFileSync(new URL(`../../docs/${name}.md`,import.meta.url),'utf8').replace(/\s+/g,' ');
    assert.match(text,/\]\(COMPARISON\.md\)/,name);
    assert.doesNotMatch(text,/cross-report comparisons remain later work|cross-result comparison \(S7\) remains later work|Descriptive comparison arrives separately in S7|comparisons remain a later concern/,name);
  }
});
