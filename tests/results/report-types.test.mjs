// Independent Captain acceptance: declaration pairs and real consumer, no emitted files/install.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('integrated report and measurement modules have byte-identical declaration pairs', () => {
  for (const name of ['report', 'report-contract', 'report-context', 'measurement-contract', 'measurement-context', 'measurements', 'input-contract', 'compatibility', 'ui-validation', 'reviewed-report']) {
    assert.deepEqual(fs.readFileSync(new URL(`../../packages/results/${name}.d.mts`, import.meta.url)), fs.readFileSync(new URL(`../../packages/results/${name}.d.ts`, import.meta.url)));
  }
});
test('S1 real NodeNext consumer typechecks report status/nullability against shipped imports', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-report-types-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modulePath = fileURLToPath(new URL('../../packages/results/report.mjs', import.meta.url)).replaceAll('\\', '/');
  const contractPath = fileURLToPath(new URL('../../packages/results/report-contract.mjs', import.meta.url)).replaceAll('\\', '/');
  const consumer = path.join(root, 'consumer.mts');
  fs.writeFileSync(consumer, `import {createReport,readReport} from ${JSON.stringify(modulePath)};
import {reportDigestOf} from ${JSON.stringify(contractPath)};
import type {Report,ReportRequest} from ${JSON.stringify(modulePath)};
const withTokens = (request:ReportRequest) => createReport({...request,metrics:{schemaVersion:'1.0.0',kind:'NeutralTokenInput',sourceId:'synthetic-token-source',scope:'RUN_TOTAL',inputIncludesCacheReads:true,inputTokens:0,outputTokens:null,cacheReadTokens:null}});
const wrongTokenSemantics:ReportRequest['metrics']={schemaVersion:'1.0.0',kind:'NeutralTokenInput',sourceId:'synthetic-token-source',scope:'RUN_TOTAL',
// @ts-expect-error Ambiguous cache-excluding input is not the supported contract.
inputIncludesCacheReads:false,inputTokens:0,outputTokens:0,cacheReadTokens:0};
const unsignedDigest = (draft: Omit<Report,'reportDigest'>): string => reportDigestOf(draft);
const consume = (r: Report) => {
  const outcome: null = r.execution.agentOutcome;
  const enforcement: false = r.execution.enforced;
  const trust: 'LOCAL_SELF_ASSESSMENT' = r.execution.assessmentTrust;
  const actual: string | undefined = r.actualEvaluator?.semanticDigest;
  const points: number | undefined = r.quality?.automated;
  const pending: number | null | undefined = r.quality?.humanUI;
  const measurement:number|null|undefined=r.measurements[0]?.value;
  const sourceKind:'lifecycle'|'snapshot-proof'|'token-input'|'evaluation'|undefined=r.provenance.sources[0]?.kind;
  void [outcome,enforcement,trust,actual,points,pending,measurement,sourceKind];
};
void createReport; void unsignedDigest; void withTokens; void wrongTokenSemantics; consume(readReport('{}'));
`);
  const compiler = fileURLToPath(new URL('../../starter/node_modules/typescript/bin/tsc', import.meta.url));
  const result = spawnSync(process.execPath, [compiler, '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', consumer], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
