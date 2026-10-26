# UI worksheet CLI guide

This guide covers the `ui` command in this development checkout: the two
routes (a blank template and an attached human review), what each one needs
before it will run, what its local summary means, and where its guarantees
stop. It describes the code as it exists here (`cli/ui-command.mjs`,
`cli/ui-arguments.mjs`, `cli/ui-context.mjs`, `cli/private-output.mjs`,
`cli/ui-summary.mjs` and the accepted layers they call). For the overall CLI
and the exit-code table, see [CLI.md](CLI.md); for the run's binding records,
see [CLI_CONTEXT.md](CLI_CONTEXT.md); for the worksheet contract and the
rubric, see [HUMAN_UI.md](HUMAN_UI.md); for the reviewed-child publication,
see [PUBLICATION.md](PUBLICATION.md).

The UI review is a **private local self-assessment**. It authenticates no
reviewer, verifies no screenshot pixels, and certifies nothing. Raw
worksheets, reviewer names, improvement narratives and evidence files are
private participant material and are not privacy-safe exports.

## Invocation

Both routes take flags only, and `--run` is required in both. Path values are
absolute ordinary spellings; the new `--input`, `--output` and
`--review-root` values carry the conservative path refusals described under
"Private files, stdout and safe export", while `--run` keeps the
accepted context normalization.

Template route:

```
node cli/benchboard.mjs ui --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --template --evaluation "<EVALUATION_ID>" --output "<ABSOLUTE_FRESH_TEMPLATE_FILE>"
node cli/benchboard.mjs ui --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --template --report "<PARENT_REPORT_ID>" --output "<ABSOLUTE_FRESH_TEMPLATE_FILE>"
```

Attachment route:

```
node cli/benchboard.mjs ui --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --input "<ABSOLUTE_COMPLETED_WORKSHEET_FILE>" --review-root "<ABSOLUTE_EXISTING_EVIDENCE_DIRECTORY>"
```

Route rules enforced by the pure route projection before selected-run state
is read, as usage refusals (exit 2):

- Template mode requires `--template` as a bare flag, a nonblank `--output`,
  and at least one of `--evaluation` or `--report`. `--input` and
  `--review-root` are forbidden.
- Attachment requires both `--input` and `--review-root`, and forbids
  `--template`, `--output`, `--evaluation` and `--report` overrides.
- Selector values are matched against the safe identifier pattern; a blank or
  malformed selector or a contradictory or missing mode field is a usage
  refusal. An unknown parser flag is a usage refusal raised by the outer
  parser itself. There are no positional operands and no public flags beyond
  the ones in [CLI.md](CLI.md).

These shape checks promise no more: with the command's lazy dispatch,
importing the operational module can already have loaded its schemas by the
time a semantic mode check runs. Separately, when both `--evaluation` and
`--report` are given and are otherwise well formed, resolving them to the
same actual baseline happens after the run state is read; a mismatch is the
state category (exit 3), not a usage refusal.

## Prerequisites the selected run must meet

Selection resolves the exact executed CLI reference: a committed C5 baseline
with a verifiable saved selection and saved artifacts. A legacy
execution-less terminal record, an incomplete planned report, mismatching
`--evaluation` and `--report` selectors, or a reviewed child named as the
parent are refused rather than adopted, and there is no implicit latest.

The parent must be a successful automated baseline: its evaluator execution
is `SUCCESS` and its evidence bundle is bound. An ordinary committed
infrastructure Report can exist, but the UI route requires the successful
bound parent and refuses such a report as an integrity error (exit 4) — such
a report receives no human points through a refusal, and a refusal is not a
zero. Unknown or missing
publication references keep their own accepted error category.

## What the template contains

`--template` writes a bound, blank worksheet that is **intentionally
invalid**: it exists to be completed, and it is not a reviewed zero. It
carries the exact parent, evaluation, bundle, snapshot, tree, starter and
workload facts of the selected baseline; blank `reviewId`, `reviewer` and
`reviewedAt`; `baselineCompared: false`; an empty evidence list (the twelve
evidence slots are left empty, not pre-populated); a `null` score and an empty
note for each of the seven categories; and no improvements. The file contains
no screenshots and nothing about authentication.

Its local summary reports the run and manifest IDs, the parent report ID and
digest, the evaluation and snapshot IDs, the private output path, and
`worksheetComplete: false`, `humanReview: NOT_REVIEWED`, `humanUI: null`,
`quality: null`.

## Completing the worksheet (what the checks look for)

The exact schema and validation semantics stay in
[HUMAN_UI.md](HUMAN_UI.md); the attachment rehashes described here follow
[PUBLICATION.md](PUBLICATION.md). Practically, a completed worksheet needs:

- `reviewId`, `reviewer` and a canonical UTC `reviewedAt` (the exact
  `YYYY-MM-DDThh:mm:ss.mmmZ` form that parses and round-trips), plus
  `baselineCompared: true`.
- Twelve unique evidence entries — the two targets (`starter`, `submission`)
  by the three widths (1440, 1024, 768) by the two views (`board`, `drawer`) at
  height 1000 — each with a symbolic logical `artifactId`, a plausible
  recorded byte count and a 64-hex-digit SHA-256 digest. In the review root
  you supply, those twelve logical names must correspond to twelve ordinary,
  unlinked physical files whose actual byte counts and digests match the
  recorded values, and the accepted checks verify those recorded bytes and
  digests plus the expected view, target and width metadata combinations. You
  must capture and name the intended views yourself: the software checks
  metadata and bytes, and it does not certify that a file's depicted UI or
  actual image dimensions are truthful. Capture and naming steps are your own
  workflow; this guide adds no procedure for them.
- An integer score within its cap and a meaningful evidence note for each of
  the seven categories (caps and totals as in [HUMAN_UI.md](HUMAN_UI.md): the
  automated 80 plus the optional human 20, total 100 — the scorer is unchanged
  and untouched by this command). Every positive score needs a matching
  positive improvement pair naming the same width and view on the two targets.
- A completed review that awards zero everywhere is a real reviewed zero and
  still needs every field, note and matching evidence file. Do not edit the
  baseline or the recorded facts to make a review fit.

## Attachment behaviour

Attachment reads `--input` as an ordinary absolute readable file bounded at
2 MiB; only the worksheet's bound parent report ID bootstraps the lookup, and
every remaining binding, provenance, score and note is re-checked by the
accepted contract. It then rehashes the twelve ordinary files below
`--review-root` (bound at 16 MiB per file and 192 MiB in total) and publishes
an immutable reviewed child under the store lock, with a fresh report ID and
`createdAt` and the exact parent ID, digest and shared evaluation, bundle,
snapshot and automated quality. The parent, workspace, snapshot, evaluation
and saved CLI references are not rewritten.

A repeated successful attachment makes another distinct child; nothing picks
a "latest" child for you. The command's store registry and lock writes are
legitimate metadata effects, so the run is not globally write-free.

Its local summary prints the new child ID and digest, the parent ID and
digest, the evaluation and snapshot IDs, and the numeric `automated`,
`humanUI` and `quality` values with the review status. No whole worksheet,
reviewer name, narrative, evidence list, configuration or root path is
printed.

## Private files, stdout and safe export

Fresh template files and an existing review root must be external to and
disjoint from the repository, the run and the entire results root, with an
existing ordinary, link-free ancestry. The worksheet input is read, not
written, so it may sit anywhere readable that the ordinary path policy
accepts: an absolute, ordinary, single-file spelling within the read bound,
with the same conservative refusals described below. There is no
parent-directory invention, no overwrite, no force, no "latest" and no
recursive cleanup.

New `--input`, `--output` and `--review-root` spellings meet the current
conservative ordinary-path policy before those paths are read or written (not
before all selected-run reads): besides rejecting dot
segments, they reject Windows alternate-stream colons outside the drive
root, reserved device and console names, namespace and UNC forms, wildcard
and unsafe punctuation, and trailing-dot or trailing-space component aliases.
This is ordinary-path policy, not complete operating-system alias coverage
or a platform qualification; see [CLI.md](CLI.md) for the accepted path
handling generally. The existing `--run` normalization is unchanged by this
policy.

Template writes are exclusive (`wx`, mode `0600`) with a directory-chain and
file-identity check and an exact-byte read-back. That is a cooperative
boundary, not an ACL, security or crash-durability guarantee, and the
Windows permission bits are not portable. On a failed write, a complete
owned file is removed only while its exact bytes, identity and chain remain
provable; partial, foreign, replaced or otherwise uncertain material is
retained, the original error is preserved, and no success summary or cleanup
root is disclosed. A retained partial file is not a valid completed
worksheet and not a sharing artifact.

Every stdout summary, including these, is private local output. The sharing
boundary is the separately written C5 privacy-safe JSON/text projection
files — not this command's local run or results filesystem, and not the
template file, the completed worksheet, stdout or the private child report.
The explicit `export` command writes those projections and a closed completion
marker; see [CLI_EXPORT.md](CLI_EXPORT.md) for exact report selection, fresh
output and verified completion rules. It never exports this raw worksheet or child.
The review root path is not safe export content, and the evidence files stay
private to your workflow.

## Errors and limits

- Missing or unreadable input or review-root state can surface as the state
  category (exit 3); an ordinary read that fails on the filesystem can surface
  as the infrastructure category (exit 5). A linked, oversize or malformed
  input, or invalid IDs, bindings, blank provenance, illegal scores, missing
  improvements and the like, surface as the integrity category (exit 4).
  Unknown or missing publication references keep their accepted C5 category.
- Default stderr states the code and guidance only: no reviewer name,
  narrative, path, schema text, stack or raw error details.
- A signal that is already aborted is refused before state access, and the
  second check runs before the command writes or delegates. There is no
  in-flight C5 cancellation or rollback and no relabeling of a late commit,
  and no operating-system signal-delivery promise. A C5 commit can land
  before a later read-back or verification error; the static stderr does not
  expose the committed fate or a new ID, and there is no rollback, automatic
  retry, delete or repair. Preserve retained evidence; an accepted read of the
  exact known report ID is what establishes an actual commit, never a command
  error or a file name.
- No browser, server, participant agent or installation is started by the UI
  command, and a synthetic test run here is not a real end-to-end evaluated
  and reviewed chain. The separately executed local
  [production-chain test](../tests/cli/production-chain.test.mjs) has passed real
  evaluation/repeat and synthetic UI protocol attachment; it still proves no
  human visual judgment or screenshot capture.
