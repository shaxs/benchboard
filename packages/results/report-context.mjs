// Captain-owned filesystem and identity verification before the pure worker projection.
import path from 'node:path';
import { openRun } from '../core/lifecycle.mjs';
import { verifyFrozenSubmission } from '../core/freeze.mjs';
import { identityDigestOf } from '../core/manifest.mjs';
import { validateEvidenceBundle } from '../evaluation/bundle-contract.mjs';
import { assertDirectoryChain } from '../evaluation/staging.mjs';
import { refuseReport, assertBundleBindings } from './report-contract.mjs';
import { validateNeutralTokenInput } from './measurement-contract.mjs';
import { buildMeasurementContext } from './measurement-context.mjs';

export async function resolveReportContext(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(k => !['reportId', 'createdAt', 'selection', 'evaluation', 'metrics'].includes(k))) refuseReport('Explicit report request required; unknown options refused');
  // Check raw numbers before JSON capture could turn NaN/Infinity into unavailable null.
  const metrics = validateNeutralTokenInput(request.metrics ?? null);
  // Capture caller-owned input before awaiting verification; never allow a mid-await rebind.
  let input;
  try { input = JSON.parse(JSON.stringify(request)); } catch { refuseReport('JSON report input required'); }
  const s = input.selection;
  if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).sort().join(',') !== 'expectedDigest,frozenSubmissionId,manifestId,runId,runRoot,snapshotId') refuseReport('Explicit complete frozen selection required');
  if (typeof s.runRoot !== 'string' || !path.isAbsolute(s.runRoot) || path.resolve(s.runRoot) !== s.runRoot || path.dirname(s.runRoot) === s.runRoot) refuseReport('Canonical absolute run root required');
  for (const key of ['runId', 'manifestId', 'snapshotId', 'frozenSubmissionId']) if (typeof s[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(s[key])) refuseReport('Invalid selected identity');
  if (typeof s.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(s.expectedDigest)) refuseReport('Expected manifest digest required');
  const e = input.evaluation;
  if (!e || typeof e !== 'object' || Array.isArray(e) || !['success', 'infrastructure-error'].includes(e.status)) refuseReport('Only returned C4 evaluations are report inputs; refusals stay thrown');
  if (e.status === 'infrastructure-error' && (e.bundle !== null || e.evidence !== null || e.score !== null || !e.error || typeof e.error.code !== 'string')) refuseReport('Incomplete infrastructure outcome or fabricated partial score');
  if (e.status === 'success' && (!e.bundle || e.score !== null)) refuseReport('Successful C4 bundle required, not top-level score');
  assertDirectoryChain(s.runRoot);
  const verified = await verifyFrozenSubmission(s);
  const opened = await openRun({ runRoot: s.runRoot, runId: s.runId, manifestId: s.manifestId, expectedDigest: s.expectedDigest });
  const pub = verified.submissions[0];
  if (!verified.ok || verified.state !== 'FROZEN' || verified.submissions.length !== 1 || !pub?.ok || pub.snapshotId !== s.snapshotId || pub.frozenSubmissionId !== s.frozenSubmissionId) refuseReport('One verified inactive frozen publication required');
  const m = opened.manifest, mb = m.bindings;
  if (identityDigestOf(m) !== s.expectedDigest) refuseReport('Manifest digest mismatch');
  const bindings = {
    manifestId: m.manifestId, runId: m.runId, snapshotId: s.snapshotId, frozenSubmissionId: s.frozenSubmissionId, treeDigest: pub.treeDigest, manifestDigest: s.expectedDigest,
    toolingIdentityDigest: mb.tooling.toolingIdentityDigest, challengeIdentityDigest: mb.challenge.challengeIdentityDigest, evaluatorIdentityDigest: mb.evaluator.evaluatorIdentityDigest,
    challengeId: mb.challenge.challengeId, challengeVersion: mb.challenge.challengeVersion, candidateVersion: mb.challenge.candidateVersion,
    evaluatorId: mb.evaluator.evaluatorId, evaluatorVersion: mb.evaluator.evaluatorVersion, toolingId: mb.tooling.toolingId, toolingVersion: mb.tooling.toolingVersion, workloadDigest: mb.challenge.workloadDigest,
  };
  const bundle = e.status === 'success' ? validateEvidenceBundle(e.bundle) : null;
  if (bundle) {
    assertBundleBindings(bundle, bindings);
    if (e.evaluationId !== bundle.evaluationId) refuseReport('Evaluation ID mismatch');
  }
  const measurementContext = await buildMeasurementContext({selection:s,manifest:m,bindings,bundle,metrics,reportId:input.reportId});
  return { reportId: input.reportId, createdAt: input.createdAt, manifest: m, bindings, bundle, evaluationId: e.evaluationId, status: e.status, measurementContext };
}
