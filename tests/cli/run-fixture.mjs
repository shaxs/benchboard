// Test-owned ordinary source and run. Real installed identities; no browser, install or agent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadInstallation } from '../../cli/installation.mjs';
import { prepareChallengeSource } from '../../cli/challenge-source.mjs';
import { initialiseRun } from '../../packages/core/init.mjs';
import { createId } from '../../packages/core/identity.mjs';
import { openSelectedRun } from '../../cli/run-context.mjs';

export async function realRunFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-cli-boundary '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 }));
  const installation = loadInstallation(), prepared = prepareChallengeSource(installation);
  let run;
  try {
    run = await initialiseRun({ output: path.join(root, 'selected run'),
      challenge: { ...installation.challenge, sourceRoot: prepared.sourceRoot },
      toolingIdentity: installation.toolingIdentity, evaluatorIdentity: installation.evaluatorIdentity,
      architectureId: createId('architecture'), harness: 'manual', dependencies: { mode: 'none' },
      configuration: { model: 'synthetic-explicit-model' } });
  } finally { prepared.dispose(); }
  return { root, installation, run, opened: await openSelectedRun(run.output) };
}
