// C6.S6.T7 capture-before-await acceptance: reserveEvaluationAttempt and finishEvaluationAttempt
// must bind the caller's original primitive facts before their first await, so a synchronous
// post-call mutation of the caller's own selection/disposition object cannot rebind what is stored.
//
// All evidence here is synthetic controlled C4 artifact-protocol evidence built by the
// Captain-owned publication fixture: a real C3 authority with controlled synthetic evaluation
// stages and ordinary synthetic artifact bytes. Nothing in this file is a browser run, a real
// human evaluation or a participant benchmark run; the labeled report is synthetic artifact-protocol
// evidence, not actual evaluator execution or human judgment. Publication goes through the actual
// C5 save path. Tests run against the production composition with no runtime injection; each
// scenario gets its own fresh fixture. The capture property is asserted by observing stored and
// returned bytes after a caller mutation; no runtime hooks were added (see the result packet).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makePublicationFixture } from '../results/publication-fixture.mjs';
import { snapshotInputs, assertInputsUnchanged } from '../evaluation/helpers.mjs';
import { openSelectedRun, ensureResultsContext } from '../../cli/run-context.mjs';
import { reserveEvaluationAttempt, finishEvaluationAttempt, readEvaluationAttempts } from '../../cli/attempt-records.mjs';
import { recordEvaluationExecution } from '../../cli/execution-records.mjs';
import { saveReport } from '../../packages/results/publication.mjs';
import { publicationKeysOf } from '../../packages/results/publication-runtime.mjs';

// One fresh publication fixture plus its bound CLI view, exactly as the accepted T3 harness.
async function ready(t) {
  const p = await makePublicationFixture(t);
  const inputsBefore = snapshotInputs(p.fixture);
  const opened = await openSelectedRun(p.runRoot);
  const context = await ensureResultsContext(opened);
  const selection = { snapshotId: p.input.selection.snapshotId, frozenSubmissionId: p.input.selection.frozenSubmissionId };
  return { p, opened, context, selection, inputsBefore };
}

// File-local helpers (copied patterns from the accepted execution-records harness; the shared
// fixtures are Captain-owned files this task does not edit).
const attemptDir = (r, attemptId) => path.join(r.context.resultsRoot, 'cli-attempts', attemptId);
const startFile = (r, attemptId) => path.join(attemptDir(r, attemptId), 'start.json');
const executionFile = (r, attemptId) => path.join(attemptDir(r, attemptId), 'execution.json');
const terminalFile = (r, attemptId) => path.join(attemptDir(r, attemptId), 'terminal.json');
const reportFile = (r, reportId) => path.join(r.context.storeRoot, publicationKeysOf(reportId).report.relativePath);
const commitFile = (r, reportId) => path.join(r.context.storeRoot, publicationKeysOf(reportId).commit.relativePath);
const isIntegrity = error => error?.category === 'integrity';
const SUCCESS_DISPOSITION = report => ({ status: 'SUCCEEDED', evaluationId: report.evidence.evaluationId, reportId: report.reportId });
const SUCCESS_INTENT = report => ({ evaluationId: report.evidence.evaluationId, reportId: report.reportId, evaluatorExecution: 'SUCCESS' });
const byteSnapshot = files => files.map(file => fs.readFileSync(file));
const byteSnapshotsEqual = (before, files) => before.forEach((bytes, index) => assert.deepEqual(fs.readFileSync(files[index]), bytes));
// File-local reader of the stored envelope's value (read-through bytes, not a runtime hook).
const readOrdinary = file => JSON.parse(fs.readFileSync(file, 'utf8')).value;

// Check 1 — reserve binds the ORIGINAL verified selection despite a synchronous mutation of the
// caller's own object while the callee's first await is pending, and a wrong selection still refuses.
test('reserve binds the original snapshot and submission when the caller mutates its selection before the await, and a wrong selection still refuses', async t => {
  const r = await ready(t);
  const originalSnapshot = r.selection.snapshotId, originalSubmission = r.selection.frozenSubmissionId;
  const pending = reserveEvaluationAttempt(r.opened, r.context, r.selection);
  // The callee ran synchronously through capture to its first await before returning the promise.
  // Mutate now, while that await is pending and before this caller awaits the promise.
  r.selection.snapshotId = 'snapshot-mutated-canary-000000000';
  r.selection.frozenSubmissionId = 'frozen-mutated-canary-000000000';
  const start = await pending;
  // The mutation did land in the caller's object (it is not frozen and does not echo the record).
  assert.equal(r.selection.snapshotId, 'snapshot-mutated-canary-000000000');
  assert.equal(r.selection.frozenSubmissionId, 'frozen-mutated-canary-000000000');
  // The returned record and the stored bytes bind the ORIGINAL verified identity, not the canary.
  assert.equal(start.snapshotId, originalSnapshot);
  assert.equal(start.frozenSubmissionId, originalSubmission);
  assert.notEqual(start.snapshotId, r.selection.snapshotId, 'the stored value does not follow the caller object');
  assert.ok(Object.isFrozen(start));
  const stored = readOrdinary(startFile(r, start.attemptId));
  assert.equal(stored.snapshotId, originalSnapshot);
  assert.equal(stored.frozenSubmissionId, originalSubmission);
  const attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.deepEqual(attempts.find(a => a.start.attemptId === start.attemptId).start, start);
  // A wrong selection still refuses: both the foreign original identity and a canary in place of
  // the original refuse with no caller-echo in the fixed error text.
  await assert.rejects(reserveEvaluationAttempt(r.opened, r.context, { snapshotId: 'snapshot-foreign-selection-000000', frozenSubmissionId: originalSubmission }), isIntegrity);
  await assert.rejects(reserveEvaluationAttempt(r.opened, r.context, { snapshotId: 'snapshot-mutated-canary-000000000', frozenSubmissionId: originalSubmission }),
    error => isIntegrity(error) && !error.message.includes('canary'));
  // The saved snapshot and live workspace bytes are unchanged throughout.
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

// Check 2 — finish binds the ORIGINAL terminal facts despite a synchronous post-call mutation of
// the caller's own disposition, with the actual C5 baseline committed under the reserved output.
test('finish binds the original status, evaluation and report facts when the caller mutates its disposition before the await', async t => {
  const r = await ready(t);
  const start = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  fs.cpSync(r.p.evaluationRoot, start.outputRoot, { recursive: true });
  // Record the execution intent with the actual C5 baseline under the reserved output root.
  const execution = await recordEvaluationExecution(r.opened, r.context, start.attemptId, SUCCESS_INTENT(r.p.report));
  await saveReport({ storeRoot: r.context.storeRoot, runRoot: r.p.runRoot, evaluationRoot: start.outputRoot, report: r.p.report });
  const watched = [startFile(r, start.attemptId), executionFile(r, start.attemptId), reportFile(r, r.p.report.reportId), commitFile(r, r.p.report.reportId)];
  watched.push(...r.p.report.artifacts.map(a => path.join(start.outputRoot, a.path)));
  const bytesBefore = byteSnapshot(watched);
  const disposition = SUCCESS_DISPOSITION(r.p.report);
  const pending = finishEvaluationAttempt(r.opened, r.context, start.attemptId, disposition);
  // Mutate the caller's own disposition synchronously, before the await: the intended terminal facts
  // are the ORIGINAL status/evaluationId/reportId, and these mutations must not rebind them.
  disposition.status = 'CANCELLED';
  disposition.evaluationId = 'eval-mutated-canary-0000000000';
  disposition.reportId = 'report-mutated-canary-0000000000';
  const terminal = await pending;
  // The returned terminal and the readback bind the ORIGINAL facts and the SUCCEEDED status.
  assert.equal(terminal.status, 'SUCCEEDED');
  assert.equal(terminal.evaluationId, r.p.report.evidence.evaluationId);
  assert.equal(terminal.reportId, r.p.report.reportId);
  assert.equal(terminal.reportDigest, r.p.report.reportDigest);
  assert.ok(Object.isFrozen(terminal));
  const attempts = await readEvaluationAttempts(r.opened, r.context);
  const entry = attempts.find(a => a.start.attemptId === start.attemptId);
  assert.deepEqual(entry.terminal, terminal);
  assert.deepEqual(entry.execution, execution, 'the committed terminal left the intent bytes identical');
  // The actual on-disk terminal carries the original IDs and digest, not a caller-echo of the canary.
  const terminalBytes = fs.readFileSync(terminalFile(r, start.attemptId)).toString('utf8');
  assert.match(terminalBytes, new RegExp(r.p.report.reportId));
  assert.match(terminalBytes, new RegExp(r.p.report.evidence.evaluationId));
  assert.match(terminalBytes, new RegExp(r.p.report.reportDigest));
  assert.equal(terminalBytes.includes('mutated-canary'), false, 'the canary never reaches the stored terminal');
  // Stored report, intent, terminal-keyed inputs, output artifacts, snapshot and workspace bytes
  // are unchanged by the finish.
  byteSnapshotsEqual(bytesBefore, watched);
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

// Check 2 (separate no-report case) — an INFRASTRUCTURE terminal captures its null report fields
// before the await; a later publication does not promote the stored terminal.
test('a no-report INFRASTRUCTURE finish captures its null report fields before the await and a later publication does not promote them', async t => {
  const r = await ready(t);
  const start = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  const disposition = { status: 'INFRASTRUCTURE', evaluationId: 'eval-known-infrastructure-0000', reportId: null };
  const pending = finishEvaluationAttempt(r.opened, r.context, start.attemptId, disposition);
  // Mutate the caller's own disposition before the await: the captured reportId was null.
  disposition.status = 'SUCCEEDED';
  disposition.evaluationId = 'eval-mutated-canary-0000000000';
  disposition.reportId = r.p.report.reportId;
  const terminal = await pending;
  assert.equal(terminal.status, 'INFRASTRUCTURE');
  assert.equal(terminal.evaluationId, 'eval-known-infrastructure-0000');
  assert.equal(terminal.reportId, null, 'the captured null report field is not the later caller value');
  assert.equal(terminal.reportDigest, null);
  // Publication under this attempt afterwards is an unrelated committed report; the stored terminal
  // keeps its captured nulls: no promotion.
  fs.cpSync(r.p.evaluationRoot, start.outputRoot, { recursive: true });
  await saveReport({ storeRoot: r.context.storeRoot, runRoot: r.p.runRoot, evaluationRoot: start.outputRoot, report: r.p.report });
  const attempts = await readEvaluationAttempts(r.opened, r.context);
  const entry = attempts.find(a => a.start.attemptId === start.attemptId);
  assert.equal(entry.terminal.reportId, null);
  assert.equal(entry.terminal.reportDigest, null);
  assert.equal(entry.terminal.status, 'INFRASTRUCTURE');
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

// Check 3 — the strict exact-key surface and no-input-side-effects behavior remain: extra keys,
// missing keys and a non-object refuse before any write, the returned records are frozen, and a
// refused call leaves no attempt residue.
test('the exact-key surface refuses extra and missing disposition keys before any write and the returned records are frozen', async t => {
  const r = await ready(t);
  // Extra keys and missing keys on the disposition refuse through the exact-key check, with the
  // fixed CLI_INTEGRITY code carrying no caller-echo of the canary value.
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, 'attempt-none-exists-000000',
    { status: 'INFRASTRUCTURE', evaluationId: null, reportId: null, score: 0 }),
  error => isIntegrity(error) && error.message === 'CLI_INTEGRITY' && !error.message.includes('score'));
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, 'attempt-none-exists-000000',
    { status: 'INFRASTRUCTURE', evaluationId: null }), isIntegrity);
  // Extra and missing keys on the selection refuse the same way.
  await assert.rejects(reserveEvaluationAttempt(r.opened, r.context,
    { snapshotId: r.selection.snapshotId, frozenSubmissionId: r.selection.frozenSubmissionId, evaluationId: 'eval-extra-canary-0000000000' }),
  error => isIntegrity(error) && !error.message.includes('canary'));
  await assert.rejects(reserveEvaluationAttempt(r.opened, r.context, { snapshotId: r.selection.snapshotId }), isIntegrity);
  // A refused call wrote nothing: no attempt directory for a nonexistent id.
  assert.equal(fs.existsSync(path.join(r.context.resultsRoot, 'cli-attempts')), false, 'the refusals created no attempt directory at all');
  // The accepted flow still works and both returned records are frozen; mutating a returned record
  // throws rather than silently diverging from the stored bytes.
  const start = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  assert.ok(Object.isFrozen(start));
  assert.throws(() => { start.snapshotId = 'mutated-returned-value'; }, TypeError);
  const startBytesBefore = fs.readFileSync(startFile(r, start.attemptId));
  const terminal = await finishEvaluationAttempt(r.opened, r.context, start.attemptId, { status: 'INFRASTRUCTURE', evaluationId: null, reportId: null });
  assert.ok(Object.isFrozen(terminal));
  assert.throws(() => { terminal.status = 'SUCCEEDED'; }, TypeError);
  assert.match(fs.readFileSync(startFile(r, start.attemptId)).toString('utf8'), /"snapshotId":/);
  // The finish left the stored start bytes byte-identical to what the reserve wrote.
  byteSnapshotsEqual([startBytesBefore], [startFile(r, start.attemptId)]);
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});
