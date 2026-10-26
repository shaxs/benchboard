// Captain acceptance of current directions, not runtime C4 execution or a fresh-user walkthrough.
// Pure argv parsing and local links; no documented operation runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments } from '../../cli/arguments.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const currentGuides = ['docs/QUICKSTART.md', 'docs/MANUAL_WORKFLOW.md', 'docs/examples/MANUAL_COMMANDS.md'];
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('current neutral guides exist and every local document link stays inside the checkout and resolves', () => {
  let checked = 0;
  for (const file of ['README.md', ...currentGuides]) {
    const text = read(file);
    for (const match of text.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target) continue;
      assert.doesNotMatch(target, /^[a-z]+:|^[/\\]/i, `${file}: current user links are checkout-relative`);
      const destination = path.resolve(root, path.dirname(file), decodeURIComponent(target));
      const relative = path.relative(root, destination);
      assert.equal(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), false);
      assert.equal(fs.statSync(destination).isFile(), true, `${file}: ${target} resolves to an ordinary document`);
      checked++;
    }
  }
  assert.ok(checked >= 12, 'the workflow must actually link its required public-safe guides');
});

test('documented CLI recipes parse with current required flags and cover the normal chain without historical execution commands', () => {
  const seen = new Set(); let parsedCount = 0;
  for (const file of currentGuides) {
    const text = read(file);
    for (const block of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
      const lines = block[1].replace(/(?:\\|`)\s*\r?\n/g, ' ').split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        assert.doesNotMatch(line, /^(?:node|pwsh|powershell|npm)\s+.*(?:runner[/\\]|evaluator[/\\](?:self-validate|refresh-contract-witnesses)|run\s+(?:self-test|validate)\b)/i,
          `${file}: historical owner commands are not current executable directions`);
        if (!/^node\s+(?:\.\/)?cli\/benchboard\.mjs(?:\s|$)/.test(line)) continue;
        const tokens = line.match(/"[^"\r\n]*"|'[^'\r\n]*'|\S+/g) ?? [];
        const commentAt = tokens.findIndex(token => token.startsWith('#'));
        const commandTokens = commentAt < 0 ? tokens : tokens.slice(0, commentAt);
        const argv = commandTokens.slice(2).map(token => /^(["']).*\1$/.test(token) ? token.slice(1, -1) : token);
        const parsed = parseArguments(argv);
        if (parsed.command === 'start' && Object.hasOwn(parsed.options, '--harness')) {
          assert.equal(parsed.options['--harness'], 'manual', `${file}: this init-to-start recipe must match the sealed manual harness`);
        }
        if (parsed.command !== undefined && parsed.command !== null) seen.add(parsed.command);
        parsedCount++;
      }
    }
  }
  for (const command of ['init', 'status', 'start', 'stop', 'freeze', 'evaluate', 'ui', 'export', 'reset']) {
    assert.equal(seen.has(command), true, `the normal chain documents ${command}`);
  }
  assert.ok(parsedCount >= 9);
});

test('README states the 26-file workload and links the current guides', () => {
  const readme = read('README.md');
  assert.match(readme, /\b26\b/);
  for (const file of ['QUICKSTART.md', 'MANUAL_WORKFLOW.md', 'CLI.md']) assert.ok(readme.includes(file));
});
