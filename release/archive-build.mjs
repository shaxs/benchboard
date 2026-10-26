/** Local deterministic synthetic ustar builder. No npm pack, hooks, publication, or extraction. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateReleaseProfile } from './profiles.mjs';
import { auditSyntheticArchive, ArchiveIntegrityError } from './archive-audit.mjs';

const LIMIT = 64 * 1024 * 1024;
const REPOSITORY = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const id = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.mode}`;
const fail = () => { throw new ArchiveIntegrityError(); };
const fold = (value) => path.resolve(value).toLowerCase();
function overlap(a, b) {
  const inside = (parent, child) => {
    const relative = path.relative(fold(parent), fold(child));
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  };
  return inside(a, b) || inside(b, a);
}
function chain(directory) {
  const receipt = [];
  for (let at = directory;; at = path.dirname(at)) {
    const stat = fs.lstatSync(at, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    receipt.push([at, id(stat)]);
    if (path.dirname(at) === at) return receipt;
  }
}
function assertChain(receipt) {
  for (const [directory, expected] of receipt) {
    const stat = fs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || id(stat) !== expected) fail();
  }
}
function read(file) {
  const namespace = chain(path.dirname(file));
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(LIMIT)) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (id(opened) !== id(before) || opened.nlink !== 1n) fail();
    const bytes = fs.readFileSync(fd);
    const after = fs.lstatSync(file, { bigint: true });
    assertChain(namespace);
    if (id(before) !== id(after) || after.isSymbolicLink() || !after.isFile() || after.nlink !== 1n ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size) fail();
    return { bytes, identity: id(after), namespace };
  } finally { fs.closeSync(fd); }
}
function headerFor(relative, size) {
  const header = Buffer.alloc(512);
  let name = relative;
  let prefix = '';
  if (name.length > 100) {
    const split = name.lastIndexOf('/');
    if (split < 0) fail();
    prefix = name.slice(0, split); name = name.slice(split + 1);
  }
  if (name.length > 100 || prefix.length > 155) fail();
  header.write(name, 0, 100, 'ascii'); header.write(prefix, 345, 155, 'ascii');
  const number = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0';
  header.write(number(0o644, 8), 100); header.write(number(0, 8), 108); header.write(number(0, 8), 116);
  header.write(number(size, 12), 124); header.write(number(0, 12), 136);
  header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return header;
}

/** Returns mutable archive bytes and immutable evidence for their captured audited state. */
export function buildSyntheticArchive({ directory, profile }) {
  const selected = validateReleaseProfile(profile);
  try {
    if (selected.profile !== 'synthetic' || typeof directory !== 'string' || !path.isAbsolute(directory) ||
        /[\x00-\x1f\x7f]/.test(directory) || directory.startsWith('\\\\') || directory.startsWith('//') ||
        (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(directory))) fail();
    const root = path.resolve(directory);
    const receipt = chain(root);
    const physical = fs.realpathSync.native(root).replace(/^\\\\\?\\/, '');
    if (overlap(root, REPOSITORY) || overlap(physical, fs.realpathSync.native(REPOSITORY).replace(/^\\\\\?\\/, ''))) fail();
    const expected = new Set(selected.entries.map((entry) => entry.path));
    function inventory(at, prefix = '') {
      for (const name of fs.readdirSync(at)) {
        const relative = prefix ? `${prefix}/${name}` : name;
        const target = path.join(at, name);
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) fail();
        if (stat.isDirectory()) {
          if (![...expected].some((entry) => entry.startsWith(relative + '/'))) fail();
          inventory(target, relative);
        } else if (!stat.isFile() || !expected.has(relative)) fail();
      }
    }
    inventory(root);
    const captured = [];
    const blocks = [];
    let total = 1024;
    for (const entry of selected.entries) {
      assertChain(receipt);
      total += 512 + Math.ceil(entry.bytes / 512) * 512;
      if (!Number.isSafeInteger(total) || total > LIMIT) fail();
      const file = path.join(root, ...entry.path.split('/'));
      const actual = read(file);
      if (actual.bytes.length !== entry.bytes || sha(actual.bytes) !== entry.sha256) fail();
      captured.push({ file, ...actual });
      blocks.push(headerFor(entry.path, actual.bytes.length), actual.bytes, Buffer.alloc((512 - actual.bytes.length % 512) % 512));
    }
    inventory(root);
    assertChain(receipt);
    for (const item of captured) {
      assertChain(item.namespace);
      const after = read(item.file);
      if (after.identity !== item.identity || !after.bytes.equals(item.bytes)) fail();
    }
    const bytes = Buffer.concat([...blocks, Buffer.alloc(1024)]);
    // This independently parses the final serialized bytes, not the builder's inventory.
    const audit = auditSyntheticArchive(bytes, selected);
    return Object.freeze({ bytes, audit });
  } catch (error) {
    if (error instanceof ArchiveIntegrityError) throw error;
    throw new ArchiveIntegrityError();
  }
}
