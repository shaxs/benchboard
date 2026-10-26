// C4.S4.T2 — bounded output and mutation domain acceptance (mutation-domain half).
//
// Independent tamper-resistance tests for the five fixed useful-test mutations. The five names and
// the five-domain mapping are re-declared here as INDEPENDENT literals so a drift in the unchanged
// immutable `evaluator/useful-tests.mjs` shows as a mismatch instead of cancelling out. The
// mutationSetup strings are treated strictly as inert text and are never evaluated here; the suite
// even proves by a static scan of its own source that it contains no code-execution route.
//
// Scoring evidence comes from two honest sources only: (a) locally explicit complete 25-property
// records built in this file, and (b) the read-only recorded full-reference useful evidence in
// `artifacts/reference-useful/summary.json` — the accepted S3 full-reference witness of the real
// 8 added tests killing all 5 mutations. Nothing here fabricates a production useful run, and
// artifacts/ is read strictly read-only (byte digest before and after). The unchanged scorer
// (`evaluator/score.mjs`) and the neutral contract validator
// (`packages/evaluation/bundle-contract.mjs`) are imported, never edited. No malformed legacy
// bundle is assembled anywhere in this suite. No browser, server, tool launch, child process or
// repository mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { score } from '../../evaluator/score.mjs';
import { usefulMutations, mutationDomains, mutationSetup } from '../../evaluator/useful-tests.mjs';
import { validateScorerEvidence, EvaluationIntegrityError } from '../../packages/evaluation/bundle-contract.mjs';
import { ownerEvidenceOption } from '../owner-evidence.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/* ---------- independent literals (drift detectors, not imports) ---------- */

const NAMES = Object.freeze(['storage-drop', 'input-drop', 'focus-drop', 'label-case', 'date-order']);
const DOMAINS = Object.freeze({
  'storage-drop': 'persistence',
  'input-drop': 'interaction',
  'focus-drop': 'accessibility',
  'label-case': 'normalization',
  'date-order': 'chronology',
});
const VALID_MUTATION_PATTERN = /^(storage-drop|input-drop|focus-drop|label-case|date-order)$/;

/* ---------- locally explicit complete 25-property scorer evidence ---------- */

function properties() {
  const records = [];
  const groups = [['F', 'functional', 13], ['P', 'persistence', 4], ['E', 'edge', 4], ['I', 'integration', 4]];
  for (const [prefix, area, count] of groups) {
    for (let index = 1; index <= count; index++) {
      records.push({ id: prefix + String(index).padStart(2, '0'), area, passed: true });
    }
  }
  return records;
}

function baseEvidence(overrides) {
  const hygiene = { visibleIntact: true, lockedDependencies: true, noSecrets: true, noDebugLogging: true, noNetwork: true };
  const evidence = {
    visiblePassed: 17,
    hidden: properties(),
    typecheck: true,
    build: true,
    usefulTests: { baselinePassed: false, addedCount: 0, killedMutations: [] },
    noSuppression: true,
    hygiene,
    analysisMethod: 'controlled mutation-domain fixture (no production run is fabricated)',
  };
  return { ...evidence, ...overrides };
}

// One flat validation call so every usage site stays single-line readable.
function validate(useful) {
  return validateScorerEvidence(baseEvidence({ usefulTests: useful }));
}

function usefulPoints(useful) {
  return score(validate(useful), null).areas.usefulTests;
}

const integrity = error => error instanceof EvaluationIntegrityError;

/* ---------- 1. names, domain mapping and inert setup text ---------- */

test('the five mutation names and the five-domain mapping match the independent literals exactly', () => {
  assert.deepEqual([...usefulMutations], [...NAMES], 'exactly the five accepted mutation names, in order');
  assert.equal(usefulMutations.length, 5);
  assert.deepEqual({ ...mutationDomains }, { ...DOMAINS }, 'each name maps to its accepted fault domain');
  assert.deepEqual(Object.keys(mutationDomains).sort(), [...NAMES].sort(), 'the mapping covers exactly the five names');
  const domains = [...new Set(Object.values(mutationDomains))].sort();
  assert.deepEqual(domains, [...new Set(Object.values(DOMAINS))].sort(), 'the five domains are the five accepted fault domains');
});

test('mutationSetup returns non-empty inert setup text for every valid name and throws for any unknown name', () => {
  for (const name of NAMES) {
    const text = mutationSetup(name);
    assert.equal(typeof text, 'string', name + ' setup is text');
    assert.ok(text.length > 40, name + ' setup text is non-trivial');
    assert.match(text, /beforeEach/, name + ' setup wires a beforeEach patch');
    assert.match(text, /afterEach/, name + ' setup restores in afterEach');
    assert.ok(VALID_MUTATION_PATTERN.test(name));
  }
  const unknowns = ['sneaky-drop', 'storage-drop ', 'STORAGE-DROP', ''];
  for (const unknown of unknowns) {
    assert.throws(() => mutationSetup(unknown), error => /Unknown mutation/i.test(error.message), 'unknown mutation name ' + JSON.stringify(unknown) + ' must throw');
    assert.ok(!(unknown in mutationDomains));
  }
  // This suite never executes the setup text: no eval, no Function constructor.
  const own = fs.readFileSync(fileURLToPath(new URL(import.meta.url)), 'utf8');
  assert.doesNotMatch(own, /\beval\s*\(|new\s+Function\b/, 'no code-execution route for mutation setup text');
});

/* ---------- 2. recorded full-reference useful evidence (read-only witness) ---------- */

test('the recorded full-reference useful evidence is the real 8-test 5-kill witness and scores 5 useful points, read unchanged', ownerEvidenceOption('artifacts/reference-useful/summary.json'), () => {
  const record = 'artifacts/reference-useful/summary.json';
  const bytes = fs.readFileSync(path.join(REPO_ROOT, record));
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const summary = JSON.parse(bytes.toString('utf8'));
  assert.equal(summary.addedCount, 8, 'S3 recorded reference added 8 tests');
  assert.equal(summary.baselinePassed, true);
  assert.deepEqual([...summary.killedMutations].sort(), [...NAMES].sort(), 'the full reference killed all five accepted mutations');
  assert.ok(summary.killedMutations.every(name => VALID_MUTATION_PATTERN.test(name)), 'no out-of-domain name in the recorded evidence');
  const useful = { baselinePassed: summary.baselinePassed, addedCount: summary.addedCount, killedMutations: summary.killedMutations };
  assert.equal(usefulPoints(useful), 5, 'the recorded five kills earn the full 5-point useful cap');
  // Read-only proof: the artifact bytes are unchanged after every read above.
  const after = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, record))).digest('hex');
  assert.equal(after, digest, 'artifacts/ must stay byte-identical');
});

/* ---------- 3. per-name points through the unchanged scorer ---------- */

test('each single accepted mutation kill earns exactly one useful point and all five earn five', () => {
  for (const name of NAMES) {
    const useful = { baselinePassed: true, addedCount: 1, killedMutations: [name] };
    assert.equal(usefulPoints(useful), 1, name + ' alone earns one point');
  }
  const allFive = { baselinePassed: true, addedCount: 1, killedMutations: [...NAMES] };
  assert.equal(usefulPoints(allFive), 5, 'the five accepted kills reach the 5-point cap');
  // A kill without a passing added-test baseline earns nothing; zero added tests cannot score.
  const failedBaseline = { baselinePassed: false, addedCount: 1, killedMutations: [...NAMES] };
  assert.equal(usefulPoints(failedBaseline), 0, 'a failed baseline must not score kills');
  const noAdded = { baselinePassed: true, addedCount: 0, killedMutations: [...NAMES] };
  assert.equal(usefulPoints(noAdded), 0, 'addedCount 0 must not score kills');
});

/* ---------- 4. unknown names rejected by BOTH the unchanged scorer and the neutral validator ---------- */

test('an out-of-domain mutation name is rejected by the unchanged scorer and by the neutral validator', () => {
  // Neutral contract validator path.
  const useful = { baselinePassed: true, addedCount: 1, killedMutations: ['sneaky-drop'] };
  assert.throws(() => validate(useful), integrity, 'the neutral validator must reject an unknown mutation name');
  // Unchanged scorer path, reached past the validator through a pre-validated record.
  const evaded = validate({ baselinePassed: true, addedCount: 1, killedMutations: [] });
  evaded.usefulTests.killedMutations.push('sneaky-drop');
  assert.throws(() => score(evaded, null), /Unknown useful-test mutation/, 'the unchanged scorer must reject an unknown mutation name');
});

/* ---------- 5. required-field and duplicate rejection through the neutral validator ---------- */

test('missing required useful evidence fields and duplicate killed-mutation entries are rejected by the neutral validator', () => {
  const missing = [
    ['baselinePassed', u => { delete u.baselinePassed; return u; }],
    ['addedCount', u => { delete u.addedCount; return u; }],
    ['killedMutations', u => { delete u.killedMutations; return u; }],
  ];
  for (const [field, mutate] of missing) {
    const useful = mutate({ baselinePassed: true, addedCount: 1, killedMutations: ['storage-drop'] });
    assert.throws(() => validate(useful), integrity, 'missing ' + field + ' must be rejected');
  }
  assert.throws(() => validate({ baselinePassed: true, addedCount: 1, killedMutations: null }), integrity, 'null killedMutations must be rejected');
  assert.throws(() => validate({ baselinePassed: true, addedCount: 1, killedMutations: ['storage-drop', 'storage-drop'] }), integrity, 'a duplicate killed-mutation entry must be rejected');
  assert.throws(() => validate({ baselinePassed: true, addedCount: 1, killedMutations: [7] }), integrity, 'a non-string mutation entry must be rejected');
  assert.throws(() => validate({ baselinePassed: 'yes', addedCount: 1, killedMutations: [] }), integrity, 'a non-boolean baselinePassed must be rejected');
});

/* ---------- 6. valid subsets and the empty list stay valid ---------- */

test('a valid subset or an empty killed list stays valid; all five are never required to score', () => {
  const empty = { baselinePassed: true, addedCount: 2, killedMutations: [] };
  assert.equal(usefulPoints(empty), 0, 'an empty killed list is valid evidence worth zero, not an error');
  const subsets = [['date-order'], ['storage-drop', 'label-case'], ['input-drop', 'focus-drop', 'date-order']];
  for (const subset of subsets) {
    const useful = { baselinePassed: true, addedCount: 2, killedMutations: [...subset] };
    assert.equal(usefulPoints(useful), subset.length, 'a valid subset scores exactly its own kills: ' + subset.join(','));
  }
});
