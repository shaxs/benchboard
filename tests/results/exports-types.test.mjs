import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
test('S5 renderer declaration twins and a real production-only API consumer agree',t=>{
  assert.deepEqual(fs.readFileSync(new URL('../../packages/results/exports.d.mts',import.meta.url)),fs.readFileSync(new URL('../../packages/results/exports.d.ts',import.meta.url)));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bb-renderer-types-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const mod=fileURLToPath(new URL('../../packages/results/exports.mjs',import.meta.url)).replaceAll('\\','/');
  const consumer=path.join(root,'consumer.mts');
  fs.writeFileSync(consumer,`import {renderReportJSON,renderReportText} from ${JSON.stringify(mod)};
declare const projection:unknown;
const json:string=renderReportJSON(projection);
const text:string=renderReportText(projection);
// @ts-expect-error Public renderers never accept extra options.
renderReportJSON(projection,{});
// @ts-expect-error Public renderers never accept extra options.
renderReportText(projection,{});
void [json,text];
`);
  const compiler=fileURLToPath(new URL('../../starter/node_modules/typescript/bin/tsc',import.meta.url));
  const result=spawnSync(process.execPath,[compiler,'--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022',consumer],{encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
