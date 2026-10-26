import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('S8 current API crosswalk and reconciled facade docs preserve actual no-injection/failure/privacy boundaries',()=>{
  const guide=fs.readFileSync(new URL('../../docs/RESULTS_API.md',import.meta.url),'utf8').replace(/\s+/g,' ');
  for(const name of ['evaluateFrozen','createReport','saveReport','readPublishedReport','attachUIReview','createExportProjection','renderReportJSON','renderReportText','compareResults','renderComparisonJSON','renderComparisonText','SCORING.md','CLEANUP_FAILED'])assert.ok(guide.includes(name),name);
  for(const phrase of [/synthetic/i,/manual/i,/not.*certif/i,/null/i,/privacy/i,/no.*install/i])assert.match(guide,phrase);
  for(const phrase of [/evaluationRequest\.submission/,/evaluationRequest\.outputRoot/,/evaluation\.status.*success/,/inputs:\s*\[saved,\s*published\]/,/new.*output|output.*new/i,/existing.*parent/i])assert.match(guide,phrase);
  assert.doesNotMatch(guide,/Nothing in the chain auto-creates a run, an output directory or a store/);
  assert.doesNotMatch(guide,/snippet itself creates, installs and reads nothing|evaluation's or the report's null-quality shapes/);
  assert.match(guide,/evidence\.bundle.*null/);
  assert.ok(guide.indexOf("if (evaluation.status !== 'success')")<guide.indexOf('const report = await createReport('),'successful reviewed-flow guard precedes report/publication');
  const bundle=fs.readFileSync(new URL('../../docs/EVIDENCE_BUNDLE.md',import.meta.url),'utf8');
  assert.doesNotMatch(bundle,/changes nothing about `docs\/EVALUATION.md`/);assert.match(bundle,/REPORTING\.md/);assert.match(bundle,/RESULTS_API\.md/);
  assert.doesNotMatch(bundle,/\*\*No C5 promise\*\*|are separate later work/);assert.match(bundle,/\[Safe exports\]\(EXPORTS\.md\)/);
  const facade=fs.readFileSync(new URL('../../packages/evaluation/evaluate-frozen.mjs',import.meta.url),'utf8');assert.match(facade,/CLEANUP_FAILED/);
  for(const suffix of ['d.mts','d.ts']){const types=fs.readFileSync(new URL(`../../packages/evaluation/evaluate-frozen.${suffix}`,import.meta.url),'utf8');assert.match(types,/CLEANUP_FAILED/);assert.match(types,/infrastructure/);}
});
