# Release staging: precise synthetic trees and conservative limits

[`../release/staging.mjs`](../release/staging.mjs) takes an accepted synthetic
profile from [`RELEASE_PROFILES.md`](./RELEASE_PROFILES.md) and materializes its
declared entries as a fresh, exclusive output tree. Each selected source is read,
hashed and compared against the profile before any target path is created; tree
creation, copying and final verification follow. Checkout documentation, not a
public release claim.

## Acknowledged operation

`stageRelease` runs synchronously with three inputs: explicit absolute local
`sourceRoot` and `destination`, and the `profile` object itself. The roots must
not be filesystem roots, UNC or extended-namespace forms (Windows requires a drive letter), must be disjoint from
each other and from the live repository (ancestor, descendant or equality). The
source root must exist and the destination must be absent, with the destination's
parent present. At call time the profile is validated first, before staging
touches the filesystem; the validator module's own fixed adjacent-inventory read
happens at module load, separate from this call.

## Output and handle

Only the synthetic profile is accepted at this boundary. The participant profile
reaches staging and is refused there
(`RELEASE_STAGE_PROFILE_BLOCKED`); `owner-development` and `end-user-tooling`
are refused earlier, inside the validator call, with a propagated
`ReleaseProfileError` (`RELEASE_PROFILE_BLOCKED`) — the two refusal layers
differ exactly. Recognized generator names other than `synthetic-metadata-v1`
are refused as unavailable
(`RELEASE_STAGE_GENERATOR_UNAVAILABLE`); there is no invented renderer registry.
`synthetic-metadata-v1` renders to `release-metadata.json` as fixed UTF-8 bytes
(`{"schemaVersion":"1.0.0","kind":"SyntheticReleaseMetadata","publicRelease":false}`
followed by one LF), and its declared bytes and digest must match.
The handle is a deeply immutable object: `schemaVersion` (`'1.0.0'`), `kind`
(`'StagedRelease'`), `profile` (`'synthetic'`), the absolute private
`directory`, the accepted `entries`, and a `cleanup` closure. `cleanup` uses
the private identity and byte receipts the operation recorded and accepts no
caller receipt, path or options; it is idempotent after a successful run and
verifies before removing. Removal
covers only the owned tree; foreign additions, replacements or changed bytes
cause a refusal that keeps partial residue in place.

## Errors and limits

`ReleaseStageError` extends `Error` with `code:string`, `cause` (inherited) and
`retained:boolean`. Codes `RELEASE_STAGE_ROOT`, `RELEASE_STAGE_OVERLAP`,
`RELEASE_STAGE_EXISTS`, `RELEASE_STAGE_INTEGRITY`, `RELEASE_STAGE_FAILED` and
`RELEASE_STAGE_RETAINED` mark distinct refusals. A native failure inside
copying becomes `RELEASE_STAGE_FAILED` with the original cause.
If an operation also fails guarded cleanup, `RELEASE_STAGE_FAILED` preserves the original
`cause` and adds a private `cleanupError` with the retention reason. An unreceipted created
root is retained rather than incorrectly reported as cleaned.
`retained` reports proof status, not a guessed cleanup outcome; a mid-cleanup
native failure can leave partial owned residue, so `retained` does not promise
the original stage is wholly intact. The errors and handle are private
diagnostics, not sanitized exports. Neither type declares extra API: no
cancellation, hooks, promises, callbacks or overwrite; no install, archive,
network or publication; and no grant of end-user or participant staging. Ordinary JSON option inputs are assumed; arbitrary
hostile JavaScript errors are not guaranteed to be wrapped. The identity checks
are cooperative: they are not an atomic OS sandbox against hostile concurrent
processes or power loss.
These ordinary-file checks do not inventory NTFS alternate data streams or distinguish every
reparse-point type; they must not be treated as proof of ownership of those hidden namespaces.
