// C6.S11.T4 — CLI source import closure and physically DSH-absent module loading.
//
// Check 1 traverses the ACTUAL source-level import graph of every CLI .mjs
// entrypoint using the pinned TypeScript compiler as a source-only parser (the
// accepted C4/C-results-graph pattern, re-created here as file-local helpers
// because importing that node:test file would register another suite). Literal
// static import/export, literal dynamic import() and require() are followed;
// Node builtins and installed external packages stop traversal by declared
// boundary. A variable, interpolated or otherwise unmodellable module-load
// position FAILS the traversal closed; module/createRequire/getBuiltinModule
// loader-acquisition forms are refused rather than an empty graph being declared
// safe. The check models syntax of reached repository source only: arbitrary
// computed or monkey-patched JavaScript, source configuration taint, external
// library internals and OS/process sandbox containment are NOT modelled, and no
// subprocess stage-worker argv root is claimed here (that is an existing C4
// graph proof, not this one).
//
// Checks 2 and 3 make a fresh ordinary external copy of only the repository
// sources needed to IMPORT the CLI handlers (the accepted copied-installation
// filter: no node_modules/.git/dist is copied; runner is copied as only
// runner/files.mjs; no adapters/dsh, .ai, .opencode, artifacts, private
// histories, configuration or previous solutions), put a junction against the
// prepared node_modules solely for module resolution (test-owned link, removed
// by unlink, never followed), and run a bounded shell-free Node child under
// that copy with a minimal standard OS/module-resolution environment (no DSH,
// Agent Teams or private endpoint variables). The child imports the copy's own
// application entrypoint and fixed readiness/contract tables, awaits all ten
// command loaders, and calls main(['--help']) through private captured sinks.
// The copied source inventory is compared BEFORE/AFTER the child as complete
// accepted inventory entries (path, byte size, SHA-256), so the unchanged claim
// binds copied BYTES, not only path membership; the DSH/artifacts path check
// stays a separate membership-only witness. “...—help” only ever parses — no handler runs, init is never invoked and no
// evaluation or participant agent is started. Success proves source closure
// plus an actual DSH-absent module load/help; it does NOT imply runtime
// dependencies are absent, that any other command branch executed, or that the
// full production chain was proven.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventoryTree } from '../../packages/core/identity.mjs';
import { COMMAND_LOADERS } from '../../cli/command-readiness.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
// Same pinned parser file the accepted graph tests use; nothing is installed.
const ts = (await import(new URL('../../starter/node_modules/typescript/lib/typescript.js', import.meta.url).href)).default;

// File-local copy of the accepted source-only module-load extractor.
function moduleLoads(source) {
  const tree = ts.createSourceFile('graph.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(tree.parseDiagnostics.length, 0, 'source graph must parse');
  const found = [];
  const literal = node => {
    assert.ok(node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)), 'unsupported variable/interpolated module load');
    assert.ok(!['module', 'node:module'].includes(node.text), 'module loader factories are refused under either builtin spelling');
    return node.text;
  };
  const visit = node => {
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === 'getBuiltinModule') throw Error('getBuiltinModule access unsupported in this CLI graph');
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) found.push(literal(node.moduleSpecifier));
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') found.push(literal(node.arguments[0]));
      if (ts.isIdentifier(node.expression) && node.expression.text === 'createRequire') throw Error('createRequire factories unsupported in this CLI graph');
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

test('every CLI entrypoint source graph stays repository-closed, DSH-free and reaches all fixed command loaders', () => {
  const cliRoot = path.join(REPO, 'cli');
  const entries = fs.readdirSync(cliRoot).filter(name => name.endsWith('.mjs')).map(name => path.join(cliRoot, name));
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const relative = path.relative(REPO, file).replaceAll('\\', '/');
    assert.ok(!relative.startsWith('../') && !path.isAbsolute(relative), 'repository graph cannot escape');
    assert.ok(!relative.startsWith('runner/') || relative === 'runner/files.mjs', 'runner utility allowlist');
    assert.notEqual(relative, 'evaluator/report.mjs');
    assert.doesNotMatch(relative, /dsh|agent-teams/i);
    for (const specifier of moduleLoads(fs.readFileSync(file, 'utf8'))) {
      assert.doesNotMatch(specifier, /dsh|agent-teams/i);
      assert.ok(!['module', 'node:module'].includes(specifier), 'unmodelled loader factories are refused');
      if (specifier.startsWith('.')) queue.push(path.resolve(path.dirname(file), specifier));
      else assert.ok(!path.isAbsolute(specifier) && !specifier.startsWith('file:'), 'absolute repository load refused');
    }
  }
  const expectedCommands = Object.freeze(['init', 'start', 'stop', 'status', 'freeze', 'reconcile', 'reset', 'evaluate', 'ui', 'export', 'run', 'review']);
  assert.deepEqual(Object.keys(COMMAND_LOADERS), expectedCommands, 'fixed readiness table unchanged');
  const loaderTargets = [...new Set(moduleLoads(fs.readFileSync(path.join(cliRoot, 'command-readiness.mjs'), 'utf8')))];
  assert.equal(loaderTargets.length, 10, 'twelve commands share the manual-commands module, so ten load targets');
  for (const specifier of loaderTargets) assert.ok(seen.has(path.resolve(cliRoot, specifier)), `fixed loader target reached through the graph: ${specifier}`);
  console.log(`CLI source-only import graph: ${entries.length} entrypoints; ${seen.size} repository modules; builtins/external packages stop traversal; no DSH/agent-teams, no evaluator/report.mjs, runner allowlist holds; all ${expectedCommands.length} fixed command loaders reached.`);
});

test('source extractor refuses loader-acquisition forms and variable/interpolated loads instead of an empty safe graph', () => {
  assert.deepEqual(moduleLoads("import x from './a.mjs';export {x} from './b.mjs';import('./c.mjs');require('d.mjs');"), ['./a.mjs', './b.mjs', './c.mjs', 'd.mjs']);
  for (const source of ['import(variable);', 'import(`./${value}.mjs`);', 'require(variable);', 'const r=createRequire(import.meta.url);r(variable);']) assert.throws(() => moduleLoads(source));
  for (const source of [
    "import {createRequire as cr} from 'module';cr(x)(variable);",
    "import {createRequire as cr} from 'node:module';cr(x)(variable);",
    "import('module').then(m=>m.createRequire(x)(variable));",
    "const r=require('module').createRequire(x);r(variable);",
    "process.getBuiltinModule('module').createRequire(x)(variable);",
    "const {getBuiltinModule: get}=process;get('module');",
    "process['getBuiltinModule']('module');",
  ]) assert.throws(() => moduleLoads(source), /module loader factories|getBuiltinModule access/);
});

// Test-owned only: the ordinary external copy tree and the junction inside it.
function removeCopy(copy) {
  const link = path.join(copy, 'node_modules');
  try { fs.unlinkSync(link); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  fs.rmSync(copy, { recursive: true, force: true, maxRetries: 4 });
}

function makeCopy() {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-cli-import-copy-'));
  const filter = source => !['node_modules', '.git', 'dist'].includes(path.basename(source));
  // Only the sources needed to IMPORT the CLI handlers. Protected checkout
  // bytes are read here; they are never modified.
  for (const relative of ['cli', 'packages/core', 'packages/evaluation', 'packages/results', 'schemas', 'evaluator', 'adapters/manual']) {
    fs.cpSync(path.join(REPO, relative), path.join(copy, relative), { recursive: true, filter });
  }
  fs.mkdirSync(path.join(copy, 'runner'));
  fs.copyFileSync(path.join(REPO, 'runner/files.mjs'), path.join(copy, 'runner/files.mjs'));
  for (const relative of ['package.json', 'package-lock.json', 'version.json']) {
    fs.copyFileSync(path.join(REPO, relative), path.join(copy, relative));
  }
  // Prepared dependencies are READ only for module resolution by this link.
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(copy, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return copy;
}

function inventoryEntries(copy) {
  // The junction is never entered and never followed by the inventory either.
  // The COMPLETE accepted entries are returned: path, byte size and SHA-256,
  // so the before/after comparison binds copied BYTES, not only membership.
  return inventoryTree({ root: copy, skipNames: ['node_modules', '.git', 'dist'] }).entries.map(
    entry => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }));
}

test('a fresh ordinary copy loads all ten command loaders with DSH roots physically absent and leaves the copied source inventory untouched', () => {
  const copy = makeCopy();
  try {
    // Physical absence of governed roots in the copied tree.
    assert.equal(fs.readdirSync(path.join(copy, 'runner')).join(','), 'files.mjs', 'only runner/files.mjs exists in the copy');
    assert.equal(fs.readdirSync(path.join(copy, 'adapters')).join(','), 'manual', 'no adapters/dsh in the copy');
    assert.ok(!fs.existsSync(path.join(copy, 'artifacts')) && !fs.existsSync(path.join(copy, '.ai')) && !fs.existsSync(path.join(copy, '.opencode')), 'no artifacts or private histories copied');
    // Membership-only witness of governed-source absence (paths, no hashes).
    const before = inventoryEntries(copy);
    assert.ok(before.length > 0, 'the copied inventory is non-empty');
    const delistedPaths = before.map(entry => entry.path);
    assert.ok(!delistedPaths.some(p => /(^|\/)(dsh|artifacts)(\/|$)/i.test(p)), 'membership-only: baseline copied inventory has no DSH/artifacts paths');
    // Independently prove the comparison carries CONTENT hashes before it is
    // trusted as a byte-preservation witness.
    assert.ok(before.every(entry => /^[0-9a-f]{64}$/.test(entry.sha256)), 'every captured inventory entry carries a real 64-hex SHA-256 hash field');
    assert.ok(before.some(entry => entry.bytes > 0), 'entry byte fields are populated in the comparison');
    const env = Object.fromEntries(['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'SystemDrive', 'TEMP', 'TMP']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    const start = Date.now();
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD, 'BB-CHILD-REAL',
      pathToFileURL(path.join(copy, 'cli/application.mjs')).href,
      pathToFileURL(path.join(copy, 'cli/command-readiness.mjs')).href,
      pathToFileURL(path.join(copy, 'cli/command-contract.mjs')).href,
    ], {
      cwd: copy,
      env,
      timeout: 90000,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      maxBuffer: 1048576,
    });
    assert.ok(run.error === undefined, `spawn failure: ${run.error}`);
    assert.ok(run.status === 0, `child exited ${run.status} (signal ${run.signal}); stderr: ${run.stderr}`);
    assert.equal(run.stderr, '', 'child produced no stderr');
    const resultLine = run.stdout.split('\n').find(line => line.startsWith('BB-CHILD-OK '));
    assert.ok(resultLine, `child result marker missing; stdout: ${run.stdout}`);
    const { loaders, helpLength } = JSON.parse(resultLine.slice('BB-CHILD-OK '.length));
    assert.deepEqual(loaders.sort(), [...Object.keys(COMMAND_LOADERS)].sort());
    assert.ok(helpLength > 0, 'help body was rendered');
    assert.deepEqual(inventoryEntries(copy), before, 'no copied source file appeared, disappeared or changed — SHA-256 bound byte-for-byte');
    console.log(`DSH-absent module load/help proof under external copy: ${Object.keys(COMMAND_LOADERS).length} loaders resolved, help exit 0, no stderr, unchanged copied inventory with SHA-256-bound bytes (${before.length} files, ${Date.now() - start}ms, junction removed by unlink on cleanup).`);
  } finally {
    removeCopy(copy);
  }
});

// The child runs under the COPY (cwd = copied root, prepared node_modules only
// for resolution, a minimal standard OS environment). It never invokes init or
// any non-help command path; —help always parses before a handler could load,
// so no evaluation, browser, server, installer or participant agent is touched.
const CHILD = `
const marker = process.argv.indexOf('BB-CHILD-REAL');
const args = marker >= 0 ? process.argv.slice(marker + 1) : [];
if (args.length !== 3) throw new Error('child argv mismatch: ' + process.argv.length);
const [appUrl, readinessUrl, contractUrl] = args;
const readiness = await import(readinessUrl);
const contract = await import(contractUrl);
const application = await import(appUrl);
if (readiness.COMMAND_LOADERS === undefined || contract.COMMANDS === undefined) throw new Error('copy tables missing');
const loaders = [];
for (const [name, load] of Object.entries(readiness.COMMAND_LOADERS)) {
  const handler = await load();
  if (typeof handler !== 'function') throw new Error('loader did not resolve to a function: ' + name);
  loaders.push(name);
}
const written = [];
const writtenErrors = [];
const exitCode = await application.main(['--help'], { write: text => written.push(text), writeError: text => writtenErrors.push(text) });
if (exitCode !== 0) throw new Error('main --help returned ' + exitCode);
if (writtenErrors.length) throw new Error('help produced stderr: ' + writtenErrors.join(''));
const help = written.join('\\n');
const missing = Object.keys(contract.COMMANDS).filter(name => !help.includes(name));
if (missing.length) throw new Error('help missing commands: ' + missing.join(','));
console.log('BB-CHILD-OK ' + JSON.stringify({ loaders, helpLength: help.length }));
`;
