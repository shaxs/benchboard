# End-to-end manual workflow without historical tooling

This guide walks the full manual chain a person drives through the checkout
command line today, from a fresh container to a safe exported report and a
reset copy: init, start, your own work, an independent stop of the agents you
ran yourself, stop, freeze, evaluate, an export of the pending baseline, the UI
template, your completed review, attachment, the reviewed export and a reset.
It is practical guidance for the current development checkout — not a release
instruction, not platform qualification, and not itself a runtime proof. The separately
executed production tests supply that bounded evidence. The quickstart
[QUICKSTART.md](QUICKSTART.md) and its synthetic command recipe
[MANUAL_COMMANDS.md](examples/MANUAL_COMMANDS.md) are the short form; the
detailed per-command references are linked throughout and win on any detail.

Nothing here launches an agent for you, stops one for you, or installs
anything, and the UI and export steps start no server or browser — evaluate
runs the installed tools and its own bounded loopback services
([CLI_EVALUATION.md](CLI_EVALUATION.md)). This chain follows no historical
runner script (the old
self-validation, watchdog, reset/evaluate/supervision procedures under
`runner/` are historical, not current workflow). The manual harness is cooperative by design: the declared ceiling
is unenforced, the stop attestation is operator-asserted, and elapsed time is
a local monotonic observation where available — these timings are not
controlled benchmarking and a stop record is not proof that processes stopped.

## Before you begin: roots, identities, prerequisites

- **Invoke the CLI as** `node cli/benchboard.mjs COMMAND --long-flag VALUE`.
  Long options only; no positional operands, no `=` syntax, no duplicate
  flags, no shell-specific environment-variable syntax in the documented API.
  `--help` (and the `-h` alias) prints help and does no operational work.
  The full grammar and the exit-code table live in [CLI.md](CLI.md).
- **A run container is what `--run` names** — the container directory, never its
  workspace subfolder. The container holds the participant workspace and the
  private `.benchboard/` state root as published siblings; folder names on disk
  are not themselves identities ([CLI_CONTEXT.md](CLI_CONTEXT.md),
  [INITIALIZATION.md](INITIALIZATION.md)).
- **Destinations you create must be fresh** absolute paths under an existing
  ordinary parent, outside the repository checkout. Init and reset refuse a
  destination that already exists; there is no overwrite or force mode.
- **Identities are separate facts.** The challenge version, the CLI tooling
  build and the executed evaluator are three distinct identities
  ([CLI_CONTEXT.md](CLI_CONTEXT.md)). Changed development tooling can make an
  old run binding refuse rather than silently upgrade; run the older work from
  a matching checkout instead ([CLI_RESET.md](CLI_RESET.md)).
- **Evaluation prerequisites are preexisting:** the canonical installed
  evaluator dependencies (the starter `node_modules`, the repository's root
  libraries) and an installed Chromium must already be present. Evaluate uses
  the installed tools and its own bounded loopback services; UI and export
  start no services. A missing browser at evaluate time surfaces as
  infrastructure (exit 5). Do not expect the CLI to download or install these,
  and do not use historical owner scripts to prepare them. Installed
  evaluator-side dependencies are a separate matter from a participant
  workspace's optional dependencies, which are the dependency-mode question
  below.

## The chain at a glance

In order: `init` → `start` (declare) → your own work inside the workspace, if
you choose to run agents yourself → stop those agents independently → `stop`
(attest) → `freeze` → `evaluate` → `export` (baseline, still pending review) →
`ui --template` → your evidence and worksheet completion → `ui` (attach) →
`export` (the reviewed child you name) → optionally `reset` into a fresh
container. Keep the IDs each summary returns; the later commands consume them
as `--evaluation` / `--report` values. Do not parse private envelope records or
pick "the most recent file" — use the returned identifiers.

## 1. Init a fresh container

```
node cli/benchboard.mjs init --output "<ABSOLUTE_FRESH_CONTAINER_PATH>"
```

- The destination must be absolute and fresh with an existing parent; a
  relative `--output` is an integrity refusal (exit 4), not a silent
  normalization.
- **Dependency modes** (shared by `init` and `reset`; see
  [INITIALIZATION.md](INITIALIZATION.md) for the full behavior): `none` is the
  default and installs nothing for the participant workspace. `prepared`
  requires both an explicit `--prepared-root` and an explicit `--source-root`
  with a lock-provenance-compatible cache; `install` is operator-explicit and
  additionally requires `--scratch-root` and `--npm-executable`. There is no
  automatic fallback between modes. The `--source-root` here is dependency
  input — it is not the run's benchmark source. This guide teaches no
  install/download commands for any of it.
- The run's initial participant workload is the verified 26 exported starter
  files, materialized from the installed challenge into an owned temporary
  source directory with its own retention rules
  ([CLI_CONTEXT.md](CLI_CONTEXT.md)).
- Init explicitly declares the manual harness and mints a new architecture ID.
  It accepts no harness, model or worker-count flags. Save `runId` and
  `manifestId` from the summary. Configuration you do not state stays unknown
  (`null`) — never an invented model, count or zero. The manual harness is the
  sealed exception: it is init's own explicit statement, carried forward (see
  step 2).

## 2. Start, work, and your own stop

```
node cli/benchboard.mjs start --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --harness manual --model "<MODEL_LABEL>" --worker-count <POSITIVE_INTEGER> --declared-ceiling-minutes <POSITIVE_INTEGER>
```

Start records your declarations immutably and launches no agent. Init sealed
this container's harness as `manual`, so the example states `manual`; a
conflicting explicit harness label is a state refusal (exit 3). If you omit
`--harness` the run inherits that sealed manifest fact rather than leaving the
harness unknown. The model label (at most 512 characters) is coverage you
state, not model inference; worker count is a declared positive integer; the
ceiling (whole minutes within 1..1440, tighter if the challenge says so) is
declared and unenforced. An omitted model, worker count or ceiling stays
unknown (`null`) — the harness is the one field inherited rather than unknown.

Then, if a real user chooses to, you run the agents yourself **within the
workspace** and, when they are finished, stop those processes yourself,
independently of this CLI. The CLI carries no survey of running processes and
terminates none.

```
node cli/benchboard.mjs stop --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --operator "<OPERATOR_IDENTITY>" --agents-stopped
```

`stop` records the attestation. The operator identity is private material, 2
through 256 characters. A successful stop records assurance
`operator-attested` with enforcement false. Details in
[MANUAL_LIFECYCLE.md](MANUAL_LIFECYCLE.md).

## 3. Freeze — the recorded route and the clockless route

Normal freeze (run state `STOP_RECORDED`) takes just `--run` and reuses,
byte-identically, the attestation the recorded stop already journaled:

```
node cli/benchboard.mjs freeze --run "<ABSOLUTE_RUN_CONTAINER_PATH>"
```

The separate explicit route for a run that never started (state
`INITIALIZED`) is fully attested and clockless:

```
node cli/benchboard.mjs freeze --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --clockless --operator "<OPERATOR_IDENTITY>" --agents-stopped
```

On this route elapsed time and stop assurance remain unavailable (`null`) —
never a manufactured value or a zero. The default route reuses the recorded
timing/stop facts; the clockless route states that there are none to reuse.
Freeze never terminates agents and silently repairs no state. A stray
`--operator`/`--agents-stopped` without `--clockless`, or a bare `--clockless`,
is a usage refusal (exit 2) before any state comparison; route/state mismatches
are state refusals (exit 3). The freeze summary (snapshot ID, frozen submission
ID, tree digest, `frozenAt` with its named provenance, elapsed as known value
or `null`, stop assurance and enforcement) is private local output; the
provenance distinctions are in [CLI.md](CLI.md).

## 4. Status and the supported recovery limits

`status --run` is a diagnosis, not a repair and not a results-context creator.
It separates the lifecycle state from its diagnosis (`consistent`,
`incomplete`, `inconsistent`), can read incomplete or inconsistent verified
views and retains nulls for unknown values. It is not globally write-free: the
accepted read APIs may take locks and write internal lock metadata.

If an operation was interrupted, `reconcile` is the single supported recovery,
and it is exact: the operation that is pending now, the exact journaled intent
event digest, an operator identity, and a supported disposition
(`COMPLETE`/`LEAVE_AS_IS` for start/stop, `COMPLETE`/`KEEP_INTERRUPTED` for
freeze). A historical start or stop intent does not repair a later pending
freeze. The event digest comes from the accepted programmatic lifecycle
reader's journal view ([CLI.md](CLI.md) §reconcile); do not extract it from
folder names, invent or guess one. There is no CLI-only intent reader and no
universal repair command, and this guide teaches no lock-stealing, journal
editing or residue-deletion recipes — preserve retained evidence for accepted
programmatic inspection. See [MANUAL_LIFECYCLE.md](MANUAL_LIFECYCLE.md) for the
recovery vocabulary and its limits (no orphan-lock takeover, no deletion of
foreign material, no automatic retry, no mid-operation rollback).

## 5. Evaluate the frozen bytes

```
node cli/benchboard.mjs evaluate --run "<ABSOLUTE_RUN_CONTAINER_PATH>"
```

- Evaluate requires an already verified frozen selection; it never freezes
  automatically and never evaluates the live workspace. C4 consumes the frozen
  copy, not later live edits. Add `--snapshot "<SNAPSHOT_ID>"` when the frozen
  selection is ambiguous — there is no implicit latest.
- The first `--results-root` may bind an external sibling root; the default is
  `<run>.benchboard-results`. Once bound, a later override must match it. Each
  attempt, output directory, evaluation and report is fresh.
- Optional bounds: `--timeout-ms` 1–3600000 and `--max-output-bytes`
  256–16777216, plain positive decimal integers; omission preserves the
  accepted C4 defaults.
- The successful summary reports `attemptId`, `runId`, `manifestId`,
  `snapshotId`, `frozenSubmissionId`, `evaluationId`, `reportId`,
  `reportDigest`, `status`, `evaluatorExecution`, `humanReview`, `agentOutcome`,
  `enforcement`, `enforced`, `automated`, `humanUI`, `quality` and
  `workspaceMatchesFrozenInventory`. Keep `evaluationId` and `reportId`.
- A successful automated baseline has `humanUI: null` and `quality: null`
  while review is pending. An automated score of `0` is a real number, distinct
  from an unavailable `null`. The executable automated scorer's maximum is 80;
  the optional human UI rubric caps sum to 20. After a completed valid
  self-assessment the combined quality is at most 100 — a valid review's score
  is capped at 100, not guaranteed to reach it. Infrastructure results carry no
  score, and a no-output preflight can keep a known evaluation ID with no report
  or output when bookkeeping succeeds. If execution association fails after C4
  returns, state remains incomplete rather than assigning an evaluator
  disposition from a bookkeeping error.

The identity-association, no-output and retained-fate detail is in
[CLI_EVALUATION.md](CLI_EVALUATION.md).

## 6. Export the baseline while review is pending

```
node cli/benchboard.mjs export --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --evaluation "<EVALUATION_ID>" --output "<ABSOLUTE_FRESH_PENDING_EXPORT_DIR>"
```

The named evaluation selects its committed baseline — never a latest child.
With no completed review, the safe files export `humanUI` and final quality as
`null`: an honest "not yet reviewed", distinct from a completed review that
genuinely scored zero, which exports that zero. The destination must be fresh;
see section 9 for what the three files are and which material is private.

## 7. Generate the bound, invalid template

```
node cli/benchboard.mjs ui --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --template --evaluation "<EVALUATION_ID>" --output "<ABSOLUTE_FRESH_TEMPLATE_FILE>"
```

(Alternatively select with `--report "<PARENT_REPORT_ID>"`; if both selectors
are given they must resolve the same successful baseline, resolved after the
state reads.) Template mode forbids `--input`/`--review-root`; the written
template is bound to the selected parent and is **intentionally invalid**:
blank reviewer, review ID and time, `baselineCompared: false`, no evidence,
seven `null` scores, blank notes, no improvements. It awards no points, and the
blank tracked `UI_WORKSHEET.json` in this folder has placeholder identities and
can not be attached as shipped.

## 8. Prepare the human evidence, then attach

The evidence is human-provided product of your own viewing workflow; nothing
in this chain captures or serves it for you, and this guide copies no private
spec procedure. The compact checklist:

1. **Capture the intended before/after views yourself.** For each logical
   width 1440, 1024 and 768 (at height 1000), take the board view and the
   drawer view of the starter and of the submission: twelve views in total.
   You choose how to run the two workloads; the UI steps here (template
   generation and attachment) and this manual evidence preparation start no
   browser and capture nothing for you. Evaluation's automated browser work
   through the installed Chromium is a separate activity: it is not your
   human screenshot capture and no proof of human judgment.
2. **Create twelve ordinary files** in a fresh evidence directory, named with
   symbolic logical artifact IDs (for example `submission-1024-drawer`, never
   host paths). Record each file's actual byte count and its lowercase
   SHA-256 in the worksheet's evidence list so the recorded metadata matches
   the files: two targets (`starter`, `submission`) × three widths × two
   views.
3. **Fill the worksheet:** real `reviewer`, `reviewId` and a canonical UTC
   `reviewedAt`; `baselineCompared: true`; the seven category scores each
   within its cap (polish 5, hierarchy 3, board 3, drawer 3, feedback 2,
   responsive 2, consistency 2 — human total 20) with a concrete note per
   category; and for every positive score a matching positive improvement
   pair naming the same width and view on the two targets. Inherited
   presentation earns zero, and zero needs no improvement.
4. **Attach:**

```
node cli/benchboard.mjs ui --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --input "<ABSOLUTE_COMPLETED_WORKSHEET_FILE>" --review-root "<ABSOLUTE_EXISTING_EVIDENCE_DIR>"
```

Attachment takes no template/output/evaluation/report overrides; the
worksheet's bound parent report ID bootstraps the exact committed executed
baseline, and the accepted layer re-checks every other binding and physically
rehashes the twelve ordinary files. The parent must be a successful bound
baseline: an infrastructure report, or a child named as a parent, is refused —
a refusal is not a zero. Software checks the metadata combinations and the
bytes; it verifies no depicted pixels, image dimensions, reviewer identity or
visual merit. A completed all-zero worksheet is a real reviewed zero; a blank
template is not zero, it is invalid.

Attachment publishes a distinct immutable child with a fresh report ID; the
parent, snapshot, evaluation and saved references are not rewritten, and no
"latest" child is ever chosen for you. The exact schema, caps and timestamp
form are in [HUMAN_UI.md](HUMAN_UI.md) and [CLI_UI.md](CLI_UI.md); this guide
adds no second schema.

## 9. Export the reviewed child, and the privacy boundary

```
node cli/benchboard.mjs export --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --evaluation "<EVALUATION_ID>" --report "<REVIEWED_CHILD_REPORT_ID>" --output "<ABSOLUTE_FRESH_REVIEWED_EXPORT_DIR>"
```

An explicit `--report` must be that evaluation's exact baseline or its direct
reviewed child — an explicit choice, never an implicit latest. A committed
infrastructure report may export its quality as unavailable (`null`). Both
export destinations in this chain (the pending one in section 6 and this
reviewed one) must be fresh: neither may reuse the other's directory or any
existing path.

The export directory is fresh, external and disjoint from the repository, the
run and the entire results root, and holds exactly `report.json`,
`report.txt` and `EXPORT_COMPLETE.json`. Both content files are the accepted
C5 privacy-safe projection (each bounded to 16 MiB); the closed marker carries
the fixed safe-export identifiers (its `kind` and `schemaVersion` constants)
plus the pair's filenames, byte counts and SHA-256 values — no raw run,
report or evaluation identities, no root paths and no prose. Success
requires exact membership, ordinary owned files, JSON/text parity and hash
read-back — the marker's presence alone is not completion. The projection
keeps its fixed structured disclosures: pseudonymized opaque references,
provenance records and the standing notices with their correlation limits;
exporting adds no anonymity and no authentication. Read
[EXPORTS.md](EXPORTS.md) before sharing anything.

**What is private:** every stdout summary (init cleanup paths, status
declarations, evaluation and export summaries included), raw Reports,
completed worksheets, review-root contents, storage envelopes, reviewer
identities, logs and arbitrary configuration. **The sharing boundary** is the
separately written projection pair plus the closed marker. A failed **export
publication** keeps its rules: partial, foreign or uncertain bytes stay, only
exact proven-owned files may be cleaned, no automatic repair runs, a late
error can still leave verified complete output, and no public verify-export
or repair command exists — preserve the directory and inspect programmatically
([CLI_EXPORT.md](CLI_EXPORT.md)). A failed
operation in the other commands follows its own layer's fates (the journal,
container and retention rules of the sections above and the error table
below), not the export cleanup protocol.

## 10. Reset into a fresh container

```
node cli/benchboard.mjs reset --run "<ABSOLUTE_OLD_RUN_CONTAINER_PATH>" --output "<ABSOLUTE_FRESH_CONTAINER_PATH>"
```

Reset creates a brand-new run container with fresh `runId` and `manifestId`
through the accepted initialization path, carrying the old architecture
identity and the sealed manifest's verified configuration forward — later
values you stated only to `start` remain lifecycle evidence and do not become
newly sealed configuration. The new run inherits no timing or declaration
events. The NEW dependency request defaults to `none`; nothing copies the old
workspace's edited dependencies. Reset refuses active, incomplete, locked,
overlapping or existing destinations and does not reuse or delete the old
workspace, snapshots, evaluations, reports, results or CLI references. This is
a reset into a new container, not destructive cleanup; the old tree is
unchanged ([CLI_RESET.md](CLI_RESET.md)).

## Error categories and what a failure leaves behind

The exit codes are categories, not fate reports:

| Exit | Category | In practice |
| --- | --- | --- |
| 0 | success | The command returned its actual success summary. |
| 2 | usage | Arguments do not match the grammar; shape checks run before selected state is read, while selectors resolve after the state reads. No command work started. |
| 3 | state | Missing prerequisites or state conflicts (non-fresh destination, lock conflict, refused transition, operation pending reconcile). |
| 4 | integrity | Verified integrity/safety refusal (failed byte, binding or path verification). |
| 5 | infrastructure | Operational infrastructure failure; a missing browser at evaluate time is this category. |
| 130 | cancellation | A handled cancellation; `evaluate` awaits the bounded C4 cleanup when one is returned. |

A failure can leave valid committed evidence or incomplete retained evidence;
a nonzero exit does not prove nothing landed, and no failure should be read as
"no writes happened" or as a readable `INCOMPLETE` state — a late error may sit
on top of a fully committed report or terminal, and a partial state may make
authoritative reads refuse. There is no automatic repair or retry; the
supported moves are `status`, the exact `reconcile` for journaled operations,
and preserved evidence for accepted programmatic inspection. Requests to
cancel are cooperative: a signal arriving after a commit does not roll that
commit back or relabel it, there is no in-flight C5 rollback promise, and no
physical operating-system signal-delivery qualification is claimed.
`SIGINT` handling and the per-command coverage notes are in
[CLI.md](CLI.md) §Cancellation.

## Path discipline for the new paths

New template outputs, worksheet inputs, review roots and export destinations
must be absolute ordinary spellings; explicit dot segments, Windows
alternate-stream/device/namespace and UNC forms, wildcard punctuation and
trailing-dot or trailing-space aliases are refused before their file IO. This
is conservative path policy, not full operating-system alias coverage and not
platform qualification; the selected run's own normalization is unchanged. The
worksheet input is read-only, single-link JSON bounded at 2 MiB; new template
outputs and review roots must be disjoint from the repository, the run and the
entire results root. Private writes use exclusive creation with exact owned
read-back; on a failed write, partial or foreign or uncertain material stays.
An exclusive-open race can classify as infrastructure (exit 5).

## What this workflow is, and is not

Development-only, in-checkout self-assessment. Nothing here is a release or
publication step, a platform or security qualification, an authentication of
any reviewer, or a benchmark run performed by the CLI itself. The synthetic
examples in [MANUAL_COMMANDS.md](examples/MANUAL_COMMANDS.md) are command
recipes, not recorded evidence. The local [production-chain test](../tests/cli/production-chain.test.mjs)
has passed real evaluation/repeat, synthetic UI protocol attachment, safe exports and fresh reset.
The [prerequisite](../tests/cli/production-failures.test.mjs) and
[handled-cancellation](../tests/cli/production-cancellation.test.mjs) tests have also passed.
Cancellation uses IPC emission into the installed listener, not physical operating-system signal
qualification. These tests are the bounded runtime proof, not this guide or real human judgment.
