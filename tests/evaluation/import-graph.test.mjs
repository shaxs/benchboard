// C4.S1.R1.P — independent order/import acceptance (import-graph half, review round1 R1-F5).
//
// This test traverses the ACTUAL runtime import graph of the supported facade. The module-loading
// forms are now classified with the ALREADY-INSTALLED PINNED TypeScript compiler's parser as DATA
// (source-only parsing; no target module is ever executed, and no install occurs): every static
// import/export-from, every literal dynamic import(), template literals with NO substitutions,
// and require-style loads made through a createRequire factory the scanner directly recognizes —
// a factory obtained ONLY by a direct identifier call `createRequire(...)` while the binding name
// is then called directly with a literal. The scanner does NOT generically model member-access or
// aliased construction of that factory (e.g. `mod.createRequire(...)` or an imported/renamed
// createRequire handed along as a factory value); the reached production graph contains no such
// form. This is deliberate scope documentation, never a claim that all arbitrary JS module-load
// forms are closed, and never a claim of an OS/process sandbox. A variable, concatenated or
// interpolated (substituted-template) load at a recognized module-load position in reached
// repository source is UNSUPPORTED and fails the traversal closed — an empty literal scan is
// never treated as proof. The scanner's own failure-closed behavior is demonstrated by the
// nondestructive regression cases below (strings parsed in memory only; nothing they name is
// resolved, executed, installed, served or launched).
//
// Declared graph boundaries (honest scope, not silent gaps):
// - Installed external packages and Node builtins stop traversal by design (declared boundary).
// - The generic runProcess argv seam hands an executable plus argv to the accepted T1 runner at
//   RUN time; the static graph proves the fixed call shapes, not a closed whole-process graph.
// - Arbitrary participant-added tests are discovered at run time by the unchanged useful module
//   (it enumerates the staged tests directory); they are never part of a static module graph.
// - The two fixed Node executable entrypoints (stage-worker argv dispatch, exit-witness preload)
//   are not ordinary import declarations and are therefore added as explicit roots.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as facade from '../../packages/evaluation/evaluate-frozen.mjs';
import { STAGE_WORKER_PATH } from '../../packages/evaluation/contracts.mjs';
import { evaluateWithRuntime } from '../../packages/evaluation/controller.mjs';
import { createFrozenFixture } from './helpers.mjs';

// The pinned TypeScript compiler library, used ONLY as a source parser in these tests. The same
// pinned file is what the existing inspection module already depends on; nothing is installed.
const ts = (await import(new URL('../../starter/node_modules/typescript/lib/typescript.js', import.meta.url).href)).default;

const PACKAGE_ROOT = fileURLToPath(new URL('../../packages/evaluation/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]+$/, '');

// Entry of the graph: the supported facade. The controller is reached through it,
// and the two executable entrypoints are added explicitly below because argv/
// preload entrypoints are not ordinary import declarations.
const FACADE_PATH = fileURLToPath(new URL('../../packages/evaluation/evaluate-frozen.mjs', import.meta.url));
const EXECUTABLE_ENTRYPOINTS = Object.freeze([STAGE_WORKER_PATH, path.join(PACKAGE_ROOT, 'exit-witness.mjs')]);

const SK = ts.SyntaxKind;

// A module-specifier-bearing literal is a plain string literal or a template literal with NO
// substitutions (parsed as the bare template token). Anything else at a module-load position is
// not statically resolvable.
function literalSpecifier(node) {
  if (!node) return null;
  if (node.kind === SK.StringLiteral) return node.text;
  if (node.kind === SK.FirstTemplateToken) return node.text.replace(/^[`\x22]|[`\x22]$/g, '');
  return null;
}

// Source-only scan of one module: returns every statically classifiable module load plus every
// unsupported (variable / concatenated / interpolated) module-load form found in it. Throws when
// the pinned parser reports a diagnostic: an unparseable reached file must stop the proof, not
// silently produce an empty scan.
function scanModules(source, filePath) {
  // Source-only parse: the file is read as text and never imported or evaluated. A parse
  // diagnostic stops the proof instead of silently yielding an empty scan.
  const sf = ts.createSourceFile(path.basename(filePath), source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const diagnostics = sf.parseDiagnostics ?? [];
  if (diagnostics.length) throw new Error('Parse diagnostics in ' + relative(filePath) + ' at line(s) ' +
    diagnostics.map(d => lineOf(sf, d.start)).join(', ') + ' — the graph scan refuses to guess past an unparseable module');
  const found = [], unsupported = [];
  // Factory recognition is deliberately narrow: only a DIRECT identifier `createRequire(...)`
  // call initializer binds require-style loader names here. Member-access or aliased factory
  // construction (e.g. `mod.createRequire(...)`, or createRequire imported/renamed and used as a
  // factory) is NOT generically modeled and establishes no binding or loader. Whatever IS bound is
  // then recognized only when the loader is called directly with a literal; a variable,
  // concatenated or interpolated target fails closed. The reached production graph contains no
  // member-access/aliased factory form; this comment is test-proof scope documentation, not a
  // new supported-loader guarantee and not a closure claim over every arbitrary module-load form.
  const requireBound = new Set(['require']);
  const collectBindingNames = (target, into) => {
    if (target.kind === SK.Identifier) into.push(target.text);
    else ts.forEachChild(target, child => collectBindingNames(child, into));
  };
  const walk = (node, role) => {
    switch (node.kind) {
      case SK.ImportDeclaration:
      case SK.ExportDeclaration: {
        if (node.moduleSpecifier) {
          const text = literalSpecifier(node.moduleSpecifier);
          if (text === null) unsupported.push({ form: 'static import/export-from with non-literal specifier', line: lineOf(sf, node.pos) });
          else found.push({ specifier: text, form: 'static', dynamic: false, line: lineOf(sf, node.pos) });
        }
        break;
      }
      case SK.VariableDeclaration: {
        const init = node.initializer;
        if (init && init.kind === SK.CallExpression && init.expression.kind === SK.Identifier && init.expression.text === 'createRequire') {
          const names = []; collectBindingNames(node.name, names);
          for (const name of names) requireBound.add(name);
        }
        break;
      }
      case SK.CallExpression: {
        const callee = node.expression;
        const argument = node.arguments.length ? node.arguments[0] : null;
        if (callee.kind === SK.ImportKeyword) {
          const text = literalSpecifier(argument);
          if (text === null) unsupported.push({ form: 'dynamic import() with variable/concatenated/interpolated target', line: lineOf(sf, node.pos) });
          else found.push({ specifier: text, form: 'dynamic', dynamic: true, line: lineOf(sf, node.pos) });
        } else if (callee.kind === SK.Identifier && requireBound.has(callee.text)) {
          const text = literalSpecifier(argument);
          if (text === null) unsupported.push({ form: 'require-style load with non-literal target', line: lineOf(sf, node.pos) });
          else found.push({ specifier: text, form: 'require', dynamic: false, line: lineOf(sf, node.pos) });
        }
        break;
      }
      case SK.Identifier: {
        // A bound require loader referenced anywhere other than as its own call's callee or the
        // createRequire creation name escapes static resolution: unsupported, never silently ignored.
        if (requireBound.has(node.text) && role === 'plain') unsupported.push({ form: 'require loader bound name used beyond a direct literal call', line: lineOf(sf, node.pos) });
        break;
      }
      default: break;
    }
    ts.forEachChild(node, child => {
      // Only a direct call and a declaration name are safe roles for a bound loader; any other
      // position (argument, member access, return, …) makes its loads unresolvable.
      let childRole = 'plain';
      if (node.kind === SK.CallExpression && child === node.expression) childRole = 'callee';
      else if (node.kind === SK.VariableDeclaration && child === node.name) childRole = 'binding';
      walk(child, childRole);
    });
  };
  walk(sf, 'plain');
  return { found, unsupported };
}
function lineOf(sf, pos) { let line = 0; for (const start of sf.getLineStarts()) { if (start <= pos) line++; } return line; }

function classify(specifier, fromPath) {
  if (specifier.startsWith('node:')) return { kind: 'builtin' };
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return { kind: 'relative', resolved: path.resolve(path.dirname(fromPath), specifier) };
  }
  if (path.isAbsolute(specifier)) return { kind: 'absolute', resolved: specifier };
  return { kind: 'external' }; // bare package name: an installed external package boundary
}

// An installed package boundary: a resolved path entering a node_modules/ segment
// (the vendored prepared-dependency tree included) is an external package stop,
// exactly like a bare package name. Its own internals are never re-traversed.
function isInstalledBoundary(resolvedPath) {
  return path.resolve(resolvedPath).split(path.sep).includes('node_modules');
}

// A URL entrypoint (the exit-witness preload) is a fixed constant in the source,
// never a participant-selected string: resolve it relative to its declaring file.
function resolveURLExpression(specifier, fromPath) {
  return path.resolve(path.dirname(fromPath), fileURLToPath(new URL(specifier, pathToFileURL(fromPath))));
}

function traverse(roots) {
  const visited = new Map(), edges = [], external = new Set(), unsupported = [];
  const queue = roots.map(root => ({ path: root, via: null }));
  while (queue.length) {
    const { path: filePath, via } = queue.shift();
    const key = filePath.toLowerCase();
    if (visited.has(key)) continue;
    if (!fs.existsSync(filePath)) throw new Error('Graph node missing: ' + filePath + (via ? ' (reached from ' + via + ')' : ''));
    const source = fs.readFileSync(filePath, 'utf8');
    visited.set(key, filePath);
    const scan = scanModules(source, filePath);
    for (const bad of scan.unsupported) unsupported.push({ node: filePath, ...bad });
    for (const { specifier, form, dynamic, line } of scan.found) {
      const edge = classify(specifier, filePath);
      if (edge.kind === 'builtin') { edges.push({ from: filePath, specifier, kind: 'builtin', form, dynamic, line }); continue; }
      if (edge.kind === 'external') { external.add(specifier); edges.push({ from: filePath, specifier, kind: 'external', form, dynamic, line }); continue; }
      // new URL('./x.mjs', import.meta.url) constant expressions name real graph files.
      const resolved = specifier.includes('mjs') && specifier.includes('/') && !specifier.startsWith('.') ? resolveURLExpression(specifier, filePath) : edge.resolved;
      const boundary = isInstalledBoundary(resolved);
      edges.push({ from: filePath, specifier, kind: edge.kind, form, dynamic, resolved, boundary, line });
      if (!boundary) queue.push({ path: resolved, via: filePath }); // installed package: traversal stops here
    }
    // A URL-form constant such as new URL('./exit-witness.mjs', import.meta.url) resolves
    // to a Node preload entrypoint rather than a module imported here; it is still
    // traversed because it is part of the runtime graph the Captain fixed.
    for (const match of source.matchAll(/new URL\(['"](\.\/[^'"]+\.mjs)['"],\s*import\.meta\.url\)/g) ?? []) {
      const resolved = resolveURLExpression(match[1], filePath);
      edges.push({ from: filePath, specifier: match[1], kind: 'url-entrypoint', dynamic: false, resolved });
      if (fs.existsSync(resolved)) queue.push({ path: resolved, via: filePath });
    }
  }
  return { visited, edges, external, unsupported };
}

const relative = absolute => path.relative(REPO_ROOT, absolute).replaceAll('\\', '/');

const GRAPH = traverse([FACADE_PATH, ...EXECUTABLE_ENTRYPOINTS]);

test('the runtime graph is non-empty and reaches every expected module including the executable entrypoints and the internal controller', () => {
  const { visited, external } = GRAPH;
  const names = [...visited.values()].map(relative).sort();
  // No empty-graph vacuous pass: the traversal must actually load the graph.
  assert.ok(visited.size >= 10, 'graph must contain the real module set, got ' + names.join(', '));
  for (const expected of [
    'packages/evaluation/evaluate-frozen.mjs',
    'packages/evaluation/controller.mjs',          // internal controller via the facade
    'packages/evaluation/contracts.mjs',
    'packages/evaluation/staging.mjs',
    'packages/evaluation/process.mjs',
    'packages/evaluation/tool-stages.mjs',
    'packages/evaluation/browser-stage.mjs',
    'packages/evaluation/useful-stage.mjs',
    'packages/evaluation/stage-worker.mjs',        // fixed argv entrypoint
    'packages/evaluation/exit-witness.mjs',        // fixed preload entrypoint
    'evaluator/collect-evidence.mjs',              // inspection reached only via the worker dispatch
  ]) assert.ok(names.includes(expected), 'graph must reach ' + expected);
  // Stopping at installed packages is real, not a broken traversal: playwright is an external
  // boundary, and the pinned TypeScript parser library is reached as a declared node_modules stop.
  assert.ok([...external].some(name => name === '@playwright/test'), 'external package boundary must be reached');
  assert.ok(GRAPH.edges.some(edge => edge.kind === 'relative' && edge.boundary === true && String(edge.resolved).split(path.sep).includes('node_modules')),
    'the node_modules stop must be an edge actually observed in the graph (collect-evidence reaches the pinned parser)');
});

test('the graph rejects report.mjs, every runner module except files.mjs and any DSH path/config/runtime import', () => {
  const { visited, edges } = GRAPH;
  for (const node of visited.values()) {
    const name = relative(node);
    assert.equal(name.includes('evaluator/report.mjs'), false, 'evaluator/report.mjs must never enter the graph (via ' + name + ')');
    if (name.startsWith('runner/')) assert.equal(name, 'runner/files.mjs', 'only runner/files.mjs may be a graph node, found ' + name);
    assert.equal(/(^|\/)dsh(\/|$)/i.test(name), false, 'no DSH path may enter the graph: ' + name);
  }
  for (const edge of edges) {
    const target = edge.resolved ?? '';
    assert.equal(target.toLowerCase().endsWith(path.normalize('evaluator/report.mjs')), false,
      'no edge may import evaluator/report.mjs (from ' + relative(edge.from) + ' as ' + edge.specifier + ')');
    if (path.isAbsolute(target) && target.toLowerCase().startsWith((path.join(REPO_ROOT, 'runner') + path.sep).toLowerCase())) {
      assert.equal(target.toLowerCase(), path.join(REPO_ROOT, 'runner', 'files.mjs').toLowerCase(),
        'only runner/files.mjs may be an edge target, found ' + relative(target));
    }
    assert.equal(/\bdsh\b/i.test(edge.specifier), false, 'no DSH specifier may appear: ' + edge.specifier);
  }
  // Guard against a silent vacuous graph on the prohibited-side check too.
  assert.ok(edges.length > 20);
});

test('the worker dispatch cannot take a participant-selected module path', () => {
  const workerSource = fs.readFileSync(STAGE_WORKER_PATH, 'utf8');
  // The dynamic targets are fixed string literals; every dynamic specifier is a
  // constant relative module under packages/evaluation or the fixed evaluator
  // inspection module. No argv/env-derived value reaches an import(). The classification is the
  // same AST scan used across the graph, so a new non-literal form would be unsupported, not missed.
  const workerScan = scanModules(workerSource, STAGE_WORKER_PATH);
  assert.deepEqual(workerScan.unsupported, [], 'stage worker carries no unsupported module-load form');
  const dynamic = workerScan.found.filter(entry => entry.dynamic);
  assert.ok(dynamic.length >= 3, 'stage-worker dispatches by dynamic import');
  for (const entry of dynamic) {
    assert.ok(/^(?:\.\.?\/|[^./])/.test(entry.specifier), 'dynamic target must be a literal relative module: ' + entry.specifier);
    assert.equal(entry.specifier.includes('$') || entry.specifier.includes('+'), false, 'dynamic target must not interpolate: ' + entry.specifier);
  }
  // The only argv values are the three fixed files; stage argv is a closed literal set.
  assert.ok(/const \[stage, requestFile, resultFile, \.\.\.extra\] = process\.argv\.slice\(2\);/.test(workerSource));
  assert.ok(/!\['browser', 'useful', 'inspection'\]\.includes\(stage\)/.test(workerSource));
  // Request field validation is structural (absolute strings and one integer), never a path used for code selection.
  for (const key of ['appRoot', 'artifactRoot', 'tempRoot']) assert.ok(workerSource.includes("'" + key + "'"), 'fixed request key ' + key);
  assert.equal(workerScan.unsupported.some(bad => bad.form.startsWith('dynamic')), false, 'no non-literal import() target may exist in the stage worker');

  // The exit witness preload path is a fixed URL constant and its request comes from
  // one Captain-only environment key that the preload deletes before the tool runs.
  const processSource = fs.readFileSync(path.join(PACKAGE_ROOT, 'process.mjs'), 'utf8');
  assert.ok(/const WITNESS_PRELOAD = new URL\('\.\/exit-witness\.mjs', import\.meta\.url\)\.href;/.test(processSource));
  assert.ok(/--import/.test(processSource) && processSource.includes('WITNESS_PRELOAD'));
  const witnessSource = fs.readFileSync(path.join(PACKAGE_ROOT, 'exit-witness.mjs'), 'utf8');
  assert.ok(/delete process\.env\[key\];/.test(witnessSource), 'the witness key is removed before the tool runs');

  // The public facade exports exactly evaluateFrozen, and the controller refuses any
  // request key that could name a module path or stage collaborator.
  assert.deepEqual(Object.keys(facade), ['evaluateFrozen']);
  const requestKeys = fs.readFileSync(path.join(PACKAGE_ROOT, 'staging.mjs'), 'utf8').match(/const allowed = \[[^\]]+\]/)[0];
  assert.equal(/runtime|stageOverrides|canonicalRoot|dependencyRoot|module/.test(requestKeys), false, 'public request keys must name no runtime or module selection: ' + requestKeys);
});

test('every reached module classifies cleanly: no variable, concatenated or interpolated module load survives the scan, and a non-empty set of literal loads was actually found', () => {
  // R1-F5: an empty literal scan must never masquerade as a proof. The graph's real forms are
  // counted, and every unsupported form found anywhere in reached repo source fails closed.
  const { unsupported } = GRAPH;
  assert.deepEqual(unsupported.map(bad => relative(bad.node) + ':' + bad.line + ' ' + bad.form), [],
    'reached repository source must contain no statically unresolvable module load');
  const forms = new Map();
  for (const edge of GRAPH.edges) forms.set(edge.form ?? edge.kind, (forms.get(edge.form ?? edge.kind) ?? 0) + 1);
  assert.ok((forms.get('static') ?? 0) >= 40, 'the static import forms must be a substantial real scan, got ' + forms.get('static'));
  assert.ok((forms.get('dynamic') ?? 0) >= 7, 'the dynamic import forms must include the worker and semantic-module seams, got ' + forms.get('dynamic'));
  // Traversal stops at installed packages by declaration: no visited node lies under node_modules.
  for (const node of GRAPH.visited.values()) assert.equal(String(node).split(path.sep).includes('node_modules'), false,
    'installed package internals must remain a declared boundary, never a graph node: ' + relative(node));
});

test('the fixed Node argv and preload roots are the graph entrypoints and the preserved local-server and useful-test spawn targets resolve under the staged node_modules', async t => {
  // Fixed Node roots, checked as data (nothing is launched): the worker entrypoint constant, its
  // argv position, and the preload constant plus the --import seam that is always exactly two
  // arguments long so no caller-supplied value can ride it.
  const contractsSource = fs.readFileSync(path.join(PACKAGE_ROOT, 'contracts.mjs'), 'utf8');
  assert.ok(/export const STAGE_WORKER_PATH = fileURLToPath\(new URL\('\.\/stage-worker\.mjs', import\.meta\.url\)\);/.test(contractsSource));
  assert.ok(/args: \[STAGE_WORKER_PATH, stage, requestFile, resultFile\]/.test(contractsSource), 'worker argv is the fixed four-entry set');
  const processSource = fs.readFileSync(path.join(PACKAGE_ROOT, 'process.mjs'), 'utf8');
  assert.ok(/const spawnArgs = witness \? \['--import', WITNESS_PRELOAD, \.\.\.args\] : \[\.\.\.args\];/.test(processSource),
    'the preload seam is fixed argv only; the caller argv rides after it unchanged');
  assert.equal(pathToFileURL(path.join(PACKAGE_ROOT, 'exit-witness.mjs')).href,
    (processSource.match(/const WITNESS_PRELOAD = new URL\('\.\/exit-witness\.mjs', import\.meta\.url\)/) ? new URL('./exit-witness.mjs', pathToFileURL(path.join(PACKAGE_ROOT, 'process.mjs'))).href : null),
    'the preload root resolves to the exit-witness graph node');

  // The preserved (unchanged) local-server and useful-test spawn targets, read as data: each names
  // a fixed tool entrypoint inside the product's node_modules with no interpolated path.
  const serverSource = fs.readFileSync(path.join(REPO_ROOT, 'evaluator', 'local-server.mjs'), 'utf8');
  assert.ok(serverSource.includes("path.resolve(app, 'node_modules/vite/bin/vite.js')"), 'local-server entrypoint is the fixed staged vite path');
  const usefulSource = fs.readFileSync(path.join(REPO_ROOT, 'evaluator', 'useful-tests.mjs'), 'utf8');
  assert.ok(usefulSource.includes("path.join(scratch, 'node_modules/vitest/vitest.mjs')"), 'useful-tests entrypoint is the fixed staged vitest path');
  // These intended entries must exist under a real staged product: use the accepted fixture helper
  // and one stage-override probe (no tool is launched; the fake runProcess never spawns).
  const f = await createFrozenFixture(t);
  let probed = false;
  f.runtime.stageOverrides.typecheck = async context => {
    for (const tool of ['typescript/bin/tsc', 'vite/bin/vite.js', 'vitest/vitest.mjs']) {
      assert.ok(fs.existsSync(path.join(context.appRoot, 'node_modules', tool)), 'intended tool entrypoint resolves under staged node_modules: ' + tool);
    }
    probed = true;
    return { stage: 'typecheck', status: 'success', value: true, process: null };
  };
  const result = await evaluateWithRuntime(f.request, f.runtime);
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(probed, true, 'the staged node_modules probe must have run');

  // Declared limits, proven rather than asserted in prose: the runProcess seam accepts arbitrary
  // validated argv (a static graph cannot close it), and the unchanged useful module discovers
  // participant tests dynamically from the staged tests directory.
  assert.ok(/if \(!Array\.isArray\(args\) \|\| args\.some\(a => typeof a !== 'string'\)\) throw new TypeError/.test(processSource),
    'the argv seam is generic by contract: it bounds types, not a closed entrypoint set');
  assert.ok(/const extra = files\(path\.join\(app, 'tests'\)\)\.filter\(/.test(usefulSource),
    'participant-added tests are discovered at run time, not present in any static module graph');
});

test('nondestructive scanner regressions: banned template-literal and variable/interpolated loads are refused while literal package and builtin loads classify', () => {
  // These sources are parsed in memory only. Nothing named by them is resolved, imported,
  // executed, installed, served or launched; the scan touches no filesystem for them at all.
  const bannedTemplate = 'import(`dyn/${name}.mjs`);';
  const bannedVariable = 'const target = chosen; import(target); require(pkgName);';
  const bannedCreateRequireEscape = 'const { createRequire } = await import("node:module"); const r = createRequire(import.meta.url); handOff(r);';
  const allowedLiterals = [
    "import fs from 'node:fs';",
    "import { chromium } from '@playwright/test';",
    "import('./sibling.mjs');",
    "import(`node:path`);",
    "const { createRequire } = await import('node:module');",
    "const legacy = createRequire(import.meta.url);",
    "legacy('./legacy-entry.cjs');",
  ].join('\n');

  const templateScan = scanModules(bannedTemplate, 'regression-banned-template.mjs');
  assert.equal(templateScan.found.length, 0, 'an interpolated template specifier yields no resolvable edge');
  assert.equal(templateScan.unsupported.length, 1);
  assert.match(templateScan.unsupported[0].form, /variable\/concatenated\/interpolated target/);

  const variableScan = scanModules(bannedVariable, 'regression-banned-variable.mjs');
  assert.equal(variableScan.found.length, 0, 'a variable module load yields no resolvable edge');
  assert.equal(variableScan.unsupported.length, 2, 'both the dynamic variable target and the require variable target are refused: ' + JSON.stringify(variableScan.unsupported));
  assert.deepEqual(variableScan.unsupported.map(bad => bad.form).sort(),
    ['dynamic import() with variable/concatenated/interpolated target', 'require-style load with non-literal target'].sort());

  const escapeScan = scanModules(bannedCreateRequireEscape, 'regression-banned-escape.mjs');
  assert.equal(escapeScan.unsupported.length, 1, 'a require loader handed to anything other than a direct literal call is unsupported');
  assert.match(escapeScan.unsupported[0].form, /beyond a direct literal call/);

  const allowedScan = scanModules(allowedLiterals, 'regression-allowed.mjs');
  assert.deepEqual(allowedScan.unsupported, [], 'literal package/builtin/relative and bound createRequire literal loads must classify');
  assert.deepEqual(allowedScan.found.map(entry => entry.specifier),
    ['node:fs', '@playwright/test', './sibling.mjs', 'node:path', 'node:module', './legacy-entry.cjs']);
  assert.deepEqual(allowedScan.found.map(entry => entry.form), ['static', 'static', 'dynamic', 'dynamic', 'dynamic', 'require']);
  // No node_modules traversal and no new tools: the scan is pure in-memory parsing; the graph used
  // by every other test here stopped at installed boundaries as asserted above.
});
