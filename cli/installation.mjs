// Production checkout loader: caller arguments never select installed identity inputs.
import path from 'node:path';
import { inventoryTree, hashEntries, sha256 } from '../packages/core/identity.mjs';
import { canonicalJson } from '../packages/core/manifest.mjs';
import { computeEvaluatorIdentity } from '../packages/evaluation/evaluator-identity.mjs';
import { projectIdentityRecords } from './identity-records.mjs';
import { INSTALLATION_ROOT, readOrdinaryBytes, readOrdinaryJson, exactKeys, rejectIntegrity } from './filesystem.mjs';
import { loadPackagedInstallation } from './packaged-installation.mjs';

const DIRECTORIES = ['cli', 'packages/core', 'packages/evaluation', 'packages/results', 'schemas', 'adapters/manual'];
const FILES = ['package.json', 'package-lock.json', 'release/inventory.json', 'version.json'];
export function loadInstallation() {
  if (arguments.length !== 0) rejectIntegrity();
  const root = INSTALLATION_ROOT;
  const descriptor = readOrdinaryJson(path.join(root, 'cli', 'installation.json'));
  if (descriptor.kind === 'benchboard.cli.synthetic-installation.v1') return loadPackagedInstallation();
  exactKeys(descriptor, ['kind', 'schemaVersion', 'developmentOnly', 'toolingVersion', 'challengeVersion', 'evaluatorVersion',
    'assets', 'workloadDigest', 'publicPrdDigest', 'visibleDigest', 'fixtureDigest']);
  if (descriptor.kind !== 'benchboard.cli.development-installation.v1' || descriptor.schemaVersion !== '1.0.0' ||
      descriptor.developmentOnly !== true || descriptor.assets !== 'cli/installed-assets.json') rejectIntegrity();
  const selected = readOrdinaryJson(path.join(root, descriptor.assets));
  exactKeys(selected, ['kind', 'schemaVersion', 'developmentOnly', 'directories', 'files']);
  if (selected.kind !== 'benchboard.cli.development-assets.v1' || selected.schemaVersion !== '1.0.0' ||
      selected.developmentOnly !== true || canonicalJson(selected.directories) !== canonicalJson(DIRECTORIES) ||
      canonicalJson(selected.files) !== canonicalJson(FILES)) rejectIntegrity();
  const release = readOrdinaryJson(path.join(root, 'release', 'inventory.json'));
  if (release.participant?.fileCount !== 26 || !Array.isArray(release.participant.files) || release.participant.files.length !== 26) rejectIntegrity();
  const source = inventoryTree({ root: path.join(root, 'starter') });
  const expected = [...release.participant.files].sort((a, b) => a.path < b.path ? -1 : 1);
  if (canonicalJson(source.entries) !== canonicalJson(expected) || source.digest !== descriptor.workloadDigest ||
      release.hashProfile?.profiles?.starterTree !== source.digest) rejectIntegrity();
  const visibleDigest = inventoryTree({ root: path.join(root, 'starter', 'tests'), skipNames: [] }).digest;
  const fixtureDigest = inventoryTree({ root: path.join(root, 'fixtures'), skipNames: [] }).digest;
  const publicPrdDigest = sha256(readOrdinaryBytes(path.join(root, 'starter', 'PRODUCT_PRD.md')));
  if (visibleDigest !== descriptor.visibleDigest || fixtureDigest !== descriptor.fixtureDigest || publicPrdDigest !== descriptor.publicPrdDigest ||
      release.hashProfile.profiles.prd !== publicPrdDigest || release.hashProfile.profiles.visibleTestsTree !== visibleDigest) rejectIntegrity();
  const actualEvaluator = computeEvaluatorIdentity();
  const candidate = readOrdinaryJson(path.join(root, 'version.json'));
  if (candidate.version !== release.challenge?.version || candidate.status !== release.challenge?.status) rejectIntegrity();
  const assetManifest = [...DIRECTORIES.flatMap(directory => inventoryTree({ root: path.join(root, directory), skipNames: [] }).entries
    .map(entry => ({ ...entry, path: `${directory}/${entry.path}` }))), ...FILES.map(file => {
      const bytes = readOrdinaryBytes(path.join(root, file));
      return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
    })].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (assetManifest.length > 2048 || new Set(assetManifest.map(entry => entry.path)).size !== assetManifest.length) rejectIntegrity();
  const records = projectIdentityRecords({ descriptor, descriptorDigest: sha256(canonicalJson(descriptor)), assetDigest: hashEntries(assetManifest),
    starterEntries: source.entries.map(entry => [entry.path, entry.sha256]), workloadDigest: source.digest,
    publicPrdDigest, visibleDigest, fixtureDigest,
    hiddenDigest: sha256(readOrdinaryBytes(path.join(root, 'evaluator', 'hidden-tests', 'properties.mjs'))),
    scoringDigest: actualEvaluator.originalCandidate.scoring, semanticDigest: actualEvaluator.semanticDigest,
    candidateVersion: candidate.version, candidateStatus: candidate.status, sourceCommit: release.authority.baselineCommit });
  // Recheck every selected byte before returning identities; no mixed captured facts
  // may hide a source edit during this cooperative read. This is not an atomic OS snapshot.
  for (const entry of [...assetManifest, ...actualEvaluator.semanticManifest,
    ...source.entries.map(item => ({ ...item, path: `starter/${item.path}` }))]) {
    const bytes = readOrdinaryBytes(path.join(root, entry.path));
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) rejectIntegrity();
  }
  return Object.freeze({ root, descriptor: Object.freeze(descriptor), toolingIdentity: records.toolingIdentity,
    evaluatorIdentity: records.evaluatorIdentity, challenge: Object.freeze({ identity: records.challengeIdentity,
      sourceRoot: path.join(root, 'starter'), fileManifest: Object.freeze(source.entries.map(entry => entry.path)),
      ownerRoots: Object.freeze([root]), evaluatorRoots: Object.freeze([path.join(root, 'evaluator')]) }),
    actualEvaluator, assetManifest: Object.freeze(assetManifest.map(Object.freeze)) });
}
