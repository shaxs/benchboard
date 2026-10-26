import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('help and rejected usage work in an isolated source-only CLI without installed assets or packages', t => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-cli-help-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const seen = new Set();
  function copy(relative) {
    if (seen.has(relative)) return;
    seen.add(relative);
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    const destination = path.join(scratch, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, source);
    // Narrow copy witness for this graph's static, column-zero import syntax;
    // the isolated subprocess below is the execution proof, not a sandbox claim.
    for (const match of source.matchAll(/^import\s+(?:[^;]*?\s+from\s+)?['"]([^'"\r\n]+)['"]/gm)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('.'), `no package needed for help: ${specifier}`);
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      assert.ok(!dependency.startsWith('../'));
      copy(dependency);
    }
  }
  copy('cli/benchboard.mjs');
  assert.ok(!fs.existsSync(path.join(scratch, 'node_modules')));
  assert.ok(!fs.existsSync(path.join(scratch, 'starter')));
  assert.ok(!fs.existsSync(path.join(scratch, 'schemas')));
  for (const [args, code] of [[['--help'], 0], [['init', '--help'], 0], [['start', '--help'], 0],
    [['status', '--help'], 0], [['evaluate', '--help'], 0], [['init', '--unexpected'], 2]]) {
    const result = spawnSync(process.execPath, [path.join(scratch, 'cli', 'benchboard.mjs'), ...args], {
      cwd: scratch, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576,
    });
    assert.equal(result.status, code, result.stderr);
    if (code === 0) assert.equal(result.stderr, '');
    else { assert.equal(result.stdout, ''); assert.match(result.stderr, /^CLI_USAGE:/); }
  }
});
