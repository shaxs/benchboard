import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root, files, tree, writeSnapshot, assertSnapshot } from '../files.mjs';
import {
  CEILING_POLICY,
  LEGACY_FIXED_CEILING_SECONDS,
  ceilingMinutes,
  ceilingMs,
  ceilingSeconds,
  deadlineFrom,
  declaredCeiling,
  projectRunStatus,
  telemetryCeilingSeconds,
} from '../ceiling.mjs';
import { createRun } from '../create-run.mjs';
import { resetRun } from '../reset.mjs';
import { executeCommand } from '../supervise.mjs';
// The reviewed artifacts/candidate-manifest.json is a review input: tests must
// never rewrite it. Redirect the snapshot to disposable scratch, as the
// harness suite does, so this suite stays side-effect-free on a fresh checkout.
const manifestScratch = fs.mkdtempSync(
  path.join(os.tmpdir(), 'bb-ceiling-manifest-'),
);
process.env.BENCHBOARD_MANIFEST_PATH = path.join(
  manifestScratch,
  'candidate-manifest.json',
);
after(() => {
  delete process.env.BENCHBOARD_MANIFEST_PATH;
  fs.rmSync(manifestScratch, { recursive: true, force: true });
});
import { ingest } from '../collect-metrics.mjs';
import {
  comparability,
  assertFormalComparison,
  scatter,
} from '../../evaluator/report.mjs';
import { score } from '../../evaluator/score.mjs';
import { governedRun, officialRow } from './governed-fixture.mjs';

const telemetry = () =>
  JSON.parse(fs.readFileSync(path.join(root, 'runner/telemetry.example.json')));
// Official ingestion requires seeded authority and a complete supervision
// lifecycle. Tests bind both explicitly instead of bypassing the contract.
let recordSeq = 0;
// Official ingestion now requires a complete governed lifecycle, so these
// ceiling assertions run against a real one built by the shared fixture.
// Official ingestion requires a complete governed lifecycle AND all nine
// bound facts, which only the real telemetry producer can state. These ceiling
// assertions therefore start from the REAL producer's telemetry for a real
// governed run at the ceiling under test, and override only the run-level
// status/stop/timing semantics each case is about. No governance fact is
// hand-written.
function ingestOfficial(data, minutes) {
  const m = minutes ?? data.run.timeCeilingMinutes;
  const srcDeadline = Date.parse(data.run.deadlineAt);
  const srcEnd = Date.parse(
    data.run.observationEndedAt ?? data.run.completedAt ?? data.run.deadlineAt,
  );
  const overrun = Math.max(0, (srcEnd - srcDeadline) / 1000);
  const timeLimited = ['TIME_LIMIT', 'TIME_LIMIT_OVERRUN'].includes(
    data.run.status,
  );
  const g = governedRun({
    minutes: m,
    status: timeLimited ? 'TIME_LIMIT' : 'COMPLETED',
    overrunSeconds: overrun,
    quiescent: true,
  });
  try {
    const iso = (ms) => new Date(ms).toISOString();
    const over = { status: data.run.status };
    // Any non-natural-completion status carries its own stop semantics, so its
    // end/completion/termination instants are re-anchored onto the governed
    // clock. A natural completion keeps the real producer's own early instants.
    if (data.run.status !== 'COMPLETED') {
      // The official window ran to its bound deadline, plus any observed
      // overrun. A case that deliberately ends BEFORE the deadline keeps that
      // shortfall, so "TIME_LIMIT before ceiling" is still exercised.
      const endMs =
        srcEnd < srcDeadline
          ? Date.parse(g.deadlineAt) - (srcDeadline - srcEnd)
          : Date.parse(g.deadlineAt) + overrun * 1000;
      over.observationEndedAt = iso(endMs);
      over.completedAt = data.run.completedAt == null ? null : iso(endMs);
      over.terminationRequestedAt =
        data.run.terminationRequestedAt === null ||
        data.run.terminationRequestedAt === undefined
          ? null
          : g.deadlineAt;
    }
    if (data.run.stopResult !== undefined) over.stopResult = data.run.stopResult;
    if (data.run.terminationOutcome !== undefined)
      over.terminationOutcome = data.run.terminationOutcome;
    return ingest(g.telemetry(over), null, null, g.manifest, g.ingestOptions);
  } finally {
    g.cleanup();
  }
}


function timed(minutes, { status, overrunSeconds = 0, stopResult, completed = true }) {
  const d = telemetry();
  d.run.runId = 'ceiling-timed-' + minutes + '-' + ++recordSeq;
  const start = Date.parse(d.run.startedAt);
  const iso = (ms) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
  const deadline = start + minutes * 60000;
  const end = deadline + overrunSeconds * 1000;
  d.schemaVersion = '1.2';
  d.run.runId = 'ceiling-official-' + minutes;
  d.run.timeCeilingMinutes = minutes;
  d.run.status = status;
  d.run.deadlineAt = iso(deadline);
  d.run.observationEndedAt = iso(end);
  d.run.completedAt = completed ? iso(end) : null;
  d.run.stopResult = stopResult;
  d.run.terminationRequestedAt = iso(deadline);
  d.run.terminationOutcome = stopResult === 'STOP_FAILURE' ? 'STOP_FAILURE' : 'STOPPED';
  return d;
}
function early(minutes) {
  const d = telemetry();
  d.run.runId = 'ceiling-early-' + minutes + '-' + ++recordSeq;
  const start = Date.parse(d.run.startedAt);
  d.schemaVersion = '1.2';
  d.run.runId = 'ceiling-official-' + minutes;
  d.run.timeCeilingMinutes = minutes;
  d.run.status = 'COMPLETED';
  d.run.deadlineAt = new Date(start + minutes * 60000)
    .toISOString()
    .replace(/\.000Z$/, 'Z');
  d.run.observationEndedAt = d.run.completedAt;
  d.run.stopResult = 'COMPLETED';
  d.run.terminationRequestedAt = null;
  d.run.terminationOutcome = 'PROCESS_EXIT';
  return d;
}
const reportRow = (runId, ceiling, wallSeconds, quality = 80) =>
  officialRow(runId, { ceiling, quality });


// 1 + 2: valid per-run ceilings are accepted; 180 is not a universal constant.
test('per-run ceilings accept 180 minutes and other valid values', () => {
  for (const m of [1, 45, 75, 180, 240, 1440]) {
    assert.equal(ceilingMinutes(m), m);
    assert.equal(ceilingSeconds(m), m * 60);
    assert.equal(ceilingMs(m), m * 60000);
  }
  for (const bad of [0, -1, 1441, 1.5, '180', null, undefined, NaN])
    assert.throws(() => ceilingMinutes(bad), /timeCeilingMinutes/);
});

// 3: deadlineAt derives from startedAt plus the run-specific ceiling.
test('deadlineAt derives from startedAt and the declared run ceiling', () => {
  const start = '2026-10-06T16:03:00Z';
  assert.equal(deadlineFrom(start, 75), '2026-10-06T17:18:00.000Z');
  assert.equal(deadlineFrom(start, 180), '2026-10-06T19:03:00.000Z');
  assert.notEqual(deadlineFrom(start, 75), deadlineFrom(start, 180));
  const d = ingestOfficial(early(180));
  assert.equal(d.timeCeilingMinutes, 180);
  assert.equal(
    Date.parse(d.deadlineAt) - Date.parse(d.run.startedAt),
    180 * 60000,
  );
});

// 4: the ceiling cannot change silently, and a derived field cannot disagree.
test('declared ceiling is immutable and derived seconds cannot disagree', () => {
  assert.equal(declaredCeiling({ timeCeilingMinutes: 180 }), 180);
  assert.throws(
    () => declaredCeiling({}),
    /must declare timeCeilingMinutes before execution/,
  );
  assert.throws(
    () => declaredCeiling({ timeCeilingMinutes: 180, timeCeilingSeconds: 4500 }),
    /disagrees/,
  );
});

// 4 (structural): a seeded run records its ceiling before execution, a reset
// carries it forward unchanged, and an executing run refuses a different one.
test('seeded run persists its ceiling and reset preserves it', () => {
  writeSnapshot();
  const id = 'ceiling-test-' + process.pid;
  const base = path.join(os.tmpdir(), 'BenchBoard-Ceiling-' + process.pid);
  const m = createRun(id, base, {
    dependencies: false,
    timeCeilingMinutes: 180,
  });
  try {
    assert.equal(m.timeCeilingMinutes, 180);
    assert.equal(m.timeCeilingSeconds, 10800);
    assert.equal(m.ceilingPolicy, CEILING_POLICY);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(root, 'artifacts/runs', id + '.json')),
    );
    assert.equal(onDisk.timeCeilingMinutes, 180);
    const again = resetRun(id);
    assert.equal(again.timeCeilingMinutes, 180);
    assert.throws(
      () =>
        createRun(id + '-bad', base, {
          dependencies: false,
          timeCeilingMinutes: 0,
        }),
      /timeCeilingMinutes/,
    );
  } finally {
    fs.rmSync(path.join(base, id), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'artifacts/runs', id + '.json'), { force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
  assertSnapshot();
});

// 5: early natural completion keeps its actual elapsed time, not the ceiling.
test('early natural completion records actual completion time', () => {
  const m = ingestOfficial(early(180));
  assert.equal(m.run.status, 'COMPLETED');
  assert.equal(m.deadlineOverrunSeconds, 0);
  assert.equal(m.validOutcome, true);
  assert.ok(m.wallSeconds < 180 * 60);
  assert.equal(m.officialWindowSeconds, m.wallSeconds);
});

// 6: exact time-limit completion at a non-75-minute ceiling.
test('exact time limit at a declared 180-minute ceiling is represented', () => {
  const m = ingestOfficial(timed(180, { status: 'TIME_LIMIT', stopResult: 'STOPPED' }));
  assert.equal(m.wallSeconds, 180 * 60);
  assert.equal(m.officialWindowSeconds, 180 * 60);
  assert.equal(m.deadlineOverrunSeconds, 0);
  assert.equal(m.validOutcome, true);
  // A TIME_LIMIT claim below the declared ceiling is rejected.
  assert.throws(
    () =>
      ingestOfficial({
        ...timed(180, { status: 'TIME_LIMIT', stopResult: 'STOPPED' }),
        run: {
          ...timed(180, { status: 'TIME_LIMIT', stopResult: 'STOPPED' }).run,
          observationEndedAt: '2026-10-05T12:05:00Z',
          completedAt: '2026-10-05T12:05:00Z',
        },
      }),
    /TIME_LIMIT before ceiling|out-of-run|deadlineAt/,
  );
});

// 7: a delayed halt preserves nominal deadline, termination request, observed
// stop and overrun.
test('delayed stopping preserves deadline, request, observed stop and overrun', () => {
  const d = timed(180, {
    status: 'TIME_LIMIT_OVERRUN',
    overrunSeconds: 1294,
    stopResult: 'STOPPED',
  });
  const m = ingestOfficial(d);
  assert.equal(m.timeCeilingMinutes, 180);
  assert.equal(m.deadlineOverrunSeconds, 1294);
  assert.equal(m.officialWindowSeconds, 180 * 60);
  assert.equal(m.wallSeconds, 180 * 60 + 1294);
  // The governed clock is the watchdog's, so these are asserted as relations
  // rather than as template absolutes.
  assert.equal(m.run.terminationRequestedAt, m.run.deadlineAt);
  assert.equal(
    (Date.parse(m.observedEndAt) - Date.parse(m.run.deadlineAt)) / 1000,
    1294,
  );
  assert.equal(m.stopConfirmed, true);
  // An overrun status with no overrun is a contradiction.
  assert.throws(
    () =>
      ingestOfficial(
        timed(180, { status: 'TIME_LIMIT_OVERRUN', stopResult: 'STOPPED' }),
      ),
    /requires a recorded overrun/,
  );
});

// 8 + 9: stop failure and infrastructure failure remain representable.
test('stop failure and infrastructure failure are representable', () => {
  const failed = ingestOfficial(
    timed(180, {
      status: 'STOP_FAILURE',
      overrunSeconds: 400,
      stopResult: 'STOP_FAILURE',
      completed: false,
    }),
  );
  assert.equal(failed.run.status, 'STOP_FAILURE');
  assert.equal(failed.validOutcome, false);
  assert.equal(failed.stopConfirmed, false);
  assert.equal(failed.deadlineOverrunSeconds, 400);
  assert.throws(
    () =>
      ingestOfficial(
        timed(180, {
          status: 'STOP_FAILURE',
          overrunSeconds: 400,
          stopResult: 'STOP_FAILURE',
          completed: true,
        }),
      ),
    /Unconfirmed stop cannot claim completion/,
  );
  const infra = ingestOfficial(
    timed(180, {
      status: 'INFRASTRUCTURE_FAILURE',
      stopResult: 'COMPLETED',
    }),
  );
  assert.equal(infra.run.status, 'INFRASTRUCTURE_FAILURE');
  assert.equal(infra.validOutcome, false);
  // The supervisor projects the same five outcomes from its own evidence.
  assert.equal(
    projectRunStatus({ expired: false, exitCode: 0, overrunSeconds: 0 }),
    'COMPLETED',
  );
  assert.equal(
    projectRunStatus({ expired: true, overrunSeconds: 0 }),
    'TIME_LIMIT',
  );
  assert.equal(
    projectRunStatus({ expired: true, overrunSeconds: 12 }),
    'TIME_LIMIT_OVERRUN',
  );
  assert.equal(
    projectRunStatus({ expired: true, stopFailure: true, overrunSeconds: 12 }),
    'STOP_FAILURE',
  );
  assert.equal(
    projectRunStatus({ expired: false, launchError: 'boom', overrunSeconds: 0 }),
    'INFRASTRUCTURE_FAILURE',
  );
  assert.equal(
    projectRunStatus({ expired: false, exitCode: 3, overrunSeconds: 0 }),
    'INFRASTRUCTURE_FAILURE',
  );
});

// The low-level primitive carries the ceiling through to real execution.
test('supervisor primitive derives its deadline from the supplied ceiling', async () => {
  const done = await executeCommand(
    [process.execPath, '-e', 'process.exit(0)'],
    root,
    { deadlineMs: ceilingMs(1) },
  );
  assert.equal(done.runStatus, 'COMPLETED');
  assert.equal(done.terminationRequestedAt, null);
  assert.equal(done.terminationOutcome, 'PROCESS_EXIT');
  assert.equal(
    Date.parse(done.deadlineAt) - Date.parse(done.startedAt),
    ceilingMs(1),
  );
  assert.ok(done.officialWallSeconds <= 60);
  await assert.rejects(
    executeCommand([process.execPath], root, {}),
    /Invalid deadline/,
  );
});

// 10: Calibration #1 historical 75-minute evidence is unchanged and still
// ingests under its own legacy ceiling.
test('Calibration #1 historical 75-minute evidence remains unchanged', () => {
  const seed = path.join(root, 'artifacts/runs/bb-cal-001-flash-fresh.json');
  const exec = path.join(
    root,
    'artifacts/runs/bb-cal-001-flash-fresh-execution.json',
  );
  assert.ok(fs.existsSync(seed) && fs.existsSync(exec));
  const e = JSON.parse(fs.readFileSync(exec));
  assert.equal(e.hardLimitSeconds, LEGACY_FIXED_CEILING_SECONDS);
  assert.equal(e.status, 'TIME_LIMIT');
  assert.equal(
    Date.parse(e.deadlineAt) - Date.parse(e.startedAt),
    LEGACY_FIXED_CEILING_SECONDS * 1000,
  );
  assert.ok(e.overrunSeconds > 1200 && e.overrunSeconds < 1400);
  assert.equal(e.benchmarkVersion ?? '1.0.0-candidate.4', '1.0.0-candidate.4');
  // It is not relabelled as a 180-minute run.
  assert.notEqual(e.hardLimitSeconds, 10800);
  assert.equal(
    JSON.parse(fs.readFileSync(seed)).timeCeilingMinutes,
    undefined,
  );
  // Legacy records keep the historical ceiling and may not claim another one.
  assert.equal(
    telemetryCeilingSeconds({ schemaVersion: '1.1', run: {} }),
    LEGACY_FIXED_CEILING_SECONDS,
  );
  assert.throws(
    () =>
      telemetryCeilingSeconds({
        schemaVersion: '1.1',
        run: { timeCeilingMinutes: 180 },
      }),
    /historical 75 minutes/,
  );
});

// 11 + 12: formal comparison requires matching ceilings.
test('formal A/B accepts matching ceilings and rejects mismatched ones', () => {
  const matched = [
    reportRow('fresh-arm', 180, 6000),
    reportRow('persistent-arm', 180, 7200),
  ];
  const formal = assertFormalComparison(matched);
  assert.equal(formal.mode, 'FORMAL');
  assert.deepEqual(formal.ceilings, [180]);
  const mismatched = [
    reportRow('fresh-arm', 180, 6000),
    reportRow('persistent-arm', 75, 4500),
  ];
  const c = comparability(mismatched);
  assert.equal(c.mode, 'DESCRIPTIVE');
  assert.match(c.reasons.join(' '), /ceilings differ/);
  assert.throws(
    () => assertFormalComparison(mismatched),
    /Not a formal controlled comparison/,
  );
  // An undeclared ceiling is also not a formal pair.
  const unknown = [reportRow('a', 180, 6000), reportRow('b', 180, 6000)];
  unknown[1].metrics.timeCeilingMinutes = null;
  assert.equal(comparability(unknown).mode, 'DESCRIPTIVE');
});

// 13 + 14: mixed-ceiling reporting stays possible, clearly labelled, on an
// absolute-minute axis.
test('mixed-ceiling plots remain available, labelled, and absolute', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-ceiling-plot-'));
  const at = path.join(scratch, 'comparison.html');
  try {
    scatter([reportRow('fresh-arm', 180, 6000), reportRow('old-arm', 75, 4500)], at);
    const html = fs.readFileSync(at, 'utf8');
    assert.ok(html.includes('DESCRIPTIVE / NON-CONTROLLED comparison'));
    assert.ok(html.includes('ceilings differ'));
    assert.ok(html.includes('declared ceiling 180 min'));
    assert.ok(html.includes('declared ceiling 75 min'));
    // Absolute axis scaled to the largest declared ceiling, not per-run.
    assert.ok(html.includes('Elapsed wall time (0–180 minutes, absolute)'));
    scatter([reportRow('a', 180, 6000), reportRow('b', 180, 7200)], at);
    const formalHtml = fs.readFileSync(at, 'utf8');
    assert.ok(formalHtml.includes('Formal controlled comparison'));
    assert.ok(formalHtml.includes('matching declared ceilings'));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// 16: scoring has no time or ceiling term and stays deterministic.
test('scoring is deterministic and has no time or ceiling term', () => {
  const evidence = {
    visiblePassed: 17,
    hidden: [
      ...Array.from({ length: 13 }, (_, i) => ({
        id: 'F' + String(i + 1).padStart(2, '0'),
        area: 'functional',
        passed: true,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: 'P' + String(i + 1).padStart(2, '0'),
        area: 'persistence',
        passed: true,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: 'E' + String(i + 1).padStart(2, '0'),
        area: 'edge',
        passed: true,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: 'I' + String(i + 1).padStart(2, '0'),
        area: 'integration',
        passed: true,
      })),
    ],
    typecheck: true,
    build: true,
    noSuppression: true,
    usefulTests: { baselinePassed: true, addedCount: 1, killedMutations: [] },
    hygiene: {
      visibleIntact: true,
      lockedDependencies: true,
      noSecrets: true,
      noDebugLogging: true,
      noNetwork: true,
    },
  };
  const a = score(evidence);
  const b = score({ ...evidence, timeCeilingMinutes: 180, wallSeconds: 99999 });
  assert.equal(a.automated, b.automated);
  assert.equal(a.automated, 75);
  const source = fs.readFileSync(
    path.join(root, 'evaluator/score.mjs'),
    'utf8',
  );
  for (const forbidden of [
    'timeCeiling',
    'wallSeconds',
    'deadline',
    'minutes',
    'elapsed',
  ])
    assert.ok(!source.includes(forbidden), 'score.mjs must not read ' + forbidden);
});

// 15: participant workload bytes do not change because the ceiling became
// per-run. These are the candidate.4 values.
test('participant workload bytes are unchanged by the ceiling change', () => {
  const snapshot = assertSnapshot();
  assert.equal(
    snapshot.starter,
    'aead38d3607492066247dddc7cbfb9828860f008f6151d434210394c736cb1f8',
  );
  assert.equal(
    snapshot.prd,
    '5684791ddc9559e6f1fcbc648695758882e5ceebae82a80c0384ad07a577d252',
  );
  assert.equal(
    snapshot.spec,
    '9759d63168843f20df60fb18319062edab595995db97deeedee1afd2888f17fd',
  );
  assert.equal(tree(path.join(root, 'starter')).hash, snapshot.starter);
  assert.ok(files(path.join(root, 'starter')).length === 26);
});
