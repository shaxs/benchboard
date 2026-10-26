# Human UI procedures (owner-only)

The owner reference UI sanity review is PASS; see REFERENCE_UI_SANITY.md. No numerical reference score is assigned because the reference is not a participant. The script may be used for qualitative reference sanity review; its numerical scoring step applies only to benchmark participant submissions. Participant scoring uses HUMAN_UI_WORKSHEET.md and the unchanged 20-point rubric below. Score visible product quality, not preferred colors, pixel matching, library choices or decorative animation. Keep correctness results separate. A functional failure's visible UX impact belongs in one category only. Two independent raters are recommended; preserve both and discuss differences larger than one point. Review blind to model/configuration/session policy.

## Launch private reference in PowerShell

```powershell
Set-Location <repository root>\reference
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Open http://127.0.0.1:5173 in Chrome or Edge. Dependencies are already installed. If reinstalling later, use `npm ci` before review. This is private reference code; do not give this directory or its screenshots/source to benchmark participants. Stop with Ctrl+C. No hidden evaluator needs to run for UI review.

Open browser DevTools, choose responsive device mode, set width 1440 and height 1000, zoom 100%. In the Console run `localStorage.removeItem('benchboard'); location.reload()` once to establish the fixture baseline. Only clears this application's localhost-origin data. Keep the same browser/version, locale and timezone across repeated reviews; record them. Disable mobile touch emulation for desktop drag checks. No seeded-defect information is needed.

## Fixed 5-10 minute review script

1. **0:00-0:45, 1440 px:** inspect initial board, header, controls, cards and analytics. Capture board screenshot. Note clarity, density, typography and focus visibility.
2. **0:45-1:30:** physically drag one visible card into a different status column; observe placement/feedback and summary changes. Also use its keyboard movement control once. Note the issue ID you used.
3. **1:30-2:30:** open that issue, edit title/description, priority, assignee and labels. Commit text edits by leaving the field. Observe grouping, scrolling, focus and feedback. Capture drawer screenshot.
4. **2:30-3:15:** change status through the drawer, close it (also try Escape), and inspect board and analytics updates.
5. **3:15-4:15:** search a distinctive term from a visible title; then combine status, priority and assignee filters using values from a visible issue. Add a label filter. Observe understandable results and clear filters. Try a no-match search and clear it. Assess product clarity without reading evaluator assertions.
6. **4:15-5:15:** clear filters, reload and locate the edited/moved issue. Inspect saved edits, board position, analytics and activity history. Note readable order, timestamps and action descriptions.
7. **5:15-6:15:** create one issue, edit it, then delete it through confirmation. Inspect feedback and analytics; try keyboard tab navigation and drawer focus behavior.
8. **6:15-8:15:** repeat board/drawer/filtered views at 1024x1000 and 768x1000. Capture board and drawer at each width. Check clipping, page overflow, control access, content density and scrolling.
9. **8:15-10:00:** for a reference sanity review, record qualitative PASS/concerns without points; for a participant submission, enter seven scores with evidence notes, total 0-20, and record any blocker. Do not consult hidden test answers or reference implementation code to assign UI points.

## Rubric anchors

| Category | Cap | Poor | Acceptable | Excellent |
|---|---:|---|---|---|
| Overall polish | 5 | 0-1: unusable or rough default controls, inconsistent finish | 3: coherent competent product; occasional rough detail | 5: professional and consistently finished across all reviewed states |
| Information hierarchy | 3 | 0: confusing; project, board or actions hard to locate | 2: project/search/status/summary easy to locate | 3: clear hierarchy including filtering and empty states |
| Cards/board | 3 | 0: unreadable, ambiguous columns or essential cues missing | 2: readable priority/labels/assignee and clear columns | 3: balanced scan-friendly cards, clear ordering/movement feedback |
| Issue drawer | 3 | 0: unusable editing or inaccessible content | 2: readable grouping, activity and confirmation | 3: polished editing, sensible scrolling and predictable focus |
| Interaction feedback | 2 | 0: silent or confusing actions | 1: basic hover/focus/save/error responses | 2: clear predictable feedback including empty/error states |
| Responsive quality | 2 | 0: clipping/overflow or unusable at a required width | 1: usable at all widths with minor crowding | 2: clear board/drawer/controls at all three widths |
| Detail consistency | 2 | 0: inconsistent type, spacing or control states | 1: minor inconsistencies | 2: consistent typography, spacing, states and details |

Intermediate scores reflect the distance between anchors. Every score requires an evidence note. A score of zero is an observed result, never a pending placeholder. For machine ingestion, save a participant UI worksheet alongside that participant's private evaluation evidence with reviewer, reviewedAt (UTC ISO), evidence, current hashes from candidate-manifest.json, and integer scores keyed polish/hierarchy/board/drawer/feedback/responsive/consistency. Blank worksheet remains pending.

## Candidate.4 participant improvement evidence

Compare the submission against its exact exported starter at all three viewport sizes. Record the starter hash and baseline screenshots, set `baselineCompared: true`, and describe participant improvements in `improvements` for every category awarded positive points. Inherited presentation alone earns zero. Review the result with the same category caps; do not award points for preferred colors or resemblance to the owner reference. Historical reference sanity PASS applies to its recorded candidate.3 bytes; current reference sanity needs a new hash-bound human record before calibration.
