// Outcome eligibility and identity-set validation.
//
// Candidate.9 moved execution-identity CONSTRUCTION and verification into
// runner/execution-authority.mjs, which owns the governed launch boundary.
// Nothing here can mint, verify or confer official execution authority: the
// candidate.8 defect was that mintExecutionIdentity() was exported from this
// module and reachable by ordinary callers.
//
// What remains here is deliberately non-authoritative: the single eligibility
// projection, which only ever DERIVES flags from facts proven elsewhere, and
// identity-set validation used by the quiescence coverage proof.
import crypto from 'node:crypto';

export const CURRENT_OFFICIAL_SCHEMAS = ['1.2'];
export const HISTORICAL_SCHEMAS = ['1.0', '1.1'];
export const OFFICIAL_OUTCOME_CLASSES = ['OFFICIAL_SUPERVISED'];

export class ExecutionIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExecutionIdentityError';
    this.supervisionKind = 'SUPERVISOR_FAILURE';
  }
}

const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// An unpredictable per-watchdog-instance nonce. This is NOT an official
// capability on its own: it only becomes execution authority when the governed
// launch boundary binds it into a persisted authority record.
export function mintWatchdogNonce() {
  return crypto.randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// One authoritative outcome eligibility projection
// ---------------------------------------------------------------------------
// Every official validity/eligibility flag is DERIVED here from facts proven
// upstream. No downstream caller may independently turn a flag back on, and
// the returned projection is frozen.
//
// Candidate.9 additions, from the candidate.8 review:
//   - executionAuthorityResolved: the AUTHORITATIVE PERSISTED record was
//     resolved from disk. A caller-supplied record cannot substitute.
//   - executionRecordValid: that record's own outcome is valid. Candidate.8
//     ignored validOutcome:false / INFRASTRUCTURE_FAILURE and still granted
//     eligibility.
//   - incompleteSupervision: the durable owner-verification marker exists, so
//     no consumer may treat the run as cleanly finalized, whichever API was
//     called.
//   - submissionFrozen / submissionMatchesFrozen: the participant result was
//     frozen at termination and the evaluated bytes still equal it.
export function projectOutcomeEligibility({
  schemaVersion,
  executionAuthorityResolved,
  executionRecordValid,
  seededAuthorityValid,
  governedDispatchProven,
  supervisionValid,
  terminationProven,
  telemetryBound,
  incompleteSupervision = false,
  submissionFrozen = true,
  submissionMatchesFrozen = true,
  evaluationPrerequisitesSatisfied = true,
  outcomeClass,
}) {
  const officialSchema = CURRENT_OFFICIAL_SCHEMAS.includes(schemaVersion);
  const reasons = [];
  if (!officialSchema)
    reasons.push(
      'Schema ' +
        schemaVersion +
        ' is historical/unbound and cannot be promoted to a current official outcome',
    );
  if (executionAuthorityResolved !== true)
    reasons.push(
      'No authoritative persisted execution record was resolved; there was no governed launch',
    );
  if (executionRecordValid !== true)
    reasons.push('The authoritative execution record is not a valid official outcome');
  if (seededAuthorityValid !== true) reasons.push('Seeded authority not proven');
  if (governedDispatchProven !== true) reasons.push('Governed dispatch not proven');
  if (supervisionValid !== true) reasons.push('Supervision not valid');
  if (terminationProven !== true) reasons.push('Termination not positively proven');
  if (telemetryBound !== true)
    reasons.push('Telemetry not fully bound to the execution identity');
  if (incompleteSupervision === true)
    reasons.push(
      'An incomplete-supervision marker requires owner verification for this execution',
    );
  if (submissionFrozen !== true)
    reasons.push('The participant submission was never frozen at termination');
  if (submissionMatchesFrozen !== true)
    reasons.push('Evaluated bytes differ from the frozen participant submission');
  if (evaluationPrerequisitesSatisfied !== true)
    reasons.push('Evaluation prerequisites not satisfied');
  if (!OFFICIAL_OUTCOME_CLASSES.includes(outcomeClass))
    reasons.push('Outcome class ' + outcomeClass + ' is not an official class');
  const officialOutcomeValid = reasons.length === 0;
  return Object.freeze({
    officialSchema,
    officialOutcomeValid,
    validOutcome: officialOutcomeValid,
    eligibleForFormalComparison: officialOutcomeValid,
    eligibleForCalibrationAcceptance: officialOutcomeValid,
    outcomeClass: officialOutcomeValid
      ? outcomeClass
      : officialSchema
        ? outcomeClass === 'OFFICIAL_SUPERVISED'
          ? 'OFFICIAL_INVALID'
          : outcomeClass
        : 'HISTORICAL_UNBOUND_DESCRIPTIVE',
    ineligibilityReasons: Object.freeze(reasons),
  });
}

// ---------------------------------------------------------------------------
// Identity-set validation (H3, affirmed resolved by the candidate.8 reviewer)
// ---------------------------------------------------------------------------
// Identity is authoritative data, not a convenience index. Coverage maps may
// only be built after this succeeds; positional identities are never
// synthesized for an official quiescence proof.
export function validateIdentitySet(
  rows,
  { label = 'member', key = 'logicalMember', fallbacks = ['name', 'id'] } = {},
) {
  if (!Array.isArray(rows))
    return { valid: false, ids: null, problems: [label + ' set is unavailable'] };
  const problems = [];
  const ids = [];
  const seen = new Map();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object') {
      problems.push(label + ' at position ' + index + ' is not a record');
      continue;
    }
    const present = [key, ...fallbacks].filter(
      (k) => row[k] !== undefined && row[k] !== null,
    );
    const values = [...new Set(present.map((k) => row[k]))];
    if (!present.length) {
      problems.push(label + ' at position ' + index + ' has no identity');
      continue;
    }
    if (values.some((v) => !nonEmptyString(v))) {
      problems.push(
        label + ' at position ' + index + ' has an empty or non-string identity',
      );
      continue;
    }
    if (values.length > 1) {
      problems.push(
        label +
          ' at position ' +
          index +
          ' has conflicting identities ' +
          values.join(' / '),
      );
      continue;
    }
    const id = values[0];
    if (seen.has(id)) {
      problems.push('Duplicate ' + label + ' identity ' + id);
      continue;
    }
    seen.set(id, row);
    ids.push(id);
  }
  return {
    valid: problems.length === 0,
    ids: problems.length === 0 ? ids : null,
    byId: problems.length === 0 ? seen : null,
    problems,
  };
}
