// Governance fixtures DERIVED FROM REAL PRODUCER OUTPUT.
//
// Candidate.8's fixture hand-assembled every record, which is exactly what the
// candidate.8 reviewer rejected: consumers were being fed shapes the real
// producers never emit. This fixture instead runs the REAL governed chain once
// per declared ceiling (in a child process, so callers stay synchronous),
// caches the real serialized artifacts, and derives each fixture by copying
// those bytes into a disposable scratch directory.
//
// Perturbations therefore start from genuine producer output and inject exactly
// one defect, which is what a negative test needs. The positive end-to-end
// proof lives in governed-chain.test.mjs against the live chain.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root } from '../files.mjs';

export const telemetryTemplate = () =>
  JSON.parse(fs.readFileSync(path.join(root, 'runner/telemetry.example.json')));

const producer = fileURLToPath(new URL('./produce-chain.mjs', import.meta.url));
const cache = new Map();
const scratchRoots = [];

// Run the real chain once per ceiling and cache its serialized artifacts.
export function realChainArtifacts(minutes) {
  if (cache.has(minutes)) return cache.get(minutes);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-real-chain-'));
  scratchRoots.push(out);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.BENCHBOARD_MANIFEST_PATH;
  const child = spawnSync(process.execPath, [producer, out, String(minutes)], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env,
  });
  if (child.status !== 0)
    throw Error(
      'Real governed chain producer failed for ' +
        minutes +
        ' minutes: ' +
        (child.stderr || child.stdout || 'no output'),
    );
  const artifacts = JSON.parse(
    fs.readFileSync(path.join(out, 'artifacts.json'), 'utf8'),
  );
  cache.set(minutes, artifacts);
  return artifacts;
}
export function disposeRealChains() {
  for (const at of scratchRoots) fs.rmSync(at, { recursive: true, force: true });
  scratchRoots.length = 0;
  cache.clear();
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const shift = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

export function governedRun({
  minutes = 180,
  teamId = null,
  watchdogPid = null,
  status = 'TIME_LIMIT',
  quiescent = true,
  overrunSeconds = 0,
  // deliberate-defect switches used by counterexample tests
  seedMinutesOnDisk = null,
  terminalTeamId = null,
  terminalPid = null,
  terminalNonce = null,
  terminalDeadlineAt = null,
  omitTerminal = false,
  omitHeartbeat = false,
  omitAuthority = false,
  omitSubmission = false,
  omitClaim = false,
  heartbeatAgeMs = 0,
  heartbeatNonce = null,
  expiredArmed = false,
  clockShiftMs = 0,
  activeMarker = null,
  dir = null,
} = {}) {
  const real = realChainArtifacts(minutes);
  const id = real.id;
  const base = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bb-governed-fx-'));
  const slot = fs.mkdtempSync(path.join(base, 'ev-'));
  const armedEvidencePath = path.join(slot, 'evidence.json.armed.json');
  const finalEvidencePath = path.join(slot, 'evidence.json');
  const heartbeatPath = path.join(slot, 'evidence.json.alive.json');

  // --- real seed manifest, optionally perturbed ----------------------------
  const seed = clone(real.seedManifest);
  if (seedMinutesOnDisk !== null) {
    seed.timeCeilingMinutes = seedMinutesOnDisk;
    seed.timeCeilingSeconds = seedMinutesOnDisk * 60;
  }
  fs.writeFileSync(path.join(base, id + '.json'), JSON.stringify(seed, null, 2));

  // --- real ARMED record, optionally perturbed -----------------------------
  const armed = clone(real.armed);
  const totalShift = expiredArmed ? -(minutes * 60000 + 60000) : clockShiftMs;
  if (totalShift) {
    armed.startedAt = shift(armed.startedAt, totalShift);
    armed.deadlineAt = shift(armed.deadlineAt, totalShift);
  }
  if (teamId !== null) armed.teamId = teamId;
  if (watchdogPid !== null) armed.watchdogPid = watchdogPid;
  fs.writeFileSync(armedEvidencePath, JSON.stringify(armed, null, 2));

  // --- real heartbeat, optionally perturbed --------------------------------
  const nonce = armed.watchdogNonce;
  if (!omitHeartbeat) {
    const beat = clone(real.heartbeat);
    beat.at = new Date(Date.now() - heartbeatAgeMs).toISOString();
    if (heartbeatNonce !== null) beat.watchdogNonce = heartbeatNonce;
    if (watchdogPid !== null) beat.watchdogPid = watchdogPid;
    fs.writeFileSync(heartbeatPath, JSON.stringify(beat, null, 2));
  }

  // --- real terminal record, optionally perturbed --------------------------
  const terminal = clone(real.terminal);
  if (!omitTerminal) {
    if (totalShift) {
      for (const f of [
        'startedAt',
        'deadlineAt',
        'naturalCompletionAt',
        'completionObservedAt',
        'observedStoppedAt',
        'triggeredAt',
        'terminationRequestedAt',
        'haltAcceptedAt',
      ])
        if (terminal[f]) terminal[f] = shift(terminal[f], totalShift);
    }
    if (status !== 'COMPLETED') {
      // Derive a halt-shaped terminal record FROM the real completion record,
      // keeping the producer's own field set and vocabulary.
      const triggeredAt = terminal.deadlineAt;
      const stoppedAt = shift(
        terminal.deadlineAt,
        Math.max(1, overrunSeconds * 1000),
      );
      terminal.status = status;
      terminal.terminalOutcome =
        status === 'TIME_LIMIT' ? 'DEADLINE_HALT' : 'DEADLINE_OVERRUN_HALT';
      terminal.haltRequested = true;
      terminal.stopProven = true;
      terminal.stopProof = 'HALT_ACCEPTED_AND_QUIESCENCE_CONFIRMED';
      terminal.triggeredAt = triggeredAt;
      terminal.terminationRequestedAt = triggeredAt;
      terminal.haltAcceptedAt = stoppedAt;
      terminal.observedStoppedAt = stoppedAt;
      terminal.naturalCompletionAt = null;
      terminal.completionObservedAt = null;
      terminal.terminationOutcome = status;
      terminal.overrunSeconds = overrunSeconds;
    }
    if (terminalTeamId !== null) terminal.teamId = terminalTeamId;
    else if (teamId !== null) terminal.teamId = teamId;
    if (terminalPid !== null) terminal.watchdogPid = terminalPid;
    else if (watchdogPid !== null) terminal.watchdogPid = watchdogPid;
    if (terminalNonce !== null) terminal.watchdogNonce = terminalNonce;
    if (terminalDeadlineAt !== null) terminal.deadlineAt = terminalDeadlineAt;
    if (quiescent !== true)
      terminal.finalState = { ...terminal.finalState, quiescent };
    if (omitClaim) terminal.executionIdentityClaim = null;
    fs.writeFileSync(finalEvidencePath, JSON.stringify(terminal, null, 2));
  }

  // --- real persisted authority, with provenance repointed to the copies ---
  const authority = clone(real.authority);
  authority.launchProvenance.armedEvidencePath = armedEvidencePath;
  authority.launchProvenance.heartbeatPath = heartbeatPath;
  authority.launchProvenance.finalEvidencePath = finalEvidencePath;
  authority.supervisionEvidence.armedEvidencePath = armedEvidencePath;
  authority.supervisionEvidence.finalEvidencePath = finalEvidencePath;
  if (!omitAuthority)
    fs.writeFileSync(
      path.join(base, id + '-execution-authority.json'),
      JSON.stringify(authority, null, 2),
    );

  // --- real persisted execution outcome -----------------------------------
  const execution = clone(real.execution);
  execution.supervisionEvidence = authority.supervisionEvidence;
  fs.writeFileSync(
    path.join(base, id + '-execution.json'),
    JSON.stringify(execution, null, 2),
  );

  // --- real frozen submission ---------------------------------------------
  if (!omitSubmission)
    fs.writeFileSync(
      path.join(base, id + '-submission.json'),
      JSON.stringify(real.frozenSubmission, null, 2),
    );

  if (activeMarker)
    fs.writeFileSync(
      path.join(base, id + '-active.json'),
      JSON.stringify(
        activeMarker === true
          ? {
              kind: 'SUPERVISION_INCOMPLETE_REQUIRES_OWNER_VERIFICATION',
              runId: id,
              recordedAt: new Date().toISOString(),
            }
          : activeMarker,
        null,
        2,
      ),
    );

  const overrides = { runsDir: base };
  const supervision = {
    runId: id,
    armedEvidencePath,
    finalEvidencePath,
    expectedTeamId: authority.executionIdentity.boundFacts.teamId,
    overrides,
  };
  const telemetry = (over = {}) => {
    const d = clone(real.telemetry);
    for (const [k, v] of Object.entries(over)) d.run[k] = v;
    return d;
  };
  return {
    id,
    dir: base,
    runsDir: base,
    minutes,
    nonce,
    teamId: authority.executionIdentity.boundFacts.teamId,
    startedAt: armed.startedAt,
    deadlineAt: armed.deadlineAt,
    armedEvidencePath,
    finalEvidencePath,
    heartbeatPath,
    supervision,
    overrides,
    authority,
    executionIdentity: authority.executionIdentity,
    executionRecord: execution,
    frozenSubmission: real.frozenSubmission,
    submissionHash: real.submissionHash,
    manifest: seed,
    telemetry,
    ingestOptions: { runsDir: base },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

// A complete, positively-valid official comparison row.
export function officialRow(runId, over = {}) {
  // A key PRESENT in `over` is used verbatim, including undefined and null, so
  // completeness tests can actually remove a required fact.
  const pick = (key, fallback) => (key in over ? over[key] : fallback);
  const hashes = {
    spec: 's',
    specTree: 'st',
    starter: 'start',
    prd: 'p',
    fixtures: 'f',
    visible: 'v',
    evaluator: 'e',
    scoring: 'sc',
    runner: 'r',
    reference: 'ref',
    ...(over.hashes ?? {}),
  };
  return {
    manifest: {
      benchmarkVersion: pick('version', 'c9'),
      publicHash: pick('publicHash', hashes.starter),
      hashes,
    },
    quality: { quality: pick('quality', 80) },
    metrics: {
      official: pick('official', true),
      validOutcome: pick('valid', true),
      officialOutcomeValid: pick('officialOutcomeValid', true),
      supervisionValid: pick('supervisionValid', true),
      eligibleForFormalComparison: pick('eligibleForFormalComparison', true),
      outcomeClass: pick('outcomeClass', 'OFFICIAL_SUPERVISED'),
      executionId: pick('executionId', 'exec-' + runId),
      wallSeconds: 6000,
      officialWindowSeconds: 6000,
      timeCeilingMinutes: pick('ceiling', 180),
      run: { runId, architectureId: 'synthetic' },
    },
  };
}
