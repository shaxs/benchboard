// Synthetic ordinary evidence bytes, not actual screenshots or a real human assessment.
import fs from 'node:fs';
import path from 'node:path';
import { uiCaps } from '../../evaluator/score.mjs';
import { sha256 } from '../../packages/core/identity.mjs';
import { createReport } from '../../packages/results/report.mjs';
import { createUIWorksheetTemplate, readUIWorksheet } from '../../packages/results/ui-worksheet.mjs';
import { makeReportFixture } from './report-fixture.mjs';
export async function makePublicationFixture(t) {
  const {fixture,input}=await makeReportFixture(t),report=await createReport(input);
  const storeRoot=path.join(fixture.root,'report-store'),reviewRoot=path.join(fixture.root,'review-evidence');
  fs.mkdirSync(storeRoot);fs.mkdirSync(reviewRoot);
  return {fixture,input,report,storeRoot,reviewRoot,runRoot:input.selection.runRoot,evaluationRoot:fixture.request.outputRoot};
}
export function physicalWorksheet(report,reviewRoot,positive=true) {
  const w=createUIWorksheetTemplate(report);
  Object.assign(w,{reviewId:'review-publication-synthetic',reviewer:'synthetic-human-reviewer',reviewedAt:'2026-01-03T04:05:06.000Z',baselineCompared:true,evidence:[]});
  for(const target of ['starter','submission'])for(const width of [1440,1024,768])for(const view of ['board','drawer']) {
    const artifactId=`${target}-${width}-${view}`,content=Buffer.from('Synthetic non-image evidence '+artifactId);
    fs.writeFileSync(path.join(reviewRoot,artifactId),content);
    w.evidence.push({artifactId,bytes:content.length,sha256:sha256(content),target,width,height:1000,view});
  }
  for(const [key,cap]of Object.entries(uiCaps)) {
    w.scores[key]=positive?cap:0;w.notes[key]='Synthetic evidence note, not a real visible-quality assessment: '+key;
    if(positive)w.improvements[key]={description:'Synthetic category comparison against the exact starter for '+key,starterArtifactId:'starter-1440-board',submissionArtifactId:'submission-1440-board'};
  }
  return readUIWorksheet(JSON.stringify(w),report);
}
