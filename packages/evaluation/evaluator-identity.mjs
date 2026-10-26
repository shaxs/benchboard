// Actual installed semantics, separate from the C1 identity binding selected at run initialization.
import fs from 'node:fs';
import path from 'node:path';
import { inventoryTree, hashEntries, sha256, HASH_ALGORITHM_ID } from '../core/identity.mjs';
import { assertDirectoryChain, OWNER_ROOT } from './staging.mjs';
import { CANONICAL_TOOLING } from './contracts.mjs';
import { EvaluationIntegrityError } from './bundle-contract.mjs';

const semanticFiles = ['evaluator/score.mjs', 'evaluator/hidden-tests/properties.mjs', 'evaluator/browser.mjs',
  'evaluator/useful-tests.mjs', 'evaluator/collect-evidence.mjs', 'evaluator/local-server.mjs'];
// These scalar hashes were copied exactly from the immutable candidate preservation record,
// not minted from installed bytes. The record is part of the installed wrapper package digest.
function readLineage() {
  const at = new URL('./candidate-lineage.json', import.meta.url);
  const stat = fs.lstatSync(at);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new EvaluationIntegrityError('Recorded lineage must be an ordinary file');
  return JSON.parse(fs.readFileSync(at, 'utf8'));
}
function file(root, relative) {
  const absolute = path.join(root, relative);
  assertDirectoryChain(path.dirname(absolute));
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new EvaluationIntegrityError('Identity input must be an ordinary file');
  const bytes = fs.readFileSync(absolute);
  return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
}
function tree(root, prefix) {
  return inventoryTree({ root: path.join(root, prefix), skipNames: [] }).entries.map(entry => ({ ...entry, path: prefix + '/' + entry.path }));
}

/** Internal roots are for synthetic identity tests, never public evaluation request options. */
export function computeEvaluatorIdentity({ root = OWNER_ROOT, packageRoot = OWNER_ROOT, lineage } = {}) {
  try { return compute(root, packageRoot, lineage ?? readLineage()); }
  catch (error) {
    if (error instanceof EvaluationIntegrityError) throw error;
    throw new EvaluationIntegrityError('Evaluator identity inputs are missing or invalid');
  }
}

function compute(root, packageRoot, lineage) {
  if (!lineage || Object.keys(lineage).sort().join(',') !== 'candidateVersion,evaluator,scoring' ||
      typeof lineage.candidateVersion !== 'string' || !/^[a-f0-9]{64}$/.test(lineage.evaluator ?? '') || !/^[a-f0-9]{64}$/.test(lineage.scoring ?? '')) {
    throw new EvaluationIntegrityError('Invalid recorded candidate lineage');
  }
  const semanticManifest = [...semanticFiles.map(name => file(root, name)), ...CANONICAL_TOOLING.map(name => file(root, 'starter/' + name)),
    ...tree(root, 'starter/tests'), ...tree(root, 'fixtures')].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const packageManifest = [...tree(packageRoot, 'packages/evaluation'), file(packageRoot, 'schemas/evidence-bundle.schema.json')]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8')).version;
  if (typeof version !== 'string' || !version) throw new EvaluationIntegrityError('Missing evaluator version');
  // Deliberately the HISTORICAL candidate tree domain: default excludes node_modules/dist/.git.
  // The explicit semantic manifest above is a different domain and includes every selected file.
  const installedEvaluator = inventoryTree({ root: path.join(root, 'evaluator') }).digest;
  const installedScoring = semanticManifest.find(entry => entry.path === 'evaluator/score.mjs').sha256;
  if (installedEvaluator !== lineage.evaluator || installedScoring !== lineage.scoring || version !== lineage.candidateVersion) {
    throw new EvaluationIntegrityError('Installed evaluator differs from recorded original candidate');
  }
  return { evaluatorVersion: version, scoringVersion: version, hashAlgorithm: HASH_ALGORITHM_ID,
    semanticManifest, semanticDigest: hashEntries(semanticManifest), packageManifest, packageDigest: hashEntries(packageManifest),
    originalCandidate: { evaluator: lineage.evaluator, scoring: lineage.scoring } };
}
