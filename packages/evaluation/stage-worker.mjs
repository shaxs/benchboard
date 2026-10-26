// Private executable. Only the three fixed browser/useful/inspection handlers are dispatchable.
import fs from 'node:fs';
import path from 'node:path';
import { EvaluationInfrastructureError, WORKER_PROTOCOL_VERSION } from './contracts.mjs';

const [stage, requestFile, resultFile, ...extra] = process.argv.slice(2);
if (extra.length || !['browser', 'useful', 'inspection'].includes(stage) || !path.isAbsolute(requestFile ?? '') || !path.isAbsolute(resultFile ?? '')) {
  process.stderr.write('Invalid evaluation worker invocation\n');
  process.exitCode = 2;
} else {
  try {
    const input = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    if (input.protocolVersion !== WORKER_PROTOCOL_VERSION ||
        !['appRoot', 'artifactRoot', 'tempRoot'].every(key => typeof input[key] === 'string' && path.isAbsolute(input[key])) ||
        !Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1) throw Error('Invalid worker request');
    let result;
    try {
      let value;
      if (stage === 'inspection') value = (await import('../../evaluator/collect-evidence.mjs')).inspectPublic(input.appRoot);
      else {
        const execute = stage === 'browser'
          ? (await import('./browser-stage.mjs')).executeBrowserStage
          : (await import('./useful-stage.mjs')).executeUsefulTestsStage;
        value = await execute(Object.freeze(input));
      }
      result = { protocolVersion: WORKER_PROTOCOL_VERSION, status: 'success', value };
    } catch (error) {
      const code = error instanceof EvaluationInfrastructureError ? error.code :
        /executable doesn't exist|executable.*not.*exist|cannot find (?:module|package)|ENOENT/i.test(String(error)) ? 'MISSING_PREREQUISITE' : 'TOOL_CRASH';
      result = { protocolVersion: WORKER_PROTOCOL_VERSION, status: 'infrastructure-error', error: { code, message: String(error.message ?? error).slice(0, 4000), details: error.details ?? {} } };
    }
    let bytes = JSON.stringify(result);
    if (Buffer.byteLength(bytes) > input.maxOutputBytes) bytes = JSON.stringify({ protocolVersion: 1, status: 'infrastructure-error', error: { code: 'OUTPUT_LIMIT', message: 'Worker result exceeded its bound' } });
    fs.writeFileSync(resultFile, bytes, { flag: 'wx' });
  } catch (error) {
    process.stderr.write(String(error.message ?? error).slice(0, 4000) + '\n');
    process.exitCode = 2;
  }
}
