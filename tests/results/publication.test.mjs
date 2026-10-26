// Captain-owned storage/containment/fault acceptance; synthetic files, never a real UI assessment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { saveReport, readPublishedReport, attachUIReview } from '../../packages/results/publication.mjs';
import { saveReportWithStorageHooks, publicationKeysOf } from '../../packages/results/publication-runtime.mjs';
import { PublicationError, verifyReportArtifacts } from '../../packages/results/artifact-verification.mjs';
import { createStorage, StorageError } from '../../packages/core/storage.mjs';
import { PathError } from '../../packages/core/paths.mjs';
import { EvaluationRefusalError } from '../../packages/evaluation/contracts.mjs';
import { sha256 } from '../../packages/core/identity.mjs';
import { reportDigestOf, digestOf, ReportIntegrityError } from '../../packages/results/report-contract.mjs';
import { readReport } from '../../packages/results/report.mjs';
import { snapshotInputs, assertInputsUnchanged } from '../evaluation/helpers.mjs';
import { makePublicationFixture, physicalWorksheet } from './publication-fixture.mjs';
const own=(code,cause)=>e=>e instanceof PublicationError&&e.code===code&&cause.test(e.message);
const saveRequest=f=>({storeRoot:f.storeRoot,runRoot:f.runRoot,evaluationRoot:f.evaluationRoot,report:f.report});
const attachRequest=(f,parent,worksheet,id)=>({storeRoot:f.storeRoot,runRoot:f.runRoot,evaluationRoot:f.evaluationRoot,reviewRoot:f.reviewRoot,parentReportId:parent.reportId,reportId:id,createdAt:'2026-01-04T00:00:00.000Z',worksheet});
const storeBytes=(f,id)=>{
  const keys=publicationKeysOf(id);return [keys.report,keys.commit].map(k=>fs.readFileSync(path.join(f.storeRoot,k.relativePath)));
};
test('S4 baseline and two reviewed children publish immutably with exact parent/evaluation/bundle/snapshot references',async t=>{
  const f=await makePublicationFixture(t),before=snapshotInputs(f.fixture),baselineInput=JSON.stringify(f.report),evaluationBytes=f.report.artifacts.map(a=>fs.readFileSync(path.join(f.evaluationRoot,a.path)));
  const base=await saveReport(saveRequest(f)),baseBytes=storeBytes(f,base.reportId);
  assert.deepEqual(await readPublishedReport({storeRoot:f.storeRoot,reportId:base.reportId}),base);
  const worksheet=physicalWorksheet(base,f.reviewRoot),child=await attachUIReview(attachRequest(f,base,worksheet,'report-child-positive'));
  assert.equal(child.quality.humanUI,20);assert.equal(child.provenance.parentReportId,base.reportId);assert.equal(child.provenance.parentReportDigest,base.reportDigest);
  const childBytes=storeBytes(f,child.reportId),zero=physicalWorksheet(child,f.reviewRoot,false),next=await attachUIReview(attachRequest(f,child,zero,'report-child-reviewed-zero'));
  assert.equal(next.quality.humanUI,0);assert.equal(next.quality.quality,base.quality.automated);assert.equal(next.execution.humanReview,'SCORED');
  assert.equal(next.provenance.parentReportId,child.reportId);assert.equal(next.provenance.parentReportDigest,child.reportDigest);
  for(const r of [child,next])for(const key of ['bindings','actualEvaluator','artifacts','evidence'])assert.deepEqual(r[key],base[key]);
  assert.deepEqual(storeBytes(f,base.reportId),baseBytes);assert.deepEqual(storeBytes(f,child.reportId),childBytes);
  for(const [i,a]of f.report.artifacts.entries())assert.deepEqual(fs.readFileSync(path.join(f.evaluationRoot,a.path)),evaluationBytes[i]);
  assert.equal(JSON.stringify(f.report),baselineInput);assertInputsUnchanged(f.fixture,before);
  await assert.rejects(saveReport(saveRequest(f)),own('PUBLICATION_DUPLICATE',/complete report ID already exists/));
  await assert.rejects(saveReport({...saveRequest(f),report:child}),own('PUBLICATION_REQUEST',/reviewed reports require attachment/));
  const malformed=structuredClone(child);malformed.quality.humanUI=0;malformed.reportDigest=reportDigestOf(malformed);
  assert.throws(()=>readReport(JSON.stringify(malformed)),e=>e instanceof ReportIntegrityError&&e.code==='REPORT_INTEGRITY'&&/Report score differs/.test(e.message));
});
test('S4 interrupted pre-marker publication stays unavailable; different retry refuses and identical retry recovers',async t=>{
  const f=await makePublicationFixture(t),request=saveRequest(f);
  await assert.rejects(saveReportWithStorageHooks(request,{beforeRegister:context=>{if(context.kind==='benchboard.result.report.v1')throw new Error('synthetic-interruption');}}),e=>e instanceof StorageError&&e.code==='ERR_STORAGE_HOOK_ABORT');
  await assert.rejects(readPublishedReport({storeRoot:f.storeRoot,reportId:f.report.reportId}),own('PUBLICATION_INCOMPLETE',/No complete publication marker/));
  const changed=structuredClone(f.report);changed.createdAt='2026-02-03T00:00:00.000Z';changed.reportDigest=reportDigestOf(changed);
  await assert.rejects(saveReport({...request,report:changed}),e=>e instanceof StorageError&&e.code==='ERR_STORAGE_DUPLICATE_IDENTITY'&&/different bytes/.test(e.message));
  assert.deepEqual(await saveReport(request),f.report);
  assert.deepEqual(await readPublishedReport({storeRoot:f.storeRoot,reportId:f.report.reportId}),f.report);
});
test('S4 concurrent writers publish at most one; a held accepted lock is never stolen',async t=>{
  const f=await makePublicationFixture(t),results=await Promise.allSettled([saveReport(saveRequest(f)),saveReport(saveRequest(f))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const rejected=results.find(r=>r.status==='rejected').reason;
  assert.ok((rejected instanceof StorageError&&rejected.code==='ERR_STORAGE_LOCK_CONFLICT')||(rejected instanceof PublicationError&&rejected.code==='PUBLICATION_DUPLICATE'));
  const held=createStorage({root:f.storeRoot});await held.withLock(async()=>{
    await assert.rejects(readPublishedReport({storeRoot:f.storeRoot,reportId:f.report.reportId}),e=>e instanceof StorageError&&e.code==='ERR_STORAGE_LOCK_CONFLICT');
  });
  assert.deepEqual(await readPublishedReport({storeRoot:f.storeRoot,reportId:f.report.reportId}),f.report);
});
test('S4 missing/altered evaluation files, hardlinks, traversal and artifact bounds refuse before publication',async t=>{
  const f=await makePublicationFixture(t),first=f.report.artifacts.find(a=>a.bytes>0);assert.ok(first,'the tamper fixture has nonempty evidence');const target=path.join(f.evaluationRoot,first.path),original=fs.readFileSync(target);
  fs.unlinkSync(target);await assert.rejects(saveReport(saveRequest(f)),e=>e instanceof PathError&&e.code==='NOT_FOUND');
  fs.writeFileSync(target,original);const changed=Buffer.from(original);changed[0]^=1;
  fs.writeFileSync(target,changed);
  await assert.rejects(saveReport(saveRequest(f)),own('PUBLICATION_ARTIFACT',/Artifact bytes, digest or identity changed/));
  fs.writeFileSync(target,original);
  const ordinary=path.join(f.reviewRoot,'ordinary'),content=Buffer.from('synthetic-artifact');fs.writeFileSync(ordinary,content);fs.linkSync(ordinary,path.join(f.reviewRoot,'hardlink'));
  assert.throws(()=>verifyReportArtifacts(f.reviewRoot,[{path:'ordinary',bytes:content.length,sha256:sha256(content)}]),own('PUBLICATION_ARTIFACT',/unlinked ordinary file/));
  assert.throws(()=>verifyReportArtifacts(f.reviewRoot,[{path:'../escape',bytes:0,sha256:sha256('')}]),e=>e instanceof PathError&&e.code==='INVALID_RELATIVE_PATH');
  assert.throws(()=>verifyReportArtifacts(f.reviewRoot,[{path:'huge',bytes:134217729,sha256:digestOf('huge')}]),own('PUBLICATION_ARTIFACT',/bounds or identity refused/));
  await assert.rejects(readPublishedReport({storeRoot:f.storeRoot,reportId:f.report.reportId}),own('PUBLICATION_INCOMPLETE',/No complete publication marker/));
});
test('S4 root overlap, junction and public injection refuse without adopting foreign files',async t=>{
  const f=await makePublicationFixture(t),junction=path.join(f.fixture.root,'review-junction');fs.symlinkSync(f.reviewRoot,junction,'junction');
  const w=physicalWorksheet(f.report,f.reviewRoot);await saveReport(saveRequest(f));
  await assert.rejects(attachUIReview({...attachRequest(f,f.report,w,'report-linked-review'),reviewRoot:junction}),e=>e instanceof EvaluationRefusalError&&e.code==='UNSAFE_PATH'&&/Linked or non-directory ancestor/.test(e.message));
  await assert.rejects(saveReport({...saveRequest(f),storeRoot:f.runRoot}),e=>e instanceof PathError&&e.code==='DUPLICATE_ROOT');
  await assert.rejects(saveReport({...saveRequest(f),hooks:{}}),own('PUBLICATION_REQUEST',/unknown options refused/));
  const keys=publicationKeysOf('foreign-report'),foreign=path.join(f.storeRoot,keys.report.relativePath);fs.writeFileSync(foreign,'foreign-canary');
  const candidate={...f.report,reportId:'foreign-report',measurements:f.report.measurements.map(m=>({...m,measurementId:'foreign-report:'+m.metric}))};candidate.reportDigest=reportDigestOf(candidate);
  await assert.rejects(saveReport({...saveRequest(f),report:candidate}),e=>e instanceof StorageError&&e.code==='ERR_STORAGE_ENVELOPE_MALFORMED'&&/not valid JSON/.test(e.message));
  assert.equal(fs.readFileSync(foreign,'utf8'),'foreign-canary');
});
test('S4 pre-marker artifact mutation cannot advertise complete publication; late marker error discloses retained complete fate',async t=>{
  const f=await makePublicationFixture(t),first=f.report.artifacts[0],target=path.join(f.evaluationRoot,first.path),content=fs.readFileSync(target);
  await assert.rejects(saveReportWithStorageHooks(saveRequest(f),{beforeRegister:ctx=>{if(ctx.kind==='benchboard.result.report.v1')fs.appendFileSync(target,'late synthetic mutation');}}),own('PUBLICATION_ARTIFACT',/recorded size/));
  await assert.rejects(readPublishedReport({storeRoot:f.storeRoot,reportId:f.report.reportId}),own('PUBLICATION_INCOMPLETE',/No complete publication marker/));
  fs.writeFileSync(target,content);
  await assert.rejects(saveReportWithStorageHooks(saveRequest(f),{beforeRegister:ctx=>{if(ctx.kind==='benchboard.result.report-commit.v1')throw new Error('late-marker-error');}}),e=>e instanceof StorageError&&e.code==='ERR_STORAGE_HOOK_ABORT');
  assert.deepEqual(await readPublishedReport({storeRoot:f.storeRoot,reportId:f.report.reportId}),f.report,'late error may retain a complete application marker; no rollback claim');
});
test('S4 legacy empty-array S1 Reports still read, while forged application commit markers refuse',async t=>{
  const f=await makePublicationFixture(t),old={...f.report,measurements:[],provenance:{parentReportId:null,parentReportDigest:null,review:null,sources:[]}};old.reportDigest=reportDigestOf(old);
  assert.deepEqual(readReport(JSON.stringify(old)),old);
  const keys=publicationKeysOf(f.report.reportId),storage=createStorage({root:f.storeRoot});
  await storage.createImmutable({...keys.report,value:f.report});
  await storage.createImmutable({...keys.commit,value:{reportId:f.report.reportId,reportDigest:'0'.repeat(64)}});
  await assert.rejects(readPublishedReport({storeRoot:f.storeRoot,reportId:f.report.reportId}),own('PUBLICATION_INTEGRITY',/marker differs from report/));
});
test('S4 attachment refuses missing and changed review files while the immutable parent stays byte-identical',async t=>{
  const f=await makePublicationFixture(t);await saveReport(saveRequest(f));const before=storeBytes(f,f.report.reportId),w=physicalWorksheet(f.report,f.reviewRoot),first=w.evidence[0],file=path.join(f.reviewRoot,first.artifactId),bytes=fs.readFileSync(file);
  fs.unlinkSync(file);await assert.rejects(attachUIReview(attachRequest(f,f.report,w,'report-missing-review')),e=>e instanceof PathError&&e.code==='NOT_FOUND');
  const altered=Buffer.from(bytes);altered[0]^=1;fs.writeFileSync(file,altered);
  await assert.rejects(attachUIReview(attachRequest(f,f.report,w,'report-altered-review')),own('PUBLICATION_ARTIFACT',/Artifact bytes, digest or identity changed/));
  assert.deepEqual(storeBytes(f,f.report.reportId),before);
  for(const reportId of ['report-missing-review','report-altered-review'])await assert.rejects(readPublishedReport({storeRoot:f.storeRoot,reportId}),own('PUBLICATION_INCOMPLETE',/No complete publication marker/));
});
test('S4 an orphaned accepted storage lock is refused unchanged, never expired or stolen',async t=>{
  const f=await makePublicationFixture(t);await saveReport(saveRequest(f));
  const lock=path.join(f.storeRoot,'.storage','lock'),bytes=Buffer.from('synthetic-orphan-lock');fs.writeFileSync(lock,bytes,{flag:'wx'});
  await assert.rejects(readPublishedReport({storeRoot:f.storeRoot,reportId:f.report.reportId}),e=>e instanceof StorageError&&e.code==='ERR_STORAGE_LOCK_CONFLICT');
  await assert.rejects(saveReport(saveRequest(f)),e=>e instanceof StorageError&&e.code==='ERR_STORAGE_LOCK_CONFLICT');
  assert.deepEqual(fs.readFileSync(lock),bytes);
});
test('S4 a valid storage envelope cannot relabel a different report under the selected publication ID',async t=>{
  const f=await makePublicationFixture(t),selected='report-mislabelled-container',keys=publicationKeysOf(selected),storage=createStorage({root:f.storeRoot}),r=f.report;
  await storage.createImmutable({...keys.report,value:r});
  await storage.createImmutable({...keys.commit,value:{schemaVersion:'1.0.0',kind:'benchboard.result.report-commit.v1',reportId:r.reportId,reportDigest:r.reportDigest,evaluationId:r.evidence.evaluationId,bundleDigest:r.evidence.bundleDigest,snapshotId:r.bindings.snapshotId,treeDigest:r.bindings.treeDigest,parentReportId:null,parentReportDigest:null}});
  await assert.rejects(readPublishedReport({storeRoot:f.storeRoot,reportId:selected}),own('PUBLICATION_INTEGRITY',/Stored report ID differs from selected publication/));
});
test('S4 pre-report verification refuses frozen temporary source changed after report creation',async t=>{
  const f=await makePublicationFixture(t),source=path.join(f.fixture.frozen.snapshotRoot,'src','App.tsx');
  fs.appendFileSync(source,'\n// synthetic test-owned frozen-copy mutation\n');
  await assert.rejects(saveReport(saveRequest(f)),own('PUBLICATION_INTEGRITY',/Report frozen source no longer verifies/));
  await assert.rejects(readPublishedReport({storeRoot:f.storeRoot,reportId:f.report.reportId}),own('PUBLICATION_INCOMPLETE',/No complete publication marker/));
});
test('S4 pre-marker C3 verification refuses frozen bytes changed after the report record exists',async t=>{
  const f=await makePublicationFixture(t),source=path.join(f.fixture.frozen.snapshotRoot,'src','App.tsx');let mutations=0;
  await assert.rejects(saveReportWithStorageHooks(saveRequest(f),{beforeRegister:context=>{
    if(context.kind!=='benchboard.result.report.v1')return;
    assert.ok(fs.existsSync(path.join(f.storeRoot,context.relativePath)),'the report record bytes already exist before this mutation');
    fs.appendFileSync(source,'\n// synthetic post-report pre-marker frozen-copy mutation\n');mutations++;
  }}),own('PUBLICATION_INTEGRITY',/Report frozen source no longer verifies/));
  assert.equal(mutations,1,'the post-report hook actually executed once');
  await assert.rejects(readPublishedReport({storeRoot:f.storeRoot,reportId:f.report.reportId}),own('PUBLICATION_INCOMPLETE',/No complete publication marker/));
});
