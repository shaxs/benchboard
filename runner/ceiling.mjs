// Canonical per-run execution ceiling. One field, declared before execution,
// immutable once the official clock starts, and derived everywhere else.
// Minutes is the only authoritative unit; seconds/milliseconds are derived so
// independent values can never disagree.
export const CEILING_MIN_MINUTES = 1;
export const CEILING_MAX_MINUTES = 1440;
export const CEILING_POLICY = 'PER_RUN_DECLARED_IMMUTABLE_AFTER_START';
// Runs recorded before the per-run ceiling existed used one global 75-minute
// execution ceiling. Retained only to read historical telemetry truthfully.
export const LEGACY_FIXED_CEILING_SECONDS = 4500;
export function ceilingMinutes(value) {
  if (!Number.isInteger(value) || value < CEILING_MIN_MINUTES || value > CEILING_MAX_MINUTES)
    throw Error(
      'timeCeilingMinutes must be an integer between ' +
        CEILING_MIN_MINUTES +
        ' and ' +
        CEILING_MAX_MINUTES,
    );
  return value;
}
export const ceilingSeconds = (minutes) => ceilingMinutes(minutes) * 60;
export const ceilingMs = (minutes) => ceilingSeconds(minutes) * 1000;
export function deadlineFrom(startedAt, minutes) {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) throw Error('Invalid startedAt');
  return new Date(start + ceilingMs(minutes)).toISOString();
}
// A seeded run manifest must declare its ceiling before execution. Historical
// manifests predate the field; callers decide whether that is acceptable.
export function declaredCeiling(manifest) {
  if (!manifest || manifest.timeCeilingMinutes === undefined)
    throw Error('Run manifest must declare timeCeilingMinutes before execution');
  const minutes = ceilingMinutes(manifest.timeCeilingMinutes);
  if (
    manifest.timeCeilingSeconds !== undefined &&
    manifest.timeCeilingSeconds !== minutes * 60
  )
    throw Error('Derived timeCeilingSeconds disagrees with timeCeilingMinutes');
  return minutes;
}
// Execution ceiling applicable to a telemetry record. Schema 1.2 carries the
// declared per-run value; earlier records keep the historical global ceiling.
export function telemetryCeilingSeconds(data) {
  if (data.schemaVersion === '1.2') {
    if (data.run?.timeCeilingMinutes === undefined || data.run.timeCeilingMinutes === null)
      throw Error('Schema 1.2 requires run.timeCeilingMinutes');
    return ceilingSeconds(data.run.timeCeilingMinutes);
  }
  if (
    data.run?.timeCeilingMinutes !== undefined &&
    data.run.timeCeilingMinutes !== null &&
    ceilingSeconds(data.run.timeCeilingMinutes) !== LEGACY_FIXED_CEILING_SECONDS
  )
    throw Error(
      'Legacy telemetry cannot declare a ceiling other than the historical 75 minutes',
    );
  return LEGACY_FIXED_CEILING_SECONDS;
}
// Single projection of the existing status/termination evidence onto the run
// status vocabulary. Not a second source of truth.
export const RUN_STATUSES = [
  'COMPLETED',
  'TIME_LIMIT',
  'TIME_LIMIT_OVERRUN',
  'STOP_FAILURE',
  'INFRASTRUCTURE_FAILURE',
];
export function projectRunStatus({
  expired,
  launchError,
  exitCode,
  stopFailure,
  overrunSeconds,
}) {
  if (stopFailure) return 'STOP_FAILURE';
  if (launchError) return 'INFRASTRUCTURE_FAILURE';
  if (expired) return overrunSeconds > 0 ? 'TIME_LIMIT_OVERRUN' : 'TIME_LIMIT';
  if (exitCode === 0) return 'COMPLETED';
  return 'INFRASTRUCTURE_FAILURE';
}
