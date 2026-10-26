import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mintWatchdogNonce } from "./execution-identity.mjs";
import {
  TERMINAL_OUTCOMES,
  executionIdentityClaim,
  tryResolveOfficialExecution,
} from "./execution-authority.mjs";
import {
  ACTIVITY,
  boundedRequestText,
  expectedExecutionIdentities,
  proveQuiescence,
  SupervisionLedger,
  bindSupervisionTiming,
  boundedFetch,
  classifyActivity,
  classifyMember,
  confirmQuiescence,
  seededAuthority,
} from "./supervision.mjs";

const modulePath = fileURLToPath(import.meta.url);
const ACTIVE_TASK_STATES = new Set(["pending", "claimed", "in_progress"]);
const TERMINAL_TASK_STATES = new Set(["completed", "failed", "cancelled"]);

export const DEFAULT_POLL_MS = 1000;
// H5: every supervision network operation carries its own abort deadline.
export const DEFAULT_NETWORK_TIMEOUT_MS = 10_000;
// H4: bounded periodic observation so natural completion is attributable to
// actual quiescence rather than the eventual deadline observation.
export const DEFAULT_OBSERVE_INTERVAL_MS = 15_000;
export const DEFAULT_STOP_TIMEOUT_MS = 60_000;

function iso(epochMs) {
  return epochMs === null || epochMs === undefined
    ? null
    : new Date(epochMs).toISOString();
}

function finiteInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

export function deadlineEpochFromIso(value) {
  if (typeof value !== "string" || !/(?:Z|[+-]\d\d:\d\d)$/i.test(value))
    throw new Error(
      "deadline ISO value must carry an explicit UTC marker or offset",
    );
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error("invalid deadline ISO value");
  return epoch;
}

export function resolveTiming({
  nowMs = Date.now(),
  ceilingSeconds,
  deadlineEpochMs,
}) {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0)
    throw new Error("nowMs must be a positive epoch millisecond value");
  const hasCeiling = ceilingSeconds !== undefined;
  const hasDeadline = deadlineEpochMs !== undefined;
  if (hasCeiling === hasDeadline)
    throw new Error("provide exactly one of ceilingSeconds or deadlineEpochMs");
  const deadline = hasCeiling
    ? nowMs + finiteInteger(ceilingSeconds, "ceilingSeconds") * 1000
    : finiteInteger(deadlineEpochMs, "deadlineEpochMs");
  if (deadline <= nowMs) throw new Error("deadline must be in the future");
  return {
    startedAtEpochMs: nowMs,
    startedAt: iso(nowMs),
    deadlineEpochMs: deadline,
    deadlineAt: iso(deadline),
  };
}

function validateId(value, name) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)
  )
    throw new Error(`invalid ${name}`);
  return value;
}

function validateLoopbackBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:")
    throw new Error("DSH base URL must use local HTTP");
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname))
    throw new Error("DSH base URL must be loopback");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

// H2: the watchdog mints an unpredictable per-instance nonce at arm time and
// refreshes a heartbeat carrying it, so a later dispatch can prove the live PID
// really is this bound instance rather than an unrelated process.
function writeHeartbeat(paths, config, nonce, atEpochMs) {
  try {
    fs.writeFileSync(
      paths.heartbeatPath,
      `${JSON.stringify({
        kind: "BENCHBOARD_WATCHDOG_HEARTBEAT",
        runId: config.runId,
        teamId: config.teamId,
        watchdogPid: process.pid,
        watchdogNonce: nonce,
        at: iso(atEpochMs),
      })}\n`,
    );
  } catch {
    // A heartbeat write failure must not mask the supervision outcome; the
    // dispatch gate fails closed on a stale heartbeat instead.
  }
}
function ensureNewEvidencePaths(output) {
  const finalPath = path.resolve(output);
  const armedPath = `${finalPath}.armed.json`;
  const eventsPath = `${finalPath}.events.jsonl`;
  const heartbeatPath = `${finalPath}.alive.json`;
  const paths = [finalPath, armedPath, eventsPath, heartbeatPath];
  for (const candidate of paths)
    if (fs.existsSync(candidate))
      throw new Error(`evidence already exists: ${candidate}`);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  return { finalPath, armedPath, eventsPath, heartbeatPath };
}

function syncWriteNew(file, bytes) {
  const handle = fs.openSync(file, "wx");
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function appendEvent(file, event) {
  const handle = fs.openSync(file, "a");
  try {
    fs.writeFileSync(handle, `${JSON.stringify(event)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/([?&]token=)[^\s&]+/gi, "$1<redacted>")
    .replace(/(cookie:\s*)[^\r\n]+/gi, "$1<redacted>");
}

export function readLaunchToken(authLaunchLog) {
  const text = fs.readFileSync(authLaunchLog, "utf8");
  const matches = [
    ...text.matchAll(/dsh web:\s+https?:\/\/[^\s?]+\?token=([^\s]+)/g),
  ];
  if (matches.length === 0)
    throw new Error("DSH launch token not found in authentication source");
  return matches.at(-1)[1];
}

function cookiePairFromResponse(response) {
  const values =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  const pair = values
    .map((value) => value.split(";", 1)[0])
    .find((value) => value.includes("="));
  if (!pair)
    throw new Error(
      "DSH authentication exchange did not issue a session cookie",
    );
  return pair;
}

export async function establishDshSession({
  baseUrl,
  authLaunchLog,
  timeoutMs = DEFAULT_NETWORK_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const token = readLaunchToken(authLaunchLog);
  const login = new URL(baseUrl);
  login.searchParams.set("token", token);
  let response;
  try {
    // The bound covers headers and body; a partial-body hang must not outlive it.
    ({ response } = await boundedRequestText(
      login,
      { redirect: "manual", cache: "no-store" },
      { timeoutMs, fetchImpl, label: "DSH authentication" },
    ));
  } catch (error) {
    // H5: a bounded-network expiry stays visible instead of collapsing into a
    // generic connectivity error.
    if (error?.supervisionKind) throw error;
    throw new Error("DSH authentication exchange could not connect");
  }
  if (response.status < 200 || response.status >= 400)
    throw new Error(
      `DSH authentication exchange failed with HTTP ${response.status}`,
    );
  return cookiePairFromResponse(response);
}

async function jsonRequest(
  url,
  {
    cookie,
    method = "GET",
    body,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_NETWORK_TIMEOUT_MS,
    label,
  },
) {
  let response;
  let raw;
  try {
    const bounded = await boundedRequestText(
      url,
      {
        method,
        cache: "no-store",
        headers: {
          accept: "application/json",
          cookie,
          origin: new URL(url).origin,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { timeoutMs, fetchImpl, label: label ?? `DSH ${method} ${url}` },
    );
    response = bounded.response;
    raw = bounded.text;
  } catch (error) {
    if (error?.supervisionKind) throw error;
    throw new Error(`DSH ${method} request could not connect`);
  }
  let value = null;
  if (raw.trim() !== "") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(
        `DSH ${method} returned non-JSON HTTP ${response.status}`,
      );
    }
  }
  if (!response.ok) {
    const detail = typeof value?.error === "string" ? `: ${value.error}` : "";
    throw new Error(
      `DSH ${method} failed with HTTP ${response.status}${detail}`,
    );
  }
  return { status: response.status, value };
}

export async function queryExactTeam(config, cookie, fetchImpl = fetch) {
  const url = new URL("/plugins/dsh-agent-teams/state", config.baseUrl);
  url.searchParams.set("sessionId", config.captainSessionId);
  const { value } = await jsonRequest(url, {
    cookie,
    fetchImpl,
    timeoutMs: config.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS,
    label: "team lookup",
  });
  const teams = Array.isArray(value?.teams) ? value.teams : [];
  const exact = teams.filter((team) => team?.teamId === config.teamId);
  if (exact.length !== 1)
    throw new Error(`expected exactly one target team, found ${exact.length}`);
  if (exact[0].captainSessionId !== config.captainSessionId)
    throw new Error("target team captain authority does not match");
  return exact[0];
}

export async function haltExactTeam(config, cookie, fetchImpl = fetch) {
  const url = new URL("/plugins/dsh-agent-teams/halt", config.baseUrl);
  return jsonRequest(url, {
    cookie,
    method: "POST",
    body: { sessionId: config.captainSessionId, teamId: config.teamId },
    fetchImpl,
    timeoutMs: config.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS,
    label: "team halt request",
  });
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label}: ${safeError(error)}`);
  }
}

function pendingTransitionCount(team) {
  return (team?.members ?? []).filter(
    (member) => member.sessionTransition !== undefined,
  ).length;
}

function captainProjectionStopped(projection) {
  const stats = projection?.record?.rows?.sessionStats?.val;
  if (!stats || stats.openStep !== null) return false;
  const calls = stats.pendingCalls;
  return (
    !calls || (typeof calls === "object" && Object.keys(calls).length === 0)
  );
}

export function inspectQuiescence(config, snapshot) {
  const durable = readJson(config.teamStatePath, "durable team state");
  const captain = readJson(config.captainStatePath, "captain projection");
  if (
    durable.id !== config.teamId ||
    durable.captainSessionId !== config.captainSessionId
  )
    throw new Error("durable team identity does not match watchdog authority");
  const captainStopped = captainProjectionStopped(captain);
  // H3: prove coverage over the authoritative expected execution identity set.
  // Missing, mismatched, unknown, contradictory or unexplained-extra identities
  // all fail closed; only a complete positively terminal/idle set passes.
  const expected = expectedExecutionIdentities(durable, config);
  const proof = proveQuiescence({
    expected,
    durable,
    runtime: snapshot,
    captainStopped,
  });
  const recoveryBlockedTasks = (durable.tasks ?? []).filter(
    (task) => task.recoveryBlocked === true,
  );
  const pendingTransitions = pendingTransitionCount(durable);
  const reasons = [...proof.reasons];
  if (recoveryBlockedTasks.length)
    reasons.push(recoveryBlockedTasks.length + " task(s) are recovery blocked");
  if (pendingTransitions)
    reasons.push(pendingTransitions + " pending session transition(s) remain");
  return {
    quiescent: proof.quiescent && !recoveryBlockedTasks.length && !pendingTransitions,
    quiescenceReasons: reasons,
    coverage: proof.coverage,
    expectedIdentities: expected,
    halted: durable.halted === true && snapshot.halted === true,
    captainStopped,
    activeTaskCount: (durable.tasks ?? []).filter((t) =>
      ACTIVE_TASK_STATES.has(t.status),
    ).length,
    nonterminalTaskCount: (durable.tasks ?? []).filter(
      (t) => !TERMINAL_TASK_STATES.has(t.status),
    ).length,
    recoveryBlockedTaskCount: recoveryBlockedTasks.length,
    pendingTransitionCount: pendingTransitions,
  };
}

function dshAlive(pid) {
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(epochMs, now = Date.now) {
  while (now() < epochMs) await sleep(Math.min(1000, epochMs - now()));
}
// H4: observe the durable team state periodically while waiting so a natural
// completion is attributable to the actual completion/quiescence, not to the
// eventual deadline observation. Local file reads only; no network polling.
// H4: whole-run completion requires the COMPLETE required execution set to be
// finished. The last task timestamp is not the benchmark's completion instant
// if the Captain or a worker is still executing afterwards.
export function wholeRunCompletionForTest(durable, captainProjection) {
  return wholeRunCompletion(durable, captainProjection);
}
function wholeRunCompletion(durable, captainProjection) {
  const tasks = durable?.tasks ?? [];
  const members = durable?.members ?? [];
  if (!tasks.length) return null;
  if (!tasks.every((task) => TERMINAL_TASK_STATES.has(task.status))) return null;
  if (members.some((member) => classifyMember(member) !== ACTIVITY.IDLE)) return null;
  if (pendingTransitionCount(durable) !== 0) return null;
  if (!captainProjectionStopped(captainProjection)) return null;
  const parse = (v) => {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  };
  const taskStamps = tasks
    .map((t) => parse(t.completedAt ?? t.finishedAt))
    .filter((t) => t !== null);
  const workerStamps = members
    .map((m) => parse(m.stoppedAt ?? m.idleAt))
    .filter((t) => t !== null);
  const captainStamp =
    parse(captainProjection?.record?.rows?.sessionStats?.val?.stoppedAt) ??
    parse(durable?.captainStoppedAt);
  const taskGraphCompletedAtEpochMs = taskStamps.length ? Math.max(...taskStamps) : null;
  const workersStoppedAtEpochMs = workerStamps.length ? Math.max(...workerStamps) : null;
  // H4 (candidate.9): the authoritative instant is the LAST required execution
  // authority to become quiescent. Candidate.8 took the max of whichever
  // timestamps happened to exist, so a missing Captain/worker stop timestamp
  // silently understated completion to the final task instant.
  //
  // If every required stop timestamp is present, use the latest. If any is
  // MISSING, the exact instant is unknown and the only defensible value is the
  // conservative confirming observation. Missing timestamps are reported here,
  // never discarded while still claiming requiredSurfacesComplete.
  const missingStopTimestamps = [];
  if (!taskStamps.length) missingStopTimestamps.push('taskGraphCompletedAt');
  if (members.length && !workerStamps.length)
    missingStopTimestamps.push('workersStoppedAt');
  if (captainStamp === null) missingStopTimestamps.push('captainStoppedAt');
  const present = [
    taskGraphCompletedAtEpochMs,
    workersStoppedAtEpochMs,
    captainStamp,
  ].filter((t) => t !== null);
  const stopTimestampsComplete = missingStopTimestamps.length === 0;
  return {
    taskGraphCompletedAtEpochMs,
    workersStoppedAtEpochMs,
    captainStoppedAtEpochMs: captainStamp,
    // Only an instant derived from COMPLETE stop evidence is authoritative.
    authoritativeAtEpochMs:
      stopTimestampsComplete && present.length ? Math.max(...present) : null,
    latestKnownStopEpochMs: present.length ? Math.max(...present) : null,
    stopTimestampsComplete,
    missingStopTimestamps,
    requiredSurfacesComplete: true,
  };
}
function durableNaturalCompletion(config) {
  let durable;
  let captain;
  try {
    durable = readJson(config.teamStatePath, "durable team state");
    captain = readJson(config.captainStatePath, "captain projection");
  } catch {
    return null;
  }
  return wholeRunCompletion(durable, captain);
}
async function observeUntilCompletionOrDeadline(
  config,
  timing,
  now,
  observeMs,
  confirm,
  ledger,
  onTick,
) {
  const failedConfirmations = [];
  while (now() < timing.deadlineEpochMs) {
    onTick?.(now());
    const natural = durableNaturalCompletion(config);
    if (natural) {
      const observedAtEpochMs = now();
      try {
        const confirmed = await confirm();
        if (confirmed?.quiescent)
          return {
            natural,
            observedAtEpochMs,
            state: confirmed,
            failedConfirmations,
          };
        failedConfirmations.push({
          atEpochMs: observedAtEpochMs,
          at: iso(observedAtEpochMs),
          reason: "not quiescent on confirmation",
          detail: confirmed?.quiescenceReasons ?? null,
        });
      } catch (error) {
        if (error?.supervisionKind === "STOP_FAILURE") throw error;
        failedConfirmations.push({
          atEpochMs: observedAtEpochMs,
          at: iso(observedAtEpochMs),
          reason: safeError(error),
        });
      }
      ledger?.note("EARLY_CONFIRMATION_FAILED", observedAtEpochMs, {
        attempts: failedConfirmations.length,
      });
    }
    const remaining = timing.deadlineEpochMs - now();
    await sleep(Math.max(1, Math.min(observeMs, remaining)));
  }
  return { natural: null, failedConfirmations };
}
// H4: a claimed natural completion must be logically consistent.
export function validateCompletionAttribution({
  startedAtEpochMs,
  naturalAtEpochMs,
  confirmedAtEpochMs,
  deadlineEpochMs,
}) {
  if (naturalAtEpochMs > confirmedAtEpochMs)
    throw new Error(
      "natural completion cannot be later than its confirming observation",
    );
  if (naturalAtEpochMs < startedAtEpochMs)
    throw new Error("natural completion cannot precede execution start");
  if (naturalAtEpochMs > deadlineEpochMs)
    throw new Error(
      "a completion beyond the deadline is not an early natural completion",
    );
  return true;
}

// The terminal record must carry the governed execution identity claim that
// reconciliation requires. The ARMED record cannot: it is produced BEFORE the
// governed launch exists. So the watchdog resolves the AUTHORITATIVE PERSISTED
// execution record by run id at termination and embeds the claim from it. If
// no governed launch happened there is no claim, and the terminal record says
// so explicitly rather than inventing one.
function governedClaim(config) {
  const { resolved, problem } = tryResolveOfficialExecution(config?.runId, {
    overrides: { runsDir: config?.runsDir },
  });
  if (!resolved)
    return {
      executionIdentityClaim: null,
      governedLaunchResolved: false,
      governedLaunchProblem: problem,
    };
  return {
    executionIdentityClaim: executionIdentityClaim(resolved.executionIdentity),
    governedLaunchResolved: true,
    governedLaunchProblem: null,
  };
}

function baseEvidence(config, timing, paths) {
  return {
    schemaVersion: 1,
    kind: "BENCHBOARD_DSH_DEADLINE_WATCHDOG",
    runId: config.runId,
    teamId: config.teamId,
    captainSessionId: config.captainSessionId,
    watchdogPid: process.pid,
    dshPid: config.dshPid ?? null,
    baseUrl: config.baseUrl,
    startedAtEpochMs: timing.startedAtEpochMs,
    startedAt: timing.startedAt,
    deadlineEpochMs: timing.deadlineEpochMs,
    deadlineAt: timing.deadlineAt,
    evidence: paths,
    authentication: {
      mechanism: "DSH launch-token exchange to in-memory host session cookie",
      secretPersisted: false,
    },
  };
}

export async function runWatchdog(input, runtime = {}) {
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const now = runtime.now ?? Date.now;
  const config = {
    ...input,
    runId: validateId(input.runId, "runId"),
    teamId: validateId(input.teamId, "teamId"),
    captainSessionId: validateId(input.captainSessionId, "captainSessionId"),
    baseUrl: validateLoopbackBaseUrl(input.baseUrl),
    pollMs: finiteInteger(input.pollMs ?? DEFAULT_POLL_MS, "pollMs"),
    stopTimeoutMs: finiteInteger(
      input.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      "stopTimeoutMs",
    ),
    dshPid:
      input.dshPid === undefined
        ? undefined
        : finiteInteger(input.dshPid, "dshPid"),
    networkTimeoutMs: finiteInteger(
      input.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS,
      "networkTimeoutMs",
    ),
    observeIntervalMs: finiteInteger(
      input.observeIntervalMs ?? DEFAULT_OBSERVE_INTERVAL_MS,
      "observeIntervalMs",
    ),
  };
  const paths = ensureNewEvidencePaths(config.evidencePath);
  let timing;
  let armed = false;
  let record;
  // M1: lifecycle facts accumulate monotonically and can never be erased by
  // later failure handling.
  const ledger = new SupervisionLedger();
  // Minted before any evidence is written so every record of this lifecycle,
  // including a failure record, carries the same instance identity.
  const watchdogNonce = mintWatchdogNonce();
  try {
    // H1: the seeded run manifest is the single immutable authority for the
    // execution ceiling. A caller-supplied ceiling/deadline is only a claim.
    const authority = seededAuthority(config.runId, {
      runsDir: config.runsDir,
    });
    timing = bindSupervisionTiming({
      authority,
      startedAtEpochMs: now(),
      claimedCeilingSeconds: config.ceilingSeconds,
      claimedDeadlineEpochMs: config.deadlineEpochMs,
    });
    record = {
      ...baseEvidence(config, timing, paths),
      timeCeilingMinutes: authority.timeCeilingMinutes,
      timeCeilingSeconds: authority.timeCeilingSeconds,
      ceilingAuthority: {
        source: authority.manifestPath,
        policy: authority.ceilingPolicy,
      },
    };
    ledger.record("startedAt", timing.startedAt);
    ledger.record("deadlineAt", timing.deadlineAt);
    ledger.record("timeCeilingMinutes", authority.timeCeilingMinutes);
    record.watchdogNonce = watchdogNonce;
    ledger.record("watchdogNonce", watchdogNonce);
    if (config.dshPid && !dshAlive(config.dshPid))
      throw new Error("configured DSH process is not running");
    const cookie = await establishDshSession({
      baseUrl: config.baseUrl,
      authLaunchLog: config.authLaunchLog,
      fetchImpl,
    });
    const initialTeam = await queryExactTeam(config, cookie, fetchImpl);
    inspectQuiescence(config, initialTeam);
    const armedAtEpochMs = now();
    const armedRecord = {
      ...record,
      status: "ARMED",
      armedAtEpochMs,
      armedAt: iso(armedAtEpochMs),
    };
    syncWriteNew(paths.armedPath, `${JSON.stringify(armedRecord, null, 2)}\n`);
    writeHeartbeat(paths, config, watchdogNonce, armedAtEpochMs);
    appendEvent(paths.eventsPath, {
      type: "ARMED",
      atEpochMs: armedAtEpochMs,
      at: iso(armedAtEpochMs),
    });
    armed = true;
    ledger.record("armedAt", iso(armedAtEpochMs));

    // H4: a natural completion observed before the deadline is recorded at the
    // actual completion/quiescence time, not at the deadline.
    const cookieForObservation = cookie;
    const early = await observeUntilCompletionOrDeadline(
      config,
      timing,
      now,
      config.observeIntervalMs,
      async () => {
        const team = await queryExactTeam(config, cookieForObservation, fetchImpl);
        return inspectQuiescence(config, team);
      },
      ledger,
      (atEpochMs) => writeHeartbeat(paths, config, watchdogNonce, atEpochMs),
    );
    if (early?.natural) {
      const confirmedAtEpochMs = early.observedAtEpochMs;
      // H4: an authoritative instant exists only when every required stop
      // timestamp was observed. Otherwise fall back CONSERVATIVELY to the
      // confirming observation, never to an earlier task timestamp.
      const naturalAtEpochMs = early.natural.stopTimestampsComplete
        ? (early.natural.authoritativeAtEpochMs ?? confirmedAtEpochMs)
        : confirmedAtEpochMs;
      const state = early.state;
      {
        validateCompletionAttribution({
          startedAtEpochMs: timing.startedAtEpochMs,
          naturalAtEpochMs,
          confirmedAtEpochMs,
          deadlineEpochMs: timing.deadlineEpochMs,
        });
        ledger.record("naturalCompletionAt", iso(naturalAtEpochMs));
        ledger.record("completionObservedAt", iso(confirmedAtEpochMs));
        ledger.record("observedStoppedAt", iso(naturalAtEpochMs));
        const final = {
          ...record,
          ...governedClaim(config),
          status: "COMPLETED",
          terminalOutcome: TERMINAL_OUTCOMES.NATURAL_COMPLETION,
          stopProven: true,
          stopProof: "NATURAL_QUIESCENCE_CONFIRMED",
          haltRequested: false,
          completionAttributionBasis: early.natural.stopTimestampsComplete
            ? "AUTHORITATIVE_STOP_TIMESTAMPS"
            : "CONSERVATIVE_CONFIRMING_OBSERVATION",
          stopTimestampsComplete: early.natural.stopTimestampsComplete,
          missingStopTimestamps: early.natural.missingStopTimestamps,
          triggeredAtEpochMs: null,
          triggeredAt: null,
          terminationRequestedAtEpochMs: null,
          terminationRequestedAt: null,
          haltRequested: false,
          haltResult: null,
          naturalCompletionAtEpochMs: naturalAtEpochMs,
          naturalCompletionAt: iso(naturalAtEpochMs),
          taskGraphCompletedAt:
            early.natural.taskGraphCompletedAtEpochMs == null
              ? null
              : iso(early.natural.taskGraphCompletedAtEpochMs),
          workersStoppedAt:
            early.natural.workersStoppedAtEpochMs == null
              ? null
              : iso(early.natural.workersStoppedAtEpochMs),
          captainStoppedAt:
            early.natural.captainStoppedAtEpochMs == null
              ? null
              : iso(early.natural.captainStoppedAtEpochMs),
          watchdogNonce,
          completionObservedAtEpochMs: confirmedAtEpochMs,
          completionObservedAt: iso(confirmedAtEpochMs),
          observedStoppedAtEpochMs: naturalAtEpochMs,
          observedStoppedAt: iso(naturalAtEpochMs),
          overrunSeconds: 0,
          completionAttribution:
            "ACTUAL_QUIESCENCE_NOT_DEADLINE_OBSERVATION",
          failedEarlyConfirmations: early.failedConfirmations,
          terminationOutcome: "COMPLETED",
          finalState: state,
          dshHealthy: dshAlive(config.dshPid),
          supervisorErrors: [],
          supervisionTimeline: ledger.snapshot(),
        };
        syncWriteNew(paths.finalPath, `${JSON.stringify(final, null, 2)}\n`);
        appendEvent(paths.eventsPath, {
          type: "COMPLETED",
          atEpochMs: naturalAtEpochMs,
          at: iso(naturalAtEpochMs),
          detail: { completionObservedAt: iso(confirmedAtEpochMs) },
        });
        return final;
      }
    }

    await waitUntil(timing.deadlineEpochMs, now);
    const triggeredAtEpochMs = now();
    ledger.record("triggeredAt", iso(triggeredAtEpochMs));
    appendEvent(paths.eventsPath, {
      type: "TRIGGERED",
      atEpochMs: triggeredAtEpochMs,
      at: iso(triggeredAtEpochMs),
    });
    let team = await queryExactTeam(config, cookie, fetchImpl);
    let state = inspectQuiescence(config, team);
    if (state.quiescent) {
      const final = {
        ...armedRecord,
        status: "COMPLETED",
        triggeredAtEpochMs,
        triggeredAt: iso(triggeredAtEpochMs),
        terminationRequestedAtEpochMs: null,
        terminationRequestedAt: null,
        haltResult: null,
        observedStoppedAtEpochMs: triggeredAtEpochMs,
        observedStoppedAt: iso(triggeredAtEpochMs),
        overrunSeconds: Math.max(
          0,
          (triggeredAtEpochMs - timing.deadlineEpochMs) / 1000,
        ),
        terminationOutcome: "COMPLETED",
        finalState: state,
        dshHealthy: dshAlive(config.dshPid),
        supervisorErrors: [],
      };
      syncWriteNew(paths.finalPath, `${JSON.stringify(final, null, 2)}\n`);
      appendEvent(paths.eventsPath, {
        type: "COMPLETED",
        atEpochMs: triggeredAtEpochMs,
        at: iso(triggeredAtEpochMs),
      });
      return final;
    }

    const terminationRequestedAtEpochMs = now();
    ledger.record("terminationRequestedAt", iso(terminationRequestedAtEpochMs));
    appendEvent(paths.eventsPath, {
      type: "TERMINATION_REQUESTED",
      atEpochMs: terminationRequestedAtEpochMs,
      at: iso(terminationRequestedAtEpochMs),
    });
    const halt = await haltExactTeam(config, cookie, fetchImpl);
    const haltAcceptedAtEpochMs = now();
    ledger.record("haltAcceptedAt", iso(haltAcceptedAtEpochMs));
    appendEvent(paths.eventsPath, {
      type: "HALT_ACCEPTED",
      atEpochMs: haltAcceptedAtEpochMs,
      at: iso(haltAcceptedAtEpochMs),
      httpStatus: halt.status,
    });
    const stopConfirmationDeadline = now() + config.stopTimeoutMs;
    while (true) {
      team = await queryExactTeam(config, cookie, fetchImpl);
      state = inspectQuiescence(config, team);
      if (state.quiescent && state.halted) break;
      if (now() >= stopConfirmationDeadline)
        throw new Error(
          "team halt was accepted but quiescence was not confirmed before timeout",
        );
      await sleep(config.pollMs);
    }
    const observedStoppedAtEpochMs = now();
    ledger.record("observedStoppedAt", iso(observedStoppedAtEpochMs));
    const overrunSeconds = Math.max(
      0,
      (observedStoppedAtEpochMs - timing.deadlineEpochMs) / 1000,
    );
    const triggerLatencyMs = triggeredAtEpochMs - timing.deadlineEpochMs;
    const status =
      triggerLatencyMs <= config.pollMs + 250
        ? "TIME_LIMIT"
        : "TIME_LIMIT_OVERRUN";
    // One shared vocabulary: the consumer checks exactly this constant. The
    // candidate.8 producer wrote TIME_LIMIT_OVERRUN as its terminationOutcome
    // while reconciliation demanded STOPPED, so no genuine halt could satisfy
    // its consumer.
    const terminalOutcome =
      status === "TIME_LIMIT"
        ? TERMINAL_OUTCOMES.DEADLINE_HALT
        : TERMINAL_OUTCOMES.DEADLINE_OVERRUN_HALT;
    const stopProven = state?.quiescent === true && halt.status === 200;
    const final = {
      ...armedRecord,
      ...governedClaim(config),
      status,
      terminalOutcome,
      stopProven,
      stopProof: stopProven
        ? "HALT_ACCEPTED_AND_QUIESCENCE_CONFIRMED"
        : null,
      haltRequested: true,
      triggeredAtEpochMs,
      triggeredAt: iso(triggeredAtEpochMs),
      terminationRequestedAtEpochMs,
      terminationRequestedAt: iso(terminationRequestedAtEpochMs),
      haltAcceptedAtEpochMs,
      haltAcceptedAt: iso(haltAcceptedAtEpochMs),
      haltResult: { httpStatus: halt.status, body: halt.value },
      observedStoppedAtEpochMs,
      observedStoppedAt: iso(observedStoppedAtEpochMs),
      overrunSeconds,
      terminationOutcome: status,
      watchdogNonce,
      finalState: state,
      dshHealthy: dshAlive(config.dshPid),
      supervisorErrors: [],
      supervisionTimeline: ledger.snapshot(),
    };
    syncWriteNew(paths.finalPath, `${JSON.stringify(final, null, 2)}\n`);
    appendEvent(paths.eventsPath, {
      type: status,
      atEpochMs: observedStoppedAtEpochMs,
      at: iso(observedStoppedAtEpochMs),
    });
    return final;
  } catch (error) {
    const failedAtEpochMs = now();
    const message = safeError(error);
    const failure = {
      ...(record ?? {
        schemaVersion: 1,
        kind: "BENCHBOARD_DSH_DEADLINE_WATCHDOG",
        runId: input.runId ?? null,
        teamId: input.teamId ?? null,
        watchdogPid: process.pid,
      }),
      // M1: failure evidence is monotonic. Every lifecycle fact already
      // observed survives into the failure record.
      ...ledger.snapshot(),
      ...governedClaim(config ?? input),
      watchdogNonce,
      status: armed ? "STOP_FAILURE" : "SUPERVISOR_FAILURE",
      terminalOutcome: armed
        ? TERMINAL_OUTCOMES.STOP_FAILURE
        : TERMINAL_OUTCOMES.SUPERVISOR_FAILURE,
      stopProven: false,
      stopProof: null,
      failedAtEpochMs,
      failedAt: iso(failedAtEpochMs),
      terminationOutcome: armed ? "STOP_FAILURE" : "SUPERVISOR_FAILURE",
      supervisorErrors: [message],
      dshHealthy: dshAlive(config.dshPid),
      supervisionTimeline: ledger.snapshot(),
      supervisionEvents: ledger.events,
    };
    try {
      if (!fs.existsSync(paths.finalPath))
        syncWriteNew(paths.finalPath, `${JSON.stringify(failure, null, 2)}\n`);
      appendEvent(paths.eventsPath, {
        type: failure.status,
        atEpochMs: failedAtEpochMs,
        at: iso(failedAtEpochMs),
        error: message,
      });
    } catch (evidenceError) {
      failure.supervisorErrors.push(
        `evidence persistence failed: ${safeError(evidenceError)}`,
      );
    }
    const wrapped = new Error(message);
    wrapped.watchdogEvidence = failure;
    throw wrapped;
  }
}

export function parseCliArgs(argv) {
  const values = {};
  const allowed = new Set([
    "--run-id",
    "--team-id",
    "--captain-session-id",
    "--base-url",
    "--evidence",
    "--auth-launch-log",
    "--team-state",
    "--captain-state",
    "--ceiling-seconds",
    "--deadline-epoch-ms",
    "--poll-ms",
    "--stop-timeout-seconds",
    "--dsh-pid",
  ]);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    if (!allowed.has(key)) throw new Error(`unknown argument ${key}`);
    if (values[key] !== undefined) throw new Error(`duplicate argument ${key}`);
    values[key] = value;
  }
  const required = [
    "--run-id",
    "--team-id",
    "--captain-session-id",
    "--base-url",
    "--evidence",
    "--auth-launch-log",
    "--team-state",
    "--captain-state",
  ];
  for (const name of required)
    if (!values[name]) throw new Error(`missing ${name}`);
  const hasCeiling = values["--ceiling-seconds"] !== undefined;
  const hasDeadline = values["--deadline-epoch-ms"] !== undefined;
  if (hasCeiling === hasDeadline)
    throw new Error(
      "provide exactly one of --ceiling-seconds or --deadline-epoch-ms",
    );
  return {
    runId: values["--run-id"],
    teamId: values["--team-id"],
    captainSessionId: values["--captain-session-id"],
    baseUrl: values["--base-url"],
    evidencePath: path.resolve(values["--evidence"]),
    authLaunchLog: path.resolve(values["--auth-launch-log"]),
    teamStatePath: path.resolve(values["--team-state"]),
    captainStatePath: path.resolve(values["--captain-state"]),
    ...(hasCeiling
      ? {
          ceilingSeconds: finiteInteger(
            values["--ceiling-seconds"],
            "ceilingSeconds",
          ),
        }
      : {
          deadlineEpochMs: finiteInteger(
            values["--deadline-epoch-ms"],
            "deadlineEpochMs",
          ),
        }),
    ...(values["--poll-ms"]
      ? { pollMs: finiteInteger(values["--poll-ms"], "pollMs") }
      : {}),
    ...(values["--stop-timeout-seconds"]
      ? {
          stopTimeoutMs:
            finiteInteger(
              values["--stop-timeout-seconds"],
              "stopTimeoutSeconds",
            ) * 1000,
        }
      : {}),
    ...(values["--dsh-pid"]
      ? { dshPid: finiteInteger(values["--dsh-pid"], "dshPid") }
      : {}),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    const result = await runWatchdog(parseCliArgs(process.argv.slice(2)));
    console.log(
      JSON.stringify({
        status: result.status,
        evidence: result.evidence.finalPath,
      }),
    );
  } catch (error) {
    console.error(safeError(error));
    process.exitCode = 1;
  }
}
