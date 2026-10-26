# BenchBoard

BenchBoard is a local-first benchmark harness for AI coding agents, with a focus on local LLMs. A
coding agent receives an existing React/TypeScript issue-board application (with seeded defects) as
the fixed challenge and works on a disposable exported copy of it; the result is evaluated locally
with an executable automated scorer worth up to 80 points, plus an optional human UI review worth up
to 20 more points.

BenchBoard is released under the [MIT License](LICENSE). Its calibration is still pending (status
`CALIBRATION_PENDING`): scores are meant for comparing agents, models and harnesses on your own
machine, not as a calibrated public leaderboard or a certification.

## Install

Node 22 or newer. Clone into an ordinary folder (not inside your system temp folder, which the
evaluator keeps separate from the repository), then install the three dependency trees and
Chromium:

```
git clone https://github.com/shaxs/benchboard.git
cd benchboard
npm ci
cd starter && npm ci && cd ..
cd reference && npm ci && cd ..
npx playwright install chromium
npm test
```

Then follow [docs/RUN.md](docs/RUN.md) to run an agent.

## Start here

- [docs/RUN.md](docs/RUN.md) — run an agent (OpenCode, Claude Code or any CLI) end to end with one
  command, then score its UI on a local page
- [docs/QUICKSTART.md](docs/QUICKSTART.md) — a first walkthrough with generic placeholders
- [docs/MANUAL_WORKFLOW.md](docs/MANUAL_WORKFLOW.md) — the manual lifecycle end to end
- [docs/CLI.md](docs/CLI.md) — commands, `--long-flag` usage, exit codes and error categories
  (usage/state/integrity/infrastructure/cancellation)

## What lives where

A run is a **container**: it holds a participant workspace and private run metadata, and `--run`
names that container, not the workspace. The initial participant workload is the verified 26-file
starter export. Protected challenge material (`spec/`, `starter/`, `fixtures/`, `reference/`,
`runner/`, `evaluator/`) remains read-only in this owner checkout. Evaluation consumes the saved,
verified participant workspace bytes with the owner-side evaluator; it does not copy those private
owner folders into the participant workspace. Participant work happens in the exported workspace
under an existing ordinary parent outside this repository.

## Privacy boundary

Every stdout summary — including init, status, evaluation, export and cleanup summaries — is local
private material, and so are raw worksheets, reports and storage envelopes, reviewer identities,
logs and arbitrary configuration. The sharing boundary is the separately written privacy-safe
projection files plus the fixed safe export marker. Unknown or pending values stay null; an
automated 0 remains a real number, distinct from unavailable null.

## Scoring, reports and exports

- [docs/SCORING.md](docs/SCORING.md)
- [docs/EVALUATION.md](docs/EVALUATION.md)
- [docs/REPORTING.md](docs/REPORTING.md)
- [docs/RESULTS_API.md](docs/RESULTS_API.md)
- [docs/EXPORTS.md](docs/EXPORTS.md)
