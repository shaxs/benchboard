import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { root, tree } from '../runner/files.mjs';
import { localServer } from './local-server.mjs';
import { browserEvaluate } from './browser.mjs';
import { inspectPublic } from './collect-evidence.mjs';
import { score } from './score.mjs';
const directory = path.join(root, 'artifacts/workload');
const configurations = [
  ['visible-only', 'candidate4-visible-only'],
  ['seeded-only', 'candidate4-seeded-only'],
  ['complete-no-added-tests', 'candidate4-complete-no-added-tests'],
  ['presentation', 'candidate4-equivalent-presentation'],
];
const run = (app, tool, args, label) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(app, 'node_modules', tool), ...args],
      { cwd: app, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let logs = '';
    child.stdout.on('data', (d) => (logs += d));
    child.stderr.on('data', (d) => (logs += d));
    child.on('error', reject);
    const timeout = setTimeout(() => {
      child.kill();
      reject(Error('Owner witness timeout'));
    }, 300000);
    child.on('close', (code) => {
      clearTimeout(timeout);
      fs.writeFileSync(
        path.join(directory, label + '-' + path.basename(tool) + '.log'),
        logs,
      );
      resolve(code === 0);
    });
  });
const rows = await Promise.all(
  configurations.map(async ([name, folder]) => {
    const app = path.join(root, 'artifacts/evaluations', folder);
    fs.copyFileSync(
      path.join(root, 'starter/tests/contracts.test.tsx'),
      path.join(app, 'tests/contracts.test.tsx'),
    );
    const before = tree(app).hash;
    const typecheck = await run(app, 'typescript/bin/tsc', ['--noEmit'], name);
    const build = await run(app, 'vite/bin/vite.js', ['build'], name);
    assert.ok(typecheck && build, name + ' canonical tooling');
    const output = path.join(directory, name + '-visible.json');
    await run(
      app,
      'vitest/vitest.mjs',
      [
        'run',
        'tests/contracts.test.tsx',
        '--reporter=json',
        '--outputFile=' + output,
      ],
      name,
    );
    const tests = JSON.parse(fs.readFileSync(output));
    const server = await localServer(app);
    let hidden;
    try {
      hidden = await browserEvaluate(
        server.url,
        name === 'presentation'
          ? path.join(root, 'artifacts/presentation-witness')
          : path.join(directory, name + '-browser'),
      );
    } finally {
      server.close();
    }
    assert.equal(tree(app).hash, before);
    const evidence = {
      visiblePassed: tests.numPassedTests,
      hidden,
      typecheck,
      build,
      usefulTests: null,
      ...inspectPublic(app),
    };
    const row = {
      name,
      sourceHash: before,
      typecheck,
      build,
      visiblePassed: tests.numPassedTests,
      visibleFailed: tests.numFailedTests,
      hiddenPassed: hidden.filter((t) => t.passed).length,
      evidence,
      score: score(evidence),
      humanUI: 'UNASSIGNED',
    };
    if (name === 'complete-no-added-tests') {
      assert.ok(!fs.existsSync(path.join(app, 'tests/regressions.test.tsx')));
      row.removedFiles = ['tests/regressions.test.tsx'];
      assert.equal(row.score.automated, 75);
      fs.writeFileSync(
        path.join(directory, 'complete-no-added-tests-evidence.json'),
        JSON.stringify(row, null, 2),
      );
    }
    if (name === 'presentation') {
      assert.equal(row.visiblePassed, 17);
      assert.equal(row.hiddenPassed, 25);
      const at = path.join(root, 'artifacts/presentation-witness/summary.json'),
        summary = JSON.parse(fs.readFileSync(at));
      Object.assign(summary, {
        sourceHash: before,
        visiblePassed: row.visiblePassed,
        typecheck,
        build,
        passed: row.hiddenPassed,
      });
      fs.writeFileSync(at, JSON.stringify(summary, null, 2));
    }
    console.log(name, row.visiblePassed, row.hiddenPassed, row.score.automated);
    return row;
  }),
);
const at = path.join(directory, 'score-floors.json'),
  floors = JSON.parse(fs.readFileSync(at));
floors.variants = floors.variants.map(
  (old) => rows.find((r) => r.name === old.name) || old,
);
fs.writeFileSync(at, JSON.stringify(floors, null, 2));
