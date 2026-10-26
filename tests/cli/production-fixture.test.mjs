// Captain verifies shared setup only. No evaluation/browser/server is launched by this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionRun, productionInputs, invokeProduction, successSummary } from './production-fixture.mjs';
test('shared production-proof setup uses actual init and clockless freeze without inventing results', async t => {
  const f = await createProductionRun(t), before = productionInputs(f);
  const status = successSummary(invokeProduction(f.root, ['status', '--run', f.runRoot]));
  assert.equal(status.state, 'FROZEN');
  assert.equal(status.runId, f.init.runId);
  assert.equal(f.frozen.elapsedMs, null);
  assert.equal(f.frozen.treeDigest, f.init.workloadDigest);
  assert.deepEqual(status.attempts, []);
  assert.ok(Object.values(before).every(entries => entries.length > 0 && entries.every(e => /^[0-9a-f]{64}$/.test(e.sha256))));
  assert.deepEqual(productionInputs(f), before);
});
