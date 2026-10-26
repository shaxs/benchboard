# BenchBoard v1 scoring (owner-only)

Execution time is never part of the 100-point quality score and no points are awarded for a larger or smaller declared execution ceiling. Quality is nevertheless conditional on the declared ceiling, because additional available time can permit more engineering work to complete, so every reported quality result carries its declared ceiling and observed wall time beside it and cross-ceiling quality figures are descriptive only.

Automated score 80; human UI 20. Automated score is rounded once to four decimals. Quality remains null until a human worksheet exists. No model/session/worker-count/speed bonuses.

| Area | Maximum | Deterministic rule |
|---|---:|---|
| Visible tests | 7 | 7 × immutable passing contracts / 17 |
| Hidden functional | 30 | 30 × passing F01–F13 / 13 |
| Persistence/migration | 10 | 10 × passing P01–P04 / 4 |
| Edge cases | 5 | 5 × passing E01–E04 / 4 |
| Integration | 15 | 15 × passing I01–I04 / 4 |
| Code quality | 5 | canonical typecheck 2, canonical build 2, no TypeScript escape/suppression in product source 1 |
| Added useful tests | 5 | passing added-test baseline required; one point per distinct killed fault, capped 5 |
| Hygiene | 3 | 0.6 each: original visible tests unchanged; package and lock unchanged; no recognizable secrets; no debug logging; no product network calls |

The hidden areas are disjoint; a behavioral defect may have consequences in multiple genuinely different product workflows, documented in property names. No scoring by component/file architecture, source similarity, dependency count, UI screenshot similarity or time. Runtime inputs come from the owner browser and canonical tooling, never a participant-provided score. Missing build/test evidence fails that criterion. Unknown/duplicate properties and incomplete hidden evidence are rejected.

Useful-test evaluation runs only added `.test`/`.spec` JavaScript/TypeScript files; ordinary helpers do not count as tests. All added tests must pass normally. Five independent boundary faults cover persistence (dropped writes), interaction (dropped input/change events), accessibility (lost focus), normalization (lost lowercasing), and chronology (reversed parsed dates). Each earns one point only when the same added tests fail under that fault. Test-count/configuration failures earn no credit. This measures test insight across fault domains without prescribing source architecture. Owner reference baseline and all five kills are measured, not assumed.

Hygiene uses TypeScript syntax nodes and actual comment directives. `any` in every type position and `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error` directives fail the suppression proxy. Examples in comments/string copy, SVG namespace URLs and commented debug calls do not fail executable-call checks. Actual console log/debug, fetch/XHR/WebSocket calls and remote executable imports/resource sources do. This remains a bounded proxy, not a comprehensive security or maintainability audit.

Human review uses spec/UI_REVIEW.md. No automatic visual score or assumed 18–20. Reference acceptance uses automated checks and owner qualitative sanity PASS, with no participant UI points assigned to the reference. A pending human score must never be graphed as zero or full credit.

Dependency additions can be useful, but no network installs during a run. Baseline lock changes lose 0.6 hygiene points; supported owner-prepared offline additions need the same reproducible toolchain across architectures. The current canonical evaluator uses baseline dependencies; no hidden requirement needs an addition.

Participant UI points require comparison with the exact supplied starter, `baselineCompared: true`, and concrete `improvements` evidence for every positive category. Inherited starter presentation alone earns zero improvement points. Review the completed product through the unchanged 20-point categories; award improvements up to each cap. No numerical reference UI score is assigned.
