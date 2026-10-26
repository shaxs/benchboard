import fs from 'node:fs';
import path from 'node:path';
import { score } from './score.mjs';
import { ingest } from '../runner/collect-metrics.mjs';
import { CEILING_POLICY } from '../runner/ceiling.mjs';
import { formalComparability } from '../runner/supervision.mjs';
// The official reporting API consumes the complete bound official run record.
// There is no second convenience route that succeeds where this one fails: a
// caller without the governed inputs must ask explicitly for a descriptive
// report, which is never a current official outcome.
export function report(
  {
    evidence,
    ui = null,
    telemetry = null,
    manifest = null,
    executionRecord = null,
    supervision = null,
    descriptive = false,
  },
  destination,
) {
  const quality = score(evidence, ui);
  // Candidate.9: the caller no longer supplies the governed record, because
  // ingestion RESOLVES the authoritative persisted execution record by run id.
  // An official report therefore succeeds exactly when a governed launch
  // happened, and fails closed inside ingestion otherwise. There is no
  // always-failing API beside a succeeding bypass, and no silent downgrade:
  // non-official analysis must be requested with descriptive: true.
  if (telemetry && !descriptive && !telemetry?.run?.runId)
    throw Error(
      'Official reporting requires telemetry that identifies its run; pass descriptive: true for explicitly non-official analysis',
    );
  const metrics = telemetry
    ? ingest(
        telemetry,
        quality.quality,
        evidence.hidden.filter((t) => t.passed).length,
        manifest,
        descriptive
          ? { official: false }
          : { executionRecord, supervision },
      )
    : null;
  const result = {
    benchmark: 'BenchBoard',
    manifest,
    quality,
    metrics,
    telemetry: telemetry || null,
    evidence,
  };
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(
    path.join(destination, 'report.json'),
    JSON.stringify(result, null, 2),
  );
  const text = `BenchBoard ${manifest?.benchmarkVersion || 'candidate'} — ${manifest?.runId || 'owner self-validation'}
Status: ${metrics?.run.status || (manifest ? 'TELEMETRY_PENDING' : 'SELF_VALIDATION')}
Valid outcome: ${metrics?.validOutcome ?? 'NOT A TIMED RUN'}
Quality: ${quality.quality ?? 'PENDING HUMAN REVIEW'} / 100
Automated: ${quality.automated} / 80
UI: ${quality.humanUI ?? 'PENDING'} / 20
Visible: ${evidence.visiblePassed} / 17
Hidden: ${evidence.hidden.filter((t) => t.passed).length} / 25
Wall: ${metrics ? metrics.wallSeconds / 60 + ' minutes' : 'NO CALIBRATION RUN'}
Declared ceiling: ${metrics ? metrics.timeCeilingMinutes + ' minutes' : 'NOT A TIMED RUN'} (${CEILING_POLICY})
Official outcome: ${metrics ? (metrics.officialOutcomeValid === true ? 'VALID' : 'INVALID - ' + (metrics.ineligibilityReasons ?? []).join('; ')) : 'NOT A TIMED RUN'}
Execution identity: ${metrics?.executionId ?? 'NONE'}
Quality is conditional on the declared ceiling: more available time can permit more engineering work to complete.
Tasks/attempts/retries: ${metrics ? metrics.taskCount + '/' + metrics.attemptCount + '/' + metrics.retries : 'NOT MEASURED'}
Tokens: ${metrics?.totalTokens ?? 'UNAVAILABLE'}
Local GPU-hours: ${metrics?.localGpuHours ?? 'UNAVAILABLE'}
Cloud GPU-hours: ${metrics?.cloudGpuHours ?? 'UNAVAILABLE'}; cloud cost: ${metrics?.cloud?.costUsd ?? 'UNAVAILABLE'}
Fresh tokens: ${metrics?.freshTokens ?? 'UNAVAILABLE'} (uncached input: ${metrics?.uncachedInputTokens ?? 'UNAVAILABLE'})
Quality per million tokens / fresh tokens: ${metrics?.efficiency.qualityPointsPerMillionTokens ?? 'UNAVAILABLE'} / ${metrics?.efficiency.qualityPointsPerMillionFreshTokens ?? 'UNAVAILABLE'}
Deadline overrun seconds: ${metrics?.deadlineOverrunSeconds ?? 'UNAVAILABLE'}; stop confirmed: ${metrics?.stopConfirmed ?? 'UNAVAILABLE'}
`;
  fs.writeFileSync(path.join(destination, 'report.txt'), text);
  return result;
}
// H6: one authoritative formal-comparability predicate lives in
// runner/supervision.mjs and is used by every formal comparison/reporting
// surface. These are thin re-exports so no caller can get a weaker check.
export { formalComparability as comparability, assertFormalComparison } from '../runner/supervision.mjs';
export function scatter(reports, destination) {
  const scored = reports.filter(
    (r) =>
      r.metrics &&
      r.metrics.validOutcome !== false &&
      r.quality.quality !== null,
  );
  const hashFields = [
    'spec',
    'specTree',
    'starter',
    'prd',
    'fixtures',
    'visible',
    'evaluator',
    'scoring',
    'runner',
    'reference',
  ];
  const identities = scored.map((r) => {
    if (!r.manifest?.hashes || hashFields.some((k) => !r.manifest.hashes[k]))
      throw Error('Comparison requires benchmark hash provenance');
    return JSON.stringify([
      r.manifest.benchmarkVersion,
      ...hashFields.map((k) => r.manifest.hashes[k]),
    ]);
  });
  if (new Set(identities).size > 1)
    throw Error('Cannot mix benchmark versions or hashes');
  // H6: eligibility is assessed on the ORIGINAL requested set, before any
  // presentation filtering. Dropping unplottable rows can never upgrade the
  // experiment's validity.
  const comparison = formalComparability(reports);
  const points = scored.map((r) => ({
    id: r.metrics.run.runId,
    architecture: r.metrics.run.architectureId,
    // Absolute elapsed minutes on a shared scale. Never normalised by each
    // run's own ceiling, which would make 75/75 and 180/180 look equivalent.
    minutes: r.metrics.wallSeconds / 60,
    officialMinutes: (r.metrics.officialWindowSeconds ?? r.metrics.wallSeconds) / 60,
    ceiling: r.metrics.timeCeilingMinutes ?? null,
    quality: r.quality.quality,
  }));
  const axisMinutes = Math.max(
    1,
    ...points.map((p) => p.ceiling ?? 0),
    ...points.map((p) => p.minutes),
  );
  const esc = (s) =>
    String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('"', '&quot;');
  const nodes = points
    .map(
      (p) =>
        `<circle cx="${60 + (p.minutes / axisMinutes) * 600}" cy="${340 - (p.quality / 100) * 300}" r="6" fill="${comparison.mode === 'FORMAL' ? '#5858d9' : '#b25a00'}"><title>${esc(p.id)} / ${esc(p.architecture)}: ${p.minutes.toFixed(2)} elapsed min (official window ${p.officialMinutes.toFixed(2)} min), declared ceiling ${p.ceiling === null ? 'unknown' : p.ceiling + ' min'}, ${p.quality} points</title></circle>`,
    )
    .join('');
  fs.writeFileSync(
    destination,
    `<!doctype html><meta charset="utf-8"><title>BenchBoard comparisons</title><style>body{font:16px system-ui;padding:24px}svg{max-width:100%}</style><h1>Quality and wall time</h1><p>Each point is a complete reviewed run plotted on absolute elapsed minutes. Hover for the declared execution ceiling. Compare only matching benchmark hashes; upper-left is better. Pending scores are omitted. Quality is conditional on the declared ceiling.</p><p><strong>${comparison.mode === 'FORMAL' ? 'Formal controlled comparison' : 'DESCRIPTIVE / NON-CONTROLLED comparison'}</strong>${comparison.reasons.length ? ': ' + esc(comparison.reasons.join('; ')) : ' (matching declared ceilings)'}. Declared ceilings: ${esc(comparison.ceilings.map((c) => (c === null ? 'unknown' : c + ' min')).join(', '))}.</p><svg viewBox="0 0 730 400" role="img" aria-label="Quality versus wall clock minutes"><path d="M60 40V340H660" stroke="#555" fill="none"/><text x="260" y="385">Elapsed wall time (0–${axisMinutes} minutes, absolute)</text><text x="5" y="25">Quality (0–100)</text>${nodes}</svg><p>${points.length ? points.length + ' of ' + reports.length + ' requested runs plotted' : 'No calibration data yet.'}${points.length === reports.length ? '' : ' (' + (reports.length - points.length) + ' requested run(s) could not be plotted; eligibility was assessed on the full requested set)'}</p>`,
  );
}
if (process.argv[2])
  report(
    JSON.parse(fs.readFileSync(process.argv[2])),
    process.argv[3] || 'artifacts/report',
  );
