import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { canonicalJson } from '../packages/core/manifest.mjs';
import { INSTALLATION_ROOT, readOrdinaryJson, rejectIntegrity } from './filesystem.mjs';
const schema = readOrdinaryJson(path.join(INSTALLATION_ROOT, 'schemas', 'cli-state.schema.json'));
const check = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
export function validateCliRecord(value) {
  const copy = JSON.parse(canonicalJson(value));
  if (!check(copy)) rejectIntegrity();
  if (copy.kind === 'benchboard.cli.attempt-terminal.v1') {
    if ((copy.reportId === null) !== (copy.reportDigest === null) ||
        (copy.status === 'SUCCEEDED' && (copy.reportId === null || copy.evaluationId === null)) ||
        (['REFUSED', 'CANCELLED'].includes(copy.status) && copy.reportId !== null)) rejectIntegrity();
  }
  return Object.freeze(copy);
}
