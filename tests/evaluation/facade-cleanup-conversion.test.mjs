// Captain carried facade catch regression. Module-loader hooks exist only in an
// isolated diagnostic child; no public runtime/collaborator injection is added.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createFrozenFixture,snapshotInputs,assertInputsUnchanged} from './helpers.mjs';

test('S8 real facade attachment catch converts CLEANUP_FAILED only and preserves thrown integrity/refusal/unknown errors',async t=>{
  const f=await createFrozenFixture(t),before=snapshotInputs(f),requestFile=path.join(f.root,'facade-request.json'),childFile=path.join(f.root,'facade-catch-probe.mjs');
  const url=name=>new URL(`../../packages/evaluation/${name}.mjs`,import.meta.url).href;
  fs.writeFileSync(requestFile,JSON.stringify(f.request));
  fs.writeFileSync(childFile,`import assert from 'node:assert/strict';
import fs from 'node:fs';
import {registerHooks} from 'node:module';
import {EvaluationInfrastructureError,EvaluationRefusalError} from ${JSON.stringify(url('contracts'))};
import {EvaluationIntegrityError} from ${JSON.stringify(url('bundle-contract'))};
const facadeURL=${JSON.stringify(url('evaluate-frozen'))};
const request=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const controlled={status:'success',evaluationId:'eval-facade-catch',evidence:{synthetic:true},score:null,snapshot:{before:'a'.repeat(64),after:'a'.repeat(64),workspaceMatchesFrozen:true},cleanup:{removed:false,residue:['synthetic-residue'],errors:[]},artifacts:['synthetic-evidence.json']};
globalThis.__facadeCatchResult=controlled;
let controllerCalls=0,attachmentCalls=0;
globalThis.__facadeControllerCall=()=>{controllerCalls++;return structuredClone(controlled);};
globalThis.__facadeAttachmentCall=()=>{attachmentCalls++;throw globalThis.__facadeCatchError;};
registerHooks({resolve(specifier,context,next){
  if(context.parentURL===facadeURL&&specifier==='./controller.mjs')return {url:'data:text/javascript,'+encodeURIComponent('export async function evaluateWithRuntime(){return globalThis.__facadeControllerCall();}'),shortCircuit:true};
  if(context.parentURL===facadeURL&&specifier==='./bundle-runtime.mjs')return {url:'data:text/javascript,'+encodeURIComponent('export async function attachEvidenceBundle(){return globalThis.__facadeAttachmentCall();}'),shortCircuit:true};
  return next(specifier,context);
}});
const facade=await import(facadeURL);assert.deepEqual(Object.keys(facade),['evaluateFrozen']);
const infrastructure=new EvaluationInfrastructureError('cleanup','CLEANUP_FAILED','Synthetic cleanup failure',{synthetic:true});
globalThis.__facadeCatchError=infrastructure;
const converted=await facade.evaluateFrozen(request);
assert.equal(converted.status,'infrastructure-error');assert.equal(converted.evaluationId,controlled.evaluationId);
for(const key of ['bundle','evidence','score'])assert.equal(converted[key],null);
assert.equal(converted.error.code,'CLEANUP_FAILED');assert.equal(converted.error.stage,'cleanup');assert.deepEqual(converted.error.details,{synthetic:true});
assert.equal(converted.error.message,infrastructure.message);
for(const key of ['snapshot','cleanup','artifacts'])assert.deepEqual(converted[key],controlled[key]);
for(const error of [new EvaluationIntegrityError('Synthetic integrity refusal'),new EvaluationRefusalError('IDENTITY_MISMATCH','Synthetic safety refusal'),new Error('Synthetic unknown error')]){
  globalThis.__facadeCatchError=error;await assert.rejects(()=>facade.evaluateFrozen(request),actual=>actual===error);
}
assert.equal(controllerCalls,4);assert.equal(attachmentCalls,4);
await assert.rejects(()=>facade.evaluateFrozen({...request,runtime:{}}),e=>e instanceof EvaluationRefusalError);assert.equal(controllerCalls,4);
console.log('Facade catch proof: CLEANUP_FAILED converts to infrastructure/no bundle/evidence/points; integrity/refusal/unknown errors retain identity; public injection refused.');
`);
  const result=spawnSync(process.execPath,[childFile,requestFile],{encoding:'utf8',timeout:60000,windowsHide:true});assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/CLEANUP_FAILED converts/);assert.equal(fs.existsSync(f.request.outputRoot),false);assertInputsUnchanged(f,before);
  console.log(result.stdout.trim());
});
