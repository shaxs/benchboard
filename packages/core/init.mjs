/**
 * BenchBoard run initialisation — one container transaction (C2 / T3).
 *
 * `init()` turns an explicitly supplied challenge package, an explicitly
 * declared dependency mode and explicitly supplied identity records into a
 * published, complete run container plus the sealed C1 `RunManifest` that
 * describes it. It is the composition seam the C2 contract names:
 *
 *   - the T1 exporter (`exportChallenge`) publishes the participant workspace;
 *   - the T2 dependency helper (`prepareDependencies`) prepares dependencies;
 *   - the accepted C1 contract layer (`validateRecord`, `createRunManifest`,
 *     `createStorage`) validates and seals the run state.
 *
 * Nothing here re-implements those modules, and nothing here introduces an
 * alternative run manifest: the returned value is the accepted
 * `createRunManifest()` result, read back through the accepted storage layer
 * and revalidated with `validateRecord('RunManifest', …)`.
 *
 * Container layout (a sibling state root is what keeps the C1 invariant
 * "participant workspace and evidence root are disjoint" true):
 *
 *   <output>/workspace     the published participant workspace — exactly the
 *                          declared workload files, plus, for a mode that
 *                          prepares them, the ordinary dependency files under
 *                          `node_modules`
 *   <output>/.benchboard   the run state root, OUTSIDE the workspace: the sealed
 *                          run record, the separately hashed dependency
 *                          companion, the export proof, and the dependency
 *                          metadata the T2 helper wrote
 *
 * The transaction is one unit: validate the request → reserve the output
 * exclusively → export the workspace → verify the exported workspace again →
 * prepare dependencies → write the state records → prove the container is
 * complete → read every state record back and verify the workspace again. On
 * any failure, on an interruption signalled by a hook, and when the output
 * cannot be reserved because a concurrent writer got there first, only material
 * this call provably created is removed and nothing foreign is touched; a
 * failure never returns a success value and no success is claimed before every
 * proof has been made.
 *
 * Trust boundary (frozen by the C2 Captain contract):
 *  - every root is an explicit absolute host path. There is no configuration,
 *    environment, DSH, `runner/`, project-root or current-directory fallback
 *    anywhere in this module, and no version, model, provider, harness,
 *    security model or session policy is inferred — an unknown value stays
 *    `null`/`UNKNOWN` (never zero) and is declared unknown;
 *  - roots are compared lexically at separator boundaries: the output may not
 *    equal, contain or sit inside the source, an owner root, an evaluator root
 *    or any dependency root, and the state root may not sit inside the
 *    participant workspace;
 *  - published bytes are proven by the exporter and, for dependency material,
 *    by the dependency helper; this module adds the containment, layout and
 *    overlap gates plus the final read-back verification rather than a second,
 *    weaker copy of their proofs;
 *  - two hash domains are kept apart: the workload tree digest is
 *    `benchboard-sha256-tree-v1` and a dependency digest is
 *    `benchboard-dependency-tree-v1`. Neither value is accepted in the other's
 *    role;
 *  - no Git mutation, no lifecycle/start/stop work and no evaluation happens
 *    here: a run is initialised, never started.
 *
 * Node builtins plus the accepted C1/C2 modules only.
 */

import fs from 'node:fs';
import path from 'node:path';

import { createId, inventoryTree, hashEntries, sha256 } from './identity.mjs';
import { validateRecord, createRunManifest, SECURITY_MODELS } from './manifest.mjs';
import { createStorage } from './storage.mjs';
import { exportChallenge, EXPECTED_WORKLOAD_FILE_COUNT } from './challenge-export.mjs';
import { prepareDependencies } from './dependencies.mjs';

/* -------------------------------------------------------------------------- */
/* Contract constants                                                          */
/* -------------------------------------------------------------------------- */

/** Machine-readable, stable refusal codes. Every refusal carries exactly one. */
export const INIT_ERROR_CODES = Object.freeze({
  /** The request object itself is missing or not a plain object. */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  /** An option has the wrong type or an unrecognised shape. */
  INVALID_OPTION: 'INVALID_OPTION',
  /** An option the contract requires was not supplied. */
  OPTION_REQUIRED: 'OPTION_REQUIRED',
  /** A root was not an absolute host path. */
  INVALID_ROOT: 'INVALID_ROOT',
  /** An explicit root does not exist or is not a directory. */
  ROOT_NOT_FOUND: 'ROOT_NOT_FOUND',
  /** A path component is a symbolic link or a special file. */
  LINK_OR_SPECIAL: 'LINK_OR_SPECIAL',
  /** An output would equal, contain or sit inside a protected or owned root. */
  ROOTS_OVERLAP: 'ROOTS_OVERLAP',
  /** The dependency mode is not one of the three declared modes. */
  DEPENDENCY_MODE_INVALID: 'DEPENDENCY_MODE_INVALID',
  /** Dependency options do not match the declared mode. */
  DEPENDENCY_MODE_MISMATCH: 'DEPENDENCY_MODE_MISMATCH',
  /** A supplied identity record failed the accepted contract validation. */
  IDENTITY_INVALID: 'IDENTITY_INVALID',
  /** A run architecture or an identity identifier collides with another. */
  IDENTITY_COLLISION: 'IDENTITY_COLLISION',
  /** A ceiling exceeds the ceiling the challenge identity binds. */
  CEILING_EXCEEDED: 'CEILING_EXCEEDED',
  /** A version or identity domain was conflated (a digest used in the wrong role). */
  DOMAIN_CONFLATION: 'DOMAIN_CONFLATION',
  /** The output already exists, or a concurrent writer reserved it first. */
  OUTPUT_EXISTS: 'OUTPUT_EXISTS',
  /** The output parent is missing, is a file, or refused an exclusive create. */
  OUTPUT_UNUSABLE: 'OUTPUT_UNUSABLE',
  /** A published container failed the read-back verification. */
  PUBLICATION_INVALID: 'PUBLICATION_INVALID',
  /** A state record could not be written, published or read back. */
  STATE_WRITE_FAILED: 'STATE_WRITE_FAILED',
  /** An accepted dependency returned a shape this seam cannot record. */
  DEPENDENCY_RESULT_INVALID: 'DEPENDENCY_RESULT_INVALID',
  /** Rollback completed; the material this call created is gone again. */
  INIT_FAILED_ROLLED_BACK: 'INIT_FAILED_ROLLED_BACK',
  /** Material this call created could not be removed; it is disclosed, not destroyed. */
  CLEANUP_FAILED: 'CLEANUP_FAILED',
  /** A failure this module cannot attribute to a named refusal. */
  INTERNAL: 'INTERNAL',
});

/** Stable identifier of this module, recorded in the state records. */
export const INIT_MODULE_ID = 'benchboard.core.init';

/** Schema version of the run-initialisation state records. */
export const INIT_STATE_SCHEMA_VERSION = '1.0.0';

/** Storage identity kind of the run-initialisation state records. */
export const INIT_STATE_KIND = 'benchboard:run-initialisation';

/** Layout of one published container. */
export const WORKSPACE_DIRECTORY_NAME = 'workspace';
export const STATE_DIRECTORY_NAME = '.benchboard';
export const DEPENDENCIES_DIRECTORY_NAME = 'dependencies';
export const RUN_STATE_RELATIVE_PATH = 'state/run.json';
export const DEPENDENCY_STATE_RELATIVE_PATH = 'state/dependencies.json';
export const EXPORT_STATE_RELATIVE_PATH = 'state/export.json';

/** The two hash domains that must never be used in each other's role. */
export const WORKLOAD_HASH_ALGORITHM_ID = 'benchboard-sha256-tree-v1';
export const DEPENDENCY_HASH_ALGORITHM_ID = 'benchboard-dependency-tree-v1';

/** File name the accepted T2 helper uses for its own metadata record. */
export const DEPENDENCIES_METADATA_FILE_NAME = '.benchboard-dependencies.json';

/** The three modes the accepted dependency helper declares. Never inferred. */
export const DEPENDENCY_MODES = Object.freeze(['none', 'prepared', 'install']);

/**
 * The security models the accepted contract binds, re-exported from that
 * contract rather than restated here: a list this module maintained on its own
 * would eventually disagree with the validator that judges the same field.
 * Nothing is inferred; the only default is `UNSPECIFIED`.
 */
export const INIT_SECURITY_MODELS = SECURITY_MODELS;

const CHALLENGE_PACKAGE_KEYS = Object.freeze([
  'identity',
  'sourceRoot',
  'fileManifest',
  'ownerRoots',
  'evaluatorRoots',
]);

const INIT_REQUEST_KEYS = Object.freeze([
  'output',
  'challenge',
  'dependencies',
  'toolingIdentity',
  'evaluatorIdentity',
  'architectureId',
  'architectureKind',
  'harness',
  'securityModel',
  'expectedSessionPolicy',
  'declaredCeilingMinutes',
  'configuration',
  'notes',
  'createdAt',
  'beforeWorkspacePublication',
  'beforeStatePublication',
]);

const DEPENDENCY_REQUEST_KEYS = Object.freeze([
  'mode',
  'preparedRoot',
  'sourceRoot',
  'scratchRoot',
  'expectedDependencyDigest',
  'npmExecutable',
  'offline',
  'npmArgumentsPrefix',
  'npmArgumentsSuffix',
  'processAdapter',
  'maxEntries',
  'maxFileBytes',
  'maxTotalBytes',
  'timeoutMs',
]);

/** Options the accepted helper refuses for a mode, mirrored as a local gate. */
const MODE_FORBIDDEN_OPTIONS = Object.freeze({
  none: Object.freeze(['preparedRoot', 'sourceRoot', 'scratchRoot', 'npmExecutable', 'expectedDependencyDigest', 'offline', 'timeoutMs', 'processAdapter', 'maxEntries', 'maxFileBytes', 'maxTotalBytes']),
  prepared: Object.freeze(['npmExecutable', 'scratchRoot', 'processAdapter', 'npmArgumentsPrefix', 'npmArgumentsSuffix', 'timeoutMs', 'offline']),
  install: Object.freeze(['preparedRoot']),
});

/** Explicit absolute-root prefix; absoluteRoot also requires a supported native spelling. */
const HOST_ROOT_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

const HEX64 = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;

const DEFAULT_ARCHITECTURE_KIND = 'run';
const DEFAULT_NOTES = 'Initialised by packages/core/init.mjs (C2 T3); the run is initialised, not started.';

/* -------------------------------------------------------------------------- */
/* Error                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Typed initialisation error. Every refusal this module raises on its own
 * account is an `InitError` carrying one of `INIT_ERROR_CODES`. On the
 * rollback path an inherited foreign error is rethrown with the rollback
 * outcome attached to it, so the reason a run did not initialise stays visible
 * instead of being replaced by this module's own wrapper.
 */
export class InitError extends Error {
  /**
   * @param {string} code one of `INIT_ERROR_CODES`
   * @param {string} message human-readable reason
   * @param {{ path?: string, cause?: unknown, [key: string]: unknown }} [details]
   */
  constructor(code, message, details = {}) {
    if (typeof code !== 'string' || code.length === 0)
      throw new TypeError('InitError requires a stable code.');
    if (typeof message !== 'string' || message.length === 0)
      throw new TypeError('InitError requires a message.');
    const { path: failedPath, cause, ...rest } = details;
    super(`${code}: ${message}`);
    this.name = 'InitError';
    this.code = code;
    if (failedPath !== void 0) this.path = failedPath;
    if (cause !== void 0) this.cause = cause;
    for (const [key, value] of Object.entries(rest)) this[key] = value;
    Object.setPrototypeOf(this, InitError.prototype);
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Initialise one run container and return its sealed run manifest.
 *
 * The signature is the one the C2 contract fixes: the output, the challenge
 * package, the dependency mode and the identity inputs are all supplied by the
 * caller; unique ids come from the accepted `createId`; `createdAt` is observed
 * at the call and no start or stop clock is read.
 *
 * @param {InitRequest} request every root explicit and absolute; nothing is inferred
 * @returns {Promise<SealedRunManifest>} the accepted sealed `RunManifest`
 */
export async function init(request) {
  const result = await initialiseRun(request);
  return result.manifest;
}

/**
 * The same single transaction as `init()`, returning the whole result record:
 * the sealed manifest plus the container layout, the two domain digests and
 * the state-record identities. A caller that only needs the manifest uses
 * `init()`; this seam never recomputes or re-derives anything.
 *
 * @param {InitRequest} request the same request object `init()` takes
 * @returns {Promise<InitResult>} the frozen result record
 */
export async function initialiseRun(request) {
  const operation = beginOperation(request);
  let failure = null;
  try {
    await runTransaction(operation);
  } catch (error) {
    failure = error;
  }
  if (failure === null) return operation.result;
  return await finishFailed(operation, failure);
}

/* -------------------------------------------------------------------------- */
/* Request validation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Validate the whole request and build the sealed manifest value that the
 * transaction will persist, before a single byte is written.
 *
 * @param {InitRequest} request
 * @returns {object} the operation record
 */
function beginOperation(request) {
  if (!isPlainObject(request))
    throw new InitError(INIT_ERROR_CODES.INVALID_ARGUMENT,
      'init({ output, challenge, dependencies, toolingIdentity, evaluatorIdentity, architectureId, … }) needs one request object.');

  rejectUnknownKeys(request, INIT_REQUEST_KEYS, 'the init request');

  const output = absoluteRoot(request.output, 'output');
  const challengePackage = validateChallengePackage(request.challenge);
  const dependencies = validateDependencyRequest(request.dependencies);
  const workspaceRoot = path.join(output, WORKSPACE_DIRECTORY_NAME);
  const stateRoot = path.join(output, STATE_DIRECTORY_NAME);

  /* The identity records are validated by the accepted contract validator
   * first, so a malformed identity costs nothing and cannot be blamed on the
   * filesystem. */
  const tooling = validatedIdentity('ToolingIdentity', request.toolingIdentity);
  const evaluator = validatedIdentity('EvaluatorIdentity', request.evaluatorIdentity);
  const challenge = validatedIdentity('ChallengeIdentity', challengePackage.identity);

  const architectureId = requiredString(request.architectureId, 'architectureId');
  if (!ID_PATTERN.test(architectureId))
    throw new InitError(INIT_ERROR_CODES.INVALID_OPTION,
      'architectureId must be a stable identifier of 3 to 128 characters.',
      { path: architectureId });

  /* A run is its own architecture domain: reusing a bound architecture would
   * let one record stand in for two identity domains. */
  for (const [label, identity] of [['tooling', tooling], ['challenge', challenge], ['evaluator', evaluator]])
    if (identity.architectureId === architectureId)
      throw new InitError(INIT_ERROR_CODES.IDENTITY_COLLISION,
        `the run architectureId must not be the ${label} identity architectureId (${architectureId}).`);
  if (tooling.toolingId === challenge.challengeId ||
      challenge.challengeId === evaluator.evaluatorId ||
      tooling.toolingId === evaluator.evaluatorId)
    throw new InitError(INIT_ERROR_CODES.IDENTITY_COLLISION,
      'the tooling, challenge and evaluator identifiers must be distinct; each identity domain is bound by its own identifier.');

  const ceiling = explicitCeiling(request.declaredCeilingMinutes, challenge);
  const securityModel = explicitSecurityModel(request.securityModel);
  const harness = explicitHarness(request.harness);
  const createdAt = explicitCreatedAt(request.createdAt);
  const configuration = explicitConfiguration(request.configuration);
  const architectureKind = optionalString(request.architectureKind, 'architectureKind') ?? DEFAULT_ARCHITECTURE_KIND;
  const notes = optionalString(request.notes, 'notes') ?? DEFAULT_NOTES;
  const expectedSessionPolicy = explicitStringMap(request.expectedSessionPolicy);

  /* Roots are compared before anything is created: the container may not
   * touch the source, the owner boundary, the evaluator boundary or any root
   * the dependency helper reads from or writes into. */
  const protectedRoots = [
    { label: 'the challenge sourceRoot', root: challengePackage.sourceRoot },
    ...challengePackage.ownerRoots.map((root, index) => ({ label: `challenge ownerRoots[${index}]`, root })),
    ...challengePackage.evaluatorRoots.map((root, index) => ({ label: `challenge evaluatorRoots[${index}]`, root })),
    ...dependencies.protectedRoots,
  ];
  for (const protectedRoot of protectedRoots) {
    assertApart(output, 'output', protectedRoot.root, protectedRoot.label);
    assertNoCaseCollision(output, 'output', protectedRoot.root, protectedRoot.label);
  }

  /* The manifest is created up front so that a record this run cannot honestly
   * state is refused before any byte is written. The two roots it names are the
   * FINAL container roots, never a staging path: the workspace is published
   * directly into its final place and the state lives in the sibling root. */
  const manifest = createRunManifest({
    manifestId: createId({ prefix: 'manifest' }),
    runId: createId({ prefix: 'run' }),
    createdAt,
    architectureId,
    architectureKind,
    harness,
    securityModel,
    ...(expectedSessionPolicy === void 0 ? {} : { expectedSessionPolicy }),
    ...(ceiling === void 0 ? {} : { declaredCeilingMinutes: ceiling }),
    ...(configuration === void 0 ? {} : { configuration }),
    participantWorkspaceRoot: workspaceRoot,
    evidenceRoot: stateRoot,
    notes,
    toolingIdentity: tooling,
    challengeIdentity: challenge,
    evaluatorIdentity: evaluator,
  });

  return {
    /* request, validated */
    output,
    challenge: challengePackage,
    dependencies,
    manifest,
    hooks: {
      beforeWorkspacePublication: asHook(request.beforeWorkspacePublication, 'beforeWorkspacePublication'),
      beforeStatePublication: asHook(request.beforeStatePublication, 'beforeStatePublication'),
    },
    /* ownership flags: what this call may remove again */
    outputOwned: false,
    stateRootCreated: false,
    /* proven during the transaction */
    workspaceRoot,
    stateRoot,
    dependenciesDirectory: path.join(stateRoot, DEPENDENCIES_DIRECTORY_NAME),
    dependenciesMetadataPath: path.join(stateRoot, DEPENDENCIES_DIRECTORY_NAME, DEPENDENCIES_METADATA_FILE_NAME),
    export: null,
    workspaceInventory: null,
    dependencyRecord: null,
    dependencyDigest: null,
    publications: null,
    storage: null,
    result: null,
    startedAt: Date.now(),
  };
}

function validateChallengePackage(value) {
  if (!isPlainObject(value))
    throw new InitError(INIT_ERROR_CODES.INVALID_ARGUMENT,
      'challenge must be a package record { identity, sourceRoot, fileManifest, ownerRoots, evaluatorRoots }; the package is supplied explicitly and no default owner discovery is performed.');
  rejectUnknownKeys(value, CHALLENGE_PACKAGE_KEYS, 'the challenge package');
  for (const key of CHALLENGE_PACKAGE_KEYS)
    if (value[key] === void 0 || value[key] === null)
      throw new InitError(INIT_ERROR_CODES.OPTION_REQUIRED,
        `challenge.${key} is required.`);

  const sourceRoot = absoluteRoot(value.sourceRoot, 'challenge.sourceRoot');
  const rawManifest = stringList(value.fileManifest, 'challenge.fileManifest');
  for (const entry of rawManifest)
    if (entry.length === 0 || entry.includes('\\') || entry.startsWith('/') ||
        entry.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..'))
      throw new InitError(INIT_ERROR_CODES.INVALID_OPTION,
        `challenge.fileManifest entries must be relative POSIX file paths, got ${JSON.stringify(entry)}.`);
  const ownerRoots = Object.freeze(absoluteList(value.ownerRoots, 'challenge.ownerRoots'));
  const evaluatorRoots = Object.freeze(absoluteList(value.evaluatorRoots, 'challenge.evaluatorRoots'));
  if (ownerRoots.length === 0)
    throw new InitError(INIT_ERROR_CODES.OPTION_REQUIRED,
      'challenge.ownerRoots must name at least one protected owner root.');
  if (evaluatorRoots.length === 0)
    throw new InitError(INIT_ERROR_CODES.OPTION_REQUIRED,
      'challenge.evaluatorRoots must name at least one protected evaluator root.');

  return {
    identity: value.identity,
    sourceRoot,
    fileManifest: Object.freeze([...new Set(rawManifest)].sort(compareLexical)),
    ownerRoots,
    evaluatorRoots,
  };
}

function validateDependencyRequest(value) {
  if (!isPlainObject(value))
    throw new InitError(INIT_ERROR_CODES.INVALID_ARGUMENT,
      'dependencies must be a request object naming its mode { mode: "none" | "prepared" | "install", … }; the mode is declared and is never inferred.');
  rejectUnknownKeys(value, DEPENDENCY_REQUEST_KEYS, 'the dependencies request');

  const mode = value.mode;
  if (typeof mode !== 'string' || !DEPENDENCY_MODES.includes(mode))
    throw new InitError(INIT_ERROR_CODES.DEPENDENCY_MODE_INVALID,
      `dependencies.mode must be exactly one of ${DEPENDENCY_MODES.join(', ')}; got ${JSON.stringify(mode)}.`);

  for (const forbidden of MODE_FORBIDDEN_OPTIONS[mode])
    if (value[forbidden] !== void 0)
      throw new InitError(INIT_ERROR_CODES.DEPENDENCY_MODE_MISMATCH,
        `dependencies.${forbidden} is not accepted for mode ${JSON.stringify(mode)}.`);

  const declared = { mode };
  const protectedRoots = [];
  const noteRoot = (label, root) => protectedRoots.push({ label, root });

  if (mode === 'prepared') {
    declared.preparedRoot = absoluteRoot(value.preparedRoot, 'dependencies.preparedRoot',
      INIT_ERROR_CODES.DEPENDENCY_MODE_MISMATCH);
    noteRoot('dependencies.preparedRoot', declared.preparedRoot);
    if (value.sourceRoot !== void 0) {
      declared.sourceRoot = absoluteRoot(value.sourceRoot, 'dependencies.sourceRoot',
        INIT_ERROR_CODES.DEPENDENCY_MODE_MISMATCH);
      noteRoot('dependencies.sourceRoot', declared.sourceRoot);
    }
  }
  if (mode === 'install') {
    declared.npmExecutable = absoluteRoot(value.npmExecutable, 'dependencies.npmExecutable',
      INIT_ERROR_CODES.DEPENDENCY_MODE_MISMATCH);
    if (value.sourceRoot !== void 0) {
      declared.sourceRoot = absoluteRoot(value.sourceRoot, 'dependencies.sourceRoot',
        INIT_ERROR_CODES.DEPENDENCY_MODE_MISMATCH);
      noteRoot('dependencies.sourceRoot', declared.sourceRoot);
    }
    if (value.scratchRoot !== void 0) {
      declared.scratchRoot = absoluteRoot(value.scratchRoot, 'dependencies.scratchRoot',
        INIT_ERROR_CODES.DEPENDENCY_MODE_MISMATCH);
      noteRoot('dependencies.scratchRoot', declared.scratchRoot);
    }
    if (value.npmArgumentsPrefix !== void 0)
      declared.npmArgumentsPrefix = Object.freeze(stringList(value.npmArgumentsPrefix, 'dependencies.npmArgumentsPrefix'));
    if (value.npmArgumentsSuffix !== void 0)
      declared.npmArgumentsSuffix = Object.freeze(stringList(value.npmArgumentsSuffix, 'dependencies.npmArgumentsSuffix'));
    if (value.processAdapter !== void 0) {
      if (typeof value.processAdapter !== 'function')
        throw new InitError(INIT_ERROR_CODES.INVALID_OPTION,
          'dependencies.processAdapter must be a function when it is supplied.');
      declared.processAdapter = value.processAdapter;
    }
  }
  if (value.expectedDependencyDigest !== void 0) {
    const digest = value.expectedDependencyDigest;
    if (typeof digest !== 'string' || !HEX64.test(digest))
      throw new InitError(INIT_ERROR_CODES.INVALID_OPTION,
        'dependencies.expectedDependencyDigest must be 64 lowercase hex characters of the dependency domain.');
    declared.expectedDependencyDigest = digest;
  }
  if (value.offline !== void 0) {
    if (typeof value.offline !== 'boolean')
      throw new InitError(INIT_ERROR_CODES.INVALID_OPTION, 'dependencies.offline must be a boolean.');
    declared.offline = value.offline;
  }
  for (const key of ['maxEntries', 'maxFileBytes', 'maxTotalBytes', 'timeoutMs'])
    if (value[key] !== void 0) {
      if (!Number.isInteger(value[key]) || value[key] < 1)
        throw new InitError(INIT_ERROR_CODES.INVALID_OPTION,
          `dependencies.${key} must be a positive whole number.`);
      declared[key] = value[key];
    }

  return Object.freeze({ ...declared, protectedRoots: Object.freeze(protectedRoots) });
}

function validatedIdentity(kind, value) {
  try {
    return validateRecord(kind, value);
  } catch (error) {
    throw new InitError(INIT_ERROR_CODES.IDENTITY_INVALID,
      `the supplied ${kind} record was refused by the accepted contract validator: ${error?.message ?? String(error)}`,
      { identityKind: kind, cause: error?.message });
  }
}

/**
 * The ceiling is caller-declared and is never raised to the challenge ceiling:
 * an unknown ceiling stays unknown instead of silently becoming a number.
 */
function explicitCeiling(value, challenge) {
  if (value === void 0 || value === null) return void 0;
  if (!Number.isInteger(value) || value < 1)
    throw new InitError(INIT_ERROR_CODES.INVALID_OPTION,
      'declaredCeilingMinutes must be a positive whole number of minutes when it is supplied.');
  if (Number.isInteger(challenge.declaredCeilingMinutes) && value > challenge.declaredCeilingMinutes)
    throw new InitError(INIT_ERROR_CODES.CEILING_EXCEEDED,
      `the run ceiling ${value} exceeds the ${challenge.declaredCeilingMinutes} minute ceiling bound by the challenge identity.`);
  return value;
}

function explicitSecurityModel(value) {
  if (value === void 0 || value === null) return 'UNSPECIFIED';
  if (typeof value !== 'string' || !SECURITY_MODELS.includes(value))
    throw new InitError(INIT_ERROR_CODES.INVALID_OPTION,
      `securityModel must be one of ${SECURITY_MODELS.join(', ')}; got ${JSON.stringify(value)}. No security model is inferred.`);
  return value;
}

/**
 * The harness is a required field of the accepted manifest, so an unknown
 * harness is stated explicitly as `UNKNOWN` instead of being discovered from
 * the environment, from DSH or from a configuration file.
 */
function explicitHarness(value) {
  if (value === void 0 || value === null) return 'UNKNOWN';
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new InitError(INIT_ERROR_CODES.INVALID_OPTION,
      'harness must be a non-empty string, or omitted so that it is recorded as UNKNOWN.');
  return value;
}

/**
 * `createdAt` is observed at the call. It is never taken from a run directory,
 * a persisted record or a clock file, and no start or stop time is read here;
 * an explicit value must be a real timestamp.
 */
function explicitCreatedAt(value) {
  if (value === void 0 || value === null) return new Date().toISOString();
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value)))
    throw new InitError(INIT_ERROR_CODES.INVALID_OPTION,
      'createdAt must be an ISO-8601 timestamp string when it is supplied.');
  return value;
}

/**
 * Configuration is only what the caller states: an unstated field stays absent
 * and the accepted normaliser lists it in `configuration.unknownFields` under
 * `unknown: "UNKNOWN"`, which is how "not known" survives as null instead of
 * becoming zero or an empty string.
 */
function explicitConfiguration(value) {
  if (value === void 0 || value === null) return void 0;
  if (!isPlainObject(value))
    throw new InitError(INIT_ERROR_CODES.INVALID_OPTION,
      'configuration must be an object of explicitly known fields, or omitted so that it is recorded as unknown.');
  rejectUnknownKeys(value, Object.freeze([
    'harness', 'model', 'location', 'os', 'nodeVersion', 'runtimeFlags', 'unknown', 'unknownFields',
  ]), 'configuration');
  for (const key of ['harness', 'model', 'location', 'os', 'nodeVersion'])
    if (value[key] !== void 0 && value[key] !== null && typeof value[key] !== 'string')
      throw new InitError(INIT_ERROR_CODES.INVALID_OPTION,
        `configuration.${key} must be a string or null; unknown configuration is null, never zero.`);
  return value;
}

function explicitStringMap(value) {
  if (value === void 0) return void 0;
  if (!isPlainObject(value))
    throw new InitError(INIT_ERROR_CODES.INVALID_OPTION,
      'expectedSessionPolicy must be an object of string values, or omitted.');
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string')
      throw new InitError(INIT_ERROR_CODES.INVALID_OPTION,
        `expectedSessionPolicy.${key} must be a string; a session policy field is stated, not inferred.`);
    out[key] = entry;
  }
  return out;
}

function asHook(value, name) {
  if (value === void 0 || value === null) return null;
  if (typeof value !== 'function')
    throw new InitError(INIT_ERROR_CODES.INVALID_OPTION, `${name} must be a function when it is supplied.`);
  return value;
}

async function callHook(hookFunction, observation) {
  if (hookFunction === null) return;
  await hookFunction(Object.freeze({ ...observation }));
}

/* -------------------------------------------------------------------------- */
/* Transaction                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run the transaction steps in contract order. Success is only ever reported
 * after the final read-back step has completed; every step is awaited, so an
 * interruption anywhere below propagates into the rollback path.
 *
 * @param {object} operation
 * @returns {Promise<void>}
 */
async function runTransaction(operation) {
  await reserveOutput(operation);
  await exportWorkspace(operation);
  await verifyWorkspaceAgain(operation);
  await recordOwnedTree(operation, operation.workspaceRoot);
  await prepareDependencyStage(operation);
  await recordOwnedTree(operation, operation.workspaceRoot);
  await recordOwnedTree(operation, operation.stateRoot);
  await writeState(operation);
  await publishContainer(operation);
  await verifyPublishedContainer(operation);
}

/**
 * Reserve the output container exclusively.
 *
 * `mkdir` without `recursive` is the exclusive create: an existing directory
 * fails with `EEXIST`. A concurrent racer therefore either wins — in which case
 * this call reports `OUTPUT_EXISTS` and has created nothing — or loses and
 * reports the same. Nothing is renamed over, emptied or replaced, and the
 * parent is never created on the caller's behalf, because inventing a parent
 * would be writing where the caller did not ask.
 */
async function reserveOutput(operation) {
  const parent = path.dirname(operation.output);
  // Prove every existing ancestor before the first write, not just the parent.
  for (let ancestor = parent; ; ancestor = path.dirname(ancestor)) {
    const status = await lstatOrNull(ancestor, 'an output ancestor');
    if (status?.isSymbolicLink() || (status && !status.isDirectory()))
      throw new InitError(INIT_ERROR_CODES.LINK_OR_SPECIAL,
        `the output ancestor ${display(ancestor)} is a link or non-directory.`, { path: ancestor });
    if (path.dirname(ancestor) === ancestor) break;
  }
  const parentStatus = await lstatOrNull(parent, 'the output parent');
  if (parentStatus === null)
    throw new InitError(INIT_ERROR_CODES.OUTPUT_UNUSABLE,
      `the output parent ${display(parent)} does not exist; it is never created implicitly.`,
      { path: parent });
  if (parentStatus.isSymbolicLink())
    throw new InitError(INIT_ERROR_CODES.LINK_OR_SPECIAL,
      `the output parent ${display(parent)} is a symbolic link.`, { path: parent });
  if (!parentStatus.isDirectory())
    throw new InitError(INIT_ERROR_CODES.OUTPUT_UNUSABLE,
      `the output parent ${display(parent)} is not a directory.`, { path: parent });

  try {
    await fs.promises.mkdir(operation.output, { recursive: false });
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new InitError(INIT_ERROR_CODES.OUTPUT_EXISTS,
        `the output ${display(operation.output)} already exists; an existing container is never reused, emptied or overwritten.`,
        { path: operation.output, cause: error?.message });
    if (error?.code === 'ELOOP')
      throw new InitError(INIT_ERROR_CODES.LINK_OR_SPECIAL,
        `the output path ${display(operation.output)} loops through a link.`, { path: operation.output });
    throw new InitError(INIT_ERROR_CODES.OUTPUT_UNUSABLE,
      `the output ${display(operation.output)} could not be reserved: ${error?.message ?? String(error)}`,
      { path: operation.output });
  }
  operation.outputOwned = true;
  operation.outputIdentity = await fs.promises.lstat(operation.output);
  operation.ownedEntries = new Map();
}

/**
 * Publish the participant workspace through the accepted exporter.
 *
 * The exporter receives the same validated package with the container's own
 * `workspace` path as its output, so it performs its full transaction — source
 * proof, private staging, source proof again, exclusive reservation,
 * publication, published proof — for exactly the declared workload files, and
 * cleans only its own staging when it fails.
 */
async function exportWorkspace(operation) {
  await callHook(operation.hooks.beforeWorkspacePublication, {
    stage: 'beforeWorkspacePublication',
    output: operation.output,
    workspaceRoot: operation.workspaceRoot,
  });

  const published = await exportChallenge({
    challenge: {
      identity: operation.challenge.identity,
      sourceRoot: operation.challenge.sourceRoot,
      fileManifest: [...operation.challenge.fileManifest],
      ownerRoots: [...operation.challenge.ownerRoots],
      evaluatorRoots: [...operation.challenge.evaluatorRoots],
    },
    output: operation.workspaceRoot,
  });

  if (!isPlainObject(published) || typeof published.workspaceRoot !== 'string' ||
      typeof published.workloadDigest !== 'string' || !HEX64.test(published.workloadDigest) ||
      !Array.isArray(published.inventory))
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      'the exporter returned a result this seam cannot record.',
      { expected: 'workspaceRoot, workloadDigest, inventory' });
  if (normalizeKey(published.workspaceRoot) !== normalizeKey(operation.workspaceRoot))
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      `the exporter published to ${display(published.workspaceRoot)} instead of ${display(operation.workspaceRoot)}.`);
  if (published.inventory.length !== operation.challenge.fileManifest.length)
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      `the exporter published ${published.inventory.length} files while the exact manifest declares ${operation.challenge.fileManifest.length}.`);
  if (published.workloadDigest !== operation.challenge.identity.workloadDigest)
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      `the exported workload digest ${published.workloadDigest} does not equal the identity workload digest ${operation.challenge.identity.workloadDigest}.`);
  operation.export = published;
}

/**
 * Verify the published workspace again from the container side.
 *
 * The exporter proved the published bytes before it returned; this second
 * proof checks the physical workspace against the exact manifest and its implied
 * directory skeleton, using the accepted raw-byte hash primitives. No generated
 * name is skipped: before dependency preparation only the workload is allowed.
 * A workspace that changed between export and preparation fails closed.
 */
async function verifyWorkspaceAgain(operation) {
  const inventory = inventoryOf(operation);
  if (inventory.digest !== operation.export.workloadDigest)
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      `the exported workspace now hashes to ${inventory.digest} instead of the exported workload digest ${operation.export.workloadDigest}.`,
      { path: operation.workspaceRoot });
  operation.workspaceInventory = inventory;
}

/**
 * Prepare the dependencies for this run.
 *
 * Every path the accepted helper needs is passed explicitly and the mode is
 * the caller's declared mode: mode `none` gets no root at all, mode `prepared`
 * gets the explicit cache (plus the explicit lock source when one was named),
 * and mode `install` gets the explicit executable, an explicit scratch root
 * inside this container's own state root and the caller's own process adapter.
 * The metadata record goes into the state root, which is OUTSIDE the
 * participant workspace — which is also the only place BenchBoard state may sit,
 * because the helper refuses a workspace that already carries state.
 */
async function prepareDependencyStage(operation) {
  const declared = operation.dependencies;

  /* The state root and its dependencies subdirectory must exist before the
   * helper can place its metadata record, and the helper proves that parent. */
  await fs.promises.mkdir(operation.stateRoot, { recursive: false });
  operation.stateRootCreated = true;
  await recordOwnedTree(operation, operation.stateRoot);
  if (declared.mode !== 'none') {
    await fs.promises.mkdir(operation.dependenciesDirectory, { recursive: false });
    operation.dependenciesDirectoryCreated = true;
    await recordOwnedTree(operation, operation.stateRoot);
  }

  if (declared.mode === 'none') {
    /* Mode none is the declared decision to run nothing and install nothing:
     * the accepted helper returns it as a pure decision without a single
     * filesystem proof, and there is no dependency identity to record. */
    operation.dependencyRecord = await prepareDependencies({
      workspaceRoot: operation.workspaceRoot,
      mode: 'none',
    });
    operation.dependencyDigest = null;
    return;
  }

  const request = {
    workspaceRoot: operation.workspaceRoot,
    mode: declared.mode,
    metadataPath: operation.dependenciesMetadataPath,
  };
  if (declared.mode === 'prepared') request.preparedRoot = declared.preparedRoot;
  if (declared.mode === 'install') {
    request.npmExecutable = declared.npmExecutable;
    /* The helper needs an explicit scratch root it owns for the duration of
     * the install. When the caller did not name one, it goes inside this
     * container's own state root, so an interrupted install can never leave
     * material in a directory the caller did not give us. */
    request.scratchRoot = declared.scratchRoot ?? path.join(operation.dependenciesDirectory, 'scratch');
    if (declared.scratchRoot === void 0)
      await fs.promises.mkdir(request.scratchRoot, { recursive: false });
  }
  if (declared.sourceRoot !== void 0) request.sourceRoot = declared.sourceRoot;
  if (declared.expectedDependencyDigest !== void 0) request.expectedDependencyDigest = declared.expectedDependencyDigest;
  if (declared.offline !== void 0) request.offline = declared.offline;
  if (declared.npmArgumentsPrefix !== void 0) request.npmArgumentsPrefix = [...declared.npmArgumentsPrefix];
  if (declared.npmArgumentsSuffix !== void 0) request.npmArgumentsSuffix = [...declared.npmArgumentsSuffix];
  if (declared.processAdapter !== void 0) request.processAdapter = declared.processAdapter;
  for (const key of ['maxEntries', 'maxFileBytes', 'maxTotalBytes', 'timeoutMs'])
    if (declared[key] !== void 0) request[key] = declared[key];

  const record = await prepareDependencies(request);
  if (!isPlainObject(record) || typeof record.mode !== 'string')
    throw new InitError(INIT_ERROR_CODES.DEPENDENCY_RESULT_INVALID,
      'the dependency helper returned a record this seam cannot record.',
      { expected: 'mode, dependencyDigest, inventory, metadata' });
  if (record.mode !== declared.mode)
    throw new InitError(INIT_ERROR_CODES.DEPENDENCY_RESULT_INVALID,
      `the dependency helper reported mode ${JSON.stringify(record.mode)} while the request declared ${JSON.stringify(declared.mode)}.`);

  const digest = record.dependencyDigest ?? record.metadata?.dependencyDigest ?? null;
  if (digest !== null && (typeof digest !== 'string' || !HEX64.test(digest)))
    throw new InitError(INIT_ERROR_CODES.DEPENDENCY_RESULT_INVALID,
      `the dependency digest ${JSON.stringify(digest)} is not 64 lowercase hex characters of the dependency domain.`);
  if (digest === null)
    throw new InitError(INIT_ERROR_CODES.DEPENDENCY_RESULT_INVALID,
      `mode ${JSON.stringify(declared.mode)} must report a dependency digest; mode none is the only mode without one.`);
  if (declared.expectedDependencyDigest !== void 0 && digest !== declared.expectedDependencyDigest)
    throw new InitError(INIT_ERROR_CODES.DEPENDENCY_RESULT_INVALID,
      `the prepared dependency digest ${digest} does not equal the expected ${declared.expectedDependencyDigest}.`);
  /* Two hash domains: a dependency digest is never interchangeable with a
   * workload digest, whatever algorithm string travels with either. */
  if (digest === operation.export.workloadDigest)
    throw new InitError(INIT_ERROR_CODES.DOMAIN_CONFLATION,
      'the dependency digest equals the workload digest; the dependency and workload hash domains must not be conflated.');

  operation.dependencyRecord = record;
  operation.dependencyDigest = digest;
}

/**
 * Seal the run state and publish it through the accepted storage layer.
 *
 * Three immutable records go into the state root: the sealed run manifest, the
 * separately hashed dependency companion, and the export proof. Dependency
 * identity is deliberately NOT an added field of the C1 record — the manifest
 * keeps exactly its schematised fields — and neither companion is schematised
 * as a C1 kind: both carry this module's own kind string and are hashed in
 * their own domain. The storage layer performs the exclusive link publication
 * and its own read-back validation.
 */
async function writeState(operation) {
  await callHook(operation.hooks.beforeStatePublication, {
    stage: 'beforeStatePublication',
    output: operation.output,
    workspaceRoot: operation.workspaceRoot,
    stateRoot: operation.stateRoot,
    manifestId: operation.manifest.manifestId,
    runId: operation.manifest.runId,
  });

  const stateDirectory = path.join(operation.stateRoot, 'state');
  await fs.promises.mkdir(stateDirectory, { recursive: false });
  operation.stateDirectoryCreated = true;
  await recordOwnedEntry(operation, stateDirectory);
  // Reserve the internal namespace ourselves; never adopt hook-inserted state.
  const storageDirectory = path.join(operation.stateRoot, '.storage');
  await fs.promises.mkdir(storageDirectory, { recursive: false });
  await recordOwnedEntry(operation, storageDirectory);
  operation.publications = [];

  const storage = createStorage({ root: operation.stateRoot, hooks: {
    beforePublish: async context => {
      await recordStorageRegistry(operation, context, true);
    },
    beforeRegister: async context => {
      await recordOwnedEntry(operation, path.join(operation.stateRoot, ...context.relativePath.split('/')));
    },
  } });
  operation.storage = storage;

  operation.publications = Object.freeze([
    await publishRecord(storage, operation, {
      relativePath: RUN_STATE_RELATIVE_PATH,
      id: operation.manifest.manifestId,
      value: operation.manifest,
      label: 'run manifest',
    }),
    await publishRecord(storage, operation, {
      relativePath: DEPENDENCY_STATE_RELATIVE_PATH,
      id: `${operation.manifest.manifestId}:dependencies`,
      value: dependencyCompanion(operation),
      label: 'dependency companion',
    }),
    await publishRecord(storage, operation, {
      relativePath: EXPORT_STATE_RELATIVE_PATH,
      id: `${operation.manifest.manifestId}:export`,
      value: exportProof(operation),
      label: 'export proof',
    }),
  ]);
}

/**
 * Prove the container is complete before it is called published.
 *
 * The workspace is already in its final place, because the exporter was given
 * the container's own `workspace` path, and the state records were published by
 * the storage layer inside the sibling state root. Publication here is
 * therefore the completeness proof: every required part is present as a real,
 * non-link, non-empty entry. An incomplete container fails closed here instead
 * of being published partially, and no rename-over or emptying is performed at
 * any point.
 */
async function publishContainer(operation) {
  for (const required of [
    { root: operation.workspaceRoot, label: 'the participant workspace', kind: 'directory' },
    { root: operation.stateRoot, label: 'the run state root', kind: 'directory' },
  ]) {
    const status = await lstatOrNull(required.root, required.label);
    if (status === null)
      throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
        `at publication time ${required.label} ${display(required.root)} is missing.`, { path: required.root });
    if (status.isSymbolicLink())
      throw new InitError(INIT_ERROR_CODES.LINK_OR_SPECIAL,
        `at publication time ${required.label} ${display(required.root)} is a symbolic link.`, { path: required.root });
    if (!status.isDirectory())
      throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
        `at publication time ${required.label} ${display(required.root)} is not a directory.`, { path: required.root });
  }

  for (const relativePath of [RUN_STATE_RELATIVE_PATH, DEPENDENCY_STATE_RELATIVE_PATH, EXPORT_STATE_RELATIVE_PATH]) {
    const target = path.join(operation.stateRoot, ...relativePath.split('/'));
    const status = await lstatOrNull(target, `the state record ${relativePath}`);
    if (status === null)
      throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
        `the state record ${JSON.stringify(relativePath)} is missing at publication time.`, { path: relativePath });
    if (status.isSymbolicLink())
      throw new InitError(INIT_ERROR_CODES.LINK_OR_SPECIAL,
        `the state record ${JSON.stringify(relativePath)} is a symbolic link.`, { path: relativePath });
    if (!status.isFile())
      throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
        `the state record ${JSON.stringify(relativePath)} is not a regular file.`, { path: relativePath });
    if (status.size === 0)
      throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
        `the state record ${JSON.stringify(relativePath)} is empty.`, { path: relativePath });
  }

  /* A run that declared a dependency mode must actually carry its dependency
   * tree where the mode put it, and must not carry a mode-none workspace that
   * grew one from somewhere else. */
  const nodeModulesStatus = await lstatOrNull(path.join(operation.workspaceRoot, 'node_modules'), 'the dependency tree');
  const hasDependencyTree = nodeModulesStatus !== null && nodeModulesStatus.isDirectory();
  if (operation.dependencyDigest !== null && !hasDependencyTree)
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      'a dependency digest was prepared but the container carries no dependency tree.',
      { path: path.join(operation.workspaceRoot, 'node_modules') });
  if (operation.dependencies.mode === 'none' && nodeModulesStatus !== null)
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      'mode none declares that nothing is installed, yet the workspace carries a node_modules entry.',
      { path: path.join(operation.workspaceRoot, 'node_modules') });
}

/**
 * Read the published container back and revalidate it.
 *
 * Every state record is read through the accepted storage reader, which
 * revalidates the envelope digest, the record identity and the storage root
 * against the current filesystem, and the run record is revalidated with the
 * accepted `validateRecord`. The workspace is inventoried once more so the
 * returned digests are recomputed from what is actually on disk. Any mismatch
 * fails the transaction instead of being reported as a warning, and this is the
 * step that makes "no success before all proofs" true.
 */
async function verifyPublishedContainer(operation) {
  const runRecord = await readState(operation, RUN_STATE_RELATIVE_PATH, operation.manifest.manifestId);
  const dependencyRecord = await readState(operation, DEPENDENCY_STATE_RELATIVE_PATH,
    `${operation.manifest.manifestId}:dependencies`);
  const exportRecord = await readState(operation, EXPORT_STATE_RELATIVE_PATH,
    `${operation.manifest.manifestId}:export`);

  const manifest = validatedRunRecord(runRecord);
  if (JSON.stringify(manifest) !== JSON.stringify(operation.manifest))
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      'the run record read back does not equal the record that was written.',
      { path: RUN_STATE_RELATIVE_PATH });

  /* The persisted record names the final native container roots, never a
   * staging path, and it stays the accepted record with no added field. */
  if (manifest.participantWorkspaceRoot !== operation.workspaceRoot ||
      manifest.evidenceRoot !== operation.stateRoot)
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      'the persisted run record names roots other than the final container roots.',
      { path: RUN_STATE_RELATIVE_PATH });

  if (dependencyRecord.dependencyDigest !== operation.dependencyDigest)
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      'the dependency companion read back does not carry the dependency digest that was prepared.',
      { path: DEPENDENCY_STATE_RELATIVE_PATH });
  if (exportRecord.workloadDigest !== operation.export.workloadDigest)
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      'the export proof read back does not carry the workload digest that was exported.',
      { path: EXPORT_STATE_RELATIVE_PATH });

  // Prove every physical workload entry, including formerly skipped names,
  // before hashing the separately verified dependency subtree.
  const workspace = inventoryOf(operation, operation.dependencyDigest !== null);
  if (operation.dependencyDigest !== null) {
    const actual = dependencyInventoryOf(path.join(operation.workspaceRoot, 'node_modules'));
    if (actual.digest !== operation.dependencyDigest || actual.digest !== dependencyRecord.dependencyDigest ||
        actual.digest !== dependencyRecord.inventoryDigest ||
        dependencyRecord.hashAlgorithmId !== DEPENDENCY_HASH_ALGORITHM_ID)
      throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
        'the complete final dependency inventory differs from the prepared or persisted dependency proof.',
        { path: path.join(operation.workspaceRoot, 'node_modules') });
  }

  if (workspace.digest !== operation.export.workloadDigest)
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      `the workspace now hashes to ${workspace.digest} instead of the exported workload digest ${operation.export.workloadDigest}.`,
      { path: operation.workspaceRoot });

  operation.result = Object.freeze(buildResult(operation, {
    manifest,
    publications: operation.publications,
    workspaceFileCount: workspace.entries.length,
  }));
}

/* -------------------------------------------------------------------------- */
/* State records                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The separately hashed, immutable dependency companion.
 *
 * It carries the dependency digest, its own algorithm identifier, the mode that
 * produced it, the inventory digest of the prepared tree and where the
 * helper's own metadata record lives. The descriptive fields are taken from the
 * accepted helper's `metadata` record — the result's top level is only `mode`,
 * `dependencyDigest`, `inventory` and `metadata` — so no field here is invented.
 * It is a record of this module, never a C1 record with added fields.
 */
function dependencyCompanion(operation) {
  const record = operation.dependencyRecord ?? {};
  const metadata = record.metadata ?? {};
  const inventory = record.inventory ?? {};
  const entries = Array.isArray(inventory.entries) ? inventory.entries : [];
  return Object.freeze({
    schemaVersion: INIT_STATE_SCHEMA_VERSION,
    kind: 'benchboard:dependency-state',
    module: INIT_MODULE_ID,
    manifestId: operation.manifest.manifestId,
    runId: operation.manifest.runId,
    mode: record.mode ?? null,
    hashAlgorithmId: metadata.hashAlgorithmId ?? DEPENDENCY_HASH_ALGORITHM_ID,
    dependencyDigest: operation.dependencyDigest,
    dependencyDirectory: metadata.dependencyDirectory ?? null,
    workspaceRoot: operation.workspaceRoot,
    metadataPath: metadata.metadataPath ?? null,
    inventoryDigest: inventory.digest ?? null,
    inventoryCount: entries.length,
    totalBytes: Number.isFinite(inventory.totalBytes) ? inventory.totalBytes : null,
    npm: metadata.npm ?? null,
    provenance: metadata.provenance ?? null,
    executed: metadata.executed === true,
    copiedFiles: Number.isFinite(metadata.copiedFiles) ? metadata.copiedFiles : null,
    copiedBytes: Number.isFinite(metadata.copiedBytes) ? metadata.copiedBytes : null,
    cleanedUp: Array.isArray(metadata.cleanedUp) ? Object.freeze([...metadata.cleanedUp]) : Object.freeze([]),
    notes: 'Dependency identity of one run, recorded outside the participant workspace and hashed in the dependency domain.',
  });
}

/** The export proof: what the accepted exporter published and verified. */
function exportProof(operation) {
  return Object.freeze({
    schemaVersion: INIT_STATE_SCHEMA_VERSION,
    kind: 'benchboard:export-state',
    module: INIT_MODULE_ID,
    manifestId: operation.manifest.manifestId,
    runId: operation.manifest.runId,
    hashAlgorithmId: WORKLOAD_HASH_ALGORITHM_ID,
    workloadDigest: operation.export.workloadDigest,
    declaredFileCount: operation.challenge.fileManifest.length,
    publishedFileCount: operation.export.inventory.length,
    releaseWorkloadFileCount: EXPECTED_WORKLOAD_FILE_COUNT,
    workspaceRoot: operation.workspaceRoot,
    sourceRoot: operation.challenge.sourceRoot,
    inventory: Object.freeze(operation.export.inventory.map(
      (entry) => Object.freeze({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }))),
    notes: 'Proof of the participant workspace as it was published, recomputed from the published bytes.',
  });
}

/* -------------------------------------------------------------------------- */
/* Result                                                                      */
/* -------------------------------------------------------------------------- */

function buildResult(operation, read) {
  const digests = new Map(read.publications.map((entry) => [entry.relativePath, entry.digest]));
  return Object.freeze({
    schemaVersion: INIT_STATE_SCHEMA_VERSION,
    kind: 'benchboard:run-initialisation-result',
    module: INIT_MODULE_ID,
    manifest: read.manifest,
    output: operation.output,
    workspace: Object.freeze({
      root: operation.workspaceRoot,
      workloadDigest: operation.export.workloadDigest,
      workloadAlgorithmId: WORKLOAD_HASH_ALGORITHM_ID,
      fileCount: read.workspaceFileCount,
      dependencyDirectory: operation.dependencyRecord?.metadata?.dependencyDirectory ?? null,
    }),
    state: Object.freeze({
      root: operation.stateRoot,
      insideWorkspace: keyContains(normalizeKey(operation.workspaceRoot), normalizeKey(operation.stateRoot)),
      runRecord: RUN_STATE_RELATIVE_PATH,
      dependencyRecord: DEPENDENCY_STATE_RELATIVE_PATH,
      exportRecord: EXPORT_STATE_RELATIVE_PATH,
      dependencyMetadata: toRelativePosix(operation.stateRoot, operation.dependenciesMetadataPath),
      runRecordDigest: digests.get(RUN_STATE_RELATIVE_PATH) ?? null,
      dependencyRecordDigest: digests.get(DEPENDENCY_STATE_RELATIVE_PATH) ?? null,
      exportRecordDigest: digests.get(EXPORT_STATE_RELATIVE_PATH) ?? null,
    }),
    dependency: Object.freeze({
      mode: operation.dependencies.mode,
      digest: operation.dependencyDigest,
      algorithmId: DEPENDENCY_HASH_ALGORITHM_ID,
    }),
    workload: Object.freeze({
      digest: operation.export.workloadDigest,
      algorithmId: WORKLOAD_HASH_ALGORITHM_ID,
      fileCount: operation.export.inventory.length,
    }),
    durationMs: Math.max(0, Date.now() - operation.startedAt),
  });
}

/* -------------------------------------------------------------------------- */
/* Failure path and rollback                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Remove only what this call provably created, then rethrow the failure.
 *
 * The container is taken down only where this call created it; anything this
 * call did not create is left exactly where it was found, so a concurrent
 * writer's container, a pre-existing target and any foreign canary survive
 * untouched. Material that cannot be removed is disclosed on `CLEANUP_FAILED`
 * attached to the original error instead of being destroyed or silently
 * ignored.
 *
 * @param {object} operation
 * @param {unknown} failure the error the transaction failed with
 * @returns {Promise<never>}
 */
async function finishFailed(operation, failure) {
  const removed = [];
  const kept = [];
  await rollbackContainer(operation, removed, kept);

  if (kept.length > 0)
    attach(failure, 'cleanup', new InitError(INIT_ERROR_CODES.CLEANUP_FAILED,
      `material this call created could not be removed and is disclosed instead of destroyed: ${kept
        .map((entry) => `${display(entry.path)} (${entry.reason})`)
        .join('; ')}.`, { kept }));
  else if (removed.length > 0)
    attach(failure, 'rolledBackTo', { removed });

  if (failure instanceof InitError) throw failure;
  attach(failure, 'initialisationFailed', { code: INIT_ERROR_CODES.INIT_FAILED_ROLLED_BACK, removed });
  throw failure;
}

function sameEntry(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

// Exact paths only: do not sweep hook-inserted foreign state into ownership.
async function recordOwnedEntry(operation, absolute, replace = false) {
  const status = await fs.promises.lstat(absolute);
  if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile()))
    throw new InitError(INIT_ERROR_CODES.LINK_OR_SPECIAL, 'a created state entry changed kind.', { path: absolute });
  const entry = { absolute, status, directory: status.isDirectory() };
  if (status.isFile()) entry.digest = sha256(await fs.promises.readFile(absolute));
  if (replace || !operation.ownedEntries.has(absolute)) operation.ownedEntries.set(absolute, entry);
}

async function recordStorageRegistry(operation, current, pending) {
  const absolute = path.join(operation.stateRoot, '.storage', 'registry.json');
  const expected = {};
  for (const entry of [...operation.publications, ...(pending ? [current] : [])]) {
    expected[JSON.stringify([INIT_STATE_KIND, entry.id])] = {
      relativePath: entry.relativePath, digest: entry.digest, recordType: 'immutable',
      ...(pending && entry === current ? { pending: true } : {}),
    };
  }
  const bytes = await fs.promises.readFile(absolute);
  if (bytes.toString('utf8') !== JSON.stringify({ schemaVersion: 1, records: expected }))
    throw new InitError(INIT_ERROR_CODES.STATE_WRITE_FAILED, 'the storage registry contains unowned or changed material.', { path: absolute });
  // Storage atomically replaces this exact registry at each bound publication.
  await recordOwnedEntry(operation, absolute, true);
}

// Capture only successfully verified operation outputs, before failure hooks.
// A failed helper's unknown residue must never be adopted by outer rollback.
async function recordOwnedTree(operation, root) {
  if (!operation.ownedEntries || !fs.existsSync(root)) return;
  const visit = async absolute => {
    const status = await fs.promises.lstat(absolute);
    if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile())) return;
    const entry = { absolute, status, directory: status.isDirectory() };
    if (status.isFile()) entry.digest = sha256(await fs.promises.readFile(absolute));
    if (!operation.ownedEntries.has(absolute)) operation.ownedEntries.set(absolute, entry);
    if (status.isDirectory()) for (const name of await fs.promises.readdir(absolute)) await visit(path.join(absolute, name));
  };
  await visit(root);
}

async function rollbackContainer(operation, removed, kept) {
  if (!operation.outputOwned) return;
  const status = await lstatOrNull(operation.output, 'the container this call created');
  if (status === null) return;
  if (status.isSymbolicLink() || !status.isDirectory() || !sameEntry(status, operation.outputIdentity)) {
    kept.push({ path: operation.output, reason: 'the reserved container was replaced; its contents are not owned' });
    return;
  }
  const entries = [...operation.ownedEntries.values()].sort((a, b) => b.absolute.length - a.absolute.length);
  for (const entry of entries) {
    try {
      let changedParent = false;
      for (const ancestor of entries) {
        const relative = path.relative(ancestor.absolute, entry.absolute);
        if (ancestor.directory && relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
          const current = await lstatOrNull(ancestor.absolute, 'owned ancestor');
          if (!current || current.isSymbolicLink() || !sameEntry(current, ancestor.status)) { changedParent = true; break; }
        }
      }
      if (changedParent) continue;
      const current = await lstatOrNull(entry.absolute, 'owned output');
      if (!current || current.isSymbolicLink() || !sameEntry(current, entry.status)) continue;
      if (entry.directory) await fs.promises.rmdir(entry.absolute);
      else if (current.isFile() && sha256(await fs.promises.readFile(entry.absolute)) === entry.digest) await fs.promises.unlink(entry.absolute);
    } catch { /* Preserve unowned or changed material; the container reports residue below. */ }
  }
  try {
    // Non-recursive removal cannot destroy foreign descendants.
    await fs.promises.rm(operation.output, { recursive: false });
    removed.push(operation.output);
  } catch (error) {
    if (error?.code === 'ERR_FS_EISDIR' || error?.code === 'EISDIR') {
      try { await fs.promises.rmdir(operation.output); removed.push(operation.output); return; }
      catch (residue) { error = residue; }
    }
    kept.push({ path: operation.output, reason: error?.message ?? String(error) });
  }
}

function attach(target, key, value) {
  try {
    Object.assign(target, { [key]: value });
    return true;
  } catch {
    /* A frozen inherited error cannot be annotated; the original throw still
     * carries the reason. */
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Storage helpers                                                             */
/* -------------------------------------------------------------------------- */

async function publishRecord(storage, operation, { relativePath, id, value, label }) {
  try {
    const publication = await storage.createImmutable({ relativePath, kind: INIT_STATE_KIND, id, value });
    operation.publications.push(publication);
    await recordStorageRegistry(operation, publication, false);
    return publication;
  } catch (error) {
    throw new InitError(INIT_ERROR_CODES.STATE_WRITE_FAILED,
      `the ${label} record could not be published at ${JSON.stringify(relativePath)}: ${error?.message ?? String(error)}`,
      { path: relativePath, storageCode: error?.code, cause: error?.message });
  }
}

async function readState(operation, relativePath, id) {
  try {
    return await operation.storage.read({ relativePath, kind: INIT_STATE_KIND, id });
  } catch (error) {
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      `the state record ${JSON.stringify(relativePath)} could not be read back: ${error?.message ?? String(error)}`,
      { path: relativePath, storageCode: error?.code, cause: error?.message });
  }
}

/** Revalidate the read-back run record with the accepted contract validator. */
function validatedRunRecord(record) {
  try {
    return validateRecord('RunManifest', record);
  } catch (error) {
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      `the persisted run record was refused by the accepted contract validator: ${error?.message ?? String(error)}`,
      { path: RUN_STATE_RELATIVE_PATH, cause: error?.message });
  }
}

/* -------------------------------------------------------------------------- */
/* Tree and path helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Exact physical workload proof: manifest files plus their directory skeleton.
 * No default skip names apply. Only the top-level ordinary node_modules directory
 * may be deferred, and only when its prepared/installed proof is verified next.
 * Rejected links and foreign directories are never followed or read.
 */
function inventoryOf(operation, allowDependencies = false) {
  const root = operation.workspaceRoot;
  let inspected = root;
  try {
    const files = new Set(operation.challenge.fileManifest);
    const directories = new Set();
    for (const relative of files) {
      let cursor = '';
      for (const segment of relative.split('/').slice(0, -1)) {
        cursor = cursor === '' ? segment : `${cursor}/${segment}`;
        directories.add(cursor);
      }
    }
    const refuse = message => {
      throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID, message, { path: inspected });
    };
    const rootStatus = fs.lstatSync(root);
    if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory())
      refuse('the final workspace root is not an ordinary directory.');
    const entries = [];
    const visit = directory => {
      for (const name of fs.readdirSync(directory).sort(compareLexical)) {
        inspected = path.join(directory, name);
        const relative = toRelativePosix(root, inspected);
        const status = fs.lstatSync(inspected);
        if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile()))
          refuse(`the workspace carries a link or special entry at ${JSON.stringify(relative)}.`);
        if (relative === 'node_modules' && allowDependencies && status.isDirectory()) continue;
        if (status.isDirectory()) {
          if (!directories.has(relative))
            refuse(`the workspace carries an undeclared directory at ${JSON.stringify(relative)}.`);
          visit(inspected);
        } else {
          if (!files.has(relative))
            refuse(`the workspace carries an undeclared file at ${JSON.stringify(relative)}.`);
          const bytes = fs.readFileSync(inspected);
          entries.push({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
        }
      }
    };
    visit(root);
    const present = new Set(entries.map(entry => entry.path));
    for (const relative of files) if (!present.has(relative)) {
      inspected = path.join(root, ...relative.split('/'));
      refuse(`the workspace is missing the declared file ${JSON.stringify(relative)}.`);
    }
    entries.sort((a, b) => compareLexical(a.path, b.path));
    return { entries, digest: hashEntries(entries) };
  } catch (error) {
    if (error instanceof InitError) throw error;
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      `the container ${display(root)} could not be physically inventoried: ${error?.message ?? String(error)}`,
      { path: inspected });
  }
}

function dependencyInventoryOf(root) {
  try {
    // No workload skip names apply in the dependency domain, even for nested
    // node_modules/dist/.git. Check directory spellings as well as file paths.
    const folded = new Map();
    const visit = directory => {
      for (const name of fs.readdirSync(directory)) {
        const absolute = path.join(directory, name);
        const relative = toRelativePosix(root, absolute);
        const key = normalizeKey(relative);
        if (folded.has(key) && folded.get(key) !== relative)
          throw new Error(`dependency case collision: ${relative}`);
        folded.set(key, relative);
        const status = fs.lstatSync(absolute);
        if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile()))
          throw new Error(`dependency link or special entry: ${relative}`);
        if (status.isDirectory()) visit(absolute);
      }
    };
    const inventory = inventoryTree({ root, skipNames: [] });
    visit(root);
    return { hashAlgorithmId: DEPENDENCY_HASH_ALGORITHM_ID, entries: inventory.entries,
      digest: hashEntries(inventory.entries) };
  } catch (error) {
    throw new InitError(INIT_ERROR_CODES.PUBLICATION_INVALID,
      `the complete final dependency tree could not be verified: ${error?.message ?? String(error)}`, { path: root });
  }
}

async function lstatOrNull(target, label) {
  try {
    return await fs.promises.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    if (error?.code === 'ELOOP')
      throw new InitError(INIT_ERROR_CODES.LINK_OR_SPECIAL,
        `${label} ${display(target)} could not be inspected without following a link.`, { path: target });
    throw new InitError(INIT_ERROR_CODES.OUTPUT_UNUSABLE,
      `${label} ${display(target)} could not be inspected: ${error?.message ?? String(error)}`, { path: target });
  }
}

function absoluteRoot(value, name, code = INIT_ERROR_CODES.INVALID_ROOT) {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new InitError(code,
      `${name} must be an explicit absolute host path; nothing is resolved against a module, package, configuration or current directory.`);
  if (!HOST_ROOT_ABSOLUTE.test(value))
    throw new InitError(code, `${name} must be an absolute host path, got ${JSON.stringify(value)}.`);
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value) ||
      value.startsWith('\\\\?\\') || value.startsWith('\\\\') || value.startsWith('//') ||
      value.split(/[\\/]/).some(segment => segment === '.' || segment === '..'))
    throw new InitError(code, `${name} must be a native absolute root without dot segments, controls or unsupported aliases.`);
  // Native normalization removes redundant separators before all comparisons.
  return path.normalize(value);
}

function absoluteList(value, name) {
  return stringList(value, name).map((entry) => absoluteRoot(entry, name));
}

function stringList(value, name) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new InitError(INIT_ERROR_CODES.INVALID_OPTION, `${name} must be an array of strings.`);
  return [...value];
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new InitError(INIT_ERROR_CODES.OPTION_REQUIRED, `${name} is required and must be a non-empty string.`);
  return value;
}

function optionalString(value, name) {
  if (value === void 0 || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new InitError(INIT_ERROR_CODES.INVALID_OPTION,
      `${name} must be a non-empty string when it is supplied.`);
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0)
    throw new InitError(INIT_ERROR_CODES.INVALID_OPTION,
      `${label} carries unrecognised field(s): ${unexpected.join(', ')}.`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareLexical(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toRelativePosix(root, target) {
  return path.relative(root, target).replaceAll('\\', '/');
}

function display(value) {
  return JSON.stringify(String(value));
}

/** Case-insensitive, separator-insensitive lexical key without a trailing slash. */
function normalizeKey(value) {
  const withForward = String(value).replaceAll('\\', '/');
  const folded = withForward.normalize('NFD').toUpperCase().normalize('NFC').toLowerCase();
  let end = folded.length;
  while (end > 1 && folded[end - 1] === '/') end -= 1;
  return folded.slice(0, end);
}

/** True when `childKey` equals or sits inside `parentKey`, at a separator. */
function keyContains(parentKey, childKey) {
  if (childKey === parentKey) return true;
  const boundary = parentKey.endsWith('/') ? parentKey : `${parentKey}/`;
  return childKey.startsWith(boundary);
}

function rootsOverlap(left, right) {
  const leftKey = normalizeKey(left);
  const rightKey = normalizeKey(right);
  return keyContains(leftKey, rightKey) || keyContains(rightKey, leftKey);
}

/**
 * Refuse two roots that touch each other.
 *
 * The comparison is lexical at separator boundaries, so `/runs/a-b` is not
 * treated as being inside `/runs/a` while `/runs/a/b` is, and a drive root is
 * still a root. Both names are reported, because the caller has to be able to
 * see which of the two it moved.
 */
function assertApart(left, leftName, right, rightName) {
  if (!rootsOverlap(left, right)) return;
  throw new InitError(INIT_ERROR_CODES.ROOTS_OVERLAP,
    `output ${display(left)} must be disjoint from ${rightName} ${display(right)}: a container may not equal, contain or sit inside a protected root.`,
    { path: left, overlaps: right });
}

/** Refuse two roots that would collide on a case-insensitive filesystem. */
function assertNoCaseCollision(left, leftName, right, rightName) {
  if (normalizeKey(left) !== normalizeKey(right)) return;
  if (left === right) return;
  throw new InitError(INIT_ERROR_CODES.ROOTS_OVERLAP,
    `output ${display(left)} differs from ${rightName} ${display(right)} only by case; a case-insensitive filesystem would merge them.`,
    { path: left, overlaps: right });
}
