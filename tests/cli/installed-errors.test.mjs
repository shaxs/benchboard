// Captain-owned diagnostics at the real subprocess boundary, using only external
// copied installations. No challenge/evaluator bytes in the checkout are edited.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadInstallation } from '../../cli/installation.mjs';
import { sha256 } from '../../packages/core/identity.mjs';

for (const scenario of ['missing selected lock', 'candidate evaluator identity mismatch']) {
  test(`actual init refuses ${scenario} with a controlled mapped diagnostic`, t => {
    const installed = loadInstallation(), parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-cli-installed-error-'));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true, maxRetries: 4 }));
    const root = path.join(parent, 'copied installation'), output = path.join(parent, 'uncreated output');
    fs.mkdirSync(root);
    for (const relative of ['cli', 'packages', 'schemas', 'release', 'starter', 'fixtures', 'evaluator', 'adapters/manual']) {
      fs.cpSync(path.join(installed.root, relative), path.join(root, relative), { recursive: true,
        filter: file => !['node_modules', '.git', 'dist'].includes(path.basename(file)) });
    }
    for (const relative of ['package.json', 'package-lock.json', 'version.json']) {
      fs.copyFileSync(path.join(installed.root, relative), path.join(root, relative));
    }
    fs.symlinkSync(path.join(installed.root, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const selected = scenario === 'missing selected lock' ? 'package-lock.json' : 'version.json';
    const original = path.join(installed.root, selected), before = sha256(fs.readFileSync(original));
    if (scenario === 'missing selected lock') fs.unlinkSync(path.join(root, selected));
    else {
      const version = JSON.parse(fs.readFileSync(path.join(root, selected), 'utf8'));
      version.version = 'private-canary-invalid-candidate';
      fs.writeFileSync(path.join(root, selected), JSON.stringify(version));
    }
    const result = spawnSync(process.execPath, [path.join(root, 'cli/benchboard.mjs'), 'init', '--output', output], {
      cwd: parent, encoding: 'utf8', shell: false, timeout: 15000, maxBuffer: 1048576, windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, scenario === 'missing selected lock' ? 3 : 4, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, scenario === 'missing selected lock' ? /^CLI_STATE:/ : /^CLI_INTEGRITY:/);
    assert.equal(result.stderr.includes('private-canary'), false);
    assert.equal(result.stderr.includes(parent), false);
    assert.equal(result.stderr.includes('\n    at '), false);
    assert.equal(fs.existsSync(output), false);
    assert.equal(sha256(fs.readFileSync(original)), before);
  });
}
