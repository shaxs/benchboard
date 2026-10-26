import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  deadlineEpochFromIso,
  resolveTiming,
  runWatchdog,
} from "../dsh-watchdog.mjs";

const scratch = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "bb-dsh-watchdog-"));
// The seeded run manifest is the single authority for the execution ceiling,
// so every watchdog run must have one. Tests seed it explicitly rather than
// supplying a ceiling the watchdog would have to trust.
function seedAuthority(dir, runId, minutes) {
  fs.writeFileSync(
    path.join(dir, runId + ".json"),
    JSON.stringify({
      runId,
      benchmarkVersion: "test",
      timeCeilingMinutes: minutes,
      timeCeilingSeconds: minutes * 60,
    }),
  );
  return dir;
}
const captainId = "session-test-captain";
const teamId = "watchdog-test-team";

function writeState(root, { halted = false, active = true } = {}) {
  const teamStatePath = path.join(root, "team.json");
  const captainStatePath = path.join(root, "captain.json");
  fs.writeFileSync(
    teamStatePath,
    JSON.stringify({
      id: teamId,
      captainSessionId: captainId,
      halted,
      tasks: [
        {
          id: "t1",
          status: active ? "in_progress" : halted ? "cancelled" : "completed",
        },
      ],
      members: [{ name: "worker-1", status: active ? "working" : "idle" }],
      pendingSessionTransitions: [],
    }),
  );
  fs.writeFileSync(
    captainStatePath,
    JSON.stringify({
      record: {
        rows: {
          sessionStats: {
            val: { openStep: active ? 1 : null, pendingCalls: {} },
          },
        },
      },
    }),
  );
  return { teamStatePath, captainStatePath };
}

async function mockDsh(
  root,
  { acceptedToken = "good-token", initiallyActive = true } = {},
) {
  let halted = false;
  let haltCalls = 0;
  const statePaths = writeState(root, { active: initiallyActive });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      if (url.searchParams.get("token") === acceptedToken) {
        res.setHeader(
          "set-cookie",
          "dsh_session=accepted; HttpOnly; SameSite=Strict",
        );
        res.writeHead(303, { location: "/" }).end();
      } else {
        res.writeHead(200).end("ok");
      }
      return;
    }
    if (req.headers.cookie !== "dsh_session=accepted") {
      res
        .writeHead(401, { "content-type": "application/json" })
        .end('{"error":"unauthorized"}');
      return;
    }
    const snapshot = {
      teamId,
      captainSessionId: captainId,
      halted,
      tasks: [
        {
          id: "t1",
          status: halted
            ? "cancelled"
            : initiallyActive
              ? "in_progress"
              : "completed",
        },
      ],
      members: [
        {
          name: "worker-1",
          status: halted || !initiallyActive ? "idle" : "working",
          rotationState: null,
        },
      ],
    };
    if (url.pathname.endsWith("/state")) {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ teams: [snapshot] }));
      return;
    }
    if (url.pathname.endsWith("/halt") && req.method === "POST") {
      halted = true;
      haltCalls += 1;
      writeState(root, { halted: true, active: false });
      res
        .writeHead(200, { "content-type": "application/json" })
        .end('{"cancelledTasks":1,"alreadyHalted":false}');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/`,
    get haltCalls() {
      return haltCalls;
    },
    ...statePaths,
  };
}

test("epoch/offset deadline calculation is timezone independent in Pacific time", () => {
  const expected = 1791307080169;
  assert.equal(deadlineEpochFromIso("2026-10-06T17:18:00.169Z"), expected);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { deadlineEpochFromIso } from ${JSON.stringify(new URL("../dsh-watchdog.mjs", import.meta.url).href)};
    process.stdout.write(String(deadlineEpochFromIso('2026-10-06T17:18:00.169Z')));
  `,
    ],
    { env: { ...process.env, TZ: "America/Los_Angeles" }, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(Number(child.stdout), expected);
  assert.throws(() => deadlineEpochFromIso("2026-10-06 17:18:00"), /explicit/);
  assert.deepEqual(
    resolveTiming({ nowMs: expected - 120_000, ceilingSeconds: 120 }),
    {
      startedAtEpochMs: expected - 120_000,
      startedAt: "2026-10-06T17:16:00.169Z",
      deadlineEpochMs: expected,
      deadlineAt: "2026-10-06T17:18:00.169Z",
    },
  );
});

test("watchdog arms, calls only the team halt route, confirms quiescence and keeps DSH healthy", async () => {
  const root = scratch();
  const realStart = Date.now();
  const mock = await mockDsh(root);
  const authLog = path.join(root, "dsh.out.log");
  const evidencePath = path.join(root, "evidence.json");
  fs.writeFileSync(authLog, `dsh web: ${mock.baseUrl}?token=good-token\n`);
  try {
    const result = await runWatchdog({
      runId: "watchdog-unit-pass",
      runsDir: seedAuthority(root, "watchdog-unit-pass", 1),
      observeIntervalMs: 20,
      teamId,
      captainSessionId: captainId,
      baseUrl: mock.baseUrl,
      evidencePath,
      authLaunchLog: authLog,
      teamStatePath: mock.teamStatePath,
      captainStatePath: mock.captainStatePath,
      dshPid: process.pid,
      pollMs: 10,
      stopTimeoutMs: 2000,
    }, { now: () => realStart + (Date.now() - realStart) * 2000 });
    // Deadline enforcement always carries a truthful overrun measurement; any
    // positive enforcement latency is reported as TIME_LIMIT_OVERRUN rather
    // than being rounded away.
    assert.ok(
      ["TIME_LIMIT", "TIME_LIMIT_OVERRUN"].includes(result.status),
      `unexpected deadline status ${result.status}`,
    );
    assert.equal(
      result.status === "TIME_LIMIT_OVERRUN",
      result.overrunSeconds > 0,
    );
    assert.ok(Number.isFinite(result.overrunSeconds));
    assert.ok(result.supervisionTimeline.triggeredAt);
    assert.ok(result.supervisionTimeline.terminationRequestedAt);
    assert.equal(result.haltResult.httpStatus, 200);
    assert.ok(
      result.haltAcceptedAtEpochMs >= result.terminationRequestedAtEpochMs,
    );
    assert.equal(result.finalState.quiescent, true);
    assert.equal(result.finalState.halted, true);
    assert.equal(result.dshHealthy, true);
    assert.ok(fs.existsSync(`${evidencePath}.armed.json`));
    assert.ok(fs.existsSync(`${evidencePath}.events.jsonl`));
    assert.equal(
      JSON.parse(fs.readFileSync(`${evidencePath}.armed.json`)).status,
      "ARMED",
    );
    const bytes = fs.readFileSync(evidencePath, "utf8");
    assert.doesNotMatch(bytes, /good-token|dsh_session/);
  } finally {
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("natural completion is recorded without an unnecessary halt request", async () => {
  const root = scratch();
  const realStart = Date.now();
  const mock = await mockDsh(root, { initiallyActive: false });
  const authLog = path.join(root, "dsh.out.log");
  const evidencePath = path.join(root, "natural-completion.json");
  fs.writeFileSync(authLog, `dsh web: ${mock.baseUrl}?token=good-token\n`);
  try {
    const result = await runWatchdog({
      runId: "watchdog-unit-completed",
      runsDir: seedAuthority(root, "watchdog-unit-completed", 1),
      observeIntervalMs: 20,
      teamId,
      captainSessionId: captainId,
      baseUrl: mock.baseUrl,
      evidencePath,
      authLaunchLog: authLog,
      teamStatePath: mock.teamStatePath,
      captainStatePath: mock.captainStatePath,
      dshPid: process.pid,
      pollMs: 10,
      stopTimeoutMs: 2000,
    }, { now: () => realStart + (Date.now() - realStart) * 2000 });
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.haltResult, null);
    assert.equal(mock.haltCalls, 0);
  } finally {
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing/invalid authentication exits as visible SUPERVISOR_FAILURE before ARMED", async () => {
  const root = scratch();
  const mock = await mockDsh(root);
  const authLog = path.join(root, "dsh.out.log");
  const evidencePath = path.join(root, "negative-auth.json");
  fs.writeFileSync(authLog, `dsh web: ${mock.baseUrl}?token=wrong-token\n`);
  try {
    await assert.rejects(
      () =>
        runWatchdog({
          runId: "watchdog-unit-auth-fail",
          runsDir: seedAuthority(root, "watchdog-unit-auth-fail", 2),
          teamId,
          captainSessionId: captainId,
          baseUrl: mock.baseUrl,
          evidencePath,
          authLaunchLog: authLog,
          teamStatePath: mock.teamStatePath,
          captainStatePath: mock.captainStatePath,
          dshPid: process.pid,
        }),
      /session cookie/,
    );
    assert.equal(fs.existsSync(`${evidencePath}.armed.json`), false);
    const failure = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    assert.equal(failure.status, "SUPERVISOR_FAILURE");
    assert.equal(failure.terminationOutcome, "SUPERVISOR_FAILURE");
    assert.ok(failure.supervisorErrors.length > 0);
    assert.doesNotMatch(fs.readFileSync(evidencePath, "utf8"), /wrong-token/);
  } finally {
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
