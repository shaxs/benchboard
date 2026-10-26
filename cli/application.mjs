import { parseArguments, ArgumentError } from './arguments.mjs';
import { renderHelp } from './help.mjs';
import { CommandError, CATEGORIES } from './command-error.mjs';
import { COMMAND_LOADERS } from './command-readiness.mjs';

// The shared fixed readiness table is the seam; caller strings never become import paths.
export async function main(argv, sinks = {}) {
  const write = sinks.write ?? (text => process.stdout.write(`${text}\n`));
  const writeError = sinks.writeError ?? (text => process.stderr.write(`${text}\n`));
  try {
    const parsed = parseArguments(argv);
    if (parsed.help) {
      write(renderHelp(parsed.command));
      return 0;
    }
    const loadHandler = COMMAND_LOADERS[parsed.command];
    if (!loadHandler) throw new CommandError('unavailable');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel);
    try {
      const handler = await loadHandler();
      const result = await handler(parsed.options, { signal: controller.signal });
      write(JSON.stringify(result));
      return 0;
    } finally {
      process.removeListener('SIGINT', cancel);
    }
  } catch (error) {
    let diagnostic = CATEGORIES.infrastructure;
    if (error instanceof ArgumentError) diagnostic = CATEGORIES.usage;
    else if (error instanceof CommandError) diagnostic = CATEGORIES[error.category];
    else {
      try { diagnostic = (await import('./diagnostics.mjs')).diagnosticOf(error); }
      catch { /* Failure loading operational prerequisites remains a controlled infrastructure error. */ }
    }
    writeError(`${diagnostic.code}: ${diagnostic.guidance}`);
    return diagnostic.exitCode;
  }
}
