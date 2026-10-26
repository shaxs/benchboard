# Evaluation API

**Current S2 addition:** successful calls also return a validated `bundle`, including
the unchanged automated score at `bundle.score`. Infrastructure results have `bundle: null`;
the top-level `score` remains null for compatibility. See [EvidenceBundle](EVIDENCE_BUNDLE.md)
for its versioned contract, integrity failures and identity/digest fields. The limitations
below describe the retained stage-evidence layer and its boundaries, not the absence of this bundle.

This document describes the retained S1 stage-evidence layer of the current checkout:
the single supported entry point that verifies a frozen C3
submission, stages it into disposable scratch, runs the established evaluation
stages there, and returns stage evidence honestly — including the score-shaped
hole that is not yet filled. It is written against the accepted modules and
their paired type declarations, and it states plainly which product pieces are
not part of this stage. This is checkout documentation, **not** an approved
public release: no publication and no operating-system qualification is claimed
or implied anywhere in it.

This is **not** a product quickstart and **not** a command-line reference.
Nothing here names a command: there is no `benchboard evaluate` or any other
evaluation command (see
[What is not available at S1](#what-is-not-available-at-s1)).
The only way to use any of the below is to import the module from your own code.
Examples use synthetic placeholder paths only.

## Modules

| Module | Import specifier | Declarations | Role |
| --- | --- | --- | --- |
| Facade | `./packages/evaluation/evaluate-frozen.mjs` | `packages/evaluation/evaluate-frozen.d.mts` | The single supported public entry point: `evaluateFrozen`. |
| Contracts | `./packages/evaluation/contracts.mjs` | `packages/evaluation/contracts.d.mts` | Stage names, infrastructure codes, defaults, the two evaluation error classes and the shared worker-protocol seams. |
| Controller | `./packages/evaluation/controller.mjs` | (internal) | Runs the sequence over the declared stages. Internal; not a public option surface. |
| Staging | `./packages/evaluation/staging.mjs` | (internal) | Request validation, C3 re-verification, scratch staging, cleanup. Internal. |

All of them are ES modules. Their own direct imports are Node builtins, the
accepted core modules and the accepted evaluation modules only. The facade's
full transitive graph is wider than that and that is intended: when a stage's
worker child runs, it loads the **preserved evaluator semantic modules**
(the unchanged loopback server, browser property evaluator, cooperative
useful-tests module and public evidence inspector), the **pinned TypeScript,
Vite, Vitest and Playwright dependencies**, and those preserved modules in turn
use the **allowed `runner/files.mjs` path-and-hash utility**. What the graph
must and does not carry is governance: nothing on the facade's import path
loads the historical reporting (`evaluator/report.mjs`), supervision,
execution-authority, metrics-collection, telemetry or watchdog modules, and
nothing loads DSH; a DSH-free environment runs every core test unchanged. The
allowed-versus-prohibited line is therefore about *what may be used* (preserved
semantics, pinned tools, the path utility) versus *what may not* (supervision,
review packets, formal-comparability or any other governance authority), not a
claim that the whole graph is core-only.

## The honesty rule that runs through all of it

1. **Nothing is invented.** An unobserved fact is `null`, never `0` and never a
   guess. The S1 result's `score` is always `null` because no score is produced
   at S1 at all, and a Node run that leaves no valid normal-completion witness
   does not gain a synthesized signal or a reinterpreted exit code.
2. **An ordinary failing stage is not an infrastructure failure.** A typecheck or
   build that exits nonzero through a normal completion is *completed evidence*
   (`build: false`) inside a `status: 'success'` result; an aborted or
   unlaunchable run is the distinct infrastructure result. A failing stage never
   fabricates points, and an infrastructure failure never carries evidence.
3. **Input files are not written; output is separately retained.** An
   evaluation never writes to a submitted snapshot, a run container, or any
   protected folder: the input bytes it does not own remain untouched for as
   long as no one else changes them, which is exactly why the snapshot is
   re-verified from bytes at four points and a changed byte is *detected and
   refused* (`SNAPSHOT_REFUSED`) — never repaired, rolled back or overwritten.
   A concurrent writer can still move an input; the contract's promise is
   detection and refusal, not a guarantee that the world holds still. What the
   evaluation *does* write is its declared output: the exclusively new
   `outputRoot` holds per-stage logs, reports and bounded control metadata —
   outside the disposable scratch directory — and those retained outputs
   survive after the scratch is removed. Scratch material the operation cannot
   prove it created is likewise preserved and reported, never deleted.

## Public surface

The facade exports exactly one name: **`evaluateFrozen`**.

```js
import { evaluateFrozen } from './packages/evaluation/evaluate-frozen.mjs';

const result = await evaluateFrozen(request);
```

The internal controller and its runtime-object shape are a test seam held by the
maintainers, **not supported public API**. There is no public way to replace the
process runner, the preflight, the stage collaborators or the event observer: the
request option set below is closed, and an unknown option such as `runtime` is
refused with `EvaluationRefusalError` code `INVALID_ARGUMENT` before any
filesystem work happens.

### The request

```ts
type EvaluationRequest = {
  challenge: ChallengeIdentity;        // validated neutral contract record
  evaluator: EvaluatorIdentity;        // validated neutral contract record
  submission: {
    runRoot: string;                   // explicit canonical absolute path
    runId: string;
    manifestId: string;
    snapshotId: string;
    frozenSubmissionId: string;
    expectedDigest: string;            // 64 lowercase hex
  };
  outputRoot: string;                  // exclusively new; parent must exist
  environment?: { label?: string | null };  // bounded non-private label only
  timeoutMs?: number;                  // default 300000, range 1–3600000
  maxOutputBytes?: number;             // default 1048576, range 256–16777216
  signal?: AbortSignal;
};
```

Rules enforced at the boundary, before any byte is written:

- **Closed option set.** `challenge`, `evaluator`, `submission`, `outputRoot`,
  `environment`, `timeoutMs`, `maxOutputBytes`, `signal` — anything else is
  `INVALID_ARGUMENT`.
- **Identities are validated records**, and their recomputed identity digests
  must equal the digests sealed into the run manifest's bindings; a difference
  is `IDENTITY_MISMATCH`, not a warning.
- **`expectedDigest` is the sealed run-manifest digest, not the snapshot tree
  digest.** The field names state it: it is validated against the run container's
  manifest. Do not pass a submission `treeDigest` here.
- **`outputRoot` is exclusively new.** Its parent must be an existing ordinary
  (non-linked) directory chain, the leaf must not exist (`OUTPUT_EXISTS`), and
  the root must be disjoint from the repository *and* from the run container
  (`ROOTS_OVERLAP`). A linked or non-directory ancestor anywhere on either path
  is refused (`UNSAFE_PATH`).
- **`timeoutMs` and `maxOutputBytes`** must be safe integers inside the stated
  ranges (`INVALID_ARGUMENT` otherwise). These are the per-tool bounds; every
  tool run the evaluation makes is bounded by them.
- **`signal`**, when present, must be an `AbortSignal`.
- **`environment`** permits a bounded non-private `label` only; it never carries
  paths, endpoints or host facts into the result.

A synthetic request, with placeholder paths only:

```js
const request = {
  challenge,                                        // ChallengeIdentity record
  evaluator,                                        // EvaluatorIdentity record
  submission: {
    runRoot: '/example/run-container',              // absolute, existing C3 run
    runId: 'run-000001',
    manifestId: 'manifest-000001',
    snapshotId: 'snapshot-000001',
    frozenSubmissionId: 'submission-000001',
    expectedDigest: run.manifest.manifestDigest,    // the sealed manifest digest
  },
  outputRoot: '/example/scratch/evaluation-run-1',  // does not exist yet
  timeoutMs: 300000,
};
```

### Selecting the frozen submission (C3 selection)

The evaluation does not discover a submission from the environment or a
well-known path: every one of `runRoot`, `runId`, `manifestId`, `snapshotId`,
`frozenSubmissionId` and `expectedDigest` is stated explicitly and re-verified
from bytes before anything is staged.

- The run container's directory chain must be link-free (`UNSAFE_PATH`).
- C3's own publication verification must report the submission complete,
  unchanged, and the run's journal/projection consistent. Anything short of that
  — an incomplete freeze, a tampered byte, more than one publication, a run that
  is not in the frozen state — is `SNAPSHOT_REFUSED`, with the findings retained
  in the error's details.
- The sealed manifest digest must equal `expectedDigest`, and the bound challenge
  and evaluator identity digests must equal the recomputed digests of the stated
  `challenge` and `evaluator` records (`IDENTITY_MISMATCH`).

The snapshot bytes themselves are re-inventoried immediately before and again
immediately after staging; a snapshot that moved between those readings aborts
the run with `SNAPSHOT_REFUSED`.

## What an evaluation does, in order

The stage sequence is fixed and matches the established order; it is not
configurable through the request.

1. **Re-verify** the selection from bytes (above).
2. **Preflight** the installed prerequisites: an installed Playwright Chromium
   executable must exist (it is never installed or downloaded by the
   evaluation), and the prepared `starter/node_modules` must contain the
   entry points of the typecheck, build and test tools. These are presence
   checks over operator-prepared material, not verification of every installed
   package's version. A missing prerequisite is `MISSING_PREREQUISITE`.
3. **Stage** a fresh scratch tree inside `outputRoot` (a `scratch-` directory the
   operation creates and owns): copy the frozen snapshot in, then replace the
   canonical tooling files and the canonical tests, then copy the prepared
   dependencies. The copied snapshot is the *staged copy*; the frozen original
   is never written to.
4. **Run the stages** in the established order, each through the bounded process
   runner: **typecheck** (`tsc --noEmit`) → **build** (`vite build`) →
   **visible tests** (`vitest run tests/contracts.test.tsx`) → **browser
   properties** (the unchanged loopback development server over the staged
   product plus the full property set) → **useful tests**
   (`usefulTestsCooperative`). The browser stage's server is the preserved
   loopback **development server** started against the staged application
   directory — it is *not* a server over the built `dist/` output and not a
   preview server. The build stage independently records build evidence (did
   `vite build` complete cleanly), and the browser stage's properties exercise
   the development-served application; these two pieces of evidence stand on
   their own and one is never inferred from the other.
5. **Re-verify** the snapshot after the quality stages, then run **source
   inspection** (`inspectPublic`) against the *frozen original*, not the staged
   copy — so tampering evidence describes what the participant actually
   submitted, and the staged canonical replacement cannot launder it.
6. **Verify the snapshot is still unchanged** (a byte that moved during
   inspection is `SNAPSHOT_REFUSED`), then **clean up** scratch.

### Canonical replacement in scratch

Inside the scratch copy only, these bytes are replaced with the canonical
copies from the shipped `starter/` tree: `package.json`, `package-lock.json`,
`tsconfig.json`, `vite.config.ts`. The canonical test files are an **overlay**,
not a replacement of the whole test directory: each canonical name that exists
in the shipped `starter/tests/` is written over its counterpart in the staged
copy, and a test file the participant *added* beyond the canonical set stays
where the staged copy has it. That retention is deliberate — the useful-tests
stage reads the participant's added tests from the staged tree — while the
governed visible-test file and setup themselves always come from the canonical
copies, so a rewritten canonical file cannot launder itself. The replacement
happens in a disposable copy, never in the submission, and refuses to follow a
link at either end (`UNSAFE_ENTRY`, `OWNERSHIP_LOST`), proving each canonical
source file unchanged between validation and read.

The prepared dependencies and pinned tool versions are **operator
prerequisites**. Staging checks they are present and ordinary (the tree scans,
plus the presence of the typecheck, build and test tool entry points), but it
does not verify the version of every installed dependency; that governance
belongs to how the operator prepared `starter/node_modules`, not to this
check.

### Original-source hygiene

The original source is never modified by an evaluation, and two separate
mechanisms say so:

- The frozen snapshot is re-inventoried before staging, after staging, after
  the quality stages and after inspection; any drift aborts with
  `SNAPSHOT_REFUSED`, and the observed before/after digests are returned in
  `snapshot.before` / `snapshot.after`.
- The `hygiene` evidence block reports what inspection *found* in the frozen
  original (lockfile intact, visible tests intact, dependency pins), as reported
  evidence about the participant's bytes — not as something the evaluation
  changed. A participant who tampered with `package-lock.json` sees it reported
  there while the evaluation itself writes nothing into their snapshot.

## The result

`evaluateFrozen` resolves to one of **two returned shapes** — the success below
carrying a validated `bundle`, or the returned infrastructure failure with
`bundle: null` — and it **rejects in every other case**. The modeled
request/safety and evidence-integrity rejections use a thrown
`EvaluationRefusalError` (the request and safety refusals, below) or a thrown
`EvaluationIntegrityError` with code `EVIDENCE_INTEGRITY`, the evidence-integrity
refusal — never a degraded result, a partial score or the raw S1 shape. Such a
refusal can fire at either end of the run: *before any tool runs*, when the
installed evaluator identity or the recorded candidate lineage inputs are missing
or inconsistent, or *after the completed stages*, when the finished evaluation
cannot be honestly assembled into a validated bundle — see
[EvidenceBundle](EVIDENCE_BUNDLE.md). The two classes are the modeled expected
faults, not every possible bug: no claim is made that an unforeseen programming
fault can never occur.
Integrity rejects
never return the raw S1 result, a partial score or a partial bundle; diagnostic
outputs already retained under `outputRoot` may remain, and the caller handles
the rejection.

### Success — `status: 'success'`

| Field | Meaning |
| --- | --- |
| `evaluationId` | `eval-`-prefixed identifier of this attempt. |
| `evidence` | The stage evidence: `visiblePassed`, `hidden` (property records), `typecheck`, `build`, `usefulTests`, `noSuppression`, `hygiene`, `analysisMethod`. Ordinary failures appear here as false/failed values. |
| `stages` | One `StageResult` per completed stage (name, `status: 'success'`, value, and the retained process facts). |
| `score` | **Always `null` at the top level, in both result shapes.** The complete automated score is the validated `bundle.score`; the unchanged top-level field stays `null` for S1 compatibility (see [EvidenceBundle](EVIDENCE_BUNDLE.md)). |
| `snapshot` | `before`, `after`, `workspaceMatchesFrozen` — the re-verification observations, with `null` where not observable. |
| `environment` | Stated `label` plus the Node version, platform and architecture the run executed under. Unobserved values (for example the browser version at S1) are `null`, never guessed. |
| `cleanup` | The cleanup observation (below). |
| `artifacts` | POSIX-relative paths of the retained logs, reports and bounded control metadata under `outputRoot`, discovered only under output the operation proved it owns. When a failure happened before any process ran (for example a refused selection or a missing prerequisite), the artifacts list is honestly short or empty: the condition is carried by the structured `error` diagnostic, not by a fabricated log. Disclosed residue directories are reported, never traversed. |

### Infrastructure failure — `status: 'infrastructure-error'`

Carries `error: { code, stage, message, details }` with one of the declared
codes — `TIMEOUT`, `CANCELLED`, `MISSING_PREREQUISITE`, `TOOL_CRASH`,
`OUTPUT_LIMIT`, `INVALID_TOOL_OUTPUT`, `CLEANUP_FAILED` — plus `evidence: null`,
`score: null`, whatever snapshot and cleanup observations were possible, and
the retained artifacts. When the failing stage actually ran a process, that
process's stdout/stderr logs are among those artifacts; when it failed before
any process could run — a missing Chromium install, a missing prepared
dependency, a preflight refusal — there may be no process log and no
stage-artifact directory at all, because none was ever created. The condition is
then carried by the structured `error` diagnostic (code, stage, message and
bounded details) — a structured diagnostic, never a fabricated process log.
Internally these
conditions are the `EvaluationInfrastructureError` classification exported by
the contracts module; the facade converts it into this returned shape rather
than letting it escape, so this status means the evaluation could not complete
and makes no claim about the submission's quality.

### Rejection — a thrown `EvaluationRefusalError` or `EvaluationIntegrityError`

**Request and safety refusals (`EvaluationRefusalError`).** A request or safety
refusal is *thrown*, not returned: a bad request, a refused
path or root (`INVALID_ARGUMENT`, `INVALID_PATH`, `UNSAFE_PATH`,
`INVALID_SELECTION`), an invalid identity record (`IDENTITY_INVALID`), a
binding mismatch (`IDENTITY_MISMATCH`), a refused submission (`SNAPSHOT_REFUSED`),
an existing output directory (`OUTPUT_EXISTS`), overlapping roots
(`ROOTS_OVERLAP`), an unsafe staged tree (`UNSAFE_ENTRY`, `CASE_COLLISION`,
`TREE_LIMIT`), a changed source (`SOURCE_CHANGED`) or a lost ownership claim
(`OWNERSHIP_LOST`). Refusals happen before any byte is written wherever the
refusal is about a byte that was not yet written — a refusal leaves the tree
where it found it.

Staging also refuses a snapshot's top-level reserved selection names or their
case aliases (`UNSAFE_ENTRY`), such as `Node_Modules`, `Dist` or `.Git`, before
creating evaluation output. This is an evaluation staging guard, not a change
to C3's byte-exact snapshot selection policy; names are never silently dropped.

If a refusal occurs after output acquisition, the thrown error also carries the
observed `cleanup` and `artifacts` (output-relative retained diagnostics). This does
not turn a refusal into quality evidence or authorize deletion of unproven residue.

**Evidence-integrity refusals (`EvaluationIntegrityError`, code `EVIDENCE_INTEGRITY`).**
The other rejection class is not about a request byte at all. It fires on the
modeled integrity faults, at either end of the run: *before any tool runs* — the
facade computes the installed evaluator identity and re-checks it against the
recorded candidate lineage before the controller is invoked, and a missing or
inconsistent identity input throws there, before any staging or tool — or *after
the completed stages* — the bundle cannot be completed honestly: evidence
that fails validation or the unchanged scorer's own validation, a recomputed
mismatch between the stored bundle and the evidence, or an installed evaluator that
differs from the recorded original candidate. Like every rejection it is *thrown*,
never returned: no raw S1 result, partial score or partial bundle comes back.
Diagnostic outputs already retained under `outputRoot` may remain, and nothing is
deleted on the rejection's account — the caller handles the rejection.

## Timeouts, cancellation and cleanup

- **Bounded.** Every tool run carries `timeoutMs` (default 300000) and
  `maxOutputBytes` (default 1048576). Exceeding the time bound yields
  `TIMEOUT`; exceeding the output bound yields `OUTPUT_LIMIT` with the retained
  (bounded) logs. The deadline stays armed until the run fully settles, so a
  killed tree's lingering pipe cannot turn into an unbounded wait.
- **Cooperative cancellation.** The `signal` is checked before each stage and
  observed during each run. An already-aborted signal never spawns a process at
  all; aborting mid-run yields `CANCELLED` with whatever logs could be retained.
  Staging checks between copy phases and copied entries, yielding to the event
  loop at most every 64 entries so an external abort can be observed during a
  multi-file copy. Initial synchronous inventories and an individual file's
  synchronous read/write are not interruptible; no hard staging deadline is
  promised. Cleanup still preserves any entry whose ownership cannot be proven.
  Cancellation is a contract, not an interruption guarantee against an
  uncooperative grandchild process.
- **Bounded termination of what the run started.** When a run must end early or
  died abnormally, the evaluation terminates only the process tree it owns and
  reports the outcome honestly; when tree termination cannot be confirmed, the
  result says so (`cleanupUnconfirmed` in the details) instead of claiming more.
- **Cleanup always runs; it never overwrites a primary error.** Scratch removal
  re-validates every claimed directory identity before each delete and removes
  only material this operation created and can prove (plus the enumerated
  generated build/temp paths). Anything it cannot prove is preserved and
  reported through `cleanup`: `{ removed, residue, errors }`. A cleanup that
  could not be confirmed turns into the primary failure with code
  `CLEANUP_FAILED` **only when no earlier failure exists**; when the run already
  failed for another reason (a `TIMEOUT`, `CANCELLED`, `TOOL_CRASH`, …), that
  original code stays the primary `error` and the cleanup difficulty is recorded
  alongside it — in the cleanup observation's `residue` and `errors` and, where
  applicable, in the error details (`cleanupUnconfirmed`). It is never silently
  dropped and never replaces the primary cause. The loopback server and browser
  are closed before the stage result settles, and the acquired server is always
  closed even when the stage fails.
- **Retained diagnostics.** Per-stage logs, reports and bounded control
  metadata live under `outputRoot` itself (never in a system or browser cache
  directory), outside the disposable scratch, and are the retained output the
  result's `artifacts` lists. For runs of the Node executable, a small bounded
  normal-completion witness record may be retained as diagnostic evidence; it is
  nonce-named, size-bounded, validated before use, and never deleted
  unconditionally. A preflight failure that never started a process has no
  process log to retain; its diagnostic is the structured `error`.

## The boundary, stated honestly

- **Cooperative containment, not an operating-system sandbox.** The staging
  boundary — link and special-file refusal, case-collision refusal, canonical
  absolute non-volume paths, directory-chain identity claims, scratch ownership
  proofs, output disjoint from the repository and run container — makes
  accidental escape and silent substitution structurally hard. It is not
  containment against a hostile process with operating-system privileges; the
  declared security model for this surface remains
  `COOPERATIVE_WORKSPACE_NO_ADVERSARIAL_OS_CONTAINMENT`.
- **The process runner classifies only what the facts state.** Exit facts come
  only from the operating system's reported event; a signal the OS does not
  report stays `null` in the facts and is never synthesized. For runs of the
  actual Node executable, the maintainer-private preload may supply a bounded
  normal-completion witness, and the classification rule is precise:
  a **nonzero** Node exit is ordinary evidence **only with a valid
  normal-completion witness**; without one (absent, unreadable, or bound to a
  different exit code) it is a `TOOL_CRASH` infrastructure result. A **zero**
  exit is ordinary **unless a valid witness explicitly says it was abnormal**
  — informational Node flags may legitimately write no witness at all, and an
  absent witness at exit zero is not a failure. The witness is *retained
  diagnostic evidence*, an input to that one classification; it is **not**
  operating-system signal knowledge, a sandbox, a timing authority or a
  certification. Non-Node executables keep only the facts the OS reports.
- **No browser-cache discovery or override.** The evaluation inherits only the
  bounded runtime variables its child tools require (system path entries,
  temporary-directory redirection into the owned scratch, and browser executable
  path variables the caller's own command already carries). It never scans for,
  installs, or redirects an installed browser's profile or cache, and it exposes
  no option to do any of that.
- **No invented command line.** There is no evaluation command-line interface
  in this checkout, and none of the historical runner scripts is part of this
  surface. Do not build against a command name; import the module.
- **There is no network sandbox, and none is claimed.** The orchestration
  deliberately uses a loopback server so the evaluation needs no hosted service
  and reaches nothing remote by design. But no operating-system or network
  sandbox is applied to the Node tool processes the evaluation runs — including
  the participant's own added tests as executed by the preserved cooperative
  useful-tests module. They run with the host's ordinary network capability, and
  a participant test that opens a network connection is not blocked at the
  process level. The only *enforced* network restriction is inside the browser
  stage: the unchanged browser evaluator routes every page-context request and
  lets through only the loopback origin, aborting all other outbound page
  requests. Read the two facts separately and honestly: browser page traffic is
  origin-routed by that unchanged module; general subprocess network access is
  possible and not sandboxed.

## What is not available at S1

- **No top-level score.** The result's top-level `score` stays deliberately
  `null` for S1 compatibility; the complete automated score is the validated
  `bundle.score`, produced by the versioned `EvidenceBundle` assembly (with its
  JSON schema and the evaluator-identity binding around the bundle) that **is**
  delivered in this checkout. Consuming the top-level field or the raw S1 stage
  evidence as if it were a finished score is out of contract. The parity
  demonstration against the recorded starter/reference/broken results is **S3**
  work and is not delivered.
- **No official-governance claim.** A successful S1 run is a local, self-issued
  assessment. The trust ceiling for a local producer applies; nothing here
  grants review, certification, ranking or any governance status, and the result
  shape deliberately carries no field that could carry one.
- **No DSH dependency.** The core runs with DSH entirely absent — no import, no
  configuration lookup, no runtime call — and the recorded core suites are run
  that way. DSH-specific concerns, if any, live outside the core.
- **No supervisor, watchdog or hosted service** on this surface: by design the
  evaluation reaches nothing remote and needs no hosted service, the browser
  stage's own loopback server being the deliberate exception it owns and
  closes. This is an architectural choice, not a sandbox — see the network
  disclaimer under [The boundary, stated honestly](#the-boundary-stated-honestly).
- **No public release.** Everything documented here is current S1 checkout work
  behind the accepted API; none of the new evaluation modules is an approved
  public release, and no operating-system qualification or publication status
  is claimed for any of them.

## Testing and the public boundary

The documentation check for this document is
`tests/evaluation/documentation.test.mjs`, which asserts that the named exports,
request options, defaults, infrastructure codes and promised error codes align
with the paired declarations — that every refusal code it lists is actually
emitted by the staging/controller source — and that its own behavior claims
(loopback development server, overlay-and-retained participant tests, retained
output outside scratch, un-overwritten primary error, the nonzero-exit witness
rule, and the not-sandboxed Node network position) match the implementation and
the preserved evaluator sources — all statically, without executing an
evaluation, starting a browser or touching a server:

```text
node --test tests/evaluation/documentation.test.mjs
```

The functional acceptance suites for the modules themselves are the sibling
`tests/evaluation/*.test.mjs` files (facade, controller, staging-security,
process, tool stages and the rest); the facade suite drives the real process
runner over tiny fixed tools and never launches a browser.
