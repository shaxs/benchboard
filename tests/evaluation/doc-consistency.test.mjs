// Static documentation-consistency check for the lifecycle guide's evaluation bullet.
// Doc-only: reads two markdown files with fs and asserts with node:assert. It imports no
// evaluator code, starts nothing, and touches no protected challenge material.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lifecyclePath = path.join(repoRoot, 'docs', 'MANUAL_LIFECYCLE.md');
const evaluationPath = path.join(repoRoot, 'docs', 'EVALUATION.md');

const lifecycle = readFileSync(lifecyclePath, 'utf8');
// The guide wraps prose across lines; collapse all runs of whitespace so assertions
// match the wording regardless of where the line breaks fall.
const flat = lifecycle.replace(/\s+/g, ' ');

test('stale no-evaluation bullet is gone from the lifecycle guide', () => {
  assert.ok(
    !flat.includes('There is no evaluation or scoring in this release'),
    'the stale "no evaluation or scoring in this release" blanket statement must be removed',
  );
  assert.ok(
    !flat.includes('planned as C4'),
    'the stale "planned as C4" evaluation promise must be removed',
  );
});

test('the evaluation bullet cross-links to an existing EVALUATION.md', () => {
  assert.ok(
    flat.includes('[Evaluation API](EVALUATION.md)'),
    'the changed bullet must carry a relative [Evaluation API](EVALUATION.md) link',
  );
  // The link is relative to docs/, so the target sits next to MANUAL_LIFECYCLE.md.
  const linked = readFileSync(path.join(repoRoot, 'docs', 'EVALUATION.md'), 'utf8');
  assert.ok(linked.length > 0, 'docs/EVALUATION.md exists and is readable');
});

test('lifecycle operations still produce no score', () => {
  assert.ok(
    flat.includes('Lifecycle operations do not score a submission'),
    'the corrected bullet must state that lifecycle operations do not score a submission',
  );
  assert.ok(
    flat.includes('it is not a score, a rank, or a quality verdict'),
    'a frozen submission must still be described as not a score, rank or quality verdict',
  );
});

test('evaluation runs stages separately and returns no score at S1', () => {
  assert.ok(
    flat.includes('runs established stages on verified frozen submissions and returns stage evidence'),
    'the bullet must state that the separate Evaluation API runs established stages on verified frozen submissions and returns stage evidence',
  );
  assert.ok(
    flat.includes('At S1 it still returns no score'),
    'the bullet must state that at S1 evaluation still returns no score',
  );
});
