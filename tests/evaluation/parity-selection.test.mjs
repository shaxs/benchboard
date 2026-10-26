// C4.S3.R1.H — fast source/frozen selection-fidelity proof (no evaluateFrozen, no child
// processes, no tools, no browser/server, no installs).
//
// Part 1 builds REAL C3 parity fixtures for all three variants (starter, reference, broken)
// through the repaired helper and asserts, for each:
//   - binding: the sealed challenge identity is the original canonical starter identity (the
//     exact 26 canonical release paths with the raw starter bytes' sha256, and the matching
//     legacy workload digest) for every variant;
//   - source: the helper-returned selection carries the exact imported top-level exclusions,
//     26 selected paths per variant, and a full {path,bytes,sha256} inventory whose digest is
//     recomputed here independently from the protected source bytes;
//   - frozen: the live workspace digest and the frozen snapshot's sorted paths, full byte
//     inventory entries and digest equal the selected source exactly (Captain-side independent
//     recomputation from fixture.selection plus a fresh measure of the snapshot and workspace).
// Part 2 proves the selection rules on synthetic trees built from a copy of the canonical 26:
//   - exact top-level policy exclusions and the metadata-only root owner marker are dropped;
//   - nested lookalikes (src/dist, vendor/.git, nested node_modules) and top-level case variants
//     and other dotfiles are RETAINED (no any-depth skipping);
//   - the selection digest is a function of the selected RAW BYTES: one changed selected byte
//     changes it, while a changed byte under an excluded top-level tree does not.
// Every test root is an exclusively-new temporary directory; on failure it is preserved (never
// deleted) and the protected source trees are proven byte-unchanged afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hashEntries, sha256 } from '../../packages/core/identity.mjs';
import { SELECTION_POLICY_EXCLUSIONS } from '../../packages/core/snapshot-copy.mjs';
import { OWNER_ROOT } from '../../packages/evaluation/staging.mjs';
import { createParityFixture, sourceSelection, domainDigest, PARTICIPANT_PATHS } from './parity-fixtures.mjs';
import { ownerEvidenceOption } from '../owner-evidence.mjs';

// Independent recomputation of the exact selection semantics under test (byte-exact top-level
// policy match; nested lookalikes retained), so the proof never trusts only the helper's walk.
function independentSelectionPaths(root) {
  const top = new Set(fs.readdirSync(root));
  const excludedTop = new Set([...SELECTION_POLICY_EXCLUSIONS, '.owner-fixture.json']);
  const found = [];
  (function walk(at, isTop) {
    for (const name of fs.readdirSync(at)) {
      if (isTop && excludedTop.has(name)) continue;
      const full = path.join(at, name);
      if (fs.lstatSync(full).isDirectory()) walk(full, false);
      else found.push(path.relative(root, full).replaceAll('\\', '/'));
    }
  })(root, true);
  void top;
  return found.sort();
}

// Digest of the selection computed here, from raw bytes at the given relative paths.
function digestOfPaths(root, files) {
  return hashEntries([...files].sort().map(p => ({ path: p, sha256: sha256(fs.readFileSync(path.join(root, ...p.split('/')))) })));
}

// The three protected source trees, proven read-only across the whole test.
const PROTECTED = Object.freeze({
  starter: path.join(OWNER_ROOT, 'starter'),
  reference: path.join(OWNER_ROOT, 'reference'),
  brokenSource: path.join(OWNER_ROOT, 'artifacts', 'broken-source'),
});

test('C4.S3.R1.H real C3 fixtures: binding, source selection and frozen snapshot are byte-faithful', { timeout: 240000, ...ownerEvidenceOption('artifacts/broken-source') }, async t => {
  const retain = { failed: false };
  const protectedBefore = Object.fromEntries(Object.entries(PROTECTED).map(([k, r]) => [k, domainDigest(r)]));
  try {
    // The canonical starter identity every variant's binding must carry (part 1 "binding").
    const canonicalPaths = [...PARTICIPANT_PATHS].sort();
    const canonicalPairs = canonicalPaths.map(p => ({ path: p, sha256: sha256(fs.readFileSync(path.join(PROTECTED.starter, ...p.split('/')))) }));
    const canonicalDigest = hashEntries(canonicalPairs);

    for (const sourceTree of ['starter', 'reference', 'broken']) {
      const fixture = await createParityFixture(t, { sourceTree, outputLabel: 'evaluation', retain });

      // --- binding: the sealed challenge identity is the original canonical starter identity ---
      assert.deepEqual([...fixture.request.challenge.starterInventory].sort(), canonicalPairs.map(e => [e.path, e.sha256]).sort(),
        sourceTree + ': challenge binding must be the exact canonical starter path/sha256 inventory');
      assert.equal(fixture.request.challenge.workloadDigest, canonicalDigest,
        sourceTree + ': challenge workload digest must be the canonical starter digest');

      // --- source: the returned selection matches an independent recomputation ---
      const expected = independentSelectionPaths(fixture.selection.sourceRoot);
      assert.deepEqual([...fixture.selection.files].sort(), expected, sourceTree + ': selection paths must equal an independent top-level-policy recomputation');
      assert.equal(fixture.selection.files.length, 26, sourceTree + ': every variant selects the 26 canonical application paths');
      assert.deepEqual([...fixture.selection.exclusions], [...SELECTION_POLICY_EXCLUSIONS], sourceTree + ': selection must carry the exact imported C3 top-level exclusions');
      assert.equal(fixture.selection.ownerFixtureMarker, '.owner-fixture.json', sourceTree + ': the owner marker must be disclosed separately from the policy exclusions');
      if (sourceTree !== 'reference') {
        assert.deepEqual([...fixture.selection.files].sort(), canonicalPaths, sourceTree + ': the starter/broken selection is the canonical 26-path set');
      } else {
        assert.ok(fixture.selection.files.includes('tests/regressions.test.tsx'), 'reference selection must carry the participant addition');
      }
      assert.deepEqual(fixture.selection.entries.map(e => e.path), [...fixture.selection.files].sort(), sourceTree + ': selection entries are sorted full {path,bytes,sha256} records');
      assert.deepEqual(fixture.selection.entries.map(e => [e.path, e.bytes, e.sha256]),
        [...fixture.selection.files].sort().map(p => { const b = fs.readFileSync(path.join(fixture.selection.sourceRoot, ...p.split('/'))); return [p, b.byteLength, sha256(b)]; }),
        sourceTree + ': selection bytes/hashes are the actual selected raw source bytes');
      assert.equal(fixture.selection.digest, digestOfPaths(fixture.selection.sourceRoot, fixture.selection.files),
        sourceTree + ': selection digest is the legacy pair digest of the selected raw bytes');

      // --- frozen: snapshot paths/inventory/digest equal the selection; workspace too ---
      const snapshot = { root: fixture.frozen.snapshotRoot };
      const snapTree = domainDigest(snapshot.root, { skipNames: [] });
      const wsTree = domainDigest(fixture.run.workspace.root, { skipNames: [] });
      assert.equal(wsTree, fixture.selection.digest, sourceTree + ': live workspace digest must equal the selected source digest');
      assert.equal(snapTree, fixture.selection.digest, sourceTree + ': frozen snapshot digest must equal the selected source digest');
      assert.equal(snapTree, fixture.frozen.frozenSubmission.treeDigest, sourceTree + ': frozen submission tree digest must equal the selected source digest');
      assert.deepEqual(fixture.frozen.frozenSubmission.inventory.map(p => p[0]).sort(), [...fixture.selection.files].sort(),
        sourceTree + ': frozen submission paths must equal the selected source paths exactly');
      assert.deepEqual(fixture.frozen.proof.inventory.map(e => [e.path, e.bytes, e.sha256]),
        fixture.selection.entries.map(e => [e.path, e.bytes, e.sha256]),
        sourceTree + ': frozen proof byte entries must equal the selected source entries exactly');

      console.log(sourceTree + ' selection-fidelity observed:', JSON.stringify({
        selected: fixture.selection.files.length, digest: fixture.selection.digest,
        workspace: wsTree, frozen: snapTree,
        exclusions: fixture.selection.exclusions, ownerMarker: fixture.selection.ownerFixtureMarker,
      }));
    }

    // The broken selection additionally proves the owner marker is skipped as metadata only:
    // the protected broken tree carries it, the selection does not, and no other content is lost.
    const brokenSelection = sourceSelection(PROTECTED.brokenSource);
    assert.ok(fs.existsSync(path.join(PROTECTED.brokenSource, '.owner-fixture.json')), 'the protected broken tree carries the owner marker');
    assert.ok(!brokenSelection.files.includes('.owner-fixture.json'), 'the top-level owner marker must be skipped as owner fixture metadata only');
  } catch (error) {
    retain.failed = true;
    console.log('C4.S3.R1.H SELECTION PROOF STOPPED — diagnostic roots preserved:', error?.message ?? String(error));
    throw error;
  } finally {
    const protectedAfter = Object.fromEntries(Object.entries(PROTECTED).map(([k, r]) => [k, domainDigest(r)]));
    assert.deepEqual(protectedAfter, protectedBefore, 'the protected source trees must be read-only for the whole proof');
  }
});

// Shared retention token: on any failure the synthetic roots are preserved, never deleted.
const synthRetain = { failed: false };

// A synthetic tree from a copy of the canonical 26 plus nested lookalikes, other dotfiles, a
// top-level case variant and the owner marker: proves the policy is EXACT top-level only. The
// `retain` token preserves a failed test's root as external diagnostic evidence (failure-
// preserving, and each run gets an exclusively-new root so test roots stay disjoint).
function buildSyntheticTree(t, retain) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sel-'));
  t.after(() => { if (!retain.failed) fs.rmSync(root, { recursive: true, force: true }); else console.log('preserved synthetic selection root:', root); });
  for (const p of PARTICIPANT_PATHS) {
    const to = path.join(root, ...p.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, fs.readFileSync(path.join(PROTECTED.starter, ...p.split('/'))));
  }
  const w = (rel, body) => { const to = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, body); };
  // Exact top-level policy exclusions (with content): dropped by byte-exact top-level match.
  w('dist/build.js', 'excluded-top\n');
  w('node_modules/pkg/index.js', 'excluded-top\n');
  w('.git/config', 'excluded-top\n');
  w('.benchboard/state.json', 'excluded-top\n');
  w('.cache/x', 'excluded-top\n');
  w('.vite/x', 'excluded-top\n');
  w('coverage/x', 'excluded-top\n');
  w('.agent-teams/x', 'excluded-top\n');
  // Nested lookalikes: RETAINED (no any-depth skipping).
  w('src/dist/nested.js', 'nested-lookalike\n');
  w('vendor/.git/nested.txt', 'nested-lookalike\n');
  w('src/node_modules/pkg/deep.js', 'nested-lookalike\n');
  // Other dotfiles: RETAINED.
  w('.editorconfig', 'dotfile\n');
  // Owner fixture metadata marker at the root: skipped, disclosedly and metadata-only.
  w('.owner-fixture.json', '{"owner":"metadata"}\n');
  return root;
}

test('C4.S3.R1.H synthetic selected tree: exact top-level exclusions only, lookalikes retained, marker skipped', t => {
  const root = buildSyntheticTree(t, synthRetain);
  try {
  const selection = sourceSelection(root);
  const topOf = p => p.split('/')[0];
  // Exact top-level policy exclusions dropped: no selected path sits at one or under one.
  for (const name of SELECTION_POLICY_EXCLUSIONS) {
    assert.ok(!selection.files.includes(name), 'no top-level entry named exactly ' + name);
  }
  assert.deepEqual(selection.files.filter(p => SELECTION_POLICY_EXCLUSIONS.includes(topOf(p))), [], 'no selected path may sit under an exact top-level exclusion');
  // Nested lookalikes retained.
  for (const p of ['src/dist/nested.js', 'vendor/.git/nested.txt', 'src/node_modules/pkg/deep.js']) {
    assert.ok(selection.files.includes(p), 'nested lookalike must be retained: ' + p);
  }
  // Case variants and other dotfiles retained (byte-exact top-level comparison).
  assert.ok(selection.files.includes('.editorconfig'), 'other dotfiles must be retained');
  // Owner marker skipped as owner fixture metadata only, disclosed separately.
  assert.ok(!selection.files.includes('.owner-fixture.json'), 'the root owner fixture marker must be skipped as metadata only');
  assert.equal(selection.ownerFixtureMarker, '.owner-fixture.json');
  assert.deepEqual([...selection.exclusions], [...SELECTION_POLICY_EXCLUSIONS], 'the policy exclusions must be the imported exact top-level set');
  // All 26 canonical application paths survive into the synthetic selection.
  for (const p of PARTICIPANT_PATHS) assert.ok(selection.files.includes(p), 'canonical path must survive: ' + p);
  assert.equal(selection.digest, digestOfPaths(root, selection.files), 'synthetic digest binds the selected raw bytes');
  } catch (error) { synthRetain.failed = true; throw error; }
});

test('C4.S3.R1.H top-level case variants of exclusion names are retained (byte-exact match)', t => {
  // A separate root WITHOUT the exact-spelling siblings, so the case variant exists as its own
  // entry on case-insensitive hosts as well: byte-exact top-level matching must retain it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-selcase-'));
  t.after(() => { if (!synthRetain.failed) fs.rmSync(root, { recursive: true, force: true }); });
  try {
    fs.mkdirSync(path.join(root, 'Dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Dist', 'Nested.tsx'), 'case-variant\n');
    fs.mkdirSync(path.join(root, 'Node_Modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Node_Modules', 'x'), 'case-variant\n');
    // A real-enough application tree below the two case variants (the completeness gate applies).
    for (const p of PARTICIPANT_PATHS) {
      const to = path.join(root, ...p.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, fs.readFileSync(path.join(PROTECTED.starter, ...p.split('/'))));
    }
    const selection = sourceSelection(root);
    assert.ok(selection.files.includes('Dist/Nested.tsx'), 'a top-level case variant of an exclusion name must be retained (byte-exact, no folding)');
    assert.ok(selection.files.includes('Node_Modules/x'), 'a top-level case variant of node_modules must be retained');
  } catch (error) { synthRetain.failed = true; throw error; }
});

test('C4.S3.R1.H selection digest is sensitive to selected raw-byte changes, not to excluded bytes', t => {
  const root = buildSyntheticTree(t, synthRetain);
  const before = sourceSelection(root);
  // A changed byte UNDER an exact top-level exclusion: the selection and its digest do not move.
  fs.writeFileSync(path.join(root, 'dist', 'build.js'), 'excluded-top-changed\n');
  const afterExcluded = sourceSelection(root);
  assert.equal(afterExcluded.digest, before.digest, 'bytes inside an excluded top-level tree are not selected and must not move the digest');
  // One changed byte at a SELECTED path: the digest must move (raw bytes, not path names).
  const target = path.join(root, 'src', 'model.ts');
  fs.writeFileSync(target, fs.readFileSync(target).toString('utf8') + '// selected byte change\n');
  try {
    const afterSelected = sourceSelection(root);
    assert.notEqual(afterSelected.digest, before.digest, 'a changed selected byte must change the digest');
    assert.ok(afterSelected.entries.some(e => e.path === 'src/model.ts' && e.sha256 !== before.entries.find(b => b.path === 'src/model.ts').sha256),
      'the changed entry must carry the new raw-byte hash');
    // A changed selected byte with the SAME path set: paths equal, digest different — the digest
    // cannot be a function of path names alone.
    assert.deepEqual(afterSelected.files, before.files, 'the selected path set is unchanged by a content edit');
  } catch (error) {
    synthRetain.failed = true;
    throw error;
  }
});
