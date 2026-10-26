// Candidate.7 regression suite for the independent candidate.6
// CHANGES_REQUESTED verdict. These are composition tests: each one drives the
// official path and proves a weaker helper cannot be reached around it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { root, candidate } from '../files.mjs';
import {
  ACTIVITY,
  boundedRequestText,
  classifyMember,
  classifyTask,
  expectedExecutionIdentities,
  formalComparability,
  assertFormalComparison,
  proveQuiescence,
  reconcileSupervision,
  resolveReferenceUiAcceptance,
  SupervisionLedger,
} from '../supervision.mjs';
import { ingest } from '../collect-metrics.mjs';
import { governedRun, officialRow } from './governed-fixture.mjs';
import { readiness } from '../readiness.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bb-governed-'));
function seedRun(dir, runId, minutes, extra = {}) {
  fs.writeFileSync(
    path.join(dir, runId + '.json'),
    JSON.stringify({
      runId,
      benchmarkVersion: '1.0.0-candidate.7',
      timeCeilingMinutes: minutes,
      timeCeilingSeconds: minutes * 60,
      runsDir: dir,
      ...extra,
    }),
  );
  return JSON.parse(fs.readFileSync(path.join(dir, runId + '.json'), 'utf8'));
}
const telemetry = () =>
  JSON.parse(fs.readFileSync(path.join(root, 'runner/telemetry.example.json')));
function officialTelemetry(runId, minutes) {
  const d = telemetry();
  const start = Date.parse(d.run.startedAt);
  const iso = (ms) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
  d.schemaVersion = '1.2';
  d.run.runId = runId;
  d.run.benchmarkVersion = '1.0.0-candidate.7';
  d.run.timeCeilingMinutes = minutes;
  d.run.status = 'TIME_LIMIT';
  d.run.deadlineAt = iso(start + minutes * 60000);
  d.run.observationEndedAt = iso(start + minutes * 60000);
  d.run.completedAt = iso(start + minutes * 60000);
  d.run.stopResult = 'STOPPED';
  return d;
}
let evidenceSeq = 0;
function supervisionEvidence(dir, runId, minutes, { terminal = 'TIME_LIMIT', pid = 4242, driftDeadline = false, omitTerminal = false } = {}) {
  // Each case gets its own evidence pair so one case cannot inherit another's.
  const slot = path.join(dir, 'ev' + ++evidenceSeq);
  fs.mkdirSync(slot, { recursive: true });
  const armedPath = path.join(slot, runId + '.evidence.json.armed.json');
  const finalPath = path.join(slot, runId + '.evidence.json');
  const startedAt = '2026-10-06T16:00:00.000Z';
  const deadlineAt = new Date(Date.parse(startedAt) + minutes * 60000).toISOString();
  fs.writeFileSync(armedPath, JSON.stringify({
    status: 'ARMED', runId, teamId: 'team-a', watchdogPid: pid,
    timeCeilingMinutes: minutes, startedAt, deadlineAt,
  }));
  if (!omitTerminal)
    fs.writeFileSync(finalPath, JSON.stringify({
      runId, teamId: 'team-a', watchdogPid: pid, status: terminal,
      deadlineAt: driftDeadline ? '2026-10-06T23:00:00.000Z' : deadlineAt,
    }));
  return { armedEvidencePath: armedPath, finalEvidencePath: finalPath, runId, overrides: { runsDir: dir } };
}


test('H1: legacy telemetry is readable but explicitly historical and ineligible', () => {
  const d = telemetry();
  d.schemaVersion = '1.1';
  d.run.deadlineAt = new Date(Date.parse(d.run.startedAt) + 4500000)
    .toISOString().replace(/\.000Z$/, 'Z');
  d.run.observationEndedAt = d.run.completedAt;
  d.run.stopResult = 'COMPLETED';
  const m = ingest(d);
  assert.equal(m.official, false);
  assert.equal(m.outcomeClass, 'HISTORICAL_UNBOUND_DESCRIPTIVE');
  assert.equal(m.validOutcome, false, 'legacy is not a valid current outcome');
  assert.equal(m.eligibleForFormalComparison, false);
  assert.equal(m.eligibleForCalibrationAcceptance, false);
  // An unbound 180-minute legacy claim cannot masquerade as bound.
  const unbound = structuredClone(d);
  unbound.run.timeCeilingMinutes = 180;
  assert.throws(() => ingest(unbound), /historical 75 minutes/);
});

// =========================================================================
// H2 — official dispatch requires live supervision; survival is reconciled
// =========================================================================
test('H2: official supervision is structural, not optional', async () => {
  const { OFFICIAL_DSH_BENCHMARK, GENERIC_COMMAND, supervise } = await import('../supervise.mjs');
  // The official route refuses to run without a supervision binding at all.
  await assert.rejects(
    supervise('h2-no-armed', [process.execPath, '-e', 'process.exit(0)'], {
      mode: OFFICIAL_DSH_BENCHMARK,
    }),
    /requires watchdog ARMED evidence/,
  );
  // ...and without the bound team identity.
  await assert.rejects(
    supervise('h2-no-team', [process.execPath], {
      mode: OFFICIAL_DSH_BENCHMARK,
      armedEvidencePath: path.join(os.tmpdir(), 'nope.json'),
    }),
    /requires the bound team identity/,
  );
  // The generic mode is a different, explicitly non-benchmark mode.
  assert.notEqual(OFFICIAL_DSH_BENCHMARK, GENERIC_COMMAND);
  await assert.rejects(
    supervise('h2-unknown-mode', [process.execPath], { mode: 'SOMETHING_ELSE' }),
    /Unknown supervision mode/,
  );
});



// =========================================================================
// H3 — quiescence is a coverage proof
// =========================================================================
test('H3: quiescence requires complete identity coverage', () => {
  const idle = (id) => ({ logicalMember: id, status: 'idle', activity: 'idle' });
  const done = (id) => ({ id, status: 'completed' });
  const base = (members, tasks) => ({
    captainSessionId: 'captain-a',
    members,
    tasks,
  });
  const prove = (durable, runtime) =>
    proveQuiescence({
      expected: expectedExecutionIdentities(durable, { captainSessionId: 'captain-a' }),
      durable,
      runtime,
      captainStopped: true,
    });

  // 6. complete matching positively-idle/terminal set -> QUIESCENT
  const complete = base([idle('w1'), idle('w2')], [done('t1')]);
  assert.equal(prove(complete, complete).quiescent, true);

  // 1. two durable workers, one runtime worker -> NOT QUIESCENT
  const partial = prove(complete, base([idle('w1')], [done('t1')]));
  assert.equal(partial.quiescent, false);
  assert.match(partial.reasons.join(' '), /Expected member w2 has no matching runtime observation/);

  // 2. mismatched worker id -> NOT QUIESCENT
  const mismatched = prove(complete, base([idle('w1'), idle('w9')], [done('t1')]));
  assert.equal(mismatched.quiescent, false);
  assert.match(mismatched.reasons.join(' '), /w2 has no matching runtime observation/);
  assert.match(mismatched.reasons.join(' '), /Unexplained runtime member w9/);

  // 3. unknown runtime task status -> NOT QUIESCENT
  const unknownTask = prove(complete, base([idle('w1'), idle('w2')], [{ id: 't1', status: 'mystery' }]));
  assert.equal(unknownTask.quiescent, false);
  assert.match(unknownTask.reasons.join(' '), /Task t1 runtime status is UNKNOWN/);

  // 4. missing expected worker from runtime entirely -> NOT QUIESCENT
  const missingAll = prove(complete, base([], [done('t1')]));
  assert.equal(missingAll.quiescent, false);

  // 5. extra active worker and extra task -> NOT QUIESCENT
  const extra = prove(
    complete,
    base([idle('w1'), idle('w2'), { logicalMember: 'w3', status: 'working' }], [done('t1'), done('t9')]),
  );
  assert.equal(extra.quiescent, false);
  assert.match(extra.reasons.join(' '), /Unexplained runtime member w3/);
  assert.match(extra.reasons.join(' '), /Unexplained runtime task t9/);

  // Unavailable identity sets fail closed.
  assert.equal(prove(base(null, null), base(null, null)).quiescent, false);
  assert.equal(
    proveQuiescence({
      expected: expectedExecutionIdentities(complete, { captainSessionId: 'captain-a' }),
      durable: complete,
      runtime: complete,
      captainStopped: false,
    }).quiescent,
    false,
    'captain must be positively stopped',
  );
});

// The formerly SURVIVING mutation: a member carrying no activity signal at all.
test('H3: a member with no activity signals is MISSING and cannot be idle', () => {
  assert.equal(classifyMember({}), ACTIVITY.MISSING);
  assert.equal(classifyMember({ logicalMember: 'w1' }), ACTIVITY.MISSING);
  assert.equal(classifyMember({ status: null, activity: null }), ACTIVITY.MISSING);
  assert.equal(classifyMember({ status: '', activity: '' }), ACTIVITY.MISSING);
  assert.notEqual(classifyMember({}), ACTIVITY.IDLE);
  assert.equal(classifyTask({}), ACTIVITY.MISSING);
  assert.equal(classifyTask({ id: 't1' }), ACTIVITY.MISSING);
  // And it must fail the coverage proof, not merely classify oddly.
  const durable = { captainSessionId: 'c', members: [{ logicalMember: 'w1' }], tasks: [{ id: 't1', status: 'completed' }] };
  const proof = proveQuiescence({
    expected: expectedExecutionIdentities(durable, { captainSessionId: 'c' }),
    durable,
    runtime: durable,
    captainStopped: true,
  });
  assert.equal(proof.quiescent, false, 'signal-less member must fail closed');
  assert.match(proof.reasons.join(' '), /w1 (durable|runtime) activity is MISSING/);
});

// =========================================================================
// H5 — the bound covers the response body
// =========================================================================
test('H5: a partial body that never completes aborts within the bound', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '64' });
    res.write('{"teams":');            // headers + partial body
    // body never completes
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const started = Date.now();
    // Race the bounded request against a generous test-local deadline so a
    // released bound fails this test fast instead of hanging the suite.
    let guard;
    const outcome = await Promise.race([
      boundedRequestText(
        `http://127.0.0.1:${port}/state`,
        {},
        { timeoutMs: 200, label: 'team lookup' },
      ).then(
        (value) => ({ kind: 'resolved', value }),
        (error) => ({ kind: 'rejected', error }),
      ),
      new Promise((resolve) => {
        guard = setTimeout(() => resolve({ kind: 'unbounded' }), 3000);
      }),
    ]);
    clearTimeout(guard);
    assert.notEqual(
      outcome.kind,
      'unbounded',
      'the bound must cover body consumption; the request never aborted',
    );
    assert.equal(outcome.kind, 'rejected', 'a never-completing body must not resolve');
    assert.equal(outcome.error.supervisionKind, 'STOP_FAILURE');
    assert.match(outcome.error.message, /before completing its response body/);
    assert.match(outcome.error.message, /team lookup/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2500, `aborted in ${elapsed}ms, must be near the bound`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

// =========================================================================
// H6 — eligibility is assessed on the original requested set
// =========================================================================
const identity = (over = {}) => ({
  spec: 's', specTree: 'st', starter: 'start', prd: 'p', fixtures: 'f',
  visible: 'v', evaluator: 'e', scoring: 'sc', runner: 'r', reference: 'ref', ...over,
});
const row = (runId, o = {}) => officialRow(runId, o);




// =========================================================================
// M1 — preserved as resolved
// =========================================================================
test('M1 regression: monotonic evidence behaviour is preserved', () => {
  const ledger = new SupervisionLedger({ startedAt: 'A' });
  ledger.record('triggeredAt', 'T1');
  ledger.record('terminationRequestedAt', 'T2');
  ledger.record('terminationRequestedAt', null);
  ledger.record('triggeredAt', undefined);
  assert.equal(ledger.snapshot().terminationRequestedAt, 'T2');
  assert.equal(ledger.snapshot().triggeredAt, 'T1');
  assert.throws(() => ledger.record('triggeredAt', 'T9'), /cannot be rewritten/);
});

// =========================================================================
// UI evidence resolution
// =========================================================================
test('UI: readiness resolves the PASS bound to the current reference hash', () => {
  const current = candidate().reference;
  const resolved = resolveReferenceUiAcceptance(current);
  assert.ok(resolved.record, 'a hash-bound owner PASS must be resolvable');
  assert.equal(resolved.record.referenceHash, current);
  assert.equal(resolved.record.verdict, 'PASS');
  assert.equal(resolved.record.kind, 'REFERENCE_UI_SANITY');
  assert.notEqual(resolved.source, 'reference-ui-sanity.json',
    'resolution must not depend on the older canonical filename');

  // The readiness gate must accept it and no longer list the UI blocker.
  const hashes = candidate();
  const gate = readiness(
    { hashes, passed: true },
    resolved.record,
    { hashes, reviewer: 'x', reviewedAt: 'y', verdict: 'PASS',
      BENCHBOARD_MAY_CALIBRATE: true,
      findings: { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] } },
    hashes,
  );
  assert.ok(
    !gate.blockers.some((b) => /reference UI sanity/i.test(b)),
    'UI blocker must clear: ' + JSON.stringify(gate.blockers),
  );

  // A record bound to a different reference must NOT be accepted.
  const dir = scratch();
  try {
    fs.writeFileSync(path.join(dir, 'reference-ui-sanity.json'), JSON.stringify({
      kind: 'REFERENCE_UI_SANITY', verdict: 'PASS', reviewer: 'o',
      reportedAt: 't', evidence: 'e', referenceHash: 'some-other-reference',
    }));
    const none = resolveReferenceUiAcceptance(current, { artifactsDir: dir });
    assert.equal(none.record, null, 'a non-matching record is never substituted');
    assert.ok(none.considered.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// H4 — observation continues after a transient failed confirmation
// =========================================================================
test('H4: a transient failed confirmation does not abandon early observation', async () => {
  const { runWatchdog, validateCompletionAttribution } = await import('../dsh-watchdog.mjs');
  const dir = scratch();
  let server;
  let completeSoon;
  try {
    // Start genuinely in progress, then complete mid-run so the natural
    // completion timestamp legitimately falls after execution start.
    const teamStatePath = path.join(dir, 'team.json');
    fs.writeFileSync(teamStatePath, JSON.stringify({
      id: 'team-a', captainSessionId: 'captain-a', halted: false,
      tasks: [{ id: 't1', status: 'in_progress' }],
      members: [{ logicalMember: 'w1', status: 'working', activity: 'working' }],
    }));
    let completedAt = null;
    completeSoon = setTimeout(() => {
      completedAt = new Date().toISOString();
      fs.writeFileSync(teamStatePath, JSON.stringify({
        id: 'team-a', captainSessionId: 'captain-a', halted: false, completedAt,
        tasks: [{ id: 't1', status: 'completed', completedAt }],
        members: [{ logicalMember: 'w1', status: 'idle', activity: 'idle' }],
      }));
    }, 60);
    fs.writeFileSync(path.join(dir, 'captain.json'), JSON.stringify({
      record: { rows: { sessionStats: { val: { openStep: null, pendingCalls: {} } } } },
    }));
    // The first two state confirmations fail; the third succeeds. A correct
    // implementation keeps observing instead of sleeping until the deadline.
    let stateCalls = 0;
    let haltCalls = 0;
    let failuresLeft = 2;
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.searchParams.get('token')) {
        res.setHeader('set-cookie', 'dsh=abc; Path=/');
        res.writeHead(200).end('{}');
        return;
      }
      if (url.pathname.endsWith('/halt')) { haltCalls += 1; res.writeHead(200).end('{}'); return; }
      stateCalls += 1;
      // Call 1 is the pre-ARM identity check. The first two confirmation
      // attempts after the durable completion fail transiently; later ones
      // succeed, so a correct implementation must still be observing.
      if (completedAt && failuresLeft > 0) {
        failuresLeft -= 1;
        res.writeHead(500).end('{"error":"transient"}');
        return;
      }
      res.writeHead(200).end(JSON.stringify({
        teams: [{
          teamId: 'team-a', captainSessionId: 'captain-a', halted: false,
          tasks: [{ id: 't1', status: completedAt ? 'completed' : 'in_progress' }],
          members: [{
            logicalMember: 'w1',
            status: completedAt ? 'idle' : 'working',
            activity: completedAt ? 'idle' : 'working',
          }],
        }],
      }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    fs.writeFileSync(path.join(dir, 'auth.log'), `dsh web:  http://127.0.0.1:${port}?token=tkn\n`);
    seedRun(dir, 'h4-transient', 60);
    const result = await runWatchdog({
      runId: 'h4-transient', teamId: 'team-a', captainSessionId: 'captain-a',
      baseUrl: `http://127.0.0.1:${port}`,
      evidencePath: path.join(dir, 'evidence.json'),
      authLaunchLog: path.join(dir, 'auth.log'),
      teamStatePath,
      captainStatePath: path.join(dir, 'captain.json'),
      runsDir: dir, observeIntervalMs: 15, pollMs: 15,
    });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(haltCalls, 0, 'a genuine early completion needs no halt');
    assert.ok(stateCalls >= 4, `observation must continue past failures (saw ${stateCalls})`);
    assert.ok(result.failedEarlyConfirmations.length >= 2,
      'the transient failures must be preserved as evidence');
    // Attribution is separately preserved and consistent.
    assert.notEqual(result.observedStoppedAt, result.deadlineAt);
    assert.ok(Date.parse(result.naturalCompletionAt) <= Date.parse(result.completionObservedAt));
    assert.ok(Date.parse(result.observedStoppedAt) < Date.parse(result.deadlineAt));
    assert.equal(result.overrunSeconds, 0);
  } finally {
    clearTimeout(completeSoon);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H4: impossible completion attribution is rejected', async () => {
  const { validateCompletionAttribution } = await import('../dsh-watchdog.mjs');
  const start = Date.parse('2026-10-06T16:00:00Z');
  const deadline = start + 3600_000;
  assert.ok(validateCompletionAttribution({
    startedAtEpochMs: start, naturalAtEpochMs: start + 1000,
    confirmedAtEpochMs: start + 2000, deadlineEpochMs: deadline,
  }));
  assert.throws(() => validateCompletionAttribution({
    startedAtEpochMs: start, naturalAtEpochMs: start + 5000,
    confirmedAtEpochMs: start + 1000, deadlineEpochMs: deadline,
  }), /later than its confirming observation/);
  assert.throws(() => validateCompletionAttribution({
    startedAtEpochMs: start, naturalAtEpochMs: start - 1,
    confirmedAtEpochMs: start + 1000, deadlineEpochMs: deadline,
  }), /cannot precede execution start/);
  assert.throws(() => validateCompletionAttribution({
    startedAtEpochMs: start, naturalAtEpochMs: deadline + 1,
    confirmedAtEpochMs: deadline + 2, deadlineEpochMs: deadline,
  }), /not an early natural completion/);
});
