// Captain safety/API documentation regression: no invented platform or publication guarantees.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('S4 publication guide and declarations retain precise cooperative/private/marker limits',()=>{
  const doc=fs.readFileSync(new URL('../../docs/PUBLICATION.md',import.meta.url),'utf8').replace(/\s+/g,' ');
  for(const name of ['saveReport','readPublishedReport','attachUIReview'])assert.match(doc,new RegExp(name));
  for(const bound of ['512 artifacts','128 MiB','512 MiB','16 MiB','192 MiB'])assert.ok(doc.includes(bound),bound);
  assert.match(doc,/PUBLICATION_INCOMPLETE/);assert.match(doc,/PUBLICATION_DUPLICATE/);
  assert.match(doc,/exact same baseline input/);assert.match(doc,/orphaned accepted lock/);
  assert.match(doc,/before[^.]*marker/i);
  assert.match(doc,/no hostile-writer or power-loss durability guarantee/);
  assert.match(doc,/(?:not|none)[^.]*privacy-safe export/i);
  assert.doesNotMatch(doc,/API creates nothing for you/);
  assert.doesNotMatch(doc,/Before and again after the write[^.]*re-runs the real C3 verification/);
  assert.doesNotMatch(doc,/a refusal leaves no partial advertisement of success/i);
  assert.match(doc,/ERR_STORAGE_LOCK_CONFLICT/);
  assert.match(doc,/read[^.]*metadata/i);
  assert.doesNotMatch(doc,/[A-Za-z]:\\|\/home\/|\/Users\//);
  for(const name of ['publication','publication-runtime','artifact-verification']) {
    const declaration=fs.readFileSync(new URL(`../../packages/results/${name}.d.mts`,import.meta.url),'utf8');
    assert.doesNotMatch(declaration,/Node builtins only/);
  }
});
test('S4 public module exposes only the three production entry points',async()=>{
  const surface=await import('../../packages/results/publication.mjs');
  assert.deepEqual(Object.keys(surface).sort(),['attachUIReview','readPublishedReport','saveReport']);
});
