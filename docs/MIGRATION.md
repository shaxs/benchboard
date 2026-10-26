# Migration contract — workload bytes, source bytes, release boundaries

Rules for moving BenchBoard workload bytes, source bytes and their lineage between locations, versions and installations. A contract, not a status report: it authorizes no write, install, benchmark run or publication. Where a value is needed it names the command that produces it, because a frozen value in prose goes stale.

## 1. Fixed by the product, not by a migration

Workload bytes, visible and hidden evaluation semantics, reference behaviour and scoring authority are immutable under migration. Moving bytes never re-decides a challenge or scoring question; a disagreement stops the migration and is reported rather than resolved locally. One codebase is maintained: public and internal paths share one core, and a migration must not fork it into a community or owner-only variant. Challenge identity and tooling version are separate recorded facts.

## 2. Raw bytes, digests, and three distinct identities

Digests cover raw file bytes (`sha256(rawBytes)`); a tree digest covers the sorted `[path, fileDigest]` pairs in POSIX-relative form. The project's own hashing module *is* the definition; a re-implementation is not evidence. Every reported digest names the directory skip set that produced it — the skip set is part of a digest's meaning, so comparing digests of different domains is an error.

Three identities stay distinct and are never merged into one value: **tooling** (harness and runner code), **challenge** (participant workload bytes), **evaluator** (evaluation and scoring assets). Lineage is the recorded chain of which bytes a reviewed release consisted of and where each came from. Installed/build material is counted per root (file count, byte total, digest of that count list) rather than digested per file: inventory, never identity. It is rebuilt at the destination from the carried manifest and lockfile.

## 3. The participant distribution is an explicit file allowlist

Deny-by-default: only enumerated paths ship. The machine-readable authority with per-file digests and byte counts is [`../release/inventory.json`](<../release/inventory.json>). Its 26 entries, in that order, relative to the participant workspace root:

```text
.dockerignore  PRODUCT_PRD.md  README.md  index.html  package-lock.json  package.json
src/App.tsx  src/activity.ts  src/analytics.ts  src/components/Analytics.tsx
src/components/Board.tsx  src/components/Filters.tsx  src/components/IssueDrawer.tsx
src/filters.ts  src/fixtures.json  src/labels.ts  src/legacy.json  src/main.tsx
src/model.ts  src/persistence.ts  src/style.css  src/types.ts
tests/contracts.test.tsx  tests/setup.ts  tsconfig.json  vite.config.ts
```

A path absent from that inventory does not ship even when it exists in the development tree; an unclassified path is a reported open item, not a judgement call at copy time.

## 4. Tooling profiles are three different things

- **Participant**: the allowlist above and nothing else — no development tree, no evaluation assets, no history.
- **Owner development**: the complete working tree; an internal installation, not a distribution form, and never public by default or by passage of time.
- **End-user tooling**: blocked today, because exposing evaluation assets and selecting a license are undecided product decisions. Blocked is recorded as blocked, never quietly downgraded to "ship anyway".

## 5. What must never cross a boundary

Absolute paths of a personal machine or user directory; private planning areas and internal policy files; operational records of a reviewed release and independent review output; the hidden evaluator, reference implementation, seeded-defect key or scoring internals in any derived form; prior participant submissions; secrets, tokens and session state; installed/build material as a substitute for a lockfile-driven install; scratch residue at the repository root.

## 6. History is lineage input, never default payload

Commit history, tags and review-adjacent refs exist to prove lineage; they are not part of any default distribution. A future clean release of allowlisted source paths still would not authorize publishing anything by itself.

## 7. Dependencies

Dependencies are identified and prepared separately through an approved mode — a lockfile-driven install or an explicitly prepared dependency set. This contract imposes no blanket prohibition on carrying prepared dependencies and approves no mode by itself.

## 8. Decisions that are not the migrating agent's

Release approval, publication, exposure of evaluation or reference material, license selection, and any change to a preserved surface. Such an agent may prepare the analysis and must stop for the decision; self-attestation by the actor that performed a migration is not acceptance.

## 9. Out of scope

No command-line interface, tooling feature or later-milestone capability is specified, promised or implied here.
