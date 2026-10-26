# Notice inventory: declared assets and lock-declared dependencies

[`../release/notices.mjs`](../release/notices.mjs) builds a notice inventory from a release
profile and caller-supplied lock records. Its types are declared in
[`../release/notices.d.mts`](../release/notices.d.mts). This page describes an inventory of
declared metadata; it is not a license grant, an approval, or permission to redistribute. The
profile, path, and authorization rules behind the profile step are in
[RELEASE_PROFILES.md](RELEASE_PROFILES.md).

## What the two arguments are

The first argument is a profile object validated by the release-profile step; if it fails that
check, the `ReleaseProfileError` from that step passes through unchanged. A `NoticeInventoryError`
(code `RELEASE_NOTICES_INVALID`, fixed non-echoing message) arises from the lock checks instead.
The second argument is one or two distinct records, each with a scope of `owner` or `participant`
and a lockfile the caller loads and selects itself — the module reads no caller file. The module
writes no output, and installs, stages, archives, and publishes nothing.
Package locations must use lowercase portable npm names beneath `node_modules/`, including
nested/scoped names; an unsupported workspace or uppercase key refuses the entire call.

## Selected assets and declared dependencies

`assets` come from the selected profile's declared entries: their path, declared size and digest,
with evidence `release-profile-declaration`. These values are declarations, not a re-verification of
source bytes or hashes. `dependencies` cover every non-root package record found in the supplied
locks, including dev and optional entries; this records the lock content, not the resolved runtime
dependency closure or any installed state. Nested package locations are preserved so duplicate
versions remain visible, and output is sorted by scope and then by exact location. Lock root
metadata, resolved URLs, scripts, and integrity fields are not projected.

## Nulls, provenance, and the license vocabulary

Unknown values stay null rather than being guessed. A dependency records `version` only when it
matches three numeric parts plus an optional prerelease or build suffix, and `license` only when it
equals a value from the limited vocabulary: MIT, MIT-0, ISC, Apache-2.0, BSD-2-Clause,
BSD-3-Clause, CC-BY-4.0, (MIT OR Apache-2.0). A recognised value carries provenance
`lockfile-declaration`; a missing or unrecognised value is null with provenance `unavailable`.
This is a fixed vocabulary check, not full SPDX validation, and no notice-text, compatibility, or
legal review is performed. Asset ownership/license/compatibility and dependency ownership/
compatibility remain null. The structural schema alone does not enforce the runtime license/
provenance pairing, location grammar or unique coverage scopes.

## Project license and distribution state

`projectLicense` reports no license selected and approval false regardless of what the locks
declare, and `releaseApproved` is false, so end-user distribution remains blocked. No installed
state and no redistribution right is claimed anywhere in this inventory.
