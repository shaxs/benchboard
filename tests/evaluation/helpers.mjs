// C4.S1.T4a shared acceptance-test helpers (sole helper owner).
//
// These helpers build FRESH C3 runs and frozen snapshots in external temporary
// directories from the canonical starter bytes, provide test-owned canonical
// tooling and prepared-dependency roots, and expose a mutable test-only
// runtime descriptor (fake runProcess, controlled no-browser preflight and fake
// stage collaborators) accepted by the internal controller. They never launch
// Chromium or a server, never import the real process implementation and never
// read or override a browser cache. Expected grades belong to the acceptance
// tests, never hidden in fixture construction.
//
// Public API (Captain-fixed before dispatch):
//   await createFrozenFixture(t, options = {})
//   snapshotInputs(fixture)
//   assertInputsUnchanged(fixture, before)
//
// The returned fixture exposes {root, run, frozen, request, canonicalRoot,
// dependencyRoot, runtime, events} (plus contexts and variant for probes).
// `request` matches the accepted public EvaluationRequest: outputRoot outside
// the run container and the repository, expectedDigest the C3 MANIFEST digest.
// The challenge binding stays the original starter challenge identity even when
// the reference variant replaced the live workspace source before the freeze.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { initialiseRun } from '../../packages/core/init.mjs';
import { freezeRun } from '../../packages/core/freeze.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { loadFixture } from '../contracts/fixtures/contracts/index.mjs';
import { OWNER_ROOT } from '../../packages/evaluation/staging.mjs';
import { stageSuccess } from '../../packages/evaluation/contracts.mjs';

const PARTICIPANT_PATHS = JSON.parse(fs.readFileSync(new URL('../../release/inventory.json', import.meta.url), 'utf8')).participant.files.map(entry => entry.path);

const CANONICAL_CONTENT = Object.freeze({
  'package.json': '{"name":"controlled-canonical-tooling","type":"module"}',
  'package-lock.json': '{"lockfileVersion":3,"packages":{}}',
  'tsconfig.json': '{}',
  'vite.config.ts': 'export default {};',
  'tests/contracts.test.tsx': '// canonical visible test fixture\n',
  'tests/setup.ts': '// canonical setup fixture\n',
});

// Tiny prepared tool placeholders only: staging requires these three entrypoint
// files inside the prepared-dependency root. They are never a real toolchain
// and never launched by these helpers.
const PREPARED_TOOL_CONTENT = Object.freeze({
  'typescript/bin/tsc': '// prepared typecheck placeholder\n',
  'vite/bin/vite.js': '// prepared build placeholder\n',
  'vitest/vitest.mjs': '// prepared visible-test placeholder\n',
});

const VISIBLE_REPORT = Object.freeze({ numPassedTests: 17, numTotalTests: 17 });

function put(base, name, bytes) {
  const to = path.join(base, name);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, bytes);
}

// Fake plain-tool runner matching the accepted T1 result shape. It writes the
// bounded visible report where the invocation requested, records logs at the
// requested paths, and never spawns anything.
async function fakeRunProcess(request) {
  if (!request || typeof request !== 'object') throw new TypeError('fake runProcess requires a request object');
  for (const key of ['executable', 'cwd', 'stdoutLog', 'stderrLog']) {
    if (typeof request[key] !== 'string' || !path.isAbsolute(request[key])) throw new TypeError('fake runProcess requires absolute ' + key);
  }
  if (!Array.isArray(request.args) || request.args.some(a => typeof a !== 'string')) throw new TypeError('fake runProcess requires string args');
  for (const log of [request.stdoutLog, request.stderrLog]) {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, 'fake tool log for ' + path.basename(log));
  }
  const outputFile = (request.args ?? []).find(arg => arg.startsWith('--outputFile='));
  if (outputFile !== undefined) {
    const target = outputFile.slice('--outputFile='.length);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(VISIBLE_REPORT));
  }
  return { status: 'completed', exitCode: 0, signal: null, stdout: 'fake tool stdout', stderr: '', stdoutLog: request.stdoutLog, stderrLog: request.stderrLog };
}

// The 25 valid hidden-property IDs and areas, declared exactly as the accepted
// hidden property list names them; no invented record is ever generated.
function twentyFiveProperties() {
  const properties = [];
  for (const [prefix, area, count] of [['F', 'functional', 13], ['P', 'persistence', 4], ['E', 'edge', 4], ['I', 'integration', 4]]) {
    for (let index = 1; index <= count; index++) properties.push({ id: prefix + String(index).padStart(2, '0'), area, passed: true });
  }
  return properties;
}

/**
 * Build one fresh frozen evaluation fixture in an external temporary directory.
 *
 * `options.variant` is 'starter' (default) or 'reference'. The reference variant
 * replaces only the test-owned live workspace source with a fresh reference
 * source copy BEFORE the freeze (the copy omits node_modules, dist and VCS as
 * documented), so the frozen snapshot carries reference bytes while the sealed
 * challenge binding stays the original starter challenge. `options.mutateWorkspace(workspaceRoot)`
 * runs BEFORE the freeze on the live workspace only, never on a saved snapshot.
 */
export async function createFrozenFixture(t, options = {}) {
  if (Object.keys(options).some(key => !['variant', 'mutateWorkspace'].includes(key))) throw new TypeError('Unknown createFrozenFixture option');
  const variant = options.variant ?? 'starter';
  if (!['starter', 'reference'].includes(variant)) throw new TypeError('createFrozenFixture variant must be starter or reference');
  if (options.mutateWorkspace !== undefined && typeof options.mutateWorkspace !== 'function') throw new TypeError('createFrozenFixture mutateWorkspace must be a function');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-eval-t4a-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const sourceRoot = path.join(root, 'source');
  for (const name of PARTICIPANT_PATHS) put(sourceRoot, name, fs.readFileSync(path.join(OWNER_ROOT, 'starter', name)));

  const challenge = structuredClone(loadFixture('challenge.identity'));
  const source = inventoryTree({ root: sourceRoot, skipNames: [] });
  challenge.starterInventory = source.entries.map(entry => [entry.path, entry.sha256]);
  challenge.workloadDigest = source.digest;
  const evaluator = structuredClone(loadFixture('evaluator.identity'));

  const run = await initialiseRun({
    output: path.join(root, 'run'),
    challenge: { identity: challenge, sourceRoot, fileManifest: PARTICIPANT_PATHS, ownerRoots: [OWNER_ROOT], evaluatorRoots: [path.join(OWNER_ROOT, 'evaluator')] },
    toolingIdentity: structuredClone(loadFixture('tooling.identity')),
    evaluatorIdentity: evaluator,
    architectureId: 't4a-fixture-run',
    harness: 'manual',
    dependencies: { mode: 'none' },
  });

  if (variant === 'reference') {
    for (const name of PARTICIPANT_PATHS) {
      const reference = path.join(OWNER_ROOT, 'reference', name);
      if (fs.existsSync(reference)) fs.copyFileSync(reference, path.join(run.workspace.root, name));
    }
  }
  if (options.mutateWorkspace !== undefined) await options.mutateWorkspace(run.workspace.root);

  const frozen = await freezeRun({
    runRoot: run.output, runId: run.manifest.runId, manifestId: run.manifest.manifestId, clockless: true,
    attestation: { operator: 'test-operator', agentStopped: true, statement: 'Controlled T4a fixture is stopped.', clockless: true },
  });

  const canonicalRoot = path.join(root, 'canonical');
  for (const [name, content] of Object.entries(CANONICAL_CONTENT)) put(canonicalRoot, name, content);
  const dependencyRoot = path.join(root, 'prepared-dependencies');
  for (const [name, content] of Object.entries(PREPARED_TOOL_CONTENT)) put(dependencyRoot, name, content);

  const values = {
    typecheck: true,
    build: true,
    visible: { passed: 17, total: 17, reportPath: 'controlled' },
    browser: twentyFiveProperties(),
    useful: {
      addedCount: 0, baselinePassed: false, killedMutations: [],
      method: 'Five independent fault domains: persistence, interaction, accessibility, normalization, chronology; added tests alone; no test-count reward',
    },
    // The inspection fake only records its frozen-original context; T6b supplies
    // the real inspection witness. Nothing here claims inspectPublic physically ran.
    inspection: {
      noSuppression: true,
      hygiene: { visibleIntact: true, lockedDependencies: true, noSecrets: true, noDebugLogging: true, noNetwork: true },
      analysisMethod: 'controlled inspection fixture (does not physically run inspectPublic)',
    },
  };

  const events = [], contexts = [];
  const stageOverrides = Object.fromEntries(Object.entries(values).map(([stage, value]) => [stage, async context => {
    contexts.push({ stage, ...context });
    fs.writeFileSync(path.join(context.artifactRoot, 'stdout.log'), stage + ' controlled diagnostic');
    return stageSuccess(stage, value);
  }]));

  const request = {
    challenge, evaluator,
    outputRoot: path.join(root, 'evaluation'),
    submission: {
      runRoot: run.output, runId: run.manifest.runId, manifestId: run.manifest.manifestId,
      expectedDigest: run.manifest.manifestDigest,
      snapshotId: frozen.snapshotId,
      frozenSubmissionId: frozen.frozenSubmission.frozenSubmissionId,
    },
  };

  const runtime = {
    canonicalRoot, dependencyRoot,
    runProcess: fakeRunProcess,
    preflight: async () => {},
    stageOverrides,
    onEvent: (name, facts) => events.push({ name, facts }),
  };

  return { root, run, frozen, request, canonicalRoot, dependencyRoot, runtime, events, contexts, variant };
}

/** Byte-tree digests of the two input domains the acceptance tests protect. */
export function snapshotInputs(fixture) {
  return Object.freeze({
    frozen: inventoryTree({ root: fixture.frozen.snapshotRoot, skipNames: [] }).digest,
    workspace: inventoryTree({ root: fixture.run.workspace.root, skipNames: [] }).digest,
  });
}

/** Recompute exactly the two domains snapshotInputs measured and prove both. */
export function assertInputsUnchanged(fixture, before) {
  assert.deepEqual(snapshotInputs(fixture), before, 'frozen snapshot and live workspace bytes must not change');
}
