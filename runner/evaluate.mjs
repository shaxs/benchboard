import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  root,
  assertSnapshot,
  contained,
  rejectLinksTo,
  files,
  tree,
} from './files.mjs';
import { localServer } from '../evaluator/local-server.mjs';
import { browserEvaluate } from '../evaluator/browser.mjs';
import { usefulTestsCooperative } from '../evaluator/useful-tests.mjs';
import { inspectPublic } from '../evaluator/collect-evidence.mjs';
import { report } from '../evaluator/report.mjs';
import { reconcileSupervision } from './supervision.mjs';
import {
  ADMISSIBLE_TERMINAL_OUTCOMES,
  activeMarkerPathFor,
  incompleteSupervisionMarker,
  resolveExecutionOutcome,
  resolveFrozenSubmission,
  resolveOfficialExecution,
} from './execution-authority.mjs';
// Private evaluation of a CURRENT OFFICIAL outcome requires verified
// termination. Historical or manual analysis is still possible but must be
// requested explicitly and is never an official benchmark result.
// The official private-evaluation gate. Every input is RESOLVED from its
// canonical persisted location; no caller may supply an execution record, a
// supervision object or a submission identity. Missing, null, false or
// mismatched is a REFUSAL, never a default.
//
// This gate runs BEFORE any telemetry exists, so it does not consume the
// telemetry eligibility projection; it proves the same persisted facts
// positively and independently. Both paths resolve the SAME records, so they
// cannot disagree about whether an outcome is official.
export function assertEvaluationEligible(
  id,
  { overrides = {}, currentSubmissionHash = null } = {},
) {
  const problems = [];
  let authority = null;
  let identity = null;
  try {
    authority = resolveOfficialExecution(id, { overrides });
    identity = authority.executionIdentity;
  } catch (error) {
    return { eligible: false, problems: [error.message], executionIdentity: null };
  }
  // The persisted execution outcome, with its own validity consulted.
  let outcome = null;
  try {
    outcome = resolveExecutionOutcome(id, identity, { overrides });
    if (outcome.executionRecordValid !== true) problems.push(...outcome.problems);
  } catch (error) {
    problems.push(error.message);
  }
  // The incomplete-supervision marker refuses evaluation here AND makes
  // telemetry invalid at ingest. Agreement is not API-dependent.
  const marker = incompleteSupervisionMarker(id, overrides);
  if (marker)
    problems.push(
      'An incomplete-supervision marker requires owner verification before evaluation',
    );
  // Terminal supervision, reconciled from the authority's own evidence.
  const evidence = authority.supervisionEvidence;
  const reconciled = reconcileSupervision({
    ...evidence,
    runId: id,
    expectedTeamId: identity.boundFacts.teamId,
    executionIdentity: identity,
    overrides,
  });
  if (reconciled.supervisionValid !== true) problems.push(...reconciled.problems);
  if (reconciled.terminationProven !== true)
    problems.push('Termination is not positively verified');
  if (reconciled.quiescent !== true)
    problems.push('Quiescence is not positively confirmed');
  if (!ADMISSIBLE_TERMINAL_OUTCOMES.includes(reconciled.terminalOutcome))
    problems.push(
      'Terminal outcome ' + reconciled.terminalOutcome + ' is not admissible for an official result',
    );
  // SUBMISSION FREEZE. The official submission is the bytes frozen at
  // termination, resolved from disk. Candidate.8 accepted a missing or
  // mismatched identity and then minted a new one from current bytes.
  let frozen = null;
  try {
    frozen = resolveFrozenSubmission(id, { overrides });
  } catch (error) {
    problems.push(error.message);
  }
  if (frozen) {
    if (frozen.executionId !== identity.executionId)
      problems.push('Frozen submission belongs to another execution');
    if (currentSubmissionHash === null)
      problems.push('Current submission hash was not supplied for comparison');
    else if (currentSubmissionHash !== frozen.submissionHash)
      problems.push(
        'Evaluated bytes differ from the frozen participant submission; the result is not the benchmark result',
      );
  }
  return {
    eligible: problems.length === 0,
    problems,
    executionIdentity: identity,
    authority,
    outcome,
    frozenSubmission: frozen,
    incompleteSupervisionMarker: marker,
  };
}
// Owner-only evaluation AFTER all participant tools stop; hidden controller never copied into submission.
export async function evaluate(id, { descriptive = false } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw Error('Invalid ID');
  const hashes = assertSnapshot();
  const m = JSON.parse(
    fs.readFileSync(path.join(root, 'artifacts/runs', id + '.json')),
  );
  if (
    m.runId !== id ||
    path.resolve(m.destination) !== path.resolve(m.base, id) ||
    !contained(m.base, m.destination) ||
    contained(root, m.destination)
  )
    throw Error('Unsafe workspace');
  if (fs.existsSync(activeMarkerPathFor(id)))
    throw Error(
      'Participant execution active or supervision incomplete; refusing to expose hidden evaluator material',
    );
  if (JSON.stringify(m.hashes) !== JSON.stringify(hashes))
    throw Error('Candidate mismatch');
  const executionFile = path.join(
    root,
    'artifacts/runs',
    id + '-execution.json',
  );
  if (
    fs.existsSync(executionFile) &&
    Date.parse(m.createdAt) >
      Date.parse(JSON.parse(fs.readFileSync(executionFile)).startedAt)
  )
    throw Error('Workspace reset after execution; use preserved submission');
  // Termination gate. The submission hash is computed FIRST and handed to the
  // gate, which compares it against the submission frozen at termination. The
  // official submission is never defined by hashing whatever is on disk now.
  rejectLinksTo(m.destination);
  const sourceHash = tree(m.destination).hash;
  const eligibility = assertEvaluationEligible(id, {
    currentSubmissionHash: sourceHash,
  });
  if (!eligibility.eligible && !descriptive)
    throw Error(
      'Private evaluation refused: ' +
        eligibility.problems.join('; ') +
        '. Pass descriptive: true for explicitly non-official analysis.',
    );
  const executionRecord = eligibility.outcome ?? null;
  // The submission identity RESOLVED from the freeze, never re-minted here.
  const submissionIdentity = {
    runId: id,
    executionId: eligibility.executionIdentity?.executionId ?? null,
    frozenSubmissionHash: eligibility.frozenSubmission?.submissionHash ?? null,
    evaluatedSubmissionHash: sourceHash,
    matchesFrozenSubmission:
      eligibility.frozenSubmission?.submissionHash === sourceHash,
    frozenAt: eligibility.frozenSubmission?.frozenAt ?? null,
    officialOutcome: eligibility.eligible,
    outcomeClass: eligibility.eligible
      ? 'OFFICIAL_SUPERVISED'
      : 'DESCRIPTIVE_INVALID_OFFICIAL_OUTCOME',
    eligibilityProblems: eligibility.problems,
  };
  const out = path.join(root, 'artifacts/evaluations', id);
  if (fs.existsSync(out))
    throw Error('Evaluation already exists; preserve prior evidence');
  fs.mkdirSync(out, { recursive: true });
  const app = path.join(out, 'product');
  fs.mkdirSync(app);
  for (const p of files(m.destination)) {
    const to = path.join(app, p);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(m.destination, p), to);
  }
  for (const p of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vite.config.ts',
    ...files(path.join(root, 'starter/tests')).map((p) => 'tests/' + p),
  ])
    fs.copyFileSync(path.join(root, 'starter', p), path.join(app, p));
  fs.cpSync(
    path.join(root, 'starter/node_modules'),
    path.join(app, 'node_modules'),
    { recursive: true },
  );
  const run = (tool, args) => {
    const p = spawnSync(
      process.execPath,
      [path.join(app, 'node_modules', tool), ...args],
      { cwd: app, encoding: 'utf8', timeout: 300000, windowsHide: true },
    );
    fs.writeFileSync(
      path.join(out, path.basename(tool) + '.log'),
      (p.stdout || '') + (p.stderr || ''),
    );
    if (p.error) throw p.error;
    return p.status === 0;
  };
  const typecheck = run('typescript/bin/tsc', ['--noEmit']);
  const build = run('vite/bin/vite.js', ['build']);
  const visibleFile = path.join(out, 'visible.json');
  run('vitest/vitest.mjs', [
    'run',
    'tests/contracts.test.tsx',
    '--reporter=json',
    '--outputFile=' + visibleFile,
  ]);
  const server = await localServer(app);
  let hidden;
  try {
    hidden = await browserEvaluate(server.url, path.join(out, 'browser'));
  } finally {
    server.close();
  }
  const usefulTests = usefulTestsCooperative(
    app,
    path.join(out, 'useful-tests'),
  );
  if (tree(m.destination).hash !== sourceHash)
    throw Error('Submission changed during evaluation');
  const evidence = {
    visiblePassed: JSON.parse(fs.readFileSync(visibleFile)).numPassedTests,
    hidden,
    typecheck,
    build,
    usefulTests,
    ...inspectPublic(m.destination),
  };
  fs.writeFileSync(
    path.join(out, 'evidence.json'),
    JSON.stringify({ sourceHash, submissionIdentity, evidence }, null, 2),
  );
  return report(
    {
      evidence,
      manifest: m,
      executionRecord,
      descriptive: !eligibility.eligible,
    },
    path.join(out, 'report'),
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(JSON.stringify(await evaluate(process.argv[2]), null, 2));
