// Captain-owned immutable publication/marker/recovery. Internal storage hooks are test-only.
import { createStorage, StorageError } from '../core/storage.mjs';
import { verifyFrozenSubmission } from '../core/freeze.mjs';
import { canonicalJson } from '../core/manifest.mjs';
import { validateReport, digestOf } from './report-contract.mjs';
import { validateUIWorksheet } from './ui-contract.mjs';
import { prepareReviewedReport } from './reviewed-report.mjs';
import { assertReportRoots, verifyReportArtifacts, publicationRefusal } from './artifact-verification.mjs';
const REPORT_KIND='benchboard.result.report.v1', COMMIT_KIND='benchboard.result.report-commit.v1';
export function publicationKeysOf(reportId) {
  if(typeof reportId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(reportId)) publicationRefusal('PUBLICATION_ID','Explicit valid report ID required');
  const name=digestOf(reportId);
  return {report:{relativePath:`reports/${name}.json`,kind:REPORT_KIND,id:reportId},commit:{relativePath:`commits/${name}.json`,kind:COMMIT_KIND,id:reportId}};
}
const markerOf=r=>({schemaVersion:'1.0.0',kind:COMMIT_KIND,reportId:r.reportId,reportDigest:r.reportDigest,evaluationId:r.evidence.evaluationId,bundleDigest:r.evidence.bundleDigest,snapshotId:r.bindings.snapshotId,treeDigest:r.bindings.treeDigest,parentReportId:r.provenance.parentReportId,parentReportDigest:r.provenance.parentReportDigest});
async function optionalRead(storage,key) {
  try{return await storage.read(key);}catch(error){if(error instanceof StorageError&&error.code==='ERR_STORAGE_NOT_FOUND')return null;throw error;}
}
async function committedRead(storage,reportId) {
  const keys=publicationKeysOf(reportId), marker=await optionalRead(storage,keys.commit);
  if(marker===null) publicationRefusal('PUBLICATION_INCOMPLETE','No complete publication marker; identical retry or explicit operator disposition required');
  const report=validateReport(await storage.read(keys.report));
  if(report.reportId!==reportId) publicationRefusal('PUBLICATION_INTEGRITY','Stored report ID differs from selected publication');
  if(canonicalJson(marker)!==canonicalJson(markerOf(report))) publicationRefusal('PUBLICATION_INTEGRITY','Publication marker differs from report');
  return report;
}
async function publish(storage,report,beforeCommit) {
  const keys=publicationKeysOf(report.reportId);
  if(await optionalRead(storage,keys.commit)!==null) {
    await committedRead(storage,report.reportId);
    publicationRefusal('PUBLICATION_DUPLICATE','A complete report ID already exists; create a new distinct report');
  }
  try {await storage.createImmutable({...keys.report,value:report});}
  catch(error) {
    // A registered report without its marker is a recoverable interrupted multi-record publication.
    if(!(error instanceof StorageError) || error.code!=='ERR_STORAGE_DUPLICATE_IDENTITY' || canonicalJson(await storage.read(keys.report))!==canonicalJson(report))throw error;
  }
  await beforeCommit();
  await storage.createImmutable({...keys.commit,value:markerOf(report)});
  return committedRead(storage,report.reportId);
}
function capture(request,fields) {
  if(!request || typeof request!=='object'||Array.isArray(request)||Object.keys(request).sort().join(',')!==[...fields].sort().join(',')) publicationRefusal('PUBLICATION_REQUEST','Explicit publication request fields required; unknown options refused');
  try{return JSON.parse(JSON.stringify(request));}catch{publicationRefusal('PUBLICATION_REQUEST','Publication request must be serialized JSON');}
}
async function verifyRun(report,runRoot) {
  const b=report.bindings,verified=await verifyFrozenSubmission({runRoot,runId:b.runId,manifestId:b.manifestId,expectedDigest:b.manifestDigest,snapshotId:b.snapshotId,frozenSubmissionId:b.frozenSubmissionId});
  if(!verified.ok||verified.state!=='FROZEN'||verified.submissions.length!==1||!verified.submissions[0].ok||verified.submissions[0].treeDigest!==b.treeDigest) publicationRefusal('PUBLICATION_INTEGRITY','Report frozen source no longer verifies');
}
function verifyEvaluation(report,evaluationRoot) {verifyReportArtifacts(evaluationRoot,report.artifacts);}
export async function saveReportWithStorageHooks(request,hooks) {
  const r=capture(request,['storeRoot','runRoot','evaluationRoot','report']);
  const report=validateReport(r.report);
  if(report.execution.humanReview!=='NOT_REVIEWED') publicationRefusal('PUBLICATION_REQUEST','Save a baseline report; reviewed reports require attachment with physical evidence');
  assertReportRoots([r.storeRoot,r.runRoot,r.evaluationRoot]);
  const storage=createStorage({root:r.storeRoot,hooks});
  return storage.withLock(async()=>{await verifyRun(report,r.runRoot);verifyEvaluation(report,r.evaluationRoot);const published=await publish(storage,report,async()=>{await verifyRun(report,r.runRoot);verifyEvaluation(report,r.evaluationRoot);});verifyEvaluation(report,r.evaluationRoot);return published;});
}
export async function readPublishedReportInternal(request) {
  const r=capture(request,['storeRoot','reportId']);assertReportRoots([r.storeRoot]);
  const storage=createStorage({root:r.storeRoot});
  return storage.withLock(()=>committedRead(storage,r.reportId));
}
export async function attachUIReviewInternal(request) {
  const r=capture(request,['storeRoot','runRoot','evaluationRoot','parentReportId','reportId','createdAt','worksheet','reviewRoot']);
  assertReportRoots([r.storeRoot,r.runRoot,r.evaluationRoot,r.reviewRoot]);
  const storage=createStorage({root:r.storeRoot});
  return storage.withLock(async()=>{
    const parent=await committedRead(storage,r.parentReportId),worksheet=validateUIWorksheet(r.worksheet,parent);
    await verifyRun(parent,r.runRoot);verifyEvaluation(parent,r.evaluationRoot);
    const reviewFiles=worksheet.evidence.map(e=>({path:e.artifactId,bytes:e.bytes,sha256:e.sha256}));
    verifyReportArtifacts(r.reviewRoot,reviewFiles,{maxFileBytes:16777216,maxTotalBytes:201326592});
    const child=prepareReviewedReport({parent,worksheet,reportId:r.reportId,createdAt:r.createdAt});
    const published=await publish(storage,child,async()=>{await verifyRun(parent,r.runRoot);verifyEvaluation(parent,r.evaluationRoot);verifyReportArtifacts(r.reviewRoot,reviewFiles,{maxFileBytes:16777216,maxTotalBytes:201326592});});
    verifyEvaluation(parent,r.evaluationRoot);verifyReportArtifacts(r.reviewRoot,reviewFiles,{maxFileBytes:16777216,maxTotalBytes:201326592});
    return published;
  });
}
