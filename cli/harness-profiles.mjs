// Harness profiles for `run`: how to launch an agent CLI, read its run-total tokens and confirm
// where it worked. Profiles only build plans and parse output; agent-process.mjs launches them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const HARNESS_NAMES = Object.freeze(['opencode', 'claude', 'command']);

// Fixed participant prompt. Kept free of cmd.exe metacharacters so it survives a .cmd shim.
export const AGENT_PROMPT = [
  'You are taking part in a timed software benchmark. The project is in the current directory.',
  'Read README.md and PRODUCT_PRD.md, then implement the product so it meets the PRD.',
  'Work autonomously until you are finished. Do not ask questions, nobody will answer.',
  'Dependencies are already installed. Do not use web research or install new packages.',
  'Check your work with npm test, npm run typecheck and npm run build.',
  'Only change files inside the current directory.',
].join(' ');

const UNSAFE_FOR_CMD = /["%^&|<>!\r\n]/;

/** Find an executable on PATH (honouring PATHEXT on Windows), or accept an existing absolute path. */
export function resolveExecutable(name, { env = process.env, platform = process.platform } = {}) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const isFile = candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } };
  if (path.isAbsolute(name)) return isFile(name) ? name : null;
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const directories = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const directory of directories) {
    for (const extension of platform === 'win32' && path.extname(name) ? ['', ...extensions] : extensions) {
      const candidate = path.join(directory, name + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Turn an executable and argument list into a spawn plan. Windows .cmd/.bat shims cannot be
 * spawned directly, so they go through cmd.exe with quoted arguments; anything cmd.exe would
 * reinterpret is refused rather than escaped.
 */
export function spawnPlanFor(executable, args, { platform = process.platform, env = process.env } = {}) {
  const extension = path.extname(executable).toLowerCase();
  if (platform !== 'win32' || (extension !== '.cmd' && extension !== '.bat')) {
    return { file: executable, args: [...args], shell: false, windowsVerbatimArguments: false };
  }
  for (const value of [executable, ...args]) {
    if (UNSAFE_FOR_CMD.test(value)) throw new HarnessError(`Argument cannot be passed safely through ${path.basename(executable)}; use --agent-bin with the real .exe`);
  }
  const quote = value => (/[\s]/.test(value) || value === '' ? `"${value}"` : value);
  const line = [executable, ...args].map(quote).join(' ');
  return { file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], shell: false, windowsVerbatimArguments: true };
}

export class HarnessError extends Error {
  constructor(message) { super(message); this.name = 'HarnessError'; }
}

const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const jsonLines = text => text.split(/\r?\n/).filter(line => line.trim().startsWith('{')).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});

/** NeutralTokenInput for the report: input already includes cache reads and writes. */
export function neutralTokens(sourceId, { input, output, cacheRead }) {
  return {
    schemaVersion: '1.0.0', kind: 'NeutralTokenInput', sourceId, scope: 'RUN_TOTAL',
    inputIncludesCacheReads: true, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead,
  };
}

const sameDirectory = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  const real = value => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
  return path.relative(real(a).toLowerCase(), real(b).toLowerCase()) === '';
};

// --- OpenCode -------------------------------------------------------------------------------

/** Major version from `opencode --version` ("opencode v2.0.29" or "1.15.5"); null if unknown. */
export function opencodeMajor(versionText) {
  const match = /(\d+)\.\d+\.\d+/.exec(String(versionText ?? ''));
  return match ? Number(match[1]) : null;
}

/** Session id and summed step tokens from `opencode run --format json` output. */
export function parseOpencodeStream(text) {
  let sessionId = null;
  const totals = { input: 0, output: 0, cacheRead: 0, steps: 0 };
  for (const event of jsonLines(text)) {
    sessionId ??= typeof event.sessionID === 'string' ? event.sessionID : null;
    const tokens = event.type === 'step_finish' ? event.part?.tokens : null;
    if (!tokens) continue;
    totals.steps++;
    totals.input += count(tokens.input) + count(tokens.cache?.read) + count(tokens.cache?.write);
    totals.output += count(tokens.output) + count(tokens.reasoning);
    totals.cacheRead += count(tokens.cache?.read);
  }
  return { sessionId, totals };
}

/**
 * Run totals and working directory from `opencode session export` (v2: info.tokens and
 * info.location.directory) or `opencode export` (v1: per-message info.tokens, info.directory).
 */
export function parseOpencodeExport(text) {
  let data;
  try { data = JSON.parse(text.slice(text.indexOf('{'))); } catch { return null; }
  if (!data || typeof data !== 'object' || !data.info) return null;
  const directory = data.info.location?.directory ?? data.info.directory ?? null;
  const fromTokens = tokens => ({
    input: count(tokens.input) + count(tokens.cache?.read) + count(tokens.cache?.write),
    output: count(tokens.output) + count(tokens.reasoning),
    cacheRead: count(tokens.cache?.read),
  });
  if (data.info.tokens) return { directory, totals: fromTokens(data.info.tokens) };
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const totals = { input: 0, output: 0, cacheRead: 0 };
  let seen = false;
  for (const message of messages) {
    const tokens = message?.info?.tokens ?? message?.tokens;
    if (!tokens) continue;
    seen = true;
    const one = fromTokens(tokens);
    totals.input += one.input; totals.output += one.output; totals.cacheRead += one.cacheRead;
  }
  return seen ? { directory, totals } : { directory, totals: null };
}

const opencode = Object.freeze({
  name: 'opencode',
  defaultBin: 'opencode',
  requiresModel: true,
  agentArgs({ model, prompt, major }) {
    return ['run', ...(major !== null && major >= 2 ? ['--standalone', '--auto'] : []), '--format', 'json', '--model', model, prompt];
  },
  judgeArgs({ model, prompt, images, major }) {
    return ['run', ...(major !== null && major >= 2 ? ['--standalone'] : []), '--format', 'json', '--model', model,
      ...images.flatMap(file => ['--file', file]), prompt];
  },
  probe(executable, env) {
    const plan = spawnPlanFor(executable, ['--version'], { env });
    const result = spawnSync(plan.file, plan.args, { env, encoding: 'utf8', timeout: 60000, windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments });
    return { major: opencodeMajor((result.stdout ?? '') + (result.stderr ?? '')) };
  },
  /** Prefers the session export (true totals); falls back to the stream, which can miss the last step. */
  readOutcome({ stdout, executable, env, cwd, major }) {
    const stream = parseOpencodeStream(stdout);
    const result = { tokens: null, approximateTokens: null, tokenSource: null, directory: null, sessionId: stream.sessionId };
    if (stream.totals.steps > 0) result.approximateTokens = stream.totals;
    if (stream.sessionId) {
      const args = major !== null && major < 2 ? ['export', stream.sessionId] : ['session', 'export', stream.sessionId];
      const plan = spawnPlanFor(executable, args, { env });
      const exported = spawnSync(plan.file, plan.args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 268435456, windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments });
      const parsed = exported.status === 0 ? parseOpencodeExport(exported.stdout ?? '') : null;
      if (parsed) {
        result.directory = parsed.directory;
        if (parsed.totals) { result.tokens = neutralTokens('opencode-session-export', parsed.totals); result.tokenSource = 'opencode session export'; }
      }
    }
    return result;
  },
  judgeText(stdout) {
    return jsonLines(stdout).filter(event => event.type === 'text' && typeof event.part?.text === 'string').map(event => event.part.text).join('\n');
  },
});

// --- Claude Code ----------------------------------------------------------------------------

/** Run totals and working directory from `claude -p --output-format stream-json --verbose`. */
export function parseClaudeStream(text) {
  let directory = null, result = null;
  for (const event of jsonLines(text)) {
    if (event.type === 'system' && event.subtype === 'init' && typeof event.cwd === 'string') directory ??= event.cwd;
    if (event.type === 'result') result = event;
  }
  if (!result) return { directory, totals: null };
  const models = result.modelUsage && typeof result.modelUsage === 'object' ? Object.values(result.modelUsage) : [];
  if (models.length) {
    const totals = { input: 0, output: 0, cacheRead: 0 };
    for (const usage of models) {
      totals.input += count(usage.inputTokens) + count(usage.cacheReadInputTokens) + count(usage.cacheCreationInputTokens);
      totals.output += count(usage.outputTokens);
      totals.cacheRead += count(usage.cacheReadInputTokens);
    }
    return { directory, totals };
  }
  const usage = result.usage;
  if (!usage) return { directory, totals: null };
  return { directory, totals: {
    input: count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
  } };
}

const claude = Object.freeze({
  name: 'claude',
  defaultBin: 'claude',
  requiresModel: false,
  agentArgs({ model, prompt }) {
    return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
      ...(model ? ['--model', model] : []), '--disallowedTools', 'WebFetch', 'WebSearch'];
  },
  // Claude Code has no attachment flag; it reads the screenshots by path with its Read tool.
  judgeArgs({ model, prompt, images, imageRoot }) {
    return ['-p', `${prompt} Read these files: ${images.join(' ')}`, '--output-format', 'json',
      ...(model ? ['--model', model] : []), '--add-dir', imageRoot, '--allowedTools', 'Read'];
  },
  probe() { return { major: null }; },
  readOutcome({ stdout }) {
    const parsed = parseClaudeStream(stdout);
    return { tokens: parsed.totals ? neutralTokens('claude-code-result', parsed.totals) : null, approximateTokens: null,
      tokenSource: parsed.totals ? 'claude result event' : null, directory: parsed.directory, sessionId: null };
  },
  judgeText(stdout) {
    try { const value = JSON.parse(stdout); return typeof value.result === 'string' ? value.result : ''; } catch { return ''; }
  },
});

// --- Any other CLI --------------------------------------------------------------------------

const command = Object.freeze({
  name: 'command',
  defaultBin: null,
  requiresModel: false,
  probe() { return { major: null }; },
  readOutcome() { return { tokens: null, approximateTokens: null, tokenSource: null, directory: null, sessionId: null }; },
});

const PROFILES = Object.freeze({ opencode, claude, command });
export function harnessProfile(name) {
  if (!Object.hasOwn(PROFILES, name)) throw new HarnessError(`Unknown --agent ${JSON.stringify(name)}; expected one of ${HARNESS_NAMES.join(', ')}`);
  return PROFILES[name];
}

/** Null when the harness did not report a directory; otherwise whether it was the workspace. */
export function workedInWorkspace(outcome, workspace) {
  return outcome.directory === null ? null : sameDirectory(outcome.directory, workspace);
}
