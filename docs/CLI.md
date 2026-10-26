# BenchBoard checkout CLI guide

This guide covers the development checkout CLI in this repository. It is for
local, development-only self-assessment: it halts no agent, certifies nothing,
publishes no release, and provides no operating-system sandbox or
authentication.

## Running it

```
node cli/benchboard.mjs --help
npm run benchboard -- --help
```

Both run the CLI from the checkout directly. There is no install step and no
global linking; no packages need to be installed to use `--help`.

## How invocation works

- Running with no arguments, or passing a global help request that consists of
  `--help` alone (`-h` alone behaves the same), prints global help and exits 0.
  Nothing else may appear in a global help invocation: `--help init` is
  refused as usage, not treated as help for a command.
- `node cli/benchboard.mjs <command> --help` prints that command's help text
  and exits 0. Help requests still validate every supplied token, but required
  flags are only enforced when no help is requested.
- Long options only: `--name value` for value options, `--name` alone for
  boolean flags. `-h` is accepted as an alias for `--help`.
- Refusals during parsing: a long option written with the `=` sign,
  `--name=value`; short options other than `-h`,
  positional operands, unknown commands, unknown options, duplicate options
  (`-h` and `--help` count as one option for this rule), missing values (a
  value that is absent or begins with `-`), and empty or whitespace-only
  values. All argument/rejection errors are usage errors and exit with
  `CLI_USAGE` (2).
- Help output is generated from the built-in command grammar table. It reads
  no run or installed assets and writes nothing.
- A completed invocation writes one line of JSON (the local command summary)
  to stdout and exits 0. The summary is a local record for the person working
  in this checkout; it may name selected paths and is not a privacy-safe
  export. Only the `export` command writes the safe projection (see below).
- Help and parse rejections do not start any command work. Operational
  commands can create or update local state as their own help describes, so a
  command that fails part way through is not guaranteed to have written
  nothing.

## Commands

All commands take options only (no positional operands). Required flags are
listed per command; `--help` is available on every command.

### `init`
Initialize a fresh participant container; does not launch an agent.
Required: `--output` (fresh absolute output container; parent must exist).
Also: `--dependency-mode` (`none` default, `prepared`, or `install`; never
falls back), `--prepared-root`, `--source-root`, `--scratch-root`,
`--npm-executable`, `--expected-dependency-digest`.

Initialization behavior in this checkout (see
[INITIALIZATION.md](INITIALIZATION.md) for the dependency-mode details):

- `init --output` requires an absolute destination that is fresh and has an
  existing parent, uses real installed identities and a new architecture ID,
  and defaults the dependency mode to `none`. A relative `--output` is
  refused as an integrity error (exit 4); it is not silently normalized.
- The command materializes the raw challenge workload (26 files) in an exclusive
  external temporary source directory, so a prepared starter, `node_modules` or
  `dist` in the checkout itself does not have to be modified. The temporary
  source is removed in both the success and failure paths when it is unchanged
  and proven owned; source that is foreign or has been replaced is retained
  instead. A retained cleanup does not erase a successfully initialized run: the
  summary reports the run and the retained cleanup root together. On a failed
  run the retained material is not individually named in the controlled
  diagnostic, and no generic cleanup command exists, so operators inspect any
  retained material manually; see
  [CLI_CONTEXT.md](CLI_CONTEXT.md) for the temporary-root prerequisites and
  these reporting limits.
- The `prepared` mode requires both an explicit `--prepared-root` and an
  explicit `--source-root`, with cache provenance compatible with that locked
  source's lock bytes; an ordinary link-heavy developer `node_modules` is not
  silently adopted. A missing prerequisite — a cache with no provenance
  record or an absent `--source-root` or lock/manifest file — is refused with
  the state category (`CLI_STATE`, exit 3) naming both flags. A mismatched
  lock/manifest binding or a cache/destination digest mismatch is an integrity
  refusal (exit 4), not the state guidance. The `install` mode is opt-in and
  requires an explicit source root, a private scratch root and an npm
  executable; there is no automatic fallback into install.
- The summary written on success includes the accepted roots and digests, file
  counts, run ID, manifest ID, duration in milliseconds, the command name and a
  source cleanup result `{ status: removed | retained, root }`. It is local
  output and not a privacy-safe projection; only the safe JSON/text files the
  `export` command writes separately are intended as such.
- Model, worker count and other configuration are not invented by `init`; what
  is not stated stays unknown. Later `start` declares only its own listed
  fields (harness, model, worker count, ceiling), so other configuration
  remains unknown rather than being declared.
- A preparation fault can leave partial private scratch behind. Controlled
  diagnostics do not print raw structured error context; the exit-code table
  below says which category applies.

### `start`
Record manual start and immutable declarations; no agent launch.
Required: `--run` (run container path, not workspace).
Also: `--harness`, `--model`, `--worker-count` (declared
positive integer worker count), `--declared-ceiling-minutes` (declared, unenforced
ceiling in minutes).

The numeric flags take plain positive decimal integers that are safe
integers; the declared ceiling is expressed in whole minutes within
1..1440, and the challenge may impose a tighter bound.
Stated harness and model labels are at most 128 and 512 characters,
respectively. Invalid supplied lengths are usage errors; labels are not trimmed.

The selected manual adapter is explicit harness coverage, not model inference:
an unstated model, worker count or configuration stays unknown rather than
being guessed. The declaration is recorded as immutable through the accepted
lifecycle layer; refusals of a conflicting harness or of a ceiling that
conflicts with the challenge's own bound are state errors. See
[MANUAL_LIFECYCLE.md](MANUAL_LIFECYCLE.md).

### `stop`
Record operator-attested stopping; does not stop any process.
Required: `--run`, `--operator` (private operator identity),
`--agents-stopped` (boolean flag attesting all agents have stopped).
The operator identity must contain 2 through 256 characters; invalid supplied
lengths are usage errors, not integrity failures.

The stop is operator-attested and unenforced: the CLI carries no survey of
running processes and terminates none, so the assurance recorded on a
successful stop is `operator-attested` with enforcement false. Repeated or
refused lifecycle transitions are state errors. See
[MANUAL_LIFECYCLE.md](MANUAL_LIFECYCLE.md).

### `status`
Read verified lifecycle diagnosis and known local result references.
Required: `--run`.

The status view separates the lifecycle state from its diagnosis
(`consistent`, `incomplete`, or `inconsistent`); an interrupted operation is
reported, not repaired. Elapsed time distinguishes a known zero from an
unknown `null`, declaration fields keep their unknowns, and the stop
assurance and enforcement values are reported with the known attempt IDs.
An absent terminal record is displayed as `INCOMPLETE` and no score is
invented for it; a malformed terminal is refused, not treated as incomplete.
`status` can touch accepted lock and storage metadata when
it reads the run, so it is not globally write-free, yet it creates no
results binding and repairs nothing: with no results context the attempts
list is empty rather than a binding being created merely to report none.
Raw journal text, findings, operator statements and errors stay out of the
summary. See [MANUAL_LIFECYCLE.md](MANUAL_LIFECYCLE.md).

### `freeze`
Save and verify immutable bytes; never terminates, launches or surveys agents.
Required: `--run`.

Freeze has two routes; exactly one is used per invocation.

- **Stopped route (the default; run state `STOP_RECORDED`).** Takes no extra
  flags. It reuses, byte-identically, the stop attestation the recorded stop
  journaled — no new operator statement is taken at freeze time. `--operator`
  or `--agents-stopped` supplied without `--clockless` is a usage refusal, and
  so is a bare `--clockless`: a clockless freeze needs its full operator and
  stopped-agents attestation, so the grammar refusal happens before any state
  comparison. A fully attested clockless request against a run that carries a
  recorded stop is refused as a state error — such a freeze binds that stop
  rather than claiming a clockless route.
- **Clockless route (`--clockless` alone is not enough; run state
  `INITIALIZED`).** Requires all three of `--clockless`, `--operator` (a
  private operator identity of 2 through 256 characters) and `--agents-stopped`.
  It attests that the run never started. This route never implies an elapsed
  time: an unavailable elapsed time stays unknown (`null`), it is never zero.

Refusals are layered, and the pure route/attestation grammar check runs
before any state comparison. Usage errors (exit 2) are the pure grammar
refusals: stray stop-route flags without `--clockless`, and a clockless
request missing `--operator` or `--agents-stopped`. State errors (exit 3)
then cover a route/state mismatch — a fully attested clockless request
against a run that carries a recorded stop, a running run, a repeated (already
frozen) run, and an `incomplete` lifecycle diagnosis. Integrity errors (exit
4) cover an `inconsistent` lifecycle diagnosis, and a missing or genuinely
not-stopped bound stop attestation on the stopped route. A freeze interrupted
mid-publication leaves its journaled intent for the explicit `reconcile`
command; `freeze` adds no retry, implicit reconciliation or rollback policy
of its own — the accepted core owns its publication and cleanup fate and the
command reports the outcome as it stands — and it never adopts, reuses or
removes material the freeze did not create.

A late integrity error (exit 4) can surface after the core has already
journaled `FREEZE_COMMIT` or after `freezeRun` returned success, when a
later verification step or the CLI's read-back of the run fails. The default
stderr for that outcome states the code and guidance and does not name the
committed fate or repeat the structured details, so inspect the actual
`status` diagnosis or the accepted diagnosis before attempting
reconciliation. An error by itself does not establish that no snapshot was
published, and it authorizes neither automatic retry nor deletion.

The freeze summary is a private local record (it names selected paths and is
not a privacy-safe export): the selected run and manifest IDs, the resulting
lifecycle state and diagnosis, the route, the snapshot ID and snapshot root,
the frozen submission ID, tree digest, file and byte counts, `frozenAt` with
its provenance, the elapsed time as a known value or unknown `null`, and the
stop assurance and enforcement facts. The distinctions matter. `frozenAt` is
the saved freeze instant, not generally a wall-clock publication moment: its
source — named by `frozenAtProvenance` as `lifecycle.stoppedAt` (a recorded
stop instant), `attestation.observedAt` (an operator statement) or
`clock.reading` (an observed reading) — is accepted-provenance, never
inferred. Elapsed run time is separate and stays unknown (`null`) on the
clockless route no matter what `frozenAt` says. The stop facts also follow the
route: `stopAssurance` is operator-attested on the stopped route and `null` on
the never-started clockless route, while enforcement is `false` in both cases.

**Selecting saved bytes** (the helper later commands share): selection
requires either a unique verified frozen publication or an explicit snapshot
ID (`--snapshot`, `snap-` followed by 32 lowercase hex characters). There is
no implicit latest-child choice; an ambiguous selection is refused as a state
error, and verification failures or findings are refused as integrity errors.
Where a workspace-drift check runs, a mismatch against the frozen inventory is
separately disclosed and neither it nor selection alters the saved bytes.

**No verification or cleanup path yet.** There is not yet a generic CLI
command to verify frozen bytes on demand or to clean orphan or foreign
material; such residue is inspected manually. `reconcile` covers only the
journaled operations described below.

Freeze examples (generic placeholders; absolute external paths, no host
paths):

```
node cli/benchboard.mjs freeze --run "<ABSOLUTE_RUN_CONTAINER_PATH>"
node cli/benchboard.mjs freeze --clockless --agents-stopped --operator "<OPERATOR_IDENTITY>" --run "<ABSOLUTE_RUN_CONTAINER_PATH>"
```

The first publishes through the recorded stop attestation the run already
carries (its `elapsedMs` is the recorded stop's elapsed fact, and `frozenAt`
comes with the provenance the accepted source states); the second publishes
from `INITIALIZED` with no start and no recorded stop, so `elapsedMs` stays
`null` and `stopAssurance` is `null` even though `frozenAt` carries a saved
instant.

### `reconcile`
Explicit supported recovery for one journaled interrupted operation; it never
steals or expires a lock, deletes foreign residue, or retries by itself.
Required: `--run`, `--operation` (`start`, `stop`, or `freeze`),
`--disposition`, `--operator` (private operator identity, 2 through 256
characters), `--intent` (the exact interrupted intent identity).

Accepted dispositions:

- `start` and `stop`: `COMPLETE` or `LEAVE_AS_IS`.
- `freeze`: `COMPLETE` or `KEEP_INTERRUPTED`.

`--intent` is the exact lowercase 64-hex journal event digest of the
interrupted operation's journaled intent event (`START_INTENT`, the recorded
`STOP_RECORDED` event, or `FREEZE_INTENT`). Read it from the run's journaled
lifecycle events through the accepted lifecycle reader
(`readRunLifecycle` → `journal.events[]` → `eventDigest`). A refused
interrupted publication also reports the same digest inside the structured
private error details the accepted core hands back
(`freezeFate.intentEventDigest`) — a programmatic detail the CLI's default
stderr guidance does not repeat. Never invent a digest, guess one, or derive
it from a folder name. Note the current limit: the digest's source is the
programmatic `readRunLifecycle` `journal.events` view, and in this checkout
neither the `status` view nor the default stderr carries that digest —
obtaining it is a programmatic step through the accepted reader, and manual
journal edits are not a supported substitute.

Prerequisites and observations:

- `reconcile` targets an interrupted run: a lifecycle diagnosis of
  `consistent` is refused as a state error. It binds the stated intent
  against the journal — exactly one event of the operation's kind must carry
  that exact digest, and anything else is refused as a state error. A named
  historical intent alone is not permission: the named operation must be the
  one that is pending now — a start with a lone `START_INTENT`, no
  `START_COMMIT`, no journaled `STOP_RECORDED` event and no pending freeze;
  a freeze with a lone `FREEZE_INTENT`, no `FREEZE_COMMIT` and no pending
  start; a stop with its single journaled `STOP_RECORDED` event on a
  still-running run carrying no recorded stop attestation, no pending start
   and no journaled `FREEZE_INTENT` — as the CLI guard checks it. A
  prior `START` or `STOP` intent does not repair some other pending
  operation. This is a
  stated-intent match, not a generic compare-and-swap; the accepted core
  still rechecks its own authority under its own transaction.
- Recovery of `freeze` delegates to the accepted freeze recovery, which
  mechanically repairs only the completion of a retained freeze publication:
  `COMPLETE` requires one frozen submission and proof that both verify and
  both bind this exact intent, manifest and run, and then appends the missing
  commit — it does not rewrite the journal or stamp a clock of its own. Where
  the proof never landed, `COMPLETE` refuses and any unknown orphan bytes stay
  preserved. `KEEP_INTERRUPTED` repairs nothing and retains every byte it
  found. Recovery of `start`/`stop` delegates to the accepted core
  reconciliation for the named operation only: a `start` handed `COMPLETE`
  can mechanically finish the pending start from the declaration the run's
  journal already captured, with no timestamp forged and no lock removed,
  while a `stop` is reported rather than repaired — a stop is recorded wholly
  or not at all, so the core reports it as it stands.
- The recovery summary reports the actual outcome, not the requested one: the
  accepted action, whether a repair actually happened, the resulting
  lifecycle state and diagnosis, the retained material disposition and the
  finding count. The `retained` field means existing material was retained,
  not cleaned; it is not an assertion that the operation is still pending. A
  `start` repaired to completion can therefore report `repaired: true` and
  `retained: true` together, and freeze material is retained for both
  `COMPLETE` and `KEEP_INTERRUPTED`; the state, diagnosis, action and
  repaired fields together distinguish completion. A `stop` handed `COMPLETE`
  can come back `LEAVE_AS_IS` through the core's own refusal, with
  `repaired: false`; nothing describes a requested decision as if it had
  succeeded.
- Limits: no orphan-lock takeover or expiry, no deletion of foreign or orphan
  material, no automatic retries, no mid-operation rollback, and no
  operating-system durability guarantee; the command adds no rollback or
  retry policy of its own — the accepted core owns its publication and
  cleanup fate under its own transaction. Only a pre-entry cancellation abort
  is honoured. There is no generic cleanup command or journal-reader command:
  read the journal through the accepted lifecycle reader, and treat every
  other residue decision as a manual one.

Recovery examples (`<CONCISE_64_HEX_EVENT_DIGEST>` stands for the exact
lowercase 64-hex event digest read from the journal; it is not derived from a
path):

```
node cli/benchboard.mjs reconcile --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --operation freeze --operator "<OPERATOR_IDENTITY>" --intent "<CONCISE_64_HEX_EVENT_DIGEST>" --disposition KEEP_INTERRUPTED
node cli/benchboard.mjs reconcile --run "<ABSOLUTE_RUN_CONTAINER_PATH>" --operation stop --operator "<OPERATOR_IDENTITY>" --intent "<CONCISE_64_HEX_EVENT_DIGEST>" --disposition COMPLETE
```

See [MANUAL_LIFECYCLE.md](MANUAL_LIFECYCLE.md) for the accepted recovery
vocabulary, the frozen-fate fields, and what a completion may and may not
manufacture.

### `evaluate`
Evaluate only saved verified bytes; human/final quality stays pending.
Required: `--run`.
Also: `--results-root` (external results root; default is
`<run>.benchboard-results`), `--snapshot` (explicit snapshot ID; required if
selection is ambiguous).
Optional bounds are `--timeout-ms` (1 through 3600000 milliseconds per stage)
and `--max-output-bytes` (256 through 16777216 bytes per process output), both
plain positive decimal integers. Omission leaves the accepted C4 defaults in
charge: 300000 milliseconds and 1048576 bytes.

Evaluation never freezes automatically, installs prerequisites or evaluates the
live workspace. It reserves fresh attempt output, calls real production C4,
then creates and publishes a C5 baseline on success. Automated quality can be
zero without a command failure; human UI and final quality stay `null` pending
review. Returned infrastructure has no quality, not zero. If C4 never creates
an evaluation directory, only attempt/execution diagnosis is retained, not a
Report. Cancellation awaits C4 cleanup and does not publish a partial score.

Status keeps an optional `publicationIntent` separate from committed terminal
references. It names a returned evaluation and a planned report (or `null`),
not proof that publication finished. A publication or index failure can retain
a physical report with an `INCOMPLETE` attempt. A partial terminal publication
can instead make authoritative reads refuse, while a late failure can leave
a committed terminal that later reads verify; no error alone proves either
fate. Preserve retained state rather than retrying, replacing or inferring success. See
[CLI_EVALUATION.md](CLI_EVALUATION.md) for the exact prerequisites, identity
association, no-output infrastructure, cancellation and retained-fate limits.

### `ui`
Generate an intentionally invalid template or attach a private bound
worksheet.
Required: `--run`.
Also: `--template` (boolean flag; write a blank, intentionally invalid
worksheet), `--evaluation` (exact evaluation ID for template generation),
`--report` (exact committed parent report ID), `--output` (fresh private
template file), `--input` (completed private worksheet file),
`--review-root` (existing private evidence root for attachment).

Template mode requires `--template --output ABSOLUTE_FRESH_FILE` and at least
one exact `--evaluation` or `--report` selector. If both selectors are supplied,
they must resolve the same successful automated baseline, not a reviewed child.
It forbids `--input` and `--review-root`. The bound blank worksheet is deliberately
invalid, with no completed review or zero awarded. Its output is private.

Attachment requires `--input ABSOLUTE_FILE --review-root ABSOLUTE_DIRECTORY`
and forbids template/output/evaluation/report overrides. The bounded ordinary
input's parent report ID selects its exact executed committed baseline; C5
validates all remaining bindings and physically rehashes all twelve evidence
files. Infrastructure Reports cannot receive UI points. A valid worksheet is
a local self-assessment, not authenticated reviewer identity or visual evidence.

The seven caps and positive-improvement rules are unchanged. Attachment creates
a distinct immutable child and prints its exact ID, preserving the baseline
and saved evaluation bytes. It never picks a latest child or edits the parent.
Fresh template files and evidence roots must be outside the repository, run
and entire results root; input reads are capped at 2 MiB. Pre-aborted commands
refuse before state access; in-flight C5 publication is not rolled back or
relabelled by a late signal. See [CLI_UI.md](CLI_UI.md) for evidence preparation,
private file boundaries and retained-error limits.

The new worksheet input/output/review-root paths require absolute ordinary
spellings: explicit dot segments, Windows alternate streams/device names,
namespace/UNC forms and trailing-dot/space aliases are refused before their
file IO. This does not change the selected run's existing normalization policy
or establish an operating-system sandbox.

### `export`
Write only safe JSON/text summaries; never selects a latest child.
Required: `--run`, `--evaluation`, `--output` (fresh export directory).
Also: `--report` (explicit child report belonging to that evaluation).

The exact evaluation selects its committed baseline, never a latest child.
An optional explicit report must be that baseline or its direct reviewed child
with matching run, evaluation, bundle and snapshot. Legacy execution-less or
incomplete planned references are not adopted. A committed infrastructure Report
can export unavailable quality (`null`), never a fabricated zero or human review.

Output is an absolute fresh external directory beneath an existing ordinary
parent, disjoint from the repository, selected run and entire results root.
It contains exactly `report.json`, `report.txt` and `EXPORT_COMPLETE.json`.
Both content files use the same accepted C5 privacy-safe projection; the closed
marker contains only fixed filenames, byte counts and SHA-256 values. Completion
requires matching bytes, file/ancestor ownership, no extra entries and a verified
marker. Do not share an incomplete directory merely because a file exists.

Publication never overwrites an existing destination or recursively deletes
foreign material. Partial, changed or uncertain bytes remain; only exact
proven-owned files may be cleaned. A late error can leave a verifiably complete
export, so no error alone proves nothing landed. The original error is retained,
default stderr remains static guidance, and no automatic repair or retry runs.
Each format is limited to 16 MiB; this is cooperative completion, not an atomic
directory rename, crash durability, authentication or an OS sandbox. See
[CLI_EXPORT.md](CLI_EXPORT.md) for selection, marker verification and retained fates.

Only the separately written safe JSON/text export files are intended for
sharing. Every stdout summary, including export's, remains private local output.

### `reset`
Create a fresh run; preserve the original container and results.
Required: `--run`, `--output` (fresh destination; never overwritten).
Also: the dependency options listed under `init`.

The output must be absolute with an existing ordinary parent, outside the
repository, old run and its bound results root. Reset uses unchanged C3/C2 to
mint fresh run/manifest IDs while preserving the old architecture domain and
verified C2 configuration. It restores the original workload with a new explicit
dependency request (default `none`); old lifecycle timing/history and results
references are not copied. Active/interrupted runs refuse, and no force or
destructive mode exists. See [CLI_RESET.md](CLI_RESET.md) for exact prerequisites,
wrapped initialization errors, retained-source limits and the private summary.

## Exit codes

| Code | Category | Meaning |
| --- | --- | --- |
| 0 | — | Command completed. A completed quality evaluation is a success even when individual checks failed; a low-quality evaluation is not a process failure. |
| 2 | `CLI_USAGE` | Arguments do not match the accepted grammar. No command work was started. |
| 3 | `CLI_STATE` | State or conflict (missing prerequisites, non-fresh destination, lock conflicts, refused transitions, interrupted operation requiring reconcile). |
| 3 | `COMMAND_UNAVAILABLE` | Reserved for disconnected handlers; all ten advertised commands are connected in this snapshot. |
| 4 | `CLI_INTEGRITY` | Inputs or paths failed verification; preserve local evidence and check identities, links and root separation. |
| 5 | `CLI_INFRASTRUCTURE` | Command did not complete (internal or local infrastructure failure). No score or completion is implied. |
| 130 | `CLI_CANCELLED` | Cancellation was handled and cleanup awaited. |

Error output goes to stderr as `<code>: <guidance>` and deliberately does not
include collaborator exception messages, stacks or details. Use `status` /
`reconcile` for state problems; never remove or steal a lock yourself.

## Grammar versus handler readiness

The command grammar (the list of commands, flags and required options above)
is fully in place and validated before any handler runs. Handler availability
is decided by a shared readiness table: the connected commands `init`,
`start`, `stop`, `status`, `freeze`, `reconcile`, `reset`, `evaluate`, `ui` and `export` load their
handlers lazily on dispatch, and command help is generated from that same
table, so help needs no installed assets or packages. All ten handlers are now
connected; readiness is not a claim that local evaluation prerequisites exist,
that every invocation will succeed, or that the S11 full-chain proof has passed.

## Cancellation

`SIGINT` handling requests an abort and the CLI awaits the command handler's
cleanup. There is no operating-system deadline guarantee on how long that
takes. The currently connected handlers check the signal, so an
already-aborted signal is refused before source materialization or a run
write begins; lazy module loading may already have read its prerequisites
by then, so that check does not promise that no module read or prerequisite
read has happened. The bounded current scope: an in-flight commit, such as
an initialization that has already run to completion or a start/stop
record the lifecycle layer has already written, is not rolled back or
relabelled as cancelled by a signal arriving late. This is coverage of the
current command paths, not a general promise about interrupting underlying
work mid-progress.

`evaluate` passes the handled AbortSignal to production C4, which owns bounded
stage cancellation and scratch cleanup. A returned `CANCELLED` outcome maps to
130 without a Report; an earlier actual failure can remain primary despite a
later signal request. Real command-chain/cancellation evidence is scheduled
separately; this wiring alone is not physical OS signal-delivery qualification.
