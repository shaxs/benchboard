import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root, files, sha, writeSnapshot } from '../files.mjs';
import { verifyPacket } from '../review-packet.mjs';
const packet = (n) =>
  path.join(
    root,
    `artifacts/review/BenchBoard-1.0.0-candidate.${n}-owner-review`,
  );
test('historical candidate.2 and .3 integrity; freshness against candidate.3 snapshot', () => {
  const h = JSON.parse(
    fs.readFileSync(path.join(packet(3), 'manifest.json'), 'utf8'),
  ).candidate;
  assert.equal(verifyPacket(packet(2)).integrity, 'PASS');
  assert.equal(
    verifyPacket(packet(2), {
      mode: 'freshness',
      currentHashes: h,
      compareSourceBytes: false,
    }).freshness,
    'STALE',
  );
  assert.equal(verifyPacket(packet(3)).integrity, 'PASS');
  assert.equal(
    verifyPacket(packet(3), {
      mode: 'freshness',
      currentHashes: h,
      compareSourceBytes: false,
    }).freshness,
    'CURRENT',
  );
});
test('fixture parity is semantic, independent of line endings', () => {
  for (const [canonical, publicName] of [
    ['v1.json', 'fixtures.json'],
    ['v0.json', 'legacy.json'],
  ]) {
    const expected = JSON.parse(
      fs.readFileSync(path.join(root, 'fixtures', canonical), 'utf8'),
    );
    for (const app of ['starter', 'reference'])
      assert.deepEqual(
        JSON.parse(
          fs.readFileSync(path.join(root, app, 'src', publicName), 'utf8'),
        ),
        expected,
      );
  }
});
test('public source and tracked specification text contain no known encoding corruption', () => {
  const markers = [
    '\u00c2\u00b7',
    '\u00c3\u2014',
    '\u00e2\u20ac\u201c',
    '\u00e2\u20ac\u201d',
    '\u00e2\u20ac\u00a6',
    '\u00ef\u00bb\u00bf',
    '\u00c3\u00af\u00c2\u00bb\u00c2\u00bf',
    '\ufffd',
    '\ufeff',
  ];
  for (const base of ['starter', 'spec'])
    for (const p of files(path.join(root, base))) {
      const t = fs.readFileSync(path.join(root, base, p), 'utf8');
      for (const marker of markers)
        assert.ok(
          !t.includes(marker),
          `${base}/${p}: ${JSON.stringify(marker)}`,
        );
    }
});
test('prepared snapshot does not overwrite a reviewed candidate tuple under its old version', () => {
  const versionFile = path.join(root, 'version.json');
  const original = fs.readFileSync(versionFile);
  const manifest = path.join(root, 'artifacts/candidate-manifest.json');
  const before = fs.readFileSync(manifest);
  try {
    const historical = JSON.parse(
      fs.readFileSync(path.join(packet(3), 'manifest.json'), 'utf8'),
    ).candidate.version;
    fs.writeFileSync(versionFile, JSON.stringify(historical));
    assert.throws(() => writeSnapshot(), /Reviewed candidate tuple/);
    assert.ok(fs.readFileSync(manifest).equals(before));
  } finally {
    fs.writeFileSync(versionFile, original);
  }
});

// The reviewer runs the suite on a fresh checkout, where the committed
// candidate-manifest.json may not yet equal the recomputed tuple. A suite that
// calls writeSnapshot() against the real path would silently rewrite a review
// input in exactly that situation and nothing would notice on a second run.
// Make the condition real: stale the manifest, run the suites that touch the
// snapshot in a child process, and require the reviewed bytes to survive.
test('test suites never rewrite the reviewed candidate manifest, even when it is stale', () => {
  const manifest = path.join(root, 'artifacts/candidate-manifest.json');
  const original = fs.readFileSync(manifest);
  const stale = JSON.stringify(
    { ...JSON.parse(original.toString('utf8')), runner: 'stale-on-purpose' },
    null,
    2,
  );
  const suites = [
    'ceiling.test.mjs',
    'harness.test.mjs',
    'governed-chain.test.mjs',
    'execution-authority.test.mjs',
  ].map((n) =>
    path.join(root, 'runner/tests', n),
  );
  try {
    fs.writeFileSync(manifest, stale);
    // node:test refuses to run recursively while NODE_TEST_CONTEXT is set, and
    // a skipped child would make this regression vacuous. Strip it and require
    // positive evidence that the child really executed the suites.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    // Also drop any inherited redirection, so the child really does face the
    // reviewed manifest path and this regression cannot pass vacuously.
    delete env.BENCHBOARD_MANIFEST_PATH;
    const child = spawnSync(
      process.execPath,
      ['--test', '--test-concurrency=1', ...suites],
      { cwd: root, encoding: 'utf8', env, windowsHide: true },
    );
    const ran = Number(/^(?:#|ℹ) pass (\d+)$/m.exec(child.stdout ?? '')?.[1] ?? 0);
    assert.ok(ran > 25, 'child suites did not actually run (pass=' + ran + ')');
    assert.equal(child.status, 0, 'snapshot-touching suites must still pass');
    assert.equal(
      fs.readFileSync(manifest, 'utf8'),
      stale,
      'a test suite rewrote artifacts/candidate-manifest.json',
    );
  } finally {
    fs.writeFileSync(manifest, original);
  }
});
