import { chromium } from '@playwright/test';
import { buildTrusted } from './build-trusted.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  root,
  writeSnapshot,
  assertSnapshot,
  files,
  tree,
  contained,
} from '../runner/files.mjs';
import { resolveReferenceUiAcceptance } from '../runner/supervision.mjs';
import { createRun } from '../runner/create-run.mjs';
import { resetRun } from '../runner/reset.mjs';
import { localServer } from './local-server.mjs';
import { browserEvaluate } from './browser.mjs';
import { mutationProbes } from './mutation-probes.mjs';
import { usefulTestsTrusted } from './useful-tests.mjs';
import { inspectPublic } from './collect-evidence.mjs';
import { report, scatter } from './report.mjs';
import { score } from './score.mjs';
import { readiness } from '../runner/readiness.mjs';
const artifacts = path.join(root, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const run = (app, tool, args, label = app) => {
  const p = spawnSync(
    process.execPath,
    [path.join(root, app, 'node_modules', tool), ...args],
    {
      cwd: path.join(root, app),
      encoding: 'utf8',
      timeout: 300000,
      windowsHide: true,
    },
  );
  fs.writeFileSync(
    path.join(artifacts, label + '-' + path.basename(tool) + '-validation.log'),
    (p.stdout || '') + (p.stderr || ''),
  );
  if (p.error) throw p.error;
  return p.status === 0;
};
const visible = (app) => {
  const output = path.join(artifacts, app + '-visible.json');
  run(app, 'vitest/vitest.mjs', [
    'run',
    'tests/contracts.test.tsx',
    '--reporter=json',
    '--outputFile=' + output,
  ]);
  return JSON.parse(fs.readFileSync(output));
};
const resolvedReferenceUi = resolveReferenceUiAcceptance(
  assertSnapshot().reference,
);
const summary = {
  benchmark: JSON.parse(fs.readFileSync(path.join(root, 'version.json')))
    .version,
  kind: 'OWNER_SELF_VALIDATION_NOT_CALIBRATION',
  checks: {},
  trustModel: 'COOPERATIVE_WORKSPACE_NO_ADVERSARIAL_OS_CONTAINMENT',
  referenceUISanity: resolvedReferenceUi.record,
  referenceUISanitySource: resolvedReferenceUi.source,
  referenceUISanityConsidered: resolvedReferenceUi.considered,
  referenceUISanityScope: resolvedReferenceUi.record
    ? 'Owner UI PASS hash-bound to the current reference bytes, resolved by reference hash rather than filename'
    : 'No owner UI PASS is hash-bound to the current reference bytes',
  referenceNumericalUI: 'NOT_APPLICABLE_NOT_A_PARTICIPANT',
  realDSHRuns: 0,
};
const prepared = await Promise.all(
  ['starter', 'reference', 'broken'].map(async (name) => {
    const prior = path.join(artifacts, name + '-build-evidence.json');
    if (process.env.BENCHBOARD_REUSE_BUILDS === '1' && fs.existsSync(prior)) {
      const evidence = JSON.parse(fs.readFileSync(prior));
      const expected =
        name === 'broken'
          ? path.join(artifacts, 'broken-source')
          : path.join(root, name);
      if (
        evidence.app === expected &&
        evidence.typecheck &&
        evidence.build &&
        fs.existsSync(expected) &&
        evidence.sourceHash === tree(expected).hash
      )
        return { ...evidence, reusedMatchingSource: true };
    }
    return buildTrusted(name);
  }),
);
const builds = Object.fromEntries(
  prepared.map((b, i) => [['starter', 'reference', 'broken'][i], b]),
);
for (const app of ['starter', 'reference']) {
  const { typecheck, build } = builds[app];
  assert.equal(builds[app].sourceHash, tree(path.join(root, app)).hash);
  assert.ok(typecheck && build);
  const tests = visible(app);
  if (app === 'reference') {
    assert.equal(tests.numPassedTests, 17);
    assert.equal(tests.numFailedTests, 0);
  } else {
    assert.equal(tests.numTotalTests, 17);
    assert.ok(tests.numFailedTests > 0);
  }
  const server = await localServer(path.join(root, app));
  let hidden;
  try {
    hidden = await browserEvaluate(
      server.url,
      path.join(artifacts, app + '-browser'),
    );
  } finally {
    server.close();
  }
  if (app === 'reference')
    assert.equal(hidden.filter((t) => t.passed).length, 25);
  const usefulTests =
    app === 'reference'
      ? usefulTestsTrusted(
          path.join(root, app),
          path.join(artifacts, 'reference-useful'),
        )
      : { addedCount: 0, baselinePassed: false, killedMutations: [] };
  if (app === 'reference')
    fs.writeFileSync(
      path.join(artifacts, 'reference-useful/summary.json'),
      JSON.stringify(usefulTests, null, 2),
    );
  const evidence = {
    visiblePassed: tests.numPassedTests,
    hidden,
    typecheck,
    build,
    usefulTests,
    ...inspectPublic(path.join(root, app)),
  };
  const result = report({ evidence }, path.join(artifacts, app + '-report'));
  if (app === 'reference') {
    result.referenceUISanity = summary.referenceUISanity;
    result.quality.status = 'REFERENCE_NOT_A_BENCHMARK_PARTICIPANT';
    fs.writeFileSync(
      path.join(artifacts, 'reference-report/report.json'),
      JSON.stringify(result, null, 2),
    );
    const textPath = path.join(artifacts, 'reference-report/report.txt');
    fs.writeFileSync(
      textPath,
      fs
        .readFileSync(textPath, 'utf8')
        .replace(
          /Quality: .*\/ 100/,
          'Quality: NOT APPLICABLE - reference is not a participant',
        )
        .replace(/UI: .*\/ 20/, 'UI: NO NUMERICAL REFERENCE SCORE'),
    );
  }

  summary.checks[app] = {
    typecheck,
    build,
    visiblePassed: tests.numPassedTests,
    visibleFailed: tests.numFailedTests,
    hiddenPassed: hidden.filter((t) => t.passed).length,
    automated: result.quality.automated,
  };
  assert.deepEqual(score(evidence), score(evidence));
  if (app === 'reference') {
    assert.equal(result.quality.automated, 80);
    const second = await localServer(path.join(root, app));
    try {
      const repeat = await browserEvaluate(
        second.url,
        path.join(artifacts, 'reference-repeat'),
      );
      assert.deepEqual(
        repeat.map((t) => [t.id, t.passed]),
        hidden.map((t) => [t.id, t.passed]),
      );
      assert.equal(
        score({ ...evidence, hidden: repeat }).automated,
        result.quality.automated,
      );
    } finally {
      second.close();
    }
  }
}
// Owner workload measurements must finish before probes temporarily mutate reference source.
const measurementDeadline = Date.now() + 600000;
while (!fs.existsSync(path.join(artifacts, 'workload/score-floors.json'))) {
  if (Date.now() > measurementDeadline)
    throw Error('Run workload-evidence first');
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const probes = await mutationProbes();
assert.ok(probes.every((p) => p.detected));
summary.checks.seededDefectsDetected = probes.length;
// Independent broken public-source fixture stays owner-only and never alters reference.
const brokenApp = builds.broken.app;
assert.equal(tree(brokenApp).hash, builds.broken.sourceHash);
const brokenTests = path.join(artifacts, 'broken-visible.json');
const brokenRun = spawnSync(
  process.execPath,
  [
    path.join(brokenApp, 'node_modules/vitest/vitest.mjs'),
    'run',
    'tests/contracts.test.tsx',
    '--reporter=json',
    '--outputFile=' + brokenTests,
  ],
  { cwd: brokenApp, encoding: 'utf8', timeout: 60000, windowsHide: true },
);
if (brokenRun.error) throw brokenRun.error;
const brokenVisible = JSON.parse(fs.readFileSync(brokenTests)).numPassedTests;
const brokenServer = await localServer(brokenApp);
let broken;
try {
  broken = await browserEvaluate(
    brokenServer.url,
    path.join(artifacts, 'broken-browser'),
  );
} finally {
  brokenServer.close();
}
const brokenEvidence = {
  visiblePassed: brokenVisible,
  hidden: broken,
  typecheck: builds.broken.typecheck,
  build: builds.broken.build,
  usefulTests: null,
  ...inspectPublic(brokenApp),
};
const brokenResult = report(
  { evidence: brokenEvidence },
  path.join(artifacts, 'broken-report'),
);
assert.ok(brokenResult.quality.automated < 30);
summary.checks.brokenAutomated = brokenResult.quality.automated;
summary.checks.broken = {
  typecheck: builds.broken.typecheck,
  build: builds.broken.build,
  visiblePassed: brokenVisible,
  hiddenPassed: broken.filter((t) => t.passed).length,
};
writeSnapshot();
const id = 'bb-owner-self-validation-candidate5';
const base = path.resolve(root, '../BenchBoard-Validation');
const record = path.join(artifacts, 'runs', id + '.json');
const m = fs.existsSync(record)
  ? resetRun(id)
  : createRun(id, base, { timeCeilingMinutes: 75 });
assert.equal(m.publicHash, tree(path.join(root, 'starter')).hash);
const names = files(m.destination);
assert.ok(
  !names.some((p) =>
    /hidden|reference|evaluator|SCORING|BENCHMARK|DESIGN/.test(p),
  ),
);
const publicText = names
  .filter((p) => /\.(tsx?|mjs|md|json)$/.test(p))
  .map((p) => fs.readFileSync(path.join(m.destination, p), 'utf8'))
  .join('\n');
assert.ok(
  !/defectWitnesses|formattedChronology|CALIBRATION_PENDING|PRIVATE benchmark/.test(
    publicText,
  ),
);
fs.writeFileSync(
  path.join(m.destination, 'previous-output.txt'),
  'must not survive',
);
const reset = resetRun(id);
assert.equal(reset.publicHash, m.publicHash);
assert.ok(!fs.existsSync(path.join(m.destination, 'previous-output.txt')));
summary.checks.publicExport = {
  publicHash: m.publicHash,
  files: names.length,
  privateLeaks: 0,
  resetIdentical: true,
};
// npm --offline guarantees registry network is forbidden; use clean disposable public-only dependency install.
const offline = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-offline-'));
try {
  for (const p of ['package.json', 'package-lock.json'])
    fs.copyFileSync(path.join(root, 'starter', p), path.join(offline, p));
  const npmCli =
    process.env.npm_execpath ||
    path.join(
      path.dirname(process.execPath),
      'node_modules/npm/bin/npm-cli.js',
    );
  const p = spawnSync(
    process.execPath,
    [npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: offline, encoding: 'utf8', timeout: 120000, windowsHide: true },
  );
  fs.writeFileSync(
    path.join(artifacts, 'offline-install.log'),
    (p.stdout || '') + (p.stderr || ''),
  );
  assert.equal(p.status, 0);
  summary.checks.offlineDependencyInstall = true;
} finally {
  if (contained(os.tmpdir(), offline))
    fs.rmSync(offline, { recursive: true, force: true });
}
const server = await localServer(m.destination);
try {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.locator('[data-issue-id]').first().waitFor();
    assert.equal(await page.locator('[data-issue-id]').count(), 18);
  } finally {
    await browser.close();
  }
  summary.checks.generatedStarterRuns = true;
} finally {
  server.close();
}
summary.READY_FOR_CALIBRATION = readiness(
  null,
  null,
  null,
  null,
).READY_FOR_CALIBRATION;
fs.writeFileSync(
  path.join(artifacts, 'self-validation.json'),
  JSON.stringify(summary, null, 2),
);
scatter([], path.join(artifacts, 'comparisons.html'));
console.log(JSON.stringify(summary, null, 2));
