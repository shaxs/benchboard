import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, assertSnapshot } from './files.mjs';
import { resolveReferenceUiAcceptance } from './supervision.mjs';
export const trustModel =
  'BenchBoard v1 assumes cooperative benchmark participants operating within their assigned DSH project/workspace. Participants receive only the generated starter application, PRODUCT_PRD.md, visible tests, required fixtures, and ordinary project dependencies/tooling. The benchmark owner retains the hidden evaluator/tests, reference implementation, private scoring internals, seeded-defect answer key, and prior benchmark outputs/private evidence. Participants must not be intentionally given private benchmark material. BenchBoard v1 does not claim adversarial OS-level containment against an agent deliberately inspecting arbitrary host paths. Docker and runtime containment are not readiness gates.';
export function readiness(validation, ui, fairness, hashes) {
  const blockers = [];
  const matches = (e) =>
    e && JSON.stringify(e.hashes) === JSON.stringify(hashes);
  if (!matches(validation) || validation.passed !== true)
    blockers.push('Current benchmark/harness validation');
  if (
    !ui ||
    ui.kind !== 'REFERENCE_UI_SANITY' ||
    ui.verdict !== 'PASS' ||
    !ui.reviewer ||
    !ui.reportedAt ||
    !ui.evidence ||
    !hashes?.reference ||
    ui.referenceHash !== hashes.reference
  )
    blockers.push(
      'Owner reference UI sanity PASS for the current reference implementation',
    );
  const findings = fairness?.findings;
  if (
    !matches(fairness) ||
    !fairness.reviewer ||
    !fairness.reviewedAt ||
    fairness.verdict !== 'PASS' ||
    fairness.BENCHBOARD_MAY_CALIBRATE !== true ||
    !findings ||
    ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].some(
      (k) => !Array.isArray(findings[k]),
    ) ||
    ['CRITICAL', 'HIGH', 'MEDIUM'].some((k) =>
      findings[k].some((f) => !f || f.resolved !== true),
    ) ||
    findings.LOW.some(
      (f) => !f || (f.resolved !== true && !f.nonBlockingJustification),
    )
  )
    blockers.push(
      'Independent fairness PASS with no unresolved Critical/High/Medium findings',
    );
  return {
    READY_FOR_CALIBRATION: blockers.length ? 'NO' : 'YES',
    blockers,
    trustModel,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const read = (p) =>
    fs.existsSync(p) ? JSON.parse(fs.readFileSync(p)) : null;
  console.log(
    JSON.stringify(
      readiness(
        read(path.join(root, 'artifacts/acceptance-validation.json')),
        // Resolve the owner UI PASS that is hash-bound to the CURRENT reference
        // bytes rather than whichever filename is canonical.
        resolveReferenceUiAcceptance(assertSnapshot().reference).record,
        read(path.join(root, 'artifacts/fairness-review.json')),
        assertSnapshot(),
      ),
      null,
      2,
    ),
  );
}
