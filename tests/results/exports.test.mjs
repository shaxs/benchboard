// Captain semantic equivalence/canary acceptance tests for both worker renderers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createExportProjection,ExportIntegrityError} from '../../packages/results/export-contract.mjs';
import {renderReportJSON,renderReportText} from '../../packages/results/exports.mjs';
import {privateExportFixture,PRIVATE_CANARIES} from './export-fixture.mjs';
import {createReport} from '../../packages/results/report.mjs';
test('S5 JSON/text render the identical validated projection, including all nulls, hashes, statuses and provenance',async t=>{
  const f=await privateExportFixture(t),failure=await createReport({...f.input,evaluation:{status:'infrastructure-error',evaluationId:null,bundle:null,evidence:null,score:null,error:{code:'TIMEOUT'}}});
  for(const input of [f.parent,f.child,f.report,failure]){
    const p=createExportProjection(input),before=JSON.stringify(p),json=renderReportJSON(p),text=renderReportText(p);
    assert.deepEqual(JSON.parse(json),p);assert.equal(JSON.stringify(p),before);
    const leaves=[];const visit=(v,key='')=>{if(v!==null&&typeof v==='object'){if(Object.keys(v).length===0)leaves.push([key,Array.isArray(v)?'[]':'{}']);else for(const [k,x]of Object.entries(v))visit(x,key?key+'.'+k:k);}else leaves.push([key,JSON.stringify(v)]);};visit(p);
    for(const [key,value]of leaves)assert.ok(text.includes(`${key}: ${value}\n`),key);
    for(const canary of PRIVATE_CANARIES)for(const rendered of [json,text])assert.ok(!rendered.includes(canary),canary);
    assert.match(text,/Local self-assessment; not certified; manual stopping is not enforced/);
    assert.equal(renderReportText(p),text);assert.equal(renderReportJSON(p),json);
  }
});
test('S5 neither renderer accepts a raw Report or a projection with private extra content',async t=>{
  const f=await privateExportFixture(t),p=createExportProjection(f.child);
  for(const render of [renderReportJSON,renderReportText])for(const raw of [f.child,{...p,logs:PRIVATE_CANARIES[3]}])assert.throws(()=>render(raw),e=>e instanceof ExportIntegrityError);
});
