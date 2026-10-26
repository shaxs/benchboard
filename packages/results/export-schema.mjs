// Captain-owned closed renderer schema. No incoming free-text field is an output label.
const object = properties => ({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const nullable = schema => ({anyOf:[{type:'null'},schema]});
const enumeration = values => ({enum:values});
const digest = {type:'string',pattern:'^[0-9a-f]{64}$'};
const number = {type:'number',minimum:0};
const instant = {type:'string',pattern:'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'};
const array = (items,maxItems=512) => ({type:'array',maxItems,items});
export const EXPORT_NOTICES = Object.freeze(['LOCAL_SELF_ASSESSMENT','NOT_CERTIFIED','MANUAL_UNENFORCED','LABELS_PSEUDONYMIZED','PSEUDONYMS_NOT_ANONYMOUS','PRIVATE_PAYLOADS_OMITTED','NOT_PUBLICATION_PROOF']);
export const EXPORT_METRICS = Object.freeze(['elapsedWallMs','elapsedWallSeconds','inputTokens','outputTokens','cacheReadTokens','totalTokens','automatedQuality','humanUIQuality','finalQuality','automatedPointsPerThousandTokens','finalPointsPerThousandTokens','qualityPointsPerWallSecond','utilization']);
const version = object({core:nullable({type:'string',pattern:'^(?:0|[1-9][0-9]{0,5})\\.(?:0|[1-9][0-9]{0,5})\\.(?:0|[1-9][0-9]{0,5})$'}),fullDigest:digest,suffixWithheld:{type:'boolean'}});
const areas = object(Object.fromEntries(Object.entries({visible:7,functional:30,persistence:10,edge:5,integration:15,code:5,usefulTests:5,hygiene:3}).map(([key,maximum])=>[key,{type:'number',minimum:0,maximum}])));
const ui = object(Object.fromEntries(Object.entries({polish:5,hierarchy:3,board:3,drawer:3,feedback:2,responsive:2,consistency:2}).map(([key,maximum])=>[key,{type:'integer',minimum:0,maximum}])));
const artifact = object({artifactRef:digest,bytes:{type:'integer',minimum:0},sha256:digest});
export const exportSchema = {
  $schema:'https://json-schema.org/draft/2020-12/schema',
  ...object({
    schemaVersion:{const:'1.0.0'},kind:{const:'SafeResultExport'},family:{const:'REPORT'},
    notices:{const:EXPORT_NOTICES},
    identity:object({reportRef:digest,reportDigest:digest,runRef:digest,manifestRef:digest,submissionRef:digest,snapshotRef:digest,parentReportRef:nullable(digest),parentReportDigest:nullable(digest),evaluationRef:nullable(digest),bundleDigest:nullable(digest)}),
    bindings:object({challengeRef:digest,evaluatorRef:digest,toolingRef:digest,challengeIdentityDigest:digest,evaluatorIdentityDigest:digest,toolingIdentityDigest:digest,workloadDigest:digest,manifestDigest:digest,treeDigest:digest}),
    versions:object(Object.fromEntries(['report','challenge','candidate','evaluatorBinding','tooling','actualEvaluator','scoring'].map(key=>[key,nullable(version)]))),
    actualEvaluator:nullable(object({semanticDigest:digest,packageDigest:digest,originalEvaluatorDigest:digest,originalScoringDigest:digest})),
    configuration:object({harnessRef:nullable(digest),modelRef:nullable(digest),workerCount:nullable({type:'integer',minimum:1}),declaredCeilingMinutes:nullable({type:'number',minimum:1,maximum:1440}),executionMode:{const:'MANUAL'}}),
    execution:object({agentOutcome:{type:'null'},evaluatorExecution:enumeration(['SUCCESS','INFRASTRUCTURE_ERROR']),humanReview:enumeration(['NOT_REVIEWED','SCORED']),assessmentTrust:{const:'LOCAL_SELF_ASSESSMENT'},enforcement:{const:'manual'},enforced:{const:false}}),
    quality:nullable(object({automated:{type:'number',minimum:0,maximum:80},automatedMaximum:{const:80},areas,humanUI:nullable({type:'number',minimum:0,maximum:20}),humanMaximum:{const:20},quality:nullable({type:'number',minimum:0,maximum:100}),qualityMaximum:{const:100},status:enumeration(['HUMAN_REVIEW_PENDING','SCORED'])})),
    timing:object({startedAt:nullable(instant),stoppedAt:nullable(instant),elapsedMs:nullable(number),provenance:enumeration(['OPERATOR_ATTESTED','UNAVAILABLE']),clockError:{type:'boolean'}}),
    measurements:array(object({metric:enumeration(EXPORT_METRICS),unit:enumeration(['ms','s','tokens','points','ratio']),measurementKind:enumeration(['MEASURED','ENTERED','DERIVED','UNAVAILABLE']),value:nullable(number),sourceKind:nullable(enumeration(['COMPUTED','SELF_ASSESSMENT'])),procedureCode:nullable(enumeration(['MEASURED_V1','ENTERED_V1','DERIVED_V1'])),formulaCode:nullable(enumeration(['MS_TO_SECONDS','INPUT_PLUS_OUTPUT','AUTOMATED_PLUS_UI','AUTOMATED_PER_1000_TOKENS','FINAL_PER_1000_TOKENS','FINAL_PER_SECOND']))}),13),
    sources:array(object({kind:enumeration(['lifecycle','snapshot-proof','evaluation','token-input']),digest}),4),
    review:nullable(object({reviewerRef:digest,reviewedAt:instant,scores:ui,artifacts:array(artifact,12)})),
    artifacts:array(artifact)
  })
};
