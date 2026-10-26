// The ACTUAL producer -> consumer governed chain.
//
// The candidate.8 reviewer's central objection: candidate.8's tests
// manufactured records the real producers do not emit, so a genuine successful
// producer path could not satisfy its consumer. The watchdog terminal record
// had no executionIdentityClaim, the launcher omitted supervisionEvidence, and
// the producer wrote TIME_LIMIT_OVERRUN where reconciliation demanded STOPPED.
//
// These tests run the real thing:
//
//   seeded run (createRun)
//     -> actual watchdog producer (runWatchdog against a loopback DSH)
//     -> actual official launcher (supervise, OFFICIAL_DSH_BENCHMARK)
//     -> actual terminal producer (the watchdog's own final record)
//     -> actual reconciliation (reconcileSupervision inside supervise)
//     -> actual telemetry producer (produceOfficialTelemetry)
//     -> actual telemetry ingest (report -> ingest)
//     -> actual evaluation gate (assertEvaluationEligible)
//
// Nothing is hand-written between stages: every consumer reads the previous
// producer's serialized output from disk.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tree, assertSnapshot } from '../files.mjs';
import { createRun } from '../create-run.mjs';
import { produceOfficialTelemetry } from '../telemetry-producer.mjs';
import { assertEvaluationEligible } from '../evaluate.mjs';
import { report } from '../../evaluator/report.mjs';
import {
  TERMINAL_OUTCOMES,
  BOUND_FACTS,
  activeMarkerPathFor,
  freezeSubmission,
  resolveOfficialExecution,
} from '../execution-authority.mjs';
import {
  evidenceFor,
  participantMeasurements,
  runRealGovernedChain,
  runsDir,
} from './chain-harness.mjs';

// The reviewed artifacts/candidate-manifest.json is a review input: redirect
// the snapshot to disposable scratch so this suite stays side-effect-free.
const manifestScratch = fs.mkdtempSync(
  path.join(os.tmpdir(), 'bb-chain-manifest-'),
);
process.env.BENCHBOARD_MANIFEST_PATH = path.join(
  manifestScratch,
  'candidate-manifest.json',
);
after(() => {
  delete process.env.BENCHBOARD_MANIFEST_PATH;
  fs.rmSync(manifestScratch, { recursive: true, force: true });
});

test('the actual governed chain completes end to end with no manufactured fields', async () => {
  const chain = await runRealGovernedChain({ idPrefix: 'chain-ok' });
  try {
    // --- the terminal producer emits what its consumer requires -------------
    assert.equal(
      chain.terminal.terminalOutcome,
      TERMINAL_OUTCOMES.NATURAL_COMPLETION,
    );
    assert.equal(chain.terminal.stopProven, true);
    assert.equal(chain.terminal.governedLaunchResolved, true);
    assert.ok(
      chain.terminal.executionIdentityClaim,
      'terminal record must carry the claim',
    );
    for (const key of BOUND_FACTS)
      assert.ok(
        chain.terminal.executionIdentityClaim[key] !== undefined &&
          chain.terminal.executionIdentityClaim[key] !== null,
        'terminal claim must state ' + key,
      );
    assert.equal(chain.terminalReturned.status, 'COMPLETED');

    // --- ONE SHARED CLOCK ---------------------------------------------------
    assert.equal(
      chain.execution.deadlineAt,
      chain.armed.deadlineAt,
      'the execution deadline must BE the watchdog deadline, not a second window',
    );
    assert.equal(chain.execution.startedAt, chain.armed.startedAt);
    assert.equal(
      Date.parse(chain.execution.deadlineAt) -
        Date.parse(chain.execution.startedAt),
      chain.minutes * 60_000,
      'the bound window is exactly the seeded ceiling',
    );
    // The observation genuinely started after the bound start, which is why a
    // second clock would have drifted.
    assert.ok(
      Date.parse(chain.execution.observationStartedAt) >=
        Date.parse(chain.execution.startedAt),
    );

    // --- the launcher emits supervision evidence and freezes the submission -
    const serialized = chain.executionSerialized;
    assert.ok(
      serialized.supervisionEvidence,
      'execution record must carry supervisionEvidence',
    );
    assert.equal(serialized.supervisionEvidence.runId, chain.id);
    assert.ok(fs.existsSync(serialized.supervisionEvidence.armedEvidencePath));
    assert.equal(serialized.supervisionValid, true);
    assert.equal(serialized.supervision.outcomeClass, 'SUPERVISED');
    assert.equal(
      serialized.supervision.terminalOutcome,
      TERMINAL_OUTCOMES.NATURAL_COMPLETION,
    );
    assert.equal(chain.frozenSubmission.submissionHash, chain.submissionHash);
    assert.equal(fs.existsSync(activeMarkerPathFor(chain.id)), false);

    // --- the persisted authority resolves -----------------------------------
    const authority = resolveOfficialExecution(chain.id);
    assert.equal(
      authority.executionId,
      serialized.executionIdentity.executionId,
    );

    // --- actual telemetry producer -> actual ingest --------------------------
    assert.equal(chain.telemetry.schemaVersion, '1.2');
    assert.equal(chain.telemetry.run.executionId, authority.executionId);
    const out = path.join(os.tmpdir(), 'bb-chain-report-' + process.pid);
    try {
      const produced = report(
        {
          evidence: evidenceFor(),
          telemetry: chain.telemetry,
          manifest: chain.manifest,
        },
        out,
      );
      assert.equal(
        produced.metrics.validOutcome,
        true,
        JSON.stringify(produced.metrics?.ineligibilityReasons),
      );
      assert.equal(produced.metrics.eligibleForFormalComparison, true);
      assert.equal(produced.metrics.eligibleForCalibrationAcceptance, true);
      assert.equal(produced.metrics.outcomeClass, 'OFFICIAL_SUPERVISED');
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }

    // --- actual evaluation gate ---------------------------------------------
    const eligible = assertEvaluationEligible(chain.id, {
      currentSubmissionHash: chain.submissionHash,
    });
    assert.equal(eligible.eligible, true, eligible.problems.join('; '));
    assert.equal(eligible.frozenSubmission.submissionHash, chain.submissionHash);

    // --- the freeze is real: changed bytes refuse official evaluation -------
    const refused = assertEvaluationEligible(chain.id, {
      currentSubmissionHash: 'f'.repeat(64),
    });
    assert.equal(refused.eligible, false);
    assert.match(
      refused.problems.join('; '),
      /differ from the frozen participant submission/,
    );

    // --- and the freeze is immutable ---------------------------------------
    assert.throws(
      () =>
        freezeSubmission({
          runId: chain.id,
          executionIdentity: chain.authority.executionIdentity,
          submissionHash: 'b'.repeat(64),
          terminalOutcome: TERMINAL_OUTCOMES.NATURAL_COMPLETION,
        }),
      /already exists for/,
    );
    assert.equal(chain.frozenSubmission.submissionHash, tree(chain.workspace).hash);
  } finally {
    chain.cleanup();
  }
  assertSnapshot();
});

test('without a governed launch there is no authoritative record and nothing downstream is official', async () => {
  const id = 'chain-forged-' + process.pid;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-chain-forge-'));
  try {
    createRun(id, base, { dependencies: false, timeCeilingMinutes: 1 });

    // ROOT: no exported primitive mints an official execution identity, so
    // ordinary code cannot manufacture one. Confirm the candidate.8 factory is
    // gone from the public surface rather than merely unused.
    const identityModule = await import('../execution-identity.mjs');
    assert.equal(identityModule.mintExecutionIdentity, undefined);
    const authorityModule = await import('../execution-authority.mjs');
    assert.equal(authorityModule.mintExecutionIdentity, undefined);
    assert.equal(authorityModule.mintIdentity, undefined);

    // No governed launch happened, so no authority is resolvable.
    assert.throws(
      () => resolveOfficialExecution(id),
      /No persisted official execution authority/,
    );
    // The telemetry producer cannot produce official telemetry at all.
    assert.throws(
      () =>
        produceOfficialTelemetry(
          id,
          participantMeasurements(
            new Date().toISOString(),
            new Date().toISOString(),
          ),
        ),
      /No persisted official execution authority/,
    );
    // The evaluation gate refuses.
    const gate = assertEvaluationEligible(id, {
      currentSubmissionHash: 'a'.repeat(64),
    });
    assert.equal(gate.eligible, false);
    assert.match(
      gate.problems.join('; '),
      /No persisted official execution authority/,
    );
  } finally {
    fs.rmSync(path.join(base, id), { recursive: true, force: true });
    fs.rmSync(path.join(runsDir, id + '.json'), { force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
  assertSnapshot();
});
