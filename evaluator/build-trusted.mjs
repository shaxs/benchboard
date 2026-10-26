import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { root, tree, files, contained } from '../runner/files.mjs';
export async function buildTrusted(name) {
  if (!['starter', 'reference', 'broken'].includes(name))
    throw Error('Only owner fixtures may execute on host');
  const app =
    name === 'broken'
      ? path.join(root, 'artifacts/broken-source')
      : path.join(root, name);
  if (name === 'broken') {
    if (fs.existsSync(app)) {
      if (
        !fs.existsSync(path.join(app, '.owner-fixture.json')) ||
        !contained(path.join(root, 'artifacts'), app)
      )
        throw Error('Unknown fixture directory');
      fs.rmSync(app, { recursive: true, force: true });
    }
    fs.mkdirSync(app, { recursive: true });
    for (const p of files(path.join(root, 'starter'))) {
      const to = path.join(app, p);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(root, 'starter', p), to);
    }
    fs.cpSync(
      path.join(root, 'starter/node_modules'),
      path.join(app, 'node_modules'),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(app, '.owner-fixture.json'),
      '{"trustedOwnerFixture":true}',
    );
    fs.writeFileSync(
      path.join(app, 'src/App.tsx'),
      "export default function App(){return <main><h1>Broken workload</h1><output aria-label='Total issues'>0</output></main>}\n",
    );
  }
  const before = tree(app).hash;
  const run = (tool, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(app, 'node_modules', tool), ...args],
        { cwd: app, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let logs = '';
      child.stdout.on('data', (d) => (logs += d));
      child.stderr.on('data', (d) => (logs += d));
      child.once('error', reject);
      const timeout = setTimeout(() => {
        child.kill();
        reject(Error('Build timeout'));
      }, 300000);
      child.once('close', (code) => {
        clearTimeout(timeout);
        fs.writeFileSync(
          path.join(
            root,
            'artifacts',
            name + '-' + path.basename(tool) + '-validation.log',
          ),
          logs,
        );
        resolve(code === 0);
      });
    });
  const typecheck = await run('typescript/bin/tsc', ['--noEmit']);
  const build = await run('vite/bin/vite.js', ['build']);
  const after = tree(app).hash;
  if (after !== before) throw Error('Fixture source changed during validation');
  const result = { app, sourceHash: after, typecheck, build };
  fs.writeFileSync(
    path.join(root, 'artifacts', name + '-build-evidence.json'),
    JSON.stringify(result, null, 2),
  );
  return result;
}
if (process.argv[2])
  console.log(JSON.stringify(await buildTrusted(process.argv[2])));
