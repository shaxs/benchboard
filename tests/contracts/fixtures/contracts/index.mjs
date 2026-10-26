/*
 * Synthetic contract fixtures for tests/contracts/manifest.test.mjs.
 *
 * Everything here is invented for the contract suite. No identifier, path,
 * commit, digest or timestamp is copied from a real run, a real candidate or an
 * owner machine. Digests are computed at load time through the module's own
 * exported helpers, which is what makes each fixture internally consistent:
 * tampering with a declared digest stays detectable because the declared value
 * was derived from the record bytes rather than typed out by hand.
 *
 * Two deliberate properties worth naming, because both look like omissions:
 *   - No identity fixture declares a self digest. A self digest covers
 *     `schemaVersion`, so declaring one binds the record to exactly one schema
 *     version, while the contract suite drives this family through compatible
 *     minor and patch versions and must accept each of them. The self digest
 *     stays an optional field that the suite exercises through `RunManifest`,
 *     which does declare one so tampering is caught.
 *   - `run.manifest` records its roots as native absolute host arguments
 *     (POSIX `/synthetic-...` strings here); the contract requires a native
 *     absolute host root in the host's own path syntax and lexically disjoint
 *     workspace/evidence roots, so a relative or nested root is a contract
 *     error; the declared manifest digest is what makes an unexpected value
 *     visible.
 */

import {
  NEUTRAL_CONTRACT_VERSION,
  canonicalJson,
  computeTreeDigest,
  identityDigestOf,
  sha256Hex,
  validateRecord,
} from '../../../../packages/core/manifest.mjs';

const hash = (label) => sha256Hex('synthetic:' + label);

/** The split this evaluator declares; scoring authority stays external. */
const CATEGORY_MAXIMA = Object.freeze({
  visibleChecks: 7,
  functionalCorrectness: 30,
  persistence: 10,
  edgeCases: 5,
  integration: 15,
  codeQuality: 5,
  usefulTests: 5,
  hygiene: 3,
});

const AUTOMATED_MAXIMUM = Object.values(CATEGORY_MAXIMA).reduce((sum, n) => sum + n, 0);
const HUMAN_MAXIMUM = 20;

/** The architecture-binding fields every identity carries. */
const architecture = (architectureId, architectureKind, label) => ({
  architectureId,
  architectureKind,
  hashAlgorithm: 'sha256',
  definitionDigest: hash(architectureKind + ':' + label),
  digestProvenance: {
    kind: 'COMPUTED',
    procedure: 'fixtures/contracts:sha256:canonical-json',
    inputs: [hash(architectureKind + ':' + label)],
  },
});

/**
 * The candidate lineage of the original candidate. The field names and values
 * are preserved as the historical candidate record stated them rather than
 * folded into the architecture binding, so a reader still sees the open review
 * state instead of only a new binding.
 */
const CANDIDATE_LINEAGE = Object.freeze({
  candidateVersion: '1.0.0-candidate.9',
  candidateStatus: 'REVIEW_FINDINGS_UNRESOLVED',
  sourceCommit: 'c662a4a1b2c3d4e5f60718293a4b5c6d7e8f90a1',
  sourceTag: 'candidate-nine-synthetic',
  reviewPacketDigest: hash('review-packet-synthetic'),
  reviewStatus: 'CHANGES_REQUESTED',
  evidenceManifestDigest: hash('evidence-manifest-synthetic'),
  lineageNotes: 'Synthetic lineage: the historical review findings stay unresolved and are not presented as closed.',
});

/** A relative POSIX inventory of `[path, fileDigest]` pairs, sorted by path. */
const starterInventory = () => [
  ['README.md', hash('starter-readme')],
  ['docs/task.md', hash('starter-task')],
  ['src/index.mjs', hash('starter-index')],
  ['visible-tests/index.mjs', hash('starter-visible-tests')],
];

/* -------------------------------------------------------------------------- */
/* Identities                                                                  */
/* -------------------------------------------------------------------------- */

const toolingIdentity = () => ({
  schemaVersion: NEUTRAL_CONTRACT_VERSION,
  kind: 'ToolingIdentity',
  toolingId: 'tooling-synthetic-cli',
  /* The tooling version is its own axis on its own release train, separate
   * from the challenge, candidate and evaluator domains; no version string of
   * one domain stands in for another. */
  toolingVersion: '0.1.0',
  toolingComponent: 'synthetic-cli',
  revision: '1122334',
  installedDigest: hash('tooling-installed-bytes'),
  adapterName: 'synthetic-adapter',
  adapterVersion: '0.1.0',
  ...architecture('arch-tooling-synthetic', 'tooling', 'tooling-definition'),
  supportedContracts: {
    contractsVersion: NEUTRAL_CONTRACT_VERSION,
    kinds: ['ToolingIdentity', 'RunManifest', 'Result'],
  },
  notes: 'Synthetic tooling identity for contract tests.',
});

const challengeIdentity = () => {
  const starter = starterInventory();
  return {
    schemaVersion: NEUTRAL_CONTRACT_VERSION,
    kind: 'ChallengeIdentity',
    challengeId: 'challenge-synthetic-surface',
    challengeVersion: '1.0.0',
    ...architecture('arch-challenge-synthetic', 'challenge', 'challenge-definition'),
    workloadProvenance: {
      kind: 'COMPUTED',
      procedure: 'fixtures/contracts:starter-inventory-digest',
    },
    publicPrdDigest: hash('public-prd-synthetic'),
    visibleHarnessDigest: hash('visible-harness-synthetic'),
    fixtureDigest: hash('fixture-bytes-synthetic'),
    starterInventory: starter,
    workloadDigest: computeTreeDigest(starter),
    declaredCeilingMinutes: 120,
    candidateLineage: { ...CANDIDATE_LINEAGE },
    notes: 'Synthetic challenge identity; the original candidate lineage is preserved as stated.',
  };
};

const evaluatorIdentity = () => ({
  schemaVersion: NEUTRAL_CONTRACT_VERSION,
  kind: 'EvaluatorIdentity',
  evaluatorId: 'evaluator-synthetic-core',
  evaluatorVersion: '1.2.0',
  exposure: 'OWNER_LOCAL',
  transparency: 'LOCAL_VISIBLE',
  /* A locally visible evaluator can not claim secrecy from its own user. */
  secretClaim: false,
  ...architecture('arch-evaluator-synthetic', 'evaluator', 'evaluator-definition'),
  scoringDigest: hash('scoring-bytes-synthetic'),
  visibleTestsDigest: hash('visible-tests-bytes-synthetic'),
  hiddenTestsDigest: hash('hidden-tests-bytes-synthetic'),
  harnessDigest: hash('evaluator-harness-synthetic'),
  /* The split is stated here, never computed: the arithmetic belongs to the
   * evaluator that runs the tests. */
  scoringBindings: {
    automatedMaximum: AUTOMATED_MAXIMUM,
    humanMaximum: HUMAN_MAXIMUM,
    maximum: AUTOMATED_MAXIMUM + HUMAN_MAXIMUM,
    categories: { ...CATEGORY_MAXIMA },
  },
  notes: 'Synthetic evaluator identity; declares the score split without computing a score.',
});

/* -------------------------------------------------------------------------- */
/* RunManifest and FrozenSubmission                                            */
/* -------------------------------------------------------------------------- */

/**
 * A run manifest that is valid as written: every binding digest is recomputed
 * from the validated projection of the identity it names, the run architecture
 * is its own rather than a borrowed one, and the declared manifest digest
 * matches the record bytes so tampering with any field is detectable.
 */
function runManifest({
  manifestId = 'mf-11111111-1111-4111-8111-111111111111',
  runId = 'bb-syn-run-001',
  createdAt = '2026-03-01T09:00:00.000Z',
  architectureId = 'arch-run-synthetic',
  architectureKind = 'run',
  securityModel = 'COOPERATIVE_WORKSPACE_NO_ADVERSARIAL_OS_CONTAINMENT',
  declaredCeilingMinutes = 45,
  configuration,
  participantWorkspaceRoot = '/synthetic-workspace/bb-syn-run-001',
  evidenceRoot = '/synthetic-evidence/bb-syn-run-001',
  notes = 'Synthetic run manifest: roots are explicit arguments, not looked up.',
} = {}) {
  const tooling = validateRecord('ToolingIdentity', toolingIdentity());
  const challenge = validateRecord('ChallengeIdentity', challengeIdentity());
  const evaluator = validateRecord('EvaluatorIdentity', evaluatorIdentity());

  const identityDigests = {
    toolingIdentityDigest: identityDigestOf(tooling),
    challengeIdentityDigest: identityDigestOf(challenge),
    evaluatorIdentityDigest: identityDigestOf(evaluator),
  };

  const manifest = {
    schemaVersion: NEUTRAL_CONTRACT_VERSION,
    kind: 'RunManifest',
    manifestId,
    runId,
    createdAt,
    architectureId,
    architectureKind,
    hashAlgorithm: 'sha256',
    /* The same formula the sealing helper uses: a canonical digest over the
     * sorted binding identity digests. */
    definitionDigest: sha256Hex(canonicalJson(
      Object.entries(identityDigests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    )),
    digestProvenance: {
      kind: 'COMPUTED',
      procedure: 'fixtures/contracts:sha256:canonical-json',
      inputs: Object.values(identityDigests).sort(),
    },
    bindings: {
      tooling: {
        toolingId: tooling.toolingId,
        toolingVersion: tooling.toolingVersion,
        toolingComponent: tooling.toolingComponent,
        architectureId: tooling.architectureId,
        installedDigest: tooling.installedDigest,
        adapterName: tooling.adapterName,
        adapterVersion: tooling.adapterVersion,
        toolingIdentityDigest: identityDigests.toolingIdentityDigest,
      },
      challenge: {
        challengeId: challenge.challengeId,
        challengeVersion: challenge.challengeVersion,
        architectureId: challenge.architectureId,
        workloadDigest: challenge.workloadDigest,
        declaredCeilingMinutes: challenge.declaredCeilingMinutes,
        candidateVersion: challenge.candidateLineage.candidateVersion,
        challengeIdentityDigest: identityDigests.challengeIdentityDigest,
      },
      evaluator: {
        evaluatorId: evaluator.evaluatorId,
        evaluatorVersion: evaluator.evaluatorVersion,
        architectureId: evaluator.architectureId,
        scoringDigest: evaluator.scoringDigest,
        exposure: evaluator.exposure,
        evaluatorIdentityDigest: identityDigests.evaluatorIdentityDigest,
      },
    },
    harness: 'manual',
    securityModel,
    expectedSessionPolicy: null,
    declaredCeilingMinutes,
    /* Stated, never discovered: a field that is not known here stays null and
     * is never defaulted to zero or an empty string. `unknown` is the statement
     * about the unknown set, and the list is stated even when empty because the
     * self digest covers the projected record, so a fixture must state what the
     * projection will hold. */
    configuration: configuration ?? {
      harness: 'manual',
      model: null,
      location: null,
      os: null,
      nodeVersion: null,
      unknown: null,
      unknownFields: [],
    },
    participantWorkspaceRoot,
    evidenceRoot,
    notes,
  };

  manifest.manifestDigest = identityDigestOf(manifest);
  return manifest;
}

/**
 * A frozen submission whose tree digest and file count are recomputed from its
 * own inventory, so a stale or replaced digest is caught rather than trusted.
 */
function frozenSubmission() {
  const manifest = validateRecord('RunManifest', runManifest());
  const inventory = [
    ['notes/plan.md', hash('submission-plan')],
    ['src/index.mjs', hash('submission-index')],
    ['src/surface.mjs', hash('submission-surface')],
    ['visible-tests/index.mjs', hash('submission-visible-tests')],
  ];
  return {
    schemaVersion: NEUTRAL_CONTRACT_VERSION,
    kind: 'FrozenSubmission',
    frozenSubmissionId: 'sub-55555555-5555-4555-8555-555555555555',
    manifestId: manifest.manifestId,
    runId: manifest.runId,
    frozenAt: '2026-03-01T10:30:00.000Z',
    hashAlgorithm: 'sha256',
    inventory,
    treeDigest: computeTreeDigest(inventory),
    byteCount: 148_320,
    fileCount: inventory.length,
    freezeProcedure: 'fixtures/contracts:freeze-copied-tree',
    notes: 'Synthetic frozen submission bound to the synthetic run manifest.',
  };
}

/* -------------------------------------------------------------------------- */
/* Measurement                                                                 */
/* -------------------------------------------------------------------------- */

const SYNTHETIC_SUBMISSION_ID = 'sub-55555555-5555-4555-8555-555555555555';
const SYNTHETIC_MANIFEST_ID = 'mf-11111111-1111-4111-8111-111111111111';

const measurementUnavailable = () => ({
  schemaVersion: NEUTRAL_CONTRACT_VERSION,
  kind: 'Measurement',
  measurementId: 'meas-syn-peak-memory',
  metric: 'peakResidentBytes',
  unit: 'bytes',
  measurementKind: 'UNAVAILABLE',
  /* Nothing was sampled: the value stays null, and is never written as zero. */
  value: null,
  source: null,
  notes: 'No sampler was running, so this stays unmeasured rather than reported as zero.',
});

const measurementElapsedWall = () => ({
  schemaVersion: NEUTRAL_CONTRACT_VERSION,
  kind: 'Measurement',
  measurementId: 'meas-syn-elapsed-wall',
  metric: 'elapsedWallSeconds',
  unit: 's',
  measurementKind: 'MEASURED',
  value: 412.5,
  source: {
    kind: 'COMPUTED',
    procedure: 'fixtures/contracts:observed-end-minus-seeded-start',
  },
  confidence: 0.98,
  recordedAt: '2026-03-01T10:00:00.000Z',
  notes: 'Measured from the observed run window.',
});

const measurementManualUsage = () => ({
  schemaVersion: NEUTRAL_CONTRACT_VERSION,
  kind: 'Measurement',
  measurementId: 'meas-syn-hand-count',
  metric: 'manualUsageCount',
  unit: 'count',
  measurementKind: 'ENTERED',
  value: 20_480,
  /* An entered value names the record it was read from, and must not be
   * dressed up as something a procedure computed. */
  source: {
    kind: 'LOCAL_ID',
    recordKind: 'RunManifest',
    recordId: SYNTHETIC_MANIFEST_ID,
    procedure: 'fixtures/contracts:transcribed-by-operator',
  },
  confidence: 0.6,
  recordedAt: '2026-03-01T10:05:00.000Z',
  notes: 'Entered by hand from a local panel: honest provenance, not a computation.',
});

const measurementOutputRate = () => ({
  schemaVersion: NEUTRAL_CONTRACT_VERSION,
  kind: 'Measurement',
  measurementId: 'meas-syn-output-rate',
  metric: 'outputRatePerSecond',
  unit: 'ratio',
  measurementKind: 'DERIVED',
  value: 49.6,
  source: {
    kind: 'LOCAL_DIGEST',
    digest: hash('derived-input-window'),
    procedure: 'fixtures/contracts:derived-from-two-measurements',
  },
  /* A formula on the wire, always carried as the same string by the runtime,
   * the schema and the declarations (validateRecord checks it in place;
   * `parseDerivation` derives the input list when a consumer needs it). */
  derivation: '{manualUsageCount} / {elapsedWallSeconds}',
  confidence: 0.9,
  recordedAt: '2026-03-01T10:06:00.000Z',
  notes: 'Derived from two measurements; the formula states the dependency openly.',
});

const measurementFilesRead = () => ({
  schemaVersion: NEUTRAL_CONTRACT_VERSION,
  kind: 'Measurement',
  measurementId: 'meas-syn-files-read',
  metric: 'filesReadCount',
  unit: 'count',
  measurementKind: 'MEASURED',
  value: 37,
  source: {
    kind: 'LOCAL_DIGEST',
    recordKind: 'FrozenSubmission',
    recordId: SYNTHETIC_SUBMISSION_ID,
    digest: frozenSubmission().treeDigest,
    procedure: 'fixtures/contracts:counted-copied-files',
  },
  recordedAt: '2026-03-01T10:07:00.000Z',
  notes: 'Counted from the frozen tree the submission preserves.',
});

/* -------------------------------------------------------------------------- */
/* Result                                                                      */
/* -------------------------------------------------------------------------- */

/** The bindings a result shares with the record it describes. */
const resultBindings = () => {
  const manifest = validateRecord('RunManifest', runManifest());
  return {
    manifestId: manifest.manifestId,
    runId: manifest.runId,
    frozenSubmissionId: SYNTHETIC_SUBMISSION_ID,
    treeDigest: frozenSubmission().treeDigest,
    manifestDigest: manifest.manifestDigest,
    toolingIdentityDigest: manifest.bindings.tooling.toolingIdentityDigest,
    challengeIdentityDigest: manifest.bindings.challenge.challengeIdentityDigest,
    evaluatorIdentityDigest: manifest.bindings.evaluator.evaluatorIdentityDigest,
    challengeId: manifest.bindings.challenge.challengeId,
    challengeVersion: manifest.bindings.challenge.challengeVersion,
    candidateVersion: manifest.bindings.challenge.candidateVersion,
    evaluatorId: manifest.bindings.evaluator.evaluatorId,
    evaluatorVersion: manifest.bindings.evaluator.evaluatorVersion,
    toolingId: manifest.bindings.tooling.toolingId,
    toolingVersion: manifest.bindings.tooling.toolingVersion,
    workloadDigest: manifest.bindings.challenge.workloadDigest,
  };
};

/**
 * A local self-assessment: an evaluator that ran and produced an automated
 * score with no human UI component yet, so the combined score stays pending.
 * The axes stay separate on purpose - the evaluator execution succeeded, the
 * human review is open, the assessment trust is only local, and the run
 * completed. None of them implies the others.
 */
function resultSelfAssessment() {
  const bindings = resultBindings();
  return {
    schemaVersion: NEUTRAL_CONTRACT_VERSION,
    kind: 'Result',
    resultId: 'result-syn-self-assessment',
    lifecycle: 'EVALUATED',
    runStatus: 'COMPLETED',
    evaluatorExecution: 'SUCCESS',
    scoreEligibility: 'ELIGIBLE_PENDING_HUMAN_REVIEW',
    stopResult: 'COMPLETED',
    architectureId: 'arch-result-synthetic',
    hashAlgorithm: 'sha256',
    bindings,
    quality: {
      automated: 61,
      automatedMaximum: AUTOMATED_MAXIMUM,
      humanUI: null,
      humanMaximum: HUMAN_MAXIMUM,
      /* No combined score while the human component has not been scored. */
      quality: null,
      qualityMaximum: AUTOMATED_MAXIMUM + HUMAN_MAXIMUM,
      status: 'HUMAN_REVIEW_PENDING',
      categories: {
        visibleChecks: 4,
        functionalCorrectness: 24,
        persistence: 8,
        edgeCases: 3,
        integration: 12,
        codeQuality: 4,
        usefulTests: 4,
        hygiene: 2,
      },
    },
    measurements: [
      {
        schemaVersion: NEUTRAL_CONTRACT_VERSION,
        kind: 'Measurement',
        measurementId: 'meas-syn-elapsed-wall',
        metric: 'elapsedWallSeconds',
        unit: 's',
        measurementKind: 'MEASURED',
        value: 412.5,
        source: {
          kind: 'COMPUTED',
          recordKind: 'FrozenSubmission',
          recordId: bindings.frozenSubmissionId,
          procedure: 'fixtures/contracts:observed-end-minus-seeded-start',
        },
        recordedAt: '2026-03-01T10:00:00.000Z',
      },
      {
        schemaVersion: NEUTRAL_CONTRACT_VERSION,
        kind: 'Measurement',
        measurementId: 'meas-syn-peak-memory',
        metric: 'peakResidentBytes',
        unit: 'bytes',
        measurementKind: 'UNAVAILABLE',
        value: null,
        source: null,
      },
    ],
    evaluationTrust: 'LOCAL_SELF_ASSESSMENT',
    evaluationTrustBasis: {
      basisKind: 'SELF_ASSESSMENT',
      /* A self-assessment rests on the person who made it. It can not rest on
       * the tooling that recorded it, and it cites no digest as though a
       * digest were an external grant. */
      reviewer: 'local-operator',
    },
    humanReview: { reviewStatus: 'NOT_REVIEWED' },
    declaredTrustChanges: [],
    limitations: [
      'Self-assessed: no independent review and no certification mechanism exists in this release.',
      'No governed timing authority: the declared ceiling is declared, not enforced.',
      'No human UI component has been scored, so no combined score exists.',
    ],
    comparability: 'LOCAL_ONLY',
    historical: false,
    notes: 'Synthetic local self-assessment; nothing here raises assessment trust.',
  };
}

/**
 * A locally scored result: a named human scored the optional UI component, so
 * a combined score may exist. That is a human act on its own axis; it is still
 * not a comparison-eligible, governed or certified record, and the trust stays
 * where a self-assessment puts it.
 */
function resultLocalScored() {
  const bindings = resultBindings();
  return {
    schemaVersion: NEUTRAL_CONTRACT_VERSION,
    kind: 'Result',
    resultId: 'result-syn-locally-scored',
    lifecycle: 'EVALUATED',
    runStatus: 'COMPLETED',
    evaluatorExecution: 'SUCCESS',
    scoreEligibility: 'SCORED',
    stopResult: 'COMPLETED',
    architectureId: 'arch-result-synthetic',
    hashAlgorithm: 'sha256',
    bindings,
    quality: {
      automated: 66,
      automatedMaximum: AUTOMATED_MAXIMUM,
      humanUI: 15,
      humanMaximum: HUMAN_MAXIMUM,
      quality: 81,
      qualityMaximum: AUTOMATED_MAXIMUM + HUMAN_MAXIMUM,
      status: 'SCORED',
      categories: {
        visibleChecks: 6,
        functionalCorrectness: 28,
        persistence: 9,
        edgeCases: 4,
        integration: 13,
        codeQuality: 4,
        usefulTests: 1,
        hygiene: 1,
      },
    },
    measurements: [
      {
        schemaVersion: NEUTRAL_CONTRACT_VERSION,
        kind: 'Measurement',
        measurementId: 'meas-syn-elapsed-wall',
        metric: 'elapsedWallSeconds',
        unit: 's',
        measurementKind: 'MEASURED',
        value: 398.75,
        source: {
          kind: 'COMPUTED',
          recordKind: 'RunManifest',
          recordId: bindings.manifestId,
          procedure: 'fixtures/contracts:observed-end-minus-seeded-start',
        },
        recordedAt: '2026-03-01T11:00:00.000Z',
      },
      {
        schemaVersion: NEUTRAL_CONTRACT_VERSION,
        kind: 'Measurement',
        measurementId: 'meas-syn-files-read',
        metric: 'filesReadCount',
        unit: 'count',
        measurementKind: 'MEASURED',
        value: 37,
        source: {
          kind: 'LOCAL_DIGEST',
          recordKind: 'FrozenSubmission',
          recordId: bindings.frozenSubmissionId,
          digest: bindings.treeDigest,
          procedure: 'fixtures/contracts:counted-copied-files',
        },
        recordedAt: '2026-03-01T11:01:00.000Z',
      },
    ],
    evaluationTrust: 'LOCAL_SELF_ASSESSMENT',
    evaluationTrustBasis: {
      basisKind: 'LOCAL_PROCEDURE',
      /* The bound tree digest is a binding, not a basis; a local procedure was
       * executed, so the basis names that and claims no external grant. */
      basisDigest: null,
      reviewer: 'local-operator',
    },
    humanReview: {
      reviewId: 'review-syn-ui-001',
      reviewStatus: 'SCORED',
      reviewer: 'reviewer-synthetic',
      reviewDigest: hash('human-ui-review-synthetic'),
      reviewedAt: '2026-03-01T11:30:00.000Z',
    },
    declaredTrustChanges: [],
    limitations: [
      'Self-assessed: a human UI score is a human act, not a review grant or a certification.',
      'Local only: no governed comparison and no enforced timing authority.',
    ],
    comparability: 'LOCAL_ONLY',
    historical: false,
    notes: 'Synthetic locally scored result; the human component is named and dated.',
  };
}

/* -------------------------------------------------------------------------- */
/* Historical records                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Historical payloads kept in the shape they were written in so the reader can
 * preserve them verbatim. The 1.0 and 1.1 records are the bare historical
 * result documents (their run object carries its own outcome statements, with
 * only what its own schema version defined: a 1.0 record has no deadline, stop
 * result or time ceiling, and a 1.1 record has no time ceiling). All values
 * are sanitised synthetic structure modelled on the supported historical
 * telemetry shapes; no identifier, token or numeric history of a real run is
 * copied.
 */
const legacyResult10 = () => ({
  schemaVersion: '1.0',
  run: {
    runId: 'bb-syn-legacy-001',
    benchmarkVersion: '0.9.3',
    startedAt: '2026-01-12T08:00:00.000Z',
    finishedAt: '2026-01-12T09:10:00.000Z',
    status: 'COMPLETED',
    challenge: 'synthetic-surface',
    candidate: 'candidate-eight-synthetic',
    notes: 'Synthetic 1.0 telemetry record: no deadline, no stop result, no score claim.',
  },
});

const legacyResult11 = () => ({
  schemaVersion: '1.1',
  run: {
    runId: 'bb-syn-legacy-002',
    benchmarkVersion: '0.9.4',
    startedAt: '2026-02-02T14:00:00.000Z',
    finishedAt: '2026-02-02T15:20:00.000Z',
    deadlineAt: '2026-02-02T16:00:00.000Z',
    observationEndedAt: '2026-02-02T15:21:00.000Z',
    stopResult: 'COMPLETED',
    status: 'TIME_LIMIT',
    challenge: 'synthetic-surface',
    candidate: 'candidate-nine-synthetic',
    validOutcome: false,
    notes: 'Synthetic 1.1 telemetry record: a time limit ended the run; no execution binding exists.',
  },
});

/**
 * A 1.2 record in the authentic raw-telemetry shape: `run` beside the arrays
 * the historical benchmark recorded per record (provenance, captain, workers,
 * tasks, attempts, gpu reservations, orchestration and cloud), all closed
 * synthetic structure. Its outcome statements — the time ceiling, the
 * termination binding and the execution identifier — sit inside `run`, not
 * beside it; numeric quality is not part of the raw shape at all.
 */
const legacySuccessTokens = () => ({
  inputTokens: 1200,
  cacheReadTokens: 300,
  outputTokens: 400,
  modelSteps: 11,
  compactions: null,
  toolCalls: null,
});

const legacySuccessAttempt = (attemptId) => ({
  logicalMember: 'worker-1',
  model: 'synthetic-model/worker-main',
  location: 'local',
  taskId: 't1',
  attemptId,
  dispatchClass: 'initial',
  sessionId: hash(attemptId).slice(0, 32),
  sessionGeneration: 1,
  startedAt: '2026-03-04T09:05:00.000Z',
  completedAt: '2026-03-04T10:20:00.000Z',
  firstMeaningfulArtifactAt: null,
  firstPassingTestAt: null,
  status: 'COMPLETED',
  tokens: legacySuccessTokens(),
  decodeTokensPerSecond: 80.5,
  ttftMs: 4000,
  modelWallSeconds: 4500.75,
  startingContextTokens: null,
  endingContextTokens: null,
  cacheGrowthTokens: null,
  focusedTestsPassed: null,
  focusedTestsTotal: null,
  reworkSeconds: null,
  falseCompletion: null,
  stalls: null,
  captainWakeups: null,
  invalidToolCalls: null,
  scopeExpansions: null,
  integrationDefects: null,
  humanInterventions: null,
});

const legacyResult12 = () => ({
  schemaVersion: '1.2',
  run: {
    runId: 'bb-syn-legacy-003',
    benchmarkVersion: '1.0.0-candidate.9',
    architectureId: 'synthetic-two-worker-session',
    startedAt: '2026-03-04T09:00:00.000Z',
    completedAt: '2026-03-04T10:25:00.000Z',
    status: 'COMPLETED',
    sessionPolicy: 'independentTask:fresh,sameAttemptContinuation:reuse',
    configuration: {
      classification: 'SYNTHETIC_STRUCTURE',
      participants: ['synthetic-worker-main'],
    },
    deadlineAt: '2026-03-04T11:00:00.000Z',
    observationEndedAt: '2026-03-04T10:26:00.000Z',
    stopResult: 'COMPLETED',
    timeCeilingMinutes: 120,
    terminationRequestedAt: null,
    terminationOutcome: 'COMPLETED',
    /* Historical for this release: the reader keeps it and binds nothing. */
    executionId: 'ex-77777777-7777-4777-8777-777777777777',
    teamId: 'bb-syn-legacy-003',
    candidateVersion: '1.0.0-candidate.9',
    workloadHash: hash('synthetic-workload-bytes'),
    watchdogPid: 111000,
    watchdogNonce: 'synthetic-watchdog-nonce-0001',
  },
  provenance: {
    source: 'Preserved synthetic team state, session projections and completion observation',
    exportedAt: '2026-03-04T10:40:00.000Z',
    sourceHash: hash('synthetic-legacy-source'),
  },
  captain: {
    model: 'synthetic-model/captain',
    location: 'local',
    tokens: legacySuccessTokens(),
    modelWallSeconds: 5100.25,
    humanInterventions: 0,
  },
  workers: [
    {
      logicalMember: 'worker-1',
      model: 'synthetic-model/worker-main',
      location: 'local',
      availableStartedAt: '2026-03-04T09:00:00.000Z',
      availableCompletedAt: '2026-03-04T10:25:00.000Z',
      intervals: [
        {
          startedAt: '2026-03-04T09:05:00.000Z',
          completedAt: '2026-03-04T10:20:00.000Z',
          kind: 'busy',
        },
      ],
    },
  ],
  tasks: [{ taskId: 't1', dependencies: [], taskType: 'work' }],
  attempts: [legacySuccessAttempt('at-77777777-7777-4777-8777-777777777771')],
  gpuReservations: null,
  orchestration: {
    captainTakeovers: 0,
    humanInterventions: 0,
    reassignments: 0,
    independentRotations: 1,
    reviewFindings: 0,
    sotaFindings: 0,
  },
  cloud: { costUsd: null, provider: null },
});

/* -------------------------------------------------------------------------- */
/* The fixture set                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Positively flagged historical records in the authentic EMITTED metrics
 * projection shape: the projection document carries its schemaVersion and run
 * object beside TOP-LEVEL numeric quality counts and top-level
 * authority/outcome flags (official, outcome classification, formal-comparison
 * and calibration eligibility, validity, timing evidence and the nullable
 * supervision/termination/stop states). This is where the historical shapes
 * actually recorded those statements — beside `run`, not nested inside it.
 * Every value is sanitised synthetic structure; no identifier, token or number
 * of a real run is copied. The reader must preserve these statements verbatim
 * inside the non-promoting envelope (the whole projection document is the
 * preserved outcome) rather than refuse the record for asserting something the
 * reader cannot certify.
 */
const legacyEmittedProjection10 = () => ({
  schemaVersion: '1.0',
  run: {
    runId: 'bb-syn-legacy-pos-001',
    benchmarkVersion: '0.9.3',
    architectureId: 'synthetic-single-session',
    startedAt: '2026-01-14T08:00:00.000Z',
    completedAt: '2026-01-14T09:05:00.000Z',
    status: 'COMPLETED',
  },
  observedEndAt: '2026-01-14T09:05:00.000Z',
  official: false,
  outcomeClass: 'HISTORICAL_UNBOUND_DESCRIPTIVE',
  supervisionValid: null,
  terminationProven: null,
  executionId: 'ex-66666666-6666-4666-8666-666666666666',
  eligibleForFormalComparison: true,
  eligibleForCalibrationAcceptance: true,
  officialOutcomeValid: true,
  ineligibilityReasons: [],
  authorityProblems: [],
  deadlineOverrunSeconds: 0,
  officialWindowSeconds: 3900.5,
  actualWallSeconds: 3900.5,
  stopConfirmed: null,
  validOutcome: true,
  timingEvidence: 'LEGACY_REPORTED_END_NOT_STOP_PROOF',
  quality: 55.75,
  hiddenPassed: 9,
  wallSeconds: 3900.5,
  taskCount: 1,
  attemptCount: 1,
});

const legacyEmittedProjection11 = () => ({
  schemaVersion: '1.1',
  run: {
    runId: 'bb-syn-legacy-pos-002',
    benchmarkVersion: '0.9.4',
    architectureId: 'synthetic-single-session',
    startedAt: '2026-02-04T14:00:00.000Z',
    completedAt: '2026-02-04T15:10:00.000Z',
    status: 'COMPLETED',
    deadlineAt: '2026-02-04T16:00:00.000Z',
    observationEndedAt: '2026-02-04T15:11:00.000Z',
    stopResult: 'COMPLETED',
  },
  observedEndAt: '2026-02-04T15:11:00.000Z',
  official: false,
  outcomeClass: 'HISTORICAL_UNBOUND_DESCRIPTIVE',
  supervisionValid: null,
  terminationProven: null,
  executionId: 'ex-66666666-6666-4666-8666-666666666677',
  eligibleForFormalComparison: true,
  eligibleForCalibrationAcceptance: true,
  officialOutcomeValid: true,
  ineligibilityReasons: [],
  authorityProblems: [],
  deadlineOverrunSeconds: 0,
  officialWindowSeconds: 4200.25,
  actualWallSeconds: 4200.25,
  stopConfirmed: true,
  validOutcome: true,
  timingEvidence: 'EXPLICIT_OBSERVATION',
  quality: 61.25,
  hiddenPassed: 11,
  wallSeconds: 4200.25,
  taskCount: 1,
  attemptCount: 1,
});

const legacyEmittedProjection12 = () => ({
  schemaVersion: '1.2',
  run: {
    runId: 'bb-syn-legacy-pos-003',
    benchmarkVersion: '1.0.0-candidate.9',
    architectureId: 'synthetic-two-worker-session',
    startedAt: '2026-03-06T09:00:00.000Z',
    completedAt: '2026-03-06T10:15:00.000Z',
    status: 'COMPLETED',
    deadlineAt: '2026-03-06T11:00:00.000Z',
    observationEndedAt: '2026-03-06T10:16:00.000Z',
    stopResult: 'COMPLETED',
    timeCeilingMinutes: 120,
    terminationOutcome: 'COMPLETED',
  },
  observedEndAt: '2026-03-06T10:16:00.000Z',
  deadlineAt: '2026-03-06T11:00:00.000Z',
  timeCeilingMinutes: 120,
  timeCeilingSeconds: 7200,
  executionId: 'ex-66666666-6666-4666-8666-666666666688',
  official: false,
  outcomeClass: 'HISTORICAL_UNBOUND_DESCRIPTIVE',
  supervisionValid: null,
  terminationProven: null,
  eligibleForFormalComparison: true,
  eligibleForCalibrationAcceptance: true,
  officialOutcomeValid: true,
  ineligibilityReasons: [],
  authorityProblems: [],
  deadlineOverrunSeconds: 0,
  officialWindowSeconds: 4500.5,
  actualWallSeconds: 4500.5,
  stopConfirmed: true,
  validOutcome: true,
  timingEvidence: 'EXPLICIT_OBSERVATION',
  quality: 71.5,
  hiddenPassed: 13,
  wallSeconds: 4500.5,
  taskCount: 2,
  attemptCount: 2,
});

const FIXTURE_SETS = Object.freeze({
  identities: Object.freeze(['tooling.identity', 'challenge.identity', 'evaluator.identity']),
  runs: Object.freeze(['run.manifest', 'run.manifest.alt']),
  submissions: Object.freeze(['frozen.submission']),
  measurements: Object.freeze([
    'measurement.unavailable',
    'measurement.elapsedWall',
    'measurement.manualTokens',
    'measurement.tokensPerSecond',
    'measurement.filesRead',
  ]),
  results: Object.freeze(['result.selfassessment', 'result.localscored']),
  legacy: Object.freeze(['legacy.result.1.0', 'legacy.result.1.1', 'legacy.result.1.2',
    'legacy.result.positive.1.0', 'legacy.result.positive.1.1', 'legacy.result.positive.1.2']),
});

/* The measurement names carry the metric they measure, so the metric names stay
 * in the name even where the fixture names predate the field rename. */
const BUILDERS = Object.freeze({
  'tooling.identity': toolingIdentity,
  'challenge.identity': challengeIdentity,
  'evaluator.identity': evaluatorIdentity,
  'run.manifest': () => runManifest(),
  'run.manifest.alt': () =>
    runManifest({
      manifestId: 'mf-22222222-2222-4222-8222-222222222222',
      runId: 'bb-syn-run-002',
      createdAt: '2026-03-01T12:00:00.000Z',
      /* A configuration that is not known here: unknown fields stay null and
       * are listed, never defaulted to zero or an empty string. */
      configuration: {
        harness: 'manual',
        model: null,
        location: null,
        os: 'win32',
        nodeVersion: null,
        unknown: 'UNKNOWN',
        unknownFields: ['location', 'model', 'nodeVersion'],
      },
      participantWorkspaceRoot: '/synthetic-workspace/bb-syn-run-002',
      evidenceRoot: '/synthetic-evidence/bb-syn-run-002',
      notes: 'Synthetic run manifest whose configuration is not known here.',
    }),
  'frozen.submission': frozenSubmission,
  'measurement.unavailable': measurementUnavailable,
  'measurement.elapsedWall': measurementElapsedWall,
  'measurement.manualTokens': measurementManualUsage,
  'measurement.tokensPerSecond': measurementOutputRate,
  'measurement.filesRead': measurementFilesRead,
  'result.selfassessment': resultSelfAssessment,
  'result.localscored': resultLocalScored,
  'legacy.result.1.0': legacyResult10,
  'legacy.result.1.1': legacyResult11,
  'legacy.result.1.2': legacyResult12,
  'legacy.result.positive.1.0': legacyEmittedProjection10,
  'legacy.result.positive.1.1': legacyEmittedProjection11,
  'legacy.result.positive.1.2': legacyEmittedProjection12,
});

/**
 * Return a fresh copy of one fixture. A copy is built per call so a test may
 * mutate, delete or tamper with a record without disturbing any other test.
 */
export function loadFixture(name) {
  const builder = BUILDERS[name];
  if (builder === undefined)
    throw Error(
      'Unknown contract fixture ' + JSON.stringify(name) +
        ' (expected one of ' + Object.keys(BUILDERS).sort().join(', ') + ')',
    );
  return structuredClone(builder());
}

/**
 * The names of one fixture set, in a stable order.
 *
 * The suite reaches a set through `FIXTURE_SETS`, which exports the names
 * themselves, so this accepts either a set key (`'identities'`) or the array of
 * names it holds. A name is accepted only when a builder exists for it, so a
 * mistyped set is reported rather than answered with an empty list.
 */
export function fixtureNames(set) {
  if (Array.isArray(set)) {
    const unknown = set.filter((name) => BUILDERS[name] === undefined);
    if (unknown.length > 0)
      throw Error(
        'Unknown contract fixture name(s) ' + unknown.join(', ') +
          ' (expected any of ' + Object.keys(BUILDERS).sort().join(', ') + ')',
      );
    return [...set];
  }
  const names = FIXTURE_SETS[set];
  if (names === undefined)
    throw Error(
      'Unknown contract fixture set ' + JSON.stringify(set) +
        ' (expected one of ' + Object.keys(FIXTURE_SETS).sort().join(', ') + ')',
    );
  return [...names];
}

export { FIXTURE_SETS };
