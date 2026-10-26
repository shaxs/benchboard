/** Inventory declarations for the metadata module at release/notices.mjs. The module reads
 *  no caller file, writes no output, installs nothing and publishes nothing. Importing the
 *  module also loads the fixed adjacent C0 inventory through release/profiles.mjs, with its
 *  documented native and ordinary load errors. This listing is an inventory, not a license
 *  grant, an approval or a permission to redistribute. */

/** The two lock scopes a caller may declare. */
export type NoticeScope = 'owner' | 'participant';

/** One caller-supplied lock record: a scope and the lock object it declares, validated at
 *  runtime as a version-3 lock. The caller loads and selects this JSON; the module reads no
 *  file to obtain it. */
export interface LockDeclaration {
  readonly scope: NoticeScope;
  readonly lockfile: unknown;
}

/** An asset projected from the selected release-profile declaration. `bytes` and `sha256` are
 *  the profile's declared values, not a re-verification of source bytes. Ownership, license and
 *  compatibility are unknown, so they are null. */
export interface NoticeAsset {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly ownership: null;
  readonly license: null;
  readonly compatibility: null;
  readonly evidence: 'release-profile-declaration';
}

/** The provenance of a dependency's `license` field. */
export type NoticeLicenseSource = 'lockfile-declaration' | 'unavailable';

/** A dependency projected from a supplied lock. `version` and `license` are null when the value
 *  is absent or outside the accepted forms. `licenseSource` records where the license came from.
 *  Ownership and compatibility are unknown, so they are null. */
export interface NoticeDependency {
  readonly scope: NoticeScope;
  readonly location: string;
  readonly name: string;
  readonly version: string | null;
  readonly license: string | null;
  readonly licenseSource: NoticeLicenseSource;
  readonly ownership: null;
  readonly compatibility: null;
}

/** A coverage record naming one supplied lock scope. */
export interface NoticeCoverage {
  readonly scope: NoticeScope;
  readonly evidence: 'lockfile-v3-declaration';
}

/** The project-level license state: no license selected and not approved, regardless of any
 *  lock declaration. */
export interface NoticeProjectLicense {
  readonly selected: null;
  readonly approved: false;
}

/** A detached, deep-frozen notice inventory: every nested record and array is frozen. */
export interface NoticeInventory {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'NoticeInventory';
  readonly profile: 'participant' | 'synthetic';
  readonly projectLicense: NoticeProjectLicense;
  readonly releaseApproved: false;
  readonly assets: readonly NoticeAsset[];
  readonly dependencies: readonly NoticeDependency[];
  readonly dependencyCoverage: readonly NoticeCoverage[];
}

/** Thrown when the `locks` argument is not one or two distinct owner/participant scopes whose
 *  lockfiles carry version-3 packages objects, or when a lock structure, path or scope is
 *  invalid, which refuses the whole call. The message is fixed and echoes no input. */
export declare class NoticeInventoryError extends Error {
  readonly name: 'NoticeInventoryError';
  readonly code: 'RELEASE_NOTICES_INVALID';
  constructor();
}

/** Builds a notice inventory from a profile and caller-selected lock records. It first
 *  validates the profile through release/profiles.mjs, so a `ReleaseProfileError` from that
 *  step passes through unchanged; a `NoticeInventoryError` arises only from the lock checks.
 *  Malformed JavaScript or accessor errors in the supplied data are not isolated: the caller is
 *  expected to supply plain JSON. The call reads no caller file and writes no output. */
export declare function buildNoticeInventory(
  profile: unknown,
  locks: readonly LockDeclaration[],
): NoticeInventory;
