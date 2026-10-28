// `run`: one command from an empty folder to a scored result. It drives the existing lifecycle
// (init -> start -> agent -> stop -> freeze -> evaluate -> export) and adds screenshots and an
// optional AI judge. Timing comes from the real agent launch and exit; tokens from the harness.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandError } from './command-error.mjs';
import { INSTALLATION_ROOT } from './filesystem.mjs';
import { initializeCommand } from './initialize-command.mjs';
import { startCommand, stopCommand } from './manual-commands.mjs';
import { freezeCommand } from './freeze-command.mjs';
import { evaluateCommand } from './evaluate-command.mjs';
import { exportCommand } from './export-command.mjs';
import { AGENT_PROMPT, HarnessError, harnessProfile, resolveExecutable, spawnPlanFor, workedInWorkspace } from './harness-profiles.mjs';
import { runAgentProcess } from './agent-process.mjs';

export const RUN_LAYOUT = Object.freeze({ run: 'run', agent: 'agent', screens: 'screens', export: 'export', summary: 'summary.json' });
const DEFAULT_MINUTES = 75;
// Deepest starter dependency path (85) plus margin: the agent's own esbuild/vite run there.
const WORKSPACE_DEPENDENCY_ALLOWANCE = 110;
const WINDOWS_MAX_PATH = 259;

export class RunFailure extends Error {
  constructor(message, category = 'state') { super(message); this.name = 'RunFailure'; this.category = category; }
}

const progress = text => process.stderr.write(`benchboard run: ${text}\n`);
const inside = (root, target) => {
  const relative = path.relative(root.toLowerCase(), target.toLowerCase());
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** Pure validation of the `run` flags into a plan. Throws RunFailure with a plain message. */
export function runPlanOf(options, { now = new Date(), home = os.homedir(), platform = process.platform } = {}) {
  let profile;
  try { profile = harnessProfile(options['--agent']); }
  catch (error) { throw new RunFailure(error.message, 'usage'); }
  const model = options['--model'] ?? null;
  if (profile.requiresModel && !model) throw new RunFailure(`--agent ${profile.name} needs --model <provider/model>`, 'usage');
  if (model !== null && (model.length > 400 || /[\x00-\x1f]/.test(model))) throw new RunFailure('--model is too long or contains control characters', 'usage');
  if (profile.name === 'command' && !options['--agent-command']) throw new RunFailure('--agent command needs --agent-command "<command line>"', 'usage');
  if (profile.name !== 'command' && options['--agent-command'] !== undefined) throw new RunFailure('--agent-command is only for --agent command', 'usage');
  const minutesText = options['--minutes'] ?? String(DEFAULT_MINUTES);
  if (!/^[1-9][0-9]{0,3}$/.test(minutesText) || Number(minutesText) > 1440) throw new RunFailure('--minutes must be a whole number from 1 to 1440', 'usage');
  if (options['--ai-judge'] !== undefined && profile.name === 'command') throw new RunFailure('--ai-judge needs --agent opencode or claude', 'usage');
  let dir, createDir = false;
  if (options['--dir'] !== undefined) dir = path.resolve(options['--dir']);
  else {
    const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const slug = (model ?? profile.name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-40);
    dir = path.join(home, 'benchboard-runs', `${stamp}-${slug}`);
    createDir = true;
  }
  if (inside(INSTALLATION_ROOT, dir) || inside(dir, INSTALLATION_ROOT)) throw new RunFailure('The run folder must be outside the BenchBoard repository', 'usage');
  const deepest = path.join(dir, RUN_LAYOUT.run, 'workspace', 'node_modules').length + 1 + WORKSPACE_DEPENDENCY_ALLOWANCE;
  if (platform === 'win32' && deepest > WINDOWS_MAX_PATH) throw new RunFailure(`The run folder path is too long for Windows tools (${dir.length} characters); use a shorter --dir such as C:\\bench\\run1`, 'usage');
  return Object.freeze({
    profile, model, minutes: Number(minutesText), dir, createDir,
    agentBin: options['--agent-bin'] ?? profile.defaultBin, agentCommand: options['--agent-command'] ?? null,
    npm: options['--npm'] ?? null, aiJudge: options['--ai-judge'] ?? null,
  });
}

function prepareFolder(plan) {
  if (plan.createDir) {
    fs.mkdirSync(path.dirname(plan.dir), { recursive: true });
    try { fs.mkdirSync(plan.dir); } catch (error) { throw new RunFailure(`Cannot create ${plan.dir}: ${error.code}`); }
    return;
  }
  let stat;
  try { stat = fs.lstatSync(plan.dir); } catch { throw new RunFailure(`--dir ${plan.dir} does not exist; create an empty folder first`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RunFailure(`--dir ${plan.dir} is not an ordinary folder`);
  if (fs.readdirSync(plan.dir).length) throw new RunFailure(`--dir ${plan.dir} is not empty; BenchBoard never reuses or overwrites a folder`);
}

function npmExecutable(plan) {
  if (plan.npm) return path.resolve(plan.npm);
  const beside = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (fs.existsSync(beside)) return beside;
  const found = resolveExecutable(process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (!found) throw new RunFailure('npm was not found next to node or on PATH; pass --npm <path>');
  return found;
}

function agentLaunch(plan, env) {
  if (plan.profile.name === 'command') {
    // Free-form command line for any other harness; the prompt arrives by environment and file.
    return { executable: null, major: null, spawn: { file: plan.agentCommand, args: [], shell: true } };
  }
  const executable = resolveExecutable(plan.agentBin, { env });
  if (!executable) throw new RunFailure(`${plan.profile.name} was not found (${plan.agentBin}); install it or pass --agent-bin <path>`);
  const { major } = plan.profile.probe(executable, env);
  let spawn;
  try { spawn = spawnPlanFor(executable, plan.profile.agentArgs({ model: plan.model, prompt: AGENT_PROMPT, major }), { env }); }
  catch (error) { throw new RunFailure(error.message); }
  return { executable, major, spawn };
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'w' });
/**
 * A launcher for the run folder that opens this run's UI review; extra options pass through
 * (e.g. --host 0.0.0.0 --port 8080). Null when a path cannot be quoted safely for cmd.exe.
 */
export function reviewLauncherOf({ dir, node = process.execPath, repo = INSTALLATION_ROOT, platform = process.platform }) {
  const cli = path.join(repo, 'cli', 'benchboard.mjs');
  if (platform === 'win32') {
    if ([dir, node, cli].some(value => /["%!^&|<>\r\n]/.test(value))) return null;
    return { name: 'review.cmd', text: `@rem Opens the UI review for this run. Extra options pass through, e.g. --host 0.0.0.0 --port 8080\r\n@"${node}" "${cli}" review --dir "${dir}" %*\r\n` };
  }
  const quote = value => `'${value.replaceAll("'", `'\\''`)}'`;
  return { name: 'review.sh', text: `#!/bin/sh\n# Opens the UI review for this run. Extra options pass through, e.g. --host 0.0.0.0 --port 8080\nexec ${quote(node)} ${quote(cli)} review --dir ${quote(dir)} "$@"\n` };
}

const tokenSummary = (tokens, source) => (tokens ? { input: tokens.inputTokens, output: tokens.outputTokens, cacheRead: tokens.cacheReadTokens, total: tokens.inputTokens + tokens.outputTokens, source } : null);

export async function runCommand(options, { signal } = {}) {
  try { return await runSteps(options, signal); }
  catch (error) {
    if (error instanceof RunFailure || error instanceof HarnessError) {
      process.stderr.write(`benchboard run: ${error.message}\n`);
      throw new CommandError(error.category ?? 'state');
    }
    throw error;
  }
}

async function runSteps(options, signal) {
  if (signal?.aborted) throw new CommandError('cancelled');
  const plan = runPlanOf(options);
  const env = { ...process.env, BENCHBOARD_PROMPT: AGENT_PROMPT };
  // Resolve the harness and npm before creating anything, so a missing CLI leaves no folder behind.
  const launch = agentLaunch(plan, env);
  const npm = npmExecutable(plan);
  prepareFolder(plan);
  const at = name => path.join(plan.dir, RUN_LAYOUT[name]);
  const runRoot = at('run'), workspace = path.join(runRoot, 'workspace'), agentRoot = at('agent');
  fs.mkdirSync(agentRoot);
  const promptFile = path.join(agentRoot, 'prompt.txt');
  fs.writeFileSync(promptFile, AGENT_PROMPT + '\n');
  env.BENCHBOARD_PROMPT_FILE = promptFile;
  progress(`folder ${plan.dir}`);
  progress('copying the starter code and installing its dependencies (about a minute)');
  await initializeCommand({ '--output': runRoot }, { signal });
  // A plain `npm ci` from the workload's own lockfile, for the agent's tests only: scoring always
  // stages the canonical starter dependencies, and init's install mode refuses the .bin symlinks
  // npm writes on Linux and macOS.
  const install = await runAgentProcess(spawnPlanFor(npm, ['ci', '--no-audit', '--no-fund']), { cwd: workspace, env: process.env,
    signal, timeoutMs: 10 * 60000, stdoutFile: path.join(agentRoot, 'npm-ci.out.log'), stderrFile: path.join(agentRoot, 'npm-ci.err.log') });
  if (install.cancelled) throw new CommandError('cancelled');
  if (install.exitCode !== 0) throw new RunFailure(`npm ci in the workspace failed (${install.spawnError ?? 'exit ' + install.exitCode}); see ${agentRoot}`);
  const label = `${plan.profile.name}:${plan.model ?? 'unspecified'}`;
  await startCommand({ '--run': runRoot, '--model': label, '--worker-count': '1', '--declared-ceiling-minutes': String(plan.minutes) }, { signal });
  progress(`agent started (${label}); limit ${plan.minutes} minutes`);
  const agent = await runAgentProcess(launch.spawn, { cwd: workspace, env, signal, timeoutMs: plan.minutes * 60000,
    stdoutFile: path.join(agentRoot, 'stdout.jsonl'), stderrFile: path.join(agentRoot, 'stderr.log') });
  // Stop is recorded as soon as the process tree is gone, whatever its outcome.
  await stopCommand({ '--run': runRoot, '--operator': 'benchboard-run', '--agents-stopped': true });
  progress(`agent finished in ${(agent.elapsedMs / 60000).toFixed(1)} minutes${agent.timedOut ? ' (time limit reached, stopped)' : ''}`);
  const summary = {
    kind: 'BenchBoardRunSummary', schemaVersion: 1, agent: plan.profile.name, model: plan.model,
    agentExecutable: launch.executable, agentCommand: plan.agentCommand, harnessMajorVersion: launch.major,
    dir: plan.dir, runRoot, workspace, ceilingMinutes: plan.minutes,
    agentRun: { startedAt: agent.startedAt, endedAt: agent.endedAt, elapsedMs: agent.elapsedMs, exitCode: agent.exitCode, timedOut: agent.timedOut },
    tokens: null, approximateTokens: null, workedInWorkspace: null, status: 'AGENT_FINISHED',
    evaluation: null, automated: null, areas: null, wallMinutes: null, humanUI: null, quality: null,
    screenshots: null, aiJudge: null, humanReviews: [],
  };
  const summaryFile = at('summary');
  writeJson(summaryFile, summary);
  if (agent.cancelled) throw new CommandError('cancelled');
  if (agent.spawnError) throw new RunFailure(`the agent could not start (${agent.spawnError}); see ${agentRoot}`);
  const stdout = fs.readFileSync(path.join(agentRoot, 'stdout.jsonl'), 'utf8');
  const outcome = plan.profile.readOutcome({ stdout, executable: launch.executable, env, cwd: workspace, major: launch.major,
    exportFile: path.join(agentRoot, 'session-export.json') });
  summary.workedInWorkspace = workedInWorkspace(outcome, workspace);
  summary.tokens = tokenSummary(outcome.tokens, outcome.tokenSource);
  if (!outcome.tokens && outcome.tokenNote) summary.tokenNote = outcome.tokenNote;
  if (!outcome.tokens && outcome.approximateTokens) summary.approximateTokens = { ...outcome.approximateTokens, note: 'stream step totals; may miss the final step' };
  if (summary.workedInWorkspace === false) {
    summary.status = 'AGENT_WORKED_ELSEWHERE';
    writeJson(summaryFile, summary);
    throw new RunFailure(`the agent worked in ${outcome.directory}, not the run workspace; check --agent-bin (a wrapper may force its own folder). Nothing was scored.`);
  }
  let tokensFile = null;
  if (outcome.tokens) { tokensFile = path.join(agentRoot, 'tokens.json'); writeJson(tokensFile, outcome.tokens); }
  // node_modules is never part of the submission (freeze excludes it and scoring stages the canonical
  // dependencies), but freeze refuses any link anywhere, and npm writes .bin links on Linux/macOS.
  // The agent has stopped, so remove it; rmSync removes links themselves, never their targets.
  fs.rmSync(path.join(workspace, 'node_modules'), { recursive: true, force: true });
  await freezeCommand({ '--run': runRoot });
  progress('evaluating (about three minutes)');
  let evaluation;
  try { evaluation = await evaluateCommand({ '--run': runRoot, ...(tokensFile ? { '--tokens-file': tokensFile } : {}) }, { signal }); }
  catch (error) {
    summary.status = 'EVALUATION_FAILED';
    writeJson(summaryFile, summary);
    if (error instanceof CommandError && error.category === 'infrastructure') progress(`evaluation failed; the attempt logs are under ${runRoot}.benchboard-results`);
    throw error;
  }
  await exportCommand({ '--run': runRoot, '--evaluation': evaluation.evaluationId, '--output': at('export') });
  const report = readJson(path.join(at('export'), 'report.json'));
  Object.assign(summary, {
    status: 'SCORED',
    evaluation: { evaluationId: evaluation.evaluationId, reportId: evaluation.reportId, reportDigest: evaluation.reportDigest, snapshotId: evaluation.snapshotId },
    automated: report.quality.automated, areas: report.quality.areas,
    wallMinutes: report.timing.elapsedMs === null ? null : Math.round(report.timing.elapsedMs / 600) / 100,
  });
  writeJson(summaryFile, summary);
  progress(`automated score ${summary.automated} / 80`);
  try {
    progress('capturing the 12 UI screenshots');
    fs.mkdirSync(at('screens'));
    const { captureScreenshots } = await import('./screenshots.mjs');
    const evidence = await captureScreenshots({ submissionSource: workspace, screensRoot: at('screens') });
    summary.screenshots = { root: at('screens'), evidence };
    writeJson(path.join(at('screens'), 'evidence.json'), evidence);
  } catch (error) {
    summary.screenshots = { root: at('screens'), error: String(error.message ?? error).slice(0, 500) };
    progress(`screenshots failed: ${summary.screenshots.error}`);
  }
  writeJson(summaryFile, summary);
  if (plan.aiJudge && summary.screenshots?.evidence) {
    progress(`AI judge (${plan.aiJudge}) scoring the UI`);
    try {
      const { runAiJudge } = await import('./ai-judge.mjs');
      summary.aiJudge = await runAiJudge({ profile: plan.profile, executable: launch.executable, major: launch.major, model: plan.aiJudge,
        screensRoot: at('screens'), evidence: summary.screenshots.evidence, outputRoot: agentRoot, env });
      progress(`AI UI score (advisory) ${summary.aiJudge.total} / 20`);
    } catch (error) {
      summary.aiJudge = { kind: 'AI_JUDGE_ADVISORY', model: plan.aiJudge, error: String(error.message ?? error).slice(0, 500) };
      progress(`AI judge failed: ${summary.aiJudge.error}`);
    }
    writeJson(summaryFile, summary);
  }
  const launcher = summary.screenshots?.evidence ? reviewLauncherOf({ dir: plan.dir }) : null;
  if (launcher) fs.writeFileSync(path.join(plan.dir, launcher.name), launcher.text, { mode: 0o755 });
  progress(`done; summary in ${summaryFile}. Human UI review: ${launcher ? path.join(plan.dir, launcher.name)
    : `node cli/benchboard.mjs review --dir "${plan.dir}"`}`);
  return Object.freeze({ command: 'run', status: summary.status, dir: plan.dir, agent: summary.agent, model: summary.model,
    automated: summary.automated, wallMinutes: summary.wallMinutes, timedOut: agent.timedOut, tokens: summary.tokens,
    aiUI: summary.aiJudge?.total ?? null, humanUI: null, summary: summaryFile });
}
