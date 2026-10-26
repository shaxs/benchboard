/** Declarations for the auditor at release/archive-audit.mjs. It inspects actual
 *  serialized archive bytes against an accepted synthetic profile, independently
 *  of the builder's staged inventory, and never extracts or writes files. */

/** Thrown for a failed archive-layer check: format, inventory, digest or the
 *  limited content policy, and for ordinary native filesystem failures the
 *  builder wraps inside its try body. Errors raised by the profile validator
 *  pass through unchanged and are not this class. The message is fixed and
 *  does not echo input; no cause or data object is attached. */
export declare class ArchiveIntegrityError extends Error {
  readonly name: 'ArchiveIntegrityError';
  readonly code: 'RELEASE_ARCHIVE_REFUSED';
  constructor();
}

/** One audited regular-file entry, frozen, with its relative path, its size in
 *  bytes and the SHA-256 digest of the actual payload bytes. */
export interface SyntheticArchiveAuditEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Deep-frozen audit record for a completed audit: `schemaVersion` ('1.0.0'),
 *  `kind` ('SyntheticArchiveAudit'), `status` ('complete'), `publicRelease`
 *  (false), `archiveSha256` (SHA-256 of the exact captured tar bytes),
 *  `inventorySha256` (SHA-256 of the JSON of the sorted frozen entries — a
 *  separate entry-list digest domain, not the archive serialization), the
 *  frozen sorted `entries`, and `contentPolicy`
 *  ('synthetic-utf8-markers-v1'). No nullable fields. The digests bind only
 *  the captured bytes of that call; they do not transfer to a later mutated
 *  copy. */
export interface SyntheticArchiveAudit {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'SyntheticArchiveAudit';
  readonly status: 'complete';
  readonly publicRelease: false;
  readonly archiveSha256: string;
  readonly inventorySha256: string;
  readonly entries: readonly SyntheticArchiveAuditEntry[];
  readonly contentPolicy: 'synthetic-utf8-markers-v1';
}

/** Synchronous audit of captured archive bytes against an accepted synthetic
 *  profile. The auditor reads no caller files: it parses the bytes it was
 *  given. A completed result means the captured bytes matched the accepted
 *  synthetic profile exactly and passed the limited content scans; it does
 *  not claim release approval or secrecy, and it binds the captured bytes
 *  only. The profile validator runs first: its errors pass through unchanged,
 *  while the archive layer's refusals (including a validator-accepted profile
 *  that is not synthetic) throw `ArchiveIntegrityError`; no failed call
 *  returns a record. */
export declare function auditSyntheticArchive(
  archiveBytes: Uint8Array,
  profile: unknown,
): SyntheticArchiveAudit;
