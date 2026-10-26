/** Declarations for the metadata validator at release/profiles.mjs. The module reads
 *  its adjacent participant inventory once at load; a filesystem or JSON failure there
 *  surfaces as an ordinary error. */

/** One of the five generator identifiers the module recognizes. Each identifier is
 *  bound to a single fixed output path: synthetic-metadata-v1 to release-metadata.json,
 *  tooling-package-v1 to package.json, tooling-lock-v1 to package-lock.json,
 *  installed-assets-v1 to cli/installed-assets.json, adapter-package-v1 to
 *  adapters/dsh/package.json. Recognition binds a name and a path; this module carries
 *  no generator or rendering code. */
export type GeneratorId =
  | 'synthetic-metadata-v1'
  | 'tooling-package-v1'
  | 'tooling-lock-v1'
  | 'installed-assets-v1'
  | 'adapter-package-v1';

/** Release entry whose bytes are declared as coming from a relative source path.
 *  `bytes` is a non-negative safe integer (zero allowed) and `sha256` is 64 lowercase
 *  hexadecimal characters; both are declarations until a later staging step verifies
 *  actual bytes. The optional never marker distinguishes source from generated
 *  origins; runtime validation remains authoritative for key absence. */
export interface SourceProfileEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly source: string;
  readonly generated?: never;
}

/** Release entry whose bytes are declared as produced by one recognized generator.
 *  The `source?: never` marker keeps this arm exclusive under structural typing. */
export interface GeneratedProfileEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly generated: GeneratorId;
  readonly source?: never;
}

/** A profile entry: path, size and digest plus exactly one of `source` or `generated`. */
export type ProfileEntry = SourceProfileEntry | GeneratedProfileEntry;

/** Accepted participant release contract: the deep-frozen result shape, entries sorted
 *  by output path in UTF-16 code-unit order, each entry frozen, no null values. The
 *  exact-identity check means every entry carries a `source` path. */
export interface ParticipantReleaseProfile {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'ReleaseProfile';
  readonly profile: 'participant';
  readonly authorization: 'participant-only';
  readonly entries: readonly SourceProfileEntry[];
}

/** Accepted synthetic release contract, same frozen shape and ordering. */
export interface SyntheticReleaseProfile {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'ReleaseProfile';
  readonly profile: 'synthetic';
  readonly authorization: 'synthetic-only';
  readonly entries: readonly ProfileEntry[];
}

/** Fixed inventory of profile names to authorization states. Listing a state grants
 *  no staging or private publication. */
export declare const RELEASE_PROFILE_STATES: {
  readonly participant: 'participant-only';
  readonly 'owner-development': 'private-only';
  readonly 'end-user-tooling': 'blocked';
  readonly synthetic: 'synthetic-only';
};

/** Thrown when a profile, entry, path or identity check fails. `code` is a stable
 *  string such as `RELEASE_PROFILE_BLOCKED` or `RELEASE_PARTICIPANT_MISMATCH`. */
export declare class ReleaseProfileError extends Error {
  readonly name: 'ReleaseProfileError';
  readonly code: string;
  constructor(code: string, message: string);
}

/** Validates declared metadata. Returns a detached, deep-frozen contract for an
 *  accepted participant or synthetic profile; unknown profiles, blocked profiles,
 *  forged authorization and failed shape, path or identity checks throw
 *  `ReleaseProfileError`. The call reads no caller file and writes no output. */
export declare function validateReleaseProfile(
  input: unknown,
): ParticipantReleaseProfile | SyntheticReleaseProfile;

/** Returns the participant contract with the exact 26 files of the participant
 *  inventory: their paths, sizes and digests, each with source `starter/<path>` and
 *  no generated replacement. */
export declare function createParticipantProfile(): ParticipantReleaseProfile;
