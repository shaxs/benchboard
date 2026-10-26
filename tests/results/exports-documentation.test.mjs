import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('S5 public export guide describes the actual conservative boundary and no authority promotion',()=>{
  const text=fs.readFileSync(new URL('../../docs/EXPORTS.md',import.meta.url),'utf8');
  for(const name of ['createExportProjection','validateExportProjection','renderReportJSON','renderReportText','ExportIntegrityError','EXPORT_INTEGRITY'])assert.ok(text.includes(name),name);
  for(const phrase of [/local self-assessment/i,/not certified/i,/manual.*not enforced/i,/pseudonym/i,/dictionary/i,/correlation/i,/raw.*Report/i,/not.*publication proof/i,/null/i,/suffix/i,/digest/i,/source.*unchanged/i,/historical.*S6/i])assert.match(text,phrase);
  assert.doesNotMatch(text,/[A-Z]:\\(?:Users|projects)\\|https?:\/\/[^\s]*private/i);
});
