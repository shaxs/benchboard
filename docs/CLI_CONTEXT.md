# Installed context and source guide (development-only)

This guide describes the identity and context layer that the checkout CLI in
this repository builds before any run work. Everything here is local,
development-only self-assessment material in this checkout: it certifies
nothing, publishes no release, and provides no operating-system sandbox or
authentication. The command surface itself (commands, options, exit codes) is
documented in [CLI.md](CLI.md); run initialisation and the run container are
described in [INITIALIZATION.md](INITIALIZATION.md), and the publication and
safety limits of the record layer in [PUBLICATION.md](PUBLICATION.md).

## Who supplies the identities

The layer has two halves with two sources:

- **Installed-tooling identity** comes from this checkout itself. Nothing an
  invoker supplies selects it: the loader reads fixed descriptor records under
  the checkout root (`cli/installation.json`, `cli/installed-assets.json`,
  `release/inventory.json`, `version.json`) purely because of the module's
  location. There is no discovery of a configuration, environment variable or
  parent directory, and no historical runner inputs are involved.
- **Run identity** comes from a caller-nominated **run container**. Like the
  other run surfaces, `--run` selects the container, not the workspace: the
  workspace and the privately maintained `.benchboard/` state root live inside
  it as published siblings (see INITIALIZATION.md §Container layout), and
  folder names on disk are not themselves identities.

## The installation descriptor and what it binds

`cli/installation.json` is a development-installation descriptor (kind
`benchboard.cli.development-installation.v1`) with `developmentOnly: true`,
`schemaVersion: "1.0.0"`, and three explicit version domains:

| Field | Value | Domain |
| --- | --- | --- |
| `toolingVersion` | `0.1.0` | the tooling itself |
| `challengeVersion` | `1.0.0` | the neutral challenge, as projected into the ChallengeIdentity record |
| `evaluatorVersion` | `1.0.0` | the neutral evaluator |

These are descriptor domains. They are separate from the preserved candidate
lineage carried by `version.json` (the `1.0.0-candidate.9` candidate challenge
*version*, whose status is a separate field — `CALIBRATION_PENDING`): the
descriptor's neutral versions and the candidate identity are recorded side by
side and are not interchangeable.

The descriptor additionally pins four digests of this checkout's challenge
material — the workload tree (`workloadDigest`, over `starter/`), the public
PRD, the visible starter tests, and the fixtures — and names its companion
assets manifest at `cli/installed-assets.json`. The assets manifest (kind
`benchboard.cli.development-assets.v1`) lists the directories
(`cli`, `packages/core`, `packages/evaluation`, `packages/results`,
`schemas`, `adapters/manual`) and top-level files
(`package.json`, `package-lock.json`, `release/inventory.json`,
`version.json`) that constitute the installed code.

What the loader does with these is verification, not trust:

- It re-reads the canonical bytes and checks each record's exact key set, kind
  and constants. A missing or inconsistent input is refused; nothing is
  defaulted or smoothed. Malformed or interrupted records yield no success, and
  there is no universal exception wrapper around the raw checks.
- It returns the *actual* evaluator identity computed from the evaluator's own
  code, alongside a frozen outer return with frozen C1 identity records; the
  actual-evaluator value itself is returned as computed, not deep-frozen. It is
  recorded separately from the C1 evaluator binding: the C4 semantic/package
  identity and the C1 identity domain stay distinct.
- It builds a frozen copy of the release inventory's declared 26-file
  participant workload and rejects the installation if the tree, its digest,
  or the release profile digests disagree with the descriptor.
- It computes a **selected installed-code identity** over the declared asset
  manifest — every entry of the listed directories plus the named files,
  hashed, with the manifest itself bounded (at most 2048 entries, unique
  paths) — and projects tooling/evaluator/challenge identity records over
  those inputs.

That selected identity is a development fingerprint of the selected assets in
this checkout, computed when the loader runs over the current selected
installed bytes — not a bundled baseline identifier recorded by release
tooling, and not compared against an immutable release baseline. A valid
changed development source therefore yields a different tooling identity,
while missing or inconsistent canonical inputs are still refused. It is
not an independently authenticated Git commit and not a release; the descriptor
currency is a local consistency check, not a publication approval.

### A prerequisite when re-exporting from the source root

The frozen challenge object the loader returns carries
`challenge.sourceRoot` — this checkout's `starter/` tree — as the **verified
owner definition root**. That is an identity fact, not a statement that the
tree is a ready, exact C2 export source in every state: if prepared
`node_modules/` or `dist/` directories exist under it, the accepted C2
exporter correctly refuses those directories, producing no publishable
workload. The outer `init` adapter now uses `prepareChallengeSource` from
`cli/challenge-source.mjs` to materialize exactly the verified 26 ordinary
manifest files into an exclusively created external temporary directory. It
rechecks raw bytes against the sealed inventory and delegates the actual run
publication to unchanged C2; no owner dependencies are removed or modified.

The temporary source is not the participant workspace. Its disposal checks
directory ancestry, created-object identities, complete file/directory membership
and file bytes, then removes only proven-owned entries without a recursive
delete. Foreign insertions, changed/replaced files or replaced ancestors cause
retention rather than deletion through an untrusted path. A concurrent foreign
insertion during cleanup can leave partial owned cleanup plus retained residue;
no atomic filesystem or adversarial containment guarantee is made. Preparation
faults retain partial scratch with structured private `sourceResidue` context;
the default diagnostics do not serialize it.

Two limits around the selected temporary parent are current behavior. First,
`prepareChallengeSource` requires the checkout installation and the ordinary OS
temporary parent to be disjoint both physically (realpath) and lexically, so a
checkout placed under that selected temporary parent is currently refused; the
preparation does not silently choose another temporary root and does not weaken
containment to proceed. The temporary source prefix is `bb-cli-source-`, under
the OS temporary directory. Second, when a run fails while the temporary source
is retained, the original error is what the caller sees and the disposal result
is not reported: the controlled diagnostic does not name the retained scratch
individually. Operators inspect any retained material manually; there is no
automatic wildcard deletion and no generic CLI cleanup or recovery command for
it.

The local init summary reports `sourceCleanup: { status, root }`, where status is
`removed` or `retained`. A retained temporary source does not erase a C2 run
that already initialized successfully. The cleanup result is private local
bookkeeping, not an export or automatic permission to remove retained material.
Never change the challenge or present a staged test copy as production output.

## Opening a selected run

`openSelectedRun(runPath)` is the bootstrap only. It takes the run-container
path. From that existing container it reads the C1 run envelope at
`<run>/.benchboard/state/run.json` through the bounded ordinary-file reader,
validates the record shape, and re-opens the run with the manifest's own
`runId`, `manifestId` and self-digest as the identity terms, so C1 validation
and `openRun`'s existing verification of the seal and the bound roots govern
acceptance rather than any folder name. It then confirms the opened roots are
exactly the container's `workspace/` and `.benchboard/` and returns the
accepted opened-run fields together with a frozen `request` record holding
  `runRoot`, `runId`, `manifestId` and `expectedDigest` — the selected root plus
  the identities and digest read from the manifest. The `runRoot` is the
  container path in its canonical absolute form, so what comes back is the
  helper's result shape, not the caller's raw string.

This is cooperative integrity, not authentication: it binds the record to the
run, but it makes no claim against a person deliberately rewriting local
records.

## The results context record

A selected run may have a **results context** that names where evaluation
attempts and the report store live for that run. The record kind is
`benchboard.cli.results.v1` and its closed field set is defined by
`schemas/cli-state.schema.json`: `contextId`, `runId`, `manifestId`,
`manifestDigest`, `runRoot`, `resultsRoot`, `attemptsRoot` (`attempts/`
under `resultsRoot`) and `storeRoot` (`store/` under `resultsRoot`). The same
schema file defines the `benchboard.cli.attempt.v1` and
`benchboard.cli.attempt-terminal.v1` record shapes, and
`cli/attempt-records.mjs` now holds internal composition helpers over them:
`reserveEvaluationAttempt`, `finishEvaluationAttempt` and `readEvaluationAttempts`.
Production `evaluate` now composes these helpers with real C4 evaluation and
C5 baseline publication; see [CLI_EVALUATION.md](CLI_EVALUATION.md). Context
work itself creates no score, timing or completed evaluation, and malformed or
interrupted records are never promoted into one. Explicit UI-review commands
and safe export also use the exact executed baseline association. Neither is an
automatic context side effect.

- **Reservation (`reserveEvaluationAttempt`).** It needs an existing bound
  results context and a verified C3 frozen selection (exact `snapshotId` and
  `frozenSubmissionId` fields, verified through the C3 freeze check). It writes
  a C1 immutable start record binding context, run, manifest, snapshot,
  submission and a fresh `outputRoot` under `attempts/`, but it does not create
  the evaluation output directory. No quality or success is invented; repeated
  reservations get distinct identifiers and outputs.
- **Finalization (`finishEvaluationAttempt`).** It checks the closed disposition
  shape (exact `status`, `evaluationId` and `reportId` fields), rechecks the
  context and start bindings, and runs while holding the C1 resultsRoot lock:
  inside that serialized window it enumerates and validates the existing
  attempt records and refuses a `reportId` or `evaluationId` that is already
   assigned to another terminal record or unfinished execution intent. Enumeration rejects an existing
  duplicate non-null report or evaluation assignment it encounters. A duplicate
  terminal for the same attempt is a different refusal path: C1 immutable
  identity rejects re-publishing the attempt's terminal record, rather than
  overwriting the existing record. When a report is supplied it also verifies that
  report's run, manifest, snapshot, submission, evaluation and digest bindings
  and expected execution class. It reads a committed C5 report and physically verifies its
  artifacts under the attempt's `outputRoot`, only when a `reportId` is
  supplied; a no-report infrastructure, refusal or cancellation terminal does
  not read a report. A `SUCCEEDED` terminal always requires a committed
  matching baseline and artifact verification, and only then may an immutable
  terminal record advertise success.
- **Reads (`readEvaluationAttempts`).** Each entry is `{ start, terminal }` with
   an additional `execution` only when its immutable record exists; a
  null `terminal` means the attempt is incomplete. The read re-reads the
  context and the C1 start and terminal records and rechecks the C5 committed
  report and digest bindings — reference-only checks over the records — but it
  does not reverify the physical evaluation artifacts on later reads. The
  physical artifact verification described above happens at finalization.

The terminal status vocabulary is `SUCCEEDED`, `INFRASTRUCTURE`, `REFUSED` and
`CANCELLED`. No-report facts keep `reportId` and `reportDigest` null, and
`evaluationId` may be null for an unavailable-infrastructure or refusal result;
a success requires a non-null `evaluationId` and a committed matching baseline.
The underlying C3/C5/C1 errors, or a `CommandError`, propagate internally —
there is no universal wrapper and no private exception-text export.
A missing, altered, uncommitted or wrong-run report refuses a success
reference. No points or raw diagnostics enter these companion records. These
helpers are local self-assessment bookkeeping, not producer or reviewer
authentication and not power-loss durability, and a C5 read may create lock or
storage metadata — a reference read is not described as write-free.

### Returned execution and publication intent

`recordEvaluationExecution` writes a versioned `benchboard.cli.execution.v1`
record at `cli-attempts/<attemptId>/execution.json`, using C1 immutable storage.
It verifies the supplied results binding before taking a write lock there,
captures the closed returned facts before awaiting, then rechecks identities
and uniqueness under that root's single lock. The record binds the start's
context, run, manifest, snapshot, submission and output root to the returned
evaluation ID, evaluator execution class, and planned report ID or `null`.
It is written before report creation/publication; no report digest is invented
at that stage. A later terminal must agree with any present execution record.
Legacy S2 terminals without execution remain readable, but they are not
retroactively assigned a producer association by adding an intent after completion.

Status exposes the intent as an optional, separately labeled
`publicationIntent`. An `INCOMPLETE` attempt with a planned report ID is not a
committed Report or a success. Report creation or publication failures keep
the association already recorded without retrying, overwriting or repairing it;
a report may physically exist before a later indexing failure. A partial C1
terminal write can make authoritative reads refuse, and a late error can leave
a fully committed terminal that later reads verify. Do not infer fate from the
error or an orphan filename; only accepted reads establish what is available.
C1 reads verify the published envelope rather than final registry registration,
so a valid terminal can also remain readable after an interrupted registration,
without any automatic repair of that registry. Only a matching
terminal plus re-read committed C5 baseline establishes a completed CLI reference.
Explicit report selection also requires this execution association and rechecks
the selected frozen bytes and baseline artifacts. It never chooses a latest child.

These are cooperative local associations, not signatures, evaluator/reviewer
authentication, or proof against deliberate local record rewriting. Default
stderr remains static guidance, not raw evaluation logs, private causes or paths.

### Results-root layout

- Default results root: `<run>.benchboard-results` — a sibling directory named
  after the run container, outside the run's workspace and state roots.
- An explicitly supplied external alternative is accepted and, once recorded,
  the first binding fixes the location: later reads and rebinding resolve
  against the bound location.
- The results root contains `attempts/` and `store/`, plus a private
  `context.json` record. Separate `cli-attempts/` records hold start/terminal
   metadata and optional execution intents; `attempts/` holds actual evaluation outputs, not those records.
  The store's own metadata and the run-side binding
  envelope (`<run>/.benchboard/cli/results.json`, under the C1 storage
  registry, outside the workspace) also remain private local bookkeeping.

The `resultsRoot` must be disjoint from the installation root and the run
root. The `attemptsRoot` and `storeRoot` are children beneath the
`resultsRoot` (the runtime context checks fix them at `attempts/` and `store/` under it),
disjoint from one another and from the run and installation roots — they
cannot be pairwise disjoint from their own parent. The existing ordinary-file,
physical-path and disjointness checks described in PUBLICATION.md are applied
to the run, results, attempts and store roots at the observations each check
performs.

### Reading (`readResultsContext`)

- Before any binding exists, the read is **`null`** — unknown is `null`, not a
  guessed value — and it stays null until the run publishes its companion.
- Once bound, the read compares **both** stored bindings: the run-side
  companion envelope and the root-side `context.json`, validated against the
  schema and each other, with the run identity fields and derived subroots
  required to agree. It re-opens the run first (verifying the seal and bound
  roots) and uses the ordinary-file reader, so linked, extra-linked
  (`nlink !== 1`), non-ordinary and oversized inputs are refused at the
  observations it performs. The unchanged C1 immutable publication links the
  staged file to the target before removing the stage, briefly giving the
  target an `nlink` of two; a concurrent unlocked CLI reader can be refused
  during that interval. A crash in that window can retain the hardlink
  residue, and reads continue refusing it — there is no automatic cleanup or
  recovery of that residue, and the `nlink` check is not weakened to
  tolerate it. It writes no context records: no repair, no
  re-publication, no deletion and no score, timing or evaluation-record
  creation happens on a read.
- A bound record names the exact storage identity under the run-side
  registry; the store-side record read back must be canonical-identical with
  the run-side projection. Root creation writes **local metadata only** and
  never touches the participant workspace during these reads.

### Creating or reusing a binding (`ensureResultsContext`)

The write path reuses the C1 storage primitives — locking and immutable
record creation — rather than the C5 application publication protocol; a CLI
context record does not go through the C5 report-marker machinery that
PUBLICATION.md documents for the report layer.

1. The run is re-opened and re-verified, and the work proceeds inside the C1
   store's single lock for the run-side registry.
2. If a binding exists for the run, it is the value returned; an explicit
   external root that does not match the bound one is refused as a state
   error with the established binding left unchanged. The call is not
   write-free: by the time the check runs, the C1 lock metadata has already
   been touched.
3. When no binding exists, the results root is resolved — the supplied
   external alternative, or the default sibling — under the root checks above
   (including that a fresh reservation is refused if the path already
   exists). The **external results root is created first** with the private
   root-side metadata (`context.json`) published immutably, and only after
   that check passes is the **run-side binding published last**.

The ordering is deliberate: no run-side binding names a results root before
the root-side context record exists immutably underneath it.

**Failure, residue and disposition.** If creation fails part way through, the
incomplete material — a fresh directory tree, an external `context.json` not
yet referenced by any run, the root's `attempts/`/`store/` shells — is **not**
automatically deleted, overwritten, adopted by a retry, repaired or
freshened. A subsequent binding attempt refuses an already-present root
rather than reusing or clearing it. An existing unbound directory is not
adopted and a matching existing record is never overwritten. Righting that
situation is the run operator's action (i.e. an owner disposition of the
residue). Reconciliation is scoped, not generic: the CLI's future
`reconcile` command delegates C3 lifecycle recovery only, for its own declared
lifecycle operations; the C1 storage mechanisms (locking and immutable
publication) are reused underneath, but no generic C1/C2 repair command
exists, and arbitrary CLI results residue is out of its scope.

## Honest limits

- This is cooperative integrity over local, explicitly named paths — mutual
  verification of stored records, not authentication. It does not prevent a
  local process or user with filesystem access from rewriting the private
  records it observes; it only refuses records that fail its checks.
- The sealed location and byte checks refuse the tested foreign-path copy and
  identity substitutions, but they do not authenticate a physical container:
  an identical copy restored to the original recorded location, after the
  original was moved away, is not distinguished by these checks. This is a
  cooperative integrity limit, not an OS containment guarantee.
- There is no OS-level sandbox, no durable power-loss guarantee, no
  authentication of any party, and no public distribution story. The
  descriptor and manifests are development records, not a publishable release
  allowlist or an approval to expose evaluator internals.
- No repair, orphan-lock stealing or deletion is performed, and no
  interrupted failure implies success.
