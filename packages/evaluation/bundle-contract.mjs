// Captain-owned evidence trust boundary. Validation never supplies missing points or booleans.
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { score } from '../../evaluator/score.mjs';
import { hashEntries } from '../core/identity.mjs';
import { canonicalJson } from '../core/manifest.mjs';

export class EvaluationIntegrityError extends Error {
  constructor(message) { super(message); this.name = 'EvaluationIntegrityError'; this.code = 'EVIDENCE_INTEGRITY'; }
}
const schema = JSON.parse(fs.readFileSync(new URL('../../schemas/evidence-bundle.schema.json', import.meta.url), 'utf8'));
const check = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const hygieneKeys = ['visibleIntact', 'lockedDependencies', 'noSecrets', 'noDebugLogging', 'noNetwork'];
const fail = message => { throw new EvaluationIntegrityError(message); };
const bool = (v, key) => { if (typeof v !== 'boolean') fail('Missing/invalid boolean: ' + key); return v; };

export function validateScorerEvidence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Complete scorer evidence required');
  if (!Number.isSafeInteger(raw.visiblePassed) || raw.visiblePassed < 0 || raw.visiblePassed > 17) fail('Invalid visible count');
  if (!Array.isArray(raw.hidden) || raw.hidden.length !== 25) fail('Incomplete hidden properties');
  const hidden = raw.hidden.map(record => {
    if (!record || typeof record.id !== 'string' || typeof record.area !== 'string') fail('Invalid property');
    return { id: record.id, area: record.area, passed: bool(record.passed, 'property.passed') };
  });
  const useful = raw.usefulTests;
  if (!useful || !Number.isSafeInteger(useful.addedCount) || useful.addedCount < 0 || !Array.isArray(useful.killedMutations) || useful.killedMutations.some(v => typeof v !== 'string')) fail('Incomplete useful-test evidence');
  if (new Set(useful.killedMutations).size !== useful.killedMutations.length) fail('Duplicate mutation');
  if (!raw.hygiene || typeof raw.hygiene !== 'object') fail('Missing hygiene evidence');
  const evidence = {
    visiblePassed: raw.visiblePassed, hidden, typecheck: bool(raw.typecheck, 'typecheck'), build: bool(raw.build, 'build'),
    usefulTests: { baselinePassed: bool(useful.baselinePassed, 'baselinePassed'), addedCount: useful.addedCount, killedMutations: [...useful.killedMutations] },
    noSuppression: bool(raw.noSuppression, 'noSuppression'), hygiene: Object.fromEntries(hygieneKeys.map(k => [k, bool(raw.hygiene[k], k)])),
  };
  try { score(evidence, null); } catch (error) { fail('Scorer rejected evidence: ' + error.message); }
  return evidence;
}

export function validateEvidenceBundle(value) {
  if (!check(value)) fail('Invalid EvidenceBundle schema: ' + check.errors.map(e => e.instancePath + ' ' + e.message).join('; ').slice(0, 2000));
  const evidence = validateScorerEvidence({ visiblePassed: value.visible.passed, hidden: value.properties, build: value.build, typecheck: value.typecheck,
    usefulTests: value.usefulTests, noSuppression: value.noSuppression, hygiene: value.hygiene });
  if (canonicalJson(value.score) !== canonicalJson(score(evidence, null))) fail('Bundle score differs from unchanged scorer');
  if (value.snapshot.before !== value.snapshot.after || value.snapshot.after !== value.identities.submission.treeDigest) fail('Snapshot digest mismatch');
  const evaluator = value.identities.evaluator;
  for (const [entries, digest] of [[evaluator.semanticManifest, evaluator.semanticDigest], [evaluator.packageManifest, evaluator.packageDigest]]) {
    let computed;
    try { computed = hashEntries(entries); } catch { fail('Invalid/duplicate manifest paths'); }
    if (computed !== digest) fail('Evaluator manifest digest mismatch');
  }
  const scoring = evaluator.semanticManifest.find(entry => entry.path === 'evaluator/score.mjs');
  if (!scoring || scoring.sha256 !== evaluator.originalCandidate.scoring) fail('Original scoring identity mismatch');
  const paths = new Set();
  for (const entry of value.artifactDigests) {
    if (paths.has(entry.path)) fail('Duplicate artifact path');
    paths.add(entry.path);
  }
  return JSON.parse(JSON.stringify(value));
}
