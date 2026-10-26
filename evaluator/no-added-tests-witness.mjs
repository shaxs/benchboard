import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { root, files, tree } from '../runner/files.mjs';
import { localServer } from './local-server.mjs';
import { browserEvaluate } from './browser.mjs';
import { inspectPublic } from './collect-evidence.mjs';
import { usefulTestsCooperative } from './useful-tests.mjs';
import { score } from './score.mjs';
const source = path.join(root, 'reference'),
  app = path.join(
    root,
    'artifacts/evaluations/candidate4-complete-no-added-tests',
  );
if (fs.existsSync(app)) throw Error('Use a fresh owner-only witness');
for (const file of files(source).filter(
  (f) => f !== 'tests/regressions.test.tsx',
)) {
  fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
  fs.copyFileSync(path.join(source, file), path.join(app, file));
}
fs.cpSync(path.join(source, 'node_modules'), path.join(app, 'node_modules'), {
  recursive: true,
});
const before = tree(app).hash;
const run = (tool, args) =>
  spawnSync(process.execPath, [path.join(app, 'node_modules', tool), ...args], {
    cwd: app,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300000,
  });
const typecheck = run('typescript/bin/tsc', ['--noEmit']).status === 0;
const build = run('vite/bin/vite.js', ['build']).status === 0;
assert.ok(typecheck && build);
const output = path.join(
  root,
  'artifacts/workload/complete-no-added-tests-visible.json',
);
run('vitest/vitest.mjs', [
  'run',
  'tests/contracts.test.tsx',
  '--reporter=json',
  '--outputFile=' + output,
]);
const tests = JSON.parse(fs.readFileSync(output));
const server = await localServer(app);
let hidden;
try {
  hidden = await browserEvaluate(
    server.url,
    path.join(root, 'artifacts/workload/complete-no-added-tests-browser'),
  );
} finally {
  server.close();
}
const usefulTests = usefulTestsCooperative(
  app,
  path.join(root, 'artifacts/workload/no-added-useful'),
);
const evidence = {
  visiblePassed: tests.numPassedTests,
  hidden,
  typecheck,
  build,
  usefulTests,
  ...inspectPublic(app),
};
const row = {
  name: 'complete-no-added-tests',
  sourceHash: before,
  removedFiles: ['tests/regressions.test.tsx'],
  typecheck,
  build,
  visiblePassed: tests.numPassedTests,
  visibleFailed: tests.numFailedTests,
  hiddenPassed: hidden.filter((t) => t.passed).length,
  evidence,
  score: score(evidence),
  humanUI: 'UNASSIGNED',
};
assert.equal(tree(app).hash, before);
assert.equal(row.score.automated, 75);
fs.writeFileSync(
  path.join(root, 'artifacts/workload/complete-no-added-tests-evidence.json'),
  JSON.stringify(row, null, 2),
);
const report = path.join(root, 'artifacts/workload/score-floors.json');
const until = Date.now() + 600000;
while (!fs.existsSync(report)) {
  if (Date.now() > until) throw Error('Missing score-floor measurement');
  await new Promise((r) => setTimeout(r, 1000));
}
const floors = JSON.parse(fs.readFileSync(report));
floors.variants = floors.variants.map((r) => (r.name === row.name ? row : r));
fs.writeFileSync(report, JSON.stringify(floors, null, 2));
console.log(
  JSON.stringify({
    name: row.name,
    visible: row.visiblePassed,
    hidden: row.hiddenPassed,
    automated: row.score.automated,
    sourceHash: before,
  }),
);
