/** Typed public surface of packages/results/comparison.mjs: the descriptive comparison over the caller's raw private inputs, each read on its own into the safe S6 compatibility summary the result carries: `compareResults` takes the raw inputs themselves, not pre-wrapped safe exports, while `validateComparison` and the renderers consume the already-built comparison. The surface is the closed result shape, its fixed disposition, reason and disclosure vocabularies, its request shape, its validator and its own refusal class. Everything here is descriptive: every comparison carries the fixed notices and `formalComparisonAvailable: false`, so no value of any of these types asserts formal comparison, certification, ranking, release or authority. Validation is structural and intrinsic policy, never authentication of authorship; nothing here verifies a filesystem artifact or marker, reads or writes a file, uploads, publishes or performs any IO. */
import type { CompatibilityExport } from './compatibility-export-contract.mjs';

/** The fixed ordered notice list every comparison carries, verbatim from the Captain's `COMPARISON_NOTICES`: descriptive only, a local self-assessment and not certified, manual controls unenforced, not formally controlled, no formal comparison, and pseudonyms that are not anonymity. No other notice is representable and the order is part of the shape. */
export type ComparisonNotices = readonly [
  'DESCRIPTIVE_ONLY',
  'LOCAL_SELF_ASSESSMENT_NOT_CERTIFIED',
  'MANUAL_UNENFORCED',
  'NOT_FORMALLY_CONTROLLED',
  'NO_FORMAL_COMPARISON',
  'PSEUDONYMS_NOT_ANONYMOUS'
];

/** The closed per-input disposition vocabulary. `BASELINE` marks the selected baseline itself (never compared against itself), `REFUSED` an input the reader would not accept, `BLOCKED` an accepted input the policy will not place next to this baseline, `AUTOMATED_ONLY` a comparison of automated quality with a human review still pending, and `REVIEWED` a comparison whose automated, human-UI and quality figures are all available. No other disposition is representable. */
export type ComparisonDisposition = 'BASELINE' | 'REFUSED' | 'BLOCKED' | 'AUTOMATED_ONLY' | 'REVIEWED';

/** The closed reason codes the fixed policy emits, and no others. They explain a refusal, a baseline problem, a blocked pairing, an automated-only state or a matched current-quality comparison; they are policy facts about the pairing, never an infrastructure, identity or trust verdict about the work itself. */
export type ComparisonReason =
  | 'INPUT_REFUSED'
  | 'BASELINE_NO_SELF_DELTA'
  | 'BASELINE_UNAVAILABLE'
  | 'BASELINE_NOT_CURRENT_REPORT'
  | 'INPUT_NOT_CURRENT_REPORT'
  | 'BASELINE_INFRASTRUCTURE'
  | 'INPUT_INFRASTRUCTURE'
  | 'SEMANTIC_PROVENANCE_UNAVAILABLE'
  | 'SEMANTIC_IDENTITY_DIFFERS'
  | 'CHALLENGE_IDENTITY_DIFFERS'
  | 'WORKLOAD_DIFFERS'
  | 'AUTOMATED_ONLY_PENDING_REVIEW'
  | 'MATCHED_CURRENT_QUALITY';

/** The closed disclosure codes the fixed policy emits, and no others. Every comparison starts from the two standing disclosures `MANUAL_UNENFORCED` and `NOT_FORMALLY_CONTROLLED`; the rest report a differing or unavailable evaluator package, tooling or binding, ceiling, declared configuration, timing provenance or review state. A disclosure never blocks a comparison and never states which side is better; an unavailable value is disclosed, never inferred. */
export type ComparisonDisclosure =
  | 'MANUAL_UNENFORCED'
  | 'NOT_FORMALLY_CONTROLLED'
  | 'TRUST_DIFFERS'
  | 'EVALUATOR_PACKAGE_DIFFERS'
  | 'TOOLING_DIFFERS'
  | 'EVALUATOR_BINDING_DIFFERS'
  | 'CEILING_UNAVAILABLE'
  | 'CEILING_DIFFERS'
  | 'DECLARATION_UNAVAILABLE'
  | 'DECLARATION_DIFFERS'
  | 'TIMING_UNAVAILABLE'
  | 'TIMING_PROVENANCE_DIFFERS'
  | 'REVIEW_UNAVAILABLE'
  | 'REVIEW_AVAILABILITY_DIFFERS'
  | 'REVIEWER_DIFFERS'
  | 'REVIEW_TIME_DIFFERS';

/** The three quality differences, each candidate minus baseline at four-decimal precision, or null wherever no paired numeric quality exists: every non-`AUTOMATED_ONLY`/`REVIEWED` item, `humanUI` and `quality` on an automated-only item, and any side whose quality is absent. Null is the only representation of "not available" — an unknown difference is never zero. There is no efficiency, timing or ranking field in this shape at all. */
export interface ComparisonDeltas {
  readonly automated: number | null;
  readonly humanUI: number | null;
  readonly quality: number | null;
}

/** One retained input and its outcome. `index` is its position in the request and equals its array position, so duplicates and refused members are still present; `summary` is the input's own already-safe `CompatibilityExport`, or null when the reader refused it, in which case the reason is the fixed `INPUT_REFUSED` and the wrapper's text is never copied. `reasons` and `disclosures` are the closed-code lists the fixed policy produced for this pairing, and `deltas` are null everywhere no paired numeric quality exists. */
export interface ComparisonItem {
  readonly index: number;
  readonly disposition: ComparisonDisposition;
  readonly reasons: readonly ComparisonReason[];
  readonly disclosures: readonly ComparisonDisclosure[];
  readonly summary: CompatibilityExport | null;
  readonly deltas: ComparisonDeltas;
}

/** A built descriptive comparison. The shape is closed: bounded literals, fixed notices, integer index fields (`index` and `baselineIndex` — the integer mention is about the indexes only, not every nested value, since the quality deltas are fractional numbers), the closed code vocabularies, the safe summaries and null. `baselineIndex` is the caller's selected baseline, `formalComparisonAvailable` is always the literal false, and there is no free-text field, no raw source payload and no open index signature anywhere in the shape — an unknown value is null, never zero and never a note. */
export interface DescriptiveComparison {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'DescriptiveComparison';
  readonly baselineIndex: number;
  readonly formalComparisonAvailable: false;
  readonly notices: ComparisonNotices;
  readonly items: readonly ComparisonItem[];
}

/** The comparison request: the caller's own stored records, kept as `unknown` because each member is read and classified independently, and the required `baselineIndex` naming which member is the baseline. A request has no name, no path, no free-text field and no extra property; ordering is positional and the count is bounded. */
export interface ComparisonRequest {
  readonly inputs: readonly unknown[];
  readonly baselineIndex: number;
}

/** Raised for this layer's own refusals — a malformed or extra-bearing request, and a value that does not match the closed comparison shape, its fixed notices, its closed vocabularies, its policy or its arithmetic. It carries no refused value, no reader or nested error text and no private content, and it makes no claim about why a lower layer refused; only its `code` identifies the refusal. */
export declare class ComparisonError extends Error {
  readonly code: 'COMPARISON_INVALID';
  constructor();
}

/** Builds one descriptive comparison from `request.inputs` — 2 to 32 records or JSON texts from the caller's own private storage — against the member named by `request.baselineIndex`. Every requested member is retained at its own index, duplicates included, and each is read independently: a member the reader refuses becomes a `REFUSED` item carrying the fixed `INPUT_REFUSED` reason and a null summary rather than throwing, so one bad member never loses the others; no member is dropped and no success is inferred. A baseline member that is refused stays itself `REFUSED` with the fixed `INPUT_REFUSED` reason (not `BASELINE`); every other valid candidate then becomes `BLOCKED` with `BASELINE_UNAVAILABLE`, while another malformed or refused candidate stays its own `REFUSED`. A baseline that is accepted is `BASELINE` with no self-delta even when it is an older family or an infrastructure side. A malformed or extra-bearing request is refused with `ComparisonError`. Numeric deltas are computed only for `AUTOMATED_ONLY` and `REVIEWED` items — candidate minus baseline at four-decimal precision — and every other delta is null, never zero. This performs no IO, verifies no artifact, marker or authorship, states no efficiency or timing difference, ranks, certifies or releases nothing, and always yields `formalComparisonAvailable: false`. */
export declare function compareResults(request: ComparisonRequest): DescriptiveComparison;

/** Checks a value that already claims to be a comparison: the closed shape and exact key sets, the bounded literals, the fixed notices in order, the integer indexes and bounded length, each nested summary re-validated as a safe compatibility export, then the fixed policy's disposition, reasons and disclosures for every pairing and the arithmetic of every delta. A mismatch is a `ComparisonError` carrying no detail; the value is returned as a defensive copy and never mutated. This is structural and intrinsic policy and arithmetic only — never authentication of authorship, never verification of a filesystem artifact or marker, and not a publication or certification check. Because each summary is re-validated through the S6 layer, a nested `CompatibilityExportError` (`COMPATIBILITY_EXPORT_INTEGRITY`) or `ExportIntegrityError` (`EXPORT_INTEGRITY`) may propagate in its own class; there is no universal error class here. */
export declare function validateComparison(value: unknown): DescriptiveComparison;
