/** Explicit release inventory validation. This module never stages or publishes. */
import { readFileSync } from 'node:fs';

const inventory = JSON.parse(readFileSync(new URL('./inventory.json', import.meta.url), 'utf8'));
if (inventory.schema !== 'benchboard.c0.participant-inventory/1' || inventory.participant.fileCount !== 26 ||
    !Array.isArray(inventory.participant.files) || inventory.participant.files.length !== 26) {
  throw new Error('Unsupported canonical participant inventory');
}

export const RELEASE_PROFILE_STATES = Object.freeze({
  participant: 'participant-only',
  'owner-development': 'private-only',
  'end-user-tooling': 'blocked',
  synthetic: 'synthetic-only',
});

const generators = Object.freeze({
  'synthetic-metadata-v1': 'release-metadata.json',
  'tooling-package-v1': 'package.json',
  'tooling-lock-v1': 'package-lock.json',
  'installed-assets-v1': 'cli/installed-assets.json',
  'adapter-package-v1': 'adapters/dsh/package.json',
});
const privateSegments = new Set([
  'reference', 'spec', 'workflow', 'artifacts', '.ai', '.git', '.agent-teams',
  '.benchboard', 'node_modules', '_backups', '.cache', '.vite', 'coverage', 'dist',
]);
const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export class ReleaseProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReleaseProfileError';
    this.code = code;
  }
}

function refuse(code, message) {
  throw new ReleaseProfileError(code, message);
}

function objectKeys(value, required, optional, code) {
  let descriptors;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      refuse(code, 'Expected a plain JSON object');
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    refuse(code, 'Expected a plain JSON object');
  }
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key) ||
      !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')) ||
      required.some((key) => !Object.hasOwn(descriptors, key))) {
    refuse(code, 'Missing, unknown or non-data contract fields');
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

/** A conservative portable path grammar; no filesystem traversal or glob expansion. */
function ordinaryPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 ||
      !/^[A-Za-z0-9._/-]+$/.test(value)) {
    refuse('RELEASE_PATH_INVALID', 'Expected an ordinary portable relative POSIX path');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
      reserved.test(part) || privateSegments.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part))) {
    refuse('RELEASE_PATH_INVALID', 'Private, reserved or ambiguous path component');
  }
  if (parts.some((part) => part.toLowerCase() === 'runner') && value !== 'runner/files.mjs') {
    refuse('RELEASE_PATH_INVALID', 'Historical runner files are not releasable');
  }
  return value;
}

function canonicalEntries() {
  return inventory.participant.files.map(({ path, bytes, sha256 }) => ({
    path, bytes, sha256, source: `starter/${path}`,
  }));
}

/** Return a detached, deeply frozen contract. Unknown profiles never imply authorization. */
export function validateReleaseProfile(input) {
  input = objectKeys(input, ['schemaVersion', 'kind', 'profile', 'authorization', 'entries'], [], 'RELEASE_PROFILE_INVALID');
  if (input.schemaVersion !== '1.0.0' || input.kind !== 'ReleaseProfile') {
    refuse('RELEASE_PROFILE_INVALID', 'Unsupported release profile discriminator');
  }
  if (typeof input.profile !== 'string' || !Object.hasOwn(RELEASE_PROFILE_STATES, input.profile)) {
    refuse('RELEASE_PROFILE_UNKNOWN', 'Unknown release profile');
  }
  if (input.authorization !== RELEASE_PROFILE_STATES[input.profile]) {
    refuse('RELEASE_PROFILE_BLOCKED', 'Caller declarations cannot change profile authorization');
  }
  if (input.profile === 'owner-development' || input.profile === 'end-user-tooling') {
    refuse('RELEASE_PROFILE_BLOCKED', 'Private owner or unresolved evaluator/license profile cannot be released');
  }
  let arrayDescriptors;
  try {
    if (Array.isArray(input.entries)) arrayDescriptors = Object.getOwnPropertyDescriptors(input.entries);
  } catch { /* Invalid input is refused below without executing property getters. */ }
  const length = arrayDescriptors?.length?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > 10000 ||
      Reflect.ownKeys(arrayDescriptors).length !== length + 1) {
    refuse('RELEASE_ENTRY_INVALID', 'Expected a non-empty dense entry array');
  }
  const entries = [];
  const paths = new Set();
  const sources = new Set();
  for (let i = 0; i < length; i += 1) {
    const descriptor = arrayDescriptors[String(i)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) refuse('RELEASE_ENTRY_INVALID', 'Expected data entries');
    const entry = objectKeys(descriptor.value, ['path', 'bytes', 'sha256'], ['source', 'generated'], 'RELEASE_ENTRY_INVALID');
    const output = ordinaryPath(entry.path);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
        typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        Object.hasOwn(entry, 'source') === Object.hasOwn(entry, 'generated')) {
      refuse('RELEASE_ENTRY_INVALID', 'Entries require exact size/hash and one source or generator');
    }
    const folded = output.toLowerCase();
    if (paths.has(folded)) refuse('RELEASE_PATH_COLLISION', 'Duplicate or case-colliding output path');
    paths.add(folded);
    if (Object.hasOwn(entry, 'source')) {
      const source = ordinaryPath(entry.source);
      if (sources.has(source.toLowerCase())) refuse('RELEASE_PATH_COLLISION', 'Duplicate source path');
      sources.add(source.toLowerCase());
      entries.push({ path: output, bytes: entry.bytes, sha256: entry.sha256, source });
    } else {
      if (typeof entry.generated !== 'string' || !Object.hasOwn(generators, entry.generated) ||
          generators[entry.generated] !== output) {
        refuse('RELEASE_ENTRY_INVALID', 'Unknown generator or incorrect fixed generated output path');
      }
      entries.push({ path: output, bytes: entry.bytes, sha256: entry.sha256, generated: entry.generated });
    }
  }
  for (const entry of entries) {
    const parts = entry.path.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i += 1) {
      if (paths.has(parts.slice(0, i).join('/'))) refuse('RELEASE_PATH_COLLISION', 'File/directory prefix collision');
    }
  }
  entries.sort((a, b) => compare(a.path, b.path));
  if (input.profile === 'participant') {
    const canonical = canonicalEntries().sort((a, b) => compare(a.path, b.path));
    if (JSON.stringify(entries) !== JSON.stringify(canonical)) {
      refuse('RELEASE_PARTICIPANT_MISMATCH', 'Participant profile must equal the exact canonical 26 files');
    }
  }
  return Object.freeze({
    schemaVersion: '1.0.0', kind: 'ReleaseProfile', profile: input.profile,
    authorization: RELEASE_PROFILE_STATES[input.profile],
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
  });
}

export function createParticipantProfile() {
  return validateReleaseProfile({
    schemaVersion: '1.0.0', kind: 'ReleaseProfile', profile: 'participant',
    authorization: 'participant-only', entries: canonicalEntries(),
  });
}
