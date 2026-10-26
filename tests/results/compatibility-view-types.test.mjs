// Captain R1-F2: original private reader/classifier types are part of the whole S6 boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
test('S6 original reader/classifier twins and real narrowed positive/negative consumers enforce non-promotion',t=>{
  for(const name of ['compatibility','input-contract'])assert.deepEqual(fs.readFileSync(new URL(`../../packages/results/${name}.d.mts`,import.meta.url)),fs.readFileSync(new URL(`../../packages/results/${name}.d.ts`,import.meta.url)));
  const mod=name=>fileURLToPath(new URL(`../../packages/results/${name}.mjs`,import.meta.url)).replaceAll('\\','/');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bb-compatibility-view-types-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'consumer.mts'),compiler=fileURLToPath(new URL('../../starter/node_modules/typescript/bin/tsc',import.meta.url));
  const run=()=>spawnSync(process.execPath,[compiler,'--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022',file],{encoding:'utf8',timeout:30000,windowsHide:true});
  fs.writeFileSync(file,`import {readCompatibilityInput} from ${JSON.stringify(mod('compatibility'))};
import type {CompatibilityView} from ${JSON.stringify(mod('compatibility'))};
import {classifyResultInput,ResultInputError} from ${JSON.stringify(mod('input-contract'))};
import type {ClassifiedInput} from ${JSON.stringify(mod('input-contract'))};
declare const raw:unknown;const view:CompatibilityView=readCompatibilityInput(raw);const classified:ClassifiedInput=classifyResultInput(raw);
if(view.family==='REPORT'){const trust:'LOCAL_SELF_ASSESSMENT'=view.assessmentTrust;const kind:'Report'=view.record.kind;const outcome:null=view.record.execution.agentOutcome;void [trust,kind,outcome];}
if(view.family==='C1_RESULT'){const evidence:false=view.currentEvidence;const review:'NOT_REVIEWED'=view.currentHumanReview;const kind:'Result'=view.record.kind;void [evidence,review,kind];}
if(view.family==='LEGACY'){const evidence:false=view.currentEvidence;const review:'NOT_REVIEWED'=view.currentHumanReview;const promotion:false=view.record.promotionAllowed;void [evidence,review,promotion];}
if(classified.family==='REPORT'){const kind:'Report'=classified.record.kind;void kind;}
if(classified.family==='C1_RESULT'){const kind:'Result'=classified.record.kind;void kind;}
if(classified.family==='LEGACY'){const promotion:false=classified.record.promotionAllowed;void promotion;}
const code:'RESULT_INPUT_INVALID'=new ResultInputError('synthetic type-only error').code;void code;
`);
  const positive=run();assert.equal(positive.status,0,positive.stdout+positive.stderr);
  fs.appendFileSync(file,`declare const legacy:Extract<CompatibilityView,{readonly family:'LEGACY'}>;
const promoted:'SCORED'=legacy.currentHumanReview;
classified.nonexistent;
`);
  const negative=run();assert.equal(negative.status,2,negative.stdout+negative.stderr);
  assert.match(negative.stdout+negative.stderr,/TS2322: Type '"NOT_REVIEWED"' is not assignable to type '"SCORED"'/);
  assert.match(negative.stdout+negative.stderr,/TS2339: Property 'nonexistent' does not exist/);
});
