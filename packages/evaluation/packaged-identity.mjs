// Fixed-template installed verifier. The unprepared checkout template always refuses.
// A synthetic builder pins exact descriptor bytes in a copied verifier, never runtime options.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashEntries, sha256, HASH_ALGORITHM_ID } from '../core/identity.mjs';

const DESCRIPTOR_DIGEST = 'BENCHBOARD_UNPREPARED_DESCRIPTOR_PIN';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DESCRIPTOR = 'packages/evaluation/packaged-assets.json';
const SELF = 'packages/evaluation/packaged-identity.mjs';
const fixedSemantics = [
  'evaluator/score.mjs', 'evaluator/hidden-tests/properties.mjs', 'evaluator/browser.mjs',
  'evaluator/useful-tests.mjs', 'evaluator/collect-evidence.mjs', 'evaluator/local-server.mjs',
  'starter/package.json', 'starter/package-lock.json', 'starter/tsconfig.json', 'starter/vite.config.ts',
];
const safePath = (value) => typeof value === 'string' && /^[A-Za-z0-9._/-]+$/.test(value) &&
  value.split('/').every((part) => part && part !== '.' && part !== '..' && !/[.]$/.test(part) && !/^(con|nul|aux|prn|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
const sort = (entries) => [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export class PackagedEvaluatorError extends Error {
  constructor() {
    super('Packaged evaluator assets or descriptor are not the pinned synthetic installation');
    this.name = 'PackagedEvaluatorError';
    this.code = 'ERR_PACKAGED_EVALUATOR_INTEGRITY';
  }
}
const fail = () => { throw new PackagedEvaluatorError(); };
const keys = (value, expected) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail();
};

function chain(directory) {
  for (let at = directory;; at = path.dirname(at)) {
    const stat = fs.lstatSync(at);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    if (path.dirname(at) === at) break;
  }
}

function bytes(relative) {
  if (!safePath(relative)) fail();
  const target = path.join(ROOT, ...relative.split('/'));
  chain(path.dirname(target));
  const stat = fs.lstatSync(target, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail();
  const value = fs.readFileSync(target);
  const after = fs.lstatSync(target, { bigint: true });
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.birthtimeNs !== stat.birthtimeNs ||
      after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs || after.size !== stat.size ||
      after.nlink !== 1n || after.isSymbolicLink()) fail();
  return value;
}

function validateEntries(entries, domain) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 10000) fail();
  const seen = new Set();
  for (const entry of entries) {
    keys(entry, ['path', 'bytes', 'sha256']);
    if (!safePath(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) || seen.has(entry.path.toLowerCase()) || !domain(entry.path)) fail();
    seen.add(entry.path.toLowerCase());
  }
  return sort(entries);
}

function inventory(prefix, allowed) {
  const result = [];
  function walk(relative) {
    chain(path.join(ROOT, relative));
    for (const name of fs.readdirSync(path.join(ROOT, relative))) {
      const child = `${relative}/${name}`;
      const stat = fs.lstatSync(path.join(ROOT, child));
      if (!safePath(child) || stat.isSymbolicLink()) fail();
      if (stat.isDirectory()) {
        if (!allowed.some((entry) => entry.startsWith(child + '/'))) fail();
        walk(child);
      }
      else if (stat.isFile()) result.push(child);
      else fail();
    }
  }
  walk(prefix);
  return result.sort();
}

/** No caller root, descriptor, expected digest, lineage, mode, or bypass parameter. */
export function verifyPackagedEvaluator() {
  try {
    if (arguments.length !== 0 || !/^[a-f0-9]{64}$/.test(DESCRIPTOR_DIGEST)) fail();
    const descriptorBytes = bytes(DESCRIPTOR);
    if (sha256(descriptorBytes) !== DESCRIPTOR_DIGEST) fail();
    const descriptor = JSON.parse(descriptorBytes);
    keys(descriptor, ['schemaVersion', 'kind', 'authorization', 'version', 'lineage', 'semantics', 'wrappers']);
    if (descriptor.schemaVersion !== '1.0.0' || descriptor.kind !== 'PackagedEvaluatorAssets' ||
        descriptor.authorization !== 'synthetic-only' || typeof descriptor.version !== 'string' ||
        !/^[A-Za-z0-9._-]{1,64}$/.test(descriptor.version)) fail();
    keys(descriptor.lineage, ['candidateVersion', 'evaluator', 'scoring']);
    if (descriptor.lineage.candidateVersion !== descriptor.version ||
        !/^[a-f0-9]{64}$/.test(descriptor.lineage.evaluator) || !/^[a-f0-9]{64}$/.test(descriptor.lineage.scoring)) fail();
    const semanticManifest = validateEntries(descriptor.semantics, (name) => fixedSemantics.includes(name) ||
      name.startsWith('starter/tests/') || name.startsWith('fixtures/'));
    for (const name of fixedSemantics) if (!semanticManifest.some((entry) => entry.path === name)) fail();
    if (!semanticManifest.some((entry) => entry.path.startsWith('starter/tests/')) ||
        !semanticManifest.some((entry) => entry.path.startsWith('fixtures/'))) fail();
    const wrapperEntries = validateEntries(descriptor.wrappers, (name) =>
      (name.startsWith('packages/evaluation/') && name !== SELF && name !== DESCRIPTOR) || name === 'schemas/evidence-bundle.schema.json');
    if (!wrapperEntries.some((entry) => entry.path === 'schemas/evidence-bundle.schema.json')) fail();
    const expected = [...semanticManifest, ...wrapperEntries];
    for (const entry of expected) {
      const actual = bytes(entry.path);
      if (actual.length !== entry.bytes || sha256(actual) !== entry.sha256) fail();
    }
    for (const prefix of ['evaluator', 'fixtures', 'starter/tests', 'packages/evaluation']) {
      const wanted = [...expected.map((entry) => entry.path), SELF, DESCRIPTOR].filter((name) => name.startsWith(prefix + '/')).sort();
      const actual = inventory(prefix, wanted);
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail();
    }
    const scoring = semanticManifest.find((entry) => entry.path === 'evaluator/score.mjs');
    if (scoring.sha256 !== descriptor.lineage.scoring) fail();
    // These are selected installed domains, never a recomputed historical evaluator-tree hash.
    const packageManifest = sort([...wrapperEntries,
      { path: SELF, bytes: bytes(SELF).length, sha256: sha256(bytes(SELF)) },
      { path: DESCRIPTOR, bytes: descriptorBytes.length, sha256: DESCRIPTOR_DIGEST }]);
    for (const entry of [...semanticManifest, ...packageManifest]) {
      const actual = bytes(entry.path);
      if (actual.length !== entry.bytes || sha256(actual) !== entry.sha256) fail();
    }
    const result = {
      evaluatorVersion: descriptor.version, scoringVersion: descriptor.version, hashAlgorithm: HASH_ALGORITHM_ID,
      semanticManifest, semanticDigest: hashEntries(semanticManifest), packageManifest, packageDigest: hashEntries(packageManifest),
      originalCandidate: { evaluator: descriptor.lineage.evaluator, scoring: descriptor.lineage.scoring },
    };
    for (const entries of [semanticManifest, packageManifest]) { entries.forEach(Object.freeze); Object.freeze(entries); }
    Object.freeze(result.originalCandidate);
    return Object.freeze(result);
  } catch { fail(); }
}
