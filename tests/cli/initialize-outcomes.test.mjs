// Captain-owned diagnostic outcomes for review F2. The real application/init/C2
// path runs unchanged; a test-local fs observation inserts owned canary residue
// during source disposal. No public collaborator or runtime hook is added.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../cli/application.mjs';
import { initializeCommand } from '../../cli/initialize-command.mjs';
import { loadInstallation } from '../../cli/installation.mjs';
import { openSelectedRun } from '../../cli/run-context.mjs';
import { diagnosticOf } from '../../cli/diagnostics.mjs';
import { InitError } from '../../packages/core/init.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-cli-outcomes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 }));
  return { root, output: path.join(root, 'selected run') };
}
async function withRetainedSources(t, operation) {
  const originalUnlink = fs.unlinkSync, roots = new Set();
  const canary = 'Synthetic foreign source residue; preserve these bytes.';
  t.after(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 });
  });
  fs.unlinkSync = function(file, ...args) {
    const result = originalUnlink.call(this, file, ...args);
    if (typeof file !== 'string') return result;
    for (let at = path.dirname(file); at !== path.dirname(at); at = path.dirname(at)) {
      if (!path.basename(at).startsWith('bb-cli-source-')) continue;
      if (!roots.has(at)) {
        roots.add(at);
        fs.writeFileSync(path.join(at, 'retained-test-canary.txt'), canary, { flag: 'wx' });
      }
      break;
    }
    return result;
  };
  try { await operation(roots); }
  finally { fs.unlinkSync = originalUnlink; }
  assert.ok(roots.size > 0, 'the controlled insertion really ran during source disposal');
  for (const root of roots) {
    assert.equal(fs.readFileSync(path.join(root, 'retained-test-canary.txt'), 'utf8'), canary);
  }
}
test('real initialized summary and retained source cleanup coexist without erasing the committed run', async t => {
  const f = fixture(t), installed = loadInstallation(), stdout = [], stderr = [];
  let summary;
  await withRetainedSources(t, async roots => {
    const exit = await main(['init', '--output', f.output], { write: line => stdout.push(line), writeError: line => stderr.push(line) });
    assert.equal(exit, 0);
    assert.deepEqual(stderr, []);
    assert.equal(stdout.length, 1);
    summary = JSON.parse(stdout[0]);
    assert.equal(summary.status, 'initialised');
    assert.equal(summary.sourceCleanup.status, 'retained');
    assert.ok(roots.has(summary.sourceCleanup.root));
    assert.equal(fs.existsSync(summary.sourceCleanup.root), true);
    const opened = await openSelectedRun(f.output);
    assert.equal(opened.runId, summary.runId);
    assert.equal(opened.manifestId, summary.manifestId);
    const actual = inventoryTree({ root: opened.workspaceRoot, skipNames: [] });
    assert.equal(actual.entries.length, 26);
    assert.equal(actual.digest, installed.descriptor.workloadDigest);
  });
  assert.equal(fs.existsSync(summary.sourceCleanup.root), true, 'no later implicit cleanup erased retained residue');
});
test('original OUTPUT_EXISTS and controlled CLI_STATE survive a retained cleanup without a fabricated summary', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.output);
  fs.writeFileSync(path.join(f.output, 'foreign-output-canary.txt'), 'Unchanged occupied destination.');
  const before = inventoryTree({ root: f.output, skipNames: [] });
  const stdout = [], stderr = [];
  await withRetainedSources(t, async roots => {
    let originalFailure;
    await assert.rejects(initializeCommand({ '--output': f.output }), error => {
      originalFailure = error;
      return error instanceof InitError && error.code === 'OUTPUT_EXISTS';
    });
    assert.equal(originalFailure.path, f.output);
    assert.equal(diagnosticOf(originalFailure).code, 'CLI_STATE');
    assert.equal(diagnosticOf(originalFailure).exitCode, 3);
    const exit = await main(['init', '--output', f.output], { write: line => stdout.push(line), writeError: line => stderr.push(line) });
    assert.equal(exit, 3);
    assert.deepEqual(stdout, []);
    assert.equal(stderr.length, 1);
    assert.match(stderr[0], /^CLI_STATE:/);
    assert.equal(stderr[0].includes(f.output), false);
    assert.equal(stderr[0].includes('\n    at '), false);
    assert.equal(roots.size, 2, 'both actual failed initializations retained their own source residue');
    for (const root of roots) assert.equal(stderr[0].includes(root), false, 'failed-run cleanup roots are not falsely advertised as a success summary');
  });
  assert.deepEqual(inventoryTree({ root: f.output, skipNames: [] }), before);
});
