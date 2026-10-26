/**
 * Contract tests for the neutral schema/manifest layer.
 *
 * Self-contained: only Node builtins and the module under test, plus the
 * repository's locally installed Ajv2020 used by the dedicated schema-compile
 * parity test (test-only; the core module keeps no import of it), and the
 * released identity layer's `hashEntries` used only by the digest-parity test
 * (the preserved tree algorithm both C1 modules must agree on). No DSH
 * import, no owner configuration lookup, no network, no read or write of
 * repository evidence by these tests. All identities, run IDs, paths and
 * legacy structures are synthetic and sanitised; the historical fixtures
 * mirror the supported telemetry/result shapes only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  NEUTRAL_CONTRACT_VERSION,
  SUPPORTED_SCHEMA_MAJOR,
  NEUTRAL_CONTRACT_KINDS,
  LEGACY_RESULT_SCHEMA_VERSIONS,
  LEGACY_TRUST_CEILING,
  MEASUREMENT_KINDS,
  MEASUREMENT_UNITS,
  LIFECYCLE_STATES,
  EVALUATION_TRUSTS,
  EVALUATOR_EXECUTION_STATUSES,
  HUMAN_REVIEW_STATUSES,
  RUN_STATUSES,
  STOP_RESULTS,
  EVALUATOR_EXPOSURES,
  EVALUATOR_TRANSPARENCIES,
  SECURITY_MODELS,
  MAX_SELF_ISSUED_EVALUATION_TRUST,
  LEGACY_SOURCE_FIELD,
  LEGACY_ENVELOPE_MARKER,
  ContractValidationError,
  validateRecord,
  createRunManifest,
  readLegacyResult,
  isLegacyEnvelope,
  canonicalJson,
  sha256Hex,
  computeTreeDigest,
  identityDigestOf,
  parseDerivation,
} from '../../packages/core/manifest.mjs';
import { hashEntries } from '../../packages/core/identity.mjs';
import { loadFixture, fixtureNames, FIXTURE_SETS } from './fixtures/contracts/index.mjs';

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Deep clone so a validator can never mutate the fixture it is handed. */
const clone = (value) => structuredClone(value);

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The outcome-bearing object the legacy reader preserves for a source, mirroring
 * the reader's authentic-location selection: the whole emitted projection when it
 * carries top-level numeric quality or outcome/authority fields, a nested metrics
 * or quality object when it recorded its outcome there, otherwise the run object.
 */
function expectedOutcomeFor(source) {
  if (
    Object.hasOwn(source, 'quality') ||
    ['validOutcome', 'officialOutcomeValid', 'officialOutcomeEligible', 'currentExecutionBound',
      'official', 'eligibleForFormalComparison', 'eligibleForCalibrationAcceptance',
      'supervisionValid', 'terminationProven', 'stopConfirmed', 'outcomeClass',
    ].some((flag) => Object.hasOwn(source, flag))
  ) {
    return source;
  }
  return source.metrics ?? source.quality ?? source.run ?? source;
}

/* -------------------------------------------------------------------------- */
/* Identity families stay distinct and bind what they describe               */
/* -------------------------------------------------------------------------- */

test('each neutral family has its own schema, id and version field', () => {
  assert.deepEqual(NEUTRAL_CONTRACT_KINDS, [
    'ToolingIdentity',
    'ChallengeIdentity',
    'EvaluatorIdentity',
    'RunManifest',
    'FrozenSubmission',
    'Measurement',
    'Result',
  ]);

  const tooling = loadFixture('tooling.identity');
  const challenge = loadFixture('challenge.identity');
  const evaluator = loadFixture('evaluator.identity');

  assert.equal(validateRecord('ToolingIdentity', tooling).toolingId, tooling.toolingId);
  assert.equal(validateRecord('ChallengeIdentity', challenge).challengeId, challenge.challengeId);
  assert.equal(validateRecord('EvaluatorIdentity', evaluator).evaluatorId, evaluator.evaluatorId);

  /* Each family names a different identity domain and a different version field. */
  assert.ok(!('toolingVersion' in challenge));
  assert.ok(!('evaluatorVersion' in tooling));
  assert.ok(!('challengeVersion' in tooling));
  assert.ok(!('toolingVersion' in challenge));
  assert.ok(!Object.hasOwn(challenge, 'toolingId'));

  /* A tooling record can not be read as a challenge, run or result record. */
  assert.throws(() => validateRecord('ChallengeIdentity', tooling), /must be ChallengeIdentity/);
  assert.throws(() => validateRecord('RunManifest', tooling), /must be RunManifest/);
  assert.throws(() => validateRecord('Result', evaluator), /must be Result/);
  assert.throws(() => validateRecord('NotAKind', tooling), /Unknown contract kind/);
});

test('separately bound version domains keep their strings; no cross-domain order is imposed', () => {
  const challenge = loadFixture('challenge.identity');
  assert.notEqual(challenge.challengeVersion, '0.1');
  assert.notEqual(challenge.candidateLineage.candidateVersion, '0.1');
  assert.notEqual(challenge.workloadDigest, loadFixture('tooling.identity').installedDigest);

  /* The candidate lineage is preserved data, not an ordering gate: a candidate
   * version string that predates the challenge is carried exactly as the
   * historical record stated it. Tooling, challenge, evaluator and
   * candidate versions are separate named domains bound by identity IDs,
   * architecture bindings and sealed digests — never by comparing version
   * strings across domains (the independent review explicitly declined this
   * ordering as a non-approved architecture rule). */
  const earlyCandidate = clone(challenge);
  earlyCandidate.candidateLineage.candidateVersion = '0.1';
  earlyCandidate.workloadDigest = computeTreeDigest(earlyCandidate.starterInventory);
  assert.equal(validateRecord('ChallengeIdentity', earlyCandidate).candidateLineage.candidateVersion,
    '0.1');
  assert.equal(
    createRunManifest({
      manifestId: 'mf-88888888-8888-4888-8888-888888888888',
      runId: 'bb-syn-run-008',
      createdAt: '2026-03-01T14:00:00.000Z',
      architectureId: 'arch-run-synthetic',
      harness: 'manual',
      participantWorkspaceRoot: '/synthetic-workspace/bb-syn-run-008',
      evidenceRoot: '/synthetic-evidence/bb-syn-run-008',
      toolingIdentity: loadFixture('tooling.identity'),
      challengeIdentity: earlyCandidate,
      evaluatorIdentity: loadFixture('evaluator.identity'),
    }).bindings.challenge.candidateVersion,
    '0.1',
    'the preserved early candidate lineage string survives into the sealed manifest verbatim',
  );

  const wrongTooling = clone(challenge);
  wrongTooling.toolingVersion = '0.1';
  assert.throws(() => validateRecord('ToolingIdentity', wrongTooling), /unexpected property/);
});

test('challenge identity preserves the original candidate lineage', () => {
  const challenge = loadFixture('challenge.identity');
  const lineage = challenge.candidateLineage;

  /* The original candidate fields survive unchanged alongside the new
   * architecture binding instead of being overwritten by it. */
  assert.equal(lineage.candidateVersion, '1.0.0-candidate.9');
  assert.equal(lineage.candidateStatus, 'REVIEW_FINDINGS_UNRESOLVED');
  assert.equal(lineage.reviewStatus, 'CHANGES_REQUESTED');
  assert.match(lineage.sourceCommit, /^[0-9a-f]{7,64}$/);
  assert.equal(typeof lineage.reviewPacketDigest, 'string');
  assert.equal(typeof lineage.evidenceManifestDigest, 'string');

  const verified = validateRecord('ChallengeIdentity', challenge);
  assert.deepEqual(verified.candidateLineage, lineage);

  /* An incomplete lineage record is refused rather than quietly completed. */
  const missing = clone(challenge);
  delete missing.candidateLineage.sourceCommit;
  assert.throws(() => validateRecord('ChallengeIdentity', missing), /sourceCommit/);
});

test('identities carry the architecture binding fields', () => {
  for (const name of fixtureNames(FIXTURE_SETS.identities)) {
    const identity = loadFixture(name);
    const verified = validateRecord(identity.kind, identity);
    assert.equal(typeof verified.architectureId, 'string');
    assert.equal(typeof verified.architectureKind, 'string');
    assert.equal(verified.hashAlgorithm, 'sha256');
    assert.equal(typeof verified.definitionDigest, 'string');
    assert.equal(verified.digestProvenance.kind, 'COMPUTED');
    assert.match(verified.definitionDigest, /^[0-9a-f]{64}$/);
  }
});

/* -------------------------------------------------------------------------- */
/* Structural rejection of malformed and unsupported records                 */
/* -------------------------------------------------------------------------- */

test('malformed records are rejected with every problem listed', () => {
  const good = loadFixture('run.manifest');
  const bad = clone(good);
  bad.schemaVersion = 'nope';
  delete bad.runId;
  bad.bindings.tooling.toolingId = '';
  bad.configuration.harness = 12;

  /* Every problem the runtime detects is listed at once: the four structural
   * mutations plus the manifest digest, which no longer matches the bytes
   * recomputed from the mutated manifest. */
  assert.throws(() => validateRecord('RunManifest', bad), (error) => {
    assert.match(error.message, /5 problem\(s\)/);
    assert.match(error.message, /schemaVersion/);
    assert.match(error.message, /runId/);
    assert.match(error.message, /toolingId/);
    assert.match(error.message, /configuration\.harness/);
    assert.match(error.message, /manifestDigest/);
    return true;
  });

  for (const junk of [null, undefined, 0, '', [], true])
    for (const kind of NEUTRAL_CONTRACT_KINDS)
      assert.throws(() => validateRecord(kind, junk), /must be an object/);

  /* Closed schemas: unknown fields are a contract error, not a free pass. */
  const extra = clone(good);
  extra.monitoringNonce = 17;
  assert.throws(() => validateRecord('RunManifest', extra), /unexpected property/);
});

test('schema major is a discriminator; unknown major is rejected not coerced', () => {
  assert.equal(SUPPORTED_SCHEMA_MAJOR, 1);
  for (const kind of ['ToolingIdentity', 'ChallengeIdentity', 'EvaluatorIdentity', 'RunManifest']) {
    const record = clone(loadFixture(kind === 'ToolingIdentity' ? 'tooling.identity'
      : kind === 'ChallengeIdentity' ? 'challenge.identity'
        : kind === 'EvaluatorIdentity' ? 'evaluator.identity'
          : 'run.manifest'));
    for (const major of [0, 2, 9]) {
      const newer = clone(record);
      newer.schemaVersion = major + '.0.0';
      assert.throws(
        () => validateRecord(kind, newer),
        /unknown-major data is not coerced/,
        kind + ' with major ' + major,
      );
    }
  }

  const malformed = clone(loadFixture('tooling.identity'));
  for (const value of ['1', '1.0', '1.0.0.0', 'v1.0.0', '01.0.0', '1.00.0', '1.0.00', 1, null]) {
    const broken = clone(malformed);
    broken.schemaVersion = value;
    assert.throws(() => validateRecord('ToolingIdentity', broken), /schemaVersion/);
  }
});

test('compatible minor and patch versions still enforce every invariant', () => {
  for (const version of ['1.0.0', '1.1.0', '1.0.1', '1.4.2']) {
    const tooling = clone(loadFixture('tooling.identity'));
    tooling.schemaVersion = version;
    assert.equal(validateRecord('ToolingIdentity', tooling).schemaVersion, version);

    /* The compatible version is not an escape hatch: the same structural and
     * digest invariants still fail. */
    /* A well-formed but relabelled installed digest can not be detected by the
     * identity alone: no self digest is declared on this fixture (the binding
     * envelope carries the identity digest instead). What this family must
     * still enforce under a compatible minor is a corrupt digest and a forged
     * self digest, plus every structural invariant. */
    const corrupt = clone(tooling);
    corrupt.installedDigest = 'not-a-digest';
    assert.throws(() => validateRecord('ToolingIdentity', corrupt), /installedDigest/, version);

    const forged = clone(tooling);
    forged.installedDigest = sha('different-bytes');
    forged.identityDigest = sha('forged-self-digest');
    assert.throws(() => validateRecord('ToolingIdentity', forged), /identityDigest/, version);

    const missing = clone(tooling);
    delete missing.revision;
    assert.throws(() => validateRecord('ToolingIdentity', missing), /revision/, version);

    const smuggled = clone(tooling);
    smuggled.hostHome = 'C:\\Users\\someone';
    assert.throws(() => validateRecord('ToolingIdentity', smuggled), /unexpected property/, version);
  }

  /* A compatible minor on a challenge identity still recomputes the workload. */
  const bumped = clone(loadFixture('challenge.identity'));
  bumped.schemaVersion = '1.2.0';
  bumped.workloadDigest = sha('stale');
  assert.throws(() => validateRecord('ChallengeIdentity', bumped), /workloadDigest/);
});

/* -------------------------------------------------------------------------- */
/* Digest consistency, duplicates and immutable bindings                     */
/* -------------------------------------------------------------------------- */

test('digests are recomputed; corrupt or inconsistent records are rejected', () => {
  const challenge = clone(loadFixture('challenge.identity'));
  const recomputed = computeTreeDigest(challenge.starterInventory);
  assert.equal(challenge.workloadDigest, recomputed);

  challenge.starterInventory.push(['extra/file.txt', sha('extra')]);
  assert.throws(() => validateRecord('ChallengeIdentity', challenge), /workloadDigest/);

  const submission = clone(loadFixture('frozen.submission'));
  submission.treeDigest = sha('wrong-tree');
  assert.throws(() => validateRecord('FrozenSubmission', submission), /treeDigest/);

  const manifest = clone(loadFixture('run.manifest'));
  manifest.manifestDigest = sha('not-the-manifest');
  assert.throws(() => validateRecord('RunManifest', manifest), /manifestDigest/);

  /* The preserved algorithm: sha256 over canonical JSON of sorted pairs. */
  const pairs = [['b/two.txt', sha('2')], ['a/one.txt', sha('1')]];
  const expected = sha(JSON.stringify([['a/one.txt', sha('1')], ['b/two.txt', sha('2')]]));
  assert.equal(computeTreeDigest(pairs), expected);
  assert.equal(computeTreeDigest([pairs[1], pairs[0]]), expected);
  assert.notEqual(computeTreeDigest(pairs), sha(JSON.stringify(pairs)));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');

  assert.throws(() => computeTreeDigest([['a.txt', sha('1')], ['a.txt', sha('2')]]), /duplicate path/);
  assert.throws(() => computeTreeDigest([['C:\\x\\a.txt', sha('1')]]), TypeError);
});

test('computeTreeDigest rejects every non-exact path spelling instead of normalising it', () => {
  /* No path is ever rewritten: the backslash-only spelling (which the old
   * negative test hid behind a colon), leading ./, traversal, repeated
   * separators, trailing separators, absolute forms, dot-only paths, control
   * characters and case-colliding spellings are all refused before hashing. */
  for (const bad of [
    'a\\b.txt',
    'a/b\\c.txt',
    './a.txt',
    'a/./b.txt',
    'a/../b.txt',
    '..',
    '../a.txt',
    'a//b.txt',
    '//a.txt',
    'a/',
    '/',
    '/a.txt',
    'a/.',
    '.',
    'C:x/a.txt',
    'C:/x/a.txt',
    'a\u0000b.txt',
    'a\nb.txt',
    'a\u007fb.txt',
  ]) {
    assert.throws(
      () => computeTreeDigest([[bad, sha('x')]]),
      (error) => {
        assert.ok(
          error instanceof TypeError,
          `expected a TypeError for ${JSON.stringify(bad)}, got ${error?.name}`,
        );
        assert.match(error.message, /exact relative POSIX path/, bad);
        return true;
      },
      JSON.stringify(bad),
    );
  }
  /* Case-colliding distinct spellings are refused (they cannot coexist on a
   * case-insensitive volume), while equal-digest duplicates are truthfully a
   * duplicate-path refusal. */
  assert.throws(
    () => computeTreeDigest([['README.md', sha('one')], ['readme.md', sha('two')]]),
    /case-insensitive path collision/,
  );
  assert.throws(
    () => computeTreeDigest([['a/b.txt', sha('one')], ['A/B.TXT', sha('one')]]),
    /case-insensitive path collision/,
  );

  /* Unicode paths are data: they are sorted and hashed raw, never split into
   * segments or changed, and the digest is exactly the preserved algorithm. */
  const unicodePairs = [['fiö.txt', sha('unicode')], ['日本語/文書.txt', sha('unicode2')]];
  assert.equal(
    computeTreeDigest(unicodePairs),
    sha(JSON.stringify([unicodePairs[0], unicodePairs[1]])),
  );
  assert.equal(
    computeTreeDigest([unicodePairs[1], unicodePairs[0]]),
    computeTreeDigest(unicodePairs),
  );
  /* Parity with the identity layer: the same pairs hash to the same digest. */
  assert.equal(computeTreeDigest(unicodePairs), hashEntries(unicodePairs));
  assert.equal(
    computeTreeDigest([unicodePairs[1], unicodePairs[0]]),
    hashEntries([unicodePairs[1], unicodePairs[0]]),
  );
  /* The golden original hashes stay intact for exact spellings: the starter
   * inventory of the released challenge identity is unchanged, byte for byte. */
  const challenge = loadFixture('challenge.identity');
  assert.equal(computeTreeDigest(challenge.starterInventory), challenge.workloadDigest);
});

/* C1 SOTA2F1: one exact inventory path definition across the identity hash
 * primitive, the challenge/submission record validators and the compiled JSON
 * Schemas — every C0 control byte (U+0000–U+001F) and DEL (U+007F) spelling is
 * refused identically by all three surfaces, every other traversal/absolute/
 * redundant-segment trap stays refused, and the valid Unicode spellings keep
 * their exact digests with no normalisation or trimming anywhere. */
test('SOTA2F1 inventory path parity matrix: identity hashEntries, runtime validators and Ajv schemas agree per path', async () => {
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const ajv = new Ajv2020();
  const documentOf = (name) =>
    JSON.parse(fs.readFileSync(new URL(`../../schemas/${name}`, import.meta.url), 'utf8'));
  const validatesChallenge = ajv.compile(documentOf('challenge.schema.json'));
  const validatesSubmission = ajv.compile(documentOf('submission.schema.json'));

  const fileDigest = sha('parity');
  /* One representative from every C0 range neighbourhood plus DEL, one
   * absolute+NUL, the traversal set and the redundant-segment set; positives
   * carry real Unicode and whitespace data that must not be touched. */
  const cases = [
    /* ASCII control bytes — the parity gap the SOTA finding named, now
     * refused by every surface (previously only NUL was refused by the
     * identity hash while the schemas accepted every control byte). */
    ['\u0000nul.txt', false],
    ['bad\u000aline.txt', false],
    ['tab\u0009bed.txt', false],
    ['esc\u001bape.txt', false],
    ['del\u007fte.txt', false],
    /* Unterminated but already refused shapes stay refused in parity. */
    ['../escape.txt', false],
    ['a/../b.txt', false],
    ['a/./b.txt', false],
    ['a//b.txt', false],
    ['a/', false],
    ['/absolute.txt', false],
    ['..', false],
    ['.', false],
    ['nested\\windows.txt', false],
    ['C:/drive.txt', false],
    /* Valid data, hashed the exact same way by every surface. */
    ['Ünïcode/fïle.txt', true],
    ['日本語/文書.txt', true],
    ['plain/release 1.0.txt', true],
  ];

  /** A ChallengeIdentity whose starterInventory is exactly one [path, digest];
   * the workload digest is genuine for exact spellings and a placeholder for
   * refused ones (the refusal comes from the path rules, not from the helper
   * throwing inside the record builder). */
  const starterDigestOf = (relativePath) => {
    try {
      return computeTreeDigest([[relativePath, fileDigest]]);
    } catch {
      return sha('not-a-recomputed-starter-digest');
    }
  };
  const challengeWith = (relativePath) => {
    const record = clone(loadFixture('challenge.identity'));
    record.starterInventory = [[relativePath, fileDigest]];
    record.workloadDigest = starterDigestOf(relativePath);
    return record;
  };
  /** A FrozenSubmission whose inventory is exactly one [path, digest]. */
  const submissionWith = (relativePath) => {
    const record = clone(loadFixture('frozen.submission'));
    record.inventory = [[relativePath, fileDigest]];
    record.treeDigest = starterDigestOf(relativePath);
    record.fileCount = 1;
    return record;
  };
  /* computeTreeDigest throws TypeError on a malformed spelling; the workload
   * digest placeholder keeps the built record structurally complete so the
   * runtime refusal below always comes from the path rules themselves. */
  const attemptValidation = (kind, relativePath) => {
    const record = kind === 'ChallengeIdentity'
      ? challengeWith(relativePath)
      : submissionWith(relativePath);
    let ok = false;
    try {
      validateRecord(kind, clone(record));
      ok = true;
    } catch {
      ok = false;
    }
    return { ok };
  };
  const attemptIdentity = (relativePath) => {
    let ok = false;
    try {
      hashEntries([[relativePath, fileDigest]]);
      ok = true;
    } catch {
      ok = false;
    }
    return ok;
  };

  for (const [relativePath, expected] of cases) {
    /* Identity surface. */
    const identityOk = attemptIdentity(relativePath);
    /* Runtime validators (challenge starterInventory, submission inventory). */
    const challengeAttempt = attemptValidation('ChallengeIdentity', relativePath);
    const submissionAttempt = attemptValidation('FrozenSubmission', relativePath);
    /* Compiled Ajv schemas. */
    let challengeSchemaOk = false;
    let submissionSchemaOk = false;
    try {
      challengeSchemaOk = validatesChallenge(challengeWith(relativePath)) === true;
    } catch (error) {
      assert.fail(`Ajv2020 threw on ChallengeIdentity for ${JSON.stringify(relativePath)}: ${error.message}`);
    }
    try {
      submissionSchemaOk = validatesSubmission(submissionWith(relativePath)) === true;
    } catch (error) {
      assert.fail(`Ajv2020 threw on FrozenSubmission for ${JSON.stringify(relativePath)}: ${error.message}`);
    }
    assert.equal(identityOk, expected, `identity hashEntries ${JSON.stringify(relativePath)}`);
    assert.equal(challengeAttempt.ok, expected, `runtime ChallengeIdentity ${JSON.stringify(relativePath)}`);
    assert.equal(submissionAttempt.ok, expected, `runtime FrozenSubmission ${JSON.stringify(relativePath)}`);
    assert.equal(challengeSchemaOk, expected, `schema challenge.starterInventory ${JSON.stringify(relativePath)}`);
    assert.equal(submissionSchemaOk, expected, `schema FrozenSubmission.inventory ${JSON.stringify(relativePath)}`);
    if (expected) {
      const challengeRecord = validateRecord('ChallengeIdentity', challengeWith(relativePath));
      const submissionRecord = validateRecord('FrozenSubmission', submissionWith(relativePath));
      assert.equal(challengeRecord.workloadDigest, challengeWith(relativePath).workloadDigest,
        `the workload digest of ${JSON.stringify(relativePath)} is preserved byte-exactly`);
      assert.equal(hashEntries(submissionRecord.inventory), computeTreeDigest(submissionRecord.inventory),
        `identity and manifest digest ${JSON.stringify(relativePath)} agree exactly`);
    }
  }

  /* The golden original starter inventory stays untouched: the released
   * challenge identity still pins its exact starter26 workload digest and
   * hashEntries/computeTreeDigest still agree on it. */
  const released = loadFixture('challenge.identity');
  assert.equal(hashEntries(released.starterInventory), released.workloadDigest);
});

test('duplicate or unsorted inventory and identity entries are refused', () => {
  const duplicate = clone(loadFixture('frozen.submission'));
  duplicate.inventory = [
    ['a/one.txt', sha('1')],
    ['a/one.txt', sha('1')],
  ];
  assert.throws(() => validateRecord('FrozenSubmission', duplicate), /sorted by path with no duplicate/);

  const unsorted = clone(loadFixture('frozen.submission'));
  unsorted.inventory = [
    ['b/two.txt', sha('2')],
    ['a/one.txt', sha('1')],
  ];
  assert.throws(() => validateRecord('FrozenSubmission', unsorted), /sorted by path/);

  const mismatchedCount = clone(loadFixture('frozen.submission'));
  mismatchedCount.fileCount = 99;
  mismatchedCount.treeDigest = computeTreeDigest(mismatchedCount.inventory);
  assert.throws(() => validateRecord('FrozenSubmission', mismatchedCount), /fileCount/);

  const manifest = clone(loadFixture('run.manifest'));
  manifest.bindings.evaluator.evaluatorId = manifest.bindings.challenge.challengeId;
  assert.throws(() => validateRecord('RunManifest', manifest), /identities must be distinct/);

  const manifestArch = clone(loadFixture('run.manifest'));
  manifestArch.architectureId = manifestArch.bindings.challenge.architectureId;
  assert.throws(() => validateRecord('RunManifest', manifestArch), /collides with/);
});

test('host and owner paths can not be smuggled into a contract record', () => {
  const submission = clone(loadFixture('frozen.submission'));
  submission.inventory = [['C:\\Users\\someone\\plan.md', sha('x')]];
  assert.throws(() => validateRecord('FrozenSubmission', submission), /forward-slash POSIX/);

  const traversal = clone(loadFixture('frozen.submission'));
  traversal.inventory = [['../../outside/plan.md', sha('x')]];
  assert.throws(() => validateRecord('FrozenSubmission', traversal), /\. or \.\./);

  const absolute = clone(loadFixture('frozen.submission'));
  absolute.inventory = [['/etc/passwd', sha('x')]];
  assert.throws(() => validateRecord('FrozenSubmission', absolute), /relative, not absolute/);

  /* Manifest run roots are explicit host arguments recorded in the host's own
   * path syntax (manifest.mjs header and the fixture header say so): they are
   * not participant-relative inventory paths, and the explicit-root contract
   * requires a *native absolute* host root (POSIX /root, Windows C:\root or
   * UNC) rather than a bare non-empty string, so a host root here is required
   * data while a relative claim below is refused. The undeclared digest keeps
   * the root change from failing the recompute comparison. */
  const explicitRoot = clone(loadFixture('run.manifest'));
  delete explicitRoot.manifestDigest;
  explicitRoot.participantWorkspaceRoot = 'C:\\someone\\synthetic\\workspace';
  assert.equal(
    validateRecord('RunManifest', explicitRoot).participantWorkspaceRoot,
    'C:\\someone\\synthetic\\workspace',
  );
  const relativeRoot = clone(explicitRoot);
  relativeRoot.evidenceRoot = 'relative/evidence';
  assert.throws(() => validateRecord('RunManifest', relativeRoot), /native absolute host root/);
});

test('run roots are native absolute host roots and lexically disjoint', () => {
  /* The synthetic fixture itself is valid as written: POSIX absolute roots,
   * disjoint by construction. */
  const fixtureManifest = loadFixture('run.manifest');
  validateRecord('RunManifest', fixtureManifest);

  const variant = (workspace, evidence) => {
    const manifest = clone(loadFixture('run.manifest'));
    delete manifest.manifestDigest;
    manifest.participantWorkspaceRoot = workspace;
    manifest.evidenceRoot = evidence;
    return manifest;
  };

  /* Windows-native absolute roots and exact-but-sibling roots stay valid. */
  assert.equal(
    validateRecord('RunManifest', variant('C:\\synthetic\\run\\workspace', 'C:\\synthetic\\run\\workspace2'))
      .evidenceRoot,
    'C:\\synthetic\\run\\workspace2',
  );
  assert.equal(
    validateRecord('RunManifest', variant('/synthetic/run/workspace', 'C:\\synthetic\\run\\workspace'))
      .evidenceRoot,
    'C:\\synthetic\\run\\workspace',
  );

  /* Evidence located inside the workspace — or borderline-equal to it — is
   * refused: the two roots must be disjoint at a separator boundary. */
  assert.throws(
    () => validateRecord('RunManifest',
      variant('C:\\synthetic\\run\\workspace', 'C:\\synthetic\\run\\workspace\\evidence')),
    /overlaps participantWorkspaceRoot/,
  );
  assert.throws(
    () => validateRecord('RunManifest',
      variant('C:\\synthetic\\run\\workspace', 'C:\\synthetic\\run\\workspace')),
    /overlaps participantWorkspaceRoot/,
  );
  /* Separator syntax is not a loophole: mixing \ and / still overlaps. */
  assert.throws(
    () => validateRecord('RunManifest',
      variant('C:\\synthetic\\run\\workspace', 'C:/synthetic/run/workspace/evidence')),
    /overlaps participantWorkspaceRoot/,
  );
  /* POSIX-absolute overlap is refused the same way. */
  assert.throws(
    () => validateRecord('RunManifest',
      variant('/synthetic/run/workspace', '/synthetic/run/workspace/evidence')),
    /overlaps participantWorkspaceRoot/,
  );
});

test('identity bindings are immutable: a re-bound digest is rejected', () => {
  const manifest = clone(loadFixture('run.manifest'));
  const otherTooling = clone(loadFixture('tooling.identity'));
  otherTooling.revision = 'ffffffff';
  otherTooling.installedDigest = sha('other-install');
  manifest.bindings.tooling.toolingIdentityDigest = identityDigestOf(otherTooling);

  /* A binding envelope carries no separate signature, so the digest that
   * detects a re-binding is the manifest digest: declared over the original
   * binding bytes, it no longer matches the recomputation over the re-bound
   * manifest and the record is refused. The self-check covers every binding
   * field at once, which is what keeps a re-bound identity undecodable. */
  assert.throws(() => validateRecord('RunManifest', manifest), /manifestDigest/);

  const submission = clone(loadFixture('frozen.submission'));
  submission.manifestId = 'mf-00000000-0000-4000-8000-000000000000';
  /* The submission still validates structurally, which is why the result layer
   * must re-check bindings; prove the manifest itself cannot be re-bound. */
  assert.equal(validateRecord('FrozenSubmission', submission).manifestId, submission.manifestId);

  const result = clone(loadFixture('result.selfassessment'));
  result.bindings.frozenSubmissionId = 'sub-00000000-0000-4000-8000-000000000000';
  assert.throws(() => validateRecord('Result', result), /frozenSubmissionId/);
});

/* -------------------------------------------------------------------------- */
/* createRunManifest                                                          */
/* -------------------------------------------------------------------------- */

test('createRunManifest seals derived bindings and recomputes its digest', () => {
  const tooling = loadFixture('tooling.identity');
  const challenge = loadFixture('challenge.identity');
  const evaluator = loadFixture('evaluator.identity');

  const manifest = createRunManifest({
    manifestId: 'mf-11111111-1111-4111-8111-111111111111',
    runId: 'bb-syn-run-001',
    createdAt: '2026-03-01T09:00:00.000Z',
    architectureId: 'arch-run-synthetic',
    architectureKind: 'run',
    harness: 'manual',
    securityModel: 'COOPERATIVE_WORKSPACE_NO_ADVERSARIAL_OS_CONTAINMENT',
    declaredCeilingMinutes: 45,
    participantWorkspaceRoot: '/synthetic-workspace/bb-syn-run-001',
    evidenceRoot: '/synthetic-evidence/bb-syn-run-001',
    toolingIdentity: tooling,
    challengeIdentity: challenge,
    evaluatorIdentity: evaluator,
  });

  assert.equal(manifest.bindings.challenge.workloadDigest, challenge.workloadDigest);
  assert.equal(manifest.bindings.challenge.candidateVersion, '1.0.0-candidate.9');
  assert.equal(manifest.bindings.tooling.toolingVersion, tooling.toolingVersion);
  assert.equal(
    manifest.bindings.challenge.challengeIdentityDigest,
    identityDigestOf(validateRecord('ChallengeIdentity', challenge)),
  );
  assert.equal(manifest.manifestDigest, identityDigestOf(manifest));
  assert.equal(validateRecord('RunManifest', manifest).manifestId, manifest.manifestId);
  assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.bindings));

  assert.throws(
    () => {
      'use strict';
      manifest.bindings.runId = 'bb-other';
    },
    TypeError,
  );

  /* Unknown configuration stays null and is listed, never defaulted to zero. */
  const partial = createRunManifest({
    manifestId: 'mf-22222222-2222-4222-8222-222222222222',
    runId: 'bb-syn-run-002',
    createdAt: '2026-03-01T10:00:00.000Z',
    architectureId: 'arch-run-synthetic',
    harness: 'manual',
    participantWorkspaceRoot: '/synthetic-workspace/bb-syn-run-002',
    evidenceRoot: '/synthetic-evidence/bb-syn-run-002',
    configuration: { harness: 'manual', model: null, location: null, os: 'win32', nodeVersion: null },
    toolingIdentity: tooling,
    challengeIdentity: challenge,
    evaluatorIdentity: evaluator,
  });
  assert.equal(partial.configuration.model, null);
  assert.equal(partial.configuration.location, null);
  assert.notEqual(partial.configuration.model, 0);
  assert.notEqual(partial.configuration.location, '');
  assert.deepEqual(partial.configuration.unknownFields, ['location', 'model', 'nodeVersion']);
});

test('createRunManifest rejects collisions, forged inputs and unknown input', () => {
  const tooling = loadFixture('tooling.identity');
  const challenge = loadFixture('challenge.identity');
  const evaluator = loadFixture('evaluator.identity');
  const base = {
    manifestId: 'mf-33333333-3333-4333-8333-333333333333',
    runId: 'bb-syn-run-003',
    createdAt: '2026-03-01T11:00:00.000Z',
    architectureId: 'arch-run-synthetic',
    harness: 'manual',
    participantWorkspaceRoot: '/synthetic-workspace/bb-syn-run-003',
    evidenceRoot: '/synthetic-evidence/bb-syn-run-003',
    toolingIdentity: tooling,
    challengeIdentity: challenge,
    evaluatorIdentity: evaluator,
  };

  /* The candidate lineage is preserved verbatim into the sealed manifest: a
   * candidate version string is data on its own release train, not a
   * cross-domain ordering input (see the dedicated domain test above). */
  const earlyCandidate = clone(challenge);
  earlyCandidate.candidateLineage.candidateVersion = '0.1';
  assert.equal(
    createRunManifest({ ...base, challengeIdentity: earlyCandidate })
      .bindings.challenge.candidateVersion,
    '0.1',
    'the preserved candidate lineage string is sealed untouched',
  );

  const sameId = clone(challenge);
  sameId.challengeId = tooling.toolingId;
  assert.throws(() => createRunManifest({ ...base, challengeIdentity: sameId }), /IDs must be distinct/);

  const reuseArch = clone(base);
  reuseArch.architectureId = challenge.architectureId;
  assert.throws(() => createRunManifest(reuseArch), /must not be the same as the challenge architecture/);

  assert.throws(
    () => createRunManifest({ ...base, declaredCeilingMinutes: 900 }),
    /exceeds the ceiling bound by the challenge identity/,
  );

  assert.throws(() => createRunManifest({ ...base, watchdogNonce: 5 }), /unrecognised input/);
  assert.throws(() => createRunManifest({ ...base, toolingIdentity: evaluator }), /must be ToolingIdentity/);

  const broken = clone(challenge);
  broken.workloadDigest = sha('forged');
  assert.throws(() => createRunManifest({ ...base, challengeIdentity: broken }), /workloadDigest/);
});

test('separately bound identities keep their version domains; equal strings stay valid', () => {
  /* Tooling, challenge, evaluator and candidate versions are separate named
   * domains; a shared version string never conflates them, and the identities
   * stay bound by their distinct IDs and identity digests instead. */
  const tooling = clone(loadFixture('tooling.identity'));
  tooling.toolingVersion = '1.0.0';
  const challenge = clone(loadFixture('challenge.identity'));
  challenge.challengeVersion = '1.0.0';
  challenge.candidateLineage.candidateVersion = '1.0.0';
  const evaluator = clone(loadFixture('evaluator.identity'));
  evaluator.evaluatorVersion = '1.0.0';

  const manifest = createRunManifest({
    manifestId: 'mf-77777777-7777-4777-8777-777777777777',
    runId: 'bb-syn-run-007',
    createdAt: '2026-03-01T13:00:00.000Z',
    architectureId: 'arch-run-synthetic',
    harness: 'manual',
    participantWorkspaceRoot: '/synthetic-workspace/bb-syn-run-007',
    evidenceRoot: '/synthetic-evidence/bb-syn-run-007',
    toolingIdentity: tooling,
    challengeIdentity: challenge,
    evaluatorIdentity: evaluator,
  });
  assert.equal(manifest.bindings.tooling.toolingVersion, '1.0.0');
  assert.equal(manifest.bindings.challenge.challengeVersion, '1.0.0');
  assert.equal(manifest.bindings.challenge.candidateVersion, '1.0.0');
  assert.equal(manifest.bindings.evaluator.evaluatorVersion, '1.0.0');
  assert.equal(validateRecord('RunManifest', manifest).manifestId, manifest.manifestId);

  /* The same holds for a hand-built binding, while the ID distinctness and
   * digest-binding gates around it stay active. */
  const raw = clone(loadFixture('run.manifest'));
  delete raw.manifestDigest;
  raw.bindings.tooling.toolingVersion = '1.0.0';
  raw.bindings.challenge.challengeVersion = '1.0.0';
  raw.bindings.challenge.candidateVersion = '1.0.0';
  raw.bindings.evaluator.evaluatorVersion = '1.0.0';
  assert.equal(validateRecord('RunManifest', raw).schemaVersion, '1.0.0');

  const collide = clone(raw);
  collide.bindings.evaluator.evaluatorId = collide.bindings.challenge.challengeId;
  assert.throws(() => validateRecord('RunManifest', collide), /identities must be distinct/);
  const rebound = clone(loadFixture('run.manifest'));
  rebound.manifestDigest = sha('not-this-manifest');
  assert.throws(() => validateRecord('RunManifest', rebound), /manifestDigest/);
});

/* -------------------------------------------------------------------------- */
/* Measurements: honest provenance, and null is not zero                     */
/* -------------------------------------------------------------------------- */

test('measurements record kind, value and source as one honest story', () => {
  for (const name of fixtureNames(FIXTURE_SETS.measurements)) {
    const measurement = loadFixture(name);
    const verified = validateRecord('Measurement', measurement);
    if (measurement.measurementKind === 'UNAVAILABLE') {
      assert.equal(verified.value, null);
      assert.equal(verified.source, null);
    } else {
      assert.notEqual(verified.value, null);
      assert.notEqual(verified.source, null);
    }
  }

  const unavailable = loadFixture('measurement.unavailable');
  assert.equal(unavailable.value, null);

  /* Claiming a source for an unmeasured value is refused. */
  const lie = clone(unavailable);
  lie.source = { kind: 'COMPUTED', procedure: 'claimed a measurement that never happened' };
  assert.throws(() => validateRecord('Measurement', lie), /must not claim a source/);

  /* Null is not silently replaced by zero. */
  const zeroed = clone(unavailable);
  zeroed.value = 0;
  assert.throws(() => validateRecord('Measurement', zeroed), /must be null rather than a number/);

  const missing = clone(unavailable);
  delete missing.value;
  assert.throws(() => validateRecord('Measurement', missing), /value.*required|value: required/);

  /* A measured value can not rest on a self-assessment source. */
  const measured = loadFixture('measurement.elapsedWall');
  const selfClaim = clone(measured);
  selfClaim.source = { kind: 'SELF_ASSESSMENT', procedure: 'looked at the clock' };
  assert.throws(() => validateRecord('Measurement', selfClaim), /local ID, a local digest or a COMPUTED/);

  /* Entered data can not be laundered into a computation. */
  const entered = loadFixture('measurement.manualTokens');
  const laundered = clone(entered);
  laundered.source = { kind: 'COMPUTED', procedure: 'pretends to compute' };
  assert.throws(() => validateRecord('Measurement', laundered), /can not be reported as COMPUTED/);

  /* The derivation is one stable representation: the formula string is what
   * the wire, the runtime, the schema and the declarations all carry, so a
   * validated DERIVED measurement can always validate again. */
  const derived = loadFixture('measurement.tokensPerSecond');
  const parsedDerivation = parseDerivation('{manualUsageCount} / {elapsedWallSeconds}');
  assert.deepEqual(parsedDerivation.inputs, ['manualUsageCount', 'elapsedWallSeconds']);
  assert.equal(parsedDerivation.formula, '{manualUsageCount} / {elapsedWallSeconds}');
  assert.equal(validateRecord('Measurement', derived).derivation,
    '{manualUsageCount} / {elapsedWallSeconds}');
  const badFormula = clone(derived);
  badFormula.derivation = '1 {a} and {b#c}';
  assert.throws(() => validateRecord('Measurement', badFormula), /placeholders are not well formed/);
  const repeated = clone(derived);
  repeated.derivation = '{a} + {a}';
  assert.throws(
    () => validateRecord('Measurement', repeated),
    /a repeated input must be an explicit dependency/,
  );
  assert.throws(() => parseDerivation('1 {a} and {b#c}'), /placeholders are not well formed/);
  assert.throws(() => parseDerivation(42), TypeError);

  const badDerived = clone(derived);
  delete badDerived.derivation;
  assert.throws(() => validateRecord('Measurement', badDerived), /must name its inputs/);

  const unitless = clone(derived);
  unitless.unit = 'lightyears';
  assert.throws(() => validateRecord('Measurement', unitless), /unit/);
});

/* C1 SOTA2F2: the DERIVED formula domain is one shared grammar — the runtime
 * validator, the parseDerivation helper and the compiled JSON Schema all
 * enforce the same structural rule (at least one whole {metricName}
 * placeholder, no empty/placeholder-free/whitespace-only formula, no
 * unmatched/nested braces), and the valid grammar keeps whitespace text as
 * data exactly as written with no content normalisation. The runtime semantic
 * extras (repeated inputs, measurementKind coupling) stay runtime-only and
 * are asserted separately. */
test('SOTA2F2 formula parity: runtime, helper and schema enforce one derivation grammar', async () => {
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const schema = JSON.parse(
    fs.readFileSync(new URL('../../schemas/measurement.schema.json', import.meta.url), 'utf8'),
  );
  const ajv = new Ajv2020();
  const validatesMeasurement = ajv.compile(schema);

  const derived = loadFixture('measurement.tokensPerSecond');
  const cases = [
    /* Valid grammar (whitespace text is data; adjacency and spacing agree). */
    ['{a}', true],
    ['{a} + {b}', true],
    ['  {a}  ', true],
    ['{manualUsageCount} / {elapsedWallSeconds}', true],
    ['{speed} and {timeSoFar} over {fileCount}', true],
    /* Empty / placeholder-free / whitespace-only. */
    ['', false],
    ['   ', false],
    ['no placeholder here', false],
    /* Unmatched, nested and stray braces. */
    ['{a', false],
    ['a}', false],
    ['{a}}', false],
    ['}{{', false],
    ['{{a}}', false],
    ['{a} and {b', false],
    /* Malformed token interiors. */
    ['{a }', false],
    ['{ }', false],
    ['{ a }', false],
    ['{NotCamel}', false],
  ];
  for (const [formula, expected] of cases) {
    const record = clone(derived);
    record.derivation = formula;
    let runtimeOk = false;
    let runtimeMessage = '';
    try {
      validateRecord('Measurement', clone(record));
      runtimeOk = true;
    } catch (error) {
      runtimeMessage = error.message;
    }
    let schemaOk = false;
    try {
      schemaOk = validatesMeasurement(clone(record)) === true;
    } catch (error) {
      assert.fail(`Ajv2020 threw instead of rejecting ${JSON.stringify(formula)}: ${error.message}`);
    }
    let helperOk = false;
    try {
      parseDerivation(formula);
      helperOk = true;
    } catch {
      helperOk = false;
    }
    assert.equal(runtimeOk, expected, `runtime ${JSON.stringify(formula)}; last error: ${runtimeMessage}`);
    assert.equal(schemaOk, expected, `schema ${JSON.stringify(formula)}`);
    assert.equal(helperOk, expected, `helper ${JSON.stringify(formula)}`);
  }

  /* Valid roundtrip: the grammar-preserving whitespace spacing ' {a} ' stays
   * exactly as written through validate, persist, read and revalidate. */
  const spaced = clone(derived);
  spaced.derivation = ' {a} ';
  const validatedSpacing = validateRecord('Measurement', clone(spaced));
  assert.equal(validatedSpacing.derivation, ' {a} ', 'no content normalisation of a valid formula');
  assert.equal(validatesMeasurement(spaced), true, 'the schema pattern keeps the same spelling valid');

  /* Literal whitespace-only text between two tokens is data, not grammar. */
  const spacedBetween = clone(derived);
  spacedBetween.derivation = '{a}   {b}';
  assert.doesNotThrow(() => parseDerivation('{a}   {b}'), 'whitespace between tokens is literal text');
  assert.equal(validatesMeasurement(spacedBetween), true,
    'whitespace-only text between two valid tokens stays valid under the same pattern');
});

test('a DERIVED measurement roundtrips validate→persist→read→validate on one stable representation', () => {
  /* The persistence envelope below is a sealed fixture over canonical bytes
   * verified with the module's own canonical-JSON digest helper: it lets the
   * focused suite prove the persist/read seam byte-honestly without importing
   * the storage layer; the released storage module carries the same identity
   * roundtrip in the integrated suite. */
  const sealEnvelope = (kind, id, value) => {
    const digest = sha256Hex(canonicalJson({ id, kind, value }));
    return {
      schemaVersion: 1,
      kind,
      id,
      value,
      digest,
    };
  };
  const unsealEnvelope = (envelope) => {
    const { digest, schemaVersion, kind, id, value } = envelope;
    void schemaVersion;
    assert.equal(sha256Hex(canonicalJson({ id, kind, value })), digest,
      'the read verifies the envelope bytes');
    return [kind, id, structuredClone(value)];
  };

  /* Standalone DERIVED record. */
  const derived = loadFixture('measurement.tokensPerSecond');
  const first = validateRecord('Measurement', structuredClone(derived));
  assert.equal(first.derivation, '{manualUsageCount} / {elapsedWallSeconds}');

  const persisted = sealEnvelope('manifest.roundtrip', first.measurementId, first);
  const persistedText = canonicalJson(persisted);
  const [readKind, readId, recorded] = unsealEnvelope(JSON.parse(persistedText));
  assert.equal(readKind, 'manifest.roundtrip');
  assert.equal(readId, first.measurementId);
  /* The persisted bytes read back validate again unchanged: stable wire,
   * stable runtime representation, null and provenance intact. */
  const second = validateRecord('Measurement', recorded);
  assert.deepEqual(second, first);
  assert.deepEqual(second.source, derived.source);
  assert.deepEqual(validateRecord('Measurement', second), second, 'validateRecord is idempotent');
  /* And the schema (compiled with the actual Ajv compiler in its parity test
   * below) accepts the same bytes both before and after the roundtrip. */

  /* A DERIVED measurement inside a Result. */
  const result = clone(loadFixture('result.selfassessment'));
  result.measurements.push({
    schemaVersion: NEUTRAL_CONTRACT_VERSION,
    kind: 'Measurement',
    measurementId: 'meas-syn-derived-rate',
    metric: 'tokensPerSecond',
    unit: 'ratio',
    measurementKind: 'DERIVED',
    value: 12.5,
    source: {
      kind: 'LOCAL_DIGEST',
      digest: result.bindings.treeDigest,
      procedure: 'fixtures/contracts:derived-from-two-measurements',
    },
    derivation: '{manualUsageCount} / {elapsedWallSeconds}',
    confidence: 0.75,
    recordedAt: '2026-03-01T10:30:00.000Z',
  });
  const validatedResult = validateRecord('Result', structuredClone(result));
  const derivedEntry = validatedResult.measurements
    .find((measurement) => measurement.measurementKind === 'DERIVED');
  assert.equal(derivedEntry.derivation, '{manualUsageCount} / {elapsedWallSeconds}');

  const resultEnvelope = sealEnvelope('manifest.roundtrip', validatedResult.resultId, validatedResult);
  const [, , recordedResult] = unsealEnvelope(JSON.parse(canonicalJson(resultEnvelope)));
  const revalidated = validateRecord('Result', recordedResult);
  assert.deepEqual(revalidated, validatedResult, 'the containing Result roundtrips unchanged');
  const recordDerivation = revalidated.measurements
    .find((measurement) => measurement.measurementKind === 'DERIVED')?.derivation;
  assert.equal(recordDerivation, '{manualUsageCount} / {elapsedWallSeconds}');
  assert.deepEqual(
    parseDerivation(recordDerivation).inputs,
    ['manualUsageCount', 'elapsedWallSeconds'],
    'the parsed inputs helper reads the same stable string after the roundtrip',
  );

  /* Null/provenance honesty survives the same roundtrip. */
  const unavailable = validateRecord('Measurement', loadFixture('measurement.unavailable'));
  assert.equal(unavailable.value, null);
  assert.equal(unavailable.source, null);
  const sealedNull = unsealEnvelope(JSON.parse(canonicalJson(
    sealEnvelope('manifest.roundtrip', unavailable.measurementId, unavailable),
  )));
  assert.deepEqual(sealedNull[2], unavailable, 'null stays null through persist and read');
});

/* SOTA3 F1/F2: real compiler and public runtime, not a schema-shaped stub.
 * Equality/binding checks remain runtime semantic extras: JSON Schema cannot
 * compare a measurement's ID/digest to surrounding Result property values. */
async function sourceStatusValidators() {
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const measurement = JSON.parse(fs.readFileSync(new URL('../../schemas/measurement.schema.json', import.meta.url), 'utf8'));
  const result = JSON.parse(fs.readFileSync(new URL('../../schemas/result.schema.json', import.meta.url), 'utf8'));
  ajv.addSchema(measurement);
  return { Measurement: ajv.getSchema(measurement.$id), Result: ajv.compile(result) };
}

function assertContractCase(validators, kind, record, expected, label) {
  assert.equal(validators[kind](clone(record)), expected,
    `${label}: actual Ajv2020 ${JSON.stringify(validators[kind].errors)}`);
  if (!expected) {
    assert.throws(() => validateRecord(kind, clone(record)), undefined, `${label}: runtime rejects`);
    return;
  }
  const first = validateRecord(kind, clone(record));
  assert.equal(validators[kind](first), true, `${label}: projected schema bytes`);
  assert.deepEqual(validateRecord(kind, JSON.parse(canonicalJson(first))), first,
    `${label}: canonical JSON read/revalidate preserves honest values`);
}

test('SOTA3 F1 complete status matrix rejects fabricated final scores and failed evaluators', async () => {
  const validators = await sourceStatusValidators();
  const absent = Symbol('absent');
  const statuses = ['HUMAN_REVIEW_PENDING', 'INVALID', 'SCORED'];
  const eligibilities = ['ELIGIBLE_NOT_RUN', 'ELIGIBLE_PENDING_HUMAN_REVIEW', 'INELIGIBLE', 'SCORED'];
  const executions = ['SUCCESS', 'FAILURE', 'INFRASTRUCTURE_ERROR', null, absent];
  const reviews = ['NOT_REVIEWED', 'SCORED', absent];
  const reviewers = ['reviewer-synthetic', null, absent, '', '   '];
  const components = [0, 81, null, absent];
  let checked = 0;
  for (const status of statuses) for (const eligibility of eligibilities)
    for (const execution of executions) for (const review of reviews)
      for (const reviewer of reviewers) for (const humanUI of components)
        for (const final of components) {
          const record = clone(loadFixture('result.localscored'));
          record.quality.status = status;
          record.scoreEligibility = eligibility;
          if (execution === absent) delete record.evaluatorExecution;
          else record.evaluatorExecution = execution;
          if (review === absent) delete record.humanReview.reviewStatus;
          else record.humanReview.reviewStatus = review;
          if (reviewer === absent) delete record.humanReview.reviewer;
          else record.humanReview.reviewer = reviewer;
          /* The original fixture's reviewedAt is real only with a scored review. */
          if (review !== 'SCORED') delete record.humanReview.reviewedAt;
          if (humanUI === absent) delete record.quality.humanUI;
          else record.quality.humanUI = humanUI;
          if (final === absent) delete record.quality.quality;
          else record.quality.quality = final;
          const scored = status === 'SCORED';
          const numericUI = typeof humanUI === 'number';
          const numericFinal = typeof final === 'number';
          const named = typeof reviewer === 'string' && reviewer.trim().length > 0;
          const expected = review !== absent && reviewer !== '' &&
            (scored === (eligibility === 'SCORED')) &&
            (status !== 'INVALID' || eligibility === 'INELIGIBLE') &&
            (!scored || (execution === 'SUCCESS' && review === 'SCORED' && named && numericUI && numericFinal)) &&
            (scored || !numericFinal) &&
            (review === 'SCORED' || !numericUI) &&
            (!numericUI || named) &&
            (eligibility !== 'ELIGIBLE_NOT_RUN' || !numericUI);
          const label = JSON.stringify([status, eligibility, execution === absent ? 'missing' : execution,
            review === absent ? 'missing' : review, reviewer === absent ? 'missing' : reviewer,
            humanUI === absent ? 'missing' : humanUI, final === absent ? 'missing' : final]);
          assertContractCase(validators, 'Result', record, expected, label);
          checked++;
        }
  assert.equal(checked, 14400, 'every cross-axis/zero/null/missing combination exercised');
  for (const fixture of ['result.localscored', 'result.selfassessment'])
    assertContractCase(validators, 'Result', loadFixture(fixture), true, fixture);
  const zero = clone(loadFixture('result.localscored'));
  zero.quality.humanUI = 0;
  zero.quality.quality = 0;
  assertContractCase(validators, 'Result', zero, true, 'zero is scored, not missing');
  for (const [field, value] of [['lifecycle', 'DRAFT'], ['runStatus', 'ABORTED'],
    ['runStatus', 'SEEDED_NOT_STARTED'], ['limitations', []]]) {
    const record = clone(zero);
    record[field] = value;
    assertContractCase(validators, 'Result', record, false, `existing scored gate ${field}`);
  }
  for (const value of [null, absent]) {
    const record = clone(zero);
    if (value === absent) delete record.humanReview;
    else record.humanReview = value;
    assertContractCase(validators, 'Result', record, false, 'missing/null review object');
  }
});

test('SOTA3 F2 discriminated source matrix enforces complete non-null references standalone and in Result', async () => {
  const validators = await sourceStatusValidators();
  const bindings = loadFixture('result.selfassessment').bindings;
  const id = { recordKind: 'RunManifest', recordId: bindings.manifestId };
  const digest = bindings.treeDigest;
  const procedure = 'synthetic:observed-procedure';
  const cases = [
    ['ID pair', { kind: 'LOCAL_ID', ...id, procedure }, true],
    ['ID with digest', { kind: 'LOCAL_ID', ...id, digest, procedure }, true],
    ['digest', { kind: 'LOCAL_DIGEST', digest, procedure }, true],
    ['digest with pair', { kind: 'LOCAL_DIGEST', digest, ...id, procedure }, true],
  ];
  for (const kind of ['COMPUTED', 'SELF_ASSESSMENT', 'LOCAL_PROCEDURE']) {
    cases.push([`${kind} pure procedure`, { kind, procedure }, true]);
    cases.push([`${kind} pair`, { kind, ...id, procedure }, true]);
    cases.push([`${kind} digest`, { kind, digest, procedure }, true]);
    cases.push([`${kind} pair + digest`, { kind, ...id, digest, procedure }, true]);
  }
  for (const kind of ['LOCAL_ID', 'LOCAL_DIGEST', 'COMPUTED', 'SELF_ASSESSMENT', 'LOCAL_PROCEDURE']) {
    const base = { kind, procedure, ...(kind === 'LOCAL_ID' ? id : {}),
      ...(kind === 'LOCAL_DIGEST' ? { digest } : {}) };
    for (const [name, mutation] of [
      ['null ID', { recordId: null }], ['empty ID', { recordId: '' }],
      ['blank ID', { recordId: '   ' }], ['number ID', { recordId: 42 }],
      ['null kind', { recordKind: null }], ['unknown kind', { recordKind: 'NotARecord' }],
      ['null digest', { digest: null }], ['malformed digest', { digest: 'bad' }],
      ['uppercase digest', { digest: 'A'.repeat(64) }],
      ['null procedure', { procedure: null }], ['empty procedure', { procedure: '' }],
      ['blank procedure', { procedure: '   ' }],
    ]) cases.push([`${kind}: ${name}`, { ...base, ...mutation }, false]);
    const missingProcedure = { ...base }; delete missingProcedure.procedure;
    cases.push([`${kind}: missing procedure`, missingProcedure, false]);
    const missingId = { ...base, recordKind: 'RunManifest' }; delete missingId.recordId;
    cases.push([`${kind}: missing ID companion`, missingId, false]);
    const missingKind = { ...base, recordId: bindings.manifestId }; delete missingKind.recordKind;
    cases.push([`${kind}: missing kind companion`, missingKind, false]);
    if (kind === 'LOCAL_ID') {
      cases.push(['LOCAL_ID procedure cannot disguise no reference', { kind, procedure }, false]);
      cases.push(['LOCAL_ID digest cannot replace ID', { kind, digest, procedure }, false]);
    }
    if (kind === 'LOCAL_DIGEST') {
      cases.push(['LOCAL_DIGEST procedure cannot disguise no digest', { kind, procedure }, false]);
      cases.push(['LOCAL_DIGEST pair cannot replace digest', { kind, ...id, procedure }, false]);
    }
  }
  for (const [label, source, expected] of cases) {
    /* DERIVED permits every source discriminator; leave the stable formula
     * grammar untouched so this matrix isolates the source contract. */
    const record = clone(loadFixture('measurement.tokensPerSecond'));
    record.source = source;
    assertContractCase(validators, 'Measurement', record, expected, `${label} standalone`);
    const result = clone(loadFixture('result.selfassessment'));
    result.measurements = [record];
    assertContractCase(validators, 'Result', result, expected, `${label} containing Result`);
  }
  /* Source structure is valid but ID/digest equality requires the runtime.
   * Each allowable Result ID domain is checked, not just manifest/submission. */
  const idFields = { RunManifest: 'manifestId', FrozenSubmission: 'frozenSubmissionId',
    ToolingIdentity: 'toolingId', ChallengeIdentity: 'challengeId', EvaluatorIdentity: 'evaluatorId' };
  for (const kind of ['LOCAL_ID', 'LOCAL_DIGEST', 'COMPUTED', 'SELF_ASSESSMENT', 'LOCAL_PROCEDURE']) {
    for (const [recordKind, binding] of Object.entries(idFields)) {
      const result = clone(loadFixture('result.selfassessment'));
      const m = clone(loadFixture('measurement.tokensPerSecond'));
      m.source = { kind, procedure, recordKind, recordId: bindings[binding], digest };
      result.measurements = [m];
      assertContractCase(validators, 'Result', result, true, `${kind} bound ${recordKind}`);
      m.source.recordId = 'synthetic-unbound-id';
      assert.equal(validators.Result(result), true, 'schema only enforces source structure');
      assert.throws(() => validateRecord('Result', result), /does not match bindings/);
    }
    for (const [recordKind, recordId] of [['Measurement', 'synthetic-other-measurement'],
      ['Result', 'synthetic-other-result'], ['Result', 'result-syn-self-assessment']]) {
      const result = clone(loadFixture('result.selfassessment'));
      result.measurements = [{ ...loadFixture('measurement.tokensPerSecond'),
        source: { kind, procedure, recordKind, recordId, digest } }];
      assert.equal(validators.Result(result), true, 'schema has no cross-record ID comparison');
      assert.throws(() => validateRecord('Result', result), /bound by this result|own measurement/);
    }
    const result = clone(loadFixture('result.selfassessment'));
    result.measurements = [{ ...loadFixture('measurement.tokensPerSecond'),
      source: { kind, procedure, ...id, digest: sha('unbound-source') } }];
    assert.equal(validators.Result(result), true);
    assert.throws(() => validateRecord('Result', result), /not one of the identity digests/);
  }
  /* Existing measured/entered source-kind semantics are not loosened. */
  for (const kind of ['COMPUTED', 'SELF_ASSESSMENT', 'LOCAL_PROCEDURE']) {
    const record = clone(loadFixture('measurement.elapsedWall'));
    record.measurementKind = kind === 'COMPUTED' ? 'MEASURED' : 'ENTERED';
    record.source = { kind, procedure };
    assertContractCase(validators, 'Measurement', record, true, `honest ${record.measurementKind} ${kind}`);
    const result = clone(loadFixture('result.selfassessment'));
    result.measurements = [record];
    assertContractCase(validators, 'Result', result, true, `pure procedure ${kind} containing Result`);
  }
  /* Undefined is not a reference in the public JS API either. JSON wire
   * cannot carry undefined, so these are runtime-only input checks. */
  for (const source of [{ kind: 'LOCAL_ID', recordKind: 'RunManifest', recordId: undefined, procedure },
    { kind: 'LOCAL_DIGEST', digest: undefined, procedure },
    { kind: 'COMPUTED', recordKind: undefined, recordId: undefined, procedure },
    { kind: 'LOCAL_PROCEDURE', digest: undefined, procedure }]) {
    const record = { ...loadFixture('measurement.tokensPerSecond'), source };
    assert.throws(() => validateRecord('Measurement', record), /required/);
    const result = clone(loadFixture('result.selfassessment'));
    result.measurements = [record];
    assert.throws(() => validateRecord('Result', result), /required/);
  }
  const unavailable = loadFixture('measurement.unavailable');
  assertContractCase(validators, 'Measurement', unavailable, true, 'honest unavailable');
  const unavailableResult = clone(loadFixture('result.selfassessment'));
  unavailableResult.measurements = [unavailable];
  assertContractCase(validators, 'Result', unavailableResult, true, 'honest unavailable in Result');
  for (const field of ['source', 'value']) {
    const bad = clone(unavailable);
    bad[field] = field === 'value' ? 0 : { kind: 'COMPUTED', procedure };
    assertContractCase(validators, 'Measurement', bad, false, `unavailable ${field} cannot be claimed`);
    unavailableResult.measurements = [bad];
    assertContractCase(validators, 'Result', unavailableResult, false, `unavailable ${field} containing Result`);
  }
});

test('SOTA3 F2 shipped mjs path has a real discriminated TypeScript source union', () => {
  const compiler = fileURLToPath(new URL('../../starter/node_modules/typescript/bin/tsc', import.meta.url));
  const packageFile = fileURLToPath(new URL('../../starter/node_modules/typescript/package.json', import.meta.url));
  assert.equal(JSON.parse(fs.readFileSync(packageFile, 'utf8')).version, '5.7.3');
  assert.deepEqual(fs.readFileSync(new URL('../../packages/core/manifest.d.ts', import.meta.url)),
    fs.readFileSync(new URL('../../packages/core/manifest.d.mts', import.meta.url)), 'declarations are byte-identical');
  const scratchRoot = new URL('./.tmp/', import.meta.url);
  fs.mkdirSync(scratchRoot, { recursive: true });
  const scratch = fs.mkdtempSync(new URL('sota3-source-types-', scratchRoot));
  const consumer = scratch + '/consumer.mts';
  try {
    fs.writeFileSync(consumer, `
import { validateRecord, type MeasurementSource } from '../../../../packages/core/manifest.mjs';
const procedure = 'synthetic:procedure';
const digest = 'a'.repeat(64);
const id: MeasurementSource = { kind: 'LOCAL_ID', recordKind: 'RunManifest', recordId: 'synthetic-id', procedure };
const localDigest: MeasurementSource = { kind: 'LOCAL_DIGEST', digest, procedure };
const computed: MeasurementSource = { kind: 'COMPUTED', procedure };
const entered: MeasurementSource = { kind: 'SELF_ASSESSMENT', procedure };
const local: MeasurementSource = { kind: 'LOCAL_PROCEDURE', recordKind: 'FrozenSubmission', recordId: 'synthetic-id', digest, procedure };
function narrowed(source: MeasurementSource) {
  if (source.kind === 'LOCAL_ID') { const id: string = source.recordId; const kind: string = source.recordKind; void id; void kind; }
  if (source.kind === 'LOCAL_DIGEST') { const d: string = source.digest; void d; }
}
// @ts-expect-error LOCAL_ID requires its ID pair
const missingId: MeasurementSource = { kind: 'LOCAL_ID', procedure };
// @ts-expect-error LOCAL_ID recordId is never null
const nullId: MeasurementSource = { kind: 'LOCAL_ID', recordKind: 'RunManifest', recordId: null, procedure };
// @ts-expect-error LOCAL_ID recordKind is never null
const nullKind: MeasurementSource = { kind: 'LOCAL_ID', recordKind: null, recordId: 'id', procedure };
// @ts-expect-error LOCAL_ID digest is no substitute for required IDs
const disguisedId: MeasurementSource = { kind: 'LOCAL_ID', digest, procedure };
// @ts-expect-error LOCAL_DIGEST requires digest
const missingDigest: MeasurementSource = { kind: 'LOCAL_DIGEST', procedure };
// @ts-expect-error LOCAL_DIGEST digest is never null
const nullDigest: MeasurementSource = { kind: 'LOCAL_DIGEST', digest: null, procedure };
// @ts-expect-error kind must name a real record family
const badKind: MeasurementSource = { kind: 'LOCAL_ID', recordKind: 'Other', recordId: 'id', procedure };
// @ts-expect-error procedure source is named
const missingProcedure: MeasurementSource = { kind: 'COMPUTED' };
// @ts-expect-error ID companion cannot be half a pair
const halfId: MeasurementSource = { kind: 'COMPUTED', recordId: 'id', procedure };
// @ts-expect-error kind companion cannot be half a pair
const halfKind: MeasurementSource = { kind: 'SELF_ASSESSMENT', recordKind: 'RunManifest', procedure };
// @ts-expect-error optional digest is never null
const badCompanionDigest: MeasurementSource = { kind: 'LOCAL_PROCEDURE', digest: null, procedure };
// @ts-expect-error optional ID pair is never null
const badCompanionId: MeasurementSource = { kind: 'LOCAL_DIGEST', digest, recordKind: 'RunManifest', recordId: null, procedure };
// @ts-expect-error explicit undefined cannot substitute a reference
const undefinedPair: MeasurementSource = { kind: 'COMPUTED', recordKind: undefined, recordId: undefined, procedure };
const result = validateRecord('Measurement', {});
const source: MeasurementSource | null = result.source;
void [id, localDigest, computed, entered, local, narrowed, source];
`);
    const result = spawnSync(process.execPath, [compiler, '--noEmit', '--strict', '--exactOptionalPropertyTypes',
      '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', consumer], { encoding: 'utf8' });
    assert.equal(result.status, 0, `pinned TypeScript actual mjs consumer:\n${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('null round-trips as null and never as zero or empty', () => {
  const unavailable = clone(loadFixture('measurement.unavailable'));
  const verified = validateRecord('Measurement', unavailable);
  assert.equal(verified.value, null);
  assert.ok(!Object.hasOwn(verified, 'confidence') || verified.confidence === null);
  assert.ok(!Object.hasOwn(verified, 'recordedAt') || verified.recordedAt === null);

  const manifest = createRunManifest({
    manifestId: 'mf-44444444-4444-4444-8444-444444444444',
    runId: 'bb-syn-run-004',
    createdAt: '2026-03-01T12:00:00.000Z',
    architectureId: 'arch-run-synthetic',
    harness: 'manual',
    participantWorkspaceRoot: '/synthetic-workspace/bb-syn-run-004',
    evidenceRoot: '/synthetic-evidence/bb-syn-run-004',
    configuration: null,
    toolingIdentity: loadFixture('tooling.identity'),
    challengeIdentity: loadFixture('challenge.identity'),
    evaluatorIdentity: loadFixture('evaluator.identity'),
  });
  assert.equal(manifest.declaredCeilingMinutes, null);
  assert.equal(manifest.configuration.model, undefined);
  assert.equal(manifest.configuration.unknown, 'UNKNOWN');
  assert.ok(manifest.configuration.unknownFields.includes('model'));
});

/* -------------------------------------------------------------------------- */
/* Trust axes and no promotion                                                */
/* -------------------------------------------------------------------------- */

test('trust axes are orthogonal and local assessment cannot upgrade itself', () => {
  const good = loadFixture('result.selfassessment');
  assert.equal(good.evaluationTrust, 'LOCAL_SELF_ASSESSMENT');
  assert.equal(good.humanReview.reviewStatus, 'NOT_REVIEWED');
  assert.equal(validateRecord('Result', good).resultId, good.resultId);

  /* LOCAL_SELF_ASSESSMENT is the ceiling for a self-issued record. */
  assert.equal(MAX_SELF_ISSUED_EVALUATION_TRUST, 'LOCAL_SELF_ASSESSMENT');

  /* Sentence: no certification mechanism exists in this release, so the
   * assessment-trust vocabulary contains no certification state and the
   * human-review axis carries pending/scored only. Fabrication is refused by
   * vocabulary and, additionally, by the validator's refusal message, not by
   * a fiction that a grant could be presented. */
  assert.ok(!EVALUATION_TRUSTS.includes('INDEPENDENTLY_REVIEWED'));
  assert.ok(!EVALUATION_TRUSTS.includes('FORMALLY_CERTIFIED'));
  assert.ok(!HUMAN_REVIEW_STATUSES.includes('REVIEWED_PASS'));

  for (const unsupported of ['INDEPENDENTLY_REVIEWED', 'FORMALLY_CERTIFIED']) {
    const claim = clone(good);
    claim.evaluationTrust = unsupported;
    assert.throws(
      () => validateRecord('Result', claim),
      /can not be self-issued: no independent review grant or certification exists/,
      unsupported,
    );
  }

  /* A human-review outcome outside the pending/scored axis is refused. */
  const fabricated = clone(good);
  fabricated.humanReview.reviewStatus = 'REVIEWED_PASS';
  fabricated.humanReview.reviewDigest = sha('claimed review');
  fabricated.humanReview.reviewedAt = '2026-03-02T12:00:00.000Z';
  assert.throws(() => validateRecord('Result', fabricated), /reviewStatus/);

  /* The recording tooling can not be its own assessing basis either. */
  const selfReview = clone(good);
  selfReview.evaluationTrustBasis = {
    basisKind: 'SELF_ASSESSMENT',
    reviewer: selfReview.bindings.toolingId,
  };
  selfReview.declaredTrustChanges = ['REVIEWED_PASS'];
  assert.throws(() => validateRecord('Result', selfReview), /can not review itself/);

  /* A self-assessment reporting a scored result is also refused: the score
   * needs a bound evaluation procedure and a scored human component, which
   * this record neither ran nor received. */
  const scored = clone(good);
  scored.quality = {
    automated: 61,
    automatedMaximum: 80,
    humanUI: null,
    humanMaximum: 20,
    quality: null,
    qualityMaximum: 100,
    status: 'SCORED',
    categories: {},
  };
  assert.throws(
    () => validateRecord('Result', scored),
    /a SCORED quality record must declare scoreEligibility SCORED/,
  );

  /* The lifecycle axis stays separate: an unevaluated draft can not already
   * be SCORED, whatever the trust axis says. */
  const draft = clone(loadFixture('result.localscored'));
  draft.lifecycle = 'DRAFT';
  assert.throws(() => validateRecord('Result', draft), /DRAFT result can not already be/);
});

/* -------------------------------------------------------------------------- */
/* Historical reader                                                          */
/* -------------------------------------------------------------------------- */

test('readLegacyResult recognises 1.0, 1.1 and 1.2 and preserves outcomes', () => {
  assert.deepEqual([...LEGACY_RESULT_SCHEMA_VERSIONS], ['1.0', '1.1', '1.2']);
  for (const version of LEGACY_RESULT_SCHEMA_VERSIONS) {
    const source = loadFixture('legacy.result.' + version);
    const envelope = readLegacyResult(source);
    assert.ok(isLegacyEnvelope(envelope));
    assert.equal(envelope[LEGACY_ENVELOPE_MARKER], true);
    assert.equal(envelope.recognizedSchemaVersion, version);
    assert.equal(envelope.outcomePreservation, 'VERBATIM');

    /* The source payload is returned verbatim. */
    assert.deepEqual(envelope[LEGACY_SOURCE_FIELD], source);
    const recorded = envelope[LEGACY_SOURCE_FIELD];
    assert.equal(recorded.run.runId, source.run.runId);
    assert.deepEqual(recorded, source);

    /* The recorded outcome is preserved exactly from the location the shape
     * actually emitted it: the raw result records preserve their run object,
     * and the raw 1.2 telemetry record keeps its authentic array structure in
     * the untouched source payload. */
    assert.deepEqual(envelope.preservedOutcome, structuredClone(expectedOutcomeFor(source)));
    assert.notEqual(envelope.preservedOutcome, null);
    if (version === '1.2') {
      /* Authentic raw-telemetry shape: run beside provenance, captain,
       * workers, tasks, attempts, orchestration and cloud. */
      assert.ok(Array.isArray(envelope[LEGACY_SOURCE_FIELD].workers));
      assert.ok(Array.isArray(envelope[LEGACY_SOURCE_FIELD].attempts));
      assert.ok(isRecord(envelope[LEGACY_SOURCE_FIELD].provenance));
      assert.equal(isRecord(envelope[LEGACY_SOURCE_FIELD].metrics ?? null), false,
        'the authentic raw 1.2 record no longer invents a nested metrics object');
      assert.deepEqual(envelope.preservedOutcome, structuredClone(source.run));
    }

    /* No automatic promotion, ever. */
    assert.equal(envelope.promotionAllowed, false);
    assert.equal(envelope.bindingStatus, 'UNBOUND_HISTORICAL');
    assert.equal(envelope.eligibility, 'NOT_FORMAL_COMPARISON_ELIGIBLE');
    assert.deepEqual(envelope.trust, LEGACY_TRUST_CEILING);
    assert.equal(envelope.trust.evaluationTrust, 'UNTRUSTED_LEGACY');
    assert.equal(envelope.trust.lifecycle, 'DRAFT');
    assert.equal(envelope.trust.humanReviewStatus, 'NOT_REVIEWED');

    /* The envelope is not a Result, and cannot become one: the validator
     * refuses it as its own family before any trick can pass it across. */
    assert.throws(() => validateRecord('Result', envelope), /\.kind: required|must be Result/);
    assert.throws(() => validateRecord('Result', { ...envelope, kind: 'Result' }), /unexpected property/);
  }
});

test('the authentic emitted projection preserves numeric quality and top-level flags verbatim and never promotes', () => {
  for (const version of LEGACY_RESULT_SCHEMA_VERSIONS) {
    const source = loadFixture('legacy.result.positive.' + version);
    const envelope = readLegacyResult(source);

    assert.ok(isLegacyEnvelope(envelope));
    assert.equal(envelope.recognizedSchemaVersion, version);
    assert.equal(envelope.outcomePreservation, 'VERBATIM');
    assert.deepEqual(envelope[LEGACY_SOURCE_FIELD], structuredClone(source));
    /* The whole emitted projection is the outcome: numeric quality and
     * top-level authority/outcome flags beside `run`, exactly as written. */
    assert.deepEqual(envelope.preservedOutcome, structuredClone(expectedOutcomeFor(source)));
    assert.deepEqual(envelope.preservedOutcome, structuredClone(source));

    /* Every positive historic claim survives exactly at its authentic
     * top-level location, beside the numeric quality of the projection. */
    const outcome = envelope.preservedOutcome;
    assert.equal(typeof outcome.quality, 'number');
    assert.ok(Number.isFinite(outcome.quality));
    assert.equal(outcome.officialOutcomeValid, true);
    assert.equal(outcome.eligibleForFormalComparison, true);
    assert.equal(outcome.eligibleForCalibrationAcceptance, true);
    assert.equal(outcome.validOutcome, true);
    assert.equal(outcome.official, false);
    assert.equal(outcome.outcomeClass, 'HISTORICAL_UNBOUND_DESCRIPTIVE');
    assert.equal(outcome.executionId, 'ex-66666666-6666-4666-8666-666666666' +
      (version === '1.0' ? '666' : version === '1.1' ? '677' : '688'));
    /* Nullable projection states stay null where the version had no proof. */
    if (version === '1.0') {
      assert.equal(outcome.stopConfirmed, null);
      assert.equal(outcome.timingEvidence, 'LEGACY_REPORTED_END_NOT_STOP_PROOF');
    } else {
      assert.equal(outcome.stopConfirmed, true);
      assert.equal(outcome.timingEvidence, 'EXPLICIT_OBSERVATION');
    }
    assert.equal(outcome.supervisionValid, null);
    assert.equal(outcome.terminationProven, null);

    /* Preserving the claims is not adopting them: the envelope keeps the
     * non-promoting trust ceiling, the unbound historical status and the
     * not-formal-comparison-eligible state whatever the source declares. */
    assert.equal(envelope.bindingStatus, 'UNBOUND_HISTORICAL');
    assert.deepEqual(envelope.trust, LEGACY_TRUST_CEILING);
    assert.equal(envelope.trust.evaluationTrust, 'UNTRUSTED_LEGACY');
    assert.equal(envelope.trust.lifecycle, 'DRAFT');
    assert.equal(envelope.trust.humanReviewStatus, 'NOT_REVIEWED');
    assert.equal(envelope.eligibility, 'NOT_FORMAL_COMPARISON_ELIGIBLE');
    assert.equal(envelope.promotionAllowed, false);

    /* And the envelope still can not cross into the current Result family. */
    assert.throws(() => validateRecord('Result', { ...envelope, kind: 'Result' }),
      /unexpected property/);
  }
});

test('malformed outcome flags are refused at their authentic real locations', () => {
  /* Top-level flags of the emitted projection: a malformed type is refused,
   * with the location named, not silently skipped by an outcome guess. */
  for (const version of LEGACY_RESULT_SCHEMA_VERSIONS) {
    for (const [field, value] of [
      ['officialOutcomeValid', 'yes'],
      ['officialOutcomeEligible', 1],
      ['official', 'true'],
      ['eligibleForFormalComparison', 'yes'],
      ['eligibleForCalibrationAcceptance', 0],
      ['validOutcome', null],
      ['stopConfirmed', 'no'],
      ['supervisionValid', 'unknown'],
      ['terminationProven', 'no'],
    ]) {
      const badFlag = clone(loadFixture('legacy.result.positive.' + version));
      badFlag[field] = value;
      const expected = ['validOutcome', 'officialOutcomeValid', 'officialOutcomeEligible',
        'official', 'eligibleForFormalComparison', 'eligibleForCalibrationAcceptance']
        .includes(field)
        ? new RegExp(field + ' must be a boolean')
        : new RegExp(field + ' must be a boolean or null');
      assert.throws(() => readLegacyResult(badFlag), expected, field + ' at $ (' + version + ')');
    }
    const badTopLevelQuality = clone(loadFixture('legacy.result.positive.' + version));
    badTopLevelQuality.quality = 'excellent';
    assert.throws(
      () => readLegacyResult(badTopLevelQuality),
      /\$\.quality must be a finite number or null/,
      'top-level quality (' + version + ')',
    );
  }
  /* Run-carried flags of the raw result records are type-checked too. */
  const runFlag = clone(loadFixture('legacy.result.1.1'));
  runFlag.run.validOutcome = 'yes';
  assert.throws(() => readLegacyResult(runFlag), /run\.validOutcome must be a boolean/);
});

test('readLegacyResult refuses unreadable, unknown or malformed data', () => {
  assert.throws(() => readLegacyResult(null), ContractValidationError);
  assert.throws(() => readLegacyResult('1.2'), ContractValidationError);

  for (const version of ['1', '2.0', '1.3', '1.2.0', '0.9', 'v1.2', 1, 1.2, null]) {
    const source = clone(loadFixture('legacy.result.1.2'));
    source.schemaVersion = version;
    assert.throws(
      () => readLegacyResult(source),
      /is not a recognised historical result schema/,
      String(version),
    );
  }

  /* A well-shaped-but-unrecognised historical document is not read as history. */
  const adHoc = { schemaVersion: 1, run: { runId: 'bb-adhoc-001', status: 'COMPLETED' } };
  assert.throws(() => readLegacyResult(adHoc), ContractValidationError);

  /* Required run fields per version. */
  for (const key of ['runId', 'benchmarkVersion', 'startedAt']) {
    const missing = clone(loadFixture('legacy.result.1.0'));
    delete missing.run[key];
    assert.throws(() => readLegacyResult(missing), new RegExp('missing run\\.' + key));
  }
  for (const key of ['deadlineAt', 'observationEndedAt', 'stopResult']) {
    const missing = clone(loadFixture('legacy.result.1.1'));
    delete missing.run[key];
    assert.throws(() => readLegacyResult(missing), new RegExp('missing run\\.' + key));
  }

  /* A 1.1 record's execution identifier is a historical statement now: it is
   * type-checked, kept verbatim, and never becomes a current binding — see
   * the positive-preservation test below. */
  const bound = clone(loadFixture('legacy.result.1.1'));
  bound.run.executionId = 'ex-99999999-9999-4999-8999-999999999999';
  assert.equal(readLegacyResult(bound).bindingStatus, 'UNBOUND_HISTORICAL');
  const typedBound = clone(loadFixture('legacy.result.1.1'));
  typedBound.run.executionId = 42;
  assert.throws(() => readLegacyResult(typedBound), /executionId must be a string or null/);

  /* A historical record's positively flagged claims are preserved, refusing
   * only malformed flag types — see the emitted-projection tests above. */
  const selfCert = clone(loadFixture('legacy.result.positive.1.2'));
  const preserved = readLegacyResult(selfCert);
  assert.equal(preserved.preservedOutcome.officialOutcomeValid, true);

  /* A preserved execution identifier must at least be a string or null, both
   * inside the run object and at the projection's top level. */
  const badExecutionId = clone(loadFixture('legacy.result.1.2'));
  badExecutionId.run.executionId = 42;
  assert.throws(() => readLegacyResult(badExecutionId), /executionId must be a string or null/);
  const badTopLevelExecutionId = clone(loadFixture('legacy.result.positive.1.2'));
  badTopLevelExecutionId.executionId = 42;
  assert.throws(
    () => readLegacyResult(badTopLevelExecutionId),
    /executionId must be a string or null/,
  );

  /* Unrecognised outcome vocabulary and out-of-range ceilings. */
  const badStatus = clone(loadFixture('legacy.result.1.2'));
  badStatus.run.status = 'PASSED_WITH_DISTINCTION';
  assert.throws(() => readLegacyResult(badStatus), /unknown historical run status/);

  const badCeiling = clone(loadFixture('legacy.result.1.2'));
  badCeiling.run.timeCeilingMinutes = 9999;
  assert.throws(() => readLegacyResult(badCeiling), /timeCeilingMinutes is outside/);

  /* A missing run object is a structural error, not a guess. */
  assert.throws(() => readLegacyResult({ schemaVersion: '1.2', run: 'nope' }), ContractValidationError);

  /* isLegacyEnvelope only accepts this reader's envelopes. */
  assert.equal(isLegacyEnvelope(null), false);
  assert.equal(isLegacyEnvelope({ [LEGACY_ENVELOPE_MARKER]: true }), false);
  assert.equal(
    isLegacyEnvelope({ ...readLegacyResult(loadFixture('legacy.result.1.0')), promotionAllowed: true }),
    false,
  );
});

/* -------------------------------------------------------------------------- */
/* Self-containment and fixture hygiene                                       */
/* -------------------------------------------------------------------------- */

test('the contract module is self-contained and does not read configuration', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../../packages/core/manifest.mjs', import.meta.url), 'utf8');

  const imports = [...source.matchAll(/^import\s[^;]*from\s+'([^']+)'/gm)].map((entry) => entry[1]);
  assert.ok(imports.length > 0);
  for (const specifier of imports)
    assert.ok(specifier === 'node:crypto', 'unexpected import: ' + specifier);

  for (const forbidden of [
    '@deepseek-ai', 'dsh', 'node:fs', 'node:net', 'node:http', 'node:child_process',
    'process.env', 'homedir', 'os.tmpdir', 'fetch(', 'eval(',
  ])
    assert.ok(
      !source.toLowerCase().includes(forbidden.toLowerCase()),
      'the contract layer must not reference ' + forbidden,
    );
});

test('fixtures are synthetic, sanitised and match the runtime contracts', () => {
  const all = [...fixtureNames(FIXTURE_SETS.identities), ...fixtureNames(FIXTURE_SETS.runs),
    ...fixtureNames(FIXTURE_SETS.measurements), ...fixtureNames(FIXTURE_SETS.results),
    ...fixtureNames(FIXTURE_SETS.legacy)];
  assert.ok(all.length >= 15, 'expected a fixture per family and legacy version');

  const text = all.map((name) => JSON.stringify(loadFixture(name))).join('\n');
  /* This list targets credentia/private material. The authentic historical
   * telemetry vocabulary legitimately counts usage ("tokens" containers) —
   * what must never appear is a credential token, key or header value, so the
   * credential forms are named precisely instead of matching the counters. */
  for (const forbidden of [
    'C:\\', 'c:\\', 'bb-cal-00', 'bb-syn-private', 'Users\\', '/home/', 'api_key',
    'apikey', 'authToken', 'accessToken', 'refreshToken', '"token"', 'token=',
    'cookie', 'bearer', 'Authorization', 'authorization:',
  ])
    assert.ok(!text.includes(forbidden), 'fixture data must not contain ' + forbidden);

  /* Synthetic identities are recognisably synthetic and stable. */
  for (const name of [...fixtureNames(FIXTURE_SETS.identities), ...fixtureNames(FIXTURE_SETS.runs)]) {
    const fixture = loadFixture(name);
    assert.match(JSON.stringify(fixture), /syn|synthetic/, name);
  }

  /* Every identity fixture validates, so declarations cannot drift from the
   * runtime contract without a failure here. */
  for (const name of fixtureNames(FIXTURE_SETS.identities)) {
    const fixture = loadFixture(name);
    validateRecord(fixture.kind, fixture);
  }
  for (const name of fixtureNames(FIXTURE_SETS.runs)) validateRecord('RunManifest', loadFixture(name));
  for (const name of fixtureNames(FIXTURE_SETS.measurements))
    validateRecord('Measurement', loadFixture(name));
  for (const name of fixtureNames(FIXTURE_SETS.results)) validateRecord('Result', loadFixture(name));
  validateRecord('FrozenSubmission', loadFixture('frozen.submission'));

  /* Version fields in fixtures are the real contract baseline. */
  assert.equal(loadFixture('tooling.identity').schemaVersion, NEUTRAL_CONTRACT_VERSION);
  assert.equal(loadFixture('run.manifest').schemaVersion, NEUTRAL_CONTRACT_VERSION);
  assert.equal(loadFixture('result.selfassessment').schemaVersion, NEUTRAL_CONTRACT_VERSION);
});

/* -------------------------------------------------------------------------- */
/* Schemas and declarations mirror the runtime contracts                      */
/* -------------------------------------------------------------------------- */

test('the TypeScript declarations describe the exported runtime surface', async () => {
  const namespace = await import('../../packages/core/manifest.mjs');
  const runtimeExports = Object.keys(namespace);
  assert.ok(runtimeExports.length >= 20, 'the contract module exports its surface');

  const declarationRelative = '../../packages/core/manifest.d.ts';
  const declarationPath = fileURLToPath(new URL(declarationRelative, import.meta.url));
  const declaration = fs.readFileSync(declarationPath, 'utf8');

  /* Every runtime export must be documented by name in the declarations. */
  for (const name of runtimeExports)
    assert.ok(
      declaration.includes(name),
      'manifest.d.ts declares ' + name,
    );

  /* And the documented contract families and axes must be present as types. */
  for (const name of [
    'ToolingIdentity', 'ChallengeIdentity', 'EvaluatorIdentity', 'RunManifest',
    'FrozenSubmission', 'Measurement', 'Result', 'CandidateLineage',
    'LegacyResultEnvelope', 'EvaluationTrust', 'MeasurementKind', 'ScoreEligibility',
  ])
    assert.ok(new RegExp(`\\b${name}\\b`).test(declaration), `manifest.d.ts declares ${name}`);
});

test('the manifest declarations typecheck with the pinned repository compiler', (t) => {
  const compiler = fileURLToPath(new URL('../../starter/node_modules/typescript/bin/tsc', import.meta.url));
  if (!fs.existsSync(compiler)) {
    t.skip('the pinned TypeScript compiler is not installed in starter/node_modules; no install is performed by this test');
    return;
  }
  const result = spawnSync(process.execPath, [
    compiler, '--noEmit', '--strict', '--target', 'es2022',
    '--module', 'nodenext', '--moduleResolution', 'nodenext',
    fileURLToPath(new URL('../../packages/core/manifest.d.ts', import.meta.url)),
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, `the pinned compiler reported:\n${result.stdout}\n${result.stderr}`);
});

test('the JSON schemas cover every family and mirror the runtime vocabulary', () => {
  const schemaRoot = new URL('../../schemas/', import.meta.url);
  const families = {
    'tooling.schema.json': 'ToolingIdentity',
    'challenge.schema.json': 'ChallengeIdentity',
    'evaluator.schema.json': 'EvaluatorIdentity',
    'run.schema.json': 'RunManifest',
    'submission.schema.json': 'FrozenSubmission',
    'measurement.schema.json': 'Measurement',
    'result.schema.json': 'Result',
  };
  assert.equal(Object.values(families).every((kind) => NEUTRAL_CONTRACT_KINDS.includes(kind)), true);
  assert.deepEqual(Object.keys(families).length, NEUTRAL_CONTRACT_KINDS.length);
  for (const kind of NEUTRAL_CONTRACT_KINDS)
    assert.ok(Object.values(families).includes(kind), kind + ' has a JSON schema');

  const byKind = {};
  for (const [name, kind] of Object.entries(families)) {
    const document = JSON.parse(fs.readFileSync(new URL(name, schemaRoot), 'utf8'));
    assert.equal(document.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(document.type, 'object');
    assert.equal(document.additionalProperties, false, name + ' is closed');
    assert.equal(document.properties.kind.const, kind);
    assert.equal(document.properties.schemaVersion.pattern, '^1\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$',
      name + ' restricts the discriminator to supported schema major 1');
    byKind[kind] = document;
  }

  /* Enumerated vocabulary must be identical on both sides. */
  assert.deepEqual(byKind.Measurement.properties.measurementKind.enum, [...MEASUREMENT_KINDS]);
  assert.deepEqual(byKind.Measurement.properties.unit.enum, [...MEASUREMENT_UNITS]);
  assert.deepEqual(byKind.Result.properties.lifecycle.enum, [...LIFECYCLE_STATES]);
  assert.deepEqual(byKind.Result.properties.runStatus.enum, [...RUN_STATUSES]);
  assert.deepEqual(
    byKind.Result.properties.evaluatorExecution.enum.filter((value) => value !== null),
    [...EVALUATOR_EXECUTION_STATUSES],
  );
  assert.deepEqual(
    byKind.Result.properties.stopResult.enum.filter((value) => value !== null),
    [...STOP_RESULTS],
  );
  assert.deepEqual(byKind.Result.properties.evaluationTrust.enum, [...EVALUATION_TRUSTS]);
  assert.deepEqual(byKind.Result.properties.humanReview.properties.reviewStatus.enum,
    [...HUMAN_REVIEW_STATUSES]);
  assert.deepEqual(byKind.EvaluatorIdentity.properties.exposure.enum, [...EVALUATOR_EXPOSURES]);
  assert.deepEqual(byKind.EvaluatorIdentity.properties.transparency.enum,
    [...EVALUATOR_TRANSPARENCIES]);
  assert.deepEqual(byKind.RunManifest.properties.securityModel.enum, [...SECURITY_MODELS]);
  assert.deepEqual([...byKind.ToolingIdentity.properties.hashAlgorithm.enum], ['sha256']);

  /* No schema can carry a certification or independent-review state the
   * release does not implement: trust can not be upgraded through wording. */
  const schemaText = Object.values(byKind).map((document) => JSON.stringify(document)).join('\n');
  for (const invented of ['FORMALLY_CERTIFIED', 'INDEPENDENTLY_REVIEWED', 'REVIEWED_PASS', 'REVIEWED_FAIL'])
    assert.ok(!schemaText.includes(invented), invented + ' must not exist in any schema');

  /* Digest fields are exactly 64 lowercase hex characters everywhere. */
  assert.equal(byKind.ChallengeIdentity.properties.workloadDigest.pattern, '^[0-9a-f]{64}$');
  assert.equal(byKind.RunManifest.properties.manifestDigest.pattern, '^[0-9a-f]{64}$');
  assert.equal(byKind.FrozenSubmission.properties.treeDigest.pattern, '^[0-9a-f]{64}$');

  /* Fixtures validate against the shapes the schemas claim. */
  for (const fixtureName of [
    'tooling.identity', 'challenge.identity', 'evaluator.identity', 'run.manifest',
    'frozen.submission', 'measurement.unavailable', 'measurement.elapsedWall',
    'measurement.manualTokens', 'result.selfassessment',
  ]) {
    const fixture = loadFixture(fixtureName);
    const document = byKind[fixture.kind];
    for (const key of document.required ?? [])
      assert.ok(Object.hasOwn(fixture, key), fixtureName + '.' + key + ' present');
  }
});

test('schemas compile with the actual Ajv2020 compiler and agree with runtime discriminator rules', async () => {
  /* The repository's locally installed Ajv (8.17.1, draft 2020-12) compiles
   * the released schemas here; this is a test-only dependency used to prove
   * schema/runtime parity, and the contract module itself keeps Node builtins. */
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const schemaRoot = new URL('../../schemas/', import.meta.url);
  const documentOf = (name) => JSON.parse(fs.readFileSync(new URL(name, schemaRoot), 'utf8'));
  const documents = {
    ToolingIdentity: documentOf('tooling.schema.json'),
    ChallengeIdentity: documentOf('challenge.schema.json'),
    EvaluatorIdentity: documentOf('evaluator.schema.json'),
    RunManifest: documentOf('run.schema.json'),
    FrozenSubmission: documentOf('submission.schema.json'),
    Measurement: documentOf('measurement.schema.json'),
    Result: documentOf('result.schema.json'),
  };

  const compiler = new Ajv2020({ strict: true, allErrors: true });
  for (const document of Object.values(documents)) compiler.addSchema(document);
  const validates = {};
  for (const [kind, document] of Object.entries(documents)) {
    const validator = compiler.getSchema(document.$id);
    assert.ok(typeof validator === 'function', kind + ' compiles under Ajv2020');
    validates[kind] = validator;
  }

  /* Positive fixtures pass through the actual compiler against their family
   * schema (result fixtures exercise the measurement $ref through the same
   * compiler instance). */
  const positives = {
    ToolingIdentity: 'tooling.identity',
    ChallengeIdentity: 'challenge.identity',
    EvaluatorIdentity: 'evaluator.identity',
    RunManifest: 'run.manifest',
    FrozenSubmission: 'frozen.submission',
    Measurement: 'measurement.elapsedWall',
    Result: 'result.selfassessment',
  };
  for (const [kind, fixtureName] of Object.entries(positives))
    assert.equal(validates[kind](loadFixture(fixtureName)), true,
      fixtureName + ' validates under its compiled schema');

  /* C1 T9 F2: the DERIVED measurement carries one stable string
   * representation — the schema's string field and the runtime's stored field
   * agree, and the validated projection is valid schema input again. */
  const derivedWire = loadFixture('measurement.tokensPerSecond');
  assert.equal(validates.Measurement(derivedWire), true,
    'the DERIVED fixture validates under its compiled schema');
  const derivedValidated = validateRecord('Measurement', structuredClone(derivedWire));
  assert.equal(derivedValidated.derivation, '{manualUsageCount} / {elapsedWallSeconds}',
    'the runtime keeps the derivation as the stable string representation');
  assert.equal(validates.Measurement(derivedValidated), true,
    'the validated projection is valid schema bytes again (validateRecord is idempotent)');

  /* Discriminator parity: each candidate value is accepted by the compiled
   * schema exactly when the runtime accepts it. Self digests are removed so
   * that acceptance means version acceptance only. */
  const parity = [
    ['1.0.0', true], ['1.1.0', true], ['1.0.1', true], ['1.4.7', true],
    ['2.0.0', false], ['0.0.0', false], ['9.9.9', false],
    ['01.0.0', false], ['1.00.0', false], ['1.0.00', false],
    ['1.0', false], ['1', false], ['1.0.0.0', false], ['v1.0.0', false],
    ['1.0.0-beta', false], ['', false], [1, false], [null, false], [undefined, false],
  ];
  for (const [kind, fixtureName] of Object.entries(positives)) {
    for (const [value, expected] of parity) {
      const record = clone(loadFixture(fixtureName));
      record.schemaVersion = value;
      delete record.manifestDigest;
      delete record.identityDigest;
      let schemaAccepts = false;
      let runtimeAccepts = false;
      try {
        schemaAccepts = validates[kind](record) === true;
      } catch (error) {
        assert.fail('Ajv2020 threw instead of rejecting ' + kind + ': ' + error.message);
      }
      try {
        validateRecord(kind, record);
        runtimeAccepts = true;
      } catch {
        /* Rejected, matching when expected is false. */
      }
      assert.equal(schemaAccepts, expected,
        `${kind}: schema discriminal for ${JSON.stringify(value) ?? 'undefined'} should be ${expected}`);
      assert.equal(runtimeAccepts, expected,
        `${kind}: runtime discriminal for ${JSON.stringify(value) ?? 'undefined'} should be ${expected}`);
    }
  }

  /* Domain version fields follow the same no-leading-zero consistency. */
  const badTooling = clone(loadFixture('tooling.identity'));
  badTooling.toolingVersion = '01.0.0';
  assert.equal(validates.ToolingIdentity(badTooling), false);
  assert.throws(() => validateRecord('ToolingIdentity', badTooling), /toolingVersion/);

  const goodTooling = clone(loadFixture('tooling.identity'));
  goodTooling.toolingVersion = '0.10.1';
  assert.equal(validates.ToolingIdentity(goodTooling), true);
  assert.equal(validateRecord('ToolingIdentity', goodTooling).toolingVersion, '0.10.1');
});
