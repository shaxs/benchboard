// C4.S3.T1 parity-only fixture helpers (owned by parity.suite.mjs and
// parity-selection.test.mjs; sole consumers). Repaired under C4.S3.R1.H.
//
// This file mirrors the accepted S1 helper API patterns (createFrozenFixture /
// snapshotInputs / assertInputsUnchanged) without editing that shared helper: the accepted
// helper's 26-file 'reference' variant replaces only release-inventory paths and therefore
// carries no participant additions such as reference/tests/regressions.test.tsx, so it cannot
// observe the recorded 8 added tests / 5 killed mutations. Full recorded-result parity needs a
// COMPLETE fresh ordinary source selection copied into the live workspace BEFORE the freeze
// while the sealed challenge binding stays the original starter challenge identity built through
// the existing contract fixtures binding API. Prepared starter node_modules are bound only by the
// production facade's default canonical/dependency roots; nothing here copies or installs
// dependencies.
//
// C4.S3.R1.H selection fidelity (Captain-fixed acceptance):
//   - The source selection mirrors the frozen C3 policy EXACTLY: the exclusion set is the exact
//     TOP-LEVEL (immediate child of the selection root) names imported from
//     packages/core/snapshot-copy.mjs (SELECTION_POLICY_EXCLUSIONS), byte-compared, never an
//     any-depth skip. A nested src/dist, vendor/.git or nested node_modules is therefore RETAINED
//     in the selected view, and a top-level entry whose spelling differs from an exclusion only by
//     case (e.g. 'Dist') is RETAINED, exactly as the copier retains it.
//   - Separately and disclosedly, a top-level '.owner-fixture.json' is excluded ONLY as owner
//     fixture metadata (it is not participant content and is NOT part of the C3 participant/
//     selection policy). It is never folded into the policy import.
//   - The selection is a sorted full {path, bytes, sha256} inventory of the ACTUAL selected raw
//     source bytes plus the legacy hashEntries pair digest (identity.mjs) — not a path-name list.
//   - After the overlay and before the freeze the live workspace is asserted to equal the
//     selection exactly (paths, entries, digest); a surviving starter-only leftover fails the
//     fixture (the residual export paths are removed explicitly and disclosed, never silently
//     kept, and no expected source tree is ever altered). After the freeze the snapshot's sorted
//     paths, full inventory and digest are asserted to equal the selected source exactly, and the
//     selected source is re-measured to prove the protected originals are unchanged.
//   - The selection object is returned on the fixture for the Captain's independent assertions.
//
// The supported public facade (evaluateFrozen) is called only by parity.suite.mjs, never from here.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { initialiseRun } from '../../packages/core/init.mjs';
import { freezeRun } from '../../packages/core/freeze.mjs';
import { hashEntries, inventoryTree, sha256 } from '../../packages/core/identity.mjs';
import { SELECTION_POLICY_EXCLUSIONS } from '../../packages/core/snapshot-copy.mjs';
import { loadFixture } from '../contracts/fixtures/contracts/index.mjs';
import { OWNER_ROOT } from '../../packages/evaluation/staging.mjs';

export const PARTICIPANT_PATHS = JSON.parse(fs.readFileSync(new URL('../../release/inventory.json', import.meta.url), 'utf8')).participant.files.map(entry => entry.path);

// The frozen C3 selection policy's exclusion names, imported — never copied — from the accepted
// copier (packages/core/snapshot-copy.mjs). These are EXACT top-level basenames, matched
// byte-for-byte with no case/Unicode folding, exactly as scanAndSelect matches them. NO any-depth
// skipping here: a nested name equal to an exclusion is part of the selected application content.
const TOP_LEVEL_EXCLUSIONS = new Set(SELECTION_POLICY_EXCLUSIONS);

// Disclosed separate exclusion, NOT part of the C3 selection policy: the owner fixture marker,
// which is owner fixture metadata rather than participant content. Top-level only, byte-exact.
const OWNER_FIXTURE_MARKER = '.owner-fixture.json';

function put(base, name, bytes) {
  const to = path.join(base, name);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, bytes);
}

// Recursive list of ordinary files under root under the EXACT top-level policy above; every entry
// must be an ordinary file (links and special files refuse the whole selection), matching the
// freeze copier's expectations. Only the root's immediate children are tested against the policy
// names, so nested lookalikes survive into the selection exactly as the copier keeps them.
function listOrdinaryFiles(root) {
  const found = [];
  (function walk(at, isTop) {
    for (const name of fs.readdirSync(at).sort()) {
      if (isTop && (TOP_LEVEL_EXCLUSIONS.has(name) || name === OWNER_FIXTURE_MARKER)) continue;
      const full = path.join(at, name);
      const stat = fs.lstatSync(full);
      assert.ok(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), 'source selection must contain only ordinary files and directories: ' + full);
      assert.ok(stat.isDirectory() || stat.isFile(), 'special file in source selection: ' + full);
      if (stat.isDirectory()) walk(full, false);
      else found.push(path.relative(root, full).replaceAll('\\', '/'));
    }
  })(root, true);
  return found;
}

// Sorted full {path, bytes, sha256} inventory over the ACTUAL raw bytes at the listed relative
// paths, plus the legacy [path, sha256] pair digest. Byte-level: changing one selected byte
// changes the digest.
function inventoryOfSelection(sourceRoot, files) {
  const entries = [...files].sort().map(relative => {
    const bytes = fs.readFileSync(path.join(sourceRoot, ...relative.split('/')));
    return Object.freeze({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
  });
  return Object.freeze({
    entries: Object.freeze(entries),
    digest: hashEntries(entries.map(entry => ({ path: entry.path, sha256: entry.sha256 }))),
  });
}

/**
 * A complete fresh ordinary source selection under the exact frozen C3 policy: every file of
 * `sourceRoot` except the EXACT top-level SELECTION_POLICY_EXCLUSIONS names (nested lookalikes
 * retained) and except the top-level owner fixture marker (disclosed separately), including
 * participant additions absent from the release inventory (such as
 * reference/tests/regressions.test.tsx), as a sorted full byte inventory with the legacy digest,
 * and refusing an empty or degenerate selection.
 */
export function sourceSelection(sourceRoot) {
  assert.ok(fs.existsSync(sourceRoot) && fs.statSync(sourceRoot).isDirectory(), 'source selection root must be an existing directory: ' + sourceRoot);
  const files = listOrdinaryFiles(sourceRoot);
  assert.ok(files.length >= 20, 'source selection must be a complete application tree, got ' + files.length + ' files');
  assert.ok(files.filter(f => !f.includes('/')).length >= 5, 'source selection must carry complete top-level application files');
  assert.ok(files.includes('tests/contracts.test.tsx'), 'source selection must include the canonical visible test');
  assert.ok(files.includes('index.html') && files.includes('src/main.tsx'), 'source selection must include the application entry files');
  const inventory = inventoryOfSelection(sourceRoot, files);
  return Object.freeze({
    sourceRoot,
    files: Object.freeze([...files].sort()),
    entries: inventory.entries,
    digest: inventory.digest,
    // Exact top-level exclusions imported from the accepted copier; disclosed separately.
    exclusions: Object.freeze([...SELECTION_POLICY_EXCLUSIONS]),
    ownerFixtureMarker: OWNER_FIXTURE_MARKER,
  });
}

export const SOURCE_TREES = Object.freeze({
  starter: path.join(OWNER_ROOT, 'starter'),
  reference: path.join(OWNER_ROOT, 'reference'),
  broken: path.join(OWNER_ROOT, 'artifacts', 'broken-source'),
});

// Sorted full {path, bytes, sha256} inventory + legacy digest of a physical tree, measured the
// same way the selection is measured so the two compare entry-for-entry.
function measureTree(root) {
  const tree = inventoryTree({ root, skipNames: [] });
  return Object.freeze({
    entries: Object.freeze(tree.entries.map(entry => Object.freeze({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }))),
    digest: tree.digest,
  });
}

function entriesAsKey(entries) {
  return entries.map(entry => [entry.path, entry.bytes, entry.sha256]);
}

/**
 * One fresh frozen C3 publication in an external exclusively-new temporary root:
 * canonical 26-file starter bytes, the original starter challenge identity through the existing
 * binding API, then the complete source selection replaced into the LIVE workspace BEFORE the
 * clockless freeze (so the frozen snapshot carries full participant bytes while the sealed
 * challenge binding is unchanged). Between overlay and freeze the workspace must equal the
 * selection exactly; any surviving starter-only leftover fails the fixture. After the freeze the
 * snapshot must equal the selected source exactly and the selected source is re-measured to
 * prove the protected originals unchanged. `outputLabel` distinguishes the distinct exclusively-new
 * evaluation output of a repeat run over the SAME frozen publication.
 */
export async function createParityFixture(t, { sourceTree, outputLabel = 'evaluation', retain = { failed: false } }) {
  assert.ok(SOURCE_TREES[sourceTree], 'unknown parity source tree: ' + sourceTree);
  assert.ok(retain && typeof retain.failed === 'boolean', 'retain must be a {failed} token');
  const selection = sourceSelection(SOURCE_TREES[sourceTree]);
  if (sourceTree === 'reference') assert.ok(selection.files.includes('tests/regressions.test.tsx'), 'the reference selection must include the participant addition tests/regressions.test.tsx');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-parity-'));
  // Ordinary success retires the fixture normally; a failure preserves it as the owned external
  // diagnostic root (packet: never delete failure evidence).
  t.after(() => {
    if (retain.failed) console.log('preserved diagnostic fixture root:', root);
    else fs.rmSync(root, { recursive: true, force: true });
  });

  // The run is initialised from canonical starter bytes only (mode none: nothing installed).
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
    architectureId: 's3-parity-run',
    harness: 'manual',
    dependencies: { mode: 'none' },
  });

  // BEFORE the freeze: replace workspace bytes with the complete fresh ordinary selection,
  // including additions outside the release inventory. The frozen selection excludes the same
  // EXACT top-level names, so the snapshot never carries a dependency, build or VCS tree.
  for (const relative of selection.files) {
    const to = path.join(run.workspace.root, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(selection.sourceRoot, relative), to);
  }

  // The canonical starter export may carry a path the fresh selection does not carry (for example
  // the reference tree has no .dockerignore). Such a residual is removed only when it is PROVEN to
  // be exactly the canonical starter byte at that path (a disclosed stale export byte, never
  // expected source — no protected tree is touched); any other starter-only leftover — bytes that
  // differ from the canonical export or a path the export never carried — MUST fail here rather
  // than freeze silently. The equality gates below then prove nothing else survived.
  const afterOverlay = measureTree(run.workspace.root);
  const selectedPaths = new Set(selection.files);
  const residual = afterOverlay.entries.filter(entry => !selectedPaths.has(entry.path));
  for (const entry of residual) {
    const canonicalPath = path.join(OWNER_ROOT, 'starter', ...entry.path.split('/'));
    const canonicalBytes = fs.existsSync(canonicalPath) ? fs.readFileSync(canonicalPath) : null;
    assert.ok(canonicalBytes !== null && sha256(canonicalBytes) === entry.sha256,
      sourceTree + ': starter-only leftover in the live workspace after the overlay must fail: ' + entry.path);
  }
  if (residual.length > 0) {
    console.log(sourceTree + ' overlay removed stale canonical-export workspace paths: ' + JSON.stringify(residual.map(entry => entry.path)));
    for (const entry of residual) fs.rmSync(path.join(run.workspace.root, ...entry.path.split('/')));
  }

  // Live workspace === selection, exactly: paths, full byte entries and the legacy digest.
  const workspace = measureTree(run.workspace.root);
  assert.deepEqual(entriesAsKey(workspace.entries), entriesAsKey(selection.entries), sourceTree + ': live workspace entries after the overlay must equal the selected source entries exactly');
  assert.equal(workspace.digest, selection.digest, sourceTree + ': live workspace digest after the overlay must equal the selected source digest');

  const frozen = await freezeRun({
    runRoot: run.output, runId: run.manifest.runId, manifestId: run.manifest.manifestId, clockless: true,
    attestation: { operator: 'test-operator', agentStopped: true, statement: 'Controlled S3 parity fixture is stopped.', clockless: true },
  });

  // AFTER the freeze: the snapshot's sorted paths, full inventory and digest equal the selected
  // source exactly (the snapshot root is the copied-workspace subdirectory of the container).
  const snapshot = measureTree(frozen.snapshotRoot);
  assert.deepEqual(snapshot.entries.map(entry => entry.path), [...selection.files].sort(), sourceTree + ': frozen snapshot paths must equal the selected source paths exactly');
  assert.deepEqual(entriesAsKey(snapshot.entries), entriesAsKey(selection.entries), sourceTree + ': frozen snapshot byte entries must equal the selected source entries exactly');
  assert.equal(snapshot.digest, selection.digest, sourceTree + ': frozen snapshot digest must equal the selected source digest');

  // Remeasure the selected source after the copy and freeze: the protected originals are
  // unchanged and the selection digest was a function of real bytes, not of names.
  const remeasured = sourceSelection(selection.sourceRoot);
  assert.deepEqual(entriesAsKey(remeasured.entries), entriesAsKey(selection.entries), sourceTree + ': the selected source bytes must be unchanged after the copy and freeze');
  assert.equal(remeasured.digest, selection.digest, sourceTree + ': the selected source digest must be unchanged after the copy and freeze');

  // Console one per variant (packet C4.S3.R1.H): counts, the three digests, the exclusions and the
  // full selection paths (the source trees carry no top-level exclusion names; the broken variant
  // additionally carries the exact owner-marker exclusion note).
  console.log(sourceTree + ' selection fidelity:', JSON.stringify({
    selectedCount: selection.files.length,
    selectedDigest: selection.digest,
    workspaceDigest: workspace.digest,
    frozenDigest: snapshot.digest,
    exclusions: selection.exclusions,
    ownerFixtureMarkerExcluded: fs.existsSync(path.join(selection.sourceRoot, OWNER_FIXTURE_MARKER)) ? ('top-level ' + OWNER_FIXTURE_MARKER + ' excluded as owner fixture metadata only') : null,
    selectionPaths: selection.files,
  }));

  const request = {
    challenge, evaluator,
    outputRoot: path.join(root, outputLabel),
    submission: {
      runRoot: run.output, runId: run.manifest.runId, manifestId: run.manifest.manifestId,
      expectedDigest: run.manifest.manifestDigest,
      snapshotId: frozen.snapshotId,
      frozenSubmissionId: frozen.frozenSubmission.frozenSubmissionId,
    },
  };
  return { root, run, frozen, request, selection, sourceTree };
}

/** Byte-tree digests of the two run domains the parity test protects. */
export function paritySnapshotInputs(fixture) {
  return Object.freeze({
    frozen: inventoryTree({ root: fixture.frozen.snapshotRoot, skipNames: [] }).digest,
    workspace: inventoryTree({ root: fixture.run.workspace.root, skipNames: [] }).digest,
  });
}

/** Recompute exactly the two domains paritySnapshotInputs measured and prove both. */
export function assertParityInputsUnchanged(fixture, before) {
  assert.deepEqual(paritySnapshotInputs(fixture), before, 'frozen snapshot and live workspace bytes must not change');
}

/** Byte-tree digest of one protected repository domain (protected trees are read-only). */
export function domainDigest(root, options = {}) {
  return inventoryTree({ root, ...options }).digest;
}
