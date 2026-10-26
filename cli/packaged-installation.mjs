// Synthetic installed loader template. The checkout's unprepared pin always refuses.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inventoryTree, hashEntries, sha256 } from '../packages/core/identity.mjs';
import { canonicalJson, validateRecord, identityDigestOf } from '../packages/core/manifest.mjs';
import { verifyPackagedEvaluator } from '../packages/evaluation/packaged-identity.mjs';
import { projectIdentityRecords } from './identity-records.mjs';
import { INSTALLATION_ROOT as ROOT, readOrdinaryBytes, readOrdinaryJson, exactKeys, rejectIntegrity } from './filesystem.mjs';

const PIN = 'BENCHBOARD_UNPREPARED_CLI_DESCRIPTOR_PIN';
const ANCHORS = ['cli/installation.json', 'cli/installed-assets.json', 'cli/packaged-installation.mjs'];
const digest = (value) => createHash('sha256').update(value).digest('hex');
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
const safe = (value) => typeof value === 'string' && /^[A-Za-z0-9._/-]+$/.test(value) &&
  value.split('/').every((segment) => segment && segment !== '.' && segment !== '..' && !segment.endsWith('.') &&
    !/^(?:con|aux|prn|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) &&
    !['.git', '.ai', '.env', 'workflow', 'reference', 'spec', 'artifacts', 'node_modules', 'dsh'].includes(segment.toLowerCase()));

/** No runtime root, descriptor, mode, expected hash or lineage input. */
export function loadPackagedInstallation() {
  try {
    if (arguments.length || !/^[a-f0-9]{64}$/.test(PIN)) rejectIntegrity();
    const descriptorBytes = readOrdinaryBytes(path.join(ROOT, ANCHORS[0]));
    if (digest(descriptorBytes) !== PIN) rejectIntegrity();
    const descriptor = JSON.parse(descriptorBytes);
    exactKeys(descriptor, ['kind', 'schemaVersion', 'authorization', 'toolingVersion', 'challengeVersion', 'evaluatorVersion',
      'packageName', 'packageVersion', 'assets', 'assetsSha256', 'workloadDigest', 'publicPrdDigest', 'visibleDigest', 'fixtureDigest']);
    if (descriptor.kind !== 'benchboard.cli.synthetic-installation.v1' || descriptor.schemaVersion !== '1.0.0' ||
        descriptor.authorization !== 'synthetic-only' || descriptor.assets !== ANCHORS[1] ||
        descriptor.packageName !== '@benchboard/synthetic-tooling' || descriptor.packageVersion !== '0.0.0-synthetic') rejectIntegrity();
    const indexBytes = readOrdinaryBytes(path.join(ROOT, ANCHORS[1]));
    if (digest(indexBytes) !== descriptor.assetsSha256) rejectIntegrity();
    const index = JSON.parse(indexBytes);
    exactKeys(index, ['kind', 'schemaVersion', 'authorization', 'entries']);
    if (index.kind !== 'benchboard.cli.synthetic-assets.v1' || index.schemaVersion !== '1.0.0' ||
        index.authorization !== 'synthetic-only' || !Array.isArray(index.entries) || !index.entries.length || index.entries.length > 2048) rejectIntegrity();
    const names = new Set();
    for (const entry of index.entries) {
      exactKeys(entry, ['path', 'bytes', 'sha256']);
      if (!safe(entry.path) || ANCHORS.includes(entry.path) || names.has(entry.path.toLowerCase()) ||
          !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) rejectIntegrity();
      names.add(entry.path.toLowerCase());
      const bytes = readOrdinaryBytes(path.join(ROOT, entry.path));
      if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) rejectIntegrity();
    }
    // Only the prepared dependency tree is outside application-asset verification.
    function namespace(directory, prefix = '') {
      for (const name of fs.readdirSync(directory)) {
        const relative = prefix ? `${prefix}/${name}` : name;
        const stat = fs.lstatSync(path.join(directory, name));
        if (stat.isSymbolicLink()) rejectIntegrity();
        if (relative === 'node_modules' && stat.isDirectory()) continue;
        if (stat.isDirectory()) {
          if (![...index.entries.map((entry) => entry.path), ...ANCHORS].some((entry) => entry.startsWith(relative + '/'))) rejectIntegrity();
          namespace(path.join(directory, name), relative);
        } else if (!stat.isFile() || (!names.has(relative.toLowerCase()) && !ANCHORS.includes(relative))) rejectIntegrity();
      }
    }
    namespace(ROOT);
    const pkg = readOrdinaryJson(path.join(ROOT, 'package.json'));
    const lock = readOrdinaryJson(path.join(ROOT, 'package-lock.json'));
    if (pkg.name !== descriptor.packageName || pkg.version !== descriptor.packageVersion || pkg.private !== true ||
        pkg.type !== 'module' || Object.hasOwn(pkg, 'scripts') || Object.hasOwn(pkg, 'license') ||
        lock.name !== pkg.name || lock.version !== pkg.version || lock.lockfileVersion !== 3 ||
        lock.packages?.['']?.name !== pkg.name || lock.packages[''].version !== pkg.version ||
        canonicalJson(pkg.dependencies) !== canonicalJson(lock.packages[''].dependencies) ||
        pkg.dependencies?.ajv !== '8.17.1' || pkg.dependencies?.['@playwright/test'] !== '1.51.1') rejectIntegrity();
    const release = readOrdinaryJson(path.join(ROOT, 'release/inventory.json'));
    const source = inventoryTree({ root: path.join(ROOT, 'starter'), skipNames: [] });
    const expected = [...release.participant.files].sort((a, b) => a.path < b.path ? -1 : 1);
    if (release.participant.fileCount !== 26 || expected.length !== 26 || canonicalJson(source.entries) !== canonicalJson(expected) ||
        source.digest !== descriptor.workloadDigest || release.hashProfile.profiles.starterTree !== source.digest) rejectIntegrity();
    const visibleDigest = inventoryTree({ root: path.join(ROOT, 'starter/tests'), skipNames: [] }).digest;
    const fixtureDigest = inventoryTree({ root: path.join(ROOT, 'fixtures'), skipNames: [] }).digest;
    const publicPrdDigest = sha256(readOrdinaryBytes(path.join(ROOT, 'starter/PRODUCT_PRD.md')));
    if (visibleDigest !== descriptor.visibleDigest || fixtureDigest !== descriptor.fixtureDigest || publicPrdDigest !== descriptor.publicPrdDigest ||
        release.hashProfile.profiles.visibleTestsTree !== visibleDigest || release.hashProfile.profiles.prd !== publicPrdDigest) rejectIntegrity();
    const actualEvaluator = verifyPackagedEvaluator();
    // The C1 evaluator identity version is distinct from the original candidate release train.
    const candidate = readOrdinaryJson(path.join(ROOT, 'version.json'));
    if (candidate.version !== release.challenge.version || candidate.status !== release.challenge.status) rejectIntegrity();
    if (actualEvaluator.evaluatorVersion !== candidate.version) rejectIntegrity();
    const assetManifest = [...index.entries, ...ANCHORS.map((relative) => {
      const bytes = readOrdinaryBytes(path.join(ROOT, relative));
      return { path: relative, bytes: bytes.length, sha256: digest(bytes) };
    })].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const records = projectIdentityRecords({ descriptor, descriptorDigest: digest(descriptorBytes), assetDigest: hashEntries(assetManifest),
      starterEntries: source.entries.map((entry) => [entry.path, entry.sha256]), workloadDigest: source.digest,
      visibleDigest, fixtureDigest, publicPrdDigest, hiddenDigest: sha256(readOrdinaryBytes(path.join(ROOT, 'evaluator/hidden-tests/properties.mjs'))),
      scoringDigest: actualEvaluator.originalCandidate.scoring, semanticDigest: actualEvaluator.semanticDigest,
      candidateVersion: candidate.version, candidateStatus: candidate.status, sourceCommit: release.authority.baselineCommit });
    const tooling = { ...records.toolingIdentity, toolingId: 'benchboard-tooling-cli-synthetic-package', toolingComponent: 'synthetic-package-cli',
      revision: 'synthetic:' + hashEntries(assetManifest), notes: 'Private synthetic package; no distribution approval.',
      digestProvenance: { kind: 'COMPUTED', procedure: 'Verified synthetic installed assets and pinned descriptor' } };
    delete tooling.identityDigest;
    const toolingIdentity = deepFreeze(validateRecord('ToolingIdentity', { ...tooling, identityDigest: identityDigestOf(tooling) }));
    namespace(ROOT);
    for (const entry of assetManifest) {
      const bytes = readOrdinaryBytes(path.join(ROOT, entry.path));
      if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) rejectIntegrity();
    }
    return Object.freeze({ root: ROOT, descriptor: Object.freeze(descriptor), toolingIdentity,
      evaluatorIdentity: records.evaluatorIdentity, actualEvaluator, assetManifest: Object.freeze(assetManifest.map(Object.freeze)),
      challenge: Object.freeze({ identity: records.challengeIdentity, sourceRoot: path.join(ROOT, 'starter'),
        fileManifest: Object.freeze(source.entries.map((entry) => entry.path)), ownerRoots: Object.freeze([ROOT]), evaluatorRoots: Object.freeze([path.join(ROOT, 'evaluator')]) }) });
  } catch { rejectIntegrity(); }
}
