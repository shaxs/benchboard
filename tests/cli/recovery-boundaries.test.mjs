// Captain-owned diagnosis/lock boundaries not covered by the separate START/FREEZE acceptance task.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realRunFixture } from './run-fixture.mjs';
import { startRun, withRunTransaction, readRunLifecycle } from '../../packages/core/lifecycle.mjs';
import { createStorage } from '../../packages/core/storage.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';

const entrypoint = fileURLToPath(new URL('../../cli/benchboard.mjs', import.meta.url));
function invoke(f, args) {
  const result = spawnSync(process.execPath, [entrypoint, ...args, '--run', f.run.output], {
    cwd: f.root, encoding: 'utf8', shell: false, timeout: 15000, maxBuffer: 1048576, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr.includes(f.root), false);
  assert.equal(result.stderr.includes('\n    at '), false);
  return result;
}

test('actual STOP disposition reports unrepaired inconsistency rather than inventing a completed stop', async t => {
  const f = await realRunFixture(t);
  await startRun({ ...f.opened.request, clock: { now: () => Date.parse('2026-01-01T00:00:00.000Z') },
    declaration: { harness: null, model: null, workerCount: null, executionMode: 'MANUAL', declaredCeilingMinutes: null } });
  const stoppedAt = '2026-01-01T00:00:01.000Z';
  const event = await withRunTransaction(f.opened.request, context => context.appendEvent({
    kind: 'STOP_RECORDED', occurredAt: stoppedAt, journalCommitAt: stoppedAt,
    declaration: context.lifecycle.declaration, detail: { operator: 'synthetic-stop-operator', agentStopped: true,
      statement: 'Synthetic journaled stopped-agent assertion without a projection commit.',
      observedAt: stoppedAt, assurance: 'operator-attested', enforced: false } }));
  const view = await readRunLifecycle(f.opened.request);
  assert.equal(view.state, 'RUNNING');
  assert.equal(view.diagnosis, 'inconsistent');
  const before = inventoryTree({ root: f.run.output, skipNames: [] });
  for (const decision of ['LEAVE_AS_IS', 'COMPLETE']) {
    const result = invoke(f, ['reconcile', '--operation', 'stop', '--disposition', decision,
      '--operator', 'synthetic-recovery-operator', '--intent', event.eventDigest]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.operation, 'STOP');
    assert.equal(summary.requestedDisposition, decision);
    assert.equal(summary.action, 'LEAVE_AS_IS');
    assert.equal(summary.repaired, false);
    assert.equal(summary.diagnosis, 'inconsistent');
    assert.equal(summary.state, 'RUNNING');
    assert.equal(JSON.stringify(summary).includes('synthetic-recovery-operator'), false);
    assert.deepEqual(inventoryTree({ root: f.run.output, skipNames: [] }), before);
  }
});

test('actual freeze/reconcile/reset children refuse a live C1 lock without taking it or changing records', async t => {
  const f = await realRunFixture(t), output = path.join(f.root, 'never reset under lock');
  const holder = createStorage({ root: f.opened.stateRoot });
  await holder.withLock(async () => {
    const before = inventoryTree({ root: f.run.output, skipNames: [] });
    for (const args of [
      ['freeze', '--clockless', '--operator', 'synthetic-lock-operator', '--agents-stopped'],
      ['reconcile', '--operation', 'start', '--disposition', 'COMPLETE', '--operator', 'synthetic-lock-operator', '--intent', 'a'.repeat(64)],
      ['reset', '--output', output],
    ]) {
      const result = invoke(f, args);
      assert.equal(result.status, 3, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^CLI_STATE:/);
      assert.deepEqual(inventoryTree({ root: f.run.output, skipNames: [] }), before);
      await assert.rejects(createStorage({ root: f.opened.stateRoot }).withLock(() => {}), error => error.code === 'ERR_STORAGE_LOCK_CONFLICT');
    }
  });
  assert.equal(fs.existsSync(output), false);
});
