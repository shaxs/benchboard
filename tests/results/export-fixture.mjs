// Synthetic privacy probes in valid, private local inputs. Never a real human assessment.
import {makePublicationFixture,physicalWorksheet} from './publication-fixture.mjs';
import {prepareReviewedReport} from '../../packages/results/reviewed-report.mjs';
import {actualEvaluatorOf,digestOf,reportDigestOf,validateReport} from '../../packages/results/report-contract.mjs';
export const PRIVATE_CANARIES=['PRIVATE_CANARY_ID','PRIVATE_CANARY_REVIEWER','PRIVATE_CANARY_TOKEN','https://private-canary.invalid/key','C:\\private-canary\\secret','PRIVATE_CANARY_CONTROL\n\u001b[31m','PRIVATE_CANARY_CONTROL','private-canary'];
export async function privateExportFixture(t){
  const f=await makePublicationFixture(t),parent=structuredClone(f.report),b=parent.bindings,bundle=parent.evidence.bundle;
  // The accepted earlier S1 form has no operational measurements; do not forge C3 source records.
  parent.measurements=[];parent.provenance.sources=[];
  parent.reportId='PRIVATE_CANARY_ID-report';
  for(const k of ['runId','manifestId','snapshotId','frozenSubmissionId','challengeId','evaluatorId','toolingId'])b[k]='PRIVATE_CANARY_ID-'+k;
  for(const k of ['challengeVersion','candidateVersion','evaluatorVersion','toolingVersion'])b[k]='1.2.3-PRIVATE_CANARY_TOKEN';
  bundle.identities.challenge.id=b.challengeId;bundle.identities.tooling.id=b.toolingId;bundle.identities.evaluator.binding.id=b.evaluatorId;
  for(const k of ['runId','snapshotId','frozenSubmissionId'])bundle.identities.submission[k]=b[k];
  bundle.evaluationId='PRIVATE_CANARY_ID-evaluation';
  bundle.identities.evaluator.evaluatorVersion='1.2.3-PRIVATE_CANARY_TOKEN';bundle.identities.evaluator.scoringVersion='C:\\private-canary\\secret';
  bundle.environment={label:'PRIVATE_CANARY_TOKEN',nodeVersion:PRIVATE_CANARIES[5],platform:PRIVATE_CANARIES[3],architecture:PRIVATE_CANARIES[4],browserVersion:PRIVATE_CANARIES[2]};
  bundle.artifactDigests=[{path:'PRIVATE_CANARY_TOKEN/private.log',bytes:123,sha256:'a'.repeat(64)}];
  parent.artifacts=structuredClone(bundle.artifactDigests);parent.actualEvaluator=actualEvaluatorOf(bundle);
  parent.evidence.bundleDigest=digestOf(bundle);parent.evidence.evaluationId=bundle.evaluationId;
  parent.configuration.harness=PRIVATE_CANARIES[3];parent.configuration.model=PRIVATE_CANARIES[5];
  parent.reportDigest=reportDigestOf(parent);validateReport(parent);
  const worksheet=physicalWorksheet(f.report,f.reviewRoot);
  worksheet.reviewer=PRIVATE_CANARIES[1];worksheet.reviewId='PRIVATE_CANARY_ID-review';
  const old=worksheet.evidence[0].artifactId;worksheet.evidence[0].artifactId='PRIVATE_CANARY_TOKEN-artifact';
  for(const entry of Object.values(worksheet.improvements))if(entry.starterArtifactId===old)entry.starterArtifactId=worksheet.evidence[0].artifactId;
  for(const k of Object.keys(worksheet.notes))worksheet.notes[k]=PRIVATE_CANARIES.join(' ');
  for(const entry of Object.values(worksheet.improvements))entry.description=PRIVATE_CANARIES.join(' ');
  const child=prepareReviewedReport({parent:f.report,worksheet,reportId:'PRIVATE_CANARY_ID-child',createdAt:'2026-01-04T00:00:00.000Z'});
  return {...f,parent,child,worksheet};
}
