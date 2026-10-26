import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scatter } from '../../evaluator/report.mjs';
import { officialRow } from './governed-fixture.mjs';
import { root } from '../files.mjs';
import { ingest } from '../collect-metrics.mjs';
import { analyzeSource } from '../../evaluator/collect-evidence.mjs';
import {
  usefulMutations,
  mutationDomains,
  mutationSetup,
} from '../../evaluator/useful-tests.mjs';
const sample = () =>
  JSON.parse(
    fs.readFileSync(path.join(root, 'runner/telemetry.example.json'), 'utf8'),
  );
test('comparison plots omit failed-stop outcomes and disclose actual overrun time', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-fairness-plot-'));
  try {
    const at = path.join(scratch, 'comparison.html');
    const hashes = Object.fromEntries(
      [
        'spec',
        'specTree',
        'starter',
        'prd',
        'fixtures',
        'visible',
        'evaluator',
        'scoring',
        'runner',
        'reference',
      ].map((k) => [k, 'same']),
    );
    const row = {
      manifest: { benchmarkVersion: 'candidate.4', hashes, publicHash: 'same' },
      quality: { quality: 90 },
      metrics: {
        validOutcome: true,
        wallSeconds: 4505,
        officialWindowSeconds: 4500,
        timeCeilingMinutes: 75,
        supervisionValid: true,
        outcomeClass: 'OFFICIAL_SUPERVISED',
        run: { runId: 'observed-overrun', architectureId: 'synthetic' },
      },
    };
    scatter(
      [
        row,
        {
          ...row,
          metrics: {
            ...row.metrics,
            validOutcome: false,
            supervisionValid: false,
            outcomeClass: 'SUPERVISION_INVALID',
            run: { ...row.metrics.run, runId: 'failed-stop' },
          },
        },
      ],
      at,
    );
    const html = fs.readFileSync(at, 'utf8');
    // Absolute elapsed minutes, with the official window and the declared
    // ceiling both disclosed rather than normalised away.
    assert.ok(
      html.includes(
        '75.08 elapsed min (official window 75.00 min), declared ceiling 75 min',
      ),
    );
    assert.ok(html.includes('absolute'));
    // The invalid run is named in the ineligibility reasons (correct) but must
    // not be plotted as a comparable point.
    assert.ok(
      !/<circle[^>]*><title>failed-stop/.test(html),
      'the failed-stop point must not be plotted',
    );
    assert.ok(html.includes('failed-stop'), 'but it must be named as ineligible');
    // ...and omitting it must not upgrade the comparison's validity.
    assert.ok(
      html.includes('DESCRIPTIVE / NON-CONTROLLED comparison'),
      'a failed-stop run in the requested set keeps the comparison descriptive',
    );
    assert.ok(html.includes('of 2 requested runs plotted'));
  } finally {
    fs.unlinkSync(path.join(scratch, 'comparison.html'));
    fs.rmdirSync(scratch);
  }
});
test('hybrid quality is not credited solely to local reserved GPUs', () => {
  const d = sample();
  d.captain.location = 'cloud';
  const m = ingest(d, 90, 25);
  assert.equal(m.executionMix, 'HYBRID');
  assert.equal(m.localGpuHours, 1 / 6);
  assert.equal(m.cloudGpuHours, null);
  assert.equal(m.efficiency.qualityPointsPerGPUHour, null);
  assert.equal(m.efficiency.qualityPointsPerLocalGPUHour, null);
  assert.equal(m.efficiency.completedLocalTasksPerLocalGPUHour, 6);
});
test('cloud reservations have their own hours and GPU identity namespace', () => {
  const d = sample();
  d.captain.location = 'cloud';
  d.gpuReservations.push({ ...d.gpuReservations[0], location: 'cloud' });
  const m = ingest(d, 90, 25);
  assert.equal(m.localGpuHours, 1 / 6);
  assert.equal(m.cloudGpuHours, 1 / 6);
  assert.equal(m.efficiency.qualityPointsPerGPUHour, null);
  delete d.gpuReservations[0].location;
  assert.throws(() => ingest(d), /location required/);
});
test('modern suppression directives and every any type position are detected', () => {
  assert.equal(
    analyzeSource('// Discuss @ts-ignore in documentation\nconst x=1;')
      .noSuppression,
    true,
  );
  for (const source of [
    '// @ts-expect-error reviewed\nconst x=1;',
    'let x: Record<string, any>;',
    'let x: any[];',
    'let x: Array<any>;',
    'const x=<any>value;',
  ])
    assert.equal(analyzeSource(source, 'source.ts').noSuppression, false);
  assert.equal(
    analyzeSource('const copy="Record<string, any> and @ts-expect-error";')
      .noSuppression,
    true,
  );
});
test('fresh-token efficiency excludes cache reads and missing cache stays unknown', () => {
  const m = ingest(sample(), 90, 25);
  assert.equal(m.uncachedInputTokens, 1600);
  assert.equal(m.freshTokens, 2100);
  assert.equal(m.efficiency.qualityPointsPerMillionFreshTokens, 90 / 0.0021);
  const d = sample();
  d.captain.tokens.cacheReadTokens = null;
  assert.equal(ingest(d).freshTokens, null);
  const bad = sample();
  bad.captain.tokens.cacheReadTokens = 1001;
  assert.throws(() => ingest(bad), /Cache-read/);
});
test('observed deadline overrun and failed stop remain truthful telemetry', () => {
  const d = sample();
  d.run.status = 'TIME_LIMIT';
  d.run.completedAt = '2026-10-05T21:15:05Z';
  d.run.observationEndedAt = d.run.completedAt;
  d.run.stopResult = 'STOPPED';
  const m = ingest(d);
  assert.equal(m.wallSeconds, 4505);
  assert.equal(m.deadlineOverrunSeconds, 5);
  assert.equal(m.stopConfirmed, true);
  d.run.completedAt = null;
  d.run.stopResult = 'STOP_FAILURE';
  const failed = ingest(d);
  assert.equal(failed.run.completedAt, null);
  assert.equal(failed.stopConfirmed, false);
  assert.equal(failed.validOutcome, false);
  assert.equal(failed.wallSeconds, 4505);
});
test('hygiene ignores examples, comments and SVG URLs but catches actual executable constructs', () => {
  const safe =
    analyzeSource(`// console.log('example'); fetch('https://example.com');
 const documentation="fetch(), console.log(), as any, @ts-ignore";
 const Icon=()=> <svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>;`);
  assert.equal(safe.noDebugLogging, true);
  assert.equal(safe.noNetwork, true);
  assert.equal(safe.noSuppression, true);
  assert.equal(analyzeSource('console.log("debug")').noDebugLogging, false);
  assert.equal(analyzeSource('window.fetch("/api")').noNetwork, false);
  assert.equal(
    analyzeSource('new WebSocket("wss://example.com")').noNetwork,
    false,
  );
  assert.equal(analyzeSource('// @ts-ignore\nconst x=1').noSuppression, false);
  assert.equal(analyzeSource('let x:any').noSuppression, false);
});
test('participant test probes span five independently described domains', () => {
  assert.equal(usefulMutations.length, 5);
  assert.equal(new Set(Object.values(mutationDomains)).size, 5);
  for (const id of usefulMutations)
    assert.ok(mutationSetup(id).includes('afterEach'));
});
