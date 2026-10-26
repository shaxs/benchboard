/** Declarations for the local deterministic builder at release/archive-build.mjs.
 *  It reads an exact externally staged tree, serializes an uncompressed
 *  constrained ustar archive and audits the final bytes independently. It
 *  writes no output file, extracts nothing, and runs no process, hook or
 *  network step. */

/** The audited record from archive-audit.mjs, bound to the captured bytes. */
import type { SyntheticArchiveAudit } from './archive-audit.mjs';

/** Synchronous build options: an explicit local absolute `directory` of an
 *  externally staged synthetic tree and an accepted `profile`. Ordinary JSON
 *  option inputs are assumed; arbitrary hostile JavaScript thrown from inputs
 *  is not guaranteed to be wrapped. */
export interface SyntheticArchiveBuildOptions {
  readonly directory: string;
  readonly profile: unknown;
}

/** Frozen top-level result: `bytes` is mutable (declared Uint8Array; the
 *  runtime currently returns a Buffer subtype) and `audit` is the deep-frozen
 *  record for the captured state. Changing the bytes invalidates that record;
 *  a copy stored or transported unchanged is not inherently altered, but
 *  re-audit the actual bytes you keep or hand on before relying on the old
 *  record, because the captured digest does not transfer to different bytes. */
export interface SyntheticArchiveBuildResult {
  readonly bytes: Uint8Array;
  readonly audit: SyntheticArchiveAudit;
}

/** Synchronously reads the exact staged tree described by the accepted
 *  synthetic profile and serializes it as a constrained deterministic ustar
 *  archive (regular-file headers only, fixed mode/uid/gid/mtime, exact two
 *  zero end blocks, at most 64 MiB; single-prefix or short names as
 *  representable). Unexpected extra files or empty directories in the tree are
 *  refused, not silently included. The caller owns no cleanup handle: the
 *  builder only reads. The profile validator runs first and its errors pass
 *  through unchanged; ordinary native errors inside the try body (the whole
 *  build, not only the tree walk) and archive-layer refusals are wrapped into
 *  `ArchiveIntegrityError` from archive-audit.mjs, with no added cause field;
 *  no failed call returns a result. No signature,
 *  publication or release claim is attached to a completed result. */
export declare function buildSyntheticArchive(
  options: SyntheticArchiveBuildOptions,
): SyntheticArchiveBuildResult;
