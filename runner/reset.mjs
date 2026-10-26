import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  root,
  contained,
  rejectLinksTo,
  files,
  assertSnapshot,
} from './files.mjs';
import { createRun } from './create-run.mjs';
import { declaredCeiling } from './ceiling.mjs';
export function resetRun(id) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id))
    throw Error('Invalid run ID');
  assertSnapshot();
  if (fs.existsSync(path.join(root, 'artifacts/runs', id + '-active.json')))
    throw Error('Cannot reset an active run');
  const record = path.join(root, 'artifacts/runs', id + '.json');
  const old = JSON.parse(fs.readFileSync(record));
  const expected = path.resolve(old.base, id);
  if (
    old.runId !== id ||
    path.resolve(old.destination) !== expected ||
    !contained(old.base, expected) ||
    contained(root, expected)
  )
    throw Error('Unsafe registered destination');
  rejectLinksTo(expected);
  if (fs.existsSync(expected)) files(expected, new Set());
  fs.rmSync(expected, { recursive: true, force: true });
  fs.rmSync(record);
  // A reset re-seeds the same logical run and carries its declared ceiling
  // forward; resets are refused once a run is active, so this never changes a
  // ceiling after the official clock has started.
  return createRun(id, old.base, {
    dependencies: old.dependencies,
    timeCeilingMinutes: declaredCeiling(old),
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(JSON.stringify(resetRun(process.argv[2]), null, 2));
