// C6.S2.T4 independent bound attempt/reference acceptance.
// All evidence here is synthetic protocol evidence built by the Captain-owned publication fixture:
// a real C3 authority with controlled synthetic evaluation stages and ordinary synthetic artifact
// bytes. Nothing in this file is a real production evaluation, a real human UI judgment or a
// participant benchmark run. Tests run against the production CLI composition with no runtime
// injection. Each test scenario gets its own fresh fixture, and in the altered-artifact scenario
// the altered bytes are never restored. The three no-write refusals inside the fabricated-reference
// scenario intentionally share one healthy fixture: none of them writes, so sharing cannot let a
// refusal mask another case's state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makePublicationFixture } from '../results/publication-fixture.mjs';
import { snapshotInputs, assertInputsUnchanged } from '../evaluation/helpers.mjs';
import { openSelectedRun, ensureResultsContext } from '../../cli/run-context.mjs';
import { createStorage } from '../../packages/core/storage.mjs';
import { reserveEvaluationAttempt, finishEvaluationAttempt, readEvaluationAttempts } from '../../cli/attempt-records.mjs';
import { saveReport, readPublishedReport } from '../../packages/results/publication.mjs';
import { publicationKeysOf } from '../../packages/results/publication-runtime.mjs';

// One fresh publication fixture plus its bound CLI view. `selection` is the same verified frozen
// selection the fixture's synthetic report is bound to.
async function ready(t) {
  const p = await makePublicationFixture(t);
  const inputsBefore = snapshotInputs(p.fixture);
  const opened = await openSelectedRun(p.runRoot);
  const context = await ensureResultsContext(opened);
  const selection = { snapshotId: p.input.selection.snapshotId, frozenSubmissionId: p.input.selection.frozenSubmissionId };
  return { p, opened, context, selection, inputsBefore };
}

// Reserve an attempt for the selection and copy the fixture's synthetic evaluation bytes into the
// reserved output root (a fresh test-owned destination), exactly where the attempt contract expects
// the physical artifacts. Returns the start record and the copied destination.
async function reserveWithArtifacts(r, selection = r.selection) {
  const start = await reserveEvaluationAttempt(r.opened, r.context, selection);
  assert.equal(fs.existsSync(start.outputRoot), false, 'reservation must not implicitly create the output directory');
  fs.cpSync(r.p.evaluationRoot, start.outputRoot, { recursive: true });
  return start;
}

// Publish the fixture's synthetic report under the attempt's output root through the production
// save path, using the bound context's store root.
async function publishUnderAttempt(r, start) {
  return saveReport({ storeRoot: r.context.storeRoot, runRoot: r.p.runRoot, evaluationRoot: start.outputRoot, report: r.p.report });
}

const terminalFile = (r, attemptId) => path.join(r.context.resultsRoot, 'cli-attempts', attemptId, 'terminal.json');
const reportFile = (r, reportId) => path.join(r.context.storeRoot, publicationKeysOf(reportId).report.relativePath);
const isIntegrity = error => error?.category === 'integrity';
const byCode = code => error => error?.code === code;
const SUCCEEDED_DISPOSITION = report => ({ status: 'SUCCEEDED', evaluationId: report.evidence.evaluationId, reportId: report.reportId });
const NO_REPORT_DISPOSITION = status => ({ status, evaluationId: null, reportId: null });

test('reservation against a verified frozen selection is metadata-only, distinct and reads as incomplete', async t => {
  const r = await ready(t);
  // Before any reservation the enumeration is empty.
  assert.deepEqual(await readEvaluationAttempts(r.opened, r.context), []);
  const first = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  const second = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  // Distinct attempt identities and distinct output paths, neither directory implicitly created.
  assert.notEqual(first.attemptId, second.attemptId);
  assert.notEqual(first.outputRoot, second.outputRoot);
  for (const start of [first, second]) {
    assert.equal(fs.existsSync(start.outputRoot), false);
    assert.ok(Object.isFrozen(start));
    // Complete start binding to the bound context and the verified frozen selection.
    assert.equal(start.kind, 'benchboard.cli.attempt.v1');
    assert.equal(start.contextId, r.context.contextId);
    assert.equal(start.runId, r.opened.runId);
    assert.equal(start.manifestId, r.opened.manifestId);
    assert.equal(start.manifestDigest, r.opened.manifestDigest);
    assert.equal(start.snapshotId, r.selection.snapshotId);
    assert.equal(start.frozenSubmissionId, r.selection.frozenSubmissionId);
    assert.equal(start.outputRoot, path.join(r.context.attemptsRoot, start.attemptId));
    // A start carries no score or success field.
    for (const absent of ['status', 'score', 'quality', 'reportId', 'evaluationId', 'reportDigest']) {
      assert.equal(absent in start, false);
    }
  }
  // Both readable with terminal null: no terminal means incomplete, not success.
  const attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(a => a.start.attemptId).sort(), [first.attemptId, second.attemptId].sort());
  for (const attempt of attempts) assert.equal(attempt.terminal, null);
  // Reservation wrote only companion metadata: no workspace or frozen snapshot byte changed.
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

test('a committed C5 baseline with matching physical artifacts finishes SUCCEEDED, rereads and refuses a duplicate terminal while preserving prior bytes', async t => {
  const r = await ready(t);
  const start = await reserveWithArtifacts(r);
  const published = await publishUnderAttempt(r, start);
  assert.equal(published.reportDigest, r.p.report.reportDigest);
  const terminal = await finishEvaluationAttempt(r.opened, r.context, start.attemptId, SUCCEEDED_DISPOSITION(r.p.report));
  // The terminal names the exact committed reference.
  assert.equal(terminal.kind, 'benchboard.cli.attempt-terminal.v1');
  assert.equal(terminal.status, 'SUCCEEDED');
  assert.equal(terminal.attemptId, start.attemptId);
  assert.equal(terminal.reportId, r.p.report.reportId);
  assert.equal(terminal.reportDigest, r.p.report.reportDigest);
  assert.equal(terminal.evaluationId, r.p.report.evidence.evaluationId);
  // The store holds the report the terminal references, byte-identical to the fixture report.
  assert.deepEqual(await readPublishedReport({ storeRoot: r.context.storeRoot, reportId: terminal.reportId }), r.p.report);
  // Later reads revalidate the same record/digest reference.
  const attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].start, start);
  assert.deepEqual(attempts[0].terminal, terminal);
  // Capture the stored report and terminal bytes before attempting a duplicate terminal.
  const reportBytesBefore = fs.readFileSync(reportFile(r, terminal.reportId));
  const terminalBytesBefore = fs.readFileSync(terminalFile(r, start.attemptId));
  // A duplicate terminal publication refuses — same reference and a different one alike —
  // while preserving the prior bytes and the prior terminal.
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, start.attemptId, SUCCEEDED_DISPOSITION(r.p.report)), byCode('ERR_STORAGE_DUPLICATE_IDENTITY'));
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, start.attemptId, NO_REPORT_DISPOSITION('REFUSED')), byCode('ERR_STORAGE_DUPLICATE_IDENTITY'));
  assert.deepEqual(fs.readFileSync(reportFile(r, terminal.reportId)), reportBytesBefore);
  assert.deepEqual(fs.readFileSync(terminalFile(r, start.attemptId)), terminalBytesBefore);
  assert.deepEqual((await readEvaluationAttempts(r.opened, r.context))[0].terminal, terminal);
  // Saved snapshot and run workspace inventories are unchanged across the whole flow.
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

test('fabricated, wrong-identity and malformed references never advertise success', async t => {
  const r = await ready(t);
  const start = await reserveWithArtifacts(r);
  await publishUnderAttempt(r, start);
  // A fabricated report ID has no committed C5 baseline; the reference check refuses.
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, start.attemptId,
    { status: 'SUCCEEDED', evaluationId: r.p.report.evidence.evaluationId, reportId: 'report-fabricated-000000' }), byCode('PUBLICATION_INCOMPLETE'));
  // A committed report with the wrong evaluation ID refuses on the identity binding.
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, start.attemptId,
    { status: 'SUCCEEDED', evaluationId: 'eval-synthetic-wrong-000000', reportId: r.p.report.reportId }), isIntegrity);
  // Unknown disposition properties are refused before any write.
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, start.attemptId,
    { status: 'REFUSED', evaluationId: null, reportId: null, extra: 'unknown' }), isIntegrity);
  // None of these produced a terminal; the attempt is still incomplete.
  let attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].terminal, null);
  // An explicit no-report terminal with null identity is allowed and stays explicit:
  // null identity and null digest, never a zeroed or invented value.
  const refused = await finishEvaluationAttempt(r.opened, r.context, start.attemptId, NO_REPORT_DISPOSITION('REFUSED'));
  assert.equal(refused.status, 'REFUSED');
  assert.equal(refused.reportId, null);
  assert.equal(refused.reportDigest, null);
  assert.equal(refused.evaluationId, null);
  // The record keeps explicit nulls; no identity or digest field is zeroed into a fake value.
  assert.match(JSON.stringify(refused), /"evaluationId":null/);
  assert.equal(JSON.stringify(refused).includes(':0'), false);
  attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.deepEqual(attempts[0].terminal, refused);
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

test('an INFRASTRUCTURE terminal with no report and null identity stays explicit and never implies quality', async t => {
  // A fresh fixture whose attempt never authored any evaluation output and published no report:
  // the infrastructure no-report/null-identity disposition is allowed and stays explicit.
  const r = await ready(t);
  const start = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  const terminal = await finishEvaluationAttempt(r.opened, r.context, start.attemptId, NO_REPORT_DISPOSITION('INFRASTRUCTURE'));
  assert.equal(terminal.kind, 'benchboard.cli.attempt-terminal.v1');
  assert.equal(terminal.status, 'INFRASTRUCTURE');
  // All three identity/digest fields are explicit nulls, never zeroed into a fake value.
  assert.equal(terminal.reportId, null);
  assert.equal(terminal.reportDigest, null);
  assert.equal(terminal.evaluationId, null);
  assert.match(JSON.stringify(terminal), /"reportId":null/);
  assert.match(JSON.stringify(terminal), /"reportDigest":null/);
  assert.match(JSON.stringify(terminal), /"evaluationId":null/);
  assert.equal(JSON.stringify(terminal).includes(':0'), false);
  // The closed terminal record carries no quality or score field, so no quality value appears.
  for (const absent of ['quality', 'score']) assert.equal(absent in terminal, false);
  // With no authored output, the reserved output directory is still absent; terminal-only
  // finalization must not implicitly create evaluation output.
  assert.equal(fs.existsSync(start.outputRoot), false);
  // The terminal re-reads identically through the enumerating read.
  const attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].start, start);
  assert.deepEqual(attempts[0].terminal, terminal);
  // Workspace and saved-snapshot inventories are unchanged.
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

test('a second run refuses a wrong context, a foreign frozen selection and a committed baseline from another run', async t => {
  const a = await ready(t);
  const aStart = await reserveWithArtifacts(a);
  await publishUnderAttempt(a, aStart);
  await finishEvaluationAttempt(a.opened, a.context, aStart.attemptId, SUCCEEDED_DISPOSITION(a.p.report));
  const b = await ready(t);
  // The foreign run's verified context is refused by the bound-context recheck.
  await assert.rejects(readEvaluationAttempts(b.opened, a.context), isIntegrity);
  // A frozen selection from the other run is refused at reservation.
  await assert.rejects(reserveEvaluationAttempt(b.opened, b.context, a.selection), isIntegrity);
  // The other run's committed baseline may exist in this store yet never binds this run's attempt:
  // publish A's synthetic report bytes into B's store under B's disjoint roots, then the reference
  // binding check refuses the finish because the report belongs to run A.
  const bStart = await reserveWithArtifacts(b);
  const foreignArtifacts = path.join(b.p.fixture.root, 'foreign-artifacts');
  fs.cpSync(a.p.evaluationRoot, foreignArtifacts, { recursive: true });
  await saveReport({ storeRoot: b.context.storeRoot, runRoot: a.p.runRoot, evaluationRoot: foreignArtifacts, report: a.p.report });
  await assert.rejects(finishEvaluationAttempt(b.opened, b.context, bStart.attemptId, SUCCEEDED_DISPOSITION(a.p.report)), isIntegrity);
  const attempts = await readEvaluationAttempts(b.opened, b.context);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].terminal, null, 'a foreign committed baseline must never advertise success for this run');
  assertInputsUnchanged(a.p.fixture, a.inputsBefore);
  assertInputsUnchanged(b.p.fixture, b.inputsBefore);
});

// C6.S2.T6 cross-attempt identity uniqueness. All evidence in the three tests below is synthetic
// protocol evidence produced by the same Captain-owned publication fixture: a real C3 authority
// with controlled synthetic evaluation stages and ordinary synthetic artifact bytes. The copied
// artifacts are byte copies of the fixture's synthetic evaluation output, not actual evaluations.
// These tests are the Captain-decided fixed contract for independent review F1.

// Snapshot the exact bytes of the files the uniqueness regressions must prove are not rewritten.
const byteSnapshot = files => files.map(file => fs.readFileSync(file));
const byteSnapshotsEqual = (before, files) => before.forEach((bytes, i) => assert.deepEqual(fs.readFileSync(files[i]), bytes));

test('a committed report and evaluation identity may bind to only one attempt terminal across dispositions', async t => {
  const r = await ready(t);
  const first = await reserveWithArtifacts(r);
  const second = await reserveWithArtifacts(r);
  const published = await publishUnderAttempt(r, first);
  assert.equal(published.reportDigest, r.p.report.reportDigest);
  // The first attempt commits the synthetic report normally. Capture its terminal and stored
  // report bytes before any refusing finish runs, so a later comparison proves nothing rewrote them.
  const winner = await finishEvaluationAttempt(r.opened, r.context, first.attemptId, SUCCEEDED_DISPOSITION(r.p.report));
  const winnerBytes = byteSnapshot([terminalFile(r, first.attemptId), reportFile(r, winner.reportId)]);
  // The second attempt copied the identical synthetic artifact bytes; its finish carries the
  // same report/evaluation identity that the first terminal already holds, which the fixed
  // contract says rejects as integrity. The synthetic copies are copies of the fixture's
  // evaluation output, not actual evaluations.
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, second.attemptId, SUCCEEDED_DISPOSITION(r.p.report)), isIntegrity);
  // A no-report disposition that reuses only the evaluationId cannot bypass report uniqueness:
  // the reportId is null yet the evaluation identity is already assigned to the first terminal,
  // and the packet's fixed contract states cross-attempt reuse rejects as integrity.
  const third = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, third.attemptId, { status: 'REFUSED', evaluationId: r.p.report.evidence.evaluationId, reportId: null }), isIntegrity);
  // Enumeration retains exactly the first terminal; the refused attempts stayed incomplete.
  const attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.equal(attempts.length, 3);
  const byId = new Map(attempts.map(a => [a.start.attemptId, a.terminal]));
  assert.deepEqual(byId.get(first.attemptId), winner);
  assert.equal(byId.get(second.attemptId), null);
  assert.equal(byId.get(third.attemptId), null);
  // The winner's terminal and stored report bytes were not touched by the refused finishes.
  byteSnapshotsEqual(winnerBytes, [terminalFile(r, first.attemptId), reportFile(r, winner.reportId)]);
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

test('concurrent finishes of two attempts against one committed report elect exactly one winner and the loser retried rejects as integrity', async t => {
  const r = await ready(t);
  const first = await reserveWithArtifacts(r);
  const second = await reserveWithArtifacts(r);
  await publishUnderAttempt(r, first);
  const reportPath = reportFile(r, r.p.report.reportId);
  const reportBefore = fs.readFileSync(reportPath);
  // Both attempts carry the copied synthetic artifacts and present the same committed identity.
  // The concurrent loser may be refused with a C1 storage lock error while the lock is held; the
  // contract asserts the rejection, not one guessed concurrent error code, and does not require
  // blocking or an automatic retry.
  const results = await Promise.allSettled([
    finishEvaluationAttempt(r.opened, r.context, first.attemptId, SUCCEEDED_DISPOSITION(r.p.report)),
    finishEvaluationAttempt(r.opened, r.context, second.attemptId, SUCCEEDED_DISPOSITION(r.p.report)),
  ]);
  const settled = results.map(result => result.status);
  assert.deepEqual([...settled].sort(), ['fulfilled', 'rejected']);
  const winnerId = results[0].status === 'fulfilled' ? first.attemptId : second.attemptId;
  const loserId = winnerId === first.attemptId ? second.attemptId : first.attemptId;
  // After settlement exactly one terminal exists; the other attempt is still null.
  const attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.equal(attempts.length, 2);
  const terminals = attempts.filter(a => a.terminal !== null);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].start.attemptId, winnerId);
  assert.equal(attempts.find(a => a.start.attemptId === loserId).terminal, null);
  // Retrying the loser after settlement, with the same identity now serially, rejects as integrity.
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, loserId, SUCCEEDED_DISPOSITION(r.p.report)), isIntegrity);
  // The committed report bytes and both protected input domains are unchanged throughout.
  assert.deepEqual(fs.readFileSync(reportPath), reportBefore);
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

test('a preexisting duplicate non-null identity in stored terminals makes readEvaluationAttempts refuse with integrity and preserves the files it read', async t => {
  const r = await ready(t);
  const first = await reserveWithArtifacts(r);
  const second = await reserveWithArtifacts(r);
  await publishUnderAttempt(r, first);
  const terminal = await finishEvaluationAttempt(r.opened, r.context, first.attemptId, SUCCEEDED_DISPOSITION(r.p.report));
  // Synthetic corrupt-state setup, not a production mutation hook: seed a deliberately inconsistent
  // second terminal through the public C1 storage API, cloning the first terminal's non-null
  // report/evaluation identity under the second attempt id. This simulates a results directory a
  // pre-fix writer could have produced, so the read path must itself refuse the duplicate.
  await createStorage({ root: r.context.resultsRoot }).createImmutable({
    relativePath: `cli-attempts/${second.attemptId}/terminal.json`,
    kind: 'benchboard.cli.attempt-terminal.v1',
    id: second.attemptId,
    value: { ...terminal, attemptId: second.attemptId },
  });
  // Snapshot the two terminal files and the committed report before the refusing read.
  const watched = [terminalFile(r, first.attemptId), terminalFile(r, second.attemptId), reportFile(r, terminal.reportId)];
  const before = byteSnapshot(watched);
  await assert.rejects(readEvaluationAttempts(r.opened, r.context), isIntegrity);
  // The refusing read preserved every file it touched.
  byteSnapshotsEqual(before, watched);
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

test('an altered copied artifact refuses registration, the terminal stays null and stored bytes are preserved', async t => {
  const r = await ready(t);
  const start = await reserveWithArtifacts(r);
  await publishUnderAttempt(r, start);
  const reportBytesBefore = fs.readFileSync(reportFile(r, r.p.report.reportId));
  // Alter one copied attempt artifact before finishing against an otherwise valid committed baseline.
  const altered = path.join(start.outputRoot, r.p.report.artifacts[0].path);
  fs.appendFileSync(altered, ' post-publication synthetic alteration');
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, start.attemptId, SUCCEEDED_DISPOSITION(r.p.report)), byCode('PUBLICATION_ARTIFACT'));
  // Registration refused: no terminal was written and the attempt remains incomplete. Later reads
  // reverify the record/digest bindings, and there is no success terminal to advertise.
  const attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].terminal, null);
  // Nothing was restored or bypassed, and the production store and protected evidence are untouched.
  assert.deepEqual(fs.readFileSync(reportFile(r, r.p.report.reportId)), reportBytesBefore);
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});
