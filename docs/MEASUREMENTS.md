# Measurements (additive, local checkout)

This guide describes the C5 measurement projection in the current checkout: the pure module
`packages/results/measurements.mjs` and its declaration pair
`packages/results/measurements.d.mts` / `packages/results/measurements.d.ts`. It also describes the
optional `metrics` request field of `createReport`, integrated in the current checkout. Like
`docs/REPORTING.md`, this is checkout documentation for a local, private
surface — it makes no CLI, installation, operating-system, certification or publication claim, and
nothing here sends, publishes or shares a record. There is no DSH importer and no interval engine
in this release, and none is claimed.

Every value in examples below is symbolic or explicitly synthetic (an invented ID, an invented
count). No real run, host path, endpoint or personal value appears here.

## The one function

```ts
projectMeasurements(input): Measurement[]
```

`projectMeasurements` is pure: it reads its (Captain-validated) input and returns exactly thirteen
C1 `Measurement` records in a fixed order, each one having passed `validateRecord('Measurement', …)`
from the neutral C1 contract. It performs no file or network IO, takes no timestamps, and never
mutates its input. The input is a single run's facts, not per-actor facts:

```ts
interface MeasurementProjectionInput {
  readonly idPrefix: string;                    // used as `${idPrefix}:${metric}` per row
  readonly timing: { readonly elapsedMs: number | null };
  readonly tokens: NeutralTokenInput | null;    // null when the run carried no token statement
  readonly quality: {
    readonly automated: number | null;
    readonly humanUI: number | null;
    readonly quality: number | null;
  };
}
```

The token statement is the Captain-validated `NeutralTokenInput` (mirrored in the declaration file
as types only — the projection module does not import the contract module at runtime, because that
module imports the projection to revalidate reports):

```ts
interface NeutralTokenInput {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'NeutralTokenInput';
  readonly sourceId: string;
  readonly scope: 'RUN_TOTAL';                 // exactly one run-total statement
  readonly inputIncludesCacheReads: true;      // input already contains cache reads
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
}
```

## The thirteen rows

In this exact order, with these units. "Known" means a finite number is present; a genuine zero is
a known value and stays zero. "Unknown" is never coerced to zero: the row comes out
`value: null`, `measurementKind: 'UNAVAILABLE'`, `source: null`, with no derivation.

| # | metric | unit | value when known | record provenance (`measurementKind` / `source.kind`) | derivation formula (DERIVED only) |
|---|---|---|---|---|---|
| 1 | `elapsedWallMs` | ms | `timing.elapsedMs` | MEASURED / `COMPUTED` `benchboard-c5-measured-v1` | — |
| 2 | `elapsedWallSeconds` | s | `elapsedWallMs / 1000` | DERIVED / `COMPUTED` `benchboard-c5-derived-v1` | `{elapsedWallMs} / 1000` |
| 3 | `inputTokens` | tokens | `tokens.inputTokens` | ENTERED / `SELF_ASSESSMENT` `benchboard-c5-entered-v1` | — |
| 4 | `outputTokens` | tokens | `tokens.outputTokens` | ENTERED / `SELF_ASSESSMENT` `benchboard-c5-entered-v1` | — |
| 5 | `cacheReadTokens` | tokens | `tokens.cacheReadTokens` | ENTERED / `SELF_ASSESSMENT` `benchboard-c5-entered-v1` | — |
| 6 | `totalTokens` | tokens | `inputTokens + outputTokens` (both must be known) | DERIVED / `COMPUTED` | `{inputTokens} + {outputTokens}` |
| 7 | `automatedQuality` | points | `quality.automated` | MEASURED / `COMPUTED` `benchboard-c5-measured-v1` | — |
| 8 | `humanUIQuality` | points | `quality.humanUI` | ENTERED / `SELF_ASSESSMENT` | — |
| 9 | `finalQuality` | points | recomputed automated + human UI rounded to the scorer's four-decimal score precision, only when both components and the supplied total are known | DERIVED / `COMPUTED` | `{automatedQuality} + {humanUIQuality}` |
| 10 | `automatedPointsPerThousandTokens` | ratio | `automatedQuality * 1000 / totalTokens` (numerator known, denominator > 0) | DERIVED / `COMPUTED` | `{automatedQuality} * 1000 / {totalTokens}` |
| 11 | `finalPointsPerThousandTokens` | ratio | `finalQuality * 1000 / totalTokens` (same conditions) | DERIVED / `COMPUTED` | `{finalQuality} * 1000 / {totalTokens}` |
| 12 | `qualityPointsPerWallSecond` | ratio | `finalQuality / elapsedWallSeconds` (numerator known, denominator > 0) | DERIVED / `COMPUTED` | `{finalQuality} / {elapsedWallSeconds}` |
| 13 | `utilization` | ratio | always unknown in C5 | UNAVAILABLE / null source | — |

Every row's `measurementId` is `${idPrefix}:${metric}` (for a symbolic prefix `my-report` the first
row is `my-report:elapsedWallMs`). Nothing outside these fields is invented: no confidence, no
timestamp, no notes beyond the C1 defaults, and the C1 `source` objects here carry no
`recordKind`, `recordId` or `digest` — operational source references belong to the Captain-owned
Report provenance level, not to a C1 measurement source.

### Why null, and when zero

A null value means "not known", and it is honest: a run that never stopped cleanly has no wall
clock, a run without a token statement has no token totals, and an efficiency whose numerator or
denominator is unknown is unknown even when the other side is known. Zero means "measured or entered
as zero": with synthetic input `{ elapsedMs: 0, tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }`
the wall rows and `totalTokens` come out as genuine known zeros. Only a strictly positive
denominator produces an efficiency, so a zero token total or a zero wall second yields an
UNAVAILABLE efficiency rather than an infinite or meaningless rate.

### Token semantics: one run total, cache-inclusive input

Token numbers arrive as exactly one `RUN_TOTAL` statement whose `inputTokens` already includes
`cacheReadTokens`. `totalTokens` therefore adds input and output **only** — adding cache reads
would double count them. The contract boundary refuses anything else outright: extra totals such
as a supplied `totalTokens` field, per-actor aggregates, a `scope` other than `RUN_TOTAL`, an
absent or false `inputIncludesCacheReads` (a cache relation you cannot state is a cache relation
you must not total), cache reads exceeding inclusive input, and negative or fractional token
counts. A run that carried no token statement produces UNAVAILABLE token rows, not zeros.

### Provenance honesty

The record kinds say exactly what they mean and nothing more. `MEASURED` claims the value was read
by the named local procedure (the wall clock and the automated score); its `source.kind` is
`COMPUTED`, because the C1 contract accepts for a measured value only a local record ID, a local
digest or a `COMPUTED` source, and these rows cite a named procedure rather than a record. Token
counts and the human
UI quality are `ENTERED` through a self-assessment: they are numbers somebody supplied, and they
are **not** evidence of measured telemetry — nothing here claims a provider API verified them.
`DERIVED` rows state their whole arithmetic as the formula string in the table, so any reader can
recompute them from the rows they name. `UNAVAILABLE` claims nothing at all.
The final row recomputes the component sum rather than trusting a supplied
aggregate; a mismatched total cannot change that sum or its derived rates. That recomputed sum
carries the unchanged scorer's four-decimal score precision (`Number((automated + humanUI).toFixed(4))`,
matching `evaluator/score.mjs`), so a binary floating tail such as `12.9231 + 4` coming out
`16.923099999999998` rounds back to the scorer's `16.9231`. The rounding makes the row equal the
scorer's own precision; it never accepts a mismatched caller-supplied total.

## `createReport`'s optional `metrics` request field

The report request is **one object**, and its optional `metrics` field carries exactly one thing:
a `NeutralTokenInput` (or `null`/omitted). It is not a second argument, not an options object, and
it never carries a human UI score or any other quality number.

```js
const report = await createReport({
  reportId,            // caller-provided ID
  createdAt,           // caller-provided UTC timestamp
  selection,           // the C4 FrozenSelection the caller already holds
  evaluation,          // the returned C4 evaluation
  metrics: myNeutralTokenInput, // one RUN_TOTAL token statement, or omitted / null
});
```

`metrics` is validated through `validateNeutralTokenInput` before anything is projected; anything
the token contract refuses (an extra total, an actor aggregate, an ambiguous cache relation) is
refused at the request. Omitting it entirely means the run carried no entered token statement: the
token rows come out UNAVAILABLE, never zero. Human UI quality **cannot** enter through this field
at all — a human score can only reach a report through a validated, bound UI worksheet (the S4
attachment path), never through a free-form report argument.

The measurement set a report carries is recomputable from the bound sources plus this input;
`validateReportMeasurements` re-derives the thirteen rows and refuses a report whose stored
measurements differ from that recomputation.

## Timing honesty: the manual stop

`elapsedWallMs` comes from the lifecycle's recorded start/stop endpoints, and only when the clock
is known to run forward. The stop time is an operator attestation recorded through the manual
lifecycle (`docs/MANUAL_LIFECYCLE.md`): the harness does not enforce that the
operator pressed it at the right moment, and this release does not claim otherwise. A run whose
clock error is known, or whose endpoints are incomplete, yields UNAVAILABLE wall rows.

## What C5 deliberately does not produce

- `utilization` is UNAVAILABLE always. A truthful utilization needs complete interval coverage
  (per-actor busy intervals with known start and stop), and C5 has no interval engine, so there is
  no complete denominator to divide by. It is not zero.
- `automatedPointsPerThousandTokens` depends only on the automated score and the token total; a
  missing human UI review never withholds it. `finalPointsPerThousandTokens` and
  `qualityPointsPerWallSecond` stay UNAVAILABLE until a valid human UI quality exists, because they
  divide the final quality: a pending or invalid UI review produces no "final" number to divide,
  and a supplied `quality.quality` total alone can not resurrect it when a component is missing.
- No per-actor measurement, no extra token total, and no ambiguous cache relation ever appears.

## Privacy

The raw lifecycle and freeze/snapshot-proof records that back the wall-clock rows are operational
source records. They stay local and private inside the report's provenance (and the whole report
is a local record; `docs/REPORTING.md` describes reading and validating it locally). The separate
[Safe export API](EXPORTS.md) carries the measurement set in a safe projection: it retains the
fixed measurement values, measurement kinds, procedure and formula codes and the source kinds and
digests, and it omits the raw operational records, private labels and free-text source details.
The pure string rendering neither uploads nor publishes nor writes files.

## Related files

| Path | Role |
| --- | --- |
| `packages/results/measurements.mjs` | The pure thirteen-row projection. |
| `packages/results/measurements.d.mts` / `.d.ts` | Byte-identical declaration pair for it. |
| `packages/results/measurement-contract.mjs` | Captain-owned input validation (`validateNeutralTokenInput`), source binding and report revalidation. |
| `packages/core/manifest.mjs` | The C1 neutral contract, including `validateRecord('Measurement', …)`. |
| `docs/REPORTING.md` | The report surface the measurements are embedded in. |
