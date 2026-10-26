import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  root,
  files,
  sha,
  assertSnapshot,
  candidate,
  contained,
  rejectLinksTo,
} from './files.mjs';
const sourceRoots = [
  'spec',
  'starter',
  'reference',
  'fixtures',
  'evaluator',
  'runner',
];
const sourceFiles = [
  'README.md',
  'AGENTS.md',
  'package.json',
  'package-lock.json',
  'version.json',
  '.gitattributes',
  '.editorconfig',
  '.gitignore',
  '.dockerignore',
];
const evidenceFiles = [
  'artifacts/self-validation.json',
  'artifacts/fairness-review-candidate.2.json',
  'artifacts/fairness-review-candidate.4.md',
  'artifacts/fairness-review-candidate.5.md',
  'artifacts/fairness-review-candidate.6.md',
  'artifacts/fairness-review-preservation.json',
  'artifacts/candidate5-ceiling-evidence.json',
  'artifacts/candidate6-remediation-evidence.json',
  'artifacts/candidate7-remediation-evidence.json',
  'artifacts/fairness-review-candidate.7.md',
  'artifacts/candidate8-remediation-evidence.json',
  'artifacts/candidate8-test-consolidation.json',
  'artifacts/candidate8-selftest.json',
  'artifacts/fairness-review-candidate.8.md',
  'artifacts/candidate9-remediation-evidence.json',
  'artifacts/candidate9-test-consolidation.json',
  'artifacts/candidate9-selftest.json',
  'artifacts/preservation-archive.json',
  'artifacts/encoding-repairs.json',
  'artifacts/candidate4-harness-tests.log',
  'artifacts/candidate4-deadline-evidence.json',
  'artifacts/candidate4-telemetry-evidence.json',
  'artifacts/acceptance-validation.json',
  'artifacts/reference-ui-sanity.json',
  'artifacts/reference-ui-sanity-candidate.4.json',
  'artifacts/methodology-change.json',
  'artifacts/candidate-manifest.json',
  'artifacts/mutation-probes.json',
  'artifacts/harness-tests.log',
  'artifacts/deadline-smoke.json',
  'artifacts/offline-install.log',
  ...['starter', 'reference', 'broken'].flatMap((app) => [
    `artifacts/${app}-build-evidence.json`,
    `artifacts/${app}-visible.json`,
  ]),
];
const evidenceRoots = [
  'artifacts/starter-report',
  'artifacts/reference-report',
  'artifacts/broken-report',
  'artifacts/reference-browser',
  'artifacts/starter-browser',
  'artifacts/broken-browser',
  'artifacts/reference-repeat',
  'artifacts/reference-useful',
  'artifacts/workload',
  'artifacts/presentation-witness',
  'artifacts/methodology-history',
  'artifacts/candidate7-mutations',
  'artifacts/candidate8-mutations',
  'artifacts/candidate9-mutations',
];
function inputsCurrent() {
  const list = [...sourceFiles, ...evidenceFiles];
  for (const base of [...sourceRoots, ...evidenceRoots])
    for (const p of files(path.join(root, base))) {
      if (
        base === 'artifacts/reference-useful' &&
        !/^(baseline|summary|storage-drop|input-drop|focus-drop|label-case|date-order)\.json$/.test(
          p,
        )
      )
        continue;
      // Previous failed validation screenshots may coexist with later passing results.
      // Current hidden JSON records all outcomes; only current reference viewport images are review inputs.
      if (base.includes('-browser') || base.endsWith('reference-repeat')) {
        if (
          p !== 'hidden.json' &&
          (!base.includes('reference') ||
            !/^(board|drawer)-(1440|1024|768)\.png$/.test(p))
        )
          continue;
      }
      if (
        (base === 'artifacts/workload' ||
          base === 'artifacts/presentation-witness') &&
        p.endsWith('.png')
      )
        continue;
      list.push(base + '/' + p);
    }
  if (new Set(list).size !== list.length)
    throw Error('Duplicate logical inputs');
  for (const p of list) {
    rejectLinksTo(path.join(root, p));
    if (!fs.statSync(path.join(root, p)).isFile())
      throw Error('Missing input ' + p);
    if (
      /(^|\/)(node_modules|dist|\.git|runs|broken-source|evaluations)(\/|$)/.test(
        p,
      )
    )
      throw Error('Participant/run output prohibited ' + p);
  }
  return list.sort();
}
function currentEvidence(hashes) {
  const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p)));
  const v = read('artifacts/self-validation.json');
  const acceptance = read('artifacts/acceptance-validation.json');
  if (
    v.benchmark !== hashes.version.version ||
    acceptance.passed !== true ||
    JSON.stringify(acceptance.hashes) !== JSON.stringify(hashes)
  )
    throw Error('Stale or incomplete validation');
  // The newest append-only transition must describe exactly this candidate.
  const transition =
    'artifacts/methodology-history/methodology-change-' +
    'candidate.' +
    (Number(hashes.version.version.split('candidate.')[1]) - 1) +
    '-to-candidate.' +
    hashes.version.version.split('candidate.')[1] +
    '.json';
  if (JSON.stringify(read(transition).after) !== JSON.stringify(hashes))
    throw Error('Stale hash change record');
  for (const app of ['starter', 'reference'])
    if (read(`artifacts/${app}-build-evidence.json`).sourceHash !== hashes[app])
      throw Error('Stale workload build evidence');
  const floors = read('artifacts/workload/score-floors.json').variants;
  const untouched = floors.find((r) => r.name === 'untouched');
  const useful = read('artifacts/reference-useful/summary.json');
  if (
    v.checks.reference.visiblePassed !== 17 ||
    v.checks.reference.hiddenPassed !== 25 ||
    v.checks.reference.automated !== 80 ||
    v.checks.seededDefectsDetected !== 7 ||
    v.checks.starter.visiblePassed !== untouched.visiblePassed ||
    v.checks.starter.hiddenPassed !== untouched.hiddenPassed ||
    v.checks.starter.automated !== untouched.score.automated ||
    !useful.baselinePassed ||
    useful.killedMutations.length !== 5 ||
    read('artifacts/presentation-witness/summary.json').passed !== 25 ||
    read('artifacts/fairness-review-candidate.2.json').verdict !==
      'CHANGES_REQUESTED' ||
    !/VERDICT: PASS/.test(
      fs.readFileSync(
        path.join(root, 'artifacts/fairness-review-candidate.4.md'),
        'utf8',
      ),
    )
  )
    throw Error('Incomplete candidate.4 remediation evidence');
  // Methodology-only candidates must prove the accepted workload bytes match
  // and must carry the preserved prior independent verdicts.
  const ceiling = read('artifacts/candidate5-ceiling-evidence.json');
  if (
    ceiling.participantWorkloadBytesChanged !== false ||
    ceiling.calibration1Preserved !== true
  )
    throw Error('Incomplete candidate.5 ceiling evidence');
  const remediation = read('artifacts/candidate6-remediation-evidence.json');
  if (
    remediation.participantWorkloadBytesChanged !== false ||
    remediation.mutationsAllRed !== true ||
    remediation.priorVerdictPreserved !== true
  )
    throw Error('Incomplete candidate.6 remediation evidence');
  const prior = read('artifacts/candidate7-remediation-evidence.json');
  const priorMutations = read('artifacts/candidate7-mutations/summary.json');
  if (
    prior.participantWorkloadBytesChanged !== false ||
    prior.priorVerdictsPreserved !== true ||
    priorMutations.allRedAsRequired !== true ||
    priorMutations.sourceScannerUsedAsSoleProof !== false
  )
    throw Error('Incomplete candidate.7 remediation evidence');
  // Candidate.8 evidence is now historical.
  const priorEight = read('artifacts/candidate8-remediation-evidence.json');
  const priorEightMutations = read('artifacts/candidate8-mutations/summary.json');
  if (
    priorEight.participantWorkloadBytesChanged !== false ||
    priorEight.priorVerdictsPreserved !== true ||
    priorEightMutations.sourceScannerUsedAsSoleProof !== false
  )
    throw Error('Incomplete candidate.8 remediation evidence');
  // The current candidate's remediation evidence must bind the CURRENT tuple,
  // carry every prior independent verdict, and report its mutation categories
  // separately rather than aggregating them.
  const current = read('artifacts/candidate9-remediation-evidence.json');
  const mutations = read('artifacts/candidate9-mutations/summary.json');
  const consolidation = read('artifacts/candidate9-test-consolidation.json');
  // The owner self-test must be side-effect-free on the reviewer's own
  // fresh-checkout condition, where the committed manifest can be stale.
  const selfTest = read('artifacts/candidate9-selftest.json');
  if (
    selfTest.total.fail !== 0 ||
    selfTest.reviewInputNoMutation !== true ||
    selfTest.reviewInputNoMutationOnStaleManifest !== true ||
    selfTest.manifestBytesRestored !== true
  )
    throw Error('Candidate.9 self-test measurements incomplete');
  if (
    current.participantWorkloadBytesChanged !== false ||
    JSON.stringify(current.after) !== JSON.stringify(hashes) ||
    current.priorVerdictsPreserved !== true ||
    current.liveDshOperated !== false ||
    current.realProducerConsumerChainProven !== true ||
    consolidation.noPropertyLostCoverage !== true
  )
    throw Error('Incomplete candidate.9 remediation evidence');
  // Mutation categories must be reported separately and honestly. A surviving
  // or undetermined mutation is a gap, and an aggregated claim is refused.
  if (
    mutations.aggregatedAsEquivalent !== false ||
    mutations.sourceScannerUsedAsSoleProof !== false ||
    mutations.allApplied !== true ||
    mutations.allBytesRestored !== true ||
    mutations.survived !== 0 ||
    mutations.undetermined !== 0 ||
    mutations.notApplied !== 0 ||
    mutations.propertyProving < 20 ||
    typeof mutations.correctionToCandidate8 !== 'string'
  )
    throw Error('Candidate.9 mutation evidence incomplete or aggregated');
  for (const v of ['5', '6', '7', '8'])
    if (
      !/VERDICT: CHANGES_REQUESTED/.test(
        fs.readFileSync(
          path.join(root, 'artifacts/fairness-review-candidate.' + v + '.md'),
          'utf8',
        ),
      )
    )
      throw Error('Candidate.' + v + ' independent verdict not preserved');
}
export function verifyPacket(
  destination,
  { mode = 'integrity', currentHashes = null, compareSourceBytes = true } = {},
) {
  if (!['integrity', 'freshness'].includes(mode))
    throw Error('Explicit integrity or freshness mode required');
  rejectLinksTo(destination);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(destination, 'manifest.json'), 'utf8'),
  );
  if (
    manifest.classification !==
    'OWNER_ONLY_BENCHMARK_REVIEW_NOT_PARTICIPANT_INPUT'
  )
    throw Error('Invalid packet classification');
  const validPath = (p) =>
    typeof p === 'string' &&
    p.length > 0 &&
    !p.includes('\\') &&
    !p.includes(':') &&
    !p.startsWith('/') &&
    !p.split('/').some((x) => x === '..' || x === '.' || x === '');
  const inputs = manifest.inputs;
  if (
    !Array.isArray(inputs) ||
    !inputs.length ||
    new Set(inputs.map((e) => e.source)).size !== inputs.length
  )
    throw Error('Missing or duplicate logical inputs');
  const unique = new Set(),
    content = new Set();
  const sources = new Map(inputs.map((e) => [e.source, e]));
  for (const e of inputs) {
    if (
      !validPath(e.source) ||
      !validPath(e.packetPath) ||
      !e.packetPath.startsWith('inputs/') ||
      /(^|\/)(node_modules|dist|\.git|runs|broken-source|evaluations)(\/|$)/.test(
        e.source,
      )
    )
      throw Error('Unsafe or participant-run input');
    if (!contained(destination, path.join(destination, e.packetPath)))
      throw Error('Unsafe packet path');
    const bytes = fs.readFileSync(path.join(destination, e.packetPath));
    if (bytes.length !== e.bytes || sha(bytes) !== e.sha256)
      throw Error('Changed input ' + e.source);
    if (e.alias !== (e.packetPath !== 'inputs/' + e.source))
      throw Error('Invalid alias');
    unique.add(e.packetPath);
  }
  for (const p of unique) {
    const h = sha(fs.readFileSync(path.join(destination, p)));
    if (content.has(h)) throw Error('Duplicate physical content');
    content.add(h);
  }
  for (const p of [...manifest.sourceFiles, ...manifest.evidenceFiles])
    if (!sources.has(p))
      throw Error('Expected input manifest incomplete: ' + p);
  for (const base of [...manifest.sourceRoots, ...manifest.evidenceRoots])
    if (!inputs.some((e) => e.source.startsWith(base + '/')))
      throw Error('Missing expected root ' + base);
  for (const e of inputs)
    if (
      ![...manifest.sourceFiles, ...manifest.evidenceFiles].includes(
        e.source,
      ) &&
      ![...manifest.sourceRoots, ...manifest.evidenceRoots].some((b) =>
        e.source.startsWith(b + '/'),
      )
    )
      throw Error('Unexpected input ' + e.source);
  const tuple = manifest.candidate;
  const treeHash = (base) =>
    sha(
      JSON.stringify(
        inputs
          .filter((e) => e.source.startsWith(base + '/'))
          .map((e) => [e.source.slice(base.length + 1), e.sha256])
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      ),
    );
  for (const [base, key] of [
    ['spec', 'specTree'],
    ['starter', 'starter'],
    ['reference', 'reference'],
    ['fixtures', 'fixtures'],
    ['evaluator', 'evaluator'],
    ['runner', 'runner'],
    ['starter/tests', 'visible'],
  ])
    if (treeHash(base) !== tuple[key])
      throw Error('Recorded candidate tree mismatch ' + key);
  for (const [p, key] of [
    ['version.json', 'versionHash'],
    ['spec/BENCHMARK.md', 'spec'],
    ['starter/PRODUCT_PRD.md', 'prd'],
    ['evaluator/score.mjs', 'scoring'],
  ])
    if (sources.get(p)?.sha256 !== tuple[key])
      throw Error('Recorded candidate file mismatch ' + key);
  const readInput = (p) =>
    JSON.parse(
      fs.readFileSync(
        path.join(destination, sources.get(p).packetPath),
        'utf8',
      ),
    );
  if (
    JSON.stringify(readInput('version.json')) !== JSON.stringify(tuple.version)
  )
    throw Error('Recorded candidate version mismatch');
  if (
    JSON.stringify(readInput('artifacts/candidate-manifest.json')) !==
    JSON.stringify(tuple)
  )
    throw Error('Recorded candidate manifest mismatch');
  const actual = files(destination, new Set());
  const allowed = [
    ...unique,
    'manifest.json',
    'MAP.md',
    'verification.json',
  ].sort();
  if (JSON.stringify(actual) !== JSON.stringify(allowed))
    throw Error('Unexpected, missing or stale packet files');
  const verification = JSON.parse(
    fs.readFileSync(path.join(destination, 'verification.json'), 'utf8'),
  );
  const manifestSHA256 = sha(
    fs.readFileSync(path.join(destination, 'manifest.json')),
  );
  const digest = sha(
    JSON.stringify({
      manifestSHA256,
      mapSHA256: sha(fs.readFileSync(path.join(destination, 'MAP.md'))),
      physicalInputs: [...unique]
        .sort()
        .map((p) => [p, sha(fs.readFileSync(path.join(destination, p)))]),
    }),
  );
  if (
    verification.packetDigest !== digest ||
    verification.manifestSHA256 !== manifestSHA256 ||
    verification.logicalInputs !== inputs.length ||
    verification.physicalInputs !== unique.size ||
    verification.deduplicatedAliases !== inputs.length - unique.size ||
    verification.status !== 'PASS'
  )
    throw Error('Packet digest/count mismatch');
  let freshness = null;
  if (mode === 'freshness') {
    const current = currentHashes || candidate();
    freshness =
      JSON.stringify(tuple) === JSON.stringify(current) ? 'CURRENT' : 'STALE';
    if (freshness === 'CURRENT' && compareSourceBytes) {
      if (
        JSON.stringify(inputs.map((e) => e.source).sort()) !==
        JSON.stringify(inputsCurrent())
      )
        throw Error('Current expected input manifest incomplete');
      for (const e of inputs) {
        const bytes = fs.readFileSync(path.join(root, e.source));
        if (sha(bytes) !== e.sha256 || bytes.length !== e.bytes)
          throw Error('Changed current source ' + e.source);
      }
    }
  }
  return {
    ...verification,
    integrity: 'PASS',
    mode,
    freshness,
    recordedCandidateVersion: tuple.version.version,
    verifiedAgainstCurrentOwner: freshness === 'CURRENT',
  };
}
export function buildPacket() {
  const hashes = assertSnapshot();
  currentEvidence(hashes);
  const selected = inputsCurrent();
  const base = path.join(root, 'artifacts/review');
  rejectLinksTo(base);
  fs.mkdirSync(base, { recursive: true });
  const destination = path.join(
    base,
    'BenchBoard-' + hashes.version.version + '-owner-review',
  );
  if (fs.existsSync(destination))
    throw Error(
      'Packet already exists; preserve it and use a new candidate for changes',
    );
  fs.mkdirSync(destination);
  const entries = [],
    seen = new Map();
  try {
    for (const source of selected) {
      const bytes = fs.readFileSync(path.join(root, source));
      const h = sha(bytes);
      let packetPath = seen.get(h);
      if (!packetPath) {
        packetPath = 'inputs/' + source;
        seen.set(h, packetPath);
        const to = path.join(destination, packetPath);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, bytes);
      }
      entries.push({
        source,
        packetPath,
        sha256: h,
        bytes: bytes.length,
        alias: packetPath !== 'inputs/' + source,
      });
    }
    const manifest = {
      classification: 'OWNER_ONLY_BENCHMARK_REVIEW_NOT_PARTICIPANT_INPUT',
      createdAt: new Date().toISOString(),
      baselineCheckpoint: '35786f8',
      candidate: hashes,
      sourceRoots,
      sourceFiles,
      evidenceRoots,
      evidenceFiles,
      inputs: entries,
      exclusions: [
        'all participant run manifests/workspaces/execution outputs',
        'installed dependencies/build products/git history',
        'older variants/synthetic metrics/ad hoc validation artifacts and historical failure screenshots',
      ],
      contentDeduplication:
        'Identical content stored once; logical original paths retained as aliases, not missing inputs.',
    };
    fs.writeFileSync(
      path.join(destination, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
    const map =
      '# OWNER-ONLY independent benchmark review packet\n\nRead inputs/spec/FAIRNESS_PROMPT.md first. No review or calibration is launched by this packet. Manifest includes exact current candidate hash tuple, complete input inventory and per-file SHA-256. verification.json supplies packet digest. Duplicate content is stored once; aliases point to the canonical copy below. Do not share this packet or owner material with participants.\n\nMaterial groups: spec/BENCHMARK.md (original BENCHBOARD_V1_BENCHMARK_SPEC); spec/TRUST_MODEL.md and CALIBRATION.md (current superseding methodology); starter/PRODUCT_PRD.md and starter sources/tests/data; fixtures canonical data; evaluator hidden assertions/scoring/probes; reference source/tests and owner browser/results; spec/DESIGN.md seeded-defect design; runner run/reset/deadline/telemetry/hash/freeze tooling; spec/UI_REVIEW.md and HUMAN_UI_WORKSHEET.md; artifacts selected current self-validation evidence. Historical candidate.3 reference UI sanity is PASS; current reference bytes require renewed human acceptance, with no numerical reference score; see spec/REFERENCE_UI_SANITY.md. Legacy deadline-smoke, harness-tests and methodology-change files are historical; candidate4-prefixed evidence and the candidate.3-to-candidate.4 ledger are current. Empirical results remain pending. Installed dependencies omitted; locks and setup instructions included.\n\n| Logical input | Read packet file | SHA-256 |\n|---|---|---|\n' +
      entries
        .map(
          (e) =>
            `| ${e.source} | [${e.packetPath}](${e.packetPath}) | ${e.sha256} |`,
        )
        .join('\n') +
      '\n';
    fs.writeFileSync(path.join(destination, 'MAP.md'), map);
    const unique = [...seen.values()].sort();
    const packetDigest = sha(
      JSON.stringify({
        manifestSHA256: sha(
          fs.readFileSync(path.join(destination, 'manifest.json')),
        ),
        mapSHA256: sha(fs.readFileSync(path.join(destination, 'MAP.md'))),
        physicalInputs: unique.map((p) => [
          p,
          sha(fs.readFileSync(path.join(destination, p))),
        ]),
      }),
    );
    fs.writeFileSync(
      path.join(destination, 'verification.json'),
      JSON.stringify(
        {
          status: 'PASS',
          expectedInputsPresent: true,
          accidentalParticipantRunOutputs: 0,
          staleVariants: 0,
          duplicateLogicalInputs: 0,
          duplicatePhysicalContent: 0,
          logicalInputs: entries.length,
          physicalInputs: unique.length,
          deduplicatedAliases: entries.length - unique.length,
          manifestComplete: true,
          hashesRecorded: true,
          manifestSHA256: sha(
            fs.readFileSync(path.join(destination, 'manifest.json')),
          ),
          packetDigest,
        },
        null,
        2,
      ),
    );
    return { destination, ...verifyPacket(destination, { mode: 'freshness' }) };
  } catch (e) {
    fs.writeFileSync(
      path.join(destination, 'INCOMPLETE_DO_NOT_REVIEW.txt'),
      String(e),
    );
    throw e;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(
    JSON.stringify(
      process.argv[2] === 'verify'
        ? verifyPacket(path.resolve(process.argv[3]), {
            mode: process.argv[4] || 'integrity',
          })
        : buildPacket(),
      null,
      2,
    ),
  );
