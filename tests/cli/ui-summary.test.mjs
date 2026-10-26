// Synthetic projection proofs, not real CLI execution, C4 evidence, or human judgment. These tests
// show the two UI summaries copy exactly their named fields and nothing else; they do not prove
// evidence correctness, visual authenticity, reviewer authentication or publication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summariseUITemplate, summariseUIAttachment } from '../../cli/ui-summary.mjs';

const CANARY = 'private-canary-not-a-diagnostic';
const OUTPUT_PATH = 'C:/synthetic/local/worksheet-template.json';

function syntheticParent(quality) {
  return {
    schemaVersion: '1.0.0', kind: 'Report', reportId: 'report-parent-synthetic', createdAt: '2026-10-20T00:00:00.000Z',
    reportDigest: 'a'.repeat(64),
    bindings: { manifestId: 'manifest-synthetic', runId: 'run-synthetic', snapshotId: 'snap-synthetic',
      treeDigest: 'c'.repeat(64), challengeIdentityDigest: 'd'.repeat(64), workloadDigest: 'e'.repeat(64) },
    configuration: { harness: CANARY, model: CANARY, workerCount: null, executionMode: 'MANUAL', declaredCeilingMinutes: null },
    execution: { agentOutcome: null, evaluatorExecution: 'SUCCESS', humanReview: 'NOT_REVIEWED', assessmentTrust: 'LOCAL_SELF_ASSESSMENT', enforcement: 'manual', enforced: false },
    quality,
    evidence: { evaluationId: 'eval-synthetic', bundleDigest: 'b'.repeat(64), bundle: { score: quality, logs: [CANARY], artifacts: [CANARY], operator: CANARY, configuration: CANARY, errors: [CANARY], roots: [CANARY] } },
    artifacts: [CANARY],
  };
}

function syntheticChild(quality) {
  const child = syntheticParent(quality);
  return {
    ...child,
    reportId: 'report-child-synthetic',
    reportDigest: 'f'.repeat(64),
    execution: { ...child.execution, humanReview: 'SCORED' },
    provenance: {
      parentReportId: 'report-parent-synthetic',
      parentReportDigest: 'a'.repeat(64),
      review: {
        worksheet: CANARY, reviewer: CANARY, reviewPath: CANARY, evidencePaths: [CANARY],
        signedBy: CANARY, completedAt: '2026-10-20T01:00:00.000Z',
      },
      sources: [CANARY],
    },
  };
}

const opened = { runId: 'run-synthetic', manifestId: 'manifest-synthetic', request: { storeRoot: CANARY } };

const TEMPLATE_KEYS = ['command', 'mode', 'runId', 'manifestId', 'parentReportId', 'parentReportDigest',
  'evaluationId', 'snapshotId', 'output', 'worksheetComplete', 'humanReview', 'humanUI', 'quality'];
const ATTACH_KEYS = ['command', 'mode', 'runId', 'manifestId', 'parentReportId', 'parentReportDigest',
  'reportId', 'reportDigest', 'evaluationId', 'snapshotId', 'humanReview', 'automated', 'humanUI', 'quality'];

test('template summary is exactly the named fields with the deliberately-not-completed zero state', () => {
  const result = summariseUITemplate({ opened, parent: syntheticParent(null), output: OUTPUT_PATH });
  assert.deepEqual(Object.keys(result).sort(), [...TEMPLATE_KEYS].sort());
  assert.equal(result.command, 'ui');
  assert.equal(result.mode, 'template');
  assert.equal(result.runId, 'run-synthetic');
  assert.equal(result.manifestId, 'manifest-synthetic');
  assert.equal(result.parentReportId, 'report-parent-synthetic');
  assert.equal(result.parentReportDigest, 'a'.repeat(64));
  assert.equal(result.evaluationId, 'eval-synthetic');
  assert.equal(result.snapshotId, 'snap-synthetic');
  assert.equal(result.output, OUTPUT_PATH);
  assert.equal(result.worksheetComplete, false);
  assert.equal(result.humanReview, 'NOT_REVIEWED');
  assert.equal(result.humanUI, null);
  assert.equal(result.quality, null);
  assert.ok(Object.isFrozen(result));
});

test('attachment summary is exactly the named fields taken from the accepted child', () => {
  const result = summariseUIAttachment({ opened, parent: syntheticParent(null),
    child: syntheticChild({ automated: 62.5, automatedMaximum: 80, humanUI: 15.5, humanMaximum: 20, quality: 78, status: 'COMPLETE' }) });
  assert.deepEqual(Object.keys(result).sort(), [...ATTACH_KEYS].sort());
  assert.equal(result.command, 'ui');
  assert.equal(result.mode, 'attach');
  assert.equal(result.runId, 'run-synthetic');
  assert.equal(result.manifestId, 'manifest-synthetic');
  assert.equal(result.parentReportId, 'report-parent-synthetic');
  assert.equal(result.parentReportDigest, 'a'.repeat(64));
  assert.equal(result.reportId, 'report-child-synthetic');
  assert.equal(result.reportDigest, 'f'.repeat(64));
  assert.equal(result.evaluationId, 'eval-synthetic');
  assert.equal(result.snapshotId, 'snap-synthetic');
  assert.equal(result.humanReview, 'SCORED');
  assert.equal(result.automated, 62.5);
  assert.equal(result.humanUI, 15.5);
  assert.equal(result.quality, 78);
  assert.ok(Object.isFrozen(result));
});

test('genuine child zero and fractional scores are preserved exactly, never rounded or defaulted', () => {
  const zero = summariseUIAttachment({ opened, parent: syntheticParent(null),
    child: syntheticChild({ automated: 0, automatedMaximum: 80, humanUI: 0, humanMaximum: 20, quality: 0, status: 'COMPLETE' }) });
  assert.equal(zero.automated, 0);
  assert.equal(zero.humanUI, 0);
  assert.equal(zero.quality, 0);
  const fractional = summariseUIAttachment({ opened, parent: syntheticParent(null),
    child: syntheticChild({ automated: 62.5, automatedMaximum: 80, humanUI: 7.5, humanMaximum: 20, quality: 70, status: 'COMPLETE' }) });
  assert.equal(fractional.automated, 62.5);
  assert.equal(fractional.humanUI, 7.5);
  assert.equal(fractional.quality, 70);
});

test('the uncompleted template reports unavailable UI values as null not zero', () => {
  const result = summariseUITemplate({ opened, parent: syntheticParent(null), output: OUTPUT_PATH });
  assert.equal(result.humanUI, null);
  assert.equal(result.quality, null);
  assert.notEqual(result.humanUI, 0);
  assert.notEqual(result.quality, 0);
});

test('reviewer, worksheet, evidence paths and every private canary are never copied, only the chosen output path', () => {
  const template = summariseUITemplate({ opened, parent: syntheticParent(null), output: OUTPUT_PATH });
  const templateJson = JSON.stringify(template);
  assert.equal(templateJson.includes(CANARY), false);
  assert.equal(templateJson.includes(CANARY.slice(0, 8)), false);
  assert.ok(templateJson.includes(OUTPUT_PATH));

  const child = syntheticChild({ automated: 62.5, automatedMaximum: 80, humanUI: 15.5, humanMaximum: 20, quality: 78, status: 'COMPLETE' });
  child.errors = [{ message: CANARY }];
  const attach = summariseUIAttachment({ opened, parent: syntheticParent(null), child });
  const attachJson = JSON.stringify(attach);
  assert.equal(attachJson.includes(CANARY), false);
  assert.equal(attachJson.includes(CANARY.slice(0, 8)), false);
  assert.equal('review' in attach, false);
  assert.equal('provenance' in attach, false);
  assert.equal('evidence' in attach, false);
  assert.equal('configuration' in attach, false);
  assert.equal('errors' in attach, false);
  assert.equal('roots' in attach, false);
});

test('inputs are unchanged by projection and returned objects are frozen', () => {
  const localOpened = { runId: 'run-synthetic', manifestId: 'manifest-synthetic', request: { storeRoot: CANARY } };
  const parent = syntheticParent(null);
  const child = syntheticChild({ automated: 62.5, automatedMaximum: 80, humanUI: 15.5, humanMaximum: 20, quality: 78, status: 'COMPLETE' });
  const snapshot = JSON.stringify({ opened: localOpened, parent, child, output: OUTPUT_PATH });
  const template = summariseUITemplate({ opened: localOpened, parent, output: OUTPUT_PATH });
  const attach = summariseUIAttachment({ opened: localOpened, parent, child });
  assert.ok(Object.isFrozen(template));
  assert.ok(Object.isFrozen(attach));
  assert.equal(JSON.stringify({ opened: localOpened, parent, child, output: OUTPUT_PATH }), snapshot);
});
