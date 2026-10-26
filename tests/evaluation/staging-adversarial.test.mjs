// Captain-owned security diagnostics. No tools, browser, server or process launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { stageFrozen, verifySelection } from '../../packages/evaluation/staging.mjs';
import { evaluateWithRuntime } from '../../packages/evaluation/controller.mjs';
import { createFrozenFixture, snapshotInputs, assertInputsUnchanged } from './helpers.mjs';

test('C3-included top-level excluded-name aliases are explicit staging refusals before output or tools', async t => {
  for (const name of ['Node_Modules', 'Dist', '.Git', '.Cache', 'Coverage', '.Vite', '.BenchBoard', '.Agent-Teams']) {
    const f = await createFrozenFixture(t, { mutateWorkspace(root) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, 'canary.txt'), 'participant-selected bytes');
    } });
    const before = snapshotInputs(f);
    // C3 deliberately includes this case spelling; evaluation refuses, never changes selection.
    assert.ok(fs.existsSync(path.join(f.frozen.snapshotRoot, name, 'canary.txt')));
    await assert.rejects(evaluateWithRuntime(f.request, f.runtime), error =>
      error.name === 'EvaluationRefusalError' && error.code === 'UNSAFE_ENTRY' && error.cleanup.removed);
    assert.equal(fs.existsSync(f.request.outputRoot), false);
    assert.deepEqual(f.contexts, []);
    assert.deepEqual(f.events.map(e => e.name), ['verify-before', 'cleanup']);
    assertInputsUnchanged(f, before);
  }
});

test('abort at each staging phase is CANCELLED with clean owned scratch and no subsequent phase', async t => {
  const phases = ['copy-frozen', 'canonical-replacement', 'prepared-dependencies'];
  for (const phase of phases) {
    const f = await createFrozenFixture(t), before = snapshotInputs(f), abort = new AbortController();
    const verified = await verifySelection(f.request), events = [];
    await assert.rejects(stageFrozen(verified, { ...f.request, signal: abort.signal }, {
      canonicalRoot: f.canonicalRoot, dependencyRoot: f.dependencyRoot,
      onEvent(name) { events.push(name); if (name === phase) abort.abort(); },
    }), error => error.code === 'CANCELLED' && error.stage === 'preflight' &&
      error.cleanup.removed && error.cleanup.errors.length === 0 && error.cleanup.residue.length === 0);
    assert.deepEqual(events, phases.slice(0, phases.indexOf(phase) + 1));
    assert.deepEqual(fs.readdirSync(f.request.outputRoot), []);
    assertInputsUnchanged(f, before);
  }
});

test('external abort is observed during a multi-file prepared dependency copy, not after all files', async t => {
  const f = await createFrozenFixture(t), abort = new AbortController(), events = [];
  const payload = path.join(f.dependencyRoot, 'payload');
  fs.mkdirSync(payload);
  for (let index = 0; index < 300; index++) fs.writeFileSync(path.join(payload, String(index).padStart(4, '0') + '.txt'), 'prepared bytes');
  const dependencyDigest = inventoryTree({ root: f.dependencyRoot, skipNames: [] }).digest;
  const before = snapshotInputs(f), verified = await verifySelection(f.request);
  const write = fs.writeFileSync;
  let copiedPayload = 0, abortCallbackRan = false, appRoot = null;
  const probe = t.mock.method(fs, 'writeFileSync', function (target, ...args) {
    const result = write.call(fs, target, ...args);
    if (typeof target === 'string' && appRoot && target.startsWith(appRoot + path.sep) &&
      target.includes(path.sep + 'node_modules' + path.sep + 'payload' + path.sep)) {
      copiedPayload++;
      if (copiedPayload === 1) setImmediate(() => { abortCallbackRan = true; abort.abort(); });
    }
    return result;
  });
  try {
    await assert.rejects(stageFrozen(verified, { ...f.request, signal: abort.signal }, {
      canonicalRoot: f.canonicalRoot, dependencyRoot: f.dependencyRoot,
      onEvent: (name, facts) => { events.push(name); appRoot ??= facts?.appRoot ?? null; },
    }), error => error.code === 'CANCELLED' && error.stage === 'preflight' && error.cleanup.removed &&
      error.cleanup.residue.length === 0 && error.cleanup.errors.length === 0);
  } finally { probe.mock.restore(); }
  assert.equal(abortCallbackRan, true);
  assert.ok(copiedPayload > 0 && copiedPayload < 300, 'abort interrupts between batches, copied=' + copiedPayload);
  assert.deepEqual(events, ['copy-frozen', 'canonical-replacement']);
  assert.deepEqual(fs.readdirSync(f.request.outputRoot), []);
  assert.equal(inventoryTree({ root: f.dependencyRoot, skipNames: [] }).digest, dependencyDigest);
  assertInputsUnchanged(f, before);
  console.log('staging abort observation:', JSON.stringify({ copiedPayload, totalPayload: 300, abortCallbackRan }));
});

test('staging cancellation never deletes an unexpected foreign insertion to pretend clean removal', async t => {
  const f = await createFrozenFixture(t), before = snapshotInputs(f), abort = new AbortController();
  const verified = await verifySelection(f.request);
  let foreign;
  await assert.rejects(stageFrozen(verified, { ...f.request, signal: abort.signal }, {
    canonicalRoot: f.canonicalRoot, dependencyRoot: f.dependencyRoot,
    onEvent(name, facts) {
      if (name !== 'copy-frozen') return;
      foreign = path.join(path.dirname(facts.appRoot), 'foreign-canary');
      fs.writeFileSync(foreign, 'keep foreign bytes');
      abort.abort();
    },
  }), error => error.code === 'CANCELLED' && !error.cleanup.removed &&
    error.cleanup.errors[0].code === 'CLEANUP_FAILED' && error.cleanup.residue.length === 1);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'keep foreign bytes');
  assertInputsUnchanged(f, before);
});
