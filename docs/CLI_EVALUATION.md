# Evaluation CLI guide

This guide covers the `evaluate` command in this development checkout: how
to invoke it, what it requires before it will run, what its summary means,
and what finishes an evaluation without giving a score. It describes the
code as it exists here. For the overall CLI and the exit-code table, see
[CLI.md](CLI.md); for the evaluation vocabulary, see
[EVALUATION.md](EVALUATION.md); for reports, see [REPORTING.md](REPORTING.md)
and [PUBLICATION.md](PUBLICATION.md); for the run's binding records, see
[CLI_CONTEXT.md](CLI_CONTEXT.md).

## What evaluate does

`evaluate` evaluates only saved, verified frozen bytes that `freeze`
already published. It does not launch an agent, does not install
dependencies or browsers, and does not touch the workspace: evaluation
stages copies beneath a fresh per-attempt output directory and reads the
saved bytes. If the workspace has been edited since the freeze, the saved
bytes stay the ones selected; the difference is only disclosed (see
"Workspace drift" below).

After a returned successful evaluation the command publishes the report,
records the attempt's terminal entry, and prints a local summary. Even at
that point, human review stays `NOT_REVIEWED` and the human-UI and
final-quality fields stay `null`: the automated scorer ran, a human did
not, and nothing here turns an automated result into a judged one. See
[EVALUATION.md](EVALUATION.md) for how those stay separate.

## Invocation

```
node cli/benchboard.mjs evaluate --run "<ABSOLUTE_RUN_CONTAINER_PATH>"
node cli/benchboard.mjs evaluate --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --snapshot "snap-<32_LOWERCASE_HEX>"
node cli/benchboard.mjs evaluate --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --results-root "<ABSOLUTE_RESULTS_ROOT>"
```

The command takes flags only, and path values are absolute external
container paths. Options:

- `--run` (required): the run container path, not the workspace.
- `--snapshot` (optional): an explicit snapshot ID, `snap-` followed by 32
  lowercase hex characters. A malformed spelling is a usage error before
  the run is opened. Selection otherwise defaults to a unique verified
  frozen submission; an explicit `--snapshot` is needed when selection is
  ambiguous. A missing or ambiguous verified freeze is refused as a state
  error (`CLI_STATE`, exit 3) with the status/freezes guidance in
  [CLI.md](CLI.md); there is no automatic stop, freeze or
  reconciliation in response.
- `--results-root` (optional): an explicit external results root; the
  default is `<run>.benchboard-results`, a sibling of the run container.
  The selected root is bound once when the run's results context is first
  created, and a later invocation naming a different root is refused as a
  state error. Run container, checkout and results roots stay disjoint;
  see [CLI_CONTEXT.md](CLI_CONTEXT.md).
- `--timeout-ms` (optional): per-stage timeout in milliseconds, a plain
  positive integer from 1 through 3600000. Omitted means the accepted
  staging default of 300000 ms applies.
- `--max-output-bytes` (optional): per-stage process-output bound in
  bytes, a plain positive integer from 256 through 16777216. Omitted
  means the accepted staging default of 1048576 bytes applies.

Both numeric flags are parsed before the run is opened, so a malformed
value (sign, decimal point, whitespace, out of range) is a usage error
(exit 2) with no command work started. These bounds are restatements of
the staging layer's own request limits; they do not enforce a
participant's declared session ceiling and are not a stop mechanism —
see [EVALUATION.md](EVALUATION.md).

## Prerequisites

- A run that has at least one verified frozen submission (unique, or
  selected explicitly as above).
- The prepared canonical toolchain and dependency tree the evaluation
  stages into disposable copies (the prepared owner-side tools the C4
  stages use by default), and an installed Playwright Chromium, must
  already exist. Evaluation never installs dependencies or browsers and
  never starts a participant agent. The staged per-stage steps may run
  their own bounded build, test, browser and server processes inside
  disposable staging; that is staging work, not participant-agent
  launching, and those processes are not an operating-system sandbox.
- A results context is not something you must have in place: when the run
  has no results context yet, `evaluate` creates and binds one after
   selection has succeeded (the default is a fresh external sibling of the run). Note
  that this means the command is not a globally write-free operation
  even before staging, and it means refusals can happen before any
  binding exists (see "Reservation is not guaranteed").
- A missing toolchain or browser at evaluation time is a refusal from
  the evaluation layer, not evidence that a working toolchain or browser
  exists anywhere: it proves nothing beyond the refusal.

## Attempt, returned evaluation, planned report, committed baseline

Four identities matter, and confusing them is what the CLI's bookkeeping
exists to prevent:

1. **Attempt.** An invocation that reaches reservation gets one attempt: a fresh
   attempt ID and a fresh per-attempt output directory
   (`attempts/<attemptId>` under the results root). Attempt output is
   fresh per attempt and never reused.
2. **Returned evaluation.** The accepted evaluation layer returns an
   `evaluationId` for the evaluation attempt it ran. That returned ID
   labels the C4 attempt and its outcome — including a preflight
   infrastructure outcome where no stage check ever executed — so it is
   not by itself proof that any stage check actually ran. The CLI records
   that returned ID in the attempt's execution record before any report
   is created; it never substitutes its own ID. When a refusal is thrown
   before the evaluation layer returned, the attempt keeps its evaluation
   ID unknown (`null`) rather than fabricating one, and no report digest
   is invented before a report exists.
3. **Planned report.** After a returned evaluation, the CLI plans a
   report ID whenever the attempt was not cancelled and left an attempt
   output directory (success counts even when the output check has to
   confirm the directory separately). Planning is bookkeeping only: a
   planned ID is not yet a published report, and no digest exists yet.
4. **Committed baseline.** A C5 report is committed by C5's own
   completion marker, written when the report has been saved into the
   report store (a disjoint sibling of the attempts root). That
   commitment is C5's, independent of the CLI's later terminal step:
   a committed report can exist while the CLI attempt is still
   `INCOMPLETE`, because the terminal establishes the completed CLI
   reference and verifies the already committed saved report rather than
   creating C5's marker. An infrastructure report still has no automated quality even
   after the terminal is written. An intent alone never proves a
   committed baseline, and a physical committed report may also already
   exist when a later index or read-back step fails.

Uniqueness of attempt, evaluation and report identities among the run's
attempts is enforced under one results-root write lock, and it covers both
unfinished execution intents and terminal assignments. The binding is
also only cooperative local association: the execution record ties the
verified selection, run, snapshot, frozen submission, output root,
returned evaluation ID, planned report ID and the stored
`evaluatorExecution` class — derived from the returned C4 status
(`SUCCESS` or `INFRASTRUCTURE_ERROR`), not from a declared or attested
outcome — together. It is not evaluator-signed origin, authentication or
certification. See
[PUBLICATION.md](PUBLICATION.md) and [REPORTING.md](REPORTING.md).

## Reservation is not guaranteed

Not every `evaluate` invocation reserves an attempt. Argument and
selection failures — a malformed flag, a missing or ambiguous verified
freeze — refuse before any results context is created or any attempt is
reserved, so in those cases there is no attempt record to read afterward.
The phase order is: grammar → run opened → frozen selection verified →
results context created/bound when absent → attempt reserved → evaluation
called.

## The success summary, and what stays null

A completed successful evaluation writes one JSON summary line to stdout —
the same local-record rules as elsewhere in the CLI: private local output,
not a privacy-safe export (only `export` writes safe sharing files). The
projection carries `command: evaluate`, the attempt, run, manifest,
snapshot, frozen-submission, evaluation and report IDs plus the report
digest, terminal status `SUCCEEDED`, `evaluatorExecution: SUCCESS`,
`humanReview: NOT_REVIEWED`, `agentOutcome: null`, `enforcement: manual`
with `enforced: false`, the unchanged automated score the report carries,
`humanUI: null`, final `quality: null`, and the
`workspaceMatchesFrozenInventory` disclosure (C4's final snapshot
observation; see "Workspace drift"). The distinctions:

- **Successful is not reviewed and not judged.** `humanUI` and final
  `quality` stay `null` after a completed automated evaluation; a human
  review, if any, happens separately and never through this command.
- **Zero is zero.** The automated score passes through unchanged; a
  completed evaluation with a zero automated score exits 0 — the command
  succeeded, the submitted work scored zero. Unknown is never rendered as
  zero.
- **No arbitrary extra content.** Evidence, bundle/log/artifact contents,
  operator and configuration values, raw error context and internal paths
  stay out of the summary; every stdout summary is still private local
  output and is not the sharing boundary.

## No-score outcomes: refusal, cancellation, infrastructure

- **Refusal after reservation, before a returned evaluation.** A
  genuinely corrupt frozen input, identity mismatch or path fault is an
  integrity refusal (`CLI_INTEGRITY`, exit 4). The handler then attempts
  one controlled diagnosis registration on the reserved attempt: where
  that write succeeds, the attempt carries a terminal entry with the
  actual controlled category (for example `REFUSED`), `evaluationId:
  null` and `reportId: null` — no fabricated IDs, no report. Where the
   metadata write itself fails, the attempt can remain `INCOMPLETE` or its
   authoritative reads can refuse partial state; existing evidence is retained, nothing is
  repainted as completed, and the original error is preserved and
  rethrown in its controlled category. (Refusals before reservation have
  no attempt at all — see "Reservation is not guaranteed".)
- **Returned infrastructure without output.** The evaluation layer can
  return an infrastructure outcome — C4's returned status is
  `infrastructure-error`, which the record and report store as the
  `INFRASTRUCTURE_ERROR` execution class — instead of success. That is
  no quality result at all, not an automated score of zero. If the
  attempt's output directory does not exist (no evaluation directory was
  produced at all), the attempt terminal keeps the returned
  `evaluationId` with `reportId: null` and `reportDigest: null`, and the
  command emits `CLI_INFRASTRUCTURE` (exit 5) on stderr only — no success
  stdout, no quality or report claim.
- **Returned infrastructure with publishable output.** When a returned
  infrastructure attempt did leave its ordinary evaluation output, the
  CLI may still publish a no-quality C5 infrastructure Report for it —
  but only if the C5 root/artifact prerequisites actually hold. That
   report carries `null` quality and the attempt terminal has status
   `INFRASTRUCTURE`; the CLI still exits 5 with no success stdout, and any
  failure in creating, publishing or verifying the report keeps its own
  controlled category — it is never silently repainted as a completed
  evaluation, and no raw cause, error text, path or stack is copied into
  the stderr line.
- **Publication faults.** If a planned report's creation, publication or
   read-back fails before a terminal is published, the attempt remains
   `INCOMPLETE` with its recorded intent where authoritative reads succeed.
   A partial C1 terminal write can instead make reads refuse, and an error
   observed after a completed C1 registry write can leave a committed terminal
   that later accepted reads verify. C1 reads verify published envelopes, not
   final registry registration, so an after-link error can also leave a valid
   terminal readable without any automatic registry repair. No error or filename alone proves
   fate. Nothing is auto-repaired or retried, and existing output/metadata are
   preserved. Inspect the run's private attempt
  records yourself ([CLI_CONTEXT.md](CLI_CONTEXT.md)); there is no
  generic repair, force, orphan-lock removal or destructive cleanup
  command in this checkout.
- **Cancellation.** The main process's `SIGINT` listener passes an
  abort signal to the evaluation layer, which owns bounded cancellation
  and cleanup. A C4 outcome of `CANCELLED` that reaches the command is
  reported as `CLI_CANCELLED` (exit 130) with no report: the attempt
   terminal, when bookkeeping succeeds, keeps the returned `evaluationId` and `reportId: null`, and
  cleanup is awaited before the process exits. Once the evaluation layer
  has returned and report publication is complete, a late signal does
  not relabel committed success. A signal request is not guaranteed to
  win over an earlier actual C4 failure: only a pre-aborted handler
  refuses before any state is touched. A signal arriving during
  preparation may already have left context or attempt metadata before
  C4 observes it, so "a signal was sent" does not promise "no state was
  written". What is not proven by this guide or its fast tests: physical
  OS signal delivery in every environment, cross-platform qualification,
   or human visual judgment. Separate local [production-chain](../tests/cli/production-chain.test.mjs)
   and [handled-cancellation](../tests/cli/production-cancellation.test.mjs) acceptance has passed
   real evaluation/repeat and IPC-triggered listener cancellation, not physical OS signal qualification.
- **Metadata retention.** Non-success paths preserve the attempt metadata
  recorded so far, keep unknowns `null`, and disclose the drifted state
  of any interrupted step — subject to the earlier caveat that failures which
  happen before reservation leave no attempt metadata, and a failed
   diagnosis write can leave an attempt `INCOMPLETE`, unreadable partial
   metadata or a verifiably committed terminal. Where accepted status reads
   succeed, they separate the terminal
  status from the optional publication intent (the recorded evaluation
  ID, planned report ID and stored evaluator execution class), so an
  `INCOMPLETE` attempt that has a planned report ID is not treated as
  `SUCCEEDED` or as a committed quality result, and a committed C5
  report is not evidence that the CLI terminal was reached. Legacy
  pre-execution start/terminal entries stay readable as status, but an
  explicit new CLI baseline selection requires the executed committed
  matching authority described above, not a guessed latest attempt or
  store folder.

## Baseline and child selection in this checkout

A committed evaluation result always comes from one freshly reserved
attempt; `evaluate` does not reuse a previous attempt's report as its own
result. In [REPORTING.md](REPORTING.md), the C5 read APIs select reports by published store identity
alone and do not require CLI attempt records; the association of a report
with a CLI attempt's committed execution intent is a new, internal CLI
report-selection layer used by the explicit `ui` and `export` commands.
UI permits only successful bound automated baselines; export may also project
a committed infrastructure Report with unavailable quality. These CLI selectors
enforce the execution association without changing generic C5 readers. Neither
command chooses an implicit latest child or adopts an arbitrary store report.

## Returned-outcome bookkeeping failures

If C4 has returned but its execution association cannot be recorded, the CLI
leaves the attempt incomplete rather than assigning a permanent evaluator
disposition from a bookkeeping error. The returned identity can remain
unavailable to accepted CLI reads if no execution envelope was published.
A non-null planned report whose C5 publication refuses can remain incomplete
indefinitely; there is no automatic downgrade to a null-report terminal or
generic repair command.

## Workspace drift

The success summary's `workspaceMatchesFrozenInventory` field carries C4's
final snapshot observation (`evaluation.snapshot.workspaceMatchesFrozen`),
made at the end of the evaluation: `true` or `false` as actually observed,
`null` when that observation was not available (unknown stays unknown).
It is a point-in-final-time observation, not an all-instant guarantee: the
evaluation used the saved bytes throughout, the workspace was left as it
stood, and nothing in this command re-freezes, re-selects, falls back to a
live source or repairs the difference.

## Limits covered and not covered

The guide documents this checkout's current `evaluate` path only. It does
not claim and the fast test run does not prove: physical OS signal and
census behavior, an operating-system sandbox for staged server processes,
authentication or crash durability, full real command chains or repeated
explicit cancellation scenarios, or the distinct UI/safe export contracts.
Those scopes are documented in [CLI_UI.md](CLI_UI.md) and
[CLI_EXPORT.md](CLI_EXPORT.md). The evaluation cooperates
with local infrastructure under the understood boundaries; no stronger
qualification is proven. The separately executed local production-chain and
handled-cancellation tests above provide bounded runtime evidence; this guide and
its fast tests do not replace that evidence.
