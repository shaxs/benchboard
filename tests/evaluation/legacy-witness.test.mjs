// C4.S1.R1.P — read-only legacy source witness (review round1 finding R1-F1).
//
// This test reads the frozen legacy orchestrator runner/evaluate.mjs AS DATA with the
// already-installed pinned TypeScript compiler used strictly as a SOURCE PARSER. It NEVER imports,
// evaluates, executes, or copies that file, and no protected source text is copied into evidence,
// fixtures or assertion output — only derived structural shapes, semantic summaries and line
// numbers are reported. From the actual source STRUCTURE of the legacy evaluate() function (never
// from comments) it proves, in order: the frozen-copy loop over the submission destination; the
// four canonical-tool replacements plus the canonical-test-name overlay as one ordered per-file
// copy list with NO test-directory removal or recreation anywhere in the staging path; the
// prepared dependency copy; then tsc --noEmit → vite build → vitest run tests/contracts.test.tsx
// with the JSON reporter → localServer → unfiltered two-argument browserEvaluate →
// usefulTestsCooperative → original-source hash verification → inspectPublic(original), asserting
// the exact relevant tool arguments and the full order as one sequence.
//
// It then connects this to the new runtime's fixed order and overlay using the accepted staging
// and controller sources read the same way (their real byte-copy behavior is exercised read-only
// through the accepted T4a fixture probe in stage-order.test.mjs). Added participant test files
// survive the overlay on BOTH sides; nothing here changes the benchmark, the spine or any grade
// or count expectation to resolve wording.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_TOOLING } from '../../packages/evaluation/contracts.mjs';

// The pinned TypeScript compiler library, used ONLY as a source parser. No install, no execution
// of any parsed target, no protected code loaded into this process.
const ts = (await import(new URL('../../starter/node_modules/typescript/lib/typescript.js', import.meta.url).href)).default;
const SK = ts.SyntaxKind;

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LEGACY_PATH = path.join(REPO_ROOT, 'runner', 'evaluate.mjs');

// ---- minimal structural query toolkit over the pinned parser -----------------------------------
function parse(file) {
  const source = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(path.basename(file), source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  if (sf.parseDiagnostics.length) throw new Error('witness found ' + sf.parseDiagnostics.length + ' parse diagnostics in ' + path.basename(file) + ' at line(s) ' +
    sf.parseDiagnostics.map(d => lineOf(sf, d.start)).join(', ') + ' — refusing to witness an unparseable structure');
  return sf;
}
function lineOf(sf, pos) { let line = 0; for (const start of sf.getLineStarts()) if (start <= pos) line++; return line; }
function walk(node, visit) { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
function findAll(root, predicate) { const out = []; walk(root, node => { if (predicate(node)) out.push(node); }); return out; }
function find(root, predicate, what) {
  const hits = findAll(root, predicate);
  // A structural miss or a duplicate means the watched source no longer has the shape being
  // witnessed: the proof stops here rather than skipping the check.
  if (hits.length !== 1) throw new Error('witness structure probe failed for ' + what + ': expected exactly 1 match, found ' + hits.length +
    ' (offsets ' + hits.map(h => h.pos).join(', ') + ')');
  return hits[0];
}
const isNamed = name => node => node !== undefined && node !== null && node.kind === SK.Identifier && node.text === name;
const isString = value => node => node !== undefined && node !== null && stringOf(node) === value;
function stringOf(node) {
  if (!node) return null;
  if (node.kind === SK.StringLiteral) return node.text;
  if (node.kind === SK.FirstTemplateToken) return node.text.replace(/^[`\x22]|[`\x22]$/g, '');
  return null;
}
// Dotted structural name of an expression such as fs.copyFileSync or m.destination — a shape,
// never a source excerpt.
function expressionName(node) {
  if (node.kind === SK.Identifier) return node.text;
  if (node.kind === SK.PropertyAccessExpression && node.name) return expressionName(node.expression) + '.' + node.name.text;
  return null;
}
const callName = node => node && node.expression ? expressionName(node.expression) : null;
function callMatches(node, name, argMatchers = []) {
  if (node.kind !== SK.CallExpression || callName(node) !== name) return false;
  return argMatchers.every((matcher, index) => matcher === null || (node.arguments[index] && matcher(node.arguments[index])));
}
// Matches path.join over the whole joined path, accepting any piece at any position rather than
// insisting on one fixed argument order.
function isJoinOf(...pieces) {
  return node => node !== undefined && node !== null && callName(node) === 'path.join' &&
    pieces.every(piece => node.arguments.some(argument => (typeof piece === 'string' ? isString(piece)(argument) : piece(argument))));
}
const containsNamed = name => node => { let hit = false; walk(node, n => { if (n.kind === SK.Identifier && n.text === name) hit = true; }); return hit; };
function functionNamed(root, name) { return find(root, n => n.kind === SK.FunctionDeclaration && n.name && n.name.text === name, 'function ' + name); }

// ---- the legacy orchestrator, as data ------------------------------------------------------------
const legacyFile = parse(LEGACY_PATH);
const legacyRel = path.relative(REPO_ROOT, LEGACY_PATH).replaceAll('\\', '/');
const evaluateFn = functionNamed(legacyFile, 'evaluate');
assert.ok(evaluateFn.modifiers.some(m => m.kind === SK.AsyncKeyword), 'the legacy evaluate() is async');
// It runs a closed static module set: no dynamic import site exists anywhere inside it.
assert.equal(findAll(evaluateFn, node => node.kind === SK.CallExpression && node.expression.kind === SK.ImportKeyword).length, 0,
  'the legacy evaluate() contains no dynamic import site');

// (1) The frozen-copy loop: every destination file is copied into the fresh staged product.
const frozenCopyLoop = find(evaluateFn, node => node.kind === SK.ForOfStatement && containsNamed('copyFileSync')(node) &&
  containsNamed('destination')(node) && !containsNamed('starter')(node), 'frozen-copy loop');
// (2) The canonical overlay loop over ONE explicit ordered file list.
const overlayLoop = find(evaluateFn, node => node.kind === SK.ForOfStatement && node.expression.kind === SK.ArrayLiteralExpression &&
  containsNamed('copyFileSync')(node), 'canonical overlay loop');
const overlayElements = overlayLoop.expression.elements;
assert.equal(overlayElements.length, 5, 'the overlay list is exactly the four canonical tooling files plus the canonical-test spread, got ' + overlayElements.length);
assert.deepEqual(overlayElements.slice(0, 4).map(stringOf), ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts']);
// The fifth entry spreads the canonical tests enumerated from the canonical tests directory over
// their canonical names — a per-file copy, never a directory swap.
const overlaySpread = overlayElements[4];
assert.equal(overlaySpread.kind, SK.SpreadElement, 'the fifth overlay entry is the spread tests mapping');
find(overlaySpread, node => callMatches(node, 'path.join', [isNamed('root'), isString('starter/tests')]), 'canonical starter-tests enumeration');
const overlayCopy = find(overlayLoop, node => callMatches(node, 'fs.copyFileSync'), 'overlay per-file copy');
assert.ok(isJoinOf(isNamed('root'), 'starter')(overlayCopy.arguments[0]), 'the overlay copy source is always the canonical starter tree');
assert.ok(isJoinOf(isNamed('app'))(overlayCopy.arguments[1]), 'the overlay copy destination is the staged product');
// No test-directory removal or recreation anywhere in the staging path: the whole legacy
// evaluate() carries no directory-removal primitive at all, so any extra file in the product
// (for example a participant-added test) survives the overlay untouched.
for (const removed of ['rmSync', 'rmdirSync', 'unlinkSync', 'rimraf']) {
  assert.equal(findAll(evaluateFn, node => node.kind === SK.CallExpression && callName(node) === 'fs.' + removed).length, 0, 'the legacy staging path carries no fs.' + removed);
}
// (3) The prepared dependency copy.
const dependencyCopy = find(evaluateFn, node => callMatches(node, 'fs.cpSync',
  [isJoinOf(isNamed('root'), 'starter/node_modules'), isJoinOf(isNamed('app'), 'node_modules')]), 'prepared dependency copy');

// (4) The fixed tool-run helper: Node runs the tool file resolved under the product node_modules
// with the product as cwd and the 300000ms bound; caller args ride unchanged.
const runHelper = find(evaluateFn, node => node.kind === SK.VariableDeclaration && node.name && node.name.text === 'run' &&
  node.initializer && node.initializer.kind === SK.ArrowFunction, 'the run(tool, args) helper');
const runSpawn = find(runHelper.initializer, node => callMatches(node, 'spawnSync'), 'spawnSync inside the run helper');
assert.ok(expressionName(runSpawn.arguments[0]) === 'process.execPath', 'tools run under the Node executable, never a shell');
const spawnArgv = runSpawn.arguments[1];
assert.ok(spawnArgv.kind === SK.ArrayLiteralExpression, 'the spawn argv is one explicit list');
assert.ok(isJoinOf(isNamed('app'), 'node_modules')(spawnArgv.elements[0]), 'the tool entrypoint resolves under the product node_modules');
assert.equal(runSpawn.arguments[1].elements[1].kind, SK.SpreadElement, 'caller args ride unchanged after the fixed tool entrypoint');
const runOptions = runSpawn.arguments[2];
const timeoutProperty = runOptions.properties.find(p => p.name && p.name.text === 'timeout');
assert.ok(timeoutProperty && Number(timeoutProperty.initializer.text) === 300000, 'the legacy per-tool bound is 300000ms');

// (5) Stage invocation sites and their exact relevant arguments.
function toolCall(tool) {
  return find(evaluateFn, node => node.kind === SK.CallExpression && callName(node) === 'run' && isString(tool)(node.arguments[0]), 'run(' + tool + ') call');
}
const typecheckCall = toolCall('typescript/bin/tsc');
const buildCall = toolCall('vite/bin/vite.js');
const visibleCall = toolCall('vitest/vitest.mjs');
assert.deepEqual(typecheckCall.arguments[1].elements.map(stringOf), ['--noEmit'], 'the typecheck tool argument');
assert.deepEqual(buildCall.arguments[1].elements.map(stringOf), ['build'], 'the build tool argument');
const visibleArgs = visibleCall.arguments[1].elements;
assert.deepEqual(visibleArgs.slice(0, 3).map(stringOf), ['run', 'tests/contracts.test.tsx', '--reporter=json'], 'the visible test name and JSON reporter');
assert.ok(visibleArgs[3].kind === SK.BinaryExpression && stringOf(visibleArgs[3].left) === '--outputFile=' && isNamed('visibleFile')(visibleArgs[3].right),
  'the visible invocation writes the JSON report to the requested output file');
find(evaluateFn, node => node.kind === SK.VariableDeclaration && node.name && node.name.text === 'visibleFile' &&
  callMatches(node.initializer, 'path.join', [isNamed('out'), isString('visible.json')]), 'the visible.json report path');
const serverCall = find(evaluateFn, node => callMatches(node, 'localServer', [isNamed('app')]), 'localServer(app)');
const browserCall = find(evaluateFn, node => callMatches(node, 'browserEvaluate'), 'browserEvaluate');
assert.equal(browserCall.arguments.length, 2, 'browserEvaluate takes exactly two arguments — no property filter exists in the call shape');
assert.ok(expressionName(browserCall.arguments[0]) === 'server.url', 'the first browser argument is the loopback server URL');
assert.ok(callName(browserCall.arguments[1]) === 'path.join' && isString('browser')(browserCall.arguments[1].arguments[1]), 'the second browser argument is the browser artifact directory');
const browserTry = find(evaluateFn, node => node.kind === SK.TryStatement && containsNamed('browserEvaluate')(node), 'the browser try/finally block');
assert.ok(browserTry.finallyBlock && findAll(browserTry.finallyBlock, node => callMatches(node, 'server.close')).length === 1, 'the acquired server is closed in the finally arm');
const usefulCall = find(evaluateFn, node => callMatches(node, 'usefulTestsCooperative'), 'usefulTestsCooperative');
assert.ok(isNamed('app')(usefulCall.arguments[0]), 'useful tests run on the staged product');
assert.ok(callName(usefulCall.arguments[1]) === 'path.join' && isString('useful-tests')(usefulCall.arguments[1].arguments[1]), 'useful tests get their own artifact directory');
// Original-source hash verification: the tree hash of the ORIGINAL destination is compared to the
// hash taken before staging, and inspectPublic receives that same original destination.
const hashCheck = find(evaluateFn, node => node.kind === SK.IfStatement && containsNamed('tree')(node) && containsNamed('destination')(node) && containsNamed('sourceHash')(node),
  'the submission hash verification');
const inspectCall = find(evaluateFn, node => callMatches(node, 'inspectPublic', [node => expressionName(node) === 'm.destination']), 'inspectPublic(m.destination)');

// The full order, asserted as ONE list: every located node lies in the single sequential evaluate()
// body, so its start offset is its sequence position.
const witnessOrder = [
  ['copy-frozen', frozenCopyLoop], ['canonical-replacement', overlayLoop], ['prepared-dependencies', dependencyCopy],
  ['typecheck', typecheckCall], ['build', buildCall], ['visible', visibleCall],
  ['localServer', serverCall], ['browserEvaluate', browserCall], ['useful', usefulCall],
  ['hash-verify', hashCheck], ['inspectPublic', inspectCall],
];
test('the read-only legacy witness proves the frozen-copy, canonical overlay and dependency sequence from actual source structure', () => {
  const located = witnessOrder.map(([name, node]) => ({ name, at: node.pos, line: lineOf(legacyFile, node.pos) }));
  assert.deepEqual(located.map(entry => entry.name), witnessOrder.map(([name]) => name), 'the witness sequence must be the located legacy sequence');
  for (const [left, right] of located.slice(1).map((entry, index) => [located[index], entry])) {
    assert.ok(left.at < right.at, 'order violation in ' + legacyRel + ': ' + left.name + ' (line ' + left.line + ') must precede ' + right.name + ' (line ' + right.line + ')');
  }
});

test('the read-only legacy witness proves the evidence assembly over exactly the accepted fields', () => {
  const evidenceObject = find(evaluateFn, node => node.kind === SK.ObjectLiteralExpression && node.properties.some(p => p.name && p.name.text === 'visiblePassed'), 'the evidence assembly object');
  // A spread of a call reports its callee name — the derived shape, never source text.
  const fields = evidenceObject.properties.map(p => p.kind === SK.SpreadAssignment
    ? '...' + (p.expression.kind === SK.CallExpression ? callName(p.expression) : expressionName(p.expression))
    : p.name.text);
  assert.deepEqual(fields, ['visiblePassed', 'hidden', 'typecheck', 'build', 'usefulTests', '...inspectPublic'],
    'the legacy evidence assembly carries exactly the accepted fields, inspectPublic spread last');
  // inspectPublic appears exactly once and takes the ORIGINAL destination, never the staged copy.
  assert.equal(findAll(evaluateFn, node => callMatches(node, 'inspectPublic')).length, 1, 'inspectPublic is called once, on the original');
  assert.ok(inspectCall.pos > hashCheck.pos, 'inspection follows the hash verification (lines ' + lineOf(legacyFile, hashCheck.pos) + ' then ' + lineOf(legacyFile, inspectCall.pos) + ')');
});

// ---- connection to the new runtime's fixed order and overlay (read the same way) ------------------
const stagingFile = parse(path.join(REPO_ROOT, 'packages', 'evaluation', 'staging.mjs'));
const stagingSource = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'evaluation', 'staging.mjs'), 'utf8');
const controllerSource = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'evaluation', 'controller.mjs'), 'utf8');

test('the runtime keeps the same fixed order and the same overlay semantics so participant-added tests survive on both sides', () => {
  // The runtime canonical tooling list equals the legacy overlay tools (same names, same order).
  assert.deepEqual(CANONICAL_TOOLING, overlayElements.slice(0, 4).map(stringOf), 'runtime canonical tooling equals the legacy overlay list');
  // The runtime stage order mirrors the witnessed legacy order.
  for (const event of ['copy-frozen', 'canonical-replacement', 'prepared-dependencies']) {
    assert.ok(stagingSource.includes("event('" + event + "'"), 'runtime staging emits ' + event);
  }
  assert.ok(stagingSource.indexOf("event('copy-frozen'") < stagingSource.indexOf("event('canonical-replacement'"), 'the runtime copies frozen bytes before canonical replacement');
  assert.ok(stagingSource.indexOf("event('canonical-replacement'") < stagingSource.indexOf("event('prepared-dependencies'"), 'the runtime replaces canonical files before prepared dependencies');
  assert.ok(/for \(const stage of \['typecheck', 'build', 'visible', 'browser', 'useful'\]\)/.test(controllerSource), 'the runtime tool-stage order is fixed');
  assert.ok(/observe\('verify-after'/.test(controllerSource) && /observe\('inspection'/.test(controllerSource), 'the runtime verifies then inspects after the useful stage');
  // The runtime overlay is the same per-file form: the four canonical tooling files and the full
  // canonical tests scan are file-copied over the copied frozen tree entry by entry.
  assert.ok(/for \(const name of CANONICAL_TOOLING\)/.test(stagingSource) && /canonicalFile\(claim, source, path\.join\(claim\.appRoot, name\)\)/.test(stagingSource),
    'runtime canonical tooling is a per-file overlay over canonical names');
  assert.ok(/const canonicalTests = scan\(path\.join\(canonicalRoot, 'tests'\)\);/.test(stagingSource) && /canonicalFile\(claim, path\.join\(canonicalRoot, 'tests', entry\.path\), to\)/.test(stagingSource),
    'runtime canonical tests are a per-file overlay over canonical names');
  // Inside the runtime stageFrozen function (the staging path, not cleanup) there is likewise no
  // removal primitive: an added participant test file outside the canonical names survives.
  const stageFrozenFn = functionNamed(stagingFile, 'stageFrozen');
  for (const removed of ['rmSync', 'rmdirSync', 'unlinkSync']) {
    assert.equal(findAll(stageFrozenFn, node => callName(node) === 'fs.' + removed).length, 0, 'the runtime stageFrozen path carries no fs.' + removed);
  }
  // The byte-level proof that the real runtime overlay preserves added tests and replaces only the
  // canonical bytes is the accepted T4a probe in stage-order.test.mjs, which drives the real staging
  // helper through the accepted fixture (reused read-only; unchanged here).
});
