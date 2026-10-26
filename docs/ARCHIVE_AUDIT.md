# Synthetic archive: deterministic build and byte audit

[`../release/archive-build.mjs`](../release/archive-build.mjs) serializes an
externally staged synthetic tree (staged per
[`RELEASE_STAGING.md`](./RELEASE_STAGING.md) with an accepted synthetic
profile) into an uncompressed, constrained ustar archive of at most 64 MiB;
[`../release/archive-audit.mjs`](../release/archive-audit.mjs) then checks the
captured bytes. These are synthetic checkout tools, not release approval.

## Build

`buildSyntheticArchive({ directory, profile })` runs synchronously. The
`directory` must be an explicit local absolute path (a Windows drive letter is
required there) whose ancestor chain is ordinary directories, lexically and
physically disjoint from the live repository. The staged tree is re-read
against the accepted synthetic profile: a missing expected file, an
unexpected extra file or an empty directory is refused, not silently
included. Files are re-verified around each read.
Serialization is deterministic: regular-file headers only, fixed
mode/uid/gid/mtime, checksum and zero padding, exactly two trailing zero
blocks. Names support short names and the single `prefix/name` split;
longer stagings may be unrepresentable. The result object is frozen, but its
`bytes` are *mutable* (declared `Uint8Array`; a `Buffer` subtype is currently
returned) and its `audit` record is fixed evidence. The builder provides no
filesystem output, extraction or cleanup handle: it reads the staged tree and
never modifies it.

## Audit

`auditSyntheticArchive(archiveBytes, profile)` parses the actual serialized
bytes synchronously, independently of any builder inventory. The profile
validator runs first; its errors pass through unchanged;
`ArchiveIntegrityError` marks the archive layer, including a validator-accepted
profile that is not synthetic. A completed result means the captured bytes
matched the accepted synthetic profile exactly — paths, sizes, digests,
directory-case folding — and the limited content scans refused nothing. The
record's digests bind the captured bytes of that call: storing or
transporting unchanged bytes does not inherently alter them, but changing
them can invalidate an old record; re-audit the actual bytes you keep or
hand on before relying on it.

Two digest domains: `archiveSha256` is the SHA-256 of the exact captured
tar bytes; `inventorySha256` is the SHA-256 of the JSON of the sorted,
actual `path`/`bytes`/`sha256` entries — a separate entry-list domain,
not the archive serialization nor a whole-tree identity.

## Content policy and limits

The scans are a deliberately limited synthetic policy (`contentPolicy`:
`synthetic-utf8-markers-v1`): payload and paths must decode as UTF-8, fixed
private/canary markers, private-key or API/token-like and loopback/private
HTTP(S) patterns are refused, and generated metadata must be the fixed
canonical synthetic bytes. Invalid UTF-8 refuses; the fatal decode does not
detect or classify binary formats, whose byte sequences may also be valid
UTF-8. False positives are possible. This is not a universal secret
search, general binary support, an attacker-proof guarantee, or a legal or
exposure approval. Only generated metadata carrying the
`synthetic-metadata-v1` identifier and exact fixed bytes is accepted; other
generated identifiers are refused. The reserved `release-metadata.json` path (case-insensitive) must have the
same canonical bytes even if declared as a source entry rather than generated metadata.
Declared-hash agreement alone would not
detect poisoned fixed metadata or canary payloads; the audit checks content
directly. File checks are cooperative reads, not an atomic OS sandbox
against hostile concurrent processes or power loss, with no ADS/reparse-point qualification.

## Responsibility

Signatures, publication and real end-user distribution are out of scope. A
completed record describes integrity and the limited policy posture,
not authentication or approval.
