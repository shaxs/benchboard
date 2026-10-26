/**
 * Real-CLI export privacy and destination-refusal acceptance (task packet C6.S8.T6).
 *
 * Every case drives the executable `cli/benchboard.mjs export` through one shell-free,
 * bounded spawnSync child against the Captain-owned fixture `makeCliExportFixture`
 * plus `attachSyntheticExportChild` with `privateCanary: true`, so the reviewed child
 * report physically carries the reviewer, narrative and improvement canaries in the
 * published store while its safe projection is what the real C5 pipeline renders.
 *
 * The three decided checks:
 *  1. A successful private-canary reviewed export publishes exactly report.json,
 *     report.txt and EXPORT_COMPLETE.json, and no scanned export file carries a
 *     private canary, a fixture/run/results/evaluation/review path,
 *     a raw report/evaluation/run/manifest identifier, or an ordinary fixture log
 *     string. The published safe pair equals the accepted C5 projection renderers
 *     byte for byte, so validated structured disclosures, digests, provenance and
 *     opaque refs survive unchanged (nothing retained is scrubbed). The separate local stdout
 *     summary intentionally carries the private identifiers and the output path and
 *     is not sharing material; it must still never dump worksheet, reviewer,
 *     narrative, configuration or log content.
 *  2. Destination refusals: occupied ordinary directory/file and a repeat against the
 *     successful bundle refuse state3 without overwriting a byte; linked/junction
 *     destination or parent, literal dot/dot-dot traversal, relative and drive-relative
 *     spellings, stream/alternate-data and device or trailing-dot spellings, and
 *     repository/run/results-root overlaps refuse integrity4 without following or
 *     deleting foreign canaries or creating export content; a missing output parent
 *     refuses the raw missing-root state3 and no parent is invented. Dot-attack
 *     strings are passed literally, never pre-normalised with path.join.
 *  3. Every failed child writes nothing to stdout and exactly the fixed CATEGORIES
 *     stderr line; after the whole command sequence the workspace, frozen snapshot,
 *     evaluation root, review evidence and the results context (attempts, store and
 *     context records) are byte-unchanged, with transient C1 storage lock files
 *     excluded from the store assertion.
 *
 * All evidence is synthetic artifact protocol: controlled C4 stage results and
 * synthetic non-image evidence bytes, not real evaluator execution, screenshot pixels
 * or human judgment. No production code, probes or formatters are touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCliExportFixture, attachSyntheticExportChild } from './export-fixture.mjs';
import { createExportProjection } from '../../packages/results/export-contract.mjs';
import { renderReportJSON, renderReportText } from '../../packages/results/exports.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { CATEGORIES } from '../../cli/command-error.mjs';

/* The fixed child contract from the task packet: absolute entrypoint, no shell,
 * bounded output, bounded wall time, run from the fixture root. */
const ABSOLUTE_CLI = fileURLToPath(new URL('../../cli/benchboard.mjs', import.meta.url));
const CHILD_TIMEOUT_MS = 20000;
const CHILD_MAX_BUFFER_BYTES = 1048576;

const REVIEWER_CANARY = 'PRIVATE_CLI_EXPORT_REVIEWER_CANARY';
const NARRATIVE_CANARY = 'PRIVATE_CLI_EXPORT_NARRATIVE_CANARY';
const IMPROVEMENT_CANARY = 'PRIVATE_CLI_EXPORT_IMPROVEMENT_CANARY';

/* The ordinary controlled log strings the fixture writes into the evaluation
 * artifacts (fake tool logs and controlled stage diagnostics). */
const FIXTURE_LOG_MARKERS = ['fake tool log', 'controlled diagnostic'];
const WORKSHEET_TEXT_MARKERS = ['synthetic-human-reviewer', 'Synthetic evidence note', 'Synthetic category comparison'];
const OPAQUE_REF = /^[a-f0-9]{64}$/;

/* One fresh scratch parent for export destinations, outside every protected root. */
function scratchDir(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bb-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 }));
  return root;
}

function runExportChild(r, output) {
  const result = spawnSync(process.execPath, [ABSOLUTE_CLI, 'export',
    '--run', r.opened.runRoot, '--evaluation', r.report.evidence.evaluationId,
    '--report', r.child.reportId, '--output', output], {
    cwd: r.p.fixture.root, encoding: 'utf8', shell: false, windowsHide: true,
    timeout: CHILD_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER_BYTES,
  });
  assert.equal(result.error ?? null, null, `the shell-free child reported no spawn error (output ${JSON.stringify(output)}): ${String(result.error?.message)}`);
  return result;
}

/* The fixed single-line stderr the application prints for one CATEGORIES diagnostic. */
function expectedStderr(category) {
  const diagnostic = CATEGORIES[category];
  return `${diagnostic.code}: ${diagnostic.guidance}\n`;
}

function assertRefused(result, category, label) {
  assert.equal(result.status, CATEGORIES[category].exitCode,
    `${label}: the child reports the concrete ${category} exit code, stderr ${JSON.stringify(result.stderr)}`);
  assert.equal(result.stdout, '', `${label}: a refused child writes nothing to stdout`);
  assert.equal(result.stderr.replace(/\r\n/g, '\n'), expectedStderr(category),
    `${label}: stderr is exactly the fixed CATEGORIES line, verbatim`);
}

/* Everything that must not appear in sharing material (the published bundle). */
function privateMaterial(r) {
  return [REVIEWER_CANARY, NARRATIVE_CANARY, IMPROVEMENT_CANARY,
    r.p.fixture.root, r.opened.runRoot, r.context.resultsRoot, r.start.outputRoot, r.p.reviewRoot,
    r.report.reportId, r.child.reportId, r.report.evidence.evaluationId,
    r.opened.runId, r.opened.manifestId,
    ...FIXTURE_LOG_MARKERS, ...WORKSHEET_TEXT_MARKERS];
}

/* Build the fixture and the private-canary reviewed child through the accepted
 * Captain-owned fixture helper, then freeze the pre-command state of every
 * protected domain for the later invariance comparison. */
async function privateFixture(t, label) {
  const r = await makeCliExportFixture(t);
  r.child = await attachSyntheticExportChild(r, { positive: true, suffix: 'private-canary', privateCanary: true });
  /* The canaries must physically be in the stored reviewed child, otherwise the
   * privacy scan below would prove nothing. */
  const stored = JSON.parse(JSON.stringify(r.child));
  assert.ok(JSON.stringify(stored).includes(REVIEWER_CANARY) &&
    JSON.stringify(stored).includes(NARRATIVE_CANARY) &&
    JSON.stringify(stored).includes(IMPROVEMENT_CANARY),
  'the reviewed child report itself carries all three private canaries before export');
  const scratch = scratchDir(t, label);
  const protectedState = () => Object.freeze({
    workspace: inventoryTree({ root: r.opened.workspaceRoot, skipNames: [] }).digest,
    snapshot: inventoryTree({ root: r.p.fixture.frozen.snapshotRoot, skipNames: [] }).digest,
    evaluation: inventoryTree({ root: r.start.outputRoot, skipNames: [] }).digest,
    review: inventoryTree({ root: r.p.reviewRoot, skipNames: [] }).digest,
    /* Transient C1 storage lock files are excluded from the store comparison; every
     * other results-domain byte (context.json, attempt records, stored reports and
     * commits, registry) must be byte-identical. */
    results: inventoryTree({ root: r.context.resultsRoot, skipNames: [] }).entries
      .filter(entry => path.basename(entry.path) !== 'lock')
      .map(entry => `${entry.path}\0${entry.bytes}\0${entry.sha256}`).join('\n'),
  });
  return { r, scratch, before: protectedState(), protectedState };
}

test('check 1 — a real successful private-canary reviewed export publishes exactly the three-file bundle with no private material while the safe projection survives unchanged', async t => {
  const { r, scratch } = await privateFixture(t, 'c6s8t6-c1');
  const output = path.join(scratch, 'safe bundle');
  const result = runExportChild(r, output);

  assert.equal(result.status, 0, `the successful export exits 0; stderr ${JSON.stringify(result.stderr)}`);
  assert.equal(result.stderr, '', 'the successful export writes nothing to stderr');

  /* The bundle is exactly the closed three-file set, nothing more. */
  assert.deepEqual(fs.readdirSync(output).sort(), ['EXPORT_COMPLETE.json', 'report.json', 'report.txt']);

  /* Every file is scanned for every private value. */
  const material = privateMaterial(r);
  for (const name of fs.readdirSync(output)) {
    const text = fs.readFileSync(path.join(output, name), 'utf8');
    for (const value of material) {
      assert.equal(text.includes(value), false, `${name} must not carry the private value ${JSON.stringify(value)}`);
    }
  }

  /* The accepted safe pair is byte-identical: validated structured disclosures,
   * digests, provenance and opaque references pass through the real CLI exactly as
   * the accepted C5 projection renderers produce them; nothing retained is scrubbed. */
  const projection = createExportProjection(r.child);
  assert.equal(fs.readFileSync(path.join(output, 'report.json'), 'utf8'), renderReportJSON(projection),
    'report.json equals the accepted C5 JSON render of the reviewed child projection byte for byte');
  assert.equal(fs.readFileSync(path.join(output, 'report.txt'), 'utf8'), renderReportText(projection),
    'report.txt equals the accepted C5 text render of the reviewed child projection byte for byte');

  /* The structured review disclosure survives as opaque references and scores. */
  const published = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
  assert.equal(published.identity.reportRef.match(OPAQUE_REF) !== null, true, 'reportRef stays an opaque reference');
  assert.equal(published.identity.evaluationRef.match(OPAQUE_REF) !== null, true, 'evaluationRef stays an opaque reference');
  assert.equal(published.identity.parentReportRef.match(OPAQUE_REF) !== null, true, 'parentReportRef stays an opaque reference');
  assert.ok(Array.isArray(published.notices) && published.notices.length > 0, 'the safe notices are retained');
  assert.ok(published.review !== null, 'the reviewed child keeps its structured review section');
  assert.equal(published.review.reviewerRef.match(OPAQUE_REF) !== null, true, 'the reviewer is disclosed as an opaque reference, not the canary');
  assert.deepEqual(published.review.scores, r.child.provenance.review.scores, 'the structured category scores are retained unchanged');
  assert.equal(published.review.artifacts.length, 12, 'all twelve structured review artifact references are retained');

  /* The local stdout summary intentionally carries the private identifiers and the
   * output path (it is the local summary, not sharing material), yet it never dumps
   * worksheet, reviewer, narrative, configuration or log content. */
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.command, 'export');
  assert.equal(summary.reportId, r.child.reportId, 'the local summary names the selected report for the operator');
  assert.equal(summary.evaluationId, r.report.evidence.evaluationId, 'the local summary names the evaluation for the operator');
  assert.equal(summary.output, path.resolve(output), 'the local summary names the destination path for the operator');
  for (const value of [REVIEWER_CANARY, NARRATIVE_CANARY, IMPROVEMENT_CANARY,
    r.p.reviewRoot, r.p.fixture.root, ...FIXTURE_LOG_MARKERS, ...WORKSHEET_TEXT_MARKERS]) {
    assert.equal(result.stdout.includes(value), false, `the local summary must not dump ${JSON.stringify(value)}`);
  }
});

test('check 2 — occupied, linked, traversal, spelling, overlap and missing-parent destinations are refused read-only with the fixed category fates', async t => {
  const { r, scratch } = await privateFixture(t, 'c6s8t6-c2');
  const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

  /* A successful baseline bundle to repeat onto and to compare bytes against. */
  const bundle = path.join(scratch, 'bundle');
  assert.equal(runExportChild(r, bundle).status, 0, 'the baseline bundle is published before the refusal battery');
  const priorBundleBytes = ['report.json', 'report.txt', 'EXPORT_COMPLETE.json'].map(name => fs.readFileSync(path.join(bundle, name)));

  /* A foreign canary inside the junction target, proving no follow-through or deletion. */
  fs.writeFileSync(path.join(scratch, 'junction-canary'), 'PRIVATE_JUNCTION_CANARY');

  const cases = [];
  /* Occupied ordinary directory — state3. */
  fs.mkdirSync(path.join(scratch, 'occupied-dir'));
  cases.push([path.join(scratch, 'occupied-dir'), 'state', 'occupied ordinary directory']);
  /* Occupied ordinary file — state3, byte kept. */
  fs.writeFileSync(path.join(scratch, 'occupied-file'), 'ordinary-file-bytes');
  cases.push([path.join(scratch, 'occupied-file'), 'state', 'occupied ordinary file']);
  /* Same command repeated into the successful bundle — state3, prior bytes intact. */
  cases.push([bundle, 'state', 'repeat onto the successful bundle']);
  /* Linked/junction destination and junction parent — integrity4, no follow-through. */
  const junction = path.join(scratch, 'junction');
  fs.symlinkSync(scratch, junction, 'junction');
  cases.push([path.join(junction, 'via-link'), 'integrity', 'junction destination']);
  cases.push([path.join(junction, 'nested', 'bundle2'), 'integrity', 'junction parent']);
  /* Explicit literal dot traversal, passed un-normalised. */
  cases.push([scratch + path.sep + '.' + path.sep + 'dot-bundle', 'integrity', 'literal dot traversal']);
  cases.push([scratch + path.sep + '..' + path.sep + 'dotdot-bundle', 'integrity', 'literal dot-dot traversal']);
  /* Relative and drive-relative spellings — integrity4. */
  cases.push(['export-out', 'integrity', 'relative path']);
  cases.push(['C:export-out', 'integrity', 'drive-relative path']);
  /* Alternate-stream and reserved-device/trailing-dot spellings — integrity4,
   * refused as name text only; nothing is ever opened against a stream or device. */
  cases.push([path.join(scratch, 'stream-bundle') + ':stream', 'integrity', 'alternate-stream spelling']);
  cases.push([path.join(scratch, 'nul'), 'integrity', 'reserved device spelling']);
  cases.push([path.join(scratch, 'dot-alias') + '.', 'integrity', 'trailing-dot alias']);
  /* Repository, run-container and entire-results-root overlaps — integrity4. */
  cases.push([path.join(repositoryRoot, 'benchboard-export-attack'), 'integrity', 'repository-root overlap']);
  cases.push([path.join(r.opened.runRoot, 'export-attack'), 'integrity', 'run-container overlap']);
  cases.push([path.join(r.context.resultsRoot, 'export-attack'), 'integrity', 'results-root overlap']);
  /* Missing output parent — the raw missing-root state3, never an invented parent. */
  cases.push([path.join(scratch, 'missing-parent', 'bundle'), 'state', 'missing output parent']);

  for (const [output, category, label] of cases) {
    const result = runExportChild(r, output);
    assertRefused(result, category, label);
    assert.equal(fs.existsSync(path.resolve(output)) && category === 'integrity', false,
      `${label}: the refused destination was not created`);
  }

  /* The repeat onto the successful bundle left every prior byte exactly as it was. */
  ['report.json', 'report.txt', 'EXPORT_COMPLETE.json'].forEach((name, index) => {
    assert.deepEqual(fs.readFileSync(path.join(bundle, name)), priorBundleBytes[index],
      `the repeat onto the bundle did not change ${name}`);
  });
  /* The occupied file and the junction-target canary are untouched foreign bytes. */
  assert.equal(fs.readFileSync(path.join(scratch, 'occupied-file'), 'utf8'), 'ordinary-file-bytes', 'the occupied file bytes are unchanged');
  assert.equal(fs.readFileSync(path.join(scratch, 'junction-canary'), 'utf8'), 'PRIVATE_JUNCTION_CANARY', 'the junction-target canary bytes are unchanged');
  assert.equal(fs.existsSync(path.join(scratch, 'via-link')), false, 'the junction refusal created nothing at the physical target');
  assert.equal(fs.existsSync(path.join(scratch, 'nested')), false, 'the junction-parent refusal created nothing at the physical target');
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'benchboard-export-attack')), false, 'the repository-overlap refusal created nothing in the repository');
  /* The junction itself was not followed into any export content beyond what the
   * scratch listing already accounts for. */
  fs.rmSync(junction, { force: true, maxRetries: 4 });
  assert.deepEqual(fs.readdirSync(scratch).sort(),
    ['bundle', 'junction-canary', 'occupied-dir', 'occupied-file'].sort(),
    'the refusal battery created no export content in the scratch root');
});

test('check 3 — after the full command sequence every protected domain is byte-unchanged and failed children echo no private material or stack', async t => {
  const { r, scratch, before, protectedState } = await privateFixture(t, 'c6s8t6-c3');

  /* One mixed sequence through the real CLI: a success, then refusals spanning both
   * categories, each checked for the fixed verbatim stderr and empty stdout. */
  const output = path.join(scratch, 'sequence-bundle');
  assert.equal(runExportChild(r, output).status, 0, 'the sequence begins with one successful export');

  fs.mkdirSync(path.join(scratch, 'occupied'));
  fs.symlinkSync(scratch, path.join(scratch, 'link'), 'junction');
  const refused = [
    [path.join(scratch, 'occupied'), 'state', 'occupied directory'],
    [output, 'state', 'repeat onto the bundle'],
    [path.join(scratch, 'missing', 'bundle'), 'state', 'missing parent'],
    [path.join(scratch, 'link', 'via-link'), 'integrity', 'junction destination'],
    [path.join(r.context.resultsRoot, 'attack'), 'integrity', 'results-root overlap'],
    [scratch + path.sep + '.' + path.sep + 'dot', 'integrity', 'literal dot traversal'],
    [path.join(scratch, 'nul'), 'integrity', 'reserved device spelling'],
  ];
  for (const [target, category, label] of refused) {
    const result = runExportChild(r, target);
    assertRefused(result, category, label);
    /* The fixed line contains no root, reviewer, narrative or stack echo. */
    for (const value of [REVIEWER_CANARY, NARRATIVE_CANARY, IMPROVEMENT_CANARY,
      r.p.fixture.root, r.opened.runRoot, r.context.resultsRoot, r.p.reviewRoot, '\n    at ']) {
      assert.equal(result.stderr.includes(value), false, `${label}: stderr echoes no ${JSON.stringify(value)}`);
    }
  }

  /* After all commands, the protected domains are byte-identical to the pre-command
   * state (transient C1 lock files excluded from the results comparison). */
  assert.deepEqual(protectedState(), before,
    'workspace, frozen snapshot, evaluation root, review evidence and the results domain are unchanged after the whole command sequence');

  /* The published bundle from the sequence success still carries no private material. */
  const bundleText = fs.readdirSync(output).map(name => fs.readFileSync(path.join(output, name), 'utf8')).join('\n');
  for (const value of privateMaterial(r)) {
    assert.equal(bundleText.includes(value), false, `the sequence bundle must not carry ${JSON.stringify(value)}`);
  }
});
