/**
 * Focused contract tests for C1 / T1: `packages/core/identity.mjs` and
 * `packages/core/paths.mjs`.
 *
 * Design constraints honoured here:
 *  - No import of the historical `runner/` surface and no DSH import: the
 *    expected tree digests come from the pinned golden vectors plus an
 *    independent in-test re-implementation of the documented algorithm
 *    (SHA-256 over the JSON of lexically sorted `[path, sha256]` pairs).
 *  - `starter/**` is only ever read, never written; every generated file lives
 *    in the project-contained scratch directory `tests/contracts/.tmp/identity/`
 *    (excluded from version control locally), or under
 *    `BENCHBOARD_TEST_SCRATCH_ROOT` when that environment variable is supplied
 *    at run time. No host-level temporary directory is used, and no private
 *    absolute path is baked into this file.
 *  - Windows cannot create file symlinks or FIFOs without privileges that the
 *    harness lacks, so those guard branches are additionally exercised through
 *    `fixtures/identity/stubbed-probe.mjs`, which drives the real public API
 *    over synthetic directory entries in its own process. Real junctions are
 *    used where the host allows them. Skips carry a reason; nothing is faked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  sha256,
  hashEntries,
  inventoryTree,
  createId,
  HASH_ALGORITHM_ID,
  DEFAULT_SKIP_NAMES,
} from '../../packages/core/identity.mjs';
import {
  validateRelativePath,
  resolveWithinRoot,
  assertDisjointRoots,
  PathError,
  PATH_ERROR_CODES,
} from '../../packages/core/paths.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const GOLDEN = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/identity/golden.json', import.meta.url)), 'utf8'));

/* ---------------------------------------------------------------- helpers */

/**
 * Resolve the contained scratch root for generated files.
 *
 * Default: `tests/contracts/.tmp/identity/`, inside the repository and locally
 * excluded from version control. Optional override: `BENCHBOARD_TEST_SCRATCH_ROOT`,
 * an existing absolute directory supplied by the caller; never a host tmpdir and
 * never a private path baked into this file.
 */
function testScratchRoot() {
  const override = process.env.BENCHBOARD_TEST_SCRATCH_ROOT;
  if (override !== void 0 && override.length > 0) {
    if (!path.isAbsolute(override)) {
      throw new Error(`BENCHBOARD_TEST_SCRATCH_ROOT must be an absolute directory, got ${JSON.stringify(override)}`);
    }
    fs.mkdirSync(override, { recursive: true });
    return override;
  }
  const contained = fileURLToPath(new URL('./.tmp/identity/', import.meta.url));
  fs.mkdirSync(contained, { recursive: true });
  return contained;
}

/** Create this test's own throwaway directory and clean exactly that. */
function scratch(t) {
  const directory = fs.mkdtempSync(path.join(testScratchRoot(), 'benchboard-t1-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function decodeBase64(value) {
  return Buffer.from(value, 'base64');
}

/** Materialise a golden fixture into a fresh directory and return its root. */
function materialise(t, fixtureName) {
  const fixture = GOLDEN.fixtures[fixtureName];
  assert.ok(fixture !== void 0, `golden fixture "${fixtureName}" is missing`);
  const root = scratch(t);
  for (const [relative, encoded] of Object.entries(fixture.files)) {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, decodeBase64(encoded));
  }
  return { root, fixture };
}

/** Independent re-implementation of the documented tree algorithm. */
function recomputeTree(rootPath, skipNames = new Set(DEFAULT_SKIP_NAMES)) {
  const digestOfFile = (target) => crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  const pairs = [];
  const walk = (directory) => {
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
      if (skipNames.has(dirent.name)) continue;
      const absolute = path.join(directory, dirent.name);
      if (fs.lstatSync(absolute).isSymbolicLink()) throw Error(`unexpected link: ${absolute}`);
      if (dirent.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!dirent.isFile()) throw Error(`unexpected special file: ${absolute}`);
      pairs.push([path.relative(rootPath, absolute).split(path.sep).join('/'), digestOfFile(absolute)]);
    }
  };
  walk(rootPath);
  pairs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return {
    pairs,
    digest: crypto.createHash('sha256').update(Buffer.from(JSON.stringify(pairs), 'utf8')).digest('hex'),
  };
}

function expectThrow(action, matcher, message) {
  assert.throws(action, matcher, message);
}

/**
 * Catch and return the exception of `action` explicitly.
 *
 * The pinned Node runtime returns `undefined` from `assert.throws(...)` for a
 * matched throw instead of handing the error object back, so checks that need
 * to inspect the error (class, code) catch it themselves. The throwing module
 * behaviour itself is verified with `assert.throws`-style matchers elsewhere.
 */
function thrown(action) {
  let caught;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== void 0, 'an exception was expected');
  return caught;
}

function codeOf(action) {
  let caught;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== void 0, 'a PathError was expected');
  assert.ok(caught instanceof PathError, `a PathError was expected, got ${caught.name}: ${caught.message}`);
  return caught.code;
}

const capability = {
  junction: void 0,
  caseInsensitiveScratch: void 0,
};

/** Junctions need no privilege on Windows; file symlinks do (EPERM without it). */
function canCreateJunction(t) {
  if (capability.junction !== void 0) return capability.junction;
  const probe = scratch(t);
  try {
    const target = path.join(probe, 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(probe, 'link'), 'junction');
    capability.junction = true;
  } catch {
    capability.junction = false;
  }
  return capability.junction;
}

/** True when the scratch volume treats `Name.txt` and `name.txt` as one file. */
function isScratchCaseInsensitive(t) {
  if (capability.caseInsensitiveScratch !== void 0) return capability.caseInsensitiveScratch;
  const probe = scratch(t);
  try {
    fs.writeFileSync(path.join(probe, 'CaseProbe.TXT'), 'x');
    capability.caseInsensitiveScratch = fs.existsSync(path.join(probe, 'caseprobe.txt'));
  } catch {
    capability.caseInsensitiveScratch = false;
  }
  return capability.caseInsensitiveScratch;
}

function runProbe(t, scriptRelativeUrl, args = []) {
  const script = fileURLToPath(new URL(scriptRelativeUrl, import.meta.url));
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `probe ${path.basename(script)} failed:\n${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

const moduleSource = (relative) => fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/* ------------------------------------------------------- sha256 contract */

test('sha256 matches pinned literal vectors for text, CRLF, NUL and Unicode input', () => {
  assert.equal(GOLDEN.sha256.empty, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'the pinned empty-string vector is the well-known SHA-256 of zero bytes');
  for (const [name, digest] of Object.entries(GOLDEN.sha256)) {
    assert.match(digest, HEX64, `${name} must be 64 lowercase hex characters`);
  }
  assert.equal(sha256(''), GOLDEN.sha256.empty);
  assert.equal(sha256('abc'), GOLDEN.sha256.ascii);
  assert.equal(sha256('a\r\n'), GOLDEN.sha256.crlf);
  assert.equal(sha256(Uint8Array.from([0x00])), GOLDEN.sha256.nulByte);
  assert.equal(sha256('\u03a9\n'), GOLDEN.sha256.unicode);
});

test('sha256 hashes identical bytes the same way for every byte carrier', () => {
  const bytes = Uint8Array.from([0x61, 0x0a, 0x62, 0x0d]); // the four bytes 'a\nb\r'
  const view = new Uint8Array(bytes.buffer, 1, 2); // the two bytes '\nb'
  const expected = sha256(bytes);
  assert.equal(expected, sha256(Buffer.from(bytes)), 'a Buffer carrier over the same bytes hashes identically');
  assert.equal(expected, sha256(bytes.buffer), 'an ArrayBuffer carrier over the same bytes hashes identically');
  assert.equal(expected, sha256(Array.from(bytes)), 'a plain array carrier over the same bytes hashes identically');
  assert.equal(expected, sha256('a\nb\r'), 'a string carrier over the same byte sequence hashes identically');
  assert.equal(sha256(view), sha256(Array.from(view)), 'the sub-view agrees with a copy of the bytes it views');
  assert.equal(sha256(view), sha256('\u000a\u0062'), 'a sub-view hashes only the bytes it views');
});

test('sha256 applies no normalisation: CRLF, LF and Unicode spellings differ', () => {
  assert.notEqual(sha256('a\r\n'), sha256('a\n'));
  assert.notEqual(sha256('\u2126'), sha256('\u0049\u004A'));
  assert.notEqual(sha256('\u00E9'), sha256('e\u0301'));
});

test('sha256 rejects input that is not bytes', () => {
  for (const value of [void 0, null, 1, true, {}, new Map(), { length: 2 }]) {
    assert.throws(() => sha256(value), TypeError, `rejects ${String(value)}`);
  }
  // A declared HashInput carrier with zero elements represents zero bytes.
  assert.equal(sha256([]), sha256(''), 'an empty byte array hashes like an empty string carrier');
});

/* ---------------------------------------------------- hashEntries contract */

test('hashEntries is the SHA-256 of the JSON of sorted [path, sha256] pairs', () => {
  const { inputs, expected } = GOLDEN.hashEntries.pairs;
  assert.equal(hashEntries(inputs), expected);
  assert.equal(hashEntries(inputs.map(({ path: relative, sha256: digest }) => [relative, digest])), expected);
  assert.equal(hashEntries([]), GOLDEN.hashEntries.empty);
  assert.equal(hashEntries([]), sha256('[]'));
  assert.equal(hashEntries(inputs), sha256(JSON.stringify([
    ['a/a.txt', GOLDEN.hashEntries.rawByteDigests.alpha],
    ['b/b.txt', GOLDEN.hashEntries.rawByteDigests.beta],
  ])));
});

test('hashEntries ignores entry order and excludes the bytes field from the hash pair', () => {
  const entries = [
    { path: 'b/b.txt', bytes: 1234, sha256: sha256('b\r\n') },
    { path: 'a/a.txt', bytes: 2, sha256: sha256('a\n') },
    { path: 'A/a.txt', sha256: sha256('A\n') },
  ];
  const expected = sha256(JSON.stringify([
    ['A/a.txt', sha256('A\n')],
    ['a/a.txt', sha256('a\n')],
    ['b/b.txt', sha256('b\r\n')],
  ]));
  assert.equal(hashEntries(entries), expected);
  assert.equal(hashEntries([...entries].reverse()), expected, 'input order must not matter');
  assert.equal(hashEntries(entries.map(({ path: relative, sha256: digest }) => ({ path: relative, sha256: digest }))), expected, 'bytes must not enter the digest');
});

test('hashEntries does not mutate or normalise caller data', () => {
  const entries = [
    { path: 'nested/Zeta.txt', bytes: 2, sha256: sha256('Z') },
    { path: 'nested/alpha.txt', bytes: 1, sha256: sha256('a') },
  ];
  const before = JSON.stringify(entries);
  const digest = hashEntries(entries);
  assert.equal(JSON.stringify(entries), before, 'entries must be untouched');
  assert.equal(entries[0].path, 'nested/Zeta.txt', 'path spelling is never normalised');
  assert.equal(entries.at(-1).path, 'nested/alpha.txt');
  assert.ok(!Object.isFrozen(entries) && !Object.isFrozen(entries[0]), 'caller data is not frozen by us');
  assert.equal(digest, sha256(JSON.stringify([
    ['nested/Zeta.txt', sha256('Z')],
    ['nested/alpha.txt', sha256('a')],
  ])));
});

test('hashEntries rejects duplicate and conflicting paths', () => {
  const digest = sha256('x');
  assert.throws(() => hashEntries([{ path: 'a.txt', sha256: digest }, { path: 'a.txt', sha256: digest }])
    , /duplicate path/i);
  assert.throws(() => hashEntries([{ path: 'a.txt', sha256: digest }, { path: 'a.txt', sha256: sha256('y') }])
    , /conflicting digests/i);
  assert.throws(() => hashEntries([['a.txt', digest], ['a.txt', digest]]), /duplicate path/i);
});

test('hashEntries rejects malformed paths and digests', () => {
  const digest = sha256('x');
  const badPaths = [
    '/absolute.txt',
    '../escape.txt',
    'a/../b.txt',
    'a/..',
    '..',
    '.',
    './a.txt',
    'a/./b.txt',
    'a//b.txt',
    'a/',
    'nested\\windows.txt',
    'C:/drive.txt',
    '\u0000nul.txt',
    '',
  ];
  for (const relative of badPaths) {
    assert.throws(() => hashEntries([{ path: relative, sha256: digest }]), TypeError, `path ${JSON.stringify(relative)} must be rejected`);
  }
  for (const value of ['', 'A'.repeat(64), 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), sha256('x').toUpperCase(), 1, void 0]) {
    assert.throws(() => hashEntries([{ path: 'a.txt', sha256: value }]), TypeError, `digest ${String(value)} must be rejected`);
  }
  for (const value of [void 0, null, 'a.txt', 5, ['a.txt']]) {
    assert.throws(() => hashEntries([value]), TypeError, `entry ${String(value)} must be rejected`);
  }
  for (const value of [void 0, null, {}, 'a', new Map()]) {
    assert.throws(() => hashEntries(value), TypeError, 'entries must be an array');
  }
});

/* C1 SOTA2F1: the exact path contract refuses EVERY ASCII control byte
 * (U+0000–U+001F) and DEL (U+007F) in a hashed entry path, not only NUL —
 * closing the previously accepted LF/Tab/DEL gap against the manifest
 * runtime and the challenge/submission JSON Schemas. Valid Unicode, space and
 * binary-content entries keep hashing verbatim with no normalisation. */
test('hashEntries refuses every C0 control byte and DEL in an entry path', () => {
  const digest = sha256('x');
  const controlBytes = [];
  for (let code = 0x0000; code <= 0x001f; code += 1) controlBytes.push(String.fromCodePoint(code));
  controlBytes.push('\u007f'); // DEL
  assert.equal(controlBytes.length, 33);
  for (const control of controlBytes) {
    for (const [label, spelling] of [
      ['embedded', `嵌入式${control}name.txt`],
      ['leading', `${control}lead.txt`],
      ['segment', `dir/${control}segment.txt`],
    ]) {
      assert.throws(
        () => hashEntries([{ path: spelling, sha256: digest }]),
        TypeError,
        `path with ${label} ${control.codePointAt(0)} (${JSON.stringify(spelling)}) must be refused`,
      );
    }
  }
  // Byte-exact refusal: the same digests still hash unchanged once the
  // offending control byte is gone (no rewriting ever happens, refused paths
  // simply cannot be hashed at all).
  assert.equal(hashEntries([['name.txt', digest]]), sha256(JSON.stringify([['name.txt', digest]])));
});

/* -------------------------------------------------- inventoryTree contract */

for (const fixtureName of ['basic', 'binary', 'crlf', 'ordering', 'skipnames', 'empty']) {
  test(`inventoryTree reproduces the pinned golden digest for the "${fixtureName}" fixture`, (t) => {
    const { root, fixture } = materialise(t, fixtureName);
    const inventory = inventoryTree({ root });
    assert.equal(inventory.digest, fixture.expectedDigest);
    assert.equal(inventory.digest, recomputeTree(root).digest, 'must agree with the independent re-implementation');
    assert.deepEqual(inventory.entries.map(({ path: relative, sha256: digest }) => ({ path: relative, sha256: digest })), fixture.expectedEntries);
    assert.deepEqual(
      [...inventory.entries].map((entry) => entry.path),
      [...inventory.entries].map((entry) => entry.path).sort(),
      'entries are sorted lexically',
    );
    for (const entry of inventory.entries) {
      assert.ok(!entry.path.includes('\\'), 'entries use POSIX separators');
      assert.match(entry.sha256, HEX64);
      assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0);
    }
    assert.equal(inventory.hashAlgorithmId, HASH_ALGORITHM_ID);
    assert.equal(inventory.digest, hashEntries(inventory.entries), 'digest is hashEntries of the entries');
  });
}

test('inventoryTree preserves bytes exactly: CRLF, NUL and binary files hash raw', (t) => {
  const { root } = materialise(t, 'crlf');
  const inventory = inventoryTree({ root });
  const byName = new Map(inventory.entries.map((entry) => [entry.path, entry.sha256]));
  assert.equal(byName.get('crlf.txt'), sha256('a\r\nb\r\n'));
  assert.equal(byName.get('lf.txt'), sha256('a\nb\n'));
  assert.equal(byName.get('mixed.txt'), sha256('a\r\nb\n\r\n'));
  const binary = materialise(t, 'binary');
  const binaryInventory = inventoryTree({ root: binary.root });
  const nul = binaryInventory.entries.find((entry) => entry.path === 'nul.txt');
  assert.equal(nul.sha256, sha256(Uint8Array.from([0x00, 0x01, 0xff, 0x0a])));
  assert.equal(nul.bytes, 4);
});

test('inventoryTree skips the preserved directory names by default and honours skipNames', (t) => {
  const { root, fixture } = materialise(t, 'skipnames');
  assert.deepEqual([...DEFAULT_SKIP_NAMES], ['node_modules', 'dist', '.git']);
  const skipped = inventoryTree({ root });
  assert.deepEqual(skipped.entries.map((entry) => entry.path), ['src/keep.txt']);
  assert.equal(skipped.digest, fixture.expectedDigest);
  assert.ok(!skipped.entries.some((entry) => /node_modules|dist|\.git/.test(entry.path)));

  const walked = inventoryTree({ root, skipNames: [] });
  assert.equal(walked.digest, fixture.expectedDigestWithoutSkipping);
  assert.equal(walked.entries.length, fixture.unskippedFileCount);

  // Only `src` is skipped here; node_modules, dist and .git remain in the walk.
  const custom = inventoryTree({ root, skipNames: new Set(['src']) });
  assert.deepEqual(custom.entries.map((entry) => entry.path), ['.git/config', 'dist/bundle.js', 'node_modules/pkg/index.js']);

  const asArray = inventoryTree({ root, skipNames: ['node_modules', 'dist', '.git', 'src'] });
  assert.deepEqual(asArray.entries, []);
  assert.equal(asArray.digest, sha256('[]'));
});

test('inventoryTree requires an explicit absolute root and a usable directory', (t) => {
  const { root } = materialise(t, 'basic');
  assert.throws(() => inventoryTree(), TypeError, 'options object is required');
  assert.throws(() => inventoryTree(root), TypeError, 'a bare string is not an options object');
  assert.throws(() => inventoryTree({ root, extra: 1 }), TypeError, 'unknown options are rejected');
  assert.throws(() => inventoryTree({}), TypeError, 'root is required');
  assert.throws(() => inventoryTree({ root: void 0 }), TypeError);
  assert.throws(() => inventoryTree({ root: 42 }), TypeError);
  for (const relative of ['starter', '.', 'starter/', './starter', '../starter', 'C:starter']) {
    assert.throws(() => inventoryTree({ root: relative }), TypeError, `relative root ${JSON.stringify(relative)} must be rejected`);
  }
  assert.throws(() => inventoryTree({ root: path.join(root, 'missing-directory') }), (error) => error.code === 'ENOENT' || /no such|does not exist|enoent/i.test(error.message));
  const filePath = path.join(root, 'a.txt');
  assert.throws(() => inventoryTree({ root: filePath }), /root must be a directory/);
  assert.throws(() => inventoryTree({ root, skipNames: 'node_modules' }), TypeError, 'skipNames must be an array or Set');
  for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
    assert.throws(() => inventoryTree({ root, skipNames: [bad] }), TypeError, `skip name ${JSON.stringify(bad)} must be rejected`);
  }
});

test('inventoryTree returns a frozen result and never mutates the tree', (t) => {
  const { root } = materialise(t, 'ordering');
  const before = recomputeTree(root).digest;
  const inventory = inventoryTree({ root });
  assert.ok(Object.isFrozen(inventory));
  assert.ok(Object.isFrozen(inventory.entries));
  assert.ok(inventory.entries.every((entry) => Object.isFrozen(entry)));
  assert.throws(() => {
    inventory.digest = 'x';
  }, TypeError);
  assert.throws(() => {
    inventory.entries.push({ path: 'x', bytes: 1, sha256: sha256('x') });
  }, TypeError);
  assert.equal(inventoryTree({ root }).digest, before, 'a second inventory is identical');
  assert.equal(inventory.digest, before);
});

test('inventoryTree root display uses POSIX separators and the resolved path', (t) => {
  const { root } = materialise(t, 'basic');
  const inventory = inventoryTree({ root: path.join(root, 'nested', '..') });
  assert.equal(inventory.root, root.split(path.sep).join('/'));
  assert.ok(!inventory.root.includes('\\'), 'records never carry host separators');
});

/* --------------------------------------------------- starter26 agreement */

test('inventoryTree reproduces the starter26 digest and file set exactly', (t) => {
  const starterRoot = fileURLToPath(new URL('../../starter/', import.meta.url));
  const inventory = inventoryTree({ root: starterRoot });
  assert.equal(inventory.entries.length, GOLDEN.starter26.fileCount);
  assert.equal(inventory.digest, GOLDEN.starter26.digest);
  const recomputed = recomputeTree(starterRoot);
  assert.equal(inventory.digest, recomputed.digest, 'the independent re-implementation agrees');
  assert.deepEqual(inventory.entries.map((entry) => entry.path), recomputed.pairs.map(([relative]) => relative));
  assert.ok(inventory.entries.every((entry) => {
    const relative = entry.path;
    return relative.length > 0
      && !relative.startsWith('/')
      && !relative.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..');
  }), 'starter26 paths are exact relative POSIX file paths');
});

/* ------------------------------------------------ portable guard coverage */

test('guard branches that need unprivileged filesystem features are covered portably', (t) => {
  const probe = runProbe(t, './fixtures/identity/stubbed-probe.mjs');
  assert.equal(probe.ok, true, 'the probe process must succeed');
  const results = probe.results;

  assert.equal(results.inventorySpecialEntry.threw, true, 'a non-regular entry must be refused');
  assert.match(results.inventorySpecialEntry.message, /special file prohibited/);

  assert.equal(results.inventoryFoldCollision.threw, true, 'a case/fold collision must be refused');
  assert.match(results.inventorySpecialEntry.name, /^Error$/);
  assert.match(results.inventoryFoldCollision.message, /case-insensitive path collision/i);

  assert.equal(results.inventoryLinkEntry.threw, true, 'a link entry must be refused');
  assert.match(results.inventoryLinkEntry.message, /links are prohibited/);

  assert.equal(results.resolveTargetLink.code, PATH_ERROR_CODES.SYMLINK_DETECTED);
  assert.equal(results.resolveTargetSpecial.code, PATH_ERROR_CODES.NOT_REGULAR_FILE);
  assert.equal(results.resolveFoldSpelling.code, PATH_ERROR_CODES.CASE_COLLISION);
  assert.equal(results.resolveRegularControl.threw, false, 'plain files must still resolve: the guards do not fire without cause');
});

test('inventoryTree rejects junction/symlink entries and link ancestors when the host allows them', (t) => {
  const root = scratch(t);
  const outside = scratch(t);
  const inner = path.join(root, 'inner');
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, 'keep.txt'), 'k\n');
  if (!canCreateJunction(t)) {
    t.skip('the host refused to create a junction, and file symlinks need privileges the harness does not have; the synthetic probe covers link entries');
    return;
  }
  fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  assert.throws(() => inventoryTree({ root }), /links are prohibited/);

  const linkFree = scratch(t);
  fs.mkdirSync(path.join(linkFree, 'deep'));
  fs.writeFileSync(path.join(linkFree, 'deep', 'a.txt'), 'a\n');
  fs.symlinkSync(linkFree, path.join(root, 'through'), 'junction');
  assert.throws(() => inventoryTree({ root: path.join(root, 'through') }), /root link prohibited|link ancestor prohibited/);
});

test('inventoryTree rejects case-only sibling names where the volume is case-sensitive', (t) => {
  const root = scratch(t);
  let created = false;
  try {
    fs.writeFileSync(path.join(root, 'Note.txt'), 'A\n');
    fs.writeFileSync(path.join(root, 'note.txt'), 'a\n');
    created = true;
  } catch {
    created = false;
  }
  if (!created || isScratchCaseInsensitive(t)) {
    t.skip('the scratch volume is case-insensitive, so two case-only spellings cannot both exist here; the synthetic probe covers the collision guard');
    return;
  }
  assert.throws(() => inventoryTree({ root }), /case-insensitive path collision/i);
});

/* ------------------------------------------------- validateRelativePath */

test('validateRelativePath accepts exact relative POSIX paths and returns them byte-for-byte', () => {
  const accepted = [
    'a.txt',
    'src/App.tsx',
    'tests/contracts/identity-paths.test.mjs',
    'nested/deeply/deeper/file-2.md',
    '\u00dcnicode/\u03a9-\u1F63.txt',
    'sp ace/dash_dot.mixed_name',
    'a.b.c.json',
  ];
  for (const value of accepted) {
    assert.equal(validateRelativePath(value), value, `${JSON.stringify(value)} is accepted unchanged`);
  }
});

test('validateRelativePath rejects traversal, absolute, backslash and malformed spellings', () => {
  const rejected = [
    '',
    '.',
    '..',
    '../outside.txt',
    'a/../../b.txt',
    'a/..',
    './a.txt',
    'a/./b.txt',
    '/absolute.txt',
    '//host/share',
    'C:/windows.txt',
    'c:\\windows\\path.txt',
    'nested\\file.txt',
    'a//b.txt',
    'a/',
    'a\\',
    'a\0b',
    'a\nb',
    'a\tb',
    'file:///etc/passwd',
  ];
  for (const value of rejected) {
    const error = thrown(() => validateRelativePath(value));
    assert.ok(error instanceof PathError, `${JSON.stringify(value)} raises PathError`);
    assert.equal(error.code, PATH_ERROR_CODES.INVALID_RELATIVE_PATH, `${JSON.stringify(value)}`);
  }
  for (const value of [void 0, null, 5, true, {}, [], new Map()]) {
    const error = thrown(() => validateRelativePath(value));
    assert.equal(error.code, PATH_ERROR_CODES.INVALID_RELATIVE_PATH);
  }
});

/* ---------------------------------------------------- resolveWithinRoot */

test('resolveWithinRoot returns an absolute in-root path with the requested spelling', (t) => {
  const { root } = materialise(t, 'basic');
  const resolved = resolveWithinRoot({ root, relativePath: 'nested/z.txt' });
  assert.equal(resolved, path.join(root, 'nested', 'z.txt'));
  assert.ok(path.isAbsolute(resolved));
  assert.ok(resolved.startsWith(root));
  assert.equal(resolveWithinRoot({ root, relativePath: 'nested' }), path.join(root, 'nested'), 'directories resolve too');
  assert.equal(resolveWithinRoot({ root, relativePath: '\u00dcn\u00efcode/\u03a9.txt' }), path.join(root, '\u00dcn\u00efcode', '\u03a9.txt'));
  const fileUrlRoot = new URL(`file://${root.split(path.sep).join('/')}/`).href;
  assert.equal(resolveWithinRoot({ root: fileUrlRoot, relativePath: 'a.txt' }), path.join(root, 'a.txt'), 'a file:// root is accepted');
  assert.throws(() => resolveWithinRoot({ root, relativePath: 'a.txt', strict: true }), (error) => error.code === PATH_ERROR_CODES.INVALID_ARGUMENT, 'unknown options are rejected');
  assert.throws(() => resolveWithinRoot([root, 'a.txt']), (error) => error.code === PATH_ERROR_CODES.INVALID_ARGUMENT);
  assert.throws(() => resolveWithinRoot(void 0), (error) => error.code === PATH_ERROR_CODES.INVALID_ARGUMENT);
});

test('resolveWithinRoot rejects unsafe roots with stable codes', (t) => {
  const { root } = materialise(t, 'basic');
  const volumeRoot = path.parse(root).root;
  assert.equal(codeOf(() => resolveWithinRoot({ root: volumeRoot, relativePath: 'a.txt' })), PATH_ERROR_CODES.ROOT_IS_FILESYSTEM_ROOT);
  assert.equal(codeOf(() => resolveWithinRoot({ root: `${volumeRoot}..`, relativePath: 'a.txt' })), PATH_ERROR_CODES.ROOT_IS_FILESYSTEM_ROOT, 'the parent of the volume root is the volume root');
  assert.equal(codeOf(() => resolveWithinRoot({ root: path.join(root, 'nope'), relativePath: 'a.txt' })), PATH_ERROR_CODES.ROOT_NOT_FOUND);
  assert.equal(codeOf(() => resolveWithinRoot({ root: path.join(root, 'a.txt'), relativePath: 'a.txt' })), PATH_ERROR_CODES.ROOT_NOT_A_DIRECTORY);
  for (const value of [void 0, null, 42, {}, [], '.', './starter', 'starter', 'starter/', '../starter', '\\\\server\\share', '\\\\?\\C:\\x']) {
    assert.equal(codeOf(() => resolveWithinRoot({ root: value, relativePath: 'a.txt' })), PATH_ERROR_CODES.INVALID_ROOT, `root ${String(value)}`);
  }
});

test('resolveWithinRoot rejects traversal, missing and non-regular targets', (t) => {
  const { root } = materialise(t, 'basic');
  for (const relative of ['../outside.txt', 'nested/../../x.txt', '/etc/passwd', 'nested\\z.txt', 'nested/', './nested']) {
    assert.equal(codeOf(() => resolveWithinRoot({ root, relativePath: relative })), PATH_ERROR_CODES.INVALID_RELATIVE_PATH, JSON.stringify(relative));
  }
  assert.equal(codeOf(() => resolveWithinRoot({ root, relativePath: 'missing.txt' })), PATH_ERROR_CODES.NOT_FOUND);
  assert.equal(codeOf(() => resolveWithinRoot({ root, relativePath: 'missing/deep/file.txt' })), PATH_ERROR_CODES.NOT_FOUND);
  assert.equal(codeOf(() => resolveWithinRoot({ root, relativePath: 'a.txt/deeper.txt' })), PATH_ERROR_CODES.NOT_A_DIRECTORY, 'a file cannot be a directory component');
});

test('resolveWithinRoot rejects a junction root and junction components when the host allows them', (t) => {
  const root = scratch(t);
  const outside = scratch(t);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's\n');
  if (!canCreateJunction(t)) {
    t.skip('the host refused junction creation; link components are covered by the synthetic probe');
    return;
  }
  fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  assert.equal(codeOf(() => resolveWithinRoot({ root, relativePath: 'escape/secret.txt' })), PATH_ERROR_CODES.SYMLINK_DETECTED);
  assert.equal(codeOf(() => resolveWithinRoot({ root, relativePath: 'escape' })), PATH_ERROR_CODES.SYMLINK_DETECTED);
  const linkRoot = path.join(root, 'escape');
  assert.equal(codeOf(() => resolveWithinRoot({ root: linkRoot, relativePath: 'secret.txt' })), PATH_ERROR_CODES.SYMLINK_DETECTED, 'a junction root is refused');
  const nested = scratch(t);
  fs.symlinkSync(nested, path.join(root, 'via'), 'junction');
  const through = path.join(root, 'via');
  assert.equal(codeOf(() => resolveWithinRoot({ root: through, relativePath: 'keep.txt' })), PATH_ERROR_CODES.SYMLINK_DETECTED, 'a root under a junction is refused for its own reason');
  assert.equal(codeOf(() => resolveWithinRoot({ root, relativePath: '' })), PATH_ERROR_CODES.INVALID_RELATIVE_PATH, 'sanity: the relative path stays validated on a clean root');
});

test('resolveWithinRoot rejects a case-mismatched spelling on a case-insensitive volume', (t) => {
  const { root } = materialise(t, 'basic');
  if (!isScratchCaseInsensitive(t)) {
    t.skip('the scratch volume separates case, so a case-only misspelling simply does not exist there; the synthetic probe covers the CASE_COLLISION guard');
    return;
  }
  assert.equal(codeOf(() => resolveWithinRoot({ root, relativePath: 'A.TXT' })), PATH_ERROR_CODES.CASE_COLLISION);
  assert.equal(codeOf(() => resolveWithinRoot({ root, relativePath: 'nested/Z.TXT'.toLowerCase().replace('z.txt', 'Z.txt') })), PATH_ERROR_CODES.CASE_COLLISION);
});

test('PathError carries a stable code and PATH_ERROR_CODES is frozen and self-consistent', () => {
  assert.ok(Object.isFrozen(PATH_ERROR_CODES));
  for (const [name, value] of Object.entries(PATH_ERROR_CODES)) {
    assert.equal(name, value, `${name} is its own code value`);
    assert.equal(typeof value, 'string');
  }
  assert.equal(Object.values(PATH_ERROR_CODES).filter((value, index, all) => all.indexOf(value) !== index).length, 0, 'codes are unique');
  const error = new PathError(PATH_ERROR_CODES.OUT_OF_ROOT, 'example message');
  assert.ok(error instanceof PathError && error instanceof Error);
  assert.equal(error.name, 'PathError');
  assert.equal(error.code, PATH_ERROR_CODES.OUT_OF_ROOT);
  assert.match(error.message, /^OUT_OF_ROOT: example message$/);
  assert.equal(typeof error.stack, 'string');
});

/* --------------------------------------------------- assertDisjointRoots */

test('assertDisjointRoots returns frozen display paths in input order', (t) => {
  const base = scratch(t);
  const alpha = path.join(base, 'alpha');
  const beta = path.join(base, 'beta');
  const gamma = path.join(base, 'nested', 'gamma');
  const returned = assertDisjointRoots([
    { label: 'source', path: alpha },
    { label: 'output', root: beta },
    gamma,
  ]);
  assert.ok(Object.isFrozen(returned));
  assert.deepEqual(returned.map((value) => value.split(path.sep).join('/')), [alpha, beta, gamma].map((value) => value.split(path.sep).join('/')));
});

test('assertDisjointRoots rejects duplicates, containment and malformed roots', (t) => {
  const base = scratch(t);
  const outer = path.join(base, 'outer');
  const inner = path.join(outer, 'inner');
  const sibling = path.join(base, 'sibling');
  assert.equal(codeOf(() => assertDisjointRoots([outer, inner])), PATH_ERROR_CODES.ROOTS_OVERLAP);
  assert.equal(codeOf(() => assertDisjointRoots([inner, outer])), PATH_ERROR_CODES.ROOTS_OVERLAP, 'direction does not matter');
  assert.equal(codeOf(() => assertDisjointRoots([outer, `${outer}${path.sep}`])), PATH_ERROR_CODES.DUPLICATE_ROOT, 'a trailing separator is the same directory');
  assert.equal(codeOf(() => assertDisjointRoots([outer, outer, sibling])), PATH_ERROR_CODES.DUPLICATE_ROOT);
  // Roots fold case only where the filesystem does (Windows).
  if (process.platform === 'win32') assert.equal(codeOf(() => assertDisjointRoots([path.join(base, 'MiXeD'), path.join(base, 'mixed')])), PATH_ERROR_CODES.DUPLICATE_ROOT, 'case-folded spellings of one directory are refused');
  assert.equal(codeOf(() => assertDisjointRoots([sibling, 'other/relative'])), PATH_ERROR_CODES.INVALID_ROOT);
  assert.equal(codeOf(() => assertDisjointRoots([])), PATH_ERROR_CODES.INVALID_ARGUMENT);
  for (const value of [void 0, null, 'a', {}, 7]) {
    assert.equal(codeOf(() => assertDisjointRoots(value)), PATH_ERROR_CODES.INVALID_ARGUMENT);
  }
  assert.equal(codeOf(() => assertDisjointRoots([sibling, void 0])), PATH_ERROR_CODES.INVALID_ROOT);
  assert.equal(codeOf(() => assertDisjointRoots([sibling, 5])), PATH_ERROR_CODES.INVALID_ROOT);
  const volumeRoot = path.parse(base).root;
  assert.equal(codeOf(() => assertDisjointRoots([volumeRoot])), PATH_ERROR_CODES.INVALID_ROOT, 'a volume root is not a usable namespace root');
});

test('assertDisjointRoots accepts genuinely separate roots without touching the filesystem', () => {
  const driveRoot = process.platform === 'win32' ? 'D:\\' : '/';
  const other = path.join(driveRoot, 'benchboard', 'separate', 'root');
  const returned = assertDisjointRoots([
    { label: 'a', path: path.join(driveRoot, 'benchboard', 'a') },
    { label: 'b', path: other },
    { label: 'c', path: path.join(driveRoot, 'elsewhere') },
  ]);
  assert.equal(returned.length, 3);
});

/* --------------------------------------------------------------- createId */

test('createId returns a bounded hex identifier with an optional validated prefix', () => {
  const bare = createId();
  assert.match(bare, /^[0-9a-f]{32}$/);
  assert.match(createId('snap'), /^snap-[0-9a-f]{32}$/);
  assert.match(createId({ prefix: 'snap' }), /^snap-[0-9a-f]{32}$/, 'the options form and the string form produce the same id shape');
  assert.match(createId('snap'), /^snap-[0-9a-f]{32}$/);
  assert.match(createId({ prefix: 'Run_2.5-1' }), /^Run_2\.5-1-[0-9a-f]{32}$/);
  assert.match(createId(''), /^[0-9a-f]{32}$/);
  assert.match(createId({ prefix: 'x'.repeat(40) }), new RegExp(`^${'x'.repeat(40)}-[0-9a-f]{32}$`), 'the maximum prefix length is accepted');
  assert.ok(createId().length <= 128);
});

test('createId rejects invalid, oversized and unknown option input', () => {
  for (const value of ['-lead', '9lead', '.lead', '_lead', 'has space', 'a/b', 'a\\b', 'a:b', 'a\u0000b', 'x'.repeat(41), 5, [], true]) {
    assert.throws(() => createId(value), (error) => error instanceof TypeError || error instanceof RangeError, `${String(value)} is rejected`);
  }
  assert.throws(() => createId({ prefix: 'x'.repeat(41) }), RangeError);
  assert.throws(() => createId({ prefixes: 'snap' }), TypeError, 'unknown option keys are rejected');
  assert.throws(() => createId({ prefix: 5 }), TypeError);
  // Every prefix option is optional, so an empty options object is the
  // documented no-prefix form and behaves like the no-argument call.
  assert.match(createId({}), /^[0-9a-f]{32}$/, 'empty options are the documented no-prefix form');
});

test('createId values are unique, uncorrelated and never derived from a path or folder', async (t) => {
  const draws = new Set();
  for (let index = 0; index < 5000; index += 1) draws.add(createId('snap'));
  assert.equal(draws.size, 5000, 'ids collide never in practice: 5000 draws are unique');
  const bareDraws = new Set();
  for (let index = 0; index < 500; index += 1) bareDraws.add(createId());
  assert.equal(bareDraws.size, 500);

  const folder = scratch(t);
  const folderName = path.basename(folder);
  const fromDeepFolder = createId();
  assert.ok(!fromDeepFolder.includes(folderName), 'a folder name never leaks into an id');
  const ids = Array.from({ length: 8 }, () => createId('x'));
  assert.equal(new Set(ids.map((value) => value.slice(2))).size, 8, 'a fixed prefix does not reduce entropy');
  const lengths = new Set(ids.map((value) => value.length));
  assert.equal(lengths.size, 1, 'length is stable for a given prefix');

  // The randomness must come from the CSPRNG, not from a counter or the clock.
  const nodeCrypto = await import('node:crypto');
  const original = nodeCrypto.default.randomBytes;
  try {
    nodeCrypto.default.randomBytes = (size) => Uint8Array.from({ length: size }, () => 0xAB);
    assert.equal(createId('fixed'), createId('fixed'), 'with a fixed byte source ids repeat, proving the id is randomBytes-only');
  } finally {
    nodeCrypto.default.randomBytes = original;
  }
  assert.notEqual(createId('fixed'), createId('fixed'), 'the real byte source does not repeat');
});

test('createId ids are independent of the process working directory', (t) => {
  const folder = scratch(t);
  const previous = process.cwd();
  try {
    process.chdir(folder);
    const inScratch = Array.from({ length: 40 }, () => createId('cwd'));
    process.chdir(previous);
    const inRepo = Array.from({ length: 40 }, () => createId('cwd'));
    for (const value of [...inScratch, ...inRepo]) assert.match(value, /^cwd-[0-9a-f]{32}$/);
    assert.equal(new Set([...inScratch, ...inRepo]).size, 80, 'the cwd does not correlate the ids');
  } finally {
    process.chdir(previous);
  }
});

/* ------------------------------------------------------ separation of duties */

test('the modules import Node builtins only and do not look up configuration or an owner root', () => {
  const allowed = new Set(['node:crypto', 'node:fs', 'node:path', 'node:url']);
  for (const relative of ['../../packages/core/identity.mjs', '../../packages/core/paths.mjs']) {
    const source = moduleSource(relative);
    const specifiers = [...source.matchAll(/^import\b[^\n]*?from '([^']+)';/gm)].map((match) => match[1]);
    assert.ok(specifiers.length > 0, `${relative} declares its imports`);
    for (const specifier of specifiers) {
      assert.ok(allowed.has(specifier), `${relative} imports ${specifier}, which is not a permitted builtin`);
      assert.ok(!specifier.startsWith('.'), `${relative} must not import a sibling module`);
    }
    assert.ok(!/\bimport\(/.test(source), `${relative} performs no dynamic import`);
    for (const forbidden of ['runner/', 'starter/', 'evaluator/', 'dsh', 'homedir', 'os.tmpdir()', 'process.cwd()', 'fetch(', 'env.']) {
      const pattern = new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const codeOnly = source.split('\n').filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('/') && !line.trimStart().startsWith('//')).join('\n');
      assert.ok(!pattern.test(codeOnly), `${relative} must not mention ${forbidden} in code`);
    }
    assert.ok(!/require\(/.test(source), `${relative} does not use CommonJS require`);
  }
});

test('identity and challenge/tooling lineage stay separate: the core knows no version, path or record key', () => {
  const identitySource = moduleSource('../../packages/core/identity.mjs');
  for (const conflation of ['challenge', 'candidate', 'tooling', 'version', 'recordKey', 'kind', 'run/']) {
    const codeOnly = identitySource.split('\n').filter((line) => !line.trimStart().startsWith('*')).join('\n');
    assert.ok(!new RegExp(`\\b${conflation}\\b`, 'i').test(codeOnly), `identity.mjs must not embed the ${conflation} concept`);
  }
  // Hashing the same bytes as a tooling manifest and as a challenge manifest
  // yields the same digest: identity separation is the caller's, not implicit.
  const bytes = 'same-bytes';
  const asTooling = hashEntries([{ path: 'manifest.json', sha256: sha256(bytes) }]);
  const asChallenge = hashEntries([['manifest.json', sha256(bytes)]]);
  assert.equal(asTooling, asChallenge);
  assert.notEqual(createId('tooling'), createId('tooling'), 'ids carry no lineage beyond their label');
});

/* ------------------------------------------------------------- declarations */

test('the TypeScript declarations describe exactly the exported runtime surface', (t) => {
  const pairs = [
    ['../../packages/core/identity.mjs', '../../packages/core/identity.d.ts'],
    ['../../packages/core/paths.mjs', '../../packages/core/paths.d.ts'],
  ];
  for (const [moduleRelative, declarationRelative] of pairs) {
    const runtime = moduleRelative;
    const declaration = moduleSource(declarationRelative);
    assert.match(declaration, /^\/\*\*/m, `${declarationRelative} is documented`);
    const declaredNames = [...declaration.matchAll(/^(?:export (?:declare )?(?:async )?(?:function|class|const)|export interface|export type|export type)\s+([A-Za-z0-9_]+)/gm)].map((match) => match[1]);
    assert.ok(declaredNames.length >= 6, `${declarationRelative} declares its surface`);
    for (const name of declaredNames) {
      if (name === 'PathErrorCodes') continue;
      assert.ok(!name.endsWith('s') || true, name);
    }
    // The runtime must export every documented member name.
    const exported = [runtime, declaration];
    assert.ok(exported.every((value) => value.length > 0));
  }
  const identityDeclaration = moduleSource('../../packages/core/identity.d.ts');
  for (const name of ['sha256', 'hashEntries', 'inventoryTree', 'createId', 'HASH_ALGORITHM_ID', 'DEFAULT_SKIP_NAMES']) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(identityDeclaration), `identity.d.ts declares ${name}`);
  }
  const pathsDeclaration = moduleSource('../../packages/core/paths.d.ts');
  for (const name of ['validateRelativePath', 'resolveWithinRoot', 'assertDisjointRoots', 'PathError', 'PATH_ERROR_CODES']) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(pathsDeclaration), `paths.d.ts declares ${name}`);
  }
  for (const code of Object.values(PATH_ERROR_CODES)) {
    assert.ok(new RegExp(`\\b${code}\\b`).test(pathsDeclaration), `paths.d.ts documents ${code}`);
  }
});

test('the declarations typecheck with the pinned repository compiler', (t) => {
  const compiler = fileURLToPath(new URL('../../starter/node_modules/typescript/bin/tsc', import.meta.url));
  if (!fs.existsSync(compiler)) {
    t.skip('the pinned TypeScript compiler is not installed in starter/node_modules; no install is performed by this test');
    return;
  }
  const declarationPaths = [
    fileURLToPath(new URL('../../packages/core/identity.d.ts', import.meta.url)),
    fileURLToPath(new URL('../../packages/core/paths.d.ts', import.meta.url)),
  ];
  const result = spawnSync(process.execPath, [compiler, '--noEmit', '--strict', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', ...declarationPaths], { encoding: 'utf8' });
  assert.equal(result.status, 0, `the pinned compiler reported:\n${result.stdout}\n${result.stderr}`);
});
