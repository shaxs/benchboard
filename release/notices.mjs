/** Inventory declarations only: no legal approval, installation, or publication. */
import { validateReleaseProfile } from './profiles.mjs';

const knownLicenses = new Set(['MIT', 'MIT-0', 'ISC', 'Apache-2.0', 'BSD-2-Clause',
  'BSD-3-Clause', 'CC-BY-4.0', '(MIT OR Apache-2.0)']);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/;
const version = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;

export class NoticeInventoryError extends Error {
  constructor() {
    super('Expected explicit version-3 lock declarations with distinct owner/participant scopes');
    this.name = 'NoticeInventoryError';
    this.code = 'RELEASE_NOTICES_INVALID';
  }
}

function frozen(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** The two arguments are metadata, not installed-dependency or source-byte evidence. */
export function buildNoticeInventory(profile, locks) {
  const selected = validateReleaseProfile(profile);
  if (!Array.isArray(locks) || locks.length === 0 || locks.length > 2) throw new NoticeInventoryError();
  const seen = new Set();
  const dependencies = [];
  for (const record of locks) {
    if (!record || !['owner', 'participant'].includes(record.scope) || seen.has(record.scope) ||
        !record.lockfile || record.lockfile.lockfileVersion !== 3 ||
        !record.lockfile.packages || typeof record.lockfile.packages !== 'object' ||
        Array.isArray(record.lockfile.packages)) throw new NoticeInventoryError();
    seen.add(record.scope);
    for (const [key, item] of Object.entries(record.lockfile.packages)) {
      if (key === '') continue;
      // A lock may contain nested copies; preserve the explicit package location as provenance.
      const segments = key.split('/node_modules/');
      if (!key.startsWith('node_modules/') || segments.some((segment, index) => {
        const name = index === 0 ? segment.slice('node_modules/'.length) : segment;
        return !packageName.test(name) || name.split('/').some((part) => part === '.' || part === '..');
      }) || !item || typeof item !== 'object' || Array.isArray(item)) throw new NoticeInventoryError();
      const name = segments.length === 1 ? key.slice('node_modules/'.length) : segments.at(-1);
      dependencies.push({
        scope: record.scope, location: key, name,
        version: typeof item.version === 'string' && version.test(item.version) ? item.version : null,
        license: knownLicenses.has(item.license) ? item.license : null,
        licenseSource: knownLicenses.has(item.license) ? 'lockfile-declaration' : 'unavailable',
        ownership: null, compatibility: null,
      });
    }
  }
  dependencies.sort((a, b) => compare(a.scope, b.scope) || compare(a.location, b.location));
  return frozen({
    schemaVersion: '1.0.0', kind: 'NoticeInventory', profile: selected.profile,
    projectLicense: { selected: null, approved: false }, releaseApproved: false,
    assets: selected.entries.map(({ path, bytes, sha256 }) => ({
      path, bytes, sha256, ownership: null, license: null, compatibility: null,
      evidence: 'release-profile-declaration',
    })),
    dependencies,
    dependencyCoverage: [...seen].sort(compare).map((scope) => ({ scope, evidence: 'lockfile-v3-declaration' })),
  });
}
