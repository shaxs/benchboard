# Storage: registry retry contract

This guide documents the approved public behavior of the C1 storage transactions at the
direct storage seam — [`../packages/core/storage.mjs`](../packages/core/storage.mjs) — for one
narrow change: the transient Windows rename retry behind registry persistence, together with
the guarded cleanup and error behavior that accompanies it. It is checkout documentation, not
an approved public release. It describes behavior, not a design decision. The existing public
method signatures of `createStorage`, `createImmutable`, `replaceMutable`, `read` and `withLock`
and the options their callers pass are unchanged, and the retry adds no public retry options,
metrics or nullable results. What this change does add — the retry's ownership/stage validation,
cleanup receipts and the error cause/residue field — is described below.

## Retry policy — exact scope

Registry persistence replaces the registry file with an atomic rename of a staging file
(`registry.staging-*.tmp` → `registry.json`) inside `<root>/.storage/`. The retry policy applies
only:

- on **win32**;
- on the error codes **EPERM, EACCES, EBUSY**;
- to that single registry rename.

Other platforms, other error codes and other operations — the record-target rename, `unlink`,
reads and lock acquisition — do not inherit this policy. There is no lock stealing, no
environment toggle, no download or server involvement and no caller-facing bypass path. The
registry rename is internal, so callers do not invoke it directly; it runs while the existing
root-wide lock and the same-instance transaction gate remain held.

The schedule is at most eight attempts, separated by seven fixed delays — 20, 40, 80, 160,
320, 500 and 500 ms — a total of 1620 ms of scheduled delay. Filesystem execution and
validation add time beyond that: the schedule bounds waiting, not filesystem wall time, and
there is no operating-system wall-clock deadline promise.

## Errors and causes

A direct registry persistence failure still surfaces as `StorageError` with the
`ERR_STORAGE_REGISTRY_UNAVAILABLE` code, and the failing `.cause` carries the underlying error.
When all eight rename attempts fail transiently, `.cause` is the first rename error. Other
non-transient rename errors propagate without retry through the same existing storage wrapper.

If the pre-retry ownership or path validation fails, the storage failure's cause may instead be
an ownership or namespace refusal, which retains the first rename error deeper in its own cause
chain. The storage layer does not establish that every `StorageError` has a `.cause` or the
same code: lifecycle/CLI callers keep their own error conversion, and this guide covers only
the direct storage seam. JSON serialization failure remains its separate existing
`ERR_STORAGE_REGISTRY_CORRUPT` code.

A transient error's external handle owner stays unknown; the storage layer does not attribute
it to a watcher, an antivirus program or another specific service.

## Ownership, cleanup and residue

Every check here is cooperative — not an atomic operating-system snapshot and not a
hostile-process sandbox — and no power-loss durability claim is made.

- **Before each retry**, ordinary ancestor identity, the original lock identity/bytes, the
  destination registry identity/bytes or its original absence, and the same singly linked
  stage identity/bytes are revalidated. The stage path and bytes are not regenerated between
  retries; changed, linked, foreign or unprovable state refuses.
- **Failure cleanup** removes a created registry stage only when its namespace, identity and
  bytes remain proven; an uncertain stage remains in place. Lock release likewise revalidates
  the original lock file identity/bytes before removing it.
- **`details.registryStageRetained`** is `true` only when a created registry stage could not be
  safely removed. It is a conservative residue disclosure — not proof that a valid final record
  was or was not published, and not a cleanup instruction.

## Phase-specific outcomes

What a registry failure leaves behind depends on where the operation stopped:

- **Before reservation publication:** a registry failure at this point means no final record
  was published by that operation.
- **After immutable target publication:** a later failure may retain the published record plus
  its pending reservation. The existing explicit identical-byte recovery remains required; a
  registry failure is not universal no-write evidence.
