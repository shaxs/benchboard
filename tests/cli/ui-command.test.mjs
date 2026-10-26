/**
 * Independent real UI command acceptance (task packet C6.S7.T2).
 *
 * The success routes and the Check 1 refusal grid run against a real shell-free,
 * bounded `spawnSync` of `cli/benchboard.mjs` (working directory: the
 * external fixture root, timeout 20000, maxBuffer 1048576) against fresh external
 * spaced roots, driven by the accepted baseline flow of the Captain fixture:
 * the real C3 frozen authority, the accepted C5 `saveReport` publication, and the
 * reserve + execution + terminal association exactly as `execution-records.test.mjs`
 * proves it. Every refusal grid — the template-route refusals, the completed-
 * worksheet attack matrix, the oversize input and the usage-before-state
 * ordering pair — is driven through that same real child, so the C5
 * UIWorksheetError mapping and the missing-artifact path are proven the way the
 * CLI surfaces them, not only at the API surface. The one labelled in-process
 * proof is the pre-abort handler case on the actual production `uiCommand`
 * export: an explicit handler-level proof with a pre-cancelled controller,
 * which makes no claim of actual OS signal delivery. No runtime injection, no
 * production hook, no accepted core edit, no browser, agent, installer or server
 * anywhere in this file.
 *
 * Evidence classification (fixed by the packet):
 *   - the fixture's baseline evaluation artifacts are synthetic C4-baseline-
 *     protocol bytes, distinct from the UI review protocol bytes below;
 *   - the UI worksheet JSON and its twelve screenshot-like artifact files are
 *     synthetic UI review protocol bytes: physical ARTIFACT PROTOCOL evidence,
 *     not pixels, not a visual judgment and not reviewer authentication;
 *   - the completed worksheets come from the accepted
 *     `physicalWorksheet(report, reviewRoot, positive)` fixture, which writes the
 *     twelve actual ordinary evidence files and returns a validated synthetic
 *     completed worksheet (positive=true, capped with paired improvement
 *     descriptions) or the all-zero variant (positive=false);
 *   - invalid inputs clone the valid object and change the exact field before
 *     JSON writing; no accepted expectation is changed anywhere here;
 *   - a successful publication legitimately writes the C1 store registry/lock
 *     bookkeeping, so no case here asserts that all store bytes are unchanged
 *     across a successful publication; content records are checked individually.
 *
 * Scope notes: this file qualifies no OS signal delivery, durability or sandbox
 * behavior, and claims no visual legitimacy beyond what the C5 review metadata
 * and the physical artifact rehash carry.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makePublicationFixture, physicalWorksheet } from '../results/publication-fixture.mjs';
import { snapshotInputs, assertInputsUnchanged } from '../evaluation/helpers.mjs';
import { openSelectedRun, ensureResultsContext } from '../../cli/run-context.mjs';
import { reserveEvaluationAttempt, finishEvaluationAttempt } from '../../cli/attempt-records.mjs';
import { recordEvaluationExecution } from '../../cli/execution-records.mjs';
import { saveReport, readPublishedReport, attachUIReview } from '../../packages/results/publication.mjs';
import { publicationKeysOf } from '../../packages/results/publication-runtime.mjs';
import { createUIWorksheetTemplate, readUIWorksheet } from '../../packages/results/ui-worksheet.mjs';
import { UIWorksheetError } from '../../packages/results/ui-contract.mjs';
import { reportDigestOf } from '../../packages/results/report-contract.mjs';
import { verifyReportArtifacts } from '../../packages/results/artifact-verification.mjs';
import { uiCommand } from '../../cli/ui-command.mjs';
import { diagnosticOf } from '../../cli/diagnostics.mjs';
import { CATEGORIES, CommandError } from '../../cli/command-error.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { uiCaps } from '../../evaluator/score.mjs';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const entrypoint = path.join(repositoryRoot, 'cli', 'benchboard.mjs');
/* Bounds so a hung or chatty child cannot outlive the test run. */
const SPAWN_TIMEOUT_MS = 20_000;
const MAX_BUFFER_BYTES = 1_048_576;
/** The accepted fixture worksheet reviewer string; a controlled stderr must not echo it. */
const REVIEWER_CANARY = 'synthetic-human-reviewer';
/** The fixed input-size bound the Captain reader enforces (cli/ui-context.mjs). */
const MAX_INPUT_BYTES = 2_097_152;
const trimmed = text => text.replace(/\r\n/g, '\n').trimEnd();
const clone = object => JSON.parse(JSON.stringify(object));
const exitOf = error => diagnosticOf(error).exitCode;
/** Run a call that must reject and hand back the rejection value for inspection. */
async function rejection(fn) {
  try { await fn(); }
  catch (error) { return error; }
  throw new Error('the call was expected to reject but it resolved');
}
/* --------------------------------------------------------------------------- */
/* Subprocess helpers (the actual production CLI, never a stub)                  */
/* --------------------------------------------------------------------------- */
/** Run the entrypoint as one argv array (never through a shell), spaced paths safe. */
function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    encoding: 'utf8', shell: false, cwd, timeout: SPAWN_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true,
  });
  assert.equal(result.error, undefined, `the child process completed within its bound: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
/** A successful run: exit 0, empty stderr, exactly one parseable JSON line. */
function runExpectingSuccess(args, cwd, label) {
  const result = runCli(args, cwd);
  assert.equal(result.status, 0, `${label}: a completed run exits 0; stderr ${JSON.stringify(result.stderr)}`);
  assert.equal(trimmed(result.stderr), '', `${label}: a completed run writes nothing to stderr`);
  const out = trimmed(result.stdout);
  assert.equal(out.split('\n').length, 1, `${label}: the success report is one JSON line`);
  return JSON.parse(out);
}
/** A controlled refusal: fixed status, empty stdout, one CLI_* line, no echo of the canaries. */
function runExpectingRefusal(args, cwd, code, status, label, forbidden = []) {
  const result = runCli(args, cwd);
  assert.equal(result.status, status, `${label}: exit status is ${status}; stderr ${JSON.stringify(result.stderr)}`);
  assert.equal(result.stdout, '', `${label}: a refusal writes nothing to stdout`);
  const err = trimmed(result.stderr);
  assert.equal(err.split('\n').length, 1, `${label}: one controlled line: ${JSON.stringify(err)}`);
  assert.ok(err.startsWith(`${code}: `), `${label}: stderr opens with ${code}: ${JSON.stringify(err)}`);
  assert.ok(!err.includes('\n    at ') && !err.includes('\n\tat '), `${label}: guidance, not a stack dump`);
  for (const secret of forbidden) {
    assert.ok(!err.includes(secret) && !result.stdout.includes(secret), `${label}: the diagnostic does not echo ${JSON.stringify(secret)}`);
  }
  return result;
}
/**
 * An integrity refusal child: the fixed integrity guidance verbatim on stderr, empty
 * stdout, and no echo of the reviewer canary, either spaced-root basename or any
 * raw error text / stack fragment beyond the fixed line.
 */
function runExpectingIntegrity(args, cwd, label, secrets) {
  const result = runExpectingRefusal(args, cwd, CATEGORIES.integrity.code, CATEGORIES.integrity.exitCode, label, secrets);
  assert.equal(trimmed(result.stderr), `${CATEGORIES.integrity.code}: ${CATEGORIES.integrity.guidance}`,
    `${label}: the stderr line is the fixed guidance verbatim`);
  return result;
}
/* --------------------------------------------------------------------------- */
/* Fixture helpers                                                               */
/* --------------------------------------------------------------------------- */
/**
 * One fresh publication fixture bound to the CLI exactly as
 * `execution-records.test.mjs` proves: reserve, copy the synthetic evaluation
 * bytes, record the execution intent, publish through the real C5 save path and
 * finish to the matching terminal.
 */
async function ready(t) {
  const p = await makePublicationFixture(t);
  const inputsBefore = snapshotInputs(p.fixture);
  const opened = await openSelectedRun(p.runRoot);
  const context = await ensureResultsContext(opened);
  const start = await reserveEvaluationAttempt(opened, context, {
    snapshotId: p.input.selection.snapshotId, frozenSubmissionId: p.input.selection.frozenSubmissionId,
  });
  fs.cpSync(p.evaluationRoot, start.outputRoot, { recursive: true });
  await recordEvaluationExecution(opened, context, start.attemptId, {
    evaluationId: p.report.evidence.evaluationId, reportId: p.report.reportId, evaluatorExecution: 'SUCCESS',
  });
  await saveReport({ storeRoot: context.storeRoot, runRoot: opened.runRoot, evaluationRoot: start.outputRoot, report: p.report });
  await finishEvaluationAttempt(opened, context, start.attemptId, {
    evaluationId: p.report.evidence.evaluationId, reportId: p.report.reportId, status: 'SUCCEEDED',
  });
  /* External spaced roots the CLI receives as single argv elements. */
  const spaced = name => {
    const at = path.join(p.fixture.root, name);
    fs.mkdirSync(at, { recursive: true });
    return at;
  };
  return { p, opened, context, start, report: p.report, inputsBefore, spaced };
}
const attemptFile = (r, name) => path.join(r.context.resultsRoot, 'cli-attempts', r.start.attemptId, name);
const storeFile = (r, reportId, which) => path.join(r.context.storeRoot, publicationKeysOf(reportId)[which].relativePath);
const byteSnapshot = files => files.map(file => fs.readFileSync(file));
const rawInventory = root => inventoryTree({ root, skipNames: [] });
function trackTree(root) {
  const before = rawInventory(root);
  return label => assert.deepEqual(rawInventory(root).entries, before.entries, `${label}: the raw inventory of ${JSON.stringify(root)} is byte-identical`);
}
/** Store bookkeeping (registry/lock under .storage/) versus immutable content records. */
const storeContent = root => rawInventory(root).entries.filter(entry => !entry.path.startsWith('.storage/'));
const contentMap = entries => Object.fromEntries(entries.map(entry => [entry.path, entry.sha256]));
/** Write a worksheet JSON file at a spaced fresh path and return its path. */
function worksheetFile(r, worksheet, name) {
  const dir = r.spaced('worksheet in');
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(worksheet));
  return file;
}
/* =========================================================================== */
/* Check 1 — the template route                                                  */
/* =========================================================================== */
describe('ui command — check 1: template route', () => {
  test('a fresh --template with either exact selector writes the accepted pending template and moves nothing else', async t => {
    const r = await ready(t);
    const outA = path.join(r.spaced('template out'), 'by evaluation.json');
    const outB = path.join(r.spaced('template out'), 'by report.json');
    const common = ['ui', '--template', '--run', r.opened.runRoot];
    const summaryA = runExpectingSuccess([...common, '--evaluation', r.report.evidence.evaluationId, '--output', outA], r.p.fixture.root, 'template via --evaluation');
    const summaryB = runExpectingSuccess([...common, '--report', r.report.reportId, '--output', outB], r.p.fixture.root, 'template via --report');
    /* The one-line summary is the accepted pending projection, not a child result. */
    for (const [summary, output] of [[summaryA, outA], [summaryB, outB]]) {
      assert.equal(summary.command, 'ui');
      assert.equal(summary.mode, 'template');
      assert.equal(summary.runId, r.opened.runId);
      assert.equal(summary.parentReportId, r.report.reportId);
      assert.equal(summary.parentReportDigest, r.report.reportDigest);
      assert.equal(summary.evaluationId, r.report.evidence.evaluationId);
      assert.equal(summary.snapshotId, r.report.bindings.snapshotId);
      assert.equal(summary.output, output);
      assert.equal(summary.worksheetComplete, false, 'the template is pending, never a completed review');
      assert.equal(summary.humanReview, 'NOT_REVIEWED');
      assert.equal(summary.humanUI, null, 'pending human review is null, never zero');
      assert.equal(summary.quality, null, 'the summary reports no quality');
      assert.notEqual(summary.quality, 0, 'unknown quality is null, never a zeroed quality');
      assert.equal('reportId' in summary, false, 'the template summary names no attached child');
    }
    /* Both selectors select the same baseline and agree on every field except the output. */
    const { output: dropA, ...restA } = summaryA;
    const { output: dropB, ...restB } = summaryB;
    void dropA; void dropB;
    assert.deepEqual(restB, restA, 'the --evaluation and --report selectors select the same exact baseline');
    /* Content parity with the accepted createUIWorksheetTemplate: unknown reviewer and time,
     * all seven category scores null, empty notes, no evidence, no improvements. */
    const expectedTemplate = createUIWorksheetTemplate(r.report);
    const bytesA = fs.readFileSync(outA, 'utf8');
    assert.deepEqual(JSON.parse(bytesA), expectedTemplate, 'the written file is the accepted pending template');
    assert.deepEqual(fs.readFileSync(outB, 'utf8'), bytesA, 'both selectors wrote byte-identical templates');
    assert.equal(JSON.parse(bytesA).reviewer, '');
    assert.equal(JSON.parse(bytesA).reviewedAt, '');
    assert.equal(JSON.parse(bytesA).baselineCompared, false);
    for (const key of Object.keys(uiCaps)) {
      assert.equal(JSON.parse(bytesA).scores[key], null, `category ${key} starts null, not zero`);
      assert.equal(JSON.parse(bytesA).notes[key], '');
    }
    assert.deepEqual(JSON.parse(bytesA).evidence, []);
    assert.deepEqual(JSON.parse(bytesA).improvements, {});
    /* The validator refuses the written template as incomplete (it is not a reviewed zero). */
    const templateRefusal = (() => {
      try { readUIWorksheet(bytesA, r.report); return null; }
      catch (error) { return error; }
    })();
    assert.ok(templateRefusal instanceof UIWorksheetError, 'the accepted template rejects through the UI worksheet contract');
    assert.equal(exitOf(templateRefusal), 4, 'the accepted template is refused as incomplete at the integrity category');
    /* Parent, records and outputs stand still; the template route commits no publication. */
    const trackRun = trackTree(r.opened.runRoot);
    const trackResults = trackTree(r.context.resultsRoot);
    const watched = [storeFile(r, r.report.reportId, 'report'), storeFile(r, r.report.reportId, 'commit'),
      attemptFile(r, 'execution.json'), attemptFile(r, 'terminal.json')];
    const before = byteSnapshot(watched);
    runExpectingSuccess([...common, '--evaluation', r.report.evidence.evaluationId, '--output', path.join(r.spaced('template out'), 'again probe.json')], r.p.fixture.root, 'template repeat probe');
    byteSnapshot(watched).forEach((bytes, index) => assert.deepEqual(bytes, before[index],
      'a second template run changed no committed record byte'));
    trackRun('template route');
    trackResults('template route');
    assertInputsUnchanged(r.p.fixture, r.inputsBefore);
  });
  test('wrong or unknown selectors, a child-as-parent template, a missing selector, an occupied output and every overlap refuse with the foreign bytes intact', async t => {
    const r = await ready(t);
    const common = ['ui', '--template', '--run'];
    const outName = name => path.join(r.spaced('rejects'), `${name}.json`);
    /* Foreign canaries under the run container and the results root stand through every refusal. */
    const runCanary = path.join(r.opened.runRoot, 'canary-keep-run.txt');
    const resultsCanary = path.join(r.context.resultsRoot, 'canary-keep-results.txt');
    fs.writeFileSync(runCanary, 'RUN-CANARY-BYTES\n');
    fs.writeFileSync(resultsCanary, 'RESULTS-CANARY-BYTES\n');
    /* A committed reviewed child exists so the child-as-template-parent case is real. */
    const zeroWorksheet = physicalWorksheet(r.report, r.p.reviewRoot, false);
    const child = await attachUIReview({ storeRoot: r.context.storeRoot, runRoot: r.opened.runRoot,
      evaluationRoot: r.start.outputRoot, parentReportId: r.report.reportId, reportId: 'report-synthetic-ui-child',
      createdAt: '2026-02-03T04:05:06.000Z', worksheet: zeroWorksheet, reviewRoot: r.p.reviewRoot });
    const forbidden = [REVIEWER_CANARY];
    /* Unknown or wrong run/report/evaluation: a state refusal, no latest inference, no write. */
    runExpectingRefusal([...common, path.join(r.spaced('empty run dir')), '--evaluation', r.report.evidence.evaluationId, '--output', outName('bad run')], r.p.fixture.root, 'CLI_STATE', 3, 'template on an unrelated run directory', forbidden);
    runExpectingRefusal([...common, r.opened.runRoot, '--evaluation', 'eval-synthetic-wrong-000000', '--output', outName('wrong evaluation')], r.p.fixture.root, 'CLI_STATE', 3, 'template with a wrong evaluation id', forbidden);
    runExpectingRefusal([...common, r.opened.runRoot, '--report', 'report-unknown-probe-000000', '--output', outName('unknown report')], r.p.fixture.root, 'CLI_STATE', 3, 'template with an unknown report id', forbidden);
    /* The reviewed child is not a valid template parent (baselineOnly selection refuses it). */
    runExpectingRefusal([...common, r.opened.runRoot, '--report', child.reportId, '--output', outName('child parent')], r.p.fixture.root, 'CLI_STATE', 3, 'child as the template parent', forbidden);
    /* No selector at all: a usage refusal before any run state is read. */
    runExpectingRefusal([...common, r.opened.runRoot, '--output', outName('no selector')], r.p.fixture.root, 'CLI_USAGE', 2, 'template with neither --evaluation nor --report', forbidden);
    /* An existing ordinary output file is never overwritten. */
    const occupied = outName('occupied');
    fs.writeFileSync(occupied, 'OCCUPIED-BYTES\n');
    runExpectingRefusal([...common, r.opened.runRoot, '--evaluation', r.report.evidence.evaluationId, '--output', occupied], r.p.fixture.root, 'CLI_STATE', 3, 'template onto an existing file', forbidden);
    assert.equal(fs.readFileSync(occupied, 'utf8'), 'OCCUPIED-BYTES\n', 'the existing output file is byte-identical');
    /* Overlaps with the run, the bound results root and the repository refuse at the integrity
     * category; the repository target is not created (its parent exists, so creation would run). */
    const insideRun = path.join(r.opened.runRoot, 'nested template.json');
    runExpectingRefusal([...common, r.opened.runRoot, '--evaluation', r.report.evidence.evaluationId, '--output', insideRun], r.p.fixture.root, 'CLI_INTEGRITY', 4, 'template output inside the run root', forbidden);
    assert.equal(fs.existsSync(insideRun), false);
    const insideResults = path.join(r.context.resultsRoot, 'nested template.json');
    runExpectingRefusal([...common, r.opened.runRoot, '--evaluation', r.report.evidence.evaluationId, '--output', insideResults], r.p.fixture.root, 'CLI_INTEGRITY', 4, 'template output inside the results root', forbidden);
    assert.equal(fs.existsSync(insideResults), false);
    const insideRepo = path.join(repositoryRoot, 'tests', 'cli', 'ui-command-probe-template.json');
    runExpectingRefusal([...common, r.opened.runRoot, '--evaluation', r.report.evidence.evaluationId, '--output', insideRepo], r.p.fixture.root, 'CLI_INTEGRITY', 4, 'template output inside the repository', forbidden);
    assert.equal(fs.existsSync(insideRepo), false);
    /* Linked views refuse: a junction over the run root and a junction over the output parent are
     * integrity refusals with no write anywhere (junction is the link form this host allows). */
    const linkedRun = path.join(r.p.fixture.root, 'linked run');
    fs.symlinkSync(r.opened.runRoot, linkedRun, 'junction');
    runExpectingRefusal([...common, linkedRun, '--evaluation', r.report.evidence.evaluationId, '--output', outName('linked run')], r.p.fixture.root, 'CLI_INTEGRITY', 4, 'template through a linked run root', forbidden);
    assert.equal(fs.existsSync(outName('linked run')), false);
    const linkedOut = path.join(r.p.fixture.root, 'linked out parent');
    fs.symlinkSync(path.join(r.p.fixture.root, 'rejects'), linkedOut, 'junction');
    runExpectingRefusal([...common, r.opened.runRoot, '--evaluation', r.report.evidence.evaluationId, '--output', path.join(linkedOut, 'through link.json')], r.p.fixture.root, 'CLI_INTEGRITY', 4, 'template through a linked output parent', forbidden);
    assert.equal(fs.existsSync(path.join(linkedOut, 'through link.json')), false);
    fs.unlinkSync(linkedRun); fs.unlinkSync(linkedOut);
    /* None of the refused routes produced a template file or touched the canaries or inputs. */
    for (const name of ['bad run', 'wrong evaluation', 'unknown report', 'child parent', 'no selector', 'again probe']) {
      assert.equal(fs.existsSync(outName(name)), false, `the refused route '${name}' wrote no output file`);
    }
    assert.equal(fs.readFileSync(runCanary, 'utf8'), 'RUN-CANARY-BYTES\n');
    assert.equal(fs.readFileSync(resultsCanary, 'utf8'), 'RESULTS-CANARY-BYTES\n');
    assertInputsUnchanged(r.p.fixture, r.inputsBefore);
  });
});
/* =========================================================================== */
/* Check 2 — the attach route with the accepted all-zero worksheet               */
/* =========================================================================== */
describe('ui command — check 2: attach route', () => {
  test('a completed all-zero worksheet attaches twice to two distinct committed children without replacing the first or inferring a latest', async t => {
    const r = await ready(t);
    const reviewRoot = r.spaced('review evidence');
    const worksheet = physicalWorksheet(r.report, reviewRoot, false);
    const input = worksheetFile(r, worksheet, 'all zero');
    const common = ['ui', '--run', r.opened.runRoot, '--input', input, '--review-root', reviewRoot];
    /* Bytes that a correct attachment must leave exactly as they were. */
    const watched = [storeFile(r, r.report.reportId, 'report'), storeFile(r, r.report.reportId, 'commit'),
      attemptFile(r, 'execution.json'), attemptFile(r, 'terminal.json'),
      ...r.report.artifacts.map(a => path.join(r.start.outputRoot, a.path)),
      ...worksheet.evidence.map(e => path.join(reviewRoot, e.artifactId))];
    const before = byteSnapshot(watched);
    const trackRun = trackTree(r.opened.runRoot);
    const first = runExpectingSuccess(common, r.p.fixture.root, 'attach the all-zero worksheet');
    const firstCommitted = await readPublishedReport({ storeRoot: r.context.storeRoot, reportId: first.reportId });
    /* A distinct committed child matching the exact parent report id/digest/evaluation/snapshot/bundle. */
    assert.notEqual(first.reportId, r.report.reportId, 'the child identity is distinct from the parent');
    assert.equal(firstCommitted.provenance.parentReportId, r.report.reportId);
    assert.equal(firstCommitted.provenance.parentReportDigest, r.report.reportDigest);
    assert.equal(firstCommitted.evidence.evaluationId, r.report.evidence.evaluationId);
    assert.equal(firstCommitted.evidence.bundleDigest, r.report.evidence.bundleDigest);
    assert.equal(firstCommitted.bindings.snapshotId, r.report.bindings.snapshotId);
    assert.equal(firstCommitted.bindings.treeDigest, r.report.bindings.treeDigest);
    assert.equal(firstCommitted.bindings.frozenSubmissionId, r.report.bindings.frozenSubmissionId);
    /* Automated score is the parent's; the human total is a genuine zero and the final is the sum. */
    assert.equal(first.automated, r.report.quality.automated, 'the automated score is the unchanged scorer result');
    assert.equal(first.humanUI, 0, 'a genuine all-zero review totals a real zero, distinct from the pending null');
    assert.equal(first.quality, Number((first.automated + 0).toFixed(4)), 'the final sum is automated plus zero');
    assert.equal(first.humanReview, 'SCORED');
    assert.equal(firstCommitted.quality.humanMaximum, 20);
    /* The one-line summary carries the child's own digest, and the committed report recomputes
     * it. This is additional observed protocol evidence at the CLI surface: the C5 metadata plus
     * physical rehash remain the authority, and this observation never replaces the unchanged
     * accepted C5 tests or a visual judgment; no visual legitimacy is claimed here. */
    assert.equal(first.reportDigest, firstCommitted.reportDigest);
    assert.equal(reportDigestOf(firstCommitted), firstCommitted.reportDigest, 'the committed child digest recomputes from its own bytes');
    assert.equal(firstCommitted.provenance.review.reviewer, worksheet.reviewer);
    assert.equal(firstCommitted.provenance.review.reviewedAt, worksheet.reviewedAt);
    assert.equal(Object.keys(firstCommitted.provenance.review.notes).length, 7, 'the committed review carries the seven category notes');
    assert.equal(firstCommitted.provenance.review.baselineCompared, true);
    /* An attach invocation carrying a template-route selector is a route conflict: a usage
     * refusal before any attachment work, with no third child. */
    const contentBeforeOverride = contentMap(storeContent(r.context.storeRoot));
    runExpectingRefusal([...common.slice(0, 2), '--report', r.report.reportId, ...common.slice(2)],
      r.p.fixture.root, 'CLI_USAGE', 2, 'attach with a --report selector override');
    assert.deepEqual(contentMap(storeContent(r.context.storeRoot)), contentBeforeOverride, 'the overridden invocation wrote no child');
    verifyReportArtifacts(reviewRoot, worksheet.evidence.map(e => ({ path: e.artifactId, bytes: e.bytes, sha256: e.sha256 })),
      { maxFileBytes: 16777216, maxTotalBytes: 201326592 });
    /* A repeat attachment generates another distinct child; the first stays committed and intact. */
    const firstReportBytes = fs.readFileSync(storeFile(r, first.reportId, 'report'));
    const second = runExpectingSuccess(common, r.p.fixture.root, 'attach the same worksheet again');
    assert.notEqual(second.reportId, first.reportId, 'a repeat attachment creates another distinct child');
    assert.equal(fs.readFileSync(storeFile(r, first.reportId, 'report'), 'utf8'), firstReportBytes.toString('utf8'),
      'the repeat did not replace the first child');
    const rereadFirst = await readPublishedReport({ storeRoot: r.context.storeRoot, reportId: first.reportId });
    assert.deepEqual(rereadFirst, firstCommitted, 'the first child reads back unchanged after the repeat');
    /* No latest inference: the baseline selection still names the parent, not either child. */
    const stillParent = runExpectingSuccess(['ui', '--template', '--run', r.opened.runRoot,
      '--evaluation', r.report.evidence.evaluationId, '--output', path.join(r.spaced('template out'), 'after attach.json')],
    r.p.fixture.root, 'template after attachments');
    assert.equal(stillParent.parentReportId, r.report.reportId, 'the baseline selector still resolves the parent, never a latest child');
    /* Parent, intent, terminal, evaluation bytes, review bytes, snapshot and workspace stand still. */
    byteSnapshot(watched).forEach((bytes, index) => assert.deepEqual(bytes, before[index],
      `protected byte ${index} is identical after the attachments`));
    trackRun('attach route');
    assertInputsUnchanged(r.p.fixture, r.inputsBefore);
  });
});
/* =========================================================================== */
/* Check 3 — the positive worksheet, the controlled refusal matrix and ordering  */
/* =========================================================================== */
describe('ui command — check 3: positive attachment and controlled refusals', () => {
  test('a capped positive worksheet with twelve references and paired improvements attaches with an unchanged automated score', async t => {
    const r = await ready(t);
    const reviewRoot = r.spaced('positive review');
    const worksheet = physicalWorksheet(r.report, reviewRoot, true);
    /* The accepted positive fixture: seven caps, twelve references, one paired improvement each. */
    assert.equal(worksheet.evidence.length, 12, 'the fixture worksheet references twelve physical evidence files');
    for (const [key, cap] of Object.entries(uiCaps)) {
      assert.equal(worksheet.scores[key], cap, `category ${key} sits at its actual cap ${cap}`);
      const improvement = worksheet.improvements[key];
      assert.ok(improvement !== undefined, `category ${key} carries an improvement description`);
      const starter = worksheet.evidence.find(e => e.artifactId === improvement.starterArtifactId);
      const submission = worksheet.evidence.find(e => e.artifactId === improvement.submissionArtifactId);
      assert.equal(starter.target, 'starter');
      assert.equal(submission.target, 'submission');
      assert.equal(starter.width, submission.width);
      assert.equal(starter.view, submission.view);
      assert.ok(improvement.description.trim().length >= 12, 'the improvement description is a paired comparison');
    }
    const input = worksheetFile(r, worksheet, 'capped positive');
    const summary = runExpectingSuccess(['ui', '--run', r.opened.runRoot, '--input', input, '--review-root', reviewRoot],
      r.p.fixture.root, 'attach the capped positive worksheet');
    const humanMaximum = Object.values(uiCaps).reduce((sum, cap) => sum + cap, 0);
    assert.equal(humanMaximum, 20, 'the seven UI caps sum to the twenty-point human total');
    assert.equal(summary.humanUI, humanMaximum);
    assert.equal(summary.automated, r.report.quality.automated, 'the valid positive attachment leaves the scorer automated total unchanged');
    assert.equal(summary.quality, Number((r.report.quality.automated + humanMaximum).toFixed(4)), 'the final is the automated total plus the genuine positive human sum');
    assert.notEqual(summary.reportId, r.report.reportId, 'the positive attachment produced a distinct child');
    const child = await readPublishedReport({ storeRoot: r.context.storeRoot, reportId: summary.reportId });
    assert.deepEqual(child.quality.areas, r.report.quality.areas, 'the automated category areas are untouched by the human attachment');
    assertInputsUnchanged(r.p.fixture, r.inputsBefore);
  });
  test('every completed-worksheet attack refuses through a real CLI child at the integrity category without a new child, the fixed stderr stays silent, and a mode conflict outranks missing state', async t => {
    const r = await ready(t);
    const reviewRoot = r.spaced('matrix review');
    const worksheet = physicalWorksheet(r.report, reviewRoot, true);
    const good = clone(worksheet);
    const contentBefore = contentMap(storeContent(r.context.storeRoot));
    const baselineBytes = byteSnapshot([storeFile(r, r.report.reportId, 'report'), storeFile(r, r.report.reportId, 'commit')]);
    /* What no refusal diagnostic may echo: the reviewer canary, the spaced-root
     * basenames; the verbatim fixed-guidance match rules out narrative, raw error
     * text and stack beyond the one fixed line. */
    const secrets = [REVIEWER_CANARY, path.basename(r.p.fixture.root), path.basename(reviewRoot), 'Error', 'at '];
    /* One attacked worksheet per real child: CLI_INTEGRITY exit 4, empty stdout, the
     * fixed guidance verbatim, and still no child marker after every single refusal. */
    const reject = (name, value) => {
      const file = worksheetFile(r, value, name);
      runExpectingIntegrity(['ui', '--run', r.opened.runRoot, '--input', file, '--review-root', reviewRoot],
        r.p.fixture.root, `the '${name}' worksheet refuses through a real child`, secrets);
      assert.deepEqual(contentMap(storeContent(r.context.storeRoot)), contentBefore,
        `the '${name}' refusal wrote no child marker`);
    };
    /* Clone the valid object and change the exact field before writing. */
    reject('blank', clone(createUIWorksheetTemplate(r.report)));
    const stale = clone(worksheet); stale.bindings.evaluationId = 'eval-stale-substitute-0000000';
    reject('stale binding', stale);
    const cap = clone(worksheet); cap.scores.polish = uiCaps.polish + 4;
    reject('illegal cap', cap);
    const noImprovement = clone(worksheet); delete noImprovement.improvements.feedback;
    reject('positive without improvement', noImprovement);
    const unsafe = clone(worksheet); unsafe.evidence[0].artifactId = '../evil';
    reject('unsafe artifact path', unsafe);
    /* An input beyond the accepted size bound refuses through one real child (the
     * same child also fixes the stderr shape for the whole matrix). */
    const oversize = path.join(r.spaced('oversize'), 'huge.json');
    fs.writeFileSync(oversize, ' '.repeat(MAX_INPUT_BYTES + 1));
    runExpectingIntegrity(['ui', '--run', r.opened.runRoot, '--input', oversize, '--review-root', reviewRoot],
      r.p.fixture.root, 'an oversize input refuses through a real child', secrets);
    assert.deepEqual(contentMap(storeContent(r.context.storeRoot)), contentBefore, 'the oversize refusal wrote no child marker');
    /* Physical-evidence mutations: a same-size byte change, then a missing file; both restored.
     * These exercise the C5 missing-artifact rehash path through the main CLI surface. */
    const firstPath = path.join(reviewRoot, worksheet.evidence[0].artifactId);
    const secondPath = path.join(reviewRoot, worksheet.evidence[1].artifactId);
    const originalFirst = fs.readFileSync(firstPath);
    const originalSecond = fs.readFileSync(secondPath);
    fs.writeFileSync(firstPath, Buffer.from('x'.repeat(originalFirst.length)));
    reject('changed byte', worksheet);
    fs.writeFileSync(firstPath, originalFirst);
    fs.rmSync(secondPath);
    reject('missing file', worksheet);
    fs.writeFileSync(secondPath, originalSecond);
    /* The whole matrix left the baseline records and all evidence bytes exactly as
     * they were; the review root is byte-identical after the restorations. */
    byteSnapshot([storeFile(r, r.report.reportId, 'report'), storeFile(r, r.report.reportId, 'commit')])
      .forEach((bytes, index) => assert.deepEqual(bytes, baselineBytes[index], 'the baseline records are byte-identical'));
    const restored = rawInventory(reviewRoot);
    assert.equal(restored.entries.length, 12, 'the twelve evidence files are all back in place');
    /* An aborted handler: the distinct in-process API proof on the actual production
     * export — an explicitly pre-cancelled controller, not a claim of OS signal
     * delivery — giving the cancelled category with its fixed 130 status before any
     * input or state work. */
    const controller = new AbortController();
    controller.abort();
    const input = worksheetFile(r, good, 'aborted target');
    const aborted = await rejection(() => uiCommand({ '--run': r.opened.runRoot, '--input': input, '--review-root': reviewRoot },
      { signal: controller.signal }));
    assert.ok(aborted instanceof CommandError && aborted.category === 'cancelled', 'the pre-aborted handler rejects with the cancelled category');
    assert.equal(exitOf(aborted), 130, 'the cancelled category is the fixed 130');
    assert.deepEqual(contentMap(storeContent(r.context.storeRoot)), contentBefore, 'the abort wrote no child');
    /* Route conflicts are usage before any nonexistent-run state, through real
     * children: the mode conflict exits 2 while the same missing run with a legal
     * template route exits 3, and neither writes an output file. */
    const missing = path.join(r.p.fixture.root, 'no such run container');
    runExpectingRefusal(['ui', '--run', missing, '--template', '--input', input, '--review-root', reviewRoot],
      r.p.fixture.root, CATEGORIES.usage.code, CATEGORIES.usage.exitCode, 'a template-plus-input conflict is a usage refusal', secrets);
    const usageOutput = path.join(r.spaced('rejects'), 'usage ordering.json');
    runExpectingRefusal(['ui', '--run', missing, '--template', '--output', usageOutput,
      '--evaluation', r.report.evidence.evaluationId],
    r.p.fixture.root, CATEGORIES.state.code, CATEGORIES.state.exitCode, 'the same missing run alone is a state refusal', secrets);
    assert.equal(fs.existsSync(usageOutput), false, 'the state refusal wrote no output file');
    assert.deepEqual(contentMap(storeContent(r.context.storeRoot)), contentBefore, 'the ordering pair wrote no child');
    assertInputsUnchanged(r.p.fixture, r.inputsBefore);
  });
});
/* =========================================================================== */
/* Check 4 — output privacy and store bookkeeping versus content                */
/* =========================================================================== */
describe('ui command — check 4: privacy and store bookkeeping', () => {
  test('complete outputs name child identities, status and human scores only; stdout is private; a publication updates bookkeeping but never prior content', async t => {
    const r = await ready(t);
    const reviewRoot = r.spaced('privacy review');
    const worksheet = physicalWorksheet(r.report, reviewRoot, true);
    const input = worksheetFile(r, worksheet, 'privacy attach');
    const contentBefore = storeContent(r.context.storeRoot);
    const contentBytesBefore = contentMap(contentBefore);
    /* A successful subprocess attachment; its stdout is the complete output being examined. */
    const summary = runExpectingSuccess(['ui', '--run', r.opened.runRoot, '--input', input, '--review-root', reviewRoot],
      r.p.fixture.root, 'privacy attach');
    const line = JSON.stringify(summary);
    /* Explicit identities and scores: the accepted attach projection keys and nothing else. */
    for (const field of ['reportId', 'reportDigest', 'parentReportId', 'evaluationId', 'snapshotId', 'humanReview', 'automated', 'humanUI', 'quality']) {
      assert.ok(field in summary, `the attach summary names ${field} explicitly`);
    }
    /* No raw worksheet, reviewer, path or log material appears in the output. */
    for (const forbidden of [REVIEWER_CANARY, reviewRoot, input, r.context.storeRoot, r.opened.runRoot,
      'reviewer', 'notes', 'improvements', 'evidence', 'bindings', 'artifacts', 'stack']) {
      assert.ok(!line.includes(forbidden), `the attach summary carries no ${JSON.stringify(forbidden)}`);
    }
    /* The template summary names its local output file, so CLI stdout is private local output,
     * not an export that is safe to publish as-is; the template file itself stays a private local
     * file even though it is bound to the committed parent. */
    const templateOutput = path.join(r.spaced('privacy template'), 'private.json');
    const templateSummary = runExpectingSuccess(['ui', '--template', '--run', r.opened.runRoot,
      '--evaluation', r.report.evidence.evaluationId, '--output', templateOutput], r.p.fixture.root, 'privacy template');
    assert.equal(templateSummary.output, templateOutput, 'the template summary names the private local file path');
    assert.ok(fs.existsSync(templateOutput), 'the bound template exists as a local file');
    const bound = JSON.parse(fs.readFileSync(templateOutput, 'utf8'));
    assert.equal(bound.bindings.reportId, r.report.reportId, 'the private local template is bound to the committed parent');
    /* Store bookkeeping versus content: the publication added exactly this child's pair of
     * content records; every prior content record is byte-identical; the registry bookkeeping is
     * allowed to differ and is not asserted unchanged (never assert all store bytes across a
     * successful publication). */
    const contentAfter = storeContent(r.context.storeRoot);
    const contentBytesAfter = contentMap(contentAfter);
    const added = contentAfter.filter(entry => !(entry.path in contentBytesBefore));
    assert.deepEqual(added.map(entry => entry.path).sort(), [publicationKeysOf(summary.reportId).report.relativePath,
      publicationKeysOf(summary.reportId).commit.relativePath].sort(), 'exactly the new child report and commit were added');
    for (const entry of contentBefore) {
      assert.equal(contentBytesAfter[entry.path], entry.sha256, `the prior content record ${entry.path} is byte-identical`);
    }
    assert.ok(rawInventory(r.context.storeRoot).entries.some(entry => entry.path === '.storage/registry.json'),
      'the C1 store registry bookkeeping is present and distinct from the content records');
    assertInputsUnchanged(r.p.fixture, r.inputsBefore);
  });
});
