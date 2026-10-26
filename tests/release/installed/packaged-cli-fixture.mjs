// Captain-owned synthetic builder fixture, not public installation or approved distribution.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventoryTree, sha256 } from '../../../packages/core/identity.mjs';
import { computeEvaluatorIdentity } from '../../../packages/evaluation/evaluator-identity.mjs';
import { renderSyntheticEvaluatorVerifier } from '../../../release/packaged-evaluator.mjs';
import { renderSyntheticCliLoader } from '../../../release/packaged-cli.mjs';
import { renderSyntheticPackageMetadata } from '../../../release/installation-metadata.mjs';
const OWNER = fileURLToPath(new URL('../../../', import.meta.url));
const profile = { schemaVersion: '1.0.0', kind: 'ReleaseProfile', profile: 'synthetic', authorization: 'synthetic-only',
  entries: [{ path: 'a.txt', source: 'a.txt', bytes: 0, sha256: sha256('') }] };
const anchors = ['cli/installation.json', 'cli/installed-assets.json', 'cli/packaged-installation.mjs'];
export function syntheticCliFixture({ toolingNote = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchboard packaged CLI '));
  const put = (relative, bytes) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), bytes); };
  try {
    const copy = (relative) => fs.cpSync(path.join(OWNER, relative), path.join(root, relative), {
      recursive: true, filter: (file) => !['node_modules', '.tmp'].includes(path.basename(file)),
    });
    for (const relative of ['cli', 'packages/core', 'packages/evaluation', 'packages/results', 'schemas', 'adapters/manual', 'fixtures', 'release/inventory.json', 'version.json', 'runner/files.mjs']) copy(relative);
    const release = JSON.parse(fs.readFileSync(path.join(OWNER, 'release/inventory.json')));
    for (const entry of release.participant.files) put('starter/' + entry.path, fs.readFileSync(path.join(OWNER, 'starter', entry.path)));
    const metadata = renderSyntheticPackageMetadata();
    put('package.json', metadata.packageJson); put('package-lock.json', metadata.packageLock);
    if (toolingNote) put('cli/synthetic-note.txt', toolingNote);
    const baseline = computeEvaluatorIdentity();
    for (const entry of baseline.semanticManifest) put(entry.path, fs.readFileSync(path.join(OWNER, entry.path)));
    const wrappers = baseline.packageManifest.filter((entry) => !['packages/evaluation/packaged-identity.mjs', 'packages/evaluation/packaged-assets.json'].includes(entry.path));
    const evaluatorDescriptor = Buffer.from(JSON.stringify({ schemaVersion: '1.0.0', kind: 'PackagedEvaluatorAssets', authorization: 'synthetic-only',
      version: baseline.evaluatorVersion, lineage: { candidateVersion: baseline.evaluatorVersion, ...baseline.originalCandidate }, semantics: baseline.semanticManifest, wrappers }));
    put('packages/evaluation/packaged-assets.json', evaluatorDescriptor);
    put('packages/evaluation/packaged-identity.mjs', renderSyntheticEvaluatorVerifier(profile, evaluatorDescriptor));
    const entries = inventoryTree({ root, skipNames: [] }).entries.filter((entry) => !anchors.includes(entry.path));
    const indexBytes = Buffer.from(JSON.stringify({ kind: 'benchboard.cli.synthetic-assets.v1', schemaVersion: '1.0.0', authorization: 'synthetic-only', entries }));
    put(anchors[1], indexBytes);
    const original = JSON.parse(fs.readFileSync(path.join(OWNER, anchors[0])));
    const descriptor = { kind: 'benchboard.cli.synthetic-installation.v1', schemaVersion: '1.0.0', authorization: 'synthetic-only',
      toolingVersion: original.toolingVersion, challengeVersion: original.challengeVersion, evaluatorVersion: original.evaluatorVersion,
      packageName: '@benchboard/synthetic-tooling', packageVersion: '0.0.0-synthetic', assets: anchors[1], assetsSha256: sha256(indexBytes),
      workloadDigest: original.workloadDigest, publicPrdDigest: original.publicPrdDigest, visibleDigest: original.visibleDigest, fixtureDigest: original.fixtureDigest };
    const descriptorBytes = Buffer.from(JSON.stringify(descriptor));
    put(anchors[0], descriptorBytes); put(anchors[2], renderSyntheticCliLoader(profile, descriptorBytes));
    // Prepared dependency copies only: no installation, linking or browser download.
    fs.cpSync(path.join(OWNER, 'node_modules'), path.join(root, 'node_modules'), { recursive: true });
    return { root, descriptor, put, baseline, async load() {
      return (await import(pathToFileURL(path.join(root, 'cli/installation.mjs')).href)).loadInstallation();
    }, async module() { return import(pathToFileURL(path.join(root, 'cli/installation.mjs')).href); },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
