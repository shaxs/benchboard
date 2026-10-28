// `run` / `review` building blocks: flag validation, harness launch plans, token parsing,
// process ceilings, AI judge replies and worksheet assembly. No model or browser is launched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPlanOf, RunFailure, reviewLauncherOf } from '../../cli/run-command.mjs';
import { listenAddressOf } from '../../cli/review-command.mjs';
import { siteFile } from '../../cli/live-apps.mjs';
import { AGENT_PROMPT, harnessProfile, neutralTokens, opencodeMajor, parseClaudeStream, parseOpencodeExport, parseOpencodeStream, resolveExecutable, spawnPlanFor, workedInWorkspace } from '../../cli/harness-profiles.mjs';
import { runAgentProcess } from '../../cli/agent-process.mjs';
import { judgePrompt, parseJudgeReply } from '../../cli/ai-judge.mjs';
import { worksheetFrom } from '../../cli/review-command.mjs';
import { TARGETS, WIDTHS, VIEWS, HEIGHT, artifactIdOf } from '../../cli/screenshots.mjs';
import { validateNeutralTokenInput } from '../../packages/results/measurement-contract.mjs';
import { validateUIWorksheetFacts } from '../../packages/results/ui-validation.mjs';
import { INSTALLATION_ROOT } from '../../cli/filesystem.mjs';

const temp = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-run-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const refusal = (options, pattern, category = 'usage') => assert.throws(() => runPlanOf(options, { home: os.tmpdir() }),
  error => error instanceof RunFailure && error.category === category && pattern.test(error.message));

test('run flags: harness, model, minutes, command line and judge are validated with plain messages', () => {
  refusal({ '--agent': 'nope' }, /Unknown --agent/);
  refusal({ '--agent': 'opencode' }, /needs --model/);
  refusal({ '--agent': 'opencode', '--model': 'm', '--minutes': '0' }, /--minutes/);
  refusal({ '--agent': 'opencode', '--model': 'm', '--minutes': '1441' }, /--minutes/);
  refusal({ '--agent': 'opencode', '--model': 'm', '--minutes': '7.5' }, /--minutes/);
  refusal({ '--agent': 'command' }, /needs --agent-command/);
  refusal({ '--agent': 'claude', '--agent-command': 'x' }, /only for --agent command/);
  refusal({ '--agent': 'command', '--agent-command': 'x', '--ai-judge': 'm' }, /--ai-judge needs/);
  refusal({ '--agent': 'claude', '--dir': path.join(INSTALLATION_ROOT, 'runs') }, /outside the BenchBoard repository/);
  refusal({ '--agent': 'claude', '--dir': path.dirname(INSTALLATION_ROOT) }, /outside the BenchBoard repository/);
  const plan = runPlanOf({ '--agent': 'claude' }, { home: os.tmpdir() });
  assert.equal(plan.minutes, 75);
  assert.equal(plan.model, null);
  assert.equal(plan.agentBin, 'claude');
});

test('run folder: default is a stamped folder under home; deep Windows folders are refused up front', () => {
  const now = new Date('2026-10-25T21:07:09.123Z');
  const plan = runPlanOf({ '--agent': 'opencode', '--model': 'example/coder-model:7b' }, { now, home: path.join(os.tmpdir(), 'h') });
  assert.equal(plan.createDir, true);
  assert.equal(path.basename(plan.dir), '20261025-210709-example_coder-model_7b');
  assert.equal(path.basename(path.dirname(plan.dir)), 'benchboard-runs');
  const deep = path.join(os.tmpdir(), 'x'.repeat(150));
  assert.throws(() => runPlanOf({ '--agent': 'claude', '--dir': deep }, { platform: 'win32' }), /too long for Windows/);
  assert.equal(runPlanOf({ '--agent': 'claude', '--dir': deep }, { platform: 'linux' }).dir, path.resolve(deep));
});

test('launch plans: executables run directly, Windows shims go through cmd.exe quoted, unsafe text is refused', () => {
  assert.deepEqual(spawnPlanFor('/usr/bin/opencode', ['run', 'a b'], { platform: 'linux' }),
    { file: '/usr/bin/opencode', args: ['run', 'a b'], shell: false, windowsVerbatimArguments: false });
  assert.equal(spawnPlanFor('C:\\bin\\opencode.exe', ['run'], { platform: 'win32' }).file, 'C:\\bin\\opencode.exe');
  const shim = spawnPlanFor('C:\\npm\\opencode.cmd', ['run', '--model', 'p/m', AGENT_PROMPT], { platform: 'win32', env: { ComSpec: 'C:\\Windows\\cmd.exe' } });
  assert.equal(shim.file, 'C:\\Windows\\cmd.exe');
  assert.deepEqual(shim.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(shim.args[3], `"C:\\npm\\opencode.cmd run --model p/m "${AGENT_PROMPT}""`);
  assert.equal(shim.windowsVerbatimArguments, true);
  assert.throws(() => spawnPlanFor('C:\\npm\\x.cmd', ['a & calc'], { platform: 'win32', env: {} }), /cannot be passed safely/);
  assert.doesNotMatch(AGENT_PROMPT, /["%^&|<>!\r\n]/, 'the fixed prompt survives a .cmd shim');
});

test('harness lookup honours PATH and PATHEXT and accepts explicit absolute paths', t => {
  const root = temp(t);
  const name = process.platform === 'win32' ? 'fakeagent.cmd' : 'fakeagent';
  fs.writeFileSync(path.join(root, name), 'echo hi');
  const env = { PATH: root, PATHEXT: '.EXE;.CMD' };
  // PATHEXT spells extensions in upper case; Windows file lookup ignores case.
  const fold = value => (process.platform === 'win32' ? value?.toLowerCase() : value);
  assert.equal(fold(resolveExecutable('fakeagent', { env })), fold(path.join(root, name)));
  assert.equal(resolveExecutable(path.join(root, name), { env: {} }), path.join(root, name));
  assert.equal(resolveExecutable('missing-agent', { env }), null);
  assert.equal(resolveExecutable(path.join(root, 'missing'), { env }), null);
});

// Shapes recorded from a real `opencode run --format json` (v2.0.29) and its `session export`.
const OPENCODE_STREAM = [
  { type: 'step_start', sessionID: 'ses_A', part: { type: 'step-start' } },
  { type: 'step_finish', sessionID: 'ses_A', part: { type: 'step-finish', tokens: { input: 5763, output: 59, reasoning: 44, cache: { read: 0, write: 0 } } } },
  { type: 'step_finish', sessionID: 'ses_A', part: { type: 'step-finish', tokens: { input: 8127, output: 46, reasoning: 23, cache: { read: 100, write: 7 } } } },
  { type: 'text', sessionID: 'ses_A', part: { type: 'text', text: 'done' } },
].map(event => JSON.stringify(event)).join('\n') + '\nnot json\n';

test('OpenCode: session id and approximate stream totals; export totals win and give the working folder', () => {
  assert.equal(opencodeMajor('opencode v2.0.29'), 2);
  assert.equal(opencodeMajor('1.15.5\n'), 1);
  assert.equal(opencodeMajor('nonsense'), null);
  const stream = parseOpencodeStream(OPENCODE_STREAM);
  assert.equal(stream.sessionId, 'ses_A');
  assert.deepEqual(stream.totals, { input: 5763 + 8127 + 100 + 7, output: 59 + 44 + 46 + 23, cacheRead: 100, steps: 2 });
  const v2 = parseOpencodeExport(JSON.stringify({ info: { location: { directory: 'C:\\w' }, tokens: { input: 22673, output: 118, reasoning: 164, cache: { read: 10, write: 0 } } }, messages: [] }));
  assert.deepEqual(v2, { directory: 'C:\\w', totals: { input: 22683, output: 282, cacheRead: 10 } });
  const v1 = parseOpencodeExport('Exporting session\n' + JSON.stringify({ info: { directory: '/w' }, messages: [{ info: { tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } } }, { info: {} }] }));
  assert.deepEqual(v1, { directory: '/w', totals: { input: 10, output: 5, cacheRead: 4 } });
  // Shape recorded from a real OpenCode 1.15.5 `opencode export`: session totals with input
  // excluding cache reads, and the working folder as info.directory.
  const v115 = parseOpencodeExport(JSON.stringify({ info: { id: 'ses_B', projectID: 'global', directory: '/home/u/run/workspace', version: '1.15.5',
    tokens: { input: 7450, output: 76, reasoning: 0, cache: { read: 7399, write: 0 } } }, messages: [] }));
  assert.deepEqual(v115, { directory: '/home/u/run/workspace', totals: { input: 14849, output: 76, cacheRead: 7399 } });
  assert.equal(parseOpencodeExport('garbage'), null);
  assert.deepEqual(harnessProfile('opencode').agentArgs({ model: 'p/m', prompt: 'P', major: 2 }), ['run', '--standalone', '--auto', '--format', 'json', '--model', 'p/m', 'P']);
  assert.deepEqual(harnessProfile('opencode').agentArgs({ model: 'p/m', prompt: 'P', major: 1 }), ['run', '--format', 'json', '--model', 'p/m', 'P']);
});

test('OpenCode outcome: a large export is read whole from a file, PWD names the real folder, failures say why', async t => {
  const root = temp(t), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  // A fake `opencode export` that reports PWD as the session folder (as 1.15.5 does), writes
  // several megabytes and exits at once, and fails for an unknown session.
  const script = path.join(root, 'fake-opencode.mjs');
  fs.writeFileSync(script, [
    "const id = process.argv[process.argv.length - 1];",
    "if (id !== 'ses_A') { console.error('Session not found: ' + id); process.exit(1); }",
    "const info = { directory: process.env.PWD, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 0 } } };",
    "process.stdout.write(JSON.stringify({ info, messages: [{ info: {}, parts: [{ text: 'x'.repeat(4 << 20) }] }] }));",
    'process.exit(0);',
  ].join('\n'));
  let executable;
  if (process.platform === 'win32') {
    executable = path.join(root, 'opencode.cmd');
    fs.writeFileSync(executable, `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    executable = path.join(root, 'opencode');
    fs.writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  const read = (stdout, name) => harnessProfile('opencode').readOutcome({ stdout, executable, env: { ...process.env, PWD: root }, cwd: workspace, major: 1,
    exportFile: path.join(root, name) });
  const ok = read(OPENCODE_STREAM, 'ok.json');
  assert.deepEqual(ok.tokens, neutralTokens('opencode-session-export', { input: 5, output: 5, cacheRead: 4 }));
  assert.equal(ok.tokenNote, null);
  assert.equal(workedInWorkspace(ok, workspace), true, 'an inherited PWD is replaced by the real working folder');
  assert.ok(fs.statSync(path.join(root, 'ok.json')).size > 4 << 20, 'the whole export is kept as evidence');
  const failed = read(OPENCODE_STREAM.replaceAll('ses_A', 'ses_GONE'), 'failed.json');
  assert.equal(failed.tokens, null);
  assert.match(failed.tokenNote, /^session export failed \(exit 1\): .*Session not found: ses_GONE/);
  assert.equal(read('', 'none.json').tokenNote, 'no session id in the agent output');
  // Every launched process also gets a PWD matching its working folder.
  const pwd = await runAgentProcess({ file: process.execPath, args: ['-e', 'console.log(process.env.PWD)'] },
    { cwd: workspace, env: { ...process.env, PWD: root }, timeoutMs: 30000, stdoutFile: path.join(root, 'pwd.out'), stderrFile: path.join(root, 'pwd.err') });
  assert.equal(pwd.exitCode, 0);
  assert.equal(fs.readFileSync(path.join(root, 'pwd.out'), 'utf8').trim(), workspace);
});

test('Claude Code: result modelUsage totals (cache included in input), usage fallback, init cwd', () => {
  const lines = events => events.map(event => JSON.stringify(event)).join('\n');
  const withModels = parseClaudeStream(lines([
    { type: 'system', subtype: 'init', cwd: '/w' },
    { type: 'result', usage: { input_tokens: 1 }, modelUsage: {
      big: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 20 },
      small: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } },
  ]));
  assert.deepEqual(withModels, { directory: '/w', totals: { input: 1125, output: 51, cacheRead: 1000 } });
  const usageOnly = parseClaudeStream(lines([{ type: 'result', usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 } }]));
  assert.deepEqual(usageOnly, { directory: null, totals: { input: 14, output: 4, cacheRead: 5 } });
  assert.deepEqual(parseClaudeStream('{"type":"assistant"}'), { directory: null, totals: null });
  const args = harnessProfile('claude').agentArgs({ model: 'opus', prompt: 'P' });
  assert.deepEqual(args.slice(0, 2), ['-p', 'P']);
  assert.ok(args.includes('stream-json') && args.includes('--verbose') && args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(args.slice(-3), ['--disallowedTools', 'WebFetch', 'WebSearch']);
});

test('evaluate --tokens-file is checked before any run is opened: bad statement is usage, unreadable JSON is integrity', async t => {
  const root = temp(t), missingRun = path.join(root, 'no-run');
  const bad = path.join(root, 'bad.json'), garbage = path.join(root, 'garbage.json');
  fs.writeFileSync(bad, JSON.stringify({ ...neutralTokens('x-source', { input: 1, output: 1, cacheRead: 5 }) }));
  fs.writeFileSync(garbage, '{not json');
  const { main } = await import('../../cli/application.mjs');
  const quiet = { write: () => {}, writeError: () => {} };
  assert.equal(await main(['evaluate', '--run', missingRun, '--tokens-file', bad], quiet), 2, 'cache reads above input are refused');
  assert.equal(await main(['evaluate', '--run', missingRun, '--tokens-file', garbage], quiet), 4);
  assert.equal(fs.existsSync(missingRun), false);
});

test('token statements satisfy the report contract; unknown directories stay unknown', () => {
  const tokens = neutralTokens('opencode-session-export', { input: 22683, output: 282, cacheRead: 10 });
  assert.deepEqual(validateNeutralTokenInput(tokens), tokens);
  assert.equal(workedInWorkspace({ directory: null }, os.tmpdir()), null);
  assert.equal(workedInWorkspace({ directory: os.tmpdir() }, os.tmpdir()), true);
  assert.equal(workedInWorkspace({ directory: path.join(os.tmpdir(), 'elsewhere') }, os.tmpdir()), false);
});

test('agent process: exit code and output files, ceiling kills the process tree, spawn errors are reported', async t => {
  const root = temp(t);
  const files = name => ({ stdoutFile: path.join(root, name + '.out'), stderrFile: path.join(root, name + '.err') });
  const ok = await runAgentProcess({ file: process.execPath, args: ['-e', 'console.log("hi"); console.error("e"); process.exit(3)'] },
    { cwd: root, env: process.env, timeoutMs: 30000, ...files('ok') });
  assert.equal(ok.exitCode, 3);
  assert.equal(ok.timedOut, false);
  assert.equal(fs.readFileSync(path.join(root, 'ok.out'), 'utf8').trim(), 'hi');
  assert.equal(fs.readFileSync(path.join(root, 'ok.err'), 'utf8').trim(), 'e');
  // A parent that starts a long-lived child: the ceiling must not leave the grandchild running.
  const marker = path.join(root, 'grandchild.pid');
  const parent = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000)`;
  const slow = await runAgentProcess({ file: process.execPath, args: ['-e', parent] }, { cwd: root, env: process.env, timeoutMs: 1500, ...files('slow') });
  assert.equal(slow.timedOut, true);
  assert.ok(slow.elapsedMs >= 1400 && slow.elapsedMs < 20000);
  const grandchild = Number(fs.readFileSync(marker, 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.throws(() => process.kill(grandchild, 0), 'grandchild was killed with the tree');
  const missing = await runAgentProcess({ file: path.join(root, 'no-such-agent'), args: [] }, { cwd: root, env: process.env, timeoutMs: 5000, ...files('missing') });
  assert.equal(missing.spawnError, 'ENOENT');
  const abort = new AbortController();
  const pending = runAgentProcess({ file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, { cwd: root, env: process.env, timeoutMs: 30000, signal: abort.signal, ...files('cancel') });
  setTimeout(() => abort.abort(), 300);
  assert.equal((await pending).cancelled, true);
});

test('AI judge: prompt names every screenshot and avoids cmd.exe metacharacters; replies are cap-checked', () => {
  const images = TARGETS.flatMap(target => WIDTHS.flatMap(width => VIEWS.map(view => path.join('/s', artifactIdOf(target, width, view)))));
  const prompt = judgePrompt(images);
  for (const image of images) assert.ok(prompt.includes(path.basename(image)));
  assert.doesNotMatch(prompt, /["%^&|<>!\r\n]/);
  const scores = { polish: 5, hierarchy: 3, board: 3, drawer: 3, feedback: 2, responsive: 2, consistency: 2 };
  const reply = parseJudgeReply('Here you go:\n' + JSON.stringify({ scores, notes: { polish: 'clean' } }) + '\n');
  assert.equal(reply.total, 20);
  assert.equal(reply.notes.polish, 'clean');
  assert.equal(reply.notes.board, '');
  assert.equal(parseJudgeReply(JSON.stringify({ scores: { ...scores, polish: 6 } })), null);
  assert.equal(parseJudgeReply(JSON.stringify({ scores: { ...scores, drawer: 1.5 } })), null);
  assert.equal(parseJudgeReply('no json'), null);
});

test('review page address: loopback and any port by default; bad --host or --port is a usage error', () => {
  assert.deepEqual(listenAddressOf({}), { host: '127.0.0.1', port: 0 });
  assert.deepEqual(listenAddressOf({ '--host': '0.0.0.0', '--port': '8080' }), { host: '0.0.0.0', port: 8080 });
  for (const options of [{ '--port': '70000' }, { '--port': '-1' }, { '--port': 'eighty' }, { '--host': 'a b' }, { '--host': '' }]) {
    assert.throws(() => listenAddressOf(options), error => error instanceof RunFailure && error.category === 'usage', JSON.stringify(options));
  }
});

test('live app files: built files are served, client routes fall back to index.html, nothing outside the site', t => {
  const root = temp(t), site = path.join(root, 'site');
  fs.mkdirSync(path.join(site, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(site, 'assets', 'app.js'), '');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'no');
  assert.deepEqual(siteFile(site, '/'), { file: path.join(site, 'index.html'), type: 'text/html; charset=utf-8' });
  assert.deepEqual(siteFile(site, '/assets/app.js'), { file: path.join(site, 'assets', 'app.js'), type: 'text/javascript; charset=utf-8' });
  assert.equal(siteFile(site, '/issues/BB-001').file, path.join(site, 'index.html'));
  assert.equal(siteFile(site, '/assets/missing.js'), null);
  for (const escape of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/assets/..%2f..%2fsecret.txt', '/%E0%A4%A']) {
    const found = siteFile(site, escape);
    assert.ok(found === null || found.file.startsWith(site + path.sep), escape);
    assert.notEqual(found?.file, path.join(root, 'secret.txt'), escape);
  }
});

test('review launcher: run folders get a review.sh or review.cmd that passes options through', () => {
  const sh = reviewLauncherOf({ dir: "/home/u/it's runs", node: '/usr/bin/node', repo: '/opt/benchboard', platform: 'linux' });
  assert.equal(sh.name, 'review.sh');
  assert.match(sh.text, /^#!\/bin\/sh\n/);
  assert.ok(sh.text.includes(`exec '/usr/bin/node' '${path.join('/opt/benchboard', 'cli', 'benchboard.mjs')}' review --dir '/home/u/it'\\''s runs' "$@"\n`), sh.text);
  const cmd = reviewLauncherOf({ dir: 'C:\\runs\\a', node: 'C:\\node\\node.exe', repo: 'C:\\bb', platform: 'win32' });
  assert.equal(cmd.name, 'review.cmd');
  assert.match(cmd.text, /review --dir "C:\\runs\\a" %\*\r\n$/);
  assert.equal(reviewLauncherOf({ dir: 'C:\\runs\\100%', node: 'C:\\node.exe', repo: 'C:\\bb', platform: 'win32' }), null);
});

test('review worksheet: form + screenshots + template make a worksheet the accepted validator takes', () => {
  const hex = c => c.repeat(64);
  const template = { schemaVersion: '1.0.0', kind: 'UIWorksheet', reviewId: '', reviewer: '', reviewedAt: '', baselineCompared: false,
    bindings: { reportId: 'report-1', reportDigest: hex('a'), evaluationId: 'eval-1', bundleDigest: hex('b'), snapshotId: 'snap-1', treeDigest: hex('c') },
    baseline: { challengeIdentityDigest: hex('d'), starterDigest: hex('e'), workloadDigest: hex('e') },
    evidence: [], scores: {}, notes: {}, improvements: {} };
  const evidence = TARGETS.flatMap(target => WIDTHS.flatMap(width => VIEWS.map(view =>
    ({ artifactId: artifactIdOf(target, width, view), bytes: 1000, sha256: hex('f'), target, width, height: HEIGHT, view, note: null }))));
  const form = { reviewer: 'Owner', scores: { polish: 2, hierarchy: 0, board: 1, drawer: 0, feedback: 0, responsive: 0, consistency: 0 },
    notes: { polish: 'tidier spacing', hierarchy: 'same as starter', board: 'cards readable', drawer: 'unchanged', feedback: 'unchanged', responsive: 'unchanged', consistency: 'unchanged' },
    improvements: { polish: { description: 'consistent spacing and type scale', pair: '1440:board' }, board: { description: 'priority badges are now distinct', pair: '768:board' } } };
  const worksheet = worksheetFrom(template, evidence, form, { reviewId: 'review-1', reviewedAt: '2026-10-25T21:00:00.000Z' });
  assert.equal(worksheet.evidence.length, 12);
  assert.ok(worksheet.evidence.every(entry => !('note' in entry)));
  assert.deepEqual(worksheet.improvements.board, { description: 'priority badges are now distinct', starterArtifactId: 'starter-768-board.png', submissionArtifactId: 'submission-768-board.png' });
  assert.deepEqual(validateUIWorksheetFacts(worksheet, template).scores, form.scores);
  const missingImprovement = worksheetFrom(template, evidence, { ...form, improvements: {} }, { reviewId: 'review-1', reviewedAt: '2026-10-25T21:00:00.000Z' });
  assert.throws(() => validateUIWorksheetFacts(missingImprovement, template), /improvement/i);
});
