// Captain-owned report trust boundary. Hashes bind local statements, not certification.
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { canonicalJson, sha256Hex } from '../core/manifest.mjs';
import { validateEvidenceBundle } from '../evaluation/bundle-contract.mjs';
import { validateReportMeasurements } from './measurement-contract.mjs';
import { score } from '../../evaluator/score.mjs';
import { scorerEvidenceOf } from '../evaluation/bundle.mjs';
import { validateUIWorksheetFacts, uiScorerInputOf } from './ui-validation.mjs';

export class ReportIntegrityError extends Error {
  constructor(message) { super(message); this.name = 'ReportIntegrityError'; this.code = 'REPORT_INTEGRITY'; }
}
export const refuseReport = message => { throw new ReportIntegrityError(message); };
export const digestOf = value => sha256Hex(canonicalJson(value));
export function reportDigestOf(value) {
  const { reportDigest, ...record } = value;
  return digestOf(record);
}
const bundleSchema = JSON.parse(fs.readFileSync(new URL('../../schemas/evidence-bundle.schema.json', import.meta.url), 'utf8'));
const schema = JSON.parse(fs.readFileSync(new URL('../../schemas/report.schema.json', import.meta.url), 'utf8'));
const supportingSchemas = ['measurement', 'lifecycle', 'snapshot-proof', 'measurement-inputs', 'ui-worksheet'].map(name => JSON.parse(fs.readFileSync(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8')));
const check = new Ajv2020({ allErrors: true, strict: true }).addSchema(bundleSchema).addSchema(supportingSchemas).compile(schema);
export function actualEvaluatorOf(bundle) {
  if (bundle === null) return null;
  const { semanticDigest, packageDigest, evaluatorVersion, scoringVersion, originalCandidate } = bundle.identities.evaluator;
  return { semanticDigest, packageDigest, evaluatorVersion, scoringVersion, originalCandidate };
}
export function assertBundleBindings(bundle, bindings) {
  const ids = bundle.identities;
  const pairs = [
    [ids.challenge.id, bindings.challengeId], [ids.challenge.digest, bindings.challengeIdentityDigest],
    [ids.tooling.id, bindings.toolingId], [ids.tooling.digest, bindings.toolingIdentityDigest],
    [ids.evaluator.binding.id, bindings.evaluatorId], [ids.evaluator.binding.digest, bindings.evaluatorIdentityDigest],
    ...['runId', 'snapshotId', 'frozenSubmissionId', 'manifestDigest', 'treeDigest'].map(k => [ids.submission[k], bindings[k]]),
  ];
  // Evaluation ID is checked against the outer evaluation separately, not a run binding.
  if (pairs.some(([actual, expected]) => actual !== expected)) refuseReport('Bundle identity differs from verified run/submission bindings');
}
export function validateReport(value) {
  if (!check(value)) refuseReport('Invalid Report schema: ' + check.errors.map(e => e.instancePath + ' ' + e.message).join('; ').slice(0, 2000));
  if (!Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) refuseReport('Invalid UTC report timestamp');
  if (value.reportDigest !== reportDigestOf(value)) refuseReport('Report digest mismatch');
  const { bundle, bundleDigest, evaluationId } = value.evidence;
  if (value.execution.evaluatorExecution === 'SUCCESS') {
    if (bundle === null) refuseReport('Successful report needs complete evidence');
    validateEvidenceBundle(bundle);
    assertBundleBindings(bundle, value.bindings);
    if (evaluationId !== bundle.evaluationId || bundleDigest !== digestOf(bundle)) refuseReport('Report evidence digest/ID mismatch');
    let expectedScore=bundle.score;
    if (value.execution.humanReview==='SCORED') {
      const p=value.provenance, b=value.bindings;
      if (!p.parentReportId || !p.parentReportDigest || p.parentReportId===value.reportId || !p.review) refuseReport('Scored report needs distinct bound parent and review');
      const review=validateUIWorksheetFacts(p.review,{bindings:{reportId:p.parentReportId,reportDigest:p.parentReportDigest,evaluationId,bundleDigest,snapshotId:b.snapshotId,treeDigest:b.treeDigest},baseline:{challengeIdentityDigest:b.challengeIdentityDigest,starterDigest:b.workloadDigest,workloadDigest:b.workloadDigest}});
      expectedScore=score(scorerEvidenceOf(bundle),uiScorerInputOf(review));
    } else if (value.provenance.parentReportId!==null || value.provenance.parentReportDigest!==null || value.provenance.review!==null) refuseReport('Pending report cannot carry parentage or a review');
    if (canonicalJson(value.quality) !== canonicalJson(expectedScore)) refuseReport('Report score differs from unchanged scorer');
    if (canonicalJson(value.actualEvaluator) !== canonicalJson(actualEvaluatorOf(bundle))) refuseReport('Actual evaluator identity mismatch');
    if (canonicalJson(value.artifacts) !== canonicalJson(bundle.artifactDigests)) refuseReport('Report artifact references differ from evidence');
  } else if (bundle !== null || bundleDigest !== null || value.quality !== null || value.actualEvaluator !== null || value.artifacts.length) {
    refuseReport('Infrastructure report cannot carry quality or evidence');
  }
  if (value.execution.evaluatorExecution!=='SUCCESS' && (value.execution.humanReview!=='NOT_REVIEWED' || value.provenance.parentReportId!==null || value.provenance.parentReportDigest!==null || value.provenance.review!==null)) refuseReport('Infrastructure report cannot carry review or parentage');
  validateReportMeasurements(value);
  return JSON.parse(JSON.stringify(value));
}
