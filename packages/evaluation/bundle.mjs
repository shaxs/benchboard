// C4.S2.T2 — pure EvidenceBundle assembler and reader (fixed S2 contract, 2026-10-17).
//
// Pure projection only: this module performs no filesystem, subprocess or crypto work and
// imports nothing governed. Every value gate, schema check and semantic check is delegated
// to the Captain-owned trust boundary `bundle-contract.mjs`; this file never re-implements
// or weakens those checks and never defaults a missing input to 0, false or null.
import { EvaluationIntegrityError, validateScorerEvidence, validateEvidenceBundle } from './bundle-contract.mjs';
import { score } from '../../evaluator/score.mjs';

// The accepted S1 stage order (contracts.mjs STAGES). A bundle exists only for this exact,
// complete, fully successful order; no shorter prefix is ever accepted as partial evidence.
const STAGE_ORDER = Object.freeze(['typecheck', 'build', 'visible', 'browser', 'useful', 'inspection']);

function guard(condition, message) {
  if (!condition) throw new EvaluationIntegrityError(message);
}

function assertCleanSuccess(result) {
  guard(result !== null && typeof result === 'object' && !Array.isArray(result), 'An EvidenceBundle needs the completed S1 result object');
  guard(result.status === 'success', 'Only a completed success evaluation can build an EvidenceBundle');
  const cleanup = result.cleanup;
  guard(cleanup && cleanup.removed === true && Array.isArray(cleanup.errors) && cleanup.errors.length === 0 && Array.isArray(cleanup.residue) && cleanup.residue.length === 0,
    'Scratch cleanup was not confirmed clean; no bundle or partial points are produced');
  const snapshot = result.snapshot;
  guard(snapshot && typeof snapshot.before === 'string' && snapshot.before.length > 0 && snapshot.before === snapshot.after,
    'Snapshot observation is incomplete or the frozen bytes drifted during evaluation');
  const stages = result.stages;
  guard(Array.isArray(stages) && stages.length === STAGE_ORDER.length
    && stages.every((stage, index) => stage !== null && typeof stage === 'object' && stage.stage === STAGE_ORDER[index] && stage.status === 'success'),
    'All six ordered stages must be successful before an EvidenceBundle can be built');
}

/**
 * Assemble the closed, versioned EvidenceBundle from a complete, clean, fully successful
 * S1 result plus the Captain-supplied identities and output artifact digests.
 *
 * Gates run before the scorer sees any value; the raw evidence is validated through the
 * Captain validator, the score comes from the unchanged `evaluator/score.mjs`, and the
 * finished projection passes through `validateEvidenceBundle` before it is returned.
 * Any ineligible input is an EvaluationIntegrityError, never a degraded bundle.
 */
export function assembleEvidenceBundle(input) {
  guard(input !== null && typeof input === 'object' && !Array.isArray(input),
    'assembleEvidenceBundle requires { result, identities, artifactDigests }');
  const { result, identities, artifactDigests } = input;
  assertCleanSuccess(result);
  guard(identities !== null && typeof identities === 'object' && !Array.isArray(identities),
    'identities must be the Captain-supplied identity block');
  guard(Array.isArray(artifactDigests),
    'artifactDigests must be the supplied output-relative {path,bytes,sha256} array');
  // Validate every raw value through the Captain boundary before scoring; nothing is defaulted.
  const evidence = validateScorerEvidence(result.evidence);
  const bundle = {
    schemaVersion: '1.0.0',
    kind: 'EvidenceBundle',
    evaluationId: result.evaluationId,
    executionStatus: 'success',
    identities,
    properties: evidence.hidden,
    visible: { passed: evidence.visiblePassed, total: 17 },
    build: evidence.build,
    typecheck: evidence.typecheck,
    usefulTests: evidence.usefulTests,
    noSuppression: evidence.noSuppression,
    hygiene: evidence.hygiene,
    environment: result.environment,
    artifactDigests,
    snapshot: result.snapshot,
    score: score(evidence, null),
  };
  // The completeness gate: the Captain validator must accept the projection before any
  // consumer can see it. The validated value itself is the caller's read-side concern.
  validateEvidenceBundle(bundle);
  return bundle;
}

/**
 * Project a bundle back to the exact scorer-input shape and re-validate it through the
 * Captain boundary. A tampered property or non-boolean value is refused, never repaired.
 */
export function scorerEvidenceOf(bundle) {
  guard(bundle !== null && typeof bundle === 'object' && !Array.isArray(bundle),
    'scorerEvidenceOf requires an EvidenceBundle object');
  return validateScorerEvidence({
    visiblePassed: bundle.visible?.passed,
    hidden: bundle.properties,
    typecheck: bundle.typecheck,
    build: bundle.build,
    usefulTests: bundle.usefulTests,
    noSuppression: bundle.noSuppression,
    hygiene: bundle.hygiene,
  });
}

/**
 * Read a serialized bundle from JSON text. This is not a filesystem path; the caller owns
 * all IO. Malformed JSON and any invalid bundle are integrity refusals, not repaired values.
 */
export function readEvidenceBundle(text) {
  guard(typeof text === 'string' && text.length > 0,
    'readEvidenceBundle takes the serialized JSON text of an EvidenceBundle');
  let value;
  try { value = JSON.parse(text); }
  catch { throw new EvaluationIntegrityError('EvidenceBundle JSON is malformed'); }
  return validateEvidenceBundle(value);
}
