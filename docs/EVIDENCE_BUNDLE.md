# EvidenceBundle API (additive)

This guide documents the additive `bundle` surface the current production facade
attaches to the accepted S1 result envelope. That facade is the delivered C4
`evaluateFrozen` (`packages/evaluation/evaluate-frozen.mjs`), the present evaluation
entry point, not a future or planned S2 pipeline: on success it resolves with the
unchanged S1 fields plus one additive, validated `bundle`, and its top-level `score`
stays `null` in both returned shapes — the complete automated score lives only at
`bundle.score`, and the null top-level field is deliberate S1
compatibility for earlier consumers. It is written against the actual checkout: the Captain
trust boundary `packages/evaluation/bundle-contract.mjs`, the closed JSON schema
`schemas/evidence-bundle.schema.json`, the evaluator identity module
`packages/evaluation/evaluator-identity.mjs` and the facade declarations
`packages/evaluation/evaluate-frozen.d.mts`. It is checkout documentation, not an
approved public release. `docs/EVALUATION.md` describes the same current facade and
result envelope, and this guide leaves its description of them as it stands. For the
later C5 flow — the bound local report, publication, safe export and descriptive
comparison — see [Reporting](REPORTING.md) and the crosswalk in
[Complete results API flow](RESULTS_API.md). The bundle is local evidence, not an
export: it carries the bounded environment block and the output-relative artifact
inventory (`{ path, bytes, sha256 }` records), nothing in it authenticates any person
or run or claims certification, and a carried bundle is not a privacy-safe export.

## Modules

| Module | Role |
| --- | --- |
| `packages/evaluation/bundle-contract.mjs` | The evidence trust boundary. Exports `EvaluationIntegrityError` (code `EVIDENCE_INTEGRITY`), `validateScorerEvidence(raw)` and `validateEvidenceBundle(value)`. Validation never supplies a missing point or boolean. |
| `packages/evaluation/bundle.mjs` | The pure assembler/reader: `assembleEvidenceBundle({ result, identities, artifactDigests })`, `scorerEvidenceOf(bundle)`, `readEvidenceBundle(text)`. Pure projection: no filesystem, subprocess or crypto work of its own. |
| `packages/evaluation/evaluator-identity.mjs` | `computeEvaluatorIdentity()` computes the actual installed evaluator identity: semantic and package manifests, versions, and the original candidate hashes. |
| `schemas/evidence-bundle.schema.json` | The closed JSON Schema (draft 2020-12) the validator compiles. Unknown keys and invalid primitives are rejected everywhere (`additionalProperties: false`). |

## Where the bundle appears in the result

- **Success** — `evaluateFrozen` resolves with the unchanged S1 success fields
  (`status`, `evaluationId`, `evidence`, `stages`, `snapshot`, `environment`,
  `cleanup`, `artifacts`) **plus one additive field: `bundle: EvidenceBundle`** —
  a complete, validated bundle. Nothing else changed.
- **Infrastructure failure** — the S1 infrastructure shape
  (`status: 'infrastructure-error'`, `evidence: null`) with **`bundle: null`**.
- **Top-level `score` stays `null` in both shapes.** This is deliberate S1
  compatibility: raw S1 evidence consumers must not see a score appear at the top
  level. The complete automated score lives only at **`bundle.score`**. Tool and
  infrastructure failures (`TIMEOUT`, `CANCELLED`, `MISSING_PREREQUISITE`,
  `TOOL_CRASH`, `OUTPUT_LIMIT`, `INVALID_TOOL_OUTPUT`, `CLEANUP_FAILED`) live in
  the result's `error` diagnostic; they never produce a bundle, a partial bundle
  or partial points.
- **Rejection is the third outcome, and it is thrown.** When a modeled
  integrity fault means the evaluation cannot be honestly assembled into a
  validated bundle, `evaluateFrozen` **rejects** — a thrown `EvaluationIntegrityError` (code
  `EVIDENCE_INTEGRITY`), alongside the `EvaluationRefusalError` request/safety
  class. Such a rejection may fire *before any tool runs* — when the installed
  evaluator identity or the recorded candidate-lineage inputs the facade checks
  before invoking the controller are missing or inconsistent — or *after the
  completed stages* — when bundle, artifact or identity validation fails at
  attachment time. These are the modeled expected faults, not a claim that no
  other bug can occur.
  A rejection never returns the raw S1 result, a partial bundle or
  partial points; diagnostic outputs already retained under the caller's own
  `outputRoot` may remain, and the caller handles the rejection.

## The bundle's closed keys

The schema requires exactly these top-level keys and rejects every other key:

- `schemaVersion` — e.g. `1.0.0`; the schema pattern rejects unknown major versions.
- `kind` — the constant `EvidenceBundle`.
- `evaluationId` — the `eval-`-prefixed identifier of the attempt.
- `executionStatus` — the constant `success`. Incomplete or infrastructure
  execution has no bundle and no partial score.
- `identities` — the identity block, below.
- `properties` — exactly 25 validated hidden property records; each projects
  exactly `{ id, area, passed }` (no source text, no diagnostic error strings).
- `visible` — `{ passed, total: 17 }`; `total` is the scoring denominator, not an
  invented observed metric.
- `build` — validated boolean.
- `typecheck` — validated boolean.
- `noSuppression` — validated boolean.
- `usefulTests` — `{ baselinePassed, addedCount, killedMutations }` with the five
  mutation names `storage-drop`, `input-drop`, `focus-drop`, `label-case`,
  `date-order`, unique inside the array.
- `hygiene` — five validated booleans: `visibleIntact`, `lockedDependencies`,
  `noSecrets`, `noDebugLogging`, `noNetwork`.
- `environment` — the S1 bounded fields `label`, `nodeVersion`, `platform`,
  `architecture`, `browserVersion` (label and browser version may be `null`; the
  label is a bounded non-private string).
- `artifactDigests` — a supplied array of `{ path, bytes, sha256 }` records for
  retained output. Paths are validated as output-relative POSIX-style relative
  paths — never raw private or host-specific absolute paths.
- `snapshot` — `{ before, after, workspaceMatchesFrozen }` digest observation.
- `score` — the scoring block, below.

## Identities: three different layers, not one mixed hash

`identities` carries three layers explicitly so nobody can conflate them:

1. **Challenge/tooling binding** — `challenge: { id, digest }` and
   `tooling: { id, digest }`: the neutral identity records sealed into the run
   manifest and re-verified by the facade (a difference is the `IDENTITY_MISMATCH`
   refusal). These are binding records, not a digest of every source byte.
2. **Submission** — `runId`, `snapshotId`, `frozenSubmissionId`, `manifestDigest`
   (the sealed run-manifest digest) and `treeDigest` (the frozen snapshot tree).
   The bundle's `snapshot.after` must equal `treeDigest`.
3. **Evaluator** — `binding: { id, digest }` (the C1 neutral evaluator binding),
   `evaluatorVersion` and `scoringVersion` (derived, immutable, from the candidate
   `version.json`), `hashAlgorithm: 'benchboard-sha256-tree-v1'`,
   `semanticManifest`/`semanticDigest` (the preserved evaluator sources actually
   used for scoring: the requested evaluator modules, hidden properties, canonical
   tool files, starter tests and fixtures, recursively),
   `packageManifest`/`packageDigest` (the installed package wrapper: the ordinary
   `packages/evaluation` modules, their declarations and the schema), and
   `originalCandidate: { evaluator, scoring }` — the actual recorded original
   candidate evaluator tree and score hashes, **not** mislabeled synthetic C1
   binding hashes. They come verbatim from the fixed record
   `packages/evaluation/candidate-lineage.json` (`candidateVersion`, `evaluator`,
   `scoring`), whose scalar hashes were copied exactly from the immutable
   candidate preservation baseline — never minted from installed bytes — and the
   record itself is validated (exactly those three keys, 64-hex digests) and is
   part of the installed package wrapper digest. At identity computation the
   **actually installed** evaluator tree and the installed `evaluator/score.mjs`
   bytes are rehashed and must still match the record, as must the candidate
   `version.json` version; an installed mismatch **refuses** with
   `EVIDENCE_INTEGRITY` — drift is never relabeled as the original.

### What each hash covers, and what it does not claim

- **Two deliberately different hash domains, stated with the hash.** The
  `originalCandidate.evaluator` hash covers the **historical default-skip
  domain**: the actually installed `evaluator/` tree as the preserved default
  skip computes it — the same `node_modules`, `dist` and `.git` exclusions the
  original candidate evaluator hash was computed with. The explicit
  `semanticManifest` is a **different domain by design**: every selected input
  file — evaluator modules, hidden tests, canonical tool files, starter tests
  and fixtures — enumerated and hashed with no default skip at all. Read each
  hash against the domain the guide names for it.
- **Not cryptographic authenticity.** All of these are the preserved tree and
  digest algorithm (`hashAlgorithm: 'benchboard-sha256-tree-v1'`): change
  detectors over byte trees. Nothing is signed, and no authenticity
  certification is claimed. No hash algorithm and no scoring grade are changed
  by any of this.

## Scoring inside the bundle

`score` is the unchanged established scorer applied to the validated evidence —
`score(validatedEvidence, null)` — and the validator recomputes it and requires an
exact match with the stored value:

- `automated` (0–80) with `automatedMaximum: 80`, and per-area values with their
  maxima: `visible` ≤ 7, `functional` ≤ 30, `persistence` ≤ 10, `edge` ≤ 5,
  `integration` ≤ 15, `code` ≤ 5, `usefulTests` ≤ 5, `hygiene` ≤ 3.
- `humanUI: null` with `humanMaximum: 20` and `quality: null` with
  `qualityMaximum: 100` — the human and quality dimensions are **not produced
  here**; `status` is the constant `HUMAN_REVIEW_PENDING`. No human points are
  invented, and C5 reporting remains separate.

## Null and zero are different things

Absent or unobserved is `null`, never `0` and never a guess. Validation never
defaults a missing input to zero and never coerces `null`/`false`/`0` into each
other: every boolean must be present and actually boolean, every count a true
safe integer, and a schema-invalid or semantically inconsistent bundle is refused,
not repaired.

## Validation, and integrity errors versus tool/infrastructure errors

- `validateScorerEvidence(raw)` validates the raw S1 evidence before scoring:
  a complete evidence object; `visiblePassed` a safe integer 0–17; exactly 25
  hidden records with string `id`/`area` and real booleans; `usefulTests`
  `baselinePassed` boolean, `addedCount` non-negative, `killedMutations` a unique
  string array; the five hygiene booleans; `typecheck`, `build` and
  `noSuppression` booleans. It projects each hidden record to exactly
  `{ id, area, passed }` and the useful block to `{ baselinePassed, addedCount,
  killedMutations }`; it deliberately omits `analysisMethod` and any private
  diagnostic error text. It then calls the unchanged scorer's own validation —
  `score(evidence, null)` — and refuses the evidence if the scorer rejects it. A
  missing, duplicate, unknown property/area or mutation, wrong type, or
  scorer-rejected input throws `EvaluationIntegrityError` (`EVIDENCE_INTEGRITY`);
  nothing is defaulted.
- `validateEvidenceBundle(value)` applies the JSON schema first (unknown major
  version or `kind`, unknown keys, invalid primitives rejected), then the semantic
  checks: the stored `score` equals the unchanged scorer recomputed from the
  validated evidence (exact comparison, not approximation); `snapshot.before` =
  `snapshot.after` = the submission's `treeDigest`; both evaluator manifests
  recompute to their digests from their entries (duplicate or invalid paths are
  rejected); the original scoring hash is bound to the `evaluator/score.mjs` entry
  of the semantic manifest; artifact paths are unique. It returns a validated deep
  copy of the value and does not coerce anything.
- Every failure above is an `EvaluationIntegrityError` (`EVIDENCE_INTEGRITY`) —
  an evidence-integrity refusal, distinct from the tool/infrastructure codes the
  facade reports in its `error` diagnostic. An invalid or incomplete bundle never
  yields a partial bundle or partial points.

## The assembler: pure projection of a complete success only

`assembleEvidenceBundle({ result, identities, artifactDigests })` accepts only a
complete success result: `status: 'success'`, `cleanup.removed` true with empty
`errors` and `residue`, `snapshot.before === snapshot.after` non-null, and all six
stages successful in the established order. It validates the raw `result.evidence`
before calling the scorer and never defaults a missing input to zero. No
infrastructure or otherwise partial result can build a bundle: an ineligible input
is an `EvaluationIntegrityError`, not a degraded bundle. `identities` and
`artifactDigests` are supplied by the caller; the assembler is pure and does
nothing else.

## Reader: `readEvidenceBundle(text)`

`readEvidenceBundle(text)` takes JSON **text** (a string), `JSON.parse`s it and
runs `validateEvidenceBundle` on the parsed value. It is not a filesystem path:
the function does no file IO. The caller reads whatever file it holds, and the
caller writes its own local record — the module persists nothing, records stay
local, and no automatic file persistence happens at any point.

## What this surface does not do

- **No automatic persistence, network, export or CLI.** No file is written for
  you, no endpoint is contacted, no export/publish step exists, and there is no
  command name to build against — import the module from your own code.
- **No private material.** No personal or host-specific paths, no browser-cache
  discovery or override, no endpoints or environment configuration, and no
  governed authority is looked up or imported by this surface.
- **Cooperative limits, not an operating-system sandbox.** The declared security
  model remains `COOPERATIVE_WORKSPACE_NO_ADVERSARIAL_OS_CONTAINMENT`; the bundle
  adds no sandbox to that.
- **Bundle-only scope.** This bundle itself makes no UI, reporting, privacy-safe export or publication promise. The delivered C5 surfaces are documented separately in [Reporting](REPORTING.md), [Safe exports](EXPORTS.md) and [Complete results API flow](RESULTS_API.md). A local bundle remains private evidence, not a safe export or a certificate.
- **No S3 parity claim.** No recorded-result parity is claimed anywhere in this
  guide; parity against the recorded starter/reference/broken results is S3 work
  and deliberately out of scope here.

## Testing

```text
node --test tests/evaluation/bundle-documentation.test.mjs
```

That documentation check is static: it reads this guide, the schema, the validator
and identity sources and the facade declarations and asserts they agree. It never
executes an evaluation, starts a browser or a server. The functional behavior
suites for the bundle modules are separate sibling suites and are not run here.
