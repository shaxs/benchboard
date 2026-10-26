import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, files, tree } from '../runner/files.mjs';
import { localServer } from './local-server.mjs';
import { browserEvaluate } from './browser.mjs';
const source = path.join(root, 'reference');
const app = path.join(
  root,
  'artifacts/evaluations/candidate4-equivalent-presentation',
);
if (fs.existsSync(app)) throw Error('Witness source already exists');
for (const file of files(source)) {
  fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
  fs.copyFileSync(path.join(source, file), path.join(app, file));
}
fs.cpSync(path.join(source, 'node_modules'), path.join(app, 'node_modules'), {
  recursive: true,
});
const change = (file, transform) => {
  const at = path.join(app, file);
  fs.writeFileSync(at, transform(fs.readFileSync(at, 'utf8')), 'utf8');
};
change('src/components/Board.tsx', (t) => {
  const start = t.indexOf('                    <div className="assignee">');
  const end = t.indexOf('                  </button>', start);
  const metadata = t.slice(start, end);
  t = t.slice(0, start) + t.slice(end);
  t = t.replace(
    '                  <button\n                    className="card-open"',
    '                  <a href="#issue"\n                    className="card-open"',
  );
  t = t.replace(
    'onClick={() => open(i.id)}',
    'onClick={(e) => {e.preventDefault(); open(i.id);}}',
  );
  t = t
    .replace("i.id + ' ' + i.title", "i.id + ': ' + i.title")
    .replace('                    <h3>{i.title}</h3>', '');
  return t
    .replace(
      '                  </button>',
      '                  </a>\n                  <h3>{i.title}</h3>\n' +
        metadata,
    )
    .replace('No issues here', 'Nothing queued in this column');
});
change('src/components/IssueDrawer.tsx', (t) =>
  t
    .replace('<ul aria-label="Activity"', '<section aria-label="Activity"')
    .replace('</ul>', '</section>')
    .replace('<li key={e.id}>', '<div key={e.id}>')
    .replace('</li>', '</div>')
    .replace(
      'dateTime={e.timestamp}',
      'dateTime={new Date(e.timestamp).toISOString()}',
    )
    .replace('          <button onClick={close}>Close</button>', '')
    .replace(
      '        <div className="danger-zone">',
      '        <button onClick={close}>Close</button>\n        <div className="danger-zone">',
    ),
);
change('src/components/Analytics.tsx', (t) =>
  t
    .replace('{stats.percentage}%', '{stats.percentage.toFixed(1)} percent')
    .replace('<details>', '<div>')
    .replace('</details>', '</div>')
    .replace(
      '<summary>Workload breakdown</summary>',
      '<h3>Workload breakdown</h3>',
    ),
);
change('src/model.ts', (t) =>
  t.replace(
    'Changes could not be saved locally.',
    'Storage error: unable to persist this change.',
  ),
);
const server = await localServer(app);
let hidden;
try {
  hidden = await browserEvaluate(
    server.url,
    path.join(root, 'artifacts/presentation-witness'),
  );
} finally {
  server.close();
}
const result = {
  kind: 'EQUIVALENT_PRESENTATION_WITNESS',
  sourceHash: tree(app).hash,
  changes: [
    'link opening controls',
    'assignee metadata outside opening control',
    'title outside opening control and punctuation after accessible issue ID',
    'equivalent ISO datetime formatting',
    'section/div activity instead of ul/li',
    'different focus order',
    'always-visible analytics',
    'decimal textual percentage',
    'different empty/error copy',
  ],
  passed: hidden.filter((t) => t.passed).length,
  total: hidden.length,
};
fs.writeFileSync(
  path.join(root, 'artifacts/presentation-witness/summary.json'),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
assert.equal(result.passed, 25);
