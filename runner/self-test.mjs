import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root, files, sha } from './files.mjs';
export function reviewInputHashes() {
  const targets = new Set();
  const base = path.join(root, 'artifacts/review');
  if (fs.existsSync(base))
    for (const name of fs.readdirSync(base)) {
      const at = path.join(base, name);
      if (!fs.existsSync(path.join(at, 'manifest.json'))) continue;
      const m = JSON.parse(
        fs.readFileSync(path.join(at, 'manifest.json'), 'utf8'),
      );
      for (const e of m.inputs) targets.add(path.join(root, e.source));
      for (const p of files(at, new Set())) targets.add(path.join(at, p));
    }
  return [...targets]
    .sort()
    .map((p) => [p, fs.existsSync(p) ? sha(fs.readFileSync(p)) : null]);
}
export function runSelfTests() {
  const before = reviewInputHashes();
  const tests = files(path.join(root, 'runner/tests'))
    .filter((p) => p.endsWith('.test.mjs'))
    .map((p) => path.join(root, 'runner/tests', p));
  const child = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...tests],
    {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  const after = reviewInputHashes();
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw Error('Self-test mutated reviewed evidence/source inputs');
  console.log(
    `Review-input no-mutation regression: PASS (${before.length} paths)`,
  );
  return child.status ?? 1;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = runSelfTests();
