// Captain security/acceptance: synthetic review metadata only, not a real participant/reference UI review.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { score, uiCaps } from '../../evaluator/score.mjs';
import { sha256 } from '../../packages/core/identity.mjs';
import { scorerEvidenceOf } from '../../packages/evaluation/bundle.mjs';
import { createReport } from '../../packages/results/report.mjs';
import { createUIWorksheetTemplate, readUIWorksheet, scoreUIWorksheet } from '../../packages/results/ui-worksheet.mjs';
import { validateUIWorksheet, UIWorksheetError } from '../../packages/results/ui-contract.mjs';
import { makeReportFixture } from './report-fixture.mjs';

const invalid = e => e instanceof UIWorksheetError && e.code === 'UI_WORKSHEET_INVALID';
function completed(report, positive = false) {
  const w = createUIWorksheetTemplate(report);
  Object.assign(w, {reviewId:'review-synthetic-001',reviewer:'synthetic-reviewer',reviewedAt:'2026-01-03T04:05:06.000Z',baselineCompared:true});
  w.evidence = [];
  for (const target of ['starter','submission']) for (const width of [1440,1024,768]) for (const view of ['board','drawer']) {
    const artifactId = `${target}-${width}-${view}`;
    const content = 'synthetic evidence metadata: ' + artifactId;
    w.evidence.push({artifactId,bytes:Buffer.byteLength(content),sha256:sha256(content),target,width,height:1000,view});
  }
  for (const [key, cap] of Object.entries(uiCaps)) {
    w.scores[key] = positive ? cap : 0;
    w.notes[key] = `Synthetic category evidence reviewed for ${key}; not an actual human assessment.`;
    if (positive) w.improvements[key] = { description:`Synthetic ${key}: clearer grouping compared with the exact bound starter.`,starterArtifactId:'starter-1440-board',submissionArtifactId:'submission-1440-board' };
  }
  return w;
}

test('S3 worksheet binds a pending report; reviewed zero and positive evidence invoke unchanged scorer without source edits', async t => {
  const {input} = await makeReportFixture(t), report = await createReport(input), before = JSON.stringify(report);
  const template = createUIWorksheetTemplate(report);
  assert.equal(template.baselineCompared, false);
  assert.ok(Object.values(template.scores).every(v => v === null));
  assert.throws(() => validateUIWorksheet(template,report), invalid);
  for (const positive of [false,true]) {
    const w = completed(report,positive), saved = JSON.stringify(w);
    assert.deepEqual(readUIWorksheet(saved,report),w);
    const result = scoreUIWorksheet(report,w);
    const ui = {reviewer:w.reviewer,reviewedAt:w.reviewedAt,baselineCompared:true,evidence:JSON.stringify(w.evidence),scores:w.scores,improvements:Object.fromEntries(Object.entries(w.improvements).map(([k,v])=>[k,v.description]))};
    assert.deepEqual(result,score(scorerEvidenceOf(report.evidence.bundle),ui));
    assert.equal(result.humanUI,positive?20:0);
    assert.equal(result.quality,report.quality.automated+(positive?20:0));
    assert.equal(result.automated,report.quality.automated);
    assert.equal(JSON.stringify(w),saved);
  }
  assert.equal(JSON.stringify(report),before);
});

test('S3 refuses every malformed/unknown score, blank provenance, missing note, unbound baseline and unmatched evidence pair', async t => {
  const {input}=await makeReportFixture(t), report=await createReport(input), good=completed(report,true);
  const schema=/Invalid UI worksheet schema/, binding=/UI report\/evaluation\/snapshot\/starter binding mismatch/;
  const mutations = [
    [w=>{w.schemaVersion='2.0.0';},schema],[w=>{w.total=20;},schema],[w=>{w.automated=80;},schema],[w=>{w.scores.other=1;},schema],
    [w=>{delete w.scores.polish;},schema],[w=>{w.scores.polish=5.5;},schema],[w=>{w.scores.polish=6;},schema],[w=>{w.scores.board=-1;},schema],
    [w=>{w.reviewer='  ';},/Named reviewer and valid canonical UTC review time/],[w=>{w.reviewedAt='2026-02-30T00:00:00.000Z';},/Named reviewer and valid canonical UTC review time/],[w=>{w.reviewedAt='2026-01-03T04:05:06+00:00';},schema],
    [w=>{w.baselineCompared=false;},schema],[w=>{delete w.notes.drawer;},schema],[w=>{w.notes.polish='   ';},/Each UI category needs a valid score and evidence note/],
    [w=>{delete w.improvements.polish;},/Positive UI points need concrete baseline improvement evidence/],[w=>{w.improvements.polish.description='TODO';},schema],
    ...['reportId','evaluationId','snapshotId'].map(k=>[w=>{w.bindings[k]+='-other';},binding]),
    ...['reportDigest','bundleDigest','treeDigest'].map(k=>[w=>{w.bindings[k]='0'.repeat(64);},binding]),
    ...['starterDigest','workloadDigest','challengeIdentityDigest'].map(k=>[w=>{w.baseline[k]='0'.repeat(64);},binding]),
    [w=>{w.evidence.pop();},schema],[w=>{w.evidence[1]=structuredClone(w.evidence[0]);},/Duplicate UI artifact identity or viewport\/view/],
    [w=>{w.evidence[0].artifactId='../escape';},schema],[w=>{w.evidence[0].bytes=16777217;},schema],
    [w=>{w.improvements.polish.starterArtifactId='submission-1440-board';},/Improvement must describe a matched starter\/submission evidence pair/],
    [w=>{w.improvements.polish.submissionArtifactId='submission-768-board';},/Improvement must describe a matched starter\/submission evidence pair/],
    [w=>{w.improvements.polish.submissionArtifactId='submission-1440-drawer';},/Improvement must describe a matched starter\/submission evidence pair/],
    [w=>{w.improvements.polish.description='............';},/Improvement must describe a matched starter\/submission evidence pair/],
    [w=>{w.notes.polish='pending';},/Each UI category needs a valid score and evidence note/],
  ];
  assert.deepEqual(readUIWorksheet(JSON.stringify(good),report),good,'the unmutated control must validate');
  for (const [mutate,cause] of mutations) {const changed=structuredClone(good);mutate(changed);assert.throws(()=>readUIWorksheet(JSON.stringify(changed),report),e=>invalid(e)&&cause.test(e.message));}
  assert.throws(()=>readUIWorksheet('not json',report),e=>invalid(e)&&/Invalid UI worksheet JSON text/.test(e.message));
  assert.throws(()=>readUIWorksheet({},report),e=>invalid(e)&&/UI worksheet JSON text required/.test(e.message));
});

test('S3 blank shipped worksheet and infrastructure reports cannot award UI points', async t => {
  const {input}=await makeReportFixture(t), report=await createReport(input);
  const blank=fs.readFileSync(new URL('../../docs/UI_WORKSHEET.json',import.meta.url),'utf8');
  assert.throws(()=>readUIWorksheet(blank,report),invalid);
  const failure=await createReport({...input,evaluation:{status:'infrastructure-error',evaluationId:null,bundle:null,evidence:null,score:null,error:{code:'TIMEOUT'}}});
  assert.throws(()=>createUIWorksheetTemplate(failure),e=>invalid(e)&&/UI review requires a successful bound automated report/.test(e.message));
});
