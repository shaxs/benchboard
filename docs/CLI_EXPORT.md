# Current safe export guide

This guide describes the `export` command of the development-checkout CLI as it
exists now: one operator-stated write of the two safe summary formats for an
already-committed evaluation report, plus a completion marker, into a fresh
directory you name. It is a supplement to [CLI.md](CLI.md) (the full command
reference and exit-code table), [CLI_CONTEXT.md](CLI_CONTEXT.md) (run and
results context), [EXPORTS.md](EXPORTS.md) (the privacy projection the files
are built from), [PUBLICATION.md](PUBLICATION.md) (the store the selected
reports live in) and [HUMAN_UI.md](HUMAN_UI.md) (why the human UI score stays
unavailable until bound evidence succeeds). Local, development-only use:
exporting scores nothing, launches no browser, server, agent or installer, and
changes no report.

## What export does in one sentence

`export` reads the run you name, selects one executed CLI completed evaluation
report from the publication store — the baseline, or an explicitly chosen
direct reviewed child of it — renders it through the accepted
C5 privacy projection into JSON and text, and writes exactly three files —
`report.json`, `report.txt` and a completion marker `EXPORT_COMPLETE.json` —
into a fresh directory you name.

## Invocation

```
node cli/benchboard.mjs export --run "<RUN_ABSOLUTE_PATH>" --evaluation "<EVALUATION_ID>" --output "<FRESH_EXPORT_DIR_ABSOLUTE_PATH>"
```

with an optional explicit report:

```
node cli/benchboard.mjs export --run "<RUN_ABSOLUTE_PATH>" --evaluation "<EVALUATION_ID>" --report "<REPORT_ID>" --output "<FRESH_EXPORT_DIR_ABSOLUTE_PATH>"
```

- Generic placeholders, quoted so values containing spaces are not split into
  separate argument tokens: `<RUN_ABSOLUTE_PATH>` is the absolute path of the
  run container; `<EVALUATION_ID>` and `<REPORT_ID>` are the local identifiers
  of the evaluation and the report record; `<FRESH_EXPORT_DIR_ABSOLUTE_PATH>`
  is the absolute path of the export directory to create. Use your real local
  values in place of them.
- Required: `--run`, `--evaluation`, `--output`. Optional: `--report`. The
  outer parser owns the `--run` flag and unknown-flag rejection; help requests
  and parse shapes follow [CLI.md](CLI.md).
- The export handler is connected in the checkout's fixed readiness table, so
  the command runs in this checkout instead of returning the still-unavailable
  readiness refusal. Its operational imports are lazy: the operational schemas
  and collaborators load on the first execution of the handler, and parsing
  itself makes no universal no-read promise for operational work.
- Every successful invocation writes one JSON summary line to stdout and exits
  0 (see [The stdout summary](#the-stdout-summary)). A command that fails
  instead preserves its error and writes no success summary.

Flag values are checked before any run state is read. `--evaluation` and, when
supplied, `--report` must be safe identifier strings (a letter followed by two
to one hundred twenty seven letters, digits, dots, underscores or dashes —
three to one hundred twenty eight characters in total), and `--output` must be
a nonblank string kept exactly as given (never trimmed, never normalized by
the flag check). An absent `--report` yields no report identifier and no
implicit selection: there is no default to a latest child and no guessed
report. A missing required flag, a blank or nonstring value, or a value that
fails the identifier pattern is a usage error (exit 2). A present flag whose
value is `undefined` counts as supplied and is refused the same way.

## Which report is selected

Selection runs only after the run state has been read. The evaluation
identifier you name must select exactly one executed CLI completed baseline
attempt of that run. A matched attempt record carries both a terminal outcome
with a report identifier and an executed evaluator execution, and the
corresponding evaluation and report identifiers of those two records agree
with each other; the matcher keeps the attempts matching your `--evaluation`
(and, when a report was named, the baseline that the named report descends
from or is), and refuses when what remains is not exactly one attempt. There
is no latest-child inference, no adoption of an arbitrary store record, no
adoption of a legacy execution-less completion, and no promotion of an
incomplete planned report.

The optional `--report` must be either that exact baseline or its direct
reviewed child, verified against the baseline: the run, manifest, manifest
digest, snapshot, frozen submission and tree bindings must match, the
evaluation identifier and bundle digest must match, and a child must carry the
baseline as its parent identifier together with the matching parent digest. A
mismatch, a reference to a record that does not exist, or any other unknown
reference is a state refusal (exit 3) or the actual accepted C5 refusal
category for it — the mapping is the one in the checkout's diagnostics table,
not a blanket usage code.

## The output destination

The `--output` value must be an absolute path naming an ordinary file or
directory spelling before its file IO starts. The check refuses relative
spellings and explicit dot segments, Windows alternate-stream, device and
namespace spellings, UNC and doubled-slash leads, wildcard punctuation
(`<`, `>`, `"`, `|`, `?`, `*`, `:` in a later segment), trailing-dot and
trailing-space aliases, and control characters. It runs before IO on that
path, not before every run-state read, so a run-side refusal can surface first.
The selected run's own path normalization policy is unchanged, and this
conservative spelling policy is not a comprehensive operating-system
qualification.

The destination must be fresh (nothing existing at that path), an ordinary
directory under an existing ordinary parent, and disjoint from the repository
checkout, from the selected run container and from the entire results root
(including the publication store root). There is no overwrite, no parent
invention and no force flag. An existing ordinary destination is a state
refusal (exit 3); a linked, special or path-integrity refusal is an integrity
error (exit 4); a raw IO failure is an infrastructure error (exit 5). A
concurrent competing creator losing the exclusive-create race on the fresh
directory is also an infrastructure error (exit 5) — and the winner's export
is untouched by the loser's refusal.

## The three files and the marker

A published export directory holds exactly `report.json`, `report.txt` and
`EXPORT_COMPLETE.json`, and nothing else.

Both content files are built from one accepted C5 privacy projection: the
command builds the projection through the Captain-owned export-contract
boundary once and renders both formats with the two accepted renderers
`renderReportJSON` and `renderReportText` (see
[EXPORTS.md](EXPORTS.md) for what the projection keeps, withholds and
refuses). The command never serializes a raw Report or a worksheet, and it has
no privacy scrubber of its own. The writer validates the parsed projection and
the exact JSON/text format parity — before creating the directory, again
before writing the marker (against the bytes read back from the two content
files), and once more after the marker is written. The acceptance check is on
the rendered bytes, not on trust in the caller.

Each content format is bounded to 16777216 bytes (16 MiB). A rendered format
above that bound is an integrity refusal before anything is written.

The marker is a fixed-closed JSON document. The shape below is illustrative
text with placeholders, not itself valid executable JSON:

```text
{
  "kind": "benchboard.cli.safe-export.v1",
  "schemaVersion": "1.0.0",
  "files": [
    { "path": "report.json", "bytes": <BYTE_COUNT>, "sha256": "<LOWERCASE_SHA256>" },
    { "path": "report.txt", "bytes": <BYTE_COUNT>, "sha256": "<LOWERCASE_SHA256>" }
  ]
}
```

The counts are byte counts of the two content files, and the hashes are
lowercase SHA-256 hex digests of their bytes. No raw run, report or evaluation
identity, no root path, no reviewer, no worksheet and no storage envelope
enters the marker. This marker is distinct from the Report commit marker used
inside the publication store, and it is not origin authentication and not, by
its own existence, proof of anything: the byte relationship between the three
files in one directory is established only by a successful current read-only
verification of the files against the closed marker contents, never by the
marker's filename or presence. Do not fabricate or edit a marker file to bless
a partial export — a marker you wrote yourself is not an export that this code
path verified.

## What is retained in the files, and the null-versus-zero rule

The files carry the C5 projection's fixed structured disclosures unchanged —
the pseudonymized opaque references and digests, the provenance records, the
bounded version shapes, the bounded numeric scores, the standing notices
(`NOT_CERTIFIED`, `PSEUDONYMS_NOT_ANONYMOUS`, `NOT_PUBLICATION_PROOF` and the
rest) and the stated correlation limits. Exporting washes none of them away and
adds no blanket anonymization and no signed or certified form. Read
[EXPORTS.md](EXPORTS.md) before sharing anything; the pseudonymization is not
anonymity.

Unavailable values stay null and genuine zeros stay zero. While human review
is pending, the human UI component score and the combined final quality export
as `null`; a review that genuinely recorded zero in a category exports as that
zero; positive numeric values are unchanged. A committed infrastructure Report
exports the execution status `INFRASTRUCTURE_ERROR` with quality `null` and its
actual evaluator `null`; it does not become an automated zero or a human
review, and its stdout/files do not carry a copied raw diagnostic or error
record. The human UI score becomes representable only after the required
successful bound evidence exists (see [HUMAN_UI.md](HUMAN_UI.md)).

## The stdout summary, and what is private

On success the command writes one stdout JSON line with the command name, the
private run, manifest, evaluation and report identifiers, the report digest,
the execution and human-review status, the three explicit score fields
`automated`, `humanUI` and `quality` as recorded (including nulls), the output
directory, whether the export is complete, the content file
names and the marker name. That summary stays local private output, like every
other CLI stdout summary: it names identities the safe files deliberately
pseudonymize, and it is not the sharing boundary. The sharing boundary is the
two safe files; the marker carries no identity either. On failure no success
line is written at all, and the default stderr stays the fixed static
guidance line for the refusal category — no raw error causes, paths, logs,
stacks, annotation roots or newly generated identifiers appear there.

## How publication works, and what it does not promise

Publication is a cooperative ownership protocol, synchronously executed:

1. The projection and exact format parity are validated before any filesystem
   mutation on the output.
2. The destination must pass the fresh-path spelling check, the non-existence
   check, and the disjointness check against the protected roots.
3. The parent chain is claimed (ordinary directories, checked both before and
   after each later read), then the directory is created with an exclusive
   mkdir (mode 0700 request) and recorded with a claimed identity (device,
   inode number and creation time).
4. Each of `report.json` and `report.txt` is created with an exclusive-create
   open (mode 0600 request) under a claimed single-link ordinary-file identity,
   written, closed, then read back and compared byte-for-byte against the
   validated bytes; around each individual read the file's claimed identity,
   single-link ordinary type, exact bytes and root/ancestor chain are
   re-checked. That per-read guarding is identity-and-bytes work, not a full
   directory-membership pass after each read.
5. The directory-membership pass (ordinary files only, no links, no extra
   entries, exactly the owned names) runs before each write, and at the start
   and end of each complete-pair and marker verification pass.
6. Only then is the marker written with the same exclusive-create and identity
   rules, and one final verification pass reads all three files back —
   membership at both bounds, per-file identity and bytes, and the projection
   and format parity re-validated from the read bytes. A full verified pass is
   what makes the export complete.

Exclusive creation means two cooperating writers going through this same path
cannot overwrite each other's files. On the guarantees' limits, keep these
boundaries in mind:

- The permission modes are creation requests; they are not an access-control
  or security guarantee about who can read the export afterwards.
- This is a completion-marker protocol, not an atomic directory rename and not
  a power-loss durability guarantee. A directory containing a marker file whose
  bytes you did not verify is not proof of completeness; the marker's content
  and the file bytes must match.
- Ownership is a claimed identity checked around each IO. Same-byte foreign
  replacement and directory-or-ancestor substitution are rejections the checks
  can refuse, not outcomes the operating system enforced after the claim; an
  adversarial process racing the very same identity fields is outside what the
  initial namespace claims qualify for.
- Later foreign mutation of a completed export is not prevented by the
  operating system. A verified complete export stays complete only as long as
  membership and bytes stay exact.

## Failure fates

Every failure preserves the original error and emits no success stdout. The
structured fate assessment below, however, is scoped to failures that happen
after the command has entered the claimed-publication phase — the writer's own
try block, once the output root's identity is about to be claimed or has been
claimed. Projection-validation (`safePair`), fresh-path, pre-existing
destination and protected-root containment failures occur before or outside
that block; they preserve their error and write no success stdout, but they
carry no guaranteed `error.exportFate` annotation.

For a failure inside the claimed-publication phase, the command determines,
without inventing anything, what actually happened to the output directory:

- If the three claimed files still form a verifiably complete export (exact
  membership, ordinary single-link identities, exact bytes, format parity, a
  verified marker), the files remain in place even though the original error
  is still thrown. This is the late-completion case: work that had already
  landed is not relabelled as cancelled or erased.
- Otherwise, cleanup runs: it is nonrecursive and removes only files that are
  still exactly as this invocation owned and claimed them (exact name, exact
  bytes, exact claimed identity). Partial files, changed bytes, foreign files
  and files whose state cannot be verified remain untouched. An export root
  that is still claimed-identified and now empty may be removed. Parent and
  root claims are re-checked before every write, read and cleanup step.

When possible, the helper attaches the fate to the original error object as a structured
annotation `error.exportFate` with a `complete` boolean and a `cleanup` value
of `unclaimed`, `removed` or `retained`. A fate of `unclaimed` means no
verified claim was ever established on the root within the claimed-publication
phase — for example the exclusive mkdir itself failed inside the try block —
and is not proof that no directory exists. The annotation is a local
programmatic detail for callers holding the error and is never printed by the
default CLI stderr as a dump of that annotation, the output root or new
identifiers. A cleanup or annotation failure never replaces the original
error: cleanup is best-effort and the original refusal surfaces.

`complete: false` means this invocation could not establish its full claimed
completion check. It is not an independent proof that retained files are absent
or that their content cannot form a valid safe pair; ownership uncertainty and
foreign replacement can prevent that conclusion.

## After a failure

There is no public verify-export and no repair command. After a failed export,
preserve the output directory the way you preserve other local evidence.

A programmatic read-only check of a possibly complete export must compare
everything against the closed marker in the directory: the exact three-file
fixed membership (ordinary files, no links, no extra entries), the C5
projection validation of the parsed JSON, text/format parity between the two
files, and the byte counts and lowercase SHA-256 hashes named in the closed
marker structure against the actual file bytes. Do not reconstruct ownership or
completeness from filenames alone, and do not invent reader APIs — no
`verifySafeExport`, `readSafeExport` or similar public API exists in this
checkout. Keep the limits in mind: content verification is not creator
authentication, and a nonzero exit code alone does not establish what was
published — a late error can sit on top of a verifiably complete export, and
an exit code carries no fate detail.

## Cancellation

A handler invocation that starts with the signal already aborted is refused as
cancellation before any state check (exit 130), and the command checks the
signal again immediately before publication begins. Publication itself is
synchronous and in-flight cancellation has no stated rollback, interruption or
late-completion relabeling guarantee for this command: a signal arriving once
publication is under way resolves as whatever the publication and failure paths
above actually produce. There is no physical operating-system signal
qualification claim.

## Testing

```text
node --check cli/export-command.mjs
```

That syntax check parses the command module and nothing else — it publishes
nothing and reads no run. The projection boundary and renderers themselves are
documented in [EXPORTS.md](EXPORTS.md), and their tests are listed there.
