# Candidate.4 workload distribution (owner-only)

Measured starter/reference implementation witness: 10 changed product files, 651 added lines and 85 removed lines. CSS accounts for 484 added/38 removed; product TypeScript/TSX accounts for 167 added/47 removed. Counts include formatting and do not establish a minimum valid solution size or elapsed duration.

| Product surface | Added | Removed |
|---|---:|---:|
| src/App.tsx | 12 | 1 |
| src/activity.ts | 2 | 4 |
| src/components/Analytics.tsx | 38 | 7 |
| src/components/Board.tsx | 27 | 4 |
| src/components/IssueDrawer.tsx | 7 | 3 |
| src/filters.ts | 1 | 7 |
| src/labels.ts | 1 | 1 |
| src/model.ts | 13 | 18 |
| src/persistence.ts | 66 | 2 |
| src/style.css | 484 | 38 |

Independent substantial work exists in persistence validation/migration, analytics rendering, board drag/keyboard movement and drawer field editing, alongside app wiring, filters, normalization, chronology, integration and visual polish. Model integration has 13 added/18 removed lines rather than concentrating all seven seeded faults. Public source files are ordinary architecture choices, never scored by similarity to this reference.

See artifacts/workload/distribution.json for file hashes and exact diff counts, and score-floors.json for executed visible/hidden outcomes. Reproduce owner measurements with evaluator/workload-evidence.mjs followed by evaluator/no-added-tests-witness.mjs using fresh disposable owner fixture directories. Full self-validation checks the untouched/reference outcomes independently. Candidate.4 exports exactly 26 allowlisted public files.

The 30-60 minute target remains an empirical question. Peak parallelism, per-file edit contention and team decomposition must be observed during future authorized calibration; no actual model/team run is recorded.
