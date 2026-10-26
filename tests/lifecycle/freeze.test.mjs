/**
 * BenchBoard v0.1 C3 T4 — the fresh-identity reset without destructive
 * old-run mutation.
 *
 * Every container here is a real C2 container produced by the accepted
 * `initialiseRun` over synthetic fixture bytes, and every lifecycle state is
 * reached through the accepted T1 seams. Nothing is faked: a refusal is proven
 * by observing that no byte appeared at the destination and that the old
 * container's bytes hash identically before and after the attempt. Dependencies
 * are `none` or a synthetic `prepared` cache only — no real install is run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {freezeRun,verifyFrozenSubmission,reconcileFreeze,FREEZE_PROOF_KIND} from '../../packages/core/freeze.mjs';

import {
  RESET_ERROR_CODES,
  RESET_ELIGIBLE_STATES,
  ResetError,
  resetRun,
} from '../../packages/core/reset.mjs';
import { initialiseRun, INIT_STATE_KIND, RUN_STATE_RELATIVE_PATH, STATE_DIRECTORY_NAME, WORKSPACE_DIRECTORY_NAME } from '../../packages/core/init.mjs';
import { sha256, hashEntries } from '../../packages/core/identity.mjs';
import { validateRecord, computeTreeDigest } from '../../packages/core/manifest.mjs';
import { EXPECTED_WORKLOAD_FILE_COUNT } from '../../packages/core/challenge-export.mjs';
import { loadFixture } from '../contracts/fixtures/contracts/index.mjs';
import {
  LIFECYCLE_JOURNAL_DIRECTORY,
  LIFECYCLE_STATE_RELATIVE_PATH,
  withRunTransaction,
  startRun,
  stopRun,
  readRunLifecycle,
} from '../../packages/core/lifecycle.mjs';
// FROZEN fixtures use only released T1 seams; T3 may be actively edited.
import { createStorage } from '../../packages/core/storage.mjs';

/* ----------------------------------------------------------------- constants */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STARTER_ROOT = path.join(REPO_ROOT, 'starter');
const RELEASE_INVENTORY_PATH = path.join(REPO_ROOT, 'release', 'inventory.json');
const HEX64 = /^[0-9a-f]{64}$/;
const RAW_COMPARE = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** Read the accepted participant inventory as raw data, importing nothing legacy. */
function releaseParticipantPaths() {
  const inventory = JSON.parse(fs.readFileSync(RELEASE_INVENTORY_PATH, 'utf8'));
  return Object.freeze(inventory.participant.files.map((entry) => entry.path));
}

/**
 * Scratch root: an explicit absolute override when the harness supplies one,
 * else a directory inside this repository. The read-only starter tree must never
 * be entered as scratch, so an override containing it is refused outright.
 */
function scratchRoot() {
  const names = ['BENCH' + 'BOARD_TEST_TMP', 'BENCH' + 'BOARD_TEST_SCRATCH_ROOT'];
  for (const name of names) {
    const value = process.env[name];
    if (value === void 0 || value.length === 0) continue;
    if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute directory, got ${JSON.stringify(value)}`);
    fs.mkdirSync(value, { recursive: true });
    const resolved = path.resolve(value);
    const starter = path.resolve(STARTER_ROOT);
    if (starter === resolved || starter.startsWith(resolved + path.sep)) {
      throw new Error(`${name} must not contain the read-only starter tree at ${starter}`);
    }
    return resolved;
  }
  const contained = fileURLToPath(new URL('./.tmp/reset/', import.meta.url));
  fs.mkdirSync(contained, { recursive: true });
  return contained;
}

/** One throwaway directory per test, removed when that test finishes. */
function scratch(t, name) {
  const directory = fs.mkdtempSync(path.join(scratchRoot(), `c3-t3-${name}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/* ------------------------------------------------------------------- helpers */

/** Byte-for-byte copy, so fixture bytes can never be re-encoded. */
function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fs.readFileSync(source));
}

const segments = (relativePath) => relativePath.split('/');
const starterPath = (relativePath) => path.join(STARTER_ROOT, ...segments(relativePath));
const inRoot = (root, relativePath) => path.join(root, ...segments(relativePath));

function rootEntry(root, relativePath) {
  return Object.freeze([relativePath, sha256(fs.readFileSync(inRoot(root, relativePath)))]);
}

/**
 * A real ChallengeIdentity over the bytes actually copied into the fixture
 * source root: the inventory is the exact sorted `[path, sha256]` list and the
 * workload digest is recomputed with the accepted helper, so the shipped
 * contract validator re-derives the recorded value.
 */
function buildIdentity(sourceRoot, paths) {
  const starterInventory = paths
    .map((relativePath) => rootEntry(sourceRoot, relativePath))
    .sort((left, right) => RAW_COMPARE(left[0], right[0]));
  return Object.freeze({
    schemaVersion: '1.0.0',
    kind: 'ChallengeIdentity',
    challengeId: 'c3-t3-fixture-board',
    challengeVersion: '0.9.0',
    architectureId: 'arch-c3-t3-fixture',
    architectureKind: 'challenge',
    hashAlgorithm: 'sha256',
    definitionDigest: sha256('c3-t3-fixture:definition'),
    digestProvenance: Object.freeze({ kind: 'COMPUTED', procedure: 'c3-t3-fixture:sha256:source-bytes' }),
    workloadProvenance: Object.freeze({ kind: 'COMPUTED', procedure: 'c3-t3-fixture:starter-inventory-digest' }),
    publicPrdDigest: sha256('c3-t3-fixture:public-prd'),
    visibleHarnessDigest: sha256('c3-t3-fixture:visible-harness'),
    fixtureDigest: sha256('c3-t3-fixture:fixture'),
    starterInventory: Object.freeze(starterInventory),
    workloadDigest: hashEntries(starterInventory),
    declaredCeilingMinutes: 120,
    candidateLineage: Object.freeze({
      candidateVersion: '1.0.0-candidate.9',
      candidateStatus: 'REVIEW_FINDINGS_UNRESOLVED',
      sourceCommit: 'c662a4a1b2c3d4e5f60718293a4b5c6d7e8f90a1',
      sourceTag: 'candidate-nine-synthetic',
      reviewStatus: 'CHANGES_REQUESTED',
      lineageNotes: 'Synthetic lineage carried by the focused fixture, not a certified release.',
    }),
    notes: 'C3 T4 focused fixture identity, derived from the read-only starter bytes.',
  });
}

/** The two non-challenge identities, taken from the accepted contract fixtures. */
function boundIdentities() {
  const toolingIdentity = structuredClone(loadFixture('tooling.identity'));
  const evaluatorIdentity = structuredClone(loadFixture('evaluator.identity'));
  assert.deepEqual(structuredClone(validateRecord('ToolingIdentity', toolingIdentity)), toolingIdentity,
    'the tooling fixture must satisfy the shipped contract validator before it is used');
  assert.deepEqual(structuredClone(validateRecord('EvaluatorIdentity', evaluatorIdentity)), evaluatorIdentity,
    'the evaluator fixture must satisfy the shipped contract validator before it is used');
  return { toolingIdentity, evaluatorIdentity };
}

/**
 * One fixture: contained roots, a seeded source root carrying the accepted
 * starter bytes, populated private owner and evaluator roots, and an identity
 * derived over exactly those bytes. The reset target parent exists; a target
 * never does.
 */
function buildFixture(t, name) {
  const paths = releaseParticipantPaths();
  const root = scratch(t, name);
  const sourceRoot = path.join(root, 'source');
  const ownerRoot = path.join(root, 'owner');
  const evaluatorRoot = path.join(root, 'evaluator');
  const publishParent = path.join(root, 'publish');
  fs.mkdirSync(ownerRoot, { recursive: true });
  fs.writeFileSync(path.join(ownerRoot, 'owner-secret.txt'), 'owner-private-material\n', 'utf8');
  fs.mkdirSync(evaluatorRoot, { recursive: true });
  fs.writeFileSync(path.join(evaluatorRoot, 'hidden-tests.txt'), 'hidden-evaluator-material\n', 'utf8');
  fs.mkdirSync(publishParent, { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  for (const relativePath of paths) copyFile(starterPath(relativePath), inRoot(sourceRoot, relativePath));

  const identity = buildIdentity(sourceRoot, paths);
  assert.deepEqual(validateRecord('ChallengeIdentity', structuredClone(identity)), structuredClone(identity),
    'the fixture identity must satisfy the shipped contract validator before it is used');
  const { toolingIdentity, evaluatorIdentity } = boundIdentities();
  return { root, paths, identity, sourceRoot, ownerRoot, evaluatorRoot, publishParent, toolingIdentity, evaluatorIdentity };
}

/** One accepted C2 challenge package for a fixture. */
function packageFor(fixture, overrides = {}) {
  const pick = (key, fallback) => (key in overrides ? overrides[key] : fallback);
  return {
    identity: pick('identity', fixture.identity),
    sourceRoot: pick('sourceRoot', fixture.sourceRoot),
    fileManifest: pick('fileManifest', [...fixture.paths]),
    ownerRoots: pick('ownerRoots', [fixture.ownerRoot]),
    evaluatorRoots: pick('evaluatorRoots', [fixture.evaluatorRoot]),
  };
}

/**
 * One accepted C2 initialisation request. Every field the API requires is stated
 * here so a test that changes one field changes only that field; the module
 * under test infers nothing from the machine it runs on.
 */
function initRequest(fixture, overrides = {}) {
  const pick = (key, fallback) => (key in overrides ? overrides[key] : fallback);
  return {
    output: pick('output', path.join(fixture.publishParent, 'run-one')),
    challenge: pick('challenge', packageFor(fixture)),
    dependencies: pick('dependencies', { mode: 'none' }),
    toolingIdentity: pick('toolingIdentity', fixture.toolingIdentity),
    evaluatorIdentity: pick('evaluatorIdentity', fixture.evaluatorIdentity),
    architectureId: pick('architectureId', 'arch-run-c3-t4'),
    /* The lifecycle seam only permits a manual start on a run that declares the
     * manual harness, and the ceiling must sit under the fixture challenge's. */
    harness: pick('harness', 'manual'),
    declaredCeilingMinutes: pick('declaredCeilingMinutes', 60),
    createdAt: pick('createdAt', '2026-04-01T09:00:00.000Z'),
  };
}

/**
 * The reset request for one published container: the same identities and the
 * same challenge package the old run bound, aimed at a fresh destination. `runRoot`
 * is the old container root — the directory holding `workspace/` and
 * `.benchboard/` — and the fresh ids are never named here, because the accepted
 * initialiser generates them.
 */
function resetRequest(published, fixture, overrides = {}) {
  const pick = (key, fallback) => (key in overrides ? overrides[key] : fallback);
  return {
    runRoot: pick('runRoot', published.output),
    manifestId: pick('manifestId', published.manifest.manifestId),
    runId: pick('runId', published.manifest.runId),
    output: pick('output', path.join(fixture.publishParent, 'reset-one')),
    initializationRequest: pick('initializationRequest', {
      challenge: pick('challenge', packageFor(fixture)),
      dependencies: pick('dependencies', { mode: 'none' }),
      toolingIdentity: pick('toolingIdentity', fixture.toolingIdentity),
      evaluatorIdentity: pick('evaluatorIdentity', fixture.evaluatorIdentity),
      architectureId: pick('architectureId', 'arch-run-c3-t4'),
      harness: pick('harness', 'manual'),
      declaredCeilingMinutes: pick('declaredCeilingMinutes', 60),
      createdAt: pick('createdAt', '2026-04-01T10:00:00.000Z'),
      ...(pick('requestExtra', void 0) ?? {}),
    }),
    ...(pick('restExtra', void 0) ?? {}),
  };
}

/** Recursive, deterministic snapshot of one tree, keyed by relative POSIX path. */
function snapshotTree(root) {
  const seen = new Map();
  const walk = (absolute, relative) => {
    const status = fs.lstatSync(absolute);
    if (status.isSymbolicLink()) {
      seen.set(relative, 'link');
      return;
    }
    if (status.isDirectory()) {
      if (relative !== '') seen.set(relative, 'directory');
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort(RAW_COMPARE)) {
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        walk(path.join(absolute, entry.name), child);
      }
      return;
    }
    seen.set(relative, status.isFile() ? `file:${sha256(fs.readFileSync(absolute))}` : 'special');
  };
  walk(root, '');
  return Object.fromEntries([...seen.entries()].sort((left, right) => RAW_COMPARE(left[0], right[0])));
}

/** The entries added to a snapshot, or removed from it. */
function addedEntries(before, after) {
  return Object.keys(after).filter((key) => !(key in before)).sort(RAW_COMPARE);
}
function removedEntries(before, after) {
  return Object.keys(before).filter((key) => !(key in after)).sort(RAW_COMPARE);
}

/** Capture a rejection, or undefined when the promise resolves. */
async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return void 0;
}

/** Assert one fail-closed refusal carrying the expected reset code, spelled first. */
async function expectCode(promise, code, label) {
  const error = await rejection(promise);
  assert.ok(error !== void 0, `${label}: a rejection was expected`);
  assert.ok(error instanceof ResetError, `${label}: a ResetError was expected, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, `${label}: error code (${error.message})`);
  assert.match(error.message, new RegExp(`^${code}: `), `${label}: the message names the code first`);
  return error;
}

/** The immutable declaration a manual run states. */
function declaration(overrides = {}) {
  return {
    harness: 'manual',
    model: null,
    workerCount: 2,
    executionMode: 'MANUAL',
    declaredCeilingMinutes: 60,
    ...overrides,
  };
}

/** The attestation a stop requires. */
function attestation(overrides = {}) {
  return {
    operator: 'operator-one',
    agentStopped: true,
    statement: 'the cooperating participants stopped of their own cooperation',
    ...overrides,
  };
}

/** A deterministic clock; `null` states that the wall clock is unknown. */
function clockAt(value) {
  return { now: () => value };
}

/* =========================================================================== */
/* The first proof: a derived INITIALIZED reset, and refusal before any write   */
/* =========================================================================== */


async function frozenFixture(t,name,{clockless=false,unknown=false,clocklessAttestation={},hooks}={}){
 const f=buildFixture(t,name);const old=await initialiseRun(initRequest(f));const request={runRoot:old.output,manifestId:old.manifest.manifestId,runId:old.manifest.runId};
 let statement={...attestation(),...clocklessAttestation,clockless:true};
 if(!clockless){await startRun({...request,declaration:declaration(),clock:unknown?{now:()=>null}:clockAt('2026-04-01T09:05:00.000Z')});const stopped=await stopRun({...request,attestation:attestation(),clock:unknown?{now:()=>null}:clockAt('2026-04-01T09:20:00.000Z')});statement=stopped.lifecycle.stopAttestation;}
 const frozen=await freezeRun({...request,clockless,attestation:statement,hooks});return{f,old,request,frozen};
}
test('stopped freeze publishes immutable C1 submission plus proof and re-verifies',async t=>{
 const{request,frozen}=await frozenFixture(t,'stopped');assert.equal(frozen.state,'FROZEN');assert.equal(frozen.frozenSubmission.fileCount,26);assert.equal(frozen.enforced,false);
 const check=await verifyFrozenSubmission({...request,snapshotId:frozen.snapshotId});assert.equal(check.ok,true,JSON.stringify(check));assert.equal(check.workspace.matchesFrozenInventory,true);
 const view=await readRunLifecycle(request);assert.equal(view.state,'FROZEN');assert.equal(view.journal.events.at(-1).detail.stateEventDigest,view.lifecycle.stateDigest);
});
test('clockless freeze never invents start or elapsed time',async t=>{
 const{request,frozen}=await frozenFixture(t,'clockless',{clockless:true});assert.equal(frozen.proof.timeProvenance.startedAt,null);assert.equal(frozen.proof.timeProvenance.elapsedMs,null);
 /* The clockless route states where its publication instant came from, and the
  * guide says which two sources are allowed here. Without a stated observation the
  * reading of the clock in force is used and must say so. */
 assert.equal(frozen.proof.frozenAtProvenance,'clock.reading');assert.equal(frozen.frozenSubmission.frozenAt,frozen.proof.frozenAt);assert.equal(frozen.frozenAtProvenance,'clock.reading');
 const view=await readRunLifecycle(request);assert.deepEqual(view.journal.events.map(e=>e.kind),['FREEZE_INTENT','FREEZE_COMMIT']);assert.equal((await verifyFrozenSubmission(request)).ok,true);
 /* With a stated observation that observation is the source, and it is the instant
  * both the submission and the proof publish. */
 const stated=await frozenFixture(t,'clockless-observed',{clockless:true,clocklessAttestation:{observedAt:'2026-04-01T11:22:33.000Z'}});assert.equal(stated.frozen.proof.frozenAtProvenance,'attestation.observedAt');assert.equal(stated.frozen.proof.frozenAt,'2026-04-01T11:22:33.000Z');assert.equal(stated.frozen.frozenSubmission.frozenAt,'2026-04-01T11:22:33.000Z');assert.equal(stated.frozen.proof.timeProvenance.startedAt,null);assert.equal(stated.frozen.proof.timeProvenance.elapsedMs,null);
});
test('unknown start-stop clock remains null while freeze publication time is observed',async t=>{
 const{frozen}=await frozenFixture(t,'unknown',{unknown:true});assert.equal(frozen.proof.timeProvenance.startedAt,null);assert.equal(frozen.proof.timeProvenance.stoppedAt,null);assert.equal(frozen.proof.timeProvenance.elapsedMs,null);assert.ok(frozen.frozenSubmission.frozenAt);
});
for(const scenario of ['active','no-clockless','wrong-id','torn-stop','pending-freeze','foreign-journal','linked-snapshots']){
 test(`freeze refuses ${scenario} and preserves preexisting bytes`,async t=>{
 const f=buildFixture(t,scenario),old=await initialiseRun(initRequest(f));const req={runRoot:old.output,manifestId:old.manifest.manifestId,runId:old.manifest.runId,attestation:{...attestation(),clockless:true},clockless:true};
 if(['active','torn-stop','pending-freeze'].includes(scenario)){await startRun({...req,declaration:declaration()});req.clockless=false;delete req.attestation.clockless;}
 if(scenario==='torn-stop')await withRunTransaction(req,async c=>{await c.appendEvent({kind:'STOP_RECORDED',declaration:declaration(),occurredAt:null,detail:{...attestation(),observedAt:null,assurance:'operator-attested',enforced:false}});});
 /* The half-finished freeze is staged by hand-appending its authority, so the
  * entry has to be the complete authority the released contract describes: the
  * attested operator statement with the witnessed instant stated explicitly and
  * null because this clock states none, the two assurances that qualify it, and
  * `clockless` stated as the boolean it is — false on this route, because this
  * run carries a journaled stop rather than the claim that nothing ran. An entry
  * that states none of that is not an authority at all, and a release that
  * validates the entries it writes refuses to append one. */
 if(scenario==='pending-freeze'){await stopRun({...req,attestation:attestation()});await withRunTransaction(req,async c=>{await c.appendEvent({kind:'FREEZE_INTENT',occurredAt:null,detail:{...attestation(),observedAt:null,assurance:'operator-attested',enforced:false,clockless:false}});});}
 if(scenario==='no-clockless'){req.clockless=false;delete req.attestation.clockless;}
 if(scenario==='wrong-id')req.runId='foreign-run';
 if(scenario==='foreign-journal'){const p=path.join(old.manifest.evidenceRoot,LIFECYCLE_JOURNAL_DIRECTORY);fs.mkdirSync(p,{recursive:true});fs.writeFileSync(path.join(p,'foreign'),'foreign');}
 if(scenario==='linked-snapshots'){const target=path.join(f.root,'foreign-snapshot-root');fs.mkdirSync(target);fs.symlinkSync(target,path.join(old.output,'snapshots'),process.platform==='win32'?'junction':'dir');}
 const before=snapshotTree(old.output);assert.ok(await rejection(freezeRun(req)));assert.deepEqual(snapshotTree(old.output),before);
 });
}
for(const scenario of ['same-size-tamper','extra-file','extra-empty-dir','deleted-file','linked-file','live-edit','corrupt-record']){
 test(`saved submission verification handles ${scenario}`,async t=>{
 const{request,frozen}=await frozenFixture(t,scenario);const file=path.join(frozen.snapshotRoot,'package.json');
 if(scenario==='same-size-tamper'){const data=fs.readFileSync(file);data[0]^=1;fs.writeFileSync(file,data);}
 if(scenario==='extra-file')fs.writeFileSync(path.join(frozen.snapshotRoot,'foreign'),'foreign');
 if(scenario==='extra-empty-dir')fs.mkdirSync(path.join(frozen.snapshotRoot,'empty-foreign'));
 if(scenario==='deleted-file')fs.rmSync(file);
 if(scenario==='linked-file'){const directory=path.join(frozen.snapshotRoot,'src');fs.renameSync(directory,directory+'-saved');fs.symlinkSync(directory+'-saved',directory,process.platform==='win32'?'junction':'dir');}
 if(scenario==='live-edit')fs.writeFileSync(path.join(request.runRoot,'workspace','package.json'),'changed live bytes');
 if(scenario==='corrupt-record')fs.writeFileSync(path.join(request.runRoot,'.benchboard','freeze',frozen.snapshotId+'.json'),'corrupt');
 const check=await verifyFrozenSubmission(request);assert.equal(check.ok,scenario==='live-edit',JSON.stringify(check));if(scenario==='live-edit')assert.equal(check.workspace.matchesFrozenInventory,false);
 });
}
test('failed copy retains explicit intent and foreign bytes, and ordinary retry refuses',async t=>{
 const f=buildFixture(t,'copy-fail'),old=await initialiseRun(initRequest(f));const req={runRoot:old.output,manifestId:old.manifest.manifestId,runId:old.manifest.runId,clockless:true,attestation:{...attestation(),clockless:true}};
 let output;const error=await rejection(freezeRun({...req,hooks:[()=>{const p=path.join(old.output,'snapshots');const id=fs.readdirSync(p)[0];output=path.join(p,id,'workspace');fs.writeFileSync(path.join(output,'foreign'),'foreign');throw new Error('fault');}]}));
 assert.ok(error.details.freezeFate.intentJournaled);assert.equal(error.details.freezeFate.freezeCommitted,false);assert.equal(fs.readFileSync(path.join(output,'foreign'),'utf8'),'foreign');assert.equal((await readRunLifecycle(req)).diagnosis,'incomplete');assert.ok(await rejection(freezeRun(req)));
});
test('repeat and concurrent freeze cannot publish a second saved identity',async t=>{
 const{request,frozen}=await frozenFixture(t,'repeat');const before=snapshotTree(request.runRoot);assert.ok(await rejection(freezeRun({...request,attestation:frozen.proof.freezeAttestation})));assert.deepEqual(snapshotTree(request.runRoot),before);
 const f=buildFixture(t,'concurrent'),old=await initialiseRun(initRequest(f));const req={runRoot:old.output,manifestId:old.manifest.manifestId,runId:old.manifest.runId,clockless:true,attestation:{...attestation(),clockless:true}};
 const results=await Promise.allSettled([freezeRun(req),freezeRun(req)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
});

for(const phase of ['submission-published','proof-published','state-projected','committed'])test(`fault at ${phase} discloses actual retained publication fate`,async t=>{
 const f=buildFixture(t,phase),old=await initialiseRun(initRequest(f));const req={runRoot:old.output,manifestId:old.manifest.manifestId,runId:old.manifest.runId,clockless:true,attestation:{...attestation(),clockless:true}};
 const error=await rejection(freezeRun({...req,publicationHook:(at)=>{if(at===phase)throw new Error('publication fault');}}));assert.ok(error.details.freezeFate.intentJournaled);assert.equal(error.details.freezeFate.freezeCommitted,phase==='committed');
 assert.equal(error.details.freezeFate.stateRecordState,['state-projected','committed'].includes(phase)?'FROZEN':'INITIALIZED');assert.ok(error.details.freezeFate.submissionPublished);if(phase!=='submission-published')assert.ok(error.details.freezeFate.proofPublished);
 if(phase==='committed')assert.equal((await verifyFrozenSubmission({runRoot:req.runRoot,manifestId:req.manifestId,runId:req.runId})).ok,true,'actual retained committed publication verifies despite reported hookfault');else assert.ok(await rejection(freezeRun(req)),'incomplete ordinary retry refuses');
});
test('late publication mutation cannot hide behind an earlier copy verification',async t=>{
 const f=buildFixture(t,'late-source'),old=await initialiseRun(initRequest(f));const req={runRoot:old.output,manifestId:old.manifest.manifestId,runId:old.manifest.runId,clockless:true,attestation:{...attestation(),clockless:true}};
 const error=await rejection(freezeRun({...req,publicationHook:at=>{if(at==='proof-published')fs.writeFileSync(path.join(old.output,'workspace','package.json'),'late source mutation');}}));assert.ok(error.details.freezeFate);assert.equal(error.details.freezeFate.freezeCommitted,false);
});
/**
 * The strict TypeScript consumer that proves the published declarations cover
 * the released surface: it binds `freezeRun`, `verifyFrozenSubmission` and
 * `reconcileFreeze` to their declared types and reads every returned field,
 * narrowing the proof through its route so the fields one route does not carry
 * cannot be read as if they were there. `@MODULE@` is replaced with the module
 * specifier before the file is written.
 */
const PROOF_TYPE_CONSUMER = String.raw`import {freezeRun, verifyFrozenSubmission, reconcileFreeze, type FreezeRequest, type FreezeResult, type VerifyFrozenRequest, type VerifyFrozenResult, type ReconcileFreezeRequest, type ReconcileFreezeResult} from @MODULE@;

declare const request: FreezeRequest;
declare const verifyRequest: VerifyFrozenRequest;
declare const reconcileRequest: ReconcileFreezeRequest;

const command: (r: FreezeRequest) => Promise<FreezeResult> = freezeRun;
const inspection: (r: VerifyFrozenRequest) => Promise<VerifyFrozenResult> = verifyFrozenSubmission;
const repair: (r: ReconcileFreezeRequest) => Promise<ReconcileFreezeResult> = reconcileFreeze;

async function readEveryResultField(): Promise<readonly string[]> {
  const frozen: FreezeResult = await command(request);
  const reported: string[] = [
    frozen.module, frozen.runId, frozen.manifestId, frozen.state, frozen.route,
    frozen.snapshotId, frozen.snapshotContainer, frozen.snapshotRoot,
    frozen.submissionDigest, frozen.frozenAt, frozen.frozenAtProvenance,
    frozen.stopAssurance ?? 'no stop assurance', frozen.enforced === false ? 'not enforced' : 'enforced',
    frozen.stateDigest, frozen.events.join(','),
    String(frozen.freeze.intentSequence) + ':' + String(frozen.freeze.commitSequence),
    frozen.frozenSubmission.schemaVersion, frozen.frozenSubmission.kind,
    frozen.frozenSubmission.frozenSubmissionId, frozen.frozenSubmission.manifestId,
    frozen.frozenSubmission.runId, frozen.frozenSubmission.frozenAt,
    frozen.frozenSubmission.hashAlgorithm, frozen.frozenSubmission.treeDigest,
    String(frozen.frozenSubmission.byteCount), String(frozen.frozenSubmission.fileCount),
    frozen.frozenSubmission.freezeProcedure, frozen.frozenSubmission.notes ?? 'no notes',
    ...frozen.frozenSubmission.inventory.map(pair => pair[0] + '=' + pair[1]),
    frozen.proof.schemaVersion, frozen.proof.kind, frozen.proof.module,
    frozen.proof.proofId, frozen.proof.snapshotId, frozen.proof.snapshotContainer,
    frozen.proof.workspaceSubdirectoryName, frozen.proof.snapshotRoot,
    frozen.proof.manifestId, frozen.proof.runId, frozen.proof.frozenSubmissionId,
    frozen.proof.submissionDigest, frozen.proof.selectionPolicyId,
    frozen.proof.hashAlgorithmId, frozen.proof.hashAlgorithm, frozen.proof.freezeRoute,
    frozen.proof.frozenAt, frozen.proof.frozenAtProvenance,
    frozen.proof.freezeIntentSequence.toFixed(0), frozen.proof.freezeIntentDigest,
    frozen.proof.selectionExclusions.join(','),
    frozen.proof.inventory.map(file => file.path + ':' + String(file.bytes) + ':' + file.sha256).join('|'),
    frozen.proof.directories.join(','), String(frozen.proof.fileCount),
    String(frozen.proof.byteCount), String(frozen.proof.directoryCount), frozen.proof.treeDigest,
    frozen.proof.timeProvenance.clockWasUnavailable === true ? 'no clock' : 'clock',
    frozen.proof.timeProvenance.clockError === null ? 'no clock error' : 'clock error',
    frozen.proof.freezeAttestation.operator, frozen.proof.freezeAttestation.statement,
    frozen.proof.freezeAttestation.agentStopped === true ? 'stopped' : 'not stopped',
    frozen.proof.freezeAttestation.observedAt ?? 'no observed instant',
  ];
  /* The route decides which stop facts exist. Reading a stop attestation off the
   * route that carries none is a compile error; reading one off the route that
   * carries one narrows to a record rather than to a nullable value. */
  if (frozen.proof.freezeRoute === 'STOP_RECORDED') {
    reported.push(frozen.proof.stopAssurance, frozen.proof.stopAttestation.operator, frozen.proof.stopAttestation.statement, frozen.proof.stopAttestation.agentStopped === true ? 'attested' : 'not attested');
    reported.push(frozen.proof.timeProvenance.startedAt ?? 'no start', frozen.proof.timeProvenance.stoppedAt ?? 'no stop', frozen.proof.timeProvenance.elapsedMs === null ? 'no elapsed span' : frozen.proof.timeProvenance.elapsedMs.toFixed(0));
  } else {
    reported.push(String(frozen.proof.stopAssurance), String(frozen.proof.stopAttestation), String(frozen.proof.freezeAttestation.clockless));
    reported.push(String(frozen.proof.timeProvenance.startedAt), String(frozen.proof.timeProvenance.stoppedAt), String(frozen.proof.timeProvenance.elapsedMs), String(frozen.proof.timeProvenance.clockError), String(frozen.proof.timeProvenance.clockWasUnavailable));
  }
  return reported;
}

async function readEveryVerificationField(): Promise<readonly string[]> {
  const checked: VerifyFrozenResult = await inspection(verifyRequest);
  const reported: string[] = [
    checked.module, checked.runId, checked.manifestId, checked.state,
    checked.ok === true ? 'verified' : 'not verified',
    checked.findings.join('|'), checked.runFindings.join('|'),
  ];
  for (const entry of checked.submissions) {
    reported.push(entry.frozenSubmissionId, entry.snapshotId, entry.snapshotRoot, entry.treeDigest,
      String(entry.fileCount), String(entry.byteCount), entry.frozenAt,
      entry.ok === true ? 'ok' : 'not ok', entry.findings.join('|'));
  }
  if (checked.workspace !== null) {
    reported.push(String(checked.workspace.observedFileCount), String(checked.workspace.observedByteCount), String(checked.workspace.matchesFrozenInventory), checked.workspace.note);
  }
  return reported;
}

async function readEveryReconciliationField(): Promise<readonly string[]> {
  const outcome: ReconcileFreezeResult = await repair(reconcileRequest);
  if (outcome.decision === 'KEEP_INTERRUPTED') {
    return [outcome.decision, outcome.operator, outcome.intentDigest, outcome.state, String(outcome.repaired), String(outcome.retained), outcome.findings.join('|')];
  }
  return [outcome.decision, outcome.operator, outcome.intentDigest, outcome.state, outcome.snapshotId, String(outcome.repaired), String(outcome.retained)];
}

export const readAll: () => Promise<readonly string[]> = async () => [...await readEveryResultField(), ...await readEveryVerificationField(), ...await readEveryReconciliationField()];
`;

/**
 * C3-R1-004: the published proof contract and the published declarations.
 *
 * Two independent things are proven here, and neither one restates the
 * producer's own check. First, the published JSON Schema is compiled by Ajv in
 * strict mode and applied to a proof a real freeze produced: that proof has to
 * pass, and a table of malformed contracts — a foreign module identity, a
 * foreign selection policy, a differently shaped snapshot identity, a relative
 * snapshot location, a backslash-separated or drive-qualified inventory path, an
 * exclusion the accepted policy does not define, and every way the two freeze
 * routes can be stated with the other route's fields — has to fail. A generic
 * string type that would accept all of those is the defect this closes.
 * Second, the published declarations are consumed by a strict TypeScript file
 * that reads every field the released functions hand back, including the
 * route-dependent proof fields, so a declaration that omits a returned field (or
 * states a shape the run does not produce) is a compile error rather than a
 * surprise in a later consumer. The `.d.ts` and `.d.mts` copies are byte-equal.
 */
test('frozen proof follows published schema and declarations resolve through shipped mjs',async t=>{
  const{frozen}=await frozenFixture(t,'proof-schema');const{request,frozen:clocklessFrozen}=await frozenFixture(t,'proof-schema-clockless',{clockless:true});const root=scratch(t,'proof-types');const schema=JSON.parse(fs.readFileSync(path.join(REPO_ROOT,'schemas/snapshot-proof.schema.json'),'utf8'));
  assert.equal(schema.additionalProperties,false);assert.deepEqual(Object.keys(frozen.proof).sort(),schema.required.slice().sort());
  const Ajv=(await import(new URL('../../node_modules/ajv/dist/2020.js',import.meta.url))).default;const ajv=new Ajv({strict:true});const validator=ajv.compile(schema);assert.equal(validator(frozen.proof),true,JSON.stringify(validator.errors));assert.equal(frozen.proof.freezeRoute,'STOP_RECORDED');assert.equal(validator(clocklessFrozen.proof),true,JSON.stringify(validator.errors),'a clockless route proof is inside the published contract as well');assert.equal(clocklessFrozen.proof.freezeRoute,'CLOCKLESS_INITIALIZED');
  assert.equal(validator({...frozen.proof,privateExtra:true}),false,'an undeclared proof field is outside the published contract');
  /* Each of these stays structurally a proof: a consumer that trusts a generic
   * string would accept every one of them, so the contract itself has to refuse
   * each one. */
  const malformed=[
    ['a proof from another module',proof=>{proof.module='benchboard-core-freeze-v2';}],
    ['a proof of another kind',proof=>{proof.kind='benchboard.freeze.snapshot-proof.v2';}],
    ['a proof under another schema version',proof=>{proof.schemaVersion='1.1.0';}],
    ['a proof bound to an unaccepted selection policy',proof=>{proof.selectionPolicyId='benchboard-whole-tree-v1';}],
    ['a proof bound to an unaccepted hash algorithm identity',proof=>{proof.hashAlgorithmId='benchboard-md5-tree-v1';}],
    ['a proof bound to an unaccepted hash algorithm',proof=>{proof.hashAlgorithm='md5';}],
    ['a proof naming an unaccepted workspace subdirectory',proof=>{proof.workspaceSubdirectoryName='work';}],
    ['a snapshot identity that is not the accepted form',proof=>{proof.snapshotId='snap-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';}],
    ['a proof identity that is not the snapshot identity with the proof suffix',proof=>{proof.proofId=proof.snapshotId;}],
    ['a submission identity that is not the accepted form',proof=>{proof.frozenSubmissionId='fsub-ABCDEFABCDEFABCDEFABCDEFABCDEF01';}],
    ['a submission digest that is not sixty-four hexadecimal characters',proof=>{proof.submissionDigest='0'.repeat(63);}],
    ['a tree digest that is not hexadecimal',proof=>{proof.treeDigest='z'.repeat(64);}],
    ['a freeze intent digest that is not a digest',proof=>{proof.freezeIntentDigest='intent-digest';}],
    ['a snapshot container stated as a relative location',proof=>{proof.snapshotContainer='snapshots/x';}],
    ['a snapshot location stated with a drive letter and no separator',proof=>{proof.snapshotRoot='C:snapshots/x/workspace';}],
    ['an inventory path separated by backslashes',proof=>{proof.inventory=[{...proof.inventory[0],path:'src\\util.mjs'},...proof.inventory.slice(1)];}],
    ['an inventory path stated as an absolute location',proof=>{proof.inventory=[{...proof.inventory[0],path:'/etc/passwd'},...proof.inventory.slice(1)];}],
    ['an inventory path qualified by a drive',proof=>{proof.inventory=[{...proof.inventory[0],path:'C:/Windows/system.ini'},...proof.inventory.slice(1)];}],
    ['a directory claim separated by backslashes',proof=>{proof.directories=[...proof.directories,'src\\util'];}],
    ['a directory claim stated as an absolute location',proof=>{proof.directories=[...proof.directories,'/usr/local'];}],
    ['an exclusion the accepted policy does not define',proof=>{proof.selectionExclusions=[...proof.selectionExclusions,'.private'];}],
    ['a frozen instant without a stated zone',proof=>{proof.frozenAt='2026-04-01T10:00:00';}],
    ['a frozen instant that is not an instant',proof=>{proof.frozenAt='sometime in april';}],
    ['a fractional file count',proof=>{proof.fileCount=proof.fileCount+0.5;}],
    ['a negative byte count',proof=>{proof.byteCount=-1;}]
  ];
  /* Each route has its own field set. These are the ways a record can name one
   * route while carrying the other route's facts. */
  const clocklessRouteViolations=[
    ['the clockless route stating a stop assurance',proof=>{proof.stopAssurance='operator-attested';}],
    ['the clockless route carrying a stop attestation',proof=>{proof.stopAttestation={...proof.freezeAttestation};}],
    ['the clockless route without its explicit clockless claim',proof=>{const{clockless:_omitted,...rest}=proof.freezeAttestation;proof.freezeAttestation=rest;}],
    ['the clockless route claiming a recorded stop instant as its frozen instant',proof=>{proof.frozenAtProvenance='lifecycle.stoppedAt';}],
    ['the clockless route stating a start instant it never had',proof=>{proof.timeProvenance={...proof.timeProvenance,startedAt:'2026-04-01T09:00:00.000Z'};}],
    ['the clockless route stating a clock error for a clock it never read',proof=>{proof.timeProvenance={...proof.timeProvenance,clockError:{code:'CLOCK_UNAVAILABLE'}};}],
    ['the clockless route stating an elapsed span for a span it never measured',proof=>{proof.timeProvenance={...proof.timeProvenance,elapsedMs:600000};}],
    ['the clockless route stating a clock it did have',proof=>{proof.timeProvenance={...proof.timeProvenance,clockWasUnavailable:true};}]
  ];
  const stoppedRouteViolations=[
    ['the stopped route stating no stop assurance',proof=>{proof.stopAssurance=null;}],
    ['the stopped route carrying no stop attestation',proof=>{proof.stopAttestation=null;}],
    ['the stopped route carrying the clockless claim',proof=>{proof.freezeAttestation={...proof.freezeAttestation,clockless:true};}],
    ['the stopped route whose frozen instant names no source',proof=>{proof.frozenAtProvenance='nothing.at.all';}]
  ];
  for(const[label,mutate]of malformed){const proof=structuredClone(frozen.proof);mutate(proof);assert.equal(validator(proof),false,`the published proof schema must refuse ${label}`);}
  /* The route conditionals are exercised from both sides: a proof of the clockless
   * route that states the other route's stop facts must fail, and so must a proof
   * of the stopped route that drops them. */
  for(const[label,mutate]of clocklessRouteViolations){const proof=structuredClone(clocklessFrozen.proof);assert.equal(validator(proof),true,`the published proof schema must accept a sound clockless proof: ${JSON.stringify(validator.errors)}`);mutate(proof);assert.equal(validator(proof),false,`the published proof schema must refuse ${label}`);}
  for(const[label,mutate]of stoppedRouteViolations){const proof=structuredClone(frozen.proof);assert.equal(validator(proof),true,`the published proof schema must accept a sound stopped proof: ${JSON.stringify(validator.errors)}`);mutate(proof);assert.equal(validator(proof),false,`the published proof schema must refuse ${label}`);}
  const consumer=path.join(root,'consumer.mts');let spec=path.relative(root,path.join(REPO_ROOT,'packages/core/freeze.mjs')).replaceAll('\\','/');if(!spec.startsWith('.'))spec='./'+spec;
  fs.writeFileSync(consumer,PROOF_TYPE_CONSUMER.replaceAll('@MODULE@',JSON.stringify(spec)));
  const result=spawnSync(process.execPath,[path.join(STARTER_ROOT,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--target','es2022','--module','nodenext','--moduleResolution','nodenext',consumer],{encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);
  /* The declarations are only proven complete when the consumer names every
   * field the released functions actually hand back: a field it does not mention
   * is a field no published declaration covers. */
  const source=fs.readFileSync(consumer,'utf8');const verify=await verifyFrozenSubmission(request);const entry=verify.submissions[0];
  const returned=new Set([...Object.keys(frozen),...Object.keys(frozen.proof),...Object.keys(frozen.frozenSubmission),...Object.keys(verify),...Object.keys(entry),...Object.keys(verify.workspace??{})]);
  for(const field of returned)assert.ok(source.includes(`.${field}`)||source.includes(JSON.stringify(field)),`the published declarations are read field by field, and ${JSON.stringify(field)} is not read`);
  assert.ok(source.includes('snapshotRoot')&&source.includes('treeDigest')&&source.includes('fileCount')&&source.includes('byteCount')&&source.includes('frozenAt'),'the snapshot location and byte facts a freeze returns are read through the published declarations');
  assert.deepEqual(fs.readFileSync(path.join(REPO_ROOT,'packages/core/freeze.d.ts')),fs.readFileSync(path.join(REPO_ROOT,'packages/core/freeze.d.mts')));
});


/**
 * A freeze interrupted after the proof was published: one bound retained
 * submission/proof pair with a journaled FREEZE_INTENT and no commit. This is the
 * real storage state reconciliation operates on (C3-R1-003).
 */
async function reconcileInterrupt(t, name) {
  const f = buildFixture(t, name);
  const old = await initialiseRun(initRequest(f));
  const req = { runRoot: old.output, manifestId: old.manifest.manifestId, runId: old.manifest.runId };
  const error = await rejection(freezeRun({
    ...req, clockless: true, attestation: { ...attestation(), clockless: true },
    publicationHook: (at) => { if (at === 'proof-published') throw new Error('publication fault'); },
  }));
  const intentDigest = error.details.freezeFate.intentEventDigest;
  assert.ok(intentDigest, 'the interrupted freeze reports its journaled intent digest');
  return { f, old, req, intentDigest, snapshotId: error.details.freezeFate.containerPath.split(path.sep).at(-1) };
}

/** Canonical JSON as the accepted storage envelope computes it (sorted keys). */
function envelopeCanonical(value) {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'number') return Object.is(value, -0) ? '0' : String(value);
  if (kind === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => envelopeCanonical(entry)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${envelopeCanonical(value[key])}`).join(',')}}`;
}

/**
 * Rewrite one record's stored value while keeping the accepted envelope valid
 * (correct identity and recomputed envelope digest), so a test tampers the
 * *contract content* rather than producing a byte-corrupt file the storage layer
 * itself would refuse. Returns nothing; the file is written in place.
 */
async function rewriteEnvelopeValue(root, relativePosixPath, key, mutate) {
  const target = path.join(root, ...relativePosixPath.split('/'));
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  const value = structuredClone(parsed.value);
  mutate(value);
  const canonical = `{"id":${JSON.stringify(key.id)},"kind":${JSON.stringify(key.kind)},"value":${envelopeCanonical(value)}}`;
  parsed.value = value;
  parsed.digest = sha256(canonical);
  fs.writeFileSync(target, JSON.stringify(parsed), 'utf8');
}

/** The proof key inside one run's state root. */
const proofKey = (manifestId, snapshotId) => ({
  relativePath: `freeze/${snapshotId}.json`,
  kind: FREEZE_PROOF_KIND,
  id: `${manifestId}:snapshot-proof:${snapshotId}`,
});

/** One corrupt-retained-proof reconciliation: it must refuse and write nothing. */
async function expectReconcileRefusal(t, name, label, tamperProof) {
  const ctx = await reconcileInterrupt(t, name);
  const { old, req, intentDigest, snapshotId } = ctx;
  if (tamperProof !== null) {
    await rewriteEnvelopeValue(path.join(old.output, STATE_DIRECTORY_NAME), `freeze/${snapshotId}.json`, proofKey(req.manifestId, snapshotId), tamperProof);
  }
  const before = snapshotTree(old.output);
  const error = await rejection(reconcileFreeze({ ...req, intentDigest, operator: 'test-operator', decision: 'COMPLETE' }));
  assert.ok(error !== void 0, `${label}: reconciliation of a corrupted retained proof must not complete`);
  assert.deepEqual(snapshotTree(old.output), before, `${label}: the refusal must change no byte of the run (no pre-refusal write)`);
  return error;
}

/* === C3-R1-003: reconciliation validates before it writes ================= */

test('reconcile COMPLETE refuses a journal that does not verify and writes nothing before refusing', async t => {
  const ctx = await reconcileInterrupt(t, 'reconcile-corrupt-journal');
  const { old, req, intentDigest } = ctx;
  const journalDir = path.join(old.output, STATE_DIRECTORY_NAME, ...LIFECYCLE_JOURNAL_DIRECTORY.split('/'));
  fs.writeFileSync(path.join(journalDir, 'foreign-note'), 'foreign');
  const before = snapshotTree(old.output);
  const kept = await reconcileFreeze({ ...req, intentDigest, operator: 'test-operator', decision: 'KEEP_INTERRUPTED' });
  assert.ok(kept.findings.length > 0, 'KEEP_INTERRUPTED reports the journal findings it found');
  const error = await rejection(reconcileFreeze({ ...req, intentDigest, operator: 'test-operator', decision: 'COMPLETE' }));
  assert.ok(error !== void 0, 'COMPLETE over an unverified journal must be refused before any write');
  assert.deepEqual(snapshotTree(old.output), before, 'no FROZEN projection may be written before the journal is proven verifiable');
});

for (const [name, label, tamper] of [
  ['reconcile-dir-claim', 'a proof whose directory claim is not the physical directory set of the snapshot', (proof) => { proof.directories = [...proof.directories, 'bogus-directory']; proof.directoryCount = proof.directories.length; }],
  ['reconcile-container-claim', 'a proof naming a snapshot container outside this run', (proof) => { proof.snapshotContainer = 'C:/outside/foreign-container'; }],
  ['reconcile-dropped-entry', 'a proof whose inventory omits a file the snapshot holds', (proof) => { proof.inventory = proof.inventory.slice(1); proof.fileCount = proof.inventory.length; proof.byteCount = proof.inventory.reduce((sum, file) => sum + file.bytes, 0); proof.treeDigest = computeTreeDigest(proof.inventory.map((file) => [file.path, file.sha256])); }],
]) test(`reconcile COMPLETE refuses ${label} and writes nothing before refusing`, async t => {
  await expectReconcileRefusal(t, name, label, tamper);
});

for(const phase of ['proof-published','state-projected'])test(`explicit reconciliation completes bound retained ${phase} publication without deleting anything`,async t=>{
 const f=buildFixture(t,'reconcile-'+phase),old=await initialiseRun(initRequest(f));const req={runRoot:old.output,manifestId:old.manifest.manifestId,runId:old.manifest.runId};
 const error=await rejection(freezeRun({...req,clockless:true,attestation:{...attestation(),clockless:true},publicationHook:at=>{if(at===phase)throw new Error('fault');}}));const intentDigest=error.details.freezeFate.intentEventDigest;
 const before=snapshotTree(path.join(old.output,'snapshots'));
 const kept=await reconcileFreeze({...req,intentDigest,operator:'test-operator',decision:'KEEP_INTERRUPTED'});assert.equal(kept.repaired,false);assert.deepEqual(snapshotTree(path.join(old.output,'snapshots')),before);
 const repaired=await reconcileFreeze({...req,intentDigest,operator:'test-operator',decision:'COMPLETE'});assert.equal(repaired.repaired,true);assert.equal((await verifyFrozenSubmission(req)).ok,true);assert.deepEqual(snapshotTree(path.join(old.output,'snapshots')),before);
});
