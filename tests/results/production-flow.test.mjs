// Captain slow acceptance. Explicitly runs production C4 installed tools/Chromium and
// evaluator-managed loopback services on a fresh external frozen reference copy only.
// No dependency install, participant benchmark run or public release qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createFrozenFixture,snapshotInputs,assertInputsUnchanged} from '../evaluation/helpers.mjs';
import {evaluateFrozen} from '../../packages/evaluation/evaluate-frozen.mjs';
import {createReport} from '../../packages/results/report.mjs';
import {saveReport,readPublishedReport,attachUIReview} from '../../packages/results/publication.mjs';
import {publicationKeysOf} from '../../packages/results/publication-runtime.mjs';
import {physicalWorksheet} from './publication-fixture.mjs';
import {createExportProjection} from '../../packages/results/export-contract.mjs';
import {renderReportJSON,renderReportText} from '../../packages/results/exports.mjs';
import {compareResults,validateComparison} from '../../packages/results/comparison.mjs';
import {renderComparisonJSON,renderComparisonText} from '../../packages/results/comparison-exports.mjs';
import {inventoryTree} from '../../packages/core/identity.mjs';
import {canonicalJson} from '../../packages/core/manifest.mjs';

test('S8 production C4 frozen temporary reference flows through immutable baseline, synthetic UI child, safe exports and descriptive comparison', {timeout:300000},async t=>{
  const f=await createFrozenFixture(t,{variant:'reference'}),before=snapshotInputs(f);
  const result=await evaluateFrozen(f.request); // Never use the helper's controlled runtime.
  assert.equal(result.status,'success',JSON.stringify(result.error??null));assert.equal(result.score,null);assert.ok(result.bundle);
  const evaluationBefore=inventoryTree({root:f.request.outputRoot,skipNames:[]}).digest;
  const report=await createReport({reportId:'report-production-flow',createdAt:'2026-01-02T00:00:00.000Z',selection:f.request.submission,evaluation:result});
  assert.deepEqual(report.quality,result.bundle.score);assert.equal(report.quality.humanUI,null);assert.equal(report.quality.quality,null);
  const storeRoot=path.join(f.root,'flow-store'),reviewRoot=path.join(f.root,'flow-review');fs.mkdirSync(storeRoot);fs.mkdirSync(reviewRoot);
  const roots={storeRoot,runRoot:f.run.output,evaluationRoot:f.request.outputRoot};
  const published=await saveReport({...roots,report});
  const keys=publicationKeysOf(report.reportId),parentBytes=fs.readFileSync(path.join(storeRoot,keys.report.relativePath)),markerBytes=fs.readFileSync(path.join(storeRoot,keys.commit.relativePath));
  const worksheet=physicalWorksheet(published,reviewRoot),child=await attachUIReview({...roots,parentReportId:published.reportId,reportId:'report-production-reviewed',createdAt:'2026-01-04T00:00:00.000Z',worksheet,reviewRoot});
  const reread=await readPublishedReport({storeRoot,reportId:published.reportId});
  assert.equal(canonicalJson(reread),canonicalJson(report));assert.equal(child.provenance.parentReportDigest,report.reportDigest);
  assert.deepEqual(child.evidence,report.evidence);assert.equal(child.quality.automated,report.quality.automated);assert.equal(child.quality.humanUI,20);
  assert.deepEqual(child.quality.areas,report.quality.areas);
  assert.deepEqual(fs.readFileSync(path.join(storeRoot,keys.report.relativePath)),parentBytes);assert.deepEqual(fs.readFileSync(path.join(storeRoot,keys.commit.relativePath)),markerBytes);
  const safe=createExportProjection(child),json=renderReportJSON(safe),text=renderReportText(safe);
  assert.deepEqual(JSON.parse(json),safe);assert.equal(safe.quality.quality,child.quality.quality);assert.ok(text.includes('quality.humanUI: 20\n'));
  for(const privateValue of [f.root,reviewRoot,worksheet.reviewer,worksheet.notes.polish]){assert.ok(!json.includes(privateValue));assert.ok(!text.includes(privateValue));}
  const comparison=compareResults({inputs:[report,child],baselineIndex:0});assert.equal(comparison.items[1].disposition,'AUTOMATED_ONLY');assert.deepEqual(comparison.items[1].deltas,{automated:0,humanUI:null,quality:null});
  const reviewed=compareResults({inputs:[child,child],baselineIndex:0});assert.equal(reviewed.items[1].disposition,'REVIEWED');assert.deepEqual(reviewed.items[1].deltas,{automated:0,humanUI:0,quality:0});
  assert.deepEqual(JSON.parse(renderComparisonJSON(reviewed)),validateComparison(reviewed));assert.ok(renderComparisonText(reviewed).includes('items.1.deltas.quality: 0\n'));assert.equal(reviewed.formalComparisonAvailable,false);
  assert.equal(inventoryTree({root:f.request.outputRoot,skipNames:[]}).digest,evaluationBefore);assertInputsUnchanged(f,before);
  console.log('S8 production-flow evidence: real C4 success; original automated categories preserved; synthetic UI20; parent bytes/evaluation/frozen/workspace unchanged; safe JSON/text; descriptive masks and formal false.');
});
