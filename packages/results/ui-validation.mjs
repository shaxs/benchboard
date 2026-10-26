// Captain-owned metadata validation independent of Report validation (prevents recursive readers).
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { uiCaps } from '../../evaluator/score.mjs';
import { canonicalJson } from '../core/manifest.mjs';
export class UIWorksheetError extends Error {
  constructor(message) { super(message); this.name = 'UIWorksheetError'; this.code = 'UI_WORKSHEET_INVALID'; }
}
const fail = message => { throw new UIWorksheetError(message); };
const schema = JSON.parse(fs.readFileSync(new URL('../../schemas/ui-worksheet.schema.json', import.meta.url), 'utf8'));
const check = new Ajv2020({allErrors:true,strict:true}).compile(schema);
const meaningful = value => typeof value === 'string' && value.trim().length >= 3 && !/^(?:n\/?a|none|todo|tbd|pending|\.{2,}|-+)$/i.test(value.trim());
export function validateUIWorksheetFacts(value, expected) {
  if (!check(value)) fail('Invalid UI worksheet schema: ' + check.errors.map(e => e.instancePath + ' ' + e.message).join('; ').slice(0,2000));
  if (!value.reviewer.trim() || !Number.isFinite(Date.parse(value.reviewedAt)) || new Date(value.reviewedAt).toISOString() !== value.reviewedAt) fail('Named reviewer and valid canonical UTC review time required');
  if (canonicalJson(value.bindings) !== canonicalJson(expected.bindings) || canonicalJson(value.baseline) !== canonicalJson(expected.baseline)) fail('UI report/evaluation/snapshot/starter binding mismatch');
  const ids = new Map(), views = new Set();
  for (const entry of value.evidence) {
    const view = [entry.target,entry.width,entry.view].join(':');
    if (ids.has(entry.artifactId) || views.has(view)) fail('Duplicate UI artifact identity or viewport/view');
    ids.set(entry.artifactId,entry); views.add(view);
  }
  for (const [key,cap] of Object.entries(uiCaps)) {
    if (!Number.isInteger(value.scores[key]) || value.scores[key]<0 || value.scores[key]>cap || !meaningful(value.notes[key])) fail('Each UI category needs a valid score and evidence note');
    const improvement=value.improvements[key];
    if (value.scores[key]>0 && !improvement) fail('Positive UI points need concrete baseline improvement evidence');
    if (improvement) {
      const starter=ids.get(improvement.starterArtifactId), submission=ids.get(improvement.submissionArtifactId);
      if (!meaningful(improvement.description) || improvement.description.trim().length<12 || !starter || !submission || starter.target!=='starter' || submission.target!=='submission' || starter.width!==submission.width || starter.view!==submission.view) fail('Improvement must describe a matched starter/submission evidence pair');
    }
  }
  return JSON.parse(JSON.stringify(value));
}
export function uiScorerInputOf(value) {
  return {reviewer:value.reviewer,reviewedAt:value.reviewedAt,baselineCompared:true,evidence:JSON.stringify(value.evidence),scores:value.scores,improvements:Object.fromEntries(Object.entries(value.improvements).map(([key,entry])=>[key,entry.description]))};
}
