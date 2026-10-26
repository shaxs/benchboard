// Captain-owned cooperative boundary; never an adversarial OS sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDirectoryChain } from '../packages/evaluation/staging.mjs';
import { assertDisjointRoots } from '../packages/core/paths.mjs';
import { CommandError } from './command-error.mjs';
export const INSTALLATION_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const rejectIntegrity = () => { throw new CommandError('integrity'); };
export function canonicalRoot(value) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) rejectIntegrity();
  const absolute = path.resolve(value);
  if (path.dirname(absolute) === absolute) rejectIntegrity();
  return absolute;
}
export function existingDirectory(root) {
  const absolute = canonicalRoot(root);
  assertDirectoryChain(absolute);
  return absolute;
}
export function externalRoot(value, others = [], fresh = false) {
  const absolute = canonicalRoot(value);
  const parent = fresh ? path.dirname(absolute) : absolute;
  existingDirectory(parent);
  const physical = fresh ? path.join(fs.realpathSync.native(parent), path.basename(absolute)) : fs.realpathSync.native(absolute);
  assertDisjointRoots([INSTALLATION_ROOT, absolute, ...others]);
  assertDisjointRoots([fs.realpathSync.native(INSTALLATION_ROOT), physical,
    ...others.map(other => fs.realpathSync.native(other))]);
  if (fresh && fs.existsSync(absolute)) throw new CommandError('state');
  return absolute;
}
export function readOrdinaryBytes(file, maximum = 2097152) {
  const chain = assertDirectoryChain(path.dirname(file));
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) rejectIntegrity();
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    const same = stat => stat.isFile() && stat.nlink === 1 && stat.dev === before.dev && stat.ino === before.ino &&
      stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
    if (!same(opened)) rejectIntegrity();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const amount = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (amount === 0) rejectIntegrity();
      offset += amount;
    }
    const after = fs.lstatSync(file);
    if (after.isSymbolicLink() || !same(after) || !same(fs.fstatSync(descriptor)) ||
        JSON.stringify(chain) !== JSON.stringify(assertDirectoryChain(path.dirname(file)))) rejectIntegrity();
    return bytes;
  } finally { fs.closeSync(descriptor); }
}
export function readOrdinaryJson(file, maximum) {
  const bytes = readOrdinaryBytes(file, maximum);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { rejectIntegrity(); }
}
export function exactKeys(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...names].sort().join(',')) rejectIntegrity();
}
