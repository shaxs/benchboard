import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, files, tree, sha } from '../runner/files.mjs';
import { localServer } from './local-server.mjs';
import { browserEvaluate } from './browser.mjs';
import { inspectPublic } from './collect-evidence.mjs';
import { usefulTestsTrusted } from './useful-tests.mjs';
import { score } from './score.mjs';

const destination = path.join(root, 'artifacts/workload');
fs.mkdirSync(destination, { recursive: true });
const text = (app, file) => fs.readFileSync(path.join(app, file), 'utf8');
const write = (app, file, content) =>
  fs.writeFileSync(path.join(app, file), content, 'utf8');
const reference = path.join(root, 'reference');
const starter = path.join(root, 'starter');
const method = (source, name, next) =>
  source.slice(
    source.indexOf('  ' + name + '('),
    source.indexOf('  ' + next + '('),
  );
const replaceMethod = (source, from, name, next) =>
  source.replace(method(source, name, next), method(from, name, next));
function clone(name, source) {
  const app = path.join(root, 'artifacts/evaluations', name);
  if (fs.existsSync(app)) throw Error('Use a fresh owner fixture name: ' + app);
  for (const file of files(source)) {
    fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(app, file));
  }
  // Dependencies are the already installed, locked owner dependencies. No participant execution here.
  fs.cpSync(path.join(source, 'node_modules'), path.join(app, 'node_modules'), {
    recursive: true,
  });
  return app;
}
const seeded = clone('candidate4-seeded-only', starter);
for (const file of ['src/labels.ts', 'src/filters.ts', 'src/activity.ts'])
  write(seeded, file, text(reference, file));
let model = text(seeded, 'src/model.ts');
const correct = text(reference, 'src/model.ts');
model = replaceMethod(model, correct, 'move', 'remove');
model = replaceMethod(model, correct, 'remove', 'create');
model = model.replace(
  "    if (changed.includes('priority')) this.event(id, message);\n",
  '',
);
model = model.replace(
  '    const changed = Object.keys(next)',
  '    if (next.status && next.status !== issue.status) next.order = this.ordered(next.status).length;\n    const changed = Object.keys(next)',
);
write(seeded, 'src/model.ts', model);

const visible = clone('candidate4-visible-only', starter);
write(visible, 'src/App.tsx', text(reference, 'src/App.tsx'));
write(visible, 'src/persistence.ts', text(reference, 'src/persistence.ts'));
write(
  visible,
  'src/components/Board.tsx',
  text(visible, 'src/components/Board.tsx').replace('    disabled', ''),
);
write(
  visible,
  'src/components/IssueDrawer.tsx',
  text(visible, 'src/components/IssueDrawer.tsx').replace(
    '            readOnly',
    "            onBlur={(e) => patch('description',e.target.value)}",
  ),
);
model = text(visible, 'src/model.ts').replace(
  'if (next.title !== undefined) next.title = next.title.trim();',
  'if (next.title !== undefined) { next.title=next.title.trim(); if (!next.title) return; }',
);
write(visible, 'src/model.ts', model);
write(
  visible,
  'src/components/Analytics.tsx',
  `import type {summary} from '../model';
export default function Analytics({stats}:{stats:ReturnType<typeof summary>}) {return <section aria-label="Analytics"><output aria-label="Total issues">{stats.total}</output><output aria-label="Completed issues">{stats.completed}</output><output aria-label="Completion percentage">{stats.percentage}%</output></section>}\n`,
);

const delta = [];
for (const file of files(starter).filter((f) => f.startsWith('src/'))) {
  const a = text(starter, file),
    b = text(reference, file);
  if (a === b) continue;
  const result = spawnSync(
    'git',
    [
      'diff',
      '--no-index',
      '--numstat',
      '--',
      path.join(starter, file),
      path.join(reference, file),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  const [added, removed] = (result.stdout || '').trim().split(/\s+/);
  delta.push({
    file,
    added: Number(added),
    removed: Number(removed),
    starterSha256: sha(a),
    referenceSha256: sha(b),
  });
}
fs.writeFileSync(
  path.join(destination, 'distribution.json'),
  JSON.stringify(
    {
      kind: 'IMPLEMENTATION_DELTA_NOT_EMPIRICAL_DURATION',
      files: delta,
      changedFiles: delta.length,
      addedLines: delta.reduce((n, f) => n + f.added, 0),
      removedLines: delta.reduce((n, f) => n + f.removed, 0),
      note: 'Includes presentation and formatting delta. Independent surfaces: persistence, board interaction, drawer editing, analytics rendering, filtering, labels, chronology, model integration, app wiring and CSS. This is an implementation witness, not a lower bound on every valid solution.',
    },
    null,
    2,
  ),
);

async function measure(name, app) {
  const before = tree(app).hash;
  const run = (tool, args) =>
    spawnSync(
      process.execPath,
      [path.join(app, 'node_modules', tool), ...args],
      { cwd: app, encoding: 'utf8', windowsHide: true, timeout: 300000 },
    );
  const typecheck = run('typescript/bin/tsc', ['--noEmit']).status === 0;
  const build = run('vite/bin/vite.js', ['build']).status === 0;
  const output = path.join(destination, name + '-visible.json');
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
      path.join(destination, name + '-browser'),
    );
  } finally {
    server.close();
  }
  if (tree(app).hash !== before)
    throw Error('Measurement changed fixture source');
  const evidence = {
    visiblePassed: tests.numPassedTests,
    hidden,
    typecheck,
    build,
    usefulTests: null,
    ...inspectPublic(app),
  };
  return {
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
}
const rows = [];
for (const [name, app] of [
  ['untouched', starter],
  ['visible-only', visible],
  ['seeded-only', seeded],
  ['complete-no-added-tests', reference],
]) {
  const row = await measure(name, app);
  rows.push(row);
  console.log(name, row.visiblePassed, row.hiddenPassed, row.score.automated);
}
const useful = usefulTestsTrusted(
  reference,
  path.join(root, 'artifacts/reference-useful'),
);
fs.writeFileSync(
  path.join(root, 'artifacts/reference-useful/summary.json'),
  JSON.stringify(useful, null, 2),
);
const full = rows.at(-1);
rows.push({
  ...full,
  name: 'full-reference',
  evidence: { ...full.evidence, usefulTests: useful },
  score: score({ ...full.evidence, usefulTests: useful }),
  referenceNotParticipant: true,
});
fs.writeFileSync(
  path.join(destination, 'score-floors.json'),
  JSON.stringify(
    {
      kind: 'MEASURED_OWNER_FIXTURES_NOT_SYNTHESIZED_PASS_COUNTS',
      variants: rows,
      humanUI:
        'No numerical reference score; participant UI requires human improvement evidence.',
      definitions: {
        'visible-only':
          'Fixes public visible failures through app wiring, title guard, description, basic totals, migration and quick move; seeded faults remain.',
        'seeded-only':
          'Only seven documented seeded defects repaired; unfinished component and persistence work remains.',
      },
    },
    null,
    2,
  ),
);
