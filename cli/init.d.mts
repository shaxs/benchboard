/**
 * BenchBoard — public type surface of the `init` command handler.
 *
 * Chunk C2, task T3. The handler is the thin command-line edge in front of the
 * run-initialisation API: it parses one argument list, refuses what it does not
 * implement, and delegates. It owns no part of the transaction and no part of the
 * run's identity, so nothing here describes bytes on disk, digests or the
 * manifest — those belong to the API declaration that this file imports.
 *
 * A declaration file cannot be executed, so none of what follows is a security
 * control; it records the boundary, and `init.mjs` is what enforces it.
 *
 * Module resolution: this file and its byte-identical `.d.mts` sibling declare
 * the very same module. The `.d.ts` form is for a CommonJS-typed consumer, the
 * `.d.mts` form for an ECMAScript one, and `init.mjs` is ECMAScript only.
 */

import type { InitDependencyRequest, InitRequest, InitResult } from '../packages/core/init.mjs';
import type { DependencyMode, ReadonlyList } from '../packages/core/dependencies.mjs';
import type { ChallengePackage } from '../packages/core/challenge-export.mjs';
import type { EvaluatorIdentity, ToolingIdentity } from '../packages/core/manifest.mjs';

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Machine-readable handler refusal reasons. They are the handler's own and are
 * deliberately disjoint from the API's codes: a handler refusal means nothing was
 * attempted, an API code means the transaction was attempted and refused or
 * failed. A consumer that must tell those apart can therefore do so by code
 * rather than by parsing a message.
 */
export interface CliErrorCodes {
  /** The argument list was empty or malformed. */
  readonly USAGE: 'USAGE';
  /** An option this handler does not implement was supplied. */
  readonly UNKNOWN_OPTION: 'UNKNOWN_OPTION';
  /** An option was supplied twice. */
  readonly DUPLICATE_OPTION: 'DUPLICATE_OPTION';
  /** An option that needs a value was given none. */
  readonly OPTION_VALUE_MISSING: 'OPTION_VALUE_MISSING';
  /** An option value is not valid for it. */
  readonly OPTION_VALUE_INVALID: 'OPTION_VALUE_INVALID';
  /** The explicitly supplied package or identity is not acceptable to the API. */
  readonly INPUT_INVALID: 'INPUT_INVALID';
}

/** One handler refusal code. */
export type CliErrorCode = CliErrorCodes[keyof CliErrorCodes];

/** Stable identifier of this handler. */
export const CLI_MODULE_ID: 'benchboard.cli.init';

/** The one command this handler implements. */
export const CLI_COMMAND: 'init';

/** Modes this handler accepts; the API decides what each of them needs. */
export const CLI_DEPENDENCY_MODES: ReadonlyList<DependencyMode>;

/**
 * Process exit statuses. `2` means the request was unusable before any work
 * could start; `1` means the API refused or failed. `0` is reached only with a
 * result in hand, so a zero status always corresponds to a real container.
 */
export interface CliExitCodes {
  /** The container was initialised and read back. */
  readonly SUCCESS: 0;
  /** The API reported a refusal or a failure. */
  readonly FAILURE: 1;
  /** The argument list was not usable, so nothing was attempted. */
  readonly USAGE: 2;
}

/** Process exit statuses as values. */
export const CLI_EXIT_CODES: CliExitCodes;

/** Handler refusal codes as values. */
export const CLI_ERROR_CODES: CliErrorCodes;

/**
 * The challenge package keys, as the accepted exporter declares the package.
 * Listed so a plainly missing field is reported before a transaction starts; the
 * deep validation of the package stays with the API and is not restated here.
 */
export const CHALLENGE_PACKAGE_KEYS: ReadonlyList<
  'identity' | 'sourceRoot' | 'fileManifest' | 'ownerRoots' | 'evaluatorRoots'
>;

/**
 * The run-statement fields this handler forwards. Every one of them is either
 * stated by the caller or absent, and the API records an absent one as unknown
 * rather than as a value. They are not command-line options in this chunk.
 */
export const INITIALIZABLE_STATEMENT_KEYS: ReadonlyList<
  'architectureId' | 'architectureKind' | 'harness' | 'securityModel'
  | 'expectedSessionPolicy' | 'declaredCeilingMinutes' | 'configuration' | 'notes' | 'createdAt'
>;

/**
 * The options this handler implements, by name, with the request field each one
 * fills and the group it belongs to. Exported so the accepted surface can be
 * cross-checked against the help text rather than being listed a second time.
 */
export const OPTION_SPECIFICATIONS: Record<string, {
  readonly field: string;
  readonly kind: 'mode' | 'path' | 'digest' | 'text';
  readonly group: 'dependencies' | 'statement';
}>;

/**
 * Names the full product CLI will need that this chunk does not implement. They
 * are refused by name rather than accepted and ignored, so what is implemented
 * here stays machine-readable and does not widen by accretion.
 */
export const UNIMPLEMENTED_OPTIONS: ReadonlyList<string>;

/** The help text. It lists only what is implemented. */
export const CLI_USAGE: string;

/**
 * A handler-level refusal. It always means nothing was attempted: no argument
 * list was usable, or an input this handler cannot derive was absent.
 */
export class CliError extends Error {
  readonly name: 'CliError';
  /** One stable code from `CLI_ERROR_CODES`. */
  readonly code: CliErrorCode;
  /** The option the refusal is about, when the refusal is about one option. */
  readonly option?: string;
  /** The input the refusal is about, when the refusal is about an input. */
  readonly input?: string;
  /** The package fields that were absent, when the package was incomplete. */
  readonly missing?: ReadonlyList<string>;
  /** The fields that were not part of the expected shape, when there were any. */
  readonly unexpected?: ReadonlyList<string>;
  /** The chunk that owns the name this handler refused, when there is one. */
  readonly pendingChunk?: 'C6';
  /** The underlying failure, when this refusal wraps one. */
  readonly cause?: unknown;
  /**
   * @param code one of `CLI_ERROR_CODES`
   * @param message human-readable reason
   */
  constructor(code: string, message: string, details?: Record<string, unknown>);
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What the run statement a caller states outside the command line may carry.
 *
 * It is the API's own request fields restricted to the statement, so a field the
 * API does not accept is a type error here before it is a runtime refusal, and a
 * future required request field cannot be smuggled through the handler.
 */
export type CliStatement = Partial<Pick<
  InitRequest,
  'architectureId' | 'architectureKind' | 'harness' | 'securityModel'
  | 'expectedSessionPolicy' | 'declaredCeilingMinutes' | 'configuration' | 'notes' | 'createdAt'
>>;

/** The parsed argument list. Nothing was created by parsing it. */
export interface CliParsedArguments {
  /** Set when help was requested; every other field is then empty. */
  readonly help: boolean;
  /** The single output root, or `null` when help was requested. */
  readonly output: string | null;
  /** The run-statement fields the command line stated; the command line wins. */
  readonly statement: CliStatement;
  /** The dependency request the command line stated. */
  readonly dependencies: CliDependencyArguments;
}

/**
 * The dependency fields expressible on the command line, taken from the API's own
 * dependency request so the two cannot drift apart. Options that belong to no
 * mode — an offline install, for instance — are not offered here at all.
 */
export type CliDependencyArguments = Pick<
  InitDependencyRequest,
  'mode' | 'preparedRoot' | 'sourceRoot' | 'scratchRoot' | 'npmExecutable' | 'expectedDependencyDigest'
>;

/** The result of a help request, which is the only non-run result. */
export interface CliHelpResult {
  readonly help: true;
  readonly usage: string;
}

/** The concise success summary. It restates no digest and adds no claim. */
export interface CliSummary {
  readonly status: 'initialised';
  readonly output: string;
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly workloadDigest: string;
  readonly workloadFileCount: number;
  readonly dependencyMode: DependencyMode;
  readonly dependencyDigest: string | null;
  readonly manifestId: string;
  readonly runId: string;
  readonly durationMs: number;
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parse one argument list. The list is resolved against nothing: no option
 * reads configuration or the environment, an unimplemented name is refused rather
 * than dropped, and an option given twice is refused rather than taken twice.
 *
 * @throws {CliError} see `CLI_ERROR_CODES`
 */
export function parseArguments(argv: ReadonlyList<string>): CliParsedArguments;

/** Everything the handler needs that a machine cannot legitimately supply. */
export interface CliInput {
  /** Arguments after the command name. */
  readonly argv: ReadonlyList<string>;
  /** The accepted challenge package: identity, physical source, boundary. */
  readonly challenge: ChallengePackage;
  /** Supplied, never discovered from an installed tool. */
  readonly toolingIdentity: ToolingIdentity;
  /** Supplied, never discovered from the repository. */
  readonly evaluatorIdentity: EvaluatorIdentity;
  /**
   * Run-statement fields the caller states directly. A field the command line
   * also states is overridden by the command line.
   */
  readonly statement?: CliStatement;
  /** Receives the API result before it is returned. */
  readonly onResult?: (result: InitResult) => void;
}

/** Where output goes, so the handler never assumes a terminal. */
export interface CliSinks {
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
}

/**
 * Run one command line and delegate the whole operation.
 *
 * The three inputs a machine cannot state — the package and the two identities —
 * are required here, so the run's identity is never a side effect of the host it
 * happened to be started on. The API's result is returned unchanged: the handler
 * neither re-decides the outcome nor adds a claim of its own.
 *
 * @throws {CliError} for an unusable request, before anything is attempted
 * @throws {InitError} for whatever the API reports
 */
export function runInit(input: CliInput): Promise<InitResult | CliHelpResult>;

/**
 * Run one command line and report a process exit status.
 *
 * A handler refusal exits `USAGE` because nothing was attempted. An API
 * refusal or failure exits `FAILURE` and is printed with the API's own code,
 * because the API's reason is the reason the caller needs. An error that is
 * neither is reported as internal rather than given a code it did not earn.
 */
export function main(input: CliInput, sinks?: CliSinks): Promise<number>;

/** Condense one result to the fields worth printing. */
export function summariseResult(result: InitResult): CliSummary;
