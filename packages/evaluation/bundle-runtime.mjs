// Captain-held assembly integration: never accept runtime collaborators from a public request.
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../core/identity.mjs';
import { identityDigestOf, canonicalJson } from '../core/manifest.mjs';
import { assertDirectoryChain, verifySelection } from './staging.mjs';
import { EvaluationIntegrityError } from './bundle-contract.mjs';
import { computeEvaluatorIdentity } from './evaluator-identity.mjs';
import { assembleEvidenceBundle } from './bundle.mjs';
import { assertEvaluationResultClaim } from './controller.mjs';
import { EvaluationRefusalError } from './contracts.mjs';

function artifactsOf(outputRoot, paths) {
  const chain = assertDirectoryChain(outputRoot), files = [];
  let bytes = 0;
  for (const relative of paths) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || relative.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f\x7f]/.test(relative)) throw new EvaluationIntegrityError('Unsafe artifact reference');
    const absolute = path.join(outputRoot, relative);
    assertDirectoryChain(path.dirname(absolute));
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 134217728 || (bytes += stat.size) > 536870912) throw new EvaluationIntegrityError('Artifact must be a bounded ordinary file');
    const content = fs.readFileSync(absolute), after = fs.lstatSync(absolute);
    if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new EvaluationIntegrityError('Artifact changed while hashing');
    files.push({ path: relative, bytes: content.length, sha256: sha256(content) });
  }
  const after = assertDirectoryChain(outputRoot);
  if (canonicalJson(chain) !== canonicalJson(after)) throw new EvaluationIntegrityError('Artifact output ownership changed');
  return files;
}

/** Internal result finalization, also exercised with controlled S1 runtimes by integration tests. */
export async function attachEvidenceBundle(request, result, installedBefore) {
  if (result.status !== 'success') return { ...result, bundle: null };
  assertEvaluationResultClaim(result, request.outputRoot);
  let verified;
  try { verified = await verifySelection(request); }
  catch (error) {
    if (error instanceof EvaluationRefusalError) { error.cleanup = result.cleanup; error.artifacts = result.artifacts; }
    throw error;
  }
  const installed = computeEvaluatorIdentity();
  if (canonicalJson(installedBefore) !== canonicalJson(installed)) throw new EvaluationIntegrityError('Installed evaluator changed during execution');
  const identities = {
    challenge: { id: request.challenge.challengeId, digest: identityDigestOf(request.challenge) },
    tooling: { id: verified.manifest.bindings.tooling.toolingId, digest: verified.manifest.bindings.tooling.toolingIdentityDigest },
    evaluator: { binding: { id: request.evaluator.evaluatorId, digest: identityDigestOf(request.evaluator) }, ...installed },
    submission: { runId: request.submission.runId, snapshotId: request.submission.snapshotId,
      frozenSubmissionId: request.submission.frozenSubmissionId, manifestDigest: request.submission.expectedDigest, treeDigest: verified.treeDigest },
  };
  let artifactDigests;
  try { artifactDigests = artifactsOf(request.outputRoot, result.artifacts); }
  catch (error) {
    if (error instanceof EvaluationIntegrityError) throw error;
    throw new EvaluationIntegrityError('Retained artifacts are missing or invalid');
  }
  assertEvaluationResultClaim(result, request.outputRoot);
  return { ...result, bundle: assembleEvidenceBundle({ result, identities, artifactDigests }) };
}
