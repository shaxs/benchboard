import test from 'node:test';
import assert from 'node:assert/strict';
import { projectIdentityRecords } from '../../cli/identity-records.mjs';
import {
  validateRecord,
  identityDigestOf,
  sha256Hex,
  canonicalJson,
} from '../../packages/core/manifest.mjs';

/* Clearly synthetic facts: nothing here is read from disk and no value below
 * is a real installed digest. */
const hex = (repeat) => repeat.repeat(64);
const SYNTHETIC_FACTS = {
  descriptor: {
    kind: 'benchboard.cli.development-installation.v1',
    schemaVersion: '1.0.0',
    developmentOnly: true,
    toolingVersion: '0.1.0',
    challengeVersion: '1.0.0',
    evaluatorVersion: '1.0.0',
  },
  descriptorDigest: hex('a'),
  assetDigest: hex('b'),
  starterEntries: [
    ['src/App.tsx', hex('1')],
    ['src/index.ts', hex('2')],
  ],
  /* sha256 over canonical JSON of the sorted pair list — the preserved tree
   * digest the C1 challenge validator recomputes from starterInventory. */
  workloadDigest: sha256Hex(
    canonicalJson([
      ['src/App.tsx', hex('1')],
      ['src/index.ts', hex('2')],
    ]),
  ),
  publicPrdDigest: hex('c'),
  visibleDigest: hex('d'),
  fixtureDigest: hex('e'),
  hiddenDigest: hex('f'),
  scoringDigest: hex('0'),
  semanticDigest: hex('9'),
  candidateVersion: '1.0.0-candidate.9',
  candidateStatus: 'CANDIDATE',
  sourceCommit: hex('3').slice(0, 40),
};

function freshFacts() {
  return structuredClone(SYNTHETIC_FACTS);
}

test('projected records are valid C1 records with distinct identities and versions', () => {
  const out = projectIdentityRecords(freshFacts());

  // Re-validating a returned record validates again unchanged.
  for (const [kind, record] of [
    ['ToolingIdentity', out.toolingIdentity],
    ['ChallengeIdentity', out.challengeIdentity],
    ['EvaluatorIdentity', out.evaluatorIdentity],
  ]) {
    assert.deepEqual(validateRecord(kind, record), record);
    assert.equal(record.identityDigest, identityDigestOf(record));
    assert.equal(record.schemaVersion, '1.0.0');
    assert.equal(record.hashAlgorithm, 'sha256');
  }

  // Domain identities and versions stay distinct, bound by IDs not versions.
  assert.equal(out.toolingIdentity.toolingId, 'benchboard-tooling-cli-development');
  assert.equal(out.challengeIdentity.challengeId, 'benchboard-issue-board-v1');
  assert.equal(out.evaluatorIdentity.evaluatorId, 'benchboard-evaluator-v1');
  assert.equal(out.toolingIdentity.architectureKind, 'tooling');
  assert.equal(out.challengeIdentity.architectureKind, 'challenge');
  assert.equal(out.evaluatorIdentity.architectureKind, 'evaluator');
  assert.notEqual(out.toolingIdentity.architectureId, out.challengeIdentity.architectureId);
  assert.notEqual(out.challengeIdentity.architectureId, out.evaluatorIdentity.architectureId);
  assert.equal(out.toolingIdentity.toolingVersion, '0.1.0');
  assert.equal(out.challengeIdentity.challengeVersion, '1.0.0');
  assert.equal(out.evaluatorIdentity.evaluatorVersion, '1.0.0');
});

test('field mappings use every stated fact exactly as specified', () => {
  const facts = freshFacts();
  const { toolingIdentity, challengeIdentity, evaluatorIdentity } =
    projectIdentityRecords(facts);

  // Tooling: descriptor versions, asset digest as revision and installed digest.
  assert.equal(toolingIdentity.toolingComponent, 'checkout-cli');
  assert.equal(toolingIdentity.revision, 'development:' + facts.assetDigest);
  assert.equal(toolingIdentity.installedDigest, facts.assetDigest);
  assert.equal(toolingIdentity.definitionDigest, facts.descriptorDigest);
  assert.deepEqual(toolingIdentity.digestProvenance, {
    kind: 'COMPUTED',
    procedure: 'Development selected installed assets and descriptor',
  });
  assert.equal(toolingIdentity.notes, 'Development checkout; not a released package.');

  // Challenge: mapped digests, carried inventory, no invented ceiling.
  assert.equal(challengeIdentity.publicPrdDigest, facts.publicPrdDigest);
  assert.equal(challengeIdentity.visibleHarnessDigest, facts.visibleDigest);
  assert.equal(challengeIdentity.fixtureDigest, facts.fixtureDigest);
  assert.deepEqual(challengeIdentity.starterInventory, facts.starterEntries);
  assert.equal(challengeIdentity.workloadDigest, facts.workloadDigest);
  assert.equal('declaredCeilingMinutes' in challengeIdentity, false);
  assert.equal('provenanceInputs' in challengeIdentity, false);
  assert.deepEqual(challengeIdentity.digestProvenance, {
    kind: 'COMPUTED',
    procedure: 'Verified installed canonical challenge inputs',
  });
  assert.deepEqual(challengeIdentity.workloadProvenance, {
    kind: 'COMPUTED',
    procedure: 'Verified installed canonical challenge inputs',
  });
  const expectedChallengeDefinition = sha256Hex(
    canonicalJson({
      domain: 'benchboard.cli.challenge-definition.v1',
      publicPrdDigest: facts.publicPrdDigest,
      visibleDigest: facts.visibleDigest,
      fixtureDigest: facts.fixtureDigest,
      starterEntries: facts.starterEntries,
    }),
  );
  assert.equal(challengeIdentity.definitionDigest, expectedChallengeDefinition);

  // Candidate lineage is the exact triplet from facts, kept separate from the
  // three identity versions.
  assert.deepEqual(challengeIdentity.candidateLineage, {
    candidateVersion: facts.candidateVersion,
    candidateStatus: facts.candidateStatus,
    sourceCommit: facts.sourceCommit,
  });

  // Evaluator: fixed exposure fields, semantic digest as definition, no
  // invented scoring bindings or harness digest.
  assert.equal(evaluatorIdentity.exposure, 'OWNER_LOCAL');
  assert.equal(evaluatorIdentity.transparency, 'LOCAL_VISIBLE');
  assert.equal(evaluatorIdentity.secretClaim, false);
  assert.equal(evaluatorIdentity.definitionDigest, facts.semanticDigest);
  assert.equal(evaluatorIdentity.scoringDigest, facts.scoringDigest);
  assert.equal(evaluatorIdentity.visibleTestsDigest, facts.visibleDigest);
  assert.equal(evaluatorIdentity.hiddenTestsDigest, facts.hiddenDigest);
  assert.deepEqual(evaluatorIdentity.digestProvenance, {
    kind: 'COMPUTED',
    procedure: 'Verified installed evaluator semantic inputs',
  });
  assert.equal('scoringBindings' in evaluatorIdentity, false);
  assert.equal('harnessDigest' in evaluatorIdentity, false);
});

test('output is deep-frozen and holds no mutable references into the facts', () => {
  const facts = freshFacts();
  const out = projectIdentityRecords(facts);

  const frozenDeep = (value) => {
    if (typeof value !== 'object' || value === null) return;
    assert.ok(Object.isFrozen(value), 'expected frozen: ' + JSON.stringify(value)?.slice(0, 60));
    for (const child of Object.values(value)) frozenDeep(child);
  };
  frozenDeep(out);

  // Mutating the caller's facts cannot change a returned record: the records
  // were built from deep copies of nested input.
  facts.starterEntries[0][1] = hex('4');
  facts.starterEntries.push(['src/extra.ts', hex('5')]);
  facts.descriptor.toolingVersion = '9.9.9';
  assert.deepEqual(out.challengeIdentity.starterInventory, SYNTHETIC_FACTS.starterEntries);
  assert.equal(out.toolingIdentity.toolingVersion, '0.1.0');
  assert.equal(out.challengeIdentity.identityDigest, identityDigestOf(out.challengeIdentity));
});

test('facts are not mutated by projection', () => {
  const facts = freshFacts();
  const before = JSON.stringify(facts);
  projectIdentityRecords(facts);
  assert.equal(JSON.stringify(facts), before);
});

test('a record the C1 contract refuses surfaces as a C1 validation failure', () => {
  const facts = freshFacts();
  // A malformed digest input is refused by the accepted validator, and the
  // helper creates no record from it.
  facts.assetDigest = 'not-a-digest';
  assert.throws(() => projectIdentityRecords(facts), (error) => {
    assert.match(String(error.message), /ToolingIdentity contract failed validation/);
    return true;
  });

  // Unsorted inventory fails the C1 inventory ordering rule.
  const unsorted = freshFacts();
  unsorted.starterEntries = [
    ['src/b.ts', hex('1')],
    ['src/a.ts', hex('2')],
  ];
  unsorted.workloadDigest = sha256Hex(canonicalJson(unsorted.starterEntries));
  assert.throws(() => projectIdentityRecords(unsorted), (error) => {
    assert.match(String(error.message), /sorted by path/);
    return true;
  });
});
