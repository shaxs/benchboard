import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './files.mjs';
import { executeCommand } from './supervise.mjs';
// Explicit evidence operation only. Never invoked by self-test; caller names a new output.
export async function recordDeadlineEvidence(output) {
  const at = path.resolve(output);
  if (fs.existsSync(at))
    throw Error('Evidence already exists; never overwrite');
  const result = await executeCommand(
    [process.execPath, '-e', 'setInterval(()=>{},1000)'],
    root,
    { deadlineMs: 600 },
  );
  if (
    result.status !== 'TIME_LIMIT' ||
    !result.validOutcome ||
    !result.processExitObserved
  )
    throw Error('Deadline smoke failed');
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(
    at,
    JSON.stringify(
      { kind: 'DELIBERATE_SHORT_DEADLINE_EVIDENCE_NOT_DSH', ...result },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  return result;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(
    JSON.stringify(await recordDeadlineEvidence(process.argv[2]), null, 2),
  );
