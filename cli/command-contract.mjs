// Checkout-local command grammar. Command implementations are loaded only after parsing.
const value = (description) => Object.freeze({ kind: 'value', description });
const flag = (description) => Object.freeze({ kind: 'boolean', description });
const run = { '--run': value('Run container path (not workspace).') };
const dependencies = {
  '--dependency-mode': value('none (default), prepared, or install; never falls back.'),
  '--prepared-root': value('Required compatible dependency cache for prepared mode.'),
  '--source-root': value('Locked dependency source required for prepared and install modes.'),
  '--scratch-root': value('Existing private dependency installation scratch root.'),
  '--npm-executable': value('Explicit npm executable for install mode.'),
  '--expected-dependency-digest': value('Expected lowercase SHA-256 dependency digest.'),
};
const results = { '--results-root': value('External results root; default is <run>.benchboard-results.') };
const command = (description, required, options) => Object.freeze({
  description, required: Object.freeze(required), options: Object.freeze(options),
});
export const COMMANDS = Object.freeze({
  init: command('Initialize a fresh participant container; does not launch an agent.', ['--output'], {
    '--output': value('Fresh absolute output container; parent must exist.'), ...dependencies,
  }),
  start: command('Record manual start and immutable declarations; no agent launch.', ['--run'], {
    ...run, '--harness': value('Declared harness label, at most 128 characters.'), '--model': value('Declared model label, at most 512 characters.'),
    '--worker-count': value('Declared positive integer worker count.'),
    '--declared-ceiling-minutes': value('Declared, unenforced ceiling in minutes.'),
  }),
  stop: command('Record operator-attested stopping; does not stop any process.', ['--run', '--operator', '--agents-stopped'], {
    ...run, '--operator': value('Private operator identity, 2 through 256 characters.'), '--agents-stopped': flag('Attest all agents have stopped.'),
  }),
  status: command('Read verified lifecycle diagnosis and known local result references.', ['--run'], { ...run }),
  freeze: command('Save and verify immutable bytes; never terminates agents.', ['--run'], {
    ...run, '--clockless': flag('Explicit INITIALIZED route with unavailable elapsed time.'),
    '--operator': value('Required operator, 2 through 256 characters, for clockless attestation.'), '--agents-stopped': flag('Attest stopped agents for clockless route.'),
  }),
  reconcile: command('Explicit supported recovery; never steals locks or deletes foreign residue.', ['--run', '--operation', '--disposition', '--operator', '--intent'], {
    ...run, '--operation': value('start, stop, or freeze.'), '--disposition': value('COMPLETE or LEAVE_AS_IS for start/stop; COMPLETE or KEEP_INTERRUPTED for freeze.'),
    '--operator': value('Private operator identity, 2 through 256 characters.'), '--intent': value('Exact lowercase 64-hex interrupted journal event digest.'),
  }),
  evaluate: command('Evaluate only saved verified bytes; human/final quality stays pending.', ['--run'], {
    ...run, ...results, '--snapshot': value('Explicit snapshot ID; required if selection is ambiguous.'),
    '--timeout-ms': value('Per-stage positive integer timeout, 1 through 3600000 milliseconds; accepted C4 default if absent.'),
    '--max-output-bytes': value('Per-stage output bound, 256 through 16777216 bytes; accepted C4 default if absent.'),
    '--tokens-file': value('Optional JSON NeutralTokenInput run total recorded in the report measurements.'),
  }),
  ui: command('Generate an intentionally invalid template or attach a private bound worksheet.', ['--run'], {
    ...run, '--template': flag('Write a blank, intentionally invalid worksheet.'),
    '--evaluation': value('Exact evaluation ID for template generation.'), '--report': value('Exact committed parent report ID.'),
    '--output': value('Fresh private template file.'), '--input': value('Completed private worksheet file.'),
    '--review-root': value('Existing private evidence root for attachment.'),
  }),
  export: command('Write only safe JSON/text summaries; never selects a latest child.', ['--run', '--evaluation', '--output'], {
    ...run, '--evaluation': value('Evaluation whose baseline is selected by default.'),
    '--report': value('Explicit child report belonging to that evaluation.'), '--output': value('Fresh export directory.'),
  }),
  reset: command('Create a fresh run; preserve the original container and results.', ['--run', '--output'], {
    ...run, '--output': value('Fresh destination; never overwritten.'), ...dependencies,
  }),
  run: command('Run one agent end to end in a fresh folder: copy, launch, time, score, screenshot.', ['--agent'], {
    '--agent': value('Harness profile: opencode, claude or command.'),
    '--model': value('Model passed to the harness (required for opencode, e.g. provider/model).'),
    '--dir': value('Existing empty folder outside the repository; default ~/benchboard-runs/<stamp>-<model>.'),
    '--minutes': value('Time limit in whole minutes, 1 through 1440; default 75. The agent is stopped at the limit.'),
    '--agent-bin': value('Explicit harness executable instead of the one found on PATH.'),
    '--agent-command': value('Command line for --agent command; the prompt is in BENCHBOARD_PROMPT and BENCHBOARD_PROMPT_FILE.'),
    '--npm': value('Explicit npm executable for the workspace dependency install.'),
    '--ai-judge': value('Optional model for an advisory AI UI score, run through the same harness.'),
  }),
  review: command('Score the UI of a finished run folder on a local page, or with --ai-judge.', ['--dir'], {
    '--dir': value('A folder produced by run.'),
    '--ai-judge': value('Run the advisory AI judge with this model instead of opening the human review page.'),
    '--agent': value('Harness for --ai-judge: opencode or claude; default the run\'s harness.'),
    '--agent-bin': value('Explicit harness executable for --ai-judge.'),
    '--no-open': flag('Print the review page address without opening a browser (for SSH sessions).'),
    '--host': value('Address to listen on; default 127.0.0.1 (this machine only). 0.0.0.0 makes the page reachable from your network.'),
    '--port': value('Port to listen on; default any free port.'),
  }),
});
