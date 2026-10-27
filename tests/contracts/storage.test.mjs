/**
 * C1 T3 focused contract tests — packages/core/storage.mjs
 * Explicit-root atomic/immutable storage transactions.
 * C1 T5 additions: immutable replacement refusal, same-instance transaction
 * ownership (serialization + drained nested fanout), root revalidation on
 * read, and upfront linked-ancestor refusal on root creation.
 * C1 T6 additions: interrupted immutable publication recovery — bound
 * identity reservations written before any immutable byte publication,
 * conservative refusal of reserved/unregistered published targets through
 * the mutable API, and explicit identical-bytes reconciliation through
 * createImmutable.
 * C1 T10 additions (SOTA1 finding4): type-preserving recovery — first-time
 * mutable publications reserve a pending MUTABLE identity before any byte
 * publication, interrupted first mutable publications recover through an
 * identical replaceMutable retry as the same mutable identity (later
 * updates stay allowed), and different-bytes/cross-location/type-conversion
 * refusals protect the reserved bytes/identity/type.
 *
 * All generated writes live under the project-contained local test scratch
 * tests/contracts/.tmp/storage (per-run test-* directory, locally
 * info/exclude-ignored) and are removed after the run. Curated fixture
 * bytes live in tests/contracts/fixtures/storage/.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { createStorage } from '../../packages/core/storage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(path.dirname(here)); // tests/contracts -> repo
const fixturePath = (name) =>
  path.join(here, 'fixtures', 'storage', 'envelopes', name);
const fixtureBytes = async (name) =>
  Buffer.from(await readFile(fixturePath(name), 'utf8'), 'utf8');

let scratchBase;
before(async () => {
  const runStamp = `${Date.now().toString(36)}-${process.pid}`;
  scratchBase = path.join(
    repoRoot,
    'tests/contracts/.tmp/storage',
    `test-${runStamp}`,
  );
  await mkdir(scratchBase, { recursive: true });
});

after(async () => {
  if (scratchBase && existsSync(scratchBase)) {
    await rm(scratchBase, { force: true, recursive: true });
  }
});

/**
 * Fresh explicit storage root per test, inside the owned task scratch.
 */
async function newRoot(label) {
  const store = path.join(scratchBase, label.replace(/[^a-z0-9_-]+/gi, '-') + '-' + Math.random().toString(36).slice(2, 8));
  await mkdir(store, { recursive: true });
  return store;
}

/**
 * Assert a promise rejects with a StorageError carrying one of the given
 * codes, and returns the error for further detail assertions.
 */
async function assertRefused(promise, codes) {
  const allowed = Array.isArray(codes) ? codes : [codes];
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'StorageError', `expected StorageError, got ${error && error.name}: ${error && error.message}`);
    assert.ok(
      allowed.includes(error.code),
      `expected code in [${allowed.join(', ')}], got ${error.code} (${error.message})`,
    );
    assert.ok(error.code.startsWith('ERR_STORAGE_'), 'refusal codes are stable ERR_STORAGE_* codes');
    return true;
  });
}

async function listDir(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

const identityOf = (result, { kind, id, relativePath, recordType }) => {
  assert.equal(result.kind, kind);
  assert.equal(result.id, id);
  assert.equal(result.relativePath, relativePath);
  assert.equal(result.recordType, recordType);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
};

describe('runtime neutrality', () => {
  it('imports Node builtins only', async () => {
    const text = await readFile(
      path.join(repoRoot, 'packages/core/storage.mjs'),
      'utf8',
    );
    const sources = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (match) => match[1],
    );
    assert.ok(sources.length > 0, 'module must have imports to inspect');
    for (const source of sources) {
      assert.match(
        source,
        /^node:[a-z0-9_./-]+$/,
        `non-builtin import source: ${source}`,
      );
    }
  });

  it('contains no environment, config, network, process-spawn or DSH lookups', async () => {
    const text = await readFile(
      path.join(repoRoot, 'packages/core/storage.mjs'),
      'utf8',
    );
    const forbidden = [
      /require\s*\(/,
      /process\.env/,
      /globalThis\./,
      /\bfetch\s*\(/,
      /node:(child_process|http|https|net|tls|dns|worker_threads|v8|inspector)/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bdeepseek\b/i,
      /\bdsh\b/,
      /\baxios\b/,
      /\bundici\b/,
      /\blocalStorage\b/,
      /\bindexedDB\b/,
    ];
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `forbidden pattern ${pattern} found in storage.mjs`);
    }
  });

  it('has no dependencies beyond Node builtins in the declaration file', async () => {
    const text = await readFile(
      path.join(repoRoot, 'packages/core/storage.d.ts'),
      'utf8',
    );
    assert.ok(!/\bimport\s+.*from\s+['"][^'"]+['"]/.test(text), 'declaration file must not import runtime modules');
  });
});

describe('explicit root validation', () => {
  it('requires an explicit root', () => {
    assert.throws(() => createStorage({}), (error) => error.code === 'ERR_STORAGE_ROOT_REQUIRED');
    assert.throws(() => createStorage({ root: '' }), (error) => error.code === 'ERR_STORAGE_ROOT_REQUIRED');
    assert.throws(() => createStorage({ root: undefined }), (error) => error.code === 'ERR_STORAGE_ROOT_REQUIRED');
  });

  it('rejects relative roots with no environment/config fallback', () => {
    assert.throws(() => createStorage({ root: 'scratch/relative' }), (error) => error.code === 'ERR_STORAGE_ROOT_NOT_ABSOLUTE');
    assert.throws(() => createStorage({ root: './scratch/cwd-relative' }), (error) => error.code === 'ERR_STORAGE_ROOT_NOT_ABSOLUTE');
  });
});

describe('record path security boundaries', () => {
  const cases = [
    ['empty relative path', '', 'ERR_STORAGE_INVALID_PATH'],
    ['parent traversal', '../escape.json', 'ERR_STORAGE_INVALID_PATH'],
    ['nested ancestor traversal', 'sub/../../escape.json', 'ERR_STORAGE_INVALID_PATH'],
    ['absolute posix path', '/abs/record.json', 'ERR_STORAGE_INVALID_PATH'],
    ['windows separators', 'sub\\record.json', 'ERR_STORAGE_INVALID_PATH'],
    ['drive-qualified path', 'C:/record.json', 'ERR_STORAGE_INVALID_PATH'],
    ['empty segment', 'a//record.json', 'ERR_STORAGE_INVALID_PATH'],
    ['dot segment', './record.json', 'ERR_STORAGE_INVALID_PATH'],
    ['reserved namespace', '.storage/registry.json', 'ERR_STORAGE_RESERVED_PATH'],
    ['nul byte', 'bad_\u0000name.json', 'ERR_STORAGE_INVALID_PATH'],
  ];

  for (const [label, relativePath, expectedCode] of cases) {
    it(`createImmutable refuses ${label}`, async () => {
      const root = await newRoot('path-safety');
      const storage = createStorage({ root });
      await assertRefused(
        storage.createImmutable({
          relativePath,
          kind: 'probe.record',
          id: 'p-1',
          value: 1,
        }),
        expectedCode,
      );
    });

    it(`read refuses ${label}`, async () => {
      const root = await newRoot('path-safety-read');
      const storage = createStorage({ root });
      await mkdir(root, { recursive: true });
      await assertRefused(
        storage.read({ relativePath, kind: 'probe.record', id: 'p-1' }),
        [expectedCode, 'ERR_STORAGE_ROOT_NOT_FOUND'],
      );
    });
  }
});

describe('root and filesystem link/special-file boundaries', () => {
  it('refuses a symlinked root without writing through it', async () => {
    const base = await newRoot('link-root');
    const realRoot = path.join(base, 'real');
    await mkdir(realRoot);
    const linkPath = path.join(base, 'linked-root');
    try {
      await symlink(realRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        // Symlink creation denied by platform policy: cannot exercise here.
        return;
      }
      throw error;
    }
    const storage = createStorage({ root: linkPath });
    await assertRefused(
      storage.createImmutable({ relativePath: 'x.json', kind: 'probe.record', id: 'r', value: 1 }),
      ['ERR_STORAGE_ROOT_LINK', 'ERR_STORAGE_ROOT_NOT_DIRECTORY'],
    );
    assert.equal(existsSync(path.join(realRoot, 'x.json')), false, 'no bytes written through a linked root');
  });

  it('refuses symlinked intermediates inside the root', async () => {
    const base = await newRoot('link-intermediate');
    const storage = createStorage({ root: base });
    const sibling = path.join(base, 'elsewhere');
    await mkdir(sibling);
    const sub = path.join(base, 'sub');
    await mkdir(sub);
    const linkDir = path.join(sub, 'linked');
    try {
      await symlink(sibling, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') return;
      throw error;
    }
    await assertRefused(
      storage.createImmutable({ relativePath: 'sub/linked/x.json', kind: 'probe.record', id: 'r', value: 1 }),
      'ERR_STORAGE_LINKED_OR_NON_DIRECTORY',
    );
    await assertRefused(
      storage.read({ relativePath: 'sub/linked/x.json', kind: 'probe.record', id: 'r' }),
      ['ERR_STORAGE_LINKED_OR_NON_DIRECTORY', 'ERR_STORAGE_NOT_FOUND'],
    );
  });

  it('refuses a root that is a regular file', async () => {
    const base = await newRoot('root-is-file');
    const filePath = path.join(base, 'not-a-root.json');
    await writeFile(filePath, 'text');
    const storage = createStorage({ root: filePath });
    await assertRefused(
      storage.createImmutable({ relativePath: 'x.json', kind: 'probe.record', id: 'r', value: 1 }),
      'ERR_STORAGE_ROOT_NOT_DIRECTORY',
    );
  });

  it('read on a missing root refuses instead of creating it', async () => {
    const base = await newRoot('read-missing-root');
    const missing = path.join(base, 'nope');
    const storage = createStorage({ root: missing });
    await assertRefused(
      storage.read({ relativePath: 'x.json', kind: 'probe.record', id: 'r' }),
      'ERR_STORAGE_ROOT_NOT_FOUND',
    );
    assert.equal(existsSync(missing), false, 'read must not create the root');
  });

  it('write creates an explicit root on demand', async () => {
    const base = await newRoot('write-creates-root');
    const target = path.join(base, 'nested/root');
    const storage = createStorage({ root: target });
    const result = await storage.createImmutable({
      relativePath: 'x.json',
      kind: 'probe.record',
      id: 'r',
      value: 1,
    });
    identityOf(result, { kind: 'probe.record', id: 'r', relativePath: 'x.json', recordType: 'immutable' });
    assert.equal(await storage.read({ relativePath: 'x.json', kind: 'probe.record', id: 'r' }), 1);
  });

  it('refuses non-regular record targets (directories, symlinks)', async () => {
    const root = await newRoot('nonregular');
    const storage = createStorage({ root });
    const dirPath = path.join(root, 'records', 'thing');
    await mkdir(dirPath, { recursive: true });
    await assertRefused(
      storage.createImmutable({ relativePath: 'records/thing', kind: 'probe.record', id: 'dir-target', value: 1 }),
      ['ERR_STORAGE_TARGET_EXISTS', 'ERR_STORAGE_NOT_REGULAR_FILE'],
    );
    await assertRefused(
      storage.read({ relativePath: 'records/thing', kind: 'probe.record', id: 'dir-target' }),
      'ERR_STORAGE_NOT_REGULAR_FILE',
    );
  });
});

describe('immutable publication and integrity', () => {
  it('publishes verified bytes exclusively and reads them back', async () => {
    const root = await newRoot('immutable');
    const storage = createStorage({ root });
    const value = { alpha: 1, beta: [null, 0, false], gamma: 'x' };
    const result = await storage.createImmutable({
      relativePath: 'reports/one.json',
      kind: 'r.report',
      id: 'r-1',
      value,
    });
    identityOf(result, { kind: 'r.report', id: 'r-1', relativePath: 'reports/one.json', recordType: 'immutable' });
    assert.deepEqual(await storage.read({ relativePath: 'reports/one.json', kind: 'r.report', id: 'r-1' }), value);
  });

  it('refuses a second immutable write of the same identity at any location', async () => {
    const root = await newRoot('immutable-duplicate');
    const storage = createStorage({ root });
    await storage.createImmutable({ relativePath: 'a/one.json', kind: 'r.report', id: 'r-1', value: { v: 1 } });
    await assertRefused(
      storage.createImmutable({ relativePath: 'a/one.json', kind: 'r.report', id: 'r-1', value: { v: 2 } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
    );
    await assertRefused(
      storage.createImmutable({ relativePath: 'b/two.json', kind: 'r.report', id: 'r-1', value: { v: 3 } }),
      [
        'ERR_STORAGE_DUPLICATE_IDENTITY',
        'ERR_STORAGE_TARGET_EXISTS',
        'ERR_STORAGE_ENVELOPE_MALFORMED',
        'ERR_STORAGE_IDENTITY_MISMATCH',
      ],
    );

    // after crash recovery semantics: retry with identical bytes reconciles
    // (covered below in transaction failure tests); with unregistered
    // different bytes it is a refusal, never an overwrite.
    await storage.createImmutable({ relativePath: 'a/other.json', kind: 'r.summary', id: 'r-1', value: { v: 9 } });
    assert.deepEqual(
      await storage.read({ relativePath: 'a/other.json', kind: 'r.summary', id: 'r-1' }),
      { v: 9 },
      'same id with a different kind is a distinct identity',
    );
  });

  it('refuses overwriting an existing mismatched record identity at the path', async () => {
    const root = await newRoot('immutable-overwrite');
    const storage = createStorage({ root });
    await storage.createImmutable({ relativePath: 'a.json', kind: 'k.one', id: 'i-1', value: { v: 1 } });
    await assertRefused(
      storage.createImmutable({ relativePath: 'a.json', kind: 'k.one', id: 'i-1', value: { v: 'different' } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
    );
    // Unregistered file with different identity occupying the path:
    const raw = JSON.stringify({
      schemaVersion: 1,
      kind: 'k.other',
      id: 'i-2',
      value: { v: 2 },
      digest: '0'.repeat(64),
    });
    await writeFile(path.join(root, 'b.json'), raw);
    await assertRefused(
      storage.createImmutable({ relativePath: 'b.json', kind: 'k.third', id: 'i-3', value: { v: 3 } }),
      ['ERR_STORAGE_TARGET_EXISTS', 'ERR_STORAGE_ENVELOPE_MALFORMED', 'ERR_STORAGE_IDENTITY_MISMATCH', 'ERR_STORAGE_DIGEST_MISMATCH'],
    );
  });
});

describe('mutable replacement semantics', () => {
  it('creates, replaces atomically and keeps identity binding', async () => {
    const root = await newRoot('mutable');
    const storage = createStorage({ root });
    const relativePath = 'state/run.json';
    const first = await storage.replaceMutable({
      relativePath,
      kind: 'state.record',
      id: 's-1',
      value: { status: 'init', attempts: 0 },
    });
    identityOf(first, { kind: 'state.record', id: 's-1', relativePath, recordType: 'mutable' });
    assert.equal(first.replaced, false);

    const replaced = await storage.replaceMutable({
      relativePath,
      kind: 'state.record',
      id: 's-1',
      value: { status: 'running', attempts: 1 },
    });
    assert.equal(replaced.replaced, true);
    assert.deepEqual(
      await storage.read({ relativePath, kind: 'state.record', id: 's-1' }),
      { status: 'running', attempts: 1 },
      'the value changed under the same immutable identity',
    );
  });

  it('refuses identity-changing replacement and leaves bytes intact', async () => {
    const root = await newRoot('mutable-identity');
    const storage = createStorage({ root });
    const relativePath = 'state/run.json';
    await storage.replaceMutable({ relativePath, kind: 'state.record', id: 's-1', value: { v: 1 } });
    await assertRefused(
      storage.replaceMutable({ relativePath, kind: 'state.record', id: 'CHANGED', value: { v: 2 } }),
      ['ERR_STORAGE_IDENTITY_MISMATCH', 'ERR_STORAGE_PATH_CONFLICT'],
    );
    await assertRefused(
      storage.replaceMutable({ relativePath, kind: 'CHANGED.record', id: 's-1', value: { v: 3 } }),
      ['ERR_STORAGE_IDENTITY_MISMATCH', 'ERR_STORAGE_PATH_CONFLICT'],
    );
    assert.deepEqual(
      await storage.read({ relativePath, kind: 'state.record', id: 's-1' }),
      { v: 1 },
      'original bytes are intact after refused replacement',
    );
  });

  it('refuses replacing an identity at a different registered location', async () => {
    const root = await newRoot('mutable-location');
    const storage = createStorage({ root });
    await storage.replaceMutable({ relativePath: 'a/one.json', kind: 'state.record', id: 's-1', value: { v: 1 } });
    await assertRefused(
      storage.replaceMutable({ relativePath: 'b/two.json', kind: 'state.record', id: 's-1', value: { v: 2 } }),
      'ERR_STORAGE_IDENTITY_LOCATION_CONFLICT',
    );
  });

  it('refuses case-ambiguous paths within the explicit root', { skip: process.platform !== 'win32' && 'storage folds case only on Windows; elsewhere these are distinct names' }, async () => {
    const root = await newRoot('case-ambiguity');
    const storage = createStorage({ root });
    await storage.createImmutable({ relativePath: 'data/Report.json', kind: 'k.alpha', id: 'a', value: 1 });
    await assertRefused(
      storage.createImmutable({ relativePath: 'data/report.json', kind: 'k.beta', id: 'b', value: 2 }),
      'ERR_STORAGE_PATH_CONFLICT',
    );
    await assertRefused(
      storage.replaceMutable({ relativePath: 'data/report.json', kind: 'k.beta', id: 'b', value: 2 }),
      'ERR_STORAGE_PATH_CONFLICT',
    );
  });

  it('refuses to mutate existing immutable recordType ids into mutable replacements across records', async () => {
    const root = await newRoot('type-stability');
    const storage = createStorage({ root });
    await storage.createImmutable({ relativePath: 'i.json', kind: 'k.one', id: 'i-1', value: 1 });
    await assertRefused(
      storage.createImmutable({ relativePath: 'i.json', kind: 'k.one', id: 'i-1', value: 2 }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
    );
  });
});

describe('value domain: null/zero roundtrip and JSON strictness', () => {
  let storage;
  before(async () => {
    storage = createStorage({ root: await newRoot('value-domain') });
  });

  it('roundtrips null distinctly from zero', async () => {
    await storage.createImmutable({ relativePath: 'null.json', kind: 'probe.record', id: 'null-1', value: null });
    const nullValue = await storage.read({ relativePath: 'null.json', kind: 'probe.record', id: 'null-1' });
    assert.equal(nullValue, null);
    assert.equal(typeof nullValue, 'object');
    assert.equal(nullValue === undefined, false);

    await storage.createImmutable({ relativePath: 'zero.json', kind: 'probe.record', id: 'zero-1', value: 0 });
    const zeroValue = await storage.read({ relativePath: 'zero.json', kind: 'probe.record', id: 'zero-1' });
    assert.equal(zeroValue, 0);
    assert.equal(typeof zeroValue, 'number');
    assert.equal(zeroValue === null, false, 'zero is not null');
  });

  it('roundtrips null/zero/false positions inside structures distinctly', async () => {
    const value = { a: null, b: 0, c: false, list: [null, 0, false], emptyObject: {}, emptyArray: [] };
    await storage.createImmutable({ relativePath: 'struct.json', kind: 'probe.record', id: 'struct-1', value });
    assert.deepEqual(
      await storage.read({ relativePath: 'struct.json', kind: 'probe.record', id: 'struct-1' }),
      value,
    );
  });

  it('refuses non-JSON values', async () => {
    const cases = [
      ['NaN', NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['undefined', undefined],
      ['bigint', 1n],
      ['function', () => 42],
      ['symbol', Symbol('x')],
      ['class instance', new Date(0)],
      ['circular', null],
    ];
    const circular = {};
    circular.self = circular;
    cases[cases.length - 1][1] = circular;
    const root2 = await newRoot('value-invalid');
    const storage2 = createStorage({ root: root2 });
    for (let i = 0; i < cases.length; i += 1) {
      const [label, value] = cases[i];
      await assertRefused(
        storage2.createImmutable({
          relativePath: `bad-${i}.json`,
          kind: 'probe.record',
          id: `bad-${i}`,
          value,
        }),
        'ERR_STORAGE_VALUE_NOT_JSON',
        undefined,
      );
    }
  });
});

describe('concurrent writer and duplicate refusal', () => {
  it('refuses the second writer on the same root for a duplicate identity race', async () => {
    const root = await newRoot('race-duplicate');
    const first = createStorage({ root });
    const second = createStorage({ root });
    const outcomes = await Promise.allSettled([
      first.createImmutable({ relativePath: 'zoneA/winner.json', kind: 'r.report', id: 'race-1', value: { writer: 'A' } }),
      second.createImmutable({ relativePath: 'zoneB/winner.json', kind: 'r.report', id: 'race-1', value: { writer: 'B' } }),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one writer wins');
    assert.equal(rejected.length, 1, 'exactly one writer is refused');
    for (const rejection of rejected) {
      assertRefusedCode(rejection.reason);
    }
    const winnerResult = fulfilled[0].value;
    const winnerValue = await first.read({
      relativePath: winnerResult.relativePath,
      kind: 'r.report',
      id: 'race-1',
    });
    assert.ok(
      winnerValue.writer === 'A' || winnerValue.writer === 'B',
      `winner value is one of the committed writers, got ${JSON.stringify(winnerValue)}`,
    );
    const loserRel = winnerResult.relativePath === 'zoneA/winner.json' ? 'zoneB/winner.json' : 'zoneA/winner.json';
    assert.equal(
      existsSync(path.join(root, loserRel)),
      false,
      'the refused writer published no bytes',
    );
    assert.equal(existsSync(path.join(root, '.storage/lock')), false, 'lock is released after the race');
  });

  it('withLock serializes and conflicting containers are refused', async () => {
    const root = await newRoot('lock-conflict');
    const gate = deferred();
    let hookCalled = false;
    const writer = createStorage({
      root,
      hooks: {
        beforePublish: async () => {
          hookCalled = true;
          await gate.promise;
        },
      },
    });
    const contender = createStorage({ root });

    const inFlight = writer.createImmutable({
      relativePath: 'gated/one.json',
      kind: 'r.report',
      id: 'locked-1',
      value: 1,
    });
    await waitFor(() => hookCalled);
    assert.equal(existsSync(path.join(root, '.storage/lock')), true, 'writer holds the root-wide lock');
    assert.equal(existsSync(path.join(root, 'gated/one.json')), false, 'nothing published yet');

    await assertRefused(
      contender.withLock(async () => 42),
      'ERR_STORAGE_LOCK_CONFLICT',
      undefined,
    );
    await assertRefused(
      contender.createImmutable({ relativePath: 'gated/two.json', kind: 'r.report', id: 'locked-2', value: 2 }),
      'ERR_STORAGE_LOCK_CONFLICT',
      undefined,
    );

    gate.resolve();
    const result = await inFlight;
    identityOf(result, { kind: 'r.report', id: 'locked-1', relativePath: 'gated/one.json', recordType: 'immutable' });
    assert.equal(existsSync(path.join(root, '.storage/lock')), false, 'lock released after publication');

    await contender.withLock(async () => {
      assert.deepEqual(await contender.read({ relativePath: 'gated/one.json', kind: 'r.report', id: 'locked-1' }), 1);
      return 'after';
    });
  });

  it('withLock returns the operation result and runs exactly once', async () => {
    const root = await newRoot('lock-basic');
    const storage = createStorage({ root });
    let calls = 0;
    const output = await storage.withLock(async () => {
      calls += 1;
      return calls;
    });
    assert.equal(output, 1);
    assert.equal(calls, 1);
    assert.equal(existsSync(path.join(root, '.storage/lock')), false);
  });

  it('withLock refuses a manually placed foreign lock and never removes it', async () => {
    const root = await newRoot('lock-foreign');
    const storage = createStorage({ root });
    await mkdir(path.join(root, '.storage'), { recursive: true });
    const foreignLock = path.join(root, '.storage/lock');
    await writeFile(foreignLock, '{"schemaVersion":1,"token":"someone-else","pid":12345}\n');
    await assertRefused(storage.withLock(async () => 1), 'ERR_STORAGE_LOCK_CONFLICT');
    assert.equal(existsSync(foreignLock), true, 'foreign lock is never stolen');
    assert.equal(
      (await readFile(foreignLock, 'utf8')),
      '{"schemaVersion":1,"token":"someone-else","pid":12345}\n',
      'foreign lock bytes untouched',
    );
  });

  it('allows nested writes by the same container inside its own withLock', async () => {
    const root = await newRoot('lock-nested');
    const storage = createStorage({ root });
    const out = await storage.withLock(async () => {
      const result = await storage.createImmutable({
        relativePath: 'nested/inner.json',
        kind: 'r.report',
        id: 'nested-1',
        value: 7,
      });
      return result.recordType;
    });
    assert.equal(out, 'immutable');
  });
});

/**
 * C1 T5 repairs: (1) registered immutable records cannot be replaced through
 * the mutable API; (2) same-instance concurrency ownership — independent
 * concurrent writes are serialized in FIFO order and causally nested writes
 * (inside one withLock callback, including Promise.all fanout) join the
 * holder via per-run child queues, so no duplicate identity is published and
 * no registry entry is lost; (3) read revalidates the root after external
 * replacement; (4) root creation refuses linked ancestors upfront.
 * All race tests are deterministic (synchronous FIFO enqueue at call time);
 * no sleeps.
 */
describe('C1 T5 repairs: immutable refusal, writer serialization and root boundaries', () => {
  describe('registered immutable replacement refusal', () => {
    it('replaceMutable refuses an immutable record at the same path and preserves bytes/identity/registry', async () => {
      const root = await newRoot('t5-immutable-refusal');
      const storage = createStorage({ root });
      const created = await storage.createImmutable({
        relativePath: 'i.json',
        kind: 'k.one',
        id: 'i-1',
        value: { v: 1 },
      });
      assert.equal(created.recordType, 'immutable');
      const beforeBytes = await readFile(path.join(root, 'i.json'));
      await assertRefused(
        storage.replaceMutable({ relativePath: 'i.json', kind: 'k.one', id: 'i-1', value: { v: 2 } }),
        'ERR_STORAGE_IMMUTABLE_REPLACEMENT',
      );
      const afterBytes = await readFile(path.join(root, 'i.json'));
      assert.ok(afterBytes.equals(beforeBytes), 'immutable bytes untouched by refused replacement');
      assert.deepEqual(
        await storage.read({ relativePath: 'i.json', kind: 'k.one', id: 'i-1' }),
        { v: 1 },
        'the original value is still bound to the identity',
      );
      // The registry entry is preserved as immutable: duplicates still refuse.
      await assertRefused(
        storage.createImmutable({ relativePath: 'i.json', kind: 'k.one', id: 'i-1', value: { v: 1 } }),
        'ERR_STORAGE_DUPLICATE_IDENTITY',
      );
      // Even identical bytes are refused: immutability is never converted.
      await assertRefused(
        storage.replaceMutable({ relativePath: 'i.json', kind: 'k.one', id: 'i-1', value: { v: 1 } }),
        'ERR_STORAGE_IMMUTABLE_REPLACEMENT',
      );
      assert.equal(existsSync(path.join(root, '.storage/lock')), false, 'lock released after refusal');
      // No replacement staging scratch remains in the record directory.
      assert.equal((await listDir(root)).filter((n) => n.includes('.staging-')).length, 0, 'no leaked scratch');
    });

    it('replaceMutable refuses an immutable record registered at another location', async () => {
      const root = await newRoot('t5-immutable-refusal-alt');
      const storage = createStorage({ root });
      await storage.createImmutable({ relativePath: 'a/one.json', kind: 'k.one', id: 'i-1', value: { v: 1 } });
      await assertRefused(
        storage.replaceMutable({ relativePath: 'b/two.json', kind: 'k.one', id: 'i-1', value: { v: 2 } }),
        ['ERR_STORAGE_IDENTITY_LOCATION_CONFLICT', 'ERR_STORAGE_IMMUTABLE_REPLACEMENT'],
      );
      assert.deepEqual(
        await storage.read({ relativePath: 'a/one.json', kind: 'k.one', id: 'i-1' }),
        { v: 1 },
      );
      assert.equal(existsSync(path.join(root, 'b/two.json')), false, 'no bytes published at the other location');
    });

    it('mutable records still replace atomically and first-time mutable creates stay supported', async () => {
      const root = await newRoot('t5-mutable-still-works');
      const storage = createStorage({ root });
      const first = await storage.replaceMutable({ relativePath: 's.json', kind: 'k.m', id: 'm-1', value: { v: 1 } });
      assert.equal(first.replaced, false);
      const second = await storage.replaceMutable({ relativePath: 's.json', kind: 'k.m', id: 'm-1', value: { v: 2 } });
      assert.equal(second.replaced, true);
      assert.deepEqual(await storage.read({ relativePath: 's.json', kind: 'k.m', id: 'm-1' }), { v: 2 });
    });
  });

  describe('independent same-instance concurrent writers (top level)', () => {
    it('same identity, different paths: FIFO serialization publishes the identity exactly once', async () => {
      const root = await newRoot('t5-race-duplicate-same-instance');
      const storage = createStorage({ root });
      const outcomes = await Promise.allSettled([
        storage.createImmutable({ relativePath: 'a.json', kind: 'run', id: 'duplicate', value: { writer: 'A' } }),
        storage.createImmutable({ relativePath: 'b.json', kind: 'run', id: 'duplicate', value: { writer: 'B' } }),
      ]);
      assert.equal(outcomes[0].status, 'fulfilled', 'the first-enqueued writer wins');
      assert.equal(outcomes[1].status, 'rejected', 'the second writer is refused');
      assert.equal(outcomes[1].reason.code, 'ERR_STORAGE_DUPLICATE_IDENTITY');
      assert.equal(existsSync(path.join(root, 'a.json')), true, 'the winner published');
      assert.equal(existsSync(path.join(root, 'b.json')), false, 'the loser published nothing');
      assert.equal(existsSync(path.join(root, '.storage/lock')), false, 'lock released after the race');
      assert.equal((await listDir(root)).filter((n) => n.includes('.staging-')).length, 0, 'no leaked scratch');
      // Registry integrity: exactly one registered identity.
      await assertRefused(
        storage.createImmutable({ relativePath: 'c.json', kind: 'run', id: 'duplicate', value: { writer: 'C' } }),
        'ERR_STORAGE_DUPLICATE_IDENTITY',
      );
    });

    it('different identities: both writers fulfill and both registry entries survive', async () => {
      const root = await newRoot('t5-race-distinct-same-instance');
      const storage = createStorage({ root });
      const outcomes = await Promise.allSettled([
        storage.createImmutable({ relativePath: 'one.json', kind: 'run', id: 'one', value: { writer: 'A' } }),
        storage.createImmutable({ relativePath: 'two.json', kind: 'other', id: 'two', value: { writer: 'B' } }),
      ]);
      assert.equal(outcomes[0].status, 'fulfilled');
      assert.equal(outcomes[1].status, 'fulfilled');
      assert.deepEqual(await storage.read({ relativePath: 'one.json', kind: 'run', id: 'one' }), { writer: 'A' });
      assert.deepEqual(await storage.read({ relativePath: 'two.json', kind: 'other', id: 'two' }), { writer: 'B' });
      // Registry retention: the first identity's entry is not lost.
      await assertRefused(
        storage.createImmutable({ relativePath: 'one.json', kind: 'run', id: 'one', value: { writer: 'A' } }),
        'ERR_STORAGE_DUPLICATE_IDENTITY',
      );
      await assertRefused(
        storage.createImmutable({ relativePath: 'three.json', kind: 'other', id: 'two', value: { writer: 'B' } }),
        'ERR_STORAGE_DUPLICATE_IDENTITY',
      );
      assert.equal(existsSync(path.join(root, '.storage/lock')), false);
    });
  });

  describe('concurrent writes launched inside ONE withLock callback', () => {
    it('Promise.all duplicate identities serialize without duplicate publication', async () => {
      const root = await newRoot('t5-nested-duplicate-fanout');
      const storage = createStorage({ root });
      const outcomes = await storage.withLock(() =>
        Promise.allSettled([
          storage.createImmutable({ relativePath: 'd/one.json', kind: 'k.dup', id: 'same', value: { which: 'first' } }),
          storage.createImmutable({ relativePath: 'd/two.json', kind: 'k.dup', id: 'same', value: { which: 'second' } }),
        ]),
      );
      assert.equal(outcomes[0].status, 'fulfilled', 'first nested sibling wins');
      assert.equal(outcomes[1].status, 'rejected', 'second nested sibling refused');
      assert.equal(outcomes[1].reason.code, 'ERR_STORAGE_DUPLICATE_IDENTITY');
      assert.equal(existsSync(path.join(root, 'd/one.json')), true);
      assert.equal(existsSync(path.join(root, 'd/two.json')), false);
      assert.equal(existsSync(path.join(root, '.storage/lock')), false, 'outer lock fully released after drain');
    });

    it('Promise.all distinct identities serialize without stale-registry loss', async () => {
      const root = await newRoot('t5-nested-distinct-fanout');
      const storage = createStorage({ root });
      const results = await storage.withLock(() =>
        Promise.all([
          storage.createImmutable({ relativePath: 'f/one.json', kind: 'k.fan', id: 'one', value: { writer: 'A' } }),
          storage.createImmutable({ relativePath: 'f/two.json', kind: 'k.fan', id: 'two', value: { writer: 'B' } }),
        ]),
      );
      assert.equal(results.length, 2);
      for (const result of results) {
        assert.equal(result.recordType, 'immutable');
      }
      assert.deepEqual(await storage.read({ relativePath: 'f/one.json', kind: 'k.fan', id: 'one' }), { writer: 'A' });
      assert.deepEqual(await storage.read({ relativePath: 'f/two.json', kind: 'k.fan', id: 'two' }), { writer: 'B' });
      // Both registry entries survived (no stale registry overwrite).
      await assertRefused(
        storage.createImmutable({ relativePath: 'f/one.json', kind: 'k.fan', id: 'one', value: { writer: 'A' } }),
        'ERR_STORAGE_DUPLICATE_IDENTITY',
      );
      await assertRefused(
        storage.createImmutable({ relativePath: 'f/three.json', kind: 'k.fan', id: 'two', value: { writer: 'B' } }),
        'ERR_STORAGE_DUPLICATE_IDENTITY',
      );
      assert.equal(existsSync(path.join(root, '.storage/lock')), false);
    });

    it('sequential nested write inside withLock remains supported and coherent', async () => {
      const root = await newRoot('t5-nested-sequential');
      const storage = createStorage({ root });
      const out = await storage.withLock(async () => {
        const first = await storage.createImmutable({
          relativePath: 'n/one.json',
          kind: 'k.nest',
          id: 'one',
          value: 1,
        });
        const second = await storage.createImmutable({
          relativePath: 'n/two.json',
          kind: 'k.nest',
          id: 'two',
          value: 2,
        });
        return [first.recordType, second.recordType];
      });
      assert.deepEqual(out, ['immutable', 'immutable']);
      assert.equal(existsSync(path.join(root, '.storage/lock')), false, 'nested depth fully drained before release');
    });
  });

  describe('read revalidates externally swapped root (junction/symlink)', () => {
    it('refuses a root replaced by a junction after caching', async () => {
      const base = await newRoot('t5-root-swap');
      const real = path.join(base, 'real');
      await mkdir(real, { recursive: true });
      const storage = createStorage({ root: real });
      await storage.createImmutable({
        relativePath: 'probe.record.json',
        kind: 'probe.record',
        id: 'r',
        value: 'original',
      });
      const other = path.join(base, 'other');
      await mkdir(other, { recursive: true });
      const otherStorage = createStorage({ root: other });
      await otherStorage.createImmutable({
        relativePath: 'probe.record.json',
        kind: 'probe.record',
        id: 'r',
        value: 'impersonated',
      });
      await rm(real, { recursive: true, force: true });
      try {
        await symlink(other, real, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') {
          // Symlink creation denied by platform policy: cannot exercise here.
          return;
        }
        throw error;
      }
      await assertRefused(
        storage.read({ relativePath: 'probe.record.json', kind: 'probe.record', id: 'r' }),
        ['ERR_STORAGE_ROOT_LINK', 'ERR_STORAGE_ROOT_NOT_FOUND'],
      );
    });
  });

  describe('root creation through a linked ancestor is refused upfront', () => {
    it('refuses before creating any directory through the link', async () => {
      const base = await newRoot('t5-linked-ancestor');
      const elsewhere = path.join(base, 'elsewhere');
      await mkdir(elsewhere, { recursive: true });
      const linked = path.join(base, 'linked');
      try {
        await symlink(elsewhere, linked, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') {
          return;
        }
        throw error;
      }
      const storage = createStorage({ root: path.join(linked, 'deep', 'root') });
      await assertRefused(
        storage.createImmutable({ relativePath: 'x.json', kind: 'probe.record', id: 'r', value: 1 }),
        'ERR_STORAGE_ROOT_LINK',
      );
      assert.equal(existsSync(path.join(elsewhere, 'deep')), false, 'nothing created inside the linked location');
      assert.equal(existsSync(path.join(linked, 'deep')), false, 'nothing created through the link path');
    });
  });
});

/**
 * C1 T6 repairs: interrupted immutable publication recovery. A bound
 * identity reservation is written into the registry BEFORE any immutable
 * byte publication; the mutable API never overwrites or type-converts
 * reserved or published-but-unregistered bytes, and recovery is explicit:
 * identical-byte createImmutable at the reserved path only.
 */
describe('C1 T6 repairs: interrupted publication reservation and recovery', () => {
  const registryAt = (root) => path.join(root, '.storage', 'registry.json');
  const entryAt = async (root, kind, id) => {
    const registry = JSON.parse(await readFile(registryAt(root), 'utf8'));
    return registry.records[JSON.stringify([kind, id])];
  };

  it('probe reproduction: beforeRegister abort leaves published reserved bytes; replaceMutable refuses and identical recovery binds', async () => {
    const root = await newRoot('t6-probe');
    const broken = createStorage({
      root,
      hooks: { beforeRegister: () => { throw new Error('injected registration failure'); } },
    });
    await assertRefused(
      broken.createImmutable({ relativePath: 'i.json', kind: 'r.report', id: 't6-a', value: { n: 1 } }),
      'ERR_STORAGE_HOOK_ABORT',
    );
    // Published bytes plus a bound reservation captured in the registry.
    const reserved = await entryAt(root, 'r.report', 't6-a');
    assert.equal(reserved.pending, true, 'identity reserved before publication');
    assert.equal(reserved.relativePath, 'i.json');
    assert.equal(reserved.recordType, 'immutable');
    const before = await readFile(path.join(root, 'i.json'));
    const beforeEnvelope = JSON.parse(before.toString('utf8'));
    assert.equal(beforeEnvelope.value.n, 1);
    assert.equal(reserved.digest, beforeEnvelope.digest, 'reservation digest matches published bytes');

    const healthy = createStorage({ root });
    await assertRefused(
      healthy.replaceMutable({ relativePath: 'i.json', kind: 'r.report', id: 't6-a', value: { n: 2 } }),
      'ERR_STORAGE_IMMUTABLE_REPLACEMENT',
      'reserved immutable identity refuses the mutable API',
    );
    const after = await readFile(path.join(root, 'i.json'));
    assert.ok(after.equals(before), 'published immutable bytes preserved through the refused mutable attempt');

    const recovered = await healthy.createImmutable({
      relativePath: 'i.json',
      kind: 'r.report',
      id: 't6-a',
      value: { n: 1 },
    });
    assert.equal(recovered.recovered, true, 'identical-bytes recovery completes the registration');
    identityOf(recovered, { kind: 'r.report', id: 't6-a', relativePath: 'i.json', recordType: 'immutable' });
    assert.deepEqual(await healthy.read({ relativePath: 'i.json', kind: 'r.report', id: 't6-a' }), { n: 1 });
    const finalized = await entryAt(root, 'r.report', 't6-a');
    assert.equal(finalized.pending, undefined, 'reservation replaced by the final registration');
    assert.equal(finalized.recordType, 'immutable');

    await assertRefused(
      healthy.createImmutable({ relativePath: 'i.json', kind: 'r.report', id: 't6-a', value: { n: 1 } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
      'duplicate refusal after recovery',
    );
    await assertRefused(
      healthy.replaceMutable({ relativePath: 'i.json', kind: 'r.report', id: 't6-a', value: { n: 3 } }),
      'ERR_STORAGE_IMMUTABLE_REPLACEMENT',
    );
    assert.deepEqual(await healthy.read({ relativePath: 'i.json', kind: 'r.report', id: 't6-a' }), { n: 1 });
  });

  it('cross-location protection: the reserved identity refuses creation and replacement elsewhere until reconciled', async () => {
    const root = await newRoot('t6-cross-location');
    const broken = createStorage({
      root,
      hooks: { beforeRegister: () => { throw new Error('injected registration failure'); } },
    });
    await assertRefused(
      broken.createImmutable({ relativePath: 'a/one.json', kind: 'r.report', id: 't6-b', value: { v: 1 } }),
      'ERR_STORAGE_HOOK_ABORT',
    );
    const healthy = createStorage({ root });
    await assertRefused(
      healthy.createImmutable({ relativePath: 'b/two.json', kind: 'r.report', id: 't6-b', value: { v: 2 } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
    );
    await assertRefused(
      healthy.replaceMutable({ relativePath: 'b/two.json', kind: 'r.report', id: 't6-b', value: { v: 2 } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
    );
    assert.equal(existsSync(path.join(root, 'b/two.json')), false, 'nothing published at the non-reserved location');
    const recovered = await healthy.createImmutable({
      relativePath: 'a/one.json',
      kind: 'r.report',
      id: 't6-b',
      value: { v: 1 },
    });
    assert.equal(recovered.recovered, true);
    await assertRefused(
      healthy.createImmutable({ relativePath: 'b/two.json', kind: 'r.report', id: 't6-b', value: { v: 1 } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
      'other locations cannot claim a registered identity',
    );
    assert.deepEqual(await healthy.read({ relativePath: 'a/one.json', kind: 'r.report', id: 't6-b' }), { v: 1 });
  });

  it('reservation-bound digest mismatch: different bytes at the reserved path refuse and never disturb the interrupted bytes', async () => {
    const root = await newRoot('t6-digest-bound');
    const broken = createStorage({
      root,
      hooks: { beforeRegister: () => { throw new Error('injected registration failure'); } },
    });
    await assertRefused(
      broken.createImmutable({ relativePath: 'a.json', kind: 'r.report', id: 't6-c', value: { n: 1 } }),
      'ERR_STORAGE_HOOK_ABORT',
    );
    const before = await readFile(path.join(root, 'a.json'));
    const healthy = createStorage({ root });
    await assertRefused(
      healthy.createImmutable({ relativePath: 'a.json', kind: 'r.report', id: 't6-c', value: { n: 2 } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
    );
    const after = await readFile(path.join(root, 'a.json'));
    assert.ok(after.equals(before), 'interrupted bytes untouched by the refused retry');
    const recovered = await healthy.createImmutable({
      relativePath: 'a.json',
      kind: 'r.report',
      id: 't6-c',
      value: { n: 1 },
    });
    assert.equal(recovered.recovered, true);
  });

  it('beforePublish abort: reservation stands without published bytes; identical retry publishes exactly once', async () => {
    const root = await newRoot('t6-stage-abort');
    const broken = createStorage({
      root,
      hooks: { beforePublish: () => { throw new Error('injected publication failure'); } },
    });
    await assertRefused(
      broken.createImmutable({ relativePath: 'x.json', kind: 'r.report', id: 't6-d', value: { n: 1 } }),
      'ERR_STORAGE_HOOK_ABORT',
    );
    assert.equal(existsSync(path.join(root, 'x.json')), false, 'no bytes published');
    const reserved = await entryAt(root, 'r.report', 't6-d');
    assert.equal(reserved.pending, true, 'reservation persisted before publication');
    assert.equal((await listDir(root)).filter((name) => name.includes('.staging-')).length, 0, 'no leaked scratch');

    const healthy = createStorage({ root });
    const result = await healthy.createImmutable({
      relativePath: 'x.json',
      kind: 'r.report',
      id: 't6-d',
      value: { n: 1 },
    });
    assert.equal(result.recovered, true, 'reservation recovery republishes identical bytes');
    identityOf(result, { kind: 'r.report', id: 't6-d', relativePath: 'x.json', recordType: 'immutable' });
    assert.deepEqual(await healthy.read({ relativePath: 'x.json', kind: 'r.report', id: 't6-d' }), { n: 1 });
  });

  it('SOTA1 F4: interrupted first-time mutable publication keeps a pending MUTABLE reservation; identical retry finalizes mutable and later updates stay allowed', async () => {
    const root = await newRoot('t10-mutable-first');
    const broken = createStorage({
      root,
      hooks: { beforeRegister: () => { throw new Error('injected registration failure'); } },
    });
    await assertRefused(
      broken.replaceMutable({ relativePath: 's.json', kind: 'state.record', id: 't10-a', value: { v: 1 } }),
      'ERR_STORAGE_HOOK_ABORT',
    );
    // Post-publication/before-registration abort: bytes published, no success
    // claimed, and the reservation carries the MUTABLE type.
    const before = await readFile(path.join(root, 's.json'));
    const beforeEnvelope = JSON.parse(before.toString('utf8'));
    assert.equal(beforeEnvelope.value.v, 1);
    const reserved = await entryAt(root, 'state.record', 't10-a');
    assert.equal(reserved.pending, true, 'first mutable publication reserved before bytes');
    assert.equal(reserved.recordType, 'mutable', 'reservation preserves the mutable record type');
    assert.equal(reserved.digest, beforeEnvelope.digest, 'reservation digest binds the published bytes');

    const healthy = createStorage({ root });
    // A different-bytes retry never claims the reserved identity.
    await assertRefused(
      healthy.replaceMutable({ relativePath: 's.json', kind: 'state.record', id: 't10-a', value: { v: 2 } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
      'different bytes refuse before overwriting the interrupted publication',
    );
    assert.ok((await readFile(path.join(root, 's.json'))).equals(before), 'interrupted bytes preserved through the refused retry');

    // Identical retry finalizes as MUTABLE (registration-only completion).
    const recovered = await healthy.replaceMutable({ relativePath: 's.json', kind: 'state.record', id: 't10-a', value: { v: 1 } });
    assert.equal(recovered.recovered, true, 'identical-byte mutable recovery completes the reservation');
    identityOf(recovered, { kind: 'state.record', id: 't10-a', relativePath: 's.json', recordType: 'mutable' });
    assert.equal(recovered.replaced, false, 'first-time publication replaced no prior record');
    const finalized = await entryAt(root, 'state.record', 't10-a');
    assert.equal(finalized.pending, undefined, 'reservation replaced by the final mutable registration');
    assert.equal(finalized.recordType, 'mutable', 'recovered identity stays mutable');

    // Later value changes remain allowed on the recovered mutable record.
    const updated = await healthy.replaceMutable({ relativePath: 's.json', kind: 'state.record', id: 't10-a', value: { v: 2 } });
    assert.equal(updated.replaced, true, 'recovered mutable record accepts later updates');
    assert.equal(updated.recovered, undefined, 'a normal replacement is not a recovery');
    assert.deepEqual(await healthy.read({ relativePath: 's.json', kind: 'state.record', id: 't10-a' }), { v: 2 });
  });

  it('SOTA1 F4: pre-publication abort leaves no final bytes and no reservation; identical first publication then works', async () => {
    const root = await newRoot('t10-mutable-prestage');
    const broken = createStorage({
      root,
      hooks: { beforeStage: () => { throw new Error('injected stage failure'); } },
    });
    await assertRefused(
      broken.replaceMutable({ relativePath: 'p.json', kind: 'state.record', id: 't10-b', value: { v: 1 } }),
      'ERR_STORAGE_HOOK_ABORT',
    );
    assert.equal(existsSync(path.join(root, 'p.json')), false, 'no final bytes before publication');
    assert.equal(existsSync(path.join(root, '.storage', 'registry.json')), false, 'no reservation before publication');
    assert.equal((await listDir(root)).filter((n) => n.includes('.staging-')).length, 0, 'no leaked scratch');

    const healthy = createStorage({ root });
    const created = await healthy.replaceMutable({ relativePath: 'p.json', kind: 'state.record', id: 't10-b', value: { v: 1 } });
    identityOf(created, { kind: 'state.record', id: 't10-b', relativePath: 'p.json', recordType: 'mutable' });
    assert.equal(created.recovered, undefined, 'a clean retry is not a recovery');
    assert.deepEqual(await healthy.read({ relativePath: 'p.json', kind: 'state.record', id: 't10-b' }), { v: 1 });
  });

  it('SOTA1 F4: pre-publication hook abort persists a typed mutable reservation with no bytes; identical retry republishes as mutable', async () => {
    const root = await newRoot('t10-mutable-prepublish');
    const gate = deferred();
    const hookWaiting = deferred();
    const broken = createStorage({
      root,
      hooks: {
        beforePublish: async () => {
          hookWaiting.resolve();
          await gate.promise;
        },
      },
    });
    const inFlight = broken.replaceMutable({ relativePath: 'q.json', kind: 'state.record', id: 't10-c', value: { v: 1 } });
    await hookWaiting.promise;
    gate.reject(new Error('injected publication failure'));
    await assertRefused(inFlight, 'ERR_STORAGE_HOOK_ABORT');
    assert.equal(existsSync(path.join(root, 'q.json')), false, 'no bytes published');
    const reserved = await entryAt(root, 'state.record', 't10-c');
    assert.equal(reserved.pending, true, 'reservation persisted before publication');
    assert.equal(reserved.recordType, 'mutable', 'reservation is typed mutable');
    assert.equal((await listDir(root)).filter((n) => n.includes('.staging-')).length, 0, 'transaction scratch cleaned');
    // No false success: the record does not read back before recovery.
    await assertRefused(
      createStorage({ root }).read({ relativePath: 'q.json', kind: 'state.record', id: 't10-c' }),
      'ERR_STORAGE_NOT_FOUND',
    );

    const healthy = createStorage({ root });
    const recovered = await healthy.replaceMutable({ relativePath: 'q.json', kind: 'state.record', id: 't10-c', value: { v: 1 } });
    assert.equal(recovered.recovered, true, 'reservation-backed republish recovers');
    identityOf(recovered, { kind: 'state.record', id: 't10-c', relativePath: 'q.json', recordType: 'mutable' });
    assert.equal(recovered.replaced, false);
    assert.deepEqual(await healthy.read({ relativePath: 'q.json', kind: 'state.record', id: 't10-c' }), { v: 1 });
    const later = await healthy.replaceMutable({ relativePath: 'q.json', kind: 'state.record', id: 't10-c', value: { v: 9 } });
    assert.equal(later.replaced, true, 'recovered mutable record accepts later updates');
  });

  it('SOTA1 F4: reserved mutable identity refuses cross-location retries and createImmutable type conversion; bytes preserved', async () => {
    const root = await newRoot('t10-mutable-conflicts');
    const broken = createStorage({
      root,
      hooks: { beforeRegister: () => { throw new Error('injected registration failure'); } },
    });
    await assertRefused(
      broken.replaceMutable({ relativePath: 'c.json', kind: 'state.record', id: 't10-d', value: { v: 1 } }),
      'ERR_STORAGE_HOOK_ABORT',
    );
    const before = await readFile(path.join(root, 'c.json'));
    const reserved = await entryAt(root, 'state.record', 't10-d');
    assert.equal(reserved.recordType, 'mutable');

    const healthy = createStorage({ root });
    // Cross-location refusal (both APIs), nothing published elsewhere.
    await assertRefused(
      healthy.replaceMutable({ relativePath: 'elsewhere.json', kind: 'state.record', id: 't10-d', value: { v: 1 } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
    );
    await assertRefused(
      healthy.createImmutable({ relativePath: 'elsewhere.json', kind: 'state.record', id: 't10-d', value: { v: 1 } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
    );
    assert.equal(existsSync(path.join(root, 'elsewhere.json')), false, 'never republished at another location');

    // Type conversion over the pending mutable reservation is refused with
    // the original bytes untouched.
    await assertRefused(
      healthy.createImmutable({ relativePath: 'c.json', kind: 'state.record', id: 't10-d', value: { v: 1 } }),
      'ERR_STORAGE_TYPE_CONFLICT',
    );
    const refused = await (async () => {
      try {
        await healthy.createImmutable({ relativePath: 'c.json', kind: 'state.record', id: 't10-d', value: { v: 1 } });
      } catch (error) {
        return error;
      }
      throw new Error('expected refusal');
    })();
    assert.equal(refused.details.pendingRegistration, true);
    assert.equal(refused.details.reservedRecordType, 'mutable');
    assert.equal(refused.details.reservedDigest, reserved.digest);
    assert.ok((await readFile(path.join(root, 'c.json'))).equals(before), 'bytes untouched by the type-conflict refusal');

    // Recovery still completes as mutable after the refusals.
    const recovered = await healthy.replaceMutable({ relativePath: 'c.json', kind: 'state.record', id: 't10-d', value: { v: 1 } });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.recordType, 'mutable');
  });

  it('SOTA1 F4: crafted pending MUTABLE registry (exact interrupted-state shape) reconciles through the mutable API; corrupt reservation shapes fail closed', async () => {
    const root = await newRoot('t10-crafted-mutable');
    const storage = createStorage({ root });
    // Materialize the registry on the target root with an unrelated seed
    // record before hand-crafting the interrupted-state shape.
    await storage.createImmutable({ relativePath: 'seed.json', kind: 'k.seed', id: 'seed', value: 0 });
    const source = createStorage({ root: await newRoot('t10-crafted-mutable-src') });
    const known = await source.replaceMutable({ relativePath: 'src.json', kind: 'state.record', id: 'cr-m', value: { v: 1 } });
    // Simulate the exact durable state of an interrupted first-time mutable
    // publication: published bytes plus the pending mutable reservation.
    const registry = JSON.parse(await readFile(registryAt(root), 'utf8'));
    registry.records[JSON.stringify(['state.record', 'cr-m'])] = {
      relativePath: 'm.json',
      digest: known.digest,
      recordType: 'mutable',
      pending: true,
    };
    await writeFile(registryAt(root), JSON.stringify(registry));
    await mkdir(path.join(root, 'sub'), { recursive: true });
    await writeFile(path.join(root, 'm.json'), await readFile(path.join(source.root, 'src.json')));
    const recovered = await storage.replaceMutable({ relativePath: 'm.json', kind: 'state.record', id: 'cr-m', value: { v: 1 } });
    assert.equal(recovered.recovered, true, 'pending mutable reservation reconciled with identical bytes');
    assert.equal(recovered.recordType, 'mutable');
    const finalized = await entryAt(root, 'state.record', 'cr-m');
    assert.equal(finalized.pending, undefined);
    assert.equal(finalized.recordType, 'mutable');
    assert.deepEqual(await storage.read({ relativePath: 'm.json', kind: 'state.record', id: 'cr-m' }), { v: 1 });

    // Corrupt reservation shapes keep failing closed on any write.
    const badShapes = [
      { relativePath: 'x.json', digest: known.digest, recordType: 'mutable', pending: 'true' },
      { relativePath: 'x.json', digest: known.digest, recordType: 'immutable', pending: 1 },
      { relativePath: 'x.json', digest: 'nothex', recordType: 'mutable', pending: true },
    ];
    for (const bad of badShapes) {
      const brokenRegistry = JSON.parse(await readFile(registryAt(root), 'utf8'));
      brokenRegistry.records[JSON.stringify(['state.record', 'cr-bad'])] = bad;
      await writeFile(registryAt(root), JSON.stringify(brokenRegistry));
      await assertRefused(
        storage.replaceMutable({ relativePath: 'y.json', kind: 'state.record', id: 'cr-bad', value: { v: 1 } }),
        'ERR_STORAGE_REGISTRY_CORRUPT',
      );
      await assertRefused(
        storage.createImmutable({ relativePath: 'y.json', kind: 'state.record', id: 'cr-bad', value: { v: 1 } }),
        'ERR_STORAGE_REGISTRY_CORRUPT',
      );
    }
  });

  it('SOTA1 F4: interrupted mutable publication releases the lock cleanly and serializes a second writer (no false success, no leaked lock)', async () => {
    const root = await newRoot('t10-mutable-lock');
    const broken = createStorage({
      root,
      hooks: { beforeRegister: () => { throw new Error('injected registration failure'); } },
    });
    await assertRefused(
      broken.replaceMutable({ relativePath: 'l.json', kind: 'state.record', id: 't10-e', value: { v: 1 } }),
      'ERR_STORAGE_HOOK_ABORT',
    );
    // The aborted transaction must not leave the root-wide lock behind.
    const healthy = createStorage({ root });
    await healthy.withLock(async () => 'acquired-after-abort');
    // A concurrent same-instance writer serializes through the FIFO gate.
    const order = [];
    const first = healthy.replaceMutable({ relativePath: 'l.json', kind: 'state.record', id: 't10-e', value: { v: 1 } })
      .then((result) => { order.push('recovered'); return result; });
    const second = healthy.replaceMutable({ relativePath: 'l.json', kind: 'state.record', id: 't10-e', value: { v: 2 } })
      .then((result) => { order.push('updated'); return result; });
    const [recovered, updated] = await Promise.all([first, second]);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.recordType, 'mutable');
    assert.equal(updated.replaced, true);
    assert.deepEqual(order, ['recovered', 'updated'], 'deterministic FIFO serialization');
    assert.deepEqual(await healthy.read({ relativePath: 'l.json', kind: 'state.record', id: 't10-e' }), { v: 2 });
    assert.equal((await listDir(root)).filter((n) => n.includes('.staging-')).length, 0, 'no leaked staging bytes');
  });

  it('pre-reservation straggler: identical-byte reconciliation without any registry entry (legacy interrupted state)', async () => {
    // Simulate a pre-T6 interrupted createImmutable: published bytes with no
    // registry entry at all (registry file removed from the source root).
    const source = createStorage({ root: await newRoot('t6-straggler-src') });
    const known = await source.createImmutable({ relativePath: 'src.json', kind: 'k.str', id: 'str-1', value: { v: 1 } });
    await rm(registryAt(source.root), { force: true });
    const root = await newRoot('t6-straggler');
    await writeFile(path.join(root, 'i.json'), await readFile(path.join(source.root, 'src.json')));
    const storage = createStorage({ root });
    await assertRefused(
      storage.replaceMutable({ relativePath: 'i.json', kind: 'k.str', id: 'str-1', value: { v: 1 } }),
      'ERR_STORAGE_IMMUTABLE_REPLACEMENT',
      'unregistered published bytes are never overwritten through the mutable API',
    );
    const recovered = await storage.createImmutable({ relativePath: 'i.json', kind: 'k.str', id: 'str-1', value: { v: 1 } });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.digest, known.digest);
    assert.deepEqual(await storage.read({ relativePath: 'i.json', kind: 'k.str', id: 'str-1' }), { v: 1 });
  });

  it('fail closed: corrupt or digest-damaged unregistered targets refuse before any mutable action', async () => {
    const storage = createStorage({ root: await newRoot('t6-failclosed') });
    const corruptPath = path.join(storage.root, 'c.json');
    await writeFile(corruptPath, '{ not an envelope');
    await assertRefused(
      storage.replaceMutable({ relativePath: 'c.json', kind: 'k.str', id: 'fc-1', value: { v: 1 } }),
      'ERR_STORAGE_ENVELOPE_MALFORMED',
    );
    assert.equal(existsSync(corruptPath), true, 'target bytes preserved');
    const source = createStorage({ root: await newRoot('t6-failclosed-src') });
    await source.createImmutable({ relativePath: 't.json', kind: 'k.str', id: 'fc-2', value: { v: 2 } });
    const tampered = JSON.parse((await readFile(path.join(source.root, 't.json'))).toString('utf8'));
    tampered.value = { v: 3 };
    const damagedPath = path.join(storage.root, 'd.json');
    await writeFile(damagedPath, JSON.stringify(tampered));
    await assertRefused(
      storage.replaceMutable({ relativePath: 'd.json', kind: 'k.str', id: 'fc-2', value: { v: 3 } }),
      'ERR_STORAGE_DIGEST_MISMATCH',
    );
    assert.equal(existsSync(damagedPath), true, 'damaged target bytes preserved');
  });

  it('crafted pending registry entry (exact interrupted-state shape) reconciles through the public API', async () => {
    const root = await newRoot('t6-crafted');
    const storage = createStorage({ root });
    const created = await storage.createImmutable({ relativePath: 'i.json', kind: 'k.str', id: 'cr-1', value: { v: 1 } });
    // Rewrite the registry into the reservation shape — the exact durable
    // state an interrupted publication leaves behind.
    const registry = JSON.parse(await readFile(registryAt(root), 'utf8'));
    registry.records[JSON.stringify(['k.str', 'cr-1'])] = {
      relativePath: 'i.json',
      digest: created.digest,
      recordType: 'immutable',
      pending: true,
    };
    await writeFile(registryAt(root), JSON.stringify(registry));
    const recovered = await storage.createImmutable({ relativePath: 'i.json', kind: 'k.str', id: 'cr-1', value: { v: 1 } });
    assert.equal(recovered.recovered, true, 'pending reservation reconciled with identical bytes');
    const finalized = await entryAt(root, 'k.str', 'cr-1');
    assert.equal(finalized.pending, undefined);
    assert.equal(finalized.recordType, 'immutable');
    await assertRefused(
      storage.createImmutable({ relativePath: 'j.json', kind: 'k.str', id: 'cr-1', value: { v: 1 } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
      'other locations cannot claim a registered identity',
    );
  });
});

describe('injected transaction failures leave honest recoverable state', () => {
  async function newHookedRoot(label) {
    const root = await newRoot(label);
    return { root };
  }

  it('beforeStage failure: no final bytes, no registry entry, resolving retry works', async () => {
    const root = await newRoot('fail-stage');
    const storage = createStorage({
      root,
      hooks: {
        beforeStage: () => {
          throw new Error('injected stage failure');
        },
      },
    });
    await assertRefused(
      storage.createImmutable({ relativePath: 'f/one.json', kind: 'r.report', id: 'stage-1', value: { n: 1 } }),
      'ERR_STORAGE_HOOK_ABORT',
    );
    assert.equal(existsSync(path.join(root, 'f/one.json')), false, 'no partial final bytes');
    assert.equal((await listDir(path.join(root, 'f'))).filter((n) => n.includes('.staging-')).length, 0, 'no leaked scratch');

    const retryStorage = createStorage({ root });
    const result = await retryStorage.createImmutable({
      relativePath: 'f/one.json',
      kind: 'r.report',
      id: 'stage-1',
      value: { n: 1 },
    });
    identityOf(result, { kind: 'r.report', id: 'stage-1', relativePath: 'f/one.json', recordType: 'immutable' });
  });

  it('beforePublish failure: no published record, scratch cleaned except foreign decoys', async () => {
    const root = await newRoot('fail-publish');
    await mkdir(path.join(root, 'f'), { recursive: true });
    await writeFile(path.join(root, 'f', '.preexisting.staging-notmine.tmp'), 'decoy');
    const gate = deferred();
    const hookWaiting = deferred();
    const storage = createStorage({
      root,
      hooks: {
        beforePublish: async () => {
          hookWaiting.resolve();
          await gate.promise;
        },
      },
    });
    const inFlight = storage.createImmutable({
      relativePath: 'f/one.json',
      kind: 'r.report',
      id: 'pub-1',
      value: { n: 1 },
    });
    await hookWaiting.promise;
    gate.reject(new Error('injected publication failure'));
    await assertRefused(inFlight, 'ERR_STORAGE_HOOK_ABORT');
    assert.equal(existsSync(path.join(root, 'f/one.json')), false, 'nothing published');
    const entries = await listDir(path.join(root, 'f'));
    assert.equal(entries.filter((n) => n.endsWith('.staging-notmine.tmp')).length, 1, 'foreign scratch untouched');
    assert.equal(entries.filter((n) => n !== '.preexisting.staging-notmine.tmp' && n !== 'one.json').length, 0, 'transaction-owned scratch cleaned');

    const retryStorage = createStorage({ root });
    await retryStorage.createImmutable({ relativePath: 'f/one.json', kind: 'r.report', id: 'pub-1', value: { n: 1 } });
    assert.deepEqual(await retryStorage.read({ relativePath: 'f/one.json', kind: 'r.report', id: 'pub-1' }), { n: 1 });
  });

  it('beforeRegister failure on immutable: published bytes intact, no success claim, retry with identical bytes reconciles; different bytes refused', async () => {
    const root = await newRoot('fail-register');
    const storage = createStorage({
      root,
      hooks: { beforeRegister: () => { throw new Error('injected registration failure'); } },
    });
    await assertRefused(
      storage.createImmutable({ relativePath: 'f/one.json', kind: 'r.report', id: 'reg-1', value: { n: 1 } }),
      'ERR_STORAGE_HOOK_ABORT',
    );
    // The bytes were published; no success was claimed; no registry entry yet.
    assert.equal(existsSync(path.join(root, 'f/one.json')), true);
    const raw = JSON.parse(await readFile(path.join(root, 'f/one.json'), 'utf8'));
    assert.equal(raw.kind, 'r.report');
    assert.equal(raw.id, 'reg-1');

    // A conservative retry with identical bytes reconciles the registry entry.
    const retryStorage = createStorage({ root });
    const recovered = await retryStorage.createImmutable({
      relativePath: 'f/one.json',
      kind: 'r.report',
      id: 'reg-1',
      value: { n: 1 },
    });
    assert.equal(recovered.recovered, true, 'retry reconciles the interrupted publication');
    assert.deepEqual(await retryStorage.read({ relativePath: 'f/one.json', kind: 'r.report', id: 'reg-1' }), { n: 1 });
    await assertRefused(
      retryStorage.createImmutable({ relativePath: 'f/one.json', kind: 'r.report', id: 'reg-1', value: { n: 1 } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
      'after recovery the identity is registered and duplicates refuse again',
    );

    // A different value under the already-registered identity is refused; the
    // published original stays intact and unchanged.
    await assertRefused(
      retryStorage.createImmutable({ relativePath: 'f/one.json', kind: 'r.report', id: 'reg-1', value: { n: 2 } }),
      'ERR_STORAGE_DUPLICATE_IDENTITY',
    );
    assert.deepEqual(
      await retryStorage.read({ relativePath: 'f/one.json', kind: 'r.report', id: 'reg-1' }),
      { n: 1 },
    );
  });

  it('beforePublish failure on mutable: old value still readable, no new bytes', async () => {
    const root = await newRoot('fail-mutable-publish');
    const gate = deferred();
    const hookWaiting = deferred();
    const broken = createStorage({
      root,
      hooks: {
        beforePublish: async () => {
          hookWaiting.resolve();
          await gate.promise;
        },
      },
    });
    const healthy = createStorage({ root });
    await healthy.replaceMutable({ relativePath: 'state.json', kind: 'state.record', id: 'm-1', value: { v: 1 } });
    const inFlight = broken.replaceMutable({ relativePath: 'state.json', kind: 'state.record', id: 'm-1', value: { v: 2 } });
    await hookWaiting.promise;
    gate.reject(new Error('injected publication failure'));
    await assertRefused(inFlight, 'ERR_STORAGE_HOOK_ABORT');
    assert.deepEqual(
      await healthy.read({ relativePath: 'state.json', kind: 'state.record', id: 'm-1' }),
      { v: 1 },
      'old value survives an aborted publication',
    );
    const entries = await listDir(root);
    assert.equal(entries.filter((n) => n.includes('.staging-')).length, 0, 'no leaked staging bytes in root dir');
  });

  it('beforeRegister failure on mutable: value replaced on disk, registry heals on the next replacement', async () => {
    const root = await newRoot('fail-mutable-register');
    const broken = createStorage({
      root,
      hooks: { beforeRegister: () => { throw new Error('injected registration failure'); } },
    });
    const healthy = createStorage({ root });
    await healthy.replaceMutable({ relativePath: 'state.json', kind: 'state.record', id: 'm-1', value: { v: 1 } });
    await assertRefused(
      broken.replaceMutable({ relativePath: 'state.json', kind: 'state.record', id: 'm-1', value: { v: 2 } }),
      'ERR_STORAGE_HOOK_ABORT',
    );
    assert.deepEqual(
      await healthy.read({ relativePath: 'state.json', kind: 'state.record', id: 'm-1' }),
      { v: 2 },
      'publication of the replacement succeeded',
    );
    const third = await healthy.replaceMutable({ relativePath: 'state.json', kind: 'state.record', id: 'm-1', value: { v: 3 } });
    assert.equal(third.replaced, true, 'registry staleness from an interrupted transaction heals on the next replacement');
    assert.deepEqual(
      await healthy.read({ relativePath: 'state.json', kind: 'state.record', id: 'm-1' }),
      { v: 3 },
      'registry now agrees with the file bytes',
    );
  });
});

describe('corrupt and identity-mismatched record detection', () => {
  async function storedFromFixture(root, name, relativePath) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), await fixtureBytes(name));
    return createStorage({ root });
  }

  it('valid fixture reads back after integrity verification', async () => {
    const root = await newRoot('fixture-valid');
    const storage = await storedFromFixture(root, 'valid-envelope.json', 'fixtures/valid.json');
    const value = await storage.read({ relativePath: 'fixtures/valid.json', kind: 'fixture.valid', id: 'v-1' });
    assert.deepEqual(value, { alpha: 1, beta: [null, 0, false], gamma: 'x' });
  });

  it('corrupt bytes are refused as malformed', async () => {
    const root = await newRoot('fixture-corrupt');
    const storage = await storedFromFixture(root, 'corrupt-envelope.json', 'fixtures/corrupt.json');
    await assertRefused(
      storage.read({ relativePath: 'fixtures/corrupt.json', kind: 'fixture.valid', id: 'v-1' }),
      'ERR_STORAGE_ENVELOPE_MALFORMED',
    );
  });

  it('digest-mismatched bytes are refused', async () => {
    const root = await newRoot('fixture-digest');
    const storage = await storedFromFixture(root, 'digest-mismatch.json', 'fixtures/mismatch.json');
    await assertRefused(
      storage.read({ relativePath: 'fixtures/mismatch.json', kind: 'fixture.valid', id: 'v-1' }),
      'ERR_STORAGE_DIGEST_MISMATCH',
    );
  });

  it('unknown schema major is refused', async () => {
    const root = await newRoot('fixture-schema');
    const storage = await storedFromFixture(root, 'schema-unknown.json', 'fixtures/unknown.json');
    await assertRefused(
      storage.read({ relativePath: 'fixtures/unknown.json', kind: 'fixture.valid', id: 'v-1' }),
      'ERR_STORAGE_ENVELOPE_MALFORMED',
    );
  });

  it('identity mismatch between request and envelope is refused; correct binding reads fine', async () => {
    const root = await newRoot('fixture-identity');
    const storage = await storedFromFixture(root, 'identity-mismatch.json', 'fixtures/identity.json');
    await assertRefused(
      storage.read({ relativePath: 'fixtures/identity.json', kind: 'fixture.beta', id: 'a-1' }),
      'ERR_STORAGE_IDENTITY_MISMATCH',
    );
    await assertRefused(
      storage.read({ relativePath: 'fixtures/identity.json', kind: 'fixture.alpha', id: 'different' }),
      'ERR_STORAGE_IDENTITY_MISMATCH',
    );
    assert.deepEqual(
      await storage.read({ relativePath: 'fixtures/identity.json', kind: 'fixture.alpha', id: 'a-1' }),
      { note: 'identity binding sample', numbers: [null, 0] },
    );
  });

  it('envelope with extra keys is refused as malformed', async () => {
    const root = await newRoot('fixture-extra-keys');
    const extra = JSON.parse((await fixtureBytes('valid-envelope.json')).toString('utf8'));
    extra.attackerNote = 'tampered';
    await mkdir(path.dirname(path.join(root, 'extra.json')), { recursive: true });
    await writeFile(path.join(root, 'extra.json'), JSON.stringify(extra));
    const storage = createStorage({ root });
    await assertRefused(
      storage.read({ relativePath: 'extra.json', kind: 'fixture.valid', id: 'v-1' }),
      'ERR_STORAGE_ENVELOPE_MALFORMED',
    );
  });
});

describe('registry consistency handling', () => {
  it('writes refuse against a corrupt local registry; verified reads still work', async () => {
    const root = await newRoot('registry-corrupt');
    const storage = createStorage({ root });
    await storage.createImmutable({ relativePath: 'ok.json', kind: 'k.one', id: 'i-1', value: 1 });
    await writeFile(path.join(root, '.storage/registry.json'), '{not json');
    await assertRefused(
      storage.createImmutable({ relativePath: 'other.json', kind: 'k.one', id: 'i-2', value: 2 }),
      'ERR_STORAGE_REGISTRY_CORRUPT',
    );
    await assertRefused(
      storage.replaceMutable({ relativePath: 'ok.json', kind: 'k.one', id: 'i-1', value: 2 }),
      'ERR_STORAGE_REGISTRY_CORRUPT',
    );
    assert.equal(
      await storage.read({ relativePath: 'ok.json', kind: 'k.one', id: 'i-1' }),
      1,
      'read relies on verified file integrity and identity binding',
    );
  });
});

/* ------- helpers ------- */

function assertRefusedCode(error) {
  assert.ok(
    [
      'ERR_STORAGE_DUPLICATE_IDENTITY',
      'ERR_STORAGE_LOCK_CONFLICT',
      'ERR_STORAGE_TARGET_EXISTS',
      'ERR_STORAGE_PATH_CONFLICT',
      'ERR_STORAGE_NOT_REGULAR_FILE',
      'ERR_STORAGE_ENVELOPE_MALFORMED',
    ].includes(error && error.code),
    `expected a refusal code, got ${error && error.code}`,
  );
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
