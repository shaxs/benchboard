// Captain-owned privacy boundary. Build a closed projection; never scrub then serialize raw data.
import Ajv2020 from 'ajv/dist/2020.js';
import {canonicalJson,sha256Hex} from '../core/manifest.mjs';
import {validateReport} from './report-contract.mjs';
import {projectMeasurements} from './measurements.mjs';
import {exportSchema,EXPORT_NOTICES} from './export-schema.mjs';

export class ExportIntegrityError extends Error {
  constructor(){super('Invalid safe export projection');this.name='ExportIntegrityError';this.code='EXPORT_INTEGRITY';}
}
const fail=()=>{throw new ExportIntegrityError();};
const copy=value=>JSON.parse(JSON.stringify(value));
const check=new Ajv2020({strict:true,allErrors:true}).compile(exportSchema);
const opaque=(domain,value)=>value===null?null:sha256Hex(canonicalJson(['benchboard-safe-export-v1',domain,value]));
const version=value=>{
  if(value===null)return null;
  const match=/^((?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5}))(?:[-+].{1,990})?$/.exec(value);
  return {core:match?.[1]??null,fullDigest:opaque('version',value),suffixWithheld:match?match[1]!==value:true};
};
const PROCEDURES={'benchboard-c5-measured-v1':'MEASURED_V1','benchboard-c5-entered-v1':'ENTERED_V1','benchboard-c5-derived-v1':'DERIVED_V1'};
const FORMULAS={'{elapsedWallMs} / 1000':'MS_TO_SECONDS','{inputTokens} + {outputTokens}':'INPUT_PLUS_OUTPUT','{automatedQuality} + {humanUIQuality}':'AUTOMATED_PLUS_UI','{automatedQuality} * 1000 / {totalTokens}':'AUTOMATED_PER_1000_TOKENS','{finalQuality} * 1000 / {totalTokens}':'FINAL_PER_1000_TOKENS','{finalQuality} / {elapsedWallSeconds}':'FINAL_PER_SECOND'};
const artifact=(domain,id,bytes,sha256)=>({artifactRef:opaque(domain,id),bytes,sha256});
const round=value=>Number(value.toFixed(4));

/** Validates the closed, prose-free renderer input, not authorship or publication. */
export function validateExportProjection(value){
  if(!check(value))fail();
  // Check the captured JSON too: a non-enumerable toJSON cannot smuggle extra payload to a renderer.
  try{value=copy(value);}catch{fail();}
  if(!check(value))fail();
  const q=value.quality, success=value.execution.evaluatorExecution==='SUCCESS', reviewed=value.execution.humanReview==='SCORED';
  if(success!==(q!==null)||success!==(value.actualEvaluator!==null)||success!==(value.identity.bundleDigest!==null))fail();
  if(success&&value.identity.evaluationRef===null)fail();
  if(reviewed!==(value.review!==null)||reviewed!==(value.identity.parentReportRef!==null)||reviewed!==(value.identity.parentReportDigest!==null))fail();
  if(q){
    if(q.automated!==round(Object.values(q.areas).reduce((a,b)=>a+b,0)))fail();
    if(reviewed){if(q.status!=='SCORED'||q.humanUI!==Object.values(value.review.scores).reduce((a,b)=>a+b,0)||q.quality!==round(q.automated+q.humanUI))fail();}
    else if(q.status!=='HUMAN_REVIEW_PENDING'||q.humanUI!==null||q.quality!==null)fail();
  }else if(reviewed||value.artifacts.length)fail();
  if(new Set(value.measurements.map(row=>row.metric)).size!==value.measurements.length)fail();
  for(const row of value.measurements){
    if((row.measurementKind==='UNAVAILABLE')!==(row.value===null))fail();
    if(row.value===null&&(row.sourceKind!==null||row.procedureCode!==null||row.formulaCode!==null))fail();
  }
  if(value.measurements.length){
    const byName=Object.fromEntries(value.measurements.map(row=>[row.metric,row.value]));
    let expected;
    try{expected=projectMeasurements({idPrefix:'safe-export',timing:{elapsedMs:value.timing.elapsedMs},tokens:{inputTokens:byName.inputTokens,outputTokens:byName.outputTokens,cacheReadTokens:byName.cacheReadTokens},quality:q});}catch{fail();}
    const projected=expected.map(m=>({metric:m.metric,unit:m.unit,measurementKind:m.measurementKind,value:m.value,sourceKind:m.source?.kind??null,procedureCode:m.source?PROCEDURES[m.source.procedure]:null,formulaCode:m.derivation?FORMULAS[m.derivation]:null}));
    if(canonicalJson(value.measurements)!==canonicalJson(projected))fail();
  }
  if(new Set(value.sources.map(source=>source.kind)).size!==value.sources.length)fail();
  if((value.sources.length===0)!==(value.measurements.length===0))fail();
  if(value.sources.length){
    const sources=new Map(value.sources.map(source=>[source.kind,source.digest]));
    if(!sources.has('lifecycle')||!sources.has('snapshot-proof')||sources.has('evaluation')!==success)fail();
    if(success&&sources.get('evaluation')!==value.identity.bundleDigest)fail();
    if(value.measurements.some(row=>['inputTokens','outputTokens','cacheReadTokens'].includes(row.metric)&&row.value!==null)&&!sources.has('token-input'))fail();
  }
  if(value.review&&value.review.artifacts.length!==12)fail();
  for(const entries of [value.artifacts,value.review?.artifacts??[]])if(new Set(entries.map(entry=>entry.artifactRef)).size!==entries.length)fail();
  for(const time of [value.timing.startedAt,value.timing.stoppedAt,value.review?.reviewedAt??null]){
    if(time!==null&&(!Number.isFinite(Date.parse(time))||new Date(time).toISOString()!==time))fail();
  }
  const time=value.timing,both=time.startedAt!==null&&time.stoppedAt!==null;
  if(time.provenance!==(both?'OPERATOR_ATTESTED':'UNAVAILABLE'))fail();
  const elapsed=both&&!time.clockError?Date.parse(time.stoppedAt)-Date.parse(time.startedAt):null;
  if((elapsed!==null&&elapsed<0)||time.elapsedMs!==elapsed)fail();
  return value;
}

/** Validated current Report -> safe local summary. No filesystem read or publication claim. */
export function createExportProjection(raw){
  const r=validateReport(raw), b=r.bindings, p=r.provenance, a=r.actualEvaluator;
  const lc=p.sources.find(s=>s.kind==='lifecycle')?.record;
  const projection={
    schemaVersion:'1.0.0',kind:'SafeResultExport',family:'REPORT',notices:[...EXPORT_NOTICES],
    identity:{reportRef:opaque('report',r.reportId),reportDigest:r.reportDigest,runRef:opaque('run',b.runId),manifestRef:opaque('manifest',b.manifestId),submissionRef:opaque('submission',b.frozenSubmissionId),snapshotRef:opaque('snapshot',b.snapshotId),parentReportRef:opaque('report',p.parentReportId),parentReportDigest:p.parentReportDigest,evaluationRef:opaque('evaluation',r.evidence.evaluationId),bundleDigest:r.evidence.bundleDigest},
    bindings:{challengeRef:opaque('challenge',b.challengeId),evaluatorRef:opaque('evaluator',b.evaluatorId),toolingRef:opaque('tooling',b.toolingId),...Object.fromEntries(['challengeIdentityDigest','evaluatorIdentityDigest','toolingIdentityDigest','workloadDigest','manifestDigest','treeDigest'].map(k=>[k,b[k]]))},
    versions:{report:version(r.schemaVersion),challenge:version(b.challengeVersion),candidate:version(b.candidateVersion),evaluatorBinding:version(b.evaluatorVersion),tooling:version(b.toolingVersion),actualEvaluator:version(a?.evaluatorVersion??null),scoring:version(a?.scoringVersion??null)},
    actualEvaluator:a?{semanticDigest:a.semanticDigest,packageDigest:a.packageDigest,originalEvaluatorDigest:a.originalCandidate.evaluator,originalScoringDigest:a.originalCandidate.scoring}:null,
    configuration:{harnessRef:opaque('harness',r.configuration.harness),modelRef:opaque('model',r.configuration.model),workerCount:r.configuration.workerCount,declaredCeilingMinutes:r.configuration.declaredCeilingMinutes,executionMode:'MANUAL'},
    execution:{...r.execution},quality:r.quality===null?null:copy(r.quality),
    timing:{startedAt:lc?.startedAt??null,stoppedAt:lc?.stoppedAt??null,elapsedMs:lc?.elapsedMs??null,provenance:lc?.startedAt!=null&&lc?.stoppedAt!=null?'OPERATOR_ATTESTED':'UNAVAILABLE',clockError:lc?.clockError!=null},
    measurements:r.measurements.map(m=>({metric:m.metric,unit:m.unit,measurementKind:m.measurementKind,value:m.value,sourceKind:m.source?.kind??null,procedureCode:m.source?PROCEDURES[m.source.procedure]??null:null,formulaCode:m.derivation?FORMULAS[m.derivation]??null:null})),
    sources:p.sources.map(s=>({kind:s.kind,digest:s.digest})),
    review:p.review?{reviewerRef:opaque('reviewer',p.review.reviewer),reviewedAt:p.review.reviewedAt,scores:copy(p.review.scores),artifacts:p.review.evidence.map(e=>artifact('review-artifact',e.artifactId,e.bytes,e.sha256))}:null,
    artifacts:r.artifacts.map(e=>artifact('evaluation-artifact',e.path,e.bytes,e.sha256))
  };
  return validateExportProjection(projection);
}
