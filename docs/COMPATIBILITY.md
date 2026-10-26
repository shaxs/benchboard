# Compatibility views and safe compatibility exports

Two related but distinct entry points exist for results from earlier or different record
generations: a private local read view and a safe, non-promoting export wrapper. The read view
embeds the raw private source payload and stays on the caller's machine; the safe wrapper is
closed — older-family metadata is limited to bounded names, digests and nulls, while a REPORT
nests the unchanged S5 projection, which retains its approved numeric quality and canonical UTC
timestamps. Neither one upgrades, promotes or certifies anything.

## The private read view (local, non-export)

`packages/results/compatibility.mjs` exposes one read-side entry point for callers that hold
results from earlier or different record generations and want them under a single, honestly
labelled view:

```js
import { readCompatibilityInput } from '<repo>/packages/results/compatibility.mjs';

const view = readCompatibilityInput(raw); // JSON text or a record, from the caller's own storage
```

`readCompatibilityInput` accepts `unknown` and returns
`{ family, record, assessmentTrust, currentEvidence, currentHumanReview, warnings }`, or throws.
It is a pure wrapper: all parsing, family discrimination, trust validation and legacy reading
happen in `classifyResultInput` (`packages/results/input-contract.mjs`). This module adds no
trust vocabulary, no conversion and no score logic, never mutates the caller's data, and returns
the validated record unchanged.

Errors from the C1, report and evidence validation layers propagate in their own classes;
invalid JSON and non-object containers surface as `ResultInputError` (`RESULT_INPUT_INVALID`).
Unknown or unsupported object schemas are refused by the unchanged legacy reader in its own error
class. A recognized legacy envelope is reconstructed by that unchanged reader from the claimed
source record: only a successfully reconstructed source whose canonical envelope differs from the
claimed envelope surfaces as `ResultInputError`. If the reconstruction itself refuses the
malformed source, the legacy reader's original error propagates in its own class instead. A
container that no longer qualifies as a legacy envelope at all (for example one asserting
`promotionAllowed: true`) may also be refused by the unchanged legacy reader in its own error
class. No single universal error class is promised, and no claim is
made that every forged-looking object arrives as `ResultInputError`.

### The three input families

| family | record (unchanged) | assessmentTrust | currentEvidence | currentHumanReview | warnings (exact order) |
|---|---|---|---|---|---|
| `REPORT` | validated Report | `record.execution.assessmentTrust` | `record.evidence.bundle !== null` | `record.execution.humanReview` | `LOCAL_SELF_ASSESSMENT_NOT_CERTIFIED` |
| `C1_RESULT` | validated C1 Result | `record.evaluationTrust` | `false` | `NOT_REVIEWED` | `C1_RESULT_NOT_C4_EVIDENCE`, `C1_REVIEW_NOT_CURRENT_WORKSHEET` |
| `LEGACY` | core legacy envelope | `record.trust.evaluationTrust` | `false` | `NOT_REVIEWED` | `UNBOUND_HISTORICAL`, `HISTORICAL_CLAIMS_NOT_CURRENT_AUTHORITY`, `HISTORICAL_UI_NOT_CURRENT_WORKSHEET` |

Symbolic example with a caller-supplied input (no real historical or private data):

```js
const view = readCompatibilityInput(sourceFromCallerStorage);
if (view.family === 'LEGACY') {
  // view.record.preservedOutcome — the historical outcome object, verbatim.
  // view.assessmentTrust — always 'UNTRUSTED_LEGACY' under the historical ceiling.
}
```

### Classification ceiling and retained source payload

Recognising a family never upgrades it. The `record` is the classifier's validated output with
the source payload retained intact: a legacy view keeps `record.sourceRecord` and
`record.preservedOutcome` verbatim, `trust` clamped to the historical ceiling,
`promotionAllowed: false` and `eligibility: 'NOT_FORMAL_COMPARISON_ELIGIBLE'`, whatever the
historical payload asserts about itself.

### What the view never infers

- **Historical official/quality flags are attributed claims only.** A historical record's own
  "official" or quality statements stay inside `sourceRecord`/`preservedOutcome` as descriptive
  history. They are never read as current official status, current quality or current authority.
- **No current UI provenance.** Historical numeric scores or UI artifacts never become a current
  human review; every non-Report family reports `NOT_REVIEWED`. Nothing here substitutes for the
  current review worksheet.
- **A current C1 Result is not C4 evidence.** A `Result` validated today still gets
  `currentEvidence: false`.
- **A Report's intrinsic validation is not authentication.** Schema, digest and binding checks
  say the record is well-formed, not that anyone certified the agent's work; hence the Report
  family warning `LOCAL_SELF_ASSESSMENT_NOT_CERTIFIED`.
- **`currentEvidence` is bundle availability, not certification.** It is `true` only when the
  Report carries a complete bound evidence bundle. An infrastructure-error report has none, so
  `currentEvidence` is `false` and no completion is invented.

### The raw view is private

The returned view embeds the raw private source payload (`sourceRecord`, `preservedOutcome`, the
full validated record). It is a compatibility read for local callers and must not be logged,
attached, rendered or sent anywhere as an export. Raw originals stay private locally; the safe
wrapper below omits them, it does not discard the source.

## The safe compatibility export pipeline

A second, separate pipeline turns the same classified input into a value that is safe to hand to
a renderer. It lives in `packages/results/compatibility-export-contract.mjs` (the wrapper) and
`packages/results/compatibility-exports.mjs` (the pure renderers):

```js
import { createCompatibilityExport } from '<repo>/packages/results/compatibility-export-contract.mjs';
import { renderCompatibilityJSON, renderCompatibilityText } from '<repo>/packages/results/compatibility-exports.mjs';

const safe = createCompatibilityExport(raw); // raw JSON text or a record, from the caller's own storage
const json = renderCompatibilityJSON(safe);  // a string; writes nothing
const text = renderCompatibilityText(safe);  // a string; writes nothing
```

`createCompatibilityExport(raw)` runs the private read path above, then wraps the classified
record in the deliberately limited safe form. `validateCompatibilityExport(value)` checks an
already-safe wrapper against the closed shape and the per-family cross-field rules — never a raw
source record — and returns a defensive copy. The renderers are pure functions that return
strings: they verify no filesystem artifact, marker or authorship, write no file, and certify or
publish nothing.

The safe wrapper is closed and prose-free. Its own metadata fields are bounded enum names, hex
digests, fixed literals or nulls for an absent value, and the older families' metadata is
deliberately limited to those. A REPORT additionally nests the unchanged S5 projection, which
retains its approved numeric quality values and canonical UTC timestamps exactly as that
projection defines them — a current Report's numerical quality is retained inside its S5
projection, while historical numeric outcomes are omitted from the wrapper. Either way there is no
free-text field and no raw record: the raw numeric outcomes, preserved outcomes and official or
eligibility claims that remain verbatim in the local read view are omitted from the older families'
wrapper entirely. An older family's `report` field is null, never a zero or an empty stand-in.
Nothing in the wrapper is a new trust grant or certification vocabulary.

### What each family carries

- **REPORT** nests the unchanged S5 safe projection (`packages/results/export-contract.mjs`) in
  its `report` field with no modification, and its classification is fully null apart from the
  literal-false `promotionAllowed`.
- **C1_RESULT** keeps ONLY the fixed declared lifecycle, run, evaluator-execution, human-review
  and eligibility classifications read off the record. It carries no current C4 evidence or
  worksheet state and no current quality report; its `report` field is null. The warnings say so:
  `C1_RESULT_NOT_C4_EVIDENCE`, `C1_REVIEW_NOT_CURRENT_WORKSHEET`.
- **LEGACY** keeps the recognized `1.0` / `1.1` / `1.2` version and the recognized shape (result or
  telemetry), the `UNTRUSTED_LEGACY` trust ceiling, the `UNBOUND_HISTORICAL` binding marker, the
  reader's `DRAFT` lifecycle ceiling, `NOT_REVIEWED` as the current review status, and the fixed
  historical-claims warnings. Its `classification.runStatus` is the bounded historical `run.status`
  from the source record when present, otherwise null — an attributed historical claim of that
  source record, never a statement about current execution, outcome or trust.

`classification.declaredHumanReview` may be `SCORED` while `currentHumanReview` remains
`NOT_REVIEWED`; the two fields mean different things. The first records what the C1 result itself
declared about its past review; the second reports today's review status, which no older record
can establish. Across all three families `formalComparisonAvailable` is always `false` and
`classification.promotionAllowed` is always `false`. The wrapper warns rather than silently
upgrading or dropping records, and no record is promoted to current authority by being classified.

### sourceDigest and sourceRef

`sourceDigest` is a NEW SHA-256 computed over the canonical local reader output — the untouched
`sourceRecord` for a legacy record, the validated record for a Report or C1 Result (a C1 record's
defaults may normalize it). It is not an existing `reportDigest` and not a digest of the original
JSON bytes. `sourceRef` is a NEW domain-separated opaque hash of the family plus that digest. Both
enable correlation and dictionary inference; neither provides anonymity. The source bytes and the
original digest-bound evidence remain untouched wherever they live.

### Error behaviour

- The wrapper's own validation raises `CompatibilityExportError` (code
  `COMPATIBILITY_EXPORT_INTEGRITY`), which carries no refused content.
- The nested S5 `validateExportProjection` inside the wrapper may propagate `ExportIntegrityError`.
- `createCompatibilityExport` may propagate the existing input, C1, Report, evidence-bundle and
  measurement errors unchanged, in their own classes and without an exhaustive list.

No universal wrapper error class is promised.

### Rendering formats

`renderCompatibilityJSON` serialises the validated wrapper with two-space indentation and a
trailing newline. `renderCompatibilityText` opens with the heading

```
BenchBoard — Descriptive compatibility; no current authority or formal comparison.
```

and then lists every leaf, including every leaf of a nested projection, as `dotted.path: JSON-value`
lines. Both return strings; neither performs IO.

### Scope

The separate [Comparison API](COMPARISON.md) is available for explicitly descriptive local
quality differences: it retains older and unbound inputs as blocked dispositions, never drops or
upgrades them, and formal comparison remains unavailable. The safe wrapper carries descriptive
labels only: it presents no old record as current authority, turns no historical claim into
current evidence, and makes no formal-comparison, publication or certification claim.
