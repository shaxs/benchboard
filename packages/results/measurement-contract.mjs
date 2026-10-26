// Captain-owned provenance/input boundary. Operational record kinds never enter C1 Measurement.source.
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { canonicalJson, sha256Hex, validateRecord } from '../core/manifest.mjs';
import { lifecycleStateDigestOf, elapsedBetween } from '../core/lifecycle.mjs';
import { projectMeasurements } from './measurements.mjs';

export class MeasurementIntegrityError extends Error {
  constructor(message) { super(message); this.name = 'MeasurementIntegrityError'; this.code = 'MEASUREMENT_INTEGRITY'; }
}
const fail = message => { throw new MeasurementIntegrityError(message); };
const digest = value => sha256Hex(canonicalJson(value));
const schema = name => JSON.parse(fs.readFileSync(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
const inputSchema = schema('measurement-inputs');
const ajv = new Ajv2020({strict:true,allErrors:true}).addSchema(schema('lifecycle')).addSchema(schema('snapshot-proof')).addSchema(inputSchema);
const checkSources = ajv.getSchema(inputSchema.$id);
const checkTokens = ajv.compile({$ref:inputSchema.$id+'#/$defs/tokens'});

export function validateNeutralTokenInput(value) {
  if (value === null) return null;
  if (!checkTokens(value)) fail('Neutral tokens require one explicit run total with cache reads already included in input; unknown fields, actor aggregates and ambiguous totals are refused');
  if (value.inputTokens !== null && value.cacheReadTokens !== null && value.cacheReadTokens > value.inputTokens) fail('Cache reads cannot exceed inclusive input tokens');
  return JSON.parse(JSON.stringify(value));
}

export function measurementProjectionInput(report) {
  const sources = report.provenance.sources;
  if (!checkSources({sources}) || Buffer.byteLength(canonicalJson(sources)) > 8388608) fail('Invalid or oversized report measurement source records');
  const byKind = new Map();
  for (const source of sources) {
    if (byKind.has(source.kind)) fail('Duplicate measurement source kind');
    byKind.set(source.kind,source);
    if (source.kind !== 'evaluation' && source.digest !== digest(source.record)) fail('Measurement source digest mismatch');
  }
  const lc = byKind.get('lifecycle')?.record, proof = byKind.get('snapshot-proof')?.record, b = report.bindings;
  if (!lc || !proof || lc.state !== 'FROZEN' || lc.stateDigest !== lifecycleStateDigestOf(lc)) fail('Frozen lifecycle source and its recomputable state digest required');
  if (lc.runId !== b.runId || lc.manifestId !== b.manifestId || lc.manifestDigest !== b.manifestDigest || proof.runId !== b.runId || proof.manifestId !== b.manifestId || proof.snapshotId !== b.snapshotId || proof.frozenSubmissionId !== b.frozenSubmissionId || proof.treeDigest !== b.treeDigest) fail('Measurement sources differ from report run/snapshot bindings');
  for (const key of ['startedAt','stoppedAt','elapsedMs','clockError']) if (canonicalJson(proof.timeProvenance[key]) !== canonicalJson(lc[key])) fail('Freeze/lifecycle timing provenance differs');
  const elapsedMs = proof.freezeRoute === 'STOP_RECORDED' && lc.clockError === null ? elapsedBetween(lc.startedAt,lc.stoppedAt) : null;
  if (lc.elapsedMs !== elapsedMs) fail('Elapsed time must match known forward clock endpoints, or remain unavailable');
  if (lc.declaration) {
    for (const key of ['harness','model','workerCount','executionMode','declaredCeilingMinutes']) if (report.configuration[key] !== lc.declaration[key]) fail('Declared report configuration differs from lifecycle source');
  } else if (report.configuration.workerCount !== null) fail('An unstarted run has no declared worker count');
  const evaluated = byKind.get('evaluation');
  if (report.evidence.bundle !== null) {
    if (!evaluated || evaluated.digest !== report.evidence.bundleDigest || evaluated.recordId !== report.evidence.evaluationId) fail('Evaluation measurement source differs from bound evidence');
  } else if (evaluated) fail('Infrastructure report has no evaluation evidence source');
  const tokens = validateNeutralTokenInput(byKind.get('token-input')?.record ?? null);
  return {idPrefix:report.reportId,timing:{elapsedMs},tokens,quality:{automated:report.quality?.automated??null,humanUI:report.quality?.humanUI??null,quality:report.quality?.quality??null}};
}

export function validateReportMeasurements(report) {
  // Earlier S1 reports remain readable; their empty set never becomes a claim of measured zero.
  if (report.measurements.length === 0 && report.provenance.sources.length === 0) return;
  const input = measurementProjectionInput(report), expected = projectMeasurements(input);
  for (const record of report.measurements) validateRecord('Measurement',record);
  if (canonicalJson(report.measurements) !== canonicalJson(expected)) fail('Report measurements differ from bound source facts or fixed derivations');
}
