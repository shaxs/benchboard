# Descriptive comparison guide

This guide documents the descriptive comparison over the caller's raw private inputs, each read on its
own into the safe S6 compatibility summary that the result carries: `compareResults` takes the raw
records or JSON texts themselves, not already-safe compatibility exports, while `validateComparison`
and the renderers consume the already-built comparison. The guide covers what it compares, how every
input is retained, when numbers are computed, what the fixed disclosure codes mean, and what a
comparison can never claim. It is written against the current checkout — the
Captain boundary `packages/results/comparison.mjs` and its policy `packages/results/comparison-policy.mjs`,
the S6 safe wrapper (`compatibility-export-contract.mjs`) and the S7 renderers in
`packages/results/comparison-exports.mjs` — and it is checkout documentation, not a release, not
publication tooling and not a CLI. Nothing here uploads, publishes, releases or certifies anything.
The currently supported complete flow is documented in
[Complete results API flow](RESULTS_API.md), and the actual 80-point automated plus optional
20-point human scoring authority in [Scoring](SCORING.md).

A comparison is **descriptive only**. Every comparison carries the fixed notices
`DESCRIPTIVE_ONLY`, `LOCAL_SELF_ASSESSMENT_NOT_CERTIFIED`, `MANUAL_UNENFORCED`,
`NOT_FORMALLY_CONTROLLED`, `NO_FORMAL_COMPARISON` and `PSEUDONYMS_NOT_ANONYMOUS`, and
`formalComparisonAvailable` is always `false`. Manual controls are unenforced and the result is not
formally controlled; no value of this API asserts formal comparison, ranking, certification or
authority.

## The pipeline

```js
import { compareResults, validateComparison } from '<repo>/packages/results/comparison.mjs';
import { renderComparisonJSON, renderComparisonText } from '<repo>/packages/results/comparison-exports.mjs';

const comparison = compareResults({
  inputs: [recordFromCallerStorageA, recordFromCallerStorageB /* … */],
  baselineIndex: 0,
});
const json = renderComparisonJSON(comparison); // a string; writes nothing
const text = renderComparisonText(comparison); // a string; writes nothing; validates first
validateComparison(comparison);                  // independent re-check; returns a defensive copy
```

The inputs are the caller's own private records or JSON texts taken from the caller's own storage;
nothing in this API reads a path, a store or a marker. The request is exactly the bounded `inputs`
array (2 to 32 members) plus the explicit `baselineIndex` naming which member is the baseline; a
request with any other shape or any extra key is refused with `ComparisonError` (code
`COMPARISON_INVALID`). Ordering is positional and duplicates are retained: every input gets its own
indexed disposition, so every input that went in is visible in the result, including a duplicate or a
refused one.

## Retention, refusal and blocking

Each input is read independently through the S6 boundary (`createCompatibilityExport`). One bad
member never loses the others: a member the reader refuses is kept at its own index as a `REFUSED`
item carrying the fixed reason `INPUT_REFUSED` and a `null` summary — the reader's error text is
never copied into the result. Where the safe wrapper survives, it is retained as the item's
`summary`; where the reader refused, the summary is null, never a zero or an empty stand-in. Nothing
is dropped and no success is inferred: an item's disposition says what the policy could say about
that pairing, and an unknown is always null.

The baseline position decides the rest. If the baseline member itself is refused, it stays itself
the `REFUSED` baseline with `INPUT_REFUSED` (never `BASELINE`), and every other valid candidate
becomes `BLOCKED` with `BASELINE_UNAVAILABLE` — a comparison never proceeds from a comparison to
nothing; a second malformed or refused candidate remains its own `REFUSED` with `INPUT_REFUSED`
rather than being relabelled. The baseline member, once accepted, gets disposition `BASELINE` with the
fixed reason `BASELINE_NO_SELF_DELTA` and all three deltas null — the baseline is never compared
against itself — and it is `BASELINE` this way even when it is an older family or an
infrastructure-failed side, where the blocking then falls to the candidates.

Beyond the baseline question, a pairing needs current Reports on both sides. An older family —
`C1_RESULT` or `LEGACY` — is `BLOCKED` with `BASELINE_NOT_CURRENT_REPORT` or
`INPUT_NOT_CURRENT_REPORT`; its historical claims stay history and never become comparison material.
A current Report whose evaluator execution was not `SUCCESS` on either side is blocked
(`BASELINE_INFRASTRUCTURE` / `INPUT_INFRASTRUCTURE`); infrastructure trouble is never read as a score.
Malformed inputs are refused with the fixed codes above, never silently reinterpreted.

## When numbers exist

A numerical delta requires all of the following on both sides, and none of it is negotiable by the
caller:

- both are current Reports whose evaluator execution is `SUCCESS` and whose bound quality is
  present (no missing quality is ever read as zero);
- the challenge reference and challenge identity digest match;
- the workload digest matches;
- the actual evaluator's semantic digest matches — the semantic provenance of what was actually run.
  The evaluator binding is separate: `EVALUATOR_BINDING_DIFFERS` compares the binding reference and
  the binding identity digest only. Evaluator version text is neither semantic identity nor a
  blocking comparison key: a version difference does not block a numeric comparison and does not
  trigger any version code — no `VERSION_DIFFERS` disclosure exists or is invented — while each side's
  version remains visible in its own nested safe projection through the version form (the bounded
  numeric core, the full-label digest and the withheld flag). Package and binding differences are
  likewise non-blocking disclosures (see below).

With both valid bound reviews present the item is `REVIEWED` and all three deltas are computed;
with a complete bound review missing on either side the item is `AUTOMATED_ONLY` with the reason
`AUTOMATED_ONLY_PENDING_REVIEW` — the automated delta is available, the human-UI and quality deltas
stay null and pending, never zero-filled. Human and final figures require both valid bound reviews;
zero stays zero: a genuine zero difference renders as `0`, while an unknown difference is null. Every
delta is candidate minus baseline — candidate value minus baseline value — rounded through
`Number(diff.toFixed(4))`, so at most four decimals with no float noise. There is no efficiency
delta, no timing delta, no ranking and no certification anywhere in the shape: differences of
elapsed time are disclosed as context, never subtracted, and the result never orders the inputs
against each other.

Every non-comparable path (baseline, refused, blocked of any kind) carries all deltas null. A null
delta means "this comparison does not establish this number", and it is the only way to say it.

## Dispositions, reasons and disclosures

Dispositions are the closed set `BASELINE`, `REFUSED`, `BLOCKED`, `AUTOMATED_ONLY`, `REVIEWED`.
Reasons explain refusals and blocks (the fixed codes above) and close with
`AUTOMATED_ONLY_PENDING_REVIEW` or `MATCHED_CURRENT_QUALITY`; a `REVIEWED` pairing is a pairing whose
identity and workload and semantic provenance matched, not a finding that either side is good.

Every comparison starts with the two standing disclosures `MANUAL_UNENFORCED` and
`NOT_FORMALLY_CONTROLLED`. On top of those, the fixed policy discloses — without blocking — these
exact code groups, and no others:

| Group | Codes |
| --- | --- |
| Trust ceiling | `TRUST_DIFFERS` |
| Evaluator package, tooling and binding | `EVALUATOR_PACKAGE_DIFFERS`, `TOOLING_DIFFERS`, `EVALUATOR_BINDING_DIFFERS` |
| Declared ceiling | `CEILING_UNAVAILABLE`, `CEILING_DIFFERS` |
| Declared configuration (harness, model, worker count) | `DECLARATION_UNAVAILABLE`, `DECLARATION_DIFFERS` |
| Timing | `TIMING_UNAVAILABLE` (elapsed time missing on either side), `TIMING_PROVENANCE_DIFFERS` |
| Review context | `REVIEW_UNAVAILABLE`, `REVIEW_AVAILABILITY_DIFFERS`, `REVIEWER_DIFFERS`, `REVIEW_TIME_DIFFERS` |

A disclosure is context, not a verdict: it says the run conditions differed (or one side's value is
unavailable) so the reader can weigh the numbers, and it never says which side is better and never
turns a number into a controlled comparison. Different declared ceilings are disclosed, never
controlled: the policy does not normalise, adjust or adjudicate across ceilings, and a ceiling
difference does not cancel the numbers that the fixed rules otherwise allow — it simply means the
comparison was made under different declared limits and says so.

The baseline, refused and no-current-family paths carry only the fixed standing disclosures (plus
`TRUST_DIFFERS` where the trust ceilings genuinely differ): no context code is invented for a side
the comparison never examined. If the pairing never reached the review stage, the absence of review
context is not disclosed as a difference — only real, observed differences and real unavailability
are disclosed.

## The two formats

`renderComparisonJSON` returns the validated comparison serialised with two-space indentation and a
trailing newline. `renderComparisonText` opens with exactly the heading

```
BenchBoard — Descriptive comparison; manual unenforced; not formally controlled.
```

and then lists every leaf of the validated comparison — including every leaf of every nested safe
summary and its nested projection — as `dotted.path: JSON-value` lines, nulls included, with object
keys in insertion order and array indices numeric. Both renderers validate through
`validateComparison` first and return strings; neither performs IO, mutates the caller's value or
applies a privacy filter that the validation does not already enforce. Both formats render the same
validated content: the S6 safe wrapper per item with, on the current-Report path, the unchanged S5
nested projection — no raw private payload, no log text, no free-text notes, no flags beyond the
closed code lists; raw reviewer names are omitted (the review context is a reference and a
timestamp, and reviewer identity is pseudonymized, not anonymized, through the nested
`review.reviewerRef`).

## Privacy and what validation is not

The hashes that travel in the rendered form are unsalted: source and binding digests retain their
own digest definitions; `sourceRef`, `review.reviewerRef`, `configuration.harnessRef` and
`configuration.modelRef` use domain-separated pseudonyms. That is deliberate, and it cuts both ways: anyone holding a
candidate label list can recompute the hashes and mount dictionary and correlation attacks across
records, recovering the value behind any of these fields by hashing guesses. They provide no
anonymity and no secret-removal guarantee — an identifier that is itself secret-bearing stays
dangerous in hashed form — and `PSEUDONYMS_NOT_ANONYMOUS` says so in the notices. Correlation is a
real capability of these values; anonymity is not.

What the rendered form does keep, it keeps deliberately: scores, quality deltas, byte counts,
source, identity and artifact hashes, timing instants and `reviewedAt` timestamps are structured
disclosures, intentionally retained even though raw narratives and labels are omitted — so an export
may still reveal sensitive context and support sensitive inference from those fields alone. See
[Safe export privacy policy](EXPORTS.md) for the full list.

Validation — `validateComparison` and the re-check inside the renderers — is structural and
intrinsic: the closed shape, the fixed notices, the closed code vocabularies, the policy decisions
recomputed per pairing and the arithmetic recomputed per delta. It is not authentication of
authorship, not verification of any filesystem artifact, marker or store, and not a publication or
certification check. A malformed request or final comparison raises `ComparisonError`
(`COMPARISON_INVALID`), which carries no refused value and no detail; during `validateComparison`
each nested summary is re-validated through the S6 layer, so a `CompatibilityExportError`
(`COMPATIBILITY_EXPORT_INTEGRITY`) or an `ExportIntegrityError` (`EXPORT_INTEGRITY`) may propagate in
its own class — `compareResults` never lets a reader error out at all, folding it into the fixed `INPUT_REFUSED`
disposition without copying its text. There is no universal error class here.

The typed declaration pair for the comparison surface ships alongside the module; this guide makes
no compiler-level promise about it — the Captain's type test verifies actual positive and negative
consumption separately.

## Scope

This is the whole comparison surface: descriptive, local, always `formalComparisonAvailable: false`.
It ranks nothing, certifies nothing, publishes nothing and controls nothing. The complete-flow test
over this surface runs a fresh temporary production evaluation on a temporary copy and reads
synthetic review evidence, not real human judgment, with the evaluated inputs' and prior records'
bytes unchanged. Treat every comparison exactly as its notices describe it — a local self-assessment,
manual controls unenforced, not formally controlled — and nothing here is a certification, a
participant benchmark run or a publication.
