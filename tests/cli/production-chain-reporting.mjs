/**
 * C6.S11.T6 — post-evaluation UI/export/reset composition helper for the real production chain.
 *
 * This file owns ONE exported async helper, `completeProductionChain(t, inputs)`. T1's slow test
 * runs the two real `evaluate` handoffs itself; after both committed summaries exist it calls this
 * helper with the fully supplied contract, and the Captain integrates and runs the full actual
 * proof. The helper performs the two decided post-evaluation checks with the real CLI only:
 *
 *   Check 1 — selection, review attachment and safe export over the real first evaluation:
 *     a fresh export with only `--evaluation` selects the committed baseline even though a newer
 *     reviewed child will exist; a fresh template is the bound, intentionally invalid blank with
 *     seven null category scores and is never attached; a completed SYNTHETIC protocol worksheet
 *     (physicalWorksheet evidence bytes, not screenshots or a human judgment) attaches through the
 *     real CLI into a fresh child report with UI20 and combined = automated + 20 while the parent
 *     report bytes and file bytes are byte-unchanged; an explicit child export and then a
 *     baseline-again export both land in their own fresh, exactly-three-file bundles whose bytes
 *     equal the accepted C5 renderers for the selected report, with the closed completion marker
 *     and no raw identifiers, roots or synthetic reviewer/narrative strings in any safe file.
 *   Check 2 — full witnesses then reset isolation:
 *     the FULL run and results inventories (nothing skipped) are recorded with no live
 *     `.storage/lock`, the real reset creates a fresh 26-file run whose sealed
 *     architectureId/harness/securityModel/configuration match the old manifest (a start-declared
 *     model value does not appear in the new sealed configuration), the new container inherits no
 *     snapshot/result/attempt/report and reads a null results context, and the ENTIRE old run and
 *     results trees are byte-identical after the reset and the new read.
 *
 * The caller (T1) owns cleanup of `root`; the helper registers none. `t` is accepted for the
 * caller's test context and diagnostic label only. This helper starts no server, installs nothing,
 * runs no benchmark agent and touches no production file. Its own acceptance here is the syntax
 * check from its task packet; the runtime proof is the Captain's integrated run of T1.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { readPublishedReport } from '../../packages/results/publication.mjs';
import { publicationKeysOf } from '../../packages/results/publication-runtime.mjs';
import { createExportProjection, validateExportProjection } from '../../packages/results/export-contract.mjs';
import { renderReportJSON, renderReportText } from '../../packages/results/exports.mjs';
import { openSelectedRun, readResultsContext } from '../../cli/run-context.mjs';
import { loadInstallation } from '../../cli/installation.mjs';
import { uiCaps } from '../../evaluator/score.mjs';
import { invokeProduction, successSummary } from './production-fixture.mjs';
import { physicalWorksheet } from '../results/publication-fixture.mjs';

const EXPORT_NAMES = ['report.json', 'report.txt'];
const MARKER = 'EXPORT_COMPLETE.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const round = value => Number(value.toFixed(4));
const humanCapTotal = Object.values(uiCaps).reduce((total, cap) => total + cap, 0);

/** The committed record file for one report, read as raw bytes for the file-level witness. */
function readStoreFile(storeRoot, reportId) {
  const relative = publicationKeysOf(reportId).report.relativePath;
  return fs.readFileSync(path.join(storeRoot, ...relative.split('/')));
}

/** A completed safe-export bundle: exactly the three files, accepted-renderer parity, closed marker, no private value. */
function assertSafeBundle(output, report, forbidden) {
  assert.deepEqual(fs.readdirSync(output).sort(), [...EXPORT_NAMES, MARKER].sort(),
    'the exported directory holds exactly report.json, report.txt and EXPORT_COMPLETE.json');
  const projection = createExportProjection(report);
  const json = renderReportJSON(projection), text = renderReportText(projection);
  const actualJSON = fs.readFileSync(path.join(output, 'report.json'));
  const actualText = fs.readFileSync(path.join(output, 'report.txt'));
  assert.equal(actualJSON.toString('utf8'), json, 'report.json equals the accepted JSON renderer output for the selected Report');
  assert.equal(actualText.toString('utf8'), text, 'report.txt equals the accepted text renderer output for the selected Report');
  assert.deepEqual(validateExportProjection(JSON.parse(actualJSON.toString('utf8'))), projection,
    'the written JSON projection revalidates through the accepted export contract');
  const markerText = fs.readFileSync(path.join(output, MARKER), 'utf8'), marker = JSON.parse(markerText);
  assert.deepEqual(Object.keys(marker).sort(), ['files', 'kind', 'schemaVersion']);
  assert.equal(marker.kind, 'benchboard.cli.safe-export.v1');
  assert.equal(marker.schemaVersion, '1.0.0');
  assert.deepEqual(marker.files, [[EXPORT_NAMES[0], actualJSON], [EXPORT_NAMES[1], actualText]]
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha(bytes) })),
    'the closed marker orders report.json then report.txt with byte counts and sha256 digests');
  for (const secret of [...forbidden, 'synthetic-human-reviewer', 'review-publication-synthetic',
    'Synthetic non-image evidence', 'Synthetic evidence note', 'Synthetic category comparison']) {
    for (const bytes of [actualJSON, actualText, fs.readFileSync(path.join(output, MARKER))]) {
      assert.equal(bytes.toString('utf8').includes(secret), false,
        `no safe file or marker carries ${JSON.stringify(secret)}`);
    }
  }
}

/** One full-inventory witness: every entry, nothing skipped. */
const fullInventory = root => inventoryTree({ root, skipNames: [] });
/** The storage lock exists only while a writer holds it; a settled witness tree must not carry one. */
function assertNoLiveLock(inventory, label) {
  const live = inventory.entries.filter(entry => entry.path.endsWith('.storage/lock'));
  assert.deepEqual(live, [], `${label}: no .storage/lock file remains after every CLI child has exited`);
}

/**
 * Runs both post-evaluation checks over the supplied real contract and returns the produced
 * template, attach, export, reset and new-run witnesses. Throws (through assert) on any refusal.
 */
export async function completeProductionChain(t, { root, runRoot, init, frozen, opened, context, first, baseline }) {
  void t; // Caller's test context; the helper registers no cleanup — T1 owns the root in its finally.
  /* ------------------------------------------------------------------ */
  /* Check 1 — selection, real attachment of a synthetic protocol review  */
  /* ------------------------------------------------------------------ */
  assert.equal(init.workloadFileCount, 26, 'the supplied init summary carries the canonical 26 workload files');
  assert.equal(frozen.state, 'FROZEN', 'the supplied freeze summary is a verified FROZEN submission');
  assert.equal(first.evaluationId, baseline.evidence.evaluationId,
    'the first evaluation summary names the baseline Report\'s own evaluation');
  assert.equal(first.reportId, baseline.reportId, 'the first evaluation committed exactly the supplied baseline Report');
  assert.equal(opened.runRoot, runRoot);
  assert.equal(baseline.execution.humanReview, 'NOT_REVIEWED');
  const storeRoot = context.storeRoot;
  const baselineSecrets = [baseline.reportId, baseline.bindings.runId, first.evaluationId,
    root, runRoot, init.workspaceRoot, frozen.snapshotRoot, context.resultsRoot, storeRoot];

  /* The baseline bytes before any post-evaluation operation, at the read and file level. */
  const baselineReadBefore = await readPublishedReport({ storeRoot, reportId: baseline.reportId });
  const baselineFileBefore = readStoreFile(storeRoot, baseline.reportId);
  assert.deepEqual(baselineReadBefore, baseline, 'the supplied baseline is the exact committed report');

  /* 1a. A fresh export with only --evaluation selects the baseline, never a later child. */
  const firstExportOutput = path.join(root, 'chain safe export 1');
  const firstExport = successSummary(invokeProduction(root,
    ['export', '--run', runRoot, '--evaluation', first.evaluationId, '--output', firstExportOutput], { timeout: 30000 }));
  assert.equal(firstExport.command, 'export');
  assert.equal(firstExport.reportId, baseline.reportId, 'the unqualified export selected the baseline');
  assert.equal(firstExport.humanReview, 'NOT_REVIEWED');
  assert.deepEqual(firstExport.humanUI, null, 'a pending baseline exports null human UI, never zero');
  assert.deepEqual(firstExport.quality, null);
  assert.equal(firstExport.output, firstExportOutput);
  assert.equal(firstExport.complete, true);
  assertSafeBundle(firstExportOutput, baseline, baselineSecrets);

  /* 1b. The real template is the bound intentionally invalid blank; it is never attached. */
  const templatePath = path.join(root, 'chain ui blank template.json');
  const template = successSummary(invokeProduction(root,
    ['ui', '--run', runRoot, '--template', '--evaluation', first.evaluationId, '--output', templatePath], { timeout: 30000 }));
  assert.equal(template.mode, 'template');
  assert.equal(template.parentReportId, baseline.reportId);
  assert.equal(template.parentReportDigest, baseline.reportDigest);
  assert.equal(template.evaluationId, first.evaluationId);
  assert.equal(template.humanReview, 'NOT_REVIEWED');
  assert.deepEqual(template.humanUI, null);
  assert.equal(template.worksheetComplete, false);
  assert.equal(template.output, templatePath);
  const blank = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  assert.deepEqual(blank.bindings, {
    reportId: baseline.reportId, reportDigest: baseline.reportDigest, evaluationId: first.evaluationId,
    bundleDigest: baseline.evidence.bundleDigest, snapshotId: baseline.bindings.snapshotId,
    treeDigest: baseline.bindings.treeDigest,
  }, 'the blank template carries the parent report\'s exact bindings');
  assert.deepEqual(Object.keys(blank.scores).sort(), Object.keys(uiCaps).sort(),
    'the blank carries one score slot for every uiCaps category');
  assert.equal(Object.keys(blank.scores).length, 7, 'the accepted category count is seven');
  for (const key of Object.keys(blank.scores)) assert.deepEqual(blank.scores[key], null, `the blank score for ${key} is null, not zero`);
  assert.equal(blank.baselineCompared, false);
  assert.deepEqual(blank.evidence, []);

  /* 1c. A completed SYNTHETIC protocol worksheet (fixture evidence bytes, not screenshots or a
   * human judgment) attaches through the real CLI into a fresh scored child. */
  const reviewRoot = path.join(root, 'chain review evidence');
  fs.mkdirSync(reviewRoot);
  const worksheet = physicalWorksheet(baseline, reviewRoot, true);
  assert.equal(worksheet.evidence.length, 12, 'the protocol creates twelve synthetic evidence files');
  const worksheetPath = path.join(root, 'chain ui completed worksheet.json');
  fs.writeFileSync(worksheetPath, JSON.stringify(worksheet, null, 2) + '\n');
  const attach = successSummary(invokeProduction(root,
    ['ui', '--run', runRoot, '--input', worksheetPath, '--review-root', reviewRoot], { timeout: 30000 }));
  assert.equal(attach.mode, 'attach');
  assert.equal(attach.parentReportId, baseline.reportId);
  assert.equal(attach.parentReportDigest, baseline.reportDigest);
  assert.notEqual(attach.reportId, baseline.reportId, 'the attachment created a fresh child report ID');
  assert.equal(attach.evaluationId, first.evaluationId);
  assert.equal(attach.humanReview, 'SCORED');
  const automated = baseline.quality.automated;
  assert.deepEqual(attach.automated, automated, 'the synthetic review leaves the automated total unchanged');
  assert.equal(attach.humanUI, humanCapTotal, 'the fully positive synthetic protocol review carries the capped 20');
  assert.equal(attach.quality, round(automated + humanCapTotal), 'combined equals automated plus 20 through the unchanged scorer');

  /* The committed child keeps every parent binding, evaluation, bundle, category and parentage. */
  const child = await readPublishedReport({ storeRoot, reportId: attach.reportId });
  assert.deepEqual(child.bindings, baseline.bindings, 'the child retains all parent bindings');
  assert.equal(child.evidence.evaluationId, baseline.evidence.evaluationId);
  assert.equal(child.evidence.bundleDigest, baseline.evidence.bundleDigest);
  assert.deepEqual(child.quality.areas, baseline.quality.areas, 'the child\'s automated categories match the parent\'s');
  assert.equal(child.execution.humanReview, 'SCORED');
  assert.equal(child.provenance.parentReportId, baseline.reportId);
  assert.equal(child.provenance.parentReportDigest, baseline.reportDigest);
  assert.equal(child.provenance.review.evidence.length, 12);

  /* The parent report is byte-unchanged by the legitimate child publication, at read and file level. */
  assert.deepEqual(await readPublishedReport({ storeRoot, reportId: baseline.reportId }), baselineReadBefore,
    'the baseline Report reads byte-identical after the child was committed');
  assert.deepEqual(readStoreFile(storeRoot, baseline.reportId), baselineFileBefore,
    'the baseline Report file bytes are unchanged after the child was committed');

  /* 1d. An explicit child export, then a baseline-again export: each to its own fresh bundle, and
   * the unqualified selection order remains the baseline, never the latest child. */
  const childExportOutput = path.join(root, 'chain safe export 2');
  const childExport = successSummary(invokeProduction(root,
    ['export', '--run', runRoot, '--evaluation', first.evaluationId, '--report', child.reportId,
      '--output', childExportOutput], { timeout: 30000 }));
  assert.equal(childExport.reportId, child.reportId);
  assert.equal(childExport.humanReview, 'SCORED');
  assert.equal(childExport.humanUI, humanCapTotal);
  assert.equal(childExport.quality, round(automated + humanCapTotal));
  assertSafeBundle(childExportOutput, child, [...baselineSecrets, child.reportId]);

  const baselineAgainOutput = path.join(root, 'chain safe export 3');
  const baselineAgain = successSummary(invokeProduction(root,
    ['export', '--run', runRoot, '--evaluation', first.evaluationId, '--output', baselineAgainOutput], { timeout: 30000 }));
  assert.equal(baselineAgain.reportId, baseline.reportId, 'after the reviewed child exists, the evaluation-selected export is still the baseline');
  assert.deepEqual(baselineAgain.humanUI, null, 'pending null versus reviewed 20 is unchanged by selection order');
  assert.deepEqual(baselineAgain.quality, null);
  assertSafeBundle(baselineAgainOutput, baseline, baselineSecrets);

  console.log('C6.S11.T6: automated points are actual CLI proof; the 20 UI points come from the synthetic protocol worksheet evidence, not a human judgment.');

  /* ------------------------------------------------------------------ */
  /* Check 2 — full witnesses, real reset, sealed parity, old bytes still */
  /* ------------------------------------------------------------------ */
  const runBefore = fullInventory(runRoot);
  const resultsBefore = fullInventory(context.resultsRoot);
  assertNoLiveLock(runBefore, 'the settled run witness');
  assertNoLiveLock(resultsBefore, 'the settled results witness');

  const resetOutput = path.join(root, 'chain reset container');
  const reset = successSummary(invokeProduction(root,
    ['reset', '--run', runRoot, '--output', resetOutput, '--dependency-mode', 'none'], { timeout: 30000 }));
  assert.equal(reset.command, 'reset');
  assert.equal(reset.fresh, true, 'the reset reports a fresh destination');
  assert.equal(reset.oldContainerMutation, 'none', 'the reset reports no old-container mutation');
  assert.equal(reset.dependencyMode, 'none');
  assert.notEqual(reset.manifestId, opened.manifestId, 'the new run has a distinct manifestId');
  assert.notEqual(reset.runId, opened.runId, 'the new run has a distinct runId');
  assert.equal(reset.workloadFileCount, 26, 'the new workspace carries the canonical 26 workload files');
  assert.equal(reset.workloadDigest, loadInstallation().challenge.identity.workloadDigest,
    'the new workload digest is the exact original challenge digest');
  assert.equal(reset.source.runId, opened.runId, 'the reset names the old run as its source');
  assert.equal(reset.source.manifestId, opened.manifestId);
  assert.equal(reset.sourceCleanup.status, 'removed');
  assert.equal(fs.existsSync(reset.sourceCleanup.root), false, 'the staged source root no longer exists');

  /* The new container read-only: sealed identity parity, no start-declared model, no inheritance. */
  const newOpened = await openSelectedRun(resetOutput);
  for (const field of ['architectureId', 'architectureKind', 'harness', 'securityModel']) {
    assert.equal(newOpened.manifest[field], opened.manifest[field],
      `the new sealed manifest keeps the old manifest's ${field}`);
  }
  assert.deepEqual(newOpened.manifest.configuration, opened.manifest.configuration,
    'the new sealed configuration matches the old sealed configuration');
  assert.deepEqual(newOpened.manifest.configuration.model ?? null, null,
    'a start-declared model value does not appear in the new sealed configuration');
  assert.equal(newOpened.manifest.configuration.unknownFields.includes('model'), true,
    'the new sealed configuration declares the model unknown');
  assert.equal(await readResultsContext(newOpened), null, 'the new run has no results context');
  const newStatus = successSummary(invokeProduction(root, ['status', '--run', resetOutput], { timeout: 30000 }));
  assert.equal(newStatus.state, 'INITIALIZED', 'the new container reports INITIALIZED');
  assert.deepEqual(newStatus.attempts, [], 'no old attempt reference is inherited');
  assert.equal(fs.existsSync(path.join(resetOutput, 'snapshots')), false, 'the new container inherited no snapshot');
  assert.equal(fs.existsSync(path.join(resetOutput, '.benchboard', 'cli', 'results.json')), false,
    'the new container inherited no results binding');
  assert.equal(fs.existsSync(`${resetOutput}.benchboard-results`), false, 'the reset created no default results root');

  /* The ENTIRE old run and results trees are byte-identical after the reset and the new read. */
  const runAfter = fullInventory(runRoot);
  const resultsAfter = fullInventory(context.resultsRoot);
  assert.deepEqual(runAfter.entries, runBefore.entries, 'every old-run entry (metadata, locks, snapshots, state, workspace) is byte-identical after the reset and the new-run read');
  assert.equal(runAfter.digest, runBefore.digest, 'the old-run tree digest is unchanged');
  assert.deepEqual(resultsAfter.entries, resultsBefore.entries, 'every results entry (context, attempt records, execution records, evaluation outputs, store reports and commits) is byte-identical after the reset and the new-run read');
  assert.equal(resultsAfter.digest, resultsBefore.digest, 'the results tree digest is unchanged');
  assertNoLiveLock(runAfter, 'the post-reset run witness');
  assertNoLiveLock(resultsAfter, 'the post-reset results witness');

  return { template, attach, child, exports: [firstExport, childExport, baselineAgain], reset, newRunRoot: resetOutput };
}
