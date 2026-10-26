import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
test('S5 privacy contract declarations are identical twins with a real strict consumer',t=>{
  const url=new URL('../../packages/results/export-contract.mjs',import.meta.url),mod=fileURLToPath(url).replaceAll('\\','/');
  assert.deepEqual(fs.readFileSync(new URL('../../packages/results/export-contract.d.mts',import.meta.url)),fs.readFileSync(new URL('../../packages/results/export-contract.d.ts',import.meta.url)));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bb-export-types-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const consumer=path.join(root,'consumer.mts');fs.writeFileSync(consumer,`import {createExportProjection,validateExportProjection,ExportIntegrityError} from ${JSON.stringify(mod)};
import type {ExportProjection} from ${JSON.stringify(mod)};
const p:ExportProjection=createExportProjection({});const checked:ExportProjection=validateExportProjection(p);
const family:'REPORT'=p.family;const agent:null=p.execution.agentOutcome;const enforced:false=p.execution.enforced;
const points:number|null=p.quality?.humanUI??null;const semantic:string|null=p.actualEvaluator?.semanticDigest??null;
const reviewer:string|null=p.review?.reviewerRef??null;const source:string|null=p.measurements[0]?.procedureCode??null;
const code:'EXPORT_INTEGRITY'=new ExportIntegrityError().code;
// @ts-expect-error Raw private Report/evidence is deliberately absent.
p.evidence.bundle;
// @ts-expect-error Raw reviewer name is absent.
p.review?.reviewer;
// @ts-expect-error No free text index signature.
p.logs;
void [checked,family,agent,enforced,points,semantic,reviewer,source,code];`);
  const compiler=fileURLToPath(new URL('../../starter/node_modules/typescript/bin/tsc',import.meta.url));
  const result=spawnSync(process.execPath,[compiler,'--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022',consumer],{encoding:'utf8',timeout:30000,windowsHide:true});assert.equal(result.status,0,result.stdout+result.stderr);
  // Independently prove that the private properties really are absent, without directives.
  fs.writeFileSync(consumer,fs.readFileSync(consumer,'utf8').replace(/^\s*\/\/ @ts-expect-error[^\n]*\n/gm,''));
  const negative=spawnSync(process.execPath,[compiler,'--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022',consumer],{encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(negative.status,2,negative.stdout+negative.stderr);
  for(const name of ['evidence','reviewer','logs'])assert.match(negative.stdout+negative.stderr,new RegExp("TS2339: Property '"+name+"' does not exist"));
});
