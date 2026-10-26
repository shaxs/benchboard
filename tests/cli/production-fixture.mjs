// Captain-owned setup for real CLI production failure proofs. No runtime injection or agent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { openSelectedRun, readResultsContext } from '../../cli/run-context.mjs';
import { readEvaluationAttempts } from '../../cli/attempt-records.mjs';

export const PRODUCTION_REPO = fileURLToPath(new URL('../../', import.meta.url));
export const PRODUCTION_CLI = path.join(PRODUCTION_REPO, 'cli/benchboard.mjs');
export function invokeProduction(root, argv, { entrypoint = PRODUCTION_CLI, env = process.env, timeout = 30000 } = {}) {
  const result = spawnSync(process.execPath, [entrypoint, ...argv], {
    cwd: root, env, encoding: 'utf8', shell: false, windowsHide: true,
    timeout, maxBuffer: 1048576,
  });
  assert.equal(result.error, undefined, 'a test child must complete inside its explicit bound');
  return result;
}
export function successSummary(result) {
  assert.equal(result.status, 0, `real CLI refused: ${result.stderr}`);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
}
export async function createProductionRun(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb CLI production failure '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 }));
  const runRoot = path.join(root, 'run container');
  const init = successSummary(invokeProduction(root, ['init', '--output', runRoot, '--dependency-mode', 'none']));
  const frozen = successSummary(invokeProduction(root, ['freeze', '--run', runRoot, '--clockless',
    '--operator', 'synthetic production proof operator', '--agents-stopped']));
  assert.equal(init.workloadFileCount, 26);
  assert.equal(frozen.state, 'FROZEN');
  const opened = await openSelectedRun(runRoot);
  return { root, runRoot, init, frozen, opened };
}
export function productionInputs(f) {
  return Object.fromEntries([['workspace', f.init.workspaceRoot], ['snapshots', path.join(f.runRoot, 'snapshots')],
    ['canonicalStarter', path.join(PRODUCTION_REPO, 'starter')]].map(([label, root]) =>
    [label, inventoryTree({ root }).entries]));
}
export async function productionAttempt(f) {
  const opened = await openSelectedRun(f.runRoot), context = await readResultsContext(opened);
  assert.ok(context, 'actual evaluate must have created its verified results binding');
  const attempts = await readEvaluationAttempts(opened, context);
  assert.equal(attempts.length, 1);
  return { opened, context, attempt: attempts[0] };
}
