// Captain R1-F2 privacy regression: real full-source timed Report, then synthetic
// schema-valid declaration/history metadata. Intrinsic validation is not authentication.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {initialiseRun} from '../../packages/core/init.mjs';
import {startRun,stopRun,lifecycleStateDigestOf} from '../../packages/core/lifecycle.mjs';
import {freezeRun} from '../../packages/core/freeze.mjs';
import {loadFixture} from '../contracts/fixtures/contracts/index.mjs';
import {createFrozenFixture} from '../evaluation/helpers.mjs';
import {evaluateWithRuntime} from '../../packages/evaluation/controller.mjs';
import {attachEvidenceBundle} from '../../packages/evaluation/bundle-runtime.mjs';
import {computeEvaluatorIdentity} from '../../packages/evaluation/evaluator-identity.mjs';
import {OWNER_ROOT} from '../../packages/evaluation/staging.mjs';
import {inventoryTree} from '../../packages/core/identity.mjs';
import {createReport} from '../../packages/results/report.mjs';
import {digestOf,reportDigestOf,validateReport} from '../../packages/results/report-contract.mjs';
import {createExportProjection} from '../../packages/results/export-contract.mjs';
import {renderReportJSON,renderReportText} from '../../packages/results/exports.mjs';

test('S5 full operational sources retain canary declarations, history, physical snapshot paths and inventory privately in both formats',async t=>{
  const base=await createFrozenFixture(t);
  const labels={harness:'SOURCE_CANARY_HARNESS',model:'SOURCE_CANARY_MODEL',root:'SOURCE_CANARY_RUN_ROOT',inventory:'SOURCE_CANARY_INVENTORY.txt',operator:'SOURCE_CANARY_OPERATOR',statement:'SOURCE_CANARY_ATTESTATION https://source-canary.invalid/private',decision:'SOURCE_CANARY_DECISION',historyOperator:'SOURCE_CANARY_HISTORY_OPERATOR',operatorAttestation:'SOURCE_CANARY_HISTORY_ATTESTATION',interruptedOperation:'SOURCE_CANARY_INTERRUPTED_OPERATION',tokens:'SOURCE_CANARY_TOKEN_SOURCE'};
  const run=await initialiseRun({output:path.join(base.root,labels.root),challenge:{identity:base.request.challenge,sourceRoot:path.join(base.root,'source'),fileManifest:base.request.challenge.starterInventory.map(([p])=>p),ownerRoots:[OWNER_ROOT],evaluatorRoots:[path.join(OWNER_ROOT,'evaluator')]},toolingIdentity:loadFixture('tooling.identity'),evaluatorIdentity:base.request.evaluator,architectureId:'export-source-privacy',harness:'manual',declaredCeilingMinutes:1,configuration:{model:labels.model},dependencies:{mode:'none'}});
  fs.writeFileSync(path.join(run.workspace.root,labels.inventory),'Synthetic private inventory marker; not a benchmark participant solution.');
  const selection={runRoot:run.output,runId:run.manifest.runId,manifestId:run.manifest.manifestId,expectedDigest:run.manifest.manifestDigest};
  const start=Date.parse('2026-01-02T00:00:00.000Z');
  await startRun({...selection,clock:{now:()=>start},declaration:{harness:'manual',model:labels.model,workerCount:2,executionMode:'MANUAL',declaredCeilingMinutes:1}});
  const attestation={operator:labels.operator,agentStopped:true,statement:labels.statement,observedAt:'2026-01-02T00:00:02.000Z'};
  await stopRun({...selection,clock:{now:()=>start+2000},attestation});
  const frozen=await freezeRun({...selection,attestation});
  const request={...base.request,outputRoot:path.join(base.root,'source-canary-evaluation'),submission:{...selection,snapshotId:frozen.snapshotId,frozenSubmissionId:frozen.frozenSubmission.frozenSubmissionId}};
  const raw=await evaluateWithRuntime(request,base.runtime),evaluation=await attachEvidenceBundle(request,raw,computeEvaluatorIdentity());
  const report=await createReport({reportId:'report-full-source-canary',createdAt:'2026-01-03T00:00:00.000Z',selection:request.submission,evaluation,metrics:{schemaVersion:'1.0.0',kind:'NeutralTokenInput',sourceId:labels.tokens,scope:'RUN_TOTAL',inputIncludesCacheReads:true,inputTokens:20,outputTokens:10,cacheReadTokens:5}});
  const lifecycle=report.provenance.sources.find(s=>s.kind==='lifecycle'),proof=report.provenance.sources.find(s=>s.kind==='snapshot-proof');
  // Exercise schema-permitted history text absent from this normal producer path.
  // This changes only the private in-memory test input, never the frozen run/journal.
  Object.assign(lifecycle.record.history[0],{operator:labels.historyOperator,decision:labels.decision,operatorAttestation:labels.operatorAttestation,interruptedOperation:labels.interruptedOperation});
  // C3 produces only the manual harness. A schema-valid opaque label is a local
  // Report-reader privacy probe, not a claim that C3 authored another harness.
  lifecycle.record.declaration.harness=labels.harness;report.configuration.harness=labels.harness;
  lifecycle.record.stateDigest=lifecycleStateDigestOf(lifecycle.record);lifecycle.digest=digestOf(lifecycle.record);report.reportDigest=reportDigestOf(report);
  const validated=validateReport(report),before=JSON.stringify(validated);
  const physicalBefore=inventoryTree({root:run.output,skipNames:[]}).digest;
  assert.equal(validated.provenance.sources.length,4);assert.equal(validated.measurements.length,13);
  assert.equal(lifecycle.record.declaration.harness,labels.harness);assert.equal(lifecycle.record.declaration.model,labels.model);
  assert.ok(proof.record.snapshotContainer.includes(labels.root));assert.ok(proof.record.snapshotRoot.includes(labels.root));
  assert.ok(proof.record.inventory.some(entry=>entry.path===labels.inventory));
  assert.equal(proof.record.freezeAttestation.operator,labels.operator);assert.equal(proof.record.freezeAttestation.statement,labels.statement);
  for(const canary of Object.values(labels))assert.ok(before.includes(canary),'canary genuinely reaches valid private input: '+canary);
  const projection=createExportProjection(validated),json=renderReportJSON(projection),text=renderReportText(projection);
  for(const canary of [...Object.values(labels),proof.record.snapshotContainer,proof.record.snapshotRoot])for(const output of [json,text]){
    assert.ok(!output.includes(canary),canary);assert.ok(!output.includes(JSON.stringify(canary).slice(1,-1)),canary);
  }
  assert.deepEqual(projection.sources,validated.provenance.sources.map(({kind,digest})=>({kind,digest})));
  assert.deepEqual(projection.quality,validated.quality);assert.equal(projection.identity.bundleDigest,validated.evidence.bundleDigest);
  assert.equal(projection.timing.elapsedMs,2000);assert.equal(projection.configuration.workerCount,2);
  assert.equal(JSON.stringify(validated),before);assert.equal(JSON.stringify(report),before);
  assert.equal(inventoryTree({root:run.output,skipNames:[]}).digest,physicalBefore,'the actual journal, frozen snapshot and original private records are never rewritten by export');
});
