/**
 * Neutral BenchBoard contract layer — identities, run manifests, frozen
 * submissions, measurements, results and the explicit historical reader.
 *
 * Harness-neutral by construction: only `node:crypto` is imported. There is no
 * harness-specific import, no vendor or owner configuration lookup, no global
 * owner artifacts path, no filesystem access and no network access here. Paths
 * inside inventory records are participant-relative POSIX strings; a host root
 * is an explicit argument supplied by whichever caller reads files, so it is
 * recorded in the host's own path syntax and never reinterpreted here.
 *
 * Versioning model:
 *   - a record carries `schemaVersion` as `<major>.<minor>.<patch>`;
 *   - `major` is a discriminator: only schema major 1 is read; unknown and
 *     malformed values (leading zeros, missing or extra components) are
 *     rejected by this module and, identically, by the companion JSON Schemas
 *     in `schemas/`, and never coerced into the current shape, so newer data
 *     can not masquerade as history;
 *   - `minor`/`patch` are compatible: validation continues and every invariant
 *     below is still enforced, so a compatible version is never an escape hatch;
 *   - `kind` must match the family being validated, so a tooling record can not
 *     be passed off as a challenge, run, submission or result record.
 *
 * Tooling, challenge, evaluator, run, submission and result identity stay
 * distinct objects with distinct IDs and distinct version fields, each field
 * naming its own release train. The domains are bound by identity IDs and
 * identity digests, not by version strings: separately bound identities whose
 * version strings happen to be equal remain valid, while an ID collision, a
 * re-bound digest or a corrupt self digest is refused. Challenge lineage
 * is preserved rather than overwritten.
 *
 * Digests preserve the established algorithm exactly: sha256 over the canonical
 * JSON serialisation of `[path, fileDigest]` pairs with POSIX paths sorted
 * ascending, so old and new tooling produce identical digests for identical
 * bytes. Declared digests are always recomputed and compared, never trusted.
 */

import crypto from 'node:crypto';

/* ------------------------------------------------------------------------- */
/* Version and vocabulary constants                                          */
/* ------------------------------------------------------------------------- */

/** Baseline contract version shared by every neutral family. */
export const NEUTRAL_CONTRACT_VERSION = '1.0.0';

/** The only schema major this release reads. Unknown majors are rejected. */
export const SUPPORTED_SCHEMA_MAJOR = 1;

/** Neutral contract families, each with its own schema and identity domain. */
export const NEUTRAL_CONTRACT_KINDS = Object.freeze([
  'ToolingIdentity',
  'ChallengeIdentity',
  'EvaluatorIdentity',
  'RunManifest',
  'FrozenSubmission',
  'Measurement',
  'Result',
]);

/** Historical result/telemetry schema versions this module may read. */
export const LEGACY_RESULT_SCHEMA_VERSIONS = Object.freeze(['1.0', '1.1', '1.2']);

/** Historical records are descriptive; they can never be official or certified. */
export const LEGACY_TRUST_CEILING = Object.freeze({
  lifecycle: 'DRAFT',
  evaluationTrust: 'UNTRUSTED_LEGACY',
  humanReviewStatus: 'NOT_REVIEWED',
});

/**
 * How a measurement value came to exist.
 *
 * ARCHITECTURE.md line 75 spells this axis `provenance` with the lower-case
 * values `measured | entered | derived | unavailable`. The record field is
 * named `measurementKind` so it stays distinct from `digestProvenance` and
 * `workloadProvenance`, which answer a different question, and its values use
 * this module's upper-case enumeration style. These are the same four states; a
 * reader that carries the architecture form maps them one to one.
 */
export const MEASUREMENT_KINDS = Object.freeze([
  'MEASURED',
  'ENTERED',
  'DERIVED',
  'UNAVAILABLE',
]);

/** Lifecycle axis: where a record stands in the run/evaluation workflow. */
export const LIFECYCLE_STATES = Object.freeze([
  'DRAFT',
  'FROZEN',
  'EVALUATED',
  'ARCHIVED',
]);

/**
 * Assessment-trust axis: how much confidence the assessment carries.
 *
 * ARCHITECTURE.md line 104 separates four axes and states that a successful
 * local quality evaluation "does not establish governed timing or
 * certification", while governed comparisons "remain unavailable by default".
 * This release therefore implements no review-grant and no certification
 * mechanism, so the trust axis carries only the two states a producer can
 * honestly state for itself plus the historical state: a legacy record, a
 * local self-assessment, or a local assessment that is not comparison eligible.
 * No value here may be read as a certification.
 */
export const EVALUATION_TRUSTS = Object.freeze([
  'UNTRUSTED_LEGACY',
  'INELIGIBLE_LOCAL_ASSESSMENT',
  'LOCAL_SELF_ASSESSMENT',
]);

/**
 * Evaluator-execution axis: whether the evaluator ran, ARCHITECTURE.md line
 * 104, reported separately from the agent outcome, the human review and the
 * trust axis. `INFRASTRUCTURE_ERROR` is its own value so an evaluation that
 * could not run is never recorded as a failed result.
 */
export const EVALUATOR_EXECUTION_STATUSES = Object.freeze([
  'SUCCESS',
  'FAILURE',
  'INFRASTRUCTURE_ERROR',
]);

/**
 * Human-review axis: ARCHITECTURE.md line 104 names human review as
 * pending/scored only, and line 102 states no numerical reference UI score is
 * invented. Review findings, reviewer identity and review digests are carried
 * verbatim in `notes` and `reviewDigest`; no review outcome is encoded here.
 */
export const HUMAN_REVIEW_STATUSES = Object.freeze(['NOT_REVIEWED', 'SCORED']);

/** Measurement units accepted by the neutral contract. */
export const MEASUREMENT_UNITS = Object.freeze([
  's',
  'ms',
  'min',
  'tokens',
  'points',
  'count',
  'bytes',
  'ratio',
  'usd',
]);

/** Neutral run outcome vocabulary (a superset of the historical one). */
export const RUN_STATUSES = Object.freeze([
  'COMPLETED',
  'TIME_LIMIT',
  'TIME_LIMIT_OVERRUN',
  'STOP_FAILURE',
  'INFRASTRUCTURE_FAILURE',
  'ABORTED',
  'SEEDED_NOT_STARTED',
]);

/**
 * A run that never produced an attempt is not scorable: these agent outcomes
 * can not carry a score, whatever a reader might compute. A run that ended in
 * `INFRASTRUCTURE_FAILURE` or `TIME_LIMIT` did produce an attempt, so it is
 * deliberately not listed here; whether its score is capped belongs to the
 * scoring authority, not to this contract.
 */
export const NON_SCORABLE_RUN_STATUSES = Object.freeze(['SEEDED_NOT_STARTED', 'ABORTED']);

/** Stop-request outcome vocabulary, shared with the historical shape. */
export const STOP_RESULTS = Object.freeze(['COMPLETED', 'STOPPED', 'STOP_FAILURE', 'UNKNOWN']);

/** Exposures an evaluator may declare about its own visibility. */
export const EVALUATOR_EXPOSURES = Object.freeze(['PUBLIC', 'OWNER_LOCAL', 'PRIVATE']);

/** Transparency of an evaluator towards the participant. */
export const EVALUATOR_TRANSPARENCIES = Object.freeze([
  'OPEN_SOURCE',
  'LOCAL_VISIBLE',
  'NOT_VISIBLE_TO_PARTICIPANT',
]);

/** Run security models that may be declared. */
export const SECURITY_MODELS = Object.freeze([
  'COOPERATIVE_WORKSPACE_NO_ADVERSARIAL_OS_CONTAINMENT',
  'OS_CONTAINED_WORKSPACE',
  'UNSPECIFIED',
]);

/** The only trust a self-assessing local producer may claim. */
export const MAX_SELF_ISSUED_EVALUATION_TRUST = 'LOCAL_SELF_ASSESSMENT';

/** Field carrying the untouched historical payload returned by the reader. */
export const LEGACY_SOURCE_FIELD = 'sourceRecord';

/** Discriminator marking a value produced by `readLegacyResult`. */
export const LEGACY_ENVELOPE_MARKER = 'legacyEnvelope';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/**
 * A `<major>.<minor>.<patch>` discriminator without a prerelease suffix.
 * Every component is a plain decimal without a leading zero (`0` and
 * `[1-9][0-9]*`), so a malformed leading-zero version such as `01.0.0` is
 * rejected here exactly as the companion JSON Schemas reject it.
 */
const SEMANTIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
/** Real-world version strings: the same no-leading-zero components, with an
 * optional prerelease tag (the benchmark releases as `1.0.0-candidate.9`). */
const BASIC_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const CAMEL_METRIC = /^[a-z0-9]+(?:[A-Z0-9][a-z0-9]*)*$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * The only bases an assessment can honestly claim in this release: the person
 * running it assessed it themselves, or a local procedure was executed. There
 * is no independent-review grant and no certification authority to name, so no
 * other basis kind is representable.
 */
const SELF_BASIS_KINDS = Object.freeze(['SELF_ASSESSMENT', 'LOCAL_PROCEDURE']);
const HASH_ALGORITHMS = Object.freeze(['sha256']);

/* ------------------------------------------------------------------------- */
/* Error type and validation entry point                                     */
/* ------------------------------------------------------------------------- */

export class ContractValidationError extends Error {
  constructor(path, message, value) {
    super(
      path + ': ' + message + (value === undefined ? '' : ' (got ' + describe(value) + ')'),
    );
    this.name = 'ContractValidationError';
    this.contractPath = path;
    this.contractMessage = message;
  }
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array(' + value.length + ')';
  if (typeof value === 'object') return 'object';
  const text = String(value);
  return JSON.stringify(text.length > 60 ? text.slice(0, 57) + '...' : text);
}

/**
 * Validate one neutral record against its family schema and invariants.
 *
 * @param {string} kind   one of NEUTRAL_CONTRACT_KINDS
 * @param {unknown} value candidate record
 * @returns {object}      validated projection (declared fields only; omitted
 *                        optionals are default-applied and every field keeps
 *                        the representation it was written in, so a validated
 *                        record validates again unchanged)
 * @throws  {Error}       unknown kind, malformed data, unsupported schema major,
 *                        a duplicate or inconsistent identity binding, or a
 *                        declared digest that does not match recomputation
 */
export function validateRecord(kind, value) {
  const validator = VALIDATORS[kind];
  if (validator === undefined)
    throw TypeError(
      'Unknown contract kind ' +
        describe(kind) +
        ' (expected one of ' +
        NEUTRAL_CONTRACT_KINDS.join(', ') +
        ')',
    );
  const state = { issues: [] };
  /* Every validator takes (path, value, state); the record starts at `$`. */
  const projected = validator('$', value, state);
  if (state.issues.length > 0)
    throw Error(
      kind +
        ' contract failed validation (' +
        state.issues.length +
        ' problem(s)):\n  - ' +
        state.issues.join('\n  - '),
    );
  return projected;
}

/* ------------------------------------------------------------------------- */
/* Field specifications                                                      */
/* ------------------------------------------------------------------------- */

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInt = (value) => Number.isSafeInteger(value);

const isNonNegative = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** A scalar field with its own `check(path, value, state)` rule. */
function field(check, { required = true, nullable = false, default: fallback } = {}) {
  return { kind: 'field', check, required, nullable, default: fallback };
}

/** An optional field that also tolerates an explicit `null`. */
const optionalScalar = (spec) => field(spec.check, { required: false, nullable: true });

/** A nested object validated by `validate(path, value, state)`. */
function record(validate, { required = true, nullable = false } = {}) {
  return { kind: 'record', validate, required, nullable };
}

const optionalRecord = (validate, { nullable = false } = {}) =>
  record(validate, { required: false, nullable });

function push(state, path, message, value) {
  state.issues.push(
    path + ': ' + message + (value === undefined ? '' : ' (got ' + describe(value) + ')'),
  );
}

/**
 * Closed object validator: unknown properties, missing required properties and
 * every nested rule are collected so one run reports all problems at once.
 */
function objectOf(path, value, spec, state) {
  if (!isPlainObject(value)) {
    push(state, path, 'must be an object', value);
    return {};
  }
  for (const key of Object.keys(value))
    if (!Object.hasOwn(spec, key)) push(state, path + '.' + key, 'unexpected property');
  const out = {};
  for (const [key, entry] of Object.entries(spec)) {
    const childPath = path + '.' + key;
    const present = Object.hasOwn(value, key) && value[key] !== undefined;
    if (!present) {
      if (entry.required) push(state, childPath, 'required');
      else if (entry.default !== undefined)
        out[key] = deepClone(typeof entry.default === 'function' ? entry.default() : entry.default);
      continue;
    }
    const child = value[key];
    if (child === null) {
      if (entry.nullable) out[key] = null;
      else push(state, childPath, 'null is not allowed here');
      continue;
    }
    out[key] =
      entry.kind === 'record'
        ? entry.validate(childPath, child, state)
        : entry.check(childPath, child, state);
  }
  return out;
}

const stringField = ({ pattern, minLength = 1 } = {}) =>
  field((path, value, state) => {
    if (typeof value !== 'string') return push(state, path, 'must be a string', value), value;
    if (value.length < minLength) push(state, path, 'needs at least ' + minLength + ' characters');
    if (pattern !== undefined && !pattern.test(value)) push(state, path, 'has an invalid format');
    return value;
  });

const versionField = (pattern, label) =>
  field((path, value, state) => {
    if (typeof value !== 'string')
      return push(state, path, 'must be a ' + label + ' version string', value), value;
    if (!pattern.test(value))
      push(state, path, 'must be a ' + label + ' version such as ' + pattern.source);
    return value;
  });

const digestField = () =>
  field((path, value, state) => {
    if (typeof value !== 'string' || !DIGEST_PATTERN.test(value))
      push(state, path, 'must be 64 lowercase hex characters');
    return value;
  });

const enumField = (values) =>
  field((path, value, state) => {
    if (typeof value !== 'string' || !values.includes(value))
      push(state, path, 'must be one of ' + values.join('|'));
    return value;
  });

const booleanField = (options) =>
  field((path, value, state) => {
    if (typeof value !== 'boolean') push(state, path, 'must be a boolean', value);
    return value;
  }, options);

const intField = ({ min, max }) =>
  field((path, value, state) => {
    if (!isInt(value) || value < min || value > max)
      push(state, path, 'must be an integer within ' + min + '..' + max);
    return value;
  });

const nonNegativeField = () =>
  field((path, value, state) => {
    if (!isNonNegative(value)) push(state, path, 'must be a finite number >= 0');
    return value;
  });

const numberField = (options) =>
  field((path, value, state) => {
    if (typeof value !== 'number' || !Number.isFinite(value))
      push(state, path, 'must be a finite number');
    return value;
  }, options);

const timestampField = (options) =>
  field((path, value, state) => {
    if (typeof value !== 'string' || !ISO_UTC.test(value) || !Number.isFinite(Date.parse(value)))
      push(state, path, 'must be an ISO-8601 UTC timestamp');
    return value;
  }, options);

/** Closed map of strings; `null` means "not known" and is preserved as null. */
const stringMapField = (options) =>
  field((path, value, state) => {
    if (!isPlainObject(value)) return push(state, path, 'must be an object of strings', value), {};
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (typeof child !== 'string') push(state, path + '.' + key, 'must be a string');
      out[key] = child;
    }
    return out;
  }, options);

/** Closed map of non-negative numbers. */
const numberMapField = ({ nonEmpty = false } = {}) =>
  field((path, value, state) => {
    if (!isPlainObject(value)) return push(state, path, 'must be an object of numbers', value), {};
    if (nonEmpty && Object.keys(value).length === 0) push(state, path, 'must not be empty');
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (!isNonNegative(child)) push(state, path + '.' + key, 'must be a finite number >= 0');
      out[key] = child;
    }
    return out;
  });

const idListField = (options) =>
  field((path, value, state) => {
    if (!Array.isArray(value)) return push(state, path, 'must be an array of identifiers', value), [];
    const seen = new Set();
    for (const [index, child] of value.entries()) {
      const childPath = path + '[' + index + ']';
      if (typeof child !== 'string' || child.length === 0)
        push(state, childPath, 'must be a non-empty string');
      else if (seen.has(child)) push(state, childPath, 'duplicate identifier ' + child);
      else seen.add(child);
    }
    return [...value];
  }, options);

/**
 * Participant-relative POSIX path. Absolute paths, backslashes, drive letters,
 * control characters, dot segments and trailing separators are refused: a
 * contract record must not smuggle a host or owner path, and no spelling is
 * ever rewritten, so the recorded path is the exact bytes that were hashed.
 * Unicode path characters are data and are never interpreted or normalised.
 */
function posixPathIssues(value) {
  const problems = [];
  if (typeof value !== 'string' || value.length === 0) return ['must be a non-empty POSIX path'];
  if (value.includes('\\')) problems.push('must use forward-slash POSIX separators');
  if (value.includes(':')) problems.push('must not contain a drive letter or colon');
  if (/[\u0000-\u001f\u007f]/.test(value)) problems.push('must not contain control characters');
  if (value.startsWith('/')) problems.push('must be relative, not absolute');
  if (value.endsWith('/')) problems.push('must not end with a separator');
  for (const segment of value.split('/'))
    if (segment === '.' || segment === '..' || segment === '')
      problems.push('must not contain . or .. or empty segments');
  return problems;
}

const pathField = () =>
  field((path, value, state) => {
    for (const problem of posixPathIssues(value)) push(state, path, problem);
    return value;
  });

/**
 * A native absolute host root: a POSIX `/root`, a Windows drive root
 * `C:\root` or `C:/root`, or a UNC root `\\server\share`. Run roots are
 * explicit host arguments recorded in the host's own path syntax (they are
 * never reinterpreted into participant-relative POSIX inventory paths), so a
 * relative string does not state the root the run was seeded with.
 */
const HOST_ROOT_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

const hostRootField = () =>
  field((path, value, state) => {
    if (typeof value !== 'string' || value.length === 0)
      return push(state, path, 'must be a non-empty native absolute host root', value), value;
    if (!HOST_ROOT_ABSOLUTE.test(value))
      push(
        state,
        path,
        'must be a native absolute host root (POSIX /root, Windows C:\\root or UNC \\\\root)',
        value,
      );
    return value;
  });

/**
 * Purely lexical overlap of two host roots, without consulting a filesystem
 * or host case rules: separators are treated as exchangeable, trailing
 * separators are dropped, and the roots overlap when one reaches into the
 * other at a separator boundary (`C:\r\ws` and `C:\r\ws2` are disjoint;
 * `C:\r\ws` and `C:\r\ws\e` are not).
 */
function hostRootsOverlap(left, right) {
  const normalise = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = normalise(left);
  const b = normalise(right);
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

/**
 * Frozen inventory of `[path, fileDigest]` pairs: unique paths, sorted
 * ascending, each file digest well-formed. Order is part of the contract
 * because the preserved digest algorithm hashes the sorted pair list.
 */
const inventoryField = () =>
  field((path, value, state) => {
    if (!Array.isArray(value)) return push(state, path, 'must be an inventory array', value), [];
    const out = [];
    let previous = null;
    value.forEach((entry, index) => {
      const entryPath = path + '[' + index + ']';
      if (!Array.isArray(entry) || entry.length !== 2)
        return push(state, entryPath, 'must be a [path, fileDigest] pair');
      const [rawPath, rawDigest] = entry;
      for (const problem of posixPathIssues(rawPath))
        push(state, entryPath + '.path', problem);
      if (typeof rawDigest !== 'string' || !DIGEST_PATTERN.test(rawDigest))
        push(state, entryPath + '.hash', 'must be 64 lowercase hex characters');
      if (typeof rawPath === 'string' && posixPathIssues(rawPath).length === 0) {
        if (previous !== null && previous >= rawPath)
          push(state, entryPath, 'inventory must be sorted by path with no duplicate paths');
        previous = rawPath;
      }
      out.push([rawPath, rawDigest]);
    });
    return out;
  });

/**
 * The version discriminator gate. An unsupported major is reported as such and
 * never down-converted; a supported major passes and then faces every
 * structural invariant, which is why a compatible minor cannot skip them.
 */
const schemaVersionField = () =>
  field((path, value, state) => {
    if (typeof value !== 'string' || !SEMANTIC_VERSION.test(value))
      return push(state, path, 'must be <major>.<minor>.<patch>', value), value;
    const major = Number(value.split('.')[0]);
    if (major !== SUPPORTED_SCHEMA_MAJOR)
      push(
        state,
        path,
        'schema major ' + major +
          ' is not supported by this contract release (expected ' + SUPPORTED_SCHEMA_MAJOR +
          '); unknown-major data is not coerced',
      );
    return value;
  });

const kindField = (kind) =>
  field((path, value, state) => {
    if (value !== kind) push(state, path, 'must be ' + kind + ' for this contract family');
    return value;
  });

const notesField = () =>
  optionalScalar(field((path, value, state) => stringField().check(path, value, state)));

/** How a reported digest was obtained, so a number is never unsourced. */
const provenanceField = () => (path, value, state) =>
  objectOf(
    path,
    value,
    {
      kind: enumField(['COMPUTED', 'INHERITED']),
      procedure: stringField({ minLength: 3 }),
      inputs: optionalScalar(idListField()),
    },
    state,
  );

/* ------------------------------------------------------------------------- */
/* Canonical JSON, sha256 and the preserved tree digest                      */
/* ------------------------------------------------------------------------- */

/** Canonical JSON: object keys sorted, array order preserved. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((entry) => canonicalJson(entry)).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
      .join(',') +
    '}'
  );
}

/** sha256 hex over UTF-8 text, matching the established hash helper. */
export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Case fold used only for collision detection; never used to rewrite, sort by
 * or report a path.
 */
function foldPathCase(value) {
  return value.normalize('NFD').toUpperCase().normalize('NFC');
}

/**
 * Tree digest over an inventory of `[posixPath, fileDigest]` pairs.
 *
 * Preserved algorithm: sort the exact strings lexically, then sha256 over the
 * canonical JSON serialisation of the pair list — the same bytes
 * `packages/core/identity.mjs` `hashEntries` hashes, so both agree for the
 * same inputs. Paths are never rewritten, normalised, trimmed or reformatted:
 * a non-exact relative POSIX spelling (backslashes, drive letters, leading
 * `./`, dot/traversal segments, repeated, leading or trailing separators,
 * absolute forms, control characters) is refused before hashing, and raw
 * bytes and Unicode paths are carried verbatim. Duplicate paths are refused
 * because they would silently hide bytes, and case-insensitive collisions
 * between distinct spellings are refused because a case-insensitive volume
 * cannot store both under different names.
 */
export function computeTreeDigest(entries) {
  if (!Array.isArray(entries)) throw TypeError('tree digest needs an inventory array');
  const seen = new Set();
  const folded = new Set();
  const pairs = [];
  for (const [index, entry] of entries.entries()) {
    if (!Array.isArray(entry) || entry.length !== 2)
      throw TypeError('tree digest entry ' + index + ' must be [path, fileDigest]');
    const rawPath = entry[0];
    if (typeof rawPath !== 'string' || posixPathIssues(rawPath).length > 0) {
      const reason = typeof rawPath === 'string'
        ? posixPathIssues(rawPath).join('; ')
        : 'path must be a non-empty exact relative POSIX string';
      throw TypeError(
        'tree digest entry ' + index + ' must be an exact relative POSIX path: ' + reason,
      );
    }
    if (seen.has(rawPath)) throw Error('tree digest has a duplicate path: ' + rawPath);
    seen.add(rawPath);
    const fold = foldPathCase(rawPath);
    if (folded.has(fold))
      throw Error('tree digest has a case-insensitive path collision: ' + rawPath);
    folded.add(fold);
    if (typeof entry[1] !== 'string' || !DIGEST_PATTERN.test(entry[1]))
      throw TypeError('tree digest entry ' + index + ' needs a 64-hex file digest');
    pairs.push([rawPath, entry[1]]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(canonicalJson(pairs));
}

/**
 * Recompute an inventory digest, reporting a structurally unreadable inventory
 * through the validation state instead of throwing out of a validator.
 */
function recomputeOrReport(path, inventory, state) {
  try {
    return computeTreeDigest(inventory);
  } catch (problem) {
    push(state, path, problem.message);
    return undefined;
  }
}

/**
 * Self digest of a record: sha256 over its canonical bytes excluding the
 * self-digest fields themselves. Because it is recomputed on validation, a
 * binding digest cannot be forged or left stale.
 */
export function identityDigestOf(recordValue) {
  if (!isPlainObject(recordValue)) throw TypeError('identity digest needs an object');
  const body = {};
  for (const [key, value] of Object.entries(recordValue))
    if (key !== 'identityDigest' && key !== 'manifestDigest') body[key] = value;
  return sha256Hex(canonicalJson(body));
}

function assertSelfDigest(path, projected, fieldNames, state) {
  const present = fieldNames.filter((name) => typeof projected[name] === 'string');
  if (present.length === 0) return;
  const recomputed = identityDigestOf(projected);
  for (const name of present)
    if (projected[name] !== recomputed)
      push(
        state,
        path + '.' + name,
        'does not match the digest recomputed from this record (' + recomputed + ')',
      );
}

/* ------------------------------------------------------------------------- */
/* Shared sub-objects                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Architecture fields carried by every identity: which family and which
 * architecture binding this identity describes, plus the hash algorithm, the
 * digest of the definition it was derived from and how that digest was
 * obtained.
 */
const architectureFields = () => ({
  architectureId: stringField({ minLength: 3 }),
  architectureKind: stringField({ minLength: 3 }),
  hashAlgorithm: enumField(HASH_ALGORITHMS),
  definitionDigest: digestField(),
  digestProvenance: record(provenanceField()),
});

/* ------------------------------------------------------------------------- */
/* ToolingIdentity                                                           */
/* ------------------------------------------------------------------------- */

const supportedContractsSpec = (path, value, state) =>
  objectOf(
    path,
    value,
    {
      contractsVersion: versionField(SEMANTIC_VERSION, 'contracts'),
      kinds: field((kindPath, kinds, kindState) => {
        if (!Array.isArray(kinds) || kinds.length === 0) {
          push(kindState, kindPath, 'must be a non-empty array of contract kinds');
          return [];
        }
        const seen = new Set();
        kinds.forEach((entry, index) => {
          const entryPath = kindPath + '[' + index + ']';
          if (!NEUTRAL_CONTRACT_KINDS.includes(entry)) push(kindState, entryPath, 'unknown contract kind');
          else if (seen.has(entry)) push(kindState, entryPath, 'duplicate kind ' + entry);
          else seen.add(entry);
        });
        return [...kinds];
      }),
    },
    state,
  );

function validateToolingIdentity(path, value, state) {
  const out = objectOf(
    path,
    value,
    {
      schemaVersion: schemaVersionField(),
      kind: kindField('ToolingIdentity'),
      toolingId: stringField({ minLength: 3 }),
      toolingVersion: versionField(SEMANTIC_VERSION, 'tooling'),
      toolingComponent: stringField(),
      revision: stringField(),
      installedDigest: digestField(),
      adapterName: optionalScalar(stringField()),
      adapterVersion: optionalScalar(versionField(SEMANTIC_VERSION, 'adapter')),
      ...architectureFields(),
      supportedContracts: optionalRecord(supportedContractsSpec),
      notes: notesField(),
      identityDigest: optionalScalar(digestField()),
    },
    state,
  );
  if (out.adapterVersion != null && out.adapterName == null)
    push(state, path + '.adapterVersion', 'an adapter version needs an adapter name');
  assertSelfDigest(path, out, ['identityDigest'], state);
  return out;
}

/* ------------------------------------------------------------------------- */
/* ChallengeIdentity — with preserved original candidate lineage             */
/* ------------------------------------------------------------------------- */

/**
 * Challenge lineage preserves the original candidate rather than overwriting
 * it: the historical candidate version, status, commit, tag and review/evidence
 * digests are carried through, so old evidence still binds to a neutral
 * identity.
 */
const candidateLineageSpec = (path, value, state) =>
  objectOf(
    path,
    value,
    {
      candidateVersion: versionField(BASIC_VERSION, 'candidate'),
      candidateStatus: stringField(),
      sourceCommit: stringField({ pattern: COMMIT_PATTERN }),
      sourceTag: optionalScalar(stringField()),
      reviewPacketDigest: optionalScalar(digestField()),
      reviewStatus: optionalScalar(stringField()),
      evidenceManifestDigest: optionalScalar(digestField()),
      lineageNotes: optionalScalar(stringField()),
    },
    state,
  );

function validateChallengeIdentity(path, value, state) {
  const out = objectOf(
    path,
    value,
    {
      schemaVersion: schemaVersionField(),
      kind: kindField('ChallengeIdentity'),
      challengeId: stringField({ minLength: 3 }),
      challengeVersion: versionField(SEMANTIC_VERSION, 'challenge'),
      ...architectureFields(),
      workloadProvenance: record(provenanceField()),
      provenanceInputs: optionalScalar(idListField()),
      publicPrdDigest: digestField(),
      visibleHarnessDigest: digestField(),
      fixtureDigest: digestField(),
      starterInventory: inventoryField(),
      workloadDigest: digestField(),
      declaredCeilingMinutes: optionalScalar(intField({ min: 1, max: 1440 })),
      candidateLineage: record(candidateLineageSpec),
      notes: notesField(),
      identityDigest: optionalScalar(digestField()),
    },
    state,
  );

  if (Array.isArray(out.starterInventory)) {
    const recomputed = recomputeOrReport(path + '.workloadDigest', out.starterInventory, state);
    if (recomputed !== undefined && recomputed !== out.workloadDigest)
      push(
        state,
        path + '.workloadDigest',
        'does not match the digest recomputed from starterInventory (' + recomputed + ')',
      );
  }
  /* Lineage is preserved, never re-derived: when the identity inherits a
   * workload digest from other records, the records must be named. */
  if (out.workloadProvenance?.kind === 'INHERITED' &&
      (!Array.isArray(out.provenanceInputs) || out.provenanceInputs.length === 0))
    push(state, path + '.provenanceInputs',
      'an inherited workload digest must name the records it was read from');
  /* Candidate lineage is preserved data, not an ordering gate: tooling,
   * challenge, evaluator and candidate versions are separate named domains on
   * different release trains, and a candidate version string that happens to
   * predate the challenge version is carried exactly as the historical record
   * stated it. The identities stay bound by IDs, architecture bindings and
   * sealed digests — never by comparing version strings across domains. */
  assertSelfDigest(path, out, ['identityDigest'], state);
  return out;
}

/* ------------------------------------------------------------------------- */
/* EvaluatorIdentity                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Scoring bindings carry the authority split so a result can name it without
 * being able to mutate it. Only structural coherence is checked: this contract
 * performs no scoring arithmetic and does not reimplement a rubric.
 */
const scoringBindingsSpec = (path, value, state) => {
  const out = objectOf(
    path,
    value,
    {
      automatedMaximum: field((scorePath, score, scoreState) => {
        if (!isNonNegative(score) || score <= 0)
          push(scoreState, scorePath, 'must be a positive finite number');
        return score;
      }),
      humanMaximum: nonNegativeField(),
      maximum: field((scorePath, score, scoreState) => {
        if (!isNonNegative(score) || score <= 0)
          push(scoreState, scorePath, 'must be a positive finite number');
        return score;
      }),
      categories: numberMapField({ nonEmpty: true }),
    },
    state,
  );
  const categories = out.categories ?? {};
  const total = Object.values(categories).reduce((sum, cap) => sum + cap, 0);
  if (Object.keys(categories).length > 0 && isNonNegative(out.maximum) && total > out.maximum)
    push(
      state,
      path + '.categories',
      'category maxima sum to ' + total + ' which exceeds maximum ' + out.maximum,
    );
  return out;
};

function validateEvaluatorIdentity(path, value, state) {
  const out = objectOf(
    path,
    value,
    {
      schemaVersion: schemaVersionField(),
      kind: kindField('EvaluatorIdentity'),
      evaluatorId: stringField({ minLength: 3 }),
      evaluatorVersion: versionField(SEMANTIC_VERSION, 'evaluator'),
      exposure: enumField(EVALUATOR_EXPOSURES),
      transparency: enumField(EVALUATOR_TRANSPARENCIES),
      secretClaim: booleanField({ required: false, default: false }),
      ...architectureFields(),
      scoringDigest: digestField(),
      visibleTestsDigest: digestField(),
      hiddenTestsDigest: digestField(),
      harnessDigest: optionalScalar(digestField()),
      scoringBindings: optionalRecord(scoringBindingsSpec, { nullable: true }),
      notes: notesField(),
      identityDigest: optionalScalar(digestField()),
    },
    state,
  );
  if (out.secretClaim === true && out.transparency === 'OPEN_SOURCE')
    push(state, path + '.secretClaim', 'an open-source evaluator cannot claim secrecy from its local user');
  assertSelfDigest(path, out, ['identityDigest'], state);
  return out;
}

/* ------------------------------------------------------------------------- */
/* RunManifest                                                               */
/* ------------------------------------------------------------------------- */

const bindingEnvelopeFields = (identityId, identityDigest) => ({
  [identityId]: stringField({ minLength: 3 }),
  architectureId: stringField({ minLength: 3 }),
  [identityDigest]: digestField(),
});

const toolingBindingSpec = (path, value, state) =>
  objectOf(
    path,
    value,
    {
      ...bindingEnvelopeFields('toolingId', 'toolingIdentityDigest'),
      toolingVersion: versionField(SEMANTIC_VERSION, 'tooling'),
      toolingComponent: stringField(),
      installedDigest: digestField(),
      adapterName: optionalScalar(stringField()),
      adapterVersion: optionalScalar(versionField(SEMANTIC_VERSION, 'adapter')),
    },
    state,
  );

const challengeBindingSpec = (path, value, state) =>
  objectOf(
    path,
    value,
    {
      ...bindingEnvelopeFields('challengeId', 'challengeIdentityDigest'),
      challengeVersion: versionField(SEMANTIC_VERSION, 'challenge'),
      workloadDigest: digestField(),
      declaredCeilingMinutes: optionalScalar(intField({ min: 1, max: 1440 })),
      candidateVersion: versionField(BASIC_VERSION, 'candidate'),
    },
    state,
  );

const evaluatorBindingSpec = (path, value, state) =>
  objectOf(
    path,
    value,
    {
      ...bindingEnvelopeFields('evaluatorId', 'evaluatorIdentityDigest'),
      evaluatorVersion: versionField(SEMANTIC_VERSION, 'evaluator'),
      scoringDigest: digestField(),
      exposure: enumField(EVALUATOR_EXPOSURES),
    },
    state,
  );

const runBindingsSpec = (path, value, state) =>
  objectOf(
    path,
    value,
    {
      tooling: record(toolingBindingSpec),
      challenge: record(challengeBindingSpec),
      evaluator: record(evaluatorBindingSpec),
    },
    state,
  );

/**
 * Run configuration. `null` means "not known here" and stays null: an unknown
 * field is never defaulted to zero or an empty string. Values are descriptive
 * only; this contract never queries a harness or a configuration service.
 */
const configurationSpec = (path, value, state) => {
  const out = objectOf(
    path,
    value,
    {
      harness: optionalScalar(stringField()),
      model: optionalScalar(stringField()),
      location: optionalScalar(stringField()),
      os: optionalScalar(stringField()),
      nodeVersion: optionalScalar(stringField()),
      runtimeFlags: optionalScalar(stringMapField()),
      unknown: field((unknownPath, unknown, unknownState) => {
        if (unknown !== null && unknown !== 'UNKNOWN' && unknown !== 'UNSET')
          push(unknownState, unknownPath, 'must be null, UNKNOWN or UNSET');
        return unknown;
      }, { nullable: true }),
      unknownFields: field((listPath, list, listState) => {
        const spec = idListField();
        return spec.check(listPath, list, listState);
      }, { required: false, default: () => [] }),
    },
    state,
  );
  if (out.unknown !== 'UNKNOWN' && Array.isArray(out.unknownFields) && out.unknownFields.length > 0)
    push(state, path + '.unknownFields', 'is only meaningful when unknown is UNKNOWN');
  return out;
};

function validateRunManifest(path, value, state) {
  const out = objectOf(
    path,
    value,
    {
      schemaVersion: schemaVersionField(),
      kind: kindField('RunManifest'),
      manifestId: stringField({ minLength: 3 }),
      runId: stringField({ minLength: 3 }),
      createdAt: timestampField(),
      architectureId: stringField({ minLength: 3 }),
      architectureKind: stringField({ minLength: 3 }),
      hashAlgorithm: enumField(HASH_ALGORITHMS),
      definitionDigest: digestField(),
      digestProvenance: record(provenanceField()),
      bindings: record(runBindingsSpec),
      harness: stringField(),
      securityModel: enumField(SECURITY_MODELS),
      expectedSessionPolicy: optionalScalar(stringMapField()),
      declaredCeilingMinutes: optionalScalar(intField({ min: 1, max: 1440 })),
      configuration: record(configurationSpec),
      participantWorkspaceRoot: hostRootField(),
      evidenceRoot: hostRootField(),
      notes: notesField(),
      manifestDigest: optionalScalar(digestField()),
    },
    state,
  );

  const bindings = out.bindings ?? {};
  const tooling = bindings.tooling ?? {};
  const challenge = bindings.challenge ?? {};
  const evaluator = bindings.evaluator ?? {};

  /* Invariants a compatible schema minor can not skip. */
  const identityIds = [
    ['tooling.toolingId', tooling.toolingId],
    ['challenge.challengeId', challenge.challengeId],
    ['evaluator.evaluatorId', evaluator.evaluatorId],
  ];
  const seenIds = new Map();
  for (const [label, id] of identityIds) {
    if (typeof id !== 'string') continue;
    if (seenIds.has(id))
      push(state, path + '.bindings.' + label,
        'duplicates bindings.' + seenIds.get(id) + '; identities must be distinct');
    else seenIds.set(id, label);
  }

  const architectures = [
    ['architectureId', out.architectureId],
    ['bindings.tooling.architectureId', tooling.architectureId],
    ['bindings.challenge.architectureId', challenge.architectureId],
    ['bindings.evaluator.architectureId', evaluator.architectureId],
  ];
  const seenArchitectures = new Map();
  for (const [label, architectureId] of architectures) {
    if (typeof architectureId !== 'string') continue;
    if (seenArchitectures.has(architectureId))
      push(state, path + '.' + label,
        'collides with ' + seenArchitectures.get(architectureId) +
        '; a run must not reuse a binding architecture as its own');
    else seenArchitectures.set(architectureId, label);
  }

  /* Version strings belong to separately bound identity domains: tooling,
   * challenge, evaluator and candidate versions are different named fields on
   * different release trains, and equality of the strings across those
   * domains does not conflate the identities. What binds each binding to its
   * identity — and what keeps the domains apart — are the distinct IDs above,
   * the distinct architecture bindings and the identity digests sealed into
   * the manifest digest, all of which stay enforced. */

  /* The two run roots state where the participant workspace and the evidence
   * live on the host. They are explicit native absolute arguments, and where
   * a record names both, they must be lexically disjoint: evidence written
   * under the participant workspace neither separates the two trees nor gives
   * an evaluator output root that reaches into participant files. */
  if (typeof out.participantWorkspaceRoot === 'string' &&
      typeof out.evidenceRoot === 'string' &&
      HOST_ROOT_ABSOLUTE.test(out.participantWorkspaceRoot) &&
      HOST_ROOT_ABSOLUTE.test(out.evidenceRoot) &&
      hostRootsOverlap(out.participantWorkspaceRoot, out.evidenceRoot))
    push(state, path + '.evidenceRoot',
      'overlaps participantWorkspaceRoot lexically; workspace and evidence roots must be disjoint host roots');

  if (isInt(out.declaredCeilingMinutes) && isInt(challenge.declaredCeilingMinutes) &&
      out.declaredCeilingMinutes > challenge.declaredCeilingMinutes)
    push(state, path + '.declaredCeilingMinutes',
      'exceeds the ' + challenge.declaredCeilingMinutes + ' minute ceiling bound by the challenge identity');

  assertSelfDigest(path, out, ['manifestDigest'], state);
  return out;
}

/* ------------------------------------------------------------------------- */
/* FrozenSubmission                                                           */
/* ------------------------------------------------------------------------- */

function validateFrozenSubmission(path, value, state) {
  const out = objectOf(
    path,
    value,
    {
      schemaVersion: schemaVersionField(),
      kind: kindField('FrozenSubmission'),
      frozenSubmissionId: stringField({ minLength: 3 }),
      manifestId: stringField({ minLength: 3 }),
      runId: stringField({ minLength: 3 }),
      frozenAt: timestampField(),
      hashAlgorithm: enumField(HASH_ALGORITHMS),
      inventory: inventoryField(),
      treeDigest: digestField(),
      byteCount: field((countPath, count, countState) => {
        if (!isInt(count) || count < 0) push(countState, countPath, 'must be a non-negative byte count');
        return count;
      }),
      fileCount: field((countPath, count, countState) => {
        if (!isInt(count) || count < 0) push(countState, countPath, 'must be a non-negative file count');
        return count;
      }),
      freezeProcedure: stringField({ minLength: 3 }),
      notes: notesField(),
    },
    state,
  );
  if (Array.isArray(out.inventory)) {
    const recomputed = recomputeOrReport(path + '.treeDigest', out.inventory, state);
    if (recomputed !== undefined && recomputed !== out.treeDigest)
      push(state, path + '.treeDigest',
        'does not match the digest recomputed from inventory (' + recomputed + ')');
    if (isInt(out.fileCount) && out.fileCount !== out.inventory.length)
      push(state, path + '.fileCount', 'expected ' + out.inventory.length + ' from the inventory');
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Measurement                                                                */
/* ------------------------------------------------------------------------- */

function measurementSourceSpec(path, value, state) {
  const localId = value?.kind === 'LOCAL_ID';
  const claimsId = localId || (isPlainObject(value) &&
    (Object.hasOwn(value, 'recordId') || Object.hasOwn(value, 'recordKind')));
  const out = objectOf(path, value, {
    kind: enumField(['LOCAL_ID', 'LOCAL_DIGEST', 'COMPUTED', 'SELF_ASSESSMENT', 'LOCAL_PROCEDURE']),
    /* A claimed reference is never nullable. Companion ID fields are a pair,
     * including on digest/procedure sources; absent pairs stay absent. */
    recordKind: field(enumField(NEUTRAL_CONTRACT_KINDS).check, { required: claimsId }),
    recordId: field(stringField({ pattern: /\S/ }).check, { required: claimsId }),
    digest: field(digestField().check, { required: value?.kind === 'LOCAL_DIGEST' ||
      (isPlainObject(value) && Object.hasOwn(value, 'digest')) }),
    procedure: stringField({ minLength: 3, pattern: /\S/ }),
  }, state);
  return out;
}

/**
 * Problems a derivation formula string can have. The formula is the one
 * stable representation everywhere: on the wire, in the runtime, in the
 * schema and in the declarations, so a validated measurement can always
 * validate again. A formula is well formed only when it names at least one
 * whole `{input}` placeholder — every `{` and every `}` belongs to exactly
 * one `{camelCaseOrDottedNumericName}` token where the name matches the
 * metric grammar `[a-z0-9]+(?:[A-Z0-9][a-z0-9]*)*` — and every input is
 * named at most once. The shared structural rule lives in
 * `DERIVATION_TOKEN_PATTERN_SOURCE` so the runtime, the helper, the JSON
 * Schemas and the type declarations agree on exactly the same grammar.
 */
const DERIVATION_TOKEN_PATTERN_SOURCE = '\\{[a-z0-9]+(?:[A-Z0-9][a-z0-9]*)*\\}';

function derivationProblems(formula) {
  const problems = [];
  const opens = (formula.match(/\{/g) ?? []).length;
  const closes = (formula.match(/\}/g) ?? []).length;
  const tokens = formula.match(new RegExp(DERIVATION_TOKEN_PATTERN_SOURCE, 'g')) ?? [];
  /* An empty formula, a placeholder-free formula or one whose braces do not
   * all belong to whole tokens is outside the grammar the shared rule and
   * the JSON Schema (minLength + pattern) enforce. */
  if (formula.length === 0 || tokens.length === 0)
    problems.push(
      'must name at least one {metricName} placeholder in the shared grammar; ' +
        'placeholder-free, empty or whitespace-only text is not a derivation',
    );
  else if (tokens.length !== opens || tokens.length !== closes)
    problems.push(
      'placeholders are not well formed: every { and } must belong to one whole ' +
        '{metricName} token, with no stray brace and no nesting',
    );
  const inputs = tokens.map((token) => token.slice(1, -1));
  if (new Set(inputs).size !== inputs.length)
    problems.push('a repeated input must be an explicit dependency');
  return problems;
}

/**
 * Parse the inputs a derivation formula names: the same well-formedness rules
 * the validator applies, exposed for callers that consume the dependency list
 * instead of the formula string. The formula itself stays the record's only
 * stored representation.
 */
export function parseDerivation(formula) {
  if (typeof formula !== 'string') throw TypeError('parseDerivation: formula must be a string');
  const problems = derivationProblems(formula);
  if (problems.length > 0)
    throw TypeError('parseDerivation: ' + problems.join('; '));
  const tokens = formula.match(new RegExp(DERIVATION_TOKEN_PATTERN_SOURCE, 'g')) ?? [];
  return deepFreeze({
    formula,
    inputs: Object.freeze(tokens.map((token) => token.slice(1, -1))),
  });
}

function validateMeasurement(path, value, state) {
  const out = objectOf(
    path,
    value,
    {
      schemaVersion: schemaVersionField(),
      kind: kindField('Measurement'),
      measurementId: stringField({ minLength: 3 }),
      metric: stringField({ pattern: CAMEL_METRIC }),
      unit: enumField(MEASUREMENT_UNITS),
      measurementKind: enumField(MEASUREMENT_KINDS),
      value: field((valuePath, number, valueState) => {
        if (typeof number !== 'number' || !Number.isFinite(number))
          push(valueState, valuePath, 'must be a finite number');
        return number;
      }, { nullable: true }),
      source: record(measurementSourceSpec, { nullable: true }),
      derivation: field((derivationPath, formula, derivationState) => {
        /* One stable representation: the formula is stored, validated,
         * persisted and read back as the same string, so a validated DERIVED
         * measurement (standalone or inside a Result) always validates again.
         * `parseDerivation` derives the input list on demand; the record
         * never grows a second shape for it. */
        if (typeof formula !== 'string')
          return push(derivationState, derivationPath, 'must be a derivation formula'), formula;
        for (const problem of derivationProblems(formula))
          push(derivationState, derivationPath, problem);
        return formula;
      }, { required: false }),
      confidence: optionalScalar(field((confidencePath, confidence, confidenceState) => {
        if (!isNonNegative(confidence) || confidence > 1)
          push(confidenceState, confidencePath, 'must be within 0..1');
        return confidence;
      })),
      recordedAt: optionalScalar(timestampField()),
      notes: notesField(),
    },
    state,
  );

  /* measurementKind, value and source must tell one consistent story. */
  if (out.measurementKind === 'UNAVAILABLE') {
    if (out.value !== null)
      push(state, path + '.value', 'an UNAVAILABLE measurement must be null rather than a number');
    if (out.source !== null)
      push(state, path + '.source', 'an UNAVAILABLE measurement must not claim a source');
    if (out.confidence != null)
      push(state, path + '.confidence', 'an UNAVAILABLE measurement must stay unmeasured');
    if (out.derivation !== undefined)
      push(state, path + '.derivation', 'an UNAVAILABLE measurement can not be derived');
  } else {
    if (out.value === null)
      push(state, path + '.value', 'a ' + out.measurementKind + ' measurement must not be null');
    if (out.source === null)
      push(state, path + '.source', 'a ' + out.measurementKind + ' measurement needs a source');
  }
  if (out.measurementKind === 'MEASURED' && out.derivation !== undefined)
    push(state, path + '.derivation', 'only a DERIVED measurement may declare a derivation');
  if (out.measurementKind === 'DERIVED' && out.derivation === undefined)
    push(state, path + '.derivation', 'a DERIVED measurement must name its inputs');
  if (out.measurementKind === 'ENTERED' && out.source?.kind === 'COMPUTED')
    push(state, path + '.source', 'an ENTERED measurement can not be reported as COMPUTED');
  if (out.measurementKind === 'MEASURED' &&
      ['SELF_ASSESSMENT', 'LOCAL_PROCEDURE'].includes(out.source?.kind))
    push(state, path + '.source',
      'a MEASURED measurement needs a local ID, a local digest or a COMPUTED source');
  return out;
}

/* ------------------------------------------------------------------------- */
/* Result                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * What the assessment trust rests on. Only the two honest bases are accepted,
 * and there is deliberately no field for a grant, an authority or an issue
 * certificate: naming one would imply a mechanism this release does not
 * implement, which is exactly what ARCHITECTURE.md line 104 forbids.
 */
const trustBasisSpec = (path, value, state) =>
  objectOf(
    path,
    value,
    {
      basisKind: enumField(SELF_BASIS_KINDS),
      basisDigest: optionalScalar(digestField()),
      reviewer: optionalScalar(stringField()),
    },
    state,
  );

const humanReviewSpec = (path, value, state) =>
  objectOf(
    path,
    value,
    {
      reviewId: optionalScalar(stringField()),
      reviewStatus: enumField(HUMAN_REVIEW_STATUSES),
      reviewer: optionalScalar(stringField()),
      reviewDigest: optionalScalar(digestField()),
      reviewedAt: optionalScalar(timestampField()),
    },
    state,
  );

const resultBindingsSpec = (path, value, state) =>
  objectOf(
    path,
    value,
    {
      manifestId: stringField({ minLength: 3 }),
      runId: stringField({ minLength: 3 }),
      frozenSubmissionId: stringField({ minLength: 3 }),
      treeDigest: digestField(),
      manifestDigest: digestField(),
      toolingIdentityDigest: digestField(),
      challengeIdentityDigest: digestField(),
      evaluatorIdentityDigest: digestField(),
      challengeId: stringField({ minLength: 3 }),
      challengeVersion: versionField(SEMANTIC_VERSION, 'challenge'),
      candidateVersion: versionField(BASIC_VERSION, 'candidate'),
      evaluatorId: stringField({ minLength: 3 }),
      evaluatorVersion: versionField(SEMANTIC_VERSION, 'evaluator'),
      toolingId: stringField({ minLength: 3 }),
      toolingVersion: versionField(SEMANTIC_VERSION, 'tooling'),
      workloadDigest: digestField(),
    },
    state,
  );

const qualityRecordSpec = (path, value, state) =>
  objectOf(
    path,
    value,
    {
      automated: nonNegativeField(),
      automatedMaximum: nonNegativeField(),
      humanUI: optionalScalar(nonNegativeField()),
      humanMaximum: nonNegativeField(),
      quality: optionalScalar(nonNegativeField()),
      qualityMaximum: nonNegativeField(),
      status: enumField(['HUMAN_REVIEW_PENDING', 'SCORED', 'INVALID']),
      categories: numberMapField(),
    },
    state,
  );

function validateResult(path, value, state) {
  const out = objectOf(
    path,
    value,
    {
      schemaVersion: schemaVersionField(),
      kind: kindField('Result'),
      resultId: stringField({ minLength: 3 }),
      lifecycle: enumField(LIFECYCLE_STATES),
      runStatus: enumField(RUN_STATUSES),
      /**
       * The fourth axis ARCHITECTURE.md line 104 keeps separate: whether the
       * evaluator run itself succeeded, failed the candidate, or broke. It is
       * optional and nullable because a record may be written before any
       * evaluator has been run, and an absent value honestly means "no evaluator
       * execution has been recorded" rather than being defaulted to success.
       */
      evaluatorExecution: optionalScalar(enumField(EVALUATOR_EXECUTION_STATUSES)),
      /**
       * Whether this result may carry a score at all, stated separately from
       * the three trust axes so a record can not imply eligibility by wording.
       */
      scoreEligibility: enumField(['ELIGIBLE_NOT_RUN', 'ELIGIBLE_PENDING_HUMAN_REVIEW', 'SCORED', 'INELIGIBLE']),
      stopResult: optionalScalar(enumField(STOP_RESULTS)),
      architectureId: stringField({ minLength: 3 }),
      hashAlgorithm: enumField(HASH_ALGORITHMS),
      bindings: record(resultBindingsSpec),
      quality: record(qualityRecordSpec),
      measurements: field((listPath, list, listState) => {
        if (!Array.isArray(list))
          return push(listState, listPath, 'must be an array of Measurement records', list), [];
        const ids = new Set();
        const presentMetrics = new Set();
        const collected = [];
        list.forEach((entry, index) => {
          const entryPath = listPath + '[' + index + ']';
          const checked = validateMeasurement(entryPath, entry, listState);
          if (typeof checked?.measurementId === 'string') {
            if (ids.has(checked.measurementId))
              push(listState, entryPath, 'duplicate measurementId ' + checked.measurementId);
            ids.add(checked.measurementId);
          }
          if (typeof checked?.metric === 'string' && checked.measurementKind !== 'UNAVAILABLE') {
            if (presentMetrics.has(checked.metric))
              push(listState, entryPath, 'duplicate metric ' + checked.metric);
            presentMetrics.add(checked.metric);
          }
          collected.push(checked);
        });
        return collected;
      }),
      evaluationTrust: field((trustPath, trust, trustState) => {
        if (typeof trust !== 'string')
          push(trustState, trustPath, 'must be one of ' + EVALUATION_TRUSTS.join('|'), trust);
        else if (!EVALUATION_TRUSTS.includes(trust))
          push(
            trustState,
            trustPath,
            'must be one of ' + EVALUATION_TRUSTS.join('|') + '; ' + describe(trust) +
              ' can not be self-issued: no independent review grant or certification exists in this release',
          );
        return trust;
      }),
      evaluationTrustBasis: record(trustBasisSpec),
      humanReview: record(humanReviewSpec),
      declaredTrustChanges: field((listPath, list, listState) => idListField().check(listPath, list, listState),
        { required: false, nullable: true, default: () => [] }),
      limitations: field((listPath, list, listState) => {
        if (!Array.isArray(list))
          return push(listState, listPath, 'must be an array of limitation strings', list), [];
        const collected = [];
        list.forEach((entry, index) => {
          const entryPath = listPath + '[' + index + ']';
          if (typeof entry !== 'string' || entry.trim().length === 0)
            push(listState, entryPath, 'must be a non-empty limitation');
          collected.push(entry);
        });
        return collected;
      }),
      comparability: optionalScalar(enumField([
        'NOT_COMPARABLE',
        'LOCAL_ONLY',
        'DECLARED_CEILING_ONLY',
        'FULL',
      ])),
      historical: booleanField({ required: false, default: false }),
      notes: notesField(),
    },
    state,
  );

  assertTrustCoherence(path, out, state);
  assertScoreCoherence(path, out, state);
  assertMeasurementBindings(path, out, state);
  return out;
}

/**
 * Scoring authority is external to this contract: the 80 automated plus 20
 * human UI split and every arithmetic rule live in the evaluator. What is
 * checked here is only that a result states honestly whether a score may exist
 * at all, so a record can not imply score eligibility by wording.
 */
function assertScoreCoherence(path, result, state) {
  const quality = result.quality ?? {};
  const review = result.humanReview ?? {};
  const eligibility = result.scoreEligibility;
  const scorableRun = !NON_SCORABLE_RUN_STATUSES.includes(result.runStatus);

  if (eligibility === 'SCORED') {
    if (quality.status !== 'SCORED')
      push(state, path + '.quality.status',
        'a SCORED result must report a SCORED quality record rather than ' + quality.status);
    if (!scorableRun)
      push(state, path + '.scoreEligibility',
        'a ' + result.runStatus + ' run is not scorable; report INELIGIBLE');
  } else if (quality.status === 'SCORED')
    push(state, path + '.scoreEligibility',
      'a SCORED quality record must declare scoreEligibility SCORED');

  if (eligibility === 'INELIGIBLE') {
    if (quality.status === 'SCORED')
      push(state, path + '.quality.status', 'an INELIGIBLE result can not be SCORED');
    if (quality.quality != null)
      push(state, path + '.quality.quality', 'an INELIGIBLE result must report a null quality');
  }
  if (eligibility === 'ELIGIBLE_NOT_RUN' && quality.humanUI != null)
    push(state, path + '.quality.humanUI', 'a run that has not been executed can not carry a human component');
  if (quality.status === 'INVALID' && eligibility !== 'INELIGIBLE')
    push(state, path + '.scoreEligibility', 'an INVALID quality record goes with INELIGIBLE');

  /* Final quality exists only for SCORED; omitted optional values honestly
   * project as absent/null, never as a finished numeric score. */
  if (quality.status !== 'SCORED' && quality.quality != null)
    push(state, path + '.quality.quality', 'a non-SCORED quality record must report null final quality');
  if (review.reviewStatus !== 'SCORED' && quality.humanUI != null)
    push(state, path + '.quality.humanUI', 'an unscored human review must report a null human component');

  if (quality.status === 'SCORED') {
    if (result.evaluatorExecution !== 'SUCCESS')
      push(state, path + '.evaluatorExecution', 'a SCORED result requires evaluator execution SUCCESS');
    if (review.reviewStatus !== 'SCORED')
      push(state, path + '.humanReview.reviewStatus', 'a SCORED result requires a SCORED human review');
  }
  /* A numeric human component is a named human act, not a trust upgrade. */
  if ((quality.status === 'SCORED' || quality.humanUI != null) &&
      (typeof review.reviewer !== 'string' || review.reviewer.trim().length === 0))
    push(state, path + '.humanReview.reviewer', 'the human who scored the UI component must be named');
}

/**
 * Assessment trust is bounded by what this release actually implements.
 *
 * ARCHITECTURE.md line 104: a new manual report is a local self-assessment, and
 * "a successful local quality evaluation does not establish governed timing or
 * certification"; line 106 keeps formal governed comparisons "unavailable by
 * default". C1 implements no review grant and no certification mechanism, so the
 * highest trust a record can state is `LOCAL_SELF_ASSESSMENT`, and this
 * function's job is to keep it that way rather than to police a ladder the
 * product does not have.
 *
 * Enforced here:
 *   - a local self-assessment rests on a self-assessment or a local procedure,
 *     never on a digest presented as an external grant, and never on the
 *     recording tooling reviewing itself;
 *   - a historical record stays at `UNTRUSTED_LEGACY`, and only a record marked
 *     historical may carry it;
 *   - a record can not describe its own trust as having been raised.
 *
 * The human-review axis is separate and stays open: a named human may score the
 * optional UI component without that touching assessment trust. Blocking a
 * scored quality record at local trust would make a human UI score
 * unrepresentable at all, because `assertScoreCoherence` requires a review
 * status and a named reviewer exactly when a human component is present, and
 * local self-assessment is the maximum trust available.
 */
function assertTrustCoherence(path, result, state) {
  const trust = result.evaluationTrust;
  const basis = result.evaluationTrustBasis ?? {};
  const review = result.humanReview ?? {};
  const bindings = result.bindings ?? {};

  if (trust === 'LOCAL_SELF_ASSESSMENT') {
    if (!SELF_BASIS_KINDS.includes(basis.basisKind))
      push(state, path + '.evaluationTrustBasis.basisKind',
        'LOCAL_SELF_ASSESSMENT can only rest on a self-assessment or a local procedure');
    if (typeof basis.reviewer === 'string' && basis.reviewer === bindings.toolingId)
      push(state, path + '.evaluationTrustBasis.reviewer', 'the recording tooling can not review itself');
    if (typeof basis.basisDigest === 'string' && basis.basisDigest === bindings.manifestDigest)
      push(state, path + '.evaluationTrustBasis.basisDigest',
        'a self-assessment can not cite the manifest digest as an external grant');
  }

  if (trust === 'UNTRUSTED_LEGACY' && result.historical !== true)
    push(state, path + '.historical', 'must be true for an untrusted historical record');

  if (result.historical === true && trust !== 'UNTRUSTED_LEGACY')
    push(state, path + '.evaluationTrust',
      'a historical record can not be promoted to ' + trust + ' by a reader');

  if (Array.isArray(result.declaredTrustChanges) && result.declaredTrustChanges.length > 0)
    push(state, path + '.declaredTrustChanges',
      'nothing is elevated at ' + trust + '; no review grant or certification is implemented');

  if (review.reviewedAt != null && review.reviewStatus === 'NOT_REVIEWED')
    push(state, path + '.humanReview.reviewedAt', 'is only set together with a review status');

  if (result.quality?.status === 'SCORED') {
    if (!isNonNegative(result.quality.quality))
      push(state, path + '.quality.quality', 'a SCORED result must carry a quality value');
    if (!isNonNegative(result.quality.humanUI))
      push(state, path + '.quality.humanUI', 'a SCORED result needs the human component');
    if (!Array.isArray(result.limitations) || result.limitations.length === 0)
      push(state, path + '.limitations', 'a SCORED result must state the limitations that keep it honest');
  }
  if (result.quality?.status !== 'SCORED' && result.comparability === 'FULL')
    push(state, path + '.comparability', 'a result without a complete score can not be FULL');
  if (result.comparability === 'FULL' && result.historical === true)
    push(state, path + '.comparability', 'a historical record can not be FULL');
  /* Lifecycle and score are separate axes, so a draft that has not been
   * evaluated still can not present a finished quality record. */
  if (result.lifecycle === 'DRAFT' && result.quality?.status === 'SCORED')
    push(state, path + '.lifecycle', 'a DRAFT result can not already be SCORED');
}

/** Measurement sources must point at this result's own bound records. */
function assertMeasurementBindings(path, result, state) {
  const bindings = result.bindings ?? {};
  const boundDigests = new Set(
    [
      bindings.treeDigest,
      bindings.manifestDigest,
      bindings.toolingIdentityDigest,
      bindings.challengeIdentityDigest,
      bindings.evaluatorIdentityDigest,
    ].filter((digest) => typeof digest === 'string'),
  );
  (result.measurements ?? []).forEach((measurement, index) => {
    if (measurement?.measurementKind === 'UNAVAILABLE') return;
    const source = measurement?.source;
    if (!isPlainObject(source)) return;
    const at = path + '.measurements[' + index + '].source';
    if (typeof source.recordId === 'string') {
      const idBinding = {
        RunManifest: 'manifestId',
        FrozenSubmission: 'frozenSubmissionId',
        ToolingIdentity: 'toolingId',
        ChallengeIdentity: 'challengeId',
        EvaluatorIdentity: 'evaluatorId',
      }[source.recordKind];
      if (source.recordKind === 'Result' && source.recordId === result.resultId)
        push(state, at + '.recordId', 'a result can not be the local source of its own measurement');
      else if (idBinding === undefined)
        push(state, at + '.recordKind', 'does not name a record bound by this result');
      else if (source.recordId !== bindings[idBinding])
        push(state, at + '.recordId', 'does not match bindings.' + idBinding);
    }
    if (typeof source.digest === 'string' && !boundDigests.has(source.digest))
      push(state, at + '.digest', 'is not one of the identity digests bound by this result');
    /* Procedure sources may honestly claim no local reference. Discriminated
     * required references and complete companion pairs are checked above by
     * measurementSourceSpec; null can never satisfy either reference kind. */
  });
}

/* ------------------------------------------------------------------------- */
/* Validator registry                                                        */
/* ------------------------------------------------------------------------- */

const VALIDATORS = Object.freeze({
  ToolingIdentity: validateToolingIdentity,
  ChallengeIdentity: validateChallengeIdentity,
  EvaluatorIdentity: validateEvaluatorIdentity,
  RunManifest: validateRunManifest,
  FrozenSubmission: validateFrozenSubmission,
  Measurement: validateMeasurement,
  Result: validateResult,
});

/* ------------------------------------------------------------------------- */
/* createRunManifest                                                         */
/* ------------------------------------------------------------------------- */

const CREATE_MANIFEST_INPUT_KEYS = Object.freeze([
  'manifestId',
  'runId',
  'createdAt',
  'architectureId',
  'architectureKind',
  'harness',
  'securityModel',
  'expectedSessionPolicy',
  'declaredCeilingMinutes',
  'configuration',
  'participantWorkspaceRoot',
  'evidenceRoot',
  'notes',
  'toolingIdentity',
  'challengeIdentity',
  'evaluatorIdentity',
]);

/**
 * Build a sealed RunManifest from the three validated identity records.
 *
 * Each identity is validated with the same validators a consumer uses; every
 * binding field is derived from those validated records so a caller cannot
 * forge a digest or a version; the manifest digest is recomputed over the
 * canonical manifest bytes; and an identity ID collision is refused rather
 * than normalised. Version strings belong to separate identity domains, so
 * equal tooling/challenge/evaluator/candidate version strings are legal;
 * nothing here conflates the domains or reduces their binding to a string.
 *
 * Unknown configuration is preserved as `null` and listed in
 * `configuration.unknownFields`. Nothing is defaulted to zero or an empty string.
 */
export function createRunManifest(input) {
  if (!isPlainObject(input)) throw TypeError('createRunManifest needs an input object');
  const unexpected = Object.keys(input).filter((key) => !CREATE_MANIFEST_INPUT_KEYS.includes(key));
  if (unexpected.length > 0)
    throw Error('createRunManifest received unrecognised input: ' + unexpected.join(', '));

  for (const name of [
    'manifestId', 'runId', 'createdAt', 'architectureId', 'harness', 'participantWorkspaceRoot',
    'evidenceRoot', 'toolingIdentity', 'challengeIdentity', 'evaluatorIdentity',
  ])
    if (input[name] === undefined || input[name] === null)
      throw Error('createRunManifest is missing required input: ' + name);

  const tooling = validateRecord('ToolingIdentity', input.toolingIdentity);
  const challenge = validateRecord('ChallengeIdentity', input.challengeIdentity);
  const evaluator = validateRecord('EvaluatorIdentity', input.evaluatorIdentity);

  const identityDigests = {
    tooling: identityDigestOf(tooling),
    challenge: identityDigestOf(challenge),
    evaluator: identityDigestOf(evaluator),
  };

  for (const [label, architectureId] of [
    ['tooling', tooling.architectureId],
    ['challenge', challenge.architectureId],
    ['evaluator', evaluator.architectureId],
  ])
    if (architectureId === input.architectureId)
      throw Error(
        'createRunManifest: the run architecture must not be the same as the ' + label +
          ' architecture (' + input.architectureId + ')',
      );

  if (tooling.toolingId === challenge.challengeId ||
      challenge.challengeId === evaluator.evaluatorId ||
      tooling.toolingId === evaluator.evaluatorId)
    throw Error('createRunManifest: tooling, challenge and evaluator IDs must be distinct');

  /* No version-domain gate: tooling, challenge, evaluator and candidate
   * versions are separate named domains bound by identity IDs and digests,
   * and equal version strings across those domains are legal. */

  const declared = input.declaredCeilingMinutes ?? null;
  if (declared !== null && challenge.declaredCeilingMinutes !== null &&
      declared > challenge.declaredCeilingMinutes)
    throw Error(
      'createRunManifest: declaredCeilingMinutes exceeds the ceiling bound by the challenge identity',
    );

  const manifest = {
    schemaVersion: NEUTRAL_CONTRACT_VERSION,
    kind: 'RunManifest',
    manifestId: input.manifestId,
    runId: input.runId,
    createdAt: input.createdAt,
    architectureId: input.architectureId,
    /* A caller may name the architecture family it documents; the default is
     * this contract's own family, never a value invented per call site. */
    architectureKind: input.architectureKind ?? 'run',
    hashAlgorithm: 'sha256',
    definitionDigest: definitionDigestOf(identityDigests),
    digestProvenance: {
      kind: 'COMPUTED',
      procedure: 'createRunManifest:sha256:canonical-json',
      inputs: Object.values(identityDigests).sort(),
    },
    bindings: {
      tooling: {
        toolingId: tooling.toolingId,
        toolingVersion: tooling.toolingVersion,
        toolingComponent: tooling.toolingComponent,
        architectureId: tooling.architectureId,
        toolingIdentityDigest: identityDigests.tooling,
        installedDigest: tooling.installedDigest,
        ...(tooling.adapterName === undefined
          ? {}
          : { adapterName: tooling.adapterName, adapterVersion: tooling.adapterVersion ?? null }),
      },
      challenge: {
        challengeId: challenge.challengeId,
        challengeVersion: challenge.challengeVersion,
        architectureId: challenge.architectureId,
        challengeIdentityDigest: identityDigests.challenge,
        workloadDigest: challenge.workloadDigest,
        declaredCeilingMinutes: challenge.declaredCeilingMinutes ?? null,
        candidateVersion: challenge.candidateLineage.candidateVersion,
      },
      evaluator: {
        evaluatorId: evaluator.evaluatorId,
        evaluatorVersion: evaluator.evaluatorVersion,
        architectureId: evaluator.architectureId,
        evaluatorIdentityDigest: identityDigests.evaluator,
        scoringDigest: evaluator.scoringDigest,
        exposure: evaluator.exposure,
      },
    },
    harness: input.harness,
    securityModel: input.securityModel ?? 'UNSPECIFIED',
    ...(input.expectedSessionPolicy === undefined
      ? {}
      : { expectedSessionPolicy: deepClone(input.expectedSessionPolicy) }),
    declaredCeilingMinutes: declared,
    configuration: normaliseConfiguration(input.configuration),
    participantWorkspaceRoot: input.participantWorkspaceRoot,
    evidenceRoot: input.evidenceRoot,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };

  const validated = validateRecord('RunManifest', manifest);
  return deepFreeze({ ...validated, manifestDigest: identityDigestOf(validated) });
}

function definitionDigestOf(identityDigests) {
  const pairs = Object.entries(identityDigests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(canonicalJson(pairs));
}

function normaliseConfiguration(configuration) {
  if (configuration === undefined || configuration === null)
    return {
      unknown: 'UNKNOWN',
      unknownFields: ['harness', 'location', 'model', 'nodeVersion', 'os'],
    };
  if (!isPlainObject(configuration))
    throw TypeError('createRunManifest configuration must be an object or null');
  const out = { unknown: null, unknownFields: [] };
  const unknownFields = [];
  for (const key of ['harness', 'model', 'location', 'os', 'nodeVersion']) {
    if (!Object.hasOwn(configuration, key)) {
      unknownFields.push(key);
      continue;
    }
    const value = configuration[key];
    out[key] = value === null ? null : String(value);
    if (value === null) unknownFields.push(key);
  }
  if (Object.hasOwn(configuration, 'runtimeFlags')) {
    const flags = configuration.runtimeFlags;
    if (flags !== null && !isPlainObject(flags))
      throw TypeError('configuration.runtimeFlags must be an object or null');
    out.runtimeFlags = flags === null ? null : deepClone(flags);
    if (flags === null) unknownFields.push('runtimeFlags');
  }
  const unknown = Object.hasOwn(configuration, 'unknown') ? configuration.unknown : 'UNKNOWN';
  out.unknown = unknown === 'UNKNOWN' || unknown === 'UNSET' ? unknown : null;
  const declaredUnknown = Object.hasOwn(configuration, 'unknownFields')
    ? configuration.unknownFields
    : [];
  if (!Array.isArray(declaredUnknown))
    throw TypeError('configuration.unknownFields must be an array');
  out.unknownFields = [...new Set([...unknownFields, ...declaredUnknown.map(String)])].sort();
  if (out.unknown === null && out.unknownFields.length > 0)
    throw Error(
      'createRunManifest: configuration.unknownFields is only meaningful when unknown is UNKNOWN',
    );
  return out;
}

function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => deepClone(entry));
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = deepClone(child);
  return out;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/* ------------------------------------------------------------------------- */
/* readLegacyResult                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Read a historical result/telemetry record.
 *
 * The recognised historical shapes are `1.0`, `1.1` and `1.2` — the raw
 * telemetry/result documents the historical benchmark emitted (whose run
 * object carries its own outcome statements) and the emitted telemetry
 * projections derived from them (numeric quality and top-level
 * authority/outcome flags beside `run`). The reader is explicit rather than
 * best-effort: unrecognised data is refused, and recognised data comes back
 * inside a marked legacy envelope whose `sourceRecord` is the source payload
 * verbatim. The outcome-bearing object the shape actually emitted is preserved
 * verbatim as `preservedOutcome` (the whole projection document for an emitted
 * projection, the inner metrics or run object otherwise), so historical
 * outcomes — including positive validity, eligibility, authority and
 * execution-binding statements the source recorded — stay exactly as written.
 * Only missing required fields, unknown shapes and malformed flag types at
 * their real locations are refused.
 *
 * Trust is clamped to `LEGACY_TRUST_CEILING` and the envelope is always
 * unbound, non-promoting and not formal-comparison eligible: a historical
 * record can never become a current official, reviewed or certified outcome,
 * whatever its source says about itself.
 */
export function readLegacyResult(value) {
  if (!isPlainObject(value))
    throw new ContractValidationError('$', 'a legacy result must be an object', value);
  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion !== 'string' || !LEGACY_RESULT_SCHEMA_VERSIONS.includes(schemaVersion))
    throw new ContractValidationError(
      '$.schemaVersion',
      'is not a recognised historical result schema (expected 1.0, 1.1 or 1.2); ' +
        'unknown data is not read as history',
      schemaVersion,
    );

  const isTelemetryShape = Object.hasOwn(value, 'run');
  const run = isTelemetryShape ? value.run : value;
  if (!isPlainObject(run))
    throw new ContractValidationError('$.run', 'a legacy record needs a run object', run);

  const problems = [];
  const requiredBySchema = {
    '1.0': ['runId', 'benchmarkVersion', 'startedAt'],
    '1.1': ['runId', 'benchmarkVersion', 'startedAt', 'deadlineAt', 'observationEndedAt', 'stopResult'],
    '1.2': ['runId', 'benchmarkVersion', 'startedAt', 'deadlineAt', 'observationEndedAt',
      'stopResult', 'timeCeilingMinutes', 'terminationOutcome'],
  };
  for (const key of requiredBySchema[schemaVersion])
    if (!Object.hasOwn(run, key)) problems.push('missing run.' + key);

  if (Object.hasOwn(run, 'status') && !RUN_STATUSES.includes(run.status))
    problems.push('unknown historical run status ' + describe(run.status));
  if (Object.hasOwn(run, 'stopResult') && run.stopResult !== null &&
      !STOP_RESULTS.includes(run.stopResult))
    problems.push('unknown historical stop result ' + describe(run.stopResult));
  if (Object.hasOwn(run, 'timeCeilingMinutes') && run.timeCeilingMinutes !== null &&
      (!isInt(run.timeCeilingMinutes) || run.timeCeilingMinutes < 1 || run.timeCeilingMinutes > 1440))
    problems.push('timeCeilingMinutes is outside 1..1440');
  if (Object.hasOwn(run, 'terminationOutcome') && run.terminationOutcome !== null &&
      typeof run.terminationOutcome !== 'string')
    problems.push('terminationOutcome must be a string or null');

  /* Outcome and authority flags are historical source statements wherever the
   * historical shapes actually carried them. The authentic emitted telemetry
   * projection carries numeric quality and top-level authority/outcome flags
   * beside `run`; earlier result records carried them inside `run` or inside a
   * nested metrics object. Every such statement is type-checked at the
   * location that actually holds it and then preserved verbatim; its truth can
   * not promote the record — the envelope keeps the trust ceiling, the
   * UNBOUND_HISTORICAL binding status and the not-eligible comparison state
   * regardless of what the source claims — so a well-typed historical flag is
   * retained exactly as written instead of being refused for saying something
   * this reader can not certify. */
  const seenContainers = new Set([value]);
  for (const [label, container] of [['$', value], ['metrics', value.metrics],
    ['run', isTelemetryShape ? value.run : value]]) {
    if (!isPlainObject(container) || seenContainers.has(container) &&
        label !== '$') continue;
    seenContainers.add(container);
    const at = label === '$' ? '$' : '$.' + label;
    if (Object.hasOwn(container, 'quality') && container.quality !== null &&
        !Number.isFinite(container.quality))
      problems.push(at + '.quality must be a finite number or null');
    for (const flag of [...LEGACY_OUTCOME_FLAG_FIELDS, ...LEGACY_AUTHORITY_FLAG_FIELDS])
      if (Object.hasOwn(container, flag) && typeof container[flag] !== 'boolean')
        problems.push(at + '.' + flag + ' must be a boolean');
    for (const flag of LEGACY_NULLABLE_FLAG_FIELDS)
      if (Object.hasOwn(container, flag) && container[flag] !== null &&
          typeof container[flag] !== 'boolean')
        problems.push(at + '.' + flag + ' must be a boolean or null');
    /* The preserved execution identifier is type-checked at every location it
     * is actually carried: inside the run object (raw telemetry) and at top
     * level (the emitted projection). It remains a historical statement that
     * binds nothing. */
    if (Object.hasOwn(container, 'executionId') && container.executionId !== null &&
        typeof container.executionId !== 'string')
      problems.push(at + '.executionId must be a string or null');
  }

  if (problems.length > 0)
    throw Error('Unreadable historical ' + schemaVersion + ' result:\n  - ' + problems.join('\n  - '));

  /* The outcome object the envelope preserves verbatim. For the authentic
   * emitted telemetry projection — numeric quality and top-level
   * authority/outcome flags beside `run` — that is the whole projection
   * document; for earlier nested shapes it is the inner metrics object or the
   * run object itself. */
  const outcome = legacyOutcomeOf(value);
  return Object.freeze({
    [LEGACY_ENVELOPE_MARKER]: true,
    legacyReaderVersion: NEUTRAL_CONTRACT_VERSION,
    recognizedSchemaVersion: schemaVersion,
    legacyShape: isTelemetryShape ? 'telemetry' : 'result',
    bindingStatus: 'UNBOUND_HISTORICAL',
    trust: { ...LEGACY_TRUST_CEILING },
    eligibility: 'NOT_FORMAL_COMPARISON_ELIGIBLE',
    promotionAllowed: false,
    outcomePreservation: 'VERBATIM',
    preservedOutcome: outcome === undefined ? null : deepClone(outcome),
    /* The untouched source payload. */
    [LEGACY_SOURCE_FIELD]: deepClone(value),
  });
}

/**
 * The outcome fields the supported historical shapes record. The four outcome
 * flags and the three strict authority flags are booleans wherever present;
 * the projection-computed booleans may be `null` where the historical record
 * genuinely did not know (e.g. a 1.0 record has no stop proof).
 */
const LEGACY_OUTCOME_FLAG_FIELDS = Object.freeze([
  'validOutcome',
  'officialOutcomeValid',
  'officialOutcomeEligible',
  'currentExecutionBound',
]);
const LEGACY_AUTHORITY_FLAG_FIELDS = Object.freeze([
  'official',
  'eligibleForFormalComparison',
  'eligibleForCalibrationAcceptance',
]);
const LEGACY_NULLABLE_FLAG_FIELDS = Object.freeze([
  'supervisionValid',
  'terminationProven',
  'stopConfirmed',
]);

/**
 * Select the outcome-bearing object of a legacy record from the locations the
 * supported historical shapes actually emitted, in priority order:
 *
 *   1. an authentic emitted telemetry projection: numeric quality and top-level
 *      authority/outcome fields sit beside `run` in one document, so the whole
 *      document is the outcome and is preserved verbatim;
 *   2. a nested metrics object (an earlier result shape that recorded its
 *      outcome there);
 *   3. a nested quality object;
 *   4. the run object itself (raw telemetry, where the run carries its own
 *      outcome statements);
 *   5. the record itself when it carries an outcome flag at top level.
 *
 * Every recognised location's fields are type-checked by the reader no matter
 * which object is selected, so a malformed flag is refused at its real
 * location instead of being silently skipped by a wrong outcome guess.
 */
function legacyOutcomeOf(value) {
  const hasTopLevelOutcomeField = Object.hasOwn(value, 'quality') ||
    [...LEGACY_OUTCOME_FLAG_FIELDS, ...LEGACY_AUTHORITY_FLAG_FIELDS,
      ...LEGACY_NULLABLE_FLAG_FIELDS, 'outcomeClass'].some((flag) =>
      Object.hasOwn(value, flag));
  if (hasTopLevelOutcomeField) return value;
  if (isPlainObject(value.metrics)) return value.metrics;
  if (isPlainObject(value.quality)) return value.quality;
  if (isPlainObject(value.run)) return value.run;
  if (Object.hasOwn(value, 'validOutcome')) return value;
  return undefined;
}

/**
 * True only for an envelope produced by `readLegacyResult`. A consumer may read
 * the preserved outcome but must treat the clamped trust ceiling as binding.
 */
export function isLegacyEnvelope(value) {
  return (
    isPlainObject(value) &&
    value[LEGACY_ENVELOPE_MARKER] === true &&
    typeof value.recognizedSchemaVersion === 'string' &&
    LEGACY_RESULT_SCHEMA_VERSIONS.includes(value.recognizedSchemaVersion) &&
    value.promotionAllowed === false
  );
}
