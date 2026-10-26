/**
 * Pure projection of already-verified installed facts into the three neutral
 * identity records used by development-checkout CLI composition (C6.S2.T1).
 *
 * A separate Captain loader verifies every fact before this call; this module
 * rediscovers nothing, reads no files, and consults no process, environment or
 * historical runner state. It maps the facts onto ToolingIdentity,
 * ChallengeIdentity and EvaluatorIdentity records, validates each record with
 * the accepted C1 `validateRecord`, seals it with a C1-recomputable
 * `identityDigestOf` self-digest, validates the sealed record again, and
 * returns a deep-frozen triplet.
 *
 * The self-digest is integrity bookkeeping: it authenticates no party and
 * carries no release approval.
 */

import {
  validateRecord,
  identityDigestOf,
  sha256Hex,
  canonicalJson,
} from '../packages/core/manifest.mjs';

/* Fixed contract values shared by the three records. */
const SCHEMA_VERSION = '1.0.0';
const HASH_ALGORITHM = 'sha256';

/** Recursive copy so no input nested object is retained inside a record. */
function deepCopy(value) {
  if (Array.isArray(value)) return value.map((entry) => deepCopy(entry));
  if (typeof value === 'object' && value !== null) {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = deepCopy(child);
    return out;
  }
  return value;
}

/** Recursively freeze a freshly built value in place and return it. */
function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Validate a record, append the self digest C1 recomputes over its canonical
 * bytes, re-validate the sealed result and return it deep-frozen. Validation
 * errors pass through as the accepted C1 errors; no new error class is created.
 */
function seal(kind, record) {
  const validated = validateRecord(kind, record);
  const sealed = { ...validated, identityDigest: identityDigestOf(validated) };
  return deepFreeze(validateRecord(kind, sealed));
}

/**
 * Project verified installed facts onto the three identity records.
 *
 * @param {object} facts  values supplied and verified by the Captain loader:
 *   `descriptor` (the cli/installation.json object), `descriptorDigest`,
 *   `assetDigest`, `starterEntries` (sorted [relativePath, sha256] pairs),
 *   `workloadDigest`, `publicPrdDigest`, `visibleDigest`, `fixtureDigest`,
 *   `hiddenDigest`, `scoringDigest`, `semanticDigest`, `candidateVersion`,
 *   `candidateStatus`, `sourceCommit`.
 * @returns {object} frozen `{toolingIdentity, challengeIdentity, evaluatorIdentity}`
 *   with each record sealed by its own identityDigest.
 */
export function projectIdentityRecords(facts) {
  const { descriptor } = facts;
  const starterEntries = deepCopy(facts.starterEntries);

  const toolingIdentity = seal('ToolingIdentity', {
    schemaVersion: SCHEMA_VERSION,
    kind: 'ToolingIdentity',
    toolingId: 'benchboard-tooling-cli-development',
    toolingVersion: descriptor.toolingVersion,
    toolingComponent: 'checkout-cli',
    revision: 'development:' + facts.assetDigest,
    installedDigest: facts.assetDigest,
    architectureId: 'benchboard-tooling-cli-architecture',
    architectureKind: 'tooling',
    hashAlgorithm: HASH_ALGORITHM,
    definitionDigest: facts.descriptorDigest,
    digestProvenance: {
      kind: 'COMPUTED',
      procedure: 'Development selected installed assets and descriptor',
    },
    notes: 'Development checkout; not a released package.',
  });

  /* The challenge definition digest binds the domain tag to the canonical
   * challenge inputs named by the task, in canonical JSON form. */
  const challengeDefinitionDigest = sha256Hex(
    canonicalJson({
      domain: 'benchboard.cli.challenge-definition.v1',
      publicPrdDigest: facts.publicPrdDigest,
      visibleDigest: facts.visibleDigest,
      fixtureDigest: facts.fixtureDigest,
      starterEntries,
    }),
  );

  const challengeIdentity = seal('ChallengeIdentity', {
    schemaVersion: SCHEMA_VERSION,
    kind: 'ChallengeIdentity',
    challengeId: 'benchboard-issue-board-v1',
    challengeVersion: descriptor.challengeVersion,
    architectureId: 'benchboard-challenge-architecture',
    architectureKind: 'challenge',
    hashAlgorithm: HASH_ALGORITHM,
    definitionDigest: challengeDefinitionDigest,
    digestProvenance: {
      kind: 'COMPUTED',
      procedure: 'Verified installed canonical challenge inputs',
    },
    workloadProvenance: {
      kind: 'COMPUTED',
      procedure: 'Verified installed canonical challenge inputs',
    },
    publicPrdDigest: facts.publicPrdDigest,
    visibleHarnessDigest: facts.visibleDigest,
    fixtureDigest: facts.fixtureDigest,
    starterInventory: starterEntries,
    workloadDigest: facts.workloadDigest,
    /* Candidate lineage is carried through as its own release-train record;
     * the three identity versions stay separate named domains. */
    candidateLineage: {
      candidateVersion: facts.candidateVersion,
      candidateStatus: facts.candidateStatus,
      sourceCommit: facts.sourceCommit,
    },
  });

  const evaluatorIdentity = seal('EvaluatorIdentity', {
    schemaVersion: SCHEMA_VERSION,
    kind: 'EvaluatorIdentity',
    evaluatorId: 'benchboard-evaluator-v1',
    evaluatorVersion: descriptor.evaluatorVersion,
    exposure: 'OWNER_LOCAL',
    transparency: 'LOCAL_VISIBLE',
    secretClaim: false,
    architectureId: 'benchboard-evaluator-architecture',
    architectureKind: 'evaluator',
    hashAlgorithm: HASH_ALGORITHM,
    definitionDigest: facts.semanticDigest,
    digestProvenance: {
      kind: 'COMPUTED',
      procedure: 'Verified installed evaluator semantic inputs',
    },
    scoringDigest: facts.scoringDigest,
    visibleTestsDigest: facts.visibleDigest,
    hiddenTestsDigest: facts.hiddenDigest,
  });

  return Object.freeze({ toolingIdentity, challengeIdentity, evaluatorIdentity });
}
