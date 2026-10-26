// Documentation check for docs/EVIDENCE_BUNDLE.md. Static only: reads the
// closed schema, the Captain trust-boundary source, the evaluator-identity
// declarations and the facade declarations and asserts the documented result
// integration, bundle keys, identity layers, score/null rules and integrity
// behavior line up with them. It never executes an evaluation, starts a browser
// or a server, or writes anywhere. The pure assembler module (bundle.mjs) may
// still be landing in its own lane: it is checked only when it exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../..', import.meta.url);
const read = relative => fs.readFileSync(new URL(relative, root), 'utf8');
const exists = relative => fs.existsSync(new URL(relative, root));
const doc = read('docs/EVIDENCE_BUNDLE.md');
const contractSource = read('packages/evaluation/bundle-contract.mjs');
const schema = JSON.parse(read('schemas/evidence-bundle.schema.json'));
const facadeDts = read('packages/evaluation/evaluate-frozen.d.ts');
const facadeDmts = read('packages/evaluation/evaluate-frozen.d.mts');

test('documented result integration matches the facade declarations exactly', () => {
  for (const decl of [facadeDts, facadeDmts]) {
    assert.match(decl, /EvaluationSuccess \{[^}]*readonly status: 'success';[^}]*readonly bundle: EvidenceBundle;/s);
    assert.match(decl, /EvaluationFailure \{[^}]*readonly bundle: null;/s);
    assert.equal([...decl.matchAll(/readonly score: null;/g)].length, 2, 'score is null on both result shapes');
  }
  assert.match(doc, /plus one additive field: `bundle: EvidenceBundle`/);
  assert.match(doc, /with \*\*`bundle: null`\*\*/);
  assert.match(doc, /Top-level `score` stays `null` in both shapes/);
  assert.match(doc, /deliberate S1(?:\s)*compatibility/);
  for (const code of ['TIMEOUT', 'CANCELLED', 'MISSING_PREREQUISITE', 'TOOL_CRASH', 'OUTPUT_LIMIT', 'INVALID_TOOL_OUTPUT', 'CLEANUP_FAILED']) {
    assert.match(doc, new RegExp('`' + code + '`'), 'documented infrastructure code ' + code);
  }
  assert.match(doc, /never produce a bundle, a partial bundle(?:\s)*or(?:\s)*partial points/);
  // Rejection is the third outcome and is thrown, never returned.
  assert.match(doc, /Rejection is the third outcome, and it is thrown/);
  assert.match(doc, /\*\*rejects\*\* — a thrown `EvaluationIntegrityError` \(code\s*`EVIDENCE_INTEGRITY`\), alongside the `EvaluationRefusalError`/);
  assert.match(doc, /never\s*returns the raw S1 result, a partial bundle or\s*partial points/);
  assert.match(doc, /outputs already retained under the caller's own\s*`outputRoot` may remain/);
  assert.match(doc, /the caller handles the rejection/);
});

test('documented closed keys are exactly the schema-required ones', () => {
  assert.equal(schema.additionalProperties, false);
  const required = schema.required;
  const keySection = doc.match(/The schema requires exactly these top-level keys[\s\S]*?(?=\n## Identities)/)[0];
  const documentedKeys = [...keySection.matchAll(/^- `([A-Za-z]+)`/gm)].map(m => m[1]);
  assert.deepEqual([...documentedKeys].sort(), [...required].sort(), 'no documented key is missing from or extra to the schema');
  assert.equal(schema.properties.schemaVersion.pattern, '^1\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$');
  assert.deepEqual(schema.properties.kind, { const: 'EvidenceBundle' });
  assert.equal(schema.properties.executionStatus.const, 'success');
  assert.match(doc, /rejects unknown major versions/);
  assert.match(doc, /Incomplete or infrastructure(?:\s)*execution has no bundle and no partial score/);
});

test('documented identities match the schema and the fixed three-layer separation', () => {
  const ids = schema.properties.identities;
  assert.deepEqual(ids.required, ['challenge', 'tooling', 'submission', 'evaluator']);
  const submission = ids.properties.submission;
  assert.deepEqual(submission.required, ['runId', 'snapshotId', 'frozenSubmissionId', 'manifestDigest', 'treeDigest']);
  const evaluator = ids.properties.evaluator;
  assert.deepEqual(evaluator.required, ['binding', 'evaluatorVersion', 'scoringVersion', 'hashAlgorithm', 'semanticManifest', 'semanticDigest', 'packageManifest', 'packageDigest', 'originalCandidate']);
  assert.deepEqual(evaluator.properties.hashAlgorithm, { const: 'benchboard-sha256-tree-v1' });
  assert.deepEqual(evaluator.properties.originalCandidate.required, ['evaluator', 'scoring']);
  for (const field of ['challenge', 'tooling', 'runId', 'snapshotId', 'frozenSubmissionId', 'manifestDigest', 'treeDigest',
    'binding', 'evaluatorVersion', 'scoringVersion', 'hashAlgorithm', 'benchboard-sha256-tree-v1',
    'semanticManifest', 'semanticDigest', 'packageManifest', 'packageDigest', 'originalCandidate']) {
    assert.match(doc, new RegExp('(^|[^A-Za-z0-9-])' + field + '($|[^A-Za-z0-9-])'), 'documented identity field ' + field);
  }
  assert.match(doc, /`IDENTITY_MISMATCH`/);
  assert.match(doc, /mislabelled? synthetic C1(?:\s)*binding hashes|\*\*not\*\* mislabeled synthetic C1(?:\s)*binding hashes/);
  assert.match(doc, /version\.json/);
});

test('documented scoring block matches the schema constants, maxima and pending-human nulls', () => {
  const score = schema.properties.score;
  assert.equal(score.properties.automatedMaximum.const, 80);
  assert.equal(score.properties.humanMaximum.const, 20);
  assert.equal(score.properties.qualityMaximum.const, 100);
  assert.equal(score.properties.humanUI.type, 'null');
  assert.equal(score.properties.quality.type, 'null');
  assert.deepEqual(score.properties.status, { const: 'HUMAN_REVIEW_PENDING' });
  const areas = score.properties.areas;
  assert.deepEqual([...areas.required].sort(), ['code', 'edge', 'functional', 'hygiene', 'integration', 'persistence', 'usefulTests', 'visible'].sort());
  assert.deepEqual(Object.fromEntries(Object.entries(areas.properties).map(([k, v]) => [k, v.maximum])),
    { visible: 7, functional: 30, persistence: 10, edge: 5, integration: 15, code: 5, usefulTests: 5, hygiene: 3 });
  assert.match(doc, /`score\(validatedEvidence, null\)`/);
  assert.match(doc, /`automatedMaximum: 80`/);
  assert.match(doc, /`humanMaximum: 20`/);
  assert.match(doc, /`qualityMaximum: 100`/);
  for (const area of ['visible', 'functional', 'persistence', 'edge', 'integration', 'code', 'usefulTests', 'hygiene']) {
    assert.match(doc, new RegExp('`' + area + '`'), 'documented score area ' + area);
  }
  assert.match(doc, /`humanUI: null`/);
  assert.match(doc, /`quality: null`/);
  assert.match(doc, /`HUMAN_REVIEW_PENDING`/);
  assert.match(doc, /No human points are(?:\s)*invented/);
  assert.match(doc, /C5 reporting remains separate/);
});

test('documented evidence shapes and the total-is-17 denominator match the schema definitions', () => {
  assert.equal(schema.properties.properties.minItems, 25);
  assert.equal(schema.properties.properties.maxItems, 25);
  const property = schema.$defs.property;
  assert.deepEqual(property.required, ['id', 'area', 'passed']);
  assert.match(doc, /exactly 25 validated hidden property records/);
  assert.match(doc, /exactly `\{ id, area, passed \}`/);
  const useful = schema.$defs.useful;
  assert.deepEqual([...useful.required].sort(), ['addedCount', 'baselinePassed', 'killedMutations'].sort());
  assert.deepEqual([...useful.properties.killedMutations.items.enum].sort(),
    ['date-order', 'focus-drop', 'input-drop', 'label-case', 'storage-drop'].sort());
  for (const mutation of ['storage-drop', 'input-drop', 'focus-drop', 'label-case', 'date-order']) {
    assert.match(doc, new RegExp('`' + mutation + '`'), 'documented mutation ' + mutation);
  }
  const hygiene = schema.$defs.hygiene;
  assert.deepEqual([...hygiene.required].sort(), ['lockedDependencies', 'noDebugLogging', 'noNetwork', 'noSecrets', 'visibleIntact'].sort());
  for (const key of hygiene.required) assert.match(doc, new RegExp('`' + key + '`'), 'documented hygiene key ' + key);
  const visible = schema.properties.visible;
  assert.deepEqual(visible.required, ['passed', 'total']);
  assert.equal(visible.properties.total.const, 17);
  assert.equal(visible.properties.passed.maximum, 17);
  assert.match(doc, /`\{ passed, total: 17 \}`/);
  assert.match(doc, /scoring denominator, not an(?:\s)*invented observed metric/);
  const env = schema.properties.environment;
  assert.deepEqual([...env.required].sort(), ['architecture', 'browserVersion', 'label', 'nodeVersion', 'platform'].sort());
  for (const field of env.required) assert.match(doc, new RegExp('`' + field + '`'), 'documented environment field ' + field);
  const file = schema.$defs.file;
  assert.deepEqual(file.required, ['path', 'bytes', 'sha256']);
  assert.match(doc, /output-relative POSIX/);
  assert.match(doc, /never raw private or host-specific absolute paths/);
  const snapshot = schema.properties.snapshot;
  assert.deepEqual(snapshot.required, ['before', 'after', 'workspaceMatchesFrozen']);
});

test('documented validator semantics match the bundle-contract source, with no defaulted zeros', () => {
  assert.match(contractSource, /export function validateScorerEvidence/);
  assert.match(contractSource, /export function validateEvidenceBundle/);
  assert.match(contractSource, /export class EvaluationIntegrityError/);
  assert.match(contractSource, /this\.code = 'EVIDENCE_INTEGRITY'/);
  assert.doesNotMatch(contractSource, /\?\? 0|\|\| 0/, 'no missing input is defaulted to zero');
  assert.match(doc, /Validation never(?:\s)*supplies a missing point or boolean/);
  assert.match(doc, /omits `analysisMethod`/);
  assert.match(doc, /any private(?:\s)*diagnostic error text/);
  assert.doesNotMatch(contractSource, /analysisMethod/);
  // Hidden projection is exactly {id, area, passed}; useful projects the three closed fields.
  assert.match(contractSource, /return \{ id: record\.id, area: record\.area, passed: bool\(record\.passed, 'property\.passed'\) \}/);
  assert.match(doc, /exactly 25(?:\s)*hidden records with string `id`\/`area` and real booleans/);
  assert.match(contractSource, /new Set\(useful\.killedMutations\)\.size !== useful\.killedMutations\.length/);
  assert.match(doc, /`killedMutations` a unique(?:\s)*string array/);
  // Bundled score must equal the unchanged scorer exactly; manifests and digests are rechecked.
  assert.match(contractSource, /canonicalJson\(value\.score\) !== canonicalJson\(score\(evidence, null\)\)/);
  assert.match(contractSource, /'evaluator\/score\.mjs'/);
  assert.match(contractSource, /hashEntries/);
  assert.match(contractSource, /value\.snapshot\.before !== value\.snapshot\.after/);
  assert.match(contractSource, /identities\.submission\.treeDigest/);
  assert.match(contractSource, /'Duplicate artifact path'/);
  assert.match(contractSource, /JSON\.parse\(JSON\.stringify\(value\)\)/);
  assert.match(doc, /exact comparison, not approximation/);
  assert.match(doc, /returns a validated deep(?:\s)*copy/);
  assert.match(doc, /EVIDENCE_INTEGRITY.*(\n.*)*?an evidence-integrity refusal, distinct from the tool\/infrastructure codes/);
  assert.match(doc, /never(?:\s)*yields a partial bundle or partial points/);
});

test('documented lineage binding, hash domains and non-authenticity match the identity source', () => {
  const identitySource = read('packages/evaluation/evaluator-identity.mjs');
  const coreIdentitySource = read('packages/core/identity.mjs');
  const runtimeSource = read('packages/evaluation/bundle-runtime.mjs');
  // The original candidate hashes come verbatim from the fixed recorded lineage,
  // copied exactly from the candidate preservation baseline, not minted locally.
  assert.match(doc, /packages\/evaluation\/candidate-lineage\.json/);
  assert.match(doc, /copied exactly from the immutable\s*candidate preservation baseline/);
  assert.match(doc, /never minted from installed bytes/);
  assert.match(doc, /part of the installed package wrapper digest/);
  assert.match(doc, /exactly those three keys, 64-hex digests/);
  assert.match(doc, /installed mismatch \*\*refuses\*\* with\s*`EVIDENCE_INTEGRITY`/);
  assert.match(doc, /never relabeled as the original/);
  assert.match(identitySource, /'candidateVersion,evaluator,scoring'/);
  assert.match(identitySource, /\/\^\[a-f0-9\]\{64\}\$\/\.test\(lineage\.evaluator/);
  assert.match(identitySource, /Installed evaluator differs from recorded original candidate/);
  assert.match(identitySource, /installedEvaluator !== lineage\.evaluator \|\| installedScoring !== lineage\.scoring \|\| version !== lineage\.candidateVersion/);
  // Historical default-skip domain versus the explicit all-input semantic manifest;
  // hashes are change detectors, not cryptographic authenticity.
  assert.match(coreIdentitySource, /DEFAULT_SKIP_NAMES = Object\.freeze\(\['node_modules', 'dist', '\.git'\]\)/);
  assert.match(identitySource, /inventoryTree\(\{ root: path\.join\(root, 'evaluator'\) \}\)/);
  assert.match(doc, /historical default-skip\s*domain/);
  assert.match(doc, /`node_modules`, `dist` and `\.git` exclusions/);
  assert.match(doc, /different domain by design/);
  assert.match(doc, /no default skip at all/);
  assert.match(doc, /\*\*Not cryptographic authenticity\.\*\*/);
  assert.match(doc, /no authenticity\s*certification is claimed/);
  assert.match(doc, /No hash algorithm and no scoring grade/);
  // The runtime refuses an installed evaluator that changed during execution too.
  assert.match(runtimeSource, /Installed evaluator changed during execution/);
});

test('documented reader and non-automatic behavior claims match the honesty limits', () => {
  assert.match(doc, /`readEvidenceBundle\(text\)` takes JSON \*\*text\*\* \(a string\)/);
  assert.match(doc, /does no file IO/);
  assert.match(doc, /caller writes its own local record/);
  assert.match(doc, /records stay(?:\s)*local/);
  assert.match(doc, /No automatic persistence, network, export or CLI/);
  assert.match(doc, /no browser-cache(?:\s)*discovery or override/);
  assert.match(doc, /no endpoints or environment configuration/);
  assert.match(doc, /no(?:\s)*governed authority/);
  assert.match(doc, /COOPERATIVE_WORKSPACE_NO_ADVERSARIAL_OS_CONTAINMENT/);
  assert.match(doc, /the bundle(?:\s)*adds no sandbox to that/);
  assert.match(doc, /C5 reporting remains separate/);
  // C5 delivered these separate APIs. Pin their separation/privacy rather than
  // requiring the historical C4 statement that they are still future work.
  assert.doesNotMatch(doc, /\*\*No C5 promise\*\*|are separate later work/);
  assert.match(doc, /This bundle itself makes no UI, reporting, privacy-safe export or publication promise/);
  for (const name of ['REPORTING', 'EXPORTS', 'RESULTS_API']) assert.match(doc, new RegExp('\\]\\(' + name + '\\.md\\)'));
  assert.match(doc, /A local bundle remains private evidence, not a safe export or a certificate/);
  // No S3 parity claim and no command line documented.
  assert.doesNotMatch(doc, /parity (?:demonstration|suite|check) (?:shows|is delivered|passes)/);
  assert.doesNotMatch(doc, /matches the recorded (?:starter|reference|broken)/);
  assert.doesNotMatch(doc, /^\s*benchboard\s+\w+/gm);
  assert.doesNotMatch(doc, /PLAYWRIGHT_BROWSERS_PATH|CHROME_CACHE|ms-playwright/i);
  const absolute = [...doc.matchAll(/['"`(]((?:[A-Za-z]:\\|\/)[A-Za-z0-9_ .\\/-]{4,})/g)].map(m => m[1]);
  assert.deepEqual(absolute, [], 'only relative repo paths appear in the guide');
});

test('the pure assembler module is documented with its three exports and checked when landed', (t) => {
  const assemblerPath = 'packages/evaluation/bundle.mjs';
  if (!exists(assemblerPath)) {
    t.skip('assembler module not landed yet (separate lane)');
    return;
  }
  const assemblerSource = read(assemblerPath);
  for (const name of ['assembleEvidenceBundle', 'scorerEvidenceOf', 'readEvidenceBundle']) {
    assert.match(doc, new RegExp('`' + name + '\\('));
    assert.match(assemblerSource, new RegExp('export (async )?function ' + name + '|export const ' + name));
  }
  assert.match(doc, /accepts only a(?:\s)*complete success result/);
  assert.match(doc, /`cleanup\.removed` true with empty(?:\s)*`errors` and `residue`/);
  assert.match(doc, /`snapshot\.before === snapshot\.after` non-null/);
  assert.match(doc, /all six(?:\s)*stages successful in the established order/);
  assert.match(doc, /validates the raw `result\.evidence`(?:\s)*before calling the scorer/);
  assert.match(doc, /No(?:\s)*infrastructure or otherwise partial result can build a bundle/);
  assert.match(doc, /is not a filesystem path/);
  assert.match(doc, /persists nothing/);
});
