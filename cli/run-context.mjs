// Bootstrap only identities from bounded bytes; accepted C1/C3 APIs re-verify authority.
import path from 'node:path';
import { validateRecord } from '../packages/core/manifest.mjs';
import { openRun } from '../packages/core/lifecycle.mjs';
import { externalRoot, readOrdinaryJson, rejectIntegrity } from './filesystem.mjs';
export async function openSelectedRun(input) {
  const runRoot = externalRoot(input);
  const envelope = readOrdinaryJson(path.join(runRoot, '.benchboard', 'state', 'run.json'));
  const manifest = validateRecord('RunManifest', envelope?.value);
  const request = Object.freeze({ runRoot, runId: manifest.runId, manifestId: manifest.manifestId, expectedDigest: manifest.manifestDigest });
  const opened = await openRun(request);
  if (opened.workspaceRoot !== path.join(runRoot, 'workspace') || opened.stateRoot !== path.join(runRoot, '.benchboard')) rejectIntegrity();
  return Object.freeze({ ...opened, request });
}
export { readResultsContext, ensureResultsContext } from './results-context.mjs';
