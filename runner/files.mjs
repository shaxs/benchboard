import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
export const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
export function files(dir, skip = new Set(['node_modules', 'dist', '.git'])) {
  if (fs.lstatSync(dir).isSymbolicLink())
    throw Error('Root link prohibited: ' + dir);
  const out = [];
  function walk(at) {
    for (const e of fs
      .readdirSync(at, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (skip.has(e.name)) continue;
      const p = path.join(at, e.name);
      if (fs.lstatSync(p).isSymbolicLink())
        throw Error('Links are prohibited: ' + p);
      if (e.isDirectory()) walk(p);
      else if (e.isFile())
        out.push(path.relative(dir, p).replaceAll('\\', '/'));
      else throw Error('Special file prohibited: ' + p);
    }
  }
  walk(dir);
  return out.sort();
}
export function tree(dir) {
  const entries = files(dir).map((p) => [
    p,
    sha(fs.readFileSync(path.join(dir, p))),
  ]);
  return { hash: sha(JSON.stringify(entries)), entries };
}
export function hashFile(p) {
  return sha(fs.readFileSync(path.join(root, p)));
}
export function candidate() {
  return {
    version: JSON.parse(fs.readFileSync(path.join(root, 'version.json'))),
    versionHash: hashFile('version.json'),
    spec: hashFile('spec/BENCHMARK.md'),
    specTree: tree(path.join(root, 'spec')).hash,
    starter: tree(path.join(root, 'starter')).hash,
    prd: hashFile('starter/PRODUCT_PRD.md'),
    fixtures: tree(path.join(root, 'fixtures')).hash,
    visible: tree(path.join(root, 'starter/tests')).hash,
    evaluator: tree(path.join(root, 'evaluator')).hash,
    scoring: hashFile('evaluator/score.mjs'),
    runner: tree(path.join(root, 'runner')).hash,
    reference: tree(path.join(root, 'reference')).hash,
  };
}
export const snapshotPath = () =>
  process.env.BENCHBOARD_MANIFEST_PATH ||
  path.join(root, 'artifacts/candidate-manifest.json');
export function writeSnapshot() {
  const snapshot = candidate();
  const freezeFile = path.join(
    root,
    'artifacts/frozen',
    snapshot.version.version + '.json',
  );
  if (
    fs.existsSync(freezeFile) &&
    JSON.stringify(JSON.parse(fs.readFileSync(freezeFile)).hashes) !==
      JSON.stringify(snapshot)
  )
    throw Error('Frozen version bytes changed. Increment benchmark version.');
  const p = snapshotPath();
  if (!process.env.BENCHBOARD_MANIFEST_PATH) {
    const reviews = path.join(root, 'artifacts/review');
    if (fs.existsSync(reviews))
      for (const name of fs.readdirSync(reviews)) {
        const m = path.join(reviews, name, 'manifest.json');
        if (!fs.existsSync(m)) continue;
        const reviewed = JSON.parse(fs.readFileSync(m, 'utf8')).candidate;
        if (
          reviewed.version.version === snapshot.version.version &&
          JSON.stringify(reviewed) !== JSON.stringify(snapshot)
        )
          throw Error(
            'Reviewed candidate tuple changed; use a new version before preparing a snapshot.',
          );
      }
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(snapshot, null, 2));
  return snapshot;
}
export function assertSnapshot() {
  const p = snapshotPath();
  if (!fs.existsSync(p)) throw Error('Prepare candidate manifest first');
  const expected = JSON.parse(fs.readFileSync(p));
  if (JSON.stringify(candidate()) !== JSON.stringify(expected))
    throw Error(
      'Owner bytes differ from candidate manifest. Prepare a new candidate before calibration.',
    );
  return expected;
}
export function contained(base, p) {
  const relative = path.relative(path.resolve(base), path.resolve(p));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
export function rejectLinksTo(p) {
  let at = path.resolve(p);
  while (true) {
    if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink())
      throw Error('Link ancestor prohibited: ' + at);
    const parent = path.dirname(at);
    if (parent === at) return;
    at = parent;
  }
}
