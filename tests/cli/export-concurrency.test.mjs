// Two real Node processes against one shared fresh export root: an independent exclusive-claim
// proof over the Captain-owned production writer. Controlled C4/C5 synthetic safe pairs and
// test-owned ordinary input files only, not actual evaluator execution, human review, a real
// committed-child claim or the production CLI handlers. All helpers are file-local.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { makePublicationFixture, physicalWorksheet } from '../results/publication-fixture.mjs';
import { snapshotInputs, assertInputsUnchanged } from '../evaluation/helpers.mjs';
import { createExportProjection } from '../../packages/results/export-contract.mjs';
import { renderReportJSON, renderReportText } from '../../packages/results/exports.mjs';
import { prepareReviewedReport } from '../../packages/results/reviewed-report.mjs';
import { publishSafeExport, EXPORT_NAMES, EXPORT_MARKER } from '../../cli/export-publication.mjs';

const MAX_CHILD_OUTPUT_BYTES = 1048576;
const CHILD_BOUND_MS = 20000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bundleFiles = () => [...EXPORT_NAMES, EXPORT_MARKER];

// Test-only child wrapper: reads its fixed safe pair from an ordinary input file BEFORE reporting
// ready, imports the production publishSafeExport and runs it once when the barrier releases.
function childScript(inputFile, output, protectedRoots, moduleUrl) {
  return [
    '(async () => {',
    '  const fs = await import("node:fs");',
    `  const input = JSON.parse(fs.readFileSync(${JSON.stringify(inputFile)}, "utf8"));`,
    `  const { publishSafeExport } = await import(${JSON.stringify(moduleUrl)});`,
    '  process.send({ type: "ready" });',
    '  process.once("message", (message) => {',
    '    if (!message || message.type !== "go") return;',
    '    let report;',
    '    try {',
    `      const result = publishSafeExport({ output: ${JSON.stringify(output)}, json: input.json, text: input.text, protectedRoots: ${JSON.stringify(protectedRoots)} });`,
    '      report = { type: "done", outcome: "success", complete: result.complete };',
    '    } catch (error) {',
    '      const fate = error.exportFate === undefined ? null : { complete: error.exportFate.complete, cleanup: error.exportFate.cleanup };',
    '      report = { type: "done", outcome: "failure", category: error.category ?? null, code: error.code ?? null, fate: fate };',
    '    }',
    '    process.send(report, () => process.disconnect());',
    '  });',
    '})().catch((error) => {',
    '  process.send({ type: "boot-failure", message: String((error && error.message) || error) }, () => process.disconnect());',
    '});',
  ].join('\n');
}

// One bounded, shell-free child process: IPC result, 1 MiB output cap, kill only on this test's own
// timeout or overrun. Resolves with the child's final report, rejects with a test-visible failure.
function startChild({ script, input, onReady }) {
  let resolve, reject, settled = false;
  const completion = new Promise((ok, bad) => { resolve = ok; reject = bad; });
  const settle = (error, value) => { if (!settled) { settled = true; if (error !== null) reject(error); else resolve(value); } };
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let childBytes = 0;
  const capped = chunk => {
    childBytes += chunk.length;
    if (childBytes > MAX_CHILD_OUTPUT_BYTES) { try { child.kill(); } catch {} settle(new Error('a child exceeded the 1 MiB output bound')); }
  };
  child.stdout.on('data', capped);
  child.stderr.on('data', capped);
  let report;
  child.on('message', message => {
    if (message.type === 'ready') onReady();
    else if (message.type === 'done') report = message;
    else if (message.type === 'boot-failure') settle(new Error('child boot failure: ' + message.message), null);
  });
  child.on('error', error => settle(error, null));
  child.on('close', code => {
    if (report === undefined) settle(new Error(`child exited with code ${String(code)} without reporting a publication result`), null);
    else settle(null, { ...report, index: input.index });
  });
  return { child, completion };
}

test('two real processes publishing to one fresh root: exactly one exclusive claim, a byte-exact winner bundle, and a refusal over the occupied output', async t => {
  const f = await makePublicationFixture(t);
  const inputsBefore = snapshotInputs(f.fixture);
  const parent = f.report;

  // Two DIFFERENT valid safe pairs, each obtained through the accepted C5 authority: the pending
  // parent projection and a pure prepareReviewedReport child projection. No hand-written payload.
  const parentProjection = createExportProjection(parent);
  const pairParent = { json: renderReportJSON(parentProjection), text: renderReportText(parentProjection) };
  const childReport = prepareReviewedReport({ parent, worksheet: physicalWorksheet(parent, f.reviewRoot, true), reportId: 'report-synthetic-concurrent-child', createdAt: '2026-01-04T00:00:00.000Z' });
  const childProjection = createExportProjection(childReport);
  const pairChild = { json: renderReportJSON(childProjection), text: renderReportText(childProjection) };
  assert.notEqual(pairParent.json, pairChild.json, 'the two safe pairs must come from different reports');

  // Test-owned scratch outside the protected roots, with the shared fresh root left uncreated.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-c6s8t5-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const inputRoot = path.join(scratch, 'concurrent export inputs');
  fs.mkdirSync(inputRoot);
  const inputs = [[pairParent, 'pair parent.json'], [pairChild, 'pair reviewed child.json']].map(([pair, name], index) => {
    const file = path.join(inputRoot, name);
    fs.writeFileSync(file, JSON.stringify(pair));
    return { index, file, pair, bytes: fs.readFileSync(file) };
  });
  const output = path.join(scratch, 'shared concurrent export root');
  const protectedRoots = [f.runRoot, f.storeRoot];
  const moduleUrl = new URL('../../cli/export-publication.mjs', import.meta.url).href;

  // Readiness barrier: both children report ready only after reading their fixed input file.
  const ready = [false, false];
  let release;
  const bothReady = new Promise(resolve => { release = () => { if (ready.every(Boolean)) resolve(); }; });
  const started = inputs.map(input => startChild({
    script: childScript(input.file, output, protectedRoots, moduleUrl), input,
    onReady: () => { ready[input.index] = true; release(); },
  }));
  assert.equal(fs.existsSync(output), false, 'the shared root is fresh before the race');

  let results;
  let boundTimer;
  try {
    const bound = new Promise((_, reject) => {
      boundTimer = setTimeout(() => {
        for (const s of started) { try { s.child.kill(); } catch {} }
        reject(new Error('the two-process race exceeded its 20 second bound'));
      }, CHILD_BOUND_MS);
    });
    const releaseBoth = bothReady.then(() => { for (const s of started) s.child.send({ type: 'go' }); });
    const raced = Promise.all([releaseBoth, Promise.all(started.map(s => s.completion))]).then(pair => pair[1]);
    results = await Promise.race([raced, bound]);
  } finally {
    clearTimeout(boundTimer);
    for (const s of started) if (s.child.exitCode === null && !s.child.killed) { try { s.child.kill(); } catch {} }
  }

  // Exactly ONE success; the loser reports a controlled race refusal (state precheck or the
  // exclusive-mkdir EEXIST), never both-fail and never one inferred specific race error.
  const winners = results.filter(r => r.outcome === 'success');
  assert.equal(winners.length, 1, 'exactly one of the two real processes may claim the fresh root; results: ' + JSON.stringify(results));
  const winner = winners[0], loser = results.find(r => r !== winner);
  assert.equal(winner.complete, true);
  assert.equal(loser.outcome, 'failure', 'the other process must report a controlled failure');
  assert.ok(loser.category === 'state' || loser.code === 'EEXIST',
    'the loser must report either the state precheck refusal or the exclusive-mkdir EEXIST race, got ' + JSON.stringify(loser));
  if (loser.fate !== null) assert.equal(loser.fate.cleanup, 'unclaimed', 'a loser without a root claim must clean nothing of the winner');

  // The output is exactly the closed bundle and both content files match the SAME winning pair.
  const winnerPair = inputs.find(i => i.index === winner.index).pair;
  const loserPair = inputs.find(i => i.index === loser.index).pair;
  assert.deepEqual(fs.readdirSync(output).sort(), bundleFiles().sort());
  assert.equal(fs.readFileSync(path.join(output, EXPORT_NAMES[0]), 'utf8'), winnerPair.json, 'report.json must match the winning pair exactly');
  assert.equal(fs.readFileSync(path.join(output, EXPORT_NAMES[1]), 'utf8'), winnerPair.text, 'report.txt must match the winning pair exactly');
  const marker = JSON.parse(fs.readFileSync(path.join(output, EXPORT_MARKER), 'utf8'));
  assert.deepEqual(Object.keys(marker).sort(), ['files', 'kind', 'schemaVersion']);
  assert.equal(marker.kind, 'benchboard.cli.safe-export.v1');
  assert.equal(marker.schemaVersion, '1.0.0');
  assert.deepEqual(marker.files, EXPORT_NAMES.map(name => {
    const bytes = fs.readFileSync(path.join(output, name));
    return { path: name, bytes: bytes.length, sha256: sha(bytes) };
  }), 'the closed marker binds the exact winner byte counts and SHA256 digests');
  for (const secret of [parent.reportId, childReport.reportId, f.runRoot, f.storeRoot, f.evaluationRoot, 'synthetic-human-reviewer']) {
    for (const name of bundleFiles()) assert.equal(fs.readFileSync(path.join(output, name), 'utf8').includes(secret), false, name + ' must not carry ' + secret);
  }

  // A third publication with the other pair into the existing output is refused with bytes unchanged.
  const inventory = () => Object.fromEntries(bundleFiles().map(name => [name, sha(fs.readFileSync(path.join(output, name)))]));
  const beforeInventory = inventory();
  assert.throws(() => publishSafeExport({ output, json: loserPair.json, text: loserPair.text, protectedRoots }),
    error => error.category === 'state', 'an occupied fresh destination is refused by the state precheck');
  assert.deepEqual(inventory(), beforeInventory, 'the refused third publication changed no output byte');

  // The fixed input pair files and the original workspace and snapshot are byte-unchanged.
  for (const input of inputs) assert.deepEqual(fs.readFileSync(input.file), input.bytes, 'the fixed safe-pair input bytes must not change');
  assertInputsUnchanged(f.fixture, inputsBefore);
});
