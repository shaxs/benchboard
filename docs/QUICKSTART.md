# Quickstart — BenchBoard development checkout

This page walks one run through the checkout's CLI in the order the commands
are meant to be used: initialize a container, declare a manual start, stop on
your own attestation, freeze, evaluate, export what is safe to share, review the
UI privately, attach that review, export the reviewed result, and reset into a
fresh container. It describes the current development checkout and presumes the
local evaluation prerequisites are already prepared. It is not an installation
guide, not a public release, and not a runtime-proof claim: the production
command-chain runtime proof comes from separately executed tests, not this recipe.
The local [production-chain test](../tests/cli/production-chain.test.mjs) has passed
with real evaluation/repeat, synthetic UI protocol attachment, safe exports and fresh reset;
the synthetic UI files are not human judgment or screenshot capture.
For every flag and the exit-code table, read [CLI.md](CLI.md); for the human
review steps, [CLI_UI.md](CLI_UI.md) and [HUMAN_UI.md](HUMAN_UI.md); for a
synthetic copy of this sequence,
[examples/MANUAL_COMMANDS.md](examples/MANUAL_COMMANDS.md). The workflow-level
narrative is in [MANUAL_WORKFLOW.md](MANUAL_WORKFLOW.md).

## Before you start

- The CLI runs from this checkout. Help output needs no installed assets or
  packages, and there is no install step for the CLI itself
  ([CLI.md](CLI.md)). Readiness of a command is not a claim that the local
  evaluation prerequisites exist or that the run will succeed.
- A destination you pass to `init` or `reset` must not exist yet and must have an
  existing ordinary parent ([CLI.md](CLI.md)). A `reset` destination must
  additionally sit outside the repository checkout, outside the run you are
  resetting and outside that run's results root
  ([CLI_RESET.md](CLI_RESET.md)); examples here keep every fresh path outside
  the checkout as an external sibling.
- Evaluation is the step with the heaviest prerequisites: production `evaluate`
  uses already installed tools and Chromium together with its own bounded
  loopback services. The `ui` and `export` commands do not start them. A
  missing browser during `evaluate` surfaces as the infrastructure category
  (exit 5), not the state category.
- `--dependency-mode none` is the default and performs no participant dependency
  install. That default says nothing about the evaluation inputs: evaluating
  still needs the preexisting canonical starter, its `node_modules`, the root
  libraries and Chromium. Those are separate from the optional dependencies of a
  participant workspace. `prepared` needs both an explicit `--prepared-root` and
  an explicit `--source-root` with compatible cache provenance, and `install` is
  operator-explicit; there is no automatic fallback into either
  ([INITIALIZATION.md](INITIALIZATION.md)).
- This page gives no install or download command, and it gives no historical
  runner, self-validation, watchdog or supervision procedure. Those scripts are
  not this workflow.

## Containers, sibling roots and workload

- A run container holds the participant workspace plus the private run metadata.
  `--run` names the container, never the workspace inside it.
- Fresh containers and results roots go beside the checkout as external
  siblings under an ordinary parent you already have, for example
  `"<ABSOLUTE_PARENT_DIRECTORY>/<CONTAINER_NAME>"`. The results root defaults to
  `"<CONTAINER_NAME>.benchboard-results"` next to that container, and an explicit
  `--results-root` can bind an external sibling root on its first use; a later
  override must match the binding ([CLI_EVALUATION.md](CLI_EVALUATION.md)).
- Fresh template files, review roots and export directories must be disjoint
  from the repository, the selected run and the entire results root.
- `init` materializes the verified 26 exported starter files as the initial
  participant workload, from the currently installed challenge, in an owned
  external temporary source directory. The checkout's own `starter`,
  `node_modules` and `dist` are not modified
  ([CLI_CONTEXT.md](CLI_CONTEXT.md)).
- The challenge version, the CLI tooling build and the executed evaluator are
  three separate identities. Changed tooling can make a reset of an old run
  refuse rather than silently rebind it
  ([CLI_RESET.md](CLI_RESET.md)).

## The command order

The angle-bracket values below are generic placeholders. Where a step says to
retain an ID, copy the value that that command's own summary line reports; the
private storage envelope is not what you parse, and there is no most-recent-file
rule to fall back on ([CLI_CONTEXT.md](CLI_CONTEXT.md)).

### 1. Initialize a fresh container

```
node cli/benchboard.mjs init --dependency-mode none --output "<ABSOLUTE_NEW_CONTAINER_PATH>"
```

`init` declares the manual harness and a new architecture ID; it takes no
harness, model or worker-count flag. On success the summary reports `runId` and
`manifestId`. Retain them as `<RUN_ID>` and `<MANIFEST_ID>`, and use
`"<ABSOLUTE_NEW_CONTAINER_PATH>"` as `<ABSOLUTE_RUN_CONTAINER_PATH>` from here
on. Unknown configuration stays unknown: an unstated model or count is reported
as `null`, and it is not invented as a value or as zero
([MANUAL_LIFECYCLE.md](MANUAL_LIFECYCLE.md)).

### 2. Read the diagnosis

```
node cli/benchboard.mjs status --run "<ABSOLUTE_RUN_CONTAINER_PATH>"
```

`status` separates the lifecycle state from its diagnosis and keeps unknowns
`null`. It is diagnosis: it repairs nothing and it creates no results binding,
so with no results context the attempt list reads empty
([CLI.md](CLI.md)).

### 3. Record a manual start with explicit declarations

```
node cli/benchboard.mjs start --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --harness manual --model "<MODEL_LABEL>" --worker-count <POSITIVE_INTEGER> --declared-ceiling-minutes <POSITIVE_INTEGER>
```

`start` records the declarations and launches nothing. The harness shown is
`manual` because the outer `init` step states `manual` explicitly, and the
accepted lifecycle layer refuses a conflicting explicit harness declaration as a
state error. An omitted harness binds the harness the manifest states explicitly
when the manifest carries one; an unstated model or worker count stays `null`
rather than being guessed. The ceiling is a declared, unenforced whole-minute value
within 1 through 1440, and a declaration that conflicts with a tighter bound the
challenge imposes is refused as a state error. Elapsed time is an observed local
monotonic value when a clock is available, not a declared or invented
measurement, and it is not controlled benchmarking
([MANUAL_LIFECYCLE.md](MANUAL_LIFECYCLE.md)).

### 4. Do the work, then stop the agents yourself

No command in this list starts a participant agent and no command in it stops
one. The participant work happens inside the container's workspace only where a
real user chooses to do it. When that work is over, stop the agents through your
own means before you continue; the next step attests that you did.

### 5. Attest the stop

```
node cli/benchboard.mjs stop --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --operator "<OPERATOR_IDENTITY>" --agents-stopped
```

`--agents-stopped` attests that the agents have stopped. The recorded assurance
is `operator-attested` with enforcement false: the command terminates no process
and holds no survey of running processes.

### 6. Freeze the bytes

```
node cli/benchboard.mjs freeze --run "<ABSOLUTE_RUN_CONTAINER_PATH>"
```

The stopped route reuses, byte-identically, the stop attestation that the
recorded stop journaled, so it takes no operator flag. Retain `snapshotId` and
`frozenSubmissionId` from the summary as `<SNAPSHOT_ID>` and
`<FROZEN_SUBMISSION_ID>`. Freeze saves and verifies bytes; it terminates no
agent, repairs no state and takes no route other than the one you asked for
([CLI.md](CLI.md)).

### 7. Evaluate the frozen copy

```
node cli/benchboard.mjs evaluate --run "<ABSOLUTE_RUN_CONTAINER_PATH>"
```

Evaluate requires an already verified frozen selection; it never automatically
freezes. `--snapshot "<SNAPSHOT_ID>"` is needed where the selection is
ambiguous.
Retain from its summary `attemptId`, `snapshotId`, `frozenSubmissionId`,
`evaluationId`, `reportId` and `reportDigest` as `<ATTEMPT_ID>`,
`<SNAPSHOT_ID>`, `<FROZEN_SUBMISSION_ID>`, `<EVALUATION_ID>`, `<REPORT_ID>` and
`<REPORT_DIGEST>`. On a completed successful baseline `humanUI` and the final
`quality` are `null` because the review has not happened, while `automated`
carries the score the report holds — a real zero stays a zero
([CLI_EVALUATION.md](CLI_EVALUATION.md)). The evaluation consumes the frozen
copy, so a later edit of the live workspace does not change that result.

### 8. Export the pending result

```
node cli/benchboard.mjs export --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --evaluation "<EVALUATION_ID>" --output "<ABSOLUTE_FRESH_EXPORT_DIRECTORY>"
```

The named evaluation selects its committed baseline. The written pair carries
the pending human values as `null` ([CLI_EXPORT.md](CLI_EXPORT.md)).

### 9. Generate the UI template

```
node cli/benchboard.mjs ui --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --template --evaluation "<EVALUATION_ID>" --output "<ABSOLUTE_FRESH_TEMPLATE_FILE>"
```

The written template is bound to the selected baseline and is intentionally
invalid: blank reviewer fields, `baselineCompared: false`, an empty evidence
list, a `null` score for each of the seven categories and no improvements. It
awards no points, and it is not a reviewed zero ([CLI_UI.md](CLI_UI.md)).

### 10. Complete the review privately

Fill in the template by hand, and capture the twelve evidence files yourself
into the review root you will name — the two targets by the three widths by the
two views — following the caps and the evidence rules in
[HUMAN_UI.md](HUMAN_UI.md) and [CLI_UI.md](CLI_UI.md). The software checks the
recorded metadata combination and the bytes; it does not judge the pixels, the
image dimensions, the reviewer identity or the visual merit. There is no
capture, serve or verify command for this material, so treat it as your own
workflow. Raw worksheets and evidence files are private participant material,
not sharing exports ([EXPORTS.md](EXPORTS.md)).

### 11. Attach the completed review

```
node cli/benchboard.mjs ui --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --input "<ABSOLUTE_COMPLETED_WORKSHEET_FILE>" --review-root "<ABSOLUTE_EXISTING_REVIEW_ROOT>"
```

The worksheet's bound parent ID bootstraps the exact committed baseline, and the
accepted contract re-checks the remaining bindings and rehashes the twelve
evidence files. The result is a distinct immutable child report; retain its
`reportId` as `<CHILD_REPORT_ID>`. The parent, its automated categories, the
snapshot and the evaluation are not rewritten, and a repeated attachment makes
another child rather than replacing one
([PUBLICATION.md](PUBLICATION.md)). A human zero is a valid outcome of a
completed worksheet with its notes and evidence; it cannot come from a blank
template.

### 12. Export the reviewed result

```
node cli/benchboard.mjs export --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --evaluation "<EVALUATION_ID>" --report "<CHILD_REPORT_ID>" --output "<ABSOLUTE_FRESH_REVIEWED_EXPORT_DIRECTORY>"
```

An explicit report is that baseline or a direct reviewed child of it; there is
no latest selection. Each successful export writes a fresh directory holding
`report.json`, `report.txt` and `EXPORT_COMPLETE.json`, and nothing else.

### 13. Reset into a fresh container

```
node cli/benchboard.mjs reset --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --output "<ABSOLUTE_FRESH_RESET_DESTINATION>" --dependency-mode none
```

Reset mints new run and manifest IDs, restores the original workload and leaves
the old container, its snapshots, evaluations, reports, results and CLI
references in place. The new run's dependency request defaults to `none`. The
inherited configuration is the old sealed manifest's configuration, so a model
you stated only to `start` does not become sealed configuration on the new run
([CLI_RESET.md](CLI_RESET.md)).

## Limits that hold across the whole sequence

- The ceilings are declared values and are unenforced: `start` launches
  nothing, `stop` kills nothing, and elapsed time is an observed local
  monotonic value when a clock is available rather than a declared or invented
  measurement.
- Unknown is `null`. A pending human review, a pending final quality and an
  unavailable measurement read as `null`, and a completed valid review is what
  can produce a human zero. An automated zero is a number that means zero.
- There is no automatic freeze, no automatic repair, no latest selection, no
  overwrite and no force flag. `evaluate` will not freeze for you, a fresh
  destination that exists is a refusal rather than something to clobber, and
  what a refused command leaves behind follows the per-command fates rather
  than one universal rule: a failed writer can leave partial or committed
  material, and cleanup removes only the material a command's own guide states
  as proven-owned. An error is never permission to alter old evidence, nor proof
  that nothing was written, nor a promise of a universally readable
  `INCOMPLETE` state ([CLI_EVALUATION.md](CLI_EVALUATION.md),
  [CLI_UI.md](CLI_UI.md), [CLI_EXPORT.md](CLI_EXPORT.md)).
- A Report can be committed through its store marker independently of the CLI's
  terminal record: a late error can leave a committed Report with an
  `INCOMPLETE` attempt, and a partial publication can make authoritative reads
  refuse. Preserve what is there; there is no automatic repair or retry.
- A reset preserves the old bytes. It is a reset into a new container, not
  destructive cleanup, and there is no mode that reuses or deletes the old
  workspace or its recorded evidence.
- Every command's stdout summary is private local material, and the fixed
  guidance line on stderr repeats none of the private cause. The sharing
  material is the separately written privacy-safe projection files together
  with their completion marker, and nothing else
  ([EXPORTS.md](EXPORTS.md), [CLI_EXPORT.md](CLI_EXPORT.md)).

## When a command refuses

Exit codes separate usage (2), state or missing prerequisites (3), verified
integrity or safety (4), operational infrastructure (5) and handled cancellation
(130); see the table in [CLI.md](CLI.md) rather than a second copy here. A few
things the codes do not tell you, in short form:

- A nonzero exit does not establish that nothing was committed, and the fixed
  stderr text is not a reader of the committed fate. Check the actual `status`
  diagnosis or an accepted read of the exact ID you hold
  ([CLI_CONTEXT.md](CLI_CONTEXT.md)).
- Cancellation behaviour is per command. `evaluate` passes the handled abort
  signal to production C4, which owns bounded stage cancellation and scratch
  cleanup, and the CLI awaits that cleanup before exiting. `ui` and `export`
  check the signal before their state work and before their write or delegate
  step; an already-aborted invocation is refused there, while an in-flight C5
  publication or synchronous export write has no stated interruption, rollback
  or late-commit relabelling. No command path carries an operating-system
  signal-delivery promise, and a commit that has already landed is not
  relabelled as cancelled
  ([CLI.md](CLI.md), [CLI_UI.md](CLI_UI.md), [CLI_EXPORT.md](CLI_EXPORT.md)).
- After a failed export there is no public verify-export or repair command;
  the per-command guides state what a later programmatic read may establish.
- For a journaled interrupted operation, `reconcile` needs the exact pending
  operation, the exact journal event digest and a supported disposition; there
  is no CLI-only intent reader, no universal repair and no lock takeover
  ([CLI.md](CLI.md)).
- The recorded limits in [CLI_EVALUATION.md](CLI_EVALUATION.md),
  [CLI_UI.md](CLI_UI.md) and [CLI_EXPORT.md](CLI_EXPORT.md) stay in force where
  this page is brief.
