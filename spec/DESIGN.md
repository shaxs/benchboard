# BenchBoard design reconciliation (owner-only)

BenchBoard measures local-agent engineering quality, elapsed time, token/context efficiency, reliability, decomposition, useful parallelism and quality-adjusted GPU throughput. The React product is a fixed engineering workload, not the subject of the benchmark.

## Architecture and trust boundary

- spec/BENCHMARK.md: exact authoritative specification, PRIVATE (contains defect list).
- spec/DESIGN.md, SCORING.md, UI_REVIEW.md, CALIBRATION.md: PRIVATE owner procedures.
- starter/: PUBLIC allowlisted runnable React/TypeScript/Vite/CSS/localStorage/Vitest project. No owner instructions, defect markers or reference branches.
- starter/PRODUCT_PRD.md: PUBLIC product behavior and storage/interaction contracts only; no decomposition or answer keys.
- starter/src/fixtures.json and legacy.json: PUBLIC ordinary data, not evaluator expectations.
- fixtures/: PRIVATE canonical source copies; public dataset copies only enter starter.
- evaluator/: PRIVATE browser properties, scoring, controller and validation records.
- reference/: PRIVATE complete implementation; evaluated through the same product boundary as submissions.
- runner/: PRIVATE hashing, provision/reset, cooperative native time-limit supervisor, telemetry ingestion and reports.
- artifacts/: PRIVATE run manifests, submissions, scores, screenshots, self-validation evidence. Never copied into runs.

Generated runs live outside this repository. Exact allowlisting, recursive symlink rejection, manifests, byte hashes and private-material scans preserve the public/private export boundary. BenchBoard v1 assumes cooperative participants within their assigned DSH project/workspace; it makes no adversarial OS containment claim. Docker and runtime containment are not readiness gates. See TRUST_MODEL.md for the superseding owner decision. Hidden assertions execute only in the owner controller after participant capabilities stop, against the product server; hidden/reference/scoring/evidence are never exported to participants. Normal host project tools are permitted under this trust model.

## Product architecture and schema

Starter uses a typed store, persistence helpers, filtering/analytics selectors, board, editable drawer, activity and CSS. This architecture is an initial scaffold, not an evaluator requirement. Browser-accessible product labels and storage formats are public contracts. All interactions are accessible by names/roles; no hidden test imports implementation modules.

v1 localStorage key benchboard, value {version:1,issues:Issue[],activity:Event[]}. Issue: id, title, description, status (backlog/in-progress/done), priority (Critical/High/Medium/Low), assignee (one of four names or empty), labels:string[], order:nonnegative integer. Event: id, issueId, timestamp:ISO UTC, message. v0 same key with version:0 and tasks instead of issues. IDs and valid data survive migration. Canonical fixture has 18 realistic fixed-ID issues in 8/6/4 status distribution, fixed timestamps and unique priorities/labels. Malformed storage falls back safely; empty arrays remain empty. Unknown fields may be ignored. Normalize labels by trim/lowercase/deduplication. No network services.

## Seeded defects (PRIVATE)

Seven independent mutations in starter: persistence retains pre-drag order; deletion retains cached analytics; selectors union active filters; drawer status edits retain source column order rather than append; label normalization is case-sensitive; priority edits append the same activity twice; activity sorts human-formatted dates. No defect comments, switches or enumeration enter public source. Owner mutation probes map each defect to a behavior assertion, independent of source paths. Missing creation/migration/keyboard interaction and incomplete polish form additional legitimate workload; product PRD describes outcomes only.

## Visible and hidden coverage

17 visible Vitest UI contracts, candidate.4 baseline 10 pass/7 fail: fixture/rendering/basic edits/search/single filters/persistence and basic unfinished requirements. Visible tests omit adversarial combinations and date/order edge cases. Owner copies of visible tests are immutable for evaluation, regardless of participant edits.

Approximately 25 browser properties cover reload after drag, within/cross-column ordering, drawer movement, delete analytics, AND filters, search/filter composition, normalized labels, deduplication, raw date chronology, migration/IDs/idempotence, malformed recovery, empty board and zero completion, filtered editing/deletion, activity reload, no-op actions, keyboard interaction, viewport overflow and console cleanliness. Product contracts define append-on-status-change and drop-before-card ordering to avoid an undisclosed convention. Tests use UI/storage only, not reference component names. Dependencies/test controller remain private and outside participant workspaces.

## Reference, scoring and human review

Private reference independently satisfies the public outcomes, with public visible tests plus useful added regressions. Same hidden behavior suite, typecheck, build and browser diagnostics must pass. Source is never exported. Owner reference UI sanity PASS is the reference acceptance gate; no numerical reference UI score is assigned because it is not a participant. See REFERENCE_UI_SANITY.md. Participant UI scoring retains its 20-point rubric.

Automated caps: visible 7, functional 30, persistence 10, edges 5, integration 15, code 5, useful participant tests 5, hygiene 3 = 80. Each property has explicit area/weight with no accidental duplicate weighting; code/hygiene/useful tests use transparent owner evidence rules, not dependency count or component architecture preferences. Added tests require passing independent evaluation plus regression usefulness (mutation evidence), not test-count rewards. Code/hygiene use bounded objective proxies (canonical typecheck/build and explicit source/tooling checks), not a claim of comprehensive maintainability or security. Calibration review examines these limitations. Missing evidence earns no points; score cannot exceed caps. Human UI 20 uses anchored per-category worksheet at 1440/1024/768, screenshots and consistent task script; two blinded raters resolve disagreement. Pending UI score stays null, never zero/assumed full credit.

## Runs, telemetry, freezing and calibration

Provision from a verified SHA-256 manifest, fresh destination, no copied git history or outputs. Reset requires a manifest-owned path and exact matching run ID; validates resolved containment and rejects links. Dependency preparation happens once; locked installed dependencies copied as ordinary files (no links back to owner). Public hashes must match on repeat provision/reset. Native supervisor requests process-tree termination at the run's declared per-run ceiling, preserves observed timing/termination failures and records COMPLETED, TIME_LIMIT, TIME_LIMIT_OVERRUN, STOP_FAILURE or INFRASTRUCTURE_FAILURE. External DSH workers require the normal orchestration stop mechanism. DSH supplies completion signal without app dependency.

Versioned external JSON telemetry schema: run identity/version/architecture/times/status, Captain model/token/cache/output/steps/compactions/tools, workers/tasks/attempts/model/session/generation/dispatch/times/artifact/test milestones/tokens/cache/decode/TTFT/steps/compactions/reliability/context, dependencies, availability/busy/blocked/idle intervals, GPU reservations, cloud use and interventions. Null means unavailable, never zero. Validate identity, timestamps, nonnegative values, duplicate attempts, dependency cycles and interval accounting. Compute union-based parallelism/utilization, retries, task completions, token/minute/task, quality/token and quality/task/hidden per local reserved GPU-hour. Keep cloud costs/tokens separately visible; local GPU denominators never imply cloud is free. Preserve raw imported records and provenance. No DSH source/config/runtime modifications.

Freeze manifest separately hashes benchmark/version, spec, starter, PRD, fixtures, visible tests, evaluator, scoring and reference. Candidate status until human-reviewed calibration: SOTA ceiling, competent two-worker 30-60 minutes, deliberately weak discrimination, repeat A/B, randomized order/fresh storage/hardware controls. Target 50-65/70-85/85-95/95+. Only owner-approved calibration can freeze v1.0; meaningful change then requires new version. No actual DSH runs in this session.

## Ambiguities and fairness decisions

The design header is frozen; executable v1.0 is not frozen until calibration. Public PRD resolves drop-before/append conventions and label case/whitespace, unassigned workload, analytics over all issues (not filtered), per-field committed action vs keystrokes, empty completion=0, migration source key and malformed data recovery. These are product contract clarifications, not altered measurement objectives. Duration is an empirical target, not provable from code; this package cannot claim calibrated duration. Human UI and useful-test judgment cannot honestly be fully automated; evidence and pending status are explicit. GPU-hour means reserved local device-hours including idle, not model decode time. GPU counts/model topology/session policies are configuration metadata, never scoring factors. Tasks differ by Captain decomposition, so task-rate metrics are descriptive and quality/GPU-hour is primary. No speed points, fixed component architecture, required added dependencies, exact screenshot, prescribed task graph or preferred session policy.

## Final implementation notes

Public board, drawer, filter and analytics components are separate files so ordinary feature work can proceed in parallel; the public PRD prescribes no work allocation. Exact 26-file public allowlist plus byte manifests enforce exports. Prepared participant dependencies are ordinary public tooling; post-submission tooling and hidden browser/controller remain owner-only. Browser tests use documented names and storage behavior, not component imports. Native drag checks use physical pointer gestures against documented card IDs. An equivalent presentation witness changes markup, metadata placement, percentage formatting, analytics visibility, focus order and feedback copy and passes all hidden properties. Useful-test probes span five independent fault domains; review this bounded proxy during calibration. Captain token aggregates must exclude usage already attributed to task attempts to prevent duplicate counting.

## Candidate.4 engineering surfaces

The starter now leaves persistence validation/migration/reload retention, analytics rendering, board pointer/keyboard movement, drawer description/label/assignee editing, app wiring and presentation work unfinished. Filtering, label normalization and activity chronology live in separate modules; model integration retains event/order/state defects. Separate files permit independent engineering work but do not prove useful parallelism or elapsed duration. Workload evidence measures an implementation witness and score variants; empirical calibration remains required. Public semantic hooks are documented in PRODUCT_PRD.md; HTML tags, exact feedback copy, focus order and button-contained metadata are not reference requirements.
