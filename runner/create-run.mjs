import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  root,
  files,
  tree,
  assertSnapshot,
  contained,
  rejectLinksTo,
} from './files.mjs';
import { CEILING_POLICY, ceilingMinutes, ceilingSeconds } from './ceiling.mjs';
export const publicRoots = new Set([
  'src',
  'tests',
  'index.html',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'README.md',
  'PRODUCT_PRD.md',
  '.dockerignore',
]);
export function createRun(
  id,
  base,
  { dependencies = true, timeCeilingMinutes } = {},
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id))
    throw Error('Invalid run ID');
  // Every real run declares its execution ceiling before execution begins.
  const ceiling = ceilingMinutes(timeCeilingMinutes);
  base = path.resolve(base);
  if (base === root || contained(root, base) || contained(base, root))
    throw Error(
      'Run base must be outside and not an ancestor of owner repository',
    );
  rejectLinksTo(base);
  const frozen = assertSnapshot();
  const source = path.join(root, 'starter');
  rejectLinksTo(source);
  const publicFiles = files(source);
  const approved = JSON.parse(
    fs.readFileSync(path.join(root, 'runner/public-manifest.json')),
  );
  if (JSON.stringify(publicFiles) !== JSON.stringify(approved))
    throw Error('Public source differs from explicit file allowlist');
  for (const p of publicFiles)
    if (!publicRoots.has(p.split('/')[0]))
      throw Error('Unallowlisted public file: ' + p);
  const destination = path.join(base, id);
  if (fs.existsSync(destination)) throw Error('Run already exists');
  const record = path.join(root, 'artifacts/runs', id + '.json');
  if (fs.existsSync(record)) throw Error('Run ID already registered');
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(destination);
  try {
    for (const p of publicFiles) {
      const to = path.join(destination, p);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(source, p), to);
    }
    if (dependencies) {
      const modules = path.join(source, 'node_modules');
      rejectLinksTo(modules);
      if (!fs.existsSync(modules))
        throw Error('Prepare locked dependencies first');
      files(modules, new Set());
      fs.cpSync(modules, path.join(destination, 'node_modules'), {
        recursive: true,
        dereference: false,
        filter: (p) =>
          !['.vite', '.vite-temp', '.cache'].includes(path.basename(p)),
      });
    }
    const publicHash = tree(destination).hash;
    if (publicHash !== frozen.starter)
      throw Error('Public starter hash mismatch');
    const dependencyHash = dependencies
      ? tree(path.join(destination, 'node_modules')).hash
      : null;
    const manifest = {
      runId: id,
      benchmarkVersion: frozen.version.version,
      destination,
      base,
      createdAt: new Date().toISOString(),
      publicHash,
      dependencyHash,
      dependencies,
      timeCeilingMinutes: ceiling,
      timeCeilingSeconds: ceilingSeconds(ceiling),
      ceilingPolicy: CEILING_POLICY,
      hashes: frozen,
      security: 'COOPERATIVE_WORKSPACE_NO_ADVERSARIAL_OS_CONTAINMENT',
    };
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    return manifest;
  } catch (e) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw e;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const minutes = Number(process.argv[4]);
  if (!Number.isInteger(minutes))
    throw Error(
      'Usage: create-run.mjs RUN_ID RUN_BASE TIME_CEILING_MINUTES',
    );
  console.log(
    JSON.stringify(
      createRun(process.argv[2], process.argv[3], {
        timeCeilingMinutes: minutes,
      }),
      null,
      2,
    ),
  );
}
