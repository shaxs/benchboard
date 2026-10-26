# How BenchBoard Scores a Run

This guide explains what the score means and where each number comes from. It
documents the **executable authority** — the unchanged scorer
`evaluator/score.mjs` — against the current checkout. It is checkout
documentation for the local scoring API, not an approved public release, and it
changes nothing about the challenge, the scorer or the recorded evidence.

Related guides: [Reports](REPORTING.md), [Human UI worksheet](HUMAN_UI.md),
[Publication](PUBLICATION.md), [Safe exports](EXPORTS.md),
[Compatibility](COMPATIBILITY.md), [Comparison](COMPARISON.md) and the current
crosswalk [Results API](RESULTS_API.md).

## The two parts of quality

Quality is two independent parts, and the top score is 100 **only** when a valid
human UI review, bound to that exact report, has been supplied.

| Part | Maximum | Supplied by |
|---|---:|---|
| Automated | 80 | `evaluator/score.mjs`, from machine evidence |
| Human UI | 20 | a completed local human review (see `HUMAN_UI.md`) |
| **Quality** | **100** | both parts, and only once the review is bound |

Until the human pass exists, the automated total is reported with
`humanUI: null` and `quality: null`, and the status reads
`HUMAN_REVIEW_PENDING`. "Pending" means only that the automated score is waiting
on the human UI pass; it asserts no eligibility, authority or certification claim.

## The automated categories (80 points)

The executable authority is `evaluator/score.mjs`. Its category maxima are:

| Category | Maximum |
|---|---:|
| `visible` — visible tests | 7 |
| `functional` — functional correctness | 30 |
| `persistence` — persistence | 10 |
| `edge` — edge cases | 5 |
| `integration` — integration | 15 |
| `code` — code quality | 5 |
| `usefulTests` — useful participant tests | 5 |
| `hygiene` — hygiene | 3 |
| **Total** | **80** |

Note on the PRD: the FR-08 table in the unified PRD lists edge cases at 10, so
its categories sum to 85. That table is **not** the authority and the table above
is not a typo — the executable scorer caps `edge` at 5 and the total at 80, and
the PRD table is recorded as erroneous. The scorer is never changed to match a
document.

## The human UI rubric (20 points, optional as a whole)

Supplying the human UI pass at all is optional. It is seven categories, all
human, and all seven are required within a pass: a completed, validated
worksheet must carry a bounded integer for every one of the seven, and zero is
a perfectly valid value for a category. An individual category cannot be left
out to make a pass complete.

| Category | Maximum |
|---|---:|
| `polish` — overall polish | 5 |
| `hierarchy` — information hierarchy | 3 |
| `board` — cards / board | 3 |
| `drawer` — issue drawer | 3 |
| `feedback` — feedback and states | 2 |
| `responsive` — responsive behaviour | 2 |
| `consistency` — consistency | 2 |
| **Total** | **20** |

A final score of 100 requires a valid review bound to the report it was made
against: review provenance, and an explicit comparison with the supplied starter
baseline. Positive UI points require participant improvement evidence for that
category. Without that binding, `humanUI` and the final quality stay null, never
an assumed number. No numerical UI grade for the reference solution is invented
here or anywhere else.

Where tests use a full UI score of 20, that value is a **synthetic protocol
fixture** used to exercise the plumbing. It is not a human judgment and must not
be read as one.

## Precision, and what is never invented

The scorer computes each category from its own evidence and reports the
automated total as `Number(total.toFixed(4))`. Individual categories are **not**
re-rounded and may keep their full fractional precision (for example a
fraction of 17 visible tests), so the sum of the printed categories can differ
from the total in digits beyond the fourth place while still agreeing with it
after rounding. A reviewed final score is computed from the component sum on the
same rule. None of this changes the scorer; the arithmetic above is exactly what
`evaluator/score.mjs` does.

Unknown is always `null`, never `0`:

- An absent human pass is `humanUI: null` and `quality: null`, not zero.
- Missing or inapplicable evidence scores no points but is never reported as a
  measured zero result — for example absent useful-test evidence yields 0 points
  with the recorded evidence left `null`.
- When evaluation cannot produce a score at all — a modeled infrastructure
  failure such as a cleanup failure, a tool timeout, a cancelled run, a missing
  prerequisite, a tool crash, output beyond the limit or invalid tool output —
  every quality field is null rather than a 0 that would read like a real
  result.
- A thrown safety or integrity refusal is a different case and produces no
  quality and no report to read at all, so there is nothing to null out: a
  snapshot that fails frozen verification or changes while it is staged raises a
  typed snapshot refusal, and frozen bytes that change during evaluation raise a
  typed refusal. These are not returned scores; no partial bundle or partial
  quality is ever returned from them, and no check or guard is bypassed to get
  one.
- A normally failed quality check contributes no points for that check. Other
  passing checks in the same category and checks elsewhere retain the points
  they earned. A category is not automatically zero because one of its checks
  failed; successful evaluation keeps the points it earned elsewhere. This does
  not grant any partial bundle or partial quality on infrastructure failure or
  refusal, and no check or guard is bypassed.

Quality is also independent of consumption: token use, harness, model identity
and the time ceiling change no category. A final efficiency figure is therefore
not available until both the human pass and the final quality are known.

## What this scoring is — and is not

This is a **manual, local self-assessment** of your own submission: not
certification, not formal or controlled evaluation, and not an attestation about
who ran it. It describes no reference-solution details, screenshots or private
logs, and exports no raw recorded evidence.

Recorded replay coverage lives with the read-only replay suites, for example
`tests/evaluation/recorded-score.test.mjs` and
`tests/results/recorded-score-replay.test.mjs`, which replay the recorded
starter, reference and broken reports through the unchanged scorer without
writing to `artifacts/`. Citing those paths is fine; publishing the raw recorded
evidence, private run history or previous solutions is not.
