// Captain-owned family discrimination. Recognizing history never grants current evidence/trust.
import { canonicalJson, validateRecord, readLegacyResult, isLegacyEnvelope, LEGACY_RESULT_SCHEMA_VERSIONS } from '../core/manifest.mjs';
import { validateReport } from './report-contract.mjs';
export class ResultInputError extends Error {
  constructor(message) { super(message); this.name = 'ResultInputError'; this.code = 'RESULT_INPUT_INVALID'; }
}
export function classifyResultInput(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new ResultInputError('Result input must be valid JSON'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResultInputError('A report, C1 Result or supported historical object is required');
  // The historical two-part version wins over a coincidentally named kind field; never promote it.
  if (LEGACY_RESULT_SCHEMA_VERSIONS.includes(value.schemaVersion)) return {family:'LEGACY',record:readLegacyResult(value)};
  if (value.kind === 'Report') return {family:'REPORT',record:validateReport(value)};
  if (value.kind === 'Result') return {family:'C1_RESULT',record:validateRecord('Result',value)};
  if (isLegacyEnvelope(value)) {
    const reconstructed = readLegacyResult(value.sourceRecord);
    if (canonicalJson(value) !== canonicalJson(reconstructed)) throw new ResultInputError('Legacy envelope differs from the unchanged non-promoting reader');
    return {family:'LEGACY',record:reconstructed};
  }
  return {family:'LEGACY',record:readLegacyResult(value)};
}
