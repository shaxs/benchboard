# Release profiles: declared metadata, validation and limits

[`../release/profiles.mjs`](../release/profiles.mjs) validates declared release-profile
metadata — names, sizes, digests, path shape and authorization. The participant profile
is additionally bound to [`../release/inventory.json`](../release/inventory.json), whose
26 file entries are its exact set. The structural shape is additionally
described by [`../schemas/release-profile.schema.json`](../schemas/release-profile.schema.json).
Schema validity alone proves neither path safety nor authorization.
This is checkout documentation, not a public release claim.

## Profiles and authorization

A profile declares five top-level fields: `schemaVersion` (`'1.0.0'`), `kind`
(`'ReleaseProfile'`), `profile`, `authorization` and `entries`. Each profile name is
bound to one authorization state: `participant`/`participant-only`,
`owner-development`/`private-only`, `end-user-tooling`/`blocked` and
`synthetic`/`synthetic-only`. A caller cannot change these decisions: a profile
declaring an authorization that does not match its name is rejected
(`RELEASE_PROFILE_BLOCKED`), and the `owner-development` and `end-user-tooling` profiles
are refused at runtime even when their declared state matches. Owner development stays
non-public, and real end-user archives are blocked on unresolved evaluator/utility
exposure and the project license. The exported state map is an inventory; it does not
grant staging or private publication.

## Entries and generated metadata

Each entry carries `path`, `bytes` (a nonnegative safe integer; zero is allowed),
`sha256` (64 lowercase hex characters), and exactly one of `source` (a relative source
path) or `generated` (one of five recognized generator identifiers). A generator
identifier is bound to one fixed output path:

| Generator id | Required output path |
| --- | --- |
| `synthetic-metadata-v1` | `release-metadata.json` |
| `tooling-package-v1` | `package.json` |
| `tooling-lock-v1` | `package-lock.json` |
| `installed-assets-v1` | `cli/installed-assets.json` |
| `adapter-package-v1` | `adapters/dsh/package.json` |

Recognition binds a name to a path; this module carries no generator or rendering code.
`createParticipantProfile()` returns the participant contract built from the 26
inventory files: their paths, sizes and digests, each with `source` `starter/<path>`
and no generated replacement.

## Validation results and errors

`validateReleaseProfile(input: unknown)` returns a detached, deep-frozen contract for
an accepted `participant` or `synthetic` profile: the entries array and each entry are
frozen, entries are sorted by output path in UTF-16 code-unit order, and results carry
no nulls. A failed check raises `ReleaseProfileError` with a stable `code`:
`RELEASE_PROFILE_INVALID` (object shape, kind or version), `RELEASE_PROFILE_UNKNOWN`
(unknown name), `RELEASE_PROFILE_BLOCKED` (forged or refused authorization),
`RELEASE_ENTRY_INVALID` (array/entry fields, size/hash, origin exclusivity or generator),
`RELEASE_PATH_INVALID` (output or source path), `RELEASE_PATH_COLLISION` (duplicate,
case or prefix collision) and `RELEASE_PARTICIPANT_MISMATCH` (a participant profile
that is not the exact 26 files). Module load reads the adjacent inventory once; a
filesystem or JSON failure there surfaces as a native error, and an unsupported
inventory throws an ordinary `Error`.

## Limits

This API validates metadata only. It reads no caller source files, expands no glob,
computes no caller-file hash, stages, builds, archives or publishes nothing, and
installs nothing. Size and hash fields are declarations until a later staging step
verifies actual bytes, so synthetic metadata is not a proof of safe source-root
placement, content privacy, installation, license or exposure approval, or archive
audit. Accepted paths are conservative ASCII POSIX-relative: traversal, absolute, drive,
UNC, backslash, alternate-data-stream and glob forms, empty, dot or trailing-dot
segments, reserved Windows device names, private or recorded areas and `.env`
components are rejected. A `runner/` path is rejected except the exact
`runner/files.mjs`, usable here only as synthetic metadata; no real evaluator or
utility exposure approval is granted. Case-collision checks are strict on every
platform. This module supplies no staging function.

Evaluator and fixture paths may appear in synthetic metadata. Actual source-root and content
checks belong to later staging/audit boundaries; this metadata grants no exposure approval.
