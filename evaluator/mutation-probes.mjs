import fs from 'node:fs';
import path from 'node:path';
import { root, sha } from '../runner/files.mjs';
import { localServer } from './local-server.mjs';
import { browserEvaluate } from './browser.mjs';
import { defectWitnesses } from './hidden-tests/properties.mjs';
export async function mutationProbes() {
  const app = path.join(root, 'reference'),
    sources = {
      filterUnion: 'filters.ts',
      labelCase: 'labels.ts',
      formattedChronology: 'activity.ts',
    };
  const originals = new Map(
    ['model.ts', 'filters.ts', 'labels.ts', 'activity.ts'].map((name) => [
      name,
      fs.readFileSync(path.join(app, 'src', name)),
    ]),
  );
  const transforms = {
    persistedOrder: (s) =>
      s.replace(
        /this\.event\(id, 'Issue moved'\);\s*this\.stats = summary\(this\.state\.issues\);\s*this\.save\(\);/,
        "this.event(id, 'Issue moved');this.stats=summary(this.state.issues);const positions=new Map((JSON.parse(before) as [string,Status,number][]).map(([key,,order])=>[key,order]));const current=this.state;this.state={...current,issues:current.issues.map(i=>({...i,order:positions.get(i.id)??i.order}))};this.save();this.state=current;",
      ),
    deleteAnalytics: (s) =>
      s.replace(
        /this\.event\(id, 'Issue deleted'\);\s*this\.stats = summary\(this\.state\.issues\);\s*this\.save\(\);/,
        "this.event(id, 'Issue deleted');this.save();",
      ),
    filterUnion: (s) =>
      s.replace(
        'checks.every(Boolean)',
        '(!f.priority&&!f.assignee&&!f.label&&!f.status || [f.priority&&checks[0],f.assignee&&checks[1],f.label&&checks[2],f.status&&checks[3]].some(Boolean))',
      ),
    drawerOrder: (s) =>
      s.replace(
        /if \(next\.status && next\.status !== issue\.status\)\s*next\.order = this\.ordered\(next\.status\)\.length;/,
        '',
      ),
    labelCase: (s) => s.replace('x.trim().toLowerCase()', 'x.trim()'),
    duplicateActivity: (s) =>
      s.replace(
        'this.event(id, message);',
        "this.event(id, message);if(changed.includes('priority'))this.event(id, message);",
      ),
    formattedChronology: (s) =>
      s.replace(
        'Date.parse(b.timestamp) - Date.parse(a.timestamp)',
        "new Date(b.timestamp).toLocaleDateString('en-US').localeCompare(new Date(a.timestamp).toLocaleDateString('en-US'))",
      ),
  };
  const baselineServer = await localServer(app);
  try {
    const baseline = await browserEvaluate(
      baselineServer.url,
      path.join(root, 'artifacts/mutations/baseline'),
      Object.values(defectWitnesses),
    );
    if (baseline.some((t) => !t.passed))
      throw Error('Reference witness baseline failed before mutation');
  } finally {
    baselineServer.close();
  }
  const results = [];
  try {
    for (const [name, change] of Object.entries(transforms)) {
      const filename = sources[name] || 'model.ts';
      const file = path.join(app, 'src', filename);
      const original = originals.get(filename).toString('utf8');
      const changed = change(original);
      if (changed === original) throw Error('Mutation did not apply: ' + name);
      fs.writeFileSync(file, changed);
      const server = await localServer(app);
      try {
        const outcome = await browserEvaluate(
          server.url,
          path.join(root, 'artifacts/mutations', name),
          [defectWitnesses[name]],
        );
        results.push({
          defect: name,
          witness: defectWitnesses[name],
          detected:
            outcome.length === 1 &&
            !outcome[0].passed &&
            outcome[0].phase === 'PROPERTY',
        });
      } finally {
        server.close();
        fs.writeFileSync(file, original);
      }
    }
  } finally {
    for (const [name, bytes] of originals)
      fs.writeFileSync(path.join(app, 'src', name), bytes);
  }
  for (const [name, bytes] of originals)
    if (sha(fs.readFileSync(path.join(app, 'src', name))) !== sha(bytes))
      throw Error('Reference restore failed');
  fs.writeFileSync(
    path.join(root, 'artifacts/mutation-probes.json'),
    JSON.stringify(results, null, 2),
  );
  return results;
}
if (process.argv[2] === 'run')
  console.log(JSON.stringify(await mutationProbes(), null, 2));
