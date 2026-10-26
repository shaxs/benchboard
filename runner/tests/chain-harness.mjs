// Harness that runs the REAL governed chain and returns the real producers'
// serialized output.
//
// Every governance fixture in this suite derives from these bytes, so no
// consumer is ever fed a record its producer does not actually emit — the
// central candidate.8 review finding.
//
// No live DSH: the DSH surface is a loopback HTTP server plus the durable
// state files the watchdog reads, exactly as the reviewer's own probe used.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { root, tree, writeSnapshot } from '../files.mjs';
import { createRun } from '../create-run.mjs';
import { supervise, OFFICIAL_DSH_BENCHMARK } from '../supervise.mjs';
import { runWatchdog } from '../dsh-watchdog.mjs';
import { produceOfficialTelemetry } from '../telemetry-producer.mjs';
import {
  authorityPathFor,
  activeMarkerPathFor,
  submissionPathFor,
} from '../execution-authority.mjs';

export const CAPTAIN_SESSION_ID = 'session-chain-captain';
export const CHAIN_TEAM_ID = 'chain-team';
export const runsDir = path.join(root, 'artifacts/runs');

export function writeTeamState(dir, { active }) {
  const teamStatePath = path.join(dir, 'team.json');
  const captainStatePath = path.join(dir, 'captain.json');
  const now = new Date().toISOString();
  fs.writeFileSync(
    teamStatePath,
    JSON.stringify({
      id: CHAIN_TEAM_ID,
      captainSessionId: CAPTAIN_SESSION_ID,
      halted: false,
      tasks: [
        {
          id: 't1',
          status: active ? 'in_progress' : 'completed',
          completedAt: active ? null : now,
        },
      ],
      members: [
        {
          name: 'worker-1',
          status: active ? 'working' : 'idle',
          stoppedAt: active ? null : now,
        },
      ],
      pendingSessionTransitions: [],
      captainStoppedAt: active ? null : now,
    }),
  );
  fs.writeFileSync(
    captainStatePath,
    JSON.stringify({
      record: {
        rows: {
          sessionStats: {
            val: {
              openStep: active ? 1 : null,
              pendingCalls: {},
              stoppedAt: active ? null : now,
            },
          },
        },
      },
    }),
  );
  return { teamStatePath, captainStatePath };
}

export async function loopbackDsh(dir, teamId = CHAIN_TEAM_ID) {
  let active = true;
  const statePaths = writeTeamState(dir, { active });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      if (url.searchParams.get('token') === 'chain-token') {
        res.setHeader(
          'set-cookie',
          'dsh_session=accepted; HttpOnly; SameSite=Strict',
        );
        res.writeHead(303, { location: '/' }).end();
      } else res.writeHead(200).end('ok');
      return;
    }
    if (req.headers.cookie !== 'dsh_session=accepted') {
      res
        .writeHead(401, { 'content-type': 'application/json' })
        .end('{"error":"unauthorized"}');
      return;
    }
    const now = new Date().toISOString();
    const snapshot = {
      teamId,
      captainSessionId: CAPTAIN_SESSION_ID,
      halted: false,
      tasks: [
        {
          id: 't1',
          status: active ? 'in_progress' : 'completed',
          completedAt: active ? null : now,
        },
      ],
      members: [
        {
          name: 'worker-1',
          status: active ? 'working' : 'idle',
          rotationState: null,
          stoppedAt: active ? null : now,
        },
      ],
    };
    if (url.pathname.endsWith('/state')) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ teams: [snapshot] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/`,
    ...statePaths,
    quiesce() {
      active = false;
      writeTeamState(dir, { active: false });
    },
  };
}

export function authLaunchLog(dir, baseUrl) {
  const at = path.join(dir, 'auth.log');
  // The real DSH launch-log format the watchdog parses.
  fs.writeFileSync(at, 'dsh web:  ' + baseUrl + '?token=chain-token\n');
  return at;
}

export async function waitForFile(at, timeoutMs = 25_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fs.existsSync(at)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error('Timed out waiting for ' + at);
}

// The participant half of telemetry. Governance facts are NOT settable here:
// produceOfficialTelemetry takes every bound fact from the persisted authority.
export const participantMeasurements = (startedAt, endedAt) => ({
  architectureId: 'SYNTHETIC_NOT_A_CALIBRATION',
  sessionPolicy: 'chain-fresh',
  configuration: { synthetic: true },
  captain: {
    model: 'Chain Captain',
    location: 'local',
    tokens: {
      inputTokens: 100,
      cacheReadTokens: 10,
      outputTokens: 20,
      modelSteps: 1,
      compactions: 0,
      toolCalls: 1,
    },
    modelWallSeconds: 1,
    humanInterventions: 0,
  },
  workers: [
    {
      logicalMember: 'worker-1',
      model: 'Chain Worker',
      location: 'local',
      availableStartedAt: startedAt,
      availableCompletedAt: endedAt,
      intervals: [{ startedAt, completedAt: endedAt, kind: 'busy' }],
    },
  ],
  tasks: [{ taskId: 't1', dependencies: [], taskType: 'chain' }],
  attempts: [
    {
      logicalMember: 'worker-1',
      model: 'Chain Worker',
      location: 'local',
      taskId: 't1',
      attemptId: 'a1',
      dispatchClass: 'chain-independent',
      sessionId: 's1',
      sessionGeneration: 1,
      startedAt,
      completedAt: endedAt,
      firstMeaningfulArtifactAt: startedAt,
      firstPassingTestAt: startedAt,
      status: 'COMPLETED',
      tokens: {
        inputTokens: 100,
        cacheReadTokens: 10,
        outputTokens: 20,
        modelSteps: 1,
        compactions: 0,
        toolCalls: 1,
      },
      decodeTokensPerSecond: null,
      ttftMs: null,
      modelWallSeconds: 1,
      startingContextTokens: null,
      endingContextTokens: null,
      cacheGrowthTokens: null,
      focusedTestsPassed: 1,
      focusedTestsTotal: 1,
      reworkSeconds: 0,
      falseCompletion: false,
      stalls: 0,
      captainWakeups: 0,
      invalidToolCalls: 0,
      scopeExpansions: 0,
      integrationDefects: 0,
      humanInterventions: 0,
    },
  ],
  gpuReservations: [
    { gpuId: 'GPU-0', startedAt, completedAt: endedAt, location: 'local' },
  ],
});

// The real hidden-property identity set, as the hidden evaluator emits it.
export const hiddenEvidence = () =>
  ['F', 'P', 'E', 'I'].flatMap((prefix) =>
    Array.from({ length: prefix === 'F' ? 13 : 4 }, (_, i) => ({
      id: prefix + String(i + 1).padStart(2, '0'),
      area: { F: 'functional', P: 'persistence', E: 'edge', I: 'integration' }[
        prefix
      ],
      passed: true,
    })),
  );
export const evidenceFor = () => ({
  visiblePassed: 17,
  hidden: hiddenEvidence(),
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

// Run the complete real chain once. Returns the real serialized artifacts.
export async function runRealGovernedChain({
  idPrefix = 'chain',
  minutes = 1,
} = {}) {
  writeSnapshot();
  const id = idPrefix + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-chain-ws-'));
  const dshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-chain-dsh-'));
  const evidenceBase = path.join(dshDir, 'watchdog');
  const disposers = [];
  const cleanup = () => {
    for (const fn of disposers.reverse())
      try {
        fn();
      } catch {}
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(dshDir, { recursive: true, force: true });
  };
  try {
    const manifest = createRun(id, base, {
      dependencies: false,
      timeCeilingMinutes: minutes,
    });
    disposers.push(() => fs.rmSync(path.join(base, id), { recursive: true, force: true }));
    for (const at of [
      path.join(runsDir, id + '.json'),
      path.join(runsDir, id + '-execution.json'),
      authorityPathFor(id),
      submissionPathFor(id),
      activeMarkerPathFor(id),
    ])
      disposers.push(() => fs.rmSync(at, { force: true }));

    const dsh = await loopbackDsh(dshDir);
    disposers.push(() => {
      dsh.server.closeAllConnections?.();
      dsh.server.close();
    });

    const watchdog = runWatchdog({
      runId: id,
      teamId: CHAIN_TEAM_ID,
      captainSessionId: CAPTAIN_SESSION_ID,
      baseUrl: dsh.baseUrl,
      authLaunchLog: authLaunchLog(dshDir, dsh.baseUrl),
      evidencePath: evidenceBase,
      teamStatePath: dsh.teamStatePath,
      captainStatePath: dsh.captainStatePath,
      runsDir,
      pollMs: 50,
      observeIntervalMs: 50,
      networkTimeoutMs: 2000,
      stopTimeoutMs: 2000,
    });
    const armedPath = evidenceBase + '.armed.json';
    await waitForFile(armedPath);

    // The supervised command flips the team to quiescent, then waits for the
    // watchdog's own terminal record before exiting. That is the real
    // interleaving of a natural completion, not a scripted sleep.
    const script = path.join(dshDir, 'participant.mjs');
    fs.writeFileSync(
      script,
      [
        "import fs from 'node:fs';",
        'const team = ' + JSON.stringify(dsh.teamStatePath) + ';',
        'const captain = ' + JSON.stringify(dsh.captainStatePath) + ';',
        'const finalPath = ' + JSON.stringify(evidenceBase) + ';',
        'const now = new Date().toISOString();',
        'const t = JSON.parse(fs.readFileSync(team, "utf8"));',
        't.tasks = t.tasks.map((x) => ({ ...x, status: "completed", completedAt: now }));',
        't.members = t.members.map((x) => ({ ...x, status: "idle", stoppedAt: now }));',
        't.captainStoppedAt = now;',
        'fs.writeFileSync(team, JSON.stringify(t));',
        'fs.writeFileSync(captain, JSON.stringify({ record: { rows: { sessionStats: { val: { openStep: null, pendingCalls: {}, stoppedAt: now } } } } }));',
        'const until = Date.now() + 25000;',
        'while (Date.now() < until) {',
        '  if (fs.existsSync(finalPath)) break;',
        '  await new Promise((r) => setTimeout(r, 25));',
        '}',
      ].join('\n'),
    );
    setTimeout(() => dsh.quiesce(), 50);

    const execution = await supervise(id, [process.execPath, script], {
      armedEvidencePath: armedPath,
      expectedTeamId: CHAIN_TEAM_ID,
      mode: OFFICIAL_DSH_BENCHMARK,
    });
    const terminalReturned = await watchdog;
    const telemetry = produceOfficialTelemetry(id, {
      ...participantMeasurements(execution.startedAt, execution.observationEndedAt),
    });
    const read = (at) => JSON.parse(fs.readFileSync(at, 'utf8'));
    return {
      id,
      minutes,
      manifest,
      workspace: manifest.destination,
      submissionHash: tree(manifest.destination).hash,
      armedPath,
      finalEvidencePath: evidenceBase,
      heartbeatPath: evidenceBase + '.alive.json',
      authorityPath: authorityPathFor(id),
      executionPath: path.join(runsDir, id + '-execution.json'),
      submissionPath: submissionPathFor(id),
      armed: read(armedPath),
      terminal: read(evidenceBase),
      terminalReturned,
      authority: read(authorityPathFor(id)),
      execution,
      executionSerialized: read(path.join(runsDir, id + '-execution.json')),
      // A chain that failed to reach a clean termination has no frozen
      // submission. Report that as data so the caller's assertions speak,
      // rather than crashing the harness on a missing file.
      frozenSubmission: fs.existsSync(submissionPathFor(id))
        ? read(submissionPathFor(id))
        : null,
      telemetry,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
