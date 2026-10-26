/**
 * C6.S11.T3 — independent fresh-user guide walkthrough (guide-only, early lifecycle).
 *
 * This test models a user who follows only the current neutral documentation set —
 * README → QUICKSTART → MANUAL_WORKFLOW → the linked CLI evidence/export guides and
 * the synthetic example — and then executes the guide's short normal route
 * (init(mode none), status, start(declarations), stop(operator-attested), freeze)
 * with the real CLI children on one fresh external run.
 *
 * Deliberate bounds, recorded rather than hidden:
 *   - This walkthrough does NOT run `evaluate`, any browser, a server, an
 *     installation, a participant agent or an export: the route stops after the
 *     freeze. The production command-chain proof and a real human review are
 *     separate stories and are not claimed here.
 *   - No clock is supplied to the CLI, no manual state is fabricated, and no
 *     private storage envelope is inspected: returned IDs are taken from the
 *     summaries the commands themselves print, and every child is the actual
 *     `cli/benchboard.mjs` entrypoint driven shell-free under epoch-less paths.
 *
 * Every test-owned path contains a space, passed as one argv element.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments } from '../../cli/arguments.mjs';
import { COMMANDS } from '../../cli/command-contract.mjs';
import { inventoryTree } from '../../packages/core/identity.mjs';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const entrypoint = path.join(repositoryRoot, 'cli', 'benchboard.mjs');

/* ---- the current neutral guide set a fresh user is pointed to ------------- */
const GUIDE_FILES = Object.freeze({
  quickstart: 'docs/QUICKSTART.md',
  workflow: 'docs/MANUAL_WORKFLOW.md',
  commands: 'docs/examples/MANUAL_COMMANDS.md',
  cli: 'docs/CLI.md',
  cliUi: 'docs/CLI_UI.md',
  cliExport: 'docs/CLI_EXPORT.md',
});

const COMMAND_LINE = /node cli\/benchboard\.mjs/;

/* Historical owner tooling a current guide must never teach as a command. */
const FORBIDDEN_EXECUTABLE_TOKENS = Object.freeze([
  'runner/',
  'npm run self-test',
  'npm run validate',
  'self-validate',
  'refresh-contract-witnesses',
  'watchdog',
  'supervise',
  'create-run',
  '.ps1',
  'dsh-',
]);

const SPAWN_TIMEOUT_MS = 10_000;
const LIFECYCLE_SPAWN_TIMEOUT_MS = 20_000;
const MAX_BUFFER_BYTES = 1_048_576;

/** Read a guide file relative to the repository root. */
const readGuide = (relative) => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

/* The QUICKSTART walkthrough, at module scope so the lifecycle route below
 * derives its argv from the same text the documentation tests inspect. */
const quickstart = readGuide(GUIDE_FILES.quickstart);

/** Fenced code blocks of a markdown document, in order. */
function fencedBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split('\n');
  let current = null;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (current === null) current = [];
      else { blocks.push(current.join('\n')); current = null; }
      continue;
    }
    if (current !== null) current.push(line);
  }
  return blocks;
}

/** Command lines of a fenced block: `node cli/…` lines, quotes intact. */
function commandLines(block) {
  return block.split('\n').map(line => line.trim())
    .filter(line => line.startsWith('node cli/benchboard.mjs'));
}

/**
 * Tokenize one documented command line the way a real user's shell would:
 * a double-quoted run of characters is one token (quotes preserved), and
 * every other whitespace run separates tokens. Stripping quotes first and
 * splitting on spaces is NOT what a shell does, so this extractor is kept
 * honest instead.
 */
function commandTokens(line) {
  const tokens = [];
  const token = /"[^"]*"|\S+/g;
  let match;
  while ((match = token.exec(line)) !== null) tokens.push(match[0]);
  return tokens;
}

/** The bare option tokens (flags with and without values) of a token list. */
const optionTokens = (tokens) => tokens.slice(3)
  .filter(token => token.startsWith('--'));

/* --------------------------------------------------------------------------- */
/* 1. Guide-only path: README → QUICKSTART → MANUAL_WORKFLOW → CLI guides      */
/* --------------------------------------------------------------------------- */

describe('fresh-user guide walkthrough (documentation only)', () => {
  const workflow = readGuide(GUIDE_FILES.workflow);
  const commands = readGuide(GUIDE_FILES.commands);
  const cli = readGuide(GUIDE_FILES.cli);
  const cliUi = readGuide(GUIDE_FILES.cliUi);
  const cliExport = readGuide(GUIDE_FILES.cliExport);

  test('README points a fresh user at QUICKSTART and MANUAL_WORKFLOW, and every local guide link resolves', () => {
    const readme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
    assert.match(readme, /docs\/QUICKSTART\.md/);
    assert.match(readme, /docs\/MANUAL_WORKFLOW\.md/);
    for (const relative of Object.values(GUIDE_FILES)) {
      const markdown = readGuide(relative);
      const linkPattern = /\]\(([^)#\s]+)(#[^)]*)?\)/g;
      let match;
      let checked = 0;
      while ((match = linkPattern.exec(markdown)) !== null) {
        const target = match[1];
        if (target.startsWith('http')) continue;
        const resolved = path.resolve(path.dirname(path.join(repositoryRoot, relative)), target);
        assert.ok(fs.existsSync(resolved) && fs.statSync(resolved).isFile(),
          `${relative} links to ${target}, which does not exist`);
        checked += 1;
      }
      assert.ok(checked > 0, `${relative} carries local guide links`);
    }
  });

  test('the three walkthrough guides teach only commands and flags in the current CLI grammar', () => {
    for (const [label, markdown] of Object.entries({ quickstart, workflow, commands })) {
      const civil = [];
      let commandCount = 0;
      for (const block of fencedBlocks(markdown)) {
        for (const tokens of commandLines(block).map(commandTokens)) {
          commandCount += 1;
          const command = tokens[2];
          assert.ok(Object.hasOwn(COMMANDS, command), `${label}: ${command} is a current command`);
          /* Values carry quotes in the doc line; the parser sees bare values. */
          const parsed = parseArguments([command, ...tokens.slice(3).map(token => token.replaceAll('"', ''))]);
          assert.equal(parsed.command, command);
          assert.equal(parsed.help, false);
          for (const required of COMMANDS[command].required) {
            assert.ok(Object.hasOwn(parsed.options, required),
              `${label}: ${command} line carries its required flag ${required}`);
          }
        }
        for (const line of block.split('\n').map(l => l.trim())) {
          if (line.length > 0 && !COMMAND_LINE.test(line)) civil.push(line);
        }
      }
      assert.ok(commandCount >= 10, `${label} documents the command chain (${commandCount} commands)`);
      for (const forbidden of FORBIDDEN_EXECUTABLE_TOKENS) {
        assert.ok(!civil.some(line => line.includes(forbidden)),
          `${label}: no fenced block teaches the historical executable ${forbidden.replace('npm ', '')}`);
      }
    }
  });

  test('the normal and clockless freeze routes are taught as distinct routes in the current guides', () => {
    /* SHORT normal route of QUICKSTART and the synthetic example: the plain
     * freeze the command token names must exist, and its option tokens carry
     * no clockless attestation — checked on real command tokens, not on a
     * line-shape suffix rule (the rework's vacuous startsWith defect). */
    const plainFreeze = (tokens, label) => assert.deepEqual(optionTokens(tokens), ['--run'],
      `${label}: the normal-guide freeze line states only --run`);
    const freezeLines = [];

    for (const markdown of [quickstart, commands]) {
      for (const block of fencedBlocks(markdown)) {
        for (const tokens of commandLines(block).map(commandTokens)) {
          if (tokens[2] !== 'freeze') continue;
          assert.ok(!optionTokens(tokens).includes('--clockless') &&
            !optionTokens(tokens).includes('--operator') &&
            !optionTokens(tokens).includes('--agents-stopped'),
            `the normal-guide freeze line carries no clockless attestation: ${tokens.join(' ')}`);
          plainFreeze(tokens, 'guide');
          freezeLines.push(tokens);
        }
      }
    }
    assert.equal(freezeLines.length, 2, 'both normal routes document exactly one plain freeze');

    /* Detection proof: the same assertion, applied to a test-local copy of the
     * QUICKSTART plain freeze line that silently gained --clockless, throws —
     * and the real guide's own line is untouched (still passes above). */
    const quickstartTokens = freezeLines[0];
    const tamperedTokens = [...quickstartTokens.slice(0, -1), '--clockless', quickstartTokens[quickstartTokens.length - 1]];
    assert.ok(optionTokens(tamperedTokens).includes('--clockless'),
      'the tampered test-local line carries the clockless flag');
    assert.equal(tamperedTokens[0], quickstartTokens[0],
      'the tampered line is otherwise the QUICKSTART plain freeze line');
    assert.throws(() => plainFreeze(tamperedTokens, 'tampered'), { name: 'AssertionError' },
      'the option-token assertion detects a normal-guide freeze line that learns --clockless');

    /* MANUAL_WORKFLOW teaches both routes separately, and CLI.md sorts their
     * refusals: a bare --clockless, or stop flags without it, are usage
     * refusals before any state comparison; the clockless needs operator and
     * attestation. */
    assert.match(workflow, /freeze --run "<ABSOLUTE_RUN_CONTAINER_PATH>"/);
    assert.match(workflow, /--clockless --operator "<OPERATOR_IDENTITY>" --agents-stopped/);
    assert.match(cli, /one is used per invocation/);
    assert.match(cli, /usage refusal/);
    assert.match(cli, /--clockless --agents-stopped --operator "<OPERATOR_IDENTITY>"/);
  });

  test('the guide chain defines the returned-ID placeholders a real user must substitute', () => {
    /* Unlike this test, a real user has no private-envelope shortcut: the exact
     * IDs come from the command's own summary, and export/ui take no latest. */
    for (const [label, markdown] of Object.entries({ quickstart, workflow, commands })) {
      assert.match(markdown, /runId/, `${label} names the returned run identity`);
      assert.match(markdown, /manifestId/, `${label} names the returned manifest identity`);
      assert.match(markdown, /snapshotId/, `${label} names the returned snapshot identity`);
      assert.match(markdown, /frozenSubmissionId/, `${label} names the returned frozen submission identity`);
      assert.match(markdown, /latest/, `${label} states that no latest selection exists`);
      assert.match(markdown, /storage envelope is not what you parse|Do not parse private envelope|no most-recent-file/i,
        `${label} points the user away from envelope parsing`);
      assert.match(markdown, /separate story|not recorded as passed|not a runtime-proof claim|runtime proof/i,
        `${label} is not sold as the recorded runtime proof`);
    }
    /* CLI evidence/export guides teach the same: fresh destinations, null/zero
     * honesty, and exact-ID selection. */
    assert.match(cliUi, /intentionally\s+invalid/);
    assert.match(cliUi, /picks\s+a\s+["']latest["'] child for you/i);
    assert.match(cliExport, /EXPORT_COMPLETE\.json/);
    assert.match(cliExport, /no\s+latest-child\s+inference|no implicit selection|no default to a latest child/i);
  });
});

/* --------------------------------------------------------------------------- */
/* CLI children, canary, and the guide-derived recipe                          */
/* --------------------------------------------------------------------------- */

/** The test-owned root, whose name contains a space. */
function ownedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb fresh-user probe-'));
  return root;
}

/**
 * Run the actual entrypoint shell-free as one argv array. Used with
 * `--help` (bounded closer) and with the short lifecycle route.
 */
function runChild(argv, { timeout = SPAWN_TIMEOUT_MS } = {}) {
  const result = spawnSync(process.execPath, [entrypoint, ...argv], {
    encoding: 'utf8', shell: false, cwd: repositoryRoot,
    timeout, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true,
  });
  assert.equal(result.error, undefined, `the ${argv[0]} child stayed inside its bound: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const trimmed = (text) => text.replace(/\r\n/g, '\n').trimEnd();

/** A success child: exit 0, empty stderr, exactly one JSON summary line. */
function parseSummary(child, label) {
  assert.equal(child.status, 0, `${label}: exit 0; stderr ${JSON.stringify(child.stderr)}`);
  assert.equal(trimmed(child.stderr), '', `${label}: success writes no stderr`);
  const lines = trimmed(child.stdout).split('\n');
  assert.equal(lines.length, 1, `${label}: exactly one stdout line`);
  return JSON.parse(lines[0]);
}

describe('help children, canary containment and the documented parse recipe', () => {
  test('every current command answers --help, lists its required flags, and touches no canary', () => {
    const root = ownedRoot();
    try {
      const canary = path.join(root, 'watched canary root'); fs.mkdirSync(canary);
      fs.writeFileSync(path.join(canary, 'canary marker.txt'), 'untouched bytes\n');
      const canaryDigestBefore = inventoryTree({ root: canary, skipNames: [] }).digest;

      for (const command of Object.keys(COMMANDS)) {
        const child = runChild([command, '--help']);
        assert.equal(child.status, 0, `${command} --help exits 0`);
        assert.equal(trimmed(child.stderr), '', `${command} --help writes no stderr`);
        const help = child.stdout;
        assert.match(help, new RegExp(`benchboard ${command}`), `${command} --help names the command`);
        for (const required of COMMANDS[command].required) {
          assert.ok(help.includes(required), `${command} --help lists required ${required}`);
        }
        for (const flag of Object.keys(COMMANDS[command].options)) {
          assert.ok(help.includes(flag), `${command} --help lists the flag ${flag}`);
        }
        assert.match(help, /--help/, `${command} --help offers help itself`);
      }
      const globalHelp = runChild(['--help']);
      assert.equal(globalHelp.status, 0);
      assert.match(globalHelp.stdout, /Usage: node cli\/benchboard\.mjs <command> \[options\]/);

      assert.equal(inventoryTree({ root: canary, skipNames: [] }).digest, canaryDigestBefore,
        'the canary root is byte-identical after every help child');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 });
    }
  });

  test('the documented command recipes parse into the full argv shape, flags distinct and paths spaced', () => {
    const root = ownedRoot();
    try {
      /* Exact values a real user substitutes from returned summaries; the run
       * path is a test-owned fresh container with a space, kept as the raw
       * single argv element a shell would pass (no quote characters folded
       * into the path itself). Substituting a snapshot ID keeps template and
       * attachment modes and selector placement distinct — no guessing or
       * latest picking. */
      const runPath = path.join(root, 'run container one');
      assert.ok(runPath.includes(' '), 'the run path is the spaced test-owned path');
      assert.ok(!runPath.includes('"'), 'the argv element carries no folded quote characters');
      const evaluationId = 'MANUAL_RECIPE_EVALUATION';
      const reportId = 'MANUAL_RECIPE_BASELINE_REPORT';
      const childId = 'MANUAL_RECIPE_CHILD_REPORT';
      const snapshotId = `snap-${'a'.repeat(32)}`;

      const recipes = Object.freeze({
        init: ['--dependency-mode', 'none', '--output', `<ABSOLUTE_RUN_CONTAINER_PATH>`],
        status: ['--run', runPath],
        start: ['--run', runPath, '--harness', 'manual', '--model', 'LOCAL MODEL LABEL',
          '--worker-count', '2', '--declared-ceiling-minutes', '60'],
        stop: ['--run', runPath, '--operator', 'operator identity', '--agents-stopped'],
        freezeNormal: ['--run', runPath],
        freezeClockless: ['--run', runPath, '--clockless', '--operator', 'operator identity', '--agents-stopped'],
        evaluate: ['--run', runPath, '--snapshot', snapshotId],
        exportPending: ['--run', runPath, '--evaluation', `<EVALUATION_ID>`, '--output', '<ABSOLUTE_FRESH_EXPORT_DIR>'],
        exportReviewed: ['--run', runPath, '--evaluation', evaluationId, '--report', childId,
          '--output', '<ABSOLUTE_FRESH_REVIEWED_EXPORT_DIR>'],
        uiTemplate: ['--run', runPath, '--template', '--evaluation', evaluationId, '--output', '<ABSOLUTE_FRESH_TEMPLATE_FILE>'],
        uiTemplateByReport: ['--run', runPath, '--template', '--report', reportId, '--output', '<ABSOLUTE_FRESH_TEMPLATE_FILE>'],
        uiAttach: ['--run', runPath, '--input', '<ABSOLUTE_COMPLETED_WORKSHEET_FILE>', '--review-root', '<ABSOLUTE_REVIEW_ROOT>'],
        reset: ['--run', runPath, '--output', '<ABSOLUTE_FRESH_RESET_DESTINATION>', '--dependency-mode', 'none'],
      });

      assert.deepEqual(recipes.init,
        ['--dependency-mode', 'none', '--output', '<ABSOLUTE_RUN_CONTAINER_PATH>'],
        'the init recipe is the exact documented placeholder recipe');

      const parsedFreezeNormal = parseArguments(['freeze', ...recipes.freezeNormal]);
      assert.deepEqual(parsedFreezeNormal.options, { '--run': runPath },
        'the plain freeze recipe states only --run');
      const parsedFreezeClockless = parseArguments(['freeze', ...recipes.freezeClockless]);
      assert.equal(parsedFreezeClockless.options['--clockless'], true);
      assert.equal(parsedFreezeClockless.options['--agents-stopped'], true);
      assert.ok(parsedFreezeClockless.options['--operator'].length > 0);

      const parsedUiTemplate = parseArguments(['ui', ...recipes.uiTemplate]);
      assert.deepEqual(parsedUiTemplate.options,
        { '--run': runPath, '--template': true, '--evaluation': evaluationId, '--output': '<ABSOLUTE_FRESH_TEMPLATE_FILE>' },
        'the template route carries template, one exact selector and a fresh output, and no input/review-root');
      const parsedUiAttach = parseArguments(['ui', ...recipes.uiAttach]);
      assert.deepEqual(parsedUiAttach.options,
        { '--run': runPath, '--input': '<ABSOLUTE_COMPLETED_WORKSHEET_FILE>', '--review-root': '<ABSOLUTE_REVIEW_ROOT>' },
        'the attachment route carries exact input and review root and no template/selector override');

      const parsedExport = parseArguments(['export', ...recipes.exportReviewed]);
      assert.equal(parsedExport.command, 'export');
      assert.equal(parsedExport.options['--report'], childId,
        'the reviewed export names the exact child report, never a latest');
      assert.ok(parsedExport.options['--evaluation'].length > 0,
        'the exported child carries its exact evaluation ID substitution');

      const parsedStart = parseArguments(['start', ...recipes.start]);
      /* The raw spaced path survives parsing as the exact, unchanged,
       * single-element value a real user would pass. */
      assert.equal(parsedStart.options['--run'], runPath);
      assert.equal(Object.keys(parsedStart.options).filter(k => parsedStart.options[k] === runPath).length, 1,
        'the run path is exactly one argv value, not several');
      assert.deepEqual(parsedStart.options, {
        '--run': runPath, '--harness': 'manual', '--model': 'LOCAL MODEL LABEL',
        '--worker-count': '2', '--declared-ceiling-minutes': '60',
      }, 'the start recipe carries all four documented declarations, exact and unmerged');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 });
    }
  });
});

/* --------------------------------------------------------------------------- */
/* 3. The guide's short normal route on one real fresh run                     */
/* --------------------------------------------------------------------------- */

const LIFECYCLE_KEYS = Object.freeze(['command', 'runId', 'manifestId', 'state', 'diagnosis',
  'findingCount', 'guidance', 'startedAt', 'stoppedAt', 'elapsedMs', 'declaration',
  'stopAssurance', 'stopEnforced', 'clockError', 'attempts']);
const INIT_KEYS = Object.freeze(['command', 'status', 'output', 'workspaceRoot', 'stateRoot',
  'workloadDigest', 'workloadFileCount', 'dependencyMode', 'dependencyDigest',
  'manifestId', 'runId', 'durationMs', 'sourceCleanup']);
const FREEZE_KEYS = Object.freeze(['command', 'runId', 'manifestId', 'state', 'diagnosis', 'route',
  'snapshotId', 'frozenSubmissionId', 'snapshotRoot', 'treeDigest', 'fileCount', 'byteCount',
  'frozenAt', 'frozenAtProvenance', 'elapsedMs', 'stopAssurance', 'stopEnforced']);

describe('fresh-user short normal route: init → status → start → stop → freeze', () => {
  test('INITIALIZED, RUNNING, STOP_RECORDED and FROZEN with documented returned IDs and no invented context', () => {
    const root = ownedRoot();
    try {
      const canary = path.join(root, 'watched canary root'); fs.mkdirSync(canary);
      fs.writeFileSync(path.join(canary, 'canary marker.txt'), 'untouched bytes\n');
      const canaryBefore = inventoryTree({ root: canary, skipNames: [] }).digest;

      /* The route argv is derived from the actual QUICKSTART command blocks —
       * not handwritten from source knowledge — so a missing required flag or
       * step in the guide makes this test fail instead of being silently
       * repaired. Only the documented placeholder values are substituted,
       * ordered by the flag that names them. */
      const container = path.join(root, 'run container one');
      const MODEL_LABEL = 'fresh-user walkthrough model';
      const OPERATOR_LABEL = 'fresh-user walkthrough operator';
      const PLACEHOLDER_VALUES = Object.freeze(new Map([
        ['<ABSOLUTE_NEW_CONTAINER_PATH>', container],
        ['<ABSOLUTE_RUN_CONTAINER_PATH>', container],
        ['<MODEL_LABEL>', MODEL_LABEL],
        ['<OPERATOR_IDENTITY>', OPERATOR_LABEL],
      ]));
      const FLAG_VALUES = Object.freeze(new Map([
        ['--worker-count', '2'],
        ['--declared-ceiling-minutes', '60'],
      ]));

      const guideCommands = [];
      for (const block of fencedBlocks(quickstart)) {
        for (const tokens of commandLines(block).map(commandTokens)) {
          guideCommands.push(tokens);
        }
      }
      const requiredOrder = ['init', 'status', 'start', 'stop', 'freeze'];
      const firstIndex = new Map();
      for (let index = 0; index < guideCommands.length; index += 1) {
        if (!firstIndex.has(guideCommands[index][2])) firstIndex.set(guideCommands[index][2], index);
      }
      const indices = requiredOrder.map((command) => {
        assert.ok(firstIndex.has(command), `QUICKSTART documents a ${command} step`);
        return firstIndex.get(command);
      });
      for (let index = 1; index < indices.length; index += 1) {
        assert.ok(indices[index] > indices[index - 1],
          `${requiredOrder[index]} follows ${requiredOrder[index - 1]} in the documented order`);
      }

      /* Substitute the documented placeholders by flag; a placeholder the
       * guide names without a documented substitution does not get invented —
       * the derivation fails explicitly instead. */
      const substitute = (tokens) => {
        const argv = [tokens[2]];
        let previousFlag = null;
        for (const token of tokens.slice(3)) {
          const bare = token.replaceAll('"', '');
          if (token.startsWith('--')) {
            argv.push(token);
            previousFlag = token;
            continue;
          }
          if (PLACEHOLDER_VALUES.has(bare)) argv.push(PLACEHOLDER_VALUES.get(bare));
           else if (bare === '<POSITIVE_INTEGER>' && previousFlag !== null && FLAG_VALUES.has(previousFlag)) argv.push(FLAG_VALUES.get(previousFlag));
           else {
             assert.doesNotMatch(bare, /^<.*>$/, 'an unknown documented placeholder must not be invented');
             argv.push(bare); /* preserve actual documented literals, including invalid ones */
           }
        }
        return argv;
      };
      assert.deepEqual(substitute(['node', 'cli/benchboard.mjs', 'start', '--worker-count', '0']),
        ['start', '--worker-count', '0'], 'literal guide values are never silently repaired');
      assert.throws(() => substitute(['node', 'cli/benchboard.mjs', 'init', '--output', '<UNKNOWN_DESTINATION>']),
        { name: 'AssertionError' }, 'unknown guide placeholders cannot become invented input');

      /* Before any child runs: every derived step must already satisfy the
       * documented grammar and required flags, so a guide omission cannot be
       * silently repaired by a hardcoded argv later. */
      const route = new Map();
      for (const command of requiredOrder) {
        const argv = substitute(guideCommands[firstIndex.get(command)]);
        let parsed = null;
        assert.doesNotThrow(() => { parsed = parseArguments(argv); },
          `${command}: the QUICKSTART-derived argv matches the documented grammar unchanged`);
        for (const required of COMMANDS[command].required) {
          assert.ok(Object.hasOwn(parsed.options, required),
            `${command}: the guide's own line carries the required flag ${required}`);
        }
        route.set(command, argv);
      }

      /* 1. init --dependency-mode none (a real child of the derived argv). */
      const initChild = runChild(route.get('init'), { timeout: LIFECYCLE_SPAWN_TIMEOUT_MS });
      const initSummary = parseSummary(initChild, 'init');
      assert.deepEqual(Object.keys(initSummary).sort(), [...INIT_KEYS].sort(),
        'the init summary is the documented summary shape');
      assert.equal(initSummary.dependencyMode, 'none');
      assert.equal(initSummary.workloadFileCount, 26,
        'init materializes the 26 exported starter files');
      assert.equal(initSummary.status, 'initialised');
      assert.ok(typeof initSummary.runId === 'string' && initSummary.runId.length > 0,
        'the summary returns the runId a user substitutes');
      assert.ok(typeof initSummary.manifestId === 'string' && initSummary.manifestId.length > 0,
        'the summary returns the manifestId a user substitutes');

      /* 2. status on the fresh run, from the derived documented argv. */
      const statusChild = runChild(route.get('status'),
        { timeout: LIFECYCLE_SPAWN_TIMEOUT_MS });
      const statusSummary = parseSummary(statusChild, 'status');
      assert.deepEqual(Object.keys(statusSummary).sort(), [...LIFECYCLE_KEYS].sort());
      assert.equal(statusSummary.state, 'INITIALIZED');
      assert.ok(statusSummary.diagnosis === null || statusSummary.diagnosis === 'consistent',
        `the fresh derived state carries no fault diagnosis (${statusSummary.diagnosis})`);
      assert.deepEqual(statusSummary.attempts, [],
        'status creates no results context; the attempt list is the honest empty view');
      assert.equal(statusSummary.declaration, null,
        'the pre-start declaration is unknown, not invented as a value or zero');
      assert.equal(statusSummary.elapsedMs, null);

      const workspace = initSummary.workspaceRoot;
      const workspaceBefore = inventoryTree({ root: workspace, skipNames: [] }).digest;

      /* 3. start with the explicit documented declarations, derived from the
       * guide's own line only. */
      const startChild = runChild(route.get('start'), { timeout: LIFECYCLE_SPAWN_TIMEOUT_MS });
      const startSummary = parseSummary(startChild, 'start');
      assert.equal(startSummary.state, 'RUNNING');
      assert.ok(startSummary.diagnosis === null || startSummary.diagnosis === 'consistent',
        'a start summary reports the recorded state; its diagnosis stays the mutation view it is');
      assert.deepEqual(startSummary.declaration, {
        harness: 'manual', model: 'fresh-user walkthrough model',
        workerCount: 2, executionMode: 'MANUAL', declaredCeilingMinutes: 60,
      }, 'the declarations are recorded exactly as given, including the manual execution mode');

      /* 4. stop with the operator attestation, derived from the guide's line. */
      const stopChild = runChild(route.get('stop'),
        { timeout: LIFECYCLE_SPAWN_TIMEOUT_MS });
      const stopSummary = parseSummary(stopChild, 'stop');
      assert.equal(stopSummary.state, 'STOP_RECORDED');
      assert.ok(stopSummary.diagnosis === null || stopSummary.diagnosis === 'consistent',
        'a stop summary reports the recorded state; its diagnosis stays the mutation view it is');
      assert.equal(stopSummary.stopAssurance, 'operator-attested');
      assert.equal(stopSummary.stopEnforced, false,
        'the attested stop is unenforced; no process was observed or killed');

      /* 5. freeze on the recorded stop: the plain stopped route, exactly the
       * guide's bare freeze argv (already asserted to carry only --run). */
      const freezeChild = runChild(route.get('freeze'),
        { timeout: LIFECYCLE_SPAWN_TIMEOUT_MS });
      const freezeSummary = parseSummary(freezeChild, 'freeze');
      assert.deepEqual(Object.keys(freezeSummary).sort(), [...FREEZE_KEYS].sort());
      assert.equal(freezeSummary.state, 'FROZEN');
      assert.equal(freezeSummary.diagnosis, 'consistent');
      assert.ok(typeof freezeSummary.snapshotId === 'string' &&
        /^snap-[0-9a-f]{32}$/.test(freezeSummary.snapshotId),
        'the summary returns the documented snapshot ID form');
      assert.ok(typeof freezeSummary.frozenSubmissionId === 'string' &&
        freezeSummary.frozenSubmissionId.length > 0,
        'the summary returns the frozen submission ID');
      assert.equal(freezeSummary.stopAssurance, 'operator-attested',
        'the stopped route reuses the recorded stop attestation byte-identically');
      assert.equal(freezeSummary.stopEnforced, false);
      assert.ok(Number.isFinite(freezeSummary.elapsedMs) && freezeSummary.elapsedMs >= 0,
        'elapsed time is the recorded observed value, not a declared or manufactured number');
      assert.ok(typeof freezeSummary.frozenAt === 'string' && freezeSummary.frozenAt.length > 0);
      assert.ok(typeof freezeSummary.frozenAtProvenance === 'string' &&
        freezeSummary.frozenAtProvenance.length > 0);

      /* 6. No evaluate. The packet's bound is recorded here rather than hidden:
       * this walkthrough ends at the verified frozen state; the later
       * QUICKSTART steps (evaluate, export, ui, reset) stay executed by the
       * separate production chain test only. Evaluation, export, review and
       * reset are that separate proof's surface; the final lifecycle reading
       * reuses the same documented status argv. */
      const finalStatus = parseSummary(runChild(route.get('status'),
        { timeout: LIFECYCLE_SPAWN_TIMEOUT_MS }), 'final status');
      assert.equal(finalStatus.state, 'FROZEN');
      assert.equal(finalStatus.diagnosis, 'consistent');
      for (const summary of [statusSummary, startSummary, stopSummary, freezeSummary, finalStatus]) {
        assert.equal(summary.runId, initSummary.runId, 'all documented steps retain the returned run identity');
        assert.equal(summary.manifestId, initSummary.manifestId, 'all documented steps retain the returned manifest identity');
      }
      assert.equal(freezeSummary.treeDigest, initSummary.workloadDigest, 'the untouched workload is exactly the frozen input');
      assert.deepEqual(finalStatus.attempts, [],
        'no evaluation context was invented by init/status/start/stop/freeze');

      /* 7. The workspace bytes and the canary root are unchanged; the default
       * results root of this early route does not exist. */
      assert.equal(inventoryTree({ root: workspace, skipNames: [] }).digest, workspaceBefore,
        'the participant workspace is byte-identical across the early route');
      assert.equal(inventoryTree({ root: canary, skipNames: [] }).digest, canaryBefore,
        'nothing wrote into the watched canary root');
      assert.ok(!fs.existsSync(`${container}.benchboard-results`),
        'the early route binds or creates no results root');
      const containerEntries = fs.readdirSync(container);
      assert.deepEqual(containerEntries.sort(), ['.benchboard', 'snapshots', 'workspace'],
        `the container holds only the private state root, freeze's saved snapshots and the workspace: ${JSON.stringify(containerEntries)}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 });
    }
  });
});
