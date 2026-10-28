# Running an agent with one command

`run` takes a coding agent from an empty folder to a scored result on the machine where this
repository is checked out. It copies the starter code into the folder, installs its dependencies,
launches your agent with a fixed prompt, times it, stops it at the time limit, scores the result
(up to 80 automated points) and captures the twelve UI screenshots for the optional 20-point
human review. `review` then lets you score the UI on a local page.

## Before the first run

- Node 22 or newer, and this repository's own dependencies: run `npm ci` in the repository root,
  in `starter/` and in `reference/`, then `npx playwright install chromium`.
- The agent's own CLI, installed and able to reach your model. BenchBoard never installs or
  configures a harness. Supported profiles:
  - `opencode`: OpenCode 1.x or 2.x. `--model` is required, as `provider/model` (OpenCode 2 also
    takes `provider/model#variant`).
  - `claude`: Claude Code. `--model` is optional.
  - `command`: any other CLI. Pass the whole command line with `--agent-command`. The prompt is
    in the `BENCHBOARD_PROMPT` environment variable and in the file named by
    `BENCHBOARD_PROMPT_FILE`. No token counts are recorded for this profile.

## Run

```
node cli/benchboard.mjs run --agent opencode --model <provider/model>
```

Without `--dir` the run goes in a new folder `~/benchboard-runs/<UTC time>-<model>/`. To choose
the folder, create an empty one outside this repository and pass it:

```
node cli/benchboard.mjs run --agent claude --dir <EMPTY_FOLDER>
```

Useful options:

| Option | Meaning |
|---|---|
| `--minutes N` | Time limit, default 75. At the limit the agent's whole process tree is stopped and what it produced is scored. |
| `--agent-bin PATH` | Use this harness executable instead of the one on PATH (for example a wrapper-free binary). |
| `--ai-judge MODEL` | Also ask a vision-capable model, through the same harness, for an advisory UI score. |
| `--npm PATH` | npm used for the workspace dependency install, if it is not next to node. |

Progress lines go to standard error. The last line on standard output is a JSON summary with
the score, minutes and tokens.

## What the folder holds afterwards

| Path | Contents |
|---|---|
| `summary.json` | Score and its eight areas, wall minutes, tokens, time-limit flag, screenshot list, AI and human UI scores once present. |
| `review.sh` / `review.cmd` | Opens the UI review for this run (see below). |
| `agent/` | The prompt, the agent's raw output and logs, the OpenCode `session-export.json`, and `tokens.json` when the harness reported totals. |
| `run/workspace/` | The agent's finished code. |
| `run/`, `run.benchboard-results/` | BenchBoard's private run records and evaluation logs. |
| `screens/` | The twelve screenshots and their `evidence.json`. |
| `export/` | The shareable report (`report.json`, `report.txt`). |

A folder is used once. `run` refuses a folder that is not empty and never overwrites anything.

## Scoring the UI yourself

Every finished run folder has a launcher for this: `review.sh` (Linux, macOS) or `review.cmd`
(Windows). It is the same as:

```
node cli/benchboard.mjs review --dir <RUN_FOLDER>
```

This builds the starter and the submission (about a minute) and opens a page with every starter
and submission screenshot side by side, links to both apps running live so you can click through
them, and a short form for the seven UI categories. Positive points need a sentence about what
improved over the starter, plus a choice of which screenshot pair shows it. Saving attaches the
review to the report, adds a reviewed export folder and updates `summary.json` with the human UI
score and the final quality out of 100.

The page only listens on this machine by default. When the run is on another machine, either:

- listen on the network: `./review.sh --host 0.0.0.0 --port 8080 --no-open`, then open the
  printed address from your own computer (the port must be allowed through its firewall); or
- keep it private and forward the port: `./review.sh --port 8080 --no-open` on the server,
  `ssh -L 8080:127.0.0.1:8080 <server>` on your computer, then open the printed address.

Either way, the printed address includes a private token; without it the page refuses requests.
Run the launcher as the user that made the run, so it can read the run folder.

To get only the advisory AI score for an existing run:

```
node cli/benchboard.mjs review --dir <RUN_FOLDER> --ai-judge <model> --agent opencode
```

The AI score is stored as advisory in `summary.json` and is never counted as the human review.

## Tokens and time

- Time is measured from the agent's launch to its exit, and recorded through the normal
  `start`/`stop` lifecycle, so the report's elapsed time and points-per-second use it.
- OpenCode tokens come from `opencode session export` after the run. If the export is not
  available, `summary.json` keeps an approximate stream total, which can miss the final step, and
  the report's token fields stay empty rather than holding a guess.
- Claude Code tokens come from the final `result` event, summed across every model it used.
- Input tokens include cache reads and cache writes. Output tokens include reasoning.

## Limits

- The agent runs as your user on this machine. It is told to stay in its folder and not to use the
  web, but nothing enforces that. For isolation, run it in a VM or container.
- If the harness reports that it worked in a different folder (for example, a wrapper script that
  forces its own directory), `run` stops before scoring and says so.
- On Windows, keep the run folder path short (the command refuses one that is too long for
  Windows build tools).
