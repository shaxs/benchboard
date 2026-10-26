// Documentation check for docs/EVALUATION.md. Static only: reads the accepted
// declarations, the implementation sources and the preserved evaluator modules
// and asserts the documented exports, request options, defaults, stage order,
// promised error codes and factual behavior claims line up with them.
// It never executes an evaluation, starts a browser or a server, or writes anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STAGES, INFRASTRUCTURE_CODES, CANONICAL_TOOLING, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } from '../../packages/evaluation/contracts.mjs';
import * as facade from '../../packages/evaluation/evaluate-frozen.mjs';

const root = new URL('../..', import.meta.url);
const read = relative => fs.readFileSync(new URL(relative, root), 'utf8');
const doc = read('docs/EVALUATION.md');
const requestDecl = read('packages/evaluation/evaluate-frozen.d.mts');
const contractsDecl = read('packages/evaluation/contracts.d.mts');
const coreDecl = read('packages/core/manifest.d.mts');
const stagingSource = read('packages/evaluation/staging.mjs');
const controllerSource = read('packages/evaluation/controller.mjs');
const processSource = read('packages/evaluation/process.mjs');
const facadeSource = read('packages/evaluation/evaluate-frozen.mjs');
const localServerSource = read('evaluator/local-server.mjs');
const browserEvaluatorSource = read('evaluator/browser.mjs');
// The rejection classes live outside the contracts module (bundle contract and runtime).
const bundleContractSource = read('packages/evaluation/bundle-contract.mjs');
const bundleRuntimeSource = read('packages/evaluation/bundle-runtime.mjs');

test('the public facade surface is exactly evaluateFrozen and nothing is documented beyond it', () => {
  assert.deepEqual(Object.keys(facade), ['evaluateFrozen']);
  assert.match(facadeSource, /export function evaluateFrozen/);
  assert.match(requestDecl, /export declare function evaluateFrozen\(request: EvaluationRequest\): Promise<EvaluationSuccess \| EvaluationFailure>/);
  assert.match(doc, /`evaluateFrozen`/);
  // The internal runtime seam must not be presented as a supported option.
  assert.doesNotMatch(doc, /evaluateWithRuntime/);
  for (const internal of ['stageOverrides', 'onEvent', 'canonicalRoot', 'dependencyRoot', 'cleanupScratch']) {
    assert.doesNotMatch(doc, new RegExp('`' + internal + '`'), internal + ' must not be documented as a request option');
  }
});

test('documented request options match the declared request and the enforced closed option set', () => {
  const declared = requestDecl.match(/export interface EvaluationRequest \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(declared, 'EvaluationRequest declaration found');
  const declaredOptions = [...declared.matchAll(/^  readonly ([A-Za-z_$][0-9A-Za-z_$]*)(\??):/gm)].map(m => m[1]);
  const enforced = stagingSource.match(/const allowed = \[([^\]]+)\]/)?.[1];
  assert.ok(enforced, 'enforced option list found in staging');
  const enforcedOptions = [...enforced.matchAll(/'([A-Za-z_$][0-9A-Za-z_$]*)'/g)].map(m => m[1]);
  assert.deepEqual([...declaredOptions].sort(), [...enforcedOptions].sort(), 'declarations and runtime option set agree');
  for (const option of declaredOptions) assert.match(doc, new RegExp('`' + option + '`'), 'documented request option ' + option);
  // Documented submission fields match the enforced selection keys.
  const selectionDecl = requestDecl.match(/export interface FrozenSelection \{([^}]+)\}/)?.[1];
  assert.ok(selectionDecl, 'FrozenSelection declaration found');
  const selectionKeys = stagingSource.match(/!\['runRoot', 'runId', 'manifestId', 'snapshotId', 'frozenSubmissionId', 'expectedDigest'\]\.includes\(key\)/);
  assert.ok(selectionKeys, 'enforced selection key list found');
  for (const key of ['runRoot', 'runId', 'manifestId', 'snapshotId', 'frozenSubmissionId', 'expectedDigest']) {
    assert.match(selectionDecl, new RegExp('readonly ' + key + ':'), 'declared submission field ' + key);
    assert.match(doc, new RegExp('\\b' + key + '\\b'), 'documented submission field ' + key);
  }
  assert.equal(declaredOptions.length, enforcedOptions.length);
});

test('documented defaults, bounds and error classes match the declarations', () => {
  assert.match(contractsDecl, new RegExp('DEFAULT_TIMEOUT_MS: ' + DEFAULT_TIMEOUT_MS));
  assert.match(contractsDecl, new RegExp('DEFAULT_MAX_OUTPUT_BYTES: ' + DEFAULT_MAX_OUTPUT_BYTES));
  assert.match(doc, new RegExp('default ' + DEFAULT_TIMEOUT_MS), 'documented default timeout');
  assert.match(doc, new RegExp('default ' + DEFAULT_MAX_OUTPUT_BYTES), 'documented default output bound');
  assert.match(contractsDecl, /export declare class EvaluationInfrastructureError extends Error/);
  assert.match(contractsDecl, /export declare class EvaluationRefusalError extends Error/);
  assert.match(doc, /EvaluationInfrastructureError/);
  assert.match(doc, /EvaluationRefusalError/);
  // The declaration pins score to null on both result shapes; the doc says the same.
  assert.equal([...requestDecl.matchAll(/readonly score: null;/g)].length, 2, 'score is null on success and on infrastructure failure');
  assert.match(doc, /`score`[^\n]*Always `null` at the top level/, 'documented top-level score is always null');
  assert.match(doc, /`bundle\.score`/, 'the automated score is documented at bundle.score');
});

test('documented stage order, codes and canonical replacement match the contracts', () => {
  assert.deepEqual([...STAGES], ['typecheck', 'build', 'visible', 'browser', 'useful', 'inspection']);
  const order = ['typecheck', 'build', 'visible', 'browser', 'useful'];
  const positions = order.map(stage => doc.indexOf('**' + stage));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'documented stage order follows the contract order');
  for (const code of INFRASTRUCTURE_CODES) assert.match(doc, new RegExp('`' + code + '`'), 'documented infrastructure code ' + code);
  const documentedCodes = [...doc.matchAll(/`([A-Z_]+)`/g)].map(m => m[1]).filter(name => /^[A-Z][A-Z_]+$/.test(name));
  const declaredCodes = new Set([...INFRASTRUCTURE_CODES,
    'INVALID_ARGUMENT', 'INVALID_PATH', 'INVALID_SELECTION', 'IDENTITY_INVALID', 'IDENTITY_MISMATCH',
    'SNAPSHOT_REFUSED', 'OUTPUT_EXISTS', 'ROOTS_OVERLAP', 'UNSAFE_PATH', 'UNSAFE_ENTRY', 'CASE_COLLISION',
    'TREE_LIMIT', 'SOURCE_CHANGED', 'OWNERSHIP_LOST', 'CLEANUP_FAILED']);
  for (const code of documentedCodes) {
    if (/^(NODE|OS|C3|S1|S2|S3|T1|T6B|SH|JSON|TS|JS|ES|URL|CLI|UI|API|DSH)$/.test(code)) continue;
    if (code === 'EVIDENCE_INTEGRITY') {
      assert.match(bundleContractSource, /this\.code = 'EVIDENCE_INTEGRITY'/, 'the integrity code is declared and emitted by the bundle contract');
      continue;
    }
    if (code === 'COOPERATIVE_WORKSPACE_NO_ADVERSARIAL_OS_CONTAINMENT') {
      // It is a declared security model, not an error code; check it against the core declaration.
      assert.match(coreDecl, new RegExp("'" + code + "'"), 'security model is declared');
      continue;
    }
    assert.ok(declaredCodes.has(code), 'documented code ' + code + ' is a declared error or infrastructure code');
  }
  for (const tool of CANONICAL_TOOLING) assert.match(doc, new RegExp('`' + tool.replace(/\./g, '\\.') + '`'), 'documented canonical tooling ' + tool);
});

test('documentation carries no invented CLI, browser-cache handling, private paths or credentials', () => {
  // No command-line form is documented (no `benchboard …` invocation, no historical runner script).
  assert.doesNotMatch(doc, /^\s*benchboard\s+(evaluate|score|run)\b/gm);
  assert.doesNotMatch(doc, /runner\/(evaluate|supervise|create-run|freeze|reset)\.mjs/);
  // No browser-cache/profile override or discovery command.
  assert.doesNotMatch(doc, /--user-data-dir|CHROME_CACHE|PLAYWRIGHT_BROWSERS_INSTALL|ms-playwright-edge|CacheDir/i);
  // No personal or host-specific absolute paths; only the synthetic placeholders.
  const absolute = [...doc.matchAll(/['"`(]((?:[A-Za-z]:\\|\/)[A-Za-z0-9_ .\\/-]{4,})/g)].map(m => m[1]);
  for (const at of absolute) assert.match(at, /^\/example\//, 'only synthetic /example paths appear: ' + at);
  assert.doesNotMatch(doc, /C:\\|Users\\[A-Za-z0-9]+/);
  // No claim that the top level produces a score, a certification or parity; the
  // versioned bundle assembly is delivered here and parity remains future S3 work.
  assert.match(doc, /parity\s+demonstration[\s\S]*?is \*\*S3\*\*\s+work/);
  assert.match(doc, /`EvidenceBundle` assembly[\s\S]*?\*\*is\*\*\s+delivered/);
  assert.doesNotMatch(doc, /are \*\*S2\*\* work; neither\s*is delivered at S1/);
  assert.match(doc, /COOPERATIVE_WORKSPACE_NO_ADVERSARIAL_OS_CONTAINMENT/);
  assert.match(doc, /never installs|never installed|never download/i);
  // S1 checkout documentation, not a publication or qualification claim.
  assert.match(doc, /not\*\* an approved\npublic release/i);
  assert.doesNotMatch(doc, /released (?:modules|product)|publicly released|generally available/i);
});

test('every documented refusal code is actually emitted by the implementation it is attributed to', () => {
  const refusalParagraph = doc.match(/### Rejection — a thrown[\s\S]*?(?=\n## )/)?.[0];
  assert.ok(refusalParagraph, 'rejection section present');
  const codes = [...refusalParagraph.matchAll(/`([A-Z][A-Z_]+)`/g)].map(m => m[1]);
  assert.ok(codes.length >= 12, 'the section names the refusal set');
  const stagingEmitted = new Set([...stagingSource.matchAll(/refuse\('([A-Z_]+)'/g)].map(m => m[1]));
  const controllerEmitted = new Set([...controllerSource.matchAll(/new EvaluationRefusalError\('([A-Z_]+)'/g)].map(m => m[1]));
  for (const code of codes) {
    if (code === 'EVIDENCE_INTEGRITY') {
      assert.match(bundleContractSource, /this\.code = 'EVIDENCE_INTEGRITY'/, 'the integrity code is declared and emitted by the bundle contract');
      continue;
    }
    const emitted = stagingEmitted.has(code) || controllerEmitted.has(code);
    assert.ok(emitted, 'documented refusal code ' + code + ' is emitted by staging.mjs or controller.mjs');
  }
  // The infrastructure code set the doc promises equals the declared one.
  for (const code of INFRASTRUCTURE_CODES) assert.ok(doc.includes('`' + code + '`'), code);
});

test('documented behavior claims match the implementation, the preserved modules and the runner', () => {
  // 1. Import graph: preserved evaluator modules are the load-bearing transitive imports.
  assert.match(doc, /preserved evaluator semantic modules/);
  assert.match(doc, /allowed `runner\/files\.mjs` path-and-hash utility/);
  assert.match(read('packages/evaluation/browser-stage.mjs'), /evaluator\/local-server\.mjs/);
  assert.match(read('packages/evaluation/browser-stage.mjs'), /evaluator\/browser\.mjs/);
  assert.match(read('packages/evaluation/useful-stage.mjs'), /evaluator\/useful-tests\.mjs/);
  assert.match(read('packages/evaluation/stage-worker.mjs'), /evaluator\/collect-evidence\.mjs/);
  assert.match(read('evaluator/useful-tests.mjs'), /runner\/files\.mjs/);
  // 2. Retained output outside the disposable scratch; inputs are not written by the evaluation.
  assert.match(doc, /outside the disposable scratch/);
  assert.match(doc, /detected and refused[^\n]*never repaired|never repaired, rolled back or overwritten/);
  assert.doesNotMatch(doc, /byte-identical after an evaluation|Nothing outside the scratch is touched/);
  // 3. Browser stage is the loopback development server, never a dist/preview claim.
  assert.match(doc, /loopback \*\*development server\*\*/);
  assert.match(doc, /is \*not\* a server over the built `dist\/` output/);
  assert.match(localServerSource, /vite\.js[\s\S]*--host[\s\S]*127\.0\.0\.1/);
  assert.doesNotMatch(localServerSource, /preview/);
  // 4. Canonical tests are an overlay; participant-added tests remain for useful scoring.
  assert.match(doc, /an \*\*overlay\*\*/);
  assert.match(doc, /participant's added tests/);
  assert.match(doc, /operator\nprerequisites/);
  // 5. A preflight failure has no process log; the structured error carries it.
  assert.match(doc, /no\s+process log|no\s+stage-artifact directory/);
  // 5b. The infrastructure-failure paragraph says this with a clear sentence: the
  //     condition travels as a structured diagnostic, never a fabricated log, and
  //     the garbled clause "rather than by logs, and it never is." is gone.
  assert.match(doc, /a structured diagnostic, never a fabricated process log/);
  assert.doesNotMatch(doc, /rather than by logs, and it never is/);
  // 6. An earlier primary error is never overwritten by a cleanup problem.
  assert.match(doc, /only when no earlier failure exists/);
  assert.match(doc, /never replaces the primary cause/);
  assert.match(controllerSource, /if \(!failure\) failure = new EvaluationInfrastructureError\('cleanup', 'CLEANUP_FAILED'/);
  // 7. Witness rule: nonzero Node exit needs valid normal evidence; zero exit is
  //    accepted without a witness; an unreported OS signal stays null.
  assert.match(doc, /a \*\*nonzero\*\* Node exit is ordinary evidence \*\*only with a valid\s+normal-completion witness\*\*/);
  assert.match(doc, /absent witness at exit zero is not a failure/);
  assert.match(doc, /stays `null` in the facts and is never synthesized/);
  assert.match(processSource, /if \(exitCode === 0\) \{/);
  assert.match(processSource, /if \(w\.verdict === 'normal'\) return null; \/\/ valid normal:true preserves every ordinary nonzero code/);
  // 8. No Node/process network sandbox; only the browser page-context origin routing.
  assert.match(doc, /no operating-system or network\s+sandbox is applied to the Node tool processes/);
  assert.match(doc, /general subprocess network access is\s+possible and not sandboxed/);
  assert.match(browserEvaluatorSource, /context\.route\('\*\*\/\*'/);
  assert.match(browserEvaluatorSource, /route\.abort\(\)/);
  // The stale "no network access beyond loopback" promise must not survive.
  assert.doesNotMatch(doc, /no network\s*\n?\s*access beyond the loopback/);
});

test('the documented rejection classes and three outcomes match the facade and runtime', () => {
  // Three outcomes: a success carrying a validated bundle, the returned
  // infrastructure failure with bundle:null, or a thrown rejection — never a
  // degraded raw-S1 shape.
  assert.match(doc, /it \*\*rejects in every other case\*\*/);
  assert.match(doc, /Integrity rejects\s*never return the raw S1 result, a partial score or a partial bundle/);
  const rejectionParagraph = doc.match(/### Rejection — a thrown[\s\S]*?(?=\n## )/)?.[0];
  assert.ok(rejectionParagraph, 'rejection section present');
  assert.match(rejectionParagraph, /Request and safety refusals \(`EvaluationRefusalError`\)/);
  assert.match(rejectionParagraph, /Evidence-integrity refusals \(`EvaluationIntegrityError`, code `EVIDENCE_INTEGRITY`\)/);
  assert.match(rejectionParagraph, /no raw S1 result, partial score or partial bundle comes back/);
  assert.match(rejectionParagraph, /the caller handles the rejection/);
  // The facade separates returned infrastructure failures from thrown rejections;
  // nothing degrades a non-success into a bundle shape.
  assert.match(facadeSource, /if \(!\(error instanceof EvaluationInfrastructureError\)\) throw error/);
  assert.match(bundleRuntimeSource, /if \(result\.status !== 'success'\) return \{ \.\.\.result, bundle: null \}/);
  assert.match(bundleRuntimeSource, /throw new EvaluationIntegrityError\('Installed evaluator changed during execution'\)/);
  // Integrity-rejection timing: the guide names both ends of the run (the modeled
  // faults are the class list, not an all-bugs guarantee), and the facade source
  // really has that shape: the identity/lineage check runs before the stages and
  // the bundle/identity validation runs after them.
  assert.match(doc, /before any tool runs[\s\S]{0,220}after the completed stages/, 'the documented rejection timing spans before any tool runs and after the completed stages');
  const identityAt = facadeSource.search(/computeEvaluatorIdentity\(\)/);
  const runtimeAt = facadeSource.search(/evaluateWithRuntime\(/);
  const attachAt = facadeSource.search(/attachEvidenceBundle\(/);
  assert.ok(identityAt !== -1 && runtimeAt !== -1 && attachAt !== -1 && identityAt < runtimeAt && runtimeAt < attachAt, 'the facade computes the installed evaluator identity before evaluateWithRuntime and attaches the bundle afterward');
});
