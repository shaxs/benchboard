// C6.S6.T3 independent actual execution/publication binding acceptance.
// All evidence here is synthetic controlled C4 artifact-protocol evidence built by the
// Captain-owned publication fixture: a real C3 authority with controlled synthetic evaluation
// stages and ordinary synthetic artifact bytes. Nothing in this file is a browser run, a real
// human evaluation or a participant benchmark run. Publication goes through the actual C5 save
// path; no copied safe export and no manual JSON envelope substitutes for publication.
// The cooperative execution records proved here are bookkeeping, not signed authentication and
// not proof a real C4 executed. Tests run against the production composition with no runtime
// injection. Each scenario gets its own fresh fixture; deliberately corrupted seeds are retained,
// never repaired or deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makePublicationFixture } from '../results/publication-fixture.mjs';
import { snapshotInputs, assertInputsUnchanged } from '../evaluation/helpers.mjs';
import { openSelectedRun, ensureResultsContext } from '../../cli/run-context.mjs';
import { createStorage } from '../../packages/core/storage.mjs';
import { reserveEvaluationAttempt, finishEvaluationAttempt, readEvaluationAttempts } from '../../cli/attempt-records.mjs';
import { recordEvaluationExecution } from '../../cli/execution-records.mjs';
import { EXECUTION_KIND } from '../../cli/execution-contract.mjs';
import { resolveCliReport } from '../../cli/report-selection.mjs';
import { CommandError } from '../../cli/command-error.mjs';
import { saveReport, readPublishedReport } from '../../packages/results/publication.mjs';
import { publicationKeysOf } from '../../packages/results/publication-runtime.mjs';

// One fresh publication fixture plus its bound CLI view, exactly as the accepted C6.S2 harness.
async function ready(t) {
  const p = await makePublicationFixture(t);
  const inputsBefore = snapshotInputs(p.fixture);
  const opened = await openSelectedRun(p.runRoot);
  const context = await ensureResultsContext(opened);
  const selection = { snapshotId: p.input.selection.snapshotId, frozenSubmissionId: p.input.selection.frozenSubmissionId };
  return { p, opened, context, selection, inputsBefore };
}

// Reserve an attempt and copy the fixture's synthetic evaluation bytes into the reserved output
// root exactly where the attempt contract expects the physical artifacts.
async function reserveWithArtifacts(r, selection = r.selection) {
  const start = await reserveEvaluationAttempt(r.opened, r.context, selection);
  fs.cpSync(r.p.evaluationRoot, start.outputRoot, { recursive: true });
  return start;
}

// Publish the fixture's synthetic baseline through the actual C5 save path under the attempt root.
async function publishUnderAttempt(r, start) {
  return saveReport({ storeRoot: r.context.storeRoot, runRoot: r.p.runRoot, evaluationRoot: start.outputRoot, report: r.p.report });
}

const attemptDir = (r, attemptId) => path.join(r.context.resultsRoot, 'cli-attempts', attemptId);
const executionFile = (r, attemptId) => path.join(attemptDir(r, attemptId), 'execution.json');
const terminalFile = (r, attemptId) => path.join(attemptDir(r, attemptId), 'terminal.json');
const reportFile = (r, reportId) => path.join(r.context.storeRoot, publicationKeysOf(reportId).report.relativePath);
const commitFile = (r, reportId) => path.join(r.context.storeRoot, publicationKeysOf(reportId).commit.relativePath);
const isIntegrity = error => error?.category === 'integrity';
const isState = error => error instanceof CommandError && error.category === 'state';
const byCode = code => error => error?.code === code;
const SUCCESS_DISPOSITION = report => ({ status: 'SUCCEEDED', evaluationId: report.evidence.evaluationId, reportId: report.reportId });
const SUCCESS_INTENT = report => ({ evaluationId: report.evidence.evaluationId, reportId: report.reportId, evaluatorExecution: 'SUCCESS' });
// Snapshot the exact bytes a refusing path must leave untouched.
const byteSnapshot = files => files.map(file => fs.readFileSync(file));
const byteSnapshotsEqual = (before, files) => before.forEach((bytes, index) => assert.deepEqual(fs.readFileSync(files[index]), bytes));
// The execution record is the full start binding plus the closed execution identity fields.
const expectedExecution = (start, facts) => ({ ...start, kind: EXECUTION_KIND, ...facts });

// Group 1 — the decided baseline flow. The intent is recorded before the actual C5 publication, so
// the record proves an INCOMPLETE intent, not a success; publication and finish then bind exactly.
test('an execution intent recorded before the actual C5 publication reads as INCOMPLETE, then publishes and finishes to the exact bound reference', async t => {
  const r = await ready(t);
  const start = await reserveWithArtifacts(r);
  const facts = SUCCESS_INTENT(r.p.report);
  // Record the intent BEFORE saveReport: an evaluation id is known, a report id is declared, and
  // no premature reportDigest exists anywhere in the intent.
  const execution = await recordEvaluationExecution(r.opened, r.context, start.attemptId, facts);
  assert.ok(Object.isFrozen(execution));
  assert.deepEqual(execution, expectedExecution(start, facts));
  for (const absent of ['reportDigest', 'status', 'score', 'quality']) assert.equal(absent in execution, false, `the intent carries no premature ${absent}`);
  // The declared report is not committed yet: no report bytes, no commit marker, no publication.
  assert.equal(fs.existsSync(reportFile(r, facts.reportId)), false);
  assert.equal(fs.existsSync(commitFile(r, facts.reportId)), false);
  await assert.rejects(readPublishedReport({ storeRoot: r.context.storeRoot, reportId: facts.reportId }), byCode('PUBLICATION_INCOMPLETE'));
  // The attempt is INCOMPLETE: no terminal, the exact execution reference present.
  let attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].terminal, null, 'an intent is not a terminal');
  assert.deepEqual(attempts[0].execution, execution);
  // Publish the actual C5 baseline through the real save path, then finish matching SUCCEEDED.
  const published = await publishUnderAttempt(r, start);
  assert.equal(published.reportDigest, r.p.report.reportDigest);
  const executionBytesBefore = fs.readFileSync(executionFile(r, start.attemptId));
  const outputBytesBefore = r.p.report.artifacts.map(a => fs.readFileSync(path.join(start.outputRoot, a.path)));
  const terminal = await finishEvaluationAttempt(r.opened, r.context, start.attemptId, SUCCESS_DISPOSITION(r.p.report));
  // Reread validates the exact run/snapshot/evaluation/report/digest/status binding.
  assert.equal(terminal.status, 'SUCCEEDED');
  assert.equal(terminal.attemptId, start.attemptId);
  assert.equal(terminal.contextId, r.context.contextId);
  assert.equal(terminal.runId, r.opened.runId);
  assert.equal(terminal.manifestId, r.opened.manifestId);
  assert.equal(terminal.manifestDigest, r.opened.manifestDigest);
  assert.equal(terminal.evaluationId, r.p.report.evidence.evaluationId);
  assert.equal(terminal.reportId, r.p.report.reportId);
  assert.equal(terminal.reportDigest, r.p.report.reportDigest);
  attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.deepEqual(attempts[0].start, start);
  assert.deepEqual(attempts[0].execution, execution, 'the committed terminal left the intent bytes identical');
  assert.deepEqual(attempts[0].terminal, terminal);
  // The intent file and the evaluation output bytes were not changed by publication or finish.
  assert.deepEqual(fs.readFileSync(executionFile(r, start.attemptId)), executionBytesBefore);
  outputBytesBefore.forEach((bytes, index) => assert.deepEqual(fs.readFileSync(path.join(start.outputRoot, r.p.report.artifacts[index].path)), bytes));
  // Saved snapshot and run workspace inventories are unchanged across the whole flow.
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

// Group 2a — actual mismatches refuse without a terminal and without changing the existing intent.
test('a wrong-identity intent, a wrong publication reference and a status-changing finish are refused against the recorded intent, leaving no terminal', async t => {
  const r = await ready(t);
  const start = await reserveWithArtifacts(r);
  const facts = SUCCESS_INTENT(r.p.report);
  const execution = await recordEvaluationExecution(r.opened, r.context, start.attemptId, facts);
  const executionBytesBefore = fs.readFileSync(executionFile(r, start.attemptId));
  // A wrong evaluation id over an otherwise-committed report refuses on the identity binding.
  await publishUnderAttempt(r, start);
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, start.attemptId,
    { status: 'SUCCEEDED', evaluationId: 'eval-synthetic-wrong-000000', reportId: r.p.report.reportId }), isIntegrity);
  // A committed report id that does not exist is not a publication: the reference check refuses
  // before any terminal.
  await assert.rejects(readPublishedReport({ storeRoot: r.context.storeRoot, reportId: 'report-fabricated-000000' }), byCode('PUBLICATION_INCOMPLETE'));
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, start.attemptId,
    { status: 'SUCCEEDED', evaluationId: r.p.report.evidence.evaluationId, reportId: 'report-fabricated-000000' }), byCode('PUBLICATION_INCOMPLETE'));
  // A status-changing finish over the recorded intent refuses: the intent declared a successful
  // evaluator execution and a non-null report, so an infrastructure terminal cannot rebind it.
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, start.attemptId,
    { status: 'INFRASTRUCTURE', evaluationId: r.p.report.evidence.evaluationId, reportId: r.p.report.reportId }), isIntegrity);
  // No refused attempt produced a terminal; the stored intent bytes are unchanged.
  const attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].terminal, null);
  assert.deepEqual(attempts[0].execution, execution);
  assert.deepEqual(fs.readFileSync(executionFile(r, start.attemptId)), executionBytesBefore);
  assert.equal(fs.existsSync(terminalFile(r, start.attemptId)), false);
  // The matching finish still succeeds afterwards, proving the refusals changed no state.
  const terminal = await finishEvaluationAttempt(r.opened, r.context, start.attemptId, SUCCESS_DISPOSITION(r.p.report));
  assert.equal(terminal.status, 'SUCCEEDED');
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

// Group 2b — the recording surface itself: arbitrary fields, input echo, wrong context, mutable
// caller rebind and a duplicate intent all refuse without writing or overwriting.
test('arbitrary fields, an input echo, a foreign context and a caller rebind are refused without a write, and a duplicate intent retains the original bytes', async t => {
  const r = await ready(t);
  const start = await reserveWithArtifacts(r);
  // A wrong context (foreign manifest identity) refuses before any lock or write.
  await assert.rejects(recordEvaluationExecution(r.opened, r.context, start.attemptId,
    { evaluationId: 'eval-synthetic-canary-aaaa', reportId: null, evaluatorExecution: 'INFRASTRUCTURE_ERROR', extra: 'unknown' }), isIntegrity);
  // A foreign context record refuses via the bound-context recheck.
  const foreign = { ...r.context, manifestId: 'manifest-not-this-run-000000' };
  await assert.rejects(readEvaluationAttempts(r.opened, foreign), isIntegrity);
  await assert.rejects(recordEvaluationExecution(r.opened, foreign, start.attemptId, SUCCESS_INTENT(r.p.report)), isIntegrity);
  // Path-shaped and malformed identities refuse; nothing echoes into the fixed error text.
  const canary = 'eval-canary-../escape-value';
  await assert.rejects(recordEvaluationExecution(r.opened, r.context, start.attemptId,
    { evaluationId: canary, reportId: null, evaluatorExecution: 'INFRASTRUCTURE_ERROR' }),
  error => isIntegrity(error) && !error.message.includes('canary') && !error.message.includes('escape'));
  await assert.rejects(recordEvaluationExecution(r.opened, r.context, start.attemptId,
    { evaluationId: 'ev', reportId: null, evaluatorExecution: 'INFRASTRUCTURE_ERROR' }), isIntegrity);
  await assert.rejects(recordEvaluationExecution(r.opened, r.context, start.attemptId,
    { evaluationId: 'eval-ok-ok-0000000000', reportId: null, evaluatorExecution: 'WEIRD' }), isIntegrity);
  await assert.rejects(recordEvaluationExecution(r.opened, r.context, start.attemptId,
    { evaluationId: 'eval-ok-ok-0000000000', reportId: null, evaluatorExecution: 'SUCCESS' }), isIntegrity);
  // The refusals wrote nothing anywhere: no execution file, no escaping path, no echo in the error.
  assert.equal(fs.existsSync(executionFile(r, start.attemptId)), false);
  assert.equal(fs.existsSync(path.join(r.context.resultsRoot, 'escape-value')), false);
  // A successful record: the returned record is frozen and the input facts object is not the record.
  const facts = SUCCESS_INTENT(r.p.report);
  const execution = await recordEvaluationExecution(r.opened, r.context, start.attemptId, facts);
  assert.ok(Object.isFrozen(execution));
  assert.throws(() => { execution.evaluationId = 'mutated-value'; }, TypeError);
  assert.equal(execution.evaluationId, r.p.report.evidence.evaluationId);
  const executionBytesBefore = fs.readFileSync(executionFile(r, start.attemptId));
  // A mutable caller rebinds its own facts object afterwards: the stored bytes cannot follow it.
  facts.evaluationId = 'eval-after-rebind-000000';
  facts.reportId = 'report-after-rebind-000000';
  // A duplicate intent on the same attempt refuses through the storage identity and retains the
  // original bytes: no overwrite in either direction.
  await assert.rejects(recordEvaluationExecution(r.opened, r.context, start.attemptId, facts), byCode('ERR_STORAGE_DUPLICATE_IDENTITY'));
  await assert.rejects(recordEvaluationExecution(r.opened, r.context, start.attemptId, SUCCESS_INTENT(r.p.report)), byCode('ERR_STORAGE_DUPLICATE_IDENTITY'));
  byteSnapshotsEqual([executionBytesBefore], [executionFile(r, start.attemptId)]);
  const attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.deepEqual(attempts[0].execution, execution);
  assert.equal(attempts[0].terminal, null);
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

// Group 2c — legacy compatibility and the explicit production baseline lookup entrypoint.
test('a legacy attempt without an execution stays readable and finishable, but the explicit production baseline lookup requires an execution', async t => {
  const r = await ready(t);
  // Legacy no-report finish: no execution was ever recorded, so it stays readable and finishable.
  const legacy = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  const refused = await finishEvaluationAttempt(r.opened, r.context, legacy.attemptId, { status: 'INFRASTRUCTURE', evaluationId: null, reportId: null });
  assert.equal(refused.status, 'INFRASTRUCTURE');
  let attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.equal(attempts.find(a => a.start.attemptId === legacy.attemptId).terminal.status, 'INFRASTRUCTURE');
  assert.equal('execution' in attempts.find(a => a.start.attemptId === legacy.attemptId), false, 'no execution was ever recorded for the legacy attempt');
  // A legacy SUCCEEDED finish through the real publication path also works without an execution.
  const legacyWin = await reserveWithArtifacts(r);
  await publishUnderAttempt(r, legacyWin);
  const won = await finishEvaluationAttempt(r.opened, r.context, legacyWin.attemptId, SUCCESS_DISPOSITION(r.p.report));
  assert.equal(won.status, 'SUCCEEDED');
  attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.equal(attempts.length, 2);
  // The explicit production baseline lookup requires the execution binding: a committed terminal
  // with no execution never resolves, rather than being adopted implicitly.
  await assert.rejects(resolveCliReport(r.opened, { evaluationId: r.p.report.evidence.evaluationId, reportId: undefined, baselineOnly: true }), isState);
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

// Group 3a — cross-attempt uniqueness claims include unfinished intents.
test('an intent without any terminal blocks the same evaluation or report identity from every other attempt', async t => {
  const r = await ready(t);
  // Two fresh selected attempts; the first claims the fixture identities with no terminal at all.
  const first = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  const second = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  const third = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  const claimed = await recordEvaluationExecution(r.opened, r.context, first.attemptId, SUCCESS_INTENT(r.p.report));
  const claimedBytes = byteSnapshot([executionFile(r, first.attemptId)]);
  // The second attempt cannot claim the same non-null evaluation identity under a different report.
  await assert.rejects(recordEvaluationExecution(r.opened, r.context, second.attemptId,
    { evaluationId: r.p.report.evidence.evaluationId, reportId: 'report-different-but-valid', evaluatorExecution: 'SUCCESS' }), isIntegrity);
  // The third attempt cannot claim the same report identity under a different evaluation.
  await assert.rejects(recordEvaluationExecution(r.opened, r.context, third.attemptId,
    { evaluationId: 'eval-different-but-valid', reportId: r.p.report.reportId, evaluatorExecution: 'SUCCESS' }), isIntegrity);
  // The refused claims wrote nothing and did not touch the first intent's bytes.
  assert.equal(fs.existsSync(executionFile(r, second.attemptId)), false);
  assert.equal(fs.existsSync(executionFile(r, third.attemptId)), false);
  byteSnapshotsEqual(claimedBytes, [executionFile(r, first.attemptId)]);
  const attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.equal(attempts.length, 3);
  const byId = new Map(attempts.map(a => [a.start.attemptId, a]));
  assert.deepEqual(byId.get(first.attemptId).execution, claimed);
  assert.equal(byId.get(second.attemptId).terminal, null);
  assert.equal('execution' in byId.get(second.attemptId), false);
  assert.equal('execution' in byId.get(third.attemptId), false);
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

// Group 3b — concurrent claims under one results-root lock. The contract asserts identity
// ownership and that no second intent committed; it does not assert byte-identical lock or
// registry state during valid concurrent writes, and does not guess one concurrent error code.
test('two concurrent claims of one identity under the results-root lock admit exactly one committed intent and no second one', async t => {
  const r = await ready(t);
  const first = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  const second = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  const facts = SUCCESS_INTENT(r.p.report);
  const results = await Promise.allSettled([
    recordEvaluationExecution(r.opened, r.context, first.attemptId, facts),
    recordEvaluationExecution(r.opened, r.context, second.attemptId, facts),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const winnerId = results[0].status === 'fulfilled' ? first.attemptId : second.attemptId;
  const loserId = winnerId === first.attemptId ? second.attemptId : first.attemptId;
  // Exactly one intent committed; the identity is owned by exactly one attempt.
  let attempts = await readEvaluationAttempts(r.opened, r.context);
  const owned = attempts.filter(a => a.execution !== undefined);
  assert.equal(owned.length, 1);
  assert.equal(owned[0].start.attemptId, winnerId);
  assert.equal(owned[0].execution.evaluationId, facts.evaluationId);
  assert.equal(owned[0].execution.reportId, facts.reportId);
  assert.equal(fs.existsSync(executionFile(r, loserId)), false, 'no second intent committed for the loser');
  // Retrying the loser with the same identity now refuses; a distinct identity is admissible.
  await assert.rejects(recordEvaluationExecution(r.opened, r.context, loserId, facts), isIntegrity);
  await recordEvaluationExecution(r.opened, r.context, loserId,
    { evaluationId: 'eval-distinct-identity-00001', reportId: 'report-distinct-identity-0001', evaluatorExecution: 'SUCCESS' });
  // A fresh read sees both committed intents: no stale-index loss of the concurrent winner.
  attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.equal(attempts.filter(a => a.execution !== undefined).length, 2);
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

// Group 3c — distinct identities both claim and finish without interfering.
test('two attempts with distinct intent identities each finish to their own terminal and status', async t => {
  const r = await ready(t);
  const first = await reserveWithArtifacts(r);
  const second = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  // The first declares the fixture baseline publication; the second declares a no-report outcome.
  const firstExecution = await recordEvaluationExecution(r.opened, r.context, first.attemptId, SUCCESS_INTENT(r.p.report));
  const secondExecution = await recordEvaluationExecution(r.opened, r.context, second.attemptId,
    { evaluationId: 'eval-second-distinct-000000', reportId: null, evaluatorExecution: 'INFRASTRUCTURE_ERROR' });
  assert.notEqual(firstExecution.evaluationId, secondExecution.evaluationId);
  // Only the first publishes and finishes SUCCEEDED; the second finishes its own terminal.
  await publishUnderAttempt(r, first);
  const firstTerminal = await finishEvaluationAttempt(r.opened, r.context, first.attemptId, SUCCESS_DISPOSITION(r.p.report));
  const secondTerminal = await finishEvaluationAttempt(r.opened, r.context, second.attemptId,
    { status: 'INFRASTRUCTURE', evaluationId: 'eval-second-distinct-000000', reportId: null });
  assert.equal(firstTerminal.status, 'SUCCEEDED');
  assert.equal(secondTerminal.status, 'INFRASTRUCTURE');
  const attempts = await readEvaluationAttempts(r.opened, r.context);
  const byId = new Map(attempts.map(a => [a.start.attemptId, a]));
  assert.deepEqual(byId.get(first.attemptId).terminal, firstTerminal);
  assert.deepEqual(byId.get(first.attemptId).execution, firstExecution);
  assert.deepEqual(byId.get(second.attemptId).terminal, secondTerminal);
  assert.deepEqual(byId.get(second.attemptId).execution, secondExecution);
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

// Group 4a — the no-report infrastructure and cancellation paths preserve the known evaluation id
// and explicit nulls, never a zeroed value.
test('a known evaluation id with a null report keeps its identity across an INFRASTRUCTURE or CANCELLED terminal and never zeroes the unknowns', async t => {
  const r = await ready(t);
  const infra = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  const cancelled = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  const infraFacts = { evaluationId: 'eval-known-infrastructure-0000', reportId: null, evaluatorExecution: 'INFRASTRUCTURE_ERROR' };
  const cancelledFacts = { evaluationId: 'eval-known-cancellation-00000', reportId: null, evaluatorExecution: 'INFRASTRUCTURE_ERROR' };
  const infraExecution = await recordEvaluationExecution(r.opened, r.context, infra.attemptId, infraFacts);
  const cancelledExecution = await recordEvaluationExecution(r.opened, r.context, cancelled.attemptId, cancelledFacts);
  assert.equal(infraExecution.reportId, null, 'an explicit null report id is the no-report declaration');
  const infraTerminal = await finishEvaluationAttempt(r.opened, r.context, infra.attemptId,
    { status: 'INFRASTRUCTURE', evaluationId: infraFacts.evaluationId, reportId: null });
  const cancelledTerminal = await finishEvaluationAttempt(r.opened, r.context, cancelled.attemptId,
    { status: 'CANCELLED', evaluationId: cancelledFacts.evaluationId, reportId: null });
  // Reread preserves the known evaluation id and the null report/digest pair for both terminals.
  const attempts = await readEvaluationAttempts(r.opened, r.context);
  const byId = new Map(attempts.map(a => [a.start.attemptId, a]));
  for (const [attemptId, terminal, execution, facts] of [[infra.attemptId, infraTerminal, infraExecution, infraFacts], [cancelled.attemptId, cancelledTerminal, cancelledExecution, cancelledFacts]]) {
    const entry = byId.get(attemptId);
    assert.equal(entry.terminal.evaluationId, facts.evaluationId);
    assert.equal(entry.terminal.reportId, null);
    assert.equal(entry.terminal.reportDigest, null);
    assert.deepEqual(entry.execution, execution);
    assert.match(JSON.stringify(entry.terminal), /"evaluationId":"/);
    assert.match(JSON.stringify(entry.terminal), /"reportId":null/);
    assert.match(JSON.stringify(entry.terminal), /"reportDigest":null/);
    // An unknown stays null, never zero: no identity/digest field carries a zero value.
    for (const field of ['evaluationId', 'reportId', 'reportDigest']) assert.notEqual(entry.terminal[field], 0);
    for (const absent of ['quality', 'score']) assert.equal(absent in entry.terminal, false);
  }
  // Reserved-but-unfinished identities stay observable separately and infer no committed baseline:
  // the explicit production lookup finds no reportable attempt for either known evaluation id.
  await assert.rejects(resolveCliReport(r.opened, { evaluationId: infraFacts.evaluationId, reportId: undefined, baselineOnly: true }), isState);
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

// Group 4b — a simulated publication failure after the intent leaves the store: the attempt stays
// INCOMPLETE, no terminal is fabricated, and no committed baseline is inferred.
test('a publication failure after the intent leaves the attempt INCOMPLETE with the reserved identity observable but no committed baseline inferred', async t => {
  const r = await ready(t);
  const start = await reserveWithArtifacts(r);
  const facts = SUCCESS_INTENT(r.p.report);
  const execution = await recordEvaluationExecution(r.opened, r.context, start.attemptId, facts);
  // Simulate the interrupted publication by altering a copied artifact before the actual save, so
  // the real C5 verifier refuses the save itself. Nothing is restored afterwards.
  const altered = path.join(start.outputRoot, r.p.report.artifacts[0].path);
  fs.appendFileSync(altered, ' post-intent synthetic interruption');
  await assert.rejects(publishUnderAttempt(r, start), byCode('PUBLICATION_ARTIFACT'));
  // The intent survives exactly as recorded; no terminal was fabricated and no baseline was written.
  const attempts = await readEvaluationAttempts(r.opened, r.context);
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].execution, execution);
  assert.equal(attempts[0].terminal, null, 'a failed publication never fabricates a terminal');
  assert.equal(fs.existsSync(terminalFile(r, start.attemptId)), false);
  assert.equal(fs.existsSync(reportFile(r, facts.reportId)), false);
  // The reserved identity is observable through the intent but resolves no committed baseline.
  await assert.rejects(resolveCliReport(r.opened, { evaluationId: facts.evaluationId, reportId: undefined, baselineOnly: true }), isState);
  // The finishing path against the never-committed report refuses without writing a terminal.
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, start.attemptId, SUCCESS_DISPOSITION(r.p.report)), byCode('PUBLICATION_INCOMPLETE'));
  assert.equal(fs.existsSync(terminalFile(r, start.attemptId)), false);
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

// Group 4c/4d — malformed and substituted optional intents refuse on enumeration and on any
// recording that reads through enumeration. Fixtures are seeded through the accepted C1 storage
// API with the exact existing corruption pattern (the accepted duplicate-terminal pattern); the
// foreign canary bytes are retained and never repaired or deleted.
test('a malformed execution intent refuses enumeration and every recording, retaining the foreign canary bytes unmodified', async t => {
  const r = await ready(t);
  const foreign = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  const other = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  // Synthetic corrupt-state seed through the accepted C1 storage API, not a production mutation
  // hook: a stored execution otherwise well-formed against the execution contract whose
  // evaluatorExecution is outside the closed enum, with the canary visible in the file bytes. This
  // follows the accepted duplicate-terminal corruption pattern: the seed is schema-visible content,
  // not a weakened schema.
  await createStorage({ root: r.context.resultsRoot }).createImmutable({
    relativePath: `cli-attempts/${foreign.attemptId}/execution.json`,
    kind: EXECUTION_KIND,
    id: `${foreign.attemptId}:execution`,
    value: { ...foreign, kind: EXECUTION_KIND, evaluationId: 'eval-foreign-canary-0000000', reportId: null, evaluatorExecution: 'CANARY-NOT-AN-ENUM' },
  });
  const watched = [executionFile(r, foreign.attemptId)];
  const before = byteSnapshot(watched);
  assert.match(fs.readFileSync(executionFile(r, foreign.attemptId)).toString('utf8'), /CANARY-NOT-AN-ENUM/);
  // Enumeration refuses the malformed optional intent.
  await assert.rejects(readEvaluationAttempts(r.opened, r.context), isIntegrity);
  // Any recording that enumerates first also refuses, before touching the other attempt.
  await assert.rejects(recordEvaluationExecution(r.opened, r.context, other.attemptId, SUCCESS_INTENT(r.p.report)), isIntegrity);
  await assert.rejects(finishEvaluationAttempt(r.opened, r.context, other.attemptId,
    { status: 'INFRASTRUCTURE', evaluationId: null, reportId: null }), isIntegrity);
  // The foreign bytes are retained: never repaired, never deleted, never rewritten.
  byteSnapshotsEqual(before, watched);
  assert.ok(fs.existsSync(executionFile(r, foreign.attemptId)));
  assert.equal(fs.existsSync(executionFile(r, other.attemptId)), false);
  assert.equal(fs.existsSync(terminalFile(r, other.attemptId)), false);
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});

test('a schema-valid but substituted execution intent (foreign bindings) refuses enumeration and every recording, retaining its bytes', async t => {
  const r = await ready(t);
  const foreign = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  const other = await reserveEvaluationAttempt(r.opened, r.context, r.selection);
  const facts = SUCCESS_INTENT(r.p.report);
  const valid = await recordEvaluationExecution(r.opened, r.context, other.attemptId, facts);
  assert.ok(Object.isFrozen(valid));
  // Substitute a schema-valid execution under the foreign attempt whose bound snapshot and output
  // do not match its own start record: a well-formed record standing in the wrong place.
  await createStorage({ root: r.context.resultsRoot }).createImmutable({
    relativePath: `cli-attempts/${foreign.attemptId}/execution.json`,
    kind: EXECUTION_KIND,
    id: `${foreign.attemptId}:execution`,
    value: { ...expectedExecution(foreign, facts), snapshotId: 'snapshot-foreign-substitute-00', outputRoot: path.join(r.context.attemptsRoot, 'attempt-foreign-substitute') },
  });
  const watched = [executionFile(r, foreign.attemptId), executionFile(r, other.attemptId)];
  const before = byteSnapshot(watched);
  // Enumeration refuses the substituted optional intent through the start-binding comparison.
  await assert.rejects(readEvaluationAttempts(r.opened, r.context), isIntegrity);
  await assert.rejects(recordEvaluationExecution(r.opened, r.context, foreign.attemptId, facts), isIntegrity);
  // The substituted bytes and the valid sibling intent are both retained unmodified.
  byteSnapshotsEqual(before, watched);
  await assert.rejects(readEvaluationAttempts(r.opened, { ...r.context }), isIntegrity);
  assert.equal(valid.reportId, facts.reportId);
  assert.equal(fs.existsSync(executionFile(r, foreign.attemptId)), true, 'the substituted record is retained, not deleted or repaired');
  assertInputsUnchanged(r.p.fixture, r.inputsBefore);
});
