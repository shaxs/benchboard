# Current fresh-run reset guide

This guide describes the `reset` command of the development-checkout CLI as it
exists now: one operator-stated fresh-run reset of an existing local run. It is
a supplement to [CLI.md](CLI.md) (the full command reference and exit-code
table), [INITIALIZATION.md](INITIALIZATION.md) (how the new container is
initialized and how dependency modes work) and
[MANUAL_LIFECYCLE.md](MANUAL_LIFECYCLE.md) (the underlying lifecycle, freeze and
reset operations). Local, development-only use: nothing here launches an agent,
evaluates anything, or scores a run.

## What reset does in one sentence

`reset` reads an existing local run you name and produces a brand-new run
container in a fresh destination you name, through the accepted initialization
path, while the old container bytes stay in place as they were.

## Invocation

```
node cli/benchboard.mjs reset --run <OLD_RUN_ABSOLUTE_PATH> --output <FRESH_OUTPUT_ABSOLUTE_PATH>
```

- Generic placeholders: `<OLD_RUN_ABSOLUTE_PATH>` is the absolute path of the
  existing run container (the run root, not its workspace subfolder);
  `<FRESH_OUTPUT_ABSOLUTE_PATH>` is the absolute path of the container to
  create. Use your real local paths in place of both.
- `<FRESH_OUTPUT_ABSOLUTE_PATH>` must be fresh (nothing existing at that path),
  with an existing ordinary parent, and must be outside the repository checkout,
  outside the old run container and outside the old run's results root. A
  relative `--output` is refused as an integrity error (exit 4). The publisher
  refuses an existing destination — there is no overwrite, force or destructive
  mode.
- The registered dependency options are the same listed under `init` in
  [CLI.md](CLI.md): `--dependency-mode`, `--prepared-root`, `--source-root`,
  `--scratch-root`, `--npm-executable`, `--expected-dependency-digest`. See
  [Dependencies](#dependencies) below.

The command checks the signal before the context is prepared and again
immediately before it delegates to the accepted `resetRun`. That covers work
beginning, not every instant up to commit: a signal arriving once the reset is
already in flight is a stated coverage boundary of the current command paths,
not a stated in-flight cancellation or rollback guarantee for it. Nothing that
has already committed is relabelled as cancelled.

## Which old runs are eligible

An accepted reset works from an old run in state `INITIALIZED`,
`STOP_RECORDED` or `FROZEN`. A `RUNNING` run is refused outright, and a run with
an interrupted or incomplete journal is refused (`RESET_JOURNAL_INCOMPLETE` or
`RESET_JOURNAL_INCONSISTENT`) rather than guessed around. Missing required
flags for the selected dependency mode, or contradictory mode flags, are
refused by a pure flag check before the temporary challenge source is staged
(exit 3). An actual missing or corrupt prepared cache is not part of that
check; it is discovered by the downstream initialization and reported as a
failed initialization (see [Dependencies](#dependencies)). A missing parent
directory, an existing destination, and an active or occupied lock on the old
container are state refusals (exit 3).
The identity of the old run is checked against the request; if the request and
the recorded manifest disagree, the reset is refused with an integrity error
(exit 4). Grammar-level refusals come first, though: an unknown
`--dependency-mode` value, a missing `--output` or `--run` flag, or any
argument that does not match the registered grammar is a usage refusal
(exit 2). An absent required flag is thus a grammar problem, whereas the
per-mode flag checks (such as a missing `--prepared-root` flag) come later in
the command's own checks.

## New versus inherited identities and configuration

- The new run gets fresh `runId` and `manifestId` values minted by the accepted
  initializer behind the reset; they differ from the old ones, and a publication
  where either is not distinct is refused.
- The old run's architecture identity and domain are **inherited** into the new
  run, not newly minted, so repeated resets of the same old run carry the same
  architecture value while their run and manifest IDs differ. The reset refuses changed
  architecture, harness, security-model or ceiling values for the new
  request: the old verified declarations are carried forward as inherited
  declarations, including their `null`/unknown fields, rather than being
  re-inferred from your host or model choice. Reset does not re-declare host or
  model facts.
- Old timing and history remain unchanged in the **old run**. They are not
  copied into the new run: it starts `INITIALIZED` without lifecycle history,
  journal events or old results/attempt references. Its unavailable start/stop
  timing is reported as `null`, not zero or a copy of a known old measurement.
  Verified C2 **configuration is inherited** as previously stated, preserving
  its known values and unknowns; this is separate from the C3 lifecycle
  declaration and timing history. See [MANUAL_LIFECYCLE.md](MANUAL_LIFECYCLE.md).
- The challenge source is staged from the currently installed challenge as the
  exact original 26-file workload in an owned external temporary source
  directory (the same staging, retention and cleanup rules `init` uses — see
  [INITIALIZATION.md](INITIALIZATION.md) and
  [CLI_CONTEXT.md](CLI_CONTEXT.md)). The repository's starter and its
  dependencies in your checkout are untouched.

## Dependencies

Dependencies are a **new explicit request** for the new run. They default to
`none`; nothing is silently copied from the old workspace's edited
`node_modules`, and nothing is inherited from an old cache. If you want
dependencies you state an explicit mode:

- `prepared` requires both `--prepared-root` and `--source-root` to be present.
  Leaving one of these required flags out, or supplying contradictory mode
  flags, is refused by the pure flag check before the temporary challenge
  source is staged (state guidance/exit 3). What the actual prepared cache
  contains is checked later, inside the downstream initialization: a
  missing or corrupt cache, and a lock-provenance or digest incompatibility
  found there, surface as a failed initialization wrapped as
  `RESET_INITIALISE_FAILED` with the infrastructure category (exit 5) — see
  [Errors and retained cleanup](#errors-and-retained-cleanup).
- `install` is opt-in and requires `--source-root`, `--scratch-root` and
  `--npm-executable`; there is no automatic fallback into install.

See [INITIALIZATION.md](INITIALIZATION.md) for the full dependency-mode
behavior.

## Installed-identity refusal

The currently installed challenge, tooling and evaluator identities in your
checkout must equal the identities the old run bound. If development tooling in
this checkout has changed since the old run was created, the reset refuses with
an integrity error (exit 4) instead of silently upgrading the old run's
bindings to the new installed identities. The preferred response is to run the
reset from a separate, known matching checkout of this repository rather than
to change the current checkout: reverting local work is not suggested here, and
this guide gives no commands for restoring or resetting source. Otherwise, an
older run in a changed checkout cannot be reset in that checkout right now.

## Old results protection

The old run's results root is protected: the prepared request carries the old
results root (when one exists) as a protected root, context reads existing
bound results without creating a binding, and the output containment check
refuses an output that overlaps the old run container, its results, or the
repository — including lexically aliased or linked paths. A reset does not
delete, edit or archive the old container, its journal or its recorded
evidence.

## Errors and retained cleanup

Diagnostics are categorized by exit code (`CLI_USAGE` 2, `CLI_STATE` 3,
`CLI_INTEGRITY` 4, `CLI_INFRASTRUCTURE` 5) per [CLI.md](CLI.md). Two notes
specific to reset:

- If an accepted reset's downstream initialization fails, the controlled error
  currently maps to the infrastructure category (`RESET_INITIALISE_FAILED`)
  while the underlying cause and its original refusal category are retained
  privately and are not printed in the controlled diagnostic. A downstream
  failure is therefore not displayed as an integrity violation even when the
  wrapped underlying cause would individually classify that way.
- The temporary source directory is disposed on both the success and failure
  paths, using the same nonrecursive retention rules as `init`: source that is
  unchanged and owned is removed; foreign or replaced source is retained. The
  retained fate and cleanup-root naming are summary facts: on **success** the
  sourceCleanup result (`{ status, root }`) is printed, naming the retained
  root, together with the new run. On a **failed reset** the original error is
  what surfaces — preserving the actual reset refusal, not a fabricated
  summary — and no success/cleanup summary or retained-root name is printed;
  retained cleanup does not remove or invalidate a new run already initialized.
  It means uncertain temporary-source material was preserved for inspection.
  Controlled diagnostics do not print private cause, publication
  fate, or retained-root paths. As with
  `init`, no generic cleanup command exists in this checkout, and no wildcard
  or bulk cleanup is triggered by the command, so inspecting or removing
  retained material is a manual operator action.

## The local summary and its limits

On success one JSON summary line is printed to stdout (exit 0). It contains the
accepted new init roots, digests and file counts, the new `runId`, `manifestId`
and `durationMs`, the command name (`reset`), the selected old source identity and
state and digest, `fresh: true`, `oldContainerMutation: 'none'`, and the
`sourceCleanup` result (`{ status, root }`).

The summary is a local operator record and private local output — it may name
local paths — and is not a privacy-safe export. Separately written safe export
files have their own boundary ([CLI.md](CLI.md), [EXPORTS.md](EXPORTS.md)).
A successful reset creates fresh workload and state, not an evaluation or
review result. Evaluation remains a separate step; a refused reset may produce
no new container at all.
