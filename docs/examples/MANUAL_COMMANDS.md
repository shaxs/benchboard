# Synthetic manual command sequence

**This page is synthetic.** It is an illustrative command recipe for the
development-checkout CLI, written with generic placeholders. Nothing here is
recorded benchmark evidence, a run history, or an example from any real machine:
there is no host path, user name or previous run's data in it. No command below
has been run as part of this documentation task, and the sequence is not the
production command-chain proof. The separate [runtime proof](../../tests/cli/production-chain.test.mjs)
has passed real evaluation/repeat, synthetic UI attachment, safe exports and fresh reset;
this recipe is still illustrative, not a run history or human judgment.

Use the guides as the authority: [QUICKSTART.md](../QUICKSTART.md) for the walkthrough,
[CLI.md](../CLI.md) for flags and exit codes, [CLI_EVALUATION.md](../CLI_EVALUATION.md),
[CLI_UI.md](../CLI_UI.md) and [CLI_EXPORT.md](../CLI_EXPORT.md) for each command's
exact prerequisites and limits, and [MANUAL_WORKFLOW.md](../MANUAL_WORKFLOW.md) for
the workflow narrative.

## Conventions

- Every path value is a quoted, absolute, generic placeholder under an
  already-existing ordinary parent, and every destination that must be fresh is
  shown as fresh. None of these paths point into the checkout, and none names a
  real host location.
- Long options carry a value with a space (`--name value`); boolean flags stand
  alone. There are no positional operands and no `=` spelling.
- Angle-bracket IDs are the values that the named command's own summary reports.
  Copy them forward from that summary. The private storage envelope is not what
  you parse, and there is no most-recent-file rule: `export` and the `ui`
  commands take the ID you name and select no latest child.

## The recipe

```
node cli/benchboard.mjs init --dependency-mode none --output "<ABSOLUTE_RUN_CONTAINER_PATH>"
```

Retain from its summary: `runId` → `<RUN_ID>`, `manifestId` → `<MANIFEST_ID>`.
`<ABSOLUTE_RUN_CONTAINER_PATH>` is the container path, never the workspace inside
it. `init` declares the manual harness and a new architecture ID, launches no
agent, and installs no participant dependency in `none` mode.

```
node cli/benchboard.mjs status --run "<ABSOLUTE_RUN_CONTAINER_PATH>"
```

```
node cli/benchboard.mjs start --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --harness manual --model "<MODEL_LABEL>" --worker-count 1 --declared-ceiling-minutes 60
```

`start` records declarations and launches nothing. The harness shown is
`manual` because the outer `init` step states `manual` explicitly and the
accepted lifecycle layer refuses a conflicting explicit harness declaration; an
omitted harness binds the harness the manifest states explicitly when the
manifest carries one, while model and worker count are the declared values or
`null` and are not guessed. The ceiling shown is a declared, unenforced
whole-minute value within 1 through 1440, and a declaration that conflicts with
a tighter bound the challenge imposes is refused as a state error. Elapsed time is an
observed local monotonic value when a clock is available, not a declared or
invented measurement.

Between `start` and `stop`, the participant work happens inside the container's
workspace where a real user chooses to do it, and the agents are stopped by the
user's own means. No command in this recipe starts a participant agent and none
stops one.

```
node cli/benchboard.mjs stop --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --operator "<OPERATOR_IDENTITY>" --agents-stopped
```

The attestation records `operator-attested` with enforcement false; the command
kills no process.

```
node cli/benchboard.mjs freeze --run "<ABSOLUTE_RUN_CONTAINER_PATH>"
```

Retain `snapshotId` → `<SNAPSHOT_ID>` and `frozenSubmissionId` →
`<FROZEN_SUBMISSION_ID>`. The stopped route reuses the journaled stop
attestation, so no operator flag belongs on it, and freeze neither terminates
agents nor repairs state.

```
node cli/benchboard.mjs evaluate --run "<ABSOLUTE_RUN_CONTAINER_PATH>"
```

Add `--snapshot "<SNAPSHOT_ID>"` where the frozen selection is ambiguous; an
explicit `--results-root "<ABSOLUTE_RESULTS_ROOT_PATH>"` can bind an external
sibling results root on its first use, and a later override must match the
binding. Retain from the summary: `attemptId` → `<ATTEMPT_ID>`, `evaluationId` →
`<EVALUATION_ID>`, `reportId` → `<BASELINE_REPORT_ID>`, `reportDigest` →
`<BASELINE_REPORT_DIGEST>`. The command requires an already verified frozen selection and never
automatically freezes.

```
node cli/benchboard.mjs export --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --evaluation "<EVALUATION_ID>" --output "<ABSOLUTE_FRESH_EXPORT_DIR>"
```

The output directory is fresh, external and disjoint from the checkout, the run
and the entire results root, and holds `report.json`, `report.txt` and
`EXPORT_COMPLETE.json`.

```
node cli/benchboard.mjs ui --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --template --evaluation "<EVALUATION_ID>" --output "<ABSOLUTE_FRESH_TEMPLATE_FILE>"
```

The written template is bound to the selected baseline and intentionally
invalid: it awards no points and is not a reviewed zero.

Complete the worksheet privately, and capture the intended before and after
views into your own review root by your own means. The evidence rules, the
seven integer caps and the twelve target/view/width combinations are in
[HUMAN_UI.md](../HUMAN_UI.md) and [CLI_UI.md](../CLI_UI.md); this page invents no
capture, serve or verification command for them, and a synthetic example is not
real screenshot capture or human judgment.

```
node cli/benchboard.mjs ui --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --input "<ABSOLUTE_COMPLETED_WORKSHEET_FILE>" --review-root "<ABSOLUTE_EXISTING_REVIEW_ROOT>"
```

Retain the child's `reportId` → `<CHILD_REPORT_ID>` and `reportDigest` →
`<CHILD_REPORT_DIGEST>` from the attachment summary. The parent, its automated
categories, the snapshot and the evaluation keep their values.

```
node cli/benchboard.mjs export --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --evaluation "<EVALUATION_ID>" --report "<CHILD_REPORT_ID>" --output "<ABSOLUTE_FRESH_REVIEWED_EXPORT_DIR>"
```

```
node cli/benchboard.mjs reset --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --output "<ABSOLUTE_FRESH_RESET_DESTINATION>" --dependency-mode none
```

The reset mints a new run ID and manifest ID and keeps the old container,
snapshots, evaluations, reports, results and CLI references untouched.

## Reading the score fields, illustratively

The two rows below are a minimal, synthetic illustration of the summary's score
fields, not a Report, not a worksheet, and not a sample of bytes any command
writes. The angle-bracket values in the command recipe above are placeholders;
these illustrative score rows carry no digests or identifiers.

```text
illustrative, pending review:   automated = 42   humanUI = null   quality = null
illustrative, reviewed zero:    automated = 42   humanUI = 0      quality = 42
```

The first row is what a completed baseline looks like while the human review is
outstanding: the pending human component and the pending final quality read as
`null`, and a pending value is never rendered as zero. The second row shows a
review that genuinely recorded zero: the human zero requires a completed
worksheet with its notes and its matching evidence, because a blank template
awards nothing and a reviewed zero is a completed valid review. The automated
figure keeps the value the report carries. On the scale: the automated score's
maximum is the unchanged scorer's 80 and the optional human component's maximum
is 20, so the available combined quality sits at most at 100, reached only
through a valid completed review that awards those points — these are upper
bounds, not scores a run is expected or forced to reach.

## Limits this recipe does not lift

- The ceilings are declared values and are unenforced: `start` launches no
  agent, `stop` kills no process, and elapsed time is an observed local
  monotonic value when a clock is available rather than a declared or invented
  measurement or controlled benchmarking.
- Unknown reads as `null`. A pending human component, a pending final quality and
  an unavailable measurement are `null`; a completed valid review is what can
  produce a human zero; automated zero is a real number meaning zero.
- There is no automatic freeze, no automatic repair, no latest selection, no
  overwrite and no force flag anywhere in the sequence.
- A Report commits through its own store marker, separately from the CLI's
  terminal record: a late failure can leave a committed Report alongside an
  `INCOMPLETE` attempt, and a partial publication can make authoritative reads
  refuse. No error alone establishes either fate; preserve the retained state.
- A reset preserves the old bytes; it creates a new container rather than
  cleaning up the old one.
- Every stdout summary here is private local output, and the stderr guidance
  line repeats no private cause. The sharing material is the separately written
  privacy-safe projection files with their fixed completion marker
  ([EXPORTS.md](../EXPORTS.md), [CLI_EXPORT.md](../CLI_EXPORT.md)).

## After a failure

Usage (2), state or missing prerequisite (3), verified integrity or safety (4),
operational infrastructure (5) and handled cancellation (130) are distinct
categories, with the table in [CLI.md](../CLI.md). Brief version: a nonzero exit
does not establish that nothing was committed, and the fixed stderr text is not a
reader of the committed fate; what a refused command leaves behind follows the
per-command fates rather than one universal rule, since a failed writer can
leave partial or committed material and cleanup removes only the proven-owned
material each command's own guide states; the missing-browser case during
`evaluate` is the infrastructure category; cancellation is likewise per command,
with the handled abort passed to production C4 in `evaluate` (bounded stage
cancellation and cleanup, awaited before exit) and pre-write signal checks in
`ui` and `export` without a stated interruption, rollback or relabelling of an
in-flight publication; and `reconcile` addresses one journaled interrupted
operation with its exact digest and a supported disposition, with the recovery
limits stated in [CLI.md](../CLI.md) and the per-command retained-fate limits in
[CLI_EVALUATION.md](../CLI_EVALUATION.md), [CLI_UI.md](../CLI_UI.md) and
[CLI_EXPORT.md](../CLI_EXPORT.md). After a failed export there is no public
verify-export or repair command; the export guide states what a later
programmatic read-only check may establish. An error is never permission to
alter old evidence, nor proof that nothing was written, nor a promise of a
universally readable `INCOMPLETE` state.
