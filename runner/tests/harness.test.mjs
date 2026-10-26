import { scatter } from '../../evaluator/report.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  root,
  tree,
  files,
  contained,
  writeSnapshot,
  assertSnapshot,
} from '../files.mjs';
import { createRun, publicRoots } from '../create-run.mjs';
import { resetRun } from '../reset.mjs';
import { ingest } from '../collect-metrics.mjs';
import { score, uiCaps } from '../../evaluator/score.mjs';
import {
  executeCommand,
  supervise,
  stopProcessTree,
} from '../supervise.mjs';
import { readiness } from '../readiness.mjs';
const manifestScratch = fs.mkdtempSync(
  path.join(os.tmpdir(), 'bb-test-manifest-'),
);
process.env.BENCHBOARD_MANIFEST_PATH = path.join(
  manifestScratch,
  'candidate-manifest.json',
);
after(() => {
  delete process.env.BENCHBOARD_MANIFEST_PATH;
  if (contained(os.tmpdir(), manifestScratch))
    fs.rmSync(manifestScratch, { recursive: true, force: true });
});
const sample = () =>
  JSON.parse(fs.readFileSync(path.join(root, 'runner/telemetry.example.json')));
const hidden = () =>
  ['F', 'P', 'E', 'I'].flatMap((prefix) =>
    Array.from({ length: prefix === 'F' ? 13 : 4 }, (_, i) => ({
      id: prefix + String(i + 1).padStart(2, '0'),
      area: { F: 'functional', P: 'persistence', E: 'edge', I: 'integration' }[
        prefix
      ],
      passed: true,
    })),
  );
const full = () => ({
  visiblePassed: 17,
  hidden: hidden(),
  typecheck: true,
  build: true,
  noSuppression: true,
  usefulTests: {
    addedCount: 5,
    baselinePassed: true,
    killedMutations: [
      'storage-drop',
      'input-drop',
      'focus-drop',
      'label-case',
      'date-order',
    ],
  },
  hygiene: {
    visibleIntact: true,
    lockedDependencies: true,
    noSecrets: true,
    noDebugLogging: true,
    noNetwork: true,
  },
});
test('automated maximum is exactly 80; human maximum is 20', () => {
  assert.equal(score(full()).automated, 80);
  assert.equal(score(full()).quality, null);
  assert.equal(
    score(full(), {
      reviewer: 'synthetic',
      reviewedAt: '2026-10-05T00:00:00Z',
      evidence: 'synthetic cap test',
      baselineCompared: true,
      improvements: Object.fromEntries(
        Object.keys(uiCaps).map((k) => [k, 'synthetic improvement cap test']),
      ),
      scores: uiCaps,
    }).quality,
    100,
  );
});
test('duplicate/unknown hidden evidence is rejected', () => {
  const e = full();
  e.hidden[1] = { ...e.hidden[0] };
  assert.throws(() => score(e));
  const f = full();
  f.hidden[0].id = 'F99';
  assert.throws(() => score(f));
});
test('malicious/out-of-bound scoring input cannot exceed any cap', () => {
  const e = full();
  e.visiblePassed = 100000;
  e.usefulTests.killedMutations.push('storage-drop');
  assert.equal(score(e).automated, 80);
  assert.throws(() =>
    score(e, {
      reviewer: 'r',
      reviewedAt: 'now',
      evidence: 'x',
      scores: { ...uiCaps, polish: 6 },
    }),
  );
});
test('scoring is deterministic and missing evidence earns no assumed score', () => {
  assert.deepEqual(score(full()), score(full()));
  const e = full();
  e.hidden.forEach((t) => (t.passed = false));
  e.visiblePassed = 0;
  e.typecheck = false;
  e.build = false;
  e.noSuppression = false;
  e.usefulTests = null;
  e.hygiene = {};
  assert.equal(score(e).automated, 0);
});
test('token cache reads are not double counted; GPU time includes reserved idle', () => {
  const m = ingest(sample(), 90, 25);
  assert.equal(m.totalTokens, 2500);
  assert.equal(m.tokens.cacheReadTokens, 400);
  assert.equal(m.gpuHours, 1 / 6);
  assert.equal(m.efficiency.qualityPointsPerGPUHour, 540);
  assert.equal(m.workerUtilization, 0.8);
  assert.equal(m.unexplainedIdleSeconds, 120);
});
test('unavailable metrics remain null', () => {
  const d = sample();
  d.gpuReservations = null;
  d.attempts[0].tokens.inputTokens = null;
  d.workers[0].intervals = null;
  const m = ingest(d);
  assert.equal(m.totalTokens, null);
  assert.equal(m.workerUtilization, null);
  assert.equal(m.peakParallelism, null);
  assert.equal(m.efficiency.completedTasksPerGPUHour, null);
});
test('dependency cycles, duplicates and unknown attempts are rejected', () => {
  const d = sample();
  d.tasks[0].dependencies = ['task-1'];
  assert.throws(() => ingest(d));
  const e = sample();
  e.attempts.push({ ...e.attempts[0] });
  assert.throws(() => ingest(e));
  const f = sample();
  f.attempts[0].logicalMember = 'missing';
  assert.throws(() => ingest(f));
});
test('interval overlap, invalid milestones and duplicate GPU reservations are rejected', () => {
  const d = sample();
  d.workers[0].intervals.push({ ...d.workers[0].intervals[0] });
  assert.throws(() => ingest(d));
  const e = sample();
  e.attempts[0].firstPassingTestAt = '2026-10-05T20:09:00Z';
  assert.throws(() => ingest(e));
  const f = sample();
  f.gpuReservations.push({ ...f.gpuReservations[0] });
  assert.throws(() => ingest(f));
});
test('half-open concurrency counts busy workers rather than task windows', () => {
  const d = sample();
  d.workers.push({
    ...d.workers[0],
    logicalMember: 'worker-2',
    intervals: [
      {
        startedAt: '2026-10-05T20:08:00Z',
        completedAt: '2026-10-05T20:10:00Z',
        kind: 'busy',
      },
    ],
  });
  assert.equal(ingest(d).peakParallelism, 1);
  d.workers[1].intervals[0].startedAt = '2026-10-05T20:07:00Z';
  assert.equal(ingest(d).peakParallelism, 2);
});
test('time-limit, negative counters, identity and impossible dates are rejected', () => {
  const d = sample();
  d.run.status = 'TIME_LIMIT';
  assert.throws(() => ingest(d));
  const e = sample();
  e.captain.tokens.inputTokens = -1;
  assert.throws(() => ingest(e));
  assert.throws(() =>
    ingest(sample(), null, null, { runId: 'wrong', benchmarkVersion: 'x' }),
  );
  const f = sample();
  f.attempts[0].startedAt = '2026-02-31T20:00:00Z';
  assert.throws(() => ingest(f));
});
test('per-attempt retries and local/cloud accounting are retained', () => {
  const d = sample();
  d.attempts[0].status = 'FAILED';
  d.attempts.push({
    ...d.attempts[0],
    attemptId: 'second',
    location: 'cloud',
    status: 'COMPLETED',
  });
  const m = ingest(d);
  assert.equal(m.retries, 1);
  assert.equal(m.failedAttempts, 1);
  assert.equal(m.completedTasks, 1);
  assert.equal(m.tokensByLocation.cloud.inputTokens, 1000);
});
test('execution ceiling is declared per run and is not a global constant', async () => {
  // Official benchmark execution is refused outright without a supervision
  // binding, and an unseeded run has no ceiling authority in generic mode.
  const { GENERIC_COMMAND } = await import('../supervise.mjs');
  await assert.rejects(
    supervise('unused-unseeded-run', [process.execPath]),
    /requires watchdog ARMED evidence/,
  );
  await assert.rejects(
    supervise('unused-unseeded-run', [process.execPath], {
      mode: GENERIC_COMMAND,
    }),
    /Prepare candidate manifest first|ENOENT|no such file|declare timeCeilingMinutes/i,
  );
});
test('normal runner command completion and launch failures are recorded', async () => {
  const done = await executeCommand(
    [process.execPath, '-e', 'process.exit(0)'],
    root,
    { deadlineMs: 3000 },
  );
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.validOutcome, true);
  const bad = await executeCommand(['benchboard-does-not-exist.exe'], root, {
    deadlineMs: 3000,
  });
  assert.equal(bad.validOutcome, false);
  assert.equal(bad.status, null);
  assert.ok(bad.launchError);
});
test('short deadline kills a real cooperative process tree and records observed stopping', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-deadline-'));
  const heartbeat = path.join(scratch, 'heartbeat');
  const script = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify("const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),40)")},process.argv[1]],{stdio:'ignore'});setInterval(()=>{},1000);`;
  try {
    const result = await executeCommand(
      [process.execPath, '-e', script, heartbeat],
      scratch,
      { deadlineMs: 600 },
    );
    assert.equal(result.status, 'TIME_LIMIT');
    assert.equal(result.validOutcome, true);
    assert.equal(result.processExitObserved, true);
    assert.equal(result.terminationRequest.requested, true);
    assert.equal(
      Date.parse(result.deadlineAt) - Date.parse(result.startedAt),
      600,
    );
    assert.ok(result.observedStoppedAt);
    assert.ok(fs.existsSync(heartbeat));
    const size = fs.statSync(heartbeat).size;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      fs.statSync(heartbeat).size,
      size,
      'descendant heartbeat must stop',
    );
  } finally {
    if (contained(os.tmpdir(), scratch))
      fs.rmSync(scratch, { recursive: true, force: true });
  }
});
test('failed termination stays explicit harness behavior, never a valid stopped run', async () => {
  let captured;
  const result = await executeCommand(
    [process.execPath, '-e', 'setInterval(()=>{},1000)'],
    root,
    {
      deadlineMs: 50,
      stop: (child) => {
        captured = child;
        return { requested: false, error: 'synthetic stop failure' };
      },
    },
  );
  stopProcessTree(captured);
  assert.equal(result.status, 'TIME_LIMIT');
  assert.equal(result.validOutcome, false);
  assert.equal(result.harnessBehavior, 'STOP_FAILURE');
  assert.equal(result.processExitObserved, false);
  assert.equal(result.completedAt, null);
  assert.equal(result.observedStoppedAt, null);
  assert.ok(result.observationEndedAt);
});
test('one readiness state requires current human and independent fairness acceptance, never Docker', () => {
  const hashes = { candidate: 'test', reference: 'reference-bytes' };
  const v = { hashes, passed: true };
  const ui = {
    hashes,
    reviewer: 'human',
    kind: 'REFERENCE_UI_SANITY',
    verdict: 'PASS',
    reportedAt: '2026-10-05T00:00:00Z',
    referenceHash: hashes.reference,
    evidence: 'synthetic owner sanity PASS; no numerical score',
  };
  const f = {
    hashes,
    reviewer: 'independent',
    reviewedAt: '2026-10-05T00:00:00Z',
    verdict: 'PASS',
    BENCHBOARD_MAY_CALIBRATE: true,
    findings: { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] },
  };
  assert.equal(readiness(v, ui, f, hashes).READY_FOR_CALIBRATION, 'YES');
  assert.equal(readiness(v, null, f, hashes).READY_FOR_CALIBRATION, 'NO');
  assert.equal(
    readiness(v, { ...ui, verdict: 'FAIL' }, f, hashes).READY_FOR_CALIBRATION,
    'NO',
  );
  assert.equal(
    readiness(v, { ...ui, referenceHash: 'changed-reference' }, f, hashes)
      .READY_FOR_CALIBRATION,
    'NO',
  );
  assert.equal(
    readiness(v, ui, { ...f, hashes: { stale: true } }, hashes)
      .READY_FOR_CALIBRATION,
    'NO',
  );
  f.findings.MEDIUM.push({ resolved: false });
  assert.equal(readiness(v, ui, f, hashes).READY_FOR_CALIBRATION, 'NO');
});
test('public export/reset has exact hashes, no private material and rejects unsafe targets', () => {
  writeSnapshot();
  assertSnapshot();
  const id = 'self-test-' + process.pid;
  const base = path.join(os.tmpdir(), 'BenchBoard-Public-' + process.pid);
  const m = createRun(id, base, {
    dependencies: false,
    timeCeilingMinutes: 75,
  });
  try {
    assert.equal(
      tree(m.destination).hash,
      tree(path.join(root, 'starter')).hash,
    );
    for (const p of files(m.destination))
      assert.ok(publicRoots.has(p.split('/')[0]));
    assert.ok(
      !files(m.destination).some((p) =>
        /reference|hidden|evaluator|SCORING|DESIGN|BENCHMARK/.test(p),
      ),
    );
    const active = path.join(root, 'artifacts/runs', id + '-active.json');
    fs.writeFileSync(active, '{}');
    assert.throws(() => resetRun(id));
    fs.rmSync(active);
    fs.writeFileSync(
      path.join(m.destination, 'prior-output.txt'),
      'PRIOR RUN OUTPUT',
    );
    const reset = resetRun(id);
    assert.equal(reset.publicHash, m.publicHash);
    assert.ok(!fs.existsSync(path.join(m.destination, 'prior-output.txt')));
    assert.throws(() =>
      createRun('../escape', base, {
        dependencies: false,
        timeCeilingMinutes: 75,
      }),
    );
    assert.throws(() =>
      createRun(id, root, { dependencies: false, timeCeilingMinutes: 75 }),
    );
    assert.throws(() => resetRun('unregistered-id'));
  } finally {
    if (contained(base, m.destination))
      fs.rmSync(m.destination, { recursive: true, force: true });
    fs.rmSync(path.join(root, 'artifacts/runs', id + '.json'), { force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});
test('link traversal and content changes fail integrity checks', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-link-'));
  try {
    fs.symlinkSync(root, path.join(scratch, 'escape'), 'junction');
    assert.throws(() => files(scratch));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  writeSnapshot();
  const p = path.join(root, 'starter/src/hash-probe.txt');
  try {
    fs.writeFileSync(p, 'changed');
    assert.throws(() => assertSnapshot());
  } finally {
    fs.rmSync(p, { force: true });
  }
  assertSnapshot();
});

test('owner preparation cannot silently export an unapproved source file', () => {
  const p = path.join(root, 'starter/src/unapproved.ts');
  try {
    fs.writeFileSync(p, 'export const accidentallyPrivate=true;');
    writeSnapshot();
    assert.throws(
      () =>
        createRun(
          'unapproved-export',
          path.join(os.tmpdir(), 'bb-unapproved'),
          { dependencies: false, timeCeilingMinutes: 75 },
        ),
      /allowlist/,
    );
  } finally {
    fs.rmSync(p, { force: true });
    writeSnapshot();
  }
});

test('comparison plots reject mixed hashes and missing provenance', () => {
  const hashes = Object.fromEntries(
    [
      'spec',
      'specTree',
      'starter',
      'prd',
      'fixtures',
      'visible',
      'evaluator',
      'scoring',
      'runner',
      'reference',
    ].map((k) => [k, 'same']),
  );
  const row = {
    manifest: { benchmarkVersion: 'candidate', hashes },
    quality: { quality: 90 },
    metrics: {
      wallSeconds: 600,
      run: { runId: 'test', architectureId: 'synthetic' },
    },
  };
  assert.throws(() =>
    scatter(
      [
        row,
        {
          ...row,
          manifest: {
            ...row.manifest,
            hashes: { ...hashes, starter: 'different' },
          },
        },
      ],
      path.join(root, 'artifacts/invalid-comparison.html'),
    ),
  );
  assert.throws(() =>
    scatter(
      [{ ...row, manifest: null }],
      path.join(root, 'artifacts/invalid-comparison.html'),
    ),
  );
});
