import fs from 'node:fs';
import path from 'node:path';
import { root, candidate, assertSnapshot } from './files.mjs';
import { readiness } from './readiness.mjs';
// Explicit owner approval and actual calibration evidence are required; never called during self-validation.
export function freeze(evidenceFile) {
  assertSnapshot();
  const e = JSON.parse(fs.readFileSync(evidenceFile));
  const read = (name) =>
    JSON.parse(fs.readFileSync(path.join(root, 'artifacts', name)));
  if (
    readiness(
      read('acceptance-validation.json'),
      read('reference-ui-sanity.json'),
      read('fairness-review.json'),
      candidate(),
    ).READY_FOR_CALIBRATION !== 'YES'
  )
    throw Error('Benchmark acceptance incomplete');
  if (
    e.approved !== true ||
    !e.reviewer ||
    !e.reviewedAt ||
    !e.runs?.length ||
    !e.durationValidated ||
    !e.discriminationValidated ||
    !e.referenceUIValidated ||
    e.fairnessReview?.verdict !== 'PASS' ||
    e.fairnessReview?.BENCHBOARD_MAY_CALIBRATE !== true ||
    !e.deadlineHarnessValidated ||
    JSON.stringify(e.hashes) !== JSON.stringify(candidate())
  )
    throw Error('Incomplete calibration approval');
  if (
    e.runs.some(
      (r) => !r.runId || r.benchmarkVersion !== candidate().version.version,
    )
  )
    throw Error('Mismatched calibration version');
  const p = path.join(
    root,
    'artifacts/frozen',
    candidate().version.version + '.json',
  );
  if (fs.existsSync(p)) throw Error('Already frozen');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        frozenAt: new Date().toISOString(),
        hashes: candidate(),
        calibration: e,
      },
      null,
      2,
    ),
  );
}
if (process.argv[2]) freeze(process.argv[2]);
