// CLI: run the REAL governed chain once and dump the real producers'
// serialized artifacts to a directory, so synchronous fixtures can derive from
// genuine producer output instead of hand-assembling records.
//
//   node runner/tests/produce-chain.mjs <outDir> <ceilingMinutes>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRealGovernedChain } from './chain-harness.mjs';

const out = process.argv[2];
const minutes = Number(process.argv[3] ?? 1);
if (!out) {
  process.stderr.write('usage: produce-chain.mjs <outDir> [ceilingMinutes]\n');
  process.exit(2);
}
// Never touch the reviewed candidate manifest.
const manifestScratch = fs.mkdtempSync(
  path.join(os.tmpdir(), 'bb-produce-manifest-'),
);
process.env.BENCHBOARD_MANIFEST_PATH = path.join(
  manifestScratch,
  'candidate-manifest.json',
);

const chain = await runRealGovernedChain({ idPrefix: 'real', minutes });
try {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(out, 'artifacts.json'),
    JSON.stringify(
      {
        kind: 'REAL_GOVERNED_CHAIN_ARTIFACTS',
        producedAt: new Date().toISOString(),
        id: chain.id,
        minutes: chain.minutes,
        submissionHash: chain.submissionHash,
        seedManifest: JSON.parse(
          fs.readFileSync(path.join(path.dirname(chain.authorityPath), chain.id + '.json'), 'utf8'),
        ),
        armed: chain.armed,
        heartbeat: JSON.parse(fs.readFileSync(chain.heartbeatPath, 'utf8')),
        terminal: chain.terminal,
        authority: chain.authority,
        execution: chain.executionSerialized,
        frozenSubmission: chain.frozenSubmission,
        telemetry: chain.telemetry,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  chain.cleanup();
  fs.rmSync(manifestScratch, { recursive: true, force: true });
}
process.stdout.write('ok\n');
