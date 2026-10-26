// Documentation check for docs/REPORTING.md. Static only: reads the guide and
// asserts it names the two public APIs, the Report-vs-Result separation, the
// bundle.score provenance and top-level null, the honest null/pending statuses,
// the manual-enforcement limits and the local-not-export warning. It reads docs
// only: no report, evaluation, browser or server is launched and nothing is
// written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../..', import.meta.url);
const read = relative => fs.readFileSync(new URL(relative, root), 'utf8');
// The guide wraps prose across lines; collapse whitespace so assertions match
// the wording regardless of where the line breaks fall.
const doc = read('docs/REPORTING.md').replace(/\s+/g, ' ');

test('the guide names both public APIs with their shapes', () => {
  assert.match(doc, /`createReport\(request\)`/);
  assert.match(doc, /`readReport\(text\)`/);
  assert.match(doc, /await createReport\(\{ reportId, createdAt, selection, evaluation \}\);/);
  assert.match(doc, /readReport\(jsonText\);/);
  // The selection is the C4 FrozenSelection with its six explicit fields.
  for (const field of ['runRoot', 'runId', 'manifestId', 'snapshotId', 'frozenSubmissionId', 'expectedDigest']) {
    assert.match(doc, new RegExp('`' + field + '`'), 'documented selection field ' + field);
  }
  // The caller awaits evaluateFrozen first; refusals stay thrown.
  assert.match(doc, /first awaits `evaluateFrozen` separately/);
  assert.match(doc, /is \*\*not caught and made into a\s*report\*\*/);
  // Creation/read publish nothing.
  assert.match(doc, /Creation and read do\s*not publish anything/);
});

test('the guide separates the additive Report from the unchanged C1 Result', () => {
  assert.match(doc, /The C1 `Result` and\s*the S1 evaluation result envelope are untouched/);
  assert.match(doc, /`kind: 'Report'`/);
  // The schema fixes both kinds; the guide must not contradict it.
  const schema = JSON.parse(read('schemas/report.schema.json'));
  assert.equal(schema.properties.kind.const, 'Report');
});

test('the guide puts success quality in bundle.score and the top-level score at null', () => {
  assert.match(doc, /The success quality comes from `evaluation\.bundle\.score`/);
  assert.match(doc, /never\*\* the top-level score|top-level score is\s*`null` in both shapes/);
  assert.match(doc, /top-level score is\s*`null` in both shapes/);
});

test('the guide states the null and pending statuses honestly, with no invented values', () => {
  // Pending human dimensions.
  assert.match(doc, /`humanUI: null`/);
  assert.match(doc, /`quality: null`/);
  assert.match(doc, /`humanReview: 'NOT_REVIEWED'`/);
  // Agent completion is never inferred from a successful evaluation.
  assert.match(doc, /`agentOutcome` is\s*`null`/);
  // The returned infrastructure failure keeps nulls, not zeros.
  assert.match(doc, /`evaluatorExecution: 'INFRASTRUCTURE_ERROR'`,\s*`quality: null`,\s*`actualEvaluator: null`,\s*`evidence\.bundle: null`/);
  assert.match(doc, /No partial points, no partial evidence, no\s*zero/);
  // The raw failure diagnostic is not a report field.
  assert.match(doc, /is \*\*not\*\* a report field/);
  // Integrity and safety refusals stay thrown.
  assert.match(doc, /they stay thrown and never become a\s*report/);
  // Distinct axes, including the local trust level.
  for (const axis of ['agentOutcome', 'evaluatorExecution', 'humanReview', 'assessmentTrust']) {
    assert.match(doc, new RegExp('`' + axis + '`'), 'documented execution axis ' + axis);
  }
  assert.match(doc, /`LOCAL_SELF_ASSESSMENT`/);
});

test('the guide states the manual limits and the binding-vs-actual digest distinction', () => {
  assert.match(doc, /`enforcement` is the constant `'manual'` with `enforced: false`/);
  assert.match(doc, /`executionMode` is the constant `'MANUAL'`/);
  // The binding identity digest and the actual evaluator digests are different domains,
  // and each field is checked against its own bound source, not a categorical equality ban.
  assert.match(doc, /`bindings\.evaluatorIdentityDigest` is the neutral evaluator \*\*binding\*\*\s*identity/);
  assert.match(doc, /`actualEvaluator` is the\s*projected identity of the evaluator that actually ran/);
  assert.match(doc, /different hash domains by\s*design/);
  assert.match(doc, /each field is checked against its own bound source/);
  assert.match(doc, /`actualEvaluator\.semanticDigest` must equal the bundle's evaluator\s*`semanticDigest`/);
  assert.match(doc, /`bindings\.evaluatorIdentityDigest` must equal the sealed binding digest/);
  assert.match(doc, /A substituted value is refused when it\s*differs from its own bound source/);
  // Read validates intrinsic bindings/digests, not certification or authentication.
  assert.match(doc, /That is \*\*intrinsic\*\* validation/);
  assert.match(doc, /not certification and not independent\s*authentication/);
  // No supported-OS, DSH or release/certification claim anywhere in the guide.
  assert.doesNotMatch(doc, /\bDSH\b/, 'the guide must not claim DSH support');
  assert.doesNotMatch(doc, /Windows|macOS|Linux|supported OS/i, 'the guide makes no supported-OS claim');
  assert.doesNotMatch(doc, /hidden test(s)? (?:are )?(?:released|shipped)/i, 'no hidden-test release claim');
});

test('the guide names the error classes per entry point and per owning layer', () => {
  // The report layer's own checks (schema shape, timestamp, self-digest, cross-binding,
  // report score, evidence references) and the readReport JSON wrap use the named class.
  assert.match(doc, /`ReportIntegrityError` \(code `REPORT_INTEGRITY`\)/);
  assert.match(doc, /This report layer's own checks/);
  assert.match(doc, /`readReport` wraps\s*malformed JSON or non-string input in that same class/);
  assert.match(doc, /a JSON parse failure is a\s*`REPORT_INTEGRITY`/);
  // A semantically invalid bundle propagates the bundle layer's class even for an otherwise valid report.
  assert.match(doc, /`EvaluationIntegrityError` \(code `EVIDENCE_INTEGRITY`\)/);
  assert.match(doc, /propagated from the bundle validation/);
  assert.match(doc, /a digest- or evidence-invalid report is not\s*categorically a `REPORT_INTEGRITY`/);
  // createReport additionally propagates the C3 and staging classes.
  assert.match(doc, /the C3 `LifecycleError`/);
  assert.match(doc, /`NOT_FOUND` for\s*no saved publication/);
  assert.match(doc, /`PROVENANCE_MISMATCH` for a wrong manifest digest/);
  assert.match(doc, /the staging `EvaluationRefusalError` code `UNSAFE_PATH`/);
  // No claim that every refusal, or every verification failure, is that class.
  assert.doesNotMatch(doc, /(?:that |the )?every (?:refusal|failure)[^.]{0,40}ReportIntegrityError/, 'the guide must not claim every refusal is a ReportIntegrityError');
  assert.doesNotMatch(doc, /refuses \(throwing `ReportIntegrityError`\)/, 'the guide must not attribute every refusal to that class');
  // The invariant that must survive: a refusal yields no report.
  assert.match(doc, /a refused request yields no report/);
  assert.match(doc, /`MeasurementIntegrityError` \(code `MEASUREMENT_INTEGRITY`\)/);
  assert.match(doc, /raw filesystem errors such as `ENOENT`/);
});

test('the guide documents measured sources and the optional bounded input without promoting missing values', () => {
  assert.match(doc, /optional `metrics` request field/);
  assert.match(doc, /thirteen C1 `measurements`/);
  assert.match(doc, /unavailable rows with literal null values/);
  assert.match(doc, /genuine measured zero/);
  assert.match(doc, /`provenance\.sources`/);
  assert.match(doc, /Older S1 reports with both arrays empty remain readable/);
  assert.match(doc, /operator-attested, not enforced/);
});

test('the guide carries the raw-local warning and distinguishes metadata, publication and safe projection', () => {
  assert.match(doc, /\*\*not\*\* a\s*privacy-safe export/);
  assert.match(doc, /Do not publish raw local reports/);
  assert.match(doc, /Human UI worksheet API/);
  assert.match(doc, /without modifying a Report or opening evidence files/);
  assert.match(doc, /Publication API/);
  assert.match(doc, /Safe export API/);
  assert.match(doc, /Comparison API/);
  // No invented command line or CLI claim.
  assert.doesNotMatch(doc, /^\s*benchboard\s+\w+/gm, 'no CLI command may be documented');
});

test('the guide is public-safe: only relative repo paths appear', () => {
  const absolute = [...doc.matchAll(/['"`(]((?:[A-Za-z]:\\|\/)[A-Za-z0-9_ .\\/-]{4,})/g)].map(m => m[1])
    .filter(candidate => !candidate.startsWith('http'));
  assert.deepEqual(absolute, [], 'only relative repo paths appear in the guide');
  assert.doesNotMatch(doc, /C:\\\\|\/home\/|\/Users\//, 'no personal or host paths');
});
