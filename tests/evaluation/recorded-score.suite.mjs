// C4.S3.T2 — independent recorded scorer replay (read-only witness over recorded evidence).
//
// This suite replays the immutable recorded results through the UNCHANGED pure scorer
// (evaluator/score.mjs, imported, never edited or copied) with ui = null, and proves arithmetic and
// witness consistency only. It is NOT the new-facade parity proof: the real end-to-end paths run
// separately (T1), and nothing here assembles or consults an EvidenceBundle. In particular no
// "neutral" bundle is synthesized from the incomplete legacy broken evidence — the broken record's
// evidence.usefulTests is genuinely null, so the only honest replay is the direct pure one.
//
// Everything read from artifacts/ is read-only DATA. No artifact is ever written: a byte digest of
// every record is taken before the reads and again after them, and the two snapshots must be
// identical. Legacy unknowns stay null (metrics, usefulTests, humanUI, quality) and are never coerced
// to 0. The recorded reference status label is legacy data; the recomputed HUMAN_REVIEW_PENDING status
// is only "automated score pending the human UI pass" and asserts no eligibility or authority claim.
// A mismatch is a hard stop: this suite never rebaselines, never relaxes a comparison and never
// repeats to hide a difference. No server, browser, tool or child process is started, and no
// dependency is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { score } from '../../evaluator/score.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// ---- read-only access to the recorded evidence ------------------------------------------------
const RECORDS = Object.freeze([
  'artifacts/starter-report/report.json',
  'artifacts/reference-report/report.json',
  'artifacts/broken-report/report.json',
  'artifacts/starter-visible.json',
  'artifacts/reference-visible.json',
  'artifacts/broken-visible.json',
  'artifacts/starter-browser/hidden.json',
  'artifacts/reference-browser/hidden.json',
  'artifacts/broken-browser/hidden.json',
  'artifacts/reference-repeat/hidden.json',
]);

function readBytes(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel));
}
function readJSON(rel) {
  return JSON.parse(readBytes(rel).toString('utf8'));
}
function digest(rel) {
  return crypto.createHash('sha256').update(readBytes(rel)).digest('hex');
}
function snapshot() {
  return RECORDS.map(rel => rel + '=' + digest(rel)).join('\n');
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
// The scorer's own input, taken as a deep-frozen clone so any in-place mutation attempt by score()
// throws instead of quietly altering the replay.
function frozenCopy(value) {
  return deepFreeze(structuredClone(value));
}

// ---- independent arithmetic witness (literals, not imported from the scorer) -------------------
const AREA_CAPS = Object.freeze({
  visible: 7,
  functional: 30,
  persistence: 10,
  edge: 5,
  integration: 15,
  code: 5,
  usefulTests: 5,
  hygiene: 3,
});
const AREA_EXPECTED_COUNTS = Object.freeze({
  functional: 13,
  persistence: 4,
  edge: 4,
  integration: 4,
});
const VISIBLE_TOTAL = 17;
const AUTOMATED_MAXIMUM = 80;
const HUMAN_MAXIMUM = 20;
const QUALITY_MAXIMUM = 100;
const VALID_MUTATIONS = Object.freeze([
  'storage-drop',
  'input-drop',
  'focus-drop',
  'label-case',
  'date-order',
]);

function fraction(passed, total) {
  return total > 0 ? Math.min(1, Math.max(0, passed / total)) : 0;
}

// Recomputed from the recorded evidence with this suite's own literals and formula, so a drift in
// either the scorer or a record shows as a mismatch rather than cancelling out.
function independentAreas(evidence) {
  const areas = {
    visible: AREA_CAPS.visible * fraction(evidence.visiblePassed, VISIBLE_TOTAL),
  };
  for (const [area, count] of Object.entries(AREA_EXPECTED_COUNTS)) {
    const tests = evidence.hidden.filter(t => t.area === area);
    assert.equal(
      tests.length,
      count,
      'recorded ' + area + ' evidence must hold exactly ' + count + ' properties',
    );
    areas[area] = AREA_CAPS[area] * fraction(tests.filter(t => t.passed === true).length, count);
  }
  areas.code =
    (evidence.typecheck === true ? 2 : 0) +
    (evidence.build === true ? 2 : 0) +
    (evidence.noSuppression === true ? 1 : 0);
  const useful = evidence.usefulTests;
  const killed = useful === null || useful === undefined ? [] : [...new Set(useful.killedMutations ?? [])];
  for (const m of killed) assert.ok(VALID_MUTATIONS.includes(m), 'unknown useful-test mutation ' + m);
  areas.usefulTests =
    useful?.baselinePassed === true && (useful?.addedCount ?? 0) > 0
      ? Math.min(AREA_CAPS.usefulTests, killed.length)
      : 0;
  areas.hygiene = ['visibleIntact', 'lockedDependencies', 'noSecrets', 'noDebugLogging', 'noNetwork'].reduce(
    (n, k) => n + (evidence.hygiene[k] === true ? AREA_CAPS.hygiene / 5 : 0),
    0,
  );
  for (const [area, cap] of Object.entries(AREA_CAPS)) {
    assert.ok(
      Number.isFinite(areas[area]) && areas[area] >= 0 && areas[area] <= cap,
      'invalid ' + area + ' area',
    );
  }
  return areas;
}
function automatedOf(areas) {
  return Number(
    Object.values(areas)
      .reduce((a, b) => a + b, 0)
      .toFixed(4),
  );
}

// ---- variants under replay --------------------------------------------------------------------
const VARIANTS = Object.freeze([
  // The fixed expectations named by the spine: starter 20.6753, reference maximum 80, broken 8.4118.
  {
    name: 'starter',
    expectedAutomated: 20.6753,
    legacyStatus: 'HUMAN_REVIEW_PENDING',
  },
  {
    name: 'reference',
    expectedAutomated: 80,
    legacyStatus: 'REFERENCE_NOT_A_BENCHMARK_PARTICIPANT',
  },
  {
    name: 'broken',
    expectedAutomated: 8.4118,
    legacyStatus: 'HUMAN_REVIEW_PENDING',
  },
]);
const reportOf = name => readJSON('artifacts/' + name + '-report/report.json');
const visibleOf = name => readJSON('artifacts/' + name + '-visible.json');
const hiddenOf = name => readJSON('artifacts/' + name + '-browser/hidden.json');

function byId(records, label) {
  const map = new Map();
  for (const t of records) {
    assert.equal(map.has(t.id), false, label + ' has a duplicate property id ' + t.id);
    map.set(t.id, t);
  }
  return map;
}

// The byte snapshot is taken BEFORE any record is read, and compared again in the final test.
const bytesBefore = snapshot();

/* ---------- pure replay through the unchanged scorer ---------- */

for (const { name, expectedAutomated, legacyStatus } of VARIANTS) {
  test(`recorded ${name} evidence replays through score(evidence, null) to the recorded areas and total`, () => {
    const record = reportOf(name);
    const evidence = frozenCopy(record.evidence);
    const result = score(evidence, null);

    // Fixed spine expectations, asserted independently of the record's own numbers.
    assert.equal(result.automated, expectedAutomated);
    assert.equal(result.automatedMaximum, AUTOMATED_MAXIMUM);
    assert.equal(result.humanMaximum, HUMAN_MAXIMUM);
    assert.equal(result.qualityMaximum, QUALITY_MAXIMUM);
    assert.equal(result.humanUI, null, 'no human UI pass exists in the recorded evidence');
    assert.equal(result.quality, null, 'quality stays null while the human UI pass is absent');

    // Every area, the total and the maxima equal the corresponding record, exactly.
    for (const area of Object.keys(AREA_CAPS)) {
      assert.equal(result.areas[area], record.quality.areas[area], `recorded ${name} ${area} area mismatch`);
    }
    assert.deepEqual(result.areas, record.quality.areas, `recorded ${name} area set mismatch`);
    assert.equal(result.automated, record.quality.automated, `recorded ${name} automated mismatch`);
    assert.equal(record.quality.automatedMaximum, AUTOMATED_MAXIMUM);
    assert.equal(record.quality.humanMaximum, HUMAN_MAXIMUM);
    assert.equal(record.quality.qualityMaximum, QUALITY_MAXIMUM);

    // Third witness: this suite's own arithmetic over the same evidence, using literals.
    const independent = independentAreas(record.evidence);
    for (const area of Object.keys(AREA_CAPS)) {
      assert.equal(independent[area], result.areas[area], `independent ${name} ${area} arithmetic mismatch`);
    }
    assert.equal(automatedOf(independent), result.automated, `independent ${name} total mismatch`);

    // Legacy unknowns stay null — never coerced to a zero that would read like a measured result.
    assert.equal(record.metrics, null, 'recorded metrics must stay null');
    assert.equal(record.quality.humanUI, null);
    assert.equal(record.quality.quality, null);

    // The recorded status label is legacy data; the recomputed status means only "the automated
    // score is pending the human UI pass" and carries no eligibility or authority claim.
    assert.equal(record.quality.status, legacyStatus, 'legacy status label must be preserved as recorded');
    assert.equal(result.status, 'HUMAN_REVIEW_PENDING');
    // Where the legacy label differs from the recomputed one (only the reference record), the
    // difference is the legacy label itself. The recomputed status reads as "automated score pending
    // the human UI pass", never as an eligibility or authority claim, and it never rewrites the
    // recorded label.
    if (legacyStatus !== 'HUMAN_REVIEW_PENDING') {
      assert.equal(name, 'reference', 'only the reference record carries a non-pending legacy label');
      assert.equal(
        result.automated,
        AUTOMATED_MAXIMUM,
        'the legacy label must not change the replayed score',
      );
    }
    for (const key of Object.keys(result))
      assert.equal(/^OFFICIAL|SUPERVISED|ELIGIB|AUTHORIT/i.test(key), false);
    for (const value of Object.values(result)) {
      assert.equal(typeof value === 'string' && /OFFICIAL_SUPERVISED/.test(value), false);
    }
  });
}

/* ---------- the frozen replay cannot be mutated by the scorer ---------- */

test('score() leaves the replayed evidence untouched (deep-frozen input, byte-for-byte unchanged)', () => {
  for (const { name } of VARIANTS) {
    const original = JSON.stringify(reportOf(name).evidence);
    const evidence = frozenCopy(reportOf(name).evidence);
    score(evidence, null);
    assert.equal(JSON.stringify(evidence), original, `${name} evidence was altered by the replay`);
  }
});

/* ---------- cross-validate every visible count against its separate record ---------- */

test('every recorded visiblePassed equals the separate <variant>-visible.json pass count of 17', () => {
  for (const { name } of VARIANTS) {
    const report = reportOf(name);
    const visible = visibleOf(name);
    assert.equal(visible.numTotalTests, VISIBLE_TOTAL, `${name} visible record must hold 17 tests`);
    assert.equal(report.evidence.visiblePassed, visible.numPassedTests, `${name} visiblePassed mismatch`);
    // The per-test verdicts in the JSON reporter output must agree with the headline count. The
    // reporter nests each test under a file-level entry's assertionResults list.
    const flat = visible.testResults.flatMap(suite => suite.assertionResults ?? [suite]);
    const passed = flat.filter(t => t.status === 'pass' || t.status === 'passed').length;
    assert.equal(flat.length, VISIBLE_TOTAL, `${name} visible reporter must list 17 tests`);
    assert.equal(passed, report.evidence.visiblePassed, `${name} per-test pass count mismatch`);
    assert.equal(
      visible.numPassedTests + visible.numFailedTests + (visible.numPendingTests ?? 0),
      VISIBLE_TOTAL,
    );
  }
});

/* ---------- cross-validate all 25 property records against the separate hidden files ---------- */

test('every recorded property id/area/pass matches the separate <variant>-browser/hidden.json record', () => {
  for (const { name } of VARIANTS) {
    const reportHidden = reportOf(name).evidence.hidden;
    const file = hiddenOf(name);
    assert.equal(reportHidden.length, 25, `${name} report must carry 25 properties`);
    assert.equal(file.length, 25, `${name} hidden file must carry 25 properties`);

    const inFile = byId(file, name + ' hidden file');
    const inReport = byId(reportHidden, name + ' report');
    assert.deepEqual(
      [...inReport.keys()].sort(),
      [...inFile.keys()].sort(),
      `${name} property id set mismatch`,
    );

    for (const [id, record] of inFile) {
      const mirrored = inReport.get(id);
      assert.equal(mirrored.area, record.area, `${name} ${id} area mismatch`);
      assert.equal(mirrored.passed, record.passed, `${name} ${id} pass mismatch`);
      assert.equal(mirrored.name, record.name, `${name} ${id} name mismatch`);
    }

    // Area membership follows the id prefix, and each area holds its fixed count.
    for (const [id, record] of inFile) {
      const expectedArea = {
        F: 'functional',
        P: 'persistence',
        E: 'edge',
        I: 'integration',
      }[id[0]];
      assert.match(id, /^([FPEI])\d{2}$/, `${name} malformed property id`);
      assert.equal(record.area, expectedArea, `${name} ${id} area/prefix disagreement`);
    }
    for (const [area, count] of Object.entries(AREA_EXPECTED_COUNTS)) {
      assert.equal(file.filter(t => t.area === area).length, count, `${name} ${area} count mismatch`);
    }
  }
});

/* ---------- the reference repeat is the same evidence the first reference run recorded ---------- */

test('reference-repeat hidden evidence equals the reference hidden evidence property for property', () => {
  const first = byId(hiddenOf('reference'), 'reference');
  const repeat = byId(readJSON('artifacts/reference-repeat/hidden.json'), 'reference-repeat');
  assert.equal(repeat.size, 25);
  assert.deepEqual(
    [...repeat.keys()].sort(),
    [...first.keys()].sort(),
    'reference repeat property id set mismatch',
  );
  for (const [id, record] of first) {
    const again = repeat.get(id);
    assert.equal(again.area, record.area, `reference repeat ${id} area mismatch`);
    assert.equal(again.passed, record.passed, `reference repeat ${id} pass mismatch`);
  }
  // Replays the reference report's own evidence through the unchanged scorer again (the recorded
  // repeat report has no score record here); the real repeat comparison above is the keyed hidden
  // records, and the real facade semantic repeat is separate parity coverage.
  const repeatScore = score(frozenCopy(reportOf('reference').evidence), null);
  assert.equal(repeatScore.automated, reportOf('reference').quality.automated);
  assert.deepEqual(repeatScore.areas, reportOf('reference').quality.areas);
});

/* ---------- incomplete legacy evidence is replayed directly, never bundled away ---------- */

test('the broken record keeps useful-tests evidence null and is replayed directly, not via a synthesized bundle', () => {
  const record = reportOf('broken');
  // The legacy broken record genuinely has no useful-test evidence: null, not a zeroed stand-in.
  assert.equal(record.evidence.usefulTests, null, 'broken usefulTests must stay the recorded null');
  assert.equal(record.evidence.hygiene.visibleIntact, true);

  // Direct pure replay only: what is handed to score() is the record's own evidence object, so no
  // neutral bundle shape (schemaVersion / identities / artifactDigests) can be assembled from it.
  const projected = frozenCopy(record.evidence);
  for (const bundleKey of ['schemaVersion', 'identities', 'evaluationId', 'artifactDigests']) {
    assert.equal(Object.hasOwn(projected, bundleKey), false, `no bundle field ${bundleKey} may be invented`);
  }
  const result = score(projected, null);
  assert.equal(
    result.areas.usefulTests,
    0,
    'absent useful-test evidence scores 0 points, not a measured run',
  );
  assert.equal(result.humanUI, null);
  assert.equal(result.quality, null);
});

/* ---------- no artifact writes ---------- */

test('the replay wrote nothing into the recorded evidence (byte digests identical before and after)', () => {
  assert.equal(snapshot(), bytesBefore, 'a protected record changed while the replay was reading it');
});
