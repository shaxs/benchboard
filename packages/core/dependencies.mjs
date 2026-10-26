/**
 * BenchBoard core dependency-preparation primitives (C2 / T2).
 *
 * Harness-neutral ES module: imports Node builtins plus the accepted C1 core
 * modules (`identity.mjs`, `paths.mjs`) and nothing else. There is no
 * configuration lookup, no owner-root / user-profile / current-directory
 * default, no registry lookup, no import of the historical `runner/` surface,
 * no import of any DSH module, and no network access in this module itself.
 *
 * Three dependency modes are **explicit**; none of them is ever inferred:
 *
 *  - `none`     — pure decision: executes nothing, touches nothing, hashes
 *                 nothing, and returns a `null` dependency digest.
 *  - `prepared` — copies an **explicitly supplied, compatible** cache into
 *                 `<workspaceRoot>/node_modules` using verified byte copies
 *                 (source hash before, copy hash, source hash after) and an
 *                 ordinary-file-only tree: links, junctions, special files and
 *                 case-insensitive collisions are refused, never materialised.
 *  - `install`  — strictly opt-in: a bounded `npm ci` of an **unchanged copy**
 *                 of the locked source inside an explicitly owned scratch
 *                 directory, using Node argument arrays with `shell: false`.
 *
 * Deliberately absent: any implicit `starter/node_modules`, any implicit
 * project `node_modules`, any global npm cache, and any "copy from the
 * nearest dependency directory" behaviour. Cache compatibility and provenance
 * must be declared by the caller (`cacheProvenance`), are recorded in the
 * returned metadata, and are checked byte-for-byte against the lock.
 *
 * Safety properties asserted by `tests/initialization/dependencies.test.mjs`:
 *  - the dependency digest lives in its own hash domain and a preparation never
 *    changes workload/challenge bytes (source bytes are verified unchanged);
 *  - missing roots, offline requests, non-zero exits, timeouts, unsafe paths and
 *    mutated caches fail closed without damaging caller workspace, source or a
 *    foreign cache;
 *  - cleanup removes only directories this helper created;
 *  - public participant workspaces receive no BenchBoard metadata file unless
 *    the caller explicitly asks for one.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { sha256, hashEntries, createId } from './identity.mjs';
import { validateRelativePath } from './paths.mjs';

/* ============================================================ public surface */

/** Identifier of this module; recorded by callers that persist a provenance. */
export const DEPENDENCIES_MODULE_ID = 'benchboard.core.dependencies';

/** Version of this module's observable contract (additive within a major). */
export const DEPENDENCIES_CONTRACT_VERSION = '1.0.0';

/**
 * Dependency trees are hashed in their **own** domain. It is deliberately not
 * `HASH_ALGORITHM_ID` of `identity.mjs` (the workload domain): a dependency
 * digest must never be mistaken for a workload digest.
 */
export const DEPENDENCY_HASH_ALGORITHM_ID = 'benchboard-dependency-tree-v1';

/** Name of the directory the prepared/installed tree is committed into. */
export const DEPENDENCIES_DIRECTORY_NAME = 'node_modules';

/**
 * Default name of the opt-in metadata record. It is **never** written unless
 * `metadataPath` is supplied, and this module never places it inside a
 * participant workspace: the default candidate check requires the file to sit
 * outside `<workspaceRoot>`.
 */
export const DEPENDENCIES_METADATA_FILE_NAME = '.benchboard-dependencies.json';

/** The exhaustive set of accepted `mode` values. */
export const DEPENDENCY_MODES = Object.freeze(['none', 'prepared', 'install']);

/** Machine-readable, stable, additive, test-assertable rejection reasons. */
export const DEPENDENCY_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_ROOT: 'INVALID_ROOT',
  ROOT_NOT_FOUND: 'ROOT_NOT_FOUND',
  ROOT_NOT_A_DIRECTORY: 'ROOT_NOT_A_DIRECTORY',
  ROOT_IS_FILESYSTEM_ROOT: 'ROOT_IS_FILESYSTEM_ROOT',
  LINK_ANCESTOR: 'LINK_ANCESTOR',
  ROOTS_OVERLAP: 'ROOTS_OVERLAP',
  WORKSPACE_NOT_SCRATCH: 'WORKSPACE_NOT_SCRATCH',
  WORKSPACE_METADATA_PRESENT: 'WORKSPACE_METADATA_PRESENT',
  MODE_NOT_DECLARED: 'MODE_NOT_DECLARED',
  MODE_OPTION_MISMATCH: 'MODE_OPTION_MISMATCH',
  PREPARED_ROOT_REQUIRED: 'PREPARED_ROOT_REQUIRED',
  CACHE_PROVENANCE_REQUIRED: 'CACHE_PROVENANCE_REQUIRED',
  CACHE_LOCK_MISSING: 'CACHE_LOCK_MISSING',
  CACHE_LOCK_MISMATCH: 'CACHE_LOCK_MISMATCH',
  CACHE_DIGEST_MISMATCH: 'CACHE_DIGEST_MISMATCH',
  DEPENDENCY_DIGEST_MISMATCH: 'DEPENDENCY_DIGEST_MISMATCH',
  TARGET_EXISTS: 'TARGET_EXISTS',
  TARGET_PRESENT: 'TARGET_PRESENT',
  STAGING_FAILED: 'STAGING_FAILED',
  SOURCE_CHANGED_DURING_COPY: 'SOURCE_CHANGED_DURING_COPY',
  COPY_VERIFICATION_FAILED: 'COPY_VERIFICATION_FAILED',
  LINK_IN_DEPENDENCY_TREE: 'LINK_IN_DEPENDENCY_TREE',
  SPECIAL_FILE_IN_DEPENDENCY_TREE: 'SPECIAL_FILE_IN_DEPENDENCY_TREE',
  CASE_COLLISION: 'CASE_COLLISION',
  TREE_LIMIT_EXCEEDED: 'TREE_LIMIT_EXCEEDED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  TREE_CHANGED_DURING_READ: 'TREE_CHANGED_DURING_READ',
  NPM_EXECUTABLE_REQUIRED: 'NPM_EXECUTABLE_REQUIRED',
  NPM_EXECUTABLE_NOT_FOUND: 'NPM_EXECUTABLE_NOT_FOUND',
  NPM_COMMAND_STRATEGY_UNSUPPORTED: 'NPM_COMMAND_STRATEGY_UNSUPPORTED',
  NPM_LOCKFILE_REQUIRED: 'NPM_LOCKFILE_REQUIRED',
  NPM_LOCKFILE_MISSING: 'NPM_LOCKFILE_MISSING',
  NPM_LOCKFILE_CHANGED: 'NPM_LOCKFILE_CHANGED',
  SCRATCH_ROOT_REQUIRED: 'SCRATCH_ROOT_REQUIRED',
  OFFLINE_UNSUPPORTED: 'OFFLINE_UNSUPPORTED',
  NPM_SPAWN_FAILED: 'NPM_SPAWN_FAILED',
  NPM_TIMEOUT: 'NPM_TIMEOUT',
  NPM_EXIT_NONZERO: 'NPM_EXIT_NONZERO',
  NPM_OUTPUT_UNBOUNDED: 'NPM_OUTPUT_UNBOUNDED',
  CLEANUP_FAILED: 'CLEANUP_FAILED',
  WORKSPACE_LOCK_MISMATCH: 'WORKSPACE_LOCK_MISMATCH',
  METADATA_PATH_IN_PROTECTED_ROOT: 'METADATA_PATH_IN_PROTECTED_ROOT',
  PUBLICATION_RETAINED: 'PUBLICATION_RETAINED',
  PUBLICATION_PARTIAL: 'PUBLICATION_PARTIAL',
});

/**
 * Recorded policy for executable shims (the `node_modules/.bin/*` entries npm
 * creates, which on Windows are `.cmd` files). The Captain rule is
 * "bounded inside-cache target materialisation/refusal, no silent link
 * weakening". This build implements the **refusal** half: nothing in a
 * dependency tree is ever materialised or followed, so `materialisation` is
 * `refused` and no option weakens that. A future materialising mode must be a
 * separate, separately reviewed contract.
 */
export const NPM_BIN_LINK_POLICY = Object.freeze({
  policyId: 'benchboard-npm-bin-link-v1',
  materialisation: 'refused',
  insideCacheOnly: true,
  resolveTargets: false,
  note: 'Links, junctions and shims inside a dependency tree are refused; they are never materialised or followed.',
});

/** Stable identifier of the command strategy family. */
export const NPM_COMMAND_STRATEGIES = Object.freeze({
  DIRECT: 'direct',
  CMD_EXE: 'cmdexe',
});

/**
 * Bound a single preparation: entry count, per-file bytes, total bytes, npm
 * wall-time and captured output. Every bound is a failure, never a truncation.
 */
export const DEPENDENCY_LIMITS = Object.freeze({
  maxEntries: 40000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  npmTimeoutMs: 120000,
  npmMaxOutputBytes: 4 * 1024 * 1024,
});

/** Environment variable names forwarded to npm, and their source spelling. */
export const NPM_FORWARDED_ENVIRONMENT = Object.freeze(['PATH', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']);

/** Maximum captured tail kept from npm output for diagnostics. */
const OUTPUT_TAIL_BYTES = 4096;

const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTERS = /[\0-\x1F\x7F]/;
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:[\\/]?$/;
const SUPPORTED_NPM_INSTALL_STRATEGIES = Object.freeze(['hoisted', 'nested', 'shallow']);
const COPY_CHUNK_BYTES = 1024 * 1024;

/* ============================================================== error type */

/** Error type thrown for every refusal. `code` is machine-readable and stable. */
export class DependencyError extends Error {
  /**
   * @param {string} code  one of `DEPENDENCY_ERROR_CODES`
   * @param {string} message
   * @param {Record<string, unknown>} [details] non-secret, serialisable context
   */
  constructor(code, message, details = void 0) {
    if (!Object.values(DEPENDENCY_ERROR_CODES).includes(code)) {
      // Guard against a typo turning into an unclassifiable error.
      throw new TypeError(`unknown dependency error code ${JSON.stringify(code)}`);
    }
    super(`${code}: ${message}`);
    this.name = 'DependencyError';
    this.code = code;
    if (details !== void 0) this.details = Object.freeze({ ...details });
  }
}

/* ==================================================== command strategy layer */

/**
 * Decide how an npm invocation must be built for this platform **without**
 * spawning anything, so the Windows `.cmd` question can be tested on any host.
 *
 * The result is always a Node argument array plus `shell: false`. Argument
 * values are validated so no element can smuggle a shell: no C0/C1 control
 * bytes, no quote characters, and no cmd metacharacters when the `cmdexe`
 * strategy carries a command through `cmd.exe /d /c`.
 *
 * @param {{platform?: string, executablePath: string, executableStrategy?: string}} options
 * @returns {{strategy: string, file: string, forwardArguments: string[], wrapForCmdExe: boolean, shell: false, reason: string}}
 */
export function resolveDependencyCommandStrategy(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'resolveDependencyCommandStrategy(options): an options object is required.');
  }
  const platform = options.platform === void 0 ? process.platform : options.platform;
  if (typeof platform !== 'string') {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'resolveDependencyCommandStrategy(options): platform must be a string.');
  }
  const executablePath = requireAbsolutePath(options.executablePath, 'executablePath');
  const requested = options.executableStrategy === void 0 ? 'auto' : options.executableStrategy;
  if (requested !== 'auto' && requested !== NPM_COMMAND_STRATEGIES.DIRECT && requested !== NPM_COMMAND_STRATEGIES.CMD_EXE) {
    throw new DependencyError(
      DEPENDENCY_ERROR_CODES.NPM_COMMAND_STRATEGY_UNSUPPORTED,
      `unknown executableStrategy ${JSON.stringify(requested)}; expected "auto", "${NPM_COMMAND_STRATEGIES.DIRECT}" or "${NPM_COMMAND_STRATEGIES.CMD_EXE}".`,
    );
  }

  const extension = path.extname(executablePath).toLowerCase();
  const isWindows = platform === 'win32';
  const isShim = extension === '.cmd' || extension === '.bat';

  if (!isWindows) {
    if (requested === NPM_COMMAND_STRATEGIES.CMD_EXE) {
      throw new DependencyError(
        DEPENDENCY_ERROR_CODES.NPM_COMMAND_STRATEGY_UNSUPPORTED,
        `executableStrategy "cmdexe" is only applicable on Windows; the running platform is ${JSON.stringify(platform)}.`,
      );
    }
    return Object.freeze({
      strategy: NPM_COMMAND_STRATEGIES.DIRECT,
      file: executablePath,
      forwardArguments: Object.freeze([]),
      wrapForCmdExe: false,
      shell: false,
      reason: isShim
        ? `posix: ${JSON.stringify(extension)} is executed directly (no shell).`
        : 'posix: executed directly (no shell).',
    });
  }

  if (isShim) {
    if (requested === NPM_COMMAND_STRATEGIES.DIRECT) {
      // Documented and asserted host behaviour: CreateProcess on a batch file
      // is not an executable image. Fail closed instead of falling back.
      throw new DependencyError(
        DEPENDENCY_ERROR_CODES.NPM_COMMAND_STRATEGY_UNSUPPORTED,
        `a ${JSON.stringify(extension)} shim cannot be executed with shell:false on Windows; use executableStrategy "cmdexe".`,
        { executablePath },
      );
    }
    return Object.freeze({
      strategy: NPM_COMMAND_STRATEGIES.CMD_EXE,
      file: 'cmd.exe',
      forwardArguments: Object.freeze(['/d', '/c']),
      wrapForCmdExe: true,
      shell: false,
      reason: 'windows shim: cmd.exe /d /c plus per-element arguments; cmd.exe resolves from the inherited PATH.',
    });
  }

  if (requested === NPM_COMMAND_STRATEGIES.CMD_EXE) {
    throw new DependencyError(
      DEPENDENCY_ERROR_CODES.NPM_COMMAND_STRATEGY_UNSUPPORTED,
      `executableStrategy "cmdexe" applies only to a .cmd/.bat shim; ${JSON.stringify(executablePath)} is not one.`,
    );
  }
  return Object.freeze({
    strategy: NPM_COMMAND_STRATEGIES.DIRECT,
    file: executablePath,
    forwardArguments: Object.freeze([]),
    wrapForCmdExe: false,
    shell: false,
    reason: 'windows native image: executed directly (no shell).',
  });
}

/**
 * Build the final argv for a strategy. With `wrapForCmdExe` the command and its
 * arguments are appended as **separate elements** after `cmd.exe /d /c`; every
 * element is re-validated because `cmd.exe` re-parses its command tail.
 *
 * @param {{strategy: string, file: string, forwardArguments: string[], wrapForCmdExe: boolean}} resolved
 * @param {{command: string, args: string[]}} command
 * @returns {{file: string, args: string[], options: {shell: false}}}
 */
export function buildDependencyCommand(resolved, command) {
  if (resolved === null || typeof resolved !== 'object') {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'buildDependencyCommand(resolved, command): a resolved strategy object is required.');
  }
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'buildDependencyCommand(resolved, command): a command object is required.');
  }
  const base = requireAbsolutePath(command.command, 'command.command');
  const args = command.args === void 0 ? [] : command.args;
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'buildDependencyCommand(): command.args must be an array of strings.');
  }
  const wrap = resolved.wrapForCmdExe === true;
  const forward = resolved.forwardArguments === void 0 ? [] : [...resolved.forwardArguments];
  for (const element of forward) {
    if (typeof element !== 'string' || !/^\/[A-Za-z]+$/.test(element)) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'buildDependencyCommand(): forwardArguments must be cmd switches such as "/d".');
    }
  }
  // The executable is never repeated as an argument. For a direct strategy the
  // executable belongs to `file` alone: an argv of `[executable, ...args]` would
  // be read by the child as its own **argv[0]-as-script** (spawning `node.exe`
  // with `["node.exe", "--version"]` makes Node load its own binary as a module
  // and exit with `SyntaxError: Invalid or unexpected token`), so the direct
  // argv is exactly `args`. Under `cmd.exe` the executable is not an argument
  // either; it is the first token of the command tail `cmd.exe` is told to run,
  // and it is quoted there because a real installation path may contain spaces.
  for (const element of [base, ...args]) {
    if (CONTROL_CHARACTERS.test(element)) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, `command element contains a control byte: ${JSON.stringify(element)}`);
    }
    // Quotes would let one element start a new cmd command, and `%` would let
    // one be expanded by cmd before the program ever sees it.
    if (element.includes('"') || element.includes('`') || element.includes('%')) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, `command element contains a quoting or expansion metacharacter: ${JSON.stringify(element)}`);
    }
    if (wrap && (element.includes('&') || element.includes('|') || element.includes('<') || element.includes('>') || element.includes('^') || element.includes('(') || element.includes(')'))) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, `cmd-carried element contains a cmd metacharacter: ${JSON.stringify(element)}`);
    }
  }
  if (wrap) {
    // Measured on this host, not inferred: with the command quoted after
    // `cmd.exe /d /c`, an **argument value that itself contains a space** is
    // split by the command-line parser and the second half is executed as a
    // program (`'C:\Program' is not recognized as an internal or external
    // command`, exit 1). `windowsVerbatimArguments` is what makes the quoted
    // command survive at all, and it passes the remaining elements through
    // unescaped, so a spaced value can not be protected by re-quoting it here.
    // Refusing is therefore the only honest option for the wrapped strategy;
    // the direct strategy has no such limit and carries spaced values intact.
    for (const element of args) {
      if (/\s/.test(element)) {
        throw new DependencyError(
          DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT,
          `the cmdexe strategy can not carry an argument value containing whitespace: ${JSON.stringify(element)}. Use executableStrategy "direct" for a native executable, or pass a value without spaces.`,
          { argument: element, strategy: NPM_COMMAND_STRATEGIES.CMD_EXE },
        );
      }
    }
  }
  return {
    file: String(resolved.file ?? base),
    // Every element is passed as its own argv entry. Under `cmdexe` the shape
    // is `["/d", "/c", "<quoted command>", ...args]`, which is the one ordering
    // measured to launch a shim whose path contains spaces; `/s` is not used,
    // because adding it does not change the parse and only obscures which
    // quoting rule is in force. A direct strategy carries no forwardArguments,
    // no wrapper and no repeated executable, so its argv is exactly `args`.
    args: wrap ? [...forward, `"${base}"`, ...args] : [...forward, ...args],
    // The verbatim flag travels with the built command so the process port
    // cannot lose it: without it Node re-escapes the embedded quotes as `\"`,
    // which `cmd.exe` does not accept, and the invocation fails before the
    // program starts. It is set only where a wrapper exists.
    options: Object.freeze(wrap ? { shell: false, windowsVerbatimArguments: true } : { shell: false }),
  };
}

/* ====================================================== default process port */

/**
 * Create the production `processAdapter`: `spawn` with an argument array and
 * `shell: false`, bounded output, bounded wall-time, kill on timeout.
 *
 * @returns {(request: {file: string, args: string[]}) => Promise<{status, signal, stdout, stderr, spawnError, timedOut}>}
 */
export function createNodeSpawnAdapter(options = {}) {
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEPENDENCY_LIMITS.npmTimeoutMs, 'createNodeSpawnAdapter(): timeoutMs');
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEPENDENCY_LIMITS.npmMaxOutputBytes, 'createNodeSpawnAdapter(): maxOutputBytes');
  const killSignal = options.killSignal === void 0 ? 'SIGTERM' : String(options.killSignal);

  return (request) => new Promise((resolve, reject) => {
    if (request === null || typeof request !== 'object' || typeof request.file !== 'string') {
      reject(new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'processAdapter(request): request.file is required.'));
      return;
    }
    const args = Array.isArray(request.args) ? request.args : [];
    if (args.some((value) => typeof value !== 'string')) {
      reject(new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'processAdapter(request): request.args must be strings.'));
      return;
    }
    const env = request.env === void 0 ? void 0 : toEnvironmentRecord(request.env);
    const cwd = request.cwd === void 0 ? void 0 : requireAbsolutePath(request.cwd, 'request.cwd');
    // The command builder's options are honoured rather than merely carried:
    // `windowsVerbatimArguments` is what lets a quoted command reach `cmd.exe`
    // unescaped. Anything beyond these two switches is a request this adapter
    // will not act on, because a shell or a rewritten argv is the failure mode
    // the whole strategy layer exists to exclude.
    const suppliedOptions = request.options === void 0 ? {} : request.options;
    if (suppliedOptions === null || typeof suppliedOptions !== 'object' || Array.isArray(suppliedOptions)) {
      reject(new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'processAdapter(request): request.options must be a plain object when present.'));
      return;
    }
    for (const name of Object.keys(suppliedOptions)) {
      if (name !== 'shell' && name !== 'windowsVerbatimArguments') {
        reject(new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, `processAdapter(request): request.options.${name} is not honoured by this adapter; only shell:false and windowsVerbatimArguments are supported.`));
        return;
      }
    }
    if (suppliedOptions.shell === true) {
      reject(new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'processAdapter(request): request.options.shell must not be true; a shell is never used.'));
      return;
    }
    const verbatim = suppliedOptions.windowsVerbatimArguments === true;

    let child;
    try {
      child = spawn(request.file, args, {
        shell: false,
        ...(verbatim ? { windowsVerbatimArguments: true } : {}),
        ...(env === void 0 ? {} : { env }),
        ...(cwd === void 0 ? {} : { cwd }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new DependencyError(DEPENDENCY_ERROR_CODES.NPM_SPAWN_FAILED, `spawn(${JSON.stringify(request.file)}) failed: ${error.message}`, { cause: error.code ?? null }));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let captured = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    const collect = (bucket, chunk) => {
      if (captured + chunk.length > maxOutputBytes) {
        overflow = true;
        // Drain without storing so the child is never blocked by a full pipe.
        return;
      }
      captured += chunk.length;
      bucket.push(chunk);
    };
    child.stdout.on('data', (chunk) => { collect(stdoutChunks, chunk); });
    child.stderr.on('data', (chunk) => { collect(stderrChunks, chunk); });
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try { child.kill(killSignal); } catch { /* already gone */ }
    }, timeoutMs);

    let spawnError = null;
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Object.freeze({
        status: status === null ? null : status,
        signal: signal === null ? null : signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        spawnError: spawnError === null ? null : `${spawnError.code ?? spawnError.name}: ${spawnError.message}`,
        timedOut,
        overflow,
      }));
    });
  });
}

/* ============================================================== main service */

/**
 * @typedef {Object} DependencyProcessResult
 * @property {number | null} status                      exit status, null when signalled
 * @property {string | null} signal                      termination signal, null on a clean exit
 * @property {string} stdout                              captured stdout, bounded
 * @property {string} stderr                              captured stderr, bounded
 * @property {string | null} [spawnError]                 present when the process could not start
 * @property {boolean} [timedOut]                         true when the bound expired
 * @property {boolean} [overflow]                         true when captured output exceeded the bound
 */

/**
 * The request a process adapter receives. `options` carries the command-line
 * rule the built command requires: `shell` is always false, and
 * `windowsVerbatimArguments` is true only for a command line meant for `cmd.exe`.
 * An adapter must refuse any option it does not implement rather than ignore it.
 * Settlement promises all process/output writers have stopped; only the declared
 * .npm-cache and node_modules outputs are captured once for cleanup ownership.
 *
 * @typedef {(request: {file: string, args: string[], env: Record<string, string | undefined>, cwd: string, shell: false, options: {shell: false, windowsVerbatimArguments?: true}}) => Promise<DependencyProcessResult>} DependencyProcessAdapter
 */

/**
 * @typedef {Object} DependencyInventoryEntry
 * @property {string} path     POSIX-relative path inside the dependency tree
 * @property {number} bytes    byte length of the file
 * @property {string} sha256   lowercase SHA-256 of the file bytes
 */

/**
 * @typedef {Object} DependencyInventory
 * @property {string | null} mode
 * @property {string} hashAlgorithmId
 * @property {string | null} root
 * @property {DependencyInventoryEntry[]} entries
 * @property {string | null} digest
 * @property {number} totalBytes
 */

/**
 * @typedef {Object} DependencyRecord
 * @property {string} schemaVersion
 * @property {string} module
 * @property {string} hashAlgorithmId
 * @property {'none' | 'prepared' | 'install'} mode
 * @property {string} workspaceRoot
 * @property {string | null} dependencyDirectory
 * @property {Readonly<Record<string, unknown>> | null} provenance
 * @property {Readonly<Record<string, unknown>> | null} npm
 * @property {boolean} persisted
 * @property {string | null} metadataPath
 * @property {boolean} executed
 * @property {number} copiedFiles
 * @property {number} copiedBytes
 * @property {Readonly<string[]>} cleanedUp
 */

/**
 * @typedef {Object} PrepareDependenciesOptions
 * @property {'none' | 'prepared' | 'install'} mode        required, never inferred
 * @property {string} workspaceRoot                        absolute caller-owned scratch root
 * @property {string} [preparedRoot]                       mode "prepared": explicit compatible cache
 * @property {string} [cacheDigest]                        mode "prepared": expected cache digest
 * @property {string} [sourceRoot]                         locked source root, outside the workspace
 * @property {string} [scratchRoot]                        mode "install": helper-owned scratch root
 * @property {string} [npmExecutable]                      mode "install": absolute executable, no PATH lookup
 * @property {'auto' | 'direct' | 'cmdexe'} [executableStrategy]
 * @property {'hoisted' | 'nested' | 'shallow'} [installStrategy] link-free npm install strategies; default `hoisted`
 * @property {string | boolean} [offline]
 * @property {string} [expectedDependencyDigest]
 * @property {string} [metadataPath]                       outside the participant workspace
 * @property {string} [lockfileName]
 * @property {string} [manifestFileName]
 * @property {number} [maxEntries]
 * @property {number} [maxFileBytes]
 * @property {number} [maxTotalBytes]
 * @property {number} [timeoutMs]
 * @property {string[]} [npmArgumentsPrefix]
 * @property {string[]} [npmArgumentsSuffix]
 * @property {Record<string, string>} [environment]
 * @property {string} [platform]
 * @property {DependencyProcessAdapter} [processAdapter]
 */

/**
 * @typedef {Object} PrepareDependenciesResult
 * @property {'none' | 'prepared' | 'install'} mode
 * @property {string | null} dependencyDigest
 * @property {DependencyInventory} inventory
 * @property {DependencyRecord} metadata
 */

/**
 * Prepare the dependencies of a caller-owned scratch workspace.
 *
 * @param {PrepareDependenciesOptions} options
 * @returns {Promise<PrepareDependenciesResult>}
 */
export async function prepareDependencies(options) {
  const input = normaliseOptions(options);

  /* ------------------------------------------------------------- mode: none */
  if (input.mode === 'none') {
    // Proves "executes nothing": the option set is frozen before this point,
    // and no fs, hash or process port call happens below.
    return Object.freeze({
      mode: 'none',
      dependencyDigest: null,
      inventory: emptyInventory('none'),
      metadata: Object.freeze({
        schemaVersion: DEPENDENCIES_CONTRACT_VERSION,
        module: DEPENDENCIES_MODULE_ID,
        hashAlgorithmId: DEPENDENCY_HASH_ALGORITHM_ID,
        mode: 'none',
        workspaceRoot: input.workspaceRoot,
        dependencyDirectory: null,
        provenance: null,
        npm: null,
        persisted: false,
        metadataPath: null,
        executed: false,
        copiedFiles: 0,
        copiedBytes: 0,
        cleanedUp: [],
      }),
    });
  }

  const facts = inspectWorkspace(input.workspaceRoot);
  if (input.mode === 'prepared') {
    return await prepareFromCache(input, facts);
  }
  return await prepareByInstall(input, facts);
}

/* ================================================================ preparation */

/** `prepared`: verified ordinary-file copy of an explicitly compatible cache. */
async function prepareFromCache(input, facts) {
  const preparedRoot = requireAbsolutePath(input.preparedRoot, 'preparedRoot');
  assertNoLinkAncestor(preparedRoot, 'preparedRoot');
  const preparedFacts = describeRoot(preparedRoot, 'preparedRoot');
  assertDisjoint([
    { label: 'workspaceRoot', path: input.workspaceRoot },
    { label: 'preparedRoot', path: preparedRoot },
  ]);

  const provenance = readCacheProvenance(preparedRoot);
  const lockPair = assertCacheLockCompatible(preparedRoot, provenance, input);

  const target = path.join(input.workspaceRoot, DEPENDENCIES_DIRECTORY_NAME);
  if (fs.existsSync(target) || pathExistsNoFollow(target)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.TARGET_EXISTS, `refusing to prepare dependencies because ${JSON.stringify(target)} already exists; this helper never merges into or overwrites an existing dependency directory.`, { target });
  }

  // One bound set for the cache, used by the first read, by the identity read
  // and by every later re-verification: re-checking a cache under different bounds
  // than the ones that authorised it would not be a re-check of the same proof.
  const preparedLimits = treeLimits(input, 'preparedRoot');
  const cacheInventory = readDependencyTree(preparedRoot, preparedLimits);
  const cacheDigest = digestOfInventory(cacheInventory);
  // The cache is read once, and that one read is the only thing the copy is
  // asked to reproduce. Because a digest describes bytes and not paths, a path
  // the inventory does not name — the provenance marker, which the tree limits
  // deliberately exclude, and any path that appears, disappears or changes kind
  // while the copy runs — has to be pinned some other way. The identity pinned
  // here is therefore the inventory digest (every byte the copy will make), the
  // tree fingerprint (the kind and size of every path under the cache root), and
  // the marker's own bytes, and it is compared at the four points where a change
  // still matters: before the copy, after the copy, between the copy and the
  // commit, and before the result is reported. A change after the commit is a
  // different object and is caught by the committed-tree proof below.
  const cacheIdentity = readCacheIdentity(preparedRoot, cacheInventory, preparedLimits);
  if (input.cacheDigest !== void 0 && input.cacheDigest !== cacheDigest) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_DIGEST_MISMATCH, 'the prepared cache no longer matches the digest the caller expected for its provenance.', { expected: input.cacheDigest, actual: cacheDigest });
  }
  if (input.expectedDependencyDigest !== void 0 && input.expectedDependencyDigest !== cacheDigest) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.DEPENDENCY_DIGEST_MISMATCH, 'the prepared cache digest does not match the expected dependency digest.', { expected: input.expectedDependencyDigest, actual: cacheDigest });
  }

  const stagingRoot = path.join(input.workspaceRoot, '.benchboard-tmp');
  const stagingRootCreated = ensureManagedDirectory(stagingRoot, input.workspaceRoot);
  const stagingRootIdentity = stagingRootCreated ? ownedPathRecord(stagingRoot) : null;
  // The staging area is created **outside** the publication name and the
  // verified tree is staged in a sub-directory of it. Staging under the
  // publication name would mean creating `node_modules` before the
  // does-it-already-exist proof, which would silently convert a foreign
  // directory into one this call appears to own, and would let a later failure
  // remove a directory it never wrote.
  const staging = fs.mkdtempSync(path.join(stagingRoot, 'deps-'), { recursive: false });
  const staged = path.join(staging, DEPENDENCIES_DIRECTORY_NAME);
  const created = [staging];
  const cleaned = [];
  // Declared outside the try so the copy report is still in scope when the
  // metadata record is built after the commit.
  let copyReport = { files: 0, bytes: 0, directories: [] };
  const stagingIdentities = new Map();
  recordOwnedPath(stagingIdentities, staging, staging);
  let publication = null;
  let publicationIdentity = null;
  let committed = null;
  try {
    fs.mkdirSync(staged);
    created.push(staged);
    recordOwnedPath(stagingIdentities, staged, staging);
    // Bound check 1: the cache is still the object the inventory describes
    // before a single byte of it is copied.
    assertCacheInventoryUnchanged(cacheIdentity, preparedRoot, preparedLimits, 'before the copy started');
    copyReport = copyVerifiedTree(preparedRoot, cacheInventory, staged, { maxFileBytes: input.limits.maxFileBytes }, stagingIdentities, staging);
    const stagedInventory = readDependencyTree(staged, treeLimits(input, 'staged'));
    if (stagedInventory.digest !== cacheDigest) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.COPY_VERIFICATION_FAILED, 'the staged copy does not reproduce the cache inventory.', { cache: cacheDigest, staged: stagedInventory.digest });
    }
    // Bound check 2: the copy reproduced the bound bytes, but that only proves
    // the cache was unchanged up to each individual read. A path added, removed or
    // mutated while the copy walked the tree has to be caught before the result
    // is trusted, or a tree that never existed as a whole is certified.
    assertCacheInventoryUnchanged(cacheIdentity, preparedRoot, preparedLimits, 'while the copy was running');
    // Claim, then commit, then prove. The claim is the atomic existence proof,
    // the commit moves only verified staged bytes, and the proof re-inventories
    // what is now published. The locked source and the workspace's own lock
    // pair are re-read at the moment the bytes are in place, so a byte that
    // moved while the copy ran is caught instead of being published under a
    // digest that does not describe it.
    if (claimPublicationDirectory(target) === 'occupied') {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.TARGET_EXISTS, `the dependency directory appeared during preparation: ${JSON.stringify(target)}`, { target });
    }
    publication = target;
    publicationIdentity = ownedPathRecord(target);
    // Bound check 3: this is the last instant at which refusing still leaves the
    // caller's workspace exactly as it was, because the verified bytes are not in
    // the publication name yet. A cache that moved after the copy is therefore
    // refused here, before the commit, rather than after it.
    assertCacheInventoryUnchanged(cacheIdentity, preparedRoot, preparedLimits, 'between the copy and the commit');
    assertTrackedSourcesUnchanged([lockPair.sourceObservation, lockPair.sourceManifestObservation, ...lockPair.workspaceObservations], 'while the dependency tree was being staged');
    committed = commitVerifiedStaging(staged, target, cacheDigest, { limits: treeLimits(input, 'node_modules'), phase: 'of the prepared copy' });
    // The staged directory no longer exists after the commit; drop it.
    created.splice(created.indexOf(staged), 1);
    // The staging tree this call staged is exactly the verified tree that was just
    // published: its digest was proven equal to the cache digest above, so every
    // byte here is one this operation can show it wrote. Feeding those recorded
    // identities lets the retirement remove precisely the bytes it created and
    // the now-empty directories it made, while a byte that is not one of these is
    // left standing rather than deleted — the recursive remove this replaces used
    // to erase a foreign byte silently. On the rename branch `staged` is already
    // gone, so only the empty staging root remains and the empty-only rule retires it.
    removeCreated(staging, stagingRoot, cleaned, 'staging root', stagingIdentities);
  } catch (error) {
    reportPublicationFate(error, publication, input, cacheDigest, cleaned, publicationIdentity);
    cleanupCreated(created, staging, stagingRoot, cleaned, stagingIdentities, input.limits);
    throw decorateCleanup(error, cleaned);
  } finally {
    // Only a staging root this call created is retired, and only once it is
    // empty, so a caller-owned directory of the same name is never removed.
    if (stagingRootCreated) {
      removeIfEmpty(stagingRoot, input.workspaceRoot, cleaned, stagingRootIdentity);
    }
  }

  try {
    // Bound check 4: the success report states that the cache matched at every
    // phase of the operation, so it is re-asserted on the way out. The cache
    // identity is never trusted further than the last moment it was read, and a
    // report about bytes that are in place does not become a licence to stop
    // checking the input they came from.
    assertCacheInventoryUnchanged(cacheIdentity, preparedRoot, preparedLimits, 'before the result was reported');

    const finalInventory = readDependencyTree(target, treeLimits(input, 'node_modules'));
    if (finalInventory.digest !== cacheDigest) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.COPY_VERIFICATION_FAILED, 'the committed dependency directory does not match the verified cache inventory.', { cache: cacheDigest, committed: finalInventory.digest });
    }

    const metadata = Object.freeze({
      schemaVersion: DEPENDENCIES_CONTRACT_VERSION,
      module: DEPENDENCIES_MODULE_ID,
      hashAlgorithmId: DEPENDENCY_HASH_ALGORITHM_ID,
      mode: 'prepared',
      workspaceRoot: input.workspaceRoot,
      dependencyDirectory: DEPENDENCIES_DIRECTORY_NAME,
      provenance: provenance.record,
      npm: null,
      persisted: false,
      metadataPath: null,
      executed: false,
      copiedFiles: copyReport.files,
      copiedBytes: copyReport.bytes,
      cleanedUp: Object.freeze([...cleaned]),
    });
    const withMetadata = await maybePersistMetadata(metadata, input);
    return Object.freeze({
      mode: 'prepared',
      dependencyDigest: finalInventory.digest,
      inventory: finalInventory.view,
      metadata: withMetadata,
    });
  } catch (error) {
    const failure = decorateCleanup(error, cleaned, null);
    reportPublicationFate(failure, publication, input, cacheDigest, cleaned, publicationIdentity);
    throw failure;
  }
}

/** `install`: bounded `npm ci` of an unchanged lock copy in owned scratch. */
async function prepareByInstall(input, facts) {
  if (input.offline === true) {
    // No cache-copy path exists, so "offline" has no honest meaning here.
    throw new DependencyError(DEPENDENCY_ERROR_CODES.OFFLINE_UNSUPPORTED, 'offline: true is refused for mode "install": installing offline would require an implicit cache, and no cache is consulted. Use mode "prepared" with an explicit preparedRoot.', { mode: 'install' });
  }

  const executablePath = requireAbsolutePath(input.npmExecutable, 'npmExecutable');
  if (!pathExistsNoFollow(executablePath)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.NPM_EXECUTABLE_NOT_FOUND, `npmExecutable does not exist: ${JSON.stringify(executablePath)}`, { executablePath });
  }
  const sourceRoot = requireAbsolutePath(input.sourceRoot, 'sourceRoot');
  assertNoLinkAncestor(sourceRoot, 'sourceRoot');
  describeRoot(sourceRoot, 'sourceRoot');
  const scratchRoot = requireAbsolutePath(input.scratchRoot, 'scratchRoot');
  assertNoLinkAncestor(scratchRoot, 'scratchRoot');
  describeRoot(scratchRoot, 'scratchRoot');
  assertDisjoint([
    { label: 'workspaceRoot', path: input.workspaceRoot },
    { label: 'sourceRoot', path: sourceRoot },
    { label: 'scratchRoot', path: scratchRoot },
  ]);
  if (contains(input.workspaceRoot, sourceRoot)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.ROOTS_OVERLAP, 'sourceRoot must not be inside workspaceRoot: the locked source belongs outside the participant workspace.', { sourceRoot });
  }

  const lockName = input.lockfileName ?? 'package-lock.json';
  const manifestName = input.manifestFileName ?? 'package.json';
  if (typeof lockName !== 'string' || typeof manifestName !== 'string' || lockName === '' || manifestName === '' || lockName.includes('/') || manifestName.includes('/') || lockName.includes('\\') || manifestName.includes('\\')) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'lockfileName and manifestFileName must be single path segments.');
  }
  const sourceLock = path.join(sourceRoot, lockName);
  const sourceManifest = path.join(sourceRoot, manifestName);
  const lockBytes = readSourceBytes(sourceLock, DEPENDENCY_ERROR_CODES.NPM_LOCKFILE_MISSING, 'the locked dependency source is missing');
  const manifestBytes = readSourceBytes(sourceManifest, DEPENDENCY_ERROR_CODES.NPM_LOCKFILE_MISSING, 'the package manifest of the locked dependency source is missing');
  const lockDigest = sha256(lockBytes);
  const manifestDigest = sha256(manifestBytes);

  const target = path.join(input.workspaceRoot, DEPENDENCIES_DIRECTORY_NAME);
  if (pathExistsNoFollow(target)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.TARGET_EXISTS, `refusing to install because ${JSON.stringify(target)} already exists; this helper never merges into or overwrites an existing dependency directory.`, { target });
  }

  const stagingRoot = path.join(input.scratchRoot, '.benchboard-install');
  const stagingRootCreated = ensureManagedDirectory(stagingRoot, input.scratchRoot);
  const stagingRootIdentity = stagingRootCreated ? ownedPathRecord(stagingRoot) : null;
  const staging = fs.mkdtempSync(path.join(stagingRoot, 'install-'), { recursive: false });
  const created = [staging];
  const cleaned = [];
  const scratchInside = (candidate) => contains(staging, candidate);
  let commandReport = null;
  let publication = null;
  let publicationIdentity = null;
  let committed = null;
  let stagedLockObservation = null;
  let stagedManifestObservation = null;
  let sourceLockObservation = null;
  let sourceManifestObservation = null;
  const stagingIdentities = new Map();
  recordOwnedPath(stagingIdentities, staging, staging);
  try {
    const stagedLock = path.join(staging, lockName);
    const stagedManifest = path.join(staging, manifestName);
    for (const [file, bytes, digest] of [[stagedLock, lockBytes, lockDigest], [stagedManifest, manifestBytes, manifestDigest]]) {
      const fd = fs.openSync(file, 'wx');
      try {
        recordOwnedPath(stagingIdentities, file, staging, null, fs.fstatSync(fd, { bigint: true }));
        fs.writeFileSync(fd, bytes);
        const key = path.relative(staging, file).split(path.sep).join('/');
        stagingIdentities.set(key, Object.freeze({ ...stagingIdentities.get(key), digest }));
      } finally { fs.closeSync(fd); }
    }
    // The staged copies are bound to the source digests by reading them back
    // once, and that single read is what the post-run re-check compares
    // against: the staged bytes are the verified bytes from here on.
    stagedLockObservation = readTrackedSourceFile(stagedLock, {
      code: DEPENDENCY_ERROR_CODES.COPY_VERIFICATION_FAILED,
      message: 'the staged copy of the locked source lock could not be read back',
      role: 'staged lock',
      required: true,
    });
    stagedManifestObservation = readTrackedSourceFile(stagedManifest, {
      code: DEPENDENCY_ERROR_CODES.COPY_VERIFICATION_FAILED,
      message: 'the staged copy of the locked source manifest could not be read back',
      role: 'staged package manifest',
      required: true,
    });
    if (stagedLockObservation.digest !== lockDigest || stagedManifestObservation.digest !== manifestDigest) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.COPY_VERIFICATION_FAILED, 'the staged copy of the locked source does not match the source bytes.', {});
    }
    sourceLockObservation = readTrackedSourceFile(sourceLock, {
      code: DEPENDENCY_ERROR_CODES.NPM_LOCKFILE_MISSING,
      message: 'the locked dependency source lock could not be read',
      role: 'source lock',
      required: true,
    }, lockBytes);
    sourceManifestObservation = readTrackedSourceFile(sourceManifest, {
      code: DEPENDENCY_ERROR_CODES.NPM_LOCKFILE_MISSING,
      message: 'the locked source package manifest could not be read',
      role: 'source package manifest',
      required: true,
    }, manifestBytes);

    const resolved = resolveDependencyCommandStrategy({
      platform: input.platform,
      executablePath,
      executableStrategy: input.executableStrategy,
    });
    const args = [
      ...input.npmArgumentsPrefix,
      'ci',
      `--lockfile=${lockName}`,
      `--install-strategy=${input.installStrategy}`,
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--no-update-check',
      ...(input.offline === false ? ['--offline=false'] : []),
      ...input.npmArgumentsSuffix,
    ];
    const built = buildDependencyCommand(resolved, { command: executablePath, args });
    const adapter = input.processAdapter ?? createNodeSpawnAdapter({ timeoutMs: input.timeoutMs });
    // A helper-owned npm cache inside the staging directory: the install can
    // never write into a user or global cache, and the whole directory is
    // removed with the staging area afterwards.
    const cacheDirectory = path.join(staging, '.npm-cache');
    fs.mkdirSync(cacheDirectory);
    created.push(cacheDirectory);
    recordOwnedPath(stagingIdentities, cacheDirectory, staging);
    const environment = buildNpmEnvironment(input.environment, cacheDirectory);
    const request = Object.freeze({
      file: built.file,
      args: built.args,
      env: environment,
      cwd: staging,
      shell: false,
      // Carried through to the process port, which enforces it: `cmd.exe` must
      // receive its command tail unescaped, so the verbatim flag is part of the
      // request and not something an adapter may choose.
      options: Object.freeze({ ...built.options }),
    });
    const outcome = await adapter(request);
    // Only these two directories are declared process-output surfaces. Bind
    // their ordinary bytes after the process has settled; unrelated staging
    // entries remain foreign and are never swept into a cleanup identity map.
    for (const outputName of ['.npm-cache', DEPENDENCIES_DIRECTORY_NAME]) {
      const outputRoot = path.join(staging, outputName);
      if (!pathExistsNoFollow(outputRoot)) continue;
      const outputInventory = readDependencyTree(outputRoot, treeLimits(input, outputName));
      captureSettledOutput(outputRoot, outputInventory, stagingIdentities, staging);
    }
    commandReport = describeCommand(resolved, built, request, outcome, input.timeoutMs);
    if (typeof outcome !== 'object' || outcome === null) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.NPM_SPAWN_FAILED, 'the process adapter must resolve with a result object.', {});
    }
    if (outcome.timedOut === true) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.NPM_TIMEOUT, `the dependency installation exceeded ${String(input.timeoutMs)}ms and was terminated (signal ${JSON.stringify(outcome.signal ?? null)}).`, commandReport);
    }
    if (typeof outcome.spawnError === 'string' && outcome.spawnError.length > 0) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.NPM_SPAWN_FAILED, `the dependency installation could not be started: ${outcome.spawnError}`, commandReport);
    }
    if (outcome.status !== 0) {
      throw new DependencyError(
        DEPENDENCY_ERROR_CODES.NPM_EXIT_NONZERO,
        `the dependency installation exited with ${JSON.stringify(outcome.status)} (signal ${JSON.stringify(outcome.signal ?? null)}); npm output tail: ${tail(outcome.stderr)}${outcome.stdout === '' ? '' : ` | stdout tail: ${tail(outcome.stdout)}`}`,
        commandReport,
      );
    }

    // Every lock-family byte the install is built on must still be the byte
    // the run started from, and that includes the **staged manifest**: the
    // adapter runs with this directory as its working directory, so a manifest
    // it rewrites is a rewrite of the input the resulting tree is claimed to
    // describe. Each side is checked in the place it lives, because a change
    // in staging and a change in the source are different failures with
    // different owners.
    recheckTrackedSourceFile(stagedLockObservation, 'during installation');
    recheckTrackedSourceFile(stagedManifestObservation, 'during installation');
    recheckTrackedSourceFile(sourceLockObservation, 'during installation');
    recheckTrackedSourceFile(sourceManifestObservation, 'during installation');

    const stagedDependencies = path.join(staging, DEPENDENCIES_DIRECTORY_NAME);
    if (!pathExistsNoFollow(stagedDependencies)) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.NPM_EXIT_NONZERO, 'the dependency installation reported success but created no node_modules directory.', commandReport);
    }
    const stagedInventory = readDependencyTree(stagedDependencies, treeLimits(input, 'staged node_modules'));
    const stagedDigest = digestOfInventory(stagedInventory);
    // A pinned expectation is verified before anything is committed: a caller
    // that authorised specific dependency bytes must not receive a committed
    // tree it did not authorise, not even momentarily.
    if (input.expectedDependencyDigest !== void 0 && input.expectedDependencyDigest !== stagedDigest) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.DEPENDENCY_DIGEST_MISMATCH, 'the installed dependency digest does not match the expected dependency digest; nothing was committed.', { expected: input.expectedDependencyDigest, actual: stagedDigest });
    }
    // Claim, then commit, then prove — the same order the prepared path uses,
    // with one install-specific difference: the tree the adapter produced is
    // the caller's data, so when the claim finds the name occupied nothing of
    // it is touched. The proof is that the published digest is the staged
    // digest: the tree that was examined is the tree that is published.
    if (claimPublicationDirectory(target) === 'occupied') {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.TARGET_EXISTS, `the dependency directory appeared during installation: ${JSON.stringify(target)}`, { target });
    }
    publication = target;
    publicationIdentity = ownedPathRecord(target);
    committed = commitVerifiedStaging(stagedDependencies, target, stagedDigest, { limits: treeLimits(input, 'node_modules'), phase: 'of the installed tree' });
    // The staged dependency tree was never a separate member of `created`;
    // do not splice(-1), which would drop the cache's ownership record.
    // What is left in the staging area is exactly what this call wrote there:
    // the two staged lock-family files, whose bytes the re-checks above proved
    // unchanged since they were written, plus any directory the install itself
    // was given as its own cache. The dependency tree that was published is no
    // longer here, so the identity map is built from what is still claimed to be
    // present. Feeding it turns the retirement into a check rather than a delete:
    // a byte that is not one of these recorded bytes is left standing and
    // reported as residue instead of being erased by a recursive remove.
    removeCreated(staging, stagingRoot, cleaned, 'installation staging directory', stagingIdentities);
  } catch (error) {
    // Distinguish the one failure a caller can not recover from by retrying:
    // bytes that are already in place. A publication this call claimed and
    // that holds the verified tree is reported as retained, because removing
    // it would destroy a good install. A publication holding other bytes is a
    // partial publication of this call and is removed.
    reportPublicationFate(error, publication, input, committed === null ? null : committed.digest, cleaned, publicationIdentity);
    cleanupCreated(created, staging, stagingRoot, cleaned, stagingIdentities, input.limits);
    throw decorateCleanup(error, cleaned, commandReport);
  } finally {
    // Only an installation staging root this call created is retired, and only
    // once it is empty, so a caller-owned directory is never removed.
    if (stagingRootCreated) {
      removeIfEmpty(stagingRoot, input.scratchRoot, cleaned, stagingRootIdentity);
    }
  }

  try {
    const finalInventory = readDependencyTree(target, treeLimits(input, 'node_modules'));
    const provenance = Object.freeze({
      sourceRoot,
      lockfileName: lockName,
      manifestFileName: manifestName,
      lockDigest,
      manifestDigest,
      installStrategy: input.installStrategy,
      npmExecutable: executablePath,
    });
    const metadata = Object.freeze({
      schemaVersion: DEPENDENCIES_CONTRACT_VERSION,
      module: DEPENDENCIES_MODULE_ID,
      hashAlgorithmId: DEPENDENCY_HASH_ALGORITHM_ID,
      mode: 'install',
      workspaceRoot: input.workspaceRoot,
      dependencyDirectory: DEPENDENCIES_DIRECTORY_NAME,
      provenance,
      npm: commandReport,
      persisted: false,
      metadataPath: null,
      executed: true,
      copiedFiles: finalInventory.entries.length,
      copiedBytes: finalInventory.totalBytes,
      cleanedUp: Object.freeze([...cleaned]),
    });
    const withMetadata = await maybePersistMetadata(metadata, input);
    return Object.freeze({
      mode: 'install',
      dependencyDigest: finalInventory.digest,
      inventory: finalInventory.view,
      metadata: withMetadata,
    });
  } catch (error) {
    const failure = decorateCleanup(error, cleaned, commandReport);
    reportPublicationFate(failure, publication, input, committed === null ? null : committed.digest, cleaned, publicationIdentity);
    throw failure;
  }
}

/* ========================================================= tree verification */

/**
 * Read a dependency tree: every regular file with its size and SHA-256, plus
 * the domain digest. Links, special files, case collisions and bound breaches
 * are refused. Entries and digests are verified twice against the tree
 * fingerprint so a mutation during the read cannot be missed.
 */
/** Bounds for one tree read, taken from the validated `limits` object. */
function treeLimits(input, rootLabel) {
  const limits = input.limits;
  return {
    maxEntries: limits.maxEntries,
    maxFileBytes: limits.maxFileBytes,
    maxTotalBytes: limits.maxTotalBytes,
    rootLabel,
    mode: input.mode,
    // The cache provenance marker is metadata about the tree, not a byte of
    // it: excluding it keeps the digest portable across machines (a prepared
    // copy of an installed cache reproduces the install digest) and keeps the
    // marker, which records caller-absolute paths, out of any participant
    // workspace.
    excludeRootNames: Object.freeze([DEPENDENCIES_METADATA_FILE_NAME]),
  };
}

function readDependencyTree(root, limits) {
  const entries = [];
  const seenCase = new Map();
  let totalBytes = 0;
  const excluded = limits.excludeRootNames ?? [];
  const visit = (directory, relativeDirectory) => {
    let names;
    try {
      names = fs.readdirSync(directory);
    } catch (error) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.ROOT_NOT_FOUND, `cannot read ${limits.rootLabel} directory ${JSON.stringify(directory)}: ${error.message}`);
    }
    names.sort();
    for (const name of names) {
      if (relativeDirectory === '' && excluded.includes(name)) {
        continue;
      }
      if (CONTROL_CHARACTERS.test(name)) {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, `${limits.rootLabel}: entry ${JSON.stringify(name)} contains a control byte.`);
      }
      if (name === '.' || name === '..') {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, `${limits.rootLabel}: redundant entry ${JSON.stringify(name)}.`);
      }
      const absolute = path.join(directory, name);
      const relative = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
      let status;
      try {
        status = fs.lstatSync(absolute);
      } catch (error) {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.TREE_CHANGED_DURING_READ, `${limits.rootLabel}: ${JSON.stringify(relative)} vanished during the read: ${error.message}`);
      }
      if (status.isSymbolicLink()) {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.LINK_IN_DEPENDENCY_TREE, `${limits.rootLabel}: symbolic links are refused inside a dependency tree: ${JSON.stringify(relative)}. ${NPM_BIN_LINK_POLICY.note}`, { relative, policy: NPM_BIN_LINK_POLICY });
      }
      const caseKey = caseFoldKey(relative);
      const previous = seenCase.get(caseKey);
      if (previous !== void 0 && previous !== relative) {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.CASE_COLLISION, `${limits.rootLabel}: ${JSON.stringify(relative)} collides case-insensitively with ${JSON.stringify(previous)}.`, { relative, previous });
      }
      seenCase.set(caseKey, relative);
      if (status.isDirectory()) {
        if (entries.length >= limits.maxEntries) {
          throw new DependencyError(DEPENDENCY_ERROR_CODES.TREE_LIMIT_EXCEEDED, `${limits.rootLabel}: more than ${String(limits.maxEntries)} entries.`, { maxEntries: limits.maxEntries });
        }
        if (fs.realpathSync(absolute) === fs.realpathSync(root)) {
          throw new DependencyError(DEPENDENCY_ERROR_CODES.LINK_IN_DEPENDENCY_TREE, `${limits.rootLabel}: ${JSON.stringify(relative)} resolves to the tree root (a bind or junction loop).`, { relative });
        }
        visit(absolute, relative);
        continue;
      }
      if (!status.isFile()) {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.SPECIAL_FILE_IN_DEPENDENCY_TREE, `${limits.rootLabel}: only regular files are accepted, ${JSON.stringify(relative)} is not one (mode ${status.mode.toString(8)}).`, { relative });
      }
      if (status.size > limits.maxFileBytes) {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.FILE_TOO_LARGE, `${limits.rootLabel}: ${JSON.stringify(relative)} is ${String(status.size)} bytes, above the ${String(limits.maxFileBytes)} byte bound.`, { relative, size: status.size });
      }
      totalBytes += status.size;
      if (totalBytes > limits.maxTotalBytes) {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.TREE_LIMIT_EXCEEDED, `${limits.rootLabel}: the tree exceeds the ${String(limits.maxTotalBytes)} byte bound.`, { maxTotalBytes: limits.maxTotalBytes });
      }
      if (entries.length >= limits.maxEntries) {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.TREE_LIMIT_EXCEEDED, `${limits.rootLabel}: more than ${String(limits.maxEntries)} entries.`, { maxEntries: limits.maxEntries });
      }
      let bytes;
      try {
        bytes = fs.readFileSync(absolute);
      } catch (error) {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.TREE_CHANGED_DURING_READ, `${limits.rootLabel}: ${JSON.stringify(relative)} could not be read: ${error.message}`);
      }
      if (bytes.length !== status.size) {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.TREE_CHANGED_DURING_READ, `${limits.rootLabel}: ${JSON.stringify(relative)} changed size during the read (${String(status.size)} -> ${String(bytes.length)}).`, { relative });
      }
      entries.push(Object.freeze({ path: validateRelativePath(relative), bytes: bytes.length, sha256: sha256(bytes) }));
    }
  };
  // Structural fingerprint before the walk; the same fingerprint is taken after
  // it, so an addition, removal, mode, size or mtime change during the read is
  // caught. Comparing this against the entry digest would be meaningless: they
  // describe different things.
  const fingerprintBefore = fingerprintOfTree(root, excluded);
  visit(root, '');
  const fingerprintAfter = fingerprintOfTree(root, excluded);
  if (fingerprintBefore !== fingerprintAfter) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.TREE_CHANGED_DURING_READ, `${limits.rootLabel}: the tree changed while it was being inventoried; nothing was copied.`, { root });
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const digest = digestOfEntries(entries);
  const fingerprint = fingerprintOfEntries(entries);
  const sortedEntries = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
  return {
    entries: entries.map((entry) => ({ ...entry })),
    digest,
    totalBytes,
    fingerprint,
    view: Object.freeze({
      mode: limits.mode ?? null,
      hashAlgorithmId: DEPENDENCY_HASH_ALGORITHM_ID,
      root: toDisplayPath(root),
      entries: sortedEntries,
      digest,
      totalBytes,
    }),
  };
}

/**
 * Copy an inventory into `destination`, verifying bytes before and after.
 *
 * The directories this copy creates are reported, deepest path first, so a
 * failure can retire the scaffolding it made without touching a directory it
 * did not make. Reporting them in creation order would mean removing a parent
 * while a child made in the same loop still stands inside it, which on every
 * platform either fails or becomes a recursive delete of a subtree that a
 * third party may have written into since. The files themselves need no such
 * report: each is written `wx` into a directory proven empty of that name just
 * before, so its existence is identical to having created it.
 *
 * @returns {{files: number, bytes: number, directories: string[]}}
 */
function copyVerifiedTree(sourceRoot, inventory, destination, limits, identities = null, identityRoot = destination) {
  let files = 0;
  let bytes = 0;
  /** @type {string[]} */
  const directories = [];
  const made = new Set();
  for (const entry of inventory.entries) {
    const source = path.join(sourceRoot, ...entry.path.split('/'));
    let before;
    try {
      before = sha256(fs.readFileSync(source));
    } catch (error) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.TREE_CHANGED_DURING_READ, `cache file ${JSON.stringify(entry.path)} could not be read before the copy: ${error.message}`);
    }
    if (before !== entry.sha256) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.SOURCE_CHANGED_DURING_COPY, `cache file ${JSON.stringify(entry.path)} no longer matches its inventory digest; the cache changed after it was verified.`, { relative: entry.path, inventoried: entry.sha256, current: before });
    }
    if (entry.bytes > limits.maxFileBytes) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.FILE_TOO_LARGE, `cache file ${JSON.stringify(entry.path)} exceeds the per-file bound.`, { relative: entry.path });
    }
    const target = path.join(destination, ...entry.path.split('/'));
    const parent = path.dirname(target);
    const missing = [];
    for (let directory = parent; directory !== destination && !pathExistsNoFollow(directory); directory = path.dirname(directory)) missing.push(directory);
    for (const directory of missing.reverse()) {
      fs.mkdirSync(directory);
      made.add(directory);
      directories.push(directory);
      if (identities !== null) recordOwnedPath(identities, directory, identityRoot);
    }
    const sourceFd = fs.openSync(source, 'r');
    try {
      const sourceStat = fs.fstatSync(sourceFd);
      if (!sourceStat.isFile()) {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.SPECIAL_FILE_IN_DEPENDENCY_TREE, `cache file ${JSON.stringify(entry.path)} is no longer a regular file.`, { relative: entry.path });
      }
      if (pathExistsNoFollow(target)) {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.COPY_VERIFICATION_FAILED, `the staging copy unexpectedly already contains ${JSON.stringify(entry.path)}.`, { relative: entry.path });
      }
      const targetFd = fs.openSync(target, 'wx');
      const creation = fs.fstatSync(targetFd, { bigint: true });
      if (identities !== null) recordOwnedPath(identities, target, identityRoot, null, creation);
      try {
        const buffer = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, Math.max(entry.bytes, 1)));
        for (;;) {
          const read = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
          if (read === 0) break;
          fs.writeSync(targetFd, buffer, 0, read);
        }
      } finally {
        fs.closeSync(targetFd);
      }
    } finally {
      fs.closeSync(sourceFd);
    }
    let after;
    try {
      after = sha256(fs.readFileSync(source));
    } catch (error) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.TREE_CHANGED_DURING_READ, `cache file ${JSON.stringify(entry.path)} could not be re-read after the copy: ${error.message}`);
    }
    if (after !== entry.sha256) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.SOURCE_CHANGED_DURING_COPY, `cache file ${JSON.stringify(entry.path)} changed while it was being copied (source-before hash ${entry.sha256}, source-after hash ${after}).`, { relative: entry.path });
    }
    const copied = sha256(fs.readFileSync(target));
    if (copied !== entry.sha256) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.COPY_VERIFICATION_FAILED, `the copy of ${JSON.stringify(entry.path)} does not match its source hash (copy ${copied}).`, { relative: entry.path });
    }
    // The byte that is now in the destination is proven byte-for-byte, so it is
    // recorded as a byte this operation created. Recording happens per file and
    // into a map the caller owns, which means a throw part way through the copy
    // still leaves an exact account of every byte already written — the only
    // account a failure path can retire from.
    if (identities !== null) {
      const key = path.relative(identityRoot, target).split(path.sep).join('/');
      identities.set(key, Object.freeze({ ...identities.get(key), digest: copied }));
    }
    files += 1;
    bytes += entry.bytes;
  }
  directories.reverse();
  return { files, bytes, directories };
}

/**
 * Read a file the operation must keep unchanged, recording its digest as the
 * reference for a later re-check. `role` names the file in diagnostics instead
 * of repeating prose in every call site, and `required` marks the files that
 * are proven unchanged again after the work is done. A required file is read
 * exactly once here per call site: the re-check is a second, separate read at
 * the point where the proof is owed, which is the only way to observe a change
 * that happened in between.
 *
 * @param {string} target absolute path
 * @param {{code: string, message: string, role: string, required?: boolean}} spec
 * @param {Buffer} [preReadBytes] bytes already read by the caller, so binding
 *   a file to its digest never costs a second read of data in hand
 * @returns {{path: string, role: string, required: boolean, digest: string, bytes: Buffer}}
 */
function readTrackedSourceFile(target, spec, preReadBytes) {
  const bytes = preReadBytes === void 0 ? readSourceBytes(target, spec.code, spec.message) : preReadBytes;
  return { path: target, role: spec.role, required: spec.required === true, digest: sha256(bytes), bytes };
}

/**
 * Re-read a tracked file and refuse when it no longer holds the bytes the
 * operation started from. The message always names the moment of the check,
 * because *when* a locked input moved is the fact a caller needs to act on.
 *
 * The refusal code is `NPM_LOCKFILE_CHANGED`: every tracked file is one side of
 * the declared lock pair, and that code is the contract for "a lock-family input
 * moved". `SOURCE_CHANGED_DURING_COPY` stays the code for a tree that drifts
 * under the copier, which is a different claim about a different object.
 *
 * @param {{path: string, role: string, digest: string}} observation
 * @param {string} phase human-readable point in the operation
 * @returns {string} the re-read digest
 */
function recheckTrackedSourceFile(observation, phase) {
  let bytes;
  try {
    bytes = fs.readFileSync(observation.path);
  } catch (error) {
    throw new DependencyError(
      DEPENDENCY_ERROR_CODES.NPM_LOCKFILE_CHANGED,
      `the ${observation.role} ${JSON.stringify(toDisplayPath(observation.path))} could not be re-read ${phase}: ${error.code ?? error.message}.`,
      { path: toDisplayPath(observation.path), role: observation.role, phase },
    );
  }
  const digest = sha256(bytes);
  if (digest !== observation.digest) {
    throw new DependencyError(
      DEPENDENCY_ERROR_CODES.NPM_LOCKFILE_CHANGED,
      `the ${observation.role} ${JSON.stringify(toDisplayPath(observation.path))} changed ${phase}: ${digest} where ${observation.digest} was read at the start.`,
      { path: toDisplayPath(observation.path), role: observation.role, phase, before: observation.digest, after: digest },
    );
  }
  return digest;
}

/** Re-check every required tracked file. */
function assertTrackedSourcesUnchanged(observations, phase) {
  for (const observation of observations) {
    if (!observation.required) continue;
    recheckTrackedSourceFile(observation, phase);
  }
}

/* ============================================================== publication */

/**
 * Claim the publication name atomically.
 *
 * A check-then-`rename` pair is not a publication guard: between the check and
 * the rename anything can create the name, and on Windows a rename onto an
 * existing directory is not a merge but an `EPERM`. So the claim is made by
 * `mkdir` itself, whose `EEXIST` is the atomic answer that somebody else holds
 * the name, and the rename then only ever targets a directory this call created.
 *
 * @param {string} target absolute path of the publication directory
 * @returns {'claimed' | 'occupied'}
 */
function claimPublicationDirectory(target) {
  try {
    fs.mkdirSync(target);
    return 'claimed';
  } catch (error) {
    // ENOENT, EACCES and friends mean the name could not be claimed, which is
    // reported apart from "occupied" so the cause is never rewritten.
    if (error.code === 'EEXIST' || pathExistsNoFollow(target)) return 'occupied';
    throw new DependencyError(
      DEPENDENCY_ERROR_CODES.STAGING_FAILED,
      `the dependency publication slot ${JSON.stringify(toDisplayPath(target))} could not be created: ${error.code ?? error.message}.`,
      { target: toDisplayPath(target), cause: error.code ?? null },
    );
  }
}

/**
 * Move a fully verified staging tree into an already claimed, empty publication
 * directory and prove the committed bytes are still the verified ones.
 *
 * The bytes committed are the **staged** bytes, never a second read of the
 * cache: the cache was verified once, against the inventory that produced the
 * staging tree, and reading it again after the copy would let a byte that
 * arrived in the meantime be published under a digest that does not describe
 * it. The rename is therefore followed by a re-inventory of the published tree
 * and a digest comparison, which is what turns "we moved something" into "the
 * published tree is the verified tree".
 *
 * @param {string} staged the verified staging tree
 * @param {string} target the claimed publication directory
 * @param {string} expectedDigest digest the staged tree was verified against
 * @param {{limits: object, phase: string}} context
 * @returns {{digest: string, via: 'rename' | 'copy', own: Map<string, string>}}
 *   `own` records the bytes this commit put into `target` itself. A rename moves
 *   the staged tree in as one unit, so the commit wrote no byte *into* the claimed
 *   name and the record is empty; a copy fallback writes each file into the
 *   claimed name and records it, which is what lets a later cleanup tell its own
 *   bytes from bytes somebody else put there.
 */
function commitVerifiedStaging(staged, target, expectedDigest, context) {
  let via = 'rename';
  let cause = null;
  /** @type {Map<string, string>} */
  let own = new Map();
  try {
    fs.renameSync(staged, target);
  } catch (error) {
    if (error.code !== 'EXDEV' && error.code !== 'EPERM') {
      throw new DependencyError(
        DEPENDENCY_ERROR_CODES.STAGING_FAILED,
        `the verified dependency directory could not be moved into place ${context.phase}: ${error.code ?? error.message}.`,
        { staged: toDisplayPath(staged), target: toDisplayPath(target), cause: error.code ?? null },
      );
    }
    // Cross-device, or the Windows rule that a directory may not be renamed
    // onto an existing one: the verified staged bytes are copied instead. The
    // staging tree itself is the only source, so nothing unverified enters.
    cause = error.code;
    via = 'copy';
    const stagedTree = readDependencyTree(staged, context.limits);
    copyVerifiedTree(staged, stagedTree, target, { maxFileBytes: context.limits.maxFileBytes });
    own = new Map(stagedTree.entries.map((entry) => [entry.path, entry.sha256]));
  }
  const committed = readDependencyTree(target, context.limits);
  if (committed.digest !== expectedDigest) {
    throw new DependencyError(
      DEPENDENCY_ERROR_CODES.COPY_VERIFICATION_FAILED,
      `the published dependency directory ${context.phase} does not match the verified staging digest.`,
      { staged: expectedDigest, published: committed.digest, via, cause },
    );
  }
  return { digest: committed.digest, via, own };
}

/**
 * Record what happened to a claimed publication name when the operation failed.
 *
 * The distinction matters because only one of these outcomes is safe to undo.
 * If the name holds exactly the bytes this call verified, deleting it would
 * destroy a good install to report a later failure, so it is reported as
 * retained and left in place. If it holds other bytes, it is a partial result
 * of this call — the name was claimed here, so it can not belong to anybody
 * else — and it is removed. If it can not be inventoried at all, nothing is
 * assumed and nothing is removed.
 *
 * The facts are attached as their own frozen `publication` detail rather than
 * merged into `details`, because `details` is frozen by the error constructor
 * and a refusal's own context must stay exactly as it was raised.
 *
 * @param {unknown} error the failure about to be rethrown
 * @param {string | null} publication the claimed name, or null when none was
 *   claimed, which is the ordinary case for every refusal raised before commit
 * @param {{limits: object}} input used for the inventory bounds
 * @param {string | null} verifiedDigest the digest the published tree must have
 *   to count as verified, or null when no commit produced one
 * @param {string[]} cleaned cleanup log to record a removal in
 * @returns {void}
 */
function reportPublicationFate(error, publication, input, verifiedDigest, cleaned, publicationIdentity) {
  if (publication === null || !(error instanceof DependencyError)) return;
  if (!pathExistsNoFollow(publication)) return;
  let published = null;
  let cause = null;
  try {
    published = digestOfInventory(readDependencyTree(publication, treeLimits(input, 'node_modules')));
  } catch (diagnostic) {
    cause = diagnostic?.code ?? diagnostic?.message ?? 'unreadable';
  }
  if (published === null) {
    // A publication that can not even be inventoried is reported as unreadable;
    // deleting it on an assumption is the worse error. No code is attached,
    // because no existing code describes this state and inventing a meaning
    // for an unreadable tree would be a false claim.
    error.publication = Object.freeze({ path: toDisplayPath(publication), state: 'unreadable', cause });
    return;
  }
  if (verifiedDigest !== null && published === verifiedDigest) {
    // The raised code is left exactly as it was: the reason the operation
    // failed stays the primary fact, while the publication detail carries the
    // state so a caller can branch on it without parsing prose.
    error.publication = Object.freeze({ code: DEPENDENCY_ERROR_CODES.PUBLICATION_RETAINED, path: toDisplayPath(publication), digest: published, removed: false });
    return;
  }
  // Partial: the name is one this call claimed, and the claim itself is empty —
  // this module writes its bytes into staging and only then moves them here, so
  // no byte of a tree that is not the verified tree was ever written by it into
  // the claimed name. Every byte that is in place is therefore something this
  // operation can not prove it created, whether the caller put it there or it
  // arrived between the claim and now. The claim is retired by the empty-only
  // rule, and a byte that keeps the name non-empty is left standing: it is not
  // this call's to delete, and deleting it would destroy caller data while
  // reporting an orderly cleanup. The fate states which of the two happened.
  const retired = retireOperationTree(
    publication,
    input.workspaceRoot,
    cleaned,
    'partial publication',
    new Map([['', publicationIdentity]]),
    { ...DEPENDENCY_LIMITS, rootLabel: 'partial publication' },
    { strict: false },
  );
  const removed = retired.complete;
  error.publication = Object.freeze({
    code: DEPENDENCY_ERROR_CODES.PUBLICATION_PARTIAL,
    path: toDisplayPath(publication),
    digest: published,
    removed,
    residue: Object.freeze([...retired.residue]),
  });
}

/* ============================================================== provenance */

/**
 * Read and validate the explicit cache provenance record
 * `node_modules/.benchboard-cache-provenance.json`. A cache without it is not
 * compatible by definition: compatibility is never inferred from a directory
 * merely being named `node_modules`.
 */
function readCacheProvenance(preparedRoot) {
  const marker = path.join(preparedRoot, DEPENDENCIES_METADATA_FILE_NAME);
  let raw;
  try {
    raw = fs.readFileSync(marker, 'utf8');
  } catch (error) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_PROVENANCE_REQUIRED, `the prepared cache ${JSON.stringify(toDisplayPath(preparedRoot))} carries no provenance record (${DEPENDENCIES_METADATA_FILE_NAME} could not be read: ${error.code ?? error.message}). Cache compatibility is declared, never inferred.`, { preparedRoot: toDisplayPath(preparedRoot) });
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_PROVENANCE_REQUIRED, `the cache provenance record of ${JSON.stringify(toDisplayPath(preparedRoot))} is not valid JSON: ${error.message}`);
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_PROVENANCE_REQUIRED, 'the cache provenance record must be a JSON object.');
  }
  for (const field of ['schemaVersion', 'module', 'hashAlgorithmId', 'mode', 'provenance']) {
    if (typeof record[field] !== 'string' && field !== 'provenance') {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_PROVENANCE_REQUIRED, `the cache provenance record needs a string ${JSON.stringify(field)} field.`);
    }
  }
  if (record.module !== DEPENDENCIES_MODULE_ID) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_PROVENANCE_REQUIRED, `the cache provenance record was written by ${JSON.stringify(record.module ?? null)}, expected ${JSON.stringify(DEPENDENCIES_MODULE_ID)}.`);
  }
  if (record.hashAlgorithmId !== DEPENDENCY_HASH_ALGORITHM_ID) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_PROVENANCE_REQUIRED, `the cache was hashed with ${JSON.stringify(record.hashAlgorithmId)}, which is not the dependency hash domain ${JSON.stringify(DEPENDENCY_HASH_ALGORITHM_ID)}.`);
  }
  if (record.mode !== 'install' && record.mode !== 'prepared') {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_PROVENANCE_REQUIRED, `the cache provenance mode ${JSON.stringify(record.mode ?? null)} is not a dependency-producing mode.`);
  }
  const provenance = record.provenance;
  if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_PROVENANCE_REQUIRED, 'the cache provenance record needs a provenance object.');
  }
  for (const field of ['lockfileName', 'manifestFileName']) {
    if (typeof provenance[field] !== 'string' || provenance[field] === '') {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_PROVENANCE_REQUIRED, `the cache provenance needs a string provenance.${field}.`);
    }
  }
  for (const field of ['lockDigest', 'manifestDigest']) {
    if (typeof provenance[field] !== 'string' || !HEX64_PATTERN.test(provenance[field])) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_PROVENANCE_REQUIRED, `the cache provenance needs a 64-hex provenance.${field}.`);
    }
  }
  return { record: Object.freeze(structuredClone(record)), provenance: Object.freeze(structuredClone(provenance)) };
}

/** Refuse a cache whose provenance lock/manifest bytes differ from the source. */
function assertCacheLockCompatible(preparedRoot, provenance, input) {
  const lockName = provenance.provenance.lockfileName;
  const manifestName = provenance.provenance.manifestFileName;
  if (input.lockfileName !== void 0 && input.lockfileName !== lockName) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_LOCK_MISMATCH, `the cache was built for lock ${JSON.stringify(lockName)} but ${JSON.stringify(input.lockfileName)} is the declared lock.`, { cache: lockName, declared: input.lockfileName });
  }
  if (input.manifestFileName !== void 0 && input.manifestFileName !== manifestName) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_LOCK_MISMATCH, `the cache was built for manifest ${JSON.stringify(manifestName)} but ${JSON.stringify(input.manifestFileName)} is the declared manifest.`, { cache: manifestName, declared: input.manifestFileName });
  }
  if (input.sourceRoot === void 0) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_PROVENANCE_REQUIRED, 'mode "prepared" needs sourceRoot: cache compatibility is checked against the real lock bytes, not against a claimed digest alone.');
  }
  const sourceRoot = requireAbsolutePath(input.sourceRoot, 'sourceRoot');
  assertNoLinkAncestor(sourceRoot, 'sourceRoot');
  describeRoot(sourceRoot, 'sourceRoot');
  assertDisjoint([
    { label: 'workspaceRoot', path: input.workspaceRoot },
    { label: 'preparedRoot', path: preparedRoot },
    { label: 'sourceRoot', path: sourceRoot },
  ]);
  const sourceLock = path.join(sourceRoot, lockName);
  const sourceManifest = path.join(sourceRoot, manifestName);
  const lockBytes = readSourceBytes(sourceLock, DEPENDENCY_ERROR_CODES.CACHE_LOCK_MISSING, `the lock ${JSON.stringify(lockName)} the cache was built for is missing from sourceRoot`);
  const manifestBytes = readSourceBytes(sourceManifest, DEPENDENCY_ERROR_CODES.CACHE_LOCK_MISSING, `the manifest ${JSON.stringify(manifestName)} the cache was built for is missing from sourceRoot`);
  const lockDigest = sha256(lockBytes);
  const manifestDigest = sha256(manifestBytes);
  if (lockDigest !== provenance.provenance.lockDigest) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_LOCK_MISMATCH, 'the cache was built for a different lock: the lock bytes in sourceRoot hash differently than the cache provenance records.', { provenanceLock: provenance.provenance.lockDigest, sourceLock: lockDigest });
  }
  if (manifestDigest !== provenance.provenance.manifestDigest) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_LOCK_MISMATCH, 'the cache was built for a different package manifest.', { provenanceManifest: provenance.provenance.manifestDigest, sourceManifest: manifestDigest });
  }
  // Cross-check: the lock bytes are re-read after the cache was inventoried.
  if (sha256(readSourceBytes(sourceLock, DEPENDENCY_ERROR_CODES.CACHE_LOCK_MISSING, 'the lock disappeared')) !== lockDigest) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.CACHE_LOCK_MISMATCH, 'the lock in sourceRoot changed while the cache was being verified.', {});
  }

  // A prepared cache is compatible with **the workspace it is prepared into**,
  // not merely with the cache's own provenance. When the participant workspace
  // carries its copy of the lock pair — which is how a real project looks, with
  // `package.json` and `package-lock.json` next to `node_modules` — those bytes
  // are part of what the resulting `node_modules` has to agree with. A foreign
  // lock in the workspace means the tree about to be copied describes a
  // different dependency set than the workspace declares, so it is refused here,
  // before a single byte is copied, rather than committed and discovered later.
  const workspaceObservations = readWorkspaceLockPair(input.workspaceRoot, provenance.provenance);

  return Object.freeze({
    sourceRoot,
    lockName,
    manifestName,
    lockDigest,
    manifestDigest,
    sourceObservation: readTrackedSourceFile(sourceLock, {
      code: DEPENDENCY_ERROR_CODES.CACHE_LOCK_MISSING,
      message: 'the lock the cache was built for could not be read from sourceRoot',
      role: 'cache source lock',
      required: true,
    }),
    sourceManifestObservation: readTrackedSourceFile(sourceManifest, {
      code: DEPENDENCY_ERROR_CODES.CACHE_LOCK_MISSING,
      message: 'the manifest the cache was built for could not be read from sourceRoot',
      role: 'cache source package manifest',
      required: true,
    }),
    workspaceObservations,
  });
}

/**
 * Read the lock pair the participant workspace itself carries.
 *
 * Absence is not a mismatch: a bare scratch workspace has no manifest to agree
 * with, and inventing a requirement for one would make the helper refuse work
 * it is otherwise asked to do. Presence is a binding obligation — the bytes
 * either are the locked ones or the cache does not belong to this workspace.
 * Every file that is read is returned as a tracked observation so the caller
 * can prove it still holds the same bytes once the copy is finished.
 *
 * @param {string} workspaceRoot the participant workspace
 * @param {{lockfileName: string, manifestFileName: string, lockDigest: string, manifestDigest: string}} provenance
 * @returns {Array<{path: string, role: string, required: boolean, digest: string, bytes: Buffer}>}
 */
function readWorkspaceLockPair(workspaceRoot, provenance) {
  const bindings = [
    { role: 'workspace lock', name: provenance.lockfileName, digest: provenance.lockDigest },
    { role: 'workspace package manifest', name: provenance.manifestFileName, digest: provenance.manifestDigest },
  ];
  const observations = [];
  for (const binding of bindings) {
    const target = path.join(workspaceRoot, binding.name);
    if (!pathExistsNoFollow(target)) continue;
    const observation = readTrackedSourceFile(target, {
      code: DEPENDENCY_ERROR_CODES.WORKSPACE_LOCK_MISMATCH,
      message: `the ${binding.role} of the participant workspace could not be read`,
      role: binding.role,
      required: true,
    });
    if (observation.digest !== binding.digest) {
      throw new DependencyError(
        DEPENDENCY_ERROR_CODES.WORKSPACE_LOCK_MISMATCH,
        `the participant workspace carries a ${binding.role} ${JSON.stringify(binding.name)} that does not match the lock the prepared cache was built for (${observation.digest} where the cache provenance records ${binding.digest}); refusing to copy a dependency tree that contradicts the workspace it is prepared into.`,
        { path: toDisplayPath(target), role: binding.role, actual: observation.digest, locked: binding.digest },
      );
    }
    observations.push(observation);
  }
  return observations;
}

/* ================================================================== options */

function normaliseOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'prepareDependencies(options): an options object is required.');
  }
  const mode = options.mode;
  if (typeof mode !== 'string' || !DEPENDENCY_MODES.includes(mode)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.MODE_NOT_DECLARED, `mode must be exactly one of ${DEPENDENCY_MODES.map((value) => JSON.stringify(value)).join(', ')}; got ${JSON.stringify(mode ?? null)}. Nothing is inferred.`, { allowed: DEPENDENCY_MODES });
  }
  const workspaceRoot = requireAbsolutePath(options.workspaceRoot, 'workspaceRoot');
  const facts = { workspaceRoot };
  // `none` is a pure decision: no filesystem proof, no access, no hash.
  if (mode === 'none') {
    for (const forbidden of ['preparedRoot', 'npmExecutable', 'sourceRoot', 'scratchRoot']) {
      if (options[forbidden] !== void 0) {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.MODE_OPTION_MISMATCH, `mode "none" accepts no ${forbidden}; it must not be given any root it could act on.`, { mode, forbidden });
      }
    }
    if (options.expectedDependencyDigest !== void 0) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.MODE_OPTION_MISMATCH, 'mode "none" has no dependency digest, so expectedDependencyDigest cannot be satisfied.', { mode });
    }
    return Object.freeze({ mode, workspaceRoot });
  }

  assertNoLinkAncestor(workspaceRoot, 'workspaceRoot');
  const rootFacts = describeRoot(workspaceRoot, 'workspaceRoot');
  if (rootFacts.looksLikeRepository) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.WORKSPACE_NOT_SCRATCH, `workspaceRoot ${JSON.stringify(toDisplayPath(workspaceRoot))} contains a ${JSON.stringify('.git')} entry: a workspace must be exclusively caller-owned scratch, never a repository root.`, { workspaceRoot: toDisplayPath(workspaceRoot) });
  }
  if (rootFacts.metadataPresent) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.WORKSPACE_METADATA_PRESENT, `workspaceRoot carries BenchBoard state (${JSON.stringify('.benchboard')} or ${JSON.stringify('.benchboard-state')} exists); a dependency helper must not run inside a initialised run workspace.`, { workspaceRoot: toDisplayPath(workspaceRoot) });
  }

  const expected = options.expectedDependencyDigest;
  if (expected !== void 0 && (typeof expected !== 'string' || !HEX64_PATTERN.test(expected))) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'expectedDependencyDigest must be 64 lowercase hex characters.');
  }

  const limits = {
    maxEntries: positiveInteger(options.maxEntries ?? DEPENDENCY_LIMITS.maxEntries, 'maxEntries'),
    maxFileBytes: positiveInteger(options.maxFileBytes ?? DEPENDENCY_LIMITS.maxFileBytes, 'maxFileBytes'),
    maxTotalBytes: positiveInteger(options.maxTotalBytes ?? DEPENDENCY_LIMITS.maxTotalBytes, 'maxTotalBytes'),
  };
  const fileNames = {
    lockfileName: options.lockfileName === void 0 ? void 0 : singleSegment(options.lockfileName, 'lockfileName'),
    manifestFileName: options.manifestFileName === void 0 ? void 0 : singleSegment(options.manifestFileName, 'manifestFileName'),
  };
  const metadataPath = options.metadataPath === void 0 ? void 0 : requireAbsolutePath(options.metadataPath, 'metadataPath');
  if (metadataPath !== void 0) {
    // The placement of the public record is proven here, before any byte is
    // copied: a refusal about the metadata destination must never arrive after
    // the dependency directory has already been committed into the workspace.
    const metadataParent = path.dirname(metadataPath);
    if (contains(workspaceRoot, metadataPath)) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.WORKSPACE_METADATA_PRESENT, `metadataPath ${JSON.stringify(toDisplayPath(metadataPath))} is inside the participant workspace; BenchBoard dependency metadata must live outside it.`, { metadataPath: toDisplayPath(metadataPath) });
    }
    if (pathExistsNoFollow(metadataPath)) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.TARGET_EXISTS, `metadataPath ${JSON.stringify(toDisplayPath(metadataPath))} already exists; this helper never overwrites an existing metadata record.`, { metadataPath: toDisplayPath(metadataPath) });
    }
    if (!pathExistsNoFollow(metadataParent)) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.ROOT_NOT_FOUND, `the parent directory of metadataPath does not exist: ${JSON.stringify(toDisplayPath(metadataParent))}`, { metadataParent: toDisplayPath(metadataParent) });
    }
    // A metadata record is the one file this helper writes outside its own
    // staging area, so its placement is proven against **every** protected root,
    // not only the participant workspace. The locked source, the prepared cache
    // and the install scratch are all read-only inputs to this call: a record
    // created inside one of them would be an unannounced byte added to a tree
    // whose digest the caller believes it already knows. The check runs here,
    // in option validation, so the refusal arrives before any copy, dispatch or
    // write rather than after the dependency directory is already committed.
    assertMetadataOutsideProtectedRoots(metadataPath, options);
  }

  if (mode === 'prepared') {
    for (const forbidden of ['npmExecutable', 'scratchRoot', 'processAdapter', 'npmArgumentsPrefix', 'npmArgumentsSuffix', 'installStrategy', 'timeoutMs', 'offline']) {
      if (options[forbidden] !== void 0) {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.MODE_OPTION_MISMATCH, `mode "prepared" accepts no ${forbidden}; it must not be able to execute a command.`, { mode, forbidden });
      }
    }
    if (options.preparedRoot === void 0) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.PREPARED_ROOT_REQUIRED, 'mode "prepared" needs an explicit preparedRoot; no starter, project or global dependency directory is ever inferred.');
    }
    if (options.cacheDigest !== void 0 && (typeof options.cacheDigest !== 'string' || !HEX64_PATTERN.test(options.cacheDigest))) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'cacheDigest must be 64 lowercase hex characters.');
    }
    return Object.freeze({ mode, workspaceRoot, limits, ...fileNames, metadataPath, preparedRoot: options.preparedRoot, cacheDigest: options.cacheDigest, expectedDependencyDigest: expected, sourceRoot: options.sourceRoot });
  }

  // mode === 'install'
  for (const forbidden of ['preparedRoot', 'cacheDigest']) {
    if (options[forbidden] !== void 0) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.MODE_OPTION_MISMATCH, `mode "install" accepts no ${forbidden}; install never consults a cache.`, { mode, forbidden });
    }
  }
  if (options.npmExecutable === void 0) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.NPM_EXECUTABLE_REQUIRED, 'mode "install" is opt-in and needs an explicit absolute npmExecutable; no npm, npx or PATH lookup is performed.');
  }
  if (options.sourceRoot === void 0) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.NPM_LOCKFILE_REQUIRED, 'mode "install" needs an explicit absolute sourceRoot that holds the unchanged locked source (package.json plus package-lock.json) outside the workspace.');
  }
  if (options.scratchRoot === void 0) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.SCRATCH_ROOT_REQUIRED, 'mode "install" needs an explicit absolute scratchRoot that this helper owns for the duration of the install.');
  }
  const strategy = options.executableStrategy;
  if (strategy !== void 0 && strategy !== 'auto' && strategy !== NPM_COMMAND_STRATEGIES.DIRECT && strategy !== NPM_COMMAND_STRATEGIES.CMD_EXE) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.NPM_COMMAND_STRATEGY_UNSUPPORTED, `unknown executableStrategy ${JSON.stringify(strategy)}.`);
  }
  // The admissible values are the install strategies of real npm
  // (`install-strategy`, whose own default is `hoisted`) that produce an
  // ordinary, link-free tree. They are forwarded verbatim to the pinned
  // executable; nothing here emulates them. `linked` is deliberately absent
  // from the admissible set even though real npm accepts it, because it asks
  // npm to store packages under `node_modules/.store` and link them into
  // place: the resulting tree could not satisfy the link-free contract this
  // build enforces, so asking for it is refused rather than attempted.
  const installStrategy = options.installStrategy === void 0 ? 'hoisted' : options.installStrategy;
  if (installStrategy === 'linked') {
    // Named apart from an unknown value because it is a real npm strategy and
    // the reason it is not admissible here is structural, not a typo: it
    // instructs npm to store packages under `node_modules/.store` and link
    // them into place, so the tree it produces carries link material that the
    // tree contract of this build can not publish.
    throw new DependencyError(DEPENDENCY_ERROR_CODES.LINK_IN_DEPENDENCY_TREE, 'installStrategy "linked" is refused: it stores packages under node_modules/.store and links them into place, and this build only publishes ordinary, link-free dependency trees.', { installStrategy });
  }
  if (typeof installStrategy !== 'string' || !SUPPORTED_NPM_INSTALL_STRATEGIES.includes(installStrategy)) {
    throw new DependencyError(
      DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT,
      `installStrategy must be one of ${SUPPORTED_NPM_INSTALL_STRATEGIES.map((name) => JSON.stringify(name)).join(', ')} (the link-free values of npm's own install-strategy setting), got ${describe(installStrategy)}.`,
      { installStrategy, allowed: Object.freeze([...SUPPORTED_NPM_INSTALL_STRATEGIES]) },
    );
  }
  const prefix = stringArray(options.npmArgumentsPrefix, 'npmArgumentsPrefix');
  const suffix = stringArray(options.npmArgumentsSuffix, 'npmArgumentsSuffix');
  return Object.freeze({
    mode,
    workspaceRoot,
    limits,
    ...fileNames,
    metadataPath,
    npmExecutable: requireAbsolutePath(options.npmExecutable, 'npmExecutable'),
    sourceRoot: requireAbsolutePath(options.sourceRoot, 'sourceRoot'),
    scratchRoot: requireAbsolutePath(options.scratchRoot, 'scratchRoot'),
    executableStrategy: strategy ?? 'auto',
    installStrategy,
    npmArgumentsPrefix: Object.freeze(prefix),
    npmArgumentsSuffix: Object.freeze(suffix),
    processAdapter: options.processAdapter === void 0 ? void 0 : requireAdapter(options.processAdapter),
    timeoutMs: positiveInteger(options.timeoutMs ?? DEPENDENCY_LIMITS.npmTimeoutMs, 'timeoutMs'),
    environment: options.environment === void 0 ? void 0 : normaliseNpmOverrides(options.environment),
    offline: options.offline === void 0 ? void 0 : booleanValue(options.offline, 'offline'),
    expectedDependencyDigest: expected,
    platform: options.platform === void 0 ? process.platform : String(options.platform),
  });
}

function requireAdapter(candidate) {
  if (typeof candidate !== 'function') {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'processAdapter must be a function taking one request object and resolving with a result object.');
  }
  return candidate;
}

function maybePersistMetadata(metadata, input) {
  if (input.metadataPath === void 0) {
    return Promise.resolve(Object.freeze({ ...metadata, persisted: false }));
  }
  if (contains(input.workspaceRoot, input.metadataPath)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.WORKSPACE_METADATA_PRESENT, `metadataPath ${JSON.stringify(toDisplayPath(input.metadataPath))} is inside the participant workspace; BenchBoard dependency metadata must live outside it.`, { metadataPath: toDisplayPath(input.metadataPath) });
  }
  if (pathExistsNoFollow(input.metadataPath)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.TARGET_EXISTS, `metadataPath ${JSON.stringify(toDisplayPath(input.metadataPath))} already exists; this helper never overwrites an existing metadata record.`, { metadataPath: toDisplayPath(input.metadataPath) });
  }
  const parent = path.dirname(input.metadataPath);
  if (!pathExistsNoFollow(parent)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.ROOT_NOT_FOUND, `the parent directory of metadataPath does not exist: ${JSON.stringify(toDisplayPath(parent))}`);
  }
  // Defence in depth: option validation already refuses a metadata destination
  // inside a protected root, and that ordering is the contract (a workspace
  // placement, an existing record and a missing parent keep their own codes).
  // This second proof is what makes the write itself safe even if a future path
  // reaches here without that validation, because the write below is create-only
  // and unconditioned: a byte placed inside the locked source or the cache would
  // silently change a tree whose digest the caller believes it knows.
  assertMetadataOutsideProtectedRoots(input.metadataPath, input);
  // The written record is the final fact: it reports that it was persisted and
  // where it lives, so the on-disk record and the returned metadata agree.
  const payload = `${JSON.stringify({ ...metadata, persisted: true, metadataPath: toDisplayPath(input.metadataPath), cleanedUp: [...metadata.cleanedUp] }, null, 2)}\n`;
  // 'wx' is the atomic create-only open: it refuses an existing path rather
  // than relying on the pre-check above, which only improves the message.
  fs.writeFileSync(input.metadataPath, payload, { flag: 'wx' });
  return Promise.resolve(Object.freeze({ ...metadata, persisted: true, metadataPath: toDisplayPath(input.metadataPath) }));
}

/* ================================================================== helpers */

function digestOfEntries(entries) {
  return hashEntries(entries.map((entry) => [entry.path, entry.sha256]));
}

function digestOfInventory(inventory) {
  return inventory.digest;
}

function fingerprintOfEntries(entries) {
  return sha256(entries.map((entry) => `${entry.path}\n${entry.bytes}\n${entry.sha256}`).join('\n'));
}

/** Cheap structural fingerprint used to detect a mutation during a read. */
function fingerprintOfTree(root, excludeRootNames) {
  const seen = [];
  const excluded = excludeRootNames ?? [];
  const visit = (directory, relative) => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (relative === '' && excluded.includes(name)) {
        continue;
      }
      const absolute = path.join(directory, name);
      const rel = relative === '' ? name : `${relative}/${name}`;
      const status = fs.lstatSync(absolute);
      if (status.isDirectory()) {
        seen.push(`d ${rel} ${status.mode.toString(8)}`);
        visit(absolute, rel);
      } else {
        seen.push(`f ${rel} ${status.mode.toString(8)} ${status.size} ${status.mtimeMs?.toFixed(6) ?? ''}`);
      }
    }
  };
  try {
    visit(root, '');
  } catch {
    return 'unreadable';
  }
  return sha256(seen.join('\n'));
}

/**
 * Read the *whole* identity of a prepared cache under a bound.
 *
 * The three pieces are needed because no single one of them sees every way the
 * cache can stop being the object that was verified:
 *
 * - `digest` — the inventory hash: the bytes and the exact path set the copy is
 *   asked to reproduce. It alone cannot see the provenance marker (the tree
 *   bounds exclude it) and it cannot see a path that only changed kind.
 * - `fingerprint` — the structural fingerprint: kind, mode, size and time of every
 *   path under the cache root, including an addition or a deletion, which is what
 *   makes an addition *after the copy* visible even though it changes no copied
 *   byte.
 * - `provenanceDigest` — the marker's own bytes, bound separately because the
 *   marker is the record that says *why* this cache may be used for this lock, and
 *   excluding it from the tree hash must not exclude it from the identity.
 *
 * A re-read of the identity is a full re-verification, not a hash comparison only:
 * `readDependencyTree` re-applies the ordinary-file, link, special-file, case and
 * bound rules to the cache, so a cache that gained a symlink or a device node is
 * refused with the code that names that fact rather than a bare hash mismatch.
 *
 * @returns {{digest: string, fingerprint: string, provenanceDigest: string}}
 */
function readCacheIdentity(preparedRoot, cacheInventory, limits) {
  const marker = path.join(preparedRoot, DEPENDENCIES_METADATA_FILE_NAME);
  let provenanceDigest;
  try {
    provenanceDigest = sha256(fs.readFileSync(marker));
  } catch (error) {
    throw new DependencyError(
      DEPENDENCY_ERROR_CODES.SOURCE_CHANGED_DURING_COPY,
      `the provenance record ${JSON.stringify(DEPENDENCIES_METADATA_FILE_NAME)} of the prepared cache ${JSON.stringify(toDisplayPath(preparedRoot))} could not be read while the cache was being verified: ${error.code ?? error.message}.`,
      { preparedRoot: toDisplayPath(preparedRoot), cause: error.code ?? null },
    );
  }
  const fingerprint = fingerprintOfTree(preparedRoot, limits.excludeRootNames);
  if (fingerprint === 'unreadable') {
    throw new DependencyError(
      DEPENDENCY_ERROR_CODES.SOURCE_CHANGED_DURING_COPY,
      `the prepared cache ${JSON.stringify(toDisplayPath(preparedRoot))} could not be re-read while the copy was in progress; a cache that can not be read can not be certified unchanged.`,
      { preparedRoot: toDisplayPath(preparedRoot) },
    );
  }
  return Object.freeze({
    digest: cacheInventory.digest,
    fingerprint,
    provenanceDigest,
  });
}

/**
 * Re-verify a bound cache identity and refuse if the cache is no longer the
 * object that was bound. Deliberately refuses rather than proceeds: a copy that
 * started from a verified cache and published a tree while the cache kept moving
 * would report a digest that describes no state that ever existed.
 */
function assertCacheUnchanged(bound, preparedRoot, limits, phase) {
  const current = readCacheIdentity(preparedRoot, { digest: bound.digest }, limits);
  // The digest of the *inventory* is re-derived by the caller's re-read below;
  // here only the pieces this function re-reads are compared, so the caller's
  // bound digest is never treated as evidence about itself.
  if (current.fingerprint !== bound.fingerprint) {
    throw new DependencyError(
      DEPENDENCY_ERROR_CODES.SOURCE_CHANGED_DURING_COPY,
      `the prepared cache ${JSON.stringify(toDisplayPath(preparedRoot))} changed structure ${phase}: the structural fingerprint is ${current.fingerprint} where ${bound.fingerprint} was bound.`,
      { preparedRoot: toDisplayPath(preparedRoot), phase, before: bound.fingerprint, after: current.fingerprint, kind: 'structure' },
    );
  }
  if (current.provenanceDigest !== bound.provenanceDigest) {
    throw new DependencyError(
      DEPENDENCY_ERROR_CODES.SOURCE_CHANGED_DURING_COPY,
      `the provenance record of the prepared cache ${JSON.stringify(toDisplayPath(preparedRoot))} changed ${phase}: its bytes are not the bytes the copy was authorised against.`,
      { preparedRoot: toDisplayPath(preparedRoot), phase, kind: 'provenance' },
    );
  }
  return current;
}

/** Full cache re-verification: structure, provenance bytes and inventory hash. */
function assertCacheInventoryUnchanged(bound, preparedRoot, limits, phase) {
  const current = assertCacheUnchanged(bound, preparedRoot, limits, phase);
  const inventory = readDependencyTree(preparedRoot, limits);
  if (inventory.digest !== bound.digest) {
    throw new DependencyError(
      DEPENDENCY_ERROR_CODES.SOURCE_CHANGED_DURING_COPY,
      `the prepared cache ${JSON.stringify(toDisplayPath(preparedRoot))} changed ${phase}: ${inventory.digest} is its inventory hash where ${bound.digest} was bound.`,
      { preparedRoot: toDisplayPath(preparedRoot), phase, before: bound.digest, after: inventory.digest, kind: 'inventory' },
    );
  }
  return current;
}

function emptyInventory(mode) {
  return Object.freeze({
    mode,
    hashAlgorithmId: DEPENDENCY_HASH_ALGORITHM_ID,
    root: null,
    entries: Object.freeze([]),
    digest: null,
    totalBytes: 0,
  });
}

function describeRoot(rootPath, label) {
  let status;
  try {
    status = fs.lstatSync(rootPath);
  } catch (error) {
    throw new DependencyError(
      error.code === 'ENOENT' ? DEPENDENCY_ERROR_CODES.ROOT_NOT_FOUND : DEPENDENCY_ERROR_CODES.INVALID_ROOT,
      `${label} ${JSON.stringify(toDisplayPath(rootPath))} could not be inspected: ${error.message}`,
    );
  }
  if (status.isSymbolicLink()) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.LINK_ANCESTOR, `${label} ${JSON.stringify(toDisplayPath(rootPath))} is itself a symbolic link.`, { label });
  }
  if (!status.isDirectory()) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.ROOT_NOT_A_DIRECTORY, `${label} ${JSON.stringify(toDisplayPath(rootPath))} is not a directory.`, { label });
  }
  if (isFilesystemRoot(rootPath)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.ROOT_IS_FILESYSTEM_ROOT, `${label} must not be a drive or volume root.`, { label });
  }
  const real = fs.realpathSync(rootPath);
  if (caseFoldKey(real) !== caseFoldKey(rootPath)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.LINK_ANCESTOR, `${label} resolves to ${JSON.stringify(toDisplayPath(real))}; the declared path must be the real path.`, { label });
  }
  const names = new Set(fs.readdirSync(rootPath));
  return {
    real,
    looksLikeRepository: names.has('.git'),
    metadataPresent: names.has('.benchboard') || names.has('.benchboard-state'),
  };
}

function inspectWorkspace(rootPath) {
  return describeRoot(rootPath, 'workspaceRoot');
}

/** Reject a link anywhere above the root: one link re-roots every inner check. */
function assertNoLinkAncestor(rootPath, label) {
  let at = path.resolve(rootPath);
  for (;;) {
    let status;
    try {
      status = fs.lstatSync(at);
    } catch {
      return;
    }
    if (status.isSymbolicLink()) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.LINK_ANCESTOR, `${label} has a symbolic-link ancestor at ${JSON.stringify(toDisplayPath(at))}.`, { label });
    }
    const parent = path.dirname(at);
    if (parent === at) return;
    at = parent;
  }
}

/**
 * Prove that a metadata destination can only land in a place this helper owns
 * the writing of. The participant workspace is covered by its own, more
 * specific code; here the remaining protected roots are covered: the locked
 * source, the prepared cache and the install scratch. Every one of them is
 * read-only for the duration of a call, so a byte added inside it is a
 * mutation of data the caller passed in as immutable — the exact failure the
 * Captain proved (`metadataPath` inside `sourceRoot` created a file there).
 *
 * The walk compares the resolved forms of both sides, so it also catches a
 * destination reached through a directory component that resolves somewhere
 * else, and it refuses a destination that itself sits under a link or junction
 * ancestor: following such an ancestor would move the write outside every root
 * the caller declared.
 *
 * @param {string} metadataPath resolved metadata destination
 * @param {Record<string, unknown>} options raw options, whose roots are
 *   resolved the same way the mode branches resolve them, so a protected root
 *   can not be hidden behind a differently spelled alias
 * @returns {void}
 */
function assertMetadataOutsideProtectedRoots(metadataPath, options) {
  const resolved = path.resolve(metadataPath);
  // A link or junction on the way to the destination re-roots the placement
  // check, so it is refused on its own before containment is even considered.
  // The walk starts at the parent directory: the destination itself must not
  // exist yet, so it is the one component that can not be inspected.
  assertNoLinkAncestor(path.dirname(resolved), 'metadataPath');
  const targetReal = safeRealpath(resolved);
  for (const label of ['sourceRoot', 'preparedRoot', 'scratchRoot']) {
    const declared = options[label];
    if (typeof declared !== 'string' || declared === '') continue;
    const real = safeRealpath(requireAbsolutePath(declared, label));
    // `contains` is strictly-below by design, so identity is tested apart:
    // a destination that *is* a protected root is the strongest violation
    // there is, not the weakest.
    if (targetReal === real || contains(real, targetReal)) {
      throw new DependencyError(
        DEPENDENCY_ERROR_CODES.METADATA_PATH_IN_PROTECTED_ROOT,
        `metadataPath ${JSON.stringify(toDisplayPath(resolved))} is inside the protected root ${label}=${JSON.stringify(toDisplayPath(real))}; a dependency metadata record must not be written into a read-only input of the call.`,
        { metadataPath: toDisplayPath(resolved), protectedRoot: label, root: toDisplayPath(real) },
      );
    }
  }
}

function assertDisjoint(roots) {
  for (const left of roots) {
    if (!pathExistsNoFollow(left.path)) continue;
    const leftReal = safeRealpath(left.path);
    for (const right of roots) {
      if (left.label === right.label || !pathExistsNoFollow(right.path)) continue;
      const rightReal = safeRealpath(right.path);
      if (leftReal === rightReal || contains(leftReal, rightReal) || contains(rightReal, leftReal)) {
        throw new DependencyError(DEPENDENCY_ERROR_CODES.ROOTS_OVERLAP, `${left.label} and ${right.label} must not contain one another: ${JSON.stringify(toDisplayPath(left.path))} vs ${JSON.stringify(toDisplayPath(right.path))}.`, { left: left.label, right: right.label });
      }
    }
  }
}

function contains(possibleParent, possibleChild) {
  if (possibleParent === possibleChild) return false;
  const foldedParent = ensureSeparator(caseFoldKey(possibleParent));
  const foldedChild = caseFoldKey(possibleChild);
  return foldedChild.startsWith(foldedParent);
}

function ensureSeparator(value) {
  return value.endsWith('/') || value.endsWith('\\') ? value : `${value}${path.sep}`;
}

function safeRealpath(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

// Existence check that never follows a link: a dangling symlink is reported
// as present (it is a link the caller must refuse), which is what the
// link-refusing inventory and the "never overwrite" guards need.
function pathExistsNoFollow(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    return true;
  }
}

function isFilesystemRoot(candidate) {
  const resolved = path.resolve(candidate);
  return WINDOWS_DRIVE_ROOT.test(resolved) || resolved === '/' || path.parse(resolved).root === resolved;
}

function caseFoldKey(value) {
  return value.normalize('NFD').toUpperCase().normalize('NFC');
}

function toDisplayPath(candidate) {
  return candidate.split(path.sep).join('/');
}

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, `${label}: an explicit absolute path is required, got ${describe(value)}.`);
  }
  if (!path.isAbsolute(value)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ROOT, `${label} must be an absolute path, got ${JSON.stringify(value)}.`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ROOT, `${label} contains a control byte.`);
  }
  if (value.startsWith('\\\\')) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ROOT, `${label} must not be a UNC path: ${JSON.stringify(value)}.`);
  }
  if (value.startsWith('\\\\?\\') || value.startsWith('\\??\\')) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ROOT, `${label} must not use an extended-length spelling.`);
  }
  return path.resolve(value);
}

function singleSegment(value, label) {
  if (typeof value !== 'string' || value === '' || value.includes('/') || value.includes('\\') || value === '.' || value === '..' || CONTROL_CHARACTERS.test(value)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, `${label} must be a single path segment, got ${describe(value)}.`);
  }
  return value;
}

function stringArray(value, label) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || value.some((element) => typeof element !== 'string')) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, `${label} must be an array of strings.`);
  }
  for (const element of value) {
    if (CONTROL_CHARACTERS.test(element) || element.includes('"') || element.includes('`') || element.includes('%')) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, `${label} contains an unsafe element: ${JSON.stringify(element)}`);
    }
  }
  return [...value];
}

function toEnvironmentRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'environment must be a plain object of string values.');
  }
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, `environment.${key} must be a string.`);
    }
    out[key] = raw;
  }
  return out;
}

/**
 * The npm child environment is built from an allowlist, so no credential,
 * proxy, registry, token or harness variable can leak into an install.
 */
function normaliseNpmOverrides(value) {
  const supplied = toEnvironmentRecord(value);
  const out = {};
  for (const [name, value] of Object.entries(supplied)) {
    const canonical = NPM_FORWARDED_ENVIRONMENT.find((allowed) => allowed.toLowerCase() === name.toLowerCase());
    if (canonical === void 0 || Object.hasOwn(out, canonical) || CONTROL_CHARACTERS.test(value)) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, 'environment overrides accept only the forwarded runtime allowlist, without duplicate case aliases or control bytes; npm config, credentials and redirects are reserved.');
    }
    out[canonical] = value;
  }
  return Object.freeze(out);
}

function buildNpmEnvironment(overrides, cacheDirectory) {
  const source = process.env;
  const environment = {};
  for (const name of NPM_FORWARDED_ENVIRONMENT) {
    const value = source[name];
    if (typeof value === 'string' && value.length > 0) environment[name] = value;
  }
  if (overrides !== void 0) Object.assign(environment, overrides);
  // Reserved values always win. Explicit private config paths prevent npm's
  // implicit user/global credential lookup even when os.homedir() is available.
  // The caller may override runtime plumbing only, never npm configuration.
  const neutral = {
    npm_config_cache: cacheDirectory,
    npm_config_userconfig: path.join(cacheDirectory, 'user.npmrc'),
    npm_config_globalconfig: path.join(cacheDirectory, 'global.npmrc'),
    npm_config_ci: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_save: 'false',
    // npm ci must reify node_modules; package-lock-only suppresses that work.
    // save:false and the source/staged byte rechecks protect the locked inputs.
    npm_config_package_lock_only: 'false',
    npm_config_update_notifier: 'false',
  };
  for (const [name, value] of Object.entries(neutral)) {
    environment[name] = value;
  }
  return environment;
}

function readSourceBytes(target, code, message) {
  let bytes;
  try {
    bytes = fs.readFileSync(target);
  } catch (error) {
    throw new DependencyError(code, `${message}: ${JSON.stringify(toDisplayPath(target))} (${error.code ?? error.message}).`, { target: toDisplayPath(target) });
  }
  if (bytes.length === 0) {
    throw new DependencyError(code, `${message}: ${JSON.stringify(toDisplayPath(target))} is empty.`, { target: toDisplayPath(target) });
  }
  return bytes;
}

function ensureManagedDirectory(candidate, ownedRoot) {
  if (!contains(ownedRoot, candidate) && path.resolve(ownedRoot) !== path.resolve(candidate)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, `internal error: ${JSON.stringify(toDisplayPath(candidate))} is not inside the caller-owned root.`);
  }
  if (pathExistsNoFollow(candidate)) {
    const status = fs.lstatSync(candidate);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new DependencyError(DEPENDENCY_ERROR_CODES.STAGING_FAILED, `${JSON.stringify(toDisplayPath(candidate))} exists and is not a real directory; refusing to stage there.`, { candidate: toDisplayPath(candidate) });
    }
    return false;
  }
  fs.mkdirSync(candidate, { recursive: true });
  return true;
}

/**
 * Remove a directory this operation created, but only when it is empty and
 * sits below the caller-owned root. A directory that still holds anything is
 * left exactly as it is: the helper never deletes bytes it did not write.
 *
 * `rmdirSync` is the required primitive here. `rmSync` with
 * `recursive: false` refuses a directory outright on Windows
 * (ERR_FS_EISDIR), while `rmdirSync` removes an empty directory and fails with
 * ENOTEMPTY on a non-empty one, which is exactly the guarantee wanted.
 */
function removeIfEmpty(candidate, ownedRoot, cleaned, expected) {
  const resolved = path.resolve(candidate);
  const root = path.resolve(ownedRoot);
  // The candidate must be the owned root itself or something below it.
  if (resolved !== root && !contains(root, resolved)) return false;
  try {
    if (!pathExistsNoFollow(resolved) || !matchesOwnedPath(resolved, expected)) return false;
    if (fs.readdirSync(resolved).length !== 0) return false;
    fs.rmdirSync(resolved);
    cleaned.push(toDisplayPath(resolved));
    return true;
  } catch {
    /* best effort: never mask the primary result */
    return false;
  }
}

/**
 * Retire the bytes and directories one operation created, and nothing else.
 *
 * This is the whole reason the failure path can not be a recursive delete. A
 * recursive remove of a path *name* deletes whatever currently stands inside
 * that name, and on a failure the contents of a staging or publication name are
 * not known to be the operation's own: another writer may have put bytes inside
 * it while the operation ran, and the probe that proves this is the failure
 * itself. So retirement proceeds from the recorded identity of what was created:
 *
 * - a file is removed only when its creation/ancestor identities match and
 *   it is still a regular file holding exactly the
 *   bytes that were written to it, matched by re-reading and re-hashing it;
 * - a directory is removed only when its creation/ancestor identities match
 *   and it is empty, which after the files above
 *   means empty of everything, including of bytes that were never ours to name;
 * - anything else — a file whose bytes changed, a path that is not a regular
 *   file, a file that was not created here, a directory that still holds any of
 *   them — is left exactly where it is.
 *
 * What is left is reported rather than hidden: `residue` names every path that
 * could not be retired, so a caller is told which bytes are still in place
 * instead of being told a cleanup succeeded. `complete` states whether the
 * subtree is gone; it is the only honest answer to "did you clean up".
 *
 * Traversal is bottom-up over a bounded walk of this subtree only. A walk that
 * hits its bound reports residue instead of escalating, because the safe
 * response to an unexpected shape is to leave it alone.
 *
 * @param {string} root directory this operation created and owns
 * @param {string} ownedRoot caller-owned root that `root` must sit below
 * @param {string[]} cleaned append-only log of retired paths
 * @param {string} label name of the subtree in diagnostics
 * @param {Map<string, object>} expected relative POSIX path -> creation identity,
 *   ancestor identities and file digest, captured when created
 * @param {{maxEntries: number, maxFileBytes: number, maxTotalBytes: number, rootLabel: string}} bounds
 * @param {{strict: boolean}} policy `strict` turns a refusal into the error the
 *   caller must see; otherwise a refusal is reported through `residue`
 * @returns {{complete: boolean, residue: readonly string[]}}
 */
function retireOperationTree(root, ownedRoot, cleaned, label, expected, bounds, policy) {
  const resolved = path.resolve(root);
  const root_ = path.resolve(ownedRoot);
  if (resolved !== root_ && !contains(root_, resolved)) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.CLEANUP_FAILED, `refusing to remove ${JSON.stringify(toDisplayPath(resolved))}: it is not below the caller-owned root.`, { target: toDisplayPath(resolved) });
  }
  /** @type {{relative: string, absolute: string, kind: 'file' | 'directory' | 'other'}[]} */
  const found = [];
  const residue = [];
  let entries = 0;
  const walk = (directory, relative) => {
    let names;
    try {
      names = fs.readdirSync(directory);
    } catch {
      // Unreadable: it can not be shown to be ours, so it is residue and the
      // enclosing directory stays non-empty, which is the safe outcome.
      residue.push(toDisplayPath(directory));
      return;
    }
    if (entries >= bounds.maxEntries) {
      residue.push(toDisplayPath(directory));
      return;
    }
    for (const name of names) {
      if (entries >= bounds.maxEntries) {
        residue.push(toDisplayPath(path.join(directory, name)));
        return;
      }
      const absolute = path.join(directory, name);
      const child = relative === '' ? name : `${relative}/${name}`;
      let status;
      try {
        status = fs.lstatSync(absolute);
      } catch {
        residue.push(toDisplayPath(absolute));
        continue;
      }
      entries += 1;
      if (status.isDirectory()) {
        found.push({ relative: child, absolute, kind: 'directory' });
        if (!matchesOwnedPath(absolute, expected.get(child))) { residue.push(toDisplayPath(absolute)); continue; }
        walk(absolute, child);
        continue;
      }
      if (status.isFile()) {
        found.push({ relative: child, absolute, kind: 'file' });
        continue;
      }
      // A link or a non regular node is not something this module creates here,
      // so it is never ours to remove.
      found.push({ relative: child, absolute, kind: 'other' });
    }
  };
  if (!pathExistsNoFollow(resolved)) return Object.freeze({ complete: true, residue: Object.freeze([]) });
  let rootStatus;
  try {
    rootStatus = fs.lstatSync(resolved);
  } catch {
    return Object.freeze({ complete: false, residue: Object.freeze([toDisplayPath(resolved)]) });
  }
  if (!rootStatus.isDirectory() || !matchesOwnedPath(resolved, expected.get(''))) {
    if (policy.strict) throw new DependencyError(DEPENDENCY_ERROR_CODES.CLEANUP_FAILED, 'operation root or ancestor creation identity changed; replacement is preserved.', { residue: Object.freeze([toDisplayPath(resolved)]) });
    return Object.freeze({ complete: false, residue: Object.freeze([toDisplayPath(resolved)]) });
  }
  walk(resolved, '');

  // Files are retired first and by identity alone: a file's removal can not be
  // blocked by what is inside it, so the only question is whether the bytes in
  // place are still the bytes this operation wrote there.
  for (const item of found) {
    if (item.kind !== 'file') continue;
    const want = expected.get(item.relative);
    if (want === void 0) {
      // No record of creating this byte. Deleting it would destroy something
      // this operation has no proof of having made, which is exactly the
      // foreign material this pass exists to preserve.
      residue.push(toDisplayPath(item.absolute));
      continue;
    }
    let isOurs = false;
    try {
      const status = fs.lstatSync(item.absolute);
      if (status.isFile() && status.size <= bounds.maxFileBytes && matchesOwnedPath(item.absolute, want)) {
        isOurs = want.digest !== null && sha256(fs.readFileSync(item.absolute)) === want.digest;
      }
    } catch {
      isOurs = false;
    }
    if (!isOurs) {
      // Replaced, truncated, turned into a link, or unreadable: not the byte
      // that was written here.
      residue.push(toDisplayPath(item.absolute));
      continue;
    }
    try {
      fs.rmSync(item.absolute, { recursive: false, force: false });
      cleaned.push(toDisplayPath(item.absolute));
    } catch {
      residue.push(toDisplayPath(item.absolute));
    }
  }
  // Directories next, deepest first, and only when empty. Emptiness is asked of
  // the file system rather than inferred, so a byte that was preserved above —
  // a foreign file, a changed file, a link, an unreadable child — keeps its
  // directory standing, and every ancestor of that directory is kept standing by
  // the same test once its child is still there.
  for (const item of [...found].reverse()) {
    if (item.kind !== 'directory') continue;
    if (!removeIfEmpty(item.absolute, resolved, cleaned, expected.get(item.relative))) residue.push(toDisplayPath(item.absolute));
  }
  // The subtree root is retired by the same rule as any directory in it: the
  // caller asked for this path to be retired, and when every node below it is
  // gone the only thing left to ask is whether it is empty. An empty root that
  // is left standing would be reported as a residue the caller can not remove
  // either, which is the failure mode the empty publication claim shows.
  if (pathExistsNoFollow(resolved)) {
    removeIfEmpty(resolved, resolved, cleaned, expected.get(''));
    // A root that is still standing was not retired, whatever the reason: a
    // process is holding it as its working directory, or a byte below it was
    // preserved above. The caller asked for this path to go away, so leaving it
    // unreported would claim an orderly cleanup that did not happen; a strict
    // caller has to be told, and a lenient one has to see it in the residue.
    if (pathExistsNoFollow(resolved)) residue.push(toDisplayPath(resolved));
  }
  if (policy.strict === true && residue.length > 0) {
    throw new DependencyError(
      DEPENDENCY_ERROR_CODES.CLEANUP_FAILED,
      `the ${label} ${JSON.stringify(toDisplayPath(resolved))} could not be fully removed; it still holds bytes this operation can not prove it created${residue.length <= 4 ? ` (${residue.map((entry) => path.basename(entry)).join(', ')})` : ` (${String(residue.length)} paths)`}.`,
      Object.freeze({ target: toDisplayPath(resolved), residue: Object.freeze([...residue]) }),
    );
  }
  const complete = !pathExistsNoFollow(resolved);
  if (complete) return Object.freeze({ complete: true, residue: Object.freeze([]) });
  return Object.freeze({ complete: false, residue: Object.freeze(residue) });
}

/** Stable creation identity, not content identity; no mtime (writes may change it). */
function creationIdentity(status) {
  return `${status.dev}:${status.ino}:${status.birthtimeNs}:${status.isDirectory() ? 'directory' : status.isFile() ? 'file' : 'other'}`;
}

/** Capture at creation (or the one declared, settled process-output boundary). */
function ownedPathRecord(candidate, digest = null, creation = fs.lstatSync(candidate, { bigint: true })) {
  const ancestors = [];
  for (let at = path.dirname(candidate); ; at = path.dirname(at)) {
    const status = fs.lstatSync(at, { bigint: true });
    if (!status.isDirectory() || status.isSymbolicLink()) throw new DependencyError(DEPENDENCY_ERROR_CODES.STAGING_FAILED, 'ownership capture requires ordinary directory ancestors.');
    ancestors.push(Object.freeze({ path: at, identity: creationIdentity(status) }));
    if (path.dirname(at) === at) break;
  }
  return Object.freeze({ identity: creationIdentity(creation), digest, ancestors: Object.freeze(ancestors) });
}

function recordOwnedPath(records, candidate, root, digest = null, creation) {
  const key = path.relative(root, candidate).split(path.sep).join('/');
  if (!records.has(key)) records.set(key, ownedPathRecord(candidate, digest, creation));
}

function matchesOwnedPath(candidate, record) {
  if (!record) return false;
  try {
    if (creationIdentity(fs.lstatSync(candidate, { bigint: true })) !== record.identity) return false;
    return record.ancestors.every((ancestor) => creationIdentity(fs.lstatSync(ancestor.path, { bigint: true })) === ancestor.identity);
  } catch { return false; }
}

/**
 * The adapter must settle only after its process and output writers have stopped.
 * Exactly .npm-cache and node_modules are declared outputs. Capture once here;
 * never refresh this proof during later reads/cleanup (which could adopt replacements).
 * This is a cooperative protocol, not containment of an adversarial process.
 */
function captureSettledOutput(root, inventory, records, staging) {
  if (!matchesOwnedPath(staging, records.get(''))) throw new DependencyError(DEPENDENCY_ERROR_CODES.STAGING_FAILED, 'the operation staging directory was replaced before process settlement.');
  const rootKey = path.relative(staging, root).split(path.sep).join('/');
  if (records.has(rootKey) && !matchesOwnedPath(root, records.get(rootKey))) throw new DependencyError(DEPENDENCY_ERROR_CODES.STAGING_FAILED, 'a helper-created process output root was replaced before settlement.');
  recordOwnedPath(records, root, staging);
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const status = fs.lstatSync(absolute, { bigint: true });
      if (status.isDirectory() && !status.isSymbolicLink()) {
        recordOwnedPath(records, absolute, staging, null, status);
        visit(absolute);
      }
    }
  };
  visit(root);
  for (const entry of inventory.entries) recordOwnedPath(records, path.join(root, ...entry.path.split('/')), staging, entry.sha256);
}

/**
 * Remove one helper-created path that lives below a caller-owned root.
 *
 * The return value states the outcome the caller needs to report: `true` when
 * no byte of that path is in place any more, either because it was removed here
 * or because it had already gone. A path that can not be removed is an error,
 * never a silently reported failure to clean up — and so is a path that still
 * holds bytes this operation can not prove it wrote, which is the case a
 * recursive delete used to erase while reporting success.
 *
 * `expected` records creation identity, ancestor identities and file digest.
 * Without a matching record nothing can be retired, even an empty directory.
 */
function removeCreated(target, ownedRoot, cleaned, label, expected = new Map(), bounds = DEPENDENCY_LIMITS) {
  const outcome = retireOperationTree(target, ownedRoot, cleaned, label, expected, { ...bounds, rootLabel: label }, { strict: true });
  return outcome.complete;
}

/**
 * Cleanup is restricted to paths this operation created. The staging root is
 * the deepest thing ever removed, and it is always below a caller-owned root,
 * so a caller workspace, a locked source and a foreign cache can never be
 * deleted by this path.
 */
function cleanupCreated(created, deepest, ownedRoot, cleaned, expected = new Map(), bounds = DEPENDENCY_LIMITS) {
  // Reuse bounded, non-recursive retirement. A reserved pathname is not
  // ownership of unknown or changed bytes subsequently placed inside it.
  if (!created.includes(deepest) || !pathExistsNoFollow(deepest)) return;
  const retired = retireOperationTree(deepest, ownedRoot, cleaned, 'operation staging', expected, bounds, { strict: false });
  if (!retired.complete) cleaned.residue = retired.residue;
}

function decorateCleanup(error, cleaned, commandReport) {
  if (error instanceof DependencyError) {
    if ((cleaned.length > 0 || cleaned.residue) && error.details?.cleanedUp === void 0) {
      // A clone has to carry everything the original reported. The fate of the
      // publication is the one piece of information a caller can not rederive
      // after the fact — it says whether verified bytes are in place — so
      // attaching the cleanup log must not drop it.
      const clone = new DependencyError(error.code, undecoratedMessage(error), Object.freeze({ ...(error.details ?? {}), cleanedUp: Object.freeze([...cleaned]), ...(cleaned.residue ? { cleanupResidue: cleaned.residue } : {}) }));
      if (error.publication !== void 0) clone.publication = error.publication;
      if (error.cause !== void 0) clone.cause = error.cause;
      return clone;
    }
    return error;
  }
  const wrapped = new DependencyError(DEPENDENCY_ERROR_CODES.STAGING_FAILED, `dependency preparation failed while staging: ${error?.message ?? String(error)}`, Object.freeze({ cleanedUp: Object.freeze([...cleaned]), command: commandReport ?? null, cause: error?.code ?? null }));
  wrapped.cause = error;
  if (error?.publication !== void 0) wrapped.publication = error.publication;
  return wrapped;
}

/**
 * The message of a `DependencyError` already starts with its own code, so
 * re-raising the same failure with the same code has to strip that prefix
 * first; otherwise the code accumulates on every decoration step.
 */
function undecoratedMessage(error) {
  const prefix = `${error.code}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

function describeCommand(resolved, built, request, outcome, timeoutMs) {
  return Object.freeze({
    strategy: resolved.strategy,
    file: built.file,
    args: Object.freeze([...built.args]),
    shell: false,
    // The report states the command line rule that was actually used, so
    // `shell: false` alone cannot be mistaken for Node's default argument
    // escaping: the wrapped strategy passes a verbatim command line.
    windowsVerbatimArguments: built.options.windowsVerbatimArguments === true,
    workingDirectory: toDisplayPath(request.cwd),
    timeoutMs,
    status: outcome && typeof outcome === 'object' ? (outcome.status ?? null) : null,
    signal: outcome && typeof outcome === 'object' ? (outcome.signal ?? null) : null,
    timedOut: outcome && typeof outcome === 'object' ? outcome.timedOut === true : false,
    stderrTail: outcome && typeof outcome === 'object' ? tail(outcome.stderr) : '',
    stdoutTail: outcome && typeof outcome === 'object' ? tail(outcome.stdout) : '',
    npmBinLinkPolicy: NPM_BIN_LINK_POLICY,
  });
}

function tail(value) {
  if (typeof value !== 'string') return '';
  if (value.length <= OUTPUT_TAIL_BYTES) return value;
  return `…${value.slice(value.length - OUTPUT_TAIL_BYTES)}`;
}

function positiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, `${label} must be a positive safe integer, got ${describe(value)}.`);
  }
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== 'boolean') {
    throw new DependencyError(DEPENDENCY_ERROR_CODES.INVALID_ARGUMENT, `${label} must be a boolean, got ${describe(value)}.`);
  }
  return value;
}

function structuredClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (value === void 0) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}
