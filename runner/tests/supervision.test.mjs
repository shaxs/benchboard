// Regression suite for the independent candidate.5 CHANGES_REQUESTED review.
// Every test reproduces the reviewer's counterexample behaviourally and fails
// if the safety property is removed. No source scanning is used as proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { root } from '../files.mjs';
import {
  ACTIVITY,
  SupervisionError,
  SupervisionLedger,
  assertDispatchAllowed,
  assertFormalComparison,
  assertTelemetryMatchesAuthority,
  bindSupervisionTiming,
  boundedFetch,
  classifyActivity,
  confirmQuiescence,
  formalComparability,
  seededAuthority,
} from '../supervision.mjs';
import { ingest } from '../collect-metrics.mjs';
import { governedRun, officialRow } from './governed-fixture.mjs';
import { inspectQuiescence, runWatchdog } from '../dsh-watchdog.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bb-supervision-'));
function seedRun(dir, runId, minutes, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, runId + '.json'),
    JSON.stringify({
      runId,
      benchmarkVersion: '1.0.0-candidate.6',
      timeCeilingMinutes: minutes,
      timeCeilingSeconds: minutes * 60,
      runsDir: dir,
      ...extra,
    }),
  );
  return path.join(dir, runId + '.json');
}
const telemetry = () =>
  JSON.parse(fs.readFileSync(path.join(root, 'runner/telemetry.example.json')));
function timedTelemetry(minutes, startedAt) {
  const d = telemetry();
  const start = Date.parse(startedAt ?? d.run.startedAt);
  const iso = (ms) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
  d.schemaVersion = '1.2';
  d.run.startedAt = iso(start);
  d.run.timeCeilingMinutes = minutes;
  d.run.status = 'TIME_LIMIT';
  d.run.deadlineAt = iso(start + minutes * 60000);
  d.run.observationEndedAt = iso(start + minutes * 60000);
  d.run.completedAt = iso(start + minutes * 60000);
  d.run.stopResult = 'STOPPED';
  return d;
}


test('H1: watchdog timing binds to the seeded ceiling and rejects a conflicting claim', () => {
  const dir = scratch();
  try {
    seedRun(dir, 'h1-bind', 75);
    const authority = seededAuthority('h1-bind', { runsDir: dir });
    assert.equal(authority.timeCeilingSeconds, 4500);
    const startedAtEpochMs = Date.parse('2026-10-06T16:00:00Z');
    const timing = bindSupervisionTiming({ authority, startedAtEpochMs });
    assert.equal(timing.deadlineAt, '2026-10-06T17:15:00.000Z');
    // A caller cannot independently supply a conflicting ceiling or deadline.
    assert.throws(
      () =>
        bindSupervisionTiming({
          authority,
          startedAtEpochMs,
          claimedCeilingSeconds: 10800,
        }),
      /conflicts with the seeded authority/,
    );
    assert.throws(
      () =>
        bindSupervisionTiming({
          authority,
          startedAtEpochMs,
          claimedDeadlineEpochMs: startedAtEpochMs + 10800000,
        }),
      /Claimed deadline conflicts/,
    );
    // An unseeded run has no ceiling authority at all.
    assert.throws(
      () => seededAuthority('never-seeded', { runsDir: dir }),
      /no authority/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// =========================================================================
// H3 — unknown or missing activity must fail closed
// =========================================================================
test('H3 counterexample: terminal tasks + idle durable member + UNKNOWN runtime is not quiescent', () => {
  const dir = scratch();
  try {
    const teamStatePath = path.join(dir, 'team.json');
    const captainStatePath = path.join(dir, 'captain.json');
    const config = {
      teamId: 'team-a',
      captainSessionId: 'captain-a',
      teamStatePath,
      captainStatePath,
    };
    const durable = {
      id: 'team-a',
      captainSessionId: 'captain-a',
      halted: true,
      tasks: [{ id: 't1', status: 'completed' }],
      members: [{ logicalMember: 'w1', status: 'idle', activity: 'idle' }],
    };
    fs.writeFileSync(teamStatePath, JSON.stringify(durable));
    fs.writeFileSync(
      captainStatePath,
      JSON.stringify({
        record: { rows: { sessionStats: { val: { openStep: null, pendingCalls: {} } } } },
      }),
    );
    const known = inspectQuiescence(config, {
      halted: true,
      tasks: [{ id: 't1', status: 'completed' }],
      members: [{ logicalMember: 'w1', status: 'idle', activity: 'idle' }],
    });
    assert.equal(known.quiescent, true, 'positively known idle must pass');

    // The reviewer's state: runtime worker activity UNKNOWN.
    const unknown = inspectQuiescence(config, {
      halted: true,
      tasks: [{ id: 't1', status: 'completed' }],
      members: [{ logicalMember: 'w1', status: 'unknown' }],
    });
    assert.equal(unknown.quiescent, false, 'UNKNOWN must not establish idle');
    assert.ok(unknown.quiescenceReasons.length > 0);

    // Missing runtime member list entirely.
    const missing = inspectQuiescence(config, {
      halted: true,
      tasks: [{ id: 't1', status: 'completed' }],
    });
    assert.equal(missing.quiescent, false, 'MISSING must not establish idle');

    // Runtime reports no members while durable has one.
    const empty = inspectQuiescence(config, {
      halted: true,
      tasks: [{ id: 't1', status: 'completed' }],
      members: [],
    });
    assert.equal(empty.quiescent, false, 'unavailable runtime view is not idle');

    // Still working.
    const working = inspectQuiescence(config, {
      halted: true,
      tasks: [{ id: 't1', status: 'completed' }],
      members: [{ logicalMember: 'w1', status: 'working' }],
    });
    assert.equal(working.quiescent, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H3: activity classification keeps UNKNOWN and MISSING distinct from IDLE', () => {
  assert.equal(classifyActivity('idle'), ACTIVITY.IDLE);
  assert.equal(classifyActivity('working'), ACTIVITY.WORKING);
  assert.equal(classifyActivity('stopping'), ACTIVITY.WORKING);
  assert.equal(classifyActivity('something-new'), ACTIVITY.UNKNOWN);
  assert.equal(classifyActivity(undefined), ACTIVITY.MISSING);
  assert.equal(classifyActivity(null), ACTIVITY.MISSING);
  assert.equal(classifyActivity(''), ACTIVITY.MISSING);
  assert.equal(confirmQuiescence({ a: 'idle', b: 'idle' }).quiescent, true);
  assert.equal(confirmQuiescence({ a: 'idle', b: 'mystery' }).quiescent, false);
  assert.equal(confirmQuiescence({ a: 'idle', b: undefined }).quiescent, false);
  assert.equal(confirmQuiescence({}).quiescent, false, 'no surfaces is not idle');
});

// =========================================================================
// H4 — natural completion time is the actual completion, not the deadline
// =========================================================================
test('H4 counterexample: early completion is not stamped with the deadline', async () => {
  const dir = scratch();
  let server;
  try {
    // No pre-start durable completion stamp: the natural completion is
    // attributed to the first observation that positively confirms quiescence,
    // which necessarily falls after execution start.
    const durable = {
      id: 'team-a',
      captainSessionId: 'captain-a',
      halted: false,
      tasks: [{ id: 't1', status: 'completed' }],
      members: [{ logicalMember: 'w1', status: 'idle', activity: 'idle' }],
    };
    fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify(durable));
    fs.writeFileSync(
      path.join(dir, 'captain.json'),
      JSON.stringify({
        record: { rows: { sessionStats: { val: { openStep: null, pendingCalls: {} } } } },
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'auth.log'),
      'dsh web:  http://127.0.0.1:PORT?token=tkn\n',
    );
    let haltCalls = 0;
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.searchParams.get('token')) {
        res.setHeader('set-cookie', 'dsh=abc; Path=/');
        res.writeHead(200).end('{}');
        return;
      }
      if (url.pathname.endsWith('/halt')) {
        haltCalls += 1;
        res.writeHead(200).end('{}');
        return;
      }
      res.writeHead(200).end(
        JSON.stringify({
          teams: [
            {
              teamId: 'team-a',
              captainSessionId: 'captain-a',
              halted: false,
              tasks: [{ id: 't1', status: 'completed' }],
              members: [{ logicalMember: 'w1', status: 'idle', activity: 'idle' }],
            },
          ],
        }),
      );
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    fs.writeFileSync(
      path.join(dir, 'auth.log'),
      `dsh web:  http://127.0.0.1:${port}?token=tkn\n`,
    );
    seedRun(dir, 'h4-run', 60); // one-hour ceiling, completion is immediate
    const result = await runWatchdog({
      runId: 'h4-run',
      teamId: 'team-a',
      captainSessionId: 'captain-a',
      baseUrl: `http://127.0.0.1:${port}`,
      evidencePath: path.join(dir, 'evidence.json'),
      authLaunchLog: path.join(dir, 'auth.log'),
      teamStatePath: path.join(dir, 'team.json'),
      captainStatePath: path.join(dir, 'captain.json'),
      runsDir: dir,
      observeIntervalMs: 20,
      pollMs: 20,
    });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(haltCalls, 0, 'no halt request for a natural completion');
    // The recorded completion is NOT the deadline.
    assert.notEqual(result.observedStoppedAt, result.deadlineAt);
    assert.ok(
      Date.parse(result.observedStoppedAt) < Date.parse(result.deadlineAt),
      'completion must precede the deadline',
    );
    assert.equal(result.overrunSeconds, 0);
    // Actual completion and the watchdog's confirmation are both preserved.
    assert.ok(
      Date.parse(result.naturalCompletionAt) >= Date.parse(result.startedAt),
      'natural completion must fall at or after execution start',
    );
    assert.ok(
      Date.parse(result.naturalCompletionAt) <=
        Date.parse(result.completionObservedAt),
    );
    assert.ok(result.completionObservedAt);
    assert.equal(
      result.completionAttribution,
      'ACTUAL_QUIESCENCE_NOT_DEADLINE_OBSERVATION',
    );
    // A full-ceiling run would have been ~60 minutes; this must be far less.
    assert.ok(
      Date.parse(result.deadlineAt) - Date.parse(result.observedStoppedAt) >
        59 * 60 * 1000,
    );
  } finally {
    if (server) await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// H5 — every supervision network operation is bounded
// =========================================================================
test('H5 counterexample: a hanging request cannot outlive its bound', async () => {
  const server = http.createServer(() => {
    /* never responds */
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const started = Date.now();
    await assert.rejects(
      boundedFetch(
        `http://127.0.0.1:${port}/hang`,
        {},
        { timeoutMs: 150, label: 'team halt request' },
      ),
      (error) => {
        assert.ok(error instanceof SupervisionError);
        assert.equal(error.supervisionKind, 'STOP_FAILURE');
        assert.match(error.message, /Supervision network timeout/);
        assert.match(error.message, /team halt request/);
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, 'bound must fire well inside the outer deadline');
    // An unbounded timeout is refused outright.
    await assert.rejects(
      boundedFetch('http://127.0.0.1:1/x', {}, { timeoutMs: 0 }),
      /Bounded network timeout required/,
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('H5: a hanging halt surfaces STOP_FAILURE with evidence instead of hanging', async () => {
  const dir = scratch();
  let server;
  try {
    fs.writeFileSync(
      path.join(dir, 'team.json'),
      JSON.stringify({
        id: 'team-a',
        captainSessionId: 'captain-a',
        halted: false,
        tasks: [{ id: 't1', status: 'in_progress' }],
        members: [{ logicalMember: 'w1', status: 'working' }],
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'captain.json'),
      JSON.stringify({
        record: { rows: { sessionStats: { val: { openStep: null, pendingCalls: {} } } } },
      }),
    );
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.searchParams.get('token')) {
        res.setHeader('set-cookie', 'dsh=abc; Path=/');
        res.writeHead(200).end('{}');
        return;
      }
      if (url.pathname.endsWith('/halt')) return; // hang forever
      res.writeHead(200).end(
        JSON.stringify({
          teams: [
            {
              teamId: 'team-a',
              captainSessionId: 'captain-a',
              halted: false,
              tasks: [{ id: 't1', status: 'in_progress' }],
              members: [{ logicalMember: 'w1', status: 'working' }],
            },
          ],
        }),
      );
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    fs.writeFileSync(
      path.join(dir, 'auth.log'),
      `dsh web:  http://127.0.0.1:${port}?token=tkn\n`,
    );
    seedRun(dir, 'h5-run', 1);
    const evidencePath = path.join(dir, 'evidence.json');
    const started = Date.now();
    const realStart = Date.now();
    await assert.rejects(
      runWatchdog({
        runId: 'h5-run',
        teamId: 'team-a',
        captainSessionId: 'captain-a',
        baseUrl: `http://127.0.0.1:${port}`,
        evidencePath,
        authLaunchLog: path.join(dir, 'auth.log'),
        teamStatePath: path.join(dir, 'team.json'),
        captainStatePath: path.join(dir, 'captain.json'),
        runsDir: dir,
        observeIntervalMs: 20,
        pollMs: 20,
        networkTimeoutMs: 200,
        stopTimeoutMs: 1000,
      },
      // Accelerated-but-advancing clock: virtual time runs 2000x so the
      // 1-minute seeded deadline arrives in ~30ms of real time. The real
      // hanging-halt path and its real network bound are still exercised.
      { now: () => realStart + (Date.now() - realStart) * 2000 }),
      /Supervision network timeout|team halt request/,
    );
    assert.ok(Date.now() - started < 120_000);
    const failure = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    assert.equal(failure.status, 'STOP_FAILURE');
    // M1: the termination request happened, so it survives into failure evidence.
    assert.ok(failure.terminationRequestedAt, 'terminationRequestedAt preserved');
    assert.ok(failure.triggeredAt, 'triggeredAt preserved');
    assert.ok(failure.supervisionTimeline.triggeredAt);
    assert.ok(failure.supervisionTimeline.terminationRequestedAt);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// M1 — failure evidence is monotonic
// =========================================================================
test('M1: observed lifecycle facts can never be erased or rewritten', () => {
  const ledger = new SupervisionLedger({ startedAt: 'A' });
  ledger.record('triggeredAt', 'T1');
  ledger.record('terminationRequestedAt', 'T2');
  // Nulling or clearing an observed fact is a no-op, never an erasure.
  ledger.record('terminationRequestedAt', null);
  ledger.record('triggeredAt', undefined);
  assert.equal(ledger.snapshot().terminationRequestedAt, 'T2');
  assert.equal(ledger.snapshot().triggeredAt, 'T1');
  // Re-recording the same value is fine; changing it is refused.
  ledger.record('triggeredAt', 'T1');
  assert.throws(
    () => ledger.record('triggeredAt', 'T9'),
    /cannot be rewritten/,
  );
  assert.equal(ledger.has('haltAcceptedAt'), false);
});

// =========================================================================
// H6 — one authoritative formal-comparability predicate
// =========================================================================
const identity = (over = {}) => ({
  spec: 's', specTree: 'st', starter: 'start', prd: 'p', fixtures: 'f',
  visible: 'v', evaluator: 'e', scoring: 'sc', runner: 'r', reference: 'ref',
  ...over,
});
const row = (runId, o = {}) => officialRow(runId, o);



test('H6: reporting surfaces use the same predicate, not a weaker local copy', async () => {
  const reportModule = await import('../../evaluator/report.mjs');
  // The exported predicate must be the authoritative one.
  assert.equal(reportModule.assertFormalComparison, assertFormalComparison);
  assert.equal(reportModule.comparability, formalComparability);
  // And it must reject what the reviewer slipped past the old local copy.
  assert.throws(
    () =>
      reportModule.assertFormalComparison([
        row('a'),
        row('b', { hashes: identity({ starter: 'different' }) }),
      ]),
    /identity differs/,
  );
});
