// Captain-owned real C3 selection boundary. No evaluation, runtime injection, server or agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { realRunFixture } from './run-fixture.mjs';
import { freezeRun } from '../../packages/core/freeze.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { selectVerifiedFrozen } from '../../cli/frozen-selection.mjs';
import { diagnosticOf } from '../../cli/diagnostics.mjs';

test('actual verified selection requires frozen authority, binds explicit saved IDs and separates live drift', async t => {
  const f = await realRunFixture(t);
  await assert.rejects(selectVerifiedFrozen(f.opened), error => diagnosticOf(error).exitCode === 3);
  const frozen = await freezeRun({ ...f.opened.request, clockless: true, attestation: {
    operator: 'synthetic-selection-operator', agentStopped: true, clockless: true,
    statement: 'Synthetic fixture explicitly attests a never-started stopped workspace.' } });
  const before = inventoryTree({ root: frozen.snapshotRoot, skipNames: [] });
  const selected = await selectVerifiedFrozen(f.opened);
  assert.equal(selected.snapshotId, frozen.snapshotId);
  assert.equal(selected.frozenSubmissionId, frozen.frozenSubmission.frozenSubmissionId);
  assert.equal(selected.treeDigest, before.digest);
  assert.equal(selected.workspaceMatchesFrozenInventory, true);
  fs.appendFileSync(path.join(f.run.workspace.root, 'package.json'), '\n');
  const afterEdit = await selectVerifiedFrozen(f.opened, frozen.snapshotId);
  assert.equal(afterEdit.workspaceMatchesFrozenInventory, false);
  assert.equal(afterEdit.treeDigest, selected.treeDigest);
  assert.deepEqual(inventoryTree({ root: frozen.snapshotRoot, skipNames: [] }), before);
  await assert.rejects(selectVerifiedFrozen(f.opened, `snap-${'b'.repeat(32)}`), error => diagnosticOf(error).exitCode === 3);
  await assert.rejects(selectVerifiedFrozen({}, '../private-canary'), error => diagnosticOf(error).exitCode === 2);
  fs.appendFileSync(path.join(frozen.snapshotRoot, 'package.json'), '\n');
  await assert.rejects(selectVerifiedFrozen(f.opened, frozen.snapshotId), error => diagnosticOf(error).exitCode === 4);
});
