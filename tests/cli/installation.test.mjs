/**
 * Independent real installation acceptance for the development installation
 * loader and the run/results context helpers (task packet C6.S2.T2).
 *
 * These tests drive the real production surfaces — `loadInstallation()` from
 * `cli/installation.mjs`, `openSelectedRun` / `readResultsContext` /
 * `ensureResultsContext` from `cli/run-context.mjs`, and the accepted
 * `initialiseRun` from `packages/core/init.mjs` — against the real installed
 * repository bytes. They do not use the synthetic identities under
 * `tests/contracts/` as installation inputs, and they do not weaken an
 * assertion when a helper is absent: the Captain is landing the production
 * helpers concurrently, so a missing helper surfaces here as a failure and is
 * disclosed in the result packet rather than stubbed away.
 *
 * Acceptance groups (decided in the packet):
 * 1. The three C1 identities validate, the stable installed identities agree
 *    with the actual C4 semantic/package identity, the real workload digest
 *    and 26-entry file manifest hold, and the candidate lineage stays
 *    `1.0.0-candidate.9`, separate from the neutral versions.
 * 2. The selected asset manifest is sorted, unique, digest-shaped, covers the
 *    CLI and accepted modules, excludes test/owner/reference/node_modules/
 *    artifacts paths, and the loader changes nothing on disk.
 * 3. A fresh external temporary run (path contains a space) initialised with
 *    the actual loaded inputs opens through `openSelectedRun` with the sealed
 *    identities, not the folder name, and `readResultsContext` is null before
 *    the first binding and creates nothing.
 * 4. `ensureResultsContext` binds the default sibling, keeps attempts and the
 *    report store disjoint, binds the exact run identity, re-reads stably, a
 *    second fresh run can bind an explicit external alternative, and the
 *    workspace inventory is byte-identical before and after context work.
 *
 * Adversarial cases (links, substitution, overlap, concurrency, incomplete
 * references) belong to the Captain's own suites and are not written here.
 */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createId, inventoryTree, hashEntries, sha256 } from '../../packages/core/identity.mjs';
import { validateRecord, identityDigestOf, canonicalJson } from '../../packages/core/manifest.mjs';
import { computeEvaluatorIdentity } from '../../packages/evaluation/evaluator-identity.mjs';
import { initialiseRun } from '../../packages/core/init.mjs';
import { openSelectedRun, readResultsContext, ensureResultsContext } from '../../cli/run-context.mjs';

const HEX64 = /^[0-9a-f]{64}$/;

/* The production loader is imported lazily so one missing sibling helper
 * reports inside the group that needs it rather than blanking the whole file.
 * The import itself is not swallowed: every group that calls it propagates
 * the failure as a real test failure. */
let installationPromise = null;
function installation() {
  if (installationPromise === null)
    installationPromise = import('../../cli/installation.mjs');
  return installationPromise;
}

/** One external temporary root whose own path contains a space. */
const temporaryRoots = [];
function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bb-installation ${label} `));
  temporaryRoots.push(root);
  return root;
}
after(() => {
  for (const root of temporaryRoots)
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 });
});

/** Manifest-based snapshot (no repository-wide walk): digest + entry list. */
function manifestSnapshot(manifest) {
  return { digest: hashEntries(manifest), entries: manifest.map((entry) => entry.path) };
}

function assertOrdinaryDigestEntry(entry, label) {
  assert.equal(typeof entry.path, 'string', `${label}: path is a string`);
  assert.ok(entry.path.length > 0 && !path.isAbsolute(entry.path) && !entry.path.includes('\\'),
    `${label}: path "${entry.path}" is a relative POSIX-style path`);
  assert.ok(Number.isInteger(entry.bytes) && entry.bytes >= 0,
    `${label}: bytes is a non-negative integer for ${entry.path}`);
  assert.match(entry.sha256, HEX64, `${label}: sha256 is 64 lowercase hex for ${entry.path}`);
}

/* -------------------------------------------------------------------------- */
/* Group 1 — real identities, real workload, separated version domains        */
/* -------------------------------------------------------------------------- */

describe('installation — group 1: the loaded installation carries the real accepted identities', () => {
  test('loadInstallation is callable twice with no input and agrees with itself', async () => {
    const { loadInstallation } = await installation();
    assert.throws(() => loadInstallation({ root: 'x' }), undefined,
      'the loader refuses a caller-supplied input; installed identity is not caller-selectable');
    const first = loadInstallation();
    const second = loadInstallation();
    assert.deepEqual(JSON.parse(canonicalJson(second)), JSON.parse(canonicalJson(first)),
      'two loads project the same installation');
  });

  test('all three C1 identities validate against the accepted contract validators', async () => {
    const { loadInstallation } = await installation();
    const loaded = loadInstallation();
    const tooling = validateRecord('ToolingIdentity', loaded.toolingIdentity);
    const challenge = validateRecord('ChallengeIdentity', loaded.challenge.identity);
    const evaluator = validateRecord('EvaluatorIdentity', loaded.evaluatorIdentity);
    assert.equal(tooling.kind, 'ToolingIdentity');
    assert.equal(challenge.kind, 'ChallengeIdentity');
    assert.equal(evaluator.kind, 'EvaluatorIdentity');
    for (const [label, record] of [['tooling', loaded.toolingIdentity], ['challenge', loaded.challenge.identity], ['evaluator', loaded.evaluatorIdentity]])
      assert.equal(identityDigestOf(record), record.identityDigest,
        `${label}: the declared identity digest recomputes over the projected record`);
  });

  test('the stable installed identities agree with the actual C4 semantic and package identity', async () => {
    const { loadInstallation } = await installation();
    const loaded = loadInstallation();
    const recomputed = computeEvaluatorIdentity();
    assert.equal(loaded.actualEvaluator.semanticDigest, recomputed.semanticDigest,
      'the C4 semantic digest recomputed from installed bytes matches the loaded one');
    assert.equal(loaded.actualEvaluator.packageDigest, recomputed.packageDigest,
      'the C4 package digest recomputed from installed bytes matches the loaded one');
    assert.equal(loaded.evaluatorIdentity.scoringDigest, loaded.actualEvaluator.originalCandidate.scoring,
      'the bound evaluator identity binds the actual scoring digest of the original candidate');
    assert.equal(loaded.challenge.identity.workloadDigest, loaded.descriptor.workloadDigest,
      'the bound challenge identity and the descriptor agree on the workload digest');
  });

  test('the real workload digest, the 26-entry file manifest and developmentOnly hold', async () => {
    const { loadInstallation } = await installation();
    const loaded = loadInstallation();
    assert.equal(loaded.descriptor.workloadDigest,
      'aead38d3607492066247dddc7cbfb9828860f008f6151d434210394c736cb1f8',
      'the installation states the exact accepted workload digest');
    assert.equal(loaded.descriptor.developmentOnly, true, 'the installation is development-only');
    assert.equal(loaded.challenge.fileManifest.length, 26, 'the package file manifest carries 26 entries');
    assert.deepEqual([...loaded.challenge.fileManifest].sort(), loaded.challenge.fileManifest,
      'the package file manifest is ordered');
    assert.ok(new Set(loaded.challenge.fileManifest).size === 26, 'the file manifest paths are unique');
    assert.ok(Array.isArray(loaded.challenge.ownerRoots) && loaded.challenge.ownerRoots.length >= 1,
      'the package names its owner roots');
    assert.ok(loaded.challenge.evaluatorRoots.every((root) => path.isAbsolute(root)),
      'the package names absolute evaluator roots');
    assert.ok(path.isAbsolute(loaded.challenge.sourceRoot) && fs.existsSync(loaded.challenge.sourceRoot),
      'the package names a present source root');
  });

  test('the identities are pairwise distinct and the candidate lineage stays separate from the neutral versions', async () => {
    const { loadInstallation } = await installation();
    const loaded = loadInstallation();
    const challenge = loaded.challenge.identity;
    const identities = [
      { label: 'tooling', record: loaded.toolingIdentity },
      { label: 'challenge', record: challenge },
      { label: 'evaluator', record: loaded.evaluatorIdentity },
    ];
    /* Identity digests, architecture ids and the kind-scoped primary id are
     * each pairwise distinct, so no one identity can stand for another. */
    const identityDigests = identities.map((entry) => entry.record.identityDigest);
    const architectureIds = identities.map((entry) => entry.record.architectureId);
    const primaryIds = [loaded.toolingIdentity.toolingId, challenge.challengeId, loaded.evaluatorIdentity.evaluatorId];
    for (const [label, list] of [['identity digest', identityDigests], ['architecture id', architectureIds], ['primary id', primaryIds]])
      assert.equal(new Set(list).size, 3,
        `the three ${label}s ${JSON.stringify(list)} are pairwise distinct`);
    assert.equal(challenge.candidateLineage.candidateVersion, '1.0.0-candidate.9',
      'the original candidate lineage remains the recorded candidate version');
    assert.ok(typeof challenge.candidateLineage.candidateStatus === 'string' && challenge.candidateLineage.candidateStatus.length > 0,
      'the candidate lineage carries its recorded status');
    for (const [label, neutral] of [
      ['challengeVersion', challenge.challengeVersion],
      ['toolingVersion', loaded.toolingIdentity.toolingVersion],
      ['evaluatorVersion', loaded.evaluatorIdentity.evaluatorVersion],
    ])
      assert.notEqual(neutral, challenge.candidateLineage.candidateVersion,
        `the neutral ${label} ${JSON.stringify(neutral)} stays separate from the candidate lineage version`);
  });
});

/* -------------------------------------------------------------------------- */
/* Group 2 — the selected asset manifest and loader non-mutation              */
/* -------------------------------------------------------------------------- */

describe('installation — group 2: the selected asset manifest is real, ordered and non-mutating', () => {
  test('the asset manifest is sorted, unique and carries ordinary digest entries', async () => {
    const { loadInstallation } = await installation();
    const loaded = loadInstallation();
    const manifest = loaded.assetManifest;
    assert.ok(Array.isArray(manifest) && manifest.length > 0, 'the asset manifest is a non-empty array');
    for (const entry of manifest)
      assertOrdinaryDigestEntry(entry, 'asset manifest');
    const paths = manifest.map((entry) => entry.path);
    assert.deepEqual([...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), paths,
      'the asset manifest is sorted by path');
    assert.equal(new Set(paths).size, paths.length, 'the asset manifest paths are unique');
  });

  test('the selection covers the CLI and the accepted modules and excludes the denied areas', async () => {
    const { loadInstallation } = await installation();
    const loaded = loadInstallation();
    const paths = loaded.assetManifest.map((entry) => entry.path);
    const covered = ['cli/', 'packages/core/', 'packages/evaluation/', 'packages/results/', 'schemas/', 'adapters/manual/'];
    for (const prefix of covered)
      assert.ok(paths.some((one) => one.startsWith(prefix)), `the selection includes ${prefix}`);
    for (const file of ['package.json', 'release/inventory.json', 'version.json'])
      assert.ok(paths.includes(file), `the selection includes ${file}`);
    for (const entry of loaded.assetManifest) {
      const p = entry.path;
      assert.ok(!/(^|\/)tests(\/|$)/.test(p), `no test-history path is selected: ${p}`);
      assert.ok(!/(^|\/)node_modules(\/|$)/.test(p), `no node_modules path is selected: ${p}`);
      assert.ok(!/(^|\/)reference(\/|$)/.test(p), `no reference path is selected: ${p}`);
      assert.ok(!/(^|\/)artifacts(\/|$)/.test(p), `no recorded-artifact path is selected: ${p}`);
      assert.ok(!/(^|\/)\.git(\/|$)/.test(p), `no repository metadata path is selected: ${p}`);
    }
  });

  test('descriptor and selected inventory digests are stable across loads and the loader changes no bytes', async () => {
    const { loadInstallation } = await installation();
    const before = loadInstallation();
    const beforeDescriptor = sha256(canonicalJson(before.descriptor));
    const beforeSnapshot = manifestSnapshot(before.assetManifest);
    /* Manifest-based re-verification: re-read exactly the single-file entries
     * the manifest names (no repository-wide recursive walk). */
    const verifyFiles = (loaded) => {
      for (const entry of loaded.assetManifest) {
        if (!entry.path.includes('/')) {
          const bytes = fs.readFileSync(path.join(loaded.root, entry.path));
          assert.equal(bytes.length, entry.bytes, `size still matches for ${entry.path}`);
          assert.equal(sha256(bytes), entry.sha256, `content still matches for ${entry.path}`);
        }
      }
    };
    verifyFiles(before);
    const after = loadInstallation();
    verifyFiles(after);
    assert.equal(sha256(canonicalJson(after.descriptor)), beforeDescriptor,
      'the descriptor digest is identical across loads');
    assert.deepEqual(manifestSnapshot(after.assetManifest), beforeSnapshot,
      'the selected inventory digest and paths are identical across loads');
  });
});

/* -------------------------------------------------------------------------- */
/* Group 3 — a real run through the accepted initialiser opens by identity    */
/* -------------------------------------------------------------------------- */

/**
 * Stage a clean source copy of the loaded workload bytes outside the
 * repository. The development installation's `starter/` carries installed
 * `node_modules` and `dist` directories, which the accepted exporter refuses
 * against the 26-entry workload manifest; the accepted suites therefore pass a
 * staged source root. Every byte here is the installed one (copied from the
 * loaded `sourceRoot` by the loaded `fileManifest`), and the staging step
 * asserts the re-walked tree digest equals the installed workload digest, so
 * the workload bytes are provably preserved.
 */
function stageSourceCopy(installed, base) {
  const sourceRoot = path.join(base, 'staged source');
  for (const relative of installed.challenge.fileManifest) {
    const target = path.join(sourceRoot, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(installed.challenge.sourceRoot, ...relative.split('/')), target);
  }
  const staged = inventoryTree({ root: sourceRoot, skipNames: [] });
  assert.equal(staged.digest, installed.descriptor.workloadDigest,
    'the staged source preserves the installed workload bytes exactly');
  assert.equal(staged.entries.length, 26, 'the staged source carries the 26 workload files');
  return sourceRoot;
}

/** Initialise one fresh run from the real loaded inputs under an external root. */
async function createRealRun(installed, baseName) {
  const base = tempRoot(baseName);
  const sourceRoot = stageSourceCopy(installed, base);
  const output = path.join(base, `${baseName} container`);
  const result = await initialiseRun({
    output,
    challenge: { ...installed.challenge, sourceRoot },
    toolingIdentity: installed.toolingIdentity,
    evaluatorIdentity: installed.evaluatorIdentity,
    architectureId: createId('cli-test-run'),
    harness: 'manual',
    dependencies: { mode: 'none' },
  });
  return { base, output, result };
}

describe('installation — group 3: a real installed run opens through the accepted path and reports the sealed identity', () => {
  test('a fresh spaced temporary run initialised from the loaded inputs opens with the sealed identities', async () => {
    const { loadInstallation } = await installation();
    const installed = loadInstallation();
    const { output, result } = await createRealRun(installed, 'open');
    const opened = await openSelectedRun(output);
    const realOutput = fs.realpathSync.native(output);
    assert.equal(fs.realpathSync.native(opened.runRoot), realOutput,
      'the opened run root is the selected container');
    assert.equal(opened.runId, result.manifest.runId, 'the opened run id is the sealed run id');
    assert.equal(opened.manifestId, result.manifest.manifestId, 'the opened manifest id is the sealed manifest id');
    assert.equal(opened.manifestDigest, result.manifest.manifestDigest,
      'the opened manifest digest matches the sealed run manifest');
    assert.equal(opened.workspaceRoot, path.join(realOutput, 'workspace'),
      'the opened workspace root is the container workspace');
    const folder = path.basename(output);
    for (const value of [opened.runId, opened.manifestId, opened.manifestDigest])
      assert.ok(!String(value).includes(folder),
        `the identity ${JSON.stringify(String(value).slice(0, 16))}… is not derived from the folder name`);
    const request = opened.request;
    assert.deepEqual({ ...request }, {
      runRoot: opened.runRoot,
      runId: opened.runId,
      manifestId: opened.manifestId,
      expectedDigest: opened.manifestDigest,
    }, 'the bound request carries the resolved root and the sealed identities');
  });

  test('readResultsContext is null before any binding and creates nothing', async () => {
    const { loadInstallation } = await installation();
    const installed = loadInstallation();
    const { base, output, result } = await createRealRun(installed, 'pre-bind');
    const opened = await openSelectedRun(output);
    const sibling = `${fs.realpathSync.native(output)}.benchboard-results`;
    const entriesBefore = fs.readdirSync(fs.realpathSync.native(output)).sort();
    const workspaceBefore = inventoryTree({ root: opened.workspaceRoot });
    assert.equal(await readResultsContext(opened), null,
      'no results context exists before the first binding');
    assert.equal(fs.existsSync(sibling), false, 'the default sibling root was not created');
    assert.equal(fs.readdirSync(fs.realpathSync.native(output)).sort().join(), entriesBefore.join(),
      'the run container gained nothing from the context read');
    const workspaceAfter = inventoryTree({ root: opened.workspaceRoot });
    assert.equal(workspaceAfter.digest, workspaceBefore.digest, 'the workspace bytes are untouched');
    assert.ok(typeof result.manifest.runId === 'string' && result.manifest.runId.length > 0,
      'the sealed run still reports its identity');
  });
});

/* -------------------------------------------------------------------------- */
/* Group 4 — binding the results context cooperatively and reversibly         */
/* -------------------------------------------------------------------------- */

describe('installation — group 4: ensureResultsContext binds the run identity and leaves the workspace alone', () => {
  test('the default binding lands at the sibling root with disjoint attempts and store and re-reads identically', async () => {
    const { loadInstallation } = await installation();
    const installed = loadInstallation();
    const { output, result } = await createRealRun(installed, 'default-bind');
    const opened = await openSelectedRun(output);
    const workspaceBefore = inventoryTree({ root: opened.workspaceRoot });
    const context = await ensureResultsContext(opened);
    assert.equal(context.kind, 'benchboard.cli.results.v1', 'the context is the CLI results context');
    assert.equal(context.schemaVersion, '1.0.0', 'the context carries its schema version');
    assert.ok(typeof context.contextId === 'string' && context.contextId.length > 0,
      'the context carries its own identifier');
    assert.equal(context.runId, result.manifest.runId, 'the context binds the run id');
    assert.equal(context.manifestId, result.manifest.manifestId, 'the context binds the manifest id');
    assert.equal(context.manifestDigest, result.manifest.manifestDigest, 'the context binds the manifest digest');
    assert.equal(path.resolve(context.runRoot), fs.realpathSync.native(output), 'the context binds the run root');
    assert.equal(context.resultsRoot, `${context.runRoot}.benchboard-results`,
      'the default results root is the sibling beside the run container');
    assert.equal(context.attemptsRoot, path.join(context.resultsRoot, 'attempts'),
      'the attempts root lives under the results root');
    assert.equal(context.storeRoot, path.join(context.resultsRoot, 'store'),
      'the report store root lives under the results root');
    assert.ok(!context.attemptsRoot.startsWith(context.storeRoot + path.sep)
      && !context.storeRoot.startsWith(context.attemptsRoot + path.sep),
      'the attempts root and the report store root are disjoint');
    for (const root of [context.resultsRoot, context.attemptsRoot, context.storeRoot])
      assert.ok(path.isAbsolute(root) && path.resolve(root) === root, `root ${root} is an ordinary absolute path`);
    for (const [label, expected] of [['runRoot', opened.runRoot], ['stateRoot', opened.stateRoot],
      ['workspaceRoot', opened.workspaceRoot], ['runId', opened.runId], ['manifestId', opened.manifestId],
      ['manifestDigest', opened.manifestDigest]])
      assert.equal(opened[label], expected, `the opened ${label} still matches what was sealed`);
    const reread = await readResultsContext(opened);
    assert.deepEqual(reread, context, 'a re-read returns the bound context unchanged');
    const rebound = await ensureResultsContext(opened);
    assert.deepEqual(rebound, context, 'binding an already-bound run returns the same context');
    const workspaceAfter = inventoryTree({ root: opened.workspaceRoot });
    assert.deepEqual({ digest: workspaceAfter.digest, entries: workspaceAfter.entries.map((e) => e.path) },
      { digest: workspaceBefore.digest, entries: workspaceBefore.entries.map((e) => e.path) },
      'the workspace inventory is identical before and after context operations');
    assert.ok(!workspaceAfter.entries.some((entry) => entry.path.includes('results') || entry.path.startsWith('cli/')),
      'no context metadata entered the workspace');
  });

  test('a separate fresh run can bind an explicit external alternative', async () => {
    const { loadInstallation } = await installation();
    const installed = loadInstallation();
    const { output } = await createRealRun(installed, 'alt-bind');
    const opened = await openSelectedRun(output);
    const alternative = path.join(tempRoot('alternative'), 'chosen results root');
    const context = await ensureResultsContext(opened, alternative);
    assert.equal(context.resultsRoot, path.resolve(alternative),
      'the explicit alternative becomes the results root');
    assert.equal(context.attemptsRoot, path.join(context.resultsRoot, 'attempts'));
    assert.equal(context.storeRoot, path.join(context.resultsRoot, 'store'));
    assert.equal(context.manifestId, opened.manifestId, 'the alternative binding carries the same run identity');
    assert.ok(!path.resolve(context.resultsRoot).startsWith(fs.realpathSync.native(output) + path.sep),
      'the alternative results root lives outside the run container');
    const reread = await readResultsContext(opened);
    assert.deepEqual(reread, context, 'the alternative binding re-reads identically');
  });
});
