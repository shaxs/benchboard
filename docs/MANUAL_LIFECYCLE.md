# Manual run lifecycle

This document describes the public lifecycle surface that exists today: how a
manual run is started, honestly timed, stopped by operator attestation, frozen
into an immutable submission, verified again later, and reset into a fresh
identity. It is written against the released modules and their paired type
declarations, and it states plainly which product pieces are not part of this
release.

This is **not** a product quickstart and **not** a runbook for operating a
benchmark. Nothing described here starts, seeds, runs, supervises or evaluates a
benchmark participant. It is the exact reference for the programmatic lifecycle
API; the current checkout command line (`cli/benchboard.mjs`) drives these same
operations and is documented in [CLI.md](CLI.md), with the fresh-reset command in
[CLI_RESET.md](CLI_RESET.md). For the current end-user walkthrough, see
[QUICKSTART.md](QUICKSTART.md) and [MANUAL_WORKFLOW.md](MANUAL_WORKFLOW.md).
The programmatic `openRun` remains an API export of this surface; there is no
`open` CLI command. See also
[What is not available in this release](#what-is-not-available-in-this-release).

## Modules

| Module | Import specifier | Declarations | Role |
| --- | --- | --- | --- |
| Lifecycle | `./packages/core/lifecycle.mjs` | `packages/core/lifecycle.d.ts` + byte-identical `.d.mts` | Start, attested stop, read, reconcile; the journal authority and its projection. |
| Freeze | `./packages/core/freeze.mjs` | `packages/core/freeze.d.ts` + `.d.mts` | Freeze the workspace into an immutable snapshot, submission and proof; verify a published submission; reconcile an interrupted freeze. |
| Reset | `./packages/core/reset.mjs` | `packages/core/reset.d.ts` + `.d.mts` | Produce a fresh run container from a finished one, leaving the old identity untouched. |
| Manual adapter | `./adapters/manual/index.mjs` | `adapters/manual/index.d.ts` + `.d.mts` | The same operations behind one named entry point plus an honest capability statement. |

All four are ES modules that import Node builtins and the accepted core modules
only. There is no dependency on any agent harness, no operating-system service,
no supervisor and no network access.

## The honesty rule that runs through all of it

Three statements hold for every operation below, and they are the reason the API
looks the way it does.

1. **Nothing is invented.** Where a fact was not observed, the recorded value is
   `null`, not zero, not a default, not "now". A missing start instant, an
   unavailable clock, and an unstated observation each produce `null`, and the
   refusal that results says that the contract invents no time.
2. **Nothing is enforced.** A cooperating agent is the only thing that can stop.
   The lifecycle records the operator's statement that it did; it does not
   interrupt, signal, launch, terminate or enumerate a process, and it never
   enforces a declared time limit.
3. **Nothing is removed that the operation did not create.** A refusal, a fault,
   and a recovery report all leave every byte found exactly where it was,
   including material that belongs to somebody else.

## What this surface does and does not do

It does:

- capture one immutable, operator-declared start record and bind it to the
  accepted run manifest,
- time a run honestly, recording unknown as unknown,
- record a stop as an operator attestation with the assurance and enforcement
  fields that make its status unambiguous,
- freeze the current workspace bytes into a content-addressed snapshot with a
  bound submission record and proof record, all published through the accepted
  storage container,
- re-verify a published submission from its own bytes at any later time,
- report the actual fate of an interrupted freeze and complete or retain it only
  by explicit operator decision, and
- reset a finished run into a brand-new container without touching the old one.

It does not:

- run, supervise, interrupt or terminate anything;
- enforce, count down, or warn about `declaredCeilingMinutes` — that field is a
  recorded declaration and nothing more;
- discover a run from the environment, a parent directory, or a well-known path;
  every request states the container by absolute path **and** by both identities;
- edit, re-time, re-stamp, or append to a published submission or proof;
- delete an orphan, a foreign container, or a partial byte as part of any
  recovery;
- decide what a run scored, or evaluate anything.

## Entry points

Results are operation-specific:

- `openRun` returns `OpenedRun`: verified `runRoot`, `stateRoot`, `workspaceRoot`, `runId`, `manifestId`, `manifestDigest`, `manifest`, and `operationName`; no lifecycle journal or diagnosis.
- `withRunTransaction<T>` returns the callback's value. Its storage facade is read-only; only checked `appendEvent` and `commitState` can write lifecycle facts. Raw persistence is confined to the internal command engine.
- `startRun` and `stopRun` return the base `LifecycleView` below. Stop additionally returns `stopAssurance` and `enforced:false`.
- `readRunLifecycle` returns that view plus required `diagnosis` and `findings`.
- `reconcileRun` returns `runId`, `manifestId`, `state`, `diagnosis`, `action`, `note`, `findings`, and (where present) `history`; it does not return a `lifecycle` or `journal` object.

The base view is:

```ts
type LifecycleView = {
  runId: string;
  manifestId: string;
  manifestDigest: string | null;
  state: 'INITIALIZED' | 'RUNNING' | 'STOP_RECORDED' | 'FROZEN';
  lifecycle: LifecycleStateRecord | null;   // the projection, null when absent
  journal: {
    entryCount: number;
    events: readonly LifecycleEvent[];
    foreignEntries: readonly string[];
  };
  // readRunLifecycle adds diagnosis and findings; start/stop do not.
};
```

### Lifecycle

| Export | Request | Effect |
| --- | --- | --- |
| `openRun` | `RunLifecycleRequest` | Bind and validate the container identities; publish nothing. |
| `withRunTransaction` | `RunLifecycleRequest`, callback | Run one whole command under the accepted container lock. The callback receives the only two write seams, `appendEvent` and `commitState`. |
| `startRun` | `StartRunRequest` (`declaration` added) | Capture the immutable declaration and move the run to `RUNNING`. |
| `stopRun` | `StopRunRequest` (`attestation` added) | Record an operator-attested stop. A second stop is refused and the first stands. |
| `readRunLifecycle` | `RunLifecycleRequest` | Read state, verified journal, `diagnosis` and `findings`. Publishes nothing. |
| `reconcileRun` | `ReconcileRunRequest` | Explicitly resolve an interrupted `START` (or report a `STOP`), with an operator decision. |
| `freezePreconditionFor` | a committed state | The single source of truth for whether a state may be frozen. |
| `readClockReading`, `elapsedBetween` | clock seam / two instants | The clock and elapsed primitives, with the honest-`null` rules applied. |
| `lifecycleStateDigestOf`, `lifecycleEventDigestOf`, `lifecycleCanonicalJson` | records | Recompute an identity from bytes. Verification always recomputes. |

### Freeze and verification

| Export | Request | Effect |
| --- | --- | --- |
| `freezeRun` | `FreezeRequest` | Freeze the workspace bytes; publish submission, proof, state projection and commit. Returns `FreezeResult`. |
| `verifyFrozenSubmission` | `VerifyFrozenRequest` | Re-verify a publication from its own bytes and the re-read journal. Returns `VerifyFrozenResult` with `ok`, per-submission `findings` and `runFindings`. |
| `verifyFrozenSnapshot` | same | Alias of `verifyFrozenSubmission`; one verification, two names people already use. |
| `reconcileFreeze` | `VerifyFrozenRequest` + `operator`, `intentDigest`, `decision` | Explicitly resolve an interrupted freeze: `KEEP_INTERRUPTED` or `COMPLETE`. |

### Reset

| Export | Request | Effect |
| --- | --- | --- |
| `resetRun` | `ResetRequest` | Create a fresh container through the initialiser and return its sealed manifest. The old container is read-only evidence: `oldContainerMutation: 'none'`. |

## The request boundary

Every request names the container three ways: `runRoot` (absolute), `manifestId`
and `runId`. A caller never supplies a state root: it is derived from the
accepted run record inside the container and revalidated, so a request cannot
redirect a lifecycle write into some other container.

`expectedDigest` is optional and checked when stated. `clock` is the injection
seam described under [Time](#time). `operationName` labels refusals.

Additional fields per operation:

- `startRun` — `declaration`: `{ harness, model, workerCount,
  executionMode: 'MANUAL', declaredCeilingMinutes }`. Unknown facts are stated as
  `null`. `harness` is optional: an omitted or null `harness` is never invented as
  `manual` — it binds the explicitly stated manifest harness when the manifest
  carries one, and stays `null` otherwise. (The outer CLI `init` command states
  `manual` explicitly; that is a separate declaration step, not a default of this
  API — see [CLI.md](CLI.md).) `model` is the declared `model` or `null`; it is
  never guessed from the manifest, the environment or the machine.
- `stopRun` — `attestation`: `{ operator, agentStopped: true, statement,
  observedAt? }`. `agentStopped` must literally be `true`; `statement` is the
  operator's own sentence.
- `freezeRun` — `attestation`, plus optional `clockless: true` (the never-started
  route), `clock`, `expectedDigest`, `hooks`, `publicationHook`, `notes`.
- `resetRun` — `output` (must be fresh), `initializationRequest` (the full
  initialiser request minus `output`), optional `protectedRoots`, `clock`,
  `expectedDigest`.

## State model

A container with no lifecycle record reports `INITIALIZED`. It is a derived
value, not a stored one. The four states and their permitted transitions are
data: `LIFECYCLE_TRANSITIONS` states the permission table every write consults,
and `FREEZE_PRECONDITIONS` states which states may reach `FROZEN`.

```text
INITIALIZED ──startRun──▶ RUNNING ──stopRun──▶ STOP_RECORDED ──freezeRun──▶ FROZEN
     │                                              ▲
     └──────freezeRun({ clockless: true })──────────┘   (publishes, then FROZEN)
```

- `FROZEN` is terminal: its transition list is empty. There is no unfreeze, no
  re-open and no re-stamp. Starting over is [`resetRun`](#reset).
- A freeze is gated twice over: by the state table and by the attestation gate.
  `freezePreconditionFor('RUNNING')` reports `permitted: false`; the run must
  carry the bound stop attestation (or state `clockless`) before the command can
  proceed.
- `stopAssurance: 'operator-attested'` and `enforced: false` are constants of
  this contract, not fields a caller can set.

### Cooperative, never halted

`stopRun` is a record, not a command. The adapter states this as machine-readable
data, and it is the honest description of the capability boundary:

```ts
capabilities = {
  executionMode: 'MANUAL',
  halt: false,                  // cannot stop an agent
  deadlineEnforcement: false,   // no timer, no interruption of a running run
  stopAssurance: 'operator-attested',
  stopEnforced: false,
  automaticRecovery: false,     // an interrupted command stays interrupted
  processControl: false,        // no signal, launch, terminate or enumerate
  environmentDiscovery: false,  // no ambient or env-based run discovery
}
```

A declared ceiling is therefore recorded and never acted on. If a run is still
going, `stopRun` does not make it stop; the attestation is refused until the
operator can honestly state `agentStopped: true`.

### No deadline enforcement

Nothing here reads a clock in order to interrupt. The clock seam exists solely
to *stamp* an event, and only when it reports something. A run that passes its
declared ceiling keeps running and keeps being timestamped; nothing warns,
nothing halts, and nothing marks the run invalid on that account.

## Time

The clock seam is a one-method object, `LifecycleClock = { now(): number | null }`.
The default observes the host wall clock; any request may inject its own. A
`now()` that returns `null` is a legal and honest answer, not an error.

Rules, all of them observable through the read view:

- An unknown start instant is stored as `startedAt: null`.
- Equal start and stop instants yield `elapsedMs: 0`, not `null`.
- An unknown endpoint yields `elapsedMs: null`.
- A backwards pair yields `elapsedMs: null` and retains the reversal as
  `clockError: { code, error, elapsedAvailable: false }`. Nothing is clamped to
  zero and the reversal is not discarded.

The journal never forges a commit stamp: `journalCommitAt` is whatever was
stated, `null` included. A reconciliation forges no clock value either.

## Journal authority and the projection

Two files, inside the container's state root, which is derived and never a
caller input:

```text
<runRoot>/.benchboard/lifecycle/state.json            the projection
<runRoot>/.benchboard/lifecycle/journal/NNNNN.json    the authority, one file per event
```

The journal is the authority. It is append-only, its sequence numbers are dense,
and every event after the first binds `previousEventDigest`, the digest of its
immediate predecessor. The event kinds are exactly
`START_INTENT`, `START_COMMIT`, `STOP_RECORDED`, `FREEZE_INTENT`, `FREEZE_COMMIT`.

`state.json` is a projection of it. It is re-derived and re-verified against the
journal on every read; a record that disagrees with the journal is reported, not
trusted. A caller cannot write a sequence number, a predecessor digest, an
identity, or a state the tables do not permit: the two write seams are
`appendEvent` and `commitState`, and each validates against the tables.

`readRunLifecycle` also reports `diagnosis`:

| `diagnosis` | What the journal says about the last command |
| --- | --- |
| `consistent` | The journaled events and the projection agree. |
| `incomplete` | A journaled intent without its commit: an interrupted command, with the bytes it wrote still present. |
| `inconsistent` | The authority and the projection contradict each other. |

`findings` carries the sentences behind a non-`consistent` report. Reporting is
all a read does: it removes nothing.

A note on scope. `incomplete` is defined for the two operations that genuinely
have an intent/commit pair — a start and a freeze. A stop is journaled whole or
not at all, so a lone `STOP_RECORDED` event is not, by itself, a torn *command*
and is not reported as `incomplete`. What it *is*, when the projection carries no
matching stop, is an authority that the projection does not reflect: `readRunLifecycle`
reports that as `inconsistent` with a finding naming the event, because the two
sources of truth do not state the same run. The freeze and reset refusals and the
byte preservation are unchanged by that report — a read still removes nothing.
The check is a comparison of what the journal states against what the projection
states; it is not a repair, and it does not change any gate.

## Immutability

"Immutable" here has one concrete meaning: **a published byte is never written
again, and a later reader judges it by recomputation.**

- The snapshot workspace is a content-addressed copy under
  `<runRoot>/snapshots/<snapshotId>/workspace`. A freeze claims an
  exclusively-new container; it never adopts, reuses, or cleans a container it did
  not create.
- The submission record (`<snapshotId>`-bound `frozenSubmissionId`) and the proof
  record (`<snapshotId>:proof`) are written once, through the accepted storage
  container, under the state root:
  `<runRoot>/.benchboard/freeze/<identity>.json`. A retry does not overwrite
  them; a second publication of the same identity is refused.
- Verification never trusts a field it can recompute. It re-reads the journal,
  recomputes the event and state digests, recomputes the tree digest from the
  bytes, and recomputes the submission and proof identities. A byte that moved is
  reported by the record that became unreadable rather than skipped, so a clean
  report cannot be produced over a tampered run.
- A later live edit of the working tree does not invalidate a published
  submission and does not touch it. It is visible only as the honest drift note
  in `verifyFrozenSubmission`'s `workspace` block: an observed file and byte count
  plus `matchesFrozenInventory`, explicitly labelled as reporting and never used
  as a verification input.

### Selection policy

The bytes that enter a snapshot are chosen by one frozen, byte-exact policy.
There is no informal extension point and no per-call override.

| Field | Value |
| --- | --- |
| `selectionPolicyId` | `benchboard-application-snapshot-v1` |
| `hashAlgorithmId` | `benchboard-sha256-tree-v1` |
| `hashAlgorithm` | `sha256` |
| `selectionExclusions` | `.git`, `node_modules`, `dist`, `.agent-teams`, `.benchboard`, `.cache`, `coverage`, `.vite` |

Exclusions are exact top-level basenames matched byte-for-byte. Two of them are
load-bearing for publication privacy: the team-state directory and the run's own
state root, so neither journal, projection, nor coordination state can be
selected into a published snapshot. The proof records the exclusion list it was
built with verbatim, so a reader can tell which policy produced which bytes. The
proof's `inventory` is the complete byte set, and its `fileCount`, `byteCount`
and `directoryCount` are computed from it.

## Provenance

Every published instant names where it came from. `frozenAtProvenance` is one of:

| Value | Meaning |
| --- | --- |
| `lifecycle.stoppedAt` | The freeze binds the recorded stop the projection carries. |
| `attestation.observedAt` | The operator stated the observation in the freeze attestation, and it is the source this route used. |
| `clock.reading` | The clock in force reported the instant, and neither a recorded stop (on the stopped route) nor a stated observation supplied it. |

Precedence is route-scoped, because the two routes do not carry the same facts.
On the stopped route it is a recorded stop, then the stated observation, then the
clock reading. On the clockless route there is no recorded stop to bind — the run
never started — so it is the stated observation, then the clock reading. The
publication instant is therefore **not** always an operator-stated
`observedAt`: where the attestation states none, the reading of the clock the
caller supplied is used and says so through `clock.reading`. Nothing else can
produce the instant. If no source states one, the freeze is refused before any
byte is written, with `CLOCK_INVALID` and a message that says the contract
invents no time and tells the operator which of the two fields to state.

The proof carries `timeProvenance`, which repeats the record's
`startedAt`, `stoppedAt`, `elapsedMs` and `clockError`, including the `null`s, so
a reader can tell an unobserved time from a zero one. On the clockless route the
proof reports `freezeRoute: 'CLOCKLESS_INITIALIZED'` and leaves the start
fields `null`: no run start/stop timing exists. A separate publication instant may still be observed using the supplied or default host clock, or supplied by an explicit operator observation. `clockWasUnavailable` is scoped to a run that carries a bound
recorded stop with no instant; it is not the field that describes a run that
never started.

The stop itself is provenanced by `stopAssurance: 'operator-attested'` and
`enforced: false` on both the record and the proof, next to the stored
attestation, so an assurance can never be read as an enforcement.

## Freeze routes

`freezeRun` takes one of two routes, both of which publish through the same
sequence and both of which require an operator statement.

**Route 1 — after a recorded stop** (the normal route). The run state is
`STOP_RECORDED`. The attestation must be byte-identical to the one the stop
journaled: a freeze always binds the recorded stop rather than a fresh one, and
`ATTESTATION_INVALID` is the result of trying otherwise.

```js
await startRun({ ...ids, declaration, clock });
const stopped = await stopRun({ ...ids, attestation, clock });
const frozen = await freezeRun({ ...ids, attestation: stopped.lifecycle.stopAttestation, clock });
// frozen.route === 'STOP_RECORDED'
```

**Route 2 — clockless from `INITIALIZED`**, for a run that never started. The
request states `clockless: true` **and** the attestation itself carries
`clockless: true`: that pair is the operator's statement that the run never
started and that no time is claimed for it. The journal for this route opens with
`FREEZE_INTENT` instead of `START_INTENT`, so a clockless freeze needs no
invented start. The publication instant is taken from `attestation.observedAt`
when the operator stated one, and otherwise from the clock reading the
transaction reports — the clock the request stated, or, where the request stated
none, the default clock that observes the host wall clock (the same seam the
start and stop commands use, documented above). Whichever source produced it is
what `frozenAtProvenance` reports (`attestation.observedAt` or `clock.reading`).
A bare `clockless: true` without the attestation claim is refused with
`ATTESTATION_INVALID`.

The converse is refused as well. On the stopped route a run that carries a
recorded stop cannot be frozen through a clockless attestation: the freeze is
bound to that stop, and presenting the clockless claim there is
`ATTESTATION_INVALID` rather than a second way to name the instant. On that route
the clockless claim is also not an optional `true` and not something an omitted
`observedAt` can imply — the stopped attestation carries no `clockless` field at
all, so a freeze that means to bind the recorded stop states no such claim.

Both routes write the intent, copy the bytes, publish the submission, publish the
proof, project the state and append the commit — in that order, with observation
points between them.

## Reading a freeze result

`FreezeResult` reports the outcome, not an intent: `state: 'FROZEN'`, the
`route`, the `snapshotId`, the `snapshotRoot`, the bound
`frozenSubmission.frozenSubmissionId`, `submissionDigest`, `frozenAt` with its
`frozenAtProvenance`, `stopAssurance`, `enforced: false`, the new `stateDigest`,
the journaled `events`, and the `freeze` sequence pair. The proof adds the
`inventory`, `directories`, counts, `treeDigest`, `selectionPolicyId`,
`selectionExclusions`, `hashAlgorithmId`, the bound `freezeIntentDigest` and
`freezeIntentSequence`, and the attestations on both sides.

## Recovery

A freeze is a multi-step publication, so it can be interrupted between steps.
Nothing recovers on its own — `automaticRecovery: false` — because the honest
outcome of an interrupted command is the operator's decision, not a guess.

When a fault strikes during publication, the refusal carries the actual fate of
the attempt in `error.details.freezeFate`:

| Field | Meaning |
| --- | --- |
| `interruptedOperation` | `'FREEZE'`. |
| `intentJournaled`, `intentEventDigest` | The journaled intent is retained and named, which is what a reconciliation binds to. |
| `submissionPublished` | The submission identity that landed, or `null` where no submission record exists. |
| `proofPublished` | The proof identity that landed, or `null` where no proof record exists. |
| `freezeCommitted` | Whether the commit happened. |
| `stateRecordState` | The state the projection was left in. |
| `preserved` | What the contract left in place. |

The two publication fields report identities or `null` rather than booleans, so a
fate cannot name a byte the operator then cannot find. Material the freeze did
not create — a foreign container inside the snapshots root, for instance — is
left exactly where it was, and the snapshots root is never pruned.

While the intent has no commit, a plain retry is refused (`RECOVERY_REQUIRED`,
or `STATE_TRANSITION_REFUSED` where the projection had already been advanced
without its commit) and a reset is refused (`RESET_JOURNAL_INCOMPLETE`, or
`RESET_JOURNAL_INCONSISTENT` for that same advanced-without-commit shape). The
only path forward is explicit:

```js
const fate = error.details.freezeFate;
await reconcileFreeze({ ...ids, operator, intentDigest: fate.intentEventDigest,
                        decision: 'KEEP_INTERRUPTED' });   // retain, repair nothing
```

`KEEP_INTERRUPTED` appends no commit and advances nothing: it reports the
projection as it stands and retains every byte it found.

`COMPLETE` is allowed only against one bound retained pair — a submission and a
proof that both verify and both bind this exact intent, this manifest and this
run, with a snapshot path inside this container whose bytes re-verify. Where the
fault struck before the proof landed there is no such pair, so `COMPLETE`
refuses with `RECOVERY_REQUIRED` and says that unknown orphan bytes are
preserved. Completion cannot be manufactured from a submission alone, and a
refused completion publishes nothing and removes nothing. Where the pair does
exist, `COMPLETE` appends the missing `FREEZE_COMMIT` — it does not rewrite the
journal — and stamps no clock value of its own.

`reconcileRun` is the same discipline for the start and stop commands: it reports
`nothing to reconcile` for a clean run, completes only the operation named, and
honours `LEAVE_AS_IS` by retaining what it found.

## Reset

`resetRun` produces a **new** container. It is the only supported way to start
again after a freeze, and it never edits the run it comes from.

Before it touches the destination it validates the whole request, then:

- requires `output` to be **absent** and not a link, with no linked ancestor. An
  existing directory is refused whatever it contains: `RESET_OUTPUT_NOT_FRESH`
  with the statement that *even an empty directory is foreign to this operation*,
  because an empty directory is still a directory somebody else created. A link
  at the destination is refused as a link rather than followed, a non-directory is
  refused as `OUTPUT_UNUSABLE`, and a path whose identity it cannot establish is
  refused rather than entered;
- refuses when the roots overlap or a protected root is involved;
- re-reads and re-verifies the source journal and projection, and refuses an
  incomplete or inconsistent run, because a fresh identity over an unresolved
  operation would hide it;
- refuses `RUNNING` outright: an active run is never reset;
- requires the identities and challenge provenance to match what the caller
  stated, and rejects a substituted identity. The three identity fields —
  `manifestId`, `runId`, `output` — may not appear inside
  `initializationRequest`; they are refused as invalid arguments;
- builds the fresh container through the initialiser and reads it back.

The result reports `source` (identity, state and manifest digest of the run it
read), the new sealed `manifest` and full `initResult`, the `output` path,
`fresh: true`, and `oldContainerMutation: 'none'`. A fault part-way through — a
hook that throws, for instance — leaves the frozen source byte-identical and
reports the actual publication fate of the attempt.

A reset is not an un-freeze. The old container, its journal, its submission and
its proof remain exactly the evidence they were, forever.

## Verification over time

`verifyFrozenSubmission` is the later reader. It takes the container identities
plus optionally one `frozenSubmissionId` or `snapshotId` and an
`expectedDigest`, and it answers from bytes:

- `ok`, `findings` for the publications and `runFindings` for the run's journal
  and projection,
- `state`, the state the journal implies,
- one entry per published submission with its own `ok` and `findings`, and
- `workspace`, the best-effort current-tree counts with `matchesFrozenInventory`
  and a note. It is reporting only, never an input to `ok`, and it is `null` when
  the tree cannot be listed.

A record that reads under none of its bound identities is named as unreadable.
It is never skipped, because silently skipping a record is how a clean report
gets produced over a tampered run.

## Refusals

Every refusal is a typed error carrying a stable `code` and a `details` object
that is context and never a secret.

| Surface | Error class | Code table |
| --- | --- | --- |
| Lifecycle, freeze | `LifecycleError` | `INVALID_ARGUMENT`, `FIELD_REQUIRED`, `NOT_FOUND`, `PROVENANCE_MISMATCH`, `STORAGE_REFUSED`, `STATE_TRANSITION_REFUSED`, `DECLARATION_INVALID`, `DECLARATION_ALREADY_BOUND`, `ATTESTATION_INVALID`, `CLOCK_INVALID`, `JOURNAL_INVALID`, `RECOVERY_REQUIRED` |
| Reset | `ResetError` | `RESET_INVALID_ARGUMENT`, `RESET_INVALID_ROOT`, `RESET_OUTPUT_NOT_FRESH`, `RESET_OUTPUT_UNUSABLE`, `RESET_OUTPUT_ALIAS`, `RESET_OUTPUT_LINK_ANCESTOR`, `RESET_ROOTS_OVERLAP`, `RESET_PROVENANCE_MISMATCH`, `RESET_CHALLENGE_MISMATCH`, `RESET_STATE_REFUSED`, `RESET_JOURNAL_INCOMPLETE`, `RESET_JOURNAL_INCONSISTENT`, `RESET_IDENTITY_NOT_DISTINCT`, `RESET_READBACK_FAILED`, `RESET_STORAGE_REFUSED`, `RESET_INITIALISE_FAILED` |

Three patterns are worth knowing before you handle a code:

- **Validation precedes touching a byte.** A malformed request is refused
  without opening the container, which is why a refusal usually leaves the tree
  byte-identical.
- **One writer owns a run.** A whole command holds the accepted container lock for
  its full length. A second writer is refused, and a reader that would have to
  wait for a lock it does not own also refuses rather than stealing it or
  removing it.
- **An already-bound fact is refused, not amended.** Restating a start with a
  different declaration yields `DECLARATION_ALREADY_BOUND`; restating it
  identically yields a state-transition refusal. Neither edits the captured
  declaration.

## What is not available in this release

Say these plainly to anyone reading this document:

- **The lifecycle commands are not a packaged product release.** This checkout
  does expose a command line: `cli/benchboard.mjs` offers `start`, `stop`,
  `status`, `freeze`, `reconcile` and `reset` over precisely the API documented
  above — see [CLI.md](CLI.md), and [CLI_RESET.md](CLI_RESET.md) for reset. The
  CLI is checkout development tooling: it is not an install step, a public
  package or a release, and this guide remains the exact reference for the
  programmatic modules. (The earlier initialisation-only handler
  `cli/init.mjs`, documented in [INITIALIZATION.md](INITIALIZATION.md), still
  exists alongside it.) There is no supervisor, watchdog or deadline enforcement
  behind either surface.
- **Lifecycle operations do not score a submission.** A frozen submission is a
  verifiable, immutable byte set with its proof; it is not a score, a rank, or a
  quality verdict. The separate [Evaluation API](EVALUATION.md) runs
  established stages on verified frozen submissions and returns stage evidence.
  At S1 it still returns no score — that is the historical S1 result shape,
  whose top-level `score` field stays `null` by design in the current result as
  well. A current successful `evaluateFrozen` additionally returns the
  validated `bundle.score` from the unchanged executable scorer, with versioned
  evidence bundles and Report integration already in place
  ([REPORTING.md](REPORTING.md)).
- **There is no supervisor, watchdog, or deadline enforcer**, and none is implied
  by the presence of `declaredCeilingMinutes`.
- **There is no hosted service** — no leaderboard, account system or backend — and
  no network access anywhere in this surface.

## Limits, stated honestly

- **Cooperative stop only.** The recorded assurance is `operator-attested` and
  `enforced: false` because that is exactly what it is. A run whose participants
  do not cooperate is not stopped by this software.
- **A declared ceiling is decoration.** Recorded, never observed, never acted on.
- **A clock that reports nothing is not an error.** It produces `null` fields and
  the refusal to publish an unobserved instant. There is no retry, no fallback
  clock, and no substituted value.
- **An interrupted freeze stays interrupted until you decide.** Orphan and foreign
  bytes are preserved by every recovery path. Cleanup of preserved material is a
  separate, deliberate act by whoever owns the container; the contract will not
  infer it. It is also an act with a precondition: nothing this release publishes
  is a deletion target, so removal is only ever correct for bytes this contract
  itself created and can prove by identity. Any byte that is not provably its own
  is left in place — a published submission, a retained proof, a foreign entry in a
  journal directory, and a destination directory that merely exists (see
  *Reset*: even an empty one is foreign) are all left untouched by every refusal.
- **A run whose authority and projection disagree is reported, not healed.** A
  stop journaled without its projection commit reports `inconsistent` with a
  finding that names it, and reconciliation refuses to advance such a run. What
  the read does not do is repair it, and what it does not do is decide the run's
  next identity for you. The matching write gate is closed too: `stopRun`
  consults the journal through the same coherence comparison, not the projection
  alone, so a repeat `stopRun` over a run that journals a stop its projection
  never received is refused `RECOVERY_REQUIRED` before the clock is read or any
  byte is written. The refusal is a report, not a repair — clearing the
  disagreement still takes an explicit reconciliation decision.
- **Immutable means never rewritten, not tamper-proof.** Recomputation detects a
  changed byte and reports it; it cannot undo one. Correcting a published
  submission means a new run.
- **Two hash domains.** Byte digests and record-identity digests are not
  interchangeable; do not compare one against the other.

## Testing and the public boundary

The acceptance suite for this document is
`tests/lifecycle/acceptance.test.mjs`, which drives the released modules through
the full chain — initialise, start, attested stop, freeze, verify, a later live
edit, then reset — together with the readiness, clock, refusal,
reconciliation-fate, selection-privacy and isolated-copy boundary cases. Run it
with the standard Node test runner:

```text
node --test tests/lifecycle/acceptance.test.mjs
```

It writes its scratch under `BENCHBOARD_TEST_TMP` /
`BENCHBOARD_TEST_SCRATCH_ROOT` when those are stated, and inside the repository
otherwise; it never writes beside the system temporary directory and never reads
or writes the read-only starter tree.

The public/private boundary of the products themselves is unchanged by this
release: a published snapshot selects application bytes and excludes the state
root and the coordination directory, and no owner-only, evaluator or hidden-test
material is part of a published submission.
