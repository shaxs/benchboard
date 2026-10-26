// Internal Captain-held controller. Production binding is separate; test collaborators cannot
// replace public request validation, C3 verification, or the filesystem containment boundary.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EvaluationInfrastructureError, EvaluationRefusalError, STAGES, runWorkerStage, throwIfAborted } from './contracts.mjs';
import { assertDirectoryChain, validateEvaluationRequest, verifySelection, stageFrozen, cleanupScratch } from './staging.mjs';
import { runTypecheckStage, runBuildStage, runVisibleStage } from './tool-stages.mjs';
import { runBrowserStage } from './browser-stage.mjs';
import { runUsefulTestsStage } from './useful-stage.mjs';

const defaults = Object.freeze({
  typecheck: runTypecheckStage, build: runBuildStage, visible: runVisibleStage,
  browser: runBrowserStage, useful: runUsefulTestsStage,
  inspection: context => runWorkerStage(context, 'inspection'),
});
// Result ownership is process-local and not serializable/caller-forgeable. S2 artifact hashing must
// use the same output claim the controller checked, not adopt a replacement after runner return.
const resultClaims = new WeakMap();
export function assertEvaluationResultClaim(result, outputRoot) {
  const saved = resultClaims.get(result);
  if (!saved || saved.outputRoot !== outputRoot) throw new EvaluationInfrastructureError('artifacts', 'CLEANUP_FAILED', 'No controller-owned result output claim');
  try { assertOutputClaim(outputRoot, saved.claim); }
  catch (error) {
    if (error instanceof EvaluationInfrastructureError) throw error;
    throw new EvaluationInfrastructureError('artifacts', 'CLEANUP_FAILED', 'Controller-owned artifact output is no longer available');
  }
}

function environmentFor(tempRoot) {
  const result = {};
  // Inherit only runtime/OS necessities, not credentials, arbitrary Node loaders or harness config.
  // Browser-path values are inherited from the caller's command, never discovered or overridden.
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL|TZ|PLAYWRIGHT_[A-Z_]*PATH)$/i;
  for (const [key, value] of Object.entries(process.env)) if (allowed.test(key) && typeof value === 'string') result[key] = value;
  return Object.freeze({ ...result, TEMP: tempRoot, TMP: tempRoot, TMPDIR: tempRoot });
}

function assertOutputClaim(outputRoot, claim) {
  const current = assertDirectoryChain(outputRoot);
  if (current.length !== claim.outputChain.length || current.some((entry, i) => entry.path !== claim.outputChain[i].path || entry.identity !== claim.outputChain[i].identity)) {
    throw new EvaluationInfrastructureError('artifacts', 'CLEANUP_FAILED', 'Retained output ownership changed');
  }
}
function artifactFiles(outputRoot, claim) {
  // Before staging has returned a claim, a concurrent/foreign output directory is never adopted.
  if (!claim || !fs.existsSync(outputRoot)) return [];
  assertOutputClaim(outputRoot, claim);
  const files = [];
  function walk(at, relative) {
    const stat = fs.lstatSync(at);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new EvaluationInfrastructureError('artifacts', 'INVALID_TOOL_OUTPUT', 'Linked or special artifact refused');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(at).sort()) {
        if (!relative && name.startsWith('scratch-')) continue; // disclosed residue is never traversed
        walk(path.join(at, name), relative ? relative + '/' + name : name);
      }
    } else files.push(relative);
  }
  walk(outputRoot, '');
  return files;
}

/** @internal Trusted test seam. The supported public facade never accepts a runtime argument. */
export async function evaluateWithRuntime(input, runtime) {
  if (!runtime || typeof runtime.runProcess !== 'function' || typeof runtime.preflight !== 'function') throw new TypeError('Internal evaluation runtime requires a runner and preflight');
  const stages = Object.freeze({ ...defaults, ...runtime.stageOverrides });
  if (Object.keys(stages).some(key => !STAGES.includes(key)) || Object.values(stages).some(fn => typeof fn !== 'function')) throw new TypeError('Unknown internal stage collaborator');
  const observe = runtime.onEvent ?? (() => {});
  const request = validateEvaluationRequest(input);
  const evaluationId = 'eval-' + randomUUID();
  const completed = [], values = {};
  let verified = null, claim = null, snapshot = null, failure = null, evidence = null;
  let cleanup = null, artifacts = [], currentStage = 'preflight';
  try {
    throwIfAborted(request.signal, currentStage);
    observe('verify-before', { selection: request.submission });
    verified = await verifySelection(request);
    snapshot = { before: verified.treeDigest, after: null, workspaceMatchesFrozen: verified.workspaceMatchesFrozen };
    await runtime.preflight(request);
    throwIfAborted(request.signal, currentStage);
    claim = await stageFrozen(verified, request, { canonicalRoot: runtime.canonicalRoot, dependencyRoot: runtime.dependencyRoot, onEvent: observe });
    const env = environmentFor(claim.tempRoot);
    const context = stage => {
      assertOutputClaim(request.outputRoot, claim);
      const artifactRoot = path.join(request.outputRoot, stage);
      fs.mkdirSync(artifactRoot);
      return Object.freeze({ appRoot: stage === 'inspection' ? verified.snapshotRoot : claim.appRoot,
        artifactRoot, tempRoot: claim.tempRoot, timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes, signal: request.signal, env, runProcess: runtime.runProcess });
    };
    for (const stage of ['typecheck', 'build', 'visible', 'browser', 'useful']) {
      currentStage = stage;
      throwIfAborted(request.signal, stage);
      const ctx = context(stage);
      observe(stage, ctx);
      const result = await stages[stage](ctx);
      completed.push(result); values[stage] = result.value;
    }
    currentStage = 'verification';
    observe('verify-after', { snapshotRoot: verified.snapshotRoot });
    await verifySelection(request);
    currentStage = 'inspection';
    throwIfAborted(request.signal, currentStage);
    const inspectionContext = context('inspection');
    observe('inspection', inspectionContext);
    const inspection = await stages.inspection(inspectionContext);
    completed.push(inspection);
    // A final read-only C3 check also covers mutation during inspection and unexpected directories.
    const final = await verifySelection(request);
    snapshot.after = final.treeDigest;
    snapshot.workspaceMatchesFrozen = final.workspaceMatchesFrozen;
    if (snapshot.before !== snapshot.after) throw new EvaluationRefusalError('SNAPSHOT_REFUSED', 'Frozen bytes changed during evaluation');
    evidence = {
      visiblePassed: values.visible.passed, hidden: values.browser, typecheck: values.typecheck,
      build: values.build, usefulTests: values.useful,
      noSuppression: inspection.value.noSuppression, hygiene: inspection.value.hygiene,
      analysisMethod: inspection.value.analysisMethod,
    };
  } catch (error) {
    failure = error;
    if (!(failure instanceof EvaluationRefusalError) && !(failure instanceof EvaluationInfrastructureError)) {
      const code = error.code === 'ETIMEDOUT' ? 'TIMEOUT' : error.code === 'ABORT_ERR' ? 'CANCELLED' : error.code === 'ENOENT' ? 'MISSING_PREREQUISITE' : 'TOOL_CRASH';
      failure = new EvaluationInfrastructureError(currentStage, code, String(error.message ?? error).slice(0, 4000), { cause: error.code ?? null });
      failure.cleanup = error.cleanup;
    }
  } finally {
    try {
      cleanup = claim ? await (runtime.cleanupScratch ?? cleanupScratch)(claim) : failure?.cleanup ?? cleanupScratch(null);
      if (!cleanup || !Array.isArray(cleanup.residue) || !Array.isArray(cleanup.errors) || typeof cleanup.removed !== 'boolean') throw new Error('Invalid cleanup observation');
    } catch (error) {
      cleanup = { removed: false, residue: claim ? [claim.scratchRoot] : [], errors: [{ code: 'CLEANUP_FAILED', message: String(error.message ?? error) }] };
    }
    if (!cleanup.removed || cleanup.errors.length) {
      if (!failure) failure = new EvaluationInfrastructureError('cleanup', 'CLEANUP_FAILED', 'Evaluation scratch cleanup could not be confirmed');
    }
    try { observe('cleanup', cleanup); }
    catch (error) { if (!failure) failure = new EvaluationInfrastructureError('cleanup', 'CLEANUP_FAILED', String(error.message ?? error)); }
    try { artifacts = artifactFiles(request.outputRoot, claim); }
    catch (error) {
      if (!failure) failure = error;
      else failure.details = { ...failure.details, artifactCollectionError: { code: error.code ?? 'INVALID_TOOL_OUTPUT', message: String(error.message ?? error).slice(0, 4000) } };
    }
  }
  if (failure instanceof EvaluationRefusalError) { failure.cleanup = cleanup; failure.artifacts = artifacts; throw failure; }
  if (failure) {
    return { status: 'infrastructure-error', evaluationId,
      error: { code: failure.code, stage: failure.stage ?? currentStage, message: failure.message, details: failure.details ?? {} },
      evidence: null, score: null, snapshot, cleanup, artifacts };
  }
  const result = { status: 'success', evaluationId, evidence, score: null, stages: completed, snapshot,
    environment: { label: request.environment?.label ?? null, nodeVersion: process.version, platform: process.platform, architecture: process.arch, browserVersion: null },
    cleanup, artifacts };
  resultClaims.set(result, { outputRoot: request.outputRoot, claim });
  return result;
}
