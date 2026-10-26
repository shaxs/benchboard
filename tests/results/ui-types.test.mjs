// Captain-authored real consumer proof; does not trust a declaration-only string scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('S3 UI declarations match and real NodeNext consumers distinguish pending template from completed review',t=>{
  for(const name of ['ui-contract','ui-worksheet']) assert.deepEqual(fs.readFileSync(new URL(`../../packages/results/${name}.d.mts`,import.meta.url)),fs.readFileSync(new URL(`../../packages/results/${name}.d.ts`,import.meta.url)));
  const root=fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(),'bb-ui-types-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const module=fileURLToPath(new URL('../../packages/results/ui-worksheet.mjs',import.meta.url)).replaceAll('\\','/');
  const reportModule=fileURLToPath(new URL('../../packages/results/report.mjs',import.meta.url)).replaceAll('\\','/');
  const consumer=path.join(root,'consumer.mts');
  fs.writeFileSync(consumer,`import {createUIWorksheetTemplate,readUIWorksheet,scoreUIWorksheet} from ${JSON.stringify(module)};
import type {UIWorksheet,UICategory,UIEvidence,UIImprovement} from ${JSON.stringify(module)};
import type {Report} from ${JSON.stringify(reportModule)};
declare const report:Report;
const blank=createUIWorksheetTemplate(report);
const pending:null=blank.scores.polish;
const compared:false=blank.baselineCompared;
// @ts-expect-error A pending template is not completed human review.
const premature:UIWorksheet=blank;
const worksheet:UIWorksheet=readUIWorksheet('{}',report);
const reviewed:true=worksheet.baselineCompared;
const points:number=worksheet.scores.polish;
const result=scoreUIWorksheet(report,worksheet);
const human:number=result.humanUI;
const final:number=result.quality;
const status:'SCORED'=result.status;
const category:UICategory='polish';
const artifact:UIEvidence|undefined=worksheet.evidence[0];
const improvement:UIImprovement|undefined=worksheet.improvements[category];
void [pending,compared,premature,reviewed,points,human,final,status,artifact,improvement];
`);
  const compiler=fileURLToPath(new URL('../../starter/node_modules/typescript/bin/tsc',import.meta.url));
  const result=spawnSync(process.execPath,[compiler,'--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022',consumer],{encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
