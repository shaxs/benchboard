# Safe Export API (additive)

This guide documents the additive safe-export surface: the closed, privacy-reviewed
projection of a local Report and its two pure renderers. It is written against the
current checkout — the Captain privacy boundary `packages/results/export-contract.mjs`,
its closed schema `packages/results/export-schema.mjs`, and the renderer surface
`packages/results/exports.mjs` — plus the report and publication entry points it is
typically paired with. It is checkout documentation, not an approved public release,
and it changes nothing about `docs/REPORTING.md` or `docs/PUBLICATION.md`, which keep
describing the local Report and the publication store exactly as they are.

A validated projection is **not** proof of anything. It carries the standing notices
`LOCAL_SELF_ASSESSMENT`, `NOT_CERTIFIED`, `MANUAL_UNENFORCED`, `LABELS_PSEUDONYMIZED`,
`PSEUDONYMS_NOT_ANONYMOUS`, `PRIVATE_PAYLOADS_OMITTED` and `NOT_PUBLICATION_PROOF`,
and nothing in this API promotes a local self-assessment into a certified or
authoritative result.

## Modules

| Module | Role |
| --- | --- |
| `packages/results/export-contract.mjs` | The Captain privacy boundary. `createExportProjection(raw)` validates the input as a private Report and projects the closed form; `validateExportProjection(value)` checks an already-built projection; both return defensive copies. The export layer's own refusals throw `ExportIntegrityError` (code `EXPORT_INTEGRITY`); `createExportProjection` may additionally propagate Report, evidence-bundle and measurement errors in their own classes, as the validation section below details. |
| `packages/results/export-schema.mjs` | The closed JSON Schema (draft 2020-12) behind the boundary, plus the frozen notice and metric vocabularies. Every object closes `additionalProperties: false`; free text appears nowhere. |
| `packages/results/exports.mjs` | The renderer surface. Exports exactly two functions, `renderReportJSON(projection)` and `renderReportText(projection)`. Both accept `unknown`, validate through `validateExportProjection` first, return text and touch no filesystem. |
| `packages/results/export-contract.d.mts` / `.d.ts` | The byte-identical typed declaration pair for the boundary. |

## The one pipeline

The whole flow is plain executable ESM over the shipped modules, synchronous apart
from the optional published-record read. Every name below is a caller-provided
variable, never a real host path or a real run:

```js
import {readReport} from './packages/results/report.mjs';
import {createExportProjection} from './packages/results/export-contract.mjs';
import {renderReportJSON, renderReportText} from './packages/results/exports.mjs';

const report = readReport(reportJsonText);        // validated local Report record
const projection = createExportProjection(report); // closed, privacy-reviewed copy
const json = renderReportJSON(projection);         // two-space JSON, trailing newline
const text = renderReportText(projection);         // fixed notice line + flat leaves
```

A report committed through the [Publication API](PUBLICATION.md) can enter the same
pipeline instead of a local read — `const report = await readPublishedReport({storeRoot, reportId})` —
and the rest is identical. Beyond that entry point this API introduces no filesystem
export writer, no CLI and no upload: the renderers return **text**, and carrying that
text anywhere is the caller's own, separate action.

Only the projection is renderer input. Both renderers accept `unknown` but accept
only an already-safe projection: a raw Report, a projection carrying a private extra,
or any structurally invalid value is refused with `ExportIntegrityError`
(`EXPORT_INTEGRITY`). Raw Reports are rejected by the same validation, not filtered
out afterwards. Nothing here ever validates-then-forgets: each render re-validates
its input, the caller's value is never mutated, and repeated renders are
deterministic.

## What the renderers emit

`renderReportJSON` returns the validated defensive copy serialised with a two-space
indent and a trailing newline. `renderReportText` returns a fixed flat format: the
notice line

```text
BenchBoard — Local self-assessment; not certified; manual stopping is not enforced.
```

followed by **every** validated leaf as `dotted.path: JSON-encoded value` — one per
line, object keys in insertion order, array indices numeric, `null` rendered as a
value, and empty arrays rendered as the literal `[]`. No leaf is dropped and no
value is reformatted; the flat text is the same data as the JSON, flatter.

## What the projection carries

The projection is closed: every field is one of a fixed vocabulary of bounded enum
names, a 64-hex digest, a pseudonymized reference, a bounded numeric value, a
canonical UTC timestamp, or `null` for an absent value. There is no free-text field
and no open index signature anywhere in the shape, and validation refuses extras —
anything outside the fixed enum, hex, numeric-core and time slots cannot be
represented or smuggled through. Concretely it carries:

- **Identity and digests, preserved and computed kept apart.** Two digest kinds
  must not be confused. Preserved digests are the source record's own values,
  transported unchanged: the report's `reportDigest`, the parent report digest, the
  evaluation bundle digest, the identity, workload, manifest and tree digests, the
  source-record digests and artifact `sha256` values. Computed digests are new,
  deterministic, domain-separated hashes created at projection time: every
  pseudonymized reference and every version `fullDigest`. Source hashes, numeric
  measurements and timestamps are retained **deliberately**: they are what makes a
  projection checkable.
- **Pseudonymized labels.** The report, run, manifest, submission, snapshot,
  evaluation, parent report, challenge, evaluator, tooling, harness, model, reviewer
  and every artifact become opaque 64-hex pseudonyms (report/run/artifact/reviewer/
  configuration references alike). Raw environment names, flags, endpoints, logs,
  filesystem paths, operational source records, legacy payloads, review prose and
  screenshots are not carried and are not representable.
- **Versions in a bounded shape.** Each version slot becomes `{core, fullDigest,
  suffixWithheld}`: a bounded numeric `major.minor.patch` core, or `null` when the
  complete label has no such bounded core; `fullDigest`, a NEW domain-separated
  opaque digest computed over the complete version label at projection time (not a
  source digest transported unchanged); and `suffixWithheld`, true whenever the
  complete label is not exactly the bare bounded core — either a prerelease/build
  suffix is being withheld, or the label sits outside the bounded numeric shape and
  its `core` is null — and false only when the label is exactly the bare core.
- **The full score block, when there is one.** Automated points out of 80 broken into
  the eight fixed areas — visible 7, functional 30, persistence 10, edge 5,
  integration 15, code 5, usefulTests 5, hygiene 3 — and human UI points out of 20
  broken into the seven fixed integer categories — polish 5, hierarchy 3, board 3,
  drawer 3, feedback 2, responsive 2, consistency 2 — with the combined quality out of
  100. The areas and categories are fixed named fields; no other score area is
  representable.
- **Bounded measurement rows.** At most thirteen rows over the fixed metric names,
  each keeping its value and measurement kind, plus fixed code names for its origin
  (`COMPUTED`/`SELF_ASSESSMENT`), attestation procedure (`MEASURED_V1`/`ENTERED_V1`/
  `DERIVED_V1`) and derivation formula. An `UNAVAILABLE` row carries `null` with its
  source, procedure and formula codes `null` — unknown is null, never zero. Arbitrary
  procedure text, formula text or notes are not carried.
- **Source references, thinned.** Operational sources keep only their fixed kind
  (`lifecycle`/`snapshot-proof`/`evaluation`/`token-input`) and their digest. The
  record contents stay private.
- **Review, reduced.** A completed review contributes the reviewer pseudonym, the
  unchanged review instant, the seven category scores and artifact references. Review
  prose, notes and screenshot bytes are not carried.

Honest nulls are preserved, never filled in, and each goes null on its own
schedule rather than in lockstep. While human review is pending, the human UI
component score, the combined final quality and the whole review object are
`null`, while `execution.humanReview` reads the enum `NOT_REVIEWED` — never null.
For an infrastructure report the whole quality block is `null`. Timing fields are
independently optional: each endpoint may be missing on its own, and `elapsedMs`
stays null when no usable interval is derivable even though both endpoints exist
(a reversed or erroneous clock), so no timing group is null as a set.
`provenance` is `OPERATOR_ATTESTED` exactly when both observed endpoints are
present, attesting observed endpoints — never an enforced or trusted elapsed
duration. The execution block keeps `agentOutcome: null`, `enforcement: 'manual'`
and `enforced: false` — stopping is manual and unenforced — and its four axes
(outcome, evaluator execution, human review, assessment trust) are independent, so
no agent outcome is inferred from a successful evaluation.

Exporting changes nothing. The pipeline reads a record and returns text. Every
source record and source byte is preserved unchanged: the Report record, the
frozen run bytes and any published record all stay exactly as they were, and the
renderers touch no filesystem at all.

## What the pseudonyms do and do not do

The pseudonyms are unsalted, domain-separated hashes of the real identifiers. That
is deliberate — a holder who knows an identifier can recompute its pseudonym — but
it cuts both ways: anyone with a candidate identifier list can mount dictionary and
correlation attacks, testing guesses and linking the same run, report or reviewer
across exported datasets. Pseudonymization is therefore **not anonymity**, and it
is **not** a credential-detoxification guarantee for a dataset: an identifier that is
itself secret-bearing stays dangerous in hashed form. A valid projection is
not a publication proof and not a certification; deciding what leaves the machine is a
separate, human act, and these files make no claim about what anyone does with the
rendered text.

## What validation is, and which errors keep their classes

`validateExportProjection` is structural and intrinsic: the closed shape, the fixed
vocabularies, cross-field agreement (score sums, pending-versus-scored consistency,
measurement availability, canonical timestamps) and nothing more. It does **not**
authenticate authorship, verify that a projection was produced by this code path, or
check any external state; a schema-valid projection does not authenticate its source
or verify publication. `createExportProjection` additionally validates the input as
a private Report before projecting it, and validation performs no re-read of external
evidence or publication markers.

Refusals at this layer are `ExportIntegrityError` with code `EXPORT_INTEGRITY`, and
the class carries no refused content. Upstream failures propagate in their own
classes with no universal wrapper and no promise: `createExportProjection` may
rethrow the report, evidence-bundle and measurement integrity errors or earlier-layer
errors unchanged, in their own classes and without an exhaustive list. The two
renderers and `validateExportProjection` are synchronous; the optional
`readPublishedReport` entry is the only promise in the pipeline. No function here
makes a promise about a check it did not execute.

## Scope: current reports only

The projection family of this guide is `REPORT` and nothing else: the Report-specific
S5 API is unchanged and stays REPORT-only. Historical safe exports (S6) and C1
compatibility summaries use the separate safe wrapper in
`packages/results/compatibility-export-contract.mjs`, which exports
`createCompatibilityExport` and `validateCompatibilityExport`, with the pure
renderers `renderCompatibilityJSON` and `renderCompatibilityText` in
`packages/results/compatibility-exports.mjs` — see
[Compatibility](COMPATIBILITY.md). The wrapper reuses this S5 projection for
Reports and supplies deliberately limited, non-promoting classifications for
C1 and historical records; it never exports a raw payload, presents an old
record as current authority, or turns historical claims into current evidence.
The local compatibility reader (`readCompatibilityInput`) still exists unchanged,
and raw sources stay private locally. The separate [Comparison API](COMPARISON.md)
is now available for explicitly descriptive local quality differences; formal
comparison remains unavailable. The publication save, review-attach and
read operations of [S4](PUBLICATION.md) are separate concerns from exporting; note
in particular that a publication read takes the store lock and may write
storage/lock metadata, while the export pipeline writes nothing at all.

## Current checkout command cross-links

The same projection is what the checkout's `export` command writes to an
external output directory; that command's requirements, output publication,
retained-file handling and cleanup are documented in
[CLI_EXPORT.md](CLI_EXPORT.md), and its neighbours are listed in
[CLI.md](CLI.md). The command is additive composition over this API: it consumes
C5 projections and the publication store the same way a programmatic caller
does. The projection validation (`validateExportProjection`/`createExportProjection`)
and the renderers (`renderReportJSON`/`renderReportText`) stay independent of
CLI attempt history — no CLI history is required to validate a projection or
render an export. There is no public reader API and no CLI counterpart to a
"safe export reader": nothing here reads an export back as a second surface.

No standalone export verification or repair command exists in this checkout:
failure, retention and cleanup behaviour remain exactly as stated in the
publication and contract sections above for the API, and as stated in
[CLI_EXPORT.md](CLI_EXPORT.md) for the command's own publication and retained
material. The evaluation and
human-UI commands that produce the records being exported are covered by
[CLI_EVALUATION.md](CLI_EVALUATION.md) and [CLI_UI.md](CLI_UI.md).

## Testing

```text
node --test tests/results/export-contract-types.test.mjs tests/results/exports-documentation.test.mjs
```

Those checks are static: the declaration-pair check typechecks a strict consumer
against the shipped declarations, and the documentation check reads this guide.
Neither runs an evaluation, a publication or a server.
