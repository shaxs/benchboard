// Captain-owned private template boundary. Exclusive file creation, never a sharing projection.
import fs from 'node:fs';
import path from 'node:path';
import { assertDirectoryChain } from '../packages/evaluation/staging.mjs';
import { externalRoot, readOrdinaryBytes, rejectIntegrity } from './filesystem.mjs';
import { CommandError } from './command-error.mjs';

const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
export function explicitFilePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) ||
      value.split(/[\\/]/).some(part => part === '.' || part === '..')) rejectIntegrity();
  // A new pathname must denote an ordinary file/directory, not a stream of a
  // preexisting Windows file, device namespace, or trailing-dot/space alias.
  if (value.startsWith('\\\\') || value.startsWith('//')) rejectIntegrity();
  const segments = value.slice(path.parse(value).root.length).split(/[\\/]/);
  if (segments.some(part => /[:<>"|?*]/.test(part) || /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) rejectIntegrity();
  return path.resolve(value);
}
export function privateTemplateDestination(value, protectedRoots) {
  const output = explicitFilePath(value);
  try {
    const prior = fs.lstatSync(output);
    if (prior.isSymbolicLink() || !prior.isFile() || prior.nlink !== 1) rejectIntegrity();
    throw new CommandError('state');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return externalRoot(output, protectedRoots, true);
}
export function writePrivateTemplate(destination, template, protectedRoots) {
  const output = privateTemplateDestination(destination, protectedRoots);
  const parent = path.dirname(output), chain = JSON.stringify(assertDirectoryChain(parent));
  const bytes = Buffer.from(JSON.stringify(template, null, 2) + '\n');
  let descriptor, claim;
  const verify = () => {
    if (JSON.stringify(assertDirectoryChain(parent)) !== chain) rejectIntegrity();
    const stat = fs.lstatSync(output);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || identity(stat) !== claim) rejectIntegrity();
    if (!readOrdinaryBytes(output).equals(bytes)) rejectIntegrity();
    const after = fs.lstatSync(output);
    if (identity(after) !== claim || after.nlink !== 1 || JSON.stringify(assertDirectoryChain(parent)) !== chain) rejectIntegrity();
  };
  try {
    descriptor = fs.openSync(output, 'wx', 0o600);
    claim = identity(fs.fstatSync(descriptor));
    fs.writeFileSync(descriptor, bytes);
    fs.closeSync(descriptor); descriptor = undefined;
    verify();
    return output;
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
    // Remove only a still-owned, complete exact file; partial/foreign/uncertain material stays.
    if (claim !== undefined) { try { verify(); fs.unlinkSync(output); } catch {} }
    throw error;
  }
}
