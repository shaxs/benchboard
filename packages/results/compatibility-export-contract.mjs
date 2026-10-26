// Captain-owned compatibility privacy/non-promotion boundary. Raw local history stays local.
import Ajv2020 from 'ajv/dist/2020.js';
import {canonicalJson,sha256Hex,EVALUATION_TRUSTS,LIFECYCLE_STATES,RUN_STATUSES,EVALUATOR_EXECUTION_STATUSES} from '../core/manifest.mjs';
import {readCompatibilityInput} from './compatibility.mjs';
import {createExportProjection,validateExportProjection} from './export-contract.mjs';
import {exportSchema} from './export-schema.mjs';

const object=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const nullable=schema=>({anyOf:[{type:'null'},schema]});
const enumeration=values=>({enum:values});
const digest={type:'string',pattern:'^[0-9a-f]{64}$'};
const WARNINGS=Object.freeze({REPORT:['LOCAL_SELF_ASSESSMENT_NOT_CERTIFIED'],C1_RESULT:['C1_RESULT_NOT_C4_EVIDENCE','C1_REVIEW_NOT_CURRENT_WORKSHEET'],LEGACY:['UNBOUND_HISTORICAL','HISTORICAL_CLAIMS_NOT_CURRENT_AUTHORITY','HISTORICAL_UI_NOT_CURRENT_WORKSHEET']});
const classification=object({bindingStatus:nullable({const:'UNBOUND_HISTORICAL'}),recognizedLegacyVersion:nullable(enumeration(['1.0','1.1','1.2'])),legacyShape:nullable(enumeration(['result','telemetry'])),lifecycle:nullable(enumeration(LIFECYCLE_STATES)),runStatus:nullable(enumeration(RUN_STATUSES)),declaredEvaluatorExecution:nullable(enumeration(EVALUATOR_EXECUTION_STATUSES)),declaredHumanReview:nullable(enumeration(['NOT_REVIEWED','SCORED'])),scoreEligibility:nullable(enumeration(['ELIGIBLE_NOT_RUN','ELIGIBLE_PENDING_HUMAN_REVIEW','SCORED','INELIGIBLE'])),promotionAllowed:{const:false}});
const schema={$schema:'https://json-schema.org/draft/2020-12/schema',...object({schemaVersion:{const:'1.0.0'},kind:{const:'SafeCompatibilityExport'},family:enumeration(['REPORT','C1_RESULT','LEGACY']),sourceDigest:digest,sourceRef:digest,assessmentTrust:enumeration(EVALUATION_TRUSTS),currentEvidence:{type:'boolean'},currentHumanReview:enumeration(['NOT_REVIEWED','SCORED']),formalComparisonAvailable:{const:false},warnings:{type:'array',maxItems:3,items:enumeration(Object.values(WARNINGS).flat())},classification,report:nullable(exportSchema)})};
const check=new Ajv2020({strict:true,allErrors:true}).compile(schema);
const copy=value=>JSON.parse(JSON.stringify(value));
const sourceRef=(family,sourceDigest)=>sha256Hex(canonicalJson(['benchboard-safe-compatibility-v1',family,sourceDigest]));
const emptyClassification=()=>({bindingStatus:null,recognizedLegacyVersion:null,legacyShape:null,lifecycle:null,runStatus:null,declaredEvaluatorExecution:null,declaredHumanReview:null,scoreEligibility:null,promotionAllowed:false});
export class CompatibilityExportError extends Error{
  constructor(){super('Invalid safe compatibility export');this.name='CompatibilityExportError';this.code='COMPATIBILITY_EXPORT_INTEGRITY';}
}
const fail=()=>{throw new CompatibilityExportError();};

/** Validates prose-free summaries, never raw sources or historical claims as current authority. */
export function validateCompatibilityExport(value){
  if(!check(value))fail();
  try{value=copy(value);}catch{fail();}
  if(!check(value)||value.sourceRef!==sourceRef(value.family,value.sourceDigest)||canonicalJson(value.warnings)!==canonicalJson(WARNINGS[value.family]))fail();
  const c=value.classification;
  if(value.family==='REPORT'){
    if(value.report===null||canonicalJson(c)!==canonicalJson(emptyClassification()))fail();
    value.report=validateExportProjection(value.report);
    if(value.assessmentTrust!==value.report.execution.assessmentTrust||value.currentEvidence!==(value.report.execution.evaluatorExecution==='SUCCESS')||value.currentHumanReview!==value.report.execution.humanReview)fail();
  }else{
    if(value.report!==null||value.currentEvidence||value.currentHumanReview!=='NOT_REVIEWED')fail();
    if(value.family==='LEGACY'){
      if(value.assessmentTrust!=='UNTRUSTED_LEGACY'||c.bindingStatus!=='UNBOUND_HISTORICAL'||c.recognizedLegacyVersion===null||c.legacyShape===null||c.lifecycle!=='DRAFT'||c.declaredEvaluatorExecution!==null||c.declaredHumanReview!==null||c.scoreEligibility!==null)fail();
    }else if(c.bindingStatus!==null||c.recognizedLegacyVersion!==null||c.legacyShape!==null||c.lifecycle===null||c.runStatus===null||c.declaredHumanReview===null||c.scoreEligibility===null)fail();
  }
  return value;
}

/** Local reader preserves originals; this deliberately limited wrapper exports no raw old payload. */
export function createCompatibilityExport(raw){
  const view=readCompatibilityInput(raw),{family,record}=view;
  const sourceDigest=sha256Hex(canonicalJson(family==='LEGACY'?record.sourceRecord:record));
  const c=emptyClassification();
  if(family==='LEGACY'){
    const run=record.sourceRecord.run??record.sourceRecord;
    Object.assign(c,{bindingStatus:record.bindingStatus,recognizedLegacyVersion:record.recognizedSchemaVersion,legacyShape:record.legacyShape,lifecycle:record.trust.lifecycle,runStatus:RUN_STATUSES.includes(run.status)?run.status:null});
  }else if(family==='C1_RESULT')Object.assign(c,{lifecycle:record.lifecycle,runStatus:record.runStatus,declaredEvaluatorExecution:record.evaluatorExecution??null,declaredHumanReview:record.humanReview.reviewStatus,scoreEligibility:record.scoreEligibility});
  return validateCompatibilityExport({schemaVersion:'1.0.0',kind:'SafeCompatibilityExport',family,sourceDigest,sourceRef:sourceRef(family,sourceDigest),assessmentTrust:view.assessmentTrust,currentEvidence:view.currentEvidence,currentHumanReview:view.currentHumanReview,formalComparisonAvailable:false,warnings:[...view.warnings],classification:c,report:family==='REPORT'?createExportProjection(record):null});
}
