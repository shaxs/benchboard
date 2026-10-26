// Captain-owned request, safe-input and final arithmetic/privacy boundary.
import {canonicalJson} from '../core/manifest.mjs';
import {createCompatibilityExport,validateCompatibilityExport} from './compatibility-export-contract.mjs';
import {comparisonDecision,COMPARISON_NOTICES} from './comparison-policy.mjs';
import {projectQualityDeltas} from './comparison-arithmetic.mjs';
export class ComparisonError extends Error{
  constructor(){super('Invalid descriptive comparison');this.name='ComparisonError';this.code='COMPARISON_INVALID';}
}
const fail=()=>{throw new ComparisonError();};
const keys=(value,names)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==[...names].sort().join('|'))fail();
};
const NULL_DELTAS=()=>({automated:null,humanUI:null,quality:null});
const roundedDifference=(candidate,baseline)=>Number((candidate-baseline).toFixed(4));

/** Validated local summaries only; checks fixed policy, all member dispositions and deltas. */
export function validateComparison(value){
  let captured;
  try{captured=JSON.parse(JSON.stringify(value));}catch{fail();}
  value=captured;
  keys(value,['schemaVersion','kind','baselineIndex','formalComparisonAvailable','notices','items']);
  if(value.schemaVersion!=='1.0.0'||value.kind!=='DescriptiveComparison'||value.formalComparisonAvailable!==false||canonicalJson(value.notices)!==canonicalJson(COMPARISON_NOTICES))fail();
  const {items,baselineIndex}=value;
  if(!Array.isArray(items)||items.length<2||items.length>32||!Number.isInteger(baselineIndex)||baselineIndex<0||baselineIndex>=items.length)fail();
  for(let index=0;index<items.length;index++){
    const item=items[index];keys(item,['index','disposition','reasons','disclosures','summary','deltas']);
    if(item.index!==index)fail();
    if(item.summary!==null)item.summary=validateCompatibilityExport(item.summary);
    keys(item.deltas,['automated','humanUI','quality']);
  }
  const baseline=items[baselineIndex].summary;
  for(const item of items){
    const decision=comparisonDecision(baseline,item.summary,item.index===baselineIndex);
    for(const key of ['disposition','reasons','disclosures'])if(canonicalJson(item[key])!==canonicalJson(decision[key]))fail();
    const expected=NULL_DELTAS();
    if(['AUTOMATED_ONLY','REVIEWED'].includes(decision.disposition)){
      const b=baseline.report.quality,c=item.summary.report.quality;
      expected.automated=roundedDifference(c.automated,b.automated);
      if(decision.disposition==='REVIEWED')for(const key of ['humanUI','quality'])expected[key]=roundedDifference(c[key],b[key]);
    }
    if(canonicalJson(item.deltas)!==canonicalJson(expected))fail();
  }
  return value;
}

/** Every requested member is retained, including refused/malformed entries. No formal eligibility. */
export function compareResults(request){
  keys(request,['inputs','baselineIndex']);
  const {inputs,baselineIndex}=request;
  if(!Array.isArray(inputs)||inputs.length<2||inputs.length>32||!Number.isInteger(baselineIndex)||baselineIndex<0||baselineIndex>=inputs.length)fail();
  const summaries=Array.from(inputs,raw=>{try{return createCompatibilityExport(raw);}catch{return null;}});
  const baseline=summaries[baselineIndex];
  const items=summaries.map((summary,index)=>{
    const decision=comparisonDecision(baseline,summary,index===baselineIndex);
    const deltas=projectQualityDeltas({mode:decision.disposition,baseline:baseline?.report?.quality??null,candidate:summary?.report?.quality??null});
    return {index,...decision,summary,deltas};
  });
  return validateComparison({schemaVersion:'1.0.0',kind:'DescriptiveComparison',baselineIndex,formalComparisonAvailable:false,notices:[...COMPARISON_NOTICES],items});
}
