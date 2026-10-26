// Useful-tests stage. The parent entry is the Captain-fixed worker protocol; the child handler
// wraps the unchanged usefulTestsCooperative with the fixed call shape and infrastructure-error
// classification. The semantic module loads only by dynamic import inside the child handler, so
// no facade path or unit test loads vitest, and the T2 runner is never imported here. The stage
// acquires no resource itself: the cooperative module creates and removes its own scratch in its
// own finally, and because the Captain supplies the child TEMP/TMP/TMPDIR environment that scratch
// always lies inside the private temporary root the bounded parent removes on every outcome. This
// module performs no environment or cache configuration of its own.
import { EvaluationInfrastructureError, runWorkerStage } from './contracts.mjs';

const STAGE = 'useful';

// Mirrors the child-side prerequisite classification the Captain's stage-worker applies to raw
// failures, so a missing node_modules or vitest file is a MISSING_PREREQUISITE infrastructure
// error and a crashed run never yields partial scored evidence. The unchanged cooperative module
// nests its own synchronous tool runs with a fixed per-run bound and rethrows the raw child error,
// which carries code ETIMEDOUT; S1 AC3 requires that distinct infrastructure error, so a raw
// timeout error or an explicit timed-out tool message classifies as TIMEOUT. A genuine crash stays
// TOOL_CRASH and a missing prerequisite stays MISSING_PREREQUISITE.
const MISSING_PREREQUISITE_PATTERN = /executable doesn't exist|executable.*not.*exist|cannot find (?:module|package)|ENOENT/i;
const TIMEOUT_PATTERN = /\bETIMEDOUT\b|\btimed?[ -]?out\b/i;

function classify(error) {
  const text = String(error?.message ?? error ?? '');
  if (error?.code === 'ETIMEDOUT' || TIMEOUT_PATTERN.test(text)) return 'TIMEOUT';
  if (MISSING_PREREQUISITE_PATTERN.test(text) || error?.code === 'ENOENT') return 'MISSING_PREREQUISITE';
  return 'TOOL_CRASH';
}

function asInfrastructure(message, error) {
  if (error instanceof EvaluationInfrastructureError) return error;
  const text = String(error?.message ?? error ?? '');
  return new EvaluationInfrastructureError(STAGE, classify(error), message, { cause: text.slice(0, 4000) });
}

export function runUsefulTestsStage(context) {
  return runWorkerStage(context, STAGE);
}

export async function executeUsefulTestsStage(request, dependencies = {}) {
  let runTests = dependencies.usefulTestsCooperative;
  if (!runTests) runTests = (await import('../../evaluator/useful-tests.mjs')).usefulTestsCooperative;
  try {
    // Fixed call shape: app root and artifact root only. The returned value is forwarded exactly;
    // the five mutation names belong to the unchanged semantic module and are never rewritten here.
    return await runTests(request.appRoot, request.artifactRoot);
  } catch (error) {
    throw asInfrastructure('Useful-tests stage evaluation failed', error);
  }
}
