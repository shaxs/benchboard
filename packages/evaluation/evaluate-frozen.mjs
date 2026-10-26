// Supported facade: real production collaborators only. Test injection is not a public option.
import fs from 'node:fs';
import { EvaluationInfrastructureError } from './contracts.mjs';
import { evaluateWithRuntime } from './controller.mjs';
import { runProcess } from './process.mjs';
import { validateEvaluationRequest } from './staging.mjs';
import { computeEvaluatorIdentity } from './evaluator-identity.mjs';
import { attachEvidenceBundle } from './bundle-runtime.mjs';

async function preflight() {
  try {
    const { chromium } = await import('@playwright/test');
    const stat = fs.statSync(chromium.executablePath());
    if (!stat.isFile()) throw new Error('Chromium executable is not a file');
  } catch (error) {
    throw new EvaluationInfrastructureError('preflight', 'MISSING_PREREQUISITE', 'Installed Playwright Chromium is required; evaluation never installs it', { cause: error.code ?? null });
  }
}
const productionRuntime = Object.freeze({ runProcess, preflight });

/**
 * The supported evaluation entry point: it runs only the real production collaborators,
 * and there is no public runtime or collaborator injection — a request carrying an
 * undocumented option (for example a runtime) is refused, never honored.
 *
 * Three outcomes, honestly separated:
 * - Success resolves with the unchanged S1 fields plus one additive, validated
 *   complete `bundle`. The top-level `score` is null; the complete automated score is
 *   `bundle.score` only.
 * - A modeled infrastructure fault RETURNS (never throws) the infrastructure shape with
 *   `bundle`, `evidence` and `score` all null and the `error` diagnostic carrying the
 *   code and stage — including `CLEANUP_FAILED`, which the controller can raise when
 *   scratch cleanup or retained-output ownership cannot be confirmed and the
 *   bundle-attachment path can raise when the controller-owned output claim is no longer
 *   intact. This facade converts only an infrastructure error at the attachment step;
 *   an incomplete result never degrades into a bundle or partial points.
 * - A typed integrity fault or a typed request/safety refusal REJECTS, as does any
 *   unknown error: nothing here swallows or relabels an error it does not model.
 */
export function evaluateFrozen(request) {
  return evaluateProduction(request);
}

async function evaluateProduction(request) {
  const input = validateEvaluationRequest(request);
  const installedBefore = computeEvaluatorIdentity();
  const result = await evaluateWithRuntime(input, productionRuntime);
  try { return await attachEvidenceBundle(input, result, installedBefore); }
  catch (error) {
    if (!(error instanceof EvaluationInfrastructureError)) throw error;
    return { status: 'infrastructure-error', evaluationId: result.evaluationId, evidence: null, score: null, bundle: null,
      error: { code: error.code, stage: error.stage, message: error.message, details: error.details },
      snapshot: result.snapshot, cleanup: result.cleanup, artifacts: result.artifacts };
  }
}
