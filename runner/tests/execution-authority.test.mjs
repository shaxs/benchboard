// Counterexamples against the candidate.9 execution-authority contract.
//
// Written as independent counterexamples against the contract the candidate.8
// reviewer specified, not as assertions of the implementation's shape. Every
// fixture derives from REAL producer output (see governed-fixture.mjs); the
// positive end-to-end proof is in governed-chain.test.mjs.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingest } from '../collect-metrics.mjs';
import { assertEvaluationEligible } from '../evaluate.mjs';
import {
  ADMISSIBLE_TERMINAL_OUTCOMES,
  BOUND_FACTS,
  ExecutionAuthorityError,
  TERMINAL_OUTCOMES,
  assertFullyBoundTo,
  executionIdentityClaim,
  incompleteSupervisionMarker,
  resolveExecutionOutcome,
  resolveFrozenSubmission,
  resolveOfficialExecution,
  terminalOutcomeOf,
  verifyExecutionIdentity,
} from '../execution-authority.mjs';
import {
  projectOutcomeEligibility,
  validateIdentitySet,
} from '../execution-identity.mjs';
import {
  reconcileSupervision,
  validateTerminalChronology,
  assertDispatchAllowed,
  formalComparability,
  resolveReferenceUiAcceptance,
  SupervisionLedger,
} from '../supervision.mjs';
import { wholeRunCompletionForTest } from '../dsh-watchdog.mjs';
import { governedRun, officialRow, disposeRealChains } from './governed-fixture.mjs';

after(disposeRealChains);

const ingestOf = (g, over = {}) =>
  ingest(g.telemetry(over), null, null, g.manifest, g.ingestOptions);

// ---------------------------------------------------------------------------
// ROOT: official authority exists only by construction
// ---------------------------------------------------------------------------
test('ROOT: no exported primitive can mint an official execution identity', async () => {
  const authority = await import('../execution-authority.mjs');
  const identity = await import('../execution-identity.mjs');
  for (const name of [
    'mintExecutionIdentity',
    'mintIdentity',
    'createExecutionIdentity',
    'identityDigest',
    'deriveExecutionId',
  ]) {
    assert.equal(authority[name], undefined, 'execution-authority must not export ' + name);
    assert.equal(identity[name], undefined, 'execution-identity must not export ' + name);
  }
  // The only composed way in is the governed launch.
  assert.equal(typeof authority.openOfficialExecution, 'function');
  assert.equal(typeof authority.resolveOfficialExecution, 'function');
});

test('ROOT: a plausible record set with no persisted authority is not official', () => {
  const g = governedRun({ minutes: 180, omitAuthority: true });
  try {
    assert.throws(
      () => resolveOfficialExecution(g.id, { overrides: g.overrides }),
      /No persisted official execution authority/,
    );
    assert.throws(() => ingestOf(g), /No persisted official execution authority/);
    const gate = assertEvaluationEligible(g.id, {
      overrides: g.overrides,
      currentSubmissionHash: g.submissionHash,
    });
    assert.equal(gate.eligible, false);
  } finally {
    g.cleanup();
  }
});

test('ROOT: a persisted authority whose launch artifacts are absent is refused', () => {
  const g = governedRun({ minutes: 180 });
  try {
    // Possessing the record is not enough: resolution re-checks the
    // independently produced watchdog artifacts it names.
    fs.rmSync(g.armedEvidencePath);
    assert.throws(
      () => resolveOfficialExecution(g.id, { overrides: g.overrides }),
      /names no existing ARMED evidence/,
    );
  } finally {
    g.cleanup();
  }
});

test('ROOT: an edited bound fact or recombined identity fails verification', () => {
  const g = governedRun({ minutes: 180 });
  try {
    const identity = g.executionIdentity;
    assert.ok(verifyExecutionIdentity(identity));
    for (const key of BOUND_FACTS) {
      const tampered = JSON.parse(JSON.stringify(identity));
      tampered.boundFacts[key] =
        typeof tampered.boundFacts[key] === 'number'
          ? tampered.boundFacts[key] + 1
          : 'tampered';
      assert.throws(
        () => verifyExecutionIdentity(tampered),
        ExecutionAuthorityError,
        'tampering with ' + key + ' must fail verification',
      );
    }
    // A recombined identity keeping a valid digest but a foreign executionId.
    const recombined = JSON.parse(JSON.stringify(identity));
    recombined.executionId = 'f'.repeat(32);
    assert.throws(
      () => verifyExecutionIdentity(recombined),
      /not derived from its bound run and watchdog nonce/,
    );
  } finally {
    g.cleanup();
  }
});

// ---------------------------------------------------------------------------
// All nine bound facts are mandatory
// ---------------------------------------------------------------------------
test('every one of the nine bound facts is mandatory and positively compared', () => {
  const g = governedRun({ minutes: 180 });
  try {
    const identity = g.executionIdentity;
    const full = executionIdentityClaim(identity);
    assert.ok(assertFullyBoundTo(identity, full, 'complete claim'));
    for (const key of BOUND_FACTS) {
      const missing = { ...full };
      delete missing[key];
      assert.throws(
        () => assertFullyBoundTo(identity, missing, 'claim'),
        new RegExp('does not state the bound ' + key),
        'an absent ' + key + ' must be INVALID',
      );
      const nulled = { ...full, [key]: null };
      assert.throws(
        () => assertFullyBoundTo(identity, nulled, 'claim'),
        new RegExp('does not state the bound ' + key),
      );
      const wrong = {
        ...full,
        [key]: typeof full[key] === 'number' ? full[key] + 1 : 'other',
      };
      assert.throws(
        () => assertFullyBoundTo(identity, wrong, 'claim'),
        new RegExp('disagrees with the governed execution on ' + key),
        'a differing ' + key + ' must be INVALID',
      );
    }
    assert.throws(
      () => assertFullyBoundTo(identity, null, 'claim'),
      /carries no execution identity claim/,
    );
  } finally {
    g.cleanup();
  }
});

test('reviewer counterexamples: workload hash, candidate version, deadlines and teams all fail closed', () => {
  // 1 + 2: telemetry that misstates the workload hash or the candidate version.
  for (const over of [
    { workloadHash: 'different-workload-hash' },
    { candidateVersion: 'not-the-candidate' },
    { workloadHash: undefined },
    { candidateVersion: null },
  ]) {
    const g = governedRun({ minutes: 180 });
    try {
      assert.throws(
        () => ingestOf(g, over),
        /Official telemetry (disagrees with the governed execution|does not state the bound)|must be string/,
        'telemetry override ' + JSON.stringify(over) + ' must be refused',
      );
    } finally {
      g.cleanup();
    }
  }
  // 3: both supervision deadlines.
  for (const perturbation of [
    { terminalDeadlineAt: '2031-01-01T00:00:00.000Z' },
    { clockShiftMs: 1000 },
  ]) {
    const g = governedRun({ minutes: 180, ...perturbation });
    try {
      const r = reconcileSupervision({
        ...g.supervision,
        executionIdentity: g.executionIdentity,
      });
      assert.equal(r.supervisionValid, false, JSON.stringify(perturbation));
    } finally {
      g.cleanup();
    }
  }
  // 4: both supervision teams, with NO expectedTeamId supplied. Candidate.8
  // treated the team check as conditional on an expected value being passed.
  const g = governedRun({ minutes: 180, terminalTeamId: 'some-other-team' });
  try {
    const omitted = reconcileSupervision({
      runId: g.id,
      armedEvidencePath: g.armedEvidencePath,
      finalEvidencePath: g.finalEvidencePath,
      overrides: g.overrides,
      executionIdentity: g.executionIdentity,
      // expectedTeamId deliberately omitted
    });
    assert.equal(omitted.supervisionValid, false);
    assert.match(omitted.problems.join('; '), /requires the bound team identity/);
    const supplied = reconcileSupervision({
      ...g.supervision,
      executionIdentity: g.executionIdentity,
    });
    assert.equal(supplied.supervisionValid, false);
  } finally {
    g.cleanup();
  }
  // And dispatch refuses without the bound team identity.
  const h = governedRun({ minutes: 180 });
  try {
    assert.throws(
      () =>
        assertDispatchAllowed(h.id, {
          armedEvidencePath: h.armedEvidencePath,
          overrides: h.overrides,
          alive: () => true,
        }),
      /the bound team identity is mandatory/,
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// H1: persisted seed and persisted execution record are authoritative
// ---------------------------------------------------------------------------
test('H1: the persisted disk seed wins and a caller claim never replaces it', () => {
  const g = governedRun({ minutes: 180, seedMinutesOnDisk: 75 });
  try {
    // Disk says 75, the governed execution and telemetry say 180.
    assert.throws(
      () => ingestOf(g),
      /conflicts with the seeded run manifest|ARMED ceiling|seeded authority/,
    );
  } finally {
    g.cleanup();
  }
});

test('H1: a caller execution-record claim that disagrees is rejected, not adopted', () => {
  const g = governedRun({ minutes: 180 });
  try {
    assert.throws(
      () =>
        ingest(g.telemetry(), null, null, g.manifest, {
          ...g.ingestOptions,
          executionRecord: { runId: 'some-other-run' },
        }),
      /binds another run/,
    );
    assert.throws(
      () =>
        ingest(g.telemetry(), null, null, g.manifest, {
          ...g.ingestOptions,
          executionRecord: {
            runId: g.id,
            executionIdentity: { executionId: 'f'.repeat(32) },
          },
        }),
      /does not match the authoritative persisted execution/,
    );
    // The authoritative record is used regardless of the claim.
    const ok = ingestOf(g);
    assert.equal(ok.validOutcome, true, JSON.stringify(ok.ineligibilityReasons));
  } finally {
    g.cleanup();
  }
});

test('H1: legacy schemas stay historical and cannot be promoted', () => {
  // A legacy record keeps the historical 75-minute ceiling, so the governed
  // run this derives from declares 75.
  const g = governedRun({ minutes: 75 });
  try {
    const legacy = g.telemetry();
    legacy.schemaVersion = '1.1';
    assert.throws(
      () =>
        ingest(legacy, null, null, g.manifest, {
          ...g.ingestOptions,
          official: true,
        }),
      /historical\/unbound and cannot be treated as a current official outcome/,
    );
    const descriptive = ingest(legacy, null, null, g.manifest, {
      ...g.ingestOptions,
      official: false,
    });
    assert.equal(descriptive.validOutcome, false);
    assert.equal(descriptive.eligibleForFormalComparison, false);
    assert.equal(descriptive.eligibleForCalibrationAcceptance, false);
  } finally {
    g.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Eligibility monotonicity
// ---------------------------------------------------------------------------
test('eligibility is derived once, frozen, and never regained downstream', () => {
  const inputs = [
    'executionAuthorityResolved',
    'executionRecordValid',
    'seededAuthorityValid',
    'governedDispatchProven',
    'supervisionValid',
    'terminationProven',
    'telemetryBound',
  ];
  const total = 2 ** inputs.length;
  let valid = 0;
  for (let mask = 0; mask < total; mask += 1) {
    const facts = Object.fromEntries(
      inputs.map((k, i) => [k, Boolean(mask & (1 << i))]),
    );
    const p = projectOutcomeEligibility({
      schemaVersion: '1.2',
      outcomeClass: 'OFFICIAL_SUPERVISED',
      ...facts,
    });
    const allTrue = inputs.every((k) => facts[k]);
    assert.equal(p.validOutcome, allTrue);
    assert.equal(p.eligibleForFormalComparison, allTrue);
    assert.equal(p.eligibleForCalibrationAcceptance, allTrue);
    if (p.validOutcome !== true) {
      assert.equal(p.eligibleForFormalComparison, false);
      assert.equal(p.eligibleForCalibrationAcceptance, false);
      assert.ok(p.ineligibilityReasons.length > 0);
    } else valid += 1;
    assert.ok(Object.isFrozen(p), 'the projection must be frozen');
  }
  assert.equal(valid, 1, 'exactly one combination may be valid');
  // A frozen projection cannot be re-enabled by a downstream caller.
  const invalid = projectOutcomeEligibility({
    schemaVersion: '1.2',
    outcomeClass: 'OFFICIAL_SUPERVISED',
    executionAuthorityResolved: false,
    executionRecordValid: false,
    seededAuthorityValid: true,
    governedDispatchProven: true,
    supervisionValid: true,
    terminationProven: true,
    telemetryBound: true,
  });
  assert.throws(() => {
    'use strict';
    invalid.eligibleForFormalComparison = true;
  }, TypeError);
});

test('an invalid persisted execution outcome can never be granted eligibility', () => {
  for (const defect of [
    { validOutcome: false },
    { supervisionValid: false },
    { terminationProven: false },
    { governedDispatchProven: false },
    { runStatus: 'INFRASTRUCTURE_FAILURE' },
    { runStatus: 'STOP_FAILURE' },
  ]) {
    const g = governedRun({ minutes: 180 });
    try {
      const at = path.join(g.runsDir, g.id + '-execution.json');
      const record = JSON.parse(fs.readFileSync(at, 'utf8'));
      Object.assign(record, defect);
      fs.writeFileSync(at, JSON.stringify(record, null, 2));
      const resolved = resolveExecutionOutcome(g.id, g.executionIdentity, {
        overrides: g.overrides,
      });
      assert.equal(
        resolved.executionRecordValid,
        false,
        JSON.stringify(defect) + ' must not be a valid outcome',
      );
      const m = ingestOf(g);
      assert.equal(m.validOutcome, false, JSON.stringify(defect));
      assert.equal(m.eligibleForFormalComparison, false);
      assert.equal(m.eligibleForCalibrationAcceptance, false);
      const gate = assertEvaluationEligible(g.id, {
        overrides: g.overrides,
        currentSubmissionHash: g.submissionHash,
      });
      assert.equal(gate.eligible, false, JSON.stringify(defect));
    } finally {
      g.cleanup();
    }
  }
});

// ---------------------------------------------------------------------------
// Incomplete-supervision marker: every consumer agrees
// ---------------------------------------------------------------------------
test('the incomplete-supervision marker blocks ingest, reconciliation and evaluation alike', () => {
  const g = governedRun({ minutes: 180, activeMarker: true });
  try {
    assert.ok(incompleteSupervisionMarker(g.id, g.overrides));
    const r = reconcileSupervision({
      ...g.supervision,
      executionIdentity: g.executionIdentity,
    });
    assert.equal(r.supervisionValid, false);
    assert.match(r.problems.join('; '), /incomplete-supervision marker/);
    const m = ingestOf(g);
    assert.equal(m.validOutcome, false);
    assert.equal(m.eligibleForFormalComparison, false);
    assert.equal(m.eligibleForCalibrationAcceptance, false);
    assert.match(m.ineligibilityReasons.join('; '), /owner verification/);
    const gate = assertEvaluationEligible(g.id, {
      overrides: g.overrides,
      currentSubmissionHash: g.submissionHash,
    });
    assert.equal(gate.eligible, false);
    assert.match(gate.problems.join('; '), /owner verification/);
  } finally {
    g.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Frozen submission and the private evaluation gate
// ---------------------------------------------------------------------------
test('the private evaluation gate requires positive proof of every prerequisite', () => {
  // Happy baseline from real producer bytes.
  const ok = governedRun({ minutes: 180 });
  try {
    const gate = assertEvaluationEligible(ok.id, {
      overrides: ok.overrides,
      currentSubmissionHash: ok.submissionHash,
    });
    assert.equal(gate.eligible, true, gate.problems.join('; '));
  } finally {
    ok.cleanup();
  }
  const cases = [
    ['missing frozen submission', { omitSubmission: true }, /never frozen at termination/],
    ['missing terminal record', { omitTerminal: true }, /produced no terminal supervision record/],
    ['non-quiescent terminal', { quiescent: false }, /does not positively prove quiescence/],
    ['missing identity claim', { omitClaim: true }, /carries no execution identity claim/],
    ['wrong terminal team', { terminalTeamId: 'other' }, /binds another team/],
    ['no persisted authority', { omitAuthority: true }, /No persisted official execution authority/],
  ];
  for (const [label, perturbation, pattern] of cases) {
    const g = governedRun({ minutes: 180, ...perturbation });
    try {
      const gate = assertEvaluationEligible(g.id, {
        overrides: g.overrides,
        currentSubmissionHash: g.submissionHash,
      });
      assert.equal(gate.eligible, false, label + ' must refuse');
      assert.match(gate.problems.join('; '), pattern, label);
    } finally {
      g.cleanup();
    }
  }
});

test('the frozen submission defines the official result; later bytes cannot replace it', () => {
  const g = governedRun({ minutes: 180 });
  try {
    const frozen = resolveFrozenSubmission(g.id, { overrides: g.overrides });
    assert.equal(frozen.submissionHash, g.submissionHash);
    // Missing comparison input is a refusal, not a default pass.
    const noHash = assertEvaluationEligible(g.id, { overrides: g.overrides });
    assert.equal(noHash.eligible, false);
    assert.match(noHash.problems.join('; '), /not supplied for comparison/);
    // Different bytes refuse.
    const changed = assertEvaluationEligible(g.id, {
      overrides: g.overrides,
      currentSubmissionHash: 'c'.repeat(64),
    });
    assert.equal(changed.eligible, false);
    assert.match(changed.problems.join('; '), /differ from the frozen participant submission/);
  } finally {
    g.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Terminal vocabulary and timestamp chronology
// ---------------------------------------------------------------------------
test('producer and consumer share one terminal vocabulary with no translation', () => {
  assert.deepEqual(ADMISSIBLE_TERMINAL_OUTCOMES, [
    TERMINAL_OUTCOMES.NATURAL_COMPLETION,
    TERMINAL_OUTCOMES.DEADLINE_HALT,
    TERMINAL_OUTCOMES.DEADLINE_OVERRUN_HALT,
  ]);
  // Every producer status maps deterministically.
  for (const [status, expected] of [
    ['COMPLETED', TERMINAL_OUTCOMES.NATURAL_COMPLETION],
    ['TIME_LIMIT', TERMINAL_OUTCOMES.DEADLINE_HALT],
    ['TIME_LIMIT_OVERRUN', TERMINAL_OUTCOMES.DEADLINE_OVERRUN_HALT],
    ['STOP_FAILURE', TERMINAL_OUTCOMES.STOP_FAILURE],
    ['SUPERVISOR_FAILURE', TERMINAL_OUTCOMES.SUPERVISOR_FAILURE],
    ['INFRASTRUCTURE_FAILURE', TERMINAL_OUTCOMES.INFRASTRUCTURE_FAILURE],
  ])
    assert.equal(terminalOutcomeOf({ status }).outcome, expected, status);
  // A declared outcome that contradicts the status is refused.
  assert.match(
    terminalOutcomeOf({
      status: 'TIME_LIMIT_OVERRUN',
      terminalOutcome: TERMINAL_OUTCOMES.NATURAL_COMPLETION,
    }).problem,
    /contradicts status/,
  );
  assert.match(
    terminalOutcomeOf({ status: 'WHAT', terminalOutcome: 'NONSENSE' }).problem,
    /Unknown terminal outcome/,
  );
  assert.match(terminalOutcomeOf({ status: 'WHAT' }).problem, /no mapping/);
  // The real halt record's own vocabulary satisfies the consumer.
  const halt = governedRun({ minutes: 180, status: 'TIME_LIMIT' });
  try {
    const r = reconcileSupervision({
      ...halt.supervision,
      executionIdentity: halt.executionIdentity,
    });
    assert.equal(r.supervisionValid, true, r.problems.join('; '));
    assert.equal(r.terminalOutcome, TERMINAL_OUTCOMES.DEADLINE_HALT);
  } finally {
    halt.cleanup();
  }
  const overrun = governedRun({
    minutes: 180,
    status: 'TIME_LIMIT_OVERRUN',
    overrunSeconds: 1294,
  });
  try {
    const r = reconcileSupervision({
      ...overrun.supervision,
      executionIdentity: overrun.executionIdentity,
    });
    assert.equal(r.supervisionValid, true, r.problems.join('; '));
    assert.equal(r.terminalOutcome, TERMINAL_OUTCOMES.DEADLINE_OVERRUN_HALT);
  } finally {
    overrun.cleanup();
  }
});

test('terminal timestamps are parsed, ordered and checked for contradiction', () => {
  const startedAt = '2026-10-06T10:00:00.000Z';
  const deadlineAt = '2026-10-06T11:00:00.000Z';
  const good = {
    status: 'TIME_LIMIT',
    terminalOutcome: TERMINAL_OUTCOMES.DEADLINE_HALT,
    haltRequested: true,
    startedAt,
    deadlineAt,
    triggeredAt: deadlineAt,
    terminationRequestedAt: deadlineAt,
    haltAcceptedAt: '2026-10-06T11:00:01.000Z',
    observedStoppedAt: '2026-10-06T11:00:02.000Z',
  };
  assert.equal(validateTerminalChronology(good).valid, true);
  const cases = [
    ['malformed date', { observedStoppedAt: 'not-a-date' }, /not a parseable timestamp/],
    ['non-string date', { observedStoppedAt: 12345 }, /not a timestamp string/],
    ['stop before start', { observedStoppedAt: '2026-10-06T09:00:00.000Z' }, /precedes the execution start/],
    ['impossible ordering', { haltAcceptedAt: '2026-10-06T11:00:05.000Z', observedStoppedAt: '2026-10-06T11:00:03.000Z' }, /impossible ordering/],
    ['halt before deadline', { triggeredAt: '2026-10-06T10:30:00.000Z', terminationRequestedAt: '2026-10-06T10:30:00.000Z' }, /cannot be triggered before the deadline/],
    ['contradictory outcome', { terminalOutcome: TERMINAL_OUTCOMES.NATURAL_COMPLETION }, /contradicts status/],
    ['halt carrying a natural completion', { naturalCompletionAt: '2026-10-06T10:30:00.000Z' }, /must not carry naturalCompletionAt/],
    ['deadline not after start', { deadlineAt: '2026-10-06T09:00:00.000Z' }, /not after startedAt/],
  ];
  for (const [label, defect, pattern] of cases) {
    const r = validateTerminalChronology({ ...good, ...defect });
    assert.equal(r.valid, false, label + ' must be invalid');
    assert.match(r.problems.join('; '), pattern, label);
  }
  // A natural completion missing its required instants.
  const natural = {
    status: 'COMPLETED',
    terminalOutcome: TERMINAL_OUTCOMES.NATURAL_COMPLETION,
    haltRequested: false,
    startedAt,
    deadlineAt,
    naturalCompletionAt: '2026-10-06T10:30:00.000Z',
    completionObservedAt: '2026-10-06T10:30:01.000Z',
  };
  assert.equal(validateTerminalChronology(natural).valid, true);
  assert.match(
    validateTerminalChronology({ ...natural, completionObservedAt: null }).problems.join('; '),
    /requires completionObservedAt/,
  );
  assert.match(
    validateTerminalChronology({
      ...natural,
      completionObservedAt: '2026-10-06T10:29:00.000Z',
    }).problems.join('; '),
    /observed before it occurred/,
  );
  // COMPLETED paired with STOP_FAILURE is a contradiction.
  assert.match(
    validateTerminalChronology({ ...natural, terminationOutcome: 'STOP_FAILURE' }).problems.join('; '),
    /contradicts terminationOutcome STOP_FAILURE/,
  );
});

// ---------------------------------------------------------------------------
// H4: conservative whole-run completion
// ---------------------------------------------------------------------------
test('H4: completion uses the latest required stop when known and a conservative observation when not', () => {
  const taskAt = '2026-10-06T05:31:01.841Z';
  const captainAt = '2026-10-06T05:31:02.007Z';
  const durable = (withStops) => ({
    tasks: [{ id: 't1', status: 'completed', completedAt: taskAt }],
    members: [
      {
        name: 'worker-1',
        status: 'idle',
        stoppedAt: withStops ? captainAt : null,
      },
    ],
    pendingSessionTransitions: [],
    captainStoppedAt: withStops ? captainAt : null,
  });
  const captainProjection = (withStops) => ({
    record: {
      rows: {
        sessionStats: {
          val: {
            openStep: null,
            pendingCalls: {},
            stoppedAt: withStops ? captainAt : null,
          },
        },
      },
    },
  });
  // Precise stop timestamps available: the LATEST required one wins, which is
  // the Captain's instant, not the earlier task instant.
  const precise = wholeRunCompletionForTest(durable(true), captainProjection(true));
  assert.equal(precise.stopTimestampsComplete, true);
  assert.equal(precise.authoritativeAtEpochMs, Date.parse(captainAt));
  assert.ok(
    precise.authoritativeAtEpochMs > Date.parse(taskAt),
    'completion must not precede the final required surface going quiescent',
  );
  // Precise stop timestamps unavailable: no authoritative instant is claimed,
  // the gap is reported, and the caller must fall back conservatively.
  const imprecise = wholeRunCompletionForTest(durable(false), captainProjection(false));
  assert.equal(imprecise.requiredSurfacesComplete, true);
  assert.equal(imprecise.stopTimestampsComplete, false);
  assert.equal(imprecise.authoritativeAtEpochMs, null);
  assert.deepEqual(imprecise.missingStopTimestamps, [
    'workersStoppedAt',
    'captainStoppedAt',
  ]);
  assert.equal(imprecise.latestKnownStopEpochMs, Date.parse(taskAt));
});

// ---------------------------------------------------------------------------
// Gaps the candidate.9 mutation pass exposed in its own coverage
// ---------------------------------------------------------------------------
test('the eligibility projection itself blocks a marker, an unfrozen submission and a mismatch', () => {
  const allGood = {
    schemaVersion: '1.2',
    outcomeClass: 'OFFICIAL_SUPERVISED',
    executionAuthorityResolved: true,
    executionRecordValid: true,
    seededAuthorityValid: true,
    governedDispatchProven: true,
    supervisionValid: true,
    terminationProven: true,
    telemetryBound: true,
  };
  assert.equal(projectOutcomeEligibility(allGood).validOutcome, true);
  // Each of these alone must invalidate, independently of any other stage that
  // also happens to catch it.
  for (const [label, over, pattern] of [
    ['incomplete-supervision marker', { incompleteSupervision: true }, /owner verification/],
    ['submission never frozen', { submissionFrozen: false }, /never frozen at termination/],
    ['evaluated bytes differ', { submissionMatchesFrozen: false }, /differ from the frozen participant submission/],
    ['authority not resolved', { executionAuthorityResolved: false }, /no governed launch/],
    ['execution record invalid', { executionRecordValid: false }, /not a valid official outcome/],
  ]) {
    const p = projectOutcomeEligibility({ ...allGood, ...over });
    assert.equal(p.validOutcome, false, label + ' must invalidate');
    assert.equal(p.eligibleForFormalComparison, false, label);
    assert.equal(p.eligibleForCalibrationAcceptance, false, label);
    assert.match(p.ineligibilityReasons.join('; '), pattern, label);
  }
});

test('a persisted authority without supervision evidence is refused', () => {
  const g = governedRun({ minutes: 180 });
  try {
    const at = path.join(g.runsDir, g.id + '-execution-authority.json');
    const record = JSON.parse(fs.readFileSync(at, 'utf8'));
    delete record.supervisionEvidence;
    fs.writeFileSync(at, JSON.stringify(record, null, 2));
    assert.throws(
      () => resolveOfficialExecution(g.id, { overrides: g.overrides }),
      /carries no supervision evidence for this run/,
    );
  } finally {
    g.cleanup();
  }
});

test('dispatch phases differ only in how an elapsed deadline is treated', () => {
  const g = governedRun({ minutes: 180, expiredArmed: true });
  try {
    // PRE_DISPATCH: an elapsed deadline is a stale binding.
    assert.throws(
      () =>
        assertDispatchAllowed(g.id, {
          armedEvidencePath: g.armedEvidencePath,
          expectedTeamId: g.teamId,
          overrides: g.overrides,
          alive: () => true,
          requireHeartbeat: false,
          phase: 'PRE_DISPATCH',
        }),
      /ARMED deadline has already expired/,
    );
    // POST_EXECUTION: the same elapsed deadline is the NORMAL terminal
    // condition and must not invalidate the binding, or a run that
    // legitimately crossed its deadline would leave no execution record.
    const after = assertDispatchAllowed(g.id, {
      armedEvidencePath: g.armedEvidencePath,
      expectedTeamId: g.teamId,
      overrides: g.overrides,
      alive: () => true,
      requireHeartbeat: false,
      phase: 'POST_EXECUTION',
    });
    assert.equal(after.permitted, true);
    assert.equal(after.phase, 'POST_EXECUTION');
    assert.equal(after.deadlineAt, g.deadlineAt);
    assert.throws(
      () =>
        assertDispatchAllowed(g.id, {
          armedEvidencePath: g.armedEvidencePath,
          expectedTeamId: g.teamId,
          overrides: g.overrides,
          alive: () => true,
          phase: 'NOT_A_PHASE',
        }),
      /Unknown dispatch phase/,
    );
  } finally {
    g.cleanup();
  }
});

test('H3 regression: identity sets reject duplicate, missing, empty and conflicting identities', () => {
  const ok = validateIdentitySet([{ logicalMember: 'a' }, { logicalMember: 'b' }], {
    label: 'member',
  });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.ids, ['a', 'b']);
  const cases = [
    ['duplicate', [{ logicalMember: 'a' }, { logicalMember: 'a' }], /Duplicate member identity a/],
    ['missing', [{ logicalMember: 'a' }, { status: 'idle' }], /has no identity/],
    ['empty', [{ logicalMember: 'a' }, { logicalMember: '   ' }], /empty or non-string identity/],
    ['conflicting', [{ logicalMember: 'a', name: 'b' }], /conflicting identities/],
    ['unavailable', null, /set is unavailable/],
  ];
  for (const [label, rows, pattern] of cases) {
    const r = validateIdentitySet(rows, { label: 'member' });
    assert.equal(r.valid, false, label + ' must be invalid');
    assert.equal(r.ids, null, label + ' must yield no ids');
    assert.match(r.problems.join('; '), pattern, label);
  }
});

test('M1 regression: observed supervision facts can never be rewritten', () => {
  const ledger = new SupervisionLedger({ startedAt: '2026-10-06T10:00:00.000Z' });
  assert.equal(ledger.facts.startedAt, '2026-10-06T10:00:00.000Z');
  // Re-recording the same value is allowed.
  ledger.record('startedAt', '2026-10-06T10:00:00.000Z');
  // Nulling is ignored, never destructive.
  ledger.record('startedAt', null);
  assert.equal(ledger.facts.startedAt, '2026-10-06T10:00:00.000Z');
  assert.throws(
    () => ledger.record('startedAt', '2026-10-06T11:00:00.000Z'),
    /cannot be rewritten/,
  );
});

test('UI regression: the owner PASS is resolved by reference hash, never by filename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-ui-'));
  try {
    const base = {
      kind: 'REFERENCE_UI_SANITY',
      verdict: 'PASS',
      reviewer: 'owner',
      reportedAt: '2026-10-06T00:00:00.000Z',
      evidence: 'exercised the reference',
    };
    // The canonical filename binds the WRONG reference.
    fs.writeFileSync(
      path.join(dir, 'reference-ui-sanity.json'),
      JSON.stringify({ ...base, referenceHash: 'old-reference' }),
    );
    // A differently named record binds the current one.
    fs.writeFileSync(
      path.join(dir, 'reference-ui-sanity-candidate.9.json'),
      JSON.stringify({ ...base, referenceHash: 'current-reference' }),
    );
    const resolved = resolveReferenceUiAcceptance('current-reference', {
      artifactsDir: dir,
    });
    assert.equal(resolved.source, 'reference-ui-sanity-candidate.9.json');
    assert.equal(resolved.record.referenceHash, 'current-reference');
    // And a reference with no matching record resolves to nothing, never to a
    // record bound to other bytes.
    const none = resolveReferenceUiAcceptance('some-other-reference', {
      artifactsDir: dir,
    });
    assert.equal(none.record, null);
    assert.equal(none.source, null);
    assert.ok(none.considered.length >= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// H6 regression: strict positive completeness
// ---------------------------------------------------------------------------
test('H6 regression: formal comparability requires positive, correctly typed facts', () => {
  const pair = () => [officialRow('a'), officialRow('b')];
  assert.equal(formalComparability(pair()).mode, 'FORMAL');
  const defects = [
    { valid: null },
    { valid: false },
    { valid: undefined },
    { supervisionValid: null },
    { supervisionValid: false },
    { eligibleForFormalComparison: false },
    { eligibleForFormalComparison: undefined },
    { outcomeClass: undefined },
    { outcomeClass: 'OFFICIAL_INVALID' },
    { official: false },
    { version: null },
    { version: '' },
    { publicHash: null },
    { ceiling: null },
    { ceiling: 0 },
    { quality: null },
    { quality: 'high' },
    { executionId: null },
    { officialOutcomeValid: false },
  ];
  for (const defect of defects) {
    const rows = [officialRow('a', defect), officialRow('b')];
    assert.notEqual(
      formalComparability(rows).mode,
      'FORMAL',
      JSON.stringify(defect) + ' must not be FORMAL',
    );
  }
  // A single run is not a controlled comparison.
  assert.notEqual(
    formalComparability([officialRow('a')]).mode,
    'FORMAL',
  );
});
