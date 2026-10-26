/**
 * Independent relocated synthetic CLI identity acceptance (task packet C7a.S7.T1).
 *
 * Four groups: (1) the synthetic installation identity surface compared against
 * the real development loader, (2) two independently prepared fixtures keep the
 * challenge/evaluator identity while the tooling identity changes with a tooling
 * note, (3) eight tampered-fixture mutations each refuse with the command integrity
 * error after a successful prior load, and (4) runtime root overrides and the
 * unprepared packaged loader in the development checkout refuse the same way.
 *
 * The tests load identities only. They execute no CLI process, evaluation, manual
 * workflow or installation, import nothing from adapters/dsh, and claim nothing
 * about the end-to-end installed workflow; unchanged fast/CLI gates already cover
 * external run/results behaviour. The Captain owns the trust code and the prepared
 * fixture; this file only calls their public documented surface.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInstallation as loadDevelopmentInstallation } from '../../../cli/installation.mjs';
import { syntheticCliFixture } from './packaged-cli-fixture.mjs';
import { sha256, hashEntries } from '../../../packages/core/identity.mjs';

const ANCHOR = { descriptor: 'cli/installation.json', index: 'cli/installed-assets.json' };
const readJson = (root, relative) => JSON.parse(fs.readFileSync(path.join(root, ...relative.split('/'))));
/* CommandError in cli/command-error.mjs keeps the default Error name, so its class
 * identity is the constructor name. instanceof across the relocated copy cannot be
 * used because the fixture root loads its own module instances of the same sources. */
const refusesCommandError = (error) => error instanceof Error && error.name === 'Error' && !['TypeError', 'SyntaxError'].includes(error.constructor.name)
  && error.constructor.name === 'CommandError' && String(error.message) === 'CLI_INTEGRITY' && error.category === 'integrity';
async function withFixture(run, options) { const fixture = syntheticCliFixture(options); try { await run(fixture); } finally { fixture.cleanup(); } }
function walkPaths(root) { const found = []; const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { if (entry.name === 'node_modules') continue; const full = path.join(dir, entry.name); found.push(full); if (entry.isDirectory()) walk(full); } }; walk(root); return found; }

describe('synthetic relocated installation — group 1: the identity surface matches the development loader where required', () => {
  test('the synthetic load carries documented synthetic identity fields, the shared challenge/evaluator identity, and no approval bit', async () => withFixture(async (fixture) => {
    const installed = await fixture.load();
    const development = loadDevelopmentInstallation();
    assert.equal(development.descriptor.kind, 'benchboard.cli.development-installation.v1');
    assert.equal(development.descriptor.developmentOnly, true);
    assert.equal(development.toolingIdentity.toolingComponent, 'checkout-cli');
    assert.equal(installed.descriptor.kind, 'benchboard.cli.synthetic-installation.v1');
    assert.equal(installed.descriptor.authorization, 'synthetic-only');
    assert.equal(installed.descriptor.packageName, '@benchboard/synthetic-tooling');
    assert.equal(installed.descriptor.packageVersion, '0.0.0-synthetic');
    assert.equal(installed.toolingIdentity.toolingComponent, 'synthetic-package-cli');
    assert.equal(installed.toolingIdentity.toolingId, 'benchboard-tooling-cli-synthetic-package');
    assert.match(installed.toolingIdentity.notes, /synthetic/i);
    assert.notEqual(installed.toolingIdentity.notes, development.toolingIdentity.notes);
    assert.ok(installed.root.includes(' ') && installed.root === fixture.root);
    assert.deepEqual(installed.challenge.identity, development.challenge.identity);
    assert.deepEqual(installed.evaluatorIdentity, development.evaluatorIdentity);
    assert.equal(installed.descriptor.workloadDigest, development.descriptor.workloadDigest);
    for (const key of ['publicPrdDigest', 'visibleDigest', 'fixtureDigest'])
      assert.equal(installed.descriptor[key], development.descriptor[key]);
    for (const entry of development.actualEvaluator.semanticManifest) {
      const selected = installed.assetManifest.find((one) => one.path === entry.path);
      assert.ok(selected, `the selected semantic asset ${entry.path} is indexed`);
      assert.equal(selected.sha256, sha256(fs.readFileSync(path.join(fixture.root, ...entry.path.split('/')))),
        `the indexed digest for ${entry.path} matches the bytes on disk`);
    }
    assert.deepEqual(installed.actualEvaluator.originalCandidate, development.actualEvaluator.originalCandidate);
    assert.equal(installed.actualEvaluator.semanticDigest, development.actualEvaluator.semanticDigest);
    assert.notEqual(installed.toolingIdentity.identityDigest, development.toolingIdentity.identityDigest);
    assert.notEqual(hashEntries(installed.assetManifest), hashEntries(development.assetManifest));
    assert.equal(installed.evaluatorIdentity.exposure, 'OWNER_LOCAL');
    assert.equal(installed.evaluatorIdentity.transparency, 'LOCAL_VISIBLE');
    assert.equal(installed.evaluatorIdentity.secretClaim, false);
    const approvalLike = (key) => /^(public|license|licence|release|released|distribution|approval|approved)$/i.test(key);
    for (const record of [installed.descriptor, development.descriptor, installed.toolingIdentity, development.toolingIdentity,
      installed.challenge.identity, development.challenge.identity, installed.evaluatorIdentity, development.evaluatorIdentity])
      for (const key of Object.keys(record))
        assert.ok(!approvalLike(key), `the record key ${key} would claim a public, license or release approval the loader never makes`);
  }));
});

describe('synthetic relocated installation — group 2: a tooling-note rebuild moves tooling identity only', () => {
  test('two independently prepared fixtures keep identical challenge/evaluator identity while tooling identity differs', async () => {
    const development = loadDevelopmentInstallation();
    await withFixture(async (plain) => {
      await withFixture(async (changed) => {
        const before = await plain.load();
        const after = await changed.load();
        assert.deepEqual(after.challenge.identity, before.challenge.identity);
        assert.deepEqual(after.evaluatorIdentity, before.evaluatorIdentity);
        assert.deepEqual(after.challenge.identity, development.challenge.identity);
        assert.equal(after.actualEvaluator.semanticDigest, before.actualEvaluator.semanticDigest);
        assert.equal(after.actualEvaluator.semanticDigest, development.actualEvaluator.semanticDigest);
        assert.deepEqual(after.actualEvaluator.originalCandidate, before.actualEvaluator.originalCandidate);
        assert.deepEqual(after.actualEvaluator.originalCandidate, development.actualEvaluator.originalCandidate);
        assert.notEqual(after.toolingIdentity.identityDigest, before.toolingIdentity.identityDigest);
        assert.notEqual(after.toolingIdentity.installedDigest, before.toolingIdentity.installedDigest);
        const sealed = [...walkPaths(plain.root), ...walkPaths(changed.root)];
        assert.ok(!sealed.some((full) => path.basename(full) === 'run.json'
          || (path.basename(full).startsWith('.benchboard') && path.basename(full).endsWith('-results'))));
      }, { toolingNote: 'ordinary synthetic wrapper change' });
    });
  });
});

describe('synthetic relocated installation — group 3: every tampered fixture re-refuses after a good load', () => {
  const cases = new Map([
    ['missing load-module dependency', async (fixture) => { await fixture.module(); fs.unlinkSync(path.join(fixture.root, 'cli/identity-records.mjs')); }],
    ['changed starter/PRODUCT_PRD.md', (fixture) => fixture.put('starter/PRODUCT_PRD.md', 'substituted starter bytes')],
    ['changed evaluator/score.mjs', (fixture) => fixture.put('evaluator/score.mjs', 'substituted scoring bytes')],
    ['extra reference/decoy.txt', (fixture) => fixture.put('reference/decoy.txt', 'decoy')],
    ['extra empty rogue directory', (fixture) => fs.mkdirSync(path.join(fixture.root, 'rogue/dir'), { recursive: true })],
    ['descriptor authorization rewritten to released', (fixture) => { const value = readJson(fixture.root, ANCHOR.descriptor); value.authorization = 'released'; fixture.put(ANCHOR.descriptor, JSON.stringify(value)); }],
    ['descriptor assetsSha256 zeroed', (fixture) => { const value = readJson(fixture.root, ANCHOR.descriptor); value.assetsSha256 = '0'.repeat(64); fixture.put(ANCHOR.descriptor, JSON.stringify(value)); }],
    ['asset index entry sha256 zeroed', (fixture) => { const value = readJson(fixture.root, ANCHOR.index); value.entries[0].sha256 = '0'.repeat(64); fixture.put(ANCHOR.index, JSON.stringify(value)); }],
  ]);
  for (const [label, mutate] of cases) {
    test(`refuses ${label}`, async () => withFixture(async (fixture) => {
      await fixture.load();
      await mutate(fixture);
      await assert.rejects(fixture.load(), (error) => refusesCommandError(error)
        && !/Cannot find module|MODULE_NOT_FOUND|Cannot find package/ig.test(String(error.message)),
        `${label} must re-refuse as a command integrity refusal after a good load`);
    }));
  }
});

describe('synthetic relocated installation — group 4: runtime overrides and the unprepared packaged loader refuse', () => {
  test('the relocated loader refuses undefined and explicit-root caller overrides', async () => withFixture(async (fixture) => {
    const loaderModule = await fixture.module();
    await fixture.load();
    for (const override of [undefined, { root: fixture.root }]) {
      assert.throws(() => loaderModule.loadInstallation(override), refusesCommandError,
        `the relocated loadInstallation refuses the caller override ${JSON.stringify(override) ?? 'undefined'}`);
    }
  }));
  test('the development checkout has no sealed packaged descriptor, so zero-argument load refuses while the checkout bytes stay untouched', async () => {
    const loaderPath = fileURLToPath(new URL('../../../cli/packaged-installation.mjs', import.meta.url));
    const before = sha256(fs.readFileSync(loaderPath));
    const { loadPackagedInstallation } = await import(new URL('../../../cli/packaged-installation.mjs', import.meta.url).href);
    assert.throws(() => loadPackagedInstallation(), refusesCommandError,
      'dropping the descriptor file is not a runtime bypass; the unprepared packaged loader refuses');
    assert.equal(sha256(fs.readFileSync(loaderPath)), before, 'the read-only checkout probe changed nothing');
  });
});
