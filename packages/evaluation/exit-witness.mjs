// Private Node preload: normal-completion evidence, never an invented OS signal or authority.
import fs from 'node:fs';
import path from 'node:path';

const key = 'BENCHBOARD_EVALUATION_EXIT_WITNESS';
const serialized = process.env[key];
delete process.env[key];
if (serialized !== undefined) {
  const request = JSON.parse(serialized);
  if (!request || typeof request.file !== 'string' || !path.isAbsolute(request.file) || !/^[a-f0-9]{32,128}$/.test(request.nonce ?? '')) {
    throw new Error('Invalid private Node exit-witness request');
  }
  let uncaught = false;
  // A tool may deliberately handle an exception and return an ordinary failing result.
  // Observe only the default-fatal case; never turn a tool's handled failure into a crash.
  process.on('uncaughtExceptionMonitor', () => { if (process.listenerCount('uncaughtException') === 0) uncaught = true; });
  process.on('exit', exitCode => {
    // Do not turn a metadata I/O error into a different participant/tool exit status.
    // The parent treats absent/invalid metadata as an infrastructure failure.
    try {
      fs.writeFileSync(request.file, JSON.stringify({
        version: 1, nonce: request.nonce, pid: process.pid, exitCode, normal: !uncaught,
      }), { flag: 'wx' });
    } catch { /* Parent must validate the witness; no default success. */ }
  });
}
