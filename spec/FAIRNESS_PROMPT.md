# Independent benchmark fairness review prompt ? OWNER-ONLY

You are a fresh independent SOTA reviewer evaluating THE BENCHMARK, not solving BenchBoard. This owner-only packet authorizes you to inspect private benchmark material solely for fairness/validity review. Do not copy any material into participant run workspaces. Do not modify the benchmark, run real DSH calibration, create teams, change models/servers/policies/configuration, freeze, push or publish. Review the exact packet hash tuple; do not rely on earlier conversations or stale variants.

First read manifest.json and verification.json. Require expected inputs present, no accidental participant-run outputs, no stale variants, no duplicate physical inputs, and matching per-file/content/packet hashes. If incomplete or inconsistent, STOP with CHANGES_REQUESTED / BENCHBOARD_MAY_CALIBRATE:false. Read MAP.md to locate all required materials. The original specification is retained verbatim; current owner TRUST_MODEL.md and CALIBRATION.md supersede prior adversarial containment assumptions. This is cooperative DSH engineering throughput, not host security.

Inspect source and actual self-validation evidence, not summaries alone. Assess starter/reference distance, fixture/PRD ambiguity, visible-vs-hidden coverage, scoring, native deadline/reset tooling, telemetry normalization and version/freeze rules. Owner reference UI sanity is PASS (REFERENCE_UI_SANITY.md), with no numerical score because the reference is not a participant. Participant UI scoring remains unchanged. Independent fairness and empirical calibration remain pending; automated 80/80 is not total quality 100. Duration/discrimination targets remain unmeasured. Do not invent human UI scores or empirical results. You may run owner-only tests if the review environment supports prepared dependencies; packet excludes bulky installed dependencies and contains locks/instructions.

Answer each of these questions with PASS/CONCERN/UNVERIFIED, rationale and precise file/line or evidence citation:

1. Does BenchBoard measure realistic software-engineering ability rather than merely React familiarity?
2. Is the workload parallelizable for 2?4 workers while retaining meaningful sequential dependencies?
3. Are hidden tests primarily behavioral rather than coupled to the reference implementation?
4. Does any hidden test unfairly require a component/file architecture?
5. Are the seven seeded defects reasonable engineering defects rather than arbitrary traps?
6. Does the visible suite reveal too much of the hidden evaluator?
7. Is the starter too close to the reference solution?
8. Is scoring balanced?
9. Is UI weighted appropriately relative to engineering correctness?
10. Is the five-point participant-added-test score reasonably resistant to gaming?
11. Are hygiene deductions and suppression rules fair?
12. Is localStorage migration weighted appropriately?
13. Are accessibility/control expectations clearly specified before scoring?
14. Is drag/drop evaluation sufficiently implementation-neutral?
15. Are fixture data and requirements unambiguous?
16. Can a participant score highly while producing a poor product?
17. Can a good implementation satisfy requirements and still be incorrectly rejected by the evaluator?
18. Does the benchmark favor a worker count, decomposition, persistent or fresh sessions, local or cloud models, or Captain strategy?
19. Are telemetry and GPU-hour calculations neutral across local/cloud/hybrid configurations?
20. Is task granularity handled carefully so tokens/task and tasks/GPU-hour are not misleading?
21. Is the 30?60 minute target plausible for this workload?
22. Is the per-run declared execution ceiling mechanism sound, immutable after start, and neutral between compared architectures?
23. Are weak/reasonable/strong/excellent bands calibration targets rather than encoded assumptions?
24. Are versioning/freezing sufficient to preserve comparability?
25. Are there Critical/High/Medium fairness or validity defects that should block empirical calibration?

Explicitly disposition each already identified concern, without assuming it is a defect:

- native HTML drag protocol versus pointer-only implementations;
- source regex hygiene/suppression rules and false positives;
- five-point diverse fault mutation component and its bounded usefulness proxy;
- public accessible-control contracts versus equivalent accessible implementations;
- local reserved GPU-hour denominator, idle reservations, cloud cost and hybrid fairness;
- hidden test implementation coupling;
- participant-added-test scoring and possible gaming.

For each concern: ACCEPTABLE / CHANGE_REQUIRED / NEEDS_EMPIRICAL_EVIDENCE, supporting evidence, severity if applicable, and concrete remedy or calibration observation. Propose alternative-solution counterexamples for possible false rejects and high-scoring poor products. Distinguish measured facts from inference. Do not prescribe one decomposition, worker count or session policy.

Return CRITICAL, HIGH, MEDIUM and LOW finding sections (write None if empty). Each finding needs ID, severity, evidence, consequence, remedy and resolved=false for any new unresolved issue. Critical/High/Medium benchmark-validity findings block calibration. A Low issue can be non-blocking only with explicit justification. Supply all 25 question dispositions and seven special-item dispositions.

Return exactly one final verdict: PASS or CHANGES_REQUESTED.
Return BENCHBOARD_MAY_CALIBRATE: true or false.
PASS/true requires no unresolved Critical/High/Medium validity findings; explicitly justify any non-blocking Low. Include independent reviewer/model identity, UTC reviewedAt, packet digest and candidate hashes. Machine result structure:

```json
{"reviewer":"IDENTITY","reviewedAt":"UTC ISO","packetDigest":"SHA256","hashes":"COPY manifest.candidate EXACT OBJECT","findings":{"CRITICAL":[],"HIGH":[],"MEDIUM":[],"LOW":[]},"verdict":"PASS or CHANGES_REQUESTED","BENCHBOARD_MAY_CALIBRATE":false}
```

This is a schema illustration, not a completed review. Save actual owner result to artifacts/fairness-review.json outside participant workspaces. No review has been launched by preparation.
