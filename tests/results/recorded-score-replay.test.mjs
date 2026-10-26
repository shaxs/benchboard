// C5.S8.T1 — read-only recorded scorer replay (pure scorer over recorded evidence, read-only DATA).
//
// One test loops the three recorded variants (starter 20.6753, reference 80, broken 8.4118), reads
// each artifacts/<variant>-report/report.json by URL, digests its bytes before and after, parses it,
// takes a pre-call structuredClone of the evidence purely as an immutability witness, and replays the
// record's OWN evidence object — not that clone — through the UNCHANGED pure scorer imported from
// ../../evaluator/score.mjs with ui = null (the scorer explicitly tolerates the legacy broken
// record's usefulTests: null; no neutral bundle or default is ever synthesized for a missing fact).
// The recomputed total, every area and every other numeric/null/max field must equal the record's
// own quality fields, and the spine literals 20.6753 / 80 / 8.4118 are asserted independently.
//
// Status labels are preserved, not coerced: the actual scorer recomputes HUMAN_REVIEW_PENDING for
// all three variants, while the recorded reference label REFERENCE_NOT_A_BENCHMARK_PARTICIPANT is
// legacy reference data asserted as recorded and never compared as equal to the recomputed one
// (starter and broken records carry HUMAN_REVIEW_PENDING as recorded). Legacy unknowns stay null.
//
// This is a scorer evidence replay only — NOT authenticated or current-bundle coverage, and no
// producer, provenance, browser or parity claim; the existing C4 differential remains the
// production category-parity witness. Nothing under artifacts/ is written: the sha256 of every
// source record is taken before the replay and again after it. A mismatch is a hard stop: this
// suite never rebaselines, never relaxes a comparison and never repeats to hide a difference. No
// process, browser, server, install or evaluation is started, and no raw evidence is printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { score } from '../../evaluator/score.mjs';
import { ownerEvidenceOption } from '../owner-evidence.mjs';

// ---- read-only access to the recorded reports ----------------------------------------------------
const reportURL = (variant) =>
  new URL('../../artifacts/' + variant + '-report/report.json', import.meta.url);
const readBytes = (variant) => fs.readFileSync(reportURL(variant));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// The spine: variant, the recorded automated total, the recorded status label (legacy data), and
// the recorded pass counts. Nothing here is derived from the scorer; nothing here edits the record.
const VARIANTS = Object.freeze([
  Object.freeze({
    name: 'starter',
    expectedAutomated: 20.6753,
    recordedStatus: 'HUMAN_REVIEW_PENDING',
    visiblePassed: 10,
    hiddenPassed: 3,
  }),
  Object.freeze({
    name: 'reference',
    expectedAutomated: 80,
    recordedStatus: 'REFERENCE_NOT_A_BENCHMARK_PARTICIPANT',
    visiblePassed: 17,
    hiddenPassed: 25,
  }),
  Object.freeze({
    name: 'broken',
    expectedAutomated: 8.4118,
    recordedStatus: 'HUMAN_REVIEW_PENDING',
    visiblePassed: 1,
    hiddenPassed: 0,
  }),
]);

const HIDDEN_PROPERTIES = 25;
const AUTOMATED_MAXIMUM = 80;
const HUMAN_MAXIMUM = 20;
const QUALITY_MAXIMUM = 100;
const AREAS = Object.freeze([
  'visible',
  'functional',
  'persistence',
  'edge',
  'integration',
  'code',
  'usefulTests',
  'hygiene',
]);
// The actual scorer's status for every ui = null replay, for every variant, regardless of the
// recorded label. It means only "automated score pending the human UI pass"; it carries no
// eligibility or authority claim and never rewrites the recorded label.
const RECOMPUTED_STATUS = 'HUMAN_REVIEW_PENDING';

// The record's quality object minus its legacy status label; compared as one deep-equal unit so the
// intentionally different status labels are never compared as equal.
const qualityFieldsExcludingStatus = (quality) =>
  Object.fromEntries(
    Object.entries(quality).filter(([key]) => key !== 'status'),
  );

test('recorded starter, reference and broken reports replay through the unchanged pure scorer to their recorded totals, areas and preserved status labels', ownerEvidenceOption('artifacts/starter-report/report.json', 'artifacts/reference-report/report.json', 'artifacts/broken-report/report.json'), () => {
  for (const variant of VARIANTS) {
    const {
      name,
      expectedAutomated,
      recordedStatus,
      visiblePassed,
      hiddenPassed,
    } = variant;

    // Bytes digest BEFORE the read, so a later re-read can prove nothing was written.
    const bytesBefore = readBytes(name);
    const digestBefore = sha256(bytesBefore);

    const record = JSON.parse(bytesBefore.toString('utf8'));
    // The ONLY input handed to score() below is the record's own evidence object — nothing
    // synthesized. This structuredClone is taken before the call and is NOT what is passed to the
    // scorer; it serves only as the before-witness, compared with record.evidence after the call to
    // show the replay left the record's own evidence untouched. (The broken record's usefulTests is
    // genuinely null — never replaced by a synthesized default; the pure scorer tolerates it as
    // recorded.)
    const evidenceClone = structuredClone(record.evidence);

    const result = score(record.evidence, null);

    // Fixed spine expectations, asserted independently of the record's own numbers.
    assert.equal(result.automated, expectedAutomated, `${name} automated total mismatch`);
    assert.equal(result.automatedMaximum, AUTOMATED_MAXIMUM);
    assert.equal(result.humanMaximum, HUMAN_MAXIMUM);
    assert.equal(result.qualityMaximum, QUALITY_MAXIMUM);
    assert.equal(result.humanUI, null, 'no human UI pass exists in the recorded evidence');
    assert.equal(result.quality, null, 'quality stays null while the human UI pass is absent');

    // Every area equals the record's recorded area, exactly (full precision, no re-rounding).
    assert.equal(
      Object.keys(result.areas).length,
      AREAS.length,
      `${name} area set size mismatch`,
    );
    for (const area of AREAS) {
      assert.equal(
        result.areas[area],
        record.quality.areas[area],
        `recorded ${name} ${area} area mismatch`,
      );
    }
    assert.deepEqual(
      result.areas,
      record.quality.areas,
      `recorded ${name} area set mismatch`,
    );

    // Every other numeric/null/max field equals the matching recorded quality field, as one unit
    // with the status label excluded (compared separately below, never coerced).
    assert.deepEqual(
      qualityFieldsExcludingStatus(result),
      qualityFieldsExcludingStatus(record.quality),
      `recorded ${name} quality fields mismatch`,
    );

    // Status labels are PRESERVED, not coerced. The actual scorer status is HUMAN_REVIEW_PENDING
    // for all three variants; the recorded reference label is the legacy reference marker and the
    // recorded starter/broken labels are HUMAN_REVIEW_PENDING. The two kinds of label are
    // intentionally different and are never compared to each other.
    assert.equal(
      record.quality.status,
      recordedStatus,
      `recorded ${name} status label must be preserved exactly as recorded`,
    );
    assert.equal(
      result.status,
      RECOMPUTED_STATUS,
      `recomputed ${name} status means only: automated score pending the human UI pass`,
    );
    if (name === 'reference') {
      // The deliberate divergence, asserted explicitly rather than hidden by an equality check:
      // the legacy reference marker stays distinct from the scorer's pending status.
      assert.notEqual(
        record.quality.status,
        result.status,
        'the recorded reference marker and the actual scorer pending status must stay distinct',
      );
    }

    // Legacy unknowns stay null — never a coerced zero that would read like a measured result.
    assert.equal(record.quality.humanUI, null);
    assert.equal(record.quality.quality, null);

    // Recorded pass counts as replayed evidence facts: 25 hidden properties per variant, and the
    // visible/hidden pass counts the recorded totals were computed from.
    assert.equal(
      record.evidence.hidden.length,
      HIDDEN_PROPERTIES,
      `${name} report must carry ${HIDDEN_PROPERTIES} hidden properties`,
    );
    assert.equal(
      record.evidence.visiblePassed,
      visiblePassed,
      `${name} recorded visible pass count mismatch`,
    );
    assert.equal(
      record.evidence.hidden.filter((t) => t.passed === true).length,
      hiddenPassed,
      `${name} recorded hidden pass count mismatch`,
    );

    // The scorer left its input untouched: the replayed evidence is deep-equal to the clone taken
    // before the call, and the source record bytes are byte-for-byte unchanged after the replay.
    assert.deepEqual(
      record.evidence,
      evidenceClone,
      `${name} evidence was altered by the replay`,
    );
    assert.equal(
      sha256(readBytes(name)),
      digestBefore,
      `${name} source record bytes changed while the replay was reading them`,
    );
  }
});
