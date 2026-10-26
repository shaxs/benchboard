import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInstallation } from '../../cli/installation.mjs';
import { openSelectedRun, readResultsContext, ensureResultsContext } from '../../cli/run-context.mjs';
import { readOrdinaryJson } from '../../cli/filesystem.mjs';
import { validateCliRecord } from '../../cli/context-contract.mjs';
import { reserveEvaluationAttempt, readEvaluationAttempts } from '../../cli/attempt-records.mjs';
import { initialiseRun } from '../../packages/core/init.mjs';
import { freezeRun } from '../../packages/core/freeze.mjs';
import { createId, inventoryTree, sha256 } from '../../packages/core/identity.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-cli-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installation = loadInstallation();
  // C2 requires an exact source tree, not the prepared owner starter directory.
  const sourceRoot = path.join(root, 'canonical source'); fs.mkdirSync(sourceRoot);
  for (const relative of installation.challenge.fileManifest) {
    const target = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(installation.challenge.sourceRoot, relative), target);
  }
  const run = await initialiseRun({ output: path.join(root, 'run with spaces'), challenge: { ...installation.challenge, sourceRoot },
    toolingIdentity: installation.toolingIdentity, evaluatorIdentity: installation.evaluatorIdentity,
    architectureId: createId('cli-security'), harness: 'manual', dependencies: { mode: 'none' } });
  return { root, run, installation, opened: await openSelectedRun(run.output) };
}
const bytesOf = root => inventoryTree({ root, skipNames: [] }).digest;

test('run bootstrap refuses copied/substituted containers without writing through them', async t => {
  const f = await fixture(t), copy = path.join(f.root, 'copied run');
  fs.cpSync(f.run.output, copy, { recursive: true });
  const before = bytesOf(copy);
  await assert.rejects(openSelectedRun(copy));
  assert.equal(bytesOf(copy), before);
  const record = path.join(copy, '.benchboard', 'state', 'run.json');
  const envelope = JSON.parse(fs.readFileSync(record, 'utf8'));
  envelope.value.runId = 'substituted-run';
  fs.writeFileSync(record, JSON.stringify(envelope));
  const tampered = bytesOf(copy);
  await assert.rejects(openSelectedRun(copy));
  assert.equal(bytesOf(copy), tampered);
});

test('bootstrap rejects linked containers, hardlinked records, oversized and malformed JSON', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'run alias');
  fs.symlinkSync(f.run.output, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(openSelectedRun(alias));
  const ordinary = path.join(f.root, 'ordinary.json'), twin = path.join(f.root, 'hardlink.json');
  fs.writeFileSync(ordinary, '{}'); fs.linkSync(ordinary, twin);
  assert.throws(() => readOrdinaryJson(twin));
  const large = path.join(f.root, 'large.json'); fs.writeFileSync(large, ' '.repeat(2097153));
  assert.throws(() => readOrdinaryJson(large));
  const malformed = path.join(f.root, 'malformed.json'); fs.writeFileSync(malformed, '{broken');
  assert.throws(() => readOrdinaryJson(malformed));
  assert.equal(fs.readFileSync(ordinary, 'utf8'), '{}');
});

test('results refuse overlap, foreign existing destinations and location rebinding', async t => {
  const f = await fixture(t), workspaceBefore = bytesOf(f.run.workspace.root);
  for (const root of [f.installation.root, f.run.output, f.run.workspace.root]) {
    await assert.rejects(ensureResultsContext(f.opened, root));
  }
  const foreign = path.join(f.root, 'foreign'); fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'canary'), 'foreign bytes');
  const before = bytesOf(foreign);
  await assert.rejects(ensureResultsContext(f.opened, foreign));
  assert.equal(bytesOf(foreign), before);
  assert.equal(await readResultsContext(f.opened), null);
  const context = await ensureResultsContext(f.opened);
  await assert.rejects(ensureResultsContext(f.opened, path.join(f.root, 'different results')));
  assert.deepEqual(await readResultsContext(f.opened), context);
  assert.equal(bytesOf(f.run.workspace.root), workspaceBefore);
});

test('concurrent context publications cannot advertise two roots or distinct identities', async t => {
  const f = await fixture(t);
  const choices = [path.join(f.root, 'results one'), path.join(f.root, 'results two')];
  const outcomes = await Promise.allSettled(choices.map(root => ensureResultsContext(f.opened, root)));
  const successes = outcomes.filter(result => result.status === 'fulfilled').map(result => result.value);
  assert.equal(successes.length, 1);
  assert.deepEqual(await readResultsContext(f.opened), successes[0]);
  assert.equal(choices.filter(root => fs.existsSync(root)).length, 1);
});

test('incomplete foreign residue is preserved, and established companion substitution is refused', async t => {
  const f = await fixture(t), residue = `${f.run.output}.benchboard-results`;
  fs.mkdirSync(residue); fs.writeFileSync(path.join(residue, 'context.json'), '{"incomplete":true}');
  const before = bytesOf(residue);
  await assert.rejects(ensureResultsContext(f.opened));
  assert.equal(await readResultsContext(f.opened), null);
  assert.equal(bytesOf(residue), before);
  const alternate = path.join(f.root, 'fresh alternate');
  const context = await ensureResultsContext(f.opened, alternate);
  const record = path.join(context.resultsRoot, 'context.json');
  const value = JSON.parse(fs.readFileSync(record, 'utf8'));
  value.value.runId = 'another-run';
  fs.writeFileSync(record, JSON.stringify(value));
  const tampered = bytesOf(alternate);
  await assert.rejects(readResultsContext(f.opened));
  assert.equal(bytesOf(alternate), tampered);
});

test('closed CLI schemas refuse unknown majors, fabricated success without reports and free extra claims', () => {
  const terminal = { kind: 'benchboard.cli.attempt-terminal.v1', schemaVersion: '1.0.0', attemptId: 'attempt-one',
    contextId: 'context-one', runId: 'run-one', manifestId: 'manifest-one', manifestDigest: 'a'.repeat(64),
    status: 'INFRASTRUCTURE', evaluationId: null, reportId: null, reportDigest: null };
  assert.deepEqual(validateCliRecord(terminal), terminal);
  for (const changed of [{ schemaVersion: '2.0.0' }, { status: 'SUCCEEDED' }, { rawDiagnostic: 'private' },
    { reportId: 'report-fake' }, { status: 'REFUSED', reportId: 'report-fake', reportDigest: 'b'.repeat(64) }]) {
    assert.throws(() => validateCliRecord({ ...terminal, ...changed }));
  }
});

test('attempt metadata enumeration refuses a replaced linked directory without entering foreign data', async t => {
  const f = await fixture(t);
  const frozen = await freezeRun({ ...f.opened.request, clockless: true,
    attestation: { operator: 'synthetic-operator', agentStopped: true, clockless: true,
      statement: 'Synthetic test fixture is stopped; no participant agent was launched.' } });
  const context = await ensureResultsContext(f.opened);
  await reserveEvaluationAttempt(f.opened, context, { snapshotId: frozen.snapshotId,
    frozenSubmissionId: frozen.frozenSubmission.frozenSubmissionId });
  const metadata = path.join(context.resultsRoot, 'cli-attempts'), foreign = path.join(f.root, 'foreign metadata');
  fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'canary'), 'foreign bytes');
  fs.renameSync(metadata, `${metadata}-retained`);
  fs.symlinkSync(foreign, metadata, process.platform === 'win32' ? 'junction' : 'dir');
  const before = bytesOf(foreign);
  await assert.rejects(readEvaluationAttempts(f.opened, context));
  assert.equal(bytesOf(foreign), before);
});

test('installation loader has no root override, and stale descriptors fail in a separate copied installation', async t => {
  assert.throws(() => loadInstallation({ root: os.tmpdir() }));
  const installation = loadInstallation();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-cli-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalDescriptor = path.join(installation.root, 'cli', 'installation.json');
  const originalDigest = sha256(fs.readFileSync(originalDescriptor));
  const copies = ['cli', 'packages', 'schemas', 'release', 'starter', 'fixtures', 'evaluator', 'adapters/manual'];
  for (const relative of copies) {
    fs.cpSync(path.join(installation.root, relative), path.join(root, relative), { recursive: true,
      filter: source => !['node_modules', '.git', 'dist'].includes(path.basename(source)) });
  }
  for (const relative of ['package.json', 'package-lock.json', 'version.json']) fs.copyFileSync(path.join(installation.root, relative), path.join(root, relative));
  // Test-only dependency resolution shares the already prepared packages; installs nothing.
  fs.symlinkSync(path.join(installation.root, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const copiedDescriptor = path.join(root, 'cli', 'installation.json');
  const descriptor = JSON.parse(fs.readFileSync(copiedDescriptor, 'utf8'));
  descriptor.schemaVersion = '2.0.0';
  fs.writeFileSync(copiedDescriptor, JSON.stringify(descriptor));
  const copied = await import(pathToFileURL(path.join(root, 'cli', 'installation.mjs')).href);
  assert.throws(() => copied.loadInstallation(), error => error.category === 'integrity');
  assert.equal(sha256(fs.readFileSync(originalDescriptor)), originalDigest);
});
