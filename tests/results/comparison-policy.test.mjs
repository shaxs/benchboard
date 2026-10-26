// Captain policy granularity checks, independent of worker arithmetic/renderers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {comparisonDecision} from '../../packages/results/comparison-policy.mjs';
import {createCompatibilityExport,validateCompatibilityExport} from '../../packages/results/compatibility-export-contract.mjs';
import {privateExportFixture} from './export-fixture.mjs';
import {reportDigestOf,validateReport} from '../../packages/results/report-contract.mjs';
test('S7 review author/time differences remain disclosed without promoting agreement to certification',async t=>{
  const f=await privateExportFixture(t),changed=structuredClone(f.child);
  changed.provenance.review.reviewer='SECOND_PRIVATE_REVIEWER';changed.provenance.review.reviewedAt='2026-02-01T00:00:00.000Z';changed.reportDigest=reportDigestOf(changed);validateReport(changed);
  const decision=comparisonDecision(createCompatibilityExport(f.child),createCompatibilityExport(changed),false);
  assert.equal(decision.disposition,'REVIEWED');assert.ok(decision.disclosures.includes('REVIEWER_DIFFERS'));assert.ok(decision.disclosures.includes('REVIEW_TIME_DIFFERS'));
});
test('S7 timing provenance/unknown ceiling/configuration comparisons use fixed explicit disclosures',async t=>{
  const f=await privateExportFixture(t),base=createCompatibilityExport(f.parent),candidate=structuredClone(base);
  candidate.report.configuration.declaredCeilingMinutes=null;candidate.report.configuration.harnessRef=null;candidate.report.configuration.modelRef=null;candidate.report.configuration.workerCount=null;
  candidate.report.timing={startedAt:'2026-01-01T00:00:00.000Z',stoppedAt:'2026-01-01T00:00:01.000Z',elapsedMs:1000,provenance:'OPERATOR_ATTESTED',clockError:false};
  // A source-free old Report safe summary can be structurally revalidated, not authenticated.
  validateCompatibilityExport(candidate);
  const decision=comparisonDecision(base,candidate,false);
  assert.equal(decision.disposition,'AUTOMATED_ONLY');
  for(const code of ['CEILING_UNAVAILABLE','DECLARATION_UNAVAILABLE','DECLARATION_DIFFERS','TIMING_UNAVAILABLE','TIMING_PROVENANCE_DIFFERS'])assert.ok(decision.disclosures.includes(code),code);
});
