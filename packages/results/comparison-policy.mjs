// Captain-owned compatibility/disclosure policy over validated S6 safe summaries.
const same=(a,b)=>a===b;
export const COMPARISON_NOTICES=Object.freeze(['DESCRIPTIVE_ONLY','LOCAL_SELF_ASSESSMENT_NOT_CERTIFIED','MANUAL_UNENFORCED','NOT_FORMALLY_CONTROLLED','NO_FORMAL_COMPARISON','PSEUDONYMS_NOT_ANONYMOUS']);
export function comparisonDecision(baseline,candidate,isBaseline){
  const reasons=[],disclosures=['MANUAL_UNENFORCED','NOT_FORMALLY_CONTROLLED'];
  const empty=disposition=>({disposition,reasons,disclosures});
  if(candidate===null){reasons.push('INPUT_REFUSED');return empty('REFUSED');}
  if(isBaseline){reasons.push('BASELINE_NO_SELF_DELTA');return empty('BASELINE');}
  if(baseline===null){reasons.push('BASELINE_UNAVAILABLE');return empty('BLOCKED');}
  if(baseline.assessmentTrust!==candidate.assessmentTrust)disclosures.push('TRUST_DIFFERS');
  if(baseline.family!=='REPORT')reasons.push('BASELINE_NOT_CURRENT_REPORT');
  if(candidate.family!=='REPORT')reasons.push('INPUT_NOT_CURRENT_REPORT');
  if(reasons.length)return empty('BLOCKED');
  const b=baseline.report,c=candidate.report;
  if(b.execution.evaluatorExecution!=='SUCCESS')reasons.push('BASELINE_INFRASTRUCTURE');
  if(c.execution.evaluatorExecution!=='SUCCESS')reasons.push('INPUT_INFRASTRUCTURE');
  if(b.actualEvaluator===null||c.actualEvaluator===null)reasons.push('SEMANTIC_PROVENANCE_UNAVAILABLE');
  else{
    if(b.actualEvaluator.semanticDigest!==c.actualEvaluator.semanticDigest)reasons.push('SEMANTIC_IDENTITY_DIFFERS');
    if(b.actualEvaluator.packageDigest!==c.actualEvaluator.packageDigest)disclosures.push('EVALUATOR_PACKAGE_DIFFERS');
  }
  if(!same(b.bindings.challengeRef,c.bindings.challengeRef)||!same(b.bindings.challengeIdentityDigest,c.bindings.challengeIdentityDigest))reasons.push('CHALLENGE_IDENTITY_DIFFERS');
  if(!same(b.bindings.workloadDigest,c.bindings.workloadDigest))reasons.push('WORKLOAD_DIFFERS');
  for(const [keys,code]of [ [['toolingRef','toolingIdentityDigest'],'TOOLING_DIFFERS'],[['evaluatorRef','evaluatorIdentityDigest'],'EVALUATOR_BINDING_DIFFERS'] ])if(keys.some(key=>b.bindings[key]!==c.bindings[key]))disclosures.push(code);
  const bc=b.configuration,cc=c.configuration;
  if(bc.declaredCeilingMinutes===null||cc.declaredCeilingMinutes===null)disclosures.push('CEILING_UNAVAILABLE');
  if(bc.declaredCeilingMinutes!==cc.declaredCeilingMinutes)disclosures.push('CEILING_DIFFERS');
  if(['harnessRef','modelRef','workerCount'].some(key=>bc[key]===null||cc[key]===null))disclosures.push('DECLARATION_UNAVAILABLE');
  if(['harnessRef','modelRef','workerCount'].some(key=>bc[key]!==cc[key]))disclosures.push('DECLARATION_DIFFERS');
  if(b.timing.elapsedMs===null||c.timing.elapsedMs===null)disclosures.push('TIMING_UNAVAILABLE');
  if(b.timing.provenance!==c.timing.provenance||b.timing.clockError!==c.timing.clockError)disclosures.push('TIMING_PROVENANCE_DIFFERS');
  if(b.review===null||c.review===null)disclosures.push('REVIEW_UNAVAILABLE');
  if((b.review===null)!==(c.review===null))disclosures.push('REVIEW_AVAILABILITY_DIFFERS');
  if(b.review!==null&&c.review!==null){
    if(b.review.reviewerRef!==c.review.reviewerRef)disclosures.push('REVIEWER_DIFFERS');
    if(b.review.reviewedAt!==c.review.reviewedAt)disclosures.push('REVIEW_TIME_DIFFERS');
  }
  if(reasons.length)return empty('BLOCKED');
  if(b.review===null||c.review===null){reasons.push('AUTOMATED_ONLY_PENDING_REVIEW');return empty('AUTOMATED_ONLY');}
  reasons.push('MATCHED_CURRENT_QUALITY');return empty('REVIEWED');
}
