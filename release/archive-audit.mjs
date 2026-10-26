/** Inspect actual bytes, independently of the builder's staged inventory. Never extracts. */
import { createHash } from 'node:crypto';
import { validateReleaseProfile } from './profiles.mjs';

const BLOCK = 512;
const LIMIT = 64 * 1024 * 1024;
const generated = Buffer.from('{"schemaVersion":"1.0.0","kind":"SyntheticReleaseMetadata","publicRelease":false}\n');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const zero = (bytes) => bytes.every((value) => value === 0);

export class ArchiveIntegrityError extends Error {
  constructor() {
    super('Synthetic archive integrity or limited content policy refused');
    this.name = 'ArchiveIntegrityError';
    this.code = 'RELEASE_ARCHIVE_REFUSED';
  }
}
const fail = () => { throw new ArchiveIntegrityError(); };

function textField(bytes) {
  const end = bytes.indexOf(0);
  const value = end === -1 ? bytes : bytes.subarray(0, end);
  if ((end !== -1 && !zero(bytes.subarray(end))) || value.some((byte) => byte < 32 || byte > 126)) fail();
  return value.toString('ascii');
}
function octal(bytes) {
  const value = bytes.toString('ascii');
  if (!/^[0-7]+\0$/.test(value)) fail();
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail();
  return parsed;
}
function content(bytes, entry) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(); }
  if (/BENCHBOARD_PRIVATE|CANARY_ARCHIVE_PRIVATE|PRIVATE_CANARY|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bsk-[A-Za-z0-9]{20,}|\bnpm_[A-Za-z0-9]{20,}/.test(text) ||
      /https?:\/\/(?:localhost|127\.[0-9.]+|10\.[0-9.]+|192\.168\.[0-9.]+|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9.]+|\[::1\])(?::|\/|\b)/i.test(text)) fail();
  if (entry.generated && entry.generated !== 'synthetic-metadata-v1') fail();
  if ((entry.generated || entry.path?.toLowerCase() === 'release-metadata.json') && !bytes.equals(generated)) fail();
}

/** Positive evidence binds only the captured bytes, not later caller mutations or legal rights. */
export function auditSyntheticArchive(archiveBytes, profile) {
  const selected = validateReleaseProfile(profile);
  if (selected.profile !== 'synthetic' || !(archiveBytes instanceof Uint8Array) ||
      archiveBytes.length > LIMIT || archiveBytes.length < 3 * BLOCK || archiveBytes.length % BLOCK) fail();
  const archive = Buffer.from(archiveBytes);
  const expected = new Map(selected.entries.map((entry) => [entry.path, entry]));
  const seen = new Set();
  const directories = new Map();
  const entries = [];
  let offset = 0;
  let ended = false;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (zero(header)) {
      if (offset + 2 * BLOCK !== archive.length || !zero(archive.subarray(offset + BLOCK))) fail();
      ended = true;
      break;
    }
    const check = header.subarray(148, 156).toString('ascii');
    if (!/^[0-7]{6}\0 $/.test(check)) fail();
    let sum = 0;
    for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 32 : header[index];
    if (sum !== Number.parseInt(check, 8) || header[156] !== 48 ||
        header.subarray(257, 263).toString('ascii') !== 'ustar\0' || header.subarray(263, 265).toString('ascii') !== '00' ||
        !zero(header.subarray(157, 257)) || !zero(header.subarray(265, 345)) || !zero(header.subarray(500))) fail();
    if (octal(header.subarray(100, 108)) !== 0o644 || octal(header.subarray(108, 116)) !== 0 ||
        octal(header.subarray(116, 124)) !== 0 || octal(header.subarray(136, 148)) !== 0) fail();
    const name = textField(header.subarray(0, 100));
    const prefix = textField(header.subarray(345, 500));
    const relative = prefix ? `${prefix}/${name}` : name;
    const entry = expected.get(relative);
    if (!entry || seen.has(relative.toLowerCase())) fail();
    content(Buffer.from(relative), {});
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join('/');
      const folded = directory.toLowerCase();
      if (directories.has(folded) && directories.get(folded) !== directory) fail();
      directories.set(folded, directory);
    }
    const size = octal(header.subarray(124, 136));
    if (size !== entry.bytes || size > LIMIT || offset + BLOCK + size > archive.length) fail();
    const bytes = archive.subarray(offset + BLOCK, offset + BLOCK + size);
    const paddedEnd = offset + BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (paddedEnd > archive.length || !zero(archive.subarray(offset + BLOCK + size, paddedEnd)) || sha(bytes) !== entry.sha256) fail();
    content(bytes, entry);
    entries.push(Object.freeze({ path: relative, bytes: size, sha256: sha(bytes) }));
    seen.add(relative.toLowerCase());
    offset = paddedEnd;
  }
  if (!ended || entries.length !== selected.entries.length) fail();
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return Object.freeze({
    schemaVersion: '1.0.0', kind: 'SyntheticArchiveAudit', status: 'complete', publicRelease: false,
    archiveSha256: sha(archive), inventorySha256: sha(JSON.stringify(entries)), entries: Object.freeze(entries),
    contentPolicy: 'synthetic-utf8-markers-v1',
  });
}
